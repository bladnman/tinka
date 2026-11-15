// Board-authored Markdown documents: create a .md-backed item on the board, and edit any local
// Markdown document in place on its card. The card's own page (media.html) does the editing
// (document-editor.js) and saves through PUT /api/documents/:itemId; this side starts and ends
// it, shows a small Saving/Saved hint, and applies the auto title. No modal, no toolbar.
import {toast} from "./workspace.js";

const DEFAULT_TITLE = "Untitled";
const STARTER = `# ${DEFAULT_TITLE}\n\n`;
const SIZE = {width:360, height:460};

function headers(board) { return {"Content-Type":"application/json","x-tinka-workspace":board.config.workspaceId}; }
async function json(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; error.data = data; throw error; }
  return data;
}
// Serialize behind the board's write queue so revisions stay ordered.
function queued(board, task) {
  const client = board.client;
  client.pendingWrites++; client.onState?.();
  const pending = client.queue.catch(() => {}).then(task).finally(() => { client.pendingWrites--; client.onState?.(); client.onSettled?.(); });
  client.queue = pending;
  return pending;
}

/** Create an "Untitled" Markdown document at a SCREEN point (or the viewport centre) and open the editor. */
export async function createBoardDocument(board, point) {
  if (board.mode && board.mode !== "canvas") board.setMode?.("canvas");
  const at = board.canvasPoint(point);
  const targetPosition = {x:Math.round(at.x - SIZE.width / 2), y:Math.round(at.y - 40)};
  const operationId = crypto.randomUUID();
  let data;
  try {
    data = await queued(board, async () => {
      for (let attempt = 0; ; attempt++) {
        const body = {workspaceId:board.snapshot.workspaceId, targetBoardId:board.snapshot.id, targetPosition,
          expectedRevision:board.client.revision, operationId, title:"Untitled", text:STARTER, ...SIZE};
        try {
          const result = await json(await fetch("/api/documents", {method:"POST", headers:headers(board), body:JSON.stringify(body)}));
          board.client.revision = result.revision;
          return result;
        } catch (error) {
          // Same operation ID, so a revision-only retry cannot duplicate the document.
          if (attempt === 0 && error.data?.code === "WORKSPACE_REVISION_CHANGED" && Number.isSafeInteger(error.data.revision)) { board.client.revision = error.data.revision; continue; }
          throw error;
        }
      }
    });
  } catch (error) { toast(`Document not created. ${error.message}`); return null; }
  if (data.history) board.history?.record(data.history, {type:"pastePlacements", data:{placementIds:data.result.placementIds}}, operationId);
  board.selection = new Set(data.result.placementIds || []);
  try { await board.refresh({saveReview:false}); } catch {}
  board.hooks?.revealPlacements?.(board.snapshot.placements.filter(p => board.selection.has(p.id)));
  const itemId = data.result.itemIds[0];
  await editBoardDocument(board, itemId, {selectTitle:true, placementId:data.result.placementIds?.[0]});
  return itemId;
}

function documentItem(board, itemId) {
  const items = board.snapshot?.items || {};
  return Array.isArray(items) ? items.find(item => item.id === itemId) : items[itemId];
}
const resourcePath = resource => `/resources/${encodeURIComponent(resource.rootId)}/${resource.path.split("/").map(encodeURIComponent).join("/")}`;

// ---------- in-place editing on a card ----------
const editing = new WeakMap(); // board -> session
const frameOf = card => card?.querySelector(".workspace-live-preview iframe");
function cardFor(board, itemId, placementId) {
  const world = document.getElementById("world"); if (!world) return null;
  const cards = [...world.querySelectorAll(".workspace-card[data-placement]")];
  const shows = card => board.snapshot.placements.find(p => p.id === card.dataset.placement)?.itemId === itemId && frameOf(card);
  return cards.find(card => card.dataset.placement === placementId && shows(card)) ||
    cards.find(card => board.selection?.has(card.dataset.placement) && shows(card)) || cards.find(shows) || null;
}
// A client point on the card becomes a point in the frame's own coordinates (canvas zoom included).
function framePoint(frame, point) {
  if (!point) return null;
  const rect = frame.getBoundingClientRect(), scale = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
  return {x:(point.x - rect.left) / scale, y:(point.y - rect.top) / scale};
}

