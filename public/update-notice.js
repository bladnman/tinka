// Tinka's own updates, where Tinka already says "Live": the board's floating
// status line and Home's live line (on phones, a pill). A compatible update is
// quiet grey text; a major one has the accent and a dot and asks first in a
// dialog. Installing pauses editing (writes wait), then offers the existing
// Refresh; nothing reloads by itself. "Copy a request for your agent" is always
// there, and it is the only route when an update needs review. The settings are
// the CLI's own (`update policy notify|auto|off`, `update later`), shown in the
// board Inspector as Ask first / Automatic / Off.
import {holdWrites, releaseWrites} from './update-hold.js';

const ICON = {
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>',
  ext: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
};
const POLL_MS = 1500, GIVE_UP_MS = 5 * 60 * 1000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const $ = selector => document.querySelector(selector);
const line = $('.canvas-footer .status-line');
const surface = line ? 'board' : $('.masthead .live') ? 'home' : null;
let config = {}, view = null, pageVersion = null;
let phase = 'idle', target = null, localFailure = null, pollTimer = null, giveUpAt = 0, popover = null, aboutMessage = '';
let refreshTimer = null, refreshing = null, refreshRetryAt = 0, refreshError = null, viewEpoch = 0;

async function getView() {
  const response = await fetch('/api/update', {cache: 'no-store'});
  if (!response.ok) throw new Error(`Update state unavailable (${response.status}).`);
  return response.json();
}
async function post(url, body) {
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-tinka-workspace': config.workspaceId}, body: JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
const preference = body => {
  const epoch = ++viewEpoch;
  return post('/api/update/preference', body).then(next => {
    if (epoch === viewEpoch) { view = next; refreshError = null; refreshRetryAt = 0; render(); }
    return next;
  });
};

// What the status line shows, if anything.
function current() {
  if (!view?.installed) return null;
  if (phase === 'ready') return {kind: 'ready', display: target};
  if (phase === 'updating') return {kind: 'busy', display: target};
  if (localFailure) return localFailure;
  const notice = view.notice;
  if (notice && !notice.snoozed && notice.kind !== 'deferred' && notice.version) return notice;
  if (notice?.snoozed) return null;
  return view.policy !== 'off' && (view.checkFailed || refreshError) ? {kind:'check-failed'} : null;
}

function checkStatus() {
  const failed = view?.checkFailed || refreshError;
  const at = view?.lastSuccessfulCheckAt || (!view?.checkFailed && view?.checkedAt);
  const date = Number.isFinite(at) && at > 0 ? new Date(at) : null;
  const successful = date ? `Last successful check: ${date.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}.` : 'No successful update check yet.';
  return failed ? `Could not refresh update information. ${successful}` : date ? successful : '';
}
const checkStatusHtml = () => checkStatus() ? `<p class="update-check-status">${esc(checkStatus())}</p>` : '';

// ---- Agent requests: the user's words, with the exact command ----------------
function request(notice) {
  const command = view.agentCommand, to = notice.display, have = view.display, major = notice.major ? ' --major' : '';
  const commit = view.pin ? ', then commit the updated tinka/project.json' : '';
  if (notice.kind === 'review') return `Tinka ${to} is available for this project (${view.project}), but Tinka says this copy needs a review before it can update itself (${notice.reason}).\n\nPlease check what Tinka found, tell me, and update Tinka to ${to} if it is safe${notice.major ? `. It is a major update, so ask me before installing it` : ''}:\n${command} now${major}${view.pin ? '\n\nThen commit the updated tinka/project.json.' : ''}`;
  if (notice.kind === 'failed') return `Tinka tried to update this project (${view.project}) to ${to} and stopped. It says it is still on ${have}.\nReason: ${notice.reason}\n\nPlease check what happened (${command} status) and, if it is safe, try again${notice.major ? ' with the same consent I gave' : ''}:\n${command} now${major}`;
  if (notice.major) return `Please update Tinka in this project (${view.project}) to ${to}.\nI know ${to} is a major update, and I agree to install it.\n\nRun:\n${command} now --major\n\nTell me when Tinka is back${commit}.`;
  return `Please update Tinka in this project (${view.project}) to ${to}.\n\nRun:\n${command} now\n\nTell me when Tinka is back${commit}.`;
}
// The clipboard may be unavailable; then the text is shown, selected, to copy by hand.
async function copy(text, status, done) {
  try { await navigator.clipboard.writeText(text); status.textContent = done; }
  catch {
    status.textContent = 'Select the request and copy it.';
    let area = status.parentElement.querySelector('textarea.update-copy-text');
    if (!area) { area = document.createElement('textarea'); area.className = 'update-copy-text'; area.readOnly = true; area.rows = 5; area.setAttribute('aria-label', 'Request for your agent'); status.before(area); }
    area.value = text; area.focus(); area.select();
  }
}

// ---- Popover beside the status line -----------------------------------------
function closePopover({focus = false} = {}) {
  if (!popover) return;
  const {element, anchor} = popover; popover = null;
  element.remove(); anchor?.setAttribute('aria-expanded', 'false');
  if (focus && anchor?.isConnected) anchor.focus({preventScroll: true});
}
function openPopover(anchor, html, label) {
  closePopover();
  const element = document.createElement('div');
  // workspace-popover: the board Inspector stays open while this is used.
  element.className = 'tk-menu update-pop workspace-popover';
  element.setAttribute('role', 'dialog'); element.setAttribute('aria-label', label);
  element.innerHTML = html;
  element.querySelector('.update-pop-body')?.insertAdjacentHTML('beforeend', checkStatusHtml());
  document.body.append(element);
  const box = anchor.getBoundingClientRect(), width = Math.min(340, innerWidth - 16);
  element.style.width = `${width}px`;
  const left = Math.max(8, Math.min(box.left, innerWidth - width - 8));
  const above = box.top > innerHeight / 2;
  const top = above ? box.top - element.offsetHeight - 8 : box.bottom + 8;
  Object.assign(element.style, {left: `${left}px`, top: `${Math.max(8, Math.min(top, innerHeight - element.offsetHeight - 8))}px`});
  anchor.setAttribute('aria-expanded', 'true');
  popover = {element, anchor};
  element.querySelector('button')?.focus({preventScroll: true});
  return element;
}
addEventListener('pointerdown', event => { if (popover && !popover.element.contains(event.target) && !popover.anchor.contains(event.target)) closePopover(); }, true);
addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !popover || event.isComposing) return;
  event.preventDefault(); event.stopImmediatePropagation(); closePopover({focus: true});
}, true);
const eyebrow = () => `<p class="update-eyebrow">Tinka for ${esc(view.project)}</p>`;
const notesLink = (label = "What's new") => view.latest?.notes ? `<a class="update-notes" href="${esc(view.latest.notes)}" target="_blank" rel="noopener noreferrer">${label} ${ICON.ext}</a>` : '';

