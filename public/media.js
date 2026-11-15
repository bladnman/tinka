import {mountMarkdownReader} from './markdown-reader.js';
import {documentTextMap,locateTextAnchor,MARKDOWN_TEXT_MODEL} from './markdown-document.js';
const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const kind = query.get('kind') || 'html';
const boardId = query.get('board') || '';
const path = query.get('path') || '';
const remote = query.get('url') || '';
const resourceRoot = query.get('root') || '';
const name = query.get('name') || 'Experiment';
const content = $('media-content');
const openOriginal = $('open-original');

function showError(message) {
  const section = document.createElement('section');
  section.className = 'media-message';
  const heading = document.createElement('h1');
  heading.textContent = 'Preview unavailable';
  const text = document.createElement('p');
  text.textContent = message;
  section.append(heading, text);
  content.replaceChildren(section);
}

function sourceUrl() {
  if (remote) {
    try {
      const url = new URL(remote);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  if (!(resourceRoot ? /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(resourceRoot) : /^[a-z0-9][a-z0-9-]*$/.test(boardId))) return null;
  const parts = path.split('/');
  if (!parts.length || parts.some(part => !part || part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return null;
  return resourceRoot ? `/resources/${encodeURIComponent(resourceRoot)}/${parts.map(encodeURIComponent).join('/')}` : `/boards/${encodeURIComponent(boardId)}/files/${parts.map(encodeURIComponent).join('/')}`;
}

function applyPreferences(theme, scale) {
  if (theme === 'paper' || theme === 'night') document.documentElement.dataset.theme = theme;
  if ([100, 115, 130].includes(Number(scale))) document.documentElement.style.setProperty('--scale', String(Number(scale) / 100));
}



applyPreferences(query.get('theme'), query.get('scale'));

// Document cards and panels on a board show the document as a paper page (the reader's paper
// look) that fills the tile, with the reader's saved highlights and comment marks painted on it.
const documentTile = kind === 'markdown' && ['card', 'panel'].includes(query.get('mode'));
const tileItem = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(query.get('item') || '') ? query.get('item') : '';
// Hide a first heading that only repeats the tile's title; mark overflow so long documents fade out.
function fitDocumentTile() {
  // While the page is edited in place it scrolls instead of fading and shows every heading; the
  // editor paints the marks then, and the refit after editing repaints them here.
  if (document.documentElement.hasAttribute('data-document-editing')) { document.documentElement.removeAttribute('data-document-overflow'); marks.article = null; return; }
  const article = content.querySelector('.markdown');
  if (!article) return;
  const plain = text => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').replace(/[.:!?\s]+$/, '').trim().toLowerCase();
  const first = article.firstElementChild;
  for (const heading of article.querySelectorAll(':scope > h1[data-duplicate-title]')) if (heading !== first) delete heading.dataset.duplicateTitle;
  if (first?.tagName === 'H1') { if (plain(first.textContent) && plain(first.textContent) === plain(name)) first.dataset.duplicateTitle = ''; else delete first.dataset.duplicateTitle; }
  document.documentElement.toggleAttribute('data-document-overflow', content.scrollHeight > content.clientHeight + 2);
  if (article !== marks.article) { marks.article = article; loadMarks(); } else paintMarks();
}
// Read-only marks: the same saved highlights and text-anchored comments the reader paints,
// located in this rendered text the way the reader locates them.
const marks = { article: null, highlights: [], comments: [], request: 0 };
async function loadMarks() {
  if (!tileItem || !globalThis.CSS?.highlights || !globalThis.Highlight) return;
  const current = ++marks.request;
  try {
    const params = new URLSearchParams({ itemId: tileItem, limit: '100' });
    const [threads, saved] = await Promise.all([fetch('/api/feedback?' + params, { cache: 'no-store' }), fetch('/api/highlights?' + params, { cache: 'no-store' })]);
    if (!threads.ok || !saved.ok) return;
    const result = await threads.json(), page = await saved.json(), highlights = [...(page.highlights || [])];
    let cursor = page.nextCursor;
    while (cursor && highlights.length < 200) { const next = await fetch('/api/highlights?' + new URLSearchParams({ itemId: tileItem, limit: '100', cursor }), { cache: 'no-store' }); if (!next.ok) break; const more = await next.json(); highlights.push(...(more.highlights || [])); cursor = more.nextCursor; }
    if (current !== marks.request) return;
    marks.highlights = highlights; marks.comments = (result.threads || []).filter(thread => thread.anchor?.kind === 'text');
    paintMarks();
  } catch {}
}
function paintMarks() {
  if (!globalThis.CSS?.highlights || !globalThis.Highlight || document.documentElement.hasAttribute('data-document-editing')) return;
  const article = marks.article?.isConnected ? marks.article : null, ranges = { comment: [], highlight: [] };
  if (article) {
    const raw = article.textContent, map = documentTextMap(raw), nodes = [], walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let offset = 0;
    while (walker.nextNode()) { const node = walker.currentNode; nodes.push({ node, start: offset, end: offset + node.length }); offset += node.length; }
    const toRange = (start, end) => {
      const from = map.starts[start], to = map.ends[end - 1];
      if (from === undefined || to === undefined) return null;
      const range = document.createRange(); let begun = false;
      for (const entry of nodes) {
        if (!begun && from >= entry.start && from < entry.end) { range.setStart(entry.node, from - entry.start); begun = true; }
        if (begun && to <= entry.end) { range.setEnd(entry.node, to - entry.start); return range; }
      }
      return null;
    };
    for (const [kind, records] of [['comment', marks.comments], ['highlight', marks.highlights]]) for (const record of records) {
      const anchor = record.currentAnchor || record.anchor; // computed position after an outside edit
      if (anchor?.kind !== 'text' || record.anchorStatus !== 'matched') continue;
      const located = locateTextAnchor(map.text, anchor, anchor.sourceRevision, MARKDOWN_TEXT_MODEL);
      const range = located.status === 'matched' && toRange(located.start, located.end);
      if (range) ranges[kind].push(range);
    }
  }
  CSS.highlights.set('tinka-document-comments', new Highlight(...ranges.comment));
  CSS.highlights.set('tinka-document-highlights', new Highlight(...ranges.highlight));
}
if (documentTile) {
  let queued = false;
  const refit = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fitDocumentTile(); }); };
  new MutationObserver(refit).observe(content, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(refit).observe(content);
  window.addEventListener('load', refit);
  // The board posts a refresh after a highlight or comment commits; returning to the board
  // (from another window or the CLI) also rechecks, so the card follows the opened document.
  window.addEventListener('message', event => { if (event.origin === location.origin && event.source === parent && ['tinka-annotations-refresh', 'tinka-feedback-refresh'].includes(event.data?.type)) loadMarks(); });
  try { if (parent !== window) parent.addEventListener('focus', () => loadMarks()); } catch {}
}
// Inside Tinka's experiment view the surrounding header already names the item and links to it.
if (query.get('chrome') === 'none' && parent !== window) $('media-header').hidden = true;
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'reader-preferences') applyPreferences(event.data.theme, event.data.scale);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && event.keyCode!==229 && !event.repeat && parent !== window) { event.preventDefault(); parent.postMessage({ type: 'reader-close' }, location.origin); }
});

