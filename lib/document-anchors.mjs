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
export async function documentAnchorStatus(config,item,anchor,{resourceRoots,documentSources=new Map()}={}){
  if(item.content?.kind!=='markdown'||!item.content.resource||item.content.url){
    if(typeof item.content?.text==='string')return locateTextAnchor(item.content.text,anchor,documentRevision(Buffer.from(item.content.text))).status;
    return 'unverified';
  }
  const resource=item.content.resource,key=JSON.stringify(resource);
  if(!documentSources.has(key))documentSources.set(key,readDocumentSource(config,resource,resourceRoots).catch(()=>null));
  const source=await documentSources.get(key);if(!source)return 'unverified';
  if(anchor.textModel===undefined&&source.legacyText!==undefined){const legacy=locateTextAnchor(source.legacyText,anchor,source.revision).status;return legacy==='stale'?'stale':'uncertain';}
  return locateTextAnchor(source.text,anchor,source.revision,source.textModel).status;
}
