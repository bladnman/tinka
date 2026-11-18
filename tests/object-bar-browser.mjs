// The contextual bar for Sticky notes, Text and shapes, using only isolated
// external fixtures. Screenshots go to TINKA_EVIDENCE_DIR.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-object-bar-ui-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-object-bar-evidence-'));
await mkdir(evidence,{recursive:true});let server,browser;
try{
 const configFile=path.join(fixture,'local/config.json');
 await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Object bar fixture']);
 const config=await loadConfig(configFile),board=(await applyOperation(config,{type:'createBoard',title:'Objects'})).result;
 const op=operation=>applyOperation(config,{...operation,boardId:board.boardId});
 for(const decoration of [
  {id:'note',type:'region',shape:'rectangle',x:0,y:0,width:220,height:200,color:'palette:gold',text:'A thought to keep'},
  {id:'words',type:'text',x:320,y:20,width:280,height:70,color:'#7a8a68',text:'Write something'},
  {id:'step',type:'region',shape:'rounded',x:320,y:200,width:240,height:130,color:'#e0e8da',text:'Process'},
  {id:'note2',type:'region',shape:'rectangle',x:0,y:260,width:220,height:200,color:'#cfe0f1',text:'Another thought',textSize:'small'},
  {id:'a1',type:'line',x:700,y:40,width:200,height:60,color:'#6c8060',text:'',endArrow:true,from:{x:700,y:40},to:{x:900,y:100}},
  {id:'a2',type:'line',x:700,y:180,width:200,height:60,color:'#6c8060',text:'',endArrow:true,dashed:true,from:{x:700,y:180},to:{x:900,y:240}},
 ])await op({type:'createDecoration',decoration});
 server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1280,height:860}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const open=async appearance=>{await page.goto(`${url}/boards/${board.boardId}/`);await page.evaluate(value=>localStorage.setItem('tinka/appearance',value),appearance);await page.reload();await page.locator('[data-decoration=note]').waitFor();};
 await open('light');
 const find=async id=>(await getBoardSnapshot(config,board.boardId)).decorations.find(d=>d.id===id);
 const eventually=async(read,done)=>{let value;for(let i=0;i<100;i++){value=await read();if(done(value))return value;await page.waitForTimeout(50);}return value;};
 const idle=()=>page.waitForFunction(()=>document.getElementById('workspace-paste')?.disabled===false&&!document.querySelector('.whiteboard-bar-status'));
 const select=async id=>{await idle();await page.locator(`[data-decoration="${id}"] [data-decoration-label]`).click();await page.locator('.whiteboard-arrow-bar').waitFor();};
 const bar=(action,value)=>page.locator(`.whiteboard-arrow-bar [data-whiteboard-action="${action}"]${value?`[data-value="${value}"]`:''}`);
 const format=()=>bar('text-appearance').click();
 const swatch=id=>page.locator(`.whiteboard-menu [data-swatch="${id}"]`);
 const size=id=>page.locator(`.whiteboard-menu [data-scrub-preset="${id}"]`);
 const option=(action,value)=>page.locator(`.whiteboard-menu [data-whiteboard-action="${action}"]${value?`[data-value="${value}"]`:''}`);
 const css=(selector,property)=>page.evaluate(([selector,property])=>getComputedStyle(document.querySelector(selector))[property],[selector,property]);
 const groups=()=>page.locator('.whiteboard-arrow-bar [role=group]').evaluateAll(list=>list.map(g=>g.getAttribute('aria-label')).filter(name=>name!=='Container'&&name!=='Grouping'));

 // A loose sticky starts with paper color and text size. Text editing and
 // connections stay on the object.
 await select('note');
 assert.equal(await page.locator('.whiteboard-toolbar').getAttribute('aria-label'),'Sticky note');
 assert.deepEqual(await groups(),['Appearance','Drawing actions']);
 assert.deepEqual(await page.locator('.whiteboard-toolbar button').evaluateAll(list=>list.map(b=>b.getAttribute('aria-label'))),['Paper color','Text size','Text alignment']);
 assert.equal(await page.locator('.whiteboard-port').count(),4);
 await page.screenshot({path:path.join(evidence,'sticky-bar-light.png')});
 await bar('drawing-color').click();
 for(const b of await page.locator('.whiteboard-arrow-bar [role=group]:not([aria-label=Container]) button').all())assert.ok(await b.getAttribute('title'),'every bar control has a tooltip');
 assert.equal(await swatch('palette:gold').getAttribute('aria-pressed'),'true');
 await page.screenshot({path:path.join(evidence,'sticky-paper-palette-light.png')});
 await swatch('palette:rose').click();assert.equal(await eventually(async()=>(await find('note')).color,v=>v==='palette:rose'),'palette:rose');
 await idle();await bar('caption-size').click();await size('large').click();assert.equal(await eventually(async()=>(await find('note')).textSize,v=>v==='large'),'large');
 assert.equal(await eventually(()=>css('[data-decoration=note] .workspace-decoration-label','fontSize'),v=>v==='28px'),'28px');
 // Keyboard: Tab walks the format controls, Enter applies, focus stays on the control.
 await size('large').and(page.locator('[aria-pressed=true]')).waitFor();
 await idle();await format();await option('align','left').focus();await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.value),'center');await page.keyboard.press('Enter');
 assert.equal(await eventually(async()=>(await find('note')).textAlign,v=>v==='center'),'center');
 assert.equal(await eventually(()=>css('[data-decoration=note] .workspace-decoration-label','textAlign'),v=>v==='center'),'center');
 await idle();assert.equal(await page.evaluate(()=>document.activeElement.dataset.value),'center');
 assert.equal(await bar('more').count(),0,'a loose sticky has no overflow actions');
 assert.equal(await bar('wrap-container').count(),0);
 assert.equal(await page.locator('.whiteboard-port').count(),4);await page.keyboard.press('Escape');

 // Text: text colours, size and alignment, on the same bar.
 await select('words');
 assert.equal(await page.locator('.whiteboard-toolbar').getAttribute('aria-label'),'Text');
 assert.deepEqual(await groups(),['Text appearance','Alignment','Text actions']);await bar('text-ink').click();
 await page.locator('.whiteboard-menu [data-swatch="palette:blue"]').click();assert.equal(await eventually(async()=>(await find('words')).color,v=>v==='palette:blue'),'palette:blue');
 await idle();await bar('text-size').click();
 await size('large').click();
 assert.equal(await eventually(async()=>(await find('words')).textSize,v=>v==='large'),'large');
 assert.equal(await eventually(()=>css('[data-decoration=words]','fontSize'),v=>v==='36px'),'36px');
 await idle();await bar('align','right').click();await eventually(async()=>(await find('words')).textAlign,v=>v==='right');
 assert.equal(await eventually(()=>css('[data-decoration=words] .workspace-decoration-label','textAlign'),v=>v==='right'),'right');
 await idle();await page.screenshot({path:path.join(evidence,'text-bar-light.png')});

 // Shapes add a shape-type choice.
 await select('step');assert.deepEqual(await groups(),['Appearance','Drawing actions']);await format();
 assert.equal(await option('align','center').getAttribute('aria-pressed'),'true');
 await option('shape','diamond').click();assert.equal(await eventually(async()=>(await find('step')).shape,v=>v==='diamond'),'diamond');

 // Several of one kind: one bar over the selection, mixed values unmarked, each change to all.
 const shiftClick=async selector=>{await idle();const b=await page.locator(selector).boundingBox();await page.keyboard.down('Shift');await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await page.keyboard.up('Shift');};
 const arrowMid=id=>page.evaluate(id=>{const p=document.querySelector(`[data-decoration="${id}"] .whiteboard-line-hit`),svg=p.ownerSVGElement,pt=p.getPointAtLength(p.getTotalLength()/2),[tx,ty]=p.parentNode.getAttribute('transform').match(/-?[\d.]+/g).map(Number),view=svg.viewBox.baseVal,r=svg.getBoundingClientRect();return {x:r.left+(pt.x+tx)*r.width/view.width,y:r.top+(pt.y+ty)*r.height/view.height};},id);
 await select('note');await shiftClick('[data-decoration=note2] [data-decoration-label]');
 assert.equal(await eventually(()=>page.locator('.whiteboard-toolbar').getAttribute('aria-label'),v=>v==='2 sticky notes'),'2 sticky notes');
 assert.deepEqual(await groups(),['Appearance','Drawing actions']);await bar('caption-size').click();
 assert.equal(await page.locator('.whiteboard-menu [data-scrub-preset][aria-pressed=true]').count(),0,'differing sizes show no current size');
 assert.equal(await bar('wrap-container').count(),1,'selection can become one container');
 assert.equal(await page.locator('[data-decoration].selected').count(),2);
 await page.screenshot({path:path.join(evidence,'multi-sticky-light.png')});
 const revision=(await getBoardSnapshot(config,board.boardId)).revision;
 await size('large').click();await eventually(async()=>(await find('note2')).textSize,v=>v==='large');
 assert.equal((await find('note')).textSize,'large');assert.equal((await getBoardSnapshot(config,board.boardId)).revision,revision+1,'one write for both');
 await idle();await bar('drawing-color').click();await swatch('palette:green').click();await eventually(async()=>(await find('note2')).color,v=>v==='palette:green');assert.equal((await find('note')).color,'palette:green');
 // Mixed kinds show only the shared options.
 await swatch('palette:green').and(page.locator('[aria-pressed=true]')).waitFor();
 await page.keyboard.press('Escape');
 await shiftClick('[data-decoration=words] [data-decoration-label]');
 assert.equal(await eventually(()=>page.locator('.whiteboard-toolbar').getAttribute('aria-label'),v=>v==='3 objects'),'3 objects');
 assert.deepEqual(await groups(),['Appearance','Drawing actions']);
 assert.equal(await bar('drawing-color').count(),0,'Mixed fill and ink do not share a color control');
 await page.keyboard.press('Escape');await page.locator('.whiteboard-toolbar').waitFor({state:'hidden'});
 // Two arrows: dash is "mixed" until applied to both.
 await idle();let m=await arrowMid('a1');await page.mouse.click(m.x,m.y);m=await arrowMid('a2');await page.keyboard.down('Shift');await page.mouse.click(m.x,m.y);await page.keyboard.up('Shift');
 assert.equal(await eventually(()=>page.locator('.whiteboard-toolbar').getAttribute('aria-label'),v=>v==='2 arrows'),'2 arrows');
 await format();assert.equal(await page.locator('.whiteboard-menu [data-whiteboard-action=dashed][aria-pressed=true]').count(),0);
 await option('dashed','true').click();await eventually(async()=>(await find('a1')).dashed,v=>v===true);assert.equal((await find('a2')).dashed,true);
 await idle();await option('heads','both').click();await eventually(async()=>(await find('a2')).startArrow,v=>v===true);assert.equal((await find('a1')).startArrow,true);
 // Deleting several is one write.
 await option('heads','both').and(page.locator('[aria-pressed=true]')).waitFor();
 const before=(await getBoardSnapshot(config,board.boardId)).revision;await idle();
 assert.equal(await bar('more').count(),0,'multiple arrows have no overflow actions');
 await page.keyboard.press('Escape');await page.keyboard.press('Delete');
 await eventually(()=>find('a1'),v=>!v);assert.equal(await find('a2'),undefined);assert.equal((await getBoardSnapshot(config,board.boardId)).revision,before+1);

 // Dark appearance views of the sticky and text bars.
 await open('dark');assert.equal(await page.locator('html').getAttribute('data-appearance'),'dark');
 await select('note');await page.screenshot({path:path.join(evidence,'sticky-bar-dark.png')});
 await select('words');await page.screenshot({path:path.join(evidence,'text-bar-dark.png')});
 await select('note');await shiftClick('[data-decoration=note2] [data-decoration-label]');await page.locator('.whiteboard-toolbar[aria-label="2 sticky notes"]').waitFor();await page.screenshot({path:path.join(evidence,'multi-sticky-dark.png')});
 await select('note');await page.keyboard.press('Delete');assert.equal(await eventually(()=>find('note'),v=>!v),undefined);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,evidence,checks:'multi-select same-kind/mixed bars with one-write apply and delete; direct sticky paper, size and alignment, text ink, shape options, edge hotspots, selection-only Make container, keyboard, light and dark screenshots'}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
