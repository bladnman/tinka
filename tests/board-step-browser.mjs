// Headless checks for ⌥←/⌥→ on a board (the opened Tinka's step keys): the selection
// steps one Tinka at a time in the stepper's order, skipping what it skips, and each
// one comes into view (zooming out only for a Tinka too big to fit); nothing selected
// starts at an end; the ends stop; text fields keep the keys. Also: no dots until a
// board is given them, and no focus ring on a clicked zoom-pill button.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-board-step-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-board-step-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser,checks=0;const errors=[];
const ok=(value,message)=>{assert.ok(value,message);checks++;};
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Step studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 await op('createBoard',{id:'steps',title:'Steps'});
 // Spread far apart so most are off screen; review order deliberately differs from position.
 const add=async(title,placement,extra={})=>(await op('createItem',{boardId:'steps',item:{title,content:{kind:'note',text:`${title}.`},...extra},placement})).placementIds[0];
 const p={};
 p.east=await add('East',{x:4200,y:0,width:320,height:220});
 p.west=await add('West',{x:0,y:0,width:320,height:220});
 p.reserved=await add('Reserved slot',{x:900,y:0,width:320,height:220},{build:{state:'reserved',message:'Later.'}});
 p.south=await add('South',{x:0,y:3200,width:320,height:220});
 p.giant=await add('Giant',{x:2400,y:1600,width:4200,height:3000});
 p.middle=await add('Middle',{x:1800,y:600,width:320,height:220});
 const owner=await op('createItem',{boardId:'steps',item:{title:'Board only'},placement:{x:600,y:900,width:320,height:220}});p.boardOnly=owner.placementIds[0];
 await op('createBoard',{itemId:owner.itemIds?.[0]??owner.itemId,title:'Inside',parentBoardId:'steps'});
 p.last=await add('Last',{x:5200,y:2400,width:320,height:220});
 await op('createDecoration',{boardId:'steps',decoration:{type:'region',shape:'rounded',x:300,y:400,width:200,height:140,color:'#f3d36b',text:'A sticky'}});
 const order=[p.west,p.reserved,p.middle,p.boardOnly,p.east,p.giant,p.south,p.last];
 await op('updateBoard',{boardId:'steps',patch:{reviewOrder:order}});
 const sequence=[p.west,p.middle,p.east,p.giant,p.south,p.last];
 await op('createBoard',{id:'plain',title:'Plain'});await op('createItem',{boardId:'plain',item:{title:'One'},placement:{x:0,y:0,width:320,height:220}});
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1244,height:820},colorScheme:'light',reducedMotion:'reduce'});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const open=async id=>{await page.goto(base+`/boards/${id}/`,{waitUntil:'load'});await page.locator('.workspace-card').first().waitFor();
  if(await page.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.keyboard.press('Escape');}
  await page.waitForTimeout(150);};
 const selected=()=>page.evaluate(()=>[...document.querySelectorAll('#world .workspace-card.selected')].map(c=>c.dataset.placement));
 const zoom=()=>page.evaluate(()=>new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a);
 // Fully inside the canvas, left of an open map.
 const inView=id=>page.evaluate(id=>{const v=document.getElementById('viewport').getBoundingClientRect(),map=document.getElementById('board-map');
  const right=map&&!map.hidden&&map.offsetWidth?map.getBoundingClientRect().left:v.right;const r=document.querySelector(`.workspace-card[data-placement="${id}"]`).getBoundingClientRect();
  return r.left>=v.left-1&&r.top>=v.top-1&&r.right<=right+1&&r.bottom<=v.bottom+1;},id);
 const step=async key=>{await page.keyboard.press(key);await page.waitForTimeout(60);};

 await open('steps');
 ok(!(await inView(p.east))&&!(await inView(p.last)),'Some Tinkas start off screen');
 // Nothing selected: ⌥→ starts at the first Tinka in stepper order.
 await step('Alt+ArrowRight');
 assert.deepEqual(await selected(),[sequence[0]]);checks++;
 ok(await inView(sequence[0]),'The first Tinka is in view');
 // Five more presses: five successive Tinkas, one at a time, each in view; reserved and board-only are skipped.
 const zoom0=await zoom();
 for(let i=1;i<=5;i++){
  await step('Alt+ArrowRight');
  assert.deepEqual(await selected(),[sequence[i]],`Press ${i} selects ${sequence[i]}`);checks++;
  ok(await inView(sequence[i]),`Tinka ${i+1} of ${sequence.length} ends in view`);
  if(sequence[i]===p.giant)ok(await zoom()<zoom0,'A Tinka too big to fit zooms out just enough');
  else ok(Math.abs(await zoom()-zoom0)<1e-6,`Tinka ${i+1} keeps (or returns to) the zoom stepping began at: ${await zoom()} vs ${zoom0}`);
 }
 await page.screenshot({path:path.join(evidence,'board-step-1244-last.png')});
 // The end stops, as the opened Tinka's stepper does.
 await step('Alt+ArrowRight');
 assert.deepEqual(await selected(),[p.last]);checks++;
 ok(await page.locator('#view-announce').textContent()==='Last Tinka on this board','The end is announced');
 // ⌥← goes back.
 await step('Alt+ArrowLeft');
 assert.deepEqual(await selected(),[sequence[4]]);checks++;
 ok(await inView(sequence[4]),'Stepping back brings it into view');
 // Plain arrows still nudge rather than step; Escape clears; ⌥← with nothing selected starts at the last.
 await page.keyboard.press('Escape');assert.deepEqual(await selected(),[]);checks++;
 await step('Alt+ArrowLeft');assert.deepEqual(await selected(),[p.last]);checks++;
 // From a selected board-only Tinka (the stepper skips it), next is the one after it.
 await page.keyboard.press('Escape');
 await page.locator(`.workspace-card[data-placement="${p.boardOnly}"] [data-placement-select]`).evaluate(b=>b.click());
 assert.deepEqual(await selected(),[p.boardOnly]);
 await step('Alt+ArrowRight');assert.deepEqual(await selected(),[p.east]);checks++;
 // The same order as the opened Tinka: open the third and read its stepper.
 await page.keyboard.press('Escape');
 for(let i=0;i<3;i++)await step('Alt+ArrowRight');
 assert.deepEqual(await selected(),[sequence[2]]);checks++;
 await page.keyboard.press('Enter');
 await page.locator('#reader-dialog[open]').waitFor();
 await page.waitForFunction(()=>document.getElementById('reader-count').textContent.trim()!=='');
 assert.equal((await page.locator('#reader-count').textContent()).trim(),`3 / ${sequence.length}`);checks++;
 await page.keyboard.press('Escape');await page.locator('#reader-dialog').waitFor({state:'hidden'}).catch(()=>{});await page.waitForTimeout(200);
 // Typing in a text field never steps.
 await page.locator('#board-info-toggle').click();
 const search=page.locator('#workspace-search');await search.click();
 const before=await selected();
 await page.keyboard.press('Alt+ArrowRight');await page.waitForTimeout(60);
 assert.deepEqual(await selected(),before,'⌥→ in a text field leaves the selection');checks++;
 await page.keyboard.press('Escape');

 // Dots: off on a board nobody has chosen for; an explicit choice is kept.
 await open('plain');
 const pattern=()=>page.evaluate(()=>({value:document.getElementById('viewport').dataset.canvasPattern,image:getComputedStyle(document.getElementById('viewport')).backgroundImage}));
 let pat=await pattern();
 ok(pat.value==='plain'&&pat.image==='none',`A fresh board has no dots: ${JSON.stringify(pat)}`);
 await page.locator('#zoom-menu-toggle').click();
 ok(await page.locator('#zoom-menu [data-canvas-pattern="plain"]').getAttribute('aria-pressed')==='true','The zoom menu shows Plain chosen');
 await page.locator('#zoom-menu [data-canvas-pattern="dots"]').click();await page.keyboard.press('Escape');
 await open('plain');
 pat=await pattern();
 ok(pat.value==='dots'&&pat.image.includes('radial-gradient'),`An explicit Dots choice is kept: ${JSON.stringify(pat)}`);
 await page.locator('#board-info-toggle').click();
 ok(await page.locator('#board-info [data-canvas-pattern="dots"]').getAttribute('aria-pressed')==='true','The Inspector shows Dots chosen');
 await page.keyboard.press('Escape');await page.waitForTimeout(100);
 await page.screenshot({path:path.join(evidence,'board-dots-1244-light.png')});

 // Focus rings: a clicked zoom-pill button shows none, even after a key; Tab focus does.
 const ring=sel=>page.evaluate(sel=>{const e=document.querySelector(sel);return {focused:document.activeElement===e,outline:getComputedStyle(e).outlineStyle};},sel);
 for(const sel of ['#board-map-toggle','#fit','#zoom-plus']){
  await page.locator(sel).click();await page.keyboard.press('Shift');
  const r=await ring(sel);ok(r.focused&&r.outline==='none',`${sel} clicked then a key: focused, no ring (${JSON.stringify(r)})`);
  if(sel==='#board-map-toggle'&&await page.locator('#board-map').isVisible())await page.locator('#board-map-toggle').click();
 }
 // A panel opened with the mouse and closed with Escape hands focus back without a ring.
 await page.locator('#board-info-toggle').click();await page.keyboard.press('Escape');
 const back=await ring('#board-info-toggle');ok(back.focused&&back.outline==='none',`Escape back to a clicked toggle shows no ring: ${JSON.stringify(back)}`);
 await page.locator('#zoom-plus').click();
 await page.keyboard.press('Shift+Tab');
 const tabbed=await page.evaluate(()=>({id:document.activeElement.id,outline:getComputedStyle(document.activeElement).outlineStyle}));
 ok(tabbed.id==='zoom-menu-toggle'&&tabbed.outline==='solid',`Tab focus keeps its ring: ${JSON.stringify(tabbed)}`);
 // With motion the step glides there rather than jumping.
 const moving=await browser.newContext({viewport:{width:1244,height:820},colorScheme:'dark'});const mp=await moving.newPage();mp.on('pageerror',e=>errors.push(e.message));
 await mp.goto(base+'/boards/steps/',{waitUntil:'load'});await mp.locator('.workspace-card').first().waitFor();await mp.waitForTimeout(150);
 const plane=()=>mp.evaluate(()=>new DOMMatrix(getComputedStyle(document.getElementById('plane')).transform).e);
 await mp.keyboard.press('Alt+ArrowRight');await mp.keyboard.press('Alt+ArrowRight');const startX=await plane();await mp.waitForTimeout(80);const midX=await plane();await mp.waitForTimeout(500);const endX=await plane();
 ok(midX!==endX&&startX!==endX,`The view glides to the next Tinka: ${startX} → ${midX} → ${endX}`);
 await mp.screenshot({path:path.join(evidence,'board-step-1244-dark.png')});
 await moving.close();
 assert.deepEqual(errors,[]);checks++;
 console.log(`Board step browser checks passed: ${checks} assertions. Evidence: ${evidence}`);
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
