import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {applyOperation,readWorkspace,getBoardSnapshot} from "../lib/workspace.mjs";
import {main} from "../cli.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),"tinka-movement-history-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const config = {boardsRoot:path.join(directory,"boards")};
  await mkdir(config.boardsRoot);
  const op = (type,data = {}) => applyOperation(config,{type,...data});
  await mkdir(path.join(config.boardsRoot,"assets"));
  await writeFile(path.join(config.boardsRoot,"assets","retained.txt"),"Project-owned resource bytes\n");
  await op("updateWorkspace",{patch:{resourceRoots:{assets:{path:"../assets"}}}});
  const source = (await op("createBoard",{title:"Source"})).result;
  const target = (await op("createBoard",{title:"Target"})).result;
  const a = (await op("createItem",{boardId:source.boardId,item:{title:"A",content:{kind:"note",text:"Keep canonical content"},
    resources:[{rootId:"assets",path:"retained.txt"}]},
    placement:{x:-40,y:70,width:445,height:312,z:8,presentation:{mode:"panel",paper:"#e4ebdc",viewport:{width:360,height:650}}}})).result;
  const b = (await op("createItem",{boardId:source.boardId,item:{title:"B"},placement:{x:190,y:-20,z:2}})).result;
  const alias = (await op("reference",{sourceBoardId:source.boardId,placementIds:a.placementIds,targetBoardId:source.boardId})).result;
  await op("createItem",{boardId:target.boardId,item:{title:"Unrelated"}});
  const ids = [...a.placementIds,...b.placementIds,...alias.placementIds];
  const snapshot = () => readWorkspace(config);
  const arrangements = s => s.boards.map(board => ({id:board.id,placements:board.placements,reviewOrder:board.reviewOrder}));
  return {config,directory,op,source,target,a,b,ids,snapshot,arrangements};
}

test("atomic group movement receipts restore original IDs, aliases, exact order/geometry/presentation and reciprocal redo",async t => {
  const f = await fixture(t), before = await f.snapshot();
  await f.op("updateBoard",{boardId:f.source.boardId,patch:{reviewOrder:[...f.ids].reverse()}});
  const original = await f.snapshot();
  const moved = await f.op("move",{sourceBoardId:f.source.boardId,placementIds:[f.ids[2],f.ids[0],f.ids[1]],
    targetBoardId:f.target.boardId,targetPosition:{x:500,y:600},operationId:"group-move"});
  assert.ok(moved.history);
  assert.equal(moved.revision,original.revision + 1);
  const afterMove = await f.snapshot();
  const undo = await f.op("restoreMovement",{history:moved.history,expectedRevision:afterMove.revision,operationId:"group-undo"});
  assert.equal(undo.revision,afterMove.revision + 1);
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(original));
  assert.deepEqual((await f.snapshot()).items,before.items);
  assert.equal(await readFile(path.join(f.config.boardsRoot,"assets","retained.txt"),"utf8"),"Project-owned resource bytes\n");
  const replay = await f.op("restoreMovement",{history:moved.history,expectedRevision:afterMove.revision,operationId:"group-undo"});
  assert.equal(replay.replayed,true);
  assert.deepEqual(replay.history,undo.history);
  const redo = await f.op("restoreMovement",{history:undo.history,operationId:"group-redo"});
  assert.ok(redo.history);
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(afterMove));
  assert.deepEqual((await f.snapshot()).items,before.items);
});

test("translation, resize and nudge receipts compose; zero movement and appearance-only patches omit receipts",async t => {
  const f = await fixture(t), original = await f.snapshot();
  const translated = await f.op("translatePlacements",{boardId:f.source.boardId,placementIds:f.ids,dx:21,dy:-9});
  const afterTranslate = await f.snapshot();
  const resized = await f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.ids[0],patch:{width:620,height:450,x:12,z:20}});
  const afterResize = await f.snapshot();
  const nudge = await f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.ids[0],patch:{x:13}});
  const undoNudge = await f.op("restoreMovement",{history:nudge.history});
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(afterResize));
  await f.op("restoreMovement",{history:resized.history});
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(afterTranslate));
  await f.op("restoreMovement",{history:translated.history});
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(original));
  assert.ok(undoNudge.history);
  assert.equal((await f.op("translatePlacements",{boardId:f.source.boardId,placementIds:f.ids,dx:0,dy:0})).history,undefined);
  assert.equal((await f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.ids[0],patch:{x:-40}})).history,undefined);
  assert.equal((await f.op("updatePlacement",{boardId:f.source.boardId,placementId:f.ids[0],patch:{presentation:{mode:"icon"}}})).history,undefined);
});

