// The board's Comment tool: C drops a pin on a card, pins follow their target and turn
// dashed (keeping the target's name) when it is deleted, Send to agent marks open threads
// sent and copies a prompt, and "Waiting on you" lists addressed and question threads
// and pans to them. Isolated fixture, headless, port 0; a fresh board per case.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listFeedback} from '../lib/feedback.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-comment-pins-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||null;
let server,browser,config,url;const results=[];
const until=async(fn,ms=6000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}return last;};
const ROBIN={id:'human-robin',label:'Robin',kind:'human'},AGENT={id:'design-agent',label:'Design agent',kind:'agent'};
const threads=async boardId=>(await listFeedback(config,{boardId,includeBodies:true,limit:100})).threads;
async function run(name,body,{width=1280,height=900,scheme='light'}={}){
  const board=(await applyOperation(config,{type:'createBoard',title:name})).result,id=board.boardId;
  const card=(await applyOperation(config,{type:'createItem',boardId:id,item:{title:'Pricing hero'},placement:{x:0,y:0,width:240,height:180}})).result.placementIds[0];
  await applyOperation(config,{type:'createDecoration',boardId:id,decoration:{id:'note',type:'region',shape:'rectangle',x:320,y:0,width:180,height:160,color:'#f6e6a4',text:'Plan'}});
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme}),page=await context.newPage(),errors=[];
  await page.addInitScript(()=>{window.__clips=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{window.__clips.push(t);}},configurable:true});});
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await body(page,id,card,async()=>{await page.goto(`${url}/boards/${id}/`);await page.waitForSelector('[data-decoration="note"]');await page.waitForSelector('.comment-pins',{state:'attached'});await page.waitForTimeout(500);});
    assert.deepEqual(errors,[],'page errors');
    results.push({name,pass:true});
  }catch(e){results.push({name,pass:false,error:String(e.message).split('\n').slice(0,6).join(' | ')});}
  finally{await context.close();}
}
const comment=async(boardId,anchor,body,extra={})=>(await applyOperation(config,{type:'addComment',boardId,anchor,author:ROBIN,body,...extra})).result.threadId;
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Comment fixture']);
  config=await loadConfig(configFile);
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});

  await run('C drops a pin on a card, and the pin follows the card',async(page,id,card,open)=>{
    await open();
    assert.equal(await page.locator('.feedback-pins .feedback-pin').count(),0,'the old numbered pins are off');
    await page.keyboard.press('c');
    const tile=await page.locator(`[data-placement="${card}"]`).boundingBox();
    await page.mouse.move(tile.x+120,tile.y+100);
    assert.match(await page.locator('.comment-target-tag').textContent(),/On Pricing hero/);
    await page.mouse.click(tile.x+120,tile.y+100);
    const composer=page.locator('.ct-card .ct-composer').first();await composer.waitFor();
    assert.ok(!(await page.locator('#workspace-toast').isVisible())||!/Click the board/.test(await page.locator('#workspace-toast').textContent()),'the arming hint is gone once the composer opens');
    assert.ok(await until(async()=>/Live · 1 item$/.test(await page.locator('#live-status').textContent())),`one item, singular (${await page.locator('#live-status').textContent()})`);
    await composer.click();await page.keyboard.type('Headline feels generic');
    await page.locator('.ct-card [data-act="post"]').click();
    const made=await until(async()=>(await threads(id)).find(t=>t.body==='Headline feels generic'));
    assert.ok(made,'thread posted');assert.equal(made.anchor.placementId,card);
    await page.keyboard.press('Escape');
    const pin=page.locator(`[data-comment-pin="${made.id}"]`);await pin.waitFor();
    const before=await pin.boundingBox();
    // Nudge the card 10 units right: the pin follows.
    await page.locator(`[data-placement="${card}"] [data-placement-select]`).click({force:true});
    await page.keyboard.press('Shift+ArrowRight');
    assert.ok(await until(async()=>{const b=await pin.boundingBox();return b&&b.x>before.x+5;}),'pin followed the card');
  });

  await run('A deleted target leaves a dashed pin naming it',async(page,id,card,open)=>{
    const t=await comment(id,{kind:'point',x:400,y:60,decorationId:'note',relative:{x:.44,y:.375}},'Is this still the plan?',{targetLabel:'Sticky · Plan'});
    await open();
    const pin=page.locator(`[data-comment-pin="${t}"]`);await pin.waitFor();
    assert.equal(await pin.evaluate(e=>e.classList.contains('detached')),false);
    await applyOperation(config,{type:'removeDecoration',boardId:id,decorationId:'note'});
    await page.reload();await page.waitForSelector('.comment-pins',{state:'attached'});
    await until(async()=>await page.locator(`[data-comment-pin="${t}"].detached`).count());
    assert.match(await page.locator(`[data-comment-pin="${t}"]`).textContent(),/Was on Sticky · Plan · deleted/);
    if(evidence)await page.screenshot({path:path.join(evidence,'comment-detached.png')});
  });

  await run('Send to agent marks open threads sent and copies a prompt',async(page,id,card,open)=>{
    const a=await comment(id,{kind:'point',x:60,y:60,placementId:card,relative:{x:.25,y:.33}},'Borrow the tone of B');
    const b=await comment(id,{kind:'point',x:20,y:300},'Add an FAQ link');
    const human=await comment(id,{kind:'point',x:200,y:300},'Sam, thoughts?',{to:{kind:'human',id:'human-sam'}});
    await open();
    const send=page.locator('#comment-send');
    assert.equal(await send.locator('.comment-count').textContent(),'2','two open threads can go to the agent');
    if(evidence)await page.screenshot({path:path.join(evidence,'comment-send-before.png')});
    await send.click();
    assert.ok(await until(async()=>{const ts=await threads(id);return ['sent','sent'].every((s,i)=>ts.find(t=>t.id===[a,b][i]).status===s);}),'both marked sent');
    const list=await threads(id);
    assert.equal(list.find(t=>t.id===a).to.kind,'agent');assert.equal(list.find(t=>t.id===human).status,'open','the person-to-person thread stays');
    const clip=(await page.evaluate(()=>window.__clips))[0];
    assert.match(clip,/node tinka\/app\/cli\.mjs inbox --config tinka\/local\/config\.json/);
    assert.match(clip,/mark (each|it) addressed/);assert.match(clip,/Never resolve/);
    assert.ok(clip.includes(`#comments/${a}`)&&clip.includes(`#comments/${b}`),'thread links');
    assert.match(await page.locator('#workspace-toast').textContent(),/Copied: paste into your agent/);
    assert.ok(await until(async()=>await send.getAttribute('aria-disabled')==='true'),'nothing left to send');
    assert.equal(await page.locator(`[data-comment-pin="${a}"]`).getAttribute('data-status'),'sent');
  });

  await run('Waiting on you lists addressed and question threads and pans to them',async(page,id,card,open)=>{
    const a=await comment(id,{kind:'point',x:60,y:60,placementId:card,relative:{x:.25,y:.33}},'Borrow the tone of B',{to:{kind:'agent'}});
    const far=(await applyOperation(config,{type:'createItem',boardId:id,item:{title:'Far card'},placement:{x:2600,y:1800,width:240,height:180}})).result.placementIds[0];
    const q=await comment(id,{kind:'point',x:2660,y:1860,placementId:far,relative:{x:.25,y:.33}},'Show annual pricing?',{to:{kind:'agent'}});
    await applyOperation(config,{type:'setCommentStatus',threadId:a,actor:AGENT,status:'addressed'});
    await applyOperation(config,{type:'replyComment',threadId:q,author:AGENT,body:'Monthly or yearly by default?',status:'question'});
    await open();
    // Start zoomed in on the first card, so the far pin is out of view.
    await page.keyboard.press('Shift+0');await page.waitForTimeout(200);
    const toggle=page.locator('#comment-layer-toggle');
    assert.equal(await toggle.locator('.comment-count').textContent(),'2');
    assert.ok(await toggle.locator('.comment-count.warn').count(),'amber count when something waits on you');
    assert.equal(await page.locator(`[data-comment-pin="${a}"]`).getAttribute('data-status'),'addressed');
    const [body,warn]=await page.locator(`[data-comment-pin="${a}"]`).evaluate(el=>{const probe=document.createElement('i');probe.style.color='var(--warn)';document.body.append(probe);const w=getComputedStyle(probe).color;probe.remove();return [getComputedStyle(el).backgroundColor,w];});
    assert.equal(body,warn,'an addressed pin is amber');
    const inView=async()=>{const pin=await page.locator(`[data-comment-pin="${q}"]`).boundingBox(),view=await page.locator('#viewport').boundingBox();return !!pin&&pin.x>view.x&&pin.x<view.x+view.width&&pin.y>view.y&&pin.y<view.y+view.height;};
    assert.equal(await inView(),false,'the far pin starts out of view');
    await toggle.click();
    const items=page.locator('.comment-menu [data-comment-waiting]');
    assert.equal(await items.count(),2);
    if(evidence)await page.screenshot({path:path.join(evidence,'comment-waiting.png')});
    await page.locator(`.comment-menu [data-comment-waiting="${q}"]`).click();
    await page.locator('.ct-card').waitFor();
    const pin=await page.locator(`[data-comment-pin="${q}"]`).boundingBox(),view=await page.locator('#viewport').boundingBox();
    assert.ok(pin&&pin.x>view.x&&pin.x<view.x+view.width&&pin.y>view.y&&pin.y<view.y+view.height,`the far pin is now in view (${JSON.stringify(pin)} in ${JSON.stringify(view)})`);
    // Show/hide: ⇧C hides the layer.
    await page.keyboard.press('Escape');await page.mouse.click(view.x+20,view.y+view.height-80);
    await page.keyboard.press('Shift+C');
    assert.ok(await until(async()=>!(await page.locator('.comment-pins').isVisible())),'⇧C hides the pins');
  });

  await run('A #comments/ID link opens that thread, on load and on hash change',async(page,id,card)=>{
    const a=await comment(id,{kind:'point',x:60,y:60,placementId:card,relative:{x:.25,y:.33}},'First thread');
    const b=await comment(id,{kind:'point',x:380,y:40,decorationId:'note',relative:{x:.33,y:.25}},'Second thread',{targetLabel:'Sticky · Plan'});
    const opened=()=>page.evaluate(()=>import('/app/comment-thread.js').then(m=>m.openThreadId()));
    await page.goto(`${url}/boards/${id}/#comments/${a}`);await page.waitForSelector('.comment-pins',{state:'attached'});
    assert.equal(await until(opened),a,'the linked thread opens on load');
    assert.equal(new URL(page.url()).hash,`#comments/${a}`,'the router keeps the link');
    await page.evaluate(id=>{location.hash=`#comments/${id}`;},b);
    assert.equal(await until(async()=>(await opened())===b&&b),b,'a hash change opens the next thread');
  });

  await run('A pin on an arrow rides along it as the arrow and its route change',async(page,id,card,open)=>{
    await applyOperation(config,{type:'createDecoration',boardId:id,decoration:{id:'arrow',type:'line',x:0,y:300,width:400,height:100,color:'#6c8060',text:'',endArrow:true,from:{x:0,y:300},to:{x:400,y:400}}});
    await open();
    await page.keyboard.press('c');
    const world=await page.locator('#world').boundingBox(),origin=await page.evaluate(()=>{const w=document.getElementById('world');return {x:parseFloat(getComputedStyle(w).getPropertyValue('--x'))||0};});
    // Click the arrow at its middle (board 200,350), found through its drawn path.
    const mid=await page.locator('[data-decoration="arrow"]').evaluate(box=>{const path=[...box.querySelectorAll('path')].sort((a,b)=>b.getTotalLength()-a.getTotalLength())[0],p=path.getPointAtLength(path.getTotalLength()/2),m=path.getScreenCTM();return {x:p.x*m.a+m.c*p.y+m.e,y:p.x*m.b+p.y*m.d+m.f};});
    await page.mouse.move(mid.x,mid.y);assert.match(await page.locator('.comment-target-tag').textContent(),/On Arrow/);
    await page.mouse.click(mid.x,mid.y);
    const composer=page.locator('.ct-card .ct-composer').first();await composer.waitFor();await composer.click();await page.keyboard.type('Label this arrow');
    await page.locator('.ct-card [data-act="post"]').click();
    const made=await until(async()=>(await threads(id)).find(t=>t.body==='Label this arrow'));
    assert.equal(made.anchor.kind,'decoration');assert.equal(made.anchor.decorationId,'arrow');assert.ok(Math.abs(made.anchor.along-.5)<.05,`along ${made.anchor.along}`);
    await page.keyboard.press('Escape');
    // Both in screen pixels: the pin's tip (its left/top in the world) and the path's midpoint.
    const pinAt=async()=>page.locator(`[data-comment-pin="${made.id}"]`).evaluate(el=>{const w=document.getElementById('world'),r=w.getBoundingClientRect(),z=r.width/w.offsetWidth;return {x:r.left+parseFloat(el.style.left)*z,y:r.top+parseFloat(el.style.top)*z};});
    const pathMid=()=>page.locator('[data-decoration="arrow"]').evaluate(box=>{const path=[...box.querySelectorAll('path')].sort((a,b)=>b.getTotalLength()-a.getTotalLength())[0],p=path.getPointAtLength(path.getTotalLength()/2),m=path.getScreenCTM();return {x:p.x*m.a+p.y*m.c+m.e,y:p.x*m.b+p.y*m.d+m.f};});
    for(const patch of [{from:{x:100,y:500},to:{x:700,y:520},x:100,y:500,width:600,height:20},{route:'elbow',from:{x:100,y:500},to:{x:500,y:800},x:100,y:500,width:400,height:300},{route:'curved'}]){
      await applyOperation(config,{type:'updateDecoration',boardId:id,decorationId:'arrow',patch});
      await page.reload();await page.locator(`[data-comment-pin="${made.id}"]`).waitFor();
      const [pin,expected]=[await pinAt(),await pathMid()];
      assert.ok(Math.hypot(pin.x-expected.x,pin.y-expected.y)<4,`${patch.route||'straight'}: pin ${JSON.stringify(pin)} at the path's middle ${JSON.stringify(expected)}`);
    }
  });

  await run('Crowded pins merge into a count with the most urgent colour, and split when zoomed in',async(page,id,card,open)=>{
    const ids=[];for(const body of ['One','Two','Three'])ids.push(await comment(id,{kind:'point',x:900,y:450+ids.length*3},body,{to:{kind:'agent'}}));
    await applyOperation(config,{type:'setCommentStatus',threadId:ids[1],actor:AGENT,status:'addressed'});
    await applyOperation(config,{type:'setCommentStatus',threadId:ids[2],actor:ROBIN,status:'sent',to:{kind:'agent'}});
    await open();
    const cluster=page.locator('.comment-cluster');await cluster.waitFor();
    assert.equal((await cluster.textContent()).trim(),'3');assert.equal(await cluster.getAttribute('data-status'),'addressed','addressed outranks open and sent');
    if(evidence)await page.screenshot({path:path.join(evidence,'comment-cluster.png')});
    await cluster.click();const picks=page.locator('.comment-cluster-menu [data-comment-pick]');assert.equal(await picks.count(),3);
    const dot=async t=>page.locator(`.comment-cluster-menu [data-comment-pick="${t}"] .comment-dot`).evaluate(el=>getComputedStyle(el).backgroundColor);
    const token=name=>page.evaluate(n=>{const i=document.createElement('i');i.style.color=`var(${n})`;document.body.append(i);const c=getComputedStyle(i).color;i.remove();return c;},name);
    assert.equal(await dot(ids[0]),await token('--accent'),'an open row is not amber');assert.equal(await dot(ids[1]),await token('--warn'),'the addressed row is amber');
    await page.locator(`.comment-cluster-menu [data-comment-pick="${ids[1]}"]`).click();await page.locator('.ct-card').waitFor();
    assert.equal(await page.evaluate(()=>import('/app/comment-thread.js').then(m=>m.openThreadId())),ids[1]);
    await page.keyboard.press('Escape');
    // At 1000% the 3 board units between pins are 30 screen px: they come apart.
    await page.evaluate(()=>{const s=document.getElementById('zoom-slider');s.value=s.max;s.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.ok(await until(async()=>!(await page.locator('.comment-cluster').count())&&(await page.locator('.comment-pins [data-comment-pin]').count())===3),'separate pins when zoomed in');
  });

  await run('A dashed pin dragged onto a card re-pins to it',async(page,id,card,open)=>{
    const t=await comment(id,{kind:'point',x:400,y:60,decorationId:'note',relative:{x:.44,y:.375}},'Where does this go now?',{targetLabel:'Sticky · Plan'});
    await open();
    await applyOperation(config,{type:'removeDecoration',boardId:id,decorationId:'note'});
    await page.reload();await page.waitForSelector('.comment-pins',{state:'attached'});
    const pin=page.locator(`[data-comment-pin="${t}"].detached`);await pin.waitFor();
    const from=await pin.boundingBox(),tile=await page.locator(`[data-placement="${card}"]`).boundingBox();
    await page.mouse.move(from.x+10,from.y+from.height-6);await page.mouse.down();
    await page.mouse.move(tile.x+tile.width/2,tile.y+tile.height/2,{steps:8});
    assert.match(await page.locator('.comment-target-tag').textContent(),/On Pricing hero/,'the target lights up while dragging');
    await page.mouse.up();
    const moved=await until(async()=>(await threads(id)).find(x=>x.id===t&&x.anchor.placementId===card));
    assert.ok(moved,'re-pinned to the card');assert.equal(moved.targetLabel,'Pricing hero');
    assert.ok(await until(async()=>!(await page.locator(`[data-comment-pin="${t}"]`).evaluate(el=>el.classList.contains('detached')))),'no longer dashed');
    assert.equal(await page.locator('.ct-card').count(),0,'dragging does not open the thread');
  });

  await run('Send to agent shows when an agent is watching',async(page,id,card,open)=>{
    await comment(id,{kind:'point',x:20,y:300},'Add an FAQ link');
    await open();
    const send=page.locator('#comment-send');
    assert.equal(await send.evaluate(el=>el.classList.contains('agent-watching')),false,'nobody is watching yet');
    // An agent waiting on the inbox (what inbox --watch does) is reported over the board's stream.
    const since=(await (await fetch(`${url}/api/inbox?actor=design-agent&wait=0`)).json()).nextSince||'';
    const watch=new AbortController(),held=fetch(`${url}/api/inbox?actor=design-agent&since=${encodeURIComponent(since)}&wait=20&label=Design%20agent`,{signal:watch.signal}).catch(()=>{});
    assert.ok(await until(async()=>await send.evaluate(el=>el.classList.contains('agent-watching'))),'watching shows');
    assert.match(await send.getAttribute('title'),/Agent is watching/);
    assert.match(await send.getAttribute('aria-label'),/^Send 1 open comment to your agent · Agent is watching$/,'screen readers hear it too');
    if(evidence)await page.screenshot({path:path.join(evidence,'comment-watching.png')});
    watch.abort();await held;
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tinka:presence',{detail:{watching:[]}})));
    assert.equal(await send.evaluate(el=>el.classList.contains('agent-watching')),false,'and goes when the agent stops');
  });

  for(const scheme of ['light','dark'])await run(`With an agent watching, an empty board still shows Send to agent and its dot (${scheme})`,async(page,id,card,open)=>{
    await open();
    const since=(await (await fetch(`${url}/api/inbox?actor=design-agent&wait=0`)).json()).nextSince||'';
    const watch=new AbortController(),held=fetch(`${url}/api/inbox?actor=design-agent&since=${encodeURIComponent(since)}&wait=20`,{signal:watch.signal}).catch(()=>{});
    const send=page.locator('#comment-send');
    assert.ok(await until(async()=>await send.isVisible()&&await send.evaluate(el=>el.classList.contains('agent-watching'))),'Send to agent shows with its dot');
    assert.equal(await page.locator('#comment-layer-toggle').isVisible(),false,'the comments menu waits for a first comment');
    assert.equal(await send.getAttribute('aria-label'),'Send to agent: nothing open to send · Agent is watching');
    if(evidence)await page.screenshot({path:path.join(evidence,`comment-watching-empty-${scheme}.png`)});
    watch.abort();await held;
  },{scheme});

  for(const [width,height,scheme] of [[375,812,'light'],[375,812,'dark'],[1280,860,'light'],[1280,860,'dark']])
    await run(`A cluster at the canvas edge stays in view and lists beside itself, clear of the bar (${width}, ${scheme})`,async(page,id,card,open)=>{
      await open();
      // Two comments at the bottom-right corner of what is in view (board units: the screen point
      // less the world's position and the board origin, read from the card's own place).
      const point=await page.locator(`[data-placement="${card}"]`).evaluate(el=>{const v=document.getElementById('viewport').getBoundingClientRect(),w=document.getElementById('world'),r=w.getBoundingClientRect(),z=r.width/w.offsetWidth;
        return {x:(v.right-4-r.left)/z-parseFloat(el.style.left),y:(v.bottom-70-r.top)/z-parseFloat(el.style.top)};});
      const edge=[];for(const body of ['Edge one','Edge two'])edge.push(await comment(id,{kind:'point',x:point.x,y:point.y},body,{to:{kind:'agent'}}));
      await applyOperation(config,{type:'setCommentStatus',threadId:edge[1],actor:AGENT,status:'addressed'});
      await page.reload();await page.waitForSelector('.comment-pins',{state:'attached'});
      const cluster=page.locator('.comment-cluster');await cluster.waitFor();await page.waitForTimeout(300);
      const view=await page.locator('#viewport').boundingBox(),box=await cluster.boundingBox();
      assert.ok(box.x>=view.x&&box.x+box.width<=view.x+view.width&&box.y+box.height<=view.y+view.height,`cluster inside the canvas (${JSON.stringify(box)} in ${JSON.stringify(view)})`);
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.locator('.comment-cluster-menu').waitFor();
      const list=await page.locator('.comment-cluster-menu').boundingBox(),bar=await page.locator('.canvas-footer .zoom-pill').boundingBox();
      if(evidence)await page.screenshot({path:path.join(evidence,`comment-cluster-edge-${width}-${scheme}.png`)});
      assert.ok(list.y+list.height<=bar.y,'the list stays clear of the bottom bar');
      const gapX=Math.max(0,list.x-(box.x+box.width),box.x-(list.x+list.width)),gapY=Math.max(0,list.y-(box.y+box.height),box.y-(list.y+list.height));
      assert.ok(gapX<=24&&gapY<=24,`the list opens beside its pin (gap ${gapX},${gapY})`);
    },{width,height,scheme});

  for(const [scheme,width,height] of [['light',1280,860],['dark',1280,860],['light',375,812],['dark',375,812]])
    await run(`Pins and bar render (${scheme}, ${width})`,async(page,id,card,open)=>{
      const a=await comment(id,{kind:'point',x:60,y:60,placementId:card,relative:{x:.25,y:.33}},'Borrow the tone of B',{to:{kind:'agent'}});
      await comment(id,{kind:'point',x:380,y:40,decorationId:'note',relative:{x:.33,y:.25}},'Keep this short',{targetLabel:'Sticky · Plan'});
      await applyOperation(config,{type:'setCommentStatus',threadId:a,actor:AGENT,status:'addressed'});
      for(const body of ['Crowd one','Crowd two'])await comment(id,{kind:'point',x:120,y:260},body);
      await page.route('**/api/agents',route=>route.fulfill({json:{watching:[{actor:{id:'design-agent'},since:new Date().toISOString()}]}}));
      await open();
      assert.equal(await page.locator('.comment-cluster').count(),1,'a crowded pair shows as one count');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no sideways scroll');
      assert.ok(await page.locator('#comment-layer-toggle').isVisible());
      if(evidence)await page.screenshot({path:path.join(evidence,`comment-${scheme}-${width}.png`)});
    },{width,height,scheme});
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const r of results)console.log(`${r.pass?'PASS':'FAIL'}  ${r.name}${r.error?'  -- '+r.error:''}`);
const failed=results.filter(r=>!r.pass).length;console.log(JSON.stringify({passed:results.length-failed,failed}));
process.exit(failed?1:0);
