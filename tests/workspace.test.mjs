import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyOperation,
  readWorkspace,
  getBoardSnapshot,
} from "../lib/workspace.mjs";
import { migrateLegacy } from "../lib/migrate.mjs";
import { resolveResource, resourceUrl } from "../lib/resources.mjs";

async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "tinka-workspace-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { boardsRoot: path.join(directory, "boards") };
  await mkdir(config.boardsRoot);
  return { directory, config, root: path.join(config.boardsRoot, ".tinka") };
}
const operation = async (config, type, fields = {}) =>
  (await applyOperation(config, { type, ...fields })).result;
const board = async (config, title = "Ideas") =>
  operation(config, "createBoard", { title });

test("content remains primary when children are attached; move/reference share canonical review", async (t) => {
  const { config } = await fixture(t),
    a = await board(config),
    b = await board(config, "Production");
  const item = await operation(config, "createItem", {
    boardId: a.boardId,
    item: {
      title: "Movie",
      content: { kind: "url", url: "https://example.com/video" },
      description: "A film",
    },
  });
  const child = await operation(config, "createBoard", {
    itemId: item.itemId,
    title: "Related notes",
  });
  await operation(config, "createItem", {
    boardId: child.boardId,
    item: {
      title: "Note",
      content: { kind: "text", text: "Keep the original content." },
    },
  });
  await operation(config, "reference", {
    sourceBoardId: a.boardId,
    placementIds: item.placementIds,
    targetBoardId: b.boardId,
  });
  await operation(config, "review", {
    itemId: item.itemId,
    patch: { note: "One canonical note", star: true },
  });
  const snap = await getBoardSnapshot(config, b.boardId);
  assert.equal(
    snap.items[item.itemId].content.url,
    "https://example.com/video",
  );
  assert.equal(snap.items[item.itemId].childBoardId, child.boardId);
  assert.equal(snap.items[item.itemId].review.note, "One canonical note");
  await operation(config, "archive", {
    boardId: a.boardId,
    placementIds: item.placementIds,
    archived: true,
  });
  assert.ok(
    (await getBoardSnapshot(config, a.boardId)).placements[0].archivedAt,
  );
  assert.equal(
    (await getBoardSnapshot(config, b.boardId)).placements[0].archivedAt,
    undefined,
  );
  const moved = await operation(config, "move", {
    sourceBoardId: a.boardId,
    placementIds: item.placementIds,
    newBoard: { title: "Moved" },
  });
  assert.ok(
    (await getBoardSnapshot(config, a.boardId)).placements[0].removedAt,
  );
  assert.equal(
    (await getBoardSnapshot(config, moved.boardId)).placements[0].itemId,
    item.itemId,
  );
});

test("board ownership home move and reference are explicit; all ancestor cycles reject atomically", async (t) => {
  const { config } = await fixture(t),
    a = await board(config, "A"),
    b = await board(config, "B");
  await operation(config, "reference", {
    itemIds: [b.itemId],
    targetBoardId: a.boardId,
  });
  let state = await readWorkspace(config);
  assert.ok(state.homeBoardIds.includes(b.boardId));
  const revision = state.revision;
  await assert.rejects(
    () =>
      operation(config, "reference", {
        itemIds: [a.itemId, b.itemId],
        targetBoardId: b.boardId,
      }),
    { status: 409 },
  );
  state = await readWorkspace(config);
  assert.equal(state.revision, revision);
  assert.equal(
    state.boards.find((v) => v.id === b.boardId).placements.length,
    0,
  );
  await operation(config, "move", {
    itemIds: [b.itemId],
    targetBoardId: a.boardId,
  });
  assert.ok(!(await readWorkspace(config)).homeBoardIds.includes(b.boardId));
  await operation(config, "move", {
    sourceBoardId: a.boardId,
    itemIds: [b.itemId],
  });
  assert.ok((await readWorkspace(config)).homeBoardIds.includes(b.boardId));
});

