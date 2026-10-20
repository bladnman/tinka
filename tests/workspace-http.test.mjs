import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen} from '../server.mjs';

async function fixture(t,{legacy=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-workspace-http-'));
  const configPath=path.join(root,'config.json'),boards=path.join(root,'boards');
  await main(['init','--config',configPath,'--boards',boards,'--label','Graph fixture']);
  if(legacy){
    await main(['board','create','legacy','--config',configPath,'--title','Existing board']);
    const board=path.join(boards,'legacy');
    await mkdir(path.join(board,'experiments','alpha'),{recursive:true});
    await writeFile(path.join(board,'experiments','alpha','index.html'),'<link rel="stylesheet" href="style.css"><h1>Alpha</h1>');
    await writeFile(path.join(board,'experiments','alpha','style.css'),'body{color:navy}');
    await writeFile(path.join(board,'rounds.json'),JSON.stringify({rounds:[{id:'first',title:'First',concepts:[{id:'alpha',name:'Alpha',path:'experiments/alpha/index.html'}]}],revisions:{'first/alpha':[{id:'v2',name:'Later',path:'experiments/alpha/index.html'}]}}));
    await writeFile(path.join(board,'.state','notes.json'),JSON.stringify({'first/alpha':{note:'Keep me',star:true,updatedAt:4},'old/orphan':{note:'Orphan survives',star:false,updatedAt:3,extra:'raw'}}));
    await writeFile(path.join(board,'build-state.json'),JSON.stringify({concepts:{'first/alpha':{state:'review',message:'Review now',updatedAt:2},'old/orphan':{state:'ready',message:'Old work',updatedAt:1}},extra:'history'}));
  }
  const config=await loadConfig(configPath),server=await listen(config,{port:0});
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const get=async route=>{const response=await fetch(base+route);assert.equal(response.status,200,await response.clone().text());return response.json();};
  const write=(route,body,extra={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':config.workspaceId,...extra.headers},body:JSON.stringify(body),...Object.fromEntries(Object.entries(extra).filter(([key])=>key!=='headers'))});
  const op=async operation=>{const response=await write('/api/operations',operation);assert.equal(response.status,200,await response.clone().text());return response.json();};
  return {root,configPath,boards,config,server,base,get,write,op};
}

test('HTTP migration is explicit and legacy feedback cannot overwrite canonical review',async t=>{
  const f=await fixture(t,{legacy:true});
  const sourceFiles=['board.json','rounds.json','build-state.json','.state/notes.json'];
  const originals=await Promise.all(sourceFiles.map(file=>readFile(path.join(f.boards,'legacy',file))));
  assert.deepEqual(await f.get('/api/workspace'),{enabled:false,revision:0});
  const dry=await f.write('/api/workspace/migrate',{dryRun:true});assert.equal(dry.status,200);
  assert.equal((await dry.json()).boards.length,1);
  assert.equal((await f.get('/api/workspace')).enabled,false);
  assert.deepEqual((await readdir(f.boards)).sort(),['legacy']);
  assert.equal((await f.write('/api/workspace/migrate',{})).status,400);
  assert.equal((await f.write('/api/workspace/migrate',{dryRun:false})).status,200);
  let workspace=await f.get('/api/workspace');assert.equal(workspace.enabled,true);
  assert.notEqual(workspace.workspaceId,f.config.workspaceId);
  assert.equal((await f.get('/api/boards')).boards.length,1);
  const board=await f.get('/api/boards/legacy');assert.equal(board.schemaVersion,2);
  const item=workspace.items.find(item=>item.legacy?.key==='first/alpha');
  assert.equal(item.review.note,'Keep me');assert.equal(item.revisions.length,1);
  await f.op({type:'review',itemId:item.id,patch:{note:'Canonical feedback'}});
  assert.equal((await f.write('/api/boards/legacy/notes',{'first/alpha':{note:'Stale'}},{method:'PUT'})).status,409);
  const notes=await f.get('/api/boards/legacy/notes');assert.equal(notes['first/alpha'].note,'Canonical feedback');assert.equal(notes['old/orphan'].note,'Orphan survives');
  assert.equal((await f.write('/api/workspace/migrate',{dryRun:false})).status,200);
  workspace=await f.get('/api/workspace');assert.equal(workspace.items.filter(item=>item.legacy?.key==='first/alpha').length,1);
  for(let i=0;i<sourceFiles.length;i++)assert.deepEqual(await readFile(path.join(f.boards,'legacy',sourceFiles[i])),originals[i]);
  const receipts=await readdir(path.join(f.config.workspaceRoot,'migrations'));
  const receipt=JSON.parse(await readFile(path.join(f.config.workspaceRoot,'migrations',receipts[0]),'utf8'));
  assert.equal(receipt.backups.legacy.notes['old/orphan'].extra,'raw');
  assert.equal(receipt.backups.legacy.build.extra,'history');
  await f.op({type:'deleteItem',itemIds:[board.ownerItemId]});
  assert.equal((await f.get('/api/boards')).boards.length,0);
  assert.equal((await fetch(f.base+'/api/boards/legacy')).status,404);
  assert.equal((await fetch(f.base+'/boards/legacy/')).status,404);
  assert.deepEqual(await readFile(path.join(f.boards,'legacy','board.json')),originals[0]);
});

test('operations and review enforce identity, origin, content type, bounds and optimistic revisions',async t=>{
  const f=await fixture(t);
  for(const route of ['/api/operations','/api/workspace/migrate','/api/items/item/review']){
    const body=route.endsWith('migrate')?{dryRun:false}:route.endsWith('review')?{patch:{note:'x'}}:{type:'createBoard',title:'Denied'};
    const method=route.endsWith('review')?'PATCH':'POST';
    assert.equal((await f.write(route,body,{method,headers:{'x-tinka-workspace':'wrong'}})).status,403);
    assert.equal((await f.write(route,body,{method,headers:{origin:'https://example.org'}})).status,403);
  }
  assert.equal((await f.write('/api/operations',{type:'createBoard',title:'No type'},{headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.write('/api/operations',{type:'createBoard',title:'x'.repeat(1_000_001)})).status,413);
  const created=await f.op({type:'createBoard',id:'ideas',title:'Ideas',expectedRevision:0,operationId:'first-board'});
  assert.equal(created.revision,1);
  const replay=await f.op({type:'createBoard',id:'ideas',title:'Ideas',expectedRevision:0,operationId:'first-board'});assert.equal(replay.replayed,true);
  assert.equal((await f.write('/api/operations',{type:'createBoard',title:'Stale',expectedRevision:0})).status,409);
  const item=await f.op({type:'createItem',boardId:'ideas',item:{id:'idea',title:'Title only'}});
  const review=await f.write('/api/items/idea/review',{expectedRevision:item.revision,patch:{note:'Useful',star:true}},{method:'PATCH'});assert.equal(review.status,200);
  assert.equal((await f.get('/api/items/idea')).review.note,'Useful');
  const settings=JSON.parse(await readFile(f.configPath,'utf8'));await writeFile(f.configPath,JSON.stringify({...settings,workspaceRoot:path.join(f.root,'changed')}));
  assert.equal((await f.write('/api/operations',{type:'review',itemId:'idea',patch:{note:'stale'}})).status,403);
  const custom=await loadConfig(f.configPath);assert.notEqual(custom.workspaceId,f.config.workspaceId);
  await writeFile(f.configPath,JSON.stringify({...settings,workspaceRoot:path.join(f.root,'changed-again')}));assert.notEqual((await loadConfig(f.configPath)).workspaceId,custom.workspaceId);
  await writeFile(f.configPath,JSON.stringify({...settings,workspaceRoot:path.join(f.boards,'.tinka')}));assert.equal((await loadConfig(f.configPath)).workspaceId,f.config.workspaceId);
});

test('declared resource roots preserve relative HTML assets, safe ranges and live source changes',async t=>{
  const f=await fixture(t);await f.op({type:'createBoard',id:'resources',title:'Resources'});
  const assets=path.join(f.root,'payload');await mkdir(path.join(assets,'page'),{recursive:true});
  await writeFile(path.join(assets,'page','index.html'),'<link href="style.css" rel="stylesheet">');
  await writeFile(path.join(assets,'page','style.css'),'first');await writeFile(path.join(assets,'.secret'),'private');
  await writeFile(path.join(f.root,'outside.txt'),'outside');await symlink(path.join(f.root,'outside.txt'),path.join(assets,'escape.txt'));
  await f.op({type:'updateWorkspace',patch:{resourceRoots:{payload:{path:path.relative(f.config.workspaceRoot,assets)}}}});
  await f.op({type:'createItem',boardId:'resources',item:{id:'html',title:'HTML',content:{kind:'html',resource:{rootId:'payload',path:'page/index.html'}}}});
  assert.equal((await fetch(f.base+'/resources/payload/page/index.html')).status,200);
  const asset=await fetch(f.base+'/resources/payload/page/style.css');assert.equal(await asset.text(),'first');
  const range=await fetch(f.base+'/resources/payload/page/style.css',{headers:{range:'bytes=1-3'}});assert.equal(range.status,206);assert.equal(await range.text(),'irs');
  assert.equal((await fetch(f.base+'/resources/payload/.secret')).status,403);
  assert.equal((await fetch(f.base+'/resources/payload/escape.txt')).status,403);
  assert.equal((await fetch(f.base+'/resources/missing/page/index.html')).status,404);
  const first=await f.get('/api/boards/resources/live');await writeFile(path.join(assets,'page','style.css'),'second');await new Promise(resolve=>setTimeout(resolve,800));
  const second=await f.get('/api/boards/resources/live');assert.notEqual(second.items.html.revision,first.items.html.revision);assert.equal(second.manifestRevision,first.manifestRevision);
});

test('CLI initializes empty workspaces and operates through the same transaction model',async t=>{
  const f=await fixture(t);
  assert.equal(JSON.parse(await main(['workspace','init','--config',f.configPath])).dryRun,true);
  assert.equal((await f.get('/api/workspace')).enabled,false);
  await main(['workspace','init','--config',f.configPath,'--apply']);assert.equal((await f.get('/api/workspace')).enabled,true);
  await main(['board','create','cli-board','--config',f.configPath,'--title','CLI board']);
  const operation=path.join(f.root,'operation.json');await writeFile(operation,JSON.stringify({type:'createItem',boardId:'cli-board',item:{id:'cli-item',title:'CLI item'}}));
  await main(['workspace','op','--config',f.configPath,'--file',operation]);
  await main(['status','--config',f.configPath,'--board','cli-board','cli-item','building','Observed work']);
  assert.equal(JSON.parse(await main(['item','show','cli-item','--config',f.configPath])).build.state,'building');
  assert.equal((await f.get('/api/items/cli-item')).build.message,'Observed work');
  assert.deepEqual((await readdir(f.boards)).sort(),['.tinka']);
});

async function waitForFile(file){
  const deadline=Date.now()+2000;
  while(Date.now()<deadline){try{await readFile(file);return;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(`Lock was not acquired: ${path.basename(path.dirname(file))}`);
}

test('migration waits for an acknowledged legacy notes write and imports its final feedback',async t=>{
  const f=await fixture(t,{legacy:true}),lock=path.join(f.boards,'legacy/.state/.notes.lock');
  await mkdir(lock);
  const saving=f.write('/api/boards/legacy/notes',{'first/alpha':{note:'Saved during conversion',star:true,updatedAt:99}},{method:'PUT'});
  await waitForFile(path.join(f.config.workspaceRoot,'.mutation-lock/owner.json'));
  let finished=false;const migrating=f.write('/api/workspace/migrate',{dryRun:false}).then(response=>{finished=true;return response;});
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(finished,false);
  await rm(lock,{recursive:true});
  assert.equal((await saving).status,200);assert.equal((await migrating).status,200);
  const item=(await f.get('/api/workspace')).items.find(item=>item.legacy?.key==='first/alpha');assert.equal(item.review.note,'Saved during conversion');
});

test('migration serializes legacy CLI status before capturing canonical build state',async t=>{
  const f=await fixture(t,{legacy:true}),lock=path.join(f.boards,'legacy/.build-state.lock');
  await mkdir(lock);
  const saving=main(['status','--config',f.configPath,'--board','legacy','first/alpha','ready','Checked before conversion']);
  await waitForFile(path.join(f.config.workspaceRoot,'.mutation-lock/owner.json'));
  let finished=false;const migrating=f.write('/api/workspace/migrate',{dryRun:false}).then(response=>{finished=true;return response;});
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(finished,false);
  await rm(lock,{recursive:true});
  assert.match(await saving,/ready/);assert.equal((await migrating).status,200);
  const item=(await f.get('/api/workspace')).items.find(item=>item.legacy?.key==='first/alpha');assert.equal(item.build.message,'Checked before conversion');assert.equal(item.build.state,'ready');
});

test('migrated revision dependencies outside the entry folder keep live refresh tracking',async t=>{
  const f=await fixture(t,{legacy:true}),boardRoot=path.join(f.boards,'legacy');
  const manifest=JSON.parse(await readFile(path.join(boardRoot,'rounds.json'),'utf8'));
  manifest.revisions['first/alpha'][0].dependencies=['variant-data'];
  await writeFile(path.join(boardRoot,'rounds.json'),JSON.stringify(manifest));
  await mkdir(path.join(boardRoot,'variant-data'));
  await writeFile(path.join(boardRoot,'variant-data','settings.json'),'{"theme":"first"}');
  assert.equal((await f.write('/api/workspace/migrate',{dryRun:false})).status,200);
  const item=(await f.get('/api/workspace')).items.find(item=>item.legacy?.key==='first/alpha');
  const before=await f.get('/api/boards/legacy/live');
  await writeFile(path.join(boardRoot,'variant-data','settings.json'),'{"theme":"second"}');
  await new Promise(resolve=>setTimeout(resolve,800));
  const after=await f.get('/api/boards/legacy/live');
  assert.notEqual(after.items[item.id].revision,before.items[item.id].revision);
  assert.equal(after.manifestRevision,before.manifestRevision);
  assert.equal(after.shellRevision,before.shellRevision);
});
