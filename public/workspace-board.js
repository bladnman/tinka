import {SelectionActionsMenu,MORE_SELECTION_ICON} from "./selection-actions.js";
import {ARRANGE_ICON,arrangePositions,arrangeMenuMarkup,arrangeMenuKeys} from "./arrange.js";
export {arrangePositions} from "./arrange.js";
import {positionTilePopover,bindTileMenu} from './tile-ui.js';
import {bindCommitShortcut,commitShortcutLabel} from './interaction.js';
import {bindDrawingPalette,colorDot,paletteMarkup} from './color-control.js';
import {drawingPalette,drawingColor} from './drawing-palette.js';
import {boardColorVariables,paperVariables,renderDrawingColor} from './theme-colors.js';
import {boardSurfaces,surfacePoints} from './board-paint.js';
import {Whiteboard,decorationMarkup,decorationUnchanged,lineBox} from "./whiteboard.js";
import {placeWhiteboardPopover} from "./whiteboard-popover.js";
import {decorationBounds,defaultArrowBend,resolveLine} from "./whiteboard-geometry.js";
import {containerDropAt,containerDropLabel,containerDropUnchanged,containerMemberFor,containerPlacementIds,expandContainerSelection} from "./containers.js";
import {completeGroups,containedOccurrences,includeGroupMembers,sameGroups,selectedGroups} from "./canvas-groups.js";
import {FeedbackController} from "./feedback.js";
import {newestBoardsFirst} from "./board-order.js";
import {reconcileChildren} from "./reconcile.js";
import {coverMarkup, observeCovers} from "./board-covers.js";
import {eventFiles,hasFileDrag,validateImportFiles,importLayout,pdfSupported,pdfPreviewURL} from "./file-import.js";
import {CutIntent} from "./cut-intent.js";
import {MovementHistory} from "./movement-history.js";
import {timeHTML} from "./relative-dates.js";
import {navigationGraph} from "./navigator-graph.js";
import {isMacPlatform,stepModifierLabel} from "./reader-keys.js";
import {snapBox,boundsOf,snapDisabled,GuideLayer} from "./snap-guides.js";
import {stackRanks,stackRef} from "./stacking.js";
import {CommentPins,COMMENT_ICON,refBox} from "./comment-pins.js";
import {CLIPBOARD_MIME,CLIPBOARD_PREFIX,clipboardBounds,clipboardBytes,readClipboard,externalClipboard} from "./clipboard.js";
import {EMOJI_STICKER_MIME,emojiSticker} from "./emoji-stickers.js";
import {mountEmojiPicker} from "./emoji-picker.js";
import {copyCardPreview} from "./copy-preview.js";
import {fileVersion, fileVersions, modifiedTime, nearbyFileVersions} from "./version-stack.js";
import {
  WorkspaceClient,
  fieldFact,
  reviewFacts,
  escape as esc,
  resourceURL,
  remoteURL,
  destinationDialog,
  featureOnParentDialog,
  itemForm,
  makeDialog,
  newBoardDialog,
  toast,
  showFailure,
} from "./workspace.js";
// The opened-Tinka step modifier: ⌥ on a Mac, Ctrl elsewhere (see reader-keys.js).
const MOD = stepModifierLabel(isMacPlatform());
const svg16 = body => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const EDIT_TOOL_ICONS = {
  pointer: '<path d="M4 3.5l11.5 5-5 1.8-2 5z"/>',
  pan: '<path d="M5.5 9V6.5a1 1 0 012 0v2-3.6a1 1 0 012 0v3-4a1 1 0 012 0V8 5.4a1 1 0 012 0v5.1l.6-.8a1.2 1.2 0 012 1.2l-2 3.9a3 3 0 01-2.6 1.6h-2a4.6 4.6 0 01-4.2-2.8l-1.6-3.5a1.1 1.1 0 012-1z"/>',
  text: '<path d="M4.5 4.5h11M10 4.5v11.5M7.5 16h5"/>',
  sticky: '<path d="M4 4.5h12v7.8l-4 4H4zM12 16.3v-4h4"/>',
  container: '<rect x="3.5" y="3.5" width="13" height="13" rx="2"/><path d="M7 7.5h6M7 10.2h6M7 13h6"/>',
  rounded: '<rect x="3.5" y="4.5" width="13" height="11" rx="2.6"/>',
  arrow: '<path d="M4 15c2.2-5 5.5-7.3 11.5-8.8M11.5 4l4.1 2.2-2.3 4.2"/>',
  sticker: '<path d="M16.5 10a6.5 6.5 0 11-6.5-6.5A6.5 6.5 0 0116.5 10zM7.7 11.5a2.7 2.7 0 004.6 0M7.8 8.2h.1m4.2 0h.1"/>',
};
const EDIT_TOOL_GROUPS = [
  ["Navigation",[["pointer","Pointer","V"],["pan","Pan","H"]]],
  ["Draw",[["text","Text","T"],["sticky","Sticky note","S"],["container","Container"],["rounded","Rounded shape"],["arrow","Arrow"],["sticker","Sticker"]]],
  ["Feedback",[["comment","Comment","C"]]],
];
const $ = (id) => document.getElementById(id);
const tilePaperChoices=[
  ["#f6f7f1","Paper"],["#e4ebdc","Sage paper"],["#f1e8d5","Sand paper"],["#f1e0dc","Rose paper"],["#e7e4ee","Lilac paper"],
].map(([id,label])=>({id,label}));
const literalFill=id=>drawingColor(id,"fill","light");
function inspectorColorMarkup(label,value,role) {
  const panelId=`inspector-color-${crypto.randomUUID()}`;
  return `<button type="button" class="tk-btn tk-sm tk-tonal inspector-color-trigger" data-inspector-color aria-expanded="false" aria-controls="${panelId}">
    ${colorDot(value,role)}<span>${esc(label)}</span></button>
    <div id="${panelId}" class="text-format-controls inspector-color-palette" data-inspector-palette hidden></div>`;
}
function bindInspectorColor(host,{label,read,save,options,role,capture}) {
  const trigger=host.querySelector("[data-inspector-color]"),panel=host.querySelector("[data-inspector-palette]");
  panel.innerHTML=paletteMarkup(["fill"],{options,resolve:(id,_channel,theme)=>renderDrawingColor(literalFill(id),role,theme)});
  const palette=panel.querySelector("[data-color-swatches]");
  let writing=false,painted=read(),original=capture?.();
  const setValue=bindDrawingPalette(palette,{channel:"fill",label,value:painted,toValue:literalFill,previewRole:role,
    choose:async value=>{
      if(writing||value===read())return;
      writing=true;
      try { await save(value,original);original=capture?.(); }
      catch(error) { showFailure(error); }
      finally { writing=false;sync(true); }
    },
  });
  const sync=(force=false)=>{
    const value=read();
    if(!force&&value===painted)return;
    painted=value;setValue(value);
    trigger.querySelector(".drawing-color-dot").outerHTML=colorDot(value,role);
  };
  const toggle=open=>{
    panel.hidden=!open;
    trigger.setAttribute("aria-expanded",String(open));
    if(open){
      original=capture?.();
      sync(true);
      (palette.querySelector("[aria-pressed=true]")||palette.querySelector("button"))?.focus({preventScroll:true});
    }
  };
  trigger.onclick=()=>toggle(panel.hidden);
  panel.addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;
    event.preventDefault();event.stopPropagation();toggle(false);trigger.focus({preventScroll:true});
  });
  return sync;
}
// Every placement is still active on the latest board with the geometry an
// arrangement action started from.
const placementsUnchanged = (latest, placements) => placements.every(p => {
  const saved = latest.placements?.find(q => q.id === p.id);
  return saved && !saved.removedAt && !saved.deletedAt && (saved.archivedAt ?? null) === (p.archivedAt ?? null) &&
    ["x","y","width","height"].every(key => saved[key] === p[key]);
});
const tileResizeEdges = ["n","ne","e","se","s","sw","w","nw"]
  .map(edge => `<span class="workspace-card-edge" data-resize-edge="${edge}" aria-hidden="true"></span>`).join("");
