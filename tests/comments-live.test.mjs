// Comment reads without the lock, arrow anchors, re-pinning, and live agent pickup with presence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {listFeedback} from '../lib/feedback.mjs';
import {listHighlights} from '../lib/highlights.mjs';
import {feedbackInbox,watchInbox} from '../lib/inbox.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {parseMarkdown,MARKDOWN_TEXT_MODEL} from '../public/markdown-document.js';
import {createHash} from 'node:crypto';

const robin={id:'robin',label:'Robin',kind:'human'},agent={id:'design-agent',label:'Design agent',kind:'agent'};
async function fixture(t,{documents=0,threadsPer=0}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-comments-live-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'local','config.json');await mkdir(path.join(root,'boards'));await mkdir(path.join(root,'docs'));
  await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Live fixture']);
  const config=await loadConfig(configPath),op=operation=>applyOperation(config,operation);
  await op({type:'createBoard',id:'landing',title:'Landing page directions'});
  await op({type:'updateWorkspace',patch:{resourceRoots:{docs:{path:'../../docs'}}}});
  const item=(await op({type:'createItem',boardId:'landing',item:{title:'A · Pricing hero'},placement:{x:0,y:0,width:300,height:200}})).result;
  const placementId=(await getBoardSnapshot(config,'landing')).placements.find(p=>p.itemId===item.itemId).id;
  await op({type:'createDecoration',boardId:'landing',decoration:{id:'flow',type:'line',x:0,y:400,width:200,height:1,color:'#6c8060',text:'',endArrow:true,from:{x:0,y:400},to:{x:200,y:400}}});
  await op({type:'createDecoration',boardId:'landing',decoration:{id:'sticky',type:'region',shape:'rectangle',x:400,y:0,width:160,height:150,color:'#f6e6a4',text:'Pricing note'}});
  const docs=[];
  for(let i=0;i<documents;i++){
    const text=`# Doc ${i}\n\nThe selected words ${i} are here.\n`;await writeFile(path.join(root,'docs',`d${i}.md`),text);
    const doc=(await op({type:'createItem',boardId:'landing',item:{title:`Doc ${i}`,content:{kind:'markdown',resource:{rootId:'docs',path:`d${i}.md`}}},placement:{x:i*10,y:600,width:200,height:200}})).result;docs.push(doc.itemId);
    const model=parseMarkdown(text),quote=`selected words ${i}`,start=model.text.indexOf(quote),revision='sha256:'+createHash('sha256').update(text).digest('hex');
    const anchorText={kind:'text',quote,prefix:model.text.slice(0,start),suffix:model.text.slice(start+quote.length),start,end:start+quote.length,sourceRevision:revision,textModel:MARKDOWN_TEXT_MODEL};
    await op({type:'addHighlight',itemId:doc.itemId,author:robin,anchor:anchorText});
    for(let j=0;j<threadsPer;j++)await op({type:'addComment',boardId:'landing',itemId:doc.itemId,author:robin,body:`Note ${j} on doc ${i}`,anchor:anchorText});
  }
  return {root,config,configPath,op,itemId:item.itemId,placementId,docs};
}
async function tree(directory){
  const entries=[];
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else entries.push(`${path.relative(directory,file)}@${(await stat(file)).mtimeMs}`);}}
  await walk(directory);return entries.sort();
}

