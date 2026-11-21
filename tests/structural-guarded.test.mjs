import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {applyOperation,applyFileImport,readWorkspace,getBoardSnapshot,workspaceView} from '../lib/workspace.mjs';
import {structuralBaseline,structuralItem} from '../public/structural-guard.js';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {callTool} from '../lib/tools.mjs';
const conflict=error=>error.status===409&&error.code==='GUARDED_PRECONDITION_CHANGED';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'tinka-structural-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={boardsRoot:path.join(root,'boards')};await mkdir(config.boardsRoot);
 for(const id of ['a','b'])await applyOperation(config,{type:'createBoard',id,title:id});
 const first=(await applyOperation(config,{type:'createItem',boardId:'a',item:{id:'one',title:'One'},placement:{x:0,y:0}})).result.placementIds[0];
 const second=(await applyOperation(config,{type:'createItem',boardId:'a',item:{id:'two',title:'Two'},placement:{x:500,y:0}})).result.placementIds[0];
 return {config,root,first,second};
}
const context=snapshot=>({boards:[snapshot,...Object.values(snapshot.childBoards||{})],items:snapshot.items,resourceRoots:snapshot.resourceRoots,structural:snapshot.structural});
async function guard(config,operation,id='save',ctx){const baseline=structuralBaseline(operation,ctx||context(await getBoardSnapshot(config,operation.boardId||operation.sourceBoardId||operation.targetBoardId)));assert.ok(baseline);return {type:'guarded',operationId:id,operation,baseline};}
const rectangle=(id,x=50)=>({id,type:'region',shape:'rectangle',x,y:300,width:120,height:100,color:'#ffffff',text:''});
test('first structural submit accepts disjoint board and same-board peers; target changes reject, replay remains exact',async t=>{
 const {config,first,second}=await fixture(t);
 const operation={type:'updatePlacement',boardId:'a',placementId:first,patch:{x:80}};
 const request=await guard(config,operation);
 await applyOperation(config,{type:'updatePlacement',boardId:'a',placementId:second,patch:{y:30}});
 await applyOperation(config,{type:'updateBoard',boardId:'b',patch:{title:'Unrelated'}});
 await applyOperation(config,{type:'review',itemId:'one',patch:{note:'Current canonical note'}});
 const response=await applyOperation(config,request);assert.ok(response.history);
 assert.deepEqual(await applyOperation(config,request),{...response,replayed:true});
 await assert.rejects(applyOperation(config,{...request,operationId:'stale'}),conflict);
 const snapshot=await getBoardSnapshot(config,'a');assert.equal(snapshot.placements.find(p=>p.id===first).x,80);assert.equal(snapshot.items.one.review.note,'Current canonical note');
 await applyOperation(config,{type:'restoreMovement',history:response.history});
 assert.equal((await getBoardSnapshot(config,'a')).placements.find(p=>p.id===first).x,0);
});
test('canonical lifecycle shared across boards and new topology invalidate the same frozen edit',async t=>{
 const {config,first}=await fixture(t);
 const request=await guard(config,{type:'updatePlacement',boardId:'a',placementId:first,patch:{x:20}});
 await applyOperation(config,{type:'reference',itemIds:['one'],targetBoardId:'b'});
 await applyOperation(config,{type:'archiveItem',itemIds:['one'],archived:true});
 await assert.rejects(applyOperation(config,request),conflict);
 await applyOperation(config,{type:'archiveItem',itemIds:['one'],archived:false});
 const topology=await guard(config,request.operation,'topology');
 await applyOperation(config,{type:'createBoard',itemId:'one',id:'child',title:'Child'});
 await assert.rejects(applyOperation(config,topology),conflict);
});
test('new attachment, endpoint target edits and group/container changes are dependency conflicts',async t=>{
 const {config,first,second}=await fixture(t);
 const request=await guard(config,{type:'updatePlacement',boardId:'a',placementId:first,patch:{x:20}});
 await applyOperation(config,{type:'createDecoration',boardId:'a',decoration:{id:'arrow',type:'line',x:0,y:0,width:100,height:100,color:'#000000',text:'',from:{placementId:first,side:'right'},to:{placementId:second,side:'left'}}});
 await assert.rejects(applyOperation(config,request),conflict);
 const arrow=await guard(config,{type:'updateDecoration',boardId:'a',decorationId:'arrow',patch:{text:'label'}},'arrow');
 await applyOperation(config,{type:'updatePlacement',boardId:'a',placementId:second,patch:{y:10}});
 await assert.rejects(applyOperation(config,arrow),conflict);
 const beforeGroup=await guard(config,request.operation,'group');
 await applyOperation(config,{type:'groupOccurrences',boardId:'a',placementIds:[first,second]});
 await assert.rejects(applyOperation(config,beforeGroup),conflict);
});
test('cross-board move uses identity-only destination snapshot, preserves shared item and signed undo',async t=>{
 const {config,first}=await fixture(t),source=await getBoardSnapshot(config,'a'),graph=await workspaceView(config,'graph',{covers:false});
 const ctx={...graph,boards:[...graph.boards.filter(b=>b.id!=='a'),source],items:Object.fromEntries([...graph.items,...Object.values(source.items)].map(i=>[i.id,i]))};
 const request=await guard(config,{type:'move',sourceBoardId:'a',placementIds:[first],targetBoardId:'b',targetPosition:{x:10,y:10}},'move',ctx);
 await applyOperation(config,{type:'createItem',boardId:'b',item:{title:'Peer'}});
 const response=await applyOperation(config,request);assert.equal(response.result.itemIds[0],'one');assert.ok(response.history);
 await applyOperation(config,{type:'restoreMovement',history:response.history});
 assert.ok((await getBoardSnapshot(config,'a')).placements.some(p=>p.id===first&&!p.removedAt));
});
test('atomic multi-target failure and structural deletion leave no partial mutations',async t=>{
 const {config,first,second}=await fixture(t);
 const request=await guard(config,{type:'arrangePlacements',boardId:'a',placements:[{id:first,x:50,y:20},{id:second,x:600,y:20}]});
 await applyOperation(config,{type:'updatePlacement',boardId:'a',placementId:second,patch:{x:800}});
 const revision=(await readWorkspace(config)).revision;await assert.rejects(applyOperation(config,request),conflict);
 const snapshot=await getBoardSnapshot(config,'a');assert.equal(snapshot.revision,revision);assert.equal(snapshot.placements.find(p=>p.id===first).x,0);
 const remove=await guard(config,{type:'remove',boardId:'a',placementIds:[first,second]},'remove');
 const response=await applyOperation(config,remove);assert.ok(response.history);
 assert.equal((await getBoardSnapshot(config,'a')).placements.filter(p=>!p.removedAt).length,0);
 await applyOperation(config,{type:'restoreMovement',history:response.history});
 assert.equal((await getBoardSnapshot(config,'a')).placements.filter(p=>!p.removedAt).length,2);
});
test('guarded imports accept unrelated revisions and reject stale destination before creating resources',async t=>{
 const {config}=await fixture(t),snapshot=await getBoardSnapshot(config,'a');
 const baseline=structuralBaseline({type:'importFiles',targetBoardId:'a'},context(snapshot));
 const metadata={type:'guardedImport',workspaceId:snapshot.workspaceId,targetBoardId:'a',targetPosition:{x:20,y:20},operationId:'import',baseline};
 const file={name:'sample.pdf',bytes:Buffer.from('%PDF-1.7\nfixture\n%%EOF')};
 await applyOperation(config,{type:'updateBoard',boardId:'b',patch:{description:'Other'}});
 const result=await applyFileImport(config,metadata,[file]);assert.ok(result.history);assert.equal((await applyFileImport(config,metadata,[file])).replayed,true);
 const before=(await readdir(path.join(config.boardsRoot,'imports'))).sort();
 await applyOperation(config,{type:'archiveItem',itemIds:[snapshot.ownerItemId],archived:true});
 await assert.rejects(applyFileImport(config,{...metadata,operationId:'stale-import'},[file]),conflict);
 assert.deepEqual((await readdir(path.join(config.boardsRoot,'imports'))).sort(),before);
 await assert.rejects(applyFileImport(config,{...metadata,operationId:'bad-import'},[file,{name:'bad.png',bytes:Buffer.from('invalid')}]),/Only PNG/);
 assert.deepEqual((await readdir(path.join(config.boardsRoot,'imports'))).sort(),before);
});
test('modern snapshot markers are required, legacy revision shape remains strict, tool/catalog v2 works',async t=>{
 const {config,first}=await fixture(t),snapshot=await getBoardSnapshot(config,'a');
 const operation={type:'updatePlacement',boardId:'a',placementId:first,patch:{x:5}};
 const old=structuredClone(snapshot);delete old.structural;
 assert.equal(structuralBaseline(operation,context(old)),null);
 assert.equal(structuralBaseline(operation,{...context(old),structural:{version:2,scope:'graph'}}),null);
 const request=await guard(config,operation);
 const {type,...input}=request;await callTool(config,'workspace.guarded',input);
 await assert.rejects(applyOperation(config,{...operation,expectedRevision:snapshot.revision}),error=>error.code==='WORKSPACE_REVISION_CHANGED');
 const missing=await guard(config,{...operation,patch:{x:10}},'missing');missing.baseline.facts=[];
 await assert.rejects(applyOperation(config,missing),error=>error.code==='GUARDED_BASELINE_INVALID');
 const unsupported={type:'guarded',operationId:'unsupported',operation:{type:'deleteItem',itemIds:['one']},baseline:request.baseline};
 await assert.rejects(applyOperation(config,unsupported),error=>error.code==='GUARDED_BASELINE_INVALID');
});
test('containers and whole-decoration batches compare full dependent structure',async t=>{
 const {config}=await fixture(t);
 await applyOperation(config,{type:'createDecoration',boardId:'a',decoration:rectangle('left')});
 await applyOperation(config,{type:'createDecoration',boardId:'a',decoration:rectangle('right',250)});
 await applyOperation(config,{type:'createDecoration',boardId:'a',decoration:{id:'container',type:'region',x:10,y:200,width:144,height:64,color:'#ffffff',text:'',container:{layout:'horizontal',children:['left','right']}}});
 const request=await guard(config,{type:'updateDecoration',boardId:'a',decorationId:'left',patch:{width:130}},'container-child');
 await applyOperation(config,{type:'updateDecoration',boardId:'a',decorationId:'right',patch:{width:150}});
 await assert.rejects(applyOperation(config,request),conflict);
 const snapshot=await getBoardSnapshot(config,'a'),batch=await guard(config,{type:'updateBoard',boardId:'a',patch:{decorations:snapshot.decorations.map(d=>({...d,color:'#eeeeee'}))}},'batch');
 await applyOperation(config,{type:'createDecoration',boardId:'a',decoration:rectangle('new',600)});
 await assert.rejects(applyOperation(config,batch),conflict);
});

