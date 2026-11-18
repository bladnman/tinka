import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { resolveResourceParentFromMetadata, validateResource } from "./resources.mjs";

const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_FAMILY_FILES = 128;

function versionedName(filename) {
  const extension = path.posix.extname(filename);
  if (extension.toLowerCase() !== ".html") return null;
  const match = /^(.+)-v([0-9]+)$/.exec(filename.slice(0, -extension.length));
  if (!match) return null;
  const [, stem, digits] = match;
  const version = Number(digits);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { stem, extension, version, name: `V${digits}` };
}

const sameFamily = (one, other) => other && one.stem === other.stem && one.extension === other.extension;

async function listDirectory(config, ref, roots, expectedDirectory) {
  try {
    const actual = await resolveResourceParentFromMetadata(config, ref, roots);
    if (expectedDirectory && expectedDirectory !== actual) return null;
    const identity = await directoryIdentity(actual);
    if (!identity) return null;
    const entries = [];
    let count = 0;
    for await (const entry of await opendir(actual)) {
      if (++count > MAX_DIRECTORY_ENTRIES) return null;
      if (!entry.isFile()) continue;
      const version = versionedName(entry.name);
      if (version) entries.push({ ...version, filename: entry.name });
    }
    return { actual, identity, entries, stats: new Map() };
  } catch {
    // Optional discovery must not hide the canonical item if a directory
    // disappears mid-read or is inaccessible on this machine.
    return null;
  }
}

async function directoryIdentity(directory) {
  try {
    const stats = await lstat(directory, { bigint: true });
    return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
}

async function fileDetails(directory, filename) {
  try {
    const stats = await lstat(path.join(directory, filename), { bigint: true });
    if (!stats.isFile()) return null;
    return {
      modifiedAt: stats.mtime.toISOString(),
      sourceRevision: createHash("sha256").update(
        [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join("-"),
      ).digest("hex"),
    };
  } catch {
    return null;
  }
}

function availableVersionId(version, explicitIds) {
  const base = `file-v${version}`;
  if (!explicitIds.has(base)) return base;
  let id = `${base}-auto`;
  for (let ordinal = 2; explicitIds.has(id); ordinal++) id = `${base}-auto-${ordinal}`;
  return id;
}

// Reuse directory listings and file stats only within one response. A later
// board read or filesystem event can immediately see newly saved siblings.
export function versionStackProjector(config, roots) {
  const directories = new Map();
  return async function versionStack(item, targetFile) {
    const content = item?.content;
    const ref = content?.resource;
    if (item?.deletedAt || content?.kind !== "html" || content.url || typeof ref?.path !== "string") return null;
    const attached = path.posix.basename(ref.path);
    const family = versionedName(attached);
    if (!family || (targetFile && !sameFamily(family, versionedName(path.basename(targetFile))))) return null;
    try { validateResource(ref); } catch { return null; }

    const relativeDir = path.posix.dirname(ref.path);
    const targetDirectory = targetFile && path.dirname(targetFile);
    const cacheKey = JSON.stringify([ref.rootId, relativeDir, targetDirectory]);
    if (!directories.has(cacheKey))
      directories.set(cacheKey, listDirectory(config, ref, roots, targetDirectory));
    const directory = await directories.get(cacheKey);
    if (!directory) return null;
    const candidates = directory.entries.filter(entry => sameFamily(family, entry));
    if (candidates.length > MAX_FAMILY_FILES) return null;

    const groups = new Map();
    for (const entry of candidates) {
      const resource = { ...ref, path: path.posix.join(relativeDir, entry.filename) };
      try { validateResource(resource); } catch { continue; }
      if (!directory.stats.has(entry.filename))
        directory.stats.set(entry.filename, fileDetails(directory.actual, entry.filename));
      const details = await directory.stats.get(entry.filename);
      if (!details) continue;
      if (!groups.has(entry.version)) groups.set(entry.version, []);
      groups.get(entry.version).push({ ...entry, ...details, resource });
    }
    // A directory replaced while reading can yield inconsistent filenames
    // and stats. Refuse that sample; the next snapshot reads the new directory.
    if (await directoryIdentity(directory.actual) !== directory.identity) return null;

    const explicitIds = new Set((item.revisions || []).map(revision => revision.id));
    const versions = [];
    for (const group of groups.values()) {
      const entry = group.length === 1 ? group[0] : group.find(candidate => candidate.filename === attached);
      if (!entry) continue;
      const { version, name, modifiedAt, sourceRevision, resource } = entry;
      versions.push({
        id: availableVersionId(version, explicitIds), name, version, modifiedAt, sourceRevision,
        content: { ...content, resource },
      });
    }
    versions.sort((a, b) => a.version - b.version);
    return versions.length ? { defaultId: versions.at(-1).id, versions } : null;
  };
}
