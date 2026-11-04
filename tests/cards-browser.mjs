import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-cards-browser-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-cards-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser;const errors=[];
try {
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Design studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 await op('createBoard',{id:'comparison',title:'Motion studies'});
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 await writeFile(path.join(assets,'diagram.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500" viewBox="0 0 1000 500"><rect width="1000" height="500" fill="#182c47"/><circle cx="125" cy="250" r="85" fill="#edc17c"/><circle cx="875" cy="250" r="85" fill="#86b8e2"/><path d="M220 250H780" stroke="#ffffff" stroke-width="8"/><text x="500" y="100" fill="white" text-anchor="middle" font-size="48" font-family="sans-serif">The complete diagram</text><text x="125" y="270" fill="#182c47" text-anchor="middle" font-size="36">A</text><text x="875" y="270" fill="#182c47" text-anchor="middle" font-size="36">B</text></svg>');
 await writeFile(path.join(assets,'design.html'),'<!doctype html><style>body{margin:0;padding:45px;background:#e8eef7;color:#182c47;font:24px system-ui}h1{font-size:50px}p{max-width:580px}figure{height:200px;background:#789bc2;display:flex;align-items:center;justify-content:space-around}i{display:block;width:100px;height:100px;border-radius:50%;background:#182c47}</style><h1>People, places, connections</h1><p>A complete design deserves enough space to compare its content and hierarchy.</p><figure><i></i><i></i><i></i></figure>');
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 const compact=(id,title,item,x)=>op('createItem',{boardId:'comparison',item:{id,title,...item},placement:{x,y:0,width:320,height:240,presentation:{mode:'card'}}});
 const image=await compact('diagram','Connections and travellers',{content:{kind:'image',resource:{rootId:'assets',path:'diagram.svg'}}},0);
 const building=await compact('building','Woodland animals and their world',{content:{kind:'html',resource:{rootId:'assets',path:'design.html'}},build:{state:'building',message:'Building the character cast, trees and streams. A preview will arrive when the kit is ready for review.'}},360);
 const html=await compact('html','Isometric town',{content:{kind:'html',resource:{rootId:'assets',path:'design.html'}}},720);
 const panel=await op('createItem',{boardId:'comparison',item:{id:'panel',title:'A readable visual comparison',content:{kind:'html',resource:{rootId:'assets',path:'design.html'}}},placement:{x:0,y:300}});
 const before=await getBoardSnapshot(config,'comparison');assert.equal(before.placements.find(p=>p.itemId==='panel').presentation.mode,'panel');
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1100},colorScheme:'dark'});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/boards/comparison/');await page.locator('.workspace-card').first().waitFor();
 const card=id=>page.locator(`[data-placement="${id}"]`);const imageCard=card(image.placementIds[0]);const buildingCard=card(building.placementIds[0]);
 assert.equal(await imageCard.locator('img').evaluate(el=>getComputedStyle(el).objectFit),'contain');
 assert.equal(await buildingCard.locator('h3 button').evaluate(el=>getComputedStyle(el).opacity),'1');
 assert.equal(await buildingCard.locator('h3 button').isDisabled(),true);
 assert.match(await buildingCard.locator('.workspace-build-label').innerText(),/In progress/);
 assert.equal(await buildingCard.locator('iframe').count(),0);
 assert.equal(await card(html.placementIds[0]).locator('iframe').count(),1);
 // The iframe's whole viewport fits the available compact preview in both axes.
 await page.waitForTimeout(200);
 const fit=await card(html.placementIds[0]).locator('.workspace-live-preview').evaluate(el=>{const frame=el.querySelector('iframe').getBoundingClientRect(),box=el.getBoundingClientRect();return frame.width<=box.width+1&&frame.height<=box.height+1;});assert.equal(fit,true);
 await page.screenshot({path:path.join(evidence,'cards-desktop-dark.png')});
 // Compact title opens the existing reader, then returns to the same placement.
 await imageCard.locator('h3 button').click();await page.locator('#reader-dialog').waitFor({state:'visible'});await page.locator('#close-reader').click();await page.locator('#reader-dialog').waitFor({state:'hidden'});
 await imageCard.locator('[data-item-controls]').click();await page.locator('#workspace-item-controls').waitFor({state:'visible'});
 await page.locator('#workspace-item-controls [data-context-close]').click();
 // Direct Add form shares the backend default; no client-side compact override.
 await page.locator('#board-info-toggle').click();
 await page.evaluate(async()=>{const {itemForm,WorkspaceClient}=await import('/app/workspace.js');const config=await fetch('/api/config').then(r=>r.json());const snapshot=await fetch('/api/boards/comparison').then(r=>r.json());itemForm(new WorkspaceClient(config,snapshot.revision),{boardId:'comparison',refresh:async()=>{}});});
 const form=page.getByRole('dialog',{name:'Add an idea'});await form.locator('[name=title]').fill('Created through Add');await form.locator('[name=kind]').selectOption('html');await form.locator('details').evaluate(el=>el.open=true);await form.locator('[name=rootId]').fill('assets');await form.locator('[name=path]').fill('design.html');await form.getByRole('button',{name:'Add idea',exact:true}).click();await form.waitFor({state:'hidden'});
 const added=(await getBoardSnapshot(config,'comparison'));const uiItem=Object.values(added.items).find(i=>i.title==='Created through Add');assert.ok(uiItem);assert.equal(added.placements.find(p=>p.itemId===uiItem.id).presentation.mode,'panel');
 if(!await page.locator('select[aria-label=Appearance]').isVisible())await page.locator('#board-info-toggle').click();await page.locator('select[aria-label=Appearance]').selectOption('light');await page.locator('#board-info-toggle').click();await page.screenshot({path:path.join(evidence,'cards-desktop-light.png')});
 await page.setViewportSize({width:390,height:844});await page.goto(base+`/boards/comparison/?reveal=${building.placementIds[0]}`);await buildingCard.waitFor();await page.waitForTimeout(200);await page.screenshot({path:path.join(evidence,'cards-narrow-building.png')});
 assert.equal(await buildingCard.locator('h3 button').evaluate(el=>getComputedStyle(el).opacity),'1');
 assert.equal((await getBoardSnapshot(config,'comparison')).placements.find(p=>p.id===building.placementIds[0]).width,320);
 await page.evaluate(configId=>localStorage.setItem(`tinka/${configId}/comparison/layout`,'grid'),config.workspaceId);await page.reload();await page.locator('.workspace-compact').first().waitFor();assert.ok(await page.locator('.workspace-compact').first().evaluate(el=>el.getBoundingClientRect().width)>=319);await page.screenshot({path:path.join(evidence,'cards-narrow-mixed-grid.png')});
 // Midtone authored paper exercises the gap between palette ink and pure black.
 // Verify rendered title and metadata, rather than only testing the helper math.
 await op('updatePlacement',{boardId:'comparison',placementId:image.placementIds[0],patch:{presentation:{mode:'card',paper:'#888'}}});
 for(const theme of ['dark','light']) {
  await page.evaluate(value=>localStorage.setItem('tinka/appearance',value),theme);await page.reload();await imageCard.waitFor();
  const ratios=await imageCard.evaluate(el=>{
   const luminance=value=>{const c=value.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
   const background=luminance(getComputedStyle(el).backgroundColor);
   return ['h3 button','.workspace-compact-meta'].map(selector=>{const ink=luminance(getComputedStyle(el.querySelector(selector)).color);return (Math.max(ink,background)+.05)/(Math.min(ink,background)+.05);});
  });
  assert.ok(ratios.every(value=>value>=4.5),`Midtone paper ${theme} title and metadata contrast: ${ratios}`);
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,evidence,checks:['visual backend defaults','explicit saved 320×240 cards','complete uncropped images','compact HTML whole viewport','readable disabled building title and truthful placeholder','reader open/return','More actions','Add form Full preview default','desktop dark/light and narrow screenshots','midtone authored-paper title and metadata contrast >=4.5 in light and dark'],errors}));
} finally {await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
