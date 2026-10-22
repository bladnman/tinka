import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../lib/config.mjs';
import {main} from '../cli.mjs';
import {boardCovers} from '../lib/board-covers.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {applyOperation,applyFileImport,readWorkspace} from '../lib/workspace.mjs';
import {IMPORT_LIMITS,prepareImport,sniffImport} from '../lib/file-import.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=','base64');
const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-file-import-'));
  const boards=path.join(root,'boards'),configPath=path.join(root,'config.json');
  await mkdir(boards);
  await main(['init','--config',configPath,'--boards',boards,'--label','Import fixture']);
  const config=await loadConfig(configPath);
  await applyOperation(config,{type:'createBoard',id:'ideas',title:'Ideas'});
  const workspace=await readWorkspace(config,{covers:false});
  const server=await listen(config,{port:0}),base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await closeAppServer(server);await rm(root,{recursive:true,force:true});});
  const metadata=(extra={})=>({workspaceId:workspace.workspaceId,targetBoardId:'ideas',targetPosition:{x:120,y:180},expectedRevision:1,operationId:'first-import',...extra});
  const upload=(data=metadata(),files=[{name:'photo.png',bytes:png}],headers={})=>{
    const form=new FormData();form.append('metadata',JSON.stringify(data));
    for(const file of files)form.append('files',new Blob([file.bytes],{type:file.type||'application/octet-stream'}),file.name);
    return fetch(base+'/api/imports',{method:'POST',headers:{'x-tinka-workspace':config.workspaceId,...headers},body:form});
  };
  return {root,boards,configPath,config,workspace,base,metadata,upload};
}

test('file imports preserve original bytes, safe names, one revision and one placement-only undo/redo',async t=>{
  const f=await fixture(t);
  const response=await f.upload(f.metadata({placements:[{x:0,y:0,width:320,height:250},{x:350,y:0,width:300,height:438}]}),[
    {name:'../../weird<script>.jpg',bytes:png,type:'text/html'},{name:'../../weird<script>.jpg',bytes:pdf,type:'image/png'}]);
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();assert.equal(result.revision,2);assert(result.history);
  assert.equal(result.result.itemIds.length,2);assert.equal(new Set(result.result.itemIds).size,2);
  assert.equal(result.result.resources.length,2);
  const after=await readWorkspace(f.config),board=after.boards.find(b=>b.id==='ideas');
  assert.equal(board.placements.length,2);assert.equal(board.placements[1].x,470);assert.equal(board.placements[1].height,438);
  assert.equal(board.placements[0].presentation.mode,'panel');
  assert.equal(after.items.find(i=>i.id===result.result.itemIds[0]).content.kind,'image');
  assert.equal(after.items.find(i=>i.id===result.result.itemIds[1]).content.kind,'pdf');
  const root=after.resourceRoots[result.result.resources[0].rootId];
  assert.equal(root.path,'../imports');assert(!JSON.stringify(after).includes(png.toString('base64')));
  for(const [index,resource] of result.result.resources.entries()){
    assert.match(resource.path,new RegExp(`^[a-f0-9]{32}/0${index+1}-[a-zA-Z0-9_-]+\\.${index?'pdf':'png'}$`));
    assert.deepEqual(await readFile(path.resolve(f.config.workspaceRoot,root.path,resource.path)),index?pdf:png);
    const served=await fetch(f.base+`/resources/${resource.rootId}/${resource.path}`,{headers:{range:'bytes=0-3'}});
    assert.equal(served.status,206);assert.deepEqual(Buffer.from(await served.arrayBuffer()),(index?pdf:png).subarray(0,4));
    assert.equal(served.headers.get('content-type'),index?'application/pdf':'image/png');
  }
  const cover=boardCovers(Object.fromEntries(after.boards.map(b=>[b.id,b])),Object.fromEntries(after.items.map(i=>[i.id,i])),['ideas']).ideas;
  const pdfTile=cover.tiles.find(tile=>tile.itemId===result.result.itemIds[1]);
  assert.equal(pdfTile.kind,'pdf');assert.deepEqual(pdfTile.viewport,{width:1000,height:1414});
  const replay=await f.upload(f.metadata({placements:[{x:0,y:0,width:320,height:250},{x:350,y:0,width:300,height:438}]}),[
    {name:'../../weird<script>.jpg',bytes:png},{name:'../../weird<script>.jpg',bytes:pdf}]);
  assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
  assert.equal((await readWorkspace(f.config)).revision,2);
  await applyOperation(f.config,{type:'review',itemId:result.result.itemIds[0],patch:{note:'Later review'}});
  const undo=await applyOperation(f.config,{type:'restoreMovement',history:result.history});
  assert.equal((await readWorkspace(f.config)).boards.find(b=>b.id==='ideas').placements.length,0);
  for(const resource of result.result.resources)assert((await readFile(path.join(f.boards,'imports',resource.path))).length);
  await applyOperation(f.config,{type:'restoreMovement',history:undo.history});
  const restored=await readWorkspace(f.config);
  assert.deepEqual(restored.boards.find(b=>b.id==='ideas').placements,board.placements);
  assert.equal(restored.items.find(i=>i.id===result.result.itemIds[0]).review.note,'Later review');
});

