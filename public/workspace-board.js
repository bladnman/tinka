import {
  WorkspaceClient,
  escape as esc,
  resourceURL,
  destinationDialog,
  itemForm,
  makeDialog,
  toast,
  showFailure,
} from "./workspace.js";
const $ = (id) => document.getElementById(id);
export class WorkspaceBoard {
  constructor(config, snapshot, hooks) {
    this.config = config;
    this.snapshot = snapshot;
    this.hooks = hooks;
    this.client = new WorkspaceClient(config, snapshot.revision);
    this.selection = new Set();
    this.filters = {
      search: "",
      favorites: false,
      recent: false,
      archive: false,
    };
    this.mode = "canvas";
    try {
      const stored = localStorage.getItem(
        `tinka/${config.workspaceId}/${snapshot.id}/layout`,
      );
      if (["grid", "canvas"].includes(stored)) this.mode = stored;
    } catch {}
    this.draftKey = `tinka/${config.workspaceId}/item-review-drafts`;
    let drafts = {};
    try {
      drafts = JSON.parse(localStorage.getItem(this.draftKey) || "{}");
    } catch {}
    this.pendingReview = new Map(Object.entries(drafts));
    this.inFlightReview = new Map();
    this.saving = false;
    this.savePromise = null;
    this.surface = "content";
    this.activeDecoration = null;
  }
  adapt(snapshot = this.snapshot) {
    this.snapshot = snapshot;
    this.client.revision = Math.max(this.client.revision, snapshot.revision);
    const items = snapshot.items || {},
      byId = new Map(snapshot.placements.map((p) => [p.id, p]));
    const placements = [
      ...(snapshot.reviewOrder || []).map((id) => byId.get(id)).filter(Boolean),
      ...snapshot.placements.filter(
        (p) => !snapshot.reviewOrder.includes(p.id),
      ),
    ].filter((p) => !p.removedAt && !p.deletedAt);
    const roundMap = new Map(
      (snapshot.rounds || []).map((r, i) => [
        r.id,
        {
          ...r,
          concepts: [],
          number: r.number || String(i + 1).padStart(2, "0"),
        },
      ]),
    );
    const revisions = {};
    const notes = {};
    for (const p of placements) {
      const item = items[p.itemId];
      if (!item || item.deletedAt) continue;
      const archived = !!(p.archivedAt || item.archivedAt);
      if (this.filters.archive ? !archived : archived) continue;
      if (this.filters.favorites && !item.review?.star) continue;
      if (
        this.filters.recent &&
        Date.now() - Date.parse(item.createdAt) > 42 * 86400000
      )
        continue;
      if (
        this.filters.search &&
        ![item.title, item.description, item.content?.text, item.preview?.text]
          .join(" ")
          .toLowerCase()
          .includes(this.filters.search.toLowerCase())
      )
        continue;
      const roundId = p.roundId || item.legacy?.roundId || "items";
      if (!roundMap.has(roundId))
        roundMap.set(roundId, {
          id: roundId,
          number: "",
          title: roundId === "items" ? "On this board" : roundId,
          concepts: [],
        });
      const key = `items/${p.id}`;
      const concept = {
        id: p.id,
        key,
        name: item.title,
        description: item.description,
        number:
          item.number ||
          item.legacy?.number ||
          String(roundMap.get(roundId).concepts.length + 1).padStart(2, "0"),
        graphItem: item,
        placement: p,
        kind: item.content?.kind || "text",
        hint: item.hint || item.build?.message || "",
        category: item.category || item.content?.kind || "Idea",
      };
      roundMap.get(roundId).concepts.push(concept);
      notes[key] = {
        ...(item.review || {}),
        ...(this.pendingReview.get(item.id) || {}),
      };
      revisions[key] = (item.revisions || []).map((v, i) => ({
        ...v,
        id: v.id || `revision-${i + 1}`,
        name: v.name || v.title || `Revision ${i + 1}`,
        graphRevision: v,
      }));
    }
    const owner = items[snapshot.ownerItemId];
    if (owner)
      notes[`owner/${owner.id}`] = {
        ...(owner.review || {}),
        ...(this.pendingReview.get(owner.id) || {}),
      };
    return {
      ...snapshot,
      rounds: [...roundMap.values()].filter((r) => r.concepts.length),
      revisions,
      graphNotes: notes,
    };
  }
  mount() {
    document.body.classList.add("workspace-board");
    $("viewport").setAttribute(
      "aria-label",
      "Board canvas: scroll to pan, pinch or Control-scroll to zoom; drag a card to move it",
    );
    $("help-panel").innerHTML =
      "<strong>Make yourself at home.</strong> Scroll with your mouse or trackpad, or swipe the background on a touch screen, to move around Canvas; Shift-scroll moves sideways. Pinch, or hold Control or ⌘ while scrolling, to zoom. Drag a card’s body to move it; notes and buttons keep their usual behavior. A click opens a preview. Select an item and use arrow keys to move it, or drag its corner to resize. Double-click text or a region label to edit it. Grid keeps comparison order. Open an item to try it, then step with Previous, Next or the dots. Escape returns here. Stars and notes follow the item across references.";
    const bar = document.createElement("section");
    bar.id = "workspace-toolbar";
    bar.className = "workspace-toolbar";
    bar.setAttribute("aria-label", "Organize this board");
    bar.innerHTML = `<div class="workspace-segments"><button data-mode="grid">Grid</button><button data-mode="canvas">Canvas</button></div><label class="workspace-search"><span class="sr-only">Search items</span><input type="search" placeholder="Find a title or text…" id="workspace-search"></label><button id="workspace-favorites" aria-pressed="false">☆ Favorites</button><button id="workspace-recent" aria-pressed="false">Last 6 weeks</button><button id="workspace-archive" aria-pressed="false">Archive</button><button id="workspace-owner" hidden>Open primary content</button><button id="workspace-retry-drafts" hidden>Retry unsaved feedback</button>`;
    $("canvas-header").after(bar);
    const add = document.createElement("button");
    add.id = "workspace-add";
    add.type = "button";
    add.textContent = "+ Add";
    add.setAttribute("aria-haspopup", "menu");
    add.setAttribute("aria-expanded", "false");
    $("canvas-header").append(add);
    add.onclick = () => this.addMenu(add);
    const selected = document.createElement("section");
    selected.id = "workspace-selection";
    selected.className = "workspace-selection";
    selected.hidden = true;
    selected.setAttribute("aria-label", "Selected placements");
    bar.after(selected);
    const surfaces = document.createElement("div");
    surfaces.id = "workspace-surfaces";
    surfaces.className = "workspace-surfaces";
    surfaces.hidden = true;
    surfaces.innerHTML =
      '<button data-surface="content">Content</button><button data-surface="board">Board</button><button data-reader-organize>Organize…</button><button data-reader-edit>Edit item…</button><button data-reader-children>Add board…</button>';
    document.querySelector(".reader-area").before(surfaces);
    document
      .querySelectorAll("[data-mode]")
      .forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode)));
    $("workspace-search").oninput = (e) => {
      this.filters.search = e.target.value;
      this.rebuild();
    };
    for (const [id, key] of [
      ["workspace-favorites", "favorites"],
      ["workspace-recent", "recent"],
      ["workspace-archive", "archive"],
    ])
      $(id).onclick = () => {
        this.filters[key] = !this.filters[key];
        $(id).setAttribute("aria-pressed", this.filters[key]);
        this.selection.clear();
        this.rebuild();
      };
    document.addEventListener("click", (e) => {
      const select = e.target.closest("[data-placement-select]"),
        context = e.target.closest("[data-item-controls]"),
        edit = e.target.closest("[data-edit-item]"),
        child = e.target.closest("[data-child-board]");
      if (select) {
        const id = select.dataset.placementSelect;
        this.selection.has(id)
          ? this.selection.delete(id)
          : this.selection.add(id);
        this.build(this.hooks.concepts());
      }
      if (context) this.itemControls(context.dataset.itemControls, context.dataset.controlsFocus);
      if (edit)
        itemForm(this.client, {
          item: this.snapshot.items[edit.dataset.editItem],
          refresh: () => this.refresh(),
        });
      if (child) this.navigate(child.dataset.childBoard);
    });
    surfaces.querySelector("[data-surface=content]").onclick = () => {
      this.surface = "content";
    this.activeDecoration = null;
      this.hooks.reloadReader();
    };
    surfaces.querySelector("[data-surface=board]").onclick = () => {
      const active = this.hooks.active();
      if (active?.graphItem.childBoardId)
        this.navigate(active.graphItem.childBoardId);
    };
    surfaces.querySelector("[data-reader-organize]").onclick = () => {
      const p = this.hooks.active()?.placement;
      if (p) {
        this.selection = new Set([p.id]);
        this.selectionMenu();
      }
    };
    surfaces.querySelector("[data-reader-edit]").onclick = () =>
      itemForm(this.client, {
        item: this.hooks.active()?.graphItem,
        refresh: () => this.refresh(),
      });
    surfaces.querySelector("[data-reader-children]").onclick = () =>
      this.addChildren(this.hooks.active()?.graphItem);
    $("workspace-retry-drafts").hidden = !this.pendingReview.size;
    $("workspace-retry-drafts").onclick = () => this.saveReview([], {});
    window.addEventListener("pagehide", () => this.persistDrafts());
    this.pointer();
    this.canvasEditing();
    this.setMode(this.mode, false);
    this.loadCrumb();
    $("workspace-owner").hidden =
      !this.snapshot.items[this.snapshot.ownerItemId]?.content;
    $("workspace-owner").onclick = () => this.hooks.openOwner();
  }
  revisionsFor(item) {
    return (item.revisions || []).map((v, i) => ({
      ...v,
      id: v.id || `revision-${i + 1}`,
      name: v.name || v.title || `Revision ${i + 1}`,
      graphRevision: v,
    }));
  }
  aliasConcept(key) {
    const p = this.snapshot.placements.find(
      (p) =>
        `items/${p.id}` === key ||
        this.snapshot.items[p.itemId]?.legacy?.key === key,
    );
    if (!p) return null;
    const item = this.snapshot.items[p.itemId];
    if (!item || item.deletedAt) return null;
    return {
      key: `items/${p.id}`,
      id: p.id,
      name: item.title,
      description: item.description,
      number: item.number || item.legacy?.number || "",
      graphItem: item,
      placement: p,
      round: p.roundId || item.legacy?.roundId || "items",
      row: 0,
      col: 0,
    };
  }
  ownerConcept(key) {
    const item = this.snapshot.items[this.snapshot.ownerItemId];
    if (item && (!key || key === `owner/${item.id}`))
      return {
        key: `owner/${item.id}`,
        id: item.id,
        name: item.title,
        graphItem: item,
        round: "items",
        row: 0,
        col: 0,
      };
    return null;
  }
  async loadCrumb() {
    try {
      const ws = await this.client.get("/api/workspace");
      const parents = ws.boards.filter((b) =>
        b.placements.some(
          (p) =>
            !p.removedAt &&
            !p.archivedAt &&
            p.itemId === this.snapshot.ownerItemId,
        ),
      );
      const requested = new URLSearchParams(location.search).get("from");
      const parent =
        parents.find((p) => p.id === requested) ||
        (parents.length === 1 ? parents[0] : null);
      let crumb = $("workspace-parent");
      if (crumb) crumb.remove();
      crumb = document.createElement(parent ? "a" : "button");
      crumb.id = "workspace-parent";
      crumb.className = "workspace-parent";
      $("board-title").before(crumb);
      if (parent) {
        crumb.textContent = parent.title + " /";
        crumb.href = `/boards/${encodeURIComponent(parent.id)}/`;
        crumb.title =
          "Return to " +
          parent.title +
          (parents.length > 1
            ? " · also appears on " + (parents.length - 1) + " other boards"
            : "");
      } else if (parents.length > 1) {
        crumb.textContent = parents.length + " parent boards /";
        crumb.onclick = () =>
          makeDialog(
            "This board appears on",
            parents
              .map(
                (p) =>
                  `<p><a href="/boards/${encodeURIComponent(p.id)}/">${esc(p.title)} ↗</a></p>`,
              )
              .join(""),
          );
      } else crumb.hidden = true;
    } catch {}
  }
  async navigate(id) {
    await this.saveReview([], {});
    if (id === this.snapshot.id) {
      this.hooks.closeReader();
      return;
    }
    location.href = `/boards/${encodeURIComponent(id)}/?from=${encodeURIComponent(this.snapshot.id)}`;
  }
  rebuild() {
    this.hooks.data(this.adapt());
  }
  async refresh() {
    if (this.pendingReview.size && !this.saving) await this.saveReview([], {});
    const snapshot = await this.client.get(
      `/api/boards/${encodeURIComponent(this.snapshot.id)}`,
    );
    this.hooks.data(this.adapt(snapshot));
    this.loadCrumb();
  }
  setMode(mode, rebuild = true) {
    this.mode = mode;
    try {
      localStorage.setItem(
        `tinka/${this.config.workspaceId}/${this.snapshot.id}/layout`,
        mode,
      );
    } catch {}
    document.body.dataset.boardLayout = mode;
    document
      .querySelectorAll("[data-mode]")
      .forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
    this.hooks.mode(mode);
    if (rebuild) this.rebuild();
  }
  build(concepts) {
    const world = $("world");
    if (this.mode === "canvas") {
      const entries = [
          ...concepts.map((c) => c.placement),
          ...(this.snapshot.decorations || []),
        ],
        origin = {
          x: 70 - Math.min(0, ...entries.map((e) => e.x || 0)),
          y: 70 - Math.min(0, ...entries.map((e) => e.y || 0)),
        };
      if (this.origin)
        this.hooks.shiftOrigin(
          origin.x - this.origin.x,
          origin.y - this.origin.y,
        );
      this.origin = origin;
    }
    const renderCard = (c) => {
      const item = c.graphItem,
        p = c.placement,
        img = resourceURL(item.preview?.resource),
        url =
          item.content?.resource &&
          ["image", "video"].includes(item.content.kind)
            ? resourceURL(item.content.resource)
            : null;
      const panel = p.presentation?.mode === "panel",
        icon = p.presentation?.mode === "icon",
        viewport = p.presentation?.viewport || { width: 1000, height: 720 };
      const selected = this.selection.has(p.id),
        unavailable = ["reserved", "building"].includes(item.build?.state),
        live = !icon && (this.mode === "grid" || panel) && !unavailable && !img &&
          item.content?.kind === "html" && item.content?.resource && !item.content?.url;
      const review = { ...item.review, ...this.pendingReview.get(item.id) };
      const handoff = resourceURL(item.resources?.find(r => r.role === "handoff")?.resource);
      const footer = `<footer class="workspace-item-footer workspace-panel-caption"><button type="button" data-placement-select="${esc(p.id)}" aria-pressed="${selected}" aria-label="${selected ? "Deselect" : "Select"} ${esc(item.title)}">${selected ? "✓" : "□"}</button>${panel ? `<button type="button" class="workspace-panel-title" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}">${esc(item.title)}</button>` : '<span class="workspace-item-spacer" aria-hidden="true"></span>'}<button type="button" class="shortlist" data-star="${esc(c.key)}" aria-label="Favorite ${esc(item.title)}" aria-pressed="${!!review.star}">${review.star ? "★" : "☆"}</button><button type="button" data-item-controls="${esc(p.id)}" data-controls-focus="notes" aria-expanded="${this.contextPlacement === p.id}" aria-label="Notes on ${esc(item.title)}">Notes${review.note ? '<span class="workspace-note-dot" aria-hidden="true"></span>' : ""}</button><button type="button" data-item-controls="${esc(p.id)}" data-controls-focus="appearance" aria-label="Details and appearance of ${esc(item.title)}" aria-expanded="${this.contextPlacement === p.id}">⋯</button></footer>`;
      const visual = unavailable
        ? `<div class="workspace-build-placeholder"><strong>${item.build.state === "building" ? "Taking shape." : "A place for a new idea."}</strong><span>${esc(item.build.message || "This slot will open when it is ready for review.")}</span></div>`
        : live ? `<iframe src="${esc(this.hooks.preview(c))}" title="${esc(item.title)} ${panel ? "design" : "live"} preview" tabindex="-1" loading="lazy" inert></iframe>`
        : img || (url && item.content.kind === "image") ? `<img src="${esc(img || url)}" alt="${esc(item.title)} preview">`
        : item.childBoardId ? '<span class="workspace-paper-art" aria-hidden="true">▱ ▱</span>'
        : `<span class="workspace-title-art">${esc(item.preview?.text || item.title)}</span>`;
      const paper = /^#[0-9a-f]{3,8}$/i.test(p.presentation?.paper || "") ? p.presentation.paper : "#f6f7f1";
      const dimensions = this.mode === "canvas"
        ? `left:${p.x + this.origin.x}px;top:${p.y + this.origin.y}px;width:${p.width}px;height:${p.height}px;z-index:${p.z};`
        : panel || icon ? `width:${p.width}px;height:${p.height}px;` : "";
      return `<article tabindex="-1" class="workspace-card ${panel ? "workspace-panel" : icon ? "workspace-icon" : "workspace-compact"} ${selected ? "selected" : ""}" data-key="${esc(c.key)}" data-placement="${esc(p.id)}" data-build-state="${esc(item.build?.state || "ready")}" style="${dimensions}--item-paper:${paper};--panel-viewport-width:${viewport.width}px;--panel-viewport-height:${viewport.height}px;">${icon ? `<button type="button" class="workspace-icon-entry" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="Open ${esc(item.title)}"><span aria-hidden="true">${item.childBoardId ? "▱" : item.content?.kind === "image" ? "▧" : item.content?.kind === "html" ? "▤" : "◇"}</span><strong>${esc(item.title)}</strong></button>` : `<div class="workspace-card-preview ${panel ? "workspace-panel-preview" : ""} ${live ? "workspace-live-preview" : ""}" ${panel ? `data-preview-width="${viewport.width}" data-preview-height="${viewport.height}"` : ""}>${visual}<button type="button" class="workspace-preview-launch" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="Open ${esc(item.title)}"><span>Open ${esc(item.title)} ↗</span></button></div>${!panel ? `<div class="workspace-card-copy"><div class="workspace-compact-meta"><span class="workspace-concept-number">${esc(c.number)}</span><span>${esc(item.category || item.content?.kind || "Idea")}</span></div><h3><button type="button" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}">${esc(item.title)}</button></h3>${item.description ? `<p>${esc(item.description)}</p>` : ""}${item.question ? `<p class="workspace-question">${esc(item.question)}</p>` : ""}${handoff ? `<a class="workspace-handoff" href="${esc(handoff)}" target="_blank" rel="noopener noreferrer">Handoff ↗</a>` : ""}${item.childBoardId && item.content ? `<button type="button" class="workspace-child" data-child-board="${esc(item.childBoardId)}">Open board ↗</button>` : ""}</div>` : ""}`}${footer}${this.mode === "canvas" ? `<button type="button" class="workspace-resize" data-resize="${esc(p.id)}" aria-label="Resize ${esc(item.title)}">◢</button>` : ""}</article>`;
    };
    const cards = concepts.map(renderCard).join("");
    const groups = new Map();
    for (const c of concepts) {
      if (!groups.has(c.round)) groups.set(c.round, []);
      groups.get(c.round).push(c);
    }
    const grid = [...groups]
      .map(([id, entries]) => {
        const r = this.snapshot.rounds.find((r) => r.id === id) || {
          title: "On this board",
        };
        return `<section class="workspace-grid-round"><header><p class="workspace-eyebrow">${r.number ? "ROUND " + esc(r.number) : "ITEMS"}${r.date ? " · " + esc(r.date) : ""}</p><h2>${esc(r.title || "Exploration")}</h2>${r.description ? `<p>${esc(r.description)}</p>` : ""}</header><div class="workspace-cards">${entries.map(renderCard).join("")}</div></section>`;
      })
      .join("");
    world.innerHTML = `${this.mode === "canvas" ? this.decorations() : ""}${this.mode === "grid" ? grid || '<p class="workspace-empty">Nothing here yet. Add an idea or clear a filter.</p>' : `<div class="workspace-cards">${cards || '<p class="workspace-empty">Nothing here yet. Add an idea or clear a filter.</p>'}</div>`}`;
    if (this.mode === "canvas") {
      const p = concepts.map((c) => c.placement),
        d = this.snapshot.decorations || [];
      world.style.width =
        Math.max(
          800,
          ...p.map((p) => p.x + p.width + this.origin.x + 70),
          ...d.map((d) => (d.x || 0) + (d.width || 300) + this.origin.x + 70),
        ) + "px";
      world.style.height =
        Math.max(
          600,
          ...p.map((p) => p.y + p.height + this.origin.y + 70),
          ...d.map((d) => (d.y || 0) + (d.height || 80) + this.origin.y + 70),
        ) + "px";
    } else {
      world.style.width = "";
      world.style.height = "";
    }
    const bg = this.snapshot.background || {};
    world.style.backgroundColor = bg.color || "";
    world.style.backgroundImage = resourceURL(bg.resource)
      ? `url("${resourceURL(bg.resource)}")`
      : "";
    this.selectionMenu();
    this.sizePreviews();
    this.hooks.layout();
    this.positionContext();
  }
  sizePreviews() {
    this.previewObserver?.disconnect();
    this.previewObserver = new ResizeObserver((entries) => {
      for (const { target } of entries) this.sizePreview(target);
    });
    document.querySelectorAll(".workspace-live-preview").forEach((el) => {
      this.sizePreview(el);
      this.previewObserver.observe(el);
    });
  }
  sizePreview(el) {
    const width = Number(el.dataset.previewWidth) || 1000,
      height = Number(el.dataset.previewHeight) || 720;
    const scale = el.classList.contains("workspace-panel-preview")
      ? Math.min(el.clientWidth / width, el.clientHeight / height)
      : el.clientWidth / width;
    el.style.setProperty("--preview-scale", String(scale));
  }
  selectionMenu() {
    const el = $("workspace-selection");
    el.hidden = !this.selection.size;
    el.innerHTML = `<strong role="status">${this.selection.size} selected</strong><button data-bulk="move">Move…</button><button data-bulk="reference">Add reference…</button><button data-bulk="group">New board around selection…</button><button data-bulk="archive">${this.filters.archive ? "Restore here" : "Archive here"}</button><button data-bulk="remove">Remove from board…</button><button data-bulk="clear" aria-label="Clear selection">×</button>`;
    el.querySelectorAll("[data-bulk]").forEach(
      (b) => (b.onclick = () => this.bulk(b.dataset.bulk)),
    );
  }
  async bulk(type) {
    const ids = [...this.selection];
    try {
      if (type === "clear") {
        this.selection.clear();
        this.build(this.hooks.concepts());
        return;
      }
      if (type === "move" || type === "reference") {
        await destinationDialog(this.client, {
          sourceBoardId: this.snapshot.id,
          placementIds: ids,
          kind: type,
          refresh: async () => {
            this.selection.clear();
            await this.refresh();
          },
        });
        return;
      }
      if (type === "group") {
        this.group(ids);
        return;
      }
      if (type === "remove") {
        makeDialog(
          "Remove these placements?",
          `<p>Remove ${ids.length} placement${ids.length === 1 ? "" : "s"} from this board. Other references, canonical items, notes and all resource files remain intact.</p><button type="submit" class="workspace-primary">Remove from this board</button>`,
          async () => {
            await this.client.write("remove", {
              boardId: this.snapshot.id,
              placementIds: ids,
            });
            this.selection.clear();
            await this.refresh();
            toast("Placements removed. Item content and files remain intact.");
          },
        );
        return;
      }
      await this.client.write("archive", {
        boardId: this.snapshot.id,
        placementIds: ids,
        archived: !this.filters.archive,
      });
      this.selection.clear();
      await this.refresh();
      toast(
        this.filters.archive
          ? "Placements restored."
          : "Archived here. Open Archive to restore.",
      );
    } catch (e) {
      showFailure(e);
    }
  }
  group(ids) {
    makeDialog(
      "A new board around these items",
      '<p>Create a board here, then move the selected placements into it. Their item identities and resources stay the same.</p><label>Board title<input name="title" required maxlength="1000"></label><button type="submit" class="workspace-primary">Create board and move</button>',
      async (f) => {
        await this.client.write("move", {
          sourceBoardId: this.snapshot.id,
          placementIds: ids,
          newBoard: {
            title: f.get("title").trim(),
            parentBoardId: this.snapshot.id,
          },
        });
        this.selection.clear();
        await this.refresh();
        toast("Board created around your selection.");
      },
    );
  }
  newBoard() {
    makeDialog(
      "Add a board",
      '<label>Board title<input name="title" required maxlength="1000"></label><button type="submit" class="workspace-primary">Add board</button>',
      async (f) => {
        await this.client.write("createBoard", {
          title: f.get("title").trim(),
          parentBoardId: this.snapshot.id,
        });
        await this.refresh();
      },
    );
  }
  addChildren(item) {
    if (!item) return;
    makeDialog(
      "Add a board to this item",
      `<p>${esc(item.title)} keeps its primary content. Its Board surface will hold related material.</p><label>Board title<input name="title" required value="${esc(item.title)}"></label><button type="submit" class="workspace-primary">Add board</button>`,
      async (f) => {
        await this.client.write("createBoard", {
          itemId: item.id,
          title: f.get("title").trim(),
        });
        await this.refresh();
        this.reader(item);
        toast("Board added. Primary content is still on Content.");
      },
    );
  }
  reader(concept) {
    const item = concept?.graphItem || concept;
    if (!item) return;
    const el = $("workspace-surfaces");
    el.hidden = false;
    el.querySelector("[data-surface=content]").hidden = !item.content;
    el.querySelector("[data-surface=content]").setAttribute(
      "aria-pressed",
      "true",
    );
    const board = el.querySelector("[data-surface=board]");
    board.hidden = !item.childBoardId;
    board.textContent = item.content ? "Board ↗" : "Open board ↗";
    el.querySelector("[data-reader-children]").hidden = !!item.childBoardId;
    $("notes-for").textContent = "Item notes · shared across placements";
  }
  itemControls(id, focus = "notes") {
    if (this.contextPlacement === id) { this.closeContext(); return; }
    this.closeContext();
    const p = this.snapshot.placements.find(p => p.id === id);
    const item = this.snapshot.items[p?.itemId];
    if (!item) return;
    this.closeAddMenu();
    this.contextPlacement = id;
    const popover = document.createElement("section");
    popover.id = "workspace-item-controls";
    popover.className = "workspace-item-controls";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `Notes and appearance of ${item.title}`);
    const note = this.pendingReview.get(item.id)?.note ?? item.review?.note ?? "";
    popover.innerHTML = `<header><strong>${esc(item.title)}</strong><button type="button" data-context-close aria-label="Close item details">×</button></header><label class="workspace-context-note">Notes<textarea data-note="items/${esc(id)}" aria-label="Notes on ${esc(item.title)}" placeholder="A thought to return to…">${esc(note)}</textarea></label><div class="workspace-context-row"><span>Appearance</span><div class="workspace-appearance-buttons" role="group" aria-label="Item appearance">${[["panel", "Full preview", '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 17h18"/>'], ["card", "Compact card", '<rect x="5" y="4" width="14" height="16" rx="1"/><path d="M5 13h14M8 16h8"/>'], ["icon", "Icon", '<rect x="7" y="7" width="10" height="10" rx="2"/>']].map(([mode, label, glyph]) => `<button type="button" data-presentation="${mode}" aria-label="${label}" title="${label}" aria-pressed="${(p.presentation?.mode || "card") === mode}"><svg viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg></button>`).join("")}</div></div><div class="workspace-context-row"><span>Paper</span><div class="workspace-paper-swatches" role="group" aria-label="Paper color">${[["#f6f7f1", "Paper"], ["#e4ebdc", "Sage"], ["#f1e8d5", "Sand"], ["#f1e0dc", "Rose"], ["#dfe8ed", "Blue"]].map(([color,label]) => `<button type="button" data-paper="${color}" aria-label="${label} paper" title="${label}" aria-pressed="${(p.presentation?.paper || "#f6f7f1") === color}" style="--swatch:${color}"></button>`).join("")}</div></div><footer><button type="button" data-context-edit>Edit item…</button><span>${esc(item.build?.state || "ready")}${item.revisions?.length ? ` · ${item.revisions.length} versions` : ""}</span></footer>`;
    document.body.append(popover);
    this.context = popover;
    popover.querySelector("[data-context-close]").onclick = () => this.closeContext(true);
    popover.querySelector("[data-context-edit]").onclick = () => { this.closeContext(); itemForm(this.client, { item, refresh: () => this.refresh() }); };
    popover.querySelectorAll("[data-presentation], [data-paper]").forEach(button => button.onclick = async () => {
      const placement = this.snapshot.placements.find(p => p.id === id);
      const presentation = { mode: "card", ...(placement.presentation || {}), ...(button.dataset.presentation ? { mode: button.dataset.presentation } : { paper: button.dataset.paper }) };
      const patch = { presentation };
      if (button.dataset.presentation && button.dataset.presentation !== (placement.presentation?.mode || "card")) {
        const [width, height] = { panel: [560, 420], card: [320, 260], icon: [218, 112] }[presentation.mode];
        Object.assign(patch, { width, height });
      }
      try {
        await this.client.write("updatePlacement", { boardId: this.snapshot.id, placementId: id, patch });
        Object.assign(placement, patch);
        popover.querySelectorAll("[data-presentation]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.presentation === (presentation.mode || "card"))));
        popover.querySelectorAll("[data-paper]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.paper === (presentation.paper || "#f6f7f1"))));
        await this.refresh();
      } catch (error) { showFailure(error); }
    });
    this.positionContext();
    document.querySelectorAll(`[data-item-controls="${CSS.escape(id)}"]`).forEach(b => b.setAttribute("aria-expanded", "true"));
    if (focus === "notes") popover.querySelector("textarea").focus({ preventScroll: true });
    else popover.querySelector("[data-presentation]").focus({ preventScroll: true });
    const follow = () => { if (!this.context) return; this.positionContext(); this.contextFrame = requestAnimationFrame(follow); };
    this.contextFrame = requestAnimationFrame(follow);
  }
  positionContext() {
    if (!this.context) return;
    const card = document.querySelector(`[data-placement="${CSS.escape(this.contextPlacement)}"]`);
    if (!card) { this.closeContext(); return; }
    const anchor = card.querySelector(".workspace-item-footer").getBoundingClientRect();
    const bounds = $("viewport").getBoundingClientRect();
    if (anchor.right < bounds.left || anchor.left > bounds.right || anchor.bottom < bounds.top || anchor.top > bounds.bottom) { this.closeContext(); return; }
    this.context.hidden = false;
    const width = this.context.offsetWidth, height = this.context.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - width - 8, anchor.right - width));
    const above = anchor.top - height - 7;
    const top = above >= bounds.top + 5 ? above : Math.min(innerHeight - height - 8, anchor.bottom + 7);
    Object.assign(this.context.style, { left: `${left}px`, top: `${Math.max(8, top)}px` });
  }
  closeContext(focus = false) {
    if (!this.context) return;
    const id = this.contextPlacement;
    this.context.remove(); this.context = null; this.contextPlacement = null;
    cancelAnimationFrame(this.contextFrame);
    const buttons = document.querySelectorAll(`[data-item-controls="${CSS.escape(id)}"]`);
    buttons.forEach(b => b.setAttribute("aria-expanded", "false"));
    if (focus) buttons[0]?.focus({ preventScroll: true });
  }
  pointer() {
    let drag = null;
    let suppressedClick = null;
    const viewport = $("viewport");
    const cancel = () => {
      if (!drag) return;
      const { element, p, pointerId } = drag;
      element.classList.remove("workspace-dragging");
      Object.assign(element.style, {
        left: `${p.x + this.origin.x}px`,
        top: `${p.y + this.origin.y}px`,
        width: `${p.width}px`,
        height: `${p.height}px`,
      });
      try {
        viewport.releasePointerCapture(pointerId);
      } catch {}
      drag = null;
    };
    // A fresh pointer gesture cannot inherit the click suppressed after a drag.
    document.addEventListener(
      "pointerdown",
      () => {
        suppressedClick = null;
      },
      true,
    );
    document.addEventListener(
      "click",
      (e) => {
        if (!suppressedClick || e.detail === 0) return;
        if (e.target === viewport || suppressedClick.contains(e.target)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          suppressedClick = null;
        }
      },
      true,
    );
    viewport.addEventListener(
      "pointerdown",
      (e) => {
        if (this.mode !== "canvas" || e.button !== 0) return;
        if (drag && drag.pointerId !== e.pointerId) {
          cancel();
          return;
        }
        const card = e.target.closest(".workspace-card");
        if (!card) return;
        const handle = e.target.closest("[data-drag],[data-resize]");
        const preview = e.target.closest(".workspace-preview-launch,.workspace-icon-entry");
        if (
          !handle &&
          !preview &&
          e.target.closest(
            "button,a,input,textarea,select,label,[contenteditable],.workspace-review",
          )
        )
          return;
        const id = card.dataset.placement;
        const p = this.snapshot.placements.find((p) => p.id === id);
        if (!p) return;
        drag = {
          id,
          p: { ...p },
          x: e.clientX,
          y: e.clientY,
          pointerId: e.pointerId,
          resize: !!handle?.dataset.resize,
          element: card,
          zoom: this.hooks.zoom(),
          active: false,
        };
        if (drag.resize) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (e) => {
        if (!drag || drag.pointerId !== e.pointerId) return;
        const screenX = e.clientX - drag.x,
          screenY = e.clientY - drag.y;
        if (
          !drag.active &&
          Math.hypot(screenX, screenY) < (e.pointerType === "touch" ? 8 : 6)
        )
          return;
        if (!drag.active) {
          drag.active = true;
          drag.element.classList.add("workspace-dragging");
          const selection = window.getSelection();
          if (
            selection?.anchorNode &&
            drag.element.contains(selection.anchorNode)
          )
            selection.removeAllRanges();
          try {
            viewport.setPointerCapture(e.pointerId);
          } catch {}
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        const dx = screenX / drag.zoom,
          dy = screenY / drag.zoom;
        drag.patch = drag.resize
          ? {
              width: Math.max(drag.p.presentation?.mode === "icon" ? 190 : 160, Math.round(drag.p.width + dx)),
              height: Math.max(drag.p.presentation?.mode === "icon" ? 90 : 120, Math.round(drag.p.height + dy)),
            }
          : { x: Math.round(drag.p.x + dx), y: Math.round(drag.p.y + dy) };
        for (const [key, value] of Object.entries(drag.patch))
          drag.element.style[key === "x" ? "left" : key === "y" ? "top" : key] =
            (key === "x"
              ? value + this.origin.x
              : key === "y"
                ? value + this.origin.y
                : value) + "px";
      },
      true,
    );
    document.addEventListener(
      "pointerup",
      async (e) => {
        if (!drag || drag.pointerId !== e.pointerId) return;
        const done = drag;
        drag = null;
        done.element.classList.remove("workspace-dragging");
        if (!done.active || !done.patch) return;
        e.preventDefault();
        suppressedClick = done.element;
        try {
          viewport.releasePointerCapture(e.pointerId);
        } catch {}
        try {
          await this.client.write("updatePlacement", {
            boardId: this.snapshot.id,
            placementId: done.id,
            patch: done.patch,
          });
          await this.refresh();
        } catch (error) {
          showFailure(error);
          this.rebuild();
        }
      },
      true,
    );
    document.addEventListener(
      "pointercancel", (e) => { if (drag?.pointerId === e.pointerId) cancel(); }, true,
    );
    document.addEventListener("keydown", e => {
      if (drag && e.key === "Escape") { cancel(); e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }
  decorations() {
    return (this.snapshot.decorations || []).map(d => this.decorationMarkup(d)).join("");
  }
  decorationMarkup(d) {
    const line = d.type === "line", selected = this.activeDecoration === d.id;
    const color = /^#[0-9a-f]{3,8}$/i.test(d.color) ? d.color : "#cfd8bf";
    const x1 = d.flipX ? 100 : 0, y1 = d.flipY ? 100 : 0;
    const x2 = 100 - x1, y2 = 100 - y1;
    const mark = line ? `<svg class="workspace-decoration-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-${esc(d.id)}" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L9 5L1 9" fill="none" stroke="${color}" stroke-width="2"/></marker></defs><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" ${d.endArrow ? `marker-end="url(#arrow-${esc(d.id)})"` : ""}/></svg><span class="workspace-decoration-label" data-decoration-label>${esc(d.text || "")}</span>` : `<span class="workspace-decoration-label" data-decoration-label>${esc(d.text || "")}</span>`;
    return `<div tabindex="0" role="group" aria-label="${esc(d.type === "line" && d.endArrow ? "Arrow" : d.type)}: ${esc(d.text || "Untitled")}" class="workspace-decoration decoration-${esc(d.type || "text")} ${selected ? "selected" : ""}" data-decoration="${esc(d.id)}" style="left:${Number(d.x || 0) + this.origin.x}px;top:${Number(d.y || 0) + this.origin.y}px;width:${Number(d.width || 300)}px;height:${Number(d.height || 80)}px;--decoration-color:${color}">${mark}${selected ? `<div class="workspace-decoration-actions"><input type="color" data-decoration-color aria-label="Decoration color" value="${color}"><button type="button" data-decoration-delete aria-label="Delete decoration">×</button></div>${line ? `<button type="button" class="workspace-endpoint" data-endpoint="start" aria-label="Move arrow start" style="left:${x1}%;top:${y1}%"></button><button type="button" class="workspace-endpoint" data-endpoint="end" aria-label="Move arrow end" style="left:${x2}%;top:${y2}%"></button>` : '<button type="button" class="workspace-decoration-resize" data-decoration-resize aria-label="Resize decoration">◢</button>'}` : ""}</div>`;
  }
  updateDecorationElement(d) {
    const old = document.querySelector(`[data-decoration="${CSS.escape(d.id)}"]`);
    if (old) old.outerHTML = this.decorationMarkup(d);
  }
  closeAddMenu() {
    this.addPopup?.remove(); this.addPopup = null;
    $("workspace-add").setAttribute("aria-expanded", "false");
  }
  addMenu(anchor, point) {
    if (this.addPopup) { this.closeAddMenu(); return; }
    this.closeContext();
    const menu = document.createElement("div");
    menu.className = "workspace-add-menu"; menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Add to board");
    menu.innerHTML = `<button type="button" role="menuitem" data-add="text"><span aria-hidden="true">T</span>Text</button><button type="button" role="menuitem" data-add="region"><span aria-hidden="true">▧</span>Colored region</button><button type="button" role="menuitem" data-add="arrow"><span aria-hidden="true">↗</span>Arrow</button><hr><button type="button" role="menuitem" data-add="idea"><span aria-hidden="true">◇</span>Item…</button><button type="button" role="menuitem" data-add="board"><span aria-hidden="true">▱</span>Tinka / Board…</button><hr><button type="button" role="menuitem" data-add="background">Board background…</button><button type="button" role="menuitem" data-add="order">Comparison order…</button>`;
    document.body.append(menu); this.addPopup = menu;
    const rect = anchor?.getBoundingClientRect();
    const screen = point || { x: rect.right - menu.offsetWidth, y: rect.bottom + 6 };
    Object.assign(menu.style, { left: `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, screen.x))}px`, top: `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, screen.y))}px` });
    $("workspace-add").setAttribute("aria-expanded", "true");
    menu.querySelectorAll("[data-add]").forEach(button => button.onclick = () => {
      const type = button.dataset.add;
      this.closeAddMenu();
      if (["text", "region", "arrow"].includes(type)) this.createDecoration(type, point);
      else if (type === "board") this.newBoard();
      else if (type === "idea") itemForm(this.client, { boardId: this.snapshot.id, refresh: () => this.refresh() });
      else if (type === "background") this.backgroundForm();
      else this.orderForm();
    });
    menu.onkeydown = e => {
      const buttons = [...menu.querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
      }
    };
    menu.querySelector("button").focus({ preventScroll: true });
  }
  canvasPoint(screen) {
    const viewport = $("viewport").getBoundingClientRect(), world = $("world").getBoundingClientRect();
    const point = screen || { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 };
    return { x: Math.round((point.x - world.left) / this.hooks.zoom() - (this.origin?.x || 0)), y: Math.round((point.y - world.top) / this.hooks.zoom() - (this.origin?.y || 0)) };
  }
  async createDecoration(type, screen) {
    if (this.mode !== "canvas") this.setMode("canvas");
    const point = this.canvasPoint(screen), region = type === "region";
    const d = { id: crypto.randomUUID(), type: type === "arrow" ? "line" : type,
      x: point.x, y: point.y, width: region ? 420 : type === "arrow" ? 200 : 280,
      height: region ? 280 : type === "arrow" ? 90 : 70,
      text: type === "text" ? "Write something" : region ? "A new area" : "",
      color: region ? "#e1e8d5" : "#7a8a68", ...(type === "arrow" ? { endArrow: true, flipY: true } : {}) };
    if (!screen) {
      const occupied = [...this.snapshot.placements.filter(p => !p.removedAt && !p.archivedAt), ...(this.snapshot.decorations || []).filter(d => region || d.type !== "region")];
      const free = point => !occupied.some(p => point.x < p.x + p.width + 16 && point.x + d.width + 16 > p.x && point.y < p.y + p.height + 16 && point.y + d.height + 16 > p.y);
      const bounds = $("viewport").getBoundingClientRect();
      const topLeft = this.canvasPoint({ x: bounds.left + 20, y: bounds.top + 20 });
      const bottomRight = this.canvasPoint({ x: bounds.right - 20, y: bounds.bottom - 20 });
      const candidates = [];
      for (let y = topLeft.y; y + d.height <= bottomRight.y; y += 30)
        for (let x = topLeft.x; x + d.width <= bottomRight.x; x += 30)
          if (free({ x, y })) candidates.push({ x, y });
      candidates.sort((a,b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y));
      if (candidates.length) Object.assign(d, candidates[0]);
      else { d.x = Math.max(point.x, ...occupied.map(p => p.x + p.width)) + 35; d.y = point.y; }
    }
    try {
      this.activeDecoration = d.id; this.selection.clear();
      await this.writeDecorations([...(this.snapshot.decorations || []), d]);
      const element = document.querySelector(`[data-decoration="${CSS.escape(d.id)}"]`);
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
      element?.focus({ preventScroll: true });
      if (type !== "arrow") this.editDecoration(d.id, true);
    } catch (error) { showFailure(error); }
  }
  async writeDecorations(decorations) {
    await this.client.write("updateBoard", { boardId: this.snapshot.id, patch: { decorations } });
    this.snapshot.decorations = decorations;
    await this.refresh();
  }
  editDecoration(id, select = false) {
    const d = this.snapshot.decorations.find(d => d.id === id);
    const label = document.querySelector(`[data-decoration="${CSS.escape(id)}"] [data-decoration-label]`);
    if (!d || !label || label.isContentEditable) return;
    const original = d.text || ""; let cancelled = false;
    label.contentEditable = "plaintext-only"; label.setAttribute("role", "textbox"); label.setAttribute("aria-label", d.type === "region" ? "Region label" : "Canvas text");
    label.focus({ preventScroll: true });
    if (select) { const range = document.createRange(); range.selectNodeContents(label); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    label.onkeydown = e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); cancelled = true; label.textContent = original; label.blur(); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); label.blur(); }
    };
    label.onblur = async () => {
      label.removeAttribute("contenteditable"); label.removeAttribute("role");
      const text = cancelled ? original : label.innerText.trim();
      if (text === original) return;
      try { await this.writeDecorations(this.snapshot.decorations.map(x => x.id === id ? { ...x, text } : x)); }
      catch (error) { showFailure(error); }
    };
  }
  canvasEditing() {
    const viewport = $("viewport"); let drag = null;
    document.addEventListener("pointerdown", e => {
      if (this.context && !e.target.closest("#workspace-item-controls,[data-item-controls]")) this.closeContext();
      if (this.addPopup && !e.target.closest(".workspace-add-menu,#workspace-add")) this.closeAddMenu();
    }, true);
    viewport.addEventListener("contextmenu", e => {
      if (e.target.closest(".workspace-card,.workspace-decoration,button,input,textarea")) return;
      e.preventDefault(); this.addMenu(null, { x: e.clientX, y: e.clientY });
    });
    viewport.addEventListener("dblclick", e => {
      const mark = e.target.closest("[data-decoration]");
      if (mark && !e.target.closest("button,input")) { e.preventDefault(); this.editDecoration(mark.dataset.decoration); }
    });
    viewport.addEventListener("change", async e => {
      if (!e.target.matches("[data-decoration-color]")) return;
      const id = e.target.closest("[data-decoration]").dataset.decoration;
      try { await this.writeDecorations(this.snapshot.decorations.map(d => d.id === id ? { ...d, color: e.target.value } : d)); } catch (error) { showFailure(error); }
    });
    viewport.addEventListener("click", e => {
      if (e.target.closest("[data-decoration-delete]")) this.deleteDecoration();
      if (!e.target.closest(".workspace-card,.workspace-decoration")) {
        if (this.activeDecoration) { const old = this.snapshot.decorations.find(d => d.id === this.activeDecoration); this.activeDecoration = null; if (old) this.updateDecorationElement(old); }
      }
    });
    viewport.addEventListener("pointerdown", e => {
      if (this.mode !== "canvas" || e.button !== 0) return;
      const element = e.target.closest("[data-decoration]");
      if (!element || e.target.closest("input,[contenteditable],[data-decoration-delete]")) return;
      const id = element.dataset.decoration, d = this.snapshot.decorations.find(d => d.id === id);
      if (!d) return;
      if (this.activeDecoration !== id) {
        const old = this.snapshot.decorations.find(d => d.id === this.activeDecoration);
        this.activeDecoration = id; this.selection.clear(); document.querySelectorAll(".workspace-card.selected").forEach(c => c.classList.remove("selected")); this.selectionMenu();
        if (old) this.updateDecorationElement(old);
        this.updateDecorationElement(d);
      }
      drag = { d: { ...d }, x: e.clientX, y: e.clientY, pointerId: e.pointerId,
        endpoint: e.target.closest("[data-endpoint]")?.dataset.endpoint,
        resize: !!e.target.closest("[data-decoration-resize]"), active: false };
      document.querySelector(`[data-decoration="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      e.stopImmediatePropagation();
    }, true);
    document.addEventListener("pointermove", e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = (e.clientX - drag.x) / this.hooks.zoom(), dy = (e.clientY - drag.y) / this.hooks.zoom();
      if (!drag.active && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.active = true; e.preventDefault(); e.stopImmediatePropagation();
      const d = drag.d;
      if (drag.endpoint) {
        const start = { x: d.x + (d.flipX ? d.width : 0), y: d.y + (d.flipY ? d.height : 0) };
        const end = { x: d.x + (d.flipX ? 0 : d.width), y: d.y + (d.flipY ? 0 : d.height) };
        const point = drag.endpoint === "start" ? start : end; point.x += dx; point.y += dy;
        drag.next = { ...d, x: Math.round(Math.min(start.x, end.x)), y: Math.round(Math.min(start.y, end.y)), width: Math.max(1, Math.round(Math.abs(end.x - start.x))), height: Math.max(1, Math.round(Math.abs(end.y - start.y))), flipX: end.x < start.x, flipY: end.y < start.y };
      } else drag.next = { ...d, ...(drag.resize ? { width: Math.max(60, Math.round(d.width + dx)), height: Math.max(35, Math.round(d.height + dy)) } : { x: Math.round(d.x + dx), y: Math.round(d.y + dy) }) };
      this.updateDecorationElement(drag.next);
    }, true);
    document.addEventListener("pointerup", async e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const done = drag; drag = null;
      if (!done.active || !done.next) return;
      e.preventDefault(); e.stopImmediatePropagation();
      try { await this.writeDecorations(this.snapshot.decorations.map(d => d.id === done.d.id ? done.next : d)); }
      catch (error) { showFailure(error); this.rebuild(); }
    }, true);
    document.addEventListener("pointercancel", () => { if (drag) { this.updateDecorationElement(drag.d); drag = null; } }, true);
    document.addEventListener("keydown", async e => {
      if (document.querySelector("#reader-dialog[open],dialog.workspace-dialog[open]")) return;
      if (e.key === "Escape") {
        if (drag) { this.updateDecorationElement(drag.d); drag = null; e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (this.context) { this.closeContext(true); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (this.addPopup) { this.closeAddMenu(); $("workspace-add").focus(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (this.activeDecoration) { const old = this.snapshot.decorations.find(d => d.id === this.activeDecoration); this.activeDecoration = null; if (old) this.updateDecorationElement(old); e.preventDefault(); return; }
        if (this.selection.size) { this.selection.clear(); this.build(this.hooks.concepts()); e.preventDefault(); return; }
      }
      if (e.target.closest("input,textarea,select,[contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[e.key];
      if (this.activeDecoration && ["Delete", "Backspace"].includes(e.key)) { e.preventDefault(); this.deleteDecoration(); return; }
      if (this.selection.size && ["Delete", "Backspace"].includes(e.key)) { e.preventDefault(); this.bulk("remove"); return; }
      if (!delta || (!this.activeDecoration && !this.selection.size)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const [dx,dy] = delta.map(v => v * (e.shiftKey ? 10 : 1));
      try {
        if (this.activeDecoration) await this.writeDecorations(this.snapshot.decorations.map(d => d.id === this.activeDecoration ? { ...d, x: d.x + dx, y: d.y + dy } : d));
        else {
          for (const id of this.selection) {
            const p = this.snapshot.placements.find(p => p.id === id); if (!p) continue;
            const patch = { x: p.x + dx, y: p.y + dy }; Object.assign(p, patch);
            await this.client.write("updatePlacement", { boardId: this.snapshot.id, placementId: id, patch });
          }
          await this.refresh();
        }
      } catch (error) { showFailure(error); }
    }, true);
  }
  async deleteDecoration() {
    const id = this.activeDecoration; if (!id) return;
    this.activeDecoration = null;
    try { await this.writeDecorations(this.snapshot.decorations.filter(d => d.id !== id)); }
    catch (error) { showFailure(error); }
  }
  backgroundForm() {
    const b = this.snapshot.background || {};
    makeDialog(
      "Board background",
      `<label>Color<input name="color" type="color" value="${b.color || "#e7e8e1"}"></label><p>An optional image remains a project resource. Your agent supplies its registered root ID and relative path.</p><label>Image root ID<input name="root" value="${esc(b.resource?.rootId || "")}"></label><label>Image path<input name="path" value="${esc(b.resource?.path || "")}"></label><button type="submit" class="workspace-primary">Save background</button>`,
      async (f) => {
        const background = { color: f.get("color") };
        if (f.get("root") || f.get("path"))
          background.resource = {
            rootId: f.get("root").trim(),
            path: f.get("path").trim(),
          };
        await this.client.write("updateBoard", {
          boardId: this.snapshot.id,
          patch: { background },
        });
        await this.refresh();
      },
    );
  }
  orderForm() {
    const placements = this.snapshot.reviewOrder
      .map((id) => this.snapshot.placements.find((p) => p.id === id))
      .filter((p) => p && !p.removedAt);
    const d = makeDialog(
      "Comparison order",
      `<p>Move a title up or down. The explicit review sequence is independent of Canvas positions.</p><div id="workspace-order"></div><button type="submit" class="workspace-primary">Save order</button>`,
      async () => {
        await this.client.write("updateBoard", {
          boardId: this.snapshot.id,
          patch: { reviewOrder: placements.map((p) => p.id) },
        });
        await this.refresh();
      },
    );
    const render = () => {
      d.querySelector("#workspace-order").innerHTML = placements
        .map(
          (p, i) =>
            `<div class="workspace-order-row"><span>${i + 1}. ${esc(this.snapshot.items[p.itemId]?.title || p.itemId)}</span><button type="button" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move ${esc(this.snapshot.items[p.itemId]?.title)} earlier">↑</button><button type="button" data-down="${i}" ${i === placements.length - 1 ? "disabled" : ""} aria-label="Move ${esc(this.snapshot.items[p.itemId]?.title)} later">↓</button></div>`,
        )
        .join("");
      d.querySelectorAll("[data-up],[data-down]").forEach(
        (b) =>
          (b.onclick = () => {
            const i = Number(b.dataset.up ?? b.dataset.down),
              j = i + (b.dataset.up !== undefined ? -1 : 1);
            [placements[i], placements[j]] = [placements[j], placements[i]];
            render();
          }),
      );
    };
    render();
  }
  persistDrafts() {
    try {
      localStorage.setItem(
        this.draftKey,
        JSON.stringify(Object.fromEntries(this.pendingReview)),
      );
    } catch {
      this.hooks.saveStatus(
        "Feedback is pending · browser storage unavailable",
        "error",
      );
    }
    const b = $("workspace-retry-drafts");
    if (b) b.hidden = !this.pendingReview.size;
  }
  captureReview(concepts, notes) {
    for (const c of concepts) {
      if (!c?.graphItem || !notes[c.key]) continue;
      const id = c.graphItem.id;
      const n = notes[c.key];
      const before = c.graphItem.review || {};
      const inFlight = this.inFlightReview.get(id) || {};
      const patch = { ...(this.pendingReview.get(id) || {}) };
      // A reverted edit cancels a queued field. If an older write is already
      // in flight, retain the latest value as a compensating write after its ACK.
      for (const field of ["note", "star"]) {
        const value = field === "note" ? n.note || "" : !!n.star;
        const baseline = field === "note" ? before.note || "" : !!before.star;
        if (
          value !== baseline ||
          (Object.hasOwn(inFlight, field) && value !== inFlight[field])
        )
          patch[field] = value;
        else delete patch[field];
      }
      if (!Object.keys(patch).length) this.pendingReview.delete(id);
      else if (
        JSON.stringify(patch) !== JSON.stringify(this.pendingReview.get(id))
      )
        this.pendingReview.set(id, patch);
    }
    this.persistDrafts();
  }
  async saveReview(concepts = [], notes = {}) {
    this.captureReview(concepts, notes);
    if (this.saving) return this.savePromise;
    this.saving = true;
    this.savePromise = (async () => {
      try {
        while (this.pendingReview.size) {
          const [id, patch] = this.pendingReview.entries().next().value;
          this.inFlightReview.set(id, patch);
          await this.client.write("review", { itemId: id, patch });
          const item = this.snapshot.items[id];
          if (item) item.review = { ...item.review, ...patch };
          for (const c of this.hooks.concepts())
            if (c.graphItem.id === id)
              c.graphItem.review = { ...c.graphItem.review, ...patch };
          this.inFlightReview.delete(id);
          if (this.pendingReview.get(id) === patch)
            this.pendingReview.delete(id);
          this.persistDrafts();
        }
        this.hooks.saveStatus("Item notes saved on this Mac", "saved");
      } catch (e) {
        this.inFlightReview.clear();
        this.persistDrafts();
        this.hooks.saveStatus(
          "Feedback saved in this browser · retry unsaved feedback",
          "local",
        );
        showFailure(e);
      } finally {
        this.saving = false;
        this.savePromise = null;
      }
    })();
    return this.savePromise;
  }
}
