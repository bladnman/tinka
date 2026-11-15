// References inside comments: the @ picker (items, drawn elements and boards on this board,
// grouped and filterable), reference chips in the composer and in posted messages, and the
// body <-> {text, refs} conversion the comments API stores. A chip click shows the target on
// the board (board.revealRef); ⌘-click or its small ↗ opens it (board.openRef).
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[ch]);
const ICON = {
  item:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 6.5h6M5 9.5h4"/></svg>',
  decoration:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5 11.5 4M8.5 4h3v3"/></svg>',
  board:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
  open:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7 9"/></svg>',
};
export {esc, ICON as REF_ICONS};

// ---------- the stored form ----------
// The API keeps a chip's "@label" text in the body and the structured link in `refs` (the
// server does not parse the body). Rendering finds each ref's "@label" in the body again.
const REF_KINDS = new Set(["item", "placement", "decoration", "board"]);
export function cleanRef(ref) {
  if (!ref || !REF_KINDS.has(ref.kind) || typeof ref.id !== "string") return null;
  const out = {kind:ref.kind, id:ref.id, label:String(ref.label || ref.id).replace(/\n/g, " ").slice(0, 120)};
  if (ref.boardId) out.boardId = ref.boardId;
  if ((ref.kind === "placement" || ref.kind === "decoration") && !out.boardId) return null;
  return out;
}
const GONE = new Set(["removed", "deleted", "missing"]);

