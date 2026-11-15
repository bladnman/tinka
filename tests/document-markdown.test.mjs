import test from 'node:test';
import assert from 'node:assert/strict';
import {markdownToDom,domToMarkdown,serializeDocument,safeUrl,titleFromMarkdown} from '../public/document-markdown.js';

// Minimal DOM: just what document-markdown.js uses.
class Node_ {
  constructor(nodeType,nodeName,value=null){this.nodeType=nodeType;this.nodeName=nodeName;this.nodeValue=value;this.childNodes=[];this.attributes={};}
  appendChild(child){this.childNodes.push(child);return child;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return key in this.attributes?this.attributes[key]:null;}
  get textContent(){return this.nodeType===3?this.nodeValue:this.childNodes.map(c=>c.textContent).join('');}
}
const doc={createElement:tag=>new Node_(1,tag.toUpperCase()),createTextNode:text=>new Node_(3,'#text',text)};
const el=(tag,attrs={},...children)=>{const n=doc.createElement(tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);for(const c of children)n.appendChild(typeof c==='string'?doc.createTextNode(c):c);return n;};
const roundTrip=md=>domToMarkdown(markdownToDom(doc,el('div'),md));
const tags=md=>markdownToDom(doc,el('div'),md).childNodes.map(n=>n.nodeName.toLowerCase());

const cases={
  'heading 1':'# Launch plan\n',
  'heading 2':'## Section\n',
  'headings 3 and 4':'### Third\n\n#### Fourth\n',
  'paragraph':'Plain words here.\n',
  'paragraph line break':'First line\nsecond line\n',
  'bold':'Some **bold** text.\n',
  'italic':'Some *italic* text.\n',
  'strikethrough':'Some ~~gone~~ text.\n',
  'inline code':'Run `npm test` now.\n',
  'link':'See [the docs](https://example.com/a?b=1) here.\n',
  'image':'![A chart](images/chart.png)\n',
  'nested inline':'**bold with *italic* inside** and [**strong link**](https://example.com)\n',
  'bulleted list':'- one\n- two\n- three\n',
  'numbered list':'1. first\n2. second\n',
  'checklist':'- [ ] todo\n- [x] done\n',
  'quote':'> A quoted line\n',
  'quote with paragraphs':'> First\n>\n> Second\n',
  'code block':'```\nconst a = 1;\n\nif (a) {}\n```\n',
  'divider':'Above\n\n---\n\nBelow\n',
  'table kept raw':'| A | B |\n| --- | --- |\n| 1 | 2 |\n',
  'mixed document':'# Title\n\nIntro with **bold**.\n\n## Tasks\n\n- [ ] write\n- [x] review\n\n1. a\n2. b\n\n> quote\n\n```\ncode\n```\n\n---\n\nEnd.\n',
};
for(const [label,md] of Object.entries(cases))
  test(`round trip is stable: ${label}`,()=>{assert.equal(roundTrip(md),md);assert.equal(roundTrip(roundTrip(md)),md);});

test('markdown builds the expected editor elements',()=>{
  assert.deepEqual(tags('# a\n\n## b\n\npara\n\n- x\n\n1. y\n\n- [ ] z\n\n> q\n\n```\nc\n```\n\n---'),['h1','h2','p','ul','ol','ul','blockquote','pre','hr']);
  const list=markdownToDom(doc,el('div'),'- [x] done').childNodes[0];
  assert.equal(list.getAttribute('class'),'checklist');assert.equal(list.childNodes[0].getAttribute('data-checked'),'true');
  const inline=markdownToDom(doc,el('div'),'**b** *i* ~~s~~ `c`').childNodes[0].childNodes.filter(n=>n.nodeType===1).map(n=>n.nodeName.toLowerCase());
  assert.deepEqual(inline,['strong','em','s','code']);
});

test('markdown shorthands normalize to one canonical form',()=>{
  assert.equal(roundTrip('* a\n+ b'),'- a\n- b\n');
  assert.equal(roundTrip('3) x\n4) y'),'1. x\n2. y\n');
  assert.equal(roundTrip('_em_ and ***'),'*em* and ***\n');
  assert.equal(roundTrip('- [X] Done'),'- [x] Done\n');
});

