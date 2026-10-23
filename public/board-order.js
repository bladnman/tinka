// Display order only: never change saved placement or comparison order.
// Only eligible entries exchange slots; ties and unknown dates retain source order.
export function newestBoardsFirst(entries, date = entry => entry.createdAt, eligible = () => true) {
  const boards = entries.map((entry, index) => {
    const value = date(entry), time = typeof value === "string" ? Date.parse(value) : NaN;
    return {entry, index, time:Number.isFinite(time) ? time : -Infinity};
  }).filter(value => eligible(value.entry));
  const slots = new Set(boards.map(value => value.index));
  boards.sort((a, b) => b.time - a.time || a.index - b.index);
  let next = 0;
  return entries.map((entry, index) => slots.has(index) ? boards[next++].entry : entry);
}
