import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {conceptKeys,conceptSourcePaths,digest,loadBoard,publicState} from './boards.mjs';
import {existingInside,safeRelative} from './paths.mjs';
import {getShellRevision,treeRevision} from './revisions.mjs';
import {getBoardSnapshot} from './workspace.mjs';
import {resolveResource} from './resources.mjs';

export function createLiveState(config,id,{cacheMs=750}={}){
  let cached;let expiresAt=0;let pending;
  async function build(){
    const board=await loadBoard(config,id);
    const root=board.root;
    const manifestFile=await readFile((await existingInside(root,'rounds.json')).path);
    const buildFile=await existingInside(root,'build-state.json').then(file=>readFile(file.path)).catch(error=>{if(error.status===404)return Buffer.from('{"concepts":{}}');throw error;});
    const manifestRevision=digest(manifestFile,await readFile((await existingInside(root,'board.json')).path));
    const shell=await getShellRevision({cacheMs:0});
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

// Schema 2 metadata and resource bytes change independently. Only inspect the
// resources used by this board; never fetch a preview URL or execute a command.
export function createWorkspaceLiveState(config,id,{cacheMs=750}={}){
  let cached,expiresAt=0,pending;
  async function build(){
    const board=await getBoardSnapshot(config,id);
    const shellRevision=await getShellRevision({cacheMs:0});const items={},concepts={};
    const stacks=[];
    for(const item of Object.values(board?.items||{})){
      const parts=[];
      const versions=item.versionStack?.versions;
      const representative=versions?.find(version=>version.content.resource.path===item.content.resource.path)?.content
        || versions?.at(-1)?.content || item.content;
      const versionRef=versions&&representative.resource;
      const versionDirectory=versionRef&&path.posix.dirname(versionRef.path);
      const siblingNames=versions&&new Set(versions.map(version=>path.posix.basename(version.content.resource.path)));
      const omitSibling=entry=>entry.isFile()&&siblingNames.has(entry.name);
      let versionAssets;
      const contents=[representative,...(item.revisions||[]).map(revision=>revision.content)];
      const refs=[item.preview?.resource,...contents.map(content=>content?.resource),...(item.resources||[]).map(resource=>resource.resource||resource)].filter(Boolean);
      for(const ref of refs){
        try {
          const resolved=await resolveResource(config,ref);
          const relative=path.relative(resolved.rootPath,resolved.path).split(path.sep).join('/');
          const directory=path.posix.dirname(relative);
          const sharesVersionDirectory=versionRef?.rootId===ref.rootId&&path.posix.dirname(ref.path)===versionDirectory&&directory===versionDirectory;
          const stamp=sharesVersionDirectory
            ? (versionAssets ??= await treeRevision(resolved.rootPath,directory,{omitDirectEntry:omitSibling}))
            : await treeRevision(resolved.rootPath,directory);
          parts.push(ref.rootId,ref===versionRef?versionDirectory:ref.path,stamp);
        }
        catch(error){if(![400,403,404].includes(error.status))throw error;parts.push(ref.rootId,ref.path,`unavailable:${error.status}`);}
      }
      if(item.legacy?.boardId){
        const dependencies=new Set(['shared','assets',...(item.dependencies||[]),...(item.revisions||[]).flatMap(revision=>revision.dependencies||[])]);
        for(const relative of dependencies){
          try{const root=await realpath(path.join(config.boardsRoot,item.legacy.boardId));parts.push(relative,await treeRevision(root,safeRelative(relative)));}catch(error){if(error.code!=='ENOENT'&&![400,403,404].includes(error.status))throw error;}
        }
      }
      if(versions)stacks.push([item.id,versions.map(version=>[version.id,version.content.resource.path,version.modifiedAt])]);
      const assetsRevision=digest(...parts);
      const revision=versions?digest(assetsRevision,...versions.map(version=>version.sourceRevision)):assetsRevision;
      // Shared relative assets affect each sibling. Editing or adding a sibling
      // leaves the live stamp of another already selected version stable.
      const versionRevisions=versions&&Object.fromEntries(versions.map(version=>[version.id,digest(version.sourceRevision,assetsRevision)]));
      const state={...item.build,revision,...(versionRevisions?{versionRevisions}:{})};items[item.id]=state;concepts[item.legacy?.key||item.id]=state;
    }
    const manifestRevision=String(board?.revision||0);
    const versionStackRevision=stacks.length?digest(JSON.stringify(stacks)):null;
    const boardCovers=board?.boardCovers||{};
    return {schemaVersion:2,revision:digest(shellRevision,manifestRevision,versionStackRevision||'',JSON.stringify(items),JSON.stringify(boardCovers)),shellRevision,manifestRevision,versionStackRevision,items,concepts,boardCovers};
  }
  return async()=>{if(cached&&Date.now()<expiresAt)return cached;if(pending)return pending;pending=build().then(value=>{cached=value;expiresAt=Date.now()+cacheMs;return value;}).finally(()=>{pending=null;});return pending;};
}
