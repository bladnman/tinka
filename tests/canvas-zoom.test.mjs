import test from 'node:test';
import assert from 'node:assert/strict';
import {MIN_ZOOM,MAX_ZOOM,FIT_MAX_ZOOM,clampZoom,sliderFromZoom,zoomFromSlider,wheelZoomFactor,SLIDER_STEPS} from '../public/canvas-zoom.js';

test('canvas zoom range reaches well past the old 125% ceiling and below 5%', () => {
  assert.equal(MAX_ZOOM, 10);assert.equal(MIN_ZOOM, .02);assert.equal(FIT_MAX_ZOOM, 1.25);
  assert.equal(clampZoom(50), 10);assert.equal(clampZoom(.001), .02);assert.equal(clampZoom(4), 4);
});

test('the logarithmic slider round-trips whole percents and spans the full range', () => {
  assert.equal(sliderFromZoom(MIN_ZOOM), 0);assert.equal(sliderFromZoom(MAX_ZOOM), SLIDER_STEPS);
  assert.equal(zoomFromSlider(0), MIN_ZOOM);assert.equal(zoomFromSlider(SLIDER_STEPS), MAX_ZOOM);
  for (const percent of [2, 5, 10, 25, 40, 50, 75, 80, 100, 125, 150, 200, 400, 800, 1000]) assert.equal(zoomFromSlider(sliderFromZoom(percent / 100)), percent / 100, `${percent}%`);
  // 100% sits near the middle of the track rather than at its far end.
  assert.ok(sliderFromZoom(1) > SLIDER_STEPS * .55 && sliderFromZoom(1) < SLIDER_STEPS * .75);
});

test('Control-wheel follows a Chromium trackpad pinch 1:1 and caps a mouse notch', () => {
  // Chromium encodes a pinch of scale s as Control-wheel deltaY = -100·ln(s).
  for (const scale of [1.02, 1.1, .95]) assert.ok(Math.abs(wheelZoomFactor({deltaMode:0, deltaY:-100 * Math.log(scale)}) - scale) < 1e-9);
  assert.ok(Math.abs(wheelZoomFactor({deltaMode:0, deltaY:-100}) - Math.exp(.3)) < 1e-9);
  assert.ok(Math.abs(wheelZoomFactor({deltaMode:0, deltaY:120}) - Math.exp(-.3)) < 1e-9);
  assert.ok(Math.abs(wheelZoomFactor({deltaMode:1, deltaY:-3}) - Math.exp(.3)) < 1e-9);
});
