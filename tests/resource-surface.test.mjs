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
