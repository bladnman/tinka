// Safe Markdown subset for board Text and Sticky decorations. User text is
// only ever placed with text nodes (or escaped for the string form); no
// innerHTML of user content. Supports **bold**, *italic*, `code`, "- "/"* "
// bullets, "1. " numbered lists, "[ ] "/"[x] " checkboxes and "# " headings.

const INLINE = /(`[^`\n]+`|\*\*(?=\S)[^\n]*?\S\*\*|\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)/;

function parseInline(text) {
  const out = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push({t:'text', v:rest}); break; }
    if (m.index) out.push({t:'text', v:rest.slice(0, m.index)});
    const tok = m[0];
    if (tok[0] === '`') out.push({t:'code', v:tok.slice(1, -1)});
    else if (tok.startsWith('**')) out.push({t:'strong', c:parseInline(tok.slice(2, -2))});
    else out.push({t:'em', c:parseInline(tok.slice(1, -1))});
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function parseTask(text) {
  const m = /^\[([ xX])\] (.*)$/.exec(text);
  return m ? {checked:m[1] !== ' ', text:m[2]} : null;
}

// Blocks: {t:'h', c} | {t:'p', c} | {t:'ul'|'ol', items:[{task, c}]}
function parseBlocks(text) {
  const blocks = [];
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let m, kind = null, body = line;
    if ((m = /^\s*[-*] (.*)$/.exec(line))) { kind = 'ul'; body = m[1]; }
    else if ((m = /^\s*\d+[.)] (.*)$/.exec(line))) { kind = 'ol'; body = m[1]; }
    if (kind) {
      const task = parseTask(body);
      const item = {task, c:parseInline(task ? task.text : body)};
      const last = blocks[blocks.length - 1];
      if (last && last.t === kind) last.items.push(item); else blocks.push({t:kind, items:[item]});
      continue;
    }
    if ((m = /^#{1,6} (.*)$/.exec(line))) { blocks.push({t:'h', c:parseInline(m[1])}); continue; }
    const task = parseTask(line);
    blocks.push(task ? {t:'p', task, c:parseInline(task.text)} : {t:'p', c:parseInline(line)});
  }
  return blocks;
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
const taskHTML = task => task ? `<span class="deco-check${task.checked ? ' checked' : ''}" aria-hidden="true">${GLYPH(task.checked)} </span>` : '';

export function formatToHTMLString(text) {
  return parseBlocks(text).map(b => {
    if (b.t === 'ul' || b.t === 'ol') {
      const items = b.items.map(i => `<li${i.task ? ' class="deco-task"' : ''}>${taskHTML(i.task)}${inlineHTML(i.c)}</li>`).join('');
      return `<${b.t} class="${CLASS[b.t]}">${items}</${b.t}>`;
    }
    const inner = taskHTML(b.task) + inlineHTML(b.c);
    return `<div class="${CLASS[b.t]}">${inner || '<br>'}</div>`;
  }).join('');
}
