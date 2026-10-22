import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {applyOperation,readWorkspace} from "../lib/workspace.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tinka-cut-paste-"));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const config = {boardsRoot:path.join(directory,"boards")};
  await mkdir(path.join(config.boardsRoot,"assets"), {recursive:true});
  await writeFile(path.join(config.boardsRoot,"assets","original.txt"), "Keep original resource bytes\n");
  const op = (type,data = {}) => applyOperation(config,{type,...data});
  await op("updateWorkspace",{patch:{resourceRoots:{assets:{path:"../assets"}}}});
  const source = (await op("createBoard",{title:"Source"})).result;
  const target = (await op("createBoard",{title:"Target"})).result;
  const first = (await op("createItem",{boardId:source.boardId,
    item:{title:"A",content:{kind:"text",text:"Original content"},resources:[{rootId:"assets",path:"original.txt"}],
      review:{note:"Original note",star:true}},
    placement:{x:-90,y:40,width:430,height:310,z:9,presentation:{mode:"panel",paper:"#ddeeff",viewport:{width:360,height:650}}}})).result;
  const second = (await op("createItem",{boardId:source.boardId,item:{title:"B"},placement:{x:80,y:-20,z:2}})).result;
  const alias = (await op("reference",{itemIds:[first.itemId],targetBoardId:source.boardId})).result;
  const spare = (await op("createItem",{boardId:source.boardId,item:{title:"Unselected"}})).result;
  const child = (await op("createBoard",{title:"Child",parentBoardId:source.boardId})).result;
  await op("reference",{itemIds:[first.itemId],targetBoardId:child.boardId});
  await op("createItem",{boardId:target.boardId,item:{title:"Existing"},placement:{z:22}});
  const selection = [...child.placementIds,...alias.placementIds,...second.placementIds,...first.placementIds];
  await op("updateBoard",{boardId:source.boardId,patch:{reviewOrder:[...selection,...spare.placementIds]}});
  const snapshot = () => readWorkspace(config);
  const captured = await snapshot(), board = captured.boards.find(b => b.id === source.boardId);
  const cut = {sourceBoardId:source.boardId,placementIds:selection,targetBoardId:target.boardId,
    targetPosition:{x:500,y:600},expectedSourcePlacements:selection.map(id => structuredClone(board.placements.find(p => p.id === id))),
    expectedSourceReviewOrder:board.reviewOrder.filter(id => selection.includes(id))};
  const arrangements = s => s.boards.map(b => ({id:b.id,placements:b.placements,reviewOrder:b.reviewOrder}));
  return {config,op,source,target,first,second,child,spare,selection,snapshot,cut,captured,arrangements};
}

test("deferred cut moves the current canonical items once, keeping aliases, children, resources and exact undo/redo arrangement",async t => {
  const f = await fixture(t);
  // Capturing a cut is read-only, and ordinary independent work may continue.
  assert.deepEqual(await f.snapshot(),f.captured);
  await f.op("review",{itemId:f.first.itemId,patch:{note:"Latest note",star:false}});
  await f.op("updateItem",{itemId:f.first.itemId,patch:{title:"Latest title",content:{kind:"text",text:"Latest content"}}});
  await f.op("createItem",{boardId:f.child.boardId,item:{title:"New child after cut"}});
  await f.op("createItem",{boardId:f.source.boardId,item:{title:"Unrelated after cut"}});
  await f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.spare.placementIds[0],patch:{x:900}});
  // Native clipboard JSON may reorder keys without changing the saved values.
  f.cut.expectedSourcePlacements = f.cut.expectedSourcePlacements.map(p => Object.fromEntries(Object.entries(p).reverse()));
  const before = await f.snapshot();
  const moved = await f.op("move",{...f.cut,operationId:"cut-transfer",expectedRevision:before.revision});
  assert.equal(moved.revision,before.revision + 1);
  assert.ok(moved.history);
  assert.equal(moved.history.boards.length,2);
  const after = await f.snapshot(), source = after.boards.find(b => b.id === f.source.boardId), target = after.boards.find(b => b.id === f.target.boardId);
  assert.deepEqual(after.items,before.items);
  assert.deepEqual(after.boards.find(b => b.id === f.child.boardId),before.boards.find(b => b.id === f.child.boardId));
  assert.deepEqual(moved.result.itemIds,f.cut.expectedSourcePlacements.map(p => p.itemId));
  const origin = {x:Math.min(...f.cut.expectedSourcePlacements.map(p => p.x)),y:Math.min(...f.cut.expectedSourcePlacements.map(p => p.y))};
  moved.result.placementIds.forEach((id,index) => {
    const saved = f.cut.expectedSourcePlacements[index], placed = target.placements.find(p => p.id === id);
    assert.notEqual(id,saved.id);
    assert.equal(placed.x,500 + saved.x - origin.x);
    assert.equal(placed.y,600 + saved.y - origin.y);
    assert.equal(placed.width,saved.width);
    assert.equal(placed.height,saved.height);
    assert.deepEqual(placed.presentation,saved.presentation);
    assert.ok(placed.z > 22);
    assert.equal(source.placements.find(p => p.id === saved.id).removalReason,"move");
  });
  assert.deepEqual(target.reviewOrder.slice(-f.selection.length),moved.result.placementIds);
  assert.equal(await readFile(path.join(f.config.boardsRoot,"assets","original.txt"),"utf8"),"Keep original resource bytes\n");
  const replay = await f.op("move",{...f.cut,operationId:"cut-transfer",expectedRevision:before.revision});
  assert.equal(replay.replayed,true);
  assert.deepEqual(replay.history,moved.history);
  assert.deepEqual(await f.snapshot(),after);
  await assert.rejects(() => f.op("move",{...f.cut,operationId:"second-transfer"}),{status:409});
  assert.deepEqual(await f.snapshot(),after);
  await f.op("review",{itemId:f.first.itemId,patch:{note:"Note after paste",star:true}});
  const latestItems = (await f.snapshot()).items;
  const undone = await f.op("restoreMovement",{history:moved.history});
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(before));
  assert.deepEqual((await f.snapshot()).items,latestItems);
  await f.op("restoreMovement",{history:undone.history});
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(after));
  assert.deepEqual((await f.snapshot()).items,latestItems);
});

