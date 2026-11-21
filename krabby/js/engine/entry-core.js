// Shared core of BLE (buy limit) and SLE (sell limit). SLE is the exact mirror of BLE. Pure.
// A proposal sits at the edge of a zone below price (buy) or above price (sell), with the stop beyond the zone.
// It is a proposal only: the coordinator decides whether a case is built, and risk decides whether it may trade.
import { atrOf, lastFinite, newMsg, evidence, fmtPrice, tfMs } from './common.js';
import { cfgFor } from '../core/schema.js';

const r3 = (x) => Math.round(x * 1000) / 1000;
const CHECKS = ['approaching', 'zoneSide', 'validRange', 'sweepSeen', 'structureOk', 'fvgObOk', 'riskOk'];

export function buildEntries(ctx, side) {
  const buy = side === 'buy';
  const { candles, tf, cfg, board, asset, nowMs, settings } = ctx;
  if (!Array.isArray(candles) || candles.length < 5 || !cfg || !board) return [];
  const A = lastFinite(atrOf(candles, cfg.atrPeriod));
  if (!(A > 0)) return [];
  const close = candles[candles.length - 1].close;
  const zoneHalf = cfgFor('sre', settings).zoneAtr * A;
  const q = (topic, extra = {}) => board.query({ topic, asset, tf, validOnly: true, ...extra });
  const sideName = buy ? 'bullish' : 'bearish';
  const lseCfg = cfgFor('lse', settings);

  const zones = [];
  for (const m of q('levels', { type: buy ? 'support' : 'resistance' })) {
    if (m.level) zones.push({ lo: m.level.lo, hi: m.level.hi, kind: buy ? 'support' : 'resistance' });
  }
  for (const m of q('ranges')) {
    if (!m.level || !(m.measurements && m.measurements.active)) continue;
    const edge = buy ? m.level.lo : m.level.hi;
    zones.push({ lo: edge - zoneHalf, hi: edge + zoneHalf, kind: 'range' });
  }
  const gaps = q('fvg', { type: sideName }).filter((m) => m.level && m.measurements.mitigation !== 'full');
  const blocks = q('orderblocks', { type: sideName }).filter((m) => m.level);
  for (const m of blocks) zones.push({ lo: m.level.lo, hi: m.level.hi, kind: 'order_block' });
  for (const m of gaps) zones.push({ lo: m.level.lo, hi: m.level.hi, kind: 'fvg' });

  const ranges = q('ranges').filter((m) => m.level && m.measurements && m.measurements.active);
  const pde = q('premium');
  const structure = q('structure');
  const sweeps = q('sweeps');
  const liqOther = board.query({ topic: buy ? 'liquidity.sell' : 'liquidity.buy', asset, tf });
  const trendMsg = board.latest('structure', asset, tf, { type: 'trend' });
  const trend = trendMsg && trendMsg.measurements ? trendMsg.measurements.trend : 'range';
  const srd = board.latest('reversal', asset, tf);

  const opposing = [];
  if (trend === (buy ? 'bearish' : 'bullish')) opposing.push(`${buy ? 'bearish' : 'bullish'} structure`);
  if (pde.some((m) => m.type === (buy ? 'premium' : 'discount'))) opposing.push(`${buy ? 'premium' : 'discount'} position`);
  if (srd && srd.type === (buy ? 'bearish_reversal' : 'bullish_reversal') && srd.evidence && srd.evidence.cls === 'strong') {
    opposing.push(`strong ${buy ? 'bearish' : 'bullish'} reversal`);
  }

  // Only recent events count: an old sweep or break says little about the next few bars.
  const barMs = tfMs(tf);
  const withinBars = (atMs, bars) => Number.isFinite(atMs) && (nowMs - atMs) / barMs <= bars;
  const structureTypes = buy ? ['bos_up', 'choch_up', 'mss_up'] : ['bos_down', 'choch_down', 'mss_down'];
  const structureOk = trend === (buy ? 'bullish' : 'bearish')
    || structure.some((m) => structureTypes.includes(m.type) && withinBars(m.atMs, cfg.structureWithinBars));
  const sweepSeen = sweeps.some((m) => m.type === (buy ? 'sweep_low' : 'sweep_high') && m.measurements.outcome === 'rejection'
    && withinBars(m.atMs, cfg.sweepWithinBars))
    || liqOther.some((m) => m.measurements && m.measurements.swept === true && m.validity === 'valid' && m.evidence.rank >= lseCfg.minLiquidityRank
      && Number.isFinite(m.measurements.sweptEpoch) && withinBars((m.measurements.sweptEpoch + Number(tf)) * 1000, cfg.sweepWithinBars));

  const out = [];
  for (const z of zones) {
    const entry = buy ? z.hi : z.lo;
    if (buy ? entry >= close : entry <= close) continue;
    const stop = buy ? z.lo - cfg.stopAtr * A : z.hi + cfg.stopAtr * A;
    const riskPrice = Math.abs(entry - stop);
    if (!(riskPrice > 0)) continue;
    const target = buy ? entry + cfg.rr * riskPrice : entry - cfg.rr * riskPrice;
    const pdeHit = pde.find((m) => m.type === (buy ? 'discount' : 'premium')
      && m.measurements.rangeLo <= entry && entry <= m.measurements.rangeHi
      && (buy ? m.measurements.position <= cfg.zoneSideLimit : m.measurements.position >= 1 - cfg.zoneSideLimit));
    const anyPde = pde.find((m) => m.measurements.rangeLo <= entry && entry <= m.measurements.rangeHi);
    const near = { lo: z.lo - 0.5 * A, hi: z.hi + 0.5 * A };
    const overlaps = (m) => m.level.hi >= near.lo && m.level.lo <= near.hi;
    const flags = {
      approaching: buy ? close - z.hi <= cfg.zoneNearAtr * A : z.lo - close <= cfg.zoneNearAtr * A,
      zoneSide: Boolean(pdeHit),
      validRange: ranges.some((m) => m.level.lo - 0.2 * A <= z.lo && z.hi <= m.level.hi + 0.2 * A),
      sweepSeen,
      structureOk,
      fvgObOk: z.kind === 'fvg' || z.kind === 'order_block' || gaps.some(overlaps) || blocks.some(overlaps),
      riskOk: riskPrice >= cfg.minStopAtr * A && riskPrice <= cfg.maxStopAtr * A && cfg.rr >= cfg.minRR,
    };
    if (!flags.riskOk) continue;
    if (cfg.requireSweep && !flags.sweepSeen) continue;
    if (cfg.requireStructure && !flags.structureOk) continue;
    if (cfg.requireFvgOb && !flags.fvgObOk) continue;

    const checks = {
      [buy ? 'approachingSupport' : 'approachingResistance']: flags.approaching,
      [buy ? 'discountZone' : 'premiumZone']: flags.zoneSide,
      validRange: flags.validRange,
      sweepSeen: flags.sweepSeen,
      structureOk: flags.structureOk,
      fvgObOk: flags.fvgObOk,
      riskOk: flags.riskOk,
    };
    const passed = CHECKS.filter((k) => flags[k]).length;
    const rank = 15 * passed;
    const stopAtr = riskPrice / A;
    out.push({
      rank,
      dist: Math.abs(entry - close),
      msg: newMsg({
        topic: buy ? 'entries.buy' : 'entries.sell',
        type: buy ? 'buy_limit' : 'sell_limit',
        direction: buy ? 'up' : 'down',
        level: { lo: z.lo, hi: z.hi },
        price: entry,
        atMs: nowMs,
        measurements: {
          checks,
          checksPassed: passed,
          opposing: [...opposing],
          rr: cfg.rr,
          stopAtr: r3(stopAtr),
          riskPrice,
          zoneKind: z.kind,
          position: pdeHit ? pdeHit.measurements.position : (anyPde ? anyPde.measurements.position : null),
        },
        evidence: evidence(rank),
        invalidation: { text: `${buy ? 'Close below' : 'Close above'} ${fmtPrice(stop)}`, price: stop },
        summary: `${buy ? 'Buy' : 'Sell'} limit at ${fmtPrice(entry)} at the edge of ${z.kind.replace('_', ' ')} ${fmtPrice(z.lo)} to ${fmtPrice(z.hi)}; stop ${fmtPrice(stop)}, objective ${fmtPrice(target)} (${cfg.rr} x risk). ${passed} of 7 checks pass.`,
        plan: {
          side, entry, stop, target, invalidation: stop, zone: { lo: z.lo, hi: z.hi }, riskPrice, objectiveR: cfg.rr, rr: cfg.rr,
          stopAtr: r3(stopAtr), orderType: 'limit',
        },
      }),
    });
  }
  out.sort((a, b) => b.rank - a.rank || a.dist - b.dist);
  return out.slice(0, cfg.maxProposals).map((x) => x.msg);
}
