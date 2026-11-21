// The compute worker: a module Web Worker that runs the heavy, pure jobs off the page's thread.
// It receives { id, type, ... } and answers { id, ok, result } or { id, ok: false, error }.
// Jobs: 'ping' (is this worker alive), 'scan' (the opportunity scanner on one series of candles).
// Nothing here touches the network, the page, storage or the Deriv token: a worker has no access to them.
import { scan } from '../learning/scanner.js';

const scope = typeof self !== 'undefined' ? self : globalThis;
const post = (m) => scope.postMessage(m);

async function handle(msg) {
  switch (msg.type) {
    case 'ping': return { pong: true };
    case 'scan': {
      const { candles, opts } = msg;
      const safe = { ...(opts || {}) };
      delete safe.signal;
      delete safe.yieldFn;
      return scan(candles, safe);
    }
    default: throw new Error(`Unknown job type: ${msg.type}`);
  }
}

if (typeof scope.addEventListener === 'function') {
  scope.addEventListener('message', async (ev) => {
    const msg = (ev && ev.data) || {};
    try {
      post({ id: msg.id, ok: true, result: await handle(msg) });
    } catch (e) {
      post({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    }
  });
}
