import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,cp} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {main} from '../cli.mjs';
import {loadConfig,PORT_ATTEMPTS,PORT_MIN,PORT_MAX,portCandidates,verifiedURL} from '../lib/config.mjs';
import {listen} from '../server.mjs';
import {callTool} from '../lib/tools.mjs';
import {withLinks} from '../lib/links.mjs';
import {readRuntime,stopManaged} from '../lib/runtime.mjs';
import {buildRelease} from '../scripts/package.mjs';
import {installArchive} from '../skill/tinka/scripts/install.mjs';
const exec=promisify(execFile);
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const get=async(url,resource='api/health')=>(await fetch(new URL(resource,url))).json();
async function fixture(t){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'tinka-instances-')));
  const managed=[];
  t.after(async()=>{
    for(const {app,config} of managed)await exec(process.execPath,[path.join(app,'cli.mjs'),'stop','--config',config]).catch(()=>{});
    await rm(root,{recursive:true,force:true});
  });
  return {root,managed};
}
async function init(root,name,port){
  const config=path.join(root,name,'tinka.config.json');
  await main(['init','--config',config,'--boards',path.join(root,name,'boards'),'--label',name]);
  if(port){const data=await read(config);await writeFile(config,JSON.stringify({...data,port}));}
  return config;
}
async function occupied(t){
  for(let attempt=0;attempt<40;attempt++){
    const server=net.createServer();
    const port=20000+Math.floor(Math.random()*20000);
    const bound=await new Promise((resolve,reject)=>{
      server.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(error));
      server.listen(port,'127.0.0.1',()=>resolve(true));
    });
    if(bound){t.after(()=>new Promise(resolve=>server.close(resolve)));return port;}
  }
  throw new Error('Could not reserve a collision fixture with a complete legal fallback range.');
}

test('two installations resolve simultaneous collisions and isolate replacement, notes, identity and shutdown',async t=>{
  const {root,managed}=await fixture(t);
  const blocked=await occupied(t);
  const release=await buildRelease({outDir:path.join(root,'release')});
  const archive={zipBytes:await readFile(release.appZip),checksumText:await readFile(release.appChecksum,'utf8'),zipName:path.basename(release.appZip)};
  const instances=[];
  for(const label of ['Glade','Runway']){
    const app=path.join(root,label,'app');
    await installArchive({...archive,installDir:app});
    const config=await init(root,label,blocked);
    managed.push({app,config});
    await exec(process.execPath,[path.join(app,'cli.mjs'),'board','create','same-slug','--title','Same board','--config',config]);
    instances.push({app,config});
  }
  const reports=await Promise.all(instances.map(({app,config})=>exec(process.execPath,[path.join(app,'cli.mjs'),'start','--config',config])));
  for(let i=0;i<instances.length;i++){
    const instance=instances[i];instance.saved=await read(instance.config);
    instance.url=`http://127.0.0.1:${instance.saved.port}/`;
    instance.health=await get(instance.url);
    assert(reports[i].stdout.includes(instance.url));
    assert.equal(instance.health.projectLabel,i===0?'Glade':'Runway');
    assert.notEqual(instance.saved.port,blocked);
    assert(instance.saved.port>=PORT_MIN&&instance.saved.port<=PORT_MAX);
    assert.match(reports[i].stdout,new RegExp(`Port ${blocked} was already in use.*new port ${instance.saved.port} is saved`));
    const response=await fetch(new URL('api/boards/same-slug/notes',instance.url),{method:'PUT',headers:{'content-type':'application/json','x-tinka-workspace':instance.health.workspaceId},body:JSON.stringify({'first/item':{note:instance.health.projectLabel,updatedAt:1}})});
    assert.equal(response.status,200);
  }
  const [a,b]=instances;
  assert.notEqual(a.url,b.url);assert.notEqual(a.health.workspaceId,b.health.workspaceId);
  const bRuntime=await read(`${b.config}.pid.json`);
  const configBefore=await readFile(a.config,'utf8');
  const notesBefore=await readFile(path.join(a.saved.boardsRoot,'same-slug','.state','notes.json'),'utf8');
  const replacement=await installArchive({...archive,installDir:a.app,configPath:a.config});
  assert(replacement.restarted);assert(replacement.backup);
  assert.equal(await readFile(a.config,'utf8'),configBefore);
  assert.equal(await readFile(path.join(a.saved.boardsRoot,'same-slug','.state','notes.json'),'utf8'),notesBefore);
  assert.equal((await get(a.url)).workspaceId,a.health.workspaceId);
  assert.equal((await get(b.url,'api/boards/same-slug/notes'))['first/item'].note,'Runway');
  assert.deepEqual(await read(`${b.config}.pid.json`),bRuntime);
  await exec(process.execPath,[path.join(a.app,'cli.mjs'),'stop','--config',a.config]);
  assert.equal((await get(b.url)).projectLabel,'Runway');
  await exec(process.execPath,[path.join(a.app,'cli.mjs'),'start','--config',a.config]);
  assert.equal((await read(a.config)).port,a.saved.port);
  assert.equal((await get(a.url)).projectLabel,'Glade');
});

