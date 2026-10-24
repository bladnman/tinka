// Focused headless acceptance; fixtures/evidence remain outside source/app data.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-feedback-ui-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-feedback-ui-evidence-'));
await mkdir(evidence,{recursive:true});
let server,browser;
try{
 const configFile=path.join(fixture,'local/config.json');
 await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Feedback fixture']);
 const config=await loadConfig(configFile);
 const board=(await applyOperation(config,{type:'createBoard',title:'Product choices'})).result;
 const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Simple routing',content:{kind:'note',text:'Add readable connector labels.'}},placement:{x:0,y:0,width:320,height:240}})).result;
 server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`${url}/boards/${board.boardId}/`);
 await page.locator('[data-item-feedback]').waitFor();
 await page.locator('[data-item-feedback]').click();
 await page.locator('[data-feedback-vote=yes]').click();
 await page.waitForFunction(()=>document.querySelector('[data-feedback-vote=yes]')?.getAttribute('aria-pressed')==='true');
 assert.equal(await page.locator('[data-feedback-vote=yes] span').textContent(),'1');
 await page.locator('[data-feedback-vote=no]').click();
 await page.waitForFunction(()=>document.querySelector('[data-feedback-vote=no]')?.getAttribute('aria-pressed')==='true');
 assert.equal(await page.locator('[data-feedback-vote=yes] span').textContent(),'0');
 await page.locator('[data-feedback-add]').click();
 await page.locator('dialog.workspace-dialog textarea').fill('Please make the arrows easier to read.');await page.locator('dialog.workspace-dialog button[type=submit]').click();
 await page.locator('.feedback-thread').waitFor();assert.match(await page.locator('.feedback-thread').textContent(),/arrows easier to read/);
 await page.locator('[data-feedback-reply]').click();await page.locator('dialog.workspace-dialog textarea').fill('Keep the simplest approach.');await page.locator('dialog.workspace-dialog button[type=submit]').click();
 await page.locator('.feedback-reply').waitFor();
 await page.locator('[data-feedback-resolve]').click();await page.waitForFunction(()=>document.querySelector('.feedback-thread')?.classList.contains('resolved'));
 await page.locator('[data-feedback-unresolved]').check();await page.locator('.feedback-thread').waitFor({state:'detached'});
 await page.locator('[data-feedback-unresolved]').uncheck();await page.locator('[data-feedback-resolve]').click();await page.waitForFunction(()=>!document.querySelector('.feedback-thread')?.classList.contains('resolved'));
 await page.locator('[data-feedback-point]').click();
 const box=await page.locator('#viewport').boundingBox();await page.mouse.click(box.x+420,box.y+150);
 await page.locator('dialog.workspace-dialog textarea').fill('Leave more space here.');await page.locator('dialog.workspace-dialog button[type=submit]').click();await page.locator('.feedback-pin').waitFor();
 await page.locator('[data-feedback-pins]').uncheck();assert.equal(await page.locator('.feedback-pins').isVisible(),false);
 await page.locator('[data-feedback-pins]').check();
 await page.locator('[data-feedback-add]').click();await page.locator('dialog.workspace-dialog textarea').fill('Board-wide decision: keep this release focused.');await page.locator('dialog.workspace-dialog button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.feedback-thread').length===3);
 await page.screenshot({path:path.join(evidence,'feedback-wide.png')});
 await page.reload();await page.locator('.feedback-pin').waitFor();await page.locator('[data-item-feedback]').click();
 assert.equal(await page.locator('[data-feedback-vote=no]').getAttribute('aria-pressed'),'true');
 await page.locator('[data-feedback-vote=clear]').click();await page.waitForFunction(()=>document.querySelector('[data-feedback-vote=clear]')?.disabled);
 await page.locator('[data-feedback-close]').click();await page.locator('.feedback-pin').waitFor({state:'visible'});
 await page.locator('[data-item-feedback]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.feedback-thread').length===1);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'feedback-narrow.png')});
 const bounds=await page.locator('.feedback-panel').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391);
 await page.locator('[data-feedback-point]').click();
 assert.equal(await page.locator('.feedback-panel').isVisible(),false,'390px point picking exposes the canvas');
 const narrowCanvas=await page.locator('#viewport').boundingBox();await page.mouse.click(narrowCanvas.x+Math.min(180,narrowCanvas.width-20),narrowCanvas.y+Math.min(180,narrowCanvas.height-20));
 await page.locator('dialog.workspace-dialog textarea').fill('Narrow screen point survives.');await page.locator('dialog.workspace-dialog button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('.feedback-list')?.textContent.includes('Narrow screen point survives.')&&document.querySelectorAll('.feedback-pin').length>=1);
 await page.screenshot({path:path.join(evidence,'feedback-narrow-point.png')});
 const response=await fetch(`${url}/api/feedback?boardId=${board.boardId}&includeBodies=true`),saved=await response.json();assert.equal(saved.threads.length,4);assert.equal(saved.threads[0].replies.length,1);
 assert.ok(saved.threads.some(thread=>thread.body==='Narrow screen point survives.'&&thread.anchor?.kind==='point'));
 assert.equal(saved.threads.some(t=>t.anchor?.kind==='point'),true);
 const cli=JSON.parse(await main(['tools','call','feedback.list','--config',configFile,'--json',JSON.stringify({boardId:board.boardId,includeBodies:true})]));
 assert.deepEqual(cli,saved);
 const cliItem=JSON.parse(await main(['tools','call','item.get','--config',configFile,'--json',JSON.stringify({itemId:item.itemId})]));
 assert.deepEqual(cliItem.review.votes,{});
 // Actual target picking uses normalized target coordinates, with the same
 // resolved point visible to the browser and an independent CLI read.
 await page.setViewportSize({width:1440,height:960});
 await applyOperation(config,{type:'createDecoration',boardId:board.boardId,decoration:{id:'feedback-shape',type:'region',x:400,y:20,width:240,height:160,text:'Discuss this decision',color:'#eee0a8'}});
 await page.reload();await page.locator('[data-item-feedback]').first().waitFor();
 const current=JSON.parse(await main(['tools','call','board.get','--config',configFile,'--json',JSON.stringify({boardId:board.boardId})]));
 const placement=current.placements.find(p=>p.itemId===item.itemId),card=page.locator(`[data-placement="${placement.id}"]`),shape=page.locator('[data-decoration="feedback-shape"]');
 async function addTargetPoint(target,body){
   await page.locator('[data-item-feedback]').first().click();await page.locator('.feedback-scope button').click();await page.locator('[data-feedback-point]').click();
   const rect=await target.boundingBox();await page.mouse.click(rect.x+rect.width*.25,rect.y+rect.height*.5);
   await page.locator('dialog.workspace-dialog textarea').fill(body);await page.locator('dialog.workspace-dialog button[type=submit]').click();
   await page.waitForFunction(text=>document.querySelector('.feedback-list')?.textContent.includes(text),body);
   const feedback=JSON.parse(await main(['tools','call','feedback.list','--config',configFile,'--json',JSON.stringify({boardId:board.boardId,includeBodies:true})]));
   const thread=feedback.threads.find(t=>t.body===body);assert.ok(thread.anchor.relative);assert.ok(Math.abs(thread.anchor.relative.x-.25)<.01);assert.ok(Math.abs(thread.anchor.relative.y-.5)<.01);
   await page.locator('[data-feedback-close]').click();return thread;
 }
 const attached=await addTargetPoint(card,'Follow this card.'),decorated=await addTargetPoint(shape,'Follow this shape.');
 assert.equal(attached.anchor.placementId,placement.id);assert.equal(decorated.anchor.decorationId,'feedback-shape');
 async function assertPinTracks(thread,target){
   await page.waitForFunction(({id,targetId,decoration,relative})=>{const pin=document.querySelector(`[data-feedback-pin="${id}"]`),target=document.querySelector(`[${decoration?'data-decoration':'data-placement'}="${targetId}"]`);return pin&&target&&Math.abs(parseFloat(pin.style.left)-parseFloat(target.style.left)-relative.x*parseFloat(target.style.width))<1&&Math.abs(parseFloat(pin.style.top)-parseFloat(target.style.top)-relative.y*parseFloat(target.style.height))<1;},{id:thread.id,targetId:thread.anchor.placementId||thread.anchor.decorationId,decoration:!!thread.anchor.decorationId,relative:thread.anchor.relative});
 }
 await applyOperation(config,{type:'updatePlacement',boardId:board.boardId,placementId:placement.id,patch:{x:50,y:80,width:400,height:300}});
 await applyOperation(config,{type:'updateDecoration',boardId:board.boardId,decorationId:'feedback-shape',patch:{x:550,y:40,width:320,height:240}});
 await page.reload();await page.locator(`[data-feedback-pin="${attached.id}"]`).waitFor();await assertPinTracks(attached,card);await assertPinTracks(decorated,shape);
 // During a real gesture the pin follows the temporary geometry before save.
 const dragBox=await card.boundingBox();await page.mouse.move(dragBox.x+dragBox.width*.75,dragBox.y+30);await page.mouse.down();await page.mouse.move(dragBox.x+dragBox.width*.75+70,dragBox.y+80,{steps:4});assert.ok(Math.abs((await card.boundingBox()).x-dragBox.x)>20);await assertPinTracks(attached,card);const moveSaved=page.waitForResponse(response=>response.url().endsWith('/api/operations')&&response.request().method()==='POST'),moveView=page.waitForResponse(response=>response.url().includes('/api/feedback?'));await page.mouse.up();await moveSaved;await (await moveView).finished();await page.evaluate(()=>new Promise(requestAnimationFrame));
 const resize=await card.locator('[data-resize]').boundingBox();await page.mouse.move(resize.x+resize.width/2,resize.y+resize.height/2);await page.mouse.down();const widthBeforeResize=await card.evaluate(el=>parseFloat(el.style.width));await page.mouse.move(resize.x+resize.width/2+60,resize.y+resize.height/2+40,{steps:4});assert.ok(await card.evaluate((el,before)=>parseFloat(el.style.width)>before+20,widthBeforeResize));await assertPinTracks(attached,card);const resizeSaved=page.waitForResponse(response=>response.url().endsWith('/api/operations')&&response.request().method()==='POST');await page.mouse.up();await resizeSaved;
 await page.screenshot({path:path.join(evidence,'feedback-relative-wide.png')});
 await applyOperation(config,{type:'removeDecoration',boardId:board.boardId,decorationId:'feedback-shape'});
 await page.reload();const detachedPin=page.locator(`[data-feedback-pin="${decorated.id}"]`);await detachedPin.waitFor();assert.match(await detachedPin.getAttribute('aria-label'),/target unavailable; original point/);assert.equal(await detachedPin.evaluate(el=>el.classList.contains('detached')),true);
 const detached=JSON.parse(await main(['tools','call','feedback.list','--config',configFile,'--json',JSON.stringify({threadId:decorated.id})])).threads[0];assert.deepEqual(detached.anchorPoint,{x:decorated.anchor.x,y:decorated.anchor.y,detached:true,fallback:true});
 // Compact graph loading must retain complete immediate child layouts for Copy.
 const child=(await applyOperation(config,{type:'createBoard',title:'Child layout',parentBoardId:board.boardId})).result;
 await applyOperation(config,{type:'updateBoard',boardId:child.boardId,patch:{decorations:[{id:'copy-note',type:'text',x:5,y:7,width:180,height:70,text:'Retain this decoration',color:'#778866'}]}});
 await page.reload();await page.locator('[data-item-feedback]').first().waitFor();
 const childCard=page.locator('.workspace-card').filter({has:page.locator(`[data-item-feedback="${child.itemId}"]`)});
 await childCard.locator('[data-placement-select]').click();
 let copied;
 for(let attempt=0;attempt<20;attempt++){
   copied=await page.evaluate(()=>{const data=new DataTransfer();document.body.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));const value=data.getData('application/x-tinka-placements+json');return value?JSON.parse(value):null;});
   if(copied)break;await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(copied);assert.equal(copied.boards[child.boardId].decorations[0].text,'Retain this decoration');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,threads:saved.threads.length+2,checks:'vote replace/clear, comment/reply, resolve/reopen/filter, point, hide/show, reload persistence, 1440/390 layout, target point picking, target move/resize preview, detached fallback, HTTP/CLI read parity, child layout copy',evidence}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true});}
