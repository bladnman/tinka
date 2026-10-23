import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {mkdtemp, realpath, mkdir, readFile, writeFile, rm, cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {buildRelease} from '../scripts/package.mjs';
import {installArchive, main as installMain, installationPristine, compatibilityError, withAppLock, operationLockPath} from '../scripts/install.mjs';
import {checkForUpdates, CHECK_INTERVAL, updateContext, loadUpdateState, updateCommand, publishedLatest} from '../lib/updates.mjs';
const exec = promisify(execFile);
const json = file => readFile(file, 'utf8').then(JSON.parse);
const node = process.execPath;
let root, release, archive, embedded;
before(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tinka-updates-')));
  release = await buildRelease({outDir: path.join(root, 'release')});
  archive = {zipBytes: await readFile(release.appZip), checksumText: await readFile(release.appChecksum, 'utf8'), zipName: path.basename(release.appZip)};
  embedded = await json(new URL('../lib/update-compatibility.json', import.meta.url));
});
after(() => rm(root, {recursive: true, force: true}));
async function fixture(t, portable = true) {
  const project = await realpath(await mkdtemp(path.join(root, 'project-')));
  const app = path.join(project, portable ? 'tinka/app' : '.tools/app');
  await installArchive({...archive, installDir: app});
  if (portable) await exec(node, [path.join(app, 'cli.mjs'), 'project', 'init', '--project', project, '--label', 'Fixture']);
  else await exec(node, [path.join(app, 'cli.mjs'), 'init', '--config', path.join(project, 'settings/a.json'), '--boards', path.join(project, 'boards'), '--label', 'Fixture']);
  const configPath = path.join(project, portable ? 'tinka/local/config.json' : 'settings/a.json');
  const config = {...await json(configPath), configPath, workspaceRoot: path.join(portable ? path.join(project, 'design/boards') : path.join(project, 'boards'), '.tinka'), version: '0.5.15'};
  const context = await updateContext(config, app);
  // A deterministic prior-version fixture, with a valid per-file receipt.
  const packagePath = path.join(app, 'package.json');
  await writeFile(packagePath, JSON.stringify({...await json(packagePath), version: '0.5.15'}));
  const receiptPath = path.join(app, 'INSTALLATION.json');
  const receipt = await json(receiptPath); receipt.version = '0.5.15';
  receipt.files['package.json'] = createHash('sha256').update(await readFile(packagePath)).digest('hex');
  await writeFile(receiptPath, JSON.stringify(receipt));
  if (context.pinPath) await writeFile(context.pinPath, JSON.stringify({...await json(context.pinPath), version: '0.5.15'}));
  t.after(async () => {
    await exec(node, [path.join(app, 'cli.mjs'), 'stop', '--config', configPath]).catch(() => {});
    await rm(project, {recursive: true, force: true});
  });
  return {project, app, config, context};
}
const latest = () => ({version: '0.5.17', compatibility: {...embedded, archiveSha256: createHash('sha256').update(archive.zipBytes).digest('hex')}});
const source = async () => ({...archive, compatibility: embedded});
async function policy(f, value) { await updateCommand(f.config, 'policy', value, {context: f.context}); }

test('daily attempts include failures; reminders occur once per release with explicit snooze', async t => {
  const f = await fixture(t); let calls = 0;
  const fetchLatest = async () => {calls++; return latest();};
  const check = now => checkForUpdates(f.config, {context: f.context, now, fetchLatest});
  assert.match((await check(1000)).message, /Update now:.*\nLater.*\nAlways install/);
  assert.equal((await check(1001)).message, ''); assert.equal(calls, 1);
  assert.equal((await check(1000 + CHECK_INTERVAL)).message, ''); assert.equal(calls, 2);
  await updateCommand(f.config, 'later', null, {context: f.context});
  const state = await json(f.context.statePath);
  assert.equal((await check(state.snoozeUntil - 1)).message, '');
  assert.match((await check(state.snoozeUntil)).message, /available/);
  await policy(f, 'off');
  await check(state.snoozeUntil + CHECK_INTERVAL * 2); assert.equal(calls, 3);
  await policy(f, 'notify');
  let failures = 0;
  const failing = () => checkForUpdates(f.config, {context: f.context, now: state.snoozeUntil + CHECK_INTERVAL * 3, fetchLatest: async () => {failures++; throw new Error('offline');}});
  await failing(); await failing(); assert.equal(failures, 1);
  assert.equal((await json(f.context.statePath)).checkError, 'Latest release check unavailable.');
});

