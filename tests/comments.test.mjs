// Comment tool (1.1): status with history and the agent rule, addressee, references,
// target labels, author-only edit/delete, list filters and the since position, and the
// read-only agent inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot,readWorkspace} from '../lib/workspace.mjs';
import {listFeedback} from '../lib/feedback.mjs';
import {callTool} from '../lib/tools.mjs';
import {feedbackInbox} from '../lib/inbox.mjs';

const robin={id:'robin',label:'Robin',kind:'human'},sam={id:'sam',label:'Sam',kind:'human'},agent={id:'design-agent',label:'Design agent',kind:'agent'};
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-comments-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'local','config.json');await mkdir(path.join(root,'boards'));
  await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Comments fixture']);
  const config=await loadConfig(configPath),op=operation=>applyOperation(config,operation);
  await op({type:'createBoard',id:'landing',title:'Landing page directions'});
  const item=(await op({type:'createItem',boardId:'landing',item:{title:'A · Pricing hero'},placement:{x:0,y:0,width:300,height:200}})).result;
  const placementId=(await getBoardSnapshot(config,'landing')).placements.find(p=>p.itemId===item.itemId).id;
  await op({type:'createDecoration',boardId:'landing',decoration:{id:'sticky',type:'region',shape:'rectangle',x:400,y:0,width:160,height:150,color:'#f6e6a4',text:'Pricing note\nsecond line'}});
  return {root,config,configPath,op,itemId:item.itemId,placementId};
}
const thread=async(f,id,extra={})=>(await listFeedback(f.config,{threadId:id,...extra})).threads[0];

test('status moves with history; the agent never resolves or reopens a person\'s comment',async t=>{
  const f=await fixture(t);
  const {result}=await f.op({type:'addComment',id:'t1',boardId:'landing',author:robin,body:'Make the price bigger.',anchor:{kind:'point',x:10,y:10,placementId:f.placementId,relative:{x:.5,y:.5}},to:{kind:'agent'},status:'sent'});
  assert.deepEqual(result,{threadId:'t1',status:'sent'});
  let t1=await thread(f,'t1');assert.equal(t1.status,'sent');assert.equal(t1.resolved,false);assert.equal(t1.targetLabel,'A · Pricing hero');assert.deepEqual(t1.to,{kind:'agent'});
  await callTool(f.config,'feedback.setStatus',{threadId:'t1',actor:agent,status:'working'});
  const reply=await callTool(f.config,'feedback.reply',{threadId:'t1',author:agent,body:'Raised the price to 48px.',changes:[{kind:'placement',id:f.placementId,boardId:'landing',label:'A · Pricing hero',note:'Price 32→48px'}],status:'addressed'});
  assert.equal(reply.result.status,'addressed');
  for(const call of [()=>callTool(f.config,'feedback.setStatus',{threadId:'t1',actor:agent,status:'resolved'}),()=>callTool(f.config,'feedback.resolve',{threadId:'t1',resolved:true,actor:agent}),()=>callTool(f.config,'feedback.setStatus',{threadId:'t1',actor:agent,status:'open'})])
    await assert.rejects(call(),{status:403});
  const before=(await readWorkspace(f.config,{covers:false})).revision;
  assert.equal((await callTool(f.config,'feedback.setStatus',{threadId:'t1',actor:agent,status:'addressed'})).result.unchanged,true);
  assert.equal((await readWorkspace(f.config,{covers:false})).revision,before,'same status again writes nothing');
  await callTool(f.config,'feedback.resolve',{threadId:'t1',resolved:true,actor:robin});
  t1=await thread(f,'t1',{includeBodies:true});assert.equal(t1.status,'resolved');assert.equal(t1.resolved,true);
  assert.deepEqual(t1.statusHistory.map(entry=>[entry.status,entry.actor?.id]),[['sent','robin'],['working','design-agent'],['addressed','design-agent'],['resolved','robin']]);
  assert.equal(t1.replies[0].changes[0].note,'Price 32→48px');assert.equal(t1.replies[0].changes[0].exists,true);assert.deepEqual(t1.lastAuthor,agent);
  // An agent may resolve its own thread; an older client resolves without an actor.
  await f.op({type:'addComment',id:'mine',boardId:'landing',author:agent,body:'Should A use the brand green?'});
  assert.equal((await callTool(f.config,'feedback.resolve',{threadId:'mine',resolved:true,actor:agent})).result.status,'resolved');
  await f.op({type:'resolveComment',threadId:'t1',resolved:false});t1=await thread(f,'t1',{includeBodies:true});assert.equal(t1.status,'open');assert.equal(t1.statusHistory.at(-1).actor,undefined);
});

