const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const kind = query.get('kind') || 'html';
const boardId = query.get('board') || '';
const path = query.get('path') || '';
const remote = query.get('url') || '';
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
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(boardId)) return null;
  const parts = path.split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) return null;
  return `/boards/${encodeURIComponent(boardId)}/files/${parts.map(encodeURIComponent).join('/')}`;
}

function applyPreferences(theme, scale) {
  if (theme === 'paper' || theme === 'night') document.documentElement.dataset.theme = theme;
  if ([100, 115, 130].includes(Number(scale))) document.documentElement.style.setProperty('--scale', String(Number(scale) / 100));
}

function markdownAssetUrl(value, baseUrl) {
  try {
    const candidate = new URL(value, baseUrl);
    const boardPath = `/boards/${encodeURIComponent(boardId)}/files/`;
    if (['http:', 'https:'].includes(candidate.protocol) && (candidate.origin !== location.origin || candidate.pathname.startsWith(boardPath))) return candidate.href;
  } catch {}
  return null;
}

function appendInline(parent, text, baseUrl) {
  const token = /(!?\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[2] !== undefined) {
      const href = markdownAssetUrl(match[3], baseUrl);
      if (href) {
        if (match[1].startsWith('!')) {
          const image = document.createElement('img');
          image.src = href;
          image.alt = match[2];
          image.loading = 'lazy';
          parent.append(image);
        } else {
          const link = document.createElement('a');
          link.href = href;
          link.textContent = match[2];
          if (new URL(href).origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
          parent.append(link);
        }
      } else parent.append(document.createTextNode(match[0]));
    } else {
      const element = document.createElement(match[4] !== undefined ? 'code' : match[5] !== undefined ? 'strong' : 'em');
      element.textContent = match[4] ?? match[5] ?? match[6];
      parent.append(element);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function renderMarkdown(markdown, baseUrl) {
  const article = document.createElement('article');
  article.className = 'markdown';
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const codeFence = line.match(/^\s*```/);
    if (codeFence) {
      const code = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      const pre = document.createElement('pre');
      const codeNode = document.createElement('code');
      codeNode.textContent = code.join('\n');
      pre.append(codeNode);
      article.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2], baseUrl);
      article.append(element);
      index++;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { article.append(document.createElement('hr')); index++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const parts = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) parts.push(lines[index++].replace(/^\s*>\s?/, ''));
      const blockquote = document.createElement('blockquote');
      appendInline(blockquote, parts.join(' '), baseUrl);
      article.append(blockquote);
      continue;
    }
    const list = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[2]);
      const element = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        const li = document.createElement('li');
        appendInline(li, item[3], baseUrl);
        element.append(li);
        index++;
      }
      article.append(element);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|\s*```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[index])) paragraph.push(lines[index++].trim());
    if (!paragraph.length) paragraph.push(lines[index++].trim());
    const p = document.createElement('p');
    appendInline(p, paragraph.join(' '), baseUrl);
    article.append(p);
  }
  content.replaceChildren(article);
}

applyPreferences(query.get('theme'), query.get('scale'));
// Inside Tinka's experiment view the surrounding header already names the item and links to it.
if (query.get('chrome') === 'none' && parent !== window) $('media-header').hidden = true;
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'reader-preferences') applyPreferences(event.data.theme, event.data.scale);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && parent !== window) parent.postMessage({ type: 'reader-close' }, location.origin);
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
  } else if (kind === 'pdf' || kind === 'html') {
    const frame = document.createElement('iframe'); frame.className = kind === 'pdf' ? 'pdf-frame' : 'app-frame'; frame.src = asset; frame.title = name;
    content.append(frame);
  } else if (kind === 'markdown') {
    fetch(asset).then(response => { if (!response.ok) throw new Error(); return response.text(); }).then(text => renderMarkdown(text, new URL(asset, location.href))).catch(() => showError('The Markdown file could not be loaded.'));
  } else showError('This media type is not supported.');
}
