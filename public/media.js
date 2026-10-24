import {mountMarkdownReader} from './markdown-reader.js';
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
