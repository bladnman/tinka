// Browser file intake is deliberately separate from the ordinary 1 MB JSON API.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,readFile} from 'node:fs/promises';
import path from 'node:path';
import {isInside} from './paths.mjs';
import {assertId,storeError,workspaceRoot} from './store.mjs';
import {validateRootLocations} from './resources.mjs';

export const IMPORT_LIMITS = Object.freeze({files:20,fileBytes:20*1024*1024,totalBytes:50*1024*1024,overheadBytes:128*1024});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const coordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value)<=10000000;
function checkAbort(signal){if(signal?.aborted)throw storeError(499,'File import cancelled.');}

export async function readImportRequest(req) {
  if(!/^multipart\/form-data\s*;/i.test(req.headers['content-type']||''))throw storeError(415,'File imports require multipart/form-data.');
  const limit=IMPORT_LIMITS.totalBytes+IMPORT_LIMITS.overheadBytes;
  if(Number(req.headers['content-length'])>limit)throw storeError(413,'File import exceeds the 50 MiB batch limit.');
  let total=0;const chunks=[];
  for await(const chunk of req){total+=chunk.length;if(total>limit)throw storeError(413,'File import exceeds the 50 MiB batch limit.');chunks.push(chunk);}
  let form;
  try{form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData();}
  catch{throw storeError(400,'Invalid multipart file import.');}
  if([...form.keys()].some(key=>!['metadata','files'].includes(key))||form.getAll('metadata').length!==1)
    throw storeError(400,'Provide one metadata field and files fields.');
  const source=form.get('metadata');
  if(typeof source!=='string'||Buffer.byteLength(source)>16384)throw storeError(400,'Invalid import metadata.');
  let metadata;try{metadata=JSON.parse(source);}catch{throw storeError(400,'Invalid import metadata JSON.');}
  const parts=form.getAll('files');
  if(!parts.length||parts.length>IMPORT_LIMITS.files)throw storeError(400,'Import between 1 and 20 files at a time.');
  const files=[];let bytes=0;
  for(const part of parts){
    if(typeof part==='string'||!part.size)throw storeError(400,'Every imported file must contain image or PDF bytes.');
    bytes+=part.size;
    if(part.size>IMPORT_LIMITS.fileBytes||bytes>IMPORT_LIMITS.totalBytes)throw storeError(413,'Files may be up to 20 MiB each and 50 MiB per batch.');
    files.push({name:part.name,bytes:Buffer.from(await part.arrayBuffer())});
  }
  return {metadata,files};
}

// Sniff bytes, never the claimed MIME or filename. This is format identification,
// not a full decoder; the browser retains responsibility for rendering the file.
export function sniffImport(bytes) {
  if(bytes.length>=45 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
      bytes.readUInt32BE(8)===13 && bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0 &&
      bytes.readUInt32BE(bytes.length-12)===0 && bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND')
    return {kind:'image',extension:'png',mime:'image/png'};
  if(bytes.length>=14 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)) && bytes.readUInt16LE(6)>0 && bytes.readUInt16LE(8)>0 && bytes.at(-1)===59)
    return {kind:'image',extension:'gif',mime:'image/gif'};
  if(bytes.length>=14 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217){
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==255)break;
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];
      if(marker===218||marker===217)break;
      if(marker===1||(marker>=208&&marker<=215))continue;
      if(offset+2>bytes.length)break;
      const size=bytes.readUInt16BE(offset);
      if(size<2||offset+size>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size>=8 &&
          bytes.readUInt16BE(offset+3)>0 && bytes.readUInt16BE(offset+5)>0)
        return {kind:'image',extension:'jpg',mime:'image/jpeg'};
      offset+=size;
    }
  }
  if(bytes.length>=25 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' &&
      bytes.readUInt32LE(4)+8===bytes.length && bytes.readUInt32LE(16)<=bytes.length-20){
    const tag=bytes.toString('ascii',12,16);
    if((tag==='VP8 ' && bytes.length>=30 && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) ||
        (tag==='VP8L' && bytes[20]===47) || (tag==='VP8X' && bytes.length>=30 && bytes.readUInt32LE(16)===10))
      return {kind:'image',extension:'webp',mime:'image/webp'};
  }
  if(bytes.length>=16 && /^%PDF-(?:1\.[0-7]|2\.0)[\r\n\t ]/.test(bytes.toString('ascii',0,16)) &&
      bytes.subarray(-1024).includes(Buffer.from('%%EOF')))
    return {kind:'pdf',extension:'pdf',mime:'application/pdf'};
  throw storeError(415,'Only PNG, JPEG, GIF, WebP images and PDF files can be imported.');
}
function safeName(name,index,extension) {
  const base=String(name||'').split(/[\\/]/).at(-1).replace(/\.[^.]*$/,'').normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^[-_]+|[-_]+$/g,'').slice(0,90)||`file-${index+1}`;
  return `${String(index+1).padStart(2,'0')}-${base}.${extension}`;
}
export function prepareImport(metadata,files) {
  if(!object(metadata)||Object.keys(metadata).some(key=>!['workspaceId','targetBoardId','targetPosition','expectedRevision','operationId','placements'].includes(key)))
    throw storeError(400,'Invalid import metadata.');
  assertId(metadata.workspaceId);assertId(metadata.targetBoardId);assertId(metadata.operationId);
  if(!Number.isSafeInteger(metadata.expectedRevision)||metadata.expectedRevision<0)throw storeError(400,'Import requires expectedRevision.');
  if(!object(metadata.targetPosition)||Object.keys(metadata.targetPosition).some(key=>!['x','y'].includes(key))||
      !coordinate(metadata.targetPosition.x)||!coordinate(metadata.targetPosition.y))throw storeError(400,'Import requires finite targetPosition x/y.');
  if(!Array.isArray(files)||!files.length||files.length>IMPORT_LIMITS.files)throw storeError(400,'Import between 1 and 20 files at a time.');
  let total=0;
  const prepared=files.map((file,index)=>{
    if(!Buffer.isBuffer(file.bytes)||!file.bytes.length)throw storeError(400,'Every imported file must contain image or PDF bytes.');
    total+=file.bytes.length;
    if(file.bytes.length>IMPORT_LIMITS.fileBytes||total>IMPORT_LIMITS.totalBytes)throw storeError(413,'Files may be up to 20 MiB each and 50 MiB per batch.');
    const format=sniffImport(file.bytes),name=safeName(file.name,index,format.extension);
    return {...format,name,title:String(file.name||`Pasted image ${index+1}`).split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,1000)||`Imported file ${index+1}`,
      size:file.bytes.length,sha256:hash(file.bytes),bytes:file.bytes};
  });
  let placements=metadata.placements;
  if(placements!==undefined && (!Array.isArray(placements)||placements.length!==files.length))throw storeError(400,'Import placements must match the files.');
  placements=(placements||prepared.map((file,index)=>({x:(index%4)*360,y:Math.floor(index/4)*470,width:320,height:file.kind==='pdf'?438:240}))).map(value=>{
    if(!object(value)||Object.keys(value).some(key=>!['x','y','width','height'].includes(key))||!coordinate(value.x)||!coordinate(value.y)||
        ![value.width,value.height].every(size=>typeof size==='number'&&Number.isFinite(size)&&size>=40&&size<=10000))throw storeError(400,'Invalid import placement geometry.');
    if(!coordinate(metadata.targetPosition.x+value.x)||!coordinate(metadata.targetPosition.y+value.y))throw storeError(400,'Imported placement coordinates are out of range.');
    return {...value};
  });
  // No byte buffers enter metadata, operation fingerprints or history receipts.
  const descriptors=prepared.map(({bytes,...entry})=>entry);
  return {operation:{type:'importFiles',...metadata,placements,files:descriptors},files:prepared};
}

