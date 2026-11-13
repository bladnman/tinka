import {openItemDetails} from './tile-test-helpers.mjs';
// Focused appearance acceptance: real app + external disposable mixed workspace.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-appearance-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-appearance-evidence-'));
await mkdir(evidence,{recursive:true});
let server,browser;const errors=[],contrasts=[];
const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
const luminance=value=>rgb(value).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
const ratio=(a,b)=>{const [x,y]=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (x+.05)/(y+.05);};
try{
  const file=path.join(root,'config.json');
  await main(['init','--config',file,'--boards',path.join(root,'boards'),'--label','Motion study']);
  const config=await loadConfig(file),op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
  await op('createBoard',{id:'studio',title:'Style guide studies'});
  await op('createBoard',{id:'round',title:'Exploration · work in progress',parentBoardId:'studio'});
  const assets=path.join(config.boardsRoot,'assets');await mkdir(assets);
  await writeFile(path.join(assets,'design.html'),'<!doctype html><style>body{margin:0;padding:28px;background:#fff7e7;color:#243b58;font:18px system-ui}h1{font-size:32px}div{height:180px;background:#799ac3;border-radius:50%}</style><h1>Authored light artwork</h1><p>This preview keeps its colors.</p><div></div>');
  await writeFile(path.join(assets,'image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300"><rect width="500" height="300" fill="#fff0df"/><circle cx="250" cy="150" r="110" fill="#c44e46"/></svg>');
  await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
  const items=[
    {id:'town',title:'Isometric town — people & places',description:'Chunky friendly buildings, people and travelers.',build:{state:'building',message:'Building the town kit. Not approved.'}},
    {id:'blueprint',title:'Isometric blueprint + 2D layer',description:'Wireframes and detail panels for comparison.',build:{state:'reserved',message:'Waiting for the next study.'}},
    {id:'review',title:'Woodland animals',description:'Runnable design, awaiting review.',content:{kind:'html',resource:{rootId:'assets',path:'design.html'}},build:{state:'review'}},
    {id:'white',title:'Explicit white paper',description:'Readable dark ink on authored white.',content:{kind:'note',text:'A supporting idea'}},
    {id:'dark',title:'Explicit dark paper',description:'Readable light ink on authored dark.',content:{kind:'note',text:'Another idea'}},
    {id:'image',title:'Uncropped image',content:{kind:'image',resource:{rootId:'assets',path:'image.svg'}}}
  ];
  const placements={};
  for(const [i,item] of items.entries())placements[item.id]=(await op('createItem',{boardId:'round',item,placement:{x:(i%3)*350,y:Math.floor(i/3)*320,width:320,height:280,presentation:{mode:item.id==='review'||item.id==='image'?'panel':'card',...(item.id==='white'?{paper:'#ffffff'}:item.id==='dark'?{paper:'#182432'}:{}),viewport:{width:500,height:300}}}})).placementIds[0];
  await op('createBoard',{id:'empty-child',title:'Reference collection',parentBoardId:'round'});
  server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'dark'});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');await page.locator('.board-card').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('data-appearance'),'dark');
  await page.screenshot({path:path.join(evidence,'home-dark.png')});
  // Preview launch buttons cover the artwork. Their hover backgrounds must
  // remain translucent in both appearances, including the legacy viewer.
  await page.goto(base+'/boards/studio/');
  await page.locator('.workspace-card-preview .board-collage').waitFor();
  for(const appearance of ['dark','light']){
    await page.evaluate(value=>localStorage.setItem('tinka/appearance',value),appearance);
    await page.reload();await page.locator('.workspace-card-preview .board-collage').waitFor();
    const launch=page.locator('.workspace-card-preview:has(.board-collage) .workspace-preview-launch').first();
    await launch.hover();
    const alpha=await launch.evaluate(el=>{const c=getComputedStyle(el).backgroundColor;return c.startsWith('rgba(')?Number(c.match(/[\d.]+/g)[3]):c==='transparent'?0:1;});
    assert.ok(alpha<.1,`${appearance} board cover hover obscures artwork: alpha ${alpha}`);
    await page.evaluate(()=>{const preview=document.createElement('div');preview.className='preview';preview.style.cssText='position:fixed;top:80px;left:80px;width:200px;height:150px;z-index:99999;background:#f00';preview.innerHTML='<button class="preview-launch"><span>Open</span></button>';document.body.append(preview);});
    const legacy=page.locator('.preview > .preview-launch').last();await legacy.hover();
    const legacyAlpha=await legacy.evaluate(el=>{const c=getComputedStyle(el).backgroundColor;return c.startsWith('rgba(')?Number(c.match(/[\d.]+/g)[3]):c==='transparent'?0:1;});
    assert.ok(legacyAlpha<.1,`${appearance} legacy preview hover obscures artwork: alpha ${legacyAlpha}`);
    await legacy.locator('..').evaluate(el=>el.remove());
  }
  await page.evaluate(()=>localStorage.removeItem('tinka/appearance'));
  await page.goto(base+'/boards/round/');await page.locator('.workspace-card').first().waitFor();
  await page.locator('#fit').click();
  const check=async(selector,background,min=4.5,label=selector)=>{
    const colors=await page.locator(selector).first().evaluate((el,bg)=>({text:getComputedStyle(el).color,background:bg?getComputedStyle(el.closest(bg)).backgroundColor:getComputedStyle(el).backgroundColor}),background);
    const contrast=ratio(colors.text,colors.background);contrasts.push({label,...colors,contrast});assert.ok(contrast>=min,`${label}: ${contrast.toFixed(2)} < ${min}`);
  };
  await check('.board-name','.canvas-header');
  await check(`[data-placement="${placements.town}"] h3 button`,'.workspace-card');
  await check(`[data-placement="${placements.town}"] .workspace-card-copy>p`,'.workspace-card');
  await check(`[data-placement="${placements.town}"] .workspace-build-placeholder strong`,'.workspace-card-preview');
  await check(`[data-placement="${placements.town}"] .workspace-build-placeholder span`,'.workspace-card-preview');
  await check(`[data-placement="${placements.white}"] h3 button`,'.workspace-card');
  await check(`[data-placement="${placements.dark}"] h3 button`,'.workspace-card');
  await page.waitForFunction(id=>{const outer=document.querySelector(`[data-placement="${id}"] iframe`);const doc=outer?.contentDocument;return doc?.body?.textContent?.includes('Authored light artwork')||doc?.querySelector('iframe')?.contentDocument?.body?.textContent?.includes('Authored light artwork');},placements.review);
  const authoredColors=await page.locator(`[data-placement="${placements.review}"] iframe`).evaluate(frame=>{const doc=frame.contentDocument,body=doc.querySelector('iframe')?.contentDocument?.body||doc.body;return {color:getComputedStyle(body).color,background:getComputedStyle(body).backgroundColor};});
  assert.deepEqual(authoredColors,{color:'rgb(36, 59, 88)',background:'rgb(255, 247, 231)'});
  await page.screenshot({path:path.join(evidence,'mixed-dark-wide.png')});
  await openItemDetails(page.locator(`[data-placement="${placements.town}"] [data-item-controls]`));await page.locator('#workspace-item-controls').waitFor({state:'visible'});
  await check('.workspace-context-note','#workspace-item-controls');
  await check('#workspace-item-controls textarea',null);
  const boundary=await page.locator('#workspace-item-controls textarea').evaluate(el=>({border:getComputedStyle(el).borderTopColor,background:getComputedStyle(el).backgroundColor}));
  assert.ok(ratio(boundary.border,boundary.background)>=3);
  await page.screenshot({path:path.join(evidence,'item-popup-dark.png')});
  await page.locator('[data-context-close]').click();
  await page.locator(`[data-placement="${placements.review}"] .workspace-panel-title`).click();
  await page.locator('#reader-dialog').waitFor({state:'visible'});await page.locator('#notes-toggle').click();
  await check('#reader-name','.reader-header');await check('#reader-note',null);
  await page.screenshot({path:path.join(evidence,'reader-dark.png')});await page.locator('#close-reader').click();
  await page.locator('#board-info-toggle').click();
  const appearance=page.getByRole('combobox',{name:'Appearance'});await appearance.selectOption('light');
  assert.equal(await page.locator('html').getAttribute('data-appearance'),'light');
  await check(`[data-placement="${placements.white}"] h3 button`,'.workspace-card');
  await check(`[data-placement="${placements.dark}"] h3 button`,'.workspace-card');
  await page.screenshot({path:path.join(evidence,'mixed-light-wide.png')});
  await appearance.selectOption('dark');await page.emulateMedia({colorScheme:'light'});
  assert.equal(await page.locator('html').getAttribute('data-appearance'),'dark');
  await appearance.selectOption('system');assert.equal(await page.locator('html').getAttribute('data-appearance'),'light');
  await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');
  await page.locator('#board-info-toggle').click();
  await page.setViewportSize({width:390,height:844});await page.goto(base+`/boards/round/?reveal=${placements.town}`);await page.locator(`[data-placement="${placements.town}"]`).waitFor();await page.waitForFunction(()=>document.querySelector('#zoom-slider').value>50);await page.locator('#workspace-toast').waitFor({state:'hidden'});
  await page.screenshot({path:path.join(evidence,'mixed-dark-narrow.png')});
  await openItemDetails(page.locator(`[data-placement="${placements.town}"] [data-item-controls]`));await page.screenshot({path:path.join(evidence,'item-popup-dark-narrow.png')});await page.locator('[data-context-close]').click();
  await page.getByRole('button',{name:'Navigator',exact:true}).click();await page.locator('#project-navigator').waitFor({state:'visible'});await page.getByText('Loading project boards…',{exact:true}).waitFor({state:'hidden'});await check('.navigator-status','#project-navigator');
  await page.screenshot({path:path.join(evidence,'navigator-dark-narrow.png')});await page.keyboard.press('Escape');
  await page.goto(base+'/');assert.equal(await page.getByRole('combobox',{name:'Appearance'}).inputValue(),'system');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(evidence,'appearance-report.json'),JSON.stringify({passed:true,contrasts,checks:['system/light/dark persistence','mixed building and review cards','explicit white and dark paper','popup field text and boundary','authored media retains source colors','home and navigator','normal and narrow'],errors},null,2));
  console.log(JSON.stringify({passed:true,evidence,contrasts,errors}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
