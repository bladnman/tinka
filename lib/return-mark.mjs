// "Back to Tinka" for standalone pages. When a person opens one of the
// project's HTML files straight from Tinka's address (Open standalone, a link
// an agent handed out), the top-level document gets one small script tag that
// draws a way back. Tinka's own frames, curl and agents get the file's exact
// bytes: only a browser's top-level navigation says Sec-Fetch-Dest: document.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { loadBoard } from "./boards.mjs";
import { boardDirectory, existingInside, HttpError, safeRelative } from "./paths.mjs";
import { resolveResource } from "./resources.mjs";
import { withStore, workspaceRoot } from "./store.mjs";

export const RETURN_MARK_TAG = '<script src="/app/return-mark.js" defer></script>';
// Larger HTML files are served raw rather than buffered to add the mark.
export const RETURN_MARK_MAX_BYTES = 8 * 1024 * 1024;

// The request is a browser opening this HTML file as the page itself.
export function wantsReturnMark(req, url, contentType, size) {
  return (
    (req.method === "GET" || req.method === "HEAD") &&
    /^text\/html\b/i.test(contentType || "") &&
    String(req.headers["sec-fetch-dest"] || "").toLowerCase() === "document" &&
    !req.headers.range &&
    url.searchParams.get("tinka") !== "off" &&
    size <= RETURN_MARK_MAX_BYTES
  );
}

