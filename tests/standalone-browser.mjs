// Headless checks for "Where it lives" and "Back to Tinka": the opened-Tinka
// Inspector shows the location card (Open standalone's address, the absolute
// file path copied by Copy path, the boards that show the file), hides Vote
// until someone votes (on the tile too), and uses the segmented Appearance;
// a standalone page opened top-level shows the mark, hovering names the Tinka
// and a click returns to it; inside Tinka's frame there is no mark. The test
// never touches the OS clipboard (navigator.clipboard is stubbed) and forces
// the mark's closed shadow root open only so it can look inside.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-standalone-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-standalone-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser,checks=0;const errors=[];
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const eq=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Standalone studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
 await writeFile(path.join(assets,'calm.html'),'<!doctype html><meta charset="utf-8"><title>Calm form</title><style>body{margin:0;min-height:100vh;display:grid;place-content:center;font:28px system-ui;background:#f4f1e6;color:#30382a}</style><body><h1>Calm form</h1><p>Studio name, digest and review day.</p></body>');
 await writeFile(path.join(assets,'bold.html'),'<!doctype html><meta charset="utf-8"><h1>Bold</h1>');
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 await op('createBoard',{id:'studio',title:'Demo Studio'});
 await op('createBoard',{id:'lab',title:'Design Lab',parentBoardId:'studio'});
 await op('createBoard',{id:'library',title:'Content Library'});
 const html=p=>({kind:'html',resource:{rootId:'assets',path:p}});
 const place=i=>({x:i*780,y:0,width:720,height:560,presentation:{mode:'panel',viewport:{width:1000,height:720}}});
 const calm=await op('createItem',{boardId:'lab',item:{title:'Calm form',number:'01',description:'A warm one-page form.',content:html('calm.html')},placement:place(0)});
 const bold=await op('createItem',{boardId:'lab',item:{title:'Bold form',number:'02',content:html('bold.html')},placement:place(1)});
 await op('vote',{itemId:bold.itemId,actor:{id:'agent-reviewer',label:'Reviewer',kind:'agent'},value:'yes'});
 await op('createItem',{boardId:'library',item:{title:'Calm settings',content:html('calm.html')},placement:place(0)});
 const filePath=await realpath(path.join(assets,'calm.html'));
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1244,height:860},colorScheme:'light',reducedMotion:'reduce'});
 await context.addInitScript(()=>{
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;},readText:async()=>window.__copied||''}});
  const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){return attach.call(this,{...init,mode:'open'});};
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});

 // (1) The board: Vote shows on a tile only once the item has votes.
 await page.goto(`${base}/boards/lab/`);await page.locator(`[data-placement="${calm.placementIds[0]}"]`).waitFor();
 await page.locator(`[data-placement="${calm.placementIds[0]}"]`).hover();ok(await page.locator(`[data-placement="${calm.placementIds[0]}"] .workspace-tool-open`).isVisible(),'The hover bar shows');
 eq(await page.locator(`[data-item-vote="${calm.itemId}"]`).evaluate(b=>[b.hidden,getComputedStyle(b).display]),[true,'none'],'No votes: the tile hover bar has no Vote');
 await page.locator(`[data-placement="${bold.placementIds[0]}"]`).hover();
 ok(await page.locator(`[data-item-vote="${bold.itemId}"]`).isVisible(),'Voted on: the tile hover bar shows Vote');

 // (2) The opened Tinka's Inspector.
 await page.goto(`${base}/boards/lab/#items/${calm.placementIds[0]}`);await page.locator('#reader-dialog[open]').waitFor();
 eq(await page.locator('#reader-star').getAttribute('title'),'Favorite','The header ☆ says Favorite');
 await page.locator('#reader-info-toggle').click();const info=page.locator('#reader-info');await info.waitFor({state:'visible'});
 ok(await info.getByRole('heading',{name:'Where it lives'}).isVisible(),'Where it lives comes first');
 const standalone=info.getByRole('link',{name:'Open standalone ↗'});
 eq(await standalone.getAttribute('href'),'/resources/assets/calm.html','Open standalone opens the file served by Tinka');
 eq(await standalone.getAttribute('target'),'_blank');
 await page.waitForFunction(p=>document.querySelector('#reader-file-path')?.textContent===p,filePath);checks++;
 await info.getByRole('button',{name:'Copy path'}).click();
 eq(await page.evaluate(()=>window.__copied),filePath,'Copy path puts the absolute path on the clipboard');
 await info.getByRole('button',{name:'Copy link'}).click();
 eq(await page.evaluate(()=>window.__copied),`${base}/resources/assets/calm.html`,'Copy link copies the standalone address');
 const boards=await info.locator('.reader-where-boards button').evaluateAll(bs=>bs.map(b=>b.textContent));
 eq(boards.sort(),['Content Libraryas “Calm settings”','Design Labhere'],'On boards lists every placement that uses the file');
 for(const gone of ['Favorite','Notes','Reload','Add reference…','Show on parent…'])eq(await info.getByRole('button',{name:gone,exact:true}).count(),0,`${gone} is not in the pruned list`);
 eq(await info.locator('[data-reader-act="vote"]:not(#reader-more *)').count(),0,'No votes: no Vote row');
 ok(await info.getByRole('button',{name:/^Comments/}).isVisible(),'Comments stays');
 await page.screenshot({path:path.join(evidence,'standalone-inspector-1244.png')});
 await info.getByRole('button',{name:'More…'}).click();const more=page.locator('#reader-more');await more.waitFor({state:'visible'});
 for(const label of ['Add board…','Edit details…','Move to another board…','Also show on another board…','Feature on Demo Studio…','Vote…','Copy for an agent','Reload content','Keyboard shortcuts'])ok(await more.getByRole('menuitem',{name:new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`)}).isVisible(),`More offers ${label}`);
 await page.screenshot({path:path.join(evidence,'standalone-inspector-more-1244.png')});
 await more.getByRole('menuitem',{name:/^Copy for an agent/}).click();
 eq(await page.evaluate(()=>window.__copied),`Calm form: ${filePath}`,'Copy for an agent copies its name and path');
 ok(await more.isHidden(),'Choosing an item closes More');
 const seg=info.getByRole('group',{name:'Appearance'});
 eq(await seg.getByRole('button').allTextContents(),['System','Light','Dark'],'Appearance is a segmented control');
 eq(await info.locator('select').count(),0,'No native select in the Inspector');
 await seg.getByRole('button',{name:'Dark'}).click();
 eq(await page.locator('html').getAttribute('data-appearance'),'dark');eq(await seg.getByRole('button',{name:'Dark'}).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:path.join(evidence,'standalone-inspector-1244-dark.png')});
 await seg.getByRole('button',{name:'Light'}).click();eq(await page.locator('html').getAttribute('data-appearance'),'light');
 // Inside Tinka's frame the page is untouched: no tag, no mark.
 const frame=page.frames().find(f=>f.url().includes('/resources/assets/calm.html'));ok(frame,'The opened Tinka frames the file');
 eq(await frame.evaluate(()=>[!!document.querySelector('tinka-return'),!!document.querySelector('script[src="/app/return-mark.js"]')]),[false,false],'No mark inside Tinka\'s frame');

 // (3) The same file opened standalone, top-level.
 const tab=await context.newPage();tab.on('pageerror',e=>errors.push(e.message));
 await tab.goto(`${base}/resources/assets/calm.html`);
 const chip=tab.locator('tinka-return .chip');await chip.waitFor();
 await tab.waitForFunction(()=>document.querySelector('tinka-return')?.shadowRoot?.querySelector('.chip small')?.textContent.includes('Design Lab'));checks++;
 eq(await tab.locator('tinka-return').evaluate(el=>getComputedStyle(el).position),'fixed');
 await tab.screenshot({path:path.join(evidence,'standalone-mark-rest-1244.png')});
 await chip.hover();await tab.waitForTimeout(260);
 eq((await chip.textContent()).trim(),'Back to Tinka01 · Calm form · Design Lab','Hover names the Tinka and its board');
 ok((await chip.boundingBox()).width>150,'Hover widens the mark');
 await tab.screenshot({path:path.join(evidence,'standalone-mark-hover-1244.png')});
 await tab.locator('tinka-return .more').click();
 ok(await tab.locator('tinka-return .card').isVisible(),'⋯ opens the menu');
 eq(await tab.locator('tinka-return .card .row').count(),2,'The menu lists the other places that show the file');
 await tab.screenshot({path:path.join(evidence,'standalone-mark-menu-1244.png')});
 await tab.keyboard.press('Escape');
 await chip.click();await tab.waitForURL(`${base}/boards/lab/#items/${calm.placementIds[0]}`);await tab.locator('#reader-dialog[open]').waitFor();
 eq(await tab.locator('#reader-name').textContent(),'Calm form','A click returns to the opened Tinka');

 // (4) No last-opened record and several places: the mark asks.
 const fresh=await browser.newContext({viewport:{width:1244,height:860}});await fresh.addInitScript(()=>{const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){return attach.call(this,{...init,mode:'open'});};});
 const ask=await fresh.newPage();await ask.goto(`${base}/resources/assets/calm.html`);
 await ask.waitForFunction(()=>document.querySelector('tinka-return')?.shadowRoot?.querySelector('.chip small')?.textContent.includes('choose'));checks++;
 await ask.locator('tinka-return .chip').click();ok(await ask.locator('tinka-return .card').isVisible(),'Several places and none opened here: the chip opens the chooser');
 eq(ask.url(),`${base}/resources/assets/calm.html`,'…without navigating');
 // Opt-out and Hide.
 await ask.goto(`${base}/resources/assets/calm.html?tinka=off`);await ask.waitForTimeout(150);eq(await ask.locator('tinka-return').count(),0,'?tinka=off shows no mark');
 await ask.goto(`${base}/resources/assets/calm.html`);await ask.locator('tinka-return .chip').hover();await ask.locator('tinka-return .more').click();await ask.locator('tinka-return [data-hide]').click();
 eq(await ask.locator('tinka-return').count(),0,'Hide removes the mark');
 await ask.reload();await ask.waitForTimeout(150);eq(await ask.locator('tinka-return').count(),0,'…for the rest of the tab');
 await fresh.close();
 eq(errors,[],'No page errors');
 console.log(JSON.stringify({passed:true,checks,evidence}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
