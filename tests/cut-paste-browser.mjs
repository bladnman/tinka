// Deferred cut acceptance. All data and screenshots are disposable external fixtures;
// ClipboardEvent/DataTransfer exercise native handlers without using the OS clipboard.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-cut-ui-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-cut-evidence-'));
await mkdir(evidence,{recursive:true});
const config=path.join(fixture,'local/config.json'),boards=path.join(fixture,'boards');
let browser;
try {
  await main(['init','--config',config,'--boards',boards,'--label','Cut paste fixture']);
  await main(['workspace','init','--config',config,'--apply']);
  await main(['start','--config',config]);
  const local=JSON.parse(await readFile(config)),base=`http://127.0.0.1:${local.port}`;
  const runtime=await(await fetch(base+'/api/config')).json();
  const snapshot=async()=>await(await fetch(base+'/api/workspace?covers=0')).json();
  const request=async(data,headers={})=>{const response=await fetch(base+'/api/operations',{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':runtime.workspaceId,...headers},body:JSON.stringify(data)});return{response,data:await response.json()};};
  const op=async(type,data)=>{const ws=await snapshot(),r=await request({type,...data,expectedRevision:ws.revision,operationId:crypto.randomUUID()});assert(r.response.ok,JSON.stringify(r.data));return r.data.result;};
  const board=(ws,id)=>ws.boards.find(b=>b.id===id),item=(ws,id)=>ws.items.find(i=>i.id===id);
  const active=(ws,id)=>board(ws,id).placements.filter(p=>!p.removedAt);
  const arrangement=(ws,...ids)=>ids.map(id=>({id,placements:board(ws,id).placements,reviewOrder:board(ws,id).reviewOrder}));
  const source=await op('createBoard',{title:'Cut source'}),target=await op('createBoard',{title:'Cut destination'}),other=await op('createBoard',{title:'Other destination'});
  const assets=path.join(boards,'assets');await mkdir(assets,{recursive:true});
  const html='<!doctype html><html><body><h1>Portable content</h1><input aria-label="Prototype input"></body></html>';
  await writeFile(path.join(assets,'portable.html'),html);
  await op('updateWorkspace',{patch:{resourceRoots:{fixture:{path:'../assets'}}}});
  const children=[];for(let i=0;i<2;i++)children.push(await op('createItem',{boardId:source.boardId,item:{title:i?'Notebook':'Focus reader',content:{kind:'html',resource:{rootId:'fixture',path:'portable.html'}},review:{note:'Original note '+i,star:true}},placement:{x:i*270-70,y:i*55-20,width:210+i*10,height:240-i*10,z:7-i*4,presentation:{mode:'panel',viewport:{width:200,height:194},paper:i?'#e4ebdc':'#f1e8d5'}}}));
  const aliases=await op('reference',{itemIds:[children[0].itemId],targetBoardId:other.boardId});
  const group=await op('createBoard',{title:'Collection',parentBoardId:source.boardId});
  const kept=await op('createItem',{boardId:group.boardId,item:{title:'Keep child',content:{kind:'note',text:'Nested content stays.'}}});
  const ids=[...children.map(i=>i.placementIds[0]),...group.placementIds];
  await op('updatePlacement',{boardId:source.boardId,placementId:group.placementIds[0],patch:{x:500,y:120,width:240,height:260,z:12}});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],writes=[],receipts=[];
  page.setDefaultTimeout(15000);
  const guard=async p=>{p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()==='POST'&&/\/api\/(?:operations|imports)$/.test(r.url()))writes.push({page:p,url:r.url(),type:r.url().endsWith('/api/imports')?'importFiles':r.postDataJSON()?.type,data:r.url().endsWith('/api/imports')?null:r.postDataJSON()});});await p.addInitScript(()=>{window.qaClipboardCalls=[];const blocked=()=>{window.qaClipboardCalls.push('OS clipboard');throw new Error('QA must not touch OS clipboard');};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:blocked,readText:blocked,write:blocked,writeText:blocked}});const exec=document.execCommand.bind(document);document.execCommand=(name,...args)=>['copy','cut','paste'].includes(name)?blocked():exec(name,...args);});};
  await guard(page);
  const ready=async(p=page)=>await p.waitForFunction(()=>document.getElementById('workspace-paste')?.disabled===false);
  const show=async(id,p=page,width=1440)=>{await p.setViewportSize({width,height:960});const loaded=p.waitForResponse(r=>r.url()===base+'/api/workspace?covers=0'&&r.ok());await p.goto(base+`/boards/${id}/`);await p.locator('#workspace-copy').waitFor({state:'attached'});await loaded;await ready(p);if(await p.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await p.locator('#board-info-toggle').click();await p.locator('[data-mode="canvas"]').click();await p.locator('#board-info-toggle').click();}if(await p.locator('.workspace-card').count())await p.locator('#fit').click();await p.evaluate(()=>document.activeElement?.blur());};
  const card=(id,p=page)=>p.locator(`[data-placement="${id}"]`);
  const select=async(ids,p=page)=>{for(const el of await p.locator('.workspace-card.selected [data-placement-select]').all())await el.click();for(const id of ids)await card(id,p).locator('[data-placement-select]').click();assert.deepEqual(await p.locator('.workspace-card.selected').evaluateAll(cs=>cs.map(c=>c.dataset.placement).sort()),[...ids].sort());await p.evaluate(()=>document.activeElement?.blur());};
  const event=async(type,data={},p=page,target,files=[])=>await p.evaluate(({type,data,target,files})=>{const transfer=new DataTransfer();for(const [k,v]of Object.entries(data))transfer.setData(k,v);for(const f of files)transfer.items.add(new File([Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))],f.name,{type:f.type}));const e=new ClipboardEvent(type,{clipboardData:transfer,bubbles:true,cancelable:true});(target?document.querySelector(target):document.body).dispatchEvent(e);return{prevented:e.defaultPrevented,data:Object.fromEntries([...transfer.types].filter(t=>t!=='Files').map(t=>[t,transfer.getData(t)]))};},{type,data,target,files});
  const mime='application/x-tinka-placements+json',historyKey=`tinka/${runtime.workspaceId}/movement-history`;
  const commit=async(action,type='move',p=page)=>{await ready(p);const before=await snapshot(),start=writes.length,pending=p.waitForResponse(r=>r.request().method()==='POST'&&r.url()===base+(type==='importFiles'?'/api/imports':'/api/operations')&&(type==='importFiles'||r.request().postDataJSON()?.type===type));await action();const response=await pending,data=await response.json();assert.equal(response.status(),200,JSON.stringify(data));assert(data.history,'One movement receipt');await p.waitForFunction(({key,receipt})=>{const s=JSON.parse(sessionStorage.getItem(key)||'{}');return [...s.undo||[],...s.redo||[]].some(e=>JSON.stringify(e.history)===JSON.stringify(receipt));},{key:historyKey,receipt:data.history});await ready(p);const after=await snapshot();assert.equal(after.revision,before.revision+1);assert.deepEqual(writes.slice(start).map(w=>w.type),[type]);receipts.push({type,before:before.revision,after:after.revision});return{before,after,result:data.result,operation:writes[start].data};};
  const replay=async redo=>{await page.waitForFunction(d=>document.getElementById('workspace-'+d)?.disabled===false,redo?'redo':'undo');return await commit(async()=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(redo?'Control+Shift+z':'Control+z');},'restoreMovement');};
  const unchanged=async(action,{allowRequest=false}={})=>{const before=await snapshot(),start=writes.length;await page.evaluate(()=>{const el=document.getElementById('workspace-toast');if(el)el.textContent='';});await action();await page.waitForFunction(()=>document.getElementById('workspace-toast')?.textContent);await ready();assert.deepEqual(await snapshot(),before,'Rejected or cancelled cut makes no graph changes');if(!allowRequest)assert.equal(writes.length,start);};
  const cut=async selected=>{await select(selected);const before=await snapshot(),start=writes.length,result=await event('cut');assert.equal(result.prevented,true);assert(result.data[mime]);const payload=JSON.parse(result.data[mime]);assert(payload.cut?.nonce);assert.equal(payload.cut.sourceBoardId,source.boardId);assert.equal(writes.length,start,'Cut only marks its source');assert.deepEqual(await snapshot(),before);return{...result,payload,before};};
  await show(source.boardId);
  const original=await snapshot();let saved=await cut(ids);
  assert.equal(await page.locator('.workspace-cut-pending').count(),ids.length,'Source cut marker covers the selected group');
  for(const child of children)await card(child.placementIds[0]).locator('iframe').contentFrame().locator('.item-full-frame').contentFrame().getByRole('heading').waitFor();
  await page.locator('.workspace-card iframe').evaluateAll(frames=>{window.qaCutFrames=frames.map(frame=>({frame,loads:0}));for(const p of window.qaCutFrames)p.frame.addEventListener('load',()=>p.loads++);});
  saved={...await event('cut'),payload:saved.payload,before:saved.before};saved.payload=JSON.parse(saved.data[mime]);assert.equal(await page.evaluate(()=>window.qaCutFrames.every(p=>p.frame.isConnected&&p.loads===0)),true,'Refreshing a cut mark preserves preview DOM');
  await page.screenshot({path:path.join(evidence,'cut-source-marked.png')});
  await unchanged(()=>event('paste',saved.data)); // Same-board cut paste keeps pending intent.
  await op('review',{itemId:children[0].itemId,patch:{note:'Written after cut',star:false}});
  await op('updateItem',{itemId:children[1].itemId,patch:{title:'Latest title after cut'}});
  const latest=await snapshot(),canonical=latest.items,childArrangement=arrangement(latest,group.boardId),aliasArrangement=arrangement(latest,other.boardId);
  await show(target.boardId);
  const moved=await commit(async()=>assert.equal((await event('paste',{'text/plain':saved.data['text/plain']})).prevented,true));
  assert.deepEqual(moved.result.itemIds,saved.payload.placements.map(p=>p.itemId),'Cut preserves canonical identity');
  assert.deepEqual(moved.after.items,canonical,'Paste reads latest content and review without rewriting them');
  assert.deepEqual(arrangement(moved.after,group.boardId),childArrangement,'Child board identity and layout unchanged');
  assert.deepEqual(arrangement(moved.after,other.boardId),aliasArrangement,'Other aliases unchanged');
  assert.equal(active(moved.after,source.boardId).filter(p=>ids.includes(p.id)).length,0);
  const placed=moved.result.placementIds.map(id=>active(moved.after,target.boardId).find(p=>p.id===id)),min={x:Math.min(...saved.payload.placements.map(p=>p.x)),y:Math.min(...saved.payload.placements.map(p=>p.y))};
  for(let i=0;i<placed.length;i++){const p=placed[i],old=saved.payload.placements[i];assert.notEqual(p.id,old.id);assert.equal(p.itemId,old.itemId);assert.deepEqual([p.x,p.y],[moved.operation.targetPosition.x+old.x-min.x,moved.operation.targetPosition.y+old.y-min.y]);for(const key of ['width','height','presentation'])assert.deepEqual(p[key],old[key]);for(let j=0;j<placed.length;j++)assert.equal(Math.sign(p.z-placed[j].z),Math.sign(old.z-saved.payload.placements[j].z),'Relative stacking order retained');}
  assert.deepEqual(board(moved.after,target.boardId).reviewOrder.slice(-ids.length),saved.payload.reviewOrder.map(id=>moved.result.placementIds[saved.payload.placements.findIndex(p=>p.id===id)]));
  await card(moved.result.placementIds.find((id,i)=>moved.result.itemIds[i]===group.itemId)).locator('[data-cover-tile]').waitFor();
  for(let i=0;i<2;i++)await card(moved.result.placementIds[i]).locator('iframe').contentFrame().locator('.item-full-frame').contentFrame().getByRole('heading').waitFor();
  await page.screenshot({path:path.join(evidence,'cut-pasted-arrangement.png')});
  await page.setViewportSize({width:390,height:960});await page.locator('#fit').click();await page.screenshot({path:path.join(evidence,'cut-pasted-arrangement-390.png')});assert.deepEqual(await snapshot(),moved.after,'Fitting narrow view keeps saved geometry');await page.setViewportSize({width:1440,height:960});await page.locator('#fit').click();
  assert.equal(await page.locator('.workspace-cut-pending').count(),0);
  await unchanged(()=>event('paste',saved.data));
  const undone=await replay(false);assert.deepEqual(arrangement(undone.after,source.boardId,target.boardId),arrangement(moved.before,source.boardId,target.boardId),'One undo restores original identities and order');assert.deepEqual(undone.after.items,canonical);
  await unchanged(()=>event('paste',saved.data)); // Undo must not revive the cut token.
  const redone=await replay(true);assert.deepEqual(arrangement(redone.after,source.boardId,target.boardId),arrangement(moved.after,source.boardId,target.boardId),'One redo restores exact destination IDs');
  const secondPage=await context.newPage();await guard(secondPage);await show(other.boardId,secondPage);
  const secondBefore=await snapshot(),secondWrites=writes.length;await event('paste',saved.data,secondPage);await secondPage.waitForFunction(()=>document.getElementById('workspace-toast')?.textContent);await ready(secondPage);assert.deepEqual(await snapshot(),secondBefore,'Consumed token stays consumed across tabs');assert.equal(writes.length,secondWrites);
  // Two tabs racing the same pending token can commit only once.
  const raceSource=await op('createBoard',{title:'Race source'}),raceItem=await op('createItem',{boardId:raceSource.boardId,item:{title:'One move only'}});
  await show(raceSource.boardId);await select(raceItem.placementIds);const raceCut=await event('cut');await show(other.boardId);await show(other.boardId,secondPage);
  const raceBefore=await snapshot(),raceStart=writes.length;let unblock;
  const blocked=new Promise(resolve=>{unblock=resolve;});let arrived;
  const firstArrived=new Promise(resolve=>{arrived=resolve;});
  await page.route('**/api/operations',async route=>{if(route.request().postDataJSON()?.type==='move'){arrived();await blocked;}await route.continue();});
  const raceResponse=page.waitForResponse(r=>r.url()===base+'/api/operations'&&r.request().postDataJSON()?.type==='move');
  await event('paste',raceCut.data);await firstArrived;await event('paste',raceCut.data,secondPage);unblock();const raceReply=await raceResponse;assert.equal(raceReply.status(),200);await ready();await ready(secondPage);await secondPage.waitForFunction(()=>document.getElementById('workspace-toast')?.textContent.includes('already used'));
  await page.unroute('**/api/operations');const raceAfter=await snapshot();assert.equal(raceAfter.revision,raceBefore.revision+1);assert.deepEqual(writes.slice(raceStart).map(w=>w.type),['move']);assert.equal(active(raceAfter,other.boardId).filter(p=>p.itemId===raceItem.itemId).length,1);
  // A different tab may start a newer cut while an older move is submitted.
  // Completion of the old move must not clear the newer marker or authority.
  const older=await op('createItem',{boardId:raceSource.boardId,item:{title:'Older inflight cut'}}),newer=await op('createItem',{boardId:raceSource.boardId,item:{title:'Newer pending cut'}});
  await show(raceSource.boardId);await select(older.placementIds);const olderCut=await event('cut');await show(other.boardId);await show(raceSource.boardId,secondPage);await select(newer.placementIds,secondPage);
  let releaseOlder,olderArrived;const olderBlocked=new Promise(resolve=>{releaseOlder=resolve;}),olderStarted=new Promise(resolve=>{olderArrived=resolve;});
  await page.route('**/api/operations',async route=>{if(route.request().postDataJSON()?.type==='move'){olderArrived();await olderBlocked;}await route.continue();});const olderResponse=page.waitForResponse(r=>r.url()===base+'/api/operations'&&r.request().postDataJSON()?.type==='move');await event('paste',olderCut.data);await olderStarted;
  const newerCut=await event('cut',{},secondPage),newerPayload=JSON.parse(newerCut.data[mime]);assert(newerPayload.cut);releaseOlder();assert.equal((await olderResponse).status(),200);await ready();await page.unroute('**/api/operations');
  const intentKey=`tinka/${runtime.workspaceId}/${newerPayload.workspaceId}/cut-intent`;assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).nonce,intentKey),newerPayload.cut.nonce,'Old completion preserves a newer cut nonce');assert.equal(await secondPage.locator('.workspace-cut-pending').count(),1);assert.equal(active(await snapshot(),raceSource.boardId).some(p=>p.id===newer.placementIds[0]),true);
  // The server may commit while the browser loses its response. A retry must
  // resolve that one move with the frozen geometry/operation ID and one history entry.
  const recoverySource=await op('createBoard',{title:'Recoverable move'}),recoveryItem=await op('createItem',{boardId:recoverySource.boardId,item:{title:'Recover committed response'}});
  await show(recoverySource.boardId);await select(recoveryItem.placementIds);const recoveryCut=await event('cut');await show(other.boardId);
  const history=async()=>await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'{"undo":[],"redo":[],"seen":[]}'),historyKey);
  const recoveryBefore=await snapshot(),historyBefore=await history(),recoveryStart=writes.length;let committedResponse;
  await page.route('**/api/operations',async route=>{if(route.request().postDataJSON()?.type==='move'){const response=await route.fetch();assert.equal(response.status(),200);committedResponse=await response.json();await route.abort('failed');}else await route.continue();});
  await event('paste',recoveryCut.data);await page.waitForFunction(()=>document.getElementById('workspace-toast')?.textContent.includes('Could not confirm'));await ready();await page.unroute('**/api/operations');
  const recoveryCommitted=await snapshot();assert.equal(recoveryCommitted.revision,recoveryBefore.revision+1);assert.deepEqual(await history(),historyBefore,'Unknown response does not invent a movement history');assert.equal(active(recoveryCommitted,recoverySource.boardId).length,0);assert.equal(active(recoveryCommitted,other.boardId).filter(p=>p.itemId===recoveryItem.itemId).length,1);
  // An uncertain move cannot be sent to a second destination.
  await show(target.boardId);await unchanged(()=>event('paste',recoveryCut.data));await show(other.boardId);
  const retryPending=page.waitForResponse(r=>r.url()===base+'/api/operations'&&r.request().postDataJSON()?.type==='move');await event('paste',recoveryCut.data);const retryResponse=await retryPending,retryData=await retryResponse.json();assert.equal(retryResponse.status(),200);assert.deepEqual(retryData.result,committedResponse.result);await ready();await page.waitForFunction(({key,id})=>JSON.parse(sessionStorage.getItem(key)||'{}').seen?.includes(id),{key:historyKey,id:writes[recoveryStart].data.operationId});
  const {expectedRevision:oldExpected,...frozen}=writes[recoveryStart].data,{expectedRevision:newExpected,...retried}=writes[recoveryStart+1].data;assert.deepEqual(retried,frozen,'Retry retains exact operation ID, source snapshots and destination geometry');assert.equal((await snapshot()).revision,recoveryCommitted.revision);assert.equal((await history()).undo.length,historyBefore.undo.length+1);assert.equal((await history()).seen.filter(id=>id===frozen.operationId).length,1);await unchanged(()=>event('paste',recoveryCut.data));
  // Fresh cuts on the destination can be cancelled without reviving older movement history.
  const currentIds=moved.result.placementIds;
  const localCut=async selected=>{await select(selected);const result=await event('cut');assert(result.prevented);assert(JSON.parse(result.data[mime]).cut);return result;};
  for(const cancellation of ['Escape','Control+z','copy']){await show(target.boardId);const fresh=await localCut(currentIds.slice(0,2)),before=await snapshot(),count=writes.length;if(cancellation==='copy'){const copy=await event('copy');assert.equal(JSON.parse(copy.data[mime]).cut,undefined);}else await page.keyboard.press(cancellation);assert.deepEqual(await snapshot(),before);assert.equal(writes.length,count);await show(other.boardId);await unchanged(()=>event('paste',fresh.data));}
  // A placement change after cut rejects the complete selection, retaining current state.
  await show(target.boardId);let fresh=await localCut(currentIds.slice(0,2));await op('updatePlacement',{boardId:target.boardId,placementId:currentIds[0],patch:{x:placed[0].x+9}});await show(other.boardId);await unchanged(()=>event('paste',fresh.data),{allowRequest:true});
  // A forged nonce cannot turn a copy snapshot into a live move.
  const forged=JSON.parse(fresh.data[mime]);forged.cut.nonce=crypto.randomUUID();await unchanged(()=>event('paste',{[mime]:JSON.stringify(forged)}));
  await show(target.boardId);fresh=await localCut([currentIds[0]]);await op('remove',{boardId:target.boardId,placementIds:[currentIds[0]]});await show(other.boardId);await unchanged(()=>event('paste',fresh.data),{allowRequest:true});
  await show(target.boardId);fresh=await localCut([currentIds[1]]);await op('deleteItem',{itemIds:[children[1].itemId]});await show(other.boardId);await unchanged(()=>event('paste',fresh.data),{allowRequest:true});
  await show(target.boardId);fresh=await localCut([currentIds[2]]);await show(group.boardId);await unchanged(()=>event('paste',fresh.data),{allowRequest:true}); // containment cycle
  // Workspace mismatch is rejected before any request.
  const foreign={...JSON.parse(fresh.data[mime]),workspaceId:'foreign-workspace'};await unchanged(()=>event('paste',{[mime]:JSON.stringify(foreign)}));
  // Editing/search and reader retain native cut, without interpreting Tinka selections.
  await show(other.boardId);await page.locator('#board-info-toggle').click();await page.locator('#workspace-search').focus();let before=await snapshot(),count=writes.length;assert.equal((await event('cut',{},page,'#workspace-search')).prevented,false);assert.equal(writes.length,count);assert.deepEqual(await snapshot(),before);await page.locator('#board-info-toggle').click();await page.evaluate(()=>document.activeElement?.blur());
  await card(aliases.placementIds[0]).locator('.workspace-preview-launch').click();await page.locator('#reader-dialog[open]').waitFor();assert.equal((await event('cut')).prevented,false);assert.equal(writes.length,count);await page.locator('#close-reader').click();await page.locator('#reader-dialog').waitFor({state:'hidden'});
  // Existing copy, exact text, link and image paste remain independent transactions.
  await show(other.boardId);await select(aliases.placementIds);const copied=await event('copy'),copiedPayload=JSON.parse(copied.data[mime]);assert.equal(copiedPayload.cut,undefined);const copyPaste=await commit(()=>event('paste',copied.data),'pastePlacements');assert.notEqual(copyPaste.result.itemIds[0],children[0].itemId);
  const text='A note\nSecond line stays complete.';const textPaste=await commit(()=>event('paste',{'text/plain':text}),'pastePlacements');assert.equal(item(textPaste.after,textPaste.result.itemIds[0]).content.text,text);
  await page.route('**/api/link-preview',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({url:'https://example.org/reading',title:'Reading reference'})}));const link=await commit(()=>event('paste',{'text/plain':'https://example.org/reading'}),'pastePlacements');assert.equal(item(link.after,link.result.itemIds[0]).content.url,'https://example.org/reading');
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=24;c.getContext('2d').fillRect(0,0,32,24);return c.toDataURL('image/png').split(',')[1];});const imagePaste=await commit(()=>event('paste',{},page,undefined,[{name:'Synthetic.png',type:'image/png',base64:png}]),'importFiles');assert.equal(item(imagePaste.after,imagePaste.result.itemIds[0]).content.kind,'image');
  assert.equal(await secondPage.evaluate(()=>window.qaClipboardCalls.length),0);await secondPage.close();
  assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>window.qaClipboardCalls.length),0);
  assert.equal(await readFile(path.join(assets,'portable.html'),'utf8'),html,'Resource bytes unchanged');
  await writeFile(path.join(evidence,'cut-paste-receipt.json'),JSON.stringify({fixture,receipts,deferredCut:true,canonicalLatestReview:true,relativeArrangement:true,exactUndoRedo:true,consumedAfterUndoAndAcrossTabs:true,racingTabsAtMostOnce:true,newerCutPreserved:true,committedResponseLossRetryOnce:true,atomicFailures:true,nativeEditingGuard:true,copyTextLinkImageSmoke:true,syntheticClipboardOnly:true,OSClipboardUntouched:true,errors},null,2)+'\n');
  console.log(JSON.stringify({passed:'Deferred cut/paste acceptance',evidence,fixture,receipts}));
} finally {if(browser)await browser.close();try{await main(['stop','--config',config]);}catch{}}