test('a person answering the agent\'s question sends the thread back; to can be changed and cleared',async t=>{
  const f=await fixture(t);
  await f.op({type:'addComment',id:'q',boardId:'landing',author:robin,body:'Try a darker hero.',to:{kind:'agent'},status:'sent'});
  await callTool(f.config,'feedback.reply',{threadId:'q',author:agent,body:'How dark: charcoal or ink?',status:'question'});
  assert.equal((await thread(f,'q')).status,'question');
  await callTool(f.config,'feedback.reply',{threadId:'q',author:robin,body:'Ink.'});
  assert.equal((await thread(f,'q')).status,'sent');
  await f.op({type:'addComment',id:'people',boardId:'landing',author:sam,body:'Robin, is this final?',to:{kind:'human',id:'robin'}});
  assert.equal((await callTool(f.config,'feedback.setStatus',{threadId:'people',actor:robin,to:{kind:'agent',id:'design-agent'},status:'sent'})).result.to.id,'design-agent');
  assert.equal((await callTool(f.config,'feedback.setStatus',{threadId:'people',actor:robin,to:null})).result.to,undefined);
  await assert.rejects(f.op({type:'addComment',boardId:'landing',author:robin,body:'x',status:'sent'}),{status:400});
  await assert.rejects(f.op({type:'addComment',boardId:'landing',author:robin,body:'x',status:'addressed',to:{kind:'agent'}}),{status:400});
});

test('references and the target label report what still exists',async t=>{
  const f=await fixture(t);
  await f.op({type:'addComment',id:'r',boardId:'landing',author:robin,body:'Compare @A · Pricing hero with @Pricing note on @Landing.',anchor:{kind:'point',x:420,y:20,decorationId:'sticky',relative:{x:.1,y:.1}},
    refs:[{kind:'placement',id:f.placementId,boardId:'landing',label:'A · Pricing hero'},{kind:'decoration',id:'sticky',boardId:'landing',label:'Pricing note'},{kind:'board',id:'landing',label:'Landing'},{kind:'item',id:'missing-item',label:'Gone'}]});
  let r=await thread(f,'r');assert.equal(r.targetLabel,'Pricing note');
  assert.deepEqual(r.refs.map(ref=>[ref.kind,ref.exists,ref.state,ref.currentLabel]),[['placement',true,'active','A · Pricing hero'],['decoration',true,'active','Pricing note'],['board',true,'active','Landing page directions'],['item',false,'missing',undefined]]);
  await f.op({type:'updateItem',itemId:f.itemId,patch:{title:'A · Pricing hero v2'}});
  await f.op({type:'removeDecoration',boardId:'landing',decorationId:'sticky'});
  await f.op({type:'remove',boardId:'landing',placementIds:[f.placementId]});
  r=await thread(f,'r',{includeBodies:true});
  assert.deepEqual(r.refs.slice(0,2).map(ref=>[ref.exists,ref.state,ref.label]),[[false,'removed','A · Pricing hero'],[false,'missing','Pricing note']]);
  assert.equal(r.targetLabel,'Pricing note','the snapshot survives the deleted target');assert.equal(r.anchorPoint.detached,true);
  const summary=(await listFeedback(f.config,{boardId:'landing'})).threads.find(entry=>entry.id==='r');assert.equal(summary.refs[0].state,'removed');assert.equal(summary.targetLabel,'Pricing note');
  await assert.rejects(f.op({type:'addComment',boardId:'landing',author:robin,body:'x',refs:[{kind:'decoration',id:'sticky',label:'No board'}]}),{status:400});
});

