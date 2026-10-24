// Bodyless canonical review marks. No source mutation or synthetic discussion.
import {randomUUID} from 'node:crypto';
import {assertId,storeError,withStore,withScopedTransaction,readStoreDocument} from './store.mjs';
import {documentRevision,readDocumentSource,documentAnchorStatus} from './document-anchors.mjs';
import {validTextAnchor,locateTextAnchor,DOCUMENT_BYTE_LIMIT} from '../public/markdown-document.js';
export const HIGHLIGHT_LIMIT=200,HIGHLIGHT_BYTE_LIMIT=256*1024;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw storeError(400,message);};
function keys(value,allowed,label){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(`Invalid ${label}.`);}
function author(value){keys(value,['id','label','kind'],'highlight author');assertId(value.id);if(typeof value.label!=='string'||!value.label.trim()||value.label.length>120||value.label.includes('\0')||!['human','agent'].includes(value.kind))fail('Invalid highlight author.');}
export function validateHighlights(value){
 if(value===undefined)return;
 if(!object(value)||Object.keys(value).length>HIGHLIGHT_LIMIT||Buffer.byteLength(JSON.stringify(value))>HIGHLIGHT_BYTE_LIMIT)fail('Highlights exceed the 200-mark or 256 KiB limit.');
 for(const [id,mark] of Object.entries(value)){
  assertId(id);keys(mark,['id','author','anchor','createdAt','updatedAt'],'highlight');
  if(mark.id!==id||!validTextAnchor(mark.anchor))fail('Invalid highlight identity or anchor.');author(mark.author);
  if(!Number.isFinite(Date.parse(mark.createdAt))||!Number.isFinite(Date.parse(mark.updatedAt)))fail('Invalid highlight timestamp.');
 }
}
async function currentSource(config,item,resourceRoots){
 const content=item.content;
 if(content?.kind==='markdown'&&content.resource&&!content.url)return readDocumentSource(config,content.resource,resourceRoots);
 if(typeof content?.text==='string'){
  const bytes=Buffer.from(content.text);if(bytes.length>DOCUMENT_BYTE_LIMIT)throw Error('Unavailable source');
  return {text:content.text,revision:documentRevision(bytes)};
 }
 throw Error('Unavailable source');
}
export const isHighlightOperation=operation=>['addHighlight','removeHighlight'].includes(operation?.type);
export async function applyHighlightOperation(config,operation){
 const add=operation?.type==='addHighlight';if(!isHighlightOperation(operation))fail('Unknown highlight operation.');
 keys(operation,['type','itemId','expectedRevision','operationId',...(add?['id','author','anchor']:['highlightId'])],'highlight operation');assertId(operation.itemId);
 if(add){if(operation.id!==undefined)assertId(operation.id);author(operation.author);if(!validTextAnchor(operation.anchor))fail('A highlight requires a valid text anchor.');if(operation.anchor.textModel!==undefined&&operation.anchor.textModel!=='markdown-v2')fail('Unsupported text model for a new highlight.');}
 else assertId(operation.highlightId);
 return withScopedTransaction(config,operation,async tx=>{
  const item=await tx.read('items',operation.itemId);if(item.deletedAt)throw storeError(404,'Item has been deleted.');
  const marks=structuredClone(item.review?.highlights||{});validateHighlights(marks);
  const id=add?(operation.id||`highlight-${randomUUID()}`):operation.highlightId;
  if(!add&&!Object.hasOwn(marks,id))return {itemId:item.id,highlightId:id,removed:false};
  if(add){
   if(Object.hasOwn(marks,id))throw storeError(409,'Highlight ID already exists.');
   let source;try{source=await currentSource(config,item,tx.metadata.resourceRoots);}catch{throw storeError(400,'This source is unavailable, unsupported or larger than 2 MiB.');}
   if(operation.anchor.textModel!==undefined&&operation.anchor.textModel!==source.textModel)throw storeError(409,'The source text model changed. Reload source and select again.');
   if(source.legacyText!==undefined&&operation.anchor.textModel===undefined&&(operation.anchor.start!==undefined||operation.anchor.sourceRevision!==undefined))throw storeError(409,'The source text model changed. Reload source and select again.');
   const location=locateTextAnchor(source.text,operation.anchor,source.revision,source.textModel);
   if(location.status!=='matched'||location.start===undefined)throw storeError(409,'The selected source changed or the quote is ambiguous. Reload the source and select again.');
   const anchor={...structuredClone(operation.anchor),...(source.textModel?{textModel:source.textModel}:{}),start:location.start,end:location.end,sourceRevision:source.revision,
    prefix:operation.anchor.prefix??source.text.slice(Math.max(0,location.start-96),location.start),suffix:operation.anchor.suffix??source.text.slice(location.end,location.end+96)};
   const stamp=new Date().toISOString();marks[id]={id,author:structuredClone(operation.author),anchor,createdAt:stamp,updatedAt:stamp};
  }else delete marks[id];
  validateHighlights(marks);
  item.review={...item.review,highlights:marks,updatedAt:new Date().toISOString()};item.updatedAt=new Date().toISOString();tx.write('items',item.id,item);
  return {itemId:item.id,highlightId:id,...(add?{}:{removed:true})};
 });
}
const compare=(a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);
export async function listHighlights(config,input={}){
 keys(input,['itemId','limit','cursor'],'highlight query');assertId(input.itemId);const limit=input.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('Highlight limit must be 1–100.');
 let cursor;if(input.cursor!==undefined){try{if(typeof input.cursor!=='string'||input.cursor.length>1024)throw Error();cursor=JSON.parse(Buffer.from(input.cursor,'base64url'));}catch{fail('Invalid highlight cursor.');}if(!object(cursor)||cursor.itemId!==input.itemId||!Number.isSafeInteger(cursor.revision)||typeof cursor.id!=='string'||typeof cursor.createdAt!=='string')fail('Cursor does not match this item.');}
 return withStore(config,async(root,state)=>{
  if(!state)throw storeError(404,'Workspace is not initialized.');const revision=state.metadata.revision;
  if(cursor&&cursor.revision!==revision)throw storeError(409,'Highlight cursor is stale. Restart the query.');
  const item=await readStoreDocument(root,'items',input.itemId);if(item.deletedAt)throw storeError(404,'Item has been deleted.');validateHighlights(item.review?.highlights);
  const all=Object.values(item.review?.highlights||{}).sort(compare).filter(mark=>!cursor||compare(mark,cursor)>0),selected=all.slice(0,limit),sources=new Map(),highlights=[];
  for(const mark of selected)highlights.push({...structuredClone(mark),anchorStatus:await documentAnchorStatus(config,item,mark.anchor,{resourceRoots:state.metadata.resourceRoots,documentSources:sources})});
  const last=selected.at(-1);return {revision,highlights,nextCursor:all.length>limit?Buffer.from(JSON.stringify({itemId:input.itemId,revision,id:last.id,createdAt:last.createdAt})).toString('base64url'):null};
 },{metadataOnly:true});
}
const id={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$',maxLength:128},string={type:'string'};
const actor={type:'object',additionalProperties:false,required:['id','label','kind'],properties:{id,label:{...string,minLength:1,maxLength:120},kind:{enum:['human','agent']}}};
const anchor={type:'object',additionalProperties:false,required:['kind','quote'],properties:{kind:{const:'text'},quote:{...string,minLength:1,maxLength:20000},prefix:{...string,maxLength:2000},suffix:{...string,maxLength:2000},start:{type:'integer',minimum:0,maximum:2000000},end:{type:'integer',minimum:1,maximum:2000000},sourceRevision:{...string,maxLength:256},textModel:{const:'markdown-v2'}}};
const schema=(properties,required)=>({type:'object',additionalProperties:false,properties,required}),common={expectedRevision:{type:'integer',minimum:0},operationId:id};
export const highlightToolDefinitions=[
 {name:'highlight.add',mutating:true,description:'Save a bodyless text highlight on a canonical item. Current local Markdown/inline text only; exact source facts or a unique quote/context are resolved once. Fixed yellow, max200/256KiB per item. No comment or source edit.',inputSchema:schema({...common,itemId:id,id,author:actor,anchor},['itemId','author','anchor'])},
 {name:'highlight.list',description:'Read bounded persistent highlights and current source-match status for one item; no source body. Cursor binds item and workspace revision.',inputSchema:schema({itemId:id,limit:{type:'integer',minimum:1,maximum:100},cursor:string},['itemId'])},
 {name:'highlight.remove',mutating:true,description:'Remove only the specified highlight metadata ID. Missing mark is an idempotent removed:false result; source files and discussion remain unchanged.',inputSchema:schema({...common,itemId:id,highlightId:id},['itemId','highlightId'])},
];
export function dispatchHighlightTool(config,name,input){if(name==='highlight.list')return listHighlights(config,input);const type={'highlight.add':'addHighlight','highlight.remove':'removeHighlight'}[name];if(!type)throw storeError(404,'Unknown highlight tool.');return applyHighlightOperation(config,{type,...input});}
