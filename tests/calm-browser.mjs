import {openItemDetails} from './tile-test-helpers.mjs';
// Headless checks for the calm board chrome: one green, side panels with
// click-away/Escape, selection without checkboxes, the view pill and the
// browser-local Dots/Grid/Plain preference. External temporary fixtures only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-calm-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-calm-evidence-'));await mkdir(evidence,{recursive:true});
let server,browser;const errors=[];
try{
 const file=path.join(root,'config.json');await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Calm studio']);const config=await loadConfig(file);
 const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
 await op('createBoard',{id:'studio',title:'Onboarding studies'});
 const a=(await op('createItem',{boardId:'studio',item:{title:'Quiet onboarding',content:{kind:'note',text:'Take your time.'}},placement:{x:40,y:60,width:320,height:260}})).placementIds[0];
 const b=(await op('createItem',{boardId:'studio',item:{title:'Bold onboarding',content:{kind:'note',text:'Start now.'}},placement:{x:420,y:60,width:320,height:260}})).placementIds[0];
 await op('createBoard',{id:'ideas',title:'Ideas',parentBoardId:'studio'});
 await op('createItem',{boardId:'ideas',item:{title:'A loose thought'}});
 const before=await getBoardSnapshot(config,'studio');
 server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:900},colorScheme:'light'});page.on('pageerror',e=>errors.push(e.message));
 const card=id=>page.locator(`[data-placement="${id}"]`);
 const blank=()=>page.evaluate(()=>{const v=document.querySelector('#viewport').getBoundingClientRect();for(let y=v.top+30;y<v.bottom-90;y+=20)for(let x=v.left+30;x<v.left+v.width/2;x+=20){const el=document.elementFromPoint(x,y);if(el&&el.matches('#viewport,#plane,#world'))return {x,y};}return null;});
 const clickBlank=async()=>{const p=await blank();await page.mouse.click(p.x,p.y);};
 await page.goto(base+'/boards/studio/');await card(a).waitFor();
 if(await page.locator('[data-mode="canvas"]').getAttribute('aria-pressed')!=='true'){await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.keyboard.press('Escape');}
 await page.locator('#fit').click();
 // Left is where (Navigator), right is what (Inspector, then the single primary Add).
 const order=await page.locator('#canvas-header').evaluate(el=>[...el.querySelectorAll('#project-navigator-toggle,.brand,#chrome-search,#board-info-toggle,#workspace-add')].map(n=>n.id||'brand'));
 assert.deepEqual(order,['project-navigator-toggle','brand','chrome-search','board-info-toggle','workspace-add']);
 assert.equal(await page.locator('#workspace-add').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(83, 96, 68)');
 // Board Inspector: click-away and Escape both dismiss it.
 await page.locator('#board-info-toggle').click();await page.locator('#board-info').waitFor();
 const panel=await page.locator('#board-info').boundingBox();assert.ok(panel.x+panel.width>1440-12&&panel.x>1440/2,'Board Inspector opens on the right');
 await clickBlank();assert.equal(await page.locator('#board-info').isVisible(),false,'Click-away closes the board Inspector');
 await page.locator('#board-info-toggle').click();await page.keyboard.press('Escape');
 assert.equal(await page.locator('#board-info').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'board-info-toggle');
 // Item Inspector replaces the attached ⋯ popup; click-away and Escape dismiss it.
 await card(a).hover();await openItemDetails(card(a).locator('[data-item-controls]'));
 const inspector=page.locator('#workspace-item-controls');await inspector.waitFor();
 const box=await inspector.boundingBox();assert.ok(box.x+box.width>1440-12&&box.width>=300,'Item Inspector is the right-side panel');
 assert.ok(await inspector.locator('textarea[data-note]').count());assert.equal(await inspector.locator('[data-presentation]').count(),3);
 assert.match(await inspector.locator('.inspector-props').innerText(),/Created\s+just now/);
 await clickBlank();assert.equal(await inspector.count(),0,'Click-away closes the item Inspector');
 await openItemDetails(card(a).locator('[data-item-controls]'));await inspector.waitFor();await page.keyboard.press('Escape');assert.equal(await inspector.count(),0);
 // The action menu selects its target; start this separate selection case empty.
 await page.keyboard.press('Escape');assert.equal(await page.locator('.workspace-card.selected').count(),0);
 // Selection without checkboxes: Shift/⌘-click selects instead of opening; one floating bar acts on it.
 assert.equal(await page.locator('[data-placement-select]').evaluateAll(els=>els.some(el=>/[□✓]/.test(el.textContent))),false);
 await card(a).locator('h3 button').click({modifiers:['Shift']});
 await card(b).locator('h3 button').click({modifiers:['ControlOrMeta']});
 assert.equal(await page.locator('#reader-dialog').isVisible(),false,'Modifier clicks never open the reader');
 assert.equal(await page.locator('.workspace-card.selected').count(),2);
 assert.match(await page.locator('#workspace-selection strong').innerText(),/2 selected/);
 const ring=await card(a).evaluate(el=>getComputedStyle(el).outlineColor);assert.equal(ring,'rgb(98, 117, 74)','Selection ring is the one green');
 const bar=await page.locator('#workspace-selection').boundingBox();assert.ok(bar.y>900-80,'Selection bar floats at the bottom');
 await page.screenshot({path:path.join(evidence,'calm-selection.png')});
 await page.keyboard.press('Escape');assert.equal(await page.locator('.workspace-card.selected').count(),0);
 // Right-click gives a short menu; Details… opens the Inspector. ⌘I does the same for one selection.
 await card(b).locator('h3 button').click({button:'right'});await page.locator('.workspace-tile-menu').waitFor();
 await page.locator('.workspace-tile-menu [data-tile-menu="details"]').click();await inspector.waitFor();await page.keyboard.press('Escape');await page.keyboard.press('Escape');assert.equal(await page.locator('.workspace-card.selected').count(),0);
 await card(a).locator('h3 button').click({modifiers:['Shift']});await page.locator('#viewport').focus();await page.keyboard.press('ControlOrMeta+i');await inspector.waitFor();
 assert.match(await inspector.getAttribute('aria-label'),/Quiet onboarding/);await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 // Board-tiles are places with a serif name, a window and a readable edited date.
 const tile=page.locator('.workspace-board-tile.workspace-place-only');assert.equal(await tile.count(),1);
 assert.match(await tile.locator('.workspace-place-meta').innerText(),/Board · 1 item · edited just now/);
 assert.ok(await tile.locator('.workspace-place-meta time[data-rel][datetime][title]').count());
 assert.match(await tile.locator('h3').evaluate(el=>getComputedStyle(el).fontFamily),/serif/);
 // The view pill: − · % · + · Fit, and a browser-local Dots / Grid / Plain choice per board.
 const pct=async()=>Number((await page.locator('#zoom-menu-toggle').innerText()).replace('%',''));
 const start=await pct();await page.locator('#zoom-minus').click();const lower=await pct();assert.ok(lower<start);await page.locator('#zoom-plus').click();assert.ok(await pct()>lower);
 assert.equal(await page.locator('#viewport').getAttribute('data-canvas-pattern'),'dots');
 await page.locator('#zoom-menu-toggle').click();await page.locator('#zoom-menu').waitFor();
 await page.locator('#zoom-menu [data-canvas-pattern="grid"]').click();assert.equal(await page.locator('#viewport').getAttribute('data-canvas-pattern'),'grid');
 assert.match(await page.locator('#viewport').evaluate(el=>getComputedStyle(el).backgroundImage),/linear-gradient/);
 await clickBlank();assert.equal(await page.locator('#zoom-menu').isVisible(),false,'Click-away closes the zoom menu');
 await page.reload();await card(a).waitFor();assert.equal(await page.locator('#viewport').getAttribute('data-canvas-pattern'),'grid','Pattern persists for this board');
 await page.goto(base+'/boards/ideas/');await page.locator('.workspace-card').first().waitFor();assert.equal(await page.locator('#viewport').getAttribute('data-canvas-pattern'),'dots','Other boards keep their own pattern');
 await page.goto(base+'/boards/studio/');await card(a).waitFor();await page.locator('#board-info-toggle').click();await page.locator('#board-info [data-canvas-pattern="plain"]').click();
 assert.equal(await page.locator('#viewport').evaluate(el=>getComputedStyle(el).backgroundImage),'none');await page.keyboard.press('Escape');
 // Warm graphite dark, never blue slate.
 await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>localStorage.setItem('tinka/appearance','dark'));await page.reload();await card(a).waitFor();
 assert.equal(await page.locator('#viewport').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(43, 44, 41)');
 await page.screenshot({path:path.join(evidence,'calm-dark.png')});
 const after=await getBoardSnapshot(config,'studio');assert.equal(after.revision,before.revision,'View, panels and selection make no metadata writes');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,evidence,checks:['left Navigator, right Inspector, single primary Add','board Inspector click-away and Escape with focus return','item Inspector replaces the popup; click-away and Escape','selection by Shift/⌘-click without checkboxes, green ring, floating selection bar','right-click menu Details and ⌘I','board-tile serif place with readable edited date','zoom pill and zoom menu click-away','Dots/Grid/Plain per board in this browser','warm graphite dark','no metadata writes'],errors}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
