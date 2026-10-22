import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {prepareImport,importResources} from "./file-import.mjs";
import {boardCovers,coverRevisions} from './board-covers.mjs';
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
    if (item.preview.url !== undefined) url(item.preview.url);
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
function presentation(value) {
  if (value === undefined) return;
  requireObject(value, "placement presentation");
  if (Object.keys(value).some((key) => !["mode", "viewport", "paper"].includes(key)) ||
      !["card", "panel", "icon"].includes(value.mode))
    throw storeError(400, "Presentation mode must be card, panel or icon.");
  if (value.paper !== undefined) color(value.paper);
  if (value.viewport !== undefined) {
    requireObject(value.viewport, "presentation viewport");
    if (Object.keys(value.viewport).some((key) => !["width", "height"].includes(key)) ||
        ["width", "height"].some((key) => !Number.isInteger(value.viewport[key]) ||
          value.viewport[key] < 40 || value.viewport[key] > 10000))
      throw storeError(400, "Presentation viewport dimensions must be integers from 40 to 10000.");
  }
}
function geometry(placement) {
  assertId(placement.id);
  assertId(placement.itemId);
  presentation(placement.presentation);
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
  for (const key of ["endArrow", "flipX", "flipY"]) {
    if (entry[key] === undefined) continue;
    if (entry.type !== "line" || typeof entry[key] !== "boolean")
      throw storeError(400, "Line arrow and direction fields must be boolean and belong to a line.");
  }
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
  const { recentOperations, movementHistoryKey, ...metadata } = state.metadata;
  return {
    ...clone(metadata),
    workspaceId: metadata.id,
    items: Object.values(state.items).map(clone),
    boards: Object.values(state.boards).map(clone),
  };
}
export async function readWorkspace(config, {covers = false} = {}) {
  const snapshot = await withStore(config, (_root, state) => state ? {...publicWorkspace(state), ...(covers ? {boardCovers:boardCovers(state.boards,state.items,state.metadata.homeBoardIds)} : {})} : null);
  if (snapshot?.boardCovers) await coverRevisions(config,snapshot.boardCovers);
  return snapshot;
}
export async function getBoardSnapshot(config, id) {
  assertId(id);
  const snapshot = await withStore(config, (_root, state) => {
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
      boardCovers:boardCovers(state.boards,state.items,[id,...Object.values(items).map(item=>item?.childBoardId).filter(Boolean)]),
    };
  });
  if (snapshot) await coverRevisions(config,snapshot.boardCovers);
  return snapshot;
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
function checkMoveSource(state, op, source) {
  const hasPlacements = Object.hasOwn(op, "expectedSourcePlacements");
  const hasOrder = Object.hasOwn(op, "expectedSourceReviewOrder");
  if (!hasPlacements && !hasOrder) return;
  if (!hasPlacements || !hasOrder || op.type !== "move" || !source ||
      !op.targetBoardId || op.newBoard || op.targetBoardId === source.id ||
      !Array.isArray(op.placementIds) || !op.placementIds.length || op.placementIds.length > 10000 ||
      new Set(op.placementIds).size !== op.placementIds.length || op.itemIds ||
      !Array.isArray(op.expectedSourcePlacements) || op.expectedSourcePlacements.length !== op.placementIds.length ||
      !Array.isArray(op.expectedSourceReviewOrder))
    throw storeError(400, "Move source preconditions require selected placement snapshots and review order with an existing distinct destination.");
  const selected = new Set(op.placementIds.map(assertId));
  for (let index = 0; index < op.expectedSourcePlacements.length; index++) {
    const saved = requireObject(op.expectedSourcePlacements[index], "expected source placement");
    geometry(saved);
    if (saved.id !== op.placementIds[index] || !active(saved))
      throw storeError(400, "Expected source placements must match the active selection in input order.");
  }
  if (new Set(op.expectedSourceReviewOrder).size !== op.expectedSourceReviewOrder.length ||
      op.expectedSourceReviewOrder.some(id => !selected.has(id)))
    throw storeError(400, "Expected source review order must contain unique selected placement IDs.");
  // Guard only the saved selection: unrelated placements and canonical edits
  // remain independent while a native cut waits for its eventual paste.
  const current = op.placementIds.map(id => source.placements.find(p => p.id === id && active(p)));
  if (!isDeepStrictEqual(current, op.expectedSourcePlacements) ||
      !isDeepStrictEqual(source.reviewOrder.filter(id => selected.has(id)), op.expectedSourceReviewOrder))
    throw storeError(409, "Cut selection changed. Cut the current selection again before pasting.");
  const destination = getBoard(state, op.targetBoardId);
  if ([source, destination].some(board => state.items[board.ownerItemId].archivedAt) ||
      current.some(p => p.archivedAt || state.items[p.itemId]?.archivedAt || state.items[p.itemId]?.deletedAt))
    throw storeError(409, "Cut requires active items and boards. Restore them before cutting again.");
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
const arrangement = (board) => ({placements:board.placements, reviewOrder:board.reviewOrder});
const hashArrangement = (board) => createHash("sha256").update(JSON.stringify(arrangement(board))).digest("hex");
function movementBoards(op) {
  if (op.type === "pastePlacements" || op.type === "importFiles") return [op.targetBoardId];
  if (op.type === "translatePlacements" || (op.type === "updatePlacement" &&
      object(op.patch) && ["x","y","width","height","z"].some(key => Object.hasOwn(op.patch,key))))
    return [op.boardId];
  if (op.type === "move" && op.sourceBoardId && op.placementIds && op.targetBoardId && !op.newBoard)
    return [...new Set([op.sourceBoardId,op.targetBoardId])];
  return [];
}
function pastePlacements(state, op) {
  const saved = requireObject(op.clipboard, "clipboard"), destination = getBoard(state, op.targetBoardId);
  if (Object.keys(saved).some(key => !["version", "workspaceId", "placements", "items", "boards", "reviewOrder"].includes(key)) ||
      saved.version !== 1 || saved.workspaceId !== state.metadata.id)
    throw storeError(400, "Clipboard belongs to another workspace or version.");
  requireObject(saved.items, "clipboard items");
  requireObject(saved.boards, "clipboard boards");
  requireObject(op.targetPosition, "targetPosition");
  if (Object.keys(op.targetPosition).some(key => !["x", "y"].includes(key)) ||
      ["x", "y"].some(key => typeof op.targetPosition[key] !== "number" ||
        !Number.isFinite(op.targetPosition[key]) || Math.abs(op.targetPosition[key]) > 10000000))
    throw storeError(400, "Paste requires finite targetPosition x/y coordinates.");
  if (!Array.isArray(saved.placements) || !saved.placements.length || saved.placements.length > 10000)
    throw storeError(400, "Clipboard requires selected placements.");
  const placementIds = new Set(), itemIds = new Set();
  for (const placement of saved.placements) {
    requireObject(placement, "clipboard placement");
    geometry(placement);
    if (!active(placement) || placementIds.has(placement.id))
      throw storeError(400, "Clipboard requires unique active placements.");
    placementIds.add(placement.id);
    itemIds.add(placement.itemId);
  }
  const order = saved.reviewOrder === undefined ? [...placementIds] : saved.reviewOrder;
  if (!Array.isArray(order) || new Set(order).size !== order.length || order.length !== placementIds.size ||
      order.some(id => !placementIds.has(id)))
    throw storeError(400, "Invalid clipboard review order.");
  if (Object.keys(saved.items).length !== itemIds.size || Object.keys(saved.items).some(id => !itemIds.has(id)))
    throw storeError(400, "Clipboard items must match selected placements.");
  const boardIds = new Set();
  for (const id of itemIds) {
    const original = requireObject(saved.items[id], "clipboard item");
    validateItem(original, state.metadata.resourceRoots);
    if (original.id !== id || original.deletedAt)
      throw storeError(400, "Invalid clipboard item identity.");
    if (original.childBoardId) boardIds.add(original.childBoardId);
  }
  if (Object.keys(saved.boards).length !== boardIds.size || Object.keys(saved.boards).some(id => !boardIds.has(id)))
    throw storeError(400, "Clipboard boards must match selected board items.");
  // A clipboard captures canonical data and arrangement at copy time. It does
  // not depend on the source placement still existing when paste occurs.
  const copies = new Map();
  for (const id of itemIds) {
    const copied = clone(saved.items[id]);
    for (const key of ["id", "childBoardId", "archivedAt", "deletedAt", "legacy", "createdAt"])
      delete copied[key];
    copies.set(id, makeItem(state, copied));
  }
  for (const id of itemIds) {
    const original = saved.items[id], item = copies.get(id);
    if (!original.childBoardId) continue;
    const source = requireObject(saved.boards[original.childBoardId], "clipboard board");
    if (source.id !== original.childBoardId || source.ownerItemId !== id || source.schemaVersion !== 2 ||
        !Array.isArray(source.placements) || source.placements.length > 10000 || !Array.isArray(source.reviewOrder) ||
        !Array.isArray(source.rounds) || !Array.isArray(source.decorations))
      throw storeError(400, "Invalid clipboard board.");
    title(source.title);
    if (source.description !== undefined) text(source.description, "board description", 200000);
    const made = makeBoard(state, {itemId:item.id, title:source.title}).board;
    // Board copies are contained by the pasted owner, including while undone.
    state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(boardId => boardId !== made.id);
    made.description = source.description ?? "";
    made.rounds = clone(source.rounds);
    made.decorations = clone(source.decorations);
    if (source.background !== undefined) made.background = clone(source.background);
    const children = new Map();
    for (const placement of source.placements) {
      requireObject(placement, "clipboard board placement");
      geometry(placement);
      if (children.has(placement.id)) throw storeError(400, "Duplicate clipboard board placement.");
      children.set(placement.id, null);
      if (!active(placement)) continue;
      const childId = copies.get(placement.itemId)?.id || getItem(state, placement.itemId).id;
      children.set(placement.id, place(made, childId, placement).id);
    }
    if (new Set(source.reviewOrder).size !== source.reviewOrder.length || source.reviewOrder.some(id => !children.has(id)))
      throw storeError(400, "Invalid clipboard board review order.");
    made.reviewOrder = source.reviewOrder.map(id => children.get(id)).filter(Boolean);
  }
  const origin = {x:Math.min(...saved.placements.map(p => p.x)), y:Math.min(...saved.placements.map(p => p.y))};
  const top = Math.max(0, ...destination.placements.filter(active).map(p => p.z));
  const minimumZ = Math.min(...saved.placements.map(p => p.z));
  const placed = new Map(), previousOrder = [...destination.reviewOrder];
  for (const original of saved.placements) {
    const copied = clone(original);
    for (const key of ["archivedAt", "deletedAt", "removedAt", "removalReason"]) delete copied[key];
    const placement = place(destination, copies.get(original.itemId).id, {...copied,
      x:op.targetPosition.x + original.x - origin.x, y:op.targetPosition.y + original.y - origin.y,
      z:top + 1 + original.z - minimumZ});
    geometry(placement);
    placed.set(original.id, placement.id);
  }
  destination.reviewOrder = [...previousOrder, ...order.map(id => placed.get(id))];
  finishBoard(destination);
  return {boardId:destination.id, itemIds:saved.placements.map(p => copies.get(p.itemId).id),
    placementIds:saved.placements.map(p => placed.get(p.id))};
}
function signMovement(state, body) {
  state.metadata.movementHistoryKey ||= randomBytes(32).toString("hex");
  const signature = createHmac("sha256",state.metadata.movementHistoryKey).update(JSON.stringify(body)).digest("hex");
  return {...body,signature};
}
function movementHistory(state, before, boardIds) {
  const boards = [];
  for (const id of boardIds) {
    const previous = before.boards[id], next = state.boards[id];
    if (hashArrangement(previous) === hashArrangement(next)) continue;
    const old = new Map(previous.placements.map(p => [p.id,JSON.stringify(p)]));
    const current = new Map(next.placements.map(p => [p.id,JSON.stringify(p)]));
    const changed = new Set([...old.keys(),...current.keys()].filter(id => old.get(id) !== current.get(id)));
    const side = board => ({hash:hashArrangement(board),reviewOrder:clone(board.reviewOrder),
      placements:board.placements.flatMap((value,index) => changed.has(value.id) ? [{index,value:clone(value)}] : [])});
    boards.push({id,before:side(previous),after:side(next)});
  }
  if (!boards.length) return;
  const home = JSON.stringify(before.metadata.homeBoardIds) === JSON.stringify(state.metadata.homeBoardIds) ? {} :
    {home:{before:clone(before.metadata.homeBoardIds),after:clone(state.metadata.homeBoardIds)}};
  return signMovement(state,{version:1,workspaceId:state.metadata.id,boards,...home});
}
function restoreMovement(state, history) {
  requireObject(history,"movement history");
  const {signature,...body} = history;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) ||
      typeof state.metadata.movementHistoryKey !== "string")
    throw storeError(400,"Invalid movement history receipt.");
  const expected = createHmac("sha256",state.metadata.movementHistoryKey).update(JSON.stringify(body)).digest();
  if (!timingSafeEqual(expected,Buffer.from(signature,"hex")) || body.version !== 1 ||
      body.workspaceId !== state.metadata.id || !Array.isArray(body.boards) || !body.boards.length || body.boards.length > 2)
    throw storeError(400,"Invalid movement history receipt.");
  // Verify every precondition before touching any board. Only arrangements are
  // guarded: later canonical reviews and board/item titles remain independent.
  const targets = body.boards.map(entry => {
    const board = getBoard(state,entry.id);
    if (hashArrangement(board) !== entry.after.hash)
      throw storeError(409,"Board arrangement changed. Movement history cannot be applied.");
    return board;
  });
  if (body.home && JSON.stringify(state.metadata.homeBoardIds) !== JSON.stringify(body.home.after))
    throw storeError(409,"Home board order changed. Movement history cannot be applied.");
  for (let i = 0; i < targets.length; i++) {
    const board = targets[i], entry = body.boards[i];
    const changed = new Set([...entry.before.placements,...entry.after.placements].map(p => p.value.id));
    board.placements = board.placements.filter(p => !changed.has(p.id));
    for (const saved of [...entry.before.placements].sort((a,b) => a.index - b.index))
      board.placements.splice(saved.index,0,clone(saved.value));
    board.reviewOrder = clone(entry.before.reviewOrder);
    board.updatedAt = now();
    if (hashArrangement(board) !== entry.before.hash)
      throw storeError(409,"Movement history does not match the saved arrangement.");
  }
  if (body.home) state.metadata.homeBoardIds = clone(body.home.before);
  const reciprocal = {...body,boards:body.boards.map(entry => ({id:entry.id,before:entry.after,after:entry.before})),
    ...(body.home ? {home:{before:body.home.after,after:body.home.before}} : {})};
  return {result:{boardIds:targets.map(board => board.id)},history:signMovement(state,reciprocal)};
}
function execute(state, op) {
  switch (op.type) {
    case "pastePlacements": return pastePlacements(state, op);
    case "createItem": {
      if (op.placement !== undefined) {
        requireObject(op.placement, "placement");
        if (
          Object.keys(op.placement).some(
            (key) => !["x", "y", "width", "height", "z", "presentation"].includes(key),
          )
        )
          throw storeError(
            400,
            "Only geometry and presentation may be supplied for a new placement.",
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
          (key) => !["x", "y", "width", "height", "z", "presentation"].includes(key),
        )
      )
        throw storeError(400, "Only placement geometry and presentation may be patched.");
      Object.assign(placement, clone(op.patch));
      finishBoard(board);
      return { boardId: board.id, placementIds: [placement.id] };
    }
    case "translatePlacements": {
      const board = getBoard(state, op.boardId);
      const placements = selectedPlacements(board, op.placementIds);
      if (["dx", "dy"].some(key => typeof op[key] !== "number" || !Number.isFinite(op[key]) || Math.abs(op[key]) > 10000000))
        throw storeError(400, "Translation requires finite dx/dy coordinates.");
      const translated = placements.map(p => {
        getItem(state, p.itemId);
        const next = {...p, x:p.x + op.dx, y:p.y + op.dy};
        geometry(next);
        return next;
      });
      placements.forEach((p, index) => { p.x = translated[index].x; p.y = translated[index].y; });
      finishBoard(board);
      return {boardId:board.id, placementIds:placements.map(p => p.id)};
    }
    case "move":
    case "reference": {
      if (op.targetBoardId && op.newBoard)
        throw storeError(400, "Choose an existing or a new destination.");
      const source = op.sourceBoardId
        ? getBoard(state, op.sourceBoardId)
        : null;
      checkMoveSource(state, op, source);
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
      if (op.targetPosition !== undefined) {
        requireObject(op.targetPosition, "targetPosition");
        if (op.type !== "move" || !op.targetBoardId || op.newBoard || !placements?.length ||
            Object.keys(op.targetPosition).some(key => !["x", "y"].includes(key)) ||
            ["x", "y"].some(key => typeof op.targetPosition[key] !== "number" ||
              !Number.isFinite(op.targetPosition[key]) || Math.abs(op.targetPosition[key]) > 10000000))
          throw storeError(400, "targetPosition requires moved placements, an existing target board and finite x/y coordinates.");
      }
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
      const origin = op.targetPosition ? {
        x:Math.min(...placements.map(p => p.x)), y:Math.min(...placements.map(p => p.y)),
      } : null;
      const destinationZ = op.targetPosition ? Math.max(0,...destination.placements.filter(active).map(p => p.z)) : 0;
      if (op.targetPosition && placements.length > 1 && destinationZ + placements.length > 10000000)
        throw storeError(400, "Destination stacking order is out of range.");
      const positionedZ = op.targetPosition ? new Map([...placements].sort((a,b) => a.z - b.z)
        .map((p,index) => [p.id, Math.min(10000000,destinationZ + index + 1)])) : null;
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
                    ...(op.targetPosition ? {
                      x:op.targetPosition.x + original.x - origin.x,
                      y:op.targetPosition.y + original.y - origin.y,
                      z:positionedZ.get(original.id),
                    } : {}),
                    width: original.width,
                    height: original.height,
                    ...(original.presentation ? { presentation: original.presentation } : {}),
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
  return applyTransaction(config,operation);
}
export async function applyFileImport(config,metadata,files,{signal}={}) {
  const prepared=prepareImport(metadata,files);
  return applyTransaction(config,prepared.operation,{files:prepared.files,signal});
}
async function applyTransaction(config, operation, imported) {
  requireObject(operation, "operation");
  if(operation.type === "importFiles" && !imported) throw storeError(400,"Use the file import endpoint for file bytes.");
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
      if(imported && (!before || operation.workspaceId !== state.metadata.id))
        throw storeError(403,"File import belongs to another workspace.");
      const boardIds = movementBoards(operation);
      const movementBefore = boardIds.length ? {boards:Object.fromEntries(boardIds.map(id => [id,clone(getBoard(state,id))])),
        metadata:{homeBoardIds:clone(state.metadata.homeBoardIds)}} : null;
      const restored = operation.type === "restoreMovement" ? restoreMovement(state,operation.history) : null;
      let payloads;
      let result;
      if(imported){
        payloads=await importResources(config,state,operation,imported.files,imported.signal);
        const items={},placements=[];
        operation.files.forEach((file,index)=>{
          const id=`import-${index}`,resource=payloads.resources[index];
          items[id]={schemaVersion:2,id,title:file.title,description:"",content:{kind:file.kind,resource},
            revisions:[],review:{note:"",star:false,updatedAt:0},build:{state:"ready",message:"",updatedAt:0},
            ...(file.kind==='image'?{preview:{resource}}:{})};
          placements.push({id:`import-placement-${index}`,itemId:id,...operation.placements[index],z:index,presentation:{mode:"panel"}});
        });
        // paste anchors at the minimum corner; preserve the supplied offsets.
        const x=Math.min(...placements.map(p=>p.x)),y=Math.min(...placements.map(p=>p.y));
        result=pastePlacements(state,{targetBoardId:operation.targetBoardId,
          targetPosition:{x:operation.targetPosition.x+x,y:operation.targetPosition.y+y},
          clipboard:{version:1,workspaceId:state.metadata.id,items,boards:{},placements}});
        result.resources=payloads.resources;
      }else result = restored ? restored.result : execute(state, operation);
      const history = restored?.history || (movementBefore ? movementHistory(state,movementBefore,boardIds) : undefined);
      state.metadata.revision++;
      state.metadata.updatedAt = now();
      const response = { revision: state.metadata.revision, result, ...(history ? {history} : {}) };
      if (operationId) {
        state.metadata.recentOperations = [
          ...state.metadata.recentOperations,
          { operationId, fingerprint, response },
        ].slice(-64);
        const cacheTooLarge = () => Buffer.byteLength(JSON.stringify(state.metadata)) > 2000000;
        while (state.metadata.recentOperations.length > 1 && cacheTooLarge())
          state.metadata.recentOperations.shift();
        // Keep retry identity even if one unusually large receipt cannot fit the
        // metadata cache. The original response still carries its full history.
        if (history && cacheTooLarge())
          state.metadata.recentOperations.at(-1).response = {revision:response.revision,result:clone(result)};
      }
      validateState(state);
      await validateRootLocations(config, state.metadata.resourceRoots);
      // Validate every metadata change before preserving payloads. Once written,
      // originals are retained even if commit or the response is interrupted.
      await payloads?.persist();
      await commitStore(root, before, state);
      return response;
    },
    { create: true },
  );
}

// Migration alone uses this internal validator before its one metadata commit.
export { validateState as validateWorkspaceState };
