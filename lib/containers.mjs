import {assertId, storeError} from './store.mjs';
import {containerFlow} from '../public/container-flow.js';

const modes = new Set(['vertical', 'horizontal', 'grid']);
const fields = new Set(['children', 'layout', 'padding', 'gap', 'columns']);

export function containerChildKey(child) {
  if (typeof child === 'string') return `decoration:${child}`;
  if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 1 &&
      Object.hasOwn(child, 'placementId') && typeof child.placementId === 'string')
    return `placement:${child.placementId}`;
  return null;
}

function validateChildKey(child) {
  const key = containerChildKey(child);
  if (!key) throw storeError(400, 'Use a decoration ID or an object with one placementId for a container child.');
  assertId(typeof child === 'string' ? child : child.placementId);
  return key;
}

export function validateContainer(entry) {
  const config = entry.container;
  if (config === undefined) return;
  if (entry.type !== 'region' || entry.shape !== undefined || !config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !fields.has(key)) || !modes.has(config.layout) ||
      !Array.isArray(config.children) || config.children.length > 128 ||
      new Set(config.children.map(validateChildKey)).size !== config.children.length)
    throw storeError(400, 'A container is a region with a layout and up to 128 unique children.');
  for (const [key, min, max] of [['padding',0,128],['gap',0,128],['columns',1,8]]) {
    const value = config[key];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
      throw storeError(400, `Container ${key} must be an integer from ${min} to ${max}.`);
  }
}

export function isActiveContainerPlacement(placement, items) {
  if (placement.removedAt || placement.deletedAt || placement.archivedAt) return false;
  const item = items?.[placement.itemId];
  return !items || Boolean(item && !item.archivedAt && !item.deletedAt);
}

function canContainDecoration(entry) {
  return !entry.container && (entry.type === 'text' || entry.type === 'region' && Boolean(entry.shape));
}

function boardMembers(board, items) {
  const members = new Map();
  for (const entry of board.decorations) {
    if (canContainDecoration(entry)) members.set(`decoration:${entry.id}`, entry);
  }
  for (const entry of board.placements) {
    if (isActiveContainerPlacement(entry, items)) members.set(`placement:${entry.id}`, entry);
  }
  return members;
}

function groupedMembers(board) {
  const members = new Set();
  for (const group of Array.isArray(board.groups) ? board.groups : []) {
    if (Array.isArray(group?.decorationIds))
      for (const id of group.decorationIds) members.add(`decoration:${id}`);
    if (Array.isArray(group?.placementIds))
      for (const id of group.placementIds) members.add(`placement:${id}`);
  }
  return members;
}

function validateMembership(containers, members, grouped, status) {
  const claimed = new Set();
  for (const parent of containers) {
    validateContainer(parent);
    for (const child of parent.container.children) {
      const key = containerChildKey(child);
      if (!members.has(key) || claimed.has(key))
        throw storeError(status, 'Container children must be active Tinkas, Text or shapes on this board belonging to only one container.');
      if (grouped.has(key)) throw storeError(status, 'Ungroup a member before adding it to a container.');
      claimed.add(key);
    }
  }
}

export function validateContainerChildren(board, items, status = 400) {
  const containers = board.decorations.filter(entry => entry.container);
  if (containers.length) validateMembership(containers, boardMembers(board,items), groupedMembers(board), status);
}

export function moveContainerMember(board, items, op) {
  const member = op.member;
  if (!member || typeof member !== 'object' || Array.isArray(member) || Object.keys(member).length !== 1 ||
      !['decorationId','placementId'].some(key => Object.hasOwn(member,key)))
    throw storeError(400, 'Choose one decorationId or placementId to move.');
  const child = Object.hasOwn(member,'decorationId') ? assertId(member.decorationId) : member;
  const key = validateChildKey(child);
  const target = boardMembers(board,items).get(key);
  if (!target) throw storeError(400, 'Choose an active Tinka, Text or shape on this board.');
  if (groupedMembers(board).has(key)) throw storeError(409, 'Ungroup a member before moving it into a container.');

  const parents = board.decorations.filter(entry => entry.container);
  const source = parents.find(parent => parent.container.children.some(value => containerChildKey(value) === key));
  const sourceIndex = source?.container.children.findIndex(value => containerChildKey(value) === key);
  if (op.containerId === null) {
    if (!source) throw storeError(409, 'This member is no longer in a container.');
    if (op.index !== undefined || [op.x,op.y].some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10000000))
      throw storeError(400, 'Releasing a container member requires finite x/y coordinates.');
    source.container.children.splice(sourceIndex,1);
    target.x = op.x;
    target.y = op.y;
    return;
  }

  assertId(op.containerId);
  const destination = parents.find(parent => parent.id === op.containerId);
  if (!destination) throw storeError(404, 'Container not found.');
  const length = destination.container.children.length - (destination === source ? 1 : 0);
  const index = op.index ?? (destination === source ? sourceIndex : length);
  if (op.index === null || !Number.isSafeInteger(index) || index < 0 || index > length ||
      op.x !== undefined || op.y !== undefined || length >= 128)
    throw storeError(400, 'Container insertion requires a valid index and room for the member.');
  source?.container.children.splice(sourceIndex,1);
  destination.container.children.splice(index,0,child);
}

export function remapContainerChildren(entry, placementMap, decorationMap) {
  if (!entry.container) return;
  entry.container.children = entry.container.children.flatMap(child => {
    if (typeof child === 'string') return decorationMap ? decorationMap.get(child) || [] : child;
    const placementId = placementMap ? placementMap.get(child.placementId) : child.placementId;
    return placementId ? [{placementId}] : [];
  });
}

// Only positions and the container bounds are derived. Members retain their
// identity, dimensions and presentation in their original board arrays.
export function layoutContainers(board, items, previous, previousItems, status = 400) {
  const containers = board.decorations.filter(entry => entry.container);
  if (!containers.length) return board;
  const members = boardMembers(board,items);
  const removed = new Set();
  if (previous) {
    const currentDecorations = new Set(board.decorations.map(entry => entry.id));
    const before = boardMembers(previous,previousItems);
    for (const [key,entry] of before) {
      if (members.has(key)) continue;
      // An explicit type change is invalid; an actual removal can trim membership.
      if (key.startsWith('placement:') || !currentDecorations.has(entry.id)) removed.add(key);
    }
  }
  const parents = containers.map(parent => {
    validateContainer(parent);
    const children = parent.container.children.filter(child => !removed.has(containerChildKey(child)));
    if (children.length === parent.container.children.length) return parent;
    return {...parent,container:{...parent.container,children}};
  });
  validateMembership(parents,members,groupedMembers(board),status);

  const placed = new Map();
  for (const parent of parents) {
    const {children}=parent.container;
    const entries=children.map(child=>members.get(containerChildKey(child)));
    const {width,height,positions}=containerFlow(parent,entries);
    entries.forEach((child,index)=>{
      const {x,y}=positions[index];
      if(child.x!==x||child.y!==y)placed.set(containerChildKey(children[index]),{...child,x,y});
    });
    placed.set(`decoration:${parent.id}`,parent.width === width && parent.height === height ? parent : {...parent,width,height});
  }
  return {
    decorations:board.decorations.map(entry => placed.get(`decoration:${entry.id}`) || entry),
    placements:board.placements.map(entry => placed.get(`placement:${entry.id}`) || entry),
  };
}
