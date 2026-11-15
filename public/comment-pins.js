// The board's Comment tool: C arms a comment cursor, a click drops a pin on empty
// canvas, a card or a drawn element, and pins show who wrote each thread and where
// it stands. The bottom bar holds the layer menu (show/hide, resolved, "Waiting on
// you") and "Send to agent", which marks open threads sent and copies a prompt.
// Thread cards (reading, replying, new threads) live in comment-thread.js.
import {pointAnchorAt, resolveCommentPoint} from './feedback-geometry.js';
import {toast, escape as esc} from './workspace.js';
import {decorationBounds} from './whiteboard-geometry.js';

// ---- API adapter (comment API, Tinka 1.1). Field and operation names live only here.
export const commentApi = {
  status: t => t.status || (t.resolved ? 'resolved' : 'open'),
  // A thread addressed to a person stays between people; unaddressed or agent ones can be sent.
  forAgent: t => !t.to || t.to.kind === 'agent',
  isAgent: t => t.author?.kind === 'agent',
  targetLabel: t => t.targetLabel || '',
  async list(client, boardId) {
    const threads = [];let cursor = null;
    do {
      const params = new URLSearchParams({boardId, includeBodies:'true', limit:'100'});
      if (cursor) params.set('cursor', cursor);
      const result = await client.get(`/api/feedback?${params}`);
      threads.push(...result.threads);cursor = result.nextCursor;
    } while (cursor && threads.length < 1000);
    return threads;
  },
  // "Send to agent" sets status sent and addresses the thread to the agent.
  send: (client, threadId, actor) => client.write('setCommentStatus', {threadId, actor, status:'sent', to:{kind:'agent'}}),
};

export const STATUS_LABEL = {open:'Open', sent:'Sent to agent', working:'Agent working', addressed:'Addressed · check it', question:'Agent asks you', resolved:'Resolved'};
const ICON = {
  comment:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 14.5H8l-4 3v-3A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z"/><path d="M6 8.5h8M6 11h5"/></svg>',
  send:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M17 3 9 11M17 3l-5 14-3-6-6-3z"/></svg>',
  agent:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5 11.4 8.6 16.5 10l-5.1 1.4L10 16.5l-1.4-5.1L3.5 10l5.1-1.4z"/></svg>',
};
export const COMMENT_ICON = ICON.comment;

// Thread cards come from comment-thread.js; until it is present, the Comments panel stands in.
let threadModule;
const threadCards = () => threadModule ||= import('./comment-thread.js').catch(() => null);

