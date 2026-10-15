import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,readdir,realpath,rename,rm,rmdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {assertSlug,boardDirectory,existingInside,HttpError,isInside,safeRelative} from './paths.mjs';
import {getShellRevision} from './revisions.mjs';

export const validStates=new Set(['reserved','building','review','ready']);
const keyPattern=/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const fallback={state:'reserved',message:'Status has not been recorded yet.',updatedAt:0};
export const digest=(...parts)=>{const hash=createHash('sha256');for(const part of parts){hash.update(part);hash.update('\0');}return hash.digest('hex');};

export async function readBoardJson(boardRoot,relative,{optional=false}={}){
  try{return JSON.parse(await readFile((await existingInside(boardRoot,relative)).path,'utf8'));}
  catch(error){if(optional&&error.status===404)return null;throw error;}
}

function validBoard(metadata){
  if(!metadata||metadata.schemaVersion!==1||typeof metadata.title!=='string'||!metadata.title.trim()||typeof metadata.description!=='string'||typeof metadata.createdAt!=='string')throw new Error('Invalid board metadata.');
  if(metadata.cover!==undefined)safeRelative(metadata.cover);
  return metadata;
}
function validManifest(manifest){
  if(!manifest||!Array.isArray(manifest.rounds)||typeof manifest.revisions!=='object'||manifest.revisions===null)throw new Error('Invalid rounds manifest.');
  for(const round of manifest.rounds){
    assertSlug(round.id);
    if(!Array.isArray(round.concepts))throw new Error('Invalid concepts.');
    for(const concept of round.concepts){
      assertSlug(concept.id);
      if(concept.path!==undefined)safeRelative(concept.path);
      if(concept.handoff!==undefined)safeRelative(concept.handoff);
      if(concept.dependencies!==undefined){if(!Array.isArray(concept.dependencies))throw new Error('Invalid dependencies.');for(const dependency of concept.dependencies)safeRelative(dependency);}
      if(concept.url!==undefined&&!/^https?:\/\/[^\s]+$/i.test(concept.url))throw new Error('Invalid concept URL.');
    }
  }
  for(const variants of Object.values(manifest.revisions)){
    if(!Array.isArray(variants))throw new Error('Invalid revisions.');
    for(const variant of variants){
      if(variant.path!==undefined)safeRelative(variant.path);
      if(variant.dependencies!==undefined){if(!Array.isArray(variant.dependencies))throw new Error('Invalid dependencies.');for(const dependency of variant.dependencies)safeRelative(dependency);}
    }
  }
  return manifest;
}
export function conceptKeys(manifest){
  const keys=new Set(manifest.rounds.flatMap(round=>round.concepts.map(concept=>`${round.id}/${concept.id}`)));
  for(const variants of Object.values(manifest.revisions||{}))for(const variant of variants){
    const match=/^rounds\/([a-z0-9-]+)\/([a-z0-9-]+)\//.exec(variant.path||'');
    if(match)keys.add(`${match[1]}/${match[2]}`);
  }
  return [...keys].sort();
}
export function conceptSourcePaths(manifest){
  const paths=new Map();
  const add=(key,source)=>{if(!paths.has(key))paths.set(key,new Set());paths.get(key).add(source);};
  const addEntry=(key,entry,defaultPath)=>{
    const source=entry.path||defaultPath;
    if(source){const clean=safeRelative(source);add(key,path.posix.dirname(clean));add(key,clean);}
    for(const dependency of entry.dependencies||[])add(key,safeRelative(dependency));
  };
  for(const round of manifest.rounds)for(const concept of round.concepts){
    const key=`${round.id}/${concept.id}`;
    add(key,`rounds/${key}`);
    addEntry(key,concept,`rounds/${key}/index.html`);
  }
  for(const [parent,variants] of Object.entries(manifest.revisions||{}))for(const variant of variants){
    const match=/^rounds\/([a-z0-9-]+)\/([a-z0-9-]+)\//.exec(variant.path||'');
    if(match){const key=`${match[1]}/${match[2]}`;add(key,`rounds/${key}`);addEntry(key,variant);}
    else if(keyPattern.test(parent))addEntry(parent,variant);
  }
  return paths;
}
export async function loadBoard(config,id){
  const root=await boardDirectory(config.boardsRoot,id);
  const [metadata,manifest,build]=await Promise.all([
    readBoardJson(root,'board.json').then(validBoard),
    readBoardJson(root,'rounds.json').then(validManifest),
    readBoardJson(root,'build-state.json',{optional:true})
  ]);
  if(build&&(!build.concepts||typeof build.concepts!=='object'||Array.isArray(build.concepts)))throw new Error('Invalid build state.');
  return {id,root,metadata,manifest,build:build||{concepts:{}}};
}
async function latestSourceMtime(root,relative,visited=new Set()){
  let actual;
  try{actual=await realpath(path.join(root,relative));}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return 0;throw error;}
  if(!isInside(root,actual))return 0;
  const details=await stat(actual);
  if(details.isFile())return details.mtimeMs;
  if(!details.isDirectory()||visited.has(actual))return 0;
  visited.add(actual);
  let newest=0;
  for(const entry of await readdir(actual,{withFileTypes:true})){
    if(entry.name.startsWith('.'))continue;
    newest=Math.max(newest,await latestSourceMtime(root,path.join(relative,entry.name),visited));
  }
  visited.delete(actual);
  return newest;
}
export async function discoverBoards(config){
  const entries=await readdir(config.boardsRoot,{withFileTypes:true});
  const boards=[];const errors=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)||(!entry.isDirectory()&&!entry.isSymbolicLink()))continue;
    try{
      const board=await loadBoard(config,entry.name);
      const baseKeys=new Set(board.manifest.rounds.flatMap(round=>round.concepts.map(concept=>`${round.id}/${concept.id}`)));
      const known=new Set(conceptKeys(board.manifest));
      const state=board.build.concepts;
      const details=await Promise.all(['board.json','rounds.json','build-state.json'].map(async file=>{try{return (await existingInside(board.root,file)).stat.mtimeMs;}catch(error){if(error.status===404)return 0;throw error;}}));
      const sources=new Set(['rounds','shared','assets',...(board.metadata.cover?[board.metadata.cover]:[]),...Array.from(conceptSourcePaths(board.manifest).values()).flatMap(set=>[...set])]);
      details.push(...await Promise.all([...sources].map(name=>latestSourceMtime(board.root,name))));
      const revisionCount=Object.values(board.manifest.revisions).reduce((count,variants)=>count+variants.length,0);
      boards.push({id:board.id,title:board.metadata.title,description:board.metadata.description,createdAt:board.metadata.createdAt,updatedAt:Math.max(...details),conceptCount:baseKeys.size,revisionCount,roundCount:board.manifest.rounds.length,buildingCount:[...known].filter(key=>state[key]?.state==='building').length,...(board.metadata.cover?{cover:board.metadata.cover}:{})});
    }catch(error){if(error.status!==404)errors.push({id:entry.name,message:'Board metadata could not be read.'});}
  }
  const shellRevision=await getShellRevision();
  return {boards,errors,shellRevision,revision:digest(JSON.stringify(boards),JSON.stringify(errors),shellRevision)};
}
export function boardResponse(board){return {id:board.id,...board.metadata,rounds:board.manifest.rounds,revisions:board.manifest.revisions};}

