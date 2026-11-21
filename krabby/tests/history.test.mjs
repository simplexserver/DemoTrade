// Deep history: paging backwards, resuming, cancelling, retrying, and the block cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfill, mergeCandles, validCandle, gapReport, createCandleCache } from '../js/market/backfill.js';
import { simCandles } from './helpers/sim.mjs';

const TF = 60;
// A pretend Deriv: the last `count` candles up to endEpoch (or the latest). The newest candle is still forming.
function fakeDeriv(series, { fail = null } = {}) {
  const calls = [];
  const fetchPage = async ({ endEpoch, count }) => {
    calls.push({ endEpoch, count });
    if (fail && fail(calls.length)) throw new Error('rate limited');
    const upto = endEpoch === 'latest' ? series : series.filter((c) => c.epoch <= endEpoch);
    return upto.slice(-count);
  };
  return { fetchPage, calls };
}
const nowAfter = (series) => () => (series[series.length - 1].epoch + TF * 0.5) * 1000; // the newest candle has not closed yet
const FAST = { delayMs: 0, retryDelayMs: 1 };

const S = simCandles(12000, 5, { kind: 'random_walk' });

test('backfill: collects the target, newest first, contiguous and ordered', async () => {
  const d = fakeDeriv(S);
  const r = await backfill({ asset: 'R_100', tf: TF, targetBars: 7000, pageSize: 2000, fetchPage: d.fetchPage, nowFn: nowAfter(S), ...FAST });
  assert.equal(r.ok, true);
  assert.equal(r.candles.length, 7000);
  assert.equal(r.newestEpoch, S[S.length - 2].epoch, 'the forming candle was left out');
  assert.equal(r.oldestEpoch, S[S.length - 2 - 6999].epoch);
  for (let i = 1; i < r.candles.length; i += 1) assert.equal(r.candles[i].epoch - r.candles[i - 1].epoch, TF);
  assert.deepEqual(r.gaps, { missing: 0, biggest: 0 });
  assert.equal(d.calls[0].endEpoch, 'latest');
  assert.ok(d.calls.every((c) => c.count <= 5000));
  assert.ok(r.pages >= 4 && r.pages <= 6, `pages ${r.pages}`);
  assert.equal(r.reachedStart, false);
});

test('backfill: stops at the start of the data and says so', async () => {
  const short = S.slice(0, 3000);
  const d = fakeDeriv(short);
  const r = await backfill({ asset: 'R_100', tf: TF, targetBars: 10000, pageSize: 2000, fetchPage: d.fetchPage, nowFn: () => Date.now(), ...FAST });
  assert.equal(r.ok, true);
  assert.equal(r.reachedStart, true);
  assert.equal(r.candles.length, 3000);
});

test('backfill: resumes from the cache and asks for less', async () => {
  const mem = new Map();
  const cache = { load: async (a, t) => mem.get(`${a}|${t}`) || [], save: async (a, t, c) => { mem.set(`${a}|${t}`, c); return true; } };
  const first = fakeDeriv(S);
  await backfill({ asset: 'R_100', tf: TF, targetBars: 4000, pageSize: 2000, fetchPage: first.fetchPage, cache, nowFn: nowAfter(S), ...FAST });
  assert.equal(mem.get('R_100|60').length, 4000);
  const warm = fakeDeriv(S);
  const rw = await backfill({ asset: 'R_100', tf: TF, targetBars: 8000, pageSize: 2000, fetchPage: warm.fetchPage, cache, nowFn: nowAfter(S), ...FAST });
  const cold = fakeDeriv(S);
  const rc = await backfill({ asset: 'R_100', tf: TF, targetBars: 8000, pageSize: 2000, fetchPage: cold.fetchPage, nowFn: nowAfter(S), ...FAST });
  assert.equal(rw.candles.length, 8000);
  assert.equal(JSON.stringify(rw.candles), JSON.stringify(rc.candles), 'the same history either way');
  assert.ok(rw.pages < rc.pages, `${rw.pages} pages warm, ${rc.pages} cold`);
});

