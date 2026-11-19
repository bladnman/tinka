import {drawingPalette,isHexDrawingColor} from "./drawing-palette.js";
import {appearanceThemes,compositeColor,renderDrawingColor,textFillColor,unpackColor} from "./theme-colors.js";
import {boardSurfaces,surfacePoints} from "./board-paint.js";

const names = new Map(drawingPalette.map(({id,label}) => [id,label]));
const mixed = "linear-gradient(135deg,var(--surface-1) 46%,var(--ink-3) 47% 53%,var(--surface-1) 54%)";
const rgbHex = rgb => "#" + rgb.map(channel => Math.round(channel).toString(16).padStart(2,"0")).join("").toUpperCase();
const chosenName = value => names.get(value) ?? value.toUpperCase();
const normalized = value => {
  const [rgb,alpha] = unpackColor(value);
  return `${rgb.join(",")}/${alpha}`;
};

// The renderer has already resolved the local surface and contrast. Read its
// final ink instead of presenting the palette's uncorrected authored hue.
function paintedInk(decoration, element, board, theme) {
  const value = element.style.getPropertyValue(`--text-ink-${theme}`).trim();
  if (!isHexDrawingColor(value)) return {colors:[],contrastAdjusted:false,themeAdjusted:false};
  const baseline = renderDrawingColor(decoration.color,"ink",theme);
  const contrastAdjusted = baseline && normalized(value) !== normalized(baseline);
  const themeAdjusted = isHexDrawingColor(decoration.color) && normalized(baseline) !== normalized(decoration.color);
  const [rgb,alpha] = unpackColor(value);
  if (alpha === 1) return {colors:[rgbHex(rgb)],contrastAdjusted,themeAdjusted};

  // Translucent ink has a different visible color on each surface it crosses.
  // Reuse the renderer's backing samples only to composite its final alpha.
  const fill = textFillColor(decoration.textFill,theme);
  const backdrops = boardSurfaces(board,theme,surfacePoints(decoration),{except:decoration.id,layers:1});
  const colors = backdrops.map(base => rgbHex(compositeColor(value,fill ? compositeColor(fill,base) : base)));
  return {colors:[...new Set(colors)],contrastAdjusted,themeAdjusted};
}

export function syncTextInkPreview(button, decorations, board) {
  if (!button || !decorations.length || decorations.some(drawing => drawing.type !== "text" || drawing.sticker)) return;
  const records = decorations.map(drawing => {
    const element = document.querySelector(`[data-decoration="${CSS.escape(drawing.id)}"]`);
    return element ? {drawing,element} : null;
  }).filter(Boolean);
  const preview = Object.fromEntries(appearanceThemes.map(theme => {
    const values = records.map(({drawing,element}) => paintedInk(drawing,element,board,theme));
    const colors = [...new Set(values.flatMap(value => value.colors))];
    return [theme,{
      color:records.length === decorations.length && colors.length === 1 && values.every(value => value.colors.length) ? colors[0] : null,
      contrastAdjusted:values.some(value => value.contrastAdjusted),
      themeAdjusted:values.some(value => value.themeAdjusted),
    }];
  }));
  const currentTheme = document.documentElement.dataset.appearance === "dark" ? "dark" : "light";
  const current = preview[currentTheme];
  const chosen = [...new Set(decorations.map(drawing => chosenName(drawing.color)))];
  const description = [
    chosen.length === 1 ? `Chosen ${chosen[0]}.` : "Chosen colors vary.",
    current.color ? `Displayed ${current.color}.` : "Displayed ink varies across the selection or backgrounds.",
    current.contrastAdjusted ? "Adjusted for contrast." : current.themeAdjusted ? "Adjusted for Dark appearance." : "",
  ].filter(Boolean).join(" ");
  let dot = button.querySelector("[data-text-ink-preview]");
  if (!dot) {
    dot = document.createElement("span");
    dot.className = "drawing-color-dot";
    dot.dataset.textInkPreview = "";
    dot.setAttribute("aria-hidden","true");
    button.querySelector(".drawing-color-dot")?.replaceWith(dot);
  }
  for (const theme of appearanceThemes) dot.style.setProperty(`--dot-${theme}`,preview[theme].color ?? mixed);
  dot.dataset.inkMixed = String(!current.color);
  button.setAttribute("aria-description",description);
  button.title = `Ink color · ${description}`;
}
