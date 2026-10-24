import {DOCUMENT_BYTE_LIMIT,parseMarkdown,renderMarkdownDocument,selectionTextAnchor,documentTextMap,locateTextAnchor} from './markdown-document.js';
import {restoreFocus} from './interaction.js';

// Reader annotations paint DOM Ranges. Reading nodes, scroll and native selection survive updates.
function rangeIndex(article){
  const map=documentTextMap(article.textContent),nodes=[],walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT);let offset=0;
  while(walker.nextNode()){const node=walker.currentNode;nodes.push({node,start:offset,end:offset+node.length});offset+=node.length;}
  return {map,nodes};
}
function textRange(index,start,end){
  const {map,nodes}=index,from=map.starts[start],to=map.ends[end-1];
  if(from===undefined||to===undefined)return null;
  const range=document.createRange();let begun=false;
  for(const {node,start:offset,end:next} of nodes){
    if(!begun&&from>=offset&&from<next){range.setStart(node,from-offset);begun=true;}
    if(begun&&to<=next){range.setEnd(node,to-offset);return range;}
  }
  return null;
}

export function mountMarkdownReader({asset,query,resourceRoot,path,boardId,content,showError}){
  const mode=['panel','card'].includes(query.get('mode'))?query.get('mode'):'reader',reader=mode==='reader';
  const itemId=query.get('item')||'',commentBoard=query.get('commentBoard')||'';
  const canAnnotate=reader&&!query.get('variant')&&query.get('annotate')==='1'&&Boolean(resourceRoot&&itemId)&&parent!==window;
  document.documentElement.dataset.documentMode=mode;
  const tools=document.createElement('nav');tools.className='document-tools';tools.setAttribute('aria-label','Document tools');
  const source=document.createElement('a');source.className='document-source';source.href=asset;source.target='_blank';source.rel='noopener noreferrer';source.textContent=resourceRoot?`${resourceRoot} / ${path}`:boardId?`${boardId} / ${path}`:'Original document';source.title='Open original source';
  const outline=document.createElement('select');outline.setAttribute('aria-label','Document contents');
  const reload=document.createElement('button');reload.type='button';reload.textContent='Reload';reload.setAttribute('aria-label','Reload source');reload.title='Reload source';reload.dataset.documentReload='';
  const annotations=document.createElement('button');annotations.type='button';annotations.textContent='Annotations';annotations.dataset.documentAnnotations='';annotations.hidden=!canAnnotate;annotations.setAttribute('aria-expanded','false');
  const status=document.createElement('p');status.className='document-status';status.setAttribute('role','status');
  const selectionTools=document.createElement('div');selectionTools.className='document-selection-tools';selectionTools.hidden=true;selectionTools.setAttribute('role','toolbar');selectionTools.setAttribute('aria-label','Selected passage');
  const highlight=document.createElement('button');highlight.type='button';highlight.textContent='Highlight';highlight.dataset.documentHighlight='';
  const comment=document.createElement('button');comment.type='button';comment.textContent='Comment';comment.dataset.documentComment='';
  selectionTools.append(highlight,comment);
  const list=document.createElement('section');list.className='document-annotations';list.hidden=true;list.setAttribute('aria-label','Document annotations');
  const paintLayer=document.createElement('div');paintLayer.className='document-paint-layer';paintLayer.setAttribute('aria-hidden','true');
  if(reader){tools.append(source,outline,annotations,reload);content.before(tools);content.before(status);document.body.append(selectionTools,list,paintLayer);}
  let article,model,revision,generation=0,annotationRequest=0,selectedAnchor,pendingSelection,painted=[],comments=[],highlights=[],composing=false;
  const nativePaint=Boolean(globalThis.CSS?.highlights&&globalThis.Highlight);
  function post(type,detail={}){parent.postMessage({type,...detail},location.origin);}
  function clearPaint(){for(const name of ['tinka-document-comments','tinka-document-highlights','tinka-document-selection'])CSS.highlights?.delete(name);paintLayer.replaceChildren();}
  function paint(){
    if(!article||!reader)return;
    const commentRanges=painted.filter(entry=>entry.kind==='comment').map(entry=>entry.range),highlightRanges=painted.filter(entry=>entry.kind==='highlight').map(entry=>entry.range);
    const pending=pendingSelection?.generation===generation&&pendingSelection.range.startContainer.isConnected?[pendingSelection.range]:[];
    if(nativePaint){
      CSS.highlights.set('tinka-document-comments',new Highlight(...commentRanges));CSS.highlights.set('tinka-document-highlights',new Highlight(...highlightRanges));CSS.highlights.set('tinka-document-selection',new Highlight(...pending));
      return;
    }
    paintLayer.replaceChildren();
    for(const [kind,ranges] of [['comment',commentRanges],['highlight',highlightRanges],['selection',pending]])for(const range of ranges)for(const rect of range.getClientRects()){
      const clippedTop=Math.max(rect.top,content.getBoundingClientRect().top),clippedBottom=Math.min(rect.bottom,content.getBoundingClientRect().bottom);if(clippedBottom<=clippedTop)continue;
      const span=document.createElement('span');span.className=`document-range-${kind}`;span.style.cssText=`left:${rect.left}px;top:${clippedTop}px;width:${rect.width}px;height:${clippedBottom-clippedTop}px`;paintLayer.append(span);
    }
  }
  function selectionRect(range){const rect=range.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right};}
  function captureSelection(){
    const selection=getSelection();if(!selectedAnchor||!selection?.rangeCount)return null;
    pendingSelection={id:crypto.randomUUID(),anchor:structuredClone(selectedAnchor),range:selection.getRangeAt(0).cloneRange(),scrollTop:content.scrollTop,generation};paint();return pendingSelection;
  }
  function act(type){
    const saved=captureSelection();if(!saved)return;
    composing=type==='tinka-comment-selection';selectionTools.hidden=true;
    post(type,{anchor:saved.anchor,selectionId:saved.id,selectionRect:selectionRect(saved.range)});
    if(type==='tinka-highlight-selection')status.textContent='Saving highlight…';
  }
  selectionTools.addEventListener('pointerdown',event=>event.preventDefault());
  comment.onclick=()=>act('tinka-comment-selection');highlight.onclick=()=>act('tinka-highlight-selection');
  function updateSelection(){
    const selection=getSelection();selectedAnchor=canAnnotate&&article?selectionTextAnchor(article,selection,revision):null;
    if(composing&&selectedAnchor&&pendingSelection&&(selectedAnchor.start!==pendingSelection.anchor.start||selectedAnchor.end!==pendingSelection.anchor.end))composing=false;
    if(composing){selectionTools.hidden=true;return;}
    if(canAnnotate&&selection?.rangeCount&&!selection.isCollapsed&&article?.contains(selection.anchorNode)&&article.contains(selection.focusNode)&&!selectedAnchor)status.textContent='Select a shorter or earlier passage to annotate it.';
    selectionTools.hidden=!selectedAnchor;
    if(selectedAnchor){const rect=selection.getRangeAt(0).getBoundingClientRect(),view=content.getBoundingClientRect();if(rect.bottom<=view.top||rect.top>=view.bottom||rect.right<=view.left||rect.left>=view.right){selectionTools.hidden=true;return;}selectionTools.style.left=`${Math.max(8,Math.min(innerWidth-180,rect.left))}px`;selectionTools.style.top=`${Math.max(8,Math.min(innerHeight-42,rect.bottom+8))}px`;}
  }
  document.addEventListener('selectionchange',updateSelection);
  function sendSelectionContext(){if(composing&&pendingSelection?.generation===generation&&pendingSelection.range.startContainer.isConnected)post('tinka-selection-context',{selectionId:pendingSelection.id,selectionRect:selectionRect(pendingSelection.range)});}
  content.addEventListener('scroll',()=>{paint();sendSelectionContext();updateSelection();},{passive:true,capture:true});
  let previousWidth=0;
  new ResizeObserver(()=>{
    const width=article?.clientWidth||content.clientWidth,changedWidth=previousWidth>0&&Math.abs(width-previousWidth)>1;previousWidth=width;
    if(pendingSelection?.generation===generation&&pendingSelection.range.startContainer.isConnected){
      const view=content.getBoundingClientRect(),rects=[...pendingSelection.range.getClientRects()].filter(rect=>rect.width&&rect.height),visible=rects.some(rect=>rect.bottom>view.top+8&&rect.top<view.bottom-8);
      // Responsive reflow preserves the logical reading position: reveal the same
      // selected passage rather than preserving a now-unrelated numeric offset.
      if(rects.length&&(changedWidth||!visible))content.scrollTop+=rects[0].top-view.top-8;
    }
    paint();sendSelectionContext();
  }).observe(content);
  outline.onchange=()=>article?.querySelector(`[id="${CSS.escape(outline.value)}"]`)?.scrollIntoView({block:'start'});
  annotations.onclick=()=>{list.hidden=!list.hidden;annotations.setAttribute('aria-expanded',String(!list.hidden));if(!list.hidden)loadAnnotations();};
  function renderList(){
    list.replaceChildren();const header=document.createElement('header'),title=document.createElement('strong'),close=document.createElement('button');title.textContent='Annotations';close.type='button';close.textContent='Close';close.onclick=()=>{list.hidden=true;annotations.setAttribute('aria-expanded','false');annotations.focus({preventScroll:true});};header.append(title,close);list.append(header);
    const state={matched:'Located',uncertain:'Source changed; review quote',stale:'Quote unlocated or ambiguous',unverified:'Source unavailable',detached:'Item unavailable'};
    for(const [kind,records] of [['highlight',highlights],['comment',comments]]){
      const heading=document.createElement('h2');heading.textContent=kind==='highlight'?'Highlights':'Comments';list.append(heading);
      if(!records.length){const empty=document.createElement('p');empty.className='document-annotation-empty';empty.textContent=kind==='highlight'?'Select a passage, then Highlight.':'Select a passage, then Comment.';list.append(empty);}
      for(const record of records){
        const row=document.createElement('article'),quote=document.createElement('q'),meta=document.createElement('small'),action=document.createElement('button');row.dataset.annotationId=record.id;quote.textContent=record.anchor?.quote||record.excerpt||'Document comment';meta.textContent=state[record.anchorStatus]||'Source not checked';action.type='button';action.textContent=kind==='highlight'?'Remove highlight':'Open discussion';
        action.onclick=()=>{if(kind==='highlight'){action.disabled=true;post('tinka-remove-highlight',{highlightId:record.id});}else post('tinka-open-comment',{threadId:record.id});};row.append(quote,meta,action);list.append(row);
      }
    }
    annotations.textContent=`Annotations (${comments.length+highlights.length})`;
  }
  function derivePaint(){
    painted=[];const index=rangeIndex(article);
    for(const [kind,records] of [['comment',comments],['highlight',highlights]])for(const record of records){
      if(record.anchor?.kind!=='text'||record.anchorStatus!=='matched'||record.anchor.sourceRevision!==revision)continue;
      const located=locateTextAnchor(model.text,record.anchor,revision,model.textModel);if(located.status!=='matched')continue;
      const range=textRange(index,located.start,located.end);if(range)painted.push({kind,record,range});
    }
    paint();renderList();
  }
  async function loadAnnotations(){
    if(!canAnnotate||!article)return;
    const current=++annotationRequest,sourceGeneration=generation;
    try{
      const params=new URLSearchParams({itemId,limit:'100'});if(commentBoard)params.set('boardId',commentBoard);
      const [response,highlightResponse]=await Promise.all([fetch('/api/feedback?'+params,{cache:'no-store'}),fetch('/api/highlights?'+new URLSearchParams({itemId,limit:'100'}),{cache:'no-store'})]);
      if(!response.ok||!highlightResponse.ok)throw Error();
      const result=await response.json(),saved=await highlightResponse.json(),records=[...(saved.highlights||[])];let cursor=saved.nextCursor;
      while(cursor&&records.length<200){const next=await fetch('/api/highlights?'+new URLSearchParams({itemId,limit:'100',cursor}),{cache:'no-store'});if(!next.ok)throw Error();const page=await next.json();records.push(...(page.highlights||[]));cursor=page.nextCursor;}
      if(current!==annotationRequest||generation!==sourceGeneration)return;
      comments=(result.threads||[]).filter(thread=>thread.anchor?.kind==='text');highlights=records;derivePaint();
      const changed=[...comments,...highlights].filter(record=>record.anchorStatus!=='matched');
      status.textContent=changed.length?`${changed.length} saved annotation${changed.length===1?' needs':'s need'} source review.`:'';
    }catch{if(current===annotationRequest)status.textContent='Annotations could not be refreshed. Try Annotations again.';}
  }
  content.addEventListener('click',event=>{
    if(!article?.contains(event.target)||!getSelection()?.isCollapsed)return;
    const entry=painted.find(mark=>[...mark.range.getClientRects()].some(rect=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom));if(!entry)return;
    if(entry.kind==='comment'){pendingSelection={id:crypto.randomUUID(),anchor:entry.record.anchor,range:entry.range.cloneRange(),scrollTop:content.scrollTop,generation};composing=true;post('tinka-open-comment',{threadId:entry.record.id,selectionId:pendingSelection.id,selectionRect:selectionRect(entry.range)});paint();}
    else{list.hidden=false;annotations.setAttribute('aria-expanded','true');list.querySelector(`[data-annotation-id="${CSS.escape(entry.record.id)}"] button`)?.focus({preventScroll:true});}
  });
  async function readBytes(response){
    if(!response.ok||Number(response.headers.get('content-length'))>DOCUMENT_BYTE_LIMIT)throw Error();
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>DOCUMENT_BYTE_LIMIT)throw Error();chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
  }
  async function load(){
    const current=++generation,heading=outline.value;selectionTools.hidden=true;selectedAnchor=null;reload.disabled=true;status.textContent='Loading source…';clearPaint();painted=[];
    if(!article){const loading=document.createElement('p');loading.className='document-loading';loading.textContent='Loading document…';content.replaceChildren(loading);}
    try{
      const bytes=await readBytes(await fetch(asset,{cache:'no-store'})),digest=await crypto.subtle.digest('SHA-256',bytes);if(current!==generation)return;
      revision='sha256:'+Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');model=parseMarkdown(new TextDecoder().decode(bytes));
      const prefix=resourceRoot?`/resources/${encodeURIComponent(resourceRoot)}/`:`/boards/${encodeURIComponent(boardId)}/files/`;
      article=renderMarkdownDocument(document,model,{baseUrl:new URL(asset,location.href),origin:location.origin,resourcePrefix:prefix});article.tabIndex=-1;content.replaceChildren(article);
      previousWidth=article.clientWidth;
      outline.replaceChildren(new Option('Contents…',''));for(const entry of model.headings)outline.append(new Option('  '.repeat(entry.level-1)+entry.label,entry.id));outline.hidden=!model.headings.length;
      if(heading&&model.headings.some(entry=>entry.id===heading)){outline.value=heading;article.querySelector(`[id="${CSS.escape(heading)}"]`)?.scrollIntoView({block:'start'});}
      status.textContent=query.get('variant')?'Historical version. Open the current document to annotate.':'';await loadAnnotations();
    }catch{if(current===generation){if(mode==='card'){const unavailable=document.createElement('p');unavailable.className='document-loading';unavailable.textContent='Document unavailable. Open to check its source.';content.replaceChildren(unavailable);}else showError('The Markdown source could not be read. It may be unavailable or larger than 2 MiB.');status.textContent='Source unavailable.';}}
    finally{if(current===generation)reload.disabled=false;}
  }
  reload.onclick=load;
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==parent)return;
    if(event.data?.type==='tinka-annotations-refresh'||event.data?.type==='tinka-feedback-refresh')loadAnnotations();
    if(event.data?.type==='tinka-annotation-result'){
      if(event.data.ok)status.textContent='Highlight updated.';
      else{status.textContent=event.data.message||'The highlight was not saved. Try again.';renderList();}
    }
    if(event.data?.type==='tinka-reader-focus'){
      composing=false;selectionTools.hidden=true;
      if(pendingSelection&&(!event.data.selectionId||event.data.selectionId===pendingSelection.id)&&pendingSelection.generation===generation&&pendingSelection.range.startContainer.isConnected){
        const currentScroll=content.scrollTop;window.focus();restoreFocus(article);const selection=getSelection();selection.removeAllRanges();selection.addRange(pendingSelection.range.cloneRange());content.scrollTop=currentScroll;paint();
      }
    }
  });
  load();
}
