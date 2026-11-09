import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main} from '../cli.mjs';

// A brand-new project has no workspace yet. An agent following the docs must be
// able to make a board and put an item on it first try, and the older
// `board create` (a legacy folder there) must say how to reach the tools.
async function fresh(){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-fresh-board-'));
  const config=path.join(root,'local','config.json');
  await main(['init','--config',config,'--boards',path.join(root,'boards'),'--label','Fresh']);
  const tool=(name,input)=>main(['tools','call',name,'--config',config,'--json',JSON.stringify(input)]).then(JSON.parse);
  return {root,config,tool};
}

test('fresh project: tools call board.create then item.create succeeds',async()=>{
  const {root,tool}=await fresh();
  try{
    await tool('board.create',{id:'title-card',title:'Title card'});
    const created=await tool('item.create',{boardId:'title-card',item:{title:'A'}});
    assert.equal(created.result.boardId,'title-card');
    assert.equal((await tool('board.get',{boardId:'title-card'})).placements.length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('fresh project: legacy board create says so, and item.create names the way forward',async()=>{
  const {root,config,tool}=await fresh();
  try{
    assert.match(await main(['board','create','title-card','--config',config,'--title','Title card']),/legacy board folder.*tools call board\.create/s);
    // The trial's order: a workspace.update first initializes an empty workspace.
    await tool('workspace.update',{patch:{resourceRoots:{}}});
    await assert.rejects(tool('item.create',{boardId:'title-card',item:{title:'A'}}),error=>{
      assert.equal(error.status,404);
      assert.match(error.message,/"title-card" is a legacy board folder.*workspace migrate --config .* --dry-run, then --apply.*tools call board\.create/s);
      return true;
    });
    await assert.rejects(tool('item.create',{boardId:'missing',item:{title:'A'}}),/^Error: Board not found\.$/);
    await main(['workspace','migrate','--config',config,'--apply']);
    const created=await tool('item.create',{boardId:'title-card',item:{title:'A'}});
    assert.equal(created.result.boardId,'title-card');
  }finally{await rm(root,{recursive:true,force:true});}
});
