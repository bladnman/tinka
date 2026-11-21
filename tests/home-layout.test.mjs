import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {applyOperation,readWorkspace,workspaceView} from '../lib/workspace.mjs';
test('optional Home geometry preserves memberships, rejects stale saves and invalid geometry',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-home-layout-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config={boardsRoot:path.join(root,'boards')};await mkdir(config.boardsRoot);
  const created=await applyOperation(config,{type:'createBoard',title:'Ideas'}),id=created.result.boardId;
  const before=await readWorkspace(config);assert.equal(before.homeLayout,undefined);
  const layout={[id]:{x:40,y:80,width:320,height:300}};
  await applyOperation(config,{type:'updateWorkspace',patch:{homeLayout:layout},expectedRevision:before.revision});
  const saved=await readWorkspace(config),home=await workspaceView(config,'home');
  assert.deepEqual(saved.homeBoardIds,before.homeBoardIds);assert.deepEqual(home.homeLayout,layout);assert.deepEqual(saved.boards,before.boards);
  await assert.rejects(applyOperation(config,{type:'updateWorkspace',patch:{homeLayout:{}},expectedRevision:before.revision}),error=>error.status===409);
  for(const box of [{x:-1,y:0,width:320,height:300},{x:0,y:0,width:0,height:300},{x:0,y:0,width:320,height:300,extra:true}])
    await assert.rejects(applyOperation(config,{type:'updateWorkspace',patch:{homeLayout:{[id]:box}}}),error=>error.status===400);
  await applyOperation(config,{type:'updateWorkspace',patch:{homeBoardIds:saved.homeBoardIds}});
  assert.deepEqual((await readWorkspace(config)).homeLayout,layout,'older clients changing known fields retain the optional layout');
});
