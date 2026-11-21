// Disposable Home layout fixture; no user data, apps or OS clipboard.
import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-home-layout-browser-')),evidence=await mkdtemp(path.join(os.tmpdir(),'tinka-home-layout-evidence-'));
let browser,server;
try{
  const configPath=path.join(fixture,'local/config.json');
  await main(['init','--config',configPath,'--boards',path.join(fixture,'boards'),'--label','Home arrangement']);const config=await loadConfig(configPath);
  const ids=[];for(const title of ['Alpha','Beta','Gamma'])ids.push((await applyOperation(config,{type:'createBoard',title})).result.boardId);
  server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',request=>{if(request.url().endsWith('/api/operations'))writes.push(request.postDataJSON());});
  const read=async()=>(await(await fetch(base+'/api/workspace')).json());
  const saved=async()=>((await read()).homeLayout||{});
  const wait=async predicate=>{for(let n=0;n<100;n++){if(await predicate())return;await page.waitForTimeout(50);}throw Error('Condition did not settle: '+JSON.stringify({saved:await saved(),writes,errors,history:await page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage))),dialogs:await page.locator("dialog[open]").allTextContents(),toasts:await page.locator('.workspace-toast').allTextContents()}));};
  const cards=page.locator('[data-home-board][data-home-item]'),bar=page.locator('[data-home-selection]');
  const select=async()=>{await page.keyboard.press('Control+a');await bar.waitFor();};
  await page.goto(base);await cards.nth(2).waitFor();assert.equal(await page.locator('[data-home-layout=grid]').getAttribute('aria-pressed'),'true');
  const original=await read();
  await select();await bar.getByRole('button',{name:'Arrange',exact:true}).click();
  const popup=page.getByRole('dialog',{name:'Arrange',exact:true});await popup.waitFor();
  const desktopMenu=await popup.boundingBox(),desktopAnchor=await bar.getByRole('button',{name:'Arrange',exact:true}).boundingBox();
  assert(Math.abs(desktopMenu.x-desktopAnchor.x)<=2,`desktop Arrange anchors beside its trigger: ${JSON.stringify({desktopMenu,desktopAnchor})}`);
  assert(desktopMenu.x>=8&&desktopMenu.x+desktopMenu.width<=1432&&desktopMenu.y>=8&&desktopMenu.y+desktopMenu.height<=992,'desktop popup stays within viewport');
  await page.screenshot({path:path.join(evidence,'home-arrange-1440.png')});
  assert(await page.getByRole('button',{name:'Distribute horizontally',exact:true}).isEnabled());
  await page.getByRole('button',{name:'Align left',exact:true}).click();await wait(async()=>Object.keys(await saved()).length===3);
  const aligned=await saved();assert.equal(new Set(Object.values(aligned).map(box=>box.x)).size,1);assert.equal(await page.locator('[data-home-layout=canvas]').getAttribute('aria-pressed'),'true');
  assert(writes.at(-1).expectedRevision===original.revision,'layout uses the displayed strict revision');
  assert.deepEqual((await read()).homeBoardIds,original.homeBoardIds);assert.deepEqual((await read()).boards,original.boards);
  await page.reload();await cards.nth(2).waitFor();assert.equal(await page.locator('[data-home-layout=canvas]').getAttribute('aria-pressed'),'true');assert.deepEqual(await saved(),aligned);
  await page.locator('[data-home-undo]').click();await wait(async()=>Object.keys(await saved()).length===0);await page.locator('[data-home-redo]').click();await wait(async()=>Object.keys(await saved()).length===3);assert.deepEqual(await saved(),aligned);
  // Grid restores normal order without changing any saved geometry; Arrange stays available.
  await page.locator('[data-home-layout=grid]').click();await select();assert(await bar.getByRole('button',{name:'Arrange',exact:true}).isVisible());assert.deepEqual(await saved(),aligned);
  await page.reload();await cards.nth(2).waitFor();assert.equal(await page.locator('[data-home-layout=grid]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-home-layout=canvas]').click();await select();await bar.getByRole('button',{name:'Arrange',exact:true}).click();await page.getByRole('button',{name:'Tidy into grid',exact:true}).click();await wait(async()=>JSON.stringify(await saved())!==JSON.stringify(aligned));
  await bar.getByRole('button',{name:'Clear selection'}).click();
  const first=cards.first(),id=await first.getAttribute('data-home-board'),beforeDrag=await saved(),box=await first.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+50,box.y+box.height/2+35,{steps:8});await page.mouse.up();await wait(async()=>(await saved())[id].x===beforeDrag[id].x+50);
  assert(page.url().replace(/\/$/,'')===base,'drag does not open the board');
  await page.locator('[data-home-undo]').click();await wait(async()=>JSON.stringify(await saved())===JSON.stringify(beforeDrag));
  // Focused controls keep Enter and arrow keys; canceled drags do not consume
  // the next intended click or accidentally navigate/open a selected board.
  await first.locator('[data-home-select]').click();
  await page.locator('[data-home-layout=grid]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('[data-home-layout=grid]').getAttribute('aria-pressed'),'true');assert(page.url().replace(/\/$/,'')===base);
  await page.locator('[data-home-layout=canvas]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('[data-home-layout=canvas]').getAttribute('aria-pressed'),'true');
  const nativeBefore=await saved();await page.locator('[data-home-layout=canvas]').focus();await page.keyboard.press('ArrowRight');assert.deepEqual(await saved(),nativeBefore);
  await bar.getByRole('button',{name:'Clear selection'}).click();
  const cancelBox=await first.boundingBox();await page.mouse.move(cancelBox.x+80,cancelBox.y+80);await page.mouse.down();await page.mouse.move(cancelBox.x+120,cancelBox.y+120,{steps:5});await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await saved(),nativeBefore);
  await page.locator('[data-home-layout=grid]').click();assert.equal(await page.locator('[data-home-layout=grid]').getAttribute('aria-pressed'),'true');await page.locator('[data-home-layout=canvas]').click();
  // A real intervening workspace write rejects stale Home geometry atomically.
  await first.locator('[data-home-select]').click();await page.keyboard.down('Shift');await cards.nth(1).locator('[data-home-select]').click();await page.keyboard.up('Shift');
  await bar.getByRole('button',{name:'Arrange',exact:true}).click();assert(await page.getByRole('button',{name:'Distribute horizontally',exact:true}).isDisabled());await page.keyboard.press('Escape');
  const geometry=await saved();await page.route('**/api/operations',async route=>{const data=route.request().postDataJSON();if(data.patch?.homeLayout){await applyOperation(config,{type:'updateWorkspace',patch:{homeLayout:geometry}});}await route.continue();});
  const rejected=page.waitForResponse(response=>response.url().endsWith('/api/operations')&&response.request().postDataJSON().patch?.homeLayout);
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('ArrowRight');assert.equal((await rejected).status(),409);await page.getByRole('dialog',{name:'Change not saved'}).waitFor();assert.deepEqual(await saved(),geometry,'stale nudge did not overwrite geometry');await page.unroute('**/api/operations');
  await page.getByRole('dialog',{name:'Change not saved'}).getByRole('button',{name:/Close/}).click();
  // Incoming metadata waits while the Arrange menu is open; its displayed
  // baseline is not silently replaced by a newer Home read.
  await bar.getByRole('button',{name:'Arrange',exact:true}).click();
  await applyOperation(config,{type:'updateWorkspace',patch:{homeLayout:geometry}});await page.waitForTimeout(1200);
  assert(await page.getByRole('dialog',{name:'Arrange',exact:true}).isVisible());await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});await bar.getByRole('button',{name:'Arrange',exact:true}).click();await popup.waitFor();
  const phoneMenu=await popup.boundingBox();assert(phoneMenu.x>=8&&phoneMenu.x+phoneMenu.width<=382&&phoneMenu.y>=8&&phoneMenu.y+phoneMenu.height<=836,`phone popup accessible: ${JSON.stringify(phoneMenu)}`);
  await page.screenshot({path:path.join(evidence,'home-arrange-390.png')});
  const firstFocus=await page.evaluate(()=>document.activeElement?.getAttribute('data-arrange'));await page.keyboard.press('ArrowRight');assert.notEqual(await page.evaluate(()=>document.activeElement?.getAttribute('data-arrange')),firstFocus);
  await page.keyboard.press('Escape');assert(await popup.isHidden());assert.equal(await bar.getByRole('button',{name:'Arrange',exact:true}).getAttribute('aria-expanded'),'false');
  assert(await bar.getByRole('button',{name:'Arrange',exact:true}).evaluate(element=>element===document.activeElement));
  await page.screenshot({path:path.join(evidence,'home-canvas-390.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(250);await page.screenshot({path:path.join(evidence,'home-canvas-1440.png')});
  assert.deepEqual(errors,[]);await writeFile(path.join(evidence,'receipt.json'),JSON.stringify({passed:true,fixture,writes:writes.length,desktopMenu,desktopAnchor,phoneMenu},null,2));console.log(JSON.stringify({passed:true,evidence,checks:['Arrange discovered in default Grid','shared align/tidy/distribute controls','workspace saved geometry survives reload','Grid selection retains Arrange and saved Canvas','layout Undo/Redo across reload','drag saves and undoes','strict stale-save rejection','no membership/board migration','narrow layout','1440 menu anchored to trigger','390 popup bounds, arrow keys, Escape and focus return']}));
}finally{await browser?.close();if(server)await closeAppServer(server);}
