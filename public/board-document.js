// Board-authored Markdown documents: create a .md-backed item on the board and
// edit it in a split source/preview dialog. Server routes: POST /api/documents,
// PUT /api/documents/:itemId (lib/documents.mjs).
import {parseMarkdown,renderMarkdownDocument} from "./markdown-document.js";
import {toast} from "./workspace.js";

const DEFAULT_TITLE = "Untitled";
const STARTER = `# ${DEFAULT_TITLE}\n\n`;
// First non-empty line with leading #s stripped; used only while the title is still the default.
const titleFrom = text => (text.split("\n").find(line => line.trim()) || "").replace(/^\s*#+\s*/, "").trim().slice(0, 200);
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
  await editBoardDocument(board, itemId, {text:STARTER, resource:data.result.resources?.[0], fresh:true});
  return itemId;
}

function documentItem(board, itemId) {
  const items = board.snapshot?.items || {};
  return Array.isArray(items) ? items.find(item => item.id === itemId) : items[itemId];
}
const resourcePath = resource => `/resources/${encodeURIComponent(resource.rootId)}/${resource.path.split("/").map(encodeURIComponent).join("/")}`;

/** Edit an existing local Markdown document item. Resolves true when saved, false when cancelled. */
export async function editBoardDocument(board, itemId, {text, resource, fresh = false} = {}) {
  const item = documentItem(board, itemId);
  resource ||= item?.content?.resource;
  if (!resource || (item && item.content?.kind !== "markdown")) { toast("Only local Markdown documents can be edited here."); return false; }
  if (text === undefined) {
    try {
      const response = await fetch(resourcePath(resource), {cache:"no-store"});
      if (!response.ok) throw new Error(`Could not read the document (${response.status}).`);
      text = await response.text();
    } catch (error) { toast(error.message); return false; }
  }
  injectStyle();
  const dialog = document.createElement("dialog");
  dialog.className = "tinka-doc-editor";
  dialog.setAttribute("aria-label", "Edit document");
  dialog.innerHTML = `<form method="dialog" class="tinka-doc-shell">
    <header><strong>${fresh ? "New document" : "Edit document"}</strong><span class="tinka-doc-hint">⌘/Ctrl-Enter to save · Esc to cancel</span>
      <button type="button" data-act="cancel">Cancel</button><button type="submit" data-act="done" class="primary">Done</button></header>
    <div class="tinka-doc-panes"><textarea spellcheck="true" aria-label="Markdown source"></textarea><div class="tinka-doc-preview" aria-label="Preview"></div></div>
  </form>`;
  const area = dialog.querySelector("textarea"), preview = dialog.querySelector(".tinka-doc-preview"), done = dialog.querySelector("[data-act=done]");
  area.value = text;
  const assets = {baseUrl:new URL(resourcePath(resource), location.href), origin:location.origin, resourcePrefix:`/resources/${encodeURIComponent(resource.rootId)}/`};
  let frame = 0;
  const render = () => { frame = 0; preview.replaceChildren(renderMarkdownDocument(document, parseMarkdown(area.value), assets)); };
  area.addEventListener("input", () => { if (!frame) frame = requestAnimationFrame(render); });
  render();
  document.body.append(dialog);
  // Keep board shortcuts (Delete, D, arrows) from firing while typing.
  dialog.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); if (!saving) close(false); }
  });
  let settle;
  const finished = new Promise(resolve => { settle = resolve; });
  let saving = false;
  async function save() {
    if (saving) return;
    if (area.value === text && !fresh) { close(false); return; }
    saving = true; done.disabled = true; done.textContent = "Saving…";
    try {
      await json(await fetch(`/api/documents/${encodeURIComponent(itemId)}`, {method:"PUT", headers:headers(board), body:JSON.stringify({text:area.value})}));
      close(true);
      const title = titleFrom(area.value), current = documentItem(board, itemId)?.title ?? (fresh ? DEFAULT_TITLE : null);
      if (title && current === DEFAULT_TITLE && title !== current) {
        try { await board.client.write("updateItem", {itemId, patch:{title}}); } catch (error) { toast(`Saved, but the title was not updated. ${error.message}`); }
      }
      try { await board.refresh({saveReview:false}); } catch {}
      reloadCards(resource);
    } catch (error) {
      saving = false; done.disabled = false; done.textContent = "Done";
      toast(`Document not saved. ${error.message}`);
    }
  }
  function close(saved) { if (!dialog.isConnected) return; dialog.remove(); settle(saved); }
  dialog.querySelector("form").addEventListener("submit", e => { e.preventDefault(); save(); });
  dialog.querySelector("[data-act=cancel]").addEventListener("click", () => close(false));
  dialog.addEventListener("cancel", e => { e.preventDefault(); if (!saving) close(false); });
  dialog.addEventListener("close", () => close(false));
  dialog.showModal();
  area.focus();
  if (fresh) area.setSelectionRange(2, 10); // select "Untitled" so typing replaces it
  else area.setSelectionRange(area.value.length, area.value.length);
  return finished;
}

