import {bindForm, restoreFocus, commitShortcutLabel} from './interaction.js';
import {escape as esc, makeDialog, showFailure} from './workspace.js';
import {resolveEndpoint, resolveLine, decorationBounds} from './whiteboard-geometry.js';

const sides = ['top', 'right', 'bottom', 'left'];
const shapeNames = {rectangle:'Sticky note', rounded:'Process', diamond:'Decision', ellipse:'Start / end'};
const selector = id => `[data-decoration="${CSS.escape(id)}"]`;
const cleanColor = value => /^#[0-9a-f]{3,8}$/i.test(value || '') ? value : '#78866c';
const isAttachment = endpoint => !!(endpoint?.placementId || endpoint?.decorationId);
const pointOnly = point => ({x:point.x, y:point.y});

export function lineBox(from, to) {
  return {x:Math.min(from.x,to.x), y:Math.min(from.y,to.y),
    width:Math.max(1,Math.abs(to.x-from.x)), height:Math.max(1,Math.abs(to.y-from.y)),
    flipX:to.x<from.x, flipY:to.y<from.y};
}
export function decorationMarkup(d, board, origin, selected=false, overrides) {
  const current = {...d,...overrides?.decorations?.get(d.id)};
  const box = decorationBounds(current,board,overrides), line = d.type === 'line';
  const color = cleanColor(current.color), w = Math.max(1,box.width), h = Math.max(1,box.height);
  let mark, handles = '';
  if (line) {
    const r = resolveLine(current,board,overrides);
    const x1=r.from.x-box.x, y1=r.from.y-box.y, x2=r.to.x-box.x, y2=r.to.y-box.y;
    mark = `<svg class="workspace-decoration-line" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-${esc(d.id)}" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M2 2L10 6L2 10" fill="none" stroke="${color}" stroke-width="2"/></marker></defs><line class="whiteboard-line-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" ${r.detached?'stroke-dasharray="6 4"':''} ${d.endArrow?`marker-end="url(#arrow-${esc(d.id)})"`:''}/></svg><span class="workspace-decoration-label whiteboard-line-label" data-decoration-label style="left:${(x1+x2)/2}px;top:${(y1+y2)/2}px">${esc(current.text||'')}</span>${r.detached?'<span class="whiteboard-detached">Detached</span>':''}`;
    if (selected) handles = `<button type="button" class="workspace-endpoint endpoint-tail" data-endpoint="from" aria-label="Reconnect arrow start" title="Reconnect start" style="left:${x1}px;top:${y1}px"></button><button type="button" class="workspace-endpoint endpoint-head" data-endpoint="to" aria-label="Reconnect arrow end" title="Reconnect end" style="left:${x2}px;top:${y2}px"></button>`;
  } else {
    const shape = current.shape;
    const silhouette = shape === 'diamond' ? `<polygon points="${w/2},0 ${w},${h/2} ${w/2},${h} 0,${h/2}"/>`
      : shape === 'ellipse' ? `<ellipse cx="${w/2}" cy="${h/2}" rx="${Math.max(1,w/2-1)}" ry="${Math.max(1,h/2-1)}"/>`
      : `<rect x="1" y="1" width="${Math.max(1,w-2)}" height="${Math.max(1,h-2)}" rx="${shape==='rounded'?Math.min(20,w/2,h/2):2}"/>`;
    mark = `${shape?`<svg class="whiteboard-silhouette" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${silhouette}</svg>`:''}<span class="workspace-decoration-label" data-decoration-label>${esc(current.text||'')}</span>`;
    if (selected) handles = '<button type="button" class="workspace-decoration-resize" data-decoration-resize aria-label="Resize decoration">◢</button>';
  }
  return `<div tabindex="0" role="group" aria-label="${esc(line?'Arrow':shapeNames[current.shape]||current.type)}: ${esc(current.text||'Untitled')}" class="workspace-decoration decoration-${esc(d.type)} ${current.shape?'whiteboard-shape shape-'+esc(current.shape):''} ${selected?'selected':''}" data-decoration="${esc(d.id)}" style="left:${box.x+origin.x}px;top:${box.y+origin.y}px;width:${w}px;height:${h}px;--decoration-color:${color}">${mark}${handles}</div>`;
}