test('forced check never downloads, attempts installation, or suppresses a later automatic update', async t => {
  const f = await fixture(t); await policy(f, 'auto'); let downloads = 0;
  await updateCommand(f.config, 'check', null, {context: f.context, fetchLatest: async () => latest(), downloadRelease: async () => {downloads++; return source();}});
  assert.equal(downloads, 0); assert.equal((await json(f.context.statePath)).attemptedVersion, undefined);
  const result = await withAppLock(f.app, lockToken => checkForUpdates(f.config, {context: f.context, fetchLatest: async () => latest(), downloadRelease: source, lockToken}));
  assert.equal(result.replaced, true);
});

test('compatibility requires explicit starting version, stable same major, runtime, schema and no migration', () => {
  const options = {fromVersion: '0.5.15', toVersion: '0.5.17', nodeVersion: '22.0.0', platform: 'linux'};
  assert.equal(compatibilityError(embedded, options), null);
  for (const [metadata, override] of [
    [null, {}], [{...embedded, fromVersions: []}, {}], [{...embedded, migration: 'apply'}, {}],
    [embedded, {toVersion: '1.0.0'}], [embedded, {fromVersion: '0.5.15-beta'}],
    [embedded, {nodeVersion: '20.0.0'}], [embedded, {platform: 'win32'}], [embedded, {workspaceSchema: 3}],
    [{...embedded, schemas: {config: [], workspace: [1, 2]}}, {}], [{...embedded, runtime: {node: '*', platforms: ['linux']}}, {}],
    [{...embedded,schemas:{config:'1',workspace:'12'}},{}], [{...embedded,schemas:{config:[1,'2'],workspace:[1,2]}},{}],
    [{...embedded,runtime:{node:['>=22'],platforms:['linux']}},{}], [{...embedded,runtime:{node:'>=22',platforms:'linux'}},{}], [{...embedded,runtime:{node:'>=22',platforms:['linux',42]}},{}]
  ]) assert(compatibilityError(metadata, {...options, ...override}));
});

test('healthy automatic replacement verifies app, updates only pin after health and preserves project material', async t => {
  const f = await fixture(t);
  const configBefore = await readFile(f.config.configPath);
  const guide = path.join(f.project, 'TINKA.md'), setup = path.join(f.project, 'tinka/setup.mjs');
  await writeFile(guide, 'Custom project instructions\n'); await writeFile(setup, '// Custom setup\n');
  const notes = path.join(f.config.boardsRoot, 'private-notes.txt'); await writeFile(notes, 'Keep IDs and notes');
  await policy(f, 'auto');
  const result = await withAppLock(f.app, lockToken => checkForUpdates(f.config, {context: f.context, fetchLatest: async () => latest(), downloadRelease: source, lockToken}));
  assert(result.replaced); assert.match(result.message, /Review and commit/);
  assert.equal((await json(f.context.pinPath)).version, '0.5.17');
  assert.equal((await json(path.join(f.app, 'package.json'))).version, '0.5.17');
  assert(await installationPristine(f.app)); assert.deepEqual(await readFile(f.config.configPath), configBefore);
  assert.equal(await readFile(notes, 'utf8'), 'Keep IDs and notes');
  assert.equal(await readFile(guide, 'utf8'), 'Custom project instructions\n'); assert.equal(await readFile(setup, 'utf8'), '// Custom setup\n');
  await assert.rejects(readFile(`${f.config.configPath}.pid.json`), {code: 'ENOENT'});
});

