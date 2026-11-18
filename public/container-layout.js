import {mountPresetScrub} from './preset-scrub.js';

export const containerLayouts = [
  ['vertical','Stack','M5 4h10v4H5zm0 8h10v4H5z'],
  ['horizontal','Row','M4 5h4v10H4zm8 0h4v10h-4z'],
  ['grid','Grid','M4 4h4v4H4zm8 0h4v4h-4zM4 12h4v4H4zm8 0h4v4h-4z'],
];
const metrics = {gap:['Gap',[6,12,24]],padding:['Padding',[8,16,32]],columns:['Columns']};
const defaults = {gap:12,padding:16,columns:2};

// Each completed layout or spacing gesture is one undoable operation. Dismissing
// the popover completes a valid in-progress numeric edit before removing its UI.
export function mountContainerLayout(popup, config, {save, preview, reposition, draft={}, failedDraft={}, report}) {
  const state = {...defaults,...config,...draft};
  let metric = 'gap', active = true, failed = {...failedDraft}, control;
  popup.innerHTML = `<div class="container-layout-metrics" role="group" aria-label="Layout spacing">${Object.entries(metrics).map(([key,[label]])=>
    `<button type="button" data-layout-metric="${key}">${label}</button>`).join('')}</div>
  <div class="container-layout-adjust"></div>
  <p class="container-layout-status" role="status"></p><button type="button" data-layout-retry hidden>Retry change</button>
  <div class="container-object-actions"><button type="button" data-whiteboard-action="edit">Edit title</button></div>`;
  const adjust = popup.querySelector('.container-layout-adjust');
  const status = popup.querySelector('.container-layout-status');
  const retry = popup.querySelector('[data-layout-retry]');
  const measures = [...popup.querySelectorAll('[data-layout-metric]')];

  function sync() {
    for (const button of measures) {
      const key = button.dataset.layoutMetric;
      button.hidden = key==='columns' && state.layout!=='grid';
      button.setAttribute('aria-pressed',String(key===metric));
    }
    for (const button of adjust.querySelectorAll('[data-columns]'))
      button.setAttribute('aria-pressed',String(Number(button.dataset.columns)===state.columns));
    retry.hidden = !Object.keys(failed).length;
    reposition();
  }
  function commit(patch) {
    Object.assign(state,patch);
    for (const key of Object.keys(patch)) delete failed[key];
    if (active) {status.textContent=''; sync();}
    save(patch).catch(error=>{
      const latest = Object.fromEntries(Object.entries(patch).filter(([key,value])=>state[key]===value));
      failed = {...failed,...latest};
      if (active) {status.textContent=error.message;retry.hidden=false;reposition();}
      else report(error);
    });
  }
  function mountMetric() {
    const key=metric,[label,values]=metrics[key];
    if (key==='columns') {
      adjust.innerHTML=`<div class="container-column-options" role="group" aria-label="Grid columns">
        ${Array.from({length:8},(_,index)=>{
          const count=index+1;
          return `<button type="button" data-columns="${count}" aria-label="${count} ${count===1?'column':'columns'}">${count}</button>`;
        }).join('')}</div>`;
      adjust.querySelectorAll('[data-columns]').forEach(button=>button.onclick=()=>{
        const count=Number(button.dataset.columns);
        if(count!==state.columns)commit({columns:count});
      });
      return;
    }
    const field=document.createElement('div');
    adjust.replaceChildren(field);
    control=mountPresetScrub(field,{
      label,unit:'px',min:0,max:128,value:state[key],
      presets:values.map((value,index)=>({value,label:['S','M','L'][index],ariaLabel:`${['Small','Medium','Large'][index]} ${label.toLowerCase()}`})),
      preview:value=>preview?.(value===null?null:{...state,[key]:value}),
      commit:value=>{if(value!==state[key])commit({[key]:value});},
    });
  }
  for (const button of measures) button.onclick=()=>{
    if(metric===button.dataset.layoutMetric)return;
    control?.destroy({commit:true});
    control=null;
    metric = button.dataset.layoutMetric;
    mountMetric();
    sync();
  };
  retry.onclick=()=>commit({...failed});
  mountMetric();
  sync();
  return {
    focus:()=>measures[0]?.focus({preventScroll:true}),
    destroy({commit=true}={}) {active=false;control?.destroy({commit});},
  };
}