test('comment and highlight reads take no lock and write nothing',async t=>{
  const f=await fixture(t,{documents:2,threadsPer:2});
  await f.op({type:'addComment',id:'pin',boardId:'landing',author:robin,body:'Pin',to:{kind:'agent'},status:'sent'});
  await rm(path.join(f.config.workspaceRoot,'feedback-index'),{recursive:true,force:true});
  // Another process holds the mutation lock: a locked read would wait for it.
  const lock=path.join(f.config.workspaceRoot,'.mutation-lock');await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,token:'held-elsewhere',createdAt:new Date().toISOString()}));
  const before=await tree(f.config.workspaceRoot),started=Date.now();
  assert.equal((await listFeedback(f.config,{boardId:'landing'})).threads.length,5);
  assert.equal((await listFeedback(f.config,{itemId:f.docs[0],includeBodies:true})).threads.length,2);
  assert.equal((await listFeedback(f.config,{threadId:'pin'})).threads[0].status,'sent');
  assert.equal((await listFeedback(f.config,{since:''})).threads.length,5);
  assert.equal((await listHighlights(f.config,{itemId:f.docs[1]})).highlights[0].anchorStatus,'matched');
  assert.equal((await feedbackInbox(f.config,{})).count,1);
  assert.ok(Date.now()-started<2000,'no read waited for the lock');
  assert.deepEqual(await tree(f.config.workspaceRoot),before,'reads wrote nothing, not even the index');
  await rm(lock,{recursive:true});
  // A commit rebuilds the index; a read sees a journal's pending writes as committed.
  await f.op({type:'replyComment',threadId:'pin',author:agent,body:'On it.'});
  assert.ok((await readdir(path.join(f.config.workspaceRoot,'feedback-index'))).some(name=>name.endsWith('.json')),'the commit wrote the index');
  const pinFile=path.join(f.config.workspaceRoot,'threads','pin.json'),pin=JSON.parse(await readFile(pinFile,'utf8'));
  await writeFile(path.join(f.config.workspaceRoot,'pending.json'),JSON.stringify({schemaVersion:1,id:'journal',writes:[{path:'threads/pin.json',value:{...pin,body:'Mid-commit body'}}]}));
  assert.equal((await listFeedback(f.config,{threadId:'pin',includeBodies:true})).threads[0].body,'Mid-commit body');
  assert.equal((await listFeedback(f.config,{boardId:'landing'})).threads.find(thread=>thread.id==='pin').excerpt,'Mid-commit body');
  await rm(path.join(f.config.workspaceRoot,'pending.json'));
});

test('many document cards read their comments and highlights quickly',async t=>{
  const f=await fixture(t,{documents:60,threadsPer:3});
  await listFeedback(f.config,{boardId:'landing'});
  const started=performance.now();
  // What a board of document cards asks for: each card's comments and highlights.
  await Promise.all(f.docs.map(async itemId=>{assert.equal((await listFeedback(f.config,{itemId})).threads.length,3);assert.equal((await listHighlights(f.config,{itemId})).highlights.length,1);}));
  const elapsed=performance.now()-started;
  assert.ok(elapsed<5000,`60 cards took ${Math.round(elapsed)} ms`);
  t.diagnostic(`60 document cards (180 threads, 60 highlights): ${Math.round(elapsed)} ms`);
});

test('arrow anchors ride along their line and fall back when it is gone',async t=>{
  const f=await fixture(t);
  await f.op({type:'addComment',id:'arrow',boardId:'landing',author:robin,body:'This step is slow.',anchor:{kind:'decoration',decorationId:'flow',along:.25,offset:10,x:50,y:390}});
  let arrow=(await listFeedback(f.config,{threadId:'arrow'})).threads[0];
  assert.deepEqual(arrow.anchorPoint,{x:50,y:390,detached:false,fallback:false});assert.equal(arrow.targetLabel,'Arrow');assert.equal(arrow.anchorStatus,'point');
  await f.op({type:'updateDecoration',boardId:'landing',decorationId:'flow',patch:{width:400,from:{x:0,y:400},to:{x:400,y:400}}});
  arrow=(await listFeedback(f.config,{threadId:'arrow'})).threads[0];assert.deepEqual([arrow.anchorPoint.x,arrow.anchorPoint.y],[100,390],'the pin rides along the longer line');
  await f.op({type:'removeDecoration',boardId:'landing',decorationId:'flow'});
  arrow=(await listFeedback(f.config,{threadId:'arrow'})).threads[0];assert.deepEqual(arrow.anchorPoint,{x:50,y:390,detached:true,fallback:true});assert.equal(arrow.anchorStatus,'detached');
  await assert.rejects(f.op({type:'addComment',boardId:'landing',author:robin,body:'x',anchor:{kind:'decoration',decorationId:'sticky',along:.5,x:0,y:0}}),{status:400});
  await assert.rejects(f.op({type:'addComment',boardId:'landing',author:robin,body:'x',anchor:{kind:'decoration',decorationId:'flow',along:1.5,x:0,y:0}}),{status:400});
});

