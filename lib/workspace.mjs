import { randomUUID, createHash } from "node:crypto";
import { assertId, commitStore, storeError, withStore } from "./store.mjs";
import {
  validateResource,
  validateResourceRoots,
  validateRootLocations,
} from "./resources.mjs";

const kinds = new Set([
  "html",
  "image",
  "markdown",
  "video",
  "pdf",
  "url",
  "text",
  "note",
  "audio",
  "file",
]);
const states = new Set([
  "reserved",
  "building",
  "review",
  "ready",
  "complete",
  "blocked",
  "draft",
]);
const now = () => new Date().toISOString();
const fresh = (prefix) => `${prefix}-${randomUUID()}`;
const clone = (value) => structuredClone(value);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function requireObject(value, label) {
  if (!object(value)) throw storeError(400, `Expected ${label} object.`);
  return value;
}
function text(value, label, max = 20000) {
  if (typeof value !== "string" || value.length > max)
    throw storeError(400, `Invalid ${label}.`);
  return value;
}
function title(value) {
  text(value, "title", 1000);
  if (!value.trim()) throw storeError(400, "Title is required.");
  return value;
}
function url(value) {
  text(value, "URL", 8192);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw storeError(400, "Invalid URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw storeError(
      400,
      "Only HTTP(S) URLs without credentials are supported.",
    );
}
function content(value, roots) {
  requireObject(value, "content");
  if (!kinds.has(value.kind))
    throw storeError(400, "Unsupported content kind.");
  if (value.resource) {
    validateResource(value.resource);
    if (!Object.hasOwn(roots, value.resource.rootId))
      throw storeError(400, "Content uses an unregistered resource root.");
  }
  if (value.url !== undefined) url(value.url);
  if (value.text !== undefined) text(value.text, "content text", 2000000);
  if (
    value.openMode !== undefined &&
    !["inline", "standalone", "external", "download", "preview"].includes(
      value.openMode,
    )
  )
    throw storeError(400, "Invalid content openMode.");
  if (value.startInstructions !== undefined)
    text(value.startInstructions, "start instructions", 20000);
}
function validateItem(item, roots) {
  assertId(item.id);
  if (item.schemaVersion !== 2) throw storeError(400, "Invalid item schema.");
  title(item.title);
  text(item.description, "description", 200000);
  if (item.content !== undefined && item.content !== null)
    content(item.content, roots);
  if (item.preview !== undefined && item.preview !== null) {
    requireObject(item.preview, "preview");
    if (item.preview.resource) {
      validateResource(item.preview.resource);
      if (!Object.hasOwn(roots, item.preview.resource.rootId))
        throw storeError(400, "Preview uses an unregistered resource root.");
    }
    if (item.preview.text !== undefined)
      text(item.preview.text, "preview text", 200000);
  }
  if (item.resources !== undefined) {
    if (!Array.isArray(item.resources) || item.resources.length > 10000)
      throw storeError(400, "Invalid item resources.");
    for (const resource of item.resources) {
      const ref = resource.resource || resource;
      validateResource(ref);
      if (!Object.hasOwn(roots, ref.rootId))
        throw storeError(400, "Unknown resource root.");
    }
  }
  if (!Array.isArray(item.revisions) || item.revisions.length > 10000)
    throw storeError(400, "Invalid revisions.");
  for (const revision of item.revisions) {
    requireObject(revision, "revision");
    if (revision.id !== undefined) text(revision.id, "revision ID", 1000);
    if (revision.content) content(revision.content, roots);
    if (revision.resource) {
      validateResource(revision.resource);
      if (!Object.hasOwn(roots, revision.resource.rootId))
        throw storeError(400, "Revision uses unknown resource root.");
    }
    if (revision.url !== undefined) url(revision.url);
  }
  requireObject(item.review, "review");
  text(item.review.note, "review note", 200000);
  if (typeof item.review.star !== "boolean")
    throw storeError(400, "Review star must be boolean.");
  requireObject(item.build, "build");
  if (!states.has(item.build.state))
    throw storeError(400, "Invalid build state.");
  text(item.build.message, "build message", 20000);
}
function geometry(placement) {
  assertId(placement.id);
  assertId(placement.itemId);
  for (const key of ["x", "y", "width", "height", "z"])
    if (
      typeof placement[key] !== "number" ||
      !Number.isFinite(placement[key]) ||
      Math.abs(placement[key]) > 10000000
    )
      throw storeError(400, "Invalid placement geometry.");
  if (
    placement.width < 40 ||
    placement.height < 40 ||
    placement.width > 100000 ||
    placement.height > 100000
  )
    throw storeError(400, "Placement dimensions are out of range.");
}
function color(value) {
  if (
    typeof value !== "string" ||
    !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
  )
    throw storeError(400, "Color must be a hexadecimal color.");
}
function decoration(entry) {
  requireObject(entry, "decoration");
  assertId(entry.id);
  if (!["text", "region", "line"].includes(entry.type))
    throw storeError(400, "Unsupported decoration type.");
  for (const key of ["x", "y", "width", "height"])
    if (
      typeof entry[key] !== "number" ||
      !Number.isFinite(entry[key]) ||
      Math.abs(entry[key]) > 10000000
    )
      throw storeError(400, "Invalid decoration geometry.");
  if (
    entry.width <= 0 ||
    entry.height <= 0 ||
    entry.width > 100000 ||
    entry.height > 100000
  )
    throw storeError(400, "Invalid decoration dimensions.");
  color(entry.color);
  text(entry.text, "decoration text", 20000);
}
const active = (placement) => !placement.removedAt && !placement.deletedAt;
function validateState(state) {
  const { metadata, items, boards } = state;
  validateResourceRoots(metadata.resourceRoots);
  for (const item of Object.values(items)) {
    validateItem(item, metadata.resourceRoots);
    if (item.childBoardId && !Object.hasOwn(boards, item.childBoardId))
      throw storeError(400, "Unknown child board.");
  }
  for (const board of Object.values(boards)) {
    assertId(board.id);
    title(board.title);
    if (board.description !== undefined)
      text(board.description, "board description", 200000);
    if (
      board.schemaVersion !== 2 ||
      !Array.isArray(board.placements) ||
      !Array.isArray(board.rounds) ||
      !Array.isArray(board.reviewOrder) ||
      !Array.isArray(board.decorations)
    )
      throw storeError(400, "Invalid board.");
    if (
      !Object.hasOwn(items, board.ownerItemId) ||
      items[board.ownerItemId].childBoardId !== board.id
    )
      throw storeError(400, "Board owner mismatch.");
    const ids = new Set();
    for (const placement of board.placements) {
      geometry(placement);
      if (ids.has(placement.id))
        throw storeError(400, "Duplicate placement ID.");
      ids.add(placement.id);
      if (!Object.hasOwn(items, placement.itemId))
        throw storeError(400, "Unknown placement item.");
    }
    if (
      new Set(board.reviewOrder).size !== board.reviewOrder.length ||
      board.reviewOrder.some((id) => !ids.has(id))
    )
      throw storeError(400, "Invalid review order.");
    if (
      board.decorations.length > 10000 ||
      JSON.stringify(board.decorations).length > 2000000
    )
      throw storeError(400, "Board decorations are too large.");
    const decorationIds = new Set();
    for (const entry of board.decorations) {
      decoration(entry);
      if (decorationIds.has(entry.id))
        throw storeError(400, "Duplicate decoration ID.");
      decorationIds.add(entry.id);
    }
    if (board.background !== undefined && board.background !== null) {
      requireObject(board.background, "background");
      if (board.background.color !== undefined) color(board.background.color);
    }
    if (board.background?.resource) {
      validateResource(board.background.resource);
      if (
        !Object.hasOwn(metadata.resourceRoots, board.background.resource.rootId)
      )
        throw storeError(400, "Unknown background resource root.");
    }
  }
  if (
    !Array.isArray(metadata.homeBoardIds) ||
    new Set(metadata.homeBoardIds).size !== metadata.homeBoardIds.length ||
    metadata.homeBoardIds.some((id) => !Object.hasOwn(boards, id))
  )
    throw storeError(400, "Invalid home boards.");
  const visiting = new Set(),
    done = new Set();
  const visit = (id) => {
    if (visiting.has(id))
      throw storeError(409, "Board relationship would create a cycle.");
    if (done.has(id)) return;
    visiting.add(id);
    for (const placement of boards[id].placements) {
      const item = items[placement.itemId];
      if (active(placement) && !item.deletedAt && item.childBoardId)
        visit(item.childBoardId);
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const id of Object.keys(boards)) visit(id);
  if (JSON.stringify(metadata).length > 2000000)
    throw storeError(400, "Workspace metadata is too large.");
}
export function emptyWorkspace() {
  return {
    metadata: {
      schemaVersion: 2,
      id: fresh("workspace"),
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
      resourceRoots: {},
      homeBoardIds: [],
      recentOperations: [],
    },
    items: {},
    boards: {},
  };
}
function publicWorkspace(state) {
  if (!state) return null;
  const { recentOperations, ...metadata } = state.metadata;
  return {
    ...clone(metadata),
    workspaceId: metadata.id,
    items: Object.values(state.items).map(clone),
    boards: Object.values(state.boards).map(clone),
  };
}
export async function readWorkspace(config) {
  return withStore(config, (_root, state) => publicWorkspace(state));
}
export async function getBoardSnapshot(config, id) {
  assertId(id);
  return withStore(config, (_root, state) => {
    if (!state || !Object.hasOwn(state.boards, id)) return null;
    const board = state.boards[id];
    if (state.items[board.ownerItemId]?.deletedAt) return null;
    const items = {};
    for (const placement of board.placements)
      items[placement.itemId] = clone(state.items[placement.itemId]);
    items[board.ownerItemId] = clone(state.items[board.ownerItemId]);
    return {
      ...clone(board),
      revision: state.metadata.revision,
      workspaceId: state.metadata.id,
      resourceRoots: clone(state.metadata.resourceRoots),
      items,
    };
  });
}
function getItem(state, id) {
  assertId(id);
  if (!Object.hasOwn(state.items, id) || state.items[id].deletedAt)
    throw storeError(404, "Item not found.");
  return state.items[id];
}
function getBoard(state, id) {
  assertId(id);
  if (
    !Object.hasOwn(state.boards, id) ||
    state.items[state.boards[id].ownerItemId]?.deletedAt
  )
    throw storeError(404, "Board not found.");
  return state.boards[id];
}
function makeItem(state, input = {}) {
  requireObject(input, "item");
  const stamp = now(),
    id = input.id || fresh("item");
  assertId(id);
  if (Object.hasOwn(state.items, id))
    throw storeError(409, "Item already exists.");
  const item = {
    ...clone(input),
    schemaVersion: 2,
    id,
    title: input.title || "Untitled",
    description: input.description ?? "",
    createdAt: input.createdAt || stamp,
    updatedAt: stamp,
    revisions: clone(input.revisions || []),
    review: {
      note: "",
      star: false,
      updatedAt: 0,
      ...clone(input.review || {}),
    },
    build: {
      state: "ready",
      message: "",
      updatedAt: 0,
      ...clone(input.build || {}),
    },
  };
  state.items[id] = item;
  return item;
}
function place(board, itemId, input = {}) {
  const existing = board.placements.filter(active);
  const count = existing.length;
  const placement = {
    x: (count % 4) * 360,
    y: Math.floor(count / 4) * 300,
    width: 320,
    height: 240,
    z: count,
    ...clone(input),
    id: fresh("placement"),
    itemId,
  };
  if (
    input.x === undefined &&
    input.y === undefined &&
    existing.some(
      (p) =>
        placement.x < p.x + p.width &&
        placement.x + placement.width > p.x &&
        placement.y < p.y + p.height &&
        placement.y + placement.height > p.y,
    )
  ) {
    placement.x = Math.max(...existing.map((p) => p.x + p.width)) + 40;
    placement.y = 0;
  }
  board.placements.push(placement);
  board.reviewOrder.push(placement.id);
  return placement;
}
function makeBoard(state, input) {
  const id = input.id || fresh("board");
  assertId(id);
  if (Object.hasOwn(state.boards, id))
    throw storeError(409, "Board already exists.");
  const item = input.itemId
    ? getItem(state, input.itemId)
    : makeItem(state, {
        title: input.title || "Untitled board",
        description: input.description ?? "",
      });
  if (item.childBoardId)
    throw storeError(409, "Item already has a child board.");
  item.childBoardId = id;
  item.updatedAt = now();
  const board = {
    schemaVersion: 2,
    id,
    ownerItemId: item.id,
    title: input.title || item.title,
    description: input.description ?? item.description,
    createdAt: now(),
    updatedAt: now(),
    placements: [],
    reviewOrder: [],
    rounds: [],
    decorations: [],
  };
  state.boards[id] = board;
  const placementIds = [];
  if (input.parentBoardId)
    placementIds.push(place(getBoard(state, input.parentBoardId), item.id).id);
  else state.metadata.homeBoardIds.push(id);
  return { board, item, placementIds };
}
function selectedPlacements(board, ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10000 ||
    new Set(ids).size !== ids.length
  )
    throw storeError(400, "Select unique placement IDs.");
  return ids.map((id) => {
    assertId(id);
    const found = board.placements.find(
      (entry) => entry.id === id && active(entry),
    );
    if (!found) throw storeError(404, "Placement not found.");
    return found;
  });
}
function ids(input) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 10000 ||
    new Set(input).size !== input.length
  )
    throw storeError(400, "Select unique item IDs.");
  return input.map(assertId);
}
function boolean(value) {
  if (typeof value !== "boolean")
    throw storeError(400, "Expected archived boolean.");
  return value;
}
function finishBoard(board) {
  board.updatedAt = now();
  const present = new Set(board.placements.filter(active).map((p) => p.id));
  board.reviewOrder = board.reviewOrder.filter((id) => present.has(id));
}
function execute(state, op) {
  switch (op.type) {
    case "createItem": {
      if (op.placement !== undefined) {
        requireObject(op.placement, "placement");
        if (
          Object.keys(op.placement).some(
            (key) => !["x", "y", "width", "height", "z"].includes(key),
          )
        )
          throw storeError(
            400,
            "Only geometry may be supplied for a new placement.",
          );
      }
      const item = makeItem(state, op.item);
      const board = op.boardId ? getBoard(state, op.boardId) : null;
      const placement = board ? place(board, item.id, op.placement) : null;
      if (board) finishBoard(board);
      return {
        itemId: item.id,
        ...(board ? { boardId: board.id, placementIds: [placement.id] } : {}),
      };
    }
    case "updateItem": {
      const item = getItem(state, op.itemId);
      requireObject(op.patch, "patch");
      for (const key of [
        "id",
        "schemaVersion",
        "createdAt",
        "childBoardId",
        "deletedAt",
      ])
        if (Object.hasOwn(op.patch, key))
          throw storeError(400, `Cannot patch ${key}.`);
      Object.assign(item, clone(op.patch), { updatedAt: now() });
      return { itemId: item.id };
    }
    case "review": {
      const item = getItem(state, op.itemId);
      requireObject(op.patch, "review patch");
      if (Object.keys(op.patch).some((key) => !["note", "star"].includes(key)))
        throw storeError(400, "Unknown review property.");
      item.review = {
        ...item.review,
        ...clone(op.patch),
        updatedAt: Date.now(),
      };
      item.updatedAt = now();
      return { itemId: item.id };
    }
    case "createBoard": {
      const made = makeBoard(state, op);
      return {
        boardId: made.board.id,
        itemId: made.item.id,
        placementIds: made.placementIds,
      };
    }
    case "updateBoard": {
      const board = getBoard(state, op.boardId);
      requireObject(op.patch, "board patch");
      if (
        Object.keys(op.patch).some(
          (key) =>
            ![
              "title",
              "description",
              "decorations",
              "background",
              "reviewOrder",
            ].includes(key),
        )
      )
        throw storeError(400, "Unknown board property.");
      Object.assign(board, clone(op.patch));
      finishBoard(board);
      return { boardId: board.id };
    }
    case "updatePlacement": {
      const board = getBoard(state, op.boardId),
        [placement] = selectedPlacements(board, [op.placementId]);
      requireObject(op.patch, "placement patch");
      if (
        Object.keys(op.patch).some(
          (key) => !["x", "y", "width", "height", "z"].includes(key),
        )
      )
        throw storeError(400, "Only placement geometry may be patched.");
      Object.assign(placement, clone(op.patch));
      finishBoard(board);
      return { boardId: board.id, placementIds: [placement.id] };
    }
    case "move":
    case "reference": {
      if (op.targetBoardId && op.newBoard)
        throw storeError(400, "Choose an existing or a new destination.");
      const source = op.sourceBoardId
        ? getBoard(state, op.sourceBoardId)
        : null;
      if (op.placementIds && !source)
        throw storeError(400, "Source board is required for placements.");
      if (op.placementIds && op.itemIds)
        throw storeError(400, "Select placements or items.");
      const placements = op.placementIds
        ? selectedPlacements(source, op.placementIds)
        : null;
      const items = placements
        ? placements.map((placement) => getItem(state, placement.itemId))
        : ids(op.itemIds).map((id) => getItem(state, id));
      let destination = op.targetBoardId
        ? getBoard(state, op.targetBoardId)
        : null;
      if (op.newBoard) {
        requireObject(op.newBoard, "newBoard");
        destination = makeBoard(state, {
          id: op.newBoard.id,
          title: op.newBoard.title,
          parentBoardId: op.newBoard.parentBoardId,
        }).board;
      }
      if (!destination && items.some((item) => !item.childBoardId))
        throw storeError(400, "Only boards can be placed on home.");
      if (op.type === "move" && source && destination?.id === source.id)
        throw storeError(400, "Move destination matches source.");
      const created = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (destination) {
          const original = placements?.[index];
          created.push(
            place(
              destination,
              item.id,
              original
                ? {
                    ...(op.newBoard ? { x: original.x, y: original.y } : {}),
                    width: original.width,
                    height: original.height,
                  }
                : {},
            ).id,
          );
        } else if (!state.metadata.homeBoardIds.includes(item.childBoardId))
          state.metadata.homeBoardIds.push(item.childBoardId);
        if (op.type === "move") {
          if (placements) {
            placements[index].removedAt = now();
            placements[index].removalReason = "move";
          } else if (source)
            for (const placement of source.placements)
              if (active(placement) && placement.itemId === item.id) {
                placement.removedAt = now();
                placement.removalReason = "move";
              }
          if (destination && item.childBoardId)
            state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(
              (id) => id !== item.childBoardId,
            );
        }
      }
      if (source) finishBoard(source);
      if (destination) finishBoard(destination);
      return {
        itemIds: items.map((item) => item.id),
        boardId: destination?.id || null,
        placementIds: created,
      };
    }
    case "duplicate": {
      const original = getItem(state, op.itemId),
        copied = clone(original);
      delete copied.id;
      delete copied.childBoardId;
      delete copied.archivedAt;
      delete copied.deletedAt;
      delete copied.legacy;
      delete copied.createdAt;
      const item = makeItem(state, {
        ...copied,
        title: op.title || `${original.title} copy`,
      });
      if (original.childBoardId) {
        const source = getBoard(state, original.childBoardId),
          made = makeBoard(state, { itemId: item.id, title: item.title });
        made.board.description = source.description;
        made.board.rounds = clone(source.rounds);
        made.board.decorations = clone(source.decorations);
        if (source.background) made.board.background = clone(source.background);
        const placementMap = new Map();
        for (const placement of source.placements.filter(active)) {
          const copy = clone(placement);
          delete copy.id;
          delete copy.itemId;
          const placed = place(made.board, placement.itemId, copy);
          placementMap.set(placement.id, placed.id);
        }
        made.board.reviewOrder = source.reviewOrder
          .map((id) => placementMap.get(id))
          .filter(Boolean);
      }
      const destination = op.targetBoardId
        ? getBoard(state, op.targetBoardId)
        : null;
      const placement = destination ? place(destination, item.id) : null;
      if (destination) {
        finishBoard(destination);
        if (item.childBoardId)
          state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(
            (id) => id !== item.childBoardId,
          );
      }
      return {
        itemId: item.id,
        ...(item.childBoardId ? { childBoardId: item.childBoardId } : {}),
        ...(destination
          ? { boardId: destination.id, placementIds: [placement.id] }
          : {}),
      };
    }
    case "archive":
    case "remove": {
      const board = getBoard(state, op.boardId),
        placements = selectedPlacements(board, op.placementIds);
      for (const placement of placements) {
        if (op.type === "remove") {
          placement.removedAt = now();
          placement.removalReason = "remove";
        } else if (boolean(op.archived)) placement.archivedAt = now();
        else delete placement.archivedAt;
      }
      finishBoard(board);
      return { boardId: board.id, placementIds: placements.map((p) => p.id) };
    }
    case "archiveItem":
    case "deleteItem": {
      const items = ids(op.itemIds).map((id) => getItem(state, id));
      const changedBoards = new Set();
      for (const item of items) {
        if (op.type === "deleteItem") {
          item.deletedAt = now();
          for (const board of Object.values(state.boards))
            for (const placement of board.placements)
              if (placement.itemId === item.id) {
                placement.deletedAt = now();
                changedBoards.add(board.id);
              }
          if (item.childBoardId)
            state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(
              (id) => id !== item.childBoardId,
            );
        } else if (boolean(op.archived)) item.archivedAt = now();
        else delete item.archivedAt;
        item.updatedAt = now();
      }
      for (const id of changedBoards) finishBoard(state.boards[id]);
      return { itemIds: items.map((item) => item.id) };
    }
    case "updateWorkspace": {
      requireObject(op.patch, "workspace patch");
      if (
        Object.keys(op.patch).some(
          (key) => !["resourceRoots", "homeBoardIds"].includes(key),
        )
      )
        throw storeError(400, "Unknown workspace property.");
      if (op.patch.resourceRoots)
        state.metadata.resourceRoots = {
          ...state.metadata.resourceRoots,
          ...clone(op.patch.resourceRoots),
        };
      if (op.patch.homeBoardIds)
        state.metadata.homeBoardIds = clone(op.patch.homeBoardIds);
      return { workspaceId: state.metadata.id };
    }
    default:
      throw storeError(400, "Unknown workspace operation.");
  }
}
export async function applyOperation(config, operation) {
  requireObject(operation, "operation");
  if (JSON.stringify(operation).length > 4000000)
    throw storeError(400, "Operation is too large.");
  if (operation.operationId !== undefined) assertId(operation.operationId);
  if (
    operation.expectedRevision !== undefined &&
    (!Number.isSafeInteger(operation.expectedRevision) ||
      operation.expectedRevision < 0)
  )
    throw storeError(400, "Invalid expectedRevision.");
  const { expectedRevision, operationId, ...payload } = operation;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return withStore(
    config,
    async (root, before) => {
      const state = clone(before || emptyWorkspace());
      const prior =
        operationId &&
        state.metadata.recentOperations.find(
          (entry) => entry.operationId === operationId,
        );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw storeError(
            409,
            "Operation ID was already used with different input.",
          );
        return { ...clone(prior.response), replayed: true };
      }
      if (
        expectedRevision !== undefined &&
        expectedRevision !== state.metadata.revision
      )
        throw storeError(
          409,
          "Workspace revision changed. Reload before retrying.",
        );
      const result = execute(state, operation);
      validateState(state);
      await validateRootLocations(config, state.metadata.resourceRoots);
      state.metadata.revision++;
      state.metadata.updatedAt = now();
      const response = { revision: state.metadata.revision, result };
      if (operationId)
        state.metadata.recentOperations = [
          ...state.metadata.recentOperations,
          { operationId, fingerprint, response },
        ].slice(-64);
      await commitStore(root, before, state);
      return response;
    },
    { create: true },
  );
}

// Migration alone uses this internal validator before its one metadata commit.
export { validateState as validateWorkspaceState };
