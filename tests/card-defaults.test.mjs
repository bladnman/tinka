import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {externalClipboard} from '../public/clipboard.js';

test('new visual items get readable panels while explicit modes, saved layouts and references survive',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'tinka-card-defaults-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={boardsRoot:path.join(root,'boards')};await mkdir(config.boardsRoot);
 const op=(type,data={})=>applyOperation(config,{type,...data});
 await op('createBoard',{id:'board',title:'Visual comparison'});
 await op('updateWorkspace',{patch:{resourceRoots:{assets:{path:'../assets'}}}});
 const create=(id,content,placement,preview)=>op('createItem',{boardId:'board',item:{id,title:id,...(content?{content}:{}),...(preview?{preview}:{})},...(placement?{placement}:{})});
 for(const kind of ['html','image','video','pdf','markdown'])await create(kind,{kind,resource:{rootId:'assets',path:`work.${kind}`}},{x:0,y:0});
 await create('preview',{kind:'url',url:'https://example.com'},{}, {url:'https://example.com/still.png'});
 await op('createBoard',{id:'automatic',title:'Automatic spacing'});
 for(let index=0;index<6;index++)await op('createItem',{boardId:'automatic',item:{title:`Visual ${index}`,content:{kind:'html',resource:{rootId:'assets',path:'work.html'}}}});
 const automatic=(await getBoardSnapshot(config,'automatic')).placements;
 for(const a of automatic)for(const b of automatic)if(a!==b)assert.equal(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y,false,'new panels must not overlap');
 await create('idea');
 await create('compact',{kind:'html',resource:{rootId:'assets',path:'work.html'}},{width:320,height:240,presentation:{mode:'card',paper:'#f6f7f1'}});
 await create('icon',{kind:'image',resource:{rootId:'assets',path:'work.png'}},{presentation:{mode:'icon'}});
 let snapshot=await getBoardSnapshot(config,'board');
 for(const id of ['html','image','video','pdf','markdown','preview']){
  const p=snapshot.placements.find(p=>p.itemId===id);assert.equal(p.presentation.mode,'panel');assert.equal(p.width,720);assert.equal(p.height,560);
 }
 assert.equal(snapshot.placements.find(p=>p.itemId==='idea').presentation.mode,'card');
 const compact=snapshot.placements.find(p=>p.itemId==='compact');assert.equal(compact.width,320);assert.equal(compact.height,240);assert.equal(compact.presentation.mode,'card');
 const icon=snapshot.placements.find(p=>p.itemId==='icon');assert.equal(icon.presentation.mode,'icon');assert.equal(icon.width,218);
 // Emulate an existing pre-default placement. Content edits do not convert it.
 const file=path.join(config.boardsRoot,'.tinka','boards','board.json');const saved=JSON.parse(await readFile(file));delete saved.placements.find(p=>p.itemId==='compact').presentation;await writeFile(file,JSON.stringify(saved));
 await op('updateItem',{itemId:'compact',patch:{description:'Keep the saved layout'}});
 snapshot=await getBoardSnapshot(config,'board');const existing=snapshot.placements.find(p=>p.itemId==='compact');assert.equal(existing.presentation,undefined);assert.equal(existing.width,320);assert.equal(existing.id,compact.id);
 await op('createBoard',{id:'other',title:'References'});await op('reference',{sourceBoardId:'board',placementIds:[existing.id],targetBoardId:'other'});
 const reference=(await getBoardSnapshot(config,'other')).placements[0];assert.equal(reference.presentation,undefined);assert.equal(reference.width,320);
});

test('new pasted image links use Full preview; text and copied snapshots keep their own geometry',()=>{
 const link=externalClipboard('workspace',{kind:'url',url:'https://example.com/work'},{title:'Work',image:'https://example.com/still.png'});
 assert.equal(link.placements[0].presentation.mode,'panel');assert.equal(link.placements[0].width,720);assert.equal(link.placements[0].height,560);
 const text=externalClipboard('workspace',{kind:'text',text:'An idea\nThe complete document'});assert.equal(text.placements[0].width,380);assert.equal(text.placements[0].height,440);assert.equal(text.placements[0].presentation,undefined);
 const plain=externalClipboard('workspace',{kind:'url',url:'https://example.com/work'});assert.equal(plain.placements[0].width,360);assert.equal(plain.placements[0].presentation,undefined);
});
