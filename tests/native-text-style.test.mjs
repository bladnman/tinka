import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {callTool} from '../lib/tools.mjs';
import {applyOperation, getBoardSnapshot} from '../lib/workspace.mjs';

test('native Text styling survives tool and workspace writes, undo and board duplication', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tinka-text-style-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const config = {boardsRoot:path.join(directory, 'boards')};
  await mkdir(config.boardsRoot);
  const apply = (type, fields, boardId = 'ideas') => applyOperation(config, {type, boardId, ...fields});
  const tool = (name, fields) => callTool(config, name, {boardId:'ideas', ...fields});
  const board = (id = 'ideas') => getBoardSnapshot(config, id);

  await apply('createBoard', {id:'ideas', title:'Ideas'});
  const decoration = {
    id:'text', type:'text', text:'## Outline', x:20, y:40, width:300, height:220,
    color:'#fedcba', textSize:42, textFace:'serif', textFill:'paper',
    textBorder:{style:'dashed', color:'#12345678'}, textPadding:14,
  };
  await tool('decoration.create', {decoration});
  await apply('createDecoration', {decoration:{...decoration, id:'preset', textSize:'large'}});
  const region = {id:'sticky', type:'region', x:400, y:40, width:120, height:110, color:'#ffc', text:'Idea', textSize:'small'};
  const shape = {...region, id:'shape', shape:'diamond', textSize:10};
  await apply('createDecoration', {decoration:region});
  await tool('decoration.create', {decoration:shape});
  assert.deepEqual((await board()).decorations, [decoration, {...decoration, id:'preset', textSize:'large'}, region, shape]);

  const patch = {textSize:144, textFace:'mono', textFill:'#abcD', textBorder:{style:'solid'}, textPadding:0};
  const updated = await tool('decoration.update', {decorationId:'text', patch});
  assert.deepEqual((await board()).decorations[0], {...decoration, ...patch});
  const undo = await apply('restoreMovement', {history:updated.history});
  assert.deepEqual((await board()).decorations[0], decoration);
  await apply('restoreMovement', {history:undo.history});
  const current = await board();
  const noBorder = {...current.decorations[0], textBorder:null};
  const mixed = [noBorder, current.decorations[1], {...region, textSize:32}, shape];
  await tool('board.update', {patch:{decorations:mixed}});
  assert.deepEqual((await board()).decorations, mixed);
  const {result:{childBoardId}} = await apply('duplicate', {itemId:current.ownerItemId});
  assert.deepEqual((await board(childBoardId)).decorations, (await board()).decorations);
  assert.deepEqual((await board(childBoardId)).decorations[0], noBorder);

  const resized = await tool('decoration.update', {decorationId:'sticky', patch:{textSize:144}});
  assert.equal((await board()).decorations[2].textSize, 144);
  await apply('restoreMovement', {history:resized.history});
  assert.equal((await board()).decorations[2].textSize, 32);

  const before = await board();
  for (const invalid of [
    {textSize:9}, {textSize:145}, {textSize:10.5}, {textSize:'16'},
    {textFace:'system-ui'}, {textFill:'url(example.png)'}, {textPadding:65},
    {textBorder:{style:'dashed', color:'var(--ink)'}}, {textBorder:{style:'solid', width:2}},
    {textBorder:{}}, {textBackground:'blue'},
  ]) {
    await assert.rejects(apply('updateDecoration', {decorationId:'text', patch:invalid}), {status:400});
  }
  await assert.rejects(tool('decoration.update', {decorationId:'sticky', patch:{textSize:145}}), {status:400});
  for (const textSize of ['small', 24]) {
    await assert.rejects(apply('createDecoration', {decoration:{...region, id:'line', type:'line', textSize}}), {status:400});
  }
  await assert.rejects(apply('updateDecoration', {decorationId:'sticky', patch:{textBorder:null}}), {status:400});
  assert.equal((await board()).revision, before.revision);
});
