// Independent feedback documents use the same lock, journal and revision as graph edits.
import {randomUUID,createHash} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile,rename,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {assertId,storeError,withStore,withScopedTransaction,readStoreDocument,listStoreDocumentIds} from './store.mjs';
import {documentAnchorState,validReanchorHistory} from './document-anchors.mjs';
import {resolveCommentPoint} from '../public/feedback-geometry.js';
const types=new Set(['addComment','replyComment','resolveComment','vote','setCommentStatus','editComment','deleteComment']);
// Comment tool (1.1): thread status with history, an addressee, structured references and
// changes, a target label snapshot, and author-only edit/delete that keep history.
export const COMMENT_STATUSES=['open','sent','working','addressed','question','resolved'];
const REF_KINDS=['item','placement','decoration','board'];
const fail=message=>{throw storeError(400,message);};
const object=(value,name)=>{if(!value||typeof value!=='object'||Array.isArray(value))fail(`${name} must be an object.`);return value;};
function keys(value,allowed,name){object(value,name);for(const key of Object.keys(value))if(!allowed.includes(key))fail(`Unknown ${name} field: ${key}.`);}
function text(value,name,max,{empty=false}={}){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||value.includes('\0'))fail(`Invalid ${name}.`);return value;}
function actor(value){keys(value,['id','label','kind'],'actor');assertId(value.id);text(value.label,'actor label',120);if(!['human','agent'].includes(value.kind))fail('Actor kind must be human or agent.');return structuredClone(value);}
function addressee(value){keys(value,['kind','id'],'addressee');if(!['agent','human'].includes(value.kind))fail('Addressee kind must be agent or human.');if(value.id!==undefined)assertId(value.id);return structuredClone(value);}
function references(value,name,{change=false}={}){
  if(!Array.isArray(value)||value.length>20)fail(`${name} must be a list of at most 20.`);
  for(const entry of value){
    keys(entry,['kind','id','boardId','label',...(change?['note']:[])],name);if(!REF_KINDS.includes(entry.kind))fail(`Unknown ${name} kind.`);assertId(entry.id);
    if(entry.boardId!==undefined)assertId(entry.boardId);if(['placement','decoration'].includes(entry.kind)&&entry.boardId===undefined)fail(`A ${entry.kind} reference needs boardId.`);
    text(entry.label,`${name} label`,120);if(change&&entry.note!==undefined)text(entry.note,'change note',500,{empty:true});
  }
  return structuredClone(value);
}
function statusValue(value){if(!COMMENT_STATUSES.includes(value))fail('Unknown comment status.');return value;}
function timestamp(value,name){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))fail(`Invalid ${name}.`);}
function messageHistory(value,name){
  for(const key of ['editedAt','deletedAt'])if(value[key]!==undefined)timestamp(value[key],key);
  if(value.deletedBy!==undefined)actor(value.deletedBy);if((value.deletedAt===undefined)!==(value.deletedBy===undefined))fail(`Invalid ${name} deletion.`);
  if(value.editHistory!==undefined){if(!Array.isArray(value.editHistory)||value.editHistory.length>50)fail(`Invalid ${name} edit history.`);for(const entry of value.editHistory){keys(entry,['body','refs','at'],'edit');text(entry.body,'edited body',20_000);if(entry.refs!==undefined)references(entry.refs,'reference');timestamp(entry.at,'edit time');}}
}
export const threadStatus=thread=>thread.status??(thread.resolved?'resolved':'open');
// Newest message that is not deleted, else the root author.
export function lastAuthor(thread){for(let i=thread.replies.length-1;i>=0;i--)if(!thread.replies[i].deletedAt)return thread.replies[i].author;return thread.author;}
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
    keys(value,['kind','quote','prefix','suffix','start','end','sourceRevision','textModel'],'text anchor');
    if(!itemId)fail('Text anchors require itemId.');text(value.quote,'anchor quote',20_000);
    for(const key of ['prefix','suffix'])if(value[key]!==undefined)text(value[key],key,2000,{empty:true});
    if((value.start===undefined)!==(value.end===undefined))fail('Text offsets require both start and end.');
    if(value.start!==undefined&&(!Number.isSafeInteger(value.start)||value.start<0||!Number.isSafeInteger(value.end)||value.end<=value.start||value.end>2_000_000))fail('Invalid text offsets.');
    if(value.sourceRevision!==undefined)text(value.sourceRevision,'source revision',256);
    if(value.textModel!==undefined)text(value.textModel,'text model',80);
  }else fail('Unknown anchor kind.');
  return structuredClone(value);
}
function validateThread(value){
  keys(value,['id','boardId','itemId','anchor','author','body','createdAt','updatedAt','replies','resolved','reanchored','status','statusHistory','to','refs','targetLabel','editedAt','editHistory','deletedAt','deletedBy','updatedRevision'],'thread');
  if(!validReanchorHistory(value.reanchored)||value.reanchored&&value.anchor?.kind!=='text')fail('Invalid thread re-anchor history.');
  assertId(value.id);assertId(value.boardId);if(value.itemId!==undefined)assertId(value.itemId);
  actor(value.author);text(value.body,'comment body',20_000);if(value.anchor)anchor(value.anchor,value.itemId);
  if(!Array.isArray(value.replies)||value.replies.length>500||typeof value.resolved!=='boolean')fail('Invalid thread replies or resolution.');
  const ids=new Set();
  if(value.status!==undefined&&(statusValue(value.status)==='resolved')!==value.resolved)fail('Thread status and resolved disagree.');
  if(value.statusHistory!==undefined){if(!Array.isArray(value.statusHistory)||value.statusHistory.length>200)fail('Invalid status history.');for(const entry of value.statusHistory){keys(entry,['status','actor','at','note'],'status entry');statusValue(entry.status);if(entry.actor!==undefined)actor(entry.actor);timestamp(entry.at,'status time');if(entry.note!==undefined)text(entry.note,'status note',500,{empty:true});}}
  if(value.to!==undefined)addressee(value.to);if(value.refs!==undefined)references(value.refs,'reference');if(value.targetLabel!==undefined)text(value.targetLabel,'target label',120);
  if(value.updatedRevision!==undefined&&(!Number.isSafeInteger(value.updatedRevision)||value.updatedRevision<0))fail('Invalid thread revision.');
  messageHistory(value,'comment');
  for(const reply of value.replies){keys(reply,['id','author','body','createdAt','refs','changes','editedAt','editHistory','deletedAt','deletedBy'],'reply');if(reply.refs!==undefined)references(reply.refs,'reference');if(reply.changes!==undefined)references(reply.changes,'change',{change:true});messageHistory(reply,'reply');assertId(reply.id);if(ids.has(reply.id))fail('Duplicate reply ID.');ids.add(reply.id);actor(reply.author);text(reply.body,'reply body',20_000);if(!Number.isFinite(Date.parse(reply.createdAt)))fail('Invalid reply timestamp.');}
  for(const key of ['createdAt','updatedAt'])if(!Number.isFinite(Date.parse(value[key])))fail('Invalid thread timestamp.');
  if(Buffer.byteLength(JSON.stringify(value))>1_000_000)fail('Thread has reached its size limit. Start a new thread.');
  return value;
}
function validateOperation(operation){
  const fields={addComment:['boardId','id','itemId','anchor','author','body','to','refs','targetLabel','status'],replyComment:['threadId','id','author','body','refs','changes','status'],resolveComment:['threadId','resolved','actor'],vote:['itemId','actor','value'],
    setCommentStatus:['threadId','actor','status','to','note'],editComment:['threadId','messageId','actor','body','refs'],deleteComment:['threadId','messageId','actor']}[operation?.type];
  if(!fields)fail('Unknown feedback operation.');keys(operation,['type','expectedRevision','operationId',...fields],'operation');
  for(const key of ['boardId','itemId','threadId','id'])if(operation[key]!==undefined)assertId(operation[key]);
  if(['addComment','replyComment'].includes(operation.type)){actor(operation.author);text(operation.body,'comment body',20_000);}
  if(operation.type==='addComment'){assertId(operation.boardId);if(operation.anchor)anchor(operation.anchor,operation.itemId);if(operation.anchor?.textModel!==undefined&&operation.anchor.textModel!=='markdown-v2')fail('Unsupported text model for a new comment.');}
  if(['replyComment','resolveComment','setCommentStatus','editComment','deleteComment'].includes(operation.type))assertId(operation.threadId);
  if(operation.messageId!==undefined)assertId(operation.messageId);
  if(['setCommentStatus','editComment','deleteComment'].includes(operation.type)||operation.type==='resolveComment'&&operation.actor!==undefined)actor(operation.actor);
  if(operation.type==='editComment')text(operation.body,'comment body',20_000);
  if(operation.refs!==undefined)references(operation.refs,'reference');if(operation.changes!==undefined)references(operation.changes,'change',{change:true});
  if(operation.to!==undefined&&!(operation.type==='setCommentStatus'&&operation.to===null))addressee(operation.to);
  if(operation.targetLabel!==undefined)text(operation.targetLabel,'target label',120);if(operation.note!==undefined)text(operation.note,'status note',500,{empty:true});
  if(operation.status!==undefined)statusValue(operation.status);
  if(operation.type==='addComment'&&operation.status!==undefined&&!['open','sent'].includes(operation.status))fail('A new comment starts open or sent.');
  if(operation.type==='addComment'&&operation.status==='sent'&&operation.to?.kind!=='agent')fail('A comment sent at once needs to:{kind:"agent"}.');
  if(operation.type==='setCommentStatus'&&operation.status===undefined&&operation.to===undefined)fail('Provide status or to.');
  if(operation.type==='resolveComment'&&typeof operation.resolved!=='boolean')fail('resolved must be boolean.');
  if(operation.type==='vote'){assertId(operation.itemId);actor(operation.actor);if(![null,'yes','no','abstain'].includes(operation.value))fail('Vote value must be yes, no, abstain or null.');}
}
export const isFeedbackOperation=operation=>types.has(operation?.type);
export async function applyFeedbackOperation(config,operation){
  validateOperation(operation);
  // A status or addressee that would not change returns without a transaction (no revision).
  if(['setCommentStatus','resolveComment'].includes(operation.type)){
    const settled=await withStore(config,async(root,state)=>{
      if(!state)return null;
      const thread=validateThread(await readStoreDocument(root,'threads',operation.threadId)),status=operation.type==='resolveComment'?(operation.resolved?'resolved':'open'):operation.status;
      if(status!==undefined)checkStatusRule(thread,operation.actor,status);
      const same=(status===undefined||threadStatus(thread)===status)&&(operation.to===undefined||JSON.stringify(operation.to)===JSON.stringify(thread.to??null));
      return same?{revision:state.metadata.revision,result:{threadId:thread.id,resolved:thread.resolved,status:threadStatus(thread),...(thread.to?{to:thread.to}:{}),unchanged:true}}:null;
    },{metadataOnly:true});
    if(settled)return settled;
  }
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
      const status=operation.status||'open',author=actor(operation.author),label=operation.targetLabel??await targetLabelFor(tx,board,operation);
      const thread={id,boardId:board.id,...(operation.itemId?{itemId:operation.itemId}:{}),...(operation.anchor?{anchor:anchor(operation.anchor,operation.itemId)}:{}),author,body:operation.body,createdAt:now,updatedAt:now,replies:[],resolved:false,
        status,statusHistory:[{status,actor:author,at:now}],...(operation.to?{to:addressee(operation.to)}:{}),...(operation.refs?.length?{refs:references(operation.refs,'reference')}:{}),...(label?{targetLabel:label}:{}),updatedRevision:tx.metadata.revision+1};
      validateThread(thread);tx.write('threads',id,thread);return {threadId:id,status};
    }
    const thread=validateThread(await tx.read('threads',operation.threadId)),write=()=>{thread.updatedAt=now;thread.updatedRevision=tx.metadata.revision+1;validateThread(thread);tx.write('threads',thread.id,thread);};
    if(operation.type==='replyComment'){
      const id=operation.id||`reply-${randomUUID()}`;
      if(thread.replies.some(reply=>reply.id===id))throw storeError(409,'Reply ID already exists.');
      const author=actor(operation.author);
      if(operation.status!==undefined)checkStatusRule(thread,author,operation.status);
      thread.replies.push({id,author,body:operation.body,createdAt:now,...(operation.refs?.length?{refs:references(operation.refs,'reference')}:{}),...(operation.changes?.length?{changes:references(operation.changes,'change',{change:true})}:{})});
      // A person answering the agent's question or addressed note hands the thread back to it.
      const next=operation.status??(author.kind==='human'&&thread.to?.kind==='agent'&&['question','addressed'].includes(threadStatus(thread))?'sent':undefined);
      if(next!==undefined)moveStatus(thread,next,author,now);
      write();return {threadId:thread.id,replyId:id,status:threadStatus(thread)};
    }
    if(operation.type==='resolveComment'||operation.type==='setCommentStatus'){
      const who=operation.actor?actor(operation.actor):undefined,status=operation.type==='resolveComment'?(operation.resolved?'resolved':'open'):operation.status;
      let changed=false;
      if(status!==undefined){checkStatusRule(thread,who,status);changed=moveStatus(thread,status,who,now,operation.note)||changed;}
      if(operation.to!==undefined&&JSON.stringify(operation.to)!==JSON.stringify(thread.to??null)){if(operation.to===null)delete thread.to;else thread.to=addressee(operation.to);changed=true;}
      if(changed)write();
      return {threadId:thread.id,resolved:thread.resolved,status:threadStatus(thread),...(thread.to?{to:thread.to}:{}),...(changed?{}:{unchanged:true})};
    }
    // editComment / deleteComment: the message's own author only; earlier versions are kept.
    const messageId=operation.messageId&&operation.messageId!==thread.id?operation.messageId:null,message=messageId?thread.replies.find(reply=>reply.id===messageId):thread;
    if(!message)throw storeError(404,'Comment message not found.');
    const who=actor(operation.actor);
    if(message.author.id!==who.id||message.author.kind!==who.kind)throw storeError(403,'Only the author can edit or delete this comment.');
    if(message.deletedAt)throw storeError(409,'This comment has been deleted.');
    if(operation.type==='editComment'){
      message.editHistory=[...(message.editHistory||[]),{body:message.body,...(message.refs?{refs:message.refs}:{}),at:message.editedAt||message.createdAt}].slice(-50);
      message.body=operation.body;if(operation.refs!==undefined){if(operation.refs.length)message.refs=references(operation.refs,'reference');else delete message.refs;}message.editedAt=now;
    }else{message.deletedAt=now;message.deletedBy=who;}
    write();
    return {threadId:thread.id,messageId:messageId||thread.id,...(operation.type==='deleteComment'?{threadDeleted:threadHidden(thread)}:{})};
  });
}
// A deleted root with no live replies hides the whole thread from default listings.
export const threadHidden=thread=>!!thread.deletedAt&&thread.replies.every(reply=>reply.deletedAt);
// The agent never resolves or reopens a person's comment; it replies and sets addressed.
function checkStatusRule(thread,who,status){
  if(who?.kind==='agent'&&thread.author.kind==='human'&&['resolved','open'].includes(status))throw storeError(403,'An agent cannot resolve or reopen a person\'s comment. Reply with what changed and set it to addressed; the author resolves it.');
}
function moveStatus(thread,status,who,at,note){
  if(threadStatus(thread)===status)return false;
  thread.status=status;thread.resolved=status==='resolved';
  thread.statusHistory=[...(thread.statusHistory||[]),{status,...(who?{actor:who}:{}),at,...(note?{note}:{})}].slice(-200);
  return true;
}
// The name of what a comment was placed on, kept so a pin can say what it was on after a delete.
async function targetLabelFor(tx,board,operation){
  const a=operation.anchor,label=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,120)||undefined;
  if(a?.kind==='point'&&a.decorationId){const d=(board.decorations||[]).find(entry=>entry.id===a.decorationId);if(!d)return undefined;return label(d.text?.split('\n')[0].slice(0,60))||({text:'Text',region:'Shape',line:'Arrow'}[d.type]||'Drawing');}
  const placementId=a?.kind==='point'?a.placementId:undefined,placement=placementId&&board.placements.find(p=>p.id===placementId);
  const itemId=placement?.itemId||operation.itemId;if(!itemId)return undefined;
  const item=await tx.read('items',itemId,{optional:true});return label(item?.title);
}
export function voteTotals(votes={}){const totals={yes:0,no:0,abstain:0};for(const vote of Object.values(votes))if(Object.hasOwn(totals,vote.value))totals[vote.value]++;return totals;}
function compare(a,b){return a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);}
function summary(thread){return {id:thread.id,boardId:thread.boardId,...(thread.itemId?{itemId:thread.itemId}:{}),...(thread.anchor?{anchor:thread.anchor}:{}),author:thread.author,excerpt:thread.deletedAt?'':thread.body.slice(0,240),createdAt:thread.createdAt,updatedAt:thread.updatedAt,replyCount:thread.replies.filter(reply=>!reply.deletedAt).length,resolved:thread.resolved,
  status:threadStatus(thread),...(thread.to?{to:thread.to}:{}),...(thread.refs&&!thread.deletedAt?{refs:thread.refs}:{}),...(thread.targetLabel?{targetLabel:thread.targetLabel}:{}),lastAuthor:lastAuthor(thread),updatedRevision:thread.updatedRevision??0,...(threadHidden(thread)?{deleted:true}:{})};}
