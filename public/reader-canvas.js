// The opened Tinka's canvas: the content window is a sheet on a plane that pans and
// zooms like a board. ⌘/Ctrl-scroll and pinch zoom the sheet about the pointer; the
// page and Tinka's own chrome never zoom. Fit returns to the fitted view (the whole
// window in sight, never past 100%) and Back returns to the view before that fit.
// Canvas zoom magnifies; it never reflows the content (Window and Type size do).
import {clampZoom, sameView, wheelZoomFactor} from './canvas-zoom.js';

// A fitted Tinka shows its window at its true size or smaller.
export const READER_FIT_MAX_ZOOM = 1;
// At least this much of the sheet stays in view however far it is panned.
const KEEP = 80;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ReaderCanvas {
  constructor(stage, plane, sheet, { onChange = () => {}, onBack = () => {}, reserveBottom = () => 0 } = {}) {
    Object.assign(this, { stage, plane, sheet, onChange, onBack, reserveBottom });
    this.view = { zoom: 1, x: 0, y: 0 };
    this.fitted = true;
    this.backView = null;
    this.glide = 0;
    this.pointers = new Map();
    this.pan = null;
    this.pinch = null;
    this.shield = document.createElement('div');
    this.shield.className = 'reader-pan-shield';
    this.shield.hidden = true;
    this.shield.setAttribute('aria-hidden', 'true');
    stage.append(this.shield);
    this.bind();
  }
  // Room around a fitted sheet (less on a phone), keeping the floating zoom pill clear of it.
  insets() {
    const pad = innerWidth <= 650 ? 10 : 24;
    return { top: pad, right: pad, left: pad, bottom: Math.max(pad, Math.round(this.reserveBottom() || 0)) };
  }
  area() { return { width: this.stage.clientWidth, height: this.stage.clientHeight }; }
  // The Fit window size fills the stage, less that room.
  fitSize() {
    const { width, height } = this.area(), i = this.insets();
    return { width: Math.max(240, Math.floor(width - i.left - i.right)), height: Math.max(200, Math.floor(height - i.top - i.bottom)) };
  }
  syncFitSize() {
    const { width, height } = this.fitSize();
    this.stage.style.setProperty('--reader-fit-w', `${width}px`);
    this.stage.style.setProperty('--reader-fit-h', `${height}px`);
  }
  fittedView() {
    const { width, height } = this.area(), i = this.insets();
    const w = Math.max(1, this.sheet.offsetWidth), h = Math.max(1, this.sheet.offsetHeight);
    const room = { width: width - i.left - i.right, height: height - i.top - i.bottom };
    const zoom = clampZoom(Math.min(READER_FIT_MAX_ZOOM, room.width / w, room.height / h));
    return { zoom, x: Math.round(i.left + (room.width - w * zoom) / 2), y: Math.round(i.top + (room.height - h * zoom) / 2) };
  }
  clamp({ zoom, x, y }) {
    const { width, height } = this.area();
    const w = this.sheet.offsetWidth * zoom, h = this.sheet.offsetHeight * zoom;
    const keepX = Math.min(KEEP, w, width / 3), keepY = Math.min(KEEP, h, height / 3);
    return { zoom, x: Math.min(width - keepX, Math.max(keepX - w, x)), y: Math.min(height - keepY, Math.max(keepY - h, y)) };
  }
  apply() {
    this.view = this.clamp(this.view);
    const { zoom, x, y } = this.view;
    this.plane.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${zoom})`;
    let step = 20 * zoom;
    while (step < 9) step *= 2;
    this.stage.style.setProperty('--reader-pattern-step', `${step}px`);
    this.stage.style.setProperty('--reader-pattern-x', `${Math.round(x)}px`);
    this.stage.style.setProperty('--reader-pattern-y', `${Math.round(y)}px`);
    this.stage.dataset.fitted = String(this.fitted);
    this.onChange(this.view);
  }
  stopGlide() { cancelAnimationFrame(this.glide); this.glide = 0; }
  // Any view change of your own ends Back.
  dropBack() { if (this.backView) { this.backView = null; this.onBack(false); } }
  // The fitted view, without remembering where you were (opening, resizing, a new window size).
  rest() { this.stopGlide(); this.fitted = true; this.syncFitSize(); this.view = this.fittedView(); this.apply(); }
  isFitted() { return sameView(this.view, this.fittedView()); }
  fit() {
    this.stopGlide();
    const before = { ...this.view };
    this.syncFitSize();
    const target = this.fittedView();
    if (sameView(before, target)) { this.fitted = true; this.apply(); return false; }
    this.backView = before;
    this.fitted = true;
    this.view = target;
    this.apply();
    this.onBack(true);
    return true;
  }
  back() {
    if (!this.backView) return false;
    const to = this.backView;
    this.backView = null;
    this.onBack(false);
    this.fitted = false;
    this.glideTo(to);
    return true;
  }
  glideTo(to) {
    this.stopGlide();
    if (reduced()) { this.view = { ...to }; this.apply(); return; }
    const from = { ...this.view }, start = performance.now();
    const frame = now => {
      const t = Math.min(1, (now - start) / 320), e = 1 - (1 - t) ** 3;
      this.view = { zoom: from.zoom + (to.zoom - from.zoom) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      this.apply();
      this.glide = t < 1 ? requestAnimationFrame(frame) : 0;
    };
    this.glide = requestAnimationFrame(frame);
  }
  // Zoom to `zoom` keeping the stage point (sx, sy) still.
  zoomTo(zoom, sx = this.stage.clientWidth / 2, sy = this.stage.clientHeight / 2) {
    this.stopGlide(); this.dropBack();
    const { zoom: z0, x, y } = this.view, z = clampZoom(zoom);
    this.fitted = false;
    this.view = { zoom: z, x: sx - (sx - x) * z / z0, y: sy - (sy - y) * z / z0 };
    this.apply();
  }
  // A zoom step about a point given in this document's client coordinates.
  zoomAtClient(factor, clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    const sx = Math.max(0, Math.min(r.width, clientX - r.left)), sy = Math.max(0, Math.min(r.height, clientY - r.top));
    this.zoomTo(this.view.zoom * factor, sx, sy);
  }
  panBy(dx, dy) {
    if (!dx && !dy) return;
    this.stopGlide(); this.dropBack();
    this.fitted = false;
    this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
    this.apply();
  }
  resize() { this.syncFitSize(); if (this.fitted) this.rest(); else this.apply(); }
  // Holding Space over the stage lets a drag anywhere pan, even when the sheet fills it.
  setSpacePan(on) { this.shield.hidden = !on; this.stage.classList.toggle('space-pan', !!on); }
  background(target) { return target === this.stage || target === this.plane || target === this.shield; }
  bind() {
    const stage = this.stage;
    stage.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); this.zoomAtClient(wheelZoomFactor(event), event.clientX, event.clientY); return; }
      if (!this.background(event.target)) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      let dx = event.deltaX * unit, dy = event.deltaY * unit;
      if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
      this.panBy(-dx, -dy);
    }, { passive: false });
    stage.addEventListener('pointerdown', event => {
      if (!this.background(event.target) || (event.pointerType === 'mouse' && event.button !== 0)) return;
      this.stopGlide();
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 1) this.pan = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false };
      else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: this.view.zoom };
        this.pan = null;
      }
    });
    stage.addEventListener('pointermove', event => {
      const point = this.pointers.get(event.pointerId);
      if (!point) return;
      const last = { ...point };
      point.x = event.clientX; point.y = event.clientY;
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const ratio = this.pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / this.pinch.distance / this.view.zoom;
        this.zoomAtClient(ratio, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (!this.pan || this.pan.id !== event.pointerId) return;
      if (!this.pan.active && Math.hypot(event.clientX - this.pan.x, event.clientY - this.pan.y) > 4) {
        this.pan.active = true; stage.classList.add('panning');
        try { stage.setPointerCapture(event.pointerId); } catch {}
      }
      if (this.pan.active) this.panBy(event.clientX - last.x, event.clientY - last.y);
    });
    const end = event => {
      if (!this.pointers.delete(event.pointerId)) return;
      if (this.pointers.size < 2) this.pinch = null;
      if (!this.pointers.size) { this.pan = null; stage.classList.remove('panning'); }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    let gestureScale = 1;
    stage.addEventListener('gesturestart', event => { event.preventDefault(); gestureScale = 1; });
    stage.addEventListener('gesturechange', event => {
      event.preventDefault();
      const scale = event.scale > 0 ? event.scale : 1;
      this.zoomAtClient(scale / gestureScale, event.clientX, event.clientY);
      gestureScale = scale;
    });
  }
}
