import path from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolveResource} from './resources.mjs';
import {treeRevision} from './revisions.mjs';
import {isInside} from './paths.mjs';

function remotePreview(value) {
  try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

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
      const resource = available && (item.preview?.resource || (['image', 'html', 'pdf'].includes(content?.kind) && !content.url ? content.resource : null));
      const url = available && !resource ? remotePreview(item.preview?.url) : null;
      return {id:p.id, itemId:item.id, title:item.title, kind:resource ? (item.preview?.resource || content.kind === 'image' ? 'image' : content.kind) : url ? 'image' : 'text',
        ...(resource ? {resource} : url ? {url,revision:'external'} : {}), text:item.preview?.text || content?.text || item.title,
        board:!!item.childBoardId, viewport:p.presentation?.viewport || {width:1000,height:content?.kind==='pdf'&&!item.preview?.resource?1414:720}};
    });
    result[id] = {count:placements.length, tiles, ...miniature(board, items, placements, tiles)};
  }
  return result;
}

// A miniature of the board: tiles at their real relative positions and sizes,
// region tints, type and saved previews. It is response data only, bounded so a
// Home page stays light: at most 60 tiles, 24 regions, 8 images and 4 live HTML
// thumbnails per board (the largest ones), decided here rather than per client.
const MINI_TILES = 60, MINI_IMAGES = 8, MINI_FRAMES = 4;
function miniature(board, items, placements, tiles) {
  const geometry = p => [p.x, p.y, p.width, p.height].every(Number.isFinite) && p.width > 0 && p.height > 0;
  const placed = placements.filter(geometry);
  if (!placed.length) return {};
  const regions = (board.regions || (board.decorations || []).filter(d => d?.type === 'region' && geometry(d)).slice(0, 24)
    .map(d => ({x:d.x, y:d.y, width:d.width, height:d.height, ...(typeof d.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(d.color) ? {color:d.color} : {}), ...(d.shape ? {shape:String(d.shape)} : {}), text:String(d.text || '').trim().split('\n')[0].slice(0, 60)})))
    .filter(geometry);
  // Keep the largest tiles, listed in review order (stacking travels separately as z).
  const largest = new Set([...placed].sort((a, b) => b.width * b.height - a.width * a.height).slice(0, MINI_TILES));
  const chosen = placed.filter(p => largest.has(p));
  const all = [...chosen, ...regions];
  const left = Math.min(...all.map(r => r.x)), top = Math.min(...all.map(r => r.y));
  const width = Math.max(...all.map(r => r.x + r.width)) - left, height = Math.max(...all.map(r => r.y + r.height)) - top;
  // Decide which tiles get a preview: the largest image and HTML tiles first.
  const candidate = p => {
    const item = items[p.itemId], content = item.content;
    const available = !['building', 'reserved'].includes(item.build?.state);
    const local = available && (item.preview?.resource || (['image', 'html'].includes(content?.kind) && !content.url ? content.resource : null));
    const kind = local ? (item.preview?.resource || content.kind === 'image' ? 'image' : 'html') : null;
    const remote = available && !local ? remotePreview(item.preview?.url) : null;
    if (p.presentation?.mode === 'icon') return null;
    return remote ? {kind:'image', url:remote, revision:'external'} : kind === 'image' ? {kind:'image', resource:local} : kind === 'html' ? {kind:'html', resource:local, viewport:p.presentation?.viewport || {width:1000, height:720}} : null;
  };
  const previews = new Map();
  let images = 0, frames = 0;
  for (const p of [...chosen].sort((a, b) => b.width * b.height - a.width * a.height)) {
    const preview = candidate(p);
    if (preview?.kind === 'image' && images < MINI_IMAGES) { images++; previews.set(p.id, preview); }
    else if (preview?.kind === 'html' && frames < MINI_FRAMES) { frames++; previews.set(p.id, preview); }
  }
  const entries = chosen.map(p => {
    const item = items[p.itemId], content = item.content;
    const available = !['building', 'reserved'].includes(item.build?.state);
    const mode = p.presentation?.mode === 'panel' ? 'panel' : p.presentation?.mode === 'icon' ? 'icon' : 'card';
    const preview = previews.get(p.id) || null;
    return {id:p.id, itemId:item.id, title:item.title, x:p.x - left, y:p.y - top, width:p.width, height:p.height, z:Number.isFinite(p.z) ? p.z : 0, mode,
      type:item.childBoardId && !content ? 'board' : content?.kind || (item.preview ? 'image' : 'idea'), board:!!item.childBoardId,
      ...(item.review?.star ? {star:true} : {}), ...(available ? {} : {state:item.build.state}),
      ...(/^#[0-9a-f]{3,8}$/i.test(p.presentation?.paper || '') ? {paper:p.presentation.paper} : {}), ...(preview ? {preview} : {})};
  });
  return {layout:{width, height, regions:regions.map(r => ({...r, x:r.x - left, y:r.y - top})), tiles:entries, ...(placed.length > chosen.length ? {omitted:placed.length - chosen.length} : {})}};
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
async function statRevision(config, resource) {
  try { const file = await resolveResource(config, resource); const details = await stat(file.path); return details.isFile() ? `${details.size}-${Math.round(details.mtimeMs)}` : null; }
  catch (error) { if (![400,403,404].includes(error.status) && !['ENOENT','ENOTDIR'].includes(error.code)) throw error; return null; }
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
  // Miniature previews reuse a collage revision when the same tile has one;
  // otherwise a light stat-based revision avoids hashing every Home image.
  for (const cover of Object.values(covers)) {
    const collage = new Map(cover.tiles.map(tile => [tile.id, tile]));
    for (const tile of cover.layout?.tiles || []) {
      const preview = tile.preview;
      if (!preview?.resource) continue;
      const known = collage.get(tile.id);
      if (known?.revision && JSON.stringify(known.resource) === JSON.stringify(preview.resource)) { preview.revision = known.revision; continue; }
      if (known && !known.resource && known.kind === 'text') { delete tile.preview; continue; }
      preview.revision = await cached(revisions, JSON.stringify(['stat', config.configPath, config.workspaceRoot, config.boardsRoot, preview.resource]), () => statRevision(config, preview.resource));
      if (!preview.revision) delete tile.preview;
    }
  }
  return covers;
}
