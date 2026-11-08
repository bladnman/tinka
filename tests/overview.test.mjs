import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen} from '../server.mjs';
import {boardOverview,findBrowser,overviewSize,saveOverview} from '../lib/overview.mjs';

const PNG=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000','hex');

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-overview-'));
  const configPath=path.join(root,'config.json');
  await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Overview']);
  await main(['workspace','init','--config',configPath,'--apply']);
  await main(['tools','call','board.create','--config',configPath,'--json','{"id":"looks","title":"Looks"}']);
  const config=await loadConfig(configPath),server=await listen(config,{port:0});
  const url=`http://127.0.0.1:${server.address().port}/`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return {root,config,url,running:async()=>({url})};
}

// A stand-in browser that speaks the DevTools pipe protocol (NUL-separated JSON
// on fds 3 and 4) and records every call it receives.
async function fakeBrowser(root,{aspect=1.5,state='ready',contentWidth=3000,chrome=0,navError='',silent=''}={}){
  const file=path.join(root,`fake-browser-${Math.random().toString(36).slice(2)}.mjs`),log=`${file}.calls.json`;
  await writeFile(file,`#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
const input=new net.Socket({fd:3,readable:true,writable:false}),output=new net.Socket({fd:4,readable:false,writable:true});
const calls=[];let buffer=Buffer.alloc(0),resized=false;
const result=message=>{
  const {method,params}=message;
  if(method==='Target.createTarget')return {targetId:'T'};
  if(method==='Target.attachToTarget')return {sessionId:'S'};
  if(method==='Emulation.setDeviceMetricsOverride'&&calls.filter(c=>c.method===method).length>1)resized=true;
  if(method==='Runtime.evaluate'&&params.expression.startsWith('(()=>'))return {result:{value:JSON.stringify({aspect:${aspect},width:${contentWidth},chrome:${chrome},items:3,error:''})}};
  if(method==='Runtime.evaluate'&&params.expression.startsWith('document'))return {result:{value:${JSON.stringify(state)}}};
  if(method==='Page.navigate'&&${JSON.stringify(navError)})return {frameId:'F',errorText:${JSON.stringify(navError)}};
  if(method==='Page.captureScreenshot')return {data:${JSON.stringify(PNG.toString('base64'))}};
  return {};
};
input.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  for(let end=buffer.indexOf(0);end>=0;end=buffer.indexOf(0)){
    const message=JSON.parse(buffer.subarray(0,end).toString());buffer=buffer.subarray(end+1);
    calls.push({method:message.method,params:message.params,sessionId:message.sessionId});
    fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),calls}));
    if(message.method!==${JSON.stringify(silent)})output.write(JSON.stringify({id:message.id,result:result(message)})+'\\0');
  }
});
process.on('SIGTERM',()=>process.exit(0));
`);
  await chmod(file,0o755);
  return {file,calls:async()=>JSON.parse(await readFile(log,'utf8'))};
}

test('board overview validates its arguments before starting anything',async t=>{
  const f=await fixture(t);
  const never=async()=>{throw new Error('should not run');};
  const call=options=>boardOverview(f.config,'looks',options,{running:f.running,find:never,save:never});
  await assert.rejects(call({}),/--out/);
  await assert.rejects(call({out:path.join(f.root,'a.jpg')}),/\.png/);
  await writeFile(path.join(f.root,'taken.png'),'keep');
  await assert.rejects(call({out:path.join(f.root,'taken.png')}),/already exists/);
  assert.equal(await readFile(path.join(f.root,'taken.png'),'utf8'),'keep');
  for(const width of ['99','8001','12.5','wide'])await assert.rejects(call({out:path.join(f.root,'a.png'),width}),/--width/);
  await assert.rejects(call({out:path.join(f.root,'a.png'),appearance:'sepia'}),/--appearance/);
  await assert.rejects(boardOverview(f.config,'../looks',{out:path.join(f.root,'a.png')},{running:f.running,find:never,save:never}));
  await assert.rejects(boardOverview(f.config,'looks',{out:path.join(f.root,'a.png')},{running:async()=>null,find:never,save:never}),/not running\. Start it first: node .*cli\.mjs start --config /);
  await assert.rejects(boardOverview(f.config,'missing',{out:path.join(f.root,'a.png')},{running:f.running,find:never,save:never}),/Board missing not found/);
  await assert.rejects(boardOverview(f.config,'looks',{out:path.join(f.root,'a.png')},{running:f.running,find:async()=>null,save:never}),/CHROMIUM_EXECUTABLE.*boards\/looks\/\?overview/s);
});

