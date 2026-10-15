import {createHash} from 'node:crypto';
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isInside} from './paths.mjs';

const publicRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','public');
function digest(...parts){const hash=createHash('sha256');for(const part of parts){hash.update(part);hash.update('\0');}return hash.digest('hex');}
export async function treeRevision(root,relative='',visited=new Set()){
  const target=path.join(root,relative);
  let actual;
  try{actual=await realpath(target);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return digest(relative,'missing');throw error;}
  if(!isInside(root,actual))return digest(relative,'outside-root');
  const details=await stat(actual);
  if(details.isFile()){
    const hash=createHash('sha256');
    hash.update(relative);hash.update('\0');hash.update(String(details.size));hash.update('\0');hash.update(String(details.mtimeMs));
    if(details.size<=2_000_000)hash.update(await readFile(actual));
    return hash.digest('hex');
  }
  if(!details.isDirectory()||visited.has(actual))return digest(relative,'cycle-or-unsupported');
  visited.add(actual);
  const entries=(await readdir(actual,{withFileTypes:true})).filter(entry=>{
    if(entry.name.startsWith('.'))return false;
    if(relative===''||relative==='.')return !['board.json','rounds.json','build-state.json'].includes(entry.name);
    return true;
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const revisions=[];
  for(const entry of entries){const child=path.posix.join(relative,entry.name);revisions.push(child,await treeRevision(root,child,visited));}
  visited.delete(actual);
  return digest(relative,...revisions);
}
let shellCache=null;let shellExpires=0;let shellPending=null;
export async function getShellRevision({cacheMs=750}={}){
  if(shellCache&&Date.now()<shellExpires)return shellCache;
  if(shellPending)return shellPending;
  shellPending=treeRevision(publicRoot).then(value=>{shellCache=value;shellExpires=Date.now()+cacheMs;return value;}).finally(()=>{shellPending=null;});
  return shellPending;
}
