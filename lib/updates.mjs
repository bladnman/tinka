import {readFile, realpath, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DEFAULT_REPO, atomicText, compatibilityError, fetchLimited, installArchive, installationPristine, verifyInstalledHealth} from '../scripts/install.mjs';
import {readRuntime, ownedProcess} from './runtime.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const checkTimeout = 1800;
const stable = /^\d+\.\d+\.\d+$/;
const json = file => readFile(file, 'utf8').then(JSON.parse);
async function optional(file) { try { return await json(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

// Only the exact portable app/config pair owns the project pin. Other layouts
// keep state beside their explicit config, uniquely named for that config.
export async function updateContext(config, app = appRoot) {
  app = await realpath(app);
  const directory = path.dirname(app);
  let pinPath = null, project = null;
  if (path.basename(app) === 'app' && config.configPath === path.join(directory, 'local/config.json')) {
    const candidate = await optional(path.join(directory, 'project.json'));
    if (candidate?.schemaVersion === 1 && typeof candidate.boards === 'string' && !path.isAbsolute(candidate.boards) && candidate.projectLabel === config.projectLabel && await realpath(path.resolve(directory, '..', candidate.boards)).catch(() => null) === config.boardsRoot) {
      pinPath = path.join(directory, 'project.json'); project = candidate;
    }
  }
  return {app, pinPath, repo: project?.repo || DEFAULT_REPO, statePath: pinPath ? path.join(directory, 'local/updates.json') : `${config.configPath}.updates.json`};
}
export async function loadUpdateState(context, config) {
  const state = await optional(context.statePath);
  if (state && (state.schemaVersion !== 1 || state.configPath !== config.configPath || state.appPath !== context.app || !['notify', 'auto', 'off'].includes(state.policy))) throw new Error(`Update state needs review: ${context.statePath}`);
  return state || {schemaVersion: 1, configPath: config.configPath, appPath: context.app, policy: 'notify'};
}
async function save(context, state) {
  await mkdir(path.dirname(context.statePath), {recursive: true});
  await atomicText(context.statePath, `${JSON.stringify(state, null, 2)}\n`);
}
function newer(a, b) {
  if (!stable.test(a) || !stable.test(b)) return false;
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] > right[i]; }
  return false;
}
function assetURL(asset, repo) {
  const url = new URL(asset?.url);
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.username || url.password || !url.pathname.toLowerCase().startsWith(`/repos/${repo.toLowerCase()}/releases/assets/`) || !/^\d+$/.test(url.pathname.split('/').at(-1))) throw new Error('Unexpected release asset URL.');
  return url.href;
}
function headers(accept = 'application/vnd.github+json') {
  return {'Accept': accept, 'User-Agent': 'tinka-updater', ...(process.env.GITHUB_TOKEN ? {Authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {})};
}
export async function publishedLatest(repo, currentVersion) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(value => ['.', '..'].includes(value))) throw new Error('Invalid release repository.');
  const deadline = Date.now() + checkTimeout;
  const get = (url, limit, accept) => fetchLimited(url, headers(accept), limit, Math.max(1, deadline - Date.now()));
  const release = JSON.parse((await get(`https://api.github.com/repos/${repo}/releases/latest`, 1024 * 1024)).toString('utf8'));
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (release.draft || release.prerelease || !stable.test(version)) throw new Error('Latest release is not a stable supported version.');
  if (currentVersion && !newer(version,currentVersion)) return {version};
  const names = [`tinka-v${version}.zip`, `tinka-v${version}.zip.sha256`, `tinka-v${version}.compatibility.json`];
  const assets = names.map(name => release.assets?.find(asset => asset.name === name));
  // A release without compatibility can still be announced, but never installed
  // by the updater. The ordinary deliberate installer remains available.
  if (!assets[0] || !assets[1] || !assets[2]) return {version, review: 'Release lacks machine-readable compatibility; review the release and use the standalone installer.'};
  const compatibility = JSON.parse((await get(assetURL(assets[2], repo), 16384, 'application/octet-stream')).toString('utf8'));
  return {version, compatibility, zipName: names[0], zipURL: assetURL(assets[0], repo), checksumURL: assetURL(assets[1], repo)};
}
async function download(release) {
  // Bounded installation download; failures are remembered per release.
  const [zipBytes, sidecar] = await Promise.all([
    fetchLimited(release.zipURL, headers('application/octet-stream'), 100 * 1024 * 1024, 15000),
    fetchLimited(release.checksumURL, headers('application/octet-stream'), 1024, 15000)
  ]);
  const digest = createHash('sha256').update(zipBytes).digest('hex');
  if (release.compatibility.archiveSha256 !== digest) throw new Error('Compatibility asset does not match the downloaded package.');
  const {archiveSha256, ...embedded} = release.compatibility;
  return {zipBytes, checksumText: sidecar.toString('utf8'), zipName: release.zipName, compatibility: embedded};
}
async function workspaceSchema(config) {
  return (await optional(path.join(config.workspaceRoot, 'workspace.json')))?.schemaVersion ?? 1;
}
function shellQuote(value) { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function commands(context, config) {
  return `node ${shellQuote(path.join(context.app, 'cli.mjs'))} update --config ${shellQuote(config.configPath)}`;
}
function bootstrap(context, config) {
  return `Automatic updates need an unmodified installation with a file baseline. Review local app changes, then use the current standalone tinka-install.mjs: node /absolute/tinka-install.mjs --install-dir ${shellQuote(context.app)} --config ${shellQuote(config.configPath)} --version ${shellQuote(config.version)}. Existing setup.mjs and TINKA.md are preserved.`;
}
function notice(context, config, state, reason = '') {
  const command = commands(context, config);
  return `Tinka update ${state.latest.version} available (installed ${config.version}).${reason ? ` ${reason}` : ''}\nUpdate now: ${command} now\nLater (24h): ${command} later\nAlways install compatible updates: ${command} policy auto\nNotify: ${command} policy notify\nOff: ${command} policy off`;
}
export async function runningInstance(config, app = appRoot) {
  const prior = await readRuntime(config);
  if (!prior) return null;
  let alive = false;
  try { process.kill(prior.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
  if (!alive) return null;
  if (prior.state !== 'ready' || !await ownedProcess(prior, config)) throw new Error('This config has an unverified running/starting process. No process was changed.');
  const record = await verifyInstalledHealth(app, config.configPath, config.version);
  return record;
}

// Called under this app's operation lock. Injectable I/O keeps tests offline.
export async function checkForUpdates(config, {context, now = Date.now(), fetchLatest = publishedLatest, downloadRelease = download, install = installArchive, lockToken, explicit = false, force = false, running = false} = {}) {
  context ||= await updateContext(config);
  const state = await loadUpdateState(context, config);
  if (!explicit && !force && state.policy === 'off') return {message: '', replaced: false};
  if (explicit || force || !state.checkedAt || now - state.checkedAt >= CHECK_INTERVAL) {
    state.checkedAt = now; delete state.checkError;
    // Persist attempts before I/O, including offline attempts and crashes.
    await save(context, state);
    try { state.latest = await fetchLatest(context.repo,config.version); }
    catch { state.checkError = 'Latest release check unavailable.'; }
    await save(context, state);
  }
  const release = state.latest;
  if(!explicit && state.policy==='auto' && state.baselineNotifiedVersion!==config.version && !await installationPristine(context.app)){
    state.baselineNotifiedVersion=config.version; await save(context,state);
    return {message:bootstrap(context,config),replaced:false};
  }
  if (!release || !newer(release.version, config.version)) return {message: explicit ? state.checkError || 'Tinka is up to date.' : '', replaced: false};
  const reason = release.review || compatibilityError(release.compatibility, {fromVersion: config.version, toVersion: release.version, workspaceSchema: await workspaceSchema(config)});
  const attempted = state.attemptedVersion === release.version;
  const wantsInstall = explicit || !force && state.policy === 'auto' && !running && !attempted && !(state.snoozeUntil && now < state.snoozeUntil);
  if (wantsInstall && !reason) {
    const pristine = await installationPristine(context.app);
    if (!pristine && !explicit) return notify(bootstrap(context,config));
    state.attemptedVersion = release.version;
    await save(context, state);
    try {
      const source = await downloadRelease(release);
      const result = await install({...source, installDir: context.app, configPath: config.configPath, compatibility: source.compatibility, fromVersion: config.version, requirePristine: !explicit, pinPath: context.pinPath, lockToken});
      state.installedVersion = result.version; delete state.installError;
      await save(context, state);
      return {message: `Updated Tinka to ${result.version}.${result.backup ? ` Backup: ${result.backup}.` : ''}${context.pinPath ? ' Review and commit tinka/project.json.' : ''}`, replaced: true};
    } catch (error) {
      state.installError = error.message; await save(context, state);
      return {message: `Tinka update failed. ${error.message}\nRetry explicitly: ${commands(context, config)} now`, replaced: false};
    }
  }
  if (explicit && reason) return {message: notice(context, config, state, reason), replaced: false};
  return notify(reason || (state.policy === 'auto' && running ? 'Automatic install deferred until the next stopped start.' : attempted && state.installError ? 'Previous install failed; use update now to retry after review.' : ''));
  async function notify(reason) {
    if (state.snoozeUntil && now < state.snoozeUntil) return {message: '', replaced: false};
    if (state.notifiedVersion === release.version && !state.snoozeUntil) return {message: '', replaced: false};
    state.notifiedVersion = release.version; delete state.snoozeUntil;
    await save(context, state);
    return {message: notice(context, config, state, reason), replaced: false};
  }
}
export async function updateCommand(config, action, value, options = {}) {
  const context = options.context || await updateContext(config);
  if (action === 'now' || action === 'check') return checkForUpdates(config, {...options, context, explicit: action==='now', force: action==='check'});
  const state = await loadUpdateState(context, config);
  if (action === 'policy') {
    if (!['notify', 'auto', 'off'].includes(value)) throw new Error('Choose update policy notify, auto or off.');
    state.policy = value;
  } else if (action === 'later') state.snoozeUntil = Date.now() + CHECK_INTERVAL;
  else if (action !== 'status') throw new Error('Use update now|later|status|policy notify|auto|off.');
  if (action !== 'status') await save(context, state);
  return {message: `Tinka updates: ${state.policy}.${state.snoozeUntil ? ` Snoozed until ${new Date(state.snoozeUntil).toISOString()}.` : ''} Local state: ${context.statePath}`, replaced: false};
}