export class Whiteboard {
  constructor(host) {
    this.host=host; this.overrides=undefined; this.drag=null;
    this.editor=null; this.drafts=new Map(); this.connectMode=false; this.pendingFrom=null;
    this.draftKey=`tinka/${host.config.workspaceId}/whiteboard-drafts/${host.snapshot.id}`;
    try { for(const [id,draft] of Object.entries(JSON.parse(localStorage.getItem(this.draftKey)||'{}')))
      if(typeof draft.text==='string')this.drafts.set(id,{...draft,pending:false,error:draft.error||'Save not confirmed. Retry to check this text.'}); } catch {}
  }
  mount() {
    if (!document.querySelector('link[data-whiteboard-style]')) {
      const link=document.createElement('link'); link.rel='stylesheet'; link.href='/app/whiteboard.css';
      link.dataset.whiteboardStyle=''; document.head.append(link);
    }
    this.ports=document.createElement('div'); this.ports.className='whiteboard-ports';
    this.toolbar=document.createElement('div'); this.toolbar.className='whiteboard-toolbar';
    this.toolbar.setAttribute('role','toolbar'); this.toolbar.setAttribute('aria-label','Selected object'); this.toolbar.hidden=true;
    this.menu=document.createElement('div'); this.menu.className='whiteboard-menu'; this.menu.hidden=true;
    this.menu.setAttribute('role','menu'); this.menu.setAttribute('aria-label','Object actions');
    this.hint=document.createElement('div'); this.hint.className='whiteboard-connect-hint'; this.hint.hidden=true;
    this.hint.setAttribute('role','status'); document.body.append(this.toolbar,this.menu,this.hint);
    document.addEventListener('pointerdown',e=>this.down(e),true);
    document.addEventListener('pointermove',e=>this.move(e),true);
    document.addEventListener('pointerup',e=>this.up(e),true);
    document.addEventListener('pointercancel',()=>this.cancel(),true);
    document.addEventListener('keydown',e=>this.keydown(e),true);
    document.addEventListener('dblclick',e=>{
      const element=e.target.closest('[data-decoration]');
      if (element&&!e.target.closest('button,input,textarea')) {
        e.preventDefault(); this.edit(element.dataset.decoration);
      }
    });
    document.addEventListener('click',e=>this.click(e),true);
    window.addEventListener('blur',()=>{this.cancel(); this.commitEdit({focus:false}); this.connectMode=false; this.pendingFrom=null; this.renderPorts();});
    window.addEventListener('resize',()=>this.positionToolbar());
    document.getElementById('viewport').addEventListener('wheel',()=>requestAnimationFrame(()=>this.positionToolbar()),{passive:true});
    this.toolbar.addEventListener('change',e=>{
      if(e.target.matches('[data-decoration-color]')) this.save(this.host.activeDecoration,{color:e.target.value}).catch(showFailure);
    });
  }
  get editing() { return !!this.editor; }
  get finishing() { return !!this.editor?.finishing || [...this.drafts.values()].some(d=>d.pending); }
  find(id=this.host.activeDecoration) { return this.host.snapshot.decorations.find(d=>d.id===id); }
  selectedRef() {
    const decoration=this.find();
    if(decoration&&decoration.type!=='line') return {decorationId:decoration.id};
    if(!decoration&&this.host.selection.size===1) {
      const ref={placementId:[...this.host.selection][0]}; if(this.target(ref)) return ref;
    }
    return null;
  }
  target(ref) {
    if(!ref)return null;
    const b=this.host.snapshot;
    if(ref.placementId) {
      const p=b.placements.find(p=>p.id===ref.placementId), item=b.items[p?.itemId];
      return p&&!p.removedAt&&!p.archivedAt&&!p.deletedAt&&!item?.deletedAt&&!item?.archivedAt?p:null;
    }
    return b.decorations.find(d=>d.id===ref.decorationId&&d.type!=='line');
  }
  targets() {
    return [...document.querySelectorAll('#world .workspace-card[data-placement]')].map(el=>({placementId:el.dataset.placement}))
      .concat(this.host.snapshot.decorations.filter(d=>d.type!=='line').map(d=>({decorationId:d.id}))).filter(ref=>this.target(ref));
  }
  name(ref) {
    const target=this.target(ref);
    return ref.placementId?this.host.snapshot.items[target?.itemId]?.title||'Item':target?.text||shapeNames[target?.shape]||'Object';
  }
  renderPorts() {
    if(this.host.mode!=='canvas'||this.editor) { this.ports.remove(); return; }
    const source=this.selectedRef();
    const refs=this.drag?.endpoint||this.pendingFrom ? this.targets() : this.connectMode&&source ? [source] : [];
    const origin=this.host.origin||{x:0,y:0};
    const markup=refs.flatMap(ref=>sides.map(side=>{
      const end={...ref,side},p=resolveEndpoint(end,this.host.snapshot,this.overrides);
      return p.detached?'':`<button type="button" class="whiteboard-port" data-port="${esc(JSON.stringify(end))}" aria-label="Connect ${esc(this.name(ref))} ${side}" title="${esc(this.name(ref))}: ${side}" style="left:${p.x+origin.x}px;top:${p.y+origin.y}px"></button>`;
    })).join('');
    if(this.ports.innerHTML!==markup)this.ports.innerHTML=markup;
    document.getElementById('world').append(this.ports);
  }
  markup(d) {
    const draft=this.drafts.get(d.id);
    const markup=decorationMarkup(draft?{...d,text:draft.text}:d,this.host.snapshot,this.host.origin||{x:0,y:0},this.host.activeDecoration===d.id,this.overrides);
    let rendered=draft?.error?markup.replace(/<\/div>$/,`<div class="whiteboard-draft-state" role="status"><span>Text not saved</span><button type="button" data-whiteboard-retry="${esc(d.id)}">Retry</button></div></div>`):markup;
    // A host keyed build that was already in flight must retain this native form.
    // Its live value/selection remain properties of the existing textarea node.
    if(this.editor?.id===d.id)rendered=rendered.replace(/<\/div>$/,this.editor.form.outerHTML+'</div>');
    return rendered;
  }
  patch(d) {
    const el=document.querySelector(selector(d.id)); if(!el)return;
    const template=document.createElement('template'); template.innerHTML=this.markup(d); const fresh=template.content.firstElementChild;
    for(const attr of [...el.attributes])if(!fresh.hasAttribute(attr.name))el.removeAttribute(attr.name);
    for(const attr of fresh.attributes)if(el.getAttribute(attr.name)!==attr.value)el.setAttribute(attr.name,attr.value);
    el.classList.toggle('whiteboard-editing',this.editor?.id===d.id);
    // The session owns the exact textarea value, native selection and focus.
    if(this.editor?.id!==d.id) this.host.reconcileChildren(el,fresh);
  }
  sync(overrides) {
    this.overrides=overrides; this.reconcileSelection();
    for(const d of this.host.snapshot.decorations)this.patch(d);
    this.renderPorts(); this.renderToolbar();
  }
  reconcileSelection() {
    if(this.host.activeDecoration&&!this.find())this.host.activeDecoration=null;
    if(this.host.mode!=='canvas') { this.connectMode=false; this.pendingFrom=null; this.closeMenu(); }
    if(this.pendingFrom&&!this.target(this.pendingFrom)){this.pendingFrom=null;this.connectMode=false;this.hint.hidden=true;}
    if(!this.selectedRef()&&!this.drag?.endpoint&&!this.pendingFrom)this.connectMode=false;
  }
  select(id) {
    if(this.host.activeDecoration===id)return;
    this.commitEdit({focus:false}); this.connectMode=false; this.pendingFrom=null; this.closeMenu();
    this.host.activeDecoration=id; this.host.selection.clear(); this.host.syncSelection(); this.host.selectionMenu(); this.sync(this.overrides);
  }
  clearSelection({finishEdit=true,focus=false}={}) {
    if(finishEdit)this.commitEdit({focus});
    this.host.activeDecoration=null; this.connectMode=false; this.pendingFrom=null; this.closeMenu();
    this.sync(this.overrides);
  }
  connectPlacement(id,invoker) {
    this.connectInvoker=invoker;
    this.clearSelection(); this.host.selection=new Set([id]); this.host.syncSelection(); this.startConnect();
  }
  renderToolbar() {
    const d=this.find(),ref=this.selectedRef(),draft=d&&this.drafts.get(d.id);
    this.toolbar.hidden=this.host.mode!=='canvas'||!d;
    if(this.toolbar.hidden){this.closeMenu();return;}
    const stamp=JSON.stringify([d?.id,ref,this.editor?.id,draft?.pending,draft?.error,this.connectMode]);
    if(stamp!==this.toolbar.dataset.stamp) {
      this.toolbar.dataset.stamp=stamp;
      this.toolbar.innerHTML=this.editor
        ? `<span class="whiteboard-edit-hint">${esc(commitShortcutLabel())} to finish</span><button type="button" data-whiteboard-action="done">Done</button><button type="button" data-whiteboard-action="cancel-edit">Cancel</button>`
        : `${d?`<button type="button" data-whiteboard-action="edit">${d.type==='line'?'Edit label':'Edit text'}</button>`:''}${ref?`<button type="button" data-whiteboard-action="connect" aria-pressed="${this.connectMode}">Connect</button>`:''}<button type="button" data-whiteboard-action="more" aria-haspopup="menu" aria-expanded="${!this.menu.hidden}">More</button>${draft?.pending?'<span role="status">Saving…</span>':''}`;
    }
    this.positionToolbar();
  }
  positionToolbar() {
    if(this.toolbar.hidden)return;
    const d=this.find(),ref=this.selectedRef();
    const element=d?document.querySelector(selector(d.id)):ref?.placementId?document.querySelector(`[data-placement="${CSS.escape(ref.placementId)}"]`):null;
    if(!element)return;
    const r=element.getBoundingClientRect(),viewport=document.getElementById('viewport').getBoundingClientRect();
    const width=this.toolbar.offsetWidth,height=this.toolbar.offsetHeight;
    const left=Math.max(8,Math.min(innerWidth-width-8,r.left+(r.width-width)/2));
    const top=r.top-height-8>=viewport.top+8?r.top-height-8:Math.min(viewport.bottom-height-8,Math.max(viewport.top+8,r.bottom+8));
    Object.assign(this.toolbar.style,{left:`${left}px`,top:`${top}px`});
    if(!this.menu.hidden)this.positionMenu();
  }
  positionMenu() {
    const r=this.toolbar.getBoundingClientRect();
    Object.assign(this.menu.style,{left:`${Math.max(8,Math.min(innerWidth-this.menu.offsetWidth-8,r.right-this.menu.offsetWidth))}px`,top:`${Math.max(8,Math.min(innerHeight-this.menu.offsetHeight-8,r.bottom+6))}px`});
  }
  openMenu() {
    const d=this.find();if(!d)return;
    this.menu.innerHTML=`<label class="whiteboard-color">Color<input type="color" data-whiteboard-menu-color value="${this.pickerColor(d.color)}"></label><button type="button" role="menuitem" data-whiteboard-action="inspect">${d.type==='line'?'Arrow settings…':'Position & size…'}</button>${d.type==='line'?'<button type="button" role="menuitem" data-whiteboard-action="reverse">Reverse direction</button><button type="button" role="menuitem" data-whiteboard-action="reconnect-from">Reconnect start…</button><button type="button" role="menuitem" data-whiteboard-action="reconnect-to">Reconnect end…</button><button type="button" role="menuitem" data-whiteboard-action="detach-from">Detach start</button><button type="button" role="menuitem" data-whiteboard-action="detach-to">Detach end</button><button type="button" role="menuitem" data-whiteboard-action="detach-both">Detach both ends</button>':''}<hr><button type="button" role="menuitem" data-whiteboard-action="remove">Remove ${d.type==='line'?'arrow':d.shape==='rectangle'?'sticky note':'object'}</button>`;
    this.menu.hidden=false;this.toolbar.querySelector('[data-whiteboard-action=more]')?.setAttribute('aria-expanded','true');this.positionMenu();
    this.menu.querySelector('[data-whiteboard-menu-color]').onchange=e=>this.save(d.id,{color:e.target.value}).catch(showFailure);
    this.menu.querySelector('button')?.focus({preventScroll:true});
  }
  pickerColor(value) {
    const c=cleanColor(value);return c.length===4||c.length===5?'#'+[...c.slice(1,4)].map(x=>x+x).join(''):c.slice(0,7);
  }
  closeMenu({focus=false}={}) {
    this.menu.hidden=true;this.toolbar?.querySelector('[data-whiteboard-action=more]')?.setAttribute('aria-expanded','false');
    if(focus)this.toolbar?.querySelector('[data-whiteboard-action=more]')?.focus({preventScroll:true});
  }
  async click(e) {
    if(this.suppressClick&&e.detail){this.suppressClick=false;e.preventDefault();e.stopImmediatePropagation();return;}
    const retry=e.target.closest('[data-whiteboard-retry]');
    if(retry){e.preventDefault();e.stopPropagation();await this.saveDraft(retry.dataset.whiteboardRetry,{retry:true});return;}
    const port=e.target.closest('[data-port]');
    if(port&&e.detail===0){e.preventDefault();await this.choosePort(JSON.parse(port.dataset.port));return;}
    const action=e.target.closest('[data-whiteboard-action]')?.dataset.whiteboardAction;if(!action)return;
    e.preventDefault();e.stopPropagation();
    if(action==='more'){this.menu.hidden?this.openMenu():this.closeMenu({focus:true});return;}
    const id=this.host.activeDecoration;this.closeMenu();
    if(action==='done'){this.commitEdit({focus:true});return;}
    if(action==='cancel-edit'){this.cancelEdit();return;}
    if(action==='edit'){this.edit(id);return;}
    if(action==='connect'){this.startConnect();return;}
    if(action==='retry'){this.saveDraft(id,{retry:true});return;}
    this.commitEdit({focus:false});
    if(action==='inspect'||action.startsWith('reconnect-')){this.inspect(id,action.slice(10));return;}
    try {
      if(action==='reverse')await this.reverse(id);
      if(action.startsWith('detach-'))await this.detach(id,action.slice(7));
      if(action==='remove')await this.remove();
    } catch(error){showFailure(error);}
  }
  startConnect() {
    this.commitEdit({focus:false});this.connectMode=!this.connectMode;this.pendingFrom=null;this.closeMenu();
    this.hint.textContent=this.connectMode?'Choose a connection point, then its destination. Dragging also works.':'';
    this.hint.hidden=!this.connectMode;this.renderPorts();this.renderToolbar();
    this.ports.querySelector('button')?.focus({preventScroll:true});
  }
  async choosePort(endpoint) {
    if(!this.pendingFrom) {
      this.pendingFrom=endpoint;this.connectMode=true;this.renderPorts();this.hint.hidden=false;this.hint.textContent='Choose the destination connection point.';
      this.ports.querySelector('button')?.focus({preventScroll:true});return;
    }
    const from=this.pendingFrom;this.pendingFrom=null;
    if(JSON.stringify(from)===JSON.stringify(endpoint)){this.renderPorts();return;}
    const p=resolveEndpoint(from,this.host.snapshot),q=resolveEndpoint(endpoint,this.host.snapshot);
    await this.createLine({...lineBox(p,q),from,to:endpoint});
  }
  async save(id,patch,options) {
    this.host.decorationCommitting=true;
    try{await this.host.client.write('updateDecoration',{boardId:this.host.snapshot.id,decorationId:id,patch},options);await this.host.refresh({saveReview:false});}
    finally{this.host.decorationCommitting=false;this.host.hooks.liveReady?.();}
  }
  async createLine(patch) {
    const d={...patch,id:patch.id||crypto.randomUUID(),type:'line',text:patch.text||'',color:patch.color||'#6c8060',endArrow:patch.endArrow??true};
    await this.host.client.write('createDecoration',{boardId:this.host.snapshot.id,decoration:d});
    this.host.activeDecoration=d.id;this.connectMode=false;this.pendingFrom=null;this.hint.hidden=true;
    await this.host.refresh({saveReview:false});this.sync();
  }
  async remove() {
    const id=this.host.activeDecoration;if(!id)return;
    this.cancelEdit({focus:false});this.host.activeDecoration=null;this.connectMode=false;this.pendingFrom=null;
    await this.host.client.write('removeDecoration',{boardId:this.host.snapshot.id,decorationId:id});await this.host.refresh({saveReview:false});this.sync();
  }
  async reverse(id) {
    const d=this.find(id),r=resolveLine(d,this.host.snapshot);
    const from=d.to?structuredClone(d.to):pointOnly(r.to),to=d.from?structuredClone(d.from):pointOnly(r.from);
    const next={...d,from,to},g=resolveLine(next,this.host.snapshot);
    await this.save(id,{from,to,...lineBox(g.from,g.to)});
  }
  async detach(id,which) {
    const d=this.find(id),r=resolveLine(d,this.host.snapshot);
    const from=which==='from'||which==='both'?pointOnly(r.from):d.from||pointOnly(r.from);
    const to=which==='to'||which==='both'?pointOnly(r.to):d.to||pointOnly(r.to);
    await this.save(id,{from,to,...lineBox(r.from,r.to)});
  }
  persistDrafts() {
    try { localStorage.setItem(this.draftKey,JSON.stringify(Object.fromEntries([...this.drafts].map(([id,draft])=>[id,{...draft,pending:false}])))); } catch {}
  }
  edit(id,select=false) { this.beginEdit(id,select); }
  beginEdit(id,select=false) {
    if(this.editor?.id===id){this.editor.textarea.focus({preventScroll:true});return;}
    if(this.editor){this.editor.nextEdit={id,select};this.commitEdit({focus:false});return;}
    const d=this.find(id),element=document.querySelector(selector(id));if(!d||!element)return;
    this.select(id);this.cancel();
    const original=this.drafts.get(id)?.text??d.text??'';
    const form=document.createElement('form');form.className='whiteboard-editor';
    form.innerHTML=`<textarea name="text" aria-label="${esc(d.type==='line'?'Arrow label':d.shape==='rectangle'?'Sticky note text':'Object text')}" spellcheck="true"></textarea>`;
    const textarea=form.querySelector('textarea');textarea.value=original;
    const session={id,original,form,textarea,composing:false,requested:false,finishing:false,finishFocus:false};
    this.editor=session;element.append(form);element.classList.add('whiteboard-editing');
    session.binding=bindForm(form,{submit:async values=>{if(!session.requested)session.finishFocus=true;return this.finishEditor(session,String(values.get('text')??''));},onError:()=>{}});
    form.addEventListener('keydown',event=>{if(event.key!=='Escape')event.stopPropagation();});
    textarea.addEventListener('compositionstart',()=>{session.composing=true;});
    textarea.addEventListener('compositionend',()=>{session.composing=false;if(session.requested)queueMicrotask(()=>this.submitEditor(session));});
    textarea.addEventListener('blur',event=>{
      if(event.relatedTarget?.closest('.whiteboard-toolbar,.whiteboard-menu,.whiteboard-editor'))return;
      this.commitEdit({focus:false});
    });
    textarea.focus({preventScroll:true});if(select)textarea.select();else textarea.setSelectionRange(textarea.value.length,textarea.value.length);
    this.renderPorts();this.renderToolbar();
  }
  commitEdit({focus=false}={}) {
    const session=this.editor;if(!session||session.finishing)return;
    session.finishFocus ||= focus;session.requested=true;
    // Outside pointerdown may precede native compositionend/focus transitions.
    // Keep the editor mounted and capture its final value only after that turn.
    if(session.composing){session.textarea.blur();return;}
    queueMicrotask(()=>this.submitEditor(session));
  }
  submitEditor(session) {
    if(this.editor!==session||session.finishing||session.composing||session.binding.pending)return;
    session.binding.requestSubmit();
  }
  async finishEditor(session,text) {
    if(this.editor!==session||session.finishing||session.composing)return;
    session.finishing=true;this.editor=null;session.binding.destroy();session.form.remove();
    document.querySelector(selector(session.id))?.classList.remove('whiteboard-editing');
    if(text!==session.original||this.drafts.has(session.id)) {
      const prior=this.drafts.get(session.id);
      this.drafts.set(session.id,{text,original:prior?.original??this.find(session.id)?.text??session.original,
        operationId:prior?.text===text?prior.operationId:crypto.randomUUID(),pending:false,error:null});
      this.persistDrafts();
    }
    this.sync();
    if(session.finishFocus&&this.host.activeDecoration===session.id)restoreFocus(document.querySelector(selector(session.id)));
    if(session.nextEdit)this.beginEdit(session.nextEdit.id,session.nextEdit.select);
    if(this.drafts.has(session.id))await this.saveDraft(session.id);
    this.host.drainGeometryRefresh();this.host.hooks.liveReady?.();
  }
  cancelEdit({focus=true}={}) {
    const session=this.editor;if(!session||session.finishing)return;
    session.finishing=true;this.editor=null;session.binding.destroy();session.form.remove();
    document.querySelector(selector(session.id))?.classList.remove('whiteboard-editing');
    // A draft that predates this session is still recoverable after cancel.
    if(this.drafts.has(session.id)){const draft=this.drafts.get(session.id);draft.text=session.original;this.persistDrafts();}
    this.sync();if(focus)restoreFocus(document.querySelector(selector(session.id)));
    this.host.drainGeometryRefresh();this.host.hooks.liveReady?.();
  }
  async saveDraft(id,{retry=false,reviewed=false}={}) {
    const draft=this.drafts.get(id);if(!draft||draft.pending)return;
    if(retry) {
      await this.host.refresh({saveReview:false});
      const saved=this.find(id)?.text??'';
      if(saved===draft.text){this.drafts.delete(id);this.persistDrafts();this.sync();return;}
      if(saved!==draft.original&&!reviewed) {
        makeDialog('Review changed text',`<p>This object's saved text changed elsewhere. Review both versions before saving.</p><label>Saved text<textarea readonly>${esc(saved)}</textarea></label><label>Your text<textarea name="text">${esc(draft.text)}</textarea></label><button type="submit" class="workspace-primary">Save reviewed text</button>`,async values=>{
          draft.text=String(values.get('text')??'');draft.original=saved;draft.operationId=crypto.randomUUID();draft.error=null;
          await this.saveDraft(id,{reviewed:true});
          if(draft.error)throw new Error(draft.error);
        });return;
      }
    }
    draft.pending=true;draft.error=null;this.persistDrafts();this.sync();
    try {
      await this.host.client.write('updateDecoration',{boardId:this.host.snapshot.id,decorationId:id,patch:{text:draft.text}},{operationId:draft.operationId});
      if(this.find(id))this.find(id).text=draft.text;
      if(this.drafts.get(id)===draft)this.drafts.delete(id);
      await this.host.refresh({saveReview:false});
    }catch(error){draft.pending=false;draft.error=error.conflict?'Text changed elsewhere. Review before retrying.':'Could not save text. Retry when the connection is available.';}
    finally{draft.pending=false;this.persistDrafts();this.sync();this.host.hooks.liveReady?.();}
  }
  nearest(point) {
    let best=null,distance=20/this.host.hooks.zoom();
    for(const ref of this.targets())for(const side of sides){const endpoint={...ref,side},p=resolveEndpoint(endpoint,this.host.snapshot,this.overrides),n=Math.hypot(point.x-p.x,point.y-p.y);if(n<=distance){distance=n;best=endpoint;}}
    return best;
  }
  down(e) {
    this.suppressClick=false;
    const own=e.target.closest('.whiteboard-toolbar,.whiteboard-menu,.whiteboard-editor,.whiteboard-draft-state');
    if(this.editor&&!own&&!e.target.closest(selector(this.editor.id)))this.commitEdit({focus:false});
    if(!e.target.closest('.whiteboard-menu,[data-whiteboard-action=more]'))this.closeMenu();
    if(this.drag){if(e.pointerId!==this.drag.pointerId)this.cancel();return;}
    if(own)return;
    const port=e.target.closest('[data-port]'),element=e.target.closest('[data-decoration]');
    if(!port&&!element){
      if(e.target.closest('#viewport')&&!e.target.closest('.whiteboard-ports'))this.clearSelection({finishEdit:true,focus:false});
      return;
    }
    if(this.host.mode!=='canvas'||e.button!==0||e.isPrimary===false||document.querySelector('dialog[open]')||this.host.pointerGesture||this.host.movePending)return;
    if(e.target.closest('input,textarea,[contenteditable]'))return;
    let d=element&&this.find(element.dataset.decoration);if(!port&&!d)return;
    if(d?.type==='region'&&!d.shape&&!e.target.closest('[data-decoration-label],button')) {
      const r=element.getBoundingClientRect();if(e.clientX>r.left+6&&e.clientX<r.right-6&&e.clientY>r.top+28&&e.clientY<r.bottom-6)return;
    }
    const point=this.host.canvasPoint({x:e.clientX,y:e.clientY});
    if(port) {
      const ref=JSON.parse(port.dataset.port),from=this.pendingFrom||ref,p=resolveEndpoint(from,this.host.snapshot);
      d={id:crypto.randomUUID(),type:'line',text:'',color:'#6c8060',endArrow:true,...lineBox(p,p),from,to:pointOnly(p)};
      this.drag={d,creating:true,endpoint:'to',port:ref,choosing:!!this.pendingFrom};
    } else {
      this.select(d.id);this.drag={d:structuredClone(d),endpoint:e.target.closest('[data-endpoint]')?.dataset.endpoint,resize:!!e.target.closest('[data-decoration-resize]')};
    }
    Object.assign(this.drag,{pointerId:e.pointerId,x:e.clientX,y:e.clientY,point,active:false,zoom:this.host.hooks.zoom()});
    this.host.decorationGesture=true;this.host.updateHistoryControls();e.preventDefault();e.stopImmediatePropagation();
  }
  move(e) {
    const g=this.drag;if(!g||e.pointerId!==g.pointerId)return;
    if(!g.active&&Math.hypot(e.clientX-g.x,e.clientY-g.y)<5)return;
    g.active=true;e.preventDefault();e.stopImmediatePropagation();
    const dx=(e.clientX-g.x)/g.zoom,dy=(e.clientY-g.y)/g.zoom,d=g.d;
    if(g.endpoint) {
      const p=this.host.canvasPoint({x:e.clientX,y:e.clientY}),snap=this.nearest(p),r=resolveLine(d,this.host.snapshot);
      const from=g.endpoint==='from'?snap||p:d.from||pointOnly(r.from),to=g.endpoint==='to'?snap||p:d.to||pointOnly(r.to);
      g.next={...d,from,to};const geometry=resolveLine(g.next,this.host.snapshot);Object.assign(g.next,lineBox(geometry.from,geometry.to));
      this.hint.hidden=false;this.hint.textContent=snap?`Attach to ${this.name(snap)}: ${snap.side}`:'Release for a free endpoint.';
    } else if(d.type==='line') {
      if(isAttachment(d.from)||isAttachment(d.to)) {
        g.blocked=true;this.hint.hidden=false;this.hint.textContent='Drag an endpoint, or use More → Detach to move the arrow freely.';return;
      }
      const r=resolveLine(d,this.host.snapshot),from={x:Math.round(r.from.x+dx),y:Math.round(r.from.y+dy)},to={x:Math.round(r.to.x+dx),y:Math.round(r.to.y+dy)};
      g.next={...d,...lineBox(from,to),from,to};
    } else g.next={...d,...(g.resize?{width:Math.max(60,Math.round(d.width+dx)),height:Math.max(35,Math.round(d.height+dy))}:{x:Math.round(d.x+dx),y:Math.round(d.y+dy)})};
    if(g.creating) {
      const old=document.querySelector(selector(d.id));
      if(old)old.remove();document.getElementById('world').insertAdjacentHTML('beforeend',decorationMarkup(g.next,this.host.snapshot,this.host.origin,true));
    }
    this.host.syncGeometry({decorations:new Map([[d.id,g.next]])});
  }
  finish() {
    const g=this.drag;this.drag=null;this.host.decorationGesture=false;this.hint.hidden=true;
    this.host.syncGeometry();this.host.updateHistoryControls();this.host.hooks.liveReady?.();return g;
  }
  cancel() {
    if(this.drag){const g=this.finish();if(g.creating)document.querySelector(selector(g.d.id))?.remove();}
    this.pendingFrom=null;this.connectMode=false;this.hint.hidden=true;this.renderPorts();this.renderToolbar();this.host.drainGeometryRefresh();
  }
  async up(e) {
    const g=this.drag;if(!g||e.pointerId!==g.pointerId)return;const done=this.finish();
    if(!done.active||!done.next) {
      if(done.active){e.preventDefault();e.stopImmediatePropagation();this.suppressClick=true;setTimeout(()=>this.suppressClick=false,0);}
      if(done.port&&!done.active) { e.preventDefault();e.stopImmediatePropagation();this.suppressClick=true;await this.choosePort(done.port); }
      this.host.drainGeometryRefresh();return;
    }
    e.preventDefault();e.stopImmediatePropagation();this.suppressClick=true;setTimeout(()=>this.suppressClick=false,0);
    try {
      if(done.creating){document.querySelector(selector(done.d.id))?.remove();await this.createLine(done.next);}
      else {const {id,...patch}=done.next;await this.save(id,patch);}
    } catch(error){if(done.creating)document.querySelector(selector(done.d.id))?.remove();showFailure(error);this.host.rebuild();}
    finally{this.host.hooks.liveReady?.();this.host.drainGeometryRefresh();}
  }
  handleEscape(e) {
    if(e.key!=='Escape')return false;
    if(this.drag||this.pendingFrom||this.connectMode){this.cancel();return true;}
    if(this.editor){if(e.isComposing||e.keyCode===229||this.editor.composing)return false;this.cancelEdit();return true;}
    if(!this.menu.hidden){this.closeMenu({focus:true});return true;}
    return false;
  }
  keydown(e) {
    if(this.editor&&e.key==='Escape'&&(e.isComposing||e.keyCode===229||this.editor.composing)){e.stopImmediatePropagation();return;}
    if(this.handleEscape(e)){e.preventDefault();e.stopImmediatePropagation();return;}
    if(e.target.closest('.whiteboard-menu')) {
      const buttons=[...this.menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
      if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    }
    const group=e.target.closest('[data-decoration]');
    if(group&&!e.target.closest('input,textarea,select,[contenteditable],button')&&!document.querySelector('dialog[open]')&&['Enter','F2'].includes(e.key)){
      e.preventDefault();e.stopImmediatePropagation();this.select(group.dataset.decoration);e.key==='F2'?this.edit(group.dataset.decoration):this.inspect(group.dataset.decoration);
    }
  }
  inspect(id,focusEndpoint) {
    const d=this.find(id);if(!d)return;
    const number=(name,label,value)=>`<label>${label}<input name="${name}" type="number" step="any" value="${value}" required></label>`;
    const r=d.type==='line'?resolveLine(d,this.host.snapshot):null;
    const targets=this.targets(), options=targets.map(ref=>`<option value="${esc(ref.placementId?'p:'+ref.placementId:'d:'+ref.decorationId)}">${esc(this.name(ref))}</option>`).join('');
    const endpoint=(key,end,p)=>`<fieldset class="whiteboard-endpoint-form" data-endpoint-form="${key}"><legend>${key==='from'?'Start':'End'}: ${p.detached?'Detached':p.attached?'Attached':'Free point'}</legend><label>Connection<select name="${key}Target"><option value="free">Free point</option>${options}${p.detached?`<option value="${esc(end.placementId?'p:'+end.placementId:'d:'+end.decorationId)}">Unavailable target</option>`:''}</select></label><div data-free-fields class="whiteboard-fields">${number(key+'X','X',p.x)}${number(key+'Y','Y',p.y)}</div><div data-attached-fields><label>Side<select name="${key}Side">${sides.map(side=>`<option ${end?.side===side?'selected':''}>${side}</option>`).join('')}</select></label><details><summary>Advanced</summary>${number(key+'Offset','Position along side (0–1)',end?.offset??.5)}</details></div><p class="whiteboard-endpoint-summary">Current point: ${p.x}, ${p.y}</p></fieldset>`;
    const label=`<label>${r?'Label':'Text'}<textarea name="text">${esc(this.drafts.get(id)?.text??d.text??'')}</textarea></label>`;
    const fields=r?`<div class="whiteboard-endpoint-columns">${endpoint('from',d.from,r.from)}${endpoint('to',d.to,r.to)}</div>`:`<div class="whiteboard-fields">${number('x','X',d.x)}${number('y','Y',d.y)}${number('width','Width',d.width)}${number('height','Height',d.height)}</div>${d.shape?`<label>Shape<select name="shape">${Object.entries(shapeNames).map(([key,label])=>`<option value="${key}" ${key===d.shape?'selected':''}>${label}</option>`).join('')}</select></label>`:''}`;
    const help='<p class="whiteboard-inspector-help">Positions and sizes use logical board units, independent of zoom.</p>';
    const button='<button type="submit" class="workspace-primary">Save changes</button>';
    const html=r?`<div class="whiteboard-settings-body">${label}${fields}${help}</div><footer class="whiteboard-settings-actions">${button}</footer>`:label+fields+help+button;
    const dialog=makeDialog(r?'Arrow settings':'Position & size',html,async form=>{
      const patch={text:form.get('text')};
      if(r) {
        for(const key of ['from','to']){const target=form.get(key+'Target');patch[key]=target==='free'?{x:Number(form.get(key+'X')),y:Number(form.get(key+'Y'))}:{[target.startsWith('p:')?'placementId':'decorationId']:target.slice(2),side:form.get(key+'Side'),offset:Number(form.get(key+'Offset'))};}
        const from=resolveEndpoint(patch.from,this.host.snapshot),to=resolveEndpoint(patch.to,this.host.snapshot);
        if(from.detached||to.detached)throw new Error('Choose an available target or a free point.');Object.assign(patch,lineBox(from,to));
      }else{for(const key of ['x','y','width','height'])patch[key]=Number(form.get(key));if(d.shape)patch.shape=form.get('shape');}
      await this.save(id,patch);
    });
    if(r) {
      dialog.classList.add('whiteboard-arrow-settings');
      const heading=document.createElement('header');heading.className='whiteboard-settings-heading';
      heading.append(dialog.querySelector('h2'),dialog.querySelector('.workspace-close'));
      dialog.querySelector('form').prepend(heading);
      const footer=dialog.querySelector('.whiteboard-settings-actions');
      footer.append(dialog.querySelector('.workspace-submit-hint'),dialog.querySelector('.workspace-form-status'));
    }
    if(r)for(const key of ['from','to']) {
      const end=d[key],value=end?.placementId?'p:'+end.placementId:end?.decorationId?'d:'+end.decorationId:'free';
      const section=dialog.querySelector(`[data-endpoint-form="${key}"]`),select=section.querySelector('select');select.value=value;
      const show=()=>{const free=select.value==='free';section.querySelector('[data-free-fields]').hidden=!free;section.querySelector('[data-attached-fields]').hidden=free;};select.onchange=show;show();
      if(focusEndpoint===key)select.focus();
    }
  }
}
