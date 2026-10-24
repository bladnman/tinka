import {escape as esc,makeDialog,toast} from './workspace.js';
import {pointAnchorAt,resolveCommentPoint} from './feedback-geometry.js';
export function voteTotals(votes={}){const result={yes:0,no:0,abstain:0};for(const vote of Object.values(votes))if(Object.hasOwn(result,vote.value))result[vote.value]++;return result;}
// Local descriptors are deliberately not accounts or authentication.
export class FeedbackController {
  constructor({client,getBoard,getOrigin=()=>({x:0,y:0}),screenToCanvas,refresh=async()=>{},getMode=()=> 'canvas',onPointMode=()=>{}}){
    Object.assign(this,{client,getBoard,getOrigin,screenToCanvas,refresh,getMode,onPointMode});
    this.threads=[];this.visible=false;this.pinsVisible=true;this.onlyUnresolved=false;this.itemId=null;this.request=0;
    this.actorKey=`tinka/${client.config.workspaceId}/feedback-actor`;
    try{this.actor=JSON.parse(localStorage.getItem(this.actorKey));}catch{}
    if(!this.actor||!/^human-[a-z0-9-]+$/i.test(this.actor.id)||typeof this.actor.label!=='string'||this.actor.label.length>120)this.actor={id:`human-${crypto.randomUUID()}`,label:'You',kind:'human'};
    this.actor.kind='human';this.saveActor();
  }
  saveActor(){try{localStorage.setItem(this.actorKey,JSON.stringify(this.actor));}catch{}}
  mount({toolbar,world,viewport}){
    this.world=world;this.viewport=viewport;
    if(!document.querySelector('link[data-feedback-css]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/app/feedback.css';link.dataset.feedbackCss='';document.head.append(link);}
    this.toggle=document.createElement('button');this.toggle.type='button';this.toggle.dataset.feedbackToggle='';this.toggle.textContent='Comments & votes';this.toggle.setAttribute('aria-expanded','false');this.toggle.onclick=()=>this.open();toolbar.append(this.toggle);
    this.layer=document.createElement('div');this.layer.className='feedback-pins';this.layer.setAttribute('aria-label','Comment points');
    this.panel=document.createElement('aside');this.panel.className='feedback-panel';this.panel.hidden=true;this.panel.setAttribute('aria-label','Comments and votes');
    this.panel.innerHTML=`<header><strong>Comments</strong><button type="button" data-feedback-close aria-label="Close comments">×</button></header><div class="feedback-scope"></div><label class="feedback-actor">Your name <input maxlength="120" aria-label="Your comment name" value="${esc(this.actor.label)}"></label><small class="feedback-local">Your name is saved in this browser.</small><div class="feedback-votes"></div><div class="feedback-actions"><button type="button" data-feedback-add>Add comment</button><button type="button" data-feedback-point>Add point</button></div><div class="feedback-options"><label><input type="checkbox" data-feedback-unresolved> Unresolved only</label><label><input type="checkbox" data-feedback-pins checked> Show points</label></div><p class="feedback-status" role="status"></p><div class="feedback-list"></div><button type="button" data-feedback-more hidden>Load more</button>`;
    document.body.append(this.panel);
    this.panel.querySelector('[data-feedback-close]').onclick=()=>this.close();
    this.panel.querySelector('.feedback-actor input').onchange=e=>{this.actor.label=e.target.value.trim()||'You';e.target.value=this.actor.label;this.saveActor();};
    this.panel.querySelector('[data-feedback-add]').onclick=()=>this.compose({itemId:this.itemId});
    this.panel.querySelector('[data-feedback-point]').onclick=()=>this.beginPoint();
    this.panel.querySelector('[data-feedback-pins]').onchange=e=>{this.pinsVisible=e.target.checked;this.syncPins();};
    this.panel.querySelector('[data-feedback-unresolved]').onchange=e=>{this.onlyUnresolved=e.target.checked;this.reload().catch(error=>this.failure(error));};
    this.panel.querySelector('[data-feedback-more]').onclick=()=>this.reload({more:true}).catch(error=>this.failure(error));
    this.panel.addEventListener('click',e=>{
      const reply=e.target.closest('[data-feedback-reply]'),resolve=e.target.closest('[data-feedback-resolve]'),vote=e.target.closest('[data-feedback-vote]');
      const scope=e.target.closest('[data-feedback-item-scope]');if(scope)this.open({itemId:scope.dataset.feedbackItemScope});
      if(reply)this.reply(reply.dataset.feedbackReply);
      if(resolve)this.resolve(resolve.dataset.feedbackResolve,resolve.dataset.resolved!=='true');
      if(vote)this.vote(this.itemId,vote.dataset.feedbackVote==='clear'?null:vote.dataset.feedbackVote);
    });
    this.pointHandler=e=>{
      if(!this.pointMode||!this.viewport.contains(e.target)||e.button!==0)return;
      e.preventDefault();e.stopImmediatePropagation();
      const point=this.screenToCanvas({x:e.clientX,y:e.clientY});
      const placement=e.target.closest('[data-placement]')?.dataset.placement;
      const decoration=e.target.closest('[data-decoration]')?.dataset.decoration;
      const itemId=placement?this.getBoard().placements.find(p=>p.id===placement)?.itemId:undefined;
      const anchor=pointAnchorAt(point,this.getBoard(),placement?{placementId:placement}:decoration?{decorationId:decoration}:{});
      this.pointClick={until:Date.now()+700,x:e.clientX,y:e.clientY};this.endPoint();this.compose({itemId,anchor});
    };
    this.clickHandler=e=>{if(this.pointClick&&Date.now()<this.pointClick.until&&Math.hypot(e.clientX-this.pointClick.x,e.clientY-this.pointClick.y)<6&&this.viewport.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();this.pointClick=null;}};
    window.addEventListener('click',this.clickHandler,true);
    this.keyHandler=e=>{if(e.key==='Escape'&&this.pointMode){e.preventDefault();this.endPoint();toast('Point comment cancelled.');}};
    window.addEventListener('pointerdown',this.pointHandler,true);window.addEventListener('keydown',this.keyHandler,true);
    this.sync();
  }
  status(message){this.panel.querySelector('.feedback-status').textContent=message;}
  failure(error){this.status(error.message);toast(error.message);}
  async open({itemId=null,threadId=null}={}){
    const changedScope=this.itemId!==itemId;
    this.visible=true;this.itemId=itemId;if(changedScope){this.threads=[];this.nextCursor=null;this.renderList();this.syncPins();}this.status('Loading comments…');this.panel.hidden=false;this.toggle.setAttribute('aria-expanded','true');this.renderScope();
    try{await this.reload();if(threadId)this.focusThread(threadId);}catch(error){this.failure(error);}
  }
  close(){this.visible=false;this.panel.hidden=true;this.toggle.setAttribute('aria-expanded','false');this.endPoint();if(this.itemId){this.itemId=null;this.reload().catch(error=>this.failure(error));}}
  renderScope(){
    const item=this.getBoard().items?.[this.itemId];
    const scope=this.panel.querySelector('.feedback-scope');scope.textContent=item?item.title:this.getBoard().title||'This board';
    if(item){const b=document.createElement('button');b.type='button';b.textContent='All board comments';b.onclick=()=>this.open();scope.append(b);}
    this.panel.querySelector('[data-feedback-point]').disabled=this.getMode()!=='canvas';this.renderVotes();
  }
  renderVotes(){
    const item=this.getBoard().items?.[this.itemId],target=this.panel.querySelector('.feedback-votes');
    if(!item){target.innerHTML='';return;}
    const totals=voteTotals(item.review?.votes),mine=item.review?.votes?.[this.actor.id]?.value;
    target.innerHTML=`<strong>Your vote</strong><div role="group" aria-label="Vote on ${esc(item.title)}">${['yes','no','abstain'].map(value=>`<button type="button" data-feedback-vote="${value}" aria-pressed="${mine===value}">${value[0].toUpperCase()+value.slice(1)} <span>${totals[value]}</span></button>`).join('')}<button type="button" data-feedback-vote="clear" ${mine?'':'disabled'}>Clear</button></div>`;
  }
  async vote(itemId,value){try{await this.client.write('vote',{itemId,actor:this.actor,value});await this.refresh();this.renderVotes();toast(value?`Vote saved: ${value}.`:'Your vote was cleared.');}catch(error){this.failure(error);}}
  beginPoint(){if(this.getMode()!=='canvas'){toast('Use Canvas to place a point comment.');return;}this.pointMode=true;this.panel.hidden=true;this.viewport.classList.add('feedback-point-mode');this.onPointMode(true);toast('Click a place on the canvas to comment. Escape cancels.');}
  endPoint(){this.pointMode=false;this.viewport?.classList.remove('feedback-point-mode');this.onPointMode(false);if(this.visible)this.panel.hidden=false;}
  compose({itemId,anchor}={}){
    const operationId=crypto.randomUUID();
    const title=anchor?.kind==='text'?'Comment on selected text':anchor?'Comment at this point':'Add comment';
    const context=anchor?.kind==='text'?`<blockquote>${esc(anchor.quote)}</blockquote>`:anchor?`<p>${anchor.relative?'This point follows the selected target when it moves or resizes.':'This comment retains the selected canvas point.'}</p>`:'';
    makeDialog(title,`${context}<label>Comment<textarea name="body" required maxlength="20000" rows="5" autofocus></textarea></label><button type="submit">Save comment</button>`,async data=>{
      await this.client.write('addComment',{boardId:this.getBoard().id,...(itemId?{itemId}:{}),...(anchor?{anchor}:{}),author:this.actor,body:data.get('body')},{operationId});
      this.itemId=itemId||null;this.visible=true;this.panel.hidden=false;this.toggle.setAttribute('aria-expanded','true');await this.refresh();this.renderScope();await this.reload();
    });
  }
  // Canonical item/text entry points for reader integrations.
  commentOnItem(itemId){this.compose({itemId});}
  commentOnText(itemId,anchor){this.compose({itemId,anchor:{...anchor,kind:'text'}});}
  reply(threadId){makeDialog('Reply to comment','<label>Reply<textarea name="body" required maxlength="20000" rows="4" autofocus></textarea></label><button type="submit">Save reply</button>',async data=>{await this.client.write('replyComment',{threadId,author:this.actor,body:data.get('body')});await this.refresh();await this.reload();});}
  async resolve(threadId,resolved){try{await this.client.write('resolveComment',{threadId,resolved});await this.refresh();await this.reload();}catch(error){this.failure(error);}}
  async reload({more=false}={}){
    const request=++this.request,params=new URLSearchParams({boardId:this.getBoard().id,includeBodies:'true',limit:'50'});
    if(this.itemId)params.set('itemId',this.itemId);if(this.onlyUnresolved)params.set('resolved','false');if(more&&this.nextCursor)params.set('cursor',this.nextCursor);
    const result=await this.client.get(`/api/feedback?${params}`);if(request!==this.request)return;
    this.client.revision=Math.max(this.client.revision,result.revision);this.threads=more?[...this.threads,...result.threads]:result.threads;this.nextCursor=result.nextCursor;
    this.status(this.threads.length?`${this.threads.length} comment${this.threads.length===1?'':'s'}${this.nextCursor?' shown · Load more for remaining comments and points':''}`:'No comments here yet.');this.renderList();this.syncPins();
  }
  renderList(){
    this.panel.querySelector('.feedback-list').innerHTML=this.threads.map((thread,index)=>`<article tabindex="-1" data-feedback-thread="${esc(thread.id)}" class="feedback-thread ${thread.resolved?'resolved':''}"><header><strong>${esc(thread.author.label)}</strong><small>${esc(thread.author.kind)} · ${new Date(thread.createdAt).toLocaleDateString()}</small></header><p class="feedback-context">${thread.itemId?this.getBoard().items?.[thread.itemId]?`<button type="button" data-feedback-item-scope="${esc(thread.itemId)}">On ${esc(this.getBoard().items[thread.itemId].title)}</button>`:'Item no longer on this board':'Board comment'}</p>${thread.anchor?`<p class="feedback-anchor">${thread.anchor.kind==='point'?`Point ${index+1}`:'Selected text'} · ${esc(({point:thread.anchor.relative?'Follows target':'Fixed canvas point',matched:'Located',uncertain:'Source or context changed · quote needs review',stale:'Quote unlocated or ambiguous',detached:thread.anchor.kind==='point'?'Target unavailable · original point':'Target unavailable',unverified:'Source unavailable or unsupported'})[thread.anchorStatus]||'Source not checked')}${thread.anchor.kind==='text'?`<q>${esc(thread.anchor.quote)}</q>`:''}</p>`:''}<p class="feedback-body">${esc(thread.body||thread.excerpt)}</p>${(thread.replies||[]).map(reply=>`<div class="feedback-reply"><strong>${esc(reply.author.label)} <small>${esc(reply.author.kind)}</small></strong><p class="feedback-body">${esc(reply.body)}</p></div>`).join('')}<footer><button type="button" data-feedback-reply="${esc(thread.id)}">Reply</button><button type="button" data-feedback-resolve="${esc(thread.id)}" data-resolved="${thread.resolved}">${thread.resolved?'Reopen':'Resolve'}</button>${thread.resolved?'<span>Resolved</span>':''}</footer></article>`).join('');
    this.panel.querySelector('[data-feedback-more]').hidden=!this.nextCursor;
  }
  focusThread(id){const thread=[...this.panel.querySelectorAll('[data-feedback-thread]')].find(el=>el.dataset.feedbackThread===id);thread?.focus({preventScroll:true});thread?.scrollIntoView({block:'nearest'});}
  syncPins(overrides){
    if(!this.layer||!this.world)return;this.layer.hidden=!this.pinsVisible||this.getMode()!=='canvas';
    if(this.layer.parentNode!==this.world)this.world.append(this.layer);
    const origin=this.getOrigin()||{x:0,y:0};
    this.layer.innerHTML=this.threads.map((thread,index)=>{
      if(thread.anchor?.kind!=='point')return '';
      const point=resolveCommentPoint(thread.anchor,this.getBoard(),overrides);
      return `<button type="button" class="feedback-pin ${thread.resolved?'resolved':''} ${point.detached?'detached':''}" data-feedback-pin="${esc(thread.id)}" style="left:${point.x+origin.x}px;top:${point.y+origin.y}px" aria-label="Comment ${index+1}${point.detached?' · target unavailable; original point':''}: ${esc((thread.body||thread.excerpt||'').slice(0,80))}">${index+1}</button>`;
    }).join('');
    for(const pin of this.layer.querySelectorAll('[data-feedback-pin]'))pin.onclick=e=>{e.stopPropagation();this.visible=true;this.panel.hidden=false;this.toggle.setAttribute('aria-expanded','true');this.focusThread(pin.dataset.feedbackPin);};
  }
  sync(overrides){this.syncPins(overrides);if(this.visible)this.renderScope();}
  destroy(){window.removeEventListener('click',this.clickHandler,true);window.removeEventListener('pointerdown',this.pointHandler,true);window.removeEventListener('keydown',this.keyHandler,true);this.panel?.remove();this.layer?.remove();this.toggle?.remove();}
}
