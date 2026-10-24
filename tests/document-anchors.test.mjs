import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseMarkdown,normalizeDocumentText,documentTextMap,locateTextAnchor,markdownAssetUrl,validTextAnchor,DOCUMENT_BYTE_LIMIT,MARKDOWN_TEXT_MODEL} from '../public/markdown-document.js';
import {readDocumentSource,documentRevision} from '../lib/document-anchors.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {applyFeedbackOperation,listFeedback} from '../lib/feedback.mjs';
const actor={id:'reviewer',label:'Reviewer',kind:'human'};
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'tinka-documents-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const config={boardsRoot:path.join(directory,'boards')};await mkdir(config.boardsRoot);await mkdir(path.join(directory,'docs'));
  const board=(await applyOperation(config,{type:'createBoard',title:'Document review'})).result;
  const roots={documents:{path:'../../docs'}};await applyOperation(config,{type:'updateWorkspace',patch:{resourceRoots:roots}});
  const resource={rootId:'documents',path:'design.md'},file=path.join(directory,'docs','design.md');await writeFile(file,'# Design\n\nKeep **selected words** here.\n\n## Next steps\n\n- One\n- Two');
  const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Design document',content:{kind:'markdown',resource}}})).result;
  return {config,board,item,resource,roots,file,directory};
}
test('one Markdown text model keeps whitespace, inline syntax, lists and UTF-16 stable',()=>{
  const model=parseMarkdown('\ufeff# Heading\r\n\r\nA **bold** and *soft* [`link`](safe.md) ![image](asset.png) 😀.\r\n\r\n- First\r\n- Second\r\n\r\n```js\r\nconst x = 1;\r\n```\r\n\r\n# Heading');
  assert.equal(model.text,normalizeDocumentText(model.rawText));assert.ok(model.text.includes('A bold and soft `link` 😀.'));
  assert.equal(model.text.includes('image'),false);assert.ok(model.text.includes('First Second const x = 1;'));
  assert.equal(parseMarkdown('# Heading\n# Heading').headings[1].id,'heading-2');
  const map=documentTextMap(' \r\n A\t😀  Z\n');assert.equal(map.text,'A 😀 Z');assert.equal(map.starts.length,map.text.length);assert.equal(map.text.slice(2,4),'😀');assert.equal(' \r\n A\t😀  Z\n'.slice(map.starts[2],map.ends[3]),'😀');
});
test('quote matching honors revision, exact context, duplication and original anchor history',()=>{
  const text='Before selected words after.',revision=documentRevision(Buffer.from(text)),start=text.indexOf('selected');
  const anchor={kind:'text',quote:'selected words',prefix:'Before ',suffix:' after.',start,end:start+14,sourceRevision:revision};
  assert.equal(locateTextAnchor(text,anchor,revision).status,'matched');
  assert.equal(locateTextAnchor(text,anchor,'sha256:'+ '0'.repeat(64)).status,'uncertain','same quote/offset with changed raw bytes never claims matched');
  assert.equal(locateTextAnchor('Before selected words other.',anchor,revision).status,'uncertain','same quote/offset with changed context never claims matched');
  assert.equal(locateTextAnchor('No old words.',anchor,revision).status,'stale');
  assert.equal(locateTextAnchor('word word',{kind:'text',quote:'word',start:0,end:4},undefined).status,'stale','legacy duplicates need reliable context');
  assert.equal(locateTextAnchor('aaa',{kind:'text',quote:'aa'},undefined).status,'stale','overlapping duplicates are ambiguous too');
  assert.equal(locateTextAnchor('word word',{kind:'text',quote:'word',prefix:'word ',start:5,end:9},undefined).status,'matched');
  assert.equal(anchor.sourceRevision,revision);assert.equal(validTextAnchor({...anchor,unexpected:true}),false);
});
test('Markdown URL policy keeps resource confinement and raw HTML inert in the text model',()=>{
  const options={baseUrl:'http://127.0.0.1:43821/resources/documents/section/design.md',origin:'http://127.0.0.1:43821',resourcePrefix:'/resources/documents/'};
  assert.equal(markdownAssetUrl('../picture.png',options),'http://127.0.0.1:43821/resources/documents/picture.png');
  for(const value of ['javascript:alert(1)','data:text/html,hi','https://user:secret@example.com/','../../../api/config','../.secret','../%2eprivate/file','../%252eprivate/file','../a%5cb'])assert.equal(markdownAssetUrl(value,options),null,value);
  assert.equal(markdownAssetUrl('https://example.com/read',options),'https://example.com/read');
  assert.equal(parseMarkdown('<script>window.bad=true</script>').text,'<script>window.bad=true</script>');
});
test('bounded pipe tables extract visible cells without pipe syntax and leave unsupported rows literal',()=>{
  const source='| Name | State |\n| :--- | ---: |\n| Alpha \\| Beta | **Ready** |\n| Other | Waiting |\n\nVerification follows.';
  const model=parseMarkdown(source);assert.equal(model.hasTables,true);assert.equal(model.blocks[0].rows.length,2);assert.deepEqual(model.blocks[0].align,['left','right']);assert.equal(model.rawText,'Name\tState\nAlpha | Beta\tReady\nOther\tWaiting\nVerification follows.');assert.equal(model.textModel,MARKDOWN_TEXT_MODEL);
  assert.equal(parseMarkdown('Name | State\n--- | :---:\nA | B').blocks[0].align[1],'center');
  assert.ok(parseMarkdown('| A | B |\n| --- | --- |\n| Wrong | width | extra |').text.includes('| Wrong | width | extra |'));
  for(const body of [Array.from({length:201},()=> '| A | B |').join('\n'),null]){
    const text=body===null?Array.from({length:17},(_,i)=>'H'+i).join('|')+'\n'+Array(17).fill('---').join('|'):'| A | B |\n| --- | --- |\n'+body;
    assert.equal(parseMarkdown(text).hasTables,false);assert.equal(parseMarkdown(text).text,parseMarkdown(text,{tables:false}).text);
  }
});
test('table extraction versions prevent unchanged raw SHA from silently locating legacy offsets',async t=>{
  const {config,board,item,file,roots,resource}=await fixture(t),raw='| Requirement | State |\n| --- | --- |\n| R1 | Ready |\n\n## Verification\n\nAll checks retain history.';await writeFile(file,raw);
  const legacy=parseMarkdown(raw,{tables:false}),source=await readDocumentSource(config,resource,roots),quote='Verification',start=legacy.text.indexOf(quote),saved={kind:'text',quote,start,end:start+quote.length,prefix:legacy.text.slice(Math.max(0,start-96),start),suffix:legacy.text.slice(start+quote.length,start+quote.length+96),sourceRevision:source.revision};
  assert.ok(source.legacyText);await applyFeedbackOperation(config,{type:'addComment',id:'legacy-table-quote',boardId:board.boardId,itemId:item.itemId,author:actor,body:'Legacy review.',anchor:saved});
  const historical=(await listFeedback(config,{threadId:'legacy-table-quote'})).threads[0];assert.equal(historical.anchorStatus,'uncertain');assert.deepEqual(historical.anchor,saved);
  const cell='Ready',cellStart=source.text.indexOf(cell),current={kind:'text',quote:cell,start:cellStart,end:cellStart+cell.length,sourceRevision:source.revision,textModel:MARKDOWN_TEXT_MODEL};
  await applyFeedbackOperation(config,{type:'addComment',id:'current-table-cell',boardId:board.boardId,itemId:item.itemId,author:actor,body:'Current cell review.',anchor:current});assert.equal((await listFeedback(config,{threadId:'current-table-cell'})).threads[0].anchorStatus,'matched');
  assert.equal(locateTextAnchor(source.text,{...current,textModel:'future-model'},source.revision,MARKDOWN_TEXT_MODEL).status,'unverified');
});
test('locked feedback reads actual linked bytes without nested locks and reports changed/removed source', {timeout:5000},async t=>{
  const {config,board,item,resource,roots,file}=await fixture(t),source=await readDocumentSource(config,resource,roots),quote='selected words',start=source.text.indexOf(quote);
  await applyFeedbackOperation(config,{type:'addComment',id:'document-quote',boardId:board.boardId,itemId:item.itemId,author:actor,body:'Review this passage.',anchor:{kind:'text',quote,start,end:start+quote.length,prefix:source.text.slice(0,start),suffix:source.text.slice(start+quote.length),sourceRevision:source.revision}});
  assert.equal((await listFeedback(config,{threadId:'document-quote'})).threads[0].anchorStatus,'matched');
  await writeFile(file,'# Design\n\nKeep **selected words** here.\n\n## Next steps\n\n- One\n- Two\n');
  assert.equal((await listFeedback(config,{threadId:'document-quote'})).threads[0].anchorStatus,'uncertain');
  await writeFile(file,'# A replacement\n\nThe passage was removed.');
  const stale=(await listFeedback(config,{threadId:'document-quote'})).threads[0];assert.equal(stale.anchorStatus,'stale');assert.equal(stale.anchor.quote,quote);
  await rm(file);assert.equal((await listFeedback(config,{threadId:'document-quote'})).threads[0].anchorStatus,'unverified');
});
test('source helper refuses oversized, hidden aliases, encoded traversal and escaped symlinks',async t=>{
  const {config,resource,roots,file,directory}=await fixture(t);
  await writeFile(file,Buffer.alloc(DOCUMENT_BYTE_LIMIT+1,97));await assert.rejects(readDocumentSource(config,resource,roots));
  const outside=path.join(directory,'private.md');await writeFile(outside,'Private');await rm(file);await symlink(outside,file);
  await assert.rejects(readDocumentSource(config,resource,roots),{status:403});
  for(const pathname of ['../private.md','%2e%2e/private.md','.hidden.md'])await assert.rejects(readDocumentSource(config,{...resource,path:pathname},roots));
});
test('inline anchors with unchanged quote/offset cannot ignore changed context or revision',async t=>{
  const {config,board}=await fixture(t),text='Before selected words after.',quote='selected words',start=text.indexOf(quote);
  const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Inline',content:{kind:'note',text}}})).result;
  await applyFeedbackOperation(config,{type:'addComment',id:'inline-quote',boardId:board.boardId,itemId:item.itemId,author:actor,body:'Inline review.',anchor:{kind:'text',quote,start,end:start+quote.length,prefix:'Before ',suffix:' after.',sourceRevision:documentRevision(Buffer.from(text))}});
  assert.equal((await listFeedback(config,{threadId:'inline-quote'})).threads[0].anchorStatus,'matched');
  await applyOperation(config,{type:'updateItem',itemId:item.itemId,patch:{content:{kind:'note',text:'Before selected words other.'}}});
  assert.equal((await listFeedback(config,{threadId:'inline-quote'})).threads[0].anchorStatus,'uncertain');
});
