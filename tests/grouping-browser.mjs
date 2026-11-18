import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(tmpdir(),'tinka-grouping-'));
let browser,server;
try {
  const configPath=path.join(fixture,'local/config.json');
  await main(['init','--config',configPath,'--boards',path.join(fixture,'boards'),'--label','Grouping fixture']);
  await main(['workspace','init','--apply','--config',configPath]);
  const config=await loadConfig(configPath);
  const op=async (type,data)=>(await applyOperation(config,{type,...data})).result;
  const {boardId}=await op('createBoard',{title:'Canvas groups'});
  const card=async (title,x)=>(await op('createItem',{boardId,item:{title},placement:{x,y:100,width:260,height:180}})).placementIds[0];
  const first=await card('A Tinka',100),second=await card('Another Tinka',760);
  for (const decoration of [
    {id:'caption',type:'text',x:410,y:100,width:225,height:90,text:'A text block',color:'#456139'},
    {id:'inside',type:'text',x:430,y:350,width:225,height:90,text:'Container text',color:'#456139'},
    {id:'holder',type:'region',x:410,y:325,width:259,height:144,text:'A container',color:'#dbe5d3',container:{layout:'vertical',children:['inside']}},
    {id:'spare',type:'region',shape:'rectangle',x:790,y:365,width:160,height:100,text:'A shape',color:'#dbe5d3'},
  ]) await op('createDecoration',{boardId,decoration});
  const snapshot=()=>getBoardSnapshot(config,boardId);
  const original=await snapshot();

  server=createAppServer(config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(6500);
  const open=()=>page.goto(`${base}/boards/${boardId}/`);
  const tile=id=>page.locator(`#world .workspace-card[data-placement="${id}"]`);
  const draw=id=>page.locator(`#world [data-decoration="${id}"]`);
  const selectionBar=page.locator('#workspace-selection');
  const groupButton=selectionBar.locator('[data-bulk="canvas-group"]');
  const drawingGroup=page.locator('[data-whiteboard-action="canvas-group"]');
  const center=async element=>{
    const box=await element.boundingBox();
    return {x:box.x+box.width/2,y:box.y+box.height/2};
  };
  const action=async(type,run)=>{
    const pending=page.waitForResponse(response=>response.url()===base+'/api/operations'&&
      response.request().method()==='POST'&&response.request().postDataJSON()?.type===type);
    await run();
    const response=await pending,body=await response.json();
    assert.equal(response.status(),200,JSON.stringify(body));
    assert.ok(body.history);
    return body.result;
  };
  await open();
  await tile(first).waitFor();
  await page.locator('#fit').click();
  const mod=await page.evaluate(()=>/mac/i.test(navigator.userAgentData?.platform||navigator.platform))?'Meta':'Control';

  await tile(first).locator('[data-placement-select]').evaluate(el=>el.click());
  await draw('caption').click({modifiers:['Shift']});
  await draw('holder').locator('[data-decoration-label]').click({modifiers:['Shift']});
  await groupButton.getByText('Group',{exact:true}).waitFor();
  const group=await action('groupOccurrences',()=>page.keyboard.press(`${mod}+g`));
  await groupButton.getByText('Ungroup',{exact:true}).waitFor();
  assert.deepEqual(new Set(group.decorationIds),new Set(['caption','holder']));
  assert.deepEqual(group.placementIds,[first]);
  const grouped=await snapshot();
  assert.deepEqual(grouped.placements,original.placements);
  assert.deepEqual(grouped.decorations,original.decorations);
  assert.deepEqual(grouped.groups,[{id:group.groupId,placementIds:group.placementIds,decorationIds:group.decorationIds}]);

  await open();
  await tile(first).waitFor();
  await page.locator('#fit').click();
  await tile(first).locator('.workspace-preview-launch').click();
  await groupButton.getByText('Ungroup',{exact:true}).waitFor();
  assert.equal(await draw('caption').evaluate(el=>el.classList.contains('selected')),true);
  assert.equal(await draw('holder').evaluate(el=>el.classList.contains('selected')),true);
  assert.equal(await tile(second).evaluate(el=>el.classList.contains('selected')),false);

  await page.locator('#viewport').focus();
  await action('translatePlacements',()=>page.keyboard.press('Shift+ArrowRight'));
  const moved=await snapshot();
  assert.equal(moved.placements.find(p=>p.id===first).x,110);
  assert.equal(moved.decorations.find(d=>d.id==='caption').x,420);
  assert.equal(moved.decorations.find(d=>d.id==='holder').x,420);
  assert.equal(moved.decorations.find(d=>d.id==='inside').x,grouped.decorations.find(d=>d.id==='inside').x+10);
  assert.deepEqual(moved.groups,grouped.groups);
  await action('restoreMovement',()=>page.keyboard.press(`${mod}+z`));
  await groupButton.getByText('Ungroup',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#chrome-redo').disabled);

  const start=await center(draw('caption'));
  await page.mouse.move(start.x,start.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.keyboard.up('Alt');
  await page.mouse.move(start.x+142,start.y+155,{steps:5});
  assert.equal(await page.locator('.workspace-copy-ghost').count(),4);
  const copies=await action('duplicateOccurrences',()=>page.mouse.up());
  const [copyId]=copies.placementIds;
  await tile(copyId).waitFor();
  const copied=await snapshot(),clone=copied.groups.find(g=>g.id!==group.groupId);
  assert.deepEqual(clone.placementIds,[copyId]);
  assert.equal(clone.decorationIds.length,2);
  assert.equal(copies.decorationIds.length,3);
  assert.equal(copied.placements.find(p=>p.id===first).itemId,copied.placements.find(p=>p.id===copyId).itemId);
  await action('restoreMovement',()=>page.keyboard.press(`${mod}+z`));
  await tile(copyId).waitFor({state:'detached'});

  await tile(first).locator('.workspace-preview-launch').click();
  await groupButton.getByText('Ungroup',{exact:true}).waitFor();
  await action('ungroupOccurrences',()=>groupButton.click());
  await groupButton.getByText('Group',{exact:true}).waitFor();
  const ungrouped=await snapshot();
  assert.equal(ungrouped.groups,undefined);
  assert.deepEqual(ungrouped.placements,original.placements);
  assert.deepEqual(ungrouped.decorations,original.decorations);

  await page.keyboard.press('Escape');
  await draw('caption').click({modifiers:['Shift']});
  await draw('spare').click({modifiers:['Shift']});
  await drawingGroup.getByText('Group',{exact:true}).waitFor();
  await action('groupOccurrences',()=>drawingGroup.click());
  await drawingGroup.getByText('Ungroup',{exact:true}).waitFor();
  await action('ungroupOccurrences',()=>page.keyboard.press(`${mod}+g`));
  await drawingGroup.getByText('Group',{exact:true}).waitFor();

  await draw('caption').dblclick();
  await page.locator('.whiteboard-editor textarea').waitFor();
  const beforeEdit=await snapshot();
  await page.keyboard.press(`${mod}+g`);
  assert.deepEqual((await snapshot()).groups,beforeEdit.groups);
  assert.equal(await page.locator('.whiteboard-editor textarea').count(),1);
  assert.deepEqual(errors,[]);
  console.log('Grouping passed: mixed selection, geometry, reload, nudge, container children, Option-copy, undo, native toolbar and editor guard.');
} finally {
  await browser?.close();
  if(server)await closeAppServer(server);
  await rm(fixture,{recursive:true,force:true});
}
