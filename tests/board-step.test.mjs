import test from 'node:test';
import assert from 'node:assert/strict';
import {boardStepCommand, boardStepTarget, isSteppable} from '../public/board-step.js';

const key = (k, extra = {}) => ({key: k, code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra});

test('board steps take the opened Tinka chord only: ⌥←/→ on a Mac, Ctrl+←/→ elsewhere', () => {
  assert.equal(boardStepCommand(key('ArrowRight', {altKey: true}), {mac: true}), 'next');
  assert.equal(boardStepCommand(key('ArrowLeft', {altKey: true}), {mac: true}), 'previous');
  assert.equal(boardStepCommand(key('ArrowRight', {ctrlKey: true}), {mac: false}), 'next');
  assert.equal(boardStepCommand(key('ArrowRight', {ctrlKey: true}), {mac: true}), null, 'Ctrl+→ stays macOS Spaces');
  assert.equal(boardStepCommand(key('ArrowLeft', {altKey: true}), {mac: false}), null, 'Alt+← stays browser Back');
  assert.equal(boardStepCommand(key('ArrowRight'), {mac: true}), null, 'plain arrows keep nudging the selection');
  assert.equal(boardStepCommand(key('ArrowUp', {altKey: true}), {mac: true}), null, 'up and down are the opened Tinka’s');
  assert.equal(boardStepCommand(key(']'), {mac: true}), null);
  assert.equal(boardStepCommand(key('f'), {mac: true}), null);
  assert.equal(boardStepCommand(key('ArrowRight', {altKey: true, shiftKey: true}), {mac: true}), null);
  assert.equal(boardStepCommand(key('ArrowRight', {altKey: true}), {mac: true, editable: true}), null, 'text fields keep the chord');
});

test('the board skips what the stepper skips', () => {
  assert.equal(isSteppable({title: 'Idea'}), true);
  assert.equal(isSteppable({content: {kind: 'html'}, build: {state: 'review'}}), true);
  assert.equal(isSteppable({build: {state: 'reserved'}}), false);
  assert.equal(isSteppable({build: {state: 'building'}}), false);
  assert.equal(isSteppable({childBoardId: 'b'}), false, 'a board-only Tinka opens its board');
  assert.equal(isSteppable({childBoardId: 'b', content: {kind: 'html'}}), true);
  assert.equal(isSteppable(null), false);
});

test('next and previous follow the order, start at the ends and stop there', () => {
  const order = ['a', 'b', 'skip', 'c', 'd'].map(id => ({id}));
  const steppable = entry => entry.id !== 'skip';
  const step = (selected, direction) => boardStepTarget(order, {selected: new Set(selected), direction, steppable})?.id ?? null;
  assert.equal(step([], 1), 'a', 'nothing selected: next starts at the first');
  assert.equal(step([], -1), 'd', 'nothing selected: previous starts at the last');
  assert.equal(step(['a'], 1), 'b');
  assert.equal(step(['b'], 1), 'c', 'skipped entries are passed over');
  assert.equal(step(['c'], -1), 'b');
  assert.equal(step(['d'], 1), null, 'stops at the end');
  assert.equal(step(['a'], -1), null, 'stops at the start');
  assert.equal(step(['skip'], 1), 'c', 'from a selected entry the stepper skips, the next one along');
  assert.equal(step(['skip'], -1), 'b');
  assert.equal(step(['b', 'd'], -1), 'a', 'with several selected, previous goes back from the first');
  assert.equal(step(['a', 'c'], 1), 'd', 'and next goes on from the last');
  assert.equal(step(['sticky'], 1), 'a', 'a selection outside the order counts as nothing selected');
  assert.equal(boardStepTarget([], {direction: 1}), null);
});
