import {restoreFocus} from "./interaction.js";
import {drawingColor, isHexDrawingColor} from "./drawing-palette.js";
import {appearanceThemes,canvasBackdrop,compositeColor,contrastRatio,luminance,readableColor,renderDrawingColor,textFillColor,textFillColors as fillColors,unpackColor} from "./theme-colors.js";
import {colorDot,paletteMarkup,pickerHex} from "./color-control.js";
import {mountPresetScrub} from "./preset-scrub.js";

export const isHexColor = isHexDrawingColor;
const presetValues = [["small","S","Small",18,4],["medium","M","Medium",21,12],["large","L","Large",36,24]];
const sizePresets = presetValues.map(([id,label,ariaLabel,value])=>({id,label,ariaLabel,value}));
const paddingPresets = presetValues.map(([id,label,ariaLabel,,value])=>({id,label,ariaLabel,value}));
const faces = [["serif","Serif"],["sans","Sans"],["mono","Mono"]];
export function textStyleVariables(decoration, ink, backdrop = theme => [canvasBackdrop(null, theme)]) {
  const styles=[];
  if(Number.isInteger(decoration.textSize)&&decoration.textSize>=10&&decoration.textSize<=144)
    styles.push(`--text-font-size:${decoration.textSize}px`);
  if(Number.isInteger(decoration.textPadding)&&decoration.textPadding>=0&&decoration.textPadding<=64)
    styles.push(`--text-padding:${decoration.textPadding}px`);
  const edgeStyle=decoration.textBorder?.style;
  if(edgeStyle==="solid"||edgeStyle==="dashed")styles.push(`--text-border-style:${edgeStyle}`);
  const backingFor = theme => {
    const fill = textFillColor(decoration.textFill, theme);
    const backing = backdrop(theme);
    return {fill, backing: fill ? backing.map(base => compositeColor(fill, base)) : backing};
  };
  const lightBackings = backingFor("light").backing;
  const lightInk = renderDrawingColor(ink,"ink","light") ?? "#78866c";
  const intendedContrast = Math.min(...lightBackings.map(base =>
    contrastRatio(luminance(compositeColor(lightInk, base)), luminance(base))));
  for (const theme of appearanceThemes) {
    const {fill, backing} = backingFor(theme);
    if(fill)styles.push(`--text-fill-${theme}:${fill}`);
    const edge=renderDrawingColor(decoration.textBorder?.color,"stroke",theme)??(theme==="dark"?"#969a8c":"#747d67");
    if(edgeStyle)styles.push(`--text-edge-${theme}:${readableColor(edge, backing, 3).color}`);
    const min = theme === "dark" ? Math.max(4.5, Math.min(7, intendedContrast)) : 4.5;
    const result = readableColor(renderDrawingColor(ink,"ink",theme) ?? "#78866c", backing, min);
    styles.push(`--text-ink-${theme}:${result.color}`);
    if (!result.meetsContrast && !readableColor(result.color, backing, 4.5).meetsContrast) {
      const halo = luminance(unpackColor(result.color)[0]) < .18 ? "#ffffff" : "#000000";
      styles.push(`--text-halo-${theme}:${halo}`);
    }
  }
  return styles.join(";")+";";
}

const colorRoles = {ink:"ink",fill:"fill",border:"stroke"};
const colorLabels = {ink:"Ink",fill:"Fill",border:"Border"};
const formatTitles = {size:"Text size",ink:"Ink",face:"Typeface",box:"Text box"};
const fills = [["none","None"],["paper","Paper"],["tint","Tint"],["strong","Strong"]];
const borders = [["none","None"],["solid","Solid"],["dashed","Dashed"]];
const closeIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>';
const insetIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><rect x="5.5" y="5.5" width="5" height="5" rx=".5"/></svg>';
const autoHeightIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2"/><path d="M8 4.1v7.8M6.1 6 8 4.1 9.9 6m-3.8 4L8 11.9 9.9 10"/></svg>';

const colorStyles = colors => `--preview-light:${colors.light};--preview-dark:${colors.dark}`;
const storedSize = d => d.textSize??"medium";
const currentSize = d => Number.isInteger(d.textSize)?d.textSize:sizePresets.find(({id})=>id===storedSize(d))?.value??21;
const sizeSelection = d => ({preset:Number.isInteger(d.textSize)?null:storedSize(d)});
const currentPadding = d => d.textPadding??12;
const currentFill = d => d.textFill??"none";
const currentBorder = d => d.textBorder?.style??"none";

const sizeMarkup = '<div data-text-size-scrub></div>';

function faceMarkup() {
  return `<div class="text-format-faces" role="group" aria-label="Typeface">
      ${faces.map(([id,label])=>`<button type="button" data-face="${id}" title="${label}"><span class="text-format-specimen" aria-hidden="true">Aa</span><span>${label}</span></button>`).join("")}
    </div>`;
}