test('backfill: new candles after a resume are joined to the old ones without a gap', async () => {
  const early = S.slice(0, 8000);
  const mem = new Map();
  const cache = { load: async (a, t) => mem.get(`${a}|${t}`) || [], save: async (a, t, c) => { mem.set(`${a}|${t}`, c); return true; } };
  await backfill({ asset: 'R_100', tf: TF, targetBars: 3000, pageSize: 2000, fetchPage: fakeDeriv(early).fetchPage, cache, nowFn: nowAfter(early), ...FAST });
  const later = S.slice(0, 9500);
  const r = await backfill({ asset: 'R_100', tf: TF, targetBars: 5000, pageSize: 2000, fetchPage: fakeDeriv(later).fetchPage, cache, nowFn: nowAfter(later), ...FAST });
  assert.equal(r.newestEpoch, later[later.length - 2].epoch);
  assert.deepEqual(r.gaps, { missing: 0, biggest: 0 });
  assert.equal(r.candles.length, 5000);
});

test('backfill: cancelling keeps what was collected', async () => {
  const signal = { aborted: false };
  const d = fakeDeriv(S);
  let pages = 0;
  const r = await backfill({
    asset: 'R_100', tf: TF, targetBars: 9000, pageSize: 2000, fetchPage: d.fetchPage, signal, nowFn: nowAfter(S), ...FAST,
    onProgress: () => { pages += 1; if (pages === 2) signal.aborted = true; },
  });
  assert.equal(r.cancelled, true);
  assert.equal(r.ok, false);
  assert.ok(r.candles.length >= 2000 && r.candles.length < 9000);
});

test('backfill: a failing page is retried, and a persistent failure keeps the partial history', async () => {
  const flaky = fakeDeriv(S, { fail: (n) => n === 2 });
  const ok = await backfill({ asset: 'R_100', tf: TF, targetBars: 4000, pageSize: 2000, fetchPage: flaky.fetchPage, nowFn: nowAfter(S), retries: 2, ...FAST });
  assert.equal(ok.ok, true, 'one failure was retried and the run went on');
  const dead = fakeDeriv(S, { fail: (n) => n >= 2 });
  const bad = await backfill({ asset: 'R_100', tf: TF, targetBars: 8000, pageSize: 2000, fetchPage: dead.fetchPage, nowFn: nowAfter(S), retries: 1, ...FAST });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /rate limited/);
  assert.match(bad.error, /kept/);
  assert.ok(bad.candles.length > 0);
  const none = await backfill({ asset: 'R_100', tf: TF, targetBars: 100, fetchPage: async () => { throw new Error('offline'); }, retries: 0, ...FAST });
  assert.equal(none.ok, false);
  assert.equal(none.candles.length, 0);
});

test('mergeCandles, validCandle and gapReport', () => {
  assert.equal(validCandle({ epoch: 1, open: 1, high: 2, low: 0.5, close: 1.5 }), true);
  assert.equal(validCandle({ epoch: 1, open: 1, high: 0.9, low: 0.5, close: 1.5 }), false, 'high below the close');
  assert.equal(validCandle({ epoch: 1, open: -1, high: 2, low: 0.5, close: 1.5 }), false);
  assert.equal(validCandle({ epoch: NaN, open: 1, high: 2, low: 0.5, close: 1.5 }), false);
  const a = [{ epoch: 3, open: 1, high: 2, low: 1, close: 1 }, { epoch: 1, open: 1, high: 2, low: 1, close: 1 }];
  const b = [{ epoch: 2, open: 1, high: 2, low: 1, close: 1 }, { epoch: 3, open: 1, high: 3, low: 1, close: 1 }, { epoch: 4, open: 0, high: 1, low: 0, close: 0 }];
  const m = mergeCandles(a, b);
  assert.deepEqual(m.map((c) => c.epoch), [1, 2, 3]);
  assert.equal(m[2].high, 3, 'the second list wins on a clash');
  assert.deepEqual(gapReport([{ epoch: 0 }, { epoch: 60 }, { epoch: 300 }, { epoch: 360 }], 60), { missing: 3, biggest: 3 });
});

