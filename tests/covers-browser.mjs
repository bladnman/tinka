// Headless checks for board covers: the miniature window, the collage, the ready
// signal for live HTML thumbnails, and that blocked cover frames never show a
// blank cell. External temporary fixtures only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-covers-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-covers-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser;const errors=[];
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Cover studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 await writeFile(path.join(assets,'design.html'),'<!doctype html><style>body{margin:0;height:100vh;background:#22231f;color:#f4f1e7;font:800 70px system-ui;display:grid;place-content:center}</style>Start now.');
 await writeFile(path.join(assets,'photo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e8c79a"/><rect y="220" width="600" height="180" fill="#8d6a4c"/></svg>');
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 // A compact board draws as a miniature; a sprawling one keeps the collage.
 await op('createBoard',{id:'compact',title:'Compact studies'});
 const html=(await op('createItem',{boardId:'compact',item:{title:'Bold opening',content:{kind:'html',resource:{rootId:'assets',path:'design.html'}}},placement:{x:0,y:60,width:520,height:400,presentation:{mode:'panel',viewport:{width:1000,height:720}}}})).itemIds?.[0];
 await op('createItem',{boardId:'compact',item:{title:'Mood photo',content:{kind:'image',resource:{rootId:'assets',path:'photo.svg'}}},placement:{x:580,y:60,width:320,height:260}});
 await op('createItem',{boardId:'compact',item:{title:'Why we pause',content:{kind:'note',text:'Who is this for?'}},placement:{x:580,y:360,width:320,height:200}});
 await op('updateBoard',{boardId:'compact',patch:{decorations:[{id:'r',type:'region',x:-20,y:0,width:960,height:600,color:'#899477',text:'Directions'}]}});
 await op('createBoard',{id:'sprawl',title:'Sprawling archive'});
 for(let i=0;i<5;i++)await op('createItem',{boardId:'sprawl',item:{title:`Study ${i+1} with a long enough title to wrap twice`,content:{kind:'html',resource:{rootId:'assets',path:'design.html'}}},placement:{x:i*6000,y:(i%2)*4000,width:520,height:400,presentation:{mode:'panel',viewport:{width:1000,height:720}}}});
 await op('createBoard',{id:'inside',title:'Ideas',parentBoardId:'compact'});
 await op('createItem',{boardId:'inside',item:{title:'Inside idea',content:{kind:'html',resource:{rootId:'assets',path:'design.html'}}},placement:{x:0,y:0,width:520,height:400,presentation:{mode:'panel',viewport:{width:1000,height:720}}}});
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 // The cover document carries a fixed ready signal on both its frame path and the older API alias.
 const ws=await (await fetch(base+'/api/workspace?view=home')).json();
 const htmlItem=ws.boardCovers.compact.layout.tiles.find(t=>t.preview?.kind==='html');assert.ok(htmlItem,'Miniature carries a live HTML preview');
 assert.ok(ws.boardCovers.compact.layout.regions.length===1&&ws.boardCovers.compact.layout.tiles.length===4,'Miniature carries region and tile geometry');
 for(const url of [`/frames/items/${htmlItem.itemId}/cover.html`,`/api/items/${htmlItem.itemId}/cover-thumbnail`]){const r=await fetch(base+url);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.match(await r.text(),/tinkaCoverReady/);}
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 // 1. Normal: frames reveal only after their ready signal.
 const ok=await browser.newPage({viewport:{width:1440,height:900},colorScheme:'light'});ok.on('pageerror',e=>errors.push(e.message));
 await ok.goto(base+'/');await ok.locator('.board-card').first().waitFor();
 const compact=ok.locator('[data-home-board="compact"]');const sprawl=ok.locator('[data-home-board="sprawl"]');
 assert.equal(await compact.locator('.board-miniature').count(),1,'Compact board shows a miniature');
 assert.equal(await compact.locator('.mini-region').count(),1);assert.equal(await compact.locator('.mini-tile').count(),4);
 assert.equal(await compact.locator('.mini-tile.mini-board .workspace-cover-icon').count(),1,'Board-tiles inside the miniature keep their type icon');
 assert.equal(await sprawl.locator('.board-collage:not(.board-miniature)').count(),1,'A sprawling board keeps the readable collage');
 await ok.waitForFunction(()=>document.querySelectorAll('.workspace-cover-tile iframe[data-cover-ready]').length>=2,null,{timeout:15000});
 assert.equal(await ok.locator('.workspace-cover-tile iframe[data-cover-ready][data-cover-pending]').count(),0);
 await ok.screenshot({path:path.join(evidence,'covers-ready.png')});
 // Collage text stays clear of the "+N more" chip.
 const chip=await sprawl.evaluate(card=>{const count=card.querySelector('.workspace-cover-count').getBoundingClientRect();return [...card.querySelectorAll('.workspace-cover-fallback strong')].filter(el=>getComputedStyle(el.closest('.workspace-cover-fallback')).visibility==='visible').map(el=>{const r=el.getBoundingClientRect();return r.right>count.left&&r.left<count.right&&r.bottom>count.top&&r.top<count.bottom;});});
 assert.ok(chip.every(overlap=>!overlap),'Cell text never runs under the count chip');
 // 2. Blocked: every cover frame request fails as a client block would. No blank cells.
 for(const theme of ['dark','light']){
  const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:theme});
  await context.route(/\/(frames\/items\/[^/]+\/cover\.html|api\/items\/[^/]+\/cover-thumbnail)/,route=>route.abort('blockedbyclient'));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const noBlank=async label=>{
   await page.waitForTimeout(2500);
   const cells=await page.locator('.workspace-cover-tile:has(iframe)').evaluateAll(tiles=>tiles.map(tile=>{const frame=tile.querySelector('iframe'),fallback=tile.querySelector('.workspace-cover-fallback');const fs=getComputedStyle(frame);return {pending:frame.hasAttribute('data-cover-pending')||frame.hidden,shown:fs.display!=='none'&&Number(fs.opacity)>0,fallback:getComputedStyle(fallback).visibility,background:getComputedStyle(tile).backgroundColor};}));
   assert.ok(cells.length>0,`${label}: cover frames were rendered`);
   for(const cell of cells){assert.equal(cell.shown,false,`${label}: a blocked frame is never shown`);assert.equal(cell.fallback,'visible',`${label}: the typed placeholder shows instead`);assert.notEqual(cell.background,'rgb(255, 255, 255)',`${label}: no white cell`);}
   return cells.length;
  };
  await page.goto(base+'/');await page.locator('.board-card').first().waitFor();const home=await noBlank(`Home ${theme}`);
  await page.screenshot({path:path.join(evidence,`covers-blocked-home-${theme}.png`)});
  await page.goto(base+'/boards/compact/');await page.locator('.workspace-card').first().waitFor();const board=await noBlank(`Board ${theme}`);
  await page.screenshot({path:path.join(evidence,`covers-blocked-board-${theme}.png`)});
  if(theme==='dark')console.error(JSON.stringify({blockedHomeFrames:home,blockedBoardFrames:board}));
  await context.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,evidence,checks:['miniature geometry, regions and board-tiles in the cover response','frame route and API alias carry the ready signal under the sandbox CSP','compact boards draw a miniature, sprawling boards keep the collage','frames reveal only after their ready signal','collage text clear of the count chip','blocked cover frames never show; typed placeholders stay visible in light and dark on Home and board'],errors}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
