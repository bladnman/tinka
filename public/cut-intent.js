// A native clipboard envelope alone is never authority to remove placements.
// The matching intent is local to this browser profile/config/durable workspace.
export class CutIntent {
  constructor(configId,workspaceId,onChange=()=>{}) {
    this.key=`tinka/${configId}/${workspaceId}/cut-intent`;
    this.workspaceId=workspaceId;
    this.onChange=onChange;
  }
  read() {
    try { const value=JSON.parse(localStorage.getItem(this.key)||'null');return value?.version===1&&value.workspaceId===this.workspaceId?value:null; } catch { return null; }
  }
  active() { const value=this.read();return value?.payload&&value.state!=='consumed'?value:null; }
  clear(expected=this.read()) {
    try { if (JSON.stringify(this.read())===JSON.stringify(expected)) localStorage.removeItem(this.key); } catch {}
    this.onChange();
  }
  prepare(clipboard,sourceBoardId) {
    if (!navigator.locks?.request) throw new Error('Cut needs browser storage and tab locking. Use Copy instead in this browser.');
    const nonce=crypto.randomUUID(),envelope={...clipboard,cut:{nonce,sourceBoardId}};
    const value={version:1,workspaceId:this.workspaceId,nonce,sourceBoardId,payload:JSON.stringify(envelope),state:'pending'};
    try { localStorage.setItem(this.key,JSON.stringify(value)); } catch { throw new Error("Cut needs browser storage. Use Copy instead in this browser."); }
    if (this.read()?.payload!==value.payload) throw new Error('The cut could not be saved in this browser. Use Copy instead.');
    return envelope;
  }
  changed() { this.onChange(); }
  match(envelope) {
    const value=this.active();
    if (!value||value.nonce!==envelope.cut?.nonce||value.sourceBoardId!==envelope.cut?.sourceBoardId||value.payload!==JSON.stringify(envelope))
      throw new Error('This cut was already used or cancelled, or its clipboard data changed. Cut the selection again.');
    return value;
  }
  update(value,patch) {
    if (JSON.stringify(this.read())!==JSON.stringify(value)) return false;
    localStorage.setItem(this.key,JSON.stringify({...value,...patch}));
    this.onChange();
    return true;
  }
  consume(value) { return this.update(value,{state:'consumed',payload:null,operation:null}); }
  async locked(envelope,action) {
    if (!navigator.locks?.request) throw new Error('Cut paste needs browser tab locking. Use Copy instead in this browser.');
    return navigator.locks.request(this.key,()=>action(this.match(envelope)));
  }
}
