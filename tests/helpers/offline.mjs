// Propagate a network guard to fixture CLIs. Tests never call production APIs.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('Test network guard: production requests are disabled.'));
  return originalFetch(input, options);
};
const preload = `--import=${JSON.stringify(new URL(import.meta.url).pathname)}`;
if (!process.env.NODE_OPTIONS?.includes(preload)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${preload}`.trim();
