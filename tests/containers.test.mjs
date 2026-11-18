import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {callTool} from '../lib/tools.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';

const fields = {x:0,y:0,width:100,height:40,color:'#63724f'};
const label = (id,geom={}) => ({id,type:'text',text:`**Label ${id}**`,...fields,...geom});
const container = (id,children,settings={}) => ({id,type:'region',text:'',...fields,x:20,y:30,
  container:{layout:'vertical',children,...settings}});

test('creating a container with a blank Text block undoes and restores both identities together',async t=>{
  const {config,apply,read}=await fixture(t);
  const made=await callTool(config,'decoration.create',{boardId:'ideas',initialText:true,decoration:container('starter',[])});
  const {initialTextId}=made.result;
  const saved=await read();
  assert.deepEqual(saved.find(d=>d.id==='starter').container.children,[initialTextId]);
  assert.equal(saved.find(d=>d.id===initialTextId).text,'');
  const undone=await apply('restoreMovement',{history:made.history});
  assert.deepEqual(await read(),[]);
  await apply('restoreMovement',{history:undone.history});
  assert.deepEqual(await read(),saved);
  await assert.rejects(apply('createDecoration',{initialText:true,decoration:container('existing',[initialTextId])}),{status:400});
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(),'tinka-container-'));
  t.after(() => rm(home,{recursive:true,force:true}));
  const config = {boardsRoot:path.join(home,'boards'),port:43000};
  await mkdir(config.boardsRoot);
  const apply = (type,args={}) => applyOperation(config,{type,boardId:'ideas',...args});
  await apply('createBoard',{id:'ideas',title:'Ideas'});
  const root = path.join(config.boardsRoot,'.tinka');
  return {config,apply,root,read:async() => (await getBoardSnapshot(config,'ideas')).decorations};
}

test('containers keep a compact board file and run ordered vertical, horizontal and grid layout',async t => {
  const {config,root,read,apply} = await fixture(t);
  const children = ['one','two','three','four','five','six'];
  const labels = children.map((id,index) => label(id,{width:100+index,height:40+index}));
  await apply('updateBoard',{patch:{decorations:labels},operationId:'save-labels'});
  const file = path.join(root,'boards','ideas.json');
  const before = await readFile(file);
  const make = await callTool(config,'decoration.create',{boardId:'ideas',operationId:'make-container',
    decoration:container('labels',children)});
  assert.ok(make.history,'creation is one undo step');
  const after = await readFile(file);
  assert.ok(after.length < 3000,`expected six labels and one container below 3,000 bytes, got ${after.length}`);
  assert.ok(after.length - before.length < 512,`container metadata added ${after.length - before.length} bytes`);
  const saved = JSON.parse(after);
  assert.deepEqual(saved.decorations.find(entry=>entry.id==='labels').container,{layout:'vertical',children});
  for (const id of children) assert.equal(after.toString().split(`**Label ${id}**`).length,2,'body appears once');

  const box = id => read().then(entries => entries.find(entry=>entry.id===id));
  assert.deepEqual(await box('two'),{...labels[1],x:36,y:98});
  assert.equal((await box('labels')).height,347);
  await apply('updateDecoration',{decorationId:'labels',operationId:'horizontal',patch:{container:{layout:'horizontal',children,gap:6,padding:10}}});
  assert.deepEqual(await box('two'),{...labels[1],x:136,y:40});
  assert.equal((await box('labels')).width,665);
  const grid = await callTool(config,'decoration.update',{boardId:'ideas',decorationId:'labels',operationId:'grid',
    patch:{container:{layout:'grid',children,padding:8,gap:4,columns:2}}});
  assert.ok(grid.history);
  assert.deepEqual(await box('four'),{...labels[3],x:136,y:83});
  assert.equal((await box('labels')).width,229);
  assert.equal((await box('labels')).height,153);
  const metadata = await readFile(path.join(root,'workspace.json'));
  assert.ok(metadata.length < 32_000,`recent-operation receipts took ${metadata.length} bytes`);
  t.diagnostic(`Saved board ${before.length} → ${after.length} bytes (+${after.length-before.length}); workspace header ${metadata.length} bytes after creation and two layout changes.`);
});