test('mixed or invalid batches never mutate metadata or write originals',async t=>{
  const f=await fixture(t),before=await readFile(path.join(f.config.workspaceRoot,'workspace.json'));
  for(const [metadata,files,status] of [
    [f.metadata(),[{name:'good.png',bytes:png},{name:'bad.png',bytes:Buffer.from('<svg></svg>')}],415],
    [f.metadata({placements:[{x:0,y:0,width:1,height:200}]}),[{name:'good.png',bytes:png}],400],
    [f.metadata({workspaceId:'other-workspace'}),[{name:'good.png',bytes:png}],403],
    [f.metadata({targetBoardId:'missing'}),[{name:'good.png',bytes:png}],404],
    [f.metadata({expectedRevision:0}),[{name:'good.png',bytes:png}],409],
    [f.metadata(),Array.from({length:21},()=>({name:'x.png',bytes:png})),400],
  ]){
    const response=await f.upload(metadata,files);assert.equal(response.status,status,await response.text());
    assert.deepEqual(await readFile(path.join(f.config.workspaceRoot,'workspace.json')),before);
    assert.deepEqual(await readdir(f.boards),['.tinka']);
  }
  assert.throws(()=>prepareImport(f.metadata(),[{name:'big.png',bytes:Buffer.alloc(IMPORT_LIMITS.fileBytes+1)}]),error=>error.status===413);
  assert.throws(()=>sniffImport(Buffer.from([255,216,255,0,0,0,0,0,0,0,0,0])),error=>error.status===415);
});

