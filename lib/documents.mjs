// Board-authored Markdown documents: create through the file-import pipeline
// (one revision, undoable placement) and save text back to the same .md file.
import {constants} from 'node:fs';
import {lstat,open,readFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {applyFileImport,getItemSnapshot} from './workspace.mjs';
import {resolveResource} from './resources.mjs';
import {storeError} from './store.mjs';
import {documentRevision} from './document-anchors.mjs';
import {reanchorDocument} from './reanchor.mjs';

export const DOCUMENT_TEXT_LIMIT = 900000; // bytes; the JSON request limit is 1 MB
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function checkText(text) {
  if (typeof text !== 'string') throw storeError(400, 'Provide document text as a string.');
  if (Buffer.byteLength(text) > DOCUMENT_TEXT_LIMIT) throw storeError(413, 'Document text is too large.');
  if (text.includes('\u0000')) throw storeError(400, 'Document text cannot contain NUL characters.');
}

export async function createDocument(config, input) {
  if (!object(input)) throw storeError(400, 'Provide a document object.');
  const {title = 'Untitled', text = '# Untitled\n\n', width = 360, height = 460, ...metadata} = input;
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw storeError(400, 'Provide a short document title.');
  checkText(text);
  const bytes = Buffer.from(text || '\n');
  return applyFileImport(config, {...metadata, placements:[{x:0, y:0, width, height}]},
    [{name:`${title.trim()}.md`, title:title.trim(), bytes, markdown:true}]);
}

export async function saveDocument(config, itemId, input) {
  if (!object(input)) throw storeError(400, 'Provide a document object.');
  if (Object.keys(input).some(key => !['text', 'baseRevision'].includes(key))) throw storeError(400, 'Provide only text and an optional baseRevision.');
  checkText(input.text);
  if (input.baseRevision !== undefined && (typeof input.baseRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.baseRevision)))
    throw storeError(400, 'baseRevision must be "sha256:" followed by 64 lowercase hex digits.');
  const item = await getItemSnapshot(config, itemId);
  if (!item) throw storeError(404, 'Item not found.');
  if (item.content?.kind !== 'markdown' || !item.content.resource || item.content.url)
    throw storeError(400, 'Only local Markdown documents can be edited.');
  // resolveResource confines the path to its registered root (no dotfiles or symlink escapes).
  const {path:actual} = await resolveResource(config, item.content.resource);
  const info = await lstat(actual);
  if (!info.isFile()) throw storeError(403, 'Document must be a regular file.');
  // Optimistic concurrency: baseRevision is the SHA-256 of the exact file bytes the editor
  // loaded. A different current file (an agent's or another editor's save) is never overwritten.
  if (input.baseRevision !== undefined) {
    const currentRevision = documentRevision(await readFile(actual));
    if (currentRevision !== input.baseRevision) {
      const error = storeError(409, 'The document changed since it was loaded. Reload it before saving.');
      error.currentRevision = currentRevision; throw error;
    }
  }
  const temp = path.join(path.dirname(actual), `.${path.basename(actual)}.${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, info.mode & 0o777);
  try { await handle.writeFile(input.text); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, actual); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  const revision = documentRevision(Buffer.from(input.text));
  // Saved highlights and passage comments follow unchanged passages (document-anchors.mjs rule).
  // Skipped without a metadata write when nothing is anchored or nothing moved; the file is
  // already saved, so a failure here leaves marks for review rather than failing the save.
  let reanchored;
  try { const {result} = await reanchorDocument(config, {itemId}, {requireDocument:false}); reanchored = {highlights:result.highlights, threads:result.threads}; }
  catch { reanchored = null; }
  return {itemId, resource:item.content.resource, bytes:Buffer.byteLength(input.text), revision, reanchored};
}
