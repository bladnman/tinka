import {decorationBounds} from './whiteboard-geometry.js';

// Point facts stay immutable. Current target geometry supplies the live location;
// missing targets use the saved creation point, with an explicit detached flag.
const coordinate=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=10_000_000;
const patch=(values,id)=>values instanceof Map?values.get(id):values?.[id];
export function pointTargetBounds(anchor,board,overrides){
  if(!board)return null;
  let box;
  if(anchor.placementId){
    const saved=board.placements?.find(p=>p.id===anchor.placementId),item=board.items?.[saved?.itemId];
    if(!saved||saved.removedAt||saved.deletedAt||saved.archivedAt||board.items&&(!item||item.deletedAt||item.archivedAt))return null;
    box={...saved,...patch(overrides?.placements,saved.id)};
  }else if(anchor.decorationId){
    const saved=board.decorations?.find(d=>d.id===anchor.decorationId);
    if(!saved)return null;
    box=decorationBounds(saved,board,overrides);
  }
  return box&&coordinate(box.x)&&coordinate(box.y)&&Number.isFinite(box.width)&&box.width>0&&Number.isFinite(box.height)&&box.height>0?box:null;
}
export function resolveCommentPoint(anchor,board,overrides){
  const targeted=Boolean(anchor.placementId||anchor.decorationId),box=targeted?pointTargetBounds(anchor,board,overrides):null;
  let detached=!board||targeted&&!box;
  if(anchor.relative&&box){
    const x=box.x+anchor.relative.x*box.width,y=box.y+anchor.relative.y*box.height;
    if(coordinate(x)&&coordinate(y))return {x,y,detached:false,fallback:false};
    detached=true;
  }
  return {x:anchor.x,y:anchor.y,detached,fallback:detached};
}
export function pointAnchorAt(point,board,target={}){
  const anchor={kind:'point',x:point.x,y:point.y,...target},box=pointTargetBounds(anchor,board);
  if(box){
    const x=(point.x-box.x)/box.width,y=(point.y-box.y)/box.height;
    if(x>=0&&x<=1&&y>=0&&y<=1)anchor.relative={x,y};
  }
  return anchor;
}
