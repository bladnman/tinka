// Internal metadata store. Every cooperating reader/writer takes this lock so
// interrupted multi-file commits are recovered before a snapshot is exposed.
import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isInside } from "./paths.mjs";
const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// Cache parsed bodies, never mutable caller state. File identity and timestamps
// are checked under the workspace lock, including after external file edits.
const documents = new Map();
let cachedBytes = 0;
const metrics = {documentReads:0,documentBytes:0,cacheHits:0,documentStats:0};
export function storeMetrics({reset=false}={}) {
  const result={...metrics,cachedDocuments:documents.size,cachedBytes};
  if(reset)for(const key of Object.keys(metrics))metrics[key]=0;
  return result;
}
export function clearDocumentCache() { documents.clear(); cachedBytes=0; }
async function documentJson(file,optional=false) {
  let details;
  try { details=await lstat(file,{bigint:true}); }
  catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  metrics.documentStats++;
  if(!details.isFile()||details.isSymbolicLink())throw storeError(403,'Metadata must be regular files.');
  const fingerprint=[details.dev,details.ino,details.size,details.mtimeNs,details.ctimeNs].join(':');
  const previous=documents.get(file);
  if(previous?.fingerprint===fingerprint){metrics.cacheHits++;return structuredClone(previous.value);}
  if(previous){cachedBytes-=previous.bytes;documents.delete(file);}
  const source=await readFile(file,'utf8');
  metrics.documentReads++;metrics.documentBytes+=Buffer.byteLength(source);
  const value=JSON.parse(source),bytes=Buffer.byteLength(source);
  if(bytes<=4_000_000){
    documents.set(file,{fingerprint,value,bytes});cachedBytes+=bytes;
    while(documents.size>512||cachedBytes>16_000_000){const key=documents.keys().next().value;cachedBytes-=documents.get(key).bytes;documents.delete(key);}
  }
  return structuredClone(value);
}

