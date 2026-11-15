import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../lib/config.mjs';
import {main} from '../cli.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {applyOperation,readWorkspace} from '../lib/workspace.mjs';

test('board documents create a markdown item, save text back and reject non-documents',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-board-document-'));
  const boards=path.join(root,'boards'),configPath=path.join(root,'config.json');
  await mkdir(boards);
  await main(['init','--config',configPath,'--boards',boards,'--label','Document fixture']);
  const config=await loadConfig(configPath);
  await applyOperation(config,{type:'createBoard',id:'ideas',title:'Ideas'});
  const workspace=await readWorkspace(config,{covers:false});
  const server=await listen(config,{port:0}),base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await closeAppServer(server);await rm(root,{recursive:true,force:true});});
  const call=(method,url,body)=>fetch(base+url,{method,headers:{'content-type':'application/json','x-tinka-workspace':config.workspaceId},body:JSON.stringify(body)});

  const created=await call('POST','/api/documents',{workspaceId:workspace.workspaceId,targetBoardId:'ideas',targetPosition:{x:40,y:60},expectedRevision:workspace.revision,operationId:'doc-1'});
  assert.equal(created.status,200,await created.clone().text());
  const {revision,result,history}=await created.json();
  assert.equal(revision,workspace.revision+1);assert(history);
  const after=await readWorkspace(config),item=after.items.find(i=>i.id===result.itemIds[0]);
  assert.equal(item.content.kind,'markdown');assert.equal(item.title,'Untitled');
  const placement=after.boards.find(b=>b.id==='ideas').placements.find(p=>p.id===result.placementIds[0]);
  assert.deepEqual([placement.x,placement.y],[40,60]);
  const file=path.resolve(config.workspaceRoot,after.resourceRoots[item.content.resource.rootId].path,item.content.resource.path);
  assert.match(item.content.resource.path,/\.md$/);
  assert.equal(await readFile(file,'utf8'),'# Untitled\n\n');

  const saved=await call('PUT',`/api/documents/${item.id}`,{text:'# Plan\n\n- one\n'});
  assert.equal(saved.status,200,await saved.clone().text());
  assert.equal(await readFile(file,'utf8'),'# Plan\n\n- one\n');
  const served=await fetch(base+`/resources/${item.content.resource.rootId}/${item.content.resource.path}`);
  assert.equal(await served.text(),'# Plan\n\n- one\n');

  const note=await applyOperation(config,{type:'createItem',boardId:'ideas',item:{title:'Note',content:{kind:'note',text:'x'}}});
  const noteId=note.result.itemId||note.result.itemIds?.[0]||note.result.id;
  assert.equal((await call('PUT',`/api/documents/${noteId}`,{text:'x'})).status,400);
  assert.equal((await call('PUT',`/api/documents/${item.id}`,{text:5})).status,400);
  assert.equal((await call('PUT','/api/documents/missing-item',{text:'x'})).status,404);
  // Multipart imports still refuse markdown: the flag is internal to the document route.
  const form=new FormData();form.append('metadata',JSON.stringify({workspaceId:workspace.workspaceId,targetBoardId:'ideas',targetPosition:{x:0,y:0},expectedRevision:revision+2,operationId:'md-upload'}));
  form.append('files',new Blob(['# hi\n'],{type:'text/markdown'}),'x.md');
  assert.equal((await fetch(base+'/api/imports',{method:'POST',headers:{'x-tinka-workspace':config.workspaceId},body:form})).status,415);
});
