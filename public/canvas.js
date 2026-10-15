import { watchBoard } from './live.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const world = $('world');
const plane = $('plane');
const dialog = $('reader-dialog');
const geometry = { pad: 70, gap: 68, cardWidth: 1000, rowHeight: 1220, worldTail: 300 };
const boardMatch = location.pathname.match(/^\/boards\/([a-z0-9][a-z0-9-]*)\/?$/);
const boardId = boardMatch?.[1];
const boardApi = `/api/boards/${encodeURIComponent(boardId || '')}`;
let notesKey, headerKey, viewKey, workspaceId;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

let board = null;
let appTitle = 'Tinka';
let rounds = [];
let revisions = {};
let all = [];
let currentRound = 0;
let zoom = .5;
let notes = {};
let active = null;
let activeRevision = null;
let liveSnapshot = null;
let restoreFocus = null;
let saveTimer;
let saveSequence = 0;
let saveQueue = Promise.resolve();
let shellReloadTimer;
let scrollFrame = 0;
const loadedPreviews = new Map();

function safeBoardPath(path) {
  if (typeof path !== 'string') return null;
  const parts = path.split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) return null;
  return `/boards/${encodeURIComponent(boardId)}/files/${parts.map(encodeURIComponent).join('/')}`;
}

function safeRemoteUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function descriptor(concept, variant = null) {
  return {
    kind: variant?.kind || concept.kind || 'html',
    path: variant?.path || concept.path || `rounds/${concept.round}/${concept.id}/index.html`,
    url: variant ? variant.url || null : concept.url || null,
    name: variant ? `${concept.name} · ${variant.name}` : concept.name,
  };
}

function standaloneHref(concept, variant = null) {
  const item = descriptor(concept, variant);
  return safeRemoteUrl(item.url) || safeBoardPath(item.path);
}

function mediaHref(item, theme = 'paper', scale = 100) {
  const params = new URLSearchParams({ board: boardId, kind: item.kind, name: item.name, theme, scale: String(scale) });
  if (item.url) params.set('url', item.url);
  else params.set('path', item.path);
  return `/app/media.html?${params}`;
}

function previewHref(concept, variant = null, theme = 'paper', scale = 100, revision = null) {
  const item = descriptor(concept, variant);
  const remote = safeRemoteUrl(item.url);
  const source = safeBoardPath(item.path);
  const href = item.kind === 'html' && !remote && source ? source : mediaHref({ ...item, url: remote }, theme, scale);
  const url = new URL(href, location.href);
  if (item.kind === 'html' && !remote) { url.searchParams.set('theme', theme); url.searchParams.set('scale', String(scale)); }
  if (revision) url.searchParams.set('v', revision);
  return url.href;
}

function readRound() {
  all = rounds.flatMap((round, row) => (round.concepts || []).map((concept, col) => ({ ...concept, round: round.id, row, col, key: `${round.id}/${concept.id}` })));
}

async function fetchBoard() {
  const response = await fetch(boardApi, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Board metadata unavailable (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data.rounds)) throw new Error('The board manifest is invalid.');
  return data;
}

async function loadAppTitle() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Workspace identity unavailable. Reload when the server is ready.');
  const config = await response.json();
  if (!config.workspaceId || !config.projectLabel) throw new Error('Workspace identity unavailable.');
  workspaceId = config.workspaceId;
  appTitle = `Tinka / ${config.projectLabel}`;
  const prefix = `tinka/${config.workspaceId}/${boardId}`;
  notesKey = `${prefix}/notes`;
  headerKey = `${prefix}/header`;
  viewKey = `${prefix}/view`;
  $('project-label').textContent = config.projectLabel;
  if (board) updateMetadata();
}

function updateMetadata() {
  document.title = `${appTitle} / ${board.title || 'Board'}`;
  document.querySelector('.brand').title = document.title;
  document.querySelector('.brand').setAttribute('aria-label', `${appTitle} home, current board ${board.title || 'Untitled board'}`);
  $('board-title').textContent = board.title || 'Untitled board';
  $('board-title-crumb').textContent = board.title || 'Untitled board';
  $('board-description').textContent = board.description || 'Working experiments and the questions they invite.';
  $('experiment-count').textContent = `${all.length} ${all.length === 1 ? 'experiment' : 'experiments'}`;
  $('round-count').textContent = `${rounds.length} ${rounds.length === 1 ? 'exploration' : 'explorations'}`;
}

