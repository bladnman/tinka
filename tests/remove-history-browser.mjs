// Focused, external-fixture QA; synthetic clipboard events never touch the OS clipboard.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '../cli.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const fixture = await mkdtemp(path.join(tmpdir(), 'tinka-remove-ui-'));
const evidence = process.env.TINKA_EVIDENCE_DIR || await mkdtemp(path.join(tmpdir(), 'tinka-remove-evidence-'));
const config = path.join(fixture, 'local/config.json'), boards = path.join(fixture, 'boards');
await mkdir(evidence, { recursive: true });
let browser;
const receipts = [], guards = [], errors = [];
try {
  await main(['init', '--config', config, '--boards', boards, '--label', 'Removal fixture']);
  await main(['workspace', 'init', '--config', config, '--apply']);
  await mkdir(path.join(boards, 'resources'), {recursive:true});
  const resource = '<!doctype html><title>Retained prototype</title><h1>Retained prototype</h1><input aria-label="Prototype input"><script>window.loadIdentity=crypto.randomUUID()</script>';
  await writeFile(path.join(boards, 'resources/prototype.html'), resource);
  await main(['start', '--config', config]);
  const local = JSON.parse(await readFile(config)), base = `http://127.0.0.1:${local.port}`;
  const cfg = await (await fetch(base + '/api/config')).json();
  const snapshot = async () => (await fetch(base + '/api/workspace')).json();
  const board = (ws,id) => ws.boards.find(b => b.id === id);
  const arrange = (ws,id) => ({placements:board(ws,id).placements,reviewOrder:board(ws,id).reviewOrder});
  const post = async data => {
    const response = await fetch(base + '/api/operations', {method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':cfg.workspaceId},body:JSON.stringify(data)});
    return {status:response.status,data:await response.json()};
  };
  const op = async (type,data) => {
    const result = await post({type,...data,expectedRevision:(await snapshot()).revision,operationId:crypto.randomUUID()});
    assert.equal(result.status,200,JSON.stringify(result.data));return result.data.result;
  };
  await op('updateWorkspace',{patch:{resourceRoots:{fixture:{path:'../resources'}}}});
  const source = await op('createBoard',{title:'Remove from this board'});
  const other = await op('createBoard',{title:'Other references'});
  const parent = await op('createBoard',{title:'Live collection observer'});
  const content = {kind:'html',resource:{rootId:'fixture',path:'prototype.html'}};
  const original = await op('createItem',{boardId:source.boardId,item:{title:'Shared prototype',content,review:{note:'Original note',star:true}},placement:{x:20,y:25,width:220,height:230,z:6,presentation:{mode:'panel',viewport:{width:220,height:180},paper:'#f1e8d5'}}});
  const alias = await op('reference',{itemIds:[original.itemId],targetBoardId:source.boardId});
  await op('updatePlacement',{boardId:source.boardId,placementId:alias.placementIds[0],patch:{x:280,y:50,width:180,height:210,z:2}});
  const collection = await op('createBoard',{title:'Kept child board',parentBoardId:source.boardId});
  await op('updatePlacement',{boardId:source.boardId,placementId:collection.placementIds[0],patch:{x:510,y:30,width:200,height:230,z:9}});
  await op('createItem',{boardId:collection.boardId,item:{title:'Retained child',content:{kind:'note',text:'Child body'}}});
  const survivor = await op('createItem',{boardId:source.boardId,item:{title:'Surviving HTML',content},placement:{x:760,y:30,width:220,height:230,presentation:{mode:'panel',viewport:{width:220,height:180}}}});
  await op('reference',{itemIds:[original.itemId],targetBoardId:other.boardId});
  const sourceOwner = board(await snapshot(),source.boardId).ownerItemId;
  const parentReference = await op('reference',{itemIds:[sourceOwner],targetBoardId:parent.boardId});
  const ids = [original.placementIds[0],alias.placementIds[0],collection.placementIds[0]];
  const initial = await snapshot();
  await op('updateBoard',{boardId:source.boardId,patch:{reviewOrder:[ids[2],survivor.placementIds[0],ids[1],ids[0]]}});
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context = await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  await context.addInitScript(() => {
    const blocked=()=>{throw new Error('QA must not access the OS clipboard');};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:blocked,readText:blocked,write:blocked,writeText:blocked}});
  });
  const page = await context.newPage(), observer = await context.newPage();
  for (const p of [page,observer]) p.on('pageerror',e=>errors.push(e.message));
  const writes = [], key = `tinka/${cfg.workspaceId}/movement-history`;
  page.on('request',r=>{if(r.method()==='POST'&&r.url()===base+'/api/operations')writes.push(r.postDataJSON());});
  const state = async()=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'{"undo":[],"redo":[]}'),key);
  const ready = async p => {
    await p.waitForFunction(()=>document.getElementById('workspace-paste')?.disabled===false);
    await p.locator('#live-status[data-connection="live"]').waitFor();
  };
  const show = async(p,id)=>{await p.goto(base+`/boards/${id}/`);await p.locator('#workspace-copy').waitFor({state:'attached'});await ready(p);};
  const card = id=>page.locator(`[data-placement="${id}"]`);
  const select = async selected=>{
    while(await page.locator('.workspace-card.selected [data-placement-select]').count()) await page.locator('.workspace-card.selected [data-placement-select]').first().click();
    for (const id of selected) await card(id).locator('[data-placement-select]').click();
    await page.evaluate(()=>document.activeElement?.blur());
    assert.deepEqual(await page.locator('.workspace-card.selected').evaluateAll(cards=>cards.map(c=>c.dataset.placement).sort()),[...selected].sort());
  };
  const commit = async(action,type='remove')=>{
    const before=await snapshot(),count=writes.length,previous=await state();
    const response=page.waitForResponse(r=>r.url()===base+'/api/operations'&&r.request().postDataJSON()?.type===type);
    await action();const reply=await response,body=await reply.json();assert.equal(reply.status(),200,JSON.stringify(body));assert(body.history);
    await page.waitForFunction(({key,receipt})=>{const s=JSON.parse(sessionStorage.getItem(key)||'{}');return [...s.undo||[],...s.redo||[]].some(e=>JSON.stringify(e.history)===JSON.stringify(receipt));},{key,receipt:body.history});
    await ready(page);const after=await snapshot();assert.equal(after.revision,before.revision+1);assert.deepEqual(writes.slice(count).map(w=>w.type),[type]);
    if(type==='remove'){assert.equal((await state()).undo.length,previous.undo.length+1);assert.equal((await state()).redo.length,0);assert.equal((await state()).undo.at(-1).label,ids.length===writes[count].placementIds.length?'Remove 3 items':'Remove item');}
    receipts.push({type,before:before.revision,after:after.revision,placementIds:writes[count].placementIds});return {before,after,body};
  };
  const replay=async redo=>commit(async()=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(redo?'Meta+Shift+z':'Meta+z');},'restoreMovement');
  const cut = async(p=page)=>p.evaluate(()=>{document.activeElement?.blur();const transfer=new DataTransfer(),event=new ClipboardEvent('cut',{clipboardData:transfer,bubbles:true,cancelable:true});document.body.dispatchEvent(event);return {prevented:event.defaultPrevented,data:Object.fromEntries([...transfer.types].map(k=>[k,transfer.getData(k)]))};});
  const cutKey=`tinka/${cfg.workspaceId}/${initial.workspaceId}/cut-intent`;
  const cutValue=()=>page.evaluate(k=>localStorage.getItem(k),cutKey);
  const noWrite=async(name,action)=>{const before=await snapshot(),count=writes.length,history=await state();await action();await page.waitForTimeout(80);assert.equal(writes.length,count,name+' '+JSON.stringify(writes.slice(count)));assert.equal((await snapshot()).revision,before.revision,name);assert.deepEqual(await state(),history,name);guards.push(name);};
  await show(observer,parent.boardId);await observer.locator('[data-cover-count="4"]').waitFor();
  await show(page,source.boardId);
  await card(survivor.placementIds[0]).locator('iframe').contentFrame().locator('.item-full-frame').contentFrame().getByRole('heading').waitFor();
  await card(survivor.placementIds[0]).locator('iframe').evaluate(frame=>{window.keptFrame=frame;window.keptLoads=0;frame.addEventListener('load',()=>window.keptLoads++);});
  await noWrite('empty selection',()=>page.keyboard.press('Delete'));
  await select(ids);const pending=await cut();assert.equal(pending.prevented,true);assert(await cutValue());
  await page.screenshot({path:path.join(evidence,'remove-selected-1440.png')});
  const removed=await commit(()=>page.keyboard.press('Delete'));
  assert.equal(await page.locator('dialog[open]').count(),0,'Keyboard removal is immediate');assert.equal(await cutValue(),null,'Successful removal clears the captured pending cut');
  assert.deepEqual(removed.after.items,removed.before.items,'Remove preserves every canonical item');
  assert.deepEqual(board(removed.after,other.boardId),board(removed.before,other.boardId));
  assert.deepEqual(board(removed.after,collection.boardId),board(removed.before,collection.boardId));
  assert.equal(await page.locator('.workspace-card').count(),1);
  await observer.locator('[data-cover-count="1"]').waitFor();
  // Later canonical content/review remain current through exact arrangement replay.
  await op('updateItem',{itemId:original.itemId,patch:{title:'Later shared title',description:'Later description'}});
  await op('review',{itemId:original.itemId,patch:{note:'Later canonical note',star:false}});
  const currentItems=(await snapshot()).items;
  await replay(false);assert.deepEqual(arrange(await snapshot(),source.boardId),arrange(removed.before,source.boardId));assert.deepEqual((await snapshot()).items,currentItems);
  await observer.locator('[data-cover-count="4"]').waitFor();
  await replay(true);assert.deepEqual(arrange(await snapshot(),source.boardId),arrange(removed.after,source.boardId));assert.deepEqual((await snapshot()).items,currentItems);
  assert.equal(await page.evaluate(()=>window.keptFrame.isConnected&&window.keptLoads===0),true,'Surviving native preview stays mounted across remove/undo/redo');
  assert.equal(await readFile(path.join(boards,'resources/prototype.html'),'utf8'),resource);
  await page.screenshot({path:path.join(evidence,'remove-undone-redone-1440.png')});
  await replay(false);await select([ids[0]]);const backspace=await commit(()=>page.keyboard.press('Backspace'));await replay(false);assert.deepEqual(arrange(await snapshot(),source.boardId),arrange(backspace.before,source.boardId));
  // Editing, reader, arbitrary modal, iframe focus, modifiers and repeats keep ownership.
  await select([ids[0]]);
  for(const [name,markup] of [['input','<input id="qa-edit">'],['textarea','<textarea id="qa-edit"></textarea>'],['contenteditable','<div id="qa-edit" contenteditable="true">text</div>'],['textbox','<div id="qa-edit" role="textbox" tabindex="0">text</div>']]){
    await page.evaluate(html=>document.body.insertAdjacentHTML('beforeend',html),markup);await page.locator('#qa-edit').focus();await noWrite(name,()=>page.keyboard.press('Delete'));await page.locator('#qa-edit').evaluate(el=>el.remove());
  }
  await page.locator('#board-info-toggle').click();await page.locator('#workspace-search').focus();await noWrite('search editing',()=>page.keyboard.press('Backspace'));await page.locator('#board-info-toggle').click();
  await card(ids[0]).locator('[data-item-controls]').click();await page.locator('#workspace-item-controls [data-note]').focus();await noWrite('notes editing',()=>page.locator('#workspace-item-controls [data-note]').evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))));await page.keyboard.press('Escape');
  await card(ids[0]).locator('.workspace-panel-title').click();await page.locator('#reader-dialog[open]').waitFor();await noWrite('reader',()=>page.keyboard.press('Delete'));await page.locator('#close-reader').click();
  await page.evaluate(()=>{const d=document.createElement('dialog');d.id='qa-dialog';d.innerHTML='<button>Modal</button>';document.body.append(d);d.showModal();});await noWrite('dialog',()=>page.keyboard.press('Delete'));await page.locator('#qa-dialog').evaluate(d=>d.remove());
  await card(survivor.placementIds[0]).locator('iframe').contentFrame().locator('.item-full-frame').contentFrame().getByRole('textbox',{name:'Prototype input'}).focus();assert.equal(await page.evaluate(()=>document.activeElement.tagName),'IFRAME');await noWrite('iframe focused',()=>page.evaluate(()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))));await page.evaluate(()=>document.activeElement?.blur());
  for(const extra of [{repeat:true},{shiftKey:true},{ctrlKey:true},{metaKey:true},{altKey:true}])await noWrite('key guard '+JSON.stringify(extra),()=>page.evaluate(extra=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true,...extra})),extra));
  // A real pointer gesture owns the selection until released/cancelled.
  const title=await card(ids[0]).locator('.workspace-panel-title').boundingBox();await page.mouse.move(title.x+30,title.y+8);await page.mouse.down();await page.mouse.move(title.x+50,title.y+20,{steps:6});await noWrite('active drag',()=>page.keyboard.press('Delete'));await page.keyboard.press('Escape');await page.mouse.up();
  // Failed requests retain cut/history/placements; real stale mixed batches are atomic.
  await select([ids[0],ids[1]]);assert.equal((await cut()).prevented,true);const beforeFailure=await snapshot(),historyFailure=await state(),pendingFailure=await cutValue();
  await page.route('**/api/operations',route=>route.request().postDataJSON()?.type==='remove'?route.fulfill({status:409,contentType:'application/json',body:'{"error":"QA stale removal"}'}):route.continue());
  let response=page.waitForResponse(r=>r.request().postDataJSON()?.type==='remove');await page.keyboard.press('Delete');assert.equal((await response).status(),409);await ready(page);
  assert.deepEqual(arrange(await snapshot(),source.boardId),arrange(beforeFailure,source.boardId));assert.deepEqual(await state(),historyFailure);assert.equal(await cutValue(),pendingFailure);await page.locator('dialog.workspace-dialog[open]').waitFor();await page.keyboard.press('Escape');await page.locator('dialog.workspace-dialog[open]').waitFor({state:'detached'});await page.unroute('**/api/operations');
  for(const data of [{placementIds:[ids[0],'missing-placement']},{placementIds:[ids[0]],expectedRevision:0}]){const before=await snapshot(),result=await post({type:'remove',boardId:source.boardId,expectedRevision:before.revision,operationId:crypto.randomUUID(),...data});assert(result.status>=400);assert.deepEqual(await snapshot(),before,'Rejected batch changes no metadata');}
  // While one removal is blocked in flight, a second key cannot submit another write.
  // A newer cut from another tab must survive completion of the captured older intent.
  const peer=await context.newPage();await show(peer,source.boardId);await peer.locator(`[data-placement="${survivor.placementIds[0]}"] [data-placement-select]`).click();
  let release,seen;const held=new Promise(r=>release=r),entered=new Promise(r=>seen=r);
  await page.route('**/api/operations',async route=>{if(route.request().postDataJSON()?.type==='remove'){seen();await held;}await route.continue();});
  await select([ids[0]]);let completion=commit(async()=>{await page.keyboard.press('Delete');await entered;await noWrite('inflight duplicate key',()=>page.keyboard.press('Backspace'));assert.equal((await cut(peer)).prevented,true);release();});await completion;const newerCut=await cutValue();assert(newerCut);assert.notEqual(newerCut,pendingFailure);await page.unroute('**/api/operations');await peer.close();
  // Cancel the newer intent explicitly so Undo addresses this completed removal.
  await page.keyboard.press('Escape');await replay(false);
  // Toolbar confirmation calls the same undoable action, including cancellation.
  await select([ids[0]]);await noWrite('toolbar opens confirmation only',()=>page.locator('[data-bulk="remove"]').click());await page.locator('dialog.workspace-dialog[open]').waitFor();await page.keyboard.press('Escape');
  await page.locator('[data-bulk="remove"]').click();await commit(()=>page.getByRole('button',{name:'Remove from this board',exact:true}).click());await replay(false);
  assert.equal(await readFile(path.join(boards,'resources/prototype.html'),'utf8'),resource);assert.equal(errors.length,0,errors.join('\n'));
  const receipt={passed:true,fixture,evidence,operations:receipts,guards,exactIdentityGeometryReviewOrder:true,canonicalEditsRetained:true,aliasesChildrenReferencesResourcesRetained:true,collectionCoversLive:true,survivingFrameMounted:true,failedAndStaleAtomic:true,pendingCutUndoAndNewerTabIntent:true,toolbarConfirmedUndo:true,syntheticClipboardOnly:true,errors};
  await writeFile(path.join(evidence,'remove-history-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
} finally {if(browser)await browser.close();try{await main(['stop','--config',config]);}catch{}}
