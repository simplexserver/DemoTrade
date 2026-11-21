import { parentPort } from 'node:worker_threads';

globalThis.self = {
  postMessage: (m) => parentPort.postMessage(m),
  addEventListener: (type, fn) => { if (type === 'message') parentPort.on('message', (data) => fn({ data })); },
};
await import('../../js/compute/task-worker.js');
