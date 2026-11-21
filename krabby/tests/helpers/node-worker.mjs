// A workerFactory for host.js that starts the real sandbox worker in a Node worker thread.
import { Worker as NodeWorker } from 'node:worker_threads';

export function nodeWorkerFactory() {
  const w = new NodeWorker(new URL('./node-worker-entry.mjs', import.meta.url));
  const shim = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (m) => w.postMessage(m),
    terminate: () => w.terminate(),
    raw: w,
  };
  w.on('message', (data) => shim.onmessage && shim.onmessage({ data }));
  w.on('error', (e) => shim.onerror && shim.onerror({ message: String((e && e.message) || e), preventDefault() {} }));
  return shim;
}
