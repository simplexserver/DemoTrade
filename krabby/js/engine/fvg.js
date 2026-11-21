// FVG: fair value gaps (three-candle gaps) that carry displacement. A gap alone is not a trade. Pure.
import { atrOf, lastFinite, closeMs, newMsg, evidence, fmtPrice } from './common.js';

const r3 = (x) => Math.round(x * 1000) / 1000;
const MAX_KEEP = 30;

export function run(ctx) {
  const { candles, tf, cfg } = ctx;
  if (!Array.isArray(candles) || !cfg || candles.length < 4) return [];
  const n = candles.length;
  const atr = atrOf(candles, cfg.atrPeriod);
  const A = lastFinite(atr);
  if (!(A > 0)) return [];
  const out = [];

  for (let i = Math.max(2, n - cfg.lookback); i < n; i += 1) {
    const age = n - 1 - i;
    if (age > cfg.maxAgeBars) continue;
    const c0 = candles[i - 2];
    const c1 = candles[i - 1];
    const c2 = candles[i];
    let side = null;
    let bottom = 0;
    let top = 0;
    if (c2.low > c0.high) {
      side = 'bullish';
      bottom = c0.high;
      top = c2.low;
    } else if (c2.high < c0.low) {
      side = 'bearish';
      top = c0.low;
      bottom = c2.high;
    }
    if (!side) continue;
    const size = top - bottom;
    if (size < cfg.minGapAtr * A) continue;

    const a1 = Number.isFinite(atr[i - 1]) && atr[i - 1] > 0 ? atr[i - 1] : A;
    const body = Math.abs(c1.close - c1.open);
    const range = c1.high - c1.low;
    const dirOk = side === 'bullish' ? c1.close > c1.open : c1.close < c1.open;
    const disp = dirOk && body >= cfg.dispAtr * a1 && range > 0 && body / range >= cfg.bodyRatio;
    if (cfg.requireDisplacement && !disp) continue;

    let mitigation = 'none';
    let invalidated = false;
    let touchIdx = -1;
    for (let k = i + 1; k < n; k += 1) {
      const ck = candles[k];
      if (side === 'bullish') {
        if (ck.low <= bottom) mitigation = 'full';
        else if (ck.low <= top && mitigation === 'none') mitigation = 'partial';
        if (ck.close < bottom) invalidated = true;
        if (touchIdx < 0 && ck.low <= top) touchIdx = k;
      } else {
        if (ck.high >= top) mitigation = 'full';
        else if (ck.high >= bottom && mitigation === 'none') mitigation = 'partial';
        if (ck.close > top) invalidated = true;
        if (touchIdx < 0 && ck.high >= bottom) touchIdx = k;
      }
    }
    let reacted = false;
    if (touchIdx >= 0) {
      for (let k = touchIdx; k <= Math.min(n - 1, touchIdx + 3); k += 1) {
        if (side === 'bullish' ? candles[k].close > top : candles[k].close < bottom) reacted = true;
      }
    }

    const sizeAtr = size / A;
    const dispAtr = body / a1;
    const rank = 20 * Math.min(sizeAtr, 2) + 15 * Math.min(dispAtr, 2) + (reacted ? 20 : 0) + (mitigation === 'none' ? 10 : 0)
      + 10 * (1 - Math.min(1, age / cfg.maxAgeBars));
    out.push(newMsg({
      topic: 'fvg',
      type: side,
      direction: side === 'bullish' ? 'up' : 'down',
      level: { lo: bottom, hi: top },
      price: (top + bottom) / 2,
      atMs: closeMs(c2, tf),
      measurements: {
        sizeAtr: r3(sizeAtr),
        displacementAtr: r3(dispAtr),
        displacement: disp,
        ageBars: age,
        mitigation,
        reacted,
        formedEpoch: c2.epoch,
      },
      evidence: evidence(rank),
      validity: invalidated ? 'invalidated' : 'valid',
      invalidation: {
        text: side === 'bullish' ? `Close below ${fmtPrice(bottom)}` : `Close above ${fmtPrice(top)}`,
        price: side === 'bullish' ? bottom : top,
      },
      summary: `${side[0].toUpperCase()}${side.slice(1)} fair value gap ${fmtPrice(bottom)} to ${fmtPrice(top)} (${sizeAtr.toFixed(1)} ATR, ${disp ? 'with' : 'no'} displacement), ${mitigation === 'none' ? 'unfilled' : `${mitigation}ly filled`}${invalidated ? ', invalidated' : ''}.`,
    }));
  }
  return out.length > MAX_KEEP ? out.slice(-MAX_KEEP) : out;
}

export const ENGINE = { code: 'FVG', name: 'Fair value gap', stage: 1, prefix: 'fvg', topics: ['fvg'], run };
