// The local server reports source revisions and explicit build states.
export function watchBoard(boardId, { onSnapshot, onManifestChange, onShellChange, onConnection }) {
  let latest;
  let timer;
  let running = false;
  let stopped = false;
  const endpoint = `/api/boards/${encodeURIComponent(boardId)}/live`;

  async function poll() {
    if (running || stopped) return;
    running = true;
    clearTimeout(timer);
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('Live board unavailable');
      const snapshot = await response.json();
      if (!snapshot.concepts || typeof snapshot.revision !== 'string') throw new Error('Invalid board state');
      if (latest && latest.manifestRevision !== snapshot.manifestRevision) await onManifestChange(snapshot.manifestRevision);
      if (latest && latest.shellRevision !== snapshot.shellRevision) onShellChange();
      if (!latest || latest.revision !== snapshot.revision) onSnapshot(snapshot, latest);
      latest = snapshot;
      onConnection(true);
    } catch {
      onConnection(false);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(poll, document.hidden ? 8000 : 2000);
    }
  }

  const visible = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', visible);
  poll();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
}