function compatiblePopover(anchor, notice) {
  const pop = openPopover(anchor, `<div class="update-pop-body">${eyebrow()}<h4>Tinka ${esc(notice.display)} is available</h4><p class="update-copy">You have ${esc(view.display)}. This is a compatible update: your boards, notes and files stay as they are.</p>
  <div class="update-row"><button class="tk-btn tk-primary" type="button" data-update="install">Update now</button><button class="tk-btn tk-tonal" type="button" data-update="later">Later</button>${notesLink()}</div>
  <p class="update-meta">Tinka restarts for a few seconds. Open boards wait, then offer Refresh.</p>
  <div class="tk-msep"></div>
  <label class="update-switch"><input type="checkbox" data-update="auto"${view.policy === 'auto' ? ' checked' : ''}><span>Install compatible updates automatically</span><small>Only as Tinka starts, never in the middle of your work. Major updates always ask.</small></label>
  <button class="tk-mi" type="button" data-update="agent">${ICON.copy}Copy a request for your agent</button><p class="update-status" role="status"></p></div>`, `Tinka ${notice.display} is available`);
  const status = pop.querySelector('.update-status');
  pop.querySelector('[data-update=install]').onclick = event => install(notice, {status, button: event.currentTarget});
  pop.querySelector('[data-update=later]').onclick = () => later(status);
  pop.querySelector('[data-update=auto]').onchange = async event => {
    const box = event.currentTarget; box.disabled = true;
    try { await preference({action: 'policy', policy: box.checked ? 'auto' : 'notify'}); status.textContent = box.checked ? 'Compatible updates now install as Tinka starts.' : 'Tinka asks first again.'; }
    catch (error) { box.checked = !box.checked; status.textContent = error.message; }
    finally { box.disabled = false; }
  };
  pop.querySelector('[data-update=agent]').onclick = () => copy(request(notice), status, 'Request copied. Paste it into your agent conversation.');
}
function reviewPopover(anchor, notice) {
  const pop = openPopover(anchor, `<div class="update-pop-body">${eyebrow()}<h4>Tinka ${esc(notice.display)} needs a quick review</h4><p class="update-copy">Tinka won't replace itself from here this time. Your agent can check what it found and update it.</p>
  <p class="update-reason"><b>Reason:</b> ${esc(notice.reason)}</p>
  <div class="update-row"><button class="tk-btn tk-primary" type="button" data-update="agent">${ICON.copy}<span>Copy request for your agent</span></button><button class="tk-btn tk-tonal" type="button" data-update="later">Later</button>${notesLink()}</div><p class="update-status" role="status"></p></div>`, `Tinka ${notice.display} needs a review`);
  const status = pop.querySelector('.update-status');
  pop.querySelector('[data-update=agent]').onclick = () => copy(request(notice), status, 'Request copied. Paste it into your agent conversation.');
  pop.querySelector('[data-update=later]').onclick = () => later(status);
}
function failedPopover(anchor, notice) {
  const lost = notice.lost;
  const pop = openPopover(anchor, `<div class="update-pop-body">${eyebrow()}<h4>Tinka didn't update to ${esc(notice.display)}</h4><p class="update-copy">${lost ? "Tinka hasn't answered since the update started. Your boards, notes and files are on disk, untouched." : `It went back to ${esc(view.display)}, which is running now. Your boards, notes and files are fine.`}</p>
  <p class="update-reason"><b>Reason:</b> ${esc(notice.reason || 'The update stopped.')}</p>
  <div class="update-row">${lost ? '' : '<button class="tk-btn tk-primary" type="button" data-update="retry">Try again</button>'}<button class="tk-btn ${lost ? 'tk-primary' : 'tk-tonal'}" type="button" data-update="agent">${ICON.copy}<span>Copy details for your agent</span></button></div><p class="update-status" role="status"></p></div>`, `Tinka didn't update to ${notice.display}`);
  const status = pop.querySelector('.update-status');
  // Try again repeats the same request; a major one carries the yes already given.
  pop.querySelector('[data-update=retry]')?.addEventListener('click', event => install(notice, {status, button: event.currentTarget, consent: notice.major}));
  pop.querySelector('[data-update=agent]').onclick = () => copy(request({...notice, kind: 'failed'}), status, 'Details copied. Paste them into your agent conversation.');
}
function checkFailedPopover(anchor) {
  const pop = openPopover(anchor, `<div class="update-pop-body">${eyebrow()}<h4>Could not check for updates</h4><p class="update-copy">Tinka will try again while this project is open. You can keep working.</p><button class="tk-btn tk-tonal" type="button" data-update="check">Check now</button><p class="update-status" role="status"></p></div>`, 'Update check unavailable');
  pop.querySelector('[data-update=check]').onclick = async event => {
    event.currentTarget.disabled = true;
    try {
      await preference({action:'check'});
      if (!view.checkFailed) closePopover();
      else pop.querySelector('.update-status').textContent = 'The update check is still unavailable.';
    } catch(error) { pop.querySelector('.update-status').textContent = error.message; }
    finally { if(pop.isConnected)pop.querySelector('[data-update=check]').disabled = false; }
  };
}
async function later(status) {
  try { await preference({action: 'later'}); closePopover({focus: false}); }
  catch (error) { status.textContent = error.message; }
}

