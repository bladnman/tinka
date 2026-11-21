import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {guardedRequest,checkGuardedFacts,checkStructuralFacts} from './guarded-write.mjs';
import {structuralItem} from '../public/structural-guard.js';
import {prepareImport,importResources} from "./file-import.mjs";
import {boardCovers,coverRevisions} from './board-covers.mjs';
import {versionStackProjector} from './version-stacks.mjs';
import { assertId, commitStore, storeError, withStore, readStoreDocument } from "./store.mjs";
import {isFeedbackOperation,applyFeedbackOperation} from './feedback.mjs';
import {isHighlightOperation,applyHighlightOperation,validateHighlights} from './highlights.mjs';
import {MAX_ARROW_BEND,MAX_ARROW_THICKNESS,resolveBoardGeometry,resolveLine,validArrowThickness} from '../public/whiteboard-geometry.js';
import {isDrawingColor} from '../public/drawing-palette.js';
import {emojiSticker} from '../public/emoji-stickers.js';
import {STACK_RANGE,applyStack,dropRestack,landOnTop,restack,stackOrder,stackRef} from '../public/stacking.js';
import {
  isActiveContainerPlacement, layoutContainers, moveContainerMember, remapContainerChildren,
  validateContainer, validateContainerChildren,
} from './containers.mjs';
import {
  copyOccurrenceGroups, groupOccurrences, pruneOccurrenceGroups, setOccurrenceGroups,
  ungroupOccurrences, validateOccurrenceGroups,
} from './occurrence-groups.mjs';
import {
  validateResource,
  validateResourceRoots,
  validateRootLocations,
} from "./resources.mjs";

