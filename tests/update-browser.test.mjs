// The browser's update routes (lib/update-browser.mjs): a read-only state, an
// install that starts `update now` detached (consent required for a major
// update, refused when updates are off, one at a time) and the CLI's own
// preferences. A fake spawn stands in for the detached process; a local release
// feed (TINKA_UPDATE_FEED) stands in for GitHub. No network is used.
import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {mkdtemp, realpath, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {buildRelease} from '../scripts/package.mjs';
import {installArchive} from '../scripts/install.mjs';
import {main} from '../lib/cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {updateContext, checkForUpdates, feedLatest} from '../lib/updates.mjs';
import {createUpdateService, installPaths} from '../lib/update-browser.mjs';
import {createAppServer, closeAppServer} from '../server.mjs';

const json = file => readFile(file, 'utf8').then(JSON.parse);
// The update on offer is the next patch after this source version, so the fixture holds across releases.
const NEXT = (({version}) => version.replace(/\d+$/, patch => String(Number(patch) + 1)))(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
let root, built, archive, shipped;
before(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tinka-update-browser-')));
  built = await buildRelease({outDir: path.join(root, 'release')});
  archive = {zipBytes: await readFile(built.appZip), checksumText: await readFile(built.appChecksum, 'utf8'), zipName: path.basename(built.appZip)};
  shipped = await json(new URL('../lib/update-compatibility.json', import.meta.url));
});
after(() => rm(root, {recursive: true, force: true}));

// An installed portable project on this source's version, with an update on offer.
async function fixture(t, offered = NEXT) {
  const project = await realpath(await mkdtemp(path.join(root, 'project-')));
  const app = path.join(project, 'tinka/app');
  await installArchive({...archive, installDir: app});
  await main(['project', 'init', '--project', project, '--label', 'Field Notes']);
  const config = await loadConfig(path.join(project, 'tinka/local/config.json'));
  const context = await updateContext(config, app);
  const spawned = [];
  const spawn = (command, args, options) => { spawned.push({command, args, options}); return {pid: process.pid, unref() {}, on() {}}; };
  const service = (options = {}) => createUpdateService(config, {app, spawn, ...options});
  const offer = async (version = offered, extra = {}) => writeFile(context.statePath, JSON.stringify({schemaVersion: 1, configPath: config.configPath, appPath: context.app, policy: 'notify', checkedAt: Date.now(), latest: {version, compatibility: {...shipped, version, fromVersions: [config.version]}}, ...extra}));
  await offer();
  const server = createAppServer(config, {updates: service()});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, headers = {}) => fetch(`${base}${route}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-tinka-workspace': config.workspaceId, ...headers}, body: JSON.stringify(body)}).then(async response => ({status: response.status, body: await response.json()}));
  const state = () => fetch(`${base}/api/update`).then(response => response.json());
  t.after(async () => { await closeAppServer(server); await rm(project, {recursive: true, force: true}); });
  return {project, app, config, context, spawned, service, offer, request, state, base};
}
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('the update state is read-only, carries no local paths and is empty for a source checkout', async t => {
  const f = await fixture(t);
  const view = await f.state();
  assert.equal(view.installed, true); assert.equal(view.version, f.config.version); assert.equal(view.policy, 'notify');
  assert.deepEqual(view.notice, {kind: 'compatible', version: NEXT, display: NEXT, major: false, reason: null, snoozed: false});
  assert.equal(view.latest.notes, `https://github.com/bladnman/tinka/releases/tag/v${NEXT}`);
  assert.equal(view.agentCommand, 'node tinka/app/cli.mjs update --config tinka/local/config.json'); assert.equal(view.pin, true);
  assert(!JSON.stringify(view).includes(f.project), 'No absolute project path is exposed');
  const source = await createUpdateService(f.config).view();
  assert.equal(source.installed, false); assert.equal(source.notice, null);
  await assert.rejects(createUpdateService(f.config).install({version: NEXT}), {status: 409});
  assert.equal((await fetch(`${f.base}/api/update/install`)).status, 405, 'Install is POST-only');
});

