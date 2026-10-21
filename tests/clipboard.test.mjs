import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {applyOperation,readWorkspace} from "../lib/workspace.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tinka-clipboard-"));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const config = {boardsRoot:path.join(directory,"boards")};
  await mkdir(path.join(config.boardsRoot,"assets"), {recursive:true});
  await writeFile(path.join(config.boardsRoot,"assets","sample.txt"), "Keep resource bytes\n");
  const op = (type,data = {}) => applyOperation(config,{type,...data});
  await op("updateWorkspace",{patch:{resourceRoots:{assets:{path:"../assets"}}}});
  const source = (await op("createBoard",{title:"Source"})).result;
  const target = (await op("createBoard",{title:"Target"})).result;
  const first = (await op("createItem",{boardId:source.boardId,item:{title:"A",description:"Original description",
    content:{kind:"text",text:"Copied content"},resources:[{rootId:"assets",path:"sample.txt"}],
    review:{note:"Copied note",star:true},preview:{url:"https://example.com/cover.png"}},
    placement:{x:-80,y:40,width:410,height:310,z:7,presentation:{mode:"panel",paper:"#ddeeff",viewport:{width:360,height:650}}}})).result;
  const second = (await op("createItem",{boardId:source.boardId,item:{title:"B"},placement:{x:60,y:-20,z:-3}})).result;
  const alias = (await op("reference",{itemIds:[first.itemId],targetBoardId:source.boardId})).result;
  await op("updatePlacement",{boardId:source.boardId,placementId:alias.placementIds[0],patch:{x:200,y:340,z:2}});
  const selection = [...alias.placementIds,...first.placementIds,...second.placementIds];
  await op("updateBoard",{boardId:source.boardId,patch:{reviewOrder:[...second.placementIds,...first.placementIds,...alias.placementIds]}});
  await op("createItem",{boardId:target.boardId,item:{title:"Existing"},placement:{z:22}});
  const snapshot = () => readWorkspace(config);
  const capture = async (selected = selection) => {
    const workspace = await snapshot(), board = workspace.boards.find(b => b.id === source.boardId);
    const placements = selected.map(id => structuredClone(board.placements.find(p => p.id === id)));
    const items = Object.fromEntries(placements.map(p => [p.itemId,structuredClone(workspace.items.find(i => i.id === p.itemId))]));
    const boards = Object.fromEntries(Object.values(items).filter(i => i.childBoardId)
      .map(i => [i.childBoardId,structuredClone(workspace.boards.find(b => b.id === i.childBoardId))]));
    return {version:1,workspaceId:workspace.workspaceId,placements,items,boards,
      reviewOrder:board.reviewOrder.filter(id => selected.includes(id))};
  };
  return {directory,config,op,source,target,first,second,selection,snapshot,capture};
}

test("paste keeps copy-time arrangement and aliases after source moves, with independent canonical metadata",async t => {
  const f = await fixture(t), clipboard = await f.capture();
  await f.op("move",{sourceBoardId:f.source.boardId,placementIds:f.selection,targetBoardId:f.target.boardId});
  await f.op("updateItem",{itemId:f.first.itemId,patch:{title:"Changed since copy",content:{kind:"text",text:"New source content"}}});
  const before = await f.snapshot();
  const pasted = await f.op("pastePlacements",{clipboard,targetBoardId:f.source.boardId,targetPosition:{x:500,y:600},operationId:"paste-copy"});
  assert.equal(pasted.revision,before.revision + 1);
  assert.ok(pasted.history);
  const after = await f.snapshot(), board = after.boards.find(b => b.id === f.source.boardId);
  const placements = pasted.result.placementIds.map(id => board.placements.find(p => p.id === id));
  assert.equal(pasted.result.itemIds[0],pasted.result.itemIds[1]);
  assert.notEqual(pasted.result.itemIds[1],f.first.itemId);
  assert.equal(new Set(pasted.result.placementIds).size,3);
  const origin = {x:-80,y:-20};
  placements.forEach((p,index) => {
    const saved = clipboard.placements[index];
    assert.equal(p.x,500 + saved.x - origin.x);
    assert.equal(p.y,600 + saved.y - origin.y);
    assert.equal(p.width,saved.width);
    assert.equal(p.height,saved.height);
    assert.deepEqual(p.presentation,saved.presentation);
    assert.equal(p.z - placements[0].z,saved.z - clipboard.placements[0].z);
  });
  assert.deepEqual(board.reviewOrder,clipboard.reviewOrder.map(id => pasted.result.placementIds[clipboard.placements.findIndex(p => p.id === id)]));
  const copied = after.items.find(i => i.id === pasted.result.itemIds[0]);
  assert.equal(copied.title,"A");
  assert.equal(copied.content.text,"Copied content");
  assert.deepEqual(copied.review,clipboard.items[f.first.itemId].review);
  assert.deepEqual(copied.resources,clipboard.items[f.first.itemId].resources);
  assert.deepEqual(after.items.filter(i => before.items.some(old => old.id === i.id)),before.items);
  assert.equal(await readFile(path.join(f.config.boardsRoot,"assets","sample.txt"),"utf8"),"Keep resource bytes\n");
  const retry = await f.op("pastePlacements",{clipboard,targetBoardId:f.source.boardId,targetPosition:{x:500,y:600},operationId:"paste-copy"});
  assert.equal(retry.replayed,true);
  assert.deepEqual(retry.result,pasted.result);
  assert.deepEqual(await f.snapshot(),after);
});

