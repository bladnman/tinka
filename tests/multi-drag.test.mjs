import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {applyOperation, readWorkspace, getBoardSnapshot} from "../lib/workspace.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),"tinka-multi-drag-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const config = {boardsRoot:path.join(directory,"boards")};
  await mkdir(config.boardsRoot);
  const op = async (type,data = {}) => (await applyOperation(config,{type,...data})).result;
  const source = await op("createBoard",{title:"Source"});
  const target = await op("createBoard",{title:"Target"});
  const a = await op("createItem",{boardId:source.boardId,item:{title:"A",content:{kind:"note",text:"Keep"}},
    placement:{x:-20,y:80,z:9,width:440,height:310,presentation:{mode:"panel",paper:"#e4ebdc"}}});
  const b = await op("createItem",{boardId:source.boardId,item:{title:"B"},placement:{x:180,y:-40,z:2}});
  await op("review",{itemId:a.itemId,patch:{note:"Retained",star:true}});
  return {config,op,source,target,a,b,ids:[a.placementIds[0],b.placementIds[0]]};
}

test("selection translation and positioned move each commit once, preserving canonical state, offsets and stacking",async t => {
  const {config,op,source,target,a,b,ids} = await fixture(t);
  await op("reference",{sourceBoardId:source.boardId,placementIds:[ids[0]],targetBoardId:source.boardId});
  const before = await readWorkspace(config);
  const translated = await applyOperation(config,{type:"translatePlacements",boardId:source.boardId,placementIds:ids,
    dx:37,dy:-61,expectedRevision:before.revision,operationId:"selection-translation"});
  assert.equal(translated.revision,before.revision + 1);
  const after = await readWorkspace(config);
  assert.deepEqual(after.items,before.items);
  const sourceBoard = await getBoardSnapshot(config,source.boardId);
  assert.deepEqual(sourceBoard.placements.slice(0,2).map(p => [p.x,p.y,p.z]),[[17,19,9],[217,-101,2]]);
  assert.deepEqual(sourceBoard.placements[2],before.boards.find(b => b.id === source.boardId).placements[2]);
  const replay = await applyOperation(config,{type:"translatePlacements",boardId:source.boardId,placementIds:ids,
    dx:37,dy:-61,expectedRevision:before.revision,operationId:"selection-translation"});
  assert.equal(replay.revision,translated.revision);
  const moved = await applyOperation(config,{type:"move",sourceBoardId:source.boardId,placementIds:ids,
    targetBoardId:target.boardId,targetPosition:{x:500,y:600},expectedRevision:after.revision});
  assert.equal(moved.revision,after.revision + 1);
  const destination = await getBoardSnapshot(config,target.boardId);
  const result = moved.result.placementIds.map(id => destination.placements.find(p => p.id === id));
  assert.deepEqual(result.map(p => p.itemId),[a.itemId,b.itemId]);
  assert.deepEqual(result.map(p => [p.x,p.y]),[[500,720],[700,600]]);
  assert.ok(result[0].z > result[1].z,"source stacking survives reverse selection order");
  assert.equal(result[0].width,440);
  assert.deepEqual(result[0].presentation,{mode:"panel",paper:"#e4ebdc"});
  assert.deepEqual((await readWorkspace(config)).items,before.items);
  assert.equal((await getBoardSnapshot(config,source.boardId)).placements.filter(p => !p.removedAt).length,1);
});

