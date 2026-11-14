// Headless checks that ⌘Z / ⇧⌘Z undo and redo a mouse move of every movable board
// object: a text title, a shape, an arrow and a card, with the focus a person has right
// after the drag, after a ⌥→ step and after clicking a zoom-pill button.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-undo-moves-'));
let server,browser,checks=0;const errors=[];
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Undo studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 await op('createBoard',{id:'u',title:'Undo'});
 const card=(await op('createItem',{boardId:'u',item:{title:'Card'},placement:{x:0,y:260,width:320,height:220}})).placementIds[0];
 const other=(await op('createItem',{boardId:'u',item:{title:'Other'},placement:{x:420,y:260,width:320,height:220}})).placementIds[0];
 const title=(await op('createDecoration',{boardId:'u',decoration:{type:'text',x:0,y:0,width:700,height:56,color:'#536044',text:'Concepts · open one'}})).decorationId;
 const sticky=(await op('createDecoration',{boardId:'u',decoration:{type:'region',shape:'rounded',x:820,y:0,width:200,height:140,color:'#f3d36b',text:'Sticky'}})).decorationId;
 const arrow=(await op('createDecoration',{boardId:'u',decoration:{type:'line',x:820,y:300,width:200,height:120,color:'#6c8060',text:'',endArrow:true,from:{x:820,y:300},to:{x:1020,y:420}}})).decorationId;
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await (await browser.newContext({viewport:{width:1244,height:820},colorScheme:'light',reducedMotion:'reduce'})).newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/boards/u/',{waitUntil:'load'});await page.locator('.workspace-card').first().waitFor();await page.waitForTimeout(300);
 const saved=()=>page.evaluate(async()=>{const b=await (await fetch('/api/boards/u')).json();return {d:Object.fromEntries(b.decorations.map(d=>[d.id,{x:d.x,y:d.y,from:d.from,to:d.to}])),p:Object.fromEntries(b.placements.map(p=>[p.id,{x:p.x,y:p.y}]))};});
 const settle=()=>page.waitForTimeout(500);
 const drag=async(locator,dx=90,dy=70)=>{const box=await locator.boundingBox();const x=box.x+box.width/2,y=box.y+Math.min(18,box.height/2);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx/2,y+dy/2,{steps:5});await page.mouse.move(x+dx,y+dy,{steps:5});await page.mouse.up();await settle();};
 const undoRedo=async(name,read)=>{
  const start=read(await saved());
  return {after:async()=>{
   const moved=read(await saved());assert.notDeepEqual(moved,start,`${name}: the drag moved it`);checks++;
   await page.keyboard.press('Meta+z');await settle();
   assert.deepEqual(read(await saved()),start,`${name}: ⌘Z undoes the move`);checks++;
   await page.keyboard.press('Meta+Shift+z');await settle();
   assert.deepEqual(read(await saved()),moved,`${name}: ⇧⌘Z redoes it`);checks++;
   await page.keyboard.press('Meta+z');await settle();
   assert.deepEqual(read(await saved()),start,`${name}: and ⌘Z undoes it again`);checks++;
  }};
 };
 const deco=id=>page.locator(`[data-decoration="${id}"]`);
 // The title Matt dragged: a text decoration.
 let u=await undoRedo('Text title',s=>s.d[title]);await drag(deco(title));await u.after();
 u=await undoRedo('Shape',s=>s.d[sticky]);await drag(deco(sticky));await u.after();
 u=await undoRedo('Arrow',s=>s.d[arrow]);await page.keyboard.press('Escape');
 {const box=await deco(arrow).boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.waitForTimeout(200);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+80,{steps:8});await page.mouse.up();await settle();}
 await u.after();
 await page.keyboard.press('Escape');
 // A card, after a ⌥→ step selected it.
 await page.keyboard.press('Alt+ArrowRight');await page.waitForTimeout(150);
 const cardEl=page.locator(`.workspace-card[data-placement="${card}"]`);
 u=await undoRedo('Card after ⌥→',s=>s.p[card]);await drag(cardEl.locator('.workspace-item-footer').first());await u.after();
 // After clicking a zoom-pill button, ⌘Z still undoes.
 await page.keyboard.press('Escape');
 u=await undoRedo('Card after clicking Fit',s=>s.p[other]);await drag(page.locator(`.workspace-card[data-placement="${other}"] .workspace-item-footer`).first());
 await page.locator('#fit').click();await page.waitForTimeout(150);await u.after();
 // The title again, after a click on the + zoom button.
 u=await undoRedo('Text title after clicking +',s=>s.d[title]);await drag(deco(title),-60,40);
 await page.locator('#zoom-plus').click();await page.waitForTimeout(150);await u.after();
 assert.deepEqual(errors,[]);checks++;
 console.log(`Undo moves browser checks passed: ${checks} assertions.`);
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
