import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm,symlink,copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {buildRelease} from '../scripts/package.mjs';
import {main as cli} from '../cli.mjs';

const exec=promisify(execFile);
const json=async file=>JSON.parse(await readFile(file,'utf8'));

test('a Git checkout restores its pinned app and board notes at a different path without a skill',async()=>{
  const temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'tinka-checkout-')));
  const project=path.join(temporary,'original');
  const checkout=path.join(temporary,'new-machine');
  await mkdir(project);
  const release=await buildRelease({outDir:path.join(temporary,'release')});
  const sourceArgs=['--zip',release.appZip,'--checksum',release.appChecksum];
  const config=path.join(project,'tinka/local/config.json');
  const restoredConfig=path.join(checkout,'tinka/local/config.json');
  const restoredCli=path.join(checkout,'tinka/app/cli.mjs');
  try{
    await writeFile(path.join(project,'AGENTS.md'),'# Product rules\n\nKeep this existing guidance.\n');
    await exec(process.execPath,[release.installer,'--project',project,'--label','Portable project',...sourceArgs]);
    assert((await readFile(path.join(project,'tinka/.gitignore'),'utf8')).includes('/.app.operation-lock/'));
    const firstGuide=await readFile(path.join(project,'AGENTS.md'),'utf8');
    assert(firstGuide.startsWith('# Product rules\n\nKeep this existing guidance.\n'));
    const board=path.join(project,'design/boards/style-guide');
    await exec(process.execPath,[path.join(project,'tinka/app/cli.mjs'),'board','create','style-guide','--config',config,'--title','Product style guide']);
    const manifest={rounds:[{id:'first',title:'Accepted styles',concepts:[{id:'palette',name:'Palette',path:'palette.html'}]}],revisions:{}};
    await writeFile(path.join(board,'rounds.json'),JSON.stringify(manifest));
    await writeFile(path.join(board,'palette.html'),'<!doctype html><title>Accepted palette</title><h1>Our design</h1>');
    const notes='{"first/palette":{"note":"Accepted project style","star":true,"updatedAt":123}}\n';
    await writeFile(path.join(board,'.state/notes.json'),notes);
    assert((await readFile(path.join(board,'AGENTS.md'),'utf8')).includes('rounds.json'));
    const pinBefore=await readFile(path.join(project,'tinka/project.json'),'utf8');
    const setupBefore=await readFile(path.join(project,'tinka/setup.mjs'));
    await mkdir(path.join(project,'tinka/packages'));
    await copyFile(release.appZip,path.join(project,'tinka/packages',path.basename(release.appZip)));
    await copyFile(release.appChecksum,path.join(project,'tinka/packages',path.basename(release.appChecksum)));
    await exec('git',['init','--quiet',project]);
    await exec('git',['-C',project,'add','.']);
    const tracked=(await exec('git',['-C',project,'ls-files'])).stdout.trim().split('\n');
    assert(tracked.includes('tinka/setup.mjs'));
    assert(tracked.includes('design/boards/style-guide/.state/notes.json'));
    assert(!tracked.some(file=>file.startsWith('tinka/app/')||file.startsWith('tinka/local/')));
    await exec('git',['-C',project,'-c','user.name=Tinka Test','-c','user.email=test@example.invalid','commit','--quiet','-m','Portable project fixture']);
    await exec('git',['clone','--quiet','--no-hardlinks',project,checkout]);
    await assert.rejects(readFile(restoredCli),{code:'ENOENT'});
    await assert.rejects(readFile(restoredConfig),{code:'ENOENT'});
    // Restore offline with only the checked-in helper, pin and packaged app.
    await exec(process.execPath,[path.join(checkout,'tinka/setup.mjs')],{cwd:temporary});
    assert.equal((await json(restoredConfig)).boardsRoot,path.join(checkout,'design/boards'));
    assert.equal(await readFile(path.join(checkout,'tinka/project.json'),'utf8'),pinBefore);
    assert.deepEqual(await readFile(path.join(checkout,'tinka/setup.mjs')),setupBefore);
    assert.equal(await readFile(path.join(checkout,'design/boards/style-guide/.state/notes.json'),'utf8'),notes);
    assert.deepEqual(await json(path.join(checkout,'design/boards/style-guide/rounds.json')),manifest);
    assert.equal(await readFile(path.join(checkout,'AGENTS.md'),'utf8'),firstGuide);
    assert.equal((await exec('git',['-C',checkout,'status','--porcelain'])).stdout,'');
    const repeat=await exec(process.execPath,[path.join(checkout,'tinka/setup.mjs')]);
    assert(repeat.stdout.includes('already installed'));
    await exec(process.execPath,[restoredCli,'start','--config',restoredConfig]);
    const runtime=await json(`${restoredConfig}.pid.json`);
    const health=await (await fetch(`${runtime.url}api/health`)).json();
    assert.equal(health.configPath,restoredConfig);
    assert.equal(health.projectLabel,'Portable project');
    const exposed=await (await fetch(`${runtime.url}api/config`)).json();
    assert.equal(exposed.protocolPath,path.join(checkout,'tinka/app/docs/PROTOCOL.md'));
    const boards=await (await fetch(`${runtime.url}api/boards`)).json();
    assert.equal(boards.boards[0].id,'style-guide');
    assert.equal(await (await fetch(`${runtime.url}api/boards/style-guide/notes`)).text(),notes.trim());
    assert((await (await fetch(`${runtime.url}boards/style-guide/files/palette.html`)).text()).includes('Our design'));
  }finally{
    await exec(process.execPath,[restoredCli,'stop','--config',restoredConfig]).catch(()=>{});
    await rm(temporary,{recursive:true,force:true});
  }
});

test('project pin mismatches and external boards fail before installation; board guides preserve edits',async()=>{
  const temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'tinka-project-boundary-')));
  const project=path.join(temporary,'project');
  await mkdir(project);
  const release=await buildRelease({outDir:path.join(temporary,'release')});
  try{
    await cli(['project','init','--project',project]);
    const config=path.join(project,'tinka/local/config.json');
    await cli(['board','create','existing','--config',config,'--title','Existing']);
    const guide=path.join(project,'design/boards/existing/AGENTS.md');
    await writeFile(guide,'Project-specific board rules.\n');
    await cli(['board','guide','existing','--config',config]);
    assert.equal(await readFile(guide,'utf8'),'Project-specific board rules.\n');
    await rm(guide);
    await cli(['board','guide','existing','--config',config]);
    assert((await readFile(guide,'utf8')).includes('rounds.json'));
    const manifest=path.join(project,'tinka/project.json');
    const pin=await json(manifest);
    await writeFile(manifest,JSON.stringify({...pin,version:'99.99.99'}));
    await assert.rejects(exec(process.execPath,[path.join(project,'tinka/setup.mjs'),'--zip',release.appZip,'--checksum',release.appChecksum]),/Archive version does not match/);
    await assert.rejects(readFile(path.join(project,'tinka/app/package.json')),{code:'ENOENT'});
    assert.equal((await json(manifest)).version,'99.99.99');
    const other=path.join(temporary,'escape');await mkdir(other);
    await assert.rejects(cli(['project','init','--project',other,'--boards','../outside']),/relative path inside/);
    await symlink(path.join(temporary,'project'),path.join(other,'linked'));
    await assert.rejects(cli(['project','init','--project',other,'--boards','linked/boards']),/inside this checkout/);
  }finally{await rm(temporary,{recursive:true,force:true});}
});
