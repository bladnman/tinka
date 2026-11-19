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
