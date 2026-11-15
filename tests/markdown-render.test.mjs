// The shared card/reader renderer: checklists, strikethrough and nested inline formatting,
// with rendered text matching the parser's text model and only safe elements produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineRuns,parseMarkdown,renderMarkdownDocument} from '../public/markdown-document.js';

class El {
  constructor(tag,text=null){this.tagName=tag;this.children=[];this.attrs={};this.dataset={};this.text=text;}
  append(...nodes){this.children.push(...nodes);}
  setAttribute(k,v){this.attrs[k]=String(v);}
  get textContent(){return this.text??this.children.map(c=>c.textContent).join('');}
  set textContent(v){this.text=String(v);this.children=[];}
  get style(){return this._style||(this._style={});}
}
const doc={createElement:tag=>new El(tag),createTextNode:text=>new El('#text',text)};
const options={baseUrl:'http://127.0.0.1/resources/docs/a.md',origin:'http://127.0.0.1',resourcePrefix:'/resources/docs/'};
const html=node=>node.tagName==='#text'?node.text:node.tagName==='input'?`<input${node.checked?' checked':''}>`:`<${node.tagName}>${node.text??node.children.map(html).join('')}</${node.tagName}>`;
const render=md=>{const model=parseMarkdown(md);return {model,article:renderMarkdownDocument(doc,model,options)};};

test('checklists render read-only boxes and keep plain items plain',()=>{
  const {model,article}=render('- [ ] write **notes**\n- [x] ship\n- [ ]\n- plain');
  const list=article.children[0];
  assert.equal(list.tagName,'ul');assert.equal(list.className,'task-list');
  assert.deepEqual(model.blocks[0].tasks,[false,true,false,null]);
  const items=list.children.filter(c=>c.tagName==='li'),boxes=items.map(li=>li.children.find(c=>c.tagName==='input'));
  assert.deepEqual(boxes.slice(0,3).map(b=>[b.type,b.checked,b.disabled]),[['checkbox',false,true],['checkbox',true,true],['checkbox',false,true]]);
  assert.equal(boxes[3],undefined);assert.equal(items[1].dataset.checked,'true');
  assert.equal(html(items[0]),'<li><input>write <strong>notes</strong></li>');
  assert.equal(article.textContent,model.rawText,'rendered text matches the text model');
  assert.equal(model.text,'write notes ship plain');
});

test('ordered lists and ordinary lists are unchanged',()=>{
  const {model,article}=render('1. [ ] literal\n2. two');
  assert.equal(model.blocks[0].tasks,undefined);assert.equal(article.children[0].className,undefined);
  assert.equal(article.textContent,'[ ] literal\ntwo');
});

test('strikethrough and nested inline formatting keep every layer',()=>{
  const {model,article}=render('*~~[see](https://example.com) this~~ now* and ***both*** and **b *i* b** `c*d*` snake_case _it_ a * b *');
  assert.equal(html(article.children[0]),'<p><em><del><a>see</a> this</del> now</em> and <strong><em>both</em></strong> and <strong>b <em>i</em> b</strong> <code>c*d*</code> snake_case <em>it</em> a * b *</p>');
  assert.equal(article.textContent,model.rawText);
  const link=article.children[0].children[0].children[0].children[0];assert.equal(link.href,'https://example.com/');assert.equal(link.rel,'noopener noreferrer');
});

test('formatting inside links and unclosed markers stay safe and literal',()=>{
  assert.deepEqual(inlineRuns('[**bold** link](https://e.com)')[0],{type:'link',text:'bold link',url:'https://e.com',children:[{type:'strong',text:'bold',children:[{type:'text',text:'bold'}]},{type:'text',text:' link'}]});
  assert.deepEqual(inlineRuns('~~open and **open'),[{type:'text',text:'~~open and **open'}]);
  const {article}=render('~~[x](javascript:alert(1))~~ <b>raw</b>');
  assert.equal(html(article.children[0]),'<p><del><span>x</span>)</del> <b>raw</b></p>','unsafe link becomes a span; raw HTML stays one text node');
  const tags=new Set();(function walk(n){tags.add(n.tagName);n.children.forEach(walk);})(article);
  assert.ok([...tags].every(tag=>['article','p','del','span','#text'].includes(tag)),[...tags].join());
});
