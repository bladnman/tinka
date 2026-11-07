// Whiteboard shape text stays readable on its own fill in light and dark
// appearance, at rest and while editing. Isolated fixture, headless, port 0.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-decoration-ink-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-decoration-ink-evidence-'));
await mkdir(evidence,{recursive:true});let server,browser;
// Add-menu defaults (sticky, process/decision/start-end, region) and custom fills,
// including dark, mid-tone, saturated and translucent colors.
const fills=[
  ['sticky','rectangle','#f6e6a4'],['process','rounded','#e0e8da'],['decision','diamond','#e0e8da'],['start-end','ellipse','#e0e8da'],
  ['custom-navy','rectangle','#2b3a55'],['custom-grey','rounded','#808080'],['custom-red','diamond','#ff0000'],
  ['custom-black','rectangle','#000000'],['custom-white','ellipse','#ffffff'],['custom-translucent','rectangle','#f6e6a480'],['custom-short','rounded','#36c'],
  ['region','','#e1e8d5'],
];
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Decoration ink fixture']);
  const config=await loadConfig(configFile),board=(await applyOperation(config,{type:'createBoard',title:'Readable stickies'})).result;
  for(const [i,[id,shape,color]] of fills.entries())
    await applyOperation(config,{type:'createDecoration',boardId:board.boardId,decoration:{id,type:'region',...(shape?{shape}:{}),x:(i%4)*260,y:Math.floor(i/4)*240,width:220,height:200,color,text:'Hi there!'}});
  // Paper-backed editors (free text, arrow labels) keep the app's ink while editing.
  await applyOperation(config,{type:'createDecoration',boardId:board.boardId,decoration:{id:'free-text',type:'text',x:1060,y:0,width:280,height:70,color:'#7a8a68',text:'Free text'}});
  await applyOperation(config,{type:'createDecoration',boardId:board.boardId,decoration:{id:'arrow',type:'line',x:1060,y:300,width:200,height:90,color:'#6c8060',text:'Arrow label',endArrow:true}});
  server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Text and its composited backdrop (canvas, then fill layers) measured in the page.
  const measure=(selector,layers)=>page.evaluate(({selector,layers})=>{
    const ctx=Object.assign(document.createElement('canvas'),{width:1,height:1}).getContext('2d',{willReadFrequently:true});
    const paint=colors=>{ctx.clearRect(0,0,1,1);for(const c of colors){ctx.fillStyle='#000';ctx.fillStyle=c;ctx.fillRect(0,0,1,1);}return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
    const lum=rgb=>{const [r,g,b]=rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};
    const ratio=(a,b)=>{const x=lum(a),y=lum(b);return Math.round((Math.max(x,y)+.05)/(Math.min(x,y)+.05)*100)/100;};
    const el=document.querySelector(selector);if(!el)return null;
    const canvas=getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim();
    const backdrop=paint([canvas,...layers.map(([s,prop])=>getComputedStyle(document.querySelector(s))[prop])]);
    const style=getComputedStyle(el),text=paint([canvas,...layers.map(([s,prop])=>getComputedStyle(document.querySelector(s))[prop]),style.color]);
    const caret=style.caretColor==='auto'?text:paint([canvas,...layers.map(([s,prop])=>getComputedStyle(document.querySelector(s))[prop]),style.caretColor]);
    return {text:style.color,backdrop:`rgb(${backdrop})`,contrast:ratio(text,backdrop),caret:ratio(caret,backdrop)};
  },{selector,layers});
  const results={},failures=[];
  for(const appearance of ['light','dark']){
    await page.goto(`${url}/boards/${board.boardId}/`);
    await page.evaluate(value=>localStorage.setItem('tinka/appearance',value),appearance);await page.reload();
    await page.locator('[data-decoration=sticky]').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-appearance'),appearance);
    // A sticky added from + Add uses the same default fill as the report.
    if(appearance==='dark'){
      await page.locator('#board-info-toggle').click();await page.locator('#workspace-add').click();await page.locator('[data-add=sticky]').click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-decoration]').length>14);
      // A new sticky opens straight into editing, as when Matt typed into it.
      await page.locator('.whiteboard-editor textarea').waitFor();await page.keyboard.press('Escape');await page.locator('.whiteboard-editor').waitFor({state:'detached'});
    }
    const ids=await page.locator('[data-decoration]').evaluateAll(els=>els.map(el=>el.dataset.decoration));
    for(const id of ids){
      const d=`[data-decoration="${id}"]`,shape=await page.locator(`${d}.whiteboard-shape`).count();
      const layers=shape?[[`${d} .whiteboard-silhouette`,'fill']]:[[d,'backgroundColor'],[`${d} > .workspace-decoration-label`,'backgroundColor']];
      // Free text is authored ink on the canvas; only its editor is measured.
      const freeText=id==='free-text';
      const rest=freeText?null:await measure(`${d} > .workspace-decoration-label`,layers);
      await page.locator(`${d} [data-decoration-label]`).dblclick();await page.locator('.whiteboard-editor textarea').waitFor();
      await page.keyboard.press('ControlOrMeta+a');
      const editing=await measure('.whiteboard-editor textarea',[...layers,['.whiteboard-editor textarea','backgroundColor']]);
      await page.keyboard.press('Escape');await page.locator('.whiteboard-editor').waitFor({state:'detached'});
      const key=`${appearance} ${fills.find(f=>f[0]===id)?.slice(0,3).join(' ')||(['free-text','arrow'].includes(id)?id:'added default sticky')}`;
      results[key]={rest,editing};
      for(const [state,m] of [['rest',rest],['editing',editing]]){
        if(!m)continue;
        if(m.contrast<4.5)failures.push(`${key} ${state}: text ${m.text} on ${m.backdrop} = ${m.contrast}:1`);
        if(m.caret<3)failures.push(`${key} ${state}: caret ${m.caret}:1`);
      }
    }
    if(appearance==='dark'){
      await page.locator('[data-decoration=sticky] [data-decoration-label]').dblclick();await page.locator('.whiteboard-editor textarea').waitFor();
      await page.screenshot({path:path.join(evidence,'decoration-ink-dark.png')});await page.keyboard.press('Escape');
    }
  }
  // A board holding only whiteboard objects is not empty. The empty message
  // returns when the last object is removed, and hides when one comes back.
  const empty=page.locator('#world .workspace-empty');
  await page.locator('.whiteboard-editor').waitFor({state:'detached'});
  assert.equal(await empty.count(),0,'a board with only whiteboard objects shows the empty message');
  const remaining=(await getBoardSnapshot(config,board.boardId)).decorations.map(d=>d.id);
  for(const id of remaining.filter(id=>id!=='sticky'))await applyOperation(config,{type:'removeDecoration',boardId:board.boardId,decorationId:id});
  await page.waitForFunction(()=>document.querySelectorAll('#world [data-decoration]').length===1);
  assert.equal(await empty.count(),0,'one remaining sticky keeps the board non-empty');
  await page.locator('[data-decoration=sticky] [data-decoration-label]').click();
  await page.locator('[data-whiteboard-action=more]').click();await page.locator('[data-whiteboard-action=remove]').click();
  await empty.waitFor();assert.equal(await page.locator('#world [data-decoration]').count(),0);
  const emptyState={afterLastRemoval:await empty.isVisible()};
  await applyOperation(config,{type:'createDecoration',boardId:board.boardId,decoration:{id:'returned',type:'region',shape:'rectangle',x:0,y:0,width:220,height:200,color:'#f6e6a4',text:'Back again'}});
  await page.locator('[data-decoration=returned]').waitFor();await empty.waitFor({state:'detached'});
  emptyState.hiddenWhenObjectReturns=true;console.log(`empty state: ${JSON.stringify(emptyState)}`);
  for(const [key,{rest,editing}] of Object.entries(results))console.log(`${key.padEnd(44)} rest ${String(rest?.contrast??'n/a').padStart(5)}:1  editing ${String(editing.contrast).padStart(5)}:1`);
  await writeFile(path.join(evidence,'decoration-ink-results.json'),JSON.stringify(results,null,2));
  assert.deepEqual(failures,[],failures.join('\n'));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,evidence,checks:'default + custom whiteboard fills keep ≥4.5:1 text and readable caret in light and dark, at rest and editing'}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
