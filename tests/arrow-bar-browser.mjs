// Arrow contextual bar, snapping endpoint drags, inline labels and edge-handle
// creation, using only isolated external fixtures. Screenshots go to TINKA_EVIDENCE_DIR.
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
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-arrow-ui-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-arrow-evidence-'));
await mkdir(evidence,{recursive:true});let server,browser;
try{
 const configFile=path.join(fixture,'local/config.json');
 await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Arrow fixture']);
 const config=await loadConfig(configFile),board=(await applyOperation(config,{type:'createBoard',title:'Arrows'})).result;
 const op=operation=>applyOperation(config,{...operation,boardId:board.boardId});
 for(const decoration of [
  {id:'plan',type:'region',shape:'rounded',x:0,y:0,width:200,height:110,color:'#dce7d5',text:'Plan'},
  {id:'build',type:'region',shape:'rounded',x:420,y:140,width:200,height:110,color:'#dfe7ed',text:'Build'},
  {id:'ship',type:'region',shape:'rectangle',x:420,y:360,width:200,height:150,color:'#f6e6a4',text:'Ship'},
  {id:'flow',type:'line',x:200,y:55,width:220,height:140,color:'#6c8060',text:'',endArrow:true,from:{decorationId:'plan',side:'right'},to:{decorationId:'build',side:'left'}},
 ])await op({type:'createDecoration',decoration});
 server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1280,height:860}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const open=async appearance=>{await page.goto(`${url}/boards/${board.boardId}/`);await page.evaluate(value=>localStorage.setItem('tinka/appearance',value),appearance);await page.reload();await page.locator('[data-decoration=plan]').waitFor();};
 await open('light');
 const snapshot=()=>getBoardSnapshot(config,board.boardId),find=async id=>(await snapshot()).decorations.find(d=>d.id===id);
 const eventually=async(read,done)=>{let value;for(let i=0;i<100;i++){value=await read();if(done(value))return value;await page.waitForTimeout(50);}return value;};
 const idle=()=>page.waitForFunction(()=>document.getElementById('workspace-paste')?.disabled===false&&!document.querySelector('.whiteboard-bar-status'));
 const box=async selector=>{const b=await page.locator(selector).boundingBox();return {...b,cx:b.x+b.width/2,cy:b.y+b.height/2};};
 // The visible midpoint of an arrow's drawn path, in screen pixels.
 const onLine=id=>page.evaluate(id=>{const p=document.querySelector(`[data-decoration="${id}"] .whiteboard-line-hit`),svg=p.ownerSVGElement,pt=p.getPointAtLength(p.getTotalLength()/2);
  const [tx,ty]=p.parentNode.getAttribute('transform').match(/-?[\d.]+/g).map(Number),view=svg.viewBox.baseVal,r=svg.getBoundingClientRect();
  return {x:r.left+(pt.x+tx)*r.width/view.width,y:r.top+(pt.y+ty)*r.height/view.height};},id);
 const selectArrow=async id=>{await idle();const p=await onLine(id);await page.mouse.click(p.x,p.y);await page.locator('.whiteboard-arrow-bar').waitFor();};
 const bar=(action,value)=>page.locator(`.whiteboard-arrow-bar [data-whiteboard-action="${action}"]${value?`[data-value="${value}"]`:''}`);
 const format=()=>bar('text-appearance').click();
 const option=(action,value)=>page.locator(`.whiteboard-menu [data-whiteboard-action="${action}"]${value?`[data-value="${value}"]`:''}`);
 const stroke=id=>page.locator(`[data-decoration="${id}"] .whiteboard-line-stroke`);

 // The three routes are on the arrow toolbar. Formatting keeps its own panel.
 await selectArrow('flow');
 assert.equal(await page.locator('.whiteboard-toolbar').getAttribute('aria-label'),'Arrow');
 assert.deepEqual(await page.locator('.whiteboard-arrow-bar [data-whiteboard-action=route]').evaluateAll(bs=>bs.map(b=>b.getAttribute('aria-label'))),['Straight','Elbow','Curve']);
 assert.equal(await bar('route','straight').getAttribute('aria-pressed'),'true');
 assert.equal(await bar('more').count(),0);
 assert.match(await stroke('flow').getAttribute('d'),/^M[^CL]*L[^CL]*$/);
 await page.screenshot({path:path.join(evidence,'arrow-bar-light.png')});
 await format();
 assert.equal(await page.locator('.whiteboard-menu [data-arrow-weight]').count(),1);
 assert.equal(await page.locator('.whiteboard-menu [data-color-swatches]').count(),0);
 assert.equal(await option('route').count(),0);
 assert.equal(await option('heads','end').getAttribute('aria-pressed'),'true');
 for(const b of await page.locator('.whiteboard-arrow-bar button').all())assert.ok(await b.getAttribute('title'),'every bar control has a tooltip');

 // Each control saves one field and marks itself current.
 await bar('drawing-color').click();
 assert.equal(await bar('drawing-color').getAttribute('aria-label'),'Stroke color');
 const blue=page.locator('.whiteboard-menu [data-swatch="palette:blue"]');
 await blue.click();assert.equal(await eventually(async()=>(await find('flow')).color,v=>v==='palette:blue'),'palette:blue');
 assert.equal(await eventually(()=>blue.getAttribute('aria-pressed'),v=>v==='true'),'true');
 await idle();await page.screenshot({path:path.join(evidence,'arrow-stroke-palette-light.png')});
 await format();
 await option('heads','both').click();const heads=await eventually(()=>find('flow'),d=>d.startArrow===true);assert.equal(heads.endArrow,true);
 assert.ok(await eventually(()=>stroke('flow').getAttribute('marker-start'),Boolean));
 await option('heads','none').click();const none=await eventually(()=>find('flow'),d=>d.startArrow===false&&d.endArrow===false);assert.equal(none.endArrow,false);
 assert.equal(await eventually(()=>stroke('flow').getAttribute('marker-end'),v=>v===null),null);
 await option('heads','end').click();await eventually(()=>find('flow'),d=>d.endArrow===true);
 await idle();await page.locator('[data-arrow-weight]').getByRole('button',{name:'Thick line'}).click();assert.equal(await eventually(async()=>(await find('flow')).thickness,v=>v==='thick'),'thick');
 assert.equal(await eventually(()=>stroke('flow').getAttribute('stroke-width'),v=>v==='3.5'),'3.5');
 await option('dashed','true').click();assert.equal(await eventually(async()=>(await find('flow')).dashed,v=>v===true),true);
 assert.ok(await eventually(()=>stroke('flow').getAttribute('stroke-dasharray'),Boolean));
 await idle();await page.keyboard.press('Escape');
 await bar('route','elbow').click();assert.equal(await eventually(async()=>(await find('flow')).route,v=>v==='elbow'),'elbow');
 assert.ok(await eventually(async()=>(await stroke('flow').getAttribute('d')).split('L').length>=4,Boolean),'elbow path bends');
 // Tab and Enter choose a primary route and keep it focused.
 await idle();await bar('route','elbow').focus();await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.value),'curved');
 await page.keyboard.press('Enter');assert.equal(await eventually(async()=>(await find('flow')).route,v=>v==='curved'),'curved');
 assert.match(await eventually(()=>stroke('flow').getAttribute('d'),v=>/C/.test(v)),/C/);
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.value),'curved');
 // A bend has live preview and saves one reversible revision.
 await idle();
 const bendSelector='[data-decoration=flow] [data-arrow-bend]';
 const beforeBend=await snapshot(),initial=(await find('flow')).bend,initialPath=await stroke('flow').getAttribute('d');
 const bendPoint=await box(bendSelector);
 await page.mouse.move(bendPoint.cx,bendPoint.cy);await page.mouse.down();await page.mouse.move(bendPoint.cx,bendPoint.cy-65,{steps:6});
 assert.notEqual(await stroke('flow').getAttribute('d'),initialPath);
 assert.equal((await snapshot()).revision,beforeBend.revision);
 await page.mouse.up();
 assert.notEqual(await eventually(async()=>(await find('flow')).bend,v=>v!==initial),initial);
 assert.equal((await snapshot()).revision,beforeBend.revision+1);
 await idle();await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
 assert.equal(await eventually(async()=>(await find('flow')).bend,v=>v===initial),initial);
 await idle();const bendAgain=await box(bendSelector),beforeCancel=await snapshot();
 await page.mouse.move(bendAgain.cx,bendAgain.cy);await page.mouse.down();await page.mouse.move(bendAgain.cx,bendAgain.cy+65,{steps:6});
 await page.keyboard.press('Escape');await page.mouse.up();
 assert.equal((await snapshot()).revision,beforeCancel.revision);
 assert.equal(await stroke('flow').getAttribute('d'),initialPath);
 await selectArrow('flow');
 await page.screenshot({path:path.join(evidence,'arrow-curve-light.png')});
 // Reverse swaps the attached ends and bend sign.
 await bar('reverse').click();const reversed=await eventually(()=>find('flow'),d=>d.from.decorationId==='build');assert.equal(reversed.to.decorationId,'plan');
 assert.equal(reversed.bend,-initial);
 // The board shows the reversed arrow (its end now on Plan) before the next gesture.
 await page.waitForFunction(()=>{const h=document.querySelector('[data-decoration=flow] [data-endpoint=to]')?.getBoundingClientRect(),p=document.querySelector('[data-decoration=plan]').getBoundingClientRect();return h&&Math.abs(h.x+h.width/2-p.right)<4;});
 assert.equal(await page.locator('dialog[open]').count(),0);

 // Dragging an end over a different shape highlights it and snaps to its nearest side.
 await idle();const handle=await box('[data-decoration=flow] [data-endpoint=to]'),ship=await box('[data-decoration=ship]');
 await page.mouse.move(handle.cx,handle.cy);await page.mouse.down();await page.mouse.move(ship.cx,ship.y+14,{steps:8});
 await page.locator('[data-decoration=ship].whiteboard-snap-target').waitFor();
 assert.equal(await page.locator('.whiteboard-port.snapped').count(),1);
 assert.match(await page.locator('.whiteboard-connect-hint').textContent(),/attach to Ship \(top\)/);
 await page.screenshot({path:path.join(evidence,'arrow-snap-light.png')});
 await page.mouse.up();const moved=await eventually(()=>find('flow'),d=>d.to.decorationId==='ship');
 assert.deepEqual([moved.to.decorationId,moved.to.side,moved.from.decorationId],['ship','top','build']);
 assert.equal(await page.locator('.whiteboard-snap-target').count(),0);
 // Dropped on empty canvas, the end detaches to a free point.
 await idle();const end=await box('[data-decoration=flow] [data-endpoint=to]');
 await page.mouse.move(end.cx,end.cy);await page.mouse.down();await page.mouse.move(ship.x+ship.width+180,ship.cy,{steps:6});
 assert.equal(await page.locator('.whiteboard-snap-target').count(),0);await page.mouse.up();
 const free=await eventually(async()=>(await find('flow')).to,to=>Number.isFinite(to?.x));assert.ok(Number.isFinite(free.y)&&!free.decorationId);

 // Double-click types the label in place; Enter and Escape both keep the text; empty removes it.
 const typeLabel=async(text,key)=>{await idle();const p=await onLine('flow');await page.mouse.dblclick(p.x,p.y);const field=page.locator('.whiteboard-label-editor textarea');await field.waitFor();await field.fill(text);return key&&page.keyboard.press(key);};
 await typeLabel('ships it');const editor=await box('.whiteboard-label-editor textarea'),mid=await onLine('flow');
 assert.ok(Math.abs(editor.cx-mid.x)<6&&Math.abs(editor.cy-mid.y)<6,'label editor sits centred on the line');
 await page.screenshot({path:path.join(evidence,'arrow-label-light.png')});
 await page.keyboard.press('Enter');assert.equal(await eventually(async()=>(await find('flow')).text,v=>v==='ships it'),'ships it');
 await page.locator('.whiteboard-label-editor').waitFor({state:'detached'});
 await typeLabel('kept','Escape');assert.equal(await eventually(async()=>(await find('flow')).text,v=>v==='kept'),'kept');
 await typeLabel('','Enter');assert.equal(await eventually(async()=>(await find('flow')).text,v=>v===''),'');
 await idle();assert.equal(await page.locator('[data-decoration=flow] .whiteboard-line-label').isVisible(),false);

 // A selected shape shows edge handles; dragging one draws an arrow that snaps to the target.
 await page.keyboard.press('Escape');await idle();await page.locator('[data-decoration=plan] [data-decoration-label]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.whiteboard-port').length===4);
 const bottom=await box('[aria-label="Connect Plan bottom"]'),build=await box('[data-decoration=build]');
 await page.mouse.move(bottom.cx,bottom.cy);await page.mouse.down();await page.mouse.move(build.x+10,build.cy,{steps:8});
 await page.locator('[data-decoration=build].whiteboard-snap-target').waitFor();await page.mouse.up();
 const drawn=await eventually(async()=>(await snapshot()).decorations.find(d=>d.type==='line'&&d.id!=='flow'),Boolean);
 assert.deepEqual([drawn.from.decorationId,drawn.from.side,drawn.to.decorationId,drawn.to.side],['plan','bottom','build','left']);
 assert.equal(drawn.route,'curved');assert.ok(Math.abs(drawn.bend)>1);

 // Delete keeps its canvas keyboard shortcut.
 await selectArrow(drawn.id);await page.keyboard.press('Delete');await eventually(async()=>(await snapshot()).decorations.some(d=>d.id===drawn.id),v=>!v);
 assert.equal((await snapshot()).decorations.some(d=>d.id===drawn.id),false);

 // Dark appearance: the same bar, snapping and label editor.
 await op({type:'updateDecoration',decorationId:'flow',patch:{to:{decorationId:'ship',side:'top'},text:'ships it'}});
 await open('dark');assert.equal(await page.locator('html').getAttribute('data-appearance'),'dark');
 await selectArrow('flow');await page.screenshot({path:path.join(evidence,'arrow-bar-dark.png')});
 const darkHandle=await box('[data-decoration=flow] [data-endpoint=to]'),buildDark=await box('[data-decoration=build]');
 await page.mouse.move(darkHandle.cx,darkHandle.cy);await page.mouse.down();await page.mouse.move(buildDark.x+buildDark.width-12,buildDark.cy,{steps:8});
 await page.locator('[data-decoration=build].whiteboard-snap-target').waitFor();await page.screenshot({path:path.join(evidence,'arrow-snap-dark.png')});
 await page.keyboard.press('Escape');await page.mouse.up();
 await typeLabel('ships it');await page.screenshot({path:path.join(evidence,'arrow-label-dark.png')});await page.keyboard.press('Enter');
 await page.locator('.whiteboard-label-editor').waitFor({state:'detached'});
 await page.setViewportSize({width:390,height:844});await page.locator('[data-decoration=flow] [data-decoration-label]').click();
 const narrow=await box('.whiteboard-arrow-bar');assert.ok(narrow.x>=0&&narrow.x+narrow.width<=390);
 await page.screenshot({path:path.join(evidence,'arrow-narrow-dark.png')});

 // The icon-only scrub and its keyboard path use real board units at natural zoom.
 for (const decoration of [
   {id:'wide',type:'line',text:'',x:20,y:410,width:260,height:1,from:{x:20,y:410},to:{x:280,y:410},color:'palette:blue',endArrow:true,route:'straight'},
   {id:'short',type:'line',text:'',x:40,y:520,width:58,height:15,from:{x:40,y:520},to:{x:98,y:535},color:'#66528a',startArrow:true,endArrow:true,route:'elbow',thickness:28},
 ]) await op({type:'createDecoration',decoration});
 await op({type:'updateDecoration',decorationId:'flow',patch:{thickness:40,dashed:false}});
 await page.setViewportSize({width:1280,height:860});await open('light');
 assert.equal(await page.locator('#viewport').evaluate(el=>getComputedStyle(el).getPropertyValue('--canvas-zoom').trim()),'1');
 const custom=page.getByRole('slider',{name:'Adjust arrow weight'});
 const width=()=>stroke('wide').getAttribute('stroke-width').then(Number);
 await selectArrow('wide');await format();await custom.waitFor();
 const weight=page.locator('[data-arrow-weight]');
 assert.equal(await weight.locator('[data-scrub-preset]').count(),3);
 assert.equal(await weight.locator('input').count(),0);
 assert.doesNotMatch(await weight.innerText(),/\d|px/);
 assert.equal(await custom.getAttribute('aria-valuenow'),'2');
 const beforeWeight=(await snapshot()).revision;
 const p=await box('[data-arrow-weight] [data-scrub-value]');
 await page.mouse.move(p.cx,p.cy);await page.mouse.down();await page.mouse.move(p.cx+36,p.cy,{steps:9});
 assert.equal(await width(),20,'Scrubbing previews the board-unit width before release');
 assert.equal((await snapshot()).revision,beforeWeight);
 assert.doesNotMatch(await weight.innerText(),/\d|px/);
 await page.mouse.up();
 assert.equal(await eventually(async()=>(await find('wide')).thickness,v=>v===20),20);await idle();
 assert.equal((await snapshot()).revision,beforeWeight+1);
 assert.equal(await page.locator('[data-decoration=wide] .whiteboard-line-head').count(),1);
 await page.screenshot({path:path.join(evidence,'arrow-weight-20.png')});
 for(const expected of [30,40]) {
   const beforeKey=(await snapshot()).revision;
   await custom.focus();await page.keyboard.down('PageUp');
   assert.equal(await width(),expected);assert.equal((await snapshot()).revision,beforeKey);
   await page.keyboard.up('PageUp');
   assert.equal(await eventually(async()=>(await find('wide')).thickness,v=>v===expected),expected);await idle();
   assert.equal((await snapshot()).revision,beforeKey+1);
 }
 await page.keyboard.press('Escape');
 await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
 assert.equal(await eventually(async()=>(await find('wide')).thickness,v=>v===30),30);
 await idle();await page.keyboard.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');
 assert.equal(await eventually(async()=>(await find('wide')).thickness,v=>v===40),40);
 await idle();
 assert.equal(await stroke('flow').getAttribute('stroke-width'),'40');
 assert.equal(await page.locator('[data-decoration=short] .whiteboard-line-head').count(),2);
 await page.screenshot({path:path.join(evidence,'arrow-weight-40.png')});

 // A mixed-weight selection keeps its widths distinct through one scrub and Undo.
 await selectArrow('wide');
 const shortMid=await onLine('short');
 await page.keyboard.down('Shift');await page.mouse.click(shortMid.x,shortMid.y);await page.keyboard.up('Shift');
 assert.equal(await page.locator('.decoration-line.selected').count(),2);
 await format();
 assert.equal(await custom.getAttribute('aria-valuetext'),'Mixed values');
 const mixedBefore=(await snapshot()).revision,mixedHandle=await box('[data-arrow-weight] [data-scrub-value]');
 await page.mouse.move(mixedHandle.cx,mixedHandle.cy);await page.mouse.down();
 await page.mouse.move(mixedHandle.cx-20,mixedHandle.cy,{steps:7});
 assert.equal(await width(),30);assert.equal(await stroke('short').getAttribute('stroke-width'),'18');
 assert.equal((await snapshot()).revision,mixedBefore);
 await page.mouse.up();
 const widths=async()=>[(await find('wide')).thickness,(await find('short')).thickness];
 assert.deepEqual(await eventually(widths,values=>values[0]===30&&values[1]===18),[30,18]);
 assert.equal((await snapshot()).revision,mixedBefore+1);
 await idle();await page.keyboard.press('Escape');await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
 assert.deepEqual(await eventually(widths,values=>values[0]===40&&values[1]===28),[40,28]);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,evidence,checks:'direct routes, heads and stroke, bend/Undo/Escape, endpoints, label editing, three presets and icon-only scrub reaching 20/40 at 100%, keyboard preview and atomic relative multi-arrow commit, short and curved bold arrows, light/dark/narrow'}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
