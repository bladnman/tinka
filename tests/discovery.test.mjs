import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {applyOperation,getBoardSnapshot,getItemSnapshot,emptyWorkspace,validateWorkspaceState,workspaceView,workspaceHeader} from '../lib/workspace.mjs';
import {searchWorkspace,rebuildDiscovery,inspectWorkspace,discoveryMetrics} from '../lib/discovery.mjs';
import {storeMetrics,clearDocumentCache,withScopedTransaction} from '../lib/store.mjs';
import {listTools,callTool} from '../lib/tools.mjs';
import {main} from '../lib/cli.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'tinka-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));const config={boardsRoot:path.join(dir,'boards')};await mkdir(config.boardsRoot);const op=(type,fields={})=>applyOperation(config,{type,...fields});const parent=(await op('createBoard',{id:'releases',title:'Releases'})).result;return {dir,config,op,parent,root:path.join(config.boardsRoot,'.tinka')};}

test('selective item/board reads recover the journal and ignore unrelated corrupt bodies',async t=>{
  const f=await fixture(t),item=(await f.op('createItem',{boardId:'releases',item:{id:'local',title:'Local'}})).result;
  await f.op('createItem',{item:{id:'unrelated',title:'Unrelated',content:{kind:'note',text:'x'.repeat(20000)}}});
  await writeFile(path.join(f.root,'items/unrelated.json'),'{broken');clearDocumentCache();storeMetrics({reset:true});
  assert.equal((await getItemSnapshot(f.config,item.itemId)).title,'Local');
  assert.equal((await getBoardSnapshot(f.config,'releases')).items.local.title,'Local');
  assert.ok(storeMetrics().documentReads<=3);
  const header=JSON.parse(await readFile(path.join(f.root,'workspace.json'))),local=await getItemSnapshot(f.config,'local');local.title='Recovered';header.revision++;
  await writeFile(path.join(f.root,'pending.json'),JSON.stringify({schemaVersion:1,writes:[{path:'items/local.json',value:local},{path:'workspace.json',value:header}]}));
  assert.equal((await getItemSnapshot(f.config,'local')).title,'Recovered');
  const inspection=await inspectWorkspace(f.config);assert.equal(inspection.valid,false);assert.ok(inspection.issues.some(issue=>issue.includes('unrelated.json')));
});

test('deep discovery is deterministic, metadata-first, bounded and revision-bound',async t=>{
  const f=await fixture(t);let parent='releases';
  for(let i=0;i<8;i++){const id=`level-${i}`;await f.op('createBoard',{id,title:`Release ${i}`,parentBoardId:parent});parent=id;}
  await f.op('createItem',{boardId:parent,item:{id:'deep-note',title:'Quiet launch',description:'About stable discovery',content:{kind:'note',text:'secret body phrase'}}});
  await f.op('createItem',{boardId:parent,item:{id:'second-note',title:'Quiet second'}});
  const deep=await searchWorkspace(f.config,{query:'quiet',kind:'items',withinBoardId:'releases',limit:1,sort:'title',direction:'asc'});
  assert.equal(deep.results[0].id,'deep-note');assert.ok(deep.nextCursor);assert.ok(Buffer.byteLength(JSON.stringify(deep))<3000);assert.equal(deep.results[0].url,'/app/item.html?item=deep-note');
  const next=await searchWorkspace(f.config,{query:'quiet',kind:'items',withinBoardId:'releases',limit:1,sort:'title',direction:'asc',cursor:deep.nextCursor});assert.equal(next.results[0].id,'second-note');
  assert.equal((await searchWorkspace(f.config,{query:'secret body phrase'})).total,0);
  assert.equal((await searchWorkspace(f.config,{query:'secret body phrase',body:true})).results[0].id,'deep-note');
  await f.op('review',{itemId:'deep-note',patch:{star:true}});
  await assert.rejects(searchWorkspace(f.config,{query:'quiet',kind:'items',withinBoardId:'releases',limit:1,sort:'title',direction:'asc',cursor:deep.nextCursor}),{status:409});
  clearDocumentCache();storeMetrics({reset:true});const warm=await searchWorkspace(f.config,{query:'stable discovery'});assert.equal(warm.indexRebuilt,false);assert.equal(storeMetrics().documentReads,0);
  const home=await workspaceView(f.config,'home');assert.equal(home.boards.length,1);assert.equal(home.boards[0].itemCount,1);assert.equal(home.boards[0].placements,undefined);
  const graph=await workspaceView(f.config,'graph');assert.equal(graph.items.find(item=>item.id==='deep-note').content,undefined);assert.equal(graph.items.find(item=>item.id==='deep-note').review,undefined);assert.equal(graph.boards.find(board=>board.id==='level-7').decorations,undefined);
  assert.equal((await workspaceHeader(f.config)).revision,graph.revision);
});

