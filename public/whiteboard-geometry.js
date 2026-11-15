// Shared deterministic geometry for browser gestures and agent readouts. No DOM.
// Shape ports project box-side offsets onto the visible ellipse/diamond/rounded
// silhouette; offset .5 is the cardinal midpoint. Coordinates are board units.
export function legacyLineEndpoints(line) {
  return {from:{x:line.x+(line.flipX?line.width:0),y:line.y+(line.flipY?line.height:0)},
    to:{x:line.x+(line.flipX?0:line.width),y:line.y+(line.flipY?0:line.height)}};
}
function override(values,id){return values instanceof Map?values.get(id):values?.[id];}
function target(endpoint,board,overrides){
  if(endpoint.placementId){const saved=(board.placements||[]).find(p=>p.id===endpoint.placementId),item=board.items?.[saved?.itemId];return saved&&!saved.removedAt&&!saved.deletedAt&&!saved.archivedAt&&!item?.archivedAt&&!item?.deletedAt?{...saved,...override(overrides?.placements,endpoint.placementId)}:null;}
  if(endpoint.decorationId){const saved=(board.decorations||[]).find(d=>d.id===endpoint.decorationId&&d.type!=='line');return saved?{...saved,...override(overrides?.decorations,endpoint.decorationId)}:null;}
  return null;
}
function port(box,side,offset){
  const cx=box.x+box.width/2,cy=box.y+box.height/2,rx=box.width/2,ry=box.height/2;
  const horizontal=side==='top'||side==='bottom',sign=side==='top'||side==='left'?-1:1;
  let x=horizontal?box.x+box.width*offset:cx+sign*rx,y=horizontal?cy+sign*ry:box.y+box.height*offset;
  const normalized=horizontal?(x-cx)/rx:(y-cy)/ry;
  if(box.shape==='ellipse'){if(horizontal)y=cy+sign*ry*Math.sqrt(Math.max(0,1-normalized*normalized));else x=cx+sign*rx*Math.sqrt(Math.max(0,1-normalized*normalized));}
  else if(box.shape==='diamond'){if(horizontal)y=cy+sign*ry*(1-Math.abs(normalized));else x=cx+sign*rx*(1-Math.abs(normalized));}
  else if(box.shape==='rounded'){
    const r=Math.min(20,rx,ry),axis=horizontal?x:y,min=horizontal?box.x:box.y,size=horizontal?box.width:box.height;
    const center=axis<min+r?min+r:axis>min+size-r?min+size-r:null;
    if(center!==null){const depth=Math.sqrt(Math.max(0,r*r-(axis-center)**2));if(horizontal)y=cy+sign*(ry-r+depth);else x=cx+sign*(rx-r+depth);}
  }
  return {x,y};
}
export function resolveEndpoint(endpoint,board,overrides) {
  if(endpoint&&typeof endpoint.x==='number'&&typeof endpoint.y==='number')return {x:endpoint.x,y:endpoint.y,attached:false,detached:false};
  const box=endpoint&&target(endpoint,board,overrides);
  const ref=endpoint?.placementId?{placementId:endpoint.placementId}:endpoint?.decorationId?{decorationId:endpoint.decorationId}:{};
  if(!box)return {x:null,y:null,attached:false,detached:true,...ref};
  return {...port(box,endpoint.side,endpoint.offset??.5),attached:true,detached:false,...ref,side:endpoint.side,offset:endpoint.offset??.5};
}
export function resolveLine(line,board,overrides) {
  const legacy=legacyLineEndpoints(line);
  const resolve=(endpoint,fallback)=>{const point=endpoint?resolveEndpoint(endpoint,board,overrides):{...fallback,attached:false,detached:false};return point.detached?{...point,...(endpoint.fallback||fallback)}:point;};
  const from=resolve(line.from,legacy.from),to=resolve(line.to,legacy.to);
  return {from,to,bounds:{x:Math.min(from.x,to.x),y:Math.min(from.y,to.y),width:Math.abs(to.x-from.x),height:Math.abs(to.y-from.y)},detached:from.detached||to.detached};
}
export function decorationBounds(decoration,board,overrides) {
  if(decoration.type==='line')return resolveLine(decoration,board,overrides).bounds;
  const current={...decoration,...override(overrides?.decorations,decoration.id)};
  return {x:current.x,y:current.y,width:current.width,height:current.height};
}
export function resolveBoardGeometry(board) {
  return {boardId:board.id,placements:(board.placements||[]).filter(p=>!p.removedAt&&!p.deletedAt).map(p=>({id:p.id,itemId:p.itemId,x:p.x,y:p.y,width:p.width,height:p.height})),
    decorations:(board.decorations||[]).map(d=>({id:d.id,type:d.type,...(d.shape?{shape:d.shape}:{}),bounds:decorationBounds(d,board),...(d.type==='line'?resolveLine(d,board):{})}))};
}
// The saved box of an endpoint target (card placement or non-line decoration), or null.
export function targetBox(ref,board,overrides){const box=ref&&target(ref,board,overrides);return box?{x:box.x,y:box.y,width:box.width,height:box.height,shape:box.shape}:null;}
// The visible path of a resolved line for its route (straight, elbow or curved).
// Attached ends leave along their side's outward normal; free ends face each other.
// Returns SVG path data in board units and the label point on the drawn path.
const normals={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
// The point halfway along a polyline's length, where a label sits on its path.
function halfway(points){
  const lengths=points.slice(1).map((pt,i)=>Math.hypot(pt[0]-points[i][0],pt[1]-points[i][1]));
  let rest=lengths.reduce((sum,n)=>sum+n,0)/2;
  for(let i=0;i<lengths.length;i++){if(rest<=lengths[i]&&lengths[i]>0){const t=rest/lengths[i];return {x:points[i][0]+(points[i+1][0]-points[i][0])*t,y:points[i][1]+(points[i+1][1]-points[i][1])*t};}rest-=lengths[i];}
  const last=points[points.length-1];return {x:last[0],y:last[1]};
}
export function linePath(resolved,route='straight'){
  const a=resolved.from,b=resolved.to,dx=b.x-a.x,dy=b.y-a.y,f=n=>Math.round(n*100)/100;
  // Free ends leave along the dominant axis toward the other end.
  const toward=Math.abs(dx)>=Math.abs(dy)?[Math.sign(dx)||1,0]:[0,Math.sign(dy)||1];
  const n1=a.attached&&normals[a.side]||toward,n2=b.attached&&normals[b.side]||[-toward[0],-toward[1]];
  if(route==='curved'){
    const k=Math.max(24,Math.min(160,Math.hypot(dx,dy)*.4));
    const c1={x:a.x+n1[0]*k,y:a.y+n1[1]*k},c2={x:b.x+n2[0]*k,y:b.y+n2[1]*k};
    const at=t=>{const u=1-t;return [u*u*u*a.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*b.x,u*u*u*a.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*b.y];};
    return {d:`M${f(a.x)} ${f(a.y)}C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`,mid:halfway(Array.from({length:49},(_,i)=>at(i/48)))};
  }
  if(route==='elbow'){
    const stub=16,horizontal=side=>side==='left'||side==='right';
    const p={x:a.x+(a.attached?n1[0]*stub:0),y:a.y+(a.attached?n1[1]*stub:0)},q={x:b.x+(b.attached?n2[0]*stub:0),y:b.y+(b.attached?n2[1]*stub:0)};
    const fallback=Math.abs(q.x-p.x)>=Math.abs(q.y-p.y)?'h':'v';
    const o1=a.attached?horizontal(a.side)?'h':'v':b.attached?horizontal(b.side)?'h':'v':fallback,o2=b.attached?horizontal(b.side)?'h':'v':o1;
    const points=o1==='h'&&o2==='h'?[[(p.x+q.x)/2,p.y],[(p.x+q.x)/2,q.y]]:o1==='v'&&o2==='v'?[[p.x,(p.y+q.y)/2],[q.x,(p.y+q.y)/2]]:o1==='h'?[[q.x,p.y]]:[[p.x,q.y]];
    const all=[[a.x,a.y],[p.x,p.y],...points,[q.x,q.y],[b.x,b.y]].filter((pt,i,list)=>!i||pt[0]!==list[i-1][0]||pt[1]!==list[i-1][1]);
    return {d:all.map(([x,y],i)=>`${i?'L':'M'}${f(x)} ${f(y)}`).join(''),mid:halfway(all)};
  }
  return {d:`M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`,mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};
}
