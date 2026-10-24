// Focused whiteboard interactions, using only isolated external fixtures.
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
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-whiteboard-ui-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-whiteboard-evidence-'));
await mkdir(evidence,{recursive:true});let server,browser;
try{
 const configFile=path.join(fixture,'local/config.json');
 await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Whiteboard fixture']);
 const config=await loadConfig(configFile),board=(await applyOperation(config,{type:'createBoard',title:'Release flow'})).result;
 const op=operation=>applyOperation(config,{...operation,boardId:board.boardId});
 await mkdir(path.join(fixture,'resources'),{recursive:true});await writeFile(path.join(fixture,'resources/index.html'),'<h1>Preview stays mounted</h1><script>window.mountIdentity=Math.random()</script>');
 await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:{docs:{path:path.relative(path.join(fixture,'boards/.tinka'),path.join(fixture,'resources'))}}}});
 const item=(await op({type:'createItem',item:{title:'Release preview',content:{kind:'html',resource:{rootId:'docs',path:'index.html'}}},placement:{x:580,y:0,width:300,height:250,presentation:{mode:'panel',viewport:{width:400,height:300}}}})).result;
 item.placementId=(await getBoardSnapshot(config,board.boardId)).placements.find(p=>p.itemId===item.itemId).id;
 for(const decoration of [
  {id:'process',type:'region',shape:'rounded',x:0,y:0,width:240,height:130,color:'#dce7d5',text:'Prepare release'},
  {id:'decision',type:'region',shape:'diamond',x:280,y:0,width:230,height:180,color:'#dfe7ed',text:'Ready?'},
  {id:'sticky',type:'region',shape:'rectangle',x:20,y:260,width:220,height:190,color:'#f6e6a4',text:'Keep the source\nand review together'},
  {id:'area',type:'region',x:290,y:300,width:450,height:210,color:'#e6eadf',text:'Review area'},
  {id:'attached',type:'line',x:240,y:65,width:40,height:25,color:'#6f835e',text:'review',endArrow:true,from:{decorationId:'process',side:'right'},to:{decorationId:'decision',side:'left'}},
  {id:'to-card',type:'line',x:510,y:90,width:70,height:35,color:'#6f835e',text:'approved',endArrow:true,from:{decorationId:'decision',side:'right'},to:{placementId:item.placementId,side:'left'}},
 ])await op({type:'createDecoration',decoration});
 server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${url}/boards/${board.boardId}/`);await page.locator('[data-decoration=process]').waitFor();
 const snapshot=()=>getBoardSnapshot(config,board.boardId),find=async id=>(await snapshot()).decorations.find(d=>d.id===id);
 const centre=async locator=>{const b=await locator.boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2};};
 const drag=async(locator,dx,dy,{cancel=false}={})=>{const p=await centre(locator);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+dx,p.y+dy,{steps:5});if(cancel)await page.keyboard.press('Escape');await page.mouse.up();};
 await page.evaluate(()=>window.keptFrame=document.querySelector('.workspace-live-preview iframe'));
 // Attached endpoints redraw during shape movement and commit without replacing media.
 const processShape=page.locator('[data-decoration=process]');const before=await page.locator('[data-decoration=attached]').boundingBox();
 await drag(processShape,35,65);await page.waitForFunction(()=>parseFloat(document.querySelector('[data-decoration=process]')?.style.top)>100);
 assert.equal((await find('process')).x,35);assert.equal((await find('process')).y,65);
 assert.equal(await page.evaluate(()=>window.keptFrame===document.querySelector('.workspace-live-preview iframe')),true);
 assert.notEqual((await page.locator('[data-decoration=attached]').boundingBox()).y,before.y);
 // Attached connectors follow card geometry before pointerup, then retain the iframe.
 const card=page.locator(`[data-placement="${item.placementId}"]`),cardBody=card.locator('.workspace-preview-launch');
 let cardPoint=await centre(cardBody),lineBefore=await page.locator('[data-decoration=to-card]').boundingBox();
 await page.mouse.move(cardPoint.x,cardPoint.y);await page.mouse.down();await page.mouse.move(cardPoint.x+45,cardPoint.y+25,{steps:5});
 const lineDuring=await page.locator('[data-decoration=to-card]').boundingBox();assert.ok(lineDuring.width>lineBefore.width+40);
 await page.mouse.up();await page.waitForTimeout(100);assert.equal((await snapshot()).placements.find(p=>p.id===item.placementId).x,625);
 await page.locator('[data-decoration=to-card] [data-decoration-label]').click();await page.locator('[data-decoration=to-card] [data-decoration-inspect]').click();
 await page.locator('[name=toSide]').selectOption('right');await page.locator('dialog.workspace-dialog button[type=submit]').click();await page.locator('dialog.workspace-dialog').waitFor({state:'detached'});
 const resize=card.locator('[data-resize]'),resizePoint=await centre(resize);lineBefore=await page.locator('[data-decoration=to-card]').boundingBox();
 await page.mouse.move(resizePoint.x,resizePoint.y);await page.mouse.down();await page.mouse.move(resizePoint.x+40,resizePoint.y+30,{steps:4});
 assert.ok((await page.locator('[data-decoration=to-card]').boundingBox()).width>lineBefore.width+35);await page.mouse.up();await page.waitForTimeout(100);
 assert.equal((await snapshot()).placements.find(p=>p.id===item.placementId).width,340);
 assert.equal(await page.evaluate(()=>window.keptFrame===document.querySelector('.workspace-live-preview iframe')),true);
 // Shape resizing uses the same temporary override path.
 await page.locator('[data-decoration=process] [data-decoration-label]').click();const shapeResize=page.locator('[data-decoration=process] [data-decoration-resize]');
 await drag(shapeResize,20,15);await page.waitForTimeout(100);assert.equal((await find('process')).width,260);
 // Geometry inspector exposes logical units and exact attached endpoints.
 await page.locator('[data-decoration=attached] [data-decoration-label]').click();await page.locator('[data-decoration=attached] [data-decoration-inspect]').click();
 await page.locator('dialog.workspace-dialog').waitFor();assert.match(await page.locator('dialog.workspace-dialog').textContent(),/logical board units/);assert.match(await page.locator('dialog.workspace-dialog').textContent(),/attached/);
 await page.locator('[name=toTarget]').selectOption('free');await page.locator('[name=toX]').fill('-40');await page.locator('[name=toY]').fill('130');await page.locator('dialog.workspace-dialog button[type=submit]').click();
 await page.locator('dialog.workspace-dialog').waitFor({state:'detached'});assert.deepEqual((await find('attached')).to,{x:-40,y:130});
 // Reattach with visible grab points, preserving the untouched start.
 await page.locator('[data-decoration=attached] [data-decoration-label]').click();
 const handle=page.locator('[data-decoration=attached] [data-endpoint=to]'),h=await centre(handle);
 await page.mouse.move(h.x,h.y);await page.mouse.down();await page.mouse.move(h.x+10,h.y,{steps:2});
 const port=page.getByRole('button',{name:'Connect Ready? left',exact:true});await port.waitFor();const end=await centre(port);await page.mouse.move(end.x,end.y,{steps:5});await page.mouse.up();
 await page.waitForFunction(()=>!document.querySelector('dialog[open]'));await page.waitForTimeout(100);
 assert.equal((await find('attached')).to.decorationId,'decision');
 // An endpoint can cross both axes into an exact free point, then reattach via keyboard form.
 await page.locator('[data-decoration=attached] [data-decoration-label]').click();const fromHandle=page.locator('[data-decoration=attached] [data-endpoint=from]');
 await drag(fromHandle,-365,-188);await page.waitForTimeout(100);const crossed=(await find('attached')).from;assert.ok(Number.isFinite(crossed.x)&&crossed.x<0&&crossed.y<0);
 await page.locator('[data-decoration=attached] [data-decoration-label]').click();await page.locator('[data-decoration=attached] [data-decoration-inspect]').click();await page.locator('[name=fromTarget]').selectOption('d:process');await page.locator('[name=fromSide]').selectOption('right');await page.locator('dialog.workspace-dialog button[type=submit]').click();await page.locator('dialog.workspace-dialog').waitFor({state:'detached'});assert.equal((await find('attached')).from.decorationId,'process');
 // Cancel leaves persisted geometry/revision alone, and sticky body drags as an object.
 const saved=await snapshot();await drag(page.locator('[data-decoration=sticky]'),45,20,{cancel:true});assert.equal((await snapshot()).revision,saved.revision);
 await drag(page.locator('[data-decoration=sticky]'),45,20);await page.waitForTimeout(100);assert.equal((await find('sticky')).x,65);
 // A port-to-port gesture creates one scoped attached arrow.
 await page.locator('[data-decoration=process]').hover();const startPort=page.getByRole('button',{name:'Connect Prepare release bottom',exact:true});await startPort.waitFor();const start=await centre(startPort);
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x,start.y+10,{steps:2});const stickyPort=page.getByRole('button',{name:'Connect Keep the source and review together top',exact:true});
 const endpoint=await page.locator('[data-port]').evaluateAll(elements=>{const el=elements.find(e=>JSON.parse(e.dataset.port).decorationId==='sticky'&&JSON.parse(e.dataset.port).side==='top');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
 await page.mouse.move(endpoint.x,endpoint.y,{steps:6});await page.mouse.up();await page.waitForTimeout(100);
 assert.ok((await snapshot()).decorations.some(d=>d.type==='line'&&d.from?.decorationId==='process'&&d.to?.decorationId==='sticky'));
 const region=await page.locator('[data-decoration=area]').boundingBox(),regionRevision=(await snapshot()).revision;
 await page.mouse.move(region.x+50,region.y+70);await page.mouse.down();await page.mouse.move(region.x+180,region.y+140,{steps:4});await page.locator('#workspace-marquee').waitFor();await page.keyboard.press('Escape');await page.mouse.up();assert.equal((await snapshot()).revision,regionRevision);
 await page.screenshot({path:path.join(evidence,'whiteboard-wide.png')});
 // Human Add menu creates the compact flowchart preset, using scoped metadata.
 await page.locator('#board-info-toggle').click();await page.locator('#workspace-add').click();await page.locator('[data-add=ellipse]').click();
 await page.locator('[data-decoration-label][contenteditable]').waitFor();await page.keyboard.press('Escape');await page.waitForTimeout(100);assert.ok((await snapshot()).decorations.some(d=>d.shape==='ellipse'&&d.type==='region'));
 // Narrow inspector remains reachable; target removal reports detached fallback.
 await page.setViewportSize({width:390,height:844});await page.locator('[data-decoration=sticky]').scrollIntoViewIfNeeded();await page.locator('[data-decoration=sticky] [data-decoration-label]').click();await page.locator('[data-decoration=sticky] [data-decoration-inspect]').click();
 await page.keyboard.press('Escape');await page.locator('[data-decoration=sticky]').focus();await page.keyboard.press('Enter');await page.locator('dialog.workspace-dialog').waitFor();
 const bounds=await page.locator('dialog.workspace-dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391);await page.screenshot({path:path.join(evidence,'whiteboard-narrow.png')});await page.keyboard.press('Escape');
 await op({type:'removeDecoration',decorationId:'decision'});await page.reload();await page.locator('.whiteboard-detached').first().waitFor();assert.equal(await page.evaluate(()=>document.querySelector('.whiteboard-detached')?.textContent),'Detached');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,evidence,checks:'shape/card movement + resize with transient attached redraw, mounted preview identity, exact geometry/free endpoint, reattach, cancellation, sticky whole body, region marquee, port creation, Add preset, keyboard + 390 inspector, detached fallback'}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
