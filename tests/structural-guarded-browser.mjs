// Actual board controls use immutable scoped structure, preserving whole-group
// atomicity, native drafts and canonical/attachment dependencies under races.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {openItemDetails} from './tile-test-helpers.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-structural-browser-'));
let server,browser;const results=[];
try {
  const file=path.join(fixture,'local/config.json');
  await main(['init','--config',file,'--boards',path.join(fixture,'boards'),'--label','Structural saves']);
  const config=await loadConfig(file),op=async operation=>(await applyOperation(config,operation)).result;
  const Q=(await op({type:'createBoard',title:'Independent board'})).boardId;
  let count=0;const bump=()=>op({type:'updateBoard',boardId:Q,patch:{description:`Independent ${++count}`}});
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'}),errors=[],requests=[];
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));let inject=null;
  await page.route('**/api/operations',async route=>{
    const body=route.request().postDataJSON(),type=body.operation?.type || body.type;
    if(inject&&type===inject.type){const action=inject.run;inject=null;await action();}
    const response=await route.fetch();requests.push({body,type,status:response.status()});await route.fulfill({response});
  });
  const until=async(fn)=>{for(let i=0;i<80;i++){const value=await fn();if(value)return value;await page.waitForTimeout(75);}throw Error('Expected saved state was not reached.');};
  const setup=async name=>{
    const id=(await op({type:'createBoard',title:name})).boardId;
    const A=await op({type:'createItem',boardId:id,item:{title:'First card',description:'Canonical data'},placement:{x:0,y:0,width:240,height:180}});
    const B=await op({type:'createItem',boardId:id,item:{title:'Second card'},placement:{x:360,y:120,width:240,height:180}});
    await op({type:'createDecoration',boardId:id,decoration:{id:'text',type:'text',x:60,y:340,width:280,height:130,text:'Original text',color:'palette:neutral'}});
    await op({type:'createDecoration',boardId:id,decoration:{id:'arrow',type:'line',x:240,y:70,width:120,height:130,text:'Attached',color:'palette:neutral',route:'curved',from:{placementId:A.placementIds[0],side:'right'},to:{placementId:B.placementIds[0],side:'left'}}});
    return {id,A:A.placementIds[0],B:B.placementIds[0],item:A.itemId};
  };
  const show=async id=>{await page.goto(`${url}/boards/${id}/`);await page.locator('[data-decoration=text]').waitFor();await page.locator('#live-status[data-connection=live]').waitFor({state:'attached'});await page.waitForTimeout(200);};
  const snap=id=>getBoardSnapshot(config,id);
  const select=async id=>{const card=page.locator(`.workspace-card[data-placement="${id}"]`);if(!await card.evaluate(el=>el.classList.contains('selected')))await card.locator('[data-placement-select]').click();await page.evaluate(()=>document.activeElement?.blur());};
  const arm=(type,run=bump)=>{requests.length=0;inject={type,run};};
  const last=()=>requests.at(-1);
  const modern=type=>{assert.equal(last().type,type);assert.equal(last().body.type,'guarded');assert.equal(last().body.baseline.version,2);assert.equal(Object.hasOwn(last().body,'expectedRevision'),false);assert.equal(inject,null,'race was actually injected');};
  const closeFailure=async()=>{const d=page.getByRole('dialog',{name:'Change not saved',exact:true});await d.waitFor();await d.locator('.workspace-close').click();};
  const noteDraft=async A=>{
    await page.locator(`[data-placement="${A}"] [data-item-controls]`).click();await page.locator('[data-tile-menu=notes]').click();
    await page.locator('.tile-notes textarea').fill('Keep this local note');await page.keyboard.press('Escape');
  };
  {
    const {id,A,B}=await setup('Groups and mixed arrangement');await show(id);await select(A);await select(B);
    arm('groupOccurrences');await page.keyboard.press('ControlOrMeta+g');await until(async()=>(await snap(id)).groups?.length===1);modern('groupOccurrences');assert.equal(last().status,200);
    const before=(await snap(id)).placements.find(p=>p.id===A).x;
    arm('translatePlacements',async()=>op({type:'ungroupOccurrences',boardId:id,groupId:(await snap(id)).groups[0].id}));
    await page.keyboard.press('ArrowRight');await closeFailure();modern('translatePlacements');assert.equal(last().status,409);assert.equal((await snap(id)).placements.find(p=>p.id===A).x,before);
    await show(id);await page.mouse.click(1300,650);await page.keyboard.press('ControlOrMeta+a');
    arm('arrangePlacements');await page.locator('#workspace-selection [data-arrange-open]').click();await page.locator('[data-arrange=align-left]').click();
    await until(async()=>{const s=await snap(id);return s.placements.every(p=>p.x===0)&&s.decorations.find(d=>d.id==='text').x===0;});modern('arrangePlacements');assert.equal(last().status,200);
    results.push('group accepts unrelated board; changed membership rejects complete nudge; mixed Arrange accepts unrelated board');
  }
  {
    const {id,A,item}=await setup('Canonical and attachment conflicts');await show(id);await noteDraft(A);await select(A);
    arm('remove',()=>op({type:'updateDecoration',boardId:id,decorationId:'arrow',patch:{text:'Peer arrow label'}}));
    await page.keyboard.press('Delete');await closeFailure();modern('remove');assert.equal(last().status,409);
    assert.equal((await snap(id)).placements.find(p=>p.id===A).removedAt,undefined);assert.equal((await snap(id)).decorations.find(d=>d.id==='arrow').text,'Peer arrow label');
    await show(id);await page.locator(`[data-placement="${A}"] [data-item-controls]`).click();await page.locator('[data-tile-menu=notes]').click();assert.equal(await page.locator('.tile-notes textarea').inputValue(),'Keep this local note');await page.keyboard.press('Escape');
    await select(A);arm('remove',()=>op({type:'archiveItem',itemIds:[item],archived:true}));await page.keyboard.press('Delete');await closeFailure();modern('remove');assert.equal(last().status,409);assert.equal((await snap(id)).placements.find(p=>p.id===A).removedAt,undefined);
    results.push('remove rejects changed incoming connector and canonical archive; note draft survives conflict and reload');
  }
  {
    const {id,A}=await setup('Inspector displayed appearance');await show(id);
    const details=async()=>{await page.evaluate(async()=>{const {WorkspaceBoard}=await import('/app/workspace-board.js');const open=WorkspaceBoard.prototype.itemControls;WorkspaceBoard.prototype.itemControls=function(...args){window.__appearanceBoard=this;return open.apply(this,args);};});await openItemDetails(page.locator(`[data-placement="${A}"] [data-item-controls]`));};
    const advanceDisplayedSnapshot=()=>page.evaluate(async()=>{const host=window.__appearanceBoard;host.snapshot=await host.client.get(`/api/boards/${host.snapshot.id}`);host.client.revision=host.snapshot.revision;});
    await details();await op({type:'updatePlacement',boardId:id,placementId:A,patch:{width:333}});await advanceDisplayedSnapshot();requests.length=0;
    await page.locator('[data-presentation=panel]').click();await closeFailure();assert.equal(last().status,409);assert.equal(last().body.baseline.version,2);assert.equal((await snap(id)).placements.find(p=>p.id===A).width,333);
    await show(id);await details();await page.locator('.inspector-paper [data-inspector-color]').click();
    const current=(await snap(id)).placements.find(p=>p.id===A);await op({type:'updatePlacement',boardId:id,placementId:A,patch:{presentation:{...current.presentation,paper:'#abcdef'}}});await advanceDisplayedSnapshot();requests.length=0;
    await page.locator('.inspector-paper [data-swatch]:not([aria-pressed=true])').first().click();await closeFailure();assert.equal(last().status,409);assert.equal(last().body.baseline.version,2);assert.equal((await snap(id)).placements.find(p=>p.id===A).presentation.paper,'#abcdef');
    results.push('Inspector appearance and paper keep their displayed baseline even after the real board snapshot and watermark advance');
  }
  {
    const {id}=await setup('Text drafts');await show(id);
    const edit=async()=>{await page.locator('[data-decoration=text] .deco-body').dblclick();await page.locator('.whiteboard-editor textarea').waitFor();};
    await edit();await page.locator('.whiteboard-editor textarea').fill('My saved text');arm('updateDecoration');await page.keyboard.press('Escape');await until(async()=>(await snap(id)).decorations.find(d=>d.id==='text').text==='My saved text');modern('updateDecoration');assert.equal(last().status,200);await page.waitForFunction(id=>{const key=[...Array(localStorage.length)].map((_,i)=>localStorage.key(i)).find(k=>k.endsWith('/whiteboard-drafts/'+id));return !key||Object.keys(JSON.parse(localStorage.getItem(key))).length===0;},id);
    await show(id);await edit();await page.locator('.whiteboard-editor textarea').fill('Keep this text draft');
    arm('updateDecoration',()=>op({type:'updateDecoration',boardId:id,decorationId:'text',patch:{text:'Remote text'}}));await page.keyboard.press('Escape');await until(()=>requests.length>0);modern('updateDecoration');assert.equal(last().status,409);
    await page.setViewportSize({width:390,height:844});await show(id);await edit();assert.equal(await page.locator('.whiteboard-editor textarea').inputValue(),'Keep this text draft');
    assert.equal((await snap(id)).decorations.find(d=>d.id==='text').text,'Remote text');await page.locator('.whiteboard-toolbar [data-whiteboard-action=cancel-edit]').click();
    await page.setViewportSize({width:1440,height:960});results.push('native Text accepts unrelated board; real text conflict preserves original baseline and draft through narrow reload');
  }
  {
    const {id,A,item}=await setup('Move and destination topology');const destination=(await op({type:'createBoard',title:'Destination'})).boardId;await show(id);await select(A);
    const open=async()=>{await page.locator('[data-bulk=move]').click();await page.getByRole('dialog',{name:'Move to a board',exact:true}).waitFor();await page.locator(`dialog [name=target][value="${destination}"]`).check();};
    await open();arm('move');await page.getByRole('button',{name:'Move items',exact:true}).click();await until(async()=>(await snap(destination)).placements.some(p=>p.itemId===item&&!p.removedAt));modern('move');assert.equal(last().status,200);
    assert.equal((await snap(id)).placements.find(p=>p.id===A).removedAt!==undefined,true);
    results.push('Move dialog uses source displayed structure and destination identity; unrelated board succeeds');
  }
  {
    const {id}=await setup('Paste and import');await show(id);
    arm('pastePlacements');await page.evaluate(()=>{document.activeElement?.blur();const dt=new DataTransfer();dt.setData('text/plain','A pasted thought');document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));});
    await until(async()=>(await snap(id)).placements.length===3);modern('pastePlacements');assert.equal(last().status,200);
    await page.waitForFunction(()=>!document.querySelector('#chrome-undo')?.disabled);
    let imported=null;await page.route('**/api/imports',async route=>{await bump();imported=route.request().postDataBuffer().toString();const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({response});});
    await page.evaluate(()=>{document.activeElement?.blur();const dt=new DataTransfer();const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7VQAAAAASUVORK5CYII='),c=>c.charCodeAt(0));dt.items.add(new File([bytes],'tiny.png',{type:'image/png'}));document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));});
    await until(async()=>(await snap(id)).placements.length===4);assert.ok(imported.includes('guardedImport'));assert.ok(imported.includes('"version":2'));assert.ok(!imported.includes('expectedRevision'));
    await page.waitForFunction(()=>!document.querySelector('#chrome-undo')?.disabled);await page.keyboard.press('Escape');await page.mouse.click(1350,700);await page.mouse.move(1000,650);
    let documentBody=null;await page.route('**/api/documents',async route=>{documentBody=route.request().postDataJSON();await bump();const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({response});});
    await page.keyboard.press('d');await until(async()=>(await snap(id)).placements.length===5);assert.equal(documentBody.type,'guardedImport');assert.equal(documentBody.baseline.version,2);assert.equal(Object.hasOwn(documentBody,'expectedRevision'),false);
    results.push('text paste, multipart image import and new Markdown document accept unrelated board through versioned guards');
  }
  {
    const limits=await page.evaluate(async()=>{
      const {WorkspaceClient}=await import('/app/workspace.js');
      const client=new WorkspaceClient({workspaceId:'fixture'},99),sent=[];
      client.write=async(...args)=>{sent.push(args);return {};};
      const board={id:'board',ownerItemId:'owner',placements:[],reviewOrder:[],decorations:[],structural:{version:2,scope:'board'}};
      for(let i=0;i<52;i++)board.decorations.push({id:'draw'+i,type:'text',x:i,y:0,width:200,height:80,text:'x'.repeat(18000)});
      const source={boards:[board],items:{owner:{id:'owner',childBoardId:'board'}},revision:7};
      await client.structural('restackOccurrences',{boardId:'board',decorationIds:['draw0'],to:'front'},source);
      const oversizedBaseline=sent.at(-1);let oversizedOperation='';
      try{await client.structural('updateDecoration',{boardId:'board',decorationId:'draw0',patch:{text:'x'.repeat(950000)}},source);}catch(error){oversizedOperation=error.message;}
      await client.structural('archiveItem',{itemIds:['owner'],archived:true},{revision:4});
      const oldSnapshot=sent.at(-1);
      let conflictWrites=0;client.write=async()=>{conflictWrites++;const error=new Error('changed');error.code='GUARDED_PRECONDITION_CHANGED';throw error;};
      board.decorations=[];
      try{await client.structural('createDecoration',{boardId:'board',decoration:{id:'small',type:'text',text:'Hello',x:0,y:0,width:200,height:80}},source);}catch{}
      return {baselineType:oversizedBaseline[0],baselineRevision:oversizedBaseline[2].expectedRevision,oldRevision:oldSnapshot[2].expectedRevision,oversizedOperation,sent:sent.length,conflictWrites};
    });
    assert.deepEqual([limits.baselineType,limits.baselineRevision,limits.oldRevision],['restackOccurrences',7,4]);assert.match(limits.oversizedOperation,/too large/);assert.equal(limits.sent,2);assert.equal(limits.conflictWrites,1);
    results.push('large envelopes choose frozen strict revision before dispatch; oversized operation rejects; guard conflict never downgrades');
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({pass:true,checks:results},null,2));
} finally {await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
