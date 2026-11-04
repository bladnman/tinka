// Read-only navigation projection. Canonical graph IDs and placements stay intact.
export function navigationGraph(snapshot, legacy = []) {
  const items = new Map((snapshot.items || []).map(item => [item.id, item]));
  const boards = new Map((snapshot.boards || []).filter(board => {
    const owner = items.get(board.ownerItemId);
    return !owner?.archivedAt && !owner?.deletedAt;
  }).map(board => [board.id, board]));
  for (const board of legacy) if (!boards.has(board.id)) boards.set(board.id, {...board, legacy:true, placements:[]});
  const children = new Map(), parents = new Map();
  for (const board of boards.values()) {
    const seen = new Set(), edges = [];
    for (const placement of board.placements || []) {
      const item = items.get(placement.itemId), id = item?.childBoardId;
      if (!boards.has(id) || item.archivedAt || item.deletedAt || placement.archivedAt || placement.removedAt || placement.deletedAt || seen.has(id)) continue;
      seen.add(id); edges.push(id);
      if (!parents.has(id)) parents.set(id, []);
      parents.get(id).push(board.id);
    }
    children.set(board.id, edges);
  }
  const roots = [...new Set([...(snapshot.homeBoardIds || []).filter(id => boards.has(id)), ...[...boards.keys()].filter(id => !parents.has(id))])];
  const paths = new Map(), pending = roots.map(id => [id]);
  for (let offset = 0; offset < pending.length; offset++) {
    const path = pending[offset], id = path.at(-1);
    if (paths.has(id)) continue;
    paths.set(id, path);
    for (const child of children.get(id) || []) if (!paths.has(child)) pending.push([...path, child]);
  }
  // Malformed/manual cycles remain reachable without inventing a parent.
  for (const id of boards.keys()) if (!paths.has(id)) {
    roots.push(id); const queue = [[id]];
    for (let offset = 0; offset < queue.length; offset++) {
      const path = queue[offset], current = path.at(-1);
      if (paths.has(current)) continue;
      paths.set(current, path);
      for (const child of children.get(current) || []) if (!paths.has(child)) queue.push([...path, child]);
    }
  }
  return {boards, children, parents, roots, paths};
}
export function navigationRows(graph, expanded, currentId, limit = 1000) {
  const rows = [], visited = new Set(), pending = [...graph.roots].reverse().map(id => ({id, depth:0, parent:null}));
  while (pending.length && rows.length < limit) {
    const row = pending.pop(), repeated = visited.has(row.id);
    visited.add(row.id);
    const children = graph.children.get(row.id) || [];
    rows.push({...row, repeated, current:row.id === currentId, expandable:!repeated && children.length > 0});
    if (!repeated && expanded.has(row.id)) for (const id of [...children].reverse()) pending.push({id, depth:row.depth + 1, parent:row.id});
  }
  return {rows, truncated:pending.length > 0};
}