function buildCanvas() {
  const cards = round => all.filter(concept => concept.round === round.id).map(concept => {
    const versions = revisions[concept.key] || [];
    const revisionButtons = versions.map(variant => `<button class="revision-button" type="button" data-open="${esc(concept.key)}" data-revision="${esc(variant.id)}">Try ${esc(variant.name)} ↗</button>`).join('');
    const handoff = safeBoardPath(concept.handoff);
    return `<article class="concept-card" data-key="${esc(concept.key)}"><header class="card-label"><div class="card-title"><span class="card-number">${esc(concept.number || String(concept.col + 1).padStart(2, '0'))}</span><h3>${esc(concept.name)}</h3><span class="card-category">${esc(concept.category || '')}</span></div><div class="card-actions">${revisionButtons}<button type="button" data-open="${esc(concept.key)}">Open experiment ↗</button>${handoff ? `<a class="handoff-link" href="${esc(handoff)}" target="_blank" rel="noopener">Handoff ↗</a>` : ''}</div></header><div class="preview"><iframe src="${esc(previewHref(concept, null, concept.tone === 'night' ? 'night' : 'paper'))}" title="${esc(concept.name)} preview" tabindex="-1" loading="eager" inert></iframe><button class="preview-launch" type="button" data-open="${esc(concept.key)}" aria-label="Explore ${esc(concept.name)}"><span>Open ${esc(concept.name)} ↗</span></button></div><div class="card-copy"><div><p>${esc(concept.description || '')}</p><p class="question">${esc(concept.question || '')}</p></div><div class="note-box"><button class="shortlist" type="button" data-star="${esc(concept.key)}" aria-label="Shortlist ${esc(concept.name)}" aria-pressed="false">☆</button><label>THOUGHTS TO RETURN TO<textarea data-note="${esc(concept.key)}" placeholder="What feels right? What gets in the way?" aria-label="Notes on ${esc(concept.name)}"></textarea></label></div></div></article>`;
  }).join('');
  world.innerHTML = rounds.map(round => `<section class="round" aria-labelledby="round-${esc(round.id)}"><header class="round-header"><span class="round-label">ROUND ${esc(round.number || '')} · ${esc(round.date || '')}</span><h2 id="round-${esc(round.id)}">${esc(round.title || 'Exploration')}</h2><p>${esc(round.description || '')}</p></header><div class="concepts">${cards(round)}</div></section>`).join('') + '<section class="future-row"><span>CONTINUE EXPLORING</span><h2>Room for what comes next.</h2><p>New explorations can join this board without replacing earlier work.</p></section>';
  $('round-picker').innerHTML = rounds.map((round, index) => `<option value="${index}">Round ${esc(round.number || index + 1)}</option>`).join('');
  decorateBuildCards();
  renderNav();
  updateMetadata();
}

function renderNav() {
  const round = rounds[currentRound];
  $('round-picker').value = String(currentRound);
  $('round-status').textContent = round ? `Round ${round.number || currentRound + 1} / ${round.date || round.id}` : 'No explorations yet';
  $('concept-nav').innerHTML = round ? all.filter(concept => concept.row === currentRound).map(concept => `<button type="button" data-jump="${esc(concept.key)}" aria-current="false"><span>${esc(concept.number || '')}</span>${esc(concept.name)}</button>`).join('') : '';
  updatePlane();
}

