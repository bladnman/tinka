import {ProjectNavigator} from './navigator.js';
import {mountAppearance} from './appearance.js';
mountAppearance(document.querySelector('.masthead-tools'), { control: 'select' });
import {watchChanges} from './live.js';
import { openRemovalPrompt, openCoverPrompt } from './agent-prompt.js';
import { WorkspaceHome, homeView, sortHomeBoards, matchesHome, boardInfo, legacyCounts, FALLBACK_ART } from './workspace-home.js';
import { startLiveDates, installDateTooltip } from './relative-dates.js';
const $=id=>document.getElementById(id);
let graphHome=null;
let config={},lastRevision=null,lastBoards=[],shellRevision=null,reloadPending=false;
const fallbackArtwork=FALLBACK_ART;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fileURL(id,value){const pieces=String(value||'').split('/');if(!value||pieces.some(p=>p==='..'||p.startsWith('.'))||String(value).startsWith('/')||String(value).includes('://'))return null;return `/boards/${encodeURIComponent(id)}/files/${pieces.map(encodeURIComponent).join('/')}`;}
const SORT_LABELS={created:'newest first',updated:'recently edited first',az:'A to Z'};
homeView.count=(shown,total)=>{
 $('board-count').textContent=homeView.query.trim()&&shown!==total?`${shown} of ${total} boards`:`${total} ${total===1?'board':'boards'}`;
 $('sort-label').textContent=SORT_LABELS[homeView.sort];
};
function renderBoards(boards){
 lastBoards=boards;
 const shown=sortHomeBoards(boards.filter(b=>matchesHome([b.title,b.description])));
 homeView.count(shown.length,boards.length);
 const query=homeView.query.trim();
 $('board-grid').innerHTML=shown.map(b=>{const cover=fileURL(b.id,b.cover);return `<article class="board-card"><a class="board-link" href="/boards/${encodeURIComponent(b.id)}/"><div class="board-art" aria-hidden="true">${cover?`<img src="${escape(cover)}" alt="" loading="lazy">`:fallbackArtwork}</div>${boardInfo(b,{description:b.description||'A place to try things and see what happens.',counts:[...legacyCounts(b),...(b.roundCount?[`${Number(b.roundCount)} ${Number(b.roundCount)===1?'exploration':'explorations'}`]:[])]})}</a><div class="board-actions"><button type="button" class="tk-btn tk-sm" data-cover-board="${escape(b.id)}" aria-label="Change cover for ${escape(b.title)}">Change cover…</button><button class="remove-action remove-board tk-btn tk-sm" type="button" data-remove-board="${escape(b.id)}" aria-label="Remove ${escape(b.title)} board" title="Get a removal prompt">Remove…</button></div></article>`;}).join('')+(query&&!shown.length?`<p class="board-none">No boards match “${escape(query)}”.</p>`:'')+(query?'':'<button class="new-board empty-card" type="button"><span class="plus" aria-hidden="true">+</span><strong>New board</strong><small>Make a place for the next idea.<br>Your agent can take it from here.</small></button>');
 $('shelf-status').textContent=`${boards.length} ${boards.length===1?'board':'boards'} · Updates appear automatically`;
}
function rerender(){if(graphHome?.active)graphHome.render();else if(lastRevision!==null)renderBoards(lastBoards);}
async function refresh(){try{const response=await fetch('/api/boards',{cache:'no-store'});if(!response.ok)throw new Error('The board folder is unavailable.');const data=await response.json();if(shellRevision&&data.shellRevision&&shellRevision!==data.shellRevision)reloadPending=true;shellRevision=data.shellRevision||shellRevision;if(reloadPending&&!document.querySelector('dialog[open]')){location.reload();return;}const fingerprint=data.revision||JSON.stringify(data.boards);if(lastRevision!==fingerprint){renderBoards(data.boards||[]);lastRevision=fingerprint;}$('error').hidden=!data.errors?.length;if(data.errors?.length)$('error').textContent='Some boards could not be read. Your agent can check their board files.';$('connection').textContent='Live on this Mac';document.querySelector('.live').classList.remove('offline');}catch(error){$('connection').textContent='Reconnecting';document.querySelector('.live').classList.add('offline');if(lastRevision===null){$('error').textContent='Could not load your boards. Check that the local server is running.';$('error').hidden=false;}}}
function updatePrompt(){
 const name=$('board-name').value.trim()||'Untitled exploration';const brief=$('board-brief').value.trim()||'Help me explore this idea. Propose a few distinct directions, then build working experiments I can compare.';
 $('agent-prompt').value=`Create a new Tinka board named “${name}” in my existing local workspace. No skill is required.\n\nProject: ${config.projectLabel}\nURL: ${config.url}\nApp: ${config.appPath||"(read project instructions or appPath in the config’s adjacent .pid.json)"}\nAgent instructions: ${config.agentGuidePath||"(read docs/AGENT.md if present, otherwise README, in that app)"}\nProtocol: ${config.protocolPath||"(read docs/PROTOCOL.md in that app)"}\nConfiguration: ${config.configPath||'(use this workspace’s external config)'}\nBoards folder: ${config.boardsRoot||'(use the configured boards folder)'}\n\n${brief}\n\nRead the supplied agent instructions and protocol paths, plus the project’s TINKA.md if present. Register the experiment slots first so I can see the work taking shape. Keep each experiment portable: no dependency on the board app, its own run instructions, and a handoff explaining what is real, simulated, and ready to carry into the target product. Create only the requested board and experiments. Do not add a reference board, workspace guide or starter experiment unless I explicitly request one. Make the important work visible on the board at a useful size. For a nested round, choose representative work and show it on the parent where useful, following the installed agent guide and protocol. Use honest previews and retain prior work. Preserve existing boards and notes.`;
 $('copy-status').textContent='Your board appears here once your agent creates it.';$('copy-prompt').textContent='Copy prompt ↗';
}
document.addEventListener('click',e=>{if(graphHome?.active&&e.target.closest('.new-board')){graphHome.create();return;}const cover=e.target.closest('[data-cover-board]');if(cover&&config.workspaceId){const board=lastBoards.find(item=>item.id===cover.dataset.coverBoard);if(board)openCoverPrompt(config,board);}const remove=e.target.closest('[data-remove-board]');if(remove&&config.workspaceId){const board=lastBoards.find(item=>item.id===remove.dataset.removeBoard);if(board)openRemovalPrompt(config,board);}if(e.target.closest('.new-board')){updatePrompt();$('new-dialog').showModal();$('board-name').focus();}});
$('board-name').addEventListener('input',updatePrompt);$('board-brief').addEventListener('input',updatePrompt);
$('copy-prompt').onclick=async()=>{try{await navigator.clipboard.writeText($('agent-prompt').value);$('copy-status').textContent='Copied. Paste it into your agent conversation.';$('copy-prompt').textContent='Copied ✓';}catch{$('agent-prompt').focus();$('agent-prompt').select();$('copy-status').textContent='Select and copy this prompt, then paste it into your agent conversation.';}};
document.addEventListener('error',event=>{if(event.target.matches?.('.board-art img'))event.target.outerHTML=fallbackArtwork;},true);
let homeDirty=false,homeRunning=false;
async function drainHome(){if(!homeDirty||homeRunning||document.querySelector('dialog[open]'))return;homeRunning=true;try{while(homeDirty){homeDirty=false;await refresh();}}finally{homeRunning=false;}}
document.addEventListener('close',()=>drainHome(),true);
// Find and sort. Sort persists per workspace; the find text is for this visit only.
const find=$('home-find'),sortGroup=document.querySelector('.home-sort');
const sortKey=()=>config.workspaceId?`tinka/${config.workspaceId}/home-sort`:null;
function setSort(value,{save=true}={}){
 if(!SORT_LABELS[value])value='created';
 homeView.sort=value;
 for(const button of sortGroup.querySelectorAll('[data-sort]'))button.setAttribute('aria-pressed',String(button.dataset.sort===value));
 if(save&&sortKey())try{localStorage.setItem(sortKey(),value);}catch{}
}
sortGroup.addEventListener('click',e=>{const button=e.target.closest('[data-sort]');if(!button||button.dataset.sort===homeView.sort)return;setSort(button.dataset.sort);rerender();});
find.addEventListener('input',()=>{homeView.query=find.value;rerender();});
find.addEventListener('keydown',e=>{if(e.key!=='Escape')return;e.preventDefault();if(find.value){find.value='';homeView.query='';rerender();}else find.blur();});
const typing=el=>el?.closest?.('input,textarea,select,[contenteditable=""],[contenteditable="true"]');
document.addEventListener('keydown',e=>{if(e.key!=='/'||e.metaKey||e.ctrlKey||e.altKey||e.defaultPrevented||typing(e.target)||document.querySelector('dialog[open]'))return;e.preventDefault();find.focus();find.select();});
try{const r=await fetch('/api/config');if(r.ok){config=await r.json();$('workspace-name').textContent=`Tinka / ${config.projectLabel}`;document.title=`Tinka / ${config.projectLabel}`;$('project-label').textContent=config.projectLabel;}}catch{}
try{setSort(sortKey()&&localStorage.getItem(sortKey())||'created',{save:false});}catch{setSort('created',{save:false});}
if(config.workspaceId)new ProjectNavigator(config).mount(document.querySelector('.masthead .brand'));
installDateTooltip();startLiveDates(document);
try{graphHome=new WorkspaceHome(config);if(!await graphHome.init())await refresh();}catch{await refresh();}

if(!graphHome?.active)watchChanges(config,{onChange:()=>{homeDirty=true;return drainHome();},onConnection:connected=>{$('connection').textContent=connected?'Live on this Mac':'Reconnecting';document.querySelector('.live').classList.toggle('offline',!connected);}});
