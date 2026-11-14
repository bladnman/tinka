import {TileNotes, positionTilePopover, bindTileMenu} from './tile-ui.js';
import {ProjectNavigator} from './navigator.js';
import {mountAppearance} from './appearance.js';
import { watchBoard } from './live.js';
import { reconcileChildren } from './reconcile.js';
import { openRemovalPrompt } from './agent-prompt.js';
import { WorkspaceBoard } from './workspace-board.js';
import { contentURL, enableOrganization, makeDialog } from './workspace.js';
import { validTextAnchor } from './markdown-document.js';
import {bindCommitShortcut,commitShortcutLabel} from './interaction.js';
import {clampZoom, FIT_MAX_ZOOM, LARGE_BOARD_ZOOM, sameView, sliderFromZoom, zoomFromSlider, wheelZoomFactor} from './canvas-zoom.js';
import {BoardMap} from './board-map.js';
import {decorationBounds} from './whiteboard-geometry.js';
import {ReaderCanvas} from './reader-canvas.js';
import {ReaderPath} from './reader-path.js';
import {isMacPlatform, readerCommand, stepModifierLabel} from './reader-keys.js';

const $ = id => document.getElementById(id);
mountAppearance($('board-info'));
const viewport = $('viewport');
const world = $('world');
const plane = $('plane');
const dialog = $('reader-dialog');
const slider = $('zoom-slider');
const sizeMenu = $('size-menu');
const geometry = { pad: 70, gap: 68, cardWidth: 1000, rowHeight: 1220 };
const SIZE_NAMES = { fit: 'Fit', custom: 'Custom', compact: 'Compact', standard: 'Standard', wide: 'Wide' };
const boardMatch = location.pathname.match(/^\/boards\/([a-z0-9][a-z0-9-]*)\/?$/);
const boardId = boardMatch?.[1];
const boardApi = `/api/boards/${encodeURIComponent(boardId || '')}`;
// ?overview shows this board alone, fitted to the window, for `board overview`
// to save as one image. It changes nothing and opens no live connection.
const overview = new URLSearchParams(location.search).has('overview');
if (overview) document.documentElement.classList.add('tinka-overview');
let notesKey, viewKey, workspaceId;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

let board = null;
let graph = null;
let projectNavigator = null;
function saveNavigatorView(){try{sessionStorage.setItem(viewKey,JSON.stringify({zoom,x:view.x,y:view.y,resting,round:rounds[currentRound]?.id}));}catch{}}
let appTitle = 'Tinka';
let appConfig;
let rounds = [];
let revisions = {};
let all = [];
let currentRound = 0;
let zoom = .5;
let notes = {};
let notesReady=false, notesLoading=null;
let legacyCommittedNotes = {}, legacyCommitSequence = 0;
let active = null;
let activeVariantId = 'original';
let activeRevision = null;
let liveSnapshot = null;
let saveTimer;
let saveSequence = 0;
let saveQueue = Promise.resolve();
let shellReloadTimer;
let routedHash = null;
let notesOpen = false;
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
  if (concept?.graphItem) return { kind: variant?.content?.kind || variant?.kind || concept.graphItem.content?.kind || 'text', name: variant ? `${concept.name} · ${variant.name}` : concept.name, graphItem: concept.graphItem, graphRevision: variant };
  return {
    kind: variant?.kind || concept.kind || 'html',
    path: variant?.path || concept.path || `rounds/${concept.round}/${concept.id}/index.html`,
    url: variant ? variant.url || null : concept.url || null,
    name: variant ? `${concept.name} · ${variant.name}` : concept.name,
  };
}

function standaloneHref(concept, variant = null) {
  if (concept?.graphItem) return contentURL(concept.graphItem, variant);
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
  if (concept?.graphItem) { const params = new URLSearchParams({item:concept.graphItem.id,theme,scale:String(scale),commentBoard:boardId}); if (variant) params.set('variant',variant.id); if (revision) params.set('v',String(revision)); return `/app/item.html?${params}`; }
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
  all = rounds.flatMap((round, row) => (round.concepts || []).map((concept, col) => ({ ...concept, round: round.id, row, col, key: concept.key || `${round.id}/${concept.id}` })));
  if (graph) { const order=graph.snapshot.reviewOrder;all.sort((a,b)=>order.indexOf(a.placement.id)-order.indexOf(b.placement.id)); }
}

