// Optional browser acceptance check; Playwright is a QA tool, not an app dependency.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
const modulePath=process.env.PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath?pathToFileURL(modulePath).href:'playwright');
const fixtures=await mkdtemp(path.join(os.tmpdir(),'tinka-browser-fixture-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-browser-evidence-'));
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
const context=await browser.newContext({viewport:{width:1440,height:960}});
const errors=[];
const instances=[];
const saved=async file=>JSON.parse(await readFile(file,'utf8'));
const waitFor=async(check,message)=>{for(let i=0;i<80;i++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error(message);};
try{
  for(const label of ['Glade','Runway']){
    const config=path.join(fixtures,label,'tinka.config.json');
    const boards=path.join(fixtures,label,'boards');
    await main(['init','--config',config,'--boards',boards,'--label',label]);
    await cp(new URL('../examples/first-steps',import.meta.url),path.join(boards,'first-steps'),{recursive:true});
    const instance={config,boards};instances.push(instance);
    const report=await main(['start','--config',config]);
    instance.port=(await saved(config)).port;instance.url=`http://127.0.0.1:${instance.port}/`;
    assert(report.includes(instance.url));
    instance.page=await context.newPage();instance.page.on('pageerror',error=>errors.push(error.message));
    await instance.page.goto(instance.url);
    await instance.page.waitForFunction(label=>document.querySelector('#workspace-name').textContent===`Tinka / ${label}`,label);
    assert.equal(await instance.page.title(),`Tinka / ${label}`);
  }
  const [a,b]=instances;assert.notEqual(a.url,b.url);
  await a.page.screenshot({path:path.join(evidence,'home-wide.png')});
  await a.page.locator('.new-board').first().click();
  assert((await a.page.locator('#agent-prompt').inputValue()).includes(a.config));
  assert((await a.page.locator('#agent-prompt').inputValue()).includes(a.url));
  await a.page.locator('.close').click();
  await main(['board','create','newly-added','--config',a.config,'--title','Newly added']);
  await a.page.getByRole('heading',{name:'Newly added'}).waitFor();
  for(const instance of instances){
    await instance.page.goto(`${instance.url}boards/first-steps/`);
    await instance.page.waitForFunction(()=>document.querySelectorAll('.concept-card').length===2);
    await instance.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
    assert((await instance.page.title()).includes(instance===a?'Tinka / Glade':'Tinka / Runway'));
    await instance.page.locator('[data-note="first/one-step"]').fill(instance===a?'Glade only':'Runway only');
    await waitFor(async()=>{
      const notes=await (await fetch(`${instance.url}api/boards/first-steps/notes`)).json();
      return notes['first/one-step']?.note===(instance===a?'Glade only':'Runway only');
    },'Note persisted to its own instance');
  }
  await a.page.screenshot({path:path.join(evidence,'board-collapsed-wide.png')});
  await a.page.locator('#toggle-header').click();
  await a.page.screenshot({path:path.join(evidence,'board-expanded-wide.png')});
  await a.page.locator('#toggle-header').click();
  await a.page.setViewportSize({width:400,height:800});
  await a.page.screenshot({path:path.join(evidence,'board-collapsed-narrow.png')});
  assert(await a.page.locator('#canvas-header').evaluate(el=>el.getBoundingClientRect().height<90));
  assert.equal(await a.page.locator('#project-label').textContent(),'Glade');
  await a.page.locator('#overview').click();
  await a.page.locator('#reset-view').click();
  await a.page.locator('#toggle-header').click();
  await a.page.screenshot({path:path.join(evidence,'board-expanded-narrow.png')});
  await a.page.goto(a.url);
  await a.page.getByRole('heading',{name:'A better first step'}).waitFor();
  await a.page.screenshot({path:path.join(evidence,'home-narrow.png')});
  await a.page.setViewportSize({width:1440,height:960});
  await a.page.goto(`${a.url}boards/first-steps/`);
  await a.page.locator('[data-note="first/one-step"]').waitFor();
  assert.equal(await a.page.locator('[data-note="first/one-step"]').inputValue(),'Glade only');
  await a.page.locator('.card-actions [data-open="first/one-step"]').click();
  const frame=a.page.frameLocator('#active-reader');
  await frame.locator('input').fill('A new thought');
  await frame.getByRole('button',{name:'Start writing'}).click();
  await frame.getByRole('heading',{name:'A new thought'}).waitFor();
  const experiment=path.join(a.boards,'first-steps/experiments/one-step/index.html');
  await writeFile(experiment,(await readFile(experiment,'utf8')).replace('A thought worth keeping.','A fresh version.'));
  await a.page.locator('#reader-update').waitFor({state:'visible'});
  // Existing interaction remains intact until the user explicitly reloads it.
  assert.equal(await frame.getByRole('heading',{name:'A new thought'}).isVisible(),true);
  await a.page.locator('#reader-update').click();
  await frame.getByRole('heading',{name:'A fresh version.'}).waitFor();
  await a.page.locator('#close-reader').click();
  await a.page.evaluate(()=>localStorage.setItem('board-room-notes/first-steps',JSON.stringify({'first/one-step':{note:'Old unscoped cache must not leak',updatedAt:Date.now()+1000000}})));
  // Reuse the very same origin with the other workspace. Its namespace must win.
  const stalePage=await context.newPage();
  await stalePage.goto(`${a.url}boards/first-steps/`);
  await stalePage.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
  await main(['stop','--config',a.config]);
  await main(['stop','--config',b.config]);
  await writeFile(b.config,JSON.stringify({...await saved(b.config),port:a.port,portMode:'fixed'}));
  await main(['start','--config',b.config]);
  await stalePage.locator('[data-note="first/one-step"]').fill('Stale Glade tab must not write to Runway');
  await stalePage.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('Saved in this browser'));
  const otherNotes=await (await fetch(`${a.url}api/boards/first-steps/notes`)).json();
  assert.equal(otherNotes['first/one-step'].note,'Runway only');
  await stalePage.close();
  await a.page.goto(`${a.url}boards/first-steps/`);
  await a.page.waitForFunction(()=>document.querySelector('#project-label').textContent==='Runway');
  await a.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
  assert.equal(await a.page.locator('[data-note="first/one-step"]').inputValue(),'Runway only');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({passed:true,evidence,checks:['two simultaneous labels and URLs','folder discovery','new-board prompt','isolated notes, same-origin port reuse and stale-tab write rejection','wide/collapsed/narrow headers','zoom and reset','independent experiment interaction','active preview safely offers reload'],browserErrors:errors},null,2));
}finally{
  await browser.close();
  for(const {config} of instances)await main(['stop','--config',config]).catch(()=>{});
  await rm(fixtures,{recursive:true,force:true});
}