function resizePlacementBox(p, edge, dx, dy) {
  const shrinkLeft = edge.includes("w"), shrinkTop = edge.includes("n");
  const icon = p.presentation?.mode === "icon";
  const limit = (value, current, minimum) => Math.max(Math.min(minimum,current),Math.min(100000,Math.round(value)));
  const width = /[we]/.test(edge) ? limit(p.width + (shrinkLeft ? -dx : dx),p.width,icon ? 190 : 160) : p.width;
  const height = /[ns]/.test(edge) ? limit(p.height + (shrinkTop ? -dy : dy),p.height,icon ? 90 : 120) : p.height;
  return { x:shrinkLeft ? p.x+p.width-width : p.x, y:shrinkTop ? p.y+p.height-height : p.y, width, height };
}
export class WorkspaceBoard {
  constructor(config, snapshot, hooks) {
    this.config = config;
    this.snapshot = snapshot;
    this.hooks = hooks;
    // Tinka item links (the same /boards/BOARD/#items/PLACEMENT form tool results give).
    hooks.itemLink ??= (placement, item, board = this.snapshot) => placement?.id && board?.id
      ? `${location.origin}/boards/${encodeURIComponent(board.id)}/#items/${encodeURIComponent(placement.id)}` : null;
    this.client = new WorkspaceClient(config, snapshot.revision,{readOnly:!!hooks.viewOnly});
    this.history = new MovementHistory(this.client,config.workspaceId,() => this.updateHistoryControls());
    this.client.onState = () => { this.updateHistoryControls(); this.hooks.liveReady?.(); };
    this.selection = new Set();
    this.selectedFileVersions = new Map();
    // Drawn elements selected with cards (a mixed group) share Whiteboard's decorationSelection.
    this.decorationSelection = new Set();
    this.mixedGroup = false;
    this.guides = new GuideLayer();
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
    this.reviewBaselineKey = `${this.draftKey}/baselines`;
    let baselines = {};
    try { baselines = JSON.parse(localStorage.getItem(this.reviewBaselineKey) || '{}'); } catch {}
    this.reviewBaselines = new Map(Object.entries(baselines));
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
    for (const [id, version] of this.selectedFileVersions) {
      const p = byId.get(id);
      if (!p || p.removedAt || p.deletedAt || !fileVersion(items[p.itemId], version))
        this.selectedFileVersions.delete(id);
    }
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
        shownNumber: item.number ?? item.legacy?.number ?? "",
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
      revisions[key] = this.revisionsFor(item);
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
    $("help-panel").append(" The bottom name bar also drags; a title click opens the item. Hover a card for its toolbar and selection circle; Shift- or ⌘/Ctrl-click adds it to the selection. Right-click a card for a short menu; Details… (⌘/Ctrl-I) opens the Inspector with notes and appearance. Use ⌘/Ctrl-Z to undo movement and Shift-⌘/Ctrl-Z to redo, or use Undo/Redo in the top bar or Inspector. This tab remembers movements across boards; text fields keep their own undo. Delete or Backspace removes the visible selection from this board; ⌘/Ctrl-Z restores it. New-board creation and canonical deletion are outside movement history.");
    bar.id = "workspace-toolbar";
    bar.className = "workspace-toolbar";
    bar.setAttribute("aria-label", "Organize this board");
    bar.innerHTML = `<div class="workspace-segments"><button data-mode="grid">Grid</button><button data-mode="canvas">Canvas</button></div><label class="workspace-search"><span class="sr-only">Filter visible canvas items</span><input type="search" placeholder="Filter this canvas…" id="workspace-search"></label><button id="workspace-favorites" aria-pressed="false">☆ Favorites</button><button id="workspace-recent" aria-pressed="false">Last 6 weeks</button><button id="workspace-archive" aria-pressed="false">Archive</button><button id="workspace-owner" hidden>Open primary content</button><button id="workspace-retry-drafts" hidden>Retry unsaved feedback</button><button id="workspace-recover-text" hidden>Recover unsaved text</button>`;
    $("board-info").prepend(bar);
    const add = document.createElement("button");
    add.id = "workspace-add";
    add.type = "button";
    add.className = "tk-btn tk-primary chrome-add";
    add.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg><span class="chrome-add-label">Add</span>';
    add.setAttribute("aria-label", "Add");
    add.title = "Add text, shapes, arrows, items and boards";
    add.setAttribute("aria-haspopup", "menu");
    add.setAttribute("aria-expanded", "false");
    const actions = $("chrome-actions");
    const quick = document.createElement("span");
    quick.className = "chrome-history";
    quick.innerHTML = '<button type="button" id="chrome-undo" class="tk-btn tk-icon" aria-label="Undo" title="Undo (⌘Z)" disabled><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5 4 8.5 7.5 12"/><path d="M4.5 8.5H12a4 4 0 0 1 0 8H9"/></svg></button><button type="button" id="chrome-redo" class="tk-btn tk-icon" aria-label="Redo" title="Redo (⇧⌘Z)" disabled><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 5 16 8.5 12.5 12"/><path d="M15.5 8.5H8a4 4 0 0 0 0 8h3"/></svg></button>';
    actions.insertBefore(quick, $("board-info-toggle"));
    actions.append(add);
    this.installEditTools();
    const history = document.createElement("div");
    history.className = "workspace-history-actions";
    history.innerHTML = '<button type="button" id="workspace-undo" disabled>Undo</button><button type="button" id="workspace-redo" disabled>Redo</button>';
    bar.append(history);
    this.installClipboard(bar);
    this.installFileDrop();
    // Clicked controls are explicit commands: focus inside the Inspector never blocks them.
    $("workspace-undo").onclick = () => this.replayMovement("undo", {explicit:true});
    $("workspace-redo").onclick = () => this.replayMovement("redo", {explicit:true});
    $("chrome-undo").onclick = () => this.replayMovement("undo", {explicit:true});
    $("chrome-redo").onclick = () => this.replayMovement("redo", {explicit:true});
    this.updateHistoryControls();
    if (!this.hooks.viewOnly) {
      this.installKeyQueue();
      this.installBoardCommands(bar);
    }
    document.addEventListener("keydown", e => {
      if (this.hooks.viewOnly || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z" ||
          e.target.closest("input,textarea,select,[contenteditable],[role=dialog]") || document.querySelector("dialog[open]")) return;
      // Browser text editing keeps its own undo; movement replay is available
      // only when no pointer gesture or operation is still being committed.
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.pointerGesture || this.decorationGesture || this.movePending || this.historyBusy || this.pasteBusy || this.history?.busy || this.client.pendingWrites || this.saving) return;
      if (!e.shiftKey && this.cutIntent.active()) { this.cancelCut(); return; }
      this.replayMovement(e.shiftKey ? "redo" : "undo");
    }, true);
    add.onclick = () => {
      if (this.addPopup) { this.closeAddMenu(); return; }
      $("board-info").hidden = true;
      $("board-info-toggle").setAttribute("aria-expanded", "false");
      this.closeContext();
      this.addMenu(add);
      add.setAttribute("aria-expanded", String(!!this.addPopup));
    };
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && this.addPopup) {
        this.closeAddMenu(true);
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
    // Shift-, ⌘- or Ctrl-click toggles an occurrence in the selection.
    document.addEventListener("click", e => {
      if (!(e.shiftKey || e.metaKey || e.ctrlKey) || e.altKey || e.button !== 0) return;
      const card = e.target.closest("#world .workspace-card[data-placement]");
      if (!card || e.target.closest("input,textarea,select,a[href],[contenteditable],[data-placement-select],[data-item-controls],.workspace-file-versions,.workspace-tile-toolbar,.workspace-resize,[data-resize-edge]")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const id = card.dataset.placement;
      this.toggleOccurrence({placementId:id});
    }, true);
    document.addEventListener("click", (e) => {
      const select = e.target.closest("[data-placement-select]"),
        context = e.target.closest("[data-item-controls]"),
        edit = e.target.closest("[data-edit-item]"),
        child = e.target.closest("[data-child-board]");
      if (select) {
        const id = select.dataset.placementSelect;
        this.toggleOccurrence({placementId:id});
      }
      const editDocument = e.target.closest("[data-edit-document-item]");
      if (editDocument) { e.preventDefault(); this.editDocument(editDocument.dataset.editDocumentItem); return; }
      const feedback = e.target.closest("[data-item-feedback]");
      if (feedback) this.feedback.open({itemId:feedback.dataset.itemFeedback,returnFocus:feedback});
      const vote = e.target.closest("[data-item-vote]");
      if (vote) this.feedback.openVote({itemId:vote.dataset.itemVote,anchor:vote,returnFocus:vote});
      if (context) { if(context.dataset.controlsFocus === 'menu'){if(this.tileMenuPlacement===context.dataset.itemControls)this.closeTileMenu();else this.tileMenu(context.dataset.itemControls,null,context);}else this.itemControls(context.dataset.itemControls, context.dataset.controlsFocus); }
      if (edit)
        itemForm(this.client, {
          item: this.snapshot.items[edit.dataset.editItem],
          refresh: () => this.refresh(),
        });
      if (child) this.navigate(child.dataset.childBoard, child.closest("[data-placement]")?.dataset.placement);
    });
    $("workspace-retry-drafts").hidden = !this.pendingReview.size;
    $("workspace-retry-drafts").onclick = () => this.saveReview([], {});
    window.addEventListener("pagehide", () => this.persistDrafts());
    this.whiteboard = new Whiteboard(this);
    this.whiteboard.mount();
    if (!this.hooks.viewOnly) {
      this.pointer();
      this.canvasEditing();
    }
    document.addEventListener("focusout", () => queueMicrotask(() => { this.drainGeometryRefresh(); this.hooks.liveReady?.(); }));
    this.feedback = new FeedbackController({client:this.client,getBoard:()=>this.snapshot,
      getOrigin:()=>this.origin,screenToCanvas:point=>this.canvasPoint(point),
      getMode:()=>this.mode,refresh:()=>this.refresh({saveReview:false})});
    this.feedback.mount({toolbar:bar,world:$("world"),viewport:$("viewport")});
    this.feedback.reload().catch(error=>console.warn("Feedback unavailable:",error.message));
    // The Comment tool: pins, the comments layer menu and Send to agent.
    if (!this.hooks.viewOnly) { this.commentPins = new CommentPins(this); this.commentPins.mount(); this.commentPins.reload(); }
    this.arrangeInspector(bar);
    this.setMode(this.mode, false);
    this.loadCrumb();
    $("workspace-owner").hidden =
      !this.snapshot.items[this.snapshot.ownerItemId]?.content;
    $("workspace-owner").onclick = () => this.hooks.openOwner();
  }
  // The board Inspector matches the opened Tinka's Inspector: the board's identity
  // first, then labelled sections in one body with one left edge (see calm.css).
  arrangeInspector(bar) {
    const panel = $("board-info");
    const section = (title, note, nodes, cls = "") => {
      const el = document.createElement("section");
      el.className = `inspector-sec ${cls}`.trim();
      const id = `board-info-${cls.replace(/^inspector-/, "")}-heading`;
      el.setAttribute("aria-labelledby", id);
      el.innerHTML = `<h3 id="${id}">${esc(title)}${note ? ` <span>${esc(note)}</span>` : ""}</h3>`;
      nodes.filter(Boolean).forEach(node => el.append(node));
      return el;
    };
    const row = (cls, nodes) => {
      const el = document.createElement("div"); el.className = `inspector-row ${cls}`.trim();
      nodes.filter(Boolean).forEach(node => el.append(node));
      return el;
    };
    // A labelled full-width choice (Layout, Background): the label names the control.
    const choice = (label, seg) => {
      if (!seg) return null;
      const el = document.createElement("div"); el.className = "inspector-choice";
      const name = document.createElement("span"); name.className = "inspector-choice-label"; name.textContent = label; name.setAttribute("aria-hidden", "true");
      seg.setAttribute("aria-label", seg.getAttribute("aria-label") || label);
      el.append(name, seg);
      return el;
    };
    const pick = selector => bar.querySelector(selector) || panel.querySelector(selector);
    const pattern = document.createElement("div");
    pattern.className = "tk-seg canvas-pattern"; pattern.setAttribute("role", "group"); pattern.setAttribute("aria-label", "Canvas background");
    pattern.innerHTML = '<button type="button" data-canvas-pattern="dots">Dots</button><button type="button" data-canvas-pattern="grid">Grid</button><button type="button" data-canvas-pattern="plain">Plain</button>';
    // Show the board's current background, whether this panel is built before or after it loads.
    const current = $("viewport")?.dataset.canvasPattern || "plain";
    pattern.querySelectorAll("[data-canvas-pattern]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.canvasPattern === current)));
    const segments = pick(".workspace-segments");
    if (segments) { segments.classList.add("tk-seg"); segments.setAttribute("role", "group"); segments.setAttribute("aria-label", "Layout"); }
    const tonal = nodes => nodes.filter(Boolean).forEach(node => (node.matches("button") ? [node] : [...node.querySelectorAll("button")]).forEach(button => button.classList.add("tk-btn", "tk-sm", "tk-tonal")));
    const toggles = [pick("#workspace-favorites"), pick("#workspace-recent"), pick("#workspace-archive")];
    tonal(toggles);
    const edits = [pick(".workspace-history-actions"), pick(".workspace-clipboard-actions"), pick("#workspace-owner"), pick("#workspace-retry-drafts"), pick("#workspace-recover-text")];
    tonal(edits);
    const boardBackground = document.createElement("div"); boardBackground.className = "inspector-background";
    const storedColor = () => this.snapshot.background?.color || "#e7e8e1";
    boardBackground.innerHTML = `${inspectorColorMarkup("Board color",storedColor(),"board")}<button type="button" class="tk-btn tk-sm tk-tonal" data-background-image>Background image…</button>`;
    this.boardColorSync=bindInspectorColor(boardBackground,{label:"Board color palette",read:storedColor,role:"board",
      capture:()=>structuredClone({id:this.snapshot.id,...(Object.hasOwn(this.snapshot,'background')?{background:this.snapshot.background}:{})}),
      save:(color,original)=>this.saveBackground({...original.background,color},original)});
    const image = boardBackground.querySelector("[data-background-image]");
    image.onclick = () => this.backgroundImageDialog(image);
    const view = section("View", "", [choice("Layout", segments), choice("Canvas pattern", pattern), boardBackground], "inspector-view");
    const filter = section("Filter", "", [pick(".workspace-search"), row("inspector-toggles", toggles)], "inspector-filter");
    const order = document.createElement("button"); order.type = "button"; order.className = "tk-btn tk-sm tk-tonal";
    order.textContent = "Comparison order…"; order.onclick = () => this.orderForm();
    const edit = section("Edit", "", [row("inspector-edit-row", [...edits, order])], "inspector-edit");
    // Feedback: board-wide Comments as one full-width row (as in the opened Tinka's
    // Inspector), anything else the feedback controls add, and notes export.
    const comments = pick("[data-feedback-toggle]");
    comments?.classList.add("tk-btn", "inspector-row-btn");
    const extra = [...bar.children].filter(node => !node.matches?.(".inspector-sec,#workspace-keyboard-shortcuts,[data-feedback-toggle]"));
    const exporter = $("export"); exporter?.classList.add("tk-btn", "tk-sm", "tk-tonal");
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "tk-btn tk-sm tk-tonal";
    copy.textContent = "Copy notes as Markdown"; copy.onclick = () => this.copyNotes();
    const feedback = section("Feedback", "", [comments, ...extra, row("", [exporter, copy])], "inspector-feedback");
    const appearance = section("Appearance", "this browser", [row("", [panel.querySelector(".appearance-control")])], "inspector-appearance");
    const guide = pick("#workspace-keyboard-shortcuts"); guide?.classList.add("tk-btn", "tk-sm", "tk-tonal");
    const help = section("Help", "", [panel.querySelector(".board-help"), row("", [guide])], "inspector-help");
    bar.replaceChildren(view, filter, edit, feedback, appearance, help);
    // Identity: the board's name, what it holds and its description, like a Tinka's.
    const identity = document.createElement("div"); identity.className = "inspector-title board-info-identity";
    const name = document.createElement("h2"); name.id = "board-info-heading";
    const syncName = () => { name.textContent = $("board-title")?.textContent || "Board"; };
    syncName(); new MutationObserver(syncName).observe($("board-title"), { childList: true, characterData: true, subtree: true });
    const meta = panel.querySelector(".info-meta");
    identity.append(name, ...(meta ? [meta] : []));
    const description = $("board-description"); description?.classList.add("inspector-desc");
    const body = document.createElement("div"); body.className = "calm-side-body board-info-body";
    body.append(identity, ...(description ? [description] : []), bar);
    panel.querySelector("#board-info-heading:not(h2)")?.remove();
    panel.querySelector(".info-actions")?.remove();
    const head = panel.querySelector(".calm-side-head");
    panel.prepend(...(head ? [head] : []), body);
  }
  revisionsFor(item) {
    return [...fileVersions(item), ...(item.revisions || []).map((v, i) => ({
      ...v,
      id: v.id || `revision-${i + 1}`,
      name: v.name || v.title || `Revision ${i + 1}`,
      graphRevision: v,
    }))];
  }
  displayedFileVersion(concept) {
    const item = concept.graphItem;
    return fileVersion(item, this.selectedFileVersions.get(concept.placement?.id)) || fileVersion(item);
  }
  stepFileVersion(button) {
    const card = button.closest("[data-placement]");
    const concept = this.hooks.concepts().find(c => c.placement?.id === card?.dataset.placement);
    if (!concept || button.getAttribute("aria-disabled") === "true") return;
    const current = this.displayedFileVersion(concept);
    const target = nearbyFileVersions(concept.graphItem, current?.id)[button.dataset.fileVersionStep];
    if (!target) return;
    this.selectedFileVersions.set(concept.placement.id, target.id);
    this.build([concept], card);
  }
  fileVersionTicker(item, version) {
    const { previous, next } = nearbyFileVersions(item, version.id);
    const time = modifiedTime(version.modifiedAt);
    const title = `File version ${version.name}${time ? ` · Modified ${time.exact}` : ""}`;
    const arrow = (direction, candidate, path) => `<button type="button" data-file-version-step="${direction}" aria-label="${direction === "previous" ? "Previous" : "Next"} version" aria-disabled="${!candidate}" title="${candidate ? `Show ${esc(candidate.name)}` : direction === "previous" ? "Oldest version" : "Newest version"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg></button>`;
    return `<span class="workspace-file-versions" role="group" aria-label="File versions for ${esc(item.title)}">${previous || next ? arrow("previous", previous, "m9.5 4.5-3.5 3.5 3.5 3.5") : ""}<span class="workspace-file-version-name" role="status" aria-label="${esc(title)}" title="${esc(title)}">${esc(version.name)}</span>${previous || next ? arrow("next", next, "m6.5 4.5 3.5 3.5-3.5 3.5") : ""}</span>`;
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
  async navigate(id, placementId) {
    await this.saveReview([], {});
    // Remember the tile this board was entered from, so returning lands on it.
    const from = placementId || this.snapshot.placements.find(p => !p.removedAt && !p.archivedAt && this.snapshot.items[p.itemId]?.childBoardId === id)?.id;
    if (from && id !== this.snapshot.id) try { sessionStorage.setItem(`tinka/${this.config.workspaceId}/return-to-tile`, JSON.stringify({ parentBoardId: this.snapshot.id, placementId: from, childBoardId: id, at: Date.now() })); } catch {}
    if (id === this.snapshot.id) {
      this.hooks.closeReader();
      return;
    }
    location.href = `/boards/${encodeURIComponent(id)}/?from=${encodeURIComponent(this.snapshot.id)}`;
  }
  async revealPlacement(id) {
    const placement=this.snapshot.placements.find(p=>p.id===id&&!p.removedAt&&!p.archivedAt&&!p.deletedAt);
    const item=this.snapshot.items[placement?.itemId];
    if(!placement||!item||item.archivedAt||item.deletedAt){toast('This item is no longer visible on this board. Open Navigator to find its current location.');return;}
    this.filters={search:'',favorites:false,recent:false,archive:false};
    $('workspace-search').value='';
    for(const name of ['favorites','recent','archive'])$(`workspace-${name}`).setAttribute('aria-pressed','false');
    this.revealedPlacement=id;
    this.hooks.closeReader();this.selection=new Set([id]);this.rebuild();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const card=$('world').querySelector(`[data-placement="${CSS.escape(id)}"]`);
    if(this.mode==='canvas')this.recenterRevealed();else card?.scrollIntoView({block:'center'});
    toast(`Found ${item.title} on ${this.snapshot.title}.`);
    if(card){this.revealFlash=id;card.classList.add('navigator-revealed');card.querySelector('[data-open]')?.focus({preventScroll:true});clearTimeout(this.revealTimer);this.revealTimer=setTimeout(()=>{if(this.revealFlash===id)this.revealFlash=null;$('world').querySelector(`[data-placement="${CSS.escape(id)}"]`)?.classList.remove('navigator-revealed');},5000);}
  }
  recenterRevealed() {
    const placement=this.snapshot.placements.find(p=>p.id===this.revealedPlacement&&!p.removedAt&&!p.archivedAt);
    if(this.mode==='canvas'&&placement)this.hooks.revealTarget(placement);
  }
  rebuild() {
    this.hooks.data(this.adapt());
  }
  async refresh({ saveReview = true, afterRender } = {}) {
    // A live refresh must not reset an in-progress pointer gesture.
    if (this.pointerGesture || this.decorationGesture || this.moveCommitting || this.whiteboard?.editing || this.documentEditing) { this.pointerRefreshPending = true; return; }
    if (saveReview && this.pendingReview.size && !this.saving) await this.saveReview([], {});
    const snapshot = await this.client.get(
      `/api/boards/${encodeURIComponent(this.snapshot.id)}`,
    );
    if (this.pointerGesture || this.decorationGesture || this.moveCommitting || this.whiteboard?.editing || this.documentEditing) { this.pointerRefreshPending = true; return; }
    // A read started before a completed operation must not roll its UI back.
    if (snapshot.revision < Math.max(this.snapshot.revision, this.client.revision)) return;
    this.pointerRefreshPending = false;
    this.hooks.data(this.adapt(snapshot));
    afterRender?.();
    await this.loadCrumb();
    if (this.feedback) await this.feedback.reload();
    await this.commentPins?.reload();
  }
  liveBlocked() {
    return !!(this.documentEditing || this.pointerGesture || this.decorationGesture || this.decorationCommitting || this.moveCommitting || this.movePending ||
      this.whiteboard?.editing || this.whiteboard?.finishing || this.client.pendingWrites || this.historyBusy || this.history?.busy || this.pasteBusy || this.saving ||
      document.activeElement?.closest("input,textarea,select,[contenteditable]") || document.querySelector("dialog.workspace-dialog[open]"));
  }
  structuralSource(snapshot = this.snapshot) {
    // The displayed board wins over graph/catalog records. Graph data supplies
    // destination identity; targeted snapshots retain full dependency facts.
    const graph=this.workspaceGraph || {};
    const boards=new Map((graph.boards || []).map(board=>[board.id,board]));
    for(const child of Object.values(snapshot.childBoards || {}))boards.set(child.id,child);
    boards.set(snapshot.id,snapshot);
    const items=Object.fromEntries((graph.items || []).map(item=>[item.id,item]));
    Object.assign(items,snapshot.items || {});
    return structuredClone({boards:[...boards.values()],items,revision:snapshot.revision,
      ...(snapshot.structural ? {structural:snapshot.structural} : {}),resourceRoots:snapshot.resourceRoots,metadata:graph});
  }
  writeStructural(type, data, options = {}, source = this.structuralSource()) {
    return this.client.structural(type,data,source,options);
  }
  writeArrangement(type, data, unchanged, {boardId = this.snapshot.id, source, ...options} = {}) {
    // Explicit source is used by lifted children; the normal board defers live
    // reconciliation throughout its gesture. Legacy snapshots fail closed at
    // their original revision instead of consulting the mutable client watermark.
    return this.writeStructural(type,data,options,source || this.structuralSource());
  }
  syncGeometry(overrides) {
    this.whiteboard?.sync(overrides);
    // The comment layer goes back into the world first, so feedback.js sees it and
    // leaves the old numbered pins off.
    this.commentPins?.sync(overrides);
    this.feedback?.sync(overrides);
  }
  containerCanvasContains(point) {
    const viewport=$("viewport").getBoundingClientRect();
    return point.x>=viewport.left&&point.x<viewport.right&&point.y>=viewport.top&&point.y<viewport.bottom;
  }
  containerDragTarget(member, screen, allowed) {
    if (!this.containerCanvasContains(screen)) return null;
    const hit=containerDropAt(this.snapshot,member,this.canvasPoint(screen));
    return hit&&{...hit,blocked:!allowed};
  }
  showContainerDrop(hit) {
    this.containerDropElement?.removeAttribute('data-container-drop-target');
    this.containerDropElement=null;
    this.containerDropMarker?.remove();
    if(!hit)return;
    const world=$("world"), parent=world.querySelector(`[data-decoration="${CSS.escape(hit.parent.id)}"]`);
    parent?.setAttribute('data-container-drop-target',hit.blocked?'blocked':'ready');
    this.containerDropElement=parent;
    if(hit.blocked)return;
    const marker=this.containerDropMarker??=document.createElement('div');
    marker.className='container-drop-marker';
    marker.setAttribute('aria-hidden','true');
    const {x,y,length,vertical}=hit.marker, thickness=3/this.hooks.zoom();
    Object.assign(marker.style,{left:`${x+this.origin.x}px`,top:`${y+this.origin.y}px`,
      width:`${vertical?thickness:length}px`,height:`${vertical?length:thickness}px`});
    world.append(marker);
  }
  positionContainerCards(placements) {
    const world=$("world");
    for(const [id,box] of placements) {
      const card=world.querySelector(`[data-placement="${CSS.escape(id)}"]`);
      if(card)Object.assign(card.style,{left:`${box.x+this.origin.x}px`,top:`${box.y+this.origin.y}px`});
    }
  }
  async transferContainerMember(member, source, hit, position) {
    const {x,y}=position;
    const destination=hit&&!hit.blocked?hit.parent:null;
    const data={boardId:this.snapshot.id,member,containerId:destination?.id??null,
      ...(destination?{index:hit.index}:{x,y})};
    await this.writeArrangement('moveContainerMember',data,containerDropUnchanged(this.snapshot,member,[source,destination]));
    await this.refresh({saveReview:false});
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
  // One Tinka selected on its own, as ⌥← / ⌥→ leave it.
  selectOnly(id) {
    this.whiteboard?.clearSelection({finishEdit:true,focus:false});
    this.selection = new Set([id]);
    this.syncSelection();
    this.selectionMenu();
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
    guide.onclick = () => this.keyboardShortcuts();
    bar.append(guide);
    // F or Z held while a selection box is released: F fits what the box selected, Z
    // zooms to the box itself (see pointer()). A tap of F fits the selection, then the
    // board; held through any pointer press or drag, its release does nothing more. A
    // bare Z has no other use on a board (⌘/Ctrl-Z stays Undo).
    const releaseBoxKey = () => { this.boxKey = null; document.body.classList.remove("workspace-box-fit","workspace-box-zoom"); this.refreshMarquee?.(); };
    document.addEventListener("keyup", event => {
      const key = event.key?.toLowerCase();
      if (!this.boxKey || key !== this.boxKey.key) return;
      const held = this.boxKey;
      releaseBoxKey();
      event.preventDefault(); event.stopImmediatePropagation();
      if (key !== "f" || held.used || this.mode !== "canvas" || this.pointerGesture || this.decorationGesture || this.boardCommandBlocked(event)) return;
      this.hooks.fit?.("smart");
    }, true);
    document.addEventListener("pointermove", e => {
      const viewport = $("viewport");
      this.lastBoardPointer = {x:e.clientX,y:e.clientY,over:!!viewport?.contains(e.target)};
    }, true);
    // Double-click on a document card's page edits it in place, caret where you clicked.
    document.addEventListener("dblclick", e => {
      const launch = e.target.closest?.("#world .workspace-preview-launch");
      const card = launch?.closest(".workspace-card"), placement = card && this.snapshot?.placements.find(p => p.id === card.dataset.placement);
      const item = placement && this.snapshot.items[placement.itemId];
      if (!item || !this.editableDocument(item) || e.button !== 0 || this.hooks.viewOnly) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.editDocument(item.id, {point:{x:e.clientX, y:e.clientY}, placementId:placement.id});
    }, true);
    // Double-click on empty Canvas space starts a Text block there.
    document.addEventListener("dblclick", e => {
      if (this.panTool || this.mode !== "canvas" || !this.snapshot?.id || e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (!e.target.closest?.("#viewport") || e.target.closest("[data-decoration],[data-placement],.workspace-card,button,a,input,textarea,select,label,iframe,dialog,[contenteditable],[role=textbox],[role=dialog],[role=menu],[role=toolbar],.zoom-pill,.board-map,.board-map-stage")) return;
      if (this.boardCommandBlocked(e) || this.pointerGesture || this.decorationGesture) return;
      e.preventDefault();
      getSelection?.()?.removeAllRanges?.();
      this.createDecoration("text", {x:e.clientX,y:e.clientY});
    });
    document.addEventListener("pointerdown", () => { this.pointerPressed = true; if (this.boxKey) this.boxKey.used = true; }, true);
    for (const type of ["pointerup","pointercancel"]) document.addEventListener(type, () => { this.pointerPressed = false; }, true);
    globalThis.window?.addEventListener("blur", releaseBoxKey);
    document.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229 || event.altKey) return;
      const command = event.metaKey || event.ctrlKey;
      // Shift-1/2 match the physical keys, so they work on any keyboard layout.
      const shifted = digit => event.shiftKey && (event.code ? event.code === `Digit${digit}` : event.key === "!@"[digit - 1] || event.key === String(digit));
      const key = event.key.toLowerCase();
      if (command && !event.shiftKey && key === "g" && this.groupAction() && !this.boardCommandBlocked(event) &&
          !this.whiteboard?.editing && !this.documentEditing) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) this.toggleCanvasGroup();
        return;
      }
      if (command && !event.shiftKey && key === "d") {
        const editing = "input,textarea,select,[contenteditable],[role=textbox],[role=dialog]";
        const hasDrawings = this.mode === "canvas" && (this.decorationSelection?.size || this.activeDecoration);
        if (event.target.closest?.(editing) || document.activeElement?.closest(editing) ||
            document.activeElement?.tagName === "IFRAME" || document.querySelector("dialog[open]") ||
            !this.clipboardCandidates().length && !hasDrawings) return;
        // Board-owned Duplicate never falls through to browser Bookmark while
        // a held key or an in-flight action suppresses another duplication.
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat && !this.boardCommandBlocked(event)) this.duplicateSelection();
        return;
      }
      // F fits when it is released, so it (and Z) can be held through a selection box.
      if (!command && !event.shiftKey && (key === "f" || key === "z") && this.mode === "canvas") {
        if (event.repeat) { if (this.boxKey) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
        const dragging = !!(this.pointerGesture || this.decorationGesture || this.pointerPressed);
        if (!dragging && this.boardCommandBlocked(event)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        // Pressed during a drag, the key belongs to that drag and never fits on its own.
        this.boxKey = {key,used:dragging};
        document.body.classList.toggle("workspace-box-fit",key === "f");
        document.body.classList.toggle("workspace-box-zoom",key === "z");
        this.refreshMarquee?.();
        return;
      }
      if (event.repeat || this.boardCommandBlocked(event)) return;
      let action;
      if (command && !event.shiftKey && key === "a")
        action = () => {
          this.whiteboard?.clearSelection({finishEdit:true,focus:false});
          this.selection = new Set(this.renderedPlacements().map(p => p.id));
          this.syncSelection();
          // On Canvas, drawn elements join: a mixed group, or Whiteboard's own multi-selection.
          const drawn = this.mode === "canvas" ? (this.snapshot.decorations || []).map(d => d.id) : [];
          if (drawn.length && this.selection.size) { this.setMixedGroup(drawn); this.syncSelection(); }
          else if (drawn.length) this.whiteboard?.selectDecorations(drawn);
          this.selectionMenu();
        };
      else if (!command && !event.shiftKey && key === "enter" &&
          !event.target.closest?.("button,a,[role=button],.board-map-stage") && this.clipboardCandidates().length === 1) {
        const id = this.clipboardCandidates()[0].id;
        const card = [...$("world").querySelectorAll(".workspace-card[data-placement]")].find(card => card.dataset.placement === id);
        const open = card?.querySelector("[data-open]:not(:disabled)");
        if (open) action = () => open.click();
      } else if (!command && !event.shiftKey && key === "/") action = () => {
        document.dispatchEvent(new CustomEvent("tinka:navigator-open"));
      };
      else if (!command && shifted(1) && this.mode === "canvas")
        action = () => this.hooks.fit?.("board");
      else if (!command && shifted(2) && this.mode === "canvas")
        action = () => this.hooks.fit?.("selection");
      // ] brings the selection to the front and [ sends it to the back.
      else if (!command && (key === "]" || key === "[") && this.stackSelection())
        action = () => this.restackSelection(key === "]" ? "front" : "back");
      // M shows or hides the board map.
      else if (!command && !event.shiftKey && key === "m" && this.mode === "canvas")
        action = () => this.hooks.toggleMap?.();
      // A shows or hides the edit tools palette.
      else if (!command && !event.shiftKey && key === "a" && this.mode === "canvas" && $("edit-tools"))
        action = () => this.toggleEditTools();
      else if (!command && !event.shiftKey && ["v","h"].includes(key) && this.mode === "canvas" && $("edit-tools"))
        action = () => this.setCanvasTool(key === "h" ? "pan" : "pointer");
      else if (!command && key === "?") action = () => this.keyboardShortcuts();
      // E edits the one selected Markdown document.
      else if (!command && !event.shiftKey && key === "e" && this.selectedDocument()) {
        const id = this.selectedDocument().id;
        action = () => this.editDocument(id);
      }
      // C arms the Comment tool; Shift-C shows or hides the comments layer.
      else if (!command && key === "c" && this.mode === "canvas" && this.commentPins)
        action = () => event.shiftKey ? this.commentPins.toggleVisible() : this.setCanvasTool(this.commentPins.armed ? "pointer" : "comment");
      // N opens Quick jot: each Enter'd line becomes a sticky.
      else if (!command && !event.shiftKey && key === "n" && this.mode === "canvas" && this.snapshot?.id)
        action = () => this.quickJot();
      // Shift-⌘/Ctrl-C copies the board's notes as Markdown; plain ⌘/Ctrl-C stays Copy.
      else if (command && event.shiftKey && key === "c" && this.snapshot?.id) action = () => this.copyNotes();
      // T · S · D add Text, a Sticky note or a Markdown Document at the pointer.
      else if (!command && !event.shiftKey && ["t","s","d"].includes(key) && this.mode === "canvas" && this.snapshot?.id) {
        const point = this.lastBoardPointer && this.lastBoardPointer.over ? {x:this.lastBoardPointer.x,y:this.lastBoardPointer.y} : undefined;
        action = key === "d" ? () => this.createDocument(point) : () => this.createDecoration(key === "t" ? "text" : "sticky", point);
      }
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
      <dt>] / [</dt><dd>Bring the selection to the front / send it to the back</dd>
      <dt>⌘/Ctrl-G</dt><dd>Group selected Canvas objects or ungroup the selected group</dd>
      <dt>${isMacPlatform() ? "Option" : "Alt"}-drag</dt><dd>Place another copy on this canvas. Cards share their item; drawn elements have their own content.</dd>
      <dt>${MOD}← · ${MOD}→</dt><dd>Select the previous · next Tinka, in the same order as an opened Tinka steps, and bring it into view</dd>
      <dt>Enter</dt><dd>Open one selected Tinka</dd>
      <dt>⌘/Ctrl-K or /</dt><dd>Find across this project (Navigator)</dd>
      <dt>⌘/Ctrl-I</dt><dd>Inspector for the selected Tinka or this board</dd>
      <dt>Shift-click · ⌘/Ctrl-click</dt><dd>Add a Tinka to the selection</dd>
      <dt>F</dt><dd>Fit the selection, then the whole board (⌥-click Fit always fits the board)</dd>
      <dt>Hold F · Z while drawing a selection box</dt><dd>When you let go: fit what the box selected · zoom to the box itself</dd>
      <dt>Shift-1 · Shift-2 · Shift-0</dt><dd>Fit the canvas · Fit the selection · Zoom to 100%</dd>
      <dt>M</dt><dd>Show or hide the board map</dd>
      <dt>V · H</dt><dd>Pointer · Pan</dd>
      <dt>Arrow keys on a tile resize grip</dt><dd>Resize the tile. Hold Shift for ten board units.</dd>
      <dt>A</dt><dd>Show or hide the edit tools</dd>
      <dt>T · S · D</dt><dd>Add Text · a Sticky note · a Markdown Document at the pointer</dd>
      <dt>E</dt><dd>Edit the selected Markdown document</dd>
      <dt>C · Shift-C</dt><dd>Comment tool: click the board, a card or a drawn element to comment · Show or hide comments</dd>
      <dt>N</dt><dd>Quick jot: type a line, Enter adds it as a sticky; Escape closes</dd>
      <dt>?</dt><dd>Show keyboard shortcuts</dd>
      <dt>⌘/Ctrl-C · X · V</dt><dd>Copy · Cut · Paste</dd>
      <dt>Shift-⌘/Ctrl-C</dt><dd>Copy this board's notes as Markdown (text, stickies and linked item titles)</dd>
      <dt>Delete / Backspace</dt><dd>Remove selection from this board</dd>
      <dt>⌘/Ctrl-Z · Shift-⌘/Ctrl-Z</dt><dd>Undo · Redo</dd>
      <dt>Arrow keys · Shift-Arrow</dt><dd>Move selection 1 · 10 units</dd>
      <dt>Escape</dt><dd>Close the newest panel or menu, then cancel a gesture, pending Cut or selection</dd>
      <dt>On an opened Tinka: ${MOD}← · ${MOD}→ · [ · ]</dt><dd>Previous · next Tinka on this board (${MOD}↑ goes up, ${MOD}↓ into its own board)</dd></dl>`);
    dialog.addEventListener("close", () => {
      if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
    });
    return dialog;
  }
  // Work in progress blocks every board command, clicked or typed.
  commandBusy() {
    return this.hooks.viewOnly || this.pointerGesture || this.decorationGesture || this.movePending || this.historyBusy || this.pasteBusy ||
      this.client.pendingWrites || this.saving || document.querySelector("dialog[open]");
  }
  // Keyboard and native clipboard events also yield to focused fields and panels.
  clipboardBlocked() {
    return this.commandBusy() ||
      this.documentEditing || this.whiteboard?.editing ||
      document.activeElement?.closest("input,textarea,select,[contenteditable],[role=textbox],[role=dialog]") ||
      document.activeElement?.tagName === "IFRAME";
  }
  copySnapshot({cut=false} = {}) {
    let placements = this.clipboardCandidates();
    const selectedCards = new Set(placements.map(p => p.id));
    const selectedDrawings = new Set(), groups = [];
    if (!cut && this.mode === "canvas") {
      for (const id of [...this.decorationSelection,this.activeDecoration]) if (id) selectedDrawings.add(id);
      for (const group of selectedGroups(this.canvasGroups(),selectedCards,selectedDrawings)) {
        group.placementIds.forEach(id => selectedCards.add(id));
        group.decorationIds.forEach(id => selectedDrawings.add(id));
        groups.push(group);
      }
      for (const id of expandContainerSelection(this.snapshot.decorations,[...selectedDrawings])) selectedDrawings.add(id);
      for (const d of this.snapshot.decorations)
        if (selectedDrawings.has(d.id)) containerPlacementIds(d.container).forEach(id => selectedCards.add(id));
      placements = this.snapshot.placements.filter(p => selectedCards.has(p.id) && !p.removedAt && !p.deletedAt &&
        this.snapshot.items[p.itemId] && !this.snapshot.items[p.itemId].deletedAt);
    }
    const decorations = this.snapshot.decorations?.filter(d => selectedDrawings.has(d.id)).map(d => {
      if (d.type !== "line" || !d.from || !d.to) return d;
      const {from,to} = resolveLine(d,this.snapshot);
      const end = (saved, {x,y}) => selectedCards.has(saved.placementId) || selectedDrawings.has(saved.decorationId)
        ? {...saved, fallback:{x,y}} : {x,y};
      return {...d,from:end(d.from,from),to:end(d.to,to)};
    }) || [];
    if (!placements.length && !decorations.length) return null;
    const items = {}, boards = {};
    for (const p of placements) {
      const item = this.snapshot.items[p.itemId];
      const {versionStack, ...canonical} = item;
      items[item.id] = structuredClone(canonical);
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
    const clipboard = {version:1,workspaceId:this.snapshot.workspaceId,placements:structuredClone(placements),items,boards,reviewOrder:order,
      ...(decorations.length ? {decorations:structuredClone(decorations)} : {}), ...(groups.length ? {groups:structuredClone(groups)} : {})};
    if (clipboardBytes(clipboard) > 900000) throw new Error("This selection is too large to paste at once. Copy fewer objects.");
    return clipboard;
  }
  installClipboard(bar) {
    const controls = document.createElement("div");
    controls.className = "workspace-clipboard-actions";
    controls.innerHTML = '<button type="button" id="workspace-copy" disabled>Copy selection</button><button type="button" id="workspace-paste">Paste…</button>';
    bar.append(controls);
    $("workspace-copy").onclick = () => {
      // An explicit command: the copy event below skips its focus guard for this call only.
      if (this.commandBusy()) { toast("Finish the current action, then copy."); return; }
      this.explicitCopy = true;
      let copied = false;
      try { copied = document.execCommand("copy") && this.explicitCopied; }
      finally { this.explicitCopy = false; this.explicitCopied = false; }
      if (!copied) toast("Use ⌘/Ctrl-C to copy the selected objects.");
    };
    $("workspace-paste").onclick = () => {
      $("board-info").hidden = true;
      $("board-info-toggle").setAttribute("aria-expanded","false");
      $("viewport").focus({preventScroll:true});
      toast("Press ⌘/Ctrl-V here to paste board objects, a link, or text.");
    };
    document.addEventListener("copy", e => {
      if (!this.explicitCopy && (this.clipboardBlocked() || e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]"))) return;
      this.cutIntent.clear();
      try {
        const clipboard = this.copySnapshot();
        if (!clipboard || !e.clipboardData) return;
        const json = JSON.stringify(clipboard);
        e.clipboardData.clearData?.();
        try { e.clipboardData.setData(CLIPBOARD_MIME,json); } catch {}
        e.clipboardData.setData("text/plain",CLIPBOARD_PREFIX + json);
        e.preventDefault();
        if (this.explicitCopy) this.explicitCopied = true;
        const count = clipboard.placements.length + (clipboard.decorations?.length || 0);
        toast(count === 1 ? "Copied selection." : `Copied ${count} objects.`);
      } catch (error) { toast(error.message); }
    });
    document.addEventListener("cut", e => {
      if (this.clipboardBlocked() || e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog]")) return;
      this.cutIntent.clear();
      try {
        if (this.canvasGroups().some(group => group.decorationIds.length && group.placementIds.some(id => this.selection.has(id))))
          throw new Error("Ungroup before cutting items from a group that includes drawings.");
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
      else {
        this.cutIntent.clear();
        const emoji=source.kind==="text"?emojiSticker(source.text):null;
        if(emoji)this.createEmojiSticker(emoji).catch(error=>toast(error.message));
        else this.pasteClipboard(source);
      }
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
          response=await this.writeStructural("move",operation,{recordHistory:false,includeHistory:true,operationId:intent.operationId});
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
    const source=this.structuralSource();
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
      const result = await this.client.importFiles(files,{workspaceId:this.snapshot.workspaceId,targetBoardId:this.snapshot.id,targetPosition,placements},this.pasteController.signal,source);
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
    const {width,height} = clipboardBounds(clipboard);
    const viewport = $("viewport").getBoundingClientRect();
    const top = this.canvasPoint({x:viewport.left + 24,y:viewport.top + 24});
    const bottom = this.canvasPoint({x:viewport.right - 24,y:viewport.bottom - 24});
    const occupied = this.snapshot.placements.filter(p => !p.removedAt && !p.deletedAt && !p.archivedAt);
    if (clipboard.decorations?.length)
      occupied.push(...this.snapshot.decorations.map(d => decorationBounds(d,this.snapshot)));
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
  async duplicateSelection({explicit = false} = {}) {
    if ((explicit ? this.commandBusy() : this.clipboardBlocked()) || this.history?.busy) return;
    this.duplicatePending = true;
    try {
      const clipboard = this.copySnapshot();
      if (!clipboard) return;
      // Duplicate uses the copy transaction directly, leaving native clipboard
      // contents untouched. A successful duplicate cancels its captured Cut.
      const {x,y} = clipboardBounds(clipboard);
      return await this.pasteClipboard({kind:"duplicate",clipboard,targetPosition:{x:x+32,y:y+32}});
    } catch (error) { toast(error.message); }
    finally { this.duplicatePending = false; }
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
        const response = await this.writeStructural("pastePlacements",operation,{recordHistory:false,includeHistory:true});
        result = response.result;
        if (response.history) this.history.record(response.history,{type:"duplicate",data:operation});
      } else result = await this.writeStructural("pastePlacements",operation);
      written = true;
      if (source.kind === "duplicate") this.cutIntent.clear(cut);
      this.moveCommitting = false;
      this.lastPastePosition = targetPosition;
      this.filters = {search:"",favorites:false,recent:false,archive:false};
      $("workspace-search").value = "";
      for (const id of ["workspace-favorites","workspace-recent","workspace-archive"]) $(id).setAttribute("aria-pressed","false");
      const drawingIds = result.decorationIds || [];
      if (drawingIds.length && this.mode !== "canvas") this.setMode("canvas",false);
      this.whiteboard?.clearSelection({finishEdit:false,focus:false});
      this.selection = new Set(result.placementIds || []);
      await this.refresh({saveReview:false,afterRender:() => {
        if (drawingIds.length && this.selection.size) {
          this.setMixedGroup(drawingIds);
          this.syncSelection(); this.selectionMenu();
        } else if (drawingIds.length) this.whiteboard?.selectDecorations(drawingIds);
        const positions = this.snapshot.placements.filter(p => this.selection.has(p.id));
        const ids = new Set(drawingIds);
        positions.push(...this.snapshot.decorations.filter(d => ids.has(d.id)).map(d => decorationBounds(d,this.snapshot)));
        this.hooks.revealPlacements?.(positions);
      }});
      const count = result.placementIds.length + drawingIds.length;
      const noun = drawingIds.length ? (count === 1 ? "object" : "objects") : (count === 1 ? "Tinka" : "Tinkas");
      toast(source.kind === "url" ? "Link pasted." : source.kind === "text" ? "Document pasted." :
        `${source.kind === "duplicate" ? "Duplicated" : "Pasted"} ${count} ${noun}.`);
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
      const quick = $("chrome-" + direction);
      if (quick) { quick.disabled = button.disabled; quick.title = `${label ? `${verb} ${label.toLowerCase()}` : verb} (${direction === "undo" ? "⌘Z" : "⇧⌘Z"})`; }
    }
    const copy = $("workspace-copy"), paste = $("workspace-paste");
    const hasDrawings = this.mode === "canvas" && (this.activeDecoration || this.decorationSelection.size);
    if (copy) copy.disabled = !!busy || !this.clipboardCandidates().length && !hasDrawings;
    if (paste) paste.disabled = !!busy;
  }
  async replayMovement(direction, {explicit = false} = {}) {
    if (this.pointerGesture || this.decorationGesture || this.movePending || this.historyBusy || this.pasteBusy || this.history?.busy || this.client.pendingWrites || this.saving ||
        (!explicit && document.activeElement?.closest("input,textarea,select,[contenteditable],[role=dialog]")) || document.querySelector("dialog[open]") ||
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
    this.whiteboard?.reconcileSelection();
    // A view-only render (?overview) never changes this browser's saved layout.
    if (!this.hooks.viewOnly) try {
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
    this.syncEditTools?.();
    if (mode !== "canvas" && this.commentPins?.armed) this.commentPins.arm(false);
    this.commentPins?.renderBar();
    if (rebuild) this.rebuild();
  }
  build(concepts, versionCard = null) {
    if (!versionCard) this.whiteboard?.reconcileSelection();
    const world = $("world");
    if (this.mode === "canvas" && !versionCard) {
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
    // Cards and drawn elements paint in the board's one shared stacking order.
    const stackRank = this.mode === "canvas" ? stackRanks(this.snapshot, {fresh:true}) : null;
    const previews = new Map((versionCard ? [versionCard] : [...world.querySelectorAll("[data-placement]")]).map(card =>
      [card.dataset.placement, { frame: card.querySelector(".workspace-live-preview iframe"), image: card.querySelector(".workspace-card-preview img"), pdf:card.querySelector(".workspace-pdf-preview") }]));
    const renderCard = (c) => {
      const item = c.graphItem,
        p = c.placement,
        version = this.displayedFileVersion(c),
        img = version ? null : resourceURL(item.preview?.resource) || remoteURL(item.preview?.url),
        url =
          item.content?.resource &&
          ["image", "video"].includes(item.content.kind)
            ? resourceURL(item.content.resource)
            : null;
      const panel = p.presentation?.mode === "panel",
        icon = p.presentation?.mode === "icon",
        viewport = p.presentation?.viewport || { width: 1000, height: 720 };
      const documentContent = item.content?.kind === "markdown" && item.content?.resource && !item.content?.url;
      const selected = this.selection.has(p.id),
        unavailable = ["reserved", "building"].includes(item.build?.state),
        live = !icon && !unavailable && !img && (documentContent ||
          item.content?.kind === "html" && item.content?.resource && !item.content?.url);
      const excerpt = !!documentContent;
      const review = { ...item.review, ...this.pendingReview.get(item.id) };
      const previewSource = JSON.stringify([item.id, version?.content || item.content || null, version?.id, documentContent ? (panel ? "document-panel" : "document-card") : null]), previous = previews.get(p.id);
      let documentPreview = documentContent
        ? `/app/media.html?${new URLSearchParams({kind:"markdown",root:item.content.resource.rootId,path:item.content.resource.path,name:item.title,item:item.id,chrome:"none",mode:panel?"panel":"card"})}` : null;
      if (documentPreview) { const stamp=new URL(this.hooks.preview(c),location.href).searchParams.get("v"); if(stamp) documentPreview += `&v=${encodeURIComponent(stamp)}`; }
      const preview = previous?.frame?.dataset.previewSource === previewSource
        ? previous.frame.getAttribute("src") : documentPreview || this.hooks.preview(c, version);
      const imageSource = JSON.stringify([item.id, img || url]);
      const image = previous?.image?.dataset.previewSource === imageSource
        ? previous.image.getAttribute("src") : img || url;
      const pdf = !img && item.content?.kind === "pdf" ? resourceURL(item.content.resource) : null;
      const pdfSource = JSON.stringify([item.id,pdf]);
      const pdfURL = previous?.pdf?.dataset.previewSource === pdfSource ? previous.pdf.getAttribute("src") : pdf && pdfPreviewURL(pdf);
      const voteState = this.feedback?.voteState?.(item.id) || {mine:null};
      const choice = voteState.mine ? voteState.mine[0].toUpperCase() + voteState.mine.slice(1) : "Vote";
      const featuredBoard = p.presentation?.featuredFrom && this.snapshot.childBoards?.[p.presentation.featuredFrom];
      const featuredMissing = featuredBoard && !featuredBoard.placements.some(entry => entry.itemId === item.id && !entry.removedAt && !entry.deletedAt && !entry.archivedAt);
      const sourceLine = p.presentation?.featuredFrom ? `<div class="workspace-feature-source"><a href="/boards/${encodeURIComponent(p.presentation.featuredFrom)}/?from=${encodeURIComponent(this.snapshot.id)}" aria-label="Open source board ${esc(featuredBoard?.title || '')}">From ${esc(featuredBoard?.title || 'source board')} ↗</a>${featuredMissing ? '<span>Not currently in source</span>' : ''}</div>` : '';
      const boardTile = !!item.childBoardId, placeOnly = boardTile && !item.content;
      const childBoard = boardTile ? this.snapshot.childBoards?.[item.childBoardId] : null;
      const childCount = childBoard ? childBoard.placements.filter(entry => !entry.removedAt && !entry.deletedAt && !entry.archivedAt).length : this.snapshot.boardCovers?.[item.childBoardId]?.count;
      const placeMeta = boardTile ? `<span class="workspace-place-meta">Board${Number.isFinite(childCount) ? ` · ${childCount} ${childCount === 1 ? "item" : "items"}` : ""}${childBoard?.updatedAt ? ` · ${timeHTML(childBoard.updatedAt, { prefix: "edited ", verb: "Edited" })}` : ""}</span>` : "";
      const badges = `<span class="workspace-badges" aria-hidden="true">${review.star ? '<span class="workspace-badge workspace-badge-star" title="Favorite"><svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/></svg></span>' : ""}${review.note ? '<span class="workspace-badge workspace-badge-note" title="Has notes"><svg viewBox="0 0 24 24"><path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M9 11h6M9 15h4"/></svg></span>' : ""}${voteState.mine ? `<span class="workspace-badge workspace-badge-vote" title="Your vote">${esc(choice)}</span>` : ""}</span>`;
      const tileNumber = String(c.shownNumber ?? "").trim().slice(0, 8);
      const titleButton = `${tileNumber ? `<span class="workspace-concept-number workspace-caption-number">${esc(tileNumber)}</span>` : ""}<button type="button" class="workspace-panel-title" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" title="${esc(item.title)}">${esc(item.title)}</button>`;
      const select = `<button type="button" class="workspace-select-dot" data-placement-select="${esc(p.id)}" aria-pressed="${selected}" aria-label="${selected ? "Deselect" : "Select"} ${esc(item.title)}" title="${selected ? "Deselect" : "Select"} (or Shift-click the item)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 10.2 3 3 6-6.4"/></svg></button>`;
      const ticker = version && !unavailable && !this.hooks.viewOnly ? this.fileVersionTicker(item, version) : "";
      const footer = `<footer class="workspace-item-footer workspace-panel-caption">${p.presentation?.featuredFrom ? `<div class="workspace-feature-caption">${panel ? titleButton : ''}${sourceLine}</div>` : panel ? titleButton : placeMeta || '<span class="workspace-item-spacer" aria-hidden="true"></span>'}${ticker}${badges}${this.mode === "canvas" ? `<button type="button" class="workspace-resize" data-resize="${esc(p.id)}" aria-label="Resize ${esc(item.title)}" title="Drag to resize, or focus and use arrow keys" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown">◢</button>` : ""}</footer>`;
      const more = `<button type="button" class="workspace-tile-more" data-item-controls="${esc(p.id)}" data-controls-focus="menu" aria-label="Actions for ${esc(item.title)}" aria-haspopup="menu" aria-expanded="${this.tileMenuPlacement === p.id}" title="Item actions"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg>${review.note ? '<span class="workspace-note-dot" aria-hidden="true"></span>' : ""}</button>`;
      const toolbar = `<div class="workspace-tile-toolbar" role="toolbar" aria-label="Actions for ${esc(item.title)}"><button type="button" class="workspace-tool-open" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="${placeOnly ? "Open board" : "Open"} ${esc(item.title)}">${placeOnly ? "Open board" : "Open"}</button>${this.editableDocument(item) ? `<button type="button" class="workspace-tool-open workspace-tool-edit" data-edit-document-item="${esc(item.id)}" aria-label="Edit ${esc(item.title)}" title="Edit document (E)">Edit</button>` : ""}<button type="button" data-item-feedback="${esc(item.id)}" aria-label="Comments on ${esc(item.title)}" title="Comments"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg></button><button type="button" class="workspace-vote-trigger" data-item-vote="${esc(item.id)}"${this.feedback?.showsVote?.(item.id) === false ? " hidden" : ""} data-vote-value="${esc(voteState.mine || "")}" aria-haspopup="dialog" aria-pressed="${!!voteState.mine}" aria-label="Vote on ${esc(item.title)}${voteState.mine ? `. Your vote: ${esc(choice)}` : ""}" title="${voteState.mine ? `Your vote: ${esc(choice)}` : "Vote"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10H3v10h18V10h-2M3 14h18M8 3h8v9H8z"/><path d="m10 7 2 2 3-3"/></svg><span data-vote-summary>${esc(choice)}</span></button><button type="button" class="shortlist" data-star="${esc(c.key)}" aria-label="Favorite ${esc(item.title)}" aria-pressed="${!!review.star}" title="Favorite"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/></svg></button></div>`;
      const visual = unavailable
        ? `<div class="workspace-build-placeholder"><strong>${item.build.state === "building" ? "In progress" : "Reserved"}</strong><span>${esc(item.build.message || "The preview will appear when this work is ready for review.")}</span></div>`
        : live ? `<iframe ${excerpt ? 'class="workspace-document-excerpt"' : ""} src="${esc(preview)}" data-preview-source="${esc(previewSource)}" title="${esc(item.title)} ${panel ? "design" : "live"} preview" tabindex="-1" loading="lazy" inert></iframe>`
        : img || (url && item.content.kind === "image") ? `<img src="${esc(image)}" data-preview-source="${esc(imageSource)}" referrerpolicy="no-referrer" alt="${esc(item.title)} preview">`
        : pdf ? `<div class="workspace-pdf-fallback"><strong>${esc(item.title)}</strong><span>PDF · ${pdfSupported() ? "Page 1 preview" : "Preview unavailable in this browser"}</span><small>Open to read all pages or download the original.</small></div>${pdfSupported() ? `<iframe class="workspace-pdf-preview" src="${esc(pdfURL)}" data-preview-source="${esc(pdfSource)}" title="${esc(item.title)} first page" loading="lazy" tabindex="-1" inert></iframe>` : ""}`
        : item.childBoardId && !item.content ? coverMarkup(this.snapshot.boardCovers?.[item.childBoardId],item.childBoardId)
        : item.content?.text ? `<div class="workspace-document-preview">${esc(item.content.text.slice(0,2400))}</div>`
        : `<span class="workspace-title-art">${esc(item.preview?.text || item.title)}</span>`;
      const paper = paperVariables(p.presentation?.paper, theme => boardSurfaces(this.snapshot, theme, surfacePoints(p))[0]);
      const dimensions = this.mode === "canvas"
        ? `left:${p.x + this.origin.x}px;top:${p.y + this.origin.y}px;width:${p.width}px;height:${p.height}px;z-index:${stackRank?.get(stackRef("placement", p.id)) || 1};`
        : panel || icon ? `width:${p.width}px;height:${p.height}px;` : "";
      return `<article tabindex="-1" class="workspace-card ${panel ? "workspace-panel" : icon ? "workspace-icon" : "workspace-compact"} ${selected ? "selected" : ""} ${selected && this.selection.size === 1 ? "solo" : ""} ${boardTile ? "workspace-board-tile" : ""} ${placeOnly ? "workspace-place-only" : ""} ${this.revealFlash === p.id ? "navigator-revealed" : ""} ${this.pulsePlacement === p.id ? "return-pulse" : ""}" data-key="${esc(c.key)}" data-placement="${esc(p.id)}" data-build-state="${esc(item.build?.state || "ready")}"${paper ? " data-custom-paper" : ""} style="${dimensions}${paper}--panel-viewport-width:${viewport.width}px;--panel-viewport-height:${viewport.height}px;">${select}${more}<div class="workspace-card-body">${icon ? `<button type="button" class="workspace-icon-entry" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="Open ${esc(item.title)}"><span aria-hidden="true">${item.childBoardId ? "▱" : item.content?.kind === "image" ? "▧" : item.content?.kind === "html" ? "▤" : "◇"}</span><strong>${esc(item.title)}</strong></button>` : `<div class="workspace-card-preview ${panel ? "workspace-panel-preview" : ""} ${live ? "workspace-live-preview" : ""} ${excerpt ? "workspace-document-excerpt-preview" : ""}" ${live && !documentContent || panel ? `data-preview-width="${viewport.width}" data-preview-height="${viewport.height}"` : ""}>${visual}<button type="button" class="workspace-preview-launch" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}" aria-label="${placeOnly ? "Open board" : "Open"} ${esc(item.title)}"><span>${placeOnly ? 'Open board <kbd aria-hidden="true">↵</kbd>' : `Open ${esc(item.title)} ↗`}</span></button></div>${!panel ? `<div class="workspace-card-copy"><div class="workspace-compact-meta">${tileNumber ? `<span class="workspace-concept-number">${esc(tileNumber)}</span>` : ""}${unavailable ? `<span class="workspace-build-label">${item.build.state === "building" ? "In progress" : "Reserved"}</span>` : ""}</div><h3><button type="button" ${unavailable ? "disabled" : ""} data-open="${esc(c.key)}">${esc(item.title)}</button></h3>${item.description ? `<p>${esc(item.description)}</p>` : ""}${item.question ? `<p class="workspace-question">${esc(item.question)}</p>` : ""}${item.childBoardId && item.content ? `<button type="button" class="workspace-child" data-child-board="${esc(item.childBoardId)}">Open board ↗</button>` : ""}</div>` : ""}`}</div>${footer}${toolbar}${this.mode === "canvas" && !this.hooks.viewOnly ? tileResizeEdges : ""}</article>`;
    };
    if (versionCard) {
      const template = document.createElement("template");
      template.innerHTML = renderCard(concepts[0]);
      this.reconcileChildren(versionCard, template.content.firstElementChild);
      return;
    }
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
    // On Canvas, stickies, shapes, text, regions and arrows also make a board non-empty.
    const canvasEmpty = !cards && !(this.snapshot.decorations || []).length;
    this.reconcile(world, `${this.mode === "canvas" ? this.decorations() : ""}${this.mode === "grid" ? grid || '<p class="workspace-empty">Nothing here yet. Add an idea or clear a filter.</p>' : `<div class="workspace-cards">${canvasEmpty ? '<p class="workspace-empty">Nothing here yet. Add an idea or clear a filter.</p>' : cards}</div>`}`);
    // A card being edited in place keeps its editing state across re-renders.
    if (this.documentEditing) import("./board-document.js").then(m => m.reapplyEditing(this)).catch(() => {});
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
    this.boardColorSync?.();
    const canvas = $("viewport");
    if (this.paintedBoardColor !== bg.color) {
      const variables = boardColorVariables(bg.color);
      for (const role of ["color","ring","pattern"]) for (const theme of ["light","dark"]) {
        const key = `--board-${role}-${theme}`;
        if (variables[key]) canvas.style.setProperty(key, variables[key]);
        else canvas.style.removeProperty(key);
      }
      this.paintedBoardColor = bg.color;
    }
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
    const scale = !el.classList.contains("workspace-document-excerpt-preview")
      ? Math.min(el.clientWidth / width, el.clientHeight / height)
      : el.clientWidth / width;
    el.style.setProperty("--preview-scale", String(scale));
  }
  selectionMenu() {
    this.closeArrangeMenu();
    this.selectionActions?.close({focus:!!this.selectionActions.popup?.menu.contains(document.activeElement)});
    this.selectionActions ||= new SelectionActionsMenu();
    const el = $("workspace-selection");
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const focusSelector = focused?.matches("[data-selection-more]") ? "[data-selection-more]" : focused?.matches("[data-arrange-open]") ? "[data-arrange-open]" : focused?.dataset.bulk ? `[data-bulk="${focused.dataset.bulk}"]` : null;
    el.hidden = !this.selection.size;
    el.setAttribute("role", "toolbar");
    const mixed = this.mixedGroup && this.decorationSelection.size;
    const cards = `${this.selection.size} card${this.selection.size === 1 ? "" : "s"}`;
    const lockedGroup = this.canvasGroups().some(group => group.placementIds.some(id => this.selection.has(id)) && group.decorationIds.length);
    const arrange = this.mode === "canvas" && this.selectedCount() >= 2 && this.arrangeObjects().length >= 2;
    el.innerHTML = `<strong role="status">${this.selectedCount()} selected</strong>${arrange ? `<button type="button" class="tk-btn tk-sm" data-arrange-open aria-haspopup="dialog" aria-expanded="false" title="Arrange: align, distribute, tidy into a grid">${ARRANGE_ICON}<span>Arrange</span></button>` : ""}${!lockedGroup ? `<button type="button" class="tk-btn tk-sm" data-bulk="move">${mixed ? `Move ${cards}…` : "Move…"}</button>` : ""}<button type="button" class="tk-btn tk-sm tk-icon" data-selection-more aria-label="More selection actions" title="More selection actions" aria-haspopup="menu" aria-expanded="false">${MORE_SELECTION_ICON}</button><span class="tk-divider" aria-hidden="true"></span><button type="button" class="tk-btn tk-sm tk-icon" data-bulk="clear" aria-label="Clear selection" title="Clear selection (Esc)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg></button>`;
    el.querySelector("[data-arrange-open]")?.addEventListener("click", event => {
      this.selectionActions.close();this.arrangeMenu(event.currentTarget);
    });
    el.querySelectorAll("[data-bulk]").forEach(b => b.onclick = () => {this.selectionActions.close();this.bulk(b.dataset.bulk);});
    el.querySelector("[data-selection-more]").onclick = event => {
      this.closeArrangeMenu();
      const entries=[], add=(action,label,danger=false)=>entries.push({action,label,danger});
      if (this.selection.size === 1) {
        if (this.selectedDocument()) add("edit-document","Edit document");
        add("details", mixed ? "Card details…" : "Details…");
      }
      const grouping=this.groupAction();
      if (grouping) add("canvas-group",grouping.label);
      if (!lockedGroup) {
        add("feature",mixed ? `Show ${cards} on parent…` : "Show on parent…");
        add("reference",mixed ? `Add reference to ${cards}…` : "Add reference…");
        add("new-board-around",mixed ? `New board around ${cards}…` : "New board around selection…");
      }
      entries.push("separator");
      if (!lockedGroup) add("archive",this.filters.archive ? (mixed ? `Restore ${cards} here` : "Restore here") : (mixed ? `Archive ${cards} here` : "Archive here"));
      add("remove","Remove from board…",true);
      this.selectionActions.toggle({anchor:event.currentTarget,entries,context:"board",attribute:"data-bulk",
        returnFocus:()=>$("workspace-selection").querySelector("[data-selection-more]"),
        run:action=>{
          if (action === "details") this.itemControls([...this.selection][0],"notes");
          else if (action === "edit-document") { const doc=this.selectedDocument();if(doc)this.editDocument(doc.id); }
          else this.bulk(action);
        }});
    };
    this.updateHistoryControls();
    this.emitSelection();
    this.positionEditTools();
    if (focusSelector && !el.hidden) el.querySelector(focusSelector)?.focus({preventScroll:true});
  }
  // The board's items and regions, for Navigator's "On this board" outline.
  // A brief green pulse that survives keyed reconciliation while it plays.
  pulse(id) {
    clearTimeout(this.pulseTimer);
    this.pulsePlacement = id;
    const card = $("world").querySelector(`[data-placement="${CSS.escape(id)}"]`);
    if (card) { card.classList.remove("return-pulse"); void card.offsetWidth; card.classList.add("return-pulse"); }
    this.pulseTimer = setTimeout(() => { this.pulsePlacement = null; $("world").querySelector(`[data-placement="${CSS.escape(id)}"]`)?.classList.remove("return-pulse"); }, 1800);
  }
  outline() {
    if (!this.snapshot?.placements) return [];
    const regions = (this.snapshot.decorations || []).filter(d => d.type === "region" && String(d.text || "").trim()).map(d => ({ label: String(d.text).trim().split("\n")[0].slice(0, 80), x: d.x, y: d.y, width: d.width, height: d.height }));
    const kinds = {html:"Prototype",image:"Image",markdown:"Document",pdf:"PDF",video:"Video",note:"Note",text:"Text",url:"Link"};
    return this.renderedPlacements().map(p => {
      const item = this.snapshot.items[p.itemId] || {};
      const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
      const region = regions.find(r => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)?.label;
      return { placementId: p.id, title: item.title || "Untitled", kind: item.childBoardId && !item.content ? "Board" : kinds[item.content?.kind] || "Idea", region, y: p.y, x: p.x };
    }).sort((a, b) => a.y - b.y || a.x - b.x).map(({x, y, ...entry}) => entry);
  }
  syncSelection() {
    this.checkMixedGroup();
    for (const card of $("world").querySelectorAll(".workspace-card[data-placement]")) {
      const selected = this.selection.has(card.dataset.placement);
      card.classList.toggle("selected", selected);
      card.classList.toggle("solo", selected && this.selection.size === 1);
      const button = card.querySelector("[data-placement-select]");
      if (!button) continue;
      const p = this.snapshot.placements.find(p => p.id === card.dataset.placement);
      const title = this.snapshot.items[p?.itemId]?.title || "item";
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `${selected ? "Deselect" : "Select"} ${title}`);
      button.title = `${selected ? "Deselect" : "Select"} (or Shift-click the item)`;
    }
    const count = $("workspace-selection").querySelector("strong");
    if (count) count.textContent = `${this.selectedCount()} selected`;
    this.updateHistoryControls();
    this.emitSelection();
  }
  // Navigator lights the matching outline rows from this event.
  emitSelection() {
    const placementIds = [...this.selection].filter(id => this.snapshot.placements.some(p => p.id === id));
    const signature = JSON.stringify(placementIds);
    if (signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    document.dispatchEvent(new CustomEvent("tinka:selection", { detail: { boardId: this.snapshot.id, placementIds } }));
  }
  async bulk(type) {
    const ids = type === "remove" ? this.clipboardCandidates().map(p => p.id) : [...this.selection];
    try {
      if (type === "clear") {
        this.whiteboard?.clearSelection({finishEdit:true,focus:false});
        this.selection.clear();
        this.build(this.hooks.concepts());
        return;
      }
      if (type === "feature") {
        await featureOnParentDialog(this.client, {sourceBoardId:this.snapshot.id, placementIds:ids,
          refresh:async () => {this.selection.clear(); await this.refresh({saveReview:false});}});
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
      if (type === "canvas-group") {
        await this.toggleCanvasGroup();
        return;
      }
      if (type === "new-board-around") {
        this.newBoardAround(ids);
        return;
      }
      if (type === "remove") {
        if (!ids.length) return;
        makeDialog(
          "Remove these placements?",
          `<p>Remove ${ids.length} placement${ids.length === 1 ? "" : "s"} from this board${this.groupDecorations().length ? ` and delete ${this.groupDecorations().length} drawn element${this.groupDecorations().length === 1 ? "" : "s"}` : ""}. Other references, canonical items, notes and all resource files remain intact.</p><button type="submit" class="workspace-primary">Remove from this board</button>`,
          () => this.removePlacements(ids),
        );
        return;
      }
      await this.writeStructural("archive", {
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
    const drawn = this.groupDecorations().map(d => d.id);
    let confirmedRemoved = false;
    try {
      // A mixed group's drawn elements are deleted in the same write, so one Undo restores all.
      await this.writeStructural("remove", {boardId:this.snapshot.id,placementIds:ids,...(drawn.length ? {decorationIds:drawn} : {})});
      confirmedRemoved = true;
      if (drawn.length) { this.mixedGroup = false; this.decorationSelection = new Set(); }
      // Clear only the intent captured before this request, never a newer tab's cut.
      this.cutIntent.clear(cut);
      ids.forEach(id => this.selection.delete(id));
      if (ids.includes(this.contextPlacement)) this.closeContext();
      await this.refresh({saveReview:false});
      toast(drawn.length ? `Removed ${ids.length} Tinka${ids.length === 1 ? "" : "s"} and ${drawn.length} drawn element${drawn.length === 1 ? "" : "s"}. Undo to restore.`
        : `Removed ${ids.length} Tinka${ids.length === 1 ? "" : "s"} from this board. Undo to restore.`);
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
  newBoardAround(ids) {
    const source=this.structuralSource();
    makeDialog(
      "New board from selection",
      '<label>Board name<input name="title" required maxlength="1000" autofocus></label><button type="submit" class="workspace-primary">Create board and move</button>',
      async (f) => {
        await this.writeStructural("move", {
          sourceBoardId: this.snapshot.id,
          placementIds: ids,
          newBoard: {
            title: f.get("title").trim(),
            parentBoardId: this.snapshot.id,
          },
        }, {}, source);
        this.selection.clear();
        await this.refresh();
        toast("Board created around your selection.");
      }, {compact:true,shortcutHint:"Enter to create"},
    );
  }
  newBoard() {
    newBoardDialog(this.client, {
      parentBoardId: this.snapshot.id,
      snapshot:this.structuralSource(),
      opener: $("workspace-add"),
      refresh: () => this.refresh(),
    });
  }
  addChildren(item) {
    if (!item) return;
    const source=this.structuralSource();
    makeDialog(
      "Add a board to this item",
      `<label>Board name<input name="title" required maxlength="1000" autofocus value="${esc(item.title)}"></label><button type="submit" class="workspace-primary">Add board</button>`,
      async (f) => {
        await this.writeStructural("createBoard", {
          itemId: item.id,
          title: f.get("title").trim(),
        }, {}, source);
        await this.refresh();
        this.reader(item);
        toast("Board added. Primary content is still on Content.");
      }, {compact:true,shortcutHint:"Enter to create"},
    );
  }
  // The opened Tinka's chrome (its down chip, path and Inspector) follows its item.
  reader(concept) {
    const item = concept?.graphItem || concept;
    if (!item) return;
    $("notes-for").textContent = "Item notes · shared across placements";
    this.hooks.readerChanged?.();
  }
  // The boards from a root to this one, preferring the board it was entered from (?from=).
  boardPath() {
    const ws = this.workspaceGraph;
    if (!ws?.boards) return null;
    const nav = navigationGraph(ws), id = this.snapshot.id, from = new URLSearchParams(location.search).get("from");
    const path = from && (nav.parents.get(id) || []).includes(from) && nav.paths.get(from) ? [...nav.paths.get(from), id] : nav.paths.get(id) || [id];
    return path.map(board => ({ id: board, title: nav.boards.get(board)?.title || (board === id ? this.snapshot.title : "") || "Untitled board" }));
  }
  // Other boards that also show this item, for "Also on" in the path.
  alsoOn(itemId) {
    return (this.workspaceGraph?.boards || []).flatMap(board => {
      if (board.id === this.snapshot.id) return [];
      const p = (board.placements || []).find(p => p.itemId === itemId && !p.removedAt && !p.archivedAt && !p.deletedAt);
      return p ? [{ id: board.id, title: board.title || "Untitled board", placementId: p.id }] : [];
    });
  }
  // An item's own board: its title and how many items it holds.
  childInfo(item) {
    if (!item?.childBoardId) return null;
    const child = this.snapshot.childBoards?.[item.childBoardId] || this.workspaceGraph?.boards?.find(b => b.id === item.childBoardId);
    const count = child?.placements ? child.placements.filter(p => !p.removedAt && !p.deletedAt && !p.archivedAt).length : null;
    return { id: item.childBoardId, title: child?.title || item.title, count };
  }
  // Organize one opened Tinka: move it, reference it elsewhere or show it on a parent board.
  async organize(type, placementId) {
    const placementIds = [placementId];
    if (type === "feature")
      return featureOnParentDialog(this.client, { sourceBoardId: this.snapshot.id, placementIds, refresh: () => this.refresh({ saveReview: false }) });
    return destinationDialog(this.client, { sourceBoardId: this.snapshot.id, placementIds, kind: type,
      refresh: async () => { if (type === "move") this.hooks.closeReader(); await this.refresh({ saveReview: false }); } });
  }
  editItem(item) { if (item) itemForm(this.client, { item, refresh: () => this.refresh() }); }
  itemControls(id, focus = "notes") {
    if (this.contextPlacement === id) { this.closeContext(); return; }
    this.closeContext();
    const p = this.snapshot.placements.find(p => p.id === id);
    const item = this.snapshot.items[p?.itemId];
    if (!item) return;
    this.closeAddMenu();
    $("board-info").hidden = true;
    $("board-info-toggle").setAttribute("aria-expanded", "false");
    this.contextPlacement = id;
    // The Inspector: the right side is "what". It replaces the old attached
    // popup with labelled sections; notes stay canonical, appearance stays local.
    const popover = document.createElement("section");
    popover.id = "workspace-item-controls";
    popover.className = "workspace-item-controls calm-side calm-side-right";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "false");
    popover.setAttribute("aria-label", `Details of ${item.title}`);
    const note = this.pendingReview.get(item.id)?.note ?? item.review?.note ?? "";
    const kinds = {html:"Prototype",image:"Image",markdown:"Document",pdf:"PDF",video:"Video",audio:"Audio",note:"Note",text:"Text",url:"Link",file:"File"};
    const placeOnly = !!item.childBoardId && !item.content;
    const kind = item.category || (placeOnly ? "Board" : kinds[item.content?.kind] || "Idea");
    const child = item.childBoardId ? this.snapshot.childBoards?.[item.childBoardId] : null;
    const childCount = child?.placements.filter(entry => !entry.removedAt && !entry.deletedAt && !entry.archivedAt).length;
    const mode = p.presentation?.mode || "card";
    const paper = p.presentation?.paper || "#f6f7f1";
    const glyph = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg>';
    const stateLabel = {reserved:"Reserved",building:"In progress",review:"Ready for review",ready:"Ready"}[item.build?.state] || "Ready";
    popover.innerHTML = `<header class="calm-side-head"><span class="tk-eyebrow">${esc(kind)}</span><button type="button" class="tk-btn tk-sm tk-icon" data-context-close aria-label="Close item details">${glyph}</button></header>
      <div class="calm-side-body">
        <div class="inspector-title"><h2 class="${item.childBoardId ? "inspector-place" : ""}">${esc(item.title)}</h2><p>${esc(kind)}${child ? ` · ${childCount} ${childCount === 1 ? "item" : "items"}` : ""} · on ${esc(this.snapshot.title || "this board")}</p></div>
        ${item.description ? `<p class="inspector-desc">${esc(item.description)}</p>` : ""}
        <div class="inspector-open"><button type="button" class="tk-btn tk-primary" data-context-open ${["reserved","building"].includes(item.build?.state) && !placeOnly ? "disabled" : ""}>${placeOnly ? "Open board" : "Open"}</button>${item.childBoardId && item.content ? `<button type="button" class="tk-btn tk-tonal" data-context-board>Open board</button>` : ""}${resourceURL(item.resources?.find(r=>r.role==="handoff")?.resource)?`<a class="tk-btn" href="${esc(resourceURL(item.resources.find(r=>r.role==="handoff").resource))}" target="_blank" rel="noopener noreferrer">Handoff</a>`:""}<button type="button" class="tk-btn tk-tonal" data-context-edit>Edit item…</button></div>
        <section class="inspector-sec"><h3>Notes <span>saved as you type</span></h3><label class="workspace-context-note"><span class="inspector-label">Notes</span><textarea data-note="items/${esc(id)}" aria-label="Notes on ${esc(item.title)}" placeholder="A thought to return to…">${esc(note)}</textarea></label></section>
        <section class="inspector-sec"><h3>Feedback</h3><div class="workspace-context-row workspace-context-actions inspector-feedback"><button type="button" class="tk-btn tk-sm" data-context-star aria-pressed="${!!item.review?.star}">${item.review?.star ? "Unfavorite" : "Favorite"}</button><button type="button" class="tk-btn tk-sm" data-context-comments>Comments</button><button type="button" class="tk-btn tk-sm" data-context-vote>Vote</button></div></section>
        <section class="inspector-sec"><h3>Appearance <span>this placement</span></h3><div class="workspace-context-row"><span class="inspector-label">Appearance</span><div class="workspace-appearance-buttons tk-seg" role="group" aria-label="Item appearance">${[["panel", "Full preview", '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 17h18"/>'], ["card", "Compact card", '<rect x="5" y="4" width="14" height="16" rx="1"/><path d="M5 13h14M8 16h8"/>'], ["icon", "Icon", '<rect x="7" y="7" width="10" height="10" rx="2"/>']].map(([value, label, art]) => `<button type="button" data-presentation="${value}" aria-label="${label}" title="${label}" aria-pressed="${mode === value}"><svg viewBox="0 0 24 24" aria-hidden="true">${art}</svg><span>${value === "panel" ? "Full" : value === "card" ? "Card" : "Icon"}</span></button>`).join("")}</div></div><div class="inspector-paper">${inspectorColorMarkup("Paper color",paper,"paper")}</div></section>
        <section class="inspector-sec"><h3>Details</h3><dl class="inspector-props"><dt>Created</dt><dd>${timeHTML(item.createdAt, { verb: "Created", focusable: true }) || "Unknown"}</dd><dt>Edited</dt><dd>${timeHTML(item.updatedAt, { verb: "Edited", focusable: true }) || "Unknown"}</dd>${child?.updatedAt ? `<dt>Board edited</dt><dd>${timeHTML(child.updatedAt, { verb: "Edited", focusable: true })}</dd>` : ""}<dt>Status</dt><dd>${esc(stateLabel)}${item.revisions?.length ? ` · ${item.revisions.length} versions` : ""}</dd></dl>${item.build?.message ? `<p class="inspector-desc">${esc(item.build.message)}</p>` : ""}</section>
        <section class="inspector-sec inspector-acts workspace-context-row workspace-context-actions" aria-label="Item actions"><button type="button" class="tk-mi" data-context-select>${this.selection.has(id) ? "Deselect" : "Select"}</button>${this.mode === "canvas" ? '<button type="button" class="tk-mi" data-context-connect>Connect</button>' : ""}<button type="button" class="tk-mi" data-context-move>Move to board…</button><button type="button" class="tk-mi" data-context-duplicate>Duplicate<kbd class="tk-kbd" aria-hidden="true">⌘D</kbd></button><button type="button" class="tk-mi tk-danger" data-context-remove>Remove from board…</button></section>
      </div>`;
    document.body.append(popover);
    this.context = popover;
    const invoker = () => document.querySelector(`[data-item-controls="${CSS.escape(id)}"]`);
    const only = () => { this.whiteboard?.clearSelection({finishEdit:true,focus:false}); this.selection = new Set([id]); this.syncSelection(); this.selectionMenu(); };
    popover.querySelector("[data-context-close]").onclick = () => this.closeContext(true);
    popover.querySelector("[data-context-edit]").onclick = () => {
      this.closeContext();
      itemForm(this.client, {item, opener:invoker, refresh:() => this.refresh()});
    };
    popover.querySelector("[data-context-open]").onclick = () => { const open = document.querySelector(`[data-placement="${CSS.escape(id)}"] [data-open]:not(:disabled)`); this.closeContext(); open?.click(); };
    popover.querySelector("[data-context-board]")?.addEventListener("click", () => { this.closeContext(); this.navigate(item.childBoardId); });
    let presentationSource=this.structuralSource();
    let presentationRecord=structuredClone(this.snapshot.placements.find(p=>p.id===id));
    popover.querySelectorAll("[data-presentation]").forEach(button => button.onclick = async () => {
      const placement = presentationRecord;
      const presentation = { mode: "card", ...(placement.presentation || {}), mode:button.dataset.presentation };
      const patch = { presentation };
      if (button.dataset.presentation && button.dataset.presentation !== (placement.presentation?.mode || "card")) {
        const [width, height] = { panel: [560, 420], card: [320, 260], icon: [218, 112] }[presentation.mode];
        Object.assign(patch, { width, height });
      }
      try {
        await this.writeStructural("updatePlacement", { boardId: this.snapshot.id, placementId: id, patch },{},presentationSource);
        Object.assign(placement, patch);
        popover.querySelectorAll("[data-presentation]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.presentation === (presentation.mode || "card"))));
        await this.refresh();
        presentationSource=this.structuralSource();
        presentationRecord=structuredClone(this.snapshot.placements.find(p=>p.id===id));
      } catch (error) { showFailure(error); }
    });
    const latestPlacement=()=>this.snapshot.placements.find(entry=>entry.id===id);
    this.contextPaperSync=bindInspectorColor(popover.querySelector(".inspector-paper"),{
      label:"Paper color palette",options:[...tilePaperChoices,...drawingPalette],role:"paper",
      read:()=>latestPlacement()?.presentation?.paper||"#f6f7f1",
      capture:()=>({source:this.structuralSource(),placement:structuredClone(latestPlacement())}),
      save:async (paper,original)=>{
        const placement=original.placement;
        if(!placement)return;
        const presentation={mode:"card",...placement.presentation,paper};
        await this.writeStructural("updatePlacement",{boardId:this.snapshot.id,placementId:id,patch:{presentation}},{},original.source);
        await this.refresh({saveReview:false});
        presentationSource=this.structuralSource();
        presentationRecord=structuredClone(this.snapshot.placements.find(p=>p.id===id));
      },
    });
    const actions = popover.querySelector(".inspector-acts");
    actions.querySelector('[data-context-select]').onclick=()=>{this.toggleOccurrence({placementId:id});this.closeContext();};
    popover.querySelector('[data-context-star]').onclick=event=>{const button=document.querySelector(`[data-placement="${CSS.escape(id)}"] [data-star]`);button?.click();const on=button?.getAttribute('aria-pressed')==='true';event.currentTarget.textContent=on?'Unfavorite':'Favorite';event.currentTarget.setAttribute('aria-pressed',String(on));};
    popover.querySelector('[data-context-comments]').onclick=()=>{this.closeContext();this.feedback.open({itemId:item.id,returnFocus:()=>invoker()?.focus({preventScroll:true})});};
    popover.querySelector('[data-context-vote]').onclick=event=>{this.closeContext();const trigger=invoker()||event.currentTarget;this.feedback.openVote({itemId:item.id,anchor:trigger,returnFocus:trigger});};
    actions.querySelector('[data-context-connect]')?.addEventListener('click',()=>{const from=invoker();this.closeContext();this.whiteboard?.connectPlacement(id,from);this.selectionMenu();});
    actions.querySelector('[data-context-move]').onclick=()=>{this.closeContext();only();this.bulk("move");};
    actions.querySelector('[data-context-duplicate]').onclick=()=>{this.closeContext();only();this.duplicateSelection({explicit:true});};
    actions.querySelector('[data-context-remove]').onclick=()=>{this.closeContext();only();this.bulk("remove");};
    const noteField=popover.querySelector('textarea');noteField.setAttribute('aria-keyshortcuts','Meta+Enter Control+Enter');
    const hint=document.createElement('small');hint.textContent=`${commitShortcutLabel()} to save`;noteField.after(hint);
    this.contextCommit=bindCommitShortcut(noteField,{commit:async()=>{await this.hooks.flushNotes();},onError:error=>toast(error.message)});
    this.positionContext();
    document.querySelectorAll(`[data-item-controls="${CSS.escape(id)}"]`).forEach(b => b.setAttribute("aria-expanded", "false"));
    document.querySelector(`[data-placement="${CSS.escape(id)}"]`)?.classList.add("inspected");
    if (focus === "notes") noteField.focus({ preventScroll: true });
    else if(focus==="actions") actions.querySelector("button").focus({preventScroll:true});
    else popover.querySelector("[data-presentation]").focus({ preventScroll: true });
  }
  // Right-click gives a short native-feeling menu; Details… opens the Inspector.
  tileMenu(id, point, anchor = null) {
    this.closeTileMenu();
    const p = this.snapshot.placements.find(p => p.id === id), item = this.snapshot.items[p?.itemId];
    if (!item) return;
    if (!this.selection.has(id)) { this.whiteboard?.clearSelection({finishEdit:true,focus:false}); this.selection = new Set([id]); this.syncSelection(); this.selectionMenu(); }
    const placeOnly = !!item.childBoardId && !item.content, star = !!(this.pendingReview.get(item.id)?.star ?? item.review?.star);
    const handoff=resourceURL(item.resources?.find(r=>r.role==="handoff")?.resource);
    const unavailable=["reserved","building"].includes(item.build?.state) && !placeOnly;
    const menu = document.createElement("div");
    menu.className = "tk-menu workspace-tile-menu"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", `Actions for ${item.title}`);
    menu.innerHTML = `<button type="button" class="tk-mi" role="menuitem" data-tile-menu="open" ${unavailable?"disabled":""}>${placeOnly ? "Open board" : "Open experiment"}<kbd class="tk-kbd" aria-hidden="true">↵</kbd></button>${handoff?`<a class="tk-mi" role="menuitem" href="${esc(handoff)}" target="_blank" rel="noopener noreferrer">Handoff</a>`:""}${this.editableDocument(item)?'<button type="button" class="tk-mi" role="menuitem" data-tile-menu="edit-document">Edit document<kbd class="tk-kbd" aria-hidden="true">E</kbd></button><button type="button" class="tk-mi" role="menuitem" data-tile-menu="edit-document-source">Edit Markdown source</button>':""}<button type="button" class="tk-mi" role="menuitem" data-tile-menu="notes">Notes</button><button type="button" class="tk-mi" role="menuitem" data-tile-menu="details">Details…<kbd class="tk-kbd" aria-hidden="true">⌘I</kbd></button><div class="tk-msep" role="separator"></div><button type="button" class="tk-mi" role="menuitem" data-tile-menu="star">${star ? "Unfavorite" : "Favorite"}</button><button type="button" class="tk-mi" role="menuitem" data-tile-menu="move">Move to board…</button><button type="button" class="tk-mi" role="menuitem" data-tile-menu="duplicate">Duplicate<kbd class="tk-kbd" aria-hidden="true">⌘D</kbd></button>${this.mode === "canvas" && !this.hooks.viewOnly ? '<button type="button" class="tk-mi" role="menuitem" data-tile-menu="front">Bring to front<kbd class="tk-kbd" aria-hidden="true">]</kbd></button><button type="button" class="tk-mi" role="menuitem" data-tile-menu="back">Send to back<kbd class="tk-kbd" aria-hidden="true">[</kbd></button>' : ""}<div class="tk-msep" role="separator"></div><button type="button" class="tk-mi tk-danger" role="menuitem" data-tile-menu="remove">Remove from board…</button>`;
    this.closeContext();
    document.body.append(menu); this.tilePopup = menu;this.tileMenuPlacement=id;
    anchor?.setAttribute("aria-expanded","true");
    positionTilePopover(menu,anchor,point);
    const card = () => document.querySelector(`[data-placement="${CSS.escape(id)}"]`);
    menu.onclick = e => {
      const action = e.target.closest("[data-tile-menu]")?.dataset.tileMenu; if (!action) {if(e.target.closest("a"))this.closeTileMenu();return;}
      this.closeTileMenu();
      if (action === "open") card()?.querySelector("[data-open]:not(:disabled)")?.click();
      else if (action === "edit-document") this.editDocument(item.id, {placementId:id});
      else if (action === "edit-document-source") this.editDocument(item.id, {placementId:id, source:true});
      else if (action === "notes") this.hooks.editNote?.(`items/${id}`,card()?.querySelector("[data-item-controls]"));
      else if (action === "details") this.itemControls(id, "notes");
      else if (action === "star") card()?.querySelector("[data-star]")?.click();
      else if (action === "move") this.bulk("move");
      else if (action === "duplicate") this.duplicateSelection({explicit:true});
      else if (action === "front" || action === "back") this.restackSelection(action);
      else if (action === "remove") this.bulk("remove");
    };
    this.tileMenuBinding=bindTileMenu(menu,{close:()=>this.closeTileMenu(),returnFocus:()=>card()?.querySelector('[data-item-controls]'),anchor:anchor||card()});
  }
  closeTileMenu() {
    this.tileMenuBinding?.destroy();this.tileMenuBinding=null;
    if(this.tileMenuPlacement)document.querySelector(`[data-item-controls="${CSS.escape(this.tileMenuPlacement)}"]`)?.setAttribute('aria-expanded','false');
    this.tilePopup?.remove(); this.tilePopup = null;this.tileMenuPlacement=null;
  }

  positionContext() {
    if (!this.context) return;
    this.contextPaperSync?.();
    const card = document.querySelector(`[data-placement="${CSS.escape(this.contextPlacement)}"]`);
    if (!card) { this.closeContext(); return; }
    // The Inspector stays docked at the right edge; the inspected tile keeps a quiet mark.
    card.classList.add("inspected");
    this.context.hidden = false;
  }
  closeContext(focus = false) {
    if (!this.context) return;
    const id = this.contextPlacement;
    this.contextCommit?.destroy(); this.contextCommit=null; this.contextPaperSync=null;
    this.context.remove(); this.context = null; this.contextPlacement = null;
    cancelAnimationFrame(this.contextFrame);
    document.querySelectorAll(".workspace-card.inspected").forEach(card => card.classList.remove("inspected"));
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
      if (!decoration.matches(".decoration-region:not(.whiteboard-shape,.whiteboard-container)") || e.target.closest("[data-decoration-label]")) return false;
      const bounds = decoration.getBoundingClientRect();
      const label = decoration.querySelector("[data-decoration-label]")?.getBoundingClientRect();
      return e.clientX > bounds.left + 6 && e.clientX < bounds.right - 6 &&
        e.clientY > Math.max(bounds.top + 28, label?.bottom || bounds.top) && e.clientY < bounds.bottom - 6;
    };
    const setSelection = selected => {
      if (selected.size === this.selection.size && [...selected].every(id => this.selection.has(id))) return;
      this.whiteboard?.clearSelection({finishEdit:true,focus:false});
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
      // Drawn elements join by positive intersection; a plain colored region (where a
      // box may start) only when the box encloses it.
      const drawn = new Set(marquee.additive ? marquee.originalDecorations : []);
      if (box.right > box.left && box.bottom > box.top)
        for (const {id,element,region} of marquee.decorations) {
          if (!element.isConnected) continue;
          const r = element.getBoundingClientRect();
          if (region ? r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom
            : r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom) drawn.add(id);
        }
      includeGroupMembers(marquee.groups,selected,drawn);
      setSelection(selected);
      if (drawn.size !== this.decorationSelection.size || [...drawn].some(id => !this.decorationSelection.has(id))) {
        this.decorationSelection = drawn;
        this.whiteboard?.sync(this.whiteboard.overrides);
      }
      const total = selected.size + drawn.size;
      const text = this.boxKey?.key === "z" ? "Zoom here" : this.boxKey?.key === "f" ? (selected.size ? `Fit ${selected.size} selected` : "Nothing to fit") : `${total} selected`;
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
      const decorations = this.mode === "canvas" ? [...$("world").querySelectorAll("[data-decoration]")].map(element => ({id:element.dataset.decoration,element,
        region:element.classList.contains("decoration-region") && !element.classList.contains("whiteboard-shape")})) : [];
      const groups = this.canvasGroups(new Set(cards.filter(({id}) => {
        const p = placements.get(id);
        return !p.archivedAt && !this.snapshot.items[p.itemId]?.archivedAt;
      }).map(({id}) => id)));
      const originalDecorations = new Set([...this.decorationSelection, ...(this.activeDecoration ? [this.activeDecoration] : [])]);
      marquee = {pointerId:e.pointerId,x:e.clientX,y:e.clientY,last:{x:e.clientX,y:e.clientY},groups,
        anchor:{x:(e.clientX - world.left) / zoom,y:(e.clientY - world.top) / zoom},
        original:new Set(this.selection),additive:e.shiftKey,cards,active:false,
        decorations,originalDecorations,originalActive:this.activeDecoration,originalMixed:this.mixedGroup};
      this.pointerGesture = true;
      this.updateHistoryControls();
      // The toolbar keeps its existing visibility until this gesture finishes.
      // Only the count and card selection state change while the box is active.
      e.preventDefault();
      e.stopImmediatePropagation();
      return true;
    };
    // The drawn box in board units, clipped to the canvas as it was shown; null when too
    // small to mean an area (a click).
    const marqueeArea = done => {
      const bounds = viewport.getBoundingClientRect(), world = $("world").getBoundingClientRect(), zoom = this.hooks.zoom();
      const anchor = {x:world.left + done.anchor.x * zoom,y:world.top + done.anchor.y * zoom};
      const left = Math.max(bounds.left,Math.min(anchor.x,done.last.x)), right = Math.min(bounds.right,Math.max(anchor.x,done.last.x));
      const top = Math.max(bounds.top,Math.min(anchor.y,done.last.y)), bottom = Math.min(bounds.bottom,Math.max(anchor.y,done.last.y));
      if (Math.max(right - left,bottom - top) < 24 || right <= left || bottom <= top) return null;
      return {x:(left - world.left) / zoom - this.origin.x,y:(top - world.top) / zoom - this.origin.y,width:(right - left) / zoom,height:(bottom - top) / zoom};
    };
    const finishMarquee = cancelled => {
      if (!marquee) return;
      const done = marquee;
      if (done.active && !cancelled) renderMarquee();
      // Released with Z held: zoom to the drawn box; with F held: fit what it selected
      // (nothing selected, nothing moves). Either way it selects as usual first.
      const held = !cancelled && done.active && this.mode === "canvas" ? this.boxKey?.key : null;
      const area = held && marqueeArea(done);
      if (done.active && this.boxKey) this.boxKey.used = true;
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
      // Drawn elements: cards with them make a mixed group; on their own they become
      // Whiteboard's multi-selection (one is an ordinary selection).
      if (cancelled) {
        if (done.originalMixed) this.setMixedGroup(done.originalDecorations);
        else if (done.originalActive) this.whiteboard?.select(done.originalActive);
        else this.whiteboard?.selectDecorations([...done.originalDecorations]);
      } else if (!done.active) {
        if (!done.additive) { this.mixedGroup = false; if (this.decorationSelection.size) { this.decorationSelection = new Set(); this.whiteboard?.sync(this.whiteboard.overrides); } }
      } else if (this.decorationSelection.size && this.selection.size) this.setMixedGroup(this.decorationSelection);
      else if (this.decorationSelection.size) { this.mixedGroup = false; this.whiteboard?.selectDecorations([...this.decorationSelection]); }
      const before = viewport.getBoundingClientRect();
      this.selectionMenu();
      const after = viewport.getBoundingClientRect();
      this.hooks.shiftViewport?.(before.left - after.left,before.top - after.top);
      this.pointerGesture = false;
      this.updateHistoryControls();
      try { viewport.releasePointerCapture(done.pointerId); } catch {}
      drainRefresh();
      if (area && held === "z") this.hooks.fit?.("area",area);
      else if (area && held === "f" && this.clipboardCandidates().length) this.hooks.fit?.("selection");
    };
    this.refreshMarquee = () => { if (marquee?.active) renderMarquee(); };
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
      parent?.classList.toggle("workspace-parent-drop-ready", !!gesture && !gesture.copy && !gesture.resize && !gesture.decorations &&
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
      if (gesture.copy) return;
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
      this.showGuides([]);
      this.showContainerDrop(null);
      gesture.copyLayer?.remove();
      if (gesture.copy) viewport.classList.remove("workspace-copy-drag");
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
    const withContainerMembers = ids => {
      const wanted = new Set(expandContainerSelection(this.snapshot.decorations,ids));
      return this.snapshot.decorations.filter(d => wanted.has(d.id));
    };
    const eligibleCopy = p => p && !p.removedAt && !p.deletedAt && !p.archivedAt &&
      this.snapshot.items[p.itemId] && !this.snapshot.items[p.itemId].deletedAt && !this.snapshot.items[p.itemId].archivedAt;
    const withContainedCards = (entries, decorations, visible) => {
      const selected=new Set(entries.map(({p})=>p.id));
      const members=new Set((decorations||[]).flatMap(d=>containerPlacementIds(d.container)));
      const attached=this.snapshot.placements.filter(p=>members.has(p.id)&&!selected.has(p.id)&&eligibleCopy(p)&&visible.has(p.id));
      return [...entries,...attached.map(p=>({p:{...p},element:visible.get(p.id)}))];
    };
    const beginCopyPreview = gesture => {
      const world = $("world"), layer = document.createElement("div");
      layer.className = "workspace-copy-layer";
      layer.setAttribute("aria-hidden","true");
      let stills = 0;
      for (const {p,element} of gesture.entries) {
        const ghost = copyCardPreview(element,this.snapshot.items[p.itemId].title,() => stills++ < 6);
        ghost.classList.add("workspace-copy-ghost");
        layer.append(ghost);
      }
      const template = document.createElement("template");
      for (const drawing of gesture.decorations) {
        template.innerHTML = decorationMarkup({...drawing,id:`copy-${crypto.randomUUID()}`},this.snapshot,this.origin);
        const ghost = template.content.firstElementChild;
        ghost.classList.add("workspace-copy-ghost");
        ghost.removeAttribute("data-decoration");
        ghost.inert = true;
        layer.append(ghost);
      }
      world.append(layer);
      gesture.copyLayer = layer;
      viewport.classList.add("workspace-copy-drag");
      const count = gesture.entries.length + gesture.decorations.length;
      setHint(count > 1 ? `Copying ${count} selected objects` : "Release to place a copy");
    };
    const finishCopy = async gesture => {
      const board = this.snapshot, cut = this.cutIntent.active();
      const placements = gesture.entries.map(entry => entry.p);
      const stillDrawn = gesture.decorations.map(decorationUnchanged);
      const linePoints = (d,snapshot) => {
        const {from,to} = resolveLine(d,snapshot);
        return [from.x,from.y,to.x,to.y].join(",");
      };
      this.duplicatePending = true;
      this.movePending = true;
      this.moveCommitting = true;
      let result;
      try {
        result = await this.writeArrangement("duplicateOccurrences",{
          boardId:board.id,placementIds:placements.map(p => p.id),decorationIds:gesture.decorations.map(d => d.id),
          ...gesture.translation,
        }, latest => placements.every(p => JSON.stringify(p) === JSON.stringify(latest.placements.find(saved => saved.id === p.id))) &&
          stillDrawn.every(unchanged => unchanged(latest)) && gesture.decorations.every(d => d.type !== "line" || linePoints(d,latest) === linePoints(d,board)) &&
          sameGroups(board,latest,placements.map(p => p.id),gesture.decorations.map(d => d.id)));
        this.cutIntent.clear(cut);
        this.moveCommitting = false;
        await this.refresh({saveReview:false,afterRender:() => {
          if (result.placementIds.length) {
            this.whiteboard?.clearSelection({finishEdit:false,focus:false});
            this.selection = new Set(result.placementIds);
            this.setMixedGroup(result.decorationIds);
            this.syncSelection();
            this.selectionMenu();
          } else this.whiteboard?.selectDecorations(result.decorationIds);
        }});
        const count = result.placementIds.length + result.decorationIds.length;
        toast(count > 1 ? `Placed ${count} copies.` : "Placed a copy.");
      } catch (error) {
        this.moveCommitting = false;
        if (!result) try { await this.refresh({saveReview:false}); } catch {}
        toast(result ? "Copy saved. Reload to see it." : error.conflict ? `Copy not saved. ${error.message}` : `Could not confirm the copy. ${error.message}`);
      } finally {
        this.duplicatePending = false;
        this.movePending = false;
        this.updateHistoryControls();
        drainRefresh();
      }
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
      const derived = this.snapshot.boardCovers?.[owner.childBoardId];
      const represented = [...(derived?.tiles || []), ...(derived?.layout?.tiles || [])]
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
        gesture.lifted = {boardId:board.id,p:{...p},item,tile,proxy,source:this.structuralSource()};
        tile.classList.add("workspace-cover-lifted");
        activate(gesture);
        setHint(`Lifted ${item.title} · drag to place`);
      }, 450);
    };
    const drainRefresh = () => this.drainGeometryRefresh();
    // Drawn elements belong to this board, so a group holding them never drops into another.
    const dropTarget = (gesture, x, y) => gesture.copy || gesture.decorations ? null : this.boardDropTarget(gesture, x, y);
    const containerTarget = (gesture,x,y) => {
      if(gesture.copy||gesture.resize||gesture.lifted)return null;
      const member=gesture.fromDecoration?{decorationId:gesture.fromDecoration}:{placementId:gesture.p.id};
      const allowed=!gesture.fromDecoration&&gesture.entries.length===1&&!gesture.decorations?.length&&
        !this.groupForOccurrence(member)&&eligibleCopy(gesture.p);
      const screen={x,y}, inside=this.containerCanvasContains(screen);
      return {member,inside,source:allowed?containerMemberFor(this.snapshot,member):null,
        hit:this.containerDragTarget(member,screen,allowed)};
    };
    // A press on a drawn element in a mixed group drags the whole group. Window capture
    // runs before Whiteboard's own handler, which would otherwise select just that element.
    // Whiteboard clears drawn elements on any other press, so a press on a grouped
    // card keeps them aside for the card drag below.
    // One Escape clears a whole mixed group (window capture runs before Whiteboard's,
    // which would clear only the drawn elements).
    window.addEventListener("keydown", e => {
      if (e.key === "Escape" && drag?.copy) { cancel(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.key === "Escape" && this.selectionActions?.popup) {
        this.selectionActions.close({focus:true});e.preventDefault();e.stopImmediatePropagation();return;
      }
      if (e.key === "Escape" && this.arrangePopup) {
        this.closeArrangeMenu({focus:true});e.preventDefault();e.stopImmediatePropagation();return;
      }
      if (e.key === "Escape" && this.panTool && !document.querySelector("dialog[open]")) {
        this.setCanvasTool("pointer");e.preventDefault();e.stopImmediatePropagation();return;
      }
      if (e.key !== "Escape" || !this.mixedGroup || this.whiteboard?.editor || this.context || this.addPopup ||
          document.querySelector("dialog[open]") || e.target.closest?.("input,textarea,select,[contenteditable]")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.whiteboard?.clearSelection({finishEdit:true,focus:false});
      this.mixedGroup = false;
      this.selection.clear(); this.build(this.hooks.concepts());
    }, true);
    window.addEventListener("pointerdown", e => {
      this.heldGroup = this.mixedGroup && e.target.closest?.("#world .workspace-card.selected") ? this.decorationSelection : null;
    }, true);
    // Whiteboard handles single drawn elements on document capture. Take their
    // Option-drag first, without changing either selection or persisted objects.
    window.addEventListener("pointerdown", e => {
      if (this.panTool || !e.altKey || e.shiftKey || this.mode !== "canvas" || e.button !== 0 || e.isPrimary === false || e.pointerType === "touch" ||
          this.commandBusy() || this.whiteboard?.editing || this.documentEditing || drag || marquee || pointers.size) return;
      const element = e.target.closest?.("#world [data-decoration]");
      if (!element || e.target.closest("button,input,textarea,select,[contenteditable],[data-endpoint],[data-decoration-resize],[data-port]")) return;
      const decoration = this.snapshot.decorations.find(d => d.id === element.dataset.decoration);
      if (!decoration) return;
      if (decoration.type === "region" && !decoration.shape && !decoration.container && !e.target.closest("[data-decoration-label]")) {
        const r = element.getBoundingClientRect();
        if (e.clientX > r.left + 6 && e.clientX < r.right - 6 && e.clientY > r.top + 28 && e.clientY < r.bottom - 6) return;
      }
      const persistentGroup = this.groupForOccurrence({decorationId:decoration.id});
      const grouped = this.decorationSelection.has(decoration.id);
      const visible = new Map([...$("world").querySelectorAll(".workspace-card[data-placement]")].map(card => [card.dataset.placement,card]));
      const copiedCards = grouped && this.mixedGroup ? this.clipboardCandidates() :
        this.snapshot.placements.filter(p => persistentGroup?.placementIds.includes(p.id));
      const copiedDrawings = grouped ? [...this.decorationSelection] : persistentGroup?.decorationIds || [decoration.id];
      const decorations=withContainerMembers(copiedDrawings);
      const entries = withContainedCards(copiedCards.filter(p=>eligibleCopy(p)&&visible.has(p.id)).map(p => ({p,element:visible.get(p.id)})),decorations,visible);
      drag = {element,entries,decorations,
        copy:true,x:e.clientX,y:e.clientY,pointerId:e.pointerId,zoom:this.hooks.zoom(),active:false,threshold:6};
      suppressedClick = null;
      pointers.add(e.pointerId);
      this.pointerGesture = true;
      this.updateHistoryControls();
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointerdown", e => {
      if (this.panTool || this.mode !== "canvas" || e.button !== 0 || e.isPrimary === false || e.pointerType === "touch" ||
          e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || this.movePending || drag || marquee || pointers.size) return;
      const element = e.target.closest?.("#world [data-decoration]");
      if (!element ||
          e.target.closest("button,input,textarea,select,[contenteditable],[data-endpoint],[data-decoration-resize],[data-port]")) return;
      const decorationId = element.dataset.decoration;
      const persistentGroup = this.groupForOccurrence({decorationId});
      if (persistentGroup && !this.whiteboard?.editing && !this.documentEditing) this.selectCanvasGroup(persistentGroup);
      if (!this.decorationSelection.has(decorationId) || !this.keyboardDecorations().length) return;
      suppressedClick = null;
      pointers.add(e.pointerId);
      const visible = new Map([...$("world").querySelectorAll(".workspace-card[data-placement]")].map(card => [card.dataset.placement,card]));
      const decorations=withContainerMembers(this.keyboardDecorations().map(d=>d.id));
      const entries = withContainedCards(this.snapshot.placements.filter(p => this.selection.has(p.id) && visible.has(p.id) && !p.removedAt && !p.deletedAt && !p.archivedAt)
        .map(p => ({p:{...p},element:visible.get(p.id)})),decorations,visible);
      drag = {id:null,p:{x:0,y:0,width:0,height:0},x:e.clientX,y:e.clientY,pointerId:e.pointerId,resize:false,element,
        zoom:this.hooks.zoom(),active:false,threshold:6,entries,decorations,
        fromDecoration:decorationId};
      this.pointerGesture = true;
      this.updateHistoryControls();
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
    // Every dragged placement is still active with its gesture-start geometry.
    const unmoved = (latest, gesture) => {
      const placements = gesture.entries.map(entry => entry.p), drawings = gesture.decorations || [];
      return placementsUnchanged(latest,placements) && drawings.every(d => decorationUnchanged(d)(latest)) &&
        sameGroups(this.snapshot,latest,placements.map(p => p.id),drawings.map(d => d.id));
    };
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
    document.addEventListener("click", e => {
      if (this.mode !== "canvas" || e.button !== 0 || e.detail === 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const card = e.target.closest?.("#world .workspace-card[data-placement]");
      if (!card || e.target.closest("input,textarea,a[href],[contenteditable],.workspace-tile-toolbar,.workspace-file-versions,[data-placement-select],[data-item-controls],[data-child-board],[data-resize],[data-resize-edge]")) return;
      const group = this.groupForOccurrence({placementId:card.dataset.placement});
      if (!group) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.selectCanvasGroup(group,{only:true});
    }, true);
    viewport.addEventListener(
      "pointerdown",
      (e) => {
        if (this.panTool || this.mode !== "canvas" || e.button !== 0 || this.movePending || pointers.size > 1) return;
        if (drag && drag.pointerId !== e.pointerId) {
          cancel();
          return;
        }
        const card = e.target.closest(".workspace-card");
        if (!card) { beginMarquee(e); return; }
        const handle = e.target.closest("[data-drag],[data-resize],[data-resize-edge]");
        const resize = handle?.dataset.resizeEdge || (handle?.dataset.resize ? "se" : "");
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
        const copy = e.altKey && e.pointerType !== "touch" && !resize;
        if (copy && (!eligibleCopy(p) || this.commandBusy() || this.whiteboard?.editing || this.documentEditing)) return;
        const persistentGroup = !resize && this.groupForOccurrence({placementId:id});
        if (!resize && !(e.shiftKey || e.metaKey || e.ctrlKey)) {
          if (this.heldGroup?.size && this.selection.has(id)) this.setMixedGroup(this.heldGroup);
          if (persistentGroup && !copy) this.selectCanvasGroup(persistentGroup);
          this.heldGroup = null;
        }
        drag = {
          id,
          p: { ...p },
          x: e.clientX,
          y: e.clientY,
          pointerId: e.pointerId,
          resize,
          copy,
          element: card,
          zoom: this.hooks.zoom(),
          active: false,
          threshold:e.pointerType === "touch" ? 8 : 6,
        };
        const visible = new Map([...$("world").querySelectorAll(".workspace-card[data-placement]")]
          .map(element => [element.dataset.placement,element]));
        const sourceIds = this.selection.has(id) ? this.selection : new Set(persistentGroup?.placementIds || []);
        const selected = drag.resize ? [] : this.snapshot.placements.filter(p => sourceIds.has(p.id) && visible.has(p.id) && eligibleCopy(p));
        drag.entries = (selected.some(p => p.id === id) ? selected : [p])
          .map(p => ({p:{...p},element:visible.get(p.id)}));
        // A mixed group's drawn elements travel with its cards.
        if (this.heldGroup?.size && this.selection.has(id)) { this.setMixedGroup(this.heldGroup); this.heldGroup = null; }
        if (!drag.resize && this.mixedGroup && this.selection.has(id) && this.groupDecorations().length)
          drag.decorations = withContainerMembers(this.groupDecorations().map(d => d.id));
        else if (copy && persistentGroup?.decorationIds.length)
          drag.decorations = withContainerMembers(persistentGroup.decorationIds);
        if (copy) drag.decorations ||= [];
        drag.entries=withContainedCards(drag.entries,drag.decorations,visible);
        this.pointerGesture = true;
        this.updateHistoryControls();
        if (!copy && (!this.workspaceGraph || this.workspaceGraph.revision !== this.snapshot.revision))
          this.client.get("/api/workspace?view=graph&covers=0").then(ws => {
            if (!this.workspaceGraph || ws.revision >= this.workspaceGraph.revision) this.workspaceGraph = ws;
          }).catch(() => {});
        if (!drag.decorations && !persistentGroup) beginHold(drag);
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
          if (drag.copy) beginCopyPreview(drag);
          else drag.entries.forEach(entry => entry.element.classList.add("workspace-dragging"));
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        parentReady(drag);
        if (drag.lifted) {
          drag.moved ||= moved;
          positionProxy(drag.lifted.proxy, e.clientX, e.clientY);
          showTarget(dropTarget(drag, e.clientX, e.clientY));
          return;
        }
        let dx = screenX / drag.zoom,
          dy = screenY / drag.zoom;
        // Smart guides: the moving group's (or resized card's) edges and centres snap to
        // other objects within six screen pixels; ⌘ (Ctrl off macOS) held turns it off.
        if (!snapDisabled(e, isMacPlatform())) {
          drag.snapTargets ||= this.snapTargets(new Set(drag.entries.map(entry => entry.p.id)), new Set((drag.decorations || []).map(d => d.id)));
          const moving = [...drag.entries.map(entry => entry.p), ...(drag.decorations || []).map(d => decorationBounds(d,this.snapshot))];
          const box = drag.resize ? resizePlacementBox(drag.p,drag.resize,dx,dy) : moving.length ? boundsOf(moving) : null;
          if (box) {
            const snap = snapBox(drag.resize ? box : {...box,x:box.x + dx,y:box.y + dy}, drag.snapTargets, 6 / drag.zoom, {resize:drag.resize});
            dx += snap.dx; dy += snap.dy;
            this.showGuides(snap.guides);
          }
        } else this.showGuides([]);
        drag.translation = {dx:Math.round(dx),dy:Math.round(dy)};
        if (drag.copy) {
          drag.copyLayer.style.transform = `translate(${drag.translation.dx}px,${drag.translation.dy}px)`;
          return;
        }
        const singleCard=!drag.fromDecoration&&drag.entries.length===1;
        drag.patch = drag.resize
          ? resizePlacementBox(drag.p,drag.resize,dx,dy)
          : singleCard ? {x:Math.round(drag.p.x + dx),y:Math.round(drag.p.y + dy)}
          : { x:drag.p.x + drag.translation.dx, y:drag.p.y + drag.translation.dy };
        for (const entry of drag.entries) {
          const patch = drag.resize || singleCard ? drag.patch : {
            x:entry.p.x + drag.translation.dx, y:entry.p.y + drag.translation.dy,
          };
          for (const [key,value] of Object.entries(patch))
            entry.element.style[key === "x" ? "left" : key === "y" ? "top" : key] =
              (key === "x" ? value + this.origin.x : key === "y" ? value + this.origin.y : value) + "px";
        }
        this.syncGeometry({placements:new Map(drag.entries.map(entry => [entry.p.id,
          drag.resize || singleCard ? drag.patch : {x:entry.p.x + drag.translation.dx,y:entry.p.y + drag.translation.dy}])),
          ...(drag.decorations ? {decorations:new Map(drag.decorations.map(d => [d.id,this.shiftedDecoration(d,drag.translation.dx,drag.translation.dy)]))} : {})});
        const container=containerTarget(drag,e.clientX,e.clientY), target=dropTarget(drag,e.clientX,e.clientY);
        this.showContainerDrop(container?.hit);
        if(container?.hit||container?.inside&&container.source&&!target) {
          showTarget(null);
          setHint(containerDropLabel(container.hit,container.source));
        } else showTarget(target);
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
        const container=done.active?containerTarget(done,e.clientX,e.clientY):null;
        const target=done.active&&!container?.hit?dropTarget(done,e.clientX,e.clientY):null;
        drag = null;
        this.pointerGesture = false;
        this.updateHistoryControls();
        done.element.classList.remove("workspace-dragging");
        if (done.copy) {
          if (done.active) { suppressedClick = true; e.preventDefault(); }
          const box = viewport.getBoundingClientRect();
          const inside = e.clientX >= box.left && e.clientX < box.right && e.clientY >= box.top && e.clientY < box.bottom;
          if (inside && done.active && done.translation && (done.translation.dx || done.translation.dy)) {
            this.hooks.holdView?.();
            this.showGuides([]); clearTarget();
            try { await finishCopy(done); } finally { finishVisuals(done); }
          } else { finishVisuals(done); drainRefresh(); }
          return;
        }
        finishVisuals(done);
        if (!done.active || (done.lifted ? !done.moved : !done.patch)) {
          if (done.active) suppressedClick = true;
          else if (done.fromDecoration) {
            const group = this.groupForOccurrence({decorationId:done.fromDecoration});
            if (group) this.selectCanvasGroup(group,{only:true});
            else this.whiteboard?.select(done.fromDecoration);
          }
          drainRefresh(); return;
        }
        e.preventDefault();
        suppressedClick = true;
        // A direct arrangement ends the resting view, so changed board bounds
        // cannot recenter the canvas away from the drop.
        this.hooks.holdView?.();
        try {
          viewport.releasePointerCapture(e.pointerId);
        } catch {}
        if(container?.source&&!container.inside&&!target){restore(done);drainRefresh();return;}
        if(container?.hit&&!container.hit.blocked||container?.source&&!target) {
          this.movePending=true;this.moveCommitting=true;this.updateHistoryControls();
          try {await this.transferContainerMember(container.member,container.source,container.hit,done.patch);}
          catch(error){restore(done);try{await this.refresh({saveReview:false});}catch{}toast(error.message);}
          finally{this.movePending=false;this.moveCommitting=false;this.updateHistoryControls();drainRefresh();}
          return;
        }
        if (target || done.lifted) {
          if (!target || target.invalid) { restore(done); drainRefresh(); return; }
          // The dropped source stays where it was released until the atomic move
          // lands; a rejection restores its saved geometry below.
          const subject = done.lifted || {boardId:this.snapshot.id};
          const movedIds = done.lifted ? [done.lifted.p.id] : done.entries.map(entry => entry.p.id);
          const sources = done.lifted ? [done.lifted.p] : done.entries.map(entry => entry.p);
          this.movePending = true;
          this.moveCommitting = true;
          let moved = false;
          try {
            await this.writeArrangement("move", {
              sourceBoardId: subject.boardId,
              placementIds:movedIds,
              targetBoardId: target.boardId,
              ...(target.targetPosition ? {targetPosition:target.targetPosition} : {}),
            }, latest => placementsUnchanged(latest, sources), {boardId:subject.boardId,...(done.lifted?{source:done.lifted.source}:{})});
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
        if (!done.resize && (done.entries.length > 1 || done.decorations?.length)) {
          this.movePending = true;
          this.moveCommitting = true;
          let saved = false;
          try {
            await this.writeArrangement("translatePlacements", {
              boardId:this.snapshot.id,
              placementIds:done.entries.map(entry => entry.p.id),
              ...(done.decorations?.length ? {decorationIds:done.decorations.map(d => d.id)} : {}),
              ...done.translation,
              // The drop comes forward only if it newly overlaps something above it.
              restack:"drop",
            }, latest => unmoved(latest, done));
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
          await this.writeArrangement("updatePlacement", {
            boardId: this.snapshot.id,
            placementId: done.id,
            patch: done.patch,
            // A dragged drop may come forward; resizing never reorders.
            ...(done.resize ? {} : {restack:"drop"}),
          }, latest => unmoved(latest, done));
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
      this.tileMenu(card.dataset.placement, { x: e.clientX, y: e.clientY });
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
    if (this.whiteboard) { this.whiteboard.patch(d); return; }
    const old = document.querySelector(`[data-decoration="${CSS.escape(d.id)}"]`);
    if (old && !old.querySelector("[contenteditable]")) old.outerHTML = this.decorationMarkup(d);
  }
  closeAddMenu(focus = false) {
    const anchor = this.addPopupAnchor || $("viewport");
    this.addPopup?.remove(); this.addPopup = null;
    this.addPopupAnchor = null;
    $("workspace-add").setAttribute("aria-expanded", "false");
    if (focus) anchor.focus({preventScroll:true});
  }
  addMenu(anchor, point) {
    if (this.addPopup) { this.closeAddMenu(); return; }
    this.closeStickerPicker();
    this.closeContext();
    const menu = document.createElement("div");
    menu.className = "workspace-add-menu"; menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Add to board");
    const options = [
      ["text","T","Text"],["sticky","▣","Sticky note"],["document","≣","Document"],["sticker","☺","Sticker"],
      ["region","▧","Colored region"],["container","▤","Container"],["arrow","↗","Arrow"],
      ["rounded","▢","Process"],["diamond","◇","Decision"],["ellipse","⬭","Start / end"],
    ];
    const choice = ([id, icon, label]) => `<button type="button" role="menuitem" data-add="${id}"><span aria-hidden="true">${icon}</span>${label}</button>`;
    menu.innerHTML = options.map(choice).join("") + '<hr role="separator">' + [
      ["idea","◇","Item…"],["board","▱","New board…"],
    ].map(choice).join("");
    document.body.append(menu); this.addPopup = menu; this.addPopupAnchor = anchor;
    const rect = anchor?.getBoundingClientRect();
    const screen = point || { x: rect.right - menu.offsetWidth, y: rect.bottom + 6 };
    Object.assign(menu.style, { left: `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, screen.x))}px`, top: `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, screen.y))}px` });
    $("workspace-add").setAttribute("aria-expanded", "true");
    menu.querySelectorAll("[data-add]").forEach(button => button.onclick = () => {
      const type = button.dataset.add;
      this.closeAddMenu();
      if (["text", "region", "container", "arrow", "sticky", "rounded", "diamond", "ellipse"].includes(type)) this.createDecoration(type, point);
      else if (type === "sticker") this.openStickerPicker(anchor || $("workspace-add"),point);
      else if (type === "document") this.createDocument(point);
      else if (type === "board") this.newBoard();
      else if (type === "idea") itemForm(this.client, {snapshot:this.structuralSource(),boardId:this.snapshot.id, opener:anchor || $("workspace-add"), refresh:() => this.refresh()});
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
  openStickerPicker(anchor, point) {
    if(this.hooks.viewOnly||this.commandBusy())return;
    const alreadyOpen=this.stickerPicker?.anchor===anchor;
    this.closeStickerPicker({focus:alreadyOpen});
    if(alreadyOpen)return;
    this.closeContext();
    this.whiteboard.closeMenu();
    if(this.mode!=="canvas")this.setMode("canvas");
    const popup=document.createElement('div'), events=new AbortController();
    popup.className='tk-menu workspace-sticker-picker';
    let stylesheet=document.querySelector('link[data-emoji-styles]');
    if(!stylesheet){
      stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='/app/emoji-picker.css';
      stylesheet.dataset.emojiStyles='';document.head.append(stylesheet);
    }
    document.body.append(popup);
    const position=()=>{
      const rect=anchor.getBoundingClientRect(), width=popup.offsetWidth, height=popup.offsetHeight;
      const left=Math.max(8,Math.min(innerWidth-width-8,rect.left+(rect.width-width)/2));
      const above=rect.top-height-6;
      const top=rect.bottom+height+14<=innerHeight?rect.bottom+6:Math.max(8,above);
      Object.assign(popup.style,{left:`${left}px`,top:`${top}px`,maxHeight:`${Math.max(0,innerHeight-top-8)}px`});
    };
    let attempt;
    const controls=mountEmojiPicker(popup,{
      choose:emoji=>{
        if(attempt?.value!==emoji)attempt={value:emoji,operationId:crypto.randomUUID()};
        return this.createEmojiSticker(emoji,point,attempt);
      },
      close:()=>this.closeStickerPicker({focus:popup.contains(document.activeElement)}),
    });
    this.stickerPicker={popup,anchor,controls,events};
    const away=event=>{
      if(!popup.contains(event.target)&&!anchor.contains(event.target))this.closeStickerPicker();
    };
    document.addEventListener('pointerdown',away,{capture:true,signal:events.signal});
    document.addEventListener('focusin',away,{capture:true,signal:events.signal});
    window.addEventListener('resize',position,{signal:events.signal});
    stylesheet.addEventListener('load',position,{once:true,signal:events.signal});
    const contents=new ResizeObserver(position);contents.observe(popup.firstElementChild);
    this.stickerPicker.contents=contents;
    position();controls.focus();
  }
  closeStickerPicker({focus=false}={}) {
    const picker=this.stickerPicker;
    if(!picker)return;
    this.stickerPicker=null;
    picker.events.abort();picker.contents.disconnect();picker.controls.destroy();picker.popup.remove();
    if(focus)picker.anchor.focus({preventScroll:true});
  }
  async createEmojiSticker(value, screen, attempt={}) {
    const emoji=emojiSticker(value);
    if(!emoji||this.hooks.viewOnly||this.commandBusy())return false;
    if(this.mode!=="canvas")this.setMode("canvas");
    const size=112;
    if(!attempt.decoration){
      const decoration={id:crypto.randomUUID(),type:'text',text:emoji,sticker:true,color:'palette:neutral',x:0,y:0,width:size,height:size};
      const point=screen?this.canvasPoint(screen):null;
      Object.assign(decoration,point?{x:point.x-size/2,y:point.y-size/2}:this.pastePosition({placements:[],decorations:[decoration]}));
      attempt.decoration=decoration;
    }
    const {decoration,operationId}=attempt;
    this.decorationCommitting=true;
    try {
      this.hooks.holdView?.();
      await this.writeStructural('createDecoration',{boardId:this.snapshot.id,decoration},{operationId});
      await this.refresh({saveReview:false});
      this.whiteboard.select(decoration.id);
      $("world").querySelector(`[data-decoration="${CSS.escape(decoration.id)}"]`)?.focus({preventScroll:true});
      return true;
    } finally {this.decorationCommitting=false;this.hooks.liveReady?.();}
  }
  canvasPoint(screen) {
    const viewport = $("viewport").getBoundingClientRect(), world = $("world").getBoundingClientRect();
    const point = screen || { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 };
    return { x: Math.round((point.x - world.left) / this.hooks.zoom() - (this.origin?.x || 0)), y: Math.round((point.y - world.top) / this.hooks.zoom() - (this.origin?.y || 0)) };
  }
  // Board keys pressed while an undo, redo or save is in flight would otherwise be dropped:
  // they wait here and replay in order once the board is idle. Escape clears the queue.
  installKeyQueue() {
    this.keyQueue = [];
    window.addEventListener("keydown", e => {
      if (e.key === "Escape") { this.keyQueue.length = 0; return; }
      if (this.replayingKey || !this.keysBusy() || !this.queueableKey(e)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.keyQueue.push({at:Date.now(), init:{key:e.key, code:e.code, keyCode:e.keyCode, shiftKey:e.shiftKey, metaKey:e.metaKey, ctrlKey:e.ctrlKey, altKey:false}});
      this.watchKeyQueue();
    }, true);
  }
  // Idle is reached through several paths (history, writes, gestures), so a short check runs
  // only while keys are waiting.
  watchKeyQueue() {
    if (this.keyQueueTimer) return;
    const tick = () => {
      this.keyQueueTimer = null;
      if (!this.keyQueue.length) return;
      this.flushKeys();
      if (this.keyQueue.length) this.keyQueueTimer = setTimeout(tick, 16);
    };
    this.keyQueueTimer = setTimeout(tick, 16);
  }
  keysBusy() {
    return !!(this.movePending || this.historyBusy || this.history?.busy || this.pasteBusy || this.client.pendingWrites || this.saving || this.decorationCommitting);
  }
  // Board commands only: plain keys, arrows, Delete/Backspace/Enter, and ⌘/Ctrl-Z, -D, -A, -G. Native
  // clipboard and browser shortcuts, fields, editors, dialogs and IME composition pass through.
  queueableKey(e) {
    if (e.target.closest?.(".selection-actions-menu")) return false;
    if (e.isComposing || e.keyCode === 229 || e.repeat || e.altKey || this.editorHold || this.whiteboard?.editing || this.documentEditing) return false;
    if (document.querySelector("dialog[open]") || document.activeElement?.tagName === "IFRAME" ||
        e.target.closest?.("input,textarea,select,[contenteditable],[role=dialog],[role=textbox]")) return false;
    const key = e.key.toLowerCase();
    // Duplicate on an in-flight duplicate's new selection would copy twice.
    // Let the scoped handler consume the shortcut without queuing it then.
    if (e.metaKey || e.ctrlKey) {
      if (key === "g") return !e.shiftKey && !!this.groupAction();
      return key === "d" ? !this.duplicatePending : ["z","a"].includes(key);
    }
    return key.length === 1 || ["arrowleft","arrowright","arrowup","arrowdown","delete","backspace","enter"].includes(key);
  }
  // Replays queued keys while the board is idle (or while a new text or sticky is holding keys
  // for its editor, which then receives them); stops again as soon as one makes it busy.
  flushKeys() {
    if (this.flushingKeys) return;
    this.flushingKeys = true;
    try {
      while (this.keyQueue?.length && (this.editorHold || !this.keysBusy())) {
        const {at, init} = this.keyQueue.shift();
        if (Date.now() - at > 5000) continue;
        this.replayingKey = true;
        try { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", {...init, bubbles:true, cancelable:true})); }
        finally { this.replayingKey = false; }
      }
    } finally { this.flushingKeys = false; }
  }
  // Keys typed between T/S (or a double-click, or the palette) and the editor taking focus
  // are held here and replayed into it in order; Escape among them finishes the edit.
  holdEditorKeys() {
    const early = {keys:[]};
    early.listener = e => {
      if (e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" || e.key === "Enter" || e.key === "Backspace" || e.key.length === 1) { e.preventDefault(); e.stopImmediatePropagation(); early.keys.push(e.key); }
    };
    window.addEventListener("keydown", early.listener, true);
    this.editorHold = early;
    early.release = () => { clearTimeout(early.timer); window.removeEventListener("keydown", early.listener, true); if (this.editorHold === early) this.editorHold = null; };
    early.timer = setTimeout(early.release, 15000);
    return early;
  }
  // Waits for the real readiness signal (this decoration's editor textarea has focus), then replays.
  async replayEditorKeys(early, id) {
    const deadline = Date.now() + 3000;
    let area;
    while (Date.now() < deadline) {
      area = this.whiteboard?.editor?.id === id ? this.whiteboard.editor.textarea : null;
      if (area && document.activeElement === area) break;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    early.release();
    if (!area || document.activeElement !== area) return;
    const line = this.snapshot.decorations.find(d => d.id === id)?.type === "line";
    for (const key of early.keys) {
      if (key === "Escape" || (key === "Enter" && line)) { this.whiteboard.commitEdit({focus:true}); return; }
      const {selectionStart:start, selectionEnd:end} = area;
      if (key === "Backspace") area.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end");
      else area.setRangeText(key === "Enter" ? "\n" : key, start, end, "end");
      area.dispatchEvent(new InputEvent("input", {bubbles:true, inputType:key === "Backspace" ? "deleteContentBackward" : "insertText", data:key.length === 1 ? key : null}));
    }
  }
  async createDecoration(type, screen) {
    if (type === "container") {
      if (this.mode !== "canvas") this.setMode("canvas");
      const early = this.holdEditorKeys();
      try {
        const initialTextId=await this.whiteboard.createContainer(screen);
        if (early&&initialTextId) await this.replayEditorKeys(early,initialTextId);
      } catch (error) { showFailure(error); }
      finally { early?.release(); }
      return;
    }
    // Quick jot types into its own field; every other creation holds early keys for the editor.
    const early = type !== "arrow" && !document.querySelector(".quick-jot") ? this.holdEditorKeys() : null;
    if (this.mode !== "canvas") this.setMode("canvas");
    const point = this.canvasPoint(screen), shaped = ["sticky","rounded","diamond","ellipse"].includes(type), region = type === "region" || shaped;
    const d = { id: crypto.randomUUID(), type: type === "arrow" ? "line" : region ? "region" : type,
      x: point.x, y: point.y, width: shaped ? type === "sticky" ? 220 : 240 : region ? 420 : type === "arrow" ? 200 : 360,
      height: shaped ? type === "sticky" ? 200 : type === "diamond" ? 180 : 130 : region ? 280 : type === "arrow" ? 90 : 48,
      text: type === "text" ? "Write something" : type === "sticky" ? "A thought to keep" : shaped ? ({rounded:"Process",diamond:"Decision",ellipse:"Start / end"}[type]) : region ? "A new area" : "",
      color: type === "sticky" ? "palette:gold" : type === "text" ? "palette:neutral" : "palette:sage",
      ...(shaped ? {shape:type === "sticky" ? "rectangle" : type} : {}),
      ...(type === "arrow" ? {endArrow:true,flipY:true} : type === "text" ? {textSizing:"auto"} : {}) };
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
      if (type === "arrow") {
        const {from,to}=resolveLine(d,this.snapshot);
        d.from={x:from.x,y:from.y}; d.to={x:to.x,y:to.y};
        d.route="curved"; d.bend=defaultArrowBend(from,to);
      }
      await this.writeStructural("createDecoration",{boardId:this.snapshot.id,decoration:d});
      await this.refresh({saveReview:false});
      const element = document.querySelector(`[data-decoration="${CSS.escape(d.id)}"]`);
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
      element?.focus({ preventScroll: true });
      if (type !== "arrow") this.editDecoration(d.id, true);
      if (early) await this.replayEditorKeys(early, d.id);
    } catch (error) { showFailure(error); }
    finally { early?.release(); }
  }
  // Document creation and editing live in board-document.js (loaded on first use).
  // point is the same screen (client) point createDecoration takes, or undefined
  // for the viewport centre; this.canvasPoint(point) converts it to board units.
  // The compact toolbar shares the board's creation actions and keyboard shortcuts.
  editToolsKey() { return `tinka/${this.config.workspaceId}/edit-tools`; }
  installEditTools() {
    if (this.hooks.viewOnly || $("edit-tools")) return;
    try { this.editToolsOpen = localStorage.getItem(this.editToolsKey()) !== "off"; } catch { this.editToolsOpen = true; }
    const palette = document.createElement("div");
    palette.id = "edit-tools";
    palette.className = "edit-tools";
    palette.setAttribute("role", "toolbar");
    palette.setAttribute("aria-label", "Canvas tools");
    palette.setAttribute("aria-orientation", "horizontal");
    palette.innerHTML = EDIT_TOOL_GROUPS.map(([group,tools]) =>
      `<div role="group" aria-label="${group}" class="edit-tool-group">${tools.filter(([tool])=>tool!=="sticker"||typeof this.openStickerPicker==="function").map(([tool,label,key]) => {
        const icon = tool === "comment" ? COMMENT_ICON : `<svg viewBox="0 0 20 20" aria-hidden="true">${EDIT_TOOL_ICONS[tool]}</svg>`;
        return `<button type="button" class="tk-btn tk-icon" data-edit-tool="${tool}" aria-label="${label}" title="${label}${key?` (${key})`:""}"${key?` aria-keyshortcuts="${key}"`:""}${tool==="sticker"?' aria-haspopup="dialog"':""}>${icon}</button>`;
      }).join("")}</div>`
    ).join("");
    palette.onclick = e => {
      const button = e.target.closest("[data-edit-tool]");
      if (!button || this.boardCommandBlocked()) return;
      const tool = button.dataset.editTool;
      if (tool === "pointer" || tool === "pan" || tool === "comment") {
        this.setCanvasTool(tool === "comment" && this.commentPins?.armed ? "pointer" : tool);
        return;
      }
      this.setCanvasTool("pointer");
      if (tool === "sticker") this.openStickerPicker(button);
      else this.createDecoration(tool);
    };
    palette.onkeydown = event => {
      if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const buttons = [...palette.querySelectorAll("button")];
      const current = buttons.indexOf(document.activeElement);
      const offset = event.key==="ArrowLeft" ? -1 : 1;
      const next = event.key==="Home" ? 0 : event.key==="End" ? buttons.length-1 : (current+offset+buttons.length)%buttons.length;
      event.preventDefault();
      event.stopPropagation();
      buttons[next]?.focus();
    };
    document.body.append(palette);
    const toggle = document.createElement("button");
    toggle.id = "edit-tools-toggle";
    toggle.type = "button";
    toggle.className = "tk-btn tk-icon edit-tools-toggle";
    toggle.setAttribute("aria-controls", "edit-tools");
    toggle.setAttribute("aria-label", "Edit tools");
    toggle.setAttribute("aria-keyshortcuts", "A");
    toggle.title = "Edit tools (A)";
    toggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1"/><circle cx="14" cy="6" r="3"/><path d="M6 11.5 9 16.5H3z"/><path d="M14 11.5v5M11.5 14h5"/></svg>';
    toggle.onclick = () => this.toggleEditTools();
    const map = $("board-map-toggle");
    map?.parentElement?.insertBefore(toggle, map);
    window.addEventListener("resize",()=>this.positionEditTools());
    this.syncEditTools();
  }
  setCanvasTool(tool) {
    this.panTool = tool === "pan";
    const comment = tool === "comment";
    if (!!this.commentPins?.armed !== comment) this.commentPins?.arm(comment);
    this.syncEditTools();
  }
  toggleEditTools(open = !this.editToolsOpen) {
    this.editToolsOpen = open;
    try { localStorage.setItem(this.editToolsKey(), open ? "on" : "off"); } catch {}
    if (!open && this.panTool) this.setCanvasTool("pointer");
    else this.syncEditTools();
  }
  positionEditTools() {
    const palette = $("edit-tools"), selection = $("workspace-selection");
    if (!palette || palette.hidden) return;
    const selectedTop = selection && !selection.hidden ? selection.getBoundingClientRect().top : innerHeight;
    const footer = document.querySelector('.canvas-footer');
    const footerSpace = innerWidth <= 720 && footer?.querySelector('.update-chip') ? innerHeight-footer.getBoundingClientRect().top+4 : 60;
    palette.style.bottom = `${Math.max(footerSpace,innerHeight-selectedTop+8)}px`;
  }
  syncEditTools() {
    const palette = $("edit-tools"), toggle = $("edit-tools-toggle");
    if (!palette) return;
    const canvas = this.mode === "canvas";
    if (!canvas) this.panTool = false;
    $("viewport").classList.toggle("canvas-pan-tool",!!this.panTool);
    palette.hidden = !(canvas && this.editToolsOpen);
    const current = this.panTool ? "pan" : this.commentPins?.armed ? "comment" : "pointer";
    for (const tool of ["pointer","pan","comment"])
      palette.querySelector(`[data-edit-tool="${tool}"]`)?.setAttribute("aria-pressed",String(tool===current));
    if (toggle) { toggle.hidden = !canvas; toggle.setAttribute("aria-pressed", String(!!this.editToolsOpen)); }
    this.positionEditTools();
  }
  // A mixed group: cards (this.selection) with drawn elements (this.decorationSelection),
  // made by the selection box or ⌘A. It moves, deletes and duplicates together.
  groupKey() { return JSON.stringify([...this.selection].sort()); }
  selectedCount() { return this.selection.size + (this.mixedGroup ? this.decorationSelection.size : 0); }
  canvasGroups(visiblePlacementIds) {
    const groups = this.mode === "canvas" ? this.snapshot.groups || [] : [];
    if (!groups.length) return groups;
    const visible = visiblePlacementIds || new Set(this.renderedPlacements().filter(p =>
      !p.archivedAt && !this.snapshot.items[p.itemId]?.archivedAt).map(p => p.id));
    return groups.filter(group => group.placementIds.every(id => visible.has(id)));
  }
  groupForOccurrence({placementId,decorationId}) {
    return this.canvasGroups().find(group => group.placementIds.includes(placementId) ||
      group.decorationIds.includes(decorationId));
  }
  // Bring to front / Send to back act on the selected cards and drawn elements.
  stackSelection() {
    if (this.mode !== "canvas" || this.hooks.viewOnly || !this.snapshot?.id) return null;
    const placementIds = this.clipboardCandidates().map(p => p.id);
    const decorationIds = [...new Set([...(this.decorationSelection || []), this.activeDecoration].filter(Boolean))];
    return placementIds.length || decorationIds.length ? {placementIds, decorationIds} : null;
  }
  async restackSelection(to) {
    const selection = this.stackSelection();
    if (!selection || this.commandBusy() || this.history?.busy) return;
    const present = latest => selection.placementIds.every(id => latest.placements.some(p => p.id === id && !p.removedAt && !p.deletedAt)) &&
      selection.decorationIds.every(id => (latest.decorations || []).some(d => d.id === id));
    try {
      await this.writeArrangement("restackOccurrences", {boardId:this.snapshot.id, ...selection, to}, present);
      await this.refresh({saveReview:false});
    } catch (error) { toast(error.message); }
  }
  groupSelectionIds() {
    const contained = containedOccurrences(this.snapshot.decorations || []);
    const placementIds = new Set(this.clipboardCandidates().filter(p =>
      !p.archivedAt && !this.snapshot.items[p.itemId]?.archivedAt && !contained.placements.has(p.id)).map(p => p.id));
    const decorationIds = new Set([...this.decorationSelection, this.activeDecoration].filter(id => id && !contained.drawings.has(id)));
    return {placementIds,decorationIds};
  }
  groupAction() {
    if (this.mode !== "canvas" || !this.snapshot?.id || this.hooks.viewOnly) return null;
    const {placementIds,decorationIds} = this.groupSelectionIds();
    const count = placementIds.size + decorationIds.size;
    if (count < 2 || this.clipboardCandidates().some(p => p.archivedAt || this.snapshot.items[p.itemId]?.archivedAt)) return null;
    const relevantGroups = selectedGroups(this.snapshot.groups || [],placementIds,decorationIds);
    const group = relevantGroups.length === 1 && relevantGroups[0];
    if (group && group.placementIds.length + group.decorationIds.length === count &&
        group.placementIds.every(id => placementIds.has(id)) && group.decorationIds.every(id => decorationIds.has(id)))
      return {label:"Ungroup",type:"ungroupOccurrences",data:{groupId:group.id}};
    if (completeGroups(relevantGroups,placementIds,decorationIds).length !== relevantGroups.length) return null;
    return {label:"Group",type:"groupOccurrences",data:{placementIds:[...placementIds],decorationIds:[...decorationIds]}};
  }
  async toggleCanvasGroup() {
    const action = this.groupAction();
    if (!action || this.commandBusy() || this.history?.busy || this.whiteboard?.editing || this.documentEditing) return;
    const groupButtons = '[data-bulk="canvas-group"],[data-whiteboard-action="canvas-group"]';
    const restoreFocus = document.activeElement?.matches(groupButtons);
    const before = this.snapshot, {placementIds,decorationIds} = this.groupSelectionIds();
    const stillSelected = latest => {
      const live = new Set(latest.placements.filter(p => !p.removedAt && !p.deletedAt && !p.archivedAt &&
        latest.items[p.itemId] && !latest.items[p.itemId].deletedAt && !latest.items[p.itemId].archivedAt).map(p => p.id));
      const contained = containedOccurrences(latest.decorations);
      const drawings = new Set(latest.decorations.map(d => d.id));
      return [...placementIds].every(id => live.has(id) && !contained.placements.has(id)) &&
        [...decorationIds].every(id => drawings.has(id) && !contained.drawings.has(id)) &&
        sameGroups(before,latest,placementIds,decorationIds);
    };
    this.movePending = true;
    this.updateHistoryControls();
    let pending = true;
    const settle = () => {
      if (!pending) return;
      pending = false;
      this.movePending = false;
      this.updateHistoryControls();
    };
    try {
      const result = await this.writeArrangement(action.type,{boardId:before.id,...action.data},stillSelected);
      await this.refresh({saveReview:false,afterRender:() => {
        this.selectOccurrences(result.placementIds,result.decorationIds);
        if (restoreFocus) document.querySelector(groupButtons)?.focus({preventScroll:true});
        settle();
      }});
    } catch (error) {
      if (error.conflict) try { await this.refresh({saveReview:false}); } catch {}
      showFailure(error);
    } finally {
      settle();
      this.drainGeometryRefresh();
    }
  }
  selectOccurrences(placementIds, decorationIds) {
    if (!placementIds.length && decorationIds.length) {
      this.whiteboard?.selectDecorations(decorationIds);
      return;
    }
    if (this.activeDecoration || this.whiteboard?.editing)
      this.whiteboard?.clearSelection({finishEdit:true,focus:false});
    this.selection = new Set(placementIds);
    this.setMixedGroup(decorationIds);
    this.syncSelection();
    this.selectionMenu();
  }
  toggleOccurrence(ref) {
    const group = this.groupForOccurrence(ref);
    const placements = new Set(this.selection);
    const drawings = new Set(this.mode === "canvas" ? [...this.decorationSelection,this.activeDecoration].filter(Boolean) : []);
    const targets = group || {placementIds:ref.placementId ? [ref.placementId] : [],decorationIds:ref.decorationId ? [ref.decorationId] : []};
    const remove = ref.placementId ? placements.has(ref.placementId) : drawings.has(ref.decorationId);
    for (const id of targets.placementIds) remove ? placements.delete(id) : placements.add(id);
    for (const id of targets.decorationIds) remove ? drawings.delete(id) : drawings.add(id);
    this.selectOccurrences([...placements],[...drawings]);
  }
  selectCanvasGroup(group,{only=false}={}) {
    const hasExtras = this.selection.size !== group.placementIds.length || this.decorationSelection.size !== group.decorationIds.length;
    if ((only && hasExtras) || !group.placementIds.every(id => this.selection.has(id)) ||
        !group.decorationIds.every(id => this.decorationSelection.has(id)))
      this.selectOccurrences(group.placementIds,group.decorationIds);
  }
  selectSection(id) {
    const section = this.snapshot.decorations.find(d => d.id === id);
    if (this.mode !== "canvas" || section?.type !== "region" || section.shape) return;
    const inside = box => box.x >= section.x && box.y >= section.y &&
      box.x + box.width <= section.x + section.width && box.y + box.height <= section.y + section.height;
    const cards = this.renderedPlacements().filter(p => !p.archivedAt && !this.snapshot.items[p.itemId].archivedAt && inside(p));
    const drawn = this.snapshot.decorations.filter(d => inside(decorationBounds(d,this.snapshot)));
    const cardIds = new Set(cards.map(p => p.id));
    const drawnIds = new Set(drawn.map(d => d.id));
    const contained = endpoint => (!endpoint?.decorationId || drawnIds.has(endpoint.decorationId)) &&
      (!endpoint?.placementId || cardIds.has(endpoint.placementId));
    const objects = drawn.filter(d => contained(d.from) && contained(d.to)).map(d => d.id);
    if (!cards.length) this.whiteboard.selectDecorations(objects);
    else {
      this.whiteboard.clearSelection({finishEdit:true,focus:false});
      this.selection = cardIds;
      this.setMixedGroup(objects);
      this.syncSelection();
      this.selectionMenu();
    }
    $("world").querySelector(`[data-decoration="${CSS.escape(id)}"]`)?.focus({preventScroll:true});
  }
  setMixedGroup(ids) {
    this.decorationSelection = new Set(ids);
    this.mixedGroup = !!(this.decorationSelection.size && this.selection.size);
    this.groupSignature = this.groupKey();
    this.whiteboard?.sync(this.whiteboard.overrides);
  }
  // Drawn elements the keyboard acts on as a group: a mixed group's, or Whiteboard's
  // decoration-only multi-selection.
  keyboardDecorations() {
    if (this.mixedGroup) return this.groupDecorations();
    return !this.selection.size && this.decorationSelection.size > 1
      ? (this.snapshot.decorations || []).filter(d => this.decorationSelection.has(d.id)) : [];
  }
  groupDecorations() {
    return this.mixedGroup ? (this.snapshot.decorations || []).filter(d => this.decorationSelection.has(d.id)) : [];
  }
  // Any other selection change (a click, Escape, a single decoration) ends the group.
  checkMixedGroup() {
    if (!this.mixedGroup || this.pointerGesture) return;
    const same = this.groupKey() === this.groupSignature;
    if (!this.activeDecoration && this.decorationSelection.size && this.selection.size && same) return;
    this.mixedGroup = false;
    // Cards picked some other way drop the drawn elements; an emptied card selection means
    // Whiteboard took over (its own single or multi-selection), so its set stays.
    if (this.selection.size && !same && this.decorationSelection.size) {
      this.decorationSelection = new Set();
      this.whiteboard?.sync(this.whiteboard.overrides);
    }
  }
  // Align, distribute and tidy treat each complete group as a single object.
  // An attached arrow follows its target.
  arrangeObjects() {
    const cards = this.clipboardCandidates().map(p => ({kind:"placement",id:p.id,box:{x:p.x,y:p.y,width:p.width,height:p.height}}));
    const drawn = this.keyboardDecorations().filter(d => !(d.from?.placementId || d.from?.decorationId || d.to?.placementId || d.to?.decorationId))
      .map(d => ({kind:"decoration",id:d.id,d,box:decorationBounds(d,this.snapshot)}));
    const cardMap = new Map(cards.map(object => [object.id,object]));
    const drawnMap = new Map(drawn.map(object => [object.id,object]));
    const groups = completeGroups(this.canvasGroups(),this.selection,this.decorationSelection);
    const units = [];
    for (const group of groups) {
      const members = [];
      for (const [ids,map] of [[group.placementIds,cardMap],[group.decorationIds,drawnMap]]) {
        for (const id of ids) {
          const member = map.get(id);
          if (member) members.push(member);
          map.delete(id);
        }
      }
      if (members.length) units.push({members,box:boundsOf(members.map(member => member.box))});
    }
    return [...cardMap.values(),...drawnMap.values(),...units];
  }
  closeArrangeMenu({focus=false}={}) {
    const popup = this.arrangePopup;
    if (!popup) return;
    this.arrangePopup = null;
    popup.events.abort();
    popup.menu.remove();
    popup.anchor.setAttribute("aria-expanded","false");
    if (focus && popup.anchor.isConnected) popup.anchor.focus({preventScroll:true});
  }
  positionArrangeMenu() {
    const popup = this.arrangePopup;
    if (!popup) return;
    const {anchor,menu} = popup;
    if (!anchor.isConnected || anchor.getClientRects().length === 0) { this.closeArrangeMenu(); return; }
    const objects = this.arrangeObjects();
    if (objects.length < 2) { this.closeArrangeMenu(); return; }
    const box = boundsOf(objects.map(object => object.box));
    const start = this.boardToScreen({x:box.x,y:box.y});
    const end = this.boardToScreen({x:box.x+box.width,y:box.y+box.height});
    const object = {left:start.x,top:start.y,right:end.x,bottom:end.y};
    const toolbar = anchor.closest("[role=toolbar]")?.getBoundingClientRect() || anchor.getBoundingClientRect();
    const viewport = $("viewport").getBoundingClientRect();
    const side = toolbar.top+toolbar.bottom < object.top+object.bottom ? "top" : "bottom";
    const scrollTop = menu.scrollTop;
    menu.style.maxHeight = "";
    const position = placeWhiteboardPopover(viewport,object,toolbar,side,menu.offsetWidth,Math.max(menu.offsetHeight,menu.scrollHeight));
    Object.assign(menu.style,{left:`${position.left}px`,top:`${position.top}px`,maxHeight:`${position.maxHeight}px`});
    menu.scrollTop = scrollTop;
    menu.dataset.popupSide = position.side;
  }
  arrangeMenu(anchor) {
    const sameAnchor = this.arrangePopup?.anchor === anchor;
    this.closeArrangeMenu({focus:sameAnchor});
    if (sameAnchor) return;
    const count = this.arrangeObjects().length;
    if (count < 2) return;
    const events = new AbortController();
    const menu = document.createElement("div");
    menu.className = "tk-menu arrange-menu"; menu.setAttribute("role","dialog"); menu.setAttribute("aria-label","Arrange");
    menu.innerHTML = arrangeMenuMarkup(count);
    document.body.append(menu);
    this.arrangePopup = {menu,anchor,events};
    anchor.setAttribute("aria-expanded","true");
    this.positionArrangeMenu();
    menu.onclick = e => {
      const button = e.target.closest("[data-arrange]:not(:disabled)");
      if (!button) return;
      this.closeArrangeMenu({focus:true});
      this.arrange(button.dataset.arrange);
    };
    menu.onkeydown = e => arrangeMenuKeys(menu,e);
    const away = e => { if (!menu.contains(e.target) && !anchor.contains(e.target)) this.closeArrangeMenu(); };
    document.addEventListener("pointerdown",away,{capture:true,signal:events.signal});
    document.addEventListener("focusin",away,{capture:true,signal:events.signal});
    menu.querySelector("button:not(:disabled)")?.focus({preventScroll:true});
  }
  // One arrangePlacements write: one revision and one Undo step.
  async arrange(kind) {
    const objects = this.arrangeObjects();
    if (objects.length < (kind.startsWith("distribute") ? 3 : 2) || this.commandBusy?.() || this.movePending) return;
    const next = arrangePositions(kind, objects);
    const placements = [], decorations = [];
    objects.forEach((o,i) => {
      const dx = Math.round(next[i].x - o.box.x), dy = Math.round(next[i].y - o.box.y);
      if (!dx && !dy) return;
      for (const member of o.members || [o]) {
        if (member.kind === "placement")
          placements.push({id:member.id,x:member.box.x + dx,y:member.box.y + dy});
        else decorations.push({id:member.id,x:member.d.x + dx,y:member.d.y + dy});
      }
    });
    if (!placements.length && !decorations.length) { toast("Already arranged."); return; }
    const before = this.snapshot.placements.filter(p => placements.some(e => e.id === p.id));
    this.movePending = true; this.updateHistoryControls();
    try {
      await this.writeArrangement("arrangePlacements", {boardId:this.snapshot.id,
        ...(placements.length ? {placements} : {}), ...(decorations.length ? {decorations} : {})}, latest => placementsUnchanged(latest, before));
      this.hooks.holdView?.();
      await this.refresh({saveReview:false});
    } catch (error) { showFailure(error); try { await this.refresh({saveReview:false}); } catch {} }
    finally { this.movePending = false; this.updateHistoryControls(); }
  }
  // Smart-guide targets: every rendered card and drawn element (arrows aside) not moving.
  snapTargets(placementIds = new Set(), decorationIds = new Set()) {
    const cards = this.renderedPlacements().filter(p => !placementIds.has(p.id) && !p.archivedAt).map(p => ({x:p.x,y:p.y,width:p.width,height:p.height}));
    const drawn = (this.snapshot.decorations || []).filter(d => d.type !== "line" && !decorationIds.has(d.id))
      .map(d => decorationBounds(d,this.snapshot));
    return [...cards, ...drawn];
  }
  boardToScreen(point) {
    const world = $("world").getBoundingClientRect(), zoom = this.hooks.zoom();
    return {x:world.left + (point.x + (this.origin?.x || 0)) * zoom, y:world.top + (point.y + (this.origin?.y || 0)) * zoom};
  }
  showGuides(guides) { if (guides?.length) this.guides.show(guides, point => this.boardToScreen(point)); else this.guides.hide(); }
  // A decoration's position after a group move: free arrow ends move, attached ends follow.
  shiftedDecoration(d, dx, dy) {
    const shift = end => end && !end.placementId && !end.decorationId ? {...end, x:end.x + dx, y:end.y + dy} : end;
    return {x:d.x + dx, y:d.y + dy, ...(d.from ? {from:shift(d.from)} : {}), ...(d.to ? {to:shift(d.to)} : {})};
  }
  // Chips in comment threads: revealRef pans to what a ref names and pulses it;
  // openRef opens it (an item in the reader, a board by navigating, a drawn element selected).
  revealRef(ref) {
    if (ref?.boardId && ref.boardId !== this.snapshot.id && ref.kind !== "board") {
      location.href = `/boards/${encodeURIComponent(ref.boardId)}/${ref.kind === "placement" ? `#items/${encodeURIComponent(ref.id)}` : ""}`; return false;
    }
    const box = refBox(this.snapshot, ref);
    if (!box) { toast(ref?.label ? `${ref.label} is not on this board now.` : "That is not on this board now."); return false; }
    if (this.mode !== "canvas") this.setMode("canvas");
    this.hooks.revealPlacements?.([{id:box.placement?.id || `ref-${ref.id}`, x:box.x, y:box.y, width:box.width, height:box.height}]);
    if (box.placement) this.pulse(box.placement.id);
    else {
      const el = document.querySelector(`[data-decoration="${CSS.escape(box.decoration.id)}"]`);
      el?.classList.remove("comment-ref-pulse"); void el?.offsetWidth; el?.classList.add("comment-ref-pulse");
      setTimeout(() => document.querySelector(`[data-decoration="${CSS.escape(box.decoration.id)}"]`)?.classList.remove("comment-ref-pulse"), 1800);
    }
    return true;
  }
  openRef(ref) {
    if (ref?.kind === "board") { location.href = `/boards/${encodeURIComponent(ref.id)}/`; return; }
    if (!this.revealRef(ref)) return;
    const box = refBox(this.snapshot, ref);
    if (box?.decoration) { this.whiteboard?.select(box.decoration.id); return; }
    const card = [...$("world").querySelectorAll(".workspace-card[data-placement]")].find(c => c.dataset.placement === box.placement.id);
    card?.querySelector("[data-open]:not(:disabled)")?.click();
  }
  // A local Markdown document item (the same test as the card's documentContent).
  editableDocument(item) { return item?.content?.kind === "markdown" && !!item.content.resource && !item.content.url; }
  selectedDocument() {
    if (this.selection.size !== 1) return null;
    const p = this.snapshot.placements.find(p => p.id === [...this.selection][0]), item = this.snapshot.items[p?.itemId];
    return this.editableDocument(item) ? item : null;
  }
  // Documents are edited in place on their card (board-document.js); options: point (client
  // point for the caret), placementId, source (Markdown source), selectTitle.
  editDocument(itemId, options = {}) {
    return import("./board-document.js").then(m => m.editBoardDocument(this, itemId, options)).catch(showFailure);
  }
  quickJot() {
    if (this.mode !== "canvas") this.setMode("canvas");
    return import("./quick-jot.js").then(m => m.openQuickJot(this)).catch(showFailure);
  }
  copyNotes() {
    return import("./board-notes-export.js").then(m => m.copyBoardNotes(this)).catch(showFailure);
  }
  createDocument(point) {
    if (this.mode !== "canvas") this.setMode("canvas");
    return import("./board-document.js").then(m => m.createBoardDocument(this, point)).catch(showFailure);
  }
  editDecoration(id, select = false) { return this.whiteboard.edit(id,select); }
  canvasEditing() {
    const viewport = $("viewport");
    viewport.addEventListener('dragover',event=>{
      if(!event.dataTransfer?.types.includes(EMOJI_STICKER_MIME)||this.hooks.viewOnly||this.mode!=="canvas")return;
      event.preventDefault();event.dataTransfer.dropEffect='copy';
    });
    viewport.addEventListener('drop',event=>{
      if(!event.dataTransfer?.types.includes(EMOJI_STICKER_MIME)||this.hooks.viewOnly||this.mode!=="canvas")return;
      event.preventDefault();
      this.createEmojiSticker(event.dataTransfer.getData(EMOJI_STICKER_MIME),{x:event.clientX,y:event.clientY}).then(created=>{
        if(created)this.closeStickerPicker();
      }).catch(error=>toast(error.message));
    });
    document.addEventListener("pointerdown", e => {
      if (this.tilePopup && !e.target.closest(".workspace-tile-menu,[data-item-controls]")) this.closeTileMenu();
      if (this.context && !e.target.closest("#workspace-item-controls,[data-item-controls],.workspace-dialog,dialog[open],.feedback-panel,.workspace-popover,.workspace-tile-menu")) this.closeContext();
      if (this.addPopup && !e.target.closest(".workspace-add-menu,#workspace-add")) this.closeAddMenu();
    }, true);
    viewport.addEventListener("contextmenu", e => {
      if (e.target.closest(".workspace-card,.workspace-decoration,button,input,textarea")) return;
      e.preventDefault(); this.addMenu(null, { x: e.clientX, y: e.clientY });
    });
    viewport.addEventListener("click", e => {
      if (!e.target.closest(".workspace-card,.workspace-decoration,.whiteboard-ports")) {
        this.whiteboard?.clearSelection({finishEdit:true,focus:false});
      }
    });
    document.addEventListener("keydown", async e => {
      if (document.querySelector("#reader-dialog[open],dialog.workspace-dialog[open]")) return;
      // The focused board map owns its arrows, Escape and +/−.
      if (e.target.closest?.(".board-map-stage")) return;
      if (e.isComposing || e.keyCode === 229 || e.repeat || e.defaultPrevented) return;
      if (this.feedback?.consumeEscape(e)) return;
      if (this.whiteboard?.handleEscape(e)) return;
      if (e.key === "Escape") {
        if (this.context) { this.closeContext(true); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (this.addPopup) { this.closeAddMenu(true); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (this.activeDecoration) { this.whiteboard?.clearSelection({finishEdit:true,focus:false}); e.preventDefault(); return; }
        if (this.selection.size) { this.selection.clear(); this.build(this.hooks.concepts()); e.preventDefault(); return; }
      }
      if (e.target.closest("input,textarea,select,[contenteditable],[role=textbox],[role=dialog]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[e.key];
      const resizeGrip = delta && e.target.closest("[data-resize]");
      if (resizeGrip) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (this.pointerGesture || this.keysBusy()) return;
        const p = this.snapshot.placements.find(entry => entry.id === resizeGrip.dataset.resize);
        if (!p || p.removedAt || p.deletedAt) return;
        const [dx,dy] = delta.map(value => value * (e.shiftKey ? 10 : 1));
        const patch = resizePlacementBox(p,"se",dx,dy);
        if (patch.width === p.width && patch.height === p.height) return;
        this.hooks.holdView?.();
        try {
          await this.writeArrangement("updatePlacement", {boardId:this.snapshot.id,placementId:p.id,patch},
            latest => placementsUnchanged(latest,[p]));
          await this.refresh({saveReview:false});
        } catch (error) { showFailure(error); }
        return;
      }
      if ((this.activeDecoration || !this.selection.size && this.decorationSelection.size > 1) && ["Delete", "Backspace"].includes(e.key)) { e.preventDefault(); this.deleteDecoration(); return; }
      if (["Delete", "Backspace"].includes(e.key)) {
        if (e.repeat || e.shiftKey || this.clipboardBlocked() || this.history?.busy) return;
        const ids = this.clipboardCandidates().map(p => p.id);
        if (!ids.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.removePlacements(ids);
        return;
      }
      if (!delta || (!this.activeDecoration && !this.selection.size && !this.keyboardDecorations().length)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.pointerGesture || this.movePending || this.historyBusy) return;
      const [dx,dy] = delta.map(v => v * (e.shiftKey ? 10 : 1));
      try {
        if (this.keyboardDecorations().length) {
          const board = this.snapshot;
          const placements = this.snapshot.placements.filter(p => this.selection.has(p.id) && !p.removedAt && !p.deletedAt);
          const drawings = this.keyboardDecorations();
          const placementIds = placements.map(p => p.id), decorationIds = drawings.map(d => d.id);
          const unchangedDrawings = drawings.map(d => decorationUnchanged(d));
          await this.writeArrangement("translatePlacements", {boardId:board.id,placementIds,decorationIds,dx,dy},
            latest=>placementsUnchanged(latest,placements) && unchangedDrawings.every(unchanged => unchanged(latest)) &&
            sameGroups(board,latest,placementIds,decorationIds));
          await this.refresh({saveReview:false});
        }
        else if (this.activeDecoration) {
          const d=this.snapshot.decorations.find(d=>d.id===this.activeDecoration);
          let patch={x:d.x+dx,y:d.y+dy};
          if(d.type === "line"){const r=resolveLine(d,this.snapshot),from={x:r.from.x+dx,y:r.from.y+dy},to={x:r.to.x+dx,y:r.to.y+dy};patch={...lineBox(from,to),from,to};}
          await this.whiteboard.save(d.id,patch,undefined,decorationUnchanged(d));
        }
        else {
          const board = this.snapshot;
          const placements = board.placements.filter(p => this.selection.has(p.id) && !p.removedAt && !p.deletedAt);
          if (!placements.length) return;
          const placementIds = [...this.selection].filter(id => placements.some(p => p.id === id));
          await this.writeArrangement("translatePlacements", {boardId:board.id,placementIds,dx,dy},
            latest=>placementsUnchanged(latest,placements) && sameGroups(board,latest,placementIds,[]));
          await this.refresh({saveReview:false});
        }
      } catch (error) { showFailure(error); }
    }, true);
  }
  async deleteDecoration() { return this.whiteboard.remove(); }
  async saveBackground(background, original = this.snapshot) {
    await this.client.guarded('updateBoard', {boardId:original.id,patch:{background}},
      [fieldFact('boardField',{boardId:original.id},original,'background')]);
    await this.refresh({saveReview:false});
  }
  backgroundImageDialog(opener) {
    const original = structuredClone({id:this.snapshot.id,...(Object.hasOwn(this.snapshot,'background')?{background:this.snapshot.background}:{})});
    const resource = original.background?.resource;
    const dialog = makeDialog(
      "Background image",
      `<label>Resource root<input name="root" value="${esc(resource?.rootId)}" autofocus></label><label>Image path<input name="path" value="${esc(resource?.path)}"></label>${resource ? '<button type="button" data-remove-image>Remove image</button>' : ''}<button type="submit" class="workspace-primary">Save image</button>`,
      async (f) => {
        const rootId = f.get("root").trim(), path = f.get("path").trim();
        if (Boolean(rootId) !== Boolean(path)) throw new Error("Enter both the resource root and image path.");
        const {resource, ...background} = original.background || {};
        if (rootId) background.resource = {rootId,path};
        await this.saveBackground(background, original);
      }, {opener,compact:true},
    );
    dialog.querySelector("[data-remove-image]")?.addEventListener("click", () => {
      const form = dialog.querySelector("form");
      form.elements.root.value = ""; form.elements.path.value = "";
      form.requestSubmit();
    });
  }
  orderForm() {
    const original = {id:this.snapshot.id,reviewOrder:[...this.snapshot.reviewOrder]};
    const placements = this.snapshot.reviewOrder
      .map((id) => this.snapshot.placements.find((p) => p.id === id))
      .filter((p) => p && !p.removedAt);
    const d = makeDialog(
      "Comparison order",
      `<p>Set which item opens next in the reader.</p><div id="workspace-order"></div><button type="submit" class="workspace-primary">Save order</button>`,
      async () => {
        await this.client.guarded('updateBoard', {
          boardId: original.id,
          patch: { reviewOrder: placements.map((p) => p.id) },
        }, [fieldFact('boardField',{boardId:original.id},original,'reviewOrder')]);
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
      localStorage.setItem(this.reviewBaselineKey, JSON.stringify(Object.fromEntries(this.reviewBaselines)));
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
        ) {
          patch[field] = value;
          const saved = this.reviewBaselines.get(id) || {};
          // A restored legacy draft with no baseline cannot safely claim current
          // state. Keep it available, but require deliberate reconciliation.
          if (!Object.hasOwn(saved,field) && !Object.hasOwn(this.pendingReview.get(id) || {},field))
            this.reviewBaselines.set(id,{...saved,[field]:baseline});
        }
        else {
          delete patch[field];
          const saved={...this.reviewBaselines.get(id)};delete saved[field];
          if(Object.keys(saved).length)this.reviewBaselines.set(id,saved);else this.reviewBaselines.delete(id);
        }
      }
      if (!Object.keys(patch).length) this.pendingReview.delete(id);
      else if (
        JSON.stringify(patch) !== JSON.stringify(this.pendingReview.get(id))
      )
        this.pendingReview.set(id, patch);
    }
    this.persistDrafts();
  }
  // Explicit tile editors own their draft until ACK. A failed attempt never
  // enters the shared autosave queue, so Cancel cannot leak it through a star.
  async saveTileNote(itemId, note, baseline) {
    if(this.saving)await this.savePromise;
    const priorNote=this.pendingReview.get(itemId)?.note;
    let failure;
    this.saving=true;
    this.savePromise=(async()=>{
      try {
        if(typeof baseline !== 'string')throw new Error('This retained note has no original baseline. Copy your draft, Cancel, and reopen Notes to review the latest note.');
        await this.client.guarded('review',{itemId,patch:{note}},reviewFacts(itemId,{note:baseline},['note']));
        const item=this.snapshot.items[itemId];
        if(item)item.review={...item.review,note};
        for(const c of this.hooks.concepts())if(c.graphItem.id===itemId)c.graphItem.review={...c.graphItem.review,note};
        const pending=this.pendingReview.get(itemId);
        // Supersede only the note this editor started from, never a newer edit
        // or the independent star field in this or another item's pending patch.
        if(pending && Object.hasOwn(pending,'note') && pending.note===priorNote){
          const remaining={...pending};delete remaining.note;
          const saved={...this.reviewBaselines.get(itemId)};delete saved.note;
          if(Object.keys(saved).length)this.reviewBaselines.set(itemId,saved);else this.reviewBaselines.delete(itemId);
          if(Object.keys(remaining).length)this.pendingReview.set(itemId,remaining);else this.pendingReview.delete(itemId);
        }
        this.persistDrafts();this.rebuild();
        this.hooks.saveStatus('Item note saved on this Mac','saved');
        return true;
      } catch(error) {failure=error;return false;}
      finally {this.saving=false;this.savePromise=null;}
    })();
    const saved=await this.savePromise;
    // Autosaves requested during the explicit write retain their own patches.
    if(this.pendingReview.size)void this.saveReview([],{});
    if(!saved)throw failure;
  }
  reviewConflict(error, attempted) {
    if (!attempted) return showFailure(error);
    const {id,patch}=attempted;
    const note=Object.hasOwn(patch,'note') ? `<label>Your retained note<textarea rows="4" readonly>${esc(patch.note)}</textarea></label>` : '';
    const dialog=makeDialog('Change not saved',
      `<p>${esc(error.message)}</p>${note}<p>Keep this draft to copy or review it. Discard loads the latest saved feedback for the fields in this attempt.</p><button type="button" data-keep-review autofocus>Keep draft</button><button type="submit">Discard this draft and load latest</button>`,
      async()=>{
        // Fetch first. Losing the connection or dismissing this dialog never
        // discards text. A newer local edit is also outside this attempt.
        const snapshot=await this.client.get(`/api/boards/${encodeURIComponent(this.snapshot.id)}`);
        if(snapshot.revision<this.client.revision)throw new Error('Work changed while loading. Your draft is retained; try again.');
        const remaining={...this.pendingReview.get(id)},baseline={...this.reviewBaselines.get(id)};
        for(const field of Object.keys(patch))if(Object.hasOwn(remaining,field)&&remaining[field]===patch[field]){
          delete remaining[field];delete baseline[field];
        }
        if(Object.keys(remaining).length)this.pendingReview.set(id,remaining);else this.pendingReview.delete(id);
        if(Object.keys(baseline).length)this.reviewBaselines.set(id,baseline);else this.reviewBaselines.delete(id);
        this.persistDrafts();this.hooks.data(this.adapt(snapshot));
        this.hooks.saveStatus(this.pendingReview.size?'Other feedback drafts remain in this browser':'Latest item feedback loaded',this.pendingReview.size?'local':'saved');
      });
    dialog.querySelector('[data-keep-review]').onclick=()=>dialog.querySelector('.workspace-close').click();
    return dialog;
  }
  async saveReview(concepts = [], notes = {}) {
    this.captureReview(concepts, notes);
    if (this.saving) return this.savePromise;
    this.saving = true;
    this.savePromise = (async () => {
      let attempted;
      try {
        while (this.pendingReview.size) {
          const [id, patch] = this.pendingReview.entries().next().value;
          attempted={id,patch};
          this.inFlightReview.set(id, patch);
          const baseline=this.reviewBaselines.get(id);
          if (!baseline || Object.keys(patch).some(field => !Object.hasOwn(baseline,field))) {
            const error=new Error('This retained feedback has no original baseline. Keep or copy your draft, then load the latest saved feedback before editing again.');
            error.code='REVIEW_BASELINE_MISSING';throw error;
          }
          await this.client.guarded('review',{itemId:id,patch},reviewFacts(id,baseline,Object.keys(patch)));
          const item = this.snapshot.items[id];
          if (item) item.review = { ...item.review, ...patch };
          for (const c of this.hooks.concepts())
            if (c.graphItem.id === id)
              c.graphItem.review = { ...c.graphItem.review, ...patch };
          this.inFlightReview.delete(id);
          if (this.pendingReview.get(id) === patch) {
            this.pendingReview.delete(id);this.reviewBaselines.delete(id);
          } else {
            // Later typing starts from this confirmed ACK, not an unrelated read.
            const baseline={...this.reviewBaselines.get(id)};
            for(const field of Object.keys(patch))baseline[field]=patch[field];
            this.reviewBaselines.set(id,baseline);
          }
          this.persistDrafts();
        }
        this.hooks.saveStatus("Item notes saved on this Mac", "saved");
        return true;
      } catch (e) {
        this.inFlightReview.clear();
        this.persistDrafts();
        this.hooks.saveStatus(
          "Feedback saved in this browser · retry unsaved feedback",
          "local",
        );
        // A conflict offers the latest board; other failures report quietly
        // without stealing focus from the note being written.
        if (['GUARDED_PRECONDITION_CHANGED','REVIEW_BASELINE_MISSING'].includes(e.code)) this.reviewConflict(e,attempted);
        else if (e.conflict) showFailure(e);
        else toast(`Notes remain in this browser. ${e.message}`);
        return false;
      } finally {
        this.saving = false;
        this.savePromise = null;
      }
    })();
    return this.savePromise;
  }
}
