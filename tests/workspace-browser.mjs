// Focused graph UI acceptance. Uses external temporary fixtures and existing Playwright.
import assert from "node:assert/strict";
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
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + `/boards/${board.id}/`);
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(
    await page.locator("body").getAttribute("data-board-layout"),
    "canvas",
    "Unconfigured graph board defaults to Canvas",
  );
  await page.getByRole("button", { name: "Grid", exact: true }).click();
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
  await page.locator("#reader-theme").click();
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
  await page.locator("#size-trigger").click();
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
  await page.locator("[data-surface=board]").click();
  await page.waitForURL(/\/boards\//);
  await page
    .getByRole("button", { name: "Open primary content", exact: true })
    .click();
  await page.locator("#reader-dialog[open]").waitFor();
  assert.equal(await page.locator("#reader-name").textContent(), "One");
  await page.locator("#size-trigger").click();
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
    await page.locator("[data-note]").first().inputValue(),
    "Owner feedback survives",
  );
  assert.equal(
    await page.locator("[data-star]").first().getAttribute("aria-pressed"),
    "true",
  );
  const reviewAtServer = async () =>
    (await (await fetch(base + "/api/items/" + first.id)).json()).review;
  const revertBaseline = await page.locator("[data-note]").first().inputValue();
  const starBaseline = await page
    .locator("[data-star]")
    .first()
    .getAttribute("aria-pressed");
  await page
    .locator("[data-note]")
    .first()
    .fill("Draft to undo before debounce");
  await page.locator("[data-note]").first().fill(revertBaseline);
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
  await page.locator("[data-note]").first().fill("Delayed draft to undo");
  await startedReview;
  await page.locator("[data-note]").first().fill(revertBaseline);
  releaseReview();
  await page.waitForFunction(
    () =>
      document.getElementById("save-status").textContent ===
      "Item notes saved on this Mac",
  );
  assert.equal((await reviewAtServer()).note, revertBaseline);
  assert.equal(
    await page.locator("[data-note]").first().inputValue(),
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
  await page.locator("[data-note]").first().fill("Network failure draft");
  await page
    .getByRole("heading", { name: "Change not saved", exact: true })
    .waitFor();
  assert.equal(
    await page.locator("[data-note]").first().inputValue(),
    "Network failure draft",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator("#workspace-retry-drafts").click();
  await page.waitForFunction(
    () => document.getElementById("workspace-retry-drafts").hidden,
  );
  await page.unroute("**/api/operations");
  await page.reload();
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(
    await page.locator("[data-note]").first().inputValue(),
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
  await page.locator("[data-note]").first().fill("Conflict draft retained");
  await page
    .getByRole("button", { name: "Reload latest", exact: true })
    .click();
  await page.locator(".workspace-card").first().waitFor();
  assert.equal(
    await page.locator("[data-note]").first().inputValue(),
    "Conflict draft retained",
  );
  await page.unroute("**/api/operations");
  await page.locator("#workspace-retry-drafts").click();
  await page.waitForFunction(
    () => document.getElementById("workspace-retry-drafts").hidden,
  );
  await page.locator("[data-mode=canvas]").click();
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
  await page.locator("[data-geometry]").first().click();
  await page.locator("[name=x]").fill("-2000");
  await page.locator("[name=width]").fill("380");
  await page
    .getByRole("button", { name: "Save placement", exact: true })
    .click();
  await page
    .locator("dialog.workspace-dialog[open]")
    .waitFor({ state: "hidden" });
  assert.equal(
    (
      await (await fetch(base + `/api/boards/${second.boardId}`)).json()
    ).placements.find((p) => !p.removedAt).x,
    -2000,
  );
  await page
    .waitForFunction(
      () => document.querySelector(".workspace-card").style.left === "70px",
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
  await page.locator("#workspace-tools").click();
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page.locator("[name=text]").fill("Making this week");
  await page.locator("[name=x]").fill("-2500");
  await page.locator("[name=y]").fill("-1000");
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.locator(".workspace-decoration").waitFor();
  assert.equal(
    await page.locator(".workspace-decoration span").textContent(),
    "Making this week",
  );
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
  await page.locator("[data-mode=grid]").click();
  await page.locator("[data-placement-select]").first().click();
  await page.getByRole("button", { name: "Archive here", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".workspace-card").length === 0,
  );
  await page.locator("#workspace-archive").click();
  await page.locator(".workspace-card").first().waitFor();
  await page.locator("[data-placement-select]").first().click();
  await page.getByRole("button", { name: "Restore here", exact: true }).click();
  await page.locator("#workspace-archive").click();
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
  await page.getByRole("button", { name: "+ Idea", exact: true }).click();
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
  let placementWrites = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/operations") &&
      request.method() === "POST" &&
      request.postDataJSON().type === "updatePlacement"
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
    const note = page.locator("[data-note]").first();
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
    await page
      .getByRole("button", { name: "Edit", exact: true })
      .first()
      .click();
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
    await page.getByRole("button", { name: "Grid", exact: true }).click();
    await page.reload();
    await page.locator(".workspace-grid-round").waitFor();
    assert.equal(
      await page.locator("body").getAttribute("data-board-layout"),
      "grid",
    );
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await page.screenshot({
      path: path.join(evidence, `canvas-input-${width}.png`),
    });
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    JSON.stringify({
      passed:
        "Canvas default and explicit Grid persistence, mouse background no-grab, wheel/horizontal/Shift-wheel/Ctrl zoom, real touch pan and pinch, threshold body/preview drag and click, notes/controls/resize persistence at390/1440; graph reader/history/revisions/shared durable review/moved aliases/geometry/archive/mixed legacy/offline content",
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
