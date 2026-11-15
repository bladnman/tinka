// Headless checks for the browser update notice (public/update-notice.js): the
// board's status line and Home's live line show a compatible update as quiet
// text and a major one with the accent; the popover offers Update now, Later
// and automatic installs; the major dialog starts on Later so Enter never
// approves; installing pauses writes and ends in the existing Refresh without
// reloading; a failed install shows its reason and Try again; a review case
// offers only the agent request; the Inspector's Tinka section maps Ask first /
// Automatic / Off to the update policy. The server's real routes and write
// guards run; only the update source behind them is a test fixture, so nothing
// is downloaded or installed. The OS clipboard is stubbed.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../cli.mjs';
import {loadConfig, VERSION} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {HttpError} from '../lib/paths.mjs';
import {listen, closeAppServer} from '../server.mjs';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = await mkdtemp(path.join(os.tmpdir(), 'tinka-update-notice-'));
const evidence = process.env.TINKA_EVIDENCE_DIR || await mkdtemp(path.join(os.tmpdir(), 'tinka-update-notice-evidence-')); await mkdir(evidence, {recursive: true});
let server, browser, checks = 0; const errors = [];
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const display = version => version.replace(/^(\d+\.\d+)\.0$/, '$1');
const [major] = VERSION.split('.').map(Number);
const COMPATIBLE = `${major}.1.0`, MAJOR = `${major + 1}.0.0`;

// The update source: what lib/update-browser.mjs would report, under test control.
const S = {};
function reset() { Object.assign(S, {version: VERSION, policy: 'notify', offer: null, kind: null, reason: null, snoozed: false, install: null, posts: []}); }
function offer(version, kind = null, reason = null) { S.offer = version; S.kind = kind; S.reason = reason; S.snoozed = false; }
const updates = {
  async view() {
    const latest = S.offer ? {version: S.offer, display: display(S.offer), major: S.offer === MAJOR, notes: `https://github.com/bladnman/tinka/releases/tag/v${S.offer}`} : null;
    const kind = latest && S.policy !== 'off' ? S.kind || (latest.major ? 'major' : S.policy === 'auto' ? 'deferred' : 'compatible') : null;
    return {installed: true, version: S.version, display: display(S.version), project: 'Field Notes', pin: true, agentCommand: 'node tinka/app/cli.mjs update --config tinka/local/config.json', policy: S.policy, checkedAt: Date.now(), checkFailed: false, latest, notice: kind ? {kind, version: latest.version, display: latest.display, major: latest.major, reason: S.reason, snoozed: S.snoozed} : null, install: S.install};
  },
  async install(input) {
    S.posts.push(['install', input]);
    if (S.policy === 'off') throw new HttpError(409, 'Updates are off for this project.');
    if (input.version === MAJOR && input.consent !== 'major') throw new HttpError(400, 'A major update installs only with the user\'s yes.');
    S.install = {state: 'running', from: VERSION, to: input.version, display: display(input.version), major: input.version === MAJOR, startedAt: Date.now()};
    return {install: S.install};
  },
  async preference(input) {
    S.posts.push(['preference', input]);
    if (input.action === 'later') S.snoozed = true;
    if (input.action === 'policy') S.policy = input.policy;
    return updates.view();
  },
};
const finish = ({failed = null} = {}) => { S.install = {...S.install, state: failed ? 'failed' : 'updated', ...(failed ? {reason: failed} : {})}; if (!failed) { S.version = S.install.to; S.offer = null; } else S.kind = 'failed', S.reason = failed; };

