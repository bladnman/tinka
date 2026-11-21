// Versioned, response-derived structural preconditions shared by browser and store.
// This module has no I/O. Compact/old snapshots cannot prove omitted structure.
export const structuralOperations = {
  updatePlacement:['boardId','placementId','patch','restack'],
  translatePlacements:['boardId','placementIds','decorationIds','dx','dy','restack'],
  arrangePlacements:['boardId','placements','decorations'],
  restackOccurrences:['boardId','placementIds','decorationIds','to'],
  duplicateOccurrences:['boardId','placementIds','decorationIds','dx','dy'],
  groupOccurrences:['boardId','placementIds','decorationIds'],
  ungroupOccurrences:['boardId','groupId'],
  createDecoration:['boardId','decoration','containerId','initialText'],
  updateDecoration:['boardId','decorationId','patch','restack'],
  removeDecoration:['boardId','decorationId'],
  moveContainerMember:['boardId','member','containerId','index','x','y'],
  remove:['boardId','placementIds','decorationIds'],
  archive:['boardId','placementIds','archived'],
  updateBoard:['boardId','patch'],
  createItem:['boardId','item','placement'],
  pastePlacements:['targetBoardId','targetPosition','clipboard'],
  move:['sourceBoardId','placementIds','targetBoardId','targetPosition','expectedSourcePlacements','expectedSourceReviewOrder'],
  reference:['sourceBoardId','placementIds','targetBoardId','featureOnParent'],
  importFiles:['workspaceId','targetBoardId','targetPosition','placements','files'],
};
const own=(value,key)=>Object.hasOwn(value,key);
const map=value=>Array.isArray(value)?Object.fromEntries(value.map(v=>[v.id,v])):value||{};
const clone=value=>JSON.parse(JSON.stringify(value));
const sorted=set=>[...set].sort();
export const structuralItem = item => item ? {
  id:item.id,childBoardId:item.childBoardId??null,
  archived:!!(item.archivedAt||item.archived),deleted:!!(item.deletedAt||item.deleted),
} : null;
export function supportsStructuralOperation(op){
  if(!op||!own(structuralOperations,op.type))return false;
  if(Object.keys(op).some(key=>key!=='type'&&!structuralOperations[op.type].includes(key)))return false;
  if(['move','reference'].includes(op.type)&&(!op.sourceBoardId||!op.targetBoardId||!Array.isArray(op.placementIds)))return false;
  if(op.type==='createItem'&&!op.boardId)return false;
  if(op.type==='updateBoard'&&(!op.patch||!own(op.patch,'decorations')||Object.keys(op.patch).some(k=>k!=='decorations')))return false;
  return true;
}
// Return null when the caller has not actually read a sufficient modern snapshot.
// The server uses trusted=true only on its own locked, complete persisted state.
export function structuralBaseline(op,context,{trusted=false}={}){
  if(!supportsStructuralOperation(op))return null;
  const boards=map(context?.boards),items={...map(context?.items)};
  for(const board of Object.values(boards))Object.assign(items,board.structural?.items||{});
  const requests=new Map(),facts=[],itemIds=new Set();
  const need=(id,full=false)=>{if(!id)return null;let r=requests.get(id);if(!r){r={id,full,p:new Set(),d:new Set(),all:false};requests.set(id,r);}r.full ||= full;return r;};
  const sourceId=op.boardId||op.sourceBoardId;
  const r=sourceId?need(sourceId,true):null;
  if(r){
    for(const id of op.placementIds||[])r.p.add(id);
    for(const id of op.decorationIds||[])r.d.add(id);
    if(op.placementId)r.p.add(op.placementId);
    if(op.decorationId)r.d.add(op.decorationId);
    for(const p of op.placements||[])r.p.add(p.id);
    for(const d of op.decorations||[])r.d.add(d.id);
    if(op.member?.placementId)r.p.add(op.member.placementId);
    if(op.member?.decorationId)r.d.add(op.member.decorationId);
    if(op.containerId)r.d.add(op.containerId);
    // Stacking actions can rewrite peers; the complete board is their dependency.
    r.all=op.type==='restackOccurrences'||op.restack==='drop';
    if(op.type==='createDecoration'&&op.decoration?.id)r.d.add(op.decoration.id);
  }
  if(op.targetBoardId)need(op.targetBoardId,op.featureOnParent===true);
  const endpoints=(entry,r)=>{
    for(const end of [entry?.from,entry?.to]){
      if(end?.placementId)r.p.add(end.placementId);
      if(end?.decorationId)r.d.add(end.decorationId);
    }
    for(const child of entry?.container?.children||[]){
      if(typeof child==='string')r.d.add(child);else if(child?.placementId)r.p.add(child.placementId);
    }
  };
  if(r){endpoints(op.decoration,r);endpoints(op.patch,r);}
  for(const request of requests.values()){
    const board=boards[request.id],marker=board?.structural||context?.structural;
    if(!board||!trusted&&(marker?.version!==2||request.full&&marker.scope!=='board'&&marker.scope!=='workspace'))return null;
    if(!board.ownerItemId)return null;
    itemIds.add(board.ownerItemId);
    if(!request.full){facts.push({kind:'boardStructure',boardId:board.id,value:{id:board.id,ownerItemId:board.ownerItemId}});continue;}
    if(!Array.isArray(board.placements)||!Array.isArray(board.decorations)||!Array.isArray(board.reviewOrder))return null;
    const {p,d}=request;
    if(request.all){for(const entry of board.placements)p.add(entry.id);for(const entry of board.decorations)d.add(entry.id);}
    if(op.type==='updateBoard'&&board.id===op.boardId){
      for(const entry of board.decorations)d.add(entry.id);
      for(const entry of op.patch.decorations||[])endpoints(entry,request);
    }
    if(op.type==='ungroupOccurrences'&&board.id===op.boardId){
      const group=board.groups?.find(g=>g.id===op.groupId);
      for(const id of group?.placementIds||[])p.add(id);
      for(const id of group?.decorationIds||[])d.add(id);
    }
    if(op.featureOnParent&&board.id===op.targetBoardId){
      const source=boards[op.sourceBoardId];
      for(const entry of board.placements)if(entry.itemId===source?.ownerItemId)p.add(entry.id);
    }
    // Build each relation once, then walk its connected dependency component.
    // Group hubs keep large groups linear rather than adding every pair of edges.
    const placements=new Map(board.placements.map(entry=>[entry.id,entry]));
    const decorations=new Map(board.decorations.map(entry=>[entry.id,entry]));
    const adjacency=new Map();
    const link=(a,b)=>{if(!adjacency.has(a))adjacency.set(a,[]);if(!adjacency.has(b))adjacency.set(b,[]);adjacency.get(a).push(b);adjacency.get(b).push(a);};
    for(const entry of board.decorations){
      const node=`d:${entry.id}`;
      for(const end of [entry.from,entry.to]){
        if(end?.placementId)link(node,`p:${end.placementId}`);
        if(end?.decorationId)link(node,`d:${end.decorationId}`);
      }
      for(const child of entry.container?.children||[])link(node,typeof child==='string'?`d:${child}`:`p:${child.placementId}`);
    }
    for(const group of board.groups||[]){
      for(const id of group.placementIds)link(`g:${group.id}`,`p:${id}`);
      for(const id of group.decorationIds)link(`g:${group.id}`,`d:${id}`);
    }
    const queue=[...p].map(id=>`p:${id}`).concat([...d].map(id=>`d:${id}`)),seen=new Set(queue);
    for(let index=0;index<queue.length;index++)for(const node of adjacency.get(queue[index])||[]){
      if(seen.has(node))continue;seen.add(node);queue.push(node);
      if(node.startsWith('p:'))p.add(node.slice(2));else if(node.startsWith('d:'))d.add(node.slice(2));
    }
    for(const id of p){const entry=placements.get(id);if(entry)itemIds.add(entry.itemId);}
    const value={id:board.id,ownerItemId:board.ownerItemId,
      placements:sorted(p).map(id=>[id,placements.get(id)||null]),
      decorations:sorted(d).map(id=>[id,decorations.get(id)||null]),
      groups:(board.groups||[]).filter(g=>g.id===op.groupId||g.placementIds.some(id=>p.has(id))||g.decorationIds.some(id=>d.has(id))).sort((a,b)=>a.id.localeCompare(b.id)),
      reviewOrder:board.reviewOrder.filter(id=>p.has(id)),
      placementOrder:board.placements.filter(entry=>p.has(entry.id)).map(entry=>entry.id),
      decorationOrder:board.decorations.filter(entry=>d.has(entry.id)).map(entry=>entry.id),
    };
    facts.push({kind:'boardStructure',boardId:board.id,value:clone(value)});
  }
  // Clipboard snapshots are intentional copies. Current children/resources they
  // reference remain dependencies, but current original text/review does not.
  if(op.type==='pastePlacements'){
    for(const board of Object.values(op.clipboard?.boards||{}))for(const placement of board.placements||[])if(!own(op.clipboard?.items||{},placement.itemId))itemIds.add(placement.itemId);
  }
  for(const id of sorted(itemIds)){
    if(!own(items,id)&&!trusted)return null;
    facts.push({kind:'itemStructure',itemId:id,value:structuralItem(items[id])});
  }
  const roots=new Set();
  const resources=value=>{if(!value||typeof value!=='object')return;if(value.rootId&&value.path)roots.add(value.rootId);for(const child of Object.values(value))resources(child);};
  if(op.type==='pastePlacements')resources(op.clipboard);
  if(op.type==='createItem')resources(op.item);
  if(roots.size){
    const known=context.resourceRoots||context.metadata?.resourceRoots;
    if(!known&&!trusted)return null;
    facts.push({kind:'resourceStructure',value:sorted(roots).map(id=>[id,known?.[id]??null])});
  }
  return {version:2,facts:facts.sort((a,b)=>`${a.kind}/${a.boardId||a.itemId||''}`.localeCompare(`${b.kind}/${b.boardId||b.itemId||''}`))};
}
