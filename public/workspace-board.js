import {Whiteboard,decorationMarkup,lineBox} from "./whiteboard.js";
import {decorationBounds,resolveLine} from "./whiteboard-geometry.js";
import {FeedbackController} from "./feedback.js";
import {newestBoardsFirst} from "./board-order.js";
import {reconcileChildren} from "./reconcile.js";
import {coverMarkup, observeCovers} from "./board-covers.js";
import {eventFiles,hasFileDrag,validateImportFiles,importLayout,pdfSupported,pdfPreviewURL} from "./file-import.js";
import {CutIntent} from "./cut-intent.js";
import {MovementHistory} from "./movement-history.js";
import {CLIPBOARD_MIME,CLIPBOARD_PREFIX,clipboardBytes,readClipboard,externalClipboard} from "./clipboard.js";
import {
  WorkspaceClient,
  escape as esc,
  resourceURL,
  remoteURL,
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
    this.history = new MovementHistory(this.client,config.workspaceId,() => this.updateHistoryControls());
    this.client.onState = () => { this.updateHistoryControls(); this.hooks.liveReady?.(); };
    this.selection = new Set();
    this.cutIntent = new CutIntent(config.workspaceId,snapshot.workspaceId,()=>this.syncCutMarks());
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
    // Replays and external moves can detach selected placements. Keep valid
    // selections, including filtered/archived ones, but never count absent cards.
    for (const id of this.selection) {
      const p = byId.get(id), item = items[p?.itemId];
      if (!p || p.removedAt || p.deletedAt || !item || item.deletedAt) this.selection.delete(id);
    }
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
        category: item.category || item.content?.kind || (item.childBoardId ? "Board" : "Idea"),
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
      "Board canvas: scroll to pan, pinch or Control-scroll to zoom; drag a card to move it or drop it into a board",
    );
    $("help-panel").innerHTML =
      "<strong>Make yourself at home.</strong> Scroll with your mouse or trackpad, or swipe the background on a touch screen, to move around Canvas; Shift-scroll moves sideways. Pinch, or hold Control or ⌘ while scrolling, to zoom. Drag a card’s body to move it; drop inside a highlighted board to move the item into it. Escape cancels a drag. Notes and buttons keep their usual behavior. A click opens a preview. Select an item and use arrow keys to move it, or drag its corner to resize. Move… in the selection toolbar also moves items into boards. Double-click text or a region label to edit it. Grid shows newer boards first, keeping other items in comparison order. Open an item to try it, then step with Previous, Next or the dots. Escape returns here. Stars and notes follow the item across references.";
    const bar = document.createElement("section");
    $("help-panel").append(" Use ⌘/Ctrl-X to cut selected Tinkas, then paste on another board to move them together. Originals stay safe until paste succeeds. Escape or ⌘/Ctrl-Z cancels a pending cut; text fields keep their normal cut.");
    $("help-panel").append(" Copy selected Tinkas with ⌘/Ctrl-C, then paste here or in another board with ⌘/Ctrl-V. Copies retain their arrangement and use the same files. A pasted link gets a saved representation; pasted text becomes a document. Undo also reverses paste. Text fields keep their normal clipboard.");
    $("help-panel").append(" Select several cards and drag a selected card to carry them together, into a board or onto Parent. An unselected card, resize or held cover child still acts alone.");
    $("help-panel").append(" With a mouse or pen, drag a box on empty Canvas space to select cards. Hold Shift when starting to add to your selection; Escape cancels. An empty click clears selection. Unused colored-region interiors also work; use a region’s label or border to move it. Touch keeps swiping and pinching.");
    $("help-panel").append(" The bottom name bar also drags; a title click opens the item. Right-click a card for its notes and appearance. Use ⌘/Ctrl-Z to undo movement and Shift-⌘/Ctrl-Z to redo, or find Undo/Redo in Tools. This tab remembers movements across boards; text fields keep their own undo. Delete or Backspace removes the visible selection from this board; ⌘/Ctrl-Z restores it. New-board creation and canonical deletion are outside movement history.");
    bar.id = "workspace-toolbar";
    bar.className = "workspace-toolbar";
    bar.setAttribute("aria-label", "Organize this board");
    bar.innerHTML = `<div class="workspace-segments"><button data-mode="grid">Grid</button><button data-mode="canvas">Canvas</button></div><label class="workspace-search"><span class="sr-only">Search items</span><input type="search" placeholder="Find a title or text…" id="workspace-search"></label><button id="workspace-favorites" aria-pressed="false">☆ Favorites</button><button id="workspace-recent" aria-pressed="false">Last 6 weeks</button><button id="workspace-archive" aria-pressed="false">Archive</button><button id="workspace-owner" hidden>Open primary content</button><button id="workspace-retry-drafts" hidden>Retry unsaved feedback</button>`;
    $("board-info").prepend(bar);
    const add = document.createElement("button");
    add.id = "workspace-add";
    add.type = "button";
    add.textContent = "+ Add";
    add.setAttribute("aria-haspopup", "menu");
    add.setAttribute("aria-expanded", "false");
    bar.prepend(add);
    const history = document.createElement("div");
    history.className = "workspace-history-actions";
    history.innerHTML = '<button type="button" id="workspace-undo" disabled>Undo</button><button type="button" id="workspace-redo" disabled>Redo</button>';
    bar.append(history);
    this.installClipboard(bar);
    this.installFileDrop();
    $("workspace-undo").onclick = () => this.replayMovement("undo");
    $("workspace-redo").onclick = () => this.replayMovement("redo");
    this.updateHistoryControls();
    this.installBoardCommands(bar);
    document.addEventListener("keydown", e => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z" ||
          e.target.closest("input,textarea,select,[contenteditable],[role=dialog]") || document.querySelector("dialog[open]")) return;
      // Browser text editing keeps its own undo; movement replay is available
      // only when no pointer gesture or operation is still being committed.
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.pointerGesture || this.decorationGesture || this.movePending || this.historyBusy || this.pasteBusy || this.history?.busy || this.client.pendingWrites || this.saving) return;
      if (!e.shiftKey && this.cutIntent.active()) { this.cancelCut(); return; }
      this.replayMovement(e.shiftKey ? "redo" : "undo");
    }, true);
    add.onclick = () => {
      // Anchor the creation menu to the still-visible Tools control before closing its drawer.
      this.addMenu($("board-info-toggle"));
      $("board-info").hidden = true;
      $("board-info-toggle").setAttribute("aria-expanded", "false");
    };
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && this.addPopup) {
        this.closeAddMenu();
        $("board-info-toggle").focus({ preventScroll: true });
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
    const selected = document.createElement("section");
    selected.id = "workspace-selection";
    selected.className = "workspace-selection";
    selected.hidden = true;
    selected.setAttribute("aria-label", "Selected placements");
    $("canvas-header").after(selected);
    const surfaces = document.createElement("div");
    surfaces.id = "workspace-surfaces";
    surfaces.className = "workspace-surfaces";
    surfaces.hidden = true;
    surfaces.innerHTML =
      '<button data-surface="content">Content</button><button data-surface="board">Board</button><button data-reader-organize>Organize…</button><button data-reader-edit>Edit item…</button><button data-reader-children>Add board…</button>';
    $("view-controls").append(surfaces);
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
      const feedback = e.target.closest("[data-item-feedback]");
      if (feedback) this.feedback.open({itemId:feedback.dataset.itemFeedback});
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
    this.whiteboard = new Whiteboard(this);
    this.whiteboard.mount();
    this.pointer();
    this.canvasEditing();
    document.addEventListener("focusout", () => queueMicrotask(() => { this.drainGeometryRefresh(); this.hooks.liveReady?.(); }));
    this.feedback = new FeedbackController({client:this.client,getBoard:()=>this.snapshot,
      getOrigin:()=>this.origin,screenToCanvas:point=>this.canvasPoint(point),
      getMode:()=>this.mode,refresh:()=>this.refresh({saveReview:false})});
    this.feedback.mount({toolbar:bar,world:$("world"),viewport:$("viewport")});
    this.feedback.reload().catch(error=>console.warn("Feedback unavailable:",error.message));
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
      const ws = this.workspaceGraph?.revision === this.snapshot.revision ? this.workspaceGraph : await this.client.get("/api/workspace?view=graph&covers=0");
      if (!this.workspaceGraph || ws.revision >= this.workspaceGraph.revision)
        this.workspaceGraph = ws;
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
      this.resolvedParent = parent ? {id:parent.id, title:parent.title} : null;
      let crumb = $("workspace-parent");
      if (!crumb) {
        crumb = document.createElement("a");
        crumb.id = "workspace-parent";
        crumb.className = "workspace-parent";
        $("board-title").before(crumb);
      }
      crumb.hidden = !parents.length;
      crumb.onclick = null;
      crumb.onkeydown = null;
      crumb.removeAttribute("role");
      if (parent) {
        crumb.textContent = "← Parent";
        crumb.href = `/boards/${encodeURIComponent(parent.id)}/`;
        crumb.setAttribute("aria-label", "Return to parent board " + parent.title);
        crumb.title = "Return to " + parent.title +
          (parents.length > 1 ? " · also appears on " + (parents.length - 1) + " other boards" : "");
      } else if (parents.length > 1) {
        crumb.textContent = "← Parents";
        crumb.href = "#parents";
        crumb.setAttribute("role", "button");
        crumb.setAttribute("aria-label", "Choose a parent board");
        crumb.title = "Choose from " + parents.length + " parent boards";
        crumb.onclick = event => {
          event.preventDefault();
          makeDialog("This board appears on", parents.map(p =>
            `<p><a href="/boards/${encodeURIComponent(p.id)}/">${esc(p.title)} ↗</a></p>`
          ).join(""));
        };
        crumb.onkeydown = event => { if (event.key === " ") { event.preventDefault(); crumb.click(); } };
      }

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
  async refresh({ saveReview = true } = {}) {
    // A live refresh must not reset an in-progress pointer gesture.
    if (this.pointerGesture || this.decorationGesture || this.moveCommitting) { this.pointerRefreshPending = true; return; }
    if (saveReview && this.pendingReview.size && !this.saving) await this.saveReview([], {});
    const snapshot = await this.client.get(
      `/api/boards/${encodeURIComponent(this.snapshot.id)}`,
    );
    if (this.pointerGesture || this.decorationGesture || this.moveCommitting) { this.pointerRefreshPending = true; return; }
    // A read started before a completed operation must not roll its UI back.
    if (snapshot.revision < Math.max(this.snapshot.revision, this.client.revision)) return;
    this.pointerRefreshPending = false;
    this.hooks.data(this.adapt(snapshot));
    await this.loadCrumb();
    if (this.feedback) await this.feedback.reload();
  }
  liveBlocked() {
    return !!(this.pointerGesture || this.decorationGesture || this.decorationCommitting || this.moveCommitting || this.movePending ||
      this.client.pendingWrites || this.historyBusy || this.history?.busy || this.pasteBusy || this.saving ||
      document.activeElement?.closest("input,textarea,select,[contenteditable]") || document.querySelector("dialog.workspace-dialog[open]"));
  }
  syncGeometry(overrides) {
    this.whiteboard?.sync(overrides);
    this.feedback?.sync(overrides);
  }
  drainGeometryRefresh() {
    this.hooks.liveReady?.();
    if (!this.pointerRefreshPending || this.liveBlocked()) return;
    this.pointerRefreshPending = false;
    this.refresh({saveReview:false}).catch(error => toast(error.message));
  }
  renderedPlacements() {
    const rendered = new Set([...$("world").querySelectorAll(".workspace-card[data-placement]")].map(card => card.dataset.placement));
    return this.snapshot.placements.filter(p => rendered.has(p.id) && !p.removedAt && !p.deletedAt &&
      this.snapshot.items[p.itemId] && !this.snapshot.items[p.itemId].deletedAt);
  }
  clipboardCandidates() {
    return this.renderedPlacements().filter(p => this.selection.has(p.id));
  }
  boardCommandBlocked(event) {
    return this.clipboardBlocked() || this.history?.busy ||
      event?.target.closest?.("input,textarea,select,[contenteditable],[role=textbox],[role=dialog]") ||
      document.activeElement?.closest("[role=textbox]");
  }
  installBoardCommands(bar) {
    const guide = document.createElement("button");
    guide.type = "button";
    guide.id = "workspace-keyboard-shortcuts";
    guide.textContent = "Keyboard shortcuts";
    guide.onclick = () => { if (!this.boardCommandBlocked()) this.keyboardShortcuts(); };
    bar.append(guide);
    document.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229 || event.altKey) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (command && !event.shiftKey && key === "d") {
        const editing = "input,textarea,select,[contenteditable],[role=textbox],[role=dialog]";
        if (event.target.closest?.(editing) || document.activeElement?.closest(editing) ||
            document.activeElement?.tagName === "IFRAME" || document.querySelector("dialog[open]") ||
            !this.clipboardCandidates().length) return;
        // Board-owned Duplicate never falls through to browser Bookmark while
        // a held key or an in-flight action suppresses another duplication.
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat && !this.boardCommandBlocked(event)) this.duplicateSelection();
        return;
      }
      if (event.repeat || this.boardCommandBlocked(event)) return;
      let action;
      if (command && !event.shiftKey && key === "a")
        action = () => {
          this.selection = new Set(this.renderedPlacements().map(p => p.id));
          this.syncSelection();
          this.selectionMenu();
        };
      else if (!command && !event.shiftKey && key === "enter" &&
          !event.target.closest?.("button,a,[role=button]") && this.clipboardCandidates().length === 1) {
        const id = this.clipboardCandidates()[0].id;
        const card = [...$("world").querySelectorAll(".workspace-card[data-placement]")].find(card => card.dataset.placement === id);
        const open = card?.querySelector("[data-open]:not(:disabled)");
        if (open) action = () => open.click();
      } else if (!command && !event.shiftKey && key === "/") action = () => {
        $("board-info").hidden = false;
        $("board-info-toggle").setAttribute("aria-expanded","true");
        $("workspace-search").focus({preventScroll:true});
      };
      else if (!command && event.shiftKey && (key === "!" || key === "1") && this.mode === "canvas")
        action = () => $("fit").click();
      else if (!command && key === "?") action = () => this.keyboardShortcuts();
      if (!action) return;
      event.preventDefault(); event.stopImmediatePropagation();
      action();
    }, true);
  }
  keyboardShortcuts() {
    const previousFocus = document.activeElement;
    const returnFocus = $("board-info").contains(previousFocus) ? $("board-info-toggle") : previousFocus;
    $("board-info").hidden = true;
    $("board-info-toggle").setAttribute("aria-expanded","false");
    const dialog = makeDialog("Keyboard shortcuts", `<p>Use these keys while working on a board. Text fields and previews keep their normal keys.</p>
      <dl><dt>⌘/Ctrl-A</dt><dd>Select all visible Tinkas</dd>
      <dt>⌘/Ctrl-D</dt><dd>Duplicate selection</dd>
      <dt>Enter</dt><dd>Open one selected Tinka</dd>
      <dt>/</dt><dd>Search this board</dd>
      <dt>Shift-1</dt><dd>Fit the canvas</dd>
      <dt>?</dt><dd>Show keyboard shortcuts</dd>
      <dt>⌘/Ctrl-C · X · V</dt><dd>Copy · Cut · Paste</dd>
      <dt>Delete / Backspace</dt><dd>Remove selection from this board</dd>
      <dt>⌘/Ctrl-Z · Shift-⌘/Ctrl-Z</dt><dd>Undo · Redo</dd>
      <dt>Arrow keys · Shift-Arrow</dt><dd>Move selection 1 · 10 units</dd>
      <dt>Escape</dt><dd>Cancel a gesture, pending Cut or selection</dd></dl>`);
    dialog.addEventListener("close", () => {
      if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
    });
    return dialog;
  }
  clipboardBlocked() {
    return this.pointerGesture || this.decorationGesture || this.movePending || this.historyBusy || this.pasteBusy ||
      this.client.pendingWrites || this.saving || document.querySelector("dialog[open]") ||
      document.activeElement?.closest("input,textarea,select,[contenteditable],[role=dialog]") ||
      document.activeElement?.tagName === "IFRAME";
  }
  copySnapshot({cut=false} = {}) {
    const placements = this.clipboardCandidates();
    if (!placements.length) return null;
    const items = {}, boards = {};
    for (const p of placements) {
      const item = this.snapshot.items[p.itemId];
      items[item.id] = structuredClone(item);
      if (this.pendingReview.has(item.id)) items[item.id].review = {...item.review,...this.pendingReview.get(item.id)};
      if (!item.childBoardId || cut) continue;
      const board = this.snapshot.childBoards?.[item.childBoardId];
      if (this.workspaceGraph?.revision !== this.snapshot.revision || !board) {
        this.refresh({saveReview:false}).catch(() => {});
        throw new Error("Loading this board’s layout. Copy the selection again when it is ready.");
      }
      boards[board.id] = structuredClone(board);
    }
    const selected = new Set(placements.map(p => p.id));
    const order = [...new Set([...(this.snapshot.reviewOrder || []),...selected])].filter(id => selected.has(id));
    const clipboard = {version:1,workspaceId:this.snapshot.workspaceId,placements:structuredClone(placements),items,boards,reviewOrder:order};
    if (clipboardBytes(clipboard) > 900000) throw new Error("This selection is too large to paste at once. Copy fewer Tinkas.");
    return clipboard;
  }
  installClipboard(bar) {
    const controls = document.createElement("div");
    controls.className = "workspace-clipboard-actions";
    controls.innerHTML = '<button type="button" id="workspace-copy" disabled>Copy selection</button><button type="button" id="workspace-paste">Paste…</button>';
    bar.append(controls);
    $("workspace-copy").onclick = () => {
      if (!document.execCommand("copy")) toast("Use ⌘/Ctrl-C to copy the selected Tinkas.");
    };
    $("workspace-paste").onclick = () => {
      $("board-info").hidden = true;
      $("board-info-toggle").setAttribute("aria-expanded","false");
      $("viewport").focus({preventScroll:true});
      toast("Press ⌘/Ctrl-V here to paste Tinkas, a link, or text.");
    };
    document.addEventListener("copy", e => {
      if (this.clipboardBlocked() || e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]")) return;
      this.cutIntent.clear();
      try {
        const clipboard = this.copySnapshot();
        if (!clipboard || !e.clipboardData) return;
        const json = JSON.stringify(clipboard);
        e.clipboardData.clearData?.();
        try { e.clipboardData.setData(CLIPBOARD_MIME,json); } catch {}
        e.clipboardData.setData("text/plain",CLIPBOARD_PREFIX + json);
        e.preventDefault();
        toast(`Copied ${clipboard.placements.length} ${clipboard.placements.length === 1 ? "Tinka" : "Tinkas"}.`);
      } catch (error) { toast(error.message); }
    });
    document.addEventListener("cut", e => {
      if (this.clipboardBlocked() || e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]")) return;
      this.cutIntent.clear();
      try {
        const clipboard=this.copySnapshot({cut:true});
        if (!clipboard || !e.clipboardData) return;
        const owner=this.snapshot.items[this.snapshot.ownerItemId];
        if (owner?.archivedAt || owner?.deletedAt || clipboard.placements.some(p=>p.archivedAt || this.snapshot.items[p.itemId]?.archivedAt))
          throw new Error("Restore archived Tinkas and their board before cutting them. Copy remains available.");
        clipboard.placements=clipboard.reviewOrder.map(id=>clipboard.placements.find(p=>p.id===id));
        const envelope=this.cutIntent.prepare(clipboard,this.snapshot.id), json=JSON.stringify(envelope);
        if (clipboardBytes(envelope)>900000) throw new Error("This cut selection is too large. Select fewer Tinkas.");
        e.clipboardData.clearData?.();
        try { e.clipboardData.setData(CLIPBOARD_MIME,json); } catch {}
        e.clipboardData.setData("text/plain",CLIPBOARD_PREFIX+json);
        e.preventDefault();
        this.cutIntent.changed();
        toast(`Cut ${clipboard.placements.length} ${clipboard.placements.length===1 ? "Tinka" : "Tinkas"}. Paste on another board to move; Escape cancels.`);
      } catch(error) { this.cutIntent.clear(); toast(error.message); }
    });
    window.addEventListener("storage",e=>{if(e.key===this.cutIntent.key || e.key===null)this.syncCutMarks();});
    document.addEventListener("keydown",e=>{
      if(e.key!=="Escape" || this.clipboardBlocked() || e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]") || !this.cutIntent.active()) return;
      this.cancelCut();
    });
    document.addEventListener("paste", e => {
      if (this.clipboardBlocked() || e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]")) return;
      const files = eventFiles(e.clipboardData);
      if (files.length) {
        this.cutIntent.clear();
        e.preventDefault();
        try { validateImportFiles(files,{clipboard:true}); } catch (error) { toast(error.message); return; }
        this.importMedia(files);
        return;
      }
      let source;
      try { source = readClipboard(e.clipboardData,this.snapshot.workspaceId); }
      catch (error) { e.preventDefault(); toast(error.message); return; }
      if (!source) { this.cutIntent.clear(); return; }
      e.preventDefault();
      if (source.kind === "cut") this.pasteCut(source.clipboard);
      else { this.cutIntent.clear(); this.pasteClipboard(source); }
    });
    window.addEventListener("pagehide", () => { this.pasteCancelled = true; this.pasteController?.abort(); });
  }
  cancelCut() {
    const intent=this.cutIntent.active();
    this.cutIntent.clear(intent);
    toast(intent?.operation ? "Cut marking cleared. Check the source and destination boards for the submitted move." : "Cut cancelled. The originals stay on their board.");
  }
  syncCutMarks() {
    const intent=this.cutIntent?.active();
    let ids=new Set();
    if(intent?.sourceBoardId===this.snapshot.id) {
      try { ids=new Set(JSON.parse(intent.payload).placements.map(p=>p.id)); } catch {}
    }
    for(const card of $("world")?.querySelectorAll(".workspace-card[data-placement]") || []) {
      const marked=ids.has(card.dataset.placement);
      card.classList.toggle("workspace-cut-pending",marked);
      if(marked) {card.dataset.cutPending="true";card.setAttribute("aria-description","Cut pending. Paste on another board to move.");}
      else {delete card.dataset.cutPending;card.removeAttribute("aria-description");}
    }
  }
  async pasteCut(clipboard) {
    this.pasteBusy=true;
    this.movePending=true;
    this.updateHistoryControls();
    let moved=false;
    try {
      await this.cutIntent.locked(clipboard,async intent=>{
        if(intent.sourceBoardId===this.snapshot.id) {toast("Open another board to paste this cut selection. The cut is still pending.");return;}
        if(intent.operation && intent.operation.targetBoardId!==this.snapshot.id)
          throw new Error("The previous move could not be confirmed. Paste on that same destination board to check it before trying elsewhere.");
        await this.refresh({saveReview:false});
        let operation=intent.operation;
        if(!operation) {
          operation={sourceBoardId:intent.sourceBoardId,placementIds:clipboard.placements.map(p=>p.id),targetBoardId:this.snapshot.id,
            targetPosition:this.pastePosition(clipboard),expectedSourcePlacements:clipboard.placements,expectedSourceReviewOrder:clipboard.reviewOrder};
          const patch={operation,operationId:crypto.randomUUID(),state:"inflight"};
          if(!this.cutIntent.update(intent,patch)) throw new Error("This cut was replaced. Cut the selection again.");
          intent={...intent,...patch};
        }
        if(intent.state!=="inflight") {
          if(!this.cutIntent.update(intent,{state:"inflight"})) throw new Error("This cut was replaced. Cut the selection again.");
          intent={...intent,state:"inflight"};
        }
        this.moveCommitting=true;
        let response;
        try {
          response=await this.client.write("move",operation,{recordHistory:false,includeHistory:true,operationId:intent.operationId});
        } catch(error) {
          this.cutIntent.update(intent,error.rejected ? {state:"pending",operation:null,operationId:null} : {state:"uncertain"});
          throw error;
        }
        moved=true;
        if(response.history) this.history.record(response.history,{type:"move",data:operation},intent.operationId);
        this.cutIntent.consume(intent);
        this.moveCommitting=false;
        this.filters={search:"",favorites:false,recent:false,archive:false};
        $("workspace-search").value="";
        for(const id of ["workspace-favorites","workspace-recent","workspace-archive"])$(id).setAttribute("aria-pressed","false");
        this.selection=new Set(response.result.placementIds || []);
        await this.refresh({saveReview:false});
        this.hooks.revealPlacements?.(this.snapshot.placements.filter(p=>this.selection.has(p.id)));
        toast(`Moved ${clipboard.placements.length} ${clipboard.placements.length===1 ? "Tinka" : "Tinkas"} here.`);
      });
    } catch(error) {
      this.moveCommitting=false;
      try {await this.refresh({saveReview:false});}catch{}
      toast(moved ? "Move saved. Reload the board to see it." : error.rejected ? `Cut not moved. ${error.message} Cut the selection again if its source changed.` : this.cutIntent.active()?.state === "uncertain" ? "Could not confirm the cut move. Paste on this same board to check it before trying elsewhere." : error.message || "Could not confirm the cut move.");
    } finally {
      this.moveCommitting=false;
      this.movePending=false;
      this.pasteBusy=false;
      this.syncCutMarks();
      this.updateHistoryControls();
    }
  }
  installFileDrop() {
    const viewport = $("viewport"), hint = document.createElement("div");
    hint.id = "workspace-import-drop";
    hint.className = "workspace-import-drop";
    hint.hidden = true;
    hint.setAttribute("role","status");
    document.body.append(hint);
    const clear = () => { hint.hidden = true; };
    const blocked = target => this.clipboardBlocked() || target.closest?.("input,textarea,select,[contenteditable],[role=dialog]") ? "Finish editing or the current action before importing files." : "";
    const show = e => {
      if (!hasFileDrag(e.dataTransfer)) return;
      if (e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]")) { clear(); return; }
      e.preventDefault();
      const message = blocked(e.target), rect = viewport.getBoundingClientRect();
      hint.textContent = message || "Drop images or PDFs onto this board";
      hint.dataset.state = message ? "blocked" : "ready";
      Object.assign(hint.style,{left:rect.left+"px",top:rect.top+"px",width:rect.width+"px",height:rect.height+"px"});
      hint.hidden = false;
      e.dataTransfer.dropEffect = message ? "none" : "copy";
    };
    viewport.addEventListener("dragenter",show);
    viewport.addEventListener("dragover",show);
    viewport.addEventListener("dragleave",e=>{if (!e.relatedTarget || !viewport.contains(e.relatedTarget)) clear();});
    viewport.addEventListener("drop",e=>{
      if (!hasFileDrag(e.dataTransfer)) return;
      if (e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]")) { clear(); return; }
      const files = eventFiles(e.dataTransfer), point = this.mode === "canvas" ? this.canvasPoint({x:e.clientX,y:e.clientY}) : undefined;
      e.preventDefault();
      clear();
      const message = blocked(e.target);
      if (message) { toast(message); return; }
      try { validateImportFiles(files); } catch (error) { toast(error.message); return; }
      this.importMedia(files,point);
    });
    document.addEventListener("dragend",clear);
    document.addEventListener("keydown",e=>{if(e.key === "Escape") clear();});
    window.addEventListener("blur",clear);
    window.addEventListener("pagehide",clear);
  }
  async importMedia(files, point) {
    this.pasteBusy = true;
    this.pasteCancelled = false;
    this.movePending = true;
    this.pasteController = new AbortController();
    this.updateHistoryControls();
    let written = false;
    try {
      toast(`Importing ${files.length === 1 ? "file" : files.length + " files"}…`);
      const placements = await importLayout(files);
      if (this.pasteCancelled) return;
      await this.refresh({saveReview:false});
      if (this.pasteCancelled) return;
      const targetPosition = point || this.pastePosition({placements});
      this.moveCommitting = true;
      const result = await this.client.importFiles(files,{workspaceId:this.snapshot.workspaceId,targetBoardId:this.snapshot.id,targetPosition,placements},this.pasteController.signal);
      written = true;
      this.moveCommitting = false;
      this.filters = {search:"",favorites:false,recent:false,archive:false};
      $("workspace-search").value = "";
      for (const id of ["workspace-favorites","workspace-recent","workspace-archive"]) $(id).setAttribute("aria-pressed","false");
      this.selection = new Set(result.placementIds || []);
      await this.refresh({saveReview:false});
      this.hooks.revealPlacements?.(this.snapshot.placements.filter(p=>this.selection.has(p.id)));
      toast(`Imported ${files.length} ${files.length === 1 ? "file" : "files"}.`);
    } catch (error) {
      this.moveCommitting = false;
      if (this.pasteCancelled) return;
      try { await this.refresh({saveReview:false}); } catch {}
      toast(written ? "Files imported. Reload the board to see them." : error.rejected || error.conflict ? `Import not saved. ${error.message}` :
        `Could not confirm the import. Check the latest board before trying again. ${error.message}`);
    } finally {
      this.pasteBusy = false;
      this.movePending = false;
      this.moveCommitting = false;
      this.pasteController = null;
      this.updateHistoryControls();
    }
  }
  pastePosition(clipboard) {
    const placements = clipboard.placements, x = Math.min(...placements.map(p => p.x)), y = Math.min(...placements.map(p => p.y));
    const width = Math.max(...placements.map(p => p.x + p.width)) - x, height = Math.max(...placements.map(p => p.y + p.height)) - y;
    const viewport = $("viewport").getBoundingClientRect();
    const top = this.canvasPoint({x:viewport.left + 24,y:viewport.top + 24});
    const bottom = this.canvasPoint({x:viewport.right - 24,y:viewport.bottom - 24});
    const occupied = this.snapshot.placements.filter(p => !p.removedAt && !p.deletedAt && !p.archivedAt);
    const free = point => !occupied.some(p => point.x < p.x + p.width + 16 && point.x + width + 16 > p.x &&
      point.y < p.y + p.height + 16 && point.y + height + 16 > p.y);
    const center = {x:Math.round((top.x + bottom.x - width) / 2),y:Math.round((top.y + bottom.y - height) / 2)};
    const previous = this.lastPastePosition;
    const inside = point => point.x >= top.x && point.y >= top.y && point.x + width <= bottom.x && point.y + height <= bottom.y;
    const next = previous && {x:previous.x + 32,y:previous.y + 32};
    if (next && inside(next) && free(next)) return next;
    const candidates = [];
    // At most 16 × 16 candidate points, regardless of zoom or board size.
    const columns = Math.max(0,Math.min(16,Math.floor((bottom.x - top.x - width) / 32) + 1));
    const rows = Math.max(0,Math.min(16,Math.floor((bottom.y - top.y - height) / 32) + 1));
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const point = {x:Math.round(top.x + (bottom.x - top.x - width) * (columns === 1 ? .5 : column / (columns - 1))),
        y:Math.round(top.y + (bottom.y - top.y - height) * (rows === 1 ? .5 : row / (rows - 1)))};
      if (free(point)) candidates.push(point);
    }
    candidates.sort((a,b) => Math.hypot(a.x - center.x,a.y - center.y) - Math.hypot(b.x - center.x,b.y - center.y));
    if (candidates.length) return candidates[0];
    if (next && next.x < bottom.x - 40 && next.y < bottom.y - 40) return next;
    return {x:Math.max(top.x,Math.min(center.x,bottom.x - width)),y:Math.max(top.y,Math.min(center.y,bottom.y - height))};
  }
  duplicateSelection() {
    if (this.clipboardBlocked() || this.history?.busy) return;
    try {
      const clipboard = this.copySnapshot();
      if (!clipboard) return;
      // Duplicate uses the copy transaction directly, leaving native clipboard
      // contents untouched. A successful duplicate cancels its captured Cut.
      const targetPosition = {x:Math.min(...clipboard.placements.map(p => p.x)) + 32,
        y:Math.min(...clipboard.placements.map(p => p.y)) + 32};
      return this.pasteClipboard({kind:"duplicate",clipboard,targetPosition});
    } catch (error) { toast(error.message); }
  }
  async pasteClipboard(source) {
    this.pasteBusy = true;
    this.pasteCancelled = false;
    this.movePending = true;
    this.updateHistoryControls();
    let written = false;
    const cut = source.kind === "duplicate" ? this.cutIntent.active() : null;
    try {
      let clipboard = source.clipboard;
      if (!clipboard) {
        let metadata = {};
        if (source.kind === "url") {
          toast("Preparing link preview…");
          this.pasteController = new AbortController();
          const timeout = setTimeout(() => this.pasteController.abort(),7000);
          try {
            const response = await fetch("/api/link-preview",{method:"POST",headers:{"Content-Type":"application/json","x-tinka-workspace":this.config.workspaceId},
              body:JSON.stringify({url:source.url}),signal:this.pasteController.signal});
            if (response.ok) metadata = await response.json();
          } catch {} finally { clearTimeout(timeout); }
        }
        clipboard = externalClipboard(this.snapshot.workspaceId,source,metadata);
      }
      if (this.pasteCancelled) return;
      await this.refresh({saveReview:false});
      if (this.pasteCancelled) return;
      const targetPosition = source.targetPosition || this.pastePosition(clipboard);
      const operation = {clipboard,targetBoardId:this.snapshot.id,targetPosition};
      if (clipboardBytes({type:"pastePlacements",...operation}) > 900000)
        throw new Error("This paste is too large to save at once. Paste a smaller document or selection; its text has not been truncated.");
      this.moveCommitting = true;
      let result;
      if (source.kind === "duplicate") {
        const response = await this.client.write("pastePlacements",operation,{recordHistory:false,includeHistory:true});
        result = response.result;
        if (response.history) this.history.record(response.history,{type:"duplicate",data:operation});
      } else result = await this.client.write("pastePlacements",operation);
      written = true;
      if (source.kind === "duplicate") this.cutIntent.clear(cut);
      this.moveCommitting = false;
      this.lastPastePosition = targetPosition;
      this.filters = {search:"",favorites:false,recent:false,archive:false};
      $("workspace-search").value = "";
      for (const id of ["workspace-favorites","workspace-recent","workspace-archive"]) $(id).setAttribute("aria-pressed","false");
      this.selection = new Set(result.placementIds || []);
      await this.refresh({saveReview:false});
      this.hooks.revealPlacements?.(this.snapshot.placements.filter(p => this.selection.has(p.id)));
      toast(source.kind === "duplicate" ? `Duplicated ${result.placementIds.length} Tinka${result.placementIds.length === 1 ? "" : "s"}.` : source.kind === "url" ? "Link pasted." : source.kind === "text" ? "Document pasted." : `Pasted ${result.placementIds.length} Tinkas.`);
    } catch (error) {
      this.moveCommitting = false;
      try { await this.refresh({saveReview:false}); } catch {}
      const action = source.kind === "duplicate" ? "Duplication" : "Paste";
      toast(written ? `${action} saved. Reload the board to see it.` : error.conflict ? `${action} not saved. ${error.message}` :
        `Could not confirm ${source.kind === "duplicate" ? "duplication" : "the paste"}. ${error.message}`);
    } finally {
      this.pasteBusy = false;
      this.movePending = false;
      this.moveCommitting = false;
      this.pasteController = null;
      this.updateHistoryControls();
    }
  }
  updateHistoryControls() {
    const busy = this.pointerGesture || this.decorationGesture || this.movePending || this.historyBusy || this.pasteBusy || this.client.pendingWrites || this.saving || this.history?.busy;
    for (const direction of ["undo","redo"]) {
      const button = $("workspace-" + direction);
      if (!button) continue;
      const verb = direction === "undo" ? "Undo" : "Redo", label = this.history?.label(direction);
      button.textContent = label ? `${verb} ${label.toLowerCase()}` : verb;
      button.disabled = !!busy || !this.history?.available(direction);
      button.title = direction === "undo" ? "Undo movement, paste or removal (⌘/Ctrl Z)" : "Redo movement, paste or removal (⌘/Ctrl Shift Z)";
    }
    const copy = $("workspace-copy"), paste = $("workspace-paste");
    if (copy) copy.disabled = !!busy || !this.clipboardCandidates().length;
    if (paste) paste.disabled = !!busy;
  }
  async replayMovement(direction) {
    if (this.pointerGesture || this.decorationGesture || this.movePending || this.historyBusy || this.pasteBusy || this.history?.busy || this.client.pendingWrites || this.saving ||
        document.activeElement?.closest("input,textarea,select,[contenteditable],[role=dialog]") || document.querySelector("dialog[open]") ||
        !this.history.available(direction)) return;
    this.historyBusy = true;
    this.movePending = true;
    this.updateHistoryControls();
    try {
      // Refresh the revision without flushing review drafts. The server receipt
      // independently checks the affected arrangements before changing them.
      await this.refresh({saveReview:false});
      const result = await this.history.replay(direction);
      if (!result) return;
      await this.refresh({saveReview:false});
      toast(`${direction === "undo" ? "Undid" : "Redid"} ${result.label.toLowerCase()}.`);
    } catch (error) {
      try { await this.refresh({saveReview:false}); } catch {}
      toast(error.conflict ? `Movement history could not apply because the board changed. ${error.message}`
        : `Could not confirm the history change. Check the latest board before trying again. ${error.message}`);
    } finally {
      this.historyBusy = false;
      this.movePending = false;
      this.updateHistoryControls();
    }
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
          ...(this.snapshot.decorations || []).map(d => decorationBounds(d,this.snapshot)),
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
    // Keep the URL stamped by live content updates when its source is unchanged.
    const previews = new Map([...world.querySelectorAll("[data-placement]")].map(card =>
      [card.dataset.placement, { frame: card.querySelector(".workspace-live-preview iframe"), image: card.querySelector(".workspace-card-preview img"), pdf:card.querySelector(".workspace-pdf-preview") }]));
    const renderCard = (c) => {
      const item = c.graphItem,
        p = c.placement,
        img = resourceURL(item.preview?.resource) || remoteURL(item.preview?.url),
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
          ["html","markdown"].includes(item.content?.kind) && item.content?.resource && !item.content?.url;
      const review = { ...item.review, ...this.pendingReview.get(item.id) };
      const handoff = resourceURL(item.resources?.find(r => r.role === "handoff")?.resource);
      const previewSource = JSON.stringify([item.id, item.content || null]), previous = previews.get(p.id);
      let documentPreview = item.content?.kind === "markdown" && item.content?.resource
        ? `/app/media.html?${new URLSearchParams({kind:"markdown",root:item.content.resource.rootId,path:item.content.resource.path,name:item.title,chrome:"none",mode:"panel"})}` : null;
      if (documentPreview) { const stamp=new URL(this.hooks.preview(c),location.href).searchParams.get("v"); if(stamp) documentPreview += `&v=${encodeURIComponent(stamp)}`; }
      const preview = previous?.frame?.dataset.previewSource === previewSource
        ? previous.frame.getAttribute("src") : documentPreview || this.hooks.preview(c);
      const imageSource = JSON.stringify([item.id, img || url]);
      const image = previous?.image?.dataset.previewSource === imageSource
        ? previous.image.getAttribute("src") : img || url;
      const pdf = !img && item.content?.kind === "pdf" ? resourceURL(item.content.resource) : null;
      const pdfSource = JSON.stringify([item.id,pdf]);
      const pdfURL = previous?.pdf?.dataset.previewSource === pdfSource ? previous.pdf.getAttribute("src") : pdf && pdfPreviewURL(pdf);
      const footer = `<footer class="workspace-item-footer workspace-panel-caption"><button type="button" data-placement-select="${esc(p.id)}" aria-pressed="${selected}" aria-label="${selected ? "Deselect" : "Select"} ${esc(item.title)}">${selected ? "✓" : "□"}</button>${panel ? `<button type="button" class="workspace-panel-title" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}">${esc(item.title)}</button>` : '<span class="workspace-item-spacer" aria-hidden="true"></span>'}<button type="button" data-item-feedback="${esc(item.id)}" aria-label="Comments and vote on ${esc(item.title)}" title="Comments and vote"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg></button><button type="button" class="shortlist" data-star="${esc(c.key)}" aria-label="Favorite ${esc(item.title)}" aria-pressed="${!!review.star}">${review.star ? "★" : "☆"}</button><button type="button" data-item-controls="${esc(p.id)}" data-controls-focus="notes" aria-label="Details for ${esc(item.title)}" aria-haspopup="dialog" aria-expanded="${this.contextPlacement === p.id}">⋯${review.note ? '<span class="workspace-note-dot" aria-hidden="true"></span>' : ""}</button></footer>`;
      const visual = unavailable
        ? `<div class="workspace-build-placeholder"><strong>${item.build.state === "building" ? "Taking shape." : "A place for a new idea."}</strong><span>${esc(item.build.message || "This slot will open when it is ready for review.")}</span></div>`
        : live ? `<iframe src="${esc(preview)}" data-preview-source="${esc(previewSource)}" title="${esc(item.title)} ${panel ? "design" : "live"} preview" tabindex="-1" loading="lazy" inert></iframe>`
        : img || (url && item.content.kind === "image") ? `<img src="${esc(image)}" data-preview-source="${esc(imageSource)}" referrerpolicy="no-referrer" alt="${esc(item.title)} preview">`
        : pdf ? `<div class="workspace-pdf-fallback"><strong>${esc(item.title)}</strong><span>PDF · ${pdfSupported() ? "Page 1 preview" : "Preview unavailable in this browser"}</span><small>Open to read all pages or download the original.</small></div>${pdfSupported() ? `<iframe class="workspace-pdf-preview" src="${esc(pdfURL)}" data-preview-source="${esc(pdfSource)}" title="${esc(item.title)} first page" loading="lazy" tabindex="-1" inert></iframe>` : ""}`
        : item.childBoardId && !item.content ? coverMarkup(this.snapshot.boardCovers?.[item.childBoardId],item.childBoardId)
        : item.content?.text ? `<div class="workspace-document-preview">${esc(item.content.text.slice(0,2400))}</div>`
        : `<span class="workspace-title-art">${esc(item.preview?.text || item.title)}</span>`;
      const paper = /^#[0-9a-f]{3,8}$/i.test(p.presentation?.paper || "") ? p.presentation.paper : "#f6f7f1";
      const dimensions = this.mode === "canvas"
        ? `left:${p.x + this.origin.x}px;top:${p.y + this.origin.y}px;width:${p.width}px;height:${p.height}px;z-index:${p.z};`
        : panel || icon ? `width:${p.width}px;height:${p.height}px;` : "";
      return `<article tabindex="-1" class="workspace-card ${panel ? "workspace-panel" : icon ? "workspace-icon" : "workspace-compact"} ${selected ? "selected" : ""}" data-key="${esc(c.key)}" data-placement="${esc(p.id)}" data-build-state="${esc(item.build?.state || "ready")}" style="${dimensions}--item-paper:${paper};--panel-viewport-width:${viewport.width}px;--panel-viewport-height:${viewport.height}px;">${icon ? `<button type="button" class="workspace-icon-entry" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="Open ${esc(item.title)}"><span aria-hidden="true">${item.childBoardId ? "▱" : item.content?.kind === "image" ? "▧" : item.content?.kind === "html" ? "▤" : "◇"}</span><strong>${esc(item.title)}</strong></button>` : `<div class="workspace-card-preview ${panel ? "workspace-panel-preview" : ""} ${live ? "workspace-live-preview" : ""}" ${panel ? `data-preview-width="${viewport.width}" data-preview-height="${viewport.height}"` : ""}>${visual}<button type="button" class="workspace-preview-launch" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="Open ${esc(item.title)}"><span>Open ${esc(item.title)} ↗</span></button></div>${!panel ? `<div class="workspace-card-copy"><div class="workspace-compact-meta"><span class="workspace-concept-number">${esc(c.number)}</span><span>${esc(item.category || item.content?.kind || (item.childBoardId ? "Board" : "Idea"))}</span></div><h3><button type="button" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}">${esc(item.title)}</button></h3>${item.description ? `<p>${esc(item.description)}</p>` : ""}${item.question ? `<p class="workspace-question">${esc(item.question)}</p>` : ""}${handoff ? `<a class="workspace-handoff" href="${esc(handoff)}" target="_blank" rel="noopener noreferrer">Handoff ↗</a>` : ""}${item.childBoardId && item.content ? `<button type="button" class="workspace-child" data-child-board="${esc(item.childBoardId)}">Open board ↗</button>` : ""}</div>` : ""}`}${footer}${this.mode === "canvas" ? `<button type="button" class="workspace-resize" data-resize="${esc(p.id)}" aria-label="Resize ${esc(item.title)}">◢</button>` : ""}</article>`;
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
        return `<section class="workspace-grid-round" data-round="${esc(id)}"><header><p class="workspace-eyebrow">${r.number ? "ROUND " + esc(r.number) : "ITEMS"}${r.date ? " · " + esc(r.date) : ""}</p><h2>${esc(r.title || "Exploration")}</h2>${r.description ? `<p>${esc(r.description)}</p>` : ""}</header><div class="workspace-cards">${newestBoardsFirst(entries, c => this.snapshot.childBoardCreatedAt?.[c.graphItem.childBoardId], c => !!c.graphItem.childBoardId).map(renderCard).join("")}</div></section>`;
      })
      .join("");
    this.reconcile(world, `${this.mode === "canvas" ? this.decorations() : ""}${this.mode === "grid" ? grid || '<p class="workspace-empty">Nothing here yet. Add an idea or clear a filter.</p>' : `<div class="workspace-cards">${cards || '<p class="workspace-empty">Nothing here yet. Add an idea or clear a filter.</p>'}</div>`}`);
    if (this.mode === "canvas") {
      const p = concepts.map((c) => c.placement),
        d = (this.snapshot.decorations || []).map(d => decorationBounds(d,this.snapshot));
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
    this.syncCutMarks();
    this.sizePreviews();
    this.coverObserver = observeCovers(world,this.coverObserver);
    this.hooks.layout();
    this.positionContext();
    this.syncGeometry();
  }
  reconcile(parent, markup) {
    const template = document.createElement("template");
    template.innerHTML = markup;
    this.reconcileChildren(parent, template.content);
  }
  reconcileChildren(parent, fresh) { reconcileChildren(parent, fresh); }
  updateCovers(covers) {
    if (!covers) return;
    this.snapshot.boardCovers = covers;
    const world = $('world');
    for (const el of world.querySelectorAll('[data-cover-board]')) {
      const template = document.createElement('template');
      template.innerHTML = coverMarkup(covers[el.dataset.coverBoard],el.dataset.coverBoard);
      const fresh = template.content.firstElementChild;
      if (fresh?.classList.contains('board-collage')) {
        el.dataset.coverCount = fresh.dataset.coverCount;
        this.reconcileChildren(el,fresh);
      }
    }
    this.coverObserver = observeCovers(world,this.coverObserver);
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
    this.updateHistoryControls();
  }
  syncSelection() {
    for (const card of $("world").querySelectorAll(".workspace-card[data-placement]")) {
      const selected = this.selection.has(card.dataset.placement);
      card.classList.toggle("selected", selected);
      const button = card.querySelector("[data-placement-select]");
      if (!button) continue;
      const p = this.snapshot.placements.find(p => p.id === card.dataset.placement);
      const title = this.snapshot.items[p?.itemId]?.title || "item";
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `${selected ? "Deselect" : "Select"} ${title}`);
      button.textContent = selected ? "✓" : "□";
    }
    const count = $("workspace-selection").querySelector("strong");
    if (count) count.textContent = `${this.selection.size} selected`;
    this.updateHistoryControls();
  }
  async bulk(type) {
    const ids = type === "remove" ? this.clipboardCandidates().map(p => p.id) : [...this.selection];
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
            await this.refresh({saveReview:false});
          },
        });
        return;
      }
      if (type === "group") {
        this.group(ids);
        return;
      }
      if (type === "remove") {
        if (!ids.length) return;
        makeDialog(
          "Remove these placements?",
          `<p>Remove ${ids.length} placement${ids.length === 1 ? "" : "s"} from this board. Other references, canonical items, notes and all resource files remain intact.</p><button type="submit" class="workspace-primary">Remove from this board</button>`,
          () => this.removePlacements(ids),
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
  async removePlacements(ids) {
    // This shared write guard deliberately permits the confirmed toolbar dialog.
    if (!ids.length || this.pointerGesture || this.decorationGesture || this.movePending ||
        this.historyBusy || this.history?.busy || this.pasteBusy || this.client.pendingWrites || this.saving) return;
    const eligible = new Set(this.clipboardCandidates().map(p => p.id));
    if (new Set(ids).size !== ids.length || ids.some(id => !eligible.has(id))) return;
    this.movePending = true;
    this.updateHistoryControls();
    const cut = this.cutIntent.active();
    let confirmedRemoved = false;
    try {
      await this.client.write("remove", {boardId:this.snapshot.id,placementIds:ids});
      confirmedRemoved = true;
      // Clear only the intent captured before this request, never a newer tab's cut.
      this.cutIntent.clear(cut);
      ids.forEach(id => this.selection.delete(id));
      if (ids.includes(this.contextPlacement)) this.closeContext();
      await this.refresh({saveReview:false});
      toast(`Removed ${ids.length} Tinka${ids.length === 1 ? "" : "s"} from this board. Undo to restore.`);
    } catch (error) {
      try { await this.refresh({saveReview:false}); } catch {}
      if (confirmedRemoved) toast("Removed from this board. Reload to see the latest board; Undo remains available.");
      else if (error.rejected || error.conflict) showFailure(error);
      else toast("Could not confirm removal. Check the latest board before trying again.");
    } finally {
      this.movePending = false;
      this.updateHistoryControls();
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
  dropContext(gesture) {
    const graph = this.workspaceGraph, subject = gesture.lifted || {
      boardId:this.snapshot.id, p:gesture.p,
    };
    const subjects = gesture.lifted ? [subject.p] : gesture.entries.map(entry => entry.p);
    const subjectKey = gesture.lifted?.p || gesture.entries;
    if (!graph) return null;
    if (gesture.dropGraph === graph && gesture.dropSubject === subjectKey) return gesture.dropContext;
    const items = new Map(graph.items.map(i => [i.id, i]));
    const boards = new Map(graph.boards.map(b => [b.id, b]));
    const board = boards.get(subject.boardId);
    const placements = subjects.map(subject => board?.placements.find(p => p.id === subject.id && p.itemId === subject.itemId));
    const forbidden = new Set([subject.boardId]);
    const visit = id => {
      if (!id || forbidden.has(id)) return;
      forbidden.add(id);
      for (const p of boards.get(id)?.placements || []) {
        const child = items.get(p.itemId);
        // Archived edges still participate in the server's DAG validation.
        if (!p.removedAt && !p.deletedAt && !child?.deletedAt) visit(child?.childBoardId);
      }
    };
    const available = placements.every(p => {
      const item = items.get(p?.itemId);
      visit(item?.childBoardId);
      return p && !p.removedAt && !p.deletedAt && !p.archivedAt && item && !item.deletedAt && !item.archivedAt;
    });
    const valid = placements.filter(Boolean);
    const x = Math.min(...valid.map(p => p.x)), y = Math.min(...valid.map(p => p.y));
    const bounds = {x,y,width:Math.max(...valid.map(p => p.x + p.width)) - x,
      height:Math.max(...valid.map(p => p.y + p.height)) - y};
    gesture.dropGraph = graph;
    gesture.dropSubject = subjectKey;
    return gesture.dropContext = {items, boards, forbidden, placements, bounds, available, sourceBoardId:subject.boardId};
  }
  dropDestination(gesture, boardId, card, kind = "board") {
    const context = this.dropContext(gesture), board = context?.boards.get(boardId);
    const owner = context?.items.get(board?.ownerItemId);
    return {card, boardId, kind, title:board?.title || "board",
      invalid:!context?.available || !board || context.forbidden.has(boardId) ||
        !owner || owner.deletedAt || owner.archivedAt};
  }
  groupDropPosition(gesture, target) {
    const context = this.dropContext(gesture), board = context.boards.get(target.boardId);
    const anchor = target.kind === "parent" ? board.placements.find(p => !p.removedAt && !p.deletedAt && !p.archivedAt && p.itemId === this.snapshot.ownerItemId) : null;
    const p = context.bounds;
    const occupied = board.placements.filter(p => !p.removedAt && !p.deletedAt && !p.archivedAt);
    const free = point => !occupied.some(other => point.x < other.x + other.width + 16 &&
      point.x + p.width + 16 > other.x && point.y < other.y + other.height + 16 && point.y + p.height + 16 > other.y);
    const candidates = anchor ? [
      {x:anchor.x + anchor.width + 40,y:anchor.y},
      {x:anchor.x,y:anchor.y + anchor.height + 40},
      {x:anchor.x - p.width - 40,y:anchor.y},
      {x:anchor.x,y:anchor.y - p.height - 40},
    ] : [];
    return candidates.find(free) || {x:Math.max(0,...occupied.map(p => p.x + p.width)) + 40, y:anchor?.y || 0};
  }
  boardDropTarget(gesture, x, y) {
    if (gesture.resize) return null;
    const surface = document.elementsFromPoint(x, y)
      .find(el => gesture.lifted || !gesture.entries.some(entry => entry.element.contains(el)));
    const parent = $("workspace-parent");
    if (parent && !parent.hidden) {
      const rect = parent.getBoundingClientRect();
      if (x > rect.left - 6 && x < rect.right + 6 && y > rect.top - 5 && y < rect.bottom + 5 &&
          (parent.contains(surface) || surface === parent.parentElement)) {
        if (!this.resolvedParent) return {card:parent,invalid:true};
        const target = this.dropDestination(gesture, this.resolvedParent.id, parent, "parent");
        if (!target.invalid) target.targetPosition = this.groupDropPosition(gesture, target);
        return target;
      }
    }
    // A lifted child leaves its owner visible and stationary; dropping back
    // inside that owner cancels. Ordinary drags ignore their moving card.
    const card = surface?.closest(".workspace-card");
    if (card && $("viewport").contains(card)) {
      const placement = this.snapshot.placements.find(p => p.id === card.dataset.placement);
      const item = this.snapshot.items[placement?.itemId];
      if (!item?.childBoardId) return gesture.lifted ? {invalid:true} : null;
      const rect = card.getBoundingClientRect(), inset = Math.min(10, rect.width / 6, rect.height / 6);
      if (x <= rect.left + inset || x >= rect.right - inset ||
          y <= rect.top + inset || y >= rect.bottom - inset) return gesture.lifted ? {invalid:true} : null;
      const target = this.dropDestination(gesture, item.childBoardId, card);
      target.invalid ||= placement.removedAt || placement.deletedAt || placement.archivedAt || item.deletedAt || item.archivedAt;
      if (!target.invalid && !gesture.lifted && gesture.entries.length > 1)
        target.targetPosition = this.groupDropPosition(gesture, target);
      return target;
    }
    if (gesture.lifted && surface && $("viewport").contains(surface) &&
        !surface.closest("button,a,input,textarea,select,[contenteditable]")) {
      const target = this.dropDestination(gesture, this.snapshot.id, $("viewport"), "canvas");
      const point = this.canvasPoint({x,y});
      target.targetPosition = {x:point.x, y:point.y};
      return target;
    }
    return null;
  }
  pointer() {
    let drag = null;
    let marquee = null;
    let suppressedClick = null;
    let highlighted = null;
    let lastPointerType = "";
    const pointers = new Set();
    const viewport = $("viewport");
    const emptyCanvas = e => {
      if (e.pointerType === "touch" || e.isPrimary === false || e.ctrlKey || e.metaKey || e.altKey ||
          document.querySelector("dialog[open]")) return false;
      const rect = viewport.getBoundingClientRect();
      if (e.clientX < rect.left + viewport.clientLeft || e.clientX >= rect.left + viewport.clientLeft + viewport.clientWidth ||
          e.clientY < rect.top + viewport.clientTop || e.clientY >= rect.top + viewport.clientTop + viewport.clientHeight) return false;
      if (e.target.closest(".workspace-card,button,a,input,textarea,select,label,[contenteditable],.workspace-review,[role=menu],[role=dialog]")) return false;
      const decoration = e.target.closest("[data-decoration]");
      if (!decoration) return true;
      if (!decoration.classList.contains("decoration-region") || decoration.classList.contains("whiteboard-shape") || e.target.closest("[data-decoration-label]")) return false;
      const bounds = decoration.getBoundingClientRect();
      const label = decoration.querySelector("[data-decoration-label]")?.getBoundingClientRect();
      return e.clientX > bounds.left + 6 && e.clientX < bounds.right - 6 &&
        e.clientY > Math.max(bounds.top + 28, label?.bottom || bounds.top) && e.clientY < bounds.bottom - 6;
    };
    const setSelection = selected => {
      if (selected.size === this.selection.size && [...selected].every(id => this.selection.has(id))) return;
      this.selection = selected;
      this.syncSelection();
    };
    const renderMarquee = () => {
      if (!marquee?.active) return;
      const bounds = viewport.getBoundingClientRect(), world = $("world").getBoundingClientRect();
      const zoom = this.hooks.zoom();
      const anchor = {x:world.left + marquee.anchor.x * zoom,y:world.top + marquee.anchor.y * zoom};
      const box = {
        left:Math.max(bounds.left,Math.min(anchor.x,marquee.last.x)),
        top:Math.max(bounds.top,Math.min(anchor.y,marquee.last.y)),
        right:Math.min(bounds.right,Math.max(anchor.x,marquee.last.x)),
        bottom:Math.min(bounds.bottom,Math.max(anchor.y,marquee.last.y)),
      };
      Object.assign(marquee.layer.style, {left:`${bounds.left}px`,top:`${bounds.top}px`,width:`${bounds.width}px`,height:`${bounds.height}px`});
      Object.assign(marquee.box.style, {left:`${box.left - bounds.left}px`,top:`${box.top - bounds.top}px`,
        width:`${Math.max(0,box.right - box.left)}px`,height:`${Math.max(0,box.bottom - box.top)}px`});
      const selected = new Set(marquee.additive ? marquee.original : []);
      if (box.right > box.left && box.bottom > box.top)
        for (const {id,element} of marquee.cards) {
          if (!element.isConnected) continue;
          const card = element.getBoundingClientRect();
          if (card.right > box.left && card.left < box.right && card.bottom > box.top && card.top < box.bottom) selected.add(id);
        }
      setSelection(selected);
      const text = `${selected.size} selected`;
      if (marquee.count.textContent !== text) marquee.count.textContent = text;
    };
    const beginMarquee = e => {
      if (!emptyCanvas(e)) return false;
      const world = $("world").getBoundingClientRect(), zoom = this.hooks.zoom();
      const placements = new Map(this.snapshot.placements.map(p => [p.id,p]));
      const cards = [...$("world").querySelectorAll(".workspace-card[data-placement]")].filter(element => {
        const p = placements.get(element.dataset.placement), item = this.snapshot.items[p?.itemId];
        return p && !p.removedAt && !p.deletedAt && item && !item.deletedAt;
      }).map(element => ({id:element.dataset.placement,element}));
      marquee = {pointerId:e.pointerId,x:e.clientX,y:e.clientY,last:{x:e.clientX,y:e.clientY},
        anchor:{x:(e.clientX - world.left) / zoom,y:(e.clientY - world.top) / zoom},
        original:new Set(this.selection),additive:e.shiftKey,cards,active:false};
      this.pointerGesture = true;
      this.updateHistoryControls();
      // The toolbar keeps its existing visibility until this gesture finishes.
      // Only the count and card selection state change while the box is active.
      e.preventDefault();
      e.stopImmediatePropagation();
      return true;
    };
    const finishMarquee = cancelled => {
      if (!marquee) return;
      const done = marquee;
      if (done.active && !cancelled) renderMarquee();
      marquee = null;
      if (cancelled) setSelection(new Set(done.original));
      else if (!done.active) setSelection(new Set(done.additive ? done.original : []));
      done.layer?.remove();
      viewport.classList.remove("workspace-marquee-active");
      if (done.active) suppressedClick = true;
      if (!cancelled && done.active && this.activeDecoration && (!done.additive || this.selection.size)) {
        const old = this.snapshot.decorations.find(d => d.id === this.activeDecoration);
        this.activeDecoration = null;
        if (old) this.updateDecorationElement(old);
      }
      const before = viewport.getBoundingClientRect();
      this.selectionMenu();
      const after = viewport.getBoundingClientRect();
      this.hooks.shiftViewport?.(before.left - after.left,before.top - after.top);
      this.pointerGesture = false;
      this.updateHistoryControls();
      try { viewport.releasePointerCapture(done.pointerId); } catch {}
      drainRefresh();
    };
    const hint = document.createElement("div");
    hint.id = "workspace-drop-hint";
    hint.className = "workspace-drop-hint";
    hint.setAttribute("role", "status");
    hint.hidden = true;
    document.body.append(hint);
    const clearTarget = () => {
      document.querySelectorAll(".workspace-drop-target").forEach(el => el.classList.remove("workspace-drop-target"));
      highlighted = null;
      hint.hidden = true;
      hint.textContent = "";
    };
    const setHint = message => {
      if (hint.textContent !== message) hint.textContent = message;
      hint.hidden = false;
    };
    const parentReady = gesture => {
      const parent = $("workspace-parent");
      parent?.classList.toggle("workspace-parent-drop-ready", !!gesture && !gesture.resize &&
        !!this.resolvedParent && !this.dropDestination(gesture, this.resolvedParent.id, parent, "parent").invalid);
    };
    const showTarget = target => {
      const next = target && !target.invalid ? target.card : null;
      const count = drag?.lifted ? 1 : drag?.entries.length || 1;
      const idleHint = () => {
        if (drag?.lifted) setHint(`Lifted ${drag.lifted.item.title} · drop on the canvas or a board`);
        else if (count > 1) setHint(`Moving ${count} selected items`);
      };
      if (highlighted === next) { if (!next) idleHint(); return; }
      clearTarget();
      if (!next) {
        idleHint();
        return;
      }
      highlighted = next;
      target.card.classList.add("workspace-drop-target");
      setHint(target.kind === "canvas" ? `Place ${drag.lifted.item.title} on ${target.title}`
        : count > 1 ? `Move ${count} items into ${target.title}` : `Move into ${target.title}`);
    };
    const stopHold = gesture => {
      clearTimeout(gesture.holdTimer);
      gesture.hold?.tile.classList.remove("workspace-cover-holding");
      gesture.holdTimer = null;
    };
    const restore = gesture => {
      for (const {element,p} of gesture.entries) {
        element.classList.remove("workspace-dragging");
        Object.assign(element.style, {
          left: `${p.x + this.origin.x}px`, top: `${p.y + this.origin.y}px`,
          width: `${p.width}px`, height: `${p.height}px`,
        });
      }
      this.syncGeometry();
    };
    const finishVisuals = gesture => {
      gesture.entries.forEach(entry => entry.element.classList.remove("workspace-dragging"));
      stopHold(gesture);
      gesture.lifted?.tile.classList.remove("workspace-cover-lifted");
      gesture.lifted?.proxy.remove();
      parentReady(null);
      clearTarget();
    };
    const activate = gesture => {
      gesture.active = true;
      const selection = window.getSelection();
      if (selection?.anchorNode && gesture.element.contains(selection.anchorNode)) selection.removeAllRanges();
      try { viewport.setPointerCapture(gesture.pointerId); } catch {}
      parentReady(gesture);
    };
    const positionProxy = (proxy, x, y) => {
      const rect = proxy.getBoundingClientRect();
      Object.assign(proxy.style, {
        left:`${Math.max(12, Math.min(innerWidth - rect.width - 12, x + 16))}px`,
        top:`${Math.max(12, Math.min(innerHeight - rect.height - 12, y + 16))}px`,
      });
    };
    const beginHold = gesture => {
      if (gesture.resize) return;
      const owner = this.snapshot.items[gesture.p.itemId];
      const cover = [...gesture.element.querySelectorAll("[data-cover-board]")]
        .find(el => el.dataset.coverBoard === owner?.childBoardId);
      if (!cover) return;
      const tile = [...cover.querySelectorAll("[data-cover-tile]")].find(el => {
        const rect = el.getBoundingClientRect();
        return gesture.x > rect.left && gesture.x < rect.right && gesture.y > rect.top && gesture.y < rect.bottom;
      });
      const represented = this.snapshot.boardCovers?.[owner.childBoardId]?.tiles
        .find(t => t.id === tile?.dataset.coverTile && t.itemId === tile?.dataset.coverItem);
      if (!represented) return;
      gesture.hold = {tile, boardId:owner.childBoardId, placementId:represented.id, itemId:represented.itemId};
      tile.classList.add("workspace-cover-holding");
      setHint(`Hold to lift ${represented.title}`);
      gesture.holdTimer = setTimeout(() => {
        if (drag !== gesture || gesture.active) return;
        stopHold(gesture);
        const board = this.workspaceGraph?.boards.find(b => b.id === gesture.hold.boardId);
        const p = board?.placements.find(p => p.id === represented.id && p.itemId === represented.itemId);
        const item = this.workspaceGraph?.items.find(i => i.id === represented.itemId);
        const boardOwner = this.workspaceGraph?.items.find(i => i.id === board?.ownerItemId);
        if (!p || p.removedAt || p.deletedAt || p.archivedAt || !item || item.deletedAt || item.archivedAt ||
            !boardOwner || boardOwner.deletedAt || boardOwner.archivedAt) { clearTarget(); return; }
        const proxy = document.createElement("div");
        proxy.id = "workspace-child-drag";
        proxy.className = "workspace-child-drag";
        proxy.setAttribute("aria-hidden", "true");
        proxy.innerHTML = `<span aria-hidden="true">↗</span><div><strong>${esc(item.title)}</strong><small>From ${esc(board.title)}</small></div>`;
        document.body.append(proxy);
        positionProxy(proxy, gesture.x, gesture.y);
        gesture.lifted = {boardId:board.id,p:{...p},item,tile,proxy};
        tile.classList.add("workspace-cover-lifted");
        activate(gesture);
        setHint(`Lifted ${item.title} · drag to place`);
      }, 450);
    };
    const drainRefresh = () => this.drainGeometryRefresh();
    const cancel = () => {
      if (marquee) { finishMarquee(true); return; }
      if (!drag) return;
      const done = drag;
      drag = null;
      this.pointerGesture = false;
      this.updateHistoryControls();
      if (done.active) suppressedClick = true;
      restore(done);
      finishVisuals(done);
      try {
        viewport.releasePointerCapture(done.pointerId);
      } catch {}
      drainRefresh();
    };
    // A fresh pointer gesture cannot inherit the click suppressed after a drag.
    document.addEventListener(
      "pointerdown",
      e => {
        suppressedClick = null;
        lastPointerType = e.pointerType;
        pointers.add(e.pointerId);
        if (pointers.size > 1) {
          const selecting = !!marquee;
          cancel();
          if (selecting) { e.preventDefault(); e.stopImmediatePropagation(); }
        }
      },
      true,
    );
    document.addEventListener(
      "click",
      (e) => {
        if (!suppressedClick || e.detail === 0) return;
        // Pointer capture may synthesize this click on either the source,
        // destination or viewport. A fresh pointerdown restores normal clicks.
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressedClick = null;
      },
      true,
    );
    viewport.addEventListener(
      "pointerdown",
      (e) => {
        if (this.mode !== "canvas" || e.button !== 0 || this.movePending || pointers.size > 1) return;
        if (drag && drag.pointerId !== e.pointerId) {
          cancel();
          return;
        }
        const card = e.target.closest(".workspace-card");
        if (!card) { beginMarquee(e); return; }
        const handle = e.target.closest("[data-drag],[data-resize]");
        const preview = e.target.closest(".workspace-preview-launch,.workspace-icon-entry,.workspace-panel-title,.workspace-card-copy h3 [data-open]");
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
          threshold:e.pointerType === "touch" ? 8 : 6,
        };
        const visible = new Map([...$("world").querySelectorAll(".workspace-card[data-placement]")]
          .map(element => [element.dataset.placement,element]));
        const selected = !drag.resize && this.selection.has(id)
          ? this.snapshot.placements.filter(p => {
              const item = this.snapshot.items[p.itemId];
              return this.selection.has(p.id) && visible.has(p.id) && !p.removedAt && !p.deletedAt && !p.archivedAt &&
                item && !item.deletedAt && !item.archivedAt;
            }) : [];
        drag.entries = (selected.some(p => p.id === id) ? selected : [p])
          .map(p => ({p:{...p},element:visible.get(p.id)}));
        this.pointerGesture = true;
        this.updateHistoryControls();
        if (!this.workspaceGraph || this.workspaceGraph.revision !== this.snapshot.revision)
          this.client.get("/api/workspace?view=graph&covers=0").then(ws => {
            if (!this.workspaceGraph || ws.revision >= this.workspaceGraph.revision) this.workspaceGraph = ws;
          }).catch(() => {});
        beginHold(drag);
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
        if (marquee?.pointerId === e.pointerId) {
          marquee.last = {x:e.clientX,y:e.clientY};
          if (!marquee.active && Math.hypot(e.clientX - marquee.x,e.clientY - marquee.y) >= 6) {
            marquee.active = true;
            const layer = document.createElement("div");
            layer.className = "workspace-marquee-layer";
            layer.innerHTML = '<div id="workspace-marquee"><span id="workspace-marquee-count" role="status"></span></div>';
            document.body.append(layer);
            Object.assign(marquee,{layer,box:layer.firstElementChild,count:layer.querySelector("#workspace-marquee-count")});
            viewport.classList.add("workspace-marquee-active");
            const selection = window.getSelection();
            if (selection?.anchorNode && viewport.contains(selection.anchorNode)) selection.removeAllRanges();
            try { viewport.setPointerCapture(e.pointerId); } catch {}
          }
          renderMarquee();
          e.preventDefault(); e.stopImmediatePropagation();
          return;
        }
        if (!drag || drag.pointerId !== e.pointerId) return;
        const screenX = e.clientX - drag.x,
          screenY = e.clientY - drag.y;
        const moved = Math.hypot(screenX, screenY) >= drag.threshold;
        if (!drag.active && !moved) return;
        if (!drag.active) {
          stopHold(drag);
          clearTarget();
          activate(drag);
          drag.entries.forEach(entry => entry.element.classList.add("workspace-dragging"));
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        parentReady(drag);
        if (drag.lifted) {
          drag.moved ||= moved;
          positionProxy(drag.lifted.proxy, e.clientX, e.clientY);
          showTarget(this.boardDropTarget(drag, e.clientX, e.clientY));
          return;
        }
        const dx = screenX / drag.zoom,
          dy = screenY / drag.zoom;
        drag.translation = {dx:Math.round(dx),dy:Math.round(dy)};
        drag.patch = drag.resize
          ? {
              width: Math.max(drag.p.presentation?.mode === "icon" ? 190 : 160, Math.round(drag.p.width + dx)),
              height: Math.max(drag.p.presentation?.mode === "icon" ? 90 : 120, Math.round(drag.p.height + dy)),
            }
          : drag.entries.length === 1 ? {x:Math.round(drag.p.x + dx),y:Math.round(drag.p.y + dy)}
          : { x:drag.p.x + drag.translation.dx, y:drag.p.y + drag.translation.dy };
        for (const entry of drag.entries) {
          const patch = drag.resize || drag.entries.length === 1 ? drag.patch : {
            x:entry.p.x + drag.translation.dx, y:entry.p.y + drag.translation.dy,
          };
          for (const [key,value] of Object.entries(patch))
            entry.element.style[key === "x" ? "left" : key === "y" ? "top" : key] =
              (key === "x" ? value + this.origin.x : key === "y" ? value + this.origin.y : value) + "px";
        }
        this.syncGeometry({placements:new Map(drag.entries.map(entry => [entry.p.id,
          drag.resize || drag.entries.length === 1 ? drag.patch : {x:entry.p.x + drag.translation.dx,y:entry.p.y + drag.translation.dy}]))});
        showTarget(this.boardDropTarget(drag, e.clientX, e.clientY));
      },
      true,
    );
    document.addEventListener(
      "pointerup",
      async (e) => {
        if (marquee?.pointerId === e.pointerId) {
          marquee.last = {x:e.clientX,y:e.clientY};
          pointers.delete(e.pointerId);
          finishMarquee(false);
          e.preventDefault(); e.stopImmediatePropagation();
          return;
        }
        if (!drag || drag.pointerId !== e.pointerId) return;
        const done = drag;
        const target = done.active ? this.boardDropTarget(done, e.clientX, e.clientY) : null;
        drag = null;
        this.pointerGesture = false;
        this.updateHistoryControls();
        done.element.classList.remove("workspace-dragging");
        finishVisuals(done);
        if (!done.active || (done.lifted ? !done.moved : !done.patch)) {
          if (done.active) suppressedClick = true;
          drainRefresh(); return;
        }
        e.preventDefault();
        suppressedClick = true;
        try {
          viewport.releasePointerCapture(e.pointerId);
        } catch {}
        if (target || done.lifted) {
          // Keep the source in its saved position until the atomic move succeeds.
          restore(done);
          if (!target || target.invalid) { drainRefresh(); return; }
          const subject = done.lifted || {boardId:this.snapshot.id};
          const movedIds = done.lifted ? [done.lifted.p.id] : done.entries.map(entry => entry.p.id);
          this.movePending = true;
          this.moveCommitting = true;
          let moved = false;
          try {
            await this.client.write("move", {
              sourceBoardId: subject.boardId,
              placementIds:movedIds,
              targetBoardId: target.boardId,
              ...(target.targetPosition ? {targetPosition:target.targetPosition} : {}),
            });
            this.moveCommitting = false;
            moved = true;
            if (!done.lifted) {
              movedIds.forEach(id => this.selection.delete(id));
              if (movedIds.includes(this.contextPlacement)) this.closeContext();
            }
            await this.refresh({ saveReview: false });
            toast(movedIds.length > 1 ? `Moved ${movedIds.length} items into ${target.title}.` : `Moved into ${target.title}.`);
          } catch (error) {
            this.moveCommitting = false;
            restore(done);
            // Reconcile conflicts with the server without flushing or discarding
            // local note drafts, and keep failure feedback nonmodal.
            try { await this.refresh({ saveReview: false }); } catch {}
            toast(moved ? `Moved into ${target.title}. The board could not refresh; reload to see it.`
              : error.conflict ? `Move not saved. ${error.message}`
              : `Could not confirm the move. Check the latest board before trying again. ${error.message}`);
          } finally {
            this.moveCommitting = false;
            this.movePending = false;
            this.updateHistoryControls();
            drainRefresh();
          }
          return;
        }
        if (!done.resize && done.entries.length > 1) {
          this.movePending = true;
          this.moveCommitting = true;
          let saved = false;
          try {
            await this.client.write("translatePlacements", {
              boardId:this.snapshot.id,
              placementIds:done.entries.map(entry => entry.p.id),
              ...done.translation,
            });
            saved = true;
            this.moveCommitting = false;
            await this.refresh({saveReview:false});
          } catch (error) {
            this.moveCommitting = false;
            restore(done);
            try { await this.refresh({saveReview:false}); } catch {}
            toast(saved ? "Positions saved. The board could not refresh; reload to see it."
              : error.conflict ? `Positions not saved. ${error.message}`
              : `Could not confirm the positions. Check the latest board before trying again. ${error.message}`);
          } finally {
            this.moveCommitting = false;
            this.movePending = false;
            this.updateHistoryControls();
            drainRefresh();
          }
          return;
        }
        this.movePending = true;
        this.moveCommitting = true;
        try {
          await this.client.write("updatePlacement", {
            boardId: this.snapshot.id,
            placementId: done.id,
            patch: done.patch,
          });
          this.moveCommitting = false;
          await this.refresh({saveReview:false});
        } catch (error) {
          showFailure(error);
          this.rebuild();
        } finally {
          this.moveCommitting = false;
          this.movePending = false;
          this.updateHistoryControls();
          drainRefresh();
        }
      },
      true,
    );
    document.addEventListener(
      "pointercancel", (e) => {
        if (marquee?.pointerId === e.pointerId) { pointers.delete(e.pointerId); cancel(); e.preventDefault(); e.stopImmediatePropagation(); }
        else if (drag?.pointerId === e.pointerId) cancel();
      }, true,
    );
    document.addEventListener("pointerup", e => pointers.delete(e.pointerId), true);
    document.addEventListener("pointercancel", e => pointers.delete(e.pointerId), true);
    viewport.addEventListener("lostpointercapture", e => { if (drag?.pointerId === e.pointerId || marquee?.pointerId === e.pointerId) cancel(); });
    viewport.addEventListener("contextmenu", e => { if (marquee) cancel(); if (drag?.hold || drag?.lifted) e.preventDefault(); });
    viewport.addEventListener("contextmenu", e => {
      if (e.pointerType === "touch" || (!e.pointerType && lastPointerType === "touch") || e.target.closest("input,textarea,[contenteditable]")) return;
      const card = e.target.closest(".workspace-card[data-placement]");
      if (!card) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const id = card.dataset.placement;
      if (this.contextPlacement === id && this.context) this.positionContext();
      else this.itemControls(id,"appearance");
    });
    let marqueeFrame;
    const updateMarquee = () => {
      if (!marquee?.active) return;
      cancelAnimationFrame(marqueeFrame);
      marqueeFrame = requestAnimationFrame(renderMarquee);
    };
    viewport.addEventListener("wheel", updateMarquee, {passive:true});
    viewport.addEventListener("scroll", updateMarquee, {passive:true});
    window.addEventListener("resize", () => { if (marquee) cancel(); });
    window.addEventListener("blur", () => { pointers.clear(); cancel(); });
    document.addEventListener("keydown", e => {
      if ((drag || marquee) && e.key === "Escape") { cancel(); e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }
  decorations() {
    return (this.snapshot.decorations || []).map(d => this.decorationMarkup(d)).join("");
  }
  decorationMarkup(d) { return this.whiteboard?.markup(d) || decorationMarkup(d,this.snapshot,this.origin,this.activeDecoration === d.id); }
  updateDecorationElement(d) {
    const old = document.querySelector(`[data-decoration="${CSS.escape(d.id)}"]`);
    if (old && !old.querySelector("[contenteditable]")) old.outerHTML = this.decorationMarkup(d);
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
    menu.innerHTML = `<button type="button" role="menuitem" data-add="text"><span aria-hidden="true">T</span>Text</button><button type="button" role="menuitem" data-add="region"><span aria-hidden="true">▧</span>Colored region</button><button type="button" role="menuitem" data-add="sticky"><span aria-hidden="true">▣</span>Sticky note</button><button type="button" role="menuitem" data-add="rounded"><span aria-hidden="true">▢</span>Process</button><button type="button" role="menuitem" data-add="diamond"><span aria-hidden="true">◇</span>Decision</button><button type="button" role="menuitem" data-add="ellipse"><span aria-hidden="true">⬭</span>Start / end</button><button type="button" role="menuitem" data-add="arrow"><span aria-hidden="true">↗</span>Arrow</button><hr><button type="button" role="menuitem" data-add="idea"><span aria-hidden="true">◇</span>Item…</button><button type="button" role="menuitem" data-add="board"><span aria-hidden="true">▱</span>Tinka / Board…</button><hr><button type="button" role="menuitem" data-add="background">Board background…</button><button type="button" role="menuitem" data-add="order">Comparison order…</button>`;
    document.body.append(menu); this.addPopup = menu;
    const rect = anchor?.getBoundingClientRect();
    const screen = point || { x: rect.right - menu.offsetWidth, y: rect.bottom + 6 };
    Object.assign(menu.style, { left: `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, screen.x))}px`, top: `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, screen.y))}px` });
    $("workspace-add").setAttribute("aria-expanded", "true");
    menu.querySelectorAll("[data-add]").forEach(button => button.onclick = () => {
      const type = button.dataset.add;
      this.closeAddMenu();
      if (["text", "region", "arrow", "sticky", "rounded", "diamond", "ellipse"].includes(type)) this.createDecoration(type, point);
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
    const point = this.canvasPoint(screen), shaped = ["sticky","rounded","diamond","ellipse"].includes(type), region = type === "region" || shaped;
    const d = { id: crypto.randomUUID(), type: type === "arrow" ? "line" : region ? "region" : type,
      x: point.x, y: point.y, width: shaped ? type === "sticky" ? 220 : 240 : region ? 420 : type === "arrow" ? 200 : 280,
      height: shaped ? type === "sticky" ? 200 : type === "diamond" ? 180 : 130 : region ? 280 : type === "arrow" ? 90 : 70,
      text: type === "text" ? "Write something" : type === "sticky" ? "A thought to keep" : shaped ? ({rounded:"Process",diamond:"Decision",ellipse:"Start / end"}[type]) : region ? "A new area" : "",
      color: type === "sticky" ? "#f6e6a4" : shaped ? "#e0e8da" : region ? "#e1e8d5" : "#7a8a68", ...(shaped ? {shape:type === "sticky" ? "rectangle" : type} : {}), ...(type === "arrow" ? { endArrow: true, flipY: true } : {}) };
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
      if (type === "arrow") { const r=resolveLine(d,this.snapshot);d.from={x:r.from.x,y:r.from.y};d.to={x:r.to.x,y:r.to.y}; }
      await this.client.write("createDecoration",{boardId:this.snapshot.id,decoration:d});
      await this.refresh({saveReview:false});
      const element = document.querySelector(`[data-decoration="${CSS.escape(d.id)}"]`);
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
      element?.focus({ preventScroll: true });
      if (type !== "arrow") this.editDecoration(d.id, true);
    } catch (error) { showFailure(error); }
  }
  editDecoration(id, select = false) { return this.whiteboard.edit(id,select); }
  canvasEditing() {
    const viewport = $("viewport");
    document.addEventListener("pointerdown", e => {
      if (this.context && !e.target.closest("#workspace-item-controls,[data-item-controls]")) this.closeContext();
      if (this.addPopup && !e.target.closest(".workspace-add-menu,#workspace-add")) this.closeAddMenu();
    }, true);
    viewport.addEventListener("contextmenu", e => {
      if (e.target.closest(".workspace-card,.workspace-decoration,button,input,textarea")) return;
      e.preventDefault(); this.addMenu(null, { x: e.clientX, y: e.clientY });
    });
    viewport.addEventListener("click", e => {
      if (!e.target.closest(".workspace-card,.workspace-decoration,.whiteboard-ports")) {
        if (this.activeDecoration) { const old=this.snapshot.decorations.find(d=>d.id===this.activeDecoration);this.activeDecoration=null;if(old)this.updateDecorationElement(old); }
      }
    });
    document.addEventListener("keydown", async e => {
      if (document.querySelector("#reader-dialog[open],dialog.workspace-dialog[open]")) return;
      if (e.key === "Escape") {
        if (this.context) { this.closeContext(true); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (this.addPopup) { this.closeAddMenu(); $("workspace-add").focus(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (this.activeDecoration) { const old = this.snapshot.decorations.find(d => d.id === this.activeDecoration); this.activeDecoration = null; if (old) this.updateDecorationElement(old); e.preventDefault(); return; }
        if (this.selection.size) { this.selection.clear(); this.build(this.hooks.concepts()); e.preventDefault(); return; }
      }
      if (e.target.closest("input,textarea,select,[contenteditable],[role=textbox],[role=dialog]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[e.key];
      if (this.activeDecoration && ["Delete", "Backspace"].includes(e.key)) { e.preventDefault(); this.deleteDecoration(); return; }
      if (["Delete", "Backspace"].includes(e.key)) {
        if (e.repeat || e.shiftKey || this.clipboardBlocked() || this.history?.busy) return;
        const ids = this.clipboardCandidates().map(p => p.id);
        if (!ids.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.removePlacements(ids);
        return;
      }
      if (!delta || (!this.activeDecoration && !this.selection.size)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.pointerGesture || this.movePending || this.historyBusy) return;
      const [dx,dy] = delta.map(v => v * (e.shiftKey ? 10 : 1));
      try {
        if (this.activeDecoration) {
          const d=this.snapshot.decorations.find(d=>d.id===this.activeDecoration);
          let patch={x:d.x+dx,y:d.y+dy};
          if(d.type === "line"){const r=resolveLine(d,this.snapshot),from={x:r.from.x+dx,y:r.from.y+dy},to={x:r.to.x+dx,y:r.to.y+dy};patch={...lineBox(from,to),from,to};}
          await this.whiteboard.save(d.id,patch);
        }
        else {
          const placementIds = [...this.selection].filter(id => this.snapshot.placements.some(p => p.id === id && !p.removedAt && !p.deletedAt));
          if (!placementIds.length) return;
          await this.client.write("translatePlacements", {boardId:this.snapshot.id,placementIds,dx,dy});
          await this.refresh({saveReview:false});
        }
      } catch (error) { showFailure(error); }
    }, true);
  }
  async deleteDecoration() { return this.whiteboard.remove(); }
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