test('fixed port collisions fail clearly and leave the existing listener untouched',async t=>{
  const {root}=await fixture(t);const port=await occupied(t);
  const config=path.join(root,'fixed.json');
  await main(['init','--config',config,'--boards',path.join(root,'boards'),'--port',String(port)]);
  await assert.rejects(main(['start','--config',config]),/Port .* already in use.*fixed port/);
  assert.equal((await read(config)).port,port);
  assert.equal(await readRuntime(await loadConfig(config)),null);
});

test('simultaneous starts of the same config produce one owner and one saved URL',async t=>{
  const {root,managed}=await fixture(t);const port=await occupied(t);
  const config=await init(root,'Concurrent',port);const app=path.resolve('.');managed.push({app,config});
  const results=await Promise.allSettled(Array.from({length:4},()=>exec(process.execPath,[path.join(app,'cli.mjs'),'start','--config',config])));
  assert(results.some(r=>r.status==='fulfilled'),results.filter(r=>r.status==='rejected').map(r=>r.reason.stderr||r.reason.message).join('\n'));
  const saved=await read(config);const record=await read(`${config}.pid.json`);
  assert.equal(record.port,saved.port);assert.equal((await get(record.url)).projectLabel,'Concurrent');
  await stopManaged(await loadConfig(config));
  assert.equal(await readRuntime(await loadConfig(config)),null);
});

test('automatic selection handles a bind race on every candidate and is bounded',async t=>{
  const {root}=await fixture(t);
  const base=43821,config=await init(root,'Bounded',base),attempted=[];
  // Inject EADDRINUSE at the real bind boundary, as when another process binds
  // between candidate choice and listen. No machine's listeners are disturbed.
  const mocked=t.mock.method(http.Server.prototype,'listen',function(port){attempted.push(port);queueMicrotask(()=>this.emit('error',Object.assign(new Error('bind race'),{code:'EADDRINUSE'})));return this;});
  await assert.rejects(listen(await loadConfig(config),{persist:true}),/No free port after 20 attempts/);
  mocked.mock.restore();
  assert.equal(attempted.length,PORT_ATTEMPTS);assert.equal(new Set(attempted).size,PORT_ATTEMPTS);assert.equal(attempted[0],base);
  assert(attempted.slice(1).every(port=>port>=PORT_MIN&&port<=PORT_MAX));
  assert.equal((await read(config)).port,base);
  assert.equal(await readRuntime(await loadConfig(config)),null);
});