const META = /<meta\b[^>]*>/gi;
// <meta name="tinka-return" content="off"> in the page turns the mark off.
export function returnMarkOptedOut(text) {
  for (const tag of text.match(META) || []) {
    const name = /\bname\s*=\s*(["']?)([^"'\s>]*)\1/i.exec(tag)?.[2];
    const content = /\bcontent\s*=\s*(["']?)([^"'\s>]*)\1/i.exec(tag)?.[2];
    if (name?.toLowerCase() === "tinka-return" && content?.toLowerCase() === "off") return true;
  }
  return false;
}

// Adds the tag before the last </body>, or at the end. Works on bytes (latin1
// maps each byte to one character), so the page's own encoding is untouched.
// Returns null when the page opted out or is UTF-16, which an ASCII tag would corrupt.
export function injectReturnMark(buffer) {
  if (buffer.length >= 2 && ((buffer[0] === 0xfe && buffer[1] === 0xff) || (buffer[0] === 0xff && buffer[1] === 0xfe))) return null;
  const text = buffer.toString("latin1");
  if (returnMarkOptedOut(text)) return null;
  let at = -1;
  for (const match of text.matchAll(/<\/body\s*>/gi)) at = match.index;
  const tag = Buffer.from(RETURN_MARK_TAG, "latin1");
  if (at < 0) return Buffer.concat([buffer, tag]);
  return Buffer.concat([buffer.subarray(0, at), tag, buffer.subarray(at)]);
}

// The file behind a standalone address, as the router serves it.
export function standaloneTarget(config, pathname) {
  let clean = String(pathname || "");
  if (config.legacyBoard && /^\/(rounds|shared|assets)\//.test(clean)) clean = `/boards/${config.legacyBoard}/files${clean}`;
  const decode = (value) => { try { return decodeURIComponent(value); } catch { throw new HttpError(400, "Invalid URL encoding."); } };
  const resource = /^\/resources\/([^/]+)\/(.+)$/.exec(clean);
  if (resource) return { kind: "resource", rootId: decode(resource[1]), path: safeRelative(resource[2]) };
  const board = /^\/boards\/([^/]+)\/files\/(.+)$/.exec(clean);
  if (board) return { kind: "board", boardId: decode(board[1]), path: safeRelative(board[2]) };
  throw new HttpError(400, "Provide a /resources/… or /boards/…/files/… address.");
}

const active = (p) => p && !p.removedAt && !p.archivedAt && !p.deletedAt;
const MAX_PLACES = 50;

// Every board placement whose item shows this file, for the Inspector's
// "On boards" list and the standalone page's way back. Read-only.
export async function resourcePlaces(config, pathname) {
  const target = standaloneTarget(config, pathname);
  let file;
  if (target.kind === "resource") file = (await resolveResource(config, { rootId: target.rootId, path: target.path })).path;
  else file = (await existingInside(await boardDirectory(config.boardsRoot, target.boardId), target.path)).path;
  const places = [];
  // Graph items: their content (and saved versions) name a file through a resource root.
  const graph = await withStore(config, (_root, state) => {
    if (!state) return null;
    const uses = [];
    for (const item of Object.values(state.items)) {
      if (item.deletedAt) continue;
      const refs = [];
      if (item.content?.resource && !item.content.url) refs.push({ resource: item.content.resource, revision: null });
      (item.revisions || []).forEach((revision, index) => {
        const resource = revision?.content?.resource || revision?.resource;
        if (resource && !(revision?.content?.url || revision?.url)) refs.push({ resource, revision: revision.id || `revision-${index + 1}` });
      });
      if (refs.length) uses.push({ item: { id: item.id, title: item.title, number: item.number || item.legacy?.number || "" }, refs });
    }
    const boards = Object.values(state.boards).filter((board) => !state.items[board.ownerItemId]?.deletedAt && !state.items[board.ownerItemId]?.archivedAt)
      .map((board) => ({ id: board.id, title: board.title, placements: (board.placements || []).filter(active).map((p) => ({ id: p.id, itemId: p.itemId })) }));
    return { uses, boards, roots: state.metadata.resourceRoots || {} };
  });
  if (graph) {
    const rootPaths = new Map();
    const rootPath = async (rootId) => {
      if (!rootPaths.has(rootId)) {
        const registered = graph.roots[rootId];
        rootPaths.set(rootId, registered ? realpath(path.resolve(workspaceRoot(config), registered.path)).catch(() => null) : Promise.resolve(null));
      }
      return rootPaths.get(rootId);
    };
    const matches = new Map();
    for (const use of graph.uses) for (const ref of use.refs) {
      const base = await rootPath(ref.resource.rootId);
      if (!base || typeof ref.resource.path !== "string") continue;
      let candidate = path.join(base, ref.resource.path);
      if (candidate !== file && path.basename(candidate) === path.basename(file)) candidate = await realpath(candidate).catch(() => candidate);
      if (candidate !== file) continue;
      if (!matches.has(use.item.id)) matches.set(use.item.id, { item: use.item, revision: ref.revision });
      else if (ref.revision === null) matches.get(use.item.id).revision = null;
    }
    for (const board of graph.boards) for (const p of board.placements) {
      const match = matches.get(p.itemId);
      if (!match || places.length >= MAX_PLACES) continue;
      const key = `items/${p.id}`;
      places.push({ boardId: board.id, boardTitle: board.title || "Untitled board", placementId: p.id, key, itemId: match.item.id, title: match.item.title, number: match.item.number, ...(match.revision ? { revision: match.revision } : {}),
        href: `/boards/${encodeURIComponent(board.id)}/#${encodeURIComponent(key).replace(/%2F/g, "/")}${match.revision ? `~${encodeURIComponent(match.revision)}` : ""}` });
    }
  }
  // A legacy board's own file: its concepts and versions name board-relative paths.
  if (target.kind === "board" && !graph?.boards.some((board) => board.id === target.boardId)) {
    const board = await loadBoard(config, target.boardId).catch(() => null);
    if (board) {
      const variants = board.manifest.revisions || {};
      for (const round of board.manifest.rounds) for (const concept of round.concepts) {
        const key = `${round.id}/${concept.id}`;
        let revision = null;
        const own = (concept.path || `rounds/${key}/index.html`) === target.path && !concept.url;
        if (!own) revision = (variants[key] || []).find((variant) => variant.path === target.path && !variant.url)?.id || null;
        if ((own || revision) && places.length < MAX_PLACES)
          places.push({ boardId: board.id, boardTitle: board.metadata.title || board.id, key, title: concept.name || concept.id, number: concept.number || "", ...(revision ? { revision } : {}),
            href: `/boards/${encodeURIComponent(board.id)}/#${key}${revision ? `~${encodeURIComponent(revision)}` : ""}` });
      }
    }
  }
  return { workspace: config.workspaceId, file, url: pathname, places };
}