export function storeError(status, message) {
  const error = new Error(message);
  error.status = error.statusCode = status;
  return error;
}
export function workspaceRoot(config) {
  if (
    !config ||
    typeof config.boardsRoot !== "string" ||
    !path.isAbsolute(config.boardsRoot)
  )
    throw storeError(400, "An absolute boardsRoot is required.");
  const root = config.workspaceRoot || path.join(config.boardsRoot, ".tinka");
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw storeError(400, "workspaceRoot must be absolute.");
  const resolved = path.resolve(root);
  if (isInside(appRoot, resolved))
    throw storeError(403, "Workspace data must stay outside the application.");
  return resolved;
}
export function assertId(id) {
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) ||
    ["constructor", "prototype", "__proto__"].includes(id)
  )
    throw storeError(400, "Invalid metadata ID.");
  return id;
}
async function json(file, optional = false) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}
async function atomic(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
async function safeDirectory(root, relative) {
  const target = path.join(root, relative);
  await mkdir(target, { recursive: true });
  if (!isInside(root, await realpath(target)))
    throw storeError(403, "Metadata directory leaves workspace.");
  return target;
}
async function safeTarget(root, relative) {
  if (
    !/^(workspace\.json|(?:items|boards|threads)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json|migrations\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json)$/.test(
      relative,
    )
  )
    throw storeError(400, "Invalid transaction path.");
  await safeDirectory(root, path.dirname(relative));
  const target = path.join(root, relative);
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw storeError(403, "Metadata cannot be a symbolic link.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}
async function recover(root) {
  const pending = await json(path.join(root, "pending.json"), true);
  if (!pending) return;
  clearDocumentCache();
  if (
    pending.schemaVersion !== 1 ||
    !Array.isArray(pending.writes) ||
    pending.writes.length > 50000
  )
    throw storeError(500, "Invalid workspace recovery journal.");
  // Validate every path before applying any of the redo records.
  const targets = [];
  for (const write of pending.writes) {
    if (!write || !Object.hasOwn(write, "value"))
      throw storeError(500, "Invalid recovery record.");
    targets.push(await safeTarget(root, write.path));
  }
  for (let i = 0; i < pending.writes.length; i++)
    await atomic(targets[i], pending.writes[i].value);
  await rm(path.join(root, "pending.json"));
}
async function acquire(root) {
  const lock = path.join(root, ".mutation-lock");
  const deadline = Date.now() + 5000;
  const token = randomUUID();
  for (;;) {
    try {
      await mkdir(lock);
      await atomic(path.join(lock, "owner.json"), {
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      });
      return { lock, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = await json(path.join(lock, "owner.json"));
      } catch {}
      if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        let dead = false;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") dead = true;
        }
        if (dead) {
          // Serialize reclaimers, then recheck ownership. A second reclaimer
          // must never rename a live successor's newly acquired lock.
          const tombstone = path.join(root, `.dead-lock-${token}`);
          const guard = path.join(root, ".lock-recovery");
          let guarded = false,
            reclaimed = false;
          try {
            await mkdir(guard);
            guarded = true;
            const current = await json(path.join(lock, "owner.json"));
            if (current.token === owner.token) {
              await rename(lock, tombstone);
              await rm(tombstone, { recursive: true, force: true });
              reclaimed = true;
            }
          } catch (error) {
            if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
          } finally {
            if (guarded) await rm(guard, { recursive: true, force: true });
          }
          if (reclaimed) continue;
        }
      }
      if (Date.now() >= deadline)
        throw storeError(
          409,
          "Workspace is busy; lock ownership could not be released safely.",
        );
      await delay(25);
    }
  }
}
export async function withStore(
  config,
  action,
  { create = false, metadataOnly = false, inventoryOnly = false } = {},
) {
  const lexical = workspaceRoot(config);
  if (create) {
    // Resolve the nearest existing ancestor before mkdir too: a parent symlink
    // must not turn an apparently external new path into application data.
    let ancestor = lexical;
    for (;;) {
      try {
        const candidate = path.resolve(
          await realpath(ancestor),
          path.relative(ancestor, lexical),
        );
        if (isInside(appRoot, candidate))
          throw storeError(
            403,
            "Workspace data must stay outside the application.",
          );
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    await mkdir(lexical, { recursive: true });
  }
  let root;
  try {
    root = await realpath(lexical);
  } catch (error) {
    if (error.code === "ENOENT" && !create) return action(null, null);
    throw error;
  }
  if ((await lstat(lexical)).isSymbolicLink())
    throw storeError(403, "Workspace metadata root cannot be a symbolic link.");
  if (isInside(appRoot, root))
    throw storeError(403, "Workspace data must stay outside the application.");
  const owned = await acquire(root);
  try {
    await recover(root);
    return await action(root, inventoryOnly ? null : await load(root, { metadataOnly }));
  } finally {
    const owner = await json(path.join(owned.lock, "owner.json"), true);
    if (owner?.token === owned.token) await rm(owned.lock, { recursive: true });
  }
}
export async function listStoreDocumentIds(root,collection) {
  if(!['items','boards','threads'].includes(collection))throw storeError(400,'Invalid metadata collection.');
  let entries;
  try {
    const directory=path.join(root,collection),details=await lstat(directory);
    if(!details.isDirectory()||details.isSymbolicLink()||!isInside(root,await realpath(directory)))
      throw storeError(403,'Metadata directory leaves workspace.');
    entries=await readdir(directory,{withFileTypes:true});
  }
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  const ids=[];
  for(const entry of entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    if(!entry.name.endsWith('.json'))continue;
    const id=assertId(entry.name.slice(0,-5));
    if(!entry.isFile())throw storeError(403,'Metadata must be regular files.');
    ids.push(id);
  }
  return ids;
}
// Call only while withStore owns the workspace lock and has recovered its journal.
export async function readStoreDocument(root,collection,id,{optional=false}={}) {
  if(!['items','boards','threads'].includes(collection))throw storeError(400,'Invalid metadata collection.');
  assertId(id);
  let value;
  try { value=await documentJson(await safeTarget(root,`${collection}/${id}.json`),optional); }
  catch(error){if(error.code==='ENOENT')throw storeError(404,'Metadata document not found.');throw error;}
  if(value&&value.id!==id)throw storeError(500,'Metadata identity mismatch.');
  if(!value&&!optional)throw storeError(404,'Metadata document not found.');
  return value;
}
export async function readStoreCollection(root,collection) {
  const ids=await listStoreDocumentIds(root,collection),result={};
  // Bound parallel disk work while avoiding a serial syscall chain at scale.
  for(let offset=0;offset<ids.length;offset+=32)
    for(const value of await Promise.all(ids.slice(offset,offset+32).map(id=>readStoreDocument(root,collection,id))))result[value.id]=value;
  return result;
}
async function load(root, { metadataOnly = false } = {}) {
  const metadata = await json(await safeTarget(root, "workspace.json"), true);
  if (!metadata) return null;
  if (
    metadata.schemaVersion !== 2 ||
    !Number.isSafeInteger(metadata.revision) ||
    metadata.revision < 0 ||
    !metadata.resourceRoots ||
    typeof metadata.resourceRoots !== "object" ||
    Array.isArray(metadata.resourceRoots) ||
    !Array.isArray(metadata.homeBoardIds) ||
    !Array.isArray(metadata.recentOperations)
  )
    throw storeError(500, "Invalid workspace metadata.");
  try {
    assertId(metadata.id);
    for (const id of metadata.homeBoardIds) assertId(id);
    for (const [id, resource] of Object.entries(metadata.resourceRoots)) {
      assertId(id);
      if (
        !resource ||
        typeof resource.path !== "string" ||
        !resource.path ||
        path.isAbsolute(resource.path) ||
        resource.path.includes("\\") ||
        resource.path.includes("\0")
      )
        throw storeError(500, "Invalid workspace resource root.");
    }
  } catch {
    throw storeError(500, "Invalid workspace metadata.");
  }
  // Resource requests need only this header. Recovery still runs under the
  // same lock, while catalog documents remain the full-snapshot path's work.
  if (metadataOnly) return { metadata };
  return {
    metadata,
    items: await readStoreCollection(root,"items"),
    boards: await readStoreCollection(root,"boards"),
  };
}
export async function commitStore(root, before, after, extraWrites = []) {
  const writes = [...extraWrites];
  for (const name of ["items", "boards", "threads"])
    for (const [id, value] of Object.entries(after[name]||{}))
      if (JSON.stringify(value) !== JSON.stringify(before?.[name]?.[id]))
        writes.push({ path: `${name}/${assertId(id)}.json`, value });
  writes.push({ path: "workspace.json", value: after.metadata });
  const targets = [];
  for (const write of writes) targets.push(await safeTarget(root, write.path));
  await atomic(path.join(root, "pending.json"), {
    schemaVersion: 1,
    id: randomUUID(),
    writes,
  });
  for (let index = 0; index < writes.length; index++)
    await atomic(targets[index], writes[index].value);
  await rm(path.join(root, "pending.json"));
  // Discovery is disposable. Never turn a committed canonical write into a
  // reported failure because its optional cache could not be refreshed.
  try { await (await import('./discovery.mjs')).refreshDiscoveryAfterCommit(root,before,after,{graphChanged:writes.some(write=>/^(items|boards)\//.test(write.path))}); } catch {}
}

function operationIdentity(operation) {
  if(!operation||typeof operation!=='object'||Array.isArray(operation)||typeof operation.type!=='string')throw storeError(400,'Provide an operation object with type.');
  if(Buffer.byteLength(JSON.stringify(operation))>4_000_000)throw storeError(400,'Operation is too large.');
  if(operation.operationId!==undefined)assertId(operation.operationId);
  if(operation.expectedRevision!==undefined&&(!Number.isSafeInteger(operation.expectedRevision)||operation.expectedRevision<0))throw storeError(400,'Invalid expectedRevision.');
  const {expectedRevision,operationId,...payload}=operation;
  return {expectedRevision,operationId,fingerprint:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
}
export function rememberOperation(metadata,identity,response) {
  if(!identity.operationId)return;
  metadata.recentOperations=[...metadata.recentOperations,{operationId:identity.operationId,fingerprint:identity.fingerprint,response:structuredClone(response)}].slice(-64);
  while(metadata.recentOperations.length>1&&Buffer.byteLength(JSON.stringify(metadata))>2_000_000)metadata.recentOperations.shift();
  if(Buffer.byteLength(JSON.stringify(metadata))>2_000_000)throw storeError(400,'Workspace metadata is too large.');
}
// Scoped append/update transactions share graph revision, retry identity, locking
// and redo recovery. The owning feature validates its touched document semantics.
export async function withScopedTransaction(config,operation,action) {
  const identity=operationIdentity(operation);
  return withStore(config,async(root,state)=>{
    if(!state)throw storeError(404,'Initialize the workspace before adding feedback.');
    const before=state.metadata,metadata=structuredClone(before);
    const prior=identity.operationId&&metadata.recentOperations.find(entry=>entry.operationId===identity.operationId);
    if(prior){if(prior.fingerprint!==identity.fingerprint)throw storeError(409,'Operation ID was already used with different input.');return {...structuredClone(prior.response),replayed:true};}
    if(identity.expectedRevision!==undefined&&identity.expectedRevision!==metadata.revision)throw storeError(409,'Workspace revision changed. Reload before retrying.');
    const touched={items:{},threads:{}};
    const tx={metadata,read:(collection,id,options)=>readStoreDocument(root,collection,id,options),
      write(collection,id,value){if(!['items','threads'].includes(collection))throw storeError(400,'Unsupported scoped write.');assertId(id);if(!value||value.id!==id)throw storeError(400,'Metadata identity mismatch.');touched[collection][id]=structuredClone(value);}};
    const result=await action(tx);
    metadata.revision++;metadata.updatedAt=new Date().toISOString();
    const response={revision:metadata.revision,result};rememberOperation(metadata,identity,response);
    await commitStore(root,{metadata:before,items:{},boards:{},threads:{}},{metadata,boards:{},...touched});
    return response;
  },{metadataOnly:true});
}
