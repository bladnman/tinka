// Preserve preset identity even when a custom value matches its number.
export function mountPresetScrub(element, {
  label, inputLabel=`Adjust ${label.toLowerCase()}`, unit="", presets, min, max, step=1, value,
  selection, preview, commit,
}) {
  const choices=presets.map(option=>({...option,id:String(option.id??option.value)}));
  const events=new AbortController();
  const on=(target,type,handler)=>target.addEventListener(type,handler,{signal:events.signal});
  const match=(number,preset)=>preset===undefined ? choices.find(option=>option.value===number)?.id??null : preset;
  const hasMin=Number.isFinite(min),hasMax=Number.isFinite(max),boundedTrack=hasMin&&hasMax&&max>min;
  const baseline=choices[Math.floor(choices.length/2)]?.value??(hasMin?min:hasMax?max:0);
  const unitName=unit==="px"?"pixels":unit;
  let saved={value,preset:match(value,selection?.preset),custom:selection?.custom};
  let gesture=null, keyboard=null, previewing=false, active=true, limit=null, limitTimer=0;

  element.classList.add("preset-scrub");
  const row=document.createElement("div");
  row.className="preset-scrub-row";
  row.setAttribute("role","group");
  row.setAttribute("aria-label",label);
  const buttons=choices.map(option=>{
    const button=document.createElement("button");
    button.type="button";
    button.dataset.scrubPreset=option.id;
    button.title=option.ariaLabel??option.label;
    button.setAttribute("aria-label",button.title);
    if(option.icon)button.innerHTML=option.icon;
    else button.textContent=option.label;
    row.append(button);
    return button;
  });
  const custom=document.createElement("button");
  custom.type="button";
  custom.className="preset-scrub-custom";
  custom.title=`Drag to adjust ${label.toLowerCase()}`;
  custom.dataset.scrubValue="";
  custom.setAttribute("role",boundedTrack?"slider":"spinbutton");
  custom.setAttribute("aria-label",inputLabel);
  if(hasMin)custom.setAttribute("aria-valuemin",String(min));
  if(hasMax)custom.setAttribute("aria-valuemax",String(max));
  custom.innerHTML=`<svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 9h12M5.5 8v2m5-2v2"/>
    ${hasMin?'<path data-scrub-edge="min" d="M2.5 7v4"/>':""}
    ${hasMax?'<path data-scrub-edge="max" d="M13.5 7v4"/>':""}
    <rect data-scrub-thumb x="7" y="5" width="2" height="8" rx=".6" fill="currentColor"/>
  </svg>`;
  const thumb=custom.querySelector("[data-scrub-thumb]");
  const announcement=document.createElement("span");
  announcement.className="preset-scrub-announcement";
  announcement.setAttribute("role","status");
  row.append(custom);
  element.replaceChildren(row,announcement);

  function paint(next, delta=null) {
    for(const button of buttons)
      button.setAttribute("aria-pressed",String(button.dataset.scrubPreset===next.preset));
    custom.dataset.active=String(next.preset===null&&(next.value!==null||!!next.custom));
    custom.setAttribute("aria-valuenow",String(next.value??baseline));
    const amount=value=>`${value}${unitName?` ${unitName}`:""}`;
    custom.setAttribute("aria-valuetext",next.value!==null ? amount(next.value) :
      delta ? `Mixed values, ${delta<0?"decrease":"increase"} by ${amount(Math.abs(delta))}` : "Mixed values");
    thumb.setAttribute("x",String(boundedTrack&&next.value!==null ? 1.5+11*(next.value-min)/(max-min) : 7));
  }
  function clearPreview() {
    if(!previewing)return;
    previewing=false;
    preview?.(null);
  }
  function showPreview(value,delta) {
    paint({value:saved.value===null&&delta!==null?null:value,preset:null,custom:true},delta);
    previewing=true;
    preview?.(value,delta);
  }
  function update(value,preset,delta=null) {
    clearPreview();
    const next=saved.value===null&&delta!==null?null:value;
    const changed=next!==saved.value||preset!==saved.preset||!!delta;
    saved={value:next,preset,custom:preset===null};
    paint(saved);
    if(changed)commit(value,{preset,delta});
  }
  function cancel() {
    gesture=null;keyboard=null;
    delete custom.dataset.dragging;
    clearPreview();
    paint(saved);
  }
  function bounded(value) {
    const anchor=hasMin?min:0,aligned=anchor+Math.round((value-anchor)/step)*step;
    return Math.min(hasMax?max:Infinity,Math.max(hasMin?min:-Infinity,Number(aligned.toFixed(8))));
  }
  function cueLimit(value,direction) {
    const edge=hasMin&&value===min&&direction<0?"min":hasMax&&value===max&&direction>0?"max":null;
    if(edge&&edge!==limit){
      clearTimeout(limitTimer);
      custom.dataset.limitCue=edge;
      announcement.textContent=edge==="min"?"Minimum reached":"Maximum reached";
      limitTimer=setTimeout(()=>{
        delete custom.dataset.limitCue;
        announcement.textContent="";
      },240);
    }
    limit=edge;
  }

  for(const [index,button] of buttons.entries())
    on(button,"click",()=>update(choices[index].value,choices[index].id));
  on(custom,"pointerdown",event=>{
    if(event.button!==0||event.isPrimary===false||gesture)return;
    gesture={id:event.pointerId,x:event.clientX,value:saved.value??baseline,next:null,delta:null};
    custom.setPointerCapture(event.pointerId);
  });
  on(custom,"pointermove",event=>{
    if(gesture?.id!==event.pointerId)return;
    const delta=event.clientX-gesture.x;
    if(gesture.next===null&&Math.abs(delta)<4)return;
    const ticks=Math.trunc(delta/2);
    if(!ticks)return;
    const previous=gesture.next??gesture.value, raw=previous+ticks*step;
    const next=bounded(raw), mixed=saved.value===null;
    const change=mixed?(gesture.delta??0)+ticks*step:next-gesture.value;
    gesture.x=!mixed&&raw!==next?event.clientX:gesture.x+ticks*2;
    if(!mixed)cueLimit(next,ticks);
    if(next===gesture.next&&change===gesture.delta)return;
    gesture.next=next;
    gesture.delta=change;
    custom.dataset.dragging="true";
    showPreview(next,change);
  });
  on(custom,"pointerup",event=>{
    if(gesture?.id!==event.pointerId)return;
    const {next,delta}=gesture;
    gesture=null;
    delete custom.dataset.dragging;
    if(next!==null)update(next,null,delta);
    else paint(saved);
  });
  const abortScrub=event=>{if(gesture?.id===event.pointerId)cancel();};
  on(custom,"pointercancel",abortScrub);
  on(custom,"lostpointercapture",abortScrub);

  const increments={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-10,PageUp:10};
  const adjustment=key=>Object.hasOwn(increments,key)||key==="Home"&&hasMin||key==="End"&&hasMax;
  const commitKeys=()=>{
    if(keyboard===null)return;
    const {value,delta}=keyboard;
    keyboard=null;
    update(value,null,delta);
  };
  on(custom,"keydown",event=>{
    if(event.key==="Escape"&&keyboard!==null){event.preventDefault();event.stopPropagation();cancel();return;}
    if(event.isComposing||event.altKey||event.metaKey||event.ctrlKey||!adjustment(event.key))return;
    event.preventDefault();
    event.stopPropagation();
    const absolute=event.key==="Home"||event.key==="End";
    const base=saved.value??baseline, current=keyboard?.value??base;
    const shift=absolute ? null : (keyboard?.delta??0)+increments[event.key]*step;
    const value=absolute ? event.key==="Home"?min:max : bounded(current+increments[event.key]*step);
    keyboard={value,delta:shift===null?null:saved.value===null?shift:value-base};
    if(absolute||saved.value!==null)cueLimit(value,absolute?(event.key==="Home"?-1:1):increments[event.key]);
    showPreview(value,keyboard.delta);
  });
  on(custom,"keyup",event=>{
    if(!adjustment(event.key))return;
    event.preventDefault();
    event.stopPropagation();
    commitKeys();
  });
  on(custom,"blur",commitKeys);

  paint(saved);
  return {
    setValue(next,{preset,custom}={}) {
      if(!active)return;
      saved={value:next,preset:match(next,preset),custom};
      if(!gesture&&keyboard===null)paint(saved);
    },
    focus() { (buttons.find(button=>button.getAttribute("aria-pressed")==="true")??custom).focus({preventScroll:true}); },
    get editing() { return !!gesture||keyboard!==null; },
    destroy({commit:finish=false}={}) {
      if(!active)return;
      active=false;
      if(finish)commitKeys();
      cancel();
      clearTimeout(limitTimer);
      events.abort();
    },
  };
}
