import {pdfSupported,pdfPreviewURL} from './file-import.js';
import {escape as esc,resourceURL,remoteURL} from './workspace.js';

const frameAvailability = new WeakMap();
// Cover thumbnails run in an opaque-origin sandbox, so their load event cannot
// tell a rendered design from a blocked or failed one. The server adds a fixed
// ready signal; until it arrives a frame stays invisible above its typed
// placeholder, and a blocked, failed or slow frame simply never appears.
if (typeof window !== 'undefined' && !window.tinkaCoverReadyBound) {
  window.tinkaCoverReadyBound = true;
  addEventListener('message', event => {
    if (!event.data || typeof event.data.tinkaCoverReady !== 'string') return;
    for (const frame of document.querySelectorAll('.workspace-cover-tile iframe')) {
      if (frame.contentWindow !== event.source) continue;
      frame.setAttribute('data-cover-ready', '');
      frame.removeAttribute('data-cover-pending');
    }
  });
}

function checkFrame(frame) {
  const source = frame.src;
  let state = frameAvailability.get(frame);
  if (state?.source === source) {
    if (state.available === false) frame.hidden = true;
    return;
  }
  state = {source};
  frameAvailability.set(frame,state);
  // A sandboxed iframe's load event also fires for HTTP errors. Check the local
  // response separately, without reading another document body or weakening the
  // opaque-origin sandbox. Retained frames reuse this result on reconciliation.
  fetch(source,{signal:AbortSignal.timeout(5000)}).then(response => {
    response.body?.cancel().catch(() => {});
    return response.ok;
  }).catch(() => false).then(available => {
    if (frameAvailability.get(frame) !== state) return;
    state.available = state.failed ? false : available;
    frame.hidden = !state.available;
  });
}

// Small type glyphs shared by the collage and the miniature (stroke icons, 16px grid).
const ICONS = {
  html:'<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M2.5 7h15"/>',
  image:'<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="m4.5 14 4-4 3 3 2-2 2.5 3"/><circle cx="13" cy="7.5" r="1.2"/>',
  doc:'<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M8 9.5h5M8 12.5h5"/>',
  pdf:'<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M7.5 13h5"/>',
  video:'<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="m8.5 7.5 4 2.5-4 2.5z"/>',
  board:'<rect x="3" y="3" width="14" height="10.5" rx="1.8"/><path d="M5 16h10M6.5 18h7"/>',
  idea:'<path d="m10 3 6 7-6 7-6-7z"/>',
};
const iconFor = type => ICONS[{html:'html',image:'image',markdown:'doc',text:'doc',note:'doc',file:'doc',url:'html',pdf:'pdf',video:'video',audio:'video',board:'board'}[type] || 'idea'];
export const coverIcon = type => `<svg class="workspace-cover-icon" viewBox="0 0 20 20" aria-hidden="true">${iconFor(type)}</svg>`;
// Live miniature frames are capped per page; the rest keep their typed placeholder.
const MINI_FRAME_CAP = 12;
const frameURL = (itemId, revision) => `/frames/items/${encodeURIComponent(itemId)}/cover.html?v=${encodeURIComponent(revision || '')}`;

// A miniature is used only when its tiles stay legible at a typical window size.
export function miniatureFits(layout) {
  if (!layout?.tiles?.length || layout.tiles.length > 40 || !(layout.width > 0) || !(layout.height > 0)) return false;
  const scale = Math.min(340 / layout.width, 170 / layout.height);
  const sizes = layout.tiles.map(t => Math.min(t.width, t.height * 1.6) * scale).sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)] >= 34;
}

// Authored paper keeps readable ink in the miniature, in either appearance.
function paperTone(paper) {
  let hex = String(paper || '').replace('#', '');
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return '';
  if (hex.length < 5) hex = [...hex].map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b > .3 ? ' mini-paper-light' : ' mini-paper-dark';
}
function miniatureMarkup(cover, boardId) {
  const {width:W, height:H, regions = [], tiles = []} = cover.layout;
  const pct = (v, total) => `${Math.round(v / total * 10000) / 100}%`;
  const box = r => `left:${pct(r.x, W)};top:${pct(r.y, H)};width:${pct(r.width, W)};height:${pct(r.height, H)};`;
  const regionMarkup = regions.map(r => `<span class="mini-region${r.shape && r.shape !== 'rectangle' ? ' mini-region-' + esc(r.shape) : ''}" style="${box(r)}${r.color ? `--mini-region:${esc(r.color)};` : ''}">${r.text ? `<span>${esc(r.text)}</span>` : ''}</span>`).join('');
  // DOM order follows review order (so reordering moves tiles, keeping frames); z sets stacking.
  const rank = new Map([...tiles].sort((a, b) => (a.z || 0) - (b.z || 0)).map((t, i) => [t.id, i + 1]));
  const tileMarkup = tiles.map(t => {
    const preview = t.preview, source = JSON.stringify([t.itemId, preview?.kind, preview?.resource, preview?.url, preview?.revision]);
    const media = preview?.kind === 'image'
      ? `<img src="${esc(preview.resource ? `${resourceURL(preview.resource)}?v=${encodeURIComponent(preview.revision || '')}` : remoteURL(preview.url))}" referrerpolicy="no-referrer" data-preview-source="${esc(source)}" alt="" loading="lazy">`
      : preview?.kind === 'html'
      ? `<iframe data-mini-src="${esc(frameURL(t.itemId, preview.revision))}" data-preview-source="${esc(source)}" data-cover-pending title="${esc(t.title)} thumbnail" width="${preview.viewport.width}" height="${preview.viewport.height}" style="width:${preview.viewport.width}px;height:${preview.viewport.height}px" sandbox="allow-scripts" loading="lazy" tabindex="-1" inert></iframe>` : '';
    return `<div class="workspace-cover-tile mini-tile mini-${esc(t.mode)}${t.board ? ' mini-board' : ''}${t.state ? ' mini-pending' : ''}${t.paper ? paperTone(t.paper) : ''}" data-cover-tile="${esc(t.id)}" data-cover-item="${esc(t.itemId)}" style="${box(t)}z-index:${rank.get(t.id)};${t.paper ? `--mini-paper:${esc(t.paper)};` : ''}"${preview?.kind === 'html' ? ` data-preview-width="${preview.viewport.width}" data-preview-height="${preview.viewport.height}"` : ''}><span class="workspace-cover-fallback mini-label">${coverIcon(t.type)}<strong>${esc(t.title)}</strong></span>${t.star ? '<span class="mini-star" aria-hidden="true"></span>' : ''}${media}</div>`;
  }).join('');
  return `<div class="board-collage board-miniature" data-cover-board="${esc(boardId)}" data-cover-count="${tiles.length}" aria-hidden="true" style="--mini-ratio:${W / H};"><div class="mini-plane">${regionMarkup}${tileMarkup}</div><span class="workspace-cover-count">${cover.count} ${cover.count === 1 ? 'item' : 'items'}</span></div>`;
}

