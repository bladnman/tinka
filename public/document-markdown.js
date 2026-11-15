// Markdown <-> editable DOM for the board document editor. Pure functions over a
// minimal DOM interface (createElement, createTextNode, appendChild, childNodes,
// nodeName, nodeType, getAttribute/setAttribute, textContent), so node:test can
// run them with a tiny fake document. Supported: H1-H4, paragraphs (with line
// breaks), bold, italic, strikethrough, inline code, links, images, bulleted,
// numbered and checklist items, quotes, fenced code, dividers. Tables are kept as
// raw Markdown in a non-editable block so they survive a round trip unchanged.

const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;
export const safeUrl = value => { const url = String(value || "").trim(); return url && SAFE_URL.test(url) && !/^\s*(?:javascript|data|vbscript):/i.test(url) ? url : ""; };

// ---------- Markdown -> DOM ----------
const TOKEN = /(!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_)/;
export function appendInline(doc, parent, text) {
  let rest = String(text);
  while (rest) {
    const match = TOKEN.exec(rest);
    if (!match) { parent.appendChild(doc.createTextNode(rest)); break; }
    if (match.index) parent.appendChild(doc.createTextNode(rest.slice(0, match.index)));
    if (match[2] !== undefined) {
      const img = doc.createElement("img"); img.setAttribute("alt", match[2]); img.setAttribute("data-src", match[3]);
      const src = safeUrl(match[3]); if (src) img.setAttribute("src", src); parent.appendChild(img);
    } else if (match[4] !== undefined) {
      const a = doc.createElement("a"); a.setAttribute("href", safeUrl(match[5]) || "#"); appendInline(doc, a, match[4]); parent.appendChild(a);
    } else if (match[6] !== undefined) {
      const code = doc.createElement("code"); code.appendChild(doc.createTextNode(match[6])); parent.appendChild(code);
    } else {
      const tag = match[7] !== undefined ? "strong" : match[8] !== undefined ? "s" : "em";
      const el = doc.createElement(tag); appendInline(doc, el, match[7] ?? match[8] ?? match[9] ?? match[10]); parent.appendChild(el);
    }
    rest = rest.slice(match.index + match[0].length);
  }
}
function appendLines(doc, parent, lines) {
  lines.forEach((line, i) => { if (i) parent.appendChild(doc.createElement("br")); appendInline(doc, parent, line); });
}
const LIST = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const TASK = /^\[([ xX]?)\]\s?(.*)$/;
const isTableStart = (lines, i) => /^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "");
const RAW_START = /^(?:\s{0,3}<(?:[a-zA-Z][\w-]*|!--|\/[a-zA-Z])|#{5,6}\s|\s{0,3}\[[^\]]+\]:\s|(?: {4}|\t)\S)/;
const blockStart = line => /^(#{1,4}\s|\s*```|\s*>|\s*(?:---+|\*\*\*+)\s*$)/.test(line) || LIST.test(line) || RAW_START.test(line);
function rawBlock(doc, text) {
  // Constructs the editor does not model (nested lists, HTML, h5/h6, reference links, indented
  // code, tables) stay as their exact source in a block that is not edited in place.
  const el = doc.createElement("div"); el.setAttribute("data-markdown", text); el.setAttribute("contenteditable", "false");
  el.setAttribute("class", "doc-raw"); el.appendChild(doc.createTextNode(text)); return el;
}

/** Append editor blocks for `markdown` to `root`. Top-level blocks remember their exact source
 *  (root.__mdSource, data-md-i) so serializeDocument can keep unedited blocks byte-for-byte. */
export function markdownToDom(doc, root, markdown) { return parseBlocks(doc, root, String(markdown).replace(/\r\n?/g, "\n"), true); }
function parseBlocks(doc, root, text, track) {
  const lines = text.split("\n"), spans = [];
  const add = (el, start, end) => { root.appendChild(el); if (track) spans.push({el, start, end}); };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i], start = i;
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const code = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = doc.createElement("pre"); pre.appendChild(doc.createTextNode(code.join("\n"))); add(pre, start, i); continue;
    }
    if (isTableStart(lines, i)) { while (i < lines.length && /^\s*\|/.test(lines[i])) i++; add(rawBlock(doc, lines.slice(start, i).join("\n")), start, i); continue; }
    if (RAW_START.test(line)) {
      const single = /^#{5,6}\s/.test(line);
      i++; if (!single) while (i < lines.length && lines[i].trim()) i++;
      add(rawBlock(doc, lines.slice(start, i).join("\n")), start, i); continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { const h = doc.createElement(`h${heading[1].length}`); appendInline(doc, h, heading[2].trim()); i++; add(h, start, i); continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { i++; add(doc.createElement("hr"), start, i); continue; }
    if (/^\s*>/.test(line)) {
      const quoted = []; while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      const quote = doc.createElement("blockquote"); parseBlocks(doc, quote, quoted.join("\n"), false); add(quote, start, i); continue;
    }
    const first = LIST.exec(line);
    if (first) {
      const ordered = !!first[2], task = !ordered && TASK.test(first[3]), items = [];
      let nested = false;
      while (i < lines.length && lines[i].trim()) {
        const item = LIST.exec(lines[i]);
        if (item && /^\s{2,}/.test(lines[i])) { nested = true; items.push(null); i++; continue; } // nested item
        if (!item) { if (/^\s+\S/.test(lines[i])) { nested = true; i++; continue; } break; }  // indented continuation
        if (!!item[2] !== ordered || (!ordered && TASK.test(item[3]) !== task)) break;
        items.push(item[3]); i++;
      }
      if (nested) { add(rawBlock(doc, lines.slice(start, i).join("\n")), start, i); continue; }
      const list = doc.createElement(ordered ? "ol" : "ul"); if (task) list.setAttribute("class", "checklist");
      for (let text of items) {
        const li = doc.createElement("li");
        if (task) { const t = TASK.exec(text); li.setAttribute("data-checked", /x/i.test(t[1]) ? "true" : "false"); text = t[2]; }
        appendInline(doc, li, text); list.appendChild(li);
      }
      add(list, start, i); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !blockStart(lines[i])) && !isTableStart(lines, i)) para.push(lines[i++].trim());
    const p = doc.createElement("p"); appendLines(doc, p, para); add(p, start, i);
  }
  if (track) {
    const offsets = []; let at = 0; for (const l of lines) { offsets.push(at); at += l.length + 1; }
    const lineStart = n => n < lines.length ? offsets[n] : text.length + 1;
    const blocks = spans.map(({el, start, end}, k) => {
      el.setAttribute("data-md-i", String(k));
      const from = offsets[start], to = lineStart(end) - 1, next = spans[k + 1];
      return {src: text.slice(from, to), canon: blockMarkdown(el), gap: next ? text.slice(to, offsets[next.start]) : "", to};
    });
    root.__mdSource = {prefix: spans.length ? text.slice(0, offsets[spans[0].start]) : "", blocks, suffix: spans.length ? text.slice(blocks.at(-1).to) : text};
  }
  return root;
}

