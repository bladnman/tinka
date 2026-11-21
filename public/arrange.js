const svg16 = body => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ARRANGE = [
  ["align-left","Align left",'<path d="M2.5 2v12"/><rect x="4.5" y="4" width="8" height="3" rx=".6"/><rect x="4.5" y="9" width="5" height="3" rx=".6"/>'],
  ["align-center","Align centres",'<path d="M8 2v12"/><rect x="3" y="4" width="10" height="3" rx=".6"/><rect x="5" y="9" width="6" height="3" rx=".6"/>'],
  ["align-right","Align right",'<path d="M13.5 2v12"/><rect x="3.5" y="4" width="8" height="3" rx=".6"/><rect x="6.5" y="9" width="5" height="3" rx=".6"/>'],
  ["align-top","Align top",'<path d="M2 2.5h12"/><rect x="4" y="4.5" width="3" height="8" rx=".6"/><rect x="9" y="4.5" width="3" height="5" rx=".6"/>'],
  ["align-middle","Align middles",'<path d="M2 8h12"/><rect x="4" y="3" width="3" height="10" rx=".6"/><rect x="9" y="5" width="3" height="6" rx=".6"/>'],
  ["align-bottom","Align bottom",'<path d="M2 13.5h12"/><rect x="4" y="3.5" width="3" height="8" rx=".6"/><rect x="9" y="6.5" width="3" height="5" rx=".6"/>'],
  ["distribute-h","Distribute horizontally",'<path d="M2 2v12M14 2v12"/><rect x="6.5" y="4.5" width="3" height="7" rx=".6"/>'],
  ["distribute-v","Distribute vertically",'<path d="M2 2h12M2 14h12"/><rect x="4.5" y="6.5" width="7" height="3" rx=".6"/>'],
  ["tidy","Tidy into a grid",'<rect x="2.5" y="2.5" width="4.5" height="4.5" rx=".6"/><rect x="9" y="2.5" width="4.5" height="4.5" rx=".6"/><rect x="2.5" y="9" width="4.5" height="4.5" rx=".6"/><rect x="9" y="9" width="4.5" height="4.5" rx=".6"/>'],
];
export const ARRANGE_ICON = svg16('<path d="M2.5 2v12"/><rect x="4.5" y="3.5" width="9" height="3.5" rx=".6"/><rect x="4.5" y="9" width="6" height="3.5" rx=".6"/>');
// Pure arrangement maths (board units). Each object is {box:{x,y,width,height}}; returns new top-left points.
export function arrangePositions(kind, objects, gap = 40) {
  const boxes = objects.map(o => o.box), left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
  const right = Math.max(...boxes.map(b => b.x + b.width)), bottom = Math.max(...boxes.map(b => b.y + b.height));
  const same = b => ({x:b.x,y:b.y});
  if (kind === "align-left") return boxes.map(b => ({x:left,y:b.y}));
  if (kind === "align-center") return boxes.map(b => ({x:(left + right) / 2 - b.width / 2,y:b.y}));
  if (kind === "align-right") return boxes.map(b => ({x:right - b.width,y:b.y}));
  if (kind === "align-top") return boxes.map(b => ({x:b.x,y:top}));
  if (kind === "align-middle") return boxes.map(b => ({x:b.x,y:(top + bottom) / 2 - b.height / 2}));
  if (kind === "align-bottom") return boxes.map(b => ({x:b.x,y:bottom - b.height}));
  if (kind === "distribute-h" || kind === "distribute-v") {
    const [pos,size] = kind === "distribute-h" ? ["x","width"] : ["y","height"];
    const order = boxes.map((b,i) => i).sort((a,b) => boxes[a][pos] + boxes[a][size] / 2 - (boxes[b][pos] + boxes[b][size] / 2));
    const start = boxes[order[0]][pos], end = Math.max(...order.map(i => boxes[i][pos] + boxes[i][size]));
    const space = (end - start - order.reduce((sum,i) => sum + boxes[i][size],0)) / (order.length - 1);
    const out = boxes.map(same);
    let at = start;
    for (const i of order) { out[i][pos] = at; at += boxes[i][size] + space; }
    return out;
  }
  // Tidy: reading order (rows top to bottom, then left to right), into ⌈√n⌉ columns.
  const sorted = boxes.map((b,i) => i).sort((a,b) => boxes[a].y - boxes[b].y);
  const reading = [];
  for (let k = 0; k < sorted.length;) {
    const first = boxes[sorted[k]], row = [];
    while (k < sorted.length && boxes[sorted[k]].y < first.y + first.height / 2) row.push(sorted[k++]);
    reading.push(...row.sort((a,b) => boxes[a].x - boxes[b].x));
  }
  const columns = Math.ceil(Math.sqrt(reading.length)), widths = [], heights = [];
  reading.forEach((i,n) => { const c = n % columns, r = Math.floor(n / columns);
    widths[c] = Math.max(widths[c] || 0,boxes[i].width); heights[r] = Math.max(heights[r] || 0,boxes[i].height); });
  const out = boxes.map(same);
  reading.forEach((i,n) => { const c = n % columns, r = Math.floor(n / columns);
    out[i] = {x:left + widths.slice(0,c).reduce((a,b) => a + b + gap,0),y:top + heights.slice(0,r).reduce((a,b) => a + b + gap,0)}; });
  return out;
}

export function arrangeMenuMarkup(count) {
  const item = ([kind,label,icon]) => `<button type="button" class="arrange-item" data-arrange="${kind}" aria-label="${label}" title="${label}" ${kind.startsWith("distribute") && count < 3 ? "disabled" : ""}>${svg16(icon)}</button>`;
  return `<div class="arrange-group" role="group" aria-label="Align"><span>Align</span>${ARRANGE.slice(0,6).map(item).join("")}</div>
    <div class="arrange-group" role="group" aria-label="Distribute"><span>Distribute</span>${ARRANGE.slice(6,8).map(item).join("")}</div>
    <button type="button" class="arrange-tidy" data-arrange="tidy" title="Tidy the selection into a grid, keeping reading order">${svg16(ARRANGE[8][2])}<span>Tidy into grid</span></button>`;
}
export function arrangeMenuKeys(menu, event) {
  const forward = ["ArrowRight","ArrowDown"].includes(event.key), backward = ["ArrowLeft","ArrowUp"].includes(event.key);
  if (!forward && !backward && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const buttons = [...menu.querySelectorAll("button:not(:disabled)")], index = buttons.indexOf(document.activeElement);
  buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 : (index+(forward?1:-1)+buttons.length)%buttons.length]?.focus();
}
