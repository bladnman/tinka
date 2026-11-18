// Draw a still of a loaded tile frame. Never mount a second browsing context or
// import authored markup into the board. The local still uses visible boxes,
// text and already available media. It does not reproduce complex effects.
function frameStill(frame) {
  let source = frame;
  for (let depth = 0; depth < 3; depth++) {
    const child = source.contentDocument?.querySelector('iframe.item-full-frame');
    if (!child) break;
    source = child;
  }
  const doc = source.contentDocument, view = doc?.defaultView;
  const width = source.clientWidth, height = source.clientHeight;
  if (!doc?.body || !view || width < 2 || height < 2 || doc.URL === 'about:blank') return null;
  const still = document.createElement('canvas');
  still.className = 'workspace-copy-frame';
  const scale = Math.min(1,900 / width,900 / height);
  still.width = Math.ceil(width * scale);
  still.height = Math.ceil(height * scale);
  const ctx = still.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale,scale);
  const paint = color => color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
  const rootBackground = view.getComputedStyle(doc.documentElement).backgroundColor;
  const background = paint(rootBackground) ? rootBackground : view.getComputedStyle(doc.body).backgroundColor;
  if (paint(background)) { ctx.fillStyle = background; ctx.fillRect(0,0,width,height); }
  const walker = doc.createTreeWalker(doc.body, 1);
  let element = doc.body;
  for (let count = 0; element && count < 180; count++, element = walker.nextNode()) {
    const {x,y,width:w,height:h} = element.getBoundingClientRect();
    if (w < 1 || h < 1 || x > width || y > height || x + w < 0 || y + h < 0) continue;
    const style = view.getComputedStyle(element);
    if (style.visibility !== 'visible' || style.opacity === '0') continue;
    if (paint(style.backgroundColor)) {
      ctx.fillStyle = style.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(x,y,w,h,Math.max(0,parseFloat(style.borderTopLeftRadius) || 0));
      ctx.fill();
    }
    if (['IMG','CANVAS','VIDEO'].includes(element.tagName)) {
      try { ctx.drawImage(element,x,y,w,h); } catch { /* Media might still be loading. */ }
    }
    if (parseFloat(style.borderTopWidth) > 0 && paint(style.borderTopColor)) {
      ctx.strokeStyle = style.borderTopColor;
      ctx.lineWidth = parseFloat(style.borderTopWidth);
      ctx.strokeRect(x,y,w,h);
    }
    ctx.fillStyle = style.color;
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.textBaseline = 'top';
    for (const node of element.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width > 0) ctx.fillText(node.textContent.trim().replace(/\s+/g,' ').slice(0,160),box.x,box.y,box.width);
    }
  }
  mediaStyle(frame,still);
  return still;
}

function mediaStyle(source, copy) {
  const style = getComputedStyle(source);
  for (const key of ['position','inset','width','height','transformOrigin','transform','objectFit','objectPosition','borderRadius'])
    copy.style[key] = style[key];
}

function imageStill(image) {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null;
  const imageCopy = document.createElement('canvas');
  const scale = Math.min(1,900 / image.naturalWidth,900 / image.naturalHeight);
  imageCopy.width = Math.max(1,Math.round(image.naturalWidth * scale));
  imageCopy.height = Math.max(1,Math.round(image.naturalHeight * scale));
  try { imageCopy.getContext('2d').drawImage(image,0,0,imageCopy.width,imageCopy.height); }
  catch { return null; }
  mediaStyle(image,imageCopy);
  return imageCopy;
}

const controls = '.workspace-select-dot,.workspace-tile-more,.workspace-tile-toolbar,.workspace-preview-launch,.workspace-resize,[data-placement-resize]';
export function copyCardPreview(card, title, reserveStill) {
  const copyNode = node => {
    if (node.nodeType !== 1) return node.cloneNode(false);
    if (node.matches(controls)) return null;
    if (node.tagName === 'IMG') return imageStill(node);
    if (node.tagName === 'IFRAME') {
      if (!node.parentElement?.classList.contains('workspace-live-preview')) return null;
      const still = reserveStill() && frameStill(node);
      if (still) return still;
      const label = document.createElement('span');
      label.className = 'workspace-title-art';
      label.textContent = title;
      return label;
    }
    // These elements could start their own activity as soon as they mount.
    if (node.matches('script,link,style,object,embed,video,audio')) return null;
    const copy = node.cloneNode(false);
    for (const child of node.childNodes) {
      const snapshot = copyNode(child);
      if (snapshot) copy.append(snapshot);
    }
    return copy;
  };
  const ghost = copyNode(card);
  ghost.classList.remove('selected','solo','navigator-revealed','return-pulse','workspace-dragging');
  ghost.removeAttribute('data-placement');
  ghost.removeAttribute('data-key');
  ghost.inert = true;
  return ghost;
}
