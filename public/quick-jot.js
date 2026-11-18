// Quick Jot: a floating single-line input; each Enter adds the line as a small
// Sticky. Jots fill a tidy grid (up to 4 across, as many as fit the view, wrapping) in a clear area near the
// current view, skipping cells that would overlap anything on the board, and
// the view pans gently to keep the newest jot visible. Esc closes it.

const STYLE_ID = "quick-jot-style";
const GAP = 16, MAX_COLS = 4, JOT_W = 180, JOT_H = 140, MARGIN = 24;
const STICKY = { type: "region", shape: "rectangle", color: "palette:gold" };
let open = null;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.quick-jot{position:fixed;left:50%;bottom:var(--quick-jot-bottom,72px);transform:translateX(-50%);z-index:1000;
  display:flex;align-items:center;width:min(440px,calc(100vw - 32px));box-sizing:border-box;
  background:var(--surface-2,#fff);color:var(--ink,#23271f);border:1px solid var(--line-strong,#c8c6bb);
  border-radius:var(--r-lg,12px);box-shadow:var(--e3)}
.quick-jot:focus-within{border-color:var(--accent-ring,#62754a);box-shadow:0 0 0 1px var(--accent-ring,#62754a),var(--e3)}
.quick-jot input{flex:1;min-width:0;margin:0;border:0;border-radius:inherit;background:transparent;
  color:var(--ink,#23271f);caret-color:var(--accent-ring,#62754a);font:inherit;font-family:var(--font-ui,inherit);
  font-size:var(--t-lg,15px);padding:11px 14px;appearance:none}
html .quick-jot input,html[data-appearance] .quick-jot input:focus,html[data-appearance] .quick-jot input:focus-visible{outline:none;box-shadow:none}
.quick-jot input::placeholder{color:var(--muted,#7a7d70);opacity:1}
.quick-jot input:disabled{opacity:.7}`;
  document.head.append(style);
}

// Sit above the bottom chrome (status pill, zoom bar), whichever is tallest.
function place(form) {
  const tops = [".status-line", ".zoom-pill", ".view-tools"].map(q => document.querySelector(q))
    .filter(el => el && el.offsetParent !== null).map(el => el.getBoundingClientRect().top).filter(t => t > innerHeight / 2);
  const bottom = tops.length ? innerHeight - Math.min(...tops) + 12 : 28;
  form.style.setProperty("--quick-jot-bottom", Math.round(bottom) + "px");
}

// Everything a jot must not overlap, in board units (regions are areas stickies may sit in).
function occupied(board) {
  const snap = board.snapshot || {};
  return [...(snap.placements || []).filter(p => !p.removedAt && !p.archivedAt),
    ...(snap.decorations || []).filter(d => d.type !== "region" || d.shape)]
    .filter(r => Number.isFinite(r.x) && Number.isFinite(r.y));
}
const clear = (rects, x, y, w, h) => !rects.some(r =>
  x < r.x + (r.width || 0) + GAP && x + w + GAP > r.x && y < r.y + (r.height || 0) + GAP && y + h + GAP > r.y);

// The visible board area in board units, leaving room for the jot bar.
function viewBox(board, form) {
  const vp = document.getElementById("viewport").getBoundingClientRect();
  const bottom = Math.min(vp.bottom, form.getBoundingClientRect().top - 8);
  const a = board.canvasPoint({ x: vp.left + MARGIN, y: vp.top + MARGIN });
  const b = board.canvasPoint({ x: vp.right - MARGIN, y: bottom - MARGIN });
  return { x: a.x, y: a.y, right: b.x, bottom: b.y };
}

// First clear spot for a block of jots (up to MAX_COLS across, as many as fit the view, 2 rows): scan the view nearest its
// centre, then fall back to just right of (or below) everything on the board.
function findAnchor(board, form) {
  const rects = occupied(board), v = viewBox(board, form);
  const COLS = Math.max(1, Math.min(MAX_COLS, Math.floor((v.right - v.x + GAP) / (JOT_W + GAP))));
  const blockW = COLS * JOT_W + (COLS - 1) * GAP, blockH = 2 * JOT_H + GAP;
  const cx = (v.x + v.right) / 2, cy = (v.y + v.bottom) / 2, spots = [];
  for (let y = v.y; y + JOT_H <= v.bottom; y += 20)
    for (let x = v.x; x + JOT_W <= v.right; x += 20)
      if (clear(rects, x, y, Math.min(blockW, v.right - x), Math.min(blockH, Math.max(JOT_H, v.bottom - y)))) spots.push({ x, y, full: x + blockW <= v.right && clear(rects, x, y, blockW, blockH) });
  spots.sort((p, q) => (q.full - p.full) || Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy));
  if (spots.length) return { x: Math.round(spots[0].x), y: Math.round(spots[0].y), cols: COLS };
  const right = rects.length ? Math.max(...rects.map(r => r.x + (r.width || 0))) + 48 : v.x;
  return { x: Math.round(right), y: Math.round(v.y), cols: COLS };
}

// Next grid cell from the anchor that overlaps nothing.
function nextCell(board, layout) {
  const rects = occupied(board);
  for (;; layout.index++) {
    const cols = layout.anchor.cols, col = layout.index % cols, row = Math.floor(layout.index / cols);
    const x = layout.anchor.x + col * (JOT_W + GAP), y = layout.anchor.y + row * (JOT_H + GAP);
    if (clear(rects, x, y, JOT_W, JOT_H)) { layout.index++; return { x, y }; }
    if (layout.index > 400) { layout.index++; return { x, y }; }
  }
}

// Pan just enough that the jot sits inside the view, above the jot bar.
function reveal(board, id, form) {
  const el = document.querySelector(`[data-decoration="${CSS.escape(id)}"]`);
  if (!el || !board.hooks.shiftViewport) return;
  const r = el.getBoundingClientRect(), vp = document.getElementById("viewport").getBoundingClientRect();
  const bottom = Math.min(vp.bottom, form.getBoundingClientRect().top - 8);
  let dx = 0, dy = 0;
  if (r.bottom > bottom - MARGIN) dy = (bottom - MARGIN) - r.bottom;
  if (r.top + dy < vp.top + MARGIN) dy = vp.top + MARGIN - r.top;
  if (r.right > vp.right - MARGIN) dx = vp.right - MARGIN - r.right;
  if (r.left + dx < vp.left + MARGIN) dx = vp.left + MARGIN - r.left;
  if (dx || dy) board.hooks.shiftViewport(dx, dy);
}

export function openQuickJot(board) {
  if (open) { open.input.focus(); return open; }
  injectStyle();
  const form = document.createElement("form");
  form.className = "quick-jot";
  form.innerHTML = `<input type="text" aria-label="Quick jot" placeholder="Jot a note… Enter adds, Esc closes" autocomplete="off">`;
  const input = form.querySelector("input");
  let layout = null, queue = Promise.resolve();

  const onResize = () => place(form);
  const close = () => { form.remove(); removeEventListener("resize", onResize); open = null; };
  form.addEventListener("keydown", e => {
    e.stopPropagation(); // keep board hotkeys (T, S, D, N…) out of the input
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; // keep typing; jots save in order
    queue = queue.then(() => add(text));
  });
  const add = async text => {
    try {
      if (board.mode !== "canvas") board.setMode("canvas");
      board.whiteboard?.commitEdit?.({ focus: false });
      if (!layout) layout = { anchor: findAnchor(board, form), index: 0 };
      const cell = nextCell(board, layout);
      const d = { id: crypto.randomUUID(), ...STICKY, x: cell.x, y: cell.y, width: JOT_W, height: JOT_H, text };
      await board.client.write("createDecoration", { boardId: board.snapshot.id, decoration: d });
      // No lingering selection or handles: nothing is active after a jot.
      board.whiteboard?.clearSelection?.({ finishEdit: false });
      board.activeDecoration = null; board.selection?.clear?.();
      await board.refresh({ saveReview: false });
      if (open) reveal(board, d.id, form);
    } catch (error) {
      console.error("Quick Jot could not add a sticky", error);
      if (open && !input.value) input.value = text; // keep the words to retry
    } finally {
      if (open && document.activeElement !== input) input.focus({ preventScroll: true });
    }
  };
  document.body.append(form);
  place(form); addEventListener("resize", onResize);
  input.focus();
  open = { form, input, close };
  return open;
}
