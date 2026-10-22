import http from 'node:http';
import {createReadStream} from 'node:fs';
import {realpath,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boardResponse,discoverBoards,loadBoard,readNotes,writeNotes} from './lib/boards.mjs';
import {loadConfig,publicConfig,VERSION,PORT_STEP,PORT_ATTEMPTS,savePort} from './lib/config.mjs';
import {createLiveState,createWorkspaceLiveState} from './lib/live.mjs';
import {boardDirectory,existingInside,HttpError,safeRelative} from './lib/paths.mjs';
import {readWorkspace,getBoardSnapshot,applyOperation,applyFileImport} from './lib/workspace.mjs';
import {migrateLegacy} from './lib/migrate.mjs';
import {resolveResource,resourceUrl} from './lib/resources.mjs';
import {withStore} from './lib/store.mjs';
import {createLinkPreview} from './lib/link-preview.mjs';
import {readImportRequest} from './lib/file-import.mjs';

const appRoot=path.dirname(fileURLToPath(import.meta.url));
const publicRoot=path.join(appRoot,'public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8','.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm','.woff2':'font/woff2'};
const noStore={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const closing=new WeakMap();
export function closeAppServer(server){
  if(!closing.has(server))closing.set(server,new Promise(resolve=>server.close(resolve)));
  return closing.get(server);
}
function sendJson(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...noStore});res.end(JSON.stringify(value));}
function decodeSegment(value){try{return decodeURIComponent(value);}catch{throw new HttpError(400,'Invalid URL encoding.');}}
function sendError(res,error){if(res.headersSent){res.destroy();return;}const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500;sendJson(res,status,{error:status===500?'Request failed.':error.message,...(error.revision!==undefined?{revision:error.revision}:{})});}
async function requestJson(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new HttpError(415,'Content-Type must be application/json.');
  let total=0;const chunks=[];
  for await(const chunk of req){total+=chunk.length;if(total>1_000_000)throw new HttpError(413,'Request too large.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Invalid JSON.');}
}
function checkWriteOrigin(req,server){
  const port=server.address()?.port;
  const allowed=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
  if(!allowed.has(`http://${req.headers.host}`)||req.headers.origin&&!allowed.has(req.headers.origin))throw new HttpError(403,'Cross-origin write denied.');
  if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'Cross-origin write denied.');
}
async function checkWrite(req,server,config){
  checkWriteOrigin(req,server);
  const current=await loadConfig(config.configPath).catch(()=>{throw new HttpError(403,'Workspace configuration changed. Restart this instance.');});
  if(req.headers['x-tinka-workspace']!==config.workspaceId||current.workspaceId!==config.workspaceId||current.workspaceRoot!==config.workspaceRoot)throw new HttpError(403,'Workspace changed. Reload before saving.');
}
async function loadGraphBoard(config,id){
  const board=await getBoardSnapshot(config,id);
  if(board)return board;
  // A deleted migrated board still has its original payload folder. It must
  // not reappear as a legacy board merely because its owner was tombstoned.
  const workspace=await readWorkspace(config);
  if(workspace?.boards.some(board=>board.id===id))throw new HttpError(404,'Board not found.');
  return null;
}
async function boardCatalog(config){
  const workspace=await readWorkspace(config);
  if(!workspace)return discoverBoards(config);
  const home=new Set(workspace.homeBoardIds||[]);
  const migrated=new Set(workspace.boards.flatMap(board=>[board.id,board.legacyBoardId,board.legacy?.boardId].filter(Boolean)));
  const legacy=await discoverBoards(config,{excludeIds:migrated});
  const items=new Map(workspace.items.map(item=>[item.id,item]));
  const boards=workspace.boards.filter(board=>home.has(board.id)&&!items.get(board.ownerItemId)?.deletedAt).map(board=>{
    const placements=(board.placements||[]).filter(p=>!p.archivedAt&&!p.removedAt&&!p.deletedAt);
    return {id:board.id,schemaVersion:2,ownerItemId:board.ownerItemId,title:board.title,description:board.description,createdAt:board.createdAt,updatedAt:board.updatedAt,conceptCount:placements.length,roundCount:board.rounds?.length||0,revisionCount:placements.reduce((sum,p)=>sum+(items.get(p.itemId)?.revisions?.length||0),0),buildingCount:placements.filter(p=>items.get(p.itemId)?.build?.state==='building').length,...(board.cover?{cover:board.cover}:{}),...(items.get(board.ownerItemId)?.preview?{preview:items.get(board.ownerItemId).preview}:{})};
  });
  return {...legacy,boards:[...legacy.boards.filter(board=>!migrated.has(board.id)),...boards],workspaceRevision:workspace.revision,revision:`${legacy.revision}:${workspace.revision}`};
}
async function sendFile(req,res,root,relative){
  const file=await existingInside(root,relative);
  const size=file.stat.size;
  const headers={'Content-Type':types[path.extname(file.path).toLowerCase()]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache','Accept-Ranges':'bytes'};
  const range=req.headers.range;
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match)throw new HttpError(416,'Invalid range.');
    const suffix=match[1]===''?Number(match[2]):null;
    const start=suffix!==null?Math.max(0,size-suffix):Number(match[1]);
    const requestedEnd=match[1]===''?size-1:match[2]===''?size-1:Number(match[2]);
    const end=Math.min(requestedEnd,size-1);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(requestedEnd)||suffix===0||start>end||start>=size)throw new HttpError(416,'Invalid range.');
    res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});
    if(req.method==='HEAD'){res.end();return;}
    createReadStream(file.path,{start,end}).on('error',()=>res.destroy()).pipe(res);return;
  }
  res.writeHead(200,{...headers,'Content-Length':size});
  if(req.method==='HEAD'){res.end();return;}
  createReadStream(file.path).on('error',()=>res.destroy()).pipe(res);
}

