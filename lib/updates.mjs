import {readFile, realpath, mkdir, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DEFAULT_REPO, MAJOR_UPDATE_CONSENT, displayVersion, fullVersion, atomicText, compatibilityError, fetchLimited, installArchive, installationPristine, majorUpdate, verifyInstalledHealth} from '../scripts/install.mjs';
import {readRuntime, ownedProcess} from './runtime.mjs';
import {refreshProjectInstructions} from './project.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECK_INTERVAL = 15 * 60 * 1000;
export const CHECK_RETRY_INTERVAL = 2 * 60 * 1000;
export const SNOOZE_INTERVAL = 24 * 60 * 60 * 1000;
export const VERSION_URL = 'https://tinka.metal-sole.com/version.txt';
const checkTimeout = 1800;
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableVersion = value => typeof value === 'string' && stable.test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part)));
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
  return {app, pinPath, projectRoot: pinPath ? path.dirname(directory) : null, repo: project?.repo || DEFAULT_REPO, statePath: pinPath ? path.join(directory, 'local/updates.json') : `${config.configPath}.updates.json`};
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
export function newer(a, b) {
  if (!stableVersion(a) || !stableVersion(b)) return false;
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] > right[i]; }
  return false;
}
function releaseRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(value => ['.', '..'].includes(value))) throw new Error('Invalid release repository.');
  return repo;
}
// Preserve authenticated custom repositories and cached API-backed downloads.
// First-party announcement requests never use these authorization headers.
function releaseHeaders(url, accept) {
  return {'Accept':accept,'User-Agent':'tinka-updater',...(new URL(url).origin==='https://api.github.com'&&process.env.GITHUB_TOKEN?{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`}:{})};
}
function apiAssetURL(asset,repo) {
  const url=new URL(asset?.url);
  if(url.origin!=='https://api.github.com'||url.username||url.password||!url.pathname.toLowerCase().startsWith(`/repos/${repo.toLowerCase()}/releases/assets/`)||!/^\d+$/.test(url.pathname.split('/').at(-1)))throw new Error('Unexpected release asset URL.');
  return url.href;
}
async function customLatest(repo,currentVersion) {
  const endpoint=`https://api.github.com/repos/${repo}/releases/latest`,deadline=Date.now()+checkTimeout;
  const get=(url,limit,accept)=>fetchLimited(url,releaseHeaders(url,accept),limit,Math.max(1,deadline-Date.now()));
  const release=JSON.parse((await get(endpoint,1024*1024,'application/vnd.github+json')).toString('utf8'));
  const version=String(release.tag_name||'').replace(/^v/,'');
  if(release.draft||release.prerelease||!stableVersion(version))throw new Error('Latest release is not a stable supported version.');
  if(currentVersion&&!newer(version,currentVersion))return {version};
  const names=[`tinka-v${version}.zip`,`tinka-v${version}.zip.sha256`,`tinka-v${version}.compatibility.json`];
  const assets=names.map(name=>release.assets?.find(asset=>asset.name===name));
  if(assets.some(asset=>!asset))return {version,review:'Release lacks machine-readable compatibility; review the release and use the standalone installer.'};
  try {
    const compatibility=JSON.parse((await get(apiAssetURL(assets[2],repo),16384,'application/octet-stream')).toString('utf8'));
    return {version,compatibility,zipName:names[0],zipURL:apiAssetURL(assets[0],repo),checksumURL:apiAssetURL(assets[1],repo)};
  }catch{return {version,review:'Tinka found this version, but its installation details are unavailable. Try checking again before updating.'};}
}
// The fallback asks the public release page where latest points, without using
// GitHub's API or downloading its HTML. Only this repository's stable tag counts.
export async function redirectLatest(repo) {
  releaseRepo(repo);
  const prefix=`/${repo}/releases/tag/v`,deadline=Date.now()+checkTimeout;
  let url=`https://github.com/${repo}/releases/latest`;
  for(let redirects=0;redirects<4;redirects++) {
    const response=await fetch(url,{method:'HEAD',redirect:'manual',headers:{'User-Agent':'tinka-updater'},signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
    await response.body?.cancel();
    if(![301,302,303,307,308].includes(response.status))throw new Error('GitHub latest-release redirect is unavailable.');
    const location=response.headers.get('location');
    if(!location)throw new Error('GitHub latest-release redirect has no destination.');
    const target=new URL(location,url);
    if(target.protocol!=='https:'||target.hostname!=='github.com'||target.port||target.username||target.password||target.search||target.hash)throw new Error('Unexpected latest-release redirect.');
    if(target.pathname.toLowerCase().startsWith(prefix.toLowerCase())){
      const version=target.pathname.slice(prefix.length);
      if(!stableVersion(version))throw new Error('Latest release is not a stable supported version.');
      return version;
    }
    if(target.pathname.toLowerCase()!==`/${repo}/releases/latest`.toLowerCase())throw new Error('Unexpected latest-release redirect.');
    url=target.href;
  }
  throw new Error('Too many latest-release redirects.');
}
export async function publishedLatest(repo, currentVersion) {
  releaseRepo(repo);
  if(repo.toLowerCase()!==DEFAULT_REPO.toLowerCase())return customLatest(repo,currentVersion);
  let version;
  {
    try {
      version=(await fetchLimited(VERSION_URL,{'Accept':'text/plain','User-Agent':'tinka-updater'},128,checkTimeout)).toString('utf8').trim();
      if(!stableVersion(version))throw new Error('Version file has no stable supported version.');
    } catch { version=await redirectLatest(repo); }
  }
  if(currentVersion&&!newer(version,currentVersion))return {version};
  // Resolve once. Every subsequent read/download is bound to this immutable tag,
  // so a newer publication cannot mix its metadata with an older package.
  const zipName=`tinka-v${version}.zip`,base=`https://github.com/${repo}/releases/download/v${version}/`;
  try {
    const compatibility=JSON.parse((await fetchLimited(`${base}tinka-v${version}.compatibility.json`,{'Accept':'application/json','User-Agent':'tinka-updater'},16384,checkTimeout)).toString('utf8'));
    return {version,compatibility,zipName,zipURL:`${base}${zipName}`,checksumURL:`${base}${zipName}.sha256`};
  } catch {
    // Knowing a version is available does not depend on installation metadata
    // being reachable. Keep the announcement and offer review, never install.
    return {version,review:'Tinka found this version, but its installation details are unavailable. Try checking again before updating.'};
  }
}
// A local release feed replaces GitHub when TINKA_UPDATE_FEED names an absolute
// folder of package.mjs outputs (tinka-vX.Y.Z.zip, .zip.sha256 and
// .compatibility.json): for offline mirrors and tests. The newest stable version
// there is the release on offer; every other check still applies. Its local
// paths are never stored in update state.
export function releaseFeed(env = process.env) {
  const folder = env.TINKA_UPDATE_FEED;
  if (!folder) return null;
  if (!path.isAbsolute(folder)) throw new Error('TINKA_UPDATE_FEED must be an absolute folder.');
  return folder;
}
async function feedFile(folder, name, limit) {
  const file = path.join(folder, name);
  if ((await stat(file)).size > limit) throw new Error(`Release feed file is too large: ${name}`);
  return readFile(file);
}
export async function feedLatest(folder, currentVersion) {
  const versions = (await readdir(folder)).map(name => /^tinka-v(\d+\.\d+\.\d+)\.compatibility\.json$/.exec(name)?.[1]).filter(stableVersion);
  const version = versions.reduce((best, value) => !best || newer(value, best) ? value : best, null);
  if (!version) throw new Error('The release feed has no Tinka release.');
  if (currentVersion && !newer(version, currentVersion)) return {version};
  const names = [`tinka-v${version}.zip`, `tinka-v${version}.zip.sha256`, `tinka-v${version}.compatibility.json`];
  const present = await Promise.all(names.slice(0, 2).map(name => stat(path.join(folder, name)).then(() => true, () => false)));
  if (!present.every(Boolean)) return {version, review: 'Release lacks its package or checksum; review the release and use the standalone installer.'};
  const compatibility = JSON.parse((await feedFile(folder, names[2], 16384)).toString('utf8'));
  return {version, compatibility, zipName: names[0], feed: true};
}
export function latestRelease(repo, currentVersion) {
  const folder = releaseFeed();
  return folder ? feedLatest(folder, currentVersion) : publishedLatest(repo, currentVersion);
}
async function download(release) {
  // Bounded installation download; failures are remembered per release.
  const folder = release.feed ? releaseFeed() : null;
  if (release.feed && !folder) throw new Error('This release came from a local release feed that is no longer set (TINKA_UPDATE_FEED).');
  const [zipBytes, sidecar] = await Promise.all(folder ? [
    feedFile(folder, release.zipName, 100 * 1024 * 1024),
    feedFile(folder, `${release.zipName}.sha256`, 1024)
  ] : [
    fetchLimited(release.zipURL, releaseHeaders(release.zipURL,'application/octet-stream'), 100 * 1024 * 1024, 15000),
    fetchLimited(release.checksumURL, releaseHeaders(release.checksumURL,'application/octet-stream'), 1024, 15000)
  ]);
  const digest = createHash('sha256').update(zipBytes).digest('hex');
  if (release.compatibility.archiveSha256 !== digest) throw new Error('Compatibility asset does not match the downloaded package.');
  const {archiveSha256, ...embedded} = release.compatibility;
  return {zipBytes, checksumText: sidecar.toString('utf8'), zipName: release.zipName, compatibility: embedded};
}
export async function workspaceSchema(config) {
  return (await optional(path.join(config.workspaceRoot, 'workspace.json')))?.schemaVersion ?? 1;
}
function shellQuote(value) { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function commands(context, config) {
  return `node ${shellQuote(path.join(context.app, 'cli.mjs'))} update --config ${shellQuote(config.configPath)}`;
}
function bootstrap(context, config) {
  return `Automatic updates need an unmodified installation with a file baseline. Review local app changes, then use the current standalone tinka-install.mjs: node /absolute/tinka-install.mjs --install-dir ${shellQuote(context.app)} --config ${shellQuote(config.configPath)} --version ${shellQuote(config.version)}. Existing setup.mjs and TINKA.md are preserved.`;
}
// 1.0.0 reads as "Tinka 1.0"; other versions are shown in full.
export {displayVersion};
// A major update is offered, never refused for being major, and is installed
// only with the user's yes: `update now --major`. Automatic paths only notify.
function majorNotice(context, config, state, reason = '') {
  const command = commands(context, config);
  const install = reason ? `\nReview the release notes before installing: https://github.com/${context.repo}/releases/tag/v${state.latest.version}` : `\nAfter the user agrees: ${command} now --major`;
  return `Tinka ${displayVersion(state.latest.version)} is available (installed ${displayVersion(config.version)}). ${MAJOR_UPDATE_CONSENT}${reason ? ` ${reason}` : ''}${install}\nLater (24h): ${command} later\nNotify: ${command} policy notify\nOff: ${command} policy off`;
}
function notice(context, config, state, reason = '') {
  if (majorUpdate(config.version, state.latest.version)) return majorNotice(context, config, state, reason);
  const command = commands(context, config);
  return `Tinka ${displayVersion(state.latest.version)} is available (installed ${displayVersion(config.version)}).${reason ? ` ${reason}` : ''}\nUpdate now: ${command} now\nLater (24h): ${command} later\nAlways install compatible updates: ${command} policy auto\nNotify: ${command} policy notify\nOff: ${command} policy off`;
}
// Each start of a validated portable project refreshes its AGENTS.md block with
// this app's text. Every install and update starts the new app (as a health
// probe or restart), so this covers setup, update now and automatic updates.
// Manual layouts are never written; a failure is a warning, never a failed start.
export async function refreshStartInstructions(config, app = appRoot) {
  try {
    const {projectRoot} = await updateContext(config, app);
    return projectRoot ? (await refreshProjectInstructions(projectRoot)).notice : '';
  } catch (error) { return `Warning: Tinka could not refresh AGENTS.md: ${error.message}`; }
}
const agentsBytes = context => context.projectRoot ? readFile(path.join(context.projectRoot, 'AGENTS.md')).catch(() => null) : null;
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
export function updateCheckTiming(state, now = Date.now()) {
  const checkedAt=Number.isFinite(state?.checkedAt)?state.checkedAt:null;
  const lastSuccessfulCheckAt=Number.isFinite(state?.lastSuccessfulCheckAt)?state.lastSuccessfulCheckAt:
    checkedAt!==null && state?.latest && !state?.checkError ? checkedAt : null;
  const checkFailed=!!state?.checkError;
  return {checkedAt,lastSuccessfulCheckAt,nextCheckAt:checkedAt===null?now:checkedAt+(checkFailed?CHECK_RETRY_INTERVAL:CHECK_INTERVAL),checkFailed};
}
export async function checkForUpdates(config, {context, now = Date.now(), fetchLatest = latestRelease, downloadRelease = download, install = installArchive, lockToken, explicit = false, force = false, running = false, major = false, expectVersion = null} = {}) {
  context ||= await updateContext(config);
  const state = await loadUpdateState(context, config);
  if (!explicit && !force && state.policy === 'off') return {message: '', replaced: false};
  const timing=updateCheckTiming(state,now);
  if (explicit || force || now >= timing.nextCheckAt) {
    if(timing.lastSuccessfulCheckAt!==null)state.lastSuccessfulCheckAt=timing.lastSuccessfulCheckAt;
    state.checkedAt = now; delete state.checkError;
    // Persist attempts before I/O, including offline attempts and crashes.
    await save(context, state);
    try {
      const latest=await fetchLatest(context.repo,config.version);
      if(!stableVersion(latest?.version))throw new Error('Latest release has no stable supported version.');
      // Metadata for an immutable tag already validated on an earlier check
      // remains usable if its metadata host is temporarily unavailable now.
      state.latest=latest.review && state.latest?.version===latest.version && state.latest.compatibility ? state.latest : latest;
      state.lastSuccessfulCheckAt=now;
    } catch { state.checkError = 'Latest release check unavailable.'; }
    await save(context, state);
  }
  const release = state.latest;
  // The browser installs exactly the version the user saw (and agreed to).
  if (explicit && expectVersion && release?.version !== expectVersion) return {message: `Tinka ${displayVersion(expectVersion)} is no longer the update on offer${release?.version ? ` (the latest is ${displayVersion(release.version)})` : ''}. Nothing was installed.`, replaced: false};
  if(!explicit && state.policy==='auto' && state.baselineNotifiedVersion!==config.version && !await installationPristine(context.app)){
    state.baselineNotifiedVersion=config.version; await save(context,state);
    return {message:bootstrap(context,config),replaced:false};
  }
  if (!release || !newer(release.version, config.version)) return {message: explicit || force ? state.checkError || 'Tinka is up to date.' : '', replaced: false};
  // Problems other than the major step itself; a major step needs consent.
  const reason = release.review || compatibilityError(release.compatibility, {fromVersion: config.version, toVersion: release.version, workspaceSchema: await workspaceSchema(config), allowMajor: true});
  const crossesMajor = majorUpdate(config.version, release.version);
  const consented = !crossesMajor || explicit && major;
  const attempted = state.attemptedVersion === release.version;
  const wantsInstall = explicit || !force && state.policy === 'auto' && !running && !attempted && !(state.snoozeUntil && now < state.snoozeUntil);
  if (wantsInstall && !reason && consented) {
    const pristine = await installationPristine(context.app);
    if (!pristine && !explicit) return notify(bootstrap(context,config));
    state.attemptedVersion = release.version;
    await save(context, state);
    try {
      const agentsBefore = await agentsBytes(context);
      const source = await downloadRelease(release);
      const result = await install({...source, installDir: context.app, configPath: config.configPath, compatibility: source.compatibility, fromVersion: config.version, allowMajor: crossesMajor && consented, requirePristine: !explicit, pinPath: context.pinPath, lockToken});
      state.installedVersion = result.version; delete state.installError;
      await save(context, state);
      const agentsAfter = await agentsBytes(context);
      const agentsChanged = agentsAfter !== null && !(agentsBefore && agentsBefore.equals(agentsAfter));
      return {message: `Updated Tinka to ${displayVersion(result.version)}.${result.backup ? ` Backup: ${result.backup}.` : ''}${result.service?.portChange?` Old port ${result.service.portChange.from} was in use; new port ${result.service.portChange.to} saved. No other process was changed. Use ${result.service.url}`:''}${context.pinPath ? ` Review and commit tinka/project.json${agentsChanged ? ' and the updated Tinka section in AGENTS.md' : ''}.` : ''}`, replaced: true};
    } catch (error) {
      state.installError = error.message; await save(context, state);
      return {message: `Tinka update failed. ${error.message}\nRetry explicitly: ${commands(context, config)} now`, replaced: false};
    }
  }
  if (explicit && (reason || !consented)) return {message: notice(context, config, state, reason), replaced: false};
  if (crossesMajor) return notify(reason);
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
  if (options.major && action !== 'now') throw new Error('--major goes with update now, after the user agrees to a major update.');
  if (options.to) options = {...options, to: fullVersion(options.to)};
  if (options.to && (action !== 'now' || !stable.test(options.to))) throw new Error('--to X.Y (or X.Y.Z) goes with update now and names the exact version to install.');
  if (['now','check','refresh'].includes(action)) return checkForUpdates(config, {...options, context, ...(action!=='now'?{running:true}:{}), explicit: action==='now', force: action==='check', major: action==='now' && !!options.major, expectVersion: action === 'now' && options.to || null});
  const state = await loadUpdateState(context, config);
  if (action === 'policy') {
    if (!['notify', 'auto', 'off'].includes(value)) throw new Error('Choose update policy notify, auto or off.');
    state.policy = value;
  } else if (action === 'later') state.snoozeUntil = Date.now() + SNOOZE_INTERVAL;
  else if (action !== 'status') throw new Error('Use update now [--major] [--to X.Y.Z]|check|refresh|later|status|policy notify|auto|off.');
  if (action !== 'status') await save(context, state);
  const available = state.latest && newer(state.latest.version, config.version) ? `\n${notice(context, config, state)}` : '';
  return {message: `Tinka updates: ${state.policy}.${state.snoozeUntil ? ` Snoozed until ${new Date(state.snoozeUntil).toISOString()}.` : ''} Local state: ${context.statePath}${available}`, replaced: false};
}