test('modified or legacy-receipt apps never auto replace; explicit bootstrap notice also works on latest', async t => {
  const f = await fixture(t); await policy(f, 'auto'); let downloads = 0;
  await writeFile(path.join(f.app, 'custom.txt'), 'local overlay'); assert.equal(await installationPristine(f.app), false);
  let result = await checkForUpdates(f.config, {context: f.context, fetchLatest: async () => latest(), downloadRelease: async () => {downloads++; return source();}});
  assert.match(result.message, /current standalone.*--version '0.5.15'/); assert.equal(downloads, 0);
  await rm(path.join(f.app, 'custom.txt'));
  const receipt = path.join(f.app, 'INSTALLATION.json'); await writeFile(receipt, JSON.stringify({version: '0.5.15', sha256: 'old-receipt'}));
  assert.equal(await installationPristine(f.app), false);
  f.config.version = '0.5.17';
  result = await checkForUpdates(f.config, {context: f.context, fetchLatest: async () => latest(), downloadRelease: async () => {downloads++; return source();}});
  assert.match(result.message, /--version '0.5.17'/); assert.equal(downloads, 0);
  await assert.rejects(installArchive({...archive, installDir: f.app, configPath: f.config.configPath, requirePristine: true}), /modified or lacks/);
});

test('already-running start checks offline once, returns verified existing URL and leaves process intact', async t => {
  const f = await fixture(t);
  const cli = path.join(f.app, 'cli.mjs');
  const first = await exec(node, [cli, 'start', '--config', f.config.configPath], {env:{...process.env,TINKA_SKIP_UPDATE:'1',TINKA_OPERATION_TOKEN:'stale-token'}});
  assert.match(first.stdout, /started on/);
  const before = await json(`${f.config.configPath}.pid.json`);
  const second = await exec(node, [cli, 'start', '--config', f.config.configPath]);
  assert.match(second.stdout, /already running on/);
  assert.deepEqual(await json(`${f.config.configPath}.pid.json`), before);
  const cached = await json(f.context.statePath);
  assert.match(cached.checkError, /unavailable/); assert.equal((await json(f.context.statePath)).checkedAt, cached.checkedAt);
  await writeFile(`${f.config.configPath}.pid.json`, JSON.stringify({...before, token: '00000000-0000-0000-0000-000000000000'}));
  await assert.rejects(exec(node, [cli, 'start', '--config', f.config.configPath]), /unverified/);
  await writeFile(`${f.config.configPath}.pid.json`, JSON.stringify(before));
});

test('automatic updates defer running boards and failed downloads are not retried on later starts', async t => {
  const f = await fixture(t); await policy(f, 'auto'); let downloads = 0;
  const options = {context: f.context, fetchLatest: async () => latest(), downloadRelease: async () => {downloads++; throw new Error('fixture download failed');}};
  assert.match((await checkForUpdates(f.config, {...options, running: true})).message, /deferred/); assert.equal(downloads, 0);
  assert.match((await checkForUpdates(f.config, options)).message, /update failed/); assert.equal(downloads, 1);
  await checkForUpdates(f.config, options); assert.equal(downloads, 1);
  await checkForUpdates(f.config, {...options, explicit: true}); assert.equal(downloads, 2);
});

test('automatic install honors an explicit snooze; update now overrides it', async t => {
  const f=await fixture(t); await policy(f,'auto');
  await updateCommand(f.config,'later',null,{context:f.context});
  let downloads=0;
  const options={context:f.context,fetchLatest:async()=>latest(),downloadRelease:async()=>{downloads++;return source();},install:async()=>({version:'0.5.17'})};
  await checkForUpdates(f.config,options); assert.equal(downloads,0);
  await checkForUpdates(f.config,{...options,explicit:true}); assert.equal(downloads,1);
});

test('start rejects a stale running workspace identity after external config changes',async t=>{
  const f=await fixture(t); const cli=path.join(f.app,'cli.mjs');
  await exec(node,[cli,'start','--config',f.config.configPath]);
  const original=await readFile(f.config.configPath);
  await writeFile(f.config.configPath,JSON.stringify({...await json(f.config.configPath),workspaceRoot:path.join(f.project,'different-metadata')}));
  try{await assert.rejects(exec(node,[cli,'start','--config',f.config.configPath]),/health identity/);}
  finally{await writeFile(f.config.configPath,original);}
});

