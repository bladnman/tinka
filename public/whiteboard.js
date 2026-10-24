import {escape as esc,makeDialog,showFailure} from './workspace.js';
import {resolveEndpoint,resolveLine,decorationBounds} from './whiteboard-geometry.js';
const sides=['top','right','bottom','left'];
const selector=id=>`[data-decoration="${CSS.escape(id)}"]`;
const shapeNames={rectangle:'Rectangle',rounded:'Process',diamond:'Decision',ellipse:'Start / end'};
const cleanColor=value=>/^#[0-9a-f]{3,8}$/i.test(value||'')?value:'#78866c';
export function lineBox(from,to){return {x:Math.min(from.x,to.x),y:Math.min(from.y,to.y),width:Math.max(1,Math.abs(to.x-from.x)),height:Math.max(1,Math.abs(to.y-from.y)),flipX:to.x<from.x,flipY:to.y<from.y};}
export function decorationMarkup(d,board,origin,selected=false,overrides){
 const current={...d,...overrides?.decorations?.get(d.id)},line=d.type==='line',box=decorationBounds(current,board,overrides),color=cleanColor(d.color);
 const left=box.x+origin.x,top=box.y+origin.y,w=Math.max(1,box.width),h=Math.max(1,box.height);
 let mark,ends='';
 if(line){
  const r=resolveLine(current,board,overrides),x1=r.from.x-box.x,y1=r.from.y-box.y,x2=r.to.x-box.x,y2=r.to.y-box.y;
  mark=`<svg class="workspace-decoration-line" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-${esc(d.id)}" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M2 2L10 6L2 10" fill="none" stroke="${color}" stroke-width="2"/></marker></defs><line class="whiteboard-line-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" ${r.detached?'stroke-dasharray="6 4"':''} ${d.endArrow?`marker-end="url(#arrow-${esc(d.id)})"`:''}/></svg><span class="workspace-decoration-label whiteboard-line-label" data-decoration-label style="left:${(x1+x2)/2}px;top:${(y1+y2)/2}px">${esc(d.text||'')}</span>${r.detached?'<span class="whiteboard-detached" title="An attachment target is unavailable">Detached</span>':''}`;
  if(selected)ends=`<button type="button" class="workspace-endpoint" data-endpoint="from" aria-label="Move arrow start" style="left:${x1}px;top:${y1}px"></button><button type="button" class="workspace-endpoint" data-endpoint="to" aria-label="Move arrow end" style="left:${x2}px;top:${y2}px"></button>`;
 }else{
  const shape=current.shape;
  const silhouette=shape==='diamond'?`<polygon points="${w/2},0 ${w},${h/2} ${w/2},${h} 0,${h/2}"/>`:shape==='ellipse'?`<ellipse cx="${w/2}" cy="${h/2}" rx="${w/2-1}" ry="${h/2-1}"/>`:`<rect x="1" y="1" width="${Math.max(1,w-2)}" height="${Math.max(1,h-2)}" rx="${shape==='rounded'?Math.min(20,w/2,h/2):shape?2:7}"/>`;
  mark=`${shape?`<svg class="whiteboard-silhouette" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${silhouette}</svg>`:''}<span class="workspace-decoration-label" data-decoration-label>${esc(current.text||'')}</span>`;
  if(selected)ends='<button type="button" class="workspace-decoration-resize" data-decoration-resize aria-label="Resize decoration">◢</button>';
 }
 const actions=selected?`<div class="workspace-decoration-actions"><input type="color" data-decoration-color aria-label="Decoration color" value="${color.slice(0,7)}"><button type="button" data-decoration-inspect aria-label="Exact decoration geometry" title="Exact geometry">⌖</button><button type="button" data-decoration-delete aria-label="Delete decoration">×</button></div>${ends}`:'';
 return `<div tabindex="0" role="group" aria-label="${esc(line?'Arrow':shapeNames[current.shape]||current.type)}: ${esc(current.text||'Untitled')}" class="workspace-decoration decoration-${esc(d.type)} ${current.shape?'whiteboard-shape shape-'+esc(current.shape):''} ${selected?'selected':''}" data-decoration="${esc(d.id)}" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;--decoration-color:${color}">${mark}${actions}</div>`;
}
export class Whiteboard {
 constructor(host){this.host=host;this.overrides=undefined;this.drag=null;this.hover=null;}
 mount(){
  if(!document.querySelector('link[data-whiteboard-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/app/whiteboard.css';link.dataset.whiteboardStyle='';document.head.append(link);}
  this.ports=document.createElement('div');this.ports.className='whiteboard-ports';
  this.hint=document.createElement('div');this.hint.className='whiteboard-connect-hint';this.hint.hidden=true;this.hint.setAttribute('role','status');document.body.append(this.hint);
  document.addEventListener('pointerdown',e=>this.down(e),true);
  document.addEventListener('pointermove',e=>this.move(e),true);
  document.addEventListener('pointerup',e=>this.up(e),true);
  document.addEventListener('pointercancel',()=>this.cancel(),true);
  window.addEventListener('blur',()=>this.cancel());
  document.addEventListener('keydown',e=>{
   if(e.key==='Escape'&&this.drag){this.cancel();e.preventDefault();e.stopImmediatePropagation();return;}
   const group=e.target.closest('[data-decoration]');
   if(group&&!e.target.closest('input,textarea,select,[contenteditable],button')&&!document.querySelector('dialog[open]')&&['Enter','F2'].includes(e.key)){
    e.preventDefault();e.stopImmediatePropagation();this.select(group.dataset.decoration);
    if(e.key==='F2')this.edit(group.dataset.decoration);else this.inspect(group.dataset.decoration);
   }
  },true);
  document.addEventListener('pointerover',e=>{
   if(this.drag||this.host.mode!=='canvas')return;
   const target=e.target.closest('.workspace-card[data-placement],[data-decoration]');
   if(target){const ref=target.dataset.placement?{placementId:target.dataset.placement}:{decorationId:target.dataset.decoration};if(this.target(ref)){this.hover=ref;this.renderPorts();}}
  });
  document.addEventListener('dblclick',e=>{const el=e.target.closest('[data-decoration]');if(el&&!e.target.closest('button,input')){e.preventDefault();this.edit(el.dataset.decoration);}});
  document.addEventListener('change',e=>{if(e.target.matches('[data-decoration-color]'))this.save(e.target.closest('[data-decoration]').dataset.decoration,{color:e.target.value}).catch(showFailure);});
  document.addEventListener('click',e=>{
   if(this.suppressClick&&e.detail){e.preventDefault();e.stopImmediatePropagation();return;}
   if(e.target.closest('[data-decoration-inspect]'))this.inspect(e.target.closest('[data-decoration]').dataset.decoration);
   if(e.target.closest('[data-decoration-delete]'))this.remove();
  },true);
 }
 target(ref){const b=this.host.snapshot;if(ref.placementId){const p=b.placements.find(p=>p.id===ref.placementId),i=b.items[p?.itemId];return p&&!p.removedAt&&!p.archivedAt&&!p.deletedAt&&!i?.deletedAt&&!i?.archivedAt?p:null;}return b.decorations.find(d=>d.id===ref.decorationId&&d.type!=='line');}
 targets(){return [...document.querySelectorAll('#world .workspace-card[data-placement]')].map(el=>({placementId:el.dataset.placement})).concat(this.host.snapshot.decorations.filter(d=>d.type!=='line').map(d=>({decorationId:d.id}))).filter(ref=>this.target(ref));}
 renderPorts(){
  if(this.host.mode!=='canvas'){this.ports.remove();return;}
  const selectedLine=this.host.snapshot.decorations.find(d=>d.id===this.host.activeDecoration)?.type==='line';
  const refs=this.drag?.endpoint?this.targets():!selectedLine&&this.hover?[this.hover]:[];
  const origin=this.host.origin||{x:0,y:0};
  this.ports.innerHTML=refs.flatMap(ref=>sides.map(side=>{const end={...ref,side},p=resolveEndpoint(end,this.host.snapshot,this.overrides);if(p.detached)return '';const target=this.target(ref),name=ref.placementId?this.host.snapshot.items[target.itemId]?.title:target.text||shapeNames[target.shape]||target.type;return `<button type="button" class="whiteboard-port" data-port="${esc(JSON.stringify(end))}" aria-label="Connect ${esc(name)} ${side}" title="Connect ${esc(name)} · ${side}" style="left:${p.x+origin.x}px;top:${p.y+origin.y}px"></button>`;})).join('');
  document.getElementById('world').append(this.ports);
 }
 markup(d){return decorationMarkup(d,this.host.snapshot,this.host.origin||{x:0,y:0},this.host.activeDecoration===d.id,this.overrides);}
 sync(overrides){this.overrides=overrides;for(const d of this.host.snapshot.decorations){const el=document.querySelector(selector(d.id));if(el&&!el.querySelector('[contenteditable]'))el.outerHTML=this.markup(d);}this.renderPorts();}
 select(id){const old=this.host.activeDecoration;this.host.activeDecoration=id;this.host.selection.clear();this.host.syncSelection();for(const key of new Set([old,id])){const d=this.host.snapshot.decorations.find(d=>d.id===key);const el=key&&document.querySelector(selector(key));if(d&&el)el.outerHTML=this.markup(d);}this.host.selectionMenu();}
 async save(id,patch){this.host.decorationCommitting=true;try{await this.host.client.write('updateDecoration',{boardId:this.host.snapshot.id,decorationId:id,patch});await this.host.refresh({saveReview:false});}finally{this.host.decorationCommitting=false;this.host.hooks.liveReady?.();}}
 async remove(){const id=this.host.activeDecoration;if(!id||this.host.client.pendingWrites)return;this.host.activeDecoration=null;try{await this.host.client.write('removeDecoration',{boardId:this.host.snapshot.id,decorationId:id});await this.host.refresh({saveReview:false});}catch(error){showFailure(error);}finally{this.host.hooks.liveReady?.();}}
 edit(id,select=false){
  const d=this.host.snapshot.decorations.find(d=>d.id===id),label=document.querySelector(`${selector(id)} [data-decoration-label]`);if(!d||!label||label.isContentEditable)return;
  const original=d.text||'';let cancelled=false;label.contentEditable='plaintext-only';label.setAttribute('role','textbox');label.setAttribute('aria-label',d.type==='region'?'Region label':'Canvas text');label.focus({preventScroll:true});
  if(select){const range=document.createRange();range.selectNodeContents(label);const s=getSelection();s.removeAllRanges();s.addRange(range);}
  label.onkeydown=e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();cancelled=true;label.textContent=original;label.blur();}if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();label.blur();}};
  label.onblur=async()=>{label.removeAttribute('contenteditable');label.removeAttribute('role');const text=cancelled?original:label.innerText.trim();if(text!==original)try{await this.save(id,{text});}catch(error){showFailure(error);}this.host.hooks.liveReady?.();};
 }
 nearest(point){let best=null,distance=20/this.host.hooks.zoom();for(const ref of this.targets())for(const side of sides){const endpoint={...ref,side},p=resolveEndpoint(endpoint,this.host.snapshot,this.overrides),n=Math.hypot(point.x-p.x,point.y-p.y);if(n<=distance){distance=n;best=endpoint;}}return best;}
 down(e){
  if(this.drag){if(e.pointerId!==this.drag.pointerId)this.cancel();return;}
  if(this.host.mode!=='canvas'||e.button!==0||e.isPrimary===false||document.querySelector('dialog[open]')||this.host.client.pendingWrites||this.host.pointerGesture||this.host.movePending||this.host.decorationCommitting)return;
  const port=e.target.closest('[data-port]'),el=e.target.closest('[data-decoration]');
  if(!port&&!el)return;
  if(e.target.closest('input,[contenteditable],[data-decoration-delete],[data-decoration-inspect]'))return;
  let d=el&&this.host.snapshot.decorations.find(d=>d.id===el.dataset.decoration);if(!port&&!d)return;
  // A plain region interior belongs to the existing selection gesture.
  if(d?.type==='region'&&!d.shape&&!e.target.closest('[data-decoration-label],button')){const r=el.getBoundingClientRect();if(e.clientX>r.left+6&&e.clientX<r.right-6&&e.clientY>r.top+28&&e.clientY<r.bottom-6)return;}
  const point=this.host.canvasPoint({x:e.clientX,y:e.clientY});
  if(port){const from=JSON.parse(port.dataset.port),p=resolveEndpoint(from,this.host.snapshot);d={id:crypto.randomUUID(),type:'line',text:'',color:'#6c8060',endArrow:true,...lineBox(p,p),from,to:{x:p.x,y:p.y}};this.drag={d,creating:true,endpoint:'to'};}
  else{this.select(d.id);this.drag={d:structuredClone(d),endpoint:e.target.closest('[data-endpoint]')?.dataset.endpoint,resize:!!e.target.closest('[data-decoration-resize]')};}
  Object.assign(this.drag,{pointerId:e.pointerId,x:e.clientX,y:e.clientY,point,active:false,zoom:this.host.hooks.zoom()});
  this.host.decorationGesture=true;this.host.updateHistoryControls();e.preventDefault();e.stopImmediatePropagation();this.renderPorts();
 }
 move(e){
  const g=this.drag;if(!g||e.pointerId!==g.pointerId)return;
  if(!g.active&&Math.hypot(e.clientX-g.x,e.clientY-g.y)<5)return;
  g.active=true;e.preventDefault();e.stopImmediatePropagation();
  const dx=(e.clientX-g.x)/g.zoom,dy=(e.clientY-g.y)/g.zoom,d=g.d;
  if(g.endpoint){const p=this.host.canvasPoint({x:e.clientX,y:e.clientY}),snap=this.nearest(p),resolved=resolveLine(d,this.host.snapshot),end=snap||{x:p.x,y:p.y};const from=g.endpoint==='from'?end:d.from||{x:resolved.from.x,y:resolved.from.y},to=g.endpoint==='to'?end:d.to||{x:resolved.to.x,y:resolved.to.y};const next={...d,from,to};const geometry=resolveLine(next,this.host.snapshot);Object.assign(next,lineBox(geometry.from,geometry.to));g.next=next;this.hint.hidden=false;this.hint.textContent=snap?'Release to attach · '+snap.side:'Release for a free endpoint';
  }else if(d.type==='line'){const r=resolveLine(d,this.host.snapshot);const from={x:Math.round(r.from.x+dx),y:Math.round(r.from.y+dy)},to={x:Math.round(r.to.x+dx),y:Math.round(r.to.y+dy)};g.next={...d,...lineBox(from,to),from,to};}
  else g.next={...d,...(g.resize?{width:Math.max(60,Math.round(d.width+dx)),height:Math.max(35,Math.round(d.height+dy))}:{x:Math.round(d.x+dx),y:Math.round(d.y+dy)})};
  if(g.creating){let el=document.querySelector(selector(d.id));if(!el){document.getElementById('world').insertAdjacentHTML('beforeend',decorationMarkup(g.next,this.host.snapshot,this.host.origin,true));}else el.outerHTML=decorationMarkup(g.next,this.host.snapshot,this.host.origin,true);}
  this.host.syncGeometry({decorations:new Map([[d.id,g.next]])});
 }
 finish(){const g=this.drag;this.drag=null;this.host.decorationGesture=false;this.hint.hidden=true;this.host.syncGeometry();this.host.updateHistoryControls();this.host.hooks.liveReady?.();return g;}
 cancel(){if(!this.drag)return;const g=this.finish();if(g.creating)document.querySelector(selector(g.d.id))?.remove();this.host.drainGeometryRefresh();}
 async up(e){const g=this.drag;if(!g||e.pointerId!==g.pointerId)return;const done=this.finish();if(!done.active||!done.next){this.host.drainGeometryRefresh();return;}e.preventDefault();e.stopImmediatePropagation();this.suppressClick=true;setTimeout(()=>this.suppressClick=false,0);try{if(done.creating){this.host.activeDecoration=done.d.id;await this.host.client.write('createDecoration',{boardId:this.host.snapshot.id,decoration:done.next});await this.host.refresh({saveReview:false});}else{const {id,...patch}=done.next;await this.save(id,patch);}}catch(error){if(done.creating)document.querySelector(selector(done.d.id))?.remove();showFailure(error);this.host.rebuild();}finally{this.host.hooks.liveReady?.();this.host.drainGeometryRefresh();}}
 inspect(id){
  const d=this.host.snapshot.decorations.find(d=>d.id===id);if(!d)return;
  const number=(name,value)=>`<label>${name}<input name="${name}" type="number" step="any" value="${value}" required></label>`;
  const targets=this.targets(),targetOptions=targets.map(ref=>{const target=this.target(ref),value=ref.placementId?'p:'+ref.placementId:'d:'+ref.decorationId,label=ref.placementId?this.host.snapshot.items[target.itemId]?.title:target.text||shapeNames[target.shape]||target.type;return `<option value="${esc(value)}">${esc(label)}</option>`;}).join('');
  const resolved=d.type==='line'?resolveLine(d,this.host.snapshot):null;
  const endpoint=(name,end,p)=>{const value=end?.placementId?'p:'+end.placementId:end?.decorationId?'d:'+end.decorationId:'free';return `<fieldset class="whiteboard-endpoint-form"><legend>${name==='from'?'Start':'End'} · ${p.x}, ${p.y}${p.detached?' · detached':p.attached?' · attached':' · free'}</legend><label>Target<select name="${name}Target"><option value="free">Free point</option>${targetOptions}${value!=='free'&&!targets.some(ref=>value===(ref.placementId?'p:'+ref.placementId:'d:'+ref.decorationId))?`<option value="${esc(value)}">Unavailable target</option>`:''}</select></label><div class="whiteboard-fields">${number(name+'X',p.x)}${number(name+'Y',p.y)}<label>Side<select name="${name}Side">${sides.map(side=>`<option ${end?.side===side?'selected':''}>${side}</option>`).join('')}</select></label>${number(name+'Offset',end?.offset??.5)}</div></fieldset>`;};
  const html=`<p class="whiteboard-inspector-help">Positions and sizes use logical board units; zoom does not change these values.</p><label>Text<textarea name="text">${esc(d.text||'')}</textarea></label>${resolved?`${endpoint('from',d.from,resolved.from)}${endpoint('to',d.to,resolved.to)}<p class="whiteboard-inspector-help">Free points use X / Y. Attached points use a target, side and offset from 0 to 1. Dragging the whole arrow makes both endpoints free.</p>`:`<div class="whiteboard-fields">${number('x',d.x)}${number('y',d.y)}${number('width',d.width)}${number('height',d.height)}</div>${d.shape?`<label>Shape<select name="shape">${Object.entries(shapeNames).map(([key,label])=>`<option value="${key}" ${key===d.shape?'selected':''}>${label}</option>`).join('')}</select></label>`:''}`}<button type="submit" class="workspace-primary">Save geometry</button>`;
  const dialog=makeDialog('Exact geometry',html,async form=>{
   const patch={text:form.get('text')};if(resolved){for(const name of ['from','to']){const target=form.get(name+'Target');patch[name]=target==='free'?{x:Number(form.get(name+'X')),y:Number(form.get(name+'Y'))}:{[target.startsWith('p:')?'placementId':'decorationId']:target.slice(2),side:form.get(name+'Side'),offset:Number(form.get(name+'Offset'))};}const from=resolveEndpoint(patch.from,this.host.snapshot),to=resolveEndpoint(patch.to,this.host.snapshot);if(from.detached||to.detached)throw new Error('Choose an available target or a free point.');Object.assign(patch,lineBox(from,to));}else{for(const key of ['x','y','width','height'])patch[key]=Number(form.get(key));if(d.shape)patch.shape=form.get('shape');}await this.save(id,patch);
  });
  if(resolved)for(const name of ['from','to']){const end=d[name],value=end?.placementId?'p:'+end.placementId:end?.decorationId?'d:'+end.decorationId:'free';dialog?.querySelector(`[name="${name}Target"]`)?.setAttribute('data-default',value);const select=dialog?.querySelector(`[name="${name}Target"]`);if(select)select.value=value;}
 }
}
