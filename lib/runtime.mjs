import {randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {mkdir,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execFileAsync=promisify(execFile);
const cliPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','cli.mjs');
export function runtimePaths(config){return {pid:`${config.configPath}.pid.json`,log:`${config.configPath}.log`};}
async function processCommand(pid){try{return (await execFileAsync('ps',['-p',String(pid),'-o','command='])).stdout.trim();}catch{return '';}}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
export async function ownedProcess(record,config){
  if(!record||!Number.isSafeInteger(record.pid)||record.pid<1||record.configPath!==config.configPath||typeof record.token!=='string'||!/^[0-9a-f-]{36}$/.test(record.token))return false;
  if(!alive(record.pid))return false;
  const command=await processCommand(record.pid);
  return command.includes(cliPath)&&command.includes(config.configPath)&&command.includes(record.token)&&command.includes('serve');
}
export async function readRuntime(config){
  try{return JSON.parse(await readFile(runtimePaths(config).pid,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function runtimeRecord(config,token,state){return {pid:process.pid,configPath:config.configPath,appPath:path.dirname(cliPath),token,state,port:config.port,url:`http://127.0.0.1:${config.port}/`,version:config.version,startedAt:Date.now()};}
async function createClaim(config,token){
  const file=await open(runtimePaths(config).pid,'wx');
  try{await file.writeFile(`${JSON.stringify(runtimeRecord(config,token,'starting'),null,2)}\n`);await file.sync();}finally{await file.close();}
}
// The claim precedes binding and saving a chosen port, so concurrent starts of
// one config cannot launch a second instance or change the first one's URL.
export async function claimRuntime(config,token){
  try{await createClaim(config,token);return;}catch(error){if(error.code!=='EEXIST')throw error;}
  const recovery=`${runtimePaths(config).pid}.recovery`;
  try{await mkdir(recovery);}catch(error){if(error.code==='EEXIST')throw new Error(`This config is already starting or recovering. Retry shortly; stale recovery directory: ${recovery}`);throw error;}
  try{
    const prior=await readRuntime(config);
    if(prior&&alive(prior.pid))throw new Error(`This config is already running or starting (PID ${prior.pid}). No process was changed.`);
    if(prior)await rm(runtimePaths(config).pid);
    await createClaim(config,token);
  }finally{await rm(recovery,{recursive:true,force:true});}
}
export async function writeRuntime(config,token){
  const prior=await readRuntime(config);
  if(prior?.pid!==process.pid||prior.token!==token)throw new Error('Runtime claim was lost.');
  const record={...runtimeRecord(config,token,'ready'),startedAt:prior.startedAt};
  const temporary=`${runtimePaths(config).pid}.${token}.tmp`;
  try{await writeFile(temporary,`${JSON.stringify(record,null,2)}\n`,{flag:'wx'});await rename(temporary,runtimePaths(config).pid);}
  finally{await rm(temporary,{force:true});}
  return record;
}
export async function removeRuntime(config,token){
  const record=await readRuntime(config);
  if(record?.pid===process.pid&&record.token===token)await rm(runtimePaths(config).pid,{force:true});
}
export async function startManaged(config){
  const paths=runtimePaths(config);
  const prior=await readRuntime(config);
  if(prior&&alive(prior.pid))throw new Error(`This config is already running or starting (PID ${prior.pid}). No process was changed.`);
  const token=randomUUID();
  const logfile=await open(paths.log,'a');
  const logStart=(await logfile.stat()).size;
  const child=spawn(process.execPath,[cliPath,'serve','--config',config.configPath,'--managed-token',token],{detached:true,stdio:['ignore',logfile.fd,logfile.fd]});
  let launchError;child.on('error',error=>{launchError=error;});
  child.unref();await logfile.close();
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    // An exclusive newly-created record may still be receiving its first bytes.
    const record=await readRuntime(config).catch(error=>{if(error instanceof SyntaxError)return null;throw error;});
    if(record?.pid===child.pid&&record.token===token&&record.state==='ready'&&await ownedProcess(record,config))return record;
    if(launchError||!alive(child.pid))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  if(alive(child.pid))child.kill('SIGTERM');
  const detail=(await readFile(paths.log)).subarray(logStart).toString('utf8').trim();
  throw new Error(`Tinka did not start. ${launchError?.message||detail||`Check ${paths.log}.`}`);
}
export async function stopManaged(config){
  const record=await readRuntime(config);
  if(!record)throw new Error('Tinka has no managed PID file.');
  if(!await ownedProcess(record,config))throw new Error('PID ownership could not be validated; refusing to stop it.');
  process.kill(record.pid,'SIGTERM');
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&alive(record.pid))await new Promise(resolve=>setTimeout(resolve,50));
  if(alive(record.pid))throw new Error('Tinka did not stop within 5 seconds.');
  // Never delete a successor's claim if a new start raced with shutdown.
  const current=await readRuntime(config);
  if(current?.token===record.token)await rm(runtimePaths(config).pid,{force:true});
  return record.pid;
}
