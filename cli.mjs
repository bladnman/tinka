#!/usr/bin/env node
import {mkdir,open,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {updateBuildState} from './lib/boards.mjs';
import {DEFAULT_PORT,loadConfig,validatePort} from './lib/config.mjs';
import {assertSlug,isInside} from './lib/paths.mjs';
import {claimRuntime,removeRuntime,startManaged,stopManaged,writeRuntime} from './lib/runtime.mjs';
import {listen} from './server.mjs';
import {addBoardGuide,initializeProject} from './lib/project.mjs';
import {boardDirectory} from './lib/paths.mjs';

const appRoot=path.dirname(fileURLToPath(import.meta.url));
const usage=`Usage:
  node cli.mjs project init --project PATH [--boards design/boards] [--label TEXT]
  node cli.mjs init --config PATH --boards PATH [--port auto|NUMBER] [--label TEXT]
  node cli.mjs serve|start|stop --config PATH
  node cli.mjs board create SLUG --config PATH --title TEXT [--description TEXT]
  node cli.mjs board guide SLUG --config PATH
  node cli.mjs status --config PATH --board SLUG ROUND/CONCEPT building|review|ready|reserved [MESSAGE]`;
function parse(args){
  const positionals=[];const options={};
  for(let index=0;index<args.length;index++){
    const item=args[index];
    if(item.startsWith('--')){const key=item.slice(2);if(!key||options[key]!==undefined||index===args.length-1||args[index+1].startsWith('--'))throw new Error(`Invalid option ${item}.`);options[key]=args[++index];}
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
export async function main(args=process.argv.slice(2)){
  const {positionals,options}=parse(args);
  const command=positionals[0];
  if(command==='project'&&positionals[1]==='init'&&positionals.length===2)return initializeProject(options,init);
  if(command==='init'&&positionals.length===1)return init(options);
  if(!options.config)throw new Error(usage);
  const config=await loadConfig(options.config);
  if(command==='board'&&positionals[1]==='guide'&&positionals.length===3){
    const directory=await boardDirectory(config.boardsRoot,positionals[2]);
    const created=await addBoardGuide(directory);
    return created?`Added board instructions to ${directory}`:`Preserved existing instructions in ${directory}`;
  }
  if(command==='board'&&positionals[1]==='create'&&positionals.length===3)return createBoard(config,positionals[2],options);
  if(command==='status'&&positionals.length>=3&&positionals.length<=4){
    if(!options.board)throw new Error('--board is required.');
    const [key,state,message=({building:'Work is in progress.',review:'Ready for review.',ready:'Reviewed and ready to explore.',reserved:'Reserved for work.'})[state]||'']=positionals.slice(1);
    const updated=await updateBuildState(config,options.board,key,state,message);
    return `${options.board} ${key}: ${updated.state}`;
  }
  if(command==='start'&&positionals.length===1){const record=await startManaged(config);return `Tinka / ${config.projectLabel} started on ${record.url} (PID ${record.pid})`;}
  if(command==='stop'&&positionals.length===1){const pid=await stopManaged(config);return `Tinka stopped (PID ${pid})`;}
  if(command==='serve'&&positionals.length===1){
    const token=options['managed-token']||randomUUID();
    await claimRuntime(config,token);
    let server;
    const cleanup=async()=>{
      if(server)await new Promise(resolve=>server.close(resolve));
      await removeRuntime(config,token);
    };
    try{
      server=await listen(config,{persist:true});
      await writeRuntime(config,token);
    }catch(error){await cleanup();throw error;}
    process.once('SIGTERM',()=>{cleanup().then(()=>process.exit(0)).catch(()=>process.exit(1));});
    process.once('SIGINT',()=>{cleanup().then(()=>process.exit(0)).catch(()=>process.exit(1));});
    return `Tinka / ${config.projectLabel} listening on http://127.0.0.1:${server.address().port}/`;
  }
  throw new Error(usage);
}
if(process.argv[1]&&await realpath(path.resolve(process.argv[1])).catch(()=>null)===fileURLToPath(import.meta.url)){
  try{process.stdout.write(`${await main()}\n`);}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
