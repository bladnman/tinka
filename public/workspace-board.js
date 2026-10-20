import {
  WorkspaceClient,
  escape as esc,
  resourceURL,
  contentURL,
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
      "<strong>Make yourself at home.</strong> Scroll with your mouse or trackpad, or swipe the background on a touch screen, to move around Canvas; Shift-scroll moves sideways. Pinch, or hold Control or ⌘ while scrolling, to zoom. Drag a card’s body to move it; notes and buttons keep their usual behavior. A click opens a preview. Move / resize offers keyboard and touch controls. Grid keeps comparison order. Open an item to try it, then step with Previous, Next or the dots. Escape returns here. Stars and notes follow the item across references.";
    const bar = document.createElement("section");
    bar.id = "workspace-toolbar";
    bar.className = "workspace-toolbar";
    bar.setAttribute("aria-label", "Organize this board");
    bar.innerHTML = `<div class="workspace-segments"><button data-mode="grid">Grid</button><button data-mode="canvas">Canvas</button></div><label class="workspace-search"><span class="sr-only">Search items</span><input type="search" placeholder="Find a title or text…" id="workspace-search"></label><button id="workspace-favorites" aria-pressed="false">☆ Favorites</button><button id="workspace-recent" aria-pressed="false">Last 6 weeks</button><button id="workspace-archive" aria-pressed="false">Archive</button><button id="workspace-new">+ Idea</button><button id="workspace-new-board">+ Board</button><button id="workspace-tools">Board tools…</button><button id="workspace-owner" hidden>Open primary content</button><button id="workspace-retry-drafts" hidden>Retry unsaved feedback</button>`;
    $("canvas-header").after(bar);
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
    $("workspace-new").onclick = () =>
      itemForm(this.client, {
        boardId: this.snapshot.id,
        refresh: () => this.refresh(),
      });
    $("workspace-new-board").onclick = () => this.newBoard();
    $("workspace-tools").onclick = () => this.boardTools();
    document.addEventListener("click", (e) => {
      const select = e.target.closest("[data-placement-select]"),
        geo = e.target.closest("[data-geometry]"),
        edit = e.target.closest("[data-edit-item]"),
        child = e.target.closest("[data-child-board]");
      if (select) {
        const id = select.dataset.placementSelect;
        this.selection.has(id)
          ? this.selection.delete(id)
          : this.selection.add(id);
        this.build(this.hooks.concepts());
      }
      if (geo) this.geometry(geo.dataset.geometry);
      if (edit)
        itemForm(this.client, {
          item: this.snapshot.items[edit.dataset.editItem],
          refresh: () => this.refresh(),
        });
      if (child) this.navigate(child.dataset.childBoard);
    });
    surfaces.querySelector("[data-surface=content]").onclick = () => {
      this.surface = "content";
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
      const selected = this.selection.has(p.id),
        unavailable = ["reserved", "building"].includes(item.build?.state),
        handoff = resourceURL(
          item.resources?.find((r) => r.role === "handoff")?.resource,
        ),
        live =
          this.mode === "grid" &&
          !unavailable &&
          !img &&
          item.content?.kind === "html" &&
          item.content?.resource &&
          !item.content?.url;
      return `<article class="workspace-card ${selected ? "selected" : ""}" data-key="${esc(c.key)}" data-placement="${esc(p.id)}" data-build-state="${esc(item.build?.state || "ready")}" style="${this.mode === "canvas" ? `left:${p.x + this.origin.x}px;top:${p.y + this.origin.y}px;width:${p.width}px;height:${p.height}px;z-index:${p.z};` : ""}"><header><button type="button" data-placement-select="${esc(p.id)}" aria-pressed="${selected}" aria-label="${selected ? "Deselect" : "Select"} ${esc(item.title)}">${selected ? "✓" : "□"}</button><span class="workspace-concept-number">${esc(c.number)}</span><span>${esc(item.category || item.content?.kind || "Idea")}${item.childBoardId ? " · Board" : ""}</span><button type="button" class="workspace-drag" data-drag="${esc(p.id)}" aria-label="Drag ${esc(item.title)}" title="Drag to move on canvas">⠿</button></header><div class="workspace-card-preview ${live ? "workspace-live-preview" : ""}">${unavailable ? `<div class="workspace-build-placeholder"><strong>${item.build.state === "building" ? "Taking shape." : "A place for a new idea."}</strong><span>${esc(item.build.message || "This slot will open when it is ready for review.")}</span></div>` : live ? `<iframe src="${esc(this.hooks.preview(c))}" title="${esc(item.title)} live preview" tabindex="-1" loading="lazy" inert></iframe>` : img || (url && item.content.kind === "image") ? `<img src="${esc(img || url)}" alt="">` : item.childBoardId ? '<span class="workspace-paper-art" aria-hidden="true">▱ ▱</span>' : `<span class="workspace-title-art">${esc(item.preview?.text || item.title)}</span>`}<button type="button" class="workspace-preview-launch" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="Open ${esc(item.title)}"><span>Open ${esc(item.title)} ↗</span></button></div><div class="workspace-card-copy"><h3><button type="button" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}">${esc(item.title)}</button></h3><p>${esc(item.description)}</p>${item.question ? `<p class="workspace-question">${esc(item.question)}</p>` : ""}${handoff ? `<a class="workspace-handoff" href="${esc(handoff)}" target="_blank" rel="noopener noreferrer">Handoff ↗</a>` : ""}${item.childBoardId ? `<button type="button" class="workspace-child" data-child-board="${esc(item.childBoardId)}">Open board ↗</button>` : ""}<div class="workspace-review"><button type="button" class="shortlist" data-star="${esc(c.key)}" aria-label="Favorite ${esc(item.title)}" aria-pressed="${!!item.review?.star}">${item.review?.star ? "★" : "☆"}</button><label><span class="sr-only">Notes on ${esc(item.title)}</span><textarea data-note="${esc(c.key)}" aria-label="Notes on ${esc(item.title)}" placeholder="A thought to return to…">${esc(item.review?.note || "")}</textarea></label></div><div class="workspace-card-meta"><span title="${esc(item.build?.message)}">${esc(item.build?.state || "ready")}${item.revisions?.length ? " · " + item.revisions.length + " versions" : ""}</span><button data-edit-item="${esc(item.id)}" type="button">Edit</button><button data-geometry="${esc(p.id)}" type="button">Move / resize</button></div></div>${this.mode === "canvas" ? `<button type="button" class="workspace-resize" data-resize="${esc(p.id)}" aria-label="Resize ${esc(item.title)}">◢</button>` : ""}</article>`;
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
  }
  sizePreviews() {
    this.previewObserver?.disconnect();
    this.previewObserver = new ResizeObserver((entries) => {
      for (const { target } of entries)
        target.style.setProperty(
          "--preview-scale",
          String(target.clientWidth / 1000),
        );
    });
    document.querySelectorAll(".workspace-live-preview").forEach((el) => {
      el.style.setProperty("--preview-scale", String(el.clientWidth / 1000));
      this.previewObserver.observe(el);
    });
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
  geometry(id) {
    const p = this.snapshot.placements.find((p) => p.id === id);
    if (!p) return;
    makeDialog(
      "Move or resize this placement",
      `<p>Change this card’s position and size on Canvas. Grid and comparison order stay the same.</p><div class="workspace-field-grid">${["x", "y", "width", "height", "z"].map((k) => `<label>${k[0].toUpperCase() + k.slice(1)}<input name="${k}" type="number" step="1" value="${p[k]}" ${["width", "height"].includes(k) ? 'min="160" max="10000"' : 'min="-100000" max="100000"'} required></label>`).join("")}</div><button type="submit" class="workspace-primary">Save placement</button>`,
      async (f) => {
        const patch = Object.fromEntries(
          ["x", "y", "width", "height", "z"].map((k) => [k, Number(f.get(k))]),
        );
        await this.client.write("updatePlacement", {
          boardId: this.snapshot.id,
          placementId: id,
          patch,
        });
        await this.refresh();
      },
    );
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
        const preview = e.target.closest(".workspace-preview-launch");
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
              width: Math.max(160, Math.round(drag.p.width + dx)),
              height: Math.max(180, Math.round(drag.p.height + dy)),
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
      "pointercancel",
      (e) => {
        if (drag?.pointerId === e.pointerId) cancel();
      },
      true,
    );
  }
  decorations() {
    return (this.snapshot.decorations || [])
      .map(
        (d) =>
          `<div class="workspace-decoration decoration-${esc(d.type || "text")}" data-decoration="${esc(d.id)}" style="left:${Number(d.x || 0) + this.origin.x}px;top:${Number(d.y || 0) + this.origin.y}px;width:${Number(d.width || 300)}px;height:${Number(d.height || 80)}px;--decoration-color:${/^#[0-9a-f]{3,8}$/i.test(d.color) ? d.color : "#cfd8bf"}"><span>${esc(d.text || "")}</span><button type="button" data-decoration-edit="${esc(d.id)}" aria-label="Edit ${esc(d.type || "text")} decoration">Edit</button></div>`,
      )
      .join("");
  }
  boardTools() {
    makeDialog(
      "Board tools",
      `<p>Spatial marks describe your arrangement. They do not change an item’s workflow status.</p><div class="workspace-inline-actions"><button type="button" data-new-decoration="text">Add text</button><button type="button" data-new-decoration="region">Add region</button><button type="button" data-new-decoration="line">Add line</button><button type="button" data-background>Background…</button><button type="button" data-review-order>Comparison order…</button></div><p class="workspace-eyebrow">Decorations</p>${(this.snapshot.decorations || []).map((d) => `<p><button type="button" data-decoration-edit="${esc(d.id)}">Edit ${esc(d.text || d.type)}</button></p>`).join("")}`,
    );
    document.querySelectorAll("[data-new-decoration]").forEach(
      (b) =>
        (b.onclick = () => {
          b.closest("dialog").close();
          this.decorationForm({ type: b.dataset.newDecoration });
        }),
    );
    document.querySelector("[data-background]").onclick = (e) => {
      e.target.closest("dialog").close();
      this.backgroundForm();
    };
    document.querySelector("[data-review-order]").onclick = (e) => {
      e.target.closest("dialog").close();
      this.orderForm();
    };
    document.querySelectorAll("[data-decoration-edit]").forEach(
      (b) =>
        (b.onclick = () => {
          b.closest("dialog")?.close();
          this.decorationForm(
            this.snapshot.decorations.find(
              (d) => d.id === b.dataset.decorationEdit,
            ),
          );
        }),
    );
  }
  decorationForm(input = { type: "text" }) {
    const d = {
      id: crypto.randomUUID(),
      x: 30,
      y: 30,
      width: 320,
      height: input.type === "line" ? 2 : 100,
      color: "#cfd8bf",
      text: "",
      ...input,
    };
    makeDialog(
      "Edit " + d.type,
      `<label>Text<input name="text" value="${esc(d.text)}"></label><div class="workspace-field-grid">${["x", "y", "width", "height"].map((k) => `<label>${k}<input name="${k}" type="number" value="${d[k]}" min="${["width", "height"].includes(k) ? 1 : -100000}" max="100000" required></label>`).join("")}</div><label>Color<input name="color" type="color" value="${d.color}"></label><button type="submit" class="workspace-primary">Save ${d.type}</button>${input.id ? '<button type="button" data-delete-decoration>Remove decoration</button>' : ""}`,
      async (f) => {
        const value = { ...d, text: f.get("text"), color: f.get("color") };
        for (const k of ["x", "y", "width", "height"])
          value[k] = Number(f.get(k));
        const list = this.snapshot.decorations.filter((x) => x.id !== d.id);
        list.push(value);
        await this.client.write("updateBoard", {
          boardId: this.snapshot.id,
          patch: { decorations: list },
        });
        this.setMode("canvas", false);
        await this.refresh();
      },
    );
    document
      .querySelector("[data-delete-decoration]")
      ?.addEventListener("click", async (e) => {
        try {
          await this.client.write("updateBoard", {
            boardId: this.snapshot.id,
            patch: {
              decorations: this.snapshot.decorations.filter(
                (x) => x.id !== d.id,
              ),
            },
          });
          e.target.closest("dialog").close();
          await this.refresh();
        } catch (error) {
          showFailure(error);
        }
      });
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