test('per-app lock excludes replacement/start and reclaims only a provably dead owner', async t => {
  const f = await fixture(t); let enter;
  const entered = new Promise(resolve => {enter = resolve;}); let releaseLock;
  const holding = withAppLock(f.app, async () => {enter(); await new Promise(resolve => {releaseLock = resolve;});});
  await entered;
  await assert.rejects(withAppLock(f.app, async () => {}, {waitMs: 0}), /Another app operation/);
  releaseLock(); await holding;
  const lock = operationLockPath(f.app);
  await mkdir(lock); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid: 2147483647, token: 'dead'}));
  assert.equal(await withAppLock(f.app, async () => 'recovered'), 'recovered');
  await mkdir(lock);
  await assert.rejects(withAppLock(f.app, async () => {}, {waitMs: 0}), /needs recovery/);
  await rm(lock, {recursive: true});
});

test('CLI waits for replacement lock before importing app implementation',async t=>{
  const f=await fixture(t); const implementation=path.join(f.app,'lib/cli.mjs');
  const original=await readFile(implementation); let pending;
  await withAppLock(f.app,async()=>{
    await writeFile(implementation,"throw new Error('half-written implementation must not load');");
    pending=exec(node,[path.join(f.app,'cli.mjs'),'start','--config',f.config.configPath]);
    // Give the launched bootstrap a bounded chance to reach the held lock.
    await new Promise(resolve=>setTimeout(resolve,100));
    await writeFile(implementation,original);
  });
  assert.match((await pending).stdout,/started on/);
});

test('standalone bootstrap and installer use exactly the same cooperating lock',async()=>{
  const bootstrap=await readFile(new URL('../cli.mjs',import.meta.url),'utf8');
  const installer=await readFile(new URL('../scripts/install.mjs',import.meta.url),'utf8');
  const section=text=>text.slice(text.indexOf('function processAlive'),text.indexOf('export async function installationPristine')<0?text.indexOf('async function canonicalFuturePath'):text.indexOf('export async function installationPristine'));
  assert.equal(section(bootstrap),section(installer));
});

test('manual and dotfolder configs keep distinct state and no portable pin is inferred', async t => {
  const f = await fixture(t, false);
  const otherPath = path.join(path.dirname(f.config.configPath), 'b.json'); await writeFile(otherPath, JSON.stringify(f.config));
  const other = {...f.config, configPath: otherPath}; const otherContext = await updateContext(other, f.app);
  assert.equal(f.context.pinPath, null); assert.notEqual(f.context.statePath, otherContext.statePath);
  await policy(f, 'off'); assert.equal((await loadUpdateState(otherContext, other)).policy, 'notify');
  const separate = await fixture(t); assert.equal((await loadUpdateState(separate.context, separate.config)).policy, 'notify');
});

test('package metadata mismatch rejects before touching app or pin', async t => {
  const f = await fixture(t);
  const pin = await readFile(f.context.pinPath);
  await assert.rejects(installArchive({...archive, installDir: f.app, configPath: f.config.configPath, compatibility: {...embedded, migration: 'unknown'}, fromVersion: '0.5.15', pinPath: f.context.pinPath}), /does not match/);
  assert.equal((await json(path.join(f.app, 'package.json'))).version, '0.5.15'); assert.deepEqual(await readFile(f.context.pinPath), pin);
});

test('published metadata is data-only, current version uses one request, archive binding is enforced',async t=>{
  const f=await fixture(t); const originalFetch=globalThis.fetch; const calls=[]; let badDigest=true;
  const asset=id=>`https://api.github.com/repos/bladnman/tinka/releases/assets/${id}`;
  const assets=[{name:archive.zipName,url:asset(1)},{name:`${archive.zipName}.sha256`,url:asset(2)},{name:'tinka-v0.5.17.compatibility.json',url:asset(3)}];
  globalThis.fetch=async(input,options)=>{
    const url=String(input); if(!url.startsWith('https://api.github.com/'))return originalFetch(input,options);
    calls.push(url);
    if(url.endsWith('/latest'))return new Response(JSON.stringify({tag_name:'v0.5.17',assets,body:'Untrusted prose is ignored.'}));
    if(url===asset(1))return new Response(archive.zipBytes);
    if(url===asset(2))return new Response(archive.checksumText);
    if(url===asset(3))return new Response(JSON.stringify({...embedded,archiveSha256:badDigest?'0'.repeat(64):createHash('sha256').update(archive.zipBytes).digest('hex')}));
    throw new Error('Unexpected test URL');
  };
  try{
    assert.deepEqual(await publishedLatest('bladnman/tinka','0.5.17'),{version:'0.5.17'}); assert.equal(calls.length,1);
    const failed=await withAppLock(f.app,lockToken=>checkForUpdates(f.config,{context:f.context,explicit:true,lockToken}));
    assert.match(failed.message,/does not match the downloaded package/);
    assert.equal((await json(path.join(f.app,'package.json'))).version,'0.5.15');
    badDigest=false;
    const result=await withAppLock(f.app,lockToken=>checkForUpdates(f.config,{context:f.context,explicit:true,lockToken}));
    assert(result.replaced); assert.equal((await json(f.context.pinPath)).version,'0.5.17');
  }finally{globalThis.fetch=originalFetch;}
});

