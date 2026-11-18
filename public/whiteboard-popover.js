// Place a contextual panel outside the selected object and its toolbar. The
// preferred direction continues the toolbar's placement. Near an edge, use an
// open side or scroll the panel within the available room.
export function placeWhiteboardPopover(view, object, toolbar, preferred, width, height) {
  const gap=7, padding=8;
  const left=view.left+padding, right=view.right-padding;
  const top=view.top+padding, bottom=view.bottom-padding;
  const clamp=(value,min,max)=>Math.min(Math.max(value,min),Math.max(min,max));
  const outer={
    left:Math.min(toolbar.left,object.left),right:Math.max(toolbar.right,object.right),
    top:Math.min(toolbar.top,object.top),bottom:Math.max(toolbar.bottom,object.bottom),
  };
  const middleX=clamp((toolbar.left+toolbar.right-width)/2,left,right-width);
  const rooms={top:Math.max(0,outer.top-top-gap),bottom:Math.max(0,bottom-outer.bottom-gap)};
  const vertical=(side,panelHeight)=>{
    const y=side==='top'?outer.top-gap-panelHeight:outer.bottom+gap;
    return {left:middleX,top:clamp(y,top,bottom-panelHeight),maxHeight:panelHeight,side};
  };
  if(rooms[preferred]>=height)return vertical(preferred,height);

  const lateral=[
    {side:'right',left:outer.right+gap,room:right-outer.right-gap},
    {side:'left',left:outer.left-gap-width,room:outer.left-left-gap},
  ].sort((a,b)=>b.room-a.room);
  if(lateral[0].room>=width){
    const maxHeight=Math.min(height,bottom-top);
    return {left:lateral[0].left,top:clamp(toolbar.top,top,bottom-maxHeight),maxHeight,side:lateral[0].side};
  }

  const other=preferred==='top'?'bottom':'top';
  if(rooms[other]>=height)return vertical(other,height);
  const moreRoom=rooms[preferred]>=rooms[other]?preferred:other;
  const naturalMin=Math.min(height,110,bottom-top);
  const maxHeight=Math.max(naturalMin,Math.min(height,rooms[moreRoom]));
  return vertical(moreRoom,maxHeight);
}
