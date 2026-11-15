// The Comment tool's floating thread card (Tinka 1.1, option A): opened from a pin beside it,
// in the floating-object style. Status chip, "On <target>", messages (people and agents look
// different; an agent's "Changed …" line), Looks good · Resolve / Not yet for addressed threads,
// resolve/reopen, edit and delete your own messages, and a reply composer with @ references
// (⌘↵ posts). Escape closes and keeps the draft; board keys never fire while typing here.
// On a narrow screen the card is a bottom sheet. API: lib/feedback.mjs (addComment,
// replyComment, setCommentStatus, editComment, deleteComment; GET /api/feedback).
import {esc, attachPicker, bindChips, chipElement, chipLabel, composerEmpty, composerValue, renderBody, setComposerValue, decorationLabel, itemLabel, refState} from "./comment-refs.js";

const STATUS = {open:"Open", sent:"Sent to agent", working:"Agent working", addressed:"Addressed · check it", question:"Agent asks you", resolved:"Resolved"};
const ICON = {
  check:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  reopen:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 3v2.5H6"/></svg>',
  close:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  agent:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z"/></svg>',
};
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+";
let current = null; // the one open card

function ensureStyle() {
  if (document.querySelector("link[data-comment-thread-css]")) return;
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/app/comment-thread.css"; link.dataset.commentThreadCss = ""; document.head.append(link);
}
function actorOf(board) {
  const a = board.feedback?.actor;
  return a && a.id ? {id:a.id, label:a.label || "You", kind:"human"} : {id:"human-local", label:"You", kind:"human"};
}
const when = iso => {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(undefined, {month:"short", day:"numeric"});
};
const avatar = author => author?.kind === "agent"
  ? `<span class="ct-avatar agent" title="${esc(author.label)} (agent)">${ICON.agent}</span>`
  : `<span class="ct-avatar" title="${esc(author?.label || "")}">${esc((author?.label || "?").trim()[0] || "?").toUpperCase()}</span>`;
const sameActor = (a, b) => !!a && !!b && a.id === b.id && (a.kind || "human") === (b.kind || "human");

// Drafts survive Escape, closing and reloading the tab (session only).
function draftStore(board) { return `tinka/${board.config?.workspaceId || "local"}/comment-card-drafts`; }
function readDrafts(board) { try { return JSON.parse(sessionStorage.getItem(draftStore(board)) || "{}") || {}; } catch { return {}; } }
function saveDraft(board, key, value) {
  const all = readDrafts(board);
  if (value && (value.text || value.refs?.length)) all[key] = {...value, at:Date.now()}; else delete all[key];
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30);
  try { sessionStorage.setItem(draftStore(board), JSON.stringify(Object.fromEntries(keep))); } catch {}
}

// What the comment is on, as a ref (for "On …" and revealing it) and a label.
function targetOf(board, thread) {
  const a = thread.anchor || {}, snap = board.snapshot || {}, boardId = thread.boardId || snap.id;
  if (!thread.id && thread.targetLabel) { const t = targetOf(board, {...thread, targetLabel:undefined, id:"draft"}); return {...t, label:thread.targetLabel, ref:t.ref && {...t.ref, label:thread.targetLabel}}; }
  if (a.placementId) {
    const p = snap.placements?.find(x => x.id === a.placementId && !x.removedAt), item = p && snap.items?.[p.itemId];
    return {ref:{kind:"placement", id:a.placementId, boardId, label:thread.targetLabel || itemLabel(item)}, label:item ? itemLabel(item) : thread.targetLabel || "an item", gone:!p};
  }
  if (a.decorationId) {
    const d = snap.decorations?.find(x => x.id === a.decorationId);
    return {ref:{kind:"decoration", id:a.decorationId, boardId, label:thread.targetLabel || decorationLabel(d)}, label:d ? (thread.targetLabel || decorationLabel(d)) : thread.targetLabel || "a drawn element", gone:!d};
  }
  if (thread.itemId) {
    const item = snap.items?.[thread.itemId];
    return {ref:{kind:"item", id:thread.itemId, boardId, label:thread.targetLabel || itemLabel(item)}, label:item ? itemLabel(item) : thread.targetLabel || "an item", gone:!item};
  }
  return {ref:null, label:"the board", gone:false};
}