test('file endpoint enforces same-origin identity and keeps the ordinary JSON body limit',async t=>{
  const f=await fixture(t);
  for(const headers of [{'x-tinka-workspace':'other'},{origin:'https://example.org'},{'sec-fetch-site':'cross-site'}])
    assert.equal((await f.upload(f.metadata(),undefined,headers)).status,403);
  const settings=JSON.parse(await readFile(f.configPath));
  await writeFile(f.configPath,JSON.stringify({...settings,workspaceRoot:path.join(f.root,'changed')}));
  assert.equal((await f.upload()).status,403);
  await writeFile(f.configPath,JSON.stringify(settings));
  const json=await fetch(f.base+'/api/operations',{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':f.config.workspaceId},body:JSON.stringify({type:'createItem',item:{title:'x'.repeat(1000001)}})});
  assert.equal(json.status,413);
  const raw=await fetch(f.base+'/api/imports',{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':f.config.workspaceId},body:'{}'});
  assert.equal(raw.status,415);
  await assert.rejects(applyOperation(f.config,{type:'importFiles',...f.metadata()}),error=>error.status===400);
});

test('existing import root mappings and symlink paths fail closed without overwriting files',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');await mkdir(outside);
  await symlink(outside,path.join(f.boards,'imports'));
  assert.equal((await f.upload()).status,403);assert.deepEqual(await readdir(outside),[]);
  await rm(path.join(f.boards,'imports'));
  await mkdir(path.join(f.boards,'imports'));
  const batch=createHash('sha256').update(`${f.workspace.workspaceId}:first-import`).digest('hex').slice(0,32);
  await symlink(outside,path.join(f.boards,'imports',batch));
  assert.equal((await f.upload()).status,403);assert.deepEqual(await readdir(outside),[]);
  await rm(path.join(f.boards,'imports',batch));
  await applyOperation(f.config,{type:'updateWorkspace',patch:{resourceRoots:{imports:{path:path.relative(f.config.workspaceRoot,outside)}}}});
  assert.equal((await f.upload(f.metadata({expectedRevision:2}))).status,409);
  assert.equal((await readWorkspace(f.config)).resourceRoots.imports.path,path.relative(f.config.workspaceRoot,outside));
});

test('aborted intake and conflicting reused operation IDs leave no duplicate placements',async t=>{
  const f=await fixture(t),signal=AbortSignal.abort();
  await assert.rejects(applyFileImport(f.config,f.metadata(),[{name:'photo.png',bytes:png}],{signal}),error=>error.status===499);
  assert.deepEqual(await readdir(f.boards),['.tinka']);
  assert.equal((await f.upload()).status,200);
  const response=await f.upload(f.metadata({targetPosition:{x:200,y:200}}));
  assert.equal(response.status,409);
  assert.equal((await readWorkspace(f.config)).boards.find(b=>b.id==='ideas').placements.length,1);
});

test('multipart imports accept payloads above the ordinary JSON limit and reuse a matching root alias',async t=>{
  const f=await fixture(t);
  await applyOperation(f.config,{type:'updateWorkspace',patch:{resourceRoots:{projectImages:{path:'../imports'}}}});
  const largePdf=Buffer.concat([Buffer.from('%PDF-1.4\n%'),Buffer.alloc(1100000,32),Buffer.from('\n%%EOF\n')]);
  const response=await f.upload(f.metadata({expectedRevision:2}),[{name:'large.pdf',bytes:largePdf}]);
  assert.equal(response.status,200,await response.clone().text());
  const value=await response.json();assert.equal(value.result.resources[0].rootId,'projectImages');
  assert.deepEqual(await readFile(path.join(f.boards,'imports',value.result.resources[0].path)),largePdf);
  const seventeen=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(17*1024*1024),Buffer.from('\n%%EOF')]);
  assert.throws(()=>prepareImport(f.metadata(),Array.from({length:3},()=>({name:'big.pdf',bytes:seventeen}))),error=>error.status===413);
});

test('pre-existing file symlinks and differing bytes are retained and prevent the complete metadata commit',async t=>{
  const f=await fixture(t),batch=createHash('sha256').update(`${f.workspace.workspaceId}:first-import`).digest('hex').slice(0,32);
  const directory=path.join(f.boards,'imports',batch);await mkdir(directory,{recursive:true});
  const outside=path.join(f.root,'outside.png');await writeFile(outside,png);
  const target=path.join(directory,'02-second.pdf');await symlink(outside,target);
  await writeFile(path.join(directory,'01-first.png'),png);
  const files=[{name:'first.png',bytes:png},{name:'second.pdf',bytes:pdf}];
  assert.equal((await f.upload(f.metadata(),files)).status,409);
  assert.equal((await readWorkspace(f.config)).revision,1);
  assert.deepEqual(await readFile(path.join(directory,'01-first.png')),png,'existing originals survive a rejected batch');
  assert.deepEqual(await readFile(outside),png);
  await rm(target);await writeFile(target,'unrelated original');
  assert.equal((await f.upload(f.metadata(),files)).status,409);
  assert.equal(await readFile(target,'utf8'),'unrelated original');
  assert.equal((await readWorkspace(f.config)).boards.find(b=>b.id==='ideas').placements.length,0);
});
