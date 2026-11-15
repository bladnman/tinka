// While Tinka replaces itself, its server stops for a few seconds. Writes wait
// here instead of failing, and go out once Tinka answers again (update-notice.js).
let gate = null, release = null;
export function holdWrites() { if (!gate) gate = new Promise(resolve => { release = resolve; }); }
export function releaseWrites() { const open = release; gate = release = null; open?.(); }
export const writesReady = () => gate || Promise.resolve();
