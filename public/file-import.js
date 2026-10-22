// Native events expose File objects synchronously; retain those before any await.
export const IMPORT_LIMITS = {count:20,file:20*1024*1024,total:50*1024*1024};
const imageTypes = new Set(['image/png','image/jpeg','image/gif','image/webp']);
export function importKind(file) {
  const type = file.type?.toLowerCase(), name = file.name || '';
  if (imageTypes.has(type) || (!type && /\.(?:png|jpe?g|gif|webp)$/i.test(name))) return 'image';
  if (type === 'application/pdf' || (!type && /\.pdf$/i.test(name))) return 'pdf';
  return null;
}
export function eventFiles(data) {
  if (!data) return [];
  const files = Array.from(data.files || []);
  if (files.length) return files;
  return Array.from(data.items || []).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);
}
export function hasFileDrag(data) {
  return Array.from(data?.types || []).includes('Files') || Array.from(data?.items || []).some(item=>item.kind==='file');
}
export function validateImportFiles(files, {clipboard=false} = {}) {
  if (!files.length) throw new Error('No image or PDF files were provided.');
  if (files.length > IMPORT_LIMITS.count) throw new Error('Import at most 20 files at once. No files were imported.');
  for (const file of files) {
    const kind = importKind(file);
    if (!kind || (clipboard && kind !== 'image')) throw new Error(clipboard ? 'Paste PNG, JPEG, GIF or WebP images. Drop PDFs onto the board to import them.' : 'Drop PNG, JPEG, GIF, WebP images or PDFs. No files were imported.');
    if (!file.size || file.size > IMPORT_LIMITS.file) throw new Error('Each file must contain data and be no larger than 20 MiB. No files were imported.');
  }
  if (files.reduce((total,file)=>total+file.size,0) > IMPORT_LIMITS.total) throw new Error('Import at most 50 MiB at once. No files were imported.');
}
async function imageSize(file) {
  const source = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise((resolve,reject)=>{
      const timeout = setTimeout(()=>reject(new Error('This image took too long to read. No files were imported.')),5000);
      image.onload=()=>{clearTimeout(timeout);resolve();};
      image.onerror=()=>{clearTimeout(timeout);reject(new Error('An image could not be read. No files were imported.'));};
      image.src=source;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('An image has no readable dimensions.');
    const scale = Math.min(1,360/image.naturalWidth,360/image.naturalHeight);
    return {width:Math.max(160,Math.round(image.naturalWidth*scale)),height:Math.max(100,Math.round(image.naturalHeight*scale))+42};
  } finally { image.onload=null; image.onerror=null; image.removeAttribute('src'); URL.revokeObjectURL(source); }
}
export async function importLayout(files) {
  const sizes=[];
  // Sequential decode bounds peak memory for batches of large image files.
  for (const file of files) sizes.push(importKind(file)==='pdf' ? {width:300,height:466} : await imageSize(file));
  const columns=Math.min(3,Math.ceil(Math.sqrt(sizes.length))), widths=Array(columns).fill(0), heights=[];
  sizes.forEach((size,index)=>{widths[index%columns]=Math.max(widths[index%columns],size.width);const row=Math.floor(index/columns);heights[row]=Math.max(heights[row]||0,size.height);});
  const sum=(values,end)=>values.slice(0,end).reduce((total,value)=>total+value+24,0);
  return sizes.map((size,index)=>({x:sum(widths,index%columns),y:sum(heights,Math.floor(index/columns)),...size}));
}
export function pdfSupported() { return typeof navigator==='undefined' || navigator.pdfViewerEnabled !== false; }
export function pdfPreviewURL(source, revision) { return source + (revision ? (source.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(revision) : '') + '#page=1&view=Fit&toolbar=0&navpanes=0'; }
