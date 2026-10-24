// The server watches project files, including writes from other CLI processes.
// Each connection starts with an authoritative resync; no browser polling loop.
export function watchChanges(config,{boardId,onSnapshot,onChange,onConnection=()=>{},onIdentity=()=>{}}={}) {
  let stream,retry,stopped=false;
  const endpoint=`/api/events?workspace=${encodeURIComponent(config.workspaceId)}${boardId?`&board=${encodeURIComponent(boardId)}`:''}`;
  const connect=()=>{
    if(stopped)return;stream?.close();stream=new EventSource(endpoint);
    const receive=handler=>event=>{try{const value=JSON.parse(event.data);if(value.runtimeId!==config.workspaceId){stream.close();onConnection(false);onIdentity();return;}onConnection(true);Promise.resolve(handler?.(value)).catch(()=>{onConnection(false);stream.close();clearTimeout(retry);retry=setTimeout(connect,1500);});}catch{onConnection(false);}};
    stream.addEventListener('snapshot',receive(onSnapshot));
    stream.addEventListener('change',receive(onChange));
    stream.addEventListener('unavailable',()=>onConnection(false));
    stream.addEventListener('identity',()=>{stream.close();onConnection(false);onIdentity();});
    stream.onerror=()=>onConnection(false);
  };
  const visible=()=>{if(!document.hidden)connect();};
  const stop=()=>{stopped=true;clearTimeout(retry);stream?.close();document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',connect);window.removeEventListener('pagehide',stop);};
  document.addEventListener('visibilitychange',visible);window.addEventListener('online',connect);window.addEventListener('pagehide',stop);connect();return stop;
}
export function watchBoard(boardId,{config,onSnapshot,onManifestChange,onShellChange,onConnection}) {
  let latest,queued,running=false;
  async function drain(){
    if(running)return;running=true;
    try{while(queued){const snapshot=queued;queued=null;
      if(!snapshot.concepts||typeof snapshot.revision!=='string')throw new Error('Invalid board state');
      // Initial/resumed connection also reconciles metadata fetched before connect.
      if(!latest||latest.manifestRevision!==snapshot.manifestRevision)await onManifestChange(snapshot.manifestRevision);
      if(latest&&latest.shellRevision!==snapshot.shellRevision)onShellChange();
      if(!latest||latest.revision!==snapshot.revision)await onSnapshot(snapshot,latest);
      latest=snapshot;
    }}finally{running=false;}
  }
  return watchChanges(config,{boardId,onSnapshot:snapshot=>{queued=snapshot;return drain();},onConnection});
}
