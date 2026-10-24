import {escape as esc,toast} from './workspace.js';
import {pointAnchorAt,resolveCommentPoint} from './feedback-geometry.js';
import {bindForm,restoreFocus,commitShortcutLabel} from './interaction.js';
export function voteTotals(votes={}){const result={yes:0,no:0,abstain:0};for(const vote of Object.values(votes))if(Object.hasOwn(result,vote.value))result[vote.value]++;return result;}
const capital=s=>s[0].toUpperCase()+s.slice(1);
// Local identity is self-reported. Drafts, conversations and ballots are separate.
export class FeedbackController {
  constructor({client,getBoard,getOrigin=()=>({x:0,y:0}),screenToCanvas,refresh=async()=>{},getMode=()=> 'canvas',onPointMode=()=>{},onCommitted=()=>{}}){
    Object.assign(this,{client,getBoard,getOrigin,screenToCanvas,refresh,getMode,onPointMode,onCommitted});
    this.threads=[];this.visible=false;this.pinsVisible=true;this.onlyUnresolved=false;this.itemId=null;this.request=0;this.mode='board';this.voting=new Set();this.annotationActions=new Map();this.drafts=new Map();
    this.actorKey=`tinka/${client.config.workspaceId}/feedback-actor`;this.draftStore=`tinka/${client.config.workspaceId}/conversation-drafts`;
    try{this.actor=JSON.parse(localStorage.getItem(this.actorKey));}catch{}
    if(!this.actor||!/^human-[a-z0-9-]+$/i.test(this.actor.id)||typeof this.actor.label!=='string'||this.actor.label.length>120)this.actor={id:`human-${crypto.randomUUID()}`,label:'You',kind:'human'};
    this.actor.kind='human';this.saveActor();
    try{for(const d of JSON.parse(sessionStorage.getItem(this.draftStore)||'[]'))if(d&&typeof d.key==='string'&&typeof d.body==='string'&&d.body.length<=20000){d.pending=false;this.drafts.set(d.key,d);}}catch{}
  }
  saveActor(){try{localStorage.setItem(this.actorKey,JSON.stringify(this.actor));}catch{}}
  mount({toolbar,world,viewport}){
    this.world=world;this.viewport=viewport;
    if(!document.querySelector('link[data-feedback-css]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/app/feedback.css';link.dataset.feedbackCss='';document.head.append(link);}
    this.toggle=document.createElement('button');this.toggle.type='button';this.toggle.dataset.feedbackToggle='';this.toggle.textContent='Comments';this.toggle.setAttribute('aria-expanded','false');this.toggle.onclick=()=>this.open({returnFocus:this.toggle});toolbar.append(this.toggle);
    this.layer=document.createElement('div');this.layer.className='feedback-pins';this.layer.setAttribute('aria-label','Comment points');
    this.panel=document.createElement('aside');this.panel.className='feedback-panel';this.panel.hidden=true;this.panel.setAttribute('aria-label','Comments');
    this.panel.innerHTML=`<header class="feedback-head"><div><strong>Comments</strong><p class="feedback-scope"></p></div><button type="button" data-feedback-settings aria-label="Conversation options" aria-expanded="false">⋯</button><button type="button" data-feedback-close aria-label="Close comments">×</button></header><section class="feedback-settings" hidden><label>Your name<input maxlength="120" aria-label="Your comment name" value="${esc(this.actor.label)}"></label><p>Your name is saved in this browser.</p><label><input type="checkbox" data-feedback-unresolved> Unresolved only</label><label><input type="checkbox" data-feedback-pins checked> Show points</label><button type="button" data-feedback-point>Add point</button><button type="button" data-feedback-board>Board discussion</button></section><div class="feedback-history"><p class="feedback-status" role="status"></p><div class="feedback-list"></div><button type="button" data-feedback-more hidden>Load more comments</button></div><form class="feedback-composer"><div class="feedback-compose-context" hidden></div><label class="sr-only" for="feedback-message">Comment</label><textarea id="feedback-message" name="body" rows="2" maxlength="20000" required placeholder="Write a comment…"></textarea><p class="feedback-post-status" role="status"></p><footer><button type="button" class="feedback-posting-as" data-feedback-identity></button><span class="feedback-shortcut">${esc(commitShortcutLabel())}</span><button type="submit" data-feedback-post>Post</button></footer></form>`;
    document.body.append(this.panel);this.textarea=this.panel.querySelector('textarea');this.form=this.panel.querySelector('form');this.settings=this.panel.querySelector('.feedback-settings');
    this.textarea.addEventListener('input',()=>{this.saveDraft();this.postStatus('');});
    this.formBinding=bindForm(this.form,{submit:()=>this.postDraft(),onError:()=>{},onPendingChange:pending=>{this.textarea.readOnly=pending;}});
    this.panel.querySelector('[data-feedback-close]').onclick=()=>this.close();
    this.panel.querySelector('[data-feedback-settings]').onclick=()=>this.showSettings(this.settings.hidden);
    this.panel.querySelector('[data-feedback-identity]').onclick=()=>{this.showSettings(true);this.settings.querySelector('input').focus();};
    this.settings.querySelector('input[aria-label]').onchange=e=>{this.actor.label=e.target.value.trim()||'You';e.target.value=this.actor.label;this.saveActor();this.renderScope();};
    this.panel.querySelector('[data-feedback-point]').onclick=()=>this.beginPoint();
    this.panel.querySelector('[data-feedback-board]').onclick=()=>this.open({mode:this.mode,host:this.panel.parentElement,returnFocus:this.returnFocus});
    this.panel.querySelector('[data-feedback-pins]').onchange=e=>{this.pinsVisible=e.target.checked;this.syncPins();};
    this.panel.querySelector('[data-feedback-unresolved]').onchange=e=>{this.onlyUnresolved=e.target.checked;this.reload().catch(error=>this.failure(error));};
    this.panel.querySelector('[data-feedback-more]').onclick=()=>this.reload({more:true}).catch(error=>this.failure(error));
    this.panel.addEventListener('click',e=>{
      const reply=e.target.closest('[data-feedback-reply]'),resolve=e.target.closest('[data-feedback-resolve]'),scope=e.target.closest('[data-feedback-item-scope]');
      if(scope)this.open({itemId:scope.dataset.feedbackItemScope,mode:this.mode,host:this.panel.parentElement,returnFocus:this.returnFocus});
      if(reply)this.reply(reply.dataset.feedbackReply);
      if(resolve)this.resolve(resolve.dataset.feedbackResolve,resolve.dataset.resolved!=='true');
      if(e.target.closest('[data-feedback-context-clear]')){this.saveDraft();this.selectDraft({itemId:this.itemId,fresh:true});this.textarea.focus();}
    });
    this.pointHandler=e=>{
      if(!this.pointMode||!this.viewport.contains(e.target)||e.button!==0)return;
      e.preventDefault();e.stopImmediatePropagation();
      const point=this.screenToCanvas({x:e.clientX,y:e.clientY}),placement=e.target.closest('[data-placement]')?.dataset.placement,decoration=e.target.closest('[data-decoration]')?.dataset.decoration;
      const itemId=placement?this.getBoard().placements.find(p=>p.id===placement)?.itemId:undefined;
      const anchor=pointAnchorAt(point,this.getBoard(),placement?{placementId:placement}:decoration?{decorationId:decoration}:{});
      this.pointClick={until:Date.now()+700,x:e.clientX,y:e.clientY};this.endPoint();this.compose({itemId,anchor});
    };
    this.clickHandler=e=>{if(this.pointClick&&Date.now()<this.pointClick.until&&Math.hypot(e.clientX-this.pointClick.x,e.clientY-this.pointClick.y)<6&&this.viewport.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();this.pointClick=null;}};
    this.outsideHandler=e=>{
      if(this.ballot&&!this.ballot.contains(e.target)&&!this.ballotAnchor?.contains(e.target))this.closeVote({restoreFocus:false});
      if(this.visible&&this.mode==='board'&&!this.pointMode&&!this.panel.contains(e.target)&&!e.target.closest('[data-item-feedback],[data-feedback-toggle],.feedback-pin'))this.close({restoreFocus:false});
    };
    this.keyHandler=e=>{if(e.key==='Escape')this.consumeEscape(e);};this.repositionHandler=()=>{this.positionBallot();this.sizePanel();};
    window.addEventListener('click',this.clickHandler,true);window.addEventListener('pointerdown',this.pointHandler,true);window.addEventListener('pointerdown',this.outsideHandler,true);window.addEventListener('keydown',this.keyHandler,true);window.addEventListener('resize',this.repositionHandler);window.visualViewport?.addEventListener('resize',this.repositionHandler);this.sync();
  }
  status(message){this.panel.querySelector('.feedback-status').textContent=message;}
  postStatus(message,error=false){const el=this.panel.querySelector('.feedback-post-status');el.textContent=message;el.setAttribute('role',error?'alert':'status');}
  failure(error){this.status(error.message);}
  showSettings(show){this.settings.hidden=!show;this.panel.querySelector('[data-feedback-settings]').setAttribute('aria-expanded',String(show));}
  scopeKey(itemId=this.itemId){return `${this.getBoard().id}/${itemId||'board'}`;}
  persistDrafts(){const saved=[...this.drafts.values()].filter(d=>d.body||d.anchor||d.replyTo).sort((a,b)=>a.updatedAt-b.updatedAt).slice(-20);try{sessionStorage.setItem(this.draftStore,JSON.stringify(saved.map(({pending,...d})=>d)));}catch{}}
  saveDraft(){if(!this.draft)return;if(this.draft.body!==this.textarea.value)this.draft.attempt=null;this.draft.body=this.textarea.value;this.draft.updatedAt=Date.now();this.drafts.set(this.draft.key,this.draft);this.persistDrafts();}
  selectDraft({itemId=this.itemId,anchor,replyTo,fresh=false}={}){
    const scope=this.scopeKey(itemId),explicit=anchor||replyTo||fresh;
    let d=!explicit?[...this.drafts.values()].filter(d=>d.scope===scope).sort((a,b)=>b.updatedAt-a.updatedAt)[0]:null;
    const key=`${scope}/${replyTo||'new'}/${anchor?JSON.stringify(anchor):''}`;
    d ||=this.drafts.get(key)||{key,scope,boardId:this.getBoard().id,itemId,anchor,replyTo,body:'',updatedAt:Date.now()};
    this.draft=d;this.textarea.value=d.body;this.postStatus('');this.renderComposer();
  }
  renderComposer(){
    const d=this.draft,context=this.panel.querySelector('.feedback-compose-context');this.panel.dataset.anchored=String(d?.anchor?.kind==='text');context.hidden=!d?.anchor&&!d?.replyTo;
    if(!context.hidden){const thread=this.threads.find(t=>t.id===d.replyTo);context.innerHTML=`<div>${d.replyTo?`Replying to ${esc(thread?.author.label||'this conversation')}`:d.anchor.kind==='text'?'Selected passage':'Canvas point'}<button type="button" data-feedback-context-clear aria-label="${d.replyTo?'Cancel reply':'Remove comment context'}">×</button></div>${d.anchor?.kind==='text'?`<blockquote>${esc(d.anchor.quote)}</blockquote>`:''}`;}
    this.textarea.placeholder=d?.replyTo?'Write a reply…':'Write a comment…';this.panel.querySelector('[data-feedback-post]').textContent=d?.replyTo?'Reply':'Post';this.queueSizing();
  }
  sizePanel(){
    if(!this.panel)return;const v=window.visualViewport,height=v?.height||innerHeight,scale=this.panel.offsetWidth?this.panel.getBoundingClientRect().width/this.panel.offsetWidth:1;
    this.panel.dataset.short=String(!this.nextCursor&&(this.panel.querySelector('.feedback-list')?.scrollHeight||0)<260);this.panel.style.setProperty('--feedback-available-height',`${height/scale}px`);if(this.mode==='board')this.panel.style.maxWidth=`${(v?.width||innerWidth)/scale-24}px`;else this.panel.style.removeProperty('max-width');this.panel.dataset.edge=this.selectionRect&&(this.selectionRect.top+this.selectionRect.bottom)/2>(v?.offsetTop||0)+height/2?'top':'bottom';
    let offset=0;
    if(this.visible&&this.mode==='reader'&&innerWidth>600&&this.selectionRect&&this.panel.dataset.short==='true'){
      const host=this.panel.parentElement.getBoundingClientRect(),box=this.panel.getBoundingClientRect(),field=this.textarea.getBoundingClientRect(),anchorY=this.selectionRect.top-host.top;
      this.panel.style.setProperty('--feedback-anchor-y',`${anchorY/scale}px`);offset=Math.max(0,Math.min(host.height-box.height,anchorY-(field.top-box.top)));
    }
    this.panel.style.setProperty('--feedback-reader-offset',`${offset/scale}px`);
  }
  queueSizing(){cancelAnimationFrame(this.sizingFrame);this.sizingFrame=requestAnimationFrame(()=>this.sizePanel());}
  async open({itemId=null,threadId=null,anchor,host,mode='board',returnFocus,selectionRect,selectionId}={}){
    this.saveDraft();this.closeVote({restoreFocus:false});this.endPoint();const changedScope=this.itemId!==itemId||this.loadedScope!==this.scopeKey(itemId);
    this.mode=mode;this.itemId=itemId;this.returnFocus=returnFocus||(!this.panel.contains(document.activeElement)?document.activeElement:this.returnFocus);
    (host||document.body).append(this.panel);this.panel.dataset.mode=mode;this.selectionRect=selectionRect;this.selectionId=selectionId;this.panel.hidden=false;this.visible=true;this.toggle.setAttribute('aria-expanded','true');this.showSettings(false);this.sizePanel();this.selectDraft({itemId,anchor});this.renderScope();
    if(changedScope){this.threads=[];this.nextCursor=null;this.renderList();this.syncPins();}this.status('Loading comments…');if(!threadId)this.textarea.focus({preventScroll:true});
    try{await this.reload();if(threadId)this.focusThread(threadId);}catch(error){this.failure(error);}
  }
  updateReaderContext({selectionId,selectionRect}={}){if(this.visible&&this.mode==='reader'&&selectionId===this.selectionId){this.selectionRect=selectionRect;this.sizePanel();}}
  close({restoreFocus:restore=true}={}){this.saveDraft();this.visible=false;this.panel.hidden=true;this.toggle.setAttribute('aria-expanded','false');this.showSettings(false);this.endPoint();if(restore)restoreFocus(this.returnFocus);this.reload().catch(()=>{});}
  consumeEscape(e){
    if(e.key!=='Escape'||e.defaultPrevented||e.isComposing||e.keyCode===229)return false;let handled=true;
    if(this.ballot)this.closeVote();else if(this.pointMode)this.endPoint();else if(this.visible&&!this.settings.hidden){this.showSettings(false);this.panel.querySelector('[data-feedback-settings]').focus();}else if(this.visible)this.close();else handled=false;
    if(handled){e.preventDefault();e.stopImmediatePropagation?.();}return handled;
  }
  renderScope(){this.panel.querySelector('.feedback-scope').textContent=this.getBoard().items?.[this.itemId]?.title||this.getBoard().title||'This board';this.panel.querySelector('[data-feedback-point]').hidden=this.mode==='reader'||this.getMode()!=='canvas';this.panel.querySelector('[data-feedback-board]').hidden=!this.itemId||this.mode==='reader';this.panel.querySelector('[data-feedback-identity]').textContent=`As ${this.actor.label}`;}
  beginPoint(){if(this.getMode()!=='canvas'||this.mode==='reader')return;this.saveDraft();this.showSettings(false);this.pointMode=true;this.panel.hidden=true;this.viewport.classList.add('feedback-point-mode');this.onPointMode(true);toast('Click the canvas to place a comment. Escape cancels.');}
  endPoint(){this.pointMode=false;this.viewport?.classList.remove('feedback-point-mode');this.onPointMode(false);if(this.visible)this.panel.hidden=false;}
  compose({itemId=null,anchor,...options}={}){return this.open({itemId,anchor,...options});}
  commentOnItem(itemId,options={}){return this.open({itemId,...options});}
  commentOnText(itemId,anchor,options={}){return this.open({itemId,anchor:{...anchor,kind:'text'},...options});}
  reply(threadId){this.saveDraft();this.selectDraft({itemId:this.itemId,replyTo:threadId});this.textarea.focus({preventScroll:true});}
  async postDraft(){
    this.saveDraft();const d=this.draft;if(!d?.body.trim()||d.pending)return;d.pending=true;
    const type=d.replyTo?'replyComment':'addComment';d.attempt ||={operationId:crypto.randomUUID(),payload:d.replyTo?{threadId:d.replyTo,author:{...this.actor},body:d.body}:{boardId:d.boardId,...(d.itemId?{itemId:d.itemId}:{}),...(d.anchor?{anchor:d.anchor}:{}),author:{...this.actor},body:d.body}};this.postStatus('Posting…');
    try{
      const result=await this.client.write(type,d.attempt.payload,{operationId:d.attempt.operationId});this.drafts.delete(d.key);this.persistDrafts();
      if(this.draft===d){this.draft=null;this.selectDraft({itemId:this.itemId,fresh:true});this.postStatus('Posted');this.textarea.focus({preventScroll:true});}
      try{await this.refresh();await this.reload();await this.onCommitted({boardId:d.boardId,itemId:d.itemId,threadId:result.threadId||d.replyTo,kind:'comment'});}catch{this.postStatus('Posted. Refresh comments to see the latest conversation.');}
    }catch(error){if(this.draft===d)this.postStatus(error.message,true);throw error;}finally{d.pending=false;}
  }
  async resolve(threadId,resolved){try{await this.client.write('resolveComment',{threadId,resolved});await this.refresh();await this.reload();await this.onCommitted({boardId:this.getBoard().id,itemId:this.itemId,threadId,kind:'comment'});}catch(error){this.failure(error);}}
  async reload({more=false}={}){
    const request=++this.request,boardId=this.getBoard().id,itemId=this.visible?this.itemId:null,params=new URLSearchParams({boardId,includeBodies:'true',limit:'50'});
    if(itemId)params.set('itemId',itemId);if(this.onlyUnresolved)params.set('resolved','false');if(more&&this.nextCursor)params.set('cursor',this.nextCursor);
    const result=await this.client.get(`/api/feedback?${params}`);if(request!==this.request||boardId!==this.getBoard().id)return;this.client.revision=Math.max(this.client.revision,result.revision);this.threads=more?[...this.threads,...result.threads]:result.threads;this.nextCursor=result.nextCursor;this.loadedScope=`${boardId}/${itemId||'board'}`;this.status('');this.renderList();this.syncPins();
  }
  anchorLabel(t){return({point:t.anchor.relative?'Follows target':'Canvas point',matched:'Located',uncertain:'Source or context changed · review quote',stale:'Quote unlocated or ambiguous',detached:t.anchor.kind==='point'?'Target unavailable · original point':'Target unavailable',unverified:'Source unavailable or unsupported'})[t.anchorStatus]||'Source not checked';}
  renderList(){
    const list=this.panel.querySelector('.feedback-list'),history=this.panel.querySelector('.feedback-history'),scroll=history.scrollTop,active=document.activeElement,id=active?.closest('[data-feedback-thread]')?.dataset.feedbackThread,action=active?.dataset.feedbackReply?'data-feedback-reply':active?.dataset.feedbackResolve?'data-feedback-resolve':null;
    const html=this.threads.length?this.threads.map((t,i)=>`<article tabindex="-1" data-feedback-thread="${esc(t.id)}" class="feedback-thread ${t.resolved?'resolved':''}"><header><strong>${esc(t.author.label)}</strong><small>${new Date(t.createdAt).toLocaleDateString()}</small></header>${!this.itemId&&t.itemId?`<button type="button" class="feedback-context" data-feedback-item-scope="${esc(t.itemId)}">${esc(this.getBoard().items?.[t.itemId]?.title||'Item unavailable')}</button>`:''}${t.anchor?`<div class="feedback-anchor">${t.anchor.kind==='point'?`Point ${i+1}`:'Selected text'} · ${esc(this.anchorLabel(t))}${t.anchor.kind==='text'?`<q>${esc(t.anchor.quote)}</q>`:''}</div>`:''}<p class="feedback-body">${esc(t.body||t.excerpt)}</p>${(t.replies||[]).map(r=>`<div class="feedback-reply"><strong>${esc(r.author.label)}</strong><p class="feedback-body">${esc(r.body)}</p></div>`).join('')}<footer><button type="button" data-feedback-reply="${esc(t.id)}">Reply</button><button type="button" data-feedback-resolve="${esc(t.id)}" data-resolved="${t.resolved}">${t.resolved?'Reopen':'Resolve'}</button>${t.resolved?'<span>Resolved</span>':''}</footer></article>`).join(''):`<p class="feedback-empty">${this.onlyUnresolved?'No unresolved comments.':`Start the conversation about ${esc(this.getBoard().items?.[this.itemId]?.title||'this board')}.`}</p>`;
    this.panel.dataset.empty=String(this.threads.length===0);this.panel.dataset.short=String(!this.nextCursor&&list.scrollHeight<260);if(list.innerHTML!==html)list.innerHTML=html;this.queueSizing();this.panel.querySelector('[data-feedback-more]').hidden=!this.nextCursor;history.scrollTop=scroll;if(id&&action)list.querySelector(`[${action}="${CSS.escape(id)}"]`)?.focus({preventScroll:true});
  }
  focusThread(id){const el=[...this.panel.querySelectorAll('[data-feedback-thread]')].find(e=>e.dataset.feedbackThread===id);el?.focus({preventScroll:true});el?.scrollIntoView({block:'nearest'});}
  voteState(itemId){const votes=this.getBoard().items?.[itemId]?.review?.votes;return{mine:votes?.[this.actor.id]?.value||null,totals:voteTotals(votes),pending:this.voting.has(itemId)};}
  openVote({itemId,anchor,host,returnFocus}={}){
    this.closeVote({restoreFocus:false});if(this.visible)this.close({restoreFocus:false});if(!this.getBoard().items?.[itemId])return;
    this.ballotId=itemId;this.ballotFocus=null;this.ballotAnchor=anchor;anchor?.setAttribute('aria-expanded','true');this.ballotReturn=returnFocus||anchor;this.ballot=document.createElement('section');this.ballot.className='feedback-ballot';this.ballot.setAttribute('role','dialog');this.ballot.setAttribute('aria-label',`Vote on ${this.getBoard().items[itemId].title}`);(host||anchor?.closest('dialog[open]')||document.body).append(this.ballot);
    this.ballot.addEventListener('click',e=>{if(e.target.closest('[data-ballot-close]'))this.closeVote();const b=e.target.closest('[data-feedback-vote]');if(b)this.vote(itemId,b.dataset.feedbackVote==='clear'?null:b.dataset.feedbackVote).catch(()=>{});});
    this.renderBallot();this.positionBallot();this.ballot.querySelector('[data-feedback-vote]')?.focus({preventScroll:true});
  }
  renderBallot(){
    if(!this.ballot)return;const{mine,totals,pending}=this.voteState(this.ballotId),item=this.getBoard().items?.[this.ballotId],focused=document.activeElement?.dataset.feedbackVote;this.ballotFocus=focused||this.ballotFocus;
    this.ballot.innerHTML=`<header><strong>Vote</strong><button type="button" data-ballot-close aria-label="Close vote">×</button></header><p class="feedback-ballot-title">${esc(item?.title||'Item')}</p><div class="feedback-ballot-choices" role="group" aria-label="Your vote">${['yes','no','abstain'].map(v=>`<button type="button" data-feedback-vote="${v}" aria-pressed="${mine===v}" ${pending?'disabled':''}>${capital(v)}<span>${totals[v]}</span></button>`).join('')}</div><footer><span>As ${esc(this.actor.label)}</span><button type="button" data-feedback-vote="clear" ${!mine||pending?'disabled':''}>Clear vote</button></footer><p class="feedback-ballot-status" role="status">${esc(this.ballotMessage||'')}</p>`;
    if(!pending&&this.ballotFocus){const b=this.ballot.querySelector(`[data-feedback-vote="${this.ballotFocus}"]`);(b&&!b.disabled?b:this.ballot.querySelector('[data-ballot-close]'))?.focus({preventScroll:true});}
  }
  positionBallot(){
    if(!this.ballot)return;
    const rect=this.ballotAnchor?.getBoundingClientRect(),v=window.visualViewport,area=(this.ballotAnchor?.closest('dialog[open]')?.querySelector('.reader-area')||this.viewport)?.getBoundingClientRect();
    const left=Math.max(v?.offsetLeft||0,area?.left||0)+8,right=Math.min((v?.offsetLeft||0)+(v?.width||innerWidth),area?.right||innerWidth)-8;
    const top=Math.max(v?.offsetTop||0,area?.top||0)+8,bottom=Math.min((v?.offsetTop||0)+(v?.height||innerHeight),area?.bottom||innerHeight)-8;
    this.ballot.style.left='0px';this.ballot.style.top='0px';
    const zero=this.ballot.getBoundingClientRect(),scale=this.ballot.offsetWidth?zero.width/this.ballot.offsetWidth:1;
    const width=Math.min(300,(right-left)/scale);this.ballot.style.width=`${width}px`;this.ballot.style.maxHeight=`${Math.max(80,(bottom-top)/scale)}px`;
    const box=this.ballot.getBoundingClientRect(),height=box.height,desired=rect?(rect.bottom+height+8>bottom?rect.top-height-8:rect.bottom+8):top;
    const x=Math.max(left,Math.min(right-box.width,rect?.left||left)),y=Math.max(top,Math.min(bottom-height,desired));
    this.ballot.style.left=`${(x-zero.left)/scale}px`;this.ballot.style.top=`${(y-zero.top)/scale}px`;
  }
  closeVote({restoreFocus:restore=true}={}){if(!this.ballot)return;this.ballot.remove();this.ballot=null;this.ballotAnchor?.setAttribute('aria-expanded','false');this.ballotMessage='';if(restore)restoreFocus(this.ballotReturn);}
  async vote(itemId,value){
    if(this.voting.has(itemId)||this.voteState(itemId).mine===value)return;this.voting.add(itemId);this.ballotMessage='Saving vote…';this.renderBallot();this.syncVoteTriggers();
    try{await this.client.write('vote',{itemId,actor:{...this.actor},value});await this.refresh();this.ballotMessage='Vote saved';}catch(error){this.ballotMessage=error.message;throw error;}finally{this.voting.delete(itemId);this.renderBallot();this.syncVoteTriggers();this.positionBallot();this.onVotesChanged?.();}
  }
  syncVoteTriggers(){
    for(const b of document.querySelectorAll('[data-item-vote]')){const itemId=b.dataset.itemVote,item=this.getBoard().items?.[itemId];if(!item)continue;const{mine,totals,pending}=this.voteState(itemId),label=`Vote on ${item.title}${mine?`; your vote: ${mine}`:''}. Yes ${totals.yes}, No ${totals.no}, Abstain ${totals.abstain}`;b.setAttribute('aria-pressed',String(Boolean(mine)));b.setAttribute('aria-label',label);b.title=label;b.dataset.voteValue=mine||'';b.disabled=pending;const text=b.querySelector('[data-vote-summary]');if(text)text.textContent=mine?capital(mine):'Vote';}
  }
  async annotationAction(type,itemId,detail,options={}){
    const key=JSON.stringify({type,itemId,...detail});let action=this.annotationActions.get(key);if(action?.pending)return;
    action ||= {operationId:crypto.randomUUID(),payload:{itemId,...detail,...(type==='addHighlight'?{author:{...this.actor}}:{})}};action.pending=true;this.annotationActions.set(key,action);
    try{const result=await this.client.write(type,action.payload,{operationId:action.operationId});this.annotationActions.delete(key);await Promise.resolve(this.onCommitted({boardId:this.getBoard().id,itemId,kind:'highlight',...result})).catch(()=>{});options.onSuccess?.(result);return result;}catch(error){options.onError?.(error);throw error;}finally{action.pending=false;}
  }
  highlightOnText(itemId,anchor,options={}){return this.annotationAction('addHighlight',itemId,{anchor},options);}
  removeHighlight(itemId,highlightId,options={}){return this.annotationAction('removeHighlight',itemId,{highlightId},options);}
  syncPins(overrides){
    if(!this.layer||!this.world)return;this.layer.hidden=!this.pinsVisible||this.getMode()!=='canvas';if(this.layer.parentNode!==this.world)this.world.append(this.layer);const origin=this.getOrigin()||{x:0,y:0};
    this.layer.innerHTML=this.threads.map((t,i)=>{if(t.anchor?.kind!=='point')return '';const p=resolveCommentPoint(t.anchor,this.getBoard(),overrides);return`<button type="button" class="feedback-pin ${t.resolved?'resolved':''} ${p.detached?'detached':''}" data-feedback-pin="${esc(t.id)}" style="left:${p.x+origin.x}px;top:${p.y+origin.y}px" aria-label="Comment ${i+1}${p.detached?' · target unavailable; original point':''}: ${esc((t.body||t.excerpt||'').slice(0,80))}">${i+1}</button>`;}).join('');
    for(const pin of this.layer.querySelectorAll('[data-feedback-pin]'))pin.onclick=e=>{e.stopPropagation();this.open({itemId:this.itemId,threadId:pin.dataset.feedbackPin,returnFocus:pin});};
  }
  sync(overrides){this.syncPins(overrides);this.syncVoteTriggers();if(this.visible)this.renderScope();}
  destroy(){cancelAnimationFrame(this.sizingFrame);this.formBinding?.destroy();window.removeEventListener('click',this.clickHandler,true);window.removeEventListener('pointerdown',this.pointHandler,true);window.removeEventListener('pointerdown',this.outsideHandler,true);window.removeEventListener('keydown',this.keyHandler,true);window.removeEventListener('resize',this.repositionHandler);window.visualViewport?.removeEventListener('resize',this.repositionHandler);this.closeVote({restoreFocus:false});this.panel?.remove();this.layer?.remove();this.toggle?.remove();}
}
