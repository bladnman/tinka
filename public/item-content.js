import {
  escape,
  resourceURL,
  remoteURL,
  contentURL,
  toast,
} from "./workspace.js";
import {validTextAnchor} from './markdown-document.js';
const host = document.getElementById("item-content"),
  q = new URLSearchParams(location.search);
let item, variant, content, markdownFrame;
const preferences = {
  theme: q.get("theme") || "paper",
  scale: Number(q.get("scale") || 100),
};
function theme(theme, scale) {
  preferences.theme = theme === "night" ? "night" : "paper";
  preferences.scale = Number(scale || 100);
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.style.setProperty(
    "--item-scale",
    String(preferences.scale / 100),
  );
  for (const iframe of document.querySelectorAll("iframe")) {
    try {
      iframe.contentWindow?.postMessage(
        { type: "reader-preferences", ...preferences },
        new URL(iframe.src, location.href).origin,
      );
    } catch {}
  }
}
theme(q.get("theme"), q.get("scale"));
function selectionContext(data){
  if(!data||typeof data!=='object'||Array.isArray(data))return null;
  const context={};
  if(data.selectionId!==undefined){if(typeof data.selectionId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(data.selectionId))return null;context.selectionId=data.selectionId;}
  if(data.selectionRect!==undefined){
    const rect=data.selectionRect;if(!rect||typeof rect!=='object'||Array.isArray(rect)||Object.keys(rect).length!==4||!['top','bottom','left','right'].every(key=>Number.isFinite(rect[key])&&Math.abs(rect[key])<=100000)||rect.bottom<rect.top||rect.right<rect.left)return null;
    const frameRect=markdownFrame.getBoundingClientRect();context.selectionRect={top:rect.top+frameRect.top,bottom:rect.bottom+frameRect.top,left:rect.left+frameRect.left,right:rect.right+frameRect.left};
  }
  return context;
}
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.source === parent && e.data?.type === "reader-preferences")
    theme(e.data.theme, e.data.scale);
  if(e.source===parent&&['tinka-feedback-refresh','tinka-annotations-refresh','tinka-reader-focus','tinka-annotation-result'].includes(e.data?.type)&&markdownFrame)
    markdownFrame.contentWindow?.postMessage(e.data,location.origin);
  let currentMarkdown=false;
  try{currentMarkdown=markdownFrame&&markdownFrame.contentWindow.location.href===markdownFrame.src;}catch{}
  if(e.source===markdownFrame?.contentWindow&&currentMarkdown&&parent!==window&&!q.get('variant')&&item?.content?.kind==='markdown'&&item.content.resource&&!item.content.url){
    const context=selectionContext(e.data);if(!context)return;
    if(['tinka-comment-selection','tinka-highlight-selection'].includes(e.data?.type)&&validTextAnchor(e.data.anchor)&&/^sha256:[a-f0-9]{64}$/.test(e.data.anchor.sourceRevision||''))
      parent.postMessage({type:e.data.type,itemId:item.id,anchor:e.data.anchor,...context},location.origin);
    if(e.data?.type==='tinka-open-comment'&&typeof e.data.threadId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(e.data.threadId))
      parent.postMessage({type:'tinka-open-comment',itemId:item.id,threadId:e.data.threadId,...context},location.origin);
    if(e.data?.type==='tinka-selection-context'&&context.selectionId&&context.selectionRect)
      parent.postMessage({type:'tinka-selection-context',itemId:item.id,...context},location.origin);
    if(e.data?.type==='tinka-remove-highlight'&&typeof e.data.highlightId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(e.data.highlightId))
      parent.postMessage({type:'tinka-remove-highlight',itemId:item.id,highlightId:e.data.highlightId},location.origin);
  }
  if (
    e.source !== parent &&
    e.data?.type === "reader-close" &&
    [...document.querySelectorAll("iframe")].some(
      (f) => f.contentWindow === e.source,
    )
  )
    parent.postMessage({ type: "reader-close" }, location.origin);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && e.keyCode!==229 && !e.repeat)
    parent.postMessage({ type: "reader-close" }, location.origin);
});
function frame(source) {
  markdownFrame=null;
  const iframe = document.createElement("iframe");
  iframe.className = "item-full-frame";
  const url = new URL(source, location.href);
  if (content?.kind === "html" && url.origin === location.origin) {
    url.searchParams.set("theme", preferences.theme);
    url.searchParams.set("scale", String(preferences.scale));
    if (q.get("v")) url.searchParams.set("v", q.get("v"));
  }
  iframe.src = url.href;
  if(content?.kind==='markdown'&&url.origin===location.origin&&url.pathname==='/app/media.html')markdownFrame=iframe;
  iframe.title = item.title;
  iframe.addEventListener("load", () => {
    theme(preferences.theme, preferences.scale);
    try {
      iframe.contentWindow.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && e.keyCode!==229 && !e.repeat) {
          e.preventDefault();
          parent.postMessage({ type: "reader-close" }, location.origin);
        }
      });
    } catch {}
  });
  host.replaceChildren(iframe);
}
function render() {
  const asset = contentURL(item, variant),
    preview = resourceURL(item.preview?.resource) || remoteURL(item.preview?.url),
    remote = remoteURL(content?.url),
    external =
      remote &&
      (content?.kind === "url" ||
        ["external", "standalone", "download"].includes(content?.openMode));
  document.title = item.title + " · Tinka";
  if (
    content?.resource &&
    asset &&
    !remote &&
    content.kind === "html" &&
    !external
  ) {
    frame(asset);
    return;
  }
  if (
    asset &&
    !remote &&
    ["image", "video", "audio", "pdf", "markdown"].includes(content?.kind)
  ) {
    const params = new URLSearchParams({
      root: content.resource.rootId,
      path: content.resource.path,
      kind: content.kind,
      name: item.title,
      chrome: "none",
      theme: q.get("theme") || "paper",
      scale: q.get("scale") || "100",
    });
    if(content.kind==='markdown'){
      params.set('item',item.id);params.set('commentBoard',q.get('commentBoard')||'');
      if(q.get('variant'))params.set('variant',q.get('variant'));else params.set('annotate','1');
      if(q.get('v'))params.set('v',q.get('v'));
    }
    frame("/app/media.html?" + params);
    return;
  }
  host.innerHTML = `<article class="item-representation">${preview ? `<img class="item-saved-preview" referrerpolicy="no-referrer" src="${escape(preview)}" alt="Saved representation of ${escape(item.title)}">` : ""}<p class="workspace-eyebrow">${escape(content?.kind || "Idea")}${remote ? " · independent experience" : ""}</p><h1>${escape(item.title)}</h1>${item.preview?.text ? `<p class="item-summary">${escape(item.preview.text)}</p>` : ""}${item.description ? `<p>${escape(item.description)}</p>` : ""}${content?.text ? `<div class="item-text">${escape(content.text)}</div>` : !asset ? '<p class="item-title-only">A title is a useful beginning. Attach primary content or add a board of related material whenever it is ready.</p>' : ""}${remote ? `<p class="item-url">${escape(remote)}</p><div class="workspace-inline-actions"><a class="workspace-button" href="${escape(remote)}" target="_blank" rel="noopener noreferrer">Open externally ↗</a>${!external ? '<button type="button" id="embed">Try embedded preview</button>' : ""}<button type="button" id="retry">Retry / reload</button></div><p class="item-hint">This representation remains available when the application is stopped or embedding is blocked. Opening a frame does not verify that its server is ready.</p>` : asset ? `<a class="workspace-button" href="${escape(asset)}" target="_blank" rel="noopener noreferrer">Open resource ↗</a>` : ""}${content?.startInstructions ? `<details open><summary>Start this application</summary><pre class="item-start">${escape(content.startInstructions)}</pre><button type="button" id="copy-start">Copy start request</button><p class="item-hint">Give the request to your project agent, then retry. Tinka does not execute these instructions.</p></details>` : ""}${
    item.resources?.length
      ? `<section><h2>Related files</h2>${item.resources
          .map((r) => {
            const ref = r.resource || r,
              url = resourceURL(ref);
            return url
              ? `<p><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(r.title || ref.path)} ↗</a></p>`
              : "";
          })
          .join("")}</section>`
      : ""
  }<div id="embedded-stage"></div></article>`;
  const embed = () => {
    const target = document.getElementById("embedded-stage");
    const iframe = document.createElement("iframe");
    iframe.src = remote;
    iframe.title = item.title;
    iframe.className = "item-embedded-frame";
    target.replaceChildren(iframe);
    toast("Requested preview. Use Open externally if embedding is blocked.");
  };
  document.getElementById("embed")?.addEventListener("click", embed);
  document.getElementById("retry")?.addEventListener("click", () => {
    if (document.querySelector(".item-embedded-frame")) embed();
    else
      toast(
        "Use Open externally after starting the application. The saved representation is still here.",
      );
  });
  document.getElementById("copy-start")?.addEventListener("click", async () => {
    const prompt = `Start the existing preview for Tinka item “${item.title}” (stable ID ${item.id}) in this project. Read the project instructions and supplied handoff. Preserve existing work and report the actual local URL.\n\n${content.startInstructions}\n\nAfter it is ready, I will retry the preview in Tinka. Do not alter unrelated processes.`;
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Start request copied. Give it to your project agent.");
    } catch {
      const text = document.createElement("textarea");
      text.value = prompt;
      text.setAttribute("aria-label", "Start request");
      document.getElementById("copy-start").after(text);
      text.focus();
      text.select();
    }
  });
}
try {
  const r = await fetch("/api/items/" + encodeURIComponent(q.get("item")), {
    cache: "no-store",
  });
  if (!r.ok)
    throw new Error(
      "This item is unavailable. Return to the board and refresh.",
    );
  item = await r.json();
  variant = item.revisions?.find((v) => v.id === q.get("variant"));
  content =
    variant?.content ||
    (variant?.resource || variant?.url ? variant : item.content);
  render();
} catch (e) {
  host.textContent = e.message;
}