function fakeIdb({ allow = true } = {}) {
  const store = new Map();
  const calls = { putMany: 0, rows: 0 };
  return {
    calls,
    async putMany(name, rows) { if (!allow) return null; calls.putMany += 1; calls.rows += rows.length; for (const r of rows) store.set(r.key, r); return true; },
    async getAll() { return [...store.values()]; },
    async delete(name, key) { store.delete(key); return true; },
  };
}

test('candle cache: round trip, and only changed blocks are rewritten', async () => {
  const idb = fakeIdb();
  const cache = createCandleCache(idb, { block: 1000 });
  const blockOf = (c) => Math.floor(c.epoch / (60 * 1000));
  const first = S.slice(0, 4500);
  await cache.save('R_100', 60, first);
  const blocks1 = new Set(first.map(blockOf)).size;
  assert.ok(blocks1 === 5 || blocks1 === 6, 'a run of 4,500 candles spans five or six blocks');
  assert.equal(idb.calls.rows, blocks1);
  const back = await cache.load('R_100', 60);
  assert.equal(JSON.stringify(back), JSON.stringify(first));
  assert.deepEqual(await cache.load('R_100', 300), []);
  await cache.save('R_100', 60, first);
  assert.equal(idb.calls.rows, blocks1, 'saving the same thing again writes nothing');
  await cache.save('R_100', 60, S.slice(0, 4700));
  const touched = new Set(S.slice(4499, 4700).map(blockOf)).size;
  assert.equal(idb.calls.rows, blocks1 + touched, 'only the blocks that changed were written');
  assert.equal((await cache.load('R_100', 60)).length, 4700);
  assert.ok((await cache.clear('R_100', 60)) >= 5);
  assert.deepEqual(await cache.load('R_100', 60), []);
});

test('candle cache: without the storage consent nothing is written and nothing throws', async () => {
  const idb = fakeIdb({ allow: false });
  const cache = createCandleCache(idb);
  assert.equal(await cache.save('R_100', 60, S.slice(0, 100)), false);
  assert.deepEqual(await cache.load('R_100', 60), []);
});

test('candle cache: a save that was refused is tried again later, not remembered as done', async () => {
  const state = { allow: false };
  const rows = new Map();
  const idb = {
    async putMany(name, list) { if (!state.allow) return null; for (const r of list) rows.set(r.key, r); return true; },
    async getAll() { return [...rows.values()]; },
    async delete(name, key) { rows.delete(key); return true; },
  };
  const cache = createCandleCache(idb, { block: 1000 });
  assert.equal(await cache.save('R_100', 60, S.slice(0, 1500)), false);
  assert.equal(rows.size, 0);
  state.allow = true; // the person accepted storage
  assert.equal(await cache.save('R_100', 60, S.slice(0, 1500)), true);
  assert.ok(rows.size >= 2, 'the same candles are written now that storage is allowed');
});

test('candle cache: keep trims the oldest blocks it holds', async () => {
  const idb = fakeIdb();
  const cache = createCandleCache(idb, { block: 1000 });
  await cache.save('R_100', 60, S.slice(0, 4500));
  const before = (await cache.load('R_100', 60)).length;
  assert.equal(before, 4500);
  assert.equal(await cache.save('R_100', 60, S.slice(0, 4500), { keep: 2000 }), true);
  const after = await cache.load('R_100', 60);
  assert.ok(after.length >= 2000 && after.length < 4500, `older blocks were deleted (kept ${after.length})`);
  assert.equal(after[after.length - 1].epoch, S[4499].epoch, 'the newest candles are the ones kept');
});
