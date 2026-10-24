import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {applyFeedbackOperation,listFeedback} from '../lib/feedback.mjs';
import {storeMetrics,clearDocumentCache} from '../lib/store.mjs';
import {pointAnchorAt,resolveCommentPoint} from '../public/feedback-geometry.js';
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'tinka-feedback-'));t.after(()=>rm(dir,{recursive:true,force:true}));const config={boardsRoot:path.join(dir,'boards')};await mkdir(config.boardsRoot);const board=(await applyOperation(config,{type:'createBoard',title:'Feedback'})).result;const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Proposal',content:{kind:'note',text:'Exact selected words remain here.'}}})).result;return {config,board,item,root:path.join(config.boardsRoot,'.tinka')};}
const author={id:'human-one',label:'Reviewer',kind:'human'},agent={id:'agent-one',label:'Agent',kind:'agent'};
test('threads, replies, resolve, stable retry and independent files preserve graph metadata',async t=>{
 const {config,board,root}=await fixture(t);
 const op={type:'addComment',id:'thread-a',boardId:board.boardId,author,body:'Tighten this up.',anchor:{kind:'point',x:-20,y:45},operationId:'request-one'};
 const first=await applyFeedbackOperation(config,op),retry=await applyFeedbackOperation(config,op);assert.equal(retry.replayed,true);assert.equal(retry.revision,first.revision);
 await assert.rejects(applyFeedbackOperation(config,{...op,body:'Different'}),{status:409});
 await applyFeedbackOperation(config,{type:'replyComment',threadId:'thread-a',author:agent,body:'I will revise it.',id:'reply-a'});
 await applyFeedbackOperation(config,{type:'resolveComment',threadId:'thread-a',resolved:true});
 const compact=await listFeedback(config,{boardId:board.boardId});assert.equal(compact.threads[0].replyCount,1);assert.equal(compact.threads[0].body,undefined);assert.equal(compact.threads[0].replies,undefined);
 const full=await listFeedback(config,{threadId:'thread-a'});assert.equal(full.threads[0].replies[0].author.kind,'agent');assert.equal(full.threads[0].resolved,true);assert.equal((await listFeedback(config,{threadId:'thread-a',boardId:'other-board'})).threads.length,0);assert.equal((await listFeedback(config,{threadId:'thread-a',resolved:false})).threads.length,0);
 assert.equal((await listFeedback(config,{boardId:board.boardId,resolved:false})).threads.length,0);
 await applyFeedbackOperation(config,{type:'resolveComment',threadId:'thread-a',resolved:false});
 const header=JSON.parse(await readFile(path.join(root,'workspace.json')));assert.equal(header.threads,undefined);assert.equal(JSON.stringify(header).includes('Tighten this up.'),false);assert.equal(JSON.stringify(header).includes('I will revise it.'),false);assert.equal((await readdir(path.join(root,'threads'))).length,1);
});
test('votes replace one actor, clear and share references while preserving note/star',async t=>{
 const {config,item,board}=await fixture(t);await applyOperation(config,{type:'review',itemId:item.itemId,patch:{note:'Keep me',star:true}});
 for(const value of ['yes','no','abstain']){const response=await applyFeedbackOperation(config,{type:'vote',itemId:item.itemId,actor:author,value});assert.equal(response.result.actorId,author.id);assert.equal(response.result.totals[value],1);}
 await applyFeedbackOperation(config,{type:'vote',itemId:item.itemId,actor:agent,value:'yes'});
 await applyFeedbackOperation(config,{type:'vote',itemId:item.itemId,actor:author,value:null});
 let snap=await getBoardSnapshot(config,board.boardId);assert.equal(snap.items[item.itemId].review.note,'Keep me');assert.equal(snap.items[item.itemId].review.star,true);assert.equal(snap.items[item.itemId].review.votes['human-one'],undefined);assert.equal(snap.items[item.itemId].review.votes['agent-one'].value,'yes');
 await applyOperation(config,{type:'review',itemId:item.itemId,patch:{note:'Still voted'}});snap=await getBoardSnapshot(config,board.boardId);assert.equal(snap.items[item.itemId].review.votes['agent-one'].value,'yes');
});
test('strict input, targets and bounded thread fields reject before committing',async t=>{
 const {config,board,item}=await fixture(t),base={type:'addComment',boardId:board.boardId,author,body:'Hello'};
 const before=(await getBoardSnapshot(config,board.boardId)).revision;
 for(const op of [{...base,extra:true},{...base,body:'x'.repeat(20001)},{...base,author:{...author,authenticated:true}},{...base,anchor:{kind:'point',x:NaN,y:0}},{...base,anchor:{kind:'point',x:0,y:0,placementId:'missing'}},{...base,anchor:{kind:'text',quote:'Exact'}},{...base,itemId:item.itemId,anchor:{kind:'text',quote:'Exact',start:0}},{type:'vote',itemId:item.itemId,actor:author,value:'maybe'}])await assert.rejects(applyFeedbackOperation(config,op),{status:400});
 assert.equal((await getBoardSnapshot(config,board.boardId)).revision,before);
});
test('text anchors preserve exact quote and report source uncertainty/staleness',async t=>{
 const {config,board,item}=await fixture(t),quote='selected words';
 await applyFeedbackOperation(config,{type:'addComment',id:'quote-a',boardId:board.boardId,itemId:item.itemId,author,body:'Keep these.',anchor:{kind:'text',quote,start:6,end:20,prefix:'Exact ',suffix:' remain here.'}});
 assert.equal((await listFeedback(config,{threadId:'quote-a'})).threads[0].anchorStatus,'matched');
 await applyOperation(config,{type:'updateItem',itemId:item.itemId,patch:{content:{kind:'note',text:'Now moved selected words somewhere.'}}});
 assert.equal((await listFeedback(config,{threadId:'quote-a'})).threads[0].anchorStatus,'uncertain');
 await applyOperation(config,{type:'updateItem',itemId:item.itemId,patch:{content:{kind:'note',text:'Changed entirely.'}}});
 const stale=(await listFeedback(config,{threadId:'quote-a'})).threads[0];assert.equal(stale.anchorStatus,'stale');assert.equal(stale.anchor.quote,quote);
});
test('relative points follow targets without rewriting threads and expose detached creation fallback',async t=>{
 const {config,board,item,root}=await fixture(t);
 let snapshot=await getBoardSnapshot(config,board.boardId);const placement=snapshot.placements.find(p=>p.itemId===item.itemId);
 await applyOperation(config,{type:'updatePlacement',boardId:board.boardId,placementId:placement.id,patch:{x:100,y:200,width:400,height:240}});
 await applyOperation(config,{type:'createDecoration',boardId:board.boardId,decoration:{id:'point-shape',type:'region',x:600,y:200,width:200,height:100,text:'Decision',color:'#eedd99'}});
 const base={type:'addComment',boardId:board.boardId,author,body:'Keep this exact target.'};
 const anchors={relative:{kind:'point',x:200,y:320,placementId:placement.id,relative:{x:.25,y:.5}},legacy:{kind:'point',x:200,y:320,placementId:placement.id},shape:{kind:'point',x:650,y:225,decorationId:'point-shape',relative:{x:.25,y:.25}}};
 for(const [id,anchor] of Object.entries(anchors))await applyFeedbackOperation(config,{...base,id,anchor,...(id!=='shape'?{itemId:item.itemId}:{})});
 const original=await Promise.all(Object.keys(anchors).map(id=>readFile(path.join(root,'threads',`${id}.json`),'utf8')));
 await applyOperation(config,{type:'updatePlacement',boardId:board.boardId,placementId:placement.id,patch:{x:300,y:400,width:800,height:400}});
 await applyOperation(config,{type:'updateDecoration',boardId:board.boardId,decorationId:'point-shape',patch:{x:700,y:300,width:400,height:200}});
 const saved=(await listFeedback(config,{boardId:board.boardId})).threads;
 assert.deepEqual(saved.find(t=>t.id==='relative').anchorPoint,{x:500,y:600,detached:false,fallback:false});
 assert.deepEqual(saved.find(t=>t.id==='legacy').anchorPoint,{x:200,y:320,detached:false,fallback:false});
 assert.deepEqual(saved.find(t=>t.id==='shape').anchorPoint,{x:800,y:350,detached:false,fallback:false});
 const cli=JSON.parse(execFileSync(process.execPath,['cli.mjs','tools','call','feedback.list','--config',await configFile(config,root),'--json',JSON.stringify({threadId:'relative'})],{cwd:process.cwd(),encoding:'utf8'}));
 assert.deepEqual(cli.threads[0].anchorPoint,saved.find(t=>t.id==='relative').anchorPoint);
 await applyOperation(config,{type:'archiveItem',itemIds:[item.itemId],archived:true});
 assert.equal((await listFeedback(config,{threadId:'relative'})).threads[0].anchorStatus,'detached');
 await applyOperation(config,{type:'archiveItem',itemIds:[item.itemId],archived:false});
 await applyOperation(config,{type:'remove',boardId:board.boardId,placementIds:[placement.id]});
 await applyOperation(config,{type:'removeDecoration',boardId:board.boardId,decorationId:'point-shape'});
 for(const id of ['relative','shape']){const thread=(await listFeedback(config,{threadId:id})).threads[0];assert.equal(thread.anchorStatus,'detached');assert.deepEqual(thread.anchor,anchors[id]);assert.deepEqual(thread.anchorPoint,{x:anchors[id].x,y:anchors[id].y,detached:true,fallback:true});}
 assert.deepEqual(await Promise.all(Object.keys(anchors).map(id=>readFile(path.join(root,'threads',`${id}.json`),'utf8'))),original);
});
async function configFile(config,root){const file=path.join(root,'..','fixture-config.json');await writeFile(file,JSON.stringify({schemaVersion:1,port:43821,portMode:'auto',projectLabel:'Feedback',title:'Tinka',...config}));return file;}
test('relative point bounds and target requirements reject before commit; preview geometry shares the resolver',async t=>{
 const {config,board,item}=await fixture(t),snapshot=await getBoardSnapshot(config,board.boardId),placement=snapshot.placements.find(p=>p.itemId===item.itemId);
 const base={type:'addComment',boardId:board.boardId,author,body:'Invalid relative point'},point={kind:'point',x:0,y:0,placementId:placement.id};
 const before=snapshot.revision;
 for(const anchor of [{...point,relative:{x:.5}},{...point,relative:{x:.5,y:.5,z:0}},{...point,relative:{x:-.1,y:0}},{...point,relative:{x:1.1,y:0}},{...point,relative:{x:NaN,y:0}},{...point,relative:{x:Infinity,y:0}},{...point,relative:null},{...point,relative:[]},{kind:'point',x:0,y:0,relative:{x:0,y:0}},{...point,decorationId:'extra',relative:{x:0,y:0}}])await assert.rejects(applyFeedbackOperation(config,{...base,anchor}),{status:400});
 assert.equal((await getBoardSnapshot(config,board.boardId)).revision,before);
 const live={placements:[{id:'p',itemId:'i',x:10,y:20,width:100,height:80}],items:{i:{id:'i'}},decorations:[]};
 const anchor=pointAnchorAt({x:35,y:60},live,{placementId:'p'});assert.deepEqual(anchor.relative,{x:.25,y:.5});
 assert.deepEqual(resolveCommentPoint(anchor,live,{placements:new Map([['p',{x:50,y:90,width:200,height:160}]])}),{x:100,y:170,detached:false,fallback:false});
 assert.deepEqual(resolveCommentPoint({...anchor,relative:undefined},live),{x:35,y:60,detached:false,fallback:false});
 assert.equal(resolveCommentPoint(anchor,{...live,placements:[]}).fallback,true);
 assert.equal(resolveCommentPoint(anchor,{...live,placements:[{...live.placements[0],x:10_000_000}]}).detached,true);
});
test('stable pagination rejects stale query and warm board list skips unrelated body parsing',async t=>{
 const {config,board,root}=await fixture(t);
 for(let i=0;i<5;i++)await applyFeedbackOperation(config,{type:'addComment',id:`comment-${i}`,boardId:board.boardId,author,body:`Comment ${i}`});
 const first=await listFeedback(config,{boardId:board.boardId,limit:2});assert.equal(first.threads.length,2);assert.ok(first.nextCursor);
 const second=await listFeedback(config,{boardId:board.boardId,limit:2,cursor:first.nextCursor});assert.equal(second.threads.length,2);assert.ok(!first.threads.some(a=>second.threads.some(b=>a.id===b.id)));
 clearDocumentCache();storeMetrics({reset:true});await listFeedback(config,{boardId:board.boardId});const warm=storeMetrics();assert.equal(warm.documentReads,0);
 await applyFeedbackOperation(config,{type:'replyComment',threadId:'comment-0',author:agent,body:'New reply'});
 await assert.rejects(listFeedback(config,{boardId:board.boardId,cursor:first.nextCursor}),{status:409});
 const updated=await listFeedback(config,{boardId:board.boardId});assert.equal(updated.threads.find(t=>t.id==='comment-0').replyCount,1);
 const file=path.join(root,'threads','comment-0.json'),thread=JSON.parse(await readFile(file));thread.body='External source edit';await writeFile(file,JSON.stringify(thread));
 assert.equal((await listFeedback(config,{boardId:board.boardId})).threads.find(t=>t.id==='comment-0').excerpt,'External source edit');
});