test('new manual and portable configs randomize across the requested range and remember their chosen port',async t=>{
  const {root,managed}=await fixture(t),ports=[];
  for(let index=0;index<12;index++)ports.push((await read(await init(root,`random-${index}`))).port);
  assert(ports.every(port=>port>=PORT_MIN&&port<=PORT_MAX));
  assert(new Set(ports).size>1,'new configs must not all use the same hard-coded default');
  const project=path.join(root,'portable');await mkdir(project);
  await main(['project','init','--project',project]);
  const config=path.join(project,'tinka/local/config.json');
  assert((await read(config)).port>=PORT_MIN&&(await read(config)).port<=PORT_MAX);
  const app=path.resolve('.');managed.push({app,config});
  const first=await main(['start','--config',config]),before=await read(`${config}.pid.json`);
  const again=await main(['start','--config',config]);
  assert.match(again,/already running/);assert(again.includes(before.url));
  assert.deepEqual(await read(`${config}.pid.json`),before);
  await stopManaged(await loadConfig(config));
  await main(['start','--config',config]);
  assert.equal((await read(`${config}.pid.json`)).port,before.port);
  assert(first.includes(before.url));
  const candidates=portCandidates(PORT_MAX);
  assert.equal(candidates[0],PORT_MAX);assert.equal(new Set(candidates).size,PORT_ATTEMPTS);
  assert(candidates.every(port=>port>=PORT_MIN&&port<=PORT_MAX));
});

test('offline mutations never return another project\'s clickable links and recover exact deep links after start',async t=>{
  const {root,managed}=await fixture(t),app=path.resolve('.');
  const foreign=await init(root,'foreign');managed.push({app,config:foreign});
  await main(['start','--config',foreign]);const foreignRuntime=await read(`${foreign}.pid.json`);
  const own=await init(root,'own',foreignRuntime.port);managed.push({app,config:own});
  const config=await loadConfig(own);
  const created=await callTool(config,'board.create',{id:'own-board',title:'Own board'});
  assert.equal(created.link,undefined);assert.equal(created.linkPath,'/boards/own-board/');
  assert.match(created.startCommand,/start --config/);assert.match(created.linkWarning,/could not be verified/);
  const commented=await callTool(config,'feedback.comment',{id:'waiting',boardId:'own-board',author:{id:'owner',label:'Owner',kind:'human'},body:'Review this',to:{kind:'agent'},status:'sent'});
  assert.equal(commented.link,undefined);assert.equal(commented.linkPath,'/boards/own-board/');
  for(const inbox of [await callTool(config,'feedback.inbox'),JSON.parse(await main(['inbox','--config',own,'--json','--since','']))]){
    assert.equal(inbox.threads[0].link,undefined);assert.equal(inbox.threads[0].linkPath,'/boards/own-board/#comments/waiting');assert(inbox.startCommand);
  }
  const text=await main(['inbox','--config',own,'--since','']);
  assert(!text.includes(foreignRuntime.url));assert.match(text,/start --config/);
  assert.deepEqual(await read(`${foreign}.pid.json`),foreignRuntime);
  assert.equal((await get(foreignRuntime.url)).projectLabel,'foreign');
  const started=await main(['start','--config',own]);
  assert.match(started,/was already in use/);const ownRuntime=await read(`${own}.pid.json`);
  assert.notEqual(ownRuntime.port,foreignRuntime.port);
  const edited=await callTool(await loadConfig(own),'board.update',{boardId:'own-board',patch:{description:'Changed'}});
  assert.equal(edited.link,new URL(created.linkPath,ownRuntime.url).href);
  const inbox=await callTool(await loadConfig(own),'feedback.inbox');
  assert.equal(inbox.threads[0].link,new URL('/boards/own-board/#comments/waiting',ownRuntime.url).href);
  assert.equal((await get(foreignRuntime.url)).projectLabel,'foreign');
});

test('endpoint links fail closed on every mismatched health identity field',async t=>{
  const {root}=await fixture(t),file=await init(root,'identity'),config=await loadConfig(file);
  let health;
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(health));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  config.port=server.address().port;
  const expected={...config,app:'board-room',url:`http://127.0.0.1:${config.port}/`};health=expected;
  assert.equal(await verifiedURL(config),expected.url);
  for(const key of ['app','configPath','boardsRoot','workspaceId','version','port','projectLabel','url']){
    health={...expected,[key]:key==='port'?1:'different'};
    assert.equal(await verifiedURL(config),null,`reject ${key} mismatch`);
  }
});