test('unresponsive latest endpoint has a bounded check timeout',async()=>{
  const server=createServer(()=>{}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(_input,options)=>originalFetch(`http://127.0.0.1:${server.address().port}/`,options);
  const started=Date.now();
  try{await assert.rejects(publishedLatest('bladnman/tinka','0.5.15'));assert(Date.now()-started<3500);}
  finally{globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('failed candidate health rolls back app, exact config and pin; a prior owned service recovers', async t => {
  const f = await fixture(t);
  const broken = path.join(f.project, 'broken-source');
  await mkdir(broken);
  for (const file of ['README.md','AGENTS.md','IMPLEMENTATION_CONTRACT.md','package.json','cli.mjs','server.mjs','public','lib','docs','examples','scripts','skill']) await cp(path.resolve(file), path.join(broken, file), {recursive: true});
  const server = path.join(broken, 'server.mjs');
  await writeFile(server, (await readFile(server, 'utf8')).replace("app:'board-room'", "app:'broken-health'"));
  // Health route's literal identity is changed; candidate still binds successfully.
  assert((await readFile(server, 'utf8')).includes("app:'broken-health'"));
  const {stdout} = await exec(node, [path.join(broken, 'scripts/package.mjs'), '--out', path.join(f.project, 'broken-release')]);
  const bad = JSON.parse(stdout);
  const sourceBad = {zipBytes: await readFile(bad.appZip), checksumText: await readFile(bad.appChecksum, 'utf8'), zipName: path.basename(bad.appZip)};
  const configBefore = await readFile(f.config.configPath), pinBefore = await readFile(f.context.pinPath);
  await assert.rejects(installArchive({...sourceBad, installDir: f.app, configPath: f.config.configPath, pinPath: f.context.pinPath}), /health identity/);
  assert.equal((await json(path.join(f.app, 'package.json'))).version, '0.5.15');
  assert.deepEqual(await readFile(f.config.configPath), configBefore); assert.deepEqual(await readFile(f.context.pinPath), pinBefore);
  // A checked-out portable project can lack local config entirely. Its pin
  // still must survive a broken candidate's failed health verification.
  await rm(path.join(f.project,'tinka/local'),{recursive:true});
  await assert.rejects(installMain(['--project',f.project,'--version','0.5.17','--zip',bad.appZip,'--checksum',bad.appChecksum]),/health identity/);
  assert.deepEqual(await readFile(f.context.pinPath),pinBefore);
  assert.equal((await json(path.join(f.app,'package.json'))).version,'0.5.15');
  const cli = path.join(f.app, 'cli.mjs');
  await exec(node, [cli, 'start', '--config', f.config.configPath]);
  const prior = await json(`${f.config.configPath}.pid.json`);
  await assert.rejects(installArchive({...sourceBad, installDir: f.app, configPath: f.config.configPath, pinPath: f.context.pinPath}), /health identity/);
  const restored = await json(`${f.config.configPath}.pid.json`);
  assert.notEqual(restored.pid, prior.pid);
  const health = await fetch(`${restored.url}api/health`).then(response => response.json());
  assert.equal(health.version, '0.5.15'); assert.equal(health.configPath, f.config.configPath);
});
