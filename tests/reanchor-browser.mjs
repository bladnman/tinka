// An edit elsewhere in a document keeps its highlights painted in the reader and on the board
// card: the save re-anchors marks whose quote and context are unchanged. Isolated fixture, headless.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listHighlights} from '../lib/highlights.mjs';
import {parseMarkdown,MARKDOWN_TEXT_MODEL} from '../public/markdown-document.js';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-reanchor-ui-'));let server,browser;
const filler=word=>Array.from({length:14},(_,i)=>`${word}${i}`).join(' ')+'.';
const original=`# Field notes\n\n${filler('alpha')}\n\nReview the selected passage before release.\n\n${filler('beta')}\n\n## Decisions\n\n${filler('gamma')}\n\nKeep the next step clear for everyone.\n\n${filler('delta')}\n`;
const sha=text=>'sha256:'+createHash('sha256').update(Buffer.from(text)).digest('hex');
function anchorFor(quote){const text=parseMarkdown(original).text,start=text.indexOf(quote);return {kind:'text',quote,prefix:text.slice(Math.max(0,start-96),start),suffix:text.slice(start+quote.length,start+quote.length+96),start,end:start+quote.length,sourceRevision:sha(original),textModel:MARKDOWN_TEXT_MODEL};}
try{
  const configFile=path.join(fixture,'local/config.json');await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Re-anchor fixture']);
  const config=await loadConfig(configFile),docs=path.join(fixture,'documents');await mkdir(docs);await writeFile(path.join(docs,'notes.md'),original);
  const board=(await applyOperation(config,{type:'createBoard',title:'Re-anchor'})).result;
  await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:{documents:{path:'../../documents'}}}});
  const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Field notes',content:{kind:'markdown',resource:{rootId:'documents',path:'notes.md'}}},placement:{x:0,y:0,width:420,height:420,presentation:{mode:'panel',viewport:{width:720,height:560}}}})).result;
  const author={id:'reviewer',label:'Reviewer',kind:'human'};
  for(const [id,quote] of [['one','selected passage'],['two','next step clear']])await applyOperation(config,{type:'addHighlight',id,itemId:item.itemId,author,anchor:anchorFor(quote)});
  const placementId=(await getBoardSnapshot(config,board.boardId)).placements.find(p=>p.itemId===item.itemId).id;
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1300,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.goto(`${base}/boards/${board.boardId}/`);await page.waitForSelector('#viewport');
  const card=page.locator(`[data-placement="${placementId}"]`),cardFrame=await card.locator('.workspace-live-preview iframe').elementHandle();
  const until=async(fn,ms=8000)=>{const end=Date.now()+ms;let value;while(Date.now()<end){value=await fn().catch(()=>null);if(value)return value;await page.waitForTimeout(150);}return value;};
  const cardPainted=()=>cardFrame.evaluate(f=>f.contentWindow.CSS.highlights.get('tinka-document-highlights')?.size||0);
  assert.equal(await until(async()=>await cardPainted()===2),true,'card paints both highlights before the edit');
  await card.locator('.workspace-preview-launch').click();
  const media=page.frameLocator('#active-reader').frameLocator('.item-full-frame');await media.locator('.markdown').waitFor();
  const readerPainted=()=>media.locator('.markdown').evaluate(()=>CSS.highlights.get('tinka-document-highlights')?.size||0);
  assert.equal(await until(async()=>await readerPainted()===2),true,'reader paints both highlights before the edit');
  // Edit far from both passages, in place in the reader (autosave, then Done).
  const moved=new Set(),puts=[];page.on('response',async response=>{if(/\/api\/documents\//.test(response.url())&&response.request().method()==='PUT'){puts.push(response.status());try{for(const id of (await response.json()).reanchored?.highlights||[])moved.add(id);}catch{}}});
  await media.locator('[data-document-edit]').click();
  await media.locator('.markdown[contenteditable="true"], [contenteditable="true"]').first().waitFor();
  const last=media.locator('[contenteditable="true"] p').last();await last.click();
  await page.keyboard.press(process.platform==='darwin'?'Meta+ArrowDown':'Control+End');await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.type('An appendix added at the end.');
  await media.locator('[data-document-edit]').click();
  assert.ok(await until(async()=>puts.length&&moved.has('one')&&moved.has('two')),`saved and re-anchored: ${JSON.stringify({puts,moved:[...moved]})}`);assert.ok(puts.every(status=>status===200));
  assert.ok(await until(async()=>(await media.locator('.markdown').textContent()).includes('An appendix added at the end.')),'reader shows the edit');
  assert.equal(await until(async()=>await readerPainted()===2),true,'reader keeps both highlights painted');
  assert.equal(await media.locator('.document-status').textContent(),'','no annotation needs review');
  await page.keyboard.press('Escape');
  assert.equal(await until(async()=>(await cardFrame.evaluate(f=>f.contentDocument.querySelector('.markdown')?.textContent||'')).includes('An appendix')&&await cardPainted()===2),true,'card shows the edit and keeps both highlights');
  const stored=(await listHighlights(config,{itemId:item.itemId})).highlights;assert.ok(stored.every(mark=>mark.anchorStatus==='matched'&&mark.reanchored?.length===1&&mark.anchor.sourceRevision!==sha(original)));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:'card+reader paint before; reader Edit save far from passages; both re-anchored with history; reader+card still paint; no review notice'}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true});}
