// Focused graph UI acceptance. Uses external temporary fixtures and existing Playwright.
import strictAssert from "node:assert/strict";
let assertions = 0;
const counted = fn => (...args) => { const value = fn(...args); assertions++; return value; };
const assert = Object.assign(counted(strictAssert), Object.fromEntries(["equal", "notEqual", "deepEqual", "match"].map(name => [name, counted(strictAssert[name])])));
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { main } from "../cli.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const fixture = await mkdtemp(path.join(os.tmpdir(), "tinka-workspace-ui-"));
const evidence =
  process.env.TINKA_EVIDENCE_DIR ||
  (await mkdtemp(path.join(os.tmpdir(), "tinka-workspace-ui-evidence-")));
await mkdir(evidence, { recursive: true });
const config = path.join(fixture, "local/config.json"),
  boards = path.join(fixture, "boards");
let browser;
try {
  await main([
    "init",
    "--config",
    config,
    "--boards",
    boards,
    "--label",
    "Graph fixture",
  ]);
  await main([
    "board",
    "create",
    "settings",
    "--config",
    config,
    "--title",
    "Settings exploration",
  ]);
  const root = path.join(boards, "settings");
  await mkdir(path.join(root, "previews"), { recursive: true });
  const concepts = ["One", "Two", "Three", "Four", "Five"].map((name, i) => ({
    id: "concept" + i,
    name,
    number: String(i + 12),
    kind: "html",
    category: i === 0 ? "QUIET DIRECTION" : undefined,
    question: i === 0 ? "Does the first step feel clear?" : undefined,
    handoff: i === 0 ? "previews/README.md" : undefined,
    path: `previews/${i}.html`,
  }));
  await writeFile(
    path.join(root, "rounds.json"),
    JSON.stringify({
      rounds: [
        { id: "first", number: "01", title: "Five directions", concepts },
      ],
      revisions: {
        "first/concept0": [
          {
            id: "second",
            name: "Second version",
            path: "previews/second.html",
          },
        ],
      },
    }),
  );
  for (let i = 0; i < 5; i++)
    await writeFile(
      path.join(root, `previews/${i}.html`),
      `<!doctype html><title>Original ${i}</title><h1>Original ${i}</h1><input aria-label="Prototype input"><script>const params=new URLSearchParams(location.search);document.body.dataset.theme=params.get('theme');document.body.dataset.scale=params.get('scale');addEventListener('message',e=>{if(e.data?.type==='reader-preferences'){document.body.dataset.theme=e.data.theme;document.body.dataset.scale=e.data.scale}});let n=0;addEventListener('keydown',e=>{if(e.key==='ArrowRight')document.body.dataset.arrow=String(++n)})</script>`,
    );
  await writeFile(
    path.join(root, "previews/README.md"),
    "A portable handoff for this direction.",
  );
  await writeFile(
    path.join(root, "previews/second.html"),
    "<!doctype html><h1>Second version</h1>",
  );
  for (let i = 0; i < 5; i++)
    await main([
      "status",
      "--config",
      config,
      "--board",
      "settings",
      "first/concept" + i,
      i === 1 ? "building" : "ready",
      i === 1 ? "Work in progress" : "Ready",
    ]);
  await main(["start", "--config", config]);
  const local = JSON.parse(await readFile(config));
  const base = `http://127.0.0.1:${local.port}`;
  const cfg = await (await fetch(base + "/api/config")).json();
  let revision = 0;
  const post = async (route, data) => {
    const r = await fetch(base + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tinka-workspace": cfg.workspaceId,
      },
      body: JSON.stringify(data),
    });
    const d = await r.json();
    assert(r.ok, JSON.stringify(d));
    if (d.revision !== undefined) revision = d.revision;
    return d;
  };
  await post("/api/workspace/migrate", { dryRun: false });
  let ws = await (await fetch(base + "/api/workspace")).json();
  revision = ws.revision;
  let board = ws.boards.find(
    (b) => b.id === "settings" || b.legacyBoardId === "settings",
  );
  assert(board);
  const first = ws.items.find((i) => i.legacy?.key === "first/concept0");
  assert(first);
  const firstPlacement = board.placements.find((p) => p.itemId === first.id);
  const op = async (type, data) =>
    (
      await post("/api/operations", {
        type,
        ...data,
        expectedRevision: revision,
        operationId: crypto.randomUUID(),
      })
    ).result;
  const second = await op("createBoard", { title: "Another board" });
  await op("reference", {
    sourceBoardId: board.id,
    placementIds: [firstPlacement.id],
    targetBoardId: second.boardId,
  });
  await op("createBoard", { itemId: first.id, title: "The parts" });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const boardTool = async selector => {
    const control = page.locator(selector);
    if (!(await control.isVisible())) await page.locator("#board-info-toggle").click();
    await control.click();
    if (await page.locator("#board-info").isVisible()) await page.locator("#board-info-toggle").click();
  };
  const readerTool = async selector => {
    const control = page.locator(selector);
    if (!(await control.isVisible())) await page.locator("#view-toggle").click();
    await control.click();
  };
  const cardNote = async () => {
    const note = page.locator("#workspace-item-controls [data-note]");
    if (!(await note.count())) await page.locator('[data-controls-focus="notes"]').first().click();
    return note;
  };
  const dragPointer = async (box, dx, dy) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + dx,
      box.y + box.height / 2 + dy,
      { steps: 8 },
    );
    await page.mouse.up();
  };
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (!process.env.TINKA_FOCUSED_ONLY && !process.env.TINKA_COVERS_ONLY && !process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY) {
  await page.goto(base + `/boards/${board.id}/`);
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(
    await page.locator("body").getAttribute("data-board-layout"),
    "canvas",
    "Unconfigured graph board defaults to Canvas",
  );
  await boardTool("[data-mode=grid]");
  await page.reload();
  await page.locator(".workspace-grid-round").first().waitFor();
  assert.equal(
    await page.locator("body").getAttribute("data-board-layout"),
    "grid",
    "Explicit Grid preference survives reload",
  );
  assert.equal(
    await page.locator(".workspace-grid-round>header h2").first().textContent(),
    "Five directions",
  );
  assert.match(
    await page
      .locator(".workspace-grid-round>header .workspace-eyebrow")
      .first()
      .textContent(),
    /ROUND 01/,
  );
  assert.equal(
    await page.locator(".workspace-concept-number").first().textContent(),
    "12",
  );
  const cardFrames = page.locator(".workspace-live-preview iframe");
  assert.equal(await cardFrames.count(), 4);
  assert(
    await page
      .getByText("QUIET DIRECTION", { exact: false })
      .first()
      .isVisible(),
  );
  assert(
    await page
      .getByText("Does the first step feel clear?", { exact: true })
      .isVisible(),
  );
  assert(
    await page
      .getByRole("link", { name: "Handoff ↗", exact: true })
      .isVisible(),
  );
  const building = page.locator('.workspace-card[data-build-state="building"]');
  assert.equal(await building.locator("iframe").count(), 0);
  assert(await building.locator(".workspace-preview-launch").isDisabled());
  assert(await building.locator(".workspace-build-placeholder").isVisible());
  await page
    .frameLocator(".workspace-live-preview iframe")
    .nth(0)
    .frameLocator("iframe")
    .getByRole("heading", { name: "Original 0", exact: true })
    .waitFor();
  await page
    .frameLocator(".workspace-live-preview iframe")
    .nth(1)
    .frameLocator("iframe")
    .getByRole("heading", { name: "Original 2", exact: true })
    .waitFor();
  assert((await cardFrames.first().getAttribute("inert")) !== null);
  await page.waitForFunction(() =>
    document.getElementById("live-status").textContent.startsWith("Live"),
  );
  await writeFile(
    path.join(root, "previews/0.html"),
    (await readFile(path.join(root, "previews/0.html"), "utf8")) +
      "<p>Live card refreshed</p>",
  );
  await page
    .frameLocator(".workspace-live-preview iframe")
    .nth(0)
    .frameLocator("iframe")
    .getByText("Live card refreshed", { exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(evidence, "five-designs-grid.png") });
  await page.goto(base + `/boards/${board.id}/#first/concept0`);
  await page.locator("#reader-dialog[open]").waitFor();
  assert.equal(await page.locator("#reader-name").textContent(), "One");
  assert.match(page.url(), /#items\//);
  const originalFrame = page
    .frameLocator("#active-reader")
    .frameLocator("iframe");
  await originalFrame
    .getByRole("heading", { name: "Original 0", exact: true })
    .waitFor();
  await page.locator("#reader-type").evaluate((e) => {
    e.value = "115";
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await originalFrame.locator("body").evaluate(
    (body) =>
      new Promise((resolve) => {
        const done = () => {
          if (body.dataset.scale === "115") resolve();
          else setTimeout(done, 20);
        };
        done();
      }),
  );
  await readerTool("#reader-theme");
  await originalFrame.locator('body[data-theme="night"]').waitFor();
  assert.equal(
    await originalFrame.locator("body").getAttribute("data-theme"),
    "night",
  );
  await writeFile(
    path.join(root, "previews/0.html"),
    (await readFile(path.join(root, "previews/0.html"), "utf8")) +
      "<p>Active content updated</p>",
  );
  await page.locator("#reader-update").waitFor({ state: "visible" });
  assert.equal(
    await originalFrame
      .getByText("Active content updated", { exact: true })
      .count(),
    0,
  );
  await page.locator("#reader-update").click();
  await originalFrame
    .getByText("Active content updated", { exact: true })
    .waitFor();
  assert(await page.locator("#revision-group").isHidden());
  await readerTool("#size-trigger");
  await page.locator("[data-revision-choice=second]").click();
  await page.waitForURL(/~second$/);
  assert.equal(
    await page.locator("#reader-name").textContent(),
    "One · Second version",
  );
  await page.goBack();
  await page.waitForFunction(
    () => document.getElementById("reader-name").textContent === "One",
  );
  await page.goForward();
  await page.waitForFunction(() =>
    document
      .getElementById("reader-name")
      .textContent.includes("Second version"),
  );
  await page.locator("#reader-next").click();
  assert.equal(await page.locator("#reader-name").textContent(), "Three");
  await page.locator("#reader-previous").click();
  assert.equal(await page.locator("#reader-name").textContent(), "One");
  await page.locator("#reader-star").click();
  await page.locator("#notes-toggle").click();
  await page.locator("#reader-note").fill("Shared item note");
  await page.waitForFunction(() =>
    document.getElementById("reader-save-status").textContent.includes("saved"),
  );
  await page.locator("#reader-note").fill("Immediate child navigation draft");
  await page.locator("#notes-close").click();
  await readerTool("[data-surface=board]");
  await page.waitForURL(/\/boards\//);
  await boardTool("#workspace-owner");
  await page.locator("#reader-dialog[open]").waitFor();
  assert.equal(await page.locator("#reader-name").textContent(), "One");
  await readerTool("#size-trigger");
  await page.locator("[data-revision-choice=second]").click();
  assert.equal(
    await page.locator("#reader-name").textContent(),
    "One · Second version",
  );
  await page.locator("#notes-toggle").click();
  assert.equal(
    await page.locator("#reader-note").inputValue(),
    "Immediate child navigation draft",
  );
  await page.locator("#reader-note").fill("Owner feedback survives");
  await page.locator("#notes-close").click();
  await page.locator("#close-reader").click();
  await page.goBack();
  await page.locator("#reader-dialog[open]").waitFor();
  await page.locator("#close-reader").click();
  await page.goto(base + `/boards/${second.boardId}/`);
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(
    await (await cardNote()).inputValue(),
    "Owner feedback survives",
  );
  assert.equal(
    await page.locator("[data-star]").first().getAttribute("aria-pressed"),
    "true",
  );
  const reviewAtServer = async () =>
    (await (await fetch(base + "/api/items/" + first.id)).json()).review;
  const revertBaseline = await (await cardNote()).inputValue();
  const starBaseline = await page
    .locator("[data-star]")
    .first()
    .getAttribute("aria-pressed");
  await (await cardNote())
    .fill("Draft to undo before debounce");
  await (await cardNote()).fill(revertBaseline);
  await page.locator("[data-star]").first().click();
  await page.locator("[data-star]").first().click();
  await page.waitForFunction(
    () =>
      document.getElementById("save-status").textContent ===
      "Item notes saved on this Mac",
  );
  assert.equal((await reviewAtServer()).note, revertBaseline);
  assert.equal((await reviewAtServer()).star, starBaseline === "true");
  let releaseReview, reviewStarted;
  const reviewGate = new Promise((resolve) => (releaseReview = resolve));
  const startedReview = new Promise((resolve) => (reviewStarted = resolve));
  let gated = false;
  await page.route("**/api/operations", async (route) => {
    const body = route.request().postDataJSON();
    if (
      body.type === "review" &&
      body.patch.note === "Delayed draft to undo" &&
      !gated
    ) {
      gated = true;
      reviewStarted();
      await reviewGate;
    }
    await route.continue();
  });
  await (await cardNote()).fill("Delayed draft to undo");
  await startedReview;
  await (await cardNote()).fill(revertBaseline);
  releaseReview();
  await page.waitForFunction(
    () =>
      document.getElementById("save-status").textContent ===
      "Item notes saved on this Mac",
  );
  assert.equal((await reviewAtServer()).note, revertBaseline);
  assert.equal(
    await (await cardNote()).inputValue(),
    revertBaseline,
  );
  assert.equal((await reviewAtServer()).star, starBaseline === "true");
  await page.unroute("**/api/operations");
  let failSave = true;
  await page.route("**/api/operations", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "review" && failSave) {
      failSave = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary save outage" }),
      });
    } else await route.continue();
  });
  await (await cardNote()).fill("Network failure draft");
  await page
    .getByRole("heading", { name: "Change not saved", exact: true })
    .waitFor();
  assert.equal(
    await (await cardNote()).inputValue(),
    "Network failure draft",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await boardTool("#workspace-retry-drafts");
  await page.waitForFunction(
    () => document.getElementById("workspace-retry-drafts").hidden,
  );
  await page.unroute("**/api/operations");
  await page.reload();
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(
    await (await cardNote()).inputValue(),
    "Network failure draft",
  );
  let conflictSave = true;
  await page.route("**/api/operations", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "review" && conflictSave) {
      conflictSave = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Revision conflict" }),
      });
    } else await route.continue();
  });
  await (await cardNote()).fill("Conflict draft retained");
  await page
    .getByRole("button", { name: "Reload latest", exact: true })
    .click();
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(
    await (await cardNote()).inputValue(),
    "Conflict draft retained",
  );
  await page.unroute("**/api/operations");
  await boardTool("#workspace-retry-drafts");
  await page.waitForFunction(
    () => document.getElementById("workspace-retry-drafts").hidden,
  );
  await boardTool("[data-mode=canvas]");
  await page.locator("#fit").click();
  await page.waitForFunction(
    () =>
      document.getElementById("viewport").scrollLeft === 100000 &&
      document.getElementById("viewport").scrollTop === 100000,
  );
  const canvasViewport = await page.locator("#viewport").boundingBox(),
    canvasCard = await page.locator(".workspace-card").first().boundingBox();
  assert(
    canvasCard.x >= canvasViewport.x - 2 &&
      canvasCard.y >= canvasViewport.y - 2 &&
      canvasCard.x + canvasCard.width <=
        canvasViewport.x + canvasViewport.width + 2 &&
      canvasCard.y + canvasCard.height <=
        canvasViewport.y + canvasViewport.height + 2,
    "Grid to Canvas Fit has no uncompensated cushion offset",
  );
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.reload();
    await page.locator(".workspace-card").first().waitFor();
    assert.equal(
      await page.locator("body").getAttribute("data-board-layout"),
      "canvas",
    );
    await page.locator("#fit").click();
    await page.waitForFunction(
      () =>
        document.getElementById("viewport").scrollLeft === 100000 &&
        document.getElementById("viewport").scrollTop === 100000,
    );
    const vp = await page.locator("#viewport").boundingBox(),
      card = await page.locator(".workspace-card").first().boundingBox();
    assert(
      card.x >= vp.x - 2 &&
        card.y >= vp.y - 2 &&
        card.x + card.width <= vp.x + vp.width + 2 &&
        card.y + card.height <= vp.y + vp.height + 2,
      "Persisted Canvas reload fits visible card at " + width,
    );
  }
  await page.keyboard.press("Escape");
  const beforeNudge = (await (await fetch(base + `/api/boards/${second.boardId}`)).json()).placements.find(p => !p.removedAt);
  await page.locator("[data-placement-select]").first().click();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.waitForFunction(async ({ id, x }) => (await (await fetch(`/api/boards/${id}`)).json()).placements.find(p => !p.removedAt).x === x, { id: second.boardId, x: beforeNudge.x - 10 });
  // Keep negative-coordinate fit coverage while placement editing uses direct
  // keyboard and resize gestures rather than a geometry form.
  await post("/api/operations", { type: "updatePlacement", boardId: second.boardId,
    placementId: beforeNudge.id, patch: { x: -2000, width: 380 } });
  await page.reload();
  await page
    .waitForFunction(
      () => document.querySelector(".workspace-card")?.style.left === "70px",
      {},
      { timeout: 5000 },
    )
    .catch(async (e) => {
      console.log(
        await page.evaluate(() => ({
          left: document.querySelector(".workspace-card")?.style.left,
          dialogs: [...document.querySelectorAll("dialog[open]")].map(
            (d) => d.textContent,
          ),
          errors: document.getElementById("board-error")?.textContent,
        })),
      );
      throw e;
    });
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".workspace-card")?.style.left === "70px",
  );
  await boardTool("#workspace-add");
  await page.getByRole("menuitem", { name: "Text", exact: true }).click();
  const canvasText = page.locator('.workspace-decoration [contenteditable]');
  await canvasText.fill("Making this week");
  await canvasText.press("Enter");
  await page.locator(".workspace-decoration").waitFor();
  await page.waitForFunction(() => document.querySelector(".workspace-decoration [data-decoration-label]")?.textContent === "Making this week");
  assert.equal(await page.locator('dialog.workspace-dialog[open]').count(), 0, "Canvas text edits in place");
  const mark = await page.locator(".workspace-decoration").boundingBox(), area = await page.locator("#viewport").boundingBox();
  assert(mark.y >= area.y && mark.y + mark.height <= area.y + area.height, "Header Add text stays visible");
  await page.keyboard.press("Escape");
  await page.locator("#fit").click();
  const bounds = await page.locator("#viewport").boundingBox();
  for (const selector of [".workspace-decoration", ".workspace-card"]) {
    const box = await page.locator(selector).first().boundingBox();
    assert(
      box.x >= bounds.x - 2 &&
        box.y >= bounds.y - 2 &&
        box.x + box.width <= bounds.x + bounds.width + 2 &&
        box.y + box.height <= bounds.y + bounds.height + 2,
      selector + " fits including negative coordinates",
    );
  }
  await page.screenshot({
    path: path.join(evidence, "negative-canvas-fit.png"),
  });
  await boardTool("[data-mode=grid]");
  await page.locator("[data-placement-select]").first().click();
  await page.getByRole("button", { name: "Archive here", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".workspace-card").length === 0,
  );
  await boardTool("#workspace-archive");
  await page.locator(".workspace-card").first().waitFor();
  await page.locator("[data-placement-select]").first().click();
  await page.getByRole("button", { name: "Restore here", exact: true }).click();
  await boardTool("#workspace-archive");
  await page.locator(".workspace-card").first().waitFor();
  await page.screenshot({ path: path.join(evidence, "graph-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(evidence, "graph-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert(
    await page
      .locator(".workspace-card")
      .first()
      .boundingBox()
      .then((b) => b.width > 280),
  );
  await page.locator("[data-placement-select]").first().click();
  await page.getByRole("button", { name: "Move…", exact: true }).click();
  await page.locator("[name=target]").selectOption(board.id);
  await page.getByRole("button", { name: "Move items", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".workspace-card").length === 0,
  );
  await page.goto(base + `/boards/${board.id}/`);
  await page.locator(".workspace-card").first().waitFor();
  const oldPlacements = await page.evaluate(() =>
    [...document.querySelectorAll(".workspace-card")]
      .filter((c) => c.querySelector("h3")?.textContent === "One")
      .map((c) => c.dataset.placement),
  );
  assert(oldPlacements.length);
  for (const oldPlacement of oldPlacements)
    await page.locator(`[data-placement-select="${oldPlacement}"]`).click();
  await page.getByRole("button", { name: "Move…", exact: true }).click();
  await page.locator("[name=target]").selectOption(second.boardId);
  await page.getByRole("button", { name: "Move items", exact: true }).click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll(".workspace-card h3")].some(
        (h) => h.textContent === "One",
      ),
  );
  await page.goto(base + `/boards/${board.id}/#first/concept0~second`);
  await page.locator("#reader-dialog[open]").waitFor();
  assert.equal(
    await page.locator("#reader-name").textContent(),
    "One · Second version",
  );
  await mkdir(path.join(boards, "later-legacy"));
  await writeFile(
    path.join(boards, "later-legacy/board.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Later legacy discovery",
      description: "A legacy folder added after graph enablement",
      createdAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    path.join(boards, "later-legacy/rounds.json"),
    JSON.stringify({ rounds: [], revisions: {} }),
  );
  await page.goto(base + "/");
  await page
    .getByRole("heading", { name: "Later legacy discovery", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator(".board-card")
      .filter({
        has: page.getByRole("heading", {
          name: "Later legacy discovery",
          exact: true,
        }),
      })
      .locator("[data-home-select]")
      .count(),
    0,
  );
  await page.goto(base + `/boards/${second.boardId}/`);
  await page.locator(".workspace-card").first().waitFor();
  await boardTool("#workspace-add");
  await page.getByRole("menuitem", { name: "Item…", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("A title is enough");
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  await page
    .getByRole("heading", { name: "A title is enough", exact: true })
    .waitFor();
  await page
    .locator(".workspace-card")
    .filter({
      has: page.getByRole("heading", {
        name: "A title is enough",
        exact: true,
      }),
    })
    .locator("[data-placement-select]")
    .click();
  await page
    .getByRole("button", { name: "New board around selection…", exact: true })
    .click();
  await page
    .getByLabel("Board title", { exact: true })
    .fill("Grouped atomically");
  await page
    .getByRole("button", { name: "Create board and move", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Grouped atomically", exact: true })
    .waitFor();
  const grouped = await (await fetch(base + "/api/workspace")).json();
  assert.equal(
    grouped.boards.filter((b) => b.title === "Grouped atomically").length,
    1,
  );
  assert.equal(
    grouped.boards.find((b) => b.title === "Grouped atomically").placements
      .length,
    1,
  );
  revision = grouped.revision;
  const offline = await op("createItem", {
    boardId: second.boardId,
    item: {
      title: "Offline settings app",
      content: {
        kind: "html",
        url: "http://127.0.0.1:1/settings",
        resource: first.content.resource,
        openMode: "inline",
        startInstructions:
          "Read the existing handoff and start the documented shared preview.",
      },
      preview: { text: "Stored settings representation" },
    },
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Offline settings app", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Offline settings app", exact: true })
    .click();
  await page.locator("#reader-dialog[open]").waitFor();
  assert.equal(
    await page.locator("#reader-standalone").getAttribute("href"),
    "http://127.0.0.1:1/settings",
  );
  const contentFrame = page.frameLocator("#active-reader");
  await contentFrame
    .getByRole("button", { name: "Copy start request", exact: true })
    .waitFor();
  await page.locator("#active-reader").evaluate((f) =>
    Object.defineProperty(f.contentWindow.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          f.contentWindow.capturedStart = text;
        },
      },
    }),
  );
  await contentFrame
    .getByRole("button", { name: "Copy start request", exact: true })
    .click();
  const copied = await page
    .locator("#active-reader")
    .evaluate((f) => f.contentWindow.capturedStart);
  assert(copied.includes(offline.itemId));
  assert(copied.includes("documented shared preview"));
  assert.equal(
    await contentFrame
      .getByRole("link", { name: "Open externally ↗", exact: true })
      .getAttribute("href"),
    "http://127.0.0.1:1/settings",
  );
  await contentFrame
    .getByRole("button", { name: "Retry / reload", exact: true })
    .click();
  assert(
    await contentFrame
      .getByText("Stored settings representation", { exact: true })
      .isVisible(),
  );
  // Natural Canvas input uses a dedicated board, independent of comparison data.
  revision = (await (await fetch(base + "/api/workspace")).json()).revision;
  const inputBoard = await op("createBoard", { title: "Canvas input fixture" });
  const inputItem = await op("createItem", {
    boardId: inputBoard.boardId,
    item: {
      title: "A card to move",
      description: "Drag this ordinary card body.",
      content: { kind: "text", text: "Primary idea content." },
    },
    placement: { x: 0, y: 0, width: 290, height: 500, z: 0 },
  });
  await op("createItem", {
    boardId: inputBoard.boardId,
    item: { title: "Room to scroll", description: "A second distant card." },
    placement: { x: 700, y: 0, width: 290, height: 500, z: 1 },
  });
  const inputPlacement = async () => {
    const b = await (
      await fetch(base + `/api/boards/${inputBoard.boardId}`)
    ).json();
    return b.placements.find((p) => p.itemId === inputItem.itemId);
  };
  const waitPlacement = async (test) => {
    for (let i = 0; i < 80; i++) {
      const p = await inputPlacement();
      if (test(p)) return p;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Canvas placement did not persist");
  };
  const planePosition = () =>
    page.locator("#plane").evaluate((el) => {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return { x: m.e, y: m.f };
    });
  let placementWrites = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/operations") &&
      request.method() === "POST" &&
      request.postDataJSON()?.type === "updatePlacement"
    )
      placementWrites++;
  });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(base + `/boards/${inputBoard.boardId}/`);
    await page.locator(".workspace-card").first().waitFor();
    assert.equal(
      await page.locator("body").getAttribute("data-board-layout"),
      "canvas",
    );
    const vp = await page.locator("#viewport").boundingBox();
    const empty = {
      x: vp.x + vp.width - 12,
      y: vp.y + vp.height - 12,
      width: 1,
      height: 1,
    };
    let before = await planePosition();
    await dragPointer(empty, -55, -45);
    assert.deepEqual(
      await planePosition(),
      before,
      "Background pointer drag does not grab Canvas",
    );
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.wheel(0, 70);
    await page.waitForFunction(
      (previous) =>
        new DOMMatrix(
          getComputedStyle(document.getElementById("plane")).transform,
        ).f < previous,
      before.y,
    );
    let after = await planePosition();
    assert.equal(Math.round(after.y - before.y), -70);
    before = after;
    await page.mouse.wheel(55, 0);
    await page.waitForFunction(
      (previous) =>
        new DOMMatrix(
          getComputedStyle(document.getElementById("plane")).transform,
        ).e < previous,
      before.x,
    );
    after = await planePosition();
    assert.equal(Math.round(after.x - before.x), -55);
    before = after;
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 40);
    await page.keyboard.up("Shift");
    await page.waitForFunction(
      (previous) =>
        new DOMMatrix(
          getComputedStyle(document.getElementById("plane")).transform,
        ).e < previous,
      before.x,
    );
    after = await planePosition();
    assert.equal(Math.round(after.x - before.x), -40);
    assert.equal(
      Math.round(after.y - before.y),
      0,
      "Shift wheel moves sideways",
    );
    const beforeZoom = await page
      .locator("#world")
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -20);
    await page.keyboard.up("Control");
    await page.waitForFunction(
      (previous) =>
        new DOMMatrix(
          getComputedStyle(document.getElementById("world")).transform,
        ).a > previous,
      beforeZoom,
    );
    if (width === 390) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 2,
      });
      const touchPoint = await page.locator("#viewport").evaluate((vp) => {
        const r = vp.getBoundingClientRect();
        for (const x of [r.left + 10, r.right - 10])
          for (const y of [r.top + 20, r.bottom - 20]) {
            const el = document.elementFromPoint(x, y);
            if (el && !el.closest(".workspace-card")) return { x, y };
          }
        throw new Error("No background touch point");
      });
      before = await planePosition();
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ id: 1, x: touchPoint.x, y: touchPoint.y }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ id: 1, x: touchPoint.x + 20, y: touchPoint.y + 30 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      after = await planePosition();
      assert.equal(Math.round(after.x - before.x), 20);
      assert.equal(
        Math.round(after.y - before.y),
        30,
        "One-finger background swipe pans on touch",
      );
      const pinchPoints = await page.locator("#viewport").evaluate((vp) => {
        const r = vp.getBoundingClientRect(),
          points = [];
        for (const x of [r.left + 30, r.right - 30])
          for (let y = r.top + 45; y < r.bottom - 45; y += 90) {
            const el = document.elementFromPoint(x, y);
            if (el && !el.closest(".workspace-card")) points.push({ x, y });
          }
        for (const a of points)
          for (const b of points)
            if (Math.hypot(a.x - b.x, a.y - b.y) >= 120) return [a, b];
        throw new Error("No two background pinch points");
      });
      const mid = {
        x: (pinchPoints[0].x + pinchPoints[1].x) / 2,
        y: (pinchPoints[0].y + pinchPoints[1].y) / 2,
      };
      const expanded = pinchPoints.map((p) => ({
        x: mid.x + (p.x - mid.x) * 1.15,
        y: mid.y + (p.y - mid.y) * 1.15,
      }));
      const pinchBefore = await page
        .locator("#world")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { id: 1, ...pinchPoints[0] },
          { id: 2, ...pinchPoints[1] },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { id: 1, ...expanded[0] },
          { id: 2, ...expanded[1] },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      const pinchAfter = await page
        .locator("#world")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
      assert(pinchAfter > pinchBefore, "Two-finger touch pinch retains zoom");
      await cdp.detach();
    }
    await page.reload();
    await page.locator(".workspace-card").first().waitFor();
    let p = await inputPlacement(),
      writes = placementWrites;
    await dragPointer(
      await page.locator(".workspace-card-copy>p").first().boundingBox(),
      20,
      15,
    );
    p = await waitPlacement(
      (next) => next.x === p.x + 20 && next.y === p.y + 15,
    );
    assert.equal(
      placementWrites - writes,
      1,
      "One body drag produces one placement write",
    );
    assert.equal(await page.locator("#reader-dialog").isVisible(), false);
    writes = placementWrites;
    const prior = p;
    await dragPointer(
      await page.locator(".workspace-preview-launch").first().boundingBox(),
      -10,
      -5,
    );
    p = await waitPlacement(
      (next) => next.x === prior.x - 10 && next.y === prior.y - 5,
    );
    assert.equal(
      placementWrites - writes,
      1,
      "Preview surface drags without opening",
    );
    assert.equal(await page.locator("#reader-dialog").isVisible(), false);
    const preview = await page
      .locator(".workspace-preview-launch")
      .first()
      .boundingBox();
    await page.mouse.move(
      preview.x + preview.width / 2,
      preview.y + preview.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      preview.x + preview.width / 2 + 2,
      preview.y + preview.height / 2 + 1,
    );
    await page.mouse.up();
    await page.locator("#reader-dialog[open]").waitFor();
    assert.equal(
      await page.locator("#reader-name").textContent(),
      "A card to move",
    );
    await page.locator("#close-reader").click();
    assert.equal(
      (await inputPlacement()).x,
      p.x,
      "A click below drag threshold only opens",
    );
    const note = await cardNote();
    await note.fill("Notes remain selectable");
    await note.focus();
    await page.keyboard.press("Meta+A");
    assert.deepEqual(
      await note.evaluate((el) => [el.selectionStart, el.selectionEnd]),
      [0, "Notes remain selectable".length],
    );
    await page.waitForFunction(
      () =>
        document.getElementById("save-status").textContent ===
        "Item notes saved on this Mac",
    );
    const beforeControls = await inputPlacement();
    await page.locator("[data-star]").first().click();
    await page.locator('[data-controls-focus="notes"]').first().click();
    await page.getByRole("button", { name: "Edit item…", exact: true }).click();
    await page
      .getByRole("heading", { name: "Edit item", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    assert.deepEqual(
      await inputPlacement(),
      beforeControls,
      "Notes, stars and editor controls do not drag",
    );
    // Bring the resize grip into view with ordinary scrolling, as a person would.
    const grip = await page.locator(".workspace-resize").first().boundingBox(),
      area = await page.locator("#viewport").boundingBox();
    const background = await page.locator("#viewport").evaluate((vp) => {
      const r = vp.getBoundingClientRect();
      for (const x of [r.left + 8, r.right - 8])
        for (const y of [r.top + 8, r.bottom - 8]) {
          const el = document.elementFromPoint(x, y);
          if (el && !el.closest(".workspace-card")) return { x, y };
        }
      throw new Error("No background point");
    });
    await page.mouse.move(background.x, background.y);
    await page.mouse.wheel(
      Math.max(0, grip.x + grip.width - area.x - area.width + 25),
      Math.max(0, grip.y + grip.height - area.y - area.height + 25),
    );
    await page.waitForFunction(() => {
      const grip = document
          .querySelector(".workspace-resize")
          .getBoundingClientRect(),
        vp = document.getElementById("viewport").getBoundingClientRect();
      return grip.right <= vp.right && grip.bottom <= vp.bottom;
    });
    writes = placementWrites;
    await dragPointer(
      await page.locator(".workspace-resize").first().boundingBox(),
      15,
      20,
    );
    const sized = await waitPlacement(
      (next) => next.width === p.width + 15 && next.height === p.height + 20,
    ).catch(async (error) => {
      console.log(
        JSON.stringify({
          phase: "resize",
          width,
          expected: p,
          actual: await inputPlacement(),
          view: await page.evaluate(() => ({
            dialogs: [...document.querySelectorAll("dialog[open]")].map(
              (d) => d.textContent,
            ),
            viewport: document
              .getElementById("viewport")
              .getBoundingClientRect()
              .toJSON(),
            resize: document
              .querySelector(".workspace-resize")
              ?.getBoundingClientRect()
              .toJSON(),
            plane: document.getElementById("plane").style.transform,
          })),
        }),
      );
      throw error;
    });
    assert.equal(
      placementWrites - writes,
      1,
      "Resize stays independent of body drag",
    );
    await page.reload();
    await page.locator(".workspace-card").first().waitFor();
    assert.equal((await inputPlacement()).width, sized.width);
    assert.equal(
      await page.locator("body").getAttribute("data-board-layout"),
      "canvas",
    );
    await boardTool("[data-mode=grid]");
    await page.reload();
    await page.locator(".workspace-grid-round").waitFor();
    assert.equal(
      await page.locator("body").getAttribute("data-board-layout"),
      "grid",
    );
    await boardTool("[data-mode=canvas]");
    await page.screenshot({
      path: path.join(evidence, `canvas-input-${width}.png`),
    });
  }
  }
  if (!process.env.TINKA_COVERS_ONLY && !process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY) {
  // Quiet header and stable preview regression: isolated graph fixtures only.
  revision = (await (await fetch(base + "/api/workspace")).json()).revision;
  const parentA = await op("createBoard", { title: "Parent A" });
  const parentB = await op("createBoard", { title: "Parent B" });
  const longTitle = "A shared reading board with a complete title that stays readable on a narrow screen";
  const stableBoard = await op("createBoard", { title: longTitle, parentBoardId: parentA.boardId });
  await op("reference", { sourceBoardId: parentA.boardId, placementIds: stableBoard.placementIds, targetBoardId: parentB.boardId });
  for (const index of [0, 1]) {
    await mkdir(path.join(root, `stable-${index}`), { recursive: true });
    await writeFile(path.join(root, `stable-${index}/index.html`), await readFile(path.join(root, `previews/${index === 0 ? 0 : 2}.html`)));
  }
  const stableItems = [];
  for (let index = 0; index < 2; index++) stableItems.push(await op("createItem", {
    boardId: stableBoard.boardId,
    item: { title: `Stable preview ${index}`, content: { kind: "html", resource: { ...first.content.resource, path: first.content.resource.path.replace(/previews\/0\.html$/, `stable-${index}/index.html`) } } },
    placement: { x: index * 380, y: 0, width: 362, height: 460, z: index, presentation: { mode: "panel", viewport: { width: 360, height: 414 } } },
  }));
  const stableRoute = `/boards/${stableBoard.boardId}/?from=${parentB.boardId}`;
  for (const width of [390, 900, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(base + stableRoute);
    await page.locator(".workspace-card").first().waitFor();
    assert.equal(await page.locator("#board-title").textContent(), longTitle);
    assert.equal(await page.locator("#board-info").isHidden(), true, "Tools starts folded at " + width);
    assert.equal(await page.locator("#workspace-toolbar").isVisible(), false);
    assert.equal(await page.locator("#workspace-parent").getAttribute("href"), `/boards/${parentB.boardId}/`, "Valid containing board wins at " + width);
    assert.equal(await page.locator("#canvas-header .brand").getAttribute("href"), "/");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#board-title").evaluate(el => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis"), true, "Complete current title wraps at " + width);
    assert.equal(await page.locator(".workspace-item-footer [data-item-controls]").count(), 2);
    assert.equal(await page.locator(".workspace-item-footer").filter({ hasText: "Notes" }).count(), 0, "Only one details trigger per footer");
    await page.screenshot({ path: path.join(evidence, `quiet-header-${width}.png`) });
    await page.locator("#board-info-toggle").focus();
    await page.keyboard.press("Enter");
    for (const selector of ["#workspace-add", "[data-mode=grid]", "[data-mode=canvas]", "#workspace-search", "#workspace-favorites", "#workspace-recent", "#workspace-archive", "#export", ".board-help summary"])
      assert.equal(await page.locator(selector).isVisible(), true, selector + " available in Tools at " + width);
    assert.equal(await page.locator("#help-panel").isVisible(), false, "Help starts folded");
    await page.locator(".board-help summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#help-panel").isVisible(), true, "Help expands from keyboard");
    await page.keyboard.press("Enter");
    await page.screenshot({ path: path.join(evidence, `quiet-tools-${width}.png`) });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#board-info").isHidden(), true);
    assert.equal(await page.locator("#board-info-toggle").evaluate(el => document.activeElement === el), true, "Escape restores Tools focus");
    await boardTool("#workspace-add");
    for (const name of ["Text", "Colored region", "Arrow"])
      assert.equal(await page.getByRole("menuitem", { name, exact: true }).isVisible(), true);
    await page.keyboard.press("Escape");
  }
  await page.goto(base + `/boards/${stableBoard.boardId}/`);
  await page.locator("#workspace-parent").waitFor();
  assert.equal(await page.locator("#workspace-parent").getAttribute("href"), "#parents", "Shared board without entry context requires parent choice");
  await page.locator("#workspace-parent").click();
  for (const id of [parentA.boardId, parentB.boardId]) assert.equal(await page.locator(`dialog[open] a[href="/boards/${id}/"]`).isVisible(), true);
  await page.keyboard.press("Escape");
  await page.goto(base + `/boards/${stableBoard.boardId}/?from=${second.boardId}`);
  await page.locator("#workspace-parent").waitFor();
  assert.equal(await page.locator("#workspace-parent").getAttribute("href"), "#parents", "Unrelated from cannot invent a parent");
  const soleChild = await post("/api/operations", { type: "createBoard", title: "Sole child", parentBoardId: parentA.boardId });
  await page.goto(base + `/boards/${soleChild.result.boardId}/`);
  await page.locator("#workspace-parent").waitFor();
  assert.equal(await page.locator("#workspace-parent").getAttribute("href"), `/boards/${parentA.boardId}/`, "Direct sole-parent entry is deterministic");
  await page.goto(base + `/boards/${parentA.boardId}/`);
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(await page.locator("#workspace-parent").isVisible(), false, "Home board has no invented parent");
  await page.goto(base + stableRoute);
  await page.locator(".workspace-card").first().waitFor();
  await page.locator(".workspace-preview-launch").first().click();
  await page.locator("#reader-dialog[open]").waitFor();
  await page.locator("#reader-next").click();
  await page.locator("#reader-previous").click();
  assert.equal(new URL(await page.locator("#reader-board-link").getAttribute("href"), base).pathname + new URL(await page.locator("#reader-board-link").getAttribute("href"), base).search, stableRoute);
  await page.locator("#reader-board-link").click();
  assert.equal(await page.locator("#reader-dialog").isVisible(), false, "Reader Board action ignores internal reader history");
  assert.equal(await page.locator("#workspace-parent").getAttribute("href"), `/boards/${parentB.boardId}/`);
  await page.locator("#workspace-parent").click();
  await page.waitForURL(base + `/boards/${parentB.boardId}/`);
  await page.waitForFunction(() => document.getElementById("board-title").textContent === "Parent B");
  assert.equal(await page.locator("#board-title").textContent(), "Parent B", "Parent means destination rather than browser Back");
  await page.goto(base + stableRoute);
  await page.locator(".workspace-card iframe").first().waitFor();
  await page.frameLocator(".workspace-card iframe").first().frameLocator("iframe").getByRole("heading", { name: "Original 0", exact: true }).waitFor();
  await page.frameLocator(".workspace-card iframe").nth(1).frameLocator("iframe").getByRole("heading", { name: "Original 2", exact: true }).waitFor();
  await page.evaluate(() => {
    window.stableProof = [...document.querySelectorAll(".workspace-card")].map(card => {
      const frame = card.querySelector("iframe"), inner = frame.contentDocument.querySelector("iframe");
      const proof = { id: card.dataset.placement, card, frame, doc: frame.contentDocument, inner, innerDoc: inner.contentDocument, outerLoads: 0, innerLoads: 0 };
      frame.addEventListener("load", () => proof.outerLoads++);
      inner.addEventListener("load", () => proof.innerLoads++);
      return proof;
    });
  });
  const identity = async phase => {
    const actual = await page.evaluate(() => window.stableProof.map(p => ({ id: p.id, card: document.querySelector(`[data-placement="${p.id}"]`) === p.card, frame: p.card.querySelector("iframe") === p.frame, document: p.frame.contentDocument === p.doc, inner: p.doc.querySelector("iframe") === p.inner, innerDocument: p.inner.contentDocument === p.innerDoc, outerLoads: p.outerLoads, innerLoads: p.innerLoads })));
    for (const proof of actual) assert.deepEqual({ ...proof, id: undefined }, { id: undefined, card: true, frame: true, document: true, inner: true, innerDocument: true, outerLoads: 0, innerLoads: 0 }, phase);
    return actual;
  };
  const stableCard = page.locator(".workspace-card").first();
  const stablePlacement = async () => (await (await fetch(base + `/api/boards/${stableBoard.boardId}`)).json()).placements.find(p => p.itemId === stableItems[0].itemId);
  const waitStablePlacement = async test => { await page.waitForFunction(async ({ id, itemId, test }) => { const b = await (await fetch(`/api/boards/${id}`)).json(); const p = b.placements.find(p => p.itemId === itemId); return Object.entries(test).every(([k,v]) => p[k] === v); }, { id: stableBoard.boardId, itemId: stableItems[0].itemId, test }); };
  let p = await stablePlacement();
  await dragPointer(await stableCard.locator(".workspace-preview-launch").boundingBox(), 18, 12);
  await waitStablePlacement({ x: p.x + 18, y: p.y + 12 });
  await identity("drag preserves mounted previews");
  p = await stablePlacement();
  await dragPointer(await stableCard.locator(".workspace-resize").boundingBox(), 12, 14);
  await waitStablePlacement({ width: p.width + 12, height: p.height + 14 });
  await identity("resize preserves mounted previews");
  await stableCard.locator("[data-placement-select]").click();
  p = await stablePlacement();
  await page.keyboard.press("Shift+ArrowRight");
  await waitStablePlacement({ x: p.x + 10 });
  await identity("selection and keyboard nudge preserve mounted previews");
  await stableCard.locator("[data-star]").click();
  await stableCard.locator("[data-item-controls]").click();
  await page.locator("#workspace-item-controls [data-note]").fill("Stable mounted notes");
  await page.waitForFunction(() => document.getElementById("save-status").textContent === "Item notes saved on this Mac");
  await identity("star and note preserve mounted previews");
  await page.locator('[data-paper="#e4ebdc"]').click();
  await page.waitForFunction(() => document.querySelector(".workspace-card").style.getPropertyValue("--item-paper") === "#e4ebdc");
  await identity("paper appearance preserves mounted previews");
  await page.keyboard.press("Escape");
  await post("/api/operations", { type: "updateBoard", boardId: stableBoard.boardId, patch: { decorations: [{ id: "qa-text", type: "text", x: 0, y: 520, width: 300, height: 60, text: "A quiet section", color: "#253018" }] } });
  await page.locator(".workspace-decoration").waitFor();
  await identity("decoration insertion preserves mounted previews");
  const beforeExternal = await stablePlacement();
  await post("/api/operations", { type: "updatePlacement", boardId: stableBoard.boardId, placementId: beforeExternal.id, patch: { x: beforeExternal.x + 9 } });
  await page.waitForFunction(x => document.querySelector(".workspace-card").style.left === x + "px", beforeExternal.x + 9 + 70);
  await identity("external geometry refresh preserves mounted previews");
  await post("/api/operations", { type: "updateBoard", boardId: stableBoard.boardId, patch: { decorations: [] } });
  await page.locator(".workspace-decoration").waitFor({ state: "detached" });
  const stableProof = await identity("decoration removal preserves mounted previews");
  await writeFile(path.join(evidence, "preview-identity-loads.json"), JSON.stringify(stableProof, null, 2));
  await stableCard.locator(".workspace-preview-launch").click();
  await page.locator("#reader-dialog[open]").waitFor();
  const active = page.frameLocator("#active-reader").frameLocator("iframe");
  await active.getByRole("heading", { name: "Original 0", exact: true }).waitFor();
  await page.locator("#active-reader").evaluate(el => { window.stableActive = { el, doc: el.contentDocument, loads: 0 }; el.addEventListener("load", () => window.stableActive.loads++); });
  await writeFile(path.join(root, "stable-0/index.html"), (await readFile(path.join(root, "stable-0/index.html"), "utf8")) + "<p>Stable resource version</p>");
  await page.locator("#reader-update").waitFor({ state: "visible" });
  assert.equal(await active.getByText("Stable resource version", { exact: true }).count(), 0, "Active content is offered, not replaced");
  assert.deepEqual(await page.evaluate(() => ({ same: document.querySelector("#active-reader") === window.stableActive.el && window.stableActive.el.contentDocument === window.stableActive.doc, loads: window.stableActive.loads })), { same: true, loads: 0 });
  await page.locator("#reader-update").click();
  await active.getByText("Stable resource version", { exact: true }).waitFor();
  await page.locator("#close-reader").click();
  assert.equal(await page.locator(".workspace-card iframe").nth(1).evaluate(frame => frame === window.stableProof[1].frame && frame.contentDocument === window.stableProof[1].doc), true, "Resource refresh leaves other target mounted");
  await mkdir(path.join(root, "stable-new"), { recursive: true });
  await writeFile(path.join(root, "stable-new/index.html"), "<!doctype html><h1>Intentional new source</h1>");
  await post("/api/operations", { type: "updateItem", itemId: stableItems[0].itemId, patch: { content: { kind: "html", resource: { ...first.content.resource, path: first.content.resource.path.replace(/previews\/0\.html$/, "stable-new/index.html") } } } });
  await page.frameLocator(".workspace-card iframe").first().frameLocator("iframe").getByRole("heading", { name: "Intentional new source", exact: true }).waitFor();
  assert.equal(await stableCard.evaluate(card => card === window.stableProof[0].card), true, "Intentional source update retains card identity");
  assert.equal(await page.locator(".workspace-card iframe").nth(1).evaluate(frame => frame === window.stableProof[1].frame && frame.contentDocument === window.stableProof[1].doc), true, "Content source update refreshes only its target");
  await page.locator("#board-info-toggle").click();
  await page.screenshot({ path: path.join(evidence, "selection-tools-grid.png") });
  await boardTool("[data-mode=grid]");
  await page.locator(".workspace-grid-round").waitFor();
  await page.frameLocator(".workspace-card iframe").first().frameLocator("iframe").getByRole("heading", { name: "Intentional new source", exact: true }).waitFor();
  await page.evaluate(() => { window.gridProof = [...document.querySelectorAll(".workspace-card")].map(card => ({ id: card.dataset.placement, card, frame: card.querySelector("iframe"), doc: card.querySelector("iframe").contentDocument })); });
  await boardTool("#workspace-favorites");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-card").length === 1);
  assert.equal(await page.locator(".workspace-card iframe").evaluate(frame => frame === window.gridProof[0].frame && frame.contentDocument === window.gridProof[0].doc), true, "Grid filter retains the matching preview");
  await boardTool("#workspace-favorites");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-card").length === 2);
  await page.frameLocator(".workspace-card iframe").nth(1).frameLocator("iframe").getByRole("heading", { name: "Original 2", exact: true }).waitFor();
  await page.evaluate(() => { window.gridProof = [...document.querySelectorAll(".workspace-card")].map(card => ({ id: card.dataset.placement, card, frame: card.querySelector("iframe"), doc: card.querySelector("iframe").contentDocument })); });
  const currentStableBoard = await (await fetch(base + `/api/boards/${stableBoard.boardId}`)).json();
  const reversed = [...currentStableBoard.reviewOrder].reverse();
  await post("/api/operations", { type: "updateBoard", boardId: stableBoard.boardId, patch: { reviewOrder: reversed } });
  await page.waitForFunction(id => document.querySelector(".workspace-card").dataset.placement === id, reversed[0]);
  assert.equal(await page.evaluate(() => window.gridProof.every(p => document.querySelector(`[data-placement="${p.id}"]`) === p.card && p.card.querySelector("iframe") === p.frame && p.frame.contentDocument === p.doc)), true, "Grid external review order preserves both preview documents");
  await page.locator(".workspace-card [data-item-controls]").first().click();
  for (const [mode, className] of [["card", "workspace-compact"], ["icon", "workspace-icon"], ["panel", "workspace-panel"]]) {
    await page.locator(`#workspace-item-controls [data-presentation="${mode}"]`).click();
    await page.waitForFunction(className => document.querySelector(".workspace-card").classList.contains(className), className);
    assert.equal(await page.locator(`#workspace-item-controls [data-presentation="${mode}"]`).getAttribute("aria-pressed"), "true", "Attached appearance popup changes " + mode);
  }
  await page.keyboard.press("Escape");



  const imageBoard = await post("/api/operations", { type: "createBoard", title: "Static image refresh fixture" });
  const imageItems = [];
  const svg = width => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20"><rect width="100%" height="100%" fill="${width === 20 ? "#547643" : "#3366cc"}"/></svg>`;
  for (const index of [0, 1]) {
    await mkdir(path.join(root, `static-image-${index}`), { recursive: true });
    await writeFile(path.join(root, `static-image-${index}/cover.svg`), svg(20));
    imageItems.push((await post("/api/operations", { type: "createItem", boardId: imageBoard.result.boardId,
      item: { title: `Static image ${index}`, content: { kind: "image", resource: { ...first.content.resource, path: first.content.resource.path.replace(/previews\/0\.html$/, `static-image-${index}/cover.svg`) } } },
      placement: { x: index * 380, y: 0, width: 300, height: 380, z: index } })).result);
  }
  const imageRequests = [0, 0];
  page.on("request", request => { for (const index of [0,1]) if (request.url().includes(`/static-image-${index}/cover.svg`)) imageRequests[index]++; });
  const initialImageLive=page.waitForResponse(response=>response.url()===base+`/api/boards/${imageBoard.result.boardId}/live`&&response.ok());
  await page.goto(base + `/boards/${imageBoard.result.boardId}/`);
  await initialImageLive;
  await page.waitForFunction(() => [...document.querySelectorAll(".workspace-card img")].length === 2 && [...document.querySelectorAll(".workspace-card img")].every(img => img.complete && img.naturalWidth === 20));
  await page.evaluate(() => { window.stableImages = [...document.querySelectorAll(".workspace-card img")]; });
  const imageBaseline = [...imageRequests];
  assert.deepEqual(imageBaseline, [1, 1], "Both initial image resources requested once");
  const imageSnapshot = await (await fetch(base + `/api/boards/${imageBoard.result.boardId}`)).json();
  await post("/api/operations", { type: "updatePlacement", boardId: imageBoard.result.boardId, placementId: imageSnapshot.placements[0].id, patch: { x: 17 } });
  await page.waitForFunction(() => document.querySelector(".workspace-card").style.left === "87px").catch(async error=>{console.log(JSON.stringify({phase:"image-geometry",dom:await page.locator(".workspace-card").evaluateAll(cards=>cards.map(card=>({id:card.dataset.placement,left:card.style.left}))),active:await page.evaluate(()=>document.activeElement?.outerHTML),drafts:await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.endsWith("/item-review-drafts")))),api:await(await fetch(base+`/api/boards/${imageBoard.result.boardId}`)).json()}));throw error;});
  assert.equal(await page.evaluate(() => window.stableImages.every((img,index) => document.querySelectorAll(".workspace-card img")[index] === img)), true, "Image DOM retained through geometry refresh");
  assert.deepEqual(imageRequests, imageBaseline, "Geometry refresh makes no extra image requests");
  await writeFile(path.join(root, "static-image-0/cover.svg"), svg(40));
  await page.waitForFunction(() => document.querySelector(".workspace-card img").naturalWidth === 40);
  assert.deepEqual(imageRequests, [2, 1], "Changed image bytes refresh the target resource only");
  assert.equal(await page.evaluate(() => window.stableImages.every((img,index) => document.querySelectorAll(".workspace-card img")[index] === img)), true, "Live image refresh preserves image elements");
  await writeFile(path.join(evidence, "image-request-counts.json"), JSON.stringify({ initial: imageBaseline, afterTargetUpdate: imageRequests }, null, 2));

  }

  if (!process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY) {
  // Automatic collection covers: current children, bounded work, stable mounts.
  revision = (await (await fetch(base + "/api/workspace")).json()).revision;
  const coverParent = await op("createBoard", { title: "Collection cover fixture" });
  const coverResource = relative => ({ ...first.content.resource, path: first.content.resource.path.replace(/previews\/0\.html$/, relative) });
  for (const index of [0, 1]) {
    await mkdir(path.join(root, `cover-${index}`), { recursive: true });
    await writeFile(path.join(root, `cover-${index}/index.html`), `<!doctype html><link rel="stylesheet" href="../cover-shared-${index}/style.css"><body><script>document.body.insertAdjacentHTML("afterbegin","<h1>Cover design ${index}</h1><footer>Complete bottom ${index}</footer>");try{parent.document.body.dataset.thumbnailWrite="bad"}catch{window.parentBlocked=true}fetch("/api/operations",{method:"POST"}).catch(()=>{});</script>`);
    await mkdir(path.join(root, `cover-shared-${index}`), { recursive: true });
    await writeFile(path.join(root, `cover-shared-${index}/style.css`), "html{background:#f4efe5}body{margin:0;width:440px;height:620px;display:flex;flex-direction:column;justify-content:space-between}h1{font:32px Georgia}footer{background:#d9debe}");
  }
  await writeFile(path.join(root, "cover-image.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="620"><rect width="440" height="620" fill="#f5d477"/></svg>`);
  const collections = [];
  for (const count of [1, 2, 4, 5]) {
    const collection = await op("createBoard", { title: `Collection of ${count}`, parentBoardId: coverParent.boardId });
    collection.children = [];
    for (let index = 0; index < count; index++) collection.children.push(await op("createItem", {
      boardId: collection.boardId,
      item: { title: `Child ${index}`, content: index < 2 ? { kind: "html", resource: coverResource(`cover-${index}/index.html`) } : index === 2 ? { kind: "image", resource: coverResource("cover-image.svg") } : index === 3 ? { kind: "text", text: "A useful thought to keep" } : { kind: "file", resource: coverResource("previews/README.md") } },
      placement: { x:index * 460, y:0, width:442, height:666, presentation:{mode:"panel",viewport:{width:440,height:620}} },
    }));
    collections.push(collection);
  }
  const two = collections[1], four = collections[2];
  await op("updatePlacement",{boardId:coverParent.boardId,placementId:two.placementIds[0],patch:{width:562,height:466,presentation:{mode:"panel",viewport:{width:560,height:420}}}});
  const coverSnapshot = await (await fetch(base + `/api/boards/${coverParent.boardId}`)).json();
  for (let index = 0; index < collections.length; index++) {
    const count = [1,2,4,5][index], descriptor = coverSnapshot.boardCovers[collections[index].boardId];
    assert.equal(descriptor.count, count);
    assert.equal(descriptor.tiles.length, Math.min(count,4), "Cover work stays capped at four direct children");
  }
  let browserWrites = 0;
  const coverWriteObserver = request => { if (request.method() !== "GET" && request.url().includes("/api/")) browserWrites++; };
  page.on("request", coverWriteObserver);
  await page.addInitScript(() => { window.collageScriptRan = false; addEventListener("message", e => { if(e.data === "COLLAGE_SCRIPT_RAN") window.collageScriptRan = true; }); });
  await page.setViewportSize({ width:1440, height:960 });
  await page.goto(base + `/boards/${coverParent.boardId}/`);
  const twoCard = page.locator(`[data-placement="${two.placementIds[0]}"]`);
  const fourCard = page.locator(`[data-placement="${four.placementIds[0]}"]`);
  await twoCard.locator(".board-collage iframe").first().waitFor();
  for (const frame of await twoCard.locator(".board-collage iframe").all()) await frame.contentFrame().getByRole("heading").waitFor();
  assert.equal(await twoCard.locator("[data-cover-tile]").count(), 2);
  assert.equal(await fourCard.locator("[data-cover-tile]").count(), 4);
  assert.equal(await page.evaluate(() => document.body.dataset.thumbnailWrite), undefined, "HTML thumbnail cannot access its parent document");
  for (const frame of await twoCard.locator(".board-collage iframe").all()) assert.equal(await frame.contentFrame().locator("body").evaluate(() => window.parentBlocked), true, "Script-built design renders in an opaque sandbox");
  const coverProof = await twoCard.evaluate(card => {
    window.coverMounts = [...card.querySelectorAll("[data-cover-tile]")].map(tile => { const frame=tile.querySelector("iframe"); const p={tile,frame,loads:0};frame.addEventListener("load",()=>p.loads++);return p; });
    return window.coverMounts.map(p => ({width:p.frame.clientWidth,height:p.frame.clientHeight,sandbox:p.frame.getAttribute("sandbox")}));
  });
  assert.deepEqual(coverProof.map(p => [p.width,p.height,p.sandbox]), [[440,620,"allow-scripts"],[440,620,"allow-scripts"]], "HTML tiles retain the whole supplied design viewport");
  const frameIdentities = [];
  for (const frame of await twoCard.locator(".board-collage iframe").all()) frameIdentities.push(await frame.contentFrame().locator("body").evaluate(() => window.coverIdentity = crypto.randomUUID()));
  await post("/api/operations", {type:"updatePlacement",boardId:coverParent.boardId,placementId:two.placementIds[0],patch:{x:21,width:350}});
  await post("/api/operations", {type:"review",itemId:two.itemId,patch:{star:true,note:"Collage stays mounted"}});
  await page.waitForFunction(id => document.querySelector(`[data-placement="${id}"] [data-star]`).getAttribute("aria-pressed")==="true", two.placementIds[0]);
  assert.equal(await page.evaluate(() => window.coverMounts.every(p=>p.tile.isConnected&&p.tile.querySelector("iframe")===p.frame&&p.loads===0)),true,"Geometry and review retain collage documents with zero loads");
  await post("/api/operations",{type:"updateBoard",boardId:two.boardId,patch:{reviewOrder:[...two.children].reverse().map(c=>c.placementIds[0])}});
  await page.waitForFunction(id=>document.querySelector(`[data-placement="${id}"] [data-cover-tile]`).dataset.coverTile, two.placementIds[0]);
  await page.waitForFunction(({placement,child})=>document.querySelector(`[data-placement="${placement}"] [data-cover-tile]`).dataset.coverTile===child,{placement:two.placementIds[0],child:two.children[1].placementIds[0]});
  assert.equal(await page.evaluate(() => window.coverMounts.every(p=>p.tile.isConnected&&p.tile.querySelector("iframe")===p.frame&&p.loads===0)),true,"Child reorder moves existing tiles without reloading");
  assert.deepEqual(await Promise.all((await twoCard.locator(".board-collage iframe").all()).map(frame => frame.contentFrame().locator("body").evaluate(() => window.coverIdentity))), [...frameIdentities].reverse(), "Reordered cover documents retain their JavaScript identities");
  await writeFile(path.join(root,"cover-shared-0/style.css"),"html{background:#c7e5ef}body{margin:0;width:440px;height:620px;display:flex;flex-direction:column;justify-content:space-between}h1{font:32px Georgia}footer{background:#d9debe}");
  await page.waitForFunction(id=>document.querySelector(`[data-cover-tile="${id}"] iframe`)!==window.coverMounts[0].frame,two.children[0].placementIds[0]);
  const refreshedCover = twoCard.locator(`[data-cover-tile="${two.children[0].placementIds[0]}"] iframe`).contentFrame();
  await refreshedCover.getByRole("heading").waitFor();
  assert.equal(await refreshedCover.locator("html").evaluate(el=>getComputedStyle(el).backgroundColor),"rgb(199, 229, 239)","A sibling CSS dependency refreshes its target cover");
  assert.equal(await page.evaluate(()=>window.coverMounts[1].loads),0,"A child asset change leaves the other cover tile mounted");
  assert.equal(browserWrites,0,"Reading, polling and rendering automatic covers do not mutate metadata");
  await writeFile(path.join(evidence,"cover-preview-identity-loads.json"),JSON.stringify({geometryAndReviewZeroLoads:true,reorderKeptDocuments:true,changedChildOnly:true,browserWrites,viewport:coverProof},null,2));
  page.off("request",coverWriteObserver);
  await twoCard.locator(".workspace-preview-launch").click();
  await page.waitForURL(base+`/boards/${two.boardId}/?from=${coverParent.boardId}`);
  await page.waitForFunction(()=>document.querySelector("#board-title").textContent==="Collection of 2");
  assert.equal(await page.locator("#board-title").textContent(),"Collection of 2","Cover click opens its board");
  await page.goto(base+`/boards/${coverParent.boardId}/`);
  await boardTool("[data-mode=grid]");
  await twoCard.locator(".board-collage").waitFor();
  await page.screenshot({path:path.join(evidence,"collection-covers-grid-1440.png")});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(evidence,"collection-covers-grid-390.png")});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"Collection grid does not overflow the viewport");
  await post("/api/operations",{type:"archive",boardId:two.boardId,placementIds:two.children[0].placementIds,archived:true});
  await page.waitForFunction(id=>document.querySelectorAll(`[data-placement="${id}"] [data-cover-tile]`).length===1,two.placementIds[0]);
  await post("/api/operations",{type:"remove",boardId:two.boardId,placementIds:two.children[1].placementIds});
  await page.waitForFunction(id=>!document.querySelector(`[data-placement="${id}"] .board-collage`),two.placementIds[0]);
  await post("/api/operations",{type:"updateItem",itemId:four.itemId,patch:{preview:{resource:coverResource("cover-image.svg")}}});
  await page.waitForFunction(id=>!!document.querySelector(`[data-placement="${id}"] .workspace-card-preview > img`),four.placementIds[0]);
  assert.equal(await fourCard.locator(".board-collage").count(),0,"Explicit custom preview wins over automatic cover");
  const groupSource = await post("/api/operations",{type:"createBoard",title:"Immediate grouping fixture"});
  await post("/api/operations",{type:"reference",sourceBoardId:four.boardId,placementIds:four.children.slice(0,2).map(child=>child.placementIds[0]),targetBoardId:groupSource.result.boardId});
  await page.setViewportSize({width:1440,height:960});
  await page.goto(base+`/boards/${groupSource.result.boardId}/`);
  await page.locator(".workspace-card").first().waitFor();
  for (const select of await page.locator("[data-placement-select]").all()) await select.click();
  await page.getByRole("button",{name:"New board around selection…",exact:true}).click();
  await page.getByLabel("Board title",{exact:true}).fill("Grouped designs");
  await page.getByRole("button",{name:"Create board and move",exact:true}).click();
  const immediate = page.locator(".workspace-card").filter({has:page.getByRole("heading",{name:"Grouped designs",exact:true})});
  await immediate.locator(".board-collage").waitFor();
  assert.equal(await immediate.locator("[data-cover-tile]").count(),2,"Grouping creates an automatic cover immediately without another edit");
  await page.goto(base+"/");
  const homeParent=page.locator(`a.board-link[href="/boards/${coverParent.boardId}/"]`);
  await homeParent.locator(".board-collage").waitFor();
  assert.equal(await homeParent.locator("iframe").count(),0,"Nested board tiles do not recurse into iframes");

  }
  if (!process.env.TINKA_COVERS_ONLY && !process.env.TINKA_FOCUSED_ONLY) {
  // One real pointer gesture moves the placement atomically, keeping existing cover media.
  const writes = [];
  const observeMove = request => {
    if (request.method() === "POST" && request.url().endsWith("/api/operations")) writes.push(request.postDataJSON());
  };
  page.on("request", observeMove);
  const snapshot = async () => (await fetch(base + "/api/workspace")).json();
  const waitGraph = async test => {
    for (let i=0;i<100;i++) { const next=await snapshot(); if(test(next)) return next; await new Promise(resolve=>setTimeout(resolve,30)); }
    throw new Error("Drag graph change did not persist");
  };
  const setZoom = async percent => {
    await page.locator("#zoom-slider").evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event("input",{bubbles:true}));},percent);
    await page.waitForFunction(value=>Math.round(new DOMMatrix(getComputedStyle(document.getElementById("world")).transform).a*100)===value,percent);
  };
  const beginDrag = async (source,target,offset={x:0,y:0}) => {
    const a=await source.locator(".workspace-preview-launch").boundingBox(),b=await target.boundingBox();
    await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
    await page.mouse.down();
    await page.mouse.move(b.x+b.width/2+offset.x,b.y+Math.min(70,b.height/3)+offset.y,{steps:12});
    await page.waitForTimeout(80); // Actual pressed-button hover must precede pointerup.
  };
  const showBoard = async (id,width,zoom) => {
    await page.setViewportSize({width,height:960});
    await page.goto(base+`/boards/${id}/`);
    await page.locator(".workspace-card").first().waitFor();
    await page.locator("#fit").click();
    await setZoom(zoom);
    const left=await page.locator(".workspace-card").evaluateAll(cards=>Math.min(...cards.map(card=>card.getBoundingClientRect().left)));
    if(left<20) {await page.mouse.move(width-10,850);await page.mouse.wheel(left-20,0);await page.waitForFunction(()=>Math.min(...[...document.querySelectorAll(".workspace-card")].map(card=>card.getBoundingClientRect().left))>=19);}
  };
  if (!process.env.TINKA_DRAG_OUT_ONLY) {
  const dragReceipts=[];
  for (const [width,zoom] of [[1440,50],[1440,100],[1440,125],[390,100]].filter(([width])=>!process.env.TINKA_DRAG_NARROW_ONLY||width===390)) {
    revision=(await snapshot()).revision;
    const parent=await op("createBoard",{title:`Drop gesture ${width} ${zoom}`});
    const target=await op("createBoard",{title:"READ FIRST",parentBoardId:parent.boardId});
    await op("updatePlacement",{boardId:parent.boardId,placementId:target.placementIds[0],patch:{x:width===390?0:250,y:width===390?200:0,width:260,height:270}});
    for(const index of [0,1]) await op("createItem",{boardId:target.boardId,item:{title:`Existing design ${index}`,content:{kind:"html",resource:{...first.content.resource,path:first.content.resource.path.replace(/previews\/0\.html$/,`previews/${index===0?0:2}.html`)}}}});
    const moving=await op("createItem",{boardId:parent.boardId,item:{title:"Focus reader",content:first.content,review:{note:"Keep this review",star:true},build:{state:"ready",message:"Keep build"}},placement:{x:0,y:0,width:190,height:160,presentation:{mode:"card",paper:"#f4ead9"}}});
    const shared=await op("reference",{sourceBoardId:parent.boardId,placementIds:moving.placementIds,targetBoardId:second.boardId});
    const before=await snapshot(),canonical=before.items.find(i=>i.id===moving.itemId),original=before.boards.find(b=>b.id===parent.boardId).placements.find(p=>p.id===moving.placementIds[0]);
    await showBoard(parent.boardId,width,zoom);
    const source=page.locator(`[data-placement="${moving.placementIds[0]}"]`),card=page.locator(`[data-placement="${target.placementIds[0]}"]`);
    for(const frame of await card.locator("iframe").all()) await frame.contentFrame().getByRole("heading").waitFor();
    await card.evaluate(el=>{window.dropCoverMounts=[...el.querySelectorAll("iframe")].map(frame=>{const proof={frame,loads:0};frame.addEventListener("load",()=>proof.loads++);return proof;});});
    const start=writes.length;
    if(width===1440&&zoom===100) {
      await beginDrag(source,card);
      await page.locator(".workspace-drop-target").waitFor();
      const liveBefore=await (await fetch(base+`/api/boards/${parent.boardId}/live`)).json();
      const changedDuringDrag=page.waitForResponse(async response=>response.url()===base+`/api/boards/${parent.boardId}/live`&&response.ok()&&(await response.json()).manifestRevision!==liveBefore.manifestRevision);
      await post("/api/operations",{type:"updateBoard",boardId:parent.boardId,patch:{title:"Updated while dragging"}});
      await changedDuringDrag;
      await page.waitForTimeout(50);
      await page.keyboard.press("Escape");await page.mouse.up();
      await page.waitForFunction(()=>document.getElementById("board-title").textContent==="Updated while dragging");
      assert.equal(writes.length,start,"Escape drains a deferred live edit and cancels without writes");
      assert.deepEqual((await snapshot()).boards.find(b=>b.id===parent.boardId).placements.find(p=>p.id===original.id),original);
      // Mere rectangle overlap is ordinary positioning when the pointer stays outside.
      const a=await source.locator(".workspace-preview-launch").boundingBox(),b=await card.boundingBox();
      await page.mouse.move(a.x+10,a.y+15);await page.mouse.down();
      await page.mouse.move(b.x-8,a.y+15,{steps:10});
      assert.equal(await page.locator(".workspace-drop-target").count(),0,"Overlapping dragged bounds do not select a board outside the pointer");
      await page.mouse.up();
      await waitGraph(ws=>ws.boards.find(b=>b.id===parent.boardId).placements.find(p=>p.id===original.id).x!==original.x);
      assert.equal(writes.at(-1).type,"updatePlacement","Ordinary overlap remains a single geometry operation");
      revision=(await snapshot()).revision;
      await op("updatePlacement",{boardId:parent.boardId,placementId:original.id,patch:{x:original.x,y:original.y}});
      await page.waitForFunction(({id,x})=>parseFloat(document.querySelector(`[data-placement="${id}"]`).style.left)===x,{id:original.id,x:await source.evaluate(el=>parseFloat(el.style.left))});
      await page.reload();await source.waitFor();await setZoom(zoom);
      for(const frame of await card.locator("iframe").all()) await frame.contentFrame().getByRole("heading").waitFor();
      await card.evaluate(el=>{window.dropCoverMounts=[...el.querySelectorAll("iframe")].map(frame=>{const proof={frame,loads:0};frame.addEventListener("load",()=>proof.loads++);return proof;});});
    }
    const moveStart=writes.length;
    await beginDrag(source,card);
    await page.locator(".workspace-drop-target").waitFor({timeout:5000}).catch(async error=>{await page.screenshot({path:path.join(evidence,`drag-target-failure-${width}-${zoom}.png`)});console.log(JSON.stringify({width,zoom,source:await source.boundingBox(),target:await card.boundingBox()}));throw error;});
    assert.match(await page.locator("#workspace-drop-hint").textContent(),/Move into READ FIRST/);
    assert.equal(await page.evaluate(()=>window.dropCoverMounts.every(p=>p.frame.isConnected&&p.loads===0)),true,"Hover keeps existing cover documents mounted");
    if(width===1440&&zoom===100) await page.screenshot({path:path.join(evidence,"drag-board-hover-1440.png")});
    await page.mouse.up();
    const after=await waitGraph(ws=>!ws.boards.find(b=>b.id===parent.boardId).placements.some(p=>p.id===original.id&&!p.removedAt));
    await page.waitForFunction(id=>document.querySelectorAll(`[data-placement="${id}"] [data-cover-tile]`).length===3,target.placementIds[0]);
    const movedTile=card.locator("[data-cover-tile]").last();
    await movedTile.locator("iframe").contentFrame().getByRole("heading").first().waitFor();
    const placed=after.boards.find(b=>b.id===target.boardId).placements.find(p=>p.itemId===moving.itemId);
    assert(placed&&placed.id!==original.id,"Move creates its normal destination placement and removes source");
    assert.deepEqual(after.items.find(i=>i.id===moving.itemId),canonical,"Canonical content/review/star/build identity stays unchanged");
    assert.deepEqual(placed.presentation,original.presentation,"Move retains placement presentation");
    assert(after.boards.find(b=>b.id===second.boardId).placements.some(p=>p.id===shared.placementIds[0]&&p.itemId===moving.itemId),"Other reference remains intact");
    assert.deepEqual(writes.slice(moveStart).map(w=>w.type),["move"],"Drop sends exactly one atomic move and no geometry write");
    assert.equal(await page.evaluate(()=>window.dropCoverMounts.length===2&&window.dropCoverMounts.every(p=>p.frame.isConnected&&p.loads===0)),true,"Drop appends third cover without reloading the two mounted documents");
    assert.equal(page.url(),base+`/boards/${parent.boardId}/`,"Drop stays on the containing board");
    if(width===1440&&zoom===100) await page.screenshot({path:path.join(evidence,"drag-board-after-1440.png")});
    dragReceipts.push({width,zoom,types:writes.slice(moveStart).map(w=>w.type),coverCount:3,existingCoverLoads:0});
    await card.locator(".workspace-preview-launch").click();
    await page.waitForURL(base+`/boards/${target.boardId}/?from=${parent.boardId}`);
    await page.locator(`[data-placement="${placed.id}"]`).waitFor();
    assert.equal(await page.locator(`[data-placement="${placed.id}"]`).count(),1,"Nested board contains the moved item");
  }
  // Client-side cycle guard and an authoritative server rejection both restore arrangement.
  revision=(await snapshot()).revision;
  const cycleRoot=await op("createBoard",{title:"Cycle and conflict fixture"});
  const ancestor=await op("createBoard",{title:"Ancestor",parentBoardId:cycleRoot.boardId});
  const descendant=await op("createBoard",{title:"Descendant",parentBoardId:ancestor.boardId});
  const childAlias=await op("reference",{sourceBoardId:ancestor.boardId,placementIds:descendant.placementIds,targetBoardId:cycleRoot.boardId});
  await op("updatePlacement",{boardId:cycleRoot.boardId,placementId:ancestor.placementIds[0],patch:{x:0,y:0,width:190,height:160}});
  await op("updatePlacement",{boardId:cycleRoot.boardId,placementId:childAlias.placementIds[0],patch:{x:260,y:0,width:260,height:270}});
  await showBoard(cycleRoot.boardId,1440,100);
  const ancestorCard=page.locator(`[data-placement="${ancestor.placementIds[0]}"]`),descendantCard=page.locator(`[data-placement="${childAlias.placementIds[0]}"]`);
  let n=writes.length;
  await beginDrag(ancestorCard,descendantCard);
  assert.equal(await page.locator(".workspace-drop-target").count(),0,"Descendant is not a valid drop target for its ancestor");
  await page.mouse.up();await page.waitForTimeout(120);
  assert.equal(writes.length,n,"Cycle rejection causes no geometry or move writes");
  revision=(await snapshot()).revision;
  const rejected=await op("createItem",{boardId:cycleRoot.boardId,item:{title:"Conflict card",content:first.content},placement:{x:0,y:350,width:190,height:160}});
  await page.reload();await page.locator(`[data-placement="${rejected.placementIds[0]}"]`).waitFor();await setZoom(100);
  const beforeConflict=await snapshot(),rejectedPlacement=beforeConflict.boards.find(b=>b.id===cycleRoot.boardId).placements.find(p=>p.id===rejected.placementIds[0]);
  await page.route("**/api/operations",async route=>{if(route.request().postDataJSON()?.type==="move") await route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"Workspace changed during this drag"})});else await route.continue();});
  n=writes.length;
  await beginDrag(page.locator(`[data-placement="${rejectedPlacement.id}"]`),descendantCard);
  await page.locator(".workspace-drop-target").waitFor();await page.mouse.up();
  await page.waitForTimeout(200);
  assert.deepEqual(writes.slice(n).map(w=>w.type),["move"],"409 rejection does not fall back to a geometry write");
  assert.deepEqual((await snapshot()).boards.find(b=>b.id===cycleRoot.boardId).placements.find(p=>p.id===rejectedPlacement.id),rejectedPlacement,"409 leaves source placement unchanged");
  assert.equal(await page.locator(`[data-placement="${rejectedPlacement.id}"]`).count(),1,"409 restores the source card");
  assert.equal(await page.locator(".workspace-drop-target").count(),0,"Conflict clears target feedback");
  await page.unroute("**/api/operations");
  await writeFile(path.join(evidence,"drag-board-receipt.json"),JSON.stringify({gestures:dragReceipts,escape:true,pointerOutsideOverlap:true,cycle:true,conflict:true},null,2));
  }
  // Parent return drop and deliberate cover-child lift share the existing move transaction.
  await page.addInitScript(()=>{window.qaInitialFrameLoads=new WeakMap();document.addEventListener("load",event=>{if(event.target.tagName==="IFRAME")window.qaInitialFrameLoads.set(event.target,(window.qaInitialFrameLoads.get(event.target)||0)+1);},true);});
  const outReceipts=[];
  const makeOutFixture=async title=>{
    revision=(await snapshot()).revision;
    const parent=await op("createBoard",{title}),group=await op("createBoard",{title:"READ FIRST",parentBoardId:parent.boardId});
    await op("updatePlacement",{boardId:parent.boardId,placementId:group.placementIds[0],patch:{x:0,y:0,width:310,height:300}});
    const children=[];
    for(const index of [0,1,2])children.push(await op("createItem",{boardId:group.boardId,item:{title:index===2?"Focus reader":`Design ${index}`,content:first.content,review:{note:"Keep this review",star:true},build:{state:"ready",message:"Keep build"}},placement:{x:index*220,y:0,width:190,height:160,presentation:{mode:"card",paper:"#f4ead9"}}}));
    const focus=children[2],shared=await op("reference",{sourceBoardId:group.boardId,placementIds:focus.placementIds,targetBoardId:second.boardId});
    return {parent,group,children,focus,shared};
  };
  const cardFor=id=>page.locator(`[data-placement="${id}"]`);
  const tileFor=(f,child=f.focus)=>cardFor(f.group.placementIds[0]).locator(`[data-cover-tile="${child.placementIds[0]}"]`);
  const coverReady=async f=>{await cardFor(f.group.placementIds[0]).waitFor();for(const iframe of await cardFor(f.group.placementIds[0]).locator("iframe").all()){await iframe.contentFrame().getByRole("heading").first().waitFor();const frame=await(await iframe.elementHandle()).contentFrame();await frame.waitForLoadState("load");}await page.waitForFunction(id=>[...document.querySelector(`[data-placement="${id}"]`).querySelectorAll("iframe")].every(frame=>window.qaInitialFrameLoads.get(frame)>0),f.group.placementIds[0]);};
  const tilePoint=async tile=>{const b=await tile.boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2};};
  const holdChild=async tile=>{const p=await tilePoint(tile);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.waitForTimeout(500);await page.locator("#workspace-child-drag").waitFor({timeout:3000});return p;};
  const blankPoint=async()=>page.locator("#viewport").evaluate(viewport=>{const r=viewport.getBoundingClientRect();for(const x of [r.right-55,r.right-180,r.left+55])for(const y of [r.top+140,r.bottom-100])if(!document.elementsFromPoint(x,y).some(el=>el.closest(".workspace-card")))return {x,y};throw new Error("No visible blank Canvas point");});
  const finishOut=async(f,start,sourceBoard,targetBoard,itemId=f.focus.itemId)=>{
    const next=await waitGraph(ws=>ws.boards.find(b=>b.id===sourceBoard).placements.some(p=>p.itemId===itemId&&p.removedAt));
    assert.deepEqual(writes.slice(start).map(w=>w?.type),["move"],"Outward gesture sends one atomic move without geometry or review writes");
    assert.equal(writes[start].sourceBoardId,sourceBoard);assert.equal(writes[start].targetBoardId,targetBoard);
    const placed=next.boards.find(b=>b.id===targetBoard).placements.find(p=>p.itemId===itemId&&!p.removedAt);
    assert(placed,"Moved item is present on destination board");return {next,placed};
  };
  for(const width of [1440,390]){
    const f=await makeOutFixture(`Parent return ${width}`),before=await snapshot(),canonical=before.items.find(i=>i.id===f.focus.itemId);
    await showBoard(f.group.boardId,width,100);
    if(width===390){const b=await cardFor(f.focus.placementIds[0]).boundingBox();await page.mouse.move(width-10,850);await page.mouse.wheel(b.x+b.width/2-width/2,0);await page.waitForTimeout(80);}
    const parent=page.locator("#workspace-parent");await page.waitForFunction(()=>document.getElementById("workspace-parent")?.getAttribute("href")?.startsWith("/boards/"));
    const start=writes.length;await beginDrag(cardFor(f.focus.placementIds[0]),parent);await page.locator("#workspace-parent.workspace-drop-target").waitFor();
    assert.match(await page.locator("#workspace-drop-hint").textContent(),/Parent|parent|Move/);
    if(width===1440)await page.screenshot({path:path.join(evidence,"parent-drag-hover-1440.png")});
    await page.mouse.up();const {next,placed}=await finishOut(f,start,f.group.boardId,f.parent.boardId);
    assert.deepEqual(next.items.find(i=>i.id===f.focus.itemId),canonical);
    assert.equal(page.url(),base+`/boards/${f.group.boardId}/`,"Parent drop does not navigate away");
    const owner=next.boards.find(b=>b.id===f.parent.boardId).placements.find(p=>p.id===f.group.placementIds[0]);
    assert(placed.x>=owner.x+owner.width||placed.x+placed.width<=owner.x||placed.y>=owner.y+owner.height||placed.y+placed.height<=owner.y,"Parent drop places returned item clear of its collection card");
    await parent.click();await page.waitForURL(base+`/boards/${f.parent.boardId}/`);await cardFor(placed.id).waitFor();await coverReady(f);
    assert.equal(await cardFor(f.group.placementIds[0]).locator("[data-cover-tile]").count(),2,"Returning to parent shows a cover reduced from three to two");
    outReceipts.push({gesture:"parent",width,types:writes.slice(start).map(w=>w.type),coverCount:2});
  }
  for(const zoom of [50,100,125]){
    const f=await makeOutFixture(`Cover pullout ${zoom}`);await showBoard(f.parent.boardId,1440,zoom);await coverReady(f);
    const group=cardFor(f.group.placementIds[0]),tile=tileFor(f),before=await snapshot(),canonical=before.items.find(i=>i.id===f.focus.itemId);
    if(zoom===100){const n=writes.length,p=await tilePoint(tile);await page.mouse.click(p.x,p.y);await page.waitForURL(base+`/boards/${f.group.boardId}/?from=${f.parent.boardId}`);assert.equal(writes.length,n,"Short cover-tile click opens the collection without moving a child");await page.locator("#workspace-parent").click();await page.waitForURL(base+`/boards/${f.parent.boardId}/`);await coverReady(f);await setZoom(zoom);}
    await group.evaluate(card=>{window.pulloutMounts=[...card.querySelectorAll("[data-cover-tile]")].slice(0,2).map(tile=>{const frame=tile.querySelector("iframe"),p={tile,frame,loads:0,src:frame.src,changes:[]};frame.addEventListener("load",()=>p.loads++);new MutationObserver(records=>records.forEach(record=>p.changes.push({attribute:record.attributeName,value:frame.getAttribute(record.attributeName)}))).observe(frame,{attributes:true,attributeFilter:["src"]});return p;});});
    const identityTokens=await Promise.all((await group.locator("iframe").all()).slice(0,2).map(frame=>frame.contentFrame().locator("body").evaluate(()=>window.qaPulloutToken=crypto.randomUUID())));
    if(zoom===100){
      let n=writes.length,p=await tilePoint(tile);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+20,p.y+12,{steps:4});await page.mouse.up();
      await waitGraph(ws=>ws.boards.find(b=>b.id===f.parent.boardId).placements.find(p=>p.id===f.group.placementIds[0]).x!==0);
      assert.deepEqual(writes.slice(n).map(w=>w?.type),["updatePlacement"],"Immediate cover drag moves the whole collection");
      assert.equal(await page.locator("#workspace-child-drag").count(),0);
      n=writes.length;await holdChild(tile);await page.mouse.up();await page.waitForTimeout(80);assert.equal(writes.length,n,"Hold and release inside source collection moves no child");
      for(const cancel of ["Escape","pointercancel","blur","multipointer"]){
        n=writes.length;await holdChild(tile);
        if(cancel==="Escape")await page.keyboard.press("Escape");
        else if(cancel==="blur")await page.evaluate(()=>window.dispatchEvent(new Event("blur")));
        else await page.evaluate(kind=>document.getElementById("viewport").dispatchEvent(new PointerEvent(kind==="multipointer"?"pointerdown":"pointercancel",{pointerId:kind==="multipointer"?99:1,pointerType:"mouse",bubbles:true,button:0})),cancel);
        await page.mouse.up();if(cancel==="multipointer")await page.evaluate(()=>document.getElementById("viewport").dispatchEvent(new PointerEvent("pointerup",{pointerId:99,pointerType:"mouse",bubbles:true,button:0})));await page.waitForTimeout(70);
        assert.equal(writes.length,n,`${cancel} cancels lifted child without writes`);assert.equal(await page.locator("#workspace-child-drag").count(),0);
      }
    }
    const start=writes.length;await holdChild(tile);assert.equal(await tile.getAttribute("class").then(c=>c.includes("workspace-cover-lifted")),true);
    const drop=await blankPoint();await page.mouse.move(drop.x,drop.y,{steps:12});
    const logical=await page.locator("#world").evaluate((world,p)=>{const r=world.getBoundingClientRect(),scale=new DOMMatrix(getComputedStyle(world).transform).a;return {x:(p.x-r.x)/scale-70,y:(p.y-r.y)/scale-70};},drop);
    if(zoom===100)await page.screenshot({path:path.join(evidence,"cover-child-lift-1440.png")});
    await page.mouse.up();const {next,placed}=await finishOut(f,start,f.group.boardId,f.parent.boardId);
    await cardFor(placed.id).waitFor();await page.waitForFunction(id=>document.querySelectorAll(`[data-placement="${id}"] [data-cover-tile]`).length===2,f.group.placementIds[0]);
    assert.deepEqual(next.items.find(i=>i.id===f.focus.itemId),canonical,"Pullout keeps canonical review/star/build/resource identity");
    assert(next.boards.find(b=>b.id===second.boardId).placements.some(p=>p.id===f.shared.placementIds[0]&&!p.removedAt),"Independent reference remains present");
    const media=await page.evaluate(()=>window.pulloutMounts.map(p=>({tileConnected:p.tile.isConnected,frameConnected:p.frame.isConnected,loads:p.loads})));
    assert(media.every(p=>p.tileConnected&&p.frameConnected&&p.loads===0),"Remaining cover tiles retain mounted documents without reload: "+JSON.stringify({zoom,media}));
    assert.deepEqual(await Promise.all((await group.locator("iframe").all()).slice(0,2).map(frame=>frame.contentFrame().locator("body").evaluate(()=>window.qaPulloutToken))),identityTokens,"Remaining cover documents retain their JavaScript identity");
    assert(writes[start].targetPosition&&Number.isFinite(placed.x)&&Number.isFinite(placed.y),"Canvas pullout includes atomic release geometry");
    assert(Math.abs(placed.x-logical.x)<=1&&Math.abs(placed.y-logical.y)<=1,"Release geometry stays near pointer at selected zoom");
    assert.equal(page.url(),base+`/boards/${f.parent.boardId}/`,"Pullout stays on current canvas");
    if(zoom===100)await page.screenshot({path:path.join(evidence,"cover-child-after-1440.png")});
    outReceipts.push({gesture:"cover-pullout",zoom,position:{x:placed.x,y:placed.y},release:logical,coverCount:2,remainingLoads:0});
  }
  // One child can move into another collection; the now-empty cover has no child to lift.
  revision=(await snapshot()).revision;
  const singleParent=await op("createBoard",{title:"Single and empty cover"}),single=await op("createBoard",{title:"Single",parentBoardId:singleParent.boardId}),other=await op("createBoard",{title:"Other",parentBoardId:singleParent.boardId});
  await op("updatePlacement",{boardId:singleParent.boardId,placementId:single.placementIds[0],patch:{x:0,y:0,width:300,height:280}});await op("updatePlacement",{boardId:singleParent.boardId,placementId:other.placementIds[0],patch:{x:470,y:0,width:300,height:280}});
  const only=await op("createItem",{boardId:single.boardId,item:{title:"Only child",content:first.content}}),one={parent:singleParent,group:single,focus:only};
  await showBoard(singleParent.boardId,1440,100);await coverReady(one);let n=writes.length;await holdChild(tileFor(one));const dest=await cardFor(other.placementIds[0]).boundingBox();await page.mouse.move(dest.x+dest.width/2,dest.y+65,{steps:10});await page.locator(".workspace-drop-target").waitFor();await page.mouse.up();await finishOut(one,n,single.boardId,other.boardId,only.itemId);
  await page.waitForFunction(id=>!document.querySelector(`[data-placement="${id}"] [data-cover-tile]`),single.placementIds[0]);n=writes.length;const empty=await cardFor(single.placementIds[0]).locator(".workspace-preview-launch").boundingBox();await page.mouse.move(empty.x+empty.width/2,empty.y+empty.height/2);await page.mouse.down();await page.waitForTimeout(500);assert.equal(await page.locator("#workspace-child-drag").count(),0,"Empty collection cannot lift a cover child");await page.keyboard.press("Escape");await page.mouse.up();assert.equal(writes.length,n);
  // An unresolved parent chooser never silently selects a destination.
  const ambiguous=await makeOutFixture("Ambiguous parent fixture");revision=(await snapshot()).revision;await op("reference",{sourceBoardId:ambiguous.parent.boardId,placementIds:ambiguous.group.placementIds,targetBoardId:second.boardId});await showBoard(ambiguous.group.boardId,1440,100);await page.waitForFunction(()=>document.getElementById("workspace-parent")?.getAttribute("href")==="#parents");n=writes.length;await beginDrag(cardFor(ambiguous.focus.placementIds[0]),page.locator("#workspace-parent"));assert.equal(await page.locator("#workspace-parent.workspace-drop-target").count(),0);await page.mouse.up();await page.waitForTimeout(100);assert.equal(writes.slice(n).some(w=>w?.type==="move"),false,"Unresolved multiple parents do not choose a destination");
  // A lifted board item cannot move into its own descendant.
  revision=(await snapshot()).revision;const childBoard=await op("createBoard",{title:"Lifted ancestor",parentBoardId:ambiguous.group.boardId}),descendant=await op("createBoard",{title:"Descendant",parentBoardId:childBoard.boardId}),alias=await op("reference",{sourceBoardId:childBoard.boardId,placementIds:descendant.placementIds,targetBoardId:ambiguous.parent.boardId});await op("updatePlacement",{boardId:ambiguous.parent.boardId,placementId:alias.placementIds[0],patch:{x:470,y:0,width:260,height:250}});await showBoard(ambiguous.parent.boardId,1440,100);await coverReady(ambiguous);n=writes.length;await holdChild(tileFor(ambiguous,{placementIds:childBoard.placementIds}));const invalid=await cardFor(alias.placementIds[0]).boundingBox();await page.mouse.move(invalid.x+invalid.width/2,invalid.y+65,{steps:10});assert.equal(await page.locator(".workspace-drop-target").count(),0);await page.mouse.up();await page.waitForTimeout(100);assert.equal(writes.length,n,"Lifted ancestor cycle cancels without metadata writes");
  // A rejected lifted move must restore the child and keep the user's local draft.
  const f=await makeOutFixture("Lift conflict fixture");await showBoard(f.parent.boardId,1440,100);await coverReady(f);
  const draftKey=`tinka/${cfg.workspaceId}/item-review-drafts`,drafts=JSON.stringify({[f.focus.itemId]:{note:"Unsaved child review"}});
  await page.addInitScript(({key,value,path})=>{if(location.pathname===path&&!sessionStorage.getItem(key+"/test-injected")){localStorage.setItem(key,value);sessionStorage.setItem(key+"/test-injected","1");}},{key:draftKey,value:drafts,path:`/boards/${f.parent.boardId}/`});await page.reload();await cardFor(f.group.placementIds[0]).waitFor();await coverReady(f);
  await page.route("**/api/operations",async route=>{if(route.request().postDataJSON()?.type==="move")await route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"Stale revision"})});else await route.continue();});
  const start=writes.length;await holdChild(tileFor(f));const blank=await blankPoint();await page.mouse.move(blank.x,blank.y,{steps:8});await page.mouse.up();await page.waitForTimeout(150);
  assert.deepEqual(writes.slice(start).map(w=>w?.type),["move"],"Rejected lift does not save geometry or flush review drafts");
  assert.equal(await page.locator("#workspace-child-drag").count(),0);assert.equal(await page.evaluate(key=>localStorage.getItem(key),draftKey),drafts,"409 preserves local child review draft");
  assert.equal(await tileFor(f).count(),1,"409 restores the same source child tile");
  await page.unroute("**/api/operations");await page.evaluate(key=>localStorage.removeItem(key),draftKey);
  await writeFile(path.join(evidence,"drag-out-receipt.json"),JSON.stringify({gestures:outReceipts,cancel:true,conflict:true},null,2));
  page.off("request",observeMove);
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    JSON.stringify({
      passed: process.env.TINKA_DRAG_OUT_ONLY ? "Parent header drop and long-press child pullout: atomic moves, cover updates, zoom50/100/125, narrow, normal whole-group drag, cancellation and409 draft preservation" : process.env.TINKA_DRAG_BOARDS_ONLY ? "Pointer drag into board: atomic move, zoom50/100/125, narrow, stable 2-to-3 cover documents, Escape, overlap, cycle and 409 rollback" : process.env.TINKA_COVERS_ONLY ? "Automatic collection covers for 1/2/4/5 children, script-built HTML in opaque sandbox, full viewport fit, stable geometry/review/reorder mounts, targeted sibling CSS refresh, immediate grouping, explicit preview precedence, archive/remove and bounded nested-board fallbacks" : process.env.TINKA_FOCUSED_ONLY ? "Quiet header/Tools/parent routes at 390/900/1440; mounted previews across geometry/review/decorations, targeted content reload, Grid filter/reorder, attached appearance popup and targeted image refresh" :
        "Canvas default and explicit Grid persistence, mouse background no-grab, wheel/horizontal/Shift-wheel/Ctrl zoom, real touch pan and pinch, threshold body/preview drag and click, notes/controls/resize persistence at390/1440; graph reader/history/revisions/shared durable review/moved aliases/geometry/archive/mixed legacy/offline content",
      assertions,
      evidence,
      fixture,
      errors,
    }),
  );
} finally {
  if (browser) await browser.close();
  try {
    await main(["stop", "--config", config]);
  } catch {}
}
