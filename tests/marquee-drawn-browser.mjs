// The selection box selects drawn elements (text, stickies, shapes, arrows) together
// with Tinkas, and the mixed group moves (drag and arrow keys, one Undo), duplicates
// and deletes as one. A plain colored region joins only when the box encloses it.
// Isolated fixture, headless, port 0. Each case runs on its own fresh board and page.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-marquee-drawn-'));
let server,browser,config,url;const results=[];
const snap=id=>getBoardSnapshot(config,id);
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}return last;};
const MOD=process.platform==='darwin'?'Meta':'Control';
const DRAWN=['arrow','label','sticky'];
async function seed(boardId){
  const item=(await applyOperation(config,{type:'createItem',boardId,item:{title:'Card'},placement:{x:0,y:0,width:240,height:180}})).result;
  const deco=decoration=>applyOperation(config,{type:'createDecoration',boardId,decoration});
  await deco({id:'sticky',type:'region',shape:'rectangle',x:300,y:0,width:160,height:150,color:'#f6e6a4',text:'Sticky'});
  await deco({id:'label',type:'text',x:0,y:220,width:200,height:50,color:'#7a8a68',text:'Label'});
  await deco({id:'arrow',type:'line',x:260,y:220,width:150,height:60,color:'#6c8060',text:'',endArrow:true,from:{x:260,y:220},to:{x:410,y:280}});
  // A big plain region around everything: a box drawn inside it must not select it.
  await deco({id:'area',type:'region',x:-80,y:-80,width:660,height:440,color:'#e1e8d5',text:'Area'});
  return item.placementIds[0];
}
const rect=(page,selector)=>page.locator(selector).first().evaluate(el=>el.getBoundingClientRect().toJSON());
async function boxSelect(page,from,to){
  await page.mouse.move(from.x,from.y);await page.mouse.down();
  await page.mouse.move((from.x+to.x)/2,(from.y+to.y)/2,{steps:4});await page.mouse.move(to.x,to.y,{steps:4});await page.mouse.up();
  await page.waitForTimeout(200);
}
// A box from inside the area's top-left to past the arrow's end: card, sticky, label and arrow.
async function selectGroup(page,placementId){
  const card=await rect(page,`[data-placement="${placementId}"]`),arrow=await rect(page,'[data-decoration="arrow"]');
  await boxSelect(page,{x:card.left-30,y:card.top+40},{x:arrow.right+10,y:arrow.bottom+10});
}
const selectedDrawn=page=>page.evaluate(()=>[...document.querySelectorAll('[data-decoration].selected')].map(e=>e.dataset.decoration).sort());
const count=page=>page.locator('#workspace-selection strong').textContent();
const where=async(id,placementId)=>{const s=await snap(id);const p=s.placements.find(p=>p.id===placementId&&!p.removedAt);
  return {card:p&&[p.x,p.y],...Object.fromEntries((s.decorations||[]).map(d=>[d.id,[d.x,d.y]]))};};
