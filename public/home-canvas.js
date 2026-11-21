import {arrangePositions,arrangeMenuMarkup,arrangeMenuKeys,ARRANGE_ICON} from './arrange.js';
import {showFailure,toast} from './workspace.js';
const copy=value=>structuredClone(value || {});
const same=(a,b)=>JSON.stringify(a || {})===JSON.stringify(b || {});
// Home has board memberships rather than canonical placements. Its optional
// geometry is workspace-owned; the ordinary grid and board URLs remain intact.
export class HomeCanvas {
  constructor(host) {
    this.host=host;this.grid=document.getElementById('board-grid');this.mode='grid';
    this.key=`tinka/${host.config.workspaceId}/home-layout-mode`;
    try{this.mode=localStorage.getItem(this.key)|| (host.workspace.homeLayout?'canvas':'grid');}catch{}
    this.viewport=document.createElement('div');this.viewport.className='home-canvas-viewport';
    this.grid.before(this.viewport);this.viewport.append(this.grid);
    this.controls=document.createElement('div');this.controls.className='home-canvas-controls';
    this.controls.innerHTML='<div class="tk-seg" role="group" aria-label="Home layout"><button type="button" data-home-layout="grid">Grid</button><button type="button" data-home-layout="canvas">Canvas</button></div><button type="button" class="tk-btn tk-sm" data-home-undo disabled>Undo</button><button type="button" class="tk-btn tk-sm" data-home-redo disabled>Redo</button>';
    host.toolbar.prepend(this.controls);
    this.controls.onclick=e=>{const mode=e.target.closest('[data-home-layout]');if(mode)this.setMode(mode.dataset.homeLayout);if(e.target.closest('[data-home-undo]'))this.replay(false);if(e.target.closest('[data-home-redo]'))this.replay(true);};
    this.undo=[];this.redo=[];
    this.historyKey=`tinka/${host.config.workspaceId}/home-layout-history`;
    try{const history=JSON.parse(sessionStorage.getItem(this.historyKey));if(history?.version===1&&Array.isArray(history.undo)&&Array.isArray(history.redo)){this.undo=history.undo.slice(-50);this.redo=history.redo.slice(-50);}}catch{}
    this.positions={};this.gestures();
  }
  rememberHistory(){try{sessionStorage.setItem(this.historyKey,JSON.stringify({version:1,undo:this.undo,redo:this.redo}));}catch{}}
  cards(){return [...this.grid.querySelectorAll('[data-home-board]')];}
  editableCards(){return this.cards().filter(card=>card.dataset.homeItem);}
  seed() {
    const origin=this.grid.getBoundingClientRect();
    return Object.fromEntries(this.cards().map(card=>{const box=card.getBoundingClientRect();return [card.dataset.homeBoard,{x:Math.round(box.left-origin.left),y:Math.round(box.top-origin.top),width:Math.round(box.width),height:Math.round(box.height)}];}));
  }
  render() {
    this.closeMenu();
    // Measure the normal responsive grid before assigning canvas geometry.
    this.viewport.classList.remove('is-canvas');this.grid.style.cssText='';
    for(const card of this.cards())card.style.cssText='';
    this.grid.querySelector('.empty-card')?.removeAttribute('style');
    const defaults=this.seed(),saved=this.host.workspace.homeLayout || {};
    this.positions=copy(saved);
    let bottom=Object.values(saved).reduce((value,box)=>Math.max(value,box.y+box.height+40),0);
    for(const card of this.cards()){
      const id=card.dataset.homeBoard;
      if(!this.positions[id]){
        this.positions[id]=Object.keys(saved).length?{...defaults[id],x:0,y:bottom}:defaults[id];
        if(Object.keys(saved).length)bottom+=defaults[id].height+40;
      }
    }
    this.paint();
  }
  setMode(mode) {
    if(this.busy || this.drag)return;
    this.mode=mode==='canvas'?'canvas':'grid';
    try{localStorage.setItem(this.key,this.mode);}catch{}
    this.render();this.host.syncSelection();
  }
  paint() {
    const canvas=this.mode==='canvas';this.viewport.classList.toggle('is-canvas',canvas);
    this.grid.dataset.homeCanvas=String(canvas);
    for(const button of document.querySelectorAll('.home-sort button')){button.disabled=canvas;button.title=canvas?'Choose Grid to sort boards':'';}
    if(canvas)document.getElementById('sort-label').textContent='saved arrangement';
    else document.getElementById('sort-label').textContent=({created:'newest first',updated:'recently edited first',az:'A to Z'})[document.querySelector('.home-sort [aria-pressed=true]')?.dataset.sort || 'created'];
    for(const card of this.cards()){
      const box=this.positions[card.dataset.homeBoard];
      card.style.cssText=canvas?`position:absolute;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`:'';
    }
    if(canvas){
      const boxes=this.cards().map(card=>this.positions[card.dataset.homeBoard]);
      const bottom=Math.max(0,...boxes.map(box=>box.y+box.height)),right=Math.max(0,...boxes.map(box=>box.x+box.width));
      const add=this.grid.querySelector('.empty-card');
      if(add)add.style.cssText=`position:absolute;left:0;top:${bottom+40}px;width:280px;min-height:140px`;
      this.grid.style.width=`${Math.max(this.viewport.clientWidth,right+12)}px`;this.grid.style.height=`${bottom+220}px`;
    }else{this.grid.style.cssText='';this.grid.querySelector('.empty-card')?.removeAttribute('style');}
    for(const button of this.controls.querySelectorAll('[data-home-layout]'))button.setAttribute('aria-pressed',String(button.dataset.homeLayout===this.mode));
    this.controls.querySelector('[data-home-undo]').disabled=this.busy || !this.undo.length;
    this.controls.querySelector('[data-home-redo]').disabled=this.busy || !this.redo.length;
  }
  objects(){return this.editableCards().filter(card=>this.host.selected.has(card.dataset.homeItem)).map(card=>({id:card.dataset.homeBoard,box:this.positions[card.dataset.homeBoard]}));}
  arrangeButton(){return this.objects().length>=2?`<button type="button" class="tk-btn tk-sm" data-home-action="arrange" aria-haspopup="dialog" aria-expanded="false">${ARRANGE_ICON}<span>Arrange</span></button>`:'';}
  closeMenu(){if(!this.menu)return;this.menu.events.abort();this.menu.element.remove();this.menu.anchor.setAttribute('aria-expanded','false');this.menu=null;queueMicrotask(()=>this.host.drainLive());}
  openMenu(anchor){
    if(this.menu){this.closeMenu();return;}
    const objects=this.objects();if(objects.length<2 || this.busy)return;
    const element=document.createElement('div'),events=new AbortController();
    element.className='tk-menu arrange-menu';element.setAttribute('role','dialog');element.setAttribute('aria-label','Arrange');element.innerHTML=arrangeMenuMarkup(objects.length);document.body.append(element);
    this.menu={element,anchor,events};anchor.setAttribute('aria-expanded','true');
    // Establish the floating sizing context before measuring: an unpositioned
    // block initially spans the page and would incorrectly clamp to the left.
    Object.assign(element.style,{position:'fixed',width:'max-content',maxWidth:'calc(100vw - 16px)',maxHeight:`${Math.max(120,innerHeight-16)}px`});
    const box=anchor.getBoundingClientRect(),width=element.offsetWidth,height=element.offsetHeight;
    const above=box.top-height-8,below=box.bottom+8;
    const top=above>=8?above:below+height<=innerHeight-8?below:Math.max(8,Math.min(innerHeight-height-8,above));
    Object.assign(element.style,{left:`${Math.max(8,Math.min(innerWidth-width-8,box.left))}px`,top:`${top}px`});
    element.onclick=e=>{const action=e.target.closest('[data-arrange]:not(:disabled)');if(!action)return;const kind=action.dataset.arrange;this.closeMenu();anchor.focus({preventScroll:true});this.arrange(kind);};
    element.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.closeMenu();anchor.focus({preventScroll:true});}else arrangeMenuKeys(element,e);};
    const away=e=>{if(!element.contains(e.target)&&!anchor.contains(e.target))this.closeMenu();};
    document.addEventListener('pointerdown',away,{capture:true,signal:events.signal});document.addEventListener('focusin',away,{signal:events.signal});
    element.querySelector('button:not(:disabled)').focus({preventScroll:true});
  }
  async arrange(kind){
    const objects=this.objects();if(this.busy || objects.length<(kind.startsWith('distribute')?3:2))return;
    const next=arrangePositions(kind,objects),layout=copy(this.positions);
    objects.forEach((object,index)=>Object.assign(layout[object.id],next[index]));
    this.mode='canvas';try{localStorage.setItem(this.key,'canvas');}catch{}
    await this.save(layout);
  }
  async save(layout,{history=true}={}){
    if(this.busy)return false;
    const source=copy(this.host.workspace),before=copy(source.homeLayout);
    if(same(before,layout)){this.paint();return false;}
    this.busy=true;this.positions={...this.positions,...copy(layout)};this.paint();
    try{
      // updateWorkspace deliberately uses the strict revision captured from the
      // displayed Home, never a later client watermark or a weaker retry.
      await this.host.client.structural('updateWorkspace',{patch:{homeLayout:layout}},source);
      if(history){this.undo.push({before,after:copy(layout)});if(this.undo.length>50)this.undo.shift();this.redo=[];this.rememberHistory();}
      await this.host.refresh();return true;
    }catch(error){showFailure(error);await this.host.refresh().catch(()=>{});return false;}
    finally{this.busy=false;this.paint();this.host.drainLive();}
  }
  async replay(redo){
    if(this.busy || this.drag || this.host.client.pendingWrites)return;
    const from=redo?this.redo:this.undo,to=redo?this.undo:this.redo,entry=from.at(-1);if(!entry)return;
    await this.host.refresh();
    if(!same(this.host.workspace.homeLayout,redo?entry.before:entry.after)){toast('Home’s arrangement changed elsewhere. Review it before undoing.');return;}
    if(await this.save(redo?entry.after:entry.before,{history:false})){from.pop();to.push(entry);this.rememberHistory();this.paint();}
  }
  gestures(){
    let swallow=false;
    this.grid.addEventListener('click',e=>{if(swallow){swallow=false;e.preventDefault();e.stopImmediatePropagation();}},true);
    this.grid.addEventListener('dragstart',e=>{if(this.mode==='canvas')e.preventDefault();});
    this.grid.addEventListener('pointerdown',e=>{
      swallow=false;
      if(this.drag){finish(true);return;}
      const card=e.target.closest('[data-home-item]');
      if(this.mode!=='canvas'||this.busy||this.host.client.pendingWrites||!card||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||e.target.closest('button,input,textarea,select')||document.querySelector('dialog[open]'))return;
      const selected=this.host.selected.has(card.dataset.homeItem);
      const ids=selected?this.objects().map(object=>object.id):[card.dataset.homeBoard];
      this.drag={id:e.pointerId,x:e.clientX,y:e.clientY,layout:copy(this.positions),ids,active:false};
    });
    const finish=async(cancel=false)=>{const drag=this.drag;if(!drag)return;this.drag=null;this.grid.classList.remove('home-dragging');if(!drag.active){this.host.drainLive();return;}swallow=true;if(cancel){this.positions=drag.layout;this.paint();this.host.drainLive();return;}await this.save(this.positions);};
    document.addEventListener('pointermove',e=>{
      const drag=this.drag;if(!drag||drag.id!==e.pointerId)return;
      let dx=Math.round(e.clientX-drag.x),dy=Math.round(e.clientY-drag.y);
      if(!drag.active&&Math.hypot(dx,dy)<6)return;
      drag.active=true;this.grid.classList.add('home-dragging');getSelection()?.removeAllRanges();
      dx=Math.max(dx,-Math.min(...drag.ids.map(id=>drag.layout[id].x)));dy=Math.max(dy,-Math.min(...drag.ids.map(id=>drag.layout[id].y)));
      for(const id of drag.ids)this.positions[id]={...drag.layout[id],x:drag.layout[id].x+dx,y:drag.layout[id].y+dy};this.paint();
    });
    document.addEventListener('pointerup',e=>{if(this.drag?.id===e.pointerId)finish();});
    document.addEventListener('pointercancel',()=>finish(true));addEventListener('blur',()=>finish(true));
    document.addEventListener('keydown',e=>{
      if(e.defaultPrevented||e.isComposing||e.repeat||e.target.closest('input,textarea,select,[contenteditable],[role=dialog],[role=menu]')||document.querySelector('dialog[open]'))return;
      if(e.key==='Escape'&&this.drag){e.preventDefault();finish(true);return;}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){if(this.undo.length||this.redo.length){e.preventDefault();this.replay(e.shiftKey);}return;}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'){e.preventDefault();this.host.setSelection(new Set(this.editableCards().map(card=>card.dataset.homeItem)));return;}
      const nativeControl=e.target.closest('button,a,summary,[role=button],[role=slider]');
      if(e.key==='Enter'&&nativeControl)return;
      if(e.key==='Enter'&&this.host.selected.size===1){const card=this.editableCards().find(card=>this.host.selected.has(card.dataset.homeItem));if(card){e.preventDefault();card.querySelector('.board-link').click();}return;}
      if(nativeControl||this.mode!=='canvas'||e.metaKey||e.ctrlKey||e.altKey||this.busy||this.host.client.pendingWrites||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
      const objects=this.objects();if(!objects.length)return;e.preventDefault();
      const step=e.shiftKey?10:1,dx=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,dy=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0,layout=copy(this.positions);
      if(objects.some(object=>object.box.x+dx<0||object.box.y+dy<0))return;
      for(const object of objects){layout[object.id].x+=dx;layout[object.id].y+=dy;}this.save(layout);
    });
    addEventListener('resize',()=>{this.closeMenu();if(this.mode==='grid')this.render();else this.paint();});
  }
}
