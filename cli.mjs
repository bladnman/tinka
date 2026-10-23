#!/usr/bin/env node
// Acquire the app-copy lock before importing replaceable implementation modules.
// Keep this standalone lock identical to scripts/install.mjs (covered by tests).
import {mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export function operationLockPath(app) { return path.join(path.dirname(app), `.${path.basename(app)}.operation-lock`); }
export async function withAppLock(app, action, { token = process.env.TINKA_OPERATION_TOKEN, waitMs = 20000 } = {}) {
  app = await canonicalFuturePath(app);
  const lock = operationLockPath(app);
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  const identity = randomUUID();
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (owner && owner.token === token && processAlive(owner.pid)) return action(token);
      if (owner && Number.isSafeInteger(owner.pid) && !processAlive(owner.pid)) {
        // A recovery guard prevents two stale-owner cleaners deleting a successor.
        const guard = `${lock}.recovery`;
        try { await mkdir(guard); } catch (error) { throw new Error(`App operation recovery needs review: ${guard}`); }
        try {
          const current = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
          if (current.token === owner.token && !processAlive(current.pid)) await rm(lock, { recursive: true });
        } finally { await rm(guard, { recursive: true, force: true }); }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Another app operation is active or needs recovery: ${lock}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: identity }), { flag: 'wx' });
    return await action(identity);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function canonicalFuturePath(input){
  const absolute=path.resolve(input);
  try{return await realpath(absolute);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(absolute);if(parent===absolute)throw error;return path.join(await canonicalFuturePath(parent),path.basename(absolute));}
}


const appRoot=path.dirname(fileURLToPath(import.meta.url));
export async function main(args=process.argv.slice(2)) {
  return withAppLock(appRoot,async token=>{
    const implementation=await import('./lib/cli.mjs');
    return implementation.main(args,{lockToken:token});
  });
}
if(process.argv[1]&&await realpath(path.resolve(process.argv[1])).catch(()=>null)===fileURLToPath(import.meta.url)){
  try{process.stdout.write(`${await main()}\n`);}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