// ---- The major update asks first ---------------------------------------------
function consent(notice) {
  closePopover();
  document.querySelector('dialog.update-dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.className = 'update-dialog';
  dialog.setAttribute('aria-labelledby', 'update-dialog-title');
  dialog.innerHTML = `<form method="dialog"><button class="close" aria-label="Close" value="close">×</button></form><p class="eyebrow">Major update · ${esc(view.project)}</p><h2 id="update-dialog-title">Update to Tinka ${esc(notice.display)}?</h2>
  <p class="dialog-copy">Tinka ${esc(notice.display)} is a major update, so Tinka asks before installing it. You have ${esc(view.display)}. Some things may look or work differently afterwards.</p>
  <ul class="update-facts">
  <li>${ICON.check}<span>Your boards, notes and files stay exactly as they are.</span></li>
  <li>${ICON.check}<span>Tinka keeps a copy of ${esc(view.display)} and goes back to it if ${esc(notice.display)} doesn't start.</span></li>
  <li>${ICON.check}<span>Tinka restarts for a few seconds. Open boards wait, then offer Refresh.</span></li>
  <li>${ICON.check}<span>Only ${esc(view.project)} is updated. Other projects keep their own Tinka.</span></li></ul>
  ${notesLink(`What's new in ${esc(notice.display)}`).replace('class="update-notes"', 'class="update-link"')}
  <div class="dialog-bottom"><span>Not now? Later asks again tomorrow.</span><div class="dialog-buttons"><button class="tk-btn tk-tonal" type="button" data-update="later" autofocus>Later</button><button class="tk-btn tk-primary" type="button" data-update="yes">Update to ${esc(notice.display)}</button></div></div>
  <p class="update-status" role="status"></p>
  <div class="update-alt"><span>Rather have your agent do it?</span><button class="tk-btn tk-sm" type="button" data-update="agent">${ICON.copy}<span>Copy the request</span></button></div>`;
  document.body.append(dialog);
  const status = dialog.querySelector('.update-status');
  const returnTo = document.activeElement;
  dialog.addEventListener('close', () => { dialog.remove(); if (returnTo?.isConnected && phase === 'idle') returnTo.focus({preventScroll: true}); });
  dialog.querySelector('[data-update=later]').onclick = async () => { try { await preference({action: 'later'}); dialog.close(); } catch (error) { status.textContent = error.message; } };
  dialog.querySelector('[data-update=yes]').onclick = event => install(notice, {status, button: event.currentTarget, consent: true, dialog});
  dialog.querySelector('[data-update=agent]').onclick = () => copy(request(notice), status, 'Request copied, with your yes. Paste it into your agent conversation.');
  dialog.showModal();
  // Focus starts on Later, so Enter never approves by accident.
  dialog.querySelector('[data-update=later]').focus();
}

// ---- Installing: editing waits, then Refresh ---------------------------------
async function install(notice, {status, button, consent: yes = false, dialog} = {}) {
  ++viewEpoch;
  if (button) button.disabled = true;
  try {
    const result = await post('/api/update/install', {version: notice.version, ...(notice.major && yes ? {consent: 'major'} : {})});
    dialog?.close(); closePopover();
    localFailure = null;
    startWaiting(result.install);
  } catch (error) {
    if (status) status.textContent = error.message;
    if (button) button.disabled = false;
  }
}
function startWaiting(install) {
  phase = 'updating'; target = install.display; giveUpAt = Date.now() + GIVE_UP_MS;
  holdWrites();
  document.body.classList.add('tinka-updating');
  render(); clearTimeout(pollTimer); pollTimer = setTimeout(poll, POLL_MS);
}
function stopWaiting() {
  clearTimeout(pollTimer); pollTimer = null;
  document.body.classList.remove('tinka-updating');
  releaseWrites();
}
async function poll() {
  let next = null;
  try { next = await getView(); } catch {}
  if (next && next.install?.state !== 'running') {
    view = next; stopWaiting();
    if (next.version !== pageVersion) { phase = 'ready'; target = next.display; }
    else {
      phase = 'idle';
      if (next.install?.state === 'failed') localFailure = {kind: 'failed', version: next.install.to, display: next.install.display, major: next.install.major, reason: next.install.reason};
    }
    render(); return;
  }
  if (Date.now() > giveUpAt) {
    stopWaiting(); phase = 'idle';
    localFailure = {kind: 'failed', lost: true, version: target, display: target, major: false, reason: "Tinka didn't come back within five minutes."};
    render(); return;
  }
  pollTimer = setTimeout(poll, POLL_MS);
}

// ---- Rendering -----------------------------------------------------------------
function chipHtml(state) {
  if (state.kind === 'busy') return `<span class="update-pulse" aria-hidden="true"></span><span>Updating to ${esc(state.display)}…<span class="update-long"> changes wait</span></span>`;
  if (state.kind === 'failed') return `<span>Update didn't finish</span>`;
  if (state.kind === 'check-failed') return '<span>Check failed</span>';
  return `${state.major ? '' : ICON.up}<span>Tinka ${esc(state.display)}<span class="update-long"> available</span></span>`;
}
function open(state, anchor) {
  if (state.kind === 'check-failed') return checkFailedPopover(anchor);
  if (state.kind === 'failed') return failedPopover(anchor, state);
  if (state.kind === 'review') return reviewPopover(anchor, state);
  if (state.major) return consent(state);
  return compatiblePopover(anchor, state);
}
function render() {
  const state = current();
  document.querySelectorAll('.update-refresh').forEach(element => element.remove());
  const host = surface === 'board' ? line : $('.masthead .live');
  host?.classList.toggle('update-busy', state?.kind === 'busy');
  if (!state || state.kind === 'ready') {
    document.querySelectorAll('.update-chip, .update-sep').forEach(element => element.remove());
  }
  if (state?.kind === 'ready') {
    const refresh = $('#live-refresh');
    if (surface === 'board' && refresh) {
      // The board's own Refresh saves the view and any notes before reloading.
      refresh.querySelector('.refresh-detail').textContent = `Tinka ${target} is ready · `;
      refresh.setAttribute('aria-label', `Tinka ${target} is ready · Refresh`);
      refresh.hidden = false;
    } else if (host) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'update-refresh';
      button.innerHTML = `<span class="refresh-detail">Tinka ${esc(target)} is ready · </span>Refresh`;
      button.onclick = () => location.reload();
      host.append(button);
    }
  } else if (state && host) {
    const kind = state.kind === 'busy' ? 'busy' : state.kind === 'failed' ? 'failed' : state.kind === 'review' ? 'review' : state.kind === 'check-failed' ? 'check' : state.major ? 'major' : 'minor';
    if (surface === 'board' && !host.querySelector('.update-sep')) host.insertAdjacentHTML('beforeend', '<span class="update-sep" aria-hidden="true"></span>');
    const chip = host.querySelector('.update-chip') || document.createElement('button');
    chip.type = 'button'; chip.className = 'update-chip'; chip.dataset.kind = kind;
    chip.innerHTML = chipHtml(state);
    chip.title = checkStatus();
    chip.removeAttribute('aria-disabled');chip.removeAttribute('aria-live');
    chip.removeAttribute('aria-haspopup');chip.removeAttribute('aria-expanded');chip.onclick = null;
    if (kind === 'busy') { chip.setAttribute('aria-disabled', 'true'); chip.setAttribute('aria-live', 'polite'); }
    else { chip.setAttribute('aria-haspopup', 'dialog'); chip.setAttribute('aria-expanded', String(popover?.anchor === chip)); chip.onclick = () => open(state, chip); }
    host.append(chip);
  }
  renderAbout();
  scheduleRefresh();
}
// The board Inspector's small Tinka section: the version and the update policy.
function aboutStatus() {
  const have = `<b>${esc(view.display)}</b>`;
  if (!view.installed) return `${have} · running from source`;
  if (phase === 'updating') return `${have} · updating to ${esc(target)}…`;
  if (phase === 'ready') return `${have} · ${esc(target)} is ready: Refresh to use it`;
  const notice = view.notice, latest = view.latest;
  if (notice?.kind === 'deferred') return `${have} · ${esc(notice.display)} installs next time Tinka starts`;
  if (notice?.kind === 'failed' || localFailure) return `${have} · the update to ${esc((localFailure || notice).display)} didn't finish`;
  if (notice?.kind === 'review') return `${have} · ${esc(notice.display)} needs a review`;
  if (notice) return `${have} · ${esc(notice.display)} available`;
  if (latest && view.policy === 'off') return `${have} · ${esc(latest.display)} available; updates are off`;
  if (view.policy === 'off') return `${have} · updates are off`;
  return `${have} · ${view.checkFailed || refreshError ? 'could not check for updates' : view.checkedAt ? 'up to date' : 'not checked yet'}`;
}
function renderAbout() {
  const inspector = surface === 'board' ? $('#board-info') : null;
  if (!inspector || !view) return;
  let section = inspector.querySelector('.update-about');
  if (!section) { section = document.createElement('section'); section.className = 'update-about'; section.setAttribute('aria-labelledby', 'update-about-title'); inspector.append(section); }
  const actionable = view.installed && phase === 'idle' && (localFailure || view.notice && view.notice.kind !== 'deferred');
  const updated = view.install?.state === 'updated' && phase === 'idle' && Date.now() - view.install.startedAt < 24 * 60 * 60 * 1000;
  section.innerHTML = `<h3 id="update-about-title">Tinka <span>this project</span></h3>
  <div class="update-about-row"><span class="update-about-status">${aboutStatus()}</span>${view.installed && phase === 'idle' ? `<button class="tk-btn tk-sm" type="button" data-update="${actionable ? 'open' : 'check'}">${actionable ? 'Update…' : 'Check now'}</button>` : ''}</div>
  ${view.installed ? `<div class="update-about-row"><span>Updates</span><div class="tk-seg" role="group" aria-label="Tinka updates for this project">${[['notify', 'Ask first'], ['auto', 'Automatic'], ['off', 'Off']].map(([value, label]) => `<button type="button" data-policy="${value}" aria-pressed="${view.policy === value}"${phase !== 'idle' ? ' disabled' : ''}>${label}</button>`).join('')}</div></div>
  <small>Automatic installs compatible updates as Tinka starts. Major updates always ask.</small>` : '<small>A source checkout updates through Git, not from here.</small>'}
  ${view.installed && view.policy !== 'off' ? `<small class="update-check-status">${esc(checkStatus())}</small>` : ''}
  ${updated && view.pin ? `<small>Updated from ${esc(view.install.from)} on this Mac. Commit the changed tinka/project.json with your project.</small>` : ''}
  <small class="update-about-message" role="status">${esc(aboutMessage)}</small>`;
  section.querySelector('[data-update=check]')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true; aboutMessage = 'Checking…'; renderAbout();
    try { await preference({action: 'check'}); aboutMessage = view.checkFailed ? 'Tinka could not reach its releases just now.' : view.latest ? `Tinka ${view.latest.display} is available.` : `Checked just now · ${view.display} is the latest.`; }
    catch (error) { aboutMessage = error.message; }
    renderAbout();
  });
  section.querySelector('[data-update=open]')?.addEventListener('click', event => {
    const state = localFailure || view.notice;
    open({...state, kind: state.kind === 'deferred' ? 'compatible' : state.kind}, document.querySelector('.update-chip') || event.currentTarget);
  });
  section.querySelectorAll('[data-policy]').forEach(button => button.addEventListener('click', async () => {
    if (button.getAttribute('aria-pressed') === 'true') return;
    const policy = button.dataset.policy;
    try { await preference({action: 'policy', policy}); aboutMessage = {notify: 'Tinka asks before installing updates.', auto: 'Compatible updates install as Tinka starts. Major updates still ask.', off: 'Tinka no longer checks for updates.'}[policy]; }
    catch (error) { aboutMessage = error.message; }
    renderAbout();
    section.querySelector(`[data-policy="${policy}"]`)?.focus({preventScroll: true});
  }));
}

