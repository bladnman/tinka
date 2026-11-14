// The board map: every rendered item and region drawn once as silhouettes on one
// canvas, the current view as a frame and the selection in the accent green.
// Outlines redraw only when content, selection or theme change; panning moves only
// the frame. The map owns its pointer, wheel and key gestures, so nothing it does
// reaches the board underneath. All coordinates it exchanges are world units.
import {wheelZoomFactor} from './canvas-zoom.js';

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Fit the content bounds into a box at most `width` wide and `maxHeight` tall.
export function mapBox(bounds, { width = 248, maxHeight = 200, minHeight = 96 } = {}) {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const pad = Math.max(bounds.width, bounds.height) * .04;
  const w = bounds.width + pad * 2, h = bounds.height + pad * 2;
  const H = Math.round(Math.max(minHeight, Math.min(maxHeight, width * h / w)));
  const s = Math.min(width / w, H / h);
  return { x: bounds.x - pad - (width - w * s) / 2 / s, y: bounds.y - pad - (H - h * s) / 2 / s, s, W: width, H };
}

export class BoardMap {
  constructor(el, hooks) {
    this.el = el; this.hooks = hooks;
    this.stage = el.querySelector('.board-map-stage');
    this.canvas = this.stage.querySelector('canvas');
    this.frame = this.stage.querySelector('.board-map-frame');
    this.ctx = this.canvas.getContext('2d');
    this.visible = false; this.dirty = true; this.box = null; this.raf = 0; this.drag = null;
    this.bindPointer(); this.bindKeys();
    // Theme changes recolour the silhouettes.
    new MutationObserver(() => this.invalidate()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance'] });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.invalidate()); } catch {}
  }
  show(on) {
    on = !!on;
    if (on === this.visible) return;
    this.visible = on;
    this.el.hidden = !on;
    if (!on) this.endDrag();
    if (on) this.layout();
  }
  // Content or selection changed: redraw once on the next frame (or when shown).
  invalidate() {
    this.dirty = true;
    if (!this.visible || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.visible) this.layout(); });
  }
  // The map's size follows the window width; the drawing follows the content.
  layout() {
    this.shapes = this.hooks.shapes();
    const narrow = innerWidth <= 720;
    const box = mapBox(this.shapes.bounds, { width: narrow ? 220 : 248, maxHeight: narrow ? 150 : 200 });
    const W = box?.W || (narrow ? 220 : 248), H = box?.H || 96;
    const dpr = devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    }
    this.canvas.style.width = `${W}px`; this.canvas.style.height = `${H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.box = box;
    this.draw();
    this.syncFrame();
  }
  // A narrow/wide crossing resizes the map; otherwise nothing needs drawing.
  resize() {
    if (!this.visible) return;
    const want = innerWidth <= 720 ? 220 : 248;
    if (!this.box || this.box.W !== want) this.layout(); else this.syncFrame();
  }
  draw() {
    this.dirty = false;
    const c = this.ctx, box = this.box, { items = [], decorations = [] } = this.shapes || {};
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const css = getComputedStyle(this.el), token = name => css.getPropertyValue(name).trim();
    const selectedCount = items.filter(item => item.selected).length;
    this.stage.setAttribute('aria-label', `Board map: ${items.length} ${items.length === 1 ? 'item' : 'items'}${selectedCount ? `, ${selectedCount} selected` : ''}. Arrow keys move the view, plus and minus zoom; click or drag to move there.`);
    if (!box) { this.frame.hidden = true; return; }
    const shape = (r, radius) => {
      const x = (r.x - box.x) * box.s, y = (r.y - box.y) * box.s;
      const w = Math.max(1.5, r.width * box.s), h = Math.max(1.5, r.height * box.s);
      c.beginPath();
      if (c.roundRect) c.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2)); else c.rect(x, y, w, h);
    };
    const sage = token('--sage') || '#899477';
    for (const d of decorations) {
      if (d.type === 'line') continue;
      const color = HEX.test(d.color || '') ? d.color : sage;
      shape(d, d.type === 'region' ? 3 : 1);
      c.globalAlpha = d.type === 'region' ? .3 : .15; c.fillStyle = color; c.fill();
      c.globalAlpha = .55; c.strokeStyle = color; c.lineWidth = 1; c.stroke();
      c.globalAlpha = 1;
    }
    const fill = token('--line-strong'), edge = token('--field-line'), accent = token('--accent');
    for (const item of items) {
      if (item.selected) continue;
      shape(item, 1.5); c.fillStyle = fill; c.fill();
      c.strokeStyle = edge; c.lineWidth = .75; c.stroke();
    }
    for (const item of items) {
      if (!item.selected) continue;
      shape(item, 1.5); c.fillStyle = accent; c.fill();
    }
  }
  syncFrame() {
    if (!this.visible || !this.box) return;
    const v = this.hooks.view(), box = this.box;
    this.frame.hidden = false;
    const x = (-v.x / v.zoom - box.x) * box.s, y = (-v.y / v.zoom - box.y) * box.s;
    const w = Math.max(4, v.width / v.zoom * box.s), h = Math.max(4, v.height / v.zoom * box.s);
    const style = this.frame.style;
    style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    style.width = `${w.toFixed(1)}px`; style.height = `${h.toFixed(1)}px`;
  }
  toWorld(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: this.box.x + (clientX - r.left) / this.box.s, y: this.box.y + (clientY - r.top) / this.box.s };
  }
  endDrag() {
    if (!this.drag) return;
    try { this.stage.releasePointerCapture(this.drag.id); } catch {}
    this.drag = null;
    this.stage.classList.remove('dragging');
  }
  bindPointer() {
    const stage = this.stage;
    stage.addEventListener('pointerdown', event => {
      event.stopPropagation();
      if (!this.box || this.drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      try { stage.setPointerCapture(event.pointerId); } catch {}
      stage.focus({ preventScroll: true });
      const f = this.frame.getBoundingClientRect();
      const inside = event.clientX >= f.left - 2 && event.clientX <= f.right + 2 && event.clientY >= f.top - 2 && event.clientY <= f.bottom + 2;
      const start = this.toWorld(event.clientX, event.clientY);
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start, last: start, inside, moved: false };
      stage.classList.add('dragging');
      this.hooks.navigate();
    });
    stage.addEventListener('pointermove', event => {
      const drag = this.drag;
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
        drag.moved = true;
        // A drag that starts outside the frame first brings the view there.
        if (!drag.inside) this.hooks.center(drag.start.x, drag.start.y, { glide: false });
      }
      const point = this.toWorld(event.clientX, event.clientY);
      this.hooks.panBy(point.x - drag.last.x, point.y - drag.last.y);
      drag.last = point;
    });
    const finish = (event, jump) => {
      const drag = this.drag;
      if (!drag || drag.id !== event.pointerId) return;
      event.stopPropagation();
      this.endDrag();
      // A click or tap jumps there at the same zoom.
      if (jump && !drag.moved) this.hooks.center(drag.start.x, drag.start.y, { glide: true });
    };
    stage.addEventListener('pointerup', event => finish(event, true));
    stage.addEventListener('pointercancel', event => finish(event, false));
    stage.addEventListener('lostpointercapture', event => finish(event, false));
    stage.addEventListener('click', event => event.stopPropagation());
    // Scrolling over the map zooms the board about that spot; it never pans the board twice.
    stage.addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      if (!this.box) return;
      const point = this.toWorld(event.clientX, event.clientY);
      this.hooks.zoomAt(wheelZoomFactor(event), point.x, point.y);
    }, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
  }
  bindKeys() {
    this.stage.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const step = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
      if (step) this.hooks.panScreen(step[0] * .25, step[1] * .25);
      else if (event.key === '+' || event.key === '=') this.hooks.zoomBy(1.25);
      else if (event.key === '-' || event.key === '_') this.hooks.zoomBy(1 / 1.25);
      else if (event.key === 'Escape' && !event.repeat && !event.defaultPrevented) this.hooks.close();
      else return;
      event.preventDefault(); event.stopPropagation();
    });
  }
}