test("stale revision and operation id replay do not write another version", async (t) => {
  const { config } = await fixture(t);
  const first = await applyOperation(config, {
    type: "createBoard",
    title: "First",
    operationId: "first",
    expectedRevision: 0,
  });
  const replay = await applyOperation(config, {
    type: "createBoard",
    title: "First",
    operationId: "first",
    expectedRevision: 0,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, first.revision);
  await assert.rejects(
    () =>
      applyOperation(config, {
        type: "createBoard",
        title: "Different",
        operationId: "first",
      }),
    { status: 409 },
  );
  await assert.rejects(
    () =>
      applyOperation(config, {
        type: "createBoard",
        title: "Other",
        expectedRevision: 0,
      }),
    { status: 409 },
  );
  assert.equal((await readWorkspace(config)).boards.length, 1);
});

test("safe named resources survive duplicate/removal; traversal, symlink escapes and private roots fail", async (t) => {
  const { config, directory } = await fixture(t);
  await mkdir(path.join(config.boardsRoot, "assets"));
  const asset = path.join(config.boardsRoot, "assets", "clip.mp4");
  await writeFile(asset, "movie bytes");
  await operation(config, "updateWorkspace", {
    patch: { resourceRoots: { project: { path: ".." } } },
  });
  const a = await board(config),
    item = await operation(config, "createItem", {
      boardId: a.boardId,
      item: {
        title: "Clip",
        content: {
          kind: "video",
          resource: { rootId: "project", path: "assets/clip.mp4" },
        },
      },
    });
  const copy = await operation(config, "duplicate", {
    itemId: item.itemId,
    targetBoardId: a.boardId,
  });
  const snapshot = await getBoardSnapshot(config, a.boardId);
  assert.deepEqual(
    snapshot.items[copy.itemId].content,
    snapshot.items[item.itemId].content,
  );
  await operation(config, "deleteItem", { itemIds: [item.itemId] });
  assert.equal(await readFile(asset, "utf8"), "movie bytes");
  assert.equal(
    (
      await resolveResource(config, {
        rootId: "project",
        path: "assets/clip.mp4",
      })
    ).path,
    asset,
  );
  await writeFile(path.join(directory, "secret"), "secret");
  await symlink(
    path.join(directory, "secret"),
    path.join(config.boardsRoot, "assets", "escape"),
  );
  await assert.rejects(
    () => resolveResource(config, { rootId: "project", path: "assets/escape" }),
    { status: 403 },
  );
  await writeFile(path.join(config.boardsRoot, ".private"), "hidden");
  await symlink(
    path.join(config.boardsRoot, ".private"),
    path.join(config.boardsRoot, "assets", "hidden-alias"),
  );
  await assert.rejects(
    () =>
      resolveResource(config, {
        rootId: "project",
        path: "assets/hidden-alias",
      }),
    { status: 403 },
  );
  for (const value of [
    "../secret",
    "assets/%2e%2e/secret",
    "assets/.hidden",
    "/etc/passwd",
    "assets\\escape",
  ])
    await assert.rejects(() =>
      resolveResource(config, { rootId: "project", path: value }),
    );
  await assert.rejects(
    () =>
      operation(config, "updateWorkspace", {
        patch: { resourceRoots: { metadata: { path: "." } } },
      }),
    { status: 403 },
  );
  assert.equal(
    resourceUrl({ rootId: "project", path: "assets/a b.mp4" }),
    "/resources/project/assets/a%20b.mp4",
  );
});

test("interrupted multi-document journal rolls forward before a reader sees data", async (t) => {
  const { config, root } = await fixture(t),
    a = await board(config);
  const current = await readWorkspace(config);
  const item = current.items.find((value) => value.id === a.itemId);
  const metadata = JSON.parse(
    await readFile(path.join(root, "workspace.json"), "utf8"),
  );
  const next = { ...item, title: "Recovered title" };
  metadata.revision++;
  await writeFile(
    path.join(root, "items", `${item.id}.json`),
    JSON.stringify(next),
  );
  await writeFile(
    path.join(root, "pending.json"),
    JSON.stringify({
      schemaVersion: 1,
      writes: [
        { path: `items/${item.id}.json`, value: next },
        { path: "workspace.json", value: metadata },
      ],
    }),
  );
  const recovered = await readWorkspace(config);
  assert.equal(recovered.revision, metadata.revision);
  assert.equal(
    recovered.items.find((value) => value.id === item.id).title,
    "Recovered title",
  );
  assert.ok(!(await readdir(root)).includes("pending.json"));
});

test("resource resolution reads only the recovered workspace header, not unrelated catalog documents", async (t) => {
  const { config, root } = await fixture(t);
  await operation(config, "updateWorkspace", {
    patch: { resourceRoots: { project: { path: ".." } } },
  });
  await board(config);
  await writeFile(path.join(config.boardsRoot, "asset.txt"), "resource bytes");
  await writeFile(
    path.join(root, "items", "unrelated.json"),
    "invalid unrelated JSON",
  );
  const metadata = JSON.parse(
    await readFile(path.join(root, "workspace.json"), "utf8"),
  );
  metadata.revision++;
  metadata.resourceRoots.recovered = { path: ".." };
  await writeFile(
    path.join(root, "pending.json"),
    JSON.stringify({
      schemaVersion: 1,
      writes: [{ path: "workspace.json", value: metadata }],
    }),
  );
  const resolved = await resolveResource(config, {
    rootId: "recovered",
    path: "asset.txt",
  });
  assert.equal(await readFile(resolved.path, "utf8"), "resource bytes");
  assert.ok(!(await readdir(root)).includes("pending.json"));
  assert.equal(
    JSON.parse(await readFile(path.join(root, "workspace.json"), "utf8"))
      .revision,
    metadata.revision,
  );
  await assert.rejects(() => readWorkspace(config), SyntaxError);
  await writeFile(
    path.join(root, "workspace.json"),
    JSON.stringify({ ...metadata, schemaVersion: 99 }),
  );
  await assert.rejects(
    () => resolveResource(config, { rootId: "recovered", path: "asset.txt" }),
    { status: 500 },
  );
});

test("competing stale lock reclaimers never remove live successor; concurrent updates serialize", async (t) => {
  const { config, root } = await fixture(t);
  await board(config);
  await mkdir(path.join(root, ".mutation-lock"));
  await writeFile(
    path.join(root, ".mutation-lock", "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "dead-owner" }),
  );
  const modulePath = fileURLToPath(
    new URL("../lib/workspace.mjs", import.meta.url),
  );
  const run = (index) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {applyOperation} from ${JSON.stringify(new URL(`file://${modulePath}`).href)}; await applyOperation(${JSON.stringify(config)}, {type:'createItem',item:{title:'Concurrent ${index}'}});`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (data) => (stderr += data));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
    });
  await Promise.all(Array.from({ length: 8 }, (_, index) => run(index)));
  const state = await readWorkspace(config);
  assert.equal(state.revision, 9);
  assert.equal(state.items.length, 9);
});

test("legacy migration preserves original bytes, custom revision paths, orphan notes and build history", async (t) => {
  const { config, root } = await fixture(t),
    legacy = path.join(config.boardsRoot, "ideas");
  await mkdir(path.join(legacy, ".state"), { recursive: true });
  const originals = {
    "board.json": {
      schemaVersion: 1,
      title: "Ideas",
      description: "Legacy",
      createdAt: "2026-01-01",
      legacyNotesKey: "old-notes",
      cover: "assets/cover.svg",
    },
    "rounds.json": {
      rounds: [
        {
          id: "round-1",
          number: "07",
          title: "Earlier round",
          concepts: [
            {
              id: "alpha",
              number: "12",
              name: "Alpha",
              description: "First",
              path: "custom/alpha.html",
              kind: "image",
              dependencies: ["shared"],
              handoff: "custom/README.md",
            },
          ],
        },
      ],
      revisions: {
        "round-1/alpha": [
          {
            id: "second",
            name: "Cross concept",
            path: "rounds/round-1/beta/index.html",
          },
          { id: "inherited", name: "Same entry point" },
        ],
        "round-1/orphan": [{ id: "kept", path: "orphan.html" }],
      },
    },
    "build-state.json": {
      concepts: {
        "round-1/alpha": {
          state: "ready",
          message: "Accepted",
          updatedAt: 1,
          history: [{ state: "building" }],
        },
        "round-1/orphan": { state: "review", message: "Keep this" },
      },
    },
    ".state/notes.json": {
      "round-1/alpha": {
        note: "  exact note \n",
        star: true,
        updatedAt: 12,
        extra: "keep",
      },
      "round-1/orphan": { note: "Orphan note", star: true },
      unexpected: { note: "Raw extra" },
    },
  };
  const bytes = {};
  for (const [file, value] of Object.entries(originals)) {
    bytes[file] = `${JSON.stringify(value, null, 3)}\n`;
    await writeFile(path.join(legacy, file), bytes[file]);
  }
  const dry = await migrateLegacy(config);
  assert.equal(dry.boards.length, 1);
  assert.equal(await readWorkspace(config), null);
  const result = await migrateLegacy(config, { dryRun: false });
  assert.equal(result.errors.length, 0);
  const state = await readWorkspace(config),
    item = state.items.find((value) => value.legacy?.conceptId === "alpha");
  assert.equal(item.legacy.number, "12");
  assert.equal(item.review.note, "  exact note \n");
  assert.equal(item.review.star, true);
  assert.deepEqual(item.build.history, [{ state: "building" }]);
  assert.equal(item.revisions[0].id, "second");
  assert.equal(item.revisions[0].content.kind, "image");
  assert.equal(
    item.revisions[1].content.resource.path,
    "ideas/custom/alpha.html",
  );
  assert.equal(
    item.revisions[0].content.resource.path,
    "ideas/rounds/round-1/beta/index.html",
  );
  for (const [file, value] of Object.entries(bytes))
    assert.equal(await readFile(path.join(legacy, file), "utf8"), value);
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.equal(
    receipt.backups.ideas.notes["round-1/orphan"].note,
    "Orphan note",
  );
  assert.equal(
    receipt.backups.ideas.manifest.revisions["round-1/orphan"][0].id,
    "kept",
  );
  assert.equal(
    Buffer.from(
      receipt.backups.ideas.files[".state/notes.json"].base64,
      "base64",
    ).toString(),
    bytes[".state/notes.json"],
  );
  const again = await migrateLegacy(config, { dryRun: false });
  assert.deepEqual(again.skipped, ["ideas"]);
  assert.equal((await readWorkspace(config)).revision, state.revision);
  assert.ok((await readdir(path.join(root, "migrations"))).length === 1);
});

test("invalid content and geometry are rejected without changing metadata revision", async (t) => {
  const { config } = await fixture(t),
    a = await board(config),
    item = await operation(config, "createItem", {
      boardId: a.boardId,
      item: { title: "Text only" },
    });
  const revision = (await readWorkspace(config)).revision;
  await assert.rejects(
    () =>
      operation(config, "updateItem", {
        itemId: item.itemId,
        patch: { content: { kind: "url", url: "javascript:alert(1)" } },
      }),
    { status: 400 },
  );
  await assert.rejects(
    () =>
      operation(config, "updatePlacement", {
        boardId: a.boardId,
        placementId: item.placementIds[0],
        patch: { width: 0 },
      }),
    { status: 400 },
  );
  assert.equal((await readWorkspace(config)).revision, revision);
});

test("attaching children twice rejects; board duplicates preserve review order with independent placement IDs", async (t) => {
  const { config } = await fixture(t);
  const parent = await board(config);
  const first = await operation(config, "createItem", {
    boardId: parent.boardId,
    item: {
      title: "First",
      content: { kind: "text", text: "Primary content" },
    },
  });
  const second = await operation(config, "createItem", {
    boardId: parent.boardId,
    item: { title: "Second" },
  });
  await operation(config, "createBoard", {
    itemId: first.itemId,
    title: "Children",
  });
  await assert.rejects(
    () =>
      operation(config, "createBoard", {
        itemId: first.itemId,
        title: "Replacement",
      }),
    { status: 409 },
  );
  await operation(config, "updateBoard", {
    boardId: parent.boardId,
    patch: { reviewOrder: [second.placementIds[0], first.placementIds[0]] },
  });
  const duplicate = await operation(config, "duplicate", {
    itemId: parent.itemId,
  });
  const snapshot = await getBoardSnapshot(config, duplicate.childBoardId);
  assert.equal(
    snapshot.placements.find((p) => p.id === snapshot.reviewOrder[0]).itemId,
    second.itemId,
  );
  assert.ok(
    snapshot.placements.every(
      (p) => ![...first.placementIds, ...second.placementIds].includes(p.id),
    ),
  );
  assert.equal(snapshot.items[first.itemId].content.text, "Primary content");
  await operation(config, "deleteItem", { itemIds: [parent.itemId] });
  assert.equal(await getBoardSnapshot(config, parent.boardId), null);
  assert.ok(await getBoardSnapshot(config, duplicate.childBoardId));
});

test("global archive changes only canonical metadata; empty migration initializes explicitly", async (t) => {
  const { config, root } = await fixture(t);
  const result = await migrateLegacy(config, { dryRun: false });
  assert.equal(result.revision, 1);
  assert.equal((await readWorkspace(config)).boards.length, 0);
  const a = await board(config);
  const before = await readFile(
    path.join(root, "boards", `${a.boardId}.json`),
    "utf8",
  );
  await operation(config, "archiveItem", {
    itemIds: [a.itemId],
    archived: true,
  });
  assert.equal(
    await readFile(path.join(root, "boards", `${a.boardId}.json`), "utf8"),
    before,
  );
  assert.ok(
    (await readWorkspace(config)).items.find((item) => item.id === a.itemId)
      .archivedAt,
  );
});

test("board creation retains the supplied description on the board and new owner item", async (t) => {
  const { config } = await fixture(t);
  const created = await operation(config, "createBoard", {
    title: "Ideas",
    description: "A durable board description.",
  });
  const snapshot = await getBoardSnapshot(config, created.boardId);
  assert.deepEqual(
    [snapshot.description, snapshot.items[created.itemId].description],
    ["A durable board description.", "A durable board description."],
  );
});

test("grouping creates a child board and moves selected items in one idempotent transaction", async (t) => {
  const { config } = await fixture(t);
  const source = await board(config, "Source");
  const selected = await operation(config, "createItem", {
    boardId: source.boardId,
    item: { title: "Grouped item" },
  });
  const revision = (await readWorkspace(config)).revision;
  const input = {
    type: "move",
    sourceBoardId: source.boardId,
    placementIds: selected.placementIds,
    newBoard: {
      id: "grouped-board",
      title: "Group",
      parentBoardId: source.boardId,
    },
    operationId: "group-once",
    expectedRevision: revision,
  };
  const response = await applyOperation(config, input);
  assert.equal(response.revision, revision + 1);
  assert.equal(response.result.boardId, "grouped-board");
  const child = await getBoardSnapshot(config, response.result.boardId);
  const parent = await getBoardSnapshot(config, source.boardId);
  assert.deepEqual(
    child.placements.map((p) => p.itemId),
    [selected.itemId],
  );
  assert.deepEqual(
    parent.placements
      .filter((p) => !p.removedAt && !p.deletedAt)
      .map((p) => p.itemId),
    [child.ownerItemId],
  );
  assert.ok(!(await readWorkspace(config)).homeBoardIds.includes(child.id));
  const replay = await applyOperation(config, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, revision + 1);
  assert.equal((await readWorkspace(config)).revision, revision + 1);
});

test("board decoration and background values are bounded and validated before commit", async (t) => {
  const { config } = await fixture(t);
  const a = await board(config);
  await operation(config, "updateBoard", {
    boardId: a.boardId,
    patch: {
      background: { color: "#fff" },
      decorations: [
        {
          id: "line-1",
          type: "line",
          x: 0,
          y: 100,
          width: 300,
          height: 2,
          color: "#aabbcc",
          text: "",
        },
      ],
    },
  });
  const revision = (await readWorkspace(config)).revision;
  await assert.rejects(
    () =>
      operation(config, "updateBoard", {
        boardId: a.boardId,
        patch: {
          decorations: [
            {
              id: "unsafe",
              type: "iframe",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              color: "#fff",
              text: "",
            },
          ],
        },
      }),
    { status: 400 },
  );
  await assert.rejects(
    () =>
      operation(config, "updateBoard", {
        boardId: a.boardId,
        patch: { background: { color: "url(javascript:alert(1))" } },
      }),
    { status: 400 },
  );
  assert.equal((await readWorkspace(config)).revision, revision);
});

test("existing destination assigns available board-local positions; new-board move keeps relative geometry", async (t) => {
  const { config } = await fixture(t);
  const a = await board(config, "Source"),
    b = await board(config, "Destination");
  const source = await operation(config, "createItem", {
    boardId: a.boardId,
    item: { title: "Source item" },
    placement: { x: 1000, y: 2000, width: 400, height: 300 },
  });
  const existing = await operation(config, "createItem", {
    boardId: b.boardId,
    item: { title: "Existing" },
  });
  const copied = await operation(config, "reference", {
    sourceBoardId: a.boardId,
    placementIds: source.placementIds,
    targetBoardId: b.boardId,
  });
  const placement = (await getBoardSnapshot(config, b.boardId)).placements.find(
    (p) => p.id === copied.placementIds[0],
  );
  assert.equal(placement.x, 360);
  assert.equal(placement.y, 0);
  assert.equal(placement.width, 400);
  assert.equal(placement.height, 300);
  await operation(config, "updatePlacement", {
    boardId: b.boardId,
    placementId: existing.placementIds[0],
    patch: { width: 1000, height: 600 },
  });
  const further = await operation(config, "reference", {
    sourceBoardId: a.boardId,
    placementIds: source.placementIds,
    targetBoardId: b.boardId,
  });
  const nonoverlap = (
    await getBoardSnapshot(config, b.boardId)
  ).placements.find((p) => p.id === further.placementIds[0]);
  assert.ok(nonoverlap.x >= 1040);
  const moved = await operation(config, "move", {
    sourceBoardId: a.boardId,
    placementIds: source.placementIds,
    newBoard: { title: "Retained layout" },
  });
  const preserved = (await getBoardSnapshot(config, moved.boardId))
    .placements[0];
  assert.equal(preserved.x, 1000);
  assert.equal(preserved.y, 2000);
});

test("panel presentation is validated and local while references share canonical review", async (t) => {
  const {config} = await fixture(t);
  const a = await board(config, "Designs"), b = await board(config, "Cards");
  const presentation = {mode:"panel",viewport:{width:360,height:650}};
  const created = await operation(config,"createItem",{boardId:a.boardId,
    item:{title:"Full design"},placement:{width:362,height:696,presentation}});
  const referenced = await operation(config,"reference",{itemIds:[created.itemId],targetBoardId:b.boardId});
  const local = (await getBoardSnapshot(config,a.boardId)).placements[0];
  assert.deepEqual(local.presentation,presentation);
  assert.equal((await getBoardSnapshot(config,b.boardId)).placements[0].presentation,undefined);
  await operation(config,"review",{itemId:created.itemId,patch:{note:"Compare at natural size",star:true}});
  assert.equal((await getBoardSnapshot(config,b.boardId)).items[created.itemId].review.star,true);
  await operation(config,"updatePlacement",{boardId:b.boardId,placementId:referenced.placementIds[0],patch:{presentation:{mode:"card"}}});
  assert.deepEqual((await getBoardSnapshot(config,a.boardId)).placements[0].presentation,presentation);
  const revision=(await readWorkspace(config)).revision;
  for(const invalid of [{mode:"icon"},{mode:"panel",viewport:{width:0,height:650}},
    {mode:"panel",viewport:{width:360.5,height:650}},{mode:"panel",viewport:{width:360,height:650,src:"x"}}]) {
    await assert.rejects(()=>operation(config,"updatePlacement",{boardId:a.boardId,placementId:local.id,patch:{presentation:invalid}}),{status:400});
  }
  assert.equal((await readWorkspace(config)).revision,revision);
  const copied=await operation(config,"reference",{sourceBoardId:a.boardId,placementIds:[local.id],targetBoardId:b.boardId});
  assert.deepEqual((await getBoardSnapshot(config,b.boardId)).placements.find(p=>p.id===copied.placementIds[0]).presentation,presentation);
});
