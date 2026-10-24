// Rebuildable metadata-only discovery. Canonical files and the normal store lock
// remain authoritative; no resource payload or network request enters this index.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import {withStore,readStoreDocument,listStoreDocumentIds,storeError,assertId} from './store.mjs';
import {isInside} from './paths.mjs';

const FORMAT=1,BUCKETS=32;
const metrics={sourceStats:0,shardReads:0,shardBytes:0,shardWrites:0,shardWriteBytes:0,rebuilds:0};
export function discoveryMetrics({reset=false}={}){const result={...metrics};if(reset)for(const key of Object.keys(metrics))metrics[key]=0;return result;}
const hash=value=>createHash('sha256').update(value).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;
const bucket=id=>parseInt(hash(id).slice(0,4),16)%BUCKETS;
const cacheRoot=root=>path.join(root,'.discovery');
const fileStamp=details=>[details.dev,details.ino,details.size,details.mtimeNs,details.ctimeNs].join(':');
const active=p=>!p.removedAt&&!p.deletedAt;
const dates=value=>({createdAt:value.createdAt??null,updatedAt:value.updatedAt??null});
function summarize(collection,value){
  if(!value||typeof value.title!=='string'||!value.id)throw storeError(500,'Invalid discovery source document.');
  if(collection==='items')return {id:value.id,title:value.title,description:value.description||'',...dates(value),
    kind:value.content?.kind|| (value.childBoardId?'board':'idea'),childBoardId:value.childBoardId,
    archived:!!value.archivedAt,deleted:!!value.deletedAt,star:!!value.review?.star,
    state:value.build?.state,revisions:value.revisions?.length||0,...(value.content?{content:{kind:value.content.kind,...(value.content.resource?{resource:value.content.resource}:{}),...(value.content.url?{url:value.content.url}:{})}}:{}),...(value.preview?{preview:{...value.preview,...(value.preview.text?{text:value.preview.text.slice(0,240)}:{})}}:{})};
  if(!Array.isArray(value.placements))throw storeError(500,'Invalid discovery board document.');
  return {id:value.id,title:value.title,description:value.description||'',ownerItemId:value.ownerItemId,...dates(value),
    legacyBoardId:value.legacyBoardId||value.legacy?.boardId,roundCount:value.rounds?.length||0,...(value.cover?{cover:value.cover}:{}),
    reviewOrder:value.reviewOrder||[],placements:value.placements.filter(active).map(p=>({...p,archived:!!p.archivedAt}))};
}
async function confinedCache(root,{create=false}={}){
  const dir=cacheRoot(root);
  if(create)await mkdir(dir,{recursive:true});
  const details=await lstat(dir);
  if(!details.isDirectory()||details.isSymbolicLink()||!isInside(root,await realpath(dir)))throw storeError(403,'Discovery cache must stay inside workspace metadata.');
  if(create)try{await writeFile(path.join(dir,'.gitignore'),'*\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  return dir;
}
async function cacheRead(dir,name){
  const file=path.join(dir,name),details=await lstat(file);
  if(!details.isFile()||details.isSymbolicLink())throw storeError(403,'Discovery cache must be regular files.');
  const text=await readFile(file,'utf8');metrics.shardReads++;metrics.shardBytes+=Buffer.byteLength(text);return text;
}
async function cacheWrite(dir,name,source){
  const target=path.join(dir,name);
  try{if((await lstat(target)).isSymbolicLink())throw storeError(403,'Discovery cache cannot be symbolic links.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const temp=path.join(dir,`.${randomUUID()}.tmp`);
  await writeFile(temp,source,{flag:'wx',mode:0o600});await rename(temp,target);
  metrics.shardWrites++;metrics.shardWriteBytes+=Buffer.byteLength(source);
}
async function inventory(root){
  const result={items:{},boards:{}};
  for(const collection of ['items','boards']){
    const ids=await listStoreDocumentIds(root,collection);
    for(let offset=0;offset<ids.length;offset+=64){
      await Promise.all(ids.slice(offset,offset+64).map(async id=>{
        const details=await lstat(path.join(root,collection,`${id}.json`),{bigint:true});
        metrics.sourceStats++;
        if(!details.isFile()||details.isSymbolicLink())throw storeError(403,'Metadata must be regular files.');
        result[collection][id]=fileStamp(details);
      }));
    }
  }
  return result;
}
function sourceSignature(source){return hash(JSON.stringify(['items','boards'].map(c=>[c,Object.entries(source[c]).sort(([a],[b])=>compare(a,b))])));}
function indexRows(index){return ['items','boards'].flatMap(collection=>Object.values(index[collection]));}
async function readIndex(root,metadata,source){
  const dir=await confinedCache(root),manifest=JSON.parse(await cacheRead(dir,'manifest.json'));
  if(manifest.format!==FORMAT||manifest.workspaceId!==metadata.id||manifest.revision!==metadata.revision||manifest.sourceSignature!==sourceSignature(source)||!Array.isArray(manifest.shards)||manifest.shards.length!==BUCKETS*2)throw new Error('Stale discovery cache.');
  const index={items:{},boards:{}};
  for(const shard of manifest.shards){
    if(!['items','boards'].includes(shard.collection)||!Number.isInteger(shard.bucket)||shard.bucket<0||shard.bucket>=BUCKETS||shard.name!==`${shard.collection}-${shard.bucket}.json`)throw new Error('Invalid discovery shard.');
    const text=await cacheRead(dir,shard.name);
    if(hash(text)!==shard.digest)throw new Error('Corrupt discovery shard.');
    const rows=JSON.parse(text);
    if(!Array.isArray(rows))throw new Error('Invalid discovery shard.');
    for(const row of rows){assertId(row.id);if(bucket(row.id)!==shard.bucket||typeof row.title!=='string'||Object.hasOwn(index[shard.collection],row.id))throw new Error('Invalid discovery record.');index[shard.collection][row.id]=row;}
  }
  for(const collection of ['items','boards'])if(Object.keys(index[collection]).length!==Object.keys(source[collection]).length||Object.keys(source[collection]).some(id=>!Object.hasOwn(index[collection],id)))throw new Error('Incomplete discovery cache.');
  return {index,manifest};
}
async function writeIndex(root,metadata,index,source,{changed}={}){
  const dir=await confinedCache(root,{create:true}),shards=[];
  for(const collection of ['items','boards']){
    const grouped=Array.from({length:BUCKETS},()=>[]);
    for(const row of Object.values(index[collection]))grouped[bucket(row.id)].push(row);
    for(let number=0;number<BUCKETS;number++){
    const name=`${collection}-${number}.json`;
    const rows=grouped[number].sort((a,b)=>compare(a.id,b.id));
    const text=JSON.stringify(rows);
    if(!changed||changed.has(`${collection}-${number}`))await cacheWrite(dir,name,text);
    shards.push({collection,bucket:number,name,digest:hash(text),count:rows.length});
  }}
  const manifest={format:FORMAT,workspaceId:metadata.id,revision:metadata.revision,sourceSignature:sourceSignature(source),shards};
  await cacheWrite(dir,'manifest.json',JSON.stringify(manifest));
  return manifest;
}
async function buildIndex(root,metadata,source){
  metrics.rebuilds++;
  const index={items:{},boards:{}};
  for(const collection of ['items','boards']){
    const ids=Object.keys(source[collection]).sort(compare);
    for(let offset=0;offset<ids.length;offset+=32)await Promise.all(ids.slice(offset,offset+32).map(async id=>{index[collection][id]={...summarize(collection,await readStoreDocument(root,collection,id)),_sourceStamp:source[collection][id]};}));
  }
  await writeIndex(root,metadata,index,source);
  return index;
}
async function obtainIndex(root,metadata,{rebuild=false}={}){
  const source=await inventory(root);
  if(!rebuild){try{return {index:(await readIndex(root,metadata,source)).index,rebuilt:false};}catch(error){if(error.status===403)throw error;}}
  return {index:await buildIndex(root,metadata,source),rebuilt:true};
}
// Invoked under the canonical commit lock. Refresh only an existing valid cache;
// a failed or interrupted refresh leaves a stale manifest and rebuilds next read.
export async function refreshDiscoveryAfterCommit(root,before,after,{graphChanged=true}={}){
  if(!before?.metadata)return;
  let manifest;
  try{const dir=await confinedCache(root);manifest=JSON.parse(await cacheRead(dir,'manifest.json'));}catch{return;}
  if(manifest.format!==FORMAT||manifest.workspaceId!==before.metadata.id||manifest.revision!==before.metadata.revision)return;
  if(!graphChanged){
    if(!Array.isArray(manifest.shards)||manifest.shards.length!==BUCKETS*2||typeof manifest.sourceSignature!=='string')return;
    // No item/board bytes changed in this transaction. Keep source/shard checks
    // for the next query, but don't scan the whole graph for a thread reply.
    manifest.revision=after.metadata.revision;await cacheWrite(await confinedCache(root),'manifest.json',JSON.stringify(manifest));return;
  }
  // Read old shards using their digests, but compare the *new* source inventory
  // only after replacing touched summaries. No canonical content is copied here.
  const dir=await confinedCache(root),index={items:{},boards:{}};
  for(const shard of manifest.shards){
    if(!['items','boards'].includes(shard.collection)||shard.name!==`${shard.collection}-${shard.bucket}.json`)throw new Error('Invalid cache shard.');
    const text=await cacheRead(dir,shard.name);if(hash(text)!==shard.digest)throw new Error('Corrupt cache shard.');
    for(const row of JSON.parse(text))index[shard.collection][row.id]=row;
  }
  const changed=new Set(),source=await inventory(root);
  for(const collection of ['items','boards']){
    for(const id of Object.keys(index[collection]))if(!Object.hasOwn(source[collection],id)){delete index[collection][id];changed.add(`${collection}-${bucket(id)}`);}
    for(const [id,stamp] of Object.entries(source[collection])){
      if(index[collection][id]?._sourceStamp===stamp)continue;
      const value=after[collection]?.[id]||await readStoreDocument(root,collection,id);
      index[collection][id]={...summarize(collection,value),_sourceStamp:stamp};changed.add(`${collection}-${bucket(id)}`);
    }
  }
  await writeIndex(root,after.metadata,index,source,{changed});
}
function parseInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw storeError(400,'Provide discovery options.');
  const allowed=new Set(['query','kind','fields','withinBoardId','recursive','createdAfter','createdBefore','updatedAfter','updatedBefore','sort','direction','limit','cursor','includeArchived','includeDeleted','body']);
  if(Object.keys(input).some(key=>!allowed.has(key)))throw storeError(400,'Unknown discovery option.');
  const result={query:'',kind:'all',fields:['title','description'],recursive:true,sort:'updatedAt',direction:'desc',limit:25,includeArchived:false,includeDeleted:false,body:false,...input};
  if(typeof result.query!=='string'||result.query.length>2000||!['all','items','boards'].includes(result.kind)||!['updatedAt','createdAt','title'].includes(result.sort)||!['asc','desc'].includes(result.direction)||!Number.isInteger(result.limit)||result.limit<1||result.limit>100||!Array.isArray(result.fields)||result.fields.some(f=>!['title','description'].includes(f)))throw storeError(400,'Invalid discovery query.');
  for(const key of ['recursive','includeArchived','includeDeleted','body'])if(typeof result[key]!=='boolean')throw storeError(400,`Invalid ${key}.`);
  if(result.withinBoardId!==undefined)assertId(result.withinBoardId);
  for(const key of ['createdAfter','createdBefore','updatedAfter','updatedBefore'])if(result[key]!==undefined&&(typeof result[key]!=='string'||!Number.isFinite(Date.parse(result[key]))))throw storeError(400,'Date bounds must be ISO dates.');
  if(result.cursor!==undefined&&(typeof result.cursor!=='string'||result.cursor.length>2048))throw storeError(400,'Invalid discovery cursor.');
  return result;
}
function membership(index){
  const locations=new Map();
  for(const board of Object.values(index.boards))for(const p of board.placements){if(!locations.has(p.itemId))locations.set(p.itemId,[]);locations.get(p.itemId).push({boardId:board.id,placementId:p.id,archived:p.archived});}
  return locations;
}
function scoped(index,input){
  if(!input.withinBoardId)return null;
  if(!index.boards[input.withinBoardId])throw storeError(404,'Scope board not found.');
  const boards=new Set([input.withinBoardId]),items=new Set(),pending=[input.withinBoardId];
  while(pending.length){const board=index.boards[pending.pop()];for(const p of board.placements){const item=index.items[p.itemId];if(!item||(!input.includeDeleted&&item.deleted)||(!input.includeArchived&&(p.archived||item.archived)))continue;items.add(item.id);if(item.childBoardId&&index.boards[item.childBoardId]&&!boards.has(item.childBoardId)){boards.add(item.childBoardId);if(input.recursive)pending.push(item.childBoardId);}}}
  return {boards,items};
}
const time=value=>typeof value==='number'?value:Number.isFinite(Date.parse(value))?Date.parse(value):0;
function excerpt(value,max=240){return value.length>max?`${value.slice(0,max-1)}…`:value;}
export async function searchWorkspace(config,input={}){
  const query=parseInput(input);
  return withStore(config,async(root,state)=>{
    if(!state)return {enabled:false,revision:0,results:[],nextCursor:null};
    const {index,rebuilt}=await obtainIndex(root,state.metadata),scope=scoped(index,query),locations=membership(index);
    const fingerprint=hash(JSON.stringify({...query,cursor:undefined}));
    let offset=0;
    if(query.cursor){let cursor;try{cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());}catch{throw storeError(400,'Invalid discovery cursor.');}if(cursor.workspaceId!==state.metadata.id||cursor.revision!==state.metadata.revision||cursor.query!==fingerprint)throw storeError(409,'Discovery cursor is stale or belongs to another query.');if(!Number.isInteger(cursor.offset)||cursor.offset<0)throw storeError(400,'Invalid discovery cursor.');offset=cursor.offset;}
    const text=query.query.toLocaleLowerCase('en-US'),rows=[];
    for(const collection of ['items','boards']){
      if(query.kind!=='all'&&query.kind!==collection)continue;
      for(const row of Object.values(index[collection])){
        const owner=collection==='boards'?index.items[row.ownerItemId]:row;
        if(!query.includeDeleted&&owner?.deleted||!query.includeArchived&&owner?.archived)continue;
        if(scope&&!scope[collection].has(row.id))continue;
        if(['created','updated'].some(key=>query[`${key}After`]!==undefined&&time(row[`${key}At`])<time(query[`${key}After`])||query[`${key}Before`]!==undefined&&time(row[`${key}At`])>time(query[`${key}Before`])))continue;
        let haystack=query.fields.map(field=>row[field]||'').join('\n');
        if(query.body&&collection==='items'){const item=await readStoreDocument(root,'items',row.id);haystack+=`\n${item.review?.note||''}\n${item.content?.text||''}`;}
        if(text&&!haystack.toLocaleLowerCase('en-US').includes(text))continue;
        rows.push({collection,row});
      }
    }
    rows.sort((a,b)=>{const av=query.sort==='title'?a.row.title.toLocaleLowerCase('en-US'):time(a.row[query.sort]),bv=query.sort==='title'?b.row.title.toLocaleLowerCase('en-US'):time(b.row[query.sort]);return compare(av,bv)*(query.direction==='asc'?1:-1)||compare(a.row.id,b.row.id)||compare(a.collection,b.collection);});
    const results=rows.slice(offset,offset+query.limit).map(({collection,row})=>({type:collection==='items'?'item':'board',id:row.id,title:row.title,description:excerpt(row.description),createdAt:row.createdAt,updatedAt:row.updatedAt,
      ...(collection==='items'?{kind:row.kind,childBoardId:row.childBoardId,locations:(locations.get(row.id)||[]).slice(0,8),locationCount:locations.get(row.id)?.length||0,url:`/app/item.html?item=${encodeURIComponent(row.id)}`}:{ownerItemId:row.ownerItemId,url:`/boards/${encodeURIComponent(row.id)}/`})}));
    const next=offset+results.length;
    return {enabled:true,workspaceId:state.metadata.id,revision:state.metadata.revision,indexRebuilt:rebuilt,total:rows.length,results,nextCursor:next<rows.length?Buffer.from(JSON.stringify({workspaceId:state.metadata.id,revision:state.metadata.revision,query:fingerprint,offset:next})).toString('base64url'):null};
  },{metadataOnly:true});
}
export async function discoveryCatalog(config){
  return withStore(config,async(root,state)=>{if(!state)return null;const {index}=await obtainIndex(root,state.metadata);for(const collection of ['items','boards'])index[collection]=Object.fromEntries(Object.entries(index[collection]).sort(([a],[b])=>compare(a,b)));return {metadata:state.metadata,index};},{metadataOnly:true});
}
export async function rebuildDiscovery(config){
  return withStore(config,async(root,state)=>{if(!state)throw storeError(404,'Workspace not initialized.');const {index}=await obtainIndex(root,state.metadata,{rebuild:true});return {revision:state.metadata.revision,items:Object.keys(index.items).length,boards:Object.keys(index.boards).length,rebuilt:true};},{metadataOnly:true});
}
// Read-only inventory is deliberately independent of home/index membership and
// still useful when the workspace header itself cannot be parsed. Never repair it.
export async function inspectWorkspace(config){
  return withStore(config,async(root)=>{
    if(!root)return {enabled:false,valid:false,issues:['Workspace metadata is absent.'],counts:{items:0,boards:0,threads:0}};
    const report={enabled:true,valid:true,issues:[],counts:{items:0,boards:0,threads:0}};
    let metadata;const documents={items:{},boards:{}};
    try{metadata=JSON.parse(await readFile(path.join(root,'workspace.json'),'utf8'));if(metadata.schemaVersion!==2||!Number.isSafeInteger(metadata.revision)||!Array.isArray(metadata.homeBoardIds))throw new Error('Invalid workspace header.');report.revision=metadata.revision;}catch(error){report.issues.push(`workspace.json: ${error.message}`);}
    for(const collection of ['items','boards','threads']){
      let ids;try{ids=await listStoreDocumentIds(root,collection);}catch(error){report.issues.push(`${collection}: ${error.message}`);continue;}
      report.counts[collection]=ids.length;
      for(const id of ids){try{const value=await readStoreDocument(root,collection,id);if(documents[collection])documents[collection][id]=value;}catch(error){if(report.issues.length<100)report.issues.push(`${collection}/${id}.json: ${error.message}`);}}
    }
    if(!report.issues.length){try{(await import('./workspace.mjs')).validateWorkspaceState({metadata,...documents});}catch(error){report.issues.push(`Graph validation: ${error.message}`);}}
    report.valid=report.issues.length===0;report.scope='File parse/identity inventory and core graph validation. Thread semantics are validated by feedback reads.';return report;
  },{inventoryOnly:true});
}