test('only the author edits or deletes, and history is kept',async t=>{
  const f=await fixture(t);
  await f.op({type:'addComment',id:'e',boardId:'landing',author:robin,body:'First words.'});
  await callTool(f.config,'feedback.reply',{threadId:'e',id:'r1',author:sam,body:'Agreed.'});
  await callTool(f.config,'feedback.edit',{threadId:'e',actor:robin,body:'Better words.',refs:[{kind:'board',id:'landing',label:'Landing'}]});
  await assert.rejects(callTool(f.config,'feedback.edit',{threadId:'e',messageId:'r1',actor:robin,body:'Not mine.'}),{status:403});
  await assert.rejects(callTool(f.config,'feedback.delete',{threadId:'e',actor:{...robin,kind:'agent'}}),{status:403});
  let e=await thread(f,'e',{includeBodies:true});assert.equal(e.body,'Better words.');assert.ok(e.editedAt);assert.equal(e.editHistory,undefined,'history only on request');
  e=await thread(f,'e',{includeBodies:true,includeHistory:true});assert.deepEqual(e.editHistory.map(entry=>entry.body),['First words.']);
  assert.equal((await callTool(f.config,'feedback.delete',{threadId:'e',actor:robin})).result.threadDeleted,false,'a live reply keeps the thread');
  e=await thread(f,'e',{includeBodies:true});assert.equal(e.body,'');assert.deepEqual(e.refs,[]);assert.ok(e.deletedAt);assert.deepEqual(e.lastAuthor,sam);
  await assert.rejects(callTool(f.config,'feedback.edit',{threadId:'e',actor:robin,body:'Too late.'}),{status:409});
  assert.equal((await callTool(f.config,'feedback.delete',{threadId:'e',messageId:'r1',actor:sam})).result.threadDeleted,true);
  assert.equal((await listFeedback(f.config,{boardId:'landing'})).threads.length,0,'hidden by default');
  const kept=(await listFeedback(f.config,{boardId:'landing',includeDeleted:true,includeBodies:true,includeHistory:true})).threads[0];assert.equal(kept.body,'Better words.');assert.equal(kept.replies[0].body,'Agreed.');
});

test('list filters, and a since position that survives unrelated writes',async t=>{
  const f=await fixture(t);
  await f.op({type:'addComment',id:'a1',boardId:'landing',author:robin,body:'For the agent.',to:{kind:'agent'},status:'sent'});
  await f.op({type:'addComment',id:'h1',boardId:'landing',author:sam,body:'For Robin.',to:{kind:'human',id:'robin'}});
  await f.op({type:'addComment',id:'g1',boardId:'landing',author:agent,body:'Agent note.'});
  const ids=async input=>(await listFeedback(f.config,input)).threads.map(entry=>entry.id).sort();
  assert.deepEqual(await ids({status:'sent'}),['a1']);assert.deepEqual(await ids({status:['sent','open']}),['a1','g1','h1']);
  assert.deepEqual(await ids({to:'agent'}),['a1']);assert.deepEqual(await ids({toId:'robin'}),['h1']);assert.deepEqual(await ids({authorKind:'agent'}),['g1']);
  const summary=(await listFeedback(f.config,{threadId:'a1'})).threads[0];assert.deepEqual(summary.lastAuthor,robin);
  const first=await listFeedback(f.config,{since:''});assert.deepEqual(first.threads.map(entry=>entry.id),['a1','h1','g1']);
  await f.op({type:'updateItem',itemId:f.itemId,patch:{title:'Unrelated rename'}});
  const quiet=await listFeedback(f.config,{since:first.nextSince});assert.deepEqual(quiet.threads,[]);assert.equal(quiet.nextSince,first.nextSince,'unrelated writes do not invalidate the position');
  await callTool(f.config,'feedback.reply',{threadId:'h1',author:robin,body:'Yes.'});
  const next=await listFeedback(f.config,{since:first.nextSince,includeBodies:true});assert.deepEqual(next.threads.map(entry=>entry.id),['h1']);assert.equal(next.threads[0].replies.length,1);
  const stamp=new Date(Date.now()-60000).toISOString();assert.equal((await ids({updatedAfter:stamp})).length,3);assert.deepEqual(await ids({updatedAfter:new Date(Date.now()+60000).toISOString()}),[]);
  await assert.rejects(listFeedback(f.config,{since:'',cursor:'x'}),{status:400});await assert.rejects(listFeedback(f.config,{status:'done'}),{status:400});
});

