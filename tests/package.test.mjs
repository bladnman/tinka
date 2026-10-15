import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { buildRelease } from '../scripts/package.mjs';
import { installArchive, main, readSafeZip } from '../skill/tinka/scripts/install.mjs';

const exec = promisify(execFile);
async function releaseFixture() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'board-room-package-')));
  const release = await buildRelease({ outDir: path.join(temporary, 'release') });
  const zipBytes = await readFile(release.appZip);
  const checksumText = await readFile(release.appChecksum, 'utf8');
  return { temporary, release, zipBytes, checksumText, zipName: path.basename(release.appZip) };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('release archives contain only the app allowlist and the separate installer skill', async () => {
  const fixture = await releaseFixture();
  try {
    const names = readSafeZip(fixture.zipBytes).map(entry => entry.relative);
    assert(names.includes('cli.mjs'));
    assert(names.includes('docs/PROTOCOL.md'));
    assert(names.includes('public/home.html'));
    assert(names.some(name => name.startsWith('lib/')));
    assert(names.every(name => /^(?:README\.md|AGENTS\.md|IMPLEMENTATION_CONTRACT\.md|package\.json|cli\.mjs|server\.mjs|public\/|lib\/|examples\/|docs\/(?:README|PROTOCOL|RELEASE)\.md)/.test(name)));
    assert(names.every(name => !/(?:^|\/)(?:boards|evidence|notes|skill|scripts|tests)(?:\/|$)/.test(name)));
    const digest = createHash('sha256').update(fixture.zipBytes).digest('hex');
    assert.match(fixture.checksumText, new RegExp(`^${digest}  ${fixture.zipName}\\n$`));
    const skillBytes = await readFile(fixture.release.skillZip);
    assert.deepEqual(readSafeZipSkillNames(skillBytes), ['SKILL.md', 'scripts/install.mjs']);
  } finally { await rm(fixture.temporary, { recursive: true, force: true }); }
});

function readSafeZipSkillNames(bytes) {
  // The application parser requires application files; inspect the skill ZIP's
  // central names directly while keeping the package's folder structure visible.
  const names = [];
  for (let offset = 0; offset < bytes.length - 46; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const length = bytes.readUInt16LE(offset + 28);
    names.push(bytes.subarray(offset + 46, offset + 46 + length).toString('utf8').replace(/^tinka\//, ''));
    offset += 45 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return names;
}

test('installer rejects a bad checksum and unsafe archive path before touching destination', async () => {
  const fixture = await releaseFixture();
  const destination = path.join(fixture.temporary, 'app');
  try {
    await assert.rejects(installArchive({ ...fixture, installDir: destination, checksumText: `${'0'.repeat(64)}  ${fixture.zipName}\n` }), /SHA-256/);
    const unsafe = Buffer.from(fixture.zipBytes);
    const original = Buffer.from('board-room/cli.mjs');
    const replacement = Buffer.from('board-room/../x.xx');
    assert.equal(original.length, replacement.length);
    let count = 0;
    for (let index = unsafe.indexOf(original); index >= 0; index = unsafe.indexOf(original, index + replacement.length)) {
      replacement.copy(unsafe, index);
      count += 1;
    }
    assert.equal(count, 2);
    assert.throws(() => readSafeZip(unsafe), /Unsafe ZIP path/);
    const checksumText = `${createHash('sha256').update(unsafe).digest('hex')}  ${fixture.zipName}\n`;
    await assert.rejects(installArchive({ zipBytes: unsafe, checksumText, zipName: fixture.zipName, installDir: destination }), /Unsafe ZIP path/);
    await assert.rejects(readFile(path.join(destination, 'package.json')), { code: 'ENOENT' });
  } finally { await rm(fixture.temporary, { recursive: true, force: true }); }
});

test('full app replacement restarts its managed service and retains external boards and notes', async () => {
  const fixture = await releaseFixture();
  const app = path.join(fixture.temporary, '.board-room');
  const config = path.join(fixture.temporary, 'settings', 'config.json');
  const boards = path.join(fixture.temporary, 'my-boards');
  const port = await freePort();
  let running = false;
  try {
    assert.match(await main(['--zip', fixture.release.appZip, '--checksum', fixture.release.appChecksum, '--install-dir', app]), /Installed Tinka \d+\.\d+\.\d+/);
    const cli = path.join(app, 'cli.mjs');
    await exec(process.execPath, [cli, 'init', '--config', config, '--boards', boards, '--port', String(port)]);
    await exec(process.execPath, [cli, 'board', 'create', 'sample', '--config', config, '--title', 'Sample']);
    const notes = path.join(boards, 'sample', '.state', 'notes.json');
    const savedNotes = '{"first/alpha":{"note":"Keep this"}}\n';
    await writeFile(notes, savedNotes);
    await writeFile(path.join(app, 'old-build-only.txt'), 'discard this old app file');
    await exec(process.execPath, [cli, 'start', '--config', config]);
    running = true;
    const first = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(first.app, 'board-room');
    await assert.rejects(installArchive({ ...fixture, installDir: app }), /Pass --config for an upgrade/);
    const result = await installArchive({ ...fixture, installDir: app, configPath: config });
    assert.equal(result.restarted, true);
    assert(result.backup);
    assert.equal(await readFile(path.join(result.backup, 'old-build-only.txt'), 'utf8'), 'discard this old app file');
    await assert.rejects(readFile(path.join(app, 'old-build-only.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(notes, 'utf8'), savedNotes);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).boardsRoot, boards);
    const after = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(after.app, 'board-room');
    assert((await readdir(path.dirname(app))).some(name => name.includes('.backup-')));
  } finally {
    if (running) await exec(process.execPath, [path.join(app, 'cli.mjs'), 'stop', '--config', config]).catch(() => {});
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});
