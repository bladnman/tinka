// An additive operation envelope: older transports reject its unknown type rather
// than silently executing a replacement without its preconditions.
import {isDeepStrictEqual} from 'node:util';
import {structuralBaseline,supportsStructuralOperation,structuralOperations} from '../public/structural-guard.js';
const own=(value,key)=>Object.hasOwn(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid(message){const error=new Error(message);error.status=error.statusCode=400;error.code='GUARDED_BASELINE_INVALID';throw error;}
function keys(value,allowed,label){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))invalid(`Invalid ${label}.`);}
function id(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)||['constructor','prototype','__proto__'].includes(value))invalid('Invalid guarded target ID.');}
const canonicalRefs = refs => refs.map(value => {
  if (!object(value)) return value;
  const {exists,state,currentLabel,...ref} = value;
  return ref;
});
const fields={boardField:['title','description','reviewOrder','background'],itemField:['title','description','number','content','preview','revisions','build','review.note','review.star'],commentField:['body','refs','deletedAt','status','to']};
export function guardedRequest(request){
  if(request?.type!=='guarded')return null;
  request=structuredClone(request);
  keys(request,['type','operationId','operation','baseline'],'guarded envelope');id(request.operationId);
  if(!object(request.operation)||own(request.operation,'operationId')||own(request.operation,'expectedRevision'))invalid('Guarded operation must not include revision or retry identity.');
  const operation=request.operation;
  if(typeof operation.type!=='string')invalid('Guarded operation requires a type.');
  if(request.baseline?.version===2){
    if(!supportsStructuralOperation(operation))invalid('This operation does not support structural guards.');
    keys(request.baseline,['version','facts'],'structural baseline');
    const facts=request.baseline.facts;
    if(!Array.isArray(facts)||!facts.length||facts.length>20000)invalid('Provide structural baseline facts.');
    const seen=new Set();
    for(const fact of facts){
      const scope=fact?.kind==='boardStructure'?'boardId':fact?.kind==='itemStructure'?'itemId':fact?.kind==='resourceStructure'?null:undefined;
      if(scope===undefined)invalid('Unknown structural fact kind.');
      keys(fact,['kind',...(scope?[scope]:[]),'value'],'structural fact');
      if(scope)id(fact[scope]);
      if(!own(fact,'value'))invalid('Structural facts require a value.');
      const key=`${fact.kind}/${scope?fact[scope]:''}`;if(seen.has(key))invalid('Duplicate structural fact.');seen.add(key);
    }
    for(const boardId of new Set([operation.boardId,operation.sourceBoardId,operation.targetBoardId].filter(Boolean)))
      if(!seen.has(`boardStructure/${boardId}`))invalid('Missing structural board fact.');
    return {request,operation,baseline:request.baseline,structural:true};
  }
  const operations = {
    updateBoard: ['type','boardId','patch'],
    updateItem: ['type','itemId','patch'],
    review: ['type','itemId','patch'],
    editComment: ['type','threadId','messageId','actor','body','refs'],
    deleteComment: ['type','threadId','messageId','actor'],
    setCommentStatus: ['type','threadId','actor','status','to','note'],
    resolveComment: ['type','threadId','actor','resolved'],
  };
  const allowed = own(operations, operation.type) ? operations[operation.type] : null;
  if (!allowed) invalid('This operation does not yet support guarded writes.');
  keys(operation, allowed, 'guarded operation');
  keys(request.baseline,['version','facts'],'guarded baseline');
  if(request.baseline.version!==1||!Array.isArray(request.baseline.facts)||!request.baseline.facts.length||request.baseline.facts.length>64)invalid('Provide a version 1 baseline with 1–64 facts.');
  const seen=new Set();
  for(const fact of request.baseline.facts){
    const scope=fact?.kind==='boardField'?'boardId':fact?.kind==='itemField'?'itemId':fact?.kind==='commentField'?'threadId':null;
    if(!scope)invalid('Unknown guarded fact kind.');
    keys(fact,['kind',scope,...(scope==='threadId'?['messageId']:[]),'field','present','value'],'guarded fact');id(fact[scope]);
    if(fact.messageId!==undefined)id(fact.messageId);
    if(!fields[fact.kind].includes(fact.field)||typeof fact.present!=='boolean'||fact.present!==own(fact,'value')||fact.value===undefined&&fact.present)invalid('A fact needs a supported field and explicit presence/value.');
    if(['status','to'].includes(fact.field)&&fact.messageId!==undefined&&fact.messageId!==fact.threadId)invalid('Status and addressee facts belong to the thread.');
    const key=factKey(fact);if(seen.has(key))invalid('Duplicate guarded fact.');seen.add(key);
  }
  const required=[];
  const add=(kind,scope,field)=>required.push({kind,...scope,field});
  if(['updateBoard','updateItem','review'].includes(operation.type)){
    if(!object(operation.patch)||!Object.keys(operation.patch).length)invalid('Provide a nonempty guarded patch.');
    const board=operation.type==='updateBoard',kind=board?'boardField':'itemField',scope=board?{boardId:operation.boardId}:{itemId:operation.itemId};id(Object.values(scope)[0]);
    for(const field of Object.keys(operation.patch)){
      const name=operation.type==='review'?`review.${field}`:field;
      if(!fields[kind].includes(name)||operation.type==='updateItem'&&name.startsWith('review.'))invalid('This patch field does not yet support guarded writes.');
      add(kind,scope,name);
    }
    if(operation.type==='updateItem'&&['content','preview','revisions','build'].some(key=>own(operation.patch,key)))for(const field of ['content','preview','revisions','build'])add(kind,scope,field);
  }else{
    id(operation.threadId);if(operation.messageId!==undefined)id(operation.messageId);
    const message=['editComment','deleteComment'].includes(operation.type),scope={threadId:operation.threadId,...(message&&operation.messageId?{messageId:operation.messageId}:{})};
    for(const field of message?['body','refs','deletedAt']:['status','to'])add('commentField',scope,field);
  }
  for (const fact of required) {
    if (!seen.has(factKey(fact))) invalid(`Missing baseline fact for ${fact.field}.`);
  }
  // Extra facts may tighten an edit, but may only describe this concrete target.
  const expectedTarget = required[0];
  for (const fact of request.baseline.facts) {
    if (fact.kind !== expectedTarget.kind || fact.boardId !== expectedTarget.boardId ||
        fact.itemId !== expectedTarget.itemId || fact.threadId !== expectedTarget.threadId ||
        messageKey(fact) !== messageKey(expectedTarget)) {
      invalid('Baseline fact belongs to another target.');
    }
  }
  return {request,operation,baseline:request.baseline};
}
const messageKey=fact=>fact.messageId===fact.threadId?undefined:fact.messageId;
const factKey=fact=>JSON.stringify([fact.kind,fact.boardId||fact.itemId||fact.threadId,messageKey(fact),fact.field]);
function fieldValue(document,fact){
  if(fact.field==='review.note')return {present:true,value:document.review?.note??''};
  if(fact.field==='review.star')return {present:true,value:document.review?.star??false};
  if(fact.kind==='commentField'){
    if(fact.field==='status')return {present:true,value:document.status??(document.resolved?'resolved':'open')};
    if(fact.field==='to')return {present:true,value:document.to??null};
    if(fact.field==='refs')return {present:true,value:document.refs??[]};
  }
  return own(document,fact.field)?{present:true,value:document[fact.field]}:{present:false};
}
export async function checkGuardedFacts(guard, read, revision) {
  if (!guard) return;
  const cache = new Map();
  for (const fact of guard.baseline.facts) {
    const collection = fact.kind === 'boardField' ? 'boards'
      : fact.kind === 'itemField' ? 'items' : 'threads';
    const target = fact.boardId || fact.itemId || fact.threadId;
    const key = `${collection}/${target}`;
    if (!cache.has(key)) cache.set(key, await read(collection, target, {optional:true}));
    let document = cache.get(key);
    if (document && fact.kind === 'commentField' && messageKey(fact)) {
      document = document.replies?.find(reply => reply.id === fact.messageId);
    }
    const actual = document ? fieldValue(document, fact) : null;
    const expected = fact.kind === 'commentField' && fact.field === 'refs' && Array.isArray(fact.value)
      ? canonicalRefs(fact.value) : fact.value;
    if (actual && actual.present === fact.present &&
        (!actual.present || isDeepStrictEqual(actual.value, expected))) continue;

    const error = new Error(`The ${fact.field} you edited changed or its target is unavailable. Refresh that target and reconcile your draft before saving.`);
    error.status = error.statusCode = 409;
    error.code = 'GUARDED_PRECONDITION_CHANGED';
    error.revision = revision;
    error.conflict = {kind:fact.kind, targetId:target,
      ...(fact.messageId ? {messageId:fact.messageId} : {}), field:fact.field};
    throw error;
  }
}
export function checkStructuralFacts(guard,state){
  if(!guard?.structural)return;
  const current=structuralBaseline(guard.operation,state,{trusted:true});
  if(current&&isDeepStrictEqual(current,guard.baseline))return;
  const expected=new Map(guard.baseline.facts.map(f=>[`${f.kind}/${f.boardId||f.itemId||''}`,f]));
  const changed=current?.facts.find(f=>!isDeepStrictEqual(f,expected.get(`${f.kind}/${f.boardId||f.itemId||''}`)))||guard.baseline.facts[0];
  const error=new Error('The structure you edited or one of its dependencies changed. Refresh the affected board and reconcile before saving.');
  error.status=error.statusCode=409;error.code='GUARDED_PRECONDITION_CHANGED';error.revision=state.metadata.revision;
  error.conflict={kind:changed.kind,targetId:changed.boardId||changed.itemId||'resources',field:'structure'};
  throw error;
}
const idSchema={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$',maxLength:128};
const factSchema=(kind,scope)=>({type:'object',additionalProperties:false,required:['kind',scope,'field','present'],properties:{kind:{const:kind},[scope]:idSchema,...(kind==='commentField'?{messageId:idSchema}:{}),field:{enum:fields[kind]},present:{type:'boolean'},value:{}}});
export const guardedToolDefinition={name:'workspace.guarded',mutating:true,description:'Atomically save a common edit against explicit target facts, allowing unrelated workspace changes. Supply operationId, a concrete operation without expectedRevision/operationId and a version 1 baseline. Supported operations: updateBoard (title/description/reviewOrder/background), updateItem (title/description/number or the complete content/preview/revisions/build fact group), review (review.note/review.star facts), editComment/deleteComment (body/refs/deletedAt), setCommentStatus/resolveComment (status/to). Facts use present:false without value for absence. Review note/star and comment status/to/refs use read-model defaults. A changed target rejects without partial edits; retry the exact immutable envelope after an uncertain response. Never downgrade to an unguarded write.',inputSchema:{type:'object',additionalProperties:false,required:['operationId','operation','baseline'],properties:{operationId:idSchema,operation:{type:'object'},baseline:{type:'object',additionalProperties:false,required:['version','facts'],properties:{version:{const:1},facts:{type:'array',minItems:1,maxItems:64,items:{oneOf:[factSchema('boardField','boardId'),factSchema('itemField','itemId'),factSchema('commentField','threadId')]}}}}}}};

// Version 1 remains unchanged; version 2 is an explicit additive structural wire.
guardedToolDefinition.description += ' Version 2 structural baselines support '+Object.keys(structuralOperations).filter(type=>type!=='importFiles').join(', ')+'. Use projections from current modern read responses; omitted structure is never an empty baseline. Imports use the guardedImport multipart/document transport.';
guardedToolDefinition.inputSchema.properties.baseline={oneOf:[guardedToolDefinition.inputSchema.properties.baseline,{type:'object',additionalProperties:false,required:['version','facts'],properties:{version:{const:2},facts:{type:'array',minItems:1,maxItems:20000,items:{type:'object'}}}}]};
