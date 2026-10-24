import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {applyOperation,getBoardSnapshot,workspaceView} from '../lib/workspace.mjs';
import {applyFeedbackOperation} from '../lib/feedback.mjs';
import {listHighlights,validateHighlights} from '../lib/highlights.mjs';
import {documentRevision,readDocumentSource} from '../lib/document-anchors.mjs';
import {callTool} from '../lib/tools.mjs';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';
const author={id:'agent-reviewer',label:'Fixture reviewer',kind:'agent'};
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'tinka-highlights-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={boardsRoot:path.join(root,'boards')};await mkdir(config.boardsRoot);
 const board=(await applyOperation(config,{type:'createBoard',title:'Review'})).result;
 const item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Text',content:{kind:'note',text:'Before selected words after.'}}})).result;
 const op=operation=>applyOperation(config,operation);return {root,config,board,item,op};
}
test('bodyless marks retry with compact receipts and preserve notes, votes, references and independent copies',async t=>{
 const f=await fixture(t),{itemId}=f.item;
 await f.op({type:'review',itemId,patch:{note:'Durable note',star:true}});
 await applyFeedbackOperation(f.config,{type:'vote',itemId,actor:author,value:'yes'});
 const request={type:'addHighlight',itemId,id:'mark-one',author,anchor:{kind:'text',quote:'selected words'},operationId:'stable-mark'};
 const first=await f.op(request),retry=await f.op(request);assert.equal(retry.replayed,true);assert.equal(retry.revision,first.revision);assert.deepEqual(first.result,{itemId,highlightId:'mark-one'});assert.ok(!JSON.stringify(first).includes('selected words'));
 const list=await listHighlights(f.config,{itemId});assert.equal(list.highlights[0].anchorStatus,'matched');assert.equal(list.highlights[0].anchor.start,7);assert.equal(list.highlights[0].anchor.sourceRevision,documentRevision(Buffer.from('Before selected words after.')));
 const other=(await f.op({type:'createBoard',title:'Reference'})).result;await f.op({type:'reference',itemIds:[itemId],targetBoardId:other.boardId});
 const copy=(await f.op({type:'duplicate',itemId,targetBoardId:f.board.boardId})).result;
 await f.op({type:'review',itemId,patch:{note:'',star:false}});const snapshot=await getBoardSnapshot(f.config,other.boardId);assert.equal(snapshot.items[itemId].review.highlights['mark-one'].anchor.quote,'selected words');assert.equal(snapshot.items[itemId].review.votes[author.id].value,'yes');assert.equal(snapshot.items[itemId].review.note,'');
 assert.equal((await f.op({type:'removeHighlight',itemId,highlightId:'mark-one'})).result.removed,true);assert.equal((await f.op({type:'removeHighlight',itemId,highlightId:'mark-one'})).result.removed,false);assert.equal((await listHighlights(f.config,{itemId:copy.itemId})).highlights.length,1);assert.equal((await listHighlights(f.config,{itemId})).highlights.length,0);
 const compact=await workspaceView(f.config,'graph',{covers:false});assert.ok(!JSON.stringify(compact).includes('selected words'));assert.ok(!JSON.stringify(compact).includes('mark-one'));
});
test('source changes retain exact anchor history, never match changed SHA, and reject stale creation',async t=>{
 const f=await fixture(t),{itemId}=f.item;const anchor={kind:'text',quote:'selected words'};
 await f.op({type:'addHighlight',itemId,id:'mark',author,anchor});const saved=(await listHighlights(f.config,{itemId})).highlights[0].anchor;
 await f.op({type:'updateItem',itemId,patch:{content:{kind:'note',text:'Now selected words after.'}}});let mark=(await listHighlights(f.config,{itemId})).highlights[0];assert.equal(mark.anchorStatus,'uncertain');assert.deepEqual(mark.anchor,saved);
 await assert.rejects(f.op({type:'addHighlight',itemId,author,anchor:saved}),{status:409});
 await f.op({type:'updateItem',itemId,patch:{content:{kind:'note',text:'Different entirely.'}}});assert.equal((await listHighlights(f.config,{itemId})).highlights[0].anchorStatus,'stale');
 await assert.rejects(f.op({type:'addHighlight',itemId,author,anchor:{kind:'text',quote:'missing'}}),{status:409});
});
test('linked Markdown uses normalized rendered text and raw SHA while remaining source read only',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.root,'docs'));const file=path.join(f.root,'docs/source.md'),raw='# Design\r\n\r\nBefore **selected words** after.\r\n';await writeFile(file,raw);
 const roots={docs:{path:'../../docs'}};await f.op({type:'updateWorkspace',patch:{resourceRoots:roots}});const resource={rootId:'docs',path:'source.md'};
 await f.op({type:'updateItem',itemId:f.item.itemId,patch:{content:{kind:'markdown',resource,text:'Incidental ignored text'}}});
 const source=await readDocumentSource(f.config,resource,roots);const start=source.text.indexOf('selected');
 await callTool(f.config,'highlight.add',{itemId:f.item.itemId,id:'linked',author,anchor:{kind:'text',quote:'selected words',start,end:start+14,sourceRevision:source.revision}});
 assert.equal(await readFile(file,'utf8'),raw);assert.equal((await listHighlights(f.config,{itemId:f.item.itemId})).highlights[0].anchorStatus,'matched');
 await writeFile(file,raw.replace('**selected words**','selected words'));assert.equal((await listHighlights(f.config,{itemId:f.item.itemId})).highlights[0].anchorStatus,'uncertain');
 await rm(file);await symlink(path.join(f.root,'unavailable.md'),file);assert.equal((await listHighlights(f.config,{itemId:f.item.itemId})).highlights[0].anchorStatus,'unverified');
 await assert.rejects(f.op({type:'addHighlight',itemId:f.item.itemId,author,anchor:{kind:'text',quote:'Incidental ignored text'}}),{status:400});
});
test('bounded pagination, strict schemas and mark caps fail without altering item bytes',async t=>{
 const f=await fixture(t),itemId=f.item.itemId;
 for(const id of ['a','b','c'])await f.op({type:'addHighlight',id,itemId,author,anchor:{kind:'text',quote:'selected words'}});
 const page=await listHighlights(f.config,{itemId,limit:2});assert.equal(page.highlights.length,2);assert.ok(page.nextCursor);assert.equal((await listHighlights(f.config,{itemId,cursor:page.nextCursor})).highlights.length,1);
 const file=path.join(f.config.boardsRoot,'.tinka/items',itemId+'.json'),before=await readFile(file,'utf8');
 for(const input of [{itemId,limit:0},{itemId,cursor:Buffer.from('null').toString('base64url')},{itemId,extra:true}])await assert.rejects(listHighlights(f.config,input),{status:400});
 await assert.rejects(callTool(f.config,'highlight.add',{itemId,author,anchor:{kind:'point',x:0,y:0}}),{status:400});assert.equal(await readFile(file,'utf8'),before);
 await f.op({type:'review',itemId,patch:{note:'Unrelated'}});await assert.rejects(listHighlights(f.config,{itemId,cursor:page.nextCursor}),{status:409});
 const mark=(await listHighlights(f.config,{itemId})).highlights[0];delete mark.anchorStatus;const oversized=Object.fromEntries(Array.from({length:201},(_,i)=>['mark-'+i,{...mark,id:'mark-'+i}]));assert.throws(()=>validateHighlights(oversized),{status:400});
 assert.throws(()=>validateHighlights({huge:{...mark,id:'huge',anchor:{...mark.anchor,quote:'x'.repeat(20000),prefix:'x'.repeat(2000),suffix:'x'.repeat(2000)},extra:'x'.repeat(300000)}}),{status:400});
});
test('HTTP endpoint, operation guard and CLI tools expose the same targeted highlights',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'tinka-highlights-http-'));t.after(()=>rm(root,{recursive:true,force:true}));const configPath=path.join(root,'config.json');await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Highlight fixture']);const config=await loadConfig(configPath);
 const board=(await applyOperation(config,{type:'createBoard',title:'Review'})).result,item=(await applyOperation(config,{type:'createItem',boardId:board.boardId,item:{title:'Source',content:{kind:'note',text:'Exact quote'}}})).result;
 const server=await listen(config,{port:0});t.after(()=>closeAppServer(server));const base=`http://127.0.0.1:${server.address().port}`;
 const request={type:'addHighlight',id:'http-mark',itemId:item.itemId,author,anchor:{kind:'text',quote:'Exact quote'},operationId:'http-stable'};
 assert.equal((await fetch(base+'/api/operations',{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':'wrong'},body:JSON.stringify(request)})).status,403);
 const added=await fetch(base+'/api/operations',{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':config.workspaceId},body:JSON.stringify(request)});assert.equal(added.status,200);assert.deepEqual((await added.json()).result,{itemId:item.itemId,highlightId:'http-mark'});
 const read=await fetch(base+`/api/highlights?itemId=${item.itemId}`);assert.equal(read.status,200);const actual=await read.json(),cli=JSON.parse(await main(['tools','call','highlight.list','--config',configPath,'--json',JSON.stringify({itemId:item.itemId})]));assert.deepEqual(cli,actual);assert.equal(actual.highlights[0].body,undefined);
 assert.equal((await fetch(base+`/api/highlights?itemId=${item.itemId}&limit=0`)).status,400);
});

test('table text-model discriminator preserves old anchors and enriches only current creation facts',async t=>{
 const f=await fixture(t),itemId=f.item.itemId;await mkdir(path.join(f.root,'docs'));const raw='# Status\n\nBefore the table.\n\n| Area | State |\n| --- | --- |\n| Release | Ready |\n\nAfter the table.';const file=path.join(f.root,'docs/table.md');await writeFile(file,raw);const roots={docs:{path:'../../docs'}},resource={rootId:'docs',path:'table.md'};
 await f.op({type:'updateWorkspace',patch:{resourceRoots:roots}});await f.op({type:'updateItem',itemId,patch:{content:{kind:'markdown',resource}}});const current=await readDocumentSource(f.config,resource,roots);assert.equal(current.textModel,'markdown-v2');assert.notEqual(current.legacyText,current.text);
 const quote='After the table.',legacyStart=current.legacyText.indexOf(quote),oldAnchor={kind:'text',quote,start:legacyStart,end:legacyStart+quote.length,sourceRevision:current.revision};
 // These bytes represent marks saved before the table renderer existed.
 const itemFile=path.join(f.config.boardsRoot,'.tinka/items',itemId+'.json'),saved=JSON.parse(await readFile(itemFile)),stamp=new Date().toISOString();saved.review.highlights={legacy:{id:'legacy',author,anchor:oldAnchor,createdAt:stamp,updatedAt:stamp},unknown:{id:'unknown',author,anchor:{...oldAnchor,textModel:'future-model'},createdAt:stamp,updatedAt:stamp}};await writeFile(itemFile,JSON.stringify(saved));
 const before=await readFile(itemFile,'utf8');let marks=await listHighlights(f.config,{itemId});assert.equal(marks.highlights.find(m=>m.id==='legacy').anchorStatus,'uncertain');assert.equal(marks.highlights.find(m=>m.id==='unknown').anchorStatus,'unverified');assert.equal(await readFile(itemFile,'utf8'),before);
 await assert.rejects(f.op({type:'addHighlight',itemId,author,anchor:oldAnchor}),{status:409});await assert.rejects(callTool(f.config,'highlight.add',{itemId,author,anchor:{kind:'text',quote,textModel:'future-model'}}),{status:400});
 await callTool(f.config,'highlight.add',{itemId,id:'current',author,anchor:{kind:'text',quote}});marks=await listHighlights(f.config,{itemId});const mark=marks.highlights.find(m=>m.id==='current');assert.equal(mark.anchor.textModel,'markdown-v2');assert.equal(mark.anchor.start,current.text.indexOf(quote));assert.equal(mark.anchorStatus,'matched');assert.deepEqual(marks.highlights.find(m=>m.id==='legacy').anchor,oldAnchor);assert.equal(await readFile(file,'utf8'),raw);
 const start=current.text.indexOf('Ready');await callTool(f.config,'feedback.comment',{boardId:f.board.boardId,itemId,id:'v2-comment',author,body:'Current table quote',anchor:{kind:'text',quote:'Ready',start,end:start+5,sourceRevision:current.revision,textModel:'markdown-v2'}});
 const {listFeedback}=await import('../lib/feedback.mjs');assert.equal((await listFeedback(f.config,{threadId:'v2-comment'})).threads[0].anchorStatus,'matched');await callTool(f.config,'feedback.comment',{boardId:f.board.boardId,itemId,id:'old-comment',author,body:'Legacy quote history',anchor:oldAnchor});assert.equal((await listFeedback(f.config,{threadId:'old-comment'})).threads[0].anchorStatus,'uncertain');
 const threadFile=path.join(f.config.boardsRoot,'.tinka/threads/old-comment.json'),thread=JSON.parse(await readFile(threadFile));thread.anchor.textModel='future-model';await writeFile(threadFile,JSON.stringify(thread));assert.equal((await listFeedback(f.config,{threadId:'old-comment'})).threads[0].anchorStatus,'unverified');
 await f.op({type:'updateItem',itemId,patch:{content:{kind:'note',text:'Inline source'}}});await assert.rejects(callTool(f.config,'highlight.add',{itemId,author,anchor:{kind:'text',quote:'Inline source',textModel:'markdown-v2'}}),{status:409});
});
