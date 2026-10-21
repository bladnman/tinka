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
const openView=async page=>{if(await page.locator('#view-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#view-toggle').click();};
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
    await instance.page.locator('[data-note="first/one-step"]').fill(instance===a?'Glade only':'Runway only');
    await waitFor(async()=>{
      const notes=await (await fetch(`${instance.url}api/boards/first-steps/notes`)).json();
      return notes['first/one-step']?.note===(instance===a?'Glade only':'Runway only');
    },'Note persisted to its own instance');
  }
  const manifestBefore=await readFile(path.join(a.boards,'first-steps/rounds.json'),'utf8');
  const notesBefore=await readFile(path.join(a.boards,'first-steps/.state/notes.json'),'utf8');
  await a.page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPrompt=text;}}}));
  await a.page.locator('[data-remove-experiment="first/one-step"]').click();
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
  assert.equal(await a.page.evaluate(()=>document.activeElement.dataset.removeExperiment),'first/one-step');
  assert.equal(await readFile(path.join(a.boards,'first-steps/rounds.json'),'utf8'),manifestBefore);
  assert.equal(await readFile(path.join(a.boards,'first-steps/.state/notes.json'),'utf8'),notesBefore);
  // The header is identity only; board details, export and help live behind the quiet info control.
  await a.page.screenshot({path:path.join(evidence,'board-wide.png')});
  assert.equal(await a.page.locator('#canvas-header button:visible').count(),1);
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
  await a.page.locator('[data-remove-experiment="first/one-step"]').click();
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
  await a.page.locator('[data-note="first/one-step"]').waitFor();
  // Card markup appears before the asynchronous server-note hydration completes.
  await a.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
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
  await a.page.locator('#zoom-slider').evaluate(el=>{el.value='20';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await a.page.locator('#world').evaluate(el=>el.style.transform),'scale(0.2)');
  await showRound('second');
  await settledRound(1);
  await a.page.emulateMedia({reducedMotion:'reduce'});
  await showRound('first');
  await settledRound(0);
  await showRound('third');
  await settledRound(2);
  await a.page.emulateMedia({reducedMotion:'no-preference'});
  // Opening, deep links, and explicit reloads route keys into the experiment body.
  await a.page.locator('.card-actions [data-open="third/pages"]').click();
  const keyboardFrame=a.page.frameLocator('#active-reader');
  const readerFocused=()=>a.page.waitForFunction(()=>{const frame=document.querySelector('#active-reader');const doc=frame.contentDocument;return document.activeElement===frame&&doc?.readyState==='complete'&&doc.body?.dataset.experiment===location.hash.slice(1).split('/')[0]&&doc.activeElement?.tagName==='BODY';},null,{timeout:10000}).catch(async error=>{
    const actual=await a.page.evaluate(()=>{const frame=document.querySelector('#active-reader');const doc=frame.contentDocument;return {hash:location.hash,open:document.querySelector('#reader-dialog').open,active:document.activeElement?.id||document.activeElement?.tagName,ready:doc?.readyState,experiment:doc?.body?.dataset.experiment,inner:doc?.activeElement?.tagName,src:frame.src};});
    throw new Error(`Reader not focused: ${JSON.stringify(actual)}; ${error.message}`);
  });
  await keyboardFrame.locator('h1').waitFor();
  await readerFocused();
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  assert.equal(await a.page.locator('#reader-fit').getAttribute('aria-pressed'),'true');
  assert.equal(await a.page.locator('#size-value').textContent(),'Fit');
  await a.page.screenshot({path:path.join(evidence,'reader-keyboard-focus.png')});
  await openView(a.page);
  await a.page.locator('#reader-type').focus();
  await a.page.keyboard.press('Tab');
  assert.equal(await a.page.evaluate(()=>document.activeElement.id),'reader-fit');
  await a.page.keyboard.press('Tab');
  assert.equal(await a.page.evaluate(()=>document.activeElement.id),'reader-theme');
  await keyboardFrame.locator('input').fill('Keep my draft');
  keyboardManifest.rounds[2].title='Updated third round';
  await writeFile(path.join(keyboardBoard,'rounds.json'),JSON.stringify(keyboardManifest));
  await a.page.locator('#round-heading-third').filter({hasText:'Updated third round'}).waitFor({state:'attached'});
  assert.equal(await keyboardFrame.locator('input').inputValue(),'Keep my draft');
  assert.equal(await keyboardFrame.locator('input').evaluate(el=>el===document.activeElement),true);
  await a.page.locator('#close-reader').click();
  await a.page.waitForFunction(()=>document.activeElement.id==='viewport');
  const keyboardNote=a.page.locator('[data-note="third/pages"]');
  await keyboardNote.fill('Keep this note');
  await keyboardNote.evaluate(el=>el.setSelectionRange(3,7));
  keyboardManifest.rounds[2].title='Third round with notes';
  await writeFile(path.join(keyboardBoard,'rounds.json'),JSON.stringify(keyboardManifest));
  await a.page.locator('#round-heading-third').filter({hasText:'Third round with notes'}).waitFor();
  assert.deepEqual(await keyboardNote.evaluate(el=>[el===document.activeElement,el.value,el.selectionStart,el.selectionEnd]),[true,'Keep this note',3,7]);
  await a.page.goto(`${a.url}boards/keyboard/#first/pages`);
  await keyboardFrame.locator('h1').waitFor();
  await readerFocused();
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  await writeFile(path.join(keyboardBoard,'first.html'),(await readFile(path.join(keyboardBoard,'first.html'),'utf8')).replace('Keyboard pages</h1>','Updated keyboard pages</h1>'));
  await a.page.locator('#reader-update').waitFor({state:'visible'});
  await a.page.locator('#reader-update').click();
  await keyboardFrame.getByRole('heading',{name:'Updated keyboard pages'}).waitFor();
  await readerFocused();
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  await a.page.keyboard.press('Escape');
  await a.page.locator('#reader-dialog').waitFor({state:'hidden'});
  await a.page.waitForFunction(()=>document.activeElement.id==='viewport');
  // Step through experiments without leaving the viewer or changing comparison settings.
  await a.page.goto(`${a.url}boards/keyboard/#first/pages`);
  await readerFocused();
  const position=()=>a.page.locator('#dot-track').getAttribute('data-position');
  await a.page.waitForFunction(()=>document.querySelector('#dot-track').dataset.position==='1 / 3');
  assert.equal(await a.page.locator('#reader-previous').isDisabled(),true);
  await openView(a.page);
  await a.page.locator('#size-trigger').click();
  await a.page.locator('#size-menu [data-size="compact"]').click();
  await openView(a.page);
  await a.page.locator('#reader-theme').click();
  await openView(a.page);
  await a.page.locator('#reader-type').focus();
  await a.page.keyboard.press('ArrowRight');
  await a.page.keyboard.press('ArrowRight');
  await a.page.locator('#reader-next').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 2');
  assert.equal(new URL(a.page.url()).hash,'#second/pages');
  assert.equal(await position(),'2 / 3');
  assert.deepEqual(await a.page.evaluate(()=>[document.querySelector('#size-value').textContent,document.querySelector('#reader-window').dataset.size,document.querySelector('#reader-theme').getAttribute('aria-pressed'),document.querySelector('#reader-type').value]),['Compact','compact','true','130']);
  await a.page.locator('#reader-next').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-next').isDisabled(),true);
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 3');
  await a.page.screenshot({path:path.join(evidence,'reader-navigation-wide.png')});
  // Status changes update the sequence without replacing the current preview.
  await main(['status','--config',a.config,'--board','keyboard','second/pages','building','Updating fixture']);
  await a.page.waitForFunction(()=>document.querySelector('#dot-track').dataset.position==='2 / 2');
  assert.equal(await a.page.locator('#dot-track [data-dot]').count(),2);
  assert.equal(await keyboardFrame.locator('output').textContent(),'1');
  await a.page.locator('#reader-previous').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 1');
  await main(['status','--config',a.config,'--board','keyboard','third/pages','reserved','Reserved fixture']);
  await a.page.waitForFunction(()=>document.querySelector('#dot-track').dataset.position==='1 / 1');
  assert.equal(await a.page.locator('#reader-next').isDisabled(),true);
  assert.equal(await a.page.locator('#reader-previous').isDisabled(),true);
  for(const id of ['second','third'])await main(['status','--config',a.config,'--board','keyboard',`${id}/pages`,'ready','Keyboard test fixture']);
  await a.page.waitForFunction(()=>document.querySelector('#dot-track').dataset.position==='1 / 3');
  await a.page.setViewportSize({width:400,height:800});
  await a.page.locator('#reader-next').click();
  await readerFocused();
  assert.equal(await a.page.locator('#reader-name').textContent(),'Pages 2');
  for(const selector of ['.reader-header','.reader-footer'])assert.equal(await a.page.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth),true,selector);
  await a.page.screenshot({path:path.join(evidence,'reader-navigation-narrow.png')});
  await a.page.locator('#close-reader').click();
  await a.page.setViewportSize({width:1440,height:1200});
  // Simulate a shell update only in this browser; the user's running app is untouched.
  await showRound('third');
  await settledRound(2);
  await a.page.waitForFunction(()=>document.querySelector('#live-status').textContent.startsWith('Live ·'));
  const shellReload=a.page.waitForEvent('load');
  // Click the visible scaled card directly, without Playwright scrolling its transformed ancestors.
  const promptButton=await a.page.locator('[data-remove-experiment="third/pages"]').boundingBox();
  const canvasTransforms=()=>({pan:document.querySelector('#plane').style.transform,zoom:document.querySelector('#world').style.transform});
  const beforePrompt=await a.page.evaluate(canvasTransforms);
  await a.page.mouse.click(promptButton.x+promptButton.width/2,promptButton.y+promptButton.height/2);
  await a.page.locator('#agent-prompt-dialog').waitFor();
  const viewBeforeReload=await a.page.evaluate(canvasTransforms);
  await a.page.locator('.agent-dialog-close').focus();
  await a.page.route('**/api/boards/keyboard/live',async route=>{
    const response=await route.fetch();
    const snapshot=await response.json();
    await route.fulfill({response,json:{...snapshot,shellRevision:'browser-fixture-shell',revision:`browser-fixture-${snapshot.revision}`}});
  });
  await a.page.locator('#live-refresh').waitFor({state:'visible'});
  await a.page.waitForTimeout(1500);
  assert.equal(await a.page.locator('#agent-prompt-dialog').isVisible(),true);
  await a.page.locator('.agent-dialog-close').click();
  await shellReload;
  await a.page.waitForFunction(()=>document.activeElement.id==='viewport');
  await a.page.waitForFunction(view=>{
    return document.querySelector('#plane').style.transform===view.pan&&document.querySelector('#world').style.transform===view.zoom&&document.querySelector('#round-status').textContent.startsWith('Round 3 /');
  },viewBeforeReload,{timeout:8000}).catch(async error=>{
    const actual=await a.page.evaluate(()=>({pan:document.querySelector('#plane').style.transform,zoom:document.querySelector('#world').style.transform,round:document.querySelector('#round-status').textContent}));
    throw new Error(`Canvas view after shell reload: before prompt ${JSON.stringify(beforePrompt)}, expected ${JSON.stringify(viewBeforeReload)}, actual ${JSON.stringify(actual)}; ${error.message}`);
  });
  // Drain the shell stub before navigation cancels or auto-continues an intercepted poll.
  // unroute() uses the default non-waiting behavior, so an outstanding route.fetch()
  // could otherwise resume with fulfill() after Playwright had already handled its route.
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
  const setRange=(selector,value)=>h.locator(selector).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await h.goto(a.url);
  await h.getByRole('heading',{name:'History'}).waitFor();
  // Home -> board is real page navigation.
  await h.locator('a.board-link[href="/boards/history/"]').click();
  await h.waitForURL(`${a.url}boards/history/`);
  await waitBoard();
  const base=await length();
  const baseHistoryLength=await historyLength();
  // Removed chrome stays removed; the board footer carries the view controls.
  assert.equal(await h.locator('select').count(),0);
  assert.equal(await h.locator('#round-picker, #concept-nav, [data-jump], #zoom-in, #zoom-out, #zoom-level, #overview, #reset-view, #toggle-header, .toolbar, .intro, .reader-bar, .reader-bottom, #reader-size').count(),0);
  assert.equal(await h.locator('#canvas-header button:visible').count(),1);
  assert.equal(await h.locator('.canvas-footer #zoom-slider').isVisible(),true);
  assert.equal(await h.locator('.canvas-footer #fit').isVisible(),true);
  assert.equal(await h.locator('#dot-track').isVisible(),false);
  assert.equal(await h.locator('#zoom-slider').inputValue(),'50');
  assert.equal(await h.locator('#zoom-slider').getAttribute('aria-valuetext'),'50 percent');
  // Board zoom: slider, Control-wheel, keyboard, Safari gesture and two-finger pinch stay in sync with the slider.
  await setRange('#zoom-slider',100);
  assert.equal((await boardView()).transform,'scale(1)');
  await h.locator('#zoom-slider').evaluate(el=>el.value='0');
  await h.mouse.move(700,500);
  await h.keyboard.down('Control');
  await h.mouse.wheel(0,-60);
  await h.keyboard.up('Control');
  await h.waitForFunction(()=>Number(document.querySelector('#zoom-slider').value)>100);
  const wheelZoom=Number(await h.locator('#zoom-slider').inputValue());
  await h.locator('#viewport').focus();
  await h.keyboard.press('-');
  assert(Number(await h.locator('#zoom-slider').inputValue())<wheelZoom);
  await h.keyboard.press('+');
  assert.equal(Number(await h.locator('#zoom-slider').inputValue()),wheelZoom);
  await setRange('#zoom-slider',50);
  await h.locator('#viewport').evaluate(el=>{const event=new Event('gesturestart',{cancelable:true});el.dispatchEvent(event);const change=Object.assign(new Event('gesturechange',{cancelable:true}),{scale:1.5,clientX:700,clientY:500});el.dispatchEvent(change);});
  assert.equal(await h.locator('#zoom-slider').inputValue(),'75');
  await setRange('#zoom-slider',40);
  await h.locator('#viewport').evaluate(el=>{
    const send=(type,id,x,y)=>el.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',isPrimary:id===11,clientX:x,clientY:y,bubbles:true,cancelable:true}));
    send('pointerdown',11,600,500);send('pointerdown',12,700,500);send('pointermove',11,550,500);send('pointermove',12,750,500);send('pointerup',11,550,500);send('pointerup',12,750,500);
  });
  assert.equal(await h.locator('#zoom-slider').inputValue(),'80');
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
  const opener=h.locator('.card-actions [data-open="alpha/one"]:not([data-revision])');
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
  assert.equal(await h.locator('#zoom-slider').inputValue(),String(Math.round(fitScale*100)));
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
  await h.locator('[data-note="alpha/two"]').fill('Card note');
  assert.equal(await length(),base);
  assert.equal(await historyLength(),baseHistoryLength);
  assert.equal(await hashNow(),'');
  // Star and note on the card appear in the experiment view, and back.
  await h.locator('.card-actions [data-open="alpha/one"]:not([data-revision])').click();
  await waitReader('One');
  assert.equal(await hashNow(),'#alpha/one');
  assert.equal(await length(),base+1);
  const readerHistoryLength=await historyLength();
  assert.equal(await h.title(),'Tinka / Glade / History / One');
  assert.equal(await h.locator('#reader-dialog .reader-header #reader-board-link').textContent(),'← Board');
  assert.equal(await h.locator('#reader-hint').textContent(),'Try the first thing.');
  assert((await h.locator('#reader-name').getAttribute('title')).includes('Try the first thing.'));
  assert.equal(await h.locator('#reader-standalone').getAttribute('href'),'/boards/history/files/alpha-one.html');
  assert.equal(await h.locator('#reader-standalone').getAttribute('target'),'_blank');
  // Dots: board order, grouped by round, one selected, endpoints disabled.
  assert.deepEqual(await h.locator('#dot-track [data-dot]').evaluateAll(dots=>dots.map(dot=>[dot.dataset.dot,dot.classList.contains('group-start'),dot.getAttribute('aria-pressed')])),[['alpha/one',true,'true'],['alpha/two',false,'false'],['beta/three',true,'false']]);
  assert.equal(await h.locator('[data-dot="beta/three"]').getAttribute('aria-label'),'3 of 3: Round 02 · 01 Three');
  assert.equal(await h.locator('#reader-previous').isDisabled(),true);
  assert.equal(await h.locator('#reader-next').isDisabled(),false);
  // Reader view controls: Type, Fit, Light, size popover (with Version), standalone. None add history entries.
  assert.deepEqual(await frameData(),{experiment:'alpha-one',theme:'paper',scale:'100'});
  await openView(h);
  await h.locator('#reader-type').focus();
  await h.keyboard.press('ArrowRight');
  assert.equal(await h.locator('#reader-type').getAttribute('aria-valuetext'),'115%');
  await h.waitForFunction(()=>document.querySelector('#active-reader').contentDocument.body.dataset.scale==='115');
  await openView(h);
  await h.locator('#reader-theme').click();
  assert.equal(await h.locator('#reader-theme').getAttribute('aria-pressed'),'true');
  await h.waitForFunction(()=>document.querySelector('#active-reader').contentDocument.body.dataset.theme==='night');
  await openView(h);
  await h.locator('#size-trigger').click();
  assert.equal(await h.locator('#size-menu').isVisible(),true);
  assert.equal(await h.locator('#size-trigger').getAttribute('aria-expanded'),'true');
  assert.deepEqual(await h.locator('#size-menu [data-size]:visible').evaluateAll(buttons=>buttons.map(button=>button.dataset.size)),['fit','compact','standard','wide']);
  assert.deepEqual(await h.locator('#revision-options [data-revision-choice]').evaluateAll(buttons=>buttons.map(button=>[button.textContent,button.getAttribute('aria-pressed')])),[['Original','true'],['Second','false']]);
  assert.equal(await h.locator('#revision-group').isVisible(),true);
  await h.screenshot({path:path.join(evidence,'history-size-popover.png')});
  await h.locator('#size-menu [data-size="standard"]').click();
  assert.equal(await h.locator('#size-menu').isVisible(),false);
  assert.equal(await h.evaluate(()=>document.activeElement.id),'size-trigger');
  assert.deepEqual(await h.evaluate(()=>[document.querySelector('#reader-window').dataset.size,document.querySelector('#size-value').textContent,document.querySelector('#reader-fit').getAttribute('aria-pressed')]),['standard','Standard','false']);
  await openView(h);
  await h.locator('#size-trigger').click();
  await h.keyboard.press('Escape');
  assert.equal(await h.locator('#size-menu').isVisible(),false);
  assert.equal(await h.locator('#reader-dialog').evaluate(dialog=>dialog.open),true);
  await openView(h);
  await h.locator('#size-trigger').click();
  await h.locator('.reader-stage').click({position:{x:8,y:8}});
  assert.equal(await h.locator('#size-menu').isVisible(),false);
  await h.locator('#reader-window').evaluate(el=>{el.style.width='600px';el.style.height='500px';});
  await h.waitForFunction(()=>document.querySelector('#size-value').textContent==='Custom');
  await openView(h);
  await h.locator('#size-trigger').click();
  assert.equal(await h.locator('#size-menu [data-size="custom"]').getAttribute('aria-pressed'),'true');
  assert.equal(await h.locator('#custom-size').textContent(),'600 × 500');
  await h.keyboard.press('Escape');
  await openView(h);
  await h.locator('#reader-fit').click();
  assert.deepEqual(await h.evaluate(()=>[document.querySelector('#reader-window').dataset.size,document.querySelector('#reader-window').style.width,document.querySelector('#reader-fit').getAttribute('aria-pressed')]),['fit','','true']);
  await h.locator('[data-dot="beta/three"]').hover();
  await h.locator('#dot-tooltip').waitFor({state:'visible'});
  assert.equal(await h.locator('#dot-tooltip').textContent(),'3 of 3: Round 02 · 01 Three');
  assert.equal(await h.locator('#reader-name').textContent(),'One');
  await h.mouse.move(10,10);
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
  assert.equal(await h.locator('[data-note="alpha/one"]').inputValue(),'Shared from the reader');
  await waitFor(async()=>(await saved(path.join(a.boards,'history/.state/notes.json')))['alpha/one']?.note==='Shared from the reader','Reader note persisted to .state/notes.json');
  const noOverlap=()=>h.evaluate(()=>{const stage=document.querySelector('.reader-stage').getBoundingClientRect();const panel=document.querySelector('#notes-panel').getBoundingClientRect();const viewer=document.querySelector('#reader-window').getBoundingClientRect();const footer=document.querySelector('.reader-footer').getBoundingClientRect();const side=panel.left>=stage.right-.5&&panel.top<stage.bottom;const below=panel.top>=stage.bottom-.5;return {separate:side||below,mode:side?'side':below?'sheet':'overlap',viewerInside:viewer.left>=stage.left-.5&&viewer.right<=stage.right+.5&&viewer.top>=stage.top-.5&&viewer.bottom<=stage.bottom+.5,aboveFooter:panel.bottom<=footer.top+.5,width:Math.round(panel.width)};});
  assert.deepEqual(await noOverlap(),{separate:true,mode:'side',viewerInside:true,aboveFooter:true,width:320});
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
  assert.equal(await length(),base+2);
  assert.equal(await hashNow(),'#alpha/two');
  await h.setViewportSize({width:390,height:844});
  assert.deepEqual(await noOverlap(),{separate:true,mode:'sheet',viewerInside:true,aboveFooter:true,width:390});
  for(const selector of ['.reader-header','.reader-footer'])assert.equal(await h.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth),true,selector);
  await h.screenshot({path:path.join(evidence,'history-reader-notes-narrow.png')});
  // The open notes field follows Back/Forward even while it has focus.
  await h.locator('#reader-note').focus();
  await h.goBack();
  await waitReader('One');
  assert.equal(await h.locator('#reader-note').inputValue(),'Shared from the reader');
  await h.goForward();
  await waitReader('Two');
  assert.equal(await h.locator('#reader-note').inputValue(),'Card note');
  // Escape inside the notes field closes the panel only.
  await h.locator('#reader-note').focus();
  await h.keyboard.press('Escape');
  assert.equal(await h.locator('#notes-panel').isVisible(),false);
  assert.equal(await h.locator('#reader-dialog').evaluate(dialog=>dialog.open),true);
  assert.equal(await h.evaluate(()=>document.activeElement.id),'notes-toggle');
  await h.setViewportSize({width:1440,height:960});
  // Back/Forward walk the experiments, then the board, then home; Forward returns to the exact states.
  await h.goBack();
  await waitReader('One');
  assert.equal(await hashNow(),'#alpha/one');
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
  await waitReader('One');
  await h.goForward();
  await waitReader('Two');
  assert.equal(await hashNow(),'#alpha/two');
  assert.equal(await length(),base+2);
  // Escape, the Back button and the board breadcrumb each add one entry that browser Back reverses.
  await h.locator('#active-reader').focus();
  await h.keyboard.press('Escape');
  await waitBoard();
  assert.match(await hashNow(),/^#round-/);
  assert.equal(await length(),base+3);
  await h.goBack();
  await waitReader('Two');
  await h.locator('#reader-next').focus();
  await h.keyboard.press('Escape');
  await waitBoard();
  await h.goBack();
  await waitReader('Two');
  await h.locator('#close-reader').click();
  await waitBoard();
  assert.equal(await length(),base+3);
  await h.goBack();
  await waitReader('Two');
  await h.locator('#reader-board-link').click();
  await waitBoard();
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
  await waitReader('Three');
  await h.goBack();
  await waitBoard();
  assert.deepEqual(await boardView(),leftView);
  await h.goForward();
  await waitReader('Three');
  await h.locator('#close-reader').click();
  await waitBoard();
  assert.deepEqual(await boardView(),leftView);
  // Dots: click, keyboard and drag-scrub each add one entry; re-selecting the current experiment adds none.
  await h.locator('.card-actions [data-open="alpha/one"]:not([data-revision])').evaluate(button=>button.click());
  await waitReader('One');
  let entries=await length();
  await h.locator('[data-dot="alpha/one"]').click();
  await openView(h);
  await h.locator('#size-trigger').click();
  await h.locator('[data-revision-choice="original"]').click();
  assert.equal(await length(),entries);
  await h.locator('[data-dot="beta/three"]').click();
  await waitReader('Three');
  assert.equal(await length(),entries+1);
  assert.equal(await h.locator('#reader-next').isDisabled(),true);
  assert.equal(await h.locator('#reader-previous').isDisabled(),false);
  await h.locator('[data-dot="beta/three"]').focus();
  await h.keyboard.press('Home');
  await waitReader('One');
  assert.equal(await h.evaluate(()=>document.activeElement.dataset.dot),'alpha/one');
  await h.keyboard.press('Home');
  await h.keyboard.press('ArrowLeft');
  assert.equal(await length(),entries+2);
  await h.keyboard.press('ArrowRight');
  await waitReader('Two');
  await h.keyboard.press('End');
  await waitReader('Three');
  await h.keyboard.press('ArrowLeft');
  await waitReader('Two');
  assert.equal(await length(),entries+5);
  await h.goBack();
  await waitReader('Three');
  await h.goBack();
  await waitReader('Two');
  await h.goForward();
  await h.goForward();
  await waitReader('Two');
  entries=await length();
  const first=await h.locator('[data-dot="alpha/one"]').boundingBox();
  const last=await h.locator('[data-dot="beta/three"]').boundingBox();
  await h.mouse.move(first.x+first.width/2,first.y+first.height/2);await h.mouse.down();
  await h.mouse.move(last.x+last.width/2,last.y+last.height/2,{steps:8});
  assert.equal(await h.locator('#dot-tooltip').textContent(),'3 of 3: Round 02 · 01 Three');
  assert.equal(await h.locator('#reader-name').textContent(),'Two');
  await h.mouse.up();
  await waitReader('Three');
  assert.equal(await length(),entries+1);
  // Switching versions is one entry; Back returns to the original.
  await h.locator('[data-dot="alpha/one"]').click();
  await waitReader('One');
  entries=await length();
  await openView(h);
  await h.locator('#size-trigger').click();
  await h.locator('[data-revision-choice="v2"]').click();
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
  assert.equal(await h.locator('[data-revision-choice="v2"]').getAttribute('aria-pressed'),'true');
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
  // Problems in one region at the current width. Controls inside the dot strip are clipped to it first.
  const layoutIssues=spec=>h.evaluate(spec=>{
    const issues=[];const vw=document.documentElement.clientWidth;
    const root=document.querySelector(spec.root);
    const shown=el=>{const style=getComputedStyle(el);const box=el.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0;};
    const rect=(el,clip)=>{const b=el.getBoundingClientRect();const r={left:b.left,right:b.right,top:b.top,bottom:b.bottom};if(clip){const c=clip.getBoundingClientRect();r.left=Math.max(r.left,c.left);r.right=Math.min(r.right,c.right);}return r;};
    const overlap=(p,q)=>Math.min(p.right,q.right)-Math.max(p.left,q.left)>.5&&Math.min(p.bottom,q.bottom)-Math.max(p.top,q.top)>.5;
    const name=el=>el.id?`#${el.id}`:el.dataset.dot?`dot ${el.dataset.dot}`:`.${[...el.classList].join('.')}`;
    if(root.scrollWidth>root.clientWidth+.5)issues.push(`${spec.root} scrolls sideways`);
    const groups=(spec.groups||[]).map(selector=>root.querySelector(selector)).filter(el=>el&&shown(el));
    groups.forEach((g,i)=>groups.slice(i+1).forEach(other=>{if(overlap(rect(g),rect(other)))issues.push(`${name(g)} overlaps ${name(other)}`);}));
    // One row: every group is centred on the same line.
    if(spec.oneRow){const centres=groups.map(g=>{const b=g.getBoundingClientRect();return (b.top+b.bottom)/2;});if(Math.max(...centres)-Math.min(...centres)>1.5)issues.push(`groups are not in one row (${centres.map(Math.round)})`);}
    const controls=[];
    for(const el of root.querySelectorAll('button,input,a[href],textarea')){
      if(!shown(el)||el.closest('[hidden],.size-menu,.board-info'))continue;
      const scroller=el.closest('.dot-track');const r=rect(el,scroller);
      if(r.right-r.left<1)continue;
      controls.push({el,r});
      if(r.left<-.5||r.right>vw+.5)issues.push(`${name(el)} leaves the window`);
      // Ancestors that hide overflow (other than the dot strip) must not clip a control.
      for(let parent=el.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
        if(parent===scroller)break;
        const style=getComputedStyle(parent);
        if(style.overflowX!=='visible'||style.overflowY!=='visible'){const p=parent.getBoundingClientRect();if(r.left<p.left-.5||r.right>p.right+.5||r.top<p.top-.5||r.bottom>p.bottom+.5)issues.push(`${name(el)} clipped by ${name(parent)}`);}
      }
      // Dots are 24 by 44 by design; the small status buttons carry a 44px hit area on a pseudo-element.
      const b=el.getBoundingClientRect();const minWidth=el.matches('.experiment-dot')?24:44;
      if(!el.matches(spec.pseudoTargets||'#none')&&(b.height<43.5||b.width<minWidth-.5))issues.push(`${name(el)} target ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    controls.forEach((c,i)=>controls.slice(i+1).forEach(d=>{if(overlap(c.r,d.r))issues.push(`${name(c.el)} overlaps ${name(d.el)}`);}));
    const result={issues,height:Math.round(root.getBoundingClientRect().height),layout:spec.navigation?`${root.dataset.back}/${root.dataset.tools}/${getComputedStyle(root).getPropertyValue('--strip-dots').trim()}`:''};
    if(spec.navigation){
      const prev=document.querySelector('#reader-previous').getBoundingClientRect();
      const next=document.querySelector('#reader-next').getBoundingClientRect();
      const strip=document.querySelector('#dot-track').getBoundingClientRect();
      const dots=controls.filter(c=>c.el.matches('.experiment-dot'));
      if(!dots.length)issues.push('no visible dots');
      else{
        const before=dots[0].r.left-prev.right;const after=next.left-dots.at(-1).r.right;
        if(before<-.5||before>24)issues.push(`Previous is ${Math.round(before)}px from the first dot`);
        if(after<-.5||after>24)issues.push(`Next is ${Math.round(after)}px from the last dot`);
      }
      // Compact Back never looks like Previous: different visible text, or the board glyph when it has none.
      const backButton=document.querySelector('#close-reader');const backText=backButton.innerText.trim();
      if(backText===document.querySelector('#reader-previous').innerText.trim()||backText==='←'||(!backText&&!shown(backButton.querySelector('.board-glyph'))))issues.push(`Back shows "${backText}" like Previous`);
      const current=document.querySelector('#dot-track [aria-pressed="true"]').getBoundingClientRect();
      if(current.left<strip.left-.5||current.right>strip.right+.5)issues.push('the current dot is not fully in the strip');
      if(strip.width>9*24+.5)issues.push(`the strip is ${Math.round(strip.width)}px wide`);
      // Centred on the page when there is room; otherwise against a neighbouring group.
      const nav=document.querySelector('.experiment-navigation').getBoundingClientRect();
      const centre=Math.abs((nav.left+nav.right)/2-vw/2);
      const back=document.querySelector('#close-reader').getBoundingClientRect();const tools=document.querySelector('.reader-tools').getBoundingClientRect();
      const gap=parseFloat(getComputedStyle(root).columnGap)||0;
      if(centre>1.5&&nav.left-back.right>gap+1.5&&tools.left-nav.right>gap+1.5)issues.push(`navigation is ${Math.round(centre)}px off centre`);
    }
    return result;
  },spec);
  const settle=()=>h.evaluate(()=>new Promise(requestAnimationFrame));
  const sweep=async(label,spec)=>{
    let height=null;const layouts=new Set();
    for(const width of [320,390,768,1024,1244,1440,1920]){
      await h.setViewportSize({width,height:860});await settle();
      const result=await layoutIssues(spec);layouts.add(result.layout);
      // A one-row footer keeps the same height at every width.
      if(spec.oneRow){height??=result.height;if(result.height!==height)result.issues.push(`height ${result.height}px instead of ${height}px`);}
      assert.deepEqual(result.issues,[],`${label} at ${width}px`);
    }
    return [...layouts];
  };
  const readerSpec={root:'.reader-footer',groups:['.back','.experiment-navigation','.reader-tools'],navigation:true,oneRow:true};
  const footerShot=async(name,width)=>{await h.setViewportSize({width,height:860});await settle();await h.locator('.reader-footer').screenshot({path:path.join(evidence,`${name}-${width}.png`)});};
  // A short track with "Fit", and a long track with a mid-track current item, a Custom size and a Version entry.
  for(const [slug,,count,perRound,,current] of sweepBoards){
    await h.setViewportSize({width:1440,height:860});
    await h.goto(`${a.url}boards/${slug}/#${sweepKey(perRound,current)}`);
    await h.waitForFunction(([count,key])=>document.querySelector('#reader-dialog').open&&document.querySelectorAll('#dot-track [data-dot]').length===count&&document.querySelector('#dot-track [aria-pressed="true"]')?.dataset.dot===key,[count,sweepKey(perRound,current)]);
    if(slug==='sweep-long'){
      assert.equal(await h.locator('#revision-group').evaluate(el=>el.hidden),false,'the long-track experiment has a Version entry');
      await h.locator('#reader-window').evaluate(el=>{el.style.width='600px';});
      await h.waitForFunction(()=>document.querySelector('#size-value').textContent==='Custom');
    }
    const layouts=await sweep(`reader footer, ${slug}`,readerSpec);
    // View controls remain in their popover at every width.
    assert(layouts.every(layout=>layout.includes('/folded')),`${slug} used ${layouts}`);
    for(const width of slug==='sweep-short'?[390,320,768,1244]:[320,1244])await footerShot(slug==='sweep-short'?'reader-footer':'reader-footer-long-mid',width);
  }
  // The strip keeps the current dot centred and fades the edges that have more beyond them; the arrows, keys and
  // endpoints still walk the whole sequence.
  await h.setViewportSize({width:1244,height:860});
  await h.goto(`${a.url}boards/sweep-long/#r1/c9`);
  await h.waitForFunction(()=>document.querySelector('#dot-track [aria-pressed="true"]')?.dataset.dot==='r1/c9');
  await settle();
  const stripState=()=>h.evaluate(()=>{const track=document.querySelector('#dot-track');const strip=track.getBoundingClientRect();const dot=track.querySelector('[aria-pressed="true"]').getBoundingClientRect();return {offset:Math.round((dot.left+dot.right)/2-(strip.left+strip.right)/2),fade:[track.style.getPropertyValue('--fade-start'),track.style.getPropertyValue('--fade-end')],dots:Math.round(strip.width/24)};});
  assert.deepEqual(await stripState(),{offset:0,fade:['16px','16px'],dots:9});
  await h.locator('#dot-track [aria-pressed="true"]').focus();
  await h.keyboard.press('Home');
  await h.waitForFunction(()=>document.querySelector('#dot-track [aria-pressed="true"]')?.dataset.dot==='r0/c0'&&document.activeElement?.dataset.dot==='r0/c0');
  assert.deepEqual((await stripState()).fade,['0px','16px']);
  assert.equal(await h.locator('#reader-previous').isDisabled(),true);
  await h.keyboard.press('End');
  await h.waitForFunction(()=>document.querySelector('#dot-track [aria-pressed="true"]')?.dataset.dot==='r3/c19');
  assert.deepEqual((await stripState()).fade,['16px','0px']);
  assert.equal(await h.locator('#reader-next').isDisabled(),true);
  await h.keyboard.press('ArrowLeft');
  await h.waitForFunction(()=>document.querySelector('#dot-track [aria-pressed="true"]')?.dataset.dot==='r3/c18');
  // Drag-scrub across the strip scrolls it at the edge and lands on a dot that was out of view.
  const stripBox=await h.locator('#dot-track').boundingBox();
  await h.mouse.move(stripBox.x+stripBox.width-30,stripBox.y+22);await h.mouse.down();
  for(let i=0;i<12;i++)await h.mouse.move(stripBox.x+4+(i%2),stripBox.y+22);
  await h.mouse.up();
  await h.waitForFunction(()=>{const key=document.querySelector('#dot-track [aria-pressed="true"]')?.dataset.dot;return key&&Number(key.split('/c')[1])<10;});
  // Phone width folds the view controls into one View popover holding all of them.
  await h.goto(`${a.url}boards/sweep-short/#r0/c0`);
  await h.waitForFunction(()=>document.querySelector('#reader-dialog').open&&document.querySelectorAll('#dot-track [data-dot]').length===3);
  await h.setViewportSize({width:390,height:844});await settle();
  assert.equal(await h.locator('#view-toggle').isVisible(),true);
  assert.equal(await h.locator('#reader-type').isVisible(),false);
  await h.locator('#view-toggle').click();
  assert.equal(await h.locator('#view-toggle').getAttribute('aria-expanded'),'true');
  assert.equal(await h.evaluate(()=>document.activeElement.id),'reader-type');
  for(const id of ['reader-type','reader-fit','reader-theme','size-trigger','reader-standalone'])assert.equal(await h.locator(`#${id}`).isVisible(),true,id);
  assert.deepEqual((await layoutIssues({root:'.view-controls'})).issues,[]);
  await h.screenshot({path:path.join(evidence,'reader-view-popover-390.png')});
  await h.keyboard.press('ArrowRight');
  assert.equal(await h.locator('#reader-type').getAttribute('aria-valuetext'),'115%');
  await openView(h);
  await h.locator('#reader-theme').click();
  assert.equal(await h.locator('#reader-theme').getAttribute('aria-pressed'),'true');
  await openView(h);
  await h.locator('#size-trigger').click();
  await h.locator('#size-menu [data-size="compact"]').click();
  assert.equal(await h.locator('#size-value').textContent(),'Compact');
  assert.equal(await h.locator('#view-toggle').getAttribute('aria-expanded'),'true');
  await h.keyboard.press('Escape');
  assert.equal(await h.locator('#view-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(await h.evaluate(()=>document.activeElement.id),'view-toggle');
  assert.equal(await h.locator('#reader-dialog').evaluate(el=>el.open),true);
  await h.locator('#view-toggle').click();
  await h.locator('#reader-name').click();
  assert.equal(await h.locator('#view-toggle').getAttribute('aria-expanded'),'false');
  await h.setViewportSize({width:1440,height:860});await settle();
  assert.equal(await h.locator('#view-toggle').isVisible(),true);
  assert.equal(await h.locator('#reader-type').isVisible(),false);
  // Long titles in both headers, with the live "New version available" banner after the experiment changes.
  await h.goto(`${a.url}boards/sweep-long/#r0/c1`);
  await h.waitForFunction(()=>document.querySelector('#reader-dialog').open&&document.querySelector('#reader-name').textContent.startsWith('An unusually long'));
  await h.waitForFunction(()=>document.querySelector('#active-reader').contentDocument?.body?.dataset.experiment==='c1'&&document.querySelector('#live-status').textContent.startsWith('Live'));
  await writeFile(path.join(a.boards,'sweep-long','c1.html'),'<!doctype html><title>c1</title><body data-experiment="c1"><h1>c1, changed</h1>');
  await h.locator('#reader-update').waitFor();
  // A long project label too (labels come from the project's config; this instance's is short).
  const longLabel=()=>h.evaluate(()=>{for(const el of document.querySelectorAll('.brand'))el.title='Tinka / A rather long project label';});
  await longLabel();
  const headerSpec={groups:['.brand','.board-name','.item-line'],pseudoTargets:'#reader-update'};
  await sweep('reader header, long titles and reload banner',{...headerSpec,root:'.reader-header'});
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
  await stalePage.locator('[data-note="first/one-step"]').fill('Stale Glade tab must not write to Runway');
  await stalePage.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('Saved in this browser'));
  const otherNotes=await (await fetch(`${a.url}api/boards/first-steps/notes`)).json();
  assert.equal(otherNotes['first/one-step'].note,'Runway only');
  await stalePage.close();
  await a.page.goto(`${a.url}boards/first-steps/`);
  await a.page.waitForFunction(()=>document.querySelector('.canvas-header .brand').title.includes('Runway'));
  await a.page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Notes saved on this Mac');
  assert.equal(await a.page.locator('[data-note="first/one-step"]').inputValue(),'Runway only');
  assert.equal(errors.length,0,errors.join('\n'));
  const checks=['two simultaneous labels and URLs','folder discovery and empty new boards','new-board prompt','board and experiment removal prompts, copy and clipboard fallback','board cover prompts, custom images, live image updates and missing-image fallback','open prompts survive shell updates without losing the canvas position','isolated notes, same-origin port reuse and stale-tab write rejection','Home and current-title header, Tools popover with export and help, narrow layouts and prompts','removed top-bar controls stay absent','board footer zoom slider synced with Control-wheel, keyboard, Safari gesture and touch pinch','wheel and drag pan, and free pan past every edge of the board to an 80px bound','keyboard pan with arrows, Page Down, Home and End','focus revealing controls from any side, zoom anchored near an edge, centred Fit after panning away, and round links after panning away','independent experiment interaction','previous/next across rounds, boundaries, live availability, retained settings and narrow viewer','dot track order, grouping, click, keyboard, hover titles and drag-scrub','reader footer Type, Fit, Light, size popover with Version and Custom, and Open standalone','star and notes shared between card and reader and saved to .state/notes.json','notes panel beside the stage on desktop and below it on phones','browser history: home, board, experiments, versions, Escape/Back/breadcrumb, rounds, re-selection, view-only changes, deep links and reload','board view restored on Back from an experiment','active preview safely offers reload','round deep links in tall and zoomed-out canvases','canvas and experiment keyboard focus on entry, return and reload','toolbar keyboard access and note/experiment focus preserved during manifest updates','one-row reader and board footers and both headers at seven widths from 320 to 1920px: no overlap, nothing off screen or clipped, arrows hugging the dot strip, current dot in view, Back distinct from Previous and 44px targets','fixed dot strip: centred current dot, edge fades, Home/End/arrows, endpoints and edge-scrolling drag-scrub','View popover at all widths: every view control inside, keyboard focus, Escape and outside click'];
  console.log(JSON.stringify({passed:true,assertions:assertCount(),checkGroups:checks.length,evidence,checks,browserErrors:errors},null,2));
}finally{
  await browser.close();
  for(const {config} of instances)await main(['stop','--config',config]).catch(()=>{});
  await rm(fixtures,{recursive:true,force:true});
}
