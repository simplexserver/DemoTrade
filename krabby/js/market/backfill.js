// Deep history: pages of candles fetched backwards in time and joined into one long, clean, ordered series.
// Deriv sends at most 5,000 candles per request, so a long history is many requests. This module is the pure logic: it is
// given fetchPage({ asset, tf, endEpoch, count }) and (optionally) a cache, so it runs and is tested without a network.
// It can be cancelled, it can resume from what the cache already holds, it pauses between requests, and it retries a failed
// page before giving up with what it has. Only public candle data is involved.
const MAX_PAGE = 5000;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function validCandle(c) {
  return c && isNum(c.epoch) && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close)
    && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.high >= Math.max(c.open, c.close) - 1e-12 && c.low <= Math.min(c.open, c.close) + 1e-12;
}

// Joins two lists by epoch (the second wins on a clash), drops bad rows, returns ascending.
export function mergeCandles(a, b) {
  const byEpoch = new Map();
  for (const c of a || []) if (validCandle(c)) byEpoch.set(c.epoch, c);
  for (const c of b || []) if (validCandle(c)) byEpoch.set(c.epoch, c);
  return [...byEpoch.values()].sort((x, y) => x.epoch - y.epoch);
}

// Missing candles inside a series, counted against the most common step. Weekends in a forex series show up here and are normal.
export function gapReport(candles, tf) {
  let missing = 0;
  let biggest = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const miss = Math.round((candles[i].epoch - candles[i - 1].epoch) / tf) - 1;
    if (miss > 0) { missing += miss; if (miss > biggest) biggest = miss; }
  }
  return { missing, biggest };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// opts: { asset, tf, targetBars, fetchPage, cache: { load(asset, tf), save(asset, tf, candles) } | null, signal: { aborted },
//         onProgress({ asset, tf, have, target, pages, oldestEpoch }), pageSize, maxPages, delayMs, retries, retryDelayMs, nowFn }
// Resolves (never rejects) with { ok, candles, added, pages, reachedStart, oldestEpoch, newestEpoch, gaps, error?, cancelled? }.
export async function backfill(opts = {}) {
  const {
    asset, tf, targetBars = 50000, fetchPage, cache = null, signal = null, onProgress = null, pageSize = MAX_PAGE, maxPages = 400,
    delayMs = 250, retries = 2, retryDelayMs = 1000, startWith = null, nowFn = Date.now,
  } = opts;
  const out = { ok: false, candles: [], added: 0, pages: 0, reachedStart: false, oldestEpoch: null, newestEpoch: null, gaps: { missing: 0, biggest: 0 }, cancelled: false };
  if (typeof fetchPage !== 'function' || !asset || !(tf > 0)) return { ...out, error: 'Nothing to fetch with.' };
  const size = Math.max(10, Math.min(MAX_PAGE, Math.floor(pageSize)));
  let have = [];
  try { if (Array.isArray(startWith)) have = mergeCandles([], startWith); else if (cache) have = mergeCandles([], await cache.load(asset, tf) || []); } catch (_) { have = []; }
  const before = have.length;
  const report = () => {
    if (typeof onProgress === 'function') {
      try { onProgress({ asset, tf, have: have.length, target: targetBars, pages: out.pages, oldestEpoch: have.length ? have[0].epoch : null }); } catch (_) { /* a progress hook must not stop the download */ }
    }
  };
  const aborted = () => Boolean(signal && signal.aborted);

  async function page(endEpoch, count) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (aborted()) return { cancelled: true };
      try {
        const list = await fetchPage({ asset, tf, endEpoch, count });
        return { list: Array.isArray(list) ? list : [] };
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
      }
    }
    return { error: String((lastErr && lastErr.message) || lastErr || 'The request failed.') };
  }

  let error = null;
  // 1. Forward: everything newer than what is held (or the latest page when nothing is held).
  if (!aborted()) {
    const r = await page('latest', size);
    if (r.cancelled) out.cancelled = true;
    else if (r.error) error = r.error;
    else {
      out.pages += 1;
      // The newest candle may still be forming. Only candles that have closed are kept.
      have = mergeCandles(have, r.list.filter((c) => c && (c.epoch + tf) * 1000 <= nowFn()));
      report();
    }
  }
  // 2. Backwards until the target, the start of the data, or an error.
  let stalls = 0;
  while (!error && !out.cancelled && have.length < targetBars && out.pages < maxPages) {
    if (aborted()) { out.cancelled = true; break; }
    const oldest = have.length ? have[0].epoch : null;
    if (oldest === null) { out.reachedStart = true; break; }
    if (delayMs > 0) await sleep(delayMs);
    const want = Math.min(size, targetBars - have.length + 50);
    const r = await page(oldest - 1, want);
    if (r.cancelled) { out.cancelled = true; break; }
    if (r.error) { error = r.error; break; }
    out.pages += 1;
    const merged = mergeCandles(have, r.list);
    const grew = merged.length - have.length;
    have = merged;
    report();
    if (cache && out.pages % 5 === 0) { try { await cache.save(asset, tf, have); } catch (_) { /* the cache is a convenience */ } }
    if (r.list.length === 0 || grew === 0) {
      stalls += 1;
      if (stalls >= 2 || r.list.length === 0) { out.reachedStart = true; break; }
    } else stalls = 0;
    if (r.list.length < Math.min(want, 100)) { out.reachedStart = true; break; }
  }
  if (have.length > targetBars) have = have.slice(-targetBars);
  if (cache) { try { await cache.save(asset, tf, have); } catch (_) { /* ignore */ } }
  out.candles = have;
  out.added = Math.max(0, have.length - before);
  out.oldestEpoch = have.length ? have[0].epoch : null;
  out.newestEpoch = have.length ? have[have.length - 1].epoch : null;
  out.gaps = gapReport(have, tf);
  out.ok = !error && !out.cancelled;
  if (error) out.error = error + (have.length ? ` The ${have.length} candles collected so far were kept.` : '');
  return out;
}

