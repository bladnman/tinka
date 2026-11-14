import test from 'node:test';
import assert from 'node:assert/strict';
import {isMacPlatform, readerCommand, stepModifierLabel} from '../public/reader-keys.js';

const key = (k, extra = {}) => ({key: k, code: extra.code || '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra});

test('platform detection prefers userAgentData, then platform', () => {
  assert.equal(isMacPlatform({userAgentData: {platform: 'macOS'}}), true);
  assert.equal(isMacPlatform({platform: 'MacIntel'}), true);
  assert.equal(isMacPlatform({platform: 'Win32'}), false);
  assert.equal(isMacPlatform({platform: 'Linux x86_64'}), false);
  assert.equal(stepModifierLabel(true), '⌥');
  assert.equal(stepModifierLabel(false), 'Ctrl+');
});

test('Mac steps with Option, Windows and Linux with Control', () => {
  assert.equal(readerCommand(key('ArrowRight', {altKey: true}), {mac: true}), 'next');
  assert.equal(readerCommand(key('ArrowLeft', {altKey: true}), {mac: true}), 'previous');
  assert.equal(readerCommand(key('ArrowUp', {altKey: true}), {mac: true}), 'up');
  assert.equal(readerCommand(key('ArrowDown', {altKey: true}), {mac: true}), 'down');
  assert.equal(readerCommand(key('ArrowRight', {ctrlKey: true}), {mac: true}), null, 'Ctrl+→ belongs to macOS Spaces');
  assert.equal(readerCommand(key('ArrowRight', {ctrlKey: true}), {mac: false}), 'next');
  assert.equal(readerCommand(key('ArrowLeft', {altKey: true}), {mac: false}), null, 'Alt+← stays browser Back on Windows');
  assert.equal(readerCommand(key('ArrowUp', {ctrlKey: true}), {mac: false}), 'up');
  assert.equal(readerCommand(key('ArrowRight', {metaKey: true}), {mac: true}), null, '⌘→ is never taken');
  assert.equal(readerCommand(key('ArrowRight', {altKey: true, shiftKey: true}), {mac: true}), null);
});

test('chords also arrive from content frames, but never inside text', () => {
  assert.equal(readerCommand(key('ArrowRight', {altKey: true}), {mac: true, fromFrame: true}), 'next');
  assert.equal(readerCommand(key('ArrowRight', {altKey: true}), {mac: true, editable: true}), null);
  assert.equal(readerCommand(key(']'), {fromFrame: true}), null, 'Brackets inside content belong to the content');
  assert.equal(readerCommand(key('ArrowRight'), {fromFrame: true, tinkaFocus: true}), null);
});

test('brackets and plain arrows are the fallback', () => {
  assert.equal(readerCommand(key(']')), 'next');
  assert.equal(readerCommand(key('[')), 'previous');
  assert.equal(readerCommand(key('[', {altKey: true}), {mac: true}), 'previous', 'Layouts that type [ with ⌥ still step');
  assert.equal(readerCommand(key(']'), {editable: true}), null);
  assert.equal(readerCommand(key('ArrowRight'), {tinkaFocus: true}), 'next');
  assert.equal(readerCommand(key('ArrowLeft'), {tinkaFocus: true}), 'previous');
  assert.equal(readerCommand(key('ArrowRight'), {tinkaFocus: false}), null, 'Plain arrows stay with other focus');
  assert.equal(readerCommand(key('ArrowRight', {shiftKey: true}), {tinkaFocus: true}), null);
});

test('view keys', () => {
  assert.equal(readerCommand(key('f')), 'fit');
  assert.equal(readerCommand(key('!', {shiftKey: true, code: 'Digit1'})), 'fit');
  assert.equal(readerCommand(key(')', {shiftKey: true, code: 'Digit0'})), 'actual-size');
  assert.equal(readerCommand(key('=', {shiftKey: false})), 'zoom-in');
  assert.equal(readerCommand(key('-')), 'zoom-out');
  assert.equal(readerCommand(key('?', {shiftKey: true, code: 'Slash'})), 'shortcuts');
  assert.equal(readerCommand(key('f'), {editable: true}), null);
  assert.equal(readerCommand(key('f', {isComposing: true})), null);
});
