import assert from 'node:assert/strict';
import test from 'node:test';
import {ReaderCanvas, resourceSize} from '../public/reader-canvas.js';

test('resource dimensions reject invalid input and bound decoded images without changing aspect', () => {
  for (const pair of [[NaN, 20], [Infinity, 20], [20, 0], [-1, 20], ['400', 200]]) assert.equal(resourceSize(...pair), null);
  assert.deepEqual(resourceSize(2360, 1822), {width:2360, height:1822});
  assert.deepEqual(resourceSize(32768, 16384), {width:16384, height:8192});
});
test('resource pan never exposes empty canvas beyond a large surface and centers a small one', () => {
  const canvas = {area:() => ({width:1000,height:800}), sheet:{offsetWidth:2360,offsetHeight:1822}};
  const clamp = view => ReaderCanvas.prototype.clamp.call(canvas, view);
  assert.deepEqual(clamp({zoom:1,x:400,y:100}), {zoom:1,x:0,y:0});
  assert.deepEqual(clamp({zoom:1,x:-9999,y:-9999}), {zoom:1,x:-1360,y:-1022});
  assert.deepEqual(clamp({zoom:.25,x:400,y:-9999}), {zoom:.25,x:205,y:172.25});
});
test('Fill takes the whole stage at 100%, less a reserved right edge, and Fit or zoom leave it', () => {
  const calls = [];
  const canvas = Object.assign(Object.create(ReaderCanvas.prototype), {fill:true, area:() => ({width:1920,height:968}), reserveRight:() => 384, sheet:{offsetWidth:1536,offsetHeight:968}, onLeaveFill:() => calls.push('leave')});
  const call = (name, ...args) => canvas[name](...args);
  assert.deepEqual(call('fitSize'), {width:1536, height:968});
  assert.deepEqual(call('fittedView'), {zoom:1, x:0, y:0});
  // Pinned to the stage's top left (never centered beside the Inspector) and never zoomed.
  assert.deepEqual(call('clamp', {zoom:2.5, x:300, y:-40}), {zoom:1, x:0, y:0});
  canvas.reserveRight = () => 0; canvas.sheet = {offsetWidth:1920,offsetHeight:968};
  assert.deepEqual(call('fitSize'), {width:1920, height:968});
  assert.equal(call('leaveFill'), true);
  assert.deepEqual(calls, ['leave']);
  assert.equal(canvas.fill, false);
  assert.equal(call('leaveFill'), false, 'Leaving Fill twice does nothing');
  // Out of Fill, the saved surface fits as before.
  canvas.resourceSize = {width:1000, height:720};
  assert.deepEqual(call('fitSize'), {width:1000, height:720});
});
test('Fit width fills a page to its width from the top; Fit page frames all of it; neither passes 100%', () => {
  const fitted = (fitMode, w, h, area = {width:1440, height:948}) => ReaderCanvas.prototype.fittedView.call({fill:false, fitMode, area:() => area, insets:() => ({top:0,right:0,bottom:0,left:0}), sheet:{offsetWidth:w, offsetHeight:h}});
  // A tall page saved at 1440 × 6000 reads at 100% from its top, instead of 15.8% whole.
  assert.deepEqual(fitted('width', 1440, 6000), {zoom:1, x:0, y:0});
  assert.ok(Math.abs(fitted('page', 1440, 6000).zoom - 948/6000) < 1e-9);
  // A 2360 × 1822 HTML chart fits its width (61%), top first; as a page it would be height-bound (52%).
  const chart = fitted('width', 2360, 1822);
  assert.ok(Math.abs(chart.zoom - 1440/2360) < 1e-9);
  assert.deepEqual([chart.x, chart.y], [0, 0]);
  assert.ok(Math.abs(fitted('page', 2360, 1822).zoom - 948/1822) < 1e-9);
  // Something that fits either way is centered, and small content never magnifies.
  assert.deepEqual(fitted('width', 1000, 720), {zoom:1, x:220, y:114});
  assert.deepEqual(fitted('width', 1000, 720), fitted('page', 1000, 720));
  // Wide, short content is width-bound in both modes; on a phone the fitted chart is short enough to center.
  assert.deepEqual(fitted('width', 3000, 600), fitted('page', 3000, 600));
  const phone = fitted('width', 2360, 1822, {width:390, height:700});
  assert.ok(Math.abs(phone.zoom - 390/2360) < 1e-9 && phone.y === Math.round((700 - 1822 * 390/2360) / 2));
});
