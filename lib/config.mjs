import {readFile,realpath,stat,rename,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {assertSlug,HttpError,isInside} from './paths.mjs';
import {fileURLToPath} from 'node:url';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const VERSION=JSON.parse(await readFile(path.join(appRoot,'package.json'),'utf8')).version;
export const DEFAULT_PORT=43821;
export const PORT_STEP=100;
export const PORT_ATTEMPTS=20;

export async function loadConfig(input){
  if(!input)throw new Error('Provide --config PATH.');
  const configPath=await realpath(path.resolve(input));
  const config=JSON.parse(await readFile(configPath,'utf8'));
  if(!config||config.schemaVersion!==1||!Number.isInteger(config.port)||config.port<1||config.port>65535||typeof config.boardsRoot!=='string'||!path.isAbsolute(config.boardsRoot))throw new Error('Invalid Tinka config.');
  if(config.portMode!==undefined&&!['auto','fixed'].includes(config.portMode))throw new Error('portMode must be auto or fixed.');
  if(config.projectLabel!==undefined&&(typeof config.projectLabel!=='string'||!config.projectLabel.trim()))throw new Error('projectLabel must be a nonempty string.');
  const boardsRoot=await realpath(config.boardsRoot);
  if(isInside(appRoot,configPath)||isInside(appRoot,boardsRoot)||isInside(boardsRoot,appRoot))throw new Error('Config and boards must live outside the application folder.');
  const details=await stat(boardsRoot);
  if(!details.isDirectory())throw new Error('boardsRoot must be a directory.');
  if(config.legacyBoard!==undefined)assertSlug(config.legacyBoard);
  const projectLabel=config.projectLabel?.trim()||path.basename(path.dirname(configPath));
  const workspaceId=createHash('sha256').update(`${configPath}\0${boardsRoot}`).digest('hex').slice(0,24);
  return {schemaVersion:1,port:config.port,portMode:config.portMode||'fixed',title:config.title||'Tinka',projectLabel,workspaceId,boardsRoot,configPath,version:VERSION,...(config.legacyBoard?{legacyBoard:config.legacyBoard}:{})};
}

export function publicConfig(config){
  return {...config,appPath:appRoot,agentGuidePath:path.join(appRoot,'docs/AGENT.md'),protocolPath:path.join(appRoot,'docs/PROTOCOL.md'),url:`http://127.0.0.1:${config.port}/`};
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
