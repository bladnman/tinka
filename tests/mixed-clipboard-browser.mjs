// Native clipboard-event path on disposable boards. No OS clipboard access.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {CLIPBOARD_MIME} from '../public/clipboard.js';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const fixture = await mkdtemp(path.join(os.tmpdir(),'tinka-mixed-clipboard-'));
const configFile = path.join(fixture,'config.json'), boards = path.join(fixture,'boards');
const resource = path.join(boards,'assets','study.html'), html = '<body style="background:#c3b7dc"><h1>Study in violet</h1></body>';
let browser, started;
try {
  await main(['init','--config',configFile,'--boards',boards,'--label','Clipboard QA']);
  await main(['workspace','init','--config',configFile,'--apply']);
  await mkdir(path.dirname(resource),{recursive:true});
  await writeFile(resource,html);
  const config = await loadConfig(configFile);
  const op = async (type, data) => (await applyOperation(config,{type,...data})).result;
  await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
  const {boardId} = await op('createBoard',{title:'Source studies'});
  const {boardId:destination} = await op('createBoard',{title:'Destination studies'});
  const {itemId,placementIds:[cardId]} = await op('createItem',{boardId,item:{title:'Study in violet',content:{kind:'html',resource:{rootId:'assets',path:'study.html'}}},
    placement:{x:100,y:100,width:280,height:200,presentation:{mode:'panel',viewport:{width:320,height:220}}}});
  const {placementIds:[memberId]} = await op('createItem',{boardId,item:{title:'Reading notes'},placement:{x:680,y:400,width:180,height:140}});
  const add = (id, fields) => op('createDecoration',{boardId,decoration:{id,color:'#456139',...fields}});
  await add('caption',{type:'text',text:'Native clipboard draft',x:445,y:100,width:220,height:120,textSize:28});
  await add('note',{type:'region',shape:'rectangle',text:'Sticky',x:460,y:355,width:170,height:120});
  await add('container',{type:'region',text:'Grouped evidence',x:430,y:285,width:240,height:200,
    container:{layout:'vertical',children:['note',{placementId:memberId}]}});
  await add('arrow',{type:'line',text:'Read next',x:380,y:130,width:64,height:70,endArrow:true,
    from:{placementId:cardId,side:'right'},to:{decorationId:'caption',side:'left'}});
  await op('groupOccurrences',{boardId,placementIds:[cardId],decorationIds:['container','arrow']});
  await main(['start','--config',configFile]); started = true;
  const {port} = JSON.parse(await readFile(configFile,'utf8')), base = `http://127.0.0.1:${port}`;
  const snapshot = id => fetch(`${base}/api/boards/${id}`).then(r=>r.json());
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page = await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  const goto = async id => { await page.goto(`${base}/boards/${id}/`); await page.locator('#workspace-copy').waitFor({state:'attached'}); };
  const drawing = id => page.locator(`#world [data-decoration="${id}"]`);
  const fire = (type, fields = {}, selector = '#viewport') => page.locator(selector).evaluate((el,{type,fields}) => {
    const transfer = new DataTransfer();
    for (const [name,value] of Object.entries(fields)) transfer.setData(name,value);
    const event = new ClipboardEvent(type,{clipboardData:transfer,bubbles:true,cancelable:true});
    el.dispatchEvent(event);
    return {prevented:event.defaultPrevented,fields:Object.fromEntries([...transfer.types].map(name=>[name,transfer.getData(name)]))};
  },{type,fields});
  const commit = async (type, action) => {
    const request = page.waitForResponse(r => r.url() === `${base}/api/operations` && r.request().postDataJSON()?.type === type);
    await action();
    const response = await request, body = await response.json();
    assert.equal(response.status(),200,JSON.stringify(body)); assert.ok(body.history);
    await page.waitForFunction(() => !document.getElementById('workspace-paste')?.disabled);
    return body.result;
  };
  const mod = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform || navigator.platform)) ? 'Meta' : 'Control';

  await goto(boardId);
  await page.locator('#fit').click();
  await drawing('caption').click();
  const textCopy = await fire('copy');
  assert.ok(textCopy.prevented);
  const native = JSON.parse(textCopy.fields[CLIPBOARD_MIME]);
  assert.deepEqual(native.placements,[]);
  assert.equal(native.decorations[0].text,'Native clipboard draft');
  const solo = await commit('pastePlacements',()=>fire('paste',textCopy.fields));
  assert.notEqual(solo.decorationIds[0],'caption');
  await drawing(solo.decorationIds[0]).waitFor();
  await commit('restoreMovement',()=>page.keyboard.press(`${mod}+z`));
  assert.equal((await snapshot(boardId)).decorations.length,4);

  await drawing('caption').focus();
  await page.keyboard.press('F2');
  const editor = '#world [data-decoration="caption"] .whiteboard-editor textarea';
  await page.locator(editor).waitFor();
  const editingRevision = (await snapshot(boardId)).revision;
  assert.equal((await fire('copy',{},editor)).prevented,false);
  assert.equal((await fire('paste',{'text/plain':'Typed in editor'},editor)).prevented,false);
  assert.equal((await snapshot(boardId)).revision,editingRevision);
  await page.keyboard.press('Escape');

  await page.locator('#viewport').focus();
  await page.keyboard.press(`${mod}+a`);
  const mixed = await fire('copy');
  assert.ok(mixed.prevented);
  const payload = JSON.parse(mixed.fields[CLIPBOARD_MIME]);
  assert.equal(payload.groups.length,1);
  assert.equal(payload.decorations.length,4);
  const onSource = await snapshot(boardId);
  const duplicate = await commit('pastePlacements',()=>page.keyboard.press(`${mod}+d`));
  assert.equal(duplicate.decorationIds.length,4);
  assert.equal((await snapshot(boardId)).groups.length,2);
  await commit('restoreMovement',()=>page.keyboard.press(`${mod}+z`));
  assert.deepEqual((await snapshot(boardId)).groups,onSource.groups);
  await goto(destination);
  await page.locator('#viewport').focus();
  const pasted = await commit('pastePlacements',()=>fire('paste',mixed.fields));
  const onDestination = await snapshot(destination);
  const [placed] = onDestination.placements, copies = Object.fromEntries(onDestination.decorations.map(d=>[d.text,d]));
  assert.notEqual(placed.itemId,itemId);
  assert.equal(onDestination.items[placed.itemId].title,'Study in violet');
  assert.deepEqual(onDestination.items[placed.itemId].content,onSource.items[itemId].content);
  assert.equal(await readFile(resource,'utf8'),html);
  const placedChild = onDestination.placements.find(p => onDestination.items[p.itemId].title === 'Reading notes');
  assert.notEqual(placedChild.id,memberId);
  assert.deepEqual(copies['Grouped evidence'].container.children,[copies['Sticky'].id,{placementId:placedChild.id}]);
  assert.equal(copies['Read next'].from.placementId,placed.id);
  assert.equal(copies['Read next'].to.decorationId,copies['Native clipboard draft'].id);
  assert.deepEqual(onDestination.groups[0].placementIds,[placed.id]);
  assert.deepEqual(onDestination.groups[0].decorationIds,[copies['Grouped evidence'].id,copies['Read next'].id]);
  assert.equal(pasted.decorationIds.length,4);
  assert.deepEqual((await snapshot(boardId)).decorations,onSource.decorations);
  await page.locator('#viewport').focus();
  await commit('restoreMovement',()=>page.keyboard.press(`${mod}+z`));
  const undone = await snapshot(destination);
  assert.equal(undone.placements.length,0); assert.equal(undone.decorations.length,0); assert.equal(undone.groups?.length || 0,0);
  await commit('restoreMovement',()=>page.keyboard.press(`${mod}+Shift+z`));
  assert.deepEqual((await snapshot(destination)).decorations,onDestination.decorations);
  assert.deepEqual(errors,[]);
  console.log('Mixed clipboard passed: Text-only and cross-board copy/paste, native editor isolation, exact group/container/connector remaps, and one-step undo/redo.');
} finally {
  await browser?.close();
  if (started) await main(['stop','--config',configFile]);
  await rm(fixture,{recursive:true,force:true});
}
