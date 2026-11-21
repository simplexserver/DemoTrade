// OBE: order blocks, judged in their structure context and not by candle colour alone. Pure.
// An impulse candle (large body, usually breaking the recent extreme) marks the last opposite candle before it as the zone.
import { atrOf, lastFinite, closeMs, newMsg, evidence, fmtPrice } from './common.js';

const r3 = (x) => Math.round(x * 1000) / 1000;
const KEEP_PER_SIDE = 5;

export function run(ctx) {
  const { candles, tf, cfg, board, asset } = ctx;
  if (!Array.isArray(candles) || !cfg || candles.length < cfg.bosWindow + 3) return [];
  const n = candles.length;
  const atr = atrOf(candles, cfg.atrPeriod);
  const A = lastFinite(atr);
  if (!(A > 0)) return [];
  const trendMsg = board ? board.latest('structure', asset, tf, { type: 'trend' }) : null;
  const trend = trendMsg && trendMsg.measurements ? trendMsg.measurements.trend : 'range';
  const found = { bullish: [], bearish: [] };

  for (let j = Math.max(cfg.bosWindow + 1, n - cfg.lookback); j < n; j += 1) {
    const age = n - 1 - j;
    if (age > cfg.maxAgeBars) continue;
    const a = Number.isFinite(atr[j]) && atr[j] > 0 ? atr[j] : A;
    const c = candles[j];
    const body = Math.abs(c.close - c.open);
    if (body < cfg.dispAtr * a) continue;
    const bull = c.close > c.open;

    let ext = bull ? -Infinity : Infinity;
    for (let k = j - cfg.bosWindow; k < j; k += 1) ext = bull ? Math.max(ext, candles[k].high) : Math.min(ext, candles[k].low);
    const bos = bull ? c.close > ext : c.close < ext;
    if (cfg.requireStructure && !bos) continue;

    let z = -1;
    for (let k = j - 1; k >= Math.max(0, j - cfg.searchBars); k -= 1) {
      const ck = candles[k];
      if (bull ? ck.close < ck.open : ck.close > ck.open) {
        z = k;
        break;
      }
    }
    if (z < 0) continue;
    const zc = candles[z];
    const lo = cfg.useBody ? Math.min(zc.open, zc.close) : zc.low;
    const hi = cfg.useBody ? Math.max(zc.open, zc.close) : zc.high;
    if (!(hi > lo)) continue;

    let mitigated = false;
    let invalidated = false;
    for (let k = j + 1; k < n; k += 1) {
      const ck = candles[k];
      if (ck.low <= hi && ck.high >= lo) mitigated = true;
      if (bull ? ck.close < lo : ck.close > hi) invalidated = true;
    }
    const side = bull ? 'bullish' : 'bearish';
    const aligned = trend === side;
    const dispAtr = body / a;
    const rank = 20 * Math.min(dispAtr, 3) + (aligned ? 25 : 0) + (mitigated ? 0 : 15) + 15 * (1 - Math.min(1, age / cfg.maxAgeBars));
    found[side].push(newMsg({
      topic: 'orderblocks',
      type: side,
      direction: bull ? 'up' : 'down',
      level: { lo, hi },
      price: (lo + hi) / 2,
      atMs: closeMs(c, tf),
      measurements: {
        displacementAtr: r3(dispAtr),
        zoneAtr: r3((hi - lo) / A),
        ageBars: age,
        mitigated,
        structureAligned: aligned,
        brokeStructure: bos,
        formedEpoch: c.epoch,
      },
      evidence: evidence(rank),
      validity: invalidated ? 'invalidated' : 'valid',
      invalidation: { text: bull ? `Close below ${fmtPrice(lo)}` : `Close above ${fmtPrice(hi)}`, price: bull ? lo : hi },
      summary: `${bull ? 'Bullish' : 'Bearish'} order block ${fmtPrice(lo)} to ${fmtPrice(hi)} (impulse ${dispAtr.toFixed(1)} ATR, structure ${aligned ? 'agrees' : 'does not confirm'}), ${mitigated ? 'already revisited' : 'untouched'}${invalidated ? ', invalidated' : ''}.`,
    }));
  }
  return [...found.bullish.slice(-KEEP_PER_SIDE), ...found.bearish.slice(-KEEP_PER_SIDE)];
}

export const ENGINE = { code: 'OBE', name: 'Order block', stage: 1, prefix: 'obe', topics: ['orderblocks'], run };
