import {isDrawingColor, isPaletteColor} from "./drawing-palette.js";
import {appearanceThemes, canvasBackdrop, compositeColor, renderDrawingColor, textFillColor, themePaper, unpackColor} from "./theme-colors.js";

const paintCache = new WeakMap();
const ordered = (a, b) => a.layer - b.layer || a.order - b.order;
const pointInside = (d, [x,y]) => {
  if (x < d.x || y < d.y || x > d.x + d.width || y > d.y + d.height) return false;
  if (d.shape === "ellipse" || d.shape === "diamond") {
    const dx = Math.abs(2 * (x - d.x) / d.width - 1);
    const dy = Math.abs(2 * (y - d.y) / d.height - 1);
    return d.shape === "ellipse" ? dx * dx + dy * dy <= 1 : dx + dy <= 1;
  }
  return true;
};

export function regionPaper(drawing, theme) {
  const value = isDrawingColor(drawing.color) ? drawing.color : "#78866c";
  const fill = renderDrawingColor(value, "fill", theme);
  if (drawing.container) {
    const mixed = compositeColor(fill, unpackColor(themePaper[theme])[0], .28);
    const opaque = "#" + mixed.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("");
    return {fill: opaque, opacity: 1};
  }
  if (drawing.shape || isPaletteColor(value)) return {fill, opacity: 1};
  return {fill, opacity: theme === "dark" ? .65 : .2};
}

// Record only surfaces that paint. Area/container backgrounds paint first,
// then Text fill and shapes in the same order as the canvas layers. Outside
// an object's bounds the board color is still the actual backing.
function paintLayers(board) {
  let paint = paintCache.get(board);
  if (paint && paint.decorations === board.decorations && paint.color === board.background?.color) return paint;
  const drawings = board.decorations || [];
  const rows = drawings.flatMap((drawing, order) => {
    if (drawing.sticker || drawing.type === "line") return [];
    const isText = drawing.type === "text";
    const layer = isText || drawing.shape ? 1 : 0;
    const surfaces = {};
    for (const theme of appearanceThemes) {
      const fill = isText ? textFillColor(drawing.textFill, theme) : null;
      surfaces[theme] = isText ? (fill && {fill, opacity: 1}) : regionPaper(drawing, theme);
    }
    return !surfaces.light && !surfaces.dark ? [] : [{drawing, order, layer, surfaces}];
  }).sort(ordered);
  paint = {
    decorations: board.decorations,
    color: board.background?.color,
    base: Object.fromEntries(appearanceThemes.map(theme => [theme, canvasBackdrop(board.background?.color, theme)])),
    rows,
  };
  paintCache.set(board, paint);
  return paint;
}

export function boardSurfaces(board, theme, points, {except, layers = 0} = {}) {
  const paint = paintLayers(board);
  if (!paint.rows.length || !points.length) return [paint.base[theme]];
  const currentOrder = (board.decorations || []).findIndex(drawing => drawing.id === except);
  const seen = new Map();
  for (const point of points) {
    let backing = paint.base[theme];
    for (const {drawing, order, layer, surfaces} of paint.rows) {
      if (layer > layers) break;
      // Equal-z Text and shapes follow saved DOM order. A foreground sees only
      // the surfaces that were painted before it in that layer.
      if (currentOrder >= 0 && layer === layers && order >= currentOrder) break;
      if (drawing.id === except || !surfaces[theme] || !pointInside(drawing, point)) continue;
      const {fill, opacity} = surfaces[theme];
      backing = compositeColor(fill, backing, opacity);
    }
    seen.set(backing.map(Math.round).join(","), backing);
  }
  return [...seen.values()];
}

export function surfacePoints(box) {
  const {x,y,width,height} = box;
  return [
    [x + width * .5, y + height * .5],
    [x + width * .12, y + height * .15], [x + width * .88, y + height * .15],
    [x + width * .12, y + height * .85], [x + width * .88, y + height * .85],
  ];
}

// Straight lines can cross a region between their two vertices. Sample the
// whole route at regular intervals, keeping the work bounded on long arrows.
export function lineSurfacePoints(path, box) {
  if (!path?.points?.length) return surfacePoints(box);
  const points = [path.points[0]];
  const step = Math.max(16, Math.max(box.width, box.height) / 48);
  for (let i = 1; i < path.points.length; i++) {
    const [x,y] = path.points[i-1], [endX,endY] = path.points[i];
    const count = Math.ceil(Math.hypot(endX - x, endY - y) / step);
    for (let j = 1; j <= count; j++) points.push([x + (endX - x) * j / count, y + (endY - y) * j / count]);
  }
  return points;
}
