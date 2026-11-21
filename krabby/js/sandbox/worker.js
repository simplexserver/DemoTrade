// The strategy worker. A module Web Worker: it receives { code, candles, params, ... } and answers with the signals.
// Before it accepts any message it removes the network, storage and timer names from its own global object and switches
// off Function.prototype.constructor, so strategy code cannot reach them even by a route the static scan missed.
// The page itself (DOM, cookies, local storage, the Deriv token) is not reachable from a worker at all.
// This is defence in depth and not a security boundary: see core.js. Dynamic import() cannot be removed from inside a
// worker, so the scan refuses it, and the host kills the worker at the time limit.
import { runSandboxed, BLOCKED_GLOBALS } from './core.js';

const scope = typeof self !== 'undefined' ? self : globalThis;
// Keep what we need before anything is removed. Strategy code never sees these: they live in this module's scope.
const post = typeof scope.postMessage === 'function' ? scope.postMessage.bind(scope) : null;
const listen = typeof scope.addEventListener === 'function' ? scope.addEventListener.bind(scope) : null;

function lockdown() {
  const targets = scope === globalThis ? [globalThis] : [globalThis, scope];
  for (const g of targets) {
    for (const name of BLOCKED_GLOBALS) {
      if (name === 'Function' || name === 'Date' || name === 'Proxy' || name === 'Reflect') continue;
      try {
        Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false });
      } catch (_) {
        try {
          g[name] = undefined;
        } catch (__) { /* a name that cannot be removed stays shadowed by the wrapper */ }
      }
    }
  }
  // The route to the Function constructor from any function value, including async and generator functions.
  const protos = [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})];
  for (const p of protos) {
    try {
      Object.defineProperty(p, 'constructor', { value: undefined, writable: false, configurable: false });
    } catch (_) { /* already locked */ }
  }
}

lockdown();

if (listen && post) {
  listen('message', (ev) => {
    let reply;
    try {
      reply = runSandboxed((ev && ev.data) || {});
    } catch (e) {
      reply = { ok: false, code: 'worker_error', error: String((e && e.message) || e), signals: [] };
    }
    post(reply);
  });
}