test("signed receipts survive64+ unrelated review/title operations, hide the secret, and preserve newer canonical changes",async t => {
  const f = await fixture(t), original = await f.snapshot();
  const moved = await f.op("translatePlacements",{boardId:f.source.boardId,placementIds:f.ids,dx:90,dy:80,operationId:"old-move"});
  const metadataPath = path.join(f.config.boardsRoot,".tinka","workspace.json");
  const privateMetadata = JSON.parse(await readFile(metadataPath,"utf8"));
  assert.match(privateMetadata.movementHistoryKey,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(await f.snapshot()).includes(privateMetadata.movementHistoryKey));
  assert.ok(!JSON.stringify(await getBoardSnapshot(f.config,f.source.boardId)).includes(privateMetadata.movementHistoryKey));
  assert.ok(!JSON.stringify(moved).includes(privateMetadata.movementHistoryKey));
  const configPath = path.join(f.directory,"config.json");
  await writeFile(configPath,JSON.stringify({schemaVersion:1,port:43821,projectLabel:"History fixture",...f.config}));
  assert.ok(!(await main(["workspace","show","--config",configPath])).includes(privateMetadata.movementHistoryKey));
  for (let i = 0; i < 66; i++) await f.op("review",{itemId:f.a.itemId,patch:{note:`Later note ${i}`,star:true},operationId:`review-${i}`});
  await f.op("updateItem",{itemId:f.a.itemId,patch:{title:"New item title"}});
  await f.op("updateBoard",{boardId:f.source.boardId,patch:{title:"New board title"}});
  const latest = await f.snapshot();
  assert.equal(JSON.parse(await readFile(metadataPath,"utf8")).recentOperations.some(p => p.operationId === "old-move"),false);
  await f.op("restoreMovement",{history:JSON.parse(JSON.stringify(moved.history)),expectedRevision:latest.revision});
  const restored = await f.snapshot();
  assert.deepEqual(f.arrangements(restored),f.arrangements(original));
  assert.deepEqual(restored.items,latest.items);
  assert.equal(restored.boards.find(b => b.id === f.source.boardId).title,"New board title");
});

test("tampered receipts, stale revisions, conflicting arrangement edits and changed operation IDs reject atomically",async t => {
  const f = await fixture(t);
  const moved = await f.op("move",{sourceBoardId:f.source.boardId,placementIds:f.ids,targetBoardId:f.target.boardId});
  const stable = await f.snapshot();
  const tampered = structuredClone(moved.history);
  tampered.boards[0].before.placements[0].value.x = 888;
  for (const [data,status] of [
    [{history:tampered},400], [{history:{}},400],
    [{history:moved.history,expectedRevision:stable.revision - 1},409],
  ]) {
    await assert.rejects(() => f.op("restoreMovement",data),{status});
    assert.deepEqual(await f.snapshot(),stable);
  }
  const other = await fixture(t), otherStable = await other.snapshot();
  await assert.rejects(() => other.op("restoreMovement",{history:moved.history}),{status:400});
  assert.deepEqual(await other.snapshot(),otherStable);
  await f.op("updatePlacement",{boardId:f.target.boardId,placementId:moved.result.placementIds[0],patch:{x:900}});
  const conflicted = await f.snapshot();
  await assert.rejects(() => f.op("restoreMovement",{history:moved.history}),{status:409});
  assert.deepEqual(await f.snapshot(),conflicted);
  const resized = await f.op("updatePlacement",{boardId:f.target.boardId,placementId:moved.result.placementIds[0],patch:{width:500}});
  await f.op("restoreMovement",{history:resized.history,operationId:"one-undo"});
  const undone = await f.snapshot();
  await assert.rejects(() => f.op("restoreMovement",{history:moved.history,operationId:"one-undo"}),{status:409});
  assert.deepEqual(await f.snapshot(),undone);
});

test("board-owner movement restores changed home membership and normal cycle validation still rejects undo",async t => {
  const f = await fixture(t);
  const child = (await f.op("createBoard",{title:"Child",parentBoardId:f.source.boardId})).result;
  // A board can be on home and referenced inside another board at the same time.
  await f.op("reference",{itemIds:[child.itemId]});
  const before = await f.snapshot();
  const moved = await f.op("move",{sourceBoardId:f.source.boardId,placementIds:child.placementIds,targetBoardId:f.target.boardId});
  assert.ok(!(await f.snapshot()).homeBoardIds.includes(child.boardId));
  await f.op("restoreMovement",{history:moved.history});
  assert.deepEqual((await f.snapshot()).homeBoardIds,before.homeBoardIds);
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(before));
  const movedAgain = await f.op("move",{sourceBoardId:f.source.boardId,placementIds:child.placementIds,targetBoardId:f.target.boardId});
  // This edits a third board, so receipt preconditions still match, but restoring
  // Source -> Child would now close Child -> Source -> Child.
  await f.op("reference",{itemIds:[f.source.itemId],targetBoardId:child.boardId});
  const stable = await f.snapshot();
  await assert.rejects(() => f.op("restoreMovement",{history:movedAgain.history}),{status:409});
  assert.deepEqual(await f.snapshot(),stable);
});

test("cached old responses make room for a new movement without weakening its idempotent replay",async t => {
  const f = await fixture(t);
  const metadataPath = path.join(f.config.boardsRoot,".tinka","workspace.json");
  const metadata = JSON.parse(await readFile(metadataPath,"utf8"));
  metadata.recentOperations = Array.from({length:63},(_,i) => ({operationId:`old-${i}`,fingerprint:"prior",
    response:{revision:i,result:{retained:"x".repeat(30000)}}}));
  const remaining = 1999500 - Buffer.byteLength(JSON.stringify(metadata));
  metadata.recentOperations[0].response.result.retained += "x".repeat(remaining);
  await writeFile(metadataPath,JSON.stringify(metadata));
  const original = await f.snapshot();
  const input = {boardId:f.source.boardId,placementIds:f.ids,dx:14,dy:27,operationId:"move-after-cache-pressure"};
  const moved = await f.op("translatePlacements",input);
  assert.ok(moved.history);
  const persisted = JSON.parse(await readFile(metadataPath,"utf8"));
  assert.ok(persisted.recentOperations.length < 64);
  assert.ok(Buffer.byteLength(JSON.stringify(persisted)) <= 2000000);
  const replay = await f.op("translatePlacements",input);
  assert.equal(replay.replayed,true);
  assert.equal(replay.revision,moved.revision);
  assert.deepEqual(replay.history,moved.history);
  await f.op("restoreMovement",{history:moved.history});
  assert.deepEqual(f.arrangements(await f.snapshot()),f.arrangements(original));
});
