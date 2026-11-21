// BDE: breakouts from ranges and levels, with a verdict: genuine (follow-through), false (back inside), or pending. Pure.
import { atrOf, lastFinite, closeMs, newMsg, evidence, fmtPrice } from './common.js';

const r3 = (x) => Math.round(x * 1000) / 1000;
const MAX_KEEP = 10;

export function run(ctx) {
  const { candles, tf, cfg, board, asset } = ctx;
  if (!Array.isArray(candles) || !cfg || !board || candles.length < 5) return [];
  const n = candles.length;
  const A = lastFinite(atrOf(candles, cfg.atrPeriod));
  if (!(A > 0)) return [];
  const buf = cfg.breakAtr * A;
  const windowStart = Math.max(1, n - cfg.lookback);

  const bounds = [];
  for (const m of board.query({ topic: 'ranges', asset, tf })) {
    if (m.validity === 'expired' || !m.level) continue;
    const endEpoch = m.measurements ? m.measurements.endEpoch : null;
    let start = 0;
    if (Number.isFinite(endEpoch)) {
      const idx = candles.findIndex((c) => c.epoch === endEpoch);
      start = idx >= 0 ? idx + 1 : 0;
    }
    bounds.push({ edge: m.level.hi, dir: 'up', source: 'range', start, id: m.id });
    bounds.push({ edge: m.level.lo, dir: 'down', source: 'range', start, id: m.id });
  }
  for (const m of board.query({ topic: 'levels', asset, tf })) {
    if (!m.level) continue;
    const age = m.measurements && Number.isFinite(m.measurements.ageBars) ? m.measurements.ageBars : n;
    const start = Math.max(0, n - age);
    if (m.type === 'resistance') bounds.push({ edge: m.level.hi, dir: 'up', source: 'level', start, id: m.id });
    if (m.type === 'support') bounds.push({ edge: m.level.lo, dir: 'down', source: 'level', start, id: m.id });
  }

  const out = [];
  for (const b of bounds) {
    const up = b.dir === 'up';
    let kb = -1;
    for (let k = Math.max(windowStart, b.start); k < n; k += 1) {
      if (up ? candles[k].close > b.edge + buf : candles[k].close < b.edge - buf) {
        kb = k;
        break;
      }
    }
    if (kb < 0) continue;

    let farthest = 0;
    for (let k = kb + 1; k <= Math.min(n - 1, kb + cfg.followBars); k += 1) {
      farthest = Math.max(farthest, up ? candles[k].high - b.edge : b.edge - candles[k].low);
    }
    farthest = Math.max(farthest, up ? candles[kb].high - b.edge : b.edge - candles[kb].low);
    let failedBack = false;
    for (let k = kb + 1; k <= Math.min(n - 1, kb + cfg.failBars); k += 1) {
      if (up ? candles[k].close <= b.edge : candles[k].close >= b.edge) failedBack = true;
    }
    const followAtr = farthest / A;
    const barsAfter = n - 1 - kb;
    let verdict = 'pending';
    if (failedBack) verdict = 'false';
    else if (followAtr >= cfg.followAtr && barsAfter >= 1) verdict = 'genuine';

    let retested = false;
    for (let k = kb + 1; k <= Math.min(n - 1, kb + cfg.retestBars); k += 1) {
      const c = candles[k];
      if (up ? c.low <= b.edge + 0.25 * A && c.close > b.edge : c.high >= b.edge - 0.25 * A && c.close < b.edge) retested = true;
    }
    const strength = Math.abs(candles[kb].close - b.edge) / A;
    const rank = (verdict === 'genuine' ? 70 : verdict === 'pending' ? 50 : 20) + 10 * Math.min(strength, 2) + (retested ? 10 : 0);
    out.push(newMsg({
      topic: 'breakouts',
      type: up ? 'bullish' : 'bearish',
      direction: up ? 'up' : 'down',
      level: { lo: b.edge, hi: b.edge },
      price: b.edge,
      atMs: closeMs(candles[kb], tf),
      measurements: {
        verdict,
        source: b.source,
        strengthAtr: r3(strength),
        followThroughAtr: r3(followAtr),
        retested,
        barsSince: barsAfter,
        boundaryId: b.id,
      },
      evidence: evidence(rank),
      invalidation: { text: `${up ? 'Close back below' : 'Close back above'} ${fmtPrice(b.edge)}`, price: b.edge },
      summary: `${up ? 'Upside' : 'Downside'} break of ${b.source === 'range' ? 'a range' : 'a level'} at ${fmtPrice(b.edge)}: ${verdict}${retested ? ', retested' : ''}.`,
    }));
  }
  out.sort((x, y) => x.atMs - y.atMs);
  return out.length > MAX_KEEP ? out.slice(-MAX_KEEP) : out;
}

export const ENGINE = { code: 'BDE', name: 'Breakout', stage: 2, prefix: 'bde', topics: ['breakouts'], run };
