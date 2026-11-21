import './helpers/offline.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,access,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {main as cli} from '../cli.mjs';
import {TINKA_SECTION,TINKA_START,TINKA_END,PREVIOUS_TINKA_SECTIONS,tinkaBlock} from '../lib/project.mjs';

const [ONE_LINER,UNMARKED_0_7_6]=PREVIOUS_TINKA_SECTIONS;
const BLOCK=tinkaBlock();
const crlf=text=>text.replaceAll('\n','\r\n');
const exists=file=>access(file).then(()=>true,()=>false);
async function project(files,{pinned=true}={}){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'tinka-agent-section-')));
  // A minimal existing portable pin, as an installed project has.
  if(pinned){await mkdir(path.join(root,'tinka'));await writeFile(path.join(root,'tinka/project.json'),JSON.stringify({schemaVersion:1,version:'0.7.5',projectLabel:path.basename(root),boards:'design/boards',repo:'bladnman/tinka'}));}
  for(const [name,content] of Object.entries(files))await writeFile(path.join(root,name),content);
  return {root,init:()=>cli(['project','init','--project',root]),instructions:()=>cli(['project','instructions','--project',root]),
    read:name=>readFile(path.join(root,name),'utf8'),done:()=>rm(root,{recursive:true,force:true})};
}

