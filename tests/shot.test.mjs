import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen} from '../server.mjs';
import {callTool} from '../lib/tools.mjs';
import {itemShot,shotSource,imageSize} from '../lib/shot.mjs';

const PNG=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000','hex');

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-shot-'));
  const configPath=path.join(root,'config.json');
  await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Shot']);
  await main(['workspace','init','--config',configPath,'--apply']);
  await mkdir(path.join(root,'work'));
  await writeFile(path.join(root,'work/page.html'),'<!doctype html><h1>Example</h1>');
  await writeFile(path.join(root,'work/picture.png'),PNG);
  const config=await loadConfig(configPath);
  await callTool(config,'workspace.update',{patch:{resourceRoots:{work:{path:'../../work'}}}});
  await callTool(config,'board.create',{id:'looks',title:'Looks'});
  await callTool(config,'board.create',{id:'shortlist',title:'Shortlist'});
  const add=item=>callTool(config,'item.create',{boardId:'looks',item});
  const page=await add({title:'Example page',content:{kind:'html',resource:{rootId:'work',path:'page.html'}}});
  const picture=await add({title:'Picture',content:{kind:'image',resource:{rootId:'work',path:'picture.png'}}});
  const missing=await add({title:'Gone',content:{kind:'html',resource:{rootId:'work',path:'gone.html'}}});
  const remote=await add({title:'Remote',content:{kind:'html',url:'https://example.org/'}});
  const board=await callTool(config,'board.create',{id:'child',title:'Child',parentBoardId:'looks'});
  const server=await listen(config,{port:0});
  const url=`http://127.0.0.1:${server.address().port}/`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return {root,config,url,running:async()=>({url}),page,picture,missing,remote,board};
}

// A stand-in browser speaking the DevTools pipe protocol; records every call.
async function fakeBrowser(root,{height=900,imageWidth=0,imageHeight=0,ready='ready'}={}){
  const file=path.join(root,`fake-browser-${Math.random().toString(36).slice(2)}.mjs`),log=`${file}.calls.json`;
  await writeFile(file,`#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
const input=new net.Socket({fd:3,readable:true,writable:false}),output=new net.Socket({fd:4,readable:false,writable:true});
const calls=[];let buffer=Buffer.alloc(0);
const result=({method,params})=>{
  if(method==='Target.createTarget')return {targetId:'T'};
  if(method==='Target.attachToTarget')return {sessionId:'S'};
  if(method==='Runtime.evaluate'&&params.expression.startsWith('/*ready*/'))return {result:{value:${JSON.stringify(ready)}}};
  if(method==='Runtime.evaluate'&&params.expression.startsWith('/*flow*/'))return {result:{value:true}};
  if(method==='Runtime.evaluate'&&params.expression.startsWith('/*measure*/'))return {result:{value:JSON.stringify({height:${height},imageWidth:${imageWidth},imageHeight:${imageHeight}})}};
  if(method==='Page.captureScreenshot')return {data:${JSON.stringify(PNG.toString('base64'))}};
  return {};
};
input.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  for(let end=buffer.indexOf(0);end>=0;end=buffer.indexOf(0)){
    const message=JSON.parse(buffer.subarray(0,end).toString());buffer=buffer.subarray(end+1);
    calls.push({method:message.method,params:message.params});
    fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),calls}));
    output.write(JSON.stringify({id:message.id,result:result(message)})+'\\0');
  }
});
process.on('SIGTERM',()=>process.exit(0));
`);
  await chmod(file,0o755);
  return {file,calls:async()=>JSON.parse(await readFile(log,'utf8')).calls};
}

test('each kind of item has a sensible thing to load',()=>{
  const base='http://127.0.0.1:9/';
  assert.deepEqual(shotSource({id:'a',content:{kind:'html',resource:{rootId:'work',path:'a b/index.html'}}},base),{kind:'page',url:`${base}resources/work/a%20b/index.html?tinka=off`,what:'page'});
  assert.equal(shotSource({id:'a',content:{kind:'html',url:'http://localhost:5173/'}},base).url,'http://localhost:5173/');
  assert.deepEqual(shotSource({id:'a',content:{kind:'html',url:'https://example.org/'}},base),{remote:'https://example.org/'});
  assert.equal(shotSource({id:'a',content:{kind:'html',url:'https://example.org/'},preview:{resource:{rootId:'work',path:'p.png'}}},base).kind,'image');
  assert.equal(shotSource({id:'a',content:{kind:'image',resource:{rootId:'work',path:'p.png'}}},base).url,`${base}resources/work/p.png`);
  const doc=shotSource({id:'a',title:'Doc',content:{kind:'markdown',resource:{rootId:'work',path:'d.md'}}},base,{appearance:'dark'});
  assert(doc.tinkaPage&&doc.url.startsWith(`${base}app/media.html?`)&&doc.url.includes('theme=night')&&doc.url.includes('chrome=none'));
  assert.equal(shotSource({id:'n',content:{kind:'note',text:'Hi'}},base).url,`${base}app/item.html?item=n&theme=paper`);
  assert.deepEqual(shotSource({id:'b',childBoardId:'kids'},base),{board:'kids'});
  assert.deepEqual(imageSize({imageWidth:3000,imageHeight:1500}),{width:3000,height:1500});
  assert.deepEqual(imageSize({imageWidth:8000,imageHeight:2000}),{width:4000,height:1000});
  assert.deepEqual(imageSize({imageWidth:3000,imageHeight:1500},1000),{width:1000,height:500});
  assert.equal(imageSize({imageWidth:0,imageHeight:0}),null);
});

