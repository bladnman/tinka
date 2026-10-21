// Keep existing media documents alive while updating their surrounding cards.
export function reconcileChildren(parent, fresh) {
    const key = node => node.nodeType === Node.ELEMENT_NODE
      ? ["placement", "decoration", "round", "cover-tile", "home-board"].map(name =>
          node.hasAttribute(`data-${name}`) ? `${name}:${node.getAttribute(`data-${name}`)}` : "").find(Boolean)
      : null;
    const compatible = (before, after) => before.nodeType === after.nodeType &&
      (before.nodeType !== Node.ELEMENT_NODE ||
        (before.tagName === after.tagName && before.namespaceURI === after.namespaceURI &&
         before.classList[0] === after.classList[0] &&
         (before.tagName !== "IFRAME" || before.dataset.previewSource === after.dataset.previewSource)));
    const old = [...parent.childNodes], used = new Set();
    const keyed = new Map(old.filter(key).map(node => [key(node), node]));
    const desired = [...fresh.childNodes].map(after => {
      const id = key(after);
      const before = id ? keyed.get(id) : old.find(node => !used.has(node) && !key(node) && compatible(node, after));
      if (!before || !compatible(before, after)) return after;
      used.add(before);
      if (before.nodeType === Node.ELEMENT_NODE) {
        // An in-progress decoration edit owns its text and selection until blur.
        if (!before.isContentEditable) {
          for (const attr of [...before.attributes])
            if (!after.hasAttribute(attr.name)) before.removeAttribute(attr.name);
          for (const attr of after.attributes)
            if (before.getAttribute(attr.name) !== attr.value) before.setAttribute(attr.name, attr.value);
          reconcileChildren(before, after);
        }
      } else if (before.nodeValue !== after.nodeValue) before.nodeValue = after.nodeValue;
      return before;
    });
    // Remove absent siblings first, so a surviving preview never moves just to
    // close the gap left by a removed item or decoration.
    for (const node of old) if (!used.has(node)) node.remove();
    let cursor = parent.firstChild;
    for (const node of desired) {
      if (node !== cursor) {
        if (node.parentNode === parent && parent.moveBefore) parent.moveBefore(node, cursor);
        else parent.insertBefore(node, cursor);
      }
      cursor = node.nextSibling;
    }
  }
