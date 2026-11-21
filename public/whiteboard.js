import {bindForm, restoreFocus, commitShortcutLabel} from './interaction.js';
import {escape as esc, makeDialog, showFailure, toast} from './workspace.js';
import {arrowBendAt, arrowWeights, boldArrowCaps, defaultArrowBend, resolveEndpoint, resolveLine, decorationBounds, linePath, targetBox, MAX_ARROW_THICKNESS} from './whiteboard-geometry.js';
import {formatToHTMLString, toggleDecorationTask} from './deco-format.js';
import {formatTextSelection, textFormatControls} from './deco-editor.js';
import {textStyleVariables, mountTextAppearance} from './text-appearance.js';
import {drawingColor, isDrawingColor, isPaletteColor} from './drawing-palette.js';
import {appearanceThemes, compositeColor, luminance, readableColor, renderDrawingColor, surfaceInk, themePaper, unpackColor} from './theme-colors.js';
import {boardSurfaces, lineSurfacePoints, regionPaper, surfacePoints} from './board-paint.js';
import {bindDrawingPalette,colorDot,paletteMarkup} from './color-control.js';
import {syncTextInkPreview} from './text-ink-preview.js';
import {placeWhiteboardPopover} from './whiteboard-popover.js';
import {stackRank} from './stacking.js';
import {snapBox, snapDisabled} from './snap-guides.js';
import {isMacPlatform} from './reader-keys.js';
import {canContain,containerDropLabel,containerFor,containerPlacementIds,expandContainerSelection,previewContainerMove,previewContainerLayout} from './containers.js';
import {containerLayouts,mountContainerLayout} from './container-layout.js';
import {mountPresetScrub} from './preset-scrub.js';

const sides = ['top', 'right', 'bottom', 'left'];
const shapeNames = {rectangle:'Sticky note', rounded:'Process', diamond:'Decision', ellipse:'Start / end'};
const selector = id => `[data-decoration="${CSS.escape(id)}"]`;
const authoredColor = value => isDrawingColor(value) ? value : '#78866c';
function drawingStyles(drawing, color, backdrop) {
  const line = drawing.type === 'line';
  return appearanceThemes.map(theme => {
    const backing = backdrop(theme);
    const rawStroke = renderDrawingColor(color, 'stroke', theme);
    if (line) {
      const stroke = readableColor(rawStroke, backing, 3);
      const halo = luminance(unpackColor(stroke.color)[0]) < .18 ? '#ffffff' : '#000000';
      return `--decoration-color-${theme}:${stroke.color};${stroke.meetsContrast ? '' : `--line-halo-${theme}:${halo};`}`;
    }
    const {fill, opacity} = regionPaper(drawing, theme);
    const surfaces = backing.map(base => compositeColor(fill, base, opacity));
    const stroke = readableColor(rawStroke, [...surfaces, ...backing], 3).color;
    const ink = readableColor(surfaceInk(surfaces[0], theme), surfaces, 4.5).color;
    const dark = luminance(unpackColor(ink)[0]) < .18;
    const label = compositeColor(themePaper[theme], surfaces[0], .82);
    return `--decoration-color-${theme}:${fill};--decoration-opacity-${theme}:${opacity * 100}%;--decoration-stroke-${theme}:${stroke};--decoration-ink-${theme}:${ink};--decoration-region-label-${theme}:${surfaceInk(label, theme, true)};--decoration-wash-${theme}:${dark ? '#fdfdfb' : '#1c1d1a'};`;
  }).join('');
}
const icon = body => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const icons = {
  straight:'<path d="M3 13L13 3"/>', elbow:'<path d="M3 13H8V3H13"/>', curved:'<path d="M3 13C3 6 13 10 13 3"/>',
  none:'<path d="M2 8H14"/>', end:'<path d="M2 8H14M10 4L14 8L10 12"/>', start:'<path d="M2 8H14M6 4L2 8L6 12"/>', both:'<path d="M2 8H14M6 4L2 8L6 12M10 4L14 8L10 12"/>',
  thin:'<path d="M2 8H14" stroke-width="1"/>', medium:'<path d="M2 8H14" stroke-width="2.2"/>', thick:'<path d="M2 8H14" stroke-width="4"/>',
  dashed:'<path d="M2 8H14" stroke-dasharray="3 2.6"/>', reverse:'<path d="M3 5H13M10 2L13 5L10 8M13 11H3M6 8L3 11L6 14"/>',
  label:'<path d="M3 4.5V3H13V4.5M8 3V13M6 13H10"/>',
  'align-left':'<path d="M2.5 4H13.5M2.5 8H9.5M2.5 12H11.5"/>', 'align-center':'<path d="M2.5 4H13.5M4.5 8H11.5M3.5 12H12.5"/>', 'align-right':'<path d="M2.5 4H13.5M6.5 8H13.5M4.5 12H13.5"/>',
  rounded:'<rect x="2" y="4" width="12" height="8" rx="2.6"/>', diamond:'<path d="M8 2.5L13.5 8L8 13.5L2.5 8Z"/>', ellipse:'<ellipse cx="8" cy="8" rx="6" ry="4.5"/>',
  arrange:'<path d="M2.5 2V14"/><rect x="4.5" y="3.5" width="9" height="3.5" rx=".6"/><rect x="4.5" y="9" width="6" height="3.5" rx=".6"/>',
  rotate:'<path d="M13 6a5.3 5.3 0 1 0 .1 4M13 2v4h-4"/>',
  more:'<circle cx="3.5" cy="8" r=".8" fill="currentColor"/><circle cx="8" cy="8" r=".8" fill="currentColor"/><circle cx="12.5" cy="8" r=".8" fill="currentColor"/>',
};
const barParts = {
  button:(action,label,body,{value,pressed,extra=''}={})=>`<button type="button" class="whiteboard-bar-button" data-whiteboard-action="${action}"${value!==undefined?` data-value="${value}"`:''} aria-label="${esc(label)}" title="${esc(label)}"${pressed!==undefined?` aria-pressed="${pressed}"`:''}${extra}>${body}</button>`,
  group:(label,body)=>`<div class="whiteboard-bar-group" role="group" aria-label="${label}">${body}</div>`,
};
const defaultAlign = d => d.shape && d.shape !== 'rectangle' ? 'center' : 'left';
const captionPresets = d => d.type==='text' ? {small:18,medium:21,large:36} :
  d.shape ? {small:15,medium:20,large:28} : {small:12,medium:15,large:24};
const captionSize = d => Number.isInteger(d.textSize) ? d.textSize : captionPresets(d)[d.textSize??'medium'];
const kindOf = d => d.sticker?'sticker':d.type==='line'?'line':d.type==='text'?'text':d.shape==='rectangle'?'sticky':d.shape?'shape':'area';
const drawingRole = d => d.sticker ? null : d.type==='line' ? 'stroke' : d.type==='text' ? 'ink' : 'fill';
const commonDrawingRole = list => {
  const role=list[0]&&drawingRole(list[0]);
  return role&&list.every(d=>drawingRole(d)===role)?role:null;
};
const resizeDirections = ['n','ne','e','se','s','sw','w','nw'];
const resizeEdges = resizeDirections.map(direction=>
  `<span class="workspace-decoration-resize" data-decoration-resize="${direction}" aria-hidden="true"></span>`
).join('');
const stickerCorners = resizeDirections.filter(direction=>direction.length===2).map(direction=>
  `<span class="workspace-decoration-resize" data-decoration-resize="${direction}" aria-hidden="true"></span>`
).join('');
const headsOf = d => d.startArrow ? d.endArrow ? 'both' : 'start' : d.endArrow ? 'end' : 'none';
const sameTarget = (a,b) => !!a && !!b && (a.placementId ? a.placementId === b.placementId : !!a.decorationId && a.decorationId === b.decorationId);
const isAttachment = endpoint => !!(endpoint?.placementId || endpoint?.decorationId);
const pointOnly = point => ({x:point.x, y:point.y});
// Key-order independent comparison of saved decoration state.
const canonical = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : v);

// The latest board still holds this decoration exactly as an action read it.
export function decorationUnchanged(d) {
  const start = canonical(d);
  return latest => canonical(latest.decorations?.find(saved => saved.id === d.id)) === start;
}
// Attached arrow endpoints still exist with the geometry the arrow was drawn against.
function endpointsUnchanged(line, board) {
  const geometry = (endpoint, source) => {
    const target = endpoint.placementId
      ? source.placements?.find(p => p.id === endpoint.placementId && !p.removedAt && !p.deletedAt && !p.archivedAt)
      : source.decorations?.find(d => d.id === endpoint.decorationId && d.type !== 'line');
    return target ? JSON.stringify(['x','y','width','height'].map(key => target[key])) : null;
  };
  const ends = [line.from, line.to].filter(isAttachment).map(end => [end, geometry(end, board)]);
  return latest => ends.every(([end, start]) => start !== null && geometry(end, latest) === start);
}

export function lineBox(from, to) {
  return {x:Math.min(from.x,to.x), y:Math.min(from.y,to.y),
    width:Math.max(1,Math.abs(to.x-from.x)), height:Math.max(1,Math.abs(to.y-from.y)),
    flipX:to.x<from.x, flipY:to.y<from.y};
}
function resizeDecoration(box, direction, dx, dy, proportional) {
  const west=direction.includes('w'), east=direction.includes('e');
  const north=direction.includes('n'), south=direction.includes('s');
  const minWidth=Math.min(box.sticker||box.shape==='ellipse'?24:60,box.width);
  const minHeight=Math.min(box.sticker||box.shape==='ellipse'?24:35,box.height);
  const bound=(next,minimum)=>Math.max(minimum,Math.min(100000,next));
  let width=box.width+(west?-dx:east?dx:0);
  let height=box.height+(north?-dy:south?dy:0);
  if(proportional) {
    const byWidth=width/box.width, byHeight=height/box.height;
    const desired=Math.abs(byWidth-1)>Math.abs(byHeight-1)?byWidth:byHeight;
    const minimum=Math.max(minWidth/box.width,minHeight/box.height);
    const maximum=Math.min(100000/box.width,100000/box.height);
    const scale=Math.max(minimum,Math.min(maximum,desired));
    width=box.width*scale; height=box.height*scale;
  } else {
    width=bound(width,minWidth); height=bound(height,minHeight);
  }
  return {x:west?box.x+box.width-width:box.x,y:north?box.y+box.height-height:box.y,width,height};
}
const stickerAngle = degrees => ((Math.round(degrees)+180)%360+360)%360-180;
function stickerDirection(point, box) {
  return Math.atan2(point.y-box.y-box.height/2,point.x-box.x-box.width/2)*180/Math.PI;
}

function numericArrowMarkup(d, resolved, path, width, box, w, h) {
  const caps = boldArrowCaps(path.points,width,d.startArrow,d.endArrow,d.route);
  const maskId = `arrow-trim-${esc(d.id)}`;
  const mask = caps.heads.length ? `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="${box.x}" y="${box.y}" width="${w}" height="${h}">
    <path d="${path.d}" pathLength="${caps.length}" fill="none" stroke="white" stroke-width="${width*1.5}" stroke-linejoin="round"
      stroke-dasharray="0 ${caps.start} ${caps.length-caps.start-caps.end} ${caps.end}"/>
    </mask></defs>` : '';
  const dash = d.dashed || resolved.detached ? `stroke-dasharray="${width*1.5} ${width}"` : '';
  const heads = caps.heads.map(points => `<polygon class="whiteboard-line-head" points="${points}"/>`).join('');
  return `<svg class="workspace-decoration-line whiteboard-numeric-arrow" style="--arrow-weight:${width}px" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${mask}<g transform="translate(${-box.x} ${-box.y})"><path class="whiteboard-line-hit" d="${path.d}"/>
    <path class="whiteboard-line-stroke" d="${path.d}" fill="none" stroke="var(--decoration-color)" stroke-width="${width}" stroke-linejoin="round" ${dash} ${mask?`mask="url(#${maskId})"`:''}/>
    ${heads}</g></svg>`;
}

