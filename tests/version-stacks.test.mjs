import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../cli.mjs";
import { loadConfig } from "../lib/config.mjs";
import { applyOperation } from "../lib/workspace.mjs";
import { closeAppServer, listen } from "../server.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinka-version-stack-"));
  const configPath = path.join(root, "config.json");
  const boards = path.join(root, "boards");
  const assets = path.join(root, "assets");
  const designs = path.join(assets, "designs");
  const asset = name => path.join(designs, name);
  await mkdir(designs, { recursive: true });
  await main(["init", "--config", configPath, "--boards", boards, "--label", "Version stack fixture"]);
  await main(["workspace", "init", "--config", configPath, "--apply"]);
  const config = await loadConfig(configPath);
  const op = operation => applyOperation(config, operation);
  await op({ type: "createBoard", id: "ideas", title: "Ideas" });
  await op({ type: "updateWorkspace", patch: {
    resourceRoots: { assets: { path: path.relative(config.workspaceRoot, assets) } },
  } });
  const server = await listen(config, { port: 0 });
  t.after(async () => {
    await closeAppServer(server);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async route => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { root, config, asset, op, base, get };
}

const html = path => ({ kind: "html", resource: { rootId: "assets", path } });
const page = version => `<link rel="stylesheet" href="design.css"><h1>Design ${version}</h1>`;

test("targeted reads project exact numeric HTML siblings and preserve canonical content", async t => {
  const f = await fixture(t);
  for (const name of ["Design-v02.html", "Design-v2.html", "Design-v10.html", "Design-v8.html", "Design-v08.html",
    "Design-v5.htm", "Design-copy-v6.html", "Design-V7.html", "Design-v00.html", "design-v4.html", "Design-v11.HTML"])
    await writeFile(f.asset(name), page(name));
  await writeFile(f.asset("design.css"), "h1 { color: navy; }");
  await mkdir(f.asset("Design-v20.html"));
  await writeFile(path.join(f.root, "outside.html"), "outside");
  await symlink(path.join(f.root, "outside.html"), f.asset("Design-v21.html"));
  await symlink(f.asset("Design-v10.html"), f.asset("Design-v22.html"));
  await symlink(f.asset("."), f.asset("../alias"));
  const stamp = new Date("2024-03-10T05:30:00Z");
  await utimes(f.asset("Design-v10.html"), stamp, stamp);

  const content = { ...html("designs/Design-v02.html"), openMode: "inline" };
  const revisions = [{ id: "file-v2", name: "Manual comparison", content: html("designs/Design-v5.htm") }];
  const { result } = await f.op({ type: "createItem", boardId: "ideas", item: {
    id: "design", title: "Design", content, revisions, review: { note: "Existing review", star: true },
  } });
  await f.op({ type: "createItem", boardId: "ideas", item: { id: "alias", title: "Alias", content: html("alias/Design-v02.html") } });
  await f.op({ type: "createItem", boardId: "ideas", item: { id: "htm", title: "HTM", content: html("designs/Design-v5.htm") } });
  const metadataPath = path.join(f.config.workspaceRoot, "items", "design.json");
  const original = await readFile(metadataPath);
  const board = await f.get("/api/boards/ideas");
  const item = board.items.design;
  const aVersion = item.versionStack.versions[0];
  assert.deepEqual(item.versionStack.versions.map(({ id, name, version }) => ({ id, name, version })), [
    { id: "file-v2-auto", name: "V02", version: 2 },
    { id: "file-v10", name: "V10", version: 10 },
  ]);
  assert.equal(item.versionStack.defaultId, "file-v10");
  assert.deepEqual(aVersion.content, content);
  assert.equal(item.versionStack.versions[1].modifiedAt, stamp.toISOString());
  assert.match(aVersion.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(board.items.alias.versionStack, undefined);
  assert.equal(board.items.htm.versionStack, undefined);
  assert.deepEqual(item.content, content);
  assert.deepEqual(item.revisions, revisions);
  assert.equal(item.review.note, "Existing review");
  assert.deepEqual(await f.get("/api/items/design"), item);
  assert.equal((await f.get("/api/workspace?covers=0")).items.find(entry => entry.id === "design").versionStack, undefined);
  assert.deepEqual(await readFile(metadataPath), original);

  const endpoint = version => `/resources/assets/designs/Design-v${version}.html`;
  const places = version => f.get(`/api/resource-places?url=${encodeURIComponent(endpoint(version))}`);
  assert.equal((await places("02")).places.find(place => place.itemId === "design").href,
    `/boards/ideas/#items/${result.placementIds[0]}~file-v2-auto`);
  assert.equal((await places("10")).places.find(place => place.itemId === "design").href,
    `/boards/ideas/#items/${result.placementIds[0]}~file-v10`);
  assert.equal(await (await fetch(f.base + endpoint("10"))).text(), page("Design-v10.html"));
  assert.equal(await (await fetch(f.base + new URL("design.css", f.base + endpoint("10")).pathname)).text(), "h1 { color: navy; }");
  assert.equal((await fetch(f.base + endpoint("21"))).status, 403);

  const clipboard = {
    version: 1, workspaceId: board.workspaceId,
    items: { design: item }, placements: board.placements.filter(placement => placement.itemId === "design"), boards: {},
  };
  const copiedResult = await f.op({ type: "pastePlacements", targetBoardId: "ideas", targetPosition: { x: 100, y: 100 }, clipboard });
  const copiedId = copiedResult.result.itemIds[0];
  const copied = JSON.parse(await readFile(path.join(f.config.workspaceRoot, "items", `${copiedId}.json`), "utf8"));
  assert.equal(copied.versionStack, undefined);
  assert.deepEqual((await f.get(`/api/items/${copiedId}`)).versionStack, item.versionStack);
});

async function snapshots(f, signal) {
  const response = await fetch(f.base + `/api/events?workspace=${f.config.workspaceId}&board=ideas`, { signal });
  assert.equal(response.status, 200);
  const decoder = new TextDecoder();
  let buffer = "";
  return (async function* () {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (/^event: snapshot$/m.test(frame)) yield JSON.parse(/^data: (.+)$/m.exec(frame)[1]);
      }
    }
  })();
}

