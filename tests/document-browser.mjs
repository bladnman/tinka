// Focused linked-document integration. All fixture data and screenshots are external.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listFeedback} from '../lib/feedback.mjs';
import {parseMarkdown} from '../public/markdown-document.js';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-document-ui-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-document-ui-evidence-'));
await mkdir(evidence,{recursive:true});let server,browser,page;
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Document fixture']);
  const config=await loadConfig(configFile),docs=path.join(fixture,'documents');await mkdir(docs);
  const original='# A calm release\n\nReview the selected passage before release.\n\n## Decisions\n\nKeep **readable labels** and [the source](related.md).\n\n- Preserve existing work\n- Keep the next step clear\n\n![A small diagram](diagram.svg)\n\n<script>window.documentUnsafe=true</script>\n\n## Decisions\n\nThe next iteration stays focused.';
  const sourceFile=path.join(docs,'design.md');await writeFile(sourceFile,original);await writeFile(path.join(docs,'related.md'),'# Related source');await writeFile(path.join(docs,'diagram.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" rx="8" fill="#dce8d4"/><text x="20" y="36" font-size="16">A clear decision</text></svg>');
  await writeFile(path.join(docs,'unsafe.html'),'<h1>Independent HTML</h1>');
  const board=(await applyOperation(config,{type:'createBoard',title:'Document review'})).result;
  await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:{documents:{path:'../../documents'}}}});
  const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Release design',content:{kind:'markdown',resource:{rootId:'documents',path:'design.md'}},revisions:[{id:'history',name:'Earlier version',content:{kind:'markdown',resource:{rootId:'documents',path:'design.md'}}}]},placement:{x:0,y:0,width:520,height:590,presentation:{mode:'panel',viewport:{width:520,height:590}}}})).result;
  item.placementId=(await getBoardSnapshot(config,board.boardId)).placements.find(placement=>placement.itemId===item.itemId).id;
  server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/boards/${board.boardId}/`);
  const card=page.locator(`[data-placement="${item.placementId}"]`),panel=card.frameLocator('.workspace-live-preview iframe');
  await panel.locator('.markdown').waitFor();assert.equal(await panel.locator('.markdown h1').textContent(),'A calm release');assert.equal(await panel.locator('.document-tools').count(),0);
  const panelFrame=await card.locator('.workspace-live-preview iframe').elementHandle();
  const caption=await card.locator('.workspace-panel-title').boundingBox(),moved=page.waitForResponse(response=>response.url().endsWith('/api/operations')&&response.request().method()==='POST');
  await page.mouse.move(caption.x+caption.width/2,caption.y+caption.height/2);await page.mouse.down();await page.mouse.move(caption.x+caption.width/2+22,caption.y+caption.height/2+12,{steps:12});await page.mouse.up();assert.equal((await moved).ok(),true);
  assert.equal(await panelFrame.evaluate(node=>node.isConnected),true,'placement edits retain mounted document iframe');
  async function openReader(){await card.locator('.workspace-preview-launch').click();const media=page.frameLocator('#active-reader').frameLocator('.item-full-frame');await media.locator('.markdown').waitFor();return media;}
  let media=await openReader();
  assert.equal(await media.locator('.markdown').textContent(),parseMarkdown(original).rawText,'DOM text and backend parser agree exactly');
  assert.equal(await media.locator('.markdown script').count(),0);assert.equal(await media.locator('.document-source').textContent(),'documents / design.md');
  assert.equal(await media.locator('.markdown a').getAttribute('target'),'_blank');assert.equal(await media.locator('.markdown img').getAttribute('src'),`${base}/resources/documents/diagram.svg`);
  await media.locator('select[aria-label="Document contents"]').selectOption('decisions-2');
  assert.equal(await media.locator('select').inputValue(),'decisions-2');
  await media.locator('select').selectOption('');await media.locator('#media-content').evaluate(node=>node.scrollTop=0);
  // Article-only selections preserve whitespace/inline/UTF-16 positions across elements.
  const selectionModel=await media.locator('.markdown').evaluate(async article=>{
    const {selectionTextAnchor}=await import('/app/markdown-document.js'),paragraph=article.querySelector('p'),range=document.createRange();range.selectNodeContents(paragraph);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    const anchor=selectionTextAnchor(article,selection,'sha256:'+'0'.repeat(64));selection.removeAllRanges();return anchor;
  });assert.equal(selectionModel.quote,'Review the selected passage before release.');
  const acrossBlocks=await media.locator('.markdown').evaluate(async article=>{
    const {selectionTextAnchor}=await import('/app/markdown-document.js'),range=document.createRange();range.setStart(article.querySelector('p').firstChild,11);range.setEnd(article.querySelector('strong').firstChild,8);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const anchor=selectionTextAnchor(article,selection,'sha256:'+'0'.repeat(64));selection.removeAllRanges();return anchor;
  });assert.equal(acrossBlocks.quote,'selected passage before release. Decisions Keep readable');
  // An unrelated same-origin frame cannot relay a selected quote.
  await page.evaluate(({itemId})=>{window.postMessage({type:'tinka-comment-selection',itemId,anchor:{kind:'text',quote:'forged',start:0,end:6,sourceRevision:'sha256:'+'0'.repeat(64)}},location.origin);},{itemId:item.itemId});
  await page.evaluate(({itemId})=>{const frame=document.getElementById('active-reader');frame.contentWindow.postMessage({type:'tinka-comment-selection',itemId,anchor:{kind:'text',quote:'forged',start:0,end:6,sourceRevision:'sha256:'+'0'.repeat(64)}},location.origin);window.dispatchEvent(new MessageEvent('message',{origin:'https://invalid.example',source:frame.contentWindow,data:{type:'tinka-comment-selection',itemId,anchor:{kind:'text',quote:'forged',start:0,end:6,sourceRevision:'sha256:'+'0'.repeat(64)}}}));},{itemId:item.itemId});
  assert.equal(await page.locator('dialog.workspace-dialog').count(),0);
  // Use a real mouse text selection through both nested frames.
  const coordinates=await media.locator('.markdown p').first().evaluate(paragraph=>{
    const node=paragraph.firstChild,text=node.textContent,start=text.indexOf('selected passage'),range=document.createRange();range.setStart(node,start);range.setEnd(node,start+'selected passage'.length);const rect=range.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  });
  const mediaElement=page.frameLocator('#active-reader').locator('.item-full-frame'),box=await mediaElement.boundingBox();
  await page.mouse.move(box.x+coordinates.x+1,box.y+coordinates.y+coordinates.height/2);await page.mouse.down();await page.mouse.move(box.x+coordinates.x+coordinates.width-1,box.y+coordinates.y+coordinates.height/2,{steps:15});await page.mouse.up();
  await media.locator('.document-selection-action').waitFor({state:'visible'});await media.locator('.document-selection-action').click();
  await page.locator('dialog.workspace-dialog textarea').fill('Tighten this selected passage.');
  const savedComment=page.waitForResponse(response=>response.url().endsWith('/api/operations')&&response.request().method()==='POST');
  await page.locator('dialog.workspace-dialog button[type=submit]').click();assert.equal((await savedComment).ok(),true,'quote comment received a successful server response');await page.locator('dialog.workspace-dialog').waitFor({state:'detached'});
  await page.locator('.feedback-thread').waitFor();await page.locator('[data-feedback-reply]').click();await page.locator('dialog.workspace-dialog textarea').fill('I will keep the intent and simplify the words.');await page.locator('dialog.workspace-dialog button[type=submit]').click();await page.locator('.feedback-reply').waitFor();
  let feedback=await listFeedback(config,{itemId:item.itemId,includeBodies:true});assert.equal(feedback.threads.length,1);assert.equal(feedback.threads[0].anchor.quote,'selected passage');assert.equal(feedback.threads[0].anchorStatus,'matched');assert.equal(feedback.threads[0].replies.length,1);
  const cli=JSON.parse(await main(['tools','call','feedback.list','--config',configFile,'--json',JSON.stringify({itemId:item.itemId,includeBodies:true})]));assert.deepEqual(cli,feedback);
  await page.locator('[data-feedback-close]').click();media=await openReader();await media.locator('mark[data-document-thread]').first().waitFor();await page.screenshot({path:path.join(evidence,'document-wide.png')});
  // Changing raw bytes alone changes revision even when visible quote/offset/context survive.
  await writeFile(sourceFile,original+'\n');await media.locator('[data-document-reload]').click();await media.locator('.document-status').filter({hasText:'need source review'}).waitFor();assert.equal(await media.locator('mark').count(),0);
  feedback=await listFeedback(config,{itemId:item.itemId});assert.equal(feedback.threads[0].anchorStatus,'uncertain');
  await writeFile(sourceFile,original.replace('selected passage','replacement paragraph'));await media.locator('[data-document-reload]').click();await media.locator('.markdown p').first().filter({hasText:'replacement paragraph'}).waitFor();feedback=await listFeedback(config,{itemId:item.itemId});assert.equal(feedback.threads[0].anchorStatus,'stale');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'document-narrow.png')});
  const toolBounds=await media.locator('.document-tools').boundingBox();assert.ok(toolBounds.width<=390);assert.equal(await media.locator('body').evaluate(node=>node.scrollWidth<=innerWidth),true);
  // Historical variants have visible read-only explanation and ignore relay messages.
  await page.locator('#close-reader').click();
  const history=await browser.newPage();await history.goto(`${base}/app/item.html?item=${item.itemId}&variant=history&commentBoard=${board.boardId}`);const historical=history.frameLocator('.item-full-frame');await historical.locator('.document-status').filter({hasText:'historical versions'}).waitFor();assert.equal(await historical.locator('.document-selection-action').isVisible(),false);await history.close();
  // Source push reload retains Markdown panel mode, not the full item adapter.
  await page.setViewportSize({width:1440,height:960});
  await page.waitForFunction(({id})=>{const frame=document.querySelector(`[data-placement="${id}"] .workspace-live-preview iframe`);try{return frame?.contentDocument?.querySelector('.markdown')?.textContent.includes('replacement paragraph');}catch{return false;}},{id:item.placementId},{timeout:10000});
  assert.match(await card.locator('.workspace-live-preview iframe').getAttribute('src'),/mode=panel/);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,evidence,checks:'actual linked panel/reader; DOM/parser parity; Contents/source; mouse quote/comment/reply/CLI; matched/uncertain/stale; historic read-only; narrow layout; source update/panel identity'}));
}catch(error){if(page){await page.screenshot({path:path.join(evidence,'document-failure.png')});console.error(JSON.stringify({evidence,dialogs:await page.locator('dialog.workspace-dialog').allTextContents(),feedback:await page.locator('.feedback-panel').allTextContents()}));}throw error;}
finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true});}
