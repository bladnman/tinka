import http from 'node:http';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boardResponse,discoverBoards,loadBoard,readNotes,writeNotes} from './lib/boards.mjs';
import {loadConfig,publicConfig,VERSION,PORT_STEP,PORT_ATTEMPTS,savePort} from './lib/config.mjs';
import {createLiveState} from './lib/live.mjs';
import {boardDirectory,existingInside,HttpError,safeRelative} from './lib/paths.mjs';

const appRoot=path.dirname(fileURLToPath(import.meta.url));
const publicRoot=path.join(appRoot,'public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8','.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm','.woff2':'font/woff2'};
const noStore={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
function sendJson(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...noStore});res.end(JSON.stringify(value));}
function sendError(res,error){if(res.headersSent){res.destroy();return;}const status=error instanceof HttpError?error.status:500;sendJson(res,status,{error:status===404?'Not found.':status===403?'Forbidden.':status===400?'Invalid request.':'Request failed.'});}
async function requestJson(req){
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
      if(pathname==='/api/boards'&&method==='GET'){sendJson(res,200,await discoverBoards(config));return;}
      const api=/^\/api\/boards\/([^/]+)(?:\/(live|notes))?$/.exec(pathname);
      if(api){
        const id=decodeURIComponent(api[1]);
        const resource=api[2];
        if(resource==='notes'){
          if(method==='GET'){const board=await loadBoard(config,id);sendJson(res,200,await readNotes(board.root));return;}
          if(method==='PUT'){checkWriteOrigin(req,server);if(req.headers['x-tinka-workspace']!==config.workspaceId)throw new HttpError(403,'Workspace changed. Reload before saving notes.');const board=await loadBoard(config,id);await writeNotes(board.root,await requestJson(req));sendJson(res,200,{saved:true});return;}
        }else if(method==='GET'){
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
      if(boardPage){await boardDirectory(config.boardsRoot,decodeURIComponent(boardPage[1]));await sendFile(req,res,publicRoot,'board.html');return;}
      if(pathname.startsWith('/app/')){await sendFile(req,res,publicRoot,safeRelative(pathname.slice('/app/'.length)));return;}
      const boardFile=/^\/boards\/([^/]+)\/files\/(.+)$/.exec(pathname);
      if(boardFile){const boardRoot=await boardDirectory(config.boardsRoot,decodeURIComponent(boardFile[1]));await sendFile(req,res,boardRoot,safeRelative(boardFile[2]));return;}
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
      if(server.listening)await new Promise(resolve=>server.close(resolve));
      if(error.code!=='EADDRINUSE')throw error;
      if(!automatic)throw new Error(`Port ${candidate} is already in use. This instance has a fixed port; choose another in its config. No other process was changed.`);
    }
  }
  throw new Error(`No free port in this instance's ${PORT_ATTEMPTS}-attempt range starting at ${port}, step ${PORT_STEP}. Set another port in its config.`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const {main}=await import('./cli.mjs');
    process.stdout.write(`${await main(['serve',...process.argv.slice(2)])}\n`);
  }catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
