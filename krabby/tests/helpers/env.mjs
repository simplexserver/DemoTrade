// Fakes for the runner tests: a clock whose timers only fire when the test says so, browser storage in memory, an IndexedDB
// stand-in with the same rules as the real wrapper (writes only while storage is allowed), and a one-call environment builder.
import { STORES } from '../../js/core/idb.js';
import { createConsent } from '../../js/core/consent.js';
import { createStore } from '../../js/core/store.js';
import { createLog } from '../../js/core/log.js';
import { Runner } from '../../js/runtime/runner.js';

export function makeClock(start = Date.UTC(2026, 10, 19, 0, 0, 0)) {
  const c = { now: start, intervals: new Map(), seq: 0 };
  c.nowFn = () => c.now;
  c.timers = {
    setInterval: (fn, ms) => { c.seq += 1; c.intervals.set(c.seq, { fn, ms, due: c.now + ms }); return c.seq; },
    clearInterval: (id) => { c.intervals.delete(id); },
  };
  // Normal time: every timer fires at its own due time, in order.
  c.advance = (ms) => {
    const end = c.now + ms;
    for (;;) {
      let id = null;
      let due = Infinity;
      for (const [k, t] of c.intervals) if (t.due < due) { due = t.due; id = k; }
      if (id === null || due > end) break;
      c.now = due;
      const t = c.intervals.get(id);
      t.due += t.ms;
      t.fn();
    }
    c.now = end;
  };
  // A throttled tab: a long time passes, then every timer fires once.
  c.sleepThenFire = (ms) => {
    c.now += ms;
    for (const t of [...c.intervals.values()]) { t.due = c.now + t.ms; t.fn(); }
  };
  return c;
}

export function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
    raw: m,
  };
}

// Same contract as createIdb: writes are refused (null) unless allowWrites says yes; reads, deletes and clears always work.
export function createMemoryIdb({ allowWrites = null, available = true } = {}) {
  const data = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()]));
  const writable = () => (typeof allowWrites === 'function' ? Boolean(allowWrites()) : true);
  const keyOf = (store, v) => (v && typeof v === 'object' ? v[STORES[store]] : undefined);
  const api = {
    writes: 0,
    available: () => available,
    async open() { return null; },
    async put(store, value) {
      if (!writable() || !data[store]) return null;
      try { const k = keyOf(store, value); if (k === undefined) return null; data[store].set(k, structuredClone(value)); api.writes += 1; return true; } catch (_) { return null; }
    },
    async putMany(store, values) {
      if (!writable() || !data[store] || !Array.isArray(values)) return null;
      try { for (const v of values) { const k = keyOf(store, v); if (k === undefined) return null; data[store].set(k, structuredClone(v)); } api.writes += 1; return true; } catch (_) { return null; }
    },
    async getAll(store, prefix = null) {
      if (!data[store]) return null;
      return [...data[store].entries()].filter(([k]) => !prefix || String(k).startsWith(prefix)).map(([, v]) => structuredClone(v));
    },
    async delete(store, key) { if (!data[store]) return null; data[store].delete(key); return true; },
    async clear(store) { if (!data[store]) return null; data[store].clear(); return true; },
    async count(store) { return data[store] ? data[store].size : null; },
    peek: (store) => [...data[store].values()],
    sizes: () => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.size])),
  };
  return api;
}

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else out[key] = v;
  }
  return out;
};

// Small, quick defaults: one market, two timeframes, a short warm-up.
export const QUICK = { data: { assets: ['R_100'], timeframes: [60, 300], simSpeed: '60' }, engine: { tradeAssets: ['R_100'], tradeTimeframes: [60, 300] }, hist: { timeframes: [300], targetBars: 3500, autoLoad: false } };

// consent: 'unset' | 'accepted' | 'declined'. Pass ls, ss, idb and clock from an earlier env to reopen "the same browser".
export function makeEnv({
  consent: answer = 'unset', settings = QUICK, ls = fakeStorage(), ss = fakeStorage(), clock = makeClock(), idb = null, nav = undefined,
  loadDeriv = undefined, workerFactory = null, warmupBars = 700, extra = {},
} = {}) {
  const consent = createConsent({ storage: ls });
  if (answer !== 'unset') consent.set(answer);
  const db = idb || createMemoryIdb({ allowWrites: () => consent.allowsStorage() });
  const store = createStore({ storage: ls, session: ss, idb: db, consent });
  store.load();
  for (const [k, v] of Object.entries(flatten(settings))) {
    const r = store.setSetting(k, v);
    if (!r.ok) throw new Error(`setting ${k} refused in the test setup: ${r.error}`);
  }
  const log = createLog({ nowFn: clock.nowFn, emit: false });
  const deps = {
    store, consent, idb: db, log, nowFn: clock.nowFn, timers: clock.timers, workerFactory, warmupBars,
    nav: nav === undefined ? { hardwareConcurrency: 4 } : nav, doc: null, perfNow: () => 0, ...extra,
  };
  if (loadDeriv) deps.loadDeriv = loadDeriv;
  const runner = new Runner(deps);
  return { runner, store, consent, idb: db, ls, ss, clock, log };
}
