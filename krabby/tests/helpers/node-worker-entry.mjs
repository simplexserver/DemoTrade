// Runs js/sandbox/worker.js inside a Node worker thread, as a browser worker would run it.
// It gives the thread a `self` with postMessage and addEventListener, then loads the real worker module (which locks the
// thread down). After that it answers { diag: true } with what the lockdown left reachable.
import { parentPort } from 'node:worker_threads';

// Keep a reference to the global object from before the lockdown: the lockdown removes the name `globalThis` itself.
const G = globalThis;
G.self = {
  postMessage: (m) => parentPort.postMessage(m),
  addEventListener: (type, fn) => {
    if (type === 'message') parentPort.on('message', (data) => fn({ data }));
  },
};
await import('../../js/sandbox/worker.js');
parentPort.on('message', (data) => {
  if (data && data.diag) {
    parentPort.postMessage({
      diag: {
        fetch: typeof G.fetch,
        setTimeout: typeof G.setTimeout,
        process: typeof G.process,
        self: typeof G.self,
        globalThis: typeof G.globalThis,
        functionCtor: typeof Function.prototype.constructor,
        asyncCtor: typeof Object.getPrototypeOf(async function () {}).constructor,
        math: typeof Math.max,
      },
    });
  }
});
