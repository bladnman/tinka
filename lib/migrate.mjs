// Explicit metadata-only conversion. Original manifests, notes, assets and their
// bytes stay where they were; the receipt contains exact source metadata backups.
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { loadBoard } from "./boards.mjs";
import { existingInside, isInside } from "./paths.mjs";
import { commitStore, storeError, withStore } from "./store.mjs";
import { emptyWorkspace, validateWorkspaceState } from "./workspace.mjs";
import { validateRootLocations } from "./resources.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (kind, ...parts) =>
  `legacy-${kind}-${hash(JSON.stringify(parts)).slice(0, 32)}`;
const ref = (boardId, relative) => ({
  rootId: "legacy",
  path: `${boardId}/${relative}`,
});
const stamp = () => new Date().toISOString();
function makeContent(boardId, roundId, conceptId, entry) {
  const resource =
    entry.path ||
    (!entry.url ? `rounds/${roundId}/${conceptId}/index.html` : null);
  return {
    kind: entry.kind || "html",
    ...(resource ? { resource: ref(boardId, resource) } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.startInstructions
      ? { startInstructions: entry.startInstructions }
      : {}),
  };
}
async function originals(board) {
  const files = {};
  for (const relative of [
    "board.json",
    "rounds.json",
    "build-state.json",
    ".state/notes.json",
    "AGENTS.md",
  ]) {
    try {
      // The legacy board reader intentionally blocks hidden paths. State is
      // read through a visible-safe parent containment check instead.
      let target;
      if (relative === ".state/notes.json") {
        target = await realpath(path.join(board.root, relative));
        if (!isInside(board.root, target))
          throw storeError(403, "Legacy notes leave board.");
      } else target = (await existingInside(board.root, relative)).path;
      const bytes = await readFile(target);
      files[relative] = {
        sha256: hash(bytes),
        base64: bytes.toString("base64"),
      };
    } catch (error) {
      if (error.code === "ENOENT" || error.status === 404) continue;
      throw error;
    }
  }
  return files;
}
function decodeJson(files, name, fallback) {
  try {
    return files[name]
      ? JSON.parse(Buffer.from(files[name].base64, "base64").toString("utf8"))
      : fallback;
  } catch {
    throw storeError(400, `Invalid legacy ${name}.`);
  }
}
export async function migrateLegacy(config, { dryRun = true } = {}) {
  if (typeof dryRun !== "boolean")
    throw storeError(400, "dryRun must be boolean.");
  return withStore(
    config,
    async (root, before) => {
      const state = structuredClone(before || emptyWorkspace());
      let entries;
      try {
        entries = await readdir(config.boardsRoot, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") entries = [];
        else throw error;
      }
      const report = {
        schemaVersion: 1,
        dryRun,
        boards: [],
        skipped: [],
        errors: [],
        identityMap: { boards: {}, items: {}, placements: {} },
        sourceFilesUnchanged: true,
        resourcesMoved: false,
      };
      const backups = {};
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          !/^[a-z0-9][a-z0-9-]*$/.test(entry.name) ||
          (!entry.isDirectory() && !entry.isSymbolicLink())
        )
          continue;
        const id = entry.name;
        if (state.boards[id]?.legacy?.boardId === id) {
          report.skipped.push(id);
          continue;
        }
        try {
          const board = await loadBoard(
              { ...config, boardsRoot: await realpath(config.boardsRoot) },
              id,
            ),
            files = await originals(board);
          if (Object.hasOwn(state.boards, id))
            throw storeError(
              409,
              "A graph board already uses this legacy board ID.",
            );
          const notes = decodeJson(files, ".state/notes.json", {}),
            rawBuild = decodeJson(files, "build-state.json", { concepts: {} });
          const ownerId = stable("board", id),
            owner = {
              ...board.metadata,
              schemaVersion: 2,
              id: ownerId,
              title: board.metadata.title,
              description: board.metadata.description,
              createdAt: board.metadata.createdAt,
              updatedAt: stamp(),
              childBoardId: id,
              revisions: [],
              review: { note: "", star: false, updatedAt: 0 },
              build: { state: "ready", message: "", updatedAt: 0 },
              legacy: { boardId: id, metadata: board.metadata },
            };
          if (board.metadata.cover)
            owner.preview = { resource: ref(id, board.metadata.cover) };
          if (Object.hasOwn(state.items, ownerId))
            throw storeError(
              409,
              "A canonical item already uses the legacy board owner ID.",
            );
          state.items[ownerId] = owner;
          const migrated = {
            ...board.metadata,
            schemaVersion: 2,
            id,
            ownerItemId: ownerId,
            placements: [],
            reviewOrder: [],
            rounds: structuredClone(board.manifest.rounds),
            decorations: [],
            legacy: {
              boardId: id,
              metadata: board.metadata,
              notesKey: board.metadata.legacyNotesKey,
              sourceRootId: "legacy",
            },
            updatedAt: stamp(),
          };
          report.identityMap.boards[id] = { boardId: id, itemId: ownerId };
          for (const round of board.manifest.rounds)
            for (const concept of round.concepts) {
              const key = `${round.id}/${concept.id}`,
                itemId = stable("item", id, round.id, concept.id),
                placementId = stable("placement", id, round.id, concept.id);
              if (Object.hasOwn(state.items, itemId))
                throw storeError(400, "Duplicate legacy concept ID.");
              const note = notes?.[key] || {},
                build = rawBuild?.concepts?.[key] || {
                  state: "reserved",
                  message: "Status has not been recorded yet.",
                  updatedAt: 0,
                };
              const item = {
                ...structuredClone(concept),
                schemaVersion: 2,
                id: itemId,
                title: concept.name || concept.id,
                description: concept.description || "",
                createdAt: round.createdAt || board.metadata.createdAt,
                updatedAt: stamp(),
                content: makeContent(id, round.id, concept.id, concept),
                revisions: (board.manifest.revisions[key] || []).map(
                  (variant, index) => ({
                    ...structuredClone(variant),
                    id: variant.id || `version-${index + 1}`,
                    content: makeContent(id, round.id, concept.id, {
                      ...concept,
                      ...variant,
                      kind: variant.kind || concept.kind || "html",
                      path:
                        variant.path ||
                        concept.path ||
                        `rounds/${round.id}/${concept.id}/index.html`,
                      // Legacy revisions inherit the original kind/path, but
                      // only an explicitly supplied revision URL is opened.
                      url: variant.url || undefined,
                    }),
                    legacy: {
                      boardId: id,
                      parentKey: key,
                      index,
                      ...structuredClone(variant),
                    },
                  }),
                ),
                review: {
                  ...structuredClone(note),
                  note:
                    typeof note.note === "string"
                      ? note.note
                      : String(note.note || ""),
                  star: !!note.star,
                  updatedAt: note.updatedAt ?? 0,
                },
                build: { ...structuredClone(build) },
                legacy: {
                  boardId: id,
                  roundId: round.id,
                  conceptId: concept.id,
                  key,
                  number: concept.number,
                  roundNumber: round.number,
                  sourceRootId: "legacy",
                },
              };
              if (concept.handoff)
                item.resources = [
                  { role: "handoff", resource: ref(id, concept.handoff) },
                ];
              state.items[itemId] = item;
              const index = migrated.placements.length;
              migrated.placements.push({
                id: placementId,
                itemId,
                x: (index % 4) * 360,
                y: Math.floor(index / 4) * 300,
                width: 320,
                height: 240,
                z: index,
                roundId: round.id,
              });
              migrated.reviewOrder.push(placementId);
              report.identityMap.items[`${id}/${key}`] = itemId;
              report.identityMap.placements[`${id}/${key}`] = placementId;
            }
          state.boards[id] = migrated;
          state.metadata.homeBoardIds.push(id);
          backups[id] = {
            files,
            notes,
            build: rawBuild,
            manifest: board.manifest,
            metadata: board.metadata,
          };
          report.boards.push({
            id,
            title: migrated.title,
            itemCount: migrated.placements.length,
            revisionCount: Object.values(board.manifest.revisions).reduce(
              (sum, variants) => sum + variants.length,
              0,
            ),
          });
        } catch (error) {
          if (error.status === 404) continue;
          report.errors.push({ id, message: error.message });
        }
      }
      if (!report.boards.length && before && !report.errors.length)
        return { ...report, revision: state.metadata.revision };
      const legacyPath =
        path
          .relative(
            path.resolve(
              config.workspaceRoot || path.join(config.boardsRoot, ".tinka"),
            ),
            path.resolve(config.boardsRoot),
          )
          .split(path.sep)
          .join("/") || ".";
      if (
        state.metadata.resourceRoots.legacy &&
        state.metadata.resourceRoots.legacy.path !== legacyPath
      )
        report.errors.push({
          id: "legacy",
          message: "The legacy resource root is already registered elsewhere.",
        });
      state.metadata.resourceRoots.legacy = { path: legacyPath };
      try {
        validateWorkspaceState(state);
        await validateRootLocations(config, state.metadata.resourceRoots);
      } catch (error) {
        report.errors.push({ id: "workspace", message: error.message });
      }
      if (dryRun) return { ...report, revision: state.metadata.revision };
      if (report.errors.length)
        throw Object.assign(
          storeError(
            409,
            "Legacy migration needs attention; no conversion was committed.",
          ),
          { report },
        );
      const receiptId = `migration-${hash(JSON.stringify(report.identityMap)).slice(0, 32)}`;
      state.metadata.revision++;
      state.metadata.updatedAt = stamp();
      const receipt = {
        ...report,
        dryRun: false,
        id: receiptId,
        createdAt: stamp(),
        revision: state.metadata.revision,
        backups,
      };
      await commitStore(root, before, state, [
        { path: `migrations/${receiptId}.json`, value: receipt },
      ]);
      return {
        ...report,
        dryRun: false,
        receiptId,
        receiptPath: path.join(root, "migrations", `${receiptId}.json`),
        revision: state.metadata.revision,
      };
    },
    { create: !dryRun },
  );
}
