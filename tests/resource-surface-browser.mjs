// Approved resource reader surface: real native chrome, HTML filling the window by
// default, the saved visual viewport one Fit away (Fit width for HTML, Fit page for
// images), image dimensions, version refit, interactive/window HTML and stale load cleanup.
// All resources, metadata and screenshots remain in external disposable fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-resource-surface-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-resource-surface-evidence-'));
await mkdir(evidence,{recursive:true});
// Plain PNG, independent of image tooling.
function png(width,height){
 const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
 const crc=b=>{let c=0xffffffff;for(const x of b)c=table[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const length=Buffer.alloc(4),sum=Buffer.alloc(4),body=Buffer.concat([Buffer.from(type),data]);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([length,body,sum]);};
 const h=Buffer.alloc(13);h.writeUInt32BE(width,0);h.writeUInt32BE(height,4);h[8]=8;h[9]=2;
 const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++)row.set([45,130+x%100,85],1+x*3);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}
let server,browser,checks=0;const errors=[];
const ok=(v,m)=>{assert.ok(v,m);checks++;};
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Resource studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 const html=label=>`<!doctype html><meta charset="utf-8"><style>html,body{margin:0}body{background:#faf7ee;color:#2d3529;font:24px system-ui}.chart{box-sizing:border-box;width:2300px;height:1780px;padding:32px;display:grid;grid-template-columns:repeat(5,1fr);gap:20px}.cell{padding:24px;background:#dce8d4}input,button{font:inherit}</style><div class="chart"><div class="cell"><h1>${label}</h1><button id="counter">Count 0</button><input id="field" aria-label="Chart note" value="Keep edits"><script>let n=0;document.querySelector('#counter').onclick=e=>e.target.textContent='Count '+(++n)</script></div>${Array.from({length:19},(_,i)=>`<div class="cell">Reading ${i+1}</div>`).join('')}</div>`;
 await writeFile(path.join(assets,'chart-v01.html'),html('Earlier chart'));
 await writeFile(path.join(assets,'chart-v02.html'),html('Current chart'));
 await writeFile(path.join(assets,'single.html'),'<meta charset="utf-8"><style>body{margin:0}main{width:100%;background:#dce8d4}</style><main><input aria-label="Responsive note" value="Draft"></main><div class="image-stage"><img src="sheet.png" width="10" height="10"></div>');
 await writeFile(path.join(assets,'sheet.png'),png(1600,1260));
 await writeFile(path.join(assets,'tall.html'),'<!doctype html><meta charset="utf-8"><style>html,body{margin:0}main{box-sizing:border-box;height:6000px;padding:32px;background:linear-gradient(#dce8d4,#faf7ee)}</style><main><h1>Tall page</h1></main>');
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'surfaces',title:'Resource surfaces'});
 const content=(kind,p)=>({kind,resource:{rootId:'assets',path:p}});
 const chart=await op('createItem',{boardId:'surfaces',item:{title:'Chart',content:content('html','chart-v01.html')},placement:{x:0,y:0,width:2362,height:1868,presentation:{mode:'panel',viewport:{width:2360,height:1822}}}});
 const image=await op('createItem',{boardId:'surfaces',item:{title:'Image',content:content('image','sheet.png')},placement:{x:2500,y:0}});
 const single=await op('createItem',{boardId:'surfaces',item:{title:'Responsive',content:content('html','single.html')},placement:{x:3500,y:0}});
 const tall=await op('createItem',{boardId:'surfaces',item:{title:'Tall page',content:content('html','tall.html')},placement:{x:4500,y:0,width:388,height:1700,presentation:{mode:'panel',viewport:{width:1440,height:6000}}}});
 const before=await getBoardSnapshot(config,'surfaces');
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await (await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'})).newPage();page.on('pageerror',e=>errors.push(e.message));
 const plane=()=>page.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('#reader-plane')).transform);return {zoom:m.a,x:m.e,y:m.f};});
 const size=()=>page.locator('#reader-window').evaluate(e=>[e.offsetWidth,e.offsetHeight]);
 const inner=()=>page.frameLocator('#active-reader').frameLocator('iframe');
 const fitLabel=()=>page.locator('#reader-fit .fit-label').textContent();
 const stageSize=async()=>{const b=await page.locator('#reader-stage').boundingBox();return [Math.round(b.width),Math.round(b.height)];};
 const open=async p=>{await page.goto(`${base}/boards/surfaces/#items/${p}`,{waitUntil:'load'});await page.locator('#reader-dialog[open]').waitFor();};
 await open(chart.placementIds[0]);await inner().locator('h1').filter({hasText:'Current chart'}).waitFor();
 const stage=await page.locator('#reader-stage').boundingBox(),filled=[Math.round(stage.width),Math.round(stage.height)];
 // HTML opens filling the window below the header, at 100%, laid out at that real size.
 eq(await size(),filled,'HTML fills the stage by default');eq(await plane(),{zoom:1,x:0,y:0},'Fill is 100% at the stage origin');
 eq(await page.locator('#reader-fill').getAttribute('aria-pressed'),'true','Fill is on in the pill');
 eq(await inner().locator('body').evaluate(()=>[innerWidth,innerHeight]),filled,'The page sees the window\'s real size');
 eq(await page.locator('#reader-window').evaluate(e=>{const s=getComputedStyle(e);return [s.borderTopWidth,s.paddingBottom,s.boxShadow,s.resize];}),['0px','0px','none','none'],'No outer card or resize control in Fill');
 // The wide chart scrolls itself natively in Fill; the canvas stays put.
 await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.mouse.wheel(0,300);await page.waitForTimeout(120);
 ok(await inner().locator('body').evaluate(()=>scrollY)>0,'A filled page scrolls natively');eq(await plane(),{zoom:1,x:0,y:0},'Scrolling a filled page never pans the canvas');
 await inner().locator('body').evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:path.join(evidence,'resource-chart-fill-1440.png')});
 // One click on Fit gives the 1.4 saved-size surface, fitted to its width: HTML has no chart signal.
 eq([await fitLabel(),await page.locator('#reader-fit').getAttribute('aria-label')],['Fit width','Fit width'],'An HTML Tinka offers Fit width');
 await page.locator('#reader-fit').click();
 eq(await size(),[2360,1822],'Fit shows the saved authored viewport as the resource surface');
 eq(await page.locator('#reader-fill').getAttribute('aria-pressed'),'false','Fill is off at the saved size');
 const fit=await plane();
 ok(Math.abs(fit.zoom-Math.min(1,stage.width/2360))<.001&&fit.zoom>Math.min(stage.width/2360,stage.height/1822)+.05,`Fit width frames the chart's width, not its height: ${fit.zoom}`);
 eq([fit.x,fit.y],[0,0],'A chart taller than the view at that zoom starts at its top');
 await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.mouse.wheel(0,400);await page.waitForTimeout(80);
 ok((await plane()).y<0,'Plain wheel pans down to the rest of the chart');
 await page.locator('#reader-fit').click();eq(await plane(),fit,'Fit returns to the top of the width');
 for(const id of ['reader-header','reader-path','reader-stepper','reader-file-versions','reader-fit','reader-fill'])ok(await page.locator('#'+id).isVisible(),id+' remains native');
 eq(await page.locator('#reader-window').evaluate(e=>{const s=getComputedStyle(e);return [s.borderTopWidth,s.paddingBottom,s.boxShadow,s.resize];}),['0px','0px','none','none'],'No outer card or resize control in resource Fit');
 eq(await inner().locator('body').evaluate(e=>[document.scrollingElement.scrollWidth,innerHeight,document.scrollingElement.scrollHeight]),[2360,1822,1822],'Authored chart has no nested overflow');
 await inner().locator('#counter').click();eq(await inner().locator('#counter').textContent(),'Count 1','HTML remains interactive');
 await inner().locator('#field').fill('Still editing');
 await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.keyboard.down('Control');await page.mouse.wheel(0,-180);await page.keyboard.up('Control');await page.waitForTimeout(80);
 ok((await plane()).zoom>fit.zoom,'Pinch/control wheel magnifies actual resource');
 await page.mouse.wheel(0,300);await page.waitForTimeout(80);ok((await plane()).y<0,'Plain wheel pans chart rather than an inner viewport');
 eq(await inner().locator('#field').inputValue(),'Still editing','Zoom and pan retain live input');
 await page.locator('#reader-fit').click();eq(await plane(),fit,'Fit restores the exact fitted width');
 await page.locator('#reader-view-back').click();ok((await plane()).zoom>fit.zoom,'Back restores magnified resource');
 await page.locator('#reader-older-file').click();await inner().getByRole('heading',{name:'Earlier chart'}).waitFor();eq([await plane(),await size()],[{zoom:1,x:0,y:0},filled],'A version opens filled again');
 await page.locator('#reader-fit').click();eq(await plane(),fit,'Fit on another version frames the same saved viewport');
 await page.locator('#reader-newer-file').click();await inner().getByRole('heading',{name:'Current chart'}).waitFor();eq(await size(),filled,'Stepping versions returns to Fill');
 await page.locator('#reader-fit').click();await page.screenshot({path:path.join(evidence,'resource-chart-1440.png')});
 await page.locator('#notes-toggle').click();await page.locator('#notes-panel').waitFor({state:'visible'});await page.locator('#notes-toggle').click();
 await page.locator('#reader-info-toggle').click();await page.locator('#reader-info').waitFor({state:'visible'});ok(await page.locator('#reader-info').getByText('Where it lives',{exact:true}).isVisible(),'Native source and standalone route remains');await page.keyboard.press('Escape');
 await open(image.placementIds[0]);await page.waitForFunction(()=>document.querySelector('#reader-window').offsetWidth===1600);eq(await size(),[1600,1260],'Decoded image uses its natural dimensions');
 eq([await page.locator('#reader-window').getAttribute('data-size'),await page.locator('#reader-fill').isHidden()],['fit',true],'Images keep Fit and offer no Fill');
 eq(await fitLabel(),'Fit page','An image offers Fit page');
 const imageStage=await page.locator('#reader-stage').boundingBox(),imageFit=await plane();
 ok(Math.abs(imageFit.zoom-Math.min(1,imageStage.width/1600,imageStage.height/1260))<.001,`Fit page shows the whole image: ${imageFit.zoom}`);
 eq(await inner().locator('.image-stage').evaluate(e=>getComputedStyle(e).padding),'0px','Only own media image wrapper loses its padding');
 await page.screenshot({path:path.join(evidence,'resource-image-1440.png')});
 await open(single.placementIds[0]);await inner().locator('main').waitFor();ok(await page.locator('#reader-file-versions').isHidden(),'Unversioned resource has no version row');
 eq(await inner().locator('main').evaluate(e=>e.clientWidth),filled[0],'Responsive HTML lays out at the filled width');
 eq(await inner().locator('.image-stage img').evaluate(e=>getComputedStyle(e).width),'10px','Authored HTML resembling media markup is untouched');
 await page.locator('#reader-zoom-toggle').click();await page.locator('#size-menu [data-size=compact]').click();eq(await size(),[440,620],'Native Window mode still reflows HTML');
 eq(await inner().locator('main').evaluate(e=>e.clientWidth),440,'HTML sees selected viewport width');await page.keyboard.press('Escape');
 await inner().getByRole('textbox',{name:'Responsive note'}).click();await inner().getByRole('textbox',{name:'Responsive note'}).fill('Keep this draft');eq(await inner().getByRole('textbox',{name:'Responsive note'}).inputValue(),'Keep this draft','Real input retains typing before fit');await page.locator('#reader-fit').click();eq(await inner().getByRole('textbox',{name:'Responsive note'}).inputValue(),'Keep this draft','Window Fit does not reload content');
 await page.locator('#reader-zoom-toggle').click();eq(await page.locator('#size-menu [data-size=fit]').textContent(),'Saved size','The Window choice is named Saved size');eq(await page.locator('#reader-zoom-menu [data-reader-zoom=fit]').textContent(),'Fit widthF','The % menu names Fit width too');await page.locator('#size-menu [data-size=fit]').click();await page.keyboard.press('Escape');eq(await size(),[1000,720],'Window Saved size is the saved viewport (1000 × 720 unspecified)');
 await page.locator('#reader-fill').click();eq(await size(),await stageSize(),'Fill returns in one click');eq(await inner().getByRole('textbox',{name:'Responsive note'}).inputValue(),'Keep this draft','Fill does not reload content');
 // A delayed obsolete image cannot resize the current chart after navigating.
 let release;const held=new Promise(r=>release=r);let requested;const request=new Promise(r=>requested=r);
 await page.route('**/resources/assets/sheet.png',async route=>{requested();await held;await route.continue().catch(()=>{});});
 await page.goto(`${base}/boards/surfaces/#items/${image.placementIds[0]}`,{waitUntil:'domcontentloaded'});await page.locator('#reader-dialog[open]').waitFor();await request;await page.locator('#reader-next').click();await inner().locator('main').waitFor();release();await page.waitForTimeout(150);eq(await size(),await stageSize(),'The next HTML item fills the window');await page.locator('#reader-fit').click();eq(await size(),[1000,720],'Old image callbacks are disconnected on navigation');await page.unroute('**/resources/assets/sheet.png');
 // A tall page saved at 1440 × 6000 fits its width at 100% from the top, then pans down.
 await open(tall.placementIds[0]);await inner().locator('h1').filter({hasText:'Tall page'}).waitFor();
 await page.locator('#reader-fit').click();eq(await size(),[1440,6000],'The tall page shows at its saved viewport');
 const tallStage=await page.locator('#reader-stage').boundingBox(),tallFit=await plane();
 eq(tallFit,{zoom:Math.min(1,Math.round(tallStage.width)/1440),x:0,y:0},'A tall page reads at 100%, top-aligned, not 16% whole');
 await page.mouse.move(tallStage.x+tallStage.width/2,tallStage.y+tallStage.height/2);await page.mouse.wheel(0,600);await page.waitForTimeout(80);
 ok((await plane()).y<-300,'Scrolling over the tall page pans down it');
 await page.screenshot({path:path.join(evidence,'resource-tall-1440.png')});
 for(const width of [1920]){
  await page.setViewportSize({width,height:1080});await page.locator('#reader-fit').click();await page.waitForTimeout(60);
  const s=await page.locator('#reader-stage').boundingBox(),v=await plane();
  eq([v.zoom,v.y],[1,0],`At ${width} the tall page stays at 100% from its top`);ok(Math.abs(v.x-(s.width-1440)/2)<1,`At ${width} it is centered across`);
  await page.screenshot({path:path.join(evidence,`resource-tall-${width}.png`)});
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.setViewportSize({width:390,height:844});await open(chart.placementIds[0]);await inner().locator('h1').waitFor();
 const smallStage=await page.locator('#reader-stage').boundingBox();eq(await size(),[Math.round(smallStage.width),Math.round(smallStage.height)],'A phone-width page fills its window too');
 for(const selector of ['.reader-header','.reader-footer'])ok(await page.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth),selector+' fits at 390');
 await page.screenshot({path:path.join(evidence,'resource-chart-fill-390.png')});
 await page.locator('#reader-fit').click();await page.screenshot({path:path.join(evidence,'resource-chart-390.png')});const small=await plane();ok(small.zoom<.2&&Math.abs(small.zoom-smallStage.width/2360)<.001,'Narrow Fit width shows the authored chart\'s full width');
 ok(await page.locator('.reader-footer').evaluate(el=>el.scrollWidth<=el.clientWidth),'.reader-footer fits at 390 with Fit width');
 eq(await getBoardSnapshot(config,'surfaces'),before,'View changes never write board/item metadata');eq(errors,[],'No page errors');
 await writeFile(path.join(evidence,'resource-surface.json'),JSON.stringify({checks,fit,tallFit,small,evidence},null,2));console.log(`Resource surface browser checks passed: ${checks}; evidence ${evidence}`);
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
