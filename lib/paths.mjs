import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status,message){super(message);this.status=status;}
}

export function isInside(root,candidate){
  const relative=path.relative(root,candidate);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`));
}

export function assertSlug(slug){
  if(typeof slug!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(slug))throw new HttpError(400,'Invalid board ID.');
  return slug;
}

export function safeRelative(input,{allowEmpty=false}={}){
  if(typeof input!=='string'||input.includes('\\')||input.includes('\0'))throw new HttpError(400,'Unsafe path.');
  let decoded;
  try{decoded=decodeURIComponent(input);}catch{throw new HttpError(400,'Unsafe path.');}
  if(decoded.includes('\\')||decoded.includes('\0')||decoded.startsWith('/')||path.isAbsolute(decoded))throw new HttpError(400,'Unsafe path.');
  const segments=decoded.split('/');
  if(segments.some((segment,index)=>!segment&&index!==segments.length-1))throw new HttpError(403,'Unsafe path.');
  if(segments.at(-1)==='')segments.pop();
  if((!allowEmpty&&segments.length===0)||segments.some(segment=>segment==='.'||segment==='..'||segment.startsWith('.')))throw new HttpError(403,'Unsafe path.');
  return segments.join('/');
}

export async function existingInside(root,relative,{type='file'}={}){
  const clean=safeRelative(relative);
  const lexical=path.resolve(root,clean);
  if(!isInside(root,lexical))throw new HttpError(403,'Unsafe path.');
  let actual;
  try{actual=await realpath(lexical);}
  catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')throw new HttpError(404,'File not found.');throw error;}
  if(!isInside(root,actual))throw new HttpError(403,'Symlink leaves the board.');
  const details=await stat(actual);
  if(type==='file'&&!details.isFile())throw new HttpError(404,'File not found.');
  if(type==='directory'&&!details.isDirectory())throw new HttpError(404,'Directory not found.');
  return {path:actual,stat:details};
}

export async function boardDirectory(boardsRoot,id){
  const slug=assertSlug(id);
  const lexical=path.join(boardsRoot,slug);
  let actual;
  try{actual=await realpath(lexical);}
  catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')throw new HttpError(404,'Board not found.');throw error;}
  if(!isInside(boardsRoot,actual))throw new HttpError(403,'Board symlink leaves the boards root.');
  const details=await stat(actual);
  if(!details.isDirectory())throw new HttpError(404,'Board not found.');
  return actual;
}
