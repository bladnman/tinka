// Headless checks for the Canvas zoom range and for pinch over a Tinka: Control-wheel
// and trackpad pinch over an item's live preview zoom the board around the cursor,
// and the preview's own page never receives or applies the gesture.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {sliderFromZoom,MAX_ZOOM,MIN_ZOOM,FIT_MAX_ZOOM} from '../public/canvas-zoom.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-zoom-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-zoom-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser,checks=0;const errors=[];
const ok=(value,message)=>{assert.ok(value,message);checks++;};
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Zoom studio']);const config=await loadConfig(file);
 await mkdir(path.join(root,'boards/assets'),{recursive:true});
 await writeFile(path.join(root,'boards/assets/design.html'),'<!doctype html><title>Design</title><body style="margin:0;height:1600px;font:24px system-ui;background:linear-gradient(#dfe6d2,#f3eee2)"><h1>Woodland map</h1><p>Small print worth a closer look.</p></body>');
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'studio',title:'Zoom studio'});
 const design=(await op('createItem',{boardId:'studio',item:{title:'Woodland map',content:{kind:'html',resource:{rootId:'assets',path:'design.html'}}},placement:{x:0,y:0,width:720,height:560,presentation:{mode:'panel'}}})).placementIds[0];
 await op('createItem',{boardId:'studio',item:{title:'A loose thought',content:{kind:'note',text:'Keep it quiet.'}},placement:{x:800,y:0,width:320,height:260}});
 await op('createBoard',{id:'tiny',title:'One small card'});
 await op('createItem',{boardId:'tiny',item:{title:'Lonely idea'},placement:{x:0,y:0,width:240,height:120}});
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:900},colorScheme:'light'});page.on('pageerror',e=>errors.push(e.message));
 const cdp=await page.context().newCDPSession(page);
 const zoom=()=>page.evaluate(()=>new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a);
 const pageScale=()=>page.evaluate(()=>visualViewport.scale);
 const setZoom=percent=>page.locator('#zoom-slider').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},sliderFromZoom(percent/100));
 const open=async id=>{await page.goto(base+`/boards/${id}/`);await page.locator('.workspace-card').first().waitFor();
  if(await page.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.keyboard.press('Escape');}};
 // Fit never magnifies a small board past 125%, even though zoom itself now goes much further.
 await open('tiny');await page.locator('#fit').click();
 ok(Math.abs(await zoom()-FIT_MAX_ZOOM)<1e-6,`Fit board stays at 125% for one small card: ${await zoom()}`);
 await open('studio');await page.locator('#fit').click();
 const card=page.locator(`[data-placement="${design}"]`);
 const frame=card.locator('iframe');await frame.waitFor({state:'attached'});
 await page.waitForFunction(id=>document.querySelector(`[data-placement="${id}"] iframe`)?.contentDocument?.readyState==='complete',design);
 // Count any wheel or gesture event that reaches the preview's own page.
 await frame.evaluate(el=>{const doc=el.contentDocument;doc.defaultView.tinkaZoomEvents=0;for(const type of ['wheel','gesturestart','gesturechange'])doc.addEventListener(type,()=>doc.defaultView.tinkaZoomEvents++,{capture:true});});
 const center=async()=>{const box=await card.boundingBox();return {x:box.x+box.width/2,y:box.y+box.height/2};};
 // (a) The slider, Control-wheel and + reach past the old 125% ceiling.
 await setZoom(100);await page.mouse.move(...Object.values(await center()));
 await page.keyboard.down('Control');for(let i=0;i<4;i++)await page.mouse.wheel(0,-100);await page.keyboard.up('Control');
 ok(await zoom()>2,`Control-wheel over the item zooms the board past 125%: ${await zoom()}`);
 await page.keyboard.down('Control');for(let i=0;i<20;i++)await page.mouse.wheel(0,-100);await page.keyboard.up('Control');
 ok(Math.abs(await zoom()-MAX_ZOOM)<1e-6,`Control-wheel stops at the new ${MAX_ZOOM * 100}% limit: ${await zoom()}`);
 await page.keyboard.down('Control');await page.mouse.wheel(0,100);await page.keyboard.up('Control');
 ok(await zoom()<MAX_ZOOM,'Zooming back out from the limit responds at once');
 await setZoom(125);await page.locator('#viewport').focus();await page.keyboard.press('+');
 ok(await zoom()>1.25,`+ zooms past 125%: ${await zoom()}`);
 await page.locator('#zoom-plus').click();ok(await zoom()>1.6,'The + button continues past 125%');
 await setZoom(1000);ok(Math.abs(await zoom()-MAX_ZOOM)<1e-6,'Slider reaches 1000%');
 assert.equal(await page.locator('#zoom-slider').getAttribute('aria-valuetext'),'1000 percent');checks++;
 await setZoom(2);ok(Math.abs(await zoom()-MIN_ZOOM)<1e-6,'Slider reaches 2%');
 // Tile chrome keeps its screen size at high zoom (the counter-scale is no longer floored at 0.8).
 await setZoom(100);await page.mouse.move(...Object.values(await center()));const toolbar=card.locator('.workspace-tile-toolbar');
 await page.waitForFunction(id=>getComputedStyle(document.querySelector(`[data-placement="${id}"] .workspace-tile-toolbar`)).opacity==='1',design);
 const bar100=(await toolbar.boundingBox()).width;
 await setZoom(400);await page.mouse.move(...Object.values(await center()));await page.mouse.move((await center()).x+3,(await center()).y);await page.waitForTimeout(300);
 const bar400=(await toolbar.boundingBox())?.width;
 ok(bar400&&Math.abs(bar400/bar100-1)<.15,`Tile toolbar keeps its size at 400%: ${bar100} → ${bar400}`);
 // After a zoom settles, the plane's will-change hint returns (it is dropped for two frames to redraw sharp).
 await page.waitForTimeout(400);ok(await page.locator('#plane').evaluate(el=>el.style.willChange===''&&getComputedStyle(el).willChange==='transform'),'Panning hint restored after the sharp redraw');
 await page.screenshot({path:path.join(evidence,'zoom-400-design.png')});
 // (b) A Chromium trackpad pinch over the item follows the fingers and zooms the board, not the page or the preview.
 await setZoom(100);let p=await center();
 await cdp.send('Input.synthesizePinchGesture',{x:Math.round(p.x),y:Math.round(p.y),scaleFactor:3,relativeSpeed:800,gestureSourceType:'mouse'});
 await page.waitForTimeout(150);
 ok(Math.abs(await zoom()/3-1)<.05,`Pinch ×3 over the item zooms the board ×3: ${await zoom()}`);
 ok(await pageScale()===1,'The page itself is not pinch-zoomed');
 // A pinch over the floating header zooms the board too, instead of magnifying the page.
 await setZoom(100);
 await cdp.send('Input.synthesizePinchGesture',{x:400,y:30,scaleFactor:1.5,relativeSpeed:800,gestureSourceType:'mouse'});await page.waitForTimeout(150);
 ok(await zoom()>1.4&&await pageScale()===1,`Pinch over the header zooms the board, not the page: ${await zoom()} / ${await pageScale()}`);
 // Safari gesture events from over the item zoom by ratio, so reversing at a limit responds immediately.
 await setZoom(100);p=await center();
 await card.locator('.workspace-preview-launch').evaluate((el,[x,y])=>{const send=(type,scale)=>el.dispatchEvent(Object.assign(new Event(type,{bubbles:true,cancelable:true}),{scale,clientX:x,clientY:y}));send('gesturestart',1);send('gesturechange',3);},[p.x,p.y]);
 ok(Math.abs(await zoom()-3)<1e-6,`Safari gesture over the item zooms the board: ${await zoom()}`);
 await setZoom(800);
 await card.locator('.workspace-preview-launch').evaluate((el,[x,y])=>{const send=(type,scale)=>el.dispatchEvent(Object.assign(new Event(type,{bubbles:true,cancelable:true}),{scale,clientX:x,clientY:y}));send('gesturestart',1);send('gesturechange',4);send('gesturechange',2);},[p.x,p.y]);
 ok(Math.abs(await zoom()-5)<1e-6,`A pinch past the limit zooms out as soon as it reverses: ${await zoom()}`);
 assert.equal(await frame.evaluate(el=>el.contentWindow.tinkaZoomEvents),0,'The item preview never receives the pinch');checks++;
 assert.deepEqual(errors,[]);checks++;
 console.log(`Zoom browser checks passed: ${checks} assertions. Evidence: ${evidence}`);
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
