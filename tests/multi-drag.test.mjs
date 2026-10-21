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
