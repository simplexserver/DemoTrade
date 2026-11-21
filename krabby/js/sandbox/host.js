// The sandbox host: runs one strategy in a fresh Web Worker, with a time limit, and always ends the worker.
// Safe to import anywhere (nothing starts at import time). Tests pass a workerFactory in place of the real Worker.
import { scanCode } from './core.js';

const defaultFactory = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// opts: { code, candles, params, timeoutMs, maxSignals, maxCodeChars, warmup, lookback, expiryBars, tf, seed, workerFactory }
// Resolves (never rejects) with { ok, signals, rejected, truncated, barsRun, ms } or { ok: false, code, error, ms }.
// Codes: blocked_code, bad_input, no_worker, timed_out, worker_error, compile_error, load_error, no_onbar, runtime_error, async_onbar.
export function runStrategy(opts = {}, factoryArg = null) {
  const { code, candles, params = {}, timeoutMs = 3000, maxSignals = 5000, maxCodeChars = 20000, warmup, lookback, expiryBars = null, tf = 0, seed = null } = opts;
  const factory = factoryArg || opts.workerFactory || (typeof Worker === 'undefined' ? null : defaultFactory);
  const t0 = now();
  const ms = () => Math.round(now() - t0);
  const fail = (c, error, extra = {}) => ({ ok: false, code: c, error, signals: [], ms: ms(), ...extra });

  // Checks that need no worker, so a refused strategy costs nothing.
  const scan = scanCode(code, { maxChars: maxCodeChars });
  if (!scan.ok) return Promise.resolve(fail('blocked_code', scan.problems.map((p) => p.text).join(' '), { problems: scan.problems }));
  if (!Array.isArray(candles) || candles.length < 2) return Promise.resolve(fail('bad_input', 'The strategy needs at least two candles.'));
  if (!factory) return Promise.resolve(fail('no_worker', 'This browser cannot run strategy code because it has no Web Worker support.'));

  return new Promise((resolve) => {
    let worker = null;
    let timer = null;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      try {
        if (worker && typeof worker.terminate === 'function') worker.terminate();
      } catch (_) { /* a worker that cannot be ended is already gone */ }
      resolve({ ...result, ms: ms() });
    };
    try {
      worker = factory();
    } catch (e) {
      finish(fail('no_worker', `The strategy worker could not start. ${(e && e.message) || e}`));
      return;
    }
    worker.onmessage = (ev) => {
      const data = ev && ev.data;
      if (data && typeof data === 'object' && typeof data.ok === 'boolean') finish(data);
      else finish(fail('worker_error', 'The strategy worker sent an answer in the wrong shape.'));
    };
    worker.onerror = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      finish(fail('worker_error', `The strategy worker stopped with an error. ${(ev && ev.message) || ''}`.trim()));
    };
    worker.onmessageerror = () => finish(fail('worker_error', 'The strategy worker sent data that could not be read.'));
    timer = setTimeout(() => finish(fail('timed_out', `The strategy ran longer than ${timeoutMs} ms and was stopped. Look for a loop that does not end, or raise the limit in Settings.`)), Math.max(50, Number(timeoutMs) || 3000));
    try {
      worker.postMessage({ code, candles, params, maxSignals, maxCodeChars, warmup, lookback, expiryBars, tf, seed });
    } catch (e) {
      finish(fail('bad_input', `The candles or parameters could not be sent to the worker. ${(e && e.message) || e}`));
    }
  });
}
