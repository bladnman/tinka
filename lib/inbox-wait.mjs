// Server side of live agent pickup: GET /api/inbox long-polls until a thread changes and
// something is waiting for the actor, using one filesystem watch on the threads directory
// shared by all waiters (no polling). Watching actors are kept as presence for the board.
import {watch} from 'node:fs';
import path from 'node:path';
import {feedbackInbox} from './inbox.mjs';

const GRACE_MS=20_000,MAX_WAIT=300;
export function createInboxWaiter(config,{onPresence=()=>{}}={}){
  const waiters=new Set(),presence=new Map();let watchers=[],stopped=false;
  const watching=()=>({watching:[...presence.values()].map(entry=>({actor:{id:entry.id,...(entry.label?{label:entry.label}:{})},since:entry.since}))});
  function wakeAll(){for(const waiter of waiters)waiter.wake();}
  function startWatching(){
    if(watchers.length||!waiters.size)return;
    // The workspace root sees threads/ appear; threads/ sees every thread write (atomic renames).
    for(const target of [config.workspaceRoot,path.join(config.workspaceRoot,'threads')]){
      try{const watcher=watch(target,{persistent:false},()=>{if(target===config.workspaceRoot&&watchers.length<2){stopWatching();startWatching();}wakeAll();});watcher.on('error',()=>{});watchers.push(watcher);}catch{}
    }
  }
  function stopWatching(){for(const watcher of watchers)watcher.close();watchers=[];}
  function hold(actor){
    const entry=presence.get(actor.id)||{id:actor.id,label:actor.label,since:new Date().toISOString(),holds:0,timer:null};
    clearTimeout(entry.timer);entry.timer=null;entry.holds++;if(actor.label)entry.label=actor.label;
    const added=!presence.has(actor.id);presence.set(actor.id,entry);if(added)onPresence(watching());
    return()=>{entry.holds--;if(entry.holds>0)return;entry.timer=setTimeout(()=>{if(entry.holds===0&&presence.get(actor.id)===entry){presence.delete(actor.id);onPresence(watching());}},GRACE_MS);entry.timer.unref?.();};
  }
  // {actor:{id,label?}, since, wait seconds} → inbox result. Ends early when the request closes.
  async function wait({actor,since,wait=0,signal}){
    let result=await feedbackInbox(config,{actorId:actor.id,since});
    const seconds=Math.max(0,Math.min(MAX_WAIT,Number(wait)||0));
    if(result.count||!seconds||stopped)return result;
    const release=hold(actor),deadline=Date.now()+seconds*1000;
    try{
      while(!stopped&&!signal?.aborted&&Date.now()<deadline){
        await new Promise(resolve=>{
          const waiter={wake:()=>setTimeout(done,120)};let timer;
          function done(){waiters.delete(waiter);clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}
          timer=setTimeout(done,Math.max(0,deadline-Date.now()));waiters.add(waiter);signal?.addEventListener('abort',done,{once:true});startWatching();
        });
        if(!waiters.size)stopWatching();
        result=await feedbackInbox(config,{actorId:actor.id,since});
        if(result.count)return result;
      }
      return result;
    }finally{release();if(!waiters.size)stopWatching();}
  }
  return {wait,presence:watching,stop(){stopped=true;wakeAll();stopWatching();for(const entry of presence.values())clearTimeout(entry.timer);}};
}
