// Scoped native keyboard behavior without user boards or operating-system clipboard.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<button id="next">Next action</button><form id="editor"><textarea name="note"></textarea><button type="submit">Save</button><p data-form-status></p></form>');return;}
  if(!['/interaction.js','/workspace.js'].includes(req.url)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../public'+req.url,import.meta.url)));
 }catch{res.writeHead(500);res.end();}
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(async()=>{
  const {bindForm}=await import('/interaction.js');window.saves=[];window.fail=false;
  window.binding=bindForm(document.querySelector('form'),{submit:async data=>{saves.push(data.get('note'));await new Promise(resolve=>window.releaseSave=resolve);if(window.fail)throw Error('Unavailable; draft retained.');},onError:error=>document.querySelector('[data-form-status]').textContent=error.message});
 });
 const note=page.locator('textarea');await note.fill('First');await page.keyboard.press('Enter');await page.keyboard.type('Second');assert.equal(await note.inputValue(),'First\nSecond');assert.equal(await page.evaluate(()=>saves.length),0);
 await page.keyboard.press('Meta+Enter');await page.waitForFunction(()=>saves.length===1);assert.equal(await page.locator('[type=submit]').isDisabled(),true);
 await page.keyboard.press('Control+Enter');await page.locator('form').evaluate(form=>form.requestSubmit());assert.equal(await page.evaluate(()=>saves.length),1);
 await page.evaluate(()=>releaseSave());await page.waitForFunction(()=>!binding.pending);
 await note.fill('');await page.keyboard.press('Control+Enter');await page.waitForFunction(()=>saves.length===2);assert.equal(await page.evaluate(()=>saves[1]),'');await page.evaluate(()=>releaseSave());await page.waitForFunction(()=>!binding.pending);
 await note.fill('IME draft');await note.dispatchEvent('compositionstart');await page.keyboard.press('Meta+Enter');assert.equal(await page.evaluate(()=>saves.length),2);await note.dispatchEvent('compositionend');
 await note.dispatchEvent('keydown',{key:'Enter',metaKey:true,repeat:true,bubbles:true});await note.dispatchEvent('keydown',{key:'Enter',ctrlKey:true,keyCode:229,bubbles:true});assert.equal(await page.evaluate(()=>saves.length),2);
 await page.evaluate(()=>window.fail=true);await page.keyboard.press('Meta+Enter');await page.waitForFunction(()=>saves.length===3);await page.locator('#next').click();await page.evaluate(()=>releaseSave());await page.waitForFunction(()=>!binding.pending);assert.equal(await note.inputValue(),'IME draft');assert.equal(await page.evaluate(()=>document.activeElement.id),'next');assert.match(await page.locator('[data-form-status]').textContent(),/draft retained/);
 // Generic dialogs route keyboard/button through one native form path and preserve failed values.
 await page.evaluate(async()=>{
  const {makeDialog}=await import('/workspace.js');window.dialogSaves=0;window.dialogFail=true;
  window.dialog=makeDialog('Edit note','<textarea name="note">Keep draft</textarea><button type="submit">Save</button>',async data=>{dialogSaves++;if(dialogFail)throw Error('Retry this draft.');window.savedDialogNote=data.get('note');});
 });
 await page.locator('dialog textarea').focus();await page.keyboard.press('Meta+Enter');await page.waitForFunction(()=>dialogSaves===1);assert.equal(await page.locator('dialog').evaluate(d=>d.open),true);assert.equal(await page.locator('dialog textarea').inputValue(),'Keep draft');
 await page.evaluate(()=>dialogFail=false);await page.locator('dialog textarea').fill('');await page.keyboard.press('Control+Enter');await page.locator('dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>savedDialogNote),'');assert.equal(await page.evaluate(()=>document.activeElement.id),'next');
 await page.evaluate(async()=>{binding.destroy();window.flushes=[];const {bindCommitShortcut}=await import('/interaction.js');bindCommitShortcut(document.querySelector('#editor textarea'),{commit:()=>flushes.push(document.querySelector('#editor textarea').value)});});
 await note.focus();await note.fill('Composing');await note.dispatchEvent('compositionstart');await page.keyboard.press('Meta+Enter');assert.equal(await page.evaluate(()=>flushes.length),0);await note.dispatchEvent('compositionend');await note.dispatchEvent('keydown',{key:'Enter',ctrlKey:true,repeat:true,bubbles:true});assert.equal(await page.evaluate(()=>flushes.length),0);
 await note.fill('');await page.keyboard.press('Control+Enter');assert.deepEqual(await page.evaluate(()=>flushes),['']);
 console.log(JSON.stringify({passed:9,checks:['multiline Enter','one pending submit','valid empty note clear','IME and held keys','failed draft and intended focus','generic dialog failure','generic dialog keyboard save and focus','autosaved note IME and repeat','autosaved valid empty flush']}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
