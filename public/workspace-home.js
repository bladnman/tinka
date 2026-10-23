import {newestBoardsFirst} from "./board-order.js";
import {reconcileChildren} from "./reconcile.js";
import {coverMarkup,observeCovers} from "./board-covers.js";
import {
  WorkspaceClient,
  escape as esc,
  resourceURL,
  destinationDialog,
  makeDialog,
  enableOrganization,
  toast,
  showFailure,
} from "./workspace.js";
export class WorkspaceHome {
  constructor(config) {
    this.config = config;
    this.client = new WorkspaceClient(config);
    this.selected = new Set();
    this.archive = false;
    this.search = "";
    this.favorites = false;
    this.active = false;
  }
  async init() {
    const ws = await this.client.get("/api/workspace");
    if (!ws.enabled) {
      const box = document.createElement("section");
      box.className = "workspace-enable";
      box.innerHTML =
        '<p>Want to arrange shared ideas, nested boards and freeform canvases? Enable flexible organization for this project.</p><button type="button">Enable organization…</button>';
      document.querySelector(".shelf-heading").after(box);
      box.querySelector("button").onclick = () =>
        enableOrganization(this.config);
      return false;
    }
    this.active = true;
    this.workspace = ws;
    this.catalog = (await this.client.get("/api/boards")).boards || [];
    this.client.revision = ws.revision;
    this.toolbar = document.createElement("section");
    this.toolbar.className = "workspace-toolbar workspace-home-toolbar";
    this.toolbar.setAttribute("aria-label", "Find and organize boards");
    this.toolbar.innerHTML =
      '<label class="workspace-search"><span class="sr-only">Find boards</span><input type="search" placeholder="Find a board…"></label><button data-favorites aria-pressed="false">☆ Favorites</button><button data-archive aria-pressed="false">Archive</button><div data-home-selection class="workspace-inline-actions"></div>';
    document.querySelector(".shelf-heading").after(this.toolbar);
    this.toolbar.querySelector("input").oninput = (e) => {
      this.search = e.target.value;
      this.render();
    };
    this.toolbar.querySelector("[data-favorites]").onclick = (e) => {
      this.favorites = !this.favorites;
      e.currentTarget.setAttribute("aria-pressed", this.favorites);
      this.render();
    };
    this.toolbar.querySelector("[data-archive]").onclick = (e) => {
      this.archive = !this.archive;
      this.selected.clear();
      e.currentTarget.setAttribute("aria-pressed", this.archive);
      this.render();
    };
    this.render();
    this.poll();
    return true;
  }
  async refresh() {
    this.workspace = await this.client.get("/api/workspace");
    this.catalog = (await this.client.get("/api/boards")).boards || [];
    this.client.revision = this.workspace.revision;
    this.render();
  }
  poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      async () => {
        try {
          if (!document.querySelector("dialog[open]")) await this.refresh();
        } catch {
          document.getElementById("connection").textContent = "Reconnecting";
        } finally {
          this.poll();
        }
      },
      document.hidden ? 8000 : 2000,
    );
  }
  render() {
    const ws = this.workspace,
      items = new Map(ws.items.map((i) => [i.id, i]));
    const boards = ws.boards
      .filter((b) => ws.homeBoardIds.includes(b.id))
      .filter((b) => {
        const i = items.get(b.ownerItemId);
        return (
          i &&
          !i.deletedAt &&
          (this.archive ? !!i.archivedAt : !i.archivedAt) &&
          (!this.favorites || i.review?.star) &&
          (!this.search ||
            [b.title, b.description, i.description]
              .join(" ")
              .toLowerCase()
              .includes(this.search.toLowerCase()))
        );
      });
    const legacy = (this.catalog || []).filter(
      (b) =>
        b.schemaVersion !== 2 &&
        (!this.search ||
          b.title.toLowerCase().includes(this.search.toLowerCase())) &&
        !this.archive &&
        !this.favorites,
    );
    document.getElementById("board-count").textContent = String(
      boards.length + legacy.length,
    );
    const markup =
      newestBoardsFirst([...boards, ...legacy])
        .map((b) => {
          if (b.schemaVersion !== 2) return this.legacyCard(b);
          const i = items.get(b.ownerItemId),
            image = resourceURL(i.preview?.resource);
          return `<article data-home-board="${esc(b.id)}" class="board-card ${this.selected.has(i.id) ? "workspace-home-selected" : ""}"><button type="button" class="workspace-home-select" data-home-select="${esc(i.id)}" aria-label="Select ${esc(b.title)}" aria-pressed="${this.selected.has(i.id)}">${this.selected.has(i.id) ? "✓" : "□"}</button><a class="board-link" href="/boards/${encodeURIComponent(b.id)}/"><div class="board-art" aria-hidden="true">${image ? `<img src="${esc(image)}" alt="">` : coverMarkup(ws.boardCovers?.[b.id],b.id)}<span class="art-label">${b.placements.filter((p) => !p.removedAt && !p.archivedAt).length} ITEMS</span></div><div class="board-info"><h3>${esc(b.title)}</h3><p>${esc(b.description || i.description || "A place to gather what you make.")}</p><div class="card-bottom"><span>${b.rounds.length} prior ${b.rounds.length === 1 ? "round" : "rounds"} retained</span><span class="arrow">↗</span></div></div></a></article>`;
        })
        .join("") +
      '<button class="new-board empty-card" type="button"><span class="plus" aria-hidden="true">+</span><strong>A fresh starting point.</strong><small>Create a board for the next idea.</small></button>';
    const grid = document.getElementById("board-grid"), template = document.createElement("template");
    template.innerHTML = markup;
    reconcileChildren(grid,template.content);
    this.coverObserver = observeCovers(grid,this.coverObserver);
    document.getElementById("shelf-status").textContent =
      boards.length + " boards · shared items, project-owned files";
    document.getElementById("connection").textContent = "Live on this Mac";
    document
      .querySelectorAll("[data-convert-legacy]")
      .forEach((b) => (b.onclick = () => enableOrganization(this.config)));
    document.querySelectorAll("[data-home-select]").forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.homeSelect;
          this.selected.has(id)
            ? this.selected.delete(id)
            : this.selected.add(id);
          this.render();
        }),
    );
    const s = this.toolbar.querySelector("[data-home-selection]");
    s.innerHTML = this.selected.size
      ? `<strong role="status">${this.selected.size} selected</strong><button data-home-action="move">Move…</button><button data-home-action="reference">Add reference…</button><button data-home-action="archive">${this.archive ? "Restore everywhere" : "Archive everywhere"}</button><button data-home-action="remove">Remove from home…</button><button data-home-action="clear" aria-label="Clear selection">×</button>`
      : "";
    s.querySelectorAll("[data-home-action]").forEach(
      (b) => (b.onclick = () => this.bulk(b.dataset.homeAction)),
    );
  }
  legacyCard(b) {
    return `<article data-home-board="${esc(b.id)}" class="board-card"><a class="board-link" href="/boards/${encodeURIComponent(b.id)}/"><div class="board-art" aria-hidden="true"><div class="sheet"></div><div class="sheet second"><b>Room for an idea.</b></div><span class="art-label">LEGACY BOARD · COMPARE AS BEFORE</span></div><div class="board-info"><h3>${esc(b.title)}</h3><p>${esc(b.description || "Existing rounds, revisions and feedback remain available.")}</p><div class="card-bottom"><span>Open to compare · enable organization deliberately</span><span class="arrow">↗</span></div></div></a><div class="board-actions"><button type="button" data-convert-legacy>Convert to organize…</button></div></article>`;
  }
  create() {
    makeDialog(
      "Create a board",
      '<label>Title<input name="title" required maxlength="1000" placeholder="A place for the next idea"></label><button type="submit" class="workspace-primary">Create board</button>',
      async (f) => {
        await this.client.write("createBoard", {
          title: f.get("title").trim(),
        });
        await this.refresh();
        toast("Board created.");
      },
    );
  }
  async bulk(type) {
    const ids = [...this.selected];
    try {
      if (type === "clear") {
        this.selected.clear();
        this.render();
        return;
      }
      if (type === "move" || type === "reference") {
        await destinationDialog(this.client, {
          itemIds: ids,
          kind: type,
          refresh: async () => {
            this.selected.clear();
            await this.refresh();
          },
        });
        return;
      }
      if (type === "remove") {
        makeDialog(
          "Remove boards from home?",
          '<p>Remove these home placements. Their boards, items, references, notes and resource files remain intact. You can still reach them through existing links or references.</p><button type="submit" class="workspace-primary">Remove from home</button>',
          async () => {
            const homes = this.workspace.homeBoardIds.filter(
              (id) =>
                !ids.includes(
                  this.workspace.boards.find((b) => b.id === id)?.ownerItemId,
                ),
            );
            await this.client.write("updateWorkspace", {
              patch: { homeBoardIds: homes },
            });
            this.selected.clear();
            await this.refresh();
          },
        );
        return;
      }
      makeDialog(
        this.archive
          ? "Restore these boards everywhere?"
          : "Archive these boards everywhere?",
        `<p>${this.archive ? "Restore these canonical board items on home and every board where they are referenced." : "Archive these canonical board items on home and every board where they are referenced. Their content and resource files remain intact."}</p><button type="submit" class="workspace-primary">${this.archive ? "Restore everywhere" : "Archive everywhere"}</button>`,
        async () => {
          await this.client.write("archiveItem", {
            itemIds: ids,
            archived: !this.archive,
          });
          this.selected.clear();
          await this.refresh();
          toast(
            this.archive
              ? "Boards restored everywhere."
              : "Boards archived everywhere. Open Archive to restore.",
          );
        },
      );
    } catch (e) {
      showFailure(e);
    }
  }
}