/** Start editing a document in place on its card. `options.point` is a client point (caret goes
 *  there), `source` opens the Markdown source, `selectTitle` selects the first heading. Resolves
 *  when editing has started (true) or could not start (false). */
export async function editBoardDocument(board, itemId, options = {}) {
  const item = documentItem(board, itemId);
  if (!item || item.content?.kind !== "markdown" || !item.content.resource || item.content.url) { toast("Only local Markdown documents can be edited here."); return false; }
  const active = editing.get(board);
  if (active && active.itemId === itemId && !options.source) { active.frame.focus(); return true; }
  if (active) await stopEditing(board);
  if (board.mode !== "canvas" && board.mode !== "grid") board.setMode?.("canvas");
  let card = cardFor(board, itemId, options.placementId);
  if (!card) { await new Promise(r => setTimeout(r, 150)); card = cardFor(board, itemId, options.placementId); }
  if (!card) { toast("Show this document as a card or full preview to edit it on the board, or open it and choose Edit."); return false; }
  injectStyle(); install(board);
  const frame = frameOf(card);
  const session = {board, itemId, item, placementId:card.dataset.placement, frame, started:false, state:"idle"};
  editing.set(board, session);
  board.documentEditing = session;
  apply(session);
  frame.focus();
  // The frame may still be loading (a new card): repeat the request until it is acknowledged.
  const request = {type:"tinka-document-edit", itemId, point:framePoint(frame, options.point), source:!!options.source, selectTitle:!!options.selectTitle};
  for (let tries = 0; tries < 50 && !session.started && editing.get(board) === session; tries++) {
    try { frame.contentWindow?.postMessage(request, location.origin); } catch {}
    await new Promise(r => setTimeout(r, tries < 5 ? 60 : 200));
  }
  if (!session.started && editing.get(board) === session) { finish(board, session, {}); toast("The document could not be opened for editing."); return false; }
  return true;
}
/** End in-place editing on this board (saves first). */
export function stopEditing(board) {
  const session = editing.get(board); if (!session) return Promise.resolve();
  return new Promise(resolve => {
    session.done = resolve;
    try { session.frame.contentWindow?.postMessage({type:"tinka-document-edit-stop"}, location.origin); } catch {}
    setTimeout(() => { if (editing.get(board) === session) finish(board, session, {}); }, 4000);
  });
}
// Board re-renders reset card attributes; re-apply the editing state after each one.
export function reapplyEditing(board) { const session = editing.get(board); if (session) { const card = currentCard(session); if (card) { session.frame = frameOf(card) || session.frame; apply(session); } } }
const currentCard = session => document.querySelector(`#world .workspace-card[data-placement="${CSS.escape(session.placementId)}"]`);
function apply(session) {
  const card = currentCard(session); if (!card) return;
  card.classList.add("doc-editing");
  session.frame.removeAttribute("inert"); session.frame.tabIndex = 0;
  let hint = card.querySelector(".doc-edit-state");
  if (!hint) { hint = document.createElement("span"); hint.className = "doc-edit-state"; hint.setAttribute("role", "status"); hint.setAttribute("aria-live", "polite"); card.querySelector(".workspace-card-preview")?.append(hint); }
  const labels = {editing:"Editing", saving:"Saving…", saved:"Saved", error:"Not saved", conflict:"Changed elsewhere", idle:"Editing"};
  hint.textContent = labels[session.state] || "Editing"; hint.dataset.state = session.state;
  if (session.message) hint.title = session.message; else hint.removeAttribute("title");
}
function finish(board, session, result) {
  if (editing.get(board) !== session) return;
  editing.delete(board); board.documentEditing = null;
  const card = currentCard(session);
  card?.classList.remove("doc-editing"); card?.querySelector(".doc-edit-state")?.remove();
  session.frame.setAttribute("inert", ""); session.frame.tabIndex = -1;
  session.done?.();
  afterEdit(board, session.itemId, result, session.frame);
}
// After a save: title from the first heading while it is still the default, then the board and
// any other card or open reader of the same document catch up.
export async function afterEdit(board, itemId, result, sourceFrame) {
  if (!result?.saved) { try { await board.refresh({saveReview:false}); } catch {} return; }
  const item = documentItem(board, itemId);
  if (result.title && item?.title === DEFAULT_TITLE && result.title !== DEFAULT_TITLE) {
    try { await board.client.write("updateItem", {itemId, patch:{title:result.title}}); } catch (error) { toast(`Saved, but the title was not updated. ${error.message}`); }
  }
  try { await board.refresh({saveReview:false}); } catch {}
  if (item?.content?.resource) reloadCards(item.content.resource, sourceFrame);
}
function install(board) {
  if (board.__documentEditingInstalled) return;
  board.__documentEditingInstalled = true;
  window.addEventListener("message", event => {
    const session = editing.get(board);
    if (!session || event.origin !== location.origin || event.source !== session.frame.contentWindow) return;
    const data = event.data || {};
    if (data.itemId && data.itemId !== session.itemId) return;
    if (data.type === "tinka-document-edit-started") { if (!data.pending) session.started = true; return; }
    if (data.type === "tinka-document-status") {
      session.started = true; session.state = data.state; session.message = data.message || ""; apply(session);
      if (data.state === "saved") documentSaved(board, session.itemId, session.frame);
      return;
    }
    if (data.type === "tinka-document-edit-end") finish(board, session, data);
  });
  // Escape that reaches the board (focus outside the page) also ends editing.
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !editing.get(board) || event.isComposing) return;
    event.preventDefault(); event.stopImmediatePropagation(); stopEditing(board);
  }, true);
  // A press anywhere outside the card being edited ends editing (saved).
  document.addEventListener("pointerdown", event => {
    const session = editing.get(board); if (!session) return;
    const card = currentCard(session);
    if (card && card.contains(event.target) && !event.target.closest("[data-open],.workspace-tile-toolbar,.workspace-card-menu,[data-placement-select]")) return;
    stopEditing(board);
  }, true);
}

