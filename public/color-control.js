import {drawingPalette,drawingColor,isHexDrawingColor} from "./drawing-palette.js";
import {renderDrawingColor} from "./theme-colors.js";

const roles={ink:"ink",fill:"fill",border:"stroke"};
const themes=["light","dark"];
const customIcon='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v8M4 8h8"/></svg>';

export function colorDot(value, role, fallback) {
  const light=renderDrawingColor(value,role,"light")??fallback?.light??fallback;
  const dark=renderDrawingColor(value,role,"dark")??fallback?.dark??fallback;
  return light&&dark ? `<span class="drawing-color-dot" aria-hidden="true" style="--dot-light:${light};--dot-dark:${dark}"></span>` :
    '<span class="drawing-color-dot drawing-color-dot-mixed" aria-hidden="true"></span>';
}

// The browser picker only shows RGB. Leaving it untouched retains a saved alpha.
export function pickerHex(value, fallback) {
  if(!isHexDrawingColor(value))return fallback;
  return value.length<=5?"#"+[...value.slice(1,4)].map(c=>c+c).join("").toLowerCase():value.slice(0,7).toLowerCase();
}

export function paletteMarkup(channels,{options=drawingPalette,resolve=renderDrawingColor}={}) {
  const swatches=options.map(({id,label})=>{
    const vars=channels.flatMap(channel=>themes.map(theme=>`--${channel}-${theme}:${resolve(id,roles[channel],theme)}`)).join(";");
    return `<button type="button" data-swatch="${id}" aria-label="${label}" title="${label}" style="${vars}"><span aria-hidden="true"></span></button>`;
  }).join("");
  return `<div class="text-format-swatches" role="group" data-color-swatches>${swatches}
    <label class="text-format-custom" title="Custom color">
      <span class="text-format-custom-chip" aria-hidden="true">${customIcon}</span>
      <input type="color" name="custom" aria-label="Custom color">
    </label>
  </div>`;
}

export function bindDrawingPalette(palette,{channel,label,value,choose,toValue=id=>id,fallback="#78866c",previewRole=roles[channel]}) {
  const swatches=[...palette.querySelectorAll("[data-swatch]")],custom=palette.querySelector("input[type=color]");
  const customChip=custom.closest(".text-format-custom");
  palette.dataset.channel=channel;
  palette.setAttribute("aria-label",label);
  const setValue=selected=>{
    const selectedSwatch=swatches.find(button=>toValue(button.dataset.swatch)===selected);
    for(const button of swatches)button.setAttribute("aria-pressed",String(button===selectedSwatch));
    const isCustom=isHexDrawingColor(selected)&&!selectedSwatch;
    customChip.classList.toggle("is-selected",isCustom);
    for (const theme of themes)
      customChip.style.setProperty(`--custom-preview-${theme}`,isCustom?renderDrawingColor(selected,previewRole,theme):"transparent");
    const theme=document.documentElement.dataset.appearance==="dark"?"dark":"light";
    custom.value=pickerHex(isHexDrawingColor(selected) ? selected : drawingColor(selected,roles[channel],theme),fallback);
  };
  for(const button of swatches)button.onclick=()=>choose(toValue(button.dataset.swatch));
  custom.onchange=()=>choose(custom.value);
  setValue(value);
  return setValue;
}