async function fetchBoard() {
  const response = await fetch(boardApi, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Board metadata unavailable (${response.status})`);
  const data = await response.json();
  if (data.schemaVersion === 2) {
    if (!graph) graph = new WorkspaceBoard(appConfig, data, { concepts:()=>all, active:()=>active, zoom:()=>zoom, shiftOrigin:(dx,dy)=>{if(dx||dy){view.x-=dx*zoom;view.y-=dy*zoom;resting=false;shiftSavedViews(dx,dy);}}, shiftViewport:(dx,dy)=>{if(dx||dy)moveView(view.x+dx,view.y+dy);}, holdView:()=>{resting=false;}, revealPlacements:revealPlacements, revealTarget:placement=>{const fit=Math.min((viewport.clientWidth-80)/placement.width,(viewport.clientHeight-80)/placement.height,1);changeZoom(fit);const rect=world.getBoundingClientRect(),region=viewport.getBoundingClientRect();moveView(view.x+region.left+viewport.clientWidth/2-(rect.left+(placement.x+graph.origin.x+placement.width/2)*zoom),view.y+region.top+viewport.clientHeight/2-(rect.top+(placement.y+graph.origin.y+placement.height/2)*zoom));}, preview:c=>previewHref(c), layout:()=>{ if(resting)rest();else applyView(); contentChanged(); }, mode:mode=>{ if(mode==='canvas'){zoom=1;settleCushion();}else{viewport.scrollLeft=0;viewport.scrollTop=0;} requestAnimationFrame(syncMapAvailability); }, fit:kind=>runFit(kind==='smart'?smartFitTarget():kind), toggleMap:()=>setMapOpen(!boardMap.visible,{remember:true}), reloadReader:()=>loadRevision(), saveStatus:setSaveStatus, openOwner:()=>{const c=graph.ownerConcept();if(c)openReader(c.key);}, closeReader:()=>closeReader(), flushNotes:flushNoteEdits, liveReady:()=>{void drainLiveUpdates().catch(()=>{});}, data:acceptGraphData, editNote:(key,anchor)=>openTileNote(key,anchor), readerChanged:()=>{if(active&&dialog.open)renderReaderChrome();}, viewOnly:overview });
    if (overview) graph.mode = 'canvas';
    return graph.adapt(data);
  }
  if (!Array.isArray(data.rounds)) throw new Error('The board manifest is invalid.');
  return data;
}

async function loadAppTitle() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Workspace identity unavailable. Reload when the server is ready.');
  const config = await response.json();
  if (!config.workspaceId || !config.projectLabel) throw new Error('Workspace identity unavailable.');
  appConfig = config;
  projectNavigator ||= new ProjectNavigator(config,{boardId,beforeNavigate:async()=>{if(graph){if(await graph.saveReview([], {})===false)throw Error('Save or retry your feedback before leaving.');}else await flushNoteEdits();saveNavigatorView();},reveal:id=>graph?.revealPlacement(id),outline:()=>graph?.outline?.()||[],selection:()=>[...(graph?.selection||[])]}).mount(document.querySelector('#canvas-header .brand'));
  workspaceId = config.workspaceId;
  appTitle = `Tinka / ${config.projectLabel}`;
  const prefix = `tinka/${config.workspaceId}/${boardId}`;
  notesKey = `${prefix}/notes`;
  viewKey = `${prefix}/view`;
  loadCanvasPattern();
  $('project-label').textContent = 'Home';
  $('reader-project').textContent = 'Home';
  document.querySelectorAll('.brand').forEach(brand => { brand.setAttribute('aria-label', `${appTitle} home`); brand.title = `${appTitle} · all boards`; });
  if (board) updateMetadata();
}

function updateMetadata() {
  const title = board.title || 'Untitled board';
  const activeNumber = active && dialog.open ? shownNumber(active) : '';
  const owner = graph?.snapshot?.items?.[graph.snapshot.ownerItemId];
  const boardNumber = String(owner?.number ?? owner?.legacy?.number ?? '').trim().slice(0, 8);
  const boardLabel = boardNumber ? `${boardNumber} · ${title}` : title;
  document.title = active && dialog.open ? `${appTitle} / ${boardLabel} / ${activeNumber ? `${activeNumber} · ` : ''}${descriptor(active, currentVariant()).name}` : `${appTitle} / ${boardLabel}`;
  $('board-title').textContent = title;
  $('board-number').textContent = boardNumber;
  $('board-number').hidden = !boardNumber;
  $('board-title').title = title;
  if (active) renderReaderChrome();
  $('board-description').textContent = board.description || 'Working experiments and the questions they invite.';
  $('experiment-count').textContent = `${all.length} ${all.length === 1 ? 'experiment' : 'experiments'}`;
  $('round-count').textContent = `${rounds.length} ${rounds.length === 1 ? 'exploration' : 'explorations'}`;
}

function buildCanvas() {
  if (graph) { graph.build(all); wireReaderReview(); updateMetadata(); renderNav(); applyNotes(); projectNavigator?.refresh?.(); if (!landed) { landed = true; requestAnimationFrame(landFromChild); } return; }
  const retainedLegacy=new Map([...world.querySelectorAll(".concept-card")].map(card=>[card.dataset.key,card.querySelector("iframe")]));
  const cards = round => all.filter(concept => concept.round === round.id).map(concept => {
    const previewSource=previewHref(concept,null,concept.tone==='night'?'night':'paper');
    const retained=retainedLegacy.get(concept.key);
    const preview=retained?.dataset.previewSource===previewSource?retained.src:previewSource;
    return `<article class="concept-card" data-key="${esc(concept.key)}" data-placement="${esc(concept.key)}"><header class="card-label"><div class="card-title">${concept.number ? `<span class="card-number">${esc(concept.number)}</span>` : ''}<h3>${esc(concept.name)}</h3><span class="build-badge"></span></div><div class="card-actions"><button class="shortlist" type="button" data-star="${esc(concept.key)}" aria-label="Favorite ${esc(concept.name)}" aria-pressed="false">☆</button><button type="button" data-tile-notes="${esc(concept.key)}" aria-label="Notes on ${esc(concept.name)}" title="Notes">${noteGlyph}<span class="tile-note-dot" hidden></span></button><button type="button" data-legacy-menu="${esc(concept.key)}" aria-label="Actions for ${esc(concept.name)}" aria-haspopup="menu" aria-expanded="false">${moreGlyph}</button></div></header><div class="preview"><iframe src="${esc(preview)}" data-preview-source="${esc(previewSource)}" title="${esc(concept.name)} preview" tabindex="-1" loading="eager" inert></iframe><button class="preview-launch" type="button" data-open="${esc(concept.key)}" aria-label="Explore ${esc(concept.name)}"><span>Open ${esc(concept.name)} ↗</span></button></div></article>`;
  }).join('');
  const freshLegacy=document.createElement("template");
  freshLegacy.innerHTML = rounds.map(round => `<section class="round" data-round="${esc(round.id)}" aria-labelledby="round-heading-${esc(round.id)}"><header class="round-header"><span class="round-label">ROUND ${esc(round.number || '')} · ${esc(round.date || '')}</span><h2 id="round-heading-${esc(round.id)}">${esc(round.title || 'Exploration')}</h2><p>${esc(round.description || '')}</p></header><div class="concepts">${cards(round)}</div></section>`).join('') + '<section class="future-row"><span>CONTINUE EXPLORING</span><h2>Room for what comes next.</h2><p>New explorations can join this board without replacing earlier work.</p></section>';
  reconcileChildren(world,freshLegacy.content);
  decorateBuildCards();
  applyNotes();
  renderNav();
  if (resting) rest(); else applyView();
  updateMetadata();
}

function renderNav() {
  const round = rounds[currentRound];
  $('round-status').textContent = round ? `Round ${round.number || currentRound + 1} / ${round.date || round.id}` : 'No explorations yet';
}

// ---- Board canvas: an endless plane. The plane carries the pan and the world the zoom; nothing scrolls natively. ----
// The board can move past any edge until only KEEP pixels of it are left in view.
const KEEP = 80;
// An invisible margin lets the browser scroll the canvas in any direction to reveal a focused control or a
// find-in-page match. The scroll is turned straight into a pan, so the view has no edges of its own.
const CUSHION = 100000;
const view = { x: 0, y: 0 };
// At rest the view shows the board's resting place and follows window resizes; any pan or zoom ends that.
let resting = true;
let glide = 0;
let glideTarget = null;
let flight = 0;
let roundFrame = 0;

function settleCushion() {
  if (graph?.mode === 'grid') return;
  viewport.scrollLeft = CUSHION;
  viewport.scrollTop = CUSHION;
}

function clampView({ x, y }) {
  const pad = geometry.pad * zoom;
  const width = Math.max(0, world.offsetWidth * zoom - pad * 2);
  const height = Math.max(0, world.offsetHeight * zoom - pad * 2);
  const keepX = Math.min(KEEP, viewport.clientWidth / 3, width);
  const keepY = Math.min(KEEP, viewport.clientHeight / 3, height);
  return {
    x: Math.min(viewport.clientWidth - keepX - pad, Math.max(keepX - width - pad, x)),
    y: Math.min(viewport.clientHeight - keepY - pad, Math.max(keepY - height - pad, y)),
  };
}

// The plane keeps will-change for smooth panning, which freezes its raster scale:
// after zooming in, text and previews would stay a magnified bitmap. Once the zoom
// settles, drop the hint for two frames so the browser redraws them sharp.
let rasterZoom = null, sharpenTimer = 0;
function sharpenAfterZoom() {
  if (rasterZoom === zoom) return;
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(() => {
    rasterZoom = zoom;
    plane.style.willChange = 'auto';
    requestAnimationFrame(() => requestAnimationFrame(() => { plane.style.willChange = ''; }));
  }, 150);
}

function applyView() {
  if (graph?.mode === 'grid') { plane.style.transform='none'; world.style.transform='none'; syncViewChrome(); return; }
  Object.assign(view, clampView(view));
  plane.style.transform = `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px)`;
  world.style.transform = `scale(${zoom})`;
  sharpenAfterZoom();
  const percent = Math.round(zoom * 100);
  slider.value = String(sliderFromZoom(zoom));
  slider.setAttribute('aria-valuetext', `${percent} percent`);
  slider.title = `Zoom ${percent}%`;
  syncViewChrome();
}

// A board rests centred on each axis where it fits, otherwise at its left edge with the given exploration on top.
function restingView(row = currentRound) {
  const width = world.offsetWidth * zoom;
  const height = world.offsetHeight * zoom;
  return {
    x: width <= viewport.clientWidth ? Math.floor((viewport.clientWidth - width) / 2) : 0,
    y: rounds.length && height <= viewport.clientHeight ? Math.floor((viewport.clientHeight - height) / 2) : -row * geometry.rowHeight * zoom,
  };
}

function stopGlide() {
  // Any other view change also ends a return-to-tile flight.
  if (flight) { cancelAnimationFrame(flight); flight = 0; }
  cancelAnimationFrame(glide);
  glide = 0;
  glideTarget = null;
}

function rest() {
  if (graph?.mode === 'grid') { applyView(); return; }
  stopGlide();
  resting = true;
  Object.assign(view, restingView());
  applyView();
}

// The reader's own pan or zoom: the quiet round status follows it.
function moveView(x, y) {
  stopGlide();
  resting = false;
  view.x = x;
  view.y = y;
  applyView();
  trackRound();
}

// Ease to a place (instantly with reduced motion). A placement chosen by the app sets the round itself.
function glideTo(target, { track = false } = {}) {
  stopGlide();
  resting = false;
  if (!track) { cancelAnimationFrame(roundFrame); roundFrame = 0; }
  const to = clampView(target);
  const from = { ...view };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now();
  const step = now => {
    const t = reduced ? 1 : Math.min(1, (now - start) / 240);
    const eased = 1 - (1 - t) ** 3;
    view.x = from.x + (to.x - from.x) * eased;
    view.y = from.y + (to.y - from.y) * eased;
    applyView();
    if (track) trackRound();
    glide = t < 1 ? requestAnimationFrame(step) : 0;
    if (!glide) glideTarget = null;
  };
  if (reduced) { step(start); return; }
  glideTarget = to;
  glide = requestAnimationFrame(step);
}

function trackRound() {
  if (roundFrame) return;
  roundFrame = requestAnimationFrame(() => {
    roundFrame = 0;
    if (!rounds.length) return;
    const row = Math.max(0, Math.min(rounds.length - 1, Math.floor((-view.y / zoom + 130) / geometry.rowHeight)));
    if (row !== currentRound) { currentRound = row; renderNav(); }
  });
}

function changeZoom(value, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) {
  const scale = clampZoom(value) / zoom;
  zoom = clampZoom(value);
  moveView(cx - (cx - view.x) * scale, cy - (cy - view.y) * scale);
}

// Reveal one newly pasted group, keeping the normal zoom whenever it fits.
function revealPlacements(placements) {
  if (graph?.mode === 'grid' || !placements.length) return;
  const x = Math.min(...placements.map(p=>p.x)), y = Math.min(...placements.map(p=>p.y));
  const width = Math.max(...placements.map(p=>p.x+p.width)) - x;
  const height = Math.max(...placements.map(p=>p.y+p.height)) - y;
  const margin = 24;
  const fit = Math.min((viewport.clientWidth-margin*2)/width,(viewport.clientHeight-margin*2)/height);
  if (fit < zoom) changeZoom(fit);
  const region = viewport.getBoundingClientRect(), rect = world.getBoundingClientRect();
  const left = rect.left + (x + graph.origin.x)*zoom, top = rect.top + (y + graph.origin.y)*zoom;
  const visibleX = Math.max(region.left+margin,Math.min(left,region.right-margin-width*zoom));
  const visibleY = Math.max(region.top+margin,Math.min(top,region.bottom-margin-height*zoom));
  const dx = visibleX-left, dy = visibleY-top;
  if (Math.abs(dx)>.5 || Math.abs(dy)>.5) moveView(view.x+dx,view.y+dy);
}

// Fits use the canvas left of an open board map on desktop widths.
function fitArea() {
  const right = boardMap?.visible && innerWidth > 720 ? boardMap.el.offsetWidth + 24 : 0;
  return { width: Math.max(160, viewport.clientWidth - right), height: viewport.clientHeight };
}
// The view that fits every exploration on both axes, centred in the area.
function fitBoardView(area = fitArea(), cap = FIT_MAX_ZOOM) {
  const margin = 24;
  const contentWidth = world.offsetWidth - geometry.pad * 2;
  const contentHeight = world.offsetHeight - geometry.pad * 2;
  if (contentWidth <= 0 || contentHeight <= 0) return null;
  const z = clampZoom(Math.min(cap, (area.width - margin * 2) / contentWidth, (area.height - margin * 2) / contentHeight));
  const pad = geometry.pad * z;
  return { zoom: z, x: (area.width - contentWidth * z) / 2 - pad, y: (area.height - contentHeight * z) / 2 - pad };
}
// The view that fits the rendered selected placements, capped like Fit board.
function fitSelectionView(placements, area = fitArea()) {
  if (!placements.length) return null;
  const x = Math.min(...placements.map(p => p.x)), y = Math.min(...placements.map(p => p.y));
  const width = Math.max(1, Math.max(...placements.map(p => p.x + p.width)) - x), height = Math.max(1, Math.max(...placements.map(p => p.y + p.height)) - y);
  const margin = 48;
  const z = clampZoom(Math.min(FIT_MAX_ZOOM, (area.width - margin * 2) / width, (area.height - margin * 2) / height));
  return { zoom: z, x: area.width / 2 - (x + graph.origin.x + width / 2) * z, y: area.height / 2 - (y + graph.origin.y + height / 2) * z };
}
function fitBoard() { runFit('board'); }
function fitSelection() { runFit('selection'); }

// ---- Smart Fit and Back. `framed` is the view the latest fit produced; `backView`
// is where the view was just before it. Any other view change ends both.
let framed = null, backView = null;
let selectionInfo = { count: 0, key: '' };
const currentView = () => ({ zoom, x: view.x, y: view.y });
function selectedPlacements() { return graph?.mode === 'canvas' ? graph.clipboardCandidates() : []; }
function readSelection() {
  const placements = selectedPlacements();
  selectionInfo = { count: placements.length, key: placements.map(p => p.id).sort().join() };
}
function isFramed(kind) {
  return !!framed && framed.kind === kind && sameView(framed.view, currentView()) && (kind !== 'selection' || framed.key === selectionInfo.key);
}
// The Fit button fits the selection first, then the board on the next press.
function smartFitTarget() { return selectionInfo.count && !isFramed('selection') ? 'selection' : 'board'; }
function runFit(kind) {
  if (graph?.mode === 'grid') { viewport.scrollTo({top:0,left:0}); return; }
  const placements = kind === 'selection' ? selectedPlacements() : [];
  if (!placements.length) kind = 'board';
  const target = kind === 'selection' ? fitSelectionView(placements) : fitBoardView();
  if (!target) return;
  if (graph) graph.revealedPlacement = null;
  const before = currentView();
  zoom = target.zoom;
  moveView(target.x, target.y);
  const after = currentView();
  readSelection();
  framed = { kind, key: selectionInfo.key, view: after };
  // A fit that changes nothing keeps the earlier way back.
  if (!sameView(before, after)) backView = before;
  if (!overview) announceView(kind === 'selection' ? `Fitted ${placements.length} selected` : 'Fitted the whole board');
  syncFitControls();
}
function goBack() {
  const to = backView;
  if (!to) return;
  backView = null; framed = null;
  if (graph) graph.revealedPlacement = null;
  if (document.activeElement === $('view-back')) $('fit').focus({ preventScroll: true });
  flyTo(to.zoom, to.x, to.y);
  announceView('Back to the previous view');
  syncFitControls();
}
// Content added at negative coordinates shifts the origin; saved views shift with it.
function shiftSavedViews(dx, dy) {
  for (const saved of [framed?.view, backView]) if (saved) { saved.x -= dx * saved.zoom; saved.y -= dy * saved.zoom; }
}
let announceTimer = 0;
function announceView(text) {
  const live = $('view-announce');
  if (!live) return;
  clearTimeout(announceTimer);
  live.textContent = text;
  announceTimer = setTimeout(() => { live.textContent = ''; }, 2500);
}
let fitSignature = '';
function syncFitControls() {
  const fit = $('fit');
  if (!fit) return;
  if (framed && !sameView(framed.view, currentView())) { framed = null; backView = null; }
  const canvasMode = graph?.mode !== 'grid';
  const target = canvasMode && graph ? smartFitTarget() : 'board';
  const count = selectionInfo.count;
  const signature = [target, count, !!backView, canvasMode, !!graph].join('|');
  if (signature === fitSignature) return;
  fitSignature = signature;
  const label = target === 'selection' ? 'Fit selection' : count ? 'Fit board' : 'Fit';
  fit.querySelector('.fit-label').textContent = label;
  const badge = fit.querySelector('.fit-count');
  badge.hidden = target !== 'selection'; badge.textContent = String(count);
  fit.dataset.target = target;
  fit.setAttribute('aria-label', target === 'selection' ? `Fit ${count} selected` : 'Fit board');
  fit.setAttribute('aria-keyshortcuts', target === 'selection' ? 'F Shift+2' : 'F Shift+1');
  fit.title = target === 'selection' ? `Fit the ${count} selected (F or ⇧2) · ⌥-click fits the board` : 'Fit every item in view (F or ⇧1)';
  $('view-back').hidden = !backView || !canvasMode;
  const fitSelected = boardMapElement()?.querySelector('[data-map-fit="selection"]');
  if (fitSelected) { fitSelected.hidden = !count; fitSelected.textContent = `Fit ${count} selected`; }
}

// Overview readiness for `board overview`: fit, then wait until every on-screen
// image and same-origin preview frame has loaded and the resource count holds
// still (15 s at most).
let overviewRun = 0;
function overviewPending() {
  let pending = 0, resources = performance.getEntriesByType('resource').length;
  // Only an image that is on screen in its own document can hold the picture up:
  // lazy images below a preview's fold, or in hidden boxes, may never load.
  const onScreen = node => { const box = node.getBoundingClientRect(), view = node.ownerDocument.defaultView; return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < view.innerHeight && box.left < view.innerWidth; };
  const visit = (root, depth) => {
    for (const image of root.querySelectorAll('img')) if (!image.complete && onScreen(image)) pending++;
    for (const frame of root.querySelectorAll('iframe')) {
      if (frame.hidden || frame.closest('[hidden]')) continue;
      if (frame.hasAttribute('data-cover-pending')) { pending++; continue; }
      let inner = null;
      try { inner = frame.contentDocument; } catch {}
      // A sandboxed (opaque-origin) cover frame reports readiness by message instead.
      if (!inner) continue;
      const blank = inner.URL === 'about:blank' && (frame.getAttribute('src') || 'about:blank') !== 'about:blank';
      if (blank || inner.readyState !== 'complete') { pending++; continue; }
      try { resources += frame.contentWindow.performance.getEntriesByType('resource').length; } catch {}
      if (depth < 2) visit(inner, depth + 1);
    }
  };
  visit(world, 0);
  return { pending, resources };
}
async function settleOverview() {
  const run = ++overviewRun, root = document.documentElement;
  delete root.dataset.overview;
  fitBoard();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = performance.now() + 15000;
  let previous = -1, state = overviewPending();
  while (performance.now() < deadline && (state.pending || state.resources !== previous)) {
    previous = state.resources;
    await wait(state.pending ? 150 : 700);
    if (run !== overviewRun) return;
    state = overviewPending();
  }
  await document.fonts?.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (run !== overviewRun) return;
  const width = world.offsetWidth - geometry.pad * 2, height = world.offsetHeight - geometry.pad * 2;
  root.dataset.overviewAspect = String(width > 0 && height > 0 ? height / width : 0.625);
  root.dataset.overviewWidth = String(Math.max(0, width));
  root.dataset.overviewChrome = String(Math.max(0, innerHeight - viewport.clientHeight));
  root.dataset.overviewItems = String(world.querySelectorAll('[data-placement]').length);
  root.dataset.overview = state.pending ? 'partial' : 'ready';
}

function jump(key) {
  if (graph?.mode === 'grid') return;
  const concept = all.find(item => item.key === key) || graph?.ownerConcept(key) || graph?.aliasConcept(key);
  if (!concept) return;
  if (currentRound !== concept.row) { currentRound = concept.row; renderNav(); }
  if (zoom < .4) { view.x *= .5 / zoom; view.y *= .5 / zoom; zoom = .5; }
  viewport.focus({ preventScroll: true });
  const place = restingView(concept.row);
  const wide = world.offsetWidth * zoom > viewport.clientWidth;
  glideTo({ x: wide ? 25 - (geometry.pad + concept.col * (geometry.cardWidth + geometry.gap)) * zoom : place.x, y: place.y });
}

function showRow(row) {
  currentRound = row;
  renderNav();
  const first = all.find(item => item.row === row);
  if (first) jump(first.key);
  else glideTo(restingView(row));
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
  let [key, revision] = raw.split('~');
  if (graph) { const alias=graph.aliasConcept(key)||graph.ownerConcept(key);if(alias){key=alias.key;revisions[key]=graph.revisionsFor(alias.graphItem);} }
  if (all.some(concept => concept.key === key) || graph?.ownerConcept(key) || graph?.aliasConcept(key)) return { view: 'experiment', key, revision: (revisions[key] || []).some(variant => variant.id === revision) ? revision : null };
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
  if (row >= 0) showRow(row);
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

// ---- The opened Tinka: the board's header pattern, its own canvas and the same zoom pill ----
const readerStage = $('reader-stage');
const readerInfo = $('reader-info');
const readerKeysMac = isMacPlatform();
const MOD = stepModifierLabel(readerKeysMac);
const readerCanvas = new ReaderCanvas(readerStage, $('reader-plane'), $('reader-window'), {
  onChange: syncReaderZoom,
  onBack: shown => { $('reader-view-back').hidden = !shown; },
  reserveBottom: () => { const pill = dialog.querySelector('.reader-footer .zoom-pill'); return pill ? pill.offsetHeight + 20 : 0; },
});
function syncReaderZoom(view) {
  const percent = Math.round(view.zoom * 100);
  const toggle = $('reader-zoom-toggle');
  if (toggle.textContent !== `${percent}%`) { toggle.textContent = `${percent}%`; toggle.setAttribute('aria-label', `Zoom ${percent}%, zoom and view options`); }
  const input = $('reader-zoom-slider');
  input.value = String(sliderFromZoom(view.zoom));
  input.setAttribute('aria-valuetext', `${percent} percent`);
}
// Opening a Tinka leaves focus on Tinka's canvas, not inside the content, so its keys work at once.
function focusTinka() {
  if (dialog.open) readerStage.focus({ preventScroll: true });
}
function applyReaderFocus(focus) {
  if (focus === 'none') return;
  const current = document.activeElement;
  if (focus === 'tinka' || !current || current === document.body || current === $('active-reader') || !dialog.contains(current) || current.disabled) focusTinka();
}

function sendPreferences() {
  $('active-reader').contentWindow?.postMessage({ type: 'reader-preferences', theme: readerView.theme, scale: readerView.type }, location.origin);
}

// Window size and Version live in the % menu.
function renderSizeControls() {
  const viewer = $('reader-window');
  const size = readerView.size;
  const customText = `${Math.round(viewer.offsetWidth)} × ${Math.round(viewer.offsetHeight)}`;
  const variant = currentVariant();
  sizeMenu.querySelectorAll('[data-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.size === size)));
  sizeMenu.querySelector('[data-size="custom"]').hidden = size !== 'custom';
  $('custom-size').textContent = customText;
  $('reader-zoom-toggle').title = `Zoom and view · Window: ${SIZE_NAMES[size]}${size === 'custom' ? ` ${customText}` : ''}${variant ? ` · Version: ${variant.name}` : ''}`;
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
  // A new window size shows whole again; canvas zoom never reflows it.
  if (dialog.open) readerCanvas.rest();
}

function setTheme(theme, send = true) {
  readerView.theme = theme === 'night' ? 'night' : 'paper';
  document.querySelectorAll('[data-reader-light]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.readerLight === readerView.theme)));
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

function setReaderMenuOpen(open, { focus = false } = {}) {
  const menu = $('reader-zoom-menu');
  if (menu.hidden !== open) { if (!open && focus) $('reader-zoom-toggle').focus({ preventScroll: true }); return; }
  menu.hidden = !open;
  $('reader-zoom-toggle').setAttribute('aria-expanded', String(open));
  if (open) { renderSizeControls(); menu.querySelector('button:not([hidden])')?.focus({ preventScroll: true }); }
  else if (focus) $('reader-zoom-toggle').focus({ preventScroll: true });
}

function renderRevisionOptions() {
  const versions = revisions[active?.key] || [];
  $('revision-group').hidden = !versions.length;
  $('revision-options').innerHTML = versions.length ? [{ id: 'original', name: 'Original' }, ...versions].map(variant => `<button type="button" class="tk-mi" data-revision-choice="${esc(variant.id)}" aria-pressed="${variant.id === activeVariantId}"><span>${esc(variant.name)}</span></button>`).join('') : '';
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
}

function renderReaderHeader() {
  if (!active) return;
  const variant = currentVariant();
  const round = rounds[active.row];
  const name = descriptor(active, variant).name;
  const hint = variant?.hint || active.hint || '';
  $('reader-name').textContent = name;
  $('reader-path').title = `${name}${hint ? ` · ${hint}` : ''} · hover or click for where you are`;
  const number = shownNumber(active);
  $('reader-number').textContent = number;
  $('reader-number').hidden = !number;
  $('reader-star').dataset.star = active.key;
  $('reader-star').setAttribute('aria-label', `Shortlist ${active.name}`);
  $('reader-note').setAttribute('aria-label', `Notes on ${active.name}`);
  $('notes-for').textContent = `Round ${round?.number || active.row + 1} · ${active.number ? `${active.number} ` : ''}${name}`;
  $('reader-hint').textContent = hint;
  applyNotes();
  if (graph) graph.reader(active);
  renderReaderChrome();
}

function loadRevision({ focus = false } = {}) {
  if (!active) return;
  const variant = currentVariant();
  $('active-reader').title = `${descriptor(active, variant).name} experiment`;
  const standalone = standaloneHref(active, variant);
  $('reader-standalone').hidden = !standalone;
  if (standalone) $('reader-standalone').href = standalone;
  activeRevision = liveSnapshot?.concepts?.[activeSourceKey()]?.revision || null;
  $('reader-update').hidden = true;
  replaceFrame($('active-reader'), previewHref(active, variant, readerView.theme, readerView.type, activeRevision || 'initial', true));
  if (focus) focusTinka();
}

// Stepping skips reserved and building slots, and board-only Tinkas (those open their board).
function readerSequence() {
  if (graph) return all.filter(c => c.key === active?.key || (!['reserved', 'building'].includes(c.graphItem?.build?.state) && !(c.graphItem?.childBoardId && !c.graphItem?.content)));
  return all.filter(concept => concept.key === active?.key || !['reserved', 'building'].includes(liveSnapshot?.concepts?.[concept.key]?.state));
}

const READER_KINDS = { html: 'Prototype', image: 'Image', markdown: 'Document', pdf: 'PDF', video: 'Video', audio: 'Audio', note: 'Note', text: 'Text', url: 'Link', file: 'File' };
function readerKind(concept) {
  const item = concept?.graphItem;
  if (!item) return { html: 'Prototype', image: 'Image', markdown: 'Document', pdf: 'PDF', video: 'Video' }[concept?.kind || 'html'] || 'Experiment';
  return item.category || READER_KINDS[item.content?.kind] || (item.childBoardId ? 'Board' : 'Idea');
}
function readerBoardTitle() { return board?.title || 'Untitled board'; }

// Up (‹ board), the ↓ Board · N chip and an open path or Inspector follow the current Tinka.
function renderReaderChrome() {
  if (!active) return;
  const title = readerBoardTitle();
  $('reader-up-label').textContent = title;
  $('close-reader').title = `Up to ${title} (Esc · ${MOD}↑)`;
  $('close-reader').setAttribute('aria-label', `Up to board ${title}`);
  $('close-reader').href = `${location.pathname}${location.search}${rounds[currentRound] ? `#round-${rounds[currentRound].id}` : ''}`;
  const child = graph?.childInfo(active.graphItem);
  const down = $('reader-down');
  down.hidden = !child;
  if (child) {
    $('reader-down-label').textContent = child.count == null ? 'Board' : `Board · ${child.count}`;
    down.title = `Go down into its board, ${child.title} (${MOD}↓)`;
    down.setAttribute('aria-label', `Open its board ${child.title}${child.count == null ? '' : `, ${child.count} ${child.count === 1 ? 'item' : 'items'}`}`);
  }
  readerPath.refresh();
  if (!readerInfo.hidden) renderReaderInfo();
}

function updateReaderNavigation() {
  const sequence = readerSequence();
  const index = sequence.findIndex(concept => concept.key === active?.key);
  const title = readerBoardTitle();
  $('reader-position').textContent = index < 0 ? '' : `Tinka ${index + 1} of ${sequence.length}: ${active.name}`;
  $('reader-stepper').hidden = index < 0;
  $('reader-stepper').setAttribute('aria-label', `Step through ${title}`);
  $('reader-count').textContent = index < 0 ? '' : `${index + 1} / ${sequence.length}`;
  $('reader-count').setAttribute('aria-label', index < 0 ? 'Neighbours' : `${index + 1} of ${sequence.length} on ${title}: show them`);
  $('reader-count').title = `${sequence.length} on ${title} · show them`;
  for (const [id, offset, label, arrow, bracket] of [['reader-previous', -1, 'Previous', '←', '['], ['reader-next', 1, 'Next', '→', ']']]) {
    const neighbor = index < 0 ? null : sequence[index + offset];
    const button = $(id);
    button.disabled = !neighbor;
    button.title = neighbor ? `${label}: ${neighbor.name} (${MOD}${arrow} or ${bracket})` : `No ${label.toLowerCase()} Tinka`;
    button.setAttribute('aria-label', neighbor ? `${label} Tinka: ${neighbor.name}` : `${label} Tinka`);
  }
  if (dialog.open && (document.activeElement === document.body || document.activeElement?.disabled)) focusTinka();
  renderReaderChrome();
}

// Stepping replaces the history entry instead of adding one: browser Back walks time
// (back to the board you opened this from), while ‹ › and the keys walk the board.
function stepReader(offset, { focus = 'keep' } = {}) {
  if (!active || !dialog.open) return false;
  const sequence = readerSequence();
  const index = sequence.findIndex(concept => concept.key === active.key);
  const next = index >= 0 && sequence[index + offset];
  if (!next) return false;
  openReader(next.key, 'original', { history: 'replace', focus });
  return true;
}

// Down a level: into the Tinka's own board.
function goDown() {
  const item = active?.graphItem;
  if (!graph || !item?.childBoardId) return false;
  graph.navigate(item.childBoardId, active.placement?.id);
  return true;
}

async function leaveReaderTo(url) {
  if (graph) { if (await graph.saveReview([], {}) === false) return; }
  else await flushNoteEdits();
  saveNavigatorView();
  location.href = url;
}

function openReader(key, revision = 'original', { history: mode = 'push', focus = 'tinka' } = {}) {
  const concept = all.find(item => item.key === key) || graph?.ownerConcept(key) || graph?.aliasConcept(key);
  if (!concept) return false;
  if(graph){revisions[concept.key]=graph.revisionsFor(concept.graphItem);notes[concept.key]={...(concept.graphItem.review||{}),...(graph.pendingReview.get(concept.graphItem.id)||{})};key=concept.key;}
  const variantId = (revisions[key] || []).some(variant => variant.id === revision) ? revision : 'original';
  if (dialog.open && active?.key === key && activeVariantId === variantId) {
    commitHistory(readerState(), mode === 'push' ? 'none' : mode);
    applyReaderFocus(focus);
    return true;
  }
  const opening = !dialog.open;
  setInfoOpen(false);
  active = concept;
  activeVariantId = variantId;
  if (opening) {
    setTheme(active.tone === 'night' ? 'night' : 'paper', false);
    setType(100, false);
    setReaderSize('fit');
    setReaderMenuOpen(false);
    setReaderInfoOpen(false);
    setNotesOpen(notesOpen, { focus: false });
  }
  renderRevisionOptions();
  renderReaderHeader();
  renderSizeControls();
  updateReaderNavigation();
  loadRevision();
  if (opening) {
    projectNavigator?.host?.(dialog, $('reader-navigator'));
    dialog.showModal();
    readerCanvas.rest();
  }
  commitHistory(readerState(), mode);
  updateMetadata();
  applyReaderFocus(focus);
  return true;
}

function closeReader({ history: mode = 'push' } = {}) {
  if (!active && !dialog.open) return;
  // Returning focus to the board must not move it: the board comes back exactly as it was left.
  const left = { ...view };
  const returnKey = active?.key;
  if (graph?.feedback?.mode === 'reader') graph.feedback.close({restoreFocus:false});
  graph?.feedback?.closeVote?.({restoreFocus:false});
  setReaderMenuOpen(false);
  setReaderInfoOpen(false);
  readerPath.close({ focus: false });
  readerCanvas.setSpacePan(false);
  if (dialog.open) dialog.close();
  projectNavigator?.host?.(null);
  replaceFrame($('active-reader'), 'about:blank');
  active = null;
  commitHistory({ view: 'board', round: rounds[currentRound]?.id || null }, mode);
  if (board) updateMetadata();
  viewport.focus({ preventScroll: true });
  settleCushion();
  Object.assign(view, left);
  applyView();
  // Land on the tile last viewed (after any arrowing between siblings).
  if (returnKey) requestAnimationFrame(() => returnToTile(returnKey));
}

// ---- The path: hover or click the title for where you are and what sits beside it ----
let readerPathExpanded = false;
function readerPathRow({ go, title, kind = '', n = null, current = false, depth = 0 }) {
  return `<button type="button" class="reader-path-row${current ? ' is-current' : ''}" data-path-go="${esc(go)}"${current ? ' aria-current="true"' : ''} style="--depth:${Math.min(depth, 6)}">${n != null ? `<span class="reader-path-n">${n}</span>` : ''}<span class="reader-path-title">${esc(title)}</span><span class="reader-path-kind">${esc(current ? 'here' : kind)}</span></button>`;
}
function renderReaderPath() {
  if (!active) return '';
  const current = readerBoardTitle();
  const rows = [{ go: 'home', title: 'Home', kind: 'All boards' }];
  const chain = graph?.boardPath?.() || [];
  const above = chain.slice(0, -1).map((b, i) => ({ go: `board:${b.id}:${i ? chain[i - 1].id : ''}`, title: b.title, kind: 'Board' }));
  // A deep path keeps its first board and the two nearest; the rest folds into one row.
  if (above.length > 3 && !readerPathExpanded) rows.push(above[0], { go: 'expand', title: `… ${above.length - 3} more`, kind: '' }, ...above.slice(-2));
  else rows.push(...above);
  rows.push({ go: 'up', title: current, kind: 'Board' });
  rows.push({ go: 'here', title: `${shownNumber(active) ? `${shownNumber(active)} · ` : ''}${descriptor(active, currentVariant()).name}`, current: true });
  const child = graph?.childInfo(active.graphItem);
  if (child) rows.push({ go: 'down', title: child.title, kind: child.count == null ? 'Its board' : `Its board · ${child.count}` });
  let html = `<section class="reader-path-section" aria-label="Where you are"><span class="tk-eyebrow">Where you are</span><ol class="reader-path-ladder">${rows.map((row, depth) => `<li>${readerPathRow({ ...row, depth })}</li>`).join('')}</ol></section>`;
  const sequence = readerSequence();
  if (sequence.length) html += `<section class="reader-path-section reader-path-sibs" aria-label="On ${esc(current)}"><span class="tk-eyebrow">On ${esc(current)} · ${sequence.length}</span><ol>${sequence.map((concept, i) => `<li>${readerPathRow({ go: `item:${concept.key}`, title: `${shownNumber(concept) ? `${shownNumber(concept)} · ` : ''}${concept.name}`, kind: readerKind(concept), n: i + 1, current: concept.key === active.key })}</li>`).join('')}</ol></section>`;
  const also = active.graphItem ? graph.alsoOn(active.graphItem.id) : [];
  if (also.length) html += `<section class="reader-path-section" aria-label="Also on"><span class="tk-eyebrow">Also on</span><ol>${also.map(b => `<li>${readerPathRow({ go: `reveal:${b.id}:${b.placementId}`, title: b.title, kind: 'Board' })}</li>`).join('')}</ol></section>`;
  return html;
}
function readerPathGo(target) {
  const [kind, a = '', b = ''] = target.split(':');
  if (kind === 'home') void leaveReaderTo('/');
  else if (kind === 'up') closeReader();
  else if (kind === 'down') goDown();
  else if (kind === 'here') focusTinka();
  else if (kind === 'expand') { readerPathExpanded = true; readerPath.open($('reader-path'), { pinned: true, focus: true }); }
  else if (kind === 'item') { const key = target.slice(5); if (key !== active?.key) openReader(key, 'original', { history: 'replace' }); else focusTinka(); }
  else if (kind === 'board') void leaveReaderTo(`/boards/${encodeURIComponent(a)}/${b ? `?from=${encodeURIComponent(b)}` : ''}`);
  else if (kind === 'reveal') void leaveReaderTo(`/boards/${encodeURIComponent(a)}/?reveal=${encodeURIComponent(b)}`);
}
$('reader-count').dataset.pathHover = 'false';
$('reader-count').dataset.pathFocus = '.reader-path-sibs [aria-current="true"]';
const readerPath = new ReaderPath($('reader-path-pop'), { anchors: [$('reader-path'), $('reader-count')], render: renderReaderPath, go: readerPathGo });

// ---- The opened Tinka's Inspector: details and actions (the former View panel's item actions) ----
readerInfo.innerHTML = `<header class="calm-side-head"><span class="tk-eyebrow" id="reader-info-kind">Tinka</span><button type="button" class="tk-btn tk-sm tk-icon" data-reader-act="close" aria-label="Close inspector"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg></button></header><div class="calm-side-body"><div id="reader-info-body" class="reader-info-body"></div><section class="inspector-sec reader-info-view"><h3>View <span>this browser</span></h3><div class="inspector-row" id="reader-info-view-row"><button type="button" class="tk-btn tk-sm" data-reader-act="shortcuts">Keyboard shortcuts</button></div></section></div>`;
mountAppearance($('reader-info-view-row'));
function renderReaderInfo() {
  if (!active) return;
  const item = active.graphItem, variant = currentVariant(), kind = readerKind(active);
  const sequence = readerSequence(), index = sequence.findIndex(concept => concept.key === active.key);
  const child = graph?.childInfo(item);
  const starred = !!notes[active.key]?.star;
  const versions = revisions[active.key] || [];
  const standalone = standaloneHref(active, variant);
  const description = item?.description || active.description || '';
  const act = (name, label, extra = '') => `<button type="button" class="tk-btn tk-sm" data-reader-act="${name}"${extra}>${label}</button>`;
  $('reader-info-kind').textContent = kind;
  // A re-render (a step or a live update) keeps keyboard focus on the same action.
  const focused = $('reader-info-body').contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused && (focused.dataset.readerAct ? `[data-reader-act="${focused.dataset.readerAct}"]` : focused.dataset.revisionChoice ? `[data-revision-choice="${CSS.escape(focused.dataset.revisionChoice)}"]` : null);
  $('reader-info-body').innerHTML = `<div class="inspector-title"><h2 id="reader-info-name">${esc(descriptor(active, variant).name)}</h2><p>${esc(kind)} · on ${esc(readerBoardTitle())}${index >= 0 ? ` · ${index + 1} of ${sequence.length}` : ''}</p></div>
    ${description ? `<p class="inspector-desc">${esc(description)}</p>` : ''}
    ${item ? '<p class="reader-owned">Its content belongs to the agent that made it. Tinka shows and zooms it and keeps your review here; editing happens on its own board, one level down.</p>' : ''}
    <section class="inspector-sec"><h3>Open</h3><div class="inspector-row">${child ? act('down', `Open its board ↓${child.count == null ? '' : ` · ${child.count}`}`) : graph && item ? act('add-board', 'Add board…') : ''}${standalone ? `<a class="tk-btn tk-sm" href="${esc(standalone)}" target="_blank" rel="noopener noreferrer">Open standalone ↗</a>` : ''}${act('reload', 'Reload')}</div></section>
    <section class="inspector-sec"><h3>Review</h3><div class="inspector-row">${act('star', starred ? 'Unfavorite' : 'Favorite', ` aria-pressed="${starred}"`)}${act('notes', 'Notes', ` aria-pressed="${notesOpen}"`)}${graph && item ? act('comments', 'Comments') + act('vote', 'Vote', ' aria-haspopup="dialog"') : ''}</div></section>
    ${versions.length ? `<section class="inspector-sec"><h3>Version</h3><div class="inspector-row">${[{ id: 'original', name: 'Original' }, ...versions].map(v => `<button type="button" class="tk-btn tk-sm" data-revision-choice="${esc(v.id)}" aria-pressed="${v.id === activeVariantId}">${esc(v.name)}</button>`).join('')}</div></section>` : ''}
    ${graph && item ? `<section class="inspector-sec"><h3>Item</h3><div class="inspector-row">${act('edit', 'Edit details…')}${active.placement ? act('move', 'Move to board…') + act('reference', 'Add reference…') + act('feature', 'Show on parent…') : ''}</div></section>` : ''}`;
  if (focusKey) $('reader-info-body').querySelector(focusKey)?.focus({ preventScroll: true });
}
function setReaderInfoOpen(open, { focus = false } = {}) {
  if (open) renderReaderInfo();
  readerInfo.hidden = !open;
  $('reader-info-toggle').setAttribute('aria-expanded', String(open));
  if (open && focus) readerInfo.querySelector('[data-reader-act="close"]')?.focus({ preventScroll: true });
  else if (!open && focus) $('reader-info-toggle').focus({ preventScroll: true });
}
readerInfo.addEventListener('click', event => {
  const button = event.target.closest('[data-reader-act]');
  if (!button || !active) return;
  const item = active.graphItem, name = button.dataset.readerAct;
  if (name === 'close') setReaderInfoOpen(false, { focus: true });
  else if (name === 'down') goDown();
  else if (name === 'add-board') graph?.addChildren(item);
  else if (name === 'reload') loadRevision();
  else if (name === 'star') { $('reader-star').click(); renderReaderInfo(); }
  else if (name === 'notes') { setNotesOpen(!notesOpen, { focus: false }); renderReaderInfo(); }
  else if (name === 'comments') { setReaderInfoOpen(false); graph?.feedback.open({ itemId: item.id, mode: 'reader', host: dialog.querySelector('.reader-area'), returnFocus: $('reader-info-toggle') }); }
  else if (name === 'vote') graph?.feedback.openVote({ itemId: item.id, anchor: button, returnFocus: $('reader-info-toggle') });
  else if (name === 'edit') graph?.editItem(item);
  else if (['move', 'reference', 'feature'].includes(name) && active.placement) void graph?.organize(name, active.placement.id).catch(error => setSaveStatus(error.message, 'error'));
  else if (name === 'shortcuts') readerShortcuts();
});

function readerShortcuts() {
  return makeDialog('Keyboard shortcuts', `<p>Use these keys on an opened Tinka. Text fields keep their own keys, and so does content you are working in.</p>
    <dl><dt>${MOD}← · ${MOD}→</dt><dd>Previous · next Tinka on this board (also while local content has focus)</dd>
    <dt>[ · ]</dt><dd>Previous · next Tinka</dd>
    <dt>← · →</dt><dd>Previous · next, while Tinka (not the content) has focus</dd>
    <dt>${MOD}↑ · Escape</dt><dd>Up to the board</dd>
    <dt>${MOD}↓</dt><dd>Down into this Tinka's own board, when it has one</dd>
    <dt>F · Shift-1</dt><dd>Fit this Tinka</dd>
    <dt>Shift-0 · + · −</dt><dd>Zoom to 100% · zoom in · zoom out</dd>
    <dt>⌘/Ctrl-scroll · pinch</dt><dd>Zoom the Tinka, also over local content; the page never zooms</dd>
    <dt>Drag the background · Space-drag</dt><dd>Pan</dd>
    <dt>⌘/Ctrl-K</dt><dd>Find across this project (Navigator)</dd>
    <dt>⌘/Ctrl-I</dt><dd>Inspector for this Tinka</dd>
    <dt>?</dt><dd>Show keyboard shortcuts</dd></dl>`);
}

// ---- Keys: step, up and down, fit and zoom; forwarded from same-origin content frames too ----
function readerEditable(target) {
  return !!(target?.isContentEditable || target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="slider"]'));
}
// Tinka (not the content, a panel or a menu) has focus.
function readerTinkaFocus(target) {
  if (!target?.closest || !dialog.contains(target) || target === $('active-reader')) return false;
  return !target.closest('#reader-path-pop,#reader-zoom-menu,#reader-info,#notes-panel,.feedback-panel,.feedback-ballot,.project-navigator,.tk-seg');
}
function readerBlocked() { return !dialog.open || !!document.querySelector('dialog.workspace-dialog[open]'); }
function runReaderCommand(command, { fromFrame = false } = {}) {
  if (command === 'previous' || command === 'next') { stepReader(command === 'next' ? 1 : -1, { focus: fromFrame ? 'tinka' : 'keep' }); return true; }
  if (command === 'up') { closeReader(); return true; }
  if (command === 'down') return goDown();
  if (command === 'fit') { readerCanvas.fit(); return true; }
  if (command === 'actual-size') { readerCanvas.zoomTo(1); return true; }
  if (command === 'zoom-in') { readerCanvas.zoomTo(readerCanvas.view.zoom * 1.25); return true; }
  if (command === 'zoom-out') { readerCanvas.zoomTo(readerCanvas.view.zoom / 1.25); return true; }
  if (command === 'shortcuts') { readerShortcuts(); return true; }
  return false;
}
document.addEventListener('keydown', event => {
  if (readerBlocked() || event.defaultPrevented || event.key === 'Escape') return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'i') {
    if (readerEditable(event.target) || event.repeat) return;
    event.preventDefault(); event.stopImmediatePropagation();
    setReaderInfoOpen(readerInfo.hidden, { focus: true });
    return;
  }
  if (event.key === ' ' && event.target === readerStage) { event.preventDefault(); if (!event.repeat) readerCanvas.setSpacePan(true); return; }
  // The Navigator keeps its own arrows and typing.
  if (event.target?.closest?.('.project-navigator') && !event.altKey && !event.ctrlKey) return;
  const command = readerCommand(event, { mac: readerKeysMac, editable: readerEditable(event.target), tinkaFocus: readerTinkaFocus(event.target) });
  if (!command) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat && !['zoom-in', 'zoom-out'].includes(command)) return;
  runReaderCommand(command);
}, true);
document.addEventListener('keyup', event => { if (event.key === ' ') readerCanvas.setSpacePan(false); }, true);
// Same-origin content (Tinka's own item, media and board files, and frames inside them)
// forwards the step/up/down chords and ⌘/Ctrl-scroll or pinch; independent pages cannot.
const FORWARDED = Symbol('tinka-reader-forward');
function framePoint(win, x, y) {
  try {
    for (let w = win; w && w !== window && w.frameElement;) {
      const element = w.frameElement, r = element.getBoundingClientRect(), scale = element.offsetWidth ? r.width / element.offsetWidth : 1;
      x = r.left + (element.clientLeft + x) * scale; y = r.top + (element.clientTop + y) * scale;
      w = element.ownerDocument.defaultView;
    }
  } catch {}
  return { x, y };
}
function forwardFrame(frame) {
  let win, doc;
  try { win = frame.contentWindow; doc = frame.contentDocument; } catch { return; }
  if (!win || !doc || doc[FORWARDED]) return;
  doc[FORWARDED] = true;
  win.addEventListener('keydown', event => {
    if (readerBlocked() || event.defaultPrevented || event.key === 'Escape') return;
    const command = readerCommand(event, { mac: readerKeysMac, editable: readerEditable(event.target), fromFrame: true });
    if (!command) return;
    event.preventDefault();
    if (!event.repeat) runReaderCommand(command, { fromFrame: true });
  }, true);
  win.addEventListener('wheel', event => {
    if (!(event.ctrlKey || event.metaKey) || readerBlocked()) return;
    event.preventDefault();
    const point = framePoint(win, event.clientX, event.clientY);
    readerCanvas.zoomAtClient(wheelZoomFactor(event), point.x, point.y);
  }, { passive: false, capture: true });
  let gestureScale = 1;
  win.addEventListener('gesturestart', event => { if (readerBlocked()) return; event.preventDefault(); gestureScale = 1; });
  win.addEventListener('gesturechange', event => {
    if (readerBlocked()) return;
    event.preventDefault();
    const scale = event.scale > 0 ? event.scale : 1, point = framePoint(win, event.clientX, event.clientY);
    readerCanvas.zoomAtClient(scale / gestureScale, point.x, point.y);
    gestureScale = scale;
  });
  doc.addEventListener('load', event => { if (event.target?.tagName === 'IFRAME') forwardFrame(event.target); }, true);
  for (const inner of doc.querySelectorAll('iframe')) forwardFrame(inner);
}

// The displayed number of a concept: authored manifest numbers for legacy boards,
// an authored item or migrated number for graph boards; never an invented ordinal.
function shownNumber(concept) {
  const value = concept?.graphItem ? concept.shownNumber : concept?.number;
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 8) : '';
}

// Return to origin: if the tile is not comfortably in view, a short pan/zoom brings
// it to the centre (instantly with reduced motion); then it pulses green once.
// This changes only the in-memory view, never saved geometry or data.
function flyTo(targetZoom, targetX, targetY) {
  stopGlide(); resting = false;
  const from = { zoom, x: view.x, y: view.y };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now();
  const step = now => {
    const t = reduced ? 1 : Math.min(1, (now - start) / 320), e = 1 - (1 - t) ** 3;
    zoom = t < 1 ? from.zoom + (targetZoom - from.zoom) * e : targetZoom;
    view.x = t < 1 ? from.x + (targetX - from.x) * e : targetX; view.y = t < 1 ? from.y + (targetY - from.y) * e : targetY;
    applyView();
    if (t < 1) flight = requestAnimationFrame(step); else { flight = 0; trackRound(); }
    if (t >= 1) return;
  };
  if (reduced) step(start); else flight = requestAnimationFrame(step);
}
function returnToTile(key, { placementId } = {}) {
  const tile = placementId ? world.querySelector(`.workspace-card[data-placement="${CSS.escape(placementId)}"]`) : world.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!tile || dialog.open) return false;
  const vr = viewport.getBoundingClientRect(), r = tile.getBoundingClientRect();
  const visibleArea = Math.max(0, Math.min(r.right, vr.right) - Math.max(r.left, vr.left)) * Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
  const comfortable = visibleArea >= r.width * r.height * .85 && r.width >= 48 && r.height >= 36;
  if (!comfortable) {
    if (graph?.mode === 'grid') tile.scrollIntoView({ block: 'center', inline: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    else {
      const w = r.width / zoom, h = r.height / zoom;
      const fit = Math.min((viewport.clientWidth - 120) / w, (viewport.clientHeight - 140) / h);
      const target = clampZoom(Math.min(Math.max(zoom, Math.min(fit, .6)), fit, 1));
      const worldRect = world.getBoundingClientRect();
      const cx = (r.left + r.width / 2 - worldRect.left) / zoom, cy = (r.top + r.height / 2 - worldRect.top) / zoom;
      const x0 = worldRect.left - view.x, y0 = worldRect.top - view.y;
      flyTo(target, vr.left + viewport.clientWidth / 2 - x0 - cx * target, vr.top + viewport.clientHeight / 2 - y0 - cy * target);
    }
  }
  if (graph && tile.dataset.placement) graph.pulse(tile.dataset.placement);
  else {
    tile.classList.remove('return-pulse'); void tile.offsetWidth; tile.classList.add('return-pulse');
    clearTimeout(tile.returnPulseTimer); tile.returnPulseTimer = setTimeout(() => tile.classList.remove('return-pulse'), 1800);
  }
  return true;
}
// Entering a child board from its tile records where to land on the way back (see WorkspaceBoard.navigate).
const RETURN_KEY = () => workspaceId ? `tinka/${workspaceId}/return-to-tile` : null;
let landed = false;
function landFromChild() {
  let entry = null;
  try { entry = JSON.parse(sessionStorage.getItem(RETURN_KEY()) || 'null'); } catch {}
  if (!entry || entry.parentBoardId !== boardId || Date.now() - entry.at > 6 * 60 * 60 * 1000) return;
  if (new URLSearchParams(location.search).has('reveal')) return;
  const tries = { n: 0 };
  const attempt = () => {
    if (returnToTile(null, { placementId: entry.placementId })) { try { sessionStorage.removeItem(RETURN_KEY()); } catch {} return; }
    if (++tries.n < 40) setTimeout(attempt, 100);
  };
  attempt();
}
addEventListener('pageshow', event => { if (event.persisted) landFromChild(); });

// Escape closes the innermost thing first (feedback, the path, the % menu, the Inspector,
// the Navigator, notes while typing in them), otherwise goes up to the board.
function handleEscape(event) {
  const keyEvent=event||{key:'Escape',defaultPrevented:false,isComposing:false,preventDefault(){},stopImmediatePropagation(){}};
  if(graph?.feedback?.consumeEscape(keyEvent))return true;
  if (readerPath.isOpen) { readerPath.close({ focus: true }); return true; }
  if (!$('reader-zoom-menu').hidden) { setReaderMenuOpen(false, { focus: true }); return true; }
  if (!readerInfo.hidden) { setReaderInfoOpen(false, { focus: true }); return true; }
  if (projectNavigator?.isOpen && projectNavigator.hostEl) { projectNavigator.hide(); return true; }
  if (notesOpen && $('notes-panel').contains(document.activeElement)) { setNotesOpen(false); return true; }
  closeReader();
  return true;
}

// ---- On-demand tile controls ----
const noteGlyph='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h9l3.5 3.5v13.5H6zM9 11h6M9 15h4"/></svg>';
const moreGlyph='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
const tileNotes=new TileNotes({
  read:key=>notes[key]?.note||'',
  draftKey:key=>`tinka/${workspaceId}/${boardId}/note-draft/${key}`,
  save:async(key,value)=>{
    if(graph){
      const item=all.find(c=>c.key===key)?.graphItem;
      if(!item)throw Error('This item is no longer on the board.');
      await graph.saveTileNote(item.id,value);
    } else {
      const updatedAt=Date.now();
      await persistLegacyNotes(saveSequence,()=>JSON.stringify({...notes,[key]:{...notes[key],note:value,updatedAt}}),()=>{
        // Publish only after ACK, preserving star changes made during this save.
        notes[key]={...notes[key],note:value,updatedAt};
        try{localStorage.setItem(notesKey,JSON.stringify(notes));}catch{}
      });
    }
    applyNotes();
  },
  discard:async key=>{
    if(graph){await graph.refresh({saveReview:false});return;}
    const baseline=legacyCommittedNotes[key]?.note||'', local=notes[key]?.note||'', sequence=legacyCommitSequence;
    const response=await fetch(`${boardApi}/notes`,{cache:'no-store',signal:AbortSignal.timeout(3000)});
    if(!response.ok)return;
    const current=await response.json();
    // A later ACK or a separate local editor wins over this read. Otherwise
    // return to the latest committed note, including another writer's update.
    if(sequence!==legacyCommitSequence || (notes[key]?.note||'')!==local || local!==baseline)return;
    legacyCommittedNotes=current;
    notes[key]={...notes[key],note:current[key]?.note||''};
    try{localStorage.setItem(notesKey,JSON.stringify(notes));}catch{}
    applyNotes();
  }
});
async function openTileNote(key,anchor){
  if(!await ensureNotesReady())return;
  const concept=all.find(c=>c.key===key);if(!concept)return;
  // A Notes menu row is removed before this handler runs. Anchor the editor to
  // the persistent tile control, not that detached row's empty rectangle.
  const tile=world.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if(!anchor?.isConnected||!tile?.contains(anchor))anchor=tile?.querySelector(graph?'[data-item-controls]':'[data-legacy-menu]')||anchor;
  closeLegacyMenu();graph?.closeContext();tileNotes.open({key,title:concept.name,anchor});
}
let legacyMenu=null,legacyMenuKey=null,legacyMenuBinding=null;
function closeLegacyMenu(focus=false){legacyMenuBinding?.destroy();legacyMenuBinding=null;const key=legacyMenuKey;legacyMenu?.remove();legacyMenu=null;legacyMenuKey=null;const button=document.querySelector(`[data-legacy-menu="${CSS.escape(key||'')}"]`);button?.setAttribute('aria-expanded','false');if(focus)button?.focus({preventScroll:true});}
function openLegacyMenu(key,anchor){
  if(legacyMenuKey===key){closeLegacyMenu(true);return;}
  closeLegacyMenu();tileNotes.close();
  const concept=all.find(c=>c.key===key);if(!concept)return;
  const handoff=safeBoardPath(concept.handoff),unavailable=['reserved','building'].includes(liveSnapshot?.concepts?.[key]?.state);
  const menu=document.createElement('div');menu.className='tk-menu workspace-tile-menu legacy-tile-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',`Actions for ${concept.name}`);
  menu.innerHTML=`<button role="menuitem" class="tk-mi" data-open="${esc(key)}" ${unavailable?'disabled':''}>Open experiment</button>${(revisions[key]||[]).map(variant=>`<button role="menuitem" class="tk-mi" data-open="${esc(key)}" data-revision="${esc(variant.id)}" ${unavailable?'disabled':''}>Try ${esc(variant.name)}</button>`).join('')}${handoff?`<a role="menuitem" class="tk-mi" href="${esc(handoff)}" target="_blank" rel="noopener">Handoff</a>`:''}<button role="menuitem" class="tk-mi" data-tile-notes="${esc(key)}">Notes</button><div class="tk-msep" role="separator"></div><button role="menuitem" class="tk-mi tk-danger" data-remove-experiment="${esc(key)}">Remove from board…</button>`;
  legacyMenu=menu;legacyMenuKey=key;document.body.append(menu);anchor.setAttribute('aria-expanded','true');positionTilePopover(menu,anchor);legacyMenuBinding=bindTileMenu(menu,{close:()=>closeLegacyMenu(),returnFocus:anchor,anchor});
  menu.addEventListener('click',event=>{if(event.target.closest('[role="menuitem"]'))closeLegacyMenu();});
}
document.addEventListener('click',event=>{const menu=event.target.closest('[data-legacy-menu]');if(menu)openLegacyMenu(menu.dataset.legacyMenu,menu);const note=event.target.closest('[data-tile-notes]');if(note)openTileNote(note.dataset.tileNotes,note);});
document.addEventListener('pointerdown',event=>{if(legacyMenu&&!event.target.closest('.legacy-tile-menu,[data-legacy-menu]'))closeLegacyMenu();},true);
window.addEventListener('resize',()=>closeLegacyMenu());

// ---- Notes ----
function applyNotes() {
  $('reader-note').disabled=!graph&&!notesReady;
  $('reader-star').disabled=!graph&&!notesReady;
  document.querySelectorAll('[data-tile-notes]').forEach(element=>{const has=Boolean(notes[element.dataset.tileNotes]?.note);element.querySelector('.tile-note-dot')?.toggleAttribute('hidden',!has);element.title=has?'Notes · has a saved note':'Notes';});
  document.querySelectorAll('[data-note]').forEach(element => { const value = notes[element.dataset.note]?.note || ''; if (element.value !== value) element.value = value; });
  document.querySelectorAll('[data-star]').forEach(element => { const starred = Boolean(notes[element.dataset.star]?.star); element.setAttribute('aria-pressed', String(starred)); element.disabled=!graph&&!notesReady; if(!element.querySelector('svg'))element.textContent = starred ? '★' : '☆'; });
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

async function flushNoteEdits(){
  clearTimeout(saveTimer);
  if(graph){if(await graph.saveReview(active&&!all.includes(active)?[...all,active]:all,notes)===false)throw Error('Notes remain in this browser. Try again.');return;}
  if(!await ensureNotesReady())throw Error('Notes unavailable. Reconnect and try Notes again before editing.');
  await persistLegacyNotes(saveSequence,()=>JSON.stringify(notes));
}
function persistLegacyNotes(revision,body,onSaved=()=>{}){
  const attempt=saveQueue.catch(()=>{}).then(async()=>{
    try{const payload=typeof body==='function'?body():body;const response=await fetch(`${boardApi}/notes`,{method:'PUT',headers:{'Content-Type':'application/json','X-Tinka-Workspace':workspaceId},body:payload});if(!response.ok)throw new Error('Notes not saved. Retry when the service is ready.');legacyCommittedNotes=JSON.parse(payload);legacyCommitSequence++;onSaved();if(revision===saveSequence)setSaveStatus('Notes saved on this Mac','saved');}
    catch(error){if(revision===saveSequence)setSaveStatus('Saved in this browser · retry or export notes','local');throw error;}
  });saveQueue=attempt.catch(()=>{});return attempt;
}
function storeNotes() {
  if (graph) { graph.captureReview(active&&!all.includes(active)?[...all,active]:all,notes); clearTimeout(saveTimer); setSaveStatus('Saving item notes…','saving'); saveTimer=setTimeout(()=>graph.saveReview(active&&!all.includes(active)?[...all,active]:all,notes),350); return; }
  if(!notesReady){setSaveStatus('Notes unavailable · reconnect and try Notes again','local');return;}
  const revision = ++saveSequence;
  try { localStorage.setItem(notesKey, JSON.stringify(notes)); } catch {}
  setSaveStatus('Saving notes…', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistLegacyNotes(revision,()=>JSON.stringify(notes)).catch(()=>{});
  }, 350);
}

// Coalesce the cold read. Editing and whole-map legacy writes must not start
// from an empty placeholder while the authoritative notes are still unknown.
async function ensureNotesReady(){
  if(notesReady)return true;
  if(!notesLoading)notesLoading=loadNotes().finally(()=>{notesLoading=null;});
  return notesLoading;
}
async function loadNotes() {
  if (graph) { notes = board.graphNotes || {}; notesReady=true; applyNotes(); setSaveStatus(graph.pendingReview.size?'Unsaved feedback restored · retry when ready':'Item notes saved on this Mac',graph.pendingReview.size?'local':'saved'); return true; }
  const backup = localNotes(notesKey);
  let server = {};
  let connected = false;
  try {
    const response = await fetch(`${boardApi}/notes`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Notes unavailable');
    const value = await response.json();
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Notes unavailable');
    server=value;connected = true;
  } catch {}
  notesReady=connected;
  legacyCommittedNotes = structuredClone(server);
  notes = { ...server };
  const changed = mergeNotes(notes, backup);
  setSaveStatus(connected ? 'Notes saved on this Mac' : 'Notes unavailable · reconnect and try Notes again', connected ? 'saved' : 'local');
  applyNotes();
  if (changed && connected && !overview) storeNotes();
  return connected;
}

// ---- Live build state ----
function decorateBuildCards() {
  document.querySelectorAll('.concept-card').forEach(card => {
    const badge = card.querySelector('.build-badge'); badge.textContent = 'Connecting';
    const overlay = document.createElement('div'); overlay.className = 'build-overlay'; overlay.hidden = true;
    const orbit = document.createElement('i'); orbit.className = 'build-orbit'; orbit.setAttribute('aria-hidden', 'true');
    overlay.append(orbit, document.createElement('strong'), document.createElement('span'));
    card.querySelector('.preview').append(overlay);
  });
}

function applyBoardSnapshotNow(snapshot) {
  if (graph) {
    graph.updateCovers(snapshot.boardCovers);
    const concepts = Object.fromEntries(all.map(c=>[c.key, {...(c.graphItem.build||{state:'ready'}), ...(snapshot.items?.[c.graphItem.id]||{})}]));
    liveSnapshot = {...snapshot,concepts};
    for (const concept of all) {
      const revision = concepts[concept.key]?.revision;
      if (!revision) continue;
      const card = [...world.querySelectorAll('.workspace-card')].find(c => c.dataset.key === concept.key);
      if (loadedPreviews.has(concept.key) && loadedPreviews.get(concept.key) !== revision) {
        const frame = card?.querySelector('.workspace-live-preview iframe');
        if (frame) {
          const source=new URL(frame.src,location.href);
          if(source.pathname==='/app/media.html'&&['panel','card'].includes(source.searchParams.get('mode'))&&source.searchParams.get('kind')==='markdown'){source.searchParams.set('v',revision);replaceFrame(frame,source.href);}
          else replaceFrame(frame, previewHref(concept, null, 'paper', 100, revision));
        }
        const pdf = card?.querySelector('.workspace-pdf-preview');
        if (pdf) {
          const source = new URL(pdf.src, location.href);
          source.searchParams.set('v', revision);
          pdf.src = source.href;
        }
        const image = card?.querySelector('.workspace-card-preview img');
        if (image) {
          const source = new URL(image.src, location.href);
          source.searchParams.set('v', revision);
          image.src = source.href;
        }
      }
      loadedPreviews.set(concept.key, revision);
    }
    const entry=concepts[active?.key]; if(active&&entry?.revision){ if(!activeRevision)activeRevision=entry.revision; $('reader-update').hidden=activeRevision===entry.revision; }
    $('live-status').textContent='Live · '+all.length+' items'; if(active)updateReaderNavigation(); return;
  }
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
  }
  const entries = all.map(concept => snapshot.concepts[concept.key]).filter(Boolean);
  const building = entries.filter(entry => entry.state === 'building').length;
  const review = entries.filter(entry => entry.state === 'review').length;
  const ready = entries.filter(entry => entry.state === 'ready').length;
  const parts = [building ? `${building} building` : null, review ? `${review} to review` : null, ready ? `${ready} ready` : null].filter(Boolean);
  $('live-status').textContent = `Live · ${parts.join(' · ') || 'Waiting for experiments'}`;
  if (active) updateReaderNavigation();
}

function acceptGraphData(fresh) {
  const activeKey=active?.key; board=fresh;rounds=fresh.rounds;revisions=fresh.revisions||{};notes=fresh.graphNotes||{};readRound();currentRound=Math.min(currentRound,Math.max(0,rounds.length-1));buildCanvas();
  if(activeKey){active=all.find(c=>c.key===activeKey)||active;renderRevisionOptions();renderReaderHeader();updateReaderNavigation();refreshReaderAnnotations({itemId:active.graphItem?.id});}
}

let pendingLiveSnapshot=null,liveManifestPending=false,liveDraining=false;
function liveBlocked(){
  const focused=document.activeElement;
  // Legacy board notes already preserve their exact value and selection during
  // keyed manifest reconciliation. Other editors retain deferred refresh.
  const legacyNote=!graph&&focused?.matches('textarea[data-note]')&&world.contains(focused);
  const editing=focused?.closest?.('textarea,input,select,[contenteditable]')&&!legacyNote&&!focused?.closest('.tile-notes');
  return !!(pointers.size||graph?.liveBlocked?.()||graph?.pointerGesture||graph?.decorationGesture||graph?.moveCommitting||graph?.client.pendingWrites||graph?.saving||editing||document.querySelector('dialog.workspace-dialog[open]'));
}
async function drainLiveUpdates(){
  if(liveDraining||liveBlocked())return;liveDraining=true;
  try{while(!liveBlocked()&&(liveManifestPending||pendingLiveSnapshot)){
    if(liveManifestPending){liveManifestPending=false;try{await refreshManifestNow();}catch(error){liveManifestPending=true;throw error;}}
    if(liveBlocked())break;
    if(pendingLiveSnapshot){const snapshot=pendingLiveSnapshot;pendingLiveSnapshot=null;applyBoardSnapshotNow(snapshot);}
  }}finally{liveDraining=false;}
}
function applyBoardSnapshot(snapshot){pendingLiveSnapshot=snapshot;return drainLiveUpdates();}
function refreshManifest(){liveManifestPending=true;return drainLiveUpdates();}
document.addEventListener('focusout',()=>queueMicrotask(()=>{void drainLiveUpdates().catch(()=>{});}));
document.addEventListener('close',()=>queueMicrotask(()=>{void drainLiveUpdates().catch(()=>{});}),true);
async function refreshManifestNow() {
  if(graph){await graph.refresh({saveReview:false});return;}
  const fresh = await fetchBoard();
  const selected = rounds[currentRound]?.id;
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
  try { sessionStorage.setItem(viewKey, JSON.stringify({ zoom, x: view.x, y: view.y, resting, round: rounds[currentRound]?.id })); } catch {}
  if (graph) { clearTimeout(saveTimer); await graph.saveReview(active&&!all.includes(active)?[...all,active]:all,notes); }
  if (saveSequence && !graph) {
    try { await saveQueue; await fetch(`${boardApi}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Tinka-Workspace': workspaceId }, body: JSON.stringify(notes) }); } catch {}
  }
  location.reload();
}

