// A small pool of background workers. Jobs wait in a queue, each worker takes one at a time, and a job can be cancelled
// (which stops the worker running it and starts a fresh one). With zero workers, or no Worker support, run() does the job
// on the page's own thread so everything still works, only slower. The pool only runs when the person has turned local
// computing on. Pure apart from the worker factory it is given.
import { scan } from '../learning/scanner.js';

export function capabilities(nav = globalThis.navigator) {
  const cores = Math.max(1, Number(nav && nav.hardwareConcurrency) || 1);
  let workers = false;
  try { workers = typeof globalThis.Worker === 'function'; } catch (_) { workers = false; }
  return { cores, workers, webgpu: Boolean(nav && nav.gpu), suggestedThreads: Math.max(1, Math.min(cores - 1, 4)) };
}

// Asks the browser for a graphics adapter. Information only: the models here are small and run faster on the processor.
export async function probeGpu(nav = globalThis.navigator) {
  const note = 'The models here are small, so a graphics card would be slower than the processor because of the cost of moving data to it. It is not used.';
  try {
    if (!nav || !nav.gpu || typeof nav.gpu.requestAdapter !== 'function') return { available: false, name: null, used: false, note: 'No graphics card interface in this browser.' };
    const a = await nav.gpu.requestAdapter();
    if (!a) return { available: false, name: null, used: false, note: 'The browser did not offer a graphics adapter.' };
    let name = null;
    try { const info = a.info || (typeof a.requestAdapterInfo === 'function' ? await a.requestAdapterInfo() : null); name = info ? (info.description || info.vendor || null) : null; } catch (_) { name = null; }
    return { available: true, name, used: false, note };
  } catch (_) {
    return { available: false, name: null, used: false, note: 'The graphics check failed. That is fine: it is not needed.' };
  }
}

export function browserWorkerFactory() {
  return new Worker(new URL('./task-worker.js', import.meta.url), { type: 'module' });
}

// size: number of workers (0 runs jobs inline). workerFactory: () => a Worker-like object.
export function createPool({ size = 0, workerFactory = null } = {}) {
  const slots = [];
  const queue = [];
  let nextId = 1;
  let closed = false;
  const stats = { started: 0, finished: 0, failed: 0, cancelled: 0 };

  const spawn = () => {
    const w = workerFactory();
    const slot = { w, job: null };
    w.onmessage = (ev) => {
      const m = (ev && ev.data) || {};
      const job = slot.job;
      if (!job || m.id !== job.id) return;
      slot.job = null;
      if (m.ok) { stats.finished += 1; job.resolve(m.result); } else { stats.failed += 1; job.reject(new Error(m.error || 'The job failed.')); }
      pump();
    };
    w.onerror = (e) => {
      const job = slot.job;
      slot.job = null;
      stats.failed += 1;
      if (job) job.reject(new Error(String((e && e.message) || 'The worker crashed.')));
      replace(slot);
      pump();
    };
    return slot;
  };
  const replace = (slot) => {
    try { slot.w.terminate(); } catch (_) { /* gone */ }
    const i = slots.indexOf(slot);
    if (i >= 0 && !closed) slots[i] = spawn();
  };
  const pump = () => {
    if (closed) return;
    for (const slot of slots) {
      if (slot.job || !queue.length) continue;
      const job = queue.shift();
      slot.job = job;
      stats.started += 1;
      slot.w.postMessage({ id: job.id, ...job.task });
    }
  };
  const ensure = () => {
    if (size > 0 && !slots.length && typeof workerFactory === 'function') for (let i = 0; i < size; i += 1) slots.push(spawn());
  };

  return {
    get size() { return slots.length; },
    stats,
    // task: { type: 'scan', candles, opts } or { type: 'ping' }. Resolves with the result. signal: { aborted } checked before start.
    run(task, { signal = null } = {}) {
      if (closed) return Promise.reject(new Error('The pool is closed.'));
      if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('Cancelled.'), { cancelled: true }));
      if (size <= 0 || typeof workerFactory !== 'function') {
        if (task.type === 'ping') return Promise.resolve({ pong: true, inline: true });
        if (task.type === 'scan') { const o = { ...(task.opts || {}) }; if (signal) o.signal = signal; return scan(task.candles, o); }
        return Promise.reject(new Error(`Unknown job type: ${task.type}`));
      }
      ensure();
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, task, resolve, reject, signal });
        pump();
      });
    },
    // Stops everything in progress and everything waiting. Workers running a job are replaced.
    cancelAll(reason = 'Cancelled.') {
      for (const job of queue.splice(0)) { stats.cancelled += 1; job.reject(Object.assign(new Error(reason), { cancelled: true })); }
      for (const slot of slots.slice()) {
        if (slot.job) { stats.cancelled += 1; const j = slot.job; slot.job = null; j.reject(Object.assign(new Error(reason), { cancelled: true })); replace(slot); }
      }
    },
    terminate() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error('The pool is closed.'));
      for (const slot of slots.splice(0)) { if (slot.job) slot.job.reject(new Error('The pool is closed.')); try { slot.w.terminate(); } catch (_) { /* gone */ } }
    },
  };
}
