// Saved highlights and passage comments follow unchanged passages through document saves
// (exact quote + prefix + suffix found once), and PUT /api/documents guards concurrent edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {applyOperation,readWorkspace} from '../lib/workspace.mjs';
import {applyFeedbackOperation,listFeedback} from '../lib/feedback.mjs';
import {listHighlights} from '../lib/highlights.mjs';
import {callTool} from '../lib/tools.mjs';
import {parseMarkdown,MARKDOWN_TEXT_MODEL} from '../public/markdown-document.js';
import {relocateAnchor} from '../lib/document-anchors.mjs';

const author={id:'reviewer',label:'Reviewer',kind:'human'};
const sha=text=>'sha256:'+createHash('sha256').update(Buffer.from(text)).digest('hex');
// Context is the 96 characters either side, so each passage is padded by longer paragraphs.
const filler=word=>Array.from({length:14},(_,i)=>`${word}${i}`).join(' ')+'.';
const SIGNED=`${filler('gamma')}\n\nThe installer must be signed.\n\n${filler('delta')}`;
const ORIGINAL=`# Plan\n\n${filler('alpha')}\n\nKeep the launch calm and quiet.\n\n${filler('beta')}\n\n## Risks\n\n${SIGNED}\n`;
function anchorFor(markdown,quote){
  const text=parseMarkdown(markdown).text,start=text.indexOf(quote);assert.ok(start>=0,quote);
  return {kind:'text',quote,prefix:text.slice(Math.max(0,start-96),start),suffix:text.slice(start+quote.length,start+quote.length+96),start,end:start+quote.length,sourceRevision:sha(markdown),textModel:MARKDOWN_TEXT_MODEL};
}
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-reanchor-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'config.json');await mkdir(path.join(root,'boards'));
  await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Re-anchor fixture']);
  const config=await loadConfig(configPath);await applyOperation(config,{type:'createBoard',id:'ideas',title:'Ideas'});
  const server=await listen(config,{port:0});t.after(()=>closeAppServer(server));const base=`http://127.0.0.1:${server.address().port}`;
  const call=(method,url,body)=>fetch(base+url,{method,headers:{'content-type':'application/json','x-tinka-workspace':config.workspaceId},body:JSON.stringify(body)});
  const workspace=await readWorkspace(config,{covers:false});
  const created=await (await call('POST','/api/documents',{workspaceId:workspace.workspaceId,targetBoardId:'ideas',targetPosition:{x:0,y:0},expectedRevision:workspace.revision,operationId:'doc',text:ORIGINAL})).json();
  const itemId=created.result.itemIds[0],item=(await readWorkspace(config)).items.find(entry=>entry.id===itemId),file=path.join(root,'boards','imports',item.content.resource.path);
  assert.equal(await readFile(file,'utf8'),ORIGINAL);
  return {config,call,itemId,file};
}
const revision=async config=>(await readWorkspace(config,{covers:false})).revision;
const mark=async (f,id)=>(await listHighlights(f.config,{itemId:f.itemId})).highlights.find(entry=>entry.id===id);
const thread=async (f,id)=>(await listFeedback(f.config,{threadId:id,includeBodies:true})).threads[0];

