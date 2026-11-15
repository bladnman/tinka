// Copy a board's visible text as Markdown: decoration text, item titles and
// document titles, ordered top-to-bottom then left-to-right.

const live = (x) => x && !x.removedAt && !x.archivedAt && !x.deletedAt;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const mdText = (s) => oneLine(s).replace(/([\\[\]])/g, "\\$1");

function itemLink(item, placement, snapshot, hooks) {
  return (
    hooks?.itemLink?.(placement, item, snapshot) ||
    placement.link ||
    item.link ||
    item.content?.url ||
    item.url ||
    null
  );
}

function linePosition(d, snapshot) {
  const ends = [d.from, d.to, d.start, d.end].filter(Boolean);
  const points = ends.map((e) => {
    if (Number.isFinite(e.x) && Number.isFinite(e.y)) return e;
    const p = e.placementId && snapshot.placements?.find((q) => q.id === e.placementId);
    const o = p || (e.decorationId && snapshot.decorations?.find((q) => q.id === e.decorationId));
    return o && Number.isFinite(o.x) ? { x: o.x + (o.width || 0) / 2, y: o.y + (o.height || 0) / 2 } : null;
  }).filter(Boolean);
  if (!points.length) return { x: Infinity, y: Infinity };
  return { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) };
}

export function buildBoardNotes(snapshot = {}, hooks) {
  const entries = [];
  for (const d of snapshot.decorations || []) {
    if (!live(d) || !oneLine(d.text)) continue;
    const pos = d.type === "line" || !Number.isFinite(d.x) ? linePosition(d, snapshot) : d;
    entries.push({ x: pos.x, y: pos.y, line: `- ${oneLine(d.text)}` });
  }
  const items = snapshot.items || {};
  for (const p of snapshot.placements || []) {
    const item = items[p.itemId];
    if (!live(p) || !live(item) || p.itemId === snapshot.ownerItemId) continue;
    const title = oneLine(item.title);
    if (!title) continue;
    const link = itemLink(item, p, snapshot, hooks);
    entries.push({ x: p.x ?? Infinity, y: p.y ?? Infinity, line: link ? `- [${mdText(title)}](${String(link).replace(/[()\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))})` : `- ${title}` });
  }
  entries.sort((a, b) => a.y - b.y || a.x - b.x);
  const heading = `# ${oneLine(snapshot.title) || "Untitled board"}`;
  return [heading, "", ...entries.map((e) => e.line)].join("\n").trimEnd() + "\n";
}

function fallbackToast(message) {
  let node = document.getElementById("board-notes-toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "board-notes-toast";
    node.setAttribute("role", "status");
    node.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#1c1d1a;color:#fdfdfb;font:13px system-ui;z-index:9999";
    document.body.append(node);
  }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(node._t);
  node._t = setTimeout(() => (node.hidden = true), 2500);
}

export async function copyBoardNotes(board) {
  const notify = async (message) => {
    try { (await import("./workspace.js")).toast(message); } catch { fallbackToast(message); }
  };
  const markdown = buildBoardNotes(board.snapshot, board.hooks);
  try {
    await navigator.clipboard.writeText(markdown);
    const count = markdown.split("\n").filter((l) => l.startsWith("- ")).length;
    await notify(`Copied ${count} note${count === 1 ? "" : "s"} from ${oneLine(board.snapshot?.title) || "this board"} as Markdown.`);
  } catch (error) {
    await notify(`Could not copy board notes. ${error.message}`);
  }
  return markdown;
}
