import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {applyOperation, getBoardSnapshot} from '../lib/workspace.mjs';

const text = id => ({id,type:'text',text:id,x:20,y:30,width:100,height:40,color:'#63724f'});
const container = (id,children) => ({...text(id),type:'region',container:{layout:'vertical',children}});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(),'tinka-group-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const config = {boardsRoot:path.join(root,'boards')};
  await mkdir(config.boardsRoot);
  const apply = (type,args={}) => applyOperation(config,{type,boardId:'ideas',...args});
  const board = await apply('createBoard',{id:'ideas',title:'Ideas'});
  const addItem = async id => (await apply('createItem',{item:{id,title:id}})).result.placementIds[0];
  const read = (id='ideas') => getBoardSnapshot(config,id);
  const replay = history => apply('restoreMovement',{history});
  return {apply,addItem,read,board,replay};
}

test('group and ungroup store only memberships, flatten peers, and use one signed undo step',async t => {
  const {apply,addItem,read,replay} = await fixture(t);
  const first = await addItem('first'), second = await addItem('second');
  await apply('updateBoard',{patch:{decorations:[text('a'),text('b'),text('c'),text('d')]}});
  const initial = await read();
  assert.equal(initial.groups,undefined);
  const groupInput = {placementIds:[first],decorationIds:['a'],operationId:'group-first',expectedRevision:initial.revision};
  const created = await apply('groupOccurrences',groupInput);
  const duplicateRetry = await apply('groupOccurrences',groupInput);
  assert.equal(duplicateRetry.replayed,true);
  assert.deepEqual(duplicateRetry.history,created.history);
  await assert.rejects(apply('groupOccurrences',{...groupInput,decorationIds:['b']}),{status:409});
  await assert.rejects(apply('groupOccurrences',{...groupInput,operationId:'stale-group'}),{
    status:409,code:'WORKSPACE_REVISION_CHANGED',
  });

  await apply('groupOccurrences',{placementIds:[second],decorationIds:['b']});
  const before = await read();
  const merged = await apply('groupOccurrences',{placementIds:[first],decorationIds:['b']});
  assert.deepEqual(new Set(merged.result.placementIds),new Set([first,second]));
  assert.deepEqual(new Set(merged.result.decorationIds),new Set(['a','b']));
  const combined = await read();
  assert.deepEqual(combined.groups,[{
    id:merged.result.groupId,placementIds:merged.result.placementIds,decorationIds:merged.result.decorationIds,
  }]);
  for (const key of ['placements','decorations','reviewOrder','items']) assert.deepEqual(combined[key],initial[key]);

  await apply('groupOccurrences',{decorationIds:['c','d']});
  const independent = (await read()).groups.at(-1);
  const redo = await replay(merged.history);
  assert.deepEqual((await read()).groups,[...before.groups,independent]);
  await replay(redo.history);
  assert.deepEqual((await read()).groups,[...combined.groups,independent]);

  const broken = await apply('ungroupOccurrences',{groupId:merged.result.groupId});
  assert.deepEqual(broken.result,merged.result);
  assert.deepEqual((await read()).groups,[independent]);
  const ungroupAgain = await replay(broken.history);
  assert.deepEqual((await read()).groups,[...combined.groups,independent]);
  await replay(ungroupAgain.history);
  assert.deepEqual((await read()).groups,[independent]);
});

test('removal preserves group history and containers protect top-level group membership',async t => {
  const {apply,addItem,read,replay} = await fixture(t);
  const [first,second,third] = [await addItem('first'),await addItem('second'),await addItem('third')];
  await apply('updateBoard',{patch:{decorations:[text('a'),text('b'),text('c')]}});
  await apply('groupOccurrences',{placementIds:[first,second],decorationIds:['a']});
  const initial = await read();
  const removed = await apply('remove',{placementIds:[second]});
  assert.deepEqual((await read()).groups,[{...initial.groups[0],placementIds:[first]}]);
  const undo = await replay(removed.history);
  assert.deepEqual((await read()).groups,initial.groups);
  const removeAgain = await replay(undo.history);
  assert.deepEqual((await read()).groups,[{...initial.groups[0],placementIds:[first]}]);
  await replay(removeAgain.history);

  const beforeContainer = await read();
  await assert.rejects(apply('createDecoration',{decoration:container('box',['a','b'])}),{status:400});
  assert.equal((await read()).revision,beforeContainer.revision);
  const contained = await apply('createDecoration',{decoration:container('box',['b',{placementId:third}])});
  assert.deepEqual((await read()).groups,initial.groups);
  const containing = (await read()).revision;
  await assert.rejects(apply('groupOccurrences',{decorationIds:['b','c']}),{status:400});
  await assert.rejects(apply('groupOccurrences',{placementIds:[third],decorationIds:['c']}),{status:400});
  assert.equal((await read()).revision,containing);
  const groupedBox = await apply('groupOccurrences',{decorationIds:['box','c']});
  await assert.rejects(replay(contained.history),{status:409});
  assert.ok((await read()).groups.some(group => group.id === groupedBox.result.groupId));
  await replay(groupedBox.history);
  await replay(contained.history);
  assert.deepEqual((await read()).groups,initial.groups);

  await apply('removeDecoration',{decorationId:'a'});
  const dissolved = await apply('remove',{placementIds:[first]});
  assert.equal((await read()).groups,undefined);
  await replay(dissolved.history);
  assert.deepEqual((await read()).groups,[{...initial.groups[0],decorationIds:[]}]);
});

