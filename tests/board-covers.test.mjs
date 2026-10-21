import test from 'node:test';
import assert from 'node:assert/strict';
import {boardCovers} from '../lib/board-covers.mjs';

test('collection covers follow visible review order and stop at four nonrecursive tiles',()=>{
  const items={owner:{id:'owner',title:'Collection'}};
  const placements=Array.from({length:8},(_,index)=>{
    items[`i${index}`]={id:`i${index}`,title:`Idea ${index}`,childBoardId:'nested'};
    return {id:`p${index}`,itemId:`i${index}`};
  });
  placements[1].removedAt=1;
  placements[2].archivedAt=1;
  items.i3.deletedAt=1;
  const boards={collection:{ownerItemId:'owner',placements,reviewOrder:['p7','p6']}};
  const before=JSON.stringify({boards,items});
  const cover=boardCovers(boards,items).collection;
  assert.equal(cover.count,5);
  assert.deepEqual(cover.tiles.map(tile=>tile.id),['p7','p6','p0','p4']);
  assert.ok(cover.tiles.every(tile=>tile.kind==='text'&&tile.board&&!tile.resource));
  assert.equal(JSON.stringify({boards,items}),before);
});

test('saved images win, local HTML keeps its viewport, external applications stay text',()=>{
  const local={rootId:'designs',path:'workup.html'},preview={rootId:'designs',path:'workup.png'};
  const items={owner:{id:'owner'},saved:{id:'saved',title:'Saved',preview:{resource:preview},content:{kind:'html',resource:local}},html:{id:'html',title:'HTML',content:{kind:'html',resource:local}},remote:{id:'remote',title:'Remote',content:{kind:'html',url:'https://example.org/',resource:local}},building:{id:'building',title:'Building',build:{state:'building'},content:{kind:'html',resource:local}}};
  const boards={collection:{ownerItemId:'owner',placements:['saved','html','remote','building'].map(id=>({id,itemId:id,presentation:{viewport:{width:440,height:620}}})),reviewOrder:[]}};
  const tiles=boardCovers(boards,items).collection.tiles;
  assert.equal(tiles[0].kind,'image');
  assert.deepEqual(tiles[0].resource,preview);
  assert.equal(tiles[1].kind,'html');
  assert.deepEqual(tiles[1].viewport,{width:440,height:620});
  assert.equal(tiles[2].kind,'text');
  assert.equal(tiles[3].kind,'text');
});
