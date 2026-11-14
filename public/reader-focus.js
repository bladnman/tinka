// Keeps an opened Tinka's keys with Tinka.
//
// Content can focus itself as it loads (autofocus, or a prototype calling .focus() on
// its own canvas). After a step that pulled keyboard focus into the new content, so
// the next ← / → / [ ] (and, if the content handles it, ⌥←/→) never reached Tinka.
// While Tinka holds focus, a newly loaded document that takes focus without the
// person working in it hands focus straight back to where it was in Tinka's chrome
// (the stepper button, the canvas). Pressing or clicking inside the content, or Tab,
// releases the hold, so content that is being worked in keeps its keys. A preview on
// the board behind the open Tinka that grabs focus always hands it back. Independent
// cross-origin content cannot be watched and keeps whatever focus it gets.
// A click on a non-focusable spot of the header (which would leave focus on <body>)
// lands on Tinka's canvas instead, so the plain keys keep working there too.
//
// Rings: focus handed back here is not a keyboard move, so it never lights a ring. The
// canvas shows its ring only when Tab brought focus to it (data-tab-focus); a control
// that was clicked keeps its quiet, click-focused state (pointer-focus.js's
// data-pointer-focus) when focus returns to it.
const WATCHED = Symbol('tinka-reader-focus');

export function keepTinkaFocus({ dialog, frame, stage }) {
  let hold = false;
  let last = null;
  let lastQuiet = false;
  let tabbing = false;
  const usable = el => !!el && el !== frame && el.isConnected && dialog.contains(el) && !el.disabled && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const target = () => (usable(last) ? last : stage);
  // Focus sits in content Tinka can see at every level (same-origin frames only).
  const inVisibleContent = () => {
    let el = document.activeElement;
    if (el !== frame) return false;
    while (el?.tagName === 'IFRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch { return false; }
      if (!doc) return false;
      el = doc.activeElement;
    }
    return true;
  };
  // Behind the open Tinka the board is inert, yet a tile's preview frame can still take
  // focus as it loads; nothing outside the Tinka (other than a dialog over it) should.
  const strayed = () => {
    const active = document.activeElement;
    if (!active || active === document.body || dialog.contains(active)) return false;
    return !active.closest('dialog[open]') && !active.closest(':popover-open');
  };
  const reclaim = () => {
    if (!dialog.open || !(strayed() || (hold && inVisibleContent()))) return;
    const element = target();
    const quiet = element === last && lastQuiet;
    element.focus({ preventScroll: true });
    if (quiet) { element.setAttribute('data-pointer-focus', ''); lastQuiet = true; }
  };
  const later = () => setTimeout(reclaim, 0);
  const release = () => { hold = false; };
  const arm = () => { if (dialog.open && document.activeElement !== frame) hold = true; };

  // Clicking the header's background focuses the dialog itself (or, elsewhere, <body>):
  // Tinka's canvas takes it instead.
  dialog.addEventListener('focusin', event => {
    const element = event.target;
    if (element === dialog) { stage.focus({ preventScroll: true }); return; }
    if (element === stage && tabbing) stage.setAttribute('data-tab-focus', '');
    else if (element === stage) stage.removeAttribute('data-tab-focus');
    tabbing = false;
    if (element !== frame) { last = element; lastQuiet = element.hasAttribute('data-pointer-focus'); }
  });
  stage.addEventListener('focusout', () => stage.removeAttribute('data-tab-focus'));
  addEventListener('pointerdown', () => { tabbing = false; }, true);
  dialog.addEventListener('focusout', event => {
    if (event.relatedTarget) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (dialog.open && (!active || active === document.body || active === document.documentElement)) stage.focus({ preventScroll: true });
    }, 0);
  });
  document.addEventListener('keydown', event => { tabbing = event.key === 'Tab'; if (tabbing) release(); }, true);
  addEventListener('blur', later);
  document.addEventListener('focusin', later, true);
  new MutationObserver(() => { if (dialog.open) { last = null; hold = true; } else hold = false; }).observe(dialog, { attributes: true, attributeFilter: ['open'] });

  const watch = (element, top) => {
    let win, doc;
    try { win = element.contentWindow; doc = element.contentDocument; } catch { return; }
    if (!win || !doc || doc[WATCHED]) return;
    doc[WATCHED] = true;
    win.addEventListener('pointerdown', release, true);
    win.addEventListener('focus', later, true);
    // Tinka replacing the content (a step, a version, Reload) while Tinka has focus.
    if (top) win.addEventListener('pagehide', arm);
    doc.addEventListener('load', event => { if (event.target?.tagName === 'IFRAME') { watch(event.target, false); later(); } }, true);
    for (const inner of doc.querySelectorAll('iframe')) watch(inner, false);
  };
  frame.addEventListener('load', () => {
    arm();
    watch(frame, true);
    reclaim();
    later();
  });
  return { get holding() { return hold; }, release };
}

const dialog = typeof document !== 'undefined' && document.getElementById('reader-dialog');
const frame = dialog && document.getElementById('active-reader');
const stage = dialog && document.getElementById('reader-stage');
if (dialog && frame && stage) keepTinkaFocus({ dialog, frame, stage });
