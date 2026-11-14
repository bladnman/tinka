// Headless checks for Smart Fit, Back and the board map: Fit follows the selection
// (selection, then board), F/⌥-click/⇧1/⇧2 (physical keys), keys ignored while typing,
// the map opening by itself only on a large board, map drag/click/keys, Back to the
// exact earlier view, and the selection bar staying clear of the zoom controls and map.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {FIT_MAX_ZOOM} from '../public/canvas-zoom.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-fit-map-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-fit-map-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser,checks=0;const errors=[];
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const near=(a,b,eps=.5)=>Math.abs(a-b)<=eps;
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Fit studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 // A large board: a 6 × 5 grid of tiles, a region around part of it and a parked cluster far to the right.
 await op('createBoard',{id:'large',title:'Large board'});
 const large=[];
 for(let row=0;row<5;row++)for(let col=0;col<6;col++)large.push((await op('createItem',{boardId:'large',item:{title:`Tile ${row}-${col}`,content:{kind:'note',text:'A note.'}},placement:{x:col*780,y:row*620,width:720,height:560}})).placementIds[0]);
 for(let i=0;i<3;i++)large.push((await op('createItem',{boardId:'large',item:{title:`Parked ${i}`,content:{kind:'note',text:'Far away.'}},placement:{x:9000+i*380,y:200,width:320,height:260}})).placementIds[0]);
 await op('createDecoration',{boardId:'large',decoration:{type:'region',x:-40,y:-40,width:2400,height:1900,color:'#8b6fb0',text:'Research'}});
 await op('createBoard',{id:'small',title:'Small board'});
 const small=[];for(let i=0;i<3;i++)small.push((await op('createItem',{boardId:'small',item:{title:`Small ${i}`},placement:{x:i*300,y:0,width:240,height:120}})).placementIds[0]);
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light',reducedMotion:'reduce'});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const view=()=>page.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.getElementById('plane')).transform);return {zoom:new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a,x:m.e,y:m.f};});
 const open=async(id,width=1440,height=900)=>{await page.setViewportSize({width,height});await page.goto(base+`/boards/${id}/`,{waitUntil:'load'});await page.locator('.workspace-card').first().waitFor();
  if(await page.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.keyboard.press('Escape');}
  await page.waitForTimeout(120);};
 const fit=page.locator('#fit'),mapEl=page.locator('#board-map'),toggle=page.locator('#board-map-toggle'),back=page.locator('#view-back');
 const label=()=>fit.locator('.fit-label').textContent();
 const card=id=>page.locator(`.workspace-card[data-placement="${id}"]`);
 const boxesOverlap=(a,b)=>a&&b&&a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;

 // (1) The small board: the map stays closed, its toggle is available, and Fit reads "Fit".
 await open('small');
 ok(await mapEl.isHidden(),'The map stays closed on a small board');
 ok(await toggle.isVisible()&&await toggle.getAttribute('aria-pressed')==='false','The map toggle is in the zoom controls');
 assert.equal(await label(),'Fit');assert.equal(await fit.getAttribute('aria-label'),'Fit board');checks+=2;
 // The zoom menu hides Fit selection while nothing is selected.
 await page.locator('#zoom-menu-toggle').click();ok(await page.locator('[data-zoom-to="selection"]').isHidden(),'Zoom menu hides Fit selection with nothing selected');await page.keyboard.press('Escape');

 // (2) The large board: the map opens by itself, and fits leave room for it.
 await open('large');
 ok(await mapEl.isVisible(),'The map opens by itself on a large board at desktop width');
 assert.equal(await toggle.getAttribute('aria-pressed'),'true');checks++;
 await fit.click();
 const fitted=await view();
 const mapBox=await mapEl.boundingBox();
 const rightmost=await card(large.at(-1)).boundingBox();
 ok(rightmost.x+rightmost.width<=mapBox.x+1,`Fit board leaves room for the open map: ${rightmost.x+rightmost.width} ≤ ${mapBox.x}`);
 ok(fitted.zoom<.4,'This board needs less than 40% to fit');
 // Selecting two tiles turns Fit into "Fit selection" with a count; pressing it fits them, then the board.
 await card(large[0]).click({modifiers:['Shift']});await card(large[7]).click({modifiers:['Shift']});
 await page.waitForFunction(()=>document.querySelector('#fit .fit-label').textContent==='Fit selection');
 assert.equal(await fit.locator('.fit-count').textContent(),'2');assert.equal(await fit.getAttribute('aria-label'),'Fit 2 selected');checks+=2;
 await page.locator('#zoom-menu-toggle').click();ok(await page.locator('[data-zoom-to="selection"]').isVisible(),'Zoom menu shows Fit selection with a selection');await page.keyboard.press('Escape');
 const header=page.locator('[data-map-fit="selection"]');
 ok(await header.isVisible()&&await header.textContent()==='Fit 2 selected','Map header offers Fit 2 selected');
 const beforeFit=await view();
 await fit.click();
 const selFit=await view();
 ok(selFit.zoom>beforeFit.zoom+.1,`Fit selection zooms in on the two tiles: ${beforeFit.zoom} → ${selFit.zoom}`);
 ok(selFit.zoom<=FIT_MAX_ZOOM+1e-9,'Fit selection stays within 125%');
 assert.equal(await label(),'Fit board');checks++;
 ok(await back.isVisible(),'Back appears after a fit');
 await page.screenshot({path:path.join(evidence,'fit-map-1440-light-selection.png')});
 // Back returns to the exact earlier view, then disappears.
 await back.click();await page.waitForTimeout(60);
 const restored=await view();
 ok(near(restored.x,beforeFit.x,1)&&near(restored.y,beforeFit.y,1)&&Math.abs(restored.zoom-beforeFit.zoom)<1e-6,`Back restores the exact view: ${JSON.stringify(beforeFit)} vs ${JSON.stringify(restored)}`);
 ok(await back.isHidden(),'Back disappears once used');
 // F does the same cycle: selection, then board.
 await page.locator('#viewport').focus();
 await page.keyboard.press('f');ok((await view()).zoom>beforeFit.zoom+.1&&await label()==='Fit board','F fits the selection');
 await page.keyboard.press('f');const boardAgain=await view();ok(near(boardAgain.zoom,fitted.zoom,1e-6)&&await label()==='Fit selection','F again fits the board');
 // A manual pan ends Back.
 ok(await back.isVisible(),'Back is offered after F');
 await page.mouse.move(700,450);await page.mouse.wheel(0,200);await page.waitForTimeout(60);
 ok(await back.isHidden(),'Back disappears after a manual pan');
 // ⌥-click always fits the board, even with a selection.
 await page.keyboard.press('Shift+2');ok(await label()==='Fit board','⇧2 fits the selection');
 await page.keyboard.press('f');await fit.click({modifiers:['Alt']});ok(near((await view()).zoom,fitted.zoom,1e-6),'⌥-click fits the board');
 // ⇧2 by physical key: a layout where Shift-2 types a quotation mark still fits the selection.
 await page.keyboard.press('Shift+1');
 await page.evaluate(()=>document.getElementById('viewport').dispatchEvent(new KeyboardEvent('keydown',{key:'"',code:'Digit2',shiftKey:true,bubbles:true,cancelable:true})));
 ok(await label()==='Fit board','⇧2 matches the physical Digit2 key (non-US layout)');
 await page.evaluate(()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'!',code:'Digit1',shiftKey:true,bubbles:true,cancelable:true})));
 ok(near((await view()).zoom,fitted.zoom,1e-6),'⇧1 fits the board from outside the canvas too');
 await page.locator('#zoom-plus').focus();await page.keyboard.press('Shift+2');
 ok(await label()==='Fit board','⇧2 works with focus outside the canvas, as ⇧1 does');

 // (3) F and M do nothing while typing in a field (Navigator search) or with ⌘/Ctrl held.
 await page.keyboard.press('Shift+1');const steady=await view();
 await page.keyboard.press('ControlOrMeta+k');const search=page.locator('#project-navigator input[type="search"], #project-navigator input').first();await search.waitFor();
 await search.focus();await page.keyboard.type('fm');
 ok(await search.inputValue()==='fm','F and M type into the Navigator search');
 ok(await mapEl.isVisible()&&near((await view()).zoom,steady.zoom,1e-6),'F and M in a text field leave the view and map alone');
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 await page.locator('#viewport').focus();
 await page.keyboard.press('ControlOrMeta+m').catch(()=>{});
 ok(await mapEl.isVisible(),'⌘/Ctrl-M does not toggle the map');

 // (4) M toggles the map and remembers the choice for this board.
 await page.keyboard.press('m');ok(await mapEl.isHidden()&&await toggle.getAttribute('aria-pressed')==='false','M closes the map');
 await open('large');ok(await mapEl.isHidden(),'A closed map stays closed on return');
 await page.keyboard.press('m');ok(await mapEl.isVisible(),'M opens it again');
 await open('large');ok(await mapEl.isVisible(),'An opened map is remembered');

 // (5) The map: drag pans at the same zoom, click jumps, keys pan and zoom, and none of it leaks to the board.
 await page.keyboard.press('Shift+1');
 await card(large[0]).click({modifiers:['Shift']});await card(large[7]).click({modifiers:['Shift']});
 ok(await page.locator('.workspace-card.selected').count()===2,'Two tiles selected again');
 const stage=page.locator('.board-map-stage');const frame=page.locator('.board-map-frame');
 const z0=await view();const fb=await frame.boundingBox();
 await page.mouse.move(fb.x+fb.width/2,fb.y+fb.height/2);await page.mouse.down();await page.mouse.move(fb.x+fb.width/2-30,fb.y+fb.height/2-10,{steps:4});await page.mouse.up();
 const dragged=await view();
 ok(Math.abs(dragged.zoom-z0.zoom)<1e-9,'Dragging the map frame keeps the zoom');
 ok(dragged.x>z0.x+20,`Dragging the frame left pans the board: ${z0.x} → ${dragged.x}`);
 const fb2=await frame.boundingBox();ok(near(fb2.x,fb.x-30,3),`The frame follows the pointer: ${fb.x} → ${fb2.x}`);
 // Zoom in so the frame is small, then click far to the right: the view jumps there at the same zoom.
 await page.locator('#viewport').focus();for(let i=0;i<6;i++)await page.keyboard.press('+');
 const z1=await view();const sb=await stage.boundingBox();
 const target={x:sb.x+sb.width-12,y:sb.y+sb.height/2};
 await page.mouse.click(target.x,target.y);await page.waitForTimeout(60);
 const jumped=await view();
 ok(Math.abs(jumped.zoom-z1.zoom)<1e-9,'A map click keeps the zoom');
 const fj=await frame.boundingBox();
 ok(near(fj.x+fj.width/2,target.x,3)&&near(fj.y+fj.height/2,target.y,3),`A map click centres the view on that spot: frame centre ${fj.x+fj.width/2},${fj.y+fj.height/2} vs ${target.x},${target.y}`);
 const parked=await card(large.at(-2)).boundingBox();ok(parked&&parked.x<1440&&parked.x+parked.width>0,'The click reached the parked cluster');
 // Keys on the focused map pan by a quarter view; Escape closes it and returns focus.
 await stage.focus();const k0=await view();
 await page.keyboard.press('ArrowLeft');const k1=await view();
 ok(near(k1.x-k0.x,1440*.25,2)&&k1.zoom===k0.zoom,`Arrow keys on the map pan the board: ${JSON.stringify(k0)} → ${JSON.stringify(k1)}`);
 await page.keyboard.press('-');ok((await view()).zoom<k1.zoom,'− on the map zooms out');
 // The selection survives keys on the map (no nudge, no Escape clearing it).
 const selectedCount=await page.locator('.workspace-card.selected').count();
 await page.keyboard.press('Escape');ok(await mapEl.isHidden()&&await page.evaluate(()=>document.activeElement?.id)==='board-map-toggle','Escape on the map closes it and focuses the toggle');
 ok(await page.locator('.workspace-card.selected').count()===selectedCount,'Escape on the map keeps the selection');
 await toggle.click();
 // A wheel over the map zooms the board there, and never also pans the board.
 const w0=await view();const sb2=await stage.boundingBox();await page.mouse.move(sb2.x+sb2.width/2,sb2.y+sb2.height/2);await page.mouse.wheel(0,-100);
 const w1=await view();ok(w1.zoom>w0.zoom,'Wheel over the map zooms the board');

 // (6) Layout at 1440: the selection bar and the (wider) zoom controls do not collide.
 await page.keyboard.press('Shift+2');
 const bar=page.locator('#workspace-selection'),pill=page.locator('.canvas-footer .zoom-pill');
 await page.waitForTimeout(100);
 ok(await back.isVisible()&&await bar.isVisible(),`Back and the selection bar are both showing: back ${await back.isVisible()} bar ${await bar.isVisible()} selected ${await page.locator('.workspace-card.selected').count()} label ${await label()} active ${await page.evaluate(()=>document.activeElement?.id||document.activeElement?.className)}`);
 ok(!boxesOverlap(await bar.boundingBox(),await pill.boundingBox()),'The selection bar clears the zoom controls at 1440');
 ok(!boxesOverlap(await bar.boundingBox(),await mapEl.boundingBox()),'The selection bar clears the map at 1440');
 await page.screenshot({path:path.join(evidence,'fit-map-1440-light-map-selection.png')});
 // A narrower desktop keeps them apart too, and so does an open Inspector.
 await page.setViewportSize({width:1244,height:900});await page.waitForTimeout(150);
 ok(!boxesOverlap(await bar.boundingBox(),await pill.boundingBox())&&!boxesOverlap(await bar.boundingBox(),await mapEl.boundingBox()),'The selection bar clears the zoom controls and map at 1244');
 await page.locator('#board-info-toggle').click();await page.waitForTimeout(150);
 ok(!boxesOverlap(await bar.boundingBox(),await pill.boundingBox())&&!boxesOverlap(await bar.boundingBox(),await mapEl.boundingBox())&&!boxesOverlap(await mapEl.boundingBox(),await page.locator('#board-info').boundingBox()),'With the Inspector open, the bar, zoom controls, map and Inspector stay apart');
 await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(150);
 // Dark: the map stays readable (frame and silhouettes).
 await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>{localStorage.setItem(Object.keys(localStorage).find(k=>k.endsWith('/appearance'))||'x','dark');});
 await page.locator('#board-info-toggle').click();const darkButton=page.locator('#board-info [data-appearance="dark"], #board-info button:has-text("Dark")').first();
 if(await darkButton.count())await darkButton.click();await page.keyboard.press('Escape');await page.waitForTimeout(150);
 ok(await page.evaluate(()=>document.documentElement.dataset.appearance)==='dark','Dark appearance is on');
 const pixels=await stage.evaluate(el=>{const c=el.querySelector('canvas'),ctx=c.getContext('2d'),d=ctx.getImageData(0,0,c.width,c.height).data;let painted=0;for(let i=3;i<d.length;i+=4)if(d[i]>0)painted++;return painted/(c.width*c.height);});
 ok(pixels>.05,`The dark map draws its silhouettes: ${pixels}`);
 await page.screenshot({path:path.join(evidence,'fit-map-1440-dark.png')});
 await mapEl.screenshot({path:path.join(evidence,'fit-map-map-dark.png')});

 // (7) A phone: the map starts closed even on a large board; opened, the selection bar never covers it.
 await page.emulateMedia({colorScheme:'light'});
 await open('large',390,844);
 ok(await mapEl.isHidden(),'On a phone the map starts closed');
 await page.keyboard.press('Shift+1');
 await card(large[0]).click({modifiers:['Shift']}).catch(async()=>{await page.evaluate(id=>document.querySelector(`.workspace-card[data-placement="${id}"] [data-placement-select]`)?.click(),large[0]);});
 await toggle.click();await page.waitForTimeout(150);
 ok(await mapEl.isVisible()&&await bar.isVisible(),'Phone: map and selection bar showing');
 ok(!boxesOverlap(await bar.boundingBox(),await mapEl.boundingBox()),'Phone: the selection bar does not cover the map');
 ok(!boxesOverlap(await bar.boundingBox(),await pill.boundingBox()),'Phone: the selection bar clears the zoom controls');
 ok(!boxesOverlap(await mapEl.boundingBox(),await pill.boundingBox()),'Phone: the map sits above the zoom controls');
 await page.keyboard.press('f');ok(await back.isVisible(),'Phone: Back after a fit');
 const pb=await pill.boundingBox();ok(pb.x>=0&&pb.x+pb.width<=390,'Phone: the zoom controls fit the width');
 await page.screenshot({path:path.join(evidence,'fit-map-390.png')});
 // With motion, Back still lands exactly where it started.
 const moving=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light'});const mp=await moving.newPage();mp.on('pageerror',e=>errors.push(e.message));
 await mp.goto(base+'/boards/small/',{waitUntil:'load'});await mp.locator('.workspace-card').first().waitFor();await mp.waitForTimeout(100);
 const mview=()=>mp.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.getElementById('plane')).transform);return {zoom:new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a,x:m.e,y:m.f};});
 const m0=await mview();await mp.locator('#fit').click();await mp.locator('#view-back').click();await mp.waitForTimeout(500);const m1=await mview();
 ok(near(m0.x,m1.x,1)&&near(m0.y,m1.y,1)&&Math.abs(m0.zoom-m1.zoom)<1e-6,`Back with motion lands on the exact view: ${JSON.stringify(m0)} vs ${JSON.stringify(m1)}`);
 await moving.close();
 assert.deepEqual(errors,[]);checks++;
 console.log(`Fit and map browser checks passed: ${checks} assertions. Evidence: ${evidence}`);
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
