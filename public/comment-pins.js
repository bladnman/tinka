// The board's Comment tool: C arms a comment cursor, a click drops a pin on empty
// canvas, a card or a drawn element, and pins show who wrote each thread and where
// it stands. The bottom bar holds the layer menu (show/hide, resolved, "Waiting on
// you") and "Send to agent", which marks open threads sent and copies a prompt.
// Thread cards (reading, replying, new threads) live in comment-thread.js.
import {pointAnchorAt, resolveCommentPoint, alongAnchorAt} from './feedback-geometry.js';
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
  // Arrow pins ride along the line: `along` is a fraction (0–1) of its drawn length;
  // x/y keep the last place for when the arrow is gone.
  arrowAnchor: ({decorationId, along, offset, x, y}) => ({kind:'decoration', decorationId, along, ...(offset ? {offset} : {}), x, y}),
  isAlong: a => a?.kind === 'decoration' && typeof a.along === 'number',
  pinned: t => t.anchor?.kind === 'point' || commentApi.isAlong(t.anchor),
  // Re-pin a thread onto something else (drag a pin onto a card, drawn element or arrow).
  repin: (client, threadId, anchor, targetLabel, actor) => client.write('repinComment', {threadId, anchor, ...(targetLabel ? {targetLabel} : {}), actor}),
  // Agents watching the inbox (inbox --watch): GET /api/agents, then `presence` stream events.
  async presence(client) { try { return await client.get('/api/agents'); } catch { return null; } },
  watching: presence => Array.isArray(presence?.watching) && presence.watching.length > 0,
};
// The most urgent status wins a crowded cluster's colour.
const URGENCY = {question:5, addressed:4, open:3, sent:2, working:1, resolved:0};
const CLUSTER_PX = 26;

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
      const cluster = e.target.closest('[data-comment-cluster]');
      if (cluster) { e.preventDefault();e.stopPropagation();this.openCluster(cluster);return; }
      const pin = e.target.closest('[data-comment-pin]');if (!pin) return;
      e.preventDefault();e.stopPropagation();
      if (this.draggedAt && Date.now() - this.draggedAt < 400) return;
      this.open(pin.dataset.commentPin, pin);
    });
    // Drag a pin onto a card, drawn element or arrow to re-pin it (a dashed one especially).
    this.layer.addEventListener('pointerdown', e => {
      const pin = e.target.closest('[data-comment-pin]');
      if (!pin || e.button !== 0 || this.armed || this.board.mode !== 'canvas') return;
      e.stopPropagation();
      this.pinDrag = {id:pin.dataset.commentPin, pin, pointerId:e.pointerId, x:e.clientX, y:e.clientY, moved:false};
    });
    window.addEventListener('pointermove', e => this.movePin(e), true);
    window.addEventListener('pointerup', e => this.dropPin(e), true);
    window.addEventListener('pointercancel', () => this.endPinDrag(), true);
    // Zoom changes the screen distance between pins, so clusters regroup.
    new MutationObserver(() => { cancelAnimationFrame(this.zoomFrame);this.zoomFrame = requestAnimationFrame(() => this.sync()); })
      .observe(this.viewport, {attributes:true, attributeFilter:['style']});
    // Panning moves the world: clusters near the canvas edge are re-placed inside it.
    new MutationObserver(() => { if (!this.layer.querySelector('.comment-cluster')) return;cancelAnimationFrame(this.panFrame);this.panFrame = requestAnimationFrame(() => this.sync()); })
      .observe(this.world, {attributes:true, attributeFilter:['style']});
    this.pollPresence();
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
  pinned() { return this.threads.filter(commentApi.pinned); }
  // Where a thread's pin sits now, in board units: the shared helper places point and arrow
  // anchors exactly as the server computes anchorPoint.
  point(t, overrides) { return resolveCommentPoint(t.anchor, this.snapshot, overrides); }
  waiting() { return this.threads.filter(t => ['addressed','question'].includes(this.status(t))); }
  unsent() { return this.threads.filter(t => this.status(t) === 'open' && !commentApi.isAgent(t) && commentApi.forAgent(t)); }
  // ---- pins
  sync(overrides) {
    if (!this.layer) return;
    if (this.layer.parentNode !== this.world) this.world.append(this.layer);
    this.layer.hidden = !this.visible || this.board.mode !== 'canvas';
    const origin = this.board.origin || {x:0, y:0}, zoom = this.board.hooks.zoom?.() || 1;
    const shown = this.pinned().filter(t => this.showResolved || this.status(t) !== 'resolved').map(t => ({t, p:this.point(t, overrides)}));
    // Pins closer than about 26 screen pixels merge into one cluster with a count.
    const groups = [];
    for (const entry of shown) {
      if (this.dragging?.id === entry.t.id) { groups.push([entry]);continue; }
      const near = groups.find(g => g[0].t.id !== this.dragging?.id && Math.hypot((g[0].p.x - entry.p.x) * zoom, (g[0].p.y - entry.p.y) * zoom) < CLUSTER_PX);
      near ? near.push(entry) : groups.push([entry]);
    }
    const html = groups.map(group => group.length === 1 ? this.pinMarkup(group[0].t, group[0].p, origin) : this.clusterMarkup(group, origin, zoom)).join('');
    if (this.layer.innerHTML !== html) this.layer.innerHTML = html;
  }
  pinMarkup(t, p, origin) {
    const status = this.status(t), agent = commentApi.isAgent(t);
    const who = agent ? 'Agent' : t.author?.label || 'Someone', label = commentApi.targetLabel(t);
    const gone = p.detached ? `<span class="comment-pin-gone">Was on ${esc(label || 'something')} · deleted</span>` : '';
    return `<button type="button" class="comment-pin${p.detached ? ' detached' : ''}${this.active === t.id ? ' active' : ''}${this.dragging?.id === t.id ? ' dragging' : ''}" data-comment-pin="${esc(t.id)}" data-status="${status}" data-author="${agent ? 'agent' : 'human'}" style="left:${p.x + origin.x}px;top:${p.y + origin.y}px" aria-label="${esc(`${who} · ${STATUS_LABEL[status] || status}${p.detached ? ` · was on ${label || 'something'}, deleted` : ''}: ${(t.body || t.excerpt || '').slice(0, 80)}`)}" title="${p.detached ? 'Drag onto a card, drawn element or arrow to re-pin' : 'Open · drag to move'}">${agent ? ICON.agent : esc((t.author?.label || '?').trim()[0]?.toUpperCase() || '?')}<span class="comment-pin-badge" aria-hidden="true"></span>${gone}</button>`;
  }
  clusterMarkup(group, origin, zoom) {
    const status = group.map(g => this.status(g.t)).sort((a, b) => URGENCY[b] - URGENCY[a])[0];
    let x = group.reduce((sum, g) => sum + g.p.x, 0) / group.length, y = group.reduce((sum, g) => sum + g.p.y, 0) / group.length;
    // A cluster whose spot is on screen stays wholly inside the canvas edge (its count is the
    // only way into those threads).
    const view = this.viewport?.getBoundingClientRect(), world = this.world.getBoundingClientRect(), margin = 22 / zoom;
    if (view?.width) {
      const left = (view.left - world.left) / zoom - origin.x, top = (view.top - world.top) / zoom - origin.y, right = left + view.width / zoom, bottom = top + view.height / zoom;
      if (x >= left && x <= right && y >= top && y <= bottom) { x = Math.min(Math.max(x, left + margin), right - margin);y = Math.min(Math.max(y, top + margin), bottom - margin); }
    }
    return `<button type="button" class="comment-pin comment-cluster" data-comment-cluster="${esc(group.map(g => g.t.id).join(' '))}" data-status="${status}" style="left:${x + origin.x}px;top:${y + origin.y}px" aria-haspopup="menu" aria-label="${group.length} comments here · ${STATUS_LABEL[status] || status}">${group.length}<span class="comment-pin-badge" aria-hidden="true"></span></button>`;
  }
  // A cluster opens a small list of its threads to pick from.
  openCluster(button) {
    this.closeMenu();
    const ids = button.dataset.commentCluster.split(' '), threads = ids.map(id => this.threads.find(t => t.id === id)).filter(Boolean);
    this.menu = document.createElement('div');this.menu.className = 'tk-menu comment-menu comment-cluster-menu';this.menu.setAttribute('role', 'menu');this.menu.setAttribute('aria-label', `${threads.length} comments here`);
    this.menu.innerHTML = `<h6 class="comment-menu-head">${threads.length} comments here</h6>` + threads.map(t => `<button type="button" role="menuitem" class="tk-mi comment-waiting" data-comment-pick="${esc(t.id)}" data-status="${this.status(t)}"><span class="comment-dot" aria-hidden="true"></span><span class="comment-waiting-text"><b>${esc(commentApi.isAgent(t) ? 'Agent' : t.author?.label || 'Someone')} · ${STATUS_LABEL[this.status(t)]}</b>${esc((t.body || t.excerpt || '').slice(0, 70))}</span></button>`).join('');
    document.body.append(this.menu);
    this.menu.addEventListener('click', e => { const pick = e.target.closest('[data-comment-pick]');if (!pick) return;this.closeMenu();this.open(pick.dataset.commentPick, button); });
    // Beside the pin (right, else left, else below or above it), clear of the bottom bar.
    Object.assign(this.menu.style, {position:'fixed', left:'0px', top:'0px'});// measure at its real (fixed) size
    const r = button.getBoundingClientRect(), w = this.menu.offsetWidth, h = this.menu.offsetHeight, gap = 8;
    const floor = Math.min(innerHeight, document.querySelector('.canvas-footer .zoom-pill')?.getBoundingClientRect().top ?? innerHeight) - gap, ceiling = (document.getElementById('viewport')?.getBoundingClientRect().top ?? 0) + gap;
    let left, top;
    if (r.right + gap + w <= innerWidth - gap) left = r.right + gap;
    else if (r.left - gap - w >= gap) left = r.left - gap - w;
    if (left !== undefined) top = Math.max(ceiling, Math.min(floor - h, r.top + r.height / 2 - h / 2));
    else {
      left = Math.max(gap, Math.min(innerWidth - w - gap, r.left + r.width / 2 - w / 2));
      top = r.bottom + gap + h <= floor ? r.bottom + gap : Math.max(ceiling, r.top - gap - h);
    }
    Object.assign(this.menu.style, {position:'fixed', left:`${left}px`, top:`${top}px`});
    this.menu.querySelector('button')?.focus({preventScroll:true});
  }
  setVisible(visible) {
    this.visible = visible;try { localStorage.setItem(this.key, visible ? 'shown' : 'hidden'); } catch {}
    this.sync();this.renderBar();if (this.menu) this.renderMenu();
  }
  toggleVisible() { this.setVisible(!this.visible);toast(this.visible ? 'Comments shown.' : 'Comments hidden. ⇧C shows them.'); }
  renderBar() {
    const layer = document.getElementById('comment-layer-toggle'), send = document.getElementById('comment-send');if (!layer) return;
    // The bar's comment controls appear once the board has comments (the palette's C makes the
    // first), or while an agent is watching, so the first comment is known to be picked up.
    const canvas = this.board.mode === 'canvas', watching = commentApi.watching(this.presence);
    layer.closest('.comment-bar').hidden = !canvas || !(this.threads.length || watching);layer.hidden = !this.threads.length;
    const waiting = this.waiting().length, open = this.threads.filter(t => this.status(t) !== 'resolved').length, count = layer.querySelector('.comment-count');
    count.hidden = !(waiting || open);count.textContent = String(waiting || open);count.classList.toggle('warn', !!waiting);
    layer.setAttribute('aria-label', waiting ? `Comments: ${waiting} waiting on you` : `Comments: ${open} open`);
    layer.setAttribute('aria-pressed', String(this.visible));
    for (const box of document.querySelectorAll('[data-feedback-pins]')) box.checked = this.visible;
    const unsent = this.unsent().length, badge = send.querySelector('.comment-count');
    // aria-disabled rather than disabled, so the watching tooltip still shows with nothing to send.
    badge.hidden = !unsent;badge.textContent = String(unsent);send.setAttribute('aria-disabled', String(!unsent));
    // Calm at rest: with nothing to send, Send is just its icon.
    send.classList.toggle('comment-send-idle', !unsent);
    send.classList.toggle('agent-watching', watching);
    send.title = watching ? 'Agent is watching: comments you send are picked up right away' : 'Send open comments to your agent';
    const label = unsent ? `Send ${unsent} open comment${unsent === 1 ? '' : 's'} to your agent` : 'Send to agent: nothing open to send';
    send.setAttribute('aria-label', watching ? `${label} · Agent is watching` : label);
  }
  // ---- the tool
  arm(on = !this.armed) {
    if (on && this.board.mode !== 'canvas') this.board.setMode('canvas');
    this.armed = on;this.viewport?.classList.toggle('comment-armed', on);
    this.board.syncEditTools?.();
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
      const kind = d.sticker ? 'Sticker' : d.type === 'line' ? 'Arrow' : d.type === 'text' ? 'Text' : d.container ? 'Container' : d.shape === 'rectangle' ? 'Sticky' : d.shape ? 'Shape' : 'Area';
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
  // The anchor for a pin dropped at a screen point: relative to a card or shape, along an arrow,
  // or a plain board point.
  anchorFor(clientX, clientY, hit) {
    const point = this.board.canvasPoint({x:clientX, y:clientY});
    const line = hit?.ref.decorationId && this.snapshot.decorations.find(d => d.id === hit.ref.decorationId && d.type === 'line');
    if (line) {
      const at = alongAnchorAt(point, line, this.snapshot);
      return commentApi.arrowAnchor({decorationId:line.id, along:Math.round(at.along * 10000) / 10000, offset:at.offset, x:point.x, y:point.y});
    }
    return pointAnchorAt(point, this.snapshot, hit ? hit.ref : {});
  }
  // What is under a screen point, looking past the pins themselves.
  targetAt(x, y) {
    const under = document.elementsFromPoint(x, y).find(el => !el.closest('.comment-pins,.comment-target-tag'));
    return under && this.viewport.contains(under) ? this.target({target:under}) : null;
  }
  movePin(e) {
    const drag = this.pinDrag;if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    if (!drag.moved) { drag.moved = true;this.dragging = {id:drag.id};this.sync();try { this.layer.setPointerCapture?.(e.pointerId); } catch {} }
    e.preventDefault();
    const pin = this.layer.querySelector(`[data-comment-pin="${CSS.escape(drag.id)}"]`), origin = this.board.origin || {x:0, y:0}, point = this.board.canvasPoint({x:e.clientX, y:e.clientY});
    if (pin) Object.assign(pin.style, {left:`${point.x + origin.x}px`, top:`${point.y + origin.y}px`});
    this.hover(null);const hit = this.targetAt(e.clientX, e.clientY);
    if (hit) this.hover({target:hit.element});
  }
  async dropPin(e) {
    const drag = this.pinDrag;if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) { this.pinDrag = null;return; }
    e.preventDefault();e.stopPropagation();this.draggedAt = Date.now();this.swallowClick = Date.now() + 400;
    const hit = this.targetAt(e.clientX, e.clientY), anchor = this.anchorFor(e.clientX, e.clientY, hit);
    this.endPinDrag();
    try { await commentApi.repin(this.client, drag.id, anchor, hit?.label, this.board.feedback?.actor);toast(hit ? `Pinned to ${hit.label}.` : 'Pin moved.'); }
    catch (error) { toast(`Could not move the pin. ${error.message}`); }
    await this.reload();
  }
  endPinDrag() { this.pinDrag = null;this.dragging = null;this.hover(null);this.sync(); }
  // "Agent is watching" on Send to agent, while an agent waits on the inbox.
  async pollPresence() {
    this.presence = await commentApi.presence(this.client);this.renderBar();
    if (!this.presenceListening) {
      this.presenceListening = true;
      window.addEventListener('tinka:presence', e => { this.presence = e.detail;this.renderBar(); });
    }
  }
  async drop(e) {
    if (!this.armed || e.button !== 0 || !this.viewport?.contains(e.target) || e.target.closest('.comment-pins,.workspace-tile-toolbar,.whiteboard-toolbar')) return;
    e.preventDefault();e.stopImmediatePropagation();this.swallowClick = Date.now() + 700;
    const hit = this.target(e), anchor = this.anchorFor(e.clientX, e.clientY, hit);
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
      const p = this.point(t);
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
    Object.assign(this.menu.style, {position:'fixed', left:'0px', top:'0px'});
    const anchor = document.getElementById('comment-layer-toggle')?.getBoundingClientRect();
    if (anchor) Object.assign(this.menu.style, {position:'fixed', left:`${Math.max(8, Math.min(innerWidth - this.menu.offsetWidth - 8, anchor.left))}px`, top:`${Math.max(8, anchor.top - this.menu.offsetHeight - 8)}px`});
  }
  closeMenu(focus = false) {
    this.menu?.remove();this.menu = null;
    const toggle = document.getElementById('comment-layer-toggle');toggle?.setAttribute('aria-expanded', 'false');if (focus) toggle?.focus({preventScroll:true});
  }
  // ---- Send to agent: mark open threads sent, then copy a prompt naming them.
  async sendToAgent() {
    const threads = this.unsent();if (!threads.length) { if (commentApi.watching(this.presence)) toast('Agent is watching: comments you send are picked up right away.');return; }
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
