// Fast creation on the canvas: T/S/D hotkeys, the edit tools palette, Escape keeping typed
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

  await run('D creates a document and edits it in place on its card; E and the pill Edit reopen it',async(page,id)=>{
    await page.mouse.move(500,400);await page.keyboard.press('d');
    const editingCard=page.locator('.workspace-card.doc-editing');await editingCard.waitFor({timeout:6000});
    const frame=page.frameLocator('.workspace-card.doc-editing iframe');
    // No modal and no toolbar: the card's own page is editable, with "Untitled" selected.
    assert.equal(await page.locator('dialog[open]').count(),0,'no dialog opens');
    await frame.locator('article.doc-editing h1').waitFor();
    assert.ok(await until(()=>frame.locator('body').evaluate(()=>getSelection().toString()==='Untitled')),'the title is selected');
    await page.keyboard.type('Hi');await page.keyboard.press('Escape');
    await page.locator('.workspace-card.doc-editing').waitFor({state:'detached'});
    const item=await until(async()=>(await items(id)).find(i=>i.content?.kind==='markdown'&&i.title==='Hi'));
    assert.ok(item?.content,'a markdown item titled from its heading is placed on the board');
    const shown=await until(async()=>{for(const f of page.frames()){const t=await f.evaluate(()=>document.querySelector('article.markdown')?.textContent||'').catch(()=>'');if(/\bHi\b/.test(t))return true;}return false;},12000);
    assert.equal(shown,true,'markdown card shows "Hi"');
    const placement=(await getBoardSnapshot(config,id)).placements.find(p=>p.itemId===item.id);
    const card=page.locator(`[data-placement="${placement.id}"]`);
    // E on the selected card edits it in place again.
    await page.mouse.click(1100,820);await card.locator('[data-placement-select]').click();assert.equal(await page.locator('.workspace-card.selected').count(),1);await page.keyboard.press('e');
    await page.locator('.workspace-card.doc-editing').waitFor({timeout:5000});await page.keyboard.press('Escape');
    await page.locator('.workspace-card.doc-editing').waitFor({state:'detached'});
    // The card's hover pill offers Edit beside Open.
    await card.hover();
    const edit=card.locator('[data-edit-document-item]');await edit.waitFor({state:'visible'});
    assert.equal(await edit.textContent(),'Edit');
    await edit.click();await page.locator('.workspace-card.doc-editing').waitFor({timeout:5000});
    await page.keyboard.press('Escape');await page.locator('.workspace-card.doc-editing').waitFor({state:'detached'});
  });

  await run('Edit tools palette: hidden by default, toggles, buttons work, remembered',async(page,id)=>{
    assert.equal(await page.locator('[class*=quick-add],[data-quick-add]').count(),0,'no quick-add strip in the top bar');
    const palette=page.locator('#edit-tools'),toggle=page.locator('#edit-tools-toggle');
    assert.equal(await palette.isVisible(),false,'palette hidden by default');
    await page.mouse.click(1100,820);await page.keyboard.press('a');await palette.waitFor({state:'visible'});
    assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    await page.keyboard.press('a');await palette.waitFor({state:'hidden'});
    await toggle.click();await palette.waitFor({state:'visible'});
    for(const [tool,check] of [['text',d=>d.type==='text'],['sticky',d=>d.color==='#f6e6a4']]){
      const before=(await decos(id)).length;
      await palette.locator(`[data-edit-tool=${tool}]`).click();
      const d=await until(async()=>{const all=await decos(id);return all.length>before&&all.at(-1);});
      assert.ok(d&&check(d),`${tool} button adds a ${tool}`);
      await page.keyboard.press('Escape');await page.mouse.click(1100,820);await page.waitForTimeout(200);
    }
    assert.equal(await palette.isVisible(),true,'Escape leaves the palette open');
    await palette.locator('[data-edit-tool=document]').click();
    await page.locator('.workspace-card.doc-editing').waitFor({timeout:6000});
    await page.keyboard.press('Escape');await page.locator('.workspace-card.doc-editing').waitFor({state:'detached'});
    await palette.locator('[data-edit-tool=jot]').click();await page.locator('.quick-jot input').waitFor();await page.keyboard.press('Escape');
    await palette.locator('[data-edit-tool=more]').click();await page.locator('.workspace-add-menu').waitFor();await page.keyboard.press('Escape');
    await page.reload();await page.locator('#edit-tools').waitFor({state:'visible',timeout:8000});
    await page.locator('#edit-tools-toggle').click();await page.reload();await page.waitForSelector('#edit-tools-toggle');await page.waitForTimeout(500);
    assert.equal(await page.locator('#edit-tools').isVisible(),false,'off state survives reload');
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
