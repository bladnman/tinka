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
 await op('createBoard',{id:'cursor',title:'Cursor'});
 const row=[];for(let i=1;i<=8;i++)row.push(await op('createItem',{boardId:'cursor',item:{title:`Row ${i}`,content:{kind:'note',text:`Row ${i}.`}},placement:{x:(i-1)*420,y:0,width:360,height:240}}).then(r=>r.placementIds[0]));
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
 // Escape clears the selection; ⌥← then continues from the board's current Tinka.
 await page.keyboard.press('Escape');assert.deepEqual(await selected(),[]);checks++;
 await step('Alt+ArrowLeft');assert.deepEqual(await selected(),[sequence[3]]);checks++;
 // With no current Tinka (a fresh tab), ⌥← starts at the last.
 await page.keyboard.press('Escape');
 await page.evaluate(()=>{for(const k of Object.keys(sessionStorage))if(k.endsWith('/step-cursor'))sessionStorage.removeItem(k);});await open('steps');
 await step('Alt+ArrowLeft');assert.deepEqual(await selected(),[p.last]);checks++;
 // From a selected board-only Tinka (the stepper skips it), next is the one after it.
 await page.keyboard.press('Escape');
 await page.locator(`.workspace-card[data-placement="${p.boardOnly}"] [data-placement-select]`).evaluate(b=>b.click());
 assert.deepEqual(await selected(),[p.boardOnly]);
 await step('Alt+ArrowRight');assert.deepEqual(await selected(),[p.east]);checks++;
 // The same order as the opened Tinka: open the third and read its stepper.
 await page.keyboard.press('Escape');
 await page.locator(`.workspace-card[data-placement="${sequence[0]}"] [data-placement-select]`).evaluate(b=>b.click());
 for(let i=0;i<2;i++)await step('Alt+ArrowRight');
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
 // The board remembers the current Tinka: open 4, step inside to 6, go back; ⌥→ is 7, ⌥← is 5.
 await open('cursor');
 const pick=async n=>{await page.locator(`.workspace-card[data-placement="${row[n-1]}"] [data-placement-select]`).evaluate(b=>b.click());await page.waitForTimeout(60);};
 const openAndStep=async()=>{await page.locator(`.workspace-card[data-placement="${row[3]}"] [data-open]`).first().evaluate(b=>b.click());await page.locator('#reader-dialog[open]').waitFor();
  await page.waitForFunction(()=>document.getElementById('reader-count').textContent.trim()==='4 / 8');
  await page.keyboard.press('Alt+ArrowRight');await page.keyboard.press('Alt+ArrowRight');
  await page.waitForFunction(()=>document.getElementById('reader-count').textContent.trim()==='6 / 8');
  await page.keyboard.press('Escape');await page.locator('#reader-dialog').waitFor({state:'hidden'});await page.waitForTimeout(300);};
 await openAndStep();
 assert.deepEqual(await selected(),[],'Back on the board nothing stays selected (unchanged)');checks++;
 await step('Alt+ArrowRight');assert.deepEqual(await selected(),[row[6]],'⌥→ continues after the Tinka last viewed (7)');checks++;
 await openAndStep();
 await step('Alt+ArrowLeft');assert.deepEqual(await selected(),[row[4]],'⌥← goes to the one before it (5)');checks++;
 // A plain click on empty canvas clears the selection but not the cursor; a reload keeps it too.
 await page.keyboard.press('Escape');
 const vpBox=await page.locator('#viewport').boundingBox();await page.mouse.click(vpBox.x+vpBox.width/2,vpBox.y+vpBox.height-120);await page.waitForTimeout(60);
 assert.deepEqual(await selected(),[]);
 await step('Alt+ArrowRight');assert.deepEqual(await selected(),[row[5]],'After clicking empty canvas, ⌥→ continues from the cursor (5 → 6)');checks++;
 await page.keyboard.press('Escape');await open('cursor');
 await step('Alt+ArrowRight');assert.deepEqual(await selected(),[row[6]],'The cursor survives a reload in this tab (6 → 7)');checks++;
 // An explicit selection wins over the cursor.
 await page.keyboard.press('Escape');await pick(2);
 await step('Alt+ArrowRight');assert.deepEqual(await selected(),[row[2]],'An explicit selection wins (2 → 3)');checks++;

 // Hold F while drawing a selection box: releasing zooms to the box (Fit selection's margin), once.
 await open('steps');
 const viewNow=()=>page.evaluate(()=>{const m=new DOMMatrix(getComputedStyle(document.getElementById('plane')).transform);return {zoom:new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a,x:m.e,y:m.f};});
 await page.keyboard.press('Shift+1');await page.waitForTimeout(80);
 const vp=await page.locator('#viewport').boundingBox();
 const start={x:vp.x+vp.width*.3,y:vp.y+vp.height*.3},end={x:vp.x+vp.width*.55,y:vp.y+vp.height*.6};
 // The drawn box in board units, read from the same transform the page uses.
 const boxBoard=await page.evaluate(([a,b])=>{const w=document.getElementById('world').getBoundingClientRect(),z=new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a;
  return {cx:((a.x+b.x)/2-w.left)/z,cy:((a.y+b.y)/2-w.top)/z,w:Math.abs(b.x-a.x)/z,h:Math.abs(b.y-a.y)/z};},[start,end]);
 const beforeArea=await viewNow();
 await page.mouse.move(start.x,start.y);await page.keyboard.down('f');await page.mouse.down();
 await page.mouse.move((start.x+end.x)/2,(start.y+end.y)/2,{steps:4});
 await page.keyboard.down('f');await page.keyboard.down('f');// key repeat while held
 const during=await viewNow();
 ok(during.zoom===beforeArea.zoom&&during.x===beforeArea.x&&during.y===beforeArea.y,'No fit happens while the box is being drawn, F held and repeating');
 ok(await page.evaluate(()=>document.body.classList.contains('workspace-fit-held')&&/Zoom here/.test(document.getElementById('workspace-marquee-count')?.textContent||'')),'The box says it will zoom');
 await page.mouse.move(end.x,end.y,{steps:4});await page.mouse.up();await page.waitForTimeout(80);
 const zoomed=await viewNow();
 await page.keyboard.up('f');await page.waitForTimeout(80);
 const afterRelease=await viewNow();
 ok(afterRelease.zoom===zoomed.zoom&&afterRelease.x===zoomed.x,'Letting go of F afterwards does not fit again');
 const centre=await page.evaluate(({cx,cy})=>{const w=document.getElementById('world').getBoundingClientRect(),z=new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a,v=document.getElementById('viewport').getBoundingClientRect(),map=document.getElementById('board-map');
  const right=map&&!map.hidden&&map.offsetWidth&&innerWidth>720?map.offsetWidth+24:0;return {x:w.left+cx*z,y:w.top+cy*z,ax:v.left+(v.width-right)/2,ay:v.top+v.height/2};},boxBoard);
 ok(Math.abs(centre.x-centre.ax)<2&&Math.abs(centre.y-centre.ay)<2,`The drawn box is centred in the canvas: ${JSON.stringify(centre)}`);
 const area=await page.evaluate(()=>{const v=document.getElementById('viewport'),map=document.getElementById('board-map');return {w:v.clientWidth-(map&&!map.hidden&&map.offsetWidth&&innerWidth>720?map.offsetWidth+24:0),h:v.clientHeight};});
 const expected=Math.min((area.w-96)/boxBoard.w,(area.h-96)/boxBoard.h);
 ok(Math.abs(zoomed.zoom-expected)<1e-3,`The zoom fits the box with Fit selection's margin: ${zoomed.zoom} vs ${expected}`);
 ok(zoomed.zoom>beforeArea.zoom,'Zoomed in to the box');
 ok(await page.locator('#view-back').isVisible(),'Back is offered after the zoom');
 await page.locator('#view-back').click();await page.waitForTimeout(80);
 const returned=await viewNow();
 ok(Math.abs(returned.zoom-beforeArea.zoom)<1e-9&&Math.abs(returned.x-beforeArea.x)<1&&Math.abs(returned.y-beforeArea.y)<1,'Back returns to the view before the zoom');
 // A tiny box with F held is a click: no zoom.
 await page.mouse.move(start.x,start.y);await page.keyboard.down('f');await page.mouse.down();await page.mouse.move(start.x+10,start.y+8,{steps:3});await page.mouse.up();await page.keyboard.up('f');await page.waitForTimeout(60);
 const tiny=await viewNow();ok(tiny.zoom===returned.zoom&&tiny.x===returned.x,'A tiny box does not zoom, and F released after it does not fit');
 // A plain F tap still fits (the board, with nothing selected).
 await page.keyboard.press('Escape');await page.locator('#zoom-plus').click();await page.locator('#zoom-plus').click();
 const zoomedIn=await viewNow();await page.keyboard.press('f');await page.waitForTimeout(60);
 ok((await viewNow()).zoom<zoomedIn.zoom,'A plain F tap still fits');

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