// ---------- readable labels ----------
const plain = text => String(text || "").replace(/[*_`~#>\[\]]/g, "").replace(/\s+/g, " ").trim();
const clip = (text, n = 40) => text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
const SHAPES = {rectangle:"Sticky", rounded:"Process", diamond:"Decision", ellipse:"Start / end"};
export function decorationLabel(d) {
  if (!d) return "Drawn element";
  const text = clip(plain(d.text));
  const kind = d.type === "line" ? "Arrow" : d.type === "text" ? "Text" : d.type === "region" ? (SHAPES[d.shape] || (d.shape ? "Shape" : "Region")) : "Drawn element";
  return text ? `${kind} · ${text}` : kind;
}
export function itemLabel(item) {
  if (!item) return "Item";
  return clip(`${item.number ? item.number + " · " : ""}${item.title || "Untitled"}`, 60);
}

/** Everything @ can reference from this board: its items, its drawn elements and boards. */
export function refCandidates(board) {
  const snap = board.snapshot || {}, boardId = snap.id, items = snap.items || {}, seen = new Set();
  const groups = {items:[], drawn:[], boards:[]};
  for (const p of snap.placements || []) {
    if (p.removedAt || p.deletedAt || p.archivedAt) continue;
    const item = items[p.itemId]; if (!item || seen.has(item.id)) continue; seen.add(item.id);
    if (item.childBoardId && !item.content) groups.boards.push({kind:"board", id:item.childBoardId, label:itemLabel(item)});
    else groups.items.push({kind:"item", id:item.id, boardId, placementId:p.id, label:itemLabel(item)});
  }
  for (const d of snap.decorations || []) groups.drawn.push({kind:"decoration", id:d.id, boardId, label:decorationLabel(d)});
  const known = new Set(groups.boards.map(b => b.id));
  for (const b of board.workspaceGraph?.boards || []) if (!known.has(b.id) && b.id !== boardId) { known.add(b.id); groups.boards.push({kind:"board", id:b.id, label:clip(b.title || b.id, 60)}); }
  if (boardId && !known.has(boardId)) groups.boards.unshift({kind:"board", id:boardId, label:clip(`${snap.title || "This board"} (this board)`, 60)});
  return groups;
}

/** Whether a ref still exists, judged from this board's snapshot (API status wins when given). */
export function refState(board, ref) {
  if (ref.exists === false || GONE.has(ref.state)) return "deleted";
  if (ref.exists === true) return ref.state || "active";
  const snap = board.snapshot || {};
  if (ref.kind === "decoration") return ref.boardId && ref.boardId !== snap.id ? "other" : (snap.decorations || []).some(d => d.id === ref.id) ? "active" : "deleted";
  if (ref.kind === "item") { const item = snap.items?.[ref.id]; return item ? (item.deletedAt ? "deleted" : "active") : ref.boardId && ref.boardId !== snap.id ? "other" : "deleted"; }
  if (ref.kind === "placement") return (snap.placements || []).some(p => p.id === ref.id && !p.removedAt) ? "active" : "deleted";
  return "active";
}

// ---------- chips ----------
export function chipElement(ref, {state = "active", editable = false} = {}) {
  const chip = document.createElement("span");
  chip.className = "cref" + (state === "deleted" ? " missing" : "");
  chip.contentEditable = "false";
  chip.dataset.ref = JSON.stringify(cleanRef(ref));
  chip.dataset.kind = ref.kind;
  const icon = ICON[ref.kind === "placement" ? "item" : ref.kind] || ICON.item;
  chip.innerHTML = `${icon}<span class="cref-label">${esc(ref.label)}</span>${!editable && ref.kind !== "board" && state !== "deleted" ? `<button type="button" class="cref-open" tabindex="-1" aria-label="Open ${esc(ref.label)}" title="Open">${ICON.open}</button>` : ""}`;
  chip.title = state === "deleted" ? "Deleted" : ref.kind === "board" ? "Open board" : "Show on board · ⌘-click or ↗ opens it";
  if (!editable) { chip.setAttribute("role", "link"); chip.tabIndex = 0; }
  return chip;
}
/** The name a chip shows now: a drawn element's readable label from this board, else the
 *  server's current label (plain text), else the label saved with the comment. */
export function chipLabel(board, ref) {
  if (ref.kind === "decoration" && (!ref.boardId || ref.boardId === board.snapshot?.id)) {
    const d = board.snapshot?.decorations?.find(x => x.id === ref.id); if (d) return decorationLabel(d);
  }
  return plain(ref.currentLabel) || ref.label;
}
/** A posted message: its text, with each ref's "@label" shown as a chip. */
export function renderBody(board, body, refs = []) {
  const frag = document.createDocumentFragment(), text = String(body || "");
  const labels = refs.map((ref, i) => ({i, token:"@" + ref.label})).filter(entry => entry.token.length > 1).sort((a, b) => b.token.length - a.token.length);
  let last = 0, at = 0;
  while (at < text.length) {
    const next = text.indexOf("@", at); if (next < 0) break;
    const hit = labels.find(entry => text.startsWith(entry.token, next));
    if (!hit) { at = next + 1; continue; }
    if (next > last) frag.append(document.createTextNode(text.slice(last, next)));
    const ref = refs[hit.i];
    frag.append(chipElement({...ref, label:chipLabel(board, ref)}, {state:refState(board, ref)}));
    last = at = next + hit.token.length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
/** Wire chip clicks inside `root`: show on the board, or open with ⌘-click / ↗. */
export function bindChips(root, board) {
  const act = (event, chip) => {
    let ref; try { ref = JSON.parse(chip.dataset.ref); } catch { return; }
    event.preventDefault(); event.stopPropagation();
    if (chip.classList.contains("missing")) return;
    const open = ref.kind === "board" || event.metaKey || event.ctrlKey || event.target.closest(".cref-open");
    if (open) openRef(board, ref); else board.revealRef?.(ref);
  };
  root.addEventListener("click", event => {
    const chip = event.target.closest?.(".cref[data-ref]");
    if (!chip || chip.closest("[contenteditable=true]")) return;
    act(event, chip);
  });
  root.addEventListener("keydown", event => {
    const chip = event.target.closest?.(".cref[data-ref]");
    if (chip && !chip.closest("[contenteditable=true]") && (event.key === "Enter" || event.key === " ")) act(event, chip);
  });
}
export function openRef(board, ref) {
  if (board.openRef) return board.openRef(ref);
  if (ref.kind === "board") return board.navigate?.(ref.id);
  const id = ref.placementId || board.snapshot?.placements?.find(p => p.itemId === ref.id)?.id;
  const open = id && document.querySelector(`[data-placement="${CSS.escape(id)}"] [data-open]:not(:disabled)`);
  if (open) open.click(); else board.revealRef?.(ref);
}

// ---------- the composer ----------
/** {text, refs} from a composer: each chip becomes its "@label" text plus a ref. */
export function composerValue(el) {
  const refs = [], keyOf = new Map();
  let text = "";
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { text += child.nodeValue.replace(/​/g, ""); continue; }
      if (child.nodeType !== 1) continue;
      if (child.classList.contains("cref")) {
        let ref; try { ref = cleanRef(JSON.parse(child.dataset.ref)); } catch {}
        if (!ref) continue;
        const key = `${ref.kind}:${ref.boardId || ""}:${ref.id}`;
        if (!keyOf.has(key) && refs.length < 20) { keyOf.set(key, refs.length); refs.push(ref); }
        text += "@" + ref.label; continue;
      }
      if (child.tagName === "BR") { text += "\n"; continue; }
      if (/^(DIV|P)$/.test(child.tagName) && text && !text.endsWith("\n")) text += "\n";
      walk(child);
    }
  };
  walk(el);
  return {text:text.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim(), refs};
}
export function setComposerValue(el, board, text = "", refs = []) {
  el.replaceChildren(renderBody(board, text, refs.map(ref => ({...ref, exists:true, currentLabel:undefined}))));
  for (const chip of el.querySelectorAll(".cref")) { chip.querySelector(".cref-open")?.remove(); chip.removeAttribute("role"); chip.removeAttribute("tabindex"); }
}
export const composerEmpty = el => !el.textContent.replace(/​/g, "").trim() && !el.querySelector(".cref");

/** The @ picker for a contenteditable composer. Returns {close, open: () => bool}. */
export function attachPicker(el, board, {onChange = () => {}} = {}) {
  let picker = null, at = null, index = 0, flat = [];
  const caretText = () => {
    const s = getSelection(); if (!s.rangeCount || !s.isCollapsed || !el.contains(s.anchorNode) || s.anchorNode.nodeType !== 3) return null;
    const before = s.anchorNode.nodeValue.slice(0, s.anchorOffset), m = /(^|[\s(])@([^\s@]{0,40})$/.exec(before);
    return m ? {node:s.anchorNode, start:s.anchorOffset - m[2].length - 1, end:s.anchorOffset, query:m[2]} : null;
  };
  function close() { picker?.remove(); picker = null; at = null; }
  function render() {
    const q = at.query.toLowerCase(), groups = refCandidates(board), match = r => !q || r.label.toLowerCase().includes(q);
    const shown = [["Items", groups.items.filter(match)], ["Drawn", groups.drawn.filter(match)], ["Boards", groups.boards.filter(match)]].filter(([, list]) => list.length).map(([name, list]) => [name, list.slice(0, 30)]);
    flat = shown.flatMap(([, list]) => list); index = Math.min(index, Math.max(0, flat.length - 1));
    if (!picker) { picker = document.createElement("div"); picker.className = "cref-picker"; picker.setAttribute("role", "listbox"); picker.setAttribute("aria-label", "Reference"); document.body.append(picker);
      picker.addEventListener("mousedown", e => { e.preventDefault(); const b = e.target.closest("[data-i]"); if (b) choose(flat[+b.dataset.i]); }); }
    let i = 0;
    picker.innerHTML = shown.length ? shown.map(([name, list]) => `<h6>${name}</h6>` + list.map(r => `<button type="button" role="option" data-i="${i}" aria-selected="${i++ === index}">${ICON[r.kind] || ICON.item}<span>${esc(r.label)}</span></button>`).join("")).join("")
      : `<p class="cref-empty">No match for “${esc(at.query)}”</p>`;
    const r = document.createRange(); r.setStart(at.node, at.start); r.setEnd(at.node, at.end);
    const rect = r.getBoundingClientRect(), width = Math.min(280, innerWidth - 16);
    picker.style.width = `${width}px`;
    picker.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`;
    const below = rect.bottom + 6, height = picker.offsetHeight;
    picker.style.top = `${below + height > innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below}px`;
    picker.querySelector('[aria-selected="true"]')?.scrollIntoView({block:"nearest"});
  }
  function choose(ref) {
    if (!ref || !at) return close();
    const r = document.createRange(); r.setStart(at.node, at.start); r.setEnd(at.node, at.end); r.deleteContents();
    const chip = chipElement(ref, {editable:true}), space = document.createTextNode(" ");
    r.insertNode(space); r.insertNode(chip);
    const c = document.createRange(); c.setStart(space, 1); c.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(c);
    close(); onChange();
  }
  el.addEventListener("input", () => { const found = caretText(); if (!found) return close(); at = found; if (!picker) index = 0; render(); });
  el.addEventListener("keydown", e => {
    if (!picker) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); index = (index + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % Math.max(1, flat.length); render(); }
    else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") { if (flat.length) { e.preventDefault(); choose(flat[index]); } }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  el.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== el) close(); }, 120));
  return {close, get open() { return !!picker; }};
}
