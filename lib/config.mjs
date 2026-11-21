import {readFile,realpath,stat,rename,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID,randomInt} from 'node:crypto';
import path from 'node:path';
import {assertSlug,HttpError,isInside} from './paths.mjs';
import {fileURLToPath} from 'node:url';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const VERSION=JSON.parse(await readFile(path.join(appRoot,'package.json'),'utf8')).version;
export const PORT_MIN=45000;
export const PORT_MAX=45999;
export const PORT_ATTEMPTS=20;
export const randomPort=()=>randomInt(PORT_MIN,PORT_MAX+1);
// Keep an existing project's remembered port (including older ranges) first.
// Draw remaining candidates without replacement; the socket bind is the check.
export function portCandidates(preferred){
  const pool=Array.from({length:PORT_MAX-PORT_MIN+1},(_,i)=>PORT_MIN+i).filter(port=>port!==preferred);
  const ports=[preferred];
  while(ports.length<PORT_ATTEMPTS&&pool.length){const index=randomInt(pool.length);ports.push(pool[index]);pool[index]=pool.at(-1);pool.pop();}
  return ports;
}

async function canonicalFuturePath(input){
  const absolute=path.resolve(input);
  try{return await realpath(absolute);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(absolute);if(parent===absolute)throw error;return path.join(await canonicalFuturePath(parent),path.basename(absolute));}
}

// The portable manifest locates the project even when the app is served from a
// source checkout. A display label is mutable and is not a filesystem identity.
async function portableProjectRoot(configPath,boardsRoot){
  const local=path.dirname(configPath),tooling=path.dirname(local);
  if(path.basename(configPath)!=='config.json'||path.basename(local)!=='local'||path.basename(tooling)!=='tinka')return null;
  try{
    const project=JSON.parse(await readFile(path.join(tooling,'project.json'),'utf8'));
    const root=path.dirname(tooling);
    if(project?.schemaVersion!==1||typeof project.boards!=='string'||!project.boards||path.isAbsolute(project.boards))return null;
    const boards=await realpath(path.resolve(root,project.boards));
    return boards===boardsRoot&&isInside(root,boards)?root:null;
  }catch{return null;}
}

export async function loadConfig(input){
  if(!input)throw new Error('Provide --config PATH.');
  const configPath=await realpath(path.resolve(input));
  const config=JSON.parse(await readFile(configPath,'utf8'));
  if(!config||config.schemaVersion!==1||!Number.isInteger(config.port)||config.port<1||config.port>65535||typeof config.boardsRoot!=='string'||!path.isAbsolute(config.boardsRoot))throw new Error('Invalid Tinka config.');
  if(config.portMode!==undefined&&!['auto','fixed'].includes(config.portMode))throw new Error('portMode must be auto or fixed.');
  if(config.projectLabel!==undefined&&(typeof config.projectLabel!=='string'||!config.projectLabel.trim()))throw new Error('projectLabel must be a nonempty string.');
  const boardsRoot=await realpath(config.boardsRoot);
  if(config.workspaceRoot!==undefined&&(typeof config.workspaceRoot!=='string'||!path.isAbsolute(config.workspaceRoot)))throw new Error('workspaceRoot must be an absolute path.');
  const workspaceRoot=await canonicalFuturePath(config.workspaceRoot||path.join(boardsRoot,'.tinka'));
  if(isInside(appRoot,workspaceRoot)||isInside(workspaceRoot,appRoot))throw new Error('Workspace metadata must live outside the application folder.');
  if(isInside(appRoot,configPath)||isInside(appRoot,boardsRoot)||isInside(boardsRoot,appRoot))throw new Error('Config and boards must live outside the application folder.');
  const details=await stat(boardsRoot);
  if(!details.isDirectory())throw new Error('boardsRoot must be a directory.');
  if(config.legacyBoard!==undefined)assertSlug(config.legacyBoard);
  const projectLabel=config.projectLabel?.trim()||path.basename(path.dirname(configPath));
  const defaultWorkspaceRoot=await canonicalFuturePath(path.join(boardsRoot,'.tinka'));
  // Preserve default-layout browser namespaces. A genuinely custom metadata
  // location is a separate write target and must invalidate old clients.
  const identity=`${configPath}\0${boardsRoot}${workspaceRoot===defaultWorkspaceRoot?'':`\0${workspaceRoot}`}`;
  const workspaceId=createHash('sha256').update(identity).digest('hex').slice(0,24);
  const projectRoot=await portableProjectRoot(configPath,boardsRoot);
  return {schemaVersion:1,port:config.port,portMode:config.portMode||'fixed',title:config.title||'Tinka',projectLabel,projectRoot,workspaceId,boardsRoot,workspaceRoot,configPath,version:VERSION,...(config.legacyBoard?{legacyBoard:config.legacyBoard}:{})};
}

export function publicConfig(config){
  return {...config,appPath:appRoot,agentGuidePath:path.join(appRoot,'docs/AGENT.md'),protocolPath:path.join(appRoot,'docs/PROTOCOL.md'),url:`http://127.0.0.1:${config.port}/`};
}

// Bound the check at the result boundary. A saved port alone is never evidence
// that the project behind a clickable address is still this one.
export async function verifiedURL(config){
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535||!['configPath','boardsRoot','workspaceId','version','projectLabel'].every(key=>typeof config[key]==='string'&&config[key].length)||!path.isAbsolute(config.configPath))return null;
  const url=`http://127.0.0.1:${config.port}/`;
  try{
    const reply=await fetch(`${url}api/health`,{signal:AbortSignal.timeout(1000),redirect:'error'});
    if(!reply.ok)return null;
    const health=await reply.json();
    return health.app==='board-room'&&health.url===url&&['configPath','boardsRoot','workspaceId','version','port','projectLabel'].every(key=>health[key]===config[key])?url:null;
  }catch{return null;}
}
export function linkRecovery(config){
  if(typeof config.configPath!=='string'||!path.isAbsolute(config.configPath))return {linkWarning:'This workspace has no verified server/config identity. Start Tinka with its explicit config, then resolve linkPath against the actual URL it prints; old links may belong to another project.'};
  const shell=value=>`'${value.replace(/'/g,"'\\''")}'`;
  return {startCommand:`node ${shell(path.join(appRoot,'cli.mjs'))} start --config ${shell(config.configPath)}`,linkWarning:'This project\'s server could not be verified at its remembered port. Run startCommand, then append linkPath to the actual URL it prints. Share that verified URL; old links may belong to another project.'};
}

// Called only after the actual socket bind, while this config's runtime is claimed.
export async function savePort(config,port){
  if(config.port===port)return;
  const source=JSON.parse(await readFile(config.configPath,'utf8'));
  const temporary=`${config.configPath}.${randomUUID()}.tmp`;
  try{
    await writeFile(temporary,`${JSON.stringify({...source,port},null,2)}\n`,{flag:'wx'});
    await rename(temporary,config.configPath);
    config.port=port;
  }finally{await rm(temporary,{force:true});}
}

export function validatePort(raw){
  const port=Number(raw);
  if(!Number.isInteger(port)||port<1||port>65535)throw new HttpError(400,'Port must be between 1 and 65535.');
  return port;
}