test("invalid translation, stale revision, overflow, missing placement and batch cycle never partially commit",async t => {
  const {config,op,source,target,ids} = await fixture(t);
  const stable = await readWorkspace(config);
  const base = {type:"translatePlacements",boardId:source.boardId,placementIds:ids,dx:1,dy:2};
  for (const [change,status] of [
    [{dx:Infinity},400], [{dy:NaN},400], [{dx:10000000},400],
    [{placementIds:[ids[0],"missing-placement"]},404], [{placementIds:[ids[0],ids[0]]},400],
    [{expectedRevision:stable.revision - 1},409],
  ]) {
    await assert.rejects(() => applyOperation(config,{...base,...change}),{status});
    assert.deepEqual(await readWorkspace(config),stable);
  }
  await assert.rejects(() => applyOperation(config,{type:"move",sourceBoardId:source.boardId,placementIds:ids,
    targetBoardId:target.boardId,targetPosition:{x:9999900,y:0}}),{status:400});
  assert.deepEqual(await readWorkspace(config),stable);
  const child = await op("createBoard",{parentBoardId:source.boardId,title:"Ancestor"});
  const descendant = await op("createBoard",{parentBoardId:child.boardId,title:"Descendant"});
  const beforeCycle = await readWorkspace(config);
  await assert.rejects(() => applyOperation(config,{type:"move",sourceBoardId:source.boardId,
    placementIds:[ids[0],child.placementIds[0]],targetBoardId:descendant.boardId,targetPosition:{x:0,y:0}}),{status:409});
  assert.deepEqual(await readWorkspace(config),beforeCycle);
});

test("two placements of one canonical item remain two independent moved placements",async t => {
  const {config,op,source,target,a,ids} = await fixture(t);
  const reference = await op("reference",{sourceBoardId:source.boardId,placementIds:[ids[0]],targetBoardId:source.boardId});
  const selected = [ids[0],reference.placementIds[0]];
  const before = await readWorkspace(config);
  const moved = await applyOperation(config,{type:"move",sourceBoardId:source.boardId,placementIds:selected,
    targetBoardId:target.boardId,targetPosition:{x:10,y:20}});
  assert.equal(moved.revision,before.revision + 1);
  const destination = await getBoardSnapshot(config,target.boardId);
  assert.equal(destination.placements.length,2);
  assert.ok(destination.placements.every(p => p.itemId === a.itemId));
  assert.notEqual(destination.placements[0].id,destination.placements[1].id);
  assert.deepEqual((await readWorkspace(config)).items,before.items);
});

test("translatePlacements with decorationIds moves items and drawn elements together, and one restore undoes it",async t => {
  const {config,op,source,ids} = await fixture(t);
  const boardId = source.boardId;
  await op("createDecoration",{boardId,decoration:{id:"note-1",type:"region",shape:"rectangle",x:600,y:0,width:220,height:200,color:"#f6e6a4",text:"Sticky"}});
  await op("createDecoration",{boardId,decoration:{id:"label-1",type:"text",x:600,y:300,width:280,height:70,color:"#7a8a68",text:"Label"}});
  // A free arrow, and one attached at the start to a moving placement and free at the end.
  await op("createDecoration",{boardId,decoration:{id:"arrow-free",type:"line",x:900,y:0,width:100,height:50,color:"#6c8060",text:"",from:{x:900,y:0},to:{x:1000,y:50}}});
  await op("createDecoration",{boardId,decoration:{id:"arrow-tied",type:"line",x:0,y:0,width:100,height:50,color:"#6c8060",text:"",from:{placementId:ids[1],side:"right"},to:{x:1200,y:400}}});
  const before = await getBoardSnapshot(config,boardId);
  const moved = await applyOperation(config,{type:"translatePlacements",boardId,placementIds:ids,
    decorationIds:["note-1","label-1","arrow-free","arrow-tied"],dx:10,dy:20});
  assert.deepEqual(moved.result.decorationIds,["note-1","label-1","arrow-free","arrow-tied"]);
  assert.ok(moved.history,"the move is one movement-history entry");
  const after = await getBoardSnapshot(config,boardId);
  const deco = id => after.decorations.find(d => d.id === id);
  assert.deepEqual([deco("note-1").x,deco("note-1").y],[610,20]);
  assert.deepEqual([deco("label-1").x,deco("label-1").y],[610,320]);
  assert.deepEqual([deco("arrow-free").from,deco("arrow-free").to],[{x:910,y:20},{x:1010,y:70}]);
  assert.equal(deco("arrow-tied").from.placementId,ids[1],"attached end stays attached");
  assert.deepEqual(deco("arrow-tied").to,{x:1210,y:420});
  assert.deepEqual(after.placements.slice(0,2).map(p => [p.x,p.y]),before.placements.slice(0,2).map(p => [p.x + 10,p.y + 20]));
  await applyOperation(config,{type:"restoreMovement",history:moved.history});
  const restored = await getBoardSnapshot(config,boardId);
  assert.deepEqual(restored.placements.map(p => [p.x,p.y]),before.placements.map(p => [p.x,p.y]));
  for (const id of ["note-1","label-1","arrow-free"]) assert.deepEqual(restored.decorations.find(d => d.id === id),before.decorations.find(d => d.id === id));
  assert.deepEqual(restored.decorations.find(d => d.id === "arrow-tied").to,{x:1200,y:400});
  // Decorations alone, an empty placement list, and the old placement-only form.
  const only = await applyOperation(config,{type:"translatePlacements",boardId,placementIds:[],decorationIds:["note-1"],dx:-5,dy:0});
  assert.deepEqual(only.result.placementIds,[]);
  assert.equal((await getBoardSnapshot(config,boardId)).decorations.find(d => d.id === "note-1").x,595);
  const plain = await applyOperation(config,{type:"translatePlacements",boardId,placementIds:ids,dx:1,dy:1});
  assert.equal(Object.hasOwn(plain.result,"decorationIds"),false);
  for (const [change,status] of [[{decorationIds:["missing-deco"]},404],[{decorationIds:["note-1","note-1"]},400],[{decorationIds:"note-1"},400],[{placementIds:[],decorationIds:[]},400]])
    await assert.rejects(applyOperation(config,{type:"translatePlacements",boardId,placementIds:ids,dx:1,dy:1,...change}),e => e.status === status);
});

