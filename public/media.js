import {DOCUMENT_BYTE_LIMIT,parseMarkdown,renderMarkdownDocument,selectionTextAnchor,documentTextMap,locateTextAnchor} from './markdown-document.js';
const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const kind = query.get('kind') || 'html';
const boardId = query.get('board') || '';
const path = query.get('path') || '';
const remote = query.get('url') || '';
const resourceRoot = query.get('root') || '';
const name = query.get('name') || 'Experiment';
const content = $('media-content');
const openOriginal = $('open-original');

function showError(message) {
  const section = document.createElement('section');
  section.className = 'media-message';
  const heading = document.createElement('h1');
  heading.textContent = 'Preview unavailable';
  const text = document.createElement('p');
  text.textContent = message;
  section.append(heading, text);
  content.replaceChildren(section);
}

function sourceUrl() {
  if (remote) {
    try {
      const url = new URL(remote);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  if (!(resourceRoot ? /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(resourceRoot) : /^[a-z0-9][a-z0-9-]*$/.test(boardId))) return null;
  const parts = path.split('/');
  if (!parts.length || parts.some(part => !part || part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return null;
  return resourceRoot ? `/resources/${encodeURIComponent(resourceRoot)}/${parts.map(encodeURIComponent).join('/')}` : `/boards/${encodeURIComponent(boardId)}/files/${parts.map(encodeURIComponent).join('/')}`;
}

function applyPreferences(theme, scale) {
  if (theme === 'paper' || theme === 'night') document.documentElement.dataset.theme = theme;
  if ([100, 115, 130].includes(Number(scale))) document.documentElement.style.setProperty('--scale', String(Number(scale) / 100));
}

function setupMarkdown(asset){
  const panel=query.get('mode')==='panel',itemId=query.get('item')||'',commentBoard=query.get('commentBoard')||'';
  const canComment=!panel&&!query.get('variant')&&query.get('annotate')==='1'&&Boolean(resourceRoot&&itemId)&&parent!==window;
  document.documentElement.dataset.documentMode=panel?'panel':'reader';
  const tools=document.createElement('nav');tools.className='document-tools';tools.setAttribute('aria-label','Document tools');
  const source=document.createElement('a');source.className='document-source';source.href=asset;source.target='_blank';source.rel='noopener noreferrer';source.textContent=resourceRoot?`${resourceRoot} / ${path}`:boardId?`${boardId} / ${path}`:'Original document';source.title='Open original source';
  const outline=document.createElement('select');outline.setAttribute('aria-label','Document contents');
  const reload=document.createElement('button');reload.type='button';reload.textContent='Reload source';reload.dataset.documentReload='';
  const status=document.createElement('p');status.className='document-status';status.setAttribute('role','status');
  const comment=document.createElement('button');comment.type='button';comment.className='document-selection-action';comment.textContent='Comment on selection';comment.hidden=true;
  if(!panel){tools.append(source,outline,reload);content.before(tools);content.before(status);document.body.append(comment);}
  let article,model,revision,selectedAnchor,generation=0,feedbackController;
  function post(type,detail){parent.postMessage({type,...detail},location.origin);}
  function updateSelection(){
    const selection=window.getSelection();
    selectedAnchor=canComment&&article?selectionTextAnchor(article,selection,revision):null;
    if(canComment&&article&&selection?.rangeCount&&!selection.isCollapsed&&article.contains(selection.anchorNode)&&article.contains(selection.focusNode)&&!selectedAnchor)
      status.textContent='This passage is too long or too far into this document for a text comment. Select a shorter or earlier passage.';
    comment.hidden=!selectedAnchor;
    if(selectedAnchor){const rect=window.getSelection().getRangeAt(0).getBoundingClientRect();comment.style.left=`${Math.max(8,Math.min(innerWidth-190,rect.left))}px`;comment.style.top=`${Math.max(8,Math.min(innerHeight-42,rect.bottom+8))}px`;}
  }
  document.addEventListener('selectionchange',updateSelection);
  content.addEventListener('scroll',()=>{comment.hidden=true;},{passive:true});
  comment.addEventListener('pointerdown',event=>event.preventDefault());
  comment.onclick=()=>{if(selectedAnchor){post('tinka-comment-selection',{anchor:selectedAnchor});comment.hidden=true;}};
  outline.onchange=()=>{article?.querySelector(`[id="${CSS.escape(outline.value)}"]`)?.scrollIntoView({block:'start'});};
  async function readBytes(response){
    if(!response.ok||Number(response.headers.get('content-length'))>DOCUMENT_BYTE_LIMIT)throw Error('unavailable');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>DOCUMENT_BYTE_LIMIT)throw Error('large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
  }
  function highlightThreads(threads){
    if(!article||!canComment)return;
    const map=documentTextMap(article.textContent),locations=[];
    for(const thread of threads){
      if(thread.anchor?.kind!=='text'||thread.anchorStatus!=='matched'||thread.anchor.sourceRevision!==revision)continue;
      const location=locateTextAnchor(model.text,thread.anchor,revision);if(location.status!=='matched')continue;
      locations.push({start:map.starts[location.start],end:map.ends[location.end-1],thread});
    }
    const walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT),nodes=[];let offset=0;
    while(walker.nextNode()){const node=walker.currentNode;nodes.push({node,start:offset,end:offset+node.length});offset+=node.length;}
    for(const {node,start,end} of nodes){
      const slices=locations.filter(mark=>mark.start<end&&mark.end>start).sort((a,b)=>a.start-b.start);if(!slices.length)continue;
      const fragment=document.createDocumentFragment();let cursor=0;
      for(const slice of slices){const from=Math.max(cursor,slice.start-start,0),to=Math.min(node.length,slice.end-start);if(to<=from)continue;
        fragment.append(document.createTextNode(node.data.slice(cursor,from)));const mark=document.createElement('mark');mark.dataset.documentThread=slice.thread.id;mark.textContent=node.data.slice(from,to);mark.tabIndex=0;mark.title='Open comment';mark.setAttribute('role','button');
        const open=()=>post('tinka-open-comment',{threadId:slice.thread.id});mark.onclick=open;mark.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}};fragment.append(mark);cursor=to;
      }
      fragment.append(document.createTextNode(node.data.slice(cursor)));node.replaceWith(fragment);
    }
  }
  async function loadFeedback(current){
    if(!canComment)return;
    feedbackController?.abort();feedbackController=new AbortController();
    try{
      const params=new URLSearchParams({itemId,limit:'50'});if(commentBoard)params.set('boardId',commentBoard);
      const response=await fetch('/api/feedback?'+params,{cache:'no-store',signal:feedbackController.signal});if(!response.ok)throw Error();const result=await response.json();if(current!==generation)return;
      highlightThreads(result.threads||[]);
      const changed=(result.threads||[]).filter(thread=>thread.anchor?.kind==='text'&&thread.anchorStatus!=='matched');
      if(changed.length)status.textContent=`${changed.length} comment${changed.length===1?'':'s'} need source review. Changed or unlocated quotes remain in Comments & votes.`;
      else if(result.nextCursor)status.textContent='Showing the first 50 comments. Open Comments & votes for more.';
      else status.textContent='Select document text to leave a comment.';
    }catch(error){if(error.name!=='AbortError'&&current===generation)status.textContent='Document loaded. Comments are unavailable; try Reload source.';}
  }
  async function load(){
    const current=++generation,heading=outline.value;comment.hidden=true;selectedAnchor=null;reload.disabled=true;status.textContent='Loading source…';
    try{
      const bytes=await readBytes(await fetch(asset,{cache:'no-store'})),digest=await crypto.subtle.digest('SHA-256',bytes);
      if(current!==generation)return;
      revision='sha256:'+Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
      model=parseMarkdown(new TextDecoder().decode(bytes));
      const prefix=resourceRoot?`/resources/${encodeURIComponent(resourceRoot)}/`:`/boards/${encodeURIComponent(boardId)}/files/`;
      article=renderMarkdownDocument(document,model,{baseUrl:new URL(asset,location.href),origin:location.origin,resourcePrefix:prefix});content.replaceChildren(article);
      outline.replaceChildren(new Option('Contents…',''));for(const entry of model.headings)outline.append(new Option(entry.label,entry.id));outline.hidden=!model.headings.length;
      if(heading&&model.headings.some(entry=>entry.id===heading)){outline.value=heading;article.querySelector(`[id="${CSS.escape(heading)}"]`)?.scrollIntoView({block:'start'});}
      status.textContent=canComment?'Select document text to leave a comment.':query.get('variant')?'Comments on historical versions are unavailable. Open the current version to comment.':'Read-only document preview.';
      await loadFeedback(current);
    }catch{if(current===generation){showError('The Markdown source could not be read. It may be unavailable or larger than 2 MiB.');status.textContent='Source unavailable.';}}
    finally{if(current===generation)reload.disabled=false;}
  }
  reload.onclick=load;
  window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===parent&&event.data?.type==='tinka-feedback-refresh')load();});
  load();
}


