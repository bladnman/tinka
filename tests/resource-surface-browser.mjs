// Approved resource reader surface: real native chrome, saved visual viewport,
// image dimensions, version refit, interactive/window HTML and stale load cleanup.
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
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'surfaces',title:'Resource surfaces'});
 const content=(kind,p)=>({kind,resource:{rootId:'assets',path:p}});
 const chart=await op('createItem',{boardId:'surfaces',item:{title:'Chart',content:content('html','chart-v01.html')},placement:{x:0,y:0,width:2362,height:1868,presentation:{mode:'panel',viewport:{width:2360,height:1822}}}});
 const image=await op('createItem',{boardId:'surfaces',item:{title:'Image',content:content('image','sheet.png')},placement:{x:2500,y:0}});
 const single=await op('createItem',{boardId:'surfaces',item:{title:'Responsive',content:content('html','single.html')},placement:{x:3500,y:0}});
 const before=await getBoardSnapshot(config,'surfaces');
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await (await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'})).newPage();page.on('pageerror',e=>errors.push(e.message));
 const plane=()=>page.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('#reader-plane')).transform);return {zoom:m.a,x:m.e,y:m.f};});
 const size=()=>page.locator('#reader-window').evaluate(e=>[e.offsetWidth,e.offsetHeight]);
 const inner=()=>page.frameLocator('#active-reader').frameLocator('iframe');
 const open=async p=>{await page.goto(`${base}/boards/surfaces/#items/${p}`,{waitUntil:'load'});await page.locator('#reader-dialog[open]').waitFor();};
 await open(chart.placementIds[0]);await inner().locator('h1').filter({hasText:'Current chart'}).waitFor();
 eq(await size(),[2360,1822],'Saved authored viewport is the complete resource surface');
 const stage=await page.locator('#reader-stage').boundingBox(),fit=await plane();
 ok(Math.abs(fit.zoom-Math.min(1,stage.width/2360,stage.height/1822))<.001,'Fit frames the complete chart');
 for(const id of ['reader-header','reader-path','reader-stepper','reader-file-versions','reader-fit'])ok(await page.locator('#'+id).isVisible(),id+' remains native');
 eq(await page.locator('#reader-window').evaluate(e=>{const s=getComputedStyle(e);return [s.borderTopWidth,s.paddingBottom,s.boxShadow,s.resize];}),['0px','0px','none','none'],'No outer card or resize control in resource Fit');
 eq(await inner().locator('body').evaluate(e=>[document.scrollingElement.scrollWidth,innerHeight,document.scrollingElement.scrollHeight]),[2360,1822,1822],'Authored chart has no nested overflow');
 await inner().locator('#counter').click();eq(await inner().locator('#counter').textContent(),'Count 1','HTML remains interactive');
 await inner().locator('#field').fill('Still editing');
 await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.keyboard.down('Control');await page.mouse.wheel(0,-180);await page.keyboard.up('Control');await page.waitForTimeout(80);
 ok((await plane()).zoom>fit.zoom,'Pinch/control wheel magnifies actual resource');
 await page.mouse.wheel(0,300);await page.waitForTimeout(80);ok((await plane()).y<0,'Plain wheel pans chart rather than an inner viewport');
 eq(await inner().locator('#field').inputValue(),'Still editing','Zoom and pan retain live input');
 await page.locator('#reader-fit').click();eq(await plane(),fit,'Fit restores exact full-resource view');
 await page.locator('#reader-view-back').click();ok((await plane()).zoom>fit.zoom,'Back restores magnified resource');
 await page.locator('#reader-older-file').click();await inner().getByRole('heading',{name:'Earlier chart'}).waitFor();eq(await plane(),fit,'Version navigation refits even equal-sized viewports');
 await page.locator('#reader-newer-file').click();await inner().getByRole('heading',{name:'Current chart'}).waitFor();
 await page.screenshot({path:path.join(evidence,'resource-chart-1440.png')});
 await page.locator('#notes-toggle').click();await page.locator('#notes-panel').waitFor({state:'visible'});await page.locator('#notes-toggle').click();
 await page.locator('#reader-info-toggle').click();await page.locator('#reader-info').waitFor({state:'visible'});ok(await page.locator('#reader-info').getByText('Where it lives',{exact:true}).isVisible(),'Native source and standalone route remains');await page.keyboard.press('Escape');
 await open(image.placementIds[0]);await page.waitForFunction(()=>document.querySelector('#reader-window').offsetWidth===1600);eq(await size(),[1600,1260],'Decoded image uses its natural dimensions');
 eq(await inner().locator('.image-stage').evaluate(e=>getComputedStyle(e).padding),'0px','Only own media image wrapper loses its padding');
 await page.screenshot({path:path.join(evidence,'resource-image-1440.png')});
 await open(single.placementIds[0]);await inner().locator('main').waitFor();ok(await page.locator('#reader-file-versions').isHidden(),'Unversioned resource has no version row');
 eq(await inner().locator('.image-stage img').evaluate(e=>getComputedStyle(e).width),'10px','Authored HTML resembling media markup is untouched');
 await page.locator('#reader-zoom-toggle').click();await page.locator('#size-menu [data-size=compact]').click();eq(await size(),[440,620],'Native Window mode still reflows HTML');
 eq(await inner().locator('main').evaluate(e=>e.clientWidth),440,'HTML sees selected viewport width');await page.keyboard.press('Escape');
 await inner().getByRole('textbox',{name:'Responsive note'}).click();await inner().getByRole('textbox',{name:'Responsive note'}).fill('Keep this draft');eq(await inner().getByRole('textbox',{name:'Responsive note'}).inputValue(),'Keep this draft','Real input retains typing before fit');await page.locator('#reader-fit').click();eq(await inner().getByRole('textbox',{name:'Responsive note'}).inputValue(),'Keep this draft','Window Fit does not reload content');
 await page.locator('#reader-zoom-toggle').click();await page.locator('#size-menu [data-size=fit]').click();await page.keyboard.press('Escape');
 // A delayed obsolete image cannot resize the current chart after navigating.
 let release;const held=new Promise(r=>release=r);let requested;const request=new Promise(r=>requested=r);
 await page.route('**/resources/assets/sheet.png',async route=>{requested();await held;await route.continue().catch(()=>{});});
 await page.goto(`${base}/boards/surfaces/#items/${image.placementIds[0]}`,{waitUntil:'domcontentloaded'});await page.locator('#reader-dialog[open]').waitFor();await request;await page.locator('#reader-next').click();await inner().locator('main').waitFor();release();await page.waitForTimeout(150);eq(await size(),[1000,720],'Old image callbacks are disconnected on navigation');await page.unroute('**/resources/assets/sheet.png');
 await page.setViewportSize({width:390,height:844});await open(chart.placementIds[0]);await inner().locator('h1').waitFor();await page.screenshot({path:path.join(evidence,'resource-chart-390.png')});
 const smallStage=await page.locator('#reader-stage').boundingBox(),small=await plane();ok(small.zoom<.2&&Math.abs(small.zoom-Math.min(smallStage.width/2360,smallStage.height/1822))<.001,'Narrow Fit retains complete authored chart');
 eq(await getBoardSnapshot(config,'surfaces'),before,'View changes never write board/item metadata');eq(errors,[],'No page errors');
 await writeFile(path.join(evidence,'resource-surface.json'),JSON.stringify({checks,fit,small,evidence},null,2));console.log(`Resource surface browser checks passed: ${checks}; evidence ${evidence}`);
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
