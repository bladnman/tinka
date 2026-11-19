import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {callTool} from '../lib/tools.mjs';
import {applyOperation,getBoardSnapshot} from '../lib/workspace.mjs';
import {emojiSticker,favoriteEmoji} from '../public/emoji-stickers.js';
import {emojiEntries,emojiGroups,emojiVersion} from '../public/emoji-repertoire.js';
import {makeEmojiSearch} from '../public/emoji-search.js';
// Drawn elements now carry their place in the board's stacking order (z); these
// checks are about style and geometry, so they compare without it.
const unstacked = value => Array.isArray(value) ? value.map(unstacked) : value && typeof value === 'object' ? (({z, ...rest}) => rest)(value) : value;
const sameDrawn = (actual, expected) => assert.deepEqual(unstacked(actual), unstacked(expected));


test('one pasted emoji retains its Unicode sequence',()=>{
  for(const value of ['🚀','⚡️','👩🏽‍💻','🇨🇦','4️⃣'])assert.equal(emojiSticker(` ${value} `),value);
  for(const value of ['ordinary text','two 🙂','🚀🔥','5','™','\u200d','👷\uFE0E'])assert.equal(emojiSticker(value),null);
});

test('the complete bundled repertoire can be added and has category and global keyword search',()=>{
  assert.equal(emojiVersion,'18.0');
  assert.equal(emojiEntries.length,3972);
  assert.equal(new Set(emojiEntries.map(([emoji])=>emoji)).size,emojiEntries.length);
  for(const [emoji] of emojiEntries)assert.equal(emojiSticker(emoji),emoji);
  const find=makeEmojiSearch(emojiEntries,emojiGroups);
  const animals=emojiGroups.indexOf('Animals & Nature'),people=emojiGroups.indexOf('People & Body');
  assert.deepEqual(find('',-1,false).entries,favoriteEmoji);
  assert.ok(find('',animals,false).entries.some(([emoji])=>emoji==='🫍'));
  for(const [query,emoji] of [
    ['release','🚀'],['fire truck','🚒'],['orca','🫍'],['cracking face','🫫'],
    ['flag scotland','\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
    ['Cote d Ivoire','🇨🇮'],['thumbs up medium skin tone','👍🏽'],['head shaking horizontally','🙂‍↔️'],
  ])assert.equal(find(query,animals,false).entries[0][0],emoji,query);
  assert.deepEqual(find('👩🏽‍💻',-1,false).entries,[['👩🏽‍💻','Woman technologist: medium skin tone']]);
  assert.equal(find('',people,false).canShowTones,true);
  assert.ok(find('',people,true).entries.length > find('',people,false).entries.length);
  assert.deepEqual(find('noactualemojimatches',-1,false).entries,[]);
});

test('a sticker from the bundled repertoire can use code points newer than the host Unicode runtime',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'tinka-unicode-sticker-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const boardsRoot=path.join(directory,'boards'),config={boardsRoot,port:43000};
  await mkdir(boardsRoot);
  const boardId='new-emoji';
  await applyOperation(config,{type:'createBoard',id:boardId,title:'New emoji'});
  const decoration={id:'cracking-face',type:'text',text:'🫫',sticker:true,x:0,y:0,width:112,height:112,color:'palette:neutral'};
  await callTool(config,'decoration.create',{boardId,decoration});
  sameDrawn((await getBoardSnapshot(config,boardId)).decorations,[decoration]);
});

test('sticker creation, rotation, copy and group retain compact independent board data',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'tinka-stickers-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const boardsRoot=path.join(directory,'boards'),config={boardsRoot,port:43000};
  await mkdir(boardsRoot);
  const boardId='ideas', op=(type,fields)=>applyOperation(config,{type,boardId,...fields});
  await op('createBoard',{id:boardId,title:'Ideas'});
  const geometry={type:'text',x:15,y:20,width:112,height:112,color:'palette:neutral'};
  const original={...geometry,id:'rocket',sticker:true,text:'🚀'};
  await callTool(config,'decoration.create',{boardId,decoration:original});
  const transformed=await callTool(config,'decoration.update',{boardId,decorationId:'rocket',patch:{rotation:-45,width:180,height:180}});
  const snapshot=()=>getBoardSnapshot(config,boardId);
  sameDrawn((await snapshot()).decorations[0],{...original,rotation:-45,width:180,height:180});
  const inverse=await op('restoreMovement',{history:transformed.history});
  sameDrawn((await snapshot()).decorations[0],original);
  await op('restoreMovement',{history:inverse.history});
  const duplicate=await op('duplicateOccurrences',{placementIds:[],decorationIds:['rocket'],dx:12,dy:15});
  const saved=await snapshot(), copy=saved.decorations.find(d=>d.id===duplicate.result.decorationIds[0]);
  sameDrawn(copy,{...saved.decorations[0],id:copy.id,x:27,y:35});
  await op('groupOccurrences',{placementIds:[],decorationIds:['rocket',copy.id]});
  assert.deepEqual((await snapshot()).groups[0].decorationIds,['rocket',copy.id]);
  await assert.rejects(op('updateDecoration',{decorationId:'rocket',patch:{rotation:181}}),{status:400});
  await assert.rejects(op('updateDecoration',{decorationId:'rocket',patch:{text:'🚀 Launch'}}),{status:400});
  await assert.rejects(op('createDecoration',{decoration:{...geometry,id:'plain',text:'Ordinary',rotation:20}}),{status:400});
  assert.ok((await readFile(path.join(boardsRoot,'.tinka','boards','ideas.json'))).length<2000);
});
