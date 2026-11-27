// An opened HTML Tinka fills the window below the header by default, at 100%, so the page
// lays out at the window's real size as Open standalone shows it. Zoom there is the browser's
// ⌘+ / ⌘−: the page lays out again at the window over the zoom, reflows and scrolls to every
// edge. Fit gives the saved-size surface; Fill returns at 100% in one click. Images and documents keep their
// view. Covers graph and legacy items, file versions, stepping, the Inspector, notes and a
// few window sizes. External disposable fixtures only; screenshots go to the evidence folder.
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
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-reader-fill-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-reader-fill-evidence-'));
await mkdir(evidence,{recursive:true});
function png(width,height){
 const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
 const crc=b=>{let c=0xffffffff;for(const x of b)c=table[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const length=Buffer.alloc(4),sum=Buffer.alloc(4),body=Buffer.concat([Buffer.from(type),data]);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([length,body,sum]);};
 const h=Buffer.alloc(13);h.writeUInt32BE(width,0);h.writeUInt32BE(height,4);h[8]=8;h[9]=2;
 const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++)row.set([60,120+x%90,95],1+x*3);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}
// A responsive page that shows the size it was laid out at.
const page_=title=>`<!doctype html><meta charset="utf-8"><style>html,body{margin:0}main{box-sizing:border-box;min-height:100vh;padding:48px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));align-content:start;gap:20px;background:#eef1e6;color:#28311f;font:22px system-ui}h1{grid-column:1/-1;margin:0;font-size:40px}section{min-height:140px;padding:20px;border-radius:12px;background:#d9e4cd}</style><main><h1>${title}</h1><p id="size" style="grid-column:1/-1;margin:0"></p>${Array.from({length:8},(_,i)=>`<section>Panel ${i+1}</section>`).join('')}</main><script>const s=()=>document.getElementById('size').textContent='Laid out at '+innerWidth+' × '+innerHeight;s();addEventListener('resize',s)</script>`;
let servers=[],browser,checks=0;const errors=[];
const ok=(v,m)=>{assert.ok(v,m);checks++;};
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
try{
 // Schema 2: a page with the default saved viewport, a file-version stack, an image and a document.
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Fill studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 await writeFile(path.join(assets,'page.html'),page_('Fill page'));
 await writeFile(path.join(assets,'opening-v01.html'),page_('Opening, first'));
 await writeFile(path.join(assets,'opening-v02.html'),page_('Opening, second'));
 await writeFile(path.join(assets,'sheet.png'),png(800,500));
 await writeFile(path.join(assets,'notes.md'),'# A document\n\nIt keeps its own responsive view.');
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'fill',title:'Fill board'});
 const content=(kind,p)=>({kind,resource:{rootId:'assets',path:p}});
 const pageItem=await op('createItem',{boardId:'fill',item:{title:'Fill page',content:content('html','page.html')},placement:{x:0,y:0}});
 await op('createItem',{boardId:'fill',item:{title:'Opening',content:content('html','opening-v01.html')},placement:{x:800,y:0}});
 await op('createItem',{boardId:'fill',item:{title:'Sheet',content:content('image','sheet.png')},placement:{x:1600,y:0}});
 await op('createItem',{boardId:'fill',item:{title:'Notes',content:content('markdown','notes.md')},placement:{x:2400,y:0}});
 const before=await getBoardSnapshot(config,'fill');
 // Legacy: an unmigrated board folder whose concept opens from its round/concept hash.
 const legacyFile=path.join(root,'legacy','config.json'),legacyBoards=path.join(root,'legacy','boards');
 await main(['init','--config',legacyFile,'--boards',legacyBoards,'--label','Legacy fill']);await main(['board','create','droids','--config',legacyFile,'--title','Droids']);
 const legacyDir=path.join(legacyBoards,'droids');await writeFile(path.join(legacyDir,'pick.html'),page_('Legacy pick'));
 await writeFile(path.join(legacyDir,'rounds.json'),JSON.stringify({rounds:[{id:'12-droids',number:'12',title:'Droids',concepts:[{id:'pick',number:'01',name:'Pick',path:'pick.html'}]}],revisions:{}}));
 await main(['status','--config',legacyFile,'--board','droids','12-droids/pick','ready']);
 const server=await listen(config,{port:0});servers.push(server);const base=`http://127.0.0.1:${server.address().port}`;
 const legacyServer=await listen(await loadConfig(legacyFile),{port:0});servers.push(legacyServer);const legacyBase=`http://127.0.0.1:${legacyServer.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await (await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'})).newPage();
 page.on('pageerror',e=>errors.push(e.message));
 const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const plane=()=>page.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('#reader-plane')).transform);return {zoom:m.a,x:m.e,y:m.f};});
 const size=()=>page.locator('#reader-window').evaluate(e=>[e.offsetWidth,e.offsetHeight]);
 const stageSize=async()=>{const b=await page.locator('#reader-stage').boundingBox();return [Math.round(b.width),Math.round(b.height)];};
 const mode=()=>page.locator('#reader-window').getAttribute('data-size');
 const inner=()=>page.frameLocator('#active-reader').frameLocator('iframe');
 const laidOut=()=>inner().locator('body').evaluate(()=>[innerWidth,innerHeight]);
 const filled=async(message)=>{await frames();const stage=await stageSize();eq([await mode(),await size(),await plane()],['fill',stage,{zoom:1,x:0,y:0}],message);return stage;};
 const pressed=async()=>[await page.locator('#reader-fill').getAttribute('aria-pressed'),await page.locator('#reader-fill-item').getAttribute('aria-pressed')];
 await page.goto(`${base}/boards/fill/#items/${pageItem.placementIds[0]}`,{waitUntil:'load'});await page.locator('#reader-dialog[open]').waitFor();
 await inner().locator('h1').filter({hasText:'Fill page'}).waitFor();

 // (1) Fill by default: the whole stage below the header, at 100%, and the page lays out at that size.
 const stage=await filled('An HTML Tinka opens filling the window below the header');
 eq(await laidOut(),stage,'The page sees the window\'s real width and height');
 eq(await pressed(),['true','true'],'Fill is on in the pill and in the % menu');
 ok(await page.locator('#reader-fill').isVisible()&&await page.locator('#reader-fit').isVisible(),'Fill sits beside Fit in the pill');
 const fitLabel=()=>page.locator('#reader-fit .fit-label').textContent();
 eq(await fitLabel(),'Fit width','A page offers Fit width');
 eq(await page.locator('#reader-zoom-toggle').textContent(),'100%','The readout says 100%');
 await page.screenshot({path:path.join(evidence,'reader-fill-1920.png')});

 // (2) One click on Fit gives the 1.4 saved-size surface (1000 × 720 when unspecified); one click on Fill returns.
 await page.locator('#reader-fit').click();await frames();
 eq([await mode(),await size(),await plane()],['fit',[1000,720],{zoom:1,x:Math.round((stage[0]-1000)/2),y:Math.round((stage[1]-720)/2)}],'Fit shows the saved viewport, centered at 100%');
 eq(await laidOut(),[1000,720],'At the saved size the page lays out at 1000 × 720');
 eq(await pressed(),['false','false'],'Fill is off at the saved size');
 await page.screenshot({path:path.join(evidence,'reader-fit-1920.png')});
 await page.locator('#reader-fill').click();await filled('Fill returns in one click');
 // Zoom on the filled page is ⌘+ / ⌘−: it stays filled, lays out at the window over the zoom and covers the window.
 await page.locator('#reader-stage').focus();await page.keyboard.press('=');await page.keyboard.press('=');await frames();
 const zoomedSize=[Math.round(stage[0]/1.5625),Math.round(stage[1]/1.5625)];
 eq([await mode(),await size(),await plane()],['fill',zoomedSize,{zoom:1.5625,x:0,y:0}],'Zooming in keeps Fill and lays the page out at the window over 156%');
 eq(await laidOut(),zoomedSize,'The page itself sees the smaller viewport, so its responsive CSS applies');
 eq(await page.locator('#reader-zoom-toggle').textContent(),'156%','The readout follows the zoom');
 const covered=await page.locator('#reader-window').boundingBox();
 ok(Math.abs(covered.width-stage[0])<=2&&Math.abs(covered.height-stage[1])<=2,`The zoomed page still covers the window from its top left: ${covered.width} × ${covered.height}`);
 await page.screenshot({path:path.join(evidence,'reader-fill-zoomed-1920.png')});
 await page.keyboard.press('Shift+Digit0');await filled('Actual size (⇧0) returns the filled page to 100%');
 await page.keyboard.press('-');await frames();
 eq([await mode(),await size()],['fill',[Math.round(stage[0]/.8),Math.round(stage[1]/.8)]],'Zooming out gives the page a wider layout, like ⌘−');
 await page.locator('#reader-fill').click();await filled('Fill returns to 100%');
 // Fill the window, beside Fit this Tinka in the % menu, works too; Window keeps its four sizes.
 await page.locator('#reader-fit').click();await page.locator('#reader-zoom-toggle').click();
 eq(await page.locator('#size-menu [data-size]:visible').evaluateAll(b=>b.map(x=>x.dataset.size)),['fit','compact','standard','wide'],'Window keeps its 1.4 choices');
 await page.locator('#reader-zoom-menu').screenshot({path:path.join(evidence,'reader-fill-menu.png')});
 await page.locator('#reader-fill-item').click();ok(await page.locator('#reader-zoom-menu').isHidden(),'Choosing Fill closes the menu, like Fit this Tinka');await filled('% menu → Fill the window');

 // (3) It follows the Inspector, notes and window size.
 await page.locator('#reader-info-toggle').click();await page.locator('#reader-info').waitFor({state:'visible'});await frames();
 const info=await page.locator('#reader-info').boundingBox(),win=await page.locator('#reader-window').boundingBox();
 ok(win.x+win.width<=info.x-7&&win.width>1200,`The filled page stops short of the open Inspector: ${win.width} wide, Inspector at ${info.x}`);
 eq((await laidOut())[0],Math.round(win.width),'The page lays out beside the Inspector');
 await page.locator('#reader-info-toggle').click();await page.locator('#reader-info').waitFor({state:'hidden'});await filled('Closing the Inspector gives the width back');
 await page.locator('#notes-toggle').click();await page.locator('#notes-panel').waitFor({state:'visible'});
 const withNotes=await filled('Notes beside the canvas narrow the filled page');ok(withNotes[0]<stage[0]-300,'Notes take their room');eq((await laidOut())[0],withNotes[0],'The page reflows for notes');
 await page.locator('#notes-toggle').click();await page.locator('#notes-panel').waitFor({state:'hidden'});await filled('Closing notes widens it again');
 const sizes={};
 for(const [width,height] of [[1024,768],[390,844]]){
  await page.setViewportSize({width,height});const at=await filled(`Fill follows a ${width}-wide window`);
  eq(await laidOut(),at,`The page lays out at ${width}-wide's real size`);sizes[width]=at;
  for(const selector of ['.reader-header','.reader-footer'])ok(await page.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth),`${selector} fits at ${width}`);
  await page.screenshot({path:path.join(evidence,`reader-fill-${width}.png`)});
 }
 await page.setViewportSize({width:1920,height:1080});sizes[1920]=await filled('Back to 1920');

 // (4) Stepping and file versions: every HTML Tinka and version opens filled; images and documents keep their view.
 await page.locator('#reader-fit').click();
 await page.locator('#reader-next').click();await inner().locator('h1').filter({hasText:'Opening, second'}).waitFor();
 const versioned=await filled('The next HTML Tinka fills the window even after Fit on the last');
 await page.locator('#reader-fit').click();await page.locator('#reader-older-file').click();await inner().locator('h1').filter({hasText:'Opening, first'}).waitFor();
 await filled('An older file version opens filled');eq(await laidOut(),versioned,'The version lays out at the window size');
 await page.locator('#reader-next').click();await page.waitForFunction(()=>document.querySelector('#reader-window').offsetWidth===800);
 eq([await mode(),await size(),await page.locator('#reader-fill').isHidden(),await page.locator('#reader-fill-item').isHidden()],['fit',[800,500],true,true],'An image keeps its natural size and offers no Fill');
 eq(await fitLabel(),'Fit page','An image offers Fit page');
 await page.locator('#reader-next').click();await page.waitForFunction(()=>document.querySelector('#reader-name').textContent==='Notes');await frames();
 eq([await mode(),await size(),await page.locator('#reader-fill').isHidden()],['fit',await stageSize(),true],'A document keeps its responsive Fit view and offers no Fill');
 eq(await fitLabel(),'Fit width','A document offers Fit width');
 await page.locator('#reader-previous').click();await page.locator('#reader-previous').click();await inner().locator('h1').filter({hasText:'Opening'}).waitFor();
 await filled('Stepping back to HTML fills again');
 // A chosen Window size carries over while stepping, as before.
 await page.locator('#reader-zoom-toggle').click();await page.locator('#size-menu [data-size="compact"]').click();await page.keyboard.press('Escape');
 await page.locator('#reader-previous').click();await inner().locator('h1').filter({hasText:'Fill page'}).waitFor();
 eq([await mode(),await size()],['compact',[440,620]],'Compact carries over to the next Tinka');
 eq(await getBoardSnapshot(config,'fill'),before,'View changes write no board or item metadata');

 // (5) Legacy concepts open from their round/concept hash filled too.
 await page.goto(`${legacyBase}/boards/droids/#12-droids/pick`,{waitUntil:'load'});await page.locator('#reader-dialog[open]').waitFor();
 await page.frameLocator('#active-reader').locator('h1').filter({hasText:'Legacy pick'}).waitFor();
 const legacy=await filled('A legacy concept fills the window');
 eq(await page.frameLocator('#active-reader').locator('body').evaluate(()=>[innerWidth,innerHeight]),legacy,'The legacy page lays out at the window size');
 await page.screenshot({path:path.join(evidence,'reader-fill-legacy-1920.png')});
 await page.locator('#reader-fit').click();await frames();eq([await mode(),await size()],['fit',[1000,720]],'Its saved size is the 1000 × 720 default');
 eq(errors,[],'No page errors');
 await writeFile(path.join(evidence,'reader-fill.json'),JSON.stringify({checks,sizes,evidence},null,2));
 console.log(`Reader fill browser checks passed: ${checks}; evidence ${evidence}`);
}finally{await browser?.close();for(const server of servers)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
