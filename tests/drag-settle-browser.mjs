// Released drags settle exactly where they were dropped: no frame may show the
// original position between pointerup, the saved write and reconciliation.
// Isolated external fixture, headless browser, port 0.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-drag-settle-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-drag-settle-evidence-'));
await mkdir(evidence,{recursive:true});let server,browser;
const results={};
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Drag settle fixture']);
  const config=await loadConfig(configFile),board=(await applyOperation(config,{type:'createBoard',title:'Drag settle'})).result;
  const op=async operation=>(await applyOperation(config,{...operation,boardId:operation.boardId||board.boardId})).result;
  await mkdir(path.join(fixture,'resources'),{recursive:true});
  await writeFile(path.join(fixture,'resources/index.html'),'<h1>Mounted preview</h1>');
  await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:{docs:{path:path.relative(path.join(fixture,'boards/.tinka'),path.join(fixture,'resources'))}}}});
  await op({type:'createDecoration',decoration:{id:'sticky',type:'region',shape:'rectangle',x:0,y:0,width:220,height:200,color:'#f6e6a4',text:'A thought to keep'}});
  const panel=await op({type:'createItem',item:{title:'HTML panel',content:{kind:'html',resource:{rootId:'docs',path:'index.html'}}},placement:{x:300,y:0,width:300,height:250,presentation:{mode:'panel',viewport:{width:400,height:300}}}});
  const child=await op({type:'createBoard',title:'Nested board',parentBoardId:board.boardId});
  const one=await op({type:'createItem',item:{title:'First idea'},placement:{x:0,y:620,width:220,height:160}});
  const two=await op({type:'createItem',item:{title:'Second idea'},placement:{x:260,y:620,width:220,height:160}});
  const anchor=await op({type:'createItem',item:{title:'Stationary reference'},placement:{x:700,y:620,width:220,height:160}});
  const placementOf=async itemId=>(await getBoardSnapshot(config,board.boardId)).placements.find(p=>p.itemId===itemId).id;
  const ids={panel:panel.placementIds?.[0]||await placementOf(panel.itemId),one:await placementOf(one.itemId),two:await placementOf(two.itemId),anchor:await placementOf(anchor.itemId)};
  ids.board=(await getBoardSnapshot(config,board.boardId)).placements.find(p=>![ids.panel,ids.one,ids.two,ids.anchor].includes(p.id)).id;
  await op({type:'updatePlacement',placementId:ids.board,patch:{x:1000,y:0,width:240,height:260}});
  server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Realistic write latency makes any intermediate frame observable.
  let delay=250;await page.route('**/api/operations',async route=>{await new Promise(r=>setTimeout(r,delay));await route.continue();});
  await page.goto(`${url}/boards/${board.boardId}/`);await page.locator('[data-decoration=sticky]').waitFor();
  await page.locator('#live-status[data-connection="live"]').waitFor();
  const snapshot=()=>getBoardSnapshot(config,board.boardId);
  // Type into the sticky first, as in the report.
  await page.locator('[data-decoration=sticky] [data-decoration-label]').dblclick();await page.locator('.whiteboard-editor textarea').fill('Typed before dragging');
  await page.keyboard.press('Meta+Enter');await page.locator('.whiteboard-editor').waitFor({state:'detached'});
  await page.waitForFunction(()=>!document.querySelector('[data-decoration=sticky] .whiteboard-draft-state'));
  await page.waitForTimeout(400);
  const sel={sticky:'[data-decoration="sticky"]',panel:`[data-placement="${ids.panel}"]`,board:`[data-placement="${ids.board}"]`,one:`[data-placement="${ids.one}"]`,two:`[data-placement="${ids.two}"]`,anchor:`[data-placement="${ids.anchor}"]`};
  const grab={sticky:'[data-decoration="sticky"] [data-decoration-label]',panel:`[data-placement="${ids.panel}"] .workspace-preview-launch`,board:`[data-placement="${ids.board}"]`,one:`[data-placement="${ids.one}"]`};
  const geometry=async(kind)=>{const s=await snapshot();if(kind==='sticky'){const d=s.decorations.find(d=>d.id==='sticky');return {x:d.x,y:d.y};}const p=s.placements.find(p=>p.id===ids[kind]);return {x:p.x,y:p.y};};
  // Sample painted positions every animation frame (relative to a stationary card, so
  // view recentering is reported separately) and record every style write synchronously.
  const startTrace=watch=>page.evaluate(({watch,anchor})=>{
    const trace={frames:[],writes:[],up:null,on:true};window.__trace=trace;
    const rect=s=>{const el=document.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top)};};
    const tick=()=>{const a=rect(anchor);trace.frames.push({t:performance.now(),a,items:watch.map(s=>{const r=rect(s);return r&&a?{x:r.x-a.x,y:r.y-a.y}:null;})});if(trace.on)requestAnimationFrame(tick);};
    requestAnimationFrame(tick);
    window.addEventListener('pointerup',()=>{trace.up=performance.now();},{capture:true,once:true});
    trace.observer=new MutationObserver(list=>{for(const m of list){const el=m.target;if(el.nodeType!==1)continue;const i=watch.findIndex(s=>el.matches(s));if(i>=0)trace.writes.push({t:performance.now(),i,left:el.style.left,top:el.style.top});}});
    trace.observer.observe(document.getElementById('world'),{subtree:true,attributes:true,attributeFilter:['style']});
  },{watch,anchor:sel.anchor});
  const stopTrace=()=>page.evaluate(()=>{const t=window.__trace;t.on=false;t.observer.disconnect();return {frames:t.frames,writes:t.writes,up:t.up};});
  const centre=async s=>{const b=await page.locator(s).first().boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2};};
  // Drag with real mouse events, then require every frame after release to keep the drop position.
  const dragCase=async(name,{grabSelector,watch,kinds,dx,dy,during})=>{
    const before=await Promise.all(kinds.map(geometry));
    const p=await centre(grabSelector);
    await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+dx,p.y+dy,{steps:8});
    if(during)await during();
    await page.waitForTimeout(50);
    const dropped=await page.evaluate(({watch,anchor})=>{const a=document.querySelector(anchor).getBoundingClientRect();return watch.map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:Math.round(r.left-a.left),y:Math.round(r.top-a.top)};});},{watch,anchor:sel.anchor});
    const original=await page.evaluate(({kinds,before})=>kinds.map((k,i)=>before[i]),{kinds,before});
    await startTrace(watch);await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    const trace=await stopTrace();
    const after=await Promise.all(kinds.map(geometry));
    const released=trace.frames.filter(f=>trace.up!==null&&f.t>=trace.up);
    const off=released.filter(f=>f.items.some((r,i)=>!r||Math.abs(r.x-dropped[i].x)>1||Math.abs(r.y-dropped[i].y)>1));
    const zoom=await page.evaluate(()=>parseFloat(getComputedStyle(document.getElementById('world')).transform.split('(')[1])||1);
    const atOriginal=off.filter(f=>f.items.some((r,i)=>r&&Math.abs(r.x-(dropped[i].x-Math.round(dx)))<=2&&Math.abs(r.y-(dropped[i].y-Math.round(dy)))<=2));
    const summary={original,saved:after,dropped,releasedFrames:released.length,framesOffDrop:off.length,framesAtOriginal:atOriginal.length,
      firstOff:off.slice(0,3).map(f=>({ms:Math.round(f.t-trace.up),items:f.items})),viewShift:released.length?{x:released.at(-1).a.x-trace.frames[0].a.x,y:released.at(-1).a.y-trace.frames[0].a.y}:null,
      styleWrites:trace.writes.filter(w=>w.t>=trace.up).map(w=>({ms:Math.round(w.t-trace.up),i:w.i,left:w.left,top:w.top})),zoom};
    results[name]=summary;console.log(name,JSON.stringify(summary));
    return summary;
  };
  const expectSettled=(name,s,kinds,dx,dy)=>{
    assert.deepEqual(s.viewShift,{x:0,y:0},`${name}: the canvas view moved after release`);
    assert.equal(s.framesOffDrop,0,`${name}: ${s.framesOffDrop} released frame(s) left the drop position (${s.framesAtOriginal} at the original position): ${JSON.stringify(s.firstOff)}`);
    s.saved.forEach((g,i)=>{assert.notDeepEqual(g,s.original[i],`${name}: move was not saved`);});
  };
  const sticky=await dragCase('sticky',{grabSelector:grab.sticky,watch:[sel.sticky],kinds:['sticky'],dx:60,dy:260});
  const panelDrag=await dragCase('html-panel',{grabSelector:grab.panel,watch:[sel.panel],kinds:['panel'],dx:40,dy:300});
  const boardDrag=await dragCase('nested-board',{grabSelector:grab.board,watch:[sel.board],kinds:['board'],dx:-30,dy:300});
  // Multi-select drag uses translatePlacements.
  for(const id of [ids.one,ids.two])await page.locator(`[data-placement="${id}"] [data-placement-select]`).click();
  await page.evaluate(()=>document.activeElement?.blur());
  const group=await dragCase('multi-select',{grabSelector:grab.one,watch:[sel.one,sel.two],kinds:['one','two'],dx:50,dy:-120});
  // Lost move: another writer changes the workspace while the drag is held.
  await page.keyboard.press('Escape');
  const stale=await dragCase('stale-revision-sticky',{grabSelector:grab.sticky,watch:[sel.sticky],kinds:['sticky'],dx:40,dy:40,
    during:()=>op({type:'updateItem',itemId:anchor.itemId,patch:{title:'Renamed by another writer'}})});
  results.staleDialog=await page.locator('dialog.workspace-dialog[open]').count();
  if(results.staleDialog)await page.keyboard.press('Escape');
  const stalePanel=await dragCase('stale-revision-panel',{grabSelector:grab.panel,watch:[sel.panel],kinds:['panel'],dx:30,dy:30,
    during:()=>op({type:'updateItem',itemId:anchor.itemId,patch:{title:'Renamed again'}})});
  results.stalePanelDialog=await page.locator('dialog.workspace-dialog[open]').count();
  if(results.stalePanelDialog)await page.keyboard.press('Escape');
  await writeFile(path.join(evidence,'drag-settle-results.json'),JSON.stringify(results,null,2));
  const failures=[];
  for(const [name,s] of [['sticky',sticky],['html-panel',panelDrag],['nested-board',boardDrag],['multi-select',group],['stale-revision-sticky',stale],['stale-revision-panel',stalePanel]])
    try{expectSettled(name,s);}catch(e){failures.push(e.message);}
  assert.deepEqual(failures,[],failures.join('\n'));
  // Undo and redo still replay a settled drop.
  const panelSaved=await geometry('panel');
  await page.waitForFunction(()=>document.getElementById('workspace-undo')?.disabled===false);await page.keyboard.press('ControlOrMeta+z');
  for(let i=0;i<40&&JSON.stringify(await geometry('panel'))===JSON.stringify(panelSaved);i++)await page.waitForTimeout(50);
  results.undo=await geometry('panel');assert.deepEqual(results.undo,{x:340,y:300},'Undo restores the pre-drop position');
  await page.waitForFunction(()=>document.getElementById('workspace-redo')?.disabled===false);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  for(let i=0;i<40&&JSON.stringify(await geometry('panel'))!==JSON.stringify(panelSaved);i++)await page.waitForTimeout(50);
  results.redo=await geometry('panel');assert.deepEqual(results.redo,panelSaved,'Redo replays the drop');
  await page.waitForTimeout(400);
  // Real conflicts and failed saves stay visible: a dialog, then the latest saved position.
  const rendered=(kind)=>page.evaluate(({s,anchor})=>{const a=document.querySelector(anchor).getBoundingClientRect(),r=document.querySelector(s).getBoundingClientRect();return {x:Math.round(r.left-a.left),y:Math.round(r.top-a.top)};},{s:sel[kind],anchor:sel.anchor});
  const expectRolledBack=async(name,kind)=>{
    const dialog=await page.locator('dialog.workspace-dialog[open]').count();
    if(dialog)await page.keyboard.press('Escape');
    const saved=await geometry(kind),a=(await snapshot()).placements.find(p=>p.id===ids.anchor);
    const want={x:saved.x-a.x,y:saved.y-a.y};let got;
    for(let i=0;i<40;i++){got=await rendered(kind);if(got.x===want.x&&got.y===want.y)break;await page.waitForTimeout(50);}
    results[name]={dialog,saved,rendered:got,expected:want};console.log(name,JSON.stringify(results[name]));
    assert.equal(dialog,1,`${name}: the rejected drop must be reported`);assert.deepEqual(got,want,`${name}: the board must show the latest saved position`);
    return saved;
  };
  await dragCase('conflict-sticky',{grabSelector:grab.sticky,watch:[sel.sticky],kinds:['sticky'],dx:30,dy:30,
    during:()=>op({type:'updateDecoration',decorationId:'sticky',patch:{x:700,y:260}})});
  assert.deepEqual(await expectRolledBack('conflict-sticky-result','sticky'),{x:700,y:260},'Another writer\'s sticky move is not overwritten');
  await dragCase('conflict-panel',{grabSelector:grab.panel,watch:[sel.panel],kinds:['panel'],dx:30,dy:30,
    during:()=>op({type:'updatePlacement',placementId:ids.panel,patch:{x:300,y:0}})});
  assert.deepEqual(await expectRolledBack('conflict-panel-result','panel'),{x:300,y:0},'Another writer\'s card move is not overwritten');
  const fail=async route=>{if(['updatePlacement','updateDecoration'].includes(route.request().postDataJSON()?.type))return route.fulfill({status:500,contentType:'application/json',body:'{"error":"Request failed."}'});await new Promise(r=>setTimeout(r,delay));return route.continue();};
  await page.unroute('**/api/operations');await page.route('**/api/operations',fail);
  const beforeFail={sticky:await geometry('sticky'),panel:await geometry('panel')};
  await dragCase('failed-sticky',{grabSelector:grab.sticky,watch:[sel.sticky],kinds:['sticky'],dx:-40,dy:40});
  assert.deepEqual(await expectRolledBack('failed-sticky-result','sticky'),beforeFail.sticky);
  await dragCase('failed-panel',{grabSelector:grab.panel,watch:[sel.panel],kinds:['panel'],dx:40,dy:40});
  assert.deepEqual(await expectRolledBack('failed-panel-result','panel'),beforeFail.panel);
  await page.screenshot({path:path.join(evidence,'drag-settle.png')});
  await writeFile(path.join(evidence,'drag-settle-results.json'),JSON.stringify(results,null,2));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,evidence,checks:'sticky, HTML panel, nested board, multi-select and stale-revision drops settle at the drop position from release through save and reconcile'}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
