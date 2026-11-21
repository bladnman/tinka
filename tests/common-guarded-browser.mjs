// Common editors use the original displayed facts, even when other writes and
// reads advance the workspace. These checks enter through ordinary board controls.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
import {openItemDetails} from './tile-test-helpers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-common-guarded-'));
let server,browser;
try {
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Common saves']);
  const config=await loadConfig(configFile),op=async operation=>(await applyOperation(config,operation)).result;
  const P=(await op({type:'createBoard',title:'Common edits'})).boardId;
  const Q=(await op({type:'createBoard',title:'Independent board'})).boardId;
  const A=(await op({type:'createItem',boardId:P,item:{title:'First idea',description:'Original description'},placement:{x:0,y:0,width:280,height:220}})).itemId;
  await op({type:'createItem',boardId:P,item:{title:'Second idea'},placement:{x:340,y:0,width:280,height:220}});
  const read=()=>getBoardSnapshot(config,P),item=async()=>(await read()).items[A];
  server=createAppServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],requests=[];
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  let inject=null;
  await page.route('**/api/operations',async route=>{
    const request=route.request().postDataJSON();
    if(inject){const run=inject;inject=null;await run();}
    const response=await route.fetch();requests.push({request,status:response.status()});await route.fulfill({response});
  });
  const show=async()=>{await page.goto(`${url}/boards/${P}/`);await page.locator('.workspace-card').first().waitFor();};
  const edit=async()=>{const snap=await read(),placement=snap.placements.find(p=>p.itemId===A);await openItemDetails(page.locator(`[data-placement="${placement.id}"] [data-item-controls]`));await page.locator('[data-context-edit]').click();await page.getByRole('dialog',{name:'Edit item',exact:true}).waitFor();};
  await show();await edit();
  await page.locator('dialog [name=title]').fill('My title');
  inject=async()=>{await op({type:'updateItem',itemId:A,patch:{description:'New description from elsewhere'}});await op({type:'updateBoard',boardId:Q,patch:{description:'Other board edit'}});};
  await page.getByRole('button',{name:'Save item',exact:true}).click();
  await page.getByRole('dialog',{name:'Edit item',exact:true}).waitFor({state:'detached'});
  assert.equal((await item()).title,'My title');assert.equal((await item()).description,'New description from elsewhere');
  const titleSave=requests.at(-1).request;assert.equal(titleSave.type,'guarded');assert.equal(Object.hasOwn(titleSave,'expectedRevision'),false);assert.deepEqual(Object.keys(titleSave.operation.patch),['title']);
  await edit();await page.locator('[data-item-section=content]').click();await page.locator('dialog [name=kind][value=note]').check();await page.locator('dialog [name=text]').fill('A changed content group');
  inject=()=>op({type:'updateBoard',boardId:Q,patch:{description:'Independent content save'}});
  await page.getByRole('button',{name:'Save item',exact:true}).click();await page.getByRole('dialog',{name:'Edit item',exact:true}).waitFor({state:'detached'});
  assert.equal((await item()).content.text,'A changed content group');
  assert.deepEqual(requests.at(-1).request.baseline.facts.map(f=>f.field).sort(),['build','content','preview','revisions']);
  await edit();await page.locator('[data-item-section=content]').click();await page.locator('dialog [name=text]').fill('Retain changed group draft');
  inject=()=>op({type:'updateItem',itemId:A,patch:{preview:{text:'A peer preview'}}});
  await page.getByRole('button',{name:'Save item',exact:true}).click();await page.locator('dialog .workspace-form-status').getByText(/field changed elsewhere/).waitFor();
  assert.equal(await page.locator('dialog [name=text]').inputValue(),'Retain changed group draft');assert.equal((await item()).preview.text,'A peer preview');
  await page.locator('dialog .workspace-close').click();
  await edit();await page.locator('dialog [name=title]').fill('Keep this draft');
  await op({type:'updateItem',itemId:A,patch:{title:'Someone else title'}});
  // Advance the real page client's watermark through a fresh read while leaving
  // the original modal fields mounted. It must not authorize this old form.
  await page.evaluate(async()=>{
    const {WorkspaceClient}=await import('/app/workspace.js'),write=WorkspaceClient.prototype.write;
    WorkspaceClient.prototype.write=async function(...args){
      const current=await this.get('/api/workspace?view=header');this.revision=current.revision;
      WorkspaceClient.prototype.write=write;return write.apply(this,args);
    };
  });
  await page.getByRole('button',{name:'Save item',exact:true}).click();
  await page.locator('dialog .workspace-form-status').getByText(/field changed elsewhere/).waitFor();
  assert.equal(await page.locator('dialog [name=title]').inputValue(),'Keep this draft');assert.equal((await item()).title,'Someone else title');
  await page.locator('dialog .workspace-close').click();
  await show();await page.locator('#board-info-toggle').click();await page.getByRole('button',{name:'Comparison order…',exact:true}).click();
  const before=(await read()).reviewOrder;await page.locator('[data-down="0"]').click();
  inject=()=>op({type:'updateBoard',boardId:Q,patch:{description:'Another independent edit'}});
  await page.getByRole('button',{name:'Save order',exact:true}).click();await page.getByRole('dialog',{name:'Comparison order',exact:true}).waitFor({state:'detached'});
  assert.deepEqual((await read()).reviewOrder,[before[1],before[0]]);
  // Explicit note draft survives a reload with the baseline it originally saw.
  await show();let placement=(await read()).placements.find(p=>p.itemId===A);
  const openNote=async()=>{await page.locator(`[data-placement="${placement.id}"] [data-item-controls]`).click();await page.locator('[data-tile-menu=notes]').click();await page.locator('.tile-notes').waitFor();};
  await openNote();await page.locator('.tile-notes textarea').fill('Retained local draft');await page.keyboard.press('Escape');
  await op({type:'review',itemId:A,patch:{note:'Other note',star:true}});
  await show();await openNote();assert.equal(await page.locator('.tile-notes textarea').inputValue(),'Retained local draft');
  await page.locator('.tile-notes [type=submit]').click();await page.locator('.tile-notes [role=alert]').waitFor();
  assert.equal((await item()).review.note,'Other note');assert.equal((await item()).review.star,true);assert.equal(await page.locator('.tile-notes textarea').inputValue(),'Retained local draft');
  await page.locator('[data-note-cancel]').click();await page.locator('.tile-notes').waitFor({state:'detached'});await openNote();
  await page.locator('.tile-notes textarea').fill('Accepted local note');inject=()=>op({type:'updateBoard',boardId:Q,patch:{description:'Still independent'}});
  await page.locator('.tile-notes [type=submit]').click();await page.locator('.tile-notes').waitFor({state:'detached'});
  assert.equal((await item()).review.note,'Accepted local note');assert.equal((await item()).review.star,true);
  // Root status/message edits are scoped independently from append-only replies.
  const actor=await page.evaluate(()=>JSON.parse(localStorage.getItem([...Array(localStorage.length)].map((_,i)=>localStorage.key(i)).find(k=>k.endsWith('/feedback-actor')))));
  const T=(await op({type:'addComment',boardId:P,author:actor,body:'Original message'})).threadId;
  const openThread=async()=>{await page.goto(`${url}/boards/${P}/`);await page.goto(`${url}/boards/${P}/#comments/${T}`);await page.locator('.ct-card [data-act=edit]').first().waitFor();};
  await openThread();await page.locator('.ct-card [data-act=edit]').first().click();await page.locator('.ct-edit').fill('My message');
  inject=()=>op({type:'replyComment',threadId:T,author:{id:'agent-check',label:'Agent',kind:'agent'},body:'Independent reply'});
  await page.locator('[data-act=edit-save]').click();await page.locator('.ct-edit').waitFor({state:'detached'});assert.equal(await page.locator('.ct-body').first().textContent(),'My message');
  await page.locator('.ct-card [data-act=edit]').first().click();await page.locator('.ct-edit').fill('Keep message draft');
  inject=()=>op({type:'editComment',threadId:T,actor,body:'Changed message'});
  await page.locator('[data-act=edit-save]').click();await page.locator('.ct-status[role=alert]').waitFor();assert.equal(await page.locator('.ct-edit').textContent(),'Keep message draft');
  await page.locator('[data-act=edit-cancel]').click();await page.locator('[data-act=close]').click();await openThread();
  inject=()=>op({type:'updateBoard',boardId:Q,patch:{description:'Comment unrelated edit'}});
  await page.locator('.ct-card [data-act=toggle]').click();await page.locator('.ct-card [data-state=resolved]').waitFor();
  inject=()=>op({type:'setCommentStatus',threadId:T,actor,status:'sent',to:{kind:'agent'}});
  await page.locator('.ct-card [data-act=toggle]').click();await page.locator('.ct-status[role=alert]').waitFor();assert.equal(await page.locator('.ct-card .ct-state').textContent(),'Resolved');
  await page.locator('.ct-card [data-act=close]').click();await show();
  await openItemDetails(page.locator(`[data-placement="${placement.id}"] [data-item-controls]`));
  inject=()=>op({type:'review',itemId:A,patch:{star:false}});
  await page.locator('#workspace-item-controls textarea').fill('Autosaved note');
  await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent?.includes('saved on this Mac'));
  assert.equal((await item()).review.note,'Autosaved note');assert.equal((await item()).review.star,false);
  inject=()=>op({type:'review',itemId:A,patch:{note:'Remote autosave conflict'}});
  await page.locator('#workspace-item-controls textarea').fill('Unsaved autosave draft');
  await page.getByRole('dialog',{name:'Change not saved',exact:true}).waitFor();
  assert.equal((await item()).review.note,'Remote autosave conflict');
  await show();
  await page.locator('#board-info-toggle').click();await page.locator('#workspace-retry-drafts').click();
  await page.getByRole('dialog',{name:'Change not saved',exact:true}).waitFor();
  assert.equal((await item()).review.note,'Remote autosave conflict');
  const retained=await page.evaluate(()=>{
    const key=[...Array(localStorage.length)].map((_,i)=>localStorage.key(i)).find(k=>k.endsWith('/item-review-drafts'));
    return {patch:JSON.parse(localStorage.getItem(key)),baseline:JSON.parse(localStorage.getItem(`${key}/baselines`))};
  });
  assert.equal(retained.patch[A].note,'Unsaved autosave draft');assert.equal(retained.baseline[A].note,'Autosaved note');
  const conflict=page.getByRole('dialog',{name:'Change not saved',exact:true});
  await conflict.getByRole('button',{name:'Keep draft',exact:true}).click();await conflict.waitFor({state:'detached'});
  await page.locator('#workspace-retry-drafts').click();await conflict.waitFor();
  await page.route(`**/api/boards/${P}`,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary read failure; draft retained'})}),{times:1});
  await conflict.getByRole('button',{name:'Discard this draft and load latest',exact:true}).click();
  await conflict.locator('.workspace-form-status').getByText(/Temporary read failure/).waitFor();
  assert.equal(await conflict.locator('textarea').inputValue(),'Unsaved autosave draft');
  await conflict.getByRole('button',{name:'Discard this draft and load latest',exact:true}).click();await conflict.waitFor({state:'detached'});
  await openItemDetails(page.locator(`[data-placement="${placement.id}"] [data-item-controls]`));
  assert.equal(await page.locator('#workspace-item-controls textarea').inputValue(),'Remote autosave conflict');assert.equal((await item()).review.note,'Remote autosave conflict');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({pass:true,checks:['title-only save preserves remote description','changed content sends complete group facts; concurrent preview conflicts','true title conflict retains form','comparison order accepts unrelated board','restored note retains original baseline','note-only save preserves star','advanced client watermark cannot authorize stale form','comment edit preserves independent reply','comment conflict retains editor','thread status accepts unrelated edit and rejects status race','autosave accepts independent star and preserves it','restored autosave draft keeps original baseline and rejects overwrite','keep draft and failed discard-read retain text; explicit discard loads latest'],requests:requests.map(r=>({type:r.request.operation?.type||r.request.type,status:r.status}))},null,2));
} finally {await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true});}
