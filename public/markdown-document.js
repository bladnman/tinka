// One deliberately small Markdown model shared by the browser and source checks.
export const DOCUMENT_BYTE_LIMIT = 2 * 1024 * 1024;
export const MARKDOWN_TEXT_MODEL = 'markdown-v2';
export function normalizeDocumentText(value) {
  return String(value).replace(/\r\n?/g, '\n').replace(/\s+/gu, ' ').trim();
}
export function documentTextMap(raw){
  const starts=[],ends=[],parts=[];let whitespace=-1;
  for(let i=0;i<raw.length;i++){
    if(/\s/u.test(raw[i])){if(whitespace<0)whitespace=i;continue;}
    if(whitespace>=0&&parts.length){parts.push(' ');starts.push(whitespace);ends.push(i);}
    whitespace=-1;parts.push(raw[i]);starts.push(i);ends.push(i+1);
  }
  return {text:parts.join(''),starts,ends};
}
// Inline Markdown nests: a link inside strikethrough inside italic keeps every layer. Each run
// keeps a flat `text` (its readable text, images excluded) and, for formatting that can hold
// other formatting, `children`. Unclosed markers stay literal text.
const INLINE = new RegExp([
  String.raw`!\[([^\]]*)\]\(([^)]+)\)`,                       // 1,2 image
  String.raw`\[([^\]]+)\]\(([^)]+)\)`,                         // 3,4 link
  String.raw`\x60([^\x60]+)\x60`,                                // 5 code
  String.raw`\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*`,                     // 6 bold italic
  String.raw`\*\*(?!\s)((?:[^*]|\*(?!\*))+?)(?<!\s)\*\*`,         // 7 strong
  String.raw`~~(?!\s)(.+?)(?<!\s)~~`,                             // 8 strikethrough
  String.raw`\*(?![\s*])((?:\*\*.+?\*\*|[^*])+?)(?<!\s)\*`,           // 9 em
  String.raw`(?<![\p{L}\p{N}_])_(?![\s_])(.+?)(?<!\s)_(?![\p{L}\p{N}_])`, // 10 em
].join('|'), 'gu');
const runText = runs => runs.filter(run=>run.type!=='image').map(run=>run.text).join('');
// Inside link text a code span stays literal (`x`), as in the markdown-v2 text model, so existing
// anchors keep their offsets.
const nested = (type, inner, extra = {}, inLink = false) => { const children = parseInline(inner, inLink || type === 'link'); return {type, text: runText(children), ...extra, children}; };
export function inlineRuns(text) { return parseInline(text, false); }
function parseInline(text, inLink) {
  const runs = [], source = String(text);
  let cursor = 0;
  for (const match of source.matchAll(INLINE)) {
    if (match.index > cursor) runs.push({type:'text',text:source.slice(cursor,match.index)});
    if (match[1] !== undefined) runs.push({type:'image',text:match[1],url:match[2]});
    else if (match[3] !== undefined) runs.push(nested('link',match[3],{url:match[4]}));
    else if (match[5] !== undefined) runs.push(inLink ? {type:'text',text:match[0]} : {type:'code',text:match[5]});
    else if (match[6] !== undefined) { const inner = nested('em',match[6],{},inLink); runs.push({type:'strong',text:inner.text,children:[inner]}); }
    else if (match[7] !== undefined) runs.push(nested('strong',match[7],{},inLink));
    else if (match[8] !== undefined) runs.push(nested('del',match[8],{},inLink));
    else runs.push(nested('em',match[9] ?? match[10],{},inLink));
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) runs.push({type:'text',text:source.slice(cursor)});
  return runs;
}
function pipeCells(line){
  const value=line.trim(),cells=[];let cell='',separators=0;
  for(let i=0;i<value.length;i++){
    if(value[i]==='\\'){
      let end=i;while(value[end]==='\\')end++;const count=end-i;
      if(value[end]==='|'&&count%2){cell+='\\'.repeat(count-1)+'|';i=end;continue;}
      cell+='\\'.repeat(count);i=end-1;continue;
    }
    if(value[i]==='|'){cells.push(cell.trim());cell='';separators++;}else cell+=value[i];
  }
  cells.push(cell.trim());if(value.startsWith('|'))cells.shift();if(cells.at(-1)===''&&value.endsWith('|'))cells.pop();
  return separators?cells:null;
}
function tableHeader(lines,index){
  const header=pipeCells(lines[index]||''),separator=pipeCells(lines[index+1]||'');
  if(!header||header.length<2||header.length>16||!separator||separator.length!==header.length||!separator.every(cell=>/^:?-{3,}:?$/.test(cell)))return null;
  return {header,align:separator.map(cell=>cell.startsWith(':')&&cell.endsWith(':')?'center':cell.endsWith(':')?'right':'left')};
}
function pipeTable(lines,index){
  const header=tableHeader(lines,index);if(!header)return null;
  const rows=[];let end=index+2;
  while(end<lines.length){const cells=pipeCells(lines[end]);if(!cells||cells.length!==header.header.length)break;if(rows.length>=200)return null;rows.push(cells.map(inlineRuns));end++;}
  return {block:{type:'table',header:header.header.map(inlineRuns),align:header.align,rows},end};
}
const blockText=block=>block.type==='table'?[block.header,...block.rows].map(row=>row.map(runText).join('\t')).join('\n'):block.items?block.items.map(runText).join('\n'):block.runs?runText(block.runs):block.text||'';
export function parseMarkdown(source,{tables=true}={}) {
  const lines=String(source).replace(/\r\n?/g,'\n').split('\n'),blocks=[],headings=[],slugs=new Map();
  let index=0;
  while(index<lines.length){
    const line=lines[index];if(!line.trim()){index++;continue;}
    if(/^\s*```/.test(line)){
      const code=[];index++;while(index<lines.length&&!/^\s*```/.test(lines[index]))code.push(lines[index++]);if(index<lines.length)index++;
      blocks.push({type:'pre',text:code.join('\n')});continue;
    }
    const table=tables&&pipeTable(lines,index);if(table){blocks.push(table.block);index=table.end;continue;}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);
    if(heading){
      const runs=inlineRuns(heading[2]),label=runText(runs),slug=normalizeDocumentText(label).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'')||'section',count=(slugs.get(slug)||0)+1;slugs.set(slug,count);
      const block={type:`h${heading[1].length}`,runs,id:slug+(count>1?`-${count}`:''),label};blocks.push(block);headings.push({id:block.id,label,level:heading[1].length});index++;continue;
    }
    if(/^\s*(?:---+|\*\*\*+)\s*$/.test(line)){blocks.push({type:'hr'});index++;continue;}
    if(/^\s*>\s?/.test(line)){const parts=[];while(index<lines.length&&/^\s*>\s?/.test(lines[index]))parts.push(lines[index++].replace(/^\s*>\s?/,''));blocks.push({type:'blockquote',runs:inlineRuns(parts.join(' '))});continue;}
    const list=line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
    if(list){
      const ordered=Boolean(list[2]),items=[],tasks=[];while(index<lines.length){const item=lines[index].match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);if(!item||Boolean(item[2])!==ordered)break;
        // Checklist items (`- [ ] todo`, `- [x] done`) keep their state beside the item's runs.
        const task=ordered?null:item[3].match(/^\[([ xX])\](?:\s+(.*))?$/);tasks.push(task?task[1]!==' ':null);items.push(inlineRuns(task?(task[2]||'').trim():item[3]));index++;}
      const block={type:ordered?'ol':'ul',items};if(tasks.some(state=>state!==null))block.tasks=tasks;blocks.push(block);continue;
    }
    const paragraph=[];while(index<lines.length&&lines[index].trim()&&!/^(#{1,4}\s|\s*```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[index])&&!(tables&&tableHeader(lines,index)))paragraph.push(lines[index++].trim());
    if(!paragraph.length)paragraph.push(lines[index++].trim());blocks.push({type:'p',runs:inlineRuns(paragraph.join(' '))});
  }
  const rawText=blocks.map(blockText).join('\n');
  return {blocks,headings,rawText,text:normalizeDocumentText(rawText),textModel:MARKDOWN_TEXT_MODEL,hasTables:blocks.some(block=>block.type==='table')};
}
export function markdownAssetUrl(value,{baseUrl,origin,resourcePrefix}){
  try{
    const candidate=new URL(value,baseUrl);
    if(!['http:','https:'].includes(candidate.protocol)||candidate.username||candidate.password)return null;
    if(candidate.origin===origin){
      if(!resourcePrefix||!candidate.pathname.startsWith(resourcePrefix))return null;
      let relative=candidate.pathname.slice(resourcePrefix.length);
      for(let i=0;i<3;i++){
        if(relative.split('/').some(part=>!part||part.startsWith('.'))||/[\\\0]/.test(relative))return null;
        const decoded=decodeURIComponent(relative);if(decoded===relative)break;relative=decoded;
      }
    }
    return candidate.href;
  }catch{return null;}
}
export function renderMarkdownDocument(document,model,assetOptions){
  const article=document.createElement('article');article.className='markdown';
  function appendRuns(parent,runs){for(const run of runs){
    if(run.type==='text'){parent.append(document.createTextNode(run.text));continue;}
    if(run.type==='image'){
      const img=document.createElement('img'),url=markdownAssetUrl(run.url,assetOptions);img.alt=run.text;img.loading='lazy';img.referrerPolicy='no-referrer';if(url)img.src=url;parent.append(img);continue;
    }
    const url=run.type==='link'?markdownAssetUrl(run.url,assetOptions):null;
    const tag=run.type==='link'?(url?'a':'span'):['code','strong','em','del'].includes(run.type)?run.type:'span';
    const element=document.createElement(tag);if(run.children&&run.type!=='code')appendRuns(element,run.children);else element.textContent=run.text;
    if(url){element.href=url;element.target='_blank';element.rel='noopener noreferrer';element.referrerPolicy='no-referrer';}
    parent.append(element);
  }}
  model.blocks.forEach((block,index)=>{
    if(index)article.append(document.createTextNode('\n'));
    if(block.type==='table'){
      const region=document.createElement('div');region.className='markdown-table';region.tabIndex=0;region.setAttribute('role','region');region.setAttribute('aria-label','Scrollable table');
      const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');
      function row(cells,header){const tr=document.createElement('tr');cells.forEach((runs,i)=>{if(i)tr.append(document.createTextNode('\t'));const cell=document.createElement(header?'th':'td');if(header)cell.scope='col';cell.style.textAlign=block.align[i];appendRuns(cell,runs);tr.append(cell);});return tr;}
      head.append(row(block.header,true));table.append(head);if(block.rows.length){table.append(document.createTextNode('\n'));block.rows.forEach((cells,i)=>{if(i)body.append(document.createTextNode('\n'));body.append(row(cells,false));});table.append(body);}region.append(table);article.append(region);return;
    }
    const element=document.createElement(block.type);if(block.id)element.id=block.id;
    if(block.tasks)element.className='task-list';
    if(block.items)block.items.forEach((runs,i)=>{if(i)element.append(document.createTextNode('\n'));const li=document.createElement('li'),state=block.tasks?.[i];
      // Read-only checkbox: it adds no text, so the rendered text still matches the parser's.
      if(typeof state==='boolean'){li.className='task';li.dataset.checked=String(state);const box=document.createElement('input');box.type='checkbox';box.checked=state;box.disabled=true;box.tabIndex=-1;box.setAttribute('aria-label',state?'Done':'Not done');li.append(box);}
      appendRuns(li,runs);element.append(li);});
    else if(block.runs)appendRuns(element,block.runs);
    else if(block.type==='pre'){const code=document.createElement('code');code.textContent=block.text;element.append(code);}
    article.append(element);
  });
  return article;
}
export function validTextAnchor(anchor){
  if(!anchor||typeof anchor!=='object'||Array.isArray(anchor)||Object.keys(anchor).some(key=>!['kind','quote','prefix','suffix','start','end','sourceRevision','textModel'].includes(key)))return false;
  if(anchor.kind!=='text'||typeof anchor.quote!=='string'||!anchor.quote.trim()||anchor.quote.length>20000||anchor.quote.includes('\0'))return false;
  for(const key of ['prefix','suffix'])if(anchor[key]!==undefined&&(typeof anchor[key]!=='string'||anchor[key].length>2000||anchor[key].includes('\0')))return false;
  if((anchor.start===undefined)!==(anchor.end===undefined))return false;
  if(anchor.start!==undefined&&(!Number.isSafeInteger(anchor.start)||!Number.isSafeInteger(anchor.end)||anchor.start<0||anchor.end<=anchor.start||anchor.end>2000000))return false;
  if(anchor.textModel!==undefined&&(typeof anchor.textModel!=='string'||!anchor.textModel.trim()||anchor.textModel.length>80||anchor.textModel.includes('\0')))return false;
  return anchor.sourceRevision===undefined||(typeof anchor.sourceRevision==='string'&&anchor.sourceRevision.length>0&&anchor.sourceRevision.length<=256&&!anchor.sourceRevision.includes('\0'));
}
export function locateTextAnchor(source,anchor,revision,textModel){
  if(!validTextAnchor(anchor))return {status:'stale'};
  if(anchor.textModel!==undefined&&anchor.textModel!==textModel)return {status:'unverified'};
  const quote=anchor.quote,contextAt=start=>(anchor.prefix===undefined||source.slice(Math.max(0,start-anchor.prefix.length),start)===anchor.prefix)&&(anchor.suffix===undefined||source.slice(start+quote.length,start+quote.length+anchor.suffix.length)===anchor.suffix);
  const saved=anchor.start!==undefined&&anchor.end===anchor.start+quote.length&&source.slice(anchor.start,anchor.end)===quote;
  const sameRevision=anchor.sourceRevision!==undefined&&anchor.sourceRevision===revision;
  if(saved&&contextAt(anchor.start)&&sameRevision)return {status:'matched',start:anchor.start,end:anchor.end};
  let any=false;const locations=[];
  for(let start=source.indexOf(quote);start!==-1;start=source.indexOf(quote,start+1)){any=true;if(contextAt(start))locations.push(start);if(locations.length>1)break;}
  if(locations.length===1){const start=locations[0];return {status:anchor.sourceRevision===undefined&&(anchor.start===undefined||saved)?'matched':'uncertain',start,end:start+quote.length};}
  // A unique surviving quote with changed surrounding text is still an uncertain history,
  // never a precise highlight. Ambiguous duplicates are stale.
  if(any&&locations.length===0){const start=source.indexOf(quote);if(source.indexOf(quote,start+1)===-1)return {status:'uncertain'};}
  return {status:'stale'};
}
export function selectionTextAnchor(article,selection,sourceRevision){
  if(!selection||selection.rangeCount!==1||selection.isCollapsed)return null;
  const range=selection.getRangeAt(0);if(!article.contains(range.startContainer)||!article.contains(range.endContainer))return null;
  const before=article.ownerDocument.createRange();before.selectNodeContents(article);before.setEnd(range.startContainer,range.startOffset);
  const raw=article.textContent;let rawStart=before.toString().length,rawEnd=rawStart+range.toString().length;
  while(rawStart<rawEnd&&/\s/u.test(raw[rawStart]))rawStart++;
  while(rawEnd>rawStart&&/\s/u.test(raw[rawEnd-1]))rawEnd--;
  const {text,starts,ends}=documentTextMap(raw),start=starts.findIndex(offset=>offset>=rawStart);
  if(start<0)return null;let end=start;while(end<ends.length&&ends[end]<=rawEnd)end++;
  const quote=text.slice(start,end);if(!quote||quote!==normalizeDocumentText(raw.slice(rawStart,rawEnd)))return null;
  const anchor={kind:'text',quote,prefix:text.slice(Math.max(0,start-96),start),suffix:text.slice(end,end+96),start,end,sourceRevision,textModel:MARKDOWN_TEXT_MODEL};
  return validTextAnchor(anchor)?anchor:null;
}
