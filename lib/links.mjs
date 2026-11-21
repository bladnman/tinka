import {workspaceView} from './workspace.mjs';
import {verifiedURL,linkRecovery} from './config.mjs';

// Direct Tinka links for agents to hand the user. An item link opens that Tinka
// itself on its board (`/boards/BOARD/#items/PLACEMENT`); leaving it lands on its
// tile. A board link opens the board. They open only on this computer.
export const baseURL=config=>`http://127.0.0.1:${config.port}/`;
// `base` is a running instance's URL or a config (its saved port).
const origin=base=>typeof base==='string'?base:baseURL(base);
export const boardLink=(base,boardId)=>`${origin(base)}boards/${encodeURIComponent(boardId)}/`;
export const itemLink=(base,boardId,placementId)=>`${boardLink(base,boardId)}#items/${encodeURIComponent(placementId)}`;

// Active placements of an item on active boards, `preferBoard` first.
export async function itemPlaces(config,itemId,{preferBoard,limit=8}={}){
  const view=await workspaceView(config,'graph',{covers:false});
  if(!view.enabled)return [];
  const gone=new Set(view.items.filter(item=>item.archivedAt||item.deletedAt).map(item=>item.id));
  if(gone.has(itemId))return [];
  const places=[];
  for(const board of view.boards){
    if(gone.has(board.ownerItemId))continue;
    for(const placement of board.placements)if(placement.itemId===itemId&&!placement.archivedAt&&!placement.removedAt)places.push({boardId:board.id,boardTitle:board.title,placementId:placement.id});
  }
  places.sort((a,b)=>(b.boardId===preferBoard)-(a.boardId===preferBoard));
  return places.slice(0,limit);
}
export async function findPlacement(config,placementId){
  const view=await workspaceView(config,'graph',{covers:false});
  if(!view.enabled)return null;
  for(const board of view.boards){const placement=board.placements.find(p=>p.id===placementId&&!p.removedAt);if(placement)return {boardId:board.id,boardTitle:board.title,placementId,itemId:placement.itemId};}
  return null;
}

const BOARD_ONLY=new Set(['createBoard','updateBoard','createDecoration','updateDecoration','removeDecoration','remove','archive','restoreMovement','updateWorkspace','groupOccurrences','ungroupOccurrences','restackOccurrences']);
const NO_LINK=new Set(['deleteItem','archiveItem']);
const MAX_LINKS=20;
// {link, links?} for a changing operation's response: one item link when one
// Tinka was added or changed, otherwise the board link plus each item's link.
// Never throws; a committed change is not reported as failed for want of a link.
export async function linksFor(config,type,input={},response={}){
  try{
    const result=response?.result||{};
    if(NO_LINK.has(type))return {};
    const boardId=result.boardId||input.boardId||input.targetBoardId;
    if(type==='createBoard'&&result.boardId)return {link:boardLink(config,result.boardId)};
    if(BOARD_ONLY.has(type))return boardId?{link:boardLink(config,boardId)}:{};
    if(result.boardId&&Array.isArray(result.placementIds)&&result.placementIds.length){
      const links=result.placementIds.slice(0,MAX_LINKS).map(id=>itemLink(config,result.boardId,id));
      return links.length===1?{link:links[0]}:{link:boardLink(config,result.boardId),links};
    }
    const itemId=result.itemId||input.itemId;
    if(typeof itemId==='string'){
      const places=await itemPlaces(config,itemId,{preferBoard:boardId});
      if(places.length){
        const links=places.map(place=>itemLink(config,place.boardId,place.placementId));
        return links.length===1?{link:links[0]}:{link:links[0],links};
      }
    }
    return boardId&&typeof boardId==='string'?{link:boardLink(config,boardId)}:{};
  }catch{return {};}
}
// Adds the links beside revision and result, leaving both unchanged.
export async function withLinks(config,type,input,response){
  if(!response||typeof response!=='object'||Array.isArray(response))return response;
  try{
    const links=await linksFor(config,type,input,response);
    if(!links.link)return response;
    if(await verifiedURL(config))return {...response,...links};
    // Disk operations remain useful while stopped. Never send someone to the
    // unrelated project that may now occupy this saved address.
    const relative=url=>{const parsed=new URL(url);return `${parsed.pathname}${parsed.search}${parsed.hash}`;};
    return {...response,linkPath:relative(links.link),...(links.links?{linkPaths:links.links.map(relative)}:{}),...linkRecovery(config)};
  }catch{return response;}
}
