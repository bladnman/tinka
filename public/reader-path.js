// "Where you are" for an opened Tinka: hovering the title (after a short delay) or
// clicking it shows the path from Home down to this Tinka and its own board, then a
// numbered list of what sits beside it on this board. Clicking pins it open, a tap
// works on touch, and a row navigates. The ‹ n / N › count opens the same list.
const HOVER_DELAY = 260;
const LEAVE_DELAY = 320;

export class ReaderPath {
  constructor(pop, { anchors, render, go }) {
    Object.assign(this, { pop, anchors, render, go });
    this.anchor = null;
    this.pinned = false;
    this.hoverTimer = 0;
    this.leaveTimer = 0;
    for (const anchor of anchors) {
      anchor.addEventListener('click', event => {
        if (this.anchor === anchor && this.pinned && !this.pop.hidden) { this.close({ focus: false }); return; }
        this.open(anchor, { pinned: true, focus: event.detail === 0 });
      });
      if (anchor.dataset.pathHover === 'false') continue;
      anchor.addEventListener('pointerenter', event => {
        if (event.pointerType === 'touch') return;
        clearTimeout(this.leaveTimer); clearTimeout(this.hoverTimer);
        if (this.anchor !== anchor || this.pop.hidden) this.hoverTimer = setTimeout(() => this.open(anchor), HOVER_DELAY);
      });
      anchor.addEventListener('pointerleave', () => { clearTimeout(this.hoverTimer); this.leaveSoon(); });
    }
    pop.addEventListener('pointerenter', () => clearTimeout(this.leaveTimer));
    pop.addEventListener('pointerleave', () => this.leaveSoon());
    pop.addEventListener('click', event => {
      const row = event.target.closest('[data-path-go]');
      if (!row || row.disabled) return;
      event.preventDefault();
      const target = row.dataset.pathGo;
      this.close({ focus: false });
      this.go(target, row);
    });
    pop.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const rows = [...pop.querySelectorAll('[data-path-go]:not(:disabled)')];
      if (!rows.length) return;
      const index = rows.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      event.preventDefault();
      rows[next].focus({ preventScroll: false });
    });
  }
  get isOpen() { return !this.pop.hidden; }
  leaveSoon() {
    if (this.pinned || this.pop.hidden) return;
    clearTimeout(this.leaveTimer);
    this.leaveTimer = setTimeout(() => {
      if (this.pinned || this.pop.matches(':hover') || this.anchor?.matches(':hover') || this.pop.contains(document.activeElement)) return;
      this.close({ focus: false });
    }, LEAVE_DELAY);
  }
  open(anchor, { pinned = false, focus = false } = {}) {
    clearTimeout(this.hoverTimer); clearTimeout(this.leaveTimer);
    if (this.anchor && this.anchor !== anchor) this.anchor.setAttribute('aria-expanded', 'false');
    this.anchor = anchor;
    this.pinned = this.pinned && !this.pop.hidden ? true : pinned;
    this.pop.innerHTML = this.render(anchor);
    this.pop.hidden = false;
    this.pop.dataset.pinned = String(this.pinned);
    anchor.setAttribute('aria-expanded', 'true');
    this.place();
    if (focus) (this.pop.querySelector(anchor.dataset.pathFocus || '[aria-current="true"]') || this.pop.querySelector('[data-path-go]'))?.focus({ preventScroll: false });
  }
  // Re-render in place, for example after stepping with the keys while it is open.
  // Keeps keyboard focus on the same row across the re-render.
  refresh() {
    if (!this.isOpen || !this.anchor) return;
    const focused = this.pop.contains(document.activeElement) ? document.activeElement.dataset.pathGo : null;
    this.pop.innerHTML = this.render(this.anchor);
    this.place();
    if (focused) [...this.pop.querySelectorAll('[data-path-go]')].find(row => row.dataset.pathGo === focused)?.focus({ preventScroll: true });
  }
  place() {
    const r = this.anchor.getBoundingClientRect();
    const width = this.pop.offsetWidth;
    this.pop.style.top = `${Math.round(r.bottom + 6)}px`;
    this.pop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - width - 8, r.left)))}px`;
    this.pop.style.maxHeight = `${Math.max(160, Math.round(innerHeight - r.bottom - 18))}px`;
    this.pop.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }
  close({ focus = true } = {}) {
    clearTimeout(this.hoverTimer); clearTimeout(this.leaveTimer);
    if (this.pop.hidden) return false;
    const anchor = this.anchor;
    this.pop.hidden = true;
    this.pop.innerHTML = '';
    this.pinned = false;
    anchor?.setAttribute('aria-expanded', 'false');
    if (focus) anchor?.focus({ preventScroll: true });
    return true;
  }
}