test('an unchanged quote re-anchors highlights and passage comments on save, with history',async t=>{
  const f=await fixture(t);
  await applyOperation(f.config,{type:'addHighlight',id:'calm',itemId:f.itemId,author,anchor:anchorFor(ORIGINAL,'launch calm')});
  await applyFeedbackOperation(f.config,{type:'addComment',id:'signed',boardId:'ideas',itemId:f.itemId,author,body:'Who signs it?',anchor:anchorFor(ORIGINAL,'must be signed')});
  const edited=ORIGINAL.replace('# Plan\n\n','# Plan\n\nA new opening line comes first.\n\n'),before=await revision(f.config);
  const saved=await f.call('PUT',`/api/documents/${f.itemId}`,{text:edited,baseRevision:sha(ORIGINAL)});assert.equal(saved.status,200);
  const body=await saved.json();assert.equal(body.revision,sha(edited));assert.deepEqual(body.reanchored,{highlights:['calm'],threads:['signed']});
  assert.equal(await revision(f.config),before+1,'one metadata write for the moves');
  const text=parseMarkdown(edited).text;
  for(const record of [await mark(f,'calm'),await thread(f,'signed')]){
    assert.equal(record.anchorStatus,'matched');assert.equal(record.currentAnchor,undefined,'stored anchor is current');
    assert.equal(record.anchor.sourceRevision,sha(edited));assert.equal(text.slice(record.anchor.start,record.anchor.end),record.anchor.quote);
    assert.equal(record.reanchored.length,1);assert.deepEqual([record.reanchored[0].from,record.reanchored[0].to],[sha(ORIGINAL),sha(edited)]);
  }
  // Saving again with nothing to move writes no metadata.
  const again=edited.replace('first.','first, really.');const quiet=await revision(f.config);
  assert.equal((await f.call('PUT',`/api/documents/${f.itemId}`,{text:again})).status,200);assert.equal((await mark(f,'calm')).anchor.sourceRevision,sha(again));
  const noop=await revision(f.config);assert.equal((await (await f.call('PUT',`/api/documents/${f.itemId}`,{text:again})).json()).reanchored.highlights.length,0);assert.equal(await revision(f.config),noop,'unchanged anchors write nothing');
  assert.ok(noop>quiet);
});

test('an edited quote or an undecidable duplicate stays for review; a unique quote moves despite new context',async t=>{
  const f=await fixture(t);
  for(const [id,quote] of [['edited','launch calm'],['duplicated','must be signed'],['context','Risks']])
    await applyOperation(f.config,{type:'addHighlight',id,itemId:f.itemId,author,anchor:anchorFor(ORIGINAL,quote)});
  // The duplicated block repeats the quote with identical context: two exact matches, no winner.
  const edited=ORIGINAL.replace('launch calm','launch very calm').replace('## Risks','## Known Risks')+`\n${SIGNED}\n`;
  const body=await (await f.call('PUT',`/api/documents/${f.itemId}`,{text:edited})).json();
  assert.deepEqual(body.reanchored,{highlights:['context'],threads:[]});
  for(const id of ['edited','duplicated']){const record=await mark(f,id);assert.equal(record.anchor.sourceRevision,sha(ORIGINAL));assert.equal(record.reanchored,undefined);assert.notEqual(record.anchorStatus,'matched',id);assert.equal(record.currentAnchor,undefined);}
  const moved=await mark(f,'context'),text=parseMarkdown(edited).text;assert.equal(moved.anchorStatus,'matched');assert.equal(text.slice(moved.anchor.start,moved.anchor.end),'Risks');assert.ok(moved.anchor.prefix.endsWith('Known '),'context is refreshed around the new place');
});

test('a short document edited right next to a highlight keeps it',async t=>{
  const f=await fixture(t),short='# My first doc\n\nHello world, this is my doc.\n';
  assert.equal((await f.call('PUT',`/api/documents/${f.itemId}`,{text:short})).status,200);
  await applyOperation(f.config,{type:'addHighlight',id:'world',itemId:f.itemId,author,anchor:anchorFor(short,'world')});
  const edited='# My first doc\n\nHello big world, truly. This is my doc today.\n',before=await revision(f.config);
  const body=await (await f.call('PUT',`/api/documents/${f.itemId}`,{text:edited,baseRevision:sha(short)})).json();
  assert.deepEqual(body.reanchored.highlights,['world']);assert.equal(await revision(f.config),before+1);
  const record=await mark(f,'world'),text=parseMarkdown(edited).text;
  assert.equal(record.anchorStatus,'matched');assert.equal(text.slice(record.anchor.start,record.anchor.end),'world');assert.deepEqual([record.reanchored[0].from,record.reanchored[0].to],[sha(short),sha(edited)]);
});

