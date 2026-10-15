#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, stat, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxFileBytes = 20 * 1024 * 1024;
const maxArchiveBytes = 100 * 1024 * 1024;
const appRoots = ['README.md', 'AGENTS.md', 'IMPLEMENTATION_CONTRACT.md', 'package.json', 'cli.mjs', 'server.mjs', 'public', 'lib', 'examples'];
const publicDocs = ['docs/README.md', 'docs/PROTOCOL.md', 'docs/RELEASE.md'];
const skillRoots = ['skill/tinka/SKILL.md', 'skill/tinka/scripts/install.mjs'];
const excludedNames = new Set(['.DS_Store', '.state', 'boards', 'evidence', 'notes', 'tests', 'test', 'skill', 'scripts', 'node_modules']);

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function collect(relative, files) {
  const absolute = path.join(sourceRoot, relative);
  const details = await lstat(absolute);
  if (details.isSymbolicLink()) throw new Error(`Symlink is not allowed in release: ${relative}`);
  if (details.isDirectory()) {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || excludedNames.has(entry.name.toLowerCase())) continue;
      await collect(path.posix.join(relative, entry.name), files);
    }
    return;
  }
  if (!details.isFile()) throw new Error(`Unsupported release entry: ${relative}`);
  if (details.size > maxFileBytes) throw new Error(`Release file is too large: ${relative}`);
  files.push(relative.replaceAll(path.sep, '/'));
}

function storedZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  let total = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name, 'utf8');
    if (filename.length > 65535 || data.length > maxFileBytes) throw new Error(`Invalid ZIP entry: ${name}`);
    total += data.length;
    if (total > maxArchiveBytes) throw new Error('Release exceeds the size limit.');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x0021, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += local.length + filename.length + data.length;
  }
  if (entries.length > 65535 || offset > 0xffffffff) throw new Error('ZIP64 is not supported.');
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

async function archive(files, stripPrefix = '', zipRoot = 'board-room') {
  const entries = [];
  for (const relative of [...new Set(files)].sort()) {
    const content = await readFile(path.join(sourceRoot, relative));
    const name = relative.startsWith(stripPrefix) ? relative.slice(stripPrefix.length) : relative;
    entries.push([`${zipRoot}/${name}`, content]);
  }
  return storedZip(entries);
}

function checksumSidecar(bytes, filename) {
  return `${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`;
}

export async function buildRelease({ outDir }) {
  if (!outDir || !path.isAbsolute(outDir)) throw new Error('--out must be an absolute path.');
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'board-room' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Invalid package name or version.');
  const appFiles = [];
  for (const root of [...appRoots, ...publicDocs]) await collect(root, appFiles);
  const skillFiles = [];
  for (const root of skillRoots) await collect(root, skillFiles);
  const appName = `tinka-v${manifest.version}.zip`;
  const skillName = 'tinka-skill.zip';
  const outputs = [appName, `${appName}.sha256`, skillName, `${skillName}.sha256`].map(name => path.join(outDir, name));
  await mkdir(outDir, { recursive: true });
  for (const output of outputs) {
    try { await stat(output); throw new Error(`Release output already exists: ${output}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const appBytes = await archive(appFiles);
  const skillBytes = await archive(skillFiles, 'skill/tinka/', 'tinka');
  await writeFile(outputs[0], appBytes, { flag: 'wx' });
  await writeFile(outputs[1], checksumSidecar(appBytes, appName), { flag: 'wx' });
  await writeFile(outputs[2], skillBytes, { flag: 'wx' });
  await writeFile(outputs[3], checksumSidecar(skillBytes, skillName), { flag: 'wx' });
  return { version: manifest.version, appZip: outputs[0], appChecksum: outputs[1], skillZip: outputs[2], skillChecksum: outputs[3], appFiles: appFiles.length, skillFiles: skillFiles.length };
}

if (process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => null) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--out');
  const outDir = index >= 0 ? process.argv[index + 1] : path.join(sourceRoot, 'scripts', 'release');
  try { process.stdout.write(`${JSON.stringify(await buildRelease({ outDir }), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
