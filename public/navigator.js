import {escape as esc, WorkspaceClient} from './workspace.js';
import {navigationGraph, navigationRows} from './navigator-graph.js';
// Left is where: a non-modal Navigator beside the work. Click-away closes it; Keep open docks it.
const boardURL = (id, from) => `/boards/${encodeURIComponent(id)}/${from ? `?from=${encodeURIComponent(from)}` : ''}`;
const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  sidebar:'<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  search:'<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  pin:'<path d="M9 4h6l-1 5 3.5 3.5h-11L10 9z"/><path d="M12 12.5V20"/>',
  x:'<path d="M6 6l12 12M18 6 6 18"/>',
  right:'<path d="m9.5 6 6 6-6 6"/>', down:'<path d="m6 9.5 6 6 6-6"/>',
  board:'<rect x="3.5" y="7.5" width="13" height="12" rx="2"/><path d="M7.5 4.5h11a2 2 0 0 1 2 2v10"/>',
  shared:'<path d="M9 7h8v8M17 7 7 17"/>',
  image:'<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5"/>',
  doc:'<path d="M6.5 3.5h11a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4.5"/>',
  code:'<path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5"/>',
  note:'<path d="M6 3.5h8.5l4 4V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4.5M8.5 12h7M8.5 15.5h5"/>',
  tree:'<rect x="3.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="10" width="7" height="5" rx="1.5"/><rect x="13.5" y="16" width="7" height="5" rx="1.5"/><path d="M7 8.5v10h6.5M7 12.5h6.5"/>',
  canvas:'<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><rect x="7" y="7" width="5" height="4.5" rx="1"/><rect x="13" y="12.5" width="4.5" height="4.5" rx="1"/><path d="M7 15.5h3.5"/>',
};
const kindIcon = kind => ICON[{board:'board',image:'image',svg:'image',html:'code',web:'code',url:'code',note:'note',text:'note',sticky:'note'}[String(kind||'').toLowerCase()]||'doc'];
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id);
const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
const SHORTCUT = isMac ? '⌘K' : 'Ctrl K';
const DOCK_WIDTH = 340, OUTLINE_LIMIT = 300;
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const narrow = () => globalThis.matchMedia?.('(max-width: 719px)').matches ?? false;
const read = (store, key, fallback) => { try { return JSON.parse(store.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
const write = (store, key, value) => { try { value == null ? store.removeItem(key) : store.setItem(key, JSON.stringify(value)); } catch {} };

export class ProjectNavigator {
  constructor(config, {boardId=null, beforeNavigate=async()=>{}, reveal=null, outline=null, selection=null}={}) {
    this.config=config; this.boardId=boardId; this.beforeNavigate=beforeNavigate; this.reveal=reveal; this.outline=outline;
    // The board's placement selection lights matching "On this board" rows; tinka:selection keeps it live.
    this.selectionSource=typeof selection==='function'?selection:null; this.selected=new Set(); this.selectedKey='';
    this.client=new WorkspaceClient(config); this.expanded=new Set(); this.generation=0; this.isOpen=false;
    const prefix=`tinka/${config.workspaceId}`;
    this.storageKey=`${prefix}/navigator`; this.recentKey=`${prefix}/recent-boards`; this.dockKey=`${prefix}/navigator-docked`; this.sectionsKey=`${prefix}/navigator-sections`;
    this.saved=read(sessionStorage,this.storageKey,{}); if(typeof this.saved!=='object')this.saved={};
    this.scope=boardId && ['board','descendants'].includes(this.saved.scope) ? this.saved.scope : 'project';
    this.docked=read(localStorage,this.dockKey,false)===true;
    const sections=read(localStorage,this.sectionsKey,{});
    this.collapsed=new Set(['boards','outline'].filter(id=>sections&&typeof sections==='object'&&sections[id]===true));
    const recent=read(localStorage,this.recentKey,[]);
    this.recent=(Array.isArray(recent)?recent:[]).filter(validId).filter(id=>id!==boardId).slice(0,12);
    if(validId(boardId)) write(localStorage,this.recentKey,[boardId,...this.recent].slice(0,12));
  }
  mount(anchor) {
    const button=this.button=document.createElement('button');
    button.id='project-navigator-toggle'; button.type='button'; button.className='project-navigator-toggle tk-btn tk-icon';
    button.innerHTML=svg(ICON.sidebar); button.setAttribute('aria-label','Navigator'); button.title=`Navigator (${SHORTCUT})`;
    button.setAttribute('aria-controls','project-navigator'); button.setAttribute('aria-expanded','false');
    anchor.before(button);
    button.onclick=()=>this.isOpen?this.close():this.open();
    button.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.isOpen&&!this.dockedNow()){event.preventDefault();this.close();}});
    const panel=this.panel=document.createElement('aside');
    panel.id='project-navigator'; panel.className='project-navigator'; panel.hidden=true;
    panel.setAttribute('role','dialog'); panel.setAttribute('aria-modal','false'); panel.setAttribute('aria-labelledby','navigator-title');
    panel.innerHTML=`<header class="navigator-head"><div class="navigator-heading"><h2 id="navigator-title" class="tk-eyebrow">Navigator</h2><p class="navigator-project">${esc(this.config.projectLabel)}</p></div>
      <button type="button" class="tk-btn tk-sm tk-icon navigator-pin" data-nav-pin aria-pressed="false" aria-label="Keep open" title="Keep open beside the board">${svg(ICON.pin)}</button>
      <button type="button" class="tk-btn tk-sm tk-icon" data-nav-close aria-label="Close navigator" title="Close">${svg(ICON.x)}</button></header>
      <div class="navigator-find"><label class="navigator-search"><span class="sr-only">Find a board or item by name or description</span>${svg(ICON.search)}<input id="navigator-query" class="tk-field" type="search" maxlength="2000" placeholder="Find a board or item" autocomplete="off" spellcheck="false" aria-controls="navigator-content"><kbd class="tk-kbd" aria-hidden="true">${SHORTCUT}</kbd></label>
      <div class="navigator-scope" ${this.boardId?'':'hidden'}><label for="navigator-scope">Search in</label><select id="navigator-scope"><option value="project">Whole project</option>${this.boardId?'<option value="board">This board</option><option value="descendants">This board and descendants</option>':''}</select></div></div>
      <p class="navigator-status" role="status" aria-live="polite"></p><div class="navigator-content" id="navigator-content"></div>
      <footer class="navigator-foot" aria-hidden="true"><kbd class="tk-kbd">↑</kbd><kbd class="tk-kbd">↓</kbd> move <span>·</span> <kbd class="tk-kbd">↵</kbd> go <span>·</span> <kbd class="tk-kbd">esc</kbd> close</footer>`;
    document.body.append(panel);
    this.query=panel.querySelector('#navigator-query'); this.query.value=typeof this.saved.query==='string'?this.saved.query:'';
    this.scopeInput=panel.querySelector('#navigator-scope'); this.scopeInput.value=this.scope;
    this.content=panel.querySelector('.navigator-content'); this.status=panel.querySelector('[role=status]');
    this.pin=panel.querySelector('[data-nav-pin]');
    panel.querySelector('[data-nav-close]').onclick=()=>this.close();
    this.pin.onclick=()=>this.setDocked(!this.docked);
    this.query.oninput=()=>{clearTimeout(this.timer);this.generation++;this.persist();this.timer=setTimeout(()=>this.search(),180);};
    this.scopeInput.onchange=()=>{this.scope=this.scopeInput.value;this.persist();this.search();};
    this.content.onclick=event=>{
      const section=event.target.closest('[data-nav-section]');
      if(section){this.toggleSection(section.dataset.navSection);return;}
      const toggle=event.target.closest('[data-nav-expand]');
      if(toggle){this.toggleExpand(toggle.dataset.navExpand,'expand');return;}
      if(event.target.closest('[data-nav-retry]')){this.open();return;}
      if(event.target.closest('[data-nav-more]')){this.search({more:true});return;}
      const jump=event.target.closest('[data-nav-outline]');
      if(jump){this.jump(jump.dataset.navOutline);return;}
      const link=event.target.closest('a[data-nav-board]');
      if(link && event.button===0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey){event.preventDefault();this.follow(link).catch(error=>{this.status.textContent=error.message;});}
    };
    this.query.addEventListener('keydown',event=>{
      if(event.key==='ArrowDown'){const first=this.rows()[0];if(first){event.preventDefault();first.focus();}}
      else if(event.key==='Enter'){event.preventDefault();const query=this.query.value.trim();
        if(!this.timer&&query&&this.renderedQuery===query&&this.content.querySelector('.navigator-result [data-nav-row]'))this.content.querySelector('.navigator-result [data-nav-row]').click();
        else{clearTimeout(this.timer);this.search();}}
    });
    this.content.addEventListener('keydown',event=>{
      const row=event.target.closest('[data-nav-row]'); if(!row)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        const rows=this.rows(),index=rows.indexOf(row),next=event.key==='ArrowDown'?rows[index+1]:index>0?rows[index-1]:this.query;
        event.preventDefault();next?.focus({preventScroll:false});next?.scrollIntoView?.({block:'nearest'});
      }else if((event.key==='ArrowRight'||event.key==='ArrowLeft')&&row.dataset.navSection){
        if((row.getAttribute('aria-expanded')==='true')===(event.key==='ArrowLeft')){event.preventDefault();this.toggleSection(row.dataset.navSection);}
      }else if((event.key==='ArrowRight'||event.key==='ArrowLeft')&&row.dataset.navBoard){
        const expand=row.closest('li')?.querySelector('[data-nav-expand]'),open=expand?.getAttribute('aria-expanded')==='true';
        if(expand&&open===(event.key==='ArrowLeft')){event.preventDefault();this.toggleExpand(expand.dataset.navExpand,'row');}
      }
    });
    panel.addEventListener('keydown',event=>{
      if(event.key!=='Escape')return;
      event.preventDefault();event.stopImmediatePropagation();
      if(this.query.value){this.query.value='';clearTimeout(this.timer);this.persist();this.search();this.query.focus({preventScroll:true});return;}
      if(this.dockedNow())this.button.focus({preventScroll:true});else this.close();
    },true);
    document.addEventListener('pointerdown',event=>{
      if(!this.isOpen||this.dockedNow()||panel.contains(event.target)||this.toggles().some(toggle=>toggle.contains(event.target)))return;
      this.hide({restoreFocus:false});
    },true);
    document.addEventListener('keydown',event=>{
      if(!(event.metaKey||event.ctrlKey)||event.altKey||event.shiftKey||event.key?.toLowerCase()!=='k')return;
      const active=document.activeElement;
      if(active&&!panel.contains(active)&&active.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false])'))return;
      if(this.modalOpen())return;
      event.preventDefault();event.stopImmediatePropagation();this.focusSearch();
    },true);
    document.addEventListener('tinka:navigator-open',()=>{if(!this.modalOpen())this.focusSearch();});
    document.addEventListener('tinka:selection',event=>{
      const detail=event.detail||{};
      if(!this.boardId||(detail.boardId!=null&&detail.boardId!==this.boardId))return;
      this.selected=new Set((Array.isArray(detail.placementIds)?detail.placementIds:[]).filter(id=>typeof id==='string'));
      this.syncSelection({scroll:true});
    });
    this.media=globalThis.matchMedia?.('(max-width: 719px)');
    this.media?.addEventListener?.('change',()=>this.applyDock());
    this.applyDock();
    if(this.docked&&!narrow())this.open({focus:false});
    return this;
  }
  // An open Tinka is a modal page of its own; the Navigator then lives inside it
  // (see host) and counts only other modal dialogs as blocking.
  modalOpen(){try{return [...document.querySelectorAll('dialog:modal')].some(dialog=>!dialog.contains(this.panel));}catch{return false;}}
  toggles(){return [this.button,this.hostButton].filter(Boolean);}
  // Move the panel into an open Tinka (container) with its own toggle, or back to the page (null).
  // While hosted it floats rather than docks; a docked Navigator returns when the Tinka closes.
  host(container,button=null){
    if(!this.panel||(this.hostEl||null)===(container||null))return;
    if(container&&this.isOpen)this.hide({restoreFocus:false});
    this.hostEl=container||null;this.hostButton=container?button:null;
    (container||document.body).append(this.panel);
    for(const toggle of this.toggles())toggle.setAttribute('aria-expanded',String(this.isOpen));
    this.applyDock();
    if(!container&&this.dockedNow()&&!this.isOpen)this.open({focus:false});
  }
  rows(){return [...this.content.querySelectorAll('[data-nav-row]')].filter(el=>!el.disabled&&el.offsetParent!==null);}
  dockedNow(){return this.docked&&!narrow()&&!this.hostEl;}
  persist(){write(sessionStorage,this.storageKey,{query:this.query.value,scope:this.scope});}
  setDocked(value){
    this.docked=!!value; write(localStorage,this.dockKey,this.docked||null);
    if(this.docked&&!this.isOpen)this.open({focus:false});
    this.applyDock();
  }
  applyDock(){
    if(!this.panel)return;
    const docked=this.isOpen&&this.dockedNow(),was=document.body.classList.contains('navigator-docked');
    this.pin.setAttribute('aria-pressed',String(this.docked));
    this.panel.classList.toggle('is-docked',docked);
    document.body.classList.toggle('navigator-docked',docked);
    if(docked)document.body.style.setProperty('--navigator-dock-width',`${DOCK_WIDTH}px`);else document.body.style.removeProperty('--navigator-dock-width');
    if(was!==docked)globalThis.dispatchEvent?.(new Event('resize'));
  }
  focusSearch(){if(!this.isOpen)return this.open();this.query.focus({preventScroll:true});this.query.select();}
  // hide() keeps the Keep open preference; close() is the explicit choice to put the Navigator away.
  hide({restoreFocus=true}={}){
    if(!this.isOpen)return;
    clearTimeout(this.timer);this.timer=null;this.generation++;this.isOpen=false;this.panel.hidden=true;
    for(const toggle of this.toggles())toggle.setAttribute('aria-expanded','false');this.applyDock();
    if(restoreFocus)(this.hostButton||this.button).focus({preventScroll:true});
  }
  close(){if(this.docked){this.docked=false;write(localStorage,this.dockKey,null);}this.hide();this.applyDock();}
  dismiss(){if(!this.dockedNow())this.hide();}
  async open({focus=true}={}){
    if(!this.isOpen){this.isOpen=true;this.panel.hidden=false;this.applyDock();}
    for(const toggle of this.toggles())toggle.setAttribute('aria-expanded','true');if(focus)this.query.focus({preventScroll:true});
    this.revealOnRender=true;
    this.status.textContent='Loading project boards…';
    try{
      const [snapshot,catalog]=await Promise.all([this.client.get('/api/workspace?view=graph&covers=0'),this.client.get('/api/boards')]);
      if(!this.isOpen)return;
      this.graph=navigationGraph(snapshot,(catalog.boards||[]).filter(board=>!(snapshot.boards||[]).some(candidate=>candidate.id===board.id)));
      this.enabled=snapshot.enabled;
      const from=new URLSearchParams(location.search).get('from');
      this.currentPath=(this.graph.parents.get(this.boardId)||[]).includes(from)?[...(this.graph.paths.get(from)||[from]),this.boardId]:this.graph.paths.get(this.boardId);
      for(const id of this.currentPath||[])this.expanded.add(id);
      await this.search();
    }catch(error){this.status.textContent='Project boards could not be loaded.';this.content.innerHTML=`<p class="navigator-empty">${esc(error.message)}</p><button type="button" class="tk-btn tk-tonal navigator-more" data-nav-retry data-nav-row>Retry</button>`;}
  }
  // Re-render the empty-query view, for example after the board's outline changed.
  // Re-render only when the outline actually changed, and never under focus, so
  // live board updates don't churn the panel while someone is using it.
  refresh(){
    if(!this.isOpen||!this.graph||this.query.value.trim())return;
    let signature='';try{signature=JSON.stringify(this.outline?.()||[]);}catch{}
    if(signature===this.outlineSignature)return;
    if(this.panel?.contains(document.activeElement))return;
    this.renderTree();
  }
  path(id){return ((id===this.boardId&&this.currentPath)||this.graph.paths.get(id)||[id]).map(id=>this.graph.boards.get(id)?.title||id).join(' / ');}
  hl(text){
    text=String(text??'');const query=this.query.value.trim(),at=query?text.toLowerCase().indexOf(query.toLowerCase()):-1;
    return at<0?esc(text):`${esc(text.slice(0,at))}<mark>${esc(text.slice(at,at+query.length))}</mark>${esc(text.slice(at+query.length))}`;
  }
  toggleExpand(id,focus){
    this.expanded.has(id)?this.expanded.delete(id):this.expanded.add(id);this.renderTree();
    const target=focus==='row'?`[data-nav-row][data-nav-board="${CSS.escape(id)}"]`:`[data-nav-expand="${CSS.escape(id)}"]`;
    this.content.querySelector(target)?.focus({preventScroll:true});
  }
  // A section band: chevron, icon, label and count, so Boards and On this board read as two data sets.
  sectionHead(id,label,icon,count,extra=''){
    const open=!this.collapsed.has(id);
    return `<div class="navigator-section-head"><h3 class="navigator-section-title"><button type="button" class="navigator-section-toggle" data-nav-section="${id}" data-nav-row aria-expanded="${open}" aria-controls="navigator-${id}-body">${svg(open?ICON.down:ICON.right)}${svg(ICON[icon])}<span class="navigator-section-label" id="navigator-${id}-title">${label}</span>${extra}<span class="navigator-count">${count}</span></button></h3></div>`;
  }
  sectionBody(id,body){return `<div class="navigator-section-body" id="navigator-${id}-body"${this.collapsed.has(id)?' hidden':''}>${body}</div>`;}
  toggleSection(id){
    if(!['boards','outline'].includes(id))return;
    this.collapsed.has(id)?this.collapsed.delete(id):this.collapsed.add(id);
    write(localStorage,this.sectionsKey,this.collapsed.size?Object.fromEntries([...this.collapsed].map(key=>[key,true])):null);
    const toggle=this.content.querySelector(`[data-nav-section="${id}"]`),body=this.content.querySelector(`#navigator-${id}-body`),open=!this.collapsed.has(id);
    if(!toggle||!body)return;
    toggle.setAttribute('aria-expanded',String(open));toggle.querySelector('svg').outerHTML=svg(open?ICON.down:ICON.right);body.hidden=!open;
    if(open&&id==='outline')this.syncSelection({scroll:true,force:true});
  }
  currentSelection(){
    if(!this.selectionSource)return this.selected;
    try{const ids=this.selectionSource();return new Set((Array.isArray(ids)||ids instanceof Set?[...ids]:[]).filter(id=>typeof id==='string'));}catch{return this.selected;}
  }
  // Light the outline rows for the board's selection, live; the first lit row scrolls into view within the panel only.
  syncSelection({scroll=false,force=false,refreshed=false}={}){
    if(!this.content)return;
    const rows=[...this.content.querySelectorAll('[data-nav-outline]')];
    if(!rows.length)return;
    if(scroll&&!refreshed&&this.isOpen&&!this.query.value.trim()&&!this.content.contains(document.activeElement)&&[...this.selected].some(id=>!rows.some(row=>row.dataset.navOutline===id))){
      let known=[];try{known=(this.outline?.()||[]).map(entry=>entry?.placementId);}catch{}
      if([...this.selected].some(id=>known.includes(id)&&!rows.some(row=>row.dataset.navOutline===id))){this.renderTree({selection:false});return this.syncSelection({scroll,force:true,refreshed:true});}
    }
    let first=null,count=0;
    for(const row of rows){
      const on=this.selected.has(row.dataset.navOutline);
      row.classList.toggle('is-selected',on);
      if(on){row.setAttribute('aria-current','true');count++;first||=row;}else row.removeAttribute('aria-current');
    }
    const badge=this.content.querySelector('[data-nav-selected]');
    if(badge){badge.hidden=!count;badge.textContent=count?`${count} selected`:'';}
    const key=first?`${first.dataset.navOutline}|${count}`:'';
    if(!scroll||!first||(!force&&key===this.selectedKey)){this.selectedKey=key;return;}
    this.selectedKey=key;
    if(first.offsetParent===null)return;
    const box=this.content.getBoundingClientRect(),rect=first.getBoundingClientRect();
    const head=first.closest('.navigator-section')?.querySelector('.navigator-section-head');
    const top=box.top+(head?.offsetHeight||0)+4,bottom=box.bottom-4;
    const delta=rect.top<top?rect.top-top:rect.bottom>bottom?Math.min(rect.bottom-bottom,rect.top-top):0;
    if(delta)this.content.scrollBy({top:delta,behavior:reducedMotion()?'auto':'smooth'});
  }
  recentMarkup(){
    const ids=this.recent.filter(id=>id!==this.boardId&&this.graph.boards.has(id)).slice(0,5);
    if(!ids.length)return '';
    return `<section class="navigator-section" aria-labelledby="navigator-recent-title"><h3 id="navigator-recent-title" class="tk-eyebrow">Recent</h3><div class="navigator-recent">${ids.map(id=>{const board=this.graph.boards.get(id);return `<a class="navigator-chip" href="${boardURL(id)}" data-nav-board="${esc(id)}" data-nav-row title="${esc(this.path(id))}"><span class="navigator-chip-window" aria-hidden="true"></span><span>${esc(board.title||id)}</span></a>`;}).join('')}</div></section>`;
  }
  outlineMarkup(){
    if(!this.boardId||typeof this.outline!=='function')return '';
    let entries=[];try{entries=(this.outline()||[]).filter(entry=>entry&&entry.placementId);}catch{entries=[];}
    const groups=new Map();
    for(const entry of entries.slice(0,OUTLINE_LIMIT)){const region=typeof entry.region==='string'&&entry.region.trim()?entry.region.trim():'';if(!groups.has(region))groups.set(region,[]);groups.get(region).push(entry);}
    const ordered=[...groups].sort(([a],[b])=>(a==='')-(b===''));
    const row=entry=>`<li><button type="button" class="navigator-outline-row${entry.kind==='board'?' is-place':''}" data-nav-outline="${esc(entry.placementId)}" data-nav-row>${svg(kindIcon(entry.kind))}<span>${esc(entry.title||'Untitled')}</span></button></li>`;
    const body=ordered.map(([region,list])=>region?`<li class="navigator-region"><span class="navigator-region-name">${esc(region)}</span><span class="navigator-count">${list.length}</span><ul>${list.map(row).join('')}</ul></li>`:list.map(row).join('')).join('');
    const selected='<span class="navigator-selected-count" data-nav-selected hidden></span>';
    return `<section class="navigator-section navigator-group is-outline" aria-labelledby="navigator-outline-title">${this.sectionHead('outline','On this board','canvas',entries.length,selected)}${this.sectionBody('outline',entries.length?`<ul class="navigator-outline">${body}</ul>${entries.length>OUTLINE_LIMIT?'<p class="navigator-empty">More items are on this board. Search to find them.</p>':''}`:'<p class="navigator-empty">Nothing is on this board yet.</p>')}</section>`;
  }
  renderTree({selection=true}={}){
    try{this.outlineSignature=JSON.stringify(this.outline?.()||[]);}catch{}
    const {rows,truncated}=navigationRows(this.graph,this.expanded,this.boardId);
    this.renderedQuery='';
    this.status.textContent=`${this.graph.boards.size} ${this.graph.boards.size===1?'board':'boards'} in this project`;
    const parent=this.currentPath?.at(-2)??null,current=rows.find(row=>row.current&&!row.repeated&&row.parent===parent)||rows.find(row=>row.current&&!row.repeated)||rows.find(row=>row.current);
    const tree=rows.map(row=>{
      const board=this.graph.boards.get(row.id),shared=(this.graph.parents.get(row.id)||[]).length>1,here=row===current,open=this.expanded.has(row.id);
      const hint=row.repeated?'Shared reference':shared?'Multiple parents':board.legacy?'Legacy board':'';
      const lead=row.expandable?`<button type="button" class="navigator-disc" data-nav-expand="${esc(row.id)}" aria-expanded="${open}" aria-label="${open?'Collapse':'Expand'} ${esc(board.title)}">${svg(open?ICON.down:ICON.right)}</button>`:`<span class="navigator-branch" aria-hidden="true">${row.repeated?svg(ICON.shared):''}</span>`;
      return `<li style="--nav-depth:${Math.min(row.depth,12)}"${here?' class="navigator-current"':''}>${lead}<a href="${boardURL(row.id,row.parent)}" data-nav-board="${esc(row.id)}" data-nav-row${here?' aria-current="page"':''} title="${esc(board.title)}"><span class="navigator-name">${esc(board.title)}</span>${hint?`<small>${hint}</small>`:''}</a></li>`;
    }).join('');
    const location=this.boardId?`<p class="navigator-location" title="${esc(this.path(this.boardId))}"><span class="sr-only">You are here: </span><bdi>${esc(this.path(this.boardId))}</bdi></p>`:'';
    const boards=`${location}<nav aria-label="Project boards"><ul class="navigator-tree">${tree}</ul></nav>${truncated?'<p class="navigator-empty">More boards are available. Search by name to find them.</p>':''}${!rows.length?'<p class="navigator-empty">No boards yet.</p>':''}`;
    this.content.innerHTML=`${this.recentMarkup()}<section class="navigator-section navigator-group is-boards" aria-labelledby="navigator-boards-title">${this.sectionHead('boards','Boards','tree',this.graph.boards.size)}${this.sectionBody('boards',boards)}</section>${this.outlineMarkup()}`;
    if(selection)this.selected=this.currentSelection();
    const reveal=this.revealOnRender;this.revealOnRender=false;
    this.syncSelection({scroll:reveal,force:reveal});
  }
  async search({more=false}={}){
    if(!this.graph)return;
    clearTimeout(this.timer);this.timer=null;const token=++this.generation, query=this.query.value.trim();
    if(!query){this.cursor=null;this.results=[];this.renderTree();return;}
    this.status.textContent='Searching…';if(!more){this.results=[];this.content.innerHTML='';this.renderedQuery=null;}
    const params=new URLSearchParams({query,kind:'all',sort:'title',direction:'asc',limit:'40'});
    if(this.boardId&&this.scope!=='project'){params.set('withinBoardId',this.boardId);params.set('recursive',String(this.scope==='descendants'));}
    if(more&&this.cursor)params.set('cursor',this.cursor);
    try{
      const data=this.enabled?await this.client.get(`/api/search?${params}`):{results:[],nextCursor:null};
      if(token!==this.generation||!this.isOpen)return;
      this.results.push(...data.results);this.cursor=data.nextCursor;
      const legacy=[...this.graph.boards.values()].filter(board=>board.legacy&&board.title.toLowerCase().includes(query.toLowerCase())&&(this.scope==='project'||board.id===this.boardId));
      const boardMatches=new Set(this.results.filter(row=>row.type==='board').map(row=>row.id));
      const results=[...this.results.filter(row=>!(row.type==='item'&&row.kind==='board'&&boardMatches.has(row.childBoardId))),...legacy.map(board=>({...board,type:'board',legacy:true}))];
      this.status.textContent=`${results.length}${this.cursor?'+':''} ${results.length===1?'match':'matches'} · ${this.scopeInput.selectedOptions[0].textContent}`;
      const focused=more&&this.content.contains(document.activeElement);
      this.content.innerHTML=results.map(row=>this.resultMarkup(row)).join('')+(!results.length?`<p class="navigator-empty">No matches for “${esc(query)}”. ${this.scope!=='project'?'Try Whole project or a different name.':'Try a different name or description.'}</p>`:'')+(this.cursor?'<button type="button" class="tk-btn tk-tonal navigator-more" data-nav-more data-nav-row>Load more results</button>':'')+(!this.enabled?'<p class="navigator-empty">Search includes legacy board names. Open a board to explore its experiments.</p>':'');
      this.renderedQuery=query;
      if(focused)this.rows().at(-1)?.focus({preventScroll:true});
    }catch(error){if(token!==this.generation)return;this.status.textContent='Search could not finish.';this.content.innerHTML=`<p class="navigator-empty">${esc(error.message)}</p><button type="button" class="tk-btn tk-tonal navigator-more" data-nav-retry data-nav-row>Retry search</button>`;}
  }
  resultMarkup(row){
    const board=row.type==='board', locations=(row.locations||[]).filter(location=>!location.archived);
    const inScope=location=>this.scope==='project'||location.boardId===this.boardId||this.graph.paths.get(location.boardId)?.includes(this.boardId);
    const ordered=[...locations.filter(inScope),...locations.filter(location=>!inScope(location))];
    const seen=new Set(),links=ordered.filter(location=>{if(seen.has(location.boardId))return false;seen.add(location.boardId);return true;});
    const where=id=>`${svg(ICON.board)}<span>${esc(this.path(id))}</span>`;
    const locationMarkup=board?`<a href="${boardURL(row.id)}" data-nav-board="${esc(row.id)}" data-nav-row>${where(row.id)}</a>`:links.map(location=>`<a href="${boardURL(location.boardId)}?reveal=${encodeURIComponent(location.placementId)}" data-nav-board="${esc(location.boardId)}" data-nav-placement="${esc(location.placementId)}" data-nav-row>${where(location.boardId)}</a>`).join('');
    const kind=board?'board':row.kind||'idea';
    return `<article class="navigator-result${board?' is-place':''}"><div class="navigator-result-head">${svg(kindIcon(kind))}<h3>${this.hl(row.title)}</h3><span class="navigator-result-kind">${esc(board?'Board':row.kind||'Idea')}</span></div>${row.description?`<p>${this.hl(row.description)}</p>`:''}<div class="navigator-result-locations">${locationMarkup||`<a href="${row.childBoardId?boardURL(row.childBoardId):`/app/item.html?item=${encodeURIComponent(row.id)}`}" ${row.childBoardId?`data-nav-board="${esc(row.childBoardId)}"`:''} data-nav-row>${row.childBoardId?'Open board':'Open item (not placed on an active board)'}</a>`}</div>${row.locationCount>locations.length?`<small>${row.locationCount} saved locations; active locations shown when available.</small>`:''}${row.legacy?'<small>Legacy board · search covers its name</small>':''}</article>`;
  }
  async jump(placementId){
    if(!this.reveal)return;
    this.dismiss();
    try{await this.reveal(placementId);}catch(error){this.status.textContent=error.message;}
  }
  async follow(link){
    await this.beforeNavigate();
    if(link.dataset.navBoard===this.boardId){this.dismiss();if(link.dataset.navPlacement&&this.reveal)await this.reveal(link.dataset.navPlacement);return;}
    if(!this.dockedNow())this.hide();
    location.assign(link.href);
  }
}
