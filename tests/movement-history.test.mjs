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

test("moving or resizing text, shapes and arrows records a receipt that undoes and redoes exactly",async t => {
  const f = await fixture(t), boardId = f.source.boardId;
  const board = async () => (await f.snapshot()).boards.find(b => b.id === boardId);
  const title = (await f.op("createDecoration",{boardId,decoration:{type:"text",x:0,y:800,width:1400,height:56,color:"#536044",text:"Concepts"}})).result.decorationId;
  const box = (await f.op("createDecoration",{boardId,decoration:{type:"region",shape:"rounded",x:600,y:600,width:200,height:120,color:"#f3d36b",text:"Box"}})).result.decorationId;
  const arrow = (await f.op("createDecoration",{boardId,decoration:{type:"line",x:0,y:0,width:10,height:10,color:"#6c8060",text:"",
    from:{decorationId:box,side:"left"},to:{x:300,y:300}}})).result.decorationId;
  const start = await board(), placements = JSON.stringify(start.placements), order = JSON.stringify(start.reviewOrder);
  const find = (b,id) => b.decorations.find(d => d.id === id);
  // A text edit is its own undo step, which redoes exactly.
  const edited = await f.op("updateDecoration",{boardId,decorationId:title,patch:{text:"Concepts · open one"}});
  assert.ok(edited.history,"a text edit returns a receipt");
  const unedited = await f.op("restoreMovement",{history:edited.history});
  assert.equal(find(await board(),title).text,"Concepts");
  await f.op("restoreMovement",{history:unedited.history});
  assert.equal(find(await board(),title).text,"Concepts · open one");
  const named = await board();
  const moved = await f.op("updateDecoration",{boardId,decorationId:title,patch:{x:-1,y:814}});
  assert.ok(moved.history,"a dragged title returns a receipt");
  assert.deepEqual([find(await board(),title).x,find(await board(),title).y],[-1,814]);
  const undone = await f.op("restoreMovement",{history:moved.history});
  assert.deepEqual(find(await board(),title),find(named,title),"undo restores the exact title");
  assert.equal(JSON.stringify((await board()).placements),placements,"placements are untouched");
  assert.equal(JSON.stringify((await board()).reviewOrder),order);
  await f.op("restoreMovement",{history:undone.history});
  assert.deepEqual([find(await board(),title).x,find(await board(),title).y],[-1,814],"redo moves it again");
  // Moving a shape freezes its arrow's fallback point; undo restores both.
  const beforeBox = await board();
  const shaped = await f.op("updateDecoration",{boardId,decorationId:box,patch:{x:900,y:700,width:260}});
  assert.ok(shaped.history);
  await f.op("restoreMovement",{history:shaped.history});
  assert.deepEqual(find(await board(),box),find(beforeBox,box));
  assert.deepEqual(find(await board(),arrow),find(beforeBox,arrow));
  // An arrow's own endpoints move and come back.
  const beforeArrow = await board();
  const dragged = await f.op("updateDecoration",{boardId,decorationId:arrow,patch:{to:{x:500,y:420}}});
  assert.ok(dragged.history);
  await f.op("restoreMovement",{history:dragged.history});
  assert.deepEqual(find(await board(),arrow),find(beforeArrow,arrow));
  // A later change to the moved decoration rejects the stale receipt without changing anything.
  const again = await f.op("updateDecoration",{boardId,decorationId:title,patch:{x:40}});
  await f.op("updateDecoration",{boardId,decorationId:title,patch:{color:"#8b6fb0"}});
  const changed = await board();
  await assert.rejects(f.op("restoreMovement",{history:again.history}),error => error.status === 409);
  assert.deepEqual(await board(),changed);
  // Card movement receipts are unchanged by decoration support.
  const cardMove = await f.op("translatePlacements",{boardId,placementIds:[f.ids[0]],dx:10,dy:0});
  assert.equal(cardMove.history.boards[0].decorationIds,undefined);
  await f.op("restoreMovement",{history:cardMove.history});
});

test("adding, restyling, batch-editing and deleting drawn elements each undo and redo as one step",async t => {
  const f = await fixture(t), boardId = f.source.boardId;
  const board = async () => (await f.snapshot()).boards.find(b => b.id === boardId);
  const decorations = async () => JSON.stringify((await board()).decorations);
  const roundTrip = async (response, label) => {
    assert.ok(response.history, `${label} returns a receipt`);
    const before = await decorations();
    const undone = await f.op("restoreMovement",{history:response.history});
    const reverted = await decorations();
    assert.notEqual(reverted,before,`${label} undoes`);
    const redone = await f.op("restoreMovement",{history:undone.history});
    assert.equal(await decorations(),before,`${label} redoes`);
    assert.ok(redone.history,"redo returns the next undo receipt");
    return reverted;
  };
  const empty = await decorations();
  const created = await f.op("createDecoration",{boardId,decoration:{id:"sticky-1",type:"region",shape:"rectangle",x:0,y:0,width:200,height:200,color:"#f6e6a4",text:"Hi"}});
  assert.equal(await roundTrip(created,"create"),empty,"undoing a create removes it");
  await roundTrip(await f.op("updateDecoration",{boardId,decorationId:"sticky-1",patch:{color:"#e0e8da",textSize:"large"}}),"style");
  await f.op("createDecoration",{boardId,decoration:{id:"label-1",type:"text",x:0,y:300,width:200,height:50,color:"#7a8a68",text:"Label"}});
  const current = (await board()).decorations;
  const batch = await f.op("updateBoard",{boardId,patch:{decorations:current.map(d => ({...d,color:"#8b6fb0"}))}});
  await roundTrip(batch,"batch style");
  const removed = await f.op("removeDecoration",{boardId,decorationId:"label-1"});
  const restored = await roundTrip(removed,"delete");
  assert.ok(JSON.parse(restored).some(d => d.id === "label-1"),"undoing a delete brings it back");
  // Remove with decorationIds deletes cards and drawn elements in one commit and one receipt.
  const mixed = await f.op("remove",{boardId,placementIds:[f.ids[0]],decorationIds:["sticky-1"]});
  assert.deepEqual(mixed.result.decorationIds,["sticky-1"]);
  assert.equal((await board()).decorations.some(d => d.id === "sticky-1"),false);
  await f.op("restoreMovement",{history:mixed.history});
  const back = await board();
  assert.ok(back.decorations.some(d => d.id === "sticky-1"),"one Undo restores the drawn element");
  assert.equal(back.placements.find(p => p.id === f.ids[0]).removedAt,undefined,"and the card");
  // Older forms are unchanged: remove without decorationIds, and its result shape.
  const plain = await f.op("remove",{boardId,placementIds:[f.ids[1]]});
  assert.equal(Object.hasOwn(plain.result,"decorationIds"),false);
});
