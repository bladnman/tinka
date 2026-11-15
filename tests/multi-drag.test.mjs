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