// ---------- DOM -> Markdown ----------
const ELEMENT = 1, TEXT = 3;
const name = node => String(node.nodeName || "").toLowerCase();
const BLOCKS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "section", "article", "header", "footer", "table", "figure"]);
const SKIP = new Set(["script", "style", "template", "noscript", "head", "title", "meta", "link", "iframe", "object", "svg"]);
const clean = text => text.replace(/[​﻿]/g, "").replace(/ /g, " ");
function wrap(marker, inner, close = marker) {
  // Keep surrounding spaces outside the markers so the result parses again.
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? `${m[1]}${marker}${m[2]}${close}${m[3]}` : inner;
}
export function inlineMarkdown(node, inCode = false) {
  let out = "";
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === TEXT) { out += clean(child.nodeValue ?? child.textContent ?? ""); continue; }
    if (child.nodeType !== ELEMENT) continue;
    const tag = name(child);
    if (SKIP.has(tag)) continue;
    if (tag === "br") { out += "\n"; continue; }
    if (inCode) { out += inlineMarkdown(child, true); continue; }
    if (tag === "img") { const src = child.getAttribute("data-src") || child.getAttribute("src") || ""; if (safeUrl(src)) out += `![${child.getAttribute("alt") || ""}](${src})`; continue; }
    const inner = inlineMarkdown(child);
    if (tag === "strong" || tag === "b") out += wrap("**", inner);
    else if (tag === "em" || tag === "i") out += wrap("*", inner);
    else if (tag === "s" || tag === "del" || tag === "strike") out += wrap("~~", inner);
    else if (tag === "code" || tag === "kbd" || tag === "samp") { const code = clean(child.textContent || "").replace(/`/g, ""); out += code ? `\`${code}\`` : ""; }
    else if (tag === "a") { const href = safeUrl(child.getAttribute("href")); out += href && href !== "#" && inner.trim() ? `[${inner.trim()}](${href.replace(/\s/g, "%20")})` : inner; }
    else if (BLOCKS.has(tag)) out += (out && !out.endsWith("\n") ? "\n" : "") + inner + "\n";
    else out += inner; // span, font, u, mark and anything else: keep the text only
  }
  return out;
}
const lines = text => text.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "").split("\n").map(line => line.replace(/[ \t]+/g, " ").trim());
function listMarkdown(list) {
  const ordered = name(list) === "ol", task = !ordered && /\bchecklist\b/.test(list.getAttribute?.("class") || "");
  const items = [];
  let n = 1;
  for (const li of Array.from(list.childNodes || [])) {
    if (li.nodeType !== ELEMENT && !clean(li.textContent || "").trim()) continue;
    const text = lines(li.nodeType === ELEMENT ? inlineMarkdown(li) : clean(li.textContent)).filter(Boolean).join(" ");
    const box = task ? `[${li.getAttribute?.("data-checked") === "true" ? "x" : " "}] ` : "";
    if (!text && !task) continue;
    items.push(`${ordered ? `${n++}.` : "-"} ${box}${text}`.trimEnd());
  }
  return items.join("\n");
}
/** Markdown for one top-level block element (null when it holds nothing). */
export function blockMarkdown(node) {
  const tag = name(node);
  if (node.getAttribute?.("data-markdown")) return node.getAttribute("data-markdown");
  if (/^h[1-6]$/.test(tag)) { const text = lines(inlineMarkdown(node)).filter(Boolean).join(" "); return text ? `${"#".repeat(Math.min(4, +tag[1]))} ${text}` : null; }
  if (tag === "hr") return "---";
  if (tag === "pre") { const code = clean(inlineMarkdown(node, true)).replace(/\n$/, ""); return "```\n" + code.replace(/^```/gm, "\\`\\`\\`") + "\n```"; }
  if (tag === "ul" || tag === "ol") return listMarkdown(node) || null;
  if (tag === "blockquote") { const inner = domToMarkdown(node).trim(); return inner ? inner.split("\n").map(line => line ? `> ${line}` : ">").join("\n") : null; }
  if (tag === "li") { const text = lines(inlineMarkdown(node)).filter(Boolean).join(" "); return text ? `- ${text}` : null; }
  // p, div and other containers: nested blocks serialize recursively, plain content as a paragraph
  if (Array.from(node.childNodes || []).some(child => child.nodeType === ELEMENT && BLOCKS.has(name(child)))) return domToMarkdown(node).trim() || null;
  return lines(inlineMarkdown(node)).join("\n").trim() || null;
}
// Top-level parts: [{node, text}] with loose inline nodes grouped into paragraphs.
function parts(root) {
  const out = []; let loose = null;
  const flush = () => { if (loose) { const text = lines(inlineMarkdown(loose)).join("\n").trim(); if (text) out.push({node:null, text}); loose = null; } };
  for (const node of Array.from(root.childNodes || [])) {
    const tag = node.nodeType === ELEMENT ? name(node) : "";
    if (SKIP.has(tag)) continue;
    if (!BLOCKS.has(tag) && !node.getAttribute?.("data-markdown")) {
      if (node.nodeType !== TEXT && node.nodeType !== ELEMENT) continue;
      loose ||= {childNodes: []}; loose.childNodes.push(node); continue;
    }
    flush();
    const text = blockMarkdown(node); if (text) out.push({node, text});
  }
  flush();
  return out;
}
/** Serialize editor blocks under `root` to canonical Markdown (ends with one newline, or empty). */
export function domToMarkdown(root) {
  const blocks = parts(root).map(part => part.text);
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}
/** Serialize a root built by markdownToDom, keeping every unedited block (and the spacing between
 *  neighbouring unedited blocks) exactly as it was in the source. */
export function serializeDocument(root) {
  const source = root.__mdSource;
  if (!source) return domToMarkdown(root);
  const list = parts(root).map(({node, text}) => {
    const i = node?.getAttribute?.("data-md-i"), block = i != null ? source.blocks[+i] : null;
    // An edited block keeps its slot, so the original spacing around it survives too.
    return {index:block ? +i : null, text:block && block.canon === text ? block.src : text};
  });
  if (!list.length) return "";
  let out = list[0].index === 0 ? source.prefix : "";
  list.forEach((part, k) => {
    const prev = list[k - 1];
    if (k) out += prev.index != null && part.index === prev.index + 1 ? source.blocks[prev.index].gap : "\n\n";
    out += part.text;
  });
  const end = list.at(-1).index === source.blocks.length - 1 ? source.suffix : "\n";
  return out + (end || (out.endsWith("\n") ? "" : end));
}

/** First non-empty line with leading #s stripped. */
export const titleFromMarkdown = text => (String(text).split("\n").find(line => line.trim()) || "").replace(/^\s*#+\s*/, "").trim().slice(0, 200);
