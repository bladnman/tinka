import test from "node:test";
import assert from "node:assert/strict";
import {formatToHTMLString as f, formatDecorationText} from "../public/deco-format.js";

test("plain text is escaped, one line per div", () => {
  assert.equal(f("a & b\nc"), '<div class="deco-line">a &amp; b</div><div class="deco-line">c</div>');
  assert.equal(f(""), '<div class="deco-line"><br></div>');
});

test("inline bold, italic, code", () => {
  assert.equal(f("**b** *i* `c`"), '<div class="deco-line"><strong>b</strong> <em>i</em> <code>c</code></div>');
  assert.equal(f("**a *b* c**"), '<div class="deco-line"><strong>a <em>b</em> c</strong></div>');
  assert.equal(f("`**not bold**`"), '<div class="deco-line"><code>**not bold**</code></div>');
  assert.equal(f("2 * 3 * 4"), '<div class="deco-line">2 * 3 * 4</div>');
});

test("bullets, numbered lists, heading", () => {
  assert.equal(f("- one\n* two"), '<ul class="deco-list"><li>one</li><li>two</li></ul>');
  assert.equal(f("1. a\n2. b"), '<ol class="deco-list"><li>a</li><li>b</li></ol>');
  assert.equal(f("# Title"), '<div class="deco-heading">Title</div>');
});

test("checkboxes", () => {
  assert.equal(f("[ ] todo"), '<div class="deco-line"><span class="deco-check" aria-hidden="true">☐ </span>todo</div>');
  assert.equal(f("- [x] done"), '<ul class="deco-list"><li class="deco-task"><span class="deco-check checked" aria-hidden="true">☑ </span>done</li></ul>');
});

test("XSS: markup in user text stays literal", () => {
  const out = f('<script>alert(1)</script> **<img src=x onerror=alert(1)>** `<b>`');
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(out.includes("<code>&lt;b&gt;</code>"));
  assert.equal(f('# "x" \'y\''), '<div class="deco-heading">&quot;x&quot; &#39;y&#39;</div>');
});

test("DOM renderer uses text nodes only", () => {
  // Minimal fake document: records textContent/text nodes, has no innerHTML.
  const make = tag => ({tag, children:[], attrs:{}, className:"", set textContent(v){this.children=[{text:v}];},
    append(...n){this.children.push(...n);}, setAttribute(k,v){this.attrs[k]=v;}, get childNodes(){return this.children;}});
  const doc = {createDocumentFragment:() => make("#frag"), createElement:make, createTextNode:text => ({text})};
  const frag = formatDecorationText("<script>x</script> **b**", doc);
  const div = frag.children[0];
  assert.equal(div.tag, "div");
  assert.deepEqual(div.children[0], {text:"<script>x</script> "});
  assert.equal(div.children[1].tag, "strong");
  assert.deepEqual(div.children[1].children[0], {text:"b"});
});
