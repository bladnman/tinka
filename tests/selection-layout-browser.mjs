// Selection actions keep readable labels and clear the canvas dock, zoom and map.
// Uses external fixtures and a headless browser; never touches the OS clipboard.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-selection-layout-fixture-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-selection-layout-evidence-'));
await mkdir(evidence,{recursive:true});
let server,browser;const observations=[];const errors=[];
try {
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Selection studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 await op('createBoard',{id:'materials',title:'Materials'});
 for(let n=0;n<7;n++)await op('createItem',{boardId:'materials',item:{title:['Opening note','Reference image','Layout options','Color study','Draft text','Review notes','Next round'][n],content:{kind:'note',text:'Materials for a shared review.'}},placement:{x:80+(n%3)*380,y:60+Math.floor(n/3)*300,width:320,height:240}});
 for(let n=0;n<6;n++)await op('createBoard',{id:`round-${n}`,title:`Review round ${n+1}`});
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1244,height:850},reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 const inspect=async(selector)=>page.locator(selector).evaluate(bar=>{
  const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const b=box(bar);const children=[...bar.children].filter(el=>el.getClientRects().length).map(el=>({name:el.getAttribute('aria-label')||el.textContent.trim(),...box(el),scroll:el.scrollWidth,client:el.clientWidth}));
  const overlaps=[];for(let a=0;a<children.length;a++)for(let c=a+1;c<children.length;c++){const x=children[a],y=children[c];if(x.x<y.right-.5&&x.right>y.x+.5&&x.y<y.bottom-.5&&x.bottom>y.y+.5)overlaps.push([x.name,y.name]);}
  const collisions=[];for(const sel of ['.canvas-footer .zoom-pill','#edit-tools','#board-map']){const el=document.querySelector(sel);if(!el||el.hidden||!el.getClientRects().length)continue;const r=box(el);if(b.x<r.right&&b.right>r.x&&b.y<r.bottom&&b.bottom>r.y)collisions.push(sel);}
  return {bar:b,children,overlaps,collisions,overflow:children.filter(c=>c.scroll>c.client+2).map(c=>c.name),inViewport:b.x>=0&&b.right<=innerWidth+.5&&b.y>=0&&b.bottom<=innerHeight+.5};
 });
 const menuCheck=async(surface,width)=>{
  const more=page.locator(surface==='home'?'[data-home-action="more"]':'[data-selection-more]');
  const move=page.locator(surface==='home'?'.home-selection-bar [data-home-action="move"]':'#workspace-selection [data-bulk="move"]');
  await move.click();await page.getByRole('dialog',{name:'Move to a board',exact:true}).waitFor();await page.keyboard.press('Escape');
  await more.click();const menu=page.getByRole('menu',{name:'More selection actions',exact:true});await menu.waitFor();
  const popup=await menu.boundingBox();assert(popup.x>=0&&popup.y>=0&&popup.x+popup.width<=width&&popup.y+popup.height<=850,`${surface} More stays in viewport`);
  assert(await menu.getByRole('menuitem').evaluateAll(items=>items.every(item=>item.getBoundingClientRect().height>=44)),'More menu rows have touch-sized targets');
  const revision=(await (await fetch(base+'/api/workspace')).json()).revision;
  await page.keyboard.press('End');assert.match(await page.locator(':focus').textContent(),/Remove from/);
  await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');assert.match(await page.locator(':focus').textContent(),surface==='home'?/Archive everywhere/:/Show on parent/);
  for(const key of ['Delete','Backspace','ControlOrMeta+d','ControlOrMeta+z'])await page.keyboard.press(key);
  assert.equal((await (await fetch(base+'/api/workspace')).json()).revision,revision,'Menu keys cannot mutate the board');
  await page.screenshot({path:path.join(evidence,`after-${surface}-more-${width}.png`)});
  await page.keyboard.press('Escape');assert.equal(await more.evaluate(el=>document.activeElement===el),true,'More Escape restores trigger');
  await more.click();await page.getByRole('menuitem',{name:'Add reference…',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Add a reference',exact:true}).waitFor();await page.keyboard.press('Escape');
  await more.click();await page.locator('header').first().click({position:{x:1,y:1}});assert(await menu.isHidden(),'Click-away dismisses More');
 };
 for(const width of [1244,768,390,320]){
  await page.setViewportSize({width,height:850});await page.goto(base+'/boards/materials/');await page.locator('.workspace-card').first().waitFor();
  if(await page.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.keyboard.press('Escape');}
  await page.locator('#viewport').focus();await page.keyboard.press('ControlOrMeta+a');
  if(await page.locator('#edit-tools').isHidden())await page.keyboard.press('a');
  await page.waitForTimeout(250);const result=await inspect('#workspace-selection');observations.push({surface:'board',width,...result});
  await page.screenshot({path:path.join(evidence,`after-board-${width}.png`)});
  assert.deepEqual(await page.locator('#workspace-selection button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')||button.textContent.trim())),['Arrange','Move…','More selection actions','Clear selection']);
  if(width===1244||width===390)await menuCheck('board',width);
  {assert.deepEqual(result.overlaps,[],`Controls overlap at ${width}`);assert.deepEqual(result.overflow,[],`Text overflows at ${width}`);assert.deepEqual(result.collisions,[],`Chrome overlaps at ${width}`);assert(result.inViewport,`Bar outside viewport at ${width}`);}
  await page.locator('[data-arrange-open]').click();await page.getByRole('dialog',{name:'Arrange',exact:true}).waitFor();await page.keyboard.press('ArrowRight');{const popup=await page.getByRole('dialog',{name:'Arrange',exact:true}).boundingBox();assert(popup.x>=0&&popup.y>=0&&popup.x+popup.width<=width&&popup.y+popup.height<=850,'Arrange stays inside viewport');}await page.screenshot({path:path.join(evidence,`after-arrange-${width}.png`)});await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-arrange-open]').evaluate(el=>document.activeElement===el),true,'Escape restores Arrange focus');
  if(width===1244){const original=await getBoardSnapshot(config,'materials');await page.locator('[data-arrange-open]').click();await page.getByRole('button',{name:'Align left',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#workspace-selection strong').textContent==='7 selected');for(let i=0;i<40;i++){const saved=await getBoardSnapshot(config,'materials');if(new Set(saved.placements.map(p=>p.x)).size===1)break;await page.waitForTimeout(50);}assert.equal(new Set((await getBoardSnapshot(config,'materials')).placements.map(p=>p.x)).size,1,'Arrange commits');await page.locator('#viewport').focus();await page.keyboard.press('ControlOrMeta+z');for(let i=0;i<40;i++){const saved=await getBoardSnapshot(config,'materials');if(JSON.stringify(saved.placements)===JSON.stringify(original.placements))break;await page.waitForTimeout(50);}assert.deepEqual((await getBoardSnapshot(config,'materials')).placements,original.placements,'Undo restores arrangement');}
  if(width>720){if(await page.locator('#board-map-toggle').getAttribute('aria-pressed')!=='true')await page.locator('#board-map-toggle').click();await page.locator('#board-map').waitFor({state:'visible'});await page.waitForTimeout(150);const withMap=await inspect('#workspace-selection');assert.deepEqual(withMap.collisions,[],`Map collides at ${width}`);assert(withMap.inViewport);await page.screenshot({path:path.join(evidence,`after-map-${width}.png`)});}
 }
 for(const width of [1244,390,320]){
  await page.setViewportSize({width,height:850});await page.goto(base+'/');
  await page.locator('.home-select-dot').first().waitFor();
  for(let i=0;i<7;i++)await page.locator('.home-select-dot').nth(i).click();
  await page.waitForTimeout(100);
  const home=await inspect('.home-selection-bar');observations.push({surface:'home',width,...home});
  assert.deepEqual(home.overlaps,[]);assert.deepEqual(home.overflow,[]);assert(home.inViewport);
  await page.screenshot({path:path.join(evidence,`after-home-${width}.png`)});
  assert.deepEqual(await page.locator('.home-selection-bar button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')||button.textContent.trim())),['Arrange','Move…','More selection actions','Clear selection']);
  if(width===1244||width===390)await menuCheck('home',width);
  const trigger=page.locator('[data-home-action="arrange"]');await trigger.click();
  const menu=page.getByRole('dialog',{name:'Arrange',exact:true});await menu.waitFor();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('button',{name:'Align centres',exact:true}).evaluate(el=>document.activeElement===el),true,'Home Arrange arrow keys move focus');
  const popup=await menu.boundingBox();assert(popup.x>=0&&popup.y>=0&&popup.x+popup.width<=width&&popup.y+popup.height<=850,'Home Arrange stays inside viewport');
  await page.screenshot({path:path.join(evidence,`after-home-arrange-${width}.png`)});
  await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(el=>document.activeElement===el),true,'Home Escape restores Arrange focus');
 }
 // Single cards keep Move and expose Details in More; drawings retain their own bar.
 await op('createBoard',{id:'mixed',title:'Mixed selection'});
 await op('createItem',{boardId:'mixed',item:{title:'One card'},placement:{x:60,y:60,width:240,height:180}});
 await op('createDecoration',{boardId:'mixed',decoration:{id:'caption',type:'text',x:420,y:60,width:180,height:80,text:'Drawing text',color:'palette:neutral'}});
 await page.setViewportSize({width:1244,height:850});await page.goto(base+'/boards/mixed/');await page.locator('.workspace-card').waitFor();await page.locator('#fit').click();
 await page.locator('[data-placement-select]').evaluate(element=>element.click());
 assert.equal(await page.locator('[data-arrange-open]').count(),0,'Single card has no Arrange');
 await page.locator('[data-selection-more]').click();assert.equal(await page.getByRole('menuitem',{name:'Details…',exact:true}).count(),1);await page.keyboard.press('Escape');
 await page.locator('[data-decoration="caption"]').click({modifiers:['Shift']});
 assert.equal(await page.locator('#workspace-selection strong').textContent(),'2 selected');
 assert.equal(await page.locator('#workspace-selection [data-bulk="move"]').textContent(),'Move 1 card…');
 await page.locator('[data-selection-more]').click();assert.equal(await page.getByRole('menuitem',{name:'Add reference to 1 card…',exact:true}).count(),1);await page.keyboard.press('Escape');
 assert.equal(await page.locator('#workspace-selection strong').textContent(),'2 selected','Closing mixed More preserves selection');
 await page.locator('[data-bulk="clear"]').click();await page.locator('[data-decoration="caption"]').click();
 assert(await page.locator('#workspace-selection').isHidden(),'Drawing-only selection keeps its own bar');assert(await page.locator('.whiteboard-toolbar').isVisible());
 assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,'observations.json'),JSON.stringify({observations,errors},null,2));console.log(JSON.stringify({evidence,observations:observations.map(({children,...r})=>r),errors}));
} finally {await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
