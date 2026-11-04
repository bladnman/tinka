// Headless checks for number continuity and return to origin.
// Numbers shown on parent tiles continue inside (top bar, reader, title) and
// follow sibling arrows; leaving an item or child board lands on its tile with a
// brief green pulse, with and without reduced motion. External temporary fixtures only.
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
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-return-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-return-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser;const errors=[];
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Glade study']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 for(const [slug,label] of [['columns','Columns give way'],['holds','Your layout holds'],['rule','Your narrow-window setting']])await writeFile(path.join(assets,`${slug}.html`),`<!doctype html><style>body{margin:0;height:100vh;display:grid;place-content:center;font:40px system-ui;background:#f6f4ec}</style><h1>${label}</h1>`);
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'options',title:'When the window gets smaller'});
 const ids={};
 for(const [i,[slug,number,title]] of [['columns','07','Columns give way'],['holds','08','Your layout holds'],['rule','09','Your narrow-window setting']].entries())
  ids[number]=(await op('createItem',{boardId:'options',item:{title,number,description:'One layout, fewer columns',content:{kind:'html',resource:{rootId:'assets',path:`${slug}.html`}}},placement:{x:i*4200,y:0,width:720,height:560,presentation:{mode:'panel',viewport:{width:1000,height:720}}}})).placementIds[0];
 const child=await op('createBoard',{id:'details',title:'Details of the choice',parentBoardId:'options'});
 const snap=await getBoardSnapshot(config,'options');const ownerPlacement=snap.placements.find(p=>snap.items[p.itemId]?.childBoardId==='details');
 await op('updateItem',{itemId:snap.items[ownerPlacement.itemId].id,patch:{number:'10'}});
 await op('updatePlacement',{boardId:'options',placementId:ownerPlacement.id,patch:{x:2100,y:2600,width:360,height:300}});
 await op('createItem',{boardId:'details',item:{title:'A note inside'}});
 const before=(await getBoardSnapshot(config,'options')).revision;
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const inView=(page,id)=>page.locator(`[data-placement="${id}"]`).evaluate(el=>{const r=el.getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect();return r.left>=v.left-1&&r.right<=v.right+1&&r.top>=v.top-1&&r.bottom<=v.bottom+1;});
 for(const motion of ['no-preference','reduce']){
  const context=await browser.newContext({viewport:{width:1280,height:860},reducedMotion:motion,colorScheme:'light'});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/boards/options/');await page.locator(`[data-placement="${ids['07']}"]`).waitFor();
  if(await page.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.keyboard.press('Escape');}
  // The parent tile shows its number.
  for(const n of ['07','08','09'])assert.equal(await page.locator(`[data-placement="${ids[n]}"] .workspace-concept-number`).textContent(),n);
  await page.locator('#zoom-menu-toggle').click();await page.locator('[data-zoom-to="1"]').click();
  await page.locator(`[data-placement="${ids['07']}"] .workspace-panel-title`).click();await page.locator('#reader-dialog[open]').waitFor();
  // Inside, the number is part of the name, and follows the sibling arrows.
  const reader=async()=>({number:await page.locator('#reader-number').textContent(),visible:await page.locator('#reader-number').isVisible(),name:await page.locator('#reader-name').textContent(),title:await page.title()});
  let r=await reader();assert.deepEqual([r.number,r.visible,r.name],['07',true,'Columns give way']);assert.match(r.title,/07 · Columns give way/);
  if(motion==='no-preference')await page.screenshot({path:path.join(evidence,'reader-number-07.png')});
  await page.locator('#reader-next').click();await page.waitForFunction(()=>document.querySelector('#reader-number').textContent==='08');
  await page.locator('#reader-next').click();await page.waitForFunction(()=>document.querySelector('#reader-number').textContent==='09');
  r=await reader();assert.equal(r.name,'Your narrow-window setting');assert.match(r.title,/09 · Your narrow-window setting/);
  // Escape lands on the last one viewed (09), which was off screen, and pulses it.
  assert.equal(await inView(page,ids['09']),false,'09 starts off screen');
  await page.keyboard.press('Escape');await page.locator('#reader-dialog').waitFor({state:'hidden'});
  if(motion==='reduce'){await page.waitForTimeout(80);assert.equal(await inView(page,ids['09']),true,'Reduced motion jumps straight to the tile');}
  await page.locator(`[data-placement="${ids['09']}"].return-pulse`).waitFor({timeout:3000});
  await page.waitForFunction(id=>{const el=document.querySelector(`[data-placement="${id}"]`),r=el.getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect();return r.left>=v.left-1&&r.right<=v.right+1&&r.top>=v.top-1&&r.bottom<=v.bottom+1;},ids['09'],{timeout:3000});
  const ring=await page.locator(`[data-placement="${ids['09']}"]`).evaluate(el=>getComputedStyle(el).outlineColor);assert.match(ring,/98, 117, 74|rgb\(98/,'The pulse is the one green');
  if(motion==='no-preference')await page.screenshot({path:path.join(evidence,'return-pulse-09.png')});
  // A visible tile is not moved: open 09 again and return without stepping.
  await page.waitForTimeout(500);const viewBefore=await page.locator('#plane').evaluate(el=>el.style.transform);
  await page.locator(`[data-placement="${ids['09']}"] .workspace-panel-title`).click();await page.locator('#reader-dialog[open]').waitFor();await page.locator('#close-reader').click();await page.locator('#reader-dialog').waitFor({state:'hidden'});
  await page.waitForTimeout(400);assert.equal(await page.locator('#plane').evaluate(el=>el.style.transform),viewBefore,'Returning to a visible tile keeps the view');
  // Child board: the top bar carries the number, and ← Parent / browser Back land on its tile.
  await page.locator(`[data-placement="${ownerPlacement.id}"] [data-open]`).first().click();await page.waitForURL(/\/boards\/details\//);await page.locator('.workspace-card').first().waitFor();
  assert.equal(await page.locator('#board-number').textContent(),'10');assert.equal(await page.locator('#board-number').isVisible(),true);assert.equal(await page.locator('#board-title').textContent(),'Details of the choice');assert.match(await page.title(),/10 · Details of the choice/);
  await page.locator('#workspace-parent').click();await page.waitForURL(/\/boards\/options\//);
  await page.locator(`[data-placement="${ownerPlacement.id}"].return-pulse`).waitFor({timeout:5000});
  await page.locator(`[data-placement="${ownerPlacement.id}"] [data-open]`).first().click();await page.waitForURL(/\/boards\/details\//);await page.locator('.workspace-card').first().waitFor();
  await page.goBack();await page.waitForURL(/\/boards\/options\//);await page.locator(`[data-placement="${ownerPlacement.id}"].return-pulse`).waitFor({timeout:5000});
  if(motion==='no-preference')await page.screenshot({path:path.join(evidence,'return-parent-pulse.png')});
  await context.close();
 }
 assert.equal((await getBoardSnapshot(config,'options')).revision,before,'Numbers and return-to-origin make no writes');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,evidence,checks:['parent tiles show 07/08/09','reader number and title follow sibling arrows 07→08→09','Escape lands on the last viewed off-screen tile with a green pulse','reduced motion jumps straight there and still highlights','a visible tile keeps the view','child board top bar carries the owner number','← Parent and browser Back land on the board-tile with a pulse','no writes'],errors}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
