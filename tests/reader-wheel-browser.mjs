// Headless check: in an opened Tinka, plain scrolling that the content has no use for (an
// image, zoomed in until it fills the canvas) pans Tinka's canvas, as it does over the
// background and the window's edge; Control-scroll still zooms; a long Markdown document and
// a long HTML page still scroll themselves without moving the canvas. External fixtures only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
// A plain PNG of the given size, written without any image dependency.
function png(width,height){
 const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
 const crc=bytes=>{let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const length=Buffer.alloc(4),sum=Buffer.alloc(4),body=Buffer.concat([Buffer.from(type),data]);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([length,body,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++)row.set([60+x%180,140,90],1+x*3);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-reader-wheel-'));
let server,browser,checks=0;const errors=[];
const ok=(value,message)=>{assert.ok(value,message);checks++;};
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Wheel studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 await writeFile(path.join(assets,'sheet.png'),png(1600,1260));
 await writeFile(path.join(assets,'long.md'),'# A long document\n\n'+Array.from({length:160},(_,i)=>`Paragraph ${i+1}, long enough to scroll.`).join('\n\n'));
 await writeFile(path.join(assets,'long.html'),'<!doctype html><meta charset="utf-8"><body style="margin:0;font:20px system-ui">'+Array.from({length:120},(_,i)=>`<p>Line ${i+1}</p>`).join('')+'</body>');
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'wheel',title:'Wheel'});
 const res=p=>({rootId:'assets',path:p});
 const image=await op('createItem',{boardId:'wheel',item:{title:'Contact sheet',content:{kind:'image',resource:res('sheet.png')}},placement:{x:0,y:0,width:1550,height:1224,presentation:{mode:'panel'}}});
 const doc=await op('createItem',{boardId:'wheel',item:{title:'Long document',content:{kind:'markdown',resource:res('long.md')}},placement:{x:1600,y:0,width:720,height:560,presentation:{mode:'panel'}}});
 const page_=await op('createItem',{boardId:'wheel',item:{title:'Long page',content:{kind:'html',resource:res('long.html')}},placement:{x:2400,y:0,width:720,height:560,presentation:{mode:'panel'}}});
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await (await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})).newPage();
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const plane=()=>page.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.getElementById('reader-plane')).transform);return {zoom:m.a,x:Math.round(m.e),y:Math.round(m.f)};});
 const inner=`document.querySelector('#active-reader')?.contentDocument?.querySelector('iframe')?.contentDocument`;
 const open=async(placementId,ready)=>{await page.goto(`${base}/boards/wheel/#items/${placementId}`,{waitUntil:'load'});await page.locator('#reader-dialog[open]').waitFor();await page.waitForFunction(ready,null,{timeout:10000});await page.waitForTimeout(150);};
 const wheel=async(dx,dy,modifier)=>{if(modifier)await page.keyboard.down(modifier);await page.mouse.wheel(dx,dy);if(modifier)await page.keyboard.up(modifier);await page.waitForTimeout(80);};

 // (1) An image zoomed in past 300%: wheel over the image pans; Shift-wheel pans sideways.
 await open(image.placementIds[0],new Function(`return ${inner}?.querySelector('.image-stage img')?.complete`));
 const stage=await page.locator('#reader-stage').boundingBox(),cx=stage.x+stage.width/2,cy=stage.y+stage.height/2;
 await page.mouse.move(cx,cy);
 for(let i=0;i<40&&(await plane()).zoom<3.1;i++)await wheel(0,-40,'Control');
 const zoomed=await plane();ok(zoomed.zoom>=3.1,`Control-scroll over the image zooms in: ${zoomed.zoom}`);
 ok(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.id,[cx,cy])==='active-reader','The pointer is over the content, not the background');
 await wheel(0,240);let now=await plane();
 ok(now.y<zoomed.y-200&&now.x===zoomed.x&&now.zoom===zoomed.zoom,`Wheel over the image pans down: ${zoomed.y} → ${now.y}`);
 await wheel(0,240,'Shift');const side=await plane();
 ok(side.x<now.x-200&&side.y===now.y,`Shift-wheel over the image pans sideways: ${now.x} → ${side.x}`);
 await wheel(0,-240);ok((await plane()).y>side.y+200,'Wheel back up pans back');
 // (2) Control-scroll over the image still zooms.
 const before=await plane();await wheel(0,60,'Control');ok((await plane()).zoom<before.zoom*.9,'Control-scroll still zooms out over the image');
 // (3) Fit now frames the resource without card padding; wheel cannot pan it beyond bounds.
 await page.locator('#reader-fit').click();await page.waitForTimeout(60);
 const fitted=await plane();await page.mouse.move(cx,cy);await wheel(0,120);
 assert.deepEqual(await plane(),fitted,'A fitted image remains centered at its bounds');checks++;
 ok(await page.locator('#reader-window').evaluate(e=>getComputedStyle(e).paddingBottom)==='0px','The resource surface has no nested card padding');

 // (4) A long Markdown document scrolls itself; the canvas stays still.
 await open(doc.placementIds[0],new Function(`return ${inner}?.querySelector('.markdown p')`));
 const scrolled=selector=>page.evaluate(new Function(`const d=${inner};return d.querySelector('${selector}')?.scrollTop??d.scrollingElement.scrollTop;`));
 const docBox=await page.locator('#reader-window').boundingBox();await page.mouse.move(docBox.x+docBox.width/2,docBox.y+docBox.height/2);
 const docPlane=await plane();await wheel(0,300);
 ok(await scrolled('#media-content')>=250,'Wheel scrolls the long document');
 assert.deepEqual(await plane(),docPlane,'The document scrolling leaves the canvas still');checks++;
 await page.keyboard.down('Control');await page.mouse.wheel(0,-60);await page.keyboard.up('Control');await page.waitForTimeout(60);
 ok((await plane()).zoom>docPlane.zoom,'Control-scroll over the document zooms');

 // (5) A long HTML page scrolls itself; the canvas stays still.
 await open(page_.placementIds[0],new Function(`return ${inner}?.querySelector('p')`));
 const pageBox=await page.locator('#reader-window').boundingBox();await page.mouse.move(pageBox.x+pageBox.width/2,pageBox.y+pageBox.height/2);
 const htmlPlane=await plane();await wheel(0,300);
 ok(await scrolled('#no-such-element')>=250,'Wheel scrolls the long page');
 assert.deepEqual(await plane(),htmlPlane,'The page scrolling leaves the canvas still');checks++;

 assert.deepEqual(errors,[],'No page errors');checks++;
 console.log(`Reader wheel browser checks passed: ${checks}`);
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
