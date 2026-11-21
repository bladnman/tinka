// The browser's view of this project's updates, and its two ways to act on them.
// It reuses the updater (lib/updates.mjs, scripts/install.mjs) without a parallel
// setting: the policy is the CLI's notify/auto/off, Later is `update later`, and
// an install is `update now [--major] --to X.Y.Z` started as a detached process,
// because the installer stops and restarts this very server. The process holds the
// app operation lock, so only one install runs at a time; a record beside the
// update state lets the restarted server (or another tab) report it.
import {open, readFile} from 'node:fs/promises';
import {spawn as spawnProcess} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicText, compatibilityError, installationPristine, majorUpdate, withAppLock} from '../scripts/install.mjs';
import {displayVersion, loadUpdateState, newer, updateCheckTiming, updateCommand, updateContext, workspaceSchema} from './updates.mjs';
import {HttpError} from './paths.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stable = /^\d+\.\d+\.\d+$/;
// A recorded install older than this is over, whatever its process ID now names.
export const INSTALL_WINDOW = 15 * 60 * 1000;
const NOT_PRISTINE = 'This copy of Tinka has local changes or no file baseline, so it does not replace itself from the browser.';

export function installPaths(context) {
  const base = context.statePath.replace(/\.json$/, '');
  return {record: `${base}.install.json`, log: `${base}.install.log`};
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
// What an agent runs; relative in a portable project, where the agent works at its root.
function agentCommand(context, config) {
  return context.projectRoot ? 'node tinka/app/cli.mjs update --config tinka/local/config.json' : `node ${quote(path.join(context.app, 'cli.mjs'))} update --config ${quote(config.configPath)}`;
}
const releaseNotes = (context, version) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repo) ? `https://github.com/${context.repo}/releases/tag/v${version}` : null;
// The installer's own words, minus the retry command the browser offers as a button.
async function failureReason(paths, state, record) {
  const log = await readFile(paths.log, 'utf8').catch(() => '');
  const lines = log.split('\n').map(line => line.trim()).filter(Boolean);
  const failed = lines.find(line => line.startsWith('Tinka update failed.'));
  if (failed) return failed.replace(/^Tinka update failed\.\s*/, '').slice(0, 400) || 'The update stopped.';
  if (state?.installError && state.attemptedVersion === record.to) return state.installError.slice(0, 400);
  const last = lines.filter(line => !/^(Retry explicitly|Later|Notify|Off|Update now|Always install|After the user agrees):/.test(line)).at(-1);
  return (last || 'Tinka stopped before the update finished.').slice(0, 400);
}

