// Disposable headless checks for Home selection: the board's corner circle,
// modifier clicks, the marquee and one floating selection bar. Never writes.
import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-home-selection-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-home-selection-evidence-'));
await mkdir(evidence,{recursive:true});
const configPath=path.join(fixture,'local/config.json'),boards=path.join(fixture,'boards');
const LIGHT_RING='rgb(98, 117, 74)',DARK_ACCENT='rgb(169, 187, 138)';
let browser,server;
try {
  await main(['init','--config',configPath,'--boards',boards,'--label','Home selection']);
  const config=await loadConfig(configPath);
  const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
  // Oldest first, so Home (newest first) shows Delta, Gamma, Beta, Alpha.
  for(const title of ['Alpha','Beta','Gamma','Delta']){
    const b=await op('createBoard',{title});
    await op('createItem',{boardId:b.boardId,item:{title:`${title} note`,content:{kind:'note',text:'Something to look at.'}}});
  }
  server=await listen(config,{port:0});
  const base=`http://127.0.0.1:${server.address().port}`;
  const revision=async()=>(await (await fetch(base+'/api/workspace')).json()).revision;
  const before=await revision();
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const cards=page.locator('#board-grid .board-card[data-home-item]');
  const card=title=>cards.filter({has:page.getByRole('heading',{name:title,exact:true})});
  const selectedTitles=()=>page.locator('#board-grid .board-card.workspace-home-selected h3').allTextContents();
  const bar=page.locator('[data-home-selection]');
  const expectSelected=async(titles,why)=>{
    const end=Date.now()+3000;let got;
    while(Date.now()<end){got=(await selectedTitles()).sort();if(JSON.stringify(got)===JSON.stringify([...titles].sort()))return;await page.waitForTimeout(50);}
    assert.deepEqual(got,[...titles].sort(),why);
  };
  // No checkbox inputs and no small square controls outside the cover window.
  const noSquares=()=>page.evaluate(()=>{
    const bad=[];
    if(document.querySelector('#board-grid input[type=checkbox],#board-grid .workspace-home-select'))bad.push('checkbox control');
    for(const el of document.querySelectorAll('#board-grid .board-card *')){
      if(el.closest('.board-art'))continue;
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      if(!r.width||r.width>40||Math.abs(r.width-r.height)>4||Number(s.opacity)<.05||s.visibility==='hidden')continue;
      const painted=s.backgroundColor!=='rgba(0, 0, 0, 0)'||s.boxShadow!=='none'||parseFloat(s.borderTopWidth)>0;
      if(painted&&parseFloat(s.borderTopLeftRadius)<r.width*.4)bad.push(`${el.tagName}.${el.className} ${Math.round(r.width)}px`);
    }
    return bad;
  });
  const dotState=title=>card(title).locator('[data-home-select]').evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {opacity:Number(s.opacity),radius:s.borderRadius,width:r.width,bg:s.backgroundColor,pressed:el.getAttribute('aria-pressed'),label:el.getAttribute('aria-label')};});
  const passed=[];

  await page.goto(base+'/');
  await cards.nth(3).waitFor();
  assert.equal(await cards.count(),4);
  assert.deepEqual(await noSquares(),[],'no squares at rest (1440)');
  for(const t of ['Alpha','Beta','Gamma','Delta'])assert.equal((await dotState(t)).opacity,0,`${t} circle hidden at rest`);
  await card('Delta').locator('h3').hover();await page.waitForTimeout(250);
  let dot=await dotState('Delta');
  assert.equal(dot.opacity,1,'hover shows the circle');assert.equal(dot.radius,'50%');assert.equal(Math.round(dot.width),22);
  assert.equal(dot.label,'Select Delta');assert.equal(dot.pressed,'false');
  assert.deepEqual(await noSquares(),[],'no squares on hover (1440)');
  await page.screenshot({path:path.join(evidence,'home-hover-1440.png')});
  passed.push('no checkboxes or squares at rest or hover (1440)','hover shows the corner circle');

  // The circle toggles by pointer and keyboard.
  await card('Delta').locator('[data-home-select]').click();
  await expectSelected(['Delta'],'circle selects');
  dot=await dotState('Delta');assert.equal(dot.pressed,'true');assert.equal(dot.label,'Deselect Delta');
  await card('Delta').locator('[data-home-select]').press('Space');
  await expectSelected([],'Space on the focused circle deselects');
  await card('Delta').locator('[data-home-select]').evaluate(el=>el.blur());
  passed.push('circle toggles by pointer and keyboard');

  // Shift-, ⌘- and Ctrl-click toggle without navigating.
  const url=page.url();
  await card('Delta').locator('h3').click({modifiers:['Shift']});
  await card('Gamma').locator('h3').click({modifiers:['Meta']});
  await expectSelected(['Delta','Gamma'],'Shift and ⌘ click select');
  await card('Beta').locator('h3').click({modifiers:['Control']});
  await expectSelected(['Delta','Gamma','Beta'],'Ctrl click selects');
  await card('Beta').locator('h3').click({modifiers:['Control']});
  await expectSelected(['Delta','Gamma'],'Ctrl click again deselects');
  await page.waitForTimeout(300);
  assert.equal(page.url(),url,'modifier clicks do not navigate');
  assert.equal(context.pages().length,1,'modifier clicks open no tab or window');
  passed.push('Shift, ⌘ and Ctrl click toggle without navigating');

  // Selected: green ring and green circle with a check; one floating bar.
  const ring=await card('Delta').locator('.board-link').evaluate(el=>{const s=getComputedStyle(el);return `${s.outlineStyle} ${s.outlineColor} ${s.boxShadow}`;});
  assert(ring.includes(LIGHT_RING)&&ring.startsWith('solid'),`green ring: ${ring}`);
  dot=await dotState('Gamma');assert.equal(dot.opacity,1);assert.equal(dot.bg,'rgb(83, 96, 68)','selected circle is the accent');
  await bar.waitFor();
  assert.equal(await bar.locator('strong').textContent(),'2 selected');
  const vb=await bar.boundingBox();
  assert(Math.abs(vb.x+vb.width/2-720)<=2&&Math.abs(1000-(vb.y+vb.height)-16)<=2,`bar floats bottom centre: ${JSON.stringify(vb)}`);
  assert.equal(await bar.evaluate(el=>getComputedStyle(el).position),'fixed');
  assert.deepEqual(await bar.getByRole('button').evaluateAll(bs=>bs.map(b=>b.getAttribute('aria-label')||b.textContent)),['Move…','Add reference…','Archive everywhere','Remove from home…','Clear selection']);
  assert.equal(await page.locator('.workspace-home-toolbar [data-home-action]').count(),0,'no inline selection group in the toolbar');
  await page.mouse.move(1400,980);await page.waitForTimeout(200);
  await page.screenshot({path:path.join(evidence,'home-selected-light-1440.png')});
  await bar.getByRole('button',{name:'Clear selection'}).click();
  await expectSelected([],'× clears');assert(await bar.isHidden(),'bar hides when empty');
  passed.push('selected cards carry the green ring and check','floating bar shows the count and Home bulk actions','× clears');

  // Marquee from empty space over two cards; Shift adds; Escape restores.
  const box=async t=>card(t).locator('.board-link').boundingBox();
  const drag=async(from,to,{shift=false,finish=true,mid}={})=>{
    if(shift)await page.keyboard.down('Shift');
    await page.mouse.move(from.x,from.y);await page.mouse.down();
    await page.mouse.move(from.x+3,from.y+2);
    assert.equal(await page.locator('.home-marquee').count(),0,'no box before 6px');
    await page.mouse.move(to.x,to.y,{steps:8});
    if(mid)await mid();
    if(finish)await page.mouse.up();
    if(shift)await page.keyboard.up('Shift');
  };
  const d=await box('Delta'),g=await box('Gamma');
  await drag({x:d.x-18,y:d.y-12},{x:g.x+40,y:g.y+40},{mid:async()=>{
    const look=await page.locator('.home-marquee').evaluate(el=>{const s=getComputedStyle(el);return `${s.backgroundColor} | ${s.boxShadow}`;});
    assert(look.includes(LIGHT_RING)&&!look.startsWith('rgba(0, 0, 0, 0)'),`translucent accent box: ${look}`);
    await expectSelected(['Delta','Gamma'],'live intersection');
    await page.screenshot({path:path.join(evidence,'home-marquee-1440.png')});
  }});
  await expectSelected(['Delta','Gamma'],'marquee selects two cards');
  assert.equal(await page.locator('.home-marquee').count(),0,'box removed after release');
  assert.equal(await bar.locator('strong').textContent(),'2 selected');
  assert.equal(page.url(),url,'marquee does not navigate');
  const a=await box('Alpha');
  await drag({x:a.x-18,y:a.y+30},{x:a.x+60,y:a.y+60},{shift:true});
  await expectSelected(['Delta','Gamma','Alpha'],'Shift marquee adds');
  const b=await box('Beta');
  await drag({x:b.x+100,y:b.y-10},{x:b.x+140,y:b.y+60},{finish:false,mid:async()=>{
    await expectSelected(['Beta'],'plain marquee replaces live');
    await page.keyboard.press('Escape');
  }});
  await page.mouse.up();
  await expectSelected(['Delta','Gamma','Alpha'],'Escape restores the original selection');
  assert.equal(await page.locator('.home-marquee').count(),0);
  passed.push('marquee selects by intersection after 6px','Shift marquee adds','Escape cancels the marquee and restores');

  // Empty clicks: Shift keeps, plain clears. Escape clears when no field is focused.
  await page.keyboard.down('Shift');await page.mouse.click(d.x-18,d.y-12);await page.keyboard.up('Shift');
  await expectSelected(['Delta','Gamma','Alpha'],'Shift empty click keeps');
  await page.mouse.click(d.x-18,d.y-12);
  await expectSelected([],'empty click clears');
  await card('Beta').locator('h3').click({modifiers:['Shift']});
  await page.locator('#home-find').focus();await page.keyboard.press('Escape');
  await expectSelected(['Beta'],'Escape in the find field keeps the selection');
  await page.evaluate(()=>document.activeElement.blur());
  await page.keyboard.press('Escape');
  await expectSelected([],'Escape clears');assert(await bar.isHidden());
  passed.push('empty click clears, Shift empty click keeps','Escape clears outside fields');

  // Marquee survives page scroll.
  await page.setViewportSize({width:1440,height:620});
  await page.evaluate(()=>scrollTo(0,260));
  const sd=await box('Alpha');
  await drag({x:sd.x-18,y:sd.y+20},{x:sd.x+60,y:sd.y+60},{finish:false,mid:async()=>{await page.mouse.wheel(0,80);await page.waitForTimeout(150);await page.mouse.move(sd.x+62,sd.y+40);}});
  await page.mouse.up();
  await expectSelected(['Alpha'],'marquee on a scrolled page selects what it covers');
  await page.mouse.click(sd.x-18,sd.y-40);await expectSelected([]);
  passed.push('marquee works with page scroll');

  // Dark theme: same ring and circle in the dark accent.
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));
  await page.emulateMedia({colorScheme:'dark'});
  await card('Delta').locator('h3').click({modifiers:['Shift']});await card('Gamma').locator('h3').click({modifiers:['Shift']});
  await page.mouse.move(1400,980);await page.waitForTimeout(250);
  assert.equal((await dotState('Delta')).bg,DARK_ACCENT,'dark selected circle');
  assert((await card('Delta').locator('.board-link').evaluate(el=>getComputedStyle(el).outlineColor))===DARK_ACCENT,'dark ring');
  await page.screenshot({path:path.join(evidence,'home-selected-dark-1440.png')});
  await page.keyboard.press('Escape');await expectSelected([]);
  await page.emulateMedia({colorScheme:'light'});
  passed.push('dark theme ring and circle');

  // 390: no stray squares, no horizontal scroll, the bar stays on screen.
  await page.setViewportSize({width:390,height:844});await page.reload();await cards.nth(3).waitFor();
  assert.deepEqual(await noSquares(),[],'no squares at rest (390)');
  await card('Delta').locator('h3').hover();await page.waitForTimeout(250);
  assert.deepEqual(await noSquares(),[],'no squares on hover (390)');
  assert.equal((await dotState('Delta')).opacity,1);
  await card('Delta').locator('h3').click({modifiers:['Shift']});await card('Gamma').locator('h3').click({modifiers:['Shift']});
  await expectSelected(['Delta','Gamma']);
  await page.mouse.move(380,10);await page.waitForTimeout(250);
  const nb=await bar.boundingBox();
  assert(nb.x>=7&&nb.x+nb.width<=383&&nb.y+nb.height<=844-6,`bar fits at 390: ${JSON.stringify(nb)}`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal scroll at 390');
  await page.screenshot({path:path.join(evidence,'home-selected-light-390.png')});
  await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(150);
  await page.screenshot({path:path.join(evidence,'home-selected-dark-390.png')});
  await page.emulateMedia({colorScheme:'light'});
  await bar.getByRole('button',{name:'Clear selection'}).click();await expectSelected([]);
  passed.push('390: no squares, no horizontal scroll, bar on screen');

  assert.equal(await revision(),before,'selection never writes');
  passed.push('workspace revision unchanged');
  // A plain click still opens the board.
  await card('Delta').locator('h3').click();
  await page.waitForURL(/\/boards\/[^/]+\/$/);
  passed.push('plain click opens the board');
  assert.deepEqual(errors,[]);
  const receipt={passed,fixture,evidence};
  await writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({passed:true,checks:passed,evidence}));
} finally {await browser?.close();if(server)await closeAppServer(server);}
