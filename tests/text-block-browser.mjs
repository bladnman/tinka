// Board-local Text: edit, preview, save, recover a rejected save, and toggle a
// checklist. The fixture is external; no real boards or linked files are used.
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
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-text-block-'));
const id='native-text', boardId='outline', errors=[];
const original='# Opening\r\nA long paragraph that wraps in a narrower block and keeps its complete text.\r\n\r\n- [ ] Sketch the opening\r\n- [x] Write the outline';
let server,browser;
const until=async test=>{
  for(let attempt=0;attempt<60;attempt++){if(await test())return;await new Promise(resolve=>setTimeout(resolve,80));}
  assert.fail('Expected board state did not settle.');
};
try {
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Native Text']);
  const config=await loadConfig(configFile);
  await applyOperation(config,{type:'createBoard',id:boardId,title:'Outline'});
  await applyOperation(config,{type:'createDecoration',boardId,decoration:{id,type:'text',text:original,color:'#38522c',x:30,y:30,width:330,height:300}});
  // A region added after Text cannot intercept its visible task buttons.
  await applyOperation(config,{type:'createDecoration',boardId,decoration:{id:'area',type:'region',text:'',color:'#353a31',x:10,y:10,width:370,height:340}});
  const read=async()=>{const board=await getBoardSnapshot(config,boardId);assert.deepEqual(board.placements,[]);return board.decorations.find(d=>d.id===id);};
  server=createAppServer(config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/boards/${boardId}/`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark',reducedMotion:'reduce'});
  await context.addInitScript(()=>localStorage.setItem('tinka/appearance','dark'));
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);
  const block=page.locator(`[data-decoration="${id}"]`), label=block.locator('[data-decoration-label]');
  const toolbar=page.locator('.whiteboard-toolbar');
  const field=page.getByRole('textbox',{name:'Text block',exact:true});
  await block.getByRole('heading',{name:'Opening'}).waitFor();
  const measured=await block.evaluate(el=>{
    const body=el.querySelector('.deco-line'), style=getComputedStyle(el), [r,g,b]=style.color.match(/\d+/g).map(Number);
    const linear=v=>v/255<=.04045?v/255/12.92:((v/255+.055)/1.055)**2.4;
    const luminance=rgb=>rgb.reduce((sum,c,i)=>sum+linear(c)*[.2126,.7152,.0722][i],0);
    return {style:getComputedStyle(body).fontStyle,lines:body.offsetHeight/parseFloat(getComputedStyle(body).lineHeight),
      contrast:(luminance([r,g,b])+.05)/(luminance([43,44,41])+.05)};
  });
  assert.ok(measured.contrast>=4.5&&measured.lines>=2&&measured.style==='normal',JSON.stringify(measured));
  const first=block.getByRole('checkbox',{name:'Sketch the opening'});
  await first.click();
  const toggled=original.replace('[ ]','[x]');
  await until(async()=>(await read()).text===toggled);
  await until(async()=>await first.getAttribute('aria-checked')==='true');
  await until(async()=>await block.getAttribute('aria-busy')!=='true');
  await first.focus();await page.keyboard.press('Space');
  await until(async()=>(await read()).text===original);
  await until(async()=>await first.getAttribute('aria-checked')==='false');
  await until(async()=>await block.getAttribute('aria-busy')!=='true');
  assert.deepEqual(await read(),{id,type:'text',text:original,color:'#38522c',x:30,y:30,width:330,height:300});

  await label.getByRole('heading',{name:'Opening'}).dblclick();
  await field.waitFor();await toolbar.getByRole('button',{name:'Done'}).click();
  await field.waitFor({state:'detached'});
  assert.equal((await read()).text,original,'unchanged edit preserves exact raw source');
  await label.getByRole('heading',{name:'Opening'}).dblclick();
  await field.fill('Outline\n\nThe final paragraph.\n\n- [ ] Write the ending');
  await field.evaluate(el=>el.setSelectionRange(0,7));
  await field.press('Tab');
  assert.ok(await toolbar.getByRole('button',{name:'Heading'}).evaluate(el=>el===document.activeElement),'formatting is keyboard reachable');
  await page.keyboard.press('Enter');
  await toolbar.getByRole('button',{name:'Preview text'}).click();
  await page.getByRole('region',{name:'Text preview'}).getByRole('heading',{name:'Outline'}).waitFor();
  await toolbar.getByRole('button',{name:'Continue editing'}).click();
  assert.ok(await field.evaluate(el=>el===document.activeElement),'editing gets keyboard focus back');
  await toolbar.getByRole('button',{name:'Preview text'}).click();
  await page.keyboard.press('Control+Enter');
  const revised='# Outline\n\nThe final paragraph.\n\n- [ ] Write the ending';
  await until(async()=>(await read()).text===revised);
  await label.getByRole('heading',{name:'Outline'}).waitFor();

  await label.getByRole('heading',{name:'Outline'}).dblclick();
  await field.fill('Discard this edit');
  await toolbar.getByRole('button',{name:'Cancel'}).click();
  assert.equal((await read()).text,revised);
  await label.getByRole('heading',{name:'Outline'}).dblclick();
  await field.fill('# Kept for retry');
  await page.route('**/api/operations',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Test rejection"}'}),{times:1});
  await toolbar.getByRole('button',{name:'Done'}).click();
  await block.getByText('Text not saved',{exact:true}).waitFor();
  assert.equal((await read()).text,revised);
  await block.getByRole('button',{name:'Retry'}).click();
  await until(async()=>(await read()).text==='# Kept for retry');
  await label.getByRole('heading',{name:'Kept for retry'}).waitFor();

  await page.setViewportSize({width:390,height:760});
  await block.getByRole('heading',{name:'Kept for retry'}).dblclick();
  const bar=await toolbar.boundingBox();
  assert.ok(bar&&bar.x>=0&&bar.x+bar.width<=390,'formatting bar fits narrow viewport');
  await field.press('Escape');

  const overview=await context.newPage();
  const draftKey=await page.evaluate(async()=>`tinka/${(await (await fetch('/api/config')).json()).workspaceId}/whiteboard-drafts/outline`);
  await overview.addInitScript(({draftKey,id})=>localStorage.setItem(draftKey,JSON.stringify({[id]:{text:'Private draft',nativeText:true,error:'Failed'}})),{draftKey,id});
  const overviewWrites=[];
  overview.on('request',request=>{if(request.method()!=='GET')overviewWrites.push(request.url());});
  await overview.goto(url+'?overview');
  await overview.getByRole('heading',{name:'Kept for retry'}).waitFor();
  assert.equal(await overview.getByText('Private draft',{exact:true}).count(),0);
  assert.equal(await overview.getByRole('button',{name:'Retry',exact:true}).count(),0);
  await overview.keyboard.press('Control+a');
  await overview.keyboard.press('Delete');
  assert.equal((await read()).text,'# Kept for retry');
  assert.deepEqual(overviewWrites,[]);
  await overview.close();await page.evaluate(key=>localStorage.removeItem(key),draftKey);

  await page.setViewportSize({width:1280,height:900});
  await label.getByRole('heading',{name:'Kept for retry'}).dblclick();
  await field.fill('# Recover from a deletion');
  await applyOperation(config,{type:'removeDecoration',boardId,decorationId:id});
  await field.press('Control+Enter');
  await block.waitFor({state:'detached'});
  await page.locator('#board-info-toggle').click();
  await page.getByRole('button',{name:'Recover unsaved text'}).click();
  assert.equal(await page.getByRole('textbox',{name:'Your text'}).inputValue(),'# Recover from a deletion');
  assert.deepEqual(errors,[]);
  console.log('Native Text: hierarchy, wrapped body, contrast, exact task toggles, inline editing, draft recovery and narrow toolbar passed.');
} finally {
  await browser?.close();
  if(server)await closeAppServer(server);
  await rm(fixture,{recursive:true,force:true});
}