// Where the pin is on screen. A rect with no size is a point where a pin sits (the pin is
// drawn up and to the right of its point), so it grows to the pin's footprint.
function pinBox(rect) {
  if (!rect) return null;
  const left = rect.left ?? rect.x, top = rect.top ?? rect.y, w = rect.width ?? (rect.right - left) ?? 0, h = rect.height ?? (rect.bottom - top) ?? 0;
  if (![left, top].every(Number.isFinite)) return null;
  if (!w && !h && !left && !top) return null; // an element that is not laid out reports all zeros
  if (w < 4 && h < 4) return {left:left - 8, right:left + 32, top:top - 36, bottom:top + 6};
  return {left, top, right:left + w, bottom:top + h};
}
// The live rect of the card's pin on the board, or of its target or point when no pin shows.
function livePin(thread) {
  const id = thread?.id;
  const pin = id && document.querySelector(`.comment-pins [data-comment-pin="${CSS.escape(id)}"]`);
  const box = pin && pinBox(pin.getBoundingClientRect());
  return box && box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight ? box : null;
}
function liveRect(board, thread, anchor) {
  const a = thread?.anchor || anchor || {};
  const target = a.placementId ? document.querySelector(`#world [data-placement="${CSS.escape(a.placementId)}"]`)
    : a.decorationId ? document.querySelector(`#world [data-decoration="${CSS.escape(a.decorationId)}"]`) : null;
  const targetBox = target && pinBox(target.getBoundingClientRect());
  if (targetBox) return targetBox;
  // A point on the board: canvas units to screen through the world's position and zoom.
  const world = document.getElementById("world"), zoom = board.hooks?.zoom?.();
  if (a.kind === "point" && Number.isFinite(a.x) && Number.isFinite(a.y) && world && zoom) {
    const w = world.getBoundingClientRect(), o = board.origin || {x:0, y:0};
    return pinBox({left:w.left + (a.x + o.x) * zoom, top:w.top + (a.y + o.y) * zoom, width:0, height:0});
  }
  return null;
}
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
/** Beside the pin: right, then left, below, above; the first side with room, never over the pin. */
function place(card, rect) {
  if (innerWidth <= 760) { card.classList.add("ct-sheet"); card.style.left = card.style.top = ""; return; }
  card.classList.remove("ct-sheet");
  const width = card.offsetWidth || 340, height = card.offsetHeight || 300, gap = 12, m = 8, minTop = 60, maxBottom = innerHeight - 12;
  const pin = pinBox(rect);
  if (!pin) { card.style.left = `${Math.round(innerWidth - width - 16)}px`; card.style.top = `${minTop + 12}px`; return; }
  const clampX = x => Math.max(m, Math.min(innerWidth - width - m, x)), clampY = y => Math.max(minTop, Math.min(maxBottom - height, y));
  const midY = clampY(pin.top - 40), midX = clampX(pin.left - 24);
  const sides = [
    {room:innerWidth - m - (pin.right + gap), need:width, left:pin.right + gap, top:midY},
    {room:pin.left - gap - m, need:width, left:pin.left - gap - width, top:midY},
    {room:maxBottom - (pin.bottom + gap), need:height, left:midX, top:pin.bottom + gap},
    {room:pin.top - gap - minTop, need:height, left:midX, top:pin.top - gap - height},
  ];
  let pick = sides.find(side => side.room >= side.need);
  if (!pick) pick = [...sides].sort((a, b) => b.room / b.need - a.room / a.need)[0];
  let left = clampX(pick.left), top = clampY(pick.top);
  // Clamping must not slide the card back over the pin.
  if (overlaps({left, top, right:left + width, bottom:top + height}, pin)) {
    if (pick === sides[0] || pick === sides[1]) top = pin.bottom + gap + height <= maxBottom ? pin.bottom + gap : Math.max(minTop, pin.top - gap - height);
    else left = pin.right + gap + width <= innerWidth - m ? pin.right + gap : Math.max(m, pin.left - gap - width);
  }
  card.style.left = `${Math.round(left)}px`; card.style.top = `${Math.round(top)}px`;
}

