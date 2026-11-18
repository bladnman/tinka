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
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-outline-'));
let browser,server;
try{
  const configFile=path.join(fixture,'local/config.json');
  await main(['init','--config',configFile,'--boards',path.join(fixture,'boards'),'--label','Outline fixture']);
  const config=await loadConfig(configFile),boardId='workspace';
  await applyOperation(config,{type:'createBoard',id:boardId,title:'Outline fixture'});
  await applyOperation(config,{type:'createDecoration',boardId,decoration:{
    id:'number',type:'region',shape:'ellipse',x:-10,y:-15,width:36,height:36,color:'palette:sage',text:'2',
  }});
  server=createAppServer(config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:850},reducedMotion:'reduce'});
  page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${server.address().port}/boards/${boardId}/`);
  const shape=page.locator('[data-decoration=number]'), toolbar=page.locator('.whiteboard-toolbar');
  const geometry=async()=>{
    const {x,y,width,height}= (await getBoardSnapshot(config,boardId)).decorations[0];
    return [x,y,width,height];
  };
  const waitGeometry=async expected=>{
    for(let n=0;n<60;n++){
      const current=await geometry();
      if(current.every((value,index)=>Math.abs(value-expected[index])<.001))return;
      await page.waitForTimeout(75);
    }
    assert.deepEqual(await geometry(),expected);
  };
  await shape.locator('.deco-body').click();
  await toolbar.getByRole('button',{name:'Connect',exact:true}).waitFor();
  assert.equal(await shape.locator('[data-decoration-resize]').count(),8);
  assert.equal(await shape.locator('button[data-decoration-resize]').count(),0);
  assert.equal(await page.locator('.whiteboard-port').count(),0);
  assert.equal(await toolbar.locator('button').count(),3);
  assert.equal(await shape.locator('.deco-body').innerText(),'2');

  const drag=async(direction,dx,dy,shift=false)=>{
    const edge=shape.locator(`[data-decoration-resize=${direction}]`),rect=await edge.boundingBox();
    const zoom=await page.locator('#viewport').evaluate(el=>Number(el.style.getPropertyValue('--canvas-zoom')));
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
    if(shift)await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(rect.x+rect.width/2+dx*zoom,rect.y+rect.height/2+dy*zoom,{steps:5});
    await page.mouse.up();
    if(shift)await page.keyboard.up('Shift');
  };
  await drag('w',-20,0);await waitGeometry([-30,-15,56,36]);
  await drag('n',0,-12);await waitGeometry([-30,-27,56,48]);
  await drag('e',8,0);await waitGeometry([-30,-27,64,48]);
  await drag('s',0,9);await waitGeometry([-30,-27,64,57]);
  await drag('nw',-16,-9,true);await waitGeometry([-46,-41.25,80,71.25]);
  for(const expected of [[-30,-27,64,57],[-30,-27,64,48],[-30,-27,56,48],[-30,-15,56,36],[-10,-15,36,36]]){
    await page.keyboard.press('Control+z');await waitGeometry(expected);
  }

  await toolbar.getByRole('button',{name:'Connect',exact:true}).click();
  const port=page.locator('.whiteboard-port[data-port-side=top]');
  await port.waitFor();
  const boundsAtZoom=()=>port.evaluate(el=>{
    const box=el.getBoundingClientRect(), outer=document.querySelector('[data-decoration=number]').getBoundingClientRect();
    const zoom=Number(document.querySelector('#viewport').style.getPropertyValue('--canvas-zoom'));
    return {zoom,hit:box.width,mark:parseFloat(getComputedStyle(el,'::after').width)*zoom,overlap:box.bottom-outer.top};
  });
  const near=await boundsAtZoom();
  await page.locator('#zoom-menu-toggle').click();
  await page.locator('#zoom-slider').evaluate(async slider=>{
    const {sliderFromZoom}=await import('/app/canvas-zoom.js');
    slider.value=String(sliderFromZoom(2.2));
    slider.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await page.waitForFunction(()=>Number(document.querySelector('#viewport').style.getPropertyValue('--canvas-zoom'))>=2);
  const close=await boundsAtZoom();
  for(const observation of [near,close]){
    assert.ok(Math.abs(observation.mark-11)<1,JSON.stringify(observation));
    assert.ok(observation.hit>=23&&observation.hit<=25,JSON.stringify(observation));
    assert.ok(observation.overlap<=.5,JSON.stringify(observation));
  }
  console.log('Compact shape, invisible outline zones on all four sides and corners, proportional resize, Undo, and capped magnets passed.');
} finally {
  await browser?.close();
  if(server)await closeAppServer(server);
  await rm(fixture,{recursive:true,force:true});
}
