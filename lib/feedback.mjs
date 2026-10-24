// Independent feedback documents use the same lock, journal and revision as graph edits.
import {randomUUID,createHash} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile,rename,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {assertId,storeError,withStore,withScopedTransaction,readStoreDocument,listStoreDocumentIds} from './store.mjs';
import {documentAnchorStatus} from './document-anchors.mjs';
import {resolveCommentPoint} from '../public/feedback-geometry.js';
const types=new Set(['addComment','replyComment','resolveComment','vote']);
const fail=message=>{throw storeError(400,message);};
const object=(value,name)=>{if(!value||typeof value!=='object'||Array.isArray(value))fail(`${name} must be an object.`);return value;};
function keys(value,allowed,name){object(value,name);for(const key of Object.keys(value))if(!allowed.includes(key))fail(`Unknown ${name} field: ${key}.`);}
function text(value,name,max,{empty=false}={}){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||value.includes('\0'))fail(`Invalid ${name}.`);return value;}
function actor(value){keys(value,['id','label','kind'],'actor');assertId(value.id);text(value.label,'actor label',120);if(!['human','agent'].includes(value.kind))fail('Actor kind must be human or agent.');return structuredClone(value);}
function coordinate(value){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>10_000_000)fail('Invalid point coordinate.');return value;}
function anchor(value,itemId){
  object(value,'anchor');
  if(value.kind==='point'){
    keys(value,['kind','x','y','placementId','decorationId','relative'],'point anchor');coordinate(value.x);coordinate(value.y);
    if(value.placementId!==undefined)assertId(value.placementId);
    if(value.decorationId!==undefined)assertId(value.decorationId);
    if(value.placementId&&value.decorationId)fail('Point anchors select at most one target.');
    if(value.relative!==undefined){
      if(!value.placementId&&!value.decorationId)fail('Relative points require a target.');
      keys(value.relative,['x','y'],'relative point');
      for(const axis of ['x','y'])if(typeof value.relative[axis]!=='number'||!Number.isFinite(value.relative[axis])||value.relative[axis]<0||value.relative[axis]>1)fail('Relative point coordinates must be between 0 and 1.');
    }
  }else if(value.kind==='text'){
    keys(value,['kind','quote','prefix','suffix','start','end','sourceRevision'],'text anchor');
    if(!itemId)fail('Text anchors require itemId.');text(value.quote,'anchor quote',20_000);
    for(const key of ['prefix','suffix'])if(value[key]!==undefined)text(value[key],key,2000,{empty:true});
    if((value.start===undefined)!==(value.end===undefined))fail('Text offsets require both start and end.');
    if(value.start!==undefined&&(!Number.isSafeInteger(value.start)||value.start<0||!Number.isSafeInteger(value.end)||value.end<=value.start||value.end>2_000_000))fail('Invalid text offsets.');
    if(value.sourceRevision!==undefined)text(value.sourceRevision,'source revision',256);
  }else fail('Unknown anchor kind.');
  return structuredClone(value);
}
function validateThread(value){
  keys(value,['id','boardId','itemId','anchor','author','body','createdAt','updatedAt','replies','resolved'],'thread');
  assertId(value.id);assertId(value.boardId);if(value.itemId!==undefined)assertId(value.itemId);
  actor(value.author);text(value.body,'comment body',20_000);if(value.anchor)anchor(value.anchor,value.itemId);
  if(!Array.isArray(value.replies)||value.replies.length>500||typeof value.resolved!=='boolean')fail('Invalid thread replies or resolution.');
  const ids=new Set();
  for(const reply of value.replies){keys(reply,['id','author','body','createdAt'],'reply');assertId(reply.id);if(ids.has(reply.id))fail('Duplicate reply ID.');ids.add(reply.id);actor(reply.author);text(reply.body,'reply body',20_000);if(!Number.isFinite(Date.parse(reply.createdAt)))fail('Invalid reply timestamp.');}
  for(const key of ['createdAt','updatedAt'])if(!Number.isFinite(Date.parse(value[key])))fail('Invalid thread timestamp.');
  if(Buffer.byteLength(JSON.stringify(value))>1_000_000)fail('Thread has reached its size limit. Start a new thread.');
  return value;
}
function validateOperation(operation){
  const fields={addComment:['boardId','id','itemId','anchor','author','body'],replyComment:['threadId','id','author','body'],resolveComment:['threadId','resolved'],vote:['itemId','actor','value']}[operation?.type];
  if(!fields)fail('Unknown feedback operation.');keys(operation,['type','expectedRevision','operationId',...fields],'operation');
  for(const key of ['boardId','itemId','threadId','id'])if(operation[key]!==undefined)assertId(operation[key]);
  if(['addComment','replyComment'].includes(operation.type)){actor(operation.author);text(operation.body,'comment body',20_000);}
  if(operation.type==='addComment'){assertId(operation.boardId);if(operation.anchor)anchor(operation.anchor,operation.itemId);}
  if(operation.type==='replyComment'||operation.type==='resolveComment')assertId(operation.threadId);
  if(operation.type==='resolveComment'&&typeof operation.resolved!=='boolean')fail('resolved must be boolean.');
  if(operation.type==='vote'){assertId(operation.itemId);actor(operation.actor);if(![null,'yes','no','abstain'].includes(operation.value))fail('Vote value must be yes, no, abstain or null.');}
}
export const isFeedbackOperation=operation=>types.has(operation?.type);
export async function applyFeedbackOperation(config,operation){
  validateOperation(operation);
  return withScopedTransaction(config,operation,async tx=>{
    const now=new Date().toISOString();
    if(operation.type==='vote'){
      const item=await tx.read('items',operation.itemId);if(item.deletedAt)throw storeError(404,'Item has been deleted.');
      const votes=structuredClone(item.review?.votes||{});
      if(operation.value===null)delete votes[operation.actor.id];
      else votes[operation.actor.id]={actor:actor(operation.actor),value:operation.value,updatedAt:now};
      if(Object.keys(votes).length>1000)fail('Item vote limit reached.');
      item.review={...item.review,votes,updatedAt:now};item.updatedAt=now;tx.write('items',item.id,item);
      return {itemId:item.id,actorId:operation.actor.id,value:operation.value,totals:voteTotals(votes)};
    }
    if(operation.type==='addComment'){
      const board=await tx.read('boards',operation.boardId);
      if(operation.itemId){const item=await tx.read('items',operation.itemId);if(item.deletedAt)throw storeError(404,'Item has been deleted.');if(!board.placements.some(p=>p.itemId===item.id&&!p.removedAt&&!p.deletedAt))fail('Comment item must belong to this board.');}
      if(operation.anchor?.kind==='point'){
        const a=operation.anchor;
        if(a.placementId&&!board.placements.some(p=>p.id===a.placementId&&!p.removedAt&&!p.deletedAt&&!p.archivedAt))fail('Point placement must belong to this board.');
        if(a.decorationId&&!(board.decorations||[]).some(d=>d.id===a.decorationId))fail('Point decoration must belong to this board.');
        if(operation.itemId&&a.placementId&&!board.placements.some(p=>p.id===a.placementId&&p.itemId===operation.itemId))fail('Point placement does not match comment item.');
        if(a.relative){
          const placement=board.placements.find(p=>p.id===a.placementId);
          const item=placement?await tx.read('items',placement.itemId):null;
          const point=resolveCommentPoint(a,{...board,...(item?{items:{[item.id]:item}}:{})});
          if(point.detached)fail('Relative point target geometry is unavailable.');
        }
      }
      const id=operation.id||`comment-${randomUUID()}`;
      if(await tx.read('threads',id,{optional:true}))throw storeError(409,'Comment ID already exists.');
      const thread={id,boardId:board.id,...(operation.itemId?{itemId:operation.itemId}:{}),...(operation.anchor?{anchor:anchor(operation.anchor,operation.itemId)}:{}),author:actor(operation.author),body:operation.body,createdAt:now,updatedAt:now,replies:[],resolved:false};
      validateThread(thread);tx.write('threads',id,thread);return {threadId:id};
    }
    const thread=validateThread(await tx.read('threads',operation.threadId));
    if(operation.type==='replyComment'){
      const id=operation.id||`reply-${randomUUID()}`;
      if(thread.replies.some(reply=>reply.id===id))throw storeError(409,'Reply ID already exists.');
      thread.replies.push({id,author:actor(operation.author),body:operation.body,createdAt:now});
    }else thread.resolved=operation.resolved;
    thread.updatedAt=now;validateThread(thread);tx.write('threads',thread.id,thread);return {threadId:thread.id,resolved:thread.resolved};
  });
}
export function voteTotals(votes={}){const totals={yes:0,no:0,abstain:0};for(const vote of Object.values(votes))if(Object.hasOwn(totals,vote.value))totals[vote.value]++;return totals;}
function compare(a,b){return a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);}
function summary(thread){return {id:thread.id,boardId:thread.boardId,...(thread.itemId?{itemId:thread.itemId}:{}),...(thread.anchor?{anchor:thread.anchor}:{}),author:thread.author,excerpt:thread.body.slice(0,240),createdAt:thread.createdAt,updatedAt:thread.updatedAt,replyCount:thread.replies.length,resolved:thread.resolved};}
// Rebuildable derived summaries, sharded across 32 files. Source stat identities
// are checked under the existing lock, including across fresh CLI processes.
const feedbackIndexes=new Map();
const bucketFor=id=>(parseInt(createHash('sha256').update(id).digest('hex').slice(0,2),16)%32).toString(16).padStart(2,'0');
function validateSummary(value){
  keys(value,['id','boardId','itemId','anchor','author','excerpt','createdAt','updatedAt','replyCount','resolved'],'feedback summary');
  assertId(value.id);assertId(value.boardId);if(value.itemId!==undefined)assertId(value.itemId);actor(value.author);text(value.excerpt,'excerpt',240,{empty:true});
  if(value.anchor)anchor(value.anchor,value.itemId);
  if(typeof value.resolved!=='boolean'||!Number.isSafeInteger(value.replyCount)||value.replyCount<0||value.replyCount>500||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.updatedAt)))fail('Invalid feedback summary.');
}
async function indexDirectory(root){
  const directory=path.join(root,'feedback-index');
  try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}
  if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw storeError(403,'Feedback index must stay in workspace metadata.');
  try{await writeFile(path.join(directory,'.gitignore'),'*\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  return directory;
}
async function feedbackIndex(root,workspaceId){
  let cache=feedbackIndexes.get(root);
  if(!cache||cache.workspaceId!==workspaceId){
    cache={workspaceId,records:new Map(),boards:new Map(),items:new Map(),loaded:false};feedbackIndexes.set(root,cache);
  }
  while(feedbackIndexes.size>8)feedbackIndexes.delete(feedbackIndexes.keys().next().value);
  let directory;
  try{directory=await indexDirectory(root);}catch{/* Derived-cache failure never changes canonical ownership. */}
  const dirty=new Set();
  if(!cache.loaded){
    if(directory)for(let number=0;number<32;number++){
      const bucket=number.toString(16).padStart(2,'0'),file=path.join(directory,`${bucket}.json`);
      try{
        const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8_000_000)throw Error('Invalid bucket');
        const saved=JSON.parse(await readFile(file,'utf8'));
        if(saved.schemaVersion!==1||saved.workspaceId!==workspaceId||!Array.isArray(saved.records)||saved.recordsDigest!==createHash('sha256').update(JSON.stringify(saved.records)).digest('hex'))throw Error('Stale or damaged bucket');
        const entries=[];
        for(const entry of saved.records){keys(entry,['fingerprint','summary'],'index entry');if(typeof entry.fingerprint!=='string'||entry.fingerprint.length>256)throw Error('Bad fingerprint');validateSummary(entry.summary);if(bucketFor(entry.summary.id)!==bucket)throw Error('Wrong bucket');entries.push([entry.summary.id,entry]);}
        for(const [id,entry] of entries)cache.records.set(id,entry);
      }catch{dirty.add(bucket);}
    }
    cache.loaded=true;
  }
  const ids=await listStoreDocumentIds(root,'threads'),current=new Set(ids);
  if(ids.length>100000)throw storeError(400,'Feedback index limit reached.');
  let changed=cache.boards.size===0;
  for(const id of cache.records.keys())if(!current.has(id)){cache.records.delete(id);dirty.add(bucketFor(id));changed=true;}
  for(const id of ids){
    const stat=await lstat(path.join(root,'threads',`${id}.json`),{bigint:true});
    if(!stat.isFile()||stat.isSymbolicLink())throw storeError(403,'Feedback must be a regular metadata file.');
    const fingerprint=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    if(cache.records.get(id)?.fingerprint===fingerprint)continue;
    const thread=validateThread(await readStoreDocument(root,'threads',id));cache.records.set(id,{fingerprint,summary:summary(thread)});dirty.add(bucketFor(id));changed=true;
  }
  if(changed){
    cache.boards.clear();cache.items.clear();
    for(const {summary:record} of cache.records.values()){
      if(!cache.boards.has(record.boardId))cache.boards.set(record.boardId,[]);cache.boards.get(record.boardId).push(record);
      if(record.itemId){if(!cache.items.has(record.itemId))cache.items.set(record.itemId,[]);cache.items.get(record.itemId).push(record);}
    }
  }
  if(directory)for(const bucket of dirty){
    const file=path.join(directory,`${bucket}.json`),temporary=`${file}.${randomUUID()}.tmp`;
    try{
      // Only derived summaries are published, never authoritative message bodies.
      const records=[...cache.records.values()].filter(entry=>bucketFor(entry.summary.id)===bucket);
      await writeFile(temporary,JSON.stringify({schemaVersion:1,workspaceId,recordsDigest:createHash('sha256').update(JSON.stringify(records)).digest('hex'),records}),{flag:'wx',mode:0o600});await rename(temporary,file);
    }catch{/* This cache is optional; canonical feedback remains usable. */}
    finally{await rm(temporary,{force:true}).catch(()=>{});}
  }
  return cache;
}
async function anchorStatus(root,thread,{config,resourceRoots,documentSources}={}){
  if(!thread.anchor)return 'general';
  const board=await readStoreDocument(root,'boards',thread.boardId,{optional:true});
  if(!board)return 'detached';
  if(thread.anchor.kind==='point')return (await pointLocation(root,thread)).anchorPoint.detached?'detached':'point';
  const item=await readStoreDocument(root,'items',thread.itemId,{optional:true});
  if(!item||item.deletedAt)return 'detached';
  return documentAnchorStatus(config,item,thread.anchor,{resourceRoots,documentSources});
}
async function pointLocation(root,thread){
  if(thread.anchor?.kind!=='point')return {};
  const board=await readStoreDocument(root,'boards',thread.boardId,{optional:true});
  const placement=board?.placements.find(p=>p.id===thread.anchor.placementId);
  if(placement){const item=await readStoreDocument(root,'items',placement.itemId,{optional:true});board.items={[placement.itemId]:item||{deletedAt:true}};}
  return {anchorPoint:resolveCommentPoint(thread.anchor,board)};
}
export async function listFeedback(config,input={}){
  keys(input,['boardId','itemId','threadId','resolved','limit','cursor','includeBodies'],'feedback query');
  for(const key of ['boardId','itemId','threadId'])if(input[key]!==undefined)assertId(input[key]);
  if(input.resolved!==undefined&&typeof input.resolved!=='boolean')fail('resolved must be boolean.');
  if(input.includeBodies!==undefined&&typeof input.includeBodies!=='boolean')fail('includeBodies must be boolean.');
  const limit=input.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('Feedback limit must be 1–100.');
  const filter={boardId:input.boardId??null,itemId:input.itemId??null,resolved:input.resolved??null,includeBodies:input.includeBodies??false};
  const fingerprint=createHash('sha256').update(JSON.stringify(filter)).digest('hex');
  let cursor;
  if(input.cursor!==undefined){try{if(typeof input.cursor!=='string'||input.cursor.length>1024)throw Error();cursor=JSON.parse(Buffer.from(input.cursor,'base64url'));}catch{fail('Invalid feedback cursor.');}if(cursor.fingerprint!==fingerprint||!Number.isSafeInteger(cursor.revision)||typeof cursor.id!=='string'||typeof cursor.createdAt!=='string')fail('Cursor does not match this query.');}
  return withStore(config,async(root,state)=>{
    if(!state)return {revision:0,threads:[],nextCursor:null};
    const revision=state.metadata.revision,documentContext={config,resourceRoots:state.metadata.resourceRoots,documentSources:new Map()};
    if(cursor&&cursor.revision!==revision)throw storeError(409,'Feedback cursor is stale. Restart the query.');
    if(input.threadId){const thread=validateThread(await readStoreDocument(root,'threads',input.threadId));if(input.boardId!==undefined&&thread.boardId!==input.boardId||input.itemId!==undefined&&thread.itemId!==input.itemId||input.resolved!==undefined&&thread.resolved!==input.resolved)return {revision,threads:[],nextCursor:null};return {revision,threads:[{...thread,...await pointLocation(root,thread),anchorStatus:await anchorStatus(root,thread,documentContext)}],nextCursor:null};}
    const cache=await feedbackIndex(root,state.metadata.id),selected=[];
    const candidates=input.boardId!==undefined?(cache.boards.get(input.boardId)||[]):input.itemId!==undefined?(cache.items.get(input.itemId)||[]):[...cache.records.values()].map(record=>record.summary);
    for(const thread of candidates){
      if(input.itemId!==undefined&&thread.itemId!==input.itemId||input.resolved!==undefined&&thread.resolved!==input.resolved)continue;
      if(cursor&&compare(thread,cursor)<=0)continue;
      selected.push(thread);selected.sort(compare);if(selected.length>limit+1)selected.pop();
    }
    let hasMore=selected.length>limit;selected.length=Math.min(selected.length,limit);
    const threads=[];let responseBytes=0;
    for(const entry of selected){
      const thread=input.includeBodies?validateThread(await readStoreDocument(root,'threads',entry.id)):entry;
      const result={...thread,...await pointLocation(root,thread),anchorStatus:await anchorStatus(root,thread,documentContext)},bytes=Buffer.byteLength(JSON.stringify(result));
      if(threads.length&&responseBytes+bytes>2_000_000){hasMore=true;break;}
      threads.push(result);responseBytes+=bytes;
    }
    const last=threads.at(-1);
    return {revision,threads,nextCursor:hasMore?Buffer.from(JSON.stringify({fingerprint,revision,id:last.id,createdAt:last.createdAt})).toString('base64url'):null};
  },{metadataOnly:true});
}
const string={type:'string'},id={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$',maxLength:128};
const actorSchema={type:'object',additionalProperties:false,required:['id','label','kind'],properties:{id,label:{type:'string',minLength:1,maxLength:120},kind:{enum:['human','agent']}}};
const anchorSchema={oneOf:[{type:'object',additionalProperties:false,required:['kind','x','y'],properties:{kind:{const:'point'},x:{type:'number',minimum:-10000000,maximum:10000000},y:{type:'number',minimum:-10000000,maximum:10000000},placementId:id,decorationId:id,relative:{type:'object',additionalProperties:false,required:['x','y'],properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}}}},allOf:[{not:{required:['placementId','decorationId']}},{if:{required:['relative']},then:{oneOf:[{required:['placementId']},{required:['decorationId']}]}}]},{type:'object',additionalProperties:false,required:['kind','quote'],properties:{kind:{const:'text'},quote:{type:'string',minLength:1,maxLength:20000},prefix:{...string,maxLength:2000},suffix:{...string,maxLength:2000},start:{type:'integer',minimum:0,maximum:2000000},end:{type:'integer',minimum:1,maximum:2000000},sourceRevision:{...string,maxLength:256}}}]};
const schema=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const common={expectedRevision:{type:'integer',minimum:0},operationId:id};
export const feedbackToolDefinitions=[
  {name:'feedback.list',mutating:false,description:'List compact feedback summaries by board/item or inspect one complete thread. Cursor binds the workspace revision. Point results include anchorPoint with resolved x/y and detached/fallback flags. Actor names are self-reported.',inputSchema:schema({boardId:id,itemId:id,threadId:id,resolved:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:100},cursor:string,includeBodies:{type:'boolean'}})},
  {name:'feedback.comment',mutating:true,description:'Add a general, board-point, item or exact text-quote comment. Optional point relative:{x,y} fractions (0–1) require one target and follow its bounds; x/y retains the creation fallback. Author is a self-reported local identity.',inputSchema:schema({...common,boardId:id,id,itemId:id,anchor:anchorSchema,author:actorSchema,body:{...string,minLength:1,maxLength:20000}},['boardId','author','body'])},
  {name:'feedback.reply',mutating:true,description:'Append a human or agent reply to a stable feedback thread.',inputSchema:schema({...common,threadId:id,id,author:actorSchema,body:{...string,minLength:1,maxLength:20000}},['threadId','author','body'])},
  {name:'feedback.resolve',mutating:true,description:'Resolve or reopen a feedback thread without losing its messages.',inputSchema:schema({...common,threadId:id,resolved:{type:'boolean'}},['threadId','resolved'])},
  {name:'item.vote',mutating:true,description:'Set one current yes/no/abstain vote per self-reported actor on a canonical item. null clears that actor’s vote; references share votes.',inputSchema:schema({...common,itemId:id,actor:actorSchema,value:{enum:['yes','no','abstain',null]}},['itemId','actor','value'])},
];
export function dispatchFeedbackTool(config,name,input){const type={'feedback.comment':'addComment','feedback.reply':'replyComment','feedback.resolve':'resolveComment','item.vote':'vote'}[name];if(name==='feedback.list')return listFeedback(config,input);if(!type)throw storeError(404,'Unknown feedback tool.');return applyFeedbackOperation(config,{type,...input});}