test('the managed block routes visual work and verifies the current instance concisely',()=>{
  assert.equal(BLOCK,`${TINKA_START}\n${TINKA_SECTION}\n${TINKA_END}`);
  assert.match(TINKA_START,/^<!-- tinka:start .*-->$/);
  assert.equal(TINKA_END,'<!-- tinka:end -->');
  assert(TINKA_SECTION.split('\n').length<=19);
  assert.match(TINKA_SECTION,/^## Tinka\n/);
  // The board is added to the usual way of showing work, not substituted for it.
  assert.match(TINKA_SECTION,/add it to a board as well as showing\nit the way you otherwise would/);
  // The direct link to what changed, with the reason, as a firm habit.
  assert.match(TINKA_SECTION,/Always\ngive the user the Tinka link to exactly what you added or changed \(the `link` in each tool\nresult\), not just the board or Home; it lets them review and decide fast\./);
  // A picture is a suggestion for when the user may be away or just needs to see it.
  assert.match(TINKA_SECTION,/may be away \(on a phone, say\) or just needs to see it, consider\nalso sending a picture with the link \(`item shot` or `board overview`/);
  assert.doesNotMatch(TINKA_SECTION,/instead of/);
  assert.match(TINKA_SECTION,/open only on\sthis computer/);
  assert.match(TINKA_SECTION,/\[TINKA\.md\]\(TINKA\.md\)/);
  assert.match(TINKA_SECTION,/Whenever opening or returning to boards, run this project's config-specific `start`/);
  assert.match(TINKA_SECTION,/even if a saved URL answers/);
  assert.match(TINKA_SECTION,/canonical config path, boards root and project label/);
  assert.match(TINKA_SECTION,/`linkPath` with `startCommand`/);
  assert.match(TINKA_SECTION,/Relay any port-collision notice and the new URL/);
});

test('setup adds the block to AGENTS.md only; CLAUDE.md is never written',async()=>{
  const agentsOnly=await project({'AGENTS.md':'# Product rules\n\nSee TINKA.md later.\n'});
  const neither=await project({});
  const claudeOnly=await project({'CLAUDE.md':'# Claude rules\n\nKeep these.'});
  try{
    await agentsOnly.init();
    assert.equal(await agentsOnly.read('AGENTS.md'),`# Product rules\n\nSee TINKA.md later.\n\n${BLOCK}\n`);
    await neither.init();
    assert.equal(await neither.read('AGENTS.md'),`${BLOCK}\n`);
    assert(!await exists(path.join(neither.root,'CLAUDE.md')));
    const message=await claudeOnly.init();
    assert.equal(await claudeOnly.read('AGENTS.md'),`${BLOCK}\n`);
    assert.equal(await claudeOnly.read('CLAUDE.md'),'# Claude rules\n\nKeep these.');
    assert.match(message,/Commit TINKA\.md, AGENTS\.md,/);
  }finally{for(const fixture of [agentsOnly,neither,claudeOnly])await fixture.done();}
});

test('the block between markers is replaced, earlier unmarked texts migrate, all else stays byte-identical',async()=>{
  const before='# Rules\n\nKeep this.\n\n',after='\n\n## Later\n\nAlso keep this.\n';
  const marked=await project({'AGENTS.md':`${before}<!-- tinka:start old note -->\n## Tinka\n\nHand edits inside.\n${TINKA_END}${after}`});
  const oneLiner=await project({'AGENTS.md':`${before}${ONE_LINER}${after}`});
  const unmarked=await project({'AGENTS.md':`${before}${UNMARKED_0_7_6}`});
  const own=await project({'AGENTS.md':`${before}## Tinka\n\nOur own board rules.\n`});
  const broken=await project({'AGENTS.md':`${before}${TINKA_START}\n## Tinka\n`});
  try{
    assert.match(await marked.instructions(),/^Updated the Tinka section in AGENTS\.md\.$/);
    assert.equal(await marked.read('AGENTS.md'),`${before}${BLOCK}${after}`);
    await oneLiner.init();
    assert.equal(await oneLiner.read('AGENTS.md'),`${before}${BLOCK}${after}`);
    await unmarked.instructions();
    assert.equal(await unmarked.read('AGENTS.md'),`${before}${BLOCK}`);
    assert.match(await own.instructions(),/older Tinka section outside the markers can be removed/);
    assert.equal(await own.read('AGENTS.md'),`${before}## Tinka\n\nOur own board rules.\n\n${BLOCK}\n`);
    assert.match(await broken.instructions(),/unmatched Tinka marker; left unchanged/);
    assert.equal(await broken.read('AGENTS.md'),`${before}${TINKA_START}\n## Tinka\n`);
    for(const fixture of [marked,oneLiner,unmarked,own]){
      const text=await fixture.read('AGENTS.md');
      assert.equal(await fixture.instructions(),'Tinka project instructions are current.');
      await fixture.init();
      assert.equal(await fixture.read('AGENTS.md'),text);
    }
  }finally{for(const fixture of [marked,oneLiner,unmarked,own,broken])await fixture.done();}
});

test('CRLF instruction files keep their line endings',async()=>{
  const fresh=await project({'AGENTS.md':crlf('# Windows rules\n\nKeep this.')});
  const upgraded=await project({'AGENTS.md':crlf(`# Windows rules\n\n${ONE_LINER}\n\n## After\n`)});
  const marked=await project({'AGENTS.md':crlf(`# Windows rules\n\n${TINKA_START}\nold\n${TINKA_END}\n`)});
  // Earlier releases appended an LF section even to CRLF files.
  const mixed=await project({'AGENTS.md':`${crlf('# Windows rules\n')}\n${ONE_LINER}\n`});
  try{
    await fresh.init();
    assert.equal(await fresh.read('AGENTS.md'),crlf(`# Windows rules\n\nKeep this.\n\n${BLOCK}\n`));
    await upgraded.init();
    assert.equal(await upgraded.read('AGENTS.md'),crlf(`# Windows rules\n\n${BLOCK}\n\n## After\n`));
    await marked.init();
    assert.equal(await marked.read('AGENTS.md'),crlf(`# Windows rules\n\n${BLOCK}\n`));
    await mixed.init();
    assert.equal(await mixed.read('AGENTS.md'),`${crlf('# Windows rules\n')}\n${BLOCK}\n`);
    for(const fixture of [fresh,upgraded,marked,mixed]){
      const text=await fixture.read('AGENTS.md');
      await fixture.init();
      assert.equal(await fixture.read('AGENTS.md'),text);
    }
  }finally{for(const fixture of [fresh,upgraded,marked,mixed])await fixture.done();}
});

test('project instructions requires a Tinka project',async()=>{
  const plain=await project({'AGENTS.md':`${ONE_LINER}\n`},{pinned:false});
  try{
    await assert.rejects(plain.instructions(),/No tinka\/project\.json/);
    assert.equal(await plain.read('AGENTS.md'),`${ONE_LINER}\n`);
  }finally{await plain.done();}
});

test('a new TINKA.md says to share the direct link and, when useful, a picture; an existing one is kept',async()=>{
  const fresh=await project({},{pinned:false});
  const custom=await project({'TINKA.md':'# Our own Tinka notes\n'},{pinned:false});
  try{
    await fresh.init();await custom.init();
    const text=await fresh.read('TINKA.md');
    assert.match(text,/## Open or return to this project's boards/);
    assert.match(text,/run this every time, even if an old URL still answers/);
    assert.match(text,/node tinka\/app\/cli\.mjs start --config tinka\/local\/config\.json/);
    assert.match(text,/canonical config path, boards root\nand project label/);
    assert.match(text,/remembered port was occupied and selects a new URL/);
    assert.match(text,/`linkPath` and `startCommand` without a full `link`/);
    assert.match(text,/## Share what you add or change\n\nGive the user the Tinka link to exactly what you added or changed\. Tool results\nthat change a board carry it as `link`/);
    assert.match(text,/node tinka\/app\/cli\.mjs item shot ITEM_ID --config tinka\/local\/config\.json --out \/absolute\/shot\.png/);
    assert.match(text,/node tinka\/app\/cli\.mjs board overview BOARD_ID --config tinka\/local\/config\.json --out/);
    assert.match(text,/`--width 390` for a phone-sized page/);
    // Any coding agent finds its comment inbox through TINKA.md, with no hook.
    assert.match(text,/## Comments for you\n/);assert.match(text,/node tinka\/app\/cli\.mjs inbox --config tinka\/local\/config\.json/);assert.match(text,/Never resolve\na person's comment/);assert.match(text,/Before finishing any Tinka task, check the inbox once\./);assert.match(text,/run `inbox --watch` in the background/);
    // Version numbers live in tinka/project.json and the checksum sidecars, never copied into TINKA.md.
    assert.match(text,/Do not copy version numbers or checksums into this file: `tinka\/project\.json`\nand `tinka\/packages\/\*\.sha256` are the record\./);
    assert.doesNotMatch(text,/\d+\.\d+\.\d+/);
    assert.equal(await custom.read('TINKA.md'),'# Our own Tinka notes\n');
  }finally{await fresh.done();await custom.done();}
});