test('shards rebuild after missing/corrupt/stale data; scoped feedback retains graph summaries',async t=>{
  const f=await fixture(t);await f.op('createItem',{boardId:'releases',item:{id:'proposal',title:'Before'}});await rebuildDiscovery(f.config);
  const shard=JSON.parse(await readFile(path.join(f.root,'.discovery/manifest.json'))).shards.find(s=>s.collection==='items'&&s.count);
  const changed=JSON.parse(await readFile(path.join(f.root,'.discovery',shard.name)));changed[0].title='Valid JSON corruption';await writeFile(path.join(f.root,'.discovery',shard.name),JSON.stringify(changed));assert.equal((await searchWorkspace(f.config,{})).indexRebuilt,true);
  const file=path.join(f.root,'items/proposal.json'),item=JSON.parse(await readFile(file));item.title='External edit';await writeFile(file,JSON.stringify(item));
  assert.equal((await searchWorkspace(f.config,{query:'External edit'})).results[0].id,'proposal');
  discoveryMetrics({reset:true});await f.op('addComment',{id:'thread',boardId:'releases',author:{id:'agent',label:'Agent',kind:'agent'},body:'Review'});
  assert.equal(discoveryMetrics().sourceStats,0);assert.equal(discoveryMetrics().shardReads,1);assert.equal(discoveryMetrics().shardWrites,1);
  assert.equal(await readFile(path.join(f.root,'.discovery/.gitignore'),'utf8'),'*\n');
  await writeFile(path.join(f.root,'.discovery/.gitignore'),'custom rule\n');await rebuildDiscovery(f.config);assert.equal(await readFile(path.join(f.root,'.discovery/.gitignore'),'utf8'),'custom rule\n');
  clearDocumentCache();storeMetrics({reset:true});const after=await searchWorkspace(f.config,{query:'External edit'});assert.equal(after.indexRebuilt,false);assert.equal(storeMetrics().documentReads,0);
  await rm(path.join(f.root,'.discovery',shard.name));assert.equal((await searchWorkspace(f.config,{})).indexRebuilt,true);
  const outside=path.join(f.dir,'outside');await writeFile(outside,'[]');await rm(path.join(f.root,'.discovery',shard.name));await symlink(outside,path.join(f.root,'.discovery',shard.name));
  await assert.rejects(searchWorkspace(f.config,{}),{status:403});assert.equal(await readFile(outside,'utf8'),'[]');
});

test('inventory still counts per-document sources with corrupt home/header and never repairs canonical files',async t=>{
  const f=await fixture(t),file=path.join(f.root,'workspace.json');await writeFile(file,'{corrupt');
  const result=await inspectWorkspace(f.config);assert.equal(result.valid,false);assert.equal(result.counts.boards,1);assert.equal(await readFile(file,'utf8'),'{corrupt');
});

test('iterative validation handles deep containment and rejects a closing cycle',()=>{
  const state=emptyWorkspace(),count=12000;
  for(let index=0;index<count;index++){const id=`b${index}`,owner=`o${index}`;state.items[owner]={schemaVersion:2,id:owner,title:id,description:'',childBoardId:id,revisions:[],review:{note:'',star:false},build:{state:'ready',message:''}};state.boards[id]={schemaVersion:2,id,title:id,ownerItemId:owner,placements:index+1<count?[{id:`p${index}`,itemId:`o${index+1}`,x:0,y:0,width:100,height:100,z:0}]:[],reviewOrder:[],rounds:[],decorations:[]};}
  state.metadata.homeBoardIds=['b0'];validateWorkspaceState(state);
  state.boards[`b${count-1}`].placements.push({id:'back',itemId:'o0',x:0,y:0,width:100,height:100,z:0});assert.throws(()=>validateWorkspaceState(state),{status:409});
});

test('catalog matches offline schemas, all named dispatches exist and targeted descriptions stay small',async t=>{
  const f=await fixture(t),offline=JSON.parse(await readFile(new URL('../lib/tools.json',import.meta.url)));assert.deepEqual(listTools(),offline);
  const summary=JSON.parse(await main(['tools','list','--summary'])),description=JSON.parse(await main(['tools','describe','decoration.create']));assert.ok(summary.tools.every(tool=>!tool.inputSchema));assert.ok(description.inputSchema.properties.decoration.properties.from.oneOf);assert.ok(Buffer.byteLength(JSON.stringify(description))<12000);
  assert.ok(listTools().tools.every(tool=>tool.operation||['workspace.search','workspace.recent','workspace.show','workspace.view','workspace.rebuildIndex','workspace.inspect','workspace.migrate','workspace.apply','item.get','board.get','board.geometry','link.preview','files.import','feedback.list','feedback.comment','feedback.reply','feedback.resolve','item.vote','highlight.add','highlight.list','highlight.remove'].includes(tool.name)));
  await assert.rejects(callTool(f.config,'item.create',{boardId:'releases',item:{title:'Okay'},placement:{unexpected:1}}),{status:400});
  await assert.rejects(callTool(f.config,'files.import',{workspaceId:'fixture',targetBoardId:'releases',targetPosition:{x:0,y:0},paths:['/dev/zero'],expectedRevision:1,operationId:'device'}),{status:400});
  await assert.rejects(callTool(f.config,'files.import',{workspaceId:'fixture',targetBoardId:'releases',targetPosition:{x:0,y:0},paths:['/etc/hosts'],expectedRevision:1,operationId:'http'},{transport:'http'}),{status:400});
  const header=await readFile(path.join(f.root,'workspace.json'),'utf8');
  for(const op of [null,[],{type:'comment',expectedRevision:-1},{type:'comment',operationId:'../bad'}])await assert.rejects(withScopedTransaction(f.config,op,()=>({})),{status:400});
  assert.equal(await readFile(path.join(f.root,'workspace.json'),'utf8'),header);
});

// Cache fingerprints must not bypass canonical collection containment.
test('warm discovery rejects escaped item and board collection directories',async t=>{
  for(const collection of ['items','boards']){
    const f=await fixture(t);await f.op('createItem',{boardId:'releases',item:{id:'private-title',title:'Private cache title'}});
    await searchWorkspace(f.config,{query:'Private cache title'});
    const directory=path.join(f.root,collection),outside=path.join(f.dir,`escaped-${collection}`);
    await rename(directory,outside);await symlink(outside,directory);
    await assert.rejects(searchWorkspace(f.config,{query:'Private cache title'}),{status:403});
    const report=await inspectWorkspace(f.config);assert.equal(report.valid,false);assert.ok(report.issues.some(issue=>issue.includes('Metadata directory leaves workspace')));
  }
});
