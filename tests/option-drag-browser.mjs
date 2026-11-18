// Native pointer and keyboard input on a disposable mixed Canvas.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(tmpdir(),'tinka-option-drag-'));
const config=path.join(fixture,'local/config.json'), boards=path.join(fixture,'boards');
const resource=path.join(boards,'assets/reader.html'), source='<!doctype html><title>Reading</title><body style="background:rgb(185, 161, 212)"><h1>Quiet reading</h1></body>';
let browser,started;
try {
  await main(['init','--config',config,'--boards',boards,'--label','Canvas copy fixture']);
  await main(['workspace','init','--config',config,'--apply']);
  await mkdir(path.dirname(resource),{recursive:true});
  await writeFile(resource,source);
  await main(['start','--config',config]);
  started=true;
  const local=JSON.parse(await readFile(config,'utf8')), base=`http://127.0.0.1:${local.port}`;
  const get=async route=>{const r=await fetch(base+route);assert.ok(r.ok);return r.json();};
  const cfg=await get('/api/config');
  const op=async(type,data)=>{
    const r=await fetch(base+'/api/operations',{method:'POST',headers:{'Content-Type':'application/json','x-tinka-workspace':cfg.workspaceId},
      body:JSON.stringify({type,...data,operationId:crypto.randomUUID()})});
    const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body.result;
  };
  await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
  const {boardId}=await op('createBoard',{title:'Reading studies'});
  const {itemId,placementIds:[id]}=await op('createItem',{boardId,item:{title:'Quiet reading',content:{kind:'html',resource:{rootId:'assets',path:'reader.html'}}},
    placement:{x:100,y:130,width:288,height:210,z:4,presentation:{mode:'panel',viewport:{width:320,height:240}}}});
  await op('createDecoration',{boardId,decoration:{id:'caption',type:'text',x:420,y:145,width:200,height:76,color:'#456139',text:'A native caption',textSize:24}});
  await op('createDecoration',{boardId,decoration:{id:'link',type:'line',x:388,y:182,width:32,height:53,color:'#456139',text:'',endArrow:true,
    from:{placementId:id,side:'right'},to:{decorationId:'caption',side:'left'}}});
  const board=()=>get(`/api/boards/${boardId}`), original=await board();
  const shape=({placements,reviewOrder,decorations})=>({placements,reviewOrder,decorations});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const pageErrors=[],writes=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url()===base+'/api/operations')writes.push(r.postDataJSON());});
  await page.goto(`${base}/boards/${boardId}/`);
  const card=placement=>page.locator(`.workspace-card[data-placement="${placement}"]`);
  const block=deco=>page.locator(`#world [data-decoration="${deco}"]`);
  const sourceCard=card(id), target=sourceCard.locator('.workspace-preview-launch');
  await sourceCard.waitFor();
  await page.locator('#fit').click();
  await sourceCard.locator('iframe').contentFrame().locator('iframe.item-full-frame').contentFrame().getByRole('heading',{name:'Quiet reading'}).waitFor();
  const key=await page.evaluate(()=>/mac/i.test(navigator.userAgentData?.platform||navigator.platform))?'Meta':'Control';
  await target.evaluate(node=>window.originalPreview=node.closest('.workspace-card').querySelector('iframe'));
  const point=await target.boundingBox(),start={x:point.x+point.width/2,y:point.y+point.height/2};
  const gesture=async(dx,dy)=>{
    await page.mouse.move(start.x,start.y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.keyboard.up('Alt'); // the action stays latched after an Option pointerdown
    await page.mouse.move(start.x+dx,start.y+dy,{steps:5});
  };
  const action=async(type,run)=>{
    const pending=page.waitForResponse(r=>r.url()===base+'/api/operations'&&r.request().postDataJSON()?.type===type);
    await run();const response=await pending, body=await response.json();
    assert.equal(response.status(),200,JSON.stringify(body));assert.ok(body.history);return body;
  };
  await page.locator('#viewport').focus();
  await page.keyboard.press(`${key}+a`);
  await gesture(182,188);
  assert.equal(await page.locator('.workspace-copy-ghost').count(),3);
  assert.equal(await page.locator('.workspace-copy-layer iframe').count(),0);
  const preview = page.locator('.workspace-copy-layer canvas.workspace-copy-frame');
  assert.deepEqual(await preview.evaluate(c=>Array.from(c.getContext('2d').getImageData(c.width-2,c.height-2,1,1).data)),[185,161,212,255]);
  assert.equal(await page.locator('.workspace-copy-ghost .deco-body').textContent(),'A native caption');
  if (process.env.TINKA_EVIDENCE_DIR) {
    await mkdir(process.env.TINKA_EVIDENCE_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.TINKA_EVIDENCE_DIR,'option-drag-rendered.png')});
  }
  assert.deepEqual(await target.boundingBox(),point,'HTML tile stays still during the drag');
  assert.equal((await board()).revision,original.revision,'no save before drop');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.locator('.workspace-copy-layer').waitFor({state:'detached'});
  assert.equal(writes.length,0);
  assert.ok(await sourceCard.evaluate(node=>node.classList.contains('selected')));

  await gesture(182,188);
  const copied=await action('duplicateOccurrences',()=>page.mouse.up());
  const [newPlacement]=copied.result.placementIds,[newCaption,newLink]=copied.result.decorationIds;
  assert.notEqual(newPlacement,id);
  await card(newPlacement).waitFor();
  await page.waitForFunction(placement=>document.querySelector(`.workspace-card.selected[data-placement="${placement}"]`),newPlacement);
  assert.ok(await sourceCard.evaluate(node=>node.querySelector('iframe')===window.originalPreview));
  const placed=await board(),ref=placed.placements.find(p=>p.id===newPlacement);
  const [copyOp]=writes;
  assert.equal(placed.revision,original.revision+1);
  assert.equal(ref.itemId,itemId);
  assert.deepEqual(placed.items,original.items);
  assert.deepEqual(placed.placements.find(p=>p.id===id),original.placements[0]);
  assert.deepEqual({x:ref.x,y:ref.y,presentation:ref.presentation},{x:100+copyOp.dx,y:130+copyOp.dy,presentation:original.placements[0].presentation});
  const caption=placed.decorations.find(d=>d.id===newCaption),link=placed.decorations.find(d=>d.id===newLink);
  assert.deepEqual(caption,{...original.decorations[0],id:newCaption,x:420+copyOp.dx,y:145+copyOp.dy});
  assert.equal(link.from.placementId,newPlacement);assert.equal(link.to.decorationId,newCaption);

  await action('restoreMovement',()=>page.keyboard.press(`${key}+z`));
  await card(newPlacement).waitFor({state:'detached'});
  assert.deepEqual(shape(await board()),shape(original));
  await action('restoreMovement',()=>page.keyboard.press(`${key}+Shift+z`));
  await card(newPlacement).waitFor();await block(newCaption).waitFor();
  assert.deepEqual(shape(await board()),shape(placed));

  // Remove only the copy as a person would, and undo that removal.
  await card(newPlacement).locator('[data-placement-select]').focus();
  await page.keyboard.press('Space');
  await page.locator('#viewport').focus();
  await action('remove',()=>page.keyboard.press('Delete'));
  await card(newPlacement).waitFor({state:'detached'});
  const removed=await board();
  assert.deepEqual(removed.placements.find(p=>p.id===id),original.placements[0]);
  assert.deepEqual(removed.items[itemId],original.items[itemId]);
  assert.equal(await readFile(resource,'utf8'),source);
  await action('restoreMovement',()=>page.keyboard.press(`${key}+z`));
  await card(newPlacement).waitFor();
  assert.deepEqual(shape(await board()),shape(placed));
  await page.waitForFunction(()=>!document.getElementById('workspace-paste')?.disabled);

  const textBounds=await block('caption').boundingBox(), center={x:textBounds.x+textBounds.width/2,y:textBounds.y+textBounds.height/2};
  await page.mouse.move(center.x,center.y);
  await page.keyboard.down('Alt');await page.mouse.down();
  await page.mouse.move(center.x+165,center.y-95,{steps:5});
  assert.equal(await page.locator('.workspace-copy-ghost').count(),1,'single native Text body is draggable');
  const one=await action('duplicateOccurrences',()=>page.mouse.up());
  await page.keyboard.up('Alt');
  assert.deepEqual(one.result.placementIds,[]);
  const independent=one.result.decorationIds[0];
  await block(independent).waitFor();
  await op('updateDecoration',{boardId,decorationId:independent,patch:{text:'Rewritten independently'}});
  const updated=await board();
  assert.equal(updated.decorations.find(d=>d.id==='caption').text,'A native caption');
  assert.equal(updated.decorations.find(d=>d.id===independent).text,'Rewritten independently');
  assert.deepEqual(pageErrors,[]);
  console.log('Option-drag passed: framed HTML + native text/connector, cancellation, one-step Undo/Redo, placement-only removal and exact restore.');
} finally {
  await browser?.close();
  if(started)await main(['stop','--config',config]);
  await rm(fixture,{recursive:true,force:true});
}
