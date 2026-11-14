// "Back to Tinka": the mark is added only to a browser's top-level HTML
// document; Tinka's frames, curl, agents, ranges, non-HTML and opted-out pages
// get the file's exact bytes. Plus the read-only placement lookup.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {applyOperation} from '../lib/workspace.mjs';
import {listen,closeAppServer} from '../server.mjs';
import {injectReturnMark,returnMarkOptedOut,RETURN_MARK_TAG} from '../lib/return-mark.mjs';

const raw=(port,route,headers={},method='GET')=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:route,method,headers:{host:`127.0.0.1:${port}`,...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});
  req.on('error',reject);req.end();
});

test('injection adds one tag before the last </body>, keeps bytes elsewhere and honors the meta opt-out',()=>{
  const page=Buffer.from('<!doctype html><title>Café</title><body><p>“é”</p><script>"</body>"</script></BODY >\n</html>\n','utf8');
  const out=injectReturnMark(page);
  const at=page.toString('latin1').lastIndexOf('</BODY');
  assert.deepEqual(out.subarray(0,at),page.subarray(0,at));
  assert.equal(out.subarray(at,at+RETURN_MARK_TAG.length).toString(),RETURN_MARK_TAG);
  assert.deepEqual(out.subarray(at+RETURN_MARK_TAG.length),page.subarray(at));
  assert.equal(out.toString('utf8').includes('<p>“é”</p>'),true,'UTF-8 text survives');
  assert.equal(injectReturnMark(Buffer.from('<h1>No body tag</h1>')).toString(),`<h1>No body tag</h1>${RETURN_MARK_TAG}`);
  assert.equal(injectReturnMark(Buffer.from('<meta content="off" name="tinka-return"><p>x</p>')),null);
  assert.equal(returnMarkOptedOut("<META NAME='tinka-return' CONTENT='OFF'>"),true);
  assert.equal(returnMarkOptedOut('<meta name="tinka-return" content="on">'),false);
  assert.equal(injectReturnMark(Buffer.from([0xff,0xfe,0x3c,0x00])),null,'UTF-16 is left alone');
});

