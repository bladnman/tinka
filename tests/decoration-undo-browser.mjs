// Drawn-element changes are each one Undo step and redo: adding, restyling (one or
// several), editing text, deleting, and a mixed Delete or ⌘D that covers cards and
// drawn elements together. Isolated fixture, headless, port 0; a fresh board per case.
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
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-decoration-undo-'));
let server,browser,config,url;const results=[];
const snap=id=>getBoardSnapshot(config,id);
const until=async(fn,ms=6000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}return last;};
const MOD=process.platform==='darwin'?'Meta':'Control';
const decos=async id=>((await snap(id)).decorations||[]);
const deco=async(id,did)=>(await decos(id)).find(d=>d.id===did);
const live=async id=>(await snap(id)).placements.filter(p=>!p.removedAt).length;
// Undo/redo once the board's history controls have settled.
async function history(page,direction){
  await until(async()=>await page.locator(direction==='undo'?'#chrome-undo':'#chrome-redo').isEnabled());
  await page.keyboard.press(direction==='undo'?`${MOD}+z`:`Shift+${MOD}+z`);
  // Board commands wait while a history step settles, as they do for a person.
  await until(async()=>await page.locator(direction==='undo'?'#chrome-redo':'#chrome-undo').isEnabled());await page.waitForTimeout(300);
}
async function run(name,body){
  const board=(await applyOperation(config,{type:'createBoard',title:name})).result,id=board.boardId;
  const card=(await applyOperation(config,{type:'createItem',boardId:id,item:{title:'Card'},placement:{x:0,y:0,width:240,height:180}})).result.placementIds[0];
  for(const [did,x] of [['s1',320],['s2',560]])await applyOperation(config,{type:'createDecoration',boardId:id,decoration:{id:did,type:'region',shape:'rectangle',x,y:0,width:180,height:160,color:'#f6e6a4',text:did}});
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`${url}/boards/${id}/`);await page.waitForSelector('[data-decoration="s2"]');await page.waitForTimeout(600);
    await body(page,id,card);
    assert.deepEqual(errors,[],'page errors');
    results.push({name,pass:true});
  }catch(e){results.push({name,pass:false,error:String(e.message).split('\n').slice(0,6).join(' | ')});}
  finally{await context.close();}
}
const select=async(page,did)=>{const r=await page.locator(`[data-decoration="${did}"]`).boundingBox();await page.mouse.click(r.x+r.width/2,r.y+r.height-20);await page.waitForTimeout(150);};
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Decoration undo fixture']);
  config=await loadConfig(configFile);
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});

  await run('Adding a sticky and editing its text are each one step',async(page,id)=>{
    await page.mouse.move(700,600);await page.keyboard.press('s');
    const made=await until(async()=>(await decos(id)).length===3&&(await decos(id))[2]);
    await page.locator('.whiteboard-editor textarea').waitFor();await page.waitForTimeout(200);
    await page.keyboard.type('Plan');await page.keyboard.press('Escape');
    assert.ok(await until(async()=>(await deco(id,made.id))?.text==='Plan'),'text saved');
    await page.mouse.click(1100,820);
    await history(page,'undo');
    assert.ok(await until(async()=>(await deco(id,made.id))?.text==='A thought to keep'),'first Undo restores the text');
    await history(page,'undo');
    assert.ok(await until(async()=>!(await deco(id,made.id))),'second Undo removes the sticky');
    await history(page,'redo');
    assert.ok(await until(async()=>!!(await deco(id,made.id))),'Redo brings it back');
  });

  // Keys pressed while an undo is still in flight wait and then apply, in order.
  await run('S and ⇧⌘Z pressed 30 ms after ⌘Z are not dropped',async(page,id)=>{
    for(const second of ['s',`Shift+${MOD}+z`]){
      await page.mouse.move(700,600);await page.keyboard.press('s');await page.locator('.whiteboard-editor textarea').waitFor();
      await page.keyboard.press('Escape');await page.mouse.click(1100,820);
      // Undo removes the new sticky; S adds another, or redo brings it back: the count returns.
      const before=(await decos(id)).length,expect=before;
      await until(async()=>await page.locator('#chrome-undo').isEnabled());await page.waitForTimeout(300);
      await page.keyboard.press(`${MOD}+z`);await page.waitForTimeout(30);
      await page.mouse.move(400,650);await page.keyboard.press(second);
      if(second==='s'){await page.locator('.whiteboard-editor textarea').waitFor();await page.keyboard.press('Escape');await page.mouse.click(1100,820);}
      const n=await until(async()=>{const n=(await decos(id)).length;return n===expect&&n;},6000);
      assert.equal(n,expect,`${second} after ⌘Z: ${before} drawn before, ${(await decos(id)).length} after`);
      await page.waitForTimeout(400);
    }
  });

  await run('A colour change and a delete each undo and redo',async(page,id)=>{
    await select(page,'s1');
    await page.locator('.whiteboard-toolbar [data-whiteboard-action="text-appearance"]').click();
    const swatch=page.locator('.whiteboard-menu [data-whiteboard-action="color"]:not([aria-pressed="true"])').first();
    const color=await swatch.getAttribute('data-value');await swatch.click();
    assert.ok(await until(async()=>(await deco(id,'s1')).color===color),'colour saved');
    await page.keyboard.press('Escape');await page.mouse.click(1100,820);
    await history(page,'undo');
    assert.ok(await until(async()=>(await deco(id,'s1')).color==='#f6e6a4'),'Undo restores the colour');
    await history(page,'redo');
    assert.ok(await until(async()=>(await deco(id,'s1')).color===color),'Redo reapplies it');
    await select(page,'s2');await page.keyboard.press('Delete');
    assert.ok(await until(async()=>!(await deco(id,'s2'))),'deleted');
    await history(page,'undo');
    assert.ok(await until(async()=>!!(await deco(id,'s2'))),'Undo restores the deleted sticky');
  });

  await run('A multi-select colour change is one step',async(page,id)=>{
    await select(page,'s1');await page.keyboard.down('Shift');await select(page,'s2');await page.keyboard.up('Shift');
    await page.locator('.whiteboard-toolbar [data-whiteboard-action="text-appearance"]').click();
    const swatch=page.locator('.whiteboard-menu [data-whiteboard-action="color"]:not([aria-pressed="true"])').first();
    const color=await swatch.getAttribute('data-value');await swatch.click();
    assert.ok(await until(async()=>(await deco(id,'s1')).color===color&&(await deco(id,'s2')).color===color),'both recoloured');
    await page.keyboard.press('Escape');await page.mouse.click(1100,820);
    await history(page,'undo');
    assert.ok(await until(async()=>(await deco(id,'s1')).color==='#f6e6a4'&&(await deco(id,'s2')).color==='#f6e6a4'),'one Undo restores both');
  });

  await run('Mixed Delete and mixed ⌘D are each one step',async(page,id,card)=>{
    await page.mouse.click(1100,820);await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press(`${MOD}+d`);
    assert.ok(await until(async()=>(await live(id))===2&&(await decos(id)).length===4),'card and both stickies copied');
    await page.keyboard.press('Escape');
    await history(page,'undo');
    assert.ok(await until(async()=>(await live(id))===1&&(await decos(id)).length===2),'one Undo removes every copy');
    await page.mouse.click(1100,820);await page.keyboard.press(`${MOD}+a`);await page.keyboard.press('Delete');
    assert.ok(await until(async()=>(await live(id))===0&&(await decos(id)).length===0),'card and stickies removed');
    await history(page,'undo');
    assert.ok(await until(async()=>(await live(id))===1&&(await decos(id)).length===2),'one Undo restores all three');
    await history(page,'redo');
    assert.ok(await until(async()=>(await live(id))===0&&(await decos(id)).length===0),'Redo removes them again');
  });
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const r of results)console.log(`${r.pass?'PASS':'FAIL'}  ${r.name}${r.error?'  -- '+r.error:''}`);
const failed=results.filter(r=>!r.pass).length;console.log(JSON.stringify({passed:results.length-failed,failed}));
process.exit(failed?1:0);
