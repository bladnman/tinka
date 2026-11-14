// Board Canvas zoom range and the zoom slider's scale. No DOM, so tests can share it.
export const MIN_ZOOM = .02;
export const MAX_ZOOM = 10;
// Fit board / Fit selection frame work; they never magnify past this, so a small
// board is not blown up (board overview relies on it too).
export const FIT_MAX_ZOOM = 1.25;
export const clampZoom = value => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
// The slider is logarithmic so 2%–1000% stays precise everywhere: each of its
// SLIDER_STEPS is the same zoom ratio (about 0.6%).
export const SLIDER_STEPS = 1000;
const span = Math.log(MAX_ZOOM / MIN_ZOOM);
export const sliderFromZoom = value => Math.round(SLIDER_STEPS * Math.log(clampZoom(value) / MIN_ZOOM) / span);
// Slider positions land on readable percents (tenths below 10%, fives from 150%),
// so 100 is exactly 1 and every whole percent up to 149% can be reached.
export function zoomFromSlider(position) {
  const percent = 100 * MIN_ZOOM * Math.exp(span * Math.max(0, Math.min(SLIDER_STEPS, Number(position) || 0)) / SLIDER_STEPS);
  const unit = percent < 10 ? .1 : percent < 150 ? 1 : 5;
  return clampZoom(Math.round(Math.round(percent / unit) * unit * 10) / 1000);
}
// A Control/⌘-wheel step as a zoom ratio. Chromium and Edge report a trackpad
// pinch as Control-wheel with deltaY = -100·ln(scale), so this follows the fingers
// exactly; a mouse wheel notch is capped at the same 1.35× step as before.
export function wheelZoomFactor(event) {
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY;
  return Math.exp(-Math.max(-30, Math.min(30, delta)) / 100);
}
// A board counts as large, so its map opens by itself on desktop widths, when
// fitting all of it would need less than this zoom.
export const LARGE_BOARD_ZOOM = .4;
// Two views match when pan and zoom agree to within rounding.
export const sameView = (a, b) => !!a && !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 1e-4;
