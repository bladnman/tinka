import {pdfSupported,pdfPreviewURL} from './file-import.js';
import {escape as esc,resourceURL,remoteURL} from './workspace.js';

export function coverMarkup(cover, boardId) {
  if (!cover?.tiles.length) return '<span class="workspace-paper-art" aria-hidden="true">▱ ▱</span>';
  return `<div class="board-collage" data-cover-board="${esc(boardId)}" data-cover-count="${cover.tiles.length}" aria-hidden="true">${cover.tiles.map(tile => {
    const source = JSON.stringify([tile.itemId,tile.kind,tile.resource,tile.url,tile.revision]);
    const src = tile.kind === 'pdf' ? pdfPreviewURL(resourceURL(tile.resource),tile.revision) : tile.kind === 'html' ? `/api/items/${encodeURIComponent(tile.itemId)}/cover-thumbnail?v=${encodeURIComponent(tile.revision)}` : resourceURL(tile.resource) || remoteURL(tile.url);
    return `<div class="workspace-cover-tile" data-cover-tile="${esc(tile.id)}" data-cover-item="${esc(tile.itemId)}" data-preview-width="${tile.viewport.width}" data-preview-height="${tile.viewport.height}"><span class="workspace-cover-fallback"><span>${tile.board ? '▱' : '◇'}</span><strong>${esc(tile.title)}</strong>${tile.kind === 'pdf' ? '<small>PDF · Open to read all pages</small>' : tile.kind === 'text' && tile.text !== tile.title ? `<small>${esc(tile.text.slice(0,180))}</small>` : ''}</span>${tile.kind === 'pdf' && pdfSupported() ? `<iframe class="workspace-cover-pdf" src="${esc(src)}" data-preview-source="${esc(source)}" title="${esc(tile.title)} first page" width="${tile.viewport.width}" height="${tile.viewport.height}" style="width:${tile.viewport.width}px;height:${tile.viewport.height}px" loading="lazy" tabindex="-1" inert></iframe>` : tile.kind === 'html' ? `<iframe src="${esc(src)}" data-preview-source="${esc(source)}" title="${esc(tile.title)} thumbnail" width="${tile.viewport.width}" height="${tile.viewport.height}" style="width:${tile.viewport.width}px;height:${tile.viewport.height}px" sandbox="allow-scripts" loading="lazy" tabindex="-1" inert></iframe>` : tile.kind === 'image' ? `<img src="${esc(tile.resource ? src + "?v=" + encodeURIComponent(tile.revision) : src)}" referrerpolicy="no-referrer" data-preview-source="${esc(source)}" alt="" loading="lazy">` : ''}</div>`;
  }).join('')}<span class="workspace-cover-count">${cover.count > 4 ? `+${cover.count - 4} more` : `${cover.count} ${cover.count === 1 ? 'item' : 'items'}`}</span></div>`;
}

export function observeCovers(host, previous) {
  previous?.disconnect();
  const size = tile => {
    const scale = Math.min(tile.clientWidth / Number(tile.dataset.previewWidth),tile.clientHeight / Number(tile.dataset.previewHeight));
    tile.style.setProperty('--cover-scale',String(scale));
  };
  const observer = new ResizeObserver(entries => entries.forEach(({target}) => size(target)));
  host.querySelectorAll('[data-cover-tile]').forEach(tile => { size(tile); observer.observe(tile); });
  if (!host.coverErrorsBound) {
    host.addEventListener('error', e => {
      if (e.target.matches?.('.workspace-cover-tile img')) e.target.hidden = true;
    },true);
    host.coverErrorsBound = true;
  }
  return observer;
}
