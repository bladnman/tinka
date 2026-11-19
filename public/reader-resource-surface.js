// Observe only Tinka's own item/media wrappers. Authored HTML and independent apps
// keep their DOM, scroll boxes, scripts and viewport behavior unchanged.
export class ReaderResourceSurface {
  constructor(frame, {isActive, onImageSize}) {
    Object.assign(this, {frame, isActive, onImageSize});
    this.cleanups = [];
    this.generation = 0;
  }
  reset(expectedURL = null) {
    this.generation++;
    this.expectedURL = expectedURL ? new URL(expectedURL, location.href).href : null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.documents = new WeakSet();
  }
  prepare() {
    if (!this.documents) this.reset();
    const generation = this.generation;
    let rootDocument;
    try { rootDocument = this.frame.contentDocument; } catch { return; }
    if (!rootDocument || (this.expectedURL && rootDocument.URL !== this.expectedURL)) return;
    const current = () => generation === this.generation && this.isActive() && this.frame.contentDocument === rootDocument;
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      this.cleanups.push(() => target.removeEventListener(type, handler));
    };
    const visit = (frame, depth = 0) => {
      if (!current() || depth > 1) return;
      let doc, url;
      try {
        doc = frame.contentDocument;
        url = new URL(doc?.URL);
      } catch { return; }
      if (!doc || url.origin !== location.origin || this.documents.has(doc)) return;
      // No arbitrary nested document can publish dimensions or receive host CSS.
      if (!['/app/item.html', '/app/media.html'].includes(url.pathname)) return;
      this.documents.add(doc);
      if (url.pathname === '/app/item.html' && depth === 0) {
        const children = new WeakSet();
        const scan = () => {
          if (!current() || frame.contentDocument !== doc) return;
          for (const inner of doc.querySelectorAll('#item-content > iframe.item-full-frame')) {
            if (children.has(inner)) continue;
            children.add(inner);
            listen(inner, 'load', () => visit(inner, depth + 1));
            visit(inner, depth + 1);
          }
        };
        const observer = new MutationObserver(scan);
        observer.observe(doc.querySelector('#item-content') || doc.documentElement, {childList: true});
        this.cleanups.push(() => observer.disconnect());
        scan();
      } else if (url.pathname === '/app/media.html' && url.searchParams.get('kind') === 'image') {
        const prepared = new WeakSet();
        const scan = () => {
          if (!current() || frame.contentDocument !== doc) return;
          const image = doc.querySelector('.image-stage img');
          if (!image || prepared.has(image)) return;
          prepared.add(image);
          const loaded = () => {
            if (!current() || frame.contentDocument !== doc || !image.isConnected || !image.naturalWidth || !image.naturalHeight) return;
            const style = doc.createElement('style');
            style.textContent = '.image-stage{padding:0;min-height:100%;height:100%}.image-stage img{width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;box-shadow:none}';
            doc.head.append(style);
            this.cleanups.push(() => style.remove());
            this.onImageSize(image.naturalWidth, image.naturalHeight);
          };
          if (image.complete) loaded();
          else listen(image, 'load', loaded);
        };
        const observer = new MutationObserver(scan);
        observer.observe(doc.querySelector('#media-content') || doc.documentElement, {childList: true, subtree: true});
        this.cleanups.push(() => observer.disconnect());
        scan();
      }
    };
    visit(this.frame);
  }
}
