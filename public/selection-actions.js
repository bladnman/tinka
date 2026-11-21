import {positionTilePopover,bindTileMenu} from './tile-ui.js';
import {restoreFocus} from './interaction.js';

export const MORE_SELECTION_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/></svg>';

// One viewport menu for the secondary selection actions. Commands remain owned
// by Home/WorkspaceBoard; this only handles presentation and menu interaction.
export class SelectionActionsMenu {
  close({focus=false}={}) {
    const popup=this.popup;
    if(!popup)return;
    this.popup=null;
    popup.events.abort();popup.binding?.destroy();popup.menu.remove();
    popup.anchor.setAttribute('aria-expanded','false');
    popup.anchor.removeAttribute('aria-controls');
    if(focus)restoreFocus(popup.returnFocus);
  }
  toggle({anchor,entries,run,returnFocus=()=>anchor,context,attribute}) {
    const same=this.popup?.anchor===anchor;
    this.close({focus:same});
    if(same)return;
    const menu=document.createElement('div'),events=new AbortController();
    menu.id=`selection-actions-${crypto.randomUUID()}`;
    menu.className='tk-menu selection-actions-menu';
    menu.dataset.selectionActions=context;
    menu.setAttribute('role','menu');menu.setAttribute('aria-label','More selection actions');
    for(const entry of entries){
      const element=document.createElement(entry==='separator'?'div':'button');
      if(entry==='separator'){element.className='tk-msep';element.setAttribute('role','separator');}
      else {
        element.type='button';element.className=`tk-mi${entry.danger?' tk-danger':''}`;
        element.setAttribute('role','menuitem');element.dataset.selectionAction=entry.action;
        if(attribute)element.setAttribute(attribute,entry.action);
        element.textContent=entry.label;
      }
      menu.append(element);
    }
    Object.assign(menu.style,{maxHeight:`${innerHeight-16}px`});
    document.body.append(menu);positionTilePopover(menu,anchor);
    anchor.setAttribute('aria-expanded','true');anchor.setAttribute('aria-controls',menu.id);
    const popup={menu,anchor,events,returnFocus};this.popup=popup;
    menu.onclick=event=>{
      const action=event.target.closest('[data-selection-action]')?.dataset.selectionAction;
      if(!action)return;
      this.close({focus:true});run(action);
    };
    popup.binding=bindTileMenu(menu,{close:()=>this.close(),returnFocus,anchor,captureKeys:true});
    const away=event=>{if(!menu.contains(event.target)&&!anchor.contains(event.target))this.close();};
    document.addEventListener('pointerdown',away,{capture:true,signal:events.signal});
    document.addEventListener('focusin',away,{signal:events.signal});
  }
}
