// Headless checks for the opened-Tinka view ("Same frame"): the board's header pattern
// and zoom pill; ⌘/Ctrl-scroll zooming the Tinka's canvas, not the page; Fit and Back;
// the path popover (hover, click, navigate to a neighbour and up); the ‹ n / N › stepper;
// ⌥/Ctrl-arrows, [ ], plain arrows with Tinka focus, ignored inside a text field;
// ⌥↑ up and ⌥↓ down; history not growing per step; every former View-panel function
// reachable; 1440 and 390 screenshots, light and dark. External temporary fixtures only.
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
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-view-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-view-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser,checks=0;const errors=[];
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const eq=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','View studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 const page_=(title,extra='')=>`<!doctype html><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-content:center;gap:16px;font:32px system-ui;background:#f4f1e6;color:#30382a}input{font:18px system-ui;padding:8px}</style><h1>${title}</h1>${extra}`;
 await writeFile(path.join(assets,'quiet.html'),page_('Quiet opening','<input id="field" aria-label="Field" value="type here">'));
 await writeFile(path.join(assets,'bold.html'),page_('Bold opening'));
 await writeFile(path.join(assets,'bold-2.html'),page_('Bold opening, second'));
 await writeFile(path.join(assets,'kit.html'),page_('Starter kit'));
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'product',title:'Product'});
 await op('createBoard',{id:'lab',title:'Design Lab',parentBoardId:'product'});
 const html=p=>({kind:'html',resource:{rootId:'assets',path:p}});
 const place=(i,w=720,h=560)=>({x:i*780,y:0,width:w,height:h,presentation:{mode:'panel',viewport:{width:1000,height:720}}});
 const quiet=await op('createItem',{boardId:'lab',item:{title:'Quiet opening',number:'01',description:'A calm first step',content:html('quiet.html')},placement:place(0)});
 const bold=await op('createItem',{boardId:'lab',item:{title:'Bold opening',number:'02',content:html('bold.html'),revisions:[{id:'second',name:'Second version',content:html('bold-2.html')}]},placement:place(1)});
 const idea=await op('createItem',{boardId:'lab',item:{title:'A plain idea',content:{kind:'note',text:'Write it down.'}},placement:{x:2*780,y:0,width:320,height:260}});
 await op('createBoard',{id:'archive-room',title:'Board only',parentBoardId:'lab'});
 const kit=await op('createItem',{boardId:'lab',item:{title:'Starter kit',content:html('kit.html')},placement:place(4)});
 await op('createBoard',{id:'kit-parts',title:'Kit parts',itemId:kit.itemId});
 await op('createItem',{boardId:'kit-parts',item:{title:'Part one'}});await op('createItem',{boardId:'kit-parts',item:{title:'Part two'}});
 // Content that focuses itself as it loads (a prototype focusing its own canvas), with very different title lengths.
 await op('createBoard',{id:'focus-lab',title:'Focus lab',parentBoardId:'product'});
 const grabby=[];
 for(let i=0;i<7;i++){
  const title=i%2?`Step ${i+1}`:`Step ${i+1}: a much longer title that keeps going and going so the header has to truncate it somewhere`;
  await writeFile(path.join(assets,`grab-${i}.html`),page_(title,'<main id="viewport" tabindex="-1" style="outline:none">canvas</main><script>document.getElementById("viewport").focus();addEventListener("load",()=>setTimeout(()=>document.getElementById("viewport").focus(),120));</script>'));
  grabby.push(await op('createItem',{boardId:'focus-lab',item:{title,content:html(`grab-${i}.html`)},placement:place(i)}));
 }
 await op('review',{itemId:grabby[2].itemId,patch:{note:'A note, so the notes dot shows on this one.'}});
 // The quiet opening also appears on Product.
 await op('reference',{sourceBoardId:'lab',placementIds:[quiet.placementIds[0]],targetBoardId:'product'});
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light',reducedMotion:'reduce'});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const name=()=>page.locator('#reader-name').textContent();
 const waitName=title=>page.waitForFunction(t=>document.querySelector('#reader-name')?.textContent===t,title,{timeout:5000});
 const plane=()=>page.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.getElementById('reader-plane')).transform);return {zoom:m.a,x:m.e,y:m.f};});
 const openLab=async()=>{await page.goto(base+'/boards/lab/?from=product',{waitUntil:'load'});await page.locator('.workspace-card').first().waitFor();
  if(await page.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.keyboard.press('Escape');}};
 const openItem=async placementId=>{await page.locator(`[data-placement="${placementId}"] [data-open]`).first().click();await page.locator('#reader-dialog[open]').waitFor();await page.waitForTimeout(150);};
 const pill=['#reader-zoom-minus','#reader-zoom-toggle','#reader-zoom-plus','#reader-fit'];
 const visible=async selector=>page.locator(selector).isVisible();
 const historyLength=()=>page.evaluate(()=>history.length);
 const headerBox=()=>page.locator('#reader-header').boundingBox();
 const pressInFrame=async(selector,key)=>{const frame=page.frameLocator('#active-reader');await frame.locator('iframe').first().waitFor().catch(()=>{});};

 // (1) The board's header pattern and the board's pill; no editing tools; Tinka has focus.
 await openLab();
 const boardHistory=await historyLength();
 await openItem(quiet.placementIds[0]);
 for(const selector of ['#reader-navigator','#reader-home','#close-reader','#reader-path','#reader-stepper','#reader-search','#reader-info-toggle',...pill])ok(await visible(selector),`${selector} is in the opened Tinka's chrome`);
 eq(await page.locator('#reader-up-label').textContent(),'Design Lab','‹ parent names the board');
 eq(await page.locator('#reader-count').textContent(),'1 / 4','The stepper counts this board, skipping the board-only Tinka');
 eq(await page.locator('#reader-zoom-toggle').textContent(),'100%');
 ok(await page.locator('#reader-dialog #dot-track, #reader-dialog #view-toggle, #reader-dialog .chrome-add, #reader-dialog #chrome-undo').count()===0,'No footer dots, View button, Add or Undo in an opened Tinka');
 ok(await page.locator('#reader-view-back').isHidden(),'Back is hidden before any fit');
 eq(await page.evaluate(()=>document.activeElement?.id),'reader-stage','Opening leaves focus on Tinka, not inside the content');
 const fitted=await plane();
 eq(fitted.zoom,1,'A Fit-size window opens at 100%');
 const winBox=await page.locator('#reader-window').boundingBox(),pillBox=await page.locator('#reader-dialog .zoom-pill').boundingBox();
 ok(winBox.y+winBox.height<=pillBox.y+1,'The fitted window stays clear of the pill (and its resize corner stays reachable)');
 await page.screenshot({path:path.join(evidence,'tinka-view-1440-light.png')});
 // The Navigator opens inside the opened Tinka, and Escape closes it before anything else.
 await page.locator('#reader-navigator').click();
 await page.locator('#project-navigator').waitFor({state:'visible'});
 ok(await page.locator('#reader-dialog #project-navigator').count()===1,'The Navigator opens inside the opened Tinka');
 eq(await page.locator('#reader-navigator').getAttribute('aria-expanded'),'true');
 await page.keyboard.press('Escape');await page.locator('#project-navigator').waitFor({state:'hidden'});
 ok(await page.locator('#reader-dialog').evaluate(d=>d.open),'Escape closes the Navigator and leaves the Tinka open');
 await page.locator('#reader-stage').focus();

 // (2) ⌘/Ctrl-scroll zooms the canvas, over the background and over local content; the page does not zoom.
 const header0=await headerBox();
 const stage=await page.locator('#reader-stage').boundingBox();
 await page.mouse.move(stage.x+8,stage.y+8);
 await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');
 await page.waitForTimeout(60);
 const z1=await plane();ok(z1.zoom>1.2,`Control-scroll over the canvas zooms the Tinka: ${z1.zoom}`);
 await page.waitForFunction(()=>document.querySelector('#active-reader').contentDocument?.querySelector('iframe')?.contentDocument?.querySelector('h1'),null,{timeout:5000});
 const frameBox=await page.locator('#reader-window').boundingBox();
 await page.mouse.move(frameBox.x+frameBox.width/2,frameBox.y+frameBox.height/3);
 await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');
 await page.waitForTimeout(60);
 const z2=await plane();ok(z2.zoom>z1.zoom*1.2,`Control-scroll over local content zooms the Tinka too: ${z1.zoom} → ${z2.zoom}`);
 const header1=await headerBox();
 eq([header1.height,header1.width],[header0.height,header0.width],'The header keeps its size: the page itself never zooms');
 eq(await page.evaluate(()=>visualViewport.scale),1,'No page zoom');
 eq(await page.locator('#reader-zoom-toggle').textContent(),`${Math.round(z2.zoom*100)}%`,'The % readout follows the canvas');
 // Fit returns to the fitted view; Back returns to the zoom before it, then goes away.
 await page.locator('#reader-fit').click();
 eq(await plane(),fitted,'Fit returns to the fitted view');
 ok(await page.locator('#reader-view-back').isVisible(),'Back appears after a fit');
 await page.locator('#reader-view-back').click();await page.waitForTimeout(40);
 const back=await plane();ok(Math.abs(back.zoom-z2.zoom)<1e-6&&Math.abs(back.x-z2.x)<1,'Back restores the view before the fit (instantly with reduced motion)');
 ok(await page.locator('#reader-view-back').isHidden(),'Back goes away once used');
 await page.locator('#reader-stage').focus();await page.keyboard.press('f');
 eq((await plane()).zoom,1,'F fits too');
 await page.keyboard.press('Shift+Digit0');eq((await plane()).zoom,1,'Shift-0 is 100%');
 await page.keyboard.press('=');ok((await plane()).zoom>1.2,'+ zooms in');await page.keyboard.press('Shift+Digit1');eq((await plane()).zoom,1,'Shift-1 fits');

 // (3) The path: hover (after a delay) shows where you are and the neighbours; leaving closes it; click pins.
 await page.locator('#reader-path').hover();
 await page.locator('#reader-path-pop').waitFor({state:'visible',timeout:2000});
 const rows=await page.locator('#reader-path-pop .reader-path-ladder .reader-path-title').allTextContents();
 eq(rows,['Home','Product','Design Lab','01 · Quiet opening'],'The ladder runs Home → Product → Design Lab → this Tinka');
 eq(await page.locator('#reader-path-pop .reader-path-sibs .tk-eyebrow').textContent(),'On Design Lab · 4');
 eq(await page.locator('#reader-path-pop .reader-path-sibs .reader-path-title').allTextContents(),['01 · Quiet opening','02 · Bold opening','A plain idea','Starter kit'],'Numbered neighbours in board order');
 ok(await page.locator('#reader-path-pop [aria-label="Also on"]').getByText('Product').isVisible(),'A Tinka placed on several boards lists where else it appears');
 await page.mouse.move(700,500);await page.locator('#reader-path-pop').waitFor({state:'hidden',timeout:2000});checks++;
 await page.locator('#reader-path').click();await page.locator('#reader-path-pop').waitFor({state:'visible'});
 await page.mouse.move(700,500);await page.waitForTimeout(500);
 ok(await visible('#reader-path-pop'),'Click pins the path open');
 const h0=await historyLength();
 await page.locator('#reader-path-pop .reader-path-sibs [data-path-go]').nth(1).click();await waitName('Bold opening');checks++;
 ok(await page.locator('#reader-path-pop').isHidden(),'Choosing a neighbour closes the path');
 eq(await page.locator('#reader-count').textContent(),'2 / 4');

 // (4) The stepper buttons.
 await page.locator('#reader-next').click();await waitName('A plain idea');
 await page.locator('#reader-previous').click();await waitName('Bold opening');
 checks+=2;

 // (5) Keys: ⌥→ (this Mac's platform), ], [, plain arrows with Tinka focus, ignored in a text field.
 const mac=await page.evaluate(()=>/mac/i.test(navigator.userAgentData?.platform||navigator.platform));
 const chord=mac?'Alt':'Control';
 await page.locator('#reader-stage').focus();
 await page.keyboard.press(`${chord}+ArrowRight`);await waitName('A plain idea');checks++;
 await page.keyboard.press(`${mac?'Control':'Alt'}+ArrowRight`);await page.waitForTimeout(150);eq(await name(),'A plain idea','The other platform\'s chord is not taken');
 await page.keyboard.press(`${chord}+ArrowLeft`);await waitName('Bold opening');checks++;
 await page.keyboard.press(']');await waitName('A plain idea');checks++;
 await page.keyboard.press('[');await waitName('Bold opening');checks++;
 eq(await page.evaluate(()=>document.activeElement?.id),'reader-stage','Stepping keeps focus on Tinka');
 await page.keyboard.press('ArrowRight');await waitName('A plain idea');checks++;
 await page.keyboard.press('ArrowLeft');await waitName('Bold opening');checks++;
 await page.keyboard.press('ArrowLeft');await waitName('Quiet opening');checks++;
 // Inside content: the chord steps from a non-text spot, but a text field keeps it.
 const inner=page.frameLocator('#active-reader').frameLocator('iframe');
 await inner.locator('#field').waitFor();
 await inner.locator('#field').click();
 await page.keyboard.press(`${chord}+ArrowRight`);await page.waitForTimeout(200);
 eq(await name(),'Quiet opening','The chord is ignored inside a text field');
 await page.keyboard.press(']');await page.waitForTimeout(150);eq(await name(),'Quiet opening','] types in a field');
 await inner.locator('h1').click();
 await page.keyboard.press(`${chord}+ArrowRight`);await waitName('Bold opening');checks++;
 eq(await page.evaluate(()=>document.activeElement?.id),'reader-stage','A step from the content lands focus on Tinka');
 eq(await historyLength(),h0,'Stepping replaces the history entry instead of adding one');

 // (6) Former View-panel functions, now in the % menu and the Inspector.
 await page.locator('#reader-zoom-toggle').click();await page.locator('#reader-zoom-menu').waitFor({state:'visible'});
 ok(await page.locator('#reader-zoom-menu [data-size="fit"]').isVisible()&&await page.locator('#reader-zoom-menu [data-size="wide"]').isVisible(),'Window size is in the % menu');
 ok(await page.locator('#revision-options').getByText('Second version').isVisible(),'Version is in the % menu');
 ok(await page.locator('#reader-theme').isVisible()&&await page.locator('#reader-type').isVisible(),'Paper/Night and Type size are in the % menu');
 ok((await page.locator('#reader-standalone').getAttribute('href')||'').length>1,'Open standalone is in the % menu');
 await page.screenshot({path:path.join(evidence,'tinka-view-1440-light-zoom-menu.png')});
 await page.locator('#reader-zoom-menu [data-size="compact"]').click();
 eq(await page.locator('#reader-window').getAttribute('data-size'),'compact');
 eq(Math.round((await page.locator('#reader-window').boundingBox()).width),440,'Compact is a true 440-wide window at 100%');
 await page.locator('#reader-theme').click();eq(await page.locator('#reader-theme').getAttribute('aria-pressed'),'true','Night');
 await page.locator('[data-reader-light="paper"]').click();
 await page.locator('#reader-type').fill('115');eq(await page.locator('#reader-type').getAttribute('aria-valuetext'),'115%');
 await page.locator('#revision-options').getByText('Second version').click();await waitName('Bold opening · Second version');checks++;
 await page.locator('#reader-zoom-toggle').click();await page.locator('#reader-zoom-menu [data-size="fit"]').click();await page.keyboard.press('Escape');
 ok(await page.locator('#reader-zoom-menu').isHidden(),'Escape closes the % menu first');
 ok(await page.locator('#reader-dialog').evaluate(d=>d.open),'…and leaves the Tinka open');
 await page.keyboard.press('Meta+i');if(await page.locator('#reader-info').isHidden())await page.keyboard.press('Control+i');
 await page.locator('#reader-info').waitFor({state:'visible'});checks++;
 const info=page.locator('#reader-info');
 for(const label of ['Add board…','Open standalone ↗','Reload','Favorite','Notes','Comments','Vote','Edit details…','Move to board…','Add reference…','Show on parent…','Keyboard shortcuts'])ok(await info.getByRole('button',{name:label,exact:true}).or(info.getByRole('link',{name:label,exact:true})).first().isVisible(),`Inspector offers ${label}`);
 ok(await info.locator('[data-revision-choice]').count()===2,'Versions are in the Inspector too');
 ok(await info.locator('.appearance-control select').isVisible(),'Appearance is in the Inspector');
 await page.screenshot({path:path.join(evidence,'tinka-view-1440-light-inspector.png')});
 await info.getByRole('button',{name:'Move to board…'}).click();
 await page.locator('dialog.workspace-dialog[open]').waitFor();ok(true,'Move to board… opens its dialog');
 await page.locator('dialog.workspace-dialog[open] .workspace-close').click();
 await info.getByRole('button',{name:'Edit details…'}).click();await page.locator('dialog.workspace-dialog[open]').waitFor();checks++;
 await page.locator('dialog.workspace-dialog[open] .workspace-close').click();
 await info.getByRole('button',{name:'Keyboard shortcuts'}).click();
 const sheet=page.locator('dialog.workspace-dialog[open]');await sheet.waitFor();
 ok((await sheet.textContent()).includes(`${mac?'⌥':'Ctrl+'}← · ${mac?'⌥':'Ctrl+'}→`),'The shortcut sheet names this platform\'s step keys');
 await sheet.locator('.workspace-close').click();
 await page.keyboard.press('Escape');await page.locator('#reader-info').waitFor({state:'hidden'});checks++;

 // (7) Down and up: ⌥↓ goes into Starter kit's board, ⌥↑ goes up; the ↓ Board · 2 chip.
 await page.locator('#reader-stage').focus();
 await page.keyboard.press(`${chord}+ArrowRight`);await waitName('A plain idea');
 ok(await page.locator('#reader-down').isHidden(),'No ↓ chip without its own board');
 await page.keyboard.press(`${chord}+ArrowDown`);await page.waitForTimeout(150);eq(await name(),'A plain idea','⌥↓ does nothing without a board');
 await page.keyboard.press(`${chord}+ArrowRight`);await waitName('Starter kit');
 eq(await page.locator('#reader-down').textContent(),'Board · 2','↓ Board · N steps down to its own board');
 await page.locator('#reader-path').click();
 eq(await page.locator('#reader-path-pop .reader-path-ladder .reader-path-title').last().textContent(),'Kit parts','The ladder continues into its own board');
 await page.keyboard.press('Escape');
 await page.locator('#reader-stage').focus();
 await page.keyboard.press(`${chord}+ArrowUp`);await page.locator('#reader-dialog').waitFor({state:'hidden'});checks++;
 ok(/^(#round-|$)/.test(new URL(page.url()).hash),'Up returns to the board');
 eq(await historyLength(),h0+1,'Up adds one entry, so browser Back reopens the last Tinka');
 await page.goBack();await page.locator('#reader-dialog[open]').waitFor();await waitName('Starter kit');checks++;
 await page.locator('#reader-stage').focus();
 await page.keyboard.press(`${chord}+ArrowDown`);await page.waitForURL(/\/boards\/kit-parts\/\?from=lab/);checks++;
 eq(boardHistory+3,await historyLength(),'Opening, up and down are the only history entries');

 // (8) The path goes up a level and to an ancestor.
 await openLab();await openItem(bold.placementIds[0]);
 await page.locator('#reader-path').click();await page.locator('#reader-path-pop [data-path-go="up"]').click();
 await page.locator('#reader-dialog').waitFor({state:'hidden'});checks++;
 await openItem(bold.placementIds[0]);
 await page.locator('#reader-path').click();await page.locator('#reader-path-pop .reader-path-ladder').getByText('Product').click();
 await page.waitForURL(/\/boards\/product\/$/);checks++;

 // (9) Windows / Linux: Ctrl+arrows step, Alt+arrows stay browser Back.
 const win=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
 await win.addInitScript(()=>{Object.defineProperty(Navigator.prototype,'platform',{get:()=>'Win32'});Object.defineProperty(Navigator.prototype,'userAgentData',{get:()=>({platform:'Windows'})});});
 const wp=await win.newPage();wp.on('pageerror',e=>errors.push(e.message));
 await wp.goto(base+'/boards/lab/',{waitUntil:'load'});await wp.locator('.workspace-card').first().waitFor();
 await wp.locator(`[data-placement="${quiet.placementIds[0]}"] [data-open]`).first().click();await wp.locator('#reader-dialog[open]').waitFor();
 await wp.keyboard.press('Control+ArrowRight');await wp.waitForFunction(()=>document.querySelector('#reader-name').textContent==='Bold opening');checks++;
 await wp.keyboard.press('Alt+ArrowLeft');await wp.waitForTimeout(150);
 ok(await wp.locator('#reader-name').textContent()!=='Quiet opening'||!(await wp.locator('#reader-dialog').evaluate(d=>d.open)),'Alt+← is not a step on Windows');
 ok((await wp.locator('#reader-next').getAttribute('title')).includes('Ctrl+→'),'Windows titles name Ctrl+→');
 await win.close();

 // (10) Dark, and a phone: the title row wraps, the stepper and path still work, no sideways scroll.
 await page.emulateMedia({colorScheme:'dark'});
 await openLab();await openItem(kit.placementIds[0]);
 await page.locator('#reader-path').hover();await page.locator('#reader-path-pop').waitFor({state:'visible'});
 await page.screenshot({path:path.join(evidence,'tinka-view-1440-dark-path.png')});
 await page.mouse.move(700,600);await page.locator('#reader-path-pop').waitFor({state:'hidden'});
 await page.emulateMedia({colorScheme:'light'});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
 const phone=await page.evaluate(()=>{const h=document.getElementById('reader-header').getBoundingClientRect(),t=document.querySelector('.reader-title-row').getBoundingClientRect(),n=document.getElementById('reader-navigator').getBoundingClientRect();return {scroll:document.documentElement.scrollWidth,dialog:document.getElementById('reader-dialog').scrollWidth,header:document.getElementById('reader-header').scrollWidth,width:innerWidth,wrapped:t.top>=n.bottom-1,titleWidth:t.width};});
 ok(phone.scroll<=phone.width&&phone.dialog<=phone.width&&phone.header<=phone.width,`No sideways scroll at 390: ${JSON.stringify(phone)}`);
 ok(phone.wrapped,'On a phone the title gets its own row');
 for(const selector of ['#reader-previous','#reader-count','#reader-next','#reader-path','#reader-down',...pill]){const box=await page.locator(selector).boundingBox();ok(box&&box.x>=0&&box.x+box.width<=390,`${selector} fits at 390`);}
 await page.screenshot({path:path.join(evidence,'tinka-view-390-light.png')});
 await page.locator('#reader-previous').click();await waitName('A plain idea');checks++;
 await page.locator('#reader-path').click();await page.locator('#reader-path-pop').waitFor({state:'visible'});
 const popBox=await page.locator('#reader-path-pop').boundingBox();ok(popBox.x>=0&&popBox.x+popBox.width<=390,'The path fits a phone');
 await page.screenshot({path:path.join(evidence,'tinka-view-390-light-path.png')});
 await page.locator('#reader-path-pop .reader-path-sibs').getByText('Starter kit').click();await waitName('Starter kit');checks++;
 await page.setViewportSize({width:1440,height:900});

 // (11) Repeated stepping keeps working although each new Tinka's content focuses itself, the stepper
 // holds still across very different titles (and a notes dot), and the path closes on click-away.
 await page.setViewportSize({width:1244,height:860});
 await page.goto(base+'/boards/focus-lab/?from=product',{waitUntil:'load'});await page.locator('.workspace-card').first().waitFor();
 await openItem(grabby[0].placementIds[0]);await page.waitForTimeout(400);
 const contentFocused=()=>page.evaluate(()=>document.activeElement===document.getElementById('active-reader'));
 const stepperX=()=>page.evaluate(()=>['reader-previous','reader-count','reader-next'].map(id=>Math.round(document.getElementById(id).getBoundingClientRect().x)));
 const x0=await stepperX();
 const titleOf=i=>grabby[i]&&(i%2?`Step ${i+1}`:`Step ${i+1}: a much longer title that keeps going and going so the header has to truncate it somewhere`);
 ok(!(await contentFocused()),'Opening keeps focus with Tinka although the content focuses itself');
 let at=0;
 const settle=async()=>{await waitName(titleOf(at)).catch(async e=>{throw new Error(`Expected ${titleOf(at)}; ${JSON.stringify(await page.evaluate(()=>({name:document.querySelector('#reader-name').textContent,active:document.activeElement?.tagName+'#'+document.activeElement?.id,inner:(()=>{try{const d=document.getElementById('active-reader').contentDocument;return d.activeElement?.tagName+'>'+(d.activeElement?.contentDocument?.activeElement?.id||'')}catch{return 'x'}})()})))}`);});await page.waitForTimeout(350);};
 for(let n=0;n<5;n++){await page.keyboard.press(`${chord}+ArrowRight`);at++;await settle();eq(await stepperX(),x0,`The stepper holds still at step ${at+1}`);ok(!(await contentFocused()),`Focus stays with Tinka after ${chord}+→ #${n+1}`);}
 eq(at,5,'Five chord presses advance five Tinkas without a click');
 for(let n=0;n<5;n++){await page.keyboard.press('ArrowLeft');at--;await settle();}
 eq(await name(),titleOf(0),'Five plain ← presses step back five Tinkas without a click');
 await page.locator('#reader-next').click();at++;await settle();
 for(let n=0;n<5;n++){await page.keyboard.press('ArrowRight');at++;await settle();if(at<6)eq(await page.evaluate(()=>document.activeElement?.id),'reader-next',`Focus stays on Next after → #${n+1}`);}
 eq([await name(),await page.evaluate(()=>document.activeElement?.id)],[titleOf(6),'reader-stage'],'After clicking Next, five plain → presses keep stepping; at the end (Next disabled) focus is on Tinka');
 await page.keyboard.press('[');at--;await settle();await page.keyboard.press('[');at--;await settle();await page.keyboard.press(']');at++;await settle();
 eq(await name(),titleOf(5),'[ and ] keep stepping too');
 // A click on the header's background lands on Tinka's canvas, so the plain keys still work.
 const hb=await page.locator('#reader-header').boundingBox(),sb=await page.locator('#reader-stepper').boundingBox();
 const spot=await page.evaluate(([x,y])=>{const e=document.elementFromPoint(x,y);return e.tagName+'#'+e.id+'.'+e.className;},[sb.x-6,hb.y+hb.height-3]);
 await page.mouse.click(sb.x-6,hb.y+hb.height-3);await page.waitForTimeout(60);
 eq(await page.evaluate(()=>document.activeElement?.tagName+'#'+document.activeElement?.id)+' @'+spot,'DIV#reader-stage @'+spot,'A click on the header background leaves focus on Tinka, not the page body');
 await page.keyboard.press('ArrowLeft');at--;await settle();checks++;
 await page.screenshot({path:path.join(evidence,'tinka-view-1244-header.png'),clip:{x:0,y:0,width:1244,height:Math.ceil(hb.height)+8}});
 // Working in the content keeps its focus: a click inside it is not undone.
 await page.frameLocator('#active-reader').frameLocator('iframe').locator('#viewport').click();await page.waitForTimeout(300);
 ok(await contentFocused(),'A click in the content keeps focus there');
 await page.locator('#reader-stage').focus();
 // The path: a press outside it (on the content, on the header) or Escape closes it; the trigger still toggles.
 const popOpen=()=>page.locator('#reader-path-pop').isVisible();
 await page.locator('#reader-path').click();ok(await popOpen(),'The title opens the path');
 const wb=await page.locator('#reader-window').boundingBox();
 await page.mouse.click(wb.x+wb.width/2,wb.y+wb.height/2);await page.waitForTimeout(250);
 ok(!(await popOpen()),'A click on the content closes the path');
 await page.locator('#reader-path').click();ok(await popOpen());
 await page.mouse.click(sb.x-6,hb.y+hb.height-3);await page.waitForTimeout(100);
 ok(!(await popOpen()),'A click on the header background closes the path');
 await page.locator('#reader-path').click();await page.locator('#reader-path').click();await page.waitForTimeout(100);
 ok(!(await popOpen()),'Clicking the title again closes it');
 await page.locator('#reader-count').click();ok(await popOpen(),'The count opens the list');
 await page.keyboard.press('Escape');await page.waitForTimeout(100);
 ok(!(await popOpen())&&await page.locator('#reader-dialog').evaluate(d=>d.open),'Escape closes the path and leaves the Tinka open');
 eq(await page.evaluate(()=>document.activeElement?.id),'reader-count','Escape returns focus to the trigger');
 await page.keyboard.press(`${chord}+ArrowRight`);at++;await settle();
 ok(await page.locator('#reader-path-pop').isHidden(),'Stepping with the path closed keeps it closed');
 await page.locator('#reader-path').click();await page.keyboard.press(`${chord}+ArrowLeft`);at--;await settle();
 ok(await popOpen(),'Stepping while the path is open (and the new content grabs focus) keeps it open');
 await page.keyboard.press('Escape');
}finally{
 await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});
}
if(errors.length)throw new Error(errors.join('\n'));
console.log(`Tinka view browser checks passed (${checks}).`);