export function cleanMessage(message){
  if(typeof message!=='string'||!message.trim()||message.length>240||message.includes('/')||message.includes('\\'))throw new HttpError(400,'Message must be 1–240 characters and contain no path.');
  return message.replace(/\s+/g,' ').trim();
}
export function cleanNotes(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'Expected notes object.');
  const clean={};
  for(const [key,value] of Object.entries(input)){
    if(!keyPattern.test(key)||!value||typeof value!=='object'||Array.isArray(value))continue;
    clean[key]={note:String(value.note||'').slice(0,20000),star:!!value.star,updatedAt:Number.isFinite(Number(value.updatedAt))?Number(value.updatedAt):0};
  }
  return clean;
}
async function stateDirectory(boardRoot){
  const statePath=path.join(boardRoot,'.state');
  await mkdir(statePath,{recursive:true});
  const actual=await realpath(statePath);
  if(!isInside(boardRoot,actual))throw new HttpError(403,'State directory leaves board.');
  return actual;
}
export async function readNotes(boardRoot){
  const statePath=await stateDirectory(boardRoot);
  try{
    const actual=await realpath(path.join(statePath,'notes.json'));
    if(!isInside(boardRoot,actual))throw new HttpError(403,'Notes file leaves board.');
    return cleanNotes(JSON.parse(await readFile(actual,'utf8')));
  }catch(error){if(error.code==='ENOENT')return {};throw error;}
}
async function withLock(lockPath,action){
  const deadline=Date.now()+5000;
  for(;;){
    try{await mkdir(lockPath);break;}
    catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()>=deadline)throw new HttpError(409,'Board is busy.');await delay(40);}
  }
  try{return await action();}finally{await rmdir(lockPath);}
}
async function atomicJson(target,data){
  const temporary=`${target}.${process.pid}.${randomUUID()}.tmp`;
  try{const file=await open(temporary,'wx');try{await file.writeFile(`${JSON.stringify(data,null,2)}\n`);await file.sync();}finally{await file.close();}await rename(temporary,target);}finally{await rm(temporary,{force:true});}
}
export async function writeNotes(boardRoot,notes){
  const clean=cleanNotes(notes);const statePath=await stateDirectory(boardRoot);
  return withLock(path.join(statePath,'.notes.lock'),async()=>{
    const target=path.join(statePath,'notes.json');
    try{const actual=await realpath(target);if(!isInside(boardRoot,actual))throw new HttpError(403,'Notes file leaves board.');}catch(error){if(error.code!=='ENOENT')throw error;}
    await atomicJson(target,clean);return clean;
  });
}
export async function updateBuildState(config,id,key,state,message){
  if(!keyPattern.test(key))throw new HttpError(400,'Invalid concept key.');
  if(!validStates.has(state))throw new HttpError(400,'Invalid state.');
  const clean=cleanMessage(message);const board=await loadBoard(config,id);
  if(!conceptKeys(board.manifest).includes(key))throw new HttpError(400,'Unknown concept key.');
  return withLock(path.join(board.root,'.build-state.lock'),async()=>{
    const current=(await readBoardJson(board.root,'build-state.json',{optional:true}))||{concepts:{}};
    if(!current.concepts||typeof current.concepts!=='object'||Array.isArray(current.concepts))throw new Error('Invalid build state.');
    const next={...current,concepts:{...current.concepts,[key]:{state,message:clean,updatedAt:Date.now()}}};
    await atomicJson(path.join(board.root,'build-state.json'),next);
    return next.concepts[key];
  });
}
export function publicState(raw){
  if(!raw||!validStates.has(raw.state)||typeof raw.message!=='string'||!Number.isFinite(raw.updatedAt))return fallback;
  return {state:raw.state,message:raw.message.replace(/\s+/g,' ').trim().slice(0,240),updatedAt:raw.updatedAt};
}
