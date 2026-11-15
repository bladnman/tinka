// In-place WYSIWYG editing of a Markdown document inside its own page (a board card's
// media.html frame or the reader). No toolbar: Markdown typing shortcuts, ⌘B/⌘I/⌘K/⌘E,
// ⌘⇧7/⌘⇧8/⌘⇧9 lists, clickable checkboxes. Autosaves about 800 ms after typing stops and
// on blur through PUT /api/documents/:itemId with baseRevision; unedited blocks keep their
// exact source (serializeDocument). Escape or ⌘Enter ends editing (saved).
import {markdownToDom,domToMarkdown,serializeDocument,titleFromMarkdown,safeUrl} from "./document-markdown.js";
import {parseMarkdown,documentTextMap,locateTextAnchor} from "./markdown-document.js";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const BLOCK = "p,div,h1,h2,h3,h4,li,blockquote,pre";
const IDLE_MS = 800;
const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[ch]);
export async function sourceRevision(text) {
  return bytesRevision(new TextEncoder().encode(text));
}
export async function bytesRevision(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
let workspaceHeader;
async function workspaceId() {
  workspaceHeader ||= fetch("/api/config", {cache:"no-store"}).then(r => r.json()).then(c => c.workspaceId).catch(error => { workspaceHeader = null; throw error; });
  return workspaceHeader;
}

// Where a click on the rendered page lands, as (top-level block index, text offset in it).
function pointPosition(article, point) {
  if (!article || !point) return null;
  const range = document.caretRangeFromPoint?.(point.x, point.y) ||
    (pos => { if (!pos) return null; const r = document.createRange(); r.setStart(pos.offsetNode, pos.offset); return r; })(document.caretPositionFromPoint?.(point.x, point.y));
  if (!range || !article.contains(range.startContainer)) return null;
  const blocks = [...article.children];
  const block = blocks.find(el => el.contains(range.startContainer));
  if (!block) return null;
  const before = document.createRange(); before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
  return {index:blocks.indexOf(block), offset:before.toString().length};
}
function placeAt(node, offset) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let left = offset, last = null;
  while (walker.nextNode()) { last = walker.currentNode; if (left <= last.length) return caret(last, left); left -= last.length; }
  if (last) return caret(last, last.length);
  return caret(node, 0);
}
function caret(node, offset) { const r = document.createRange(); r.setStart(node, offset); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }

