import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig,publicConfig} from '../lib/config.mjs';

test('Home identifies portable roots independently of labels and app location',async()=>{
 const temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'tinka-home-project-')));
 try{
  for(const parent of ['north','south']){
   const root=path.join(temporary,parent,'same-project'),boards=path.join(root,'custom/nested/boards'),configPath=path.join(root,'tinka/local/config.json');
   await mkdir(boards,{recursive:true});await mkdir(path.dirname(configPath),{recursive:true});
   await writeFile(configPath,JSON.stringify({schemaVersion:1,port:45000,projectLabel:'Renamed label',boardsRoot:boards}));
   const manifest=path.join(root,'tinka/project.json');
   await writeFile(manifest,JSON.stringify({schemaVersion:1,projectLabel:'Original label',boards:'custom/nested/boards'}));
   const config=await loadConfig(configPath);
   assert.equal(config.projectRoot,root);assert.equal(publicConfig(config).projectRoot,root);
   // A stale or moved manifest must not assert a root for unrelated boards.
   await writeFile(manifest,JSON.stringify({schemaVersion:1,boards:'other/boards'}));
   assert.equal((await loadConfig(configPath)).projectRoot,null);
  }
  const boards=path.join(temporary,'manual-boards'),configPath=path.join(temporary,'manual.json');await mkdir(boards);
  await writeFile(configPath,JSON.stringify({schemaVersion:1,port:45000,projectLabel:'Renamed label',boardsRoot:boards}));
  const manual=await loadConfig(configPath);assert.equal(manual.projectRoot,null);assert.equal(manual.boardsRoot,boards);assert.equal(manual.configPath,configPath);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
