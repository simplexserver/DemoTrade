// Shared helpers for the analysis engines. Pure: no DOM, no storage, no clock. Callers pass every time in.
// Candles are Deriv-shaped: { epoch (seconds, open time, UTC), open, high, low, close }. Ascending, no duplicates.
import { atr as atrSeries } from './indicators.js';
import { fingerprint } from '../core/hash.js';

export const ENGINE_VERSION = '0.2.0';

export const tfMs = (tf) => Number(tf) * 1000;
// Close time of a candle in ms. A finding made on this candle is stamped with it ("candle close, UTC").
export const closeMs = (candle, tf) => (candle.epoch + Number(tf)) * 1000;

// ATR series for the candles (warm-up entries are NaN). Many engines ask for the same series on the same candles in one run,
// so it is worked out once per candle list and period. The result is read-only: nobody writes into it.
const ATR_MEMO = new WeakMap();
export function atrOf(candles, period) {
  if (!Array.isArray(candles) || candles.length === 0) return atrSeries(candles, period);
  let byPeriod = ATR_MEMO.get(candles);
  if (!byPeriod) { byPeriod = new Map(); ATR_MEMO.set(candles, byPeriod); }
  const n = candles.length;
  const last = candles[n - 1];
  const hit = byPeriod.get(period);
  if (hit && hit.n === n && hit.last === last) return hit.series;
  const series = atrSeries(candles, period);
  byPeriod.set(period, { n, last, series });
  return series;
}

// Highest high and lowest low of the S candles ending at each index from `from` on (a sliding window, so the cost does not
// grow with S). Entries before `from` are NaN. `from` must be at least S - 1.
export function rollingHighLow(candles, S, from) {
  const n = candles.length;
  const hi = new Float64Array(n).fill(NaN);
  const lo = new Float64Array(n).fill(NaN);
  const dh = [];
  const dl = [];
  let h0 = 0;
  let l0 = 0;
  for (let k = Math.max(0, from - S + 1); k < n; k += 1) {
    const c = candles[k];
    while (dh.length > h0 && candles[dh[dh.length - 1]].high <= c.high) dh.pop();
    dh.push(k);
    while (dl.length > l0 && candles[dl[dl.length - 1]].low >= c.low) dl.pop();
    dl.push(k);
    while (dh[h0] <= k - S) h0 += 1;
    while (dl[l0] <= k - S) l0 += 1;
    if (k >= from) { hi[k] = candles[dh[h0]].high; lo[k] = candles[dl[l0]].low; }
  }
  return { hi, lo };
}

// Last finite value of an array at or before `index`. NaN when none.
export function lastFinite(arr, index = arr.length - 1) {
  for (let i = Math.min(index, arr.length - 1); i >= 0; i -= 1) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return NaN;
}

// Confirmed swing points. A swing at index i is a strict high (or low) over `wing` candles each side.
// Only indexes with `wing` candles after them are returned, so nothing uses future data.
export function confirmedSwings(candles, wing, lookback = Infinity) {
  const n = candles.length;
  const w = Math.max(1, Math.floor(wing) || 1);
  const out = [];
  const first = Math.max(w, n - (Number.isFinite(lookback) ? lookback : n));
  for (let i = first; i <= n - 1 - w; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let k = i - w; k <= i + w; k += 1) {
      if (k === i) continue;
      if (candles[k].high >= h) isHigh = false;
      if (candles[k].low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, type: 'high', price: h, epoch: candles[i].epoch });
    if (isLow) out.push({ index: i, type: 'low', price: l, epoch: candles[i].epoch });
  }
  return out;
}

// A band around a price: { lo, hi }. halfWidth is in price units.
export const zoneOf = (price, halfWidth) => ({ lo: price - Math.abs(halfWidth), hi: price + Math.abs(halfWidth) });

// Evidence class from a 0-100 rank. Fixed cut-offs, passed in from settings.
export function classOf(rank, weakBelow = 40, strongFrom = 70) {
  if (!Number.isFinite(rank)) return null;
  if (rank >= strongFrom) return 'strong';
  if (rank >= weakBelow) return 'developing';
  return 'weak';
}

export const clampRank = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : 0);

// Base message. The engine fills topic, type, direction, level, price, measurements, evidence, invalidation, summary.
// atMs is the close time (ms) of the candle the finding is about. runMs is set by finalizeAll, never by an engine.
export function newMsg(fields) {
  return {
    id: null,
    engine: null,
    version: ENGINE_VERSION,
    asset: null,
    tf: null,
    topic: null,
    type: null,
    direction: 'none',
    level: null,
    price: null,
    atMs: null,
    runMs: null,
    measurements: {},
    evidence: null,
    validity: 'valid',
    invalidation: null,
    inputs: null,
    supersedes: null,
    summary: '',
    plan: null,
    ...fields,
  };
}

// Gives every message of one run its id, engine, market, timeframe, run time and inputs fingerprint.
// Ids are deterministic: the same candles, settings and run time always give the same ids.
export function finalizeAll(meta, messages) {
  return messages.map((m, i) => ({
    ...m,
    id: `${meta.code}:${meta.asset}:${meta.tf}:${meta.runMs}:${m.atMs}:${i}`,
    engine: meta.code,
    version: meta.version || ENGINE_VERSION,
    asset: meta.asset,
    tf: Number(meta.tf),
    runMs: meta.runMs,
    inputs: meta.inputs,
  }));
}

// Fingerprint for a run: the last `window` candles plus the engine's settings.
export const inputsOf = (candles, window, cfg) => fingerprint(candles, window, cfg);

// Evidence object for a message: { rank 0-100, cls 'weak' | 'developing' | 'strong' }.
export function evidence(rank, weakBelow = 40, strongFrom = 70) {
  const r = clampRank(rank);
  return { rank: r, cls: classOf(r, weakBelow, strongFrom) };
}

// A price as short plain text for summaries.
export const fmtPrice = (x) => String(Number(Number(x).toPrecision(8)));

// Rounds a price to the number of decimals of the market (pip). Used for display and for stable comparisons.
export const roundPrice = (p, decimals = 5) => {
  if (!Number.isFinite(p)) return NaN;
  const f = 10 ** decimals;
  return Math.round(p * f) / f;
};
