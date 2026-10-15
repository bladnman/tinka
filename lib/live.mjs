import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {conceptKeys,conceptSourcePaths,digest,loadBoard,publicState} from './boards.mjs';
import {existingInside,safeRelative} from './paths.mjs';
import {getShellRevision,treeRevision} from './revisions.mjs';

export function createLiveState(config,id,{cacheMs=750}={}){
  let cached;let expiresAt=0;let pending;
  async function build(){
    const board=await loadBoard(config,id);
    const root=board.root;
    const manifestFile=await readFile((await existingInside(root,'rounds.json')).path);
    const buildFile=await existingInside(root,'build-state.json').then(file=>readFile(file.path)).catch(error=>{if(error.status===404)return Buffer.from('{"concepts":{}}');throw error;});
    const manifestRevision=digest(manifestFile);
    const shell=await getShellRevision();
    const shared=digest(await treeRevision(root,'shared'),await treeRevision(root,'assets'));
    const paths=conceptSourcePaths(board.manifest);
    const concepts={};const sourceParts=[];
    for(const key of conceptKeys(board.manifest)){
      const sources=paths.get(key)||new Set([`rounds/${key}`]);
      const parts=[];
      for(const source of sources)parts.push(source,await treeRevision(root,source==='.'?'':safeRelative(source)));
      const revision=digest(shared,...parts);
      concepts[key]={...publicState(board.build.concepts[key]),revision};
      sourceParts.push(key,revision);
    }
    return {revision:digest(shell,manifestRevision,digest(buildFile),...sourceParts),shellRevision:shell,manifestRevision,concepts};
  }
  return async function getLiveState(){
    if(cached&&Date.now()<expiresAt)return cached;
    if(pending)return pending;
    pending=build().then(snapshot=>{cached=snapshot;expiresAt=Date.now()+cacheMs;return snapshot;}).finally(()=>{pending=null;});
    return pending;
  };
}
