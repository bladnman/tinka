// Keys for an opened Tinka. No DOM, so tests can share it.
//
// Step to the previous / next Tinka with ⌥← / ⌥→ on a Mac and Ctrl+← / Ctrl+→ on
// Windows and Linux (Alt+← is browser Back there; Ctrl+← switches Spaces on a Mac).
// The same modifier with ↑ goes up a level and with ↓ goes down into the Tinka's
// own board. [ and ] are a fallback, and plain ← / → step while Tinka itself (not
// the content or a field) has focus. Text fields keep every one of these keys.
export function isMacPlatform(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}
export const stepModifierLabel = mac => mac ? '⌥' : 'Ctrl+';
export const stepModifierName = mac => mac ? 'Alt' : 'Control';

const ARROWS = { ArrowLeft: 'previous', ArrowRight: 'next', ArrowUp: 'up', ArrowDown: 'down' };

// One keydown, classified. `editable` is true inside a text field, contenteditable
// or other control that owns its keys; `tinkaFocus` is true when focus is on
// Tinka's own canvas or chrome (not the content frame); `fromFrame` marks a key
// forwarded from a same-origin content frame. Returns a command name or null.
export function readerCommand(event, { mac = false, editable = false, tinkaFocus = false, fromFrame = false } = {}) {
  if (!event || event.isComposing || event.keyCode === 229 || event.metaKey) return null;
  const key = event.key;
  const chord = mac ? event.altKey && !event.ctrlKey : event.ctrlKey && !event.altKey;
  if (chord && !event.shiftKey && ARROWS[key]) return editable ? null : ARROWS[key];
  if (editable || fromFrame) return null;
  if (key === '[') return 'previous';
  if (key === ']') return 'next';
  if (event.altKey || event.ctrlKey) return null;
  if (!event.shiftKey && tinkaFocus && (key === 'ArrowLeft' || key === 'ArrowRight')) return ARROWS[key];
  const shifted = digit => event.shiftKey && (event.code ? event.code === `Digit${digit}` : key === '!@)'[digit === 0 ? 2 : digit - 1]);
  if ((!event.shiftKey && (key === 'f' || key === 'F')) || shifted(1)) return 'fit';
  if (shifted(0)) return 'actual-size';
  if (key === '+' || key === '=') return 'zoom-in';
  if (key === '-' || key === '_') return 'zoom-out';
  if (key === '?') return 'shortcuts';
  return null;
}