test('reflow, attached arrows, moving, removal and undo retain independent children',async t => {
  const {config,apply,read} = await fixture(t);
  const a = label('a'), b = label('b');
  const arrow = {id:'connector',type:'line',...fields,text:'',from:{decorationId:'b',side:'right'},to:{x:350,y:200}};
  const simpleRegion = {id:'regular-region',type:'region',...fields,x:350,text:'Freeform'};
  await apply('updateBoard',{patch:{decorations:[a,b,arrow,simpleRegion]}});
  await apply('createDecoration',{decoration:container('group',['a','b'])});
  const initial = await read();
  const resized = await apply('updateDecoration',{decorationId:'a',patch:{text:'Longer\n\ncopy',height:90}});
  let after = await read();
  assert.equal(after.find(d=>d.id==='b').y,148);
  assert.equal(after.find(d=>d.id==='group').height,174);
  assert.deepEqual(after.find(d=>d.id==='connector').from.fallback,{x:136,y:118});
  const undoResize = await apply('restoreMovement',{history:resized.history});
  assert.deepEqual(await read(),initial);
  await apply('restoreMovement',{history:undoResize.history});

  await callTool(config,'decoration.create',{boardId:'ideas',containerId:'group',decoration:label('c')});
  const beforeMove = await read();
  const moved = await apply('translatePlacements',{placementIds:[],decorationIds:['group'],dx:31,dy:-25});
  after = await read();
  for (const id of ['a','b','c','group']) {
    const original=beforeMove.find(d=>d.id===id),saved=after.find(d=>d.id===id);
    assert.deepEqual([saved.x,saved.y],[original.x+31,original.y-25]);
  }
  assert.deepEqual(after.find(d=>d.id==='regular-region'),simpleRegion);
  await apply('restoreMovement',{history:moved.history});
  const removedChild = await apply('removeDecoration',{decorationId:'b'});
  after = await read();
  assert.deepEqual(after.find(d=>d.id==='group').container.children,['a','c']);
  assert.equal(after.find(d=>d.id==='c').y,148);
  await apply('restoreMovement',{history:removedChild.history});
  assert.deepEqual(await read(),beforeMove);

  const removedParent = await apply('remove',{placementIds:[],decorationIds:['group']});
  assert.deepEqual(await read(),beforeMove.filter(d=>d.id!=='group'));
  const restored = await apply('restoreMovement',{history:removedParent.history});
  assert.deepEqual(await read(),beforeMove);
  await apply('restoreMovement',{history:restored.history});
  await apply('updateDecoration',{decorationId:'a',patch:{height:91}});
  await assert.rejects(apply('restoreMovement',{history:removedParent.history}),{status:409});
});

test('membership validation rejects shared, missing, nested and arrow children atomically',async t => {
  const {apply,read} = await fixture(t);
  await apply('updateBoard',{patch:{decorations:[label('a'),{...label('arrow'),type:'line'}]}});
  await apply('createDecoration',{decoration:container('main',['a'])});
  const before = await read();
  for (const id of ['main','a','arrow','unknown']) {
    await assert.rejects(apply('createDecoration',{decoration:container('other',[id])}),{status:400});
  }
  await assert.rejects(apply('createDecoration',{decoration:label('bad'),containerId:'unknown'}),{status:404});
  assert.deepEqual(await read(),before);
});

