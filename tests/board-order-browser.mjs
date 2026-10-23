// Disposable headless checks; never uses personal boards, apps, or the OS clipboard.
import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {withStore} from '../lib/store.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-board-order-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-board-order-evidence-'));
await mkdir(evidence,{recursive:true});
const configPath=path.join(fixture,'local/config.json'),boards=path.join(fixture,'boards');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
let browser,server;
try {
  await main(['init','--config',configPath,'--boards',boards,'--label','Board creation order']);
  for(const [id,stamp] of [['alpha','2020-01-01'],['zulu','2024-01-01'],['unknown','invalid']]){
    await main(['board','create',id,'--config',configPath,'--title',id]);
    const file=path.join(boards,id,'board.json');await writeFile(file,JSON.stringify({...await json(file),createdAt:stamp}));
  }
  const config=await loadConfig(configPath);server=await listen(config,{port:0});
  const base=`http://127.0.0.1:${server.address().port}`;
  const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
  const stamp=async(id,date)=>withStore(config,async(root)=>{
    const file=path.join(root,'boards',id+'.json');await writeFile(file,JSON.stringify({...await json(file),createdAt:date}));
  });
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const homeOrder=()=>page.locator('#board-grid .board-link').evaluateAll(links=>links.map(a=>decodeURIComponent(a.getAttribute('href').split('/')[2])));
  const waitOrder=async(read,expected)=>{
    const end=Date.now()+15000;
    while(Date.now()<end){if(JSON.stringify(await read())===JSON.stringify(expected))return;await page.waitForTimeout(100);}
    assert.deepEqual(await read(),expected);
  };
  await page.goto(base);await waitOrder(homeOrder,['zulu','alpha','unknown']);
  await page.screenshot({path:path.join(evidence,'home-legacy-1440.png')});
  await op('createBoard',{id:'middle',title:'Middle graph'});await stamp('middle','2022-01-01');
  await page.reload();await waitOrder(homeOrder,['zulu','middle','alpha','unknown']);
  await op('createBoard',{id:'newest',title:'Zulu latest graph'});await waitOrder(homeOrder,['newest','zulu','middle','alpha','unknown']);
  await op('updateBoard',{boardId:'middle',patch:{title:'AAA renamed older graph'}});
  await op('review',{itemId:(await getBoardSnapshot(config,'middle')).ownerItemId,patch:{note:'A fresh note'}});
  await page.waitForTimeout(2300);assert.deepEqual(await homeOrder(),['newest','zulu','middle','alpha','unknown']);
  await page.screenshot({path:path.join(evidence,'home-mixed-1440.png')});
  // Saved round and reader order deliberately differs from board creation order.
  const parent=await op('createBoard',{id:'parent',title:'Mixed nested collection'}),bid=parent.boardId;
  const note=await op('createItem',{boardId:bid,item:{title:'First note',content:{kind:'note',text:'Keep reader order.'}},placement:{x:30,y:40}});
  const old=await op('createBoard',{id:'old-child',title:'Alpha old board',parentBoardId:bid});await stamp(old.boardId,'2020-01-01');
  const second=await op('createItem',{boardId:bid,item:{title:'Second note',content:{kind:'note',text:'Non-board slot stays.'}}});
  const recent=await op('createBoard',{id:'recent-child',title:'Zulu recent board',parentBoardId:bid});await stamp(recent.boardId,'2024-01-01');
  const convertedItem=await op('createItem',{boardId:bid,item:{title:'Converted old idea',createdAt:'2001-01-01',content:{kind:'note',text:'Older idea, newly created board.'}}});
  const converted=await op('createBoard',{id:'converted-child',itemId:convertedItem.itemId,title:'Newest child of old item'});
  const tail=await op('createItem',{boardId:bid,item:{title:'Last note',content:{kind:'note',text:'Keep my slot.'}}});
  const roundTwo=await op('createBoard',{id:'other-round',title:'Another retained round',parentBoardId:bid});
  // Fixture-only round metadata is written under the same store lock, before browsing.
  await withStore(config,async(root)=>{
    const file=path.join(root,'boards',bid+'.json'),b=await json(file);
    b.rounds=[{id:'first',title:'Retained first round',number:'01'},{id:'second',title:'Retained second round',number:'02'}];
    for(const p of b.placements)p.roundId=p.id===roundTwo.placementIds[0]?'second':'first';
    await writeFile(file,JSON.stringify(b));
  });
  const ids=[note.placementIds[0],old.placementIds[0],second.placementIds[0],recent.placementIds[0],convertedItem.placementIds[0],tail.placementIds[0],roundTwo.placementIds[0]];
  const before=await getBoardSnapshot(config,bid);
  assert.notEqual(before.items[convertedItem.itemId].createdAt,before.childBoardCreatedAt[converted.boardId]);
  await context.addInitScript(({workspaceId,bid})=>localStorage.setItem(`tinka/${workspaceId}/${bid}/layout`,'grid'),{workspaceId:config.workspaceId,bid});
  await page.goto(base+`/boards/${bid}/`);
  const gridOrder=()=>page.locator('.workspace-grid-round[data-round="first"] .workspace-card').evaluateAll(cards=>cards.map(c=>c.dataset.placement));
  await waitOrder(gridOrder,[ids[0],ids[4],ids[2],ids[3],ids[1],ids[5]]);
  assert.deepEqual(await page.locator('.workspace-grid-round').evaluateAll(groups=>groups.map(g=>g.dataset.round)),['first','second']);
  assert.deepEqual(await page.locator('.workspace-grid-round[data-round="second"] .workspace-card').evaluateAll(cards=>cards.map(c=>c.dataset.placement)),[ids[6]]);
  await page.screenshot({path:path.join(evidence,'nested-mixed-grid-1440.png')});
  await page.locator(`[data-placement="${ids[0]}"] .workspace-preview-launch`).click();
  await page.locator('#reader-dialog[open]').waitFor();
  assert.deepEqual(await page.locator('#dot-track [data-dot]').evaluateAll(dots=>dots.map(dot=>dot.dataset.dot)),ids.map(id=>'items/'+id));
  await page.locator('#close-reader').click();
  // New child appears through the ordinary live refresh and takes the first board slot.
  const live=await op('createBoard',{id:'live-child',title:'ZZZ live child',parentBoardId:bid});
  await withStore(config,async(root)=>{const file=path.join(root,'boards',bid+'.json'),b=await json(file);b.placements.find(p=>p.id===live.placementIds[0]).roundId='first';await writeFile(file,JSON.stringify(b));});
  await waitOrder(gridOrder,[ids[0],live.placementIds[0],ids[2],ids[4],ids[3],ids[5],ids[1]]);
  await op('updateItem',{itemId:old.itemId,patch:{title:'ZZZZ renamed oldest child'}});
  await op('review',{itemId:old.itemId,patch:{note:'Fresh notes must not reorder'}});
  await page.waitForTimeout(2300);assert.deepEqual(await gridOrder(),[ids[0],live.placementIds[0],ids[2],ids[4],ids[3],ids[5],ids[1]]);
  await page.screenshot({path:path.join(evidence,'nested-live-grid-1440.png')});
  // Switching to Canvas neither sorts its DOM order nor changes its saved geometry.
  await page.locator('#board-info-toggle').click();await page.locator('[data-mode="canvas"]').click();await page.locator('#board-info-toggle').click();
  const latest=await getBoardSnapshot(config,bid);
  assert.deepEqual(latest.reviewOrder,[...before.reviewOrder,live.placementIds[0]]);
  assert.deepEqual(latest.placements.slice(0,before.placements.length),before.placements);
  assert.deepEqual(await page.locator('#world .workspace-card').evaluateAll(cards=>cards.map(c=>c.dataset.placement)),latest.reviewOrder);
  assert.deepEqual(await page.locator('#world .workspace-card').evaluateAll(cards=>cards.map(c=>[c.dataset.placement,parseFloat(c.style.width),parseFloat(c.style.height),Number(c.style.zIndex)])),latest.reviewOrder.map(id=>{const p=latest.placements.find(p=>p.id===id);return [id,p.width,p.height,p.z];}));
  await page.screenshot({path:path.join(evidence,'nested-canvas-1440.png')});
  const pure=await op('createBoard',{id:'pure',title:'Pure collection'});
  const a=await op('createBoard',{id:'pure-alpha',title:'Alpha older',parentBoardId:pure.boardId});await stamp(a.boardId,'2020-01-01');
  const z=await op('createBoard',{id:'pure-zulu',title:'Zulu newer',parentBoardId:pure.boardId});
  await page.goto(base+`/boards/${pure.boardId}/`);await page.locator('#board-info-toggle').click();await page.locator('[data-mode="grid"]').click();await page.locator('#board-info-toggle').click();
  await waitOrder(()=>page.locator('#world .workspace-card').evaluateAll(cards=>cards.map(c=>c.dataset.placement)),[z.placementIds[0],a.placementIds[0]]);
  assert.deepEqual(errors,[]);
  const receipt={passed:['legacy Home newest first','mixed Home and live insertion','rename and notes do not reorder','actual child creation on older owner','mixed nested board slots and retained rounds','live nested insertion','reader saved comparison sequence','Canvas DOM order, geometry and saved reviewOrder','pure collection newest first'],fixture,evidence};
  await writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
} finally {await browser?.close();if(server)await closeAppServer(server);}