/** Read a document's exact bytes: text keeps a leading BOM (the revision hashes raw bytes). */
export async function readSource(asset) {
  const response = await fetch(asset, {cache:"no-store"});
  if (!response.ok) throw new Error(`The document could not be read (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {text:new TextDecoder("utf-8", {ignoreBOM:true}).decode(bytes), revision:await bytesRevision(bytes)};
}

/**
 * Start editing. Options: content (the scrolling container), article (the rendered page, replaced
 * while editing), asset (source URL), text and revision (as loaded), itemId, point (client point on
 * the rendered page), source (start in the Markdown source view), selectTitle (select the first
 * heading's text), onStatus({state,message}), onEnd({saved,text,title,revision}).
 */
export function startDocumentEditor(options) {
  const {content, article, asset, itemId, onStatus = () => {}, onEnd = () => {}} = options;
  // A UTF-8 BOM is kept aside and written back, so the editor never sees it and the bytes survive.
  const BOM = "\ufeff";
  let bom = options.text.startsWith(BOM) ? BOM : "", text = bom ? options.text.slice(1) : options.text;
  let revision = options.revision, saved = text, savedAny = false, conflict = false, ended = false;
  const scroll = content.scrollTop, position = pointPosition(article, options.point);
  const root = document.documentElement;
  root.dataset.documentEditing = "";
  const page = document.createElement("article");
  page.className = "markdown doc-editing"; page.contentEditable = "true"; page.spellcheck = true;
  page.setAttribute("role", "textbox"); page.setAttribute("aria-multiline", "true"); page.setAttribute("aria-label", "Document, editing");
  const raw = document.createElement("textarea");
  raw.className = "doc-editing-source"; raw.spellcheck = false; raw.setAttribute("aria-label", "Markdown source");
  const bar = document.createElement("div"); bar.className = "doc-editing-conflict"; bar.hidden = true; bar.setAttribute("role", "alert");
  bar.innerHTML = `<span>Changed elsewhere since you started editing.</span><button type="button">Reload</button>`;
  const linkBox = document.createElement("form"); linkBox.className = "doc-editing-link"; linkBox.hidden = true;
  linkBox.innerHTML = `<input type="url" placeholder="Paste a link, Enter to apply" aria-label="Link address">`;
  const linkInput = linkBox.querySelector("input");
  let sourceMode = false;

  function build(markdown) {
    page.replaceChildren();
    markdownToDom(document, page, markdown);
    for (const img of page.querySelectorAll("img[data-src]")) { const src = safeUrl(img.dataset.src); if (src) img.src = new URL(src, new URL(asset, location.href)).href; }
    if (!page.firstChild) page.append(Object.assign(document.createElement("p"), {innerHTML:"<br>"}));
  }
  const current = () => sourceMode ? raw.value : serializeDocument(page);
  function setSource(on) {
    if (on === sourceMode) return;
    if (on) { raw.value = serializeDocument(page); page.replaceWith(raw); sourceMode = true; raw.focus(); }
    else { build(raw.value); raw.replaceWith(page); sourceMode = false; resetHistory(); page.focus(); }
  }
  build(text);
  (article || content.firstChild) ? (article || content.firstChild).replaceWith(page) : content.append(page);
  content.append(bar, linkBox);
  content.scrollTop = scroll;
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch {}
  if (options.source) { raw.value = text; page.replaceWith(raw); sourceMode = true; try { window.focus(); } catch {} raw.focus(); raw.setSelectionRange(raw.value.length, raw.value.length); }
  else {
    try { window.focus(); } catch {}
    page.focus({preventScroll:true});
    const heading = page.querySelector("h1");
    if (options.selectTitle && heading) { const r = document.createRange(); r.selectNodeContents(heading); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    else if (position && page.children[position.index]) placeAt(page.children[position.index], position.offset);
    else { const r = document.createRange(); r.selectNodeContents(page); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }

  // ---------- saving ----------
  let timer = 0, inflight = null, again = false;
  const status = (state, message = "", extra = {}) => onStatus({state, message, ...extra});
  function schedule() { if (ended) return; clearTimeout(timer); timer = setTimeout(flush, IDLE_MS); status("editing"); }
  async function flush() {
    clearTimeout(timer);
    if (conflict) return false;
    if (inflight) { again = true; return inflight; }
    const value = current();
    if (value === saved) { status(savedAny ? "saved" : "idle"); return true; }
    inflight = (async () => {
      status("saving");
      try {
        const response = await fetch(`/api/documents/${encodeURIComponent(itemId)}`, {method:"PUT",
          headers:{"Content-Type":"application/json", "x-tinka-workspace":await workspaceId()}, body:JSON.stringify({text:bom + value, baseRevision:revision})});
        const data = await response.json().catch(() => ({}));
        if (response.status === 409 && (data.currentRevision || /changed/i.test(data.error || ""))) { conflict = true; bar.hidden = false; status("conflict", "Changed elsewhere"); return false; }
        if (!response.ok) throw new Error(data.error || `Save failed (${response.status}).`);
        saved = value; savedAny = true; revision = typeof data.revision === "string" ? data.revision : await sourceRevision(bom + value);
        status("saved", "", {revision, reanchored:data.reanchored || null}); paintMarks(); return true;
      } catch (error) { status("error", error.message); return false; }
      finally { inflight = null; }
    })();
    const result = await inflight;
    if (again) { again = false; return flush(); }
    return result;
  }
  bar.querySelector("button").addEventListener("click", async () => {
    try {
      const fresh = await readSource(asset);
      bom = fresh.text.startsWith(BOM) ? BOM : ""; text = saved = bom ? fresh.text.slice(1) : fresh.text; revision = fresh.revision;
      conflict = false; bar.hidden = true;
      if (sourceMode) raw.value = text; else build(text);
      resetHistory(); status("idle"); paintMarks();
    } catch { status("error", "The document could not be reloaded."); }
  });

  // ---------- highlight and comment marks ----------
  // Saved marks stay painted while editing: located in the saved text (currentAnchor first, as the
  // server re-anchors after each save), then found by their quote in the edited page. Ranges follow
  // later typing on their own; each save repaints from fresh records.
  let markRequest = 0;
  async function paintMarks() {
    if (!itemId || !globalThis.CSS?.highlights || !globalThis.Highlight || ended) return;
    const request = ++markRequest;
    try {
      const params = new URLSearchParams({itemId, limit:"100"});
      const [threads, marks] = await Promise.all([fetch("/api/feedback?" + params, {cache:"no-store"}), fetch("/api/highlights?" + params, {cache:"no-store"})]);
      if (!threads.ok || !marks.ok) return;
      const comments = ((await threads.json()).threads || []).filter(thread => thread.anchor?.kind === "text"), highlights = (await marks.json()).highlights || [];
      if (request !== markRequest || ended) return;
      markRecords = {comments, highlights};
      paintLocal();
    } catch {}
  }
  // Paint the last fetched marks on the page as it is now (after a save, an undo or a redo).
  let markRecords = null;
  function paintLocal() {
    if (!markRecords || ended || sourceMode || !globalThis.CSS?.highlights || !globalThis.Highlight) return;
    const {comments, highlights} = markRecords;
    try {
      const model = parseMarkdown(saved);
      // The page's text with a line break between blocks and list items, as the renderer has it.
      const nodes = []; let rawText = "";
      const walk = node => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) { nodes.push({node:child, start:rawText.length}); rawText += child.nodeValue; continue; }
          if (child.nodeType !== 1) continue;
          const block = child.parentNode === page || child.tagName === "LI";
          if (block && rawText && !rawText.endsWith("\n")) rawText += "\n";
          if (child.tagName === "BR") { rawText += "\n"; continue; }
          walk(child);
        }
      };
      walk(page);
      const map = documentTextMap(rawText.replace(/\u200b/g, " "));
      const toRange = (from, to) => {
        const a = map.starts[from], b = map.ends[to - 1]; if (a === undefined || b === undefined) return null;
        const r = document.createRange(); let begun = false;
        for (let i = 0; i < nodes.length; i++) {
          const {node, start} = nodes[i], end = start + node.nodeValue.length;
          if (!begun && a >= start && a < end) { r.setStart(node, a - start); begun = true; }
          if (begun && b <= end) { r.setEnd(node, b - start); return r; }
        }
        return null;
      };
      const ranges = {comment:[], highlight:[]};
      for (const [kind, records] of [["comment", comments], ["highlight", highlights]]) for (const record of records) {
        const anchor = record.currentAnchor || record.anchor;
        if (anchor?.kind !== "text" || record.anchorStatus !== "matched") continue;
        const located = locateTextAnchor(model.text, anchor, revision, model.textModel);
        if (located.status !== "matched") continue;
        const quote = model.text.slice(located.start, located.end);
        let best = -1;
        for (let at = map.text.indexOf(quote); at >= 0; at = map.text.indexOf(quote, at + 1)) if (best < 0 || Math.abs(at - located.start) < Math.abs(best - located.start)) best = at;
        const range = best >= 0 && toRange(best, best + quote.length);
        if (range) ranges[kind].push(range);
      }
      CSS.highlights.set("tinka-document-comments", new Highlight(...ranges.comment));
      CSS.highlights.set("tinka-document-highlights", new Highlight(...ranges.highlight));
    } catch {}
  }
  paintMarks();

  // ---------- selection helpers and formatting ----------
  const sel = () => getSelection();
  const blockOf = node => { let el = node?.nodeType === 1 ? node : node?.parentNode; el = el?.closest?.(BLOCK); return el && page.contains(el) && el !== page ? el : null; };
  const currentBlock = () => { const s = sel(); return s.rangeCount ? blockOf(s.anchorNode) : null; };
  // Programmatic edits are recorded by explicit checkpoints, never by the typing coalescer.
  let programmatic = false;
  const exec = (command, value) => { programmatic = true; try { return document.execCommand(command, false, value); } finally { programmatic = false; } };
  function toggleBlock(tag) { const inside = currentBlock()?.closest(tag); exec("formatBlock", inside && page.contains(inside) ? "p" : tag); }
  const listKind = list => !list ? null : list.tagName === "OL" ? "ol" : list.classList.contains("checklist") ? "task" : "ul";
  function shapeList(list, kind) {
    const next = document.createElement(kind === "ol" ? "ol" : "ul");
    if (kind === "task") next.className = "checklist";
    for (const attr of ["data-md-i"]) if (list.hasAttribute(attr)) next.setAttribute(attr, list.getAttribute(attr));
    for (const li of [...list.children]) { if (kind === "task") li.dataset.checked ||= "false"; else delete li.dataset.checked; next.append(li); }
    list.replaceWith(next); return next;
  }
  // Lists are built by hand: execCommand list commands nest lists inside paragraphs and merge
  // neighbouring lists.
  function toggleList(kind) {
    const s = sel(), offset = s.focusOffset, node = s.focusNode;
    const block = currentBlock(), li = block?.closest("li"), list = li?.parentElement;
    if (li && list && page.contains(list)) {
      if (listKind(list) !== kind) { shapeList(list, kind); if (node?.isConnected) caret(node, offset); return; }
      const p = document.createElement("p"); p.append(...li.childNodes); if (!p.firstChild) p.append(document.createElement("br"));
      const after = [...list.children].slice([...list.children].indexOf(li) + 1);
      li.remove(); list.after(p);
      if (after.length) { const rest = list.cloneNode(false); rest.removeAttribute("data-md-i"); rest.append(...after); p.after(rest); }
      if (!list.children.length) list.remove();
      if (node && p.contains(node)) caret(node, Math.min(offset, node.nodeType === 3 ? node.length : node.childNodes.length)); else caret(p, 0);
      return;
    }
    const target = block && !block.matches("pre") ? block : null;
    const ul = document.createElement(kind === "ol" ? "ol" : "ul"), item = document.createElement("li");
    if (kind === "task") { ul.className = "checklist"; item.dataset.checked = "false"; }
    if (target) item.append(...target.childNodes);
    if (!item.textContent && !item.querySelector("br,img")) item.replaceChildren(document.createElement("br"));
    ul.append(item);
    if (target) target.replaceWith(ul); else page.append(ul);
    if (node && item.contains(node)) caret(node, offset); else caret(item, 0);
  }
  function toggleCode() {
    const s = sel(), block = currentBlock();
    const code = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentNode).closest?.("code");
    if (code && page.contains(code) && !code.closest("pre")) { code.replaceWith(document.createTextNode(code.textContent)); return; }
    if (!s.isCollapsed && block && block.contains(s.focusNode) && !block.matches("pre")) { exec("insertHTML", `<code>${escapeHtml(s.toString())}</code>`); return; }
    toggleBlock("pre");
  }
  function divider() {
    const block = currentBlock();
    exec("insertHorizontalRule");
    const hr = block?.nextElementSibling?.tagName === "HR" ? block.nextElementSibling : [...page.querySelectorAll("hr")].find(h => !h.nextElementSibling);
    if (hr && (!hr.nextElementSibling || hr.nextElementSibling.tagName === "HR")) { const p = document.createElement("p"); p.innerHTML = "<br>"; hr.after(p); caret(p, 0); }
  }
  let linkRange = null;
  function openLink() {
    const s = sel(); if (!s.rangeCount) return;
    linkRange = s.getRangeAt(0).cloneRange();
    const a = (linkRange.startContainer.nodeType === 1 ? linkRange.startContainer : linkRange.startContainer.parentNode).closest?.("a");
    linkInput.value = a && page.contains(a) ? a.getAttribute("href") : "";
    const rect = linkRange.getBoundingClientRect(), box = content.getBoundingClientRect();
    linkBox.style.top = `${Math.max(4, rect.bottom - box.top + content.scrollTop + 6)}px`;
    linkBox.style.left = `${Math.max(4, Math.min(rect.left - box.left, box.width - 260))}px`;
    linkBox.hidden = false; linkInput.focus(); linkInput.select();
  }
  function closeLink(apply) {
    if (linkBox.hidden) return;
    linkBox.hidden = true; page.focus({preventScroll:true});
    if (linkRange) { const s = sel(); s.removeAllRanges(); s.addRange(linkRange); }
    if (!apply) return;
    checkpoint();
    const url = safeUrl(linkInput.value);
    if (!url) exec("unlink");
    else if (linkRange && !linkRange.collapsed) exec("createLink", url);
    else exec("insertHTML", `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>&nbsp;`);
    schedule();
  }
  linkBox.addEventListener("submit", e => { e.preventDefault(); closeLink(true); });
  linkInput.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeLink(false); } });
  linkInput.addEventListener("blur", () => setTimeout(() => { if (!linkBox.contains(document.activeElement)) closeLink(false); }, 0));

  // ---------- undo ----------
  // The editor owns undo: every change is a step on its own stack, as a snapshot of the page (its
  // HTML, which carries each block's source slot, and the selection) taken just before the change.
  // Typing coalesces into word-sized steps; structural changes (lists, Markdown shortcuts, block
  // formats, checkboxes, leaving a quote, paste, links) are one step each, and undoing a shortcut
  // brings back the literal text typed (for example "- "). Native undo is never used.
  const undoStack = [], redoStack = [], UNDO_LIMIT = 300;
  let typing = null; // the open typing step: {kind, at, space, node, offset}
  const lengthOf = node => node.nodeType === 3 ? node.length : node.childNodes.length;
  const pathTo = node => { const path = []; while (node && node !== page) { const parent = node.parentNode; if (!parent) return null; path.unshift(Array.prototype.indexOf.call(parent.childNodes, node)); node = parent; } return node === page ? path : null; };
  const nodeAt = path => { let node = page; for (const i of path || []) { node = node?.childNodes[i]; } return node || null; };
  function snapshot() {
    const s = sel(); let range = null;
    if (s.rangeCount && page.contains(s.getRangeAt(0).startContainer)) { const r = s.getRangeAt(0); range = {sp:pathTo(r.startContainer), so:r.startOffset, ep:pathTo(r.endContainer), eo:r.endOffset}; }
    return {html:page.innerHTML, range};
  }
  function restore(snap) {
    page.innerHTML = snap.html;
    page.focus({preventScroll:true});
    const r = document.createRange(), start = snap.range && nodeAt(snap.range.sp), finish = snap.range && nodeAt(snap.range.ep);
    try {
      if (!start || !finish) throw new Error();
      r.setStart(start, Math.min(snap.range.so, lengthOf(start))); r.setEnd(finish, Math.min(snap.range.eo, lengthOf(finish)));
    } catch { r.selectNodeContents(page); r.collapse(false); }
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    (start || page).parentElement?.scrollIntoView?.({block:"nearest"});
    typing = null; paintLocal(); schedule();
  }
  function checkpoint() {
    undoStack.push(snapshot()); if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0; typing = null;
  }
  function resetHistory() { undoStack.length = 0; redoStack.length = 0; typing = null; }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }
  page.addEventListener("beforeinput", e => {
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") { e.preventDefault(); (e.inputType === "historyUndo" ? undo : redo)(); return; }
    if (programmatic) return;
    const kind = /^insert(Text|CompositionText|ReplacementText)$/.test(e.inputType) ? "insert" : /^delete(Content|Word|SoftLine|HardLine)/.test(e.inputType) ? "delete" : "other";
    const s = sel(), space = kind === "insert" && /^\s+$/.test(e.data || "");
    const moved = !typing || !s.rangeCount || !s.isCollapsed || typing.node !== s.anchorNode || typing.offset !== s.anchorOffset;
    if (kind === "other" || moved || typing.kind !== kind || Date.now() - typing.at > 1500 || (space && !typing.space)) checkpoint();
    typing = kind === "other" ? null : {kind, at:Date.now(), space, node:null, offset:-1};
  });
  // After each typed change, remember where the caret is: typing on from there extends the step.
  page.addEventListener("input", () => { const s = sel(); if (typing && s.rangeCount) { typing.node = s.anchorNode; typing.offset = s.anchorOffset; typing.at = Date.now(); } });

  // ---------- keys ----------
  const KEYS = {KeyB:[false, () => exec("bold")], KeyI:[false, () => exec("italic")], KeyK:[false, openLink], KeyE:[false, toggleCode],
    KeyX:[true, () => exec("strikeThrough")], Digit7:[true, () => toggleList("ol")], Digit8:[true, () => toggleList("ul")], Digit9:[true, () => toggleList("task")]};
  function onKey(e) {
    const mod = MAC ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); end(); return; }
    if (e.key === "Enter" && mod) { e.preventDefault(); end(); return; }
    if (sourceMode || e.isComposing) return;
    if (mod && !e.altKey && e.code === "KeyZ") { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if (!MAC && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyY") { e.preventDefault(); redo(); return; }
    if (mod && !e.altKey && KEYS[e.code] && KEYS[e.code][0] === e.shiftKey) { e.preventDefault(); if (e.code !== "KeyK") checkpoint(); KEYS[e.code][1](); schedule(); return; }
    const block = currentBlock();
    if (e.key === "Enter" && !e.shiftKey && !mod && block?.matches("pre")) { e.preventDefault(); checkpoint(); exec("insertText", "\n"); return; }
    const quote = block?.closest("blockquote");
    if (e.key === "Enter" && !e.shiftKey && quote && page.contains(quote)) {
      const s = sel(), r = document.createRange(); r.selectNodeContents(quote); r.setStart(s.focusNode, s.focusOffset);
      if (!r.toString().replace(/[​\n]/g, "").trim()) {
        e.preventDefault(); checkpoint();
        for (let last = quote.lastChild; last && quote.childNodes.length > 1 && (last.nodeName === "BR" || (!last.textContent.trim() && last.nodeName !== "IMG")); last = quote.lastChild) last.remove();
        const p = document.createElement("p"); p.innerHTML = "<br>"; quote.after(p); caret(p, 0); schedule(); return;
      }
    }
    if (e.key === "Enter" && block?.closest("ul.checklist"))
      requestAnimationFrame(() => { const li = currentBlock()?.closest("ul.checklist > li"); if (li && !li.textContent.trim()) li.dataset.checked = "false"; });
  }
  page.addEventListener("keydown", onKey);
  raw.addEventListener("keydown", onKey);

  // ---------- Markdown typing shortcuts ----------
  page.addEventListener("input", e => {
    schedule();
    if (e.inputType !== "insertText" || !e.data) return;
    const s = sel(); if (!s.isCollapsed || !s.rangeCount) return;
    const node = s.anchorNode, offset = s.anchorOffset, block = blockOf(node);
    if (!block) return;
    if (e.data === " " && !block.matches("pre")) {
      const r = document.createRange(); r.setStart(block, 0); r.setEnd(node, offset);
      const before = r.toString().replace(/ /g, " ");
      const rule = {"# ":["block", "h1"], "## ":["block", "h2"], "### ":["block", "h3"], "- ":["list", "ul"], "* ":["list", "ul"], "1. ":["list", "ol"],
        "[] ":["list", "task"], "[ ] ":["list", "task"], "> ":["block", "blockquote"], "--- ":["hr"]}[before];
      if (!rule) return;
      checkpoint();
      r.deleteContents();
      if (!block.textContent && !block.querySelector("br,img")) block.append(document.createElement("br"));
      caret(block, 0);
      // formatBlock can leave an empty, childless paragraph behind; it is not content.
      if (rule[0] === "block") { exec("formatBlock", rule[1]); for (const el of [...page.children]) if (el.tagName === "P" && !el.textContent && !el.querySelector("br,img") && !el.contains(sel().anchorNode)) el.remove(); }
      else if (rule[0] === "list") { const list = block.closest("li")?.parentElement; if (list && listKind(list) !== rule[1]) shapeList(list, rule[1]); else if (!list) toggleList(rule[1]); }
      else divider();
      return;
    }
    if ((e.data === "*" || e.data === "`") && node.nodeType === 3 && !block.matches("pre")) {
      const before = node.nodeValue.slice(0, offset);
      const match = e.data === "*" ? /\*\*([^*\n]+)\*\*$/.exec(before) : /`([^`\n]+)`$/.exec(before);
      if (!match || node.parentNode.closest("code")) return;
      checkpoint();
      const el = document.createElement(e.data === "*" ? "strong" : "code"); el.textContent = match[1];
      const after = document.createTextNode("​" + node.nodeValue.slice(offset));
      node.nodeValue = before.slice(0, match.index);
      node.after(el); el.after(after); caret(after, 1);
    }
  });
  raw.addEventListener("input", schedule);
  // Checklist boxes are drawn left of the item; a press there toggles it.
  page.addEventListener("mousedown", e => {
    const li = e.target.closest?.("ul.checklist > li");
    if (!li || !page.contains(li) || e.clientX >= li.getBoundingClientRect().left + parseFloat(getComputedStyle(li).paddingLeft)) return;
    e.preventDefault(); checkpoint(); li.dataset.checked = li.dataset.checked === "true" ? "false" : "true"; schedule();
  });
  page.addEventListener("click", e => { const a = e.target.closest?.("a"); if (a && page.contains(a) && (e.metaKey || e.ctrlKey)) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); } else if (a) e.preventDefault(); });
  // Paste: plain text as text; HTML reduced to the supported structure via Markdown.
  page.addEventListener("paste", e => {
    const data = e.clipboardData; if (!data) return;
    e.preventDefault(); checkpoint();
    const html = data.getData("text/html"), plain = data.getData("text/plain");
    if (!html) { exec("insertText", plain); return; }
    const md = domToMarkdown(new DOMParser().parseFromString(html, "text/html").body);
    if (!md) { exec("insertText", plain); return; }
    const holder = markdownToDom(document, document.createElement("div"), md);
    for (const el of holder.querySelectorAll("[data-md-i]")) el.removeAttribute("data-md-i");
    const only = holder.children.length === 1 && holder.firstElementChild.tagName === "P" ? holder.firstElementChild : null;
    exec("insertHTML", only ? only.innerHTML : holder.innerHTML);
  });
  const onBlur = () => { if (!ended) flush(); };
  window.addEventListener("blur", onBlur);
  // Escape from anywhere in this page (the conflict bar, a raw block) also ends editing.
  const onWindowKey = e => { if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && !linkBox.contains(e.target)) { e.preventDefault(); end(); } };
  window.addEventListener("keydown", onWindowKey, true);

  async function end() {
    if (ended) return; ended = true;
    clearTimeout(timer); closeLink(false);
    const ok = await flush();
    window.removeEventListener("blur", onBlur); window.removeEventListener("keydown", onWindowKey, true);
    delete root.dataset.documentEditing;
    bar.remove(); linkBox.remove();
    // On a board card, the keyboard goes back to the board (so D, E, arrows work at once).
    if (root.dataset.documentMode !== "reader" && parent !== window) { try { document.activeElement?.blur?.(); parent.focus(); } catch {} }
    onEnd({saved:savedAny, unsaved:ok === false, text:bom + saved, title:titleFromMarkdown(saved), revision});
  }
  // Keys typed before the caret appeared (options.pendingKeys) land where it is now, as one step.
  function typeKeys(keys) {
    if (!keys?.length || ended) return;
    if (sourceMode) { for (const key of keys) if (key.length === 1) raw.setRangeText(key, raw.selectionStart, raw.selectionEnd, "end"); schedule(); return; }
    checkpoint();
    for (const key of keys) {
      if (key === "Enter") exec("insertParagraph"); else if (key === "Backspace") exec("delete"); else exec("insertText", key);
    }
    typing = null; schedule();
  }
  typeKeys(options.pendingKeys);
  return {end, flush, setSource, undo, redo, typeKeys, get editing() { return !ended; }};
}
