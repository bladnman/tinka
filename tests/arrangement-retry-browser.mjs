import {openItemDetails} from './tile-test-helpers.mjs';
// Arrangement actions survive an unrelated workspace revision change, while real
// conflicts still reject visibly. Each case injects a server write exactly when the
// action's request arrives. Isolated fixture, headless browser, port 0.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-arrangement-retry-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-arrangement-retry-evidence-'));
await mkdir(evidence,{recursive:true});let server,browser;
const results={},failures=[];
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Arrangement retry fixture']);
  const config=await loadConfig(configFile);
  const op=async operation=>(await applyOperation(config,operation)).result;
  const parent=await op({type:'createBoard',title:'Arrangement parent'}),P=parent.boardId;
  const card=async(title,x,y,boardId=P)=>{const r=await op({type:'createItem',boardId,item:{title,content:{kind:'note',text:title}},placement:{x,y,width:220,height:160}});return {itemId:r.itemId,id:r.placementIds?.[0]||(await getBoardSnapshot(config,boardId)).placements.find(p=>p.itemId===r.itemId).id};};
  const A=await card('Nudge me',0,0),B=await card('Drop me into the board',260,0),Z=await card('Unrelated item',0,620);
  const child=await op({type:'createBoard',title:'Child board',parentBoardId:P}),C=child.boardId;
  const Cplacement=(await getBoardSnapshot(config,P)).placements.find(p=>![A.id,B.id,Z.id].includes(p.id)).id;
  await op({type:'updatePlacement',boardId:P,placementId:Cplacement,patch:{x:600,y:0,width:300,height:300}});
  const X=await card('Lift me out',0,0,C),Y=await card('Return me to parent',260,0,C);
  await op({type:'createDecoration',boardId:P,decoration:{id:'start',type:'region',shape:'rectangle',x:0,y:320,width:220,height:200,color:'#f6e6a4',text:'Start here'}});
  await op({type:'createDecoration',boardId:P,decoration:{id:'then',type:'region',shape:'rounded',x:320,y:320,width:220,height:160,color:'#e0e8da',text:'Then this'}});
  const board=id=>getBoardSnapshot(config,id);
  const placement=async(boardId,id)=>(await board(boardId)).placements.find(p=>p.id===id);
  const decoration=async id=>(await board(P)).decorations.find(d=>d.id===id);
  let unrelated=0;const bump=()=>op({type:'updateItem',itemId:Z.itemId,patch:{title:`Unrelated edit ${++unrelated}`}});
  server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  // One-shot injection: when the armed operation type arrives, run a server write first.
  let armed=null,requests=[];
  await page.route('**/api/operations',async route=>{
    const body=route.request().postDataJSON();
    if(armed&&body?.type===armed.type){const inject=armed.inject;armed=null;await inject();}
    await new Promise(r=>setTimeout(r,150));
    const response=await route.fetch();requests.push({type:body?.type,status:response.status()});
    await route.fulfill({response});
  });
  const ready=async()=>{await page.locator('#live-status[data-connection="live"]').waitFor();await page.waitForTimeout(300);};
  const show=async(id,from)=>{await page.goto(`${url}/boards/${id}/${from?`?from=${from}`:''}`);await page.locator('#world').waitFor();await ready();};
  const until=async(check,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await page.waitForTimeout(100);}return false;};
  const centre=async locator=>{const b=await locator.boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2};};
  const settle=async()=>{await page.waitForFunction(()=>!document.querySelector('.workspace-dragging'));await page.waitForTimeout(400);};
  const closeDialog=async()=>{const open=await page.locator('dialog[open]').count();if(open){await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'}).catch(()=>{});}return open;};
  const record=async(name,ok,extra={})=>{const shown=await closeDialog();results[name]={saved:ok,requests:requests.map(r=>`${r.type}:${r.status}`),dialogOpenAfter:shown,...extra};console.log(name.padEnd(30),JSON.stringify(results[name]));if(!ok)failures.push(`${name}: action was not saved after an unrelated revision change (${results[name].requests.join(', ')})`);await settle();};
  const lost=async(name,type,action,check,extra)=>{requests=[];armed={type,inject:bump};await action();await record(name,await until(check),extra?await extra():{});armed=null;};
  const drag=async(from,to,{hold=0}={})=>{await page.mouse.move(from.x,from.y);await page.mouse.down();if(hold){await page.waitForTimeout(hold);await page.locator('#workspace-child-drag').waitFor({timeout:3000});}await page.mouse.move(from.x+12,from.y+12,{steps:3});await page.mouse.move(to.x,to.y,{steps:10});await page.waitForTimeout(80);await page.mouse.up();};
  const select=async id=>{await page.locator(`[data-placement="${id}"] [data-placement-select]`).click();await page.evaluate(()=>document.activeElement?.blur());};

  await show(P);
  // 1. Drop into a board. The released card also never repaints at its old position.
  const bCard=page.locator(`[data-placement="${B.id}"]`),bOriginal=await bCard.evaluate(el=>({left:el.style.left,top:el.style.top}));
  await bCard.evaluate(el=>{window.__bWrites=[];window.__bUp=false;window.addEventListener('pointerup',()=>{window.__bUp=true;},{capture:true,once:true});new MutationObserver(()=>{if(window.__bUp)window.__bWrites.push({left:el.style.left,top:el.style.top});}).observe(el,{attributes:true,attributeFilter:['style']});});
  await lost('drop-into-board','move',async()=>drag(await centre(bCard),await centre(page.locator(`[data-placement="${Cplacement}"]`))),
    async()=>(await board(C)).placements.some(p=>p.itemId===B.itemId&&!p.removedAt)&&(await placement(P,B.id))?.removedAt,
    async()=>{const writes=await page.evaluate(()=>window.__bWrites||[]);return {repaintedAtOriginal:writes.some(w=>w.left===bOriginal.left&&w.top===bOriginal.top)};});
  if(results['drop-into-board'].repaintedAtOriginal)failures.push('drop-into-board: the released card repainted at its original position before the move landed');
  // 2. Lift a child out of the board's cover onto this canvas.
  await show(P);const tile=page.locator(`[data-placement="${Cplacement}"] [data-cover-tile="${X.id}"]`);await tile.waitFor();
  const cBox=await page.locator(`[data-placement="${Cplacement}"]`).boundingBox();
  await lost('lift-from-cover','move',async()=>drag(await centre(tile),{x:cBox.x+cBox.width+140,y:cBox.y+cBox.height/2},{hold:550}),
    async()=>(await board(P)).placements.some(p=>p.itemId===X.itemId&&!p.removedAt));
  // 3. Drop onto Parent from the child board.
  await show(C,P);await page.waitForFunction(()=>document.getElementById('workspace-parent')?.getAttribute('href')?.startsWith('/boards/'));
  await lost('drop-onto-parent','move',async()=>drag(await centre(page.locator(`[data-placement="${Y.id}"]`)),await centre(page.locator('#workspace-parent'))),
    async()=>(await board(P)).placements.some(p=>p.itemId===Y.itemId&&!p.removedAt));
  await show(P);
  // 4. Create an arrow from a port. The drawn arrow stays visible until it is saved.
  await page.locator('[data-decoration=start] [data-decoration-label]').click();await page.locator('[data-whiteboard-action=connect]').click();
  const startPort=page.getByRole('button',{name:'Connect Start here right',exact:true});await startPort.waitFor();
  const lines=()=>page.evaluate(()=>document.querySelectorAll('#world .decoration-line').length);
  await lost('arrow-from-port','createDecoration',async()=>{
    const s=await centre(startPort);await page.mouse.move(s.x,s.y);await page.mouse.down();await page.mouse.move(s.x+10,s.y,{steps:2});
    const end=await page.locator('[data-port]').evaluateAll(els=>{const el=els.find(e=>JSON.parse(e.dataset.port).decorationId==='then'&&JSON.parse(e.dataset.port).side==='left');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await page.mouse.move(end.x,end.y,{steps:6});
    await page.evaluate(()=>{window.__lineGap=0;window.__lineWatch=true;const count=()=>document.querySelectorAll('#world .decoration-line').length,start=count();const tick=()=>{if(count()<start)window.__lineGap++;if(window.__lineWatch)requestAnimationFrame(tick);};requestAnimationFrame(tick);});
    await page.mouse.up();
  },async()=>(await board(P)).decorations.some(d=>d.type==='line'&&d.from?.decorationId==='start'&&d.to?.decorationId==='then'),
    async()=>({framesWithoutArrow:await page.evaluate(()=>{window.__lineWatch=false;return window.__lineGap;})}));
  if(results['arrow-from-port'].framesWithoutArrow)failures.push(`arrow-from-port: the drawn arrow vanished for ${results['arrow-from-port'].framesWithoutArrow} frame(s) before it was saved`);
  await page.keyboard.press('Escape');
  // 5. Keyboard nudges: a card and a sticky.
  await select(A.id);const ax=(await placement(P,A.id)).x;
  await lost('nudge-card','translatePlacements',()=>page.keyboard.press('ArrowRight'),async()=>(await placement(P,A.id)).x===ax+1);
  await page.keyboard.press('Escape');
  await page.locator('[data-decoration=start] [data-decoration-label]').click();await page.keyboard.press('Escape');await page.locator('[data-decoration=start] [data-decoration-label]').click();
  const sy=(await decoration('start')).y;
  await lost('nudge-sticky','updateDecoration',()=>page.keyboard.press('ArrowDown'),async()=>(await decoration('start')).y===sy+1);
  // 6. Move / resize dialogs: a card and a sticky.
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  await openItemDetails(page.locator(`[data-placement="${A.id}"] [data-item-controls]`));await page.locator('[data-context-geometry]').click();
  await page.locator('dialog[open] input[name=x]').fill('40');
  await lost('dialog-card','updatePlacement',()=>page.locator('dialog[open] button[type=submit]').click(),async()=>(await placement(P,A.id)).x===40);
  await page.locator('[data-decoration=start] [data-decoration-label]').click();await page.locator('[data-whiteboard-action=more]').click();await page.locator('[data-whiteboard-action=inspect]').click();
  await page.locator('dialog[open] input[name=x]').fill('12');
  await lost('dialog-sticky','updateDecoration',()=>page.locator('dialog[open] button[type=submit]').click(),async()=>(await decoration('start')).x===12);
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  // 7. Undo and redo replay a fresh, uncontested movement of the card.
  await show(P);
  while(await page.locator('.workspace-card.selected [data-placement-select]').count())await page.locator('.workspace-card.selected [data-placement-select]').first().click();
  await select(A.id);const before=(await placement(P,A.id)).x;
  await page.keyboard.press('ArrowRight');await until(async()=>(await placement(P,A.id)).x===before+1);await settle();
  await page.keyboard.press('Escape');await page.evaluate(()=>document.activeElement?.blur());
  await page.waitForFunction(()=>document.getElementById('workspace-undo')?.disabled===false);
  await lost('undo','restoreMovement',()=>page.keyboard.press('ControlOrMeta+z'),async()=>(await placement(P,A.id)).x===before);
  if(results.undo.saved){
    await page.waitForFunction(()=>document.getElementById('workspace-redo')?.disabled===false);
    await lost('redo','restoreMovement',()=>page.keyboard.press('ControlOrMeta+Shift+z'),async()=>(await placement(P,A.id)).x===before+1);
  } else failures.push('redo: not reached because undo was lost');
  await page.screenshot({path:path.join(evidence,'arrangement-retry.png')});

  // Real conflicts still reject: placement, decoration and history.
  const conflict=async(name,type,inject,action,{expect,message})=>{
    await page.waitForFunction(()=>!document.querySelector('.workspace-toast'),null,{timeout:15000}).catch(()=>{});
    requests=[];armed={type,inject};await action();
    // Wait for the action's final response, then for its failure feedback.
    await until(async()=>requests.some(r=>r.type===type)&&(await page.locator('dialog[open]').count()>0||(await page.locator('.workspace-toast').allTextContents()).some(t=>/could not apply|changed/i.test(t))),8000);
    await page.waitForTimeout(300);
    const dialog=await page.locator('dialog[open]').count(),toast=await page.locator('.workspace-toast').allTextContents();armed=null;
    const kept=await until(expect,3000);await closeDialog();
    results[name]={dialog,toast:toast.join(' | ').slice(0,160),otherWriterKept:kept,requests:requests.map(r=>`${r.type}:${r.status}`)};console.log(name.padEnd(30),JSON.stringify(results[name]));
    if(!kept)failures.push(`${name}: another writer's change was overwritten`);
    if(message==='dialog'&&!dialog)failures.push(`${name}: no failure dialog`);
    if(message==='toast'&&!toast.some(t=>/could not apply/i.test(t)))failures.push(`${name}: no history conflict notice`);
    await settle();
  };
  await page.keyboard.press('Escape');await page.evaluate(()=>document.activeElement?.blur());
  while(await page.locator('.workspace-card.selected [data-placement-select]').count())await page.locator('.workspace-card.selected [data-placement-select]').first().click();
  await select(A.id);assert.deepEqual(await page.locator('.workspace-card.selected').evaluateAll(cards=>cards.map(c=>c.dataset.placement)),[A.id]);
  await conflict('conflict-placement','translatePlacements',()=>op({type:'updatePlacement',boardId:P,placementId:A.id,patch:{x:500,y:700}}),
    ()=>page.keyboard.press('ArrowRight'),{expect:async()=>(await placement(P,A.id)).x===500,message:'dialog'});
  const rendered=await until(async()=>(await page.locator(`[data-placement="${A.id}"]`).evaluate(el=>el.style.left))===`${500+70}px`,4000);
  if(!rendered)failures.push('conflict-placement: the board did not reconcile to the latest position');
  await page.keyboard.press('Escape');
  await page.locator('[data-decoration=then] [data-decoration-label]').click();
  await conflict('conflict-decoration','updateDecoration',()=>op({type:'updateDecoration',boardId:P,decorationId:'then',patch:{x:620}}),
    ()=>page.keyboard.press('ArrowDown'),{expect:async()=>(await decoration('then')).x===620&&(await decoration('then')).y===320,message:'dialog'});
  await page.keyboard.press('Escape');await page.evaluate(()=>document.activeElement?.blur());
  // Record a fresh movement to undo, then let another writer change the same board.
  await openItemDetails(page.locator(`[data-placement="${A.id}"] [data-item-controls]`));await page.locator('[data-context-geometry]').click();
  await page.locator('dialog[open] input[name=x]').fill('80');await page.locator('dialog[open] button[type=submit]').click();
  await until(async()=>(await placement(P,A.id)).x===80);await page.keyboard.press('Escape');await page.evaluate(()=>document.activeElement?.blur());await settle();
  await page.waitForFunction(()=>document.getElementById('workspace-undo')?.disabled===false);
  await conflict('conflict-history','restoreMovement',()=>op({type:'updatePlacement',boardId:P,placementId:A.id,patch:{x:520}}),
    ()=>page.keyboard.press('ControlOrMeta+z'),{expect:async()=>(await placement(P,A.id)).x===520,message:'toast'});
  await writeFile(path.join(evidence,'arrangement-retry-results.json'),JSON.stringify(results,null,2));
  assert.deepEqual(failures,[],failures.join('\n'));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,evidence,checks:'move into board, cover lift, Parent drop, port arrow, card/sticky nudges, card/sticky geometry dialogs and undo/redo survive an unrelated revision; placement, decoration and history conflicts still reject'}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
