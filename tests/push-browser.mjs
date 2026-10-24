// Headless focused push evidence. No real project/browser/clipboard is used.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';
const run=promisify(execFile),{chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-push-browser-')),configPath=path.join(root,'config.json'),boards=path.join(root,'boards');
let browser,server;
try{
 await main(['init','--config',configPath,'--boards',boards,'--label','Push browser']);
 const op=async x=>JSON.parse(await main(['workspace','op','--config',configPath,'--json',JSON.stringify(x)]));
 const cli=x=>run(process.execPath,['cli.mjs','workspace','op','--config',configPath,'--json',JSON.stringify(x)],{cwd:path.resolve(import.meta.dirname,'..')});
 await op({type:'createBoard',id:'live',title:'Live'});const config=await loadConfig(configPath),assets=path.join(root,'assets');await mkdir(assets);
 await writeFile(path.join(assets,'index.html'),'<h1>Original resource</h1><input id="draft" value="original">');
 await op({type:'updateWorkspace',patch:{resourceRoots:{assets:{path:path.relative(config.workspaceRoot,assets)}}}});
 const item=await op({type:'createItem',boardId:'live',item:{id:'html',title:'Prototype',content:{kind:'html',resource:{rootId:'assets',path:'index.html'}}},placement:{x:0,y:0,width:362,height:320,presentation:{mode:'panel',viewport:{width:360,height:274}}}});
 await op({type:'createItem',boardId:'live',item:{id:'text',title:'Text',content:{kind:'note',text:'Companion'}},placement:{x:450,y:0,width:300,height:240}});
 server=await listen(config,{port:0});let base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 await page.goto(base+'/boards/live/');await page.locator('[data-placement]').first().waitFor();await page.waitForTimeout(1200);
 const card=page.locator(`[data-placement="${JSON.parse(await main(['tools','call','board.get','--config',configPath,'--json','{"boardId":"live"}'])).placements.find(p=>p.itemId==='html').id}"]`);await card.locator('iframe').waitFor();
 await page.evaluate(()=>window.retainedCardFrame=document.querySelector('.workspace-live-preview iframe'));
 await cli({type:'updateBoard',boardId:'live',patch:{title:'Pushed title'}});await page.waitForFunction(()=>document.querySelector('#board-title').textContent.includes('Pushed title'));
 assert.equal(await page.evaluate(()=>window.retainedCardFrame===document.querySelector('.workspace-live-preview iframe')),true,'metadata keeps mounted card iframe');
 // An unsaved form remains exact while a push waits; cancel then drains it.
 await card.locator('[data-item-controls]').click();await page.locator('[data-context-edit]').click();const field=page.locator('dialog.workspace-dialog [name=description]');await field.fill('Unsaved form draft');await field.focus();
 await cli({type:'updateBoard',boardId:'live',patch:{title:'Queued while editing'}});await page.waitForTimeout(1200);assert.equal(await field.inputValue(),'Unsaved form draft');assert.equal(await page.locator('#board-title').textContent(),'Pushed title');
 await page.locator('dialog.workspace-dialog .workspace-close').click();await page.waitForFunction(()=>document.querySelector('#board-title').textContent==='Queued while editing');
 // Background metadata/resource changes defer throughout a native pointer gesture.
 const box=await card.boundingBox();await page.mouse.move(box.x+80,box.y+box.height-22);await page.mouse.down();await page.mouse.move(box.x+105,box.y+box.height-15);
 await cli({type:'updateBoard',boardId:'live',patch:{title:'Queued through gesture'}});await writeFile(path.join(assets,'index.html'),'<h1>Gesture resource</h1><input id="draft" value="original">');await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>window.retainedCardFrame===document.querySelector('.workspace-live-preview iframe')),true,'resource update waits for gesture');assert.equal(await page.locator('#board-title').textContent(),'Queued while editing');await page.keyboard.press('Escape');await page.mouse.up();
 await page.waitForFunction(()=>document.querySelector('#board-title').textContent==='Queued through gesture');
 // Local canonical-review drafts remain unsaved through remote reconciliation.
 let reviewAttempts=0;
 await page.route('**/api/operations',route=>{if(route.request().postDataJSON()?.type==='review'){reviewAttempts++;return route.abort();}return route.continue();});
 await card.locator('[data-item-controls]').click();const note=page.locator('#workspace-item-controls [data-note]');await note.fill('Retain local review draft');await note.focus();await page.waitForTimeout(500);await page.locator('dialog.workspace-dialog .workspace-close').click();await card.locator('[data-item-controls]').click();await note.focus();const attemptsBeforePush=reviewAttempts;
 await cli({type:'updateBoard',boardId:'live',patch:{title:'Review draft retained'}});await page.waitForTimeout(1200);assert.equal(await note.inputValue(),'Retain local review draft');
 await page.locator('#workspace-item-controls [data-context-close]').click();await page.waitForFunction(()=>document.querySelector('#board-title').textContent==='Review draft retained');
 await card.locator('[data-item-controls]').click();assert.equal(await page.locator('#workspace-item-controls [data-note]').inputValue(),'Retain local review draft');assert.equal(reviewAttempts,attemptsBeforePush,'remote refresh does not save local draft');
 const stored=JSON.parse(await main(['tools','call','item.get','--config',configPath,'--json','{"itemId":"html"}']));assert.equal(stored.review.note,'');await page.locator('#workspace-item-controls [data-context-close]').click();
 await card.locator('[data-open]').first().click();await page.locator('#reader-dialog').waitFor({state:'visible'});
 const reader=page.frameLocator('#active-reader').frameLocator('iframe');await reader.locator('#draft').fill('Keep mounted reader input');
 await page.evaluate(()=>window.retainedReader=document.querySelector('#active-reader'));
 await writeFile(path.join(assets,'index.html'),'<h1>Changed resource</h1><input id="draft" value="new resource">');
 await page.locator('#reader-update').waitFor({state:'visible'});assert.equal(await reader.locator('#draft').inputValue(),'Keep mounted reader input');assert.equal(await page.evaluate(()=>window.retainedReader===document.querySelector('#active-reader')),true);
 await page.locator('#reader-update').click();await reader.locator('h1').filter({hasText:'Changed resource'}).waitFor();assert.equal(await reader.locator('#draft').inputValue(),'new resource');
 await page.locator('#close-reader').click();
 // Native EventSource reconnect after an owned server restart resyncs latest data.
 const port=server.address().port;await closeAppServer(server);await cli({type:'updateBoard',boardId:'live',patch:{title:'Restart resync'}});server=await listen(config,{port});await page.waitForFunction(()=>document.querySelector('#board-title').textContent==='Restart resync',{},{timeout:10000});
 requests.length=0;await page.waitForTimeout(2500);assert.equal(requests.filter(url=>url.includes('/live')||url.includes('view=header')).length,0,'settled browser has no routine live/header polling');
 const home=await browser.newPage();await home.goto(base+'/');await home.locator('[data-home-board="live"]').waitFor();await cli({type:'createBoard',id:'new-home',title:'New home board'});await home.locator('[data-home-board="new-home"]').waitFor({timeout:10000});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['CLI metadata','card iframe retained','unsaved form retained','gesture deferred','review draft not saved','resource reload offer','reader state retained','server reconnect resync','no polling','Home CLI creation']}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
