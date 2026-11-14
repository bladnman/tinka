import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findBrowser,headlessCapture} from './overview.mjs';
import {getItemSnapshot,workspaceHeader} from './workspace.mjs';
import {findPlacement,itemLink,itemPlaces} from './links.mjs';

// `item shot` saves one Tinka's own content as a PNG, the thing the user decides
// on, at a readable size: an HTML prototype rendered at a chosen width (1280 by
// default, 390 for a phone), an image at its own size, a document as Tinka's
// reader shows it. It drives the same headless browser as `board overview`.

export const SHOT_WIDTH=1280,MAX_SHOT_HEIGHT=4000,MAX_IMAGE_SIDE=4000;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]']);
const resourcePath=({rootId,path:file})=>`resources/${encodeURIComponent(rootId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
const usable=ref=>ref&&typeof ref.rootId==='string'&&typeof ref.path==='string'&&ref.path.split('/').every(part=>part&&!part.startsWith('.'));
function loopbackURL(value){
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&LOOPBACK.has(url.hostname)?url.href:null;}catch{return null;}
}

// What to load for an item, without any browser: {kind:'page'|'image', url,
// tinkaPage?, what}. `page` renders at the chosen width; `image` at its own size.
export function shotSource(item,base,{appearance='light'}={}){
  const content=item.content||{},preview=usable(item.preview?.resource)?item.preview.resource:null;
  const image=(ref,what)=>({kind:'image',url:`${base}${resourcePath(ref)}`,what});
  const tinka=params=>({kind:'page',tinkaPage:true,url:`${base}app/${params}`});
  const theme=appearance==='dark'?'night':'paper';
  if(item.childBoardId&&!content.kind)return {board:item.childBoardId};
  if(content.kind==='html'){
    if(usable(content.resource))return {kind:'page',url:`${base}${resourcePath(content.resource)}?tinka=off`,what:'page'};
    const local=loopbackURL(content.url);
    if(local)return {kind:'page',url:local,what:'app',app:true};
    if(preview)return image(preview,'saved preview');
    return {remote:content.url||''};
  }
  if(content.kind==='image'&&usable(content.resource))return image(content.resource,'image');
  if(['pdf','video','audio'].includes(content.kind)&&preview)return image(preview,'saved preview');
  if(['markdown','pdf','video','audio','image'].includes(content.kind)&&usable(content.resource)){
    const params=new URLSearchParams({kind:content.kind,root:content.resource.rootId,path:content.resource.path,name:item.title||'',chrome:'none',theme,scale:'100'});
    return {...tinka(`media.html?${params}`),what:content.kind==='markdown'?'document':content.kind};
  }
  if(content.kind==='url'&&preview)return image(preview,'saved preview');
  return {...tinka(`item.html?${new URLSearchParams({item:item.id,theme})}`),what:'card'};
}

// Page-side scripts. Each starts with a marker comment (also used by the test
// browser). READY waits for load, fonts and images, at most 15 s.
export const READY=`/*ready*/(async()=>{const until=Date.now()+15000,pause=ms=>new Promise(r=>setTimeout(r,ms));
while(document.readyState!=='complete'&&Date.now()<until)await pause(100);
try{await Promise.race([document.fonts.ready,pause(3000)]);}catch{}
let last=-1;for(;;){const waiting=[...document.images].some(i=>!i.complete),count=performance.getEntriesByType('resource').length;
if(!waiting&&count===last)break;if(Date.now()>until)return 'partial';last=count;await pause(250);}
await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return 'ready';})()`;
// Tinka's own reader pages scroll inside a box and carry reader controls; let
// them flow and hide the controls so only the work is in the picture. Their
// height is where the content ends, not the window's.
export const FLOW=`/*flow*/(()=>{const s=document.createElement('style');s.textContent='html,body,.item-content{height:auto!important;min-height:0!important;overflow:visible!important}#media-content,#item-content{overflow:visible!important;flex:none!important;height:auto!important;min-height:0!important}#open-original,.document-tools,.document-selection-tools,.document-annotations,.document-status,.document-paint-layer,.workspace-inline-actions,.item-representation a.workspace-button,.item-representation button,.item-hint{display:none!important}';document.head.append(s);
const bottom=Math.max(0,...[...document.querySelectorAll('body *')].map(n=>{const r=n.getBoundingClientRect();return r.width&&r.height?r.bottom+scrollY:0;}));
document.documentElement.dataset.shotHeight=String(Math.ceil(bottom+40));return true;})()`;
export const MEASURE=`/*measure*/(()=>{const d=document.documentElement,b=document.body,i=document.contentType.startsWith('image/')&&document.images[0];
return JSON.stringify({height:Number(d.dataset.shotHeight)||Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0)),imageWidth:i?i.naturalWidth:0,imageHeight:i?i.naturalHeight:0,title:document.title});})()`;
const frame=()=>new Promise(resolve=>setTimeout(resolve,150));

// An image keeps its own pixels, scaled down only to fit MAX_IMAGE_SIDE (and
// --width when given).
export function imageSize({imageWidth,imageHeight},limit){
  if(!(imageWidth>0&&imageHeight>0))return null;
  const ratio=Math.min(1,(limit||MAX_IMAGE_SIDE)/imageWidth,MAX_IMAGE_SIDE/imageHeight);
  return {width:Math.max(1,Math.round(imageWidth*ratio)),height:Math.max(1,Math.round(imageHeight*ratio))};
}

export async function saveShot({source,out,width=SHOT_WIDTH,height,scale=2,appearance='light',browser,timeout=45000,widthGiven=false}){
  return headlessCapture({browser,out,timeout,what:'shot'},async call=>{
    const evaluate=async expression=>(await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}))?.result?.value;
    const first={width,height:height||Math.round(width<=600?width*844/390:width*0.625)};
    const pixelScale=source.kind==='image'?1:scale;
    await call('Emulation.setDeviceMetricsOverride',{...first,deviceScaleFactor:pixelScale,mobile:false});
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:appearance}]});
    const navigation=await call('Page.navigate',{url:source.url});
    if(navigation.errorText)throw new Error(`The item did not load (${navigation.errorText}). Nothing was saved.`);
    let state=await evaluate(READY)||'partial';
    if(source.tinkaPage)await evaluate(FLOW);
    const page=JSON.parse(await evaluate(MEASURE)||'{}');
    if(source.kind==='image'){
      const size=imageSize(page,widthGiven?width:0);
      if(!size)throw new Error('The image did not load. Nothing was saved.');
      await call('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false});
      await frame();
      const {data}=await call('Page.captureScreenshot',{format:'png'});
      return {data,state,...size,scale:1,cropped:false};
    }
    const full=Math.max(200,Number(page.height)||first.height);
    const shown=height||Math.min(full,MAX_SHOT_HEIGHT);
    // Capture beyond the viewport rather than resizing it, so a page laid out
    // to the window's height (100vh) keeps the look it has in a real window.
    const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:shown,scale:1}});
    return {data,state,width,height:shown,scale:pixelScale,cropped:!height&&full>MAX_SHOT_HEIGHT,fullHeight:full};
  });
}

const cliPath=()=>path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),'cli.mjs');
const integer=(value,name,min,max,fallback)=>{
  if(value===undefined)return fallback;
  const number=Number(value);
  if(!Number.isInteger(number)||number<min||number>max)throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
};

export async function itemShot(config,target,options,{running,find=findBrowser,save=saveShot}={}){
  if(typeof target!=='string'||!ID.test(target))throw new Error('Name the item or placement ID to shoot.');
  if(!options.out)throw new Error('Provide --out /absolute/shot.png.');
  const out=path.resolve(options.out);
  if(path.extname(out).toLowerCase()!=='.png')throw new Error('--out must name a .png file.');
  if(await access(out).then(()=>true,()=>false))throw new Error(`${out} already exists. Choose a new file name or remove the old one.`);
  const width=integer(options.width,'--width',320,2560,SHOT_WIDTH);
  const height=integer(options.height,'--height',200,MAX_SHOT_HEIGHT,undefined);
  const scale=integer(options.scale,'--scale',1,2,2);
  const appearance=options.appearance||'light';
  if(!['light','dark'].includes(appearance))throw new Error('--appearance must be light or dark.');
  if(options.board!==undefined&&!ID.test(options.board))throw new Error('--board must be a board ID.');
  if(!(await workspaceHeader(config)).enabled)throw new Error('item shot needs a workspace (schema 2). For a legacy board use board overview.');
  const placement=await findPlacement(config,target);
  const item=await getItemSnapshot(config,placement?.itemId||target);
  if(!item||item.deletedAt)throw new Error(`No item or placement ${target}.`);
  let places=placement?[placement]:await itemPlaces(config,item.id,{preferBoard:options.board});
  if(options.board&&!places.some(place=>place.boardId===options.board))throw new Error(`${item.title||item.id} is not on board ${options.board}.`);
  if(options.board)places=places.filter(place=>place.boardId===options.board).concat(places.filter(place=>place.boardId!==options.board));
  const instance=await running(config);
  if(!instance)throw new Error(`This project's Tinka is not running. Start it first: node ${cliPath()} start --config ${config.configPath}`);
  const source=shotSource(item,instance.url,{appearance});
  if(source.board)throw new Error(`${item.title||item.id} is a board. Save it as one image with: node ${cliPath()} board overview ${source.board} --config ${config.configPath} --out ${out}`);
  if(source.remote!==undefined)throw new Error(`${item.title||item.id} shows a remote page, which item shot does not load. Give the item a saved preview image, or screenshot the page yourself.`);
  const response=await fetch(source.url,{cache:'no-store'}).catch(()=>null);
  await response?.body?.cancel();
  if(!response)throw new Error(source.app?`Its app at ${source.url} is not answering. Start it${item.content?.startInstructions?` (${item.content.startInstructions})`:''}, then retry.`:`Tinka did not answer at ${instance.url}.`);
  if(response.status===404)throw new Error(`The file for ${item.title||item.id} is missing (${new URL(source.url).pathname}).`);
  if(!response.ok)throw new Error(`${item.title||item.id} could not be read (${response.status}).`);
  const browser=await find();
  if(!browser)throw new Error(`No Chrome, Chromium, Edge or Brave was found for the headless render. Set CHROMIUM_EXECUTABLE to one, or open ${source.url} in a browser and save a screenshot.`);
  const result=await save({source,out,width,height,scale,appearance,browser,widthGiven:options.width!==undefined});
  const pixels=`${result.width*result.scale} × ${result.height*result.scale}`;
  const notes=[
    result.state==='ready'?'':'Some images had not finished loading; check the picture.',
    result.cropped?`The page is ${result.fullHeight} px tall; the picture shows its first ${result.height} (use --height to choose).`:''
  ].filter(Boolean);
  const link=places.length?`Tinka link: ${itemLink(instance.url,places[0].boardId,places[0].placementId)}${places.length>1?` (also on ${places.length-1} other ${places.length===2?'board':'boards'})`:''}`:'Not on an active board, so it has no Tinka link.';
  return [`Saved a shot of ${JSON.stringify(item.title||item.id)} (${source.what}, ${pixels} pixels) to ${out}.${notes.length?` ${notes.join(' ')}`:''}`,link].join('\n');
}
