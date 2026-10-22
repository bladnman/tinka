// Small shared primitives for graph workspaces; the legacy board stays independent.
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function resourceURL(ref) {
  if (
    !ref?.rootId ||
    !ref.path ||
    ref.path.split("/").some((p) => !p || p.startsWith(".") || /[\\\0]/.test(p))
  )
    return null;
  return `/resources/${encodeURIComponent(ref.rootId)}/${ref.path.split("/").map(encodeURIComponent).join("/")}`;
}
export function remoteURL(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function contentURL(item, revision) {
  const c =
    revision?.content ||
    (revision?.resource || revision?.url ? revision : item.content);
  return remoteURL(c?.url) || resourceURL(c?.resource);
}
export class WorkspaceClient {
  constructor(config, revision = 0) {
    this.config = config;
    this.revision = revision;
    this.queue = Promise.resolve();
    this.pendingWrites = 0;
  }
  async get(url) {
    const r = await fetch(url, { cache: "no-store" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  }
  importFiles(files, metadata, signal) {
    const operationId = crypto.randomUUID();
    this.pendingWrites++;
    this.onState?.();
    const pending = this.queue.catch(()=>{}).then(async()=>{
      const body = new FormData();
      body.append("metadata",JSON.stringify({...metadata,expectedRevision:this.revision,operationId}));
      for (const file of files) body.append("files",file,file.name || "Pasted image");
      const response = await fetch("/api/imports",{method:"POST",headers:{"x-tinka-workspace":this.config.workspaceId},body,signal});
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || `Import failed (${response.status}).`);
        error.conflict = response.status === 409;
        error.rejected = true;
        throw error;
      }
      this.revision = data.revision;
      if (data.history) this.onHistory?.(data.history,{type:"importFiles",data:{files}});
      return data.result;
    }).finally(()=>{this.pendingWrites--;this.onState?.();});
    this.queue = pending;
    return pending;
  }
  write(type, data = {}, {recordHistory = true,includeHistory = false,operationId = crypto.randomUUID()} = {}) {
    this.pendingWrites++;
    this.onState?.();
    const pending = this.queue
      .catch(() => {})
      .then(async () => {
        const r = await fetch("/api/operations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tinka-workspace": this.config.workspaceId,
          },
          body: JSON.stringify({
            type,
            ...data,
            expectedRevision: this.revision,
            operationId,
          }),
        });
        const d = await r.json();
        if (!r.ok) {
          const e = new Error(
            r.status === 409
              ? "This workspace changed elsewhere. Reload the board, review the latest version, then retry your change."
              : d.error || `Change failed (${r.status})`,
          );
          e.conflict = r.status === 409;
          e.rejected = r.status >= 400 && r.status < 500;
          throw e;
        }
        this.revision = Math.max(this.revision,d.revision);
        if (d.history && recordHistory && type !== "restoreMovement") this.onHistory?.(d.history,{type,data});
        return includeHistory ? {result:d.result || d,history:d.history || null,replayed:!!d.replayed} : d.result || d;
      }).finally(() => { this.pendingWrites--; this.onState?.(); });
    this.queue = pending;
    return pending;
  }
}
export function toast(message) {
  let node = document.getElementById("workspace-toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "workspace-toast";
    node.className = "workspace-toast";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(node.timer);
  node.timer = setTimeout(() => {
    node.hidden = true;
  }, 6000);
}
export function showFailure(error) {
  const d = makeDialog(
    "Change not saved",
    `<p role="alert">${escape(error.message)}</p><p>Your resource files have not been removed. A conflicting change is never silently overwritten.</p>${error.conflict ? '<button type="button" data-reload>Reload latest</button>' : ""}`,
  );
  d.querySelector("[data-reload]")?.addEventListener("click", () =>
    location.reload(),
  );
}
export function makeDialog(title, body, onSubmit) {
  const d = document.createElement("dialog");
  const titleId = "workspace-dialog-" + crypto.randomUUID();
  d.className = "workspace-dialog";
  d.setAttribute("aria-labelledby", titleId);
  d.innerHTML = `<form><button class="workspace-close" type="button" aria-label="Close dialog">×</button><h2 id="${titleId}">${escape(title)}</h2>${body}<p class="workspace-form-status" role="status"></p></form>`;
  document.body.append(d);
  const close = () => {
    d.close();
    d.remove();
  };
  d.querySelector(".workspace-close").onclick = close;
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  d.addEventListener("close", () => d.remove());
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const submit = e.submitter;
    if (submit) submit.disabled = true;
    try {
      await onSubmit(new FormData(e.target), d);
      close();
    } catch (error) {
      const status = d.querySelector(".workspace-form-status");
      status.textContent = error.message;
      status.setAttribute("role", "alert");
      if (error.conflict && !d.querySelector("[data-reload]")) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.reload = "";
        b.textContent = "Reload latest";
        b.onclick = () => location.reload();
        status.after(b);
      }
      if (submit) submit.disabled = false;
    }
  };
  d.showModal();
  return d;
}
export async function enableOrganization(config) {
  makeDialog(
    "Enable flexible boards?",
    '<p>Convert the existing board metadata to stable items and placements. Existing board files, prior rounds, revisions, stars and notes remain in place. New organization changes live beside your project data.</p><p>This is an explicit workspace conversion. Resource files are not moved or deleted.</p><button type="submit" class="workspace-primary">Enable organization</button>',
    async () => {
      const r = await fetch("/api/workspace/migrate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tinka-workspace": config.workspaceId,
        },
        body: JSON.stringify({ dryRun: false }),
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(data.error || "Could not enable organization.");
      location.reload();
    },
  );
}
export async function destinationDialog(
  client,
  { sourceBoardId, placementIds, itemIds, kind = "move", refresh },
) {
  const ws = await client.get("/api/workspace");
  const source = ws.boards.find((b) => b.id === sourceBoardId),
    selectedItems =
      itemIds ||
      source?.placements
        .filter((p) => placementIds?.includes(p.id))
        .map((p) => p.itemId) ||
      [];
  const forbidden = new Set(),
    byItem = new Map(ws.items.map((i) => [i.id, i])),
    byBoard = new Map(ws.boards.map((b) => [b.id, b]));
  const visit = (id) => {
    if (!id || forbidden.has(id)) return;
    forbidden.add(id);
    for (const p of byBoard.get(id)?.placements || [])
      if (!p.removedAt && !p.deletedAt)
        visit(byItem.get(p.itemId)?.childBoardId);
  };
  for (const id of selectedItems) visit(byItem.get(id)?.childBoardId);
  const boards = ws.boards.filter(
    (b) =>
      b.id !== sourceBoardId &&
      !forbidden.has(b.id) &&
      !byItem.get(b.ownerItemId)?.deletedAt,
  );
  const isMove = kind === "move";
  makeDialog(
    isMove ? "Move to a board" : "Add a reference",
    `<p>${isMove ? "Replace the selected placements with placements in the destination." : "Keep these placements and add references to the same items in the destination."} Content, stars and notes stay with each item.</p><label>Destination<select name="target"><option value="new">＋ Create a new board</option>${boards.map((b) => `<option value="${escape(b.id)}">${escape(b.title)}</option>`).join("")}${itemIds ? '<option value="home">Home</option>' : ""}</select></label><label data-new-title>New board title<input name="title" maxlength="1000" placeholder="A new series"></label><p class="workspace-scope">A reference shares the item. A duplicate makes a separate item.</p><button class="workspace-primary" type="submit">${isMove ? "Move items" : "Add references"}</button>`,
    async (f) => {
      const target = f.get("target");
      if (target === "new" && !f.get("title").trim())
        throw new Error("Name the new board.");
      await client.write(kind, {
        ...(sourceBoardId ? { sourceBoardId } : {}),
        ...(placementIds ? { placementIds } : { itemIds }),
        ...(target === "new"
          ? { newBoard: { title: f.get("title").trim() } }
          : target === "home"
            ? {}
            : { targetBoardId: target }),
      });
      await refresh();
      toast(
        isMove
          ? "Items moved. Resource files remain in place."
          : "References added. Original placements remain.",
      );
    },
  );
  const dialog = document.querySelector("dialog.workspace-dialog:last-of-type");
  dialog.querySelector("[name=target]").onchange = (e) =>
    (dialog.querySelector("[data-new-title]").hidden =
      e.target.value !== "new");
}
export function itemForm(client, { item, boardId, refresh }) {
  const c = item?.content || {},
    p = item?.preview || {};
  makeDialog(
    item ? "Edit item" : "Add an idea",
    `<label>Title<input name="title" required maxlength="1000" value="${escape(item?.title || "")}" placeholder="A title is enough to begin"></label><label>Description<textarea name="description" rows="3">${escape(item?.description || "")}</textarea></label><label>Status<select name="status">${[
      ["draft", "Draft"],
      ["reserved", "Reserved"],
      ["building", "Taking shape"],
      ["review", "Ready to review"],
      ["ready", "Ready"],
      ["complete", "Complete"],
      ["blocked", "Blocked"],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${(item?.build?.state || "ready") === value ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select></label><label>Primary content<select name="kind">${["text", "note", "html", "image", "video", "audio", "pdf", "markdown", "url", "file"].map((k) => `<option ${c.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select></label><label>Text or transcript<textarea name="text" rows="4">${escape(c.text || "")}</textarea></label><label>External or local application URL<input name="url" type="url" value="${escape(c.url || "")}" placeholder="https://… or http://127.0.0.1:…"></label><label>Open content<select name="openMode"><option value="inline" ${c.openMode === "inline" ? "selected" : ""}>Preview inside Tinka</option><option value="external" ${c.openMode === "external" || c.kind === "url" ? "selected" : ""}>Open externally</option></select></label><details><summary>Project resource & saved representation</summary><p>Resources stay in folders managed by your project. Ask your agent to register a resource root; use its root ID and relative path here.</p><label>Resource root ID<input name="rootId" value="${escape(c.resource?.rootId || "")}"></label><label>Resource path<input name="path" value="${escape(c.resource?.path || "")}" placeholder="ideas/first-video.mp4"></label><label>Preview image root ID<input name="previewRoot" value="${escape(p.resource?.rootId || "")}"></label><label>Preview image path<input name="previewPath" value="${escape(p.resource?.path || "")}"></label><label>Preview text<textarea name="previewText" rows="2">${escape(p.text || "")}</textarea></label><label>Start instructions<textarea name="startInstructions" rows="3">${escape(c.startInstructions || "")}</textarea></label></details><button type="submit" class="workspace-primary">${item ? "Save item" : "Add idea"}</button>`,
    async (f) => {
      const content = { kind: f.get("kind"), openMode: f.get("openMode") };
      for (const key of ["text", "url", "startInstructions"])
        if (f.get(key).trim()) content[key] = f.get(key).trim();
      if (f.get("rootId") || f.get("path"))
        content.resource = {
          rootId: f.get("rootId").trim(),
          path: f.get("path").trim(),
        };
      const preview = {};
      if (f.get("previewText").trim())
        preview.text = f.get("previewText").trim();
      if (f.get("previewRoot") || f.get("previewPath"))
        preview.resource = {
          rootId: f.get("previewRoot").trim(),
          path: f.get("previewPath").trim(),
        };
      const patch = {
        title: f.get("title").trim(),
        description: f.get("description"),
        content,
        preview,
        build: { ...(item?.build || { message: "" }), state: f.get("status") },
      };
      await client.write(
        item ? "updateItem" : "createItem",
        item ? { itemId: item.id, patch } : { boardId, item: patch },
      );
      await refresh();
      toast(item ? "Item updated." : "Idea added.");
    },
  );
}
