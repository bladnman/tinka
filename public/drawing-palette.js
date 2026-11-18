// An authored hue keeps its identity when the board changes appearance.
// Each row defines light ink, dark ink, light fill and dark fill.
const hues = [
  ['neutral', 'Neutral', '#434640', '#e1dfd5', '#deddd5', '#40413b'],
  ['slate', 'Slate', '#415260', '#b6c4d1', '#dbe2e8', '#35424d'],
  ['sage', 'Sage', '#4a573a', '#c1cca6', '#e0e7d1', '#3b4732'],
  ['green', 'Green', '#2b5c40', '#a7d5ae', '#d3e9d8', '#284b39'],
  ['teal', 'Teal', '#245b54', '#96d4c6', '#d0e8e1', '#244a45'],
  ['cyan', 'Cyan', '#28586a', '#9bccdd', '#d5e9ed', '#284650'],
  ['blue', 'Blue', '#2b4e82', '#a9c6f5', '#d9e4f5', '#2c405e'],
  ['indigo', 'Indigo', '#464a83', '#bfc1f5', '#e2e1f5', '#3b3c5c'],
  ['violet', 'Violet', '#5b4380', '#d3b8f0', '#ece0f7', '#473655'],
  ['plum', 'Plum', '#6c426c', '#deb5db', '#eddfed', '#50394c'],
  ['rose', 'Rose', '#853e5b', '#efafd0', '#f3dfe8', '#563748'],
  ['red', 'Red', '#873c40', '#f0b1b1', '#f3deda', '#573638'],
  ['clay', 'Clay', '#81482e', '#edb695', '#f2e0d2', '#533c2d'],
  ['amber', 'Amber', '#754e21', '#e9be87', '#f0e4ce', '#51412c'],
  ['gold', 'Gold', '#66541c', '#dec885', '#ebe6cb', '#49442c'],
];

const colors = new Map(hues.map(([name, label, lightInk, darkInk, lightFill, darkFill]) => [
  `palette:${name}`,
  {
    label,
    light: {ink: lightInk, fill: lightFill, stroke: lightInk},
    dark: {ink: darkInk, fill: darkFill, stroke: darkInk},
  },
]));

export const drawingPalette = Array.from(colors, ([id, {label}]) => ({id, label}));
export const isPaletteColor = value => colors.has(value);
export const isHexDrawingColor = value => typeof value === 'string' &&
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
export const isDrawingColor = value => isPaletteColor(value) || isHexDrawingColor(value);

// A custom hexadecimal color is intentional. Keep its original value so the
// caller can render it as a fill or adjust it against the actual text backdrop.
export function drawingColor(value, role, theme) {
  if (isHexDrawingColor(value)) return value;
  return colors.get(value)?.[theme]?.[role] ?? null;
}
