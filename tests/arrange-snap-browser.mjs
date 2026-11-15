// Smart guides and arrangement: dragging snaps edges/centres to neighbours with guide
// lines (⌘/Ctrl turns it off), and Arrange aligns, distributes and tidies a selection of
// cards and drawn elements in one write that one Undo restores.
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
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-arrange-snap-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||null;
let server,browser,config,url;const results=[];
const snap=id=>getBoardSnapshot(config,id);
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}return last;};
const MOD=process.platform==='darwin'?'Meta':'Control';
// Two cards, two stickies, scattered.
async function seed(boardId){
  const card=async(title,x,y)=>(await applyOperation(config,{type:'createItem',boardId,item:{title},placement:{x,y,width:240,height:180}})).result.placementIds[0];
  const a=await card('A',0,0),b=await card('B',420,330);
  const deco=decoration=>applyOperation(config,{type:'createDecoration',boardId,decoration});
  await deco({id:'s1',type:'region',shape:'rectangle',x:60,y:420,width:160,height:150,color:'#f6e6a4',text:'One'});
  await deco({id:'s2',type:'region',shape:'rectangle',x:760,y:90,width:160,height:150,color:'#f6e6a4',text:'Two'});
  return {a,b};
}
const rect=(page,selector)=>page.locator(selector).first().evaluate(el=>el.getBoundingClientRect().toJSON());
const geo=async id=>{const s=await snap(id);const o={};for(const p of s.placements.filter(p=>!p.removedAt))o[s.items[p.itemId].title]=[p.x,p.y];for(const d of s.decorations||[])o[d.id]=[d.x,d.y];return o;};
// Drags from a point by (dx,dy) screen px; `during` runs before release.
async function drag(page,from,dx,dy,{hold,during}={}){
  await page.mouse.move(from.x,from.y);await page.mouse.down();
  if(hold)await page.keyboard.down(hold);
  await page.mouse.move(from.x+dx/2,from.y+dy/2,{steps:5});await page.mouse.move(from.x+dx,from.y+dy,{steps:5});
  const seen=during?await during():null;
  await page.mouse.up();if(hold)await page.keyboard.up(hold);
  return seen;
}
const guides=page=>page.locator('.snap-guides .snap-guide').count();
async function run(name,body){
  const board=(await applyOperation(config,{type:'createBoard',title:name})).result;
  const ids=await seed(board.boardId);
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`${url}/boards/${board.boardId}/`);await page.waitForSelector(`[data-placement="${ids.b}"]`);await page.waitForTimeout(600);
    await body(page,board.boardId,ids);
    assert.deepEqual(errors,[],'page errors');
    results.push({name,pass:true});
  }catch(e){results.push({name,pass:false,error:String(e.message).split('\n').slice(0,8).join(' | ')});}
  finally{await context.close();}
}
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Arrange fixture']);
  config=await loadConfig(configFile);
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});

  await run('Dragging a card snaps its left edge to a neighbour and shows a guide',async(page,id,ids)=>{
    const a=await rect(page,`[data-placement="${ids.a}"]`),b=await rect(page,`[data-placement="${ids.b}"] .workspace-card-body`),bc=await rect(page,`[data-placement="${ids.b}"]`);
    const seen=await drag(page,{x:b.left+b.width/2,y:b.top+b.height/2},a.left+3-bc.left,0,{during:()=>guides(page)});
    assert.ok(seen>0,'a guide shows while dragging');
    const g=await until(async()=>{const g=await geo(id);return g.B[0]!==420&&g;});
    assert.equal(g.B[0],0,'B snapped to A\'s left edge');
    assert.equal(await guides(page),0,'guides clear on release');
    if(evidence){await page.screenshot({path:path.join(evidence,'arrange-guides-done.png')});}
  });

  await run(`Holding ${MOD} while dragging turns snapping off`,async(page,id,ids)=>{
    const a=await rect(page,`[data-placement="${ids.a}"]`),b=await rect(page,`[data-placement="${ids.b}"] .workspace-card-body`),bc=await rect(page,`[data-placement="${ids.b}"]`);
    const seen=await drag(page,{x:b.left+b.width/2,y:b.top+b.height/2},a.left+3-bc.left,0,{hold:MOD,during:()=>guides(page)});
    assert.equal(seen,0,'no guides');
    const g=await until(async()=>{const g=await geo(id);return g.B[0]!==420&&g;});
    assert.ok(g.B[0]>0&&g.B[0]<12,`B kept its unsnapped position (${g.B[0]})`);
  });

  await run('Dragging a sticky snaps it to a card edge',async(page,id,ids)=>{
    const a=await rect(page,`[data-placement="${ids.a}"]`),s=await rect(page,'[data-decoration="s1"]');
    // s1's left (60) is 60 board units right of A's left; drag it to 3 px right of A's left.
    await drag(page,{x:s.left+s.width/2,y:s.top+s.height-20},a.left+3-s.left,0);
    const g=await until(async()=>{const g=await geo(id);return g.s1[0]!==60&&g;});
    assert.equal(g.s1[0],0,'sticky snapped to the card');
  });

  await run('Arrange aligns a mixed selection left, and one Undo restores it',async(page,id)=>{
    const before=await geo(id);
    await page.mouse.click(1240,450);await page.keyboard.press(`${MOD}+a`);
    await page.locator('#workspace-selection [data-arrange-open]').click();
    if(evidence)await page.screenshot({path:path.join(evidence,'arrange-menu.png')});
    await page.locator('.arrange-menu [data-arrange="align-left"]').click();
    const g=await until(async()=>{const g=await geo(id);return g.B[0]===0&&g;});
    assert.ok(g,'B aligned');
    assert.deepEqual([g.A[0],g.B[0],g.s1[0],g.s2[0]],[0,0,0,0]);
    assert.deepEqual([g.A[1],g.B[1],g.s1[1],g.s2[1]],[before.A[1],before.B[1],before.s1[1],before.s2[1]],'y unchanged');
    await page.keyboard.press('Escape');await page.keyboard.press(`${MOD}+z`);
    assert.deepEqual(await until(async()=>{const g=await geo(id);return g.B[0]===420&&g;}),before,'one Undo restores everything');
  });

  await run('Distribute and tidy',async(page,id)=>{
    await page.mouse.click(1240,450);await page.keyboard.press(`${MOD}+a`);
    await page.locator('#workspace-selection [data-arrange-open]').click();
    await page.locator('.arrange-menu [data-arrange="distribute-h"]').click();
    // Left to right by centre: A (0..240), s1 (60..220), B (420..660), s2 (760..920): span 0..920.
    const d=await until(async()=>{const g=await geo(id);return g.s2[0]===760&&g.B[0]!==420&&g;});
    assert.ok(d,'distributed');
    const gaps=[[d.A[0]+240,d.s1[0]],[d.s1[0]+160,d.B[0]],[d.B[0]+240,d.s2[0]]].map(([a,b])=>b-a);
    assert.ok(Math.max(...gaps)-Math.min(...gaps)<=1,`equal gaps ${gaps}`);
    await page.locator('#workspace-selection [data-arrange-open]').click();
    await page.locator('.arrange-menu [data-arrange="tidy"]').click();
    const t=await until(async()=>{const g=await geo(id);return g.A[1]===g.s2[1]&&g;});
    assert.ok(t,'tidied');
    // Reading order A, s2 (row 1), B, s1: 2 columns, widths 240/240, gap 40, anchored at (0,0).
    assert.deepEqual([t.A,t.s2,t.B,t.s1],[[0,0],[280,0],[0,220],[280,220]]);
    if(evidence)await page.screenshot({path:path.join(evidence,'arrange-tidy.png')});
    await page.keyboard.press('Escape');await page.keyboard.press(`${MOD}+z`);
    assert.ok(await until(async()=>{const g=await geo(id);return g.B[0]===d.B[0]&&g.B[1]===d.B[1];}),'one Undo returns to the distributed layout');
  });

  await run('Drawn-only selection: the object bar offers Arrange',async(page,id)=>{
    const s1=await rect(page,'[data-decoration="s1"]'),s2=await rect(page,'[data-decoration="s2"]');
    await page.mouse.click(s1.left+s1.width/2,s1.top+s1.height-15);await page.keyboard.down('Shift');
    await page.mouse.click(s2.left+s2.width/2,s2.top+s2.height-15);await page.keyboard.up('Shift');
    await page.locator('.whiteboard-toolbar [data-whiteboard-action="arrange"]').click();
    await page.locator('.arrange-menu [data-arrange="align-top"]').click();
    const g=await until(async()=>{const g=await geo(id);return g.s1[1]===90&&g;});
    assert.ok(g,'stickies aligned to the higher top');
    assert.equal(g.s2[1],90);
  });
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const r of results)console.log(`${r.pass?'PASS':'FAIL'}  ${r.name}${r.error?'  -- '+r.error:''}`);
const failed=results.filter(r=>!r.pass).length;console.log(JSON.stringify({passed:results.length-failed,failed}));
process.exit(failed?1:0);
