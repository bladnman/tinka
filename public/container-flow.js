// The store and the live preview use the same track measurements.
function tracks(sizes, gap, start) {
  let end=start;
  const offsets=sizes.map(size=>{
    const offset=end;
    end+=size+gap;
    return offset;
  });
  return {offsets,size:sizes.length?end-start-gap:0};
}

export function containerFlow(parent, children) {
  const {layout,padding=16,gap=12,columns=2}=parent.container;
  const titleHeight=typeof parent.text==="string"&&parent.text.trim()?28:0;
  const columnCount=Math.min(children.length,layout==="vertical"?1:layout==="horizontal"?children.length:columns);
  const rowCount=columnCount?Math.ceil(children.length/columnCount):0;
  const widths=Array(columnCount).fill(0), heights=Array(rowCount).fill(0);
  for(const [index,child] of children.entries()){
    const column=index%columnCount,row=Math.floor(index/columnCount);
    widths[column]=Math.max(widths[column],child.width);
    heights[row]=Math.max(heights[row],child.height);
  }
  const x=tracks(widths,gap,parent.x+padding),y=tracks(heights,gap,parent.y+padding+titleHeight);
  return {
    width:Math.max(144,x.size+2*padding),
    height:Math.max(64,y.size+2*padding+titleHeight),
    positions:children.map((_,index)=>({x:x.offsets[index%columnCount],y:y.offsets[Math.floor(index/columnCount)]})),
  };
}
