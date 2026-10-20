import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,realpath,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {buildRelease} from '../scripts/package.mjs';
import {installArchive} from '../scripts/install.mjs';

test('replacement preserves a custom metadata root and rejects metadata inside or around the replaceable app',async t=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'tinka-workspace-install-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const release=await buildRelease({outDir:path.join(root,'release')});
  const archive={zipBytes:await readFile(release.appZip),checksumText:await readFile(release.appChecksum,'utf8'),zipName:path.basename(release.appZip)};
  const app=path.join(root,'app'),configPath=path.join(root,'config.json'),boards=path.join(root,'boards'),metadata=path.join(root,'durable-metadata');
  await installArchive({...archive,installDir:app});
  await main(['init','--config',configPath,'--boards',boards]);
  const source=JSON.parse(await readFile(configPath,'utf8'));
  await writeFile(configPath,JSON.stringify({...source,workspaceRoot:metadata}));
  await main(['workspace','init','--config',configPath,'--apply']);
  await main(['workspace','op','--config',configPath,'--json',JSON.stringify({type:'createBoard',id:'saved',title:'Retained'})]);
  const configBytes=await readFile(configPath),metadataBytes=await readFile(path.join(metadata,'workspace.json'));
  const result=await installArchive({...archive,installDir:app,configPath});assert(result.backup);
  assert.deepEqual(await readFile(configPath),configBytes);assert.deepEqual(await readFile(path.join(metadata,'workspace.json')),metadataBytes);
  await mkdir(path.join(app,'private-metadata'),{recursive:true});await writeFile(path.join(app,'private-metadata','keep.txt'),'must survive rejection');
  const alias=path.join(root,'app-alias');await symlink(app,alias);
  for(const workspaceRoot of [path.join(app,'private-metadata'),path.join(alias,'not-created'),root]){
    await writeFile(configPath,JSON.stringify({...source,workspaceRoot}));
    await assert.rejects(installArchive({...archive,installDir:app,configPath}),/Workspace metadata must remain outside/);
    assert.equal(await readFile(path.join(app,'private-metadata','keep.txt'),'utf8'),'must survive rejection');
  }
});

test('portable scaffolding preserves custom config deliberately and defaults metadata to durable boards',async t=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'tinka-workspace-project-')));t.after(()=>rm(root,{recursive:true,force:true}));
  await main(['project','init','--project',root,'--label','Portable']);
  const configPath=path.join(root,'tinka/local/config.json'),config=await loadConfig(configPath);
  assert.equal(config.workspaceRoot,path.join(root,'design/boards/.tinka'));
  const custom=path.join(root,'custom-workspace');
  const source=JSON.parse(await readFile(configPath,'utf8'));const text=JSON.stringify({...source,workspaceRoot:custom},null,2)+'\n';await writeFile(configPath,text);
  await main(['project','init','--project',root]);assert.equal(await readFile(configPath,'utf8'),text);
  await writeFile(configPath,JSON.stringify({...source,workspaceRoot:path.join(root,'tinka/app/private')}));
  await assert.rejects(main(['project','init','--project',root]),/outside the replaceable app/);
});