const asset = sourceUrl();
$('media-label').textContent = `${name} · ${kind === 'html' ? 'Independent preview' : kind.toUpperCase()}`;
document.title = `${name} · Tinka`;
if (!asset) showError('The preview source is missing or invalid.');
else {
  openOriginal.href = asset;
  openOriginal.hidden = false;
  if (kind === 'image') {
    const stage = document.createElement('div'); stage.className = 'image-stage';
    const img = document.createElement('img'); img.src = asset; img.alt = name;
    img.onerror = () => showError('The image could not be loaded.');
    stage.append(img); content.append(stage);
  } else if (kind === 'video') {
    const stage = document.createElement('div'); stage.className = 'video-stage';
    const video = document.createElement('video'); video.src = asset; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    video.onerror = () => showError('The video could not be loaded.');
    stage.append(video); content.append(stage);
  } else if (kind === 'audio') {
    const audio = document.createElement('audio'); audio.src = asset; audio.controls = true; audio.preload = 'metadata'; audio.setAttribute('aria-label', name); content.append(audio);
  } else if (kind === 'pdf' || kind === 'html') {
    if (kind === 'pdf' && navigator.pdfViewerEnabled === false) {
      showError('This browser cannot display embedded PDFs. Open the original to read or download the complete document.');
      const link = document.createElement('a'); link.href = asset; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open original PDF ↗'; content.append(link);
    } else {
      const frame = document.createElement('iframe'); frame.className = kind === 'pdf' ? 'pdf-frame' : 'app-frame'; frame.src = asset; frame.title = name;
      content.append(frame);
    }
  } else if (kind === 'markdown') {
    mountMarkdownReader({asset,query,resourceRoot,path,boardId,content,showError});
  } else showError('This media type is not supported.');
}