function scheduleShellReload() {
  $('live-refresh').hidden = false;
  // A new app shell is available. Only the explicit refresh action replaces the
  // page, preserving reader state, local drafts and active gestures.
}

function showError(message) {
  $('board-error').textContent = message;
  $('board-error').hidden = false;
  setSaveStatus('Board unavailable', 'error');
}

function setInfoOpen(open, { focus = false } = {}) {
  if (open) graph?.closeContext?.();
  $('board-info').hidden = !open;
  $('board-info-toggle').setAttribute('aria-expanded', String(open));
  if (focus) (open ? $('board-info').querySelector('button,input,a') : $('board-info-toggle'))?.focus({ preventScroll: true });
}

// Controls are bound once; board content is replaced only after a manifest update.
document.addEventListener('pointerdown', event => {
  const remove = event.target.closest('[data-remove-experiment]');
  if (remove && event.button === 0) { event.preventDefault(); remove.focus({ preventScroll: true }); }
  if (!$('reader-zoom-menu').hidden && !event.target.closest('.reader-footer .zoom-menu-wrap')) setReaderMenuOpen(false);
  if (readerPath.isOpen && !event.target.closest('#reader-path-pop, #reader-path, #reader-count')) readerPath.close({ focus: false });
  if (!readerInfo.hidden && !event.target.closest('#reader-info, #reader-info-toggle, .workspace-dialog, .feedback-ballot')) setReaderInfoOpen(false);
});
document.addEventListener('pointerdown', event => {
  if (!$('board-info').hidden && !event.target.closest('#board-info, #board-info-toggle, .workspace-dialog, dialog[open], .workspace-add-menu, .workspace-popover, .feedback-panel')) setInfoOpen(false);
  if (!$('zoom-menu').hidden && !event.target.closest('.zoom-menu-wrap')) setZoomMenuOpen(false);
}, true);
document.addEventListener('click', event => {
  const open = event.target.closest('[data-open]');
  const star = event.target.closest('[data-star]');
  const remove = event.target.closest('[data-remove-experiment]');
  if (remove && appConfig) {
    const concept = all.find(item => item.key === remove.dataset.removeExperiment);
    if (concept) {closeLegacyMenu();document.querySelector(`[data-legacy-menu="${CSS.escape(concept.key)}"]`)?.focus({preventScroll:true});openRemovalPrompt(appConfig, board, concept);}
  }
  if (open && !open.disabled) {
    closeLegacyMenu();
    tileNotes.close();
    const concept = graph && (all.find(item => item.key === open.dataset.open) || graph.aliasConcept(open.dataset.open));
    if (concept?.graphItem.childBoardId && !concept.graphItem.content)
      graph.navigate(concept.graphItem.childBoardId, concept.placement?.id);
    else openReader(open.dataset.open, open.dataset.revision);
  }
  if (star?.dataset.star) {
    const key = star.dataset.star;
    notes[key] = { ...notes[key], star: !notes[key]?.star, updatedAt: Date.now() };
    if(graph){const item=all.find(c=>c.key===key)?.graphItem||active?.graphItem;for(const c of all)if(c.graphItem.id===item?.id)notes[c.key]={...notes[c.key],star:notes[key].star};}
    applyNotes();
    storeNotes();
  }
});
document.addEventListener('input', event => {
  const target = event.target;
  const key = target.dataset.note || (target.id === 'reader-note' ? active?.key : null);
  if (!key) return;
  notes[key] = { ...notes[key], note: target.value, updatedAt: Date.now() };
  if(graph){const item=all.find(c=>c.key===key)?.graphItem||active?.graphItem;for(const c of all)if(c.graphItem.id===item?.id)notes[c.key]={...notes[c.key],note:target.value};}
  // The board card and the experiment view edit the same note.
  document.querySelectorAll('[data-note]').forEach(element => { if (element !== target && element.dataset.note === key) element.value = target.value; });
  syncReaderNotes();
  storeNotes();
});
bindCommitShortcut(world,{accept:event=>event.target.matches('textarea[data-note]'),commit:flushNoteEdits,onError:error=>setSaveStatus(error.message,'local')});
bindCommitShortcut($('reader-note'),{commit:flushNoteEdits,onError:error=>setSaveStatus(error.message,'local')});
$('reader-note').setAttribute('aria-keyshortcuts','Meta+Enter Control+Enter');
const readerNoteHint=document.createElement('small');readerNoteHint.className='workspace-submit-hint';readerNoteHint.textContent=`${commitShortcutLabel()} to save`; $('reader-note').after(readerNoteHint);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode===229 || event.repeat || document.querySelector('dialog.workspace-dialog[open]')) return;
  if (tileNotes.element) {event.preventDefault();event.stopImmediatePropagation();tileNotes.close({focus:true});return;}
  if (legacyMenu) {event.preventDefault();event.stopImmediatePropagation();closeLegacyMenu(true);return;}
  if (dialog.open) { if (projectNavigator?.panel?.contains(event.target)) return; handleEscape(event); event.preventDefault(); return; }
  if (!$('zoom-menu').hidden) { event.preventDefault(); setZoomMenuOpen(false, { focus: true }); return; }
  if (!$('board-info').hidden) { event.preventDefault(); setInfoOpen(false, { focus: true }); }
}, true);

