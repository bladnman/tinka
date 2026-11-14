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
// `id` (its placement); `selected` holds placement IDs. With nothing selected (or only
// non-Tinka things), next starts at the first Tinka and previous at the last. With a
// selection, next goes on from the last selected one and previous back from the first.
// Returns null at either end: stepping stops there, as it does in an opened Tinka.
export function boardStepTarget(order, { selected = new Set(), direction = 1, steppable = () => true } = {}) {
  const at = [];
  order.forEach((entry, index) => { if (selected.has(entry.id)) at.push(index); });
  if (!at.length) {
    const sequence = order.filter(steppable);
    return (direction > 0 ? sequence[0] : sequence.at(-1)) || null;
  }
  const from = direction > 0 ? Math.max(...at) : Math.min(...at);
  for (let index = from + direction; index >= 0 && index < order.length; index += direction)
    if (steppable(order[index])) return order[index];
  return null;
}
