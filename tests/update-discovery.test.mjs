import './helpers/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publishedLatest,redirectLatest,checkForUpdates,updateCommand,loadUpdateState,updateCheckTiming,CHECK_INTERVAL,CHECK_RETRY_INTERVAL,SNOOZE_INTERVAL,VERSION_URL} from '../lib/updates.mjs';
const REPO='bladnman/tinka',HAVE='1.8.0',NEXT='1.9.0';
const tag=version=>`https://github.com/${REPO}/releases/tag/v${version}`;
const download=version=>`https://github.com/${REPO}/releases/download/v${version}/`;
async function network(t,fetcher){const original=globalThis.fetch;globalThis.fetch=fetcher;t.after(()=>{globalThis.fetch=original;});}
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-discovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'config.json'),workspaceRoot:root,version:HAVE};
  const context={app:root,repo:REPO,statePath:path.join(root,'updates.json')};return {config,context};
}
test('official stable plain version is one tiny request when current; newer assets bind to one tag',async t=>{
  const calls=[];await network(t,async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url)===VERSION_URL)return new Response(`${NEXT}\n`);
    assert.equal(String(url),`${download(NEXT)}tinka-v${NEXT}.compatibility.json`);
    return new Response(JSON.stringify({version:NEXT}));
  });
  assert.deepEqual(await publishedLatest(REPO,NEXT),{version:NEXT});assert.equal(calls.length,1);
  const latest=await publishedLatest(REPO,HAVE);assert.equal(latest.version,NEXT);assert.equal(latest.zipURL,`${download(NEXT)}tinka-v${NEXT}.zip`);assert.equal(latest.checksumURL,latest.zipURL+'.sha256');
  assert(calls.every(call=>!call.url.includes('api.github.com')));assert(calls.every(call=>!call.options.headers.Authorization));
  assert(calls.every(call=>!new URL(call.url).search),'no project/client identifier in version requests');
});
test('failed, malformed, prerelease, oversized and zero-padded version files use the public redirect',async t=>{
  let body='';const calls=[];await network(t,async(url,options)=>{
    calls.push(String(url));
    if(String(url)===VERSION_URL){if(body==='unavailable')return new Response('',{status:429});return new Response(body);}
    assert.equal(String(url),`https://github.com/${REPO}/releases/latest`);assert.equal(options.method,'HEAD');assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:tag(HAVE)}});
  });
  for(body of ['unavailable','<html>not a version</html>','1.9.0-beta.1','1.09.0','1.9.0\n'+' '.repeat(200)]){
    calls.length=0;assert.deepEqual(await publishedLatest(REPO,HAVE),{version:HAVE});assert.equal(calls.length,2);
  }
});
test('custom repositories preserve authenticated API discovery without contacting the Tinka website',async t=>{
  const token=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-token';t.after(()=>{if(token===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=token;});
  const repo='sample/custom',calls=[];
  await network(t,async(url,options)=>{calls.push(String(url));assert.equal(options.headers.Authorization,'Bearer fixture-token');return new Response(JSON.stringify({tag_name:`v${HAVE}`,assets:[]}));});
  assert.deepEqual(await publishedLatest(repo,HAVE),{version:HAVE});assert.deepEqual(calls,[`https://api.github.com/repos/${repo}/releases/latest`]);
});
test('unsafe/unsupported fallback redirect destinations fail closed and redirect loops are bounded',async t=>{
  let location='';const calls=[];
  await network(t,async(url)=>{calls.push(String(url));return new Response(null,{status:302,headers:{location}});});
  for(location of ['https://evil.example/releases/tag/v1.9.0',`http://github.com/${REPO}/releases/tag/v1.9.0`,`https://github.com/other/repo/releases/tag/v1.9.0`,tag('1.9.0-beta.1')])await assert.rejects(redirectLatest(REPO));
  location=`https://github.com/${REPO}/releases/latest`;calls.length=0;await assert.rejects(redirectLatest(REPO),/Too many/);assert.equal(calls.length,4);
});
test('a discovered version survives unavailable/malformed install metadata as a review offer',async t=>{
  let malformed=false;await network(t,async(url)=>String(url)===VERSION_URL?new Response(NEXT):malformed?new Response('{broken'):new Response('',{status:404}));
  for(malformed of [false,true]){const offer=await publishedLatest(REPO,HAVE);assert.equal(offer.version,NEXT);assert.match(offer.review,/installation details are unavailable/);assert.equal(offer.compatibility,undefined);}
});
test('discovery failure preserves known offer and success time; failed attempts retry after two minutes',async t=>{
  const f=await fixture(t),offer={version:NEXT,review:'Unavailable installation details'};let calls=0;
  await checkForUpdates(f.config,{context:f.context,now:1000,fetchLatest:async()=>offer});
  let state=await loadUpdateState(f.context,f.config);assert.equal(state.lastSuccessfulCheckAt,1000);assert.equal(updateCheckTiming(state).nextCheckAt,1000+CHECK_INTERVAL);
  const failedAt=1000+CHECK_INTERVAL;
  const fail=async()=>{calls++;throw new Error('both sources unavailable');};
  await checkForUpdates(f.config,{context:f.context,now:failedAt,fetchLatest:fail});
  state=await loadUpdateState(f.context,f.config);assert.deepEqual(state.latest,offer);assert.equal(state.lastSuccessfulCheckAt,1000);assert.equal(state.checkedAt,failedAt);assert.equal(updateCheckTiming(state).checkFailed,true);assert.equal(updateCheckTiming(state).nextCheckAt,failedAt+CHECK_RETRY_INTERVAL);
  await checkForUpdates(f.config,{context:f.context,now:failedAt+CHECK_RETRY_INTERVAL-1,fetchLatest:fail});assert.equal(calls,1);
  await checkForUpdates(f.config,{context:f.context,now:failedAt+CHECK_RETRY_INTERVAL,fetchLatest:async()=>{calls++;return offer;}});
  state=await loadUpdateState(f.context,f.config);assert.equal(calls,2);assert.equal(state.checkError,undefined);assert.equal(state.lastSuccessfulCheckAt,failedAt+CHECK_RETRY_INTERVAL);
});
test('both real discovery routes failing retain state; explicit check reports failure without downloading',async t=>{
  const f=await fixture(t);await network(t,async()=>new Response('',{status:503}));
  const result=await updateCommand(f.config,'check',null,{context:f.context,downloadRelease:()=>{throw new Error('must not download');}});
  assert.match(result.message,/check unavailable/);assert.equal(result.replaced,false);assert.equal(updateCheckTiming(await loadUpdateState(f.context,f.config)).checkFailed,true);
});
test('immutable validated metadata survives a transient metadata-only failure for the same announced version',async t=>{
  const f=await fixture(t),metadata=JSON.parse(await readFile(new URL('../lib/update-compatibility.json',import.meta.url),'utf8'));
  const offer={version:NEXT,compatibility:{...metadata,version:NEXT,fromVersions:[HAVE]},zipURL:download(NEXT)+'package.zip'};
  await checkForUpdates(f.config,{context:f.context,now:1000,fetchLatest:async()=>offer});
  await checkForUpdates(f.config,{context:f.context,now:1000+CHECK_INTERVAL,fetchLatest:async()=>({version:NEXT,review:'Metadata host unavailable'})});
  assert.deepEqual((await loadUpdateState(f.context,f.config)).latest,offer);
});
test('refresh is unforced metadata-only; Off blocks it; snooze remains exactly 24 hours independently',async t=>{
  const f=await fixture(t);let calls=0,downloads=0;const options={context:f.context,now:1000,fetchLatest:async()=>{calls++;return {version:NEXT,review:'Metadata not ready'};},downloadRelease:async()=>{downloads++;}};
  await updateCommand(f.config,'refresh',null,options);await updateCommand(f.config,'refresh',null,options);assert.equal(calls,1);assert.equal(downloads,0);
  await updateCommand(f.config,'policy','off',{context:f.context});await updateCommand(f.config,'refresh',null,{...options,now:1000+CHECK_INTERVAL});assert.equal(calls,1);
  await updateCommand(f.config,'check',null,{...options,now:1000+CHECK_INTERVAL});assert.equal(calls,2);assert.equal(downloads,0);
  const at=Date.now();await updateCommand(f.config,'later',null,{context:f.context});const state=await loadUpdateState(f.context,f.config);assert(state.snoozeUntil>=at+SNOOZE_INTERVAL&&state.snoozeUntil<=Date.now()+SNOOZE_INTERVAL);assert.equal(SNOOZE_INTERVAL,24*60*60*1000);assert.equal(CHECK_INTERVAL,15*60*1000);
});

test('old cached success time survives the first failed check after upgrading',async t=>{
  const f=await fixture(t),offer={version:NEXT,review:'Installation metadata not ready'};
  await writeFile(f.context.statePath,JSON.stringify({schemaVersion:1,configPath:f.config.configPath,appPath:f.context.app,policy:'notify',checkedAt:1000,latest:offer}));
  await checkForUpdates(f.config,{context:f.context,now:1000+CHECK_INTERVAL,fetchLatest:async()=>{throw new Error('offline');}});
  const state=await loadUpdateState(f.context,f.config);assert.equal(state.lastSuccessfulCheckAt,1000);assert.deepEqual(state.latest,offer);assert.equal(state.checkError,'Latest release check unavailable.');
});