test("paste is one undo step with exact redo IDs, later review preserved, and copied boards stay off home",async t => {
  const f = await fixture(t);
  const child = (await f.op("createBoard",{title:"Child",parentBoardId:f.source.boardId})).result;
  await f.op("reference",{itemIds:[f.first.itemId],targetBoardId:child.boardId});
  await f.op("updateBoard",{boardId:child.boardId,patch:{decorations:[{id:"caption",type:"text",x:20,y:30,width:100,height:50,color:"#112233",text:"Retained"}],background:{color:"#efe"}}});
  const selected = [...child.placementIds,...f.first.placementIds], clipboard = await f.capture(selected), before = await f.snapshot();
  const pasted = await f.op("pastePlacements",{clipboard,targetBoardId:f.target.boardId,targetPosition:{x:-300,y:100}});
  const after = await f.snapshot(), copiedOwner = after.items.find(i => i.id === pasted.result.itemIds[0]);
  const originalBoard = before.boards.find(b => b.id === child.boardId), copiedBoard = after.boards.find(b => b.id === copiedOwner.childBoardId);
  assert.notEqual(copiedBoard.id,child.boardId);
  assert.deepEqual(copiedBoard.decorations,originalBoard.decorations);
  assert.deepEqual(copiedBoard.background,originalBoard.background);
  assert.equal(copiedBoard.placements[0].itemId,pasted.result.itemIds[1]);
  assert.deepEqual(after.homeBoardIds,before.homeBoardIds);
  await f.op("review",{itemId:copiedOwner.id,patch:{note:"Written after paste",star:true}});
  const undo = await f.op("restoreMovement",{history:pasted.history});
  const undone = await f.snapshot();
  assert.deepEqual(undone.boards.find(b => b.id === f.target.boardId).placements,before.boards.find(b => b.id === f.target.boardId).placements);
  assert.deepEqual(undone.homeBoardIds,before.homeBoardIds);
  assert.ok(undone.boards.some(b => b.id === copiedBoard.id));
  await f.op("restoreMovement",{history:undo.history});
  const redone = await f.snapshot();
  assert.deepEqual(redone.boards.find(b => b.id === f.target.boardId).placements,after.boards.find(b => b.id === f.target.boardId).placements);
  assert.deepEqual(redone.boards.find(b => b.id === f.target.boardId).reviewOrder,after.boards.find(b => b.id === f.target.boardId).reviewOrder);
  assert.equal(redone.items.find(i => i.id === copiedOwner.id).review.note,"Written after paste");
});

test("malformed, foreign, missing-resource and overflowing clipboard payloads reject atomically",async t => {
  const f = await fixture(t), original = await f.capture(), before = await f.snapshot();
  const changed = alter => {const clip = structuredClone(original);alter(clip);return clip;};
  const invalid = [
    changed(c => c.version = 2), changed(c => c.workspaceId = "workspace-other"),
    changed(c => c.unexpected = true), changed(c => c.placements.push(c.placements[0])),
    changed(c => c.placements[0].width = 2), changed(c => c.placements[0].removedAt = "old"),
    changed(c => c.items[f.first.itemId].id = "wrong"), changed(c => delete c.items[f.first.itemId]),
    changed(c => c.items[f.first.itemId].resources[0].rootId = "unknown"),
    changed(c => c.items[f.first.itemId].preview.url = "file:///private/secret"),
    changed(c => c.reviewOrder = [c.reviewOrder[0]]),
    changed(c => c.boards.extra = {}),
  ];
  for (const clipboard of invalid) {
    await assert.rejects(() => f.op("pastePlacements",{clipboard,targetBoardId:f.target.boardId,targetPosition:{x:0,y:0}}),{status:400});
    assert.deepEqual(await f.snapshot(),before);
  }
  for (const targetPosition of [{x:Infinity,y:0},{x:10000000,y:0},{x:0,y:0,z:1}]) {
    await assert.rejects(() => f.op("pastePlacements",{clipboard:original,targetBoardId:f.target.boardId,targetPosition}),{status:400});
    assert.deepEqual(await f.snapshot(),before);
  }
  await assert.rejects(() => f.op("pastePlacements",{clipboard:changed(c => c.items[f.first.itemId].resources[0].path = "../../escape"),
    targetBoardId:f.target.boardId,targetPosition:{x:0,y:0}}),{status:403});
  await assert.rejects(() => f.op("pastePlacements",{clipboard:original,targetBoardId:f.target.boardId,targetPosition:{x:0,y:0},expectedRevision:before.revision - 1}),{status:409});
  assert.deepEqual(await f.snapshot(),before);
});

