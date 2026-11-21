// A workerFactory for the compute pool that runs the real js/compute/task-worker.js in a Node worker thread.
import { Worker as NodeWorker } from 'node:worker_threads';

export function nodePoolWorkerFactory() {
  const w = new NodeWorker(new URL('./node-pool-entry.mjs', import.meta.url));
  const shim = { onmessage: null, onerror: null, postMessage: (m) => w.postMessage(m), terminate: () => w.terminate() };
  w.on('message', (data) => shim.onmessage && shim.onmessage({ data }));
  w.on('error', (e) => shim.onerror && shim.onerror({ message: String((e && e.message) || e) }));
  return shim;
}
