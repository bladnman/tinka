// Quick Jot: a floating single-line input that adds each Enter'd line as a
// Sticky, stacked in a column below the previous jot. Esc closes it.
// Text is saved through the whiteboard editor session that createDecoration
// opens, so it follows the same draft/save path as typing into the sticky.

const STYLE_ID = "quick-jot-style";
const GAP = 16;
let open = null;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.quick-jot{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1000;
  display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:12px;
  background:var(--panel,#fffdf6);box-shadow:0 6px 24px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.08)}
.quick-jot input{width:min(420px,70vw);font:inherit;font-size:15px;padding:8px 10px;border-radius:8px;
  border:1px solid rgba(0,0,0,.18);background:#fff;color:#222;outline:none}
.quick-jot input:focus{border-color:#6c8060;box-shadow:0 0 0 2px rgba(108,128,96,.25)}
.quick-jot input:disabled{opacity:.6}`;
  document.head.append(style);
}

// Inverse of board.canvasPoint: board units -> screen (client) point.
function screenPoint(board, canvas) {
  const world = document.getElementById("world").getBoundingClientRect();
  const zoom = board.hooks.zoom(), origin = board.origin || { x: 0, y: 0 };
  return { x: world.left + (canvas.x + origin.x) * zoom, y: world.top + (canvas.y + origin.y) * zoom };
}

function firstPoint(board) {
  const vp = document.getElementById("viewport").getBoundingClientRect();
  const zoom = board.hooks.zoom();
  return { x: vp.left + vp.width / 2 - 110 * zoom, y: vp.top + 40 };
}

export function openQuickJot(board) {
  if (open) { open.input.focus(); return open; }
  injectStyle();
  const form = document.createElement("form");
  form.className = "quick-jot";
  form.innerHTML = `<input type="text" aria-label="Quick jot" placeholder="Jot a note… Enter adds, Esc closes" autocomplete="off">`;
  const input = form.querySelector("input");
  let last = null, busy = false;

  const close = () => { form.remove(); open = null; };
  form.addEventListener("keydown", e => {
    e.stopPropagation(); // keep board hotkeys (T, S, D, N…) out of the input
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; input.disabled = true;
    try {
      const point = last ? screenPoint(board, { x: last.x, y: last.y + last.height + GAP }) : firstPoint(board);
      await board.createDecoration("sticky", point);
      const id = board.activeDecoration;
      const wb = board.whiteboard, session = wb?.editor;
      if (session && session.id === id) {
        session.textarea.value = text;
        wb.commitEdit({ focus: false }); // same path as finishing an edit in the sticky
      }
      const d = (board.snapshot?.decorations || []).find(x => x.id === id);
      if (d) last = { x: d.x, y: d.y, height: d.height };
      input.value = "";
    } finally {
      busy = false; input.disabled = false;
      if (open) input.focus({ preventScroll: true });
    }
  });
  document.body.append(form);
  input.focus();
  open = { form, input, close };
  return open;
}
