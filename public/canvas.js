import { watchBoard } from './live.js';
import { openRemovalPrompt } from './agent-prompt.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const world = $('world');
const plane = $('plane');
const dialog = $('reader-dialog');
const slider = $('zoom-slider');
const track = $('dot-track');
const tooltip = $('dot-tooltip');
const sizeMenu = $('size-menu');
const geometry = { pad: 70, gap: 68, cardWidth: 1000, rowHeight: 1220, worldTail: 300 };
const MIN_ZOOM = .05;
const MAX_ZOOM = 1.25;
const SIZE_NAMES = { fit: 'Fit', custom: 'Custom', compact: 'Compact', standard: 'Standard', wide: 'Wide' };
const boardMatch = location.pathname.match(/^\/boards\/([a-z0-9][a-z0-9-]*)\/?$/);
const boardId = boardMatch?.[1];
const boardApi = `/api/boards/${encodeURIComponent(boardId || '')}`;
let notesKey, viewKey, workspaceId;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const clampZoom = value => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

let board = null;
let appTitle = 'Tinka';
let appConfig;
let rounds = [];
let revisions = {};
let all = [];
let currentRound = 0;
let zoom = .5;
let notes = {};
let active = null;
let activeVariantId = 'original';
let activeRevision = null;
let liveSnapshot = null;
let saveTimer;
let saveSequence = 0;
let saveQueue = Promise.resolve();
let shellReloadTimer;
let scrollFrame = 0;
let routedHash = null;
let notesOpen = false;
let dotSignature = '';
let scrub = null;
let noteFieldKey = null;
const readerView = { size: 'fit', theme: 'paper', type: 100 };
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

function mediaHref(item, theme = 'paper', scale = 100, inReader = false) {
  const params = new URLSearchParams({ board: boardId, kind: item.kind, name: item.name, theme, scale: String(scale) });
  if (item.url) params.set('url', item.url);
  else params.set('path', item.path);
  // The experiment view already names the item and links to it; its media page needs no header of its own.
  if (inReader) params.set('chrome', 'none');
  return `/app/media.html?${params}`;
}

function previewHref(concept, variant = null, theme = 'paper', scale = 100, revision = null, inReader = false) {
  const item = descriptor(concept, variant);
  const remote = safeRemoteUrl(item.url);
  const source = safeBoardPath(item.path);
  const href = item.kind === 'html' && !remote && source ? source : mediaHref({ ...item, url: remote }, theme, scale, inReader);
  const url = new URL(href, location.href);
  if (item.kind === 'html' && !remote) { url.searchParams.set('theme', theme); url.searchParams.set('scale', String(scale)); }
  if (revision) url.searchParams.set('v', revision);
  return url.href;
}

// Assigning a frame's src adds an entry to the tab's session history, so browser Back would step inside the
// frame. Replacing the frame's location keeps Back and Forward for Tinka's own places.
function replaceFrame(frame, url) {
  try { if (frame.contentWindow) { frame.contentWindow.location.replace(url); return; } } catch {}
  frame.src = url;
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
  appConfig = config;
  workspaceId = config.workspaceId;
  appTitle = `Tinka / ${config.projectLabel}`;
  const prefix = `tinka/${config.workspaceId}/${boardId}`;
  notesKey = `${prefix}/notes`;
  viewKey = `${prefix}/view`;
  $('project-label').textContent = config.projectLabel;
  $('reader-project').textContent = config.projectLabel;
  document.querySelectorAll('.brand').forEach(brand => { brand.setAttribute('aria-label', `${appTitle} home`); brand.title = `${appTitle} · all boards`; });
  if (board) updateMetadata();
}

function updateMetadata() {
  const title = board.title || 'Untitled board';
  document.title = active && dialog.open ? `${appTitle} / ${title} / ${descriptor(active, currentVariant()).name}` : `${appTitle} / ${title}`;
  $('board-title').textContent = title;
  $('board-title').title = title;
  $('reader-board-link').textContent = title;
  $('reader-board-link').setAttribute('aria-label', `Back to board ${title}`);
  $('board-description').textContent = board.description || 'Working experiments and the questions they invite.';
  $('experiment-count').textContent = `${all.length} ${all.length === 1 ? 'experiment' : 'experiments'}`;
  $('round-count').textContent = `${rounds.length} ${rounds.length === 1 ? 'exploration' : 'explorations'}`;
}

function buildCanvas() {
  const cards = round => all.filter(concept => concept.round === round.id).map(concept => {
    const versions = revisions[concept.key] || [];
    const revisionButtons = versions.map(variant => `<button class="revision-button" type="button" data-open="${esc(concept.key)}" data-revision="${esc(variant.id)}">Try ${esc(variant.name)} ↗</button>`).join('');
    const handoff = safeBoardPath(concept.handoff);
    return `<article class="concept-card" data-key="${esc(concept.key)}"><header class="card-label"><div class="card-title"><span class="card-number">${esc(concept.number || String(concept.col + 1).padStart(2, '0'))}</span><h3>${esc(concept.name)}</h3><span class="card-category">${esc(concept.category || '')}</span></div><div class="card-actions">${revisionButtons}<button type="button" data-open="${esc(concept.key)}">Open experiment ↗</button>${handoff ? `<a class="handoff-link" href="${esc(handoff)}" target="_blank" rel="noopener">Handoff ↗</a>` : ''}<button class="remove-action" type="button" data-remove-experiment="${esc(concept.key)}" aria-label="Remove ${esc(concept.name)} from board" title="Get a removal prompt">Remove…</button></div></header><div class="preview"><iframe src="${esc(previewHref(concept, null, concept.tone === 'night' ? 'night' : 'paper'))}" title="${esc(concept.name)} preview" tabindex="-1" loading="eager" inert></iframe><button class="preview-launch" type="button" data-open="${esc(concept.key)}" aria-label="Explore ${esc(concept.name)}"><span>Open ${esc(concept.name)} ↗</span></button></div><div class="card-copy"><div><p>${esc(concept.description || '')}</p><p class="question">${esc(concept.question || '')}</p></div><div class="note-box"><button class="shortlist" type="button" data-star="${esc(concept.key)}" aria-label="Shortlist ${esc(concept.name)}" aria-pressed="false">☆</button><label>THOUGHTS TO RETURN TO<textarea data-note="${esc(concept.key)}" placeholder="What feels right? What gets in the way?" aria-label="Notes on ${esc(concept.name)}"></textarea></label></div></div></article>`;
  }).join('');
  world.innerHTML = rounds.map(round => `<section class="round" aria-labelledby="round-heading-${esc(round.id)}"><header class="round-header"><span class="round-label">ROUND ${esc(round.number || '')} · ${esc(round.date || '')}</span><h2 id="round-heading-${esc(round.id)}">${esc(round.title || 'Exploration')}</h2><p>${esc(round.description || '')}</p></header><div class="concepts">${cards(round)}</div></section>`).join('') + '<section class="future-row"><span>CONTINUE EXPLORING</span><h2>Room for what comes next.</h2><p>New explorations can join this board without replacing earlier work.</p></section>';
  decorateBuildCards();
  renderNav();
  updateMetadata();
}

