// Focus rings for keyboard navigation only. A control clicked or tapped keeps focus (so
// its keys still work), but browsers start drawing its :focus-visible ring as soon as
// any key is pressed afterwards: a clicked map or Fit button lit up when F or an arrow
// was pressed, and a panel opened with the mouse and closed with Escape lit up the
// button it returned focus to. Focus that arrives while the pointer is the way of
// working is marked data-pointer-focus, and CSS hides the ring on marked controls.
// Tab and the arrow, Home and End keys switch to keyboard navigation: focus they move,
// and focus moved afterwards, keeps its ring. Text fields are never marked: their focus
// style shows where typing goes.
const FIELD = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=textbox]';
const NAVIGATION = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

const installed = new WeakSet();

export function quietPointerFocus(target = globalThis.window) {
  if (!target?.addEventListener || installed.has(target)) return;
  installed.add(target);
  let pointer = false;
  target.addEventListener('pointerdown', () => { pointer = true; }, true);
  target.addEventListener('keydown', event => { if (NAVIGATION.has(event.key)) pointer = false; }, true);
  target.addEventListener('focusin', event => {
    const element = event.target;
    if (!element?.setAttribute) return;
    if (pointer && !element.matches(FIELD)) element.setAttribute('data-pointer-focus', '');
    else element.removeAttribute('data-pointer-focus');
  }, true);
  target.addEventListener('focusout', event => { event.target?.removeAttribute?.('data-pointer-focus'); }, true);
}
