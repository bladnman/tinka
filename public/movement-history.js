// Movement receipts are opaque server-authenticated inverses, scoped to one tab
// and workspace. Canonical item content/review never enters this client history.
export class MovementHistory {
  constructor(client, workspaceId, onChange = () => {}) {
    this.client = client;
    this.key = `tinka/${workspaceId}/movement-history`;
    this.onChange = onChange;
    this.state = {undo:[],redo:[]};
    this.busy = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.key) || "null");
      for (const direction of ["undo","redo"])
        this.state[direction] = (Array.isArray(saved?.[direction]) ? saved[direction] : [])
          .filter(entry => entry && typeof entry.label === "string" && entry.history && typeof entry.history === "object")
          .slice(-50);
    } catch {}
    while (this.state.undo.length + this.state.redo.length > 50) this.state.undo.shift();
    client.onHistory = (history, operation) => this.record(history, operation);
  }
  label(direction) { return this.state[direction].at(-1)?.label || ""; }
  available(direction) { return !!this.state[direction].length && !this.busy; }
  changed() {
    // Keep a bounded history even for large selections and storage quotas.
    for (const direction of ["undo","redo"]) this.state[direction] = this.state[direction].slice(-50);
    while (this.state.undo.length + this.state.redo.length > 50) this.state.undo.shift();
    while (JSON.stringify(this.state).length > 2_000_000 && this.state.undo.length + this.state.redo.length > 1) {
      if (this.state.undo.length) this.state.undo.shift(); else this.state.redo.shift();
    }
    try { sessionStorage.setItem(this.key,JSON.stringify(this.state)); } catch {}
    this.onChange();
  }
  record(history, {type,data}) {
    const count = data.placementIds?.length || data.clipboard?.placements?.length || 1;
    const action = type === "pastePlacements" ? (count > 1 ? `Paste ${count} items` : "Paste item") : type === "updatePlacement" && ("width" in (data.patch || {}) || "height" in (data.patch || {}))
      ? "Resize item" : count > 1 ? `Move ${count} items` : "Move item";
    this.state.undo.push({history,label:action});
    this.state.redo = [];
    this.changed();
  }
  async replay(direction) {
    if (!this.available(direction) || this.client.pendingWrites) return null;
    const entry = this.state[direction].at(-1);
    const opposite = direction === "undo" ? "redo" : "undo";
    this.busy = true;
    this.onChange();
    try {
      const response = await this.client.write("restoreMovement",{history:entry.history},
        {recordHistory:false,includeHistory:true});
      this.state[direction].pop();
      if (response.history) this.state[opposite].push({history:response.history,label:entry.label});
      this.changed();
      return {label:entry.label,result:response.result};
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
}