test("cut source snapshots reject geometry, appearance, order and membership changes without moving any selection",async t => {
  for (const change of [
    f => f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.selection[0],patch:{x:501}}),
    f => f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.selection[1],patch:{width:550}}),
    f => f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.selection[2],patch:{presentation:{mode:"icon"}}}),
    f => f.op("updateBoard",{boardId:f.source.boardId,patch:{reviewOrder:[...f.selection].reverse()}}),
    f => f.op("remove",{boardId:f.source.boardId,placementIds:[f.selection[0]]}),
    f => f.op("move",{sourceBoardId:f.source.boardId,placementIds:[f.selection[1]],targetBoardId:f.target.boardId}),
  ]) {
    const f = await fixture(t);
    await change(f);
    const before = await f.snapshot();
    await assert.rejects(() => f.op("move",f.cut),{status:409});
    assert.deepEqual(await f.snapshot(),before);
  }
});

test("cut guards archived items and board owners, deleted items and stale workspace revision atomically",async t => {
  for (const change of [
    f => f.op("archive",{boardId:f.source.boardId,placementIds:[f.selection[0]],archived:true}),
    f => f.op("archiveItem",{itemIds:[f.first.itemId],archived:true}),
    f => f.op("archiveItem",{itemIds:[f.source.itemId],archived:true}),
    f => f.op("archiveItem",{itemIds:[f.target.itemId],archived:true}),
    f => f.op("deleteItem",{itemIds:[f.first.itemId]}),
  ]) {
    const f = await fixture(t);
    await change(f);
    const before = await f.snapshot();
    await assert.rejects(() => f.op("move",f.cut),{status:409});
    assert.deepEqual(await f.snapshot(),before);
  }
  const f = await fixture(t), before = await f.snapshot();
  await assert.rejects(() => f.op("move",{...f.cut,expectedRevision:before.revision - 1}),{status:409});
  assert.deepEqual(await f.snapshot(),before);
});

test("malformed paired cut preconditions reject and ordinary moves remain compatible",async t => {
  const f = await fixture(t), before = await f.snapshot();
  for (const patch of [
    {expectedSourcePlacements:undefined}, {expectedSourceReviewOrder:undefined},
    {expectedSourcePlacements:[]}, {expectedSourceReviewOrder:[f.selection[0],f.selection[0]]},
    {expectedSourceReviewOrder:["unknown-placement"]}, {expectedSourcePlacements:f.cut.expectedSourcePlacements.slice().reverse()},
    {expectedSourcePlacements:f.cut.expectedSourcePlacements.map((p,index) => index ? p : {...p,width:1})},
    {targetBoardId:f.source.boardId}, {targetBoardId:undefined}, {newBoard:{title:"Unexpected board"}},
    {placementIds:[f.selection[0],f.selection[0]]}, {itemIds:[f.first.itemId]},
  ]) {
    await assert.rejects(() => f.op("move",{...f.cut,...patch}),{status:400});
    assert.deepEqual(await f.snapshot(),before);
  }
  await assert.rejects(() => f.op("reference",f.cut),{status:400});
  assert.deepEqual(await f.snapshot(),before);
  const {expectedSourcePlacements,expectedSourceReviewOrder,...ordinary} = f.cut;
  assert.ok((await f.op("move",ordinary)).history);
});

test("cut destination containment and coordinate rejection leave source and destination untouched",async t => {
  const f = await fixture(t), before = await f.snapshot();
  await assert.rejects(() => f.op("move",{...f.cut,targetBoardId:f.child.boardId}),{status:409});
  assert.deepEqual(await f.snapshot(),before);
  await assert.rejects(() => f.op("move",{...f.cut,targetPosition:{x:10000000,y:0}}),{status:400});
  assert.deepEqual(await f.snapshot(),before);
});