function updatePlane() {
  const columns = Math.max(1, ...rounds.map(round => round.concepts?.length || 0));
  const width = geometry.pad * 2 + columns * geometry.cardWidth + (columns - 1) * geometry.gap;
  const height = geometry.pad * 2 + rounds.length * geometry.rowHeight + geometry.worldTail;
  world.style.transform = `scale(${zoom})`;
  plane.style.width = `${width * zoom}px`;
  plane.style.height = `${height * zoom}px`;
  $('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
}

function changeZoom(value, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) {
  const next = Math.max(.05, Math.min(1.25, value));
  const x = (viewport.scrollLeft + cx) / zoom;
  const y = (viewport.scrollTop + cy) / zoom;
  zoom = next;
  updatePlane();
  viewport.scrollLeft = x * zoom - cx;
  viewport.scrollTop = y * zoom - cy;
}

function jump(key) {
  const concept = all.find(item => item.key === key);
  if (!concept) return;
  if (currentRound !== concept.row) { currentRound = concept.row; renderNav(); }
  if (zoom < .4) changeZoom(.5, 0, 0);
  viewport.scrollTo({ left: (geometry.pad + concept.col * (geometry.cardWidth + geometry.gap)) * zoom - 25, top: concept.row * geometry.rowHeight * zoom, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  document.querySelectorAll('[data-jump]').forEach(button => button.setAttribute('aria-current', String(button.dataset.jump === key)));
}

function setReaderSize() {
  if ($('reader-size').value === 'custom') return;
  const viewer = $('reader-window');
  viewer.style.removeProperty('width');
  viewer.style.removeProperty('height');
  viewer.dataset.size = $('reader-size').value;
}

function sendPreferences() {
  $('active-reader').contentWindow?.postMessage({ type: 'reader-preferences', theme: $('reader-theme').value, scale: Number($('reader-type').value) }, location.origin);
}

function currentVariant() { return (revisions[active?.key] || []).find(variant => variant.id === $('reader-revision').value) || null; }
function activeSourceKey() {
  if (!active) return null;
  const variant = currentVariant();
  const parts = variant?.path?.split('/') || [];
  const sourceKey = parts[0] === 'rounds' && parts.length > 2 ? `${parts[1]}/${parts[2]}` : active.key;
  return liveSnapshot?.concepts?.[sourceKey] ? sourceKey : active.key;
}

function loadRevision() {
  if (!active) return;
  const variant = currentVariant();
  $('reader-hint').textContent = variant?.hint || active.hint || '';
  $('active-reader').title = `${active.name}${variant ? ` · ${variant.name}` : ''} experiment`;
  const standalone = standaloneHref(active, variant);
  $('reader-standalone').hidden = !standalone;
  if (standalone) $('reader-standalone').href = standalone;
  activeRevision = liveSnapshot?.concepts?.[activeSourceKey()]?.revision || null;
  $('reader-update').hidden = true;
  $('active-reader').src = previewHref(active, variant, $('reader-theme').value, Number($('reader-type').value), activeRevision || 'initial');
  history.replaceState(null, '', `#${active.key}${variant ? `~${variant.id}` : ''}`);
}

function openReader(key, revision = 'original') {
  const concept = all.find(item => item.key === key);
  if (!concept) return;
  active = concept;
  restoreFocus = document.activeElement;
  $('reader-name').textContent = active.name;
  $('reader-number').textContent = `EXPERIMENT ${active.number || ''}`;
  $('reader-theme').value = active.tone === 'night' ? 'night' : 'paper';
  $('reader-type').value = '100';
  $('reader-size').value = 'fit';
  setReaderSize();
  const versions = revisions[key] || [];
  $('revision-label').hidden = !versions.length;
  $('reader-revision').innerHTML = '<option value="original">Original</option>' + versions.map(variant => `<option value="${esc(variant.id)}">${esc(variant.name)}</option>`).join('');
  $('reader-revision').value = versions.some(variant => variant.id === revision) ? revision : 'original';
  loadRevision();
  if (!dialog.open) dialog.showModal();
}

function closeReader() {
  const left = viewport.scrollLeft;
  const top = viewport.scrollTop;
  if (dialog.open) dialog.close();
  $('active-reader').src = 'about:blank';
  history.replaceState(null, '', rounds[currentRound] ? `#round-${rounds[currentRound].id}` : location.pathname);
  if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  viewport.scrollTo({ left, top, behavior: 'instant' });
  active = null;
}

function applyNotes() {
  document.querySelectorAll('[data-note]').forEach(element => element.value = notes[element.dataset.note]?.note || '');
  document.querySelectorAll('[data-star]').forEach(element => { const starred = Boolean(notes[element.dataset.star]?.star); element.setAttribute('aria-pressed', String(starred)); element.textContent = starred ? '★' : '☆'; });
}

function localNotes(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function mergeNotes(base, incoming) {
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (!value || typeof value !== 'object') continue;
    if (!base[key] || (Number(value.updatedAt) || 0) > (Number(base[key].updatedAt) || 0)) { base[key] = value; changed = true; }
  }
  return changed;
}

function storeNotes() {
  const revision = ++saveSequence;
  try { localStorage.setItem(notesKey, JSON.stringify(notes)); } catch {}
  $('save-status').textContent = 'Saving notes…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = JSON.stringify(notes);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try {
        const response = await fetch(`${boardApi}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Tinka-Workspace': workspaceId }, body });
        if (!response.ok) throw new Error('Save failed');
        if (revision === saveSequence) $('save-status').textContent = 'Notes saved on this Mac';
      } catch { if (revision === saveSequence) $('save-status').textContent = 'Saved in this browser · export notes for a backup'; }
    });
  }, 350);
}

async function loadNotes() {
  const backup = localNotes(notesKey);
  let server = {};
  let connected = false;
  try {
    const response = await fetch(`${boardApi}/notes`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Notes unavailable');
    const value = await response.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) server = value;
    connected = true;
  } catch {}
  notes = { ...server };
  const backupChanged = mergeNotes(notes, backup);
  const changed = backupChanged;
  $('save-status').textContent = connected ? 'Notes saved on this Mac' : 'Browser notes · local service unavailable';
  applyNotes();
  if (changed) storeNotes();
}

function decorateBuildCards() {
  document.querySelectorAll('.concept-card').forEach(card => {
    const badge = document.createElement('span'); badge.className = 'build-badge'; badge.textContent = 'Connecting'; card.querySelector('.card-title').append(badge);
    const overlay = document.createElement('div'); overlay.className = 'build-overlay'; overlay.hidden = true;
    const orbit = document.createElement('i'); orbit.className = 'build-orbit'; orbit.setAttribute('aria-hidden', 'true');
    overlay.append(orbit, document.createElement('strong'), document.createElement('span'));
    card.querySelector('.preview').append(overlay);
  });
}

function applyBoardSnapshot(snapshot) {
  liveSnapshot = snapshot;
  const labels = { building: 'Building', reserved: 'Reserved', review: 'Ready to review', ready: 'Ready' };
  document.querySelectorAll('.concept-card').forEach(card => {
    const key = card.dataset.key;
    const entry = snapshot.concepts[key];
    if (!entry) return;
    const state = labels[entry.state] ? entry.state : 'reserved';
    card.dataset.buildState = state;
    card.dataset.liveRevision = entry.revision;
    const badge = card.querySelector('.build-badge'); badge.textContent = labels[state]; badge.title = entry.message || labels[state];
    const overlay = card.querySelector('.build-overlay'); overlay.hidden = !['building', 'reserved'].includes(state);
    overlay.querySelector('strong').textContent = state === 'building' ? 'Taking shape.' : 'A place for a new idea.';
    overlay.querySelector('span').textContent = entry.message || (state === 'building' ? 'This experiment is being built. Its preview will appear when it is ready to review.' : 'This slot is reserved for a future experiment.');
    card.querySelectorAll('[data-open]').forEach(button => button.disabled = state === 'reserved' || state === 'building');
    const frame = card.querySelector('iframe');
    if (state === 'ready' || state === 'review') {
      if (loadedPreviews.has(key) && loadedPreviews.get(key) !== entry.revision) {
        const concept = all.find(item => item.key === key);
        frame.src = previewHref(concept, null, concept.tone === 'night' ? 'night' : 'paper', 100, entry.revision);
        card.classList.remove('just-landed');
        requestAnimationFrame(() => card.classList.add('just-landed'));
        setTimeout(() => card.classList.remove('just-landed'), 1800);
      }
      loadedPreviews.set(key, entry.revision);
    } else if (!loadedPreviews.has(key)) loadedPreviews.set(key, null);
  });
  const activeEntry = snapshot.concepts[activeSourceKey()];
  if (active && activeEntry) {
    if (!activeRevision) activeRevision = activeEntry.revision;
    $('reader-update').hidden = activeRevision === activeEntry.revision || !['ready', 'review'].includes(activeEntry.state);
  }
  const entries = all.map(concept => snapshot.concepts[concept.key]).filter(Boolean);
  const building = entries.filter(entry => entry.state === 'building').length;
  const review = entries.filter(entry => entry.state === 'review').length;
  const ready = entries.filter(entry => entry.state === 'ready').length;
  const parts = [building ? `${building} building` : null, review ? `${review} to review` : null, ready ? `${ready} ready` : null].filter(Boolean);
  $('live-status').textContent = `Live · ${parts.join(' · ') || 'Waiting for experiments'}`;
}

async function refreshManifest() {
  const fresh = await fetchBoard();
  const selected = rounds[currentRound]?.id;
  const left = viewport.scrollLeft;
  const top = viewport.scrollTop;
  const focused = document.activeElement;
  const noteKey = focused?.dataset.note;
  const selection = noteKey ? [focused.selectionStart, focused.selectionEnd] : null;
  board = fresh;
  rounds = fresh.rounds;
  revisions = fresh.revisions || {};
  readRound();
  currentRound = Math.max(0, rounds.findIndex(round => round.id === selected));
  buildCanvas();
  applyNotes();
  viewport.scrollTo({ left, top, behavior: 'instant' });
  if (active) active = all.find(concept => concept.key === active.key) || active;
  if (noteKey) {
    const note = [...document.querySelectorAll('[data-note]')].find(element => element.dataset.note === noteKey);
    if (note) { note.focus({ preventScroll: true }); note.setSelectionRange(...selection); }
  }
  if (liveSnapshot) applyBoardSnapshot(liveSnapshot);
}

function setHeaderCollapsed(collapsed) {
  const left = viewport.scrollLeft;
  const top = viewport.scrollTop;
  document.body.classList.toggle('header-collapsed', collapsed);
  const toggle = $('toggle-header');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Expand header' : 'Collapse header');
  toggle.title = collapsed ? 'Expand header' : 'Collapse header';
  toggle.textContent = collapsed ? 'Expand header' : 'Collapse header';
  viewport.scrollTo({ left, top, behavior: 'instant' });
  try { localStorage.setItem(headerKey, collapsed ? 'compact' : 'expanded'); } catch {}
}

async function reloadCanvas() {
  clearTimeout(saveTimer);
  clearTimeout(shellReloadTimer);
  try { sessionStorage.setItem(viewKey, JSON.stringify({ zoom, left: viewport.scrollLeft, top: viewport.scrollTop, round: rounds[currentRound]?.id })); } catch {}
  if (saveSequence) {
    try { await saveQueue; await fetch(`${boardApi}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Tinka-Workspace': workspaceId }, body: JSON.stringify(notes) }); } catch {}
  }
  location.reload();
}

function scheduleShellReload() {
  $('live-refresh').hidden = false;
  clearTimeout(shellReloadTimer);
  shellReloadTimer = setTimeout(() => {
    if (dialog.open || document.activeElement?.matches('textarea,input,[contenteditable="true"]')) { scheduleShellReload(); return; }
    reloadCanvas();
  }, 1200);
}

function showError(message) {
  $('board-error').textContent = message;
  $('board-error').hidden = false;
  $('save-status').textContent = 'Board unavailable';
}

// Controls are bound once; board content is replaced only after a manifest update.
document.addEventListener('click', event => {
  const open = event.target.closest('[data-open]');
  const nav = event.target.closest('[data-jump]');
  const star = event.target.closest('[data-star]');
  if (open && !open.disabled) openReader(open.dataset.open, open.dataset.revision);
  if (nav) jump(nav.dataset.jump);
  if (star) {
    const key = star.dataset.star;
    notes[key] = { ...notes[key], star: !notes[key]?.star, updatedAt: Date.now() };
    applyNotes();
    storeNotes();
  }
});
document.addEventListener('input', event => {
  const key = event.target.dataset.note;
  if (key) { notes[key] = { ...notes[key], note: event.target.value, updatedAt: Date.now() }; storeNotes(); }
});
$('zoom-in').onclick = () => changeZoom(zoom + .1);
$('zoom-out').onclick = () => changeZoom(zoom - .1);
$('overview').onclick = () => { changeZoom(Math.min(.5, (viewport.clientWidth - 20) / world.scrollWidth), 0, 0); viewport.scrollTo(0, 0); };
$('reset-view').onclick = () => { changeZoom(.5, 0, 0); if (all.length) jump(all.find(concept => concept.row === currentRound)?.key || all[0].key); };
$('help').onclick = () => { $('help-panel').hidden = !$('help-panel').hidden; $('help').setAttribute('aria-expanded', String(!$('help-panel').hidden)); };
$('close-reader').onclick = closeReader;
dialog.addEventListener('cancel', event => { event.preventDefault(); closeReader(); });
$('reader-revision').onchange = loadRevision;
$('round-picker').onchange = () => { currentRound = Number($('round-picker').value); renderNav(); const first = all.find(concept => concept.row === currentRound); if (first) jump(first.key); };
$('reader-size').onchange = setReaderSize;
$('reader-theme').onchange = sendPreferences;
$('reader-type').onchange = sendPreferences;
window.addEventListener('message', event => { if (event.origin === location.origin && event.source === $('active-reader').contentWindow && event.data?.type === 'reader-close') closeReader(); });
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ board: boardId, title: board?.title || 'Board', exportedAt: new Date().toISOString(), notes }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${boardId}-notes.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
let pan = null;
viewport.addEventListener('pointerdown', event => { if (event.button !== 0 || event.target.closest('button,textarea,a,input,select')) return; pan = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.setPointerCapture(event.pointerId); viewport.classList.add('panning'); });
viewport.addEventListener('pointermove', event => { if (!pan) return; viewport.scrollLeft = pan.left - (event.clientX - pan.x); viewport.scrollTop = pan.top - (event.clientY - pan.y); });
function stopPan() { pan = null; viewport.classList.remove('panning'); }
viewport.addEventListener('pointerup', stopPan);
viewport.addEventListener('pointercancel', stopPan);
viewport.addEventListener('wheel', event => { if (!event.ctrlKey) return; event.preventDefault(); const rect = viewport.getBoundingClientRect(); changeZoom(zoom * Math.exp(-event.deltaY * .005), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
new ResizeObserver(() => { if ($('reader-window').style.width) $('reader-size').value = 'custom'; }).observe($('reader-window'));
viewport.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!rounds.length) return;
    const row = Math.max(0, Math.min(rounds.length - 1, Math.floor((viewport.scrollTop / zoom + 130) / geometry.rowHeight)));
    if (row !== currentRound) { currentRound = row; renderNav(); }
  });
}, { passive: true });
window.addEventListener('hashchange', () => {
  const [key, revision] = decodeURIComponent(location.hash.slice(1)).split('~');
  const concept = all.find(item => item.key === key);
  if (concept) { currentRound = concept.row; renderNav(); jump(key); openReader(key, revision); return; }
  const row = rounds.findIndex(round => key === `round-${round.id}`);
  if (row >= 0) { currentRound = row; if (active) closeReader(); renderNav(); const first = all.find(item => item.row === row); if (first) jump(first.key); }
});
$('toggle-header').onclick = () => setHeaderCollapsed(!document.body.classList.contains('header-collapsed'));
$('live-refresh').onclick = reloadCanvas;
$('reader-update').onclick = loadRevision;

