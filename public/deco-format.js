// Safe Markdown subset for board Text and Sticky decorations. User text is
// only ever placed with text nodes (or escaped for the string form); no
// innerHTML of user content. Supports **bold**, *italic*, `code`, "- "/"* "
// bullets, "1. " numbered lists, "[ ] "/"[x] " checkboxes and "# " headings.

const INLINE = /`[^`\n]+`|\*\*(?=\S)[^\n]*?\S\*\*|\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*/;
const STRIKE = /~~[^\s~](?:[^~\n]*?[^\s~])?~~/;
const RICH_INLINE = new RegExp(`${INLINE.source}|${STRIKE.source}`);
const LIST = /^(\s*([-*]|\d+[.)]) )(.*)$/;
const TASK = /^\[([ xX])\] (.*)$/;
const RICH_TASK = /^\[([ xX])\](?: (.*))?$/;

function parseInline(text, pattern) {
  const out = [];
  let rest = text;
  while (rest) {
    const m = pattern.exec(rest);
    if (!m) { out.push({t:'text', v:rest}); break; }
    if (m.index) out.push({t:'text', v:rest.slice(0, m.index)});
    const tok = m[0];
    if (tok[0] === '`') out.push({t:'code', v:tok.slice(1, -1)});
    else if (tok.startsWith('**')) out.push({t:'strong', c:parseInline(tok.slice(2, -2), pattern)});
    else if (tok.startsWith('~~')) out.push({t:'del', c:parseInline(tok.slice(2, -2), pattern)});
    else out.push({t:'em', c:parseInline(tok.slice(1, -1), pattern)});
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function parseTask(text, start, rich) {
  const m = (rich ? RICH_TASK : TASK).exec(text);
  return m ? {checked:m[1] !== ' ', text:m[2] ?? '', offset:start + 1} : null;
}

// Blocks: {t:'h', level, c} | {t:'p', c} | {t:'ul'|'ol', items:[{task, c}]}
function parseBlocks(text, rich = false) {
  const blocks = [];
  const pattern = rich ? RICH_INLINE : INLINE;
  const lines = String(text ?? '').split(/(\r\n?|\n)/);
  let start = 0;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const list = LIST.exec(line);
    const body = list ? list[3] : line;
    const task = parseTask(body, start + (list ? list[1].length : 0), rich);
    start += line.length + (lines[i + 1]?.length ?? 0);
    if (list) {
      const kind = /^\d/.test(list[2]) ? 'ol' : 'ul';
      const item = {task, c:parseInline(task ? task.text : body, pattern)};
      const last = blocks[blocks.length - 1];
      if (last && last.t === kind) last.items.push(item); else blocks.push({t:kind, items:[item]});
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) blocks.push({t:'h', level:heading[1].length, c:parseInline(heading[2], pattern)});
    else blocks.push({t:'p', task, c:parseInline(task ? task.text : line, pattern)});
  }
  return blocks;
}

// Offsets refer to the raw source (including CRLF and UTF-16 surrogate pairs).
export function toggleDecorationTask(text, offset) {
  if (typeof text !== 'string' || !Number.isInteger(offset) || offset < 1 || offset >= text.length) return null;
  const start = Math.max(text.lastIndexOf('\n', offset), text.lastIndexOf('\r', offset)) + 1;
  const line = text.slice(start).split(/\r\n?|\n/, 1)[0];
  const list = LIST.exec(line);
  const task = list ? parseTask(list[3], start + list[1].length, true) : parseTask(line, start, true);
  if (task?.offset !== offset) return null;
  return text.slice(0, offset) + (task.checked ? ' ' : 'x') + text.slice(offset + 1);
}

const GLYPH = checked => checked ? '☑' : '☐';
const CLASS = {h:'deco-heading', p:'deco-line', ul:'deco-list', ol:'deco-list'};

// ---- DOM renderer ----
function inlineNodes(doc, parent, nodes) {
  for (const n of nodes) {
    if (n.t === 'text') parent.append(doc.createTextNode(n.v));
    else if (n.t === 'code') { const el = doc.createElement('code'); el.textContent = n.v; parent.append(el); }
    else { const el = doc.createElement(n.t); inlineNodes(doc, el, n.c); parent.append(el); }
  }
}
function taskGlyph(doc, parent, task) {
  if (!task) return;
  const g = doc.createElement('span');
  g.className = 'deco-check' + (task.checked ? ' checked' : '');
  g.setAttribute('aria-hidden', 'true');
  g.textContent = GLYPH(task.checked) + ' ';
  parent.append(g);
}

export function formatDecorationText(text, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const b of parseBlocks(text)) {
    if (b.t === 'ul' || b.t === 'ol') {
      const list = doc.createElement(b.t);
      list.className = CLASS[b.t];
      for (const item of b.items) {
        const li = doc.createElement('li');
        if (item.task) li.className = 'deco-task';
        taskGlyph(doc, li, item.task);
        inlineNodes(doc, li, item.c);
        list.append(li);
      }
      frag.append(list);
    } else {
      const el = doc.createElement('div');
      el.className = CLASS[b.t];
      taskGlyph(doc, el, b.task);
      inlineNodes(doc, el, b.c);
      if (!el.childNodes.length) el.append(doc.createElement('br'));
      frag.append(el);
    }
  }
  return frag;
}

// ---- String renderer (tests and string-built markup) ----
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inlineHTML = nodes => nodes.map(n =>
  n.t === 'text' ? escapeHTML(n.v)
  : n.t === 'code' ? `<code>${escapeHTML(n.v)}</code>`
  : `<${n.t}>${inlineHTML(n.c)}</${n.t}>`).join('');
const inlineText = nodes => nodes.map(n => n.c ? inlineText(n.c) : n.v).join('');

function taskHTML(task, nodes, interactive) {
  if (!task) return '';
  const cls = `deco-check${task.checked ? ' checked' : ''}`;
  const glyph = GLYPH(task.checked);
  if (!interactive) return `<span class="${cls}" aria-hidden="true">${glyph} </span>`;
  const label = escapeHTML(inlineText(nodes).trim() || 'Task');
  return `<button type="button" class="deco-task-toggle ${cls}" role="checkbox" aria-checked="${task.checked}" aria-label="${label}" data-deco-task="${task.offset}"><span aria-hidden="true">${glyph}</span></button> `;
}

export function formatToHTMLString(text, {rich = false, interactive = false} = {}) {
  const interactiveTasks = rich && interactive;
  return parseBlocks(text, rich).map(b => {
    if (b.t === 'ul' || b.t === 'ol') {
      const items = b.items.map(i => `<li${i.task ? ' class="deco-task"' : ''}>${taskHTML(i.task, i.c, interactiveTasks)}${inlineHTML(i.c)}</li>`).join('');
      return `<${b.t} class="${CLASS[b.t]}">${items}</${b.t}>`;
    }
    const tag = rich && b.t === 'h' ? `h${b.level}` : 'div';
    const inner = taskHTML(b.task, b.c, interactiveTasks) + inlineHTML(b.c);
    return `<${tag} class="${CLASS[b.t]}">${inner || '<br>'}</${tag}>`;
  }).join('');
}