// Rebuildable derived summaries, sharded across 32 files. Source stat identities
// are checked under the existing lock, including across fresh CLI processes.
const feedbackIndexes=new Map();
const bucketFor=id=>(parseInt(createHash('sha256').update(id).digest('hex').slice(0,2),16)%32).toString(16).padStart(2,'0');
function validateSummary(value){
  keys(value,['id','boardId','itemId','anchor','author','excerpt','createdAt','updatedAt','replyCount','resolved','status','to','refs','targetLabel','lastAuthor','updatedRevision','deleted'],'feedback summary');
  if(value.status===undefined||value.lastAuthor===undefined||value.updatedRevision===undefined)fail('Feedback summary predates comment status.');
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
        if(saved.schemaVersion!==2||saved.workspaceId!==workspaceId||!Array.isArray(saved.records)||saved.recordsDigest!==createHash('sha256').update(JSON.stringify(saved.records)).digest('hex'))throw Error('Stale or damaged bucket');
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
      await writeFile(temporary,JSON.stringify({schemaVersion:2,workspaceId,recordsDigest:createHash('sha256').update(JSON.stringify(records)).digest('hex'),records}),{flag:'wx',mode:0o600});await rename(temporary,file);
    }catch{/* This cache is optional; canonical feedback remains usable. */}
    finally{await rm(temporary,{force:true}).catch(()=>{});}
  }
  return cache;
}
// Anchor state for a listed thread: {anchorStatus} plus currentAnchor when a text anchor relocates.
async function anchorState(root,thread,context){const state=await anchorStatus(root,thread,context);return typeof state==='string'?{anchorStatus:state}:{anchorStatus:state.status,...(state.currentAnchor?{currentAnchor:state.currentAnchor}:{})};}
async function anchorStatus(root,thread,{config,resourceRoots,documentSources}={}){
  if(!thread.anchor)return 'general';
  const board=await readStoreDocument(root,'boards',thread.boardId,{optional:true});
  if(!board)return 'detached';
  if(thread.anchor.kind==='point')return (await pointLocation(root,thread)).anchorPoint.detached?'detached':'point';
  const item=await readStoreDocument(root,'items',thread.itemId,{optional:true});
  if(!item||item.deletedAt)return 'detached';
  return documentAnchorState(config,item,thread.anchor,{resourceRoots,documentSources});
}
async function pointLocation(root,thread){
  if(thread.anchor?.kind!=='point')return {};
  const board=await readStoreDocument(root,'boards',thread.boardId,{optional:true});
  const placement=board?.placements.find(p=>p.id===thread.anchor.placementId);
  if(placement){const item=await readStoreDocument(root,'items',placement.itemId,{optional:true});board.items={[placement.itemId]:item||{deletedAt:true}};}
  return {anchorPoint:resolveCommentPoint(thread.anchor,board)};
}
// Text-anchored threads on one item, from the derived index. Call only under withStore.
export async function textThreadIds(root,workspaceId,itemId){const cache=await feedbackIndex(root,workspaceId);return (cache.items.get(itemId)||[]).filter(summary=>summary.anchor?.kind==='text').map(summary=>summary.id);}
export {validateThread};
// References report whether their target still exists, its state and its current name.
async function referenceState(root,ref,memo){
  const read=(collection,id)=>{const key=collection+'/'+id;if(!memo.has(key))memo.set(key,readStoreDocument(root,collection,id,{optional:true}).catch(()=>null));return memo.get(key);};
  const named=value=>{const text=String(value||'').replace(/\s+/g,' ').trim();return text?{currentLabel:text.slice(0,120)}:{};};
  let state='missing',extra={};
  if(ref.kind==='board'){const board=await read('boards',ref.id);if(board){state=board.deletedAt?'deleted':board.archivedAt?'archived':'active';extra=named(board.title);}}
  else if(ref.kind==='item'){const item=await read('items',ref.id);if(item){state=item.deletedAt?'deleted':'active';extra=named(item.title);}}
  else{
    const board=await read('boards',ref.boardId);
    if(board&&ref.kind==='placement'){const placement=board.placements.find(entry=>entry.id===ref.id);if(placement){state=placement.deletedAt?'deleted':placement.removedAt?'removed':placement.archivedAt?'archived':'active';const item=await read('items',placement.itemId);extra=named(item?.title);}}
    if(board&&ref.kind==='decoration'){const decoration=(board.decorations||[]).find(entry=>entry.id===ref.id);if(decoration){state='active';extra=named(String(decoration.text||'').split('\n')[0])||{currentLabel:{text:'Text',region:'Shape',line:'Arrow'}[decoration.type]||'Drawing'};}}
  }
  return {...ref,exists:state==='active'||state==='archived',state,...extra};
}
const withReferenceStates=async(root,list,memo)=>list?Promise.all(list.map(ref=>referenceState(root,ref,memo))):list;
// A listed message: deleted bodies and edit history only with includeHistory.
function shownMessage(message,includeHistory){
  const shown={...message};
  if(!includeHistory){delete shown.editHistory;if(message.deletedAt){shown.body='';shown.refs=[];if(shown.changes)shown.changes=[];}}
  return shown;
}
async function presentThread(root,thread,{includeHistory,memo}){
  const shown=shownMessage(thread,includeHistory);
  shown.status=threadStatus(thread);shown.statusHistory=thread.statusHistory||[];shown.lastAuthor=lastAuthor(thread);
  if(shown.refs)shown.refs=await withReferenceStates(root,shown.refs,memo);
  if(Array.isArray(thread.replies))shown.replies=await Promise.all(thread.replies.map(async reply=>{const r=shownMessage(reply,includeHistory);if(r.refs)r.refs=await withReferenceStates(root,r.refs,memo);if(r.changes)r.changes=await withReferenceStates(root,r.changes,memo);return r;}));
  return shown;
}
const sinceToken=(revision,id)=>Buffer.from(JSON.stringify({r:revision,id})).toString('base64url');
function readSince(value){
  if(value==='')return {r:-1,id:''};
  try{if(typeof value!=='string'||value.length>512)throw Error();const token=JSON.parse(Buffer.from(value,'base64url'));if(!Number.isSafeInteger(token.r)||typeof token.id!=='string')throw Error();return token;}catch{fail('Invalid since token.');}
}
const afterToken=(entry,token)=>entry.updatedRevision>token.r||entry.updatedRevision===token.r&&entry.id>token.id;
const bySince=(a,b)=>a.updatedRevision-b.updatedRevision||(a.id<b.id?-1:a.id>b.id?1:0);
export async function listFeedback(config,input={}){
  keys(input,['boardId','itemId','threadId','resolved','limit','cursor','includeBodies','status','to','toId','authorKind','updatedAfter','since','includeHistory','includeDeleted'],'feedback query');
  for(const key of ['boardId','itemId','threadId','toId'])if(input[key]!==undefined)assertId(input[key]);
  for(const key of ['resolved','includeBodies','includeHistory','includeDeleted'])if(input[key]!==undefined&&typeof input[key]!=='boolean')fail(`${key} must be boolean.`);
  const statuses=input.status===undefined?null:(Array.isArray(input.status)?input.status:String(input.status).split(',')).map(value=>statusValue(String(value).trim()));
  if(statuses&&(!statuses.length||statuses.length>6))fail('Provide one to six statuses.');
  if(input.to!==undefined&&!['agent','human'].includes(input.to))fail('to must be agent or human.');
  if(input.authorKind!==undefined&&!['agent','human'].includes(input.authorKind))fail('authorKind must be agent or human.');
  if(input.updatedAfter!==undefined)timestamp(input.updatedAfter,'updatedAfter');
  if(input.since!==undefined&&input.cursor!==undefined)fail('Use since or cursor, not both.');
  const since=input.since===undefined?null:readSince(input.since);
  const limit=input.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('Feedback limit must be 1–100.');
  const filter={boardId:input.boardId??null,itemId:input.itemId??null,resolved:input.resolved??null,includeBodies:input.includeBodies??false,status:statuses,to:input.to??null,toId:input.toId??null,authorKind:input.authorKind??null,updatedAfter:input.updatedAfter??null,includeHistory:input.includeHistory??false,includeDeleted:input.includeDeleted??false};
  const fingerprint=createHash('sha256').update(JSON.stringify(filter)).digest('hex');
  let cursor;
  if(input.cursor!==undefined){try{if(typeof input.cursor!=='string'||input.cursor.length>1024)throw Error();cursor=JSON.parse(Buffer.from(input.cursor,'base64url'));}catch{fail('Invalid feedback cursor.');}if(cursor.fingerprint!==fingerprint||!Number.isSafeInteger(cursor.revision)||typeof cursor.id!=='string'||typeof cursor.createdAt!=='string')fail('Cursor does not match this query.');}
  const after=input.updatedAfter===undefined?null:Date.parse(input.updatedAfter);
  const matches=entry=>(input.itemId===undefined||entry.itemId===input.itemId)&&(input.resolved===undefined||entry.resolved===input.resolved)&&(!statuses||statuses.includes(entry.status??(entry.resolved?'resolved':'open')))
    &&(input.to===undefined||entry.to?.kind===input.to)&&(input.toId===undefined||entry.to?.id===input.toId)&&(input.authorKind===undefined||entry.author.kind===input.authorKind)
    &&(after===null||Date.parse(entry.updatedAt)>after)&&(input.includeDeleted||!entry.deleted);
  return withStore(config,async(root,state)=>{
    if(!state)return {revision:0,threads:[],nextCursor:null,...(since?{nextSince:input.since}:{})};
    const revision=state.metadata.revision,documentContext={config,resourceRoots:state.metadata.resourceRoots,documentSources:new Map()},memo=new Map(),present={includeHistory:input.includeHistory??false,memo};
    if(cursor&&cursor.revision!==revision)throw storeError(409,'Feedback cursor is stale. Restart the query.');
    if(input.threadId){const thread=validateThread(await readStoreDocument(root,'threads',input.threadId));if(input.boardId!==undefined&&thread.boardId!==input.boardId||!matches({...summary(thread),deleted:undefined}))return {revision,threads:[],nextCursor:null};return {revision,threads:[{...await presentThread(root,thread,present),...await pointLocation(root,thread),...await anchorState(root,thread,documentContext)}],nextCursor:null};}
    const cache=await feedbackIndex(root,state.metadata.id),selected=[],order=since?bySince:compare;
    const candidates=input.boardId!==undefined?(cache.boards.get(input.boardId)||[]):input.itemId!==undefined?(cache.items.get(input.itemId)||[]):[...cache.records.values()].map(record=>record.summary);
    for(const thread of candidates){
      if(!matches(thread))continue;
      if(cursor&&compare(thread,cursor)<=0||since&&!afterToken(thread,since))continue;
      selected.push(thread);selected.sort(order);if(selected.length>limit+1)selected.pop();
    }
    let hasMore=selected.length>limit;selected.length=Math.min(selected.length,limit);
    const threads=[];let responseBytes=0;
    for(const entry of selected){
      const thread=input.includeBodies?await presentThread(root,validateThread(await readStoreDocument(root,'threads',entry.id)),present):{...entry,...(entry.refs?{refs:await withReferenceStates(root,entry.refs,memo)}:{})};
      const result={...thread,...await pointLocation(root,thread),...await anchorState(root,thread,documentContext)},bytes=Buffer.byteLength(JSON.stringify(result));
      if(threads.length&&responseBytes+bytes>2_000_000){hasMore=true;break;}
      threads.push(result);responseBytes+=bytes;
    }
    const last=threads.at(-1);
    if(since)return {revision,threads,nextCursor:null,nextSince:last?sinceToken(last.updatedRevision??0,last.id):input.since,...(hasMore?{hasMore:true}:{})};
    return {revision,threads,nextCursor:hasMore?Buffer.from(JSON.stringify({fingerprint,revision,id:last.id,createdAt:last.createdAt})).toString('base64url'):null};
  },{metadataOnly:true});
}
const string={type:'string'},id={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$',maxLength:128};
const actorSchema={type:'object',additionalProperties:false,required:['id','label','kind'],properties:{id,label:{type:'string',minLength:1,maxLength:120},kind:{enum:['human','agent']}}};
const anchorSchema={oneOf:[{type:'object',additionalProperties:false,required:['kind','x','y'],properties:{kind:{const:'point'},x:{type:'number',minimum:-10000000,maximum:10000000},y:{type:'number',minimum:-10000000,maximum:10000000},placementId:id,decorationId:id,relative:{type:'object',additionalProperties:false,required:['x','y'],properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}}}},allOf:[{not:{required:['placementId','decorationId']}},{if:{required:['relative']},then:{oneOf:[{required:['placementId']},{required:['decorationId']}]}}]},{type:'object',additionalProperties:false,required:['kind','quote'],properties:{kind:{const:'text'},quote:{type:'string',minLength:1,maxLength:20000},prefix:{...string,maxLength:2000},suffix:{...string,maxLength:2000},start:{type:'integer',minimum:0,maximum:2000000},end:{type:'integer',minimum:1,maximum:2000000},sourceRevision:{...string,maxLength:256},textModel:{const:'markdown-v2'}}}]};
const schema=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const common={expectedRevision:{type:'integer',minimum:0},operationId:id};
const statusSchema={enum:['open','sent','working','addressed','question','resolved']};
const toSchema={type:'object',additionalProperties:false,required:['kind'],properties:{kind:{enum:['agent','human']},id}};
const refSchema=(change=false)=>({type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['kind','id','label'],properties:{kind:{enum:['item','placement','decoration','board']},id,boardId:id,label:{type:'string',minLength:1,maxLength:120},...(change?{note:{type:'string',maxLength:500}}:{})}}});
export const feedbackToolDefinitions=[
  {name:'feedback.list',mutating:false,description:'List compact feedback summaries by board/item or inspect one complete thread. Filters: status (one or a list), to (agent|human), toId, authorKind, updatedAfter. Cursor binds the workspace revision; since (start with "") is an inbox position that survives unrelated writes and returns nextSince. Summaries carry status, to, refs, targetLabel and lastAuthor; refs report exists/state/currentLabel. Point results include anchorPoint. Actor names are self-reported.',inputSchema:schema({boardId:id,itemId:id,threadId:id,resolved:{type:'boolean'},status:{oneOf:[statusSchema,{type:'array',minItems:1,maxItems:6,items:statusSchema}]},to:{enum:['agent','human']},toId:id,authorKind:{enum:['agent','human']},updatedAfter:string,since:{type:'string',maxLength:512},limit:{type:'integer',minimum:1,maximum:100},cursor:string,includeBodies:{type:'boolean'},includeHistory:{type:'boolean'},includeDeleted:{type:'boolean'}})},
  {name:'feedback.comment',mutating:true,description:'Add a general, board-point, item or exact text-quote comment. Optional point relative:{x,y} fractions (0–1) require one target and follow its bounds; x/y retains the creation fallback. to:{kind:agent|human,id?} addresses it; status "sent" (with to agent) hands it to the agent at once. refs are structured @ references; targetLabel snapshots what it is on (computed when omitted). Author is a self-reported local identity.',inputSchema:schema({...common,boardId:id,id,itemId:id,anchor:anchorSchema,author:actorSchema,body:{...string,minLength:1,maxLength:20000},to:toSchema,refs:refSchema(),targetLabel:{type:'string',minLength:1,maxLength:120},status:{enum:['open','sent']}},['boardId','author','body'])},
  {name:'feedback.reply',mutating:true,description:'Append a human or agent reply to a stable feedback thread. changes lists what the reply changed ("Changed A"); status moves the thread in the same write (an agent: addressed or question; never resolved on a person\'s thread). A person replying to an agent\'s question or addressed note sends the thread back (sent).',inputSchema:schema({...common,threadId:id,id,author:actorSchema,body:{...string,minLength:1,maxLength:20000},refs:refSchema(),changes:refSchema(true),status:statusSchema},['threadId','author','body'])},
  {name:'feedback.setStatus',mutating:true,description:'Set a thread\'s status (open, sent, working, addressed, question, resolved) and/or its addressee to (null clears), recorded with the actor in statusHistory. Agents may set sent, working, addressed or question; an agent may not resolve or reopen a thread a person wrote. Same status again is a no-op.',inputSchema:schema({...common,threadId:id,actor:actorSchema,status:statusSchema,to:{oneOf:[toSchema,{type:'null'}]},note:{type:'string',maxLength:500}},['threadId','actor'])},
  {name:'feedback.resolve',mutating:true,description:'Resolve or reopen a feedback thread without losing its messages (status resolved or open). Pass actor to record who did it; an agent may not resolve or reopen a thread a person wrote.',inputSchema:schema({...common,threadId:id,resolved:{type:'boolean'},actor:actorSchema},['threadId','resolved'])},
  {name:'feedback.edit',mutating:true,description:'Edit your own comment or reply (messageId; omit for the thread\'s first comment). Only the author (same actor id and kind) may edit; the previous version is kept in editHistory.',inputSchema:schema({...common,threadId:id,messageId:id,actor:actorSchema,body:{...string,minLength:1,maxLength:20000},refs:refSchema()},['threadId','actor','body'])},
  {name:'feedback.delete',mutating:true,description:'Delete your own comment or reply (messageId; omit for the first comment). Only the author may delete; the message is kept with deletedAt and listed without its body. A deleted first comment with no live replies hides the thread.',inputSchema:schema({...common,threadId:id,messageId:id,actor:actorSchema},['threadId','actor'])},
  {name:'item.vote',mutating:true,description:'Set one current yes/no/abstain vote per self-reported actor on a canonical item. null clears that actor’s vote; references share votes.',inputSchema:schema({...common,itemId:id,actor:actorSchema,value:{enum:['yes','no','abstain',null]}},['itemId','actor','value'])},
];
export function dispatchFeedbackTool(config,name,input){const type={'feedback.comment':'addComment','feedback.reply':'replyComment','feedback.resolve':'resolveComment','feedback.setStatus':'setCommentStatus','feedback.edit':'editComment','feedback.delete':'deleteComment','item.vote':'vote'}[name];if(name==='feedback.list')return listFeedback(config,input);if(!type)throw storeError(404,'Unknown feedback tool.');return applyFeedbackOperation(config,{type,...input});}
