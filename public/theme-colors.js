import {drawingColor, isHexDrawingColor} from "./drawing-palette.js";

export const appearanceThemes = ["light", "dark"];
const canvas = {light: "#efeee8", dark: "#2b2c29"};
export const themePaper = {light: "#fdfdfb", dark: "#3a3c37"};
export const textFillColors = {
  paper: themePaper,
  tint: {light: "#e4e9da", dark: "#373f30"},
  strong: {light: "#536044", dark: "#475b3d"},
};
const surfaceLightness = {board: [.13, .22], paper: [.17, .33], fill: [.20, .39]};

export function unpackColor(color) {
  let hex = color.slice(1);
  if (hex.length < 5) hex = [...hex].map(channel => channel + channel).join("");
  const colorBytes = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
  return [colorBytes, hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
}

function hex(rgb, alpha = 1) {
  const bytes = alpha === 1 ? rgb : [...rgb, alpha * 255];
  return "#" + bytes.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("");
}

export function mixColor(front, back, amount) {
  return front.map((channel, index) => channel * amount + back[index] * (1 - amount));
}

export function compositeColor(color, backing, opacity = 1) {
  const [rgb, alpha] = unpackColor(color);
  return mixColor(rgb, backing, alpha * opacity);
}

export function luminance(rgb) {
  const linear = rgb.map(channel => {
    const n = channel / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

export function contrastRatio(a, b) {
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

// Move lightness while maintaining the hue. Limit the chroma to what is
// representable at the target lightness so an RGB channel never clips.
function withLightness(rgb, target) {
  const min = Math.min(...rgb), max = Math.max(...rgb);
  const mid = (min + max) / 2;
  const half = (max - min) / 2;
  const chroma = half ? Math.min(1, target / half, (255 - target) / half) : 1;
  return rgb.map(channel => Math.round(target + (channel - mid) * chroma));
}

// Keep already-dark surfaces, and compress lighter values into the role's
// usable dark range. Hue and the order of shades are retained. Foreground
// polarity flips, then the renderer checks the actual surface.
export function renderDrawingColor(value, role, theme) {
  const surface = surfaceLightness[role];
  if (theme !== "dark" || !isHexDrawingColor(value))
    return drawingColor(value, surface ? "fill" : role, theme);
  const [rgb, alpha] = unpackColor(value);
  const lightness = (Math.min(...rgb) + Math.max(...rgb)) / 510;
  if (surface && lightness <= surface[0]) return value;
  const target = surface ? surface[0] + (lightness - surface[0]) * (surface[1] - surface[0]) / (1 - surface[0]) :
    1 - lightness;
  return hex(withLightness(rgb, target * 255), alpha);
}

export function canvasBackdrop(color, theme) {
  const [base] = unpackColor(canvas[theme]);
  const fill = renderDrawingColor(color, "board", theme);
  return fill ? compositeColor(fill, base) : base;
}

export function boardColorVariables(value) {
  if (!isHexDrawingColor(value)) return {};
  return Object.fromEntries(appearanceThemes.flatMap(theme => {
    const backing = canvasBackdrop(value, theme);
    const ring = readableColor(drawingColor("palette:sage", "stroke", theme), [backing], 3).color;
    return [[`--board-color-${theme}`, hex(backing)], [`--board-ring-${theme}`, ring],
      [`--board-pattern-${theme}`, surfaceInk(backing, theme)]];
  }));
}

export function textFillColor(value, theme) {
  return Object.hasOwn(textFillColors, value) ? textFillColors[value][theme] :
    renderDrawingColor(value, "fill", theme);
}

// Find the smallest lightness shift that can read across the sampled surfaces.
// At a boundary where neither polarity can satisfy every sample, maximize the
// weakest contrast. The caller can give that case a contrasting outline.
export function readableColor(color, backdrops, minimum) {
  const backgrounds = backdrops.map(luminance);
  const [rgb, alpha] = unpackColor(color);
  const contrast = (candidate, opacity = 1) => Math.min(...backgrounds.map((background, index) =>
    contrastRatio(luminance(mixColor(candidate, backdrops[index], opacity)), background)));
  // Browser CSS interpolation and 8-bit channel rounding can move a value just
  // below an exact threshold. Leave a small margin for the final painted pixels.
  const target = minimum + .08;
  if (contrast(rgb, alpha) >= target) return {color, meetsContrast: true};

  let result = {rgb, contrast: contrast(rgb), distance: 0};
  for (let tone = 0; tone <= 255; tone++) {
    const candidate = withLightness(rgb, tone);
    const score = contrast(candidate);
    const distance = Math.abs(tone - (Math.min(...rgb) + Math.max(...rgb)) / 2);
    const passes = score >= target, alreadyPasses = result.contrast >= target;
    if (passes ? !alreadyPasses || distance < result.distance : !alreadyPasses && score > result.contrast)
      result = {rgb: candidate, contrast: score, distance};
  }
  return {color: hex(result.rgb), meetsContrast: result.contrast >= minimum};
}

export function surfaceInk(backing, theme, muted = false) {
  const options = muted ? ["#4c5145", "#c8c9bf"] : ["#23271f", "#ecece5"];
  const contrast = color => contrastRatio(luminance(unpackColor(color)[0]), luminance(backing));
  const preferred = options.sort((a, b) => contrast(b) - contrast(a))[0];
  return readableColor(preferred, [backing], 4.5).color;
}

// Resolve title/caption ink against the paper after its alpha composites over
// the local backing. Provide both theme values so a toggle never rebuilds tiles.
export function paperVariables(value, backdrop = theme => canvasBackdrop(undefined, theme)) {
  if (!isHexDrawingColor(value)) return "";
  return appearanceThemes.map(theme => {
    const paper = renderDrawingColor(value, "paper", theme);
    const backing = backdrop(theme);
    const surface = compositeColor(paper, backing);
    return `--item-paper-${theme}:${paper};--item-ink-${theme}:${surfaceInk(surface, theme)};--item-muted-${theme}:${surfaceInk(surface, theme, true)};`;
  }).join("");
}
