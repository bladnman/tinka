// Smart guides: while a box moves or resizes, its edges and centre snap to other
// objects' edges and centres within a few screen pixels, and thin guide lines show
// what it lines up with. A box sitting midway between two neighbours in a row or
// column also snaps there and shows equal-spacing marks. All geometry is in board
// units; the layer draws in screen space over the canvas.

const lines = box => [box.x, box.x + box.width / 2, box.x + box.width];
const rows = box => [box.y, box.y + box.height / 2, box.y + box.height];
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// Best offset bringing one of `moving` values onto one of `targets` values.
function nearest(moving, targets, threshold) {
  let best = null;
  for (const m of moving) for (const t of targets) {
    const d = t - m;
    if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}

// Midway between the nearest neighbour on each side that shares the cross axis.
function spacing(box, others, axis, threshold) {
  const [pos, size, cross, crossSize] = axis === "x" ? ["x","width","y","height"] : ["y","height","x","width"];
  const shared = others.filter(o => overlaps(o[cross], o[cross] + o[crossSize], box[cross], box[cross] + box[crossSize]));
  const before = shared.filter(o => o[pos] + o[size] <= box[pos] + threshold).sort((a,b) => (b[pos] + b[size]) - (a[pos] + a[size]))[0];
  const after = shared.filter(o => o[pos] >= box[pos] + box[size] - threshold).sort((a,b) => a[pos] - b[pos])[0];
  if (!before || !after) return null;
  const free = after[pos] - (before[pos] + before[size]) - box[size];
  if (free <= 0) return null;
  const target = before[pos] + before[size] + free / 2, d = target - box[pos];
  return Math.abs(d) <= threshold ? {d, before, after, gap:free / 2} : null;
}

/**
 * Snap a moving box. Returns {dx, dy, guides} where guides are segments in board
 * units: {x1,y1,x2,y2,kind:"align"|"space"}. `resize:true` snaps right and
 * bottom. A direction such as "nw" instead snaps only the moving edges.
 */
export function snapBox(box, others, threshold, {resize = false} = {}) {
  const direction = resize === true ? "se" : resize;
  const west = direction && direction.includes("w"), north = direction && direction.includes("n");
  const edgeX = b => west ? [b.x] : direction.includes("e") ? [b.x + b.width] : [];
  const edgeY = b => north ? [b.y] : direction.includes("s") ? [b.y + b.height] : [];
  const movingX = resize ? edgeX(box) : lines(box), movingY = resize ? edgeY(box) : rows(box);
  let dx = nearest(movingX, others.flatMap(lines), threshold), dy = nearest(movingY, others.flatMap(rows), threshold);
  let spaceX = null, spaceY = null;
  if (!resize) {
    spaceX = spacing(box, others, "x", threshold); spaceY = spacing(box, others, "y", threshold);
    if (spaceX && (dx === null || Math.abs(spaceX.d) < Math.abs(dx))) dx = spaceX.d; else spaceX = null;
    if (spaceY && (dy === null || Math.abs(spaceY.d) < Math.abs(dy))) dy = spaceY.d; else spaceY = null;
  }
  dx ??= 0; dy ??= 0;
  const snapped = resize
    ? {x:box.x+(west?dx:0),y:box.y+(north?dy:0),width:box.width+(west?-dx:dx),height:box.height+(north?-dy:dy)}
    : {...box, x:box.x + dx, y:box.y + dy};
  const guides = [];
  const near = (a, b) => Math.abs(a - b) < 0.5;
  if (dx || !resize) for (const x of resize ? edgeX(snapped) : lines(snapped)) {
    const hits = others.filter(o => lines(o).some(v => near(v, x)));
    if (!hits.length || spaceX) continue;
    const ys = [snapped.y, snapped.y + snapped.height, ...hits.flatMap(o => [o.y, o.y + o.height])];
    guides.push({x1:x, y1:Math.min(...ys), x2:x, y2:Math.max(...ys), kind:"align"});
  }
  if (dy || !resize) for (const y of resize ? edgeY(snapped) : rows(snapped)) {
    const hits = others.filter(o => rows(o).some(v => near(v, y)));
    if (!hits.length || spaceY) continue;
    const xs = [snapped.x, snapped.x + snapped.width, ...hits.flatMap(o => [o.x, o.x + o.width])];
    guides.push({x1:Math.min(...xs), y1:y, x2:Math.max(...xs), y2:y, kind:"align"});
  }
  // Spacing marks run through the box's middle; an alignment line there would hide them.
  const hidden = (g, axis, v) => g.kind === "align" && (axis === "y" ? g.y1 === g.y2 && Math.abs(g.y1 - v) < 0.5 : g.x1 === g.x2 && Math.abs(g.x1 - v) < 0.5);
  if (spaceX) for (let i = guides.length - 1; i >= 0; i--) if (hidden(guides[i], "y", snapped.y + snapped.height / 2)) guides.splice(i, 1);
  if (spaceY) for (let i = guides.length - 1; i >= 0; i--) if (hidden(guides[i], "x", snapped.x + snapped.width / 2)) guides.splice(i, 1);
  if (spaceX) {
    const y = snapped.y + snapped.height / 2;
    guides.push({x1:spaceX.before.x + spaceX.before.width, y1:y, x2:snapped.x, y2:y, kind:"space"},
      {x1:snapped.x + snapped.width, y1:y, x2:spaceX.after.x, y2:y, kind:"space"});
  }
  if (spaceY) {
    const x = snapped.x + snapped.width / 2;
    guides.push({x1:x, y1:spaceY.before.y + spaceY.before.height, x2:x, y2:snapped.y, kind:"space"},
      {x1:x, y1:snapped.y + snapped.height, x2:x, y2:spaceY.after.y, kind:"space"});
  }
  return {dx, dy, guides};
}

// The union of several boxes.
export function boundsOf(boxes) {
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return {x, y, width:Math.max(...boxes.map(b => b.x + b.width)) - x, height:Math.max(...boxes.map(b => b.y + b.height)) - y};
}

// Snapping is on unless ⌘ (macOS) or Ctrl (elsewhere) is held during the drag.
export const snapDisabled = (event, mac) => mac ? !!event?.metaKey : !!event?.ctrlKey;

/** Draws guides over the canvas. toScreen maps a board point to client pixels. */
export class GuideLayer {
  constructor() { this.el = null; }
  show(guides, toScreen) {
    if (!guides?.length) { this.hide(); return; }
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "snap-guides"; this.el.setAttribute("aria-hidden", "true");
      document.body.append(this.el);
    }
    this.el.innerHTML = guides.map(g => {
      const a = toScreen({x:g.x1, y:g.y1}), b = toScreen({x:g.x2, y:g.y2});
      const vertical = Math.abs(a.x - b.x) < 0.5;
      const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
      const style = vertical ? `left:${left}px;top:${top}px;height:${Math.abs(b.y - a.y)}px` : `left:${left}px;top:${top}px;width:${Math.abs(b.x - a.x)}px`;
      return `<i class="snap-guide ${vertical ? "snap-v" : "snap-h"} snap-${g.kind}" style="${style}"></i>`;
    }).join("");
  }
  hide() { this.el?.remove(); this.el = null; }
}