export function createAppServer(config){
  const live=new Map();
  const server=http.createServer(async(req,res)=>{
    // close() removes currently idle sockets. An accepted request can become
    // idle later, after its complete response (and any metadata write) drains.
    res.once('finish',()=>{if(closing.has(server))setImmediate(()=>server.closeIdleConnections());});
    try{
      const url=new URL(req.url,'http://localhost');
      let pathname=url.pathname;
      if(config.legacyBoard&&['/api/live','/api/notes'].includes(pathname))pathname=`/api/boards/${config.legacyBoard}/${pathname.slice(5)}`;
      const method=req.method;
      if(config.legacyBoard&&method==='GET'&&pathname==='/rounds.js'){
        const board=await loadBoard(config,config.legacyBoard);
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8',...noStore});
        res.end(`export const rounds=${JSON.stringify(board.manifest.rounds)};\nexport const revisions=${JSON.stringify(board.manifest.revisions)};\n`);return;
      }
      if(config.legacyBoard&&/^\/(rounds|shared|assets)\//.test(pathname))pathname=`/boards/${config.legacyBoard}/files${pathname}`;
      if(pathname==='/api/health'&&method==='GET'){sendJson(res,200,{app:'board-room',version:VERSION,configPath:config.configPath,boardsRoot:config.boardsRoot,projectLabel:config.projectLabel,workspaceId:config.workspaceId,port:server.address().port,url:`http://127.0.0.1:${server.address().port}/`});return;}
      if(pathname==='/api/config'&&method==='GET'){sendJson(res,200,publicConfig(config));return;}
      if(pathname==='/api/workspace'&&method==='GET'){const workspace=await readWorkspace(config,{covers:url.searchParams.get('covers')!=='0'});sendJson(res,200,workspace?{...workspace,enabled:true}:{enabled:false,revision:0});return;}
      if(pathname==='/api/imports'&&method==='POST'){
        await checkWrite(req,server,config);
        const controller=new AbortController();
        const cancel=()=>{if(!res.writableEnded)controller.abort();};
        req.once('aborted',cancel);res.once('close',cancel);
        try{const {metadata,files}=await readImportRequest(req);sendJson(res,200,await applyFileImport(config,metadata,files,{signal:controller.signal}));}
        finally{req.off('aborted',cancel);res.off('close',cancel);}
        return;
      }
      if(pathname==='/api/link-preview'&&method==='POST'){await checkWrite(req,server,config);const input=await requestJson(req);sendJson(res,200,await createLinkPreview(input?.url));return;}
      if(pathname==='/api/workspace/migrate'&&method==='POST'){await checkWrite(req,server,config);const input=await requestJson(req);if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.dryRun!=='boolean')throw new HttpError(400,'Provide dryRun: true or false explicitly.');sendJson(res,200,await migrateLegacy(config,{dryRun:input.dryRun}));return;}
      if(pathname==='/api/operations'&&method==='POST'){await checkWrite(req,server,config);const operation=await requestJson(req);if(!operation||typeof operation!=='object'||Array.isArray(operation)||typeof operation.type!=='string')throw new HttpError(400,'Provide an operation object with type.');sendJson(res,200,await applyOperation(config,operation));return;}
      const thumbnail=/^\/api\/items\/([^/]+)\/cover-thumbnail$/.exec(pathname);
      if(thumbnail&&method==='GET'){
        const item=await withStore(config,(_root,state)=>state?.items[decodeSegment(thumbnail[1])]);
        if(item?.deletedAt||item?.archivedAt)throw new HttpError(404,'Item not found.');
        if(!item?.content?.resource||item.content.kind!=='html'||item.content.url)throw new HttpError(404,'Local HTML preview not found.');
        const file=await resolveResource(config,item.content.resource);
        const base=resourceUrl(item.content.resource).split('/').slice(0,-1).join('/')+'/';
        // Local render helpers run without access to the parent or storage.
        // Nested documents, forms, network APIs and remote assets stay off.
        // Strip metadata as well so a prototype's refresh cannot navigate a tile.
        const html=(await readFile(file.path,'utf8')).replace(/<meta\b[^>]*>/gi,'').replace(/<base\b[^>]*>/gi,'');
        res.writeHead(200,{...noStore,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; sandbox allow-scripts"});
        res.end(/<head\b[^>]*>/i.test(html)?html.replace(/<head\b[^>]*>/i,head=>`${head}<base href="${base}">`):`<!doctype html><head><base href="${base}"></head>${html.replace(/<!doctype[^>]*>/i,'')}`);return;
      }
      const itemApi=/^\/api\/items\/([^/]+)(?:\/(review))?$/.exec(pathname);
      if(itemApi){
        const id=decodeSegment(itemApi[1]);
        if(method==='GET'&&!itemApi[2]){const workspace=await readWorkspace(config);const item=workspace?.items.find(item=>item.id===id&&!item.deletedAt);if(!item)throw new HttpError(404,'Item not found.');sendJson(res,200,item);return;}
        if(method==='PATCH'&&itemApi[2]){await checkWrite(req,server,config);const input=await requestJson(req);if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'Provide a review object.');const {expectedRevision,operationId,patch,...fields}=input;sendJson(res,200,await applyOperation(config,{type:'review',itemId:id,patch:patch||fields,...(expectedRevision!==undefined?{expectedRevision}:{}),...(operationId?{operationId}:{})}));return;}
        throw new HttpError(405,'Method not allowed.');
      }
      if(pathname==='/api/boards'&&method==='GET'){sendJson(res,200,await boardCatalog(config));return;}
      const api=/^\/api\/boards\/([^/]+)(?:\/(live|notes))?$/.exec(pathname);
      if(api){
        const id=decodeSegment(api[1]);
        const resource=api[2];
        if(resource==='notes'){
          const graph=await loadGraphBoard(config,id);
          if(method==='GET'){
            if(graph){const notes=graph.legacy?.boardId?await readNotes((await loadBoard(config,id)).root):{};for(const item of Object.values(graph.items))if(item.legacy?.key)notes[item.legacy.key]=item.review;sendJson(res,200,notes);return;}
            const board=await loadBoard(config,id);sendJson(res,200,await readNotes(board.root));return;
          }
          if(method==='PUT'){
            await checkWrite(req,server,config);const notes=await requestJson(req);
            await withStore(config,async(_root,state)=>{
              if(state?.boards[id])throw new HttpError(409,'This board now uses canonical item review. Reload and use the item review endpoint.');
              const board=await loadBoard(config,id);await writeNotes(board.root,notes);
            },{create:true});
            sendJson(res,200,{saved:true});return;
          }
        }else if(method==='GET'){
          const graph=await loadGraphBoard(config,id);
          if(graph){if(resource==='live'){const key=`workspace:${id}`;if(!live.has(key))live.set(key,createWorkspaceLiveState(config,id));sendJson(res,200,await live.get(key)());return;}sendJson(res,200,graph);return;}
          if(resource==='live'){
            if(!live.has(id))live.set(id,createLiveState(config,id));
            sendJson(res,200,await live.get(id)());return;
          }
          sendJson(res,200,boardResponse(await loadBoard(config,id)));return;
        }
        throw new HttpError(405,'Method not allowed.');
      }
      if(method!=='GET'&&method!=='HEAD')throw new HttpError(405,'Method not allowed.');
      if(pathname==='/'){await sendFile(req,res,publicRoot,'home.html');return;}
      const boardPage=/^\/boards\/([^/]+)\/?$/.exec(pathname);
      if(boardPage){const id=decodeSegment(boardPage[1]);if(!await loadGraphBoard(config,id))await boardDirectory(config.boardsRoot,id);await sendFile(req,res,publicRoot,'board.html');return;}
      if(pathname.startsWith('/app/')){await sendFile(req,res,publicRoot,safeRelative(pathname.slice('/app/'.length)));return;}
      const resourceFile=/^\/resources\/([^/]+)\/(.+)$/.exec(pathname);
      if(resourceFile){const resource=await resolveResource(config,{rootId:decodeSegment(resourceFile[1]),path:safeRelative(resourceFile[2])});await sendFile(req,res,resource.rootPath,path.relative(resource.rootPath,resource.path).split(path.sep).join('/'));return;}
      const boardFile=/^\/boards\/([^/]+)\/files\/(.+)$/.exec(pathname);
      if(boardFile){const boardRoot=await boardDirectory(config.boardsRoot,decodeSegment(boardFile[1]));await sendFile(req,res,boardRoot,safeRelative(boardFile[2]));return;}
      throw new HttpError(404,'Not found.');
    }catch(error){sendError(res,error);}
  });
  return server;
}
export async function listen(config,{port=config.port,persist=false}={}){
  const automatic=persist&&config.portMode==='auto';
  const attempts=automatic?PORT_ATTEMPTS:1;
  for(let attempt=0;attempt<attempts;attempt++){
    const candidate=port+attempt*PORT_STEP;
    if(candidate>65535)break;
    const server=createAppServer(config);
    try{
      await new Promise((resolve,reject)=>{
        const failed=error=>{server.off('listening',ready);reject(error);};
        const ready=()=>{server.off('error',failed);resolve();};
        server.once('error',failed);server.once('listening',ready);
        server.listen(candidate,'127.0.0.1');
      });
      if(persist)await savePort(config,server.address().port);
      return server;
    }catch(error){
      if(server.listening)await closeAppServer(server);
      if(error.code!=='EADDRINUSE')throw error;
      if(!automatic)throw new Error(`Port ${candidate} is already in use. This instance has a fixed port; choose another in its config. No other process was changed.`);
    }
  }
  throw new Error(`No free port in this instance's ${PORT_ATTEMPTS}-attempt range starting at ${port}, step ${PORT_STEP}. Set another port in its config.`);
}
if(process.argv[1]&&await realpath(path.resolve(process.argv[1])).catch(()=>null)===fileURLToPath(import.meta.url)){
  try{
    const {main}=await import('./cli.mjs');
    process.stdout.write(`${await main(['serve',...process.argv.slice(2)])}\n`);
  }catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