function renderNav() {
  const round = rounds[currentRound];
  $('round-status').textContent = round ? `Round ${round.number || currentRound + 1} / ${round.date || round.id}` : 'No explorations yet';
  updatePlane();
}

// ---- Board canvas: native scrolling pans; the slider, Fit and pinch gestures zoom. ----
function updatePlane() {
  const columns = Math.max(1, ...rounds.map(round => round.concepts?.length || 0));
  const width = geometry.pad * 2 + columns * geometry.cardWidth + (columns - 1) * geometry.gap;
  const height = geometry.pad * 2 + rounds.length * geometry.rowHeight + geometry.worldTail;
  world.style.transform = `scale(${zoom})`;
  plane.style.width = `${width * zoom}px`;
  // When the whole board fits, centre it vertically (it is centred horizontally by CSS).
  // Otherwise leave enough canvas below the last row to align it even in a tall window.
  const scaledHeight = world.offsetHeight * zoom;
  const fits = rounds.length > 0 && scaledHeight <= viewport.clientHeight;
  const lastRowTop = Math.max(0, rounds.length - 1) * geometry.rowHeight * zoom;
  plane.style.marginTop = fits ? `${Math.floor((viewport.clientHeight - scaledHeight) / 2)}px` : '0px';
  plane.style.height = `${fits ? scaledHeight : Math.max(height * zoom, lastRowTop + viewport.clientHeight)}px`;
  const percent = Math.round(zoom * 100);
  slider.value = String(percent);
  slider.setAttribute('aria-valuetext', `${percent} percent`);
  slider.title = `Zoom ${percent}%`;
}

function changeZoom(value, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) {
  const next = clampZoom(value);
  const x = (viewport.scrollLeft + cx - plane.offsetLeft) / zoom;
  const y = (viewport.scrollTop + cy - plane.offsetTop) / zoom;
  zoom = next;
  updatePlane();
  viewport.scrollLeft = x * zoom + plane.offsetLeft - cx;
  viewport.scrollTop = y * zoom + plane.offsetTop - cy;
}

function fitBoard() {
  const margin = 24;
  const contentWidth = world.offsetWidth - geometry.pad * 2;
  const contentHeight = world.offsetHeight - geometry.pad * 2;
  if (contentWidth <= 0 || contentHeight <= 0) return;
  zoom = clampZoom(Math.min((viewport.clientWidth - margin * 2) / contentWidth, (viewport.clientHeight - margin * 2) / contentHeight));
  updatePlane();
  viewport.scrollTo({ left: Math.max(0, geometry.pad * zoom - margin), top: Math.max(0, geometry.pad * zoom - margin), behavior: 'instant' });
}

