// CDE: consolidation ranges of four sizes (small, medium, large, long), tracked at the same time. Pure.
// A window qualifies when its high-low spread is at most maxAtr x ATR. Runs of qualifying windows form one range.
import { atrOf, lastFinite, closeMs, newMsg, evidence, fmtPrice, rollingHighLow } from './common.js';

const SIZES = ['small', 'medium', 'large', 'long'];

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

const r3 = (x) => Math.round(x * 1000) / 1000;

export function run(ctx) {
  const { candles, tf, cfg } = ctx;
  if (!Array.isArray(candles) || !cfg || candles.length < cfg.smallBars + 2) return [];
  const n = candles.length;
  const atr = atrOf(candles, cfg.atrPeriod);
  const first = Math.max(0, n - cfg.lookback);
  const out = [];

  for (const size of SIZES) {
    const S = cfg[`${size}Bars`];
    const maxAtr = cfg[`${size}MaxAtr`];
    if (n < S + 1) continue;
    const runs = [];
    let cur = null;
    const from = Math.max(S - 1, first);
    const win = rollingHighLow(candles, S, from);
    for (let i = from; i < n; i += 1) {
      const a = atr[i];
      let ok = false;
      if (Number.isFinite(a) && a > 0) ok = win.hi[i] - win.lo[i] <= maxAtr * a;
      if (ok) {
        if (cur && cur.end === i - 1) cur.end = i;
        else {
          cur = { start: i, end: i };
          runs.push(cur);
        }
      }
    }

    for (const run of runs.slice(-cfg.maxPerSize)) {
      const rs = Math.max(0, run.start - S + 1);
      const re = run.end;
      let upper = -Infinity;
      let lower = Infinity;
      for (let k = rs; k <= re; k += 1) {
        if (candles[k].high > upper) upper = candles[k].high;
        if (candles[k].low < lower) lower = candles[k].low;
      }
      const A = lastFinite(atr, re);
      if (!(A > 0) || !(upper > lower)) continue;

      // Reactions: touches of a boundary (within 0.1 ATR) that close back inside, at least one bar apart.
      const edge = 0.1 * A;
      let reactions = 0;
      let lastUp = -2;
      let lastDn = -2;
      for (let k = rs; k <= re; k += 1) {
        const c = candles[k];
        if (c.high >= upper - edge && c.close < upper - edge && k - lastUp > 1) {
          reactions += 1;
          lastUp = k;
        }
        if (c.low <= lower + edge && c.close > lower + edge && k - lastDn > 1) {
          reactions += 1;
          lastDn = k;
        }
      }
      if (cfg.minReactions > 0 && reactions < cfg.minReactions) continue;

      // Broken: a later close beyond a boundary by the buffer.
      let breakDir = null;
      const buf = cfg.breakBufferAtr * A;
      for (let k = re + 1; k < n; k += 1) {
        if (candles[k].close > upper + buf) { breakDir = 'up'; break; }
        if (candles[k].close < lower - buf) { breakDir = 'down'; break; }
      }
      const active = !breakDir && n - 1 - re <= cfg.graceBars;
      const validity = breakDir ? 'invalidated' : active ? 'valid' : 'expired';

      const pct = [];
      for (let k = rs + 1; k <= re; k += 1) {
        if (candles[k - 1].close > 0) pct.push((candles[k].close / candles[k - 1].close - 1) * 100);
      }
      const duration = re - rs + 1;
      const sizeAtr = (upper - lower) / A;
      const rank = 20 * Math.min(reactions, 4) + Math.min(duration, 100) / 2;
      const state = breakDir ? `broken ${breakDir}` : active ? 'active' : 'expired';
      out.push(newMsg({
        topic: 'ranges',
        type: size,
        direction: 'none',
        level: { lo: lower, hi: upper },
        price: (upper + lower) / 2,
        atMs: closeMs(candles[re], tf),
        measurements: {
          midpoint: (upper + lower) / 2,
          sizeAtr: r3(sizeAtr),
          durationBars: duration,
          reactions,
          volatilityPct: r3(stdev(pct)),
          active,
          broken: Boolean(breakDir),
          breakDir,
          startEpoch: candles[rs].epoch,
          endEpoch: candles[re].epoch,
        },
        evidence: evidence(rank),
        validity,
        invalidation: { text: `Close beyond ${fmtPrice(upper)} or ${fmtPrice(lower)}`, price: null },
        summary: `${size[0].toUpperCase()}${size.slice(1)} range ${fmtPrice(lower)} to ${fmtPrice(upper)} (${sizeAtr.toFixed(1)} ATR, ${duration} bars, ${reactions} reactions), ${state}.`,
      }));
    }
  }
  return out;
}

export const ENGINE = { code: 'CDE', name: 'Consolidation', stage: 1, prefix: 'cde', topics: ['ranges'], run };