test('a person re-pins a detached comment onto a new target, with history',async t=>{
  const f=await fixture(t);
  await f.op({type:'addComment',id:'moved',boardId:'landing',itemId:f.itemId,author:robin,body:'Bigger price.',anchor:{kind:'point',x:10,y:10,placementId:f.placementId,relative:{x:.1,y:.1}}});
  await f.op({type:'remove',boardId:'landing',placementIds:[f.placementId]});
  assert.equal((await listFeedback(f.config,{threadId:'moved'})).threads[0].anchorPoint.detached,true);
  await assert.rejects(f.op({type:'repinComment',threadId:'moved',actor:agent,anchor:{kind:'point',x:420,y:20,decorationId:'sticky',relative:{x:.1,y:.1}}}),{status:403});
  const {result}=await f.op({type:'repinComment',threadId:'moved',actor:robin,anchor:{kind:'point',x:420,y:20,decorationId:'sticky',relative:{x:.1,y:.1}}});
  assert.equal(result.targetLabel,'Pricing note');
  const moved=(await listFeedback(f.config,{threadId:'moved',includeBodies:true})).threads[0];
  assert.equal(moved.anchorPoint.detached,false);assert.equal(moved.itemId,undefined,'the item link follows the new target');
  assert.equal(moved.anchorHistory.length,1);assert.equal(moved.anchorHistory[0].anchor.placementId,f.placementId);assert.equal(moved.anchorHistory[0].targetLabel,'A · Pricing hero');assert.equal(moved.anchorHistory[0].actor.id,'robin');
  await f.op({type:'addComment',id:'agents',boardId:'landing',author:agent,body:'My own note.',anchor:{kind:'point',x:5,y:5}});
  assert.equal((await f.op({type:'repinComment',threadId:'agents',actor:agent,anchor:{kind:'decoration',decorationId:'flow',along:.5,x:100,y:400}})).result.targetLabel,'Arrow');
  await assert.rejects(f.op({type:'repinComment',threadId:'agents',actor:robin,anchor:{kind:'text',quote:'x'}}),{status:400});
});

test('inbox --watch waits on the server without polling, and the board sees the agent watching',async t=>{
  const f=await fixture(t),server=await listen(f.config,{port:0});t.after(()=>closeAppServer(server));
  const base=`http://127.0.0.1:${server.address().port}/`;
  assert.deepEqual(await (await fetch(base+'api/agents')).json(),{watching:[]});
  // The board's event stream reports presence on connect and when it changes.
  const events=await fetch(`${base}api/events?workspace=${f.config.workspaceId}`,{headers:{origin:base.slice(0,-1)}}),reader=events.body.getReader(),decoder=new TextDecoder();let stream='';
  const nextPresence=async()=>{for(;;){const at=stream.indexOf('event: presence\ndata: ');if(at>=0){const end=stream.indexOf('\n\n',at);if(end>0){const body=JSON.parse(stream.slice(at+22,end));stream=stream.slice(end);return body;}}const {value}=await reader.read();stream+=decoder.decode(value);}};
  assert.deepEqual((await nextPresence()).watching,[]);
  const started=Date.now(),held=fetch(`${base}api/inbox?actor=design-agent&wait=20&label=Design%20agent`).then(response=>response.json());
  const presence=await nextPresence();assert.deepEqual(presence.watching.map(entry=>entry.actor),[{id:'design-agent',label:'Design agent'}]);
  assert.deepEqual((await (await fetch(base+'api/agents')).json()).watching[0].actor.id,'design-agent');
  await f.op({type:'addComment',id:'live',boardId:'landing',author:robin,body:'Picked up live?',to:{kind:'agent'},status:'sent'});
  const result=await held;assert.equal(result.count,1);assert.equal(result.threads[0].threadId,'live');assert.ok(Date.now()-started<8000);
  await reader.cancel();
  assert.equal((await (await fetch(`${base}api/inbox?actor=design-agent&wait=0&since=${encodeURIComponent(result.nextSince)}`)).json()).count,0);
  await assert.rejects(fetch(`${base}api/inbox?actor=../x`).then(response=>{if(!response.ok)throw Object.assign(Error('bad'),{status:response.status});}),{status:400});
});

test('without a running server, --watch waits on the thread files and times out quietly',async t=>{
  const f=await fixture(t);
  const startedQuiet=Date.now();assert.equal(await watchInbox(f.config,{timeoutSeconds:.4}),null);assert.ok(Date.now()-startedQuiet<3000);
  assert.equal(await main(['inbox','--config',f.configPath,'--watch','--timeout','0.3']),'');
  const waiting=main(['inbox','--config',f.configPath,'--watch','--timeout','10','--actor','design-agent']);
  await new Promise(resolve=>setTimeout(resolve,300));
  await f.op({type:'addComment',id:'file-watch',boardId:'landing',author:robin,body:'Seen through the files?',to:{kind:'agent'},status:'sent'});
  const output=await waiting;
  assert.match(output,/^Tinka: 1 new comment for you on 'Landing page directions'/);assert.match(output,/\/boards\/landing\/#comments\/file-watch \(thread file-watch\)/);
  assert.equal(await main(['inbox','--config',f.configPath,'--brief','--actor','design-agent']),'','a watch marks what it showed as seen');
});
