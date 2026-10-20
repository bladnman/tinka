import {mkdir,readFile,writeFile,appendFile,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {VERSION,loadConfig} from './config.mjs';
import {isInside} from './paths.mjs';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function readOptional(file){try{return await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function createOnly(file,content){try{await writeFile(file,content,{flag:'wx'});return true;}catch(error){if(error.code==='EEXIST')return false;throw error;}}
async function existingAncestor(file){try{return await realpath(file);}catch(error){if(error.code!=='ENOENT')throw error;return existingAncestor(path.dirname(file));}}

export async function addBoardGuide(directory){
  return createOnly(path.join(directory,'AGENTS.md'),await readFile(path.join(appRoot,'docs/BOARD.md'),'utf8'));
}

// Durable project metadata uses relative paths. Machine-specific config and the
// replaceable app are reconstructed by the checked-in, standalone setup script.
export async function initializeProject(options,initializeConfig){
  if(!options.project)throw new Error('Provide --project /absolute/project.');
  const root=await realpath(path.resolve(options.project));
  const directory=path.join(root,'tinka');
  if(isInside(appRoot,directory))throw new Error('Project data must live outside the application folder.');
  await mkdir(directory,{recursive:true});
  if(await realpath(directory)!==directory)throw new Error('The project tinka folder must not be a symlink.');
  const manifestPath=path.join(directory,'project.json');
  const previousText=await readOptional(manifestPath);
  const previous=previousText===null?null:JSON.parse(previousText);
  if(previous&&(previous.schemaVersion!==1||typeof previous.boards!=='string'||typeof previous.projectLabel!=='string'))throw new Error('Invalid tinka/project.json.');
  const boards=options.boards||previous?.boards||'design/boards';
  const boardsPath=path.resolve(root,boards);
  if(path.isAbsolute(boards)||!isInside(root,boardsPath)||isInside(directory,boardsPath)||isInside(boardsPath,directory))throw new Error('Project boards must use a relative path inside the project, outside tinka/. Use init --config for external boards.');
  const label=(options.label||previous?.projectLabel||path.basename(root)).trim();
  if(!label)throw new Error('Project label must be nonempty.');
  if(previous&&(previous.boards!==boards||previous.projectLabel!==label))throw new Error('Existing project settings differ; edit tinka/project.json deliberately before changing them.');
  if(!isInside(root,await existingAncestor(boardsPath)))throw new Error('Project boards must remain inside this checkout, outside tinka/.');
  await mkdir(boardsPath,{recursive:true});
  const canonicalBoards=await realpath(boardsPath);
  if(!isInside(root,canonicalBoards)||isInside(directory,canonicalBoards))throw new Error('Project boards must remain inside this checkout, outside tinka/.');
  const local=path.join(directory,'local');
  await mkdir(local,{recursive:true});
  if(await realpath(local)!==local)throw new Error('The local config folder must not be a symlink.');
  const configPath=path.join(local,'config.json');
  const existingConfig=await readOptional(configPath);
  if(existingConfig){
    const config=JSON.parse(existingConfig);
    if(config.boardsRoot!==canonicalBoards||config.projectLabel!==label)throw new Error('Local config belongs to another location or project. Keep tinka/local untracked; inspect it before restoring this checkout.');
    // Validate an optional custom metadata root but retain the user's config
    // byte-for-byte. Portable setup restores the default under boardsRoot;
    // arbitrary custom absolute roots need their own deliberate restoration.
    const loaded=await loadConfig(configPath);
    const replaceable=path.join(directory,'app');
    if(isInside(replaceable,loaded.workspaceRoot)||isInside(loaded.workspaceRoot,replaceable))throw new Error('Workspace metadata must remain outside the replaceable app directory.');
  }else await initializeConfig({config:configPath,boards:canonicalBoards,label});
  const repo=options.repo||previous?.repo||'bladnman/tinka';
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))throw new Error('Project repository must be OWNER/REPO.');
  const manifest={schemaVersion:1,version:VERSION,projectLabel:label,boards,repo};
  if(previousText!==`${JSON.stringify(manifest,null,2)}\n`){
    const temporary=`${manifestPath}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx'});await rename(temporary,manifestPath);}finally{await rm(temporary,{force:true});}
  }
  await createOnly(path.join(directory,'setup.mjs'),await readFile(path.join(appRoot,'scripts/install.mjs')));
  const ignoreFile=path.join(directory,'.gitignore');
  const ignores=await readOptional(ignoreFile)||'';
  const missing=['/app/','/local/','/.app.backup-*/','/.app.stage-*/'].filter(rule=>!ignores.split('\n').includes(rule));
  if(missing.length)await appendFile(ignoreFile,`${ignores&&!ignores.endsWith('\n')?'\n':''}${missing.join('\n')}\n`);
  await createOnly(path.join(root,'TINKA.md'),`# Tinka in this project

This project's boards are in \`${boards}\`. Their manifests, experiments, assets,
handoffs and disk notes are durable project material. Keep them in version control,
including each board's \`.state/notes.json\`. Check your project's ignore rules.
The boards can be read and edited without installing a skill or running Tinka.

## Restore on a new machine

With Node.js 22 or newer, run from the project root:

\`\`\`sh
node tinka/setup.mjs
node tinka/app/cli.mjs start --config tinka/local/config.json
\`\`\`

Setup installs the version pinned in [tinka/project.json](tinka/project.json),
verifies its archive checksum, and rebuilds this machine's config using relative
project paths. Open the URL printed by start. No global skill or registry is needed.
Setup first uses a matching committed \`tinka/packages/tinka-vVERSION.zip\` and
its \`.sha256\` sidecar when present. Otherwise it needs network access, or a
local ZIP and checksum passed with \`--zip PATH --checksum PATH\`.

Before editing boards, read their \`AGENTS.md\` and the installed app's
[agent guide](tinka/app/docs/AGENT.md) and [protocol](tinka/app/docs/PROTOCOL.md).
If the app is absent, restore it or use the board's portable instructions.
Preserve earlier rounds, stable IDs, assets and notes. Record actual project
requirements, such as which board is the accepted style guide, in project guidance.

## What travels with Git

Commit \`TINKA.md\`, the project's \`AGENTS.md\` pointer, \`tinka/project.json\`,
\`tinka/setup.mjs\`, \`tinka/.gitignore\`, and all of \`${boards}/\`, including disk
notes. Browser-only view preferences are local. \`tinka/app/\` and \`tinka/local/\`
are ignored: setup restores the app and recreates config, logs and process state.
A dot folder is not automatically ignored by Git; verify the actual staged files.
An app can also be vendored deliberately if offline restoration is required.

Upgrade deliberately with \`node tinka/setup.mjs --version X.Y.Z\`, then review
and commit the changed version pin. Setup preserves existing boards and notes;
it never silently upgrades a checkout to the latest release.
`);
  const agentFile=path.join(root,'AGENTS.md');
  const instructions=await readOptional(agentFile)||'';
  if(!instructions.includes('TINKA.md'))await appendFile(agentFile,`${instructions.endsWith('\n')||!instructions?'':'\n'}\n## Tinka\n\nRead [TINKA.md](TINKA.md) before working with this project's Tinka boards. It identifies the boards and explains how to restore the pinned app on a new machine without a skill.\n`);
  return `Tinka project prepared. Commit TINKA.md, AGENTS.md, tinka/project.json, tinka/setup.mjs, tinka/.gitignore and ${boards}/ (including disk notes).\nRestore: node ${path.join(directory,'setup.mjs')}\nStart: node ${path.join(directory,'app/cli.mjs')} start --config ${configPath}`;
}
