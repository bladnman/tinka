import test from 'node:test';
import assert from 'node:assert/strict';
import {newestBoardsFirst} from '../public/board-order.js';

test('creation ordering is newest first with stable ties and undated fallback, without mutation', () => {
  const entries = [
    {id:'unknown'}, {id:'alpha',createdAt:'2020-01-01'},
    {id:'invalid',createdAt:'invalid'}, {id:'zulu',createdAt:'2025-01-01'},
    {id:'tie',createdAt:'2025-01-01T00:00:00Z'}, {id:'empty',createdAt:''},
  ];
  const original = structuredClone(entries);
  assert.deepEqual(newestBoardsFirst(entries).map(b=>b.id), ['zulu','tie','alpha','unknown','invalid','empty']);
  entries[1].title='Renamed'; entries[1].updatedAt='2030-01-01'; entries[1].review={note:'A fresh edit'};
  assert.deepEqual(newestBoardsFirst(entries).map(b=>b.id), ['zulu','tie','alpha','unknown','invalid','empty']);
  assert.deepEqual(entries.map(({title,updatedAt,review,...b})=>b),original);
});

test('mixed Grid exchanges only child-board slots; other items and round groups stay in place', () => {
  const entries = [{id:'note'}, {id:'undated',board:true}, {id:'old',board:true,createdAt:'2020-01-01'},
    {id:'image'}, {id:'new',board:true,createdAt:'2025-01-01'}, {id:'text'}];
  assert.deepEqual(newestBoardsFirst(entries, b=>b.createdAt,b=>b.board).map(b=>b.id),
    ['note','new','old','image','undated','text']);
  const groups=[entries.slice(0,3),entries.slice(3)];
  assert.deepEqual(groups.map(g=>newestBoardsFirst(g,b=>b.createdAt,b=>b.board).map(b=>b.id)),
    [['note','old','undated'],['image','new','text']]);
});