/** Close the open card (its draft is kept). */
export function closeThreadCard() { current?.close(false); }

/** Open a thread's card beside `anchorRect` (the pin's client rect). Resolves when it closes. */
export function openThreadCard(board, threadId, anchorRect) {
  return showCard(board, {threadId, anchorRect});
}
/** The composer for a new comment at `anchor` (an API anchor). Resolves with the posted
 *  thread's ID, or null when closed without posting. */
export function createThread(board, anchor, anchorRect, {itemId, targetLabel} = {}) {
  // Resolves as soon as the comment is posted (the card stays open on the new thread), or with
  // null when the composer closes first.
  return new Promise(resolve => { showCard(board, {anchor, anchorRect, itemId, targetLabel, onCreated:resolve}).then(result => resolve(result?.created || null)); });
}

function showCard(board, {threadId = null, anchor = null, anchorRect = null, itemId = null, targetLabel = null, onCreated = null}) {
  current?.close(false);
  ensureStyle();
  const actor = actorOf(board);
  const card = document.createElement("section");
  card.className = "ct-card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-label", threadId ? "Comment thread" : "New comment");
  card.dataset.commentCard = threadId || "new";
  document.body.append(card);
  let thread = null, closed = false, settle, created = null, editing = null, confirmDelete = null, picker = null, rect = anchorRect, busy = false;
  const done = new Promise(resolve => { settle = resolve; });
  const draftKey = () => thread ? `thread:${thread.id}` : `new:${board.snapshot?.id}:${JSON.stringify(anchor || {})}:${itemId || ""}`;
  let composer = null;
  // The pin's rect as given, or (when none, or not laid out) the live pin or target on the board.
  const currentRect = () => { const t = thread || (threadId ? {id:threadId} : null); return livePin(t) || pinBox(rect) || liveRect(board, t, anchor); };
  // Opened from a list or a link, the board may still be panning to the pin: follow it until it
  // stops moving (a few frames), then stay put.
  let settling = 0;
  function settlePlace() {
    const run = ++settling; let last = "", still = 0, frames = 0;
    const step = () => {
      if (closed || run !== settling) return;
      const r = currentRect(), key = r ? `${Math.round(r.left)},${Math.round(r.top)}` : "none";
      place(card, r);
      still = key === last ? still + 1 : 0; last = key;
      if (still < 3 && ++frames < 90) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const persist = () => { if (composer) saveDraft(board, draftKey(), composerValue(composer)); };

  async function load() {
    const params = new URLSearchParams({threadId, includeBodies:"true"});
    const data = await board.client.get(`/api/feedback?${params}`);
    if (Number.isSafeInteger(data.revision)) board.client.revision = Math.max(board.client.revision || 0, data.revision);
    thread = data.threads?.[0] || null;
    if (!thread) throw new Error("This comment is no longer available.");
  }
  async function write(type, data) {
    if (busy) return null; busy = true; card.setAttribute("aria-busy", "true");
    try {
      // Thread writes touch only this thread: a revision that moved on elsewhere (an agent
      // working on the board) is not a conflict, so retry once at the latest revision.
      const operationId = crypto.randomUUID();
      let result;
      try { result = await board.client.write(type, data, {operationId}); }
      catch (error) {
        if (error.code !== "WORKSPACE_REVISION_CHANGED" || !Number.isSafeInteger(error.revision)) throw error;
        board.client.revision = Math.max(board.client.revision || 0, error.revision);
        result = await board.client.write(type, data, {operationId});
      }
      board.onCommentsChanged?.(); board.feedback?.reload?.().catch?.(() => {});
      return result || {};
    } catch (error) { status(error.message, true); return null; }
    finally { busy = false; card.removeAttribute("aria-busy"); }
  }
  function status(message, error = false) { const el = card.querySelector(".ct-status"); if (el) { el.textContent = message; el.setAttribute("role", error ? "alert" : "status"); } }

  function messageHTML(m, root) {
    const own = sameActor(m.author, actor) && !m.deletedAt;
    const tools = own && !editing ? `<span class="ct-msg-tools"><button type="button" class="ct-link" data-act="edit" data-id="${esc(m.id)}">Edit</button><button type="button" class="ct-link" data-act="delete" data-id="${esc(m.id)}">Delete</button></span>` : "";
    const confirm = confirmDelete === m.id ? `<div class="ct-confirm" role="alert">Delete this ${root ? "comment" : "reply"}? <button type="button" class="tk-btn tk-sm ct-danger" data-act="delete-yes" data-id="${esc(m.id)}">Delete</button><button type="button" class="tk-btn tk-sm" data-act="delete-no">Keep</button></div>` : "";
    return `<article class="ct-msg ${m.author?.kind === "agent" ? "ct-agent" : "ct-human"} ${m.deletedAt ? "ct-deleted" : ""}" data-msg="${esc(m.id)}">${avatar(m.author)}<div class="ct-msg-main">
      <div class="ct-msg-head"><span class="ct-who">${esc(m.author?.label || "Someone")}</span>${m.author?.kind === "agent" ? '<span class="ct-agent-tag">Agent</span>' : ""}<time datetime="${esc(m.createdAt)}">${esc(when(m.createdAt))}</time>${m.editedAt && !m.deletedAt ? '<span class="ct-edited">edited</span>' : ""}${tools}</div>
      <div class="ct-body" data-body="${esc(m.id)}"></div>${m.changes?.length ? `<div class="ct-changes" data-changes="${esc(m.id)}"><span>Changed</span></div>` : ""}${confirm}</div></article>`;
  }
  function render() {
    if (closed) return;
    picker?.close(); persist();
    const isNew = !thread, st = thread?.status || (thread?.resolved ? "resolved" : "open");
    const target = thread ? targetOf(board, thread) : targetOf(board, {anchor, itemId, targetLabel, boardId:board.snapshot?.id});
    const on = target.gone ? `Was on <b>${esc(target.label)}</b> · deleted` : target.ref ? `On <button type="button" class="ct-on-target" data-act="target">${esc(target.label)}</button>` : "On the board";
    const last = thread?.statusHistory?.at(-1);
    const VERB = {open:"reopened it", sent:"sent it to the agent", working:"is working on it", addressed:"addressed it", question:"asked you", resolved:"resolved it"};
    const activity = last && last.actor && (thread.statusHistory.length > 1 || last.status !== "open") ? `<p class="ct-activity">${esc(last.actor.label)} ${esc(VERB[last.status] || last.status)} · ${esc(when(last.at))}${last.note ? ` — ${esc(last.note)}` : ""}</p>` : "";
    const messages = thread ? [{...thread, id:thread.id, root:true}, ...(thread.replies || [])].filter(m => !m.deletedAt || m.root) : [];
    const addressedMine = st === "addressed" || st === "question";
    const decide = st === "addressed" ? `<div class="ct-decide"><button type="button" class="tk-btn tk-sm tk-primary" data-act="looks-good">${ICON.check}<span>Looks good · Resolve</span></button><button type="button" class="tk-btn tk-sm" data-act="not-yet">Not yet</button></div>` : "";
    const forAgent = isNew ? `<label class="ct-for-agent"><input type="checkbox" data-for-agent ${anchor?.forAgent === false ? "" : "checked"}> For the agent</label>` : "";
    card.dataset.status = isNew ? "draft" : st;
    card.innerHTML = `<header class="ct-head">${isNew ? '<b class="ct-title">New comment</b>' : `<span class="ct-state" data-state="${esc(st)}">${esc(STATUS[st] || st)}</span>`}
        ${!isNew ? `<button type="button" class="tk-btn tk-icon ct-icon" data-act="toggle" aria-label="${st === "resolved" ? "Reopen" : "Resolve"}" title="${st === "resolved" ? "Reopen" : "Resolve"}">${st === "resolved" ? ICON.reopen : ICON.check}</button>` : ""}
        <button type="button" class="tk-btn tk-icon ct-icon" data-act="close" aria-label="Close" title="Close (Esc)">${ICON.close}</button>
        <span class="ct-on">${on}</span></header>
      <div class="ct-scroll">${target.gone ? '<p class="ct-detached">The thing this was pinned to is gone. The pin stays where it was.</p>' : ""}${activity}${messages.map(m => messageHTML(m, !!m.root)).join("")}${decide}</div>
      <footer class="ct-foot"><div class="ct-composer" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${isNew ? "Comment" : "Reply"}" data-placeholder="${isNew ? "Comment… type @ to reference" : addressedMine ? "Reply… goes back to the agent" : "Reply… @ to reference"}"></div>
        <div class="ct-row"><span class="ct-hint ct-keys">${MOD}↵ to post</span><span class="ct-status" role="status"></span>${forAgent}<button type="button" class="tk-btn tk-sm tk-primary" data-act="post">${isNew ? "Comment" : "Reply"}</button></div></footer>`;
    // bodies and chips (DOM, never HTML from the server)
    for (const m of messages) {
      const body = card.querySelector(`[data-body="${CSS.escape(m.id)}"]`);
      if (editing === m.id) {
        const box = document.createElement("div"); box.className = "ct-composer ct-edit"; box.contentEditable = "true"; box.setAttribute("role", "textbox"); box.setAttribute("aria-label", "Edit message");
        setComposerValue(box, board, m.body, m.refs || []); body.replaceWith(box);
        const row = document.createElement("div"); row.className = "ct-row"; row.innerHTML = `<span class="ct-hint ct-keys">${MOD}↵ saves · Esc cancels</span><button type="button" class="tk-btn tk-sm" data-act="edit-cancel">Cancel</button><button type="button" class="tk-btn tk-sm tk-primary" data-act="edit-save" data-id="${esc(m.id)}">Save</button>`;
        box.after(row); attachPicker(box, board); continue;
      }
      if (m.deletedAt) { body.innerHTML = '<span class="ct-gone">Comment deleted</span>'; continue; }
      body.append(renderBody(board, m.body, m.refs || []));
      const ch = card.querySelector(`[data-changes="${CSS.escape(m.id)}"]`);
      if (ch) for (const c of m.changes) ch.append(chipElement({...c, label:chipLabel(board, c)}, {state:refState(board, c)}));
    }
    composer = card.querySelector(".ct-composer:not(.ct-edit)");
    const saved = readDrafts(board)[draftKey()];
    if (saved) setComposerValue(composer, board, saved.text, saved.refs);
    picker = attachPicker(composer, board, {onChange:persist});
    composer.addEventListener("input", persist);
    settlePlace();
  }
  async function post() {
    if (busy || composerEmpty(composer)) return;
    const {text, refs} = composerValue(composer);
    if (!thread) {
      const forAgent = card.querySelector("[data-for-agent]")?.checked;
      const target = targetOf(board, {anchor, itemId, targetLabel, boardId:board.snapshot?.id});
      const result = await write("addComment", {boardId:board.snapshot.id, ...(itemId ? {itemId} : {}), ...(anchor ? {anchor:cleanAnchor(anchor)} : {}),
        author:actor, body:text, refs, ...(forAgent ? {to:{kind:"agent"}} : {}), ...(targetLabel ? {targetLabel:String(targetLabel).slice(0, 120)} : target.ref && anchor?.decorationId ? {targetLabel:target.label.slice(0, 120)} : {})});
      if (!result) return;
      saveDraft(board, draftKey(), null);
      threadId = created = result.threadId || result.result?.threadId;
      card.dataset.commentCard = threadId; card.setAttribute("aria-label", "Comment thread");
      onCreated?.(threadId);
    } else {
      const result = await write("replyComment", {threadId:thread.id, author:actor, body:text, refs});
      if (!result) return;
      saveDraft(board, draftKey(), null);
    }
    composer.replaceChildren();
    await reload(); composer?.focus();
  }
  async function reload() { try { await load(); render(); } catch (error) { status(error.message, true); } }
  async function setStatus(statusValue) {
    const result = await write("setCommentStatus", {threadId:thread.id, actor, status:statusValue});
    if (result) await reload();
    return result;
  }

  card.addEventListener("click", async event => {
    const button = event.target.closest("[data-act]"); if (!button) return;
    const act = button.dataset.act, id = button.dataset.id;
    if (act === "close") return close(false);
    if (act === "post") return post();
    if (act === "target") { const t = targetOf(board, thread || {anchor, itemId, boardId:board.snapshot?.id}); if (t.ref) board.revealRef?.(t.ref); return; }
    if (act === "toggle") { await setStatus(card.dataset.status === "resolved" ? "open" : "resolved"); return; }
    if (act === "looks-good") { await setStatus("resolved"); return; }
    if (act === "not-yet") { await setStatus("open"); composer?.focus(); return; }
    if (act === "edit") { editing = id; confirmDelete = null; render(); const box = card.querySelector(".ct-edit"); box?.focus(); caretToEnd(box); return; }
    if (act === "edit-cancel") { editing = null; render(); return; }
    if (act === "edit-save") return saveEdit(id);
    if (act === "delete") { confirmDelete = id; editing = null; render(); card.querySelector('[data-act="delete-yes"]')?.focus(); return; }
    if (act === "delete-no") { confirmDelete = null; render(); return; }
    if (act === "delete-yes") {
      const result = await write("deleteComment", {threadId:thread.id, ...(id !== thread.id ? {messageId:id} : {}), actor});
      if (!result) return;
      confirmDelete = null;
      if ((result.threadDeleted ?? result.result?.threadDeleted)) return close(false);
      await reload();
    }
  });
  async function saveEdit(id) {
    const box = card.querySelector(".ct-edit"); if (!box || composerEmpty(box)) return;
    const {text, refs} = composerValue(box);
    const result = await write("editComment", {threadId:thread.id, ...(id !== thread.id ? {messageId:id} : {}), actor, body:text, refs});
    if (!result) return;
    editing = null; await reload();
  }
  // Keys: ⌘↵ posts or saves, Escape cancels an edit or closes the card (keeping the draft).
  // Nothing typed here reaches the board's shortcuts.
  card.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.isComposing) return;
    const inEdit = event.target.closest?.(".ct-edit");
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (inEdit) saveEdit(editing); else if (event.target.closest?.(".ct-composer")) post(); return; }
    if (event.key === "Escape") {
      event.preventDefault();
      if (inEdit) { editing = null; render(); composer?.focus(); return; }
      if (confirmDelete) { confirmDelete = null; render(); return; }
      close(false);
    }
  });
  for (const type of ["keyup", "keypress"]) card.addEventListener(type, event => event.stopPropagation());
  card.addEventListener("paste", event => {
    const target = event.target.closest?.(".ct-composer"); if (!target) return;
    event.preventDefault(); event.stopPropagation();
    document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") || "");
  });
  for (const type of ["copy", "cut"]) card.addEventListener(type, event => event.stopPropagation());
  bindChips(card, board);
  // A press outside closes the card (the draft stays); pins and the palette open their own.
  const outside = event => { if (!card.contains(event.target) && !event.target.closest?.(".cref-picker")) close(false); };
  const onResize = () => place(card, currentRect());
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  addEventListener("resize", onResize);

  function close() {
    if (closed) return; closed = true;
    persist(); picker?.close();
    document.removeEventListener("pointerdown", outside, true); removeEventListener("resize", onResize);
    card.remove(); if (current?.card === card) current = null;
    settle({created, threadId});
  }
  current = {card, close, move(next) { rect = next; place(card, currentRect()); }, get threadId() { return threadId; }};

  if (threadId) {
    card.innerHTML = '<p class="ct-loading">Loading comment…</p>'; place(card, currentRect());
    load().then(() => { render(); composer?.focus({preventScroll:true}); }).catch(error => { card.innerHTML = `<p class="ct-loading" role="alert">${esc(error.message)}</p>`; });
  } else { render(); composer.focus({preventScroll:true}); }
  return done;
}
/** Keep the open card beside its pin as the board pans or zooms. */
export function moveThreadCard(anchorRect) { current?.move(anchorRect); }
export function openThreadId() { return current?.threadId || null; }

function cleanAnchor(anchor) { const {forAgent, ...rest} = anchor || {}; return rest; }
function caretToEnd(el) { if (!el) return; const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
