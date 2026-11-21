import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {applyOperation,readWorkspace,getBoardSnapshot} from '../lib/workspace.mjs';
import {callTool} from '../lib/tools.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {listFeedback} from '../lib/feedback.mjs';
const actor={id:'owner',label:'Owner',kind:'human'};
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'tinka-guarded-'));t.after(()=>rm(dir,{recursive:true,force:true}));const config={boardsRoot:path.join(dir,'boards')};await mkdir(config.boardsRoot);const board=(await applyOperation(config,{type:'createBoard',id:'ideas',title:'Ideas'})).result;const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{id:'draft',title:'Draft',description:'Before'}})).result;return {config,board,item,dir};}
const fact=(kind,id,field,value,present=true)=>({kind,[kind==='boardField'?'boardId':kind==='itemField'?'itemId':'threadId']:id,field,present,...(present?{value}:{})});
const guarded=(operation,facts,operationId='save')=>({type:'guarded',operationId,operation,baseline:{version:1,facts}});
const itemFact=(field,value,present=true)=>fact('itemField','draft',field,value,present);
const fails=(code,status)=>error=>error.code===code&&error.status===status;
test('graph common saves allow unrelated changes; same-target facts and exact replay stay atomic',async t=>{
 const {config}=await fixture(t),save=guarded({type:'updateItem',itemId:'draft',patch:{description:'After'}},[itemFact('description','Before')]);
 await applyOperation(config,{type:'review',itemId:'draft',patch:{star:true}});
 const first=await applyOperation(config,save);assert.equal(first.result.itemId,'draft');
 await applyOperation(config,{type:'updateItem',itemId:'draft',patch:{description:'Later'}});
 assert.deepEqual(await applyOperation(config,save),{...first,replayed:true});
 await assert.rejects(applyOperation(config,{...save,operationId:'other'}),fails('GUARDED_PRECONDITION_CHANGED',409));
 await assert.rejects(applyOperation(config,{...save,operation:{...save.operation,patch:{description:'Different'}}}),/different input/);
 const snapshot=await readWorkspace(config);assert.equal(snapshot.items.find(i=>i.id==='draft').description,'Later');assert.equal(snapshot.items.find(i=>i.id==='draft').review.star,true);
});
test('guarded board order/settings use concrete patch facts and legacy revisions remain strict',async t=>{
 const {config}=await fixture(t),board=await getBoardSnapshot(config,'ideas');
 await applyOperation(config,{type:'review',itemId:'draft',patch:{note:'peer'}});
 await applyOperation(config,guarded({type:'updateBoard',boardId:'ideas',patch:{reviewOrder:board.reviewOrder,background:{color:'#fff'}}},[fact('boardField','ideas','reviewOrder',board.reviewOrder),fact('boardField','ideas','background',undefined,false)]));
 await assert.rejects(applyOperation(config,{type:'review',itemId:'draft',patch:{star:true},expectedRevision:board.revision}),fails('WORKSPACE_REVISION_CHANGED',409));
 await applyOperation(config,{type:'review',itemId:'draft',patch:{star:true}});
});
test('missing versus null, field groups, malformed and unsupported envelopes fail closed',async t=>{
 const {config}=await fixture(t);
 for(const request of [guarded({type:'updateItem',itemId:'draft',patch:{description:'x'}},[itemFact('title','Draft')]),guarded({type:'remove',boardId:'ideas',placementIds:[]},[itemFact('title','Draft')]),...['constructor','toString','__proto__'].map(type=>guarded({type},[itemFact('title','Draft')])),{...guarded({type:'review',itemId:'draft',patch:{note:'x'}},[itemFact('review.note','')]),expectedRevision:0},guarded({type:'updateItem',itemId:'draft',patch:{content:null}},[itemFact('content',undefined,false)])])await assert.rejects(applyOperation(config,request),fails('GUARDED_BASELINE_INVALID',400));
 await assert.rejects(applyOperation(config,guarded({type:'updateBoard',boardId:'ideas',patch:{background:null}},[fact('boardField','ideas','background',null)])),fails('GUARDED_PRECONDITION_CHANGED',409));
 const item=(await readWorkspace(config)).items.find(i=>i.id==='draft');
 await applyOperation(config,guarded({type:'updateItem',itemId:'draft',patch:{content:{kind:'note',text:'content'}}},['content','preview','revisions','build'].map(field=>itemFact(field,item[field],Object.hasOwn(item,field)))));
});
test('review fields are independently guarded and named tool exposes additive transport',async t=>{
 const {config}=await fixture(t);
 await applyOperation(config,{type:'review',itemId:'draft',patch:{star:true}});
 const request=guarded({type:'review',itemId:'draft',patch:{note:'saved'}},[itemFact('review.note','')]);
 const {type,...input}=request;assert.ok((await callTool(config,'workspace.guarded',input)).result);
 const item=(await readWorkspace(config)).items.find(i=>i.id==='draft');assert.equal(item.review.star,true);assert.equal(item.review.note,'saved');
});
test('scoped comment edit/delete/status compare message facts, replay before guards, and no-op validates revision',async t=>{
 const {config}=await fixture(t);await applyOperation(config,{type:'addComment',boardId:'ideas',id:'thread',author:actor,body:'Original'});
 const fs=[fact('commentField','thread','body','Original'),fact('commentField','thread','refs',[]),fact('commentField','thread','deletedAt',undefined,false)];
 const request=guarded({type:'editComment',threadId:'thread',actor,body:'Edited'},fs);
 await applyOperation(config,{type:'review',itemId:'draft',patch:{note:'Unrelated'}});
 const response=await applyOperation(config,request);assert.equal((await applyOperation(config,request)).replayed,true);
 await assert.rejects(applyOperation(config,{...request,operationId:'stale'}),fails('GUARDED_PRECONDITION_CHANGED',409));
 const status=guarded({type:'setCommentStatus',threadId:'thread',actor,status:'open'},[fact('commentField','thread','status','open'),fact('commentField','thread','to',null)],'noop');
 assert.equal((await applyOperation(config,status)).result.unchanged,true);assert.equal((await applyOperation(config,status)).replayed,true);
 assert.equal((await applyOperation(config,{type:'setCommentStatus',threadId:'thread',actor,status:'open',expectedRevision:0})).result.unchanged,true); // Legacy fast no-op remains compatible.
 await applyOperation(config,guarded({type:'setCommentStatus',threadId:'thread',actor,status:'working'},status.baseline.facts,'status'));
 await assert.rejects(applyOperation(config,{...status,operationId:'stale-noop'}),fails('GUARDED_PRECONDITION_CHANGED',409));
 await applyOperation(config,guarded({type:'deleteComment',threadId:'thread',actor},fs.map(f=>f.field==='body'?{...f,value:'Edited'}:f),'delete'));
 assert.equal((await listFeedback(config,{threadId:'thread',includeBodies:true,includeDeleted:true,includeHistory:true})).threads[0].body,'Edited');
 assert.ok(response.revision);
});