slider.addEventListener('input', () => {if(graph)graph.revealedPlacement=null;changeZoom(zoomFromSlider(slider.value));});
$('fit').onclick = event => runFit(event.altKey ? 'board' : smartFitTarget());
$('view-back').onclick = goBack;
$('board-info-toggle').onclick = () => setInfoOpen($('board-info').hidden, { focus: true });
$('board-info-close').onclick = () => setInfoOpen(false, { focus: true });
$('chrome-search').onclick = () => document.dispatchEvent(new CustomEvent('tinka:navigator-open'));
// ⌘I / Ctrl-I opens the Inspector: the selected item when there is exactly one, otherwise the board.
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'i' || event.repeat) return;
  if (dialog.open || event.target.closest?.('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  const sole = graph?.selection?.size === 1 ? [...graph.selection][0] : null;
  if (sole && graph.contextPlacement !== sole) { setInfoOpen(false); graph.itemControls(sole, 'notes'); return; }
  if (graph?.context) { graph.closeContext(true); return; }
  setInfoOpen($('board-info').hidden, { focus: true });
}, true);
// The floating view pill: − · percent menu · + · Fit.
function setZoomMenuOpen(open, { focus = false } = {}) {
  $('zoom-menu').hidden = !open;
  $('zoom-menu-toggle').setAttribute('aria-expanded', String(open));
  if (open) readSelection();
  $('zoom-menu').querySelector('[data-zoom-to="selection"]').hidden = !graph || graph.mode !== 'canvas' || !selectionInfo.count;
  if (open) $('zoom-menu').querySelector('button:not([hidden])')?.focus({ preventScroll: true });
  else if (focus) $('zoom-menu-toggle').focus({ preventScroll: true });
}
$('zoom-menu-toggle').onclick = () => setZoomMenuOpen($('zoom-menu').hidden);
$('zoom-minus').onclick = () => { if (graph) graph.revealedPlacement = null; changeZoom(zoom / 1.25); };
$('zoom-plus').onclick = () => { if (graph) graph.revealedPlacement = null; changeZoom(zoom * 1.25); };
$('zoom-menu').addEventListener('click', event => {
  const choice = event.target.closest('[data-zoom-to]');
  if (!choice) return;
  if (graph) graph.revealedPlacement = null;
  const to = choice.dataset.zoomTo;
  setZoomMenuOpen(false, { focus: true });
  if (to === 'fit') fitBoard();
  else if (to === 'selection') fitSelection();
  else changeZoom(Number(to));
});
$('zoom-menu').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const items = [...$('zoom-menu').querySelectorAll('button:not([hidden]),input')];
  const index = items.indexOf(document.activeElement);
  if (index < 0 || document.activeElement.type === 'range') return;
  event.preventDefault();
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});
document.addEventListener('click', event => {
  const pattern = event.target.closest('[data-canvas-pattern]');
  if (pattern) setCanvasPattern(pattern.dataset.canvasPattern);
});
// ---- Board map: a toggle in the zoom controls (M). It opens by itself on large
// boards at desktop widths, and remembers this browser's open/closed choice per board.
let boardMap = null, mapDecided = false, mapWanted = false;
const boardMapElement = () => $('board-map');
const mapKey = () => workspaceId && boardId ? `tinka/${workspaceId}/${boardId}/board-map` : null;
function mapAvailable() { return !!graph && graph.mode === 'canvas' && !overview; }
// Every rendered item and decoration, in world units, for the map's silhouettes.
function mapShapes() {
  if (!graph?.snapshot) return { items: [], decorations: [], bounds: null };
  const ox = graph.origin?.x || 0, oy = graph.origin?.y || 0;
  const selected = graph.selection;
  const items = graph.renderedPlacements().map(p => ({ x: p.x + ox, y: p.y + oy, width: p.width, height: p.height, selected: selected.has(p.id) }));
  const decorations = (graph.snapshot.decorations || []).map(d => { try { const b = decorationBounds(d, graph.snapshot); return { type: d.type, color: d.color, x: (b.x || 0) + ox, y: (b.y || 0) + oy, width: b.width || 0, height: b.height || 0 }; } catch { return null; } }).filter(Boolean);
  const all = [...items, ...decorations].filter(r => Number.isFinite(r.x) && Number.isFinite(r.y));
  if (!all.length) return { items, decorations, bounds: null };
  const x = Math.min(...all.map(r => r.x)), y = Math.min(...all.map(r => r.y));
  const bounds = { x, y, width: Math.max(1, Math.max(...all.map(r => r.x + Math.max(0, r.width))) - x), height: Math.max(1, Math.max(...all.map(r => r.y + Math.max(0, r.height))) - y) };
  return { items, decorations, bounds };
}
function centerOn(wx, wy, { glide = false } = {}) {
  if (graph) graph.revealedPlacement = null;
  const x = viewport.clientWidth / 2 - wx * zoom, y = viewport.clientHeight / 2 - wy * zoom;
  if (glide) flyTo(zoom, x, y); else moveView(x, y);
}
function ensureBoardMap() {
  if (boardMap || !boardMapElement()) return boardMap;
  boardMap = new BoardMap(boardMapElement(), {
    shapes: mapShapes,
    view: () => ({ x: view.x, y: view.y, zoom, width: viewport.clientWidth, height: viewport.clientHeight }),
    navigate: () => { if (graph) graph.revealedPlacement = null; },
    center: centerOn,
    panBy: (dx, dy) => moveView(view.x - dx * zoom, view.y - dy * zoom),
    panScreen: (fx, fy) => moveView(view.x + fx * viewport.clientWidth, view.y + fy * viewport.clientHeight),
    zoomAt: (factor, wx, wy) => { if (graph) graph.revealedPlacement = null; changeZoom(zoom * factor, view.x + wx * zoom, view.y + wy * zoom); },
    zoomBy: factor => { if (graph) graph.revealedPlacement = null; changeZoom(zoom * factor); },
    close: () => setMapOpen(false, { remember: true, focus: true }),
  });
  const el = boardMapElement();
  el.querySelector('[data-map-fit="selection"]').onclick = () => runFit('selection');
  el.querySelector('[data-map-fit="board"]').onclick = () => runFit('board');
  el.querySelector('[data-map-close]').onclick = () => setMapOpen(false, { remember: true, focus: true });
  return boardMap;
}
// The open/closed choice is remembered for desktop widths; on a phone the map
// starts closed and a choice made there is not saved.
function savedMapChoice() { try { const saved = mapKey() && localStorage.getItem(mapKey()); return saved === 'open' ? true : saved === 'closed' ? false : null; } catch { return null; } }
function setMapOpen(open, { remember = false, focus = false } = {}) {
  const map = ensureBoardMap();
  if (!map) return;
  mapWanted = !!open;
  open = open && mapAvailable();
  const hadFocus = boardMapElement().contains(document.activeElement);
  map.show(open);
  $('board-map-toggle').setAttribute('aria-pressed', String(open));
  if (remember && innerWidth > 720) try { if (mapKey()) localStorage.setItem(mapKey(), open ? 'open' : 'closed'); } catch {}
  if (!open && (focus || hadFocus)) $('board-map-toggle').focus({ preventScroll: true });
  placeSelectionBar();
}
// Large means fitting the whole board would need less than 40% zoom.
function boardIsLarge() {
  const fit = fitBoardView({ width: viewport.clientWidth, height: viewport.clientHeight }, Infinity);
  return !!fit && fit.zoom < LARGE_BOARD_ZOOM;
}
function syncMapAvailability() {
  const toggle = $('board-map-toggle');
  if (!toggle) return;
  const available = mapAvailable();
  toggle.hidden = !available;
  if (!available) { boardMap?.show(false); return; }
  if (!mapDecided) {
    mapDecided = true;
    const saved = innerWidth > 720 ? savedMapChoice() : false;
    setMapOpen(saved ?? (innerWidth > 720 && boardIsLarge()));
  } else if (mapWanted && !boardMap?.visible) setMapOpen(true);
}
// The board's content or selection changed: redraw the map once and recount.
function contentChanged() {
  readSelection();
  syncFitControls();
  boardMap?.invalidate();
}
document.addEventListener('tinka:selection', () => { readSelection(); syncFitControls(); boardMap?.invalidate(); requestAnimationFrame(placeSelectionBar); });
// The selection bar never runs into the zoom controls or the map. When its usual
// centred place would, it centres in the free space to their left: beside the
// status line if it fits, otherwise over a quiet status line (which steps aside
// while the bar shows), otherwise raised above the footer row. On a phone it spans
// the width and the open map stacks above it instead.
function placeSelectionBar() {
  const bar = $('workspace-selection'), pill = document.querySelector('.canvas-footer .zoom-pill'), root = document.documentElement;
  const footer = document.querySelector('.canvas-footer');
  if (!bar || !footer) return;
  if (!barObserved) { barObserved = true; footerObserver.observe(bar); }
  root.style.setProperty('--selection-bar-space', !bar.hidden && innerWidth <= 720 ? `${bar.offsetHeight + 14}px` : '0px');
  for (const property of ['left', 'max-width', 'bottom']) bar.style.removeProperty(property);
  footer.classList.remove('status-yields');
  if (bar.hidden || !pill || innerWidth <= 720) return;
  const meets = (a, b) => a.right > b.left - 8 && a.left < b.right + 8 && a.bottom > b.top && a.top < b.bottom;
  const b = bar.getBoundingClientRect(), p = pill.getBoundingClientRect();
  const m = boardMap?.visible ? boardMapElement().getBoundingClientRect() : null;
  if (!meets(b, p) && !(m && meets(b, m))) return;
  const statusLine = footer.querySelector('.status-line'), status = statusLine?.getBoundingClientRect();
  const right = Math.min(p.left, m ? m.left : Infinity) - 12, edge = footer.getBoundingClientRect().left + 12;
  const beside = status && status.width && status.bottom > b.top && status.top < b.bottom ? Math.max(edge, status.right + 12) : edge;
  const quiet = ['saved', 'saving', '', undefined].includes($('save-status').dataset.state) && $('live-refresh').hidden && $('live-status').dataset.connection !== 'offline';
  let from = edge;
  if (b.width <= right - beside) from = beside;
  else if (quiet && b.width <= right - edge) footer.classList.add('status-yields');
  else bar.style.bottom = `${Math.max(72, innerHeight - p.top + 12)}px`;
  bar.style.left = `${Math.round((from + right) / 2)}px`;
  bar.style.maxWidth = `${Math.max(160, Math.round(right - from))}px`;
}
let barObserved = false;
const footerObserver = new ResizeObserver(() => placeSelectionBar());
for (const element of document.querySelectorAll('.canvas-footer, .canvas-footer .zoom-pill, .canvas-footer .status-line')) footerObserver.observe(element);
addEventListener('resize', () => { placeSelectionBar(); boardMap?.resize(); });
$('board-map-toggle').onclick = () => setMapOpen(!boardMap?.visible, { remember: true });
// Dots, Grid or Plain: a per-board view preference kept in this browser.
const PATTERNS = ['dots', 'grid', 'plain'];
let canvasPattern = 'dots';
function patternKey() { return workspaceId && boardId ? `tinka/${workspaceId}/${boardId}/canvas-pattern` : null; }
function loadCanvasPattern() {
  try { const saved = patternKey() && localStorage.getItem(patternKey()); if (PATTERNS.includes(saved)) canvasPattern = saved; } catch {}
  setCanvasPattern(canvasPattern, { save: false });
}
function setCanvasPattern(pattern, { save = true } = {}) {
  if (!PATTERNS.includes(pattern)) return;
  canvasPattern = pattern;
  viewport.dataset.canvasPattern = pattern;
  document.querySelectorAll('[data-canvas-pattern]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.canvasPattern === pattern)));
  if (save) try { if (patternKey()) localStorage.setItem(patternKey(), pattern); } catch {}
  syncViewChrome();
}
// Patterns scale with the board and coarsen as it zooms out, so they never turn into noise.
function syncViewChrome() {
  const percent = Math.round(zoom * 100);
  const readout = $('zoom-menu-toggle');
  if (readout && readout.textContent !== `${percent}%`) { readout.textContent = `${percent}%`; readout.setAttribute('aria-label', `Zoom ${percent}%, zoom and background options`); }
  const canvasMode = graph?.mode !== 'grid';
  viewport.style.setProperty('--canvas-zoom', String(canvasMode ? zoom : 1));
  viewport.style.setProperty('--chrome-scale', String(canvasMode ? Math.min(2.4, 1 / zoom) : 1));
  // Tile chrome steps back on tiles too small on screen to carry it, so it never covers the drag surface.
  const bucket = !canvasMode ? '100' : zoom >= .85 ? '100' : zoom >= .6 ? '60' : zoom >= .4 ? '40' : zoom >= .25 ? '25' : '0';
  if (viewport.dataset.zoomBucket !== bucket) viewport.dataset.zoomBucket = bucket;
  let step = 22 * (canvasMode ? zoom : 1), major = 110 * (canvasMode ? zoom : 1);
  while (step < 9) { step *= 2; major *= 2; }
  viewport.style.setProperty('--pattern-step', `${step}px`);
  viewport.style.setProperty('--pattern-major', `${major}px`);
  viewport.style.setProperty('--pattern-fade', String(canvasMode ? Math.max(0, Math.min(1, (zoom - .25) / .75)) ** 1.5 : 1));
  const ox = canvasMode ? view.x + (graph?.origin?.x || 0) * zoom : 0, oy = canvasMode ? view.y + (graph?.origin?.y || 0) * zoom : 0;
  viewport.style.setProperty('--pattern-x', `${Math.round(ox)}px`);
  viewport.style.setProperty('--pattern-y', `${Math.round(oy)}px`);
  syncFitControls();
  boardMap?.syncFrame();
}
// Up: ‹ board in the header (a link, so it can also open the board in a new tab).
$('close-reader').addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  closeReader();
});
$('reader-previous').onclick = () => stepReader(-1);
$('reader-next').onclick = () => stepReader(1);
$('reader-down').onclick = () => goDown();
$('notes-toggle').onclick = () => setNotesOpen(!notesOpen);
$('notes-close').onclick = () => setNotesOpen(false);
$('reader-type').addEventListener('input', () => setType($('reader-type').value));
$('reader-navigator').onclick = () => { if (!projectNavigator) return; if (projectNavigator.isOpen) projectNavigator.hide(); else projectNavigator.open(); };
$('reader-search').onclick = () => document.dispatchEvent(new CustomEvent('tinka:navigator-open'));
$('reader-info-toggle').onclick = () => setReaderInfoOpen(readerInfo.hidden, { focus: true });
// The pill: − · % menu (zoom, window and version, light, type size, standalone) · + · Back · Fit.
$('reader-zoom-toggle').onclick = () => setReaderMenuOpen($('reader-zoom-menu').hidden);
$('reader-zoom-minus').onclick = () => readerCanvas.zoomTo(readerCanvas.view.zoom / 1.25);
$('reader-zoom-plus').onclick = () => readerCanvas.zoomTo(readerCanvas.view.zoom * 1.25);
$('reader-zoom-slider').addEventListener('input', () => readerCanvas.zoomTo(zoomFromSlider($('reader-zoom-slider').value)));
$('reader-fit').onclick = () => readerCanvas.fit();
$('reader-view-back').onclick = () => readerCanvas.back();
$('reader-zoom-menu').addEventListener('click', event => {
  const zoomChoice = event.target.closest('[data-reader-zoom]');
  const size = event.target.closest('[data-size]');
  const light = event.target.closest('[data-reader-light]');
  if (zoomChoice) {
    setReaderMenuOpen(false, { focus: true });
    if (zoomChoice.dataset.readerZoom === 'fit') readerCanvas.fit(); else readerCanvas.zoomTo(Number(zoomChoice.dataset.readerZoom));
  }
  if (size) setReaderSize(size.dataset.size);
  if (light) setTheme(light.dataset.readerLight);
});
$('reader-zoom-menu').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || document.activeElement?.type === 'range') return;
  const items = [...$('reader-zoom-menu').querySelectorAll('button:not([hidden]),input,a:not([hidden])')];
  const index = items.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});