test('guarded import identity denial precedes stale target facts, without payload directories',async t=>{
 const {config}=await fixture(t),snapshot=await getBoardSnapshot(config,'a');
 const baseline=structuralBaseline({type:'importFiles',targetBoardId:'a'},context(snapshot));
 await applyOperation(config,{type:'archiveItem',itemIds:[snapshot.ownerItemId],archived:true});
 await assert.rejects(applyFileImport(config,{type:'guardedImport',workspaceId:'other-workspace',targetBoardId:'a',targetPosition:{x:0,y:0},operationId:'foreign',baseline},[{name:'one.pdf',bytes:Buffer.from('%PDF-1.7\nfixture\n%%EOF')}]),error=>error.status===403);
 await assert.rejects(readdir(path.join(config.boardsRoot,'imports')),error=>error.code==='ENOENT');
});
test('resource registrations and failed multi-element validation cannot partially commit',async t=>{
 const {config,first,second}=await fixture(t);
 await mkdir(path.join(config.boardsRoot,'assets'));
 await mkdir(path.join(config.boardsRoot,'other'));
 await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:{assets:{path:'../assets'}}}});
 const request=await guard(config,{type:'createItem',boardId:'a',item:{id:'resource',title:'Resource',content:{kind:'image',resource:{rootId:'assets',path:'image.png'}}}});
 await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:{assets:{path:'../other'}}}});
 await assert.rejects(applyOperation(config,request),conflict);
 const invalid=await guard(config,{type:'arrangePlacements',boardId:'a',placements:[{id:first,x:40,y:50},{id:second,x:20000000,y:10}]},'invalid-multi');
 const before=await readWorkspace(config);await assert.rejects(applyOperation(config,invalid),/finite x\/y/);
 assert.deepEqual(await readWorkspace(config),before);
});
test('HTTP guarded file/document creation accepts unrelated writes and exact response replay',async t=>{
 const {config:raw,root}=await fixture(t),configPath=path.join(root,'config.json');
 await writeFile(configPath,JSON.stringify({schemaVersion:1,port:43821,projectLabel:'Structural fixture',...raw}));
 const config=await loadConfig(configPath),server=await listen(config,{port:0});t.after(()=>closeAppServer(server));
 const base=`http://127.0.0.1:${server.address().port}`,snapshot=await getBoardSnapshot(config,'a');
 const metadata={type:'guardedImport',workspaceId:snapshot.workspaceId,targetBoardId:'a',targetPosition:{x:30,y:40},operationId:'http-import',baseline:structuralBaseline({type:'importFiles',targetBoardId:'a'},context(snapshot))};
 await applyOperation(config,{type:'updateBoard',boardId:'b',patch:{title:'Other board'}});
 const form=()=>{const body=new FormData();body.append('metadata',JSON.stringify(metadata));body.append('files',new Blob(['%PDF-1.7\nfixture\n%%EOF']),'one.pdf');return body;};
 const post=await fetch(base+'/api/imports',{method:'POST',headers:{'x-tinka-workspace':config.workspaceId},body:form()});assert.equal(post.status,200);const saved=await post.json();assert.ok(saved.history);
 const replay=await fetch(base+'/api/imports',{method:'POST',headers:{'x-tinka-workspace':config.workspaceId},body:form()});assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
 const document={...metadata,operationId:'http-document',title:'Document',text:'# Saved'};
 const created=await fetch(base+'/api/documents',{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':config.workspaceId},body:JSON.stringify(document)});
 assert.equal(created.status,200);assert.ok((await created.json()).history);
});

test('targeted structural read carries only supplemental children and generates identical guards',async t=>{
 const {config,first}=await fixture(t);
 const child=(await applyOperation(config,{type:'createBoard',id:'child',title:'Child',parentBoardId:'a'})).result;
 const inner=(await applyOperation(config,{type:'createItem',boardId:'child',item:{id:'inside',title:'Inside'}})).result;
 const snapshot=await getBoardSnapshot(config,'a'),graph=await workspaceView(config,'graph',{covers:false});
 assert.deepEqual(Object.keys(snapshot.structural.items),['inside']);
 assert.ok(Object.keys(snapshot.items).every(id=>!Object.hasOwn(snapshot.structural.items,id)));
 const source={...context(snapshot),boards:[...graph.boards.filter(b=>b.id!=='a'&&b.id!=='child'),snapshot,...Object.values(snapshot.childBoards)],items:{...Object.fromEntries(graph.items.map(item=>[item.id,item])),...snapshot.items}};
 const redundant=structuredClone(source);
 const duplicateMarker=redundant.boards.find(b=>b.id==='a').structural;
 Object.assign(duplicateMarker.items,Object.fromEntries(Object.entries(snapshot.items).map(([id,item])=>[id,structuralItem(item)])));
 const operations=[
   {type:'updatePlacement',boardId:'a',placementId:first,patch:{x:15}},
   {type:'move',sourceBoardId:'child',placementIds:inner.placementIds,targetBoardId:'a',targetPosition:{x:900,y:900}},
   {type:'move',sourceBoardId:'a',placementIds:child.placementIds,targetBoardId:'b',targetPosition:{x:40,y:40}},
   {type:'importFiles',targetBoardId:'a'},
 ];
 const baselines=operations.map(operation=>{
   const compact=structuralBaseline(operation,source);assert.ok(compact);
   assert.deepEqual(compact,structuralBaseline(operation,redundant));return compact;
 });
 await applyOperation(config,{type:'updateBoard',boardId:'b',patch:{title:'Peer edit'}});
 for(let index=0;index<3;index++)await applyOperation(config,{type:'guarded',operationId:`compact-${index}`,operation:operations[index],baseline:baselines[index]});
 const imported=await applyFileImport(config,{type:'guardedImport',workspaceId:snapshot.workspaceId,targetBoardId:'a',targetPosition:{x:0,y:500},operationId:'compact-import',baseline:baselines[3]},[{name:'one.pdf',bytes:Buffer.from('%PDF-1.7\nfixture\n%%EOF')}]);
 assert.ok(imported.history);
 assert.equal((await getBoardSnapshot(config,'a')).items.inside.id,'inside');
 assert.ok((await getBoardSnapshot(config,'b')).placements.some(p=>p.itemId===child.itemId&&!p.removedAt));
});