test('installs refuse cross-site requests the way other writes do', async t => {
  const f = await fixture(t);
  for (const headers of [{'x-tinka-workspace': 'other'}, {Origin: 'http://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}]) assert.equal((await f.request('/api/update/install', {version: NEXT}, headers)).status, 403);
  const plain = await fetch(`${f.base}/api/update/install`, {method: 'POST', headers: {'x-tinka-workspace': f.config.workspaceId}, body: JSON.stringify({version: NEXT})});
  assert.equal(plain.status, 415);
  assert.equal(f.spawned.length, 0);
});

test('a major update installs only with consent, and only the version the user saw', async t => {
  const f = await fixture(t, '2.0.0');
  const view = await f.state();
  assert.equal(view.notice.kind, 'major'); assert.equal(view.notice.display, '2.0');
  assert.equal((await f.request('/api/update/install', {version: '2.0.0'})).status, 400);
  assert.equal((await f.request('/api/update/install', {version: '2.0.0', consent: 'yes'})).status, 400);
  assert.equal((await f.request('/api/update/install', {version: '3.0.0', consent: 'major'})).status, 409);
  assert.equal(f.spawned.length, 0, 'Nothing starts without consent');
  const started = await f.request('/api/update/install', {version: '2.0.0', consent: 'major'});
  assert.equal(started.status, 202); assert.equal(started.body.install.state, 'running'); assert.equal(started.body.install.to, '2.0.0');
  const [{command, args, options}] = f.spawned;
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [path.join(f.context.app, 'cli.mjs'), 'update', 'now', '--major', '--to', '2.0.0', '--config', f.config.configPath]);
  assert.equal(options.detached, true); assert.equal(options.cwd, f.project);
  assert.equal(options.env.TINKA_OPERATION_TOKEN, undefined);
});

test('a compatible update sends no consent; policy off refuses; one install at a time', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/update/install', {version: NEXT, consent: 'major'})).status, 400);
  assert.equal((await f.request('/api/update/preference', {action: 'policy', policy: 'off'})).status, 200);
  const off = await f.state();
  assert.equal(off.policy, 'off'); assert.equal(off.notice, null); assert.equal(off.latest.version, NEXT);
  assert.equal((await f.request('/api/update/install', {version: NEXT})).status, 409);
  assert.equal(f.spawned.length, 0, 'No install while updates are off');
  await f.request('/api/update/preference', {action: 'policy', policy: 'notify'});
  const [first, second] = await Promise.all([f.request('/api/update/install', {version: NEXT}), f.request('/api/update/install', {version: NEXT})]);
  assert.deepEqual([first.status, second.status].sort(), [202, 409]);
  assert.equal(f.spawned.length, 1);
  assert.match([first, second].find(result => result.status === 409).body.error, /already running/);
  assert.equal((await f.state()).install.state, 'running');
  assert.equal((await f.request('/api/update/preference', {action: 'later'})).status, 409, 'Settings wait for the install');
  // The process ended without changing this server's version: the update failed.
  const paths = installPaths(f.context);
  await writeFile(paths.record, JSON.stringify({...await json(paths.record), pid: deadPid()}));
  await writeFile(paths.log, 'Tinka update failed. Download timed out.\nRetry explicitly: node cli.mjs update now\n');
  const failed = await f.state();
  assert.equal(failed.install.state, 'failed'); assert.equal(failed.install.reason, 'Download timed out.');
  assert.equal(failed.notice.kind, 'failed'); assert.equal(failed.notice.reason, 'Download timed out.');
  assert.equal((await f.request('/api/update/install', {version: NEXT})).status, 202, 'Try again starts a new install');
});

test('Later and the policy are the CLI settings; review cases never install from the browser', async t => {
  const f = await fixture(t);
  let result = await f.request('/api/update/preference', {action: 'later'});
  assert.equal(result.status, 200); assert.equal(result.body.notice.snoozed, true);
  assert.ok((await json(f.context.statePath)).snoozeUntil > Date.now());
  result = await f.request('/api/update/preference', {action: 'policy', policy: 'auto'});
  assert.equal(result.body.policy, 'auto'); assert.equal(result.body.notice.kind, 'deferred');
  assert.equal((await f.request('/api/update/preference', {action: 'policy', policy: 'sometimes'})).status, 400);
  await f.request('/api/update/preference', {action: 'policy', policy: 'notify'});
  await f.offer(NEXT, {latest: {version: NEXT, compatibility: {...shipped, version: NEXT, fromVersions: ['0.1.0']}}});
  let view = await f.service().view();
  assert.equal(view.notice.kind, 'review'); assert.match(view.notice.reason, /no explicit compatibility/);
  assert.equal((await f.request('/api/update/install', {version: NEXT})).status, 409);
  await f.offer();
  await writeFile(path.join(f.app, 'local-change.txt'), 'edited');
  view = await f.service().view();
  assert.equal(view.notice.kind, 'review'); assert.match(view.notice.reason, /local changes/);
  assert.equal((await f.request('/api/update/install', {version: NEXT})).status, 409);
  assert.equal(f.spawned.length, 0);
});

test('a local release feed stands in for GitHub; --to installs only the version on offer', async t => {
  const feed = path.join(root, 'feed'); await mkdir(feed, {recursive: true});
  const offered = await feedLatest(path.join(root, 'release'), '0.7.17');
  assert.equal(offered.version, built.version); assert.equal(offered.feed, true); assert.equal(offered.compatibility.archiveSha256, createHash('sha256').update(archive.zipBytes).digest('hex'));
  assert.deepEqual(await feedLatest(path.join(root, 'release'), built.version), {version: built.version});
  await assert.rejects(feedLatest(feed, '0.7.17'), /no Tinka release/);
  const project = await realpath(await mkdtemp(path.join(root, 'feed-project-')));
  t.after(() => rm(project, {recursive: true, force: true}));
  await main(['init', '--config', path.join(project, 'config.json'), '--boards', path.join(project, 'boards'), '--label', 'Feed']);
  const config = {...await loadConfig(path.join(project, 'config.json')), version: '0.7.17'};
  const context = {app: path.join(project, 'app'), pinPath: null, projectRoot: null, repo: 'bladnman/tinka', statePath: path.join(project, 'config.json.updates.json')};
  const previous = process.env.TINKA_UPDATE_FEED; process.env.TINKA_UPDATE_FEED = path.join(root, 'release');
  t.after(() => { if (previous === undefined) delete process.env.TINKA_UPDATE_FEED; else process.env.TINKA_UPDATE_FEED = previous; });
  let installed = null;
  const install = async options => { installed = options; return {version: built.version, backup: null}; };
  const skipped = await checkForUpdates(config, {context, explicit: true, expectVersion: '9.9.9', install});
  assert.match(skipped.message, /no longer the update on offer/); assert.equal(installed, null);
  const result = await checkForUpdates(config, {context, explicit: true, major: true, expectVersion: built.version, install});
  assert.equal(result.replaced, true, result.message);
  assert.deepEqual(installed.zipBytes, archive.zipBytes); assert.equal(installed.checksumText, archive.checksumText);
  const state = await json(context.statePath);
  assert.equal(state.latest.feed, true); assert(!JSON.stringify(state).includes(path.join(root, 'release')), 'Feed paths are not stored');
});
