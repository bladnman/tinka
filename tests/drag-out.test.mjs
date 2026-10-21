import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {applyOperation, readWorkspace, getBoardSnapshot} from "../lib/workspace.mjs";

test("one atomic positioned move preserves canonical state and presentation; invalid positions do not commit", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tinka-drag-out-"));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const config = {boardsRoot:path.join(directory, "boards")};
  await mkdir(config.boardsRoot);
  const op = async (type, data = {}) => (await applyOperation(config, {type, ...data})).result;
  const source = await op("createBoard", {title:"Collection"});
  const target = await op("createBoard", {title:"Parent"});
  const item = await op("createItem", {boardId:source.boardId,
    item:{title:"Reader", content:{kind:"note", text:"Canonical content"}},
    placement:{width:440, height:310, presentation:{mode:"panel", paper:"#e4ebdc", viewport:{width:360,height:650}}}});
  await op("review", {itemId:item.itemId, patch:{note:"Retain this note", star:true}});
  await op("reference", {sourceBoardId:source.boardId, placementIds:item.placementIds, targetBoardId:target.boardId});
  const before = await readWorkspace(config);
  const moved = await applyOperation(config, {type:"move", sourceBoardId:source.boardId,
    placementIds:item.placementIds, targetBoardId:target.boardId,
    targetPosition:{x:-117,y:268}, expectedRevision:before.revision});
  const after = await readWorkspace(config);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.items, before.items);
  const board = await getBoardSnapshot(config, target.boardId);
  const placed = board.placements.find(p => p.id === moved.result.placementIds[0]);
  assert.equal(placed.x, -117);
  assert.equal(placed.y, 268);
  assert.equal(placed.width, 440);
  assert.equal(placed.height, 310);
  assert.deepEqual(placed.presentation, {mode:"panel", paper:"#e4ebdc", viewport:{width:360,height:650}});
  assert.equal(board.placements.filter(p => p.itemId === item.itemId && !p.removedAt).length, 2);
  assert.ok((await getBoardSnapshot(config, source.boardId)).placements[0].removedAt);
  const stable = await readWorkspace(config);
  for (const change of [
    {targetPosition:{x:Infinity,y:0}},
    {targetPosition:{x:0,y:10000001}},
    {targetPosition:{x:0}},
    {targetPosition:{x:0,y:0,width:200}},
    {type:"reference",targetPosition:{x:0,y:0}},
    {placementIds:board.placements.map(p => p.id),targetPosition:{x:0,y:0}},
    {targetBoardId:undefined,newBoard:{title:"Invalid"},targetPosition:{x:0,y:0}},
  ]) {
    await assert.rejects(() => applyOperation(config, {type:"move",sourceBoardId:target.boardId,
      placementIds:[placed.id],targetBoardId:source.boardId,...change}), {status:400});
    assert.deepEqual(await readWorkspace(config), stable);
  }
});