test("arrangePlacements sets per-object positions for placements and drawn elements, and one restore undoes it",async t => {
  const {config,op,source,ids} = await fixture(t);
  const boardId = source.boardId;
  await op("createDecoration",{boardId,decoration:{id:"note-1",type:"region",shape:"rectangle",x:600,y:0,width:220,height:200,color:"#f6e6a4",text:"Sticky"}});
  await op("createDecoration",{boardId,decoration:{id:"arrow-free",type:"line",x:900,y:0,width:100,height:50,color:"#6c8060",text:"",from:{x:900,y:0},to:{x:1000,y:50}}});
  const before = await getBoardSnapshot(config,boardId);
  const arranged = await applyOperation(config,{type:"arrangePlacements",boardId,
    placements:[{id:ids[0],x:10,y:10},{id:ids[1],x:500,y:10}],decorations:[{id:"note-1",x:10,y:400},{id:"arrow-free",x:500,y:400}]});
  assert.ok(arranged.history,"one movement-history entry");
  assert.deepEqual(arranged.result.decorationIds,["note-1","arrow-free"]);
  const after = await getBoardSnapshot(config,boardId);
  assert.deepEqual(after.placements.slice(0,2).map(p => [p.x,p.y]),[[10,10],[500,10]]);
  assert.deepEqual(after.placements.slice(0,2).map(p => [p.width,p.height]),before.placements.slice(0,2).map(p => [p.width,p.height]),"sizes unchanged");
  const deco = id => after.decorations.find(d => d.id === id);
  assert.deepEqual([deco("note-1").x,deco("note-1").y],[10,400]);
  assert.deepEqual([deco("arrow-free").from,deco("arrow-free").to],[{x:500,y:400},{x:600,y:450}],"free arrow ends move by the same delta");
  await applyOperation(config,{type:"restoreMovement",history:arranged.history});
  const restored = await getBoardSnapshot(config,boardId);
  assert.deepEqual(restored.placements.map(p => [p.x,p.y]),before.placements.map(p => [p.x,p.y]));
  assert.deepEqual(restored.decorations,before.decorations);
  const placementsOnly = await applyOperation(config,{type:"arrangePlacements",boardId,placements:[{id:ids[0],x:1,y:2}]});
  assert.deepEqual(placementsOnly.result.decorationIds,[]);
  for (const [change,status] of [[{},400],[{placements:[]},400],[{placements:[{id:ids[0],x:1}]},400],[{placements:[{id:ids[0],x:1,y:1},{id:ids[0],x:2,y:2}]},400],
    [{placements:[{id:"missing-placement",x:1,y:1}]},404],[{decorations:[{id:"missing-deco",x:1,y:1}]},404],[{placements:[{id:ids[0],x:1,y:1,width:5}]},400],[{placements:[{id:ids[0],x:Infinity,y:1}]},400]])
    await assert.rejects(applyOperation(config,{type:"arrangePlacements",boardId,...change}),e => e.status === status,JSON.stringify(change));
});

