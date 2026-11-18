import {containerFlow} from './container-flow.js';

// Container members participate in a parent move/copy but stay independently
// selectable for editing and removal. This helper is shared with the store.
export function expandContainerSelection(decorations, ids) {
  const selected = new Set(ids);
  for (const entry of decorations) {
    if (entry.container && selected.has(entry.id))
      for (const id of entry.container.children) if (typeof id === 'string') selected.add(id);
  }
  return [...selected];
}

export function canContain(entry) {
  return !entry.container && (entry.type === 'text' || entry.type === 'region' && Boolean(entry.shape));
}

export function containerFor(decorations, id) {
  return decorations.find(entry => entry.container?.children.includes(id));
}

export function containerPlacementIds(container) {
  return (container?.children || []).flatMap(child => child?.placementId ? [child.placementId] : []);
}

const keyOf = child => typeof child === 'string' ? `decoration:${child}` : `placement:${child.placementId}`;
const memberKey = member => member.decorationId ? keyOf(member.decorationId) : keyOf(member);
const refOf = child => typeof child === 'string' ? {decorationId:child} : child;
const boxFor = (board, ref) => ref.placementId ? board.placements.find(p=>p.id===ref.placementId) : board.decorations.find(d=>d.id===ref.decorationId);

export function containerMemberFor(board, member) {
  const key = memberKey(member);
  return board.decorations.find(entry=>entry.container?.children.some(child=>keyOf(child)===key));
}

export function previewContainerMove(board, previous, next) {
  const decorations = new Map([[next.id,next]]), placements = new Map();
  if (!previous.container) return {decorations,placements};
  const dx = next.x - previous.x, dy = next.y - previous.y;
  for (const child of previous.container.children) {
    const box=boxFor(board,refOf(child));
    if(box)(typeof child==='string'?decorations:placements).set(box.id,{...box,x:box.x+dx,y:box.y+dy});
  }
  return {decorations,placements};
}

export function previewContainerLayout(board, parent, patch) {
  const members=parent.container.children.map(child=>boxFor(board,refOf(child)));
  if(members.some(member=>!member))return null;
  const container={...parent.container,...patch};
  const {width,height,positions}=containerFlow({...parent,container},members);
  const decorations=new Map([[parent.id,{...parent,container,width,height}]]);
  const placements=new Map(), originalPlacements=new Map();
  for(const [index,member] of members.entries()){
    if(typeof container.children[index]==="string")decorations.set(member.id,{...member,...positions[index]});
    else {
      placements.set(member.id,{...member,...positions[index]});
      originalPlacements.set(member.id,member);
    }
  }
  return {decorations,placements,originalPlacements};
}

function within(point, box) {
  return point.x>=box.x&&point.x<=box.x+box.width&&point.y>=box.y&&point.y<=box.y+box.height;
}

// The saved child boxes are in layout order. Use their logical midpoint in the
// stack/row, or the midpoint of the actual row band and column in a grid.
export function containerDropAt(board, member, point) {
  const parent = board.decorations.findLast(d=>d.container&&d.id!==member.decorationId&&within(point,d));
  if (!parent) return null;
  const {layout,padding=16,gap=12}=parent.container;
  const children=parent.container.children.filter(child=>keyOf(child)!==memberKey(member)).map(child=>boxFor(board,refOf(child))).filter(Boolean);
  const empty={x:parent.x+padding,y:parent.y+padding+(parent.text?.trim()?28:0),length:Math.max(24,parent.width-padding*2),vertical:false};
  if (!children.length) return {parent,index:0,marker:empty};
  if (layout==='vertical') {
    const before=children.findIndex(child=>point.y<child.y+child.height/2);
    const index=before<0?children.length:before, last=children.at(-1);
    const y=before<0?last.y+last.height+gap/2:children[before].y-gap/2;
    return {parent,index,marker:{...empty,y}};
  }
  const bands=[];
  for (const child of children) {
    const current=bands.at(-1);
    if (current?.y===child.y) {current.boxes.push(child);current.height=Math.max(current.height,child.height);}
    else bands.push({y:child.y,height:child.height,boxes:[child]});
  }
  const band=bands.find((row,index)=>!bands[index+1]||point.y<(row.y+row.height+bands[index+1].y)/2);
  const before=band.boxes.findIndex(child=>point.x<child.x+child.width/2), last=band.boxes.at(-1);
  const index=before<0?children.indexOf(last)+1:children.indexOf(band.boxes[before]);
  const x=before<0?last.x+last.width+gap/2:band.boxes[before].x-gap/2;
  return {parent,index,marker:{x,y:band.y,length:band.height,vertical:true}};
}

export function containerDropUnchanged(board, member, affected) {
  const read = source => [boxFor(source,member),...affected.filter(Boolean).map(({id})=>{
    const parent=source.decorations.find(d=>d.id===id);
    return [parent,...(parent?.container?.children||[]).map(child=>boxFor(source,refOf(child)))];
  })];
  const start=JSON.stringify(read(board));
  return latest=>JSON.stringify(read(latest))===start;
}

export function containerDropLabel(hit, source) {
  if (hit?.blocked) return 'This selection stays on the canvas';
  if (hit) return hit.parent.id===source?.id ? 'Drop to reorder' : 'Drop into container';
  return source ? 'Drop to remove from container' : '';
}
