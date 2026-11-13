// Follow the public ellipsis → Details route when a check needs the Inspector.
export async function openItemDetails(control) {
  await control.click();
  await control.page().locator('.workspace-tile-menu [data-tile-menu="details"]').click();
}
export async function legacyNote(page,key) {
  const field=page.locator('.tile-notes textarea');
  if(!await field.count())await page.locator(`[data-tile-notes="${key}"]`).click();
  return field;
}
export async function saveLegacyNote(page,key,value) {
  const field=await legacyNote(page,key);await field.fill(value);
  await page.locator('.tile-notes [type="submit"]').click();await page.locator('.tile-notes').waitFor({state:'detached'});
}
export async function openLegacyItem(page,key,revision=null) {
  await page.locator(`[data-legacy-menu="${key}"]`).click();
  await page.locator(`.legacy-tile-menu [data-open="${key}"]${revision?`[data-revision="${revision}"]`:':not([data-revision])'}`).click();
}
// A drag of a card body must not begin on its independently interactive chrome.
// Hover first, then use rendered hit testing to find exposed host surface.
export async function exposedTileBodyPoint(card, preferred) {
  const page=card.page(),box=await card.boundingBox();
  await page.mouse.move(preferred?.x??box.x+box.width/2,preferred?.y??box.y+box.height/2);
  await card.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const point=await card.evaluate((el,preferred)=>{
    const r=el.getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect();let checks=0;
    const usable=(x,y)=>{
      if(++checks>2048||x<=v.left+1||x>=v.right-1||y<=v.top+1||y>=v.bottom-1)return false;
      const hit=document.elementFromPoint(x,y);
      return hit?.closest('.workspace-card')===el&&!hit.closest('button,a,input,textarea,select,label,[contenteditable],.workspace-tile-toolbar,.workspace-select-dot,.workspace-resize,[data-resize],[data-drag]');
    };
    if(preferred&&usable(preferred.x,preferred.y))return preferred;
    const xs=[r.right-4,r.left+4,r.right-10,r.left+10,r.x+r.width/2],ys=[r.y+r.height/2,r.bottom-16,r.top+44,r.bottom-4,r.top+4];
    for(const y of ys)for(const x of xs)if(usable(x,y))return {x,y};
    for(let y=Math.max(r.top,v.top)+4;y<Math.min(r.bottom,v.bottom)-3&&checks<2048;y+=12)
      for(let x=Math.min(r.right,v.right)-4;x>Math.max(r.left,v.left)+3&&checks<2048;x-=12)
        if(usable(x,y))return {x,y};
    return null;
  },preferred);
  if(!point)throw Error('Drag fixture has no exposed, non-interactive card body target.');
  return point;
}
