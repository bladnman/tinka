import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-cover-evidence-'));
await mkdir(evidence,{recursive:true});
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const server=createServer(async(req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname;
 if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/app/workspace.css"><link rel="stylesheet" href="/app/appearance.css"><style>body{margin:0;padding:32px;background:var(--canvas,#edf0e6)}#host{position:relative;width:360px;height:240px}</style><div id="host"></div>');return;}
 if(name==='/frames/items/tall/cover.html'||name==='/api/items/tall/cover-thumbnail'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><script>addEventListener("load",function(){parent.postMessage({tinkaCoverReady:"tall"},"*")})</script><style>html,body{margin:0;background:transparent}body{height:1000px;box-sizing:border-box;border:8px solid #599abb;display:flex;flex-direction:column;justify-content:space-between;text-align:center;color:#163c56;font:40px sans-serif}</style><b>TOP</b><b>BOTTOM</b>');return;}
 if(name==='/resources/assets/tall.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000"><rect x="4" y="4" width="392" height="992" fill="none" stroke="#ae6e43" stroke-width="8"/><circle cx="200" cy="60" r="40" fill="#ae6e43"/><circle cx="200" cy="940" r="40" fill="#ae6e43"/></svg>');return;}
 if(name.startsWith('/app/')&&!name.includes('..'))try{res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(path.join(publicRoot,name.slice(5))));return;}catch{}
 res.writeHead(404);res.end('Unavailable');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:430,height:340}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{
  const {coverMarkup,observeCovers}=await import('/app/board-covers.js');
  const viewport={width:400,height:1000};
  window.cover={count:4,tiles:[
   {id:'tall',itemId:'tall',title:'HTML title must not bleed',kind:'html',viewport,revision:'1'},
   {id:'image',itemId:'image',title:'Image title must not bleed',kind:'image',resource:{rootId:'assets',path:'tall.svg'},viewport,revision:'1'},
   {id:'missing',itemId:'missing',title:'Missing image fallback',kind:'image',resource:{rootId:'assets',path:'missing.png'},viewport,revision:'1'},
   {id:'text',itemId:'text',title:'A useful title-only idea',kind:'text',text:'Keep this meaningful fallback.',viewport},
  ]};
  window.render=()=>{document.querySelector('#host').innerHTML=coverMarkup(window.cover,'collection');window.observer=observeCovers(document.querySelector('#host'),window.observer);};window.render();
 });
 const tile=id=>page.locator(`[data-cover-tile="${id}"]`);
 await page.waitForFunction(()=>document.querySelector('[data-cover-tile="image"] img')?.naturalWidth>0&&document.querySelector('[data-cover-tile="missing"] img')?.hidden);
 await tile('tall').locator('iframe').evaluate(el=>el.loading='eager');
 await page.waitForTimeout(100);
 for(const theme of ['light','dark']){
  await page.evaluate(value=>document.documentElement.dataset.appearance=value,theme);
  for(const id of ['tall','image'])assert.equal(await tile(id).locator('.workspace-cover-fallback').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  for(const id of ['missing','text'])assert.equal(await tile(id).locator('.workspace-cover-fallback').evaluate(el=>getComputedStyle(el).visibility),'visible');
  const fit=await tile('tall').evaluate(el=>{const box=el.getBoundingClientRect(),frame=el.querySelector('iframe').getBoundingClientRect();return frame.width<=box.width&&frame.height<=box.height&&Math.abs(frame.width/frame.height-.4)<.01;});assert.equal(fit,true);
  // Transparent image margins use the theme's opaque tile surface, not a fixed light paper.
assert.equal(await tile('image').evaluate(el=>getComputedStyle(el.querySelector('img')).backgroundColor===getComputedStyle(el).backgroundColor),true);
  await page.screenshot({path:path.join(evidence,`covers-tall-${theme}.png`)});
 }
 // Geometry/review reconciliation can retain a failed image after removing its hidden attribute.
 await tile('missing').locator('img').evaluate(el=>el.hidden=false);
 await page.evaluate(async()=>{const {observeCovers}=await import('/app/board-covers.js');window.observer=observeCovers(document.querySelector('#host'),window.observer);});
 assert.equal(await tile('missing').locator('img').isHidden(),true);
 // Browser-reported media failures restore the same title fallback.
 await tile('tall').locator('iframe').evaluate(el=>el.dispatchEvent(new Event('error')));
 assert.equal(await tile('tall').locator('.workspace-cover-fallback').evaluate(el=>getComputedStyle(el).visibility),'visible');
 // Native iframe load is not success evidence: a real HTTP404 must reveal the title.
 await page.evaluate(()=>{window.cover.tiles=[{id:'unavailable',itemId:'unavailable',title:'HTML unavailable fallback',kind:'html',viewport:{width:400,height:1000},revision:'1'}];window.render();});
 await page.waitForFunction(()=>document.querySelector('[data-cover-tile="unavailable"] iframe')?.hidden);
 assert.equal(await tile('unavailable').locator('.workspace-cover-fallback').evaluate(el=>getComputedStyle(el).visibility),'visible');
 await tile('unavailable').locator('iframe').evaluate(el=>el.hidden=false);
 await page.evaluate(async()=>{const {observeCovers}=await import('/app/board-covers.js');window.observer=observeCovers(document.querySelector('#host'),window.observer);});
 assert.equal(await tile('unavailable').locator('iframe').isHidden(),true);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,evidence,checks:['HTML and transparent image letterboxes exclude fallback text','complete tall viewport retained','light and dark tile backgrounds','real image404 fallback','title-only fallback retained','already-failed images after reconciliation','reported iframe errors restore fallback','real HTML404 fallback retained after reconciliation'],errors}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
