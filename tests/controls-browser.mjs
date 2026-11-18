// Integration checks for existing notes and saved-small-card fallback controls.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-controls-'));let server,browser;
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Control fixture']);const config=await loadConfig(file),board=(await applyOperation(config,{type:'createBoard',title:'Small saved work'})).result;
 const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Small note',content:{kind:'note',text:'A real note remains readable.'}},placement:{x:0,y:0,width:130,height:130}})).result;
 await applyOperation(config,{type:'review',itemId:item.itemId,patch:{note:'Existing note'}});
 server=await listen(config,{port:0});browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/boards/${board.boardId}/`);await page.locator('[data-item-controls]').waitFor({state:'attached'});
 const tile=page.locator('.workspace-card[data-placement]').first();
 const snap=()=>getBoardSnapshot(config,board.boardId),savedNote=async()=>(await snap()).items[item.itemId].review.note;
 // A small saved card hides its tile toolbar; selection keeps every action reachable.
 await tile.locator('[data-placement-select]').click();await page.getByRole('button',{name:'Item details',exact:true}).click();
 for(const selector of ['select','star','comments','vote','connect'])assert.equal(await page.locator(`[data-context-${selector}]`).isVisible(),true);
 assert.equal(await page.locator('[data-context-geometry]').count(),0);
 const note=page.locator('#workspace-item-controls textarea');await note.fill('');const clearAck=page.waitForResponse(r=>r.url().endsWith('/api/operations')&&r.request().postDataJSON()?.type==='review'&&r.status()===200);await page.keyboard.press('Meta+Enter');await(await clearAck).json();await page.waitForFunction(async({boardId,itemId})=>(await(await fetch(`/api/boards/${boardId}`)).json()).items[itemId].review.note==='', {boardId:board.boardId,itemId:item.itemId});assert.equal(await savedNote(),'');
 await note.fill('First');await page.keyboard.press('Enter');await page.keyboard.type('Second');assert.equal(await note.inputValue(),'First\nSecond');const multilineAck=page.waitForResponse(r=>r.url().endsWith('/api/operations')&&r.request().postDataJSON()?.type==='review'&&r.status()===200);await page.keyboard.press('Control+Enter');await(await multilineAck).json();await page.waitForFunction(async({boardId,itemId})=>(await(await fetch(`/api/boards/${boardId}`)).json()).items[itemId].review.note==='First\nSecond', {boardId:board.boardId,itemId:item.itemId});
 await page.locator('[data-context-close]').click();
 const edge=tile.locator('[data-resize-edge=w]'),r=await edge.boundingBox(),x=r.x+r.width/2,y=r.y+r.height/2;
 assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.dataset.resizeEdge,{x,y}),'w');
 const zoom=await tile.evaluate(el=>parseFloat(getComputedStyle(el).getPropertyValue('--canvas-zoom')));
 const resizeAck=()=>page.waitForResponse(r=>r.url().endsWith('/api/operations')&&r.request().postDataJSON()?.type==='updatePlacement'&&r.status()===200);
 const resized=resizeAck(), modifier=process.platform==='darwin'?'Meta':'Control';
 await page.mouse.move(x,y);await page.mouse.down();await page.keyboard.down(modifier);await page.mouse.move(x-20*zoom,y,{steps:5});await page.mouse.up();await page.keyboard.up(modifier);await resized;
 const placed=() => snap().then(board=>board.placements.find(p=>p.itemId===item.itemId));
 assert.deepEqual([(await placed()).x,(await placed()).width,(await placed()).height],[-20,150,130]);
 await page.waitForFunction(()=>!document.getElementById('workspace-paste')?.disabled);
 const keyed=resizeAck();await tile.locator('[data-resize]').press('Shift+ArrowDown');await keyed;
 assert.equal((await placed()).height,140);
 assert.equal(await page.locator('dialog.workspace-dialog[open]').count(),0);
 // Save rejection leaves the local draft and does not open a modal over the next control.
 await page.route('**/api/operations',async route=>{const body=route.request().postDataJSON();if(body.type==='review')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture offline"}'});return route.continue();});
 await page.getByRole('button',{name:'Item details',exact:true}).click();await page.locator('#workspace-item-controls textarea').fill('Recover this draft');await page.keyboard.press('Meta+Enter');await page.locator('#workspace-toast').filter({hasText:'remain'}).waitFor();await page.locator('#workspace-item-controls [data-context-select]').focus();assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-context-select')),true);assert.equal(await page.locator('dialog.workspace-dialog').count(),0);assert.equal(await page.locator('#workspace-item-controls textarea').inputValue(),'Recover this draft');assert.equal(await savedNote(),'First\nSecond');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:5,checks:['small-card actions in viewport','valid-empty canonical note clear','multiline explicit note flush','direct edge and keyboard resize','failed note retains draft and focus without modal']}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