// Live updates may already hold the saved revision (they wait while the editor has focus),
// so reload this document's card frames directly.
function reloadCards(resource) {
  for (const frame of document.querySelectorAll("iframe")) {
    let source;
    try { source = new URL(frame.getAttribute("src") || "", location.href); } catch { continue; }
    if (source.pathname !== "/app/media.html" || source.searchParams.get("kind") !== "markdown" ||
        source.searchParams.get("root") !== resource.rootId || source.searchParams.get("path") !== resource.path) continue;
    source.searchParams.set("v", `edit-${Date.now()}`);
    frame.src = source.href;
  }
}

function injectStyle() {
  if (document.getElementById("tinka-doc-editor-style")) return;
  const style = document.createElement("style");
  style.id = "tinka-doc-editor-style";
  style.textContent = `
.tinka-doc-editor{width:min(1200px,calc(100vw - 48px));height:min(800px,calc(100vh - 48px));max-width:none;max-height:none;padding:0;border:1px solid var(--line-strong,#ccc);border-radius:var(--r-lg,12px);background:var(--card,#fff);color:var(--ink,#222);box-shadow:0 24px 80px rgba(0,0,0,.25)}
.tinka-doc-editor::backdrop{background:rgba(0,0,0,.3)}
.tinka-doc-shell{display:flex;flex-direction:column;height:100%;margin:0}
.tinka-doc-shell header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line,#ddd);font:14px var(--font-ui,system-ui)}
.tinka-doc-hint{flex:1;color:var(--muted,#777);font-size:12px}
.tinka-doc-shell button{height:var(--control-h-sm,30px);padding:0 14px;border:1px solid var(--control-line,#ccc);border-radius:var(--r-pill,99px);background:var(--field,#fff);color:inherit;font:inherit;cursor:pointer}
.tinka-doc-shell button.primary{background:var(--accent,#2b6);border-color:var(--accent,#2b6);color:var(--on-accent,#fff)}
.tinka-doc-panes{flex:1;display:grid;grid-template-columns:1fr 1fr;min-height:0}
.tinka-doc-panes textarea{resize:none;border:0;border-right:1px solid var(--line,#ddd);padding:18px;background:var(--field,#fff);color:inherit;font:14px/1.6 var(--font-mono,ui-monospace,monospace);outline:none}
.tinka-doc-preview{overflow:auto;padding:18px 28px;font:16px/1.65 Georgia,"Times New Roman",serif}
.tinka-doc-preview .markdown h1,.tinka-doc-preview .markdown h2,.tinka-doc-preview .markdown h3{font-weight:400;line-height:1.2}
.tinka-doc-preview .markdown h1{font-size:2em;margin:0 0 .6em}
.tinka-doc-preview .markdown pre{overflow:auto;padding:10px;background:var(--hover,#f3f3f3);border-radius:6px}
.tinka-doc-preview .markdown img{max-width:100%}
.tinka-doc-preview .markdown table{border-collapse:collapse}.tinka-doc-preview .markdown td,.tinka-doc-preview .markdown th{border:1px solid var(--line,#ddd);padding:4px 8px}
@media (max-width:700px){.tinka-doc-panes{grid-template-columns:1fr;grid-template-rows:1fr 1fr}.tinka-doc-panes textarea{border-right:0;border-bottom:1px solid var(--line,#ddd)}}`;
  document.head.append(style);
}
