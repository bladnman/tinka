// Clipboard data is self-contained. Unrelated clipboard text never falls back
// to an old in-memory selection, and native editing keeps its own clipboard.
export const CLIPBOARD_MIME = "application/x-tinka-placements+json";
export const CLIPBOARD_PREFIX = "TINKA_CLIPBOARD_V1\n";
export const clipboardBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export function clipboardURL(value) {
  try {
    const url = new URL(value);
    return ["http:","https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function readClipboard(data, workspaceId) {
  if (!data || data.files?.length) return null;
  const custom = data.getData(CLIPBOARD_MIME), text = data.getData("text/plain");
  const fallback = /^TINKA_CLIPBOARD_V1\r?\n/.exec(text);
  if (custom || fallback) {
    let clipboard;
    try { clipboard = JSON.parse(custom || text.slice(fallback[0].length)); }
    catch { throw new Error("This Tinka clipboard could not be read. Copy the selection again."); }
    if (clipboard?.version !== 1 || clipboard.workspaceId !== workspaceId)
      throw new Error("These Tinkas belong to a different workspace or clipboard version.");
    if (!Array.isArray(clipboard.placements) || !clipboard.placements.length || !clipboard.items || !clipboard.boards)
      throw new Error("This Tinka clipboard is incomplete. Copy the selection again.");
    return {kind:Object.hasOwn(clipboard,"cut") ? "cut" : "tinkas",clipboard};
  }
  if (!text.trim()) return null;
  const single = /^https?:\/\/\S+$/i.test(text.trim());
  if (single && !clipboardURL(text.trim())) throw new Error("Paste an HTTP or HTTPS link without embedded credentials.");
  return single ? {kind:"url",url:clipboardURL(text.trim())} : {kind:"text",text};
}
export function externalClipboard(workspaceId, source, metadata = {}) {
  const itemId = `clip-item-${crypto.randomUUID()}`, id = `clip-placement-${crypto.randomUUID()}`;
  const now = new Date().toISOString(), link = source.kind === "url";
  const fallback = link ? new URL(source.url) : null;
  const title = link ? String(metadata.title || fallback.hostname + fallback.pathname).slice(0,1000)
    : (source.text.split(/\r?\n/).find(line => line.trim())?.trim() || "Pasted document").slice(0,120);
  const author = String(metadata.author || "").trim(), description = String(metadata.description || "").trim();
  const summary = author && !description.includes(author) ? `${author}${description ? " · " + description : ""}` : description;
  const item = {schemaVersion:2,id:itemId,title,description:link ? summary.slice(0,2000) : "",
    ...(link ? {category:String(metadata.siteName || fallback.hostname).slice(0,120)} : {}),
    content:link ? {kind:"url",url:source.url,openMode:"external"} : {kind:"note",text:source.text},
    revisions:[],review:{note:"",star:false,updatedAt:now},build:{state:"ready",message:"",updatedAt:now}};
  const image = clipboardURL(metadata.image);
  if (link && image) item.preview = {url:image};
  return {version:1,workspaceId,placements:[{id,itemId,x:0,y:0,width:link ? 360 : 380,height:link ? 340 : 440,z:0}],
    items:{[itemId]:item},boards:{},reviewOrder:[id]};
}