export function createUpdateService(config, {app = appRoot, spawn = spawnProcess, now = () => Date.now(), checkOptions = {}} = {}) {
  let contextPromise = null, pristineCache = null;
  const context = () => contextPromise ||= updateContext(config, app);
  const installed = context => readFile(path.join(context.app, 'INSTALLATION.json')).then(() => true, () => false);
  // Hashing the app copy is not free; a page load can reuse a recent answer.
  async function pristine(context, fresh = false) {
    if (!fresh && pristineCache && now() - pristineCache.at < 60000) return pristineCache.value;
    pristineCache = {at: now(), value: await installationPristine(context.app)};
    return pristineCache.value;
  }
  async function readRecord(context) {
    const record = await readFile(installPaths(context).record, 'utf8').then(JSON.parse).catch(() => null);
    if (!record || record.schemaVersion !== 1 || !stable.test(record.to || '') || !Number.isFinite(record.startedAt)) return null;
    return {...record, running: alive(record.pid) && now() - record.startedAt < INSTALL_WINDOW};
  }
  async function reviewReason(context, state, latest, {fresh = false} = {}) {
    return latest.review || compatibilityError(latest.compatibility, {fromVersion: config.version, toVersion: latest.version, workspaceSchema: await workspaceSchema(config), allowMajor: true}) || (await pristine(context, fresh) ? null : NOT_PRISTINE);
  }
  async function view() {
    const context_ = await context();
    const base = {installed: await installed(context_), version: config.version, display: displayVersion(config.version), project: config.projectLabel, pin: !!context_.pinPath, agentCommand: agentCommand(context_, config), policy: null, checkedAt: null, lastSuccessfulCheckAt: null, nextCheckAt: null, checkFailed: false, refreshEnabled: false, latest: null, notice: null, install: null};
    if (!base.installed) return base;
    let state;
    try { state = await loadUpdateState(context_, config); }
    catch (error) { return {...base, notice: {kind: 'review', version: null, display: null, major: false, reason: error.message, snoozed: false}}; }
    Object.assign(base, updateCheckTiming(state, now()), {policy: state.policy, refreshEnabled: state.policy !== 'off'});
    const record = await readRecord(context_);
    if (record) {
      const outcome = record.running ? 'running' : config.version === record.to ? 'updated' : config.version === record.from ? 'failed' : null;
      if (outcome) base.install = {state: outcome, from: record.from, to: record.to, display: displayVersion(record.to), major: !!record.major, startedAt: record.startedAt, ...(outcome === 'failed' ? {reason: await failureReason(installPaths(context_), state, record)} : {})};
    }
    const latest = state.latest;
    if (!latest || !newer(latest.version, config.version)) return base;
    const major = majorUpdate(config.version, latest.version);
    base.latest = {version: latest.version, display: displayVersion(latest.version), major, notes: releaseNotes(context_, latest.version)};
    if (state.policy === 'off') return base;
    const review = await reviewReason(context_, state, latest);
    const failed = base.install?.state === 'failed' && base.install.to === latest.version ? base.install.reason : state.installError && state.attemptedVersion === latest.version ? state.installError : null;
    const kind = review ? 'review' : failed ? 'failed' : major ? 'major' : state.policy === 'auto' ? 'deferred' : 'compatible';
    base.notice = {kind, version: latest.version, display: base.latest.display, major, reason: review || failed || null, snoozed: !!(state.snoozeUntil && now() < state.snoozeUntil)};
    return base;
  }
  // One request at a time in this server; the record and the app lock cover restarts.
  let queue = Promise.resolve();
  const serial = action => { const run = queue.then(action, action); queue = run.catch(() => {}); return run; };
  function install(input) {
    return serial(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['version', 'consent'].includes(key)) || typeof input.version !== 'string' || !stable.test(input.version) || input.consent !== undefined && input.consent !== 'major') throw new HttpError(400, 'Provide {version} and, for a major update, consent: "major".');
      const context_ = await context();
      if (!await installed(context_)) throw new HttpError(409, 'This Tinka runs from a source checkout; update it with Git.');
      const state = await loadUpdateState(context_, config).catch(error => { throw new HttpError(409, error.message); });
      if (state.policy === 'off') throw new HttpError(409, 'Updates are off for this project. Choose Ask first in the Inspector to update from here.');
      if ((await readRecord(context_))?.running) throw new HttpError(409, 'An update is already running.');
      const latest = state.latest;
      if (!latest || !newer(latest.version, config.version)) throw new HttpError(409, 'No update is available.');
      if (latest.version !== input.version) throw new HttpError(409, `Tinka ${displayVersion(latest.version)} is the update on offer now, not ${displayVersion(input.version)}. Reload and review it.`);
      const review = await reviewReason(context_, state, latest, {fresh: true});
      if (review) throw new HttpError(409, `This update needs a review first. ${review}`);
      const crossesMajor = majorUpdate(config.version, latest.version);
      if (crossesMajor && input.consent !== 'major') throw new HttpError(400, `Tinka ${displayVersion(latest.version)} is a major update; it installs only with the user's yes (consent: "major").`);
      if (!crossesMajor && input.consent) throw new HttpError(400, 'This is not a major update; send no consent field.');
      const paths = installPaths(context_);
      const log = await open(paths.log, 'w');
      let child;
      try {
        const env = {...process.env};
        delete env.TINKA_OPERATION_TOKEN; delete env.TINKA_SKIP_UPDATE;
        child = spawn(process.execPath, [path.join(context_.app, 'cli.mjs'), 'update', 'now', ...(crossesMajor ? ['--major'] : []), '--to', latest.version, '--config', config.configPath], {detached: true, stdio: ['ignore', log.fd, log.fd], cwd: context_.projectRoot || path.dirname(config.configPath), env});
        child.on?.('error', () => {});
        child.unref?.();
      } finally { await log.close(); }
      if (!child?.pid) throw new HttpError(500, 'The update could not start.');
      const record = {schemaVersion: 1, pid: child.pid, startedAt: now(), from: config.version, to: latest.version, major: crossesMajor};
      await atomicText(paths.record, `${JSON.stringify(record, null, 2)}\n`);
      return {install: {state: 'running', from: record.from, to: record.to, display: displayVersion(record.to), major: crossesMajor, startedAt: record.startedAt}};
    });
  }
  // Later, the policy and Check now are the CLI's own update commands.
  function preference(input) {
    return serial(async () => {
      const policies = ['notify', 'auto', 'off'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || !['later', 'policy', 'check', 'refresh'].includes(input.action) || Object.keys(input).some(key => !['action', 'policy'].includes(key)) || (input.action === 'policy') !== (input.policy !== undefined) || input.action === 'policy' && !policies.includes(input.policy)) throw new HttpError(400, 'Provide {action:"later"}, {action:"check"}, {action:"refresh"} or {action:"policy",policy:"notify"|"auto"|"off"}.');
      const context_ = await context();
      if (!await installed(context_)) {
        if (input.action === 'refresh') return view();
        throw new HttpError(409, 'This Tinka runs from a source checkout; it has no update settings.');
      }
      if ((await readRecord(context_))?.running) {
        if (input.action === 'refresh') return view();
        throw new HttpError(409, 'An update is running. Try again when Tinka is back.');
      }
      try { await withAppLock(context_.app, token => updateCommand(config, input.action, input.policy, {...checkOptions, context: context_, lockToken: token, running: true, now: now()}), {token: null, waitMs: 3000}); }
      catch (error) { throw new HttpError(409, /operation is active/.test(error.message) ? 'Tinka is busy with another update task. Try again in a moment.' : error.message); }
      return view();
    });
  }
  return {view, install, preference};
}
