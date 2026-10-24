import {watch} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withStore} from './store.mjs';
import {loadConfig} from './config.mjs';
import {validateRootLocations} from './resources.mjs';

const publicRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
// One event source per server/config. Filesystem events, including other CLI
// processes, drive reads; heartbeat traffic never polls workspace documents.
export function createPushHub(config,{snapshot,coalesceMs=850,heartbeatMs=15000,maxClients=128}={}){
  const clients=new Set(),watchers=new Map();let stopped=false,generation=0,snapshotBuilds=0,rootChecks=0,filesystemEvents=0,timer,retry,heartbeat,running=false,dirty=false,rootsDirty=true,watchedTargets=new Set(),retryDelay=1500;
  function frame(client,event,data){
    if(client.res.destroyed||client.res.writableEnded)return;
    if(client.res.writableLength>262144){client.res.destroy();return;}
    client.res.write(`id: ${generation}\nevent: ${event}\ndata: ${JSON.stringify({...data,runtimeId:config.workspaceId})}\n\n`);
  }
  function relevant(file,target){
    if(file===config.configPath||inside(publicRoot,file))return true;
    if(inside(config.workspaceRoot,file)){
      const relative=path.relative(config.workspaceRoot,file).split(path.sep);
      return relative.length===1?relative[0]==='workspace.json'||!relative[0]:['items','boards','threads'].includes(relative[0]);
    }
    return !path.relative(target,file).split(path.sep).some(part=>part.startsWith('.'));
  }
  function schedule({roots=false,immediate=false}={}){
    if(stopped||!clients.size)return;
    rootsDirty ||= roots;dirty=true;
    if(!running&&!timer)timer=setTimeout(()=>{timer=null;void flush();},immediate?0:coalesceMs).unref();
  }
  async function watchRoot(target,recursive){
    const key=`${recursive?'r':'p'}:${target}`;if(stopped||!clients.size||watchers.has(key))return key;
    const watcher=watch(target,{recursive,persistent:false},(_event,name)=>{
      const file=name?path.resolve(target,String(name)):target;
      if((recursive||!name||watchedTargets.has(file))&&relevant(file,target)){filesystemEvents++;schedule({roots:true});}
    });
    watcher.on('error',()=>{watcher.close();watchers.delete(key);degraded();});
    watchers.set(key,watcher);return key;
  }
  function degraded(){
    for(const client of clients)frame(client,'unavailable',{message:'Live updates are reconnecting.'});
    if(!retry&&!stopped)retry=setTimeout(async()=>{retry=null;if(!clients.size||stopped)return;try{if(await syncRoots()){retryDelay=1500;schedule({immediate:true});}}catch{degraded();}},retryDelay).unref();
    retryDelay=Math.min(30000,retryDelay*2);
  }
  async function syncRoots(){
    rootChecks++;
    const roots=await withStore(config,(_root,state)=>state?.metadata.resourceRoots||{},{metadataOnly:true});
    await validateRootLocations(config,roots);
    const desired=new Set();let incomplete=false;
    const targets=new Set([config.boardsRoot,config.workspaceRoot,publicRoot,...Object.values(roots).map(root=>path.resolve(config.workspaceRoot,root.path))]);
    watchedTargets=new Set([...targets,config.configPath]);
    for(const target of targets){
      // Parent watches detect atomic replacement of the watched directory itself.
      const parent=path.dirname(target);
      try{desired.add(await watchRoot(parent,false));}catch{incomplete=true;}
      try{const actual=await realpath(target);if((await stat(actual)).isDirectory())desired.add(await watchRoot(actual,true));else incomplete=true;}catch{incomplete=true;}
    }
    desired.add(await watchRoot(path.dirname(config.configPath),false));
    for(const [key,watcher] of watchers)if(!desired.has(key)){watcher.close();watchers.delete(key);}
    if(incomplete)degraded();
    return !incomplete;
  }
  async function flush(){
    if(running||stopped||!clients.size)return;running=true;dirty=false;
    try{
      const current=await loadConfig(config.configPath);
      if(current.workspaceId!==config.workspaceId||current.workspaceRoot!==config.workspaceRoot){for(const c of clients){frame(c,'identity',{message:'Workspace changed. Reload this page.'});c.res.end();}return;}
      if(rootsDirty){rootsDirty=false;await syncRoots();}
      generation++;
      const builds=new Map();
      for(const client of clients){
        if(client.board){
          if(!builds.has(client.board)){snapshotBuilds++;builds.set(client.board,Promise.resolve().then(()=>snapshot(client.board)));}
          try{const value=await builds.get(client.board);if(client.initial||client.revision!==value.revision){frame(client,'snapshot',value);client.revision=value.revision;client.initial=false;}}
          catch{frame(client,'unavailable',{message:'Live board is temporarily unavailable.'});degraded();}
        }else{frame(client,'change',{generation});client.initial=false;}
      }
    }catch{rootsDirty=true;degraded();}
    finally{running=false;if(dirty)schedule();}
  }
  function idle(){
    clearTimeout(timer);clearTimeout(retry);clearInterval(heartbeat);timer=retry=heartbeat=null;
    for(const watcher of watchers.values())watcher.close();watchers.clear();rootsDirty=true;
  }
  return {
    subscribe(req,res,board){
      if(stopped||clients.size>=maxClients){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Live update capacity reached."}');return;}
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('retry: 1500\n\n');
      const client={res,board,initial:true};clients.add(client);
      res.once('close',()=>{clients.delete(client);if(!clients.size)idle();});
      if(!heartbeat)heartbeat=setInterval(()=>{for(const c of clients){if(c.res.writableLength>262144)c.res.destroy();else c.res.write(': heartbeat\n\n');}},heartbeatMs).unref();
      schedule({roots:true,immediate:true});
    },
    invalidate:()=>schedule({roots:true}),
    close(){stopped=true;idle();for(const c of clients)c.res.end();clients.clear();},
    diagnostics:()=>({clients:clients.size,watchers:watchers.size,running,generation,snapshotBuilds,rootChecks,filesystemEvents}),
  };
}
