// Saved annotations follow their passage through document edits, under the exact rule in
// document-anchors.mjs relocateAnchor: highlights (item review) and text-anchored comment threads
// move only when their quote and context occur exactly once in the new text. Each move is kept
// in the record's `reanchored` history. Nothing is written when nothing moves.
import {assertId,storeError,withStore,withScopedTransaction,readStoreDocument} from './store.mjs';
import {readDocumentSource,relocateAnchor,reanchorEntry,appendReanchor,isLocalDocument} from './document-anchors.mjs';
import {textThreadIds,validateThread} from './feedback.mjs';
import {validateHighlights} from './highlights.mjs';

async function relocations(config,read,metadata,item,threadIds){
  const marks=Object.values(item.review?.highlights||{}).filter(mark=>mark.anchor?.kind==='text');
  if(!marks.length&&!threadIds.length)return {highlights:[],threads:[]};
  let source;try{source=await readDocumentSource(config,item.content.resource,metadata.resourceRoots);}catch{return {highlights:[],threads:[],unavailable:true};}
  const highlights=[],threads=[];
  for(const mark of marks){const anchor=relocateAnchor(mark.anchor,source);if(anchor)highlights.push({mark,anchor});}
  for(const id of threadIds){const thread=await read('threads',id,{optional:true});const anchor=thread&&thread.itemId===item.id&&relocateAnchor(thread.anchor,source);if(anchor)threads.push({thread,anchor});}
  return {source,highlights,threads};
}
const summary=(itemId,found,written)=>({itemId,...(found.source?{sourceRevision:found.source.revision}:{}),highlights:found.highlights.map(entry=>entry.mark.id),threads:found.threads.map(entry=>entry.thread.id),...(found.unavailable?{unavailable:true}:{}),written});

// {itemId, expectedRevision?, operationId?}. Returns {revision?, result:{itemId, sourceRevision,
// highlights:[ids moved], threads:[ids moved], written}}; revision only when metadata changed.
export async function reanchorDocument(config,input,{requireDocument=true}={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['itemId','expectedRevision','operationId'].includes(key)))throw storeError(400,'Invalid re-anchor request.');
  assertId(input.itemId);
  const first=await withStore(config,async(root,state)=>{
    if(!state)return null;
    const item=await readStoreDocument(root,'items',input.itemId,{optional:true});
    if(!item||item.deletedAt||!isLocalDocument(item))return null;
    const threadIds=await textThreadIds(root,state.metadata.id,item.id);
    return {threadIds,found:await relocations(config,(collection,id,options)=>readStoreDocument(root,collection,id,options),state.metadata,item,threadIds)};
  },{metadataOnly:true});
  if(!first){if(requireDocument)throw storeError(400,'Only local Markdown document items can be re-anchored.');return {result:{itemId:input.itemId,highlights:[],threads:[],written:false}};}
  if(!first.found.highlights.length&&!first.found.threads.length)return {result:summary(input.itemId,first.found,false)};
  return withScopedTransaction(config,{type:'reanchorDocument',...input},async tx=>{
    const item=await tx.read('items',input.itemId,{optional:true});
    if(!item||item.deletedAt||!isLocalDocument(item))return summary(input.itemId,{highlights:[],threads:[]},false);
    const found=await relocations(config,tx.read,tx.metadata,item,first.threadIds),at=new Date().toISOString();
    if(found.highlights.length){
      const marks=structuredClone(item.review.highlights);
      for(const {mark,anchor} of found.highlights)marks[mark.id]={...marks[mark.id],anchor,reanchored:appendReanchor(mark.reanchored,reanchorEntry(mark.anchor,anchor,at))};
      validateHighlights(marks);tx.write('items',item.id,{...item,review:{...item.review,highlights:marks}});
    }
    for(const {thread,anchor} of found.threads)tx.write('threads',thread.id,validateThread({...thread,anchor,reanchored:appendReanchor(thread.reanchored,reanchorEntry(thread.anchor,anchor,at))}));
    return summary(item.id,found,found.highlights.length+found.threads.length>0);
  });
}
const id={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$',maxLength:128};
export const reanchorToolDefinitions=[
  {name:'document.reanchor',mutating:true,description:'After editing a local Markdown document item\'s file, move its saved highlights and text-anchored comment threads to their passage in the current text. A mark moves only when its exact quote with its saved prefix and suffix occurs exactly once; edited, ambiguous or missing quotes stay for review. Each move is recorded in the mark\'s reanchored history. Writes nothing when nothing moves; saves made in Tinka do this automatically.',inputSchema:{type:'object',additionalProperties:false,properties:{itemId:id,expectedRevision:{type:'integer',minimum:0},operationId:id},required:['itemId']}},
];
export function dispatchReanchorTool(config,name,input){if(name!=='document.reanchor')throw storeError(404,'Unknown document tool.');return reanchorDocument(config,input);}