test('browser-produced DOM serializes to clean markdown',()=>{
  const root=el('div',{},
    el('h1',{},'Title'),
    el('div',{},'Loose ',el('b',{},'bold'),' and ',el('i',{},'it'),' ',el('span',{style:'color:red'},'span'),' end​'),
    el('p',{},el('br')),
    el('ul',{class:'checklist'},el('li',{'data-checked':'true'},'Shipped'),el('li',{'data-checked':'false'},'Next')),
    el('ol',{},el('li',{},'One'),el('li',{},el('strike',{},'Two'))),
    el('blockquote',{},el('p',{},'Said')),
    el('p',{},el('a',{href:'javascript:alert(1)'},'bad link'),' ',el('a',{href:'https://ok.example'},'good')),
    el('pre',{},'line 1',el('br'),'line 2'),
    el('hr'),
    'trailing text');
  assert.equal(domToMarkdown(root),'# Title\n\nLoose **bold** and *it* span end\n\n- [x] Shipped\n- [ ] Next\n\n1. One\n2. ~~Two~~\n\n> Said\n\nbad link [good](https://ok.example)\n\n```\nline 1\nline 2\n```\n\n---\n\ntrailing text\n');
  assert.equal(domToMarkdown(el('div',{},el('p',{},el('strong',{},'bold '),'next'))),'**bold** next\n');
  assert.equal(domToMarkdown(el('div',{},el('p',{},el('br')))),'');
  assert.equal(domToMarkdown(el('div',{},el('p',{},'Hi',el('script',{},'bad()'),el('style',{},'p{}')),el('script',{},'x()'))),'Hi\n');
});

test('unsafe URLs are dropped',()=>{
  for(const bad of ['javascript:alert(1)','data:text/html,x','vbscript:x',' JavaScript:x'])assert.equal(safeUrl(bad),'');
  for(const ok of ['https://a.b','mailto:x@y.z','#top','/a','./a','a/b.png'])assert.equal(safeUrl(ok),ok);
  const link=markdownToDom(doc,el('div'),'[x](javascript:alert(1))').childNodes[0].childNodes[0];
  assert.notEqual(link.getAttribute?.('href'),'javascript:alert(1)');
});

test('title comes from the first non-empty line',()=>{
  assert.equal(titleFromMarkdown('\n\n## Hi there\n\nx'),'Hi there');assert.equal(titleFromMarkdown(''),'');
});

const agentDoc='\n# Agent notes\n\n* star bullet\n* another\n\nSome _underscored_ text\nwith a soft break  \nand a hard one.\n\n\n## Nested\n\n- top\n  - child\n    - grandchild\n\n<details><summary>HTML</summary>\nkept\n</details>\n\n##### Fifth level\n\n[ref]: https://example.com\n\n    indented code\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nLast line without newline';
test('unedited documents serialize byte-for-byte, including spacing and constructs the editor does not model',()=>{
  const root=markdownToDom(doc,el('div'),agentDoc);
  assert.equal(serializeDocument(root),agentDoc);
  const raws=root.childNodes.filter(n=>n.getAttribute('class')==='doc-raw').map(n=>n.getAttribute('data-markdown').split('\n')[0]);
  assert.deepEqual(raws,['- top','<details><summary>HTML</summary>','##### Fifth level','[ref]: https://example.com','    indented code','| a | b |']);
});
test('only edited blocks are re-serialized; neighbours keep their exact source',()=>{
  const root=markdownToDom(doc,el('div'),agentDoc);
  const para=root.childNodes.find(n=>n.nodeName==='P'&&n.textContent.startsWith('Some'));
  para.childNodes.length=0;para.appendChild(doc.createTextNode('Rewritten paragraph'));
  const out=serializeDocument(root);
  assert.equal(out,agentDoc.replace('Some _underscored_ text\nwith a soft break  \nand a hard one.','Rewritten paragraph'));
  // a new block inserted between two originals uses a blank line on each side
  const root2=markdownToDom(doc,el('div'),'# A\n\n* x\n');
  root2.childNodes.splice(1,0,el('p',{},'New'));
  assert.equal(serializeDocument(root2),'# A\n\nNew\n\n* x\n');
  // removing the last original block ends with one newline
  const root3=markdownToDom(doc,el('div'),'* a\n\ntail');root3.childNodes.pop();
  assert.equal(serializeDocument(root3),'* a\n');
  // a block whose text changes back to its original still keeps its exact source
  const root4=markdownToDom(doc,el('div'),'Some _x_ here\n');
  assert.equal(serializeDocument(root4),'Some _x_ here\n');
});