// A version can be chosen from the % menu or the Inspector.
dialog.addEventListener('click', event => {
  const choice = event.target.closest('[data-revision-choice]');
  if (choice && active) { setReaderMenuOpen(false); openReader(active.key, choice.dataset.revisionChoice, { focus: 'keep' }); if (!readerInfo.hidden) renderReaderInfo(); }
});
dialog.addEventListener('cancel', event => { event.preventDefault(); });
// A native close (not through closeReader) still returns to the board. The close event arrives
// asynchronously, so ignore it if the reader has been reopened in the meantime.
dialog.addEventListener('close', () => { if (active && !dialog.open) closeReader(); });
$('active-reader').addEventListener('load', () => {
  if (!dialog.open) return;
  forwardFrame($('active-reader'));
  // Key events inside a frame do not reach the surrounding dialog.
  try {
    $('active-reader').contentWindow.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && event.keyCode!==229 && !event.repeat) { if(handleEscape(event))event.preventDefault(); }
    });
  } catch {} // Independent cross-origin previews own their keyboard handling.
});
const readerActions=new Set();
function readerContext(data,itemId){
  const frame=$('active-reader'),source=frame.contentWindow;
  const selectionId=typeof data.selectionId==='string'&&data.selectionId.length<=80?data.selectionId:undefined;
  const options={host:dialog.querySelector('.reader-area'),mode:'reader',selectionId,returnFocus:()=>{
    if(dialog.open&&active?.graphItem?.id===itemId&&activeVariantId==='original'&&frame.contentWindow===source)
      source.postMessage({type:'tinka-reader-focus',selectionId},location.origin);
  }};
  const r=data.selectionRect;
  if(r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).length===4&&['top','bottom','left','right'].every(key=>Number.isFinite(r[key])&&Math.abs(r[key])<=100000)&&r.bottom>=r.top&&r.right>=r.left){
    const box=frame.getBoundingClientRect();options.selectionRect={top:Math.max(box.top,Math.min(box.bottom,box.top+r.top)),bottom:Math.max(box.top,Math.min(box.bottom,box.top+r.bottom)),left:Math.max(box.left,Math.min(box.right,box.left+r.left)),right:Math.max(box.left,Math.min(box.right,box.left+r.right))};
  }
  return options;
}
function refreshReaderAnnotations(detail={}){
  if(dialog.open&&activeVariantId==='original'&&active?.graphItem?.id===detail.itemId)
    $('active-reader').contentWindow?.postMessage({type:'tinka-annotations-refresh'},location.origin);
}
function wireReaderReview(){
  if(graph?.feedback&&!graph.feedback.canvasReviewBound){graph.feedback.canvasReviewBound=true;graph.feedback.onCommitted=refreshReaderAnnotations;}
}
window.addEventListener('message', event => {
  if(event.origin!==location.origin||event.source!==$('active-reader').contentWindow)return;
  if(event.data?.type==='reader-close'){handleEscape();return;}
  const item=active?.graphItem,data=event.data;
  if(!dialog.open||!graph||!item||activeVariantId!=='original'||data?.itemId!==item.id||item.content?.kind!=='markdown'||!item.content.resource||item.content.url)return;
  wireReaderReview();const options=readerContext(data,item.id);
  if(data.type==='tinka-selection-context'){graph.feedback.updateReaderContext({selectionId:options.selectionId,selectionRect:options.selectionRect});return;}
  if(data.type==='tinka-comment-selection'&&validTextAnchor(data.anchor)&&/^sha256:[a-f0-9]{64}$/.test(data.anchor.sourceRevision||'')){
    graph.feedback.commentOnText(item.id,data.anchor,options);
  }else if(data.type==='tinka-open-comment'&&typeof data.threadId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(data.threadId)){
    graph.feedback.open({...options,itemId:item.id,threadId:data.threadId});
  }else if((data.type==='tinka-highlight-selection'&&validTextAnchor(data.anchor)&&/^sha256:[a-f0-9]{64}$/.test(data.anchor.sourceRevision||''))||(data.type==='tinka-remove-highlight'&&typeof data.highlightId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(data.highlightId))){
    const frame=event.source,key=JSON.stringify([item.id,data.type,data.selectionId||data.highlightId||data.anchor]);if(readerActions.has(key))return;readerActions.add(key);
    const result=(ok,error)=>{if(dialog.open&&active?.graphItem?.id===item.id&&$('active-reader').contentWindow===frame)frame.postMessage({type:'tinka-annotation-result',selectionId:data.selectionId,ok,...(error?{message:error.message}: {})},location.origin);};
    const action=data.type==='tinka-highlight-selection'?graph.feedback.highlightOnText(item.id,data.anchor):graph.feedback.removeHighlight(item.id,data.highlightId);
    Promise.resolve(action).then(()=>result(true),error=>result(false,error)).finally(()=>readerActions.delete(key));
  }
});
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ board: boardId, title: board?.title || 'Board', exportedAt: new Date().toISOString(), notes }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${boardId}-notes.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