test('older thread records and index buckets stay valid',async t=>{
  const f=await fixture(t);
  await f.op({type:'addComment',id:'old',boardId:'landing',author:robin,body:'Before 1.1.'});
  const file=path.join(f.config.workspaceRoot,'threads','old.json'),record=JSON.parse(await readFile(file,'utf8'));
  for(const key of ['status','statusHistory','updatedRevision'])delete record[key];record.resolved=true;await writeFile(file,JSON.stringify(record));
  await listFeedback(f.config,{boardId:'landing'});const index=path.join(f.config.workspaceRoot,'feedback-index');for(const name of await readdir(index))if(name.endsWith('.json')){const bucket=JSON.parse(await readFile(path.join(index,name),'utf8'));bucket.schemaVersion=1;await writeFile(path.join(index,name),JSON.stringify(bucket));}
  const old=(await listFeedback(f.config,{threadId:'old',includeBodies:true})).threads[0];assert.equal(old.status,'resolved');assert.deepEqual(old.statusHistory,[]);
  assert.equal((await listFeedback(f.config,{boardId:'landing',status:'resolved'})).threads[0].id,'old');
  await f.op({type:'resolveComment',threadId:'old',resolved:false});assert.equal((await listFeedback(f.config,{threadId:'old'})).threads[0].status,'open');
});

test('the agent inbox is read-only, reports only new things, and --brief is silent when there is nothing',async t=>{
  const f=await fixture(t),cli=args=>main(['inbox','--config',f.configPath,...args]);
  assert.equal(await cli(['--brief']),'');
  await f.op({type:'addComment',id:'i1',boardId:'landing',author:robin,body:'Make the price bigger.',anchor:{kind:'point',x:10,y:10,placementId:f.placementId},to:{kind:'agent'},status:'sent'});
  await f.op({type:'addComment',id:'i2',boardId:'landing',author:sam,body:'Only for Robin.',to:{kind:'human',id:'robin'}});
  await f.op({type:'addComment',id:'i3',boardId:'landing',author:robin,body:'For another agent.',to:{kind:'agent',id:'copy-agent'},status:'sent'});
  await f.op({type:'addComment',id:'i4',boardId:'landing',author:agent,body:'I tightened the grid.'});
  await callTool(f.config,'feedback.reply',{threadId:'i4',author:robin,body:'Tighter still, please.'});
  const revision=(await readWorkspace(f.config,{covers:false})).revision,started=performance.now();
  const brief=await cli(['--brief','--actor','design-agent']),elapsed=performance.now()-started;
  assert.match(brief,/^Tinka: 2 new comments for you on 'Landing page directions' — run `node .+ inbox --config .+ --actor design-agent` for details$/);
  assert.ok(elapsed<1000,`brief took ${elapsed} ms`);
  const inbox=await feedbackInbox(f.config,{actorId:'design-agent'});
  assert.deepEqual(inbox.threads.map(entry=>[entry.threadId,entry.reason]),[['i1','sent'],['i4','reply']]);
  assert.equal(inbox.threads[0].targetLabel,'A · Pricing hero');assert.equal(inbox.threads[0].boardTitle,'Landing page directions');assert.match(inbox.threads[0].link,/\/boards\/landing\/#comments\/i1$/);assert.equal(inbox.threads[1].snippet,'Tighter still, please.');
  assert.equal(await cli(['--brief','--actor','design-agent']),brief,'brief never moves the position');
  const full=await cli(['--actor','design-agent']);assert.match(full,/2 comments for you/);assert.match(full,/thread i1/);
  assert.equal(await cli(['--brief','--actor','design-agent']),'','a full run marks them seen');
  assert.match(await cli(['--brief']),/2 new comments for you/,'positions are per actor: the default agent sees i1 and i4 but not i3, which is for copy-agent');
  assert.equal((await readWorkspace(f.config,{covers:false})).revision,revision,'the inbox writes no metadata');
  const state=JSON.parse(await readFile(path.join(path.dirname(f.configPath),'.inbox-state.json'),'utf8'));assert.ok(state.actors['design-agent'].since);
  await callTool(f.config,'feedback.reply',{threadId:'i1',author:robin,body:'Also the button.'});
  assert.match(await cli(['--brief','--actor','design-agent']),/1 new comment/);
  const tool=await callTool(f.config,'feedback.inbox',{actorId:'design-agent',since:inbox.nextSince});assert.deepEqual(tool.threads.map(entry=>entry.threadId),['i1']);
});
