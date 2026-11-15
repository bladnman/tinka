// The Comment tool's thread card (comment-thread.js, comment-refs.js) on a real board page:
// create a thread with an @ chip, reply, chip reveal and open, Looks good / Not yet, resolve
// and reopen, edit and delete your own messages, Escape keeping the draft, board keys staying
// quiet, and a deleted target's chip struck through. Light at 1280 and dark at 375 (sheet).
// The card is driven through its exported API with the page's own board data and client, so it
// does not depend on the board's pin layer. Isolated fixture, headless, port 0.
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listFeedback} from '../lib/feedback.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-comment-thread-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||path.join(fixture,'evidence');await mkdir(evidence,{recursive:true});
const MOD=process.platform==='darwin'?'Meta':'Control';
let server,browser,config,url;const results=[];
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,80));}return last;};
async function check(name,body){try{await body();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:String(e.message).split('\n').slice(0,8).join(' | ')});}}
const thread=async id=>(await listFeedback(config,{threadId:id,includeBodies:true})).threads[0];
// A stand-in board on the real page: its snapshot, the app's client and spies for reveal/open.
const STUB=`async boardId=>{
  const {WorkspaceClient}=await import('/app/workspace.js');
  const config=await (await fetch('/api/config')).json(),snapshot=await (await fetch('/api/boards/'+boardId)).json();
  window.__revealed=[];window.__opened=[];
  window.__board={config,snapshot,client:new WorkspaceClient(config,snapshot.revision),feedback:{actor:{id:'human-robin',label:'Robin',kind:'human'}},
    revealRef:ref=>{window.__revealed.push(ref);return true;},openRef:ref=>{window.__opened.push(ref);},
    async refresh(){this.snapshot=await (await fetch('/api/boards/'+boardId)).json();}};
  window.__ct=await import('/app/comment-thread.js');
}`;
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Comment fixture']);
  config=await loadConfig(configFile);
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  for(const [scheme,width] of [['light',1280],['dark',375]]){
    const board=(await applyOperation(config,{type:'createBoard',title:`Comments ${scheme}`})).result,boardId=board.boardId;
    const placementId=(await applyOperation(config,{type:'createItem',boardId,item:{title:'Pricing hero'},placement:{x:0,y:0,width:240,height:180}})).result.placementIds[0];
    const itemId=(await getBoardSnapshot(config,boardId)).placements.find(p=>p.id===placementId).itemId;
    await applyOperation(config,{type:'createDecoration',boardId,decoration:{id:'note1',type:'region',shape:'rectangle',x:300,y:0,width:160,height:150,color:'#f6e6a4',text:'Annual **pricing** note'}});
    const context=await browser.newContext({viewport:{width,height:width>600?880:780},colorScheme:scheme,reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
    page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${url}/boards/${boardId}/`);await page.waitForSelector('#viewport');await page.waitForTimeout(500);
    await page.evaluate(`(${STUB})(${JSON.stringify(boardId)})`);
    const card=page.locator('.ct-card'),composer=card.locator('.ct-composer').last(),tag=`${scheme} ${width}:`;
    let threadId;
    await check(`${tag} create a thread with an @ chip, for the agent`,async()=>{
      await page.evaluate(([placementId,itemId])=>{window.__created=window.__ct.createThread(window.__board,{kind:'point',placementId,x:120,y:90,relative:{x:.5,y:.5}},{left:420,top:200,right:450,bottom:230,width:30,height:30},{itemId,targetLabel:'Pricing hero'});},[placementId,itemId]);
      await card.waitFor();assert.ok((await card.locator('.ct-on').textContent()).includes('Pricing hero'),'On <target>');
      assert.equal(await card.locator('[data-for-agent]').isChecked(),true,'For the agent on by default');
      await page.keyboard.type('Borrow the tone of @hero');
      const picker=page.locator('.cref-picker');await picker.waitFor();
      assert.deepEqual(await picker.locator('h6').allTextContents(),['Items'],'filtered to items');
      await page.keyboard.press('Enter');assert.equal(await composer.locator('.cref').count(),1,'chip inserted');
      await page.keyboard.type('please');
      // board keys stay quiet while typing (t would add a text block)
      const before=(await getBoardSnapshot(config,boardId)).decorations.length;
      await page.keyboard.press(`${MOD}+Enter`);
      threadId=await page.evaluate(()=>Promise.race([window.__created,new Promise(r=>setTimeout(()=>r(null),6000))]));assert.ok(threadId,`createThread resolves with the thread ID (card says: ${await card.locator('.ct-status').textContent().catch(()=>'?')})`);
      assert.equal((await getBoardSnapshot(config,boardId)).decorations.length,before,'no board shortcut fired');
      const t=await thread(threadId);
      assert.equal(t.body,'Borrow the tone of @Pricing hero please');assert.equal(t.refs[0].kind,'item');assert.equal(t.refs[0].id,itemId);
      assert.equal(t.to?.kind,'agent');assert.equal(t.targetLabel,'Pricing hero');
      await card.locator('.ct-state').waitFor();assert.equal(await card.locator('.ct-state').textContent(),'Open');
      assert.equal(await card.locator('.ct-msg .cref').count(),1,'chip rendered in the posted message');
    });
    await check(`${tag} reply with a drawn-element chip`,async()=>{
      await composer.click();await page.keyboard.type('Also see @annual');
      await page.locator('.cref-picker button').first().waitFor();
      assert.equal(await page.locator('.cref-picker h6').first().textContent(),'Drawn');
      assert.ok((await page.locator('.cref-picker button').first().textContent()).startsWith('Sticky · Annual pricing note'),'readable drawn label');
      await page.keyboard.press('Enter');await page.keyboard.press(`${MOD}+Enter`);
      await until(async()=>await card.locator('.ct-msg').count()===2);
      const t=await thread(threadId);assert.equal(t.replies[0].refs[0].kind,'decoration');assert.equal(t.replies[0].refs[0].boardId,boardId);
    });
    await check(`${tag} chip click reveals; ⌘-click and ↗ open`,async()=>{
      await card.locator('.ct-msg .cref').first().click();
      assert.equal(await page.evaluate(()=>window.__revealed.at(-1)?.kind),'item');
      await card.locator('.ct-msg .cref').first().click({modifiers:[MOD]});
      assert.equal(await page.evaluate(()=>window.__opened.length),1,'⌘-click opens');
      await card.locator('.ct-msg .cref').first().hover();await card.locator('.ct-msg .cref-open').first().click();
      assert.equal(await page.evaluate(()=>window.__opened.length),2,'↗ opens');
      await card.locator('.ct-on-target').click();assert.equal(await page.evaluate(()=>window.__revealed.at(-1)?.kind),'placement','On <target> reveals it');
    });
    await check(`${tag} addressed thread: Not yet, then Looks good · Resolve, then reopen`,async()=>{
      const agent={id:'design-agent',label:'Design agent',kind:'agent'};
      await applyOperation(config,{type:'replyComment',threadId,author:agent,body:'Rewrote the headline in @Pricing hero voice.',refs:[{kind:'item',id:itemId,boardId,label:'Pricing hero'}],changes:[{kind:'item',id:itemId,boardId,label:'Pricing hero'}],status:'addressed'});
      await page.keyboard.press('Escape');await card.waitFor({state:'detached'});
      await page.evaluate(id=>{window.__ct.openThreadCard(window.__board,id,{left:420,top:200,right:450,bottom:230,width:30,height:30});},threadId);
      await card.locator('.ct-state').waitFor();assert.equal(await card.locator('.ct-state').textContent(),'Addressed · check it');
      assert.equal(await card.locator('.ct-agent').count(),1,'agent message looks different');
      assert.equal(await card.locator('.ct-changes .cref').count(),1,'Changed chip');
      assert.equal(await card.locator('.ct-agent [data-act=edit]').count(),0,'no edit on the agent message');
      await page.screenshot({path:path.join(evidence,`thread-${scheme}-${width}.png`)});
      await card.locator('[data-act=not-yet]').click();await until(async()=>(await card.locator('.ct-state').textContent())==='Open');
      assert.equal((await thread(threadId)).status,'open');
      await applyOperation(config,{type:'setCommentStatus',threadId,actor:agent,status:'addressed'});
      await page.keyboard.press('Escape');await page.evaluate(id=>{window.__ct.openThreadCard(window.__board,id,null);},threadId);
      await card.locator('[data-act=looks-good]').click();await until(async()=>(await card.locator('.ct-state').textContent())==='Resolved');
      const t=await thread(threadId);assert.equal(t.status,'resolved');assert.equal(t.statusHistory.at(-1).actor.label,'Robin');
      await card.locator('[data-act=toggle]').click();await until(async()=>(await card.locator('.ct-state').textContent())==='Open');
      assert.equal((await thread(threadId)).status,'open','reopened');
    });
    await check(`${tag} edit and delete your own reply`,async()=>{
      const mine=card.locator('.ct-msg.ct-human').nth(1);
      await mine.hover();await mine.locator('[data-act=edit]').click();
      const edit=card.locator('.ct-edit');await edit.waitFor();
      await page.keyboard.type(' (edited)');await page.keyboard.press(`${MOD}+Enter`);
      await until(async()=>(await card.locator('.ct-edited').count())===1);
      assert.ok((await thread(threadId)).replies[0].body.endsWith('(edited)'));
      await card.locator('.ct-msg.ct-human').nth(1).hover();await card.locator('.ct-msg.ct-human').nth(1).locator('[data-act=delete]').click();
      await card.locator('[data-act=delete-yes]').click();
      await until(async()=>(await thread(threadId)).replies[0].deletedAt);
      // The card re-reads the thread after the write; wait for it to show the result.
      assert.ok(await until(async()=>await card.locator('.ct-msg').count()===2),`deleted reply gone (root and agent remain): ${await card.locator('.ct-msg').count()}`);
    });
    await check(`${tag} Escape closes and keeps the draft`,async()=>{
      await composer.click();await page.keyboard.type('half a thought');await page.keyboard.press('Escape');await card.waitFor({state:'detached'});
      await page.evaluate(id=>{window.__ct.openThreadCard(window.__board,id,null);},threadId);
      await until(async()=>(await composer.textContent())==='half a thought');
    });
    await check(`${tag} the card sits beside its pin or target, never over it`,async()=>{
      await page.keyboard.press('Escape');await card.waitFor({state:'detached'}).catch(()=>{});
      const box=await page.locator(`[data-placement="${placementId}"]`).first().boundingBox();
      // a new comment at a point inside the target: the card clears the pin drawn there
      const at={x:box.x+box.width/2,y:box.y+box.height/2};
      await page.evaluate(([placementId,at])=>{window.__ct.createThread(window.__board,{kind:'point',placementId,x:120,y:90,relative:{x:.5,y:.5}},{left:at.x,top:at.y,right:at.x,bottom:at.y,width:0,height:0},{targetLabel:'Pricing hero'});},[placementId,at]);
      await card.waitFor();await page.waitForFunction(()=>{const c=document.querySelector('.ct-card');return c&&c.style.left!==''||c?.classList.contains('ct-sheet');});
      const pin={left:at.x-8,right:at.x+32,top:at.y-36,bottom:at.y+6},c=await card.boundingBox();
      if(width>760){assert.ok(c.x>=pin.right||c.x+c.width<=pin.left||c.y>=pin.bottom||c.y+c.height<=pin.top,`card ${JSON.stringify(c)} clears the pin ${JSON.stringify(pin)}`);assert.ok(c.x>=pin.right,'prefers the right side');}
      assert.equal(await card.locator('.ct-keys').isVisible(),width>760,'⌘↵ hint only with a keyboard-sized screen');
      await page.keyboard.press('Escape');await card.waitFor({state:'detached'});
      // opened with no rect (a list or a link): placed beside its target, not over it
      await page.evaluate(id=>{window.__ct.openThreadCard(window.__board,id,null);},threadId);
      await card.locator('.ct-state').waitFor();
      // beside the thread's pin (the board's pin layer) or, without one, its target
      if(width>760){const b=await card.boundingBox(),pinEl=page.locator(`.comment-pins [data-comment-pin="${threadId}"]`);
        const t=await pinEl.count()&&await pinEl.isVisible()?await pinEl.boundingBox():await page.locator(`[data-placement="${placementId}"]`).first().boundingBox();
        assert.ok(b.x>=t.x+t.width||b.x+b.width<=t.x||b.y>=t.y+t.height||b.y+b.height<=t.y,`card ${JSON.stringify(b)} clears ${JSON.stringify(t)}`);}
      await page.screenshot({path:path.join(evidence,`placement-${scheme}-${width}.png`)});
    });
    await check(`${tag} a deleted target's chip is struck through`,async()=>{
      await page.keyboard.press('Escape');
      await applyOperation(config,{type:'removeDecoration',boardId,decorationId:'note1'}).catch(()=>applyOperation(config,{type:'updateBoard',boardId,patch:{decorations:[]}}));
      await applyOperation(config,{type:'replyComment',threadId,author:{id:'human-robin',label:'Robin',kind:'human'},body:'Gone: @Sticky · Annual pricing note',refs:[{kind:'decoration',id:'note1',boardId,label:'Sticky · Annual pricing note'}]});
      await page.evaluate(()=>window.__board.refresh());
      await page.evaluate(id=>{window.__ct.openThreadCard(window.__board,id,null);},threadId);
      await card.locator('.cref.missing').first().waitFor();
      if(width<600)assert.ok(await card.evaluate(el=>el.classList.contains('ct-sheet')),'bottom sheet on a phone');
      await page.screenshot({path:path.join(evidence,`thread-missing-${scheme}-${width}.png`)});
    });
    assert.deepEqual(errors,[],`${tag} page errors`);
    await context.close();
  }
}finally{await browser?.close();if(server)await closeAppServer(server);if(!process.env.TINKA_EVIDENCE_DIR)await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const r of results)console.log(`${r.pass?'PASS':'FAIL'}  ${r.name}${r.error?'  -- '+r.error:''}`);
const failed=results.filter(r=>!r.pass).length;console.log(JSON.stringify({passed:results.length-failed,failed,evidence}));
process.exit(failed?1:0);