// One shared stacking order for cards and drawn elements (public/stacking.js).
import {stackOrder} from "../public/stacking.js";
const stacked = board => stackOrder(board).map(entry => entry.id);

test("the default stacking order reproduces the fixed per-kind levels boards had before",() => {
  const board = {
    decorations:[
      {id:"line",type:"line",x:0,y:0,width:10,height:10,color:"#000",text:""},
      {id:"region",type:"region",x:0,y:0,width:10,height:10,color:"#000",text:""},
      {id:"sticker",type:"text",sticker:true,x:0,y:0,width:10,height:10,color:"#000",text:"🚀"},
      {id:"text",type:"text",x:0,y:0,width:10,height:10,color:"#000",text:"T"},
      {id:"shape",type:"region",shape:"rectangle",x:0,y:0,width:10,height:10,color:"#000",text:""},
      {id:"box",type:"region",x:0,y:0,width:10,height:10,color:"#000",text:"",container:{layout:"vertical",children:["text"]}},
    ],
    placements:[{id:"p5",z:5},{id:"p0",z:0},{id:"p1",z:1},{id:"p2",z:2},{id:"gone",z:9,removedAt:"2026-01-01"}],
  };
  // Regions/containers 0, text and shapes 1, stickers and arrows 2; at equal levels
  // drawn elements paint first, as they came first in the board's markup.
  assert.deepEqual(stacked(board),["region","box","p0","text","shape","p1","line","sticker","p2","p5"]);
  // A container is never drawn above its own members.
  board.decorations[5] = {...board.decorations[5],z:40};
  assert.deepEqual(stacked(board),["region","p0","box","text","shape","p1","line","sticker","p2","p5"]);
});

async function stackFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),"tinka-stacking-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const config = {boardsRoot:path.join(directory,"boards")};
  await mkdir(config.boardsRoot);
  const write = (type,data = {}) => applyOperation(config,{type,boardId:"b",...data});
  await applyOperation(config,{type:"createBoard",id:"b",title:"Stacking"});
  const card = async (title,x,y,width = 300,height = 200) =>
    (await write("createItem",{item:{title},placement:{x,y,width,height}})).result.placementIds[0];
  const board = () => getBoardSnapshot(config,"b");
  return {config,write,card,board};
}

test("new objects land on top, beneath anything already resting on them",async t => {
  const {write,card,board} = await stackFixture(t);
  const older = await card("Older",0,0), newer = await card("Newer",400,0);
  assert.deepEqual(stacked(await board()),[older,newer]);
  // A sticky dropped on a card lands above it.
  await write("createDecoration",{decoration:{id:"note",type:"region",shape:"rectangle",x:20,y:20,width:120,height:100,color:"palette:gold",text:"Hi"}});
  assert.deepEqual(stacked(await board()),[older,newer,"note"]);
  // A coloured backdrop drawn around the newer card goes under it, above the rest.
  await write("createDecoration",{decoration:{id:"backdrop",type:"region",x:360,y:-40,width:900,height:600,color:"palette:sage",text:"Area"}});
  assert.deepEqual(stacked(await board()),[older,"note","backdrop",newer]);
  // Copies keep their own order and land on top of everything.
  const copy = (await write("duplicateOccurrences",{placementIds:[older],decorationIds:["note"],dx:32,dy:32})).result;
  assert.deepEqual(stacked(await board()).slice(-2),[copy.placementIds[0],copy.decorationIds[0]]);
});