test('item shot checks its arguments and the item before starting a browser',async t=>{
  const f=await fixture(t),never=async()=>{throw new Error('should not run');};
  const shot=(target,options)=>itemShot(f.config,target,{out:path.join(f.root,'a.png'),...options},{running:f.running,find:never,save:never});
  const id=f.page.result.itemId;
  await assert.rejects(itemShot(f.config,id,{},{running:f.running,find:never,save:never}),/--out/);
  await assert.rejects(shot(id,{out:path.join(f.root,'a.jpg')}),/\.png/);
  await writeFile(path.join(f.root,'taken.png'),'keep');
  await assert.rejects(shot(id,{out:path.join(f.root,'taken.png')}),/already exists/);
  assert.equal(await readFile(path.join(f.root,'taken.png'),'utf8'),'keep');
  for(const width of ['319','2561','12.5'])await assert.rejects(shot(id,{width}),/--width/);
  await assert.rejects(shot(id,{height:'50'}),/--height/);
  await assert.rejects(shot(id,{scale:'3'}),/--scale/);
  await assert.rejects(shot(id,{appearance:'sepia'}),/--appearance/);
  await assert.rejects(shot('../x',{}),/item or placement ID/);
  await assert.rejects(shot('nothing-here',{}),/No item or placement nothing-here/);
  await assert.rejects(shot(id,{board:'shortlist'}),/not on board shortlist/);
  await assert.rejects(itemShot(f.config,id,{out:path.join(f.root,'a.png')},{running:async()=>null,find:never,save:never}),/not running\. Start it first: node .*cli\.mjs start --config /);
  await assert.rejects(shot(f.board.result.itemId,{}),/is a board\. Save it as one image with: node .*board overview child/);
  await assert.rejects(shot(f.remote.result.itemId,{}),/remote page/);
  await assert.rejects(shot(f.missing.result.itemId,{}),/file for Gone is missing/);
  await assert.rejects(itemShot(f.config,id,{out:path.join(f.root,'a.png')},{running:f.running,find:async()=>null,save:never}),/CHROMIUM_EXECUTABLE.*resources\/work\/page\.html/s);
});

test('item shot renders the page at the chosen width, at twice the pixels, and prints its Tinka link',async t=>{
  const f=await fixture(t),browser=await fakeBrowser(f.root,{height:1500});
  const out=path.join(f.root,'page.png'),placement=f.page.result.placementIds[0];
  const message=await itemShot(f.config,f.page.result.itemId,{out,appearance:'dark'},{running:f.running,find:async()=>browser.file});
  assert.equal(message,`Saved a shot of "Example page" (page, 2560 × 3000 pixels) to ${out}.\nTinka link: ${f.url}boards/looks/#items/${placement}`);
  assert.deepEqual(await readFile(out),PNG);
  const calls=await browser.calls();
  assert.deepEqual(calls.find(c=>c.method==='Emulation.setDeviceMetricsOverride').params,{width:1280,height:800,deviceScaleFactor:2,mobile:false});
  assert.deepEqual(calls.find(c=>c.method==='Emulation.setEmulatedMedia').params.features,[{name:'prefers-color-scheme',value:'dark'}]);
  assert.equal(calls.find(c=>c.method==='Page.navigate').params.url,`${f.url}resources/work/page.html?tinka=off`);
  assert.deepEqual(calls.find(c=>c.method==='Page.captureScreenshot').params,{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1280,height:1500,scale:1}});
  await assert.rejects(itemShot(f.config,f.page.result.itemId,{out},{running:f.running,find:async()=>browser.file}),/already exists/);

  // Phone width, a placement ID, and a very long page shown to its first 4000 px.
  const tall=await fakeBrowser(f.root,{height:9000,ready:'partial'}),phone=path.join(f.root,'phone.png');
  const second=await itemShot(f.config,placement,{out:phone,width:'390'},{running:f.running,find:async()=>tall.file});
  assert.match(second,/\(page, 780 × 8000 pixels\).*Some images had not finished loading.*9000 px tall; the picture shows its first 4000 \(use --height to choose\)\.\nTinka link: .*#items\//s);
  assert.deepEqual((await tall.calls()).find(c=>c.method==='Emulation.setDeviceMetricsOverride').params,{width:390,height:844,deviceScaleFactor:2,mobile:false});
});