// Legacy canvas: background drag pans. Graph Canvas uses ordinary scrolling; both keep two-finger pinch zoom.
const pointers = new Map();
let pan = null;
let pinch = null;
viewport.addEventListener('pointerdown', event => {
  if (graph?.mode === 'grid') return;
  if (graph && (event.pointerType !== 'touch' || (event.target.closest('button') && !event.target.closest('.workspace-preview-launch')))) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (event.target.closest('textarea,input,select,a,button')) return;
  stopGlide();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, canPan: !graph || !event.target.closest('.workspace-card') });
  if (pointers.size === 1) {
    pan = graph && event.target.closest('.workspace-card') ? null : { id: event.pointerId, x: event.clientX, y: event.clientY, left: view.x, top: view.y, active: false };
    pinch = null;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const [mx, my] = viewportPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom, x: (mx - view.x) / zoom, y: (my - view.y) / zoom };
    pan = null;
    viewport.classList.add('panning');
  }
});
viewport.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { ...pointers.get(event.pointerId), x: event.clientX, y: event.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const [mx, my] = viewportPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    zoom = clampZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinch.distance);
    moveView(mx - pinch.x * zoom, my - pinch.y * zoom);
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
  if (pan.active) moveView(pan.left + dx, pan.top + dy);
});
function endPointer(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    const [id, point] = [...pointers.entries()][0];
    pan = graph && !point.canPan ? null : { id, x: point.x, y: point.y, left: view.x, top: view.y, active: true };
  } else if (!pointers.size) { pan = null; viewport.classList.remove('panning'); }
  void drainLiveUpdates().catch(()=>{});
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
// A note field with more to scroll keeps its own wheel scrolling.
function scrollsItself(target, dy) {
  const field = target.closest?.('textarea,.workspace-card-copy');
  if (!field || !dy) return false;
  return dy > 0 ? field.scrollTop + field.clientHeight < field.scrollHeight - 1 : field.scrollTop > 0;
}
// Control/⌘-scroll (and trackpad pinch) zooms about the pointer; any other scroll pans.
viewport.addEventListener('wheel', event => {
  if (graph?.mode === 'grid') return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    changeZoom(zoom * wheelZoomFactor(event), ...viewportPoint(event.clientX, event.clientY));
    return;
  }
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  let dx = event.deltaX * unit;
  let dy = event.deltaY * unit;
  if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
  if (scrollsItself(event.target, dy)) return;
  event.preventDefault();
  moveView(view.x - dx, view.y - dy);
}, { passive: false });
// Safari reports a trackpad pinch as gesture events with a running scale. Apply each
// change as a ratio, so a pinch that reaches a zoom limit reverses at once.
let gestureScale = 1;
viewport.addEventListener('gesturestart', event => { event.preventDefault(); gestureScale = 1; });
viewport.addEventListener('gesturechange', event => {
  event.preventDefault();
  const scale = event.scale > 0 ? event.scale : 1;
  changeZoom(zoom * scale / gestureScale, ...viewportPoint(event.clientX, event.clientY));
  gestureScale = scale;
});
viewport.addEventListener('gestureend', event => event.preventDefault());
// A pinch over the board's floating chrome (header, panels, zoom pill) zooms the
// board too, rather than magnifying the whole page. The reader and open dialogs
// keep the browser's own zoom.
function boardOwnsPinch(event) {
  if (graph?.mode === 'grid' || viewport.contains(event.target)) return false;
  return !document.querySelector('dialog[open]');
}
function viewportPinchPoint(event) {
  const r = viewport.getBoundingClientRect();
  return viewportPoint(Math.max(r.left, Math.min(r.right, event.clientX)), Math.max(r.top, Math.min(r.bottom, event.clientY)));
}
document.addEventListener('wheel', event => {
  // Over an opened Tinka's header, panels or pill, ⌘/Ctrl-scroll zooms its canvas, never the page.
  if ((event.ctrlKey || event.metaKey) && dialog.open && !readerStage.contains(event.target) && !document.querySelector('dialog.workspace-dialog[open]')) {
    event.preventDefault(); readerCanvas.zoomAtClient(wheelZoomFactor(event), event.clientX, event.clientY); return;
  }
  if (!(event.ctrlKey || event.metaKey) || !boardOwnsPinch(event)) return;
  event.preventDefault();
  changeZoom(zoom * wheelZoomFactor(event), ...viewportPinchPoint(event));
}, { passive: false });
const readerOwnsPinch = event => dialog.open && !readerStage.contains(event.target) && !document.querySelector('dialog.workspace-dialog[open]');
document.addEventListener('gesturestart', event => { if (boardOwnsPinch(event) || readerOwnsPinch(event)) { event.preventDefault(); gestureScale = 1; } });
document.addEventListener('gesturechange', event => {
  if (readerOwnsPinch(event)) { event.preventDefault(); const scale = event.scale > 0 ? event.scale : 1; readerCanvas.zoomAtClient(scale / gestureScale, event.clientX, event.clientY); gestureScale = scale; return; }
  if (!boardOwnsPinch(event)) return;
  event.preventDefault();
  const scale = event.scale > 0 ? event.scale : 1;
  changeZoom(zoom * scale / gestureScale, ...viewportPinchPoint(event));
  gestureScale = scale;
});
// Keys pan as scrolling did: arrows, Page Up/Down and Space (on the canvas itself), Home and End for the first and
// last explorations. + and − zoom about the centre.
viewport.addEventListener('keydown', event => {
  if (graph?.mode === 'grid') return;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('textarea,input,select,[contenteditable]')) return;
  const onCanvas = event.target === viewport;
  const page = viewport.clientHeight * .875;
  const key = event.key === ' ' && onCanvas ? (event.shiftKey ? 'PageUp' : 'PageDown') : event.key;
  const step = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80], PageUp: [0, page], PageDown: [0, -page] }[key];
  if (event.shiftKey && (event.code === 'Digit0' || key === ')' || key === '0')) { changeZoom(1); event.preventDefault(); return; }
  if (onCanvas && (key === '+' || key === '=')) changeZoom(zoom * 1.15);
  else if (onCanvas && (key === '-' || key === '_')) changeZoom(zoom / 1.15);
  else if (key.startsWith('Arrow') && step) moveView(view.x + step[0], view.y + step[1]);
  else if (step) { const from = glideTarget || view; glideTo({ x: from.x + step[0], y: from.y + step[1] }, { track: true }); }
  else if ((key === 'Home' || key === 'End') && rounds.length) { currentRound = key === 'Home' ? 0 : rounds.length - 1; renderNav(); glideTo(restingView()); }
  else return;
  event.preventDefault();
});
new ResizeObserver(() => {
  // Dragging the window's corner makes a custom size; the view stays where it is.
  if ($('reader-window').style.width && readerView.size !== 'custom') { readerView.size = 'custom'; readerCanvas.fitted = false; }
  if (dialog.open) renderSizeControls();
}).observe($('reader-window'));
new ResizeObserver(() => { if (overview) { if (board) void settleOverview(); return; } if(graph?.revealedPlacement&&!dialog.open)graph.recenterRevealed();else if (resting) rest(); else applyView(); }).observe(viewport);
// A found target follows responsive canvas changes until the user resumes navigation.
for(const type of ['pointerdown','wheel','keydown'])viewport.addEventListener(type,()=>{if(graph)graph.revealedPlacement=null;},{capture:true,passive:true});
// The stage follows window, notes and comment panel changes; a fitted Tinka stays fitted.
new ResizeObserver(() => { if (dialog.open) readerCanvas.resize(); }).observe(readerStage);
// The hosted Navigator and the path sit just below the reader's header, however tall it wraps.
new ResizeObserver(() => dialog.style.setProperty('--reader-header-h', `${$('reader-header').offsetHeight}px`)).observe($('reader-header'));
// The browser scrolls the canvas to reveal keyboard focus or a find-in-page match; carry that over as a pan.
// A press on a card control never moves the board.
viewport.style.setProperty('--cushion', `${CUSHION}px`);
settleCushion();
viewport.addEventListener('scroll', () => {
  if (graph?.mode === 'grid') return;
  const dx = viewport.scrollLeft - CUSHION;
  const dy = viewport.scrollTop - CUSHION;
  if (!dx && !dy) return;
  settleCushion();
  if (!pointers.size) moveView(view.x - dx, view.y - dy);
}, { passive: true });
window.addEventListener('popstate', route);
// Clicking into the experiment frame never reaches this document; close the popover when focus leaves it.
window.addEventListener('blur', () => { setReaderMenuOpen(false); readerCanvas.setSpacePan(false); });
addEventListener('resize', () => readerPath.close({ focus: false }));
window.addEventListener('hashchange', route);
$('live-refresh').onclick = reloadCanvas;
$('reader-update').onclick = () => loadRevision({ focus: true });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// The interactive board: route the hash, restore the view, follow live changes.
async function openBoardView() {
  const requested = parseHash();
  if (requested.view === 'experiment') {
    const concept = all.find(item => item.key === requested.key) || graph?.ownerConcept(requested.key) || graph?.aliasConcept(requested.key);
    currentRound = concept?.row || 0;
    renderNav();
    jump(concept.key);
    openReader(requested.key, requested.revision || 'original', { history: 'replace' });
  } else {
    if (requested.invalid) commitHistory({ view: 'board', round: null }, 'replace');
    const index = rounds.findIndex(round => round.id === requested.round);
    if (index >= 0) currentRound = index;
    renderNav();
    rest();
  }
  routedHash = location.hash;
  try {
    const saved = JSON.parse(sessionStorage.getItem(viewKey) || 'null');
    sessionStorage.removeItem(viewKey);
    if (saved && Number.isFinite(saved.zoom)) {
      zoom = clampZoom(saved.zoom);
      currentRound = Math.max(0, rounds.findIndex(round => round.id === saved.round));
      renderNav();
      // A view saved by an earlier version (scroll offsets) falls back to the round's resting place.
      if (saved.resting || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) rest();
      else { resting = false; Object.assign(view, { x: saved.x, y: saved.y }); applyView(); }
    }
  } catch {}
  syncMapAvailability();
  const revealId=new URLSearchParams(location.search).get('reveal');
  if(revealId&&graph)await graph.revealPlacement(revealId);
  if (!dialog.open && document.activeElement === document.body) viewport.focus({ preventScroll: true });
  $('live-status').classList.add('live-indicator');
  watchBoard(boardId, {
    config:appConfig,
    onSnapshot: applyBoardSnapshot,
    onManifestChange: refreshManifest,
    onShellChange: scheduleShellReload,
    onConnection: connected => { const label = $('live-status'); label.dataset.connection = connected ? 'live' : 'offline'; if (!connected) label.textContent = 'Reconnecting to this Mac…'; else if (liveSnapshot && label.textContent.startsWith('Reconnecting')) applyBoardSnapshot(liveSnapshot); },
  });
}

if (!boardId) showError('This board address is invalid. Return to Boards and open a board from there.');
else {
  try {
    await loadAppTitle();
    board = await fetchBoard();
    rounds = board.rounds;
    revisions = board.revisions || {};
    readRound();
    if (graph) { graph.mount(); if(graph.mode==='grid'){viewport.scrollLeft=0;viewport.scrollTop=0;}else settleCushion(); }
    else { const b=document.createElement('button');b.type='button';b.textContent='Enable organization…';b.onclick=()=>enableOrganization(appConfig);document.querySelector('.info-actions').append(b); }
    currentRound = Math.max(0, rounds.length - 1);
    buildCanvas();
    await ensureNotesReady();
    setTheme(readerView.theme, false);
    setType(readerView.type, false);
    if (overview) {
      // Legacy cards take their build badges from the live state; read it once.
      if (!graph) { const live = await fetch(`${boardApi}/live`, { cache: 'no-store' }); if (live.ok) await applyBoardSnapshot(await live.json()); }
      await settleOverview();
    }
    else await openBoardView();
  } catch (error) { showError(error.message || 'This board could not be loaded.'); if (overview) document.documentElement.dataset.overview = 'error'; }
}
