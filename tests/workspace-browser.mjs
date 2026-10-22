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
  if (!process.env.TINKA_FOCUSED_ONLY && !process.env.TINKA_COVERS_ONLY && !process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY && !process.env.TINKA_MULTI_DRAG_ONLY && !process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_HISTORY_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
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
  if (!process.env.TINKA_COVERS_ONLY && !process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY && !process.env.TINKA_MULTI_DRAG_ONLY && !process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_HISTORY_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
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

  if (!process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY && !process.env.TINKA_MULTI_DRAG_ONLY && !process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_HISTORY_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
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
    // A persisted revision precedes the completed browser refresh and gesture cleanup.
    // Wait for the existing Paste control to reflect idle before starting another pointer gesture.
    for (let i=0;i<100;i++) { const next=await snapshot(); if(test(next)) { await page.waitForFunction(()=>document.getElementById("workspace-paste")?.disabled===false); return next; } await new Promise(resolve=>setTimeout(resolve,30)); }
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
  if (!process.env.TINKA_DRAG_OUT_ONLY && !process.env.TINKA_MULTI_DRAG_ONLY && !process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_HISTORY_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
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
  if (!process.env.TINKA_MULTI_DRAG_ONLY && !process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_HISTORY_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
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
  }
  // Selected placements travel as one gesture and one store transaction.
  const multiReceipts=[];
  const makeMulti=async(title,narrow=false)=>{
    revision=(await snapshot()).revision;const parent=await op("createBoard",{title}),group=await op("createBoard",{title:"READ FIRST",parentBoardId:parent.boardId});
    await op("updatePlacement",{boardId:parent.boardId,placementId:group.placementIds[0],patch:{x:narrow?0:500,y:narrow?300:0,width:280,height:260}});
    const kept=await op("createItem",{boardId:group.boardId,item:{title:"Existing design",content:first.content}}),children=[];
    for(const index of [0,1])children.push(await op("createItem",{boardId:parent.boardId,item:{title:index?"Notebook":"Focus reader",content:first.content,review:{note:"Keep review "+index,star:true},build:{state:"ready",message:"Keep build"}},placement:{x:index*60,y:index*40,width:190,height:160,z:5-index,presentation:{mode:"card",paper:"#f4ead9"}}}));
    const references=[];for(const child of children)references.push(await op("reference",{sourceBoardId:parent.boardId,placementIds:child.placementIds,targetBoardId:second.boardId}));return {parent,group,kept,children,references};
  };
  const bringControl=async control=>{const b=await control.boundingBox(),vp=await page.locator("#viewport").boundingBox();let dx=0,dy=0;if(b.x+b.width/2<vp.x+15||b.x+b.width/2>vp.x+vp.width-15)dx=b.x+b.width/2-(vp.x+vp.width/2);if(b.y+b.height/2<vp.y+15||b.y+b.height/2>vp.y+vp.height-15)dy=b.y+b.height/2-(vp.y+vp.height/2);if(dx||dy){await page.mouse.move(vp.x+vp.width-8,vp.y+vp.height-8);await page.mouse.wheel(dx,dy);await page.waitForFunction(el=>{const b=el.getBoundingClientRect(),v=document.getElementById("viewport").getBoundingClientRect();return b.x+b.width/2>v.left+10&&b.x+b.width/2<v.right-10&&b.y+b.height/2>v.top+10&&b.y+b.height/2<v.bottom-10;},await control.elementHandle());}};
  const selectMany=async ids=>{for(const id of ids){const button=page.locator(`[data-placement-select="${id}"]`);await bringControl(button);if(await button.getAttribute("aria-pressed")!=="true")await button.click();}assert.equal(await page.locator(".workspace-card.selected").count(),ids.length);};
  const beginMany=async(id,target,right=false)=>{const preview=cardFor(id).locator(".workspace-preview-launch");await bringControl(preview);const a=await preview.boundingBox(),b=await target.boundingBox();await page.mouse.move(right?a.x+a.width-12:a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+Math.min(65,b.height/3),{steps:12});await page.waitForTimeout(70);};
  const activeBoard=(ws,id)=>ws.boards.find(b=>b.id===id);
  const activePlacements=(ws,id)=>activeBoard(ws,id).placements.filter(p=>!p.removedAt&&!p.archivedAt);
  const assertCanonical=(before,after,ids)=>{for(const id of ids)assert.deepEqual(after.items.find(i=>i.id===id),before.items.find(i=>i.id===id),"Batch gesture retains canonical content/review/star/build/resources");};
  if (!process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_HISTORY_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
  for(const [width,zoom,lead] of [[1440,50,0],[1440,100,1],[1440,125,0],[390,50,1]]){
    const f=await makeMulti(`Selected gesture ${width} ${zoom}`,width===390);await showBoard(f.parent.boardId,width,zoom);await coverReady(f);const ids=f.children.map(c=>c.placementIds[0]),itemIds=f.children.map(c=>c.itemId);await selectMany(ids);
    const group=cardFor(f.group.placementIds[0]);await group.evaluate(card=>{const frame=card.querySelector("iframe");window.multiKept={frame,loads:0};frame.addEventListener("load",()=>window.multiKept.loads++);});const frameToken=await group.locator("iframe").contentFrame().locator("body").evaluate(()=>window.multiToken=crypto.randomUUID());
    let before=await snapshot(),start=writes.length;await beginMany(ids[lead],group,lead===1);await page.locator(".workspace-drop-target").waitFor();assert.equal(await page.locator(".workspace-dragging").count(),2,"Both selected rendered cards follow the pointer");assert.match(await page.locator("#workspace-drop-hint").textContent(),/2 items/);
    if(width===1440&&zoom===100)await page.screenshot({path:path.join(evidence,"multi-into-hover-1440.png")});await page.mouse.up();let after=await waitGraph(ws=>ids.every(id=>activeBoard(ws,f.parent.boardId).placements.find(p=>p.id===id)?.removedAt));
    assert.deepEqual(writes.slice(start).map(w=>w?.type),["move"]);assert.deepEqual([...writes[start].placementIds].sort(),[...ids].sort(),"One batch move carries both placement IDs");assert.equal(after.revision,before.revision+1,"Containment is one revision");assertCanonical(before,after,itemIds);
    const moved=itemIds.map(id=>activePlacements(after,f.group.boardId).find(p=>p.itemId===id));for(let i=0;i<2;i++){assert.deepEqual(moved[i].presentation,activeBoard(before,f.parent.boardId).placements.find(p=>p.id===ids[i]).presentation);assert(activePlacements(after,second.boardId).some(p=>p.id===f.references[i].placementIds[0]));}
    await page.waitForFunction(id=>document.querySelectorAll(`[data-placement="${id}"] [data-cover-tile]`).length===3,f.group.placementIds[0]);await coverReady(f);assert.equal(await page.evaluate(()=>window.multiKept.frame.isConnected&&window.multiKept.loads===0),true,"Existing cover frame stays mounted during selected drop");assert.equal(await group.locator("iframe").first().contentFrame().locator("body").evaluate(()=>window.multiToken),frameToken);
    assert.equal(page.url(),base+`/boards/${f.parent.boardId}/`);if(width===1440&&zoom===100)await page.screenshot({path:path.join(evidence,"multi-into-after-1440.png")});
    await group.locator(".workspace-preview-launch").click();await page.waitForURL(base+`/boards/${f.group.boardId}/?from=${f.parent.boardId}`);await cardFor(moved[0].id).waitFor();await selectMany(moved.map(p=>p.id));await page.waitForFunction(()=>document.getElementById("workspace-parent")?.getAttribute("href")?.startsWith("/boards/"));
    before=await snapshot();start=writes.length;const offset={x:moved[1].x-moved[0].x,y:moved[1].y-moved[0].y};await beginMany(moved[lead].id,page.locator("#workspace-parent"));await page.locator("#workspace-parent.workspace-drop-target").waitFor();if(width===1440&&zoom===100)await page.screenshot({path:path.join(evidence,"multi-parent-hover-1440.png")});await page.mouse.up();after=await waitGraph(ws=>moved.every(p=>activeBoard(ws,f.group.boardId).placements.find(q=>q.id===p.id)?.removedAt));
    assert.deepEqual(writes.slice(start).map(w=>w?.type),["move"]);assert.equal(writes[start].placementIds.length,2);assert.equal(after.revision,before.revision+1);assertCanonical(before,after,itemIds);assert.equal(page.url(),base+`/boards/${f.group.boardId}/?from=${f.parent.boardId}`);
    const returned=itemIds.map(id=>activePlacements(after,f.parent.boardId).find(p=>p.itemId===id));assert.deepEqual({x:returned[1].x-returned[0].x,y:returned[1].y-returned[0].y},offset,"Parent batch preserves relative child positions");const owner=activePlacements(after,f.parent.boardId).find(p=>p.id===f.group.placementIds[0]);assert(returned.every(p=>p.x>=owner.x+owner.width||p.x+p.width<=owner.x||p.y>=owner.y+owner.height||p.y+p.height<=owner.y),"Parent batch is clear of collection cover");
    await page.locator("#workspace-parent").click();await page.waitForURL(base+`/boards/${f.parent.boardId}/`);await coverReady(f);assert.equal(await group.locator("[data-cover-tile]").count(),1,"Source collection cover removes both returned members");multiReceipts.push({width,zoom,lead,intoCount:3,outCount:1,offset,moveRequests:2});
  }
  // Representative ordinary geometry, cancellation, and held-child compatibility.
  const f=await makeMulti("Selected controls fixture");revision=(await snapshot()).revision;const single=await op("createItem",{boardId:f.parent.boardId,item:{title:"Unselected",content:first.content},placement:{x:0,y:260,width:190,height:160}});await showBoard(f.parent.boardId,1440,100);await coverReady(f);const ids=f.children.map(c=>c.placementIds[0]);await selectMany(ids);
  let before=await snapshot(),start=writes.length;const lead=cardFor(ids[0]),a=await lead.locator(".workspace-preview-launch").boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(a.x+a.width/2+25,a.y+a.height/2+30,{steps:8});await page.mouse.up();let after=await waitGraph(ws=>ws.revision>before.revision);assert.deepEqual(writes.slice(start).map(w=>w?.type),["translatePlacements"],"Selected canvas move is one atomic geometry transaction");assert.equal(after.revision,before.revision+1);for(const id of ids){const p=activeBoard(before,f.parent.boardId).placements.find(p=>p.id===id),q=activeBoard(after,f.parent.boardId).placements.find(p=>p.id===id);assert.deepEqual([q.x-p.x,q.y-p.y],[25,30]);}
  before=after;start=writes.length;await dragPointer(await cardFor(single.placementIds[0]).locator(".workspace-preview-launch").boundingBox(),15,10);after=await waitGraph(ws=>ws.revision>before.revision);assert.deepEqual(writes.slice(start).map(w=>w?.type),["updatePlacement"],"Unselected card still drags singly");for(const id of ids)assert.deepEqual(activeBoard(after,f.parent.boardId).placements.find(p=>p.id===id),activeBoard(before,f.parent.boardId).placements.find(p=>p.id===id));await selectMany(ids);
  before=after;start=writes.length;await dragPointer(await lead.locator(".workspace-resize").boundingBox(),15,10);after=await waitGraph(ws=>ws.revision>before.revision);assert.deepEqual(writes.slice(start).map(w=>w?.type),["updatePlacement"],"Resize remains one selected card only");assert.deepEqual(activeBoard(after,f.parent.boardId).placements.find(p=>p.id===ids[1]),activeBoard(before,f.parent.boardId).placements.find(p=>p.id===ids[1]));
  for(const cancel of ["Escape","pointercancel"]){await selectMany(ids);before=await snapshot();start=writes.length;await beginMany(ids[0],cardFor(f.group.placementIds[0]));await page.locator(".workspace-drop-target").waitFor();if(cancel==="Escape")await page.keyboard.press("Escape");else await page.evaluate(()=>document.getElementById("viewport").dispatchEvent(new PointerEvent("pointercancel",{pointerId:1,pointerType:"mouse",bubbles:true})));await page.mouse.up();assert.equal(writes.length,start);assert.equal((await snapshot()).revision,before.revision);assert.equal(await page.locator(".workspace-card.selected").count(),2,`${cancel} preserves the selected pair`);}
  start=writes.length;await holdChild(tileFor(f,f.kept));const blank=await blankPoint();await page.mouse.move(blank.x,blank.y,{steps:8});await page.mouse.up();after=await waitGraph(ws=>activeBoard(ws,f.group.boardId).placements.some(p=>p.id===f.kept.placementIds[0]&&p.removedAt));assert.deepEqual(writes.slice(start).map(w=>w?.type),["move"]);assert.deepEqual(writes[start].placementIds,f.kept.placementIds,"Held collection child remains single despite an outside selection");assert.equal(await page.locator(".workspace-card.selected").count(),2);
  // Any selected member's descendant cycle rejects the entire containment move.
  revision=(await snapshot()).revision;const ancestor=await op("createBoard",{title:"Selected ancestor",parentBoardId:f.parent.boardId}),descendant=await op("createBoard",{title:"Descendant",parentBoardId:ancestor.boardId}),alias=await op("reference",{sourceBoardId:ancestor.boardId,placementIds:descendant.placementIds,targetBoardId:f.parent.boardId});await op("updatePlacement",{boardId:f.parent.boardId,placementId:ancestor.placementIds[0],patch:{x:260,y:260,width:190,height:160}});await op("updatePlacement",{boardId:f.parent.boardId,placementId:alias.placementIds[0],patch:{x:650,y:260,width:230,height:220}});await showBoard(f.parent.boardId,1440,100);await selectMany([ids[0],ancestor.placementIds[0]]);before=await snapshot();start=writes.length;await beginMany(ids[0],cardFor(alias.placementIds[0]));assert.equal(await page.locator(".workspace-drop-target").count(),0);await page.mouse.up();assert.equal(writes.length,start,"A cycle of either selected member rejects all placements");assert.equal((await snapshot()).revision,before.revision);assert.equal(await page.locator(".workspace-card.selected").count(),2);
  start=writes.length;await beginMany(ids[0],cardFor(ancestor.placementIds[0]));await page.mouse.up();after=await waitGraph(ws=>ws.revision>before.revision);assert.deepEqual(writes.slice(start).map(w=>w?.type),["translatePlacements"],"Moving selected board surfaces are ignored as containment destinations");
  // A stale batch response keeps both placements, selection and local review drafts.
  const draftKey=`tinka/${cfg.workspaceId}/item-review-drafts`,drafts=JSON.stringify({[f.children[0].itemId]:{note:"Unsaved selected review"}});await page.addInitScript(({key,value,path})=>{if(location.pathname===path&&!sessionStorage.getItem(key+"/multi-injected")){localStorage.setItem(key,value);sessionStorage.setItem(key+"/multi-injected","1");}},{key:draftKey,value:drafts,path:`/boards/${f.parent.boardId}/`});await page.reload();await cardFor(ids[0]).waitFor();await selectMany(ids);before=await snapshot();await page.route("**/api/operations",async route=>{if(route.request().postDataJSON()?.type==="move")await route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"Stale batch"})});else await route.continue();});start=writes.length;await beginMany(ids[0],cardFor(f.group.placementIds[0]));await page.locator(".workspace-drop-target").waitFor();await page.mouse.up();await page.waitForFunction(()=>document.getElementById("workspace-toast")?.textContent.includes("Move not saved"));assert.deepEqual(writes.slice(start).map(w=>w?.type),["move"]);assert.equal((await snapshot()).revision,before.revision);assert.equal(await page.locator(".workspace-card.selected").count(),2);assert.equal(await page.evaluate(key=>localStorage.getItem(key),draftKey),drafts);for(const id of ids)assert.deepEqual(activeBoard(await snapshot(),f.parent.boardId).placements.find(p=>p.id===id),activeBoard(before,f.parent.boardId).placements.find(p=>p.id===id));await page.unroute("**/api/operations");
  await writeFile(path.join(evidence,"multi-drag-receipt.json"),JSON.stringify({gestures:multiReceipts,translation:true,singleCompatibility:true,cancel:true,cycle:true,conflict:true},null,2));
  }
  if (!process.env.TINKA_HISTORY_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
  // Empty Canvas selection changes browser state only; previews and geometry stay put.
  const marqueeReceipts=[];
  const makeMarquee=async title=>{revision=(await snapshot()).revision;const board=await op("createBoard",{title}),items=[];for(const [index,x,y] of [[0,-120,-70],[1,100,-70],[2,380,150]])items.push(await op("createItem",{boardId:board.boardId,item:{title:`Box design ${index}`,content:first.content},placement:{x,y,width:160,height:150,presentation:{mode:"panel",viewport:{width:160,height:110}}}}));return {board,items};};
  const selectedIds=async()=>page.locator(".workspace-card.selected").evaluateAll(cards=>cards.map(card=>card.dataset.placement).sort());
  const boxBounds=async ids=>{const boxes=await Promise.all(ids.map(id=>cardFor(id).boundingBox()));return {a:{x:Math.min(...boxes.map(b=>b.x))-12,y:Math.min(...boxes.map(b=>b.y))-12},b:{x:Math.max(...boxes.map(b=>b.x+b.width))+12,y:Math.max(...boxes.map(b=>b.y+b.height))+12}};};
  const startBox=async(bounds,shift=false)=>{if(shift)await page.keyboard.down("Shift");await page.mouse.move(bounds.a.x,bounds.a.y);await page.mouse.down();await page.mouse.move(bounds.b.x,bounds.b.y,{steps:12});await page.locator("#workspace-marquee").waitFor();};
  const endBox=async(shift=false)=>{await page.mouse.up();if(shift)await page.keyboard.up("Shift");await page.locator("#workspace-marquee").waitFor({state:"hidden"});};
  const nativeReady=async ids=>{for(const id of ids){await cardFor(id).waitFor();const iframe=cardFor(id).locator("iframe");await iframe.contentFrame().locator(".item-full-frame").contentFrame().getByRole("heading").first().waitFor();await page.waitForFunction(id=>window.qaInitialFrameLoads.get(document.querySelector(`[data-placement="${id}"] iframe`))>0,id);}};
  const cardPositions=async ids=>Promise.all(ids.map(id=>cardFor(id).evaluate(el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y}))));
  const closePositions=(before,after,message)=>assert(before.every((p,i)=>Math.abs(p.x-after[i].x)<=1&&Math.abs(p.y-after[i].y)<=1),message);
  for(const [width,zoom,pan] of [[1440,50,false],[1440,100,true],[1440,125,false],[390,50,false]]){
    const f=await makeMarquee(`Marquee ${width} ${zoom}`),ids=f.items.map(i=>i.placementIds[0]);await showBoard(f.board.boardId,width,zoom);await nativeReady(ids);if(pan){const p=await cardFor(ids[0]).boundingBox(),vp=await page.locator("#viewport").boundingBox();await page.mouse.move(vp.x+vp.width-8,vp.y+vp.height-8);await page.mouse.wheel(-40,-30);await page.waitForFunction(({id,x})=>document.querySelector(`[data-placement="${id}"]`).getBoundingClientRect().x>x+35,{id:ids[0],x:p.x});}
    await page.locator(".workspace-card iframe").evaluateAll(frames=>{window.marqueeFrames=frames.map(frame=>{const p={frame,loads:0};frame.addEventListener("load",()=>p.loads++);return p;});});const tokens=await Promise.all(ids.map(id=>cardFor(id).locator("iframe").contentFrame().locator("body").evaluate(()=>window.marqueeToken=crypto.randomUUID()))),before=await snapshot(),positions=await cardPositions(ids),start=writes.length,bounds=await boxBounds(ids.slice(0,2));
    await startBox(bounds);assert.deepEqual(await selectedIds(),ids.slice(0,2).sort(),"Intersection box highlights and selects both cards live");assert.match(await page.locator("#workspace-marquee-count").textContent(),/2/);for(const id of ids.slice(0,2))assert.equal(await page.locator(`[data-placement-select="${id}"]`).getAttribute("aria-pressed"),"true");closePositions(positions,await cardPositions(ids),"Live selection count does not jump Canvas content");if(width===1440&&zoom===100)await page.screenshot({path:path.join(evidence,"marquee-live-1440.png")});if(width===390)await page.screenshot({path:path.join(evidence,"marquee-live-390.png")});await endBox();closePositions(positions,await cardPositions(ids),"Showing the selection toolbar keeps card screen positions stable");assert.equal(writes.length,start,"Selection emits no API or review operations");assert.equal((await snapshot()).revision,before.revision);assert.equal(await page.evaluate(()=>window.marqueeFrames.every(p=>p.frame.isConnected&&p.loads===0)),true);assert.deepEqual(await Promise.all(ids.map(id=>cardFor(id).locator("iframe").contentFrame().locator("body").evaluate(()=>window.marqueeToken))),tokens,"Marquee keeps existing preview documents");marqueeReceipts.push({width,zoom,pan,selected:2,operations:0,iframeLoads:0});
  }
  const f=await makeMarquee("Marquee controls"),ids=f.items.map(i=>i.placementIds[0]),draftKey=`tinka/${cfg.workspaceId}/item-review-drafts`,drafts=JSON.stringify({[f.items[0].itemId]:{note:"Unsaved marquee review"}});await page.addInitScript(({key,value,path})=>{if(location.pathname===path&&!sessionStorage.getItem(key+"/marquee-injected")){localStorage.setItem(key,value);sessionStorage.setItem(key+"/marquee-injected","1");}},{key:draftKey,value:drafts,path:`/boards/${f.board.boardId}/`});await showBoard(f.board.boardId,1440,100);await nativeReady(ids);let start=writes.length;await page.locator(`[data-placement-select="${ids[2]}"]`).click();await startBox(await boxBounds(ids.slice(0,2)));await endBox();assert.deepEqual(await selectedIds(),ids.slice(0,2).sort(),"Plain box replaces prior selection");await startBox(await boxBounds([ids[2]]),true);await endBox(true);assert.deepEqual(await selectedIds(),[...ids].sort(),"Shift box adds to prior selection");const blank=await blankPoint();await page.keyboard.down("Shift");await page.mouse.click(blank.x,blank.y);await page.keyboard.up("Shift");assert.equal((await selectedIds()).length,3,"Shift empty click keeps selection");await page.mouse.click(blank.x,blank.y);assert.equal((await selectedIds()).length,0,"Plain empty click clears selection");assert.equal(writes.length,start);
  await page.locator(`[data-placement-select="${ids[2]}"]`).click();
  for(const cancel of ["Escape","pointercancel","blur","lostcapture","multipointer"]){const original=await selectedIds(),positions=await cardPositions(ids);start=writes.length;await startBox(await boxBounds(ids.slice(0,2)));if(cancel==="Escape")await page.keyboard.press("Escape");else if(cancel==="blur")await page.evaluate(()=>window.dispatchEvent(new Event("blur")));else await page.evaluate(kind=>document.getElementById("viewport").dispatchEvent(new PointerEvent(kind==="multipointer"?"pointerdown":kind==="lostcapture"?"lostpointercapture":"pointercancel",{pointerId:kind==="multipointer"?99:1,pointerType:"mouse",isPrimary:kind!=="multipointer",button:0,bubbles:true})),cancel);await page.mouse.up();if(cancel==="multipointer")await page.evaluate(()=>document.getElementById("viewport").dispatchEvent(new PointerEvent("pointerup",{pointerId:99,pointerType:"mouse",bubbles:true})));assert.deepEqual(await selectedIds(),original,`${cancel} restores original selection`);closePositions(positions,await cardPositions(ids),`${cancel} restores viewport position`);assert.equal(writes.length,start);assert.equal(await page.locator("#workspace-marquee").isVisible(),false);}
  // Clip rectangle to the viewport even when the pointer leaves its edges.
  let vp=await page.locator("#viewport").boundingBox(),bounds=await boxBounds(ids.slice(0,2));await startBox({a:bounds.a,b:{x:vp.x+vp.width+60,y:vp.y+vp.height+60}});const rectangle=await page.locator("#workspace-marquee").boundingBox();assert(rectangle.x>=vp.x-1&&rectangle.y>=vp.y-1&&rectangle.x+rectangle.width<=vp.x+vp.width+1&&rectangle.y+rectangle.height<=vp.y+vp.height+1,"Selection rectangle is clipped to Canvas viewport");await page.keyboard.press("Escape");await page.mouse.up();
  // Live metadata waits until cancellation and does not alter the selection gesture.
  start=writes.length;const liveBefore=await(await fetch(base+`/api/boards/${f.board.boardId}/live`)).json();await startBox(await boxBounds(ids.slice(0,2)));const changed=page.waitForResponse(async response=>response.url()===base+`/api/boards/${f.board.boardId}/live`&&response.ok()&&(await response.json()).manifestRevision!==liveBefore.manifestRevision);await post("/api/operations",{type:"updateBoard",boardId:f.board.boardId,patch:{title:"Updated during marquee"}});await changed;assert.equal(await page.locator("#board-title").textContent(),"Marquee controls","Metadata does not rebuild an active marquee");await page.keyboard.press("Escape");await page.mouse.up();await page.waitForFunction(()=>document.getElementById("board-title").textContent==="Updated during marquee");assert.deepEqual(await selectedIds(),[ids[2]]);assert.equal(writes.length,start,"Deferred metadata and cancelled selection never flush pending review");assert.equal(await page.evaluate(key=>localStorage.getItem(key),draftKey),drafts);
  // Isolate ordinary decoration writes from this test-owned pending review.
  await page.addInitScript(key=>{if(sessionStorage.getItem(key+"/qa-reset")==="clear"){localStorage.removeItem(key);sessionStorage.removeItem(key+"/qa-reset");}},draftKey);await page.evaluate(key=>sessionStorage.setItem(key+"/qa-reset","clear"),draftKey);await page.reload();await cardFor(ids[0]).waitFor();
  // Region interiors select; the label band and screen-space border retain direct editing.
  revision=(await snapshot()).revision;await op("updateBoard",{boardId:f.board.boardId,patch:{decorations:[{id:"marquee-region",type:"region",x:-200,y:-180,width:850,height:650,text:"Group region",color:"#dfe7ce"},{id:"marquee-text",type:"text",x:-160,y:350,width:250,height:65,text:"A note",color:"#333333"},{id:"marquee-arrow",type:"line",x:200,y:350,width:200,height:30,text:"Arrow",color:"#333333",endArrow:true}]}});await showBoard(f.board.boardId,1440,100);await nativeReady(ids);bounds=await boxBounds(ids.slice(0,2));assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.closest('.workspace-decoration')?.dataset.decoration,bounds.a),"marquee-region");start=writes.length;await startBox(bounds);await endBox();assert.deepEqual(await selectedIds(),ids.slice(0,2).sort(),"Blank colored region interior starts selection");assert.equal(writes.length,start);
  for(const kind of ["label","border"]){const region=page.locator('[data-decoration="marquee-region"]'),box=await region.boundingBox(),p=kind==="label"?{x:box.x+box.width/2,y:box.y+15}:{x:box.x+box.width-2,y:box.y+box.height/2};const before=await snapshot();start=writes.length;await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+18,p.y+12,{steps:8});assert.equal(await page.locator("#workspace-marquee").isVisible(),false);await page.mouse.up();await waitGraph(ws=>ws.revision>before.revision);assert.deepEqual(writes.slice(start).map(w=>w?.type),["updateBoard"],`Region ${kind} still moves its decoration`);}
  for(const id of ["marquee-text","marquee-arrow"]){const box=await page.locator(`[data-decoration="${id}"]`).boundingBox();start=writes.length;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+15,box.y+box.height/2+10,{steps:6});assert.equal(await page.locator("#workspace-marquee").isVisible(),false,"Text and arrow surfaces do not start a selection box");await page.keyboard.press("Escape");await page.mouse.up();assert.equal(writes.length,start);}
  // Persisted local drafts are neither flushed nor removed by a box gesture.
  await page.addInitScript(({key,value})=>{if(sessionStorage.getItem(key+"/qa-inject")){localStorage.setItem(key,value);sessionStorage.removeItem(key+"/qa-inject");}},{key:draftKey,value:drafts});await page.evaluate(key=>sessionStorage.setItem(key+"/qa-inject","1"),draftKey);await page.reload();await cardFor(ids[0]).waitFor();start=writes.length;await startBox(await boxBounds(ids.slice(0,2)));await endBox();assert.equal(writes.length,start);assert.equal(await page.evaluate(key=>localStorage.getItem(key),draftKey),drafts);
  await writeFile(path.join(evidence,"marquee-receipt.json"),JSON.stringify({gestures:marqueeReceipts,shift:true,clear:true,cancel:true,clip:true,liveDefer:true,region:true,drafts:true},null,2));
  }
  page.off("request",observeMove);
  }
  if (!process.env.TINKA_FOCUSED_ONLY && !process.env.TINKA_COVERS_ONLY && !process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY && !process.env.TINKA_MULTI_DRAG_ONLY && !process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_CLIPBOARD_ONLY) {
    // Movement history is tab-local; isolate it from earlier fixtures' deliberate drafts.
    const hc=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:"reduce"}),hp=await hc.newPage();
    hp.on("pageerror",e=>errors.push(e.message));
    await hp.addInitScript(()=>{window.qaFrameLoads=new WeakMap();document.addEventListener("load",e=>{if(e.target.tagName==="IFRAME")window.qaFrameLoads.set(e.target,(window.qaFrameLoads.get(e.target)||0)+1);},true);});
    const hwrites=[],hreceipts=[],hkey=`tinka/${cfg.workspaceId}/movement-history`;
    hp.on("request",r=>{if(r.method()==="POST"&&r.url().endsWith("/api/operations"))hwrites.push(r.postDataJSON());});
    const hsnapshot=async()=>await(await fetch(base+"/api/workspace")).json();
    const hfixtureOp=async(type,data)=>{revision=(await hsnapshot()).revision;return await op(type,data);};
    const hboard=(ws,id)=>ws.boards.find(b=>b.id===id),hcard=id=>hp.locator(`[data-placement="${id}"]`);
    const arrangement=(ws,ids)=>ids.map(id=>{const b=hboard(ws,id);return {id,placements:b.placements,reviewOrder:b.reviewOrder};});
    const hstate=async()=>await hp.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'{"undo":[],"redo":[]}'),hkey);
    const hshow=async(id,width=1440,zoom=100,from)=>{await hp.setViewportSize({width,height:960});await hp.goto(base+`/boards/${id}/`+(from?`?from=${from}`:""));await hp.locator(".workspace-card").first().waitFor();if(await hp.locator('[data-mode="canvas"]').getAttribute("aria-pressed")!=="true"){await hp.locator("#board-info-toggle").click();await hp.locator('[data-mode="canvas"]').click();await hp.locator("#board-info-toggle").click();}await hp.locator("#fit").click();await hp.locator("#zoom-slider").evaluate((el,z)=>{el.value=String(z);el.dispatchEvent(new Event("input",{bubbles:true}));},zoom);const left=await hp.locator(".workspace-card").evaluateAll(cards=>Math.min(...cards.map(c=>c.getBoundingClientRect().left)));if(left<20){await hp.mouse.move(width-10,850);await hp.mouse.wheel(left-20,0);await hp.waitForFunction(()=>Math.min(...[...document.querySelectorAll(".workspace-card")].map(c=>c.getBoundingClientRect().left))>=19);}};
    const hready=async ids=>{for(const id of ids){await hcard(id).waitFor();const frame=hcard(id).locator('iframe[src*="/app/item.html"]');if(await frame.count())await frame.contentFrame().locator(".item-full-frame").contentFrame().getByRole("heading").first().waitFor();}await hp.waitForFunction(ids=>ids.every(id=>[...document.querySelector(`[data-placement="${id}"]`).querySelectorAll('iframe[src*="/app/item.html"]')].every(frame=>window.qaFrameLoads.get(frame)>0)),ids);};
    const hcommit=async(action,type)=>{const before=await hsnapshot(),start=hwrites.length,response=hp.waitForResponse(r=>r.request().method()==="POST"&&r.url()===base+"/api/operations"&&r.request().postDataJSON()?.type===type);await action();const r=await response,d=await r.json();assert.equal(r.status(),200,JSON.stringify(d));assert(d.history,"Successful movement returns reciprocal history");await hp.waitForFunction(({key,receipt})=>{const s=JSON.parse(sessionStorage.getItem(key)||"{}");return [...s.undo||[],...s.redo||[]].some(e=>JSON.stringify(e.history)===JSON.stringify(receipt));},{key:hkey,receipt:d.history});await hp.waitForFunction(()=>document.getElementById("workspace-paste")?.disabled===false);const after=await hsnapshot();assert.equal(after.revision,before.revision+1,"Movement history commits in one revision");assert.deepEqual(hwrites.slice(start).map(w=>w.type),[type]);hreceipts.push({type,before:before.revision,after:after.revision,placementIds:hwrites[start].placementIds});return {before,after};};
    const hreplay=async redo=>await hcommit(async()=>{await hp.evaluate(()=>document.activeElement?.blur());await hp.keyboard.press(redo?"Meta+Shift+z":"Meta+z");},"restoreMovement");
    const hdrag=async(locator,dx,dy,release=true)=>{const p=await locator.boundingBox();await hp.mouse.move(p.x+p.width/2,p.y+p.height/2);await hp.mouse.down();await hp.mouse.move(p.x+p.width/2+dx,p.y+p.height/2+dy,{steps:10});if(release)await hp.mouse.up();};
    const hdrop=async(id,target)=>{const p=await hcard(id).locator(".workspace-panel-title,.workspace-preview-launch").first().boundingBox(),t=await target.boundingBox();await hp.mouse.move(p.x+p.width/2,p.y+p.height/2);await hp.mouse.down();await hp.mouse.move(t.x+t.width/2,t.y+Math.min(t.height/3,65),{steps:14});await hp.locator(".workspace-drop-target").waitFor();};
    const hselect=async ids=>{const boxes=await Promise.all(ids.map(id=>hcard(id).boundingBox())),a={x:Math.min(...boxes.map(b=>b.x))-10,y:Math.min(...boxes.map(b=>b.y))-10},b={x:Math.max(...boxes.map(b=>b.x+b.width))+10,y:Math.max(...boxes.map(b=>b.y+b.height))+10};const count=hwrites.length;await hp.mouse.move(a.x,a.y);await hp.mouse.down();await hp.mouse.move(b.x,b.y,{steps:12});await hp.locator("#workspace-marquee").waitFor();await hp.mouse.up();assert.deepEqual(await hp.locator(".workspace-card.selected").evaluateAll(cards=>cards.map(c=>c.dataset.placement).sort()),[...ids].sort());assert.equal(hwrites.length,count);};
    const makeHistory=async title=>{const parent=await hfixtureOp("createBoard",{title}),group=await hfixtureOp("createBoard",{title:"READ FIRST",parentBoardId:parent.boardId});await hfixtureOp("updatePlacement",{boardId:parent.boardId,placementId:group.placementIds[0],patch:{x:600,y:0,width:260,height:240}});const kept=await hfixtureOp("createItem",{boardId:group.boardId,item:{title:"Kept child",content:first.content}}),children=[];for(let i=0;i<2;i++)children.push(await hfixtureOp("createItem",{boardId:parent.boardId,item:{title:i?"Notebook":"Focus reader",content:first.content,review:{note:"Retain note "+i,star:true}},placement:{x:i*250,y:0,width:200,height:220,z:i+4,presentation:{mode:"panel",viewport:{width:200,height:174}}}}));return {parent,group,kept,children};};
    const f=await makeHistory("Movement history"),bid=f.parent.boardId,gid=f.group.boardId,ids=f.children.map(i=>i.placementIds[0]);
    for(const [width,zoom] of [[1440,100],[1440,125],[390,100]]){
      await hshow(bid,width,zoom);await hready(ids);await hp.locator('.workspace-card iframe[src*="/app/item.html"]').evaluateAll(frames=>{window.historyMedia=frames.map(frame=>{const p={frame,loads:0};frame.addEventListener("load",()=>p.loads++);return p;});});
      const before=await hsnapshot(),move=await hcommit(()=>hdrag(hcard(ids[0]).locator(".workspace-panel-title"),30,15),"updatePlacement");await hreplay(false);assert.deepEqual(arrangement(await hsnapshot(),[bid]),arrangement(before,[bid]),"Undo restores exact placement identity and order");await hreplay(true);assert.deepEqual(arrangement(await hsnapshot(),[bid]),arrangement(move.after,[bid]));assert.equal(await hp.evaluate(()=>window.historyMedia.every(p=>p.frame.isConnected&&p.loads===0)),true,"Move/undo/redo keeps native preview documents");
      // Returning to the saved baseline keeps this representative case independent.
      await hreplay(false);
    }
    await hshow(bid,1440,100);await hready(ids);await hselect(ids);let before=await hsnapshot();const translated=await hcommit(()=>hdrag(hcard(ids[1]).locator(".workspace-panel-title"),25,15),"translatePlacements");await hreplay(false);assert.deepEqual(arrangement(await hsnapshot(),[bid]),arrangement(before,[bid]));await hreplay(true);assert.deepEqual(arrangement(await hsnapshot(),[bid]),arrangement(translated.after,[bid]));assert.equal(await hp.locator(".workspace-card.selected").count(),2,"Translation history retains valid selection");
    // A real empty footer strip carries the selected group, while title click still opens.
    const footer=await hcard(ids[0]).locator("footer").boundingBox(),blank={x:footer.x+1,y:footer.y+footer.height/2};assert.equal(await hp.evaluate(p=>!!document.elementFromPoint(p.x,p.y)?.closest("button"),blank),false);await hcommit(async()=>{await hp.mouse.move(blank.x,blank.y);await hp.mouse.down();await hp.mouse.move(blank.x+15,blank.y+10,{steps:8});await hp.mouse.up();},"translatePlacements");await hreplay(false);
    const geometry=await hsnapshot(),count=hwrites.length;await hcard(ids[0]).locator(".workspace-panel-title").click();await hp.locator("#reader-dialog[open]").waitFor();await hp.locator("#close-reader").click();await hp.locator("#reader-dialog").waitFor({state:"hidden"});assert.equal(hwrites.length,count);assert.deepEqual(arrangement(await hsnapshot(),[bid]),arrangement(geometry,[bid]));
    for(const mode of ["canvas","grid"]){if(mode==="grid"){await hp.locator("#board-info-toggle").click();await hp.locator('[data-mode="grid"]').click();await hp.locator("#board-info-toggle").click();}const start=hwrites.length;await hcard(ids[0]).locator(".workspace-panel-title").click({button:"right"});await hp.locator("#workspace-item-controls").waitFor();assert.equal(await hp.locator('#workspace-item-controls [data-presentation="panel"]').getAttribute("aria-pressed"),"true");await hcard(ids[0]).locator(".workspace-panel-title").click({button:"right"});assert.equal(await hp.locator("#workspace-item-controls").count(),1);assert.equal(hwrites.length,start);await hp.screenshot({path:path.join(evidence,`history-rightclick-${mode}-1440.png`)});await hp.keyboard.press("Escape");}
    await hshow(bid,1440,125);await hready(ids);await hselect(ids);before=await hsnapshot();const contained=await hcommit(async()=>{await hdrop(ids[0],hcard(f.group.placementIds[0]));await hp.screenshot({path:path.join(evidence,"history-into-hover-1440.png")});await hp.mouse.up();},"move");assert.deepEqual(contained.after.items,before.items);assert.equal(hp.url(),base+`/boards/${bid}/`);
    await hreplay(false);await hready(ids);await hselect(ids);await hreplay(true);await hp.locator("#workspace-selection").waitFor({state:"hidden"});assert.equal(await hp.locator(".workspace-card.selected").count(),0,"Redo prunes restored placements that moved away");
    const inside=ids.map(id=>{const old=hboard(before,bid).placements.find(p=>p.id===id);return hboard(contained.after,gid).placements.find(p=>p.itemId===old.itemId&&!p.removedAt).id;});
    // Same-tab navigation retains history; canonical review edits are deliberately concurrent.
    await hshow(gid,1440,100,bid);await hfixtureOp("review",{itemId:f.children[0].itemId,patch:{note:"Later canonical note",star:false}});const reviewed=(await hsnapshot()).items;await hreplay(false);assert.deepEqual(arrangement(await hsnapshot(),[bid,gid]),arrangement(before,[bid,gid]));assert.deepEqual((await hsnapshot()).items,reviewed,"Undo preserves later canonical notes and stars");await hreplay(true);assert.deepEqual(arrangement(await hsnapshot(),[bid,gid]),arrangement(contained.after,[bid,gid]));
    await hshow(gid,1440,100,bid);await hready(inside);await hselect(inside);before=await hsnapshot();const returned=await hcommit(async()=>{await hdrop(inside[1],hp.locator("#workspace-parent"));await hp.screenshot({path:path.join(evidence,"history-parent-hover-1440.png")});await hp.mouse.up();},"move");assert.equal(hp.url(),base+`/boards/${gid}/?from=${bid}`);await hreplay(false);assert.deepEqual(arrangement(await hsnapshot(),[bid,gid]),arrangement(before,[bid,gid]));await hreplay(true);assert.deepEqual(arrangement(await hsnapshot(),[bid,gid]),arrangement(returned.after,[bid,gid]));
    // Resize and keyboard nudge each produce one reversible step.
    await hshow(bid,1440,100);const active=hboard(await hsnapshot(),bid).placements.filter(p=>!p.removedAt&&f.children.some(i=>i.itemId===p.itemId)),aid=active[0].id;await hready(active.map(p=>p.id));before=await hsnapshot();await hcommit(()=>hdrag(hcard(aid).locator("[data-resize]"),20,15),"updatePlacement");await hreplay(false);assert.deepEqual(arrangement(await hsnapshot(),[bid]),arrangement(before,[bid]));await hcard(aid).locator("[data-placement-select]").click();before=await hsnapshot();await hcommit(()=>hp.keyboard.press("Shift+ArrowRight"),"translatePlacements");await hreplay(false);assert.deepEqual(arrangement(await hsnapshot(),[bid]),arrangement(before,[bid]));
    // A new movement after undo clears redo; cancellation/no-op creates no entry.
    await hcommit(()=>hdrag(hcard(aid).locator(".workspace-panel-title"),12,8),"updatePlacement");assert.equal((await hstate()).redo.length,0);let state=await hstate(),start=hwrites.length;await hdrag(hcard(aid).locator(".workspace-panel-title"),20,10,false);await hp.keyboard.press("Escape");await hp.mouse.up();assert.deepEqual(await hstate(),state);assert.equal(hwrites.length,start);
    // Text editing keeps native undo rather than invoking movement restoration.
    await hcard(aid).locator("[data-item-controls]").click();const note=hp.locator("#workspace-item-controls [data-note]");await note.focus();await note.pressSequentially(" temporary");const typedNote=await note.inputValue();start=hwrites.length;await hp.keyboard.press("Meta+z");assert.notEqual(await note.inputValue(),typedNote,"Notes keep native text undo");assert.equal(hwrites.slice(start).some(w=>w.type==="restoreMovement"),false);await hp.keyboard.press("Escape");
    // A later arrangement change safely rejects the inverse and retains local drafts.
    const draftKey=`tinka/${cfg.workspaceId}/item-review-drafts`,drafts=JSON.stringify({[f.children[1].itemId]:{note:"Keep local history draft"}});await hp.addInitScript(({key,value})=>{if(window.top===window)localStorage.setItem(key,value);},{key:draftKey,value:drafts});await hp.reload();await hcard(aid).waitFor();await hfixtureOp("updatePlacement",{boardId:bid,placementId:aid,patch:{x:active[0].x+99}});const conflicted=await hsnapshot();state=await hstate();start=hwrites.length;const rejection=hp.waitForResponse(r=>r.url()===base+"/api/operations"&&r.request().postDataJSON()?.type==="restoreMovement");await hp.evaluate(()=>document.activeElement?.blur());await hp.keyboard.press("Meta+z");assert.equal((await rejection).status(),409);await hp.locator("#workspace-toast").waitFor();assert.deepEqual(arrangement(await hsnapshot(),[bid,gid]),arrangement(conflicted,[bid,gid]));assert.deepEqual(await hstate(),state);assert.deepEqual(hwrites.slice(start).map(w=>w.type),["restoreMovement"]);assert.equal(await hp.evaluate(key=>localStorage.getItem(key),draftKey),drafts);
    await writeFile(path.join(evidence,"movement-history-receipt.json"),JSON.stringify({operations:hreceipts,representativeViews:[[1440,100],[1440,125],[390,100]],exactPlacementsAndOrder:true,canonicalReviewPreserved:true,stableNativeDocuments:true,branching:true,cancel:true,textUndo:true,conflictDrafts:true,footerAndContextMenu:true},null,2));await hc.close();
  }
  if (!process.env.TINKA_FOCUSED_ONLY && !process.env.TINKA_COVERS_ONLY && !process.env.TINKA_DRAG_BOARDS_ONLY && !process.env.TINKA_DRAG_OUT_ONLY && !process.env.TINKA_MULTI_DRAG_ONLY && !process.env.TINKA_MARQUEE_ONLY && !process.env.TINKA_HISTORY_ONLY) {
    // Synthetic ClipboardEvent data exercises the app handlers without touching the OS clipboard.
    const cc=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:"reduce"}),cp=await cc.newPage();
    cp.on("pageerror",e=>errors.push(e.message));
    await cp.addInitScript(()=>{window.qaClipboardCalls=[];const blocked=()=>{window.qaClipboardCalls.push("native clipboard API");throw new Error("QA must not touch the OS clipboard");};Object.defineProperty(navigator,"clipboard",{configurable:true,value:{read:blocked,readText:blocked,write:blocked,writeText:blocked}});const exec=document.execCommand.bind(document);document.execCommand=(name,...args)=>["copy","cut","paste"].includes(name)?blocked():exec(name,...args);window.qaFrameLoads=new WeakMap();document.addEventListener("load",e=>{if(e.target.tagName==="IFRAME")window.qaFrameLoads.set(e.target,(window.qaFrameLoads.get(e.target)||0)+1);},true);});
    const cwrites=[],creceipts=[],mime="application/x-tinka-placements+json",prefix="TINKA_CLIPBOARD_V1\n",historyKey=`tinka/${cfg.workspaceId}/movement-history`;
    cp.on("request",r=>{if(r.method()==="POST"&&r.url().endsWith("/api/operations"))cwrites.push(r.postDataJSON());});
    const csnapshot=async()=>await(await fetch(base+"/api/workspace")).json(),cboard=(ws,id)=>ws.boards.find(b=>b.id===id),ccard=id=>cp.locator(`[data-placement="${id}"]`);
    const cfixture=async(type,data)=>{revision=(await csnapshot()).revision;return await op(type,data);};
    const cshow=async(id,width=1440)=>{await cp.setViewportSize({width,height:960});const graph=cp.waitForResponse(r=>r.url()===base+"/api/workspace?covers=0"&&r.ok());await cp.goto(base+`/boards/${id}/`);await cp.locator("#workspace-copy").waitFor({state:"attached"});await graph;if(await cp.locator('[data-mode="canvas"]').getAttribute("aria-pressed")!=="true"){await cp.locator("#board-info-toggle").click();await cp.locator('[data-mode="canvas"]').click();await cp.locator("#board-info-toggle").click();}if(await cp.locator(".workspace-card").count())await cp.locator("#fit").click();};
    const cevent=async(type,data={},target)=>await cp.evaluate(({type,data,target})=>{const transfer=new DataTransfer();for(const [key,value]of Object.entries(data))transfer.setData(key,value);const event=new ClipboardEvent(type,{clipboardData:transfer,bubbles:true,cancelable:true});(target?document.querySelector(target):document.body).dispatchEvent(event);return {prevented:event.defaultPrevented,data:Object.fromEntries([...transfer.types].map(key=>[key,transfer.getData(key)]))};},{type,data,target});
    const cselect=async ids=>{for(const selected of await cp.locator('.workspace-card.selected [data-placement-select]').all())await selected.click();for(const id of [...ids].reverse())await ccard(id).locator("[data-placement-select]").click();assert.deepEqual(await cp.locator(".workspace-card.selected").evaluateAll(cards=>cards.map(c=>c.dataset.placement).sort()),[...ids].sort());};
    const ccopy=async ids=>{await cselect(ids);const start=cwrites.length,copy=await cevent("copy");assert.equal(copy.prevented,true);assert(copy.data[mime]);assert(copy.data["text/plain"].startsWith(prefix));assert.equal(cwrites.length,start);const payload=JSON.parse(copy.data[mime]);assert.deepEqual(payload.placements.map(p=>p.id).sort(),[...ids].sort());return {data:copy.data,payload};};
    const ccommit=async(action,type="pastePlacements")=>{const before=await csnapshot(),start=cwrites.length,rp=cp.waitForResponse(r=>r.request().method()==="POST"&&r.url()===base+"/api/operations"&&r.request().postDataJSON()?.type===type);await action();const response=await rp,d=await response.json();assert.equal(response.status(),200,JSON.stringify(d));assert(d.history);await cp.waitForFunction(({key,receipt})=>{const state=JSON.parse(sessionStorage.getItem(key)||"{}");return [...state.undo||[],...state.redo||[]].some(e=>JSON.stringify(e.history)===JSON.stringify(receipt));},{key:historyKey,receipt:d.history});if(type==="pastePlacements")await cp.waitForFunction(ids=>ids.every(id=>document.querySelector(`[data-placement="${id}"].selected`)),d.result.placementIds);await cp.waitForFunction(()=>document.getElementById("workspace-paste")?.disabled===false);const after=await csnapshot();assert.equal(after.revision,before.revision+1);assert.deepEqual(cwrites.slice(start).map(w=>w.type),[type]);creceipts.push({type,before:before.revision,after:after.revision,count:d.result.placementIds?.length});return {before,after,result:d.result,operation:cwrites[start]};};
    const cpaste=async data=>{const pasted=await ccommit(async()=>assert.equal((await cevent("paste",data)).prevented,true));await cp.waitForFunction(()=>document.getElementById("workspace-undo")?.disabled===false);return pasted;};
    const creplay=async redo=>{await cp.waitForFunction(direction=>document.getElementById("workspace-"+direction)?.disabled===false,redo?"redo":"undo");const replay=await ccommit(async()=>{await cp.evaluate(()=>document.activeElement?.blur());await cp.keyboard.press(redo?"Meta+Shift+z":"Meta+z");},"restoreMovement");await cp.waitForFunction(()=>document.getElementById("workspace-undo")?.disabled===false||document.getElementById("workspace-redo")?.disabled===false);return replay;};
    const carrange=(ws,id)=>{const b=cboard(ws,id);return {placements:b.placements,reviewOrder:b.reviewOrder};};
    const verifyPaste=(saved,pasted)=>{const board=cboard(pasted.after,pasted.result.boardId),placed=pasted.result.placementIds.map(id=>board.placements.find(p=>p.id===id)),origin={x:Math.min(...saved.placements.map(p=>p.x)),y:Math.min(...saved.placements.map(p=>p.y))};for(let i=0;i<placed.length;i++){const p=placed[i],old=saved.placements[i],item=pasted.after.items.find(i=>i.id===p.itemId);assert.notEqual(p.id,old.id);assert.notEqual(p.itemId,old.itemId);assert.equal(p.x,pasted.operation.targetPosition.x+old.x-origin.x);assert.equal(p.y,pasted.operation.targetPosition.y+old.y-origin.y);assert.equal(p.width,old.width);assert.equal(p.height,old.height);assert.deepEqual(p.presentation,old.presentation);assert.equal(p.z-placed[0].z,old.z-saved.placements[0].z);for(const key of ["title","description","content","review","resources","revisions","build"])assert.deepEqual(item[key],saved.items[old.itemId][key]);}const mapped=saved.reviewOrder.map(id=>pasted.result.placementIds[saved.placements.findIndex(p=>p.id===id)]);assert.deepEqual(board.reviewOrder.slice(-mapped.length),mapped);for(const old of pasted.before.items)assert.deepEqual(pasted.after.items.find(i=>i.id===old.id),old,"Paste keeps original canonical items");return placed;};
    const source=await cfixture("createBoard",{title:"Clipboard source"}),target=await cfixture("createBoard",{title:"Clipboard destination"}),moved=await cfixture("createBoard",{title:"Moved after copy"}),children=[];
    for(let i=0;i<2;i++)children.push(await cfixture("createItem",{boardId:source.boardId,item:{title:i?"Notebook":"Focus reader",content:first.content,review:{note:"Retain note "+i,star:true},resources:[first.content.resource]},placement:{x:i*270-70,y:i*55-20,width:210+i*10,height:240-i*10,z:7-i*4,presentation:{mode:"panel",viewport:{width:200,height:194},paper:i?"#e4ebdc":"#f1e8d5"}}}));
    const ids=children.map(i=>i.placementIds[0]),draftKey=`tinka/${cfg.workspaceId}/item-review-drafts`,drafts=JSON.stringify({[children[0].itemId]:{note:"Unsaved clipboard note"}});
    await cp.addInitScript(({key,value,path})=>{if(window.top===window&&location.pathname===path&&!sessionStorage.getItem(key+"/clip-injected")){localStorage.setItem(key,value);sessionStorage.setItem(key+"/clip-injected","1");}},{key:draftKey,value:drafts,path:`/boards/${source.boardId}/`});
    await cshow(source.boardId);for(const id of ids){await ccard(id).locator("iframe").contentFrame().locator(".item-full-frame").contentFrame().getByRole("heading").first().waitFor();}await cp.waitForFunction(ids=>ids.every(id=>window.qaFrameLoads.get(document.querySelector(`[data-placement="${id}"] iframe`))>0),ids);await cp.locator(".workspace-card iframe").evaluateAll(frames=>{window.clipboardMedia=frames.map(frame=>{const p={frame,loads:0};frame.addEventListener("load",()=>p.loads++);return p;});});
    const copied=await ccopy(ids);assert.equal(copied.payload.items[children[0].itemId].review.note,"Unsaved clipboard note");const same=await cpaste(copied.data);verifyPaste(copied.payload,same);for(const id of ids)assert.deepEqual(cboard(same.after,source.boardId).placements.find(p=>p.id===id),cboard(same.before,source.boardId).placements.find(p=>p.id===id));assert.equal(await cp.evaluate(()=>window.clipboardMedia.length===2&&window.clipboardMedia.every(p=>p.frame.isConnected&&p.loads===0)),true);assert.equal(await cp.evaluate(key=>localStorage.getItem(key),draftKey),drafts);for(const id of same.result.placementIds)await ccard(id).locator("iframe").contentFrame().locator(".item-full-frame").contentFrame().getByRole("heading").first().waitFor();await cp.waitForFunction(ids=>ids.every(id=>window.qaFrameLoads.get(document.querySelector(`[data-placement="${id}"] iframe`))>0),same.result.placementIds);await cp.screenshot({path:path.join(evidence,"clipboard-pair-same-board-1440.png")});await creplay(false);assert.deepEqual(carrange(await csnapshot(),source.boardId),carrange(same.before,source.boardId));await creplay(true);assert.deepEqual(carrange(await csnapshot(),source.boardId),carrange(same.after,source.boardId));
    // Clipboard content is immutable after the source placements and canonical title change.
    const movedSource=await cfixture("move",{sourceBoardId:source.boardId,placementIds:ids,targetBoardId:moved.boardId});await cfixture("updateItem",{itemId:children[0].itemId,patch:{title:"Edited after copy"}});await cshow(target.boardId);const other=await cpaste({"text/plain":copied.data["text/plain"]});verifyPaste(copied.payload,other);assert.equal(other.after.items.find(i=>i.id===other.result.itemIds[0]).title,copied.payload.items[copied.payload.placements[0].itemId].title);await creplay(false);assert.deepEqual(carrange(await csnapshot(),target.boardId),carrange(other.before,target.boardId));await creplay(true);assert.deepEqual(carrange(await csnapshot(),target.boardId),carrange(other.after,target.boardId));const repeated=await cpaste(copied.data);verifyPaste(copied.payload,repeated);assert.equal(repeated.result.itemIds.some(id=>other.result.itemIds.includes(id)),false);
    await cshow(target.boardId,390);await cp.locator("#zoom-slider").evaluate(el=>{el.value="100";el.dispatchEvent(new Event("input",{bubbles:true}));});const narrow=await cpaste(copied.data);verifyPaste(copied.payload,narrow);await cp.waitForFunction(ids=>{const v=document.getElementById("viewport").getBoundingClientRect();return ids.every(id=>{const b=document.querySelector(`[data-placement="${id}"]`).getBoundingClientRect();return b.left>=v.left-1&&b.top>=v.top-1&&b.right<=v.right+1&&b.bottom<=v.bottom+1;});},narrow.result.placementIds);assert(await cp.locator("#world").evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).a)<1,"Oversized narrow paste lowers view zoom without changing saved dimensions");for(const id of narrow.result.placementIds)await ccard(id).locator("iframe").contentFrame().locator(".item-full-frame").contentFrame().getByRole("heading").first().waitFor();await cp.waitForFunction(ids=>ids.every(id=>window.qaFrameLoads.get(document.querySelector(`[data-placement="${id}"] iframe`))>0),narrow.result.placementIds);await cp.screenshot({path:path.join(evidence,"clipboard-pair-390.png")});
    // Distinct selected aliases remain two placements sharing one fresh canonical item.
    const alias=await cfixture("reference",{itemIds:[children[0].itemId],targetBoardId:moved.boardId});await cshow(moved.boardId);const aliases=[movedSource.placementIds[0],...alias.placementIds];await cfixture("updatePlacement",{boardId:moved.boardId,placementId:alias.placementIds[0],patch:{x:400,y:260}});await cshow(moved.boardId);const aliasCopy=await ccopy(aliases);assert.equal(Object.keys(aliasCopy.payload.items).length,1);await cshow(target.boardId);const aliasPaste=await cpaste(aliasCopy.data);verifyPaste(aliasCopy.payload,aliasPaste);assert.equal(aliasPaste.result.itemIds[0],aliasPaste.result.itemIds[1]);
    // Board owners copy their layout and keep ordinary children as references.
    const group=await cfixture("createBoard",{title:"Collection copy",parentBoardId:source.boardId});await cfixture("reference",{itemIds:[children[0].itemId],targetBoardId:group.boardId});await cfixture("updateBoard",{boardId:group.boardId,patch:{decorations:[{id:"copy-label",type:"text",text:"Copied layout",color:"#446633",x:10,y:10,width:180,height:50}]}});await cshow(source.boardId);const boardCopy=await ccopy(group.placementIds);await cshow(target.boardId);const pastedBoard=await cpaste(boardCopy.data),owner=pastedBoard.after.items.find(i=>i.id===pastedBoard.result.itemIds[0]),newBoard=cboard(pastedBoard.after,owner.childBoardId);assert.notEqual(newBoard.id,group.boardId);assert.deepEqual(newBoard.decorations,boardCopy.payload.boards[group.boardId].decorations);assert.equal(newBoard.placements[0].itemId,children[0].itemId);assert.equal(pastedBoard.after.homeBoardIds.includes(newBoard.id),false);await ccard(pastedBoard.result.placementIds[0]).locator("[data-cover-tile]").waitFor();assert.equal(await ccard(pastedBoard.result.placementIds[0]).locator("[data-cover-tile]").count(),1);
    // Invalid and foreign envelopes are rejected before any graph write.
    for(const [payload,message]of [["{","could not be read"],[JSON.stringify({...copied.payload,workspaceId:"workspace-other"}),"different workspace"]]){const before=await csnapshot(),start=cwrites.length;assert.equal((await cevent("paste",{[mime]:payload})).prevented,true);await cp.waitForFunction(message=>document.getElementById("workspace-toast")?.textContent.includes(message),message);assert.equal(cwrites.length,start);assert.equal((await csnapshot()).revision,before.revision);}
    // Editing fields retain native clipboard ownership; untrusted events intentionally have no UA insertion.
    await cp.locator("#board-info-toggle").click();await cp.locator("#workspace-search").focus();let start=cwrites.length;assert.equal((await cevent("paste",{"text/plain":"native search paste"},"#workspace-search")).prevented,false);assert.equal((await cevent("copy",{},"#workspace-search")).prevented,false);assert.equal(cwrites.length,start);await cp.locator("#board-info-toggle").click();await cp.evaluate(()=>document.activeElement?.blur());
    // URL metadata is routed locally; parser/network behavior is covered by the service tests.
    const imageURL="https://images.example.org/reading-preview.svg";await cp.route(imageURL,route=>route.fulfill({status:200,contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#dfe7ce"/><text x="40" y="120" font-size="36" fill="#45583e">A place for reading</text></svg>'}));
    await cp.route("**/api/link-preview",async route=>{const url=route.request().postDataJSON().url;if(url.includes("blocked"))return route.fulfill({status:503,contentType:"application/json",body:'{"error":"Unavailable"}'});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({url,title:url.includes("embed")?"A writer on making room":"How reading makes room",description:"A useful summary, not an embedded web page.",siteName:"Reading Journal",author:"A Writer",image:imageURL,html:'<script id="qa-unfurl-html">window.qaUnfurlExecuted=true</script>'})});});
    const rich=await cpaste({"text/plain":"https://reading.example.org/og"}),richItem=rich.after.items.find(i=>i.id===rich.result.itemIds[0]);assert.equal(richItem.title,"How reading makes room");assert.equal(richItem.content.url,"https://reading.example.org/og");assert.equal(richItem.preview.url,imageURL);await ccard(rich.result.placementIds[0]).locator("img").waitFor();await cp.waitForFunction(id=>document.querySelector(`[data-placement="${id}"] img`)?.naturalWidth>0,rich.result.placementIds[0]);assert.equal(await cp.locator("#qa-unfurl-html").count(),0);await cp.screenshot({path:path.join(evidence,"clipboard-link-rich-1440.png")});await creplay(false);await creplay(true);
    const embed=await cpaste({"text/plain":"https://social.example.org/embed"});assert.equal(embed.after.items.find(i=>i.id===embed.result.itemIds[0]).title,"A writer on making room");assert.equal(await cp.evaluate(()=>window.qaUnfurlExecuted),undefined);const fallback=await cpaste({"text/plain":"https://blocked.example.org/path"}),fallbackItem=fallback.after.items.find(i=>i.id===fallback.result.itemIds[0]);assert.equal(fallbackItem.title,"blocked.example.org/path");assert.equal(fallbackItem.preview,undefined);
    // Clear active filters so the newly selected document is visible at narrow width.
    const docBoard=await cfixture("createBoard",{title:"Pasted document"});await cshow(docBoard.boardId,390);await cp.locator("#board-info-toggle").click();await cp.locator("#workspace-search").fill("does not match");await cp.locator("#workspace-favorites").click();await cp.locator("#board-info-toggle").click();await cp.evaluate(()=>document.activeElement?.blur());
    const line='A thoughtful line with <literal markup>, spaces, and a fresh beginning.\n',bigText='A long reading document\n\n'+line.repeat(Math.ceil(500000/line.length)).slice(0,500000)+'\nFinal line stays complete.\n';const documentPaste=await cpaste({"text/plain":bigText}),documentItem=documentPaste.after.items.find(i=>i.id===documentPaste.result.itemIds[0]);assert.equal(documentItem.content.text,bigText);assert.equal(await cp.locator("#workspace-search").inputValue(),"");assert.equal(await cp.locator("#workspace-favorites").getAttribute("aria-pressed"),"false");const documentCard=ccard(documentPaste.result.placementIds[0]);assert((await documentCard.textContent()).length<5000,"Card uses a bounded document excerpt");await cp.waitForFunction(id=>{const b=document.querySelector(`[data-placement="${id}"]`).getBoundingClientRect(),v=document.getElementById("viewport").getBoundingClientRect();return b.left>=v.left-1&&b.right<=v.right+1&&b.top>=v.top-1&&b.bottom<=v.bottom+1;},documentPaste.result.placementIds[0]);assert.equal(cboard(documentPaste.after,docBoard.boardId).placements[0].width,380);assert.equal(cboard(documentPaste.after,docBoard.boardId).placements[0].height,440);await cp.screenshot({path:path.join(evidence,"clipboard-document-390.png")});await documentCard.locator(".workspace-preview-launch").click();await cp.locator("#reader-dialog[open]").waitFor();const reader=cp.locator("#active-reader").contentFrame();await reader.locator(".item-text").waitFor();assert.equal(await reader.locator(".item-text").textContent(),bigText);assert.equal(await reader.locator(".item-text script,.item-text img").count(),0);await cp.locator("#close-reader").click();await cp.locator("#reader-dialog").waitFor({state:"hidden"});await creplay(false);assert.deepEqual(carrange(await csnapshot(),docBoard.boardId),carrange(documentPaste.before,docBoard.boardId));await creplay(true);
    const tooLarge="x".repeat(1000000),largeBefore=await csnapshot();start=cwrites.length;await cevent("paste",{"text/plain":tooLarge});await cp.waitForFunction(()=>document.getElementById("workspace-toast")?.textContent.includes("too large"));assert.equal(cwrites.length,start);assert.equal((await csnapshot()).revision,largeBefore.revision);assert.equal(await cp.evaluate(()=>window.qaClipboardCalls.length),0);
    await writeFile(path.join(evidence,"clipboard-receipt.json"),JSON.stringify({operations:creceipts,sameAndCrossBoard:true,narrowOversizedVisible:true,snapshotAfterSourceMove:true,repeatedPaste:true,aliases:true,boardCopy:true,invalidAtomic:true,nativeEditingGuard:true,richURL:true,oEmbedPlainMetadata:true,blockedFallback:true,documentBytes:new TextEncoder().encode(bigText).length,documentExact:true,filterReveal:true,drafts:true,stableNativeMedia:true,syntheticClipboardOnly:true,nativeOSClipboardUntested:true},null,2));await cc.close();
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    JSON.stringify({
      passed: process.env.TINKA_CLIPBOARD_ONLY ? "Clipboard events: selected snapshot paste, independent IDs/arrangement, atomic undo/redo, aliases/board copy, rich link/fallback and full document" : process.env.TINKA_HISTORY_ONLY ? "Movement history: atomic undo/redo, exact placement identity/order, navigation, canonical review/drafts, stable native previews, footer drag and context menu" : process.env.TINKA_MARQUEE_ONLY ? "Canvas marquee: zero-write selection, representative zoom/pan/narrow, stable previews and toolbar, Shift/clear/cancel, clipped bounds, metadata defer and region controls" : process.env.TINKA_MULTI_DRAG_ONLY ? "Selected group drag into collections/Parent, atomic translation, representative zoom/narrow, stable covers, single compatibility, union cycles and409 cancellation" : process.env.TINKA_DRAG_OUT_ONLY ? "Parent header drop and long-press child pullout: atomic moves, cover updates, zoom50/100/125, narrow, normal whole-group drag, cancellation and409 draft preservation" : process.env.TINKA_DRAG_BOARDS_ONLY ? "Pointer drag into board: atomic move, zoom50/100/125, narrow, stable 2-to-3 cover documents, Escape, overlap, cycle and 409 rollback" : process.env.TINKA_COVERS_ONLY ? "Automatic collection covers for 1/2/4/5 children, script-built HTML in opaque sandbox, full viewport fit, stable geometry/review/reorder mounts, targeted sibling CSS refresh, immediate grouping, explicit preview precedence, archive/remove and bounded nested-board fallbacks" : process.env.TINKA_FOCUSED_ONLY ? "Quiet header/Tools/parent routes at 390/900/1440; mounted previews across geometry/review/decorations, targeted content reload, Grid filter/reorder, attached appearance popup and targeted image refresh" :
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