test('an image keeps its own pixels, and an item on several boards names the preferred one',async t=>{
  const f=await fixture(t),browser=await fakeBrowser(f.root,{imageWidth:1600,imageHeight:900});
  const shared=await callTool(f.config,'placement.reference',{sourceBoardId:'looks',placementIds:f.picture.result.placementIds,targetBoardId:'shortlist'});
  const out=path.join(f.root,'picture.png');
  const message=await itemShot(f.config,f.picture.result.itemId,{out,board:'shortlist'},{running:f.running,find:async()=>browser.file});
  assert.match(message,/\(image, 1600 × 900 pixels\)/);
  assert(message.endsWith(`Tinka link: ${f.url}boards/shortlist/#items/${shared.result.placementIds[0]} (also on 1 other board)`));
  const sizes=(await browser.calls()).filter(c=>c.method==='Emulation.setDeviceMetricsOverride').map(c=>c.params);
  assert.deepEqual(sizes.at(-1),{width:1600,height:900,deviceScaleFactor:1,mobile:false});
});

test('changing tool calls return the direct Tinka link to what they changed',async t=>{
  const f=await fixture(t),base=`http://127.0.0.1:${f.config.port}/`;
  const placement=f.page.result.placementIds[0],itemURL=`${base}boards/looks/#items/${placement}`;
  assert.equal(f.page.link,itemURL);
  assert.equal(f.board.link,`${base}boards/child/`);
  assert.equal((await callTool(f.config,'item.update',{itemId:f.page.result.itemId,patch:{description:'Changed'}})).link,itemURL);
  assert.equal((await callTool(f.config,'placement.update',{boardId:'looks',placementId:placement,patch:{x:40}})).link,itemURL);
  const shared=await callTool(f.config,'placement.reference',{sourceBoardId:'looks',placementIds:[placement],targetBoardId:'shortlist'});
  assert.equal(shared.link,`${base}boards/shortlist/#items/${shared.result.placementIds[0]}`);
  // On two boards: the first link, plus every place.
  const reviewed=await callTool(f.config,'item.review',{itemId:f.page.result.itemId,patch:{star:true}});
  assert.equal(reviewed.links.length,2);assert(reviewed.links.includes(itemURL));assert.equal(reviewed.link,reviewed.links[0]);
  const both=await callTool(f.config,'placement.translate',{boardId:'looks',placementIds:[placement,f.picture.result.placementIds[0]],dx:10,dy:0});
  assert.equal(both.link,`${base}boards/looks/`);assert.equal(both.links.length,2);
  const arranged=await callTool(f.config,'placement.arrange',{boardId:'looks',placements:[{id:placement,x:0,y:0},{id:f.picture.result.placementIds[0],x:400,y:0}]});
  assert.ok(arranged.history,'arrange returns movement history');assert.equal(arranged.links.length,2);
  await assert.rejects(callTool(f.config,'placement.arrange',{boardId:'looks',placements:[{id:placement,x:0}]}),e=>e.status===400);
  const drawn=(await callTool(f.config,'decoration.create',{boardId:'looks',decoration:{type:'text',x:0,y:600,width:100,height:40,color:'#222222',text:'Gone'}})).result.decorationId;
  const cleared=await callTool(f.config,'placement.remove',{boardId:'looks',placementIds:[],decorationIds:[drawn]});
  assert.deepEqual(cleared.result.decorationIds,[drawn]);assert.ok(cleared.history,'one undo step');
  assert.equal((await callTool(f.config,'decoration.create',{boardId:'looks',decoration:{type:'text',x:0,y:0,width:100,height:40,color:'#222222',text:'Hi'}})).link,`${base}boards/looks/`);
  assert.equal((await callTool(f.config,'placement.remove',{boardId:'looks',placementIds:[placement]})).link,`${base}boards/looks/`);
  assert.equal((await callTool(f.config,'item.delete',{itemIds:[f.missing.result.itemId]})).link,undefined);
  assert.equal((await callTool(f.config,'board.get',{boardId:'looks'})).link,undefined,'reads are unchanged');
  const viaApply=await callTool(f.config,'workspace.apply',{operation:{type:'updateItem',itemId:f.picture.result.itemId,patch:{title:'Picture 2'}}});
  assert.equal(viaApply.link,`${base}boards/looks/#items/${f.picture.result.placementIds[0]}`);
  const viaOp=JSON.parse(await main(['workspace','op','--config',f.config.configPath,'--json',JSON.stringify({type:'updateItem',itemId:f.picture.result.itemId,patch:{title:'Picture 3'}})]));
  assert.equal(viaOp.link,viaApply.link);
});