async function run(name,body){
  const board=(await applyOperation(config,{type:'createBoard',title:name})).result;
  const placementId=await seed(board.boardId);
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`${url}/boards/${board.boardId}/`);await page.waitForSelector(`[data-placement="${placementId}"]`);await page.waitForTimeout(600);
    await body(page,board.boardId,placementId);
    assert.deepEqual(errors,[],'page errors');
    results.push({name,pass:true});
  }catch(e){results.push({name,pass:false,error:String(e.message).split('\n').slice(0,12).join(' | ')});}
  finally{await context.close();}
}
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Marquee drawn fixture']);
  config=await loadConfig(configFile);
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});

  await run('Box selects drawn elements with cards; an unenclosed region stays out',async(page,id,pid)=>{
    await selectGroup(page,pid);
    assert.equal(await page.locator(`[data-placement="${pid}"].selected`).count(),1,'card selected');
    assert.deepEqual(await selectedDrawn(page),DRAWN);
    assert.equal(await count(page),'4 selected');
    await page.keyboard.press('Escape');await page.waitForTimeout(200);
    assert.equal(await page.locator('.workspace-card.selected').count(),0,'Escape clears the cards');
    assert.deepEqual(await selectedDrawn(page),[],'and the drawn elements');
  });

  await run('Dragging a card moves the whole group; one Undo restores it',async(page,id,pid)=>{
    const before=await where(id,pid);
    await selectGroup(page,pid);
    const card=await rect(page,`[data-placement="${pid}"] .workspace-card-body`);
    await page.mouse.move(card.left+card.width/2,card.top+card.height/2);await page.mouse.down();
    await page.mouse.move(card.left+card.width/2+40,card.top+card.height/2+20,{steps:6});await page.mouse.move(card.left+card.width/2+80,card.top+card.height/2+40,{steps:6});await page.mouse.up();
    const after=await until(async()=>{const w=await where(id,pid);return w.card[0]!==before.card[0]&&w;});
    const dx=after.card[0]-before.card[0],dy=after.card[1]-before.card[1];
    assert.ok(dx>0&&dy>0,'card moved');
    for(const d of DRAWN)assert.deepEqual(after[d],[before[d][0]+dx,before[d][1]+dy],`${d} moved with the card`);
    assert.deepEqual(after.area,before.area,'region left alone');
    await page.keyboard.press('Escape');await page.keyboard.press(`${MOD}+z`);
    const undone=await until(async()=>{const w=await where(id,pid);return w.card[0]===before.card[0]&&w;});
    assert.deepEqual(undone,before,'one Undo restores cards and drawn elements');
  });

  await run('Dragging a grouped drawn element moves the group; arrow keys nudge it',async(page,id,pid)=>{
    const before=await where(id,pid);
    await selectGroup(page,pid);
    const sticky=await rect(page,'[data-decoration="sticky"]');
    await page.mouse.move(sticky.left+sticky.width/2,sticky.top+sticky.height-20);await page.mouse.down();
    await page.mouse.move(sticky.left+sticky.width/2+30,sticky.top+sticky.height,{steps:6});await page.mouse.move(sticky.left+sticky.width/2+60,sticky.top+sticky.height+10,{steps:6});await page.mouse.up();
    const after=await until(async()=>{const w=await where(id,pid);return w.sticky[0]!==before.sticky[0]&&w;});
    const dx=after.sticky[0]-before.sticky[0],dy=after.sticky[1]-before.sticky[1];
    assert.deepEqual(after.card,[before.card[0]+dx,before.card[1]+dy],'card moved with the sticky');
    assert.deepEqual(after.label,[before.label[0]+dx,before.label[1]+dy]);
    assert.deepEqual(await selectedDrawn(page),DRAWN,'group still selected after the drag');
    // Board keys wait while the drag's save settles, as they do for a person.
    await until(async()=>await page.locator('#chrome-undo').isEnabled());await page.waitForTimeout(300);
    await page.keyboard.press('Shift+ArrowRight');
    const nudged=await until(async()=>{const w=await where(id,pid);return w.card[0]===after.card[0]+10&&w;});
    for(const d of DRAWN)assert.deepEqual(nudged[d],[after[d][0]+10,after[d][1]],`${d} nudged`);
  });

  await run('⌘D duplicates the group; Delete removes it',async(page,id,pid)=>{
    await selectGroup(page,pid);
    await page.keyboard.press(`${MOD}+d`);
    const copied=await until(async()=>{const s=await snap(id);return s.placements.filter(p=>!p.removedAt).length===2&&(s.decorations||[]).length===7&&s;},8000);
    assert.ok(copied,'one more card and three more drawn elements');
    const original=(await snap(id)).decorations.find(d=>d.id==='sticky'),copy=copied.decorations.find(d=>d.text==='Sticky'&&d.id!=='sticky');
    assert.deepEqual([copy.x,copy.y],[original.x+32,original.y+32]);
    const picked=await until(async()=>{const ids=await selectedDrawn(page);return ids.length===3&&!ids.some(id=>DRAWN.includes(id))&&ids;});
    assert.ok(picked,'the copied drawn elements are selected');
    assert.equal(await count(page),'4 selected','with the copied card');
    await page.keyboard.press('Delete');
    const removed=await until(async()=>{const s=await snap(id);return s.placements.filter(p=>!p.removedAt).length===1&&(s.decorations||[]).length===4&&s;},8000);
    assert.ok(removed,'the copied card and drawn elements are gone');
    assert.deepEqual(removed.decorations.map(d=>d.id).sort(),['area','arrow','label','sticky']);
  });

  await run('Drawn elements alone use the decoration multi-selection; an enclosed region joins',async(page,id,pid)=>{
    const label=await rect(page,'[data-decoration="label"]'),arrow=await rect(page,'[data-decoration="arrow"]');
    await boxSelect(page,{x:label.left-10,y:label.top-5},{x:arrow.right+10,y:arrow.bottom+10});
    assert.deepEqual(await selectedDrawn(page),['arrow','label']);
    assert.equal(await page.locator('.workspace-card.selected').count(),0);
    await page.keyboard.press('Escape');await page.waitForTimeout(200);
    const area=await rect(page,'[data-decoration="area"]');
    await boxSelect(page,{x:area.left-20,y:area.top-20},{x:area.right+20,y:area.bottom+20});
    assert.deepEqual(await selectedDrawn(page),['area',...DRAWN].sort());
    assert.equal(await count(page),'5 selected');
  });
  await run('Drawn-only group: arrow keys nudge it, ⌘D copies it, Delete removes it',async(page,id,pid)=>{
    const before=await where(id,pid);
    const label=await rect(page,'[data-decoration="label"]'),arrow=await rect(page,'[data-decoration="arrow"]');
    await boxSelect(page,{x:label.left-10,y:label.top-5},{x:arrow.right+10,y:arrow.bottom+10});
    assert.deepEqual(await selectedDrawn(page),['arrow','label']);
    await page.keyboard.press('Shift+ArrowDown');
    const nudged=await until(async()=>{const w=await where(id,pid);return w.label[1]===before.label[1]+10&&w;});
    assert.deepEqual(nudged.arrow,[before.arrow[0],before.arrow[1]+10]);
    assert.deepEqual(nudged.card,before.card,'cards stay put');
    await page.keyboard.press(`${MOD}+z`);
    assert.ok(await until(async()=>{const w=await where(id,pid);return w.label[1]===before.label[1]&&w.arrow[1]===before.arrow[1];}),'one Undo restores both');
    // Board commands wait while Undo finishes (its controls settle), as they do for a person.
    await until(async()=>await page.locator('#chrome-redo').isEnabled());await page.waitForTimeout(300);
    await page.keyboard.press(`${MOD}+d`);
    const copies=await until(async()=>{const ids=await selectedDrawn(page);return ids.length===2&&!ids.includes('label')&&ids;});
    assert.ok(copies,`the two copies are selected (selected ${JSON.stringify(await selectedDrawn(page))}, ${(await snap(id)).decorations.length} drawn)`);
    assert.equal((await snap(id)).decorations.length,6);
    await page.keyboard.press('Delete');
    const left=await until(async()=>{const s=await snap(id);return s.decorations.length===4&&s;});
    assert.ok(left,'Delete removes the copies');
    assert.deepEqual(left.decorations.map(d=>d.id).sort(),['area','arrow','label','sticky']);
  });
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const r of results)console.log(`${r.pass?'PASS':'FAIL'}  ${r.name}${r.error?'  -- '+r.error:''}`);
const failed=results.filter(r=>!r.pass).length;console.log(JSON.stringify({passed:results.length-failed,failed}));
process.exit(failed?1:0);
