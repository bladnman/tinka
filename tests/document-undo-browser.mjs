// In-place document editing: ⌘Z / ⇧⌘Z for every structural change (lists made, converted and
// removed, Markdown block and inline shortcuts, checkboxes, leaving a quote), word-sized typing
// steps, and keys typed before the caret appears after a double-click. Isolated fixture, headless,
// port 0; each case creates its own document with D and edits it on its card.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-document-undo-'));
const MOD=process.platform==='darwin'?'Meta':'Control';
let server,browser,config,url;const results=[];
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,80));}return last;};
let board,page,errors;
// A new document, editing on its card, with the caret on an empty line under its heading.
async function fresh(){
  await page.mouse.move(640,380);await page.keyboard.press('d');
  const frame=page.frameLocator('.workspace-card.doc-editing iframe'),ed=frame.locator('article.doc-editing');
  await ed.locator('h1').waitFor({timeout:15000});
  await page.keyboard.type('T');await page.keyboard.press('Enter');
  return {frame,ed,html:()=>ed.evaluate(e=>e.innerHTML.replace(/​/g,'')),text:()=>ed.evaluate(e=>e.innerText.replace(/​/g,''))};
}
// The board writes the auto title after editing ends and quick-create keys wait for that
// write: done when the stored title and the card's title both read "T" (no "Untitled" left).
async function done(){
  await page.keyboard.press('Escape');await page.locator('.workspace-card.doc-editing').waitFor({state:'detached'});
  assert.ok(await until(async()=>{const items=Object.values((await getBoardSnapshot(config,board.boardId)).items);
    return items.every(i=>i.title!=='Untitled')&&await page.evaluate(()=>![...document.querySelectorAll('#world .workspace-card')].some(c=>/\bUntitled\b/.test(c.textContent)));},15000),'title written and shown');
}
const undo=()=>page.keyboard.press(`${MOD}+KeyZ`),redo=()=>page.keyboard.press(`${MOD}+Shift+KeyZ`);
async function run(name,body){
  try{await body();assert.deepEqual(errors,[],'page errors');results.push({name,pass:true});}
  catch(e){results.push({name,pass:false,error:String(e.message).split('\n').slice(0,3).join(' | ')});await page.keyboard.press('Escape').catch(()=>{});await page.waitForTimeout(300);}
}
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Undo fixture']);
  config=await loadConfig(configFile);
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  board=(await applyOperation(config,{type:'createBoard',title:'Undo'})).result;
  page=await (await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})).newPage();errors=[];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${url}/boards/${board.boardId}/`);await page.waitForSelector('#viewport');await page.waitForTimeout(600);

  for(const [marker,selector,label] of [['- ','ul:not(.checklist) > li','bullet'],['1. ','ol > li','numbered'],['[] ','ul.checklist > li','checklist']])
    await run(`typing "${marker}" makes a ${label} list; undo brings back the typed marker, redo the list`,async()=>{
      const d=await fresh();await page.keyboard.type(marker+'item');
      assert.equal(await d.ed.locator(selector).count(),1,'list made');
      await undo();await undo();
      assert.equal(await d.ed.locator('ul,ol').count(),0,'list undone');
      assert.ok((await d.text()).includes(marker.trim()),`literal marker back: ${await d.text()}`);
      await redo();await redo();
      assert.equal(await d.ed.locator(selector).count(),1,'redo makes the list again');
      assert.ok((await d.ed.locator(selector).textContent()).includes('item'));
      await done();
    });

  for(const [marker,tag] of [['# ','h1'],['> ','blockquote']])
    await run(`typing "${marker}" makes a ${tag}; undo restores the marker as text`,async()=>{
      const d=await fresh();await page.keyboard.type(marker);
      assert.equal(await d.ed.locator(`:scope > ${tag}`).count(),tag==='h1'?2:1,`${tag} made`);
      await undo();
      assert.equal(await d.ed.locator(`:scope > ${tag}`).count(),tag==='h1'?1:0,`${tag} undone`);
      assert.ok((await d.text()).trimEnd().endsWith(marker.trim()),`marker text back: ${JSON.stringify(await d.text())}`);
      await redo();assert.equal(await d.ed.locator(`:scope > ${tag}`).count(),tag==='h1'?2:1,'redo');
      await done();
    });

  for(const [typed,tag] of [['**bold**','strong'],['`code`','code']])
    await run(`typing ${typed} formats it; undo leaves the literal markers`,async()=>{
      const d=await fresh();await page.keyboard.type(`a ${typed}`);
      assert.equal(await d.ed.locator(tag).count(),1,`${tag} made`);
      await undo();
      assert.equal(await d.ed.locator(tag).count(),0,`${tag} undone`);
      assert.ok((await d.text()).includes(`a ${typed}`),`literal back: ${await d.text()}`);
      await redo();assert.equal(await d.ed.locator(tag).count(),1,'redo');
      await done();
    });

  await run('ticking a checkbox is one undo step',async()=>{
    const d=await fresh();await page.keyboard.type('[] task');
    const li=d.ed.locator('ul.checklist > li').first(),box=await li.boundingBox();
    await page.mouse.click(box.x+4,box.y+box.height/2);assert.equal(await li.getAttribute('data-checked'),'true');
    await undo();assert.equal(await d.ed.locator('ul.checklist > li').first().getAttribute('data-checked'),'false');
    await redo();assert.equal(await d.ed.locator('ul.checklist > li').first().getAttribute('data-checked'),'true');
    await done();
  });

  await run('converting and removing a list with ⌘⇧7 / ⌘⇧8 undo one step each',async()=>{
    const d=await fresh();await page.keyboard.type('- one');await page.keyboard.press('Enter');await page.keyboard.type('two');
    await page.keyboard.press(`${MOD}+Shift+Digit7`);assert.equal(await d.ed.locator('ol > li').count(),2,'converted');
    await undo();assert.equal(await d.ed.locator('ul > li').count(),2,'conversion undone');assert.equal(await d.ed.locator('ol').count(),0);
    await page.keyboard.press(`${MOD}+Shift+Digit8`);assert.equal(await d.ed.locator('ul > li').count(),1,'item removed from the list');
    assert.ok((await d.html()).includes('<p>two</p>'));
    await undo();assert.equal(await d.ed.locator('ul > li').count(),2,'removal undone');
    await redo();assert.equal(await d.ed.locator('ul > li').count(),1,'redo removes again');
    await done();
  });

  await run('leaving a quote with Enter is one undo step',async()=>{
    const d=await fresh();await page.keyboard.type('> wise');await page.keyboard.press('Enter');
    assert.equal(await d.ed.evaluate(e=>e.lastElementChild.tagName),'P','left the quote');
    await undo();
    assert.equal(await d.ed.evaluate(e=>e.lastElementChild.tagName),'BLOCKQUOTE','back in the quote');
    await page.keyboard.type(' words');assert.equal(await d.ed.locator('blockquote').textContent(),'wise words','caret restored inside the quote');
    await done();
  });

  await run('typing undoes a word at a time, and the saved file follows undo',async()=>{
    const d=await fresh();await page.keyboard.type('hello brave world');
    await undo();assert.equal((await d.text()).split('\n').at(-1),'hello brave');
    await undo();assert.equal((await d.text()).split('\n').at(-1),'hello');
    await redo();assert.equal((await d.text()).split('\n').at(-1),'hello brave');
    const snap=await getBoardSnapshot(config,board.boardId),item=Object.values(snap.items).filter(i=>i.content?.kind==='markdown').at(-1);
    const file=path.join(fixture,'boards','imports',item.content.resource.path);
    assert.ok(await until(async()=>(await readFile(file,'utf8')).trimEnd().endsWith('hello brave'),4000),'autosave writes the undone state');
    await done();
  });

  await run('keys typed right after a double-click are kept; Escape then cancels cleanly',async()=>{
    const snap=await getBoardSnapshot(config,board.boardId),placement=snap.placements.at(-1),card=page.locator(`[data-placement="${placement.id}"]`);
    const item=snap.items[placement.itemId],file=path.join(fixture,'boards','imports',item.content.resource.path),before=await readFile(file,'utf8');
    const box=await card.locator('.workspace-card-preview').boundingBox();
    await page.mouse.dblclick(box.x+box.width-30,box.y+box.height-30);await page.keyboard.type('xyz',{delay:5});
    const ed=page.frameLocator('.workspace-card.doc-editing iframe').locator('article.doc-editing');
    assert.ok(await until(async()=>(await ed.innerText()).includes('xyz'),15000),`early keys replayed in order: ${await ed.innerText().catch(()=>'')}`);
    await done();
    assert.ok(await until(async()=>(await readFile(file,'utf8')).includes('xyz'),15000),'saved');
    const now=await readFile(file,'utf8');
    await page.mouse.dblclick(box.x+box.width-30,box.y+box.height-30);await page.keyboard.press('Escape');
    await page.locator('.workspace-card.doc-editing').waitFor({state:'detached'});
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.workspace-card.doc-editing').count(),0,'not editing');
    assert.equal(await page.locator('#reader-dialog[open]').count(),0,'reader not opened');
    assert.equal(await readFile(file,'utf8'),now,'nothing written');assert.notEqual(now,before);
  });
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const r of results)console.log(`${r.pass?'PASS':'FAIL'}  ${r.name}${r.error?'  -- '+r.error:''}`);
const failed=results.filter(r=>!r.pass).length;console.log(JSON.stringify({passed:results.length-failed,failed}));
process.exit(failed?1:0);