function jump(key) {
  const concept = all.find(item => item.key === key);
  if (!concept) return;
  if (currentRound !== concept.row) { currentRound = concept.row; renderNav(); }
  if (zoom < .4) changeZoom(.5, 0, 0);
  viewport.focus({ preventScroll: true });
  viewport.scrollTo({ left: (geometry.pad + concept.col * (geometry.cardWidth + geometry.gap)) * zoom - 25, top: concept.row * geometry.rowHeight * zoom, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function viewportPoint(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  return [clientX - rect.left, clientY - rect.top];
}

// ---- Browser history: each place-changing navigation is one real entry. ----
function decodeHash(hash) {
  try { return decodeURIComponent(String(hash || '').replace(/^#/, '')); } catch { return null; }
}

function parseHash(hash = location.hash) {
  const raw = decodeHash(hash);
  if (!raw) return { view: 'board', round: null, invalid: raw === null };
  const row = rounds.findIndex(round => raw === `round-${round.id}`);
  if (row >= 0) return { view: 'board', round: rounds[row].id };
  const [key, revision] = raw.split('~');
  if (all.some(concept => concept.key === key)) return { view: 'experiment', key, revision: (revisions[key] || []).some(variant => variant.id === revision) ? revision : null };
  return { view: 'board', round: null, invalid: true };
}

function hashFor(state) {
  if (state.view === 'experiment') return `#${state.key}${state.revision ? `~${state.revision}` : ''}`;
  return state.round ? `#round-${state.round}` : '';
}

function commitHistory(state, mode) {
  if (mode !== 'push' && mode !== 'replace') return;
  const hash = hashFor(state);
  if (decodeHash(location.hash) === decodeHash(hash) && (mode === 'push' || location.hash === hash)) return;
  const url = `${location.pathname}${location.search}${hash}`;
  if (mode === 'push') history.pushState(null, '', url);
  else history.replaceState(history.state, '', url);
  routedHash = location.hash;
}

function readerState() {
  return { view: 'experiment', key: active.key, revision: activeVariantId === 'original' ? null : activeVariantId };
}

// Back and Forward render the state in the URL; they never add entries of their own.
function route() {
  if (!board || location.hash === routedHash) return;
  const state = parseHash();
  if (state.invalid) commitHistory({ view: 'board', round: null }, 'replace');
  routedHash = location.hash;
  if (state.view === 'experiment') { openReader(state.key, state.revision || 'original', { history: 'replace' }); return; }
  if (dialog.open || active) { closeReader({ history: 'none' }); return; }
  const row = rounds.findIndex(round => round.id === state.round);
  if (row >= 0) {
    currentRound = row;
    renderNav();
    const first = all.find(item => item.row === row);
    if (first) jump(first.key);
    else viewport.scrollTo({ top: row * geometry.rowHeight * zoom, behavior: 'instant' });
  }
}

// ---- Experiment view ----
function currentVariant() { return (revisions[active?.key] || []).find(variant => variant.id === activeVariantId) || null; }
function activeSourceKey() {
  if (!active) return null;
  const variant = currentVariant();
  const parts = variant?.path?.split('/') || [];
  const sourceKey = parts[0] === 'rounds' && parts.length > 2 ? `${parts[1]}/${parts[2]}` : active.key;
  return liveSnapshot?.concepts?.[sourceKey] ? sourceKey : active.key;
}

function focusReader() {
  if (dialog.open) $('active-reader').focus({ preventScroll: true });
}

function sendPreferences() {
  $('active-reader').contentWindow?.postMessage({ type: 'reader-preferences', theme: readerView.theme, scale: readerView.type }, location.origin);
}

function renderSizeControls(layout = true) {
  const viewer = $('reader-window');
  const size = readerView.size;
  const customText = `${Math.round(viewer.offsetWidth)} × ${Math.round(viewer.offsetHeight)}`;
  const variant = currentVariant();
  const label = `Window size: ${SIZE_NAMES[size]}${size === 'custom' ? ` ${customText}` : ''}${variant ? `. Version: ${variant.name}` : ''}`;
  $('size-value').textContent = SIZE_NAMES[size];
  $('size-trigger').setAttribute('aria-label', label);
  $('size-trigger').title = (revisions[active?.key] || []).length ? `${label} · choose a window size or version` : label;
  $('reader-fit').setAttribute('aria-pressed', String(size === 'fit'));
  sizeMenu.querySelectorAll('[data-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.size === size)));
  sizeMenu.querySelector('[data-size="custom"]').hidden = size !== 'custom';
  $('custom-size').textContent = customText;
  if (layout) layoutReaderFooter();
}

function setReaderSize(size) {
  const viewer = $('reader-window');
  readerView.size = SIZE_NAMES[size] ? size : 'fit';
  if (readerView.size !== 'custom') {
    viewer.style.removeProperty('width');
    viewer.style.removeProperty('height');
    viewer.dataset.size = readerView.size;
  }
  renderSizeControls();
}

function setTheme(theme, send = true) {
  readerView.theme = theme === 'night' ? 'night' : 'paper';
  const night = readerView.theme === 'night';
  $('reader-theme').setAttribute('aria-pressed', String(night));
  $('reader-theme').title = night ? 'Light: Night · switch to Paper' : 'Light: Paper · switch to Night';
  if (send) sendPreferences();
}

function setType(value, send = true) {
  readerView.type = [100, 115, 130].includes(Number(value)) ? Number(value) : 100;
  const input = $('reader-type');
  input.value = String(readerView.type);
  input.setAttribute('aria-valuetext', `${readerView.type}%`);
  input.title = `Type size ${readerView.type}%`;
  if (send) sendPreferences();
}

function openSizeMenu() {
  sizeMenu.hidden = false;
  $('size-trigger').setAttribute('aria-expanded', 'true');
  (sizeMenu.querySelector('button[aria-pressed="true"]:not([hidden])') || sizeMenu.querySelector('button:not([hidden])')).focus({ preventScroll: true });
}

function closeSizeMenu(refocus = true) {
  if (sizeMenu.hidden) return;
  sizeMenu.hidden = true;
  $('size-trigger').setAttribute('aria-expanded', 'false');
  if (refocus) $('size-trigger').focus({ preventScroll: true });
}

function renderRevisionOptions() {
  const versions = revisions[active?.key] || [];
  $('revision-group').hidden = !versions.length;
  $('revision-options').innerHTML = versions.length ? [{ id: 'original', name: 'Original' }, ...versions].map(variant => `<button type="button" data-revision-choice="${esc(variant.id)}" aria-pressed="${variant.id === activeVariantId}"><span>${esc(variant.name)}</span></button>`).join('') : '';
}

function setNotesOpen(open, { focus = true } = {}) {
  notesOpen = open;
  $('notes-panel').hidden = !open;
  $('notes-toggle').setAttribute('aria-expanded', String(open));
  if (focus) (open ? $('reader-note') : $('notes-toggle')).focus({ preventScroll: true });
}

function syncReaderNotes() {
  if (!active) return;
  const note = notes[active.key]?.note || '';
  const field = $('reader-note');
  // Always follow a change of experiment, even mid-typing; otherwise keep the caret where the user is typing.
  if (noteFieldKey !== active.key || (field.value !== note && document.activeElement !== field)) { field.value = note; noteFieldKey = active.key; }
  const hasNote = Boolean(note.trim());
  document.querySelector('.note-dot').hidden = !hasNote;
  $('notes-toggle').setAttribute('aria-label', hasNote ? 'Notes (this experiment has a note)' : 'Notes');
  const starred = Boolean(notes[active.key]?.star);
  $('reader-star').title = starred ? 'Shortlisted · remove from shortlist' : 'Add to shortlist';
  layoutReaderHeader();
}

function renderReaderHeader() {
  if (!active) return;
  const variant = currentVariant();
  const round = rounds[active.row];
  const name = descriptor(active, variant).name;
  const hint = variant?.hint || active.hint || '';
  $('reader-name').textContent = name;
  $('reader-name').title = hint ? `${name} · ${hint}` : name;
  $('reader-star').dataset.star = active.key;
  $('reader-star').setAttribute('aria-label', `Shortlist ${active.name}`);
  $('reader-note').setAttribute('aria-label', `Notes on ${active.name}`);
  $('notes-for').textContent = `Round ${round?.number || active.row + 1} · ${active.number ? `${active.number} ` : ''}${name}`;
  $('reader-hint').textContent = hint;
  $('reader-board-link').href = `${location.pathname}${rounds[currentRound] ? `#round-${rounds[currentRound].id}` : ''}`;
  applyNotes();
}

function loadRevision({ focus = true } = {}) {
  if (!active) return;
  const variant = currentVariant();
  $('active-reader').title = `${descriptor(active, variant).name} experiment`;
  const standalone = standaloneHref(active, variant);
  $('reader-standalone').hidden = !standalone;
  if (standalone) $('reader-standalone').href = standalone;
  activeRevision = liveSnapshot?.concepts?.[activeSourceKey()]?.revision || null;
  $('reader-update').hidden = true;
  layoutReaderHeader();
  replaceFrame($('active-reader'), previewHref(active, variant, readerView.theme, readerView.type, activeRevision || 'initial', true));
  if (focus) focusReader();
}

function readerSequence() {
  return all.filter(concept => concept.key === active?.key || !['reserved', 'building'].includes(liveSnapshot?.concepts?.[concept.key]?.state));
}

function dotLabel(concept, index, total) {
  const round = rounds[concept.row];
  return `${index + 1} of ${total}: Round ${round?.number || concept.row + 1} · ${concept.number ? `${concept.number} ` : ''}${concept.name}`;
}

// Keep the current dot centred in the strip (the browser clamps at either end).
function revealDot(dot) {
  if (!dot || scrub) return;
  track.scrollLeft = dot.offsetLeft - track.offsetLeft + dot.offsetWidth / 2 - track.clientWidth / 2;
  updateTrackFade();
}

function renderDots(sequence, index) {
  const signature = sequence.map(concept => `${concept.key}\u0000${concept.name}\u0000${concept.row}`).join('\u0001');
  const focusedDot = track.contains(document.activeElement);
  if (signature !== dotSignature) {
    dotSignature = signature;
    track.innerHTML = sequence.map((concept, i) => `<button type="button" class="experiment-dot${i === 0 || concept.row !== sequence[i - 1].row ? ' group-start' : ''}" data-dot="${esc(concept.key)}" aria-label="${esc(dotLabel(concept, i, sequence.length))}" aria-pressed="false" tabindex="-1"></button>`).join('');
  }
  let current = null;
  track.querySelectorAll('[data-dot]').forEach(dot => {
    const selected = dot.dataset.dot === active?.key;
    dot.setAttribute('aria-pressed', String(selected));
    dot.tabIndex = selected ? 0 : -1;
    if (selected) current = dot;
  });
  track.setAttribute('aria-label', index < 0 ? 'Experiments on this board' : `Experiments on this board, ${index + 1} of ${sequence.length}`);
  revealDot(current);
  if (focusedDot && current && document.activeElement !== current) current.focus({ preventScroll: true });
}

// ---- Reader header and footer layout: chosen by measured fit, never a fixed breakpoint ----
// The header keeps the breadcrumb on one line while the board name and the experiment name each keep a readable
// width (or all of it, if shorter) and the item actions fit; otherwise the experiment line takes its own row.
const readerHeader = document.querySelector('.reader-header');
const NAME_MIN = 120;
function layoutReaderHeader() {
  if (!dialog.open) return;
  // On one line, each name may shrink to NAME_MIN (or its full width, if shorter) but no further.
  readerHeader.style.setProperty('--board-min', `${Math.min($('reader-board-link').scrollWidth, NAME_MIN)}px`);
  readerHeader.style.setProperty('--name-min', `${Math.min($('reader-name').scrollWidth, NAME_MIN)}px`);
  readerHeader.dataset.layout = 'row';
  const identity = readerHeader.querySelector('.identity').getBoundingClientRect();
  const last = [...readerHeader.querySelectorAll('.item-actions > :not([hidden])')].at(-1)?.getBoundingClientRect();
  if (last && last.right > identity.right + .5) readerHeader.dataset.layout = 'wrapped';
}

function layoutReaderChrome() {
  layoutReaderHeader();
  layoutReaderFooter();
}

// The footer is always one row. Its dot strip shows up to 9 dots and the arrows hug it. As room runs out, measured
// against the actual widths: the strip drops to 7, 5, then 3 dots; Back becomes a board glyph with "Board"; the
// view controls fold into a View popover; the View button drops its word; and only then does Back drop its word
// (the strip may grow again each time room is freed). The navigation stays centred on the page when it can,
// otherwise between its neighbours.
const readerFooter = document.querySelector('.reader-footer');
const STRIP_DOTS = [9, 7, 5, 3];
const DOT_WIDTH = 24;
const FOOTER_STEPS = [['full', 'inline'], ['board', 'inline'], ['board', 'folded'], ['board', 'folded-icon'], ['icon', 'folded-icon']];
function layoutReaderFooter() {
  if (!dialog.open) return;
  const nav = readerFooter.querySelector('.experiment-navigation');
  const tools = readerFooter.querySelector('.reader-tools');
  readerFooter.style.setProperty('--nav-shift', '0px');
  const navGap = parseFloat(getComputedStyle(nav).columnGap) || 0;
  const arrows = $('reader-previous').offsetWidth + $('reader-next').offsetWidth + 2 * navGap;
  const dots = track.scrollWidth;
  const room = () => {
    const gap = parseFloat(getComputedStyle(readerFooter).columnGap) || 0;
    const start = $('close-reader').getBoundingClientRect().right + gap;
    return { start, end: tools.getBoundingClientRect().left - gap };
  };
  let strip = STRIP_DOTS.at(-1);
  for (const [back, view] of FOOTER_STEPS) {
    readerFooter.dataset.back = back;
    readerFooter.dataset.tools = view;
    const { start, end } = room();
    const fit = STRIP_DOTS.find(count => arrows + Math.min(dots, count * DOT_WIDTH) <= end - start + .5);
    if (fit) { strip = fit; break; }
  }
  readerFooter.style.setProperty('--strip-dots', String(strip));
  if (readerFooter.dataset.tools === 'inline') setViewOpen(false, { focus: false });
  const box = readerFooter.getBoundingClientRect();
  const { start, end } = room();
  const slack = Math.max(0, (end - start - nav.getBoundingClientRect().width) / 2);
  const shift = Math.max(-slack, Math.min(slack, box.left + box.width / 2 - (start + end) / 2));
  readerFooter.style.setProperty('--nav-shift', `${Math.round(shift)}px`);
  revealDot(track.querySelector('[aria-pressed="true"]'));
  updateTrackFade();
}

// Fade an edge of the strip while more dots lie beyond it.
function updateTrackFade() {
  const more = track.scrollWidth - track.clientWidth;
  track.style.setProperty('--fade-start', track.scrollLeft > 1 ? '16px' : '0px');
  track.style.setProperty('--fade-end', track.scrollLeft < more - 1 ? '16px' : '0px');
}

// ---- View popover: the folded home of the view controls on narrow footers ----
const viewControls = $('view-controls');
function setViewOpen(open, { focus = true } = {}) {
  const wasOpen = viewControls.classList.contains('open');
  if (open === wasOpen) return;
  viewControls.classList.toggle('open', open);
  $('view-toggle').setAttribute('aria-expanded', String(open));
  if (!open) closeSizeMenu(false);
  if (focus) (open ? $('reader-type') : $('view-toggle')).focus({ preventScroll: true });
}

function updateReaderNavigation() {
  const sequence = readerSequence();
  const index = sequence.findIndex(concept => concept.key === active?.key);
  $('reader-position').textContent = index < 0 ? '' : `Experiment ${index + 1} of ${sequence.length}: ${active.name}`;
  track.dataset.position = index < 0 ? '' : `${index + 1} / ${sequence.length}`;
  for (const [id, offset, label] of [['reader-previous', -1, 'Previous'], ['reader-next', 1, 'Next']]) {
    const neighbor = index < 0 ? null : sequence[index + offset];
    const button = $(id);
    button.disabled = !neighbor;
    button.title = neighbor ? `${label}: ${neighbor.name}` : `No ${label.toLowerCase()} experiment`;
    button.setAttribute('aria-label', neighbor ? `${label} experiment: ${neighbor.name}` : `${label} experiment`);
  }
  renderDots(sequence, index);
  layoutReaderChrome();
}

function stepReader(offset, focus = 'reader') {
  if (!active || !dialog.open) return;
  const sequence = readerSequence();
  const index = sequence.findIndex(concept => concept.key === active.key);
  if (index >= 0 && sequence[index + offset]) openReader(sequence[index + offset].key, 'original', { focus });
}

function focusActiveDot() {
  track.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
}

function openReader(key, revision = 'original', { history: mode = 'push', focus = 'reader' } = {}) {
  const concept = all.find(item => item.key === key);
  if (!concept) return false;
  const variantId = (revisions[key] || []).some(variant => variant.id === revision) ? revision : 'original';
  if (dialog.open && active?.key === key && activeVariantId === variantId) {
    commitHistory(readerState(), mode === 'push' ? 'none' : mode);
    if (focus === 'dot') focusActiveDot(); else if (focus === 'reader') focusReader();
    return true;
  }
  const opening = !dialog.open;
  active = concept;
  activeVariantId = variantId;
  if (opening) {
    setTheme(active.tone === 'night' ? 'night' : 'paper', false);
    setType(100, false);
    setReaderSize('fit');
    closeSizeMenu(false);
    setViewOpen(false, { focus: false });
    setNotesOpen(notesOpen, { focus: false });
  }
  renderRevisionOptions();
  renderReaderHeader();
  renderSizeControls();
  updateReaderNavigation();
  loadRevision({ focus: false });
  if (opening) dialog.showModal();
  layoutReaderChrome();
  commitHistory(readerState(), mode);
  updateMetadata();
  if (focus === 'dot') focusActiveDot();
  else if (focus === 'reader') focusReader();
  return true;
}

function closeReader({ history: mode = 'push' } = {}) {
  if (!active && !dialog.open) return;
  const left = viewport.scrollLeft;
  const top = viewport.scrollTop;
  closeSizeMenu(false);
  setViewOpen(false, { focus: false });
  hideTooltip();
  scrub = null;
  if (dialog.open) dialog.close();
  replaceFrame($('active-reader'), 'about:blank');
  active = null;
  commitHistory({ view: 'board', round: rounds[currentRound]?.id || null }, mode);
  if (board) updateMetadata();
  viewport.focus({ preventScroll: true });
  viewport.scrollTo({ left, top, behavior: 'instant' });
}

// Escape closes the size panel first, then the notes panel while typing in it, otherwise returns to the board.
function handleEscape() {
  if (!sizeMenu.hidden) { closeSizeMenu(true); return; }
  if (viewControls.classList.contains('open')) { setViewOpen(false); return; }
  if (notesOpen && $('notes-panel').contains(document.activeElement)) { setNotesOpen(false); return; }
  closeReader();
}

// ---- Dot track tooltip and scrubbing ----
function showTooltip(dot) {
  if (!dot) return;
  tooltip.textContent = dot.getAttribute('aria-label');
  tooltip.hidden = false;
  const footer = document.querySelector('.reader-footer').getBoundingClientRect();
  const bounds = track.getBoundingClientRect();
  const half = tooltip.offsetWidth / 2;
  tooltip.style.left = `${Math.max(12 + half, Math.min(innerWidth - 12 - half, bounds.left + bounds.width / 2))}px`;
  tooltip.style.bottom = `${innerHeight - footer.top + 8}px`;
}

function hideTooltip() { tooltip.hidden = true; }

function scrubTo(clientX) {
  const bounds = track.getBoundingClientRect();
  if (clientX < bounds.left + 18) track.scrollLeft -= 18;
  if (clientX > bounds.right - 18) track.scrollLeft += 18;
  let nearest = null;
  track.querySelectorAll('[data-dot]').forEach(dot => {
    const rect = dot.getBoundingClientRect();
    const distance = Math.abs(clientX - rect.left - rect.width / 2);
    if (!nearest || distance < nearest.distance) nearest = { dot, distance };
  });
  if (!nearest) return;
  track.querySelectorAll('.scrubbing').forEach(dot => dot.classList.remove('scrubbing'));
  nearest.dot.classList.add('scrubbing');
  scrub.key = nearest.dot.dataset.dot;
  showTooltip(nearest.dot);
}

function endScrub(commit) {
  if (!scrub) return;
  const { key } = scrub;
  scrub = null;
  track.querySelectorAll('.scrubbing').forEach(dot => dot.classList.remove('scrubbing'));
  hideTooltip();
  if (commit && key) openReader(key, 'original', { focus: 'dot' });
}

// ---- Notes ----
function applyNotes() {
  document.querySelectorAll('[data-note]').forEach(element => { const value = notes[element.dataset.note]?.note || ''; if (element.value !== value) element.value = value; });
  document.querySelectorAll('[data-star]').forEach(element => { const starred = Boolean(notes[element.dataset.star]?.star); element.setAttribute('aria-pressed', String(starred)); element.textContent = starred ? '★' : '☆'; });
  syncReaderNotes();
}

function setSaveStatus(text, state) {
  $('save-status').textContent = text;
  $('save-status').dataset.state = state;
  $('reader-save-status').textContent = text;
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
  setSaveStatus('Saving notes…', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = JSON.stringify(notes);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try {
        const response = await fetch(`${boardApi}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Tinka-Workspace': workspaceId }, body });
        if (!response.ok) throw new Error('Save failed');
        if (revision === saveSequence) setSaveStatus('Notes saved on this Mac', 'saved');
      } catch { if (revision === saveSequence) setSaveStatus('Saved in this browser · export notes for a backup', 'local'); }
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
  const changed = mergeNotes(notes, backup);
  setSaveStatus(connected ? 'Notes saved on this Mac' : 'Browser notes · local service unavailable', connected ? 'saved' : 'local');
  applyNotes();
  if (changed) storeNotes();
}

// ---- Live build state ----
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
        replaceFrame(frame, previewHref(concept, null, concept.tone === 'night' ? 'night' : 'paper', 100, entry.revision));
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
    layoutReaderHeader();
  }
  const entries = all.map(concept => snapshot.concepts[concept.key]).filter(Boolean);
  const building = entries.filter(entry => entry.state === 'building').length;
  const review = entries.filter(entry => entry.state === 'review').length;
  const ready = entries.filter(entry => entry.state === 'ready').length;
  const parts = [building ? `${building} building` : null, review ? `${review} to review` : null, ready ? `${ready} ready` : null].filter(Boolean);
  $('live-status').textContent = `Live · ${parts.join(' · ') || 'Waiting for experiments'}`;
  if (active) updateReaderNavigation();
}

async function refreshManifest() {
  const fresh = await fetchBoard();
  const selected = rounds[currentRound]?.id;
  const left = viewport.scrollLeft;
  const top = viewport.scrollTop;
  const focused = document.activeElement;
  const noteKey = world.contains(focused) ? focused?.dataset.note : null;
  const selection = noteKey ? [focused.selectionStart, focused.selectionEnd] : null;
  board = fresh;
  rounds = fresh.rounds;
  revisions = fresh.revisions || {};
  readRound();
  currentRound = Math.max(0, rounds.findIndex(round => round.id === selected));
  buildCanvas();
  applyNotes();
  viewport.scrollTo({ left, top, behavior: 'instant' });
  if (active) {
    active = all.find(concept => concept.key === active.key) || active;
    if (!currentVariant()) activeVariantId = 'original';
    renderRevisionOptions();
    renderReaderHeader();
    renderSizeControls();
    updateReaderNavigation();
  }
  if (noteKey) {
    const note = [...world.querySelectorAll('[data-note]')].find(element => element.dataset.note === noteKey);
    if (note) { note.focus({ preventScroll: true }); note.setSelectionRange(...selection); }
  }
  if (!dialog.open && document.activeElement === document.body) viewport.focus({ preventScroll: true });
  if (liveSnapshot) applyBoardSnapshot(liveSnapshot);
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
    if (document.querySelector('dialog[open]') || document.activeElement?.matches('textarea,input,[contenteditable="true"]')) { scheduleShellReload(); return; }
    reloadCanvas();
  }, 1200);
}

function showError(message) {
  $('board-error').textContent = message;
  $('board-error').hidden = false;
  setSaveStatus('Board unavailable', 'error');
}

function setInfoOpen(open, { focus = false } = {}) {
  $('board-info').hidden = !open;
  $('board-info-toggle').setAttribute('aria-expanded', String(open));
  if (!open && focus) $('board-info-toggle').focus({ preventScroll: true });
}

// Controls are bound once; board content is replaced only after a manifest update.
document.addEventListener('pointerdown', event => {
  const remove = event.target.closest('[data-remove-experiment]');
  if (remove && event.button === 0) { event.preventDefault(); remove.focus({ preventScroll: true }); }
  if (!sizeMenu.hidden && !event.target.closest('.size-wrap')) closeSizeMenu(false);
  if (viewControls.classList.contains('open') && !event.target.closest('.reader-tools')) setViewOpen(false, { focus: false });
  if (!$('board-info').hidden && !event.target.closest('#board-info, #board-info-toggle')) setInfoOpen(false);
});
document.addEventListener('click', event => {
  const open = event.target.closest('[data-open]');
  const star = event.target.closest('[data-star]');
  const remove = event.target.closest('[data-remove-experiment]');
  if (remove && appConfig) {
    const concept = all.find(item => item.key === remove.dataset.removeExperiment);
    if (concept) openRemovalPrompt(appConfig, board, concept);
  }
  if (open && !open.disabled) openReader(open.dataset.open, open.dataset.revision);
  if (star?.dataset.star) {
    const key = star.dataset.star;
    notes[key] = { ...notes[key], star: !notes[key]?.star, updatedAt: Date.now() };
    applyNotes();
    storeNotes();
  }
});
document.addEventListener('input', event => {
  const target = event.target;
  const key = target.dataset.note || (target.id === 'reader-note' ? active?.key : null);
  if (!key) return;
  notes[key] = { ...notes[key], note: target.value, updatedAt: Date.now() };
  // The board card and the experiment view edit the same note.
  document.querySelectorAll('[data-note]').forEach(element => { if (element !== target && element.dataset.note === key) element.value = target.value; });
  syncReaderNotes();
  storeNotes();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (dialog.open) { event.preventDefault(); handleEscape(); return; }
  if (!$('board-info').hidden) { event.preventDefault(); setInfoOpen(false, { focus: true }); }
}, true);

slider.addEventListener('input', () => changeZoom(Number(slider.value) / 100));
$('fit').onclick = fitBoard;
$('board-info-toggle').onclick = () => setInfoOpen($('board-info').hidden);
$('close-reader').onclick = () => closeReader();
$('reader-board-link').addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  closeReader();
});
$('reader-previous').onclick = () => stepReader(-1);
$('reader-next').onclick = () => stepReader(1);
$('notes-toggle').onclick = () => setNotesOpen(!notesOpen);
$('notes-close').onclick = () => setNotesOpen(false);
$('reader-type').addEventListener('input', () => setType($('reader-type').value));
$('reader-fit').onclick = () => setReaderSize('fit');
$('reader-theme').onclick = () => setTheme(readerView.theme === 'night' ? 'paper' : 'night');
$('view-toggle').onclick = () => setViewOpen(!viewControls.classList.contains('open'));
$('size-trigger').onclick = () => (sizeMenu.hidden ? openSizeMenu() : closeSizeMenu());
sizeMenu.addEventListener('click', event => {
  const size = event.target.closest('[data-size]');
  const choice = event.target.closest('[data-revision-choice]');
  if (size) { setReaderSize(size.dataset.size); closeSizeMenu(); }
  if (choice && active) { closeSizeMenu(false); openReader(active.key, choice.dataset.revisionChoice); }
});
sizeMenu.addEventListener('keydown', event => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [...sizeMenu.querySelectorAll('button:not([hidden])')];
  const index = buttons.indexOf(document.activeElement);
  event.preventDefault();
  buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
});
dialog.addEventListener('cancel', event => { event.preventDefault(); });
// A native close (not through closeReader) still returns to the board. The close event arrives
// asynchronously, so ignore it if the reader has been reopened in the meantime.
dialog.addEventListener('close', () => { if (active && !dialog.open) closeReader(); });
$('active-reader').addEventListener('load', () => {
  if (!dialog.open) return;
  // Key events inside a frame do not reach the surrounding dialog.
  try {
    $('active-reader').contentWindow.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); handleEscape(); }
    });
  } catch {} // Independent cross-origin previews own their keyboard handling.
});
window.addEventListener('message', event => { if (event.origin === location.origin && event.source === $('active-reader').contentWindow && event.data?.type === 'reader-close') handleEscape(); });
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ board: boardId, title: board?.title || 'Board', exportedAt: new Date().toISOString(), notes }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${boardId}-notes.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

// Dot track: click or drag to choose, hover or focus to read a title, arrow keys to step.
track.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !track.querySelector('[data-dot]')) return;
  event.preventDefault();
  scrub = { key: null, pointerId: event.pointerId };
  try { track.setPointerCapture(event.pointerId); } catch {}
  scrubTo(event.clientX);
});
track.addEventListener('pointermove', event => { if (scrub?.pointerId === event.pointerId) scrubTo(event.clientX); });
track.addEventListener('pointerup', event => {
  if (scrub?.pointerId !== event.pointerId) return;
  scrubTo(event.clientX);
  try { track.releasePointerCapture(event.pointerId); } catch {}
  endScrub(true);
});
track.addEventListener('pointercancel', () => endScrub(false));
track.addEventListener('scroll', updateTrackFade, { passive: true });
track.addEventListener('click', event => {
  const dot = event.target.closest('[data-dot]');
  if (dot && event.detail === 0) openReader(dot.dataset.dot, 'original', { focus: 'dot' });
});
track.addEventListener('keydown', event => {
  if (!event.target.matches('[data-dot]')) return;
  const sequence = readerSequence();
  const index = sequence.findIndex(concept => concept.key === active?.key);
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: sequence.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  if (sequence[next]) openReader(sequence[next].key, 'original', { focus: 'dot' });
});
track.addEventListener('pointerover', event => { const dot = event.target.closest('[data-dot]'); if (dot && !scrub) showTooltip(dot); });
track.addEventListener('pointerout', event => { if (!scrub && event.target.closest('[data-dot]') && !track.contains(event.relatedTarget)) hideTooltip(); });
track.addEventListener('focusin', event => { if (event.target.matches('[data-dot]:focus-visible')) showTooltip(event.target); });
track.addEventListener('focusout', () => { if (!scrub) hideTooltip(); });

// Canvas: drag to pan (after a small threshold, so clicks still work), two-finger pinch to zoom.
const pointers = new Map();
let pan = null;
let pinch = null;
viewport.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (event.target.closest('textarea,input,select,a')) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) {
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, active: false };
    pinch = null;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const [mx, my] = viewportPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom, x: (viewport.scrollLeft + mx - plane.offsetLeft) / zoom, y: (viewport.scrollTop + my - plane.offsetTop) / zoom };
    pan = null;
    viewport.classList.add('panning');
  }
});
viewport.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const [mx, my] = viewportPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    zoom = clampZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinch.distance);
    updatePlane();
    viewport.scrollLeft = pinch.x * zoom + plane.offsetLeft - mx;
    viewport.scrollTop = pinch.y * zoom + plane.offsetTop - my;
    return;
  }
  if (!pan || pan.id !== event.pointerId) return;
  const dx = event.clientX - pan.x;
  const dy = event.clientY - pan.y;
  if (!pan.active && Math.hypot(dx, dy) > 4) {
    pan.active = true;
    viewport.classList.add('panning');
    try { viewport.setPointerCapture(event.pointerId); } catch {}
  }
  if (pan.active) { viewport.scrollLeft = pan.left - dx; viewport.scrollTop = pan.top - dy; }
});
function endPointer(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    const [id, point] = [...pointers.entries()][0];
    pan = { id, x: point.x, y: point.y, left: viewport.scrollLeft, top: viewport.scrollTop, active: true };
  } else if (!pointers.size) { pan = null; viewport.classList.remove('panning'); }
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
viewport.addEventListener('wheel', event => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const delta = Math.max(-60, Math.min(60, event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY));
  changeZoom(zoom * Math.exp(-delta * .005), ...viewportPoint(event.clientX, event.clientY));
}, { passive: false });
let gestureZoom = zoom;
viewport.addEventListener('gesturestart', event => { event.preventDefault(); gestureZoom = zoom; });
viewport.addEventListener('gesturechange', event => { event.preventDefault(); changeZoom(gestureZoom * event.scale, ...viewportPoint(event.clientX, event.clientY)); });
viewport.addEventListener('gestureend', event => event.preventDefault());
viewport.addEventListener('keydown', event => {
  if (event.target !== viewport || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(zoom * 1.15); }
  else if (event.key === '-' || event.key === '_') { event.preventDefault(); changeZoom(zoom / 1.15); }
});
new ResizeObserver(() => {
  if ($('reader-window').style.width && readerView.size !== 'custom') readerView.size = 'custom';
  // A new size label can change the footer layout, which resizes this window; lay out on the next frame to avoid a resize loop.
  if (dialog.open) { renderSizeControls(false); requestAnimationFrame(layoutReaderFooter); }
}).observe($('reader-window'));
new ResizeObserver(updatePlane).observe(viewport);
// The dialog fills the window, so this fires on window resizes but never because the footer re-laid itself out.
new ResizeObserver(layoutReaderChrome).observe(dialog);
viewport.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!rounds.length) return;
    const row = Math.max(0, Math.min(rounds.length - 1, Math.floor(((viewport.scrollTop - plane.offsetTop) / zoom + 130) / geometry.rowHeight)));
    if (row !== currentRound) { currentRound = row; renderNav(); }
  });
}, { passive: true });
window.addEventListener('popstate', route);
// Clicking into the experiment frame never reaches this document; close the popover when focus leaves it.
window.addEventListener('blur', () => { closeSizeMenu(false); setViewOpen(false, { focus: false }); if (!scrub) hideTooltip(); });
window.addEventListener('hashchange', route);
$('live-refresh').onclick = reloadCanvas;
$('reader-update').onclick = () => loadRevision();
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

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
    setTheme(readerView.theme, false);
    setType(readerView.type, false);
    const requested = parseHash();
    if (requested.view === 'experiment') {
      const concept = all.find(item => item.key === requested.key);
      currentRound = concept.row;
      renderNav();
      jump(concept.key);
      openReader(requested.key, requested.revision || 'original', { history: 'replace' });
    } else {
      if (requested.invalid) commitHistory({ view: 'board', round: null }, 'replace');
      const index = rounds.findIndex(round => round.id === requested.round);
      if (index >= 0) currentRound = index;
      renderNav();
      requestAnimationFrame(() => { viewport.scrollTop = currentRound * geometry.rowHeight * zoom; });
    }
    routedHash = location.hash;
    try {
      const saved = JSON.parse(sessionStorage.getItem(viewKey) || 'null');
      sessionStorage.removeItem(viewKey);
      if (saved && Number.isFinite(saved.zoom)) {
        zoom = clampZoom(saved.zoom);
        currentRound = Math.max(0, rounds.findIndex(round => round.id === saved.round));
        renderNav();
        requestAnimationFrame(() => viewport.scrollTo({ left: saved.left, top: saved.top, behavior: 'instant' }));
      }
    } catch {}
    if (!dialog.open && document.activeElement === document.body) viewport.focus({ preventScroll: true });
    $('live-status').classList.add('live-indicator');
    watchBoard(boardId, {
      onSnapshot: applyBoardSnapshot,
      onManifestChange: refreshManifest,
      onShellChange: scheduleShellReload,
      onConnection: connected => { const label = $('live-status'); label.dataset.connection = connected ? 'live' : 'offline'; if (!connected) label.textContent = 'Reconnecting to this Mac…'; else if (liveSnapshot && label.textContent.startsWith('Reconnecting')) applyBoardSnapshot(liveSnapshot); },
    });
  } catch (error) { showError(error.message || 'This board could not be loaded.'); }
}
