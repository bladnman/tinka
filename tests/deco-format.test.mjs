import test from "node:test";
import assert from "node:assert/strict";
import {formatToHTMLString as f, formatDecorationText, toggleDecorationTask} from "../public/deco-format.js";

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

test("rich board Text renders semantic headings, inline formatting and read-only tasks", () => {
  assert.equal(f("## Next ~~step~~\n###### **Done**\n- [x] Send *draft*", {rich:true}),
    '<h2 class="deco-heading">Next <del>step</del></h2><h6 class="deco-heading"><strong>Done</strong></h6>' +
    '<ul class="deco-list"><li class="deco-task"><span class="deco-check checked" aria-hidden="true">☑ </span>Send <em>draft</em></li></ul>');
  assert.equal(f("# ~~step~~\n- [ ]"),
    '<div class="deco-heading">~~step~~</div><ul class="deco-list"><li>[ ]</li></ul>');
});

test("interactive tasks expose the exact UTF-16 marker and the escaped rendered task label", () => {
  const source = '😀\r\n\t- [ ] **Review** "draft" & <tag>\n2) [X] Send `draft`\r[x] Done\n* [ ]';
  const out = f(source, {rich:true, interactive:true});
  const offsets = [...out.matchAll(/data-deco-task="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(offsets, [source.indexOf('[ ]') + 1, source.indexOf('[X]') + 1,
    source.indexOf('[x]') + 1, source.lastIndexOf('[ ]') + 1]);
  assert.deepEqual(offsets.map(offset => toggleDecorationTask(source, offset)), [
    source.replace('- [ ]', '- [x]'), source.replace('2) [X]', '2) [ ]'),
    source.replace('[x] Done', '[ ] Done'), source.replace('* [ ]', '* [x]'),
  ]);
  assert.match(out, /<button type="button"[^>]+role="checkbox" aria-checked="false" aria-label="Review &quot;draft&quot; &amp; &lt;tag&gt;"/);
  assert.match(out, /aria-checked="true" aria-label="Send draft"/);
  assert.match(out, /aria-label="Task"/);
  assert.match(out, /<\/button> <strong>Review<\/strong> &quot;draft&quot; &amp; &lt;tag&gt;/);
});

test("task toggles reject offsets outside actual task markers", () => {
  const source = 'Plain [ ] here\n- `[x] literal`\r\n- [ ] work [X] later\n[!] other\n[x]no space\n<button data-deco-task="7">';
  const out = f(source, {rich:true, interactive:true});
  const trueOffset = source.lastIndexOf('[ ]') + 1;
  assert.equal(out.match(/<button /g)?.length, 1);
  assert.match(out, /&lt;button data-deco-task=&quot;7&quot;&gt;/);
  for (const offset of [source.indexOf('[ ]') + 1, source.indexOf('[x]') + 1, source.indexOf('[X]') + 1,
    source.indexOf('[!]') + 1, source.lastIndexOf('[x]') + 1, trueOffset - 1, trueOffset + 1,
    String(trueOffset), trueOffset + 0.5, -1, source.length]) {
    assert.equal(toggleDecorationTask(source, offset), null);
  }
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
