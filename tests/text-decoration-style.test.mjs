import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {callTool} from '../lib/tools.mjs';
import {applyOperation, getBoardSnapshot} from '../lib/workspace.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tinka-text-sizing-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const config = {boardsRoot:path.join(directory, 'boards')};
  await mkdir(config.boardsRoot);
  const boardId = 'canvas';
  const apply = (type, fields) => applyOperation(config, {type, boardId, ...fields});
  const tool = (name, fields) => callTool(config, name, {boardId, ...fields});
  await apply('createBoard', {id:boardId, title:'Canvas'});
  return {apply, tool, read:() => getBoardSnapshot(config, boardId)};
}

const base = {type:'text', id:'title', text:'Heading', x:20, y:30, width:240, height:48, color:'#123'};

test('Text sizing is stored with text and geometry and survives occurrence copy and undo', async t => {
  const {apply, tool, read} = await fixture(t);
  const initial = {...base, textSizing:'auto'};
  const legacy = {...base, id:'legacy'};
  await tool('decoration.create', {decoration:initial});
  await apply('createDecoration', {decoration:legacy});
  assert.deepEqual((await read()).decorations, [initial, legacy]);

  const measured = {text:'A longer heading', textSize:36, height:90};
  const fitted = await tool('decoration.update', {decorationId:base.id, patch:measured});
  const afterFit = {...initial, ...measured};
  assert.deepEqual((await read()).decorations[0], afterFit);
  const inverse = await apply('restoreMovement', {history:fitted.history});
  assert.deepEqual((await read()).decorations[0], initial);
  await apply('restoreMovement', {history:inverse.history});

  const fixed = {width:180, height:64, textSizing:'fixed'};
  await tool('decoration.update', {decorationId:base.id, patch:fixed});
  const manuallySized = {...afterFit, ...fixed};
  const copy = await apply('duplicateOccurrences', {
    placementIds:[], decorationIds:[base.id], dx:50, dy:20,
  });
  const copied = {...manuallySized, id:copy.result.decorationIds[0], x:70, y:50};
  assert.deepEqual((await read()).decorations, [manuallySized, legacy, copied]);
  const undoneCopy = await apply('restoreMovement', {history:copy.history});
  assert.deepEqual((await read()).decorations, [manuallySized, legacy]);
  await apply('restoreMovement', {history:undoneCopy.history});
  await tool('board.update', {patch:{decorations:[manuallySized, legacy, copied]}});
  assert.deepEqual((await read()).decorations, [manuallySized, legacy, copied]);
});

test('Text sizing rejects unknown modes and non-Text decorations without a write', async t => {
  const {apply, tool, read} = await fixture(t);
  const region = {...base, id:'region', type:'region'};
  await apply('createDecoration', {decoration:base});
  await apply('createDecoration', {decoration:region});
  const before = await read();
  await assert.rejects(tool('decoration.create', {decoration:{...base, id:'invalid', textSizing:'fit'}}), {status:400});
  await assert.rejects(apply('updateDecoration', {decorationId:base.id, patch:{textSizing:null}}), {status:400});
  await assert.rejects(tool('decoration.update', {decorationId:region.id, patch:{textSizing:'auto'}}), {status:400});
  await assert.rejects(apply('createDecoration', {decoration:{...region, id:'invalid', textSizing:'fixed'}}), {status:400});
  assert.equal((await read()).revision, before.revision);
  assert.deepEqual((await read()).decorations, [base, region]);
});
