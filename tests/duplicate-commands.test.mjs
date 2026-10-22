import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceBoard} from '../public/workspace-board.js';
import {MovementHistory} from '../public/movement-history.js';

test('duplicate captures current selection with deterministic offset and keeps the copy source intact', async () => {
  const saved = {placements:[{id:'a',x:-80,y:200},{id:'b',x:240,y:-40}],items:{a:{title:'Original'}}};
  const original = structuredClone(saved);
  const calls=[];
  const board = {
    clipboardBlocked:()=>false, history:{busy:false},copySnapshot:()=>saved,
    pasteClipboard:async source=>calls.push(source),
  };
  await WorkspaceBoard.prototype.duplicateSelection.call(board);
  assert.deepEqual(calls,[{kind:'duplicate',clipboard:saved,targetPosition:{x:-48,y:-8}}]);
  assert.deepEqual(saved,original);
  board.clipboardBlocked=()=>true;
  await WorkspaceBoard.prototype.duplicateSelection.call(board);
  board.clipboardBlocked=()=>false;
  board.history.busy=true;
  await WorkspaceBoard.prototype.duplicateSelection.call(board);
  assert.equal(calls.length,1);
});

test('duplicate participates in existing whole-group history and reciprocal redo labels',async t => {
  const prior=globalThis.sessionStorage;
  globalThis.sessionStorage={getItem:()=>null,setItem:()=>{}};
  t.after(()=>{globalThis.sessionStorage=prior;});
  const inverse={signature:'initial'}, reciprocal={signature:'redo'};
  const writes=[];
  const client={pendingWrites:0,write:async (...args)=>{writes.push(args);return {history:reciprocal,result:{}};}};
  const history=new MovementHistory(client,'fixture');
  history.record(inverse,{type:'duplicate',data:{clipboard:{placements:[{id:'a'},{id:'b'}]}}});
  assert.equal(history.label('undo'),'Duplicate 2 items');
  assert.equal(history.state.undo.length,1);
  assert.equal(history.state.redo.length,0);
  await history.replay('undo');
  assert.equal(writes[0][0],'restoreMovement');
  assert.deepEqual(writes[0][1],{history:inverse});
  assert.equal(history.state.undo.length,0);
  assert.equal(history.label('redo'),'Duplicate 2 items');
  assert.deepEqual(history.state.redo[0].history,reciprocal);
});

test('board-owned duplicate consumes repeat and busy defaults without mutating; native contexts retain defaults', t => {
  const prior=globalThis.document;
  let handler, busy=false, writes=0, editing=false, selected=true;
  globalThis.document={
    activeElement:{closest:()=>null,tagName:'DIV'},
    createElement:()=>({}),addEventListener:(_,fn)=>{handler=fn;},querySelector:()=>null,
  };
  t.after(()=>{globalThis.document=prior;});
  const board={
    boardCommandBlocked:()=>busy,clipboardCandidates:()=>selected?[{id:'a'}]:[],
    duplicateSelection:()=>{writes++;},
  };
  WorkspaceBoard.prototype.installBoardCommands.call(board,{append:()=>{}});
  const dispatch = (patch={}) => {
    const event={key:'d',metaKey:true,ctrlKey:false,altKey:false,shiftKey:false,repeat:false,
      target:{closest:()=>editing?{}:null},preventDefault(){this.defaultPrevented=true;},
      stopImmediatePropagation(){},...patch};
    handler(event);return !!event.defaultPrevented;
  };
  assert.equal(dispatch({repeat:true}),true);
  busy=true;
  assert.equal(dispatch(),true);
  assert.equal(writes,0);
  busy=false;
  assert.equal(dispatch(),true);
  assert.equal(writes,1);
  editing=true;
  assert.equal(dispatch({repeat:true}),false);
  editing=false;
  document.activeElement.tagName='IFRAME';
  assert.equal(dispatch(),false);
  document.activeElement.tagName='DIV';
  for(const patch of [{altKey:true},{shiftKey:true},{isComposing:true},{keyCode:229}])
    assert.equal(dispatch(patch),false);
  selected=false;
  assert.equal(dispatch(),false);
  assert.equal(writes,1);
});
