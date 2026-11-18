// Source editing for a board-local Text block. Buttons apply ordinary Markdown
// to the selection; the native textarea owns typing, IME and the caret.
const wrappers = {bold:['**','**','bold text'], italic:['*','*','italic text'], code:['`','`','code']};
const linePrefixes = {heading:'# ', list:'- ', task:'- [ ] '};
export const textFormatControls = [
  ['heading','Heading','H'], ['bold','Bold','<strong>B</strong>'], ['italic','Italic','<em>I</em>'],
  ['code','Inline code','&lt;/&gt;'], ['list','Bulleted list','<span aria-hidden="true">• ≡</span>'],
  ['task','Checklist','<span aria-hidden="true">☐</span>'],
];

export function formatTextSelection(area, kind) {
  const {value,selectionStart:start,selectionEnd:end} = area;
  let from=start, to=end, replacement, selection;
  if (wrappers[kind]) {
    const [open,close,placeholder]=wrappers[kind], text=(start===end?placeholder:value.slice(start,end));
    if (text.includes('\n')) return; // Inline formatting belongs to a single line.
    if(start!==end && value.slice(Math.max(0,start-open.length),start)===open && value.slice(end,end+close.length)===close) {
      from=start-open.length;to=end+close.length;replacement=text;selection=[from,from+text.length];
    }else{
      replacement=open+text+close;selection=[start+open.length,start+open.length+text.length];
    }
  } else if (linePrefixes[kind]) {
    from=start===0?0:value.lastIndexOf('\n',start-1)+1;
    const last=value.indexOf('\n',end>start&&value[end-1]==='\n'?end-1:end);
    to=last<0?value.length:last;
    const lines=value.slice(from,to).split('\n'), prefix=linePrefixes[kind];
    const matcher=kind==='heading'?/^#{1,6} /:kind==='task'?/^[-*+] \[[ xX]\] /:/^[-*+] (?!\[[ xX]\] )/;
    const remove=lines.every(line=>matcher.test(line));
    replacement=lines.map(line=>remove?line.replace(matcher,''):matcher.test(line)?line:
      prefix+(kind==='task'?line.replace(/^[-*+] /,''):line)).join('\n');
    selection=start===end?[from+replacement.length,from+replacement.length]:[from,from+replacement.length];
  } else return;
  // Keep Chromium/WebKit's native editor Undo when supported.
  area.focus({preventScroll:true});
  area.setSelectionRange(from,to);
  if(!area.ownerDocument.execCommand?.('insertText',false,replacement))area.setRangeText(replacement,from,to,'end');
  area.setSelectionRange(...selection);
}