test('a placement enters, reorders, transfers, resizes and leaves mixed containers with exact undo', async t => {
  const {config,apply,root} = await fixture(t);
  const first = label('label');
  const second = container('other',[],{layout:'horizontal'});
  const {result:{itemId,placementIds:[placementId]}} = await apply('createItem',{
    item:{id:'card',title:'Card',content:{kind:'note',text:'Canonical content'}},
    placement:{x:350,y:150,width:210,height:170},
  });
  const placementRef = {placementId};
  await apply('updateBoard',{patch:{decorations:[first,container('main',['label']),second]}});
  const read = () => getBoardSnapshot(config,'ideas');
  const before = await read();
  const box = (board,id) => board.decorations.find(entry => entry.id === id);
  const card = board => board.placements.find(entry => entry.id === placementId);
  const check = (actual,expected) => {
    assert.deepEqual(actual.placements,expected.placements);
    assert.deepEqual(actual.decorations,expected.decorations);
    assert.deepEqual(actual.reviewOrder,expected.reviewOrder);
  };

  const file = path.join(root,'boards','ideas.json'), originalBytes = (await readFile(file)).length;
  const added = await callTool(config,'container.moveMember',{boardId:'ideas',member:placementRef,containerId:'main',index:0});
  const inside = await read();
  assert.deepEqual(added.result,{boardId:'ideas',containerId:'main',member:placementRef});
  assert.deepEqual(box(inside,'main').container.children,[placementRef,'label']);
  assert.deepEqual(card(inside),{...card(before),x:36,y:46});
  assert.deepEqual([box(inside,'label').x,box(inside,'label').y],[36,228]);
  assert.deepEqual(inside.items[itemId],before.items[itemId]);
  const savedBytes = await readFile(file);
  assert.ok(savedBytes.length-originalBytes < 160,'adding a card stores a small occurrence reference');
  assert.equal(savedBytes.toString().split(placementId).length,4,'ID appears only as placement, review order and membership');

  const undo = await apply('restoreMovement',{history:added.history});
  check(await read(),before);
  await apply('restoreMovement',{history:undo.history});
  check(await read(),inside);

  const reordered = await apply('moveContainerMember',{member:placementRef,containerId:'main',index:1});
  assert.ok(reordered.history);
  assert.deepEqual(box(await read(),'main').container.children,['label',placementRef]);
  const transfer = await apply('moveContainerMember',{member:placementRef,containerId:'other'});
  const transferred = await read();
  assert.deepEqual(box(transferred,'main').container.children,['label']);
  assert.deepEqual(box(transferred,'other').container.children,[placementRef]);
  const resized = await apply('updatePlacement',{placementId,patch:{width:260,height:180}});
  const saved = await read();
  assert.deepEqual([box(saved,'other').width,box(saved,'other').height],[292,212]);
  await apply('restoreMovement',{history:resized.history});
  check(await read(),transferred);

  const released = await callTool(config,'container.moveMember',{boardId:'ideas',member:placementRef,containerId:null,x:710,y:-24});
  const loose = await read();
  assert.deepEqual(box(loose,'other').container.children,[]);
  assert.deepEqual(card(loose),{...card(transferred),x:710,y:-24});
  await apply('restoreMovement',{history:released.history});
  check(await read(),transferred);
  await assert.rejects(apply('restoreMovement',{history:reordered.history}),{status:409});
  await apply('restoreMovement',{history:transfer.history});
  assert.deepEqual(box(await read(),'main').container.children,['label',placementRef]);
});

test('container validation separates identity kinds, respects groups, and rejects invalid drops', async t => {
  const {config,apply} = await fixture(t);
  const {result:{placementIds:[placementId]}} = await apply('createItem',{item:{title:'First'}});
  const {result:{placementIds:[peerId]}} = await apply('createItem',{item:{title:'Second'}});
  const placementRef = {placementId};
  await apply('updateBoard',{patch:{decorations:[label(placementId),container('main',[])]}});
  const grouped = await apply('groupOccurrences',{placementIds:[placementId,peerId]});
  const move = op => apply('moveContainerMember',{member:placementRef,containerId:'main',...op});
  await assert.rejects(move(),{status:409});
  await assert.rejects(apply('updateDecoration',{decorationId:'main',patch:{container:{layout:'grid',children:[placementRef]}}}),{status:400});
  await apply('ungroupOccurrences',{groupId:grouped.result.groupId});
  await callTool(config,'decoration.update',{boardId:'ideas',decorationId:'main',
    patch:{container:{layout:'grid',children:[placementId,placementRef]}}});
  const before = await getBoardSnapshot(config,'ideas');
  await assert.rejects(apply('groupOccurrences',{placementIds:[placementId,peerId]}),{status:400});
  for (const args of [
    {index:255}, {index:null}, {member:{placementId,decorationId:placementId}}, {member:{placementId:'other-board'}},
    {containerId:null}, {containerId:null,x:0,y:0,index:0}, {containerId:'missing'},
  ]) {
    await assert.rejects(move(args));
  }
  await assert.rejects(apply('updateDecoration',{decorationId:'main',
    patch:{container:{layout:'horizontal',children:[placementRef,{...placementRef}]}}}),{status:400});
  const after = await getBoardSnapshot(config,'ideas');
  assert.deepEqual(after.placements,before.placements);
  assert.deepEqual(after.decorations,before.decorations);
  assert.equal(after.revision,before.revision);
});

