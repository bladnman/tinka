import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp,mkdir,readFile,realpath,symlink,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {discoverBoards,updateBuildState} from '../lib/boards.mjs';
import {ownedProcess,runtimePaths,stopManaged} from '../lib/runtime.mjs';
import {listen} from '../server.mjs';

let temporary,configPath,boardsRoot,boardRoot,config,server,base;
before(async()=>{
  temporary=await mkdtemp(path.join(os.tmpdir(),'board-room-test-'));
  configPath=path.join(temporary,'settings','board-room.config.json');
  boardsRoot=path.join(temporary,'boards');
  await main(['init','--config',configPath,'--boards',boardsRoot,'--port','43821','--title','Test Boards']);
  await main(['board','create','sample','--config',configPath,'--title','A sample','--description','For tests']);
  boardRoot=path.join(boardsRoot,'sample');
  await mkdir(path.join(boardRoot,'rounds','first','alpha'),{recursive:true});
  await writeFile(path.join(boardRoot,'rounds','first','alpha','index.html'),'<h1>Alpha</h1>');
  await writeFile(path.join(boardRoot,'rounds.json'),JSON.stringify({rounds:[{id:'first',date:'2026-10-14',number:1,title:'Round',description:'',concepts:[{id:'alpha',number:1,name:'Alpha',category:'test',description:'',question:'',hint:'',tone:''}]}],revisions:{}}));
  config=await loadConfig(configPath);
  server=await listen(config,{port:0});
  base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(temporary)await rm(temporary,{recursive:true,force:true});});
const json=async url=>(await fetch(`${base}${url}`)).json();