// The server owns the per-project throttle across tabs. This page only wakes
// while visible, using the updater's next due time; installs keep their own poll.
function scheduleRefresh() {
  clearTimeout(refreshTimer);refreshTimer = null;
  if (document.hidden || phase !== 'idle' || !view?.refreshEnabled || view.install?.state === 'running' || refreshing) return;
  const due = Number.isFinite(view.nextCheckAt) ? view.nextCheckAt : 0;
  refreshTimer = setTimeout(discover, Math.max(0, due - Date.now(), refreshRetryAt - Date.now()));
}
async function discover() {
  refreshTimer = null;
  if (document.hidden || phase !== 'idle' || !view?.refreshEnabled || refreshing) return;
  const epoch = viewEpoch;
  refreshing = post('/api/update/preference', {action:'refresh'});
  try {
    const next = await refreshing;
    if (epoch !== viewEpoch) return;
    view = next;refreshError = null;
    // A busy lock or an unchanged old server response must not spin this tab.
    refreshRetryAt = next.nextCheckAt > Date.now() ? 0 : Date.now() + 60000;
    if (next.install?.state === 'running') return startWaiting(next.install);
    if (next.version !== pageVersion) { phase = 'ready';target = next.display; }
    render();
  } catch(error) {
    if (epoch === viewEpoch) { refreshError = error.message;refreshRetryAt = Date.now() + 60000;render(); }
  } finally { refreshing = null;scheduleRefresh(); }
}
async function refreshView() {
  if (phase !== 'idle' || document.hidden || refreshing) return;
  const epoch = viewEpoch;
  try {
    const next = await getView();
    if (epoch !== viewEpoch) return;
    view = next;
    if (next.install?.state === 'running') return startWaiting(next.install);
    if (next.version !== pageVersion) { phase = 'ready'; target = next.display; }
    render();
  } catch { scheduleRefresh(); }
}
async function start() {
  if (!surface || new URLSearchParams(location.search).has('overview')) return;
  try { config = await (await fetch('/api/config', {cache: 'no-store'})).json(); pageVersion = config.version; view = await getView(); }
  catch { return; }
  if (view.install?.state === 'running') startWaiting(view.install);
  else render();
  // Returning to the tab picks up an update made meanwhile, by an agent or another tab.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(refreshTimer);refreshTimer = null;
    if (!document.hidden) refreshView();
  });
}
start();