async function directory(target,{create=false}={}) {
  if(create)try{await mkdir(target);}catch(error){if(error.code!=='EEXIST')throw error;}
  let details;
  try{details=await lstat(target);}catch(error){if(!create&&error.code==='ENOENT')return false;throw error;}
  if(details.isSymbolicLink()||!details.isDirectory())throw storeError(403,'Import directories must be real project directories.');
  return true;
}
async function existingFile(target,file) {
  let info;
  try{info=await lstat(target);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(info.isSymbolicLink()||!info.isFile()||info.size!==file.size||hash(await readFile(target))!==file.sha256)
    throw storeError(409,'Existing import bytes differ. No file was overwritten.');
  return true;
}
export async function importResources(config,state,operation,files,signal) {
  checkAbort(signal);
  const imports=path.join(config.boardsRoot,'imports');
  const registration={path:path.relative(workspaceRoot(config),imports).split(path.sep).join('/')};
  await validateRootLocations(config,{imports:registration});
  // Each component created by intake is checked separately: recursive mkdir
  // would follow an existing symlink before containment can be established.
  const boards=await realpath(config.boardsRoot);
  const importsExist=await directory(imports);
  if(importsExist&&!isInside(boards,await realpath(imports)))throw storeError(403,'Import directory leaves the project boards.');
  await validateRootLocations(config,{imports:registration});
  const rootId=Object.keys(state.metadata.resourceRoots).find(id=>state.metadata.resourceRoots[id].path===registration.path)||'imports';
  if(state.metadata.resourceRoots[rootId]&&state.metadata.resourceRoots[rootId].path!==registration.path)
    throw storeError(409,'The imports resource root is already registered to another folder.');
  state.metadata.resourceRoots[rootId]=registration;
  const batch=hash(`${operation.workspaceId}:${operation.operationId}`).slice(0,32);
  const folder=path.join(imports,batch);
  const folderExists=await directory(folder);
  if(folderExists&&!isInside(await realpath(imports),await realpath(folder)))throw storeError(403,'Import batch directory leaves the import folder.');
  // Check every existing target before any new bytes are written. Recheck on
  // exclusive-create collision as well, so retries can reuse only equal bytes.
  for(const file of files)await existingFile(path.join(folder,file.name),file);
  const resources=files.map(file=>({rootId,path:`${batch}/${file.name}`}));
  return {resources,async persist(){
    checkAbort(signal);
    await directory(imports,{create:true});
    if(!isInside(boards,await realpath(imports)))throw storeError(403,'Import directory leaves the project boards.');
    await validateRootLocations(config,{imports:registration});
    await directory(folder,{create:true});
    if(!isInside(await realpath(imports),await realpath(folder)))throw storeError(403,'Import batch directory leaves the import folder.');
    for(const file of files){
      checkAbort(signal);
      const target=path.join(folder,file.name);
      let handle;
      try{handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        await existingFile(target,file);
        continue;
      }
      try{await handle.writeFile(file.bytes);await handle.sync();}finally{await handle.close();}
    }
    checkAbort(signal);
  }};
}
