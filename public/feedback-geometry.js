import {decorationBounds,resolveLine,linePath} from './whiteboard-geometry.js';

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
  if(anchor.kind==='decoration'){
    const line=board?.decorations?.find(d=>d.id===anchor.decorationId),points=line?linePolyline(line,board,overrides):null,point=points&&pointAlongLine(points,anchor.along,anchor.offset||0);
    if(point&&coordinate(point.x)&&coordinate(point.y))return {x:point.x,y:point.y,detached:false,fallback:false};
    return {x:anchor.x,y:anchor.y,detached:true,fallback:true};
  }
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

// Arrow anchors: {kind:'decoration', decorationId, along:0..1, offset?, x, y} ride along a line
// decoration's drawn path (any route). `along` is the fraction of the path's length; `offset`
// is a perpendicular distance in board units, positive to the left of the travel direction.
// x/y is the creation point, used when the line is gone.
function pathPoints(d){
  const numbers=String(d).match(/[MLC]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)||[],points=[];let index=0,command='M',current=null;
  const next=()=>Number(numbers[index++]);
  while(index<numbers.length){
    if(/^[MLC]$/i.test(numbers[index])){command=numbers[index++].toUpperCase();continue;}
    if(command==='C'){
      const c1=[next(),next()],c2=[next(),next()],end=[next(),next()],start=current||end;
      for(let i=1;i<=24;i++){const t=i/24,u=1-t;points.push([u*u*u*start[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t*t*t*end[0],u*u*u*start[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t*t*t*end[1]]);}
      current=end;
    }else{current=[next(),next()];points.push(current);}
  }
  return points.filter(point=>point.every(Number.isFinite));
}
export function linePolyline(line,board,overrides){
  if(!line||line.type!=='line')return null;
  const current={...line,...patch(overrides?.decorations,line.id)};
  const resolved=resolveLine(current,board,overrides);
  if(![resolved.from.x,resolved.from.y,resolved.to.x,resolved.to.y].every(Number.isFinite))return null;
  const points=pathPoints(linePath(resolved,current.route,current.bend).d);
  return points.length>1?points:null;
}
function segments(points){const list=[];let total=0;for(let i=1;i<points.length;i++){const length=Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]);list.push({a:points[i-1],b:points[i],start:total,length});total+=length;}return {list,total};}
export function pointAlongLine(points,along,offset=0){
  const {list,total}=segments(points);if(!total)return null;
  const target=Math.max(0,Math.min(1,along))*total,segment=list.find(entry=>target<=entry.start+entry.length&&entry.length>0)||list.filter(entry=>entry.length>0).at(-1);
  const t=segment.length?(target-segment.start)/segment.length:0,dx=(segment.b[0]-segment.a[0])/segment.length,dy=(segment.b[1]-segment.a[1])/segment.length;
  return {x:segment.a[0]+dx*segment.length*t+dy*offset,y:segment.a[1]+dy*segment.length*t-dx*offset};
}
// The arrow anchor for a board point: the nearest place on the line's path, as along/offset.
export function alongAnchorAt(point,line,board,overrides){
  const points=linePolyline(line,board,overrides);if(!points)return null;
  const {list,total}=segments(points);if(!total)return null;
  let best=null;
  for(const segment of list){
    if(!segment.length)continue;
    const dx=(segment.b[0]-segment.a[0])/segment.length,dy=(segment.b[1]-segment.a[1])/segment.length;
    const t=Math.max(0,Math.min(segment.length,(point.x-segment.a[0])*dx+(point.y-segment.a[1])*dy));
    const px=segment.a[0]+dx*t,py=segment.a[1]+dy*t,distance=Math.hypot(point.x-px,point.y-py);
    if(!best||distance<best.distance)best={distance,along:(segment.start+t)/total,offset:(point.x-px)*dy-(point.y-py)*dx};
  }
  const round=value=>Math.round(value*10000)/10000;
  return {kind:'decoration',decorationId:line.id,along:round(best.along),offset:round(best.offset),x:point.x,y:point.y};
}