export class CommentPins {
  constructor(board) {
    this.board = board;this.threads = [];this.armed = false;this.showResolved = false;
    this.key = `tinka/${board.config.workspaceId}/comment-pins`;
    try { this.visible = localStorage.getItem(this.key) !== 'hidden'; } catch { this.visible = true; }
  }
  get client() { return this.board.client; }
  get snapshot() { return this.board.snapshot; }
  mount() {
    this.world = document.getElementById('world');this.viewport = document.getElementById('viewport');
    this.layer = document.createElement('div');this.layer.className = 'comment-pins';this.layer.setAttribute('aria-label', 'Comments');
    this.world.append(this.layer);
    // feedback.js stops drawing its numbered canvas pins once this layer exists.
    this.board.feedback?.syncPins?.();
    const pill = document.querySelector('.canvas-footer .zoom-pill');
    if (pill && !document.getElementById('comment-layer-toggle')) {
      const group = document.createElement('span');group.className = 'comment-bar';
      group.innerHTML = `<button type="button" id="comment-layer-toggle" class="tk-btn comment-layer" aria-haspopup="menu" aria-expanded="false" aria-label="Comments" title="Comments (⇧C)">${ICON.comment}<span class="comment-count" hidden></span></button><button type="button" id="comment-send" class="tk-btn comment-send" aria-label="Send to agent" title="Send open comments to your agent">${ICON.send}<span class="comment-send-label">Send to agent</span><span class="comment-count" hidden></span></button><span class="tk-divider" aria-hidden="true"></span>`;
      pill.prepend(group);
      group.querySelector('#comment-layer-toggle').onclick = e => { e.stopPropagation();this.menu ? this.closeMenu() : this.openMenu(); };
      group.querySelector('#comment-send').onclick = () => this.sendToAgent();
    }
    this.layer.addEventListener('click', e => {
      const pin = e.target.closest('[data-comment-pin]');if (!pin) return;
      e.preventDefault();e.stopPropagation();this.open(pin.dataset.commentPin, pin);
    });
    // Armed: hover lights the target; a click drops the pin there.
    window.addEventListener('pointermove', e => { if (this.armed) this.hover(e); }, true);
    window.addEventListener('pointerdown', e => this.drop(e), true);
    // The Comments panel's "Show pins" option shows or hides this layer (its old pins are off).
    document.addEventListener('change', e => { if (e.target.matches?.('[data-feedback-pins]')) this.setVisible(e.target.checked); }, true);
    window.addEventListener('hashchange', () => { if (/^#comments\//.test(location.hash)) this.reload().then(() => this.openLinked()); });
    window.addEventListener('click', e => { if (this.swallowClick && Date.now() < this.swallowClick) { e.preventDefault();e.stopImmediatePropagation();this.swallowClick = 0; } }, true);
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (this.menu) { e.preventDefault();e.stopImmediatePropagation();this.closeMenu(true); }
      else if (this.armed) { e.preventDefault();e.stopImmediatePropagation();this.arm(false); }
    }, true);
    document.addEventListener('pointerdown', e => { if (this.menu && !this.menu.contains(e.target) && !e.target.closest('#comment-layer-toggle')) this.closeMenu(); }, true);
    this.sync();this.renderBar();
  }
  // ---- data
  async reload() {
    const boardId = this.snapshot.id;
    try { const threads = await commentApi.list(this.client, boardId);if (boardId !== this.snapshot.id) return;this.threads = threads; }
    catch (error) { console.warn('Comments unavailable:', error.message); }
    this.sync();this.renderBar();if (this.menu) this.renderMenu();
    if (!this.linkHandled) { this.linkHandled = true;this.openLinked(); }
  }
  // A thread link (…/boards/BOARD/#comments/ID, from the inbox and the agent prompt) pans to
  // its pin and opens its card, on first load and whenever the hash changes.
  openLinked() {
    const id = /^#comments\/(.+)$/.exec(location.hash)?.[1];
    if (!id) return;
    const threadId = decodeURIComponent(id);
    if (this.threads.some(t => t.id === threadId)) this.reveal(threadId);
    else toast('That comment is not on this board, or it was deleted.');
  }
  status(t) { return commentApi.status(t); }
  pinned() { return this.threads.filter(t => t.anchor?.kind === 'point'); }
  waiting() { return this.threads.filter(t => ['addressed','question'].includes(this.status(t))); }
  unsent() { return this.threads.filter(t => this.status(t) === 'open' && !commentApi.isAgent(t) && commentApi.forAgent(t)); }
  // ---- pins
  sync(overrides) {
    if (!this.layer) return;
    if (this.layer.parentNode !== this.world) this.world.append(this.layer);
    this.layer.hidden = !this.visible || this.board.mode !== 'canvas';
    const origin = this.board.origin || {x:0, y:0};
    const html = this.pinned().filter(t => this.showResolved || this.status(t) !== 'resolved').map(t => {
      const p = resolveCommentPoint(t.anchor, this.snapshot, overrides), status = this.status(t), agent = commentApi.isAgent(t);
      const who = agent ? 'Agent' : t.author?.label || 'Someone', label = commentApi.targetLabel(t);
      const gone = p.detached ? `<span class="comment-pin-gone">Was on ${esc(label || 'something')} · deleted</span>` : '';
      return `<button type="button" class="comment-pin${p.detached ? ' detached' : ''}${this.active === t.id ? ' active' : ''}" data-comment-pin="${esc(t.id)}" data-status="${status}" data-author="${agent ? 'agent' : 'human'}" style="left:${p.x + origin.x}px;top:${p.y + origin.y}px" aria-label="${esc(`${who} · ${STATUS_LABEL[status] || status}${p.detached ? ` · was on ${label || 'something'}, deleted` : ''}: ${(t.body || t.excerpt || '').slice(0, 80)}`)}">${agent ? ICON.agent : esc((t.author?.label || '?').trim()[0]?.toUpperCase() || '?')}<span class="comment-pin-badge" aria-hidden="true"></span>${gone}</button>`;
    }).join('');
    if (this.layer.innerHTML !== html) this.layer.innerHTML = html;
  }
  setVisible(visible) {
    this.visible = visible;try { localStorage.setItem(this.key, visible ? 'shown' : 'hidden'); } catch {}
    this.sync();this.renderBar();if (this.menu) this.renderMenu();
  }
  toggleVisible() { this.setVisible(!this.visible);toast(this.visible ? 'Comments shown.' : 'Comments hidden. ⇧C shows them.'); }
  renderBar() {
    const layer = document.getElementById('comment-layer-toggle'), send = document.getElementById('comment-send');if (!layer) return;
    // The bar's comment controls appear once the board has comments (the palette's C makes the first).
    const canvas = this.board.mode === 'canvas';layer.closest('.comment-bar').hidden = !canvas || !this.threads.length;
    const waiting = this.waiting().length, open = this.threads.filter(t => this.status(t) !== 'resolved').length, count = layer.querySelector('.comment-count');
    count.hidden = !(waiting || open);count.textContent = String(waiting || open);count.classList.toggle('warn', !!waiting);
    layer.setAttribute('aria-label', waiting ? `Comments: ${waiting} waiting on you` : `Comments: ${open} open`);
    layer.setAttribute('aria-pressed', String(this.visible));
    for (const box of document.querySelectorAll('[data-feedback-pins]')) box.checked = this.visible;
    const unsent = this.unsent().length, badge = send.querySelector('.comment-count');
    badge.hidden = !unsent;badge.textContent = String(unsent);send.disabled = !unsent;
    // Calm at rest: with nothing to send, Send is just its icon.
    send.classList.toggle('comment-send-idle', !unsent);
    send.setAttribute('aria-label', unsent ? `Send ${unsent} open comment${unsent === 1 ? '' : 's'} to your agent` : 'Send to agent: nothing open to send');
  }
  // ---- the tool
  arm(on = !this.armed) {
    if (on && this.board.mode !== 'canvas') this.board.setMode('canvas');
    this.armed = on;this.viewport?.classList.toggle('comment-armed', on);
    document.querySelector('[data-edit-tool="comment"]')?.setAttribute('aria-pressed', String(on));
    if (!on) this.hover(null);
    else toast('Click the board, a card or a drawn element to comment. Escape cancels.');
  }
  target(e) {
    const card = e.target.closest?.('#world .workspace-card[data-placement]'), drawn = e.target.closest?.('#world [data-decoration]');
    if (card) {
      const placement = this.snapshot.placements.find(p => p.id === card.dataset.placement), item = this.snapshot.items[placement?.itemId];
      return placement && {element:card, ref:{placementId:placement.id}, itemId:item?.id, label:item?.title || 'Item'};
    }
    if (drawn) {
      const d = (this.snapshot.decorations || []).find(d => d.id === drawn.dataset.decoration);if (!d) return null;
      const kind = d.type === 'line' ? 'Arrow' : d.type === 'text' ? 'Text' : d.shape === 'rectangle' && /f6e6a4/i.test(d.color || '') ? 'Sticky' : d.shape ? 'Shape' : 'Area';
      const words = String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return {element:drawn, ref:{decorationId:d.id}, label:words ? `${kind} · ${words}` : kind};
    }
    return null;
  }
  hover(e) {
    const hit = e && this.viewport?.contains(e.target) ? this.target(e) : null;
    if (this.hovered && this.hovered !== hit?.element) this.hovered.classList.remove('comment-target');
    this.hovered = hit?.element || null;this.hovered?.classList.add('comment-target');
    if (!hit) { this.tag?.remove();this.tag = null;return; }
    this.tag ||= Object.assign(document.createElement('div'), {className:'comment-target-tag'});
    if (!this.tag.isConnected) document.body.append(this.tag);
    this.tag.textContent = `On ${hit.label}`;
    const r = hit.element.getBoundingClientRect();
    Object.assign(this.tag.style, {left:`${Math.min(innerWidth - this.tag.offsetWidth - 8, Math.max(8, r.right - this.tag.offsetWidth))}px`, top:`${Math.max(8, Math.min(innerHeight - 40, r.bottom + 6))}px`});
  }
  async drop(e) {
    if (!this.armed || e.button !== 0 || !this.viewport?.contains(e.target) || e.target.closest('.comment-pins,.workspace-tile-toolbar,.whiteboard-toolbar')) return;
    e.preventDefault();e.stopImmediatePropagation();this.swallowClick = Date.now() + 700;
    const hit = this.target(e), point = this.board.canvasPoint({x:e.clientX, y:e.clientY});
    // Arrows follow by position for now: a box anchor is meaningless along a diagonal path.
    const arrow = hit?.ref.decorationId && this.snapshot.decorations.find(d => d.id === hit.ref.decorationId)?.type === 'line';
    const anchor = pointAnchorAt(point, this.snapshot, hit && !arrow ? hit.ref : {});
    this.arm(false);
    // The arming hint has done its job once the composer opens.
    const hint = document.getElementById('workspace-toast');if (hint && /^Click the board, a card/.test(hint.textContent)) hint.hidden = true;
    const rect = {left:e.clientX, top:e.clientY, right:e.clientX, bottom:e.clientY, width:0, height:0};
    const cards = await threadCards();
    try {
      if (cards?.createThread) { const id = await cards.createThread(this.board, anchor, rect, {itemId:hit?.itemId, targetLabel:hit?.label});if (id) await this.reload(); }
      else this.board.feedback?.compose({itemId:hit?.itemId, anchor});
    } catch (error) { toast(error.message); }
  }
  async open(threadId, pin) {
    this.active = threadId;this.sync();
    const cards = await threadCards(), rect = pin?.getBoundingClientRect?.() || this.pinRect(threadId);
    if (cards?.openThreadCard) cards.openThreadCard(this.board, threadId, rect);
    else this.board.feedback?.open({threadId, returnFocus:pin});
  }
  pinRect(threadId) { return this.layer?.querySelector(`[data-comment-pin="${CSS.escape(threadId)}"]`)?.getBoundingClientRect() || null; }
  // Pans so the thread's pin is in view, then opens it.
  async reveal(threadId) {
    const t = this.threads.find(t => t.id === threadId);if (!t) return;
    if (!this.visible) this.setVisible(true);
    if (this.status(t) === 'resolved' && !this.showResolved) { this.showResolved = true;this.sync(); }
    if (t.anchor?.kind === 'point') {
      const p = resolveCommentPoint(t.anchor, this.snapshot);
      this.board.hooks.revealPlacements?.([{id:`comment-${t.id}`, x:p.x - 60, y:p.y - 80, width:120, height:120}]);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return this.open(threadId, this.layer?.querySelector(`[data-comment-pin="${CSS.escape(threadId)}"]`));
  }
  // ---- layer menu and "Waiting on you"
  openMenu() {
    this.menu = document.createElement('div');this.menu.className = 'tk-menu comment-menu';this.menu.setAttribute('role', 'menu');this.menu.setAttribute('aria-label', 'Comments');
    document.body.append(this.menu);document.getElementById('comment-layer-toggle')?.setAttribute('aria-expanded', 'true');
    this.menu.addEventListener('change', e => {
      if (e.target.dataset.commentOption === 'visible') this.setVisible(e.target.checked);
      if (e.target.dataset.commentOption === 'resolved') { this.showResolved = e.target.checked;this.sync(); }
    });
    this.menu.addEventListener('click', e => {
      const item = e.target.closest('[data-comment-waiting]');if (!item) return;
      this.closeMenu();this.reveal(item.dataset.commentWaiting);
    });
    this.renderMenu();this.menu.querySelector('input,button')?.focus({preventScroll:true});
  }
  renderMenu() {
    const waiting = this.waiting();
    this.menu.innerHTML = `<h6 class="comment-menu-head">Comments</h6><label class="tk-mi"><input type="checkbox" data-comment-option="visible" ${this.visible ? 'checked' : ''}> Show comments <kbd class="tk-kbd" aria-hidden="true">⇧C</kbd></label><label class="tk-mi"><input type="checkbox" data-comment-option="resolved" ${this.showResolved ? 'checked' : ''}> Show resolved</label><h6 class="comment-menu-head">Waiting on you</h6>${waiting.length ? waiting.map(t => `<button type="button" role="menuitem" class="tk-mi comment-waiting" data-comment-waiting="${esc(t.id)}" data-status="${this.status(t)}"><span class="comment-dot" aria-hidden="true"></span><span class="comment-waiting-text"><b>${STATUS_LABEL[this.status(t)]}</b>${esc(commentApi.targetLabel(t) || (t.body || t.excerpt || '').slice(0, 60))}</span></button>`).join('') : '<p class="comment-menu-empty">Nothing right now.</p>'}`;
    const anchor = document.getElementById('comment-layer-toggle')?.getBoundingClientRect();
    if (anchor) Object.assign(this.menu.style, {position:'fixed', left:`${Math.max(8, Math.min(innerWidth - this.menu.offsetWidth - 8, anchor.left))}px`, top:`${Math.max(8, anchor.top - this.menu.offsetHeight - 8)}px`});
  }
  closeMenu(focus = false) {
    this.menu?.remove();this.menu = null;
    const toggle = document.getElementById('comment-layer-toggle');toggle?.setAttribute('aria-expanded', 'false');if (focus) toggle?.focus({preventScroll:true});
  }
  // ---- Send to agent: mark open threads sent, then copy a prompt naming them.
  async sendToAgent() {
    const threads = this.unsent();if (!threads.length) return;
    const actor = this.board.feedback?.actor;
    const prompt = commentPrompt(this.board.config, this.snapshot, threads);
    let copied = false;
    try { await navigator.clipboard.writeText(prompt);copied = true; } catch {}
    let marked = 0;
    for (const t of threads) { try { await commentApi.send(this.client, t.id, actor);marked++; } catch (error) { toast(`Could not mark a comment sent. ${error.message}`); } }
    await this.reload();
    if (copied) toast('Copied: paste into your agent');
    else showPromptFallback(prompt, marked);
  }
}

/** The prompt that hands open comment threads to an agent: one line to paste, then the thread links. */
export function commentPrompt(config, board, threads) {
  const base = new URL(`boards/${encodeURIComponent(board.id)}/`, config.url || location.origin + '/').href;
  const n = threads.length, them = n === 1 ? 'it' : 'each';
  const line = `Handle my ${n} Tinka comment${n === 1 ? '' : 's'} on the board “${board.title}”: run \`node tinka/app/cli.mjs inbox --config tinka/local/config.json\`, make the change, reply on ${n === 1 ? 'the thread' : 'each thread'} saying what you changed, and mark ${them} addressed. Never resolve a thread; I check and resolve.`;
  const links = threads.map(t => `- ${base}#comments/${encodeURIComponent(t.id)} · ${(t.body || t.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`).join('\n');
  return `${line}\n${links}`;
}

function showPromptFallback(prompt, marked) {
  const dialog = document.createElement('dialog');dialog.className = 'workspace-dialog comment-prompt';
  dialog.innerHTML = `<form method="dialog"><h2>Send to your agent</h2><p>Marked ${marked} comment${marked === 1 ? '' : 's'} sent. Copy this prompt into your agent.</p><textarea readonly rows="10">${esc(prompt)}</textarea><button class="workspace-primary">Done</button></form>`;
  document.body.append(dialog);dialog.addEventListener('close', () => dialog.remove());dialog.showModal();
  const area = dialog.querySelector('textarea');area.focus();area.select();
}

/** Where a ref sits on this board, in board units, or null. */
export function refBox(board, ref) {
  if (!ref) return null;
  const live = p => p && !p.removedAt && !p.deletedAt;
  if (ref.kind === 'placement') { const p = board.placements.find(p => p.id === ref.id && live(p));return p && {placement:p, x:p.x, y:p.y, width:p.width, height:p.height}; }
  if (ref.kind === 'item') { const p = board.placements.find(p => p.itemId === ref.id && live(p));return p && {placement:p, x:p.x, y:p.y, width:p.width, height:p.height}; }
  if (ref.kind === 'decoration') { const d = (board.decorations || []).find(d => d.id === ref.id);return d && {decoration:d, ...decorationBounds(d, board)}; }
  if (ref.kind === 'board') { const owner = Object.values(board.items || {}).find(i => i.childBoardId === ref.id), p = owner && board.placements.find(p => p.itemId === owner.id && live(p));return p && {placement:p, x:p.x, y:p.y, width:p.width, height:p.height}; }
  return null;
}
