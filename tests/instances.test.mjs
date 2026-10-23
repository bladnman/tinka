import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,cp} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {main} from '../cli.mjs';
import {loadConfig,PORT_ATTEMPTS,PORT_STEP} from '../lib/config.mjs';
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
  // listen(0) can choose a port so high that no +100 fallback is legal.
  // These collision fixtures require room for the complete candidate range.
  const highestBase=65535-(PORT_ATTEMPTS-1)*PORT_STEP;
  for(let attempt=0;attempt<20;attempt++){
    const server=net.createServer();
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    if(port<=highestBase){t.after(()=>new Promise(resolve=>server.close(resolve)));return port;}
    await new Promise(resolve=>server.close(resolve));
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
    assert.equal((instance.saved.port-blocked)%PORT_STEP,0);
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

test('automatic selection is bounded when every candidate is occupied',async t=>{
  const {root}=await fixture(t);
  // Reserve an entire candidate range, retrying another base if this machine is busy.
  let servers=[],base;
  for(let start=48021;start<58000;start+=2100){
    try{
      for(let i=0;i<PORT_ATTEMPTS;i++){
        const server=net.createServer();servers.push(server);
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(start+i*PORT_STEP,'127.0.0.1',resolve);});
      }
      base=start;break;
    }catch{await Promise.all(servers.map(s=>s.listening?new Promise(r=>s.close(r)):null));servers=[];}
  }
  assert(base,'A test candidate range is available');
  t.after(()=>Promise.all(servers.map(s=>new Promise(r=>s.close(r)))));
  const config=await init(root,'Bounded',base);
  await assert.rejects(main(['start','--config',config]),/No free port.*20-attempt/);
  assert.equal((await read(config)).port,base);
  assert.equal(await readRuntime(await loadConfig(config)),null);
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
  for(const name of ['README.md','AGENTS.md','IMPLEMENTATION_CONTRACT.md','package.json','cli.mjs','server.mjs','public','lib','docs','examples','scripts','skill'])await cp(path.resolve(name),path.join(brokenSource,name),{recursive:true});
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