if (!boardId) showError('This board address is invalid. Return to Boards and open a board from there.');
else {
  try {
    await loadAppTitle();
    board = await fetchBoard();
    rounds = board.rounds;
    revisions = board.revisions || {};
    readRound();
    currentRound = Math.max(0, rounds.length - 1);
    buildCanvas();
    await loadNotes();
    let compactHeader = true;
    try { compactHeader = localStorage.getItem(headerKey) !== 'expanded'; } catch {}
    setHeaderCollapsed(compactHeader);
    const requested = decodeURIComponent(location.hash.slice(1));
    const [requestedKey, requestedRevision] = requested.split('~');
    const concept = all.find(item => item.key === requestedKey);
    if (concept) { currentRound = concept.row; renderNav(); jump(concept.key); openReader(requestedKey, requestedRevision); }
    else {
      const index = rounds.findIndex(round => requested === `round-${round.id}`);
      if (index >= 0) currentRound = index;
      renderNav();
      requestAnimationFrame(() => { viewport.scrollTop = currentRound * geometry.rowHeight * zoom; });
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(viewKey) || 'null');
      sessionStorage.removeItem(viewKey);
      if (saved && Number.isFinite(saved.zoom)) {
        zoom = Math.max(.05, Math.min(1.25, saved.zoom));
        currentRound = Math.max(0, rounds.findIndex(round => round.id === saved.round));
        renderNav();
        requestAnimationFrame(() => viewport.scrollTo({ left: saved.left, top: saved.top, behavior: 'instant' }));
      }
    } catch {}
    $('live-status').classList.add('live-indicator');
    watchBoard(boardId, {
      onSnapshot: applyBoardSnapshot,
      onManifestChange: refreshManifest,
      onShellChange: scheduleShellReload,
      onConnection: connected => { const label = $('live-status'); label.dataset.connection = connected ? 'live' : 'offline'; if (!connected) label.textContent = 'Reconnecting to this Mac…'; else if (liveSnapshot && label.textContent.startsWith('Reconnecting')) applyBoardSnapshot(liveSnapshot); },
    });
  } catch (error) { showError(error.message || 'This board could not be loaded.'); }
}