try {
  reset();
  const file = path.join(root, 'config.json'); await main(['init', '--config', file, '--boards', path.join(root, 'boards'), '--label', 'Field Notes']); const config = await loadConfig(file);
  const op = async (type, fields) => (await applyOperation(config, {type, ...fields})).result;
  const assets = path.join(config.boardsRoot, 'assets'); await mkdir(assets);
  const design = (title, hue) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:18px system-ui;background:#f6f3ea;color:#2e3328}header{height:70px;background:${hue};opacity:.85}main{padding:28px}h1{font:600 34px Georgia,serif;margin:0 0 12px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}.cards div{height:180px;border-radius:12px;background:${hue}33;box-shadow:inset 0 0 0 1px ${hue}55}</style><header></header><main><h1>${title}</h1><p>Monthly or yearly, with the saving spelled out.</p><div class="cards"><div></div><div></div><div></div></div></main>`;
  for (const [name, title, hue] of [['quiet.html', 'Quiet table', '#5f7a4a'], ['cards.html', 'Plan cards', '#a9783f'], ['calc.html', 'Calculator', '#466f86']]) await writeFile(path.join(assets, name), design(title, hue));
  await op('updateWorkspace', {patch: {resourceRoots: {assets: {path: '../assets'}}}});
  await op('createBoard', {id: 'pricing', title: 'Pricing page · round 2'});
  const placements = [];
  for (const [index, [name, title]] of [['quiet.html', 'Quiet table'], ['cards.html', 'Plan cards'], ['calc.html', 'Calculator']].entries()) placements.push(await op('createItem', {boardId: 'pricing', item: {title, number: `0${index + 1}`, content: {kind: 'html', resource: {rootId: 'assets', path: name}}}, placement: {x: index * 780, y: 0, width: 720, height: 560, presentation: {mode: 'panel', viewport: {width: 1000, height: 720}}}}));
  await op('createItem', {boardId: 'pricing', item: {title: 'Which layout makes the yearly saving obvious?', content: {kind: 'note', text: 'Star one, or leave a note.'}}, placement: {x: 0, y: 620, width: 420, height: 140}});
  server = await listen(config, {port: 0, updates}); const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
  async function open(width, scheme, url = `${base}/boards/pricing/`) {
    const context = await browser.newContext({viewport: {width, height: width > 720 ? 900 : 844}, colorScheme: scheme, reducedMotion: 'reduce', deviceScaleFactor: 2});
    await context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async text => { window.__copied = text; }, readText: async () => window.__copied || ''}}); window.__marker = 'same page'; });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
    await page.goto(url); await page.locator(url.includes('/boards/') ? '#live-status:not(:empty)' : '#connection').waitFor({state: 'attached'}); await page.waitForTimeout(150);
    return {context, page};
  }
  const shot = (page, name) => page.screenshot({path: path.join(evidence, `${name}.png`)});
  const chip = page => page.locator('.update-chip');

  // (1) Compatible: quiet text; the popover's Update now, Later, Automatic and agent request.
  offer(COMPATIBLE);
  let {context, page} = await open(1440, 'light');
  await chip(page).waitFor();
  eq(await chip(page).evaluate(b => [b.dataset.kind, b.textContent.trim(), b.closest('.status-line') !== null]), ['minor', `Tinka ${display(COMPATIBLE)} available`, true], 'A compatible update is quiet text on the status line');
  ok(await chip(page).evaluate(b => getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)'), 'No fill or dot for a compatible update');
  await chip(page).click();
  const pop = page.locator('.update-pop'); await pop.waitFor();
  eq(await pop.locator('h4').textContent(), `Tinka ${display(COMPATIBLE)} is available`, 'The popover names the update');
  ok(await pop.getByRole('button', {name: 'Update now'}).isVisible() && await pop.getByRole('button', {name: 'Later'}).isVisible(), 'Update now and Later');
  ok(await pop.getByLabel('Install compatible updates automatically').isVisible(), 'Automatic installs are offered');
  await pop.getByRole('button', {name: 'Copy a request for your agent'}).click();
  ok((await page.evaluate(() => window.__copied)).includes('node tinka/app/cli.mjs update --config tinka/local/config.json now'), 'The agent request carries the command');
  await shot(page, 'compatible-1440-light');
  await pop.getByLabel('Install compatible updates automatically').check();
  await page.waitForFunction(() => document.querySelector('.update-pop .update-status')?.textContent.includes('as Tinka starts'));
  eq(S.posts.at(-1), ['preference', {action: 'policy', policy: 'auto'}], 'Automatic is the auto update policy');
  await page.keyboard.press('Escape'); ok(!await pop.count(), 'Escape closes the popover');
  ok(!await chip(page).count(), 'With Automatic, a compatible update goes quiet');
  await page.locator('#board-info-toggle').click();
  const about = page.locator('.update-about'); await about.waitFor();
  ok((await about.textContent()).includes(`${display(COMPATIBLE)} installs next time Tinka starts`), 'The Inspector says when it installs');
  eq(await about.locator('[data-policy]').evaluateAll(buttons => buttons.map(b => [b.textContent, b.getAttribute('aria-pressed')])), [['Ask first', 'false'], ['Automatic', 'true'], ['Off', 'false']], 'Ask first / Automatic / Off show the policy');
  await about.getByRole('button', {name: 'Ask first'}).click();
  await page.locator('.update-chip').waitFor();
  eq(S.posts.at(-1), ['preference', {action: 'policy', policy: 'notify'}], 'Ask first is the notify policy');
  await page.locator('#board-info-close').click();
  await chip(page).click(); await page.locator('.update-pop').getByRole('button', {name: 'Later'}).click();
  await page.waitForFunction(() => !document.querySelector('.update-chip'));
  eq(S.posts.at(-1), ['preference', {action: 'later'}], 'Later is update later (24 hours)');
  await context.close();

  // (2) Major: accent and dot; the consent dialog starts on Later; Enter never approves.
  reset(); offer(MAJOR);
  ({context, page} = await open(1440, 'light'));
  await chip(page).waitFor();
  eq(await chip(page).evaluate(b => [b.dataset.kind, b.textContent.trim(), getComputedStyle(b, '::before').width]), ['major', `Tinka ${display(MAJOR)} available`, '6px'], 'A major update has the accent and a dot');
  await chip(page).click();
  const dialog = page.locator('dialog.update-dialog[open]'); await dialog.waitFor();
  eq(await dialog.locator('h2').textContent(), `Update to Tinka ${display(MAJOR)}?`, 'The consent question');
  eq(await dialog.locator('.update-facts li').count(), 4, 'Four facts');
  ok(await dialog.getByRole('link', {name: `What's new in ${display(MAJOR)}`}).isVisible(), "What's new");
  eq(await page.evaluate(() => document.activeElement?.dataset.update), 'later', 'Focus starts on Later');
  await shot(page, 'major-consent-1440-light');
  await page.keyboard.press('Enter');
  await dialog.waitFor({state: 'detached'});
  ok(!S.posts.some(([kind]) => kind === 'install'), 'Enter chose Later: nothing installed');
  eq(S.posts.at(-1), ['preference', {action: 'later'}], 'Later snoozed the reminder');
  S.snoozed = false;
  await page.reload(); await chip(page).waitFor(); await chip(page).click(); await dialog.waitFor();
  await dialog.getByRole('button', {name: 'Copy the request'}).click();
  ok((await page.evaluate(() => window.__copied)).includes(`I know ${display(MAJOR)} is a major update, and I agree to install it.`), 'The agent request carries the yes');
  await dialog.getByRole('button', {name: `Update to ${display(MAJOR)}`}).click();
  await dialog.waitFor({state: 'detached'});
  eq(S.posts.at(-1), ['install', {version: MAJOR, consent: 'major'}], 'Update sends the consent field');

  // (3) Updating: writes wait, then the existing Refresh; nothing reloads itself.
  await page.locator('.update-chip[data-kind="busy"]').waitFor();
  eq((await chip(page).textContent()).trim(), `Updating to ${display(MAJOR)}… changes wait`, 'The status line says changes wait');
  ok(await page.evaluate(() => document.body.classList.contains('tinka-updating') && getComputedStyle(document.querySelector('.chrome-add')).pointerEvents === 'none'), 'Adding pauses');
  ok(await page.evaluate(async () => { const hold = await import('/app/update-hold.js'); let done = false; hold.writesReady().then(() => { done = true; }); await new Promise(resolve => setTimeout(resolve, 100)); return !done; }), 'Writes wait while Tinka restarts');
  await shot(page, 'updating-1440-light');
  finish();
  await page.locator('#live-refresh:not([hidden])').waitFor({timeout: 5000});
  eq(await page.locator('#live-refresh').textContent(), `Tinka ${display(MAJOR)} is ready · Refresh`, 'Ready ends in the existing Refresh');
  ok(await page.evaluate(() => window.__marker === 'same page' && !document.body.classList.contains('tinka-updating')), 'Nothing reloaded by itself; editing is back');
  ok(await page.evaluate(async () => { const hold = await import('/app/update-hold.js'); let done = false; hold.writesReady().then(() => { done = true; }); await new Promise(resolve => setTimeout(resolve, 50)); return done; }), 'Held writes go out once Tinka answers');
  await shot(page, 'ready-1440-light');
  await context.close();

  // (4) Failed: the reason and Try again (with the yes already given), plus the agent details.
  reset(); offer(MAJOR, 'failed', 'Compatibility asset does not match the downloaded package.');
  S.install = {state: 'failed', from: VERSION, to: MAJOR, display: display(MAJOR), major: true, startedAt: Date.now(), reason: S.reason};
  ({context, page} = await open(1440, 'light'));
  await chip(page).waitFor();
  eq([await chip(page).getAttribute('data-kind'), (await chip(page).textContent()).trim()], ['failed', "Update didn't finish"], 'A failed install says so');
  await chip(page).click(); await page.locator('.update-pop').waitFor();
  ok((await page.locator('.update-reason').textContent()).includes('does not match the downloaded package'), 'The reason is shown');
  await page.locator('.update-pop').getByRole('button', {name: 'Copy details for your agent'}).click();
  ok((await page.evaluate(() => window.__copied)).includes('now --major'), 'The details carry the retry command');
  await shot(page, 'failed-1440-light');
  await page.locator('.update-pop').getByRole('button', {name: 'Try again'}).click();
  await page.locator('.update-chip[data-kind="busy"]').waitFor();
  eq(S.posts.at(-1), ['install', {version: MAJOR, consent: 'major'}], 'Try again repeats the same request');
  finish({failed: 'Installed app health identity/version mismatch.'});
  await page.locator('.update-chip[data-kind="failed"]').waitFor({timeout: 5000});
  ok(await page.evaluate(() => !document.body.classList.contains('tinka-updating')), 'Back on the old version, editing returns');
  await context.close();

  // (5) Needs review: only the agent request; policy Off quiets everything.
  reset(); offer(COMPATIBLE, 'review', 'This copy of Tinka has local changes or no file baseline, so it does not replace itself from the browser.');
  ({context, page} = await open(1440, 'light'));
  await chip(page).click(); await page.locator('.update-pop').waitFor();
  eq(await page.locator('.update-pop').getByRole('button').evaluateAll(buttons => buttons.map(b => b.textContent.trim())), ['Copy request for your agent', 'Later'], 'Review offers only the agent request (and Later)');
  await page.locator('.update-pop').getByRole('button', {name: 'Copy request for your agent'}).click();
  ok((await page.evaluate(() => window.__copied)).includes('local changes'), 'The request says why');
  await page.keyboard.press('Escape');
  await page.locator('#board-info-toggle').click(); await page.locator('.update-about').getByRole('button', {name: 'Off'}).click();
  await page.waitForFunction(() => !document.querySelector('.update-chip'));
  eq(S.posts.at(-1), ['preference', {action: 'policy', policy: 'off'}], 'Off is the off policy');
  ok((await page.locator('.update-about').textContent()).includes('updates are off'), 'The Inspector says updates are off');
  await context.close();

  // (6) Home's live line, and the major dialog there.
  reset(); offer(MAJOR);
  ({context, page} = await open(1440, 'light', `${base}/`));
  await chip(page).waitFor();
  ok(await chip(page).evaluate(b => b.closest('.masthead .live') !== null), "Home shows it on the live line");
  await chip(page).click(); await page.locator('dialog.update-dialog[open]').waitFor();
  eq(await page.evaluate(() => document.activeElement?.dataset.update), 'later', 'Home: focus starts on Later');
  await shot(page, 'home-major-consent-1440-light');
  await page.locator('dialog.update-dialog').getByRole('button', {name: `Update to ${display(MAJOR)}`}).click();
  await page.locator('.masthead .live .update-chip[data-kind="busy"]').waitFor();
  finish(); await page.locator('.masthead .live .update-refresh').waitFor({timeout: 5000});
  eq(await page.locator('.update-refresh').textContent(), `Tinka ${display(MAJOR)} is ready · Refresh`, 'Home: ready · Refresh');
  await shot(page, 'home-ready-1440-light');
  await context.close();

  // (7) Every state at 1440 and 390, light and dark.
  const states = {
    compatible: async page => { await chip(page).click(); await page.locator('.update-pop').waitFor(); },
    'major-consent': async page => { await chip(page).click(); await page.locator('dialog.update-dialog[open]').waitFor(); },
    updating: async page => { await page.locator('.update-chip[data-kind="busy"]').waitFor(); },
    ready: async page => { finish(); await page.locator('#live-refresh:not([hidden])').waitFor({timeout: 5000}); },
    failed: async page => { await chip(page).click(); await page.locator('.update-pop').waitFor(); },
  };
  const setup = {
    compatible: () => offer(COMPATIBLE),
    'major-consent': () => offer(MAJOR),
    updating: () => { offer(MAJOR); S.install = {state: 'running', from: VERSION, to: MAJOR, display: display(MAJOR), major: true, startedAt: Date.now()}; },
    ready: () => { offer(MAJOR); S.install = {state: 'running', from: VERSION, to: MAJOR, display: display(MAJOR), major: true, startedAt: Date.now()}; },
    failed: () => { offer(MAJOR, 'failed', 'Compatibility asset does not match the downloaded package.'); S.install = {state: 'failed', from: VERSION, to: MAJOR, display: display(MAJOR), major: true, startedAt: Date.now(), reason: S.reason}; },
  };
  for (const width of [1440, 390]) for (const scheme of ['light', 'dark']) {
    for (const [name, act] of Object.entries(states)) {
      reset(); setup[name]();
      ({context, page} = await open(width, scheme));
      if (name !== 'ready' && name !== 'updating') await chip(page).waitFor();
      await act(page);
      if (width === 390 && name !== 'ready') ok(await page.locator('.update-chip, dialog.update-dialog[open]').first().isVisible(), `Phone ${scheme} ${name}: visible`);
      if (width === 390 && ['compatible', 'failed'].includes(name)) ok(await page.locator('.update-pop').evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0; }), `Phone ${scheme} ${name}: the popover fits`);
      await shot(page, `${name}-${width}-${scheme}`);
      await context.close();
    }
  }
  reset(); offer(COMPATIBLE);
  ({context, page} = await open(390, 'light', `${base}/`)); await chip(page).waitFor(); await shot(page, 'home-compatible-390-light'); await context.close();

  eq(errors, [], 'No page errors');
  console.log(`Update notice browser checks passed (${checks} checks). Screenshots: ${evidence}`);
} finally {
  await browser?.close(); if (server) await closeAppServer(server); await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
