// Clicked Inspector commands always run; board keys still yield to Inspector focus.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-inspector-'));let server,browser;
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Inspector fixture']);
 const config=await loadConfig(file),board=(await applyOperation(config,{type:'createBoard',title:'Inspector commands'})).result;
 const first=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'First idea'},placement:{x:0,y:0,width:320,height:260}})).result;
 await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Second idea'},placement:{x:400,y:0,width:320,height:260}});
 const active=async()=>(await getBoardSnapshot(config,board.boardId)).placements.filter(p=>!p.removedAt&&!p.deletedAt).length;
 server=await listen(config,{port:0});
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/operations'))writes.push(r.postDataJSON()?.type);});
 // Never touch the OS clipboard: execCommand('copy') dispatches a synthetic copy event and records its data.
 await page.addInitScript(()=>{
  window.qaCopies=[];const blocked=()=>{throw new Error('QA must not touch OS clipboard');};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:blocked,readText:blocked,write:blocked,writeText:blocked}});
  const exec=document.execCommand.bind(document);
  document.execCommand=(name,...args)=>{
   if(name!=='copy')return ['cut','paste'].includes(name)?blocked():exec(name,...args);
   const transfer=new DataTransfer(),event=new ClipboardEvent('copy',{clipboardData:transfer,bubbles:true,cancelable:true});
   (document.activeElement||document.body).dispatchEvent(event);
   window.qaCopies.push({prevented:event.defaultPrevented,types:[...transfer.types],text:transfer.getData('text/plain')});
   return true;
  };
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/boards/${board.boardId}/`);
 await page.locator('#workspace-copy').waitFor({state:'attached'});
 await page.waitForFunction(()=>document.querySelectorAll('.workspace-card[data-placement]').length===2);
 const card=page.locator(`.workspace-card[data-placement="${first.placementIds[0]}"]`);
 const selected=()=>page.locator('.workspace-card.selected').count();
 const openInspector=async()=>{if(await page.locator('#board-info').isHidden())await page.locator('#board-info-toggle').click();await page.locator('#board-info').waitFor();};
 // 1. Inspector → Keyboard shortcuts opens the sheet.
 await openInspector();
 await page.getByRole('button',{name:'Keyboard shortcuts',exact:true}).click();
 await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor();
 assert.match(await page.getByRole('dialog',{name:'Keyboard shortcuts'}).textContent(),/Duplicate selection/);
 await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor({state:'detached'});
 // 2. Inspector → Copy selection puts the selection on the clipboard without a graph write.
 await card.locator('[data-placement-select]').click();assert.equal(await selected(),1);
 await openInspector();assert.equal(await page.locator('#workspace-copy').isEnabled(),true);
 const before=writes.length;await page.locator('#workspace-copy').click();
 const copies=await page.evaluate(()=>window.qaCopies);
 assert.equal(copies.length,1);assert.equal(copies[0].prevented,true);
 assert.ok(copies[0].types.includes('application/x-tinka-placements+json'),JSON.stringify(copies[0].types));
 const envelope=JSON.parse(copies[0].text.slice(copies[0].text.indexOf('\n')+1));
 assert.equal(envelope.placements.length,1);assert.equal(envelope.placements[0].id,first.placementIds[0]);
 await page.locator('#workspace-toast').filter({hasText:'Copied 1 Tinka'}).waitFor();
 assert.equal(writes.length,before);
 // 3. Board keys pressed while focus sits on an Inspector button do not act on the board.
 const count=await active();
 await page.locator('#workspace-copy').focus();
 for(const key of ['Delete','Backspace','Meta+a','Control+a','Meta+d'])await page.keyboard.press(key);
 await page.waitForTimeout(400);
 assert.equal(await page.locator('#board-info').isVisible(),true);
 assert.equal(await selected(),1,'Select-all ignored while focus is in the Inspector');
 assert.equal(writes.length,before,'No removal or duplicate from Inspector focus');assert.equal(await active(),count);
 // 4. Inspector Undo is also an explicit command: undo a keyboard removal from the Inspector.
 await page.locator('#board-info-toggle').click();await page.locator('#board-info').waitFor({state:'hidden'});
 await page.locator('#viewport').focus();
 const removed=page.waitForResponse(r=>r.url().endsWith('/api/operations')&&r.request().postDataJSON()?.type==='remove'&&r.status()===200);
 await page.keyboard.press('Delete');await removed;assert.equal(await active(),count-1);
 await openInspector();await page.locator('#workspace-undo:not([disabled])').waitFor();
 const restored=page.waitForResponse(r=>r.url().endsWith('/api/operations')&&r.request().postDataJSON()?.type==='restoreMovement'&&r.status()===200);
 await page.locator('#workspace-undo').click();await restored;
 await page.waitForFunction(()=>document.querySelectorAll('.workspace-card[data-placement]').length===2);assert.equal(await active(),count);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:4,checks:['Inspector Keyboard shortcuts opens the sheet','Inspector Copy selection writes the clipboard envelope','Delete/Backspace/Select-all/Duplicate ignored with Inspector focus','Inspector Undo restores a removal']}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
