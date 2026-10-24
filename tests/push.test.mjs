import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';
const run=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-push-')),configPath=path.join(root,'config.json'),boards=path.join(root,'boards');
  await main(['init','--config',configPath,'--boards',boards,'--label','Push fixture']);
  await main(['workspace','init','--config',configPath,'--apply']);
  const config=await loadConfig(configPath);
  const op=async operation=>JSON.parse(await main(['workspace','op','--config',configPath,'--json',JSON.stringify(operation)]));
  await op({type:'createBoard',id:'ideas',title:'Ideas'});
  const assets=path.join(root,'assets');await mkdir(assets);await writeFile(path.join(assets,'page.html'),'<h1>One</h1>');
  await op({type:'updateWorkspace',patch:{resourceRoots:{assets:{path:path.relative(config.workspaceRoot,assets)}}}});
  await op({type:'createItem',boardId:'ideas',item:{id:'page',title:'Page',content:{kind:'html',resource:{rootId:'assets',path:'page.html'}}}});
  const server=await listen(config,{port:0}),base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await closeAppServer(server);await rm(root,{recursive:true,force:true});});
  const cli=operation=>run(process.execPath,['cli.mjs','workspace','op','--config',configPath,'--json',JSON.stringify(operation)],{cwd:path.resolve(import.meta.dirname,'..')});
  return {root,configPath,config,server,base,assets,cli};
}
async function stream(t,f,board='ideas'){
  const abort=new AbortController(),events=[];
  const response=await fetch(`${f.base}/api/events?workspace=${f.config.workspaceId}${board?`&board=${board}`:''}`,{signal:abort.signal});assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  const reading=(async()=>{try{while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);const event=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(event&&data)events.push({event,data:JSON.parse(data)});}}}catch{}})();
  const close=async()=>{abort.abort();await reading;};t.after(close);
  async function until(predicate,timeout=7000){const start=Date.now();while(Date.now()-start<timeout){const found=events.find(predicate);if(found)return found.data;await pause(20);}assert.fail(`No matching push event: ${JSON.stringify(events)}`);}
  return {events,until,close};
}

test('SSE observes external CLI and atomic resource edits, resyncs, and releases idle watchers',async t=>{
  const f=await fixture(t),s=await stream(t,f);
  const first=await s.until(e=>e.event==='snapshot');assert.equal(first.runtimeId,f.config.workspaceId);
  await f.cli({type:'updateItem',itemId:'page',patch:{title:'Changed by another process'}});
  const metadata=await s.until(e=>e.event==='snapshot'&&e.data.manifestRevision!==first.manifestRevision);
  await writeFile(path.join(f.assets,'replacement.html'),'<h1>Resource updated independently</h1>');await rename(path.join(f.assets,'replacement.html'),path.join(f.assets,'page.html'));
  const resource=await s.until(e=>e.event==='snapshot'&&e.data.manifestRevision===metadata.manifestRevision&&e.data.items.page.revision!==metadata.items.page.revision);
  await s.close();await pause(50);assert.equal(f.server.pushHub.diagnostics().watchers,0);
  await f.cli({type:'updateItem',itemId:'page',patch:{title:'Changed while disconnected'}});
  const resumed=await stream(t,f);const latest=await resumed.until(e=>e.event==='snapshot');assert.notEqual(latest.manifestRevision,resource.manifestRevision);
  await pause(1200);const count=resumed.events.length,idle=f.server.pushHub.diagnostics();
  await pause(1300);const after=f.server.pushHub.diagnostics();assert.ok(after.snapshotBuilds-idle.snapshotBuilds<=after.filesystemEvents-idle.filesystemEvents,'snapshot builds require filesystem events, including concurrent source-shell edits');if(after.filesystemEvents===idle.filesystemEvents){assert.equal(resumed.events.length,count);assert.equal(after.generation,idle.generation);assert.equal(after.rootChecks,idle.rootChecks);}
  await closeAppServer(f.server);assert.equal(f.server.pushHub.diagnostics().watchers,0);
});

test('push runtime/origin guards and independent instances isolate notifications',async t=>{
  const a=await fixture(t),b=await fixture(t),sa=await stream(t,a,''),sb=await stream(t,b,'');
  await sa.until(e=>e.event==='change');await sb.until(e=>e.event==='change');
  assert.equal((await fetch(`${a.base}/api/events?workspace=${b.config.workspaceId}`)).status,403);
  assert.equal((await fetch(`${a.base}/api/events?workspace=${a.config.workspaceId}`,{headers:{origin:'https://example.org'}})).status,403);
  const aCount=sa.events.length,bCount=sb.events.length;
  await a.cli({type:'createBoard',id:'other',title:'Other'});
  await sa.until((_e)=>sa.events.length>aCount);
  await pause(1200);assert.equal(sb.events.length,bCount);
  await closeAppServer(a.server);assert.equal((await fetch(b.base+'/api/health')).status,200);
});
