// Visible Home/board metadata refresh through the real service and its app lock.
// Only release discovery is controlled; no package download or install is allowed.
import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createUpdateService,installPaths} from '../lib/update-browser.mjs';
import {updateContext,CHECK_INTERVAL,CHECK_RETRY_INTERVAL} from '../lib/updates.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-update-refresh-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-update-refresh-evidence-'));await mkdir(evidence,{recursive:true});
let browser,server;const errors=[];let checks=0;
const ok=(value,message)=>{assert(value,message);checks++;};
const until=async check=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected update refresh did not settle');};
try {
 const configFile=path.join(root,'config.json');await main(['init','--config',configFile,'--boards',path.join(root,'boards'),'--label','Refresh studio']);const config=await loadConfig(configFile);
 await applyOperation(config,{type:'createBoard',id:'notes',title:'Review notes'});
 await applyOperation(config,{type:'createItem',boardId:'notes',item:{title:'Keep this note',content:{kind:'note',text:'The notes and navigation remain here.'},review:{note:'A saved review note.'}}});
 await applyOperation(config,{type:'createItem',boardId:'notes',item:{title:'Second review note',content:{kind:'note',text:'A second selected card.'}}});
 const original=await getBoardSnapshot(config,'notes');
 // A disposable installed marker is enough for this service test. It deliberately
 // has no pristine baseline, so discovered newer versions require review.
 const app=path.join(root,'app');await mkdir(app);await writeFile(path.join(app,'INSTALLATION.json'),'{}');
 const updateContext_=await updateContext(config,app);let tick=Date.now(),calls=0,fail=false,releaseFirst;
 const held=new Promise(resolve=>releaseFirst=resolve);
 const next=config.version.replace(/\.(\d+)\./,(_,minor)=>`.${Number(minor)+1}.`);
 const initial={schemaVersion:1,appPath:updateContext_.app,configPath:config.configPath,policy:'notify',checkedAt:tick-CHECK_INTERVAL-1,lastSuccessfulCheckAt:tick-CHECK_INTERVAL-1,latest:{version:config.version}};
 await writeFile(updateContext_.statePath,JSON.stringify(initial));
 const updates=createUpdateService(config,{app,now:()=>tick,checkOptions:{fetchLatest:async()=>{calls++;if(calls===1)await held;if(fail)throw new Error('Fixture offline');return {version:next,review:'Review this fixture update.'};},downloadRelease:async()=>{throw new Error('Unexpected package download');},install:async()=>{throw new Error('Unexpected install');}}});
 server=await listen(config,{port:0,updates});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await context.addInitScript(()=>{window.__visible=true;window.__pageMarker='unchanged';Object.defineProperty(document,'hidden',{configurable:true,get:()=>!window.__visible});});
 await context.clock.install({time:tick});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/boards/notes/');await page.locator('.workspace-card').first().waitFor();await until(()=>calls===1);
 await page.locator('#viewport').focus();await page.keyboard.press('ControlOrMeta+a');
 ok(await page.locator('.update-chip').count()===0,'First paint uses cached current state while a due check runs');
 const otherService=createUpdateService(config,{app,now:()=>tick,checkOptions:{fetchLatest:async()=>{calls++;throw new Error('The shared app lock should reuse the first check');}}});
 const parallelRefresh=otherService.preference({action:'refresh'});
 releaseFirst();await parallelRefresh;await page.locator('.update-chip').waitFor();
 ok(calls===1,'Independent service queues share the app-lock throttle');
 ok((await page.locator('.update-chip').textContent()).includes(next.replace(/\.0$/,'')),'The badge appears after discovery without a reload');
 ok(await page.evaluate(()=>window.__pageMarker==='unchanged'),'Discovery keeps the page');
 await page.screenshot({path:path.join(evidence,'selected-new-badge-390.png')});
 await page.setViewportSize({width:1440,height:900});await page.screenshot({path:path.join(evidence,'board-refreshed-1440.png')});
 const peer=await context.newPage();peer.on('pageerror',error=>errors.push(error.message));await peer.goto(base+'/');await peer.locator('.update-chip').waitFor();
 ok(calls===1,'A second tab reuses the project check');
 const state=()=>readFile(updateContext_.statePath,'utf8').then(JSON.parse);
 const beforeRead=await readFile(updateContext_.statePath,'utf8');await updates.view();ok(await readFile(updateContext_.statePath,'utf8')===beforeRead,'GET/view stays read-only');
 tick+=CHECK_INTERVAL+100;await context.clock.fastForward(CHECK_INTERVAL+100);await until(async()=>calls===2&&(await state()).checkedAt===tick);
 ok(calls===2,'Two visible due tabs make one external check under the shared app lock');
 const visible=async(p,value)=>p.evaluate(value=>{window.__visible=value;document.dispatchEvent(new Event('visibilitychange'));},value);
 await visible(page,false);await visible(peer,false);
 tick+=CHECK_INTERVAL*2;await context.clock.fastForward(CHECK_INTERVAL*2);await new Promise(resolve=>setTimeout(resolve,100));ok(calls===2,'Hidden tabs make no scheduled discovery requests');
 await visible(peer,true);await until(()=>calls===3);ok(calls===3,'Foreground return checks when due');
 const lastSuccess=(await state()).lastSuccessfulCheckAt;fail=true;
 tick+=CHECK_INTERVAL+100;await context.clock.fastForward(CHECK_INTERVAL+100);await until(async()=>calls===4&&(await state()).checkError);
 ok((await state()).lastSuccessfulCheckAt===lastSuccess,'A failed attempt retains the successful timestamp');
 ok((await peer.locator('.update-chip').textContent()).includes(next.replace(/\.0$/,'')),'A failed check keeps the prior newer offer');
 await peer.locator('.update-chip').click();ok((await peer.locator('.update-check-status').textContent()).includes('Could not refresh update information. Last successful check:'),'A retained offer explains failed refresh and last successful date');
 await peer.keyboard.press('Escape');await peer.setViewportSize({width:390,height:844});await peer.locator('.update-chip').click();await peer.screenshot({path:path.join(evidence,'home-retained-offer-failure-390.png')});await peer.keyboard.press('Escape');
 await updates.preference({action:'policy',policy:'off'});await visible(peer,false);await visible(peer,true);await until(async()=>(await updates.view()).policy==='off');
 await new Promise(resolve=>setTimeout(resolve,100));tick+=CHECK_INTERVAL*2;await context.clock.fastForward(CHECK_INTERVAL*2);ok(calls===4,'Off stops periodic discovery');
 // Even a direct refresh during an active install does not do discovery.
 const paths=installPaths(updateContext_);await writeFile(paths.record,JSON.stringify({schemaVersion:1,pid:process.pid,from:config.version,to:next,startedAt:tick}));
 await updates.preference({action:'refresh'});ok(calls===4,'Pending install skips metadata refresh');await rm(paths.record);
 // No prior newer offer: failed refresh is visibly different from up-to-date.
 await writeFile(updateContext_.statePath,JSON.stringify({...initial,checkedAt:tick-CHECK_INTERVAL-1,lastSuccessfulCheckAt:lastSuccess}));
 await page.goto(base+'/boards/notes/');await page.locator('.update-chip[data-kind="check"]').waitFor();ok(await page.locator('.update-chip').textContent()==='Check failed','A failed check without an offer gets a quiet status badge');
 await page.locator('#board-info-toggle').click();ok((await page.locator('.update-about').textContent()).includes('could not check for updates'),'About does not claim current after failure');
 ok((await page.locator('.update-about .update-check-status').textContent()).includes('Last successful check:'),'About shows the successful date');
 await page.setViewportSize({width:390,height:844});await page.locator('.update-about').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'board-check-failed-about-390.png')});
 await page.locator('#board-info-close').click();await page.locator('.update-chip').click();fail=false;
 await page.locator('.update-pop [data-update=check]').click();await page.locator('.update-chip[data-kind="review"]').waitFor();ok((await updates.view()).checkFailed===false,'An explicit Check now recovers immediately');
 for(const width of [320,390,608]) {
  await page.setViewportSize({width,height:844});await page.locator('#viewport').focus();await page.keyboard.press('ControlOrMeta+a');
  await page.locator('#workspace-selection strong').getByText('2 selected',{exact:true}).waitFor();
  await page.screenshot({path:path.join(evidence,`selected-update-badge-${width}.png`)});
  const controls=await page.evaluate(()=>['.update-chip','.canvas-footer .zoom-pill','#workspace-selection','#edit-tools'].map(selector=>{const element=document.querySelector(selector),r=element.getBoundingClientRect();return {selector,x:r.x,y:r.y,right:r.right,bottom:r.bottom,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};}));
  for(const c of controls)ok(c.inside,`${width}: ${c.selector} stays in viewport ${JSON.stringify(c)}`);
  for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){const a=controls[i],b=controls[j];ok(!(a.x<b.right&&a.right>b.x&&a.y<b.bottom&&a.bottom>b.y),`${width}: ${a.selector} and ${b.selector} do not overlap`);}
  await page.locator('.update-chip').click();await page.locator('.update-pop').waitFor();await page.keyboard.press('Escape');
  await page.locator('#zoom-menu-toggle').click();await page.locator('#zoom-menu').waitFor({state:'visible'});await page.keyboard.press('Escape');
  await page.locator('[data-selection-more]').click();await page.locator('.selection-actions-menu').waitFor();await page.keyboard.press('Escape');
 }
 const after=await getBoardSnapshot(config,'notes');ok(JSON.stringify(after.placements)===JSON.stringify(original.placements)&&JSON.stringify(after.items)===JSON.stringify(original.items),'Update discovery preserves notes and board geometry');
 // A source checkout carries no refresh eligibility, even on a direct POST.
 const source=createUpdateService(config);ok(!(await source.view()).refreshEnabled,'Source checkout has no scheduled discovery');await source.preference({action:'refresh'});ok(calls===6,'Source refresh does not contact the release source');
 ok(errors.length===0,errors.join('\n'));
 console.log(JSON.stringify({passed:true,checks,calls,evidence,errors}));
 await context.close();
} finally {await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
