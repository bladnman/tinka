// ⌥← / ⌥→ on a board (Ctrl+← / Ctrl+→ on Windows and Linux) select the previous or
// next Tinka, in the same order and with the same skips as an opened Tinka's stepper,
// so the keys mean the same thing on a board and inside a Tinka. No DOM, so tests can
// share it.
import {readerCommand} from './reader-keys.js';

// The stepper skips reserved and building slots, and board-only Tinkas (those open their board).
export function isSteppable(item) {
  return !!item && !['reserved', 'building'].includes(item.build?.state) && !(item.childBoardId && !item.content);
}

// The step chord alone: ⌥←/→ on a Mac, Ctrl+←/→ elsewhere. Never inside a text field.
export function boardStepCommand(event, { mac = false, editable = false } = {}) {
  if (!event || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return null;
  const command = readerCommand(event, { mac, editable });
  return command === 'previous' || command === 'next' ? command : null;
}

// The Tinka to select next. `order` is the board's Tinkas in stepper order, each with an
// `id` (its placement); `selected` holds placement IDs. With a selection, next goes on
// from the last selected one and previous back from the first. With nothing selected (or
// only non-Tinka things) the board's cursor, {id, index}, stands in: the Tinka last
// opened, viewed, stepped to or selected on its own. If that Tinka has gone or is filtered
// out, stepping continues from the place in the order where it stood (`index`). Without
// either, next starts at the first Tinka and previous at the last. Returns null at either
// end: stepping stops there, as it does in an opened Tinka.
export function boardStepTarget(order, { selected = new Set(), direction = 1, steppable = () => true, cursor = null } = {}) {
  const at = [];
  order.forEach((entry, index) => { if (selected.has(entry.id)) at.push(index); });
  if (!at.length && cursor?.id) {
    const index = order.findIndex(entry => entry.id === cursor.id);
    if (index >= 0) at.push(index);
    else if (Number.isInteger(cursor.index) && cursor.index >= 0) {
      // Whatever now stands at the cursor's old place is next; the one before it, previous.
      const start = direction > 0 ? Math.min(cursor.index, order.length) : Math.min(cursor.index, order.length) - 1;
      for (let index = start; index >= 0 && index < order.length; index += direction)
        if (steppable(order[index])) return order[index];
    }
  }
  if (!at.length) {
    const sequence = order.filter(steppable);
    return (direction > 0 ? sequence[0] : sequence.at(-1)) || null;
  }
  const from = direction > 0 ? Math.max(...at) : Math.min(...at);
  for (let index = from + direction; index >= 0 && index < order.length; index += direction)
    if (steppable(order[index])) return order[index];
  return null;
}
