import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {applyOperation,readWorkspace} from '../lib/workspace.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'tinka-remove-history-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const config = {boardsRoot:path.join(directory,'boards')};
  await mkdir(path.join(config.boardsRoot,'assets'),{recursive:true});
  await writeFile(path.join(config.boardsRoot,'assets','keep.txt'),'Keep project resource\n');
  const op = (type,data={}) => applyOperation(config,{type,...data});
  await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
  const board = (await op('createBoard',{title:'Source'})).result;
  const other = (await op('createBoard',{title:'Other'})).result;
  const child = (await op('createBoard',{title:'Collection',parentBoardId:board.boardId})).result;
  await op('createItem',{boardId:child.boardId,item:{title:'Child retained'}});
  const a = (await op('createItem',{boardId:board.boardId,item:{title:'A',resources:[{rootId:'assets',path:'keep.txt'}]},placement:{x:-20,y:190,width:445,height:312,z:9,presentation:{mode:'panel',paper:'#abcdef',viewport:{width:800,height:600}}}})).result;
  const alias = (await op('reference',{sourceBoardId:board.boardId,placementIds:a.placementIds,targetBoardId:board.boardId})).result;
  await op('reference',{sourceBoardId:board.boardId,placementIds:a.placementIds,targetBoardId:other.boardId});
  const ids = [...child.placementIds,...a.placementIds,...alias.placementIds];
  await op('updateBoard',{boardId:board.boardId,patch:{reviewOrder:[...ids].reverse()}});
  return {config,op,board,other,child,a,ids,snapshot:()=>readWorkspace(config)};
}
const arrangements = s => s.boards.map(({id,placements,reviewOrder})=>({id,placements,reviewOrder}));

test('group removal is one signed step; undo/redo restore exact placements while later canonical metadata and references survive',async t => {
  const f=await fixture(t), before=await f.snapshot();
  const input={boardId:f.board.boardId,placementIds:f.ids,operationId:'remove-group'};
  const removed=await f.op('remove',input), after=await f.snapshot();
  assert.equal(removed.revision,before.revision+1);
  assert.equal(removed.history.boards.length,1);
  assert.equal(after.boards.find(b=>b.id===f.board.boardId).placements.filter(p=>p.removedAt).length,3);
  assert.deepEqual(after.items,before.items);
  const retry=await f.op('remove',input);
  assert.equal(retry.replayed,true);
  assert.deepEqual(retry.history,removed.history);
  await f.op('review',{itemId:f.a.itemId,patch:{note:'Later note',star:true}});
  await f.op('updateItem',{itemId:f.a.itemId,patch:{title:'Later title'}});
  const latest=await f.snapshot();
  const undo=await f.op('restoreMovement',{history:removed.history,expectedRevision:latest.revision});
  const restored=await f.snapshot();
  assert.deepEqual(arrangements(restored),arrangements(before));
  assert.deepEqual(restored.items,latest.items);
  assert.deepEqual(restored.homeBoardIds,before.homeBoardIds);
  const redo=await f.op('restoreMovement',{history:undo.history});
  assert.ok(redo.history);
  assert.deepEqual(arrangements(await f.snapshot()),arrangements(after));
  assert.deepEqual((await f.snapshot()).items,latest.items);
  assert.equal(await readFile(path.join(f.config.boardsRoot,'assets','keep.txt'),'utf8'),'Keep project resource\n');
});

test('invalid whole batches, stale revisions, replay conflicts and repeated removed placements never mutate state',async t => {
  const f=await fixture(t), before=await f.snapshot();
  for(const [placementIds,status] of [[[],400],[[f.ids[0],f.ids[0]],400],[[f.ids[0],'missing'],404]]) {
    await assert.rejects(()=>f.op('remove',{boardId:f.board.boardId,placementIds}),{status});
    assert.deepEqual(await f.snapshot(),before);
  }
  await assert.rejects(()=>f.op('remove',{boardId:f.board.boardId,placementIds:f.ids,expectedRevision:before.revision-1}),{status:409});
  assert.deepEqual(await f.snapshot(),before);
  const removed=await f.op('remove',{boardId:f.board.boardId,placementIds:[f.ids[0]]});
  const after=await f.snapshot();
  await assert.rejects(()=>f.op('remove',{boardId:f.board.boardId,placementIds:[f.ids[1],f.ids[0]]}),{status:404});
  assert.deepEqual(await f.snapshot(),after);
  await f.op('updatePlacement',{boardId:f.board.boardId,placementId:f.ids[1],patch:{x:300}});
  const conflict=await f.snapshot();
  await assert.rejects(()=>f.op('restoreMovement',{history:removed.history}),{status:409});
  assert.deepEqual(await f.snapshot(),conflict);
});