applyPreferences(query.get('theme'), query.get('scale'));
// Inside Tinka's experiment view the surrounding header already names the item and links to it.
if (query.get('chrome') === 'none' && parent !== window) $('media-header').hidden = true;
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'reader-preferences') applyPreferences(event.data.theme, event.data.scale);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && parent !== window) parent.postMessage({ type: 'reader-close' }, location.origin);
});

const asset = sourceUrl();
$('media-label').textContent = `${name} · ${kind === 'html' ? 'Independent preview' : kind.toUpperCase()}`;
document.title = `${name} · Tinka`;
if (!asset) showError('The preview source is missing or invalid.');
else {
  openOriginal.href = asset;
  openOriginal.hidden = false;
  if (kind === 'image') {
    const stage = document.createElement('div'); stage.className = 'image-stage';
    const img = document.createElement('img'); img.src = asset; img.alt = name;
    img.onerror = () => showError('The image could not be loaded.');
    stage.append(img); content.append(stage);
  } else if (kind === 'video') {
    const stage = document.createElement('div'); stage.className = 'video-stage';
    const video = document.createElement('video'); video.src = asset; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    video.onerror = () => showError('The video could not be loaded.');
    stage.append(video); content.append(stage);
  } else if (kind === 'audio') {
    const audio = document.createElement('audio'); audio.src = asset; audio.controls = true; audio.preload = 'metadata'; audio.setAttribute('aria-label', name); content.append(audio);
  } else if (kind === 'pdf' || kind === 'html') {
    if (kind === 'pdf' && navigator.pdfViewerEnabled === false) {
      showError('This browser cannot display embedded PDFs. Open the original to read or download the complete document.');
      const link = document.createElement('a'); link.href = asset; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open original PDF ↗'; content.append(link);
    } else {
      const frame = document.createElement('iframe'); frame.className = kind === 'pdf' ? 'pdf-frame' : 'app-frame'; frame.src = asset; frame.title = name;
      content.append(frame);
    }
  } else if (kind === 'markdown') {
    setupMarkdown(asset);
  } else showError('This media type is not supported.');
}