async function nextSnapshot(events, matches = () => true) {
  while (true) {
    const { value, done } = await events.next();
    assert.equal(done, false, "Live stream ended before the expected snapshot");
    if (matches(value)) return value;
  }
}

test("later siblings and removal reconcile on a live board with the same graph revision", async t => {
  const f = await fixture(t);
  await writeFile(f.asset("Story-v01.html"), page(1));
  await writeFile(f.asset("design.css"), "h1 { color: navy; }");
  const { result } = await f.op({ type: "createItem", boardId: "ideas", item: {
    id: "story", title: "Story", content: html("designs/Story-v01.html"),
  } });
  const controller = new AbortController();
  const events = await snapshots(f, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
  try {
    const first = await nextSnapshot(events);
    assert.deepEqual(Object.keys(first.items.story.versionRevisions), ["file-v1"]);
    const originalItem = await f.get("/api/items/story");
    await writeFile(f.asset("Story-v03.html"), page(3));
    const value = await nextSnapshot(events, snapshot => snapshot.items.story.versionRevisions?.["file-v3"]);
    assert.notEqual(value.versionStackRevision, first.versionStackRevision);
    assert.equal(value.manifestRevision, first.manifestRevision);
    assert.equal(value.items.story.versionRevisions["file-v1"], first.items.story.versionRevisions["file-v1"]);
    const board = await f.get("/api/boards/ideas");
    assert.equal(board.placements[0].id, result.placementIds[0]);
    assert.equal(board.items.story.versionStack.defaultId, "file-v3");
    assert.equal(board.items.story.versionStack.versions[0].sourceRevision, originalItem.versionStack.versions[0].sourceRevision);

    await rm(f.asset("Story-v01.html"));
    const removal = await nextSnapshot(events, snapshot => !snapshot.items.story.versionRevisions?.["file-v1"]);
    assert.equal(removal.manifestRevision, first.manifestRevision);
    const remaining = await f.get("/api/items/story");
    assert.deepEqual(remaining.versionStack.versions.map(entry => entry.version), [3]);
    assert.equal(remaining.content.resource.path, "designs/Story-v01.html");

    await writeFile(f.asset("design.css"), "h1 { color: teal; }");
    const assetEdit = await nextSnapshot(events, snapshot =>
      snapshot.items.story.versionRevisions["file-v3"] !== removal.items.story.versionRevisions["file-v3"]);
    assert.equal(assetEdit.manifestRevision, first.manifestRevision);
    assert.equal(assetEdit.versionStackRevision, removal.versionStackRevision);
  } finally {
    controller.abort();
    try { await events.return(); } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }
});
