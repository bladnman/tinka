import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolveResourceFromMetadata} from './resources.mjs';
import {DOCUMENT_BYTE_LIMIT,MARKDOWN_TEXT_MODEL,parseMarkdown,locateTextAnchor} from '../public/markdown-document.js';
export const documentRevision = bytes => 'sha256:'+createHash('sha256').update(bytes).digest('hex');
export async function readDocumentSource(config,resource,resourceRoots){
  const resolved=await resolveResourceFromMetadata(config,resource,resourceRoots);
  const handle=await open(resolved.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await handle.stat();if(!before.isFile()||before.size>DOCUMENT_BYTE_LIMIT)throw Error('Unavailable source');
    // Fixed-size read prevents growth during the read from defeating the byte limit.
    const bytes=Buffer.alloc(DOCUMENT_BYTE_LIMIT+1);let length=0;
    while(length<bytes.length){const result=await handle.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
    const after=await handle.stat();if(length>DOCUMENT_BYTE_LIMIT||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Source changed while reading');
    const raw=bytes.subarray(0,length),markdown=new TextDecoder().decode(raw),model=parseMarkdown(markdown),legacyText=model.hasTables?parseMarkdown(markdown,{tables:false}).text:model.text;
    return {text:model.text,revision:documentRevision(raw),textModel:MARKDOWN_TEXT_MODEL,...(legacyText!==model.text?{legacyText}:{})};
  }finally{await handle.close();}
}
// Re-anchoring after a source edit: a text anchor follows its passage only when its exact quote
// can be placed without guessing.
//  1. The quote occurs exactly once in the new text: it moves there, whatever its context.
//  2. It occurs more than once: an occurrence whose saved prefix and suffix both match exactly
//     wins if it is the only one; otherwise the occurrence with the most matching context
//     characters (prefix matched backwards plus suffix matched forwards) wins if it is strictly
//     ahead of every other occurrence and matches at least one character.
//  3. Anything else (quote edited or missing, a tie, a legacy text model) stays for review.
// The moved anchor takes the new offsets, sourceRevision and the 96-character context around
// its new place; the quote is unchanged.
export const REANCHOR_HISTORY_LIMIT=20,ANCHOR_CONTEXT=96;
function commonSuffix(a,b){let n=0;while(n<a.length&&n<b.length&&a[a.length-1-n]===b[b.length-1-n])n++;return n;}
function commonPrefix(a,b){let n=0;while(n<a.length&&n<b.length&&a[n]===b[n])n++;return n;}
export function relocateAnchor(anchor,source){
  if(anchor?.kind!=='text'||!source||!anchor.quote||anchor.textModel===undefined||anchor.textModel!==source.textModel)return null;
  if(anchor.sourceRevision===undefined||anchor.sourceRevision===source.revision)return null;
  const text=source.text,quote=anchor.quote,found=[];
  for(let at=text.indexOf(quote);at!==-1&&found.length<=1000;at=text.indexOf(quote,at+1))found.push(at);
  let start;
  if(found.length===1)start=found[0];
  else if(found.length>1){
    const prefix=anchor.prefix??'',suffix=anchor.suffix??'';
    const scored=found.map(at=>{const before=text.slice(Math.max(0,at-prefix.length),at),after=text.slice(at+quote.length,at+quote.length+suffix.length),p=commonSuffix(before,prefix),q=commonPrefix(after,suffix);return {at,exact:p===prefix.length&&q===suffix.length,score:p+q};});
    const exact=scored.filter(entry=>entry.exact);
    if(exact.length===1)start=exact[0].at;
    else if(!exact.length){const ranked=scored.sort((a,b)=>b.score-a.score);if(ranked[0].score>0&&ranked[0].score>ranked[1].score)start=ranked[0].at;}
  }
  if(start===undefined)return null;
  const end=start+quote.length;
  return {...structuredClone(anchor),start,end,sourceRevision:source.revision,prefix:text.slice(Math.max(0,start-ANCHOR_CONTEXT),start),suffix:text.slice(end,end+ANCHOR_CONTEXT)};
}
// The visible history of a record's re-anchors: each entry names the revisions it moved between.
export function reanchorEntry(from,to,at=new Date().toISOString()){return {from:from.sourceRevision,to:to.sourceRevision,start:to.start,end:to.end,at};}
export function appendReanchor(history,entry){return [...(Array.isArray(history)?history:[]),entry].slice(-REANCHOR_HISTORY_LIMIT);}
export function validReanchorHistory(value){
  if(value===undefined)return true;
  if(!Array.isArray(value)||!value.length||value.length>REANCHOR_HISTORY_LIMIT)return false;
  return value.every(entry=>entry&&typeof entry==='object'&&!Array.isArray(entry)&&Object.keys(entry).every(key=>['from','to','start','end','at'].includes(key))&&
    ['from','to'].every(key=>typeof entry[key]==='string'&&/^sha256:[a-f0-9]{64}$/.test(entry[key]))&&Number.isSafeInteger(entry.start)&&Number.isSafeInteger(entry.end)&&entry.start>=0&&entry.end>entry.start&&
    typeof entry.at==='string'&&Number.isFinite(Date.parse(entry.at)));
}
const localDocument=item=>item?.content?.kind==='markdown'&&!!item.content.resource&&!item.content.url;
export const isLocalDocument=localDocument;
// Status plus, for an anchor that relocates under the rule above, the computed currentAnchor.
// Reads never write: the stored anchor moves only on a save or document.reanchor.
export async function documentAnchorState(config,item,anchor,{resourceRoots,documentSources=new Map()}={}){
  if(!localDocument(item)){
    if(typeof item.content?.text==='string')return {status:locateTextAnchor(item.content.text,anchor,documentRevision(Buffer.from(item.content.text))).status};
    return {status:'unverified'};
  }
  const resource=item.content.resource,key=JSON.stringify(resource);
  if(!documentSources.has(key))documentSources.set(key,readDocumentSource(config,resource,resourceRoots).catch(()=>null));
  const source=await documentSources.get(key);if(!source)return {status:'unverified'};
  if(anchor.textModel===undefined&&source.legacyText!==undefined){const legacy=locateTextAnchor(source.legacyText,anchor,source.revision).status;return {status:legacy==='stale'?'stale':'uncertain'};}
  const status=locateTextAnchor(source.text,anchor,source.revision,source.textModel).status;
  const currentAnchor=status!=='matched'?relocateAnchor(anchor,source):null;
  return currentAnchor?{status:'matched',currentAnchor}:{status};
}
export async function documentAnchorStatus(config,item,anchor,options){return (await documentAnchorState(config,item,anchor,options)).status;}