test("board snapshots retain ordinary child references and reject missing children, malformed layouts and cycles atomically",async t => {
  const f = await fixture(t), child = (await f.op("createBoard",{title:"Collection",parentBoardId:f.source.boardId})).result;
  await f.op("reference",{itemIds:[f.first.itemId],targetBoardId:child.boardId});
  const clipboard = await f.capture(child.placementIds), before = await f.snapshot();
  for (const [alter,status] of [
    [c => c.boards[child.boardId].placements = [null],400],
    [c => c.boards[child.boardId].placements[0].itemId = "missing-child",404],
    [c => c.boards[child.boardId].placements[0].itemId = child.itemId,409],
    [c => c.boards[child.boardId].reviewOrder = ["missing-placement"],400],
  ]) {
    const changed = structuredClone(clipboard);alter(changed);
    await assert.rejects(() => f.op("pastePlacements",{clipboard:changed,targetBoardId:f.target.boardId,targetPosition:{x:20,y:30}}),{status});
    assert.deepEqual(await f.snapshot(),before);
  }
  const pasted = await f.op("pastePlacements",{clipboard,targetBoardId:f.target.boardId,targetPosition:{x:20,y:30}});
  const after = await f.snapshot(), owner = after.items.find(i => i.id === pasted.result.itemIds[0]);
  assert.equal(after.boards.find(b => b.id === owner.childBoardId).placements[0].itemId,f.first.itemId);
});

test("archived selections produce visible unarchived copies while original archive flags remain",async t => {
  const f = await fixture(t);
  await f.op("archiveItem",{itemIds:[f.first.itemId],archived:true});
  await f.op("archive",{boardId:f.source.boardId,placementIds:f.first.placementIds,archived:true});
  const clipboard = await f.capture(f.first.placementIds);
  const pasted = await f.op("pastePlacements",{clipboard,targetBoardId:f.target.boardId,targetPosition:{x:20,y:30}});
  const after = await f.snapshot();
  assert.ok(after.items.find(i => i.id === f.first.itemId).archivedAt);
  assert.equal(after.items.find(i => i.id === pasted.result.itemIds[0]).archivedAt,undefined);
  assert.equal(after.boards.find(b => b.id === f.target.boardId).placements.find(p => p.id === pasted.result.placementIds[0]).archivedAt,undefined);
});

test("external pasted text uses the same atomic creation/history without a live source item",async t => {
  const f = await fixture(t), before = await f.snapshot();
  const document = "A document paragraph with useful detail.\n\n".repeat(12000);
  const item = {schemaVersion:2,id:"clipboard-document",title:"A document paragraph with useful detail.",description:"",
    content:{kind:"text",text:document},revisions:[],review:{note:"",star:false},build:{state:"ready",message:""}};
  const clipboard = {version:1,workspaceId:before.workspaceId,placements:[{id:"clip-placement",itemId:item.id,x:0,y:0,width:420,height:340,z:0}],items:{[item.id]:item},boards:{}};
  const pasted = await f.op("pastePlacements",{clipboard,targetBoardId:f.target.boardId,targetPosition:{x:80,y:100}});
  assert.ok(pasted.history);
  assert.equal((await f.snapshot()).items.find(i => i.id === pasted.result.itemIds[0]).content.text,document);
  const undone = await f.op("restoreMovement",{history:pasted.history});
  assert.deepEqual((await f.snapshot()).boards.find(b => b.id === f.target.boardId).placements,before.boards.find(b => b.id === f.target.boardId).placements);
  await f.op("restoreMovement",{history:undone.history});
  assert.equal((await f.snapshot()).items.find(i => i.id === pasted.result.itemIds[0]).content.text,document);
});