function boxMarkup() {
  return `<div class="text-format-colors">
      <div class="text-format-roles" role="group" aria-label="Color applies to">
        <button type="button" data-role="fill"><span data-role-dot></span>Fill</button><button type="button" data-role="border"><span data-role-dot></span>Border</button>
      </div>
      <div class="text-format-options" data-fill-options role="group" aria-label="Fill style" hidden>
        ${fills.map(([id,label])=>`<button type="button" data-fill="${id}"><span class="text-format-fill-preview"${fillColors[id]?` style="${colorStyles(fillColors[id])}"`:""} aria-hidden="true"></span>${label}</button>`).join("")}
      </div>
      <div class="text-format-options" data-border-options role="group" aria-label="Border style" hidden>
        ${borders.map(([id,label])=>`<button type="button" data-border="${id}"><span class="text-format-border-preview" aria-hidden="true"></span>${label}</button>`).join("")}
      </div>
      ${paletteMarkup(["fill","border"])}
      <button type="button" data-border-auto title="Use the default border color" hidden>Automatic border color</button>
    </div>`;
}

export function mountTextAppearance(popover, decoration, {save, close, layout, previewSize, previewPadding, fitHeight, mode="face"}) {
  const title=formatTitles[mode];
  const content=mode==="size"?sizeMarkup:mode==="ink"?paletteMarkup(["ink"]):mode==="box"?boxMarkup():faceMarkup();
  popover.innerHTML=`<div class="text-format-controls" data-text-format-mode="${mode}">
    <div class="text-format-header"><strong>${title}</strong>
      <button type="button" data-format-close aria-label="Close ${title.toLowerCase()}" title="Close">${closeIcon}</button>
    </div>
    ${content}
    ${mode==="box"?`<div class="text-format-inset">
      <span class="text-format-inset-label" aria-hidden="true">${insetIcon}Padding</span>
      <div data-padding-scrub></div>
    </div>
    <div class="text-format-box-height">
      <button type="button" data-auto-height>${autoHeightIcon}<span>Auto height</span></button>
      <button type="button" data-fit-height>Fit height once</button>
    </div>`:""}
    <div data-style-feedback hidden><span data-style-status role="status"></span><button type="button" data-style-retry hidden>Retry</button></div>
  </div>`;

  const surface=popover.querySelector(".text-format-controls");
  const get=selector=>surface.querySelector(selector);
  const custom=get("[name=custom]");
  const autoHeightToggle=get("[data-auto-height]");
  const fitHeightButton=get("[data-fit-height]");
  const customTarget=get(".text-format-custom"),status=get("[data-style-status]");
  const swatches=get("[data-color-swatches]");
  const fillOptions=get("[data-fill-options]"),borderOptions=get("[data-border-options]"),autoBorder=get("[data-border-auto]");
  const pending=[];
  let saved={...decoration},channel=mode==="ink"?"ink":"fill";
  let active=true,writing=false,failed=null;
  const events=new AbortController();
  const on=(target,event,handler)=>target.addEventListener(event,handler,{signal:events.signal});
  const optimistic=()=>pending.reduce((d,change)=>({...d,...change(d)}),saved);
  const press=(attribute,value)=>surface.querySelectorAll(`[${attribute}]`).forEach(button=>
    button.setAttribute("aria-pressed",String(button.getAttribute(attribute)===value)));
  const borderFor=(d,color)=>({style:d.textBorder?.style??"solid",...(color?{color}:{})});

  function update() {
    if(!active)return;
    const d=optimistic();
    press("data-face",d.textFace??"serif");
    if(mode==="box"){
      press("data-role",channel);
      press("data-fill",currentFill(d));
      press("data-border",currentBorder(d));
      get("[data-role=fill] [data-role-dot]").innerHTML=colorDot(d.textFill,"fill",fillColors[d.textFill]);
      get("[data-role=border] [data-role-dot]").innerHTML=colorDot(d.textBorder?.color,"stroke",
        d.textBorder?{light:"#747d67",dark:"#969a8c"}:undefined);
      fillOptions.hidden=channel!=="fill";
      borderOptions.hidden=channel!=="border";
      autoBorder.hidden=channel!=="border"||!d.textBorder;
      autoBorder.setAttribute("aria-pressed",String(!d.textBorder?.color));
    }
    if(swatches){
      const selected=channel==="ink"?d.color:channel==="fill"?d.textFill:d.textBorder?.color;
      press("data-swatch",selected);
      swatches.dataset.channel=channel;
      swatches.setAttribute("aria-label",`${colorLabels[channel]} color palette`);
      const theme=document.documentElement.dataset.appearance==="dark"?"dark":"light";
      customTarget.classList.toggle("is-selected",isHexColor(selected));
      for (const theme of appearanceThemes) {
        const preview = isHexColor(selected) ? renderDrawingColor(selected, colorRoles[channel], theme) : "transparent";
        customTarget.style.setProperty(`--custom-preview-${theme}`, preview);
      }
      custom.value=pickerHex(isHexColor(selected) ? selected : renderDrawingColor(selected,colorRoles[channel],theme)??fillColors[selected]?.[theme],
        {ink:"#78866c",fill:"#e4e9da",border:"#747d67"}[channel]);
    }
    if(autoHeightToggle){
      const autoHeight=d.textSizing==="auto";
      const action=autoHeight?"Disable auto height":"Enable auto height";
      autoHeightToggle.setAttribute("aria-pressed",String(autoHeight));
      autoHeightToggle.setAttribute("aria-label",action);
      autoHeightToggle.title=action;
      fitHeightButton.disabled=pending.some(change=>change.fit);
    }
    sizeControl?.setValue(currentSize(d),sizeSelection(d));
    paddingControl?.setValue(currentPadding(d));
    const message=failed?(failed.change.fit?"Couldn’t fit the text height.":"Change wasn’t saved."):"";
    get("[data-style-feedback]").hidden=!message;
    get("[data-style-retry]").hidden=!failed;
    if(status.textContent!==message)status.textContent=message;
    layout?.();
  }

  function enqueue(change) {
    if(!Object.keys(change(optimistic())).length){update();return;}
    pending.push(change);
    update();
    void drain();
  }

  // Re-evaluate each intent against the last confirmed result, so a rejected
  // border/style write cannot leak into the next queued patch.
  async function drain() {
    if(writing)return;
    writing=true;
    while(pending.length){
      const change=pending[0],patch=change(saved);
      if(change.fit||Object.keys(patch).length){
        try {
          const result=change.fit?await fitHeight():await save(patch);
          if(result===false)throw new Error("Style change was rejected");
          saved={...saved,...(change.fit&&result&&typeof result==="object"?result:patch)};
          if(failed&&(failed.change.fit===change.fit)&&JSON.stringify(failed.patch)===JSON.stringify(patch))failed=null;
        } catch {failed={change,patch};}
      }
      pending.shift();
      update();
    }
    writing=false;
  }

  const field=(key,value,read=d=>d[key])=>enqueue(d=>read(d)===value?{}:{[key]:value});
  const sizeControl=mode==="size"?mountPresetScrub(get("[data-text-size-scrub]"),{
    label:"Text size",inputLabel:"Adjust text size",unit:"px",presets:sizePresets,min:10,max:144,
    value:currentSize(decoration),selection:sizeSelection(decoration),preview:previewSize,
    commit:(value,{preset})=>field("textSize",preset??value,storedSize),
  }):null;
  const paddingControl=mode==="box"?mountPresetScrub(get("[data-padding-scrub]"),{
    label:"Padding",inputLabel:"Adjust padding",unit:"px",presets:paddingPresets,min:0,max:64,
    value:currentPadding(decoration),preview:previewPadding,
    commit:value=>field("textPadding",value,currentPadding),
  }):null;
  const setColor=(channel,value)=>channel==="ink"?field("color",value):
    channel==="fill"?field("textFill",value,currentFill):
    enqueue(d=>d.textBorder?.color===value?{}:{textBorder:borderFor(d,value)});

  const choose=event=>{
    const button=event.target.closest("button");
    if(!button)return;
    const {face,role,fill,border,swatch}=button.dataset;
    if(button.hasAttribute("data-format-close")){close();return;}
    if(button.hasAttribute("data-style-retry")&&failed){
      const {change}=failed;
      failed=null;
      if(change.fit){pending.push(change);update();void drain();}
      else enqueue(change);
      return;
    }
    if(role){channel=role;update();return;}
    if(button===fitHeightButton){
      const change=()=>({});
      change.fit=true;
      pending.push(change);
      update();
      void drain();
      return;
    }
    if(button===autoHeightToggle){
      const sizing=optimistic().textSizing==="auto"?"fixed":"auto";
      field("textSizing",sizing,d=>d.textSizing??"fixed");
      return;
    }
    if(face)field("textFace",face,d=>d.textFace??"serif");
    if(fill)field("textFill",fill,currentFill);
    if(border)enqueue(d=>currentBorder(d)===border?{}:{textBorder:border==="none"?null:{...d.textBorder,style:border}});
    if(swatch)setColor(channel,swatch);
    if(button.hasAttribute("data-border-auto"))setColor("border",undefined);
  };
  on(surface,"click",choose);
  if(custom)on(custom,"change",()=>setColor(channel,custom.value));
  update();
  return {
    destroy({commit=true}={}) {
      if(!active)return;
      active=false;
      sizeControl?.destroy({commit});
      paddingControl?.destroy({commit});
      events.abort();
    },
    focus() {
      if(sizeControl)sizeControl.focus();
      else restoreFocus(get("[data-face][aria-pressed=true],[data-swatch][aria-pressed=true]")??get("[data-swatch]"));
    },
  };
}
