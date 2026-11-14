import {legacyNote,saveLegacyNote,openLegacyItem} from './tile-test-helpers.mjs';
// Optional browser acceptance check; Playwright is a QA tool, not an app dependency.
import strictAssert from 'node:assert/strict';
// Count passing assertions so a run reports an exact number.
let assertions=0;
const counted=fn=>(...args)=>{const result=fn(...args);assertions++;return result;};
const assert=Object.assign(counted(strictAssert),Object.fromEntries(['equal','notEqual','deepEqual','match'].map(name=>[name,counted(strictAssert[name])])));
const assertCount=()=>assertions;
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {sliderFromZoom} from '../public/canvas-zoom.js';
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
// The former View panel's controls live in the opened Tinka's % menu.
const openView=async page=>{if(await page.locator('#reader-zoom-menu').isHidden())await page.locator('#reader-zoom-toggle').click();};
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
  await main(['board','create','keyboard','--config',a.config,'--title','Keyboard navigation']);
  const keyboardBoard=path.join(a.boards,'keyboard');
  const keyboardManifest={rounds:['first','second','third'].map((id,index)=>({id,number:String(index+1),title:`Round ${index+1}`,concepts:[{id:'pages',name:`Pages ${index+1}`,path:`${id}.html`}]})),revisions:{}};
  await writeFile(path.join(keyboardBoard,'rounds.json'),JSON.stringify(keyboardManifest));
  for(const round of keyboardManifest.rounds)await writeFile(path.join(keyboardBoard,`${round.id}.html`),`<!doctype html><title>Keyboard pages</title><body data-experiment="${round.id}"><h1>Keyboard pages</h1><output>0</output><input aria-label="Draft"><script>let page=0;addEventListener("keydown",event=>{if(event.target.tagName!=="INPUT"&&event.key==="ArrowRight"){event.preventDefault();document.querySelector("output").textContent=++page;}});</script>`);
  for(const round of keyboardManifest.rounds)await main(['status','--config',a.config,'--board','keyboard',`${round.id}/pages`,'ready','Keyboard test fixture']);
  // A small two-round board with one revision for history, footer, dot and shared-notes checks.
  await main(['board','create','history','--config',a.config,'--title','History']);
  const historyBoard=path.join(a.boards,'history');
  const historyManifest={rounds:[{id:'alpha',number:'01',date:'October 1, 2026',title:'Alpha',concepts:[{id:'one',number:'01',name:'One',hint:'Try the first thing.',path:'alpha-one.html'},{id:'two',number:'02',name:'Two',path:'alpha-two.html'}]},{id:'beta',number:'02',date:'October 2, 2026',title:'Beta',concepts:[{id:'three',number:'01',name:'Three',path:'beta-three.html'}]}],revisions:{'alpha/one':[{id:'v2',name:'Second',path:'alpha-one-v2.html',hint:'Compare the second.'}]}};
  await writeFile(path.join(historyBoard,'rounds.json'),JSON.stringify(historyManifest));
  for(const id of ['alpha-one','alpha-two','beta-three','alpha-one-v2'])await writeFile(path.join(historyBoard,`${id}.html`),`<!doctype html><title>${id}</title><body data-experiment="${id}"><h1>${id}</h1><script>const q=new URLSearchParams(location.search);document.body.dataset.theme=q.get("theme");document.body.dataset.scale=q.get("scale");addEventListener("message",event=>{if(event.data?.type==="reader-preferences"){document.body.dataset.theme=event.data.theme;document.body.dataset.scale=String(event.data.scale);}});</script>`);
  for(const key of ['alpha/one','alpha/two','beta/three'])await main(['status','--config',a.config,'--board','history',key,'ready','History test fixture']);
  await a.page.screenshot({path:path.join(evidence,'home-wide.png')});
  await a.page.locator('.new-board').first().click();
  assert((await a.page.locator('#agent-prompt').inputValue()).includes(a.config));
  assert((await a.page.locator('#agent-prompt').inputValue()).includes(a.url));
  const agentConfig=await (await fetch(`${a.url}api/config`)).json();
  const creationPrompt=await a.page.locator('#agent-prompt').inputValue();
  assert(creationPrompt.includes(agentConfig.appPath)&&creationPrompt.includes(agentConfig.agentGuidePath)&&creationPrompt.includes(agentConfig.protocolPath));
  assert(!creationPrompt.includes('Use the tinka skill'));
  assert((await a.page.locator('#agent-prompt').inputValue()).includes('Do not add a reference board'));
  await a.page.locator('.close').click();
  // Source files can update while an older managed server is still running.
  // Its config response has no app/instruction fields; prompts must stay useful.
  await a.page.route('**/api/config',async route=>{
    const response=await route.fetch();const config=await response.json();
    delete config.appPath;delete config.agentGuidePath;delete config.protocolPath;
    await route.fulfill({response,json:config});
  });
  await a.page.reload();
  await a.page.getByRole('heading',{name:'A better first step'}).waitFor();
  await a.page.locator('.new-board').first().click();
  const legacyPrompt=await a.page.locator('#agent-prompt').inputValue();
  assert(legacyPrompt.includes('.pid.json')&&!legacyPrompt.includes('undefined')&&!legacyPrompt.includes('Use the tinka skill'));
  await a.page.locator('.close').click();
  await a.page.locator('[data-remove-board="first-steps"]').click();
  assert((await a.page.locator('#agent-prompt-text').inputValue()).includes('.pid.json'));
  await a.page.keyboard.press('Escape');
  await a.page.unroute('**/api/config');
  await a.page.reload();
  await a.page.getByRole('heading',{name:'A better first step'}).waitFor();
  await main(['board','create','newly-added','--config',a.config,'--title','Newly added']);
  await a.page.getByRole('heading',{name:'Newly added'}).waitFor();
  assert.deepEqual((await (await fetch(`${a.url}api/boards/newly-added`)).json()).rounds,[]);
  // Copying a removal request stays local to this browser. Never touch the OS clipboard in QA.
  await a.page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPrompt=text;}}}));
  await a.page.locator('[data-remove-board="newly-added"]').click();
  let prompt=await a.page.locator('#agent-prompt-text').inputValue();
  assert(prompt.includes(a.config)&&prompt.includes(a.boards)&&prompt.includes('"id": "newly-added"'));
  assert(prompt.includes(agentConfig.agentGuidePath)&&prompt.includes(agentConfig.protocolPath)&&!prompt.includes('Use the tinka skill'));
  assert(prompt.includes('recoverable archive')&&!prompt.includes(b.config));
  await a.page.locator('#copy-agent-prompt').click();
  await a.page.waitForFunction(()=>document.querySelector('#agent-prompt-status').textContent.startsWith('Copied.'));
  assert.equal(await a.page.evaluate(()=>window.copiedPrompt),prompt);
  await a.page.screenshot({path:path.join(evidence,'board-removal-prompt.png')});
  await a.page.keyboard.press('Escape');
  assert.equal((await (await fetch(`${a.url}api/boards`)).json()).boards.some(board=>board.id==='newly-added'),true);
  await a.page.locator('[data-cover-board="newly-added"]').click();
  prompt=await a.page.locator('#agent-prompt-text').inputValue();
  assert(prompt.includes(a.config)&&prompt.includes('"id": "newly-added"')&&prompt.includes('1200 × 600')&&prompt.includes('assets/cover.svg'));
  await a.page.locator('#copy-agent-prompt').click();
  await a.page.waitForFunction(()=>document.querySelector('#agent-prompt-status').textContent.startsWith('Copied.'));
  assert.equal(await a.page.evaluate(()=>window.copiedPrompt),prompt);
  await a.page.screenshot({path:path.join(evidence,'cover-image-prompt.png')});
  await a.page.locator('.agent-dialog-close').click();
  // Simulate an agent adding and then updating a cover outside the usual assets folder.
  const coverBoard=path.join(a.boards,'newly-added');
  const coverMetadata=await saved(path.join(coverBoard,'board.json'));
  await mkdir(path.join(coverBoard,'art'));
  const coverSvg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><rect width="1200" height="600" fill="#254cd1"/><circle cx="600" cy="300" r="140" fill="#faf9f3"/></svg>';
  await writeFile(path.join(coverBoard,'art/cover.svg'),coverSvg);
  await writeFile(path.join(coverBoard,'board.json'),JSON.stringify({...coverMetadata,cover:'art/cover.svg'}));
  const coverCard=a.page.locator('.board-card').filter({has:a.page.getByRole('heading',{name:'Newly added',exact:true})});
  await coverCard.locator('img').waitFor();
  await coverCard.locator('img').evaluate(img=>new Promise((resolve,reject)=>{if(img.complete&&img.naturalWidth)resolve();else{img.onload=resolve;img.onerror=reject;}}));
  await coverCard.scrollIntoViewIfNeeded();
  assert.equal(await coverCard.locator('.board-art').evaluate(el=>Math.abs(el.clientWidth/el.clientHeight-2)<.02),true);
  await a.page.screenshot({path:path.join(evidence,'custom-board-cover.png')});
  await coverCard.locator('img').evaluate(img=>{window.previousCover=img;});
  await writeFile(path.join(coverBoard,'art/cover.svg'),coverSvg.replace('#254cd1','#526739'));
  await a.page.waitForFunction(()=>{
    const img=document.querySelector('img[src*="/boards/newly-added/files/art/cover.svg"]');
    return img&&img!==window.previousCover&&img.complete&&img.naturalWidth>0;
  });
  await writeFile(path.join(coverBoard,'board.json'),JSON.stringify({...coverMetadata,cover:'art/missing.svg'}));
  await coverCard.locator('.sheet').first().waitFor();
  assert.equal(await coverCard.locator('img').count(),0);
  for(const instance of instances){
    await instance.page.goto(`${instance.url}boards/first-steps/`);
    await instance.page.waitForFunction(()=>document.querySelectorAll('.concept-card').length===2);
    await instance.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
    assert((await instance.page.title()).includes(instance===a?'Tinka / Glade':'Tinka / Runway'));
    await saveLegacyNote(instance.page,'first/one-step',instance===a?'Glade only':'Runway only');
    await waitFor(async()=>{
      const notes=await (await fetch(`${instance.url}api/boards/first-steps/notes`)).json();
      return notes['first/one-step']?.note===(instance===a?'Glade only':'Runway only');
    },'Note persisted to its own instance');
  }
  const manifestBefore=await readFile(path.join(a.boards,'first-steps/rounds.json'),'utf8');
  const notesBefore=await readFile(path.join(a.boards,'first-steps/.state/notes.json'),'utf8');
  await a.page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPrompt=text;}}}));
  await a.page.locator('[data-legacy-menu="first/one-step"]').click();await a.page.locator('[data-remove-experiment="first/one-step"]').click();
  prompt=await a.page.locator('#agent-prompt-text').inputValue();
  assert(prompt.includes(a.config)&&prompt.includes('"key": "first/one-step"')&&prompt.includes('experiments/one-step/index.html'));
  assert(prompt.includes('Keep the source files, shared assets, notes')&&!prompt.includes(b.config));
  await a.page.locator('#copy-agent-prompt').click();
  await a.page.waitForFunction(()=>document.querySelector('#agent-prompt-status').textContent.startsWith('Copied.'));
  assert.equal(await a.page.evaluate(()=>window.copiedPrompt),prompt);
  await a.page.screenshot({path:path.join(evidence,'experiment-removal-prompt.png')});
  // A denied Clipboard API still leaves a selected, copyable prompt.
  await a.page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new Error('Clipboard denied');};});
  await a.page.locator('#copy-agent-prompt').click();
  await a.page.waitForFunction(()=>document.querySelector('#agent-prompt-status').textContent.startsWith('Select and copy'));
  assert.deepEqual(await a.page.locator('#agent-prompt-text').evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,prompt.length]);
  await a.page.locator('.agent-dialog-close').click();
  assert.equal(await a.page.evaluate(()=>document.activeElement.dataset.legacyMenu),'first/one-step');
  assert.equal(await readFile(path.join(a.boards,'first-steps/rounds.json'),'utf8'),manifestBefore);
  assert.equal(await readFile(path.join(a.boards,'first-steps/.state/notes.json'),'utf8'),notesBefore);
  // The header is identity only; board details, export and help live behind the quiet info control.
  await a.page.screenshot({path:path.join(evidence,'board-wide.png')});
  // Navigator (left, where), Find, and the Inspector toggle (right, what).
  assert.equal(await a.page.locator('#canvas-header button:visible').count(),3);
  await a.page.locator('#board-info-toggle').click();
  assert.equal(await a.page.locator('#board-info').isVisible(),true);
  assert.equal(await a.page.locator('#board-info-toggle').getAttribute('aria-expanded'),'true');
  assert((await a.page.locator('#board-description').textContent()).length>0);
  assert.equal(await a.page.locator('#experiment-count').textContent(),'2 experiments');
  assert.equal(await a.page.locator('#export').isVisible(),true);
  assert((await a.page.locator('#help-panel').textContent()).includes('Escape returns here'));
  await a.page.screenshot({path:path.join(evidence,'board-info-wide.png')});
  await a.page.keyboard.press('Escape');
  assert.equal(await a.page.locator('#board-info').isVisible(),false);
  assert.equal(await a.page.evaluate(()=>document.activeElement.id),'board-info-toggle');
  await a.page.setViewportSize({width:400,height:800});
  await a.page.screenshot({path:path.join(evidence,'board-narrow.png')});
  await a.page.locator('[data-legacy-menu="first/one-step"]').click();await a.page.locator('[data-remove-experiment="first/one-step"]').click();
  await a.page.screenshot({path:path.join(evidence,'removal-prompt-narrow.png')});
  assert.equal(await a.page.locator('#agent-prompt-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await a.page.locator('.agent-dialog-close').click();
  assert.deepEqual(await a.page.locator('#canvas-header').evaluate(el=>{const title=el.querySelector('#board-title'),tools=el.querySelector('#board-info-toggle');const t=title.getBoundingClientRect(),b=tools.getBoundingClientRect();return {overflow:el.scrollWidth>el.clientWidth,wrap:getComputedStyle(title).whiteSpace,overlap:t.left<b.right&&t.right>b.left&&t.top<b.bottom&&t.bottom>b.top};}),{overflow:false,wrap:'normal',overlap:false});
  assert.equal(await a.page.locator('#project-label').textContent(),'Home');
  assert.equal(await a.page.locator('.canvas-footer').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await a.page.locator('#fit').click();
  await a.page.locator('#board-info-toggle').click();
  await a.page.screenshot({path:path.join(evidence,'board-info-narrow.png')});
  await a.page.locator('#board-info-toggle').click();
  await a.page.goto(a.url);
  await a.page.getByRole('heading',{name:'A better first step'}).waitFor();
  await a.page.screenshot({path:path.join(evidence,'home-narrow.png')});
  await a.page.setViewportSize({width:1440,height:960});
  await a.page.goto(`${a.url}boards/first-steps/`);
  await legacyNote(a.page,'first/one-step');
  // Card markup appears before the asynchronous server-note hydration completes.
  await a.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
  assert.equal(await (await legacyNote(a.page,'first/one-step')).inputValue(),'Glade only');
  // Establish the initial resource revision before editing a mounted reader.
  await a.page.waitForFunction(()=>document.querySelector('#live-status').textContent.startsWith('Live')&&Boolean(document.querySelector('[data-key="first/one-step"]').dataset.liveRevision));
  await openLegacyItem(a.page,'first/one-step');
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
  // Tall and zoomed-out canvases must still align the requested exploration.
  await a.page.setViewportSize({width:1440,height:1200});
  await a.page.goto(`${a.url}boards/keyboard/`);
  await a.page.waitForFunction(()=>document.activeElement.id==='viewport');
  // The canvas pans its plane and zooms its world; read both from their transforms.
  const settledRound=async index=>a.page.waitForFunction(index=>{
    const zoom=Number(document.querySelector('#world').style.transform.match(/scale\(([^)]+)\)/)[1]);
    const top=-Number(document.querySelector('#plane').style.transform.match(/-?[\d.]+(?=px)/g)[1]);
    return document.querySelector('#round-status').textContent.startsWith(`Round ${index+1} /`)&&Math.abs(top-index*1220*zoom)<.5;
  },index,{timeout:8000}).catch(async error=>{
    const actual=await a.page.evaluate(()=>({hash:location.hash,pan:document.querySelector('#plane').style.transform,transform:document.querySelector('#world').style.transform,status:document.querySelector('#round-status').textContent}));
    throw new Error(`Round ${index+1} did not settle: ${JSON.stringify(actual)}; ${error.message}`);
  });
  const showRound=async id=>{
    // Choosing the round that is already in the address fires no event, so pass through the bare board first.
    if(await a.page.evaluate(()=>location.hash)===`#round-${id}`){await a.page.evaluate(()=>{location.hash='#';});await a.page.waitForFunction(()=>!location.hash);}
    await a.page.evaluate(id=>{location.hash=`#round-${id}`;},id);
  };
  const roundIds=['first','second','third'];
  for(const index of [0,1,2,0,2]){
    await showRound(roundIds[index]);
    await settledRound(index);
  }
  await a.page.screenshot({path:path.join(evidence,'round-three-tall.png')});
  // Home shows the first exploration; arrow keys belong to the canvas; panning by hand updates the quiet round status.
  await a.page.keyboard.press('Home');
  await settledRound(0);
  await a.page.keyboard.press('ArrowDown');
  await a.page.waitForFunction(()=>Number(document.querySelector('#plane').style.transform.match(/-?[\d.]+(?=px)/g)[1])<-75);
  assert(( await a.page.locator('#round-status').textContent()).startsWith('Round 1 /'));
  await a.page.mouse.move(720,600);
  await a.page.mouse.wheel(0,610);
  await a.page.waitForFunction(()=>document.querySelector('#round-status').textContent.startsWith('Round 2 /'));
  await a.page.locator('#zoom-slider').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},sliderFromZoom(.2));
  assert.equal(await a.page.locator('#world').evaluate(el=>el.style.transform),'scale(0.2)');
  await showRound('second');
  await settledRound(1);
  await a.page.emulateMedia({reducedMotion:'reduce'});
  await showRound('first');
  await settledRound(0);
  await showRound('third');
  await settledRound(2);
  await a.page.emulateMedia({reducedMotion:'no-preference'});
  // Opening, deep links and explicit reloads leave focus on Tinka, so its keys work at once; a click into the
  // experiment hands it the arrow keys.
  await openLegacyItem(a.page,'third/pages');
  const keyboardFrame=a.page.frameLocator('#active-reader');
  const readerFocused=()=>a.page.waitForFunction(()=>{const frame=document.querySelector('#active-reader');const doc=frame.contentDocument;const active=document.activeElement;return document.querySelector('#reader-dialog').contains(active)&&active!==frame&&doc?.readyState==='complete'&&doc.body?.dataset.experiment===location.hash.slice(1).split('/')[0];},null,{timeout:10000}).catch(async error=>{
    const actual=await a.page.evaluate(()=>{const frame=document.querySelector('#active-reader');const doc=frame.contentDocument;return {hash:location.hash,open:document.querySelector('#reader-dialog').open,active:document.activeElement?.id||document.activeElement?.tagName,ready:doc?.readyState,experiment:doc?.body?.dataset.experiment,inner:doc?.activeElement?.tagName,src:frame.src};});
    throw new Error(`Reader not focused: ${JSON.stringify(actual)}; ${error.message}`);
  });
  const intoExperiment=()=>keyboardFrame.locator('h1').click();
  await keyboardFrame.locator('h1').waitFor();
  await readerFocused();
  assert.equal(await a.page.evaluate(()=>document.activeElement.id),'reader-stage');
  await intoExperiment();
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  assert.equal(await a.page.locator('#reader-window').getAttribute('data-size'),'fit');
  await a.page.screenshot({path:path.join(evidence,'reader-keyboard-focus.png')});
  await openView(a.page);
  for(const id of ['reader-type','reader-theme','reader-standalone'])assert.equal(await a.page.locator(`#${id}`).isVisible(),true,id);
  await a.page.keyboard.press('Escape');
  await keyboardFrame.locator('input').fill('Keep my draft');
  keyboardManifest.rounds[2].title='Updated third round';
  await writeFile(path.join(keyboardBoard,'rounds.json'),JSON.stringify(keyboardManifest));
  await a.page.locator('#round-heading-third').filter({hasText:'Updated third round'}).waitFor({state:'attached'});
  assert.equal(await keyboardFrame.locator('input').inputValue(),'Keep my draft');
  assert.equal(await keyboardFrame.locator('input').evaluate(el=>el===document.activeElement),true);
  await a.page.locator('#close-reader').click();
  await a.page.waitForFunction(()=>document.activeElement.id==='viewport');
  const keyboardNote=await legacyNote(a.page,'third/pages');
  await keyboardNote.fill('Keep this note');
  await keyboardNote.evaluate(el=>el.setSelectionRange(3,7));
  keyboardManifest.rounds[2].title='Third round with notes';
  await writeFile(path.join(keyboardBoard,'rounds.json'),JSON.stringify(keyboardManifest));
  await a.page.locator('#round-heading-third').filter({hasText:'Third round with notes'}).waitFor();
  assert.deepEqual(await keyboardNote.evaluate(el=>[el===document.activeElement,el.value,el.selectionStart,el.selectionEnd]),[true,'Keep this note',3,7]);
  await a.page.goto(`${a.url}boards/keyboard/#first/pages`);
  await keyboardFrame.locator('h1').waitFor();
  await readerFocused();
  await intoExperiment();
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  await writeFile(path.join(keyboardBoard,'first.html'),(await readFile(path.join(keyboardBoard,'first.html'),'utf8')).replace('Keyboard pages</h1>','Updated keyboard pages</h1>'));
  await a.page.locator('#reader-update').waitFor({state:'visible'});
  await a.page.locator('#reader-update').click();
  await keyboardFrame.getByRole('heading',{name:'Updated keyboard pages'}).waitFor();
  await readerFocused();
  await intoExperiment();
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  await a.page.keyboard.press('Escape');
  await a.page.locator('#reader-dialog').waitFor({state:'hidden'});
  await a.page.waitForFunction(()=>document.activeElement.id==='viewport');
  // Step through experiments without leaving the viewer or changing comparison settings.
  await a.page.goto(`${a.url}boards/keyboard/#first/pages`);
  await readerFocused();
  const position=()=>a.page.locator('#reader-count').textContent();
  await a.page.waitForFunction(()=>document.querySelector('#reader-count').textContent==='1 / 3');
  assert.equal(await a.page.locator('#reader-previous').isDisabled(),true);
  await openView(a.page);
  await a.page.locator('#reader-zoom-menu [data-size="compact"]').click();
  await a.page.locator('#reader-theme').click();
  await a.page.locator('#reader-type').focus();
  await a.page.keyboard.press('ArrowRight');
  await a.page.keyboard.press('ArrowRight');
  await a.page.keyboard.press('Escape');
  await a.page.locator('#reader-next').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 2');
  assert.equal(new URL(a.page.url()).hash,'#second/pages');
  assert.equal(await position(),'2 / 3');
  assert.deepEqual(await a.page.evaluate(()=>[document.querySelector('#reader-window').dataset.size,document.querySelector('#reader-theme').getAttribute('aria-pressed'),document.querySelector('#reader-type').value]),['compact','true','130']);
  await a.page.locator('#reader-next').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-next').isDisabled(),true);
  // At the end, focus falls back to Tinka; the experiment still gets the arrows once it has focus.
  await intoExperiment();
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 3');
  await a.page.screenshot({path:path.join(evidence,'reader-navigation-wide.png')});
  // Status changes update the sequence without replacing the current preview.
  await main(['status','--config',a.config,'--board','keyboard','second/pages','building','Updating fixture']);
  await a.page.waitForFunction(()=>document.querySelector('#reader-count').textContent==='2 / 2');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  await a.page.locator('#reader-previous').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 1');
  await main(['status','--config',a.config,'--board','keyboard','third/pages','reserved','Reserved fixture']);
  await a.page.waitForFunction(()=>document.querySelector('#reader-count').textContent==='1 / 1');
  assert.equal(await a.page.locator('#reader-next').isDisabled(),true);
  assert.equal(await a.page.locator('#reader-previous').isDisabled(),true);
  for(const id of ['second','third'])await main(['status','--config',a.config,'--board','keyboard',`${id}/pages`,'ready','Keyboard test fixture']);
  await a.page.waitForFunction(()=>document.querySelector('#reader-count').textContent==='1 / 3');
  await a.page.setViewportSize({width:400,height:800});
  await a.page.locator('#reader-next').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 2');
  for(const selector of ['.reader-header','.reader-footer'])assert.equal(await a.page.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth),true,selector);
  await a.page.screenshot({path:path.join(evidence,'reader-navigation-narrow.png')});
  await a.page.locator('#close-reader').click();
  await a.page.setViewportSize({width:1440,height:1200});
  // Let the short return-to-tile flight finish before navigating to another round.
  await a.page.waitForTimeout(500);
  // Simulate a shell update only in this browser; the user's running app is untouched.
  await showRound('third');
  await settledRound(2);
  await a.page.waitForFunction(()=>document.querySelector('#live-status').textContent.startsWith('Live ·'));
  const shellDocument=await a.page.evaluate(()=>window.__shellFixtureDocument=crypto.randomUUID());
  // Click the visible scaled card directly, without Playwright scrolling its transformed ancestors.
  await a.page.locator('[data-legacy-menu="third/pages"]').click();
  const promptButton=await a.page.locator('[data-remove-experiment="third/pages"]').boundingBox();
  const canvasTransforms=()=>({pan:document.querySelector('#plane').style.transform,zoom:document.querySelector('#world').style.transform});
  const beforePrompt=await a.page.evaluate(canvasTransforms);
  await a.page.mouse.click(promptButton.x+promptButton.width/2,promptButton.y+promptButton.height/2);
  await a.page.locator('#agent-prompt-dialog').waitFor();
  const viewBeforeReload=await a.page.evaluate(canvasTransforms);
  await a.page.locator('.agent-dialog-close').focus();
  const shellConfig=await fetch(`${a.url}api/config`).then(response=>response.json());
  await a.page.route(/\/api\/events\?.*board=keyboard/,async route=>{
    const snapshot=await fetch(`${a.url}api/boards/keyboard/live`).then(response=>response.json());
    const changed={...snapshot,runtimeId:shellConfig.workspaceId,shellRevision:'browser-fixture-shell',revision:`browser-fixture-${snapshot.revision}`};
    await route.fulfill({contentType:'text/event-stream',headers:{'Cache-Control':'no-store'},body:`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify(changed)}\n\n`});
  });
  // Reconnect this page's stream so the browser-only shell fixture is received.
  await a.page.evaluate(()=>dispatchEvent(new Event('online')));
  await a.page.locator('#live-refresh').waitFor({state:'visible'});
  await a.page.waitForTimeout(1500);
  assert.equal(await a.page.locator('#agent-prompt-dialog').isVisible(),true);
  await a.page.locator('.agent-dialog-close').click();
  await a.page.waitForTimeout(1500);
  assert.equal(await a.page.evaluate(()=>window.__shellFixtureDocument),shellDocument,'Shell updates wait for explicit Refresh after the dialog closes');
  assert.deepEqual(await a.page.evaluate(canvasTransforms),viewBeforeReload);
  const shellReload=a.page.waitForEvent('load');
  await a.page.locator('#live-refresh').click();
  await shellReload;
  await a.page.waitForFunction(()=>document.activeElement.id==='viewport');
  await a.page.waitForFunction(view=>{
    return document.querySelector('#plane').style.transform===view.pan&&document.querySelector('#world').style.transform===view.zoom&&document.querySelector('#round-status').textContent.startsWith('Round 3 /');
  },viewBeforeReload,{timeout:8000}).catch(async error=>{
    const actual=await a.page.evaluate(()=>({pan:document.querySelector('#plane').style.transform,zoom:document.querySelector('#world').style.transform,round:document.querySelector('#round-status').textContent}));
    throw new Error(`Canvas view after shell reload: before prompt ${JSON.stringify(beforePrompt)}, expected ${JSON.stringify(viewBeforeReload)}, actual ${JSON.stringify(actual)}; ${error.message}`);
  });
  // Drain the complete SSE shell stub before leaving this browser-only fixture.
  await a.page.unrouteAll({behavior:'wait'});
  await a.page.goto(`${a.url}boards/first-steps/`);

  // ---- Real browser history, card 10 footers, dots, and notes shared between card and reader ----
  const h=await context.newPage();h.on('pageerror',error=>errors.push(error.message));
  // Count real entries with the Navigation API. Chrome's history.length can stay stale after a pushState that
  // coincides with a frame commit, although the entries (and Back/Forward) are right; view-only checks compare both.
  const length=()=>h.evaluate(()=>navigation.entries().length);
  const historyLength=()=>h.evaluate(()=>history.length);
  const hashNow=()=>h.evaluate(()=>location.hash);
  const frameIds={'One':'alpha-one','Two':'alpha-two','Three':'beta-three','One · Second':'alpha-one-v2'};
  const waitReader=name=>h.waitForFunction(([name,id])=>{const dialog=document.querySelector('#reader-dialog');const doc=document.querySelector('#active-reader').contentDocument;return dialog.open&&document.querySelector('#reader-name').textContent===name&&doc?.readyState==='complete'&&doc.body?.dataset.experiment===id;},[name,frameIds[name]]);
  const waitBoard=()=>h.waitForFunction(()=>!document.querySelector('#reader-dialog').open&&document.querySelectorAll('.concept-card').length===3&&document.querySelector('#save-status').dataset.state);
  const frameData=()=>h.locator('#active-reader').evaluate(frame=>({...frame.contentDocument.body.dataset}));
  const boardView=()=>h.evaluate(()=>({pan:document.querySelector('#plane').style.transform,transform:document.querySelector('#world').style.transform}));
  // Leaving a reader keeps the view when its tile is comfortably visible; otherwise it lands on that tile.
  const landedOn=async(key,view)=>{await h.waitForTimeout(500);const now=await boardView();if(JSON.stringify(now)===JSON.stringify(view))return;assert.equal(await h.locator(`[data-key="${key}"]`).evaluate(el=>{const v=document.querySelector('#viewport').getBoundingClientRect(),r=el.getBoundingClientRect();return r.left>=v.left&&r.right<=v.right&&r.top>=v.top&&r.bottom<=v.bottom;}),true,`Returned to ${key}`);};
  // The pan, zoom and board content edges (inside the world's padding) relative to the canvas, in pixels.
  const canvasState=()=>h.evaluate(()=>{
    const v=document.querySelector('#viewport');const vr=v.getBoundingClientRect();
    const w=document.querySelector('#world');const wr=w.getBoundingClientRect();
    const z=Number(w.style.transform.match(/scale\(([^)]+)\)/)[1]);const pad=70*z;
    const [x,y]=document.querySelector('#plane').style.transform.match(/-?[\d.]+(?=px)/g).map(Number);
    return {x,y,z,left:wr.left-vr.left+pad,top:wr.top-vr.top+pad,right:wr.right-vr.left-pad,bottom:wr.bottom-vr.top-pad,width:v.clientWidth,height:v.clientHeight,vl:vr.left,vt:vr.top,scroll:[v.scrollLeft,v.scrollTop]};
  });
  // Drag the canvas by (dx, dy) from a point that is not a text field, chosen so the whole drag stays in the window.
  const dragCanvas=async(dx,dy)=>{
    const start=await h.evaluate(([dx,dy])=>{
      const v=document.querySelector('#viewport').getBoundingClientRect();
      const xs=dx>0?[v.left+40,v.left+120,v.left+200]:dx<0?[v.right-40,v.right-120,v.right-200]:[v.left+v.width/2,v.left+80,v.right-80];
      const ys=dy>0?[v.top+40,v.top+120,v.top+200]:dy<0?[v.bottom-40,v.bottom-120,v.bottom-200]:[v.top+v.height/2,v.top+80,v.bottom-80];
      for(const y of ys)for(const x of xs){const el=document.elementFromPoint(x,y);if(el&&!el.closest('textarea,input,select,a'))return {x,y};}
      return null;
    },[dx,dy]);
    assert(start,'A drag start point is available');
    await h.mouse.move(start.x,start.y);await h.mouse.down();
    await h.mouse.move(start.x+dx/2,start.y+dy/2,{steps:5});await h.mouse.move(start.x+dx,start.y+dy,{steps:5});
    await h.mouse.up();
  };
  const near=(a,b)=>Math.abs(a-b)<1.5;
  // The zoom slider is logarithmic: set and read it in percent.
  const setRange=(selector,percent)=>h.locator(selector).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},sliderFromZoom(percent/100));
  const zoomPercent=async()=>parseInt(await h.locator('#zoom-slider').getAttribute('aria-valuetext'),10);
  await h.goto(a.url);
  await h.getByRole('heading',{name:'History'}).waitFor();
  // Home -> board is real page navigation.
  await h.locator('a.board-link[href="/boards/history/"]').click();
  await h.waitForURL(`${a.url}boards/history/`);
  await waitBoard();
  const base=await length();
  const baseHistoryLength=await historyLength();
  // Removed chrome stays removed; the board footer carries the view controls.
  assert.equal(await h.locator('select:not(#navigator-scope):not([aria-label="Appearance"])').count(),0);
  // One in the board's Inspector, one in an opened Tinka's.
  assert.equal(await h.getByRole('combobox',{name:'Appearance',includeHidden:true}).count(),2);
  assert.equal(await h.locator('#round-picker, #concept-nav, [data-jump], #zoom-in, #zoom-out, #zoom-level, #overview, #reset-view, #toggle-header, .toolbar, .intro, .reader-bar, .reader-bottom, #reader-size').count(),0);
  assert.equal(await h.locator('#canvas-header button:visible').count(),3);
  // One floating view pill: − · percent menu (with the precise slider) · + · Fit.
  assert.equal(await h.locator('.canvas-footer .zoom-pill #zoom-menu-toggle').isVisible(),true);
  assert.equal(await h.locator('.canvas-footer #zoom-slider').count(),1);
  assert.equal(await h.locator('.canvas-footer #fit').isVisible(),true);
  assert.equal(await h.locator('#dot-track').isVisible(),false);
  assert.equal(await zoomPercent(),50);
  assert.equal(await h.locator('#zoom-slider').getAttribute('aria-valuetext'),'50 percent');
  // Board zoom: slider, Control-wheel, keyboard, Safari gesture and two-finger pinch stay in sync with the slider.
  await setRange('#zoom-slider',100);
  assert.equal((await boardView()).transform,'scale(1)');
  await h.locator('#zoom-slider').evaluate(el=>el.value='0');
  await h.mouse.move(700,500);
  await h.keyboard.down('Control');
  await h.mouse.wheel(0,-60);
  await h.keyboard.up('Control');
  await h.waitForFunction(full=>Number(document.querySelector('#zoom-slider').value)>full,sliderFromZoom(1));
  const wheelZoom=Number(await h.locator('#zoom-slider').inputValue());
  await h.locator('#viewport').focus();
  await h.keyboard.press('-');
  assert(Number(await h.locator('#zoom-slider').inputValue())<wheelZoom);
  await h.keyboard.press('+');
  assert.equal(Number(await h.locator('#zoom-slider').inputValue()),wheelZoom);
  await setRange('#zoom-slider',50);
  await h.locator('#viewport').evaluate(el=>{const event=new Event('gesturestart',{cancelable:true});el.dispatchEvent(event);const change=Object.assign(new Event('gesturechange',{cancelable:true}),{scale:1.5,clientX:700,clientY:500});el.dispatchEvent(change);});
  assert.equal(await zoomPercent(),75);
  await setRange('#zoom-slider',40);
  await h.locator('#viewport').evaluate(el=>{
    const send=(type,id,x,y)=>el.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',isPrimary:id===11,clientX:x,clientY:y,bubbles:true,cancelable:true}));
    send('pointerdown',11,600,500);send('pointerdown',12,700,500);send('pointermove',11,550,500);send('pointermove',12,750,500);send('pointerup',11,550,500);send('pointerup',12,750,500);
  });
  assert.equal(await zoomPercent(),80);
  // The scroll wheel pans, and dragging empty canvas pans in both directions.
  await setRange('#zoom-slider',100);
  await h.mouse.move(700,500);
  const beforeWheel=await canvasState();
  await h.mouse.wheel(400,400);
  const afterWheel=await canvasState();
  assert(near(beforeWheel.x-afterWheel.x,400)&&near(beforeWheel.y-afterWheel.y,400),`Wheel pans the canvas: ${JSON.stringify([beforeWheel,afterWheel])}`);
  const empty=await h.evaluate(()=>{const v=document.querySelector('#viewport').getBoundingClientRect();for(let y=v.top+40;y<v.bottom-200;y+=20)for(let x=v.left+40;x<v.right-260;x+=20){const el=document.elementFromPoint(x,y);if(el&&el.matches('#viewport,#plane,#world,.round,.concepts,.round-header,.card-copy,.future-row'))return {x,y};}return null;});
  assert(empty,'An empty canvas point is available');
  const beforePan=await canvasState();
  await h.mouse.move(empty.x,empty.y);await h.mouse.down();await h.mouse.move(empty.x+120,empty.y+90,{steps:6});await h.mouse.move(empty.x+200,empty.y+150,{steps:6});await h.mouse.up();
  const afterPan=await canvasState();
  assert(near(afterPan.x-beforePan.x,200)&&near(afterPan.y-beforePan.y,150),`Drag pans the canvas: ${JSON.stringify([beforePan,afterPan])}`);
  // Free pan: the canvas moves past every edge of the board and stops only with KEEP (80px) of it left in view.
  await setRange('#zoom-slider',50);
  for(let i=0;i<3;i++)await dragCanvas(900,0);
  let pan=await canvasState();
  assert(near(pan.left,pan.width-80),`Dragging right passes the board's left edge: ${JSON.stringify(pan)}`);
  for(let i=0;i<4;i++)await dragCanvas(-900,0);
  pan=await canvasState();
  assert(near(pan.right,80),`Dragging left passes the board's right edge: ${JSON.stringify(pan)}`);
  for(let i=0;i<4;i++)await dragCanvas(0,600);
  pan=await canvasState();
  assert(near(pan.top,pan.height-80),`Dragging down passes the board's top edge: ${JSON.stringify(pan)}`);
  for(let i=0;i<5;i++)await dragCanvas(0,-600);
  pan=await canvasState();
  assert(near(pan.bottom,80)&&near(pan.right,80),`Dragging up passes the board's bottom edge: ${JSON.stringify(pan)}`);
  // Keyboard focus (and find-in-page, which reveals the same way) brings a control into view from any side.
  const opener=h.locator('[data-legacy-menu="alpha/one"]');
  await opener.focus();
  // The browser's scroll arrives as a scroll event on the next frame and becomes a pan.
  await h.waitForFunction(()=>{const v=document.querySelector('#viewport');return v.scrollLeft===100000&&v.scrollTop===100000;});
  const openerBox=await opener.boundingBox();
  pan=await canvasState();
  assert(openerBox.x>=pan.vl&&openerBox.y>=pan.vt&&openerBox.x+openerBox.width<=pan.vl+pan.width&&openerBox.y+openerBox.height<=pan.vt+pan.height,`Focus reveals a control above and left of the view: ${JSON.stringify([openerBox,pan])}`);
  assert.deepEqual(pan.scroll,[100000,100000]);
  // Zooming in on the sliver of board left at an edge keeps that spot under the pointer.
  for(let i=0;i<3;i++)await dragCanvas(900,0);
  pan=await canvasState();
  const anchor={x:pan.vl+pan.left+40,y:pan.vt+pan.height/2};
  const anchored=[(anchor.x-pan.vl-pan.x)/pan.z,(anchor.y-pan.vt-pan.y)/pan.z];
  await h.mouse.move(anchor.x,anchor.y);await h.keyboard.down('Control');await h.mouse.wheel(0,-60);await h.keyboard.up('Control');
  const zoomedIn=await canvasState();
  assert(zoomedIn.z>pan.z&&near(zoomedIn.vl+zoomedIn.x+anchored[0]*zoomedIn.z,anchor.x)&&near(zoomedIn.vt+zoomedIn.y+anchored[1]*zoomedIn.z,anchor.y),`Zoom near an edge stays anchored: ${JSON.stringify([anchor,pan,zoomedIn])}`);
  // Fit, even far from the board, shows every exploration on both axes, centred.
  await h.locator('#fit').click();
  const fit=await h.evaluate(()=>{const v=document.querySelector('#viewport').getBoundingClientRect();return [...document.querySelectorAll('.concept-card')].every(card=>{const r=card.getBoundingClientRect();return r.left>=v.left-1&&r.right<=v.right+1&&r.top>=v.top-1&&r.bottom<=v.bottom+1;});});
  assert.equal(fit,true);
  pan=await canvasState();
  assert(near((pan.left+pan.right)/2,pan.width/2)&&near((pan.top+pan.bottom)/2,pan.height/2),`Fit centres the board: ${JSON.stringify(pan)}`);
  const fitScale=Number((await boardView()).transform.match(/scale\(([^)]+)\)/)[1]);
  assert.equal(await zoomPercent(),Math.round(fitScale*100));
  await h.screenshot({path:path.join(evidence,'history-board-fit.png')});
  // Keys pan the canvas: arrows by 80px, Page Down by most of a screen; Home and End show the first and last explorations.
  await h.locator('#viewport').focus();
  const beforeKeys=await canvasState();
  await h.keyboard.press('ArrowLeft');await h.keyboard.press('ArrowUp');
  const afterKeys=await canvasState();
  assert(near(afterKeys.x-beforeKeys.x,80)&&near(afterKeys.y-beforeKeys.y,80),`Arrow keys pan: ${JSON.stringify([beforeKeys,afterKeys])}`);
  await h.keyboard.press('PageDown');
  await h.waitForFunction(y=>Math.abs(Number(document.querySelector('#plane').style.transform.match(/-?[\d.]+(?=px)/g)[1])-y)<1.5,afterKeys.y-afterKeys.height*.875);
  await h.keyboard.press('End');
  await h.waitForFunction(()=>document.querySelector('#round-status').textContent.startsWith('Round 02 /'));
  await h.keyboard.press('Home');
  await h.waitForFunction(()=>document.querySelector('#round-status').textContent.startsWith('Round 01 /'));
  // View-only board changes never add history entries.
  assert.equal(await length(),base);
  assert.equal(await historyLength(),baseHistoryLength);
  assert.equal(await hashNow(),'');
  await h.locator('#board-info-toggle').click();
  await h.locator('#board-info-toggle').click();
  await setRange('#zoom-slider',50);
  await h.locator('#viewport').focus();
  await h.keyboard.press('Home');
  await h.locator('.shortlist[data-star="alpha/two"]').click();
  await saveLegacyNote(h,'alpha/two','Card note');
  assert.equal(await length(),base);
  assert.equal(await historyLength(),baseHistoryLength);
  assert.equal(await hashNow(),'');
  // Star and note on the card appear in the experiment view, and back.
  await openLegacyItem(h,'alpha/one');
  await waitReader('One');
  assert.equal(await hashNow(),'#alpha/one');
  assert.equal(await length(),base+1);
  const readerHistoryLength=await historyLength();
  // The concept's authored number continues inside the item's name.
  assert.equal(await h.title(),'Tinka / Glade / History / 01 · One');
  // Up names the board, as ‹ Parent does on a board.
  assert.equal(await h.locator('#reader-dialog .reader-header #reader-up-label').textContent(),'History');
  assert.equal(await h.locator('#reader-hint').textContent(),'Try the first thing.');
  assert((await h.locator('#reader-path').getAttribute('title')).includes('Try the first thing.'));
  assert.equal(await h.locator('#reader-standalone').getAttribute('href'),'/boards/history/files/alpha-one.html');
  assert.equal(await h.locator('#reader-standalone').getAttribute('target'),'_blank');
  // The stepper and the path's neighbour list follow board order across rounds; endpoints are disabled.
  assert.equal(await h.locator('#reader-count').textContent(),'1 / 3');
  await h.locator('#reader-count').click();
  assert.deepEqual(await h.locator('#reader-path-pop .reader-path-sibs .reader-path-title').allTextContents(),['01 · One','02 · Two','01 · Three']);
  assert.equal(await h.evaluate(()=>document.activeElement.closest('.reader-path-sibs')?document.activeElement.getAttribute('aria-current'):null),null,'A mouse click leaves focus where it was');
  await h.keyboard.press('Escape');
  assert.equal(await h.locator('#reader-path-pop').isVisible(),false);
  assert.equal(await h.locator('#reader-previous').isDisabled(),true);
  assert.equal(await h.locator('#reader-next').isDisabled(),false);
  // The former View controls (Type, Light, Window with Version, standalone) live in the % menu. None add history entries.
  assert.deepEqual(await frameData(),{experiment:'alpha-one',theme:'paper',scale:'100'});
  await openView(h);
  await h.locator('#reader-type').focus();
  await h.keyboard.press('ArrowRight');
  assert.equal(await h.locator('#reader-type').getAttribute('aria-valuetext'),'115%');
  await h.waitForFunction(()=>document.querySelector('#active-reader').contentDocument.body.dataset.scale==='115');
  await h.locator('#reader-theme').click();
  assert.equal(await h.locator('#reader-theme').getAttribute('aria-pressed'),'true');
  await h.waitForFunction(()=>document.querySelector('#active-reader').contentDocument.body.dataset.theme==='night');
  assert.equal(await h.locator('#size-menu').isVisible(),true);
  assert.equal(await h.locator('#reader-zoom-toggle').getAttribute('aria-expanded'),'true');
  assert.deepEqual(await h.locator('#size-menu [data-size]:visible').evaluateAll(buttons=>buttons.map(button=>button.dataset.size)),['fit','compact','standard','wide']);
  assert.deepEqual(await h.locator('#revision-options [data-revision-choice]').evaluateAll(buttons=>buttons.map(button=>[button.textContent,button.getAttribute('aria-pressed')])),[['Original','true'],['Second','false']]);
  assert.equal(await h.locator('#revision-group').isVisible(),true);
  await h.screenshot({path:path.join(evidence,'history-size-popover.png')});
  await h.locator('#size-menu [data-size="standard"]').click();
  assert.deepEqual(await h.evaluate(()=>[document.querySelector('#reader-window').dataset.size,document.querySelector('#size-menu [data-size="standard"]').getAttribute('aria-pressed')]),['standard','true']);
  assert((await h.locator('#reader-zoom-toggle').getAttribute('title')).includes('Window: Standard'));
  await h.keyboard.press('Escape');
  assert.equal(await h.locator('#size-menu').isVisible(),false);
  assert.equal(await h.evaluate(()=>document.activeElement.id),'reader-zoom-toggle');
  assert.equal(await h.locator('#reader-dialog').evaluate(dialog=>dialog.open),true);
  await openView(h);
  await h.locator('.reader-stage').click({position:{x:8,y:8}});
  assert.equal(await h.locator('#size-menu').isVisible(),false);
  await h.locator('#reader-window').evaluate(el=>{el.style.width='600px';el.style.height='500px';});
  await h.waitForFunction(()=>document.querySelector('#size-menu [data-size="custom"]').getAttribute('aria-pressed')==='true');
  await openView(h);
  assert.equal(await h.locator('#size-menu [data-size="custom"]').isVisible(),true);
  assert.equal(await h.locator('#custom-size').textContent(),'600 × 500');
  await h.locator('#size-menu [data-size="fit"]').click();
  assert.deepEqual(await h.evaluate(()=>[document.querySelector('#reader-window').dataset.size,document.querySelector('#reader-window').style.width,document.querySelector('#size-menu [data-size="fit"]').getAttribute('aria-pressed')]),['fit','','true']);
  await h.keyboard.press('Escape');
  // Hovering the title shows where you are and what sits beside it.
  await h.locator('#reader-path').hover();
  await h.locator('#reader-path-pop').waitFor({state:'visible'});
  assert.deepEqual(await h.locator('#reader-path-pop .reader-path-ladder .reader-path-title').allTextContents(),['Home','History','01 · One']);
  assert.equal(await h.locator('#reader-name').textContent(),'One');
  await h.mouse.move(10,700);
  await h.locator('#reader-path-pop').waitFor({state:'hidden'});
  assert.equal(await length(),base+1);
  assert.equal(await historyLength(),readerHistoryLength);
  assert.equal(await hashNow(),'#alpha/one');
  // Notes panel: same store as the card, open across navigation, never covering the stage.
  assert.equal(await h.locator('.note-dot').isVisible(),false);
  await h.locator('#notes-toggle').click();
  assert.equal(await h.locator('#notes-panel').isVisible(),true);
  assert.equal(await h.evaluate(()=>document.activeElement.id),'reader-note');
  await h.keyboard.type('Shared from the reader');
  await h.waitForFunction(()=>document.querySelector('#reader-save-status').textContent==='Notes saved on this Mac'&&document.querySelector('#save-status').dataset.state==='saved');
  assert.equal(await h.locator('.note-dot').isVisible(),true);
  assert.equal(await h.locator('#reader-note').inputValue(),'Shared from the reader');
  await waitFor(async()=>(await saved(path.join(a.boards,'history/.state/notes.json')))['alpha/one']?.note==='Shared from the reader','Reader note persisted to .state/notes.json');
  // The notes sit beside (or, on a phone, below) the canvas; the window stays inside the canvas and clear of the pill.
  const noOverlap=()=>h.evaluate(()=>{const stage=document.querySelector('.reader-stage').getBoundingClientRect();const panel=document.querySelector('#notes-panel').getBoundingClientRect();const viewer=document.querySelector('#reader-window').getBoundingClientRect();const pill=document.querySelector('.reader-footer .zoom-pill').getBoundingClientRect();const side=panel.left>=stage.right-.5&&panel.top<stage.bottom;const below=panel.top>=stage.bottom-.5;return {separate:side||below,mode:side?'side':below?'sheet':'overlap',viewerInside:viewer.left>=stage.left-.5&&viewer.right<=stage.right+.5&&viewer.top>=stage.top-.5&&viewer.bottom<=stage.bottom+.5,pillInCanvas:pill.right<=stage.right+.5&&pill.bottom<=stage.bottom+.5,viewerAbovePill:viewer.bottom<=pill.top+.5,width:Math.round(panel.width)};});
  assert.deepEqual(await noOverlap(),{separate:true,mode:'side',viewerInside:true,pillInCanvas:true,viewerAbovePill:true,width:320});
  await h.screenshot({path:path.join(evidence,'history-reader-notes-wide.png')});
  await h.locator('#reader-next').click();
  await waitReader('Two');
  assert.equal(await h.locator('#notes-panel').isVisible(),true);
  assert.equal(await h.locator('#reader-note').inputValue(),'Card note');
  assert.equal(await h.locator('#reader-star').getAttribute('aria-pressed'),'true');
  assert.equal(await h.locator('#revision-group').isVisible(),false);
  await h.locator('#reader-star').click();
  assert.equal(await h.locator('#reader-star').getAttribute('aria-pressed'),'false');
  assert.equal(await h.locator('.shortlist[data-star="alpha/two"]').getAttribute('aria-pressed'),'false');
  await waitFor(async()=>(await saved(path.join(a.boards,'history/.state/notes.json')))['alpha/two']?.star===false,'Reader star persisted to .state/notes.json');
  // Stepping replaces the entry: Back walks time (to the board), not the board's order.
  assert.equal(await length(),base+1);
  assert.equal(await hashNow(),'#alpha/two');
  await h.setViewportSize({width:390,height:844});
  await h.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.deepEqual(await noOverlap(),{separate:true,mode:'sheet',viewerInside:true,pillInCanvas:true,viewerAbovePill:true,width:390});
  for(const selector of ['.reader-header','.reader-footer'])assert.equal(await h.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth),true,selector);
  await h.screenshot({path:path.join(evidence,'history-reader-notes-narrow.png')});
  // The open notes field follows a step even while it has focus.
  await h.locator('#reader-note').focus();
  await h.evaluate(()=>document.querySelector('#reader-previous').click());
  await waitReader('One');
  assert.equal(await h.locator('#reader-note').inputValue(),'Shared from the reader');
  await h.evaluate(()=>document.querySelector('#reader-next').click());
  await waitReader('Two');
  assert.equal(await h.locator('#reader-note').inputValue(),'Card note');
  // Escape inside the notes field closes the panel only.
  await h.locator('#reader-note').focus();
  await h.keyboard.press('Escape');
  assert.equal(await h.locator('#notes-panel').isVisible(),false);
  assert.equal(await h.locator('#reader-dialog').evaluate(dialog=>dialog.open),true);
  assert.equal(await h.evaluate(()=>document.activeElement.id),'notes-toggle');
  await h.setViewportSize({width:1440,height:960});
  // Back/Forward walk time: the item you opened, then the board, then home; Forward returns to the exact states.
  await h.goBack();
  await waitBoard();
  assert.equal(await hashNow(),'');
  assert.equal(await h.title(),'Tinka / Glade / History');
  await h.goBack();
  await h.waitForURL(a.url);
  await h.getByRole('heading',{name:'History'}).waitFor();
  await h.goForward();
  await h.waitForURL(`${a.url}boards/history/`);
  await waitBoard();
  await h.goForward();
  await waitReader('Two');
  assert.equal(await hashNow(),'#alpha/two');
  assert.equal(await length(),base+1);
  // Escape and ‹ board each add one entry that browser Back reverses.
  await h.locator('#active-reader').focus();
  await h.keyboard.press('Escape');
  await waitBoard();
  assert.match(await hashNow(),/^#round-/);
  assert.equal(await length(),base+2);
  await h.goBack();
  await waitReader('Two');
  await h.locator('#reader-next').focus();
  await h.keyboard.press('Escape');
  await waitBoard();
  await h.goBack();
  await waitReader('Two');
  await h.locator('#close-reader').click();
  await waitBoard();
  assert.equal(await length(),base+2);
  await h.goBack();
  await waitReader('Two');
  await h.goForward();
  await waitBoard();
  // Back from an experiment restores exactly the board view that was left, here panned past the board's top-left edge.
  await setRange('#zoom-slider',80);
  await h.mouse.move(700,500);
  const beforeEdge=await canvasState();
  await h.mouse.wheel(Math.min(0,beforeEdge.left-300),Math.min(0,beforeEdge.top-200));
  const pastEdge=await canvasState();
  assert(pastEdge.left>0&&pastEdge.top>0,`The view is past the board's top-left edge: ${JSON.stringify(pastEdge)}`);
  const leftView=await boardView();
  await h.locator('[data-open="beta/three"].preview-launch').evaluate(button=>button.click());
  await waitReader('Three');
  await h.locator('#reader-previous').click();
  await waitReader('Two');
  await h.goBack();
  await waitBoard();
  await landedOn('alpha/two',leftView);
  await h.goForward();
  await waitReader('Two');
  await h.locator('#close-reader').click();
  await waitBoard();
  await landedOn('alpha/two',leftView);
  // Stepping by button, key or the path list adds no entries; re-choosing the current one changes nothing.
  await openLegacyItem(h,'alpha/one');
  await waitReader('One');
  let entries=await length();
  await openView(h);
  await h.locator('#revision-options [data-revision-choice="original"]').click();
  assert.equal(await length(),entries);
  assert.equal(await h.locator('#reader-zoom-menu').isVisible(),false,'Choosing a version closes the menu');
  await h.locator('#reader-count').click();
  await h.locator('#reader-path-pop .reader-path-sibs [data-path-go]').nth(2).click();
  await waitReader('Three');
  assert.equal(await h.locator('#reader-next').isDisabled(),true);
  assert.equal(await h.locator('#reader-previous').isDisabled(),false);
  await h.locator('#reader-stage').focus();
  await h.keyboard.press('[');
  await waitReader('Two');
  await h.keyboard.press('ArrowLeft');
  await waitReader('One');
  await h.keyboard.press('ArrowLeft');
  await h.keyboard.press(`${await h.evaluate(()=>/mac/i.test(navigator.userAgentData?.platform||navigator.platform))?'Alt':'Control'}+ArrowRight`);
  await waitReader('Two');
  await h.keyboard.press(']');
  await waitReader('Three');
  assert.equal(await length(),entries);
  await h.goBack();
  await waitBoard();
  await h.goForward();
  await waitReader('Three');
  // Switching versions is one entry; Back returns to the original.
  await h.locator('#reader-count').click();
  await h.locator('#reader-path-pop .reader-path-sibs [data-path-go]').nth(0).click();
  await waitReader('One');
  entries=await length();
  await openView(h);
  await h.locator('#revision-options [data-revision-choice="v2"]').click();
  await waitReader('One · Second');
  assert.equal(await hashNow(),'#alpha/one~v2');
  assert.equal(await length(),entries+1);
  assert.equal((await frameData()).experiment,'alpha-one-v2');
  assert.equal(await h.locator('#reader-hint').textContent(),'Compare the second.');
  assert.equal(await h.locator('#reader-standalone').getAttribute('href'),'/boards/history/files/alpha-one-v2.html');
  await h.goBack();
  await waitReader('One');
  assert.equal(await hashNow(),'#alpha/one');
  await h.goForward();
  await waitReader('One · Second');
  // Deep links and reloads restore board, round, experiment and version; bad addresses are normalized in place.
  await h.reload();
  await waitReader('One · Second');
  assert.equal(await h.locator('#revision-options [data-revision-choice="v2"]').getAttribute('aria-pressed'),'true');
  entries=await length();
  await h.goto(`${a.url}boards/history/#alpha/one~missing`);
  await waitReader('One');
  assert.equal(await hashNow(),'#alpha/one');
  assert.equal(await length(),entries+1);
  await h.goto(`${a.url}boards/history/#nothing/here`);
  await waitBoard();
  assert.equal(await hashNow(),'');
  assert.equal(await length(),entries+2);
  // Changing the round by address is one entry; Back and Forward move between rounds.
  await h.goto(`${a.url}boards/history/#round-alpha`);
  await waitBoard();
  await h.waitForFunction(()=>document.querySelector('#round-status').textContent.startsWith('Round 01 /'));
  entries=await length();
  // A round link still finds its exploration after the canvas has been panned far away.
  await h.mouse.move(700,500);
  await h.mouse.wheel(-2500,-2500);
  await h.evaluate(()=>{location.hash='#round-beta';});
  await h.waitForFunction(()=>{
    const zoom=Number(document.querySelector('#world').style.transform.match(/scale\(([^)]+)\)/)[1]);
    const top=-Number(document.querySelector('#plane').style.transform.match(/-?[\d.]+(?=px)/g)[1]);
    return document.querySelector('#round-status').textContent.startsWith('Round 02 /')&&Math.abs(top-1220*zoom)<2;
  });
  assert.equal(await length(),entries+1);
  await h.goBack();
  await h.waitForFunction(()=>location.hash==='#round-alpha'&&document.querySelector('#round-status').textContent.startsWith('Round 01 /'));
  await h.goForward();
  await h.waitForFunction(()=>location.hash==='#round-beta'&&document.querySelector('#round-status').textContent.startsWith('Round 02 /'));
  assert.equal(await length(),entries+1);
  await h.reload();
  await waitBoard();
  await h.waitForFunction(()=>document.querySelector('#round-status').textContent.startsWith('Round 02 /'));
  // Night and the reader at phone width.
  await h.goto(`${a.url}boards/history/#beta/three`);
  await waitReader('Three');
  await openView(h);
  await h.locator('#reader-theme').click();
  await h.setViewportSize({width:390,height:844});
  await h.screenshot({path:path.join(evidence,'history-reader-narrow.png')});
  await h.setViewportSize({width:1440,height:960});
  // ---- Footer and header layout at a few widths: footers stay one row, groups and controls never overlap, nothing
  // leaves the window or is clipped, the arrows hug the dot strip, the current dot is in view, Back never looks like
  // Previous, and targets stay 44px ----
  const sweepBoards=[['sweep-short','Short',3,2,false,0],['sweep-long','A board title long enough that it must truncate instead of pushing into the controls beside it',20,6,true,9]];
  const sweepKey=(perRound,i)=>`r${Math.floor(i/perRound)}/c${i}`;
  for(const [slug,title,count,perRound,longNames,current] of sweepBoards){
    await main(['board','create',slug,'--config',a.config,'--title',title]);
    const dir=path.join(a.boards,slug);const sweepRounds=[];
    for(let i=0;i<count;i++){
      const row=Math.floor(i/perRound);
      sweepRounds[row]??={id:`r${row}`,number:String(row+1).padStart(2,'0'),title:`Round ${row+1}`,concepts:[]};
      sweepRounds[row].concepts.push({id:`c${i}`,number:String(i+1).padStart(2,'0'),name:longNames?`An unusually long experiment name, number ${i+1}, that keeps on going`:`Card ${i+1}`,path:`c${i}.html`});
      await writeFile(path.join(dir,`c${i}.html`),`<!doctype html><title>c${i}</title><body data-experiment="c${i}"><h1>c${i}</h1>`);
    }
    await writeFile(path.join(dir,'v2.html'),'<!doctype html><title>v2</title><body data-experiment="v2">');
    await writeFile(path.join(dir,'rounds.json'),JSON.stringify({rounds:sweepRounds,revisions:{[sweepKey(perRound,current)]:[{id:'v2',name:'Second',path:'v2.html'}]}}));
    for(let i=0;i<count;i++)await main(['status','--config',a.config,'--board',slug,sweepKey(perRound,i),'ready','Sweep fixture']);
  }
  // Problems in one region at the current width.
  const layoutIssues=spec=>h.evaluate(spec=>{
    const issues=[];const vw=document.documentElement.clientWidth;
    const root=document.querySelector(spec.root);
    const shown=el=>{const style=getComputedStyle(el);const box=el.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0;};
    const rect=el=>{const b=el.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
    const overlap=(p,q)=>Math.min(p.right,q.right)-Math.max(p.left,q.left)>.5&&Math.min(p.bottom,q.bottom)-Math.max(p.top,q.top)>.5;
    const name=el=>el.id?`#${el.id}`:`.${[...el.classList].join('.')}`;
    if(root.scrollWidth>root.clientWidth+.5)issues.push(`${spec.root} scrolls sideways`);
    if(spec.withinWindow){const r=root.getBoundingClientRect();if(r.left<-.5||r.right>vw+.5)issues.push(`${spec.root} leaves the window`);}
    const groups=(spec.groups||[]).map(selector=>root.querySelector(selector)).filter(el=>el&&shown(el));
    groups.forEach((g,i)=>groups.slice(i+1).forEach(other=>{if(overlap(rect(g),rect(other)))issues.push(`${name(g)} overlaps ${name(other)}`);}));
    // One row: every group is centred on the same line.
    if(spec.oneRow){const centres=groups.map(g=>{const b=g.getBoundingClientRect();return (b.top+b.bottom)/2;});if(Math.max(...centres)-Math.min(...centres)>1.5)issues.push(`groups are not in one row (${centres.map(Math.round)})`);}
    const controls=[];
    for(const el of root.querySelectorAll('button,input,a[href],textarea,select')){
      if(!shown(el)||el.closest('[hidden],.board-info'+(spec.menus?'':',.zoom-menu')))continue;
      const r=rect(el);
      controls.push({el,r});
      if(r.left<-.5||r.right>vw+.5)issues.push(`${name(el)} leaves the window`);
      // Ancestors that hide overflow must not clip a control.
      for(let parent=el.parentElement;parent&&parent!==document.body&&parent!==root.parentElement;parent=parent.parentElement){
        const style=getComputedStyle(parent);
        // A menu scrolls its own rows; anything else that hides overflow must not clip a control.
        if(spec.menus&&parent===root)continue;
        if(style.overflowX!=='visible'||style.overflowY!=='visible'){const p=parent.getBoundingClientRect();if(r.left<p.left-.5||r.right>p.right+.5||r.top<p.top-.5||r.bottom>p.bottom+.5)issues.push(`${name(el)} clipped by ${name(parent)}`);}
      }
      // Chrome targets are 44px; the small status buttons carry a 44px hit area on a pseudo-element; menu rows are menu-sized.
      const b=el.getBoundingClientRect();
      if(!spec.menus&&!el.matches(spec.pseudoTargets||'#none')&&(b.height<43.5||b.width<43.5))issues.push(`${name(el)} target ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    if(!spec.menus)controls.forEach((c,i)=>controls.slice(i+1).forEach(d=>{if(overlap(c.r,d.r))issues.push(`${name(c.el)} overlaps ${name(d.el)}`);}));
    return {issues,height:Math.round(root.getBoundingClientRect().height)};
  },spec);
  const settle=()=>h.evaluate(()=>new Promise(requestAnimationFrame));
  const sweep=async(label,spec)=>{
    let height=null;
    for(const width of [320,390,768,1024,1244,1440,1920]){
      await h.setViewportSize({width,height:860});await settle();
      const result=await layoutIssues(spec);
      // A one-row bar keeps the same height at every width.
      if(spec.oneRow){height??=result.height;if(result.height!==height)result.issues.push(`height ${result.height}px instead of ${height}px`);}
      assert.deepEqual(result.issues,[],`${label} at ${width}px`);
    }
  };
  // The opened Tinka's pill is the board's: one row, 44px targets, at every width.
  const readerSpec={root:'.reader-footer',groups:['.zoom-pill'],oneRow:true};
  const footerShot=async(name,width)=>{await h.setViewportSize({width,height:860});await settle();await h.locator('.reader-footer').screenshot({path:path.join(evidence,`${name}-${width}.png`)});};
  // A short board, and a long one opened mid-way with a Custom size and a Version entry.
  for(const [slug,,count,perRound,,current] of sweepBoards){
    await h.setViewportSize({width:1440,height:860});
    await h.goto(`${a.url}boards/${slug}/#${sweepKey(perRound,current)}`);
    await h.waitForFunction(([count,current])=>document.querySelector('#reader-dialog').open&&document.querySelector('#reader-count').textContent===`${current+1} / ${count}`,[count,current]);
    if(slug==='sweep-long'){
      assert.equal(await h.locator('#revision-group').evaluate(el=>el.hidden),false,'the long-board experiment has a Version entry');
      await h.locator('#reader-window').evaluate(el=>{el.style.width='600px';});
      await h.waitForFunction(()=>document.querySelector('#size-menu [data-size="custom"]').getAttribute('aria-pressed')==='true');
    }
    await sweep(`reader pill, ${slug}`,readerSpec);
    for(const width of slug==='sweep-short'?[390,320,768,1244]:[320,1244])await footerShot(slug==='sweep-short'?'reader-footer':'reader-footer-long-mid',width);
  }
  // The stepper walks the whole long board from the middle, by button and key.
  await h.setViewportSize({width:1244,height:860});
  await h.goto(`${a.url}boards/sweep-long/#r1/c9`);
  await h.waitForFunction(()=>document.querySelector('#reader-count').textContent==='10 / 20');
  await h.locator('#reader-next').click();
  await h.waitForFunction(()=>document.querySelector('#reader-count').textContent==='11 / 20');
  await h.locator('#reader-stage').focus();
  await h.keyboard.press('[');await h.keyboard.press('[');
  await h.waitForFunction(()=>document.querySelector('#reader-count').textContent==='9 / 20');
  // The path's neighbour list reaches any of the twenty, scrolled to the current one.
  await h.locator('#reader-count').click();
  assert.equal(await h.locator('#reader-path-pop .reader-path-sibs [data-path-go]').count(),20);
  assert.equal(await h.evaluate(()=>document.activeElement?.getAttribute('aria-current')),null);
  await h.locator('#reader-path-pop .reader-path-sibs [data-path-go]').nth(19).click();
  await h.waitForFunction(()=>document.querySelector('#reader-count').textContent==='20 / 20');
  assert.equal(await h.locator('#reader-next').isDisabled(),true);
  // At phone width the % menu holds every former View control and fits the window.
  await h.goto(`${a.url}boards/sweep-short/#r0/c0`);
  await h.waitForFunction(()=>document.querySelector('#reader-dialog').open&&document.querySelector('#reader-count').textContent==='1 / 3');
  await h.setViewportSize({width:390,height:844});await settle();
  await openView(h);
  for(const id of ['reader-type','reader-theme','reader-standalone','reader-zoom-slider'])assert.equal(await h.locator(`#${id}`).isVisible(),true,id);
  for(const size of ['fit','compact','standard','wide'])assert.equal(await h.locator(`#size-menu [data-size="${size}"]`).isVisible(),true,size);
  assert.deepEqual((await layoutIssues({root:'#reader-zoom-menu',menus:true,withinWindow:true})).issues,[]);
  await h.screenshot({path:path.join(evidence,'reader-view-menu-390.png')});
  await h.locator('#reader-type').focus();
  await h.keyboard.press('ArrowRight');
  assert.equal(await h.locator('#reader-type').getAttribute('aria-valuetext'),'115%');
  await h.locator('#reader-theme').click();
  assert.equal(await h.locator('#reader-theme').getAttribute('aria-pressed'),'true');
  await h.locator('#size-menu [data-size="compact"]').click();
  assert.equal(await h.locator('#reader-window').getAttribute('data-size'),'compact');
  await h.keyboard.press('Escape');
  assert.equal(await h.locator('#reader-zoom-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(await h.evaluate(()=>document.activeElement.id),'reader-zoom-toggle');
  assert.equal(await h.locator('#reader-dialog').evaluate(el=>el.open),true);
  await h.locator('#reader-zoom-toggle').click();
  await h.locator('#reader-name').click();
  assert.equal(await h.locator('#reader-zoom-toggle').getAttribute('aria-expanded'),'false');
  await h.keyboard.press('Escape');
  await h.setViewportSize({width:1440,height:860});await settle();
  // Long titles in both headers, with the live "New version available" banner after the experiment changes.
  await h.goto(`${a.url}boards/sweep-long/#r0/c1`);
  await h.waitForFunction(()=>document.querySelector('#reader-dialog').open&&document.querySelector('#reader-name').textContent.startsWith('An unusually long'));
  await h.waitForFunction(()=>document.querySelector('#active-reader').contentDocument?.body?.dataset.experiment==='c1'&&document.querySelector('#live-status').textContent.startsWith('Live'));
  await writeFile(path.join(a.boards,'sweep-long','c1.html'),'<!doctype html><title>c1</title><body data-experiment="c1"><h1>c1, changed</h1>');
  await h.locator('#reader-update').waitFor();
  // A long project label too (labels come from the project's config; this instance's is short).
  const longLabel=()=>h.evaluate(()=>{for(const el of document.querySelectorAll('.brand'))el.title='Tinka / A rather long project label';});
  await longLabel();
  await sweep('reader header, long titles and reload banner',{root:'.reader-header',groups:['.brand','#close-reader','.reader-title-row','.chrome-actions'],pseudoTargets:'#reader-update'});
  await h.goto(`${a.url}boards/sweep-long/`);
  await h.waitForFunction(()=>!document.querySelector('#reader-dialog').open&&document.querySelector('#live-status').textContent.startsWith('Live'));
  await longLabel();
  await sweep('board header, long title',{root:'.canvas-header',groups:['.brand','.board-name','.info-toggle']});
  // The refresh offer normally appears after an app update and reloads soon after; show it to measure it.
  await h.locator('#live-refresh').evaluate(el=>{el.hidden=false;});
  await sweep('board footer, live status and refresh offer',{root:'.canvas-footer',groups:['.status-line','.view-tools'],pseudoTargets:'#live-refresh',oneRow:true});
  await h.setViewportSize({width:1440,height:960});
  await h.close();
  await a.page.evaluate(()=>localStorage.setItem('board-room-notes/first-steps',JSON.stringify({'first/one-step':{note:'Old unscoped cache must not leak',updatedAt:Date.now()+1000000}})));
  // Reuse the very same origin with the other workspace. Its namespace must win.
  const stalePage=await context.newPage();
  await stalePage.goto(`${a.url}boards/first-steps/`);
  await stalePage.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
  await main(['stop','--config',a.config]);
  await main(['stop','--config',b.config]);
  await writeFile(b.config,JSON.stringify({...await saved(b.config),port:a.port,portMode:'fixed'}));
  await main(['start','--config',b.config]);
  await (await legacyNote(stalePage,'first/one-step')).fill('Stale Glade tab must not write to Runway');await stalePage.locator('.tile-notes [type=submit]').click();
  await stalePage.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('Saved in this browser'));
  const otherNotes=await (await fetch(`${a.url}api/boards/first-steps/notes`)).json();
  assert.equal(otherNotes['first/one-step'].note,'Runway only');
  await stalePage.close();
  await a.page.goto(`${a.url}boards/first-steps/`);
  await a.page.waitForFunction(()=>document.querySelector('.canvas-header .brand').title.includes('Runway'));
  await a.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
  assert.equal(await (await legacyNote(a.page,'first/one-step')).inputValue(),'Runway only');
  assert.equal(errors.length,0,errors.join('\n'));
  const checks=['two simultaneous labels and URLs','folder discovery and empty new boards','new-board prompt','board and experiment removal prompts, copy and clipboard fallback','board cover prompts, custom images, live image updates and missing-image fallback','open prompts survive shell updates without losing the canvas position','isolated notes, same-origin port reuse and stale-tab write rejection','Home and current-title header, Tools popover with export and help, narrow layouts and prompts','removed top-bar controls stay absent','board footer zoom slider synced with Control-wheel, keyboard, Safari gesture and touch pinch','wheel and drag pan, and free pan past every edge of the board to an 80px bound','keyboard pan with arrows, Page Down, Home and End','focus revealing controls from any side, zoom anchored near an edge, centred Fit after panning away, and round links after panning away','independent experiment interaction','previous/next across rounds, boundaries, live availability, retained settings and narrow viewer','dot track order, grouping, click, keyboard, hover titles and drag-scrub','reader footer Type, Fit, Light, size popover with Version and Custom, and Open standalone','star and notes shared between card and reader and saved to .state/notes.json','notes panel beside the stage on desktop and below it on phones','browser history: home, board, experiments, versions, Escape/Back/breadcrumb, rounds, re-selection, view-only changes, deep links and reload','board view restored on Back from an experiment','active preview safely offers reload','round deep links in tall and zoomed-out canvases','canvas and experiment keyboard focus on entry, return and reload','toolbar keyboard access and note/experiment focus preserved during manifest updates','one-row reader and board footers and both headers at seven widths from 320 to 1920px: no overlap, nothing off screen or clipped, arrows hugging the dot strip, current dot in view, Back distinct from Previous and 44px targets','fixed dot strip: centred current dot, edge fades, Home/End/arrows, endpoints and edge-scrolling drag-scrub','View popover at all widths: every view control inside, keyboard focus, Escape and outside click'];
  console.log(JSON.stringify({passed:true,assertions:assertCount(),checkGroups:checks.length,evidence,checks,browserErrors:errors},null,2));
}finally{
  await browser.close();
  for(const {config} of instances)await main(['stop','--config',config]).catch(()=>{});
  await rm(fixtures,{recursive:true,force:true});
}
