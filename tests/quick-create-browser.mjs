// Fast creation on the canvas: T/S/D hotkeys, the quick-add strip, Escape keeping typed
// text, and pasting plain text as a note. Each case runs on its own fresh board and page.
// Isolated fixture, headless, port 0; ClipboardEvent exercises the paste handler without
// the OS clipboard.
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
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-quick-create-'));
let server,browser,config,url;const results=[];
const decos=async id=>(await getBoardSnapshot(config,id)).decorations||[];
const items=async id=>{const s=await getBoardSnapshot(config,id);return s.placements.filter(p=>!p.removedAt).map(p=>s.items[p.itemId]);};
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}return last;};
async function run(name,body){
  const board=(await applyOperation(config,{type:'createBoard',title:name})).result;
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`${url}/boards/${board.boardId}/`);await page.waitForSelector('#viewport');await page.waitForTimeout(600);
    await body(page,board.boardId);
    assert.deepEqual(errors,[],'page errors');
    results.push({name,pass:true});
  }catch(e){results.push({name,pass:false,error:String(e.message).split('\n').slice(0,3).join(' | ')});}
  finally{await context.close();}
}
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Quick create fixture']);
  config=await loadConfig(configFile);
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});

  await run('T, type, Escape keeps the text',async(page,id)=>{
    await page.mouse.move(400,400);await page.keyboard.press('t');
    const d=await until(async()=>(await decos(id)).find(d=>d.type==='text'));assert.ok(d?.id,'T adds a text');
    assert.ok(await until(()=>page.evaluate(()=>!!document.activeElement?.closest('[contenteditable],textarea,[role=textbox]'))),'text opens for editing');
    await page.keyboard.press(process.platform==='darwin'?'Meta+a':'Control+a');
    await page.keyboard.type('Kept after escape');await page.keyboard.press('Escape');
    const saved=await until(async()=>(await decos(id)).find(x=>x.id===d.id&&x.text==='Kept after escape'));
    assert.ok(saved?.id,`Escape keeps typed text; saved ${JSON.stringify((await decos(id)).map(x=>x.text))}`);
    assert.equal((await decos(id)).length,1,'typing adds nothing else');
  });

  await run('S creates a sticky',async(page,id)=>{
    await page.mouse.move(600,350);await page.keyboard.press('s');
    const d=await until(async()=>(await decos(id))[0]);
    assert.equal(d?.type,'region');assert.equal(d.shape,'rectangle');assert.equal(d.color,'#f6e6a4');
    await page.locator(`[data-decoration="${d.id}"]`).waitFor();
  });

  await run('D opens the document editor and saves a markdown card',async(page,id)=>{
    await page.mouse.move(500,400);await page.keyboard.press('d');
    const dialog=page.locator('dialog.tinka-doc-editor[open]');await dialog.waitFor({timeout:5000});
    await dialog.locator('textarea').fill('# Hi');
    await dialog.locator('[data-act=done]').click();await dialog.waitFor({state:'detached'});
    const item=await until(async()=>(await items(id)).find(i=>i.content?.kind==='markdown'));
    assert.ok(item?.content,'a markdown item is placed on the board');
    const shown=await until(async()=>{for(const f of page.frames()){const t=await f.evaluate(()=>document.querySelector('article.markdown')?.textContent||'').catch(()=>'');if(/\bHi\b/.test(t))return true;}return false;},12000);
    assert.equal(shown,true,'markdown card shows "Hi"');
  });

  await run('Quick-add strip buttons work',async(page,id)=>{
    const strip=page.locator('[class*=quick],[id*=quick],[data-quick-add]').filter({has:page.locator('button')}).first();
    await strip.waitFor({timeout:3000});
    for(const [label,check] of [['Text',d=>d.type==='text'],['Sticky',d=>d.color==='#f6e6a4']]){
      const before=(await decos(id)).length;
      await strip.getByRole('button',{name:new RegExp(label,'i')}).first().click();
      const d=await until(async()=>{const all=await decos(id);return all.length>before&&all.at(-1);});
      assert.ok(d&&check(d),`${label} button adds a ${label.toLowerCase()}`);
      await page.keyboard.press('Escape');await page.mouse.click(1100,820);await page.waitForTimeout(200);
    }
    await strip.getByRole('button',{name:/document/i}).first().click();
    const dialog=page.locator('dialog.tinka-doc-editor[open]');await dialog.waitFor({timeout:5000});
    await dialog.locator('[data-act=cancel]').click();await dialog.waitFor({state:'detached'});
  });

  await run('Paste plain text creates a note',async(page,id)=>{
    const beforeItems=(await items(id)).length,beforeDecos=(await decos(id)).length,text='Pasted thought for the board';
    await page.mouse.click(640,450);
    await page.evaluate(text=>{const dt=new DataTransfer();dt.setData('text/plain',text);document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},text);
    const made=await until(async()=>{
      const d=(await decos(id)).slice(beforeDecos).find(d=>String(d.text||'').includes(text));if(d)return {via:'decoration',type:d.type,shape:d.shape};
      const i=(await items(id)).slice(beforeItems).find(i=>JSON.stringify(i.content||{}).includes(text)||String(i.title||'').includes(text));if(i)return {via:'item',kind:i.content?.kind};
      return null;
    },8000);
    assert.ok(made?.via,'pasting plain text creates something holding the text');
    const isNote=(made.via==='decoration'&&made.type==='region')||(made.via==='item'&&made.kind==='note');
    assert.ok(isNote,`paste should create a note; created ${JSON.stringify(made)}`);
  });
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const r of results)console.log(`${r.pass?'PASS':'FAIL'}  ${r.name}${r.error?'  -- '+r.error:''}`);
const failed=results.filter(r=>!r.pass).length;console.log(JSON.stringify({passed:results.length-failed,failed}));
process.exit(failed?1:0);