test('link enrichment preserves committed results for in-memory configs without server identity',async()=>{
  const response={revision:3,result:{boardId:'ideas',itemId:'saved'}};
  for(const config of [{boardsRoot:'/tmp/example',port:43000},{boardsRoot:'/tmp/example'},{configPath:42,port:43000}]){
    const result=await withLinks(config,'createBoard',{},response);
    assert.equal(result.revision,response.revision);assert.equal(result.result,response.result);
    assert.equal(result.link,undefined);assert.equal(result.startCommand,undefined);
  }
});


test('a failed upgrade restart restores the old app and service without changing external notes',async t=>{
  const {root,managed}=await fixture(t);
  const release=await buildRelease({outDir:path.join(root,'good-release')});
  const archive={zipBytes:await readFile(release.appZip),checksumText:await readFile(release.appChecksum,'utf8'),zipName:path.basename(release.appZip)};
  const app=path.join(root,'rollback','app');
  await installArchive({...archive,installDir:app});
  const config=await init(root,'rollback');managed.push({app,config});
  await exec(process.execPath,[path.join(app,'cli.mjs'),'board','create','saved','--config',config,'--title','Preserve this']);
  const notes=path.join(root,'rollback','boards','saved','.state','notes.json');
  const content='{"first/item":{"note":"Keep through rollback","updatedAt":1}}\n';
  await writeFile(notes,content);
  await exec(process.execPath,[path.join(app,'cli.mjs'),'start','--config',config]);
  const url=(await read(`${config}.pid.json`)).url;
  const brokenSource=path.join(root,'broken-source');
  await mkdir(brokenSource);
  for(const name of ['README.md','LICENSE','AGENTS.md','IMPLEMENTATION_CONTRACT.md','package.json','cli.mjs','server.mjs','public','lib','docs','examples','scripts','skill'])await cp(path.resolve(name),path.join(brokenSource,name),{recursive:true});
  const cli=path.join(brokenSource,'lib/cli.mjs');
  await writeFile(cli,(await readFile(cli,'utf8')).replace("if(command==='start'&&positionals.length===1){", "if(command==='start'&&positionals.length===1){throw new Error('Injected restart failure');"));
  const badRelease=path.join(root,'bad-release');
  const {stdout}=await exec(process.execPath,[path.join(brokenSource,'scripts/package.mjs'),'--out',badRelease]);
  const bad=JSON.parse(stdout);
  await assert.rejects(installArchive({zipBytes:await readFile(bad.appZip),checksumText:await readFile(bad.appChecksum,'utf8'),zipName:path.basename(bad.appZip),installDir:app,configPath:config}),/Injected restart failure/);
  assert.equal((await get((await read(`${config}.pid.json`)).url)).projectLabel,'rollback');
  assert.equal(await readFile(notes,'utf8'),content);
  assert(!(await readFile(path.join(app,'lib/cli.mjs'),'utf8')).includes('Injected restart failure'));
});

test('concurrent starts recover a dead runtime record without displacing the new owner',async t=>{
  const {root,managed}=await fixture(t);
  const config=await init(root,'recover');const app=path.resolve('.');managed.push({app,config});
  const canonical=(await loadConfig(config)).configPath;
  await writeFile(`${config}.pid.json`,JSON.stringify({pid:2147483647,configPath:canonical,token:'00000000-0000-0000-0000-000000000000'}));
  const results=await Promise.allSettled(Array.from({length:4},()=>exec(process.execPath,[path.join(app,'cli.mjs'),'start','--config',config])));
  assert(results.some(r=>r.status==='fulfilled'),results.filter(r=>r.status==='rejected').map(r=>r.reason.stderr||r.reason.message).join('\n'));
  const record=await read(`${config}.pid.json`);
  assert.equal(record.state,'ready');assert.equal((await get(record.url)).projectLabel,'recover');
});