test('fresh process uses persisted summaries and rebuilds a corrupt summary shard',async t=>{
 const {config,board,root}=await fixture(t);
 for(let i=0;i<4;i++)await applyFeedbackOperation(config,{type:'addComment',id:`persisted-${i}`,boardId:board.boardId,author,body:'A long source body '.repeat(300)});
 await listFeedback(config,{boardId:board.boardId});
 const run=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {listFeedback} from './lib/feedback.mjs';import {storeMetrics} from './lib/store.mjs';const result=await listFeedback(${JSON.stringify(config)},{boardId:${JSON.stringify(board.boardId)}});console.log(JSON.stringify({result,metrics:storeMetrics()}));`],{cwd:process.cwd(),encoding:'utf8'}));
 const warm=run();assert.equal(warm.result.threads.length,4);assert.equal(warm.metrics.documentReads,0);assert.ok(JSON.stringify(warm.result).length<3000);
 const directory=path.join(root,'feedback-index'),files=(await readdir(directory)).filter(name=>name.endsWith('.json'));
 for(const name of files){const saved=JSON.parse(await readFile(path.join(directory,name)));if(saved.records.length){await writeFile(path.join(directory,name),'{broken');break;}}
 const repaired=run();assert.equal(repaired.result.threads.length,4);assert.ok(repaired.metrics.documentReads>0);assert.ok(repaired.metrics.documentReads<4);
 for(const name of files){const saved=JSON.parse(await readFile(path.join(directory,name)));if(saved.records.length){saved.records[0].summary.excerpt='Silently damaged cache';await writeFile(path.join(directory,name),JSON.stringify(saved));break;}}
 const checksumRepaired=run();assert.equal(checksumRepaired.result.threads.some(t=>t.excerpt==='Silently damaged cache'),false);assert.ok(checksumRepaired.metrics.documentReads>0);
});

test('warm feedback summaries reject an escaped canonical threads directory',async t=>{
 const {config,board,root}=await fixture(t);
 await applyFeedbackOperation(config,{type:'addComment',id:'private-thread',boardId:board.boardId,author,body:'Private cached excerpt'});
 await listFeedback(config,{boardId:board.boardId});
 const directory=path.join(root,'threads'),outside=path.join(path.dirname(root),'escaped-threads');
 await rename(directory,outside);await symlink(outside,directory);
 await assert.rejects(listFeedback(config,{boardId:board.boardId}),{status:403});
 const source=`import {listFeedback} from './lib/feedback.mjs';try{await listFeedback(${JSON.stringify(config)},{boardId:${JSON.stringify(board.boardId)}});process.exitCode=1;}catch(error){console.log(error.status);}`;
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:process.cwd(),encoding:'utf8'}).trim(),'403');
});
