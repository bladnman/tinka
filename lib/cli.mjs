#!/usr/bin/env node
import {mkdir,open,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {updateBuildState} from './boards.mjs';
import {DEFAULT_PORT,loadConfig,validatePort} from './config.mjs';
import {assertSlug,isInside} from './paths.mjs';
import {claimRuntime,removeRuntime,startManaged,stopManaged,writeRuntime} from './runtime.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {addBoardGuide,initializeProject} from './project.mjs';
import {boardDirectory} from './paths.mjs';
import {readWorkspace,workspaceHeader,applyOperation,getItemSnapshot} from './workspace.mjs';
import {listTools,callTool} from './tools.mjs';
import {migrateLegacy} from './migrate.mjs';
import {withStore} from './store.mjs';
import {withAppLock} from '../scripts/install.mjs';
import {checkForUpdates, updateCommand, runningInstance} from './updates.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const usage=`Usage:
  node cli.mjs project init --project PATH [--boards design/boards] [--label TEXT]
  node cli.mjs init --config PATH --boards PATH [--port auto|NUMBER] [--label TEXT]
  node cli.mjs serve|start|stop --config PATH
  node cli.mjs update now|later|status --config PATH
  node cli.mjs update policy notify|auto|off --config PATH
  node cli.mjs board create SLUG --config PATH --title TEXT [--description TEXT]
  node cli.mjs board guide SLUG --config PATH
  node cli.mjs status --config PATH --board SLUG ROUND/CONCEPT building|review|ready|reserved [MESSAGE]
  node cli.mjs workspace init|migrate --config PATH [--dry-run|--apply]
  node cli.mjs workspace show --config PATH
  node cli.mjs workspace op --config PATH --json JSON|--file PATH
  node cli.mjs item show ITEM_ID --config PATH
  node cli.mjs tools list [--summary]
  node cli.mjs tools describe NAME
  node cli.mjs tools call NAME --config PATH [--json JSON|--file PATH]`;
function parse(args){
  const positionals=[];const options={};
  for(let index=0;index<args.length;index++){
    const item=args[index];
    if(item.startsWith('--')){const key=item.slice(2);if(!key||options[key]!==undefined)throw new Error(`Invalid option ${item}.`);if(['apply','dry-run','summary'].includes(key)){options[key]=true;continue;}if(index===args.length-1||args[index+1].startsWith('--'))throw new Error(`Invalid option ${item}.`);options[key]=args[++index];}
    else positionals.push(item);
  }
  return {positionals,options};
}
function external(target){if(isInside(appRoot,path.resolve(target)))throw new Error('Config and boards must live outside the application folder.');}
async function init(options){
  if(!options.config||!options.boards)throw new Error(usage);
  const configPath=path.resolve(options.config);
  const boardsPath=path.resolve(options.boards);
  external(configPath);external(boardsPath);
  if(!path.isAbsolute(options.boards))throw new Error('--boards must be an absolute path.');
  const portMode=!options.port||options.port==='auto'?'auto':'fixed';
  const port=portMode==='auto'?DEFAULT_PORT:validatePort(options.port);
  const projectLabel=(options.label||path.basename(process.cwd())).trim();
  if(!projectLabel)throw new Error('--label must be nonempty.');
  const title=(options.title||'Tinka').trim();if(!title)throw new Error('Title is required.');
  await mkdir(boardsPath,{recursive:true});
  const boardsRoot=await realpath(boardsPath);external(boardsRoot);
  await mkdir(path.dirname(configPath),{recursive:true});
  external(await realpath(path.dirname(configPath)));
  const file=await open(configPath,'wx');
  try{await file.writeFile(`${JSON.stringify({schemaVersion:1,port,portMode,projectLabel,boardsRoot,title},null,2)}\n`);await file.sync();}finally{await file.close();}
  return `Created config at ${configPath}`;
}
async function createBoard(config,slug,options){
  assertSlug(slug);
  const title=options.title?.trim();if(!title)throw new Error('--title is required.');
  const description=(options.description||'').trim();
  const directory=path.join(config.boardsRoot,slug);
  await mkdir(directory);
  try{
    const files=[
      ['board.json',{schemaVersion:1,title,description,createdAt:new Date().toISOString()}],
      ['rounds.json',{rounds:[],revisions:{}}],
      ['build-state.json',{concepts:{}}]
    ];
    await Promise.all(files.map(([name,data])=>writeFile(path.join(directory,name),`${JSON.stringify(data,null,2)}\n`,{flag:'wx'})));
    await mkdir(path.join(directory,'.state'));
    await writeFile(path.join(directory,'.state','notes.json'),'{}\n',{flag:'wx'});
    await addBoardGuide(directory);
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  return `Created board ${slug}`;
}
export async function main(args=process.argv.slice(2),{lockToken}={}){
  const withOperationLock=action=>withAppLock(appRoot,action,{token:lockToken});
  const {positionals,options}=parse(args);
  const command=positionals[0];
  if(command==='tools'&&positionals[1]==='list'&&positionals.length===2){const catalog=listTools();return JSON.stringify(options.summary?{...catalog,tools:catalog.tools.map(({name,description,mutating})=>({name,description,...(mutating?{mutating}: {})}))}:catalog,null,2);}
  if(command==='tools'&&positionals[1]==='describe'&&positionals.length===3){const tool=listTools().tools.find(tool=>tool.name===positionals[2]);if(!tool)throw new Error('Unknown Tinka tool.');return JSON.stringify(tool,null,2);}
  if(command==='project'&&positionals[1]==='init'&&positionals.length===2)return initializeProject(options,init);
  if(command==='init'&&positionals.length===1)return init(options);
  if(!options.config)throw new Error(usage);
  const config=await loadConfig(options.config);
  if(command==='tools'&&positionals[1]==='call'&&positionals.length===3){
    if(options.json&&options.file)throw new Error('Provide --json or --file, not both.');
    const input=JSON.parse(options.json|| (options.file?await readFile(path.resolve(options.file),'utf8'):'{}'));
    return JSON.stringify(await callTool(config,positionals[2],input),null,2);
  }
  if(command==='workspace'&&positionals.length===2){
    if(['init','migrate'].includes(positionals[1])){if(options.apply&&options['dry-run'])throw new Error('Choose --dry-run or --apply.');return JSON.stringify(await migrateLegacy(config,{dryRun:!options.apply}),null,2);}
    if(positionals[1]==='show')return JSON.stringify(await readWorkspace(config),null,2);
    if(positionals[1]==='op'){
      if(!!options.json===!!options.file)throw new Error('Provide exactly one of --json JSON or --file PATH.');
      const operation=JSON.parse(options.json||await readFile(path.resolve(options.file),'utf8'));
      return JSON.stringify(await applyOperation(config,operation),null,2);
    }
  }
  if(command==='item'&&positionals[1]==='show'&&positionals.length===3){const item=await getItemSnapshot(config,positionals[2]);if(!item)throw new Error('Item not found.');return JSON.stringify(item,null,2);}
  if(command==='board'&&positionals[1]==='guide'&&positionals.length===3){
    const directory=await boardDirectory(config.boardsRoot,positionals[2]);
    const created=await addBoardGuide(directory);
    return created?`Added board instructions to ${directory}`:`Preserved existing instructions in ${directory}`;
  }
  if(command==='board'&&positionals[1]==='create'&&positionals.length===3){if((await workspaceHeader(config)).enabled){assertSlug(positionals[2]);if(!options.title?.trim())throw new Error('--title is required.');return JSON.stringify(await applyOperation(config,{type:'createBoard',id:positionals[2],title:options.title.trim(),description:options.description||''}),null,2);}return createBoard(config,positionals[2],options);}
  if(command==='status'&&positionals.length>=3&&positionals.length<=4){
    if(!options.board)throw new Error('--board is required.');
    const [key,state,message=({building:'Work is in progress.',review:'Ready for review.',ready:'Reviewed and ready to explore.',reserved:'Reserved for work.'})[state]||'']=positionals.slice(1);
    if(!['building','review','ready','reserved'].includes(state))throw new Error('Invalid state.');
    const selected=await withStore(config,async(_root,workspace)=>{
      const item=Object.values(workspace?.items||{}).find(item=>!item.deletedAt&&(item.id===key||item.legacy?.boardId===options.board&&item.legacy?.key===key));
      if(item)return {item,revision:workspace.metadata.revision};
      if(workspace?.boards[options.board])throw new Error('Unknown item or legacy concept key.');
      const updated=await updateBuildState(config,options.board,key,state,message);
      return {legacy:`${options.board} ${key}: ${updated.state}`};
    },{create:true});
    if(selected.legacy)return selected.legacy;
    return JSON.stringify(await applyOperation(config,{type:'updateItem',itemId:selected.item.id,expectedRevision:selected.revision,patch:{status:state,build:{...selected.item.build,state,message,updatedAt:Date.now()}}}),null,2);
  }
  if(command==='update')return withOperationLock(async token=>{
    const action=positionals[1]||'status';
    if(positionals.length>(action==='policy'?3:2))throw new Error(usage);
    const result=await updateCommand(config,action,positionals[2],{lockToken:token});
    return result.message;
  });
  if(command==='start'&&positionals.length===1){return withOperationLock(async token=>{
    const prior=await runningInstance(config,appRoot);
    let result={message:'',replaced:false};
    // Source checkouts have no installation receipt and are developed explicitly.
    const installed=await readFile(path.join(appRoot,'INSTALLATION.json'),'utf8').then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
    if(installed&&!(process.env.TINKA_SKIP_UPDATE==='1'&&process.env.TINKA_OPERATION_TOKEN===token)){
      try{result=await checkForUpdates(config,{running:!!prior,lockToken:token});}
      catch(error){result.message=`Tinka update check unavailable: ${error.message}`;}
    }
    if(result.replaced){
      const restarted=await promisify(execFile)(process.execPath,[path.join(appRoot,'cli.mjs'),'start','--config',config.configPath],{timeout:12000,env:{...process.env,TINKA_OPERATION_TOKEN:token,TINKA_SKIP_UPDATE:'1'}});
      return `${result.message}\n${restarted.stdout.trim()}`;
    }
    const record=prior||await startManaged(config,{lockToken:token});
    return `${result.message?`${result.message}\n`:''}Tinka / ${config.projectLabel} ${prior?'already running':'started'} on ${record.url} (PID ${record.pid})`;
  });}
  if(command==='stop'&&positionals.length===1)return withOperationLock(async()=>{const pid=await stopManaged(config);return `Tinka stopped (PID ${pid})`;});
  if(command==='serve'&&positionals.length===1){
    const token=options['managed-token']||randomUUID();
    let server;
    const cleanup=async()=>{
      if(server)await closeAppServer(server);
      await removeRuntime(config,token);
    };
    await withOperationLock(async()=>{
    await claimRuntime(config,token);
    try{
      server=await listen(config,{persist:true});
      await writeRuntime(config,token);
    }catch(error){await cleanup();throw error;}
    });
    process.once('SIGTERM',()=>{cleanup().then(()=>process.exit(0)).catch(()=>process.exit(1));});
    process.once('SIGINT',()=>{cleanup().then(()=>process.exit(0)).catch(()=>process.exit(1));});
    return `Tinka / ${config.projectLabel} listening on http://127.0.0.1:${server.address().port}/`;
  }
  throw new Error(usage);
}