export function decorationMarkup(d, board, origin, selected=false, overrides, interactive=false) {
  const current = {...d,...overrides?.decorations?.get(d.id)};
  const line = d.type === 'line', resolved = line ? resolveLine(current,board,overrides) : null;
  const box = resolved?.bounds || decorationBounds(current,board,overrides);
  const container = current.container;
  const color = authoredColor(current.color), w = Math.max(1,box.width), h = Math.max(1,box.height);
  if(current.sticker){
    const angle=Number.isFinite(current.rotation)?current.rotation:0;
    const handles=selected===true?`${stickerCorners}<button type="button" class="whiteboard-sticker-rotation" data-sticker-rotate aria-label="Rotate sticker" title="Drag to rotate, or use the arrow keys">${icon(icons.rotate)}</button>`:'';
    return `<div tabindex="0" role="group" aria-label="${esc(`Sticker: ${current.text}`)}" class="workspace-decoration whiteboard-sticker${selected?' selected':''}" data-decoration="${esc(d.id)}" data-sticker style="left:${box.x+origin.x}px;top:${box.y+origin.y}px;width:${w}px;height:${h}px;z-index:${stackRank(board,'decoration',d.id)};--sticker-size:${Math.min(w,h)*.82}px;--sticker-angle:${angle}deg"><span class="whiteboard-sticker-glyph" aria-hidden="true">${esc(current.text)}</span>${handles}</div>`;
  }
  const path = line ? linePath(resolved, current.route, current.bend) : null;
  const points = line ? lineSurfacePoints(path, box) : surfacePoints(box);
  const backdrop = theme => boardSurfaces(board, theme, points, {except: current.id, layers: line ? 2 : current.type === 'text' || current.shape ? 1 : 0});
  let mark, handles = '';
  if (line) {
    const r=resolved;
    const x1=r.from.x-box.x, y1=r.from.y-box.y, x2=r.to.x-box.x, y2=r.to.y-box.y;
    const sw=arrowWeights[current.thickness]||arrowWeights.medium, k=Math.max(1,sw/2), head=`url(#arrow-${esc(d.id)})`;
    const dash=current.dashed?`stroke-dasharray="${7*k} ${5*k}"`:r.detached?'stroke-dasharray="1 5" stroke-linecap="round"':'';
    mark = Number.isInteger(current.thickness) ? numericArrowMarkup(current,r,path,current.thickness,box,w,h) :
      `<svg class="workspace-decoration-line" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-${esc(d.id)}" markerWidth="${12*k}" markerHeight="${12*k}" refX="${10*k}" refY="${6*k}" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M${2*k} ${2*k}L${10*k} ${6*k}L${2*k} ${10*k}" fill="none" stroke="var(--decoration-color)" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/></marker></defs><g transform="translate(${-box.x} ${-box.y})"><path class="whiteboard-line-hit" d="${path.d}"/><path class="whiteboard-line-stroke" d="${path.d}" fill="none" stroke="var(--decoration-color)" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke" ${dash} ${current.startArrow?`marker-start="${head}"`:''} ${current.endArrow?`marker-end="${head}"`:''}/></g></svg>`;
    mark += `<span class="workspace-decoration-label whiteboard-line-label" data-decoration-label style="left:${path.mid.x-box.x}px;top:${path.mid.y-box.y}px">${esc(current.text||'')}</span>${r.detached?'<span class="whiteboard-detached">Detached</span>':''}`;
    if (selected === true) {
      handles = `<button type="button" class="workspace-endpoint endpoint-tail" data-endpoint="from" aria-label="Arrow start: drag to move or attach" title="Drag to move or attach the start" style="left:${x1}px;top:${y1}px"></button><button type="button" class="workspace-endpoint endpoint-head" data-endpoint="to" aria-label="Arrow end: drag to move or attach" title="Drag to move or attach the end" style="left:${x2}px;top:${y2}px"></button>`;
      if (path.bendPoint) handles += `<button type="button" class="workspace-bend" data-arrow-bend aria-label="Adjust arrow bend" title="Drag to bend the arrow" style="left:${path.bendPoint.x-box.x}px;top:${path.bendPoint.y-box.y}px"></button>`;
    }
  } else {
    const shape = current.shape;
    const silhouette = shape === 'diamond' ? `<polygon points="${w/2},0 ${w},${h/2} ${w/2},${h} 0,${h/2}"/>`
      : shape === 'ellipse' ? `<ellipse cx="${w/2}" cy="${h/2}" rx="${Math.max(1,w/2-1)}" ry="${Math.max(1,h/2-1)}"/>`
      : `<rect x="1" y="1" width="${Math.max(1,w-2)}" height="${Math.max(1,h-2)}" rx="${shape==='rounded'?Math.min(20,w/2,h/2):2}"/>`;
    const rich=d.type==='text';
    const tag=rich?'div':'span';
    const emptyArea = current.type==='region'&&!shape&&!current.text?.trim();
    const emptyContainerLabel = interactive && container && !container.children.length && emptyArea;
    mark = `${shape?`<svg class="whiteboard-silhouette" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${silhouette}</svg>`:''}<${tag} class="workspace-decoration-label" data-decoration-label${emptyArea&&!emptyContainerLabel?' data-empty-area-label':''}><${tag} class="deco-body">${emptyContainerLabel?'Container':formatToHTMLString(current.text||'',{rich,interactive:rich&&interactive})}</${tag}></${tag}>`;
    if (selected === true && !container) handles = resizeEdges;
  }
  const label=d.type==='text'?(current.text||'').split(/\r?\n/).find(line=>line.trim())?.replace(/^#{1,6} /,'').slice(0,120):current.text;
  const nativeText=d.type==='text';
  const face=nativeText&&['sans','serif','mono'].includes(current.textFace)?` data-text-face="${current.textFace}"`:'';
  const labelSize=d.type==='region'&&!container&&current.textSize!==undefined?captionSize(current):null;
  const appearance=nativeText?textStyleVariables(current,color,backdrop):drawingStyles(current,color,backdrop)+(labelSize===null?'':`--drawing-label-size:${labelSize}px;`);
  const sizedLabel=labelSize===null?'':' data-drawing-label-size';
  return `<div tabindex="0" role="group" aria-label="${esc(line?'Arrow':container?'Container':shapeNames[current.shape]||current.type)}: ${esc(label||'Untitled')}" class="workspace-decoration decoration-${esc(d.type)} ${container?'whiteboard-container':current.shape?'whiteboard-shape shape-'+esc(current.shape):''}${line&&current.route==='curved'?' whiteboard-curved-arrow':''}${!line&&['small','large'].includes(current.textSize)?' text-size-'+current.textSize:''}${!line&&['left','center','right'].includes(current.textAlign)?' text-align-'+current.textAlign:''} ${selected?'selected':''}" data-decoration="${esc(d.id)}"${isPaletteColor(color)?' data-named-color':''}${face}${sizedLabel} style="left:${box.x+origin.x}px;top:${box.y+origin.y}px;width:${w}px;height:${h}px;z-index:${stackRank(board,'decoration',d.id)};${container?`--container-padding:${container.padding??16}px;`:''}${appearance}">${mark}${handles}</div>`;
}

export class Whiteboard {
  constructor(host) {
    this.host=host; this.overrides=undefined; this.drag=null;
    this.editor=null; this.drafts=new Map(); this.taskActivations=new WeakMap(); this.connectMode=false; this.pendingFrom=null;
    this.draftKey=`tinka/${host.config.workspaceId}/whiteboard-drafts/${host.snapshot.id}`;
    if(!host.hooks.viewOnly){
      try { for(const [id,draft] of Object.entries(JSON.parse(localStorage.getItem(this.draftKey)||'{}')))
        if(typeof draft.text==='string')this.drafts.set(id,{...draft,pending:false,error:draft.error||'Save not confirmed. Retry to check this text.'}); } catch {}
    }
  }
  mount() {
    if (!document.querySelector('link[data-whiteboard-style]')) {
      const link=document.createElement('link'); link.rel='stylesheet'; link.href='/app/whiteboard.css';
      link.dataset.whiteboardStyle=''; document.head.append(link);
      const format=document.createElement('link');format.rel='stylesheet';format.href='/app/text-format-controls.css';
      document.head.append(format);
    }
    this.ports=document.createElement('div'); this.ports.className='whiteboard-ports';
    this.toolbar=document.createElement('div'); this.toolbar.className='whiteboard-toolbar';
    this.toolbar.setAttribute('role','toolbar'); this.toolbar.setAttribute('aria-label','Selected object'); this.toolbar.hidden=true;
    this.menu=document.createElement('div'); this.menu.className='whiteboard-menu'; this.menu.hidden=true;
    this.menu.setAttribute('role','menu'); this.menu.setAttribute('aria-label','Object actions');
    this.hint=document.createElement('div'); this.hint.className='whiteboard-connect-hint'; this.hint.hidden=true;
    this.hint.setAttribute('role','status'); document.body.append(this.toolbar,this.menu,this.hint);
    if(this.host.hooks.viewOnly)return;
    this.inkAppearanceObserver=new MutationObserver(()=>this.refreshTextInkPreview());
    this.inkAppearanceObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-appearance']});
    this.recoverButton=document.getElementById('workspace-recover-text');
    if(this.recoverButton)this.recoverButton.onclick=()=>this.recoverText();
    document.addEventListener('pointerdown',e=>this.down(e),true);
    document.addEventListener('pointermove',e=>this.move(e),true);
    document.addEventListener('pointerup',e=>this.up(e),true);
    document.addEventListener('pointercancel',()=>this.cancel(),true);
    document.addEventListener('keydown',e=>this.keydown(e),true);
    document.addEventListener('dblclick',e=>{
      const element=e.target.closest('[data-decoration]');
      if (element&&!this.host.hooks.viewOnly&&!e.target.closest('button:not([data-arrow-bend]),input,textarea,.whiteboard-editor')) {
        e.preventDefault(); this.edit(element.dataset.decoration);
      }
    });
    document.addEventListener('click',e=>this.click(e),true);
    window.addEventListener('blur',()=>{this.cancel(); this.commitEdit({focus:false}); this.connectMode=false; this.pendingFrom=null; this.renderPorts();});
    window.addEventListener('resize',()=>this.positionToolbar());
    document.getElementById('viewport').addEventListener('wheel',()=>requestAnimationFrame(()=>this.positionToolbar()),{passive:true});
    // The board normally pans on a plain wheel. An overflowing block gets to
    // scroll its own text first; pinch and modifier zoom still reach the canvas.
    document.getElementById('world').addEventListener('wheel',e=>{
      if(e.metaKey||e.ctrlKey||e.shiftKey||!e.deltaY)return;
      const scroller=e.target.closest('.decoration-text > .workspace-decoration-label,.whiteboard-text-preview');
      if(scroller&&(e.deltaY>0?scroller.scrollTop+scroller.clientHeight<scroller.scrollHeight-1:scroller.scrollTop>0))e.stopPropagation();
    },{passive:true});
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
    if(this.host.hooks.viewOnly||this.host.mode!=='canvas'||this.editor) { this.ports.remove(); return; }
    const source=this.selectedRef();
    // Hotspots sit outside the outline, where they do not compete with resizing.
    const ownTarget=source?.decorationId&&this.find(source.decorationId);
    const own=ownTarget&&!ownTarget.sticker&&!this.drag&&(ownTarget.type==='text'||ownTarget.shape) ? [source] : [];
    const refs=this.drag?.endpoint||this.pendingFrom ? this.targets() : this.connectMode&&source ? [source] : own;
    const origin=this.host.origin||{x:0,y:0},snap=this.drag?.snap;
    const markup=refs.flatMap(ref=>sides.map(side=>{
      const end={...ref,side},p=resolveEndpoint(end,this.host.snapshot,this.overrides);
      const state=sameTarget(snap?.ref,ref)?snap.endpoint.side===side&&(snap.endpoint.offset??.5)===.5?' near snapped':' near':'';
      return p.detached?'':`<button type="button" class="whiteboard-port${state}" data-port-side="${side}" data-port="${esc(JSON.stringify(end))}" aria-label="Connect ${esc(this.name(ref))} ${side}" title="${esc(this.name(ref))}: ${side}" style="left:${p.x+origin.x}px;top:${p.y+origin.y}px"></button>`;
    })).join('');
    if(this.ports.innerHTML!==markup)this.ports.innerHTML=markup;
    this.ports.classList.toggle('snapping',!!snap);
    // Decoration patches rewrite class attributes, so the target mark follows each render.
    if(this.drag?.endpoint)this.highlight(snap?.ref);
    document.getElementById('world').append(this.ports);
  }
  markup(d) {
    const held=this.drafts.get(d.id),draft=d.sticker||held?.nativeText&&d.type!=='text'?null:held;
    const markup=decorationMarkup(draft?{...d,text:draft.text}:d,this.host.snapshot,this.host.origin||{x:0,y:0},this.host.activeDecoration===d.id||(this.host.decorationSelection?.has(d.id)&&(this.host.decorationSelection.size>1||this.host.selection.size)?'group':false),this.overrides,!this.host.hooks.viewOnly&&!draft?.error);
    let rendered=draft?.error?markup.replace(/<\/div>$/,`<div class="whiteboard-draft-state" role="status"><span>Text not saved</span><button type="button" data-whiteboard-retry="${esc(d.id)}">Retry</button></div></div>`):markup;
    if(draft?.nativeText&&draft.pending)rendered=rendered.replace(' data-decoration="',' aria-busy="true" data-decoration="');
    // A host keyed build that was already in flight must retain this native form.
    // Its live value/selection remain properties of the existing textarea node.
    if(this.editor?.id===d.id)rendered=rendered.replace(' data-decoration="', ' data-editing="" data-decoration="').replace(/<\/div>$/,this.editor.form.outerHTML+'</div>');
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
    if(this.recoverButton)this.recoverButton.hidden=!this.orphanDraft();
    this.renderPorts(); this.renderToolbar();
  }
  reconcileSelection() {
    if(this.host.activeDecoration&&!this.find())this.host.activeDecoration=null;
    if(this.host.decorationSelection?.size){const kept=[...this.host.decorationSelection].filter(id=>this.find(id));this.host.decorationSelection=new Set(kept.length>1||kept.length&&this.host.selection.size?kept:[]);}
    if(this.host.mode!=='canvas') { this.connectMode=false; this.pendingFrom=null; this.closeMenu(); }
    if(this.pendingFrom&&!this.target(this.pendingFrom)){this.pendingFrom=null;this.connectMode=false;this.hint.hidden=true;}
    if(!this.selectedRef()&&!this.drag?.endpoint&&!this.pendingFrom)this.connectMode=false;
  }
  select(id) {
    if(this.host.activeDecoration===id&&!(this.host.decorationSelection?.size>1))return;
    this.commitEdit({focus:false}); this.connectMode=false; this.pendingFrom=null; this.closeMenu();
    this.host.activeDecoration=id; this.host.decorationSelection=new Set(); this.host.selection.clear(); this.host.syncSelection(); this.host.selectionMenu(); this.sync(this.overrides);
  }
  clearSelection({finishEdit=true,focus=false}={}) {
    if(finishEdit)this.commitEdit({focus});
    this.host.activeDecoration=null; this.host.decorationSelection=new Set(); this.connectMode=false; this.pendingFrom=null; this.closeMenu();
    this.sync(this.overrides);
  }
  connectPlacement(id,invoker) {
    this.connectInvoker=invoker;
    this.clearSelection(); this.host.selection=new Set([id]); this.host.syncSelection(); this.startConnect();
  }
  // The decorations the bar acts on: a multi-selection (host.decorationSelection,
  // two or more ids) or the single active decoration.
  selectedDecorations() {
    const many=this.host.decorationSelection;
    const ids=many?.size&&this.host.selection.size?[]:many?.size>1?[...many]:this.host.activeDecoration?[this.host.activeDecoration]:[];
    return ids.map(id=>this.find(id)).filter(Boolean);
  }
  // Select several decorations at once (marquee, shift-click). One id selects it
  // normally; none clears. Card selection is cleared, as for a single decoration.
  selectDecorations(ids) {
    ids=[...new Set(ids)].filter(id=>this.find(id));
    if(ids.length<2){if(ids.length)this.select(ids[0]);else this.clearSelection();return;}
    this.commitEdit({focus:false});this.connectMode=false;this.pendingFrom=null;this.closeMenu();
    this.host.activeDecoration=null;this.host.decorationSelection=new Set(ids);
    this.host.selection.clear();this.host.syncSelection();this.host.selectionMenu();this.sync(this.overrides);
  }
  renderToolbar() {
    const list=this.selectedDecorations(),d=list[0],multi=list.length>1,ref=this.selectedRef(),draft=!multi&&d&&this.drafts.get(d.id);
    // The bar steps aside while a drag is under way, as in FigJam or Miro.
    this.toolbar.hidden=this.host.hooks.viewOnly||this.host.mode!=='canvas'||!d||!!this.drag?.active||
      (!multi&&d.sticker&&!this.objectMenuActions(list).length);
    if(this.toolbar.hidden){this.closeMenu();this.positionStickerRotation();return;}
    const line=!multi&&d.type==='line',style=list.map(d=>[d.id,d.color,d.route,d.thickness,d.dashed,d.startArrow,d.endArrow,d.shape,d.textSize,d.textAlign,
      this.containerLayoutDrafts?.get(d.id)?.pending.layout??d.container?.layout]);
    const grouping=multi?this.host.groupAction()?.label:null;
    const stamp=JSON.stringify([ref,this.editor?.id,this.editor?.previewing,draft?.pending,draft?.error,this.connectMode,style,grouping]);
    if(stamp!==this.toolbar.dataset.stamp) {
      this.toolbar.dataset.stamp=stamp;
      // Keep keyboard focus on the same control across a re-render.
      const focused=this.toolbar.contains(document.activeElement)?document.activeElement:null;
      const focusKey=focused&&[focused.dataset.whiteboardAction,focused.dataset.value];
      this.toolbar.classList.toggle('whiteboard-arrow-bar',!this.editor||this.editor.rich);
      this.toolbar.classList.toggle('whiteboard-text-editor-bar',!!this.editor?.rich);
      this.toolbar.setAttribute('aria-label',this.groupName(list));
      this.toolbar.innerHTML=this.editor
        ? this.editor.rich?this.textEditorBar(this.editor)
        : `<span class="whiteboard-edit-hint">${esc(line?'Enter':commitShortcutLabel())} to finish</span><button type="button" data-whiteboard-action="done">Done</button><button type="button" data-whiteboard-action="cancel-edit">Cancel</button>`
        : this.bar(list,draft)+(grouping?barParts.group('Grouping',`<button type="button" class="whiteboard-action-caption" data-whiteboard-action="canvas-group">${grouping}</button>`):'');
      if(focusKey)[...this.toolbar.querySelectorAll('button')].find(b=>b.dataset.whiteboardAction===focusKey[0]&&b.dataset.value===focusKey[1])?.focus({preventScroll:true});
    }
    this.positionToolbar();
    this.refreshTextInkPreview();
  }
  refreshTextInkPreview() {
    if(this.toolbar.hidden||this.editor)return;
    const button=this.toolbar.querySelector('[data-whiteboard-action="text-ink"],[data-whiteboard-action="drawing-color"]');
    syncTextInkPreview(button,this.selectedDecorations(),this.host.snapshot);
  }
  textEditorBar(session) {
    const {button,group}=barParts;
    const controls=session.previewing?'':group('Formatting',textFormatControls.map(([value,label,mark])=>button('format-text',label,mark,{value})).join(''));
    return controls+group('Editing',button('text-preview',session.previewing?'Continue editing':'Preview text',session.previewing?'Edit':'Preview',
      {pressed:session.previewing}))
      +group('Finish editing',`<button class="whiteboard-action-caption" type="button" data-whiteboard-action="done" title="${esc(commitShortcutLabel())}">Done</button><button class="whiteboard-action-caption" type="button" data-whiteboard-action="cancel-edit">Cancel</button>`);
  }
  kindName(d) { return d.sticker?'Sticker':d.container?'Container':d.type==='line'?'Arrow':d.type==='text'?'Text':shapeNames[d.shape]||'Area'; }
  groupName(list) {
    if(list.length<2)return list[0]?this.kindName(list[0]):'Selected object';
    const kinds=new Set(list.map(kindOf)),name=this.kindName(list[0]).toLowerCase();
    return kinds.size===1?`${list.length} ${name==='text'?'text boxes':name+'s'}`:`${list.length} objects`;
  }
  bar(list,draft) {
    const {button,group}=barParts,multi=list.length>1,first=list[0];
    const action=(key,label)=>`<button type="button" class="whiteboard-action-caption" data-whiteboard-action="${key}">${label}</button>`;
    const popup=key=>` aria-haspopup="dialog" aria-expanded="${this.appearance?.trigger===key}"`;
    const colorRole=commonDrawingRole(list);
    const colorValue=list.every(d=>d.color===first.color)?authoredColor(first.color):undefined;
    const colorLabel=first.type==='line'?'Stroke color':first.type==='text'?'Ink color':
      !multi&&first.shape==='rectangle'?'Paper color':'Fill color';
    const color=colorRole?button(first.type==='text'&&!multi?'text-ink':'drawing-color',colorLabel,colorDot(colorValue,colorRole),{
      extra:popup(first.type==='text'&&!multi?'text-ink':'drawing-color'),
    }):'';
    const sizeGlyph=icon('<path d="M1.5 12.5 5 3.5l3.5 9M2.7 9.5h4.6M12.5 3.5v9M10.5 5.5l2-2 2 2m-4 5 2 2 2-2"/>');
    const size=key=>button(key,'Text size',sizeGlyph,{extra:popup(key)});
    // The bar shows More only for an object's own actions; when it does, its menu adds
    // the stacking commands (] and [ work for every selection).
    const more=this.objectMenuActions(list).length?button('more','More options',icon(icons.more),{
      extra:` aria-haspopup="menu" aria-expanded="${!this.menu.hidden&&!this.appearance&&!this.containerLayout}"`,
    }):'';
    const pending=draft?.pending?'<span class="whiteboard-bar-status" role="status">Saving…</span>':'';
    if(!multi&&first.container){
      const layout=this.containerLayoutDrafts?.get(first.id)?.pending.layout??first.container.layout;
      const modes=containerLayouts.map(([value,label,path])=>button('container-mode',label,
        `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}"/></svg>`,{value,pressed:value===layout})).join('');
      return group('Container color',color)+group('Container layout',modes)+
        group('Container options',button('container-layout','More container options',icon(icons.more),{
          extra:` aria-haspopup="dialog" aria-expanded="${!!this.containerLayout}"`,
        }));
    }
    if(!multi&&first.sticker)return group('Sticker actions',more);
    if(!multi&&first.type==='text'){
      const align=['left','center','right'].map(value=>button('align',`Align ${value}`,icon(icons['align-'+value]),{
        value,pressed:value===(first.textAlign||'left'),
      })).join('');
      return group('Text appearance',color+size('text-size'))+group('Alignment',align)+
        group('Text actions',button('text-appearance','Typeface','<b class="whiteboard-size-letter">Aa</b>',{
          extra:popup('text-appearance'),
        })+button('text-box','Text box',icon('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h4"/>'),{
          extra:popup('text-box'),
        })+more)+pending;
    }
    const arrange=multi&&this.host.arrangeObjects().length>1?button('arrange','Arrange: align, distribute, tidy',icon(icons.arrange),{extra:' aria-haspopup="dialog" aria-expanded="false"'}):'';
    if(list.every(d=>d.type==='line')) {
      const routes=[['straight','Straight'],['elbow','Elbow'],['curved','Curve']]
        .map(([value,label])=>button('route',label,icon(icons[value]),{value,pressed:list.every(d=>(d.route||'straight')===value)})).join('');
      const edit=!multi?button('edit','Edit arrow label',icon(icons.label)):'';
      const reverse=button('reverse',multi?'Reverse directions':'Reverse direction',icon(icons.reverse));
      const style=button('text-appearance','Line options',icon(icons.medium),{extra:popup('text-appearance')});
      return group('Stroke color',color)+group('Arrow route',routes)+group('Arrow actions',edit+reverse+style+arrange);
    }
    const textOptions=list.every(d=>d.type!=='line'&&!d.sticker&&!d.container);
    const free=list.filter(d=>canContain(d)&&!containerFor(this.host.snapshot.decorations,d.id));
    const membership=multi&&free.length===list.length?action('wrap-container','Make container'):
      multi&&list.filter(d=>d.container).length===1&&free.length===list.length-1?action('attach-container','Add to container'):'';
    const caption=textOptions?size('caption-size'):'';
    const alignment=first.textAlign||defaultAlign(first);
    const optionLabel=multi?'Drawing options':first.shape==='rectangle'?'Text alignment':first.shape?'Shape options':'Region options';
    const options=textOptions?button('text-appearance',optionLabel,
      icon(first.shape==='rectangle'?icons['align-'+alignment]:icons[first.shape]||icons.more),{extra:popup('text-appearance')}):'';
    return (color||caption?group('Appearance',color+caption):'')+
      (options||arrange||more?group('Drawing actions',options+arrange+(options?'':more)):'')+
      (membership?group('Container',membership):'')+pending;
  }
  // One bar choice as a patch for one decoration, or null when it changes nothing.
  stylePatch(d,action,value) {
    let patch;
    if(action==='reverse') {
      if(d.type!=='line')return null;
      const r=resolveLine(d,this.host.snapshot),from=d.to?structuredClone(d.to):pointOnly(r.to),to=d.from?structuredClone(d.from):pointOnly(r.from),g=resolveLine({...d,from,to},this.host.snapshot);
      return {from,to,...lineBox(g.from,g.to),...(d.bend!==undefined?{bend:-d.bend}:{})};
    }
    if(action==='route'&&value==='curved'&&d.route!=='curved'&&d.bend===undefined) {
      const {from,to}=resolveLine(d,this.host.snapshot);
      return {route:value,bend:defaultArrowBend(from,to)};
    }
    patch=action==='color'?{color:value}:action==='route'?{route:value}:action==='thickness'?{thickness:value}
      :action==='size'?{textSize:value}:action==='align'?{textAlign:value}:action==='shape'?{shape:value}
      :action==='dashed'?{dashed:value}:{startArrow:value==='start'||value==='both',endArrow:value==='end'||value==='both'};
    const defaults={route:'straight',thickness:'medium',dashed:false,startArrow:false,endArrow:false,textSize:'medium',textAlign:defaultAlign(d)};
    return Object.entries(patch).every(([key,v])=>(d[key]??defaults[key])===v)?null:patch;
  }
  // Apply a bar choice to every selected decoration. Several at once save as one
  // atomic board write, refused (and reported) if the board changed meanwhile.
  async restyle(ids,action,value) {
    const list=ids.map(id=>this.find(id)).filter(Boolean);if(!list.length)return;
    if(action==='dashed')value=value==='true'?true:value==='false'?false:!list.every(d=>d.dashed);
    const valueFor=typeof value==='function'?value:()=>value;
    const patches=new Map();
    for(const d of list){
      const patch=this.stylePatch(d,action,valueFor(d));
      if(patch)patches.set(d.id,list.length>1&&action==='size'?this.fitAutoText(d.id,patch):patch);
    }
    if(!patches.size)return;
    if(list.length===1){const [[id,patch]]=patches;await this.save(id,patch);return;}
    await this.host.history.group(patches.size>1?`Change style of ${patches.size} drawn elements`:'Change style',()=>this.saveMany(this.host.snapshot.decorations.map(d=>patches.has(d.id)?{...d,...patches.get(d.id)}:d)));
  }
  async saveMany(decorations) {
    const before=canonical(this.host.snapshot.decorations);
    this.host.decorationCommitting=true;
    try{await this.host.writeArrangement('updateBoard',{boardId:this.host.snapshot.id,patch:{decorations}},latest=>canonical(latest.decorations)===before);await this.host.refresh({saveReview:false});}
    finally{this.host.decorationCommitting=false;this.host.hooks.liveReady?.();}
  }
  positionToolbar() {
    this.positionStickerRotation();
    if(this.toolbar.hidden)return;
    const list=this.selectedDecorations(),ref=this.selectedRef();
    const elements=list.length?list.map(d=>document.querySelector(selector(d.id))).filter(Boolean):ref?.placementId?[document.querySelector(`[data-placement="${CSS.escape(ref.placementId)}"]`)].filter(Boolean):[];
    if(!elements.length)return;
    const rects=elements.map(e=>e.getBoundingClientRect()),r={left:Math.min(...rects.map(b=>b.left)),top:Math.min(...rects.map(b=>b.top)),right:Math.max(...rects.map(b=>b.right)),bottom:Math.max(...rects.map(b=>b.bottom))};
    r.width=r.right-r.left;r.height=r.bottom-r.top;const viewport=document.getElementById('viewport').getBoundingClientRect();
    const width=this.toolbar.offsetWidth,height=this.toolbar.offsetHeight;
    const left=Math.max(8,Math.min(innerWidth-width-8,r.left+(r.width-width)/2));
    const gap=list.length===1&&ref?.decorationId&&this.ports.childElementCount ? 26 : 8;
    const above=r.top-height-gap>=viewport.top+8;
    const top=above?r.top-height-gap:Math.min(viewport.bottom-height-8,Math.max(viewport.top+8,r.bottom+gap));
    this.toolbarObject=r;
    this.toolbarSide=above?'top':'bottom';
    Object.assign(this.toolbar.style,{left:`${left}px`,top:`${top}px`});
    if(!this.menu.hidden)this.positionMenu();
  }
  positionStickerRotation() {
    const sticker=this.find();
    if(!sticker?.sticker)return;
    const element=document.querySelector(selector(sticker.id)), handle=element?.querySelector('[data-sticker-rotate]');
    if(!handle)return;
    const viewport=document.getElementById('viewport'), view=viewport.getBoundingClientRect();
    const box=element.getBoundingClientRect(), x=box.left+box.width/2, y=box.top+box.height/2, offset=19;
    const candidates=[['bottom',x,box.bottom+offset],['right',box.right+offset,y],
      ['left',box.left-offset,y],['top',x,box.top-offset]];
    const side=candidates.find(([,cx,cy])=>{
      if(cx < view.left+13||cx > view.right-13||cy < view.top+13||cy > view.bottom-13)return false;
      return viewport.contains(document.elementFromPoint(cx,cy));
    })?.[0]||'bottom';
    handle.dataset.rotateSide=side;
  }
  positionMenu() {
    if(this.menu.hidden)return;
    const viewport=document.getElementById('viewport').getBoundingClientRect();
    const toolbar=this.toolbar.getBoundingClientRect();
    const view={left:Math.max(0,viewport.left),top:Math.max(0,viewport.top),
      right:Math.min(innerWidth,viewport.right),bottom:Math.min(innerHeight,viewport.bottom)};
    const scrollTop=this.menu.scrollTop;
    this.menu.style.maxHeight='';
    const height=Math.max(this.menu.offsetHeight,this.menu.scrollHeight);
    const place=placeWhiteboardPopover(view,this.toolbarObject||toolbar,toolbar,this.toolbarSide||'bottom',this.menu.offsetWidth,height);
    Object.assign(this.menu.style,{left:`${place.left}px`,top:`${place.top}px`,maxHeight:`${place.maxHeight}px`});
    this.menu.scrollTop=scrollTop;
    this.menu.dataset.popupSide=place.side;
  }
  objectMenuActions(list) {
    const actions=[];
    const add=(action,label)=>actions.push([action,label]);
    if(list.length===1){
      const [d]=list;
      if(d.type==='region'&&!d.shape&&!d.container)add('select-section','Select section contents');
      if(d.container)add('edit','Edit container title');
      if(containerFor(this.host.snapshot.decorations,d.id))add('container-detach','Remove from container');
    }
    return actions;
  }
  // The More menu adds the stacking commands to the object's own actions.
  menuActions(list) {
    return [...this.objectMenuActions(list),...(this.host.hooks.viewOnly?[]:[['stack-front','Bring to front'],['stack-back','Send to back']])];
  }
  openMenu() {
    const actions=this.menuActions(this.selectedDecorations());
    if(!actions.length)return false;
    this.menu.innerHTML=actions.map(([action,label])=>`<button type="button" role="menuitem" data-whiteboard-action="${action}">${label}</button>`).join('');
    this.menu.hidden=false;
    this.toolbar.querySelector('[data-whiteboard-action=more]')?.setAttribute('aria-expanded','true');
    this.positionMenu();
    this.menu.querySelector('button')?.focus({preventScroll:true});
    return true;
  }
  renderObjectFormat(session) {
    const formatActions=actions=>actions.length?`<div class="whiteboard-format-actions">${actions.map(([id,label])=>
      `<button type="button" data-whiteboard-action="${id}">${label}</button>`).join('')}</div>`:'';
    if(this.appearance!==session)return;
    if(session.weightControl?.editing||session.captionControl?.editing)return;
    const objects=session.ids.map(id=>this.find(id)).filter(Boolean);
    if(!objects.length){this.closeMenu();return;}
    const active=this.menu.contains(document.activeElement)?document.activeElement:null;
    const focused=active?{action:active.dataset.whiteboardAction,value:active.dataset.value,custom:active.type==='color',swatch:active.dataset.swatch,
      weight:active.closest('[data-arrow-weight]'),caption:active.closest('[data-caption-size]'),scrub:active.hasAttribute('data-scrub-value')}:null;
    const {button}=barParts;
    const common=read=>{const values=objects.map(read);return values.every(value=>value===values[0])?values[0]:undefined;};
    const all=predicate=>objects.every(predicate);
    const role=commonDrawingRole(objects),channel=role==='stroke'?'border':role;
    const choices=(name,action,current,options)=>`<fieldset class="whiteboard-format-section"><legend>${name}</legend><div class="whiteboard-format-options">
      ${options.map(([value,label,mark])=>button(action,label,mark,{value,pressed:value===current})).join('')}
    </div></fieldset>`;
    const pick=(value,label=value)=>[value,label,icon(icons[value])];
    const sections=[];
    if(session.mode==='color'){
      if(!channel){this.closeMenu();return;}
      sections.push(`<div class="text-format-header"><strong>${esc(session.label)}</strong><button type="button" data-format-close data-whiteboard-action="close-format" aria-label="Close color palette">×</button></div>`,
        paletteMarkup([channel]));
    } else if(session.mode==='size'){
      sections.push('<fieldset class="whiteboard-format-section"><legend>Text size</legend><div data-caption-size></div></fieldset>');
    } else if(all(d=>d.type==='line')){
      sections.push(
        choices('Arrowheads','heads',common(headsOf),[pick('none','No arrowheads'),pick('start','Arrowhead at start'),pick('end','Arrowhead at end'),pick('both','Arrowheads at both ends')]),
        '<fieldset class="whiteboard-format-section"><legend>Weight</legend><div data-arrow-weight></div></fieldset>',
        choices('Stroke','dashed',String(common(d=>!!d.dashed)),[['false','Solid line',icon(icons.medium)],['true','Dashed line',icon(icons.dashed)]]),
        formatActions(this.menuActions(objects))
      );
    } else if(all(d=>d.type!=='line')){
      if(all(d=>d.shape&&d.shape!=='rectangle'))
        sections.push(choices('Shape','shape',common(d=>d.shape),['rounded','diamond','ellipse'].map(value=>pick(value,shapeNames[value]))));
      sections.push(choices('Alignment','align',common(d=>d.textAlign||defaultAlign(d)),['left','center','right'].map(value=>[value,`Align ${value}`,icon(icons['align-'+value])])));
      sections.push(formatActions(this.menuActions(objects)));
    }
    session.weightControl?.destroy({commit:false});
    session.captionControl?.destroy({commit:false});
    this.menu.innerHTML=`<div class="text-format-controls whiteboard-object-format">
      ${sections.join('')}<span class="whiteboard-format-status" role="status">${esc(session.error||'')}</span>
    </div>`;
    const custom=this.menu.querySelector('input[type=color]');
    const palette=this.menu.querySelector('[data-color-swatches]');
    if(palette)bindDrawingPalette(palette,{channel,label:session.label,value:common(d=>d.color),
      choose:value=>this.applyObjectFormat(session,'color',value,{finishAfterClose:true})});
    const caption=this.menu.querySelector('[data-caption-size]');
    if(caption)this.mountCaptionSize(session,caption,objects,common);
    const weight=this.menu.querySelector('[data-arrow-weight]');
    if(weight) {
      const thickness=common(d=>d.thickness??'medium');
      const presets=Object.entries(arrowWeights).map(([id,value])=>({id,value,icon:icon(icons[id]),
        label:id[0].toUpperCase()+id.slice(1),ariaLabel:`${id[0].toUpperCase()+id.slice(1)} line`}));
      const measured=d=>Number.isInteger(d.thickness)?d.thickness:arrowWeights[d.thickness??'medium'];
      const adjusted=(d,value,delta)=>thickness!==undefined||delta==null?value:
        Math.max(1,Math.min(MAX_ARROW_THICKNESS,Math.round(measured(d)+delta)));
      session.weightControl=mountPresetScrub(weight,{
        label:'Weight', inputLabel:'Adjust arrow weight', unit:'px', presets, min:1, max:MAX_ARROW_THICKNESS,
        value:Number.isInteger(thickness)?thickness:arrowWeights[thickness]??null,
        selection:{preset:typeof thickness==='string'?thickness:null,custom:objects.every(d=>Number.isInteger(d.thickness))},
        preview:(value,delta)=>{
          if(value===null){
            if(session.previewingWeight){session.previewingWeight=false;this.host.syncGeometry();}
            return;
          }
          session.previewingWeight=true;
          const entries=session.ids.map(id=>this.find(id)).filter(Boolean)
            .map(d=>[d.id,{thickness:adjusted(d,value,delta)}]);
          this.host.syncGeometry({decorations:new Map(entries)});
        },
        commit:(value,{preset,delta})=>{
          this.applyObjectFormat(session,'thickness',d=>preset??adjusted(d,value,delta),{finishAfterClose:true});
          return session.pending;
        },
      });
    }
    this.positionMenu();
    const controls=[...this.menu.querySelectorAll('button')];
    if(focused?.scrub)restoreFocus(this.menu.querySelector('[data-scrub-value]'));
    else if(focused?.caption)session.captionControl?.focus();
    else if(focused?.weight)session.weightControl?.focus();
    else if(focused)restoreFocus(focused.custom?custom:focused.swatch?controls.find(control=>control.dataset.swatch===focused.swatch):
      controls.find(control=>control.dataset.whiteboardAction===focused.action&&control.dataset.value===focused.value));
  }
  mountCaptionSize(session,element,objects,common) {
    const saved=common(d=>d.textSize??'medium'), value=common(captionSize)??null;
    const adjusted=(d,next,delta)=>value!==null||delta===null?next:Math.min(144,Math.max(10,captionSize(d)+delta));
    const presets=Object.entries(captionPresets(objects[0])).map(([id,value])=>({
      id,value,label:id[0].toUpperCase(),ariaLabel:`${id[0].toUpperCase()+id.slice(1)} text`,
    }));
    session.captionControl=mountPresetScrub(element,{
      label:'Text size',inputLabel:'Adjust text size',unit:'px',min:10,max:144,presets,value,
      selection:{preset:typeof saved==='string'?saved:null,custom:objects.every(d=>Number.isInteger(d.textSize))},
      preview:(next,delta)=>{
        if(next===null){
          if(session.previewingCaption){session.previewingCaption=false;this.host.syncGeometry();}
          return;
        }
        session.previewingCaption=true;
        const entries=session.ids.map(id=>this.find(id)).filter(Boolean).map(d=>
          [d.id,this.fitAutoText(d.id,{textSize:adjusted(d,next,delta)})]);
        this.host.syncGeometry({decorations:new Map(entries)});
      },
      commit:(next,{preset,delta})=>this.applyObjectFormat(session,'size',d=>preset??adjusted(d,next,delta),{finishAfterClose:true}),
    });
  }
  openObjectFormat(objects,{mode='format',trigger='text-appearance',label='Drawing options'}={}) {
    const session={
      ids:objects.map(d=>d.id),objectFormat:true,mode,trigger,label,pending:Promise.resolve(),
      destroy({commit}={}) {
        this.weightControl?.destroy({commit});
        this.captionControl?.destroy({commit});
      },
    };
    this.appearance=session;
    this.menu.classList.add('whiteboard-text-appearance');
    this.menu.setAttribute('role','dialog');
    this.menu.setAttribute('aria-label',label);
    this.menu.hidden=false;
    this.toolbar.querySelector(`[data-whiteboard-action="${trigger}"]`)?.setAttribute('aria-expanded','true');
    this.renderObjectFormat(session);
    restoreFocus(this.menu.querySelector('button'));
  }
  applyObjectFormat(session,action,value,{finishAfterClose=false}={}) {
    const boardId=this.host.snapshot.id;
    session.pending=session.pending.then(async()=>{
      if(this.host.snapshot.id!==boardId||!finishAfterClose&&this.appearance!==session)return;
      session.error='';
      try { await this.restyle(session.ids,action,value); }
      catch(error){
        session.error=error.message;
        if(this.appearance!==session)toast(error.message);
      }
      this.renderObjectFormat(session);
    });
  }
  openTextAppearance(text,mode,trigger) {
    this.menu.classList.add('whiteboard-text-appearance');
    this.menu.setAttribute('role','dialog');
    this.menu.setAttribute('aria-label',({size:'Text size',ink:'Ink',face:'Typeface',box:'Text box'})[mode]);
    this.menu.hidden=false;
    this.appearance=mountTextAppearance(this.menu,text,{
      mode,
      save:patch=>{
        const current=this.find(text.id);
        if(current?.type!=='text')throw new Error('This Text block is no longer available.');
        return this.save(text.id,patch,undefined,decorationUnchanged(current));
      },
      previewSize:size=>this.previewTextStyle(text.id,size===null?null:{textSize:size}),
      previewPadding:padding=>this.previewTextStyle(text.id,padding===null?null:{textPadding:padding}),
      fitHeight:async()=>{await this.fitText(text.id);return this.find(text.id);},
      close:()=>this.closeMenu({focus:true}),
      layout:()=>this.positionMenu(),
    });
    this.appearance.trigger=trigger;
    this.toolbar.querySelector(`[data-whiteboard-action=${trigger}]`)?.setAttribute('aria-expanded','true');
    this.positionMenu();
    this.appearance.focus();
  }
  closeMenu({focus=false,commit=true}={}) {
    const appearance=this.appearance, layout=this.containerLayout;
    const trigger=appearance?.trigger||(layout?'container-layout':'more');
    if(appearance||layout){
      this.appearance=this.containerLayout=null;
      if(appearance)appearance.destroy({commit});else layout.destroy({commit});
      this.menu.classList.remove('whiteboard-text-appearance','whiteboard-container-layout');
      this.menu.setAttribute('role','menu');
      this.menu.setAttribute('aria-label','Object actions');
      this.menu.replaceChildren();
    }
    this.menu.hidden=true;this.toolbar?.querySelector('[data-whiteboard-action=more]')?.setAttribute('aria-expanded','false');
    const opener=this.toolbar?.querySelector(`[data-whiteboard-action=${trigger}]`);
    opener?.setAttribute('aria-expanded','false');
    if(focus)opener?.focus({preventScroll:true});
  }
  async click(e) {
    if(this.suppressClick&&e.detail){this.suppressClick=false;e.preventDefault();e.stopImmediatePropagation();return;}
    const rotate=e.target.closest('[data-sticker-rotate]');
    if(rotate&&e.detail===0){
      e.preventDefault();e.stopPropagation();this.adjustSticker(rotate,15);return;
    }
    const retry=e.target.closest('[data-whiteboard-retry]');
    if(retry){e.preventDefault();e.stopPropagation();await this.saveDraft(retry.dataset.whiteboardRetry,{retry:true});return;}
    const task=e.target.closest('[data-deco-task]');
    if(task) {
      e.preventDefault();e.stopPropagation();
      if(this.host.hooks.viewOnly||this.host.mode!=='canvas'||this.editor||this.host.pointerGesture||document.querySelector('dialog[open]'))return;
      await this.toggleTask(task);return;
    }
    const port=e.target.closest('[data-port]');
    if(port&&e.detail===0){e.preventDefault();await this.choosePort(JSON.parse(port.dataset.port));return;}
    const control=e.target.closest('[data-whiteboard-action]'),action=control?.dataset.whiteboardAction;if(!action)return;
    e.preventDefault();e.stopPropagation();
    if(action==='more'){
      if(this.appearance||this.containerLayout){this.closeMenu();this.openMenu();}
      else this.menu.hidden?this.openMenu():this.closeMenu({focus:true});
      return;
    }
    if(action==='arrange'){this.closeMenu();this.host.arrangeMenu?.(control);return;}
    if(action==='close-format'){this.closeMenu({focus:true});return;}
    if(action==='drawing-color'||action==='caption-size'){
      const objects=this.selectedDecorations(), open=this.appearance?.trigger===action;
      this.closeMenu({focus:open});
      if(!open&&objects.length)this.openObjectFormat(objects,{mode:action==='drawing-color'?'color':'size',
        trigger:action,label:control.getAttribute('aria-label')});
      return;
    }
    if(['text-appearance','text-size','text-ink','text-box'].includes(action)){
      const objects=this.selectedDecorations(), open=this.appearance?.trigger===action;
      this.closeMenu({focus:open});
      if(!open&&objects.length){
        if(objects.length===1&&objects[0].type==='text')
          this.openTextAppearance(objects[0],({ 'text-size':'size','text-ink':'ink','text-box':'box','text-appearance':'face' })[action],action);
        else this.openObjectFormat(objects,{label:control.getAttribute('aria-label')});
      }
      return;
    }
    if(this.appearance?.objectFormat&&['color','heads','thickness','dashed','size','align','shape'].includes(action)){
      this.applyObjectFormat(this.appearance,action,control.dataset.value);
      return;
    }
    if(action==='container-layout'){
      if(this.containerLayout)this.closeMenu({focus:true});
      else this.configureContainer(this.find());
      return;
    }
    if(action==='container-mode'){
      const container=this.find(), layout=control.dataset.value;
      if(!container?.container||control.getAttribute('aria-pressed')==='true')return;
      this.closeMenu();
      try{const saved=this.saveContainerLayout(container.id,{layout});this.renderToolbar();await saved;}
      catch(error){this.renderToolbar();toast(`Container layout could not be saved. Open More to retry. ${error.message}`);}
      return;
    }
    const id=this.host.activeDecoration,ids=this.selectedDecorations().map(d=>d.id);this.closeMenu();
    if(action==='done'){this.commitEdit({focus:true});return;}
    if(action==='cancel-edit'){this.cancelEdit();return;}
    if(action==='edit'){this.edit(id);return;}
    if(action==='format-text'&&this.editor?.rich&&!this.editor.previewing&&!this.editor.composing){formatTextSelection(this.editor.textarea,control.dataset.value);return;}
    if(action==='text-preview'&&this.editor?.rich&&!this.editor.composing){this.setTextPreview(this.editor,!this.editor.previewing);return;}
    if(action==='retry'){this.saveDraft(id,{retry:true});return;}
    if(action==='select-section'){this.host.selectSection(id);return;}
    if(action==='stack-front'||action==='stack-back'){await this.host.restackSelection(action==='stack-front'?'front':'back');return;}
    if(action==='canvas-group'){await this.host.toggleCanvasGroup();return;}
    this.commitEdit({focus:false});
    if(['color','route','heads','thickness','dashed','size','align','shape'].includes(action)){try{await this.restyle(ids,action,control.dataset.value);}catch(error){showFailure(error);}return;}
    try {
      if(action==='wrap-container')await this.createContainer(undefined,this.selectedDecorations());
      if(action==='attach-container')await this.attachContainerSelection(this.selectedDecorations());
      if(action==='container-detach')await this.detachContainerChild(id);
      if(action==='reverse')await this.restyle(ids,'reverse');
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
  async save(id,patch,options,unchanged,extra) {
    this.host.decorationCommitting=true;
    const fitted=this.fitAutoText(id,patch),text=this.find(id);
    const operation={boardId:this.host.snapshot.id,decorationId:id,patch:fitted,...extra};
    if(fitted!==patch&&text)this.syncDragGeometry(text,{...text,...fitted});
    try{await (unchanged?this.host.writeArrangement('updateDecoration',operation,unchanged):this.host.writeStructural('updateDecoration',operation,options));await this.host.refresh({saveReview:false});}
    catch(error){if(fitted!==patch)this.host.syncGeometry();throw error;}
    finally{this.host.decorationCommitting=false;this.host.hooks.liveReady?.();}
  }
  async fitText(id) {
    const text=this.find(id);
    if(text?.type!=='text'||text.sticker||this.editor)return;
    if(this.drafts.has(id)){toast('Save the Text block before fitting its height.');return;}
    const height=this.measureTextHeight(text);
    if(height!==null&&height!==text.height)
      await this.save(id,{height},undefined,decorationUnchanged(text));
  }
  fitAutoText(id,patch) {
    if('height' in patch||!Object.keys(patch).some(key=>['text','textSize','textFace','textBorder','textPadding','textSizing'].includes(key)))return patch;
    const text=this.find(id);
    if(text?.type!=='text'||(patch.textSizing??text.textSizing)!=='auto')return patch;
    const height=this.measureTextHeight({...text,...patch});
    return height===null||height===text.height?patch:{...patch,height};
  }
  previewTextStyle(id,patch) {
    if(patch===null){
      if(this.textStylePreview===id){this.textStylePreview=null;this.host.syncGeometry();}
      return;
    }
    const text=this.find(id);
    if(text?.type!=='text'||text.sticker)return;
    this.textStylePreview=id;
    this.syncDragGeometry(text,{...text,...this.fitAutoText(id,patch)});
  }
  previewEditorHeight(session) {
    const saved=this.find(session.id);
    if(saved?.textSizing!=='auto')return;
    cancelAnimationFrame(session.heightFrame);
    session.heightFrame=requestAnimationFrame(()=>{
      if(this.editor!==session)return;
      const area=session.textarea,next={...saved,text:area.value};
      const rendered=this.measureTextHeight(next);
      if(rendered===null)return;
      // The source can wrap sooner than its rendered Markdown while editing.
      // Measure the live textarea independently of its current fitted height.
      let height=rendered;
      if(!session.previewing){
        area.style.height='0';
        height=Math.max(height,area.scrollHeight+area.offsetHeight-area.clientHeight);
        area.style.height='';
      }
      height=Math.min(100000,Math.max(20,height));
      if(height===session.previewHeight)return;
      session.previewHeight=height;
      this.syncDragGeometry(saved,{...saved,height});
    });
  }
  measureTextHeight(text) {
    const element=document.querySelector(selector(text.id));
    if(!element)return null;
    // Use saved logical width, without a scrollbar or canvas zoom calculation.
    const sample=document.createElement('template');
    sample.innerHTML=decorationMarkup(text,this.host.snapshot,{x:0,y:0});
    const box=sample.content.firstElementChild;
    const label=box.querySelector(':scope > [data-decoration-label]');
    box.removeAttribute('data-decoration');
    box.style.visibility='hidden';
    box.inert=true;
    Object.assign(label.style,{height:'auto',overflow:'hidden'});
    element.after(box);
    const measured=parseFloat(getComputedStyle(label).height);
    box.remove();
    return Number.isFinite(measured)?Math.min(100000,Math.max(20,Math.ceil(measured))):null;
  }
  async createContainer(screen, selected=[]) {
    const board=this.host.snapshot;
    const free=selected.filter(entry=>canContain(entry)&&!containerFor(board.decorations,entry.id))
      .sort((a,b)=>a.y-b.y||a.x-b.x);
    const padding=16;
    const point=free.length?{x:Math.min(...free.map(entry=>entry.x))-padding,y:Math.min(...free.map(entry=>entry.y))-padding}:this.host.canvasPoint(screen);
    const decoration={id:crypto.randomUUID(),type:'region',color:'#dbe5d3',text:'',...point,width:144,height:64,
      container:{layout:'vertical',children:free.map(entry=>entry.id)}};
    const unchanged=free.map(decorationUnchanged);
    const initialText=selected.length===0;
    let initialTextId;
    this.host.decorationCommitting=true;
    try {
      const fit=this.fitIncomingChildren(free);
      if(fit.size)await this.saveMany([...board.decorations.map(entry=>fit.get(entry.id)||entry),decoration]);
      else {
        const created=await this.host.writeArrangement('createDecoration',{
          boardId:board.id,decoration,...(initialText?{initialText:true}:{})
        },latest=>unchanged.every(check=>check(latest)));
        initialTextId=created.initialTextId;
        await this.host.refresh({saveReview:false});
      }
      const selectedId=initialTextId||decoration.id;
      this.select(selectedId);
      document.querySelector(selector(selectedId))?.focus({preventScroll:true});
      if(initialTextId)this.edit(initialTextId,true);
      return initialTextId;
    } finally {this.host.decorationCommitting=false;this.host.hooks.liveReady?.();}
  }
  async attachContainerSelection(list) {
    const parent=list.find(entry=>entry.container);
    if(!parent)return;
    const free=list.filter(entry=>canContain(entry)&&!containerFor(this.host.snapshot.decorations,entry.id))
      .sort((a,b)=>a.y-b.y||a.x-b.x);
    if(!free.length)return;
    const children=[...parent.container.children,...free.map(entry=>entry.id)];
    const container={...parent.container,children}, fit=this.fitIncomingChildren(free);
    const unchanged=[parent,...free].map(decorationUnchanged);
    if(fit.size)await this.saveMany(this.host.snapshot.decorations.map(entry=>entry.id===parent.id?{...entry,container}:fit.get(entry.id)||entry));
    else await this.save(parent.id,{container},undefined,latest=>unchanged.every(check=>check(latest)));
    this.select(parent.id);
  }
  fitIncomingChildren(entries) {
    const fit=new Map();
    for(const entry of entries) {
      if(entry.type!=='text'||entry.sticker)continue;
      const height=this.measureTextHeight(entry);
      if(height>entry.height)fit.set(entry.id,{...entry,height});
    }
    return fit;
  }
  async detachContainerChild(id) {
    const parent=containerFor(this.host.snapshot.decorations,id);
    const child=this.find(id);
    if(!parent||!child)return;
    const children=parent.container.children.filter(child=>child!==id);
    const right=parent.x+parent.width+24, left=parent.x-child.width-24;
    const x=right<=10000000?right:left>=-10000000?left:child.x;
    await this.saveMany(this.host.snapshot.decorations.map(entry=>entry.id===id?{...entry,x}:
      entry.id===parent.id?{...entry,container:{...parent.container,children}}:entry));
  }
  configureContainer(parent) {
    if(!parent?.container)return;
    this.closeMenu();
    const trigger=this.toolbar.querySelector('[data-whiteboard-action=container-layout]');
    this.menu.classList.add('whiteboard-container-layout');
    this.menu.setAttribute('role','dialog');
    this.menu.setAttribute('aria-label','Container options');
    this.menu.hidden=false;
    const draft=this.containerLayoutDrafts?.get(parent.id);
    this.containerLayout=mountContainerLayout(this.menu,parent.container,{
      draft:draft?.pending,failedDraft:draft?.failed,
      save:fields=>this.saveContainerLayout(parent.id,fields),
      preview:patch=>this.previewLayoutSpacing(parent.id,patch),
      reposition:()=>this.positionMenu(),
      report:error=>toast(`Container layout could not be saved. Open More to retry. ${error.message}`),
    });
    trigger?.setAttribute('aria-expanded','true');
    this.containerLayout.focus();
  }
  previewLayoutSpacing(id,patch) {
    if(patch===null){
      const held=this.layoutSpacingPreview;
      if(held?.id===id){
        this.layoutSpacingPreview=null;
        this.host.positionContainerCards(held.placements);
        this.host.syncGeometry();
      }
      return;
    }
    const parent=this.find(id);
    if(!parent?.container)return;
    // The size control may also have a queued change to the other dimension.
    const geometry=previewContainerLayout(this.host.snapshot,parent,{gap:patch.gap,padding:patch.padding});
    if(!geometry)return;
    this.layoutSpacingPreview={id,placements:geometry.originalPlacements};
    this.host.positionContainerCards(geometry.placements);
    this.host.syncGeometry(geometry);
  }
  saveContainerLayout(id,fields) {
    const drafts=this.containerLayoutDrafts??=new Map();
    const draft=drafts.get(id)||{pending:{},failed:{}};
    drafts.set(id,draft);
    Object.assign(draft.pending,fields);
    const write=(this.containerLayoutWrite||Promise.resolve()).catch(()=>{}).then(async()=>{
      const parent=this.find(id);
      if(!parent?.container)throw Error('The container is no longer on this board.');
      await this.save(id,{container:{...parent.container,...fields}},undefined,decorationUnchanged(parent));
      for(const [key,value] of Object.entries(fields)) {
        if(draft.pending[key]===value)delete draft.pending[key];
        if(draft.failed[key]===value)delete draft.failed[key];
      }
      if(!Object.keys(draft.pending).length)drafts.delete(id);
    }).catch(error=>{
      for(const [key,value] of Object.entries(fields)) if(draft.pending[key]===value)draft.failed[key]=value;
      throw error;
    });
    this.containerLayoutWrite=write;
    return write;
  }
  async createLine(patch) {
    const d={...patch,id:patch.id||crypto.randomUUID(),type:'line',text:patch.text||'',color:patch.color||'palette:sage',endArrow:patch.endArrow??true,route:patch.route||'curved'};
    if(d.route==='curved'&&d.bend===undefined){const {from,to}=resolveLine(d,this.host.snapshot);d.bend=defaultArrowBend(from,to);}
    await this.host.writeArrangement('createDecoration',{boardId:this.host.snapshot.id,decoration:d},endpointsUnchanged(d,this.host.snapshot));
    this.host.activeDecoration=d.id;this.connectMode=false;this.pendingFrom=null;this.hint.hidden=true;
    await this.host.refresh({saveReview:false});this.sync();
  }
  async remove() {
    const many=this.selectedDecorations();
    if(many.length>1) {
      // Several selected: one atomic board write removes them all.
      const gone=new Set(many.map(d=>d.id));this.host.decorationSelection=new Set();this.connectMode=false;this.pendingFrom=null;
      await this.host.history.group(`Delete ${gone.size} drawn elements`,()=>this.saveMany(this.host.snapshot.decorations.filter(d=>!gone.has(d.id))));this.sync();return;
    }
    const id=this.host.activeDecoration;if(!id)return;
    this.cancelEdit({focus:false});this.host.activeDecoration=null;this.connectMode=false;this.pendingFrom=null;
    await this.host.writeStructural('removeDecoration',{boardId:this.host.snapshot.id,decorationId:id});await this.host.refresh({saveReview:false});this.sync();
  }
  persistDrafts() {
    try { localStorage.setItem(this.draftKey,JSON.stringify(Object.fromEntries([...this.drafts].map(([id,draft])=>[id,{...draft,pending:false}])))); } catch {}
  }
  orphanDraft() {
    return [...this.drafts].find(([id,draft])=>draft.nativeText&&this.find(id)?.type!=='text');
  }
  recoverText() {
    const orphan=this.orphanDraft();if(!orphan)return;
    const [id,draft]=orphan;
    const dialog=makeDialog('Recover unsaved text',`<p>This Text block is no longer on the board. Copy the draft to keep working.</p><label>Your text<textarea readonly>${esc(draft.text)}</textarea></label><button type="button" data-discard-text-draft>Discard draft</button>`);
    dialog.querySelector('[data-discard-text-draft]').onclick=()=>{
      if(this.drafts.get(id)===draft)this.drafts.delete(id);
      this.persistDrafts();this.sync();
      dialog.querySelector('.workspace-close').click();
    };
  }
  captureTask(task) {
    const d=this.find(task.closest('[data-decoration]')?.dataset.decoration);
    if(d?.type==='text')this.taskActivations.set(task,{id:d.id,text:d.text??'',offset:task.dataset.decoTask});
  }
  async toggleTask(task) {
    const d=this.find(task.closest('[data-decoration]')?.dataset.decoration);
    if(d?.type!=='text'||this.drafts.has(d.id))return;
    const activation=this.taskActivations.get(task);this.taskActivations.delete(task);
    if(activation&&(activation.id!==d.id||activation.text!==(d.text??'')||activation.offset!==task.dataset.decoTask)){
      toast('The text changed. Choose the task again.');return;
    }
    const original=d.text??'', next=toggleDecorationTask(original,Number(task.dataset.decoTask));
    if(next===null)return;
    this.drafts.set(d.id,{text:next,original,nativeText:true,source:this.host.client.captureStructural('updateDecoration',{boardId:this.host.snapshot.id,decorationId:d.id,patch:{text:''}},this.host.structuralSource()),operationId:crypto.randomUUID(),pending:false,error:null});
    await this.saveDraft(d.id);
  }
  setTextPreview(session,show) {
    if(this.editor!==session)return;
    session.previewing=show;
    if(show){
      session.preview.innerHTML=formatToHTMLString(session.textarea.value,{rich:true});
      session.preview.hidden=false;restoreFocus(session.preview);session.textarea.hidden=true;
    }else{
      session.textarea.hidden=false;restoreFocus(session.textarea);session.preview.hidden=true;
    }
    this.previewEditorHeight(session);
    this.renderToolbar();
  }
  edit(id,select=false) { this.beginEdit(id,select); }
  beginEdit(id,select=false) {
    if(this.host.hooks.viewOnly)return;
    if(this.editor?.id===id){this.editor.textarea.focus({preventScroll:true});return;}
    if(this.editor){this.editor.nextEdit={id,select};this.commitEdit({focus:false});return;}
    const d=this.find(id),element=document.querySelector(selector(id));if(!d||d.sticker||!element)return;
    this.select(id);this.cancel();
    const existingDraft=this.drafts.get(id);
    if(existingDraft?.pending)return;
    if(existingDraft?.nativeText&&d.type!=='text'){toast('Open Inspector → Edit to recover the earlier Text draft first.');return;}
    const original=existingDraft?.text??d.text??'',rich=d.type==='text';
    const form=document.createElement('form');form.className='whiteboard-editor';
    form.innerHTML=`<textarea name="text" aria-label="${esc(rich?'Text block':d.type==='line'?'Arrow label':d.shape==='rectangle'?'Sticky note text':'Object text')}" spellcheck="true"></textarea>`;
    const textarea=form.querySelector('textarea');textarea.value=original;
    const session={id,original,source:this.host.client.captureStructural('updateDecoration',{boardId:this.host.snapshot.id,decorationId:d.id,patch:{text:''}},this.host.structuralSource()),baseText:existingDraft?.original??d.text??'',initialValue:textarea.value,form,textarea,rich,composing:false,requested:false,finishing:false,finishFocus:false};
    if(rich){
      form.classList.add('whiteboard-markdown-editor');textarea.placeholder='Write something';
      const preview=document.createElement('div');preview.className='deco-body whiteboard-text-preview';preview.hidden=true;
      preview.tabIndex=-1;preview.setAttribute('role','region');preview.setAttribute('aria-label','Text preview');
      form.append(preview);session.preview=preview;
      textarea.addEventListener('keydown',e=>{
        if(e.isComposing||session.composing||e.keyCode===229||e.repeat||e.shiftKey||e.altKey||(!e.metaKey&&!e.ctrlKey))return;
        const command={b:'bold',i:'italic',e:'code'}[e.key.toLowerCase()];
        if(command){e.preventDefault();formatTextSelection(textarea,command);}
      });
    }
    this.editor=session;element.append(form);element.classList.add('whiteboard-editing');
    if(rich&&d.textSizing==='auto'){
      textarea.addEventListener('input',()=>this.previewEditorHeight(session));
      this.previewEditorHeight(session);
    }
    session.binding=bindForm(form,{submit:async values=>{
      if(!session.requested)session.finishFocus=true;
      const text=String(values.get('text')??'');
      return this.finishEditor(session,text===session.initialValue?session.original:text);
    },onError:()=>{}});
    form.addEventListener('keydown',event=>{
      if(rich&&event.key==='Tab'&&!event.shiftKey&&!this.toolbar.hidden){
        event.preventDefault();restoreFocus(this.toolbar.querySelector('button'));
      }
      if(event.key!=='Escape')event.stopPropagation();
    });
    if(d.type==='line') {
      // Arrow labels edit in place on the line: Enter (or Escape) keeps the text.
      const label=element.querySelector('.whiteboard-line-label');form.classList.add('whiteboard-label-editor');
      Object.assign(form.style,{left:label?.style.left||'50%',top:label?.style.top||'50%'});
      textarea.rows=1;textarea.placeholder='Label';
      textarea.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&!session.composing){event.preventDefault();this.commitEdit({focus:true});}});
    }
    textarea.addEventListener('compositionstart',()=>{session.composing=true;});
    textarea.addEventListener('compositionend',()=>{session.composing=false;if(session.requested)queueMicrotask(()=>this.submitEditor(session));});
    form.addEventListener('focusout',event=>{
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
    session.finishing=true;this.editor=null;cancelAnimationFrame(session.heightFrame);session.binding.destroy();session.form.remove();
    document.querySelector(selector(session.id))?.classList.remove('whiteboard-editing');
    if(text!==session.original||this.drafts.has(session.id)) {
      const prior=this.drafts.get(session.id);
      this.drafts.set(session.id,{text,original:prior?.original??session.baseText,nativeText:session.rich,source:prior ? prior.source : session.source,
        operationId:prior?.text===text?prior.operationId:crypto.randomUUID(),pending:false,error:null});
      this.persistDrafts();
    }
    this.host.syncGeometry();
    if(session.finishFocus&&this.host.activeDecoration===session.id)restoreFocus(document.querySelector(selector(session.id)));
    if(session.nextEdit)this.beginEdit(session.nextEdit.id,session.nextEdit.select);
    if(this.drafts.has(session.id))await this.saveDraft(session.id);
    this.host.drainGeometryRefresh();this.host.hooks.liveReady?.();
  }
  cancelEdit({focus=true}={}) {
    const session=this.editor;if(!session||session.finishing)return;
    session.finishing=true;this.editor=null;cancelAnimationFrame(session.heightFrame);session.binding.destroy();session.form.remove();
    document.querySelector(selector(session.id))?.classList.remove('whiteboard-editing');
    // A draft that predates this session is still recoverable after cancel.
    if(this.drafts.has(session.id)){const draft=this.drafts.get(session.id);draft.text=session.original;this.persistDrafts();}
    this.host.syncGeometry();if(focus)restoreFocus(document.querySelector(selector(session.id)));
    this.host.drainGeometryRefresh();this.host.hooks.liveReady?.();
  }
  async saveDraft(id,{retry=false,reviewed=false}={}) {
    const draft=this.drafts.get(id);if(!draft||draft.pending)return;
    if(retry) {
      try { await this.host.refresh({saveReview:false}); }
      catch { toast('Could not read the latest text. Your draft is still here.');return; }
      if(this.drafts.get(id)!==draft||draft.pending)return;
      if(draft.nativeText&&this.find(id)?.type!=='text'){this.sync();return;}
      const saved=this.find(id)?.text??'';
      if(saved===draft.text){this.drafts.delete(id);this.persistDrafts();this.sync();return;}
      if((saved!==draft.original||draft.conflict||!draft.source)&&!reviewed) {
        makeDialog('Review changed text',`<p>${!draft.source ? 'This draft has no saved conflict facts. Review the current text before saving.' : saved!==draft.original ? "This object's saved text changed elsewhere. Review both versions before saving." : "This object's arrangement changed elsewhere. Review its current board before saving this text."}</p><label>Saved text<textarea readonly>${esc(saved)}</textarea></label><label>Your text<textarea name="text">${esc(draft.text)}</textarea></label><button type="submit" class="workspace-primary">Save reviewed text</button>`,async values=>{
          draft.text=String(values.get('text')??'');draft.original=saved;draft.source=this.host.client.captureStructural('updateDecoration',{boardId:this.host.snapshot.id,decorationId:id,patch:{text:''}},this.host.structuralSource());draft.operationId=crypto.randomUUID();draft.error=null;draft.conflict=false;
          await this.saveDraft(id,{reviewed:true});
          if(draft.error)throw new Error(draft.error);
        });return;
      }
    }
    const d=this.find(id), nativeText=draft.nativeText||d?.type==='text';
    if(nativeText&&d?.type!=='text'){this.sync();return;}
    if(nativeText&&(d.text??'')!==draft.original){
      draft.error='Text changed elsewhere. Review before retrying.';draft.conflict=true;this.persistDrafts();this.sync();return;
    }
    const source=draft.source || {revision:-1};
    draft.pending=true;draft.error=null;this.persistDrafts();this.sync();
    try {
      const patch=this.fitAutoText(id,{text:draft.text});
      if(patch.height!==undefined)this.syncDragGeometry(d,{...d,...patch});
      await this.host.writeStructural('updateDecoration',{boardId:this.host.snapshot.id,decorationId:id,patch},{operationId:draft.operationId},source);
      if(this.find(id))Object.assign(this.find(id),patch);
      if(this.drafts.get(id)===draft)this.drafts.delete(id);
      await this.host.refresh({saveReview:false});
    }catch(error){
      draft.pending=false;draft.conflict=!!error.conflict;draft.error=error.conflict?'Text changed elsewhere. Review before retrying.':'Could not save text. Retry when the connection is available.';
      if(nativeText&&error.conflict){
        try { await this.host.refresh({saveReview:false}); } catch {}
        if(this.find(id)?.type!=='text')toast('Open Inspector → Edit to recover your unsaved text.');
      }
    }
    finally{draft.pending=false;this.persistDrafts();this.host.syncGeometry();this.host.hooks.liveReady?.();}
  }
  // Where a dragged arrow end would attach: an exact port within reach first,
  // else the smallest target under (or just outside) the pointer, on its nearest side.
  snapAt(point) {
    const board=this.host.snapshot,pad=14/this.host.hooks.zoom(),port=this.nearest(point);
    let hover=null,area=Infinity;
    for(const ref of this.targets()) {
      const b=targetBox(ref,board,this.overrides);if(!b)continue;
      if(point.x>=b.x-pad&&point.x<=b.x+b.width+pad&&point.y>=b.y-pad&&point.y<=b.y+b.height+pad&&b.width*b.height<area){hover={ref,box:b};area=b.width*b.height;}
    }
    if(!hover||port)return port?{endpoint:port,ref:port.placementId?{placementId:port.placementId}:{decorationId:port.decorationId}}:null;
    const b=hover.box,distance={top:Math.abs(point.y-b.y),right:Math.abs(b.x+b.width-point.x),bottom:Math.abs(b.y+b.height-point.y),left:Math.abs(point.x-b.x)};
    return {endpoint:{...hover.ref,side:sides.reduce((best,side)=>distance[side]<distance[best]?side:best)},ref:hover.ref};
  }
  highlight(ref) {
    const element=!ref?null:ref.decorationId?document.querySelector(selector(ref.decorationId)):document.querySelector(`#world .workspace-card[data-placement="${CSS.escape(ref.placementId)}"]`);
    if(this.highlighted&&this.highlighted!==element)this.highlighted.classList.remove('whiteboard-snap-target');
    element?.classList.add('whiteboard-snap-target');this.highlighted=element;
  }
  nearest(point) {
    let best=null,distance=20/this.host.hooks.zoom();
    for(const ref of this.targets())for(const side of sides){const endpoint={...ref,side},p=resolveEndpoint(endpoint,this.host.snapshot,this.overrides),n=Math.hypot(point.x-p.x,point.y-p.y);if(n<=distance){distance=n;best=endpoint;}}
    return best;
  }
  down(e) {
    this.suppressClick=false;
    if(this.host.panTool&&e.target.closest('#viewport'))return;
    const own=e.target.closest('.whiteboard-toolbar,.whiteboard-menu,.whiteboard-editor,.whiteboard-draft-state');
    if(this.editor&&!own&&!e.target.closest(selector(this.editor.id)))this.commitEdit({focus:false});
    const menuLauncher=e.target.closest('[data-whiteboard-action]')?.dataset.whiteboardAction;
    if(!e.target.closest('.whiteboard-menu')&&!['more','text-appearance','text-size','text-ink','text-box','drawing-color','caption-size','container-layout'].includes(menuLauncher))this.closeMenu();
    if(this.drag){if(e.pointerId!==this.drag.pointerId)this.cancel();return;}
    if(own)return;
    const port=e.target.closest('[data-port]'),element=e.target.closest('[data-decoration]');
    if(!port&&!element){
      if(e.target.closest('#world .workspace-card')&&(e.shiftKey||e.metaKey||e.ctrlKey||e.target.closest('[data-placement-select]')))return;
      if(e.target.closest('#viewport')&&!e.target.closest('.whiteboard-ports'))this.clearSelection({finishEdit:true,focus:false});
      return;
    }
    if(this.host.mode!=='canvas'||e.button!==0||e.isPrimary===false||document.querySelector('dialog[open]')||this.host.pointerGesture||this.host.movePending)return;
    const task=e.target.closest('[data-deco-task]');
    if(task){this.captureTask(task);return;}
    if(e.target.closest('input,textarea,[contenteditable]'))return;
    let d=element&&this.find(element.dataset.decoration);if(!port&&!d)return;
    const resize=e.target.closest('[data-decoration-resize]')?.dataset.decorationResize;
    const endpoint=e.target.closest('[data-endpoint]')?.dataset.endpoint;
    const bending=!!e.target.closest('[data-arrow-bend]');
    const rotating=!!(d?.sticker&&e.target.closest('[data-sticker-rotate]'));
    // Toggle the whole saved group when the drawing belongs to one.
    if((e.shiftKey||e.metaKey||e.ctrlKey)&&!e.altKey&&d&&!port&&!resize&&!endpoint&&!bending&&!rotating) {
      this.host.toggleOccurrence({decorationId:d.id});
      this.suppressClick=true;e.preventDefault();e.stopImmediatePropagation();return;
    }
    if(d?.type==='region'&&!d.shape&&!d.container&&!e.target.closest('[data-decoration-label],button')) {
      const r=element.getBoundingClientRect();if(e.clientX>r.left+6&&e.clientX<r.right-6&&e.clientY>r.top+28&&e.clientY<r.bottom-6)return;
    }
    const point=this.host.canvasPoint({x:e.clientX,y:e.clientY});
    if(port) {
      const ref=JSON.parse(port.dataset.port),from=this.pendingFrom||ref,p=resolveEndpoint(from,this.host.snapshot);
      d={id:crypto.randomUUID(),type:'line',text:'',color:'palette:sage',endArrow:true,route:'curved',...lineBox(p,p),from,to:pointOnly(p)};
      this.drag={d,creating:true,endpoint:'to',port:ref,choosing:!!this.pendingFrom};
    } else {
      this.select(d.id);this.drag={d:structuredClone(d),endpoint,resize,bending,rotating};
    }
    Object.assign(this.drag,{pointerId:e.pointerId,x:e.clientX,y:e.clientY,point,active:false,zoom:this.host.hooks.zoom()});
    this.host.decorationGesture=true;this.host.updateHistoryControls();e.preventDefault();e.stopImmediatePropagation();
  }
  move(e) {
    const g=this.drag;if(!g||e.pointerId!==g.pointerId)return;
    if(!g.active&&Math.hypot(e.clientX-g.x,e.clientY-g.y)<5)return;
    g.active=true;e.preventDefault();e.stopImmediatePropagation();
    const dx=(e.clientX-g.x)/g.zoom,dy=(e.clientY-g.y)/g.zoom,d=g.d;
    if(g.rotating) {
      const point=this.host.canvasPoint({x:e.clientX,y:e.clientY});
      const turn=(d.rotation||0)+stickerDirection(point,d)-stickerDirection(g.point,d);
      const rotation=stickerAngle(e.shiftKey?Math.round(turn/15)*15:turn);
      g.next={...d,rotation};
      this.hint.hidden=false;this.hint.textContent=`${rotation}°`;
    } else if(g.endpoint) {
      const p=this.host.canvasPoint({x:e.clientX,y:e.clientY}),hit=this.snapAt(p),snap=hit?.endpoint,r=resolveLine(d,this.host.snapshot);
      g.snap=hit;this.highlight(hit?.ref);
      const from=g.endpoint==='from'?snap||p:d.from||pointOnly(r.from),to=g.endpoint==='to'?snap||p:d.to||pointOnly(r.to);
      g.next={...d,from,to};const geometry=resolveLine(g.next,this.host.snapshot);Object.assign(g.next,lineBox(geometry.from,geometry.to));
      if(g.creating)g.next.bend=defaultArrowBend(geometry.from,geometry.to);
      this.hint.hidden=false;this.hint.textContent=snap?`Release to attach to ${this.name(snap)} (${snap.side})`:'Release to leave this end free.';
    } else if(g.bending) {
      const resolved=resolveLine(d,this.host.snapshot);
      const point=linePath(resolved,d.route,d.bend).bendPoint;
      g.next={...d,bend:arrowBendAt(resolved,{x:point.x+dx,y:point.y+dy})};
    } else if(d.type==='line') {
      if(isAttachment(d.from)||isAttachment(d.to)) {
        g.blocked=true;this.hint.hidden=false;this.hint.textContent='Drag an endpoint to move or detach it.';return;
      }
      const r=resolveLine(d,this.host.snapshot),from={x:Math.round(r.from.x+dx),y:Math.round(r.from.y+dy)},to={x:Math.round(r.to.x+dx),y:Math.round(r.to.y+dy)};
      g.next={...d,...lineBox(from,to),from,to};
    } else {
      // Smart guides: edges and centres snap to other objects (⌘/Ctrl held turns it off).
      let sx=dx,sy=dy;
      const proportional=!!(g.resize?.length===2&&(d.sticker||e.shiftKey));
      if(!g.creating&&!proportional&&!snapDisabled(e,isMacPlatform())) {
        g.snapTargets||=this.host.snapTargets(new Set(containerPlacementIds(d.container)),new Set(expandContainerSelection(this.host.snapshot.decorations,[d.id])));
        const proposed=g.resize?resizeDecoration(d,g.resize,dx,dy,false):{...d,x:d.x+dx,y:d.y+dy};
        const r=snapBox(proposed,g.snapTargets,6/g.zoom,{resize:g.resize||false});
        sx+=r.dx;sy+=r.dy;this.host.showGuides(r.guides);
      } else this.host.showGuides([]);
      const geometry=g.resize
        ? resizeDecoration(d,g.resize,Math.round(sx),Math.round(sy),proportional)
        : {x:Math.round(d.x+sx),y:Math.round(d.y+sy)};
      g.next={...d,...geometry};
      if(g.resize&&d.textSizing==='auto'&&(geometry.width!==d.width||geometry.height!==d.height))g.next.textSizing='fixed';
    }
    if(g.creating) {
      const old=document.querySelector(selector(d.id));
      if(old)old.remove();document.getElementById('world').insertAdjacentHTML('beforeend',decorationMarkup(g.next,this.host.snapshot,this.host.origin,true));
    }
    this.syncDragGeometry(d,g.next);
    if(!g.endpoint&&!g.resize&&!g.creating&&!g.bending&&!g.rotating){
      const screen={x:e.clientX,y:e.clientY};
      const target=this.containerDropFor(d,screen);
      this.host.showContainerDrop(target.hit);
      const message=containerDropLabel(target.hit,target.inside&&target.source);
      this.hint.hidden=!message;this.hint.textContent=message;
      document.querySelector(selector(d.id))?.classList.add('whiteboard-dragging');
    }
  }
  containerDropFor(d,screen) {
    const member={decorationId:d.id}, inside=this.host.containerCanvasContains(screen);
    const allowed=canContain(d)&&!this.host.groupForOccurrence(member);
    const source=allowed?containerFor(this.host.snapshot.decorations,d.id):null;
    return {member,inside,source,hit:this.host.containerDragTarget(member,screen,allowed)};
  }
  syncDragGeometry(previous,next) {
    const overrides=previewContainerMove(this.host.snapshot,previous,next||previous);
    this.host.positionContainerCards(overrides.placements);
    this.host.syncGeometry(next?overrides:undefined);
  }
  finish(settled) {
    const g=this.drag;this.drag=null;this.host.decorationGesture=false;this.hint.hidden=true;this.highlight(null);this.host.showGuides?.([]);
    this.host.showContainerDrop(null);
    // A released drop keeps its geometry until the save reconciles or rolls back.
    this.syncDragGeometry(g.d,settled);this.host.updateHistoryControls();this.host.hooks.liveReady?.();return g;
  }
  cancel() {
    if(this.drag){const g=this.finish();if(g.creating)document.querySelector(selector(g.d.id))?.remove();}
    this.pendingFrom=null;this.connectMode=false;this.hint.hidden=true;this.renderPorts();this.renderToolbar();this.host.drainGeometryRefresh();
  }
  async up(e) {
    const g=this.drag;if(!g||e.pointerId!==g.pointerId)return;
    const drop=!g.endpoint&&!g.resize&&!g.creating&&!g.bending&&!g.rotating?this.containerDropFor(g.d,{x:e.clientX,y:e.clientY}):null;
    if(g.active&&drop?.source&&!drop.inside){this.cancel();this.suppressClick=true;e.preventDefault();e.stopImmediatePropagation();return;}
    // Hold live reconciliation from release until the save, so a snapshot read
    // before it cannot repaint the original geometry.
    const commit=!!(g.active&&g.next);if(commit){this.host.decorationCommitting=true;this.host.hooks.holdView?.();}
    const done=this.finish(commit&&!g.creating?g.next:null);
    if(!done.active||!done.next) {
      if(done.active){e.preventDefault();e.stopImmediatePropagation();this.suppressClick=true;setTimeout(()=>this.suppressClick=false,0);}
      if(done.port&&!done.active) { e.preventDefault();e.stopImmediatePropagation();this.suppressClick=true;await this.choosePort(done.port); }
      this.host.drainGeometryRefresh();return;
    }
    e.preventDefault();e.stopImmediatePropagation();this.suppressClick=true;setTimeout(()=>this.suppressClick=false,0);
    try {
      // The drawn arrow stays until the saved one takes its place (same keyed element).
      if(done.creating)await this.createLine(done.next);
      else if(done.rotating){
        if((done.d.rotation||0)!==done.next.rotation)await this.save(done.d.id,{rotation:done.next.rotation},undefined,decorationUnchanged(done.d));
      }
      else if(done.bending)await this.save(done.d.id,{bend:done.next.bend},undefined,decorationUnchanged(done.d));
      else if(drop?.source||drop?.hit&&!drop.hit.blocked)await this.host.transferContainerMember(drop.member,drop.source,drop.hit,done.next);
      // A dragged drop may come forward (the store's drop rule); a resize never reorders.
      else {const {id,...patch}=done.next;await this.save(id,patch,undefined,decorationUnchanged(done.d),done.resize?undefined:{restack:'drop'});}
    } catch(error){if(done.creating)document.querySelector(selector(done.d.id))?.remove();showFailure(error);this.host.rebuild();}
    finally{this.host.decorationCommitting=false;this.host.hooks.liveReady?.();this.host.drainGeometryRefresh();}
  }
  handleEscape(e) {
    if(e.key!=='Escape')return false;
    if(this.drag||this.pendingFrom||this.connectMode){this.cancel();return true;}
    // Escape keeps what was typed (as in Figma or Miro): it commits and leaves edit mode.
    // Discarding stays an explicit choice (the toolbar's cancel-edit action).
    if(this.editor){if(e.isComposing||e.keyCode===229||this.editor.composing)return false;this.commitEdit({focus:true});return true;}
    if(!this.menu.hidden){this.closeMenu({focus:true,commit:false});return true;}
    if(this.host.decorationSelection?.size>1){this.clearSelection();return true;}
    return false;
  }
  arrowHandleKey(e) {
    const handle=e.target.closest('[data-endpoint],[data-arrow-bend]');
    if(!handle||e.altKey||e.metaKey||e.ctrlKey)return false;
    const direction={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]}[e.key];
    const endpoint=handle.dataset.endpoint;
    const detach=endpoint&&['Delete','Backspace'].includes(e.key);
    if(!direction&&!detach)return false;
    e.preventDefault();e.stopImmediatePropagation();
    if(e.repeat||this.host.commandBusy()||this.host.decorationCommitting)return true;
    const d=this.find(handle.closest('[data-decoration]')?.dataset.decoration);
    if(d?.type!=='line')return true;
    const geometry=resolveLine(d,this.host.snapshot),step=e.shiftKey?10:1;
    const shifted=point=>({x:point.x+(direction?.[0]||0)*step,y:point.y+(direction?.[1]||0)*step});
    let patch;
    if(endpoint){
      if(detach&&!isAttachment(d[endpoint]))return true;
      const from=endpoint==='from'?shifted(geometry.from):d.from||pointOnly(geometry.from);
      const to=endpoint==='to'?shifted(geometry.to):d.to||pointOnly(geometry.to);
      const next=resolveLine({...d,from,to},this.host.snapshot);
      patch={from,to,...lineBox(next.from,next.to)};
    }else{
      const {bendPoint}=linePath(geometry,d.route,d.bend);
      if(!bendPoint)return true;
      patch={bend:arrowBendAt(geometry,shifted(bendPoint))};
      if(patch.bend===d.bend)return true;
    }
    this.save(d.id,patch,undefined,decorationUnchanged(d)).then(()=>{
      if(document.activeElement===document.body||document.activeElement===handle)
        restoreFocus(document.querySelector(selector(d.id))?.querySelector(endpoint?`[data-endpoint="${endpoint}"]`:'[data-arrow-bend]'));
    }).catch(showFailure);
    return true;
  }
  keydown(e) {
    const task=e.target.closest('[data-deco-task]');
    if(task&&[' ','Enter'].includes(e.key)) {
      if(e.repeat)e.preventDefault();
      else this.captureTask(task);
      e.stopImmediatePropagation();return;
    }
    if(this.editor&&e.key==='Escape'&&(e.isComposing||e.keyCode===229||this.editor.composing)){e.stopImmediatePropagation();return;}
    if(this.handleEscape(e)){e.preventDefault();e.stopImmediatePropagation();return;}
    if(this.arrowHandleKey(e))return;
    const rotate=e.target.closest('[data-sticker-rotate]');
    const turn={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,Home:0}[e.key];
    if(rotate&&turn!==undefined&&!e.altKey&&!e.metaKey&&!e.ctrlKey){
      e.preventDefault();e.stopImmediatePropagation();
      if(!e.repeat)this.adjustSticker(rotate,turn*(e.shiftKey?15:5));
      return;
    }
    if(this.editor?.rich&&e.key==='Tab'&&e.shiftKey&&e.target===this.toolbar.querySelector('button')){
      e.preventDefault();e.stopImmediatePropagation();
      restoreFocus(this.editor.previewing?this.editor.preview:this.editor.textarea);return;
    }
    if(e.target.closest('.whiteboard-toolbar')&&['ArrowRight','ArrowLeft','Home','End'].includes(e.key)) {
      const buttons=[...this.toolbar.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
      e.preventDefault();e.stopImmediatePropagation();
      buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length]?.focus();return;
    }
    if(e.target.closest('.whiteboard-menu')&&!this.appearance&&!this.containerLayout&&!e.target.closest('input,select,textarea')) {
      const buttons=[...this.menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
      if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    }
    const group=e.target.closest('[data-decoration]');
    if(group&&!e.target.closest('input,textarea,select,[contenteditable],button,.whiteboard-editor')&&!document.querySelector('dialog[open]')&&['Enter','F2'].includes(e.key)){
      e.preventDefault();e.stopImmediatePropagation();this.select(group.dataset.decoration);e.key==='F2'?this.edit(group.dataset.decoration):this.inspect(group.dataset.decoration);
    }
  }
  inspect(id) {
    const d=this.find(id);if(!d)return;
    if(d.sticker){restoreFocus(document.querySelector(selector(id))?.querySelector('[data-sticker-rotate]'));return;}
    if(d.container){this.configureContainer(d);return;}
    if(d.type==='line') {
      restoreFocus(this.toolbar.querySelector('[data-whiteboard-action="route"][aria-pressed="true"]'));
      return;
    }
    if(!this.openMenu())this.openObjectFormat([d]);
  }
  adjustSticker(handle,turn) {
    if(this.host.commandBusy()||this.host.decorationCommitting)return;
    const d=this.find(handle.closest('[data-decoration]')?.dataset.decoration);
    if(!d?.sticker)return;
    const rotation=turn?stickerAngle((d.rotation||0)+turn):0;
    if((d.rotation||0)===rotation)return;
    this.save(d.id,{rotation},undefined,decorationUnchanged(d)).then(()=>{
      if(!handle.isConnected&&document.activeElement===document.body)
        restoreFocus(document.querySelector(selector(d.id))?.querySelector('[data-sticker-rotate]'));
    }).catch(showFailure);
  }
}