test('CLI creates external config and board, refusing overwrite',async()=>{
  const saved=JSON.parse(await readFile(configPath,'utf8'));
  assert.equal(saved.boardsRoot,await realpath(boardsRoot));
  assert.equal((await json('/api/config')).title,'Test Boards');
  await assert.rejects(main(['init','--config',configPath,'--boards',boardsRoot,'--port','43821']),/exist/);
  await assert.rejects(main(['board','create','sample','--config',configPath,'--title','Again']),/exist/);
});
test('discovery and board manifest use only immediate declared boards',async()=>{
  const discovered=await discoverBoards(config);
  assert.equal(discovered.boards.length,1);
  assert.equal(discovered.boards[0].conceptCount,1);
  assert.equal(discovered.boards[0].roundCount,1);
  const response=await json('/api/boards/sample');
  assert.equal(response.rounds[0].concepts[0].id,'alpha');
  assert.equal(response.title,'A sample');
});
test('status update is atomic and build state is explicit',async()=>{
  const results=await Promise.all([
    updateBuildState(config,'sample','first/alpha','building','Editing the first section.'),
    updateBuildState(config,'sample','first/alpha','review','Ready for review.')
  ]);
  assert.equal(results.length,2);
  const disk=JSON.parse(await readFile(path.join(boardRoot,'build-state.json'),'utf8'));
  assert(['building','review'].includes(disk.concepts['first/alpha'].state));
  assert.equal(disk.concepts['first/alpha'].message, disk.concepts['first/alpha'].state==='review'?'Ready for review.':'Editing the first section.');
  await updateBuildState(config,'sample','first/alpha','review','Ready for review.');
  assert.equal((await json('/api/boards')).boards[0].buildingCount,0);
  await assert.rejects(updateBuildState(config,'sample','first/unknown','ready','Done.'),/Unknown concept/);
});
test('notes save and load with same-origin checks and a size bound',async()=>{
  const url=`${base}/api/boards/sample/notes`;
  const denied=await fetch(url,{method:'PUT',headers:{origin:'https://example.com','content-type':'application/json'},body:'{}'});
  assert.equal(denied.status,403);
  const stale=await fetch(url,{method:'PUT',headers:{origin:base,'content-type':'application/json','x-tinka-workspace':'another-workspace'},body:'{}'});
  assert.equal(stale.status,403);
  const accepted=await fetch(url,{method:'PUT',headers:{origin:base,'content-type':'application/json','x-tinka-workspace':config.workspaceId},body:JSON.stringify({'first/alpha':{note:'Useful',star:true,updatedAt:42},'bad/key/extra':{note:'ignore'}})});
  assert.equal(accepted.status,200);
  const notes=await json('/api/boards/sample/notes');
  assert.deepEqual(Object.keys(notes),['first/alpha']);
  assert.equal(notes['first/alpha'].note,'Useful');
});
test('preview rejects dotfiles, escaping symlinks, and unsafe IDs',async()=>{
  const good=await fetch(`${base}/boards/sample/files/rounds/first/alpha/index.html`);
  assert.equal(good.status,200);
  assert.match(await good.text(),/Alpha/);
  assert.equal((await fetch(`${base}/boards/sample/files/.state/notes.json`)).status,403);
  await writeFile(path.join(temporary,'secret.txt'),'private');
  await symlink(path.join(temporary,'secret.txt'),path.join(boardRoot,'outside.txt'));
  assert.equal((await fetch(`${base}/boards/sample/files/outside.txt`)).status,403);
  await symlink(temporary,path.join(boardsRoot,'escape'));
  assert.equal((await fetch(`${base}/boards/escape/files/secret.txt`)).status,403);
  assert.equal((await fetch(`${base}/boards/Invalid/`)).status,400);
});
test('byte ranges clamp oversize ends and reject invalid suffixes',async()=>{
  const file='/boards/sample/files/rounds/first/alpha/index.html';
  const entire=await (await fetch(`${base}${file}`)).text();
  const clamped=await fetch(`${base}${file}`,{headers:{range:'bytes=0-999999'}});
  assert.equal(clamped.status,206);
  assert.equal(clamped.headers.get('content-range'),`bytes 0-${Buffer.byteLength(entire)-1}/${Buffer.byteLength(entire)}`);
  assert.equal(Number(clamped.headers.get('content-length')),Buffer.byteLength(entire));
  assert.equal(await clamped.text(),entire);
  assert.equal((await fetch(`${base}${file}`,{headers:{range:'bytes=-0'}})).status,416);
  assert.equal((await fetch(`${base}${file}`,{headers:{range:'bytes=999999-'}})).status,416);
});
test('live hashes distinguish status, concept source, and shell',async()=>{
  const first=await json('/api/boards/sample/live');
  await updateBuildState(config,'sample','first/alpha','ready','Reviewed and ready.');
  await new Promise(resolve=>setTimeout(resolve,800));
  const second=await json('/api/boards/sample/live');
  assert.notEqual(first.revision,second.revision);
  assert.equal(first.shellRevision,second.shellRevision);
  assert.equal(first.concepts['first/alpha'].revision,second.concepts['first/alpha'].revision);
  await writeFile(path.join(boardRoot,'rounds','first','alpha','index.html'),'<h1>Alpha changed</h1>');
  await new Promise(resolve=>setTimeout(resolve,800));
  const third=await json('/api/boards/sample/live');
  assert.notEqual(second.concepts['first/alpha'].revision,third.concepts['first/alpha'].revision);
  assert.equal(second.manifestRevision,third.manifestRevision);
  assert.equal((await json('/api/boards')).shellRevision,third.shellRevision);
});
test('custom folders, dependencies, and outside-round variants affect the right revision',async()=>{
  const manifest=JSON.parse(await readFile(path.join(boardRoot,'rounds.json'),'utf8'));
  manifest.rounds[0].concepts.push({id:'custom',name:'Custom',path:'experiments/custom/index.html',dependencies:['resources/theme.css']});
  manifest.revisions['first/alpha']=[{id:'alternate',name:'Alternate',path:'alternates/alpha/index.html'}];
  await writeFile(path.join(boardRoot,'rounds.json'),JSON.stringify(manifest));
  await mkdir(path.join(boardRoot,'experiments','custom'),{recursive:true});
  await mkdir(path.join(boardRoot,'alternates','alpha'),{recursive:true});
  await mkdir(path.join(boardRoot,'resources'),{recursive:true});
  await writeFile(path.join(boardRoot,'experiments','custom','index.html'),'<h1>Custom</h1>');
  await writeFile(path.join(boardRoot,'experiments','custom','app.js'),'const value = 1;');
  await writeFile(path.join(boardRoot,'alternates','alpha','index.html'),'<h1>Alternate</h1>');
  await writeFile(path.join(boardRoot,'alternates','alpha','style.css'),'body { color: red; }');
  await writeFile(path.join(boardRoot,'resources','theme.css'),'body { color: blue; }');
  await new Promise(resolve=>setTimeout(resolve,800));
  const before=await json('/api/boards/sample/live');
  const discovered=await json('/api/boards');
  assert.equal(discovered.boards[0].conceptCount,2);
  assert.equal(discovered.boards[0].revisionCount,1);
  await writeFile(path.join(boardRoot,'experiments','custom','app.js'),'const value = 2;');
  await new Promise(resolve=>setTimeout(resolve,800));
  const afterSibling=await json('/api/boards/sample/live');
  assert.notEqual(before.concepts['first/custom'].revision,afterSibling.concepts['first/custom'].revision);
  assert.equal(before.concepts['first/alpha'].revision,afterSibling.concepts['first/alpha'].revision);
  await writeFile(path.join(boardRoot,'alternates','alpha','style.css'),'body { color: green; }');
  await new Promise(resolve=>setTimeout(resolve,800));
  const afterVariant=await json('/api/boards/sample/live');
  assert.notEqual(afterSibling.concepts['first/alpha'].revision,afterVariant.concepts['first/alpha'].revision);
  await writeFile(path.join(boardRoot,'resources','theme.css'),'body { color: purple; }');
  await new Promise(resolve=>setTimeout(resolve,800));
  const afterDependency=await json('/api/boards/sample/live');
  assert.notEqual(afterVariant.concepts['first/custom'].revision,afterDependency.concepts['first/custom'].revision);
});
test('stop refuses a PID record that cannot prove ownership',async()=>{
  const pid=runtimePaths(config).pid;
  await writeFile(pid,JSON.stringify({pid:process.pid,configPath:config.configPath,token:'00000000-0000-0000-0000-000000000000'}));
  assert.equal(await ownedProcess(JSON.parse(await readFile(pid,'utf8')),config),false);
  await assert.rejects(stopManaged(config),/ownership/);
});
test('managed start and stop own only their recorded process',async()=>{
  const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const directory=path.join(temporary,'managed');
  const managedConfig=path.join(directory,'settings.json');
  await main(['init','--config',managedConfig,'--boards',path.join(directory,'boards'),'--port',String(port)]);
  const cfg=await loadConfig(managedConfig);
  try{
    assert.match(await main(['start','--config',managedConfig]),/started/);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).app,'board-room');
    assert.match(await main(['stop','--config',managedConfig]),/stopped/);
  }finally{
    const record=await readFile(runtimePaths(cfg).pid,'utf8').catch(()=>null);
    if(record){try{await stopManaged(cfg);}catch{}}
  }
});
