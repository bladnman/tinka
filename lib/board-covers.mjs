import path from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolveResource} from './resources.mjs';
import {treeRevision} from './revisions.mjs';
import {isInside} from './paths.mjs';

// A representation of the current contents, never stored as board metadata.
// Do not descend into board-only children: four tiles means at most four frames.
export function boardCovers(boards, items, ids = Object.keys(boards)) {
  const result = {};
  for (const id of new Set(ids)) {
    const board = boards[id], owner = items[board?.ownerItemId];
    if (!board || !owner || owner.deletedAt) continue;
    const byId = new Map(board.placements.map(p => [p.id, p]));
    const order = [...new Set([...(board.reviewOrder || []), ...byId.keys()])];
    const placements = order.map(id => byId.get(id)).filter(p => p && !p.removedAt && !p.archivedAt && !p.deletedAt && items[p.itemId] && !items[p.itemId].deletedAt && !items[p.itemId].archivedAt);
    const tiles = placements.slice(0, 4).map(p => {
      const item = items[p.itemId], content = item.content;
      const available = !['building', 'reserved'].includes(item.build?.state);
      const resource = available && (item.preview?.resource || (['image', 'html'].includes(content?.kind) && !content.url ? content.resource : null));
      return {id:p.id, itemId:item.id, title:item.title, kind:resource ? (item.preview?.resource || content.kind === 'image' ? 'image' : 'html') : 'text',
        ...(resource ? {resource} : {}), text:item.preview?.text || content?.text || item.title,
        board:!!item.childBoardId, viewport:p.presentation?.viewport || {width:1000,height:720}};
    });
    result[id] = {count:placements.length, tiles};
  }
  return result;
}

// Share fingerprints across snapshots/live polls/thumbnail requests. Metadata-only
// callers do not enter this path, and concurrent reads reuse the same work.
const revisions = new Map(), trees = new Map();
function cached(map,key,build) {
  const previous=map.get(key);
  if(previous && previous.expires>Date.now()) return previous.promise;
  const entry={expires:Infinity,promise:null};
  entry.promise=build().then(value=>{entry.expires=Date.now()+750;return value;},error=>{map.delete(key);throw error;});
  map.set(key,entry);
  if(map.size>256)map.delete(map.keys().next().value);
  return entry.promise;
}
async function htmlRevision(root,entry,rootId) {
  const visited=new Set(),parts=[];
  async function visit(relative,depth=0) {
    if(visited.has(relative)||visited.size>=64||depth>8)return;
    visited.add(relative);
    const absolute=path.join(root,relative);
    let actual;
    try { actual=await realpath(absolute); } catch(error) { if(!['ENOENT','ENOTDIR'].includes(error.code))throw error; parts.push(relative,'missing'); return; }
    if(!isInside(root,actual)||path.relative(root,actual).split(path.sep).some(segment=>segment.startsWith('.')))return;
    const details=await stat(actual);
    if(!details.isFile())return;
    parts.push(relative,await cached(trees,JSON.stringify([root,relative]),()=>treeRevision(root,relative)));
    if(details.size>2_000_000||! /\.(?:html?|css|[cm]?js)$/i.test(relative))return;
    const text=await readFile(actual,'utf8');
    const references=[...text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']|\burl\(\s*["']?([^\s"')]+)|\b(?:from|import)\s*["']([^"']+)["']/gi)].map(match=>match[1]||match[2]||match[3]);
    for(const ref of references) {
      if(/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(ref))continue;
      let local;
      try { local=decodeURIComponent(ref.split(/[?#]/)[0]); } catch { continue; }
      if(local.startsWith('/')) {
        const prefix=`/resources/${encodeURIComponent(rootId)}/`;
        if(!local.startsWith(prefix))continue;
        local=local.slice(prefix.length);
      } else local=path.posix.join(path.posix.dirname(relative),local);
      if(local.split('/').some(segment=>segment.startsWith('.'))||local.includes('\\'))continue;
      await visit(local,depth+1);
    }
  }
  await visit(entry);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export async function coverRevisions(config, covers) {
  for (const cover of Object.values(covers)) for (const tile of cover.tiles) {
    if (!tile.resource) continue;
    const key = JSON.stringify([config.configPath,config.workspaceRoot,config.boardsRoot,tile.kind,tile.resource]);
    tile.revision = await cached(revisions,key,async () => {
      try {
        const file = await resolveResource(config, tile.resource);
        const relative = path.relative(file.rootPath,file.path).split(path.sep).join('/');
        return tile.kind === 'html' ? await htmlRevision(file.rootPath,relative,tile.resource.rootId)
          : await cached(trees,JSON.stringify([file.rootPath,relative]),()=>treeRevision(file.rootPath,relative));
      } catch (error) {
        if (![400,403,404].includes(error.status)) throw error;
        return null;
      }
    });
    if (!tile.revision) { tile.kind = 'text'; delete tile.resource; }
  }
  return covers;
}