/** After each autosave, other cards of the same document (and an open reader) show the new text
 *  and repaint their marks; the frame doing the editing is left alone. */
export function documentSaved(board, itemId, except) {
  const resource = documentItem(board, itemId)?.content?.resource;
  if (resource) reloadCards(resource, except);
}
// Live updates may already hold the saved revision (they wait while editing), so reload the
// document's other card frames directly. The frame that edited reloads itself.
function reloadCards(resource, except) {
  for (const frame of document.querySelectorAll("iframe")) {
    if (frame === except) continue;
    let source;
    try { source = new URL(frame.getAttribute("src") || "", location.href); } catch { continue; }
    if (source.pathname !== "/app/media.html" || source.searchParams.get("kind") !== "markdown" ||
        source.searchParams.get("root") !== resource.rootId || source.searchParams.get("path") !== resource.path) continue;
    if (source.searchParams.get("mode") === "reader") { frame.contentWindow?.postMessage({type:"tinka-document-reload"}, location.origin); continue; }
    source.searchParams.set("v", `edit-${Date.now()}`);
    frame.src = source.href;
  }
}

function injectStyle() {
  if (document.getElementById("tinka-doc-editing-style")) return;
  const style = document.createElement("style");
  style.id = "tinka-doc-editing-style";
  // The card stays put; its page takes the pointer and keyboard, scrolls, and shows a quiet hint.
  style.textContent = `
#world .workspace-card.doc-editing .workspace-live-preview iframe { pointer-events:auto!important; }
#world .workspace-card.doc-editing .workspace-preview-launch { display:none!important; }
#world .workspace-card.doc-editing .workspace-tile-toolbar { display:none!important; }
#world .workspace-card.doc-editing { outline:2px solid var(--accent-ring, var(--accent)); outline-offset:1px; }
#world .workspace-card.doc-editing .workspace-card-preview { position:relative; }
#world .doc-edit-state { position:absolute; z-index:3; top:6px; right:8px; padding:2px 7px; border-radius:999px; background:color-mix(in srgb,var(--paper,#fff) 88%,transparent); color:var(--muted,#777); font:500 11px/1.5 var(--font-ui,-apple-system,BlinkMacSystemFont,sans-serif); pointer-events:none; box-shadow:0 0 0 1px var(--line,#ddd); }
#world .doc-edit-state[data-state=error],#world .doc-edit-state[data-state=conflict] { color:var(--danger,#b3261e); }`;
  document.head.append(style);
}
