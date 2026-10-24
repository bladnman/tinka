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
