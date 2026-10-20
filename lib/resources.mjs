import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./paths.mjs";
import { assertId, storeError, withStore, workspaceRoot } from "./store.mjs";

export function validateResource(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref))
    throw storeError(400, "Expected resource reference.");
  assertId(ref.rootId);
  if (
    typeof ref.path !== "string" ||
    ref.path.length > 4096 ||
    !ref.path ||
    ref.path.includes("\\") ||
    ref.path.includes("\0") ||
    path.posix.isAbsolute(ref.path) ||
    /^[a-z]:/i.test(ref.path)
  )
    throw storeError(400, "Invalid resource path.");
  // References are unencoded path segments. Encoded traversal is rejected too,
  // so adapters cannot accidentally turn a safe-looking reference into ../.
  let decoded;
  try {
    decoded = decodeURIComponent(ref.path);
  } catch {
    throw storeError(400, "Invalid resource encoding.");
  }
  for (const candidate of [ref.path, decoded])
    if (
      candidate.split("/").some((part) => !part || part.startsWith(".")) ||
      candidate.includes("\\") ||
      candidate.includes("\0")
    )
      throw storeError(403, "Resource path is unsafe.");
  return ref;
}
export function validateResourceRoots(roots) {
  if (
    !roots ||
    typeof roots !== "object" ||
    Array.isArray(roots) ||
    Object.keys(roots).length > 100
  )
    throw storeError(400, "Invalid resource roots.");
  for (const [id, root] of Object.entries(roots)) {
    assertId(id);
    if (
      !root ||
      typeof root.path !== "string" ||
      !root.path ||
      root.path.length > 4096 ||
      root.path.includes("\\") ||
      root.path.includes("\0") ||
      path.isAbsolute(root.path) ||
      /^[a-z]:/i.test(root.path)
    )
      throw storeError(400, "Resource roots must be workspace-relative paths.");
  }
  return roots;
}
export function resourceUrl(ref) {
  validateResource(ref);
  return `/resources/${encodeURIComponent(ref.rootId)}/${ref.path.split("/").map(encodeURIComponent).join("/")}`;
}
const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function validateRootLocations(config, roots) {
  validateResourceRoots(roots);
  const metadataRoot = workspaceRoot(config);
  let actualMetadata = metadataRoot;
  try {
    actualMetadata = await realpath(metadataRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const root of Object.values(roots)) {
    const lexical = path.resolve(metadataRoot, root.path);
    let actual = lexical;
    try {
      actual = await realpath(lexical);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      isInside(metadataRoot, lexical) ||
      isInside(actualMetadata, actual) ||
      isInside(appRoot, lexical) ||
      isInside(appRoot, actual)
    )
      throw storeError(
        403,
        "Resources must be outside application and workspace metadata directories.",
      );
  }
}
export async function resolveResource(config, ref) {
  validateResource(ref);
  const registered = await withStore(
    config,
    (_root, state) => state?.metadata.resourceRoots?.[ref.rootId],
    { metadataOnly: true },
  );
  if (!registered) throw storeError(404, "Unknown resource root.");
  await validateRootLocations(config, { [ref.rootId]: registered });
  const lexicalRoot = path.resolve(workspaceRoot(config), registered.path);
  let rootPath, actual;
  try {
    rootPath = await realpath(lexicalRoot);
    actual = await realpath(path.join(rootPath, ref.path));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      throw storeError(404, "Resource not found.");
    throw error;
  }
  if (!isInside(rootPath, actual))
    throw storeError(403, "Resource symlink leaves registered root.");
  if (
    path
      .relative(rootPath, actual)
      .split(path.sep)
      .some((part) => part.startsWith("."))
  )
    throw storeError(403, "Hidden resources cannot be served through aliases.");
  if (
    isInside(await realpath(workspaceRoot(config)), actual) ||
    isInside(appRoot, actual)
  )
    throw storeError(
      403,
      "Application and workspace metadata files are private.",
    );
  if (!(await stat(actual)).isFile())
    throw storeError(404, "Resource is not a file.");
  return { path: actual, rootPath };
}
