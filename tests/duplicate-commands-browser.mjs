// Disposable, headless acceptance for duplication and the small board command set.
// No OS clipboard calls or personal board/config writes are used.
import strict from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {main} from '../cli.mjs';

let assertions=0;
const assert=Object.fromEntries(['ok','equal','notEqual','deepEqual','match'].map(name=>[name,(...args)=>{strict[name](...args);assertions++;}]));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-duplicate-commands-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-duplicate-evidence-'));
await mkdir(evidence,{recursive:true});
const config=path.join(fixture,'local/config.json'),boards=path.join(fixture,'boards');
const errors=[],receipts=[],writes=[];
let browser;
try {
  await main(['init','--config',config,'--boards',boards,'--label','Board command fixture']);
  await main(['workspace','init','--config',config,'--apply']);
  await mkdir(path.join(boards,'assets'),{recursive:true});
  const resource=path.join(boards,'assets','reading.html');
  const sourceHTML='<!doctype html><title>A reading experiment</title><style>body{background:#e9eddf;color:#344733;font:22px Georgia;padding:25px}h1{font-weight:400}</style><h1>A place for reading</h1><p>Shared content stays in its own file.</p><input aria-label="Prototype input"><script>window.qaInstance=crypto.randomUUID()</script>';
  await writeFile(resource,sourceHTML);
  const resourceHash=createHash('sha256').update(sourceHTML).digest('hex');
  await main(['start','--config',config]);
  const local=JSON.parse(await readFile(config,'utf8')),base=`http://127.0.0.1:${local.port}`;
  const cfg=await(await fetch(base+'/api/config')).json();
  const snapshot=async()=>await(await fetch(base+'/api/workspace?covers=0')).json();
  const op=async(type,data)=>{
    const before=await snapshot();
    const response=await fetch(base+'/api/operations',{method:'POST',headers:{'Content-Type':'application/json','x-tinka-workspace':cfg.workspaceId},body:JSON.stringify({type,...data,expectedRevision:before.revision,operationId:crypto.randomUUID()})});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result;
  };
  await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
  const source=await op('createBoard',{title:'Board commands'}),bid=source.boardId;
  const content={kind:'html',resource:{rootId:'assets',path:'reading.html'}};
  const first=await op('createItem',{boardId:bid,item:{title:'Reading one',content,review:{note:'Original one',star:true}},placement:{x:-70,y:-30,width:230,height:280,z:7,presentation:{mode:'panel',viewport:{width:240,height:250},paper:'#edf1e4'}}});
  const second=await op('createItem',{boardId:bid,item:{title:'Reading two',content,review:{note:'Original two',star:false}},placement:{x:230,y:40,width:250,height:260,z:2,presentation:{mode:'panel',viewport:{width:240,height:250},paper:'#f3eadb'}}});
  const alias=await op('reference',{itemIds:[first.itemId],targetBoardId:bid});
  await op('updatePlacement',{boardId:bid,placementId:alias.placementIds[0],patch:{x:550,y:-20,width:180,height:220,z:5,presentation:{mode:'icon',paper:'#edf1e4'}}});
  const group=await op('createBoard',{title:'Collection',parentBoardId:bid});
  await op('updatePlacement',{boardId:bid,placementId:group.placementIds[0],patch:{x:20,y:330,width:260,height:230,z:4}});
  const child=await op('createItem',{boardId:group.boardId,item:{title:'Shared child',content,review:{note:'Child stays shared',star:true}},placement:{x:90,y:110,width:230,height:280,z:6,presentation:{mode:'panel',viewport:{width:240,height:250}}}});
  await op('updateBoard',{boardId:group.boardId,patch:{decorations:[{id:'collection-label',type:'text',text:'Keep this layout',color:'#446633',x:10,y:10,width:180,height:50}],background:{color:'#e2ead9'}}});
  const ids=[first.placementIds[0],second.placementIds[0],alias.placementIds[0],group.placementIds[0]];
  await op('updateBoard',{boardId:bid,patch:{reviewOrder:[ids[1],ids[3],ids[2],ids[0]]}});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'}),page=await context.newPage();
  const historyKey=`tinka/${cfg.workspaceId}/movement-history`,draftKey=`tinka/${cfg.workspaceId}/item-review-drafts`;
  // The durable workspace ID is returned on board snapshots; avoid assuming its API alias.
  const boardSnapshot=await(await fetch(base+`/api/boards/${bid}`)).json();
  const actualCutKey=`tinka/${cfg.workspaceId}/${boardSnapshot.workspaceId}/cut-intent`;
  const drafts=JSON.stringify({[first.itemId]:{note:'Local unsaved note'}});
  await context.addInitScript(({draftKey,drafts})=>{
    if(window.top===window&&!sessionStorage.getItem('qa-draft-seeded')){localStorage.setItem(draftKey,drafts);sessionStorage.setItem('qa-draft-seeded','yes');}
    window.qaClipboardCalls=[];
    const blocked=()=>{window.qaClipboardCalls.push('native clipboard');throw new Error('QA must not access OS clipboard');};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:blocked,readText:blocked,write:blocked,writeText:blocked}});
    const exec=document.execCommand.bind(document);document.execCommand=(name,...args)=>['copy','cut','paste'].includes(name)?blocked():exec(name,...args);
    window.qaClipboardEvents=[];for(const name of ['copy','cut','paste'])document.addEventListener(name,()=>window.qaClipboardEvents.push(name),true);
    window.qaLoads=new WeakMap();document.addEventListener('load',e=>{if(e.target.tagName==='IFRAME')window.qaLoads.set(e.target,(window.qaLoads.get(e.target)||0)+1);},true);
  },{draftKey,drafts});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))writes.push({url:r.url(),method:r.method(),data:r.postDataJSON()});});
  const card=id=>page.locator(`[data-placement="${id}"]`),board=(state,id=bid)=>state.boards.find(b=>b.id===id);
  const arrangement=(state,id=bid)=>({placements:board(state,id).placements,reviewOrder:board(state,id).reviewOrder});
  const history=async()=>await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'{"undo":[],"redo":[]}'),historyKey);
  const selected=async()=>await page.locator('.workspace-card.selected').evaluateAll(nodes=>nodes.map(n=>n.dataset.placement).sort());
  const settle=async()=>{await page.waitForFunction(()=>!document.getElementById('workspace-paste')?.disabled);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  const show=async()=>{const graph=page.waitForResponse(r=>r.url()===base+'/api/workspace?covers=0'&&r.ok());await page.goto(base+`/boards/${bid}/`);await page.locator('#workspace-copy').waitFor({state:'attached'});await graph;await page.locator('#fit').click();await settle();};
  const select=async wanted=>{
    // Clones deliberately overlap: activate their native selection controls by
    // keyboard so pointer occlusion is not confused with command correctness.
    for(const id of await selected()){await card(id).locator('[data-placement-select]').focus();await page.keyboard.press('Space');}
    for(const id of wanted){await card(id).locator('[data-placement-select]').focus();await page.keyboard.press('Space');}
    await page.locator('#viewport').focus();assert.deepEqual(await selected(),[...wanted].sort());
  };
  const clipboard=async type=>await page.evaluate(type=>{const transfer=new DataTransfer();const e=new ClipboardEvent(type,{clipboardData:transfer,bubbles:true,cancelable:true});document.body.dispatchEvent(e);const buffer=Object.fromEntries([...transfer.types].map(t=>[t,transfer.getData(t)]));window.qaBuffer=buffer;return {prevented:e.defaultPrevented,buffer};},type);
  const mutation=async(action,type='pastePlacements')=>{
    const before=await snapshot(),start=writes.length,responsePromise=page.waitForResponse(r=>r.url()===base+'/api/operations'&&r.request().postDataJSON()?.type===type);
    await action();const response=await responsePromise,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));assert.ok(body.history);
    await settle();const after=await snapshot();assert.equal(after.revision,before.revision+1);assert.deepEqual(writes.slice(start).map(r=>r.data.type),[type]);
    receipts.push({type,revisionBefore:before.revision,revisionAfter:after.revision,result:body.result,history:body.history});
    return {before,after,body,operation:writes[start].data};
  };
  const replay=async redo=>{await page.locator('#viewport').focus();return mutation(()=>page.keyboard.press(redo?'Meta+Shift+z':'Meta+z'),'restoreMovement');};
  const zero=async(action,check)=>{const before=await snapshot(),start=writes.length;await action();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await check?.();assert.equal(writes.length,start,'UI command must not write');assert.equal((await snapshot()).revision,before.revision);};
  await show();
  for(const id of ids.slice(0,2)){await card(id).locator('iframe').contentFrame().locator('.item-full-frame').contentFrame().getByRole('heading').waitFor();}
  await page.waitForFunction(ids=>ids.every(id=>window.qaLoads.get(document.querySelector(`[data-placement="${id}"] iframe`))>0),ids.slice(0,2));
  await page.locator('.workspace-card iframe').evaluateAll(frames=>{window.qaOriginalFrames=frames.map(frame=>{const entry={frame,loads:0};frame.addEventListener('load',()=>entry.loads++);return entry;});});
  await select(ids);
  await zero(async()=>{
    const prevented=await page.evaluate(()=>{const e=new KeyboardEvent('keydown',{key:'d',metaKey:true,repeat:true,bubbles:true,cancelable:true});document.getElementById('viewport').dispatchEvent(e);return e.defaultPrevented;});
    assert.equal(prevented,true,'A repeated board-owned duplicate must suppress the browser bookmark default');
  });
  const copied=await clipboard('copy');assert.equal(copied.prevented,true);const payload=JSON.parse(copied.buffer['application/x-tinka-placements+json']);
  assert.equal(payload.items[first.itemId].review.note,'Local unsaved note');
  const clipboardEvents=await page.evaluate(()=>window.qaClipboardEvents.length);
  const duplicated=await mutation(()=>page.keyboard.press('Meta+d'));
  const fresh=duplicated.body.result.placementIds,newPlacements=fresh.map(id=>board(duplicated.after).placements.find(p=>p.id===id));
  assert.equal(newPlacements.length,ids.length);assert.deepEqual(await selected(),[...fresh].sort());
  for(let i=0;i<newPlacements.length;i++){
    const p=newPlacements[i],old=payload.placements[i],item=duplicated.after.items.find(item=>item.id===p.itemId);
    assert.notEqual(p.id,old.id);assert.notEqual(p.itemId,old.itemId);assert.equal(p.x,old.x+32);assert.equal(p.y,old.y+32);
    assert.equal(p.width,old.width);assert.equal(p.height,old.height);assert.equal(p.z-newPlacements[0].z,old.z-payload.placements[0].z);assert.deepEqual(p.presentation,old.presentation);
    for(const key of ['title','description','content','review','resources','revisions','build'])assert.deepEqual(item[key],payload.items[old.itemId][key]);
  }
  assert.equal(duplicated.body.result.itemIds[0],duplicated.body.result.itemIds[2],'Aliases share one fresh canonical identity');
  const order=payload.reviewOrder.map(id=>fresh[payload.placements.findIndex(p=>p.id===id)]);assert.deepEqual(board(duplicated.after).reviewOrder.slice(-order.length),order);
  for(const item of duplicated.before.items)assert.deepEqual(duplicated.after.items.find(i=>i.id===item.id),item);
  for(const id of ids)assert.deepEqual(board(duplicated.after).placements.find(p=>p.id===id),board(duplicated.before).placements.find(p=>p.id===id));
  const oldGroup=board(duplicated.before,group.boardId),groupCopyItem=duplicated.after.items.find(i=>i.id===newPlacements[3].itemId),groupCopy=board(duplicated.after,groupCopyItem.childBoardId);
  assert.notEqual(groupCopy.id,oldGroup.id);assert.deepEqual(groupCopy.decorations,oldGroup.decorations);assert.deepEqual(groupCopy.background,oldGroup.background);assert.deepEqual(groupCopy.rounds,oldGroup.rounds);
  assert.equal(groupCopy.placements[0].itemId,child.itemId);assert.deepEqual(duplicated.after.items.find(i=>i.id===child.itemId),duplicated.before.items.find(i=>i.id===child.itemId));assert.equal(duplicated.after.homeBoardIds.includes(groupCopy.id),false);
  assert.equal(await page.evaluate(()=>window.qaOriginalFrames.every(p=>p.frame.isConnected&&p.loads===0)),true,'Original preview nodes survive duplication');
  assert.deepEqual(await page.evaluate(()=>window.qaBuffer),copied.buffer);assert.equal(await page.evaluate(()=>window.qaClipboardEvents.length),clipboardEvents);assert.equal(await page.evaluate(key=>localStorage.getItem(key),draftKey),drafts);
  assert.equal((await history()).undo.at(-1).label,'Duplicate 4 items');
  for(const id of fresh.slice(0,2))await card(id).locator('iframe').contentFrame().locator('.item-full-frame').contentFrame().getByRole('heading').waitFor();
  await page.waitForFunction(ids=>ids.every(id=>window.qaLoads.get(document.querySelector(`[data-placement="${id}"] iframe`))>0),fresh.slice(0,2));
  const liveCount=board(duplicated.after).placements.filter(p=>!p.removedAt&&!p.deletedAt&&!p.archivedAt).length;
  await page.waitForFunction(count=>document.getElementById('live-status')?.textContent===`Live · ${count} items`,liveCount);
  await page.screenshot({path:path.join(evidence,'duplicate-arrangement-1440.png')});
  await replay(false);assert.deepEqual(arrangement(await snapshot()),arrangement(duplicated.before));
  await replay(true);assert.deepEqual(arrangement(await snapshot()),arrangement(duplicated.after));assert.equal(await page.evaluate(()=>window.qaOriginalFrames.every(p=>p.frame.isConnected&&p.loads===0)),true);
  console.log(JSON.stringify({stage:'batch arrangement, aliases, shallow boards, exact history, drafts and original previews',assertions}));
  await op('review',{itemId:newPlacements[0].itemId,patch:{note:'Independent duplicate feedback',star:false}});
  assert.equal((await snapshot()).items.find(i=>i.id===first.itemId).review.note,'Original one');
  // Refresh clears the externally advanced revision while retaining the existing tab history.
  await show();await select([ids[0]]);
  const cut=await clipboard('cut');assert.equal(cut.prevented,true);assert.ok(await page.evaluate(key=>localStorage.getItem(key),actualCutKey));
  const cutCopy=JSON.stringify(cut.buffer);const cutDuplicate=await mutation(()=>page.keyboard.press('Control+d'));
  assert.equal((await history()).undo.at(-1).label,'Duplicate item');
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),actualCutKey),null);assert.equal(JSON.stringify(await page.evaluate(()=>window.qaBuffer)),cutCopy);
  await replay(false);assert.deepEqual(arrangement(await snapshot()),arrangement(cutDuplicate.before),'First undo reverses duplicate rather than pending cut');
  // A denied transaction keeps the pending cut, selection and exact history.
  await select([ids[1]]);await clipboard('cut');const deniedCut=await page.evaluate(key=>localStorage.getItem(key),actualCutKey),deniedHistory=await history(),deniedState=await snapshot(),deniedSelected=await selected();
  await page.route('**/api/operations',route=>route.request().postDataJSON()?.type==='pastePlacements'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'QA concurrent edit'})}):route.continue());
  const deniedResponse=page.waitForResponse(r=>r.url()===base+'/api/operations'&&r.request().postDataJSON()?.type==='pastePlacements');await page.keyboard.press('Meta+d');assert.equal((await deniedResponse).status(),409);await settle();await page.unroute('**/api/operations');
  assert.deepEqual(await history(),deniedHistory);assert.deepEqual(await selected(),deniedSelected);assert.equal(await page.evaluate(key=>localStorage.getItem(key),actualCutKey),deniedCut);assert.deepEqual(await snapshot(),deniedState);
  // While a duplicate is in flight, a different tab can establish a newer cut.
  const other=await context.newPage();await other.goto(base+`/boards/${bid}/`);await other.locator('#workspace-copy').waitFor({state:'attached'});
  let release,arrived;const arrival=new Promise(resolve=>{arrived=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/operations',async route=>{if(route.request().postDataJSON()?.type==='pastePlacements'){arrived();await barrier;}await route.continue();});
  const racePromise=mutation(()=>page.keyboard.press('Meta+d'));await arrival;
  assert.equal(await page.evaluate(()=>{const e=new KeyboardEvent('keydown',{key:'d',metaKey:true,bubbles:true,cancelable:true});document.getElementById('viewport').dispatchEvent(e);return e.defaultPrevented;}),true,'Busy duplicate owns the browser shortcut without another transaction');
  await other.locator(`[data-placement="${ids[0]}"] [data-placement-select]`).click();
  await other.evaluate(()=>{document.activeElement?.blur();const e=new ClipboardEvent('cut',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true});document.body.dispatchEvent(e);});
  const newerCut=await other.evaluate(key=>localStorage.getItem(key),actualCutKey);assert.notEqual(newerCut,deniedCut);release();await racePromise;await page.unroute('**/api/operations');assert.equal(await page.evaluate(key=>localStorage.getItem(key),actualCutKey),newerCut);await other.close();
  await page.keyboard.press('Escape');await select([ids[0]]);
  // A genuine repeated keydown causes one duplicate only.
  const repeated=await mutation(async()=>{await page.keyboard.down('Meta');await page.keyboard.down('d');await page.keyboard.down('d');await page.keyboard.up('d');await page.keyboard.up('Meta');});assert.equal(repeated.body.result.placementIds.length,1);
  console.log(JSON.stringify({stage:'cut success, denial, cross-tab cut race, repeat and busy defaults',assertions}));
  // The five new affordances make zero graph writes.
  await zero(()=>page.keyboard.press('/'),async()=>{assert.equal(await page.locator('#workspace-search').evaluate(el=>el===document.activeElement),true);assert.equal(await page.locator('#board-info').isVisible(),true);});
  await page.locator('#workspace-search').fill('Reading two');await page.keyboard.press('Escape');await page.locator('#viewport').focus();
  const rendered=await page.locator('.workspace-card').evaluateAll(cards=>cards.map(c=>c.dataset.placement).sort());assert.ok(rendered.length>0);assert.ok(rendered.length<board(await snapshot()).placements.length);
  await zero(()=>page.keyboard.press('Meta+a'),async()=>assert.deepEqual(await selected(),rendered));
  await page.keyboard.press('/');await page.locator('#workspace-search').fill('Nothing matches this search');await page.locator('#board-info-toggle').click();await page.locator('#viewport').focus();
  await zero(()=>page.keyboard.press('Meta+a'),async()=>{assert.deepEqual(await selected(),[]);assert.equal(await page.evaluate(()=>String(window.getSelection())), '');});
  await page.keyboard.press('/');await page.locator('#workspace-search').fill('Reading two');await page.keyboard.press('Escape');await page.locator('#viewport').focus();await page.keyboard.press('Meta+a');
  await zero(()=>page.keyboard.press('Enter'),async()=>assert.equal(await page.locator('#reader-dialog').isVisible(),false));
  await select([ids[1]]);await zero(()=>page.keyboard.press('Enter'),async()=>{await page.locator('#reader-dialog[open]').waitFor();assert.equal(await page.locator('#reader-name').textContent(),'Reading two');});
  // The active prototype owns its keys, including the text-editing case.
  const input=page.locator('#active-reader').contentFrame().locator('.item-full-frame').contentFrame().getByRole('textbox',{name:'Prototype input'});
  await input.focus();await zero(async()=>{for(const key of ['Meta+d','Meta+a','/','Shift+1','?'])await page.keyboard.press(key);},async()=>assert.equal(await page.locator('dialog.workspace-dialog[open]').count(),0));
  await page.locator('#close-reader').click();await page.locator('#viewport').focus();await page.keyboard.press('/');await page.locator('#workspace-search').fill('');await page.keyboard.press('Escape');await page.locator('#viewport').focus();
  await page.locator('#zoom-slider').evaluate(el=>{el.value='5';el.dispatchEvent(new Event('input',{bubbles:true}));});const zoomBefore=await page.locator('#zoom-slider').inputValue();
  await zero(()=>page.keyboard.press('Shift+1'),async()=>assert.notEqual(await page.locator('#zoom-slider').inputValue(),zoomBefore));
  await zero(()=>page.keyboard.press('?'),async()=>{await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor();assert.match(await page.getByRole('dialog',{name:'Keyboard shortcuts'}).textContent(),/Duplicate/);});
  await page.screenshot({path:path.join(evidence,'keyboard-shortcuts-1440.png')});await page.keyboard.press('Escape');assert.equal(await page.locator('#viewport').evaluate(el=>document.activeElement===el),true);
  await page.locator('#board-info-toggle').click();await zero(()=>page.getByRole('button',{name:'Keyboard shortcuts',exact:true}).click(),async()=>page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor());await page.keyboard.press('Escape');assert.equal(await page.locator('#board-info-toggle').evaluate(el=>document.activeElement===el),true);
  // Native editing, dialog, composing and modifier ownership. Ordinary menus
  // retain normal accelerator behavior when their focus is not an editor.
  await page.keyboard.press('/');await page.locator('#workspace-search').fill('native text');
  await zero(async()=>{await page.keyboard.press('Meta+a');assert.equal(await page.locator('#workspace-search').evaluate(el=>el.selectionEnd-el.selectionStart),11);for(const key of ['Meta+d','?','/','Shift+1'])await page.keyboard.press(key);});
  await page.locator('#workspace-search').fill('');await page.keyboard.press('Escape');await page.locator('#viewport').focus();await select([ids[0]]);
  await page.evaluate(()=>{const input=document.createElement('div');input.id='qa-editable';input.contentEditable='true';input.textContent='Native editable';document.body.append(input);input.focus();});
  await zero(async()=>{for(const key of ['Meta+d','Meta+a','/','Shift+1','?'])await page.keyboard.press(key);},async()=>assert.equal(await page.locator('dialog.workspace-dialog[open]').count(),0));await page.locator('#qa-editable').evaluate(el=>el.remove());
  await page.locator('#viewport').focus();await page.keyboard.press('?');await zero(()=>page.keyboard.press('Meta+d'));await page.keyboard.press('Escape');
  await page.locator('#board-info-toggle').click();await page.locator('#workspace-add').click();const menuDuplicate=await mutation(()=>page.keyboard.press('Meta+d'));await page.keyboard.press('Escape');await page.locator('#viewport').focus();await replay(false);assert.deepEqual(arrangement(await snapshot()),arrangement(menuDuplicate.before));
  await zero(async()=>{await page.keyboard.press('Meta+Alt+d');await page.evaluate(()=>document.getElementById('viewport').dispatchEvent(new KeyboardEvent('keydown',{key:'d',metaKey:true,isComposing:true,bubbles:true,cancelable:true})));});
  // Native selection controls retain Enter instead of opening a different card.
  await card(ids[1]).locator('[data-placement-select]').focus();await zero(()=>page.keyboard.press('Enter'),async()=>{assert.ok((await selected()).includes(ids[1]));assert.equal(await page.locator('#reader-dialog').isVisible(),false);});
  // Representative narrow Canvas and Grid access use the same commands.
  await page.setViewportSize({width:390,height:844});await page.locator('#viewport').focus();await page.keyboard.press('Shift+1');await page.screenshot({path:path.join(evidence,'duplicate-arrangement-390.png')});await page.keyboard.press('?');await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor();await page.screenshot({path:path.join(evidence,'keyboard-shortcuts-390.png')});await page.keyboard.press('Escape');
  await page.locator('#board-info-toggle').click();await page.locator('[data-mode="grid"]').click();await page.locator('#board-info-toggle').click();await page.locator('#viewport').focus();await zero(()=>page.keyboard.press('Control+a'),async()=>assert.equal((await selected()).length,await page.locator('.workspace-card').count()));
  assert.equal(await page.evaluate(()=>window.qaClipboardCalls.length),0);assert.equal(createHash('sha256').update(await readFile(resource)).digest('hex'),resourceHash);assert.equal(errors.length,0,errors.join('\n'));
  const sourceHashes={};for(const file of ['public/workspace-board.js','public/movement-history.js','public/canvas.js','public/board-commands.js']){try{sourceHashes[file]=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex');}catch{}}
  const coverage={batchGeometry:true,relativeStacking:true,reviewOrder:true,freshIDs:true,aliasIdentity:true,independentCanonicalFeedback:true,shallowBoardCopy:true,originalsAndResourceUnchanged:true,oneStepExactUndoRedo:true,stableOriginalPreviewNodes:true,localReviewDrafts:true,capturedCutCanceledOnSuccess:true,newerCrossTabCutPreserved:true,rejectionPreservesSelectionCutHistory:true,repeatAndBusyDefaultPrevented:true,clipboardBufferUntouched:true,filteredAndEmptySelectAll:true,enterSoleAndMultiple:true,searchFocus:true,fitBoard:true,guideToolsQuestionFocusReturn:true,nativeEditingReaderDialogCompositionGuards:true,ordinaryMenuAccelerator:true,narrowAndGrid:true};
  const result={passed:true,assertions,fixture,evidence,coverage,receipts,sourceHashes,errors,syntheticClipboardOnly:true,osClipboardCalls:0,originalResourceSHA256:resourceHash};
  await rm(path.join(evidence,'failure.txt'),{force:true});await writeFile(path.join(evidence,'duplicate-commands-receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await context.close();
} catch(error) {
  await writeFile(path.join(evidence,'failure.txt'),error.stack||String(error));throw error;
} finally {
  if(browser)await browser.close();
  try{await main(['stop','--config',config]);}catch{}
}
