// `board overview` saves a whole board as one image from the real board view.
// Checks a mixed graph board and a legacy board with a real headless Chromium:
// the image is sized to the board, shows every preview and no controls, and
// the ?overview page writes nothing and opens no live connection.
// Isolated external fixture, port 0.
import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deflateSync,crc32} from 'node:zlib';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {createAppServer,closeAppServer} from '../server.mjs';
import {saveOverview} from '../lib/overview.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=await mkdtemp(path.join(os.tmpdir(),'tinka-overview-browser-'));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'tinka-overview-evidence-'));
await mkdir(evidence,{recursive:true});
// Saved images never overwrite, so each run writes into its own folder.
const shots=await mkdtemp(path.join(evidence,'overview-'));

function solidPng([r,g,b],width=320,height=180){
  const row=Buffer.concat([Buffer.from([0]),Buffer.alloc(width*3).map((_,i)=>[r,g,b][i%3])]);
  const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]);const out=Buffer.alloc(body.length+8);out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body)>>>0,body.length+4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header.set([8,2,0,0,0],8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array(height).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}
const COLORS={red:[214,48,49],teal:[0,148,133],blue:[45,85,200]};
const pngSize=bytes=>({width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)});

let server,browser;const checks=[];
try{
  const configFile=path.join(fixture,'local/config.json'),boardsRoot=path.join(fixture,'boards');
  await main(['init','--config',configFile,'--boards',boardsRoot,'--label','Overview fixture']);
  await cp(path.join(repo,'examples/first-steps'),path.join(boardsRoot,'first-steps'),{recursive:true});
  const config=await loadConfig(configFile);
  await mkdir(path.join(fixture,'renders'),{recursive:true});
  for(const [name,color] of Object.entries(COLORS))await writeFile(path.join(fixture,`renders/${name}.png`),solidPng(color));
  await writeFile(path.join(fixture,'renders/proto.html'),'<!doctype html><body style="margin:0;background:#f7d34a;font:64px Georgia"><h1>Live prototype</h1>');
  await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:{renders:{path:'../../renders'}}}});
  const board=(await applyOperation(config,{type:'createBoard',id:'looks',title:'Looks · pick one'})).result.boardId;
  const op=operation=>applyOperation(config,{boardId:board,...operation});
  await op({type:'createItem',item:{title:'Which look? Star one.',content:{kind:'note',text:'My pick is teal.'}},placement:{x:0,y:0,width:420,height:300}});
  let x=460;for(const name of Object.keys(COLORS)){await op({type:'createItem',item:{title:`Look ${name}`,content:{kind:'image',resource:{rootId:'renders',path:`${name}.png`}}},placement:{x,y:0,width:640,height:400,presentation:{mode:'panel'}}});x+=680;}
  await op({type:'createItem',item:{title:'Prototype',content:{kind:'html',resource:{rootId:'renders',path:'proto.html'}}},placement:{x:0,y:440,width:642,height:486,presentation:{mode:'panel',viewport:{width:640,height:440}}}});
  await op({type:'createItem',item:{title:'Still building',build:{state:'building',message:'Rendering the last look.'}},placement:{x:700,y:440,width:420,height:300}});
  await op({type:'createDecoration',decoration:{type:'region',shape:'rectangle',x:1200,y:440,width:260,height:200,color:'#f6e6a4',text:'Sticky stays'}});

  server=createAppServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const executable=process.env.CHROMIUM_EXECUTABLE||chromium.executablePath();

  // The page itself: board title only, no controls, no writes, no live stream.
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),requests=[],errors=[];
  page.on('request',request=>requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${url}boards/looks/?overview`);
  await page.waitForFunction(()=>['ready','partial','error'].includes(document.documentElement.dataset.overview),null,{timeout:30000});
  const view=await page.evaluate(()=>{
    const shown=selector=>[...document.querySelectorAll(selector)].some(node=>getComputedStyle(node).display!=='none'&&node.getClientRects().length);
    return {state:document.documentElement.dataset.overview,items:Number(document.documentElement.dataset.overviewItems),title:document.getElementById('board-title').textContent,
      controls:['#chrome-actions','.canvas-footer','.project-navigator-toggle','#project-label','.workspace-tile-toolbar','.workspace-select-dot','.workspace-resize','.workspace-preview-launch'].filter(shown),
      building:document.querySelector('.workspace-build-placeholder strong')?.textContent,sticky:document.body.textContent.includes('Sticky stays')};
  });
  assert.equal(view.state,'ready');assert.equal(view.items,6);assert.equal(view.title,'Looks · pick one');
  assert.deepEqual(view.controls,[]);assert.equal(view.building,'In progress');assert.equal(view.sticky,true);
  assert.deepEqual(requests.filter(entry=>!entry.startsWith('GET ')),[]);
  assert(!requests.some(entry=>entry.includes('/api/events')),'no live connection');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(shots,'overview-page.png')});
  checks.push('overview page: title only, no controls, truthful building placeholder, sticky kept, GET only, no live stream');

  // The saved image: sized to the board and showing every preview.
  const pixels=async file=>{
    const probe=await browser.newPage();
    const result=await probe.evaluate(async([data,colors])=>{
      const image=new Image();image.src=`data:image/png;base64,${data}`;await image.decode();
      const canvas=Object.assign(document.createElement('canvas'),{width:image.width,height:image.height}),context=canvas.getContext('2d');
      context.drawImage(image,0,0);const {data:rgba}=context.getImageData(0,0,image.width,image.height);
      const counts=Object.fromEntries(Object.keys(colors).map(name=>[name,0]));
      for(let i=0;i<rgba.length;i+=4)for(const [name,[r,g,b]] of Object.entries(colors))if(Math.abs(rgba[i]-r)<6&&Math.abs(rgba[i+1]-g)<6&&Math.abs(rgba[i+2]-b)<6)counts[name]++;
      const corner=context.getImageData(4,image.height-4,1,1).data;
      return {counts,corner:[...corner].slice(0,3)};
    },[(await readFile(file)).toString('base64'),{...COLORS,prototype:[247,211,74]}]);
    await probe.close();return result;
  };
  const light=path.join(shots,'overview-light.png');
  const saved=await saveOverview({url,boardId:'looks',out:light,width:1600,browser:executable});
  assert.equal(saved.state,'ready');assert.equal(saved.items,6);
  assert.deepEqual(pngSize(await readFile(light)),{width:1600,height:saved.height});
  // The board is about 2460 × 926 units: (1600-48)·926/2460+48 plus the 52px title ≈ 684, not the first 16:10 window.
  assert(Math.abs(saved.height-684)<=12,`board-shaped height ${saved.height}`);
  const lit=await pixels(light);
  for(const [name,count] of Object.entries(lit.counts))assert(count>5000,`${name} preview visible (${count} pixels)`);
  assert(lit.corner.every(channel=>channel>200),`light canvas ${lit.corner}`);
  await assert.rejects(saveOverview({url,boardId:'looks',out:light,width:1600,browser:executable}),/EEXIST/);
  const dark=path.join(shots,'overview-dark.png');
  await saveOverview({url,boardId:'looks',out:dark,width:1200,appearance:'dark',browser:executable});
  const dim=await pixels(dark);
  assert(dim.corner.every(channel=>channel<80),`dark canvas ${dim.corner}`);
  for(const [name,count] of Object.entries(dim.counts))assert(count>2000,`${name} preview visible in dark (${count} pixels)`);
  checks.push('saved PNG is board-shaped at the requested width, shows all three looks and the live prototype, light and dark, never overwrites');

  // A person's own browser keeps its saved Grid layout and its newer local notes:
  // ?overview changes neither and sends nothing.
  const layoutKey=`tinka/${config.workspaceId}/looks/layout`,notesKey=`tinka/${config.workspaceId}/first-steps/notes`;
  await page.evaluate(([layoutKey,notesKey])=>{localStorage.setItem(layoutKey,'grid');localStorage.setItem(notesKey,JSON.stringify({'first/one-step':{note:'Only in this browser',star:true,updatedAt:Date.now()}}));},[layoutKey,notesKey]);
  await page.goto(`${url}boards/looks/?overview`);
  await page.waitForFunction(()=>document.documentElement.dataset.overview==='ready',null,{timeout:30000});
  assert.equal(await page.evaluate(()=>document.body.dataset.boardLayout),'canvas');
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),layoutKey),'grid');
  checks.push('a saved Grid layout in the person\'s browser is shown as Canvas and left unchanged');

  // A legacy board: experiment frames, no card controls or notes, no stuck "Connecting".
  await page.goto(`${url}boards/first-steps/?overview`);
  await page.waitForFunction(()=>document.documentElement.dataset.overview==='ready',null,{timeout:30000});
  const legacy=await page.evaluate(()=>({
    controls:['.card-actions','.note-box','.preview-launch'].filter(selector=>[...document.querySelectorAll(selector)].some(node=>getComputedStyle(node).display!=='none')),
    badges:[...document.querySelectorAll('.build-badge')].map(node=>node.textContent),frames:document.querySelectorAll('.concept-card iframe').length}));
  assert.deepEqual(legacy.controls,[]);assert.equal(legacy.frames,2);
  assert(!legacy.badges.includes('Connecting'),`legacy badges ${legacy.badges}`);
  const legacyImage=path.join(shots,'overview-legacy.png');
  assert.equal((await saveOverview({url,boardId:'first-steps',out:legacyImage,width:1400,browser:executable})).state,'ready');
  checks.push('legacy board: frames load, card controls and notes hidden, live badges read once');
  assert.deepEqual(requests.filter(entry=>!entry.startsWith('GET ')),[],'newer browser notes are not saved from an overview');
  assert.equal(JSON.parse(await readFile(path.join(boardsRoot,'first-steps/.state/notes.json'),'utf8').catch(()=>'{}'))['first/one-step']?.note,undefined);
  console.log(JSON.stringify({passed:true,evidence:shots,checks},null,1));
}finally{
  await browser?.close();
  if(server)await closeAppServer(server);
  await rm(fixture,{recursive:true,force:true});
}