// A candle cache on top of the IndexedDB wrapper (or anything with put/putMany/getAll). Candles are stored in blocks, so a
// save rewrites only the blocks that changed. Everything resolves, nothing throws. Writes only happen when the wrapper allows
// them, which is when the storage consent is accepted.
export function createCandleCache(idb, { block = 5000 } = {}) {
  const sig = new Map();
  const keyOf = (asset, tf, b) => `${asset}|${tf}|${b}`;
  const blockOf = (epoch, tf) => Math.floor(epoch / (tf * block));
  return {
    async load(asset, tf) {
      const all = await idb.getAll('candles', `${asset}|${tf}|`);
      if (!Array.isArray(all)) return [];
      const rows = all.filter((r) => r && r.asset === asset && r.tf === tf && Array.isArray(r.data));
      const out = [];
      for (const r of rows) {
        for (const a of r.data) out.push({ epoch: a[0], open: a[1], high: a[2], low: a[3], close: a[4] });
        sig.set(r.key, `${r.data.length}:${r.data.length ? r.data[r.data.length - 1][0] : 0}`);
      }
      return mergeCandles([], out);
    },
    // keep: the most candles to hold for this market and timeframe; older blocks this cache knows about are deleted.
    async save(asset, tf, candles, { keep = 0 } = {}) {
      const list = keep > 0 && candles.length > keep ? candles.slice(-keep) : candles;
      const groups = new Map();
      for (const c of list) {
        const b = blockOf(c.epoch, tf);
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push([c.epoch, c.open, c.high, c.low, c.close]);
      }
      const changed = [];
      const marks = [];
      for (const [b, data] of groups) {
        const key = keyOf(asset, tf, b);
        const s = `${data.length}:${data[data.length - 1][0]}`;
        if (sig.get(key) === s) continue;
        changed.push({ key, asset, tf, block: b, data, savedMs: Date.now() });
        marks.push([key, s]);
      }
      let ok = true;
      if (changed.length) {
        // A block counts as saved only when the write went through, so a refused write (no consent yet) is retried later.
        ok = Boolean(await idb.putMany('candles', changed));
        if (ok) for (const [k, s] of marks) sig.set(k, s);
      }
      if (ok && keep > 0) {
        const prefix = `${asset}|${tf}|`;
        const live = new Set([...groups.keys()].map((b) => keyOf(asset, tf, b)));
        for (const k of [...sig.keys()]) {
          if (k.startsWith(prefix) && !live.has(k)) { await idb.delete('candles', k); sig.delete(k); }
        }
      }
      return ok;
    },
    async clear(asset = null, tf = null) {
      const all = await idb.getAll('candles');
      if (!Array.isArray(all)) return 0;
      let n = 0;
      for (const r of all) {
        if (r && (asset === null || r.asset === asset) && (tf === null || r.tf === tf)) { await idb.delete('candles', r.key); sig.delete(r.key); n += 1; }
      }
      return n;
    },
  };
}