const kinds = new Set([
  "html",
  "image",
  "markdown",
  "video",
  "pdf",
  "url",
  "text",
  "note",
  "audio",
  "file",
]);
const states = new Set([
  "reserved",
  "building",
  "review",
  "ready",
  "complete",
  "blocked",
  "draft",
]);
const now = () => new Date().toISOString();
const fresh = (prefix) => `${prefix}-${randomUUID()}`;
const clone = (value) => structuredClone(value);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function requireObject(value, label) {
  if (!object(value)) throw storeError(400, `Expected ${label} object.`);
  return value;
}
function text(value, label, max = 20000) {
  if (typeof value !== "string" || value.length > max)
    throw storeError(400, `Invalid ${label}.`);
  return value;
}
function title(value) {
  text(value, "title", 1000);
  if (!value.trim()) throw storeError(400, "Title is required.");
  return value;
}
function url(value) {
  text(value, "URL", 8192);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw storeError(400, "Invalid URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw storeError(
      400,
      "Only HTTP(S) URLs without credentials are supported.",
    );
}
function content(value, roots) {
  requireObject(value, "content");
  if (!kinds.has(value.kind))
    throw storeError(400, "Unsupported content kind.");
  if (value.resource) {
    validateResource(value.resource);
    if (!Object.hasOwn(roots, value.resource.rootId))
      throw storeError(400, "Content uses an unregistered resource root.");
  }
  if (value.url !== undefined) url(value.url);
  if (value.text !== undefined) text(value.text, "content text", 2000000);
  if (
    value.openMode !== undefined &&
    !["inline", "standalone", "external", "download", "preview"].includes(
      value.openMode,
    )
  )
    throw storeError(400, "Invalid content openMode.");
  if (value.startInstructions !== undefined)
    text(value.startInstructions, "start instructions", 20000);
}
function validateItem(item, roots) {
  assertId(item.id);
  if (item.schemaVersion !== 2) throw storeError(400, "Invalid item schema.");
  title(item.title);
  text(item.description, "description", 200000);
  if (item.content !== undefined && item.content !== null)
    content(item.content, roots);
  if (item.preview !== undefined && item.preview !== null) {
    requireObject(item.preview, "preview");
    if (item.preview.resource) {
      validateResource(item.preview.resource);
      if (!Object.hasOwn(roots, item.preview.resource.rootId))
        throw storeError(400, "Preview uses an unregistered resource root.");
    }
    if (item.preview.text !== undefined)
      text(item.preview.text, "preview text", 200000);
    if (item.preview.url !== undefined) url(item.preview.url);
  }
  if (item.resources !== undefined) {
    if (!Array.isArray(item.resources) || item.resources.length > 10000)
      throw storeError(400, "Invalid item resources.");
    for (const resource of item.resources) {
      const ref = resource.resource || resource;
      validateResource(ref);
      if (!Object.hasOwn(roots, ref.rootId))
        throw storeError(400, "Unknown resource root.");
    }
  }
  if (!Array.isArray(item.revisions) || item.revisions.length > 10000)
    throw storeError(400, "Invalid revisions.");
  for (const revision of item.revisions) {
    requireObject(revision, "revision");
    if (revision.id !== undefined) text(revision.id, "revision ID", 1000);
    if (revision.content) content(revision.content, roots);
    if (revision.resource) {
      validateResource(revision.resource);
      if (!Object.hasOwn(roots, revision.resource.rootId))
        throw storeError(400, "Revision uses unknown resource root.");
    }
    if (revision.url !== undefined) url(revision.url);
  }
  requireObject(item.review, "review");
  text(item.review.note, "review note", 200000);
  if (typeof item.review.star !== "boolean")
    throw storeError(400, "Review star must be boolean.");
  if(item.review.votes!==undefined){
    requireObject(item.review.votes,'votes');
    if(Object.keys(item.review.votes).length>1000)throw storeError(400,'Too many votes.');
    for(const [id,vote] of Object.entries(item.review.votes)){
      assertId(id);requireObject(vote,'vote');requireObject(vote.actor,'vote actor');
      if(vote.actor.id!==id||!['human','agent'].includes(vote.actor.kind)||!['yes','no','abstain'].includes(vote.value))throw storeError(400,'Invalid vote.');
      text(vote.actor.label,'actor label',120);
    }
  }
  validateHighlights(item.review.highlights);
  requireObject(item.build, "build");
  if (!states.has(item.build.state))
    throw storeError(400, "Invalid build state.");
  text(item.build.message, "build message", 20000);
}
function presentation(value) {
  if (value === undefined) return;
  requireObject(value, "placement presentation");
  if (Object.keys(value).some((key) => !["mode", "viewport", "paper", "featuredFrom"].includes(key)) ||
      !["card", "panel", "icon"].includes(value.mode))
    throw storeError(400, "Presentation mode must be card, panel or icon.");
  if (value.featuredFrom !== undefined) assertId(value.featuredFrom);
  if (value.paper !== undefined) color(value.paper);
  if (value.viewport !== undefined) {
    requireObject(value.viewport, "presentation viewport");
    if (Object.keys(value.viewport).some((key) => !["width", "height"].includes(key)) ||
        ["width", "height"].some((key) => !Number.isInteger(value.viewport[key]) ||
          value.viewport[key] < 40 || value.viewport[key] > 10000))
      throw storeError(400, "Presentation viewport dimensions must be integers from 40 to 10000.");
  }
}
function geometry(placement) {
  assertId(placement.id);
  assertId(placement.itemId);
  presentation(placement.presentation);
  for (const key of ["x", "y", "width", "height", "z"])
    if (
      typeof placement[key] !== "number" ||
      !Number.isFinite(placement[key]) ||
      Math.abs(placement[key]) > 10000000
    )
      throw storeError(400, "Invalid placement geometry.");
  if (
    placement.width < 40 ||
    placement.height < 40 ||
    placement.width > 100000 ||
    placement.height > 100000
  )
    throw storeError(400, "Placement dimensions are out of range.");
}
function color(value) {
  if (
    typeof value !== "string" ||
    !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
  )
    throw storeError(400, "Color must be a hexadecimal color.");
}
function decorationColor(value) {
  if (!isDrawingColor(value)) throw storeError(400, "Color must be a named drawing palette color or a hexadecimal color.");
}
function decoration(entry) {
  requireObject(entry, "decoration");
  assertId(entry.id);
  if (!["text", "region", "line"].includes(entry.type))
    throw storeError(400, "Unsupported decoration type.");
  for (const key of ["x", "y", "width", "height"])
    if (
      typeof entry[key] !== "number" ||
      !Number.isFinite(entry[key]) ||
      Math.abs(entry[key]) > 10000000
    )
      throw storeError(400, "Invalid decoration geometry.");
  if (
    entry.width <= 0 ||
    entry.height <= 0 ||
    entry.width > 100000 ||
    entry.height > 100000
  )
    throw storeError(400, "Invalid decoration dimensions.");
  // Optional place in the board's shared stacking order (see public/stacking.js).
  if (entry.z !== undefined && (typeof entry.z !== "number" || !Number.isFinite(entry.z) || Math.abs(entry.z) > STACK_RANGE))
    throw storeError(400, "Decoration z must be a finite number from -10000000 to 10000000.");
  decorationColor(entry.color);
  text(entry.text, "decoration text", 20000);
  for (const key of ["endArrow", "startArrow", "dashed", "flipX", "flipY"]) {
    if (entry[key] === undefined) continue;
    if (entry.type !== "line" || typeof entry[key] !== "boolean")
      throw storeError(400, "Line arrow and direction fields must be boolean and belong to a line.");
  }
  // Optional line style; absence keeps the original straight, medium, solid look.
  if(entry.route!==undefined&&(entry.type!=='line'||!['straight','elbow','curved'].includes(entry.route)))throw storeError(400,'Unsupported line route.');
  if(entry.bend!==undefined&&(entry.type!=='line'||!Number.isFinite(entry.bend)||Math.abs(entry.bend)>MAX_ARROW_BEND))
    throw storeError(400,'Arrow bend must be a finite board-unit offset from −10000 to 10000.');
  if(entry.thickness!==undefined&&(entry.type!=='line'||!validArrowThickness(entry.thickness)))
    throw storeError(400,`Line thickness must be thin, medium, thick or an integer from 1 to ${MAX_ARROW_THICKNESS}.`);
  const isText = entry.type === 'text';
  if(entry.sticker!==undefined&&(!isText||entry.sticker!==true||emojiSticker(entry.text)!==entry.text))
    throw storeError(400,'A sticker must be a Text decoration with one emoji.');
  if(entry.rotation!==undefined&&(!entry.sticker||!Number.isInteger(entry.rotation)||entry.rotation < -180||entry.rotation > 180))
    throw storeError(400,'Sticker rotation must be an integer from −180 to 180 degrees.');
  if (entry.textSize !== undefined) {
    const preset = ['small','medium','large'].includes(entry.textSize);
    const pixels = Number.isInteger(entry.textSize) && entry.textSize >= 10 && entry.textSize <= 144;
    if (entry.type === 'line' || (!preset && !pixels)) throw storeError(400, 'Unsupported text size.');
  }
  if(entry.textAlign!==undefined&&(entry.type==='line'||!['left','center','right'].includes(entry.textAlign)))throw storeError(400,'Unsupported text alignment.');
  if (!isText && ['textFace','textFill','textBorder','textPadding','textSizing'].some(key => entry[key] !== undefined))
    throw storeError(400, 'Text style fields belong to Text blocks.');
  if (entry.textSizing !== undefined && !['auto','fixed'].includes(entry.textSizing))
    throw storeError(400, 'Unsupported Text sizing mode.');
  if (entry.textFace !== undefined && !['serif','sans','mono'].includes(entry.textFace))
    throw storeError(400, 'Unsupported text face.');
  if (entry.textFill !== undefined && !['none','paper','tint','strong'].includes(entry.textFill))
    decorationColor(entry.textFill);
  if (entry.textBorder !== undefined && entry.textBorder !== null) {
    const border = requireObject(entry.textBorder, 'text border');
    if (!['solid','dashed'].includes(border.style) || Object.keys(border).some(key => !['style','color'].includes(key)))
      throw storeError(400, 'Invalid text border.');
    if (border.color !== undefined) decorationColor(border.color);
  }
  if (entry.textPadding !== undefined && (!Number.isInteger(entry.textPadding) || entry.textPadding < 0 || entry.textPadding > 64))
    throw storeError(400, 'Text padding must be an integer from 0 to 64.');
  if(entry.shape!==undefined&&(entry.type!=='region'||!['rectangle','rounded','diamond','ellipse'].includes(entry.shape)))throw storeError(400,'Unsupported region shape.');
  validateContainer(entry);
  if((entry.from===undefined)!==(entry.to===undefined))throw storeError(400,'Line endpoints require both from and to.');
  if(entry.from!==undefined){if(entry.type!=='line')throw storeError(400,'Endpoints belong to lines.');endpoint(entry.from);endpoint(entry.to);}
}
function endpoint(value){
  requireObject(value,'line endpoint');
  const point=Object.hasOwn(value,'x')||Object.hasOwn(value,'y');
  if(point){if(Object.keys(value).some(key=>!['x','y'].includes(key))||['x','y'].some(key=>typeof value[key]!=='number'||!Number.isFinite(value[key])||Math.abs(value[key])>10000000))throw storeError(400,'Endpoint requires finite x/y coordinates.');return;}
  const key=value.placementId?'placementId':value.decorationId?'decorationId':null;
  if(!key||Object.keys(value).some(field=>![key,'side','offset','fallback'].includes(field))||!['top','right','bottom','left'].includes(value.side)||value.offset!==undefined&&(typeof value.offset!=='number'||!Number.isFinite(value.offset)||value.offset<0||value.offset>1))throw storeError(400,'Invalid attached endpoint.');
  assertId(value[key]);
  if(value.fallback!==undefined){requireObject(value.fallback,'endpoint fallback');if(Object.keys(value.fallback).some(key=>!['x','y'].includes(key))||['x','y'].some(key=>typeof value.fallback[key]!=='number'||!Number.isFinite(value.fallback[key])||Math.abs(value.fallback[key])>10000000))throw storeError(400,'Invalid endpoint fallback.');}
}
function freezeBoardAttachments(board,{placementIds,decorationIds,geometryBoard=board}={}){
  const selected=endpoint=>(!placementIds&&!decorationIds)||endpoint.placementId&&placementIds?.has(endpoint.placementId)||endpoint.decorationId&&decorationIds?.has(endpoint.decorationId);
  for(const line of board.decorations){if(line.type!=='line'||!line.from)continue;const resolved=resolveLine(line,geometryBoard);for(const key of ['from','to'])if((line[key].placementId||line[key].decorationId)&&selected(line[key]))line[key].fallback={x:resolved[key].x,y:resolved[key].y};}
}
function reflowBoardContainers(board, items, previous, previousItems) {
  const flowed = layoutContainers(board,items,previous,previousItems);
  if (flowed === board) return;
  const changedGeometry = (entries, prior) => {
    const before = new Map(prior.map(entry => [entry.id,entry]));
    return new Set(entries.filter(entry => {
      const saved = before.get(entry.id);
      return entry.type !== 'line' && saved && ['x','y','width','height'].some(key => entry[key] !== saved[key]);
    }).map(entry => entry.id));
  };
  if (previous) {
    const decorationIds = changedGeometry(flowed.decorations,previous.decorations);
    const placementIds = changedGeometry(flowed.placements,previous.placements);
    if (decorationIds.size || placementIds.size)
      freezeBoardAttachments(board,{decorationIds,placementIds,geometryBoard:{...previous,items:previousItems}});
  }
  if (flowed.decorations.some((entry,index) => entry !== board.decorations[index]))
    board.updatedAt = now();
  board.placements = flowed.placements;
  board.decorations = flowed.decorations;
}
function remapCopiedContainers(board, items, placementMap) {
  if (!board.decorations.some(entry => entry.container)) return;
  const active = new Set(board.placements.filter(placement => isActiveContainerPlacement(placement,items)).map(placement => placement.id));
  const activeCopies = new Map([...placementMap].filter(([,id]) => active.has(id)));
  for (const entry of board.decorations) remapContainerChildren(entry,activeCopies);
  reflowBoardContainers(board,items);
}
function freezeItemAttachments(state,itemIds){
  const selected=new Set(itemIds);
  for(const board of Object.values(state.boards)){const placements=new Set(board.placements.filter(p=>selected.has(p.itemId)).map(p=>p.id));if(placements.size)freezeBoardAttachments(board,{placementIds:placements});}
}
function validateNewAttachments(board,entry){
  for(const value of [entry.from,entry.to]){
    if(value?.placementId&&!board.placements.some(p=>p.id===value.placementId&&!p.removedAt&&!p.deletedAt&&!p.archivedAt))throw storeError(400,'Attached placement must belong to this board.');
    if(value?.decorationId&&!board.decorations.some(d=>d.id===value.decorationId&&d.id!==entry.id&&d.type!=='line'))throw storeError(400,'Attached decoration must be a non-line on this board.');
  }
}
function remapAttachments(decorations,placementMap){
  for(const line of decorations)for(const key of ['from','to'])if(line[key]?.placementId&&placementMap.get(line[key].placementId))line[key].placementId=placementMap.get(line[key].placementId);
}
const active = (placement) => !placement.removedAt && !placement.deletedAt;
function validateState(state) {
  const { metadata, items, boards } = state;
  validateResourceRoots(metadata.resourceRoots);
  for (const item of Object.values(items)) {
    validateItem(item, metadata.resourceRoots);
    if (item.childBoardId && !Object.hasOwn(boards, item.childBoardId))
      throw storeError(400, "Unknown child board.");
  }
  for (const board of Object.values(boards)) {
    assertId(board.id);
    title(board.title);
    if (board.description !== undefined)
      text(board.description, "board description", 200000);
    if (
      board.schemaVersion !== 2 ||
      !Array.isArray(board.placements) ||
      !Array.isArray(board.rounds) ||
      !Array.isArray(board.reviewOrder) ||
      !Array.isArray(board.decorations)
    )
      throw storeError(400, "Invalid board.");
    if (
      !Object.hasOwn(items, board.ownerItemId) ||
      items[board.ownerItemId].childBoardId !== board.id
    )
      throw storeError(400, "Board owner mismatch.");
    const ids = new Set();
    for (const placement of board.placements) {
      geometry(placement);
      if (ids.has(placement.id))
        throw storeError(400, "Duplicate placement ID.");
      ids.add(placement.id);
      if (!Object.hasOwn(items, placement.itemId))
        throw storeError(400, "Unknown placement item.");
    }
    if (
      new Set(board.reviewOrder).size !== board.reviewOrder.length ||
      board.reviewOrder.some((id) => !ids.has(id))
    )
      throw storeError(400, "Invalid review order.");
    if (
      board.decorations.length > 10000 ||
      JSON.stringify(board.decorations).length > 2000000
    )
      throw storeError(400, "Board decorations are too large.");
    const decorationIds = new Set();
    for (const entry of board.decorations) {
      decoration(entry);
      if (decorationIds.has(entry.id))
        throw storeError(400, "Duplicate decoration ID.");
      decorationIds.add(entry.id);
    }
    validateContainerChildren(board,items);
    validateOccurrenceGroups(board);
    if (board.background !== undefined && board.background !== null) {
      requireObject(board.background, "background");
      if (board.background.color !== undefined) color(board.background.color);
    }
    if (board.background?.resource) {
      validateResource(board.background.resource);
      if (
        !Object.hasOwn(metadata.resourceRoots, board.background.resource.rootId)
      )
        throw storeError(400, "Unknown background resource root.");
    }
  }
  if (
    !Array.isArray(metadata.homeBoardIds) ||
    new Set(metadata.homeBoardIds).size !== metadata.homeBoardIds.length ||
    metadata.homeBoardIds.some((id) => !Object.hasOwn(boards, id))
  )
    throw storeError(400, "Invalid home boards.");
  const visiting = new Set(),done = new Set();
  for(const start of Object.keys(boards)){
    if(done.has(start))continue;
    const pending=[{id:start,exit:false}];
    while(pending.length){const {id,exit}=pending.pop();if(exit){visiting.delete(id);done.add(id);continue;}if(visiting.has(id))throw storeError(409,'Board relationship would create a cycle.');if(done.has(id))continue;visiting.add(id);pending.push({id,exit:true});for(const p of boards[id].placements){const item=items[p.itemId];if(active(p)&&!item.deletedAt&&item.childBoardId)pending.push({id:item.childBoardId,exit:false});}}
  }
  if (JSON.stringify(metadata).length > 2000000)
    throw storeError(400, "Workspace metadata is too large.");
}
export function emptyWorkspace() {
  return {
    metadata: {
      schemaVersion: 2,
      id: fresh("workspace"),
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
      resourceRoots: {},
      homeBoardIds: [],
      recentOperations: [],
    },
    items: {},
    boards: {},
  };
}
function publicWorkspace(state) {
  if (!state) return null;
  const { recentOperations, movementHistoryKey, ...metadata } = state.metadata;
  return {
    ...clone(metadata),
    workspaceId: metadata.id,
    structural:{version:2,scope:'workspace'},
    items: Object.values(state.items).map(clone),
    boards: Object.values(state.boards).map(board=>({...clone(board),structural:{version:2,scope:'board'}})),
  };
}
export async function readWorkspace(config, {covers = false} = {}) {
  const snapshot = await withStore(config, (_root, state) => state ? {...publicWorkspace(state), ...(covers ? {boardCovers:boardCovers(state.boards,state.items,state.metadata.homeBoardIds)} : {})} : null);
  if (snapshot?.boardCovers) await coverRevisions(config,snapshot.boardCovers);
  return snapshot;
}
export async function workspaceHeader(config){return withStore(config,(_root,state)=>state?{enabled:true,workspaceId:state.metadata.id,revision:state.metadata.revision,updatedAt:state.metadata.updatedAt}:{enabled:false,revision:0},{metadataOnly:true});}
export async function workspaceView(config,view,{covers=true}={}){
  if(!['home','graph'].includes(view))throw storeError(400,'Workspace view must be home or graph.');
  const catalog=await (await import('./discovery.mjs')).discoveryCatalog(config);
  if(!catalog)return {enabled:false,revision:0};
  const {metadata,index}=catalog;
  if(view==='graph')return {enabled:true,view,structural:{version:2,scope:'graph'},workspaceId:metadata.id,revision:metadata.revision,homeBoardIds:metadata.homeBoardIds,
    items:Object.values(index.items).map(item=>({id:item.id,title:item.title,childBoardId:item.childBoardId,...(item.archived?{archivedAt:true}:{}),...(item.deleted?{deletedAt:true}:{})})),
    boards:Object.values(index.boards).map(board=>({structural:{version:2,scope:'identity'},id:board.id,title:board.title,ownerItemId:board.ownerItemId,placements:board.placements.map(({archived,...p})=>p)}))};
  const home=new Set(metadata.homeBoardIds),boards={},items={};
  // Derived covers need compact content/resource references only, not document
  // text, reviews, revisions or child-board layouts across the workspace.
  for(const [id,item] of Object.entries(index.items))items[id]={...item,...(item.archived?{archivedAt:true}:{}),...(item.deleted?{deletedAt:true}:{}),review:{star:item.star}};
  for(const [id,board] of Object.entries(index.boards))if(home.has(id))boards[id]={...board,placements:board.placements.map(({archived,...p})=>p)};
  const boardCovers=covers?boardCoversForView(boards,items,metadata.homeBoardIds):undefined;
  if(boardCovers)await coverRevisions(config,boardCovers);
  return {enabled:true,view,workspaceId:metadata.id,revision:metadata.revision,homeBoardIds:metadata.homeBoardIds,...(metadata.homeLayout?{homeLayout:clone(metadata.homeLayout)}:{}),
    boards:Object.values(boards).map(board=>({schemaVersion:2,id:board.id,title:board.title,description:board.description,ownerItemId:board.ownerItemId,createdAt:board.createdAt,updatedAt:board.updatedAt,itemCount:board.placements.filter(p=>!p.archivedAt).length,roundCount:board.roundCount})),
    items:Object.values(boards).map(board=>{const item=items[board.ownerItemId];return {id:item.id,title:item.title,description:item.description,childBoardId:item.childBoardId,review:item.review,preview:item.preview,archivedAt:item.archivedAt,deletedAt:item.deletedAt};}),...(boardCovers?{boardCovers}:{})};
}
const boardCoversForView=(boards,items,ids)=>boardCovers(boards,items,ids);
export async function getBoardSnapshot(config, id, { versionStacks = true } = {}) {
  assertId(id);
  const snapshot = await withStore(config, async (root, header) => {
    if (!header) return null;
    const board=await readStoreDocument(root,'boards',id,{optional:true});
    if(!board)return null;
    const state={metadata:header.metadata,items:{},boards:{[id]:board}};
    const readItem=async itemId=>state.items[itemId]||(state.items[itemId]=await readStoreDocument(root,'items',itemId));
    if((await readItem(board.ownerItemId)).deletedAt)return null;
    for(const p of board.placements)await readItem(p.itemId);
    const items = {};
    for (const placement of board.placements)
      items[placement.itemId] = clone(state.items[placement.itemId]);
    items[board.ownerItemId] = clone(state.items[board.ownerItemId]);
    // Covers are deliberately one level deep. Read only immediate child boards
    // and their canonical items, never their descendants or resource payloads.
    for(const item of Object.values(items))if(item.childBoardId&&item.childBoardId!==id){const child=await readStoreDocument(root,'boards',item.childBoardId,{optional:true});if(!child)continue;state.boards[child.id]=child;await readItem(child.ownerItemId);for(const p of child.placements)await readItem(p.itemId);}
    return {
      ...clone(board),
      structural:{version:2,scope:'board',items:Object.fromEntries(Object.entries(state.items).filter(([id])=>!Object.hasOwn(items,id)).map(([id,item])=>[id,structuralItem(item)]))},
      revision: state.metadata.revision,
      workspaceId: state.metadata.id,
      resourceRoots: clone(state.metadata.resourceRoots),
      childBoards:Object.fromEntries(Object.entries(state.boards).filter(([boardId])=>boardId!==id).map(([boardId,child])=>[boardId,{...clone(child),structural:{version:2,scope:'board'}}])),
      items,
      childBoardCreatedAt:Object.fromEntries(Object.values(items).filter(item => item?.childBoardId)
        .map(item => [item.childBoardId,state.boards[item.childBoardId]?.createdAt])),
      boardCovers:boardCovers(state.boards,state.items,[id,...Object.values(items).map(item=>item?.childBoardId).filter(Boolean)]),
    };
  },{metadataOnly:true});
  if (snapshot) {
    await coverRevisions(config,snapshot.boardCovers);
    if (versionStacks) {
      const projectStack = versionStackProjector(config, snapshot.resourceRoots);
      for (const item of Object.values(snapshot.items)) {
        delete item.versionStack;
        const stack = await projectStack(item);
        if (stack) item.versionStack = stack;
      }
    }
  }
  return snapshot;
}
export async function getItemSnapshot(config, id, { versionStacks = true } = {}) {
  assertId(id);
  const result = await withStore(config, async (root, state) => {
    if (!state) return null;
    const item = await readStoreDocument(root, 'items', id, { optional: true });
    return item && !item.deletedAt ? { item, roots: state.metadata.resourceRoots } : null;
  }, { metadataOnly: true });
  if (!result) return null;
  const { item, roots } = result;
  if (versionStacks) {
    delete item.versionStack;
    const stack = await versionStackProjector(config, roots)(item);
    if (stack) item.versionStack = stack;
  }
  return item;
}
export async function boardExists(config,id){assertId(id);return withStore(config,async(root,state)=>!!state&&!!await readStoreDocument(root,'boards',id,{optional:true}),{metadataOnly:true});}
export async function getBoardGeometry(config,id){
  assertId(id);return withStore(config,async(root,state)=>{
    const board=state&&await readStoreDocument(root,'boards',id,{optional:true});
    if(!board)throw storeError(404,'Board not found.');
    const owner=await readStoreDocument(root,'items',board.ownerItemId);if(owner.deletedAt)throw storeError(404,'Board not found.');
    const items={},ids=new Set();for(const line of board.decorations)for(const endpoint of [line.from,line.to])if(endpoint?.placementId){const p=board.placements.find(p=>p.id===endpoint.placementId);if(p)ids.add(p.itemId);}
    for(const itemId of ids)items[itemId]=await readStoreDocument(root,'items',itemId);
    return {revision:state.metadata.revision,...resolveBoardGeometry({...board,items})};
  },{metadataOnly:true});
}
function getItem(state, id) {
  assertId(id);
  if (!Object.hasOwn(state.items, id) || state.items[id].deletedAt)
    throw storeError(404, "Item not found.");
  return state.items[id];
}
function getBoard(state, id) {
  assertId(id);
  if (
    !Object.hasOwn(state.boards, id) ||
    state.items[state.boards[id].ownerItemId]?.deletedAt
  )
    throw storeError(404, "Board not found.");
  return state.boards[id];
}
function makeItem(state, input = {}) {
  requireObject(input, "item");
  const stamp = now(),
    id = input.id || fresh("item");
  assertId(id);
  if (Object.hasOwn(state.items, id))
    throw storeError(409, "Item already exists.");
  const item = {
    ...clone(input),
    schemaVersion: 2,
    id,
    title: input.title || "Untitled",
    description: input.description ?? "",
    createdAt: input.createdAt || stamp,
    updatedAt: stamp,
    revisions: clone(input.revisions || []),
    review: {
      note: "",
      star: false,
      updatedAt: 0,
      ...clone(input.review || {}),
    },
    build: {
      state: "ready",
      message: "",
      updatedAt: 0,
      ...clone(input.build || {}),
    },
  };
  delete item.versionStack;
  state.items[id] = item;
  return item;
}
// Choose a readable representation only when creating a new item. Loading,
// updating, moving and copying saved placements must never reinterpret geometry.
function newItemPlacement(item, input = {}) {
  const visual = ["html", "image", "video", "pdf", "markdown"].includes(item.content?.kind) || item.preview?.resource || item.preview?.url;
  const mode = input.presentation?.mode || (visual ? "panel" : "card");
  const defaults = mode === "panel" ? { width: 720, height: 560 }
    : mode === "icon" ? { width: 218, height: 112 } : {};
  return { ...defaults, ...clone(input), presentation: { mode, ...clone(input.presentation || {}) } };
}
// The highest key in the board's shared stacking order (0 for an empty board).
function stackTopKey(board) {
  return stackOrder(board).reduce((top, entry) => Math.max(top, entry.key), 0);
}
function place(board, itemId, input = {}) {
  const existing = board.placements.filter(active);
  const count = existing.length;
  const placement = {
    x: (count % 4) * ((input.width ?? 320) + 40),
    y: Math.floor(count / 4) * ((input.height ?? 240) + 60),
    width: 320,
    height: 240,
    // A new placement lands on top of everything on the board.
    z: input.z === undefined ? stackTopKey(board) + 1 : input.z,
    ...clone(input),
    id: fresh("placement"),
    itemId,
  };
  if (
    input.x === undefined &&
    input.y === undefined &&
    existing.some(
      (p) =>
        placement.x < p.x + p.width &&
        placement.x + placement.width > p.x &&
        placement.y < p.y + p.height &&
        placement.y + placement.height > p.y,
    )
  ) {
    placement.x = Math.max(...existing.map((p) => p.x + p.width)) + 40;
    placement.y = 0;
  }
  board.placements.push(placement);
  board.reviewOrder.push(placement.id);
  return placement;
}
function makeBoard(state, input) {
  const id = input.id || fresh("board");
  assertId(id);
  if (Object.hasOwn(state.boards, id))
    throw storeError(409, "Board already exists.");
  const item = input.itemId
    ? getItem(state, input.itemId)
    : makeItem(state, {
        title: input.title || "Untitled board",
        description: input.description ?? "",
      });
  if (item.childBoardId)
    throw storeError(409, "Item already has a child board.");
  item.childBoardId = id;
  item.updatedAt = now();
  const board = {
    schemaVersion: 2,
    id,
    ownerItemId: item.id,
    title: input.title || item.title,
    description: input.description ?? item.description,
    createdAt: now(),
    updatedAt: now(),
    placements: [],
    reviewOrder: [],
    rounds: [],
    decorations: [],
  };
  state.boards[id] = board;
  const placementIds = [];
  if (input.parentBoardId)
    placementIds.push(place(getBoard(state, input.parentBoardId), item.id).id);
  else state.metadata.homeBoardIds.push(id);
  return { board, item, placementIds };
}
function selectedDecorations(board, ids) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 10000 || new Set(ids).size !== ids.length)
    throw storeError(400, "Select unique decoration IDs.");
  return ids.map(id => {
    assertId(id);
    const found = (board.decorations || []).find(d => d.id === id);
    if (!found) throw storeError(404, "Decoration not found.");
    return found;
  });
}
function selectedPlacements(board, ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10000 ||
    new Set(ids).size !== ids.length
  )
    throw storeError(400, "Select unique placement IDs.");
  return ids.map((id) => {
    assertId(id);
    const found = board.placements.find(
      (entry) => entry.id === id && active(entry),
    );
    if (!found) throw storeError(404, "Placement not found.");
    return found;
  });
}
function checkMoveSource(state, op, source) {
  const hasPlacements = Object.hasOwn(op, "expectedSourcePlacements");
  const hasOrder = Object.hasOwn(op, "expectedSourceReviewOrder");
  if (!hasPlacements && !hasOrder) return;
  if (!hasPlacements || !hasOrder || op.type !== "move" || !source ||
      !op.targetBoardId || op.newBoard || op.targetBoardId === source.id ||
      !Array.isArray(op.placementIds) || !op.placementIds.length || op.placementIds.length > 10000 ||
      new Set(op.placementIds).size !== op.placementIds.length || op.itemIds ||
      !Array.isArray(op.expectedSourcePlacements) || op.expectedSourcePlacements.length !== op.placementIds.length ||
      !Array.isArray(op.expectedSourceReviewOrder))
    throw storeError(400, "Move source preconditions require selected placement snapshots and review order with an existing distinct destination.");
  const selected = new Set(op.placementIds.map(assertId));
  for (let index = 0; index < op.expectedSourcePlacements.length; index++) {
    const saved = requireObject(op.expectedSourcePlacements[index], "expected source placement");
    geometry(saved);
    if (saved.id !== op.placementIds[index] || !active(saved))
      throw storeError(400, "Expected source placements must match the active selection in input order.");
  }
  if (new Set(op.expectedSourceReviewOrder).size !== op.expectedSourceReviewOrder.length ||
      op.expectedSourceReviewOrder.some(id => !selected.has(id)))
    throw storeError(400, "Expected source review order must contain unique selected placement IDs.");
  // Guard only the saved selection: unrelated placements and canonical edits
  // remain independent while a native cut waits for its eventual paste.
  const current = op.placementIds.map(id => source.placements.find(p => p.id === id && active(p)));
  if (!isDeepStrictEqual(current, op.expectedSourcePlacements) ||
      !isDeepStrictEqual(source.reviewOrder.filter(id => selected.has(id)), op.expectedSourceReviewOrder))
    throw storeError(409, "Cut selection changed. Cut the current selection again before pasting.");
  const destination = getBoard(state, op.targetBoardId);
  if ([source, destination].some(board => state.items[board.ownerItemId].archivedAt) ||
      current.some(p => p.archivedAt || state.items[p.itemId]?.archivedAt || state.items[p.itemId]?.deletedAt))
    throw storeError(409, "Cut requires active items and boards. Restore them before cutting again.");
}
function ids(input) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 10000 ||
    new Set(input).size !== input.length
  )
    throw storeError(400, "Select unique item IDs.");
  return input.map(assertId);
}
function boolean(value) {
  if (typeof value !== "boolean")
    throw storeError(400, "Expected archived boolean.");
  return value;
}
function finishBoard(board) {
  board.updatedAt = now();
  const present = new Set(board.placements.filter(active).map((p) => p.id));
  board.reviewOrder = board.reviewOrder.filter((id) => present.has(id));
}
const arrangement = (board) => ({placements:board.placements, reviewOrder:board.reviewOrder});
const hashArrangement = (board) => createHash("sha256").update(JSON.stringify(arrangement(board))).digest("hex");
function movementBoards(op) {
  if (op.type === "reference" && op.featureOnParent === true && op.targetBoardId) return [op.targetBoardId];
  if (op.type === "pastePlacements" || op.type === "importFiles") return [op.targetBoardId];
  if (op.type === "groupOccurrences" || op.type === "ungroupOccurrences" || op.type === "restackOccurrences") return [op.boardId];
  if (op.type === "remove" || op.type === "translatePlacements" || op.type === "duplicateOccurrences" || op.type === "arrangePlacements" || (op.type === "updatePlacement" &&
      object(op.patch) && ["x","y","width","height","z"].some(key => Object.hasOwn(op.patch,key))))
    return [op.boardId];
  if (op.type === "move" && op.sourceBoardId && op.placementIds && op.targetBoardId && !op.newBoard)
    return [...new Set([op.sourceBoardId,op.targetBoardId])];
  return editsContainerLayout(op) && op.boardId ? [op.boardId] : [];
}
const editsContainerLayout = op => [
  "createDecoration","removeDecoration","updateDecoration","moveContainerMember",
].includes(op.type) || op.type === "updateBoard" && object(op.patch) && Object.hasOwn(op.patch,"decorations");
function containerLayoutBoards(op, state, before, historyBoards) {
  if (["groupOccurrences","ungroupOccurrences","reference","importFiles"].includes(op.type)) return [];
  if (historyBoards.length) return historyBoards;
  if (op.type === "archive") return [op.boardId];
  if (op.type === "move" && op.sourceBoardId) return [op.sourceBoardId];
  const itemIds = op.type === "deleteItem" || op.type === "archiveItem" ? op.itemIds
    : op.type === "updateItem" && Object.hasOwn(op.patch,"archivedAt") ? [op.itemId] : [];
  const affectedItems = new Set(itemIds.filter(id => !before.items[id].archivedAt && !before.items[id].deletedAt &&
    (state.items[id].archivedAt || state.items[id].deletedAt)));
  if (!affectedItems.size) return [];
  return Object.values(state.boards).filter(board => board.decorations.some(entry => entry.container) &&
    board.placements.some(placement => affectedItems.has(placement.itemId))).map(board => board.id);
}
function pastePlacements(state, op) {
  const saved = requireObject(op.clipboard, "clipboard"), destination = getBoard(state, op.targetBoardId);
  if (Object.keys(saved).some(key => !["version", "workspaceId", "placements", "items", "boards", "reviewOrder", "decorations", "groups"].includes(key)) ||
      saved.version !== 1 || saved.workspaceId !== state.metadata.id)
    throw storeError(400, "Clipboard belongs to another workspace or version.");
  requireObject(saved.items, "clipboard items");
  requireObject(saved.boards, "clipboard boards");
  requireObject(op.targetPosition, "targetPosition");
  if (Object.keys(op.targetPosition).some(key => !["x", "y"].includes(key)) ||
      ["x", "y"].some(key => typeof op.targetPosition[key] !== "number" ||
        !Number.isFinite(op.targetPosition[key]) || Math.abs(op.targetPosition[key]) > 10000000))
    throw storeError(400, "Paste requires finite targetPosition x/y coordinates.");
  const drawings = saved.decorations === undefined ? [] : saved.decorations;
  if (!Array.isArray(saved.placements) || saved.placements.length > 10000 || !Array.isArray(drawings) ||
      drawings.length > 10000 || (!saved.placements.length && !drawings.length))
    throw storeError(400, "Clipboard requires selected placements or drawn elements.");
  const drawingIds = new Set();
  for (const drawing of drawings) {
    decoration(drawing);
    if (drawingIds.has(drawing.id)) throw storeError(400, "Clipboard requires unique drawn elements.");
    drawingIds.add(drawing.id);
  }
  const sourceSelection = {...saved, decorations:drawings};
  const placementIds = new Set(), itemIds = new Set();
  for (const placement of saved.placements) {
    requireObject(placement, "clipboard placement");
    geometry(placement);
    if (!active(placement) || placementIds.has(placement.id))
      throw storeError(400, "Clipboard requires unique active placements.");
    placementIds.add(placement.id);
    itemIds.add(placement.itemId);
  }
  validateOccurrenceGroups(sourceSelection);
  const order = saved.reviewOrder === undefined ? [...placementIds] : saved.reviewOrder;
  if (!Array.isArray(order) || new Set(order).size !== order.length || order.length !== placementIds.size ||
      order.some(id => !placementIds.has(id)))
    throw storeError(400, "Invalid clipboard review order.");
  if (Object.keys(saved.items).length !== itemIds.size || Object.keys(saved.items).some(id => !itemIds.has(id)))
    throw storeError(400, "Clipboard items must match selected placements.");
  const boardIds = new Set();
  for (const id of itemIds) {
    const original = requireObject(saved.items[id], "clipboard item");
    validateItem(original, state.metadata.resourceRoots);
    if (original.id !== id || original.deletedAt)
      throw storeError(400, "Invalid clipboard item identity.");
    if (original.childBoardId) boardIds.add(original.childBoardId);
  }
  if (Object.keys(saved.boards).length !== boardIds.size || Object.keys(saved.boards).some(id => !boardIds.has(id)))
    throw storeError(400, "Clipboard boards must match selected board items.");
  // A clipboard captures canonical data and arrangement at copy time. It does
  // not depend on the source placement still existing when paste occurs.
  const copies = new Map();
  for (const id of itemIds) {
    const copied = clone(saved.items[id]);
    for (const key of ["id", "childBoardId", "archivedAt", "deletedAt", "legacy", "createdAt"])
      delete copied[key];
    copies.set(id, makeItem(state, copied));
  }
  for (const id of itemIds) {
    const original = saved.items[id], item = copies.get(id);
    if (!original.childBoardId) continue;
    const source = requireObject(saved.boards[original.childBoardId], "clipboard board");
    if (source.id !== original.childBoardId || source.ownerItemId !== id || source.schemaVersion !== 2 ||
        !Array.isArray(source.placements) || source.placements.length > 10000 || !Array.isArray(source.reviewOrder) ||
        !Array.isArray(source.rounds) || !Array.isArray(source.decorations))
      throw storeError(400, "Invalid clipboard board.");
    title(source.title);
    if (source.description !== undefined) text(source.description, "board description", 200000);
    const made = makeBoard(state, {itemId:item.id, title:source.title}).board;
    // Board copies are contained by the pasted owner, including while undone.
    state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(boardId => boardId !== made.id);
    made.description = source.description ?? "";
    made.rounds = clone(source.rounds);
    made.decorations = clone(source.decorations);
    if (source.background !== undefined) made.background = clone(source.background);
    const children = new Map();
    for (const placement of source.placements) {
      requireObject(placement, "clipboard board placement");
      geometry(placement);
      if (children.has(placement.id)) throw storeError(400, "Duplicate clipboard board placement.");
      children.set(placement.id, null);
      if (!active(placement)) continue;
      const childId = copies.get(placement.itemId)?.id || getItem(state, placement.itemId).id;
      const childPlacement = clone(placement);
      if (copies.has(placement.itemId) && childPlacement.presentation) delete childPlacement.presentation.featuredFrom;
      children.set(placement.id, place(made, childId, childPlacement).id);
    }
    if (new Set(source.reviewOrder).size !== source.reviewOrder.length || source.reviewOrder.some(id => !children.has(id)))
      throw storeError(400, "Invalid clipboard board review order.");
    made.reviewOrder = source.reviewOrder.map(id => children.get(id)).filter(Boolean);
    remapAttachments(made.decorations,children);
    validateContainerChildren(source);
    remapCopiedContainers(made,state.items,children);
    validateOccurrenceGroups(source);
    copyOccurrenceGroups(source,made,children);
  }
  const positions = [...saved.placements, ...drawings];
  const dx = op.targetPosition.x - Math.min(...positions.map(p => p.x));
  const dy = op.targetPosition.y - Math.min(...positions.map(p => p.y));
  // The pasted selection keeps its own stacking order and relative z distances,
  // and lands on top of everything (copies are not tucked under what they cover).
  const top = stackTopKey(destination), pastedOrder = stackOrder({placements:saved.placements,decorations:drawings});
  const lowest = Math.min(...pastedOrder.map(entry => entry.key));
  const pastedRank = new Map(pastedOrder.map(entry => [entry.ref,entry.key - lowest]));
  if (top + 1 + Math.max(...pastedRank.values()) > STACK_RANGE) throw storeError(400, "Destination stacking order is out of range.");
  const placed = new Map(), previousOrder = [...destination.reviewOrder];
  for (const original of saved.placements) {
    const copied = clone(original);
    for (const key of ["archivedAt", "deletedAt", "removedAt", "removalReason"]) delete copied[key];
    // Clipboard paste creates a new item, so it was never featured from the old source board.
    if (copied.presentation) delete copied.presentation.featuredFrom;
    const placement = place(destination, copies.get(original.itemId).id, {...copied,
      x:original.x + dx, y:original.y + dy,
      z:top + 1 + pastedRank.get(stackRef("placement",original.id))});
    geometry(placement);
    placed.set(original.id, placement.id);
  }
  const drawn = new Map(drawings.map(d => [d.id, fresh("decoration")]));
  const offset = point => ({x:point.x + dx,y:point.y + dy});
  const translateEnd = (end, point) => {
    const placementId = placed.get(end.placementId), decorationId = drawn.get(end.decorationId);
    if (!placementId && !decorationId) return offset(point);
    return {...end, ...(placementId ? {placementId} : {decorationId}), fallback:offset(point)};
  };
  const decorations = drawings.map(drawing => {
    const copied = {...clone(drawing), ...offset(drawing), id:drawn.get(drawing.id), z:top + 1 + pastedRank.get(stackRef("decoration",drawing.id))};
    remapContainerChildren(copied, placed, drawn);
    if (drawing.type === "line" && drawing.from && drawing.to) {
      const {from,to} = resolveLine(drawing,sourceSelection);
      copied.from = translateEnd(drawing.from,from);
      copied.to = translateEnd(drawing.to,to);
    }
    decoration(copied);
    return copied;
  });
  destination.decorations.push(...decorations);
  for (const copied of decorations) validateNewAttachments(destination,copied);
  copyOccurrenceGroups(sourceSelection,destination,placed,drawn);
  destination.reviewOrder = [...previousOrder, ...order.map(id => placed.get(id))];
  finishBoard(destination);
  return {boardId:destination.id, itemIds:saved.placements.map(p => copies.get(p.itemId).id),
    placementIds:saved.placements.map(p => placed.get(p.id)),
    ...(drawings.length ? {decorationIds:[...drawn.values()]} : {})};
}
function signMovement(state, body) {
  state.metadata.movementHistoryKey ||= randomBytes(32).toString("hex");
  const signature = createHmac("sha256",state.metadata.movementHistoryKey).update(JSON.stringify(body)).digest("hex");
  return {...body,signature};
}
// The entries whose JSON differs between two lists of {id} objects.
function changedIds(previous = [], next = []) {
  const old = new Map(previous.map(entry => [entry.id,JSON.stringify(entry)]));
  const current = new Map(next.map(entry => [entry.id,JSON.stringify(entry)]));
  return new Set([...old.keys(),...current.keys()].filter(id => old.get(id) !== current.get(id)));
}
// A board entry records changed placements and review order, changed decorations
// (including affected arrows), and groups whose membership changed. Only placement
// or review order changes need the placement arrangement hash.
function movementHistory(state, before, boardIds) {
  const boards = [];
  for (const id of boardIds) {
    const previous = before.boards[id], next = state.boards[id];
    const arranged = hashArrangement(previous) !== hashArrangement(next);
    const changed = changedIds(previous.placements,next.placements);
    const decorationIds = [...changedIds(previous.decorations,next.decorations)];
    const groups = changedIds(previous.groups,next.groups);
    if (!arranged && !decorationIds.length && !groups.size) continue;
    const moved = new Set(decorationIds);
    const records = (entries, ids) => (entries || []).flatMap((value,index) => ids.has(value.id) ? [{index,value:clone(value)}] : []);
    const side = board => ({
      ...(arranged ? {hash:hashArrangement(board),reviewOrder:clone(board.reviewOrder),
        placements:records(board.placements,changed)} : {}),
      ...(decorationIds.length ? {decorations:records(board.decorations,moved)} : {}),
      ...(groups.size ? {groups:records(board.groups,groups)} : {})});
    boards.push({id,...(decorationIds.length ? {decorationIds} : {}),...(groups.size ? {groupIds:[...groups]} : {}),
      before:side(previous),after:side(next)});
  }
  if (!boards.length) return;
  const home = JSON.stringify(before.metadata.homeBoardIds) === JSON.stringify(state.metadata.homeBoardIds) ? {} :
    {home:{before:clone(before.metadata.homeBoardIds),after:clone(state.metadata.homeBoardIds)}};
  return signMovement(state,{version:1,workspaceId:state.metadata.id,boards,...home});
}
function restoreMovement(state, history) {
  requireObject(history,"movement history");
  const {signature,...body} = history;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) ||
      typeof state.metadata.movementHistoryKey !== "string")
    throw storeError(400,"Invalid movement history receipt.");
  const expected = createHmac("sha256",state.metadata.movementHistoryKey).update(JSON.stringify(body)).digest();
  if (!timingSafeEqual(expected,Buffer.from(signature,"hex")) || body.version !== 1 ||
      body.workspaceId !== state.metadata.id || !Array.isArray(body.boards) || !body.boards.length || body.boards.length > 2)
    throw storeError(400,"Invalid movement history receipt.");
  // Verify every precondition before touching any board. Only arrangements are
  // guarded: later canonical reviews and board/item titles remain independent.
  const targets = body.boards.map(entry => {
    const board = getBoard(state,entry.id);
    const arranged = typeof entry.after?.hash === "string";
    if (entry.decorationIds !== undefined && (!Array.isArray(entry.decorationIds) || !entry.decorationIds.length ||
        !Array.isArray(entry.before?.decorations) || !Array.isArray(entry.after?.decorations)))
      throw storeError(400,"Invalid movement history receipt.");
    if (entry.groupIds !== undefined && (!Array.isArray(entry.groupIds) || !entry.groupIds.length ||
        !Array.isArray(entry.before?.groups) || !Array.isArray(entry.after?.groups)))
      throw storeError(400,"Invalid movement history receipt.");
    if (!arranged && !entry.decorationIds && !entry.groupIds) throw storeError(400,"Invalid movement history receipt.");
    if (arranged && hashArrangement(board) !== entry.after.hash)
      throw storeError(409,"Board arrangement changed. Movement history cannot be applied.");
    // Each recorded decoration must still be exactly as the movement left it.
    for (const id of entry.decorationIds || []) {
      const current = (board.decorations || []).find(d => d.id === id), saved = entry.after.decorations.find(d => d.value.id === id)?.value;
      if (JSON.stringify(current) !== JSON.stringify(saved))
        throw storeError(409,"Board arrangement changed. Movement history cannot be applied.");
    }
    if (entry.groupIds) {
      const current = new Map((board.groups || []).map(group => [group.id,group]));
      const saved = new Map(entry.after.groups.map(({value}) => [value.id,value]));
      if (entry.groupIds.some(id => !isDeepStrictEqual(current.get(id),saved.get(id))))
        throw storeError(409,"Group membership changed. Movement history cannot be applied.");
    }
    return board;
  });
  if (body.home && JSON.stringify(state.metadata.homeBoardIds) !== JSON.stringify(body.home.after))
    throw storeError(409,"Home board order changed. Movement history cannot be applied.");
  for (let i = 0; i < targets.length; i++) {
    const board = targets[i], entry = body.boards[i];
    if (typeof entry.after.hash === "string") {
      const changed = new Set([...entry.before.placements,...entry.after.placements].map(p => p.value.id));
      board.placements = board.placements.filter(p => !changed.has(p.id));
      for (const saved of [...entry.before.placements].sort((a,b) => a.index - b.index))
        board.placements.splice(saved.index,0,clone(saved.value));
      board.reviewOrder = clone(entry.before.reviewOrder);
      if (hashArrangement(board) !== entry.before.hash)
        throw storeError(409,"Movement history does not match the saved arrangement.");
    }
    if (entry.decorationIds) {
      const moved = new Set(entry.decorationIds);
      board.decorations = (board.decorations || []).filter(d => !moved.has(d.id));
      for (const saved of [...entry.before.decorations].sort((a,b) => a.index - b.index))
        board.decorations.splice(Math.min(saved.index,board.decorations.length),0,clone(saved.value));
    }
    if (entry.groupIds) {
      const changed = new Set(entry.groupIds);
      const groups = (board.groups || []).filter(group => !changed.has(group.id));
      for (const saved of [...entry.before.groups].sort((a,b) => a.index - b.index))
        groups.splice(saved.index,0,clone(saved.value));
      setOccurrenceGroups(board,groups);
    }
    const flowed = layoutContainers(board,state.items,undefined,undefined,409);
    if (!isDeepStrictEqual(flowed.decorations,board.decorations) || !isDeepStrictEqual(flowed.placements,board.placements))
      throw storeError(409,'Container layout changed since this edit.');
    // Older receipts lack group data. Reject replay if it would strand or claim a
    // member of a newer group, rather than silently rewriting that membership.
    validateOccurrenceGroups(board,409);
    board.updatedAt = now();
  }
  if (body.home) state.metadata.homeBoardIds = clone(body.home.before);
  const reciprocal = {...body,boards:body.boards.map(entry => ({...entry,before:entry.after,after:entry.before})),
    ...(body.home ? {home:{before:body.home.after,after:body.home.before}} : {})};
  return {result:{boardIds:targets.map(board => board.id)},history:signMovement(state,reciprocal)};
}
function execute(state, op) {
  switch (op.type) {
    case "pastePlacements": return pastePlacements(state, op);
    case "groupOccurrences": {
      const board = getBoard(state, op.boardId);
      const placements = op.placementIds === undefined || Array.isArray(op.placementIds) && !op.placementIds.length
        ? [] : selectedPlacements(board, op.placementIds);
      const decorations = selectedDecorations(board, op.decorationIds);
      const previous = board.groups;
      const {id:groupId,placementIds,decorationIds} = groupOccurrences(board,placements.map(p => p.id),decorations.map(d => d.id));
      if (board.groups !== previous) board.updatedAt = now();
      return {boardId:board.id,groupId,placementIds,decorationIds};
    }
    case "ungroupOccurrences": {
      const board = getBoard(state, op.boardId);
      const {id:groupId,placementIds,decorationIds} = ungroupOccurrences(board,op.groupId);
      board.updatedAt = now();
      return {boardId:board.id,groupId,placementIds,decorationIds};
    }
    case "createItem": {
      if (op.placement !== undefined) {
        requireObject(op.placement, "placement");
        if (
          Object.keys(op.placement).some(
            (key) => !["x", "y", "width", "height", "z", "presentation"].includes(key),
          )
        )
          throw storeError(
            400,
            "Only geometry and presentation may be supplied for a new placement.",
          );
      }
      const item = makeItem(state, op.item);
      const board = op.boardId ? getBoard(state, op.boardId) : null;
      const placement = board ? place(board, item.id, newItemPlacement(item, op.placement)) : null;
      // On top, beneath anything already resting on it; an explicit z is kept.
      if (board && op.placement?.z === undefined) applyStack(board, landOnTop(board, [stackRef("placement", placement.id)]));
      if (board) finishBoard(board);
      return {
        itemId: item.id,
        ...(board ? { boardId: board.id, placementIds: [placement.id] } : {}),
      };
    }
    case "updateItem": {
      const item = getItem(state, op.itemId);
      requireObject(op.patch, "patch");
      for (const key of [
        "id",
        "schemaVersion",
        "createdAt",
        "childBoardId",
        "deletedAt",
        "versionStack",
      ])
        if (Object.hasOwn(op.patch, key))
          throw storeError(400, `Cannot patch ${key}.`);
      Object.assign(item, clone(op.patch), { updatedAt: now() });
      return { itemId: item.id };
    }
    case "review": {
      const item = getItem(state, op.itemId);
      requireObject(op.patch, "review patch");
      if (Object.keys(op.patch).some((key) => !["note", "star"].includes(key)))
        throw storeError(400, "Unknown review property.");
      item.review = {
        ...item.review,
        ...clone(op.patch),
        updatedAt: Date.now(),
      };
      item.updatedAt = now();
      return { itemId: item.id };
    }
    case "createBoard": {
      const made = makeBoard(state, op);
      return {
        boardId: made.board.id,
        itemId: made.item.id,
        placementIds: made.placementIds,
      };
    }
    case "updateBoard": {
      const board = getBoard(state, op.boardId);
      requireObject(op.patch, "board patch");
      if (
        Object.keys(op.patch).some(
          (key) =>
            ![
              "title",
              "description",
              "decorations",
              "background",
              "reviewOrder",
            ].includes(key),
        )
      )
        throw storeError(400, "Unknown board property.");
      const previousDecorations=board.decorations;
      const patch=clone(op.patch);
      if(patch.decorations){
        freezeBoardAttachments(board);
        for(const entry of patch.decorations){const old=previousDecorations.find(d=>d.id===entry.id);for(const key of ['from','to'])if(old?.[key]?.fallback&&entry[key]&&old[key].placementId===entry[key].placementId&&old[key].decorationId===entry[key].decorationId&&old[key].side===entry[key].side&&old[key].offset===entry[key].offset)entry[key].fallback=clone(old[key].fallback);}
      }
      Object.assign(board, patch);
      if(patch.decorations)for(const entry of patch.decorations){const old=previousDecorations.find(d=>d.id===entry.id);if(!old||!isDeepStrictEqual(old.from,entry.from)||!isDeepStrictEqual(old.to,entry.to))validateNewAttachments(board,entry);}
      finishBoard(board);
      return { boardId: board.id };
    }
    case 'createDecoration':{
      const board=getBoard(state,op.boardId),entry=clone(requireObject(op.decoration,'decoration'));
      if(!entry.id)entry.id=fresh('decoration');
      if(board.decorations.some(d=>d.id===entry.id))throw storeError(409,'Decoration ID already exists.');
      decoration(entry);validateNewAttachments(board,entry);
      let initialText;
      if(op.initialText!==undefined){
        if(op.initialText!==true||!entry.container||entry.container.children.length||op.containerId!==undefined)
          throw storeError(400,'An initial Text block requires a new empty container.');
        initialText={id:fresh('decoration'),type:'text',text:'',textSizing:'auto',color:'palette:neutral',x:entry.x,y:entry.y,width:240,height:48};
        entry.container.children.push(initialText.id);
      }
      if(op.containerId !== undefined){
        assertId(op.containerId);
        const parent=board.decorations.find(d=>d.id===op.containerId && d.container);
        if(!parent)throw storeError(404,'Container not found.');
        parent.container.children.push(entry.id);
      }
      // A new drawn element lands on top, beneath anything resting on it; an explicit z is kept.
      const explicitZ=entry.z!==undefined;
      if(!explicitZ){entry.z=stackTopKey(board)+1;if(initialText)initialText.z=entry.z+1;}
      board.decorations.push(entry);
      if(initialText)board.decorations.push(initialText);
      if(!explicitZ)applyStack(board,landOnTop(board,[stackRef('decoration',entry.id),...(initialText?[stackRef('decoration',initialText.id)]:[])]));
      finishBoard(board);return {boardId:board.id,decorationId:entry.id,...(initialText?{initialTextId:initialText.id}:{})};
    }
    case 'updateDecoration':{
      const board=getBoard(state,op.boardId),index=board.decorations.findIndex(d=>d.id===op.decorationId);
      if(index<0)throw storeError(404,'Decoration not found.');requireObject(op.patch,'decoration patch');
      if(Object.keys(op.patch).some(key=>!['type','x','y','width','height','color','text','endArrow','startArrow','dashed','route','bend','thickness','textSize','textAlign','textFace','textFill','textBorder','textPadding','textSizing','sticker','rotation','flipX','flipY','shape','from','to','container','z'].includes(key)))throw storeError(400,'Unknown decoration patch field.');
      const entry={...board.decorations[index],...clone(op.patch)};decoration(entry);
      if(Object.hasOwn(op.patch,'from')||Object.hasOwn(op.patch,'to'))validateNewAttachments(board,entry);
      freezeBoardAttachments(board,{decorationIds:new Set([entry.id])});
      board.decorations[index]=entry;finishBoard(board);return {boardId:board.id,decorationId:entry.id};
    }
    case 'removeDecoration':{
      const board=getBoard(state,op.boardId),index=board.decorations.findIndex(d=>d.id===op.decorationId);
      if(index<0)throw storeError(404,'Decoration not found.');freezeBoardAttachments(board,{decorationIds:new Set([op.decorationId])});board.decorations.splice(index,1);finishBoard(board);return {boardId:board.id,decorationId:op.decorationId};
    }
    case "moveContainerMember": {
      const board = getBoard(state,op.boardId);
      if (state.items[board.ownerItemId].archivedAt) throw storeError(409,"Restore this board before editing its containers.");
      moveContainerMember(board,state.items,op);
      finishBoard(board);
      return {boardId:board.id,containerId:op.containerId,member:clone(op.member)};
    }
    case "updatePlacement": {
      const board = getBoard(state, op.boardId),
        [placement] = selectedPlacements(board, [op.placementId]);
      freezeBoardAttachments(board,{placementIds:new Set([placement.id])});
      requireObject(op.patch, "placement patch");
      if (
        Object.keys(op.patch).some(
          (key) => !["x", "y", "width", "height", "z", "presentation"].includes(key),
        )
      )
        throw storeError(400, "Only placement geometry and presentation may be patched.");
      Object.assign(placement, clone(op.patch));
      finishBoard(board);
      return { boardId: board.id, placementIds: [placement.id] };
    }
    case "arrangePlacements": {
      // Per-object positions (align, distribute, tidy) for placements and drawn
      // elements on one board, in one revision and one movement-history entry.
      const board = getBoard(state, op.boardId);
      const entries = (list, label) => {
        if (list === undefined) return [];
        if (!Array.isArray(list) || list.length > 10000 || new Set(list.map(e => e?.id)).size !== list.length)
          throw storeError(400, `Provide unique ${label} positions.`);
        for (const e of list) {
          requireObject(e, `${label} position`);
          if (Object.keys(e).some(key => !["id","x","y"].includes(key)) || ["x","y"].some(key => typeof e[key] !== "number" || !Number.isFinite(e[key]) || Math.abs(e[key]) > 10000000))
            throw storeError(400, `Each ${label} position needs an id and finite x/y.`);
        }
        return list;
      };
      const placementMoves = entries(op.placements, "placement"), decorationMoves = entries(op.decorations, "decoration");
      if (!placementMoves.length && !decorationMoves.length) throw storeError(400, "Arrange at least one placement or decoration.");
      const placements = placementMoves.length ? selectedPlacements(board, placementMoves.map(e => e.id)) : [];
      const decorations = selectedDecorations(board, decorationMoves.map(e => e.id));
      freezeBoardAttachments(board,{placementIds:new Set(placements.map(p => p.id)),decorationIds:new Set(decorations.map(d => d.id))});
      const nextPlacements = placements.map((p, index) => {
        getItem(state, p.itemId);
        const next = {...p, x:placementMoves[index].x, y:placementMoves[index].y};
        geometry(next);
        return next;
      });
      const nextDecorations = decorations.map((d, index) => {
        const dx = decorationMoves[index].x - d.x, dy = decorationMoves[index].y - d.y;
        const shift = end => end && !end.placementId && !end.decorationId ? {...end, x:end.x + dx, y:end.y + dy} : end;
        const next = {...d, x:d.x + dx, y:d.y + dy, ...(d.from ? {from:shift(d.from)} : {}), ...(d.to ? {to:shift(d.to)} : {})};
        decoration(next);
        return next;
      });
      placements.forEach((p, index) => { p.x = nextPlacements[index].x; p.y = nextPlacements[index].y; });
      nextDecorations.forEach(next => { board.decorations[board.decorations.findIndex(d => d.id === next.id)] = next; });
      finishBoard(board);
      return {boardId:board.id, placementIds:placements.map(p => p.id), decorationIds:decorations.map(d => d.id)};
    }
    case "restackOccurrences": {
      // Bring to front / Send to back for placements and drawn elements on one board.
      const board = getBoard(state, op.boardId);
      if (!["front","back"].includes(op.to)) throw storeError(400, "Restack needs to: front or back.");
      const decorations = selectedDecorations(board, op.decorationIds);
      const placements = op.placementIds === undefined || Array.isArray(op.placementIds) && !op.placementIds.length
        ? [] : selectedPlacements(board, op.placementIds);
      if (!placements.length && !decorations.length) throw storeError(400, "Select at least one Tinka or drawn element to restack.");
      applyStack(board, restack(board, [...placements.map(p => stackRef("placement",p.id)),...decorations.map(d => stackRef("decoration",d.id))], op.to));
      finishBoard(board);
      return {boardId:board.id, placementIds:placements.map(p => p.id), decorationIds:decorations.map(d => d.id)};
    }
    case "translatePlacements": {
      const board = getBoard(state, op.boardId);
      // Optional decorationIds move drawn elements (text, shapes, regions, arrows) in
      // the same transaction; placementIds may then be empty.
      const decorations = selectedDecorations(board, op.decorationIds);
      const placements = decorations.length && Array.isArray(op.placementIds) && !op.placementIds.length
        ? [] : selectedPlacements(board, op.placementIds);
      freezeBoardAttachments(board,{placementIds:new Set(placements.map(p=>p.id)),decorationIds:new Set(decorations.map(d=>d.id))});
      if (["dx", "dy"].some(key => typeof op[key] !== "number" || !Number.isFinite(op[key]) || Math.abs(op[key]) > 10000000))
        throw storeError(400, "Translation requires finite dx/dy coordinates.");
      const translated = placements.map(p => {
        getItem(state, p.itemId);
        const next = {...p, x:p.x + op.dx, y:p.y + op.dy};
        geometry(next);
        return next;
      });
      // Free arrow ends move with the arrow; attached ends keep following their targets.
      const shift = end => end && !end.placementId && !end.decorationId ? {...end, x:end.x + op.dx, y:end.y + op.dy} : end;
      const movedDecorations = decorations.map(d => {
        const next = {...d, x:d.x + op.dx, y:d.y + op.dy, ...(d.from ? {from:shift(d.from)} : {}), ...(d.to ? {to:shift(d.to)} : {})};
        decoration(next);
        return next;
      });
      placements.forEach((p, index) => { p.x = translated[index].x; p.y = translated[index].y; });
      movedDecorations.forEach(next => { board.decorations[board.decorations.findIndex(d => d.id === next.id)] = next; });
      finishBoard(board);
      return {boardId:board.id, placementIds:placements.map(p => p.id), ...(op.decorationIds !== undefined ? {decorationIds:decorations.map(d => d.id)} : {})};
    }
    case "duplicateOccurrences": {
      const board = getBoard(state, op.boardId);
      const selectedDrawn = selectedDecorations(board, op.decorationIds);
      const selectedChildren = selectedDrawn.flatMap(d => d.container?.children || []);
      const drawnIds = new Set([...selectedDrawn.map(d => d.id),...selectedChildren.filter(child => typeof child === "string")]);
      const drawn = board.decorations.filter(d => drawnIds.has(d.id));
      const selected = Array.isArray(op.placementIds) && !op.placementIds.length
        ? [] : selectedPlacements(board, op.placementIds);
      const placementIds = [...new Set([...selected.map(p => p.id),...selectedChildren
        .filter(child => typeof child !== "string").map(child => child.placementId)])];
      const placements = placementIds.length ? selectedPlacements(board,placementIds) : [];
      if (!placements.length && !drawn.length) throw storeError(400, "Select at least one Tinka or drawn element to copy.");
      const {dx,dy} = op;
      if ([dx,dy].some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 10000000))
        throw storeError(400, "Duplication requires finite dx/dy coordinates.");
      if (getItem(state,board.ownerItemId).archivedAt || placements.some(p => p.archivedAt || getItem(state,p.itemId).archivedAt))
        throw storeError(409, "Restore archived items or boards before copying them.");
      // Copies keep the selection's own stacking order and land on top.
      const z = stackTopKey(board);
      if (z + placements.length + drawn.length > STACK_RANGE) throw storeError(400, "Destination stacking order is out of range.");
      const copyRank = new Map(stackOrder({placements,decorations:drawn}).map((entry,index) => [entry.ref,z + index + 1]));
      const zById = new Map(placements.map(p => [p.id,copyRank.get(stackRef("placement",p.id))]));
      const sourcesById = new Map(placements.map(p => [p.id,p]));
      const review = new Set([...board.reviewOrder.filter(id => sourcesById.has(id)),...sourcesById.keys()]);
      const placementCopies = new Map();
      for (const id of review) {
        const p = sourcesById.get(id);
        const copy = {...clone(p),id:fresh("placement"),x:p.x + dx,y:p.y + dy,z:zById.get(id)};
        geometry(copy);
        placementCopies.set(id,copy);
      }
      const decorationCopies = new Map(drawn.map(d => [d.id,fresh("decoration")]));
      const placementCopyIds = new Map([...placementCopies].map(([id,copy]) => [id,copy.id]));
      const shift = p => ({x:p.x + dx,y:p.y + dy});
      const copyEnd = (end, point) => {
        const placementId = placementCopies.get(end.placementId)?.id, decorationId = decorationCopies.get(end.decorationId);
        if (!placementId && !decorationId) return shift(point);
        return {...end,...(placementId ? {placementId} : {decorationId}),fallback:shift(point)};
      };
      const copies = drawn.map(d => {
        const copy = {...clone(d),...shift(d),id:decorationCopies.get(d.id),z:copyRank.get(stackRef("decoration",d.id))};
        remapContainerChildren(copy,placementCopyIds,decorationCopies);
        if (d.type === "line" && d.from && d.to) {
          const line = resolveLine(d,{...board,items:state.items});
          copy.from = copyEnd(d.from,line.from);
          copy.to = copyEnd(d.to,line.to);
        }
        decoration(copy);
        return copy;
      });
      board.placements.push(...placementCopies.values());
      board.reviewOrder.push(...[...placementCopies.values()].map(p => p.id));
      board.decorations.push(...copies);
      for (const copy of copies) validateNewAttachments(board,copy);
      if (board.groups) copyOccurrenceGroups(board,board,placementCopyIds,decorationCopies);
      finishBoard(board);
      return {boardId:board.id,placementIds:placements.map(p => placementCopies.get(p.id).id),decorationIds:copies.map(d => d.id)};
    }
    case "move":
    case "reference": {
      const feature = op.type === "reference" && op.featureOnParent === true;
      if (Object.hasOwn(op,"featureOnParent") && (!feature || !op.sourceBoardId || !op.targetBoardId || !op.placementIds || op.itemIds || op.newBoard || op.targetPosition))
        throw storeError(400, "Featuring requires selected placements and an existing parent board.");
      if (op.targetBoardId && op.newBoard)
        throw storeError(400, "Choose an existing or a new destination.");
      const source = op.sourceBoardId
        ? getBoard(state, op.sourceBoardId)
        : null;
      checkMoveSource(state, op, source);
      if (op.placementIds && !source)
        throw storeError(400, "Source board is required for placements.");
      if (op.placementIds && op.itemIds)
        throw storeError(400, "Select placements or items.");
      const placements = op.placementIds
        ? selectedPlacements(source, op.placementIds)
        : null;
      if(op.type==='move'&&source)freezeBoardAttachments(source,{placementIds:new Set((placements||source.placements.filter(p=>op.itemIds?.includes(p.itemId))).map(p=>p.id))});
      const items = placements
        ? placements.map((placement) => getItem(state, placement.itemId))
        : ids(op.itemIds).map((id) => getItem(state, id));
      if (op.targetPosition !== undefined) {
        requireObject(op.targetPosition, "targetPosition");
        if (op.type !== "move" || !op.targetBoardId || op.newBoard || !placements?.length ||
            Object.keys(op.targetPosition).some(key => !["x", "y"].includes(key)) ||
            ["x", "y"].some(key => typeof op.targetPosition[key] !== "number" ||
              !Number.isFinite(op.targetPosition[key]) || Math.abs(op.targetPosition[key]) > 10000000))
          throw storeError(400, "targetPosition requires moved placements, an existing target board and finite x/y coordinates.");
      }
      let destination = op.targetBoardId
        ? getBoard(state, op.targetBoardId)
        : null;
      if (op.newBoard) {
        requireObject(op.newBoard, "newBoard");
        destination = makeBoard(state, {
          id: op.newBoard.id,
          title: op.newBoard.title,
          parentBoardId: op.newBoard.parentBoardId,
        }).board;
      }
      if (!destination && items.some((item) => !item.childBoardId))
        throw storeError(400, "Only boards can be placed on home.");
      if (op.type === "move" && source && destination?.id === source.id)
        throw storeError(400, "Move destination matches source.");
      if (feature) {
        const owner = state.items[source.ownerItemId];
        const destinationOwner = state.items[destination.ownerItemId];
        if (!owner || owner.deletedAt || owner.archivedAt || !destinationOwner || destinationOwner.deletedAt || destinationOwner.archivedAt || !destination.placements.some(p => active(p) && !p.archivedAt && p.itemId === owner.id))
          throw storeError(409, "This board is no longer on that parent. Choose a current parent.");
        if (placements.some(p => p.archivedAt || state.items[p.itemId]?.archivedAt || state.items[p.itemId]?.deletedAt))
          throw storeError(409, "Restore archived items before featuring them.");
        if (new Set(placements.map(p => p.itemId)).size !== placements.length)
          throw storeError(400, "Select each item only once when featuring it.");
        if (placements.some(p => destination.placements.some(existing => active(existing) && !existing.archivedAt && existing.itemId === p.itemId && existing.presentation?.featuredFrom === source.id)))
          throw storeError(409, "One or more selected items are already featured from this board on that parent.");
      }
      let targetPosition = op.targetPosition;
      if (feature) {
        const anchor = destination.placements.find(p => active(p) && !p.archivedAt && p.itemId === source.ownerItemId);
        const minX = Math.min(...placements.map(p => p.x)), minY = Math.min(...placements.map(p => p.y));
        const width = Math.max(...placements.map(p => p.x + p.width)) - minX;
        const height = Math.max(...placements.map(p => p.y + p.height)) - minY;
        const occupied = destination.placements.filter(p => active(p) && !p.archivedAt);
        const clear = point => !occupied.some(p => point.x < p.x+p.width+16 && point.x+width+16 > p.x && point.y < p.y+p.height+16 && point.y+height+16 > p.y);
        const candidates = [{x:anchor.x+anchor.width+40,y:anchor.y},{x:anchor.x,y:anchor.y+anchor.height+40},{x:anchor.x-width-40,y:anchor.y},{x:anchor.x,y:anchor.y-height-40}];
        targetPosition = candidates.find(clear) || {x:Math.max(0,...occupied.map(p => p.x+p.width))+40,y:anchor.y};
      }
      const origin = targetPosition ? {
        x:Math.min(...placements.map(p => p.x)), y:Math.min(...placements.map(p => p.y)),
      } : null;
      const destinationZ = targetPosition ? stackTopKey(destination) : 0;
      if (targetPosition && placements.length > 1 && destinationZ + placements.length > 10000000)
        throw storeError(400, "Destination stacking order is out of range.");
      const positionedZ = targetPosition ? new Map([...placements].sort((a,b) => a.z - b.z)
        .map((p,index) => [p.id, Math.min(10000000,destinationZ + index + 1)])) : null;
      const created = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (destination) {
          const original = placements?.[index];
          created.push(
            place(
              destination,
              item.id,
              original
                ? {
                    ...(op.newBoard ? { x: original.x, y: original.y } : {}),
                    ...(targetPosition ? {
                      x:targetPosition.x + original.x - origin.x,
                      y:targetPosition.y + original.y - origin.y,
                      z:positionedZ.get(original.id),
                    } : {}),
                    width: original.width,
                    height: original.height,
                    ...(feature ? {presentation:{mode:"card",...(original.presentation || {}),featuredFrom:source.id}} : original.presentation ? { presentation: original.presentation } : {}),
                  }
                : {},
            ).id,
          );
        } else if (!state.metadata.homeBoardIds.includes(item.childBoardId))
          state.metadata.homeBoardIds.push(item.childBoardId);
        if (op.type === "move") {
          if (placements) {
            placements[index].removedAt = now();
            placements[index].removalReason = "move";
          } else if (source)
            for (const placement of source.placements)
              if (active(placement) && placement.itemId === item.id) {
                placement.removedAt = now();
                placement.removalReason = "move";
              }
          if (destination && item.childBoardId)
            state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(
              (id) => id !== item.childBoardId,
            );
        }
      }
      if (op.type === "move" && source?.groups && destination && placements) {
        const placementMap = new Map(placements.map((placement,index) => [placement.id,created[index]]));
        copyOccurrenceGroups(source,destination,placementMap,new Map());
      }
      if (source) finishBoard(source);
      if (destination) finishBoard(destination);
      return {
        itemIds: items.map((item) => item.id),
        boardId: destination?.id || null,
        placementIds: created,
      };
    }
    case "duplicate": {
      const original = getItem(state, op.itemId),
        copied = clone(original);
      delete copied.id;
      delete copied.childBoardId;
      delete copied.archivedAt;
      delete copied.deletedAt;
      delete copied.legacy;
      delete copied.createdAt;
      const item = makeItem(state, {
        ...copied,
        title: op.title || `${original.title} copy`,
      });
      if (original.childBoardId) {
        const source = getBoard(state, original.childBoardId),
          made = makeBoard(state, { itemId: item.id, title: item.title });
        made.board.description = source.description;
        made.board.rounds = clone(source.rounds);
        made.board.decorations = clone(source.decorations);
        if (source.background) made.board.background = clone(source.background);
        const placementMap = new Map();
        for (const placement of source.placements.filter(active)) {
          const copy = clone(placement);
          delete copy.id;
          delete copy.itemId;
          const placed = place(made.board, placement.itemId, copy);
          placementMap.set(placement.id, placed.id);
        }
        made.board.reviewOrder = source.reviewOrder
          .map((id) => placementMap.get(id))
          .filter(Boolean);
        remapAttachments(made.board.decorations,placementMap);
        remapCopiedContainers(made.board,state.items,placementMap);
        copyOccurrenceGroups(source,made.board,placementMap);
      }
      const destination = op.targetBoardId
        ? getBoard(state, op.targetBoardId)
        : null;
      const placement = destination ? place(destination, item.id) : null;
      if (destination) {
        finishBoard(destination);
        if (item.childBoardId)
          state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(
            (id) => id !== item.childBoardId,
          );
      }
      return {
        itemId: item.id,
        ...(item.childBoardId ? { childBoardId: item.childBoardId } : {}),
        ...(destination
          ? { boardId: destination.id, placementIds: [placement.id] }
          : {}),
      };
    }
    case "archive":
    case "remove": {
      const board = getBoard(state, op.boardId),
        // Remove may also delete drawn elements (a mixed selection) in the same commit.
        drawn = op.type === "remove" ? selectedDecorations(board, op.decorationIds) : [],
        placements = drawn.length && Array.isArray(op.placementIds) && !op.placementIds.length ? [] : selectedPlacements(board, op.placementIds);
      freezeBoardAttachments(board,{placementIds:new Set(placements.map(p=>p.id)),decorationIds:new Set(drawn.map(d=>d.id))});
      if (drawn.length) { const gone = new Set(drawn.map(d => d.id)); board.decorations = board.decorations.filter(d => !gone.has(d.id)); }
      for (const placement of placements) {
        if (op.type === "remove") {
          placement.removedAt = now();
          placement.removalReason = "remove";
        } else if (boolean(op.archived)) placement.archivedAt = now();
        else delete placement.archivedAt;
      }
      finishBoard(board);
      return { boardId: board.id, placementIds: placements.map((p) => p.id), ...(op.decorationIds !== undefined && op.type === "remove" ? {decorationIds:drawn.map(d => d.id)} : {}) };
    }
    case "archiveItem":
    case "deleteItem": {
      const items = ids(op.itemIds).map((id) => getItem(state, id));
      freezeItemAttachments(state,items.map(item=>item.id));
      const changedBoards = new Set();
      for (const item of items) {
        if (op.type === "deleteItem") {
          item.deletedAt = now();
          for (const board of Object.values(state.boards))
            for (const placement of board.placements)
              if (placement.itemId === item.id) {
                placement.deletedAt = now();
                changedBoards.add(board.id);
              }
          if (item.childBoardId)
            state.metadata.homeBoardIds = state.metadata.homeBoardIds.filter(
              (id) => id !== item.childBoardId,
            );
        } else if (boolean(op.archived)) item.archivedAt = now();
        else delete item.archivedAt;
        item.updatedAt = now();
      }
      for (const id of changedBoards) finishBoard(state.boards[id]);
      return { itemIds: items.map((item) => item.id) };
    }
    case "updateWorkspace": {
      requireObject(op.patch, "workspace patch");
      if (
        Object.keys(op.patch).some(
          (key) => !["resourceRoots", "homeBoardIds", "homeLayout"].includes(key),
        )
      )
        throw storeError(400, "Unknown workspace property.");
      if (op.patch.resourceRoots)
        state.metadata.resourceRoots = {
          ...state.metadata.resourceRoots,
          ...clone(op.patch.resourceRoots),
        };
      if (op.patch.homeBoardIds)
        state.metadata.homeBoardIds = clone(op.patch.homeBoardIds);
      if (Object.hasOwn(op.patch,"homeLayout")) {
        requireObject(op.patch.homeLayout,"Home layout");
        for (const [id,box] of Object.entries(op.patch.homeLayout)) {
          assertId(id);requireObject(box,"Home card geometry");
          if (Object.keys(box).length!==4 || !["x","y","width","height"].every(key=>Number.isFinite(box[key])) ||
              box.x<0 || box.y<0 || box.x>10000000 || box.y>10000000 || box.width<160 || box.width>10000 || box.height<120 || box.height>10000)
            throw storeError(400,"Invalid Home card geometry.");
        }
        state.metadata.homeLayout=clone(op.patch.homeLayout);
      }
      return { workspaceId: state.metadata.id };
    }
    default:
      throw storeError(400, "Unknown workspace operation.");
  }
}
export async function applyOperation(config, operation) {
  const guard=guardedRequest(operation);
  if(guard){
    if(isFeedbackOperation(guard.operation))return applyFeedbackOperation(config,guard.operation,guard);
    return applyTransaction(config,guard.operation,undefined,guard);
  }
  if(isFeedbackOperation(operation))return applyFeedbackOperation(config,operation);
  if(isHighlightOperation(operation))return applyHighlightOperation(config,operation);
  return applyTransaction(config,operation);
}
export async function applyFileImport(config,metadata,files,{signal}={}) {
  const prepared=prepareImport(metadata,files);
  if(metadata.type==='guardedImport'){
    const {operationId,baseline,type,...fields}=prepared.operation;
    const guard=guardedRequest({type:'guarded',operationId,operation:{type:'importFiles',...fields},baseline});
    return applyTransaction(config,guard.operation,{files:prepared.files,signal},guard);
  }
  return applyTransaction(config,prepared.operation,{files:prepared.files,signal});
}
async function applyTransaction(config, operation, imported, guard) {
  const request=guard?.request||operation;
  requireObject(operation, "operation");
  if(operation.type === "importFiles" && !imported) throw storeError(400,"Use the file import endpoint for file bytes.");
  if ((guard ? Buffer.byteLength(JSON.stringify(request)) : JSON.stringify(operation).length) > 4000000)
    throw storeError(400, "Operation is too large.");
  if (operation.operationId !== undefined) assertId(operation.operationId);
  if (
    operation.expectedRevision !== undefined &&
    (!Number.isSafeInteger(operation.expectedRevision) ||
      operation.expectedRevision < 0)
  )
    throw storeError(400, "Invalid expectedRevision.");
  const { expectedRevision, operationId, ...payload } = request;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return withStore(
    config,
    async (root, before) => {
      const state = clone(before || emptyWorkspace());
      const prior =
        operationId &&
        state.metadata.recentOperations.find(
          (entry) => entry.operationId === operationId,
        );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw storeError(
            409,
            "Operation ID was already used with different input.",
          );
        return { ...clone(prior.response), replayed: true };
      }
      if (
        expectedRevision !== undefined &&
        expectedRevision !== state.metadata.revision
      ) {
        // Machine-identifiable: no target was validated or touched.
        const error = storeError(
          409,
          "Workspace revision changed. Reload before retrying.",
        );
        error.code = "WORKSPACE_REVISION_CHANGED";
        error.revision = state.metadata.revision;
        throw error;
      }
      // Preserve import namespace denial before evaluating target-specific facts.
      if(imported && (!before || operation.workspaceId !== state.metadata.id))
        throw storeError(403,"File import belongs to another workspace.");
      if(guard?.structural)checkStructuralFacts(guard,state);
      else await checkGuardedFacts(guard,async(collection,id)=>state[collection][id]||null,state.metadata.revision);
      if (operation.restack !== undefined && (operation.restack !== "drop" ||
          !["translatePlacements","updatePlacement","updateDecoration"].includes(operation.type) ||
          operation.type === "updatePlacement" && !(object(operation.patch) && ["x","y"].some(key => Object.hasOwn(operation.patch,key)))))
        throw storeError(400, "restack \"drop\" applies to a moved placement, drawn element or selection.");
      const boardIds = movementBoards(operation);
      const movementBefore = boardIds.length ? {boards:Object.fromEntries(boardIds.map(id => [id,clone(getBoard(state,id))])),
        metadata:{homeBoardIds:clone(state.metadata.homeBoardIds)}} : null;
      const restored = operation.type === "restoreMovement" ? restoreMovement(state,operation.history) : null;
      let payloads;
      let result;
      if(imported){
        payloads=await importResources(config,state,{...operation,operationId},imported.files,imported.signal);
        const items={},placements=[];
        operation.files.forEach((file,index)=>{
          const id=`import-${index}`,resource=payloads.resources[index];
          items[id]={schemaVersion:2,id,title:file.title,description:"",content:{kind:file.kind,resource},
            revisions:[],review:{note:"",star:false,updatedAt:0},build:{state:"ready",message:"",updatedAt:0},
            ...(file.kind==='image'?{preview:{resource}}:{})};
          placements.push({id:`import-placement-${index}`,itemId:id,...operation.placements[index],z:index,presentation:{mode:"panel"}});
        });
        // paste anchors at the minimum corner; preserve the supplied offsets.
        const x=Math.min(...placements.map(p=>p.x)),y=Math.min(...placements.map(p=>p.y));
        result=pastePlacements(state,{targetBoardId:operation.targetBoardId,
          targetPosition:{x:operation.targetPosition.x+x,y:operation.targetPosition.y+y},
          clipboard:{version:1,workspaceId:state.metadata.id,items,boards:{},placements}});
        result.resources=payloads.resources;
      }else result = restored ? restored.result : execute(state, operation);
      if (!restored)
        for (const id of containerLayoutBoards(operation,state,before,boardIds))
          reflowBoardContainers(state.boards[id],state.items,before?.boards[id],before?.items);
      if (!restored)
        for (const board of Object.values(state.boards)) pruneOccurrenceGroups(board);
      // A pointer drop that newly overlaps something above it brings the moved
      // objects forward (public/stacking.js), in this same revision and receipt.
      if (operation.restack === "drop") {
        const board = state.boards[operation.boardId], previous = movementBefore.boards[operation.boardId];
        const refs = operation.type === "updatePlacement" ? [stackRef("placement",operation.placementId)]
          : operation.type === "updateDecoration" ? [stackRef("decoration",operation.decorationId)]
          : [...result.placementIds.map(id => stackRef("placement",id)),...(result.decorationIds || []).map(id => stackRef("decoration",id))];
        applyStack(board, dropRestack({...previous,items:before?.items || {}}, {...board,items:state.items}, refs));
      }
      const history = restored?.history || (movementBefore ? movementHistory(state,movementBefore,boardIds) : undefined);
      state.metadata.revision++;
      state.metadata.updatedAt = now();
      const response = { revision: state.metadata.revision, result, ...(history ? {history} : {}) };
      if (operationId) {
        state.metadata.recentOperations = [
          ...state.metadata.recentOperations,
          { operationId, fingerprint, response },
        ].slice(-64);
        const cacheTooLarge = () => Buffer.byteLength(JSON.stringify(state.metadata)) > 2000000;
        while (state.metadata.recentOperations.length > 1 && cacheTooLarge())
          state.metadata.recentOperations.shift();
        // Keep retry identity even if one unusually large receipt cannot fit the
        // metadata cache. The original response still carries its full history.
        if (history && cacheTooLarge())
          state.metadata.recentOperations.at(-1).response = {revision:response.revision,result:clone(result)};
      }
      validateState(state);
      await validateRootLocations(config, state.metadata.resourceRoots);
      // Validate every metadata change before preserving payloads. Once written,
      // originals are retained even if commit or the response is interrupted.
      await payloads?.persist();
      await commitStore(root, before, state);
      return response;
    },
    { create: true },
  );
}

// Migration alone uses this internal validator before its one metadata commit.
export { validateState as validateWorkspaceState };