export function coverMarkup(cover, boardId) {
  if (!cover?.tiles.length) return '<span class="workspace-paper-art" aria-hidden="true">▱ ▱</span>';
  if (miniatureFits(cover.layout)) return miniatureMarkup(cover, boardId);
  return `<div class="board-collage" data-cover-board="${esc(boardId)}" data-cover-count="${cover.tiles.length}" aria-hidden="true">${cover.tiles.map(tile => {
    const source = JSON.stringify([tile.itemId,tile.kind,tile.resource,tile.url,tile.revision]);
    const src = tile.kind === 'pdf' ? pdfPreviewURL(resourceURL(tile.resource),tile.revision) : tile.kind === 'html' ? frameURL(tile.itemId, tile.revision) : resourceURL(tile.resource) || remoteURL(tile.url);
    return `<div class="workspace-cover-tile" data-cover-tile="${esc(tile.id)}" data-cover-item="${esc(tile.itemId)}" data-preview-width="${tile.viewport.width}" data-preview-height="${tile.viewport.height}"><span class="workspace-cover-fallback">${coverIcon(tile.board ? 'board' : tile.sourceKind || tile.kind)}<strong>${esc(tile.title)}</strong>${tile.kind === 'pdf' ? '<small>PDF · Open to read all pages</small>' : tile.kind === 'text' && tile.text !== tile.title ? `<small>${esc(tile.text.slice(0,180))}</small>` : ''}</span>${tile.kind === 'pdf' && pdfSupported() ? `<iframe class="workspace-cover-pdf" src="${esc(src)}" data-preview-source="${esc(source)}" title="${esc(tile.title)} first page" width="${tile.viewport.width}" height="${tile.viewport.height}" style="width:${tile.viewport.width}px;height:${tile.viewport.height}px" loading="lazy" tabindex="-1" inert></iframe>` : tile.kind === 'html' ? `<iframe src="${esc(src)}" data-preview-source="${esc(source)}" data-cover-pending title="${esc(tile.title)} thumbnail" width="${tile.viewport.width}" height="${tile.viewport.height}" style="width:${tile.viewport.width}px;height:${tile.viewport.height}px" sandbox="allow-scripts" loading="lazy" tabindex="-1" inert></iframe>` : tile.kind === 'image' ? `<img src="${esc(tile.resource ? src + "?v=" + encodeURIComponent(tile.revision) : src)}" referrerpolicy="no-referrer" data-preview-source="${esc(source)}" alt="" loading="lazy">` : ''}</div>`;
  }).join('')}<span class="workspace-cover-count">${cover.count > 4 ? `+${cover.count - 4} more` : `${cover.count} ${cover.count === 1 ? 'item' : 'items'}`}</span></div>`;
}

export function observeCovers(host, previous) {
  previous?.disconnect();
  const size = tile => {
    // client sizes round to whole pixels; keep a pixel in hand so a design never overflows its cell.
    const scale = Math.max(0, Math.min((tile.clientWidth - 1) / Number(tile.dataset.previewWidth),(tile.clientHeight - 1) / Number(tile.dataset.previewHeight)));
    tile.style.setProperty('--cover-scale',String(scale));
  };
  const observer = new ResizeObserver(entries => entries.forEach(({target}) => size(target)));
  // Activate at most MINI_FRAME_CAP live miniature frames on the page, in order.
  let live = document.querySelectorAll('.board-miniature iframe[src]').length;
  for (const frame of host.querySelectorAll('.board-miniature iframe[data-mini-src]')) {
    if (frame.getAttribute('src') === frame.dataset.miniSrc) continue;
    if (live >= MINI_FRAME_CAP) { frame.remove(); continue; }
    frame.setAttribute('src', frame.dataset.miniSrc); live++;
  }

  host.querySelectorAll('[data-cover-tile]').forEach(tile => {
    size(tile); observer.observe(tile);
    // Reconciliation can retain an already failed image without another error.
    const image = tile.querySelector('img');
    if (image?.complete && !image.naturalWidth) image.hidden = true;
    const frame = tile.querySelector('iframe');
    if (frame) checkFrame(frame);
  });
  if (!host.coverErrorsBound) {
    host.addEventListener('error', e => {
      if (e.target.matches?.('.workspace-cover-tile img, .workspace-cover-tile iframe')) {
        e.target.hidden = true;
        const state = frameAvailability.get(e.target);
        if (state) { state.failed = true; state.available = false; }
      }
    },true);
    host.coverErrorsBound = true;
  }
  return observer;
}
