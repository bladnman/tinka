import {randomUUID} from 'node:crypto';
import {assertId, storeError} from './store.mjs';
import {containerChildKey} from './containers.mjs';

const fields = ['id', 'placementIds', 'decorationIds'];
const memberFields = ['placementIds', 'decorationIds'];
const size = group => group.placementIds.length + group.decorationIds.length;
const freshGroupId = () => `group-${randomUUID()}`;

function availableMembers(board) {
  const children = new Set(board.decorations.flatMap(entry => (entry.container?.children || []).map(containerChildKey)));
  return {
    placementIds: new Set(board.placements.filter(entry => !entry.removedAt && !entry.deletedAt &&
      !children.has(`placement:${entry.id}`)).map(entry => entry.id)),
    decorationIds: new Set(board.decorations.filter(entry => !children.has(`decoration:${entry.id}`)).map(entry => entry.id)),
  };
}

export function validateOccurrenceGroups(board, status = 400) {
  const groups = board.groups;
  if (groups === undefined) return;
  if (!Array.isArray(groups) || groups.length > 10000 || JSON.stringify(groups).length > 2000000)
    throw storeError(400, 'Invalid board groups.');
  if (!groups.length) return;
  const groupIds = new Set();
  const remaining = availableMembers(board);
  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group) || Object.keys(group).some(key => !fields.includes(key)) ||
        memberFields.some(field => !Array.isArray(group[field]) || group[field].length > 10000) ||
        size(group) < 2 || groupIds.has(assertId(group.id)))
      throw storeError(400, 'A group requires a unique ID and at least two members.');
    groupIds.add(group.id);
    for (const field of memberFields) {
      for (const id of group[field]) {
        if (!remaining[field].delete(assertId(id)))
          throw storeError(status, 'Group members must be existing top-level objects in only one group on this board.');
      }
    }
  }
}

export function setOccurrenceGroups(board, groups) {
  if (groups.length) board.groups = groups;
  else delete board.groups;
}

export function pruneOccurrenceGroups(board) {
  if (!Array.isArray(board.groups) || !board.groups.length) return;
  const available = availableMembers(board);
  const groups = board.groups.flatMap(group => {
    if (memberFields.some(field => !Array.isArray(group?.[field]))) return [group];
    const placementIds = group.placementIds.filter(id => available.placementIds.has(id));
    const decorationIds = group.decorationIds.filter(id => available.decorationIds.has(id));
    const remaining = placementIds.length + decorationIds.length;
    if (remaining === size(group)) return [group];
    return remaining >= 2 ? [{...group, placementIds, decorationIds}] : [];
  });
  if (groups.length !== board.groups.length || groups.some((group,index) => group !== board.groups[index]))
    setOccurrenceGroups(board, groups);
}

export function groupOccurrences(board, placementIds, decorationIds) {
  const available = availableMembers(board);
  if (placementIds.some(id => !available.placementIds.has(id)) || decorationIds.some(id => !available.decorationIds.has(id)))
    throw storeError(400, 'Choose top-level objects to group.');
  const placements = new Set(placementIds);
  const decorations = new Set(decorationIds);
  const groups = board.groups || [];
  const selected = groups.filter(group => group.placementIds.some(id => placements.has(id)) ||
    group.decorationIds.some(id => decorations.has(id)));
  for (const group of selected) {
    group.placementIds.forEach(id => placements.add(id));
    group.decorationIds.forEach(id => decorations.add(id));
  }
  if (placements.size + decorations.size < 2)
    throw storeError(400, 'Select at least two objects to group.');

  if (selected.length === 1 && size(selected[0]) === placements.size + decorations.size)
    return selected[0];

  const group = {id: freshGroupId(), placementIds: [...placements], decorationIds: [...decorations]};
  const combined = new Set(selected);
  board.groups = [...groups.filter(entry => !combined.has(entry)), group];
  return group;
}

export function ungroupOccurrences(board, groupId) {
  assertId(groupId);
  const group = board.groups?.find(entry => entry.id === groupId);
  if (!group) throw storeError(404, 'Group not found.');
  setOccurrenceGroups(board, board.groups.filter(entry => entry.id !== groupId));
  return group;
}

export function copyOccurrenceGroups(source, target, placementMap, decorationMap) {
  const copies = [];
  for (const group of source.groups || []) {
    const placementIds = group.placementIds.map(id => placementMap.get(id));
    const decorationIds = group.decorationIds.map(id => decorationMap ? decorationMap.get(id) : id);
    if (placementIds.every(Boolean) && decorationIds.every(Boolean))
      copies.push({id: freshGroupId(), placementIds, decorationIds});
  }
  if (copies.length) target.groups = [...(target.groups || []), ...copies];
}
