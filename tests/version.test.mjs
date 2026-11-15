// Version display and the X.Y alias. Releases bump the minor only and show as X.Y;
// machinery (package.json, tags, pins, comparison) keeps X.Y.Z.
import assert from 'node:assert/strict';
import test from 'node:test';
import {displayVersion, fullVersion, parseArgs} from '../scripts/install.mjs';
import {displayVersion as shownByUpdates, newer} from '../lib/updates.mjs';

test('displayVersion drops a zero patch and keeps a real one', () => {
  assert.equal(displayVersion('1.1.0'), '1.1');
  assert.equal(displayVersion('2.0.0'), '2.0');
  assert.equal(displayVersion('0.10.0'), '0.10');
  assert.equal(displayVersion('1.0.4'), '1.0.4');
  assert.equal(displayVersion('1.1.10'), '1.1.10');
  assert.equal(displayVersion('1.1.0-rc.1'), '1.1.0-rc.1');
  assert.equal(displayVersion('1.1'), '1.1');
  assert.equal(shownByUpdates, displayVersion, 'one helper, shared by the updater');
});

test('fullVersion reads X.Y as X.Y.0 and leaves everything else alone', () => {
  assert.equal(fullVersion('1.1'), '1.1.0');
  assert.equal(fullVersion('1.1.0'), '1.1.0');
  assert.equal(fullVersion('1.0.4'), '1.0.4');
  assert.equal(fullVersion('1'), '1');
  assert.equal(fullVersion('v1.1'), 'v1.1');
  assert.equal(fullVersion(undefined), undefined);
  assert.equal(newer(fullVersion('1.1'), '1.0.4'), true);
});

test('installer and setup accept --version X.Y as X.Y.0', () => {
  assert.equal(parseArgs(['--project', '/tmp/p', '--version', '1.1'])['--version'], '1.1.0');
  assert.equal(parseArgs(['--project', '/tmp/p', '--version', '1.0.4'])['--version'], '1.0.4');
  assert.throws(() => parseArgs(['--project', '/tmp/p', '--version', '1']), /Use a version such as 1\.1/);
});