test("a drag drop comes forward only when it newly overlaps something above it",async t => {
  const {config,write,card,board} = await stackFixture(t);
  const a = await card("A",0,0), b = await card("B",1000,0), c = await card("C",0,400);
  // A small slip of the top card changes nothing (nothing is above it anyway); a slide
  // of A that keeps it clear of B and C leaves the order alone.
  await write("updatePlacement",{placementId:a,patch:{x:6,y:4},restack:"drop"});
  assert.deepEqual(stacked(await board()),[a,b,c]);
  // An arrow-key nudge (no restack) into C does not reorder.
  await write("translatePlacements",{placementIds:[a],dx:0,dy:250});
  assert.deepEqual(stacked(await board()),[a,b,c]);
  // A further small drag while it still overlaps C, and no new neighbour: unchanged.
  await write("updatePlacement",{placementId:a,patch:{x:12,y:260},restack:"drop"});
  assert.deepEqual(stacked(await board()),[a,b,c]);
  // Resizing A over B never reorders, even though it now covers B.
  await write("updatePlacement",{placementId:a,patch:{width:1200}});
  assert.deepEqual(stacked(await board()),[a,b,c]);
  await write("updatePlacement",{placementId:a,patch:{width:300}});
  // A real drop onto B, which A did not overlap, brings A to the top, in one receipt.
  const before = await board();
  const dropped = await write("updatePlacement",{placementId:a,patch:{x:1100,y:60},restack:"drop"});
  assert.deepEqual(stacked(await board()),[b,c,a]);
  // Undo restores position and order together.
  await applyOperation(config,{type:"restoreMovement",history:dropped.history});
  const undone = await board();
  assert.deepEqual(stacked(undone),[a,b,c]);
  assert.deepEqual(undone.placements.find(p => p.id === a),before.placements.find(p => p.id === a));
  // Multi-selection drags use the same rule and keep their own relative order.
  // B lands on C (which is above both); A lands in empty space.
  await write("translatePlacements",{placementIds:[a,b],dx:-900,dy:420,restack:"drop"});
  assert.deepEqual(stacked(await board()),[c,a,b]);
  // Selecting and restyling write nothing to the order; the drop rule needs a move.
  await assert.rejects(write("updatePlacement",{placementId:a,patch:{presentation:{mode:"card"}},restack:"drop"}),{status:400});
});

test("a moved backdrop stays beneath what rests on it and rises only above the rest",async t => {
  const {write,card,board} = await stackFixture(t);
  await write("createDecoration",{decoration:{id:"area",type:"region",x:0,y:0,width:800,height:600,color:"palette:sage",text:"Area"}});
  const resting = await card("Resting",100,100,240,160);
  const neighbour = await card("Neighbour",820,0);
  assert.deepEqual(stacked(await board()),["area",resting,neighbour]);
  // Recolouring the backdrop leaves the order alone.
  const order = stacked(await board());
  await write("updateDecoration",{decorationId:"area",patch:{color:"palette:blue"}});
  assert.deepEqual(stacked(await board()),order);
  // Move the backdrop so it newly overlaps the neighbour, with the resting card still on it.
  await write("updateDecoration",{decorationId:"area",patch:{x:50,y:0},restack:"drop"});
  assert.deepEqual(stacked(await board()),[neighbour,"area",resting]);
});

test("Bring to front and Send to back reorder a selection as one undoable step",async t => {
  const {config,write,card,board} = await stackFixture(t);
  const a = await card("A",0,0), b = await card("B",50,50), c = await card("C",100,100);
  await write("createDecoration",{decoration:{id:"note",type:"text",x:10,y:10,width:200,height:60,color:"palette:neutral",text:"Note"}});
  assert.deepEqual(stacked(await board()),[a,b,c,"note"]);
  const front = await write("restackOccurrences",{placementIds:[b,a],to:"front"});
  assert.deepEqual(stacked(await board()),[c,"note",a,b]);
  assert.ok(front.history);
  await write("restackOccurrences",{placementIds:[],decorationIds:["note"],to:"back"});
  assert.deepEqual(stacked(await board()),["note",c,a,b]);
  const undo = await applyOperation(config,{type:"restoreMovement",history:(await write("restackOccurrences",{placementIds:[c],to:"front"})).history});
  assert.deepEqual(stacked(await board()),["note",c,a,b]);
  assert.ok(undo.history);
  await assert.rejects(write("restackOccurrences",{placementIds:[a],to:"middle"}),{status:400});
  await assert.rejects(write("restackOccurrences",{placementIds:[],to:"front"}),{status:400});
});