test('only a top-level HTML document gets the mark; frames, curl, ranges, non-HTML and opt-outs are byte-identical',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-return-mark-'));
  const configPath=path.join(root,'config.json');
  await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Return fixture']);
  const config=await loadConfig(configPath);
  const assets=path.join(root,'boards','assets');await mkdir(assets,{recursive:true});
  const page='<!doctype html><meta charset="utf-8"><title>Calm</title><body><h1>Calm form</h1></body></html>\n';
  await writeFile(path.join(assets,'calm.html'),page);
  await writeFile(path.join(assets,'quiet.html'),'<!doctype html><meta name="tinka-return" content="off"><h1>Quiet</h1>');
  await writeFile(path.join(assets,'shot.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  const op=async(type,fields)=>(await applyOperation(config,{type,...fields})).result;
  await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
  await op('createBoard',{id:'lab',title:'Design Lab'});await op('createBoard',{id:'library',title:'Content Library'});
  const calm=await op('createItem',{boardId:'lab',item:{title:'Calm form',number:'01',content:{kind:'html',resource:{rootId:'assets',path:'calm.html'}}}});
  await op('reference',{sourceBoardId:'lab',placementIds:calm.placementIds,targetBoardId:'library'});
  const other=await op('createItem',{boardId:'library',item:{title:'Calm settings',content:{kind:'note',text:'x'},revisions:[{id:'web',name:'Web',content:{kind:'html',resource:{rootId:'assets',path:'calm.html'}}}]}});
  await op('createItem',{boardId:'library',item:{title:'Unrelated',content:{kind:'html',resource:{rootId:'assets',path:'quiet.html'}}}});
  const server=await listen(config,{port:0});const port=server.address().port;
  t.after(async()=>{await closeAppServer(server);await rm(root,{recursive:true,force:true});});
  const original=await readFile(path.join(assets,'calm.html'));

  const doc=await raw(port,'/resources/assets/calm.html',{'sec-fetch-dest':'document','sec-fetch-mode':'navigate'});
  assert.equal(doc.status,200);
  assert.equal(doc.body.toString(),page.replace('</body>',`${RETURN_MARK_TAG}</body>`));
  assert.equal(Number(doc.headers['content-length']),doc.body.length,'Content-Length is recomputed');
  assert.equal(doc.headers.vary,'Sec-Fetch-Dest');
  const head=await raw(port,'/resources/assets/calm.html',{'sec-fetch-dest':'document'},'HEAD');
  assert.equal(Number(head.headers['content-length']),doc.body.length,'HEAD matches the document length');

  const frame=await raw(port,'/resources/assets/calm.html',{'sec-fetch-dest':'iframe'});
  const curl=await raw(port,'/resources/assets/calm.html');
  assert.deepEqual(frame.body,original,'Tinka\'s own frames get the exact bytes');
  assert.deepEqual(curl.body,original,'curl and agents get the exact bytes');
  assert.deepEqual(frame.body,curl.body,'iframe and curl responses are byte-identical');
  assert.equal(frame.headers.vary,'Sec-Fetch-Dest');
  assert.equal(Number(curl.headers['content-length']),original.length);

  const range=await raw(port,'/resources/assets/calm.html',{'sec-fetch-dest':'document',range:'bytes=0-9'});
  assert.equal(range.status,206);assert.deepEqual(range.body,original.subarray(0,10),'a range is never rewritten');
  const off=await raw(port,'/resources/assets/calm.html?tinka=off',{'sec-fetch-dest':'document'});
  assert.deepEqual(off.body,original,'?tinka=off serves the exact bytes');
  const quiet=await raw(port,'/resources/assets/quiet.html',{'sec-fetch-dest':'document'});
  assert.deepEqual(quiet.body,await readFile(path.join(assets,'quiet.html')),'the meta opt-out serves the exact bytes');
  const svg=await raw(port,'/resources/assets/shot.svg',{'sec-fetch-dest':'document'});
  assert.deepEqual(svg.body,await readFile(path.join(assets,'shot.svg')),'non-HTML is left raw');
  assert.equal(svg.headers.vary,undefined);
  const script=await raw(port,'/app/return-mark.js');assert.equal(script.status,200);
  const app=await raw(port,'/app/item.html',{'sec-fetch-dest':'document'});assert.equal(app.body.includes('return-mark.js'),false,'Tinka\'s own pages are not marked');

  // Legacy board files follow the same rule.
  const legacy=path.join(root,'boards','legacy');await mkdir(path.join(legacy,'rounds','first','alpha'),{recursive:true});
  await writeFile(path.join(legacy,'board.json'),JSON.stringify({schemaVersion:1,title:'Legacy board',description:'',createdAt:'2026-11-01T00:00:00Z'}));
  await writeFile(path.join(legacy,'rounds','first','alpha','index.html'),'<h1>Alpha</h1>');
  await writeFile(path.join(legacy,'rounds.json'),JSON.stringify({rounds:[{id:'first',title:'First',concepts:[{id:'alpha',name:'Alpha',number:'01'}]}],revisions:{}}));
  const legacyDoc=await raw(port,'/boards/legacy/files/rounds/first/alpha/index.html',{'sec-fetch-dest':'document'});
  assert.equal(legacyDoc.body.toString(),`<h1>Alpha</h1>${RETURN_MARK_TAG}`);
  const legacyFrame=await raw(port,'/boards/legacy/files/rounds/first/alpha/index.html',{'sec-fetch-dest':'iframe'});
  assert.equal(legacyFrame.body.toString(),'<h1>Alpha</h1>');

  // The lookup lists every placement that shows the file, including another item's saved version.
  const places=JSON.parse((await raw(port,`/api/resource-places?url=${encodeURIComponent('/resources/assets/calm.html')}`)).body);
  assert.equal(places.workspace,config.workspaceId);
  assert.equal(places.file,await (await import('node:fs/promises')).realpath(path.join(assets,'calm.html')));
  assert.deepEqual(places.places.map(p=>[p.boardTitle,p.title,p.revision||null]).sort(),[['Content Library','Calm form',null],['Content Library','Calm settings','web'],['Design Lab','Calm form',null]]);
  const lab=places.places.find(p=>p.boardId==='lab');
  assert.equal(lab.href,`/boards/lab/#items/${calm.placementIds[0]}`);assert.equal(lab.number,'01');
  assert.equal(places.places.find(p=>p.itemId===other.itemId).href,`/boards/library/#items/${other.placementIds[0]}~web`);
  const legacyPlaces=JSON.parse((await raw(port,`/api/resource-places?url=${encodeURIComponent('/boards/legacy/files/rounds/first/alpha/index.html')}`)).body);
  assert.deepEqual(legacyPlaces.places.map(p=>[p.boardTitle,p.title,p.href]),[['Legacy board','Alpha','/boards/legacy/#first/alpha']]);
  assert.equal((await raw(port,'/api/resource-places?url=/app/item.html')).status,400);
  assert.equal((await raw(port,'/api/resource-places?url=/resources/assets/missing.html')).status,404);
  assert.equal((await raw(port,'/api/resource-places?url=/resources/assets/calm.html',{host:'evil.example:80'})).status,403);
});
