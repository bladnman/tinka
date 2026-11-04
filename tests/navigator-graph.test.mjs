import test from 'node:test';
import assert from 'node:assert/strict';
import {navigationGraph,navigationRows} from '../public/navigator-graph.js';
const item=(id,childBoardId,extra={})=>({id,childBoardId,...extra});
const board=(id,itemIds=[])=>({id,title:id,ownerItemId:id,placements:itemIds.map(itemId=>({itemId}))});
test('navigator opens current ancestry and exposes shared references without duplicating subtrees',()=>{
 const graph=navigationGraph({homeBoardIds:['root'],items:[item('a','a'),item('b','b'),item('c','c')],boards:[board('root',['a','b']),board('a',['c']),board('b',['c']),board('c')]});
 assert.deepEqual(graph.paths.get('c'),['root','a','c']);assert.deepEqual(graph.parents.get('c'),['a','b']);
 const {rows}=navigationRows(graph,new Set(['root','a','b','c']),'c');assert.equal(rows.filter(row=>row.id==='c').length,2);assert.equal(rows.filter(row=>row.repeated).length,1);assert.equal(rows.filter(row=>row.current).length,2);
});
test('navigator remains finite for manually cyclic and disconnected metadata and respects archives',()=>{
 const graph=navigationGraph({homeBoardIds:[],items:[item('a','a'),item('b','b'),item('gone','gone',{archivedAt:true})],boards:[board('a',['b']),board('b',['a','gone']),board('gone'),board('orphan')]},[{id:'legacy',title:'Legacy'}]);
 assert.equal(graph.boards.has('gone'),false);assert.equal(graph.boards.get('legacy').legacy,true);assert.ok(graph.paths.has('a'));assert.ok(graph.paths.has('orphan'));
 const {rows}=navigationRows(graph,new Set(['a','b']),'b');assert.ok(rows.length<8);assert.ok(rows.some(row=>row.repeated));assert.equal(navigationRows(graph,new Set(['a','b']),'b',1).truncated,true);
});