test('container duplication remaps both kinds, and moving or removing a member cleans up membership atomically', async t => {
  const {config,apply} = await fixture(t);
  const {result:{itemId,placementIds:[placementId]}} = await apply('createItem',{
    item:{title:'Card'},placement:{x:240,y:70,width:200,height:180},
  });
  const raw = label('label');
  await apply('updateBoard',{patch:{decorations:[raw,container('main',[{placementId},'label'])]}});
  const read = () => getBoardSnapshot(config,'ideas');
  const before = await read();
  const copy = await apply('duplicateOccurrences',{placementIds:[],decorationIds:['main'],dx:350,dy:-10});
  const expanded = await read();
  const [copyPlacementId] = copy.result.placementIds;
  const copied = expanded.decorations.filter(entry => copy.result.decorationIds.includes(entry.id));
  const [newParent,newText] = [copied.find(entry => entry.container),copied.find(entry => entry.type === 'text')];
  assert.deepEqual(newParent.container.children,[{placementId:copyPlacementId},newText.id]);
  assert.equal(expanded.placements.find(entry => entry.id === copyPlacementId).itemId,itemId);
  assert.equal(newParent.x,before.decorations.find(entry => entry.id === 'main').x+350);
  await apply('restoreMovement',{history:copy.history});

  const beforeClone = await read();
  const cloned = await apply('duplicate',{itemId:beforeClone.ownerItemId});
  const clone = await getBoardSnapshot(config,cloned.result.childBoardId);
  const clonedCard = clone.placements.find(entry => entry.itemId === itemId);
  assert.ok(clonedCard && clonedCard.id !== placementId);
  assert.deepEqual(clone.decorations.find(entry => entry.id === 'main').container.children,[{placementId:clonedCard.id},'label']);

  await apply('createBoard',{id:'parent',title:'Parent'});
  const {result:{placementIds:[ownerPlacement]}} = await apply('reference',{itemIds:[cloned.result.itemId],targetBoardId:'parent'});
  const parent = await getBoardSnapshot(config,'parent');
  const clipboard = {
    version:1,workspaceId:parent.workspaceId,
    placements:[parent.placements.find(entry => entry.id === ownerPlacement)],
    items:{[cloned.result.itemId]:parent.items[cloned.result.itemId]},
    boards:{[clone.id]:parent.childBoards[clone.id]},
  };
  const pasted = await apply('pastePlacements',{targetBoardId:'parent',targetPosition:{x:990,y:50},clipboard});
  assert.ok(pasted.history);
  const pastedParent = await getBoardSnapshot(config,'parent');
  const pastedBoard = pastedParent.childBoards[pastedParent.items[pasted.result.itemIds[0]].childBoardId];
  const pastedCard = pastedBoard.placements.find(entry => entry.itemId === itemId);
  assert.ok(pastedCard && pastedCard.id !== clonedCard.id);
  assert.deepEqual(pastedBoard.decorations.find(entry => entry.id === 'main').container.children,[{placementId:pastedCard.id},'label']);

  const move = await apply('move',{sourceBoardId:'ideas',targetBoardId:'parent',placementIds:[placementId],targetPosition:{x:720,y:120}});
  const afterMove = await read();
  assert.deepEqual(afterMove.decorations.find(entry => entry.id === 'main').container.children,['label']);
  assert.equal(afterMove.decorations.find(entry => entry.id === 'label').y,46);
  await apply('restoreMovement',{history:move.history});
  assert.deepEqual((await read()).decorations,before.decorations);

  const remove = await apply('remove',{placementIds:[placementId]});
  assert.deepEqual((await read()).decorations.find(entry => entry.id === 'main').container.children,['label']);
  await apply('restoreMovement',{history:remove.history});
  assert.deepEqual((await read()).decorations,before.decorations);

  await apply('archiveItem',{itemIds:[itemId],archived:true});
  assert.deepEqual((await read()).decorations.find(entry => entry.id === 'main').container.children,['label']);
  await apply('archiveItem',{itemIds:[itemId],archived:false});
  assert.ok((await read()).placements.some(entry => entry.id === placementId && !entry.removedAt));
  assert.deepEqual((await read()).decorations.find(entry => entry.id === 'main').container.children,['label']);
  const contain = () => apply('moveContainerMember',{member:{placementId},containerId:'main'});
  await contain();
  await apply('archive',{placementIds:[placementId],archived:true});
  assert.deepEqual((await read()).decorations.find(entry => entry.id === 'main').container.children,['label']);
  await apply('archive',{placementIds:[placementId],archived:false});
  await contain();
  await apply('deleteItem',{itemIds:[itemId]});
  assert.deepEqual((await read()).decorations.find(entry => entry.id === 'main').container.children,['label']);
});
