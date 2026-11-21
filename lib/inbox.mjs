// Agent inbox: comments that need an agent, read straight from the thread files with no
// workspace lock and no metadata writes, so a per-turn agent hook stays fast. The CLI keeps
// each actor's last-seen position in a local state file beside the config (.inbox-state.json).
import {readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {verifiedURL,linkRecovery} from './config.mjs';

const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const statusOf=thread=>thread.status??(thread.resolved?'resolved':'open');
const live=thread=>[{author:thread.author,body:thread.body,deletedAt:thread.deletedAt},...(thread.replies||[])].filter(message=>!message.deletedAt);
const token=(r,id)=>Buffer.from(JSON.stringify({r,id})).toString('base64url');
function readToken(value){
  if(value===undefined||value===null||value==='')return {r:-1,id:''};
  try{const parsed=JSON.parse(Buffer.from(String(value),'base64url'));if(!Number.isSafeInteger(parsed.r)||typeof parsed.id!=='string')throw Error();return parsed;}
  catch{const error=new Error('Invalid since token.');error.status=400;throw error;}
}
const after=(revision,id,since)=>revision>since.r||revision===since.r&&id>since.id;
// Why a thread needs the agent, or null: handed to it (sent), addressed to it and still open,
// or a person replied after the agent's last message. Threads for another named agent, threads
// between people, resolved, working and deleted threads are skipped.
export function inboxReason(thread,actorId){
  const status=statusOf(thread),messages=live(thread);
  if(!messages.length||status==='resolved'||thread.to?.kind==='human')return null;
  if(thread.to?.kind==='agent'&&thread.to.id&&thread.to.id!==actorId)return null;
  if(status==='sent')return 'sent';
  if(status==='open'&&thread.to?.kind==='agent')return 'new';
  const lastAgent=messages.map(message=>message.author?.kind).lastIndexOf('agent');
  if(lastAgent>=0&&messages.at(-1).author?.kind==='human'&&status!=='working')return 'reply';
  return null;
}
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}}
// {actorId?, since?, limit?} → {threads:[...], count, nextSince}. Read-only.
export async function feedbackInbox(config,{actorId='agent',since,limit=50,includeLinks=true}={}){
  if(!ID.test(actorId)){const error=new Error('Invalid actorId.');error.status=400;throw error;}
  if(!Number.isSafeInteger(limit)||limit<1||limit>100){const error=new Error('Inbox limit must be 1–100.');error.status=400;throw error;}
  const position=readToken(since),root=config.workspaceRoot||path.join(config.boardsRoot,'.tinka'),directory=path.join(root,'threads');
  let names=[];try{names=(await readdir(directory)).filter(name=>name.endsWith('.json')&&!name.startsWith('.'));}catch{}
  const threads=(await Promise.all(names.map(name=>readJson(path.join(directory,name))))).filter(thread=>thread&&ID.test(thread.id||''));
  let high={r:position.r,id:position.id};
  for(const thread of threads){const r=thread.updatedRevision??0;if(after(r,thread.id,high))high={r,id:thread.id};}
  const found=threads.map(thread=>({thread,reason:inboxReason(thread,actorId),r:thread.updatedRevision??0})).filter(entry=>entry.reason&&after(entry.r,entry.thread.id,position))
    .sort((a,b)=>a.r-b.r||(a.thread.id<b.thread.id?-1:1));
  const boards=new Map(),base=found.length&&includeLinks?await verifiedURL(config):null;
  const boardTitle=async id=>{if(!boards.has(id))boards.set(id,ID.test(id)?readJson(path.join(root,'boards',`${id}.json`)).then(board=>board?.title||id):Promise.resolve(id));return boards.get(id);};
  const listed=await Promise.all(found.slice(0,limit).map(async({thread,reason})=>{
    const messages=live(thread),last=messages.at(-1),human=[...messages].reverse().find(message=>message.author?.kind==='human')||last;
    const linkPath=`/boards/${encodeURIComponent(thread.boardId)}/#comments/${encodeURIComponent(thread.id)}`;
    return {threadId:thread.id,boardId:thread.boardId,boardTitle:await boardTitle(thread.boardId),...(base?{link:new URL(linkPath,base).href}:{linkPath}),
      ...(thread.targetLabel?{targetLabel:thread.targetLabel}:{}),status:statusOf(thread),reason,snippet:String(human.body||'').replace(/\s+/g,' ').trim().slice(0,140),lastAuthor:last.author,updatedAt:thread.updatedAt};
  }));
  return {threads:listed,count:found.length,nextSince:token(high.r,high.id),...(listed.length&&includeLinks&&!base?linkRecovery(config):{})};
}
const statePath=config=>path.join(path.dirname(config.configPath),'.inbox-state.json');
async function savedSince(config,actorId){const state=await readJson(statePath(config));return state?.schemaVersion===1?state.actors?.[actorId]?.since:undefined;}
async function saveSince(config,actorId,since){
  const file=statePath(config),state=(await readJson(file))||{};const next={schemaVersion:1,actors:{...(state.schemaVersion===1?state.actors:{}),[actorId]:{since,at:new Date().toISOString()}}};
  const temporary=`${file}.${randomUUID()}.tmp`;
  try{await writeFile(temporary,`${JSON.stringify(next,null,2)}\n`,{mode:0o600});await rename(temporary,file);}finally{await rm(temporary,{force:true}).catch(()=>{});}
}
const command=(config,options,actorId)=>`node ${shown(fileURLToPath(new URL('../cli.mjs',import.meta.url)))} inbox --config ${shown(config.configPath)}${options.actor?` --actor ${actorId}`:''}`;
function briefLine(result,run){
  const titles=[...new Set(result.threads.map(thread=>thread.boardTitle))],where=titles.length===1?`'${titles[0]}'`:`'${titles[0]}' and ${titles.length-1} other board${titles.length>2?'s':''}`;
  return `Tinka: ${result.count} new comment${result.count===1?'':'s'} for you on ${where} — run \`${run}\` for details`;
}
const shown=target=>{const relative=path.relative(process.cwd(),target);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)?relative:target;};
// CLI: inbox --config PATH [--since TOKEN] [--actor ID] [--brief] [--json]. --brief prints
// nothing when nothing is new and never moves the saved position; a full run shows the threads
// and saves the new position, so the next brief only reports newer things.
export async function inboxCommand(config,options){
  const actorId=options.actor||'agent',since=options.since??await savedSince(config,actorId);
  if(options.watch){
    const timeout=options.timeout===undefined?undefined:Number(options.timeout);
    if(timeout!==undefined&&(!Number.isFinite(timeout)||timeout<=0))throw new Error('--timeout must be a number of seconds.');
    const found=await watchInbox(config,{actorId,label:options.label,since,timeoutSeconds:timeout});
    if(!found)return '';
    if(options.since===undefined)await saveSince(config,actorId,found.nextSince);
    if(options.json)return JSON.stringify(found,null,2);
    return [briefLine(found,command(config,options,actorId)),...found.threads.map(thread=>`- ${thread.boardTitle}${thread.targetLabel?` · on ${thread.targetLabel}`:''}: "${thread.snippet}" ${thread.link||thread.linkPath} (thread ${thread.threadId})`),...(found.startCommand?[`${found.linkWarning}\n${found.startCommand}`]:[])].join('\n');
  }
  const result=await feedbackInbox(config,{actorId,since,limit:options.brief?100:50,includeLinks:!options.brief});
  if(options.brief)return result.count?briefLine(result,command(config,options,actorId)):'';
  if(options.since===undefined)await saveSince(config,actorId,result.nextSince);
  if(options.json)return JSON.stringify(result,null,2);
  if(!result.count)return 'Tinka inbox: nothing new for you.';
  const lines=result.threads.map(thread=>`- ${thread.boardTitle}${thread.targetLabel?` · on ${thread.targetLabel}`:''} [${thread.reason==='reply'?'reply':thread.status}] ${thread.lastAuthor?.label||''}: "${thread.snippet}"\n  ${thread.link||thread.linkPath}\n  thread ${thread.threadId}`);
  return [`Tinka inbox: ${result.count} comment${result.count===1?'':'s'} for you.`,...lines,...(result.startCommand?[`${result.linkWarning}\n${result.startCommand}`]:[]),'',`Read a thread: tools call feedback.list --json '{"threadId":"ID","includeBodies":true}'. Reply with feedback.reply (changes, status "addressed" or "question"); a person resolves.`].join('\n');
}
// --watch: wait quietly until something new is waiting, through the running Tinka server's
// long-poll (presence shows "Agent is watching" on the board), else through a filesystem watch
// on the thread files. No tight polling either way. Resolves with the result, or null at timeout.
async function serverURL(config){
  try{
    const {readRuntime}=await import('./runtime.mjs'),record=await readRuntime(config);
    if(!record?.url||record.state!=='ready')return null;
    try{process.kill(record.pid,0);}catch(error){if(error.code==='ESRCH')return null;}
    const url=await verifiedURL(config);
    return record.url===url?url:null;
  }catch{return null;}
}
async function waitThroughServer(url,{actorId,label,since,deadline}){
  for(;;){
    const remaining=deadline===null?300:Math.ceil((deadline-Date.now())/1000);if(remaining<=0)return null;
    const query=new URLSearchParams({actor:actorId,wait:String(Math.min(300,remaining)),...(since?{since}:{}),...(label?{label}:{})});
    const response=await fetch(new URL(`api/inbox?${query}`,url));
    if(!response.ok)throw new Error(`Tinka inbox wait failed (${response.status}).`);
    const result=await response.json();if(result.count)return result;
  }
}
async function waitThroughFiles(config,{actorId,since,deadline}){
  const {watch}=await import('node:fs'),root=config.workspaceRoot||path.join(config.boardsRoot,'.tinka');
  return new Promise((resolve,reject)=>{
    const watchers=[];let timer,limit,settled=false,checking=false,again=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(limit);for(const watcher of watchers)watcher.close();resolve(value);};
    const check=async()=>{if(checking){again=true;return;}checking=true;try{const result=await feedbackInbox(config,{actorId,since});if(result.count)finish(result);}catch(error){settled=true;reject(error);}finally{checking=false;if(again&&!settled){again=false;void check();}}};
    for(const target of [root,path.join(root,'threads')]){try{const watcher=watch(target,()=>{clearTimeout(timer);timer=setTimeout(check,150);});watcher.on('error',()=>{});watchers.push(watcher);}catch{}}
    if(deadline!==null)limit=setTimeout(()=>finish(null),Math.max(0,deadline-Date.now()));
    void check();
  });
}
export async function watchInbox(config,{actorId='agent',label,since,timeoutSeconds}={}){
  const deadline=timeoutSeconds===undefined?null:Date.now()+timeoutSeconds*1000,url=await serverURL(config);
  if(url){try{return await waitThroughServer(url,{actorId,label,since,deadline});}catch{/* The server went away: keep waiting on the files. */}}
  return waitThroughFiles(config,{actorId,since,deadline});
}
export const inboxToolDefinitions=[
  {name:'feedback.inbox',mutating:false,description:'Comments that need this agent: handed to it (sent), addressed to it and open, or a person replied after its last message. Read-only and fast (no lock). Each has board, link, targetLabel, status, reason and a one-line snippet. since is a position from a previous nextSince; omit it for everything waiting.',inputSchema:{type:'object',additionalProperties:false,properties:{actorId:{type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$',maxLength:128},since:{type:'string',maxLength:512},limit:{type:'integer',minimum:1,maximum:100}}}},
];