test('board overview renders through the DevTools pipe, sizes the image to the board and never overwrites',async t=>{
  const f=await fixture(t),browser=await fakeBrowser(f.root,{aspect:1.5,chrome:52});
  const out=path.join(f.root,'overview.png');
  const message=await boardOverview(f.config,'looks',{out,width:'1000',appearance:'dark'},{running:f.running,find:async()=>browser.file});
  assert.match(message,/Saved an overview of looks \(3 items, 1000 × 1528\) to .*overview\.png\.$/);
  assert.deepEqual(await readFile(out),PNG);
  const {args,calls}=await browser.calls();
  assert(args.includes('--headless=new')&&args.includes('--remote-debugging-pipe'));
  const profile=args.find(arg=>arg.startsWith('--user-data-dir='));
  assert(profile,'a throwaway profile, never the person\'s own');
  const sizes=calls.filter(c=>c.method==='Emulation.setDeviceMetricsOverride').map(c=>[c.params.width,c.params.height]);
  // First a default 16:10 window, then the board's own shape below the 52px title bar: (1000-48)*1.5+48+52.
  assert.deepEqual(sizes,[[1000,625],[1000,1528]]);
  assert.deepEqual(calls.find(c=>c.method==='Emulation.setEmulatedMedia').params.features,[{name:'prefers-color-scheme',value:'dark'}]);
  assert.equal(calls.find(c=>c.method==='Page.navigate').params.url,`${f.url}boards/looks/?overview`);
  assert(calls.filter(c=>!c.method.startsWith('Target.')).every(c=>c.sessionId==='S'));
  await assert.rejects(boardOverview(f.config,'looks',{out},{running:f.running,find:async()=>browser.file}),/already exists/);
  await assert.rejects(readFile(profile.slice('--user-data-dir='.length)),/ENOENT/);
});

test('an overview whose previews never settle is still saved, with a warning',async t=>{
  const f=await fixture(t),browser=await fakeBrowser(f.root,{state:'partial',aspect:0.625});
  const out=path.join(f.root,'partial.png');
  const message=await boardOverview(f.config,'looks',{out},{running:f.running,find:async()=>browser.file});
  assert.match(message,/2400 × 1518\).*Some previews had not finished loading/);
  const failed=await saveOverview({url:f.url,boardId:'looks',out:path.join(f.root,'never.png'),browser:path.join(f.root,'no-such-browser')}).catch(error=>error);
  assert.match(failed.message,/Could not start/);
  await assert.rejects(readFile(path.join(f.root,'never.png')),/ENOENT/);
});

test('a small board is not enlarged past 125%, and very tall boards stay within 16000 pixels',async t=>{
  assert.deepEqual(overviewSize({width:2400,aspect:0.5,contentWidth:800,chrome:52}),{width:1048,height:600});
  assert.deepEqual(overviewSize({width:2400,aspect:0.5,contentWidth:100,chrome:0}),{width:400,height:224});
  assert.deepEqual(overviewSize({width:8000,aspect:3,contentWidth:9000,chrome:0}),{width:8000,height:16000});
  assert.deepEqual(overviewSize({width:2400,aspect:0.01,contentWidth:90000,chrome:0}),{width:2400,height:720});
  assert.deepEqual(overviewSize({width:1200,aspect:0,contentWidth:0,chrome:0}),{width:1200,height:768});
  const f=await fixture(t),browser=await fakeBrowser(f.root,{aspect:0.5,contentWidth:800,chrome:52});
  const message=await boardOverview(f.config,'looks',{out:path.join(f.root,'small.png')},{running:f.running,find:async()=>browser.file});
  assert.match(message,/1048 × 600\)/);
  const {calls}=await browser.calls();
  assert.deepEqual(calls.filter(c=>c.method==='Emulation.setDeviceMetricsOverride').map(c=>[c.params.width,c.params.height]),[[2400,1500],[1048,600]]);
});

test('a page that fails, never gets ready or stops answering saves nothing and cannot hang',async t=>{
  const f=await fixture(t);
  const cases=[
    [{navError:'net::ERR_CONNECTION_REFUSED'},/did not load \(net::ERR_CONNECTION_REFUSED\)\. Nothing was saved/],
    [{state:''},/did not finish the overview within 2 s\. Nothing was saved/],
    [{silent:'Page.navigate'},/did not finish the overview within 2 s/],
    [{silent:'Target.createTarget'},/did not finish the overview within 2 s/],
  ];
  for(const [options,expected] of cases){
    const browser=await fakeBrowser(f.root,options),out=path.join(f.root,'failed.png'),began=Date.now();
    await assert.rejects(saveOverview({url:f.url,boardId:'looks',out,browser:browser.file,timeout:1500}),expected);
    assert(Date.now()-began<5000,`${JSON.stringify(options)} gave up promptly`);
    await assert.rejects(readFile(out),/ENOENT/);
  }
});

test('the browser comes from CHROMIUM_EXECUTABLE or a known name on PATH',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-overview-find-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const chromium=path.join(root,'chromium');
  await writeFile(chromium,'#!/bin/sh\n');await chmod(chromium,0o755);
  assert.equal(await findBrowser({env:{CHROMIUM_EXECUTABLE:chromium},platform:'linux'}),chromium);
  await assert.rejects(findBrowser({env:{CHROMIUM_EXECUTABLE:path.join(root,'missing')},platform:'linux'}),/not an executable/);
  assert.equal(await findBrowser({env:{PATH:`/nonexistent${path.delimiter}${root}`},platform:'linux'}),chromium);
  assert.equal(await findBrowser({env:{PATH:root},platform:'win32'}),null);
});