test('concurrent guarded replacements serialize; a multi-field conflict writes nothing',async t=>{
 const {config}=await fixture(t),before=(await readWorkspace(config)).revision;
 const request=value=>guarded({type:'updateItem',itemId:'draft',patch:{title:value,description:value}},[itemFact('title','Draft'),itemFact('description','Before')],value);
 const results=await Promise.allSettled([applyOperation(config,request('first')),applyOperation(config,request('second'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'GUARDED_PRECONDITION_CHANGED');
 const snapshot=await readWorkspace(config),item=snapshot.items.find(i=>i.id==='draft');assert.equal(snapshot.revision,before+1);assert.equal(item.title,item.description);
});
test('HTTP operations and tools retain identity guards and actionable conflict codes',async t=>{
 const {config:raw,dir}=await fixture(t),configPath=path.join(dir,'config.json');await writeFile(configPath,JSON.stringify({schemaVersion:1,port:43821,projectLabel:'Guarded fixture',...raw}));const config=await loadConfig(configPath);
 const server=await listen(config,{port:0});t.after(()=>closeAppServer(server));const base=`http://127.0.0.1:${server.address().port}`;
 const request=guarded({type:'review',itemId:'draft',patch:{note:'HTTP'}},[itemFact('review.note','')]);
 const post=(route,value,workspace=config.workspaceId)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':workspace},body:JSON.stringify(value)});
 assert.equal((await post('/api/operations',request,'wrong')).status,403);
 assert.equal((await post('/api/operations',request)).status,200);
 const stale=await post('/api/operations',{...request,operationId:'stale'}),body=await stale.json();assert.equal(stale.status,409);assert.equal(body.code,'GUARDED_PRECONDITION_CHANGED');assert.equal(body.conflict.field,'review.note');
 const invalid=await post('/api/operations',{...request,baseline:{version:1,facts:[]}});assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'GUARDED_BASELINE_INVALID');
 const next=guarded({type:'review',itemId:'draft',patch:{note:'Tool'}},[itemFact('review.note','HTTP')],'tool'),{type,...args}=next;
 const tool=await post('/api/tools/call',{name:'workspace.guarded',arguments:args});assert.equal(tool.status,200);assert.equal((await tool.json()).result.itemId,'draft');
});