test('occurrence and board copies remap complete groups, and placement-only groups survive moves',async t => {
  const {apply,addItem,read,board,replay} = await fixture(t);
  const first = await addItem('first'), second = await addItem('second');
  await apply('updateBoard',{patch:{decorations:[text('child'),container('box',['child'])]}});
  const mixed = (await apply('groupOccurrences',{placementIds:[first],decorationIds:['box']})).result;
  const copied = await apply('duplicateOccurrences',{placementIds:[first],decorationIds:['box'],dx:48,dy:28});
  const afterCopy = await read();
  const copyGroup = afterCopy.groups.at(-1);
  assert.notEqual(copyGroup.id,mixed.groupId);
  assert.deepEqual(copyGroup.placementIds,copied.result.placementIds);
  const copiedBox = afterCopy.decorations.find(entry => copied.result.decorationIds.includes(entry.id) && entry.container);
  assert.deepEqual(copyGroup.decorationIds,[copiedBox.id]);
  assert.notEqual(copiedBox.container.children[0],'child');
  const redoCopy = await replay(copied.history);
  assert.equal((await read()).groups.length,1);
  await replay(redoCopy.history);
  assert.deepEqual((await read()).groups,afterCopy.groups);

  const partial = await apply('duplicateOccurrences',{placementIds:[first],dx:80,dy:80});
  assert.ok(!(await read()).groups.some(group => group.placementIds.includes(partial.result.placementIds[0])));
  const boardCopy = await apply('duplicate',{itemId:board.result.itemId});
  const copiedBoard = await read(boardCopy.result.childBoardId);
  assert.equal(copiedBoard.groups.length,2);
  assert.deepEqual(copiedBoard.groups[0].decorationIds,['box']);
  assert.notEqual(copiedBoard.groups[0].placementIds[0],first);
  assert.notEqual(copiedBoard.groups[0].id,mixed.groupId);

  await apply('createBoard',{id:'dest',title:'Destination'});
  await apply('reference',{itemIds:[board.result.itemId],targetBoardId:'dest'});
  const clipboardSource = await read('dest'), childBoard = await read();
  const clipboard = {version:1,workspaceId:clipboardSource.workspaceId,
    placements:clipboardSource.placements,items:{[board.result.itemId]:clipboardSource.items[board.result.itemId]},
    boards:{ideas:childBoard}};
  const pasted = await apply('pastePlacements',{targetBoardId:'dest',targetPosition:{x:70,y:80},clipboard});
  const pastedOwner = (await read('dest')).items[pasted.result.itemIds[0]];
  const pastedBoard = await read(pastedOwner.childBoardId);
  assert.equal(pastedBoard.groups.length,2);
  assert.deepEqual(pastedBoard.groups[0].decorationIds,['box']);
  assert.notEqual(pastedBoard.groups[0].placementIds[0],first);

  const third = await addItem('third');
  const cards = (await apply('groupOccurrences',{placementIds:[second,third]})).result;
  const move = await apply('move',{sourceBoardId:'ideas',targetBoardId:'dest',placementIds:[second,third]});
  assert.deepEqual((await read('dest')).groups[0].placementIds,move.result.placementIds);
  assert.ok(!(await read()).groups.some(group => group.id === cards.groupId));
  await replay(move.history);
  assert.deepEqual((await read()).groups.at(-1),{id:cards.groupId,placementIds:[second,third],decorationIds:[]});
  assert.equal((await read('dest')).groups,undefined);
});

test('older movement receipts can replay except when they would strand a newer group',async t => {
  const {apply,read,replay} = await fixture(t);
  const oldCreate = await apply('createDecoration',{decoration:text('a')});
  assert.equal(oldCreate.history.boards[0].groupIds,undefined);
  await apply('createDecoration',{decoration:text('b')});
  await apply('createDecoration',{decoration:text('other')});
  const oldMove = await apply('updateDecoration',{decorationId:'other',patch:{x:500}});
  const group = (await apply('groupOccurrences',{decorationIds:['a','b']})).result;
  const before = await read();
  await assert.rejects(replay(oldCreate.history),{status:409});
  assert.equal((await read()).revision,before.revision);
  await replay(oldMove.history);
  assert.deepEqual((await read()).groups,before.groups);
  await apply('ungroupOccurrences',{groupId:group.groupId});
  await replay(oldCreate.history);
  assert.ok(!(await read()).decorations.some(entry => entry.id === 'a'));
});