test('duplicate quotes are resolved by context, and ties stay for review',()=>{
  const source=markdown=>({text:parseMarkdown(markdown).text,revision:sha(markdown),textModel:MARKDOWN_TEXT_MODEL});
  const doc='Morning: review the plan with design.\n\nEvening: review the plan with sales.\n';
  const second=anchorFor(doc,'Evening: review the plan')&&(()=>{const text=parseMarkdown(doc).text,start=text.lastIndexOf('the plan');return {kind:'text',quote:'the plan',prefix:text.slice(Math.max(0,start-96),start),suffix:text.slice(start+8,start+104),start,end:start+8,sourceRevision:sha(doc),textModel:MARKDOWN_TEXT_MODEL};})();
  // Both contexts change, but the evening occurrence keeps more of its saved context.
  const edited='Early morning: we review the plan with design.\n\nEvening: review the plan with the sales team.\n';
  const moved=relocateAnchor(second,source(edited)),text=parseMarkdown(edited).text;
  assert.ok(moved);assert.equal(moved.start,text.lastIndexOf('the plan'));assert.equal(moved.sourceRevision,sha(edited));
  // An exact prefix+suffix match wins outright among duplicates.
  const exact=`${doc}\nAppendix: the plan is final.\n`;assert.equal(relocateAnchor(second,source(exact)).start,parseMarkdown(exact).text.indexOf('Evening: review the plan')+'Evening: review '.length);
  // A tie: both occurrences keep the same amount of context.
  const tie='Note: review the plan with x.\n\nNote: review the plan with x.\n';assert.equal(relocateAnchor({...second,prefix:'review ',suffix:' with'},source(tie)),null);
  // The quote itself changed: review.
  assert.equal(relocateAnchor(second,source(doc.replace(/the plan/g,'the roadmap'))),null);
  // A unique quote moves whatever its context.
  assert.ok(relocateAnchor({...second,prefix:'unrelated ',suffix:' unrelated'},source('Only here: the plan.\n')));
});

test('baseRevision guards concurrent edits: a stale base writes nothing and reports the current revision',async t=>{
  const f=await fixture(t);
  const outside=ORIGINAL+'\nAn agent added this.\n';await writeFile(f.file,outside);
  const stale=await f.call('PUT',`/api/documents/${f.itemId}`,{text:'# Mine\n',baseRevision:sha(ORIGINAL)});
  assert.equal(stale.status,409);const body=await stale.json();assert.equal(body.currentRevision,sha(outside));assert.match(body.error,/changed/);
  assert.equal(await readFile(f.file,'utf8'),outside,'nothing written');
  assert.equal((await f.call('PUT',`/api/documents/${f.itemId}`,{text:'# Mine\n',baseRevision:'sha256:ABC'})).status,400);
  assert.equal((await f.call('PUT',`/api/documents/${f.itemId}`,{text:'# Mine\n',extra:1})).status,400);
  const ok=await f.call('PUT',`/api/documents/${f.itemId}`,{text:'# Mine\n',baseRevision:body.currentRevision});assert.equal(ok.status,200);assert.equal((await ok.json()).revision,sha('# Mine\n'));
  assert.equal((await f.call('PUT',`/api/documents/${f.itemId}`,{text:'# Without base\n'})).status,200,'absent baseRevision saves as before');
});

test('after an outside edit, listings show currentAnchor without writing, and document.reanchor persists it',async t=>{
  const f=await fixture(t);
  await applyOperation(f.config,{type:'addHighlight',id:'calm',itemId:f.itemId,author,anchor:anchorFor(ORIGINAL,'launch calm')});
  const outside=ORIGINAL.replace('# Plan\n\n','# Plan\n\nAn agent wrote an intro.\n\n');await writeFile(f.file,outside);
  const before=await revision(f.config),listed=await mark(f,'calm');
  assert.equal(listed.anchorStatus,'matched');assert.equal(listed.anchor.sourceRevision,sha(ORIGINAL));assert.equal(listed.currentAnchor.sourceRevision,sha(outside));assert.equal(await revision(f.config),before,'reads never write');
  const result=await callTool(f.config,'document.reanchor',{itemId:f.itemId});assert.deepEqual(result.result.highlights,['calm']);assert.equal(result.result.written,true);
  const persisted=await mark(f,'calm');assert.equal(persisted.anchor.sourceRevision,sha(outside));assert.equal(persisted.currentAnchor,undefined);assert.equal(persisted.reanchored.length,1);
  assert.equal((await callTool(f.config,'document.reanchor',{itemId:f.itemId})).result.written,false);
});
