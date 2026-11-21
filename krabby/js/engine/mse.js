// MSE: market structure. Swings, trend (HH/HL/LH/LL), and breaks of structure (BOS, CHoCH, MSS).
// Pure: no DOM, no storage, no clock. Uses only confirmed swings (a swing needs `wing` candles after it).
import { atrOf, lastFinite, confirmedSwings, closeMs, clampRank, classOf, newMsg } from './common.js';

const MAX_SWINGS = 6; // swing messages kept per kind
const MAX_BREAKS = 12; // most recent breaks reported (bounds the board)
const RANKS = { mss: 80, choch: 65, bos: 55, swing: 30, trend: 40 };

const fmt = (x) => String(Math.round(x * 1e5) / 1e5);

// Trend from the last two confirmed swing highs and lows. Fewer than two of either side: null (unknown).
function trendOf(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return null;
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  if (hh && hl) return 'bullish';
  if (!hh && !hl) return 'bearish';
  return 'range';
}

export function run(ctx) {
  const { candles, tf, cfg } = ctx || {};
  if (!Array.isArray(candles) || !cfg) return [];
  const n = candles.length;
  const wing = cfg.wing;
  if (n < 2 * wing + 3) return [];
  const atr = atrOf(candles, cfg.atrPeriod);
  if (!Number.isFinite(lastFinite(atr))) return [];
  const ev = (rank) => ({ rank, cls: classOf(rank, ctx.settings?.srd?.weakBelow, ctx.settings?.srd?.strongFrom) });

  const swings = confirmedSwings(candles, wing, cfg.lookback).map((s) => ({ ...s, broken: false }));
  const first = Math.max(0, n - cfg.lookback);
  const highs = [];
  const lows = [];
  const breaks = [];
  let si = 0;
  for (let t = first; t < n; t += 1) {
    while (si < swings.length && swings[si].index + wing <= t) {
      const s = swings[si];
      si += 1;
      (s.type === 'high' ? highs : lows).push(s);
    }
    const lastH = highs[highs.length - 1];
    const lastL = lows[lows.length - 1];
    const trend = trendOf(highs, lows) || 'range';
    const c = candles[t];
    const body = Math.abs(c.close - c.open);
    const bigBody = Number.isFinite(atr[t]) && body >= cfg.dispAtr * atr[t];
    if (lastH && !lastH.broken && (cfg.closeBeyond ? c.close : c.high) > lastH.price) {
      lastH.broken = true;
      const kind = trend === 'bullish' ? 'bos' : bigBody ? 'mss' : 'choch';
      breaks.push({ t, dir: 'up', kind, swing: lastH, ref: lastL || null, trend, body });
    }
    if (lastL && !lastL.broken && (cfg.closeBeyond ? c.close : c.low) < lastL.price) {
      lastL.broken = true;
      const kind = trend === 'bearish' ? 'bos' : bigBody ? 'mss' : 'choch';
      breaks.push({ t, dir: 'down', kind, swing: lastL, ref: lastH || null, trend, body });
    }
  }

  const out = [];
  const label = (list, i, up) => {
    if (i === 0) return 'first';
    const higher = list[i].price > list[i - 1].price;
    if (up) return higher ? 'HH' : 'LH';
    return higher ? 'HL' : 'LL';
  };
  const swingMsgs = [];
  for (const [list, up] of [[highs, true], [lows, false]]) {
    for (let i = Math.max(0, list.length - MAX_SWINGS); i < list.length; i += 1) {
      const s = list[i];
      const lab = label(list, i, up);
      swingMsgs.push(newMsg({
        topic: 'structure',
        type: up ? 'swing_high' : 'swing_low',
        direction: 'none',
        level: { lo: s.price, hi: s.price },
        price: s.price,
        atMs: closeMs(candles[s.index + wing], tf),
        measurements: { barsAgo: n - 1 - s.index, label: lab, broken: s.broken, swingEpoch: s.epoch },
        evidence: ev(RANKS.swing),
        invalidation: null,
        summary: `Confirmed swing ${up ? 'high' : 'low'} at ${fmt(s.price)} (${lab}), ${n - 1 - s.index} bars ago.`,
      }));
    }
  }
  swingMsgs.sort((a, b) => a.atMs - b.atMs);
  out.push(...swingMsgs);

  for (const b of breaks.slice(-MAX_BREAKS)) {
    const up = b.dir === 'up';
    const refPrice = b.ref ? b.ref.price : null;
    let invalidated = false;
    if (refPrice !== null) {
      for (let k = b.t + 1; k < n; k += 1) {
        if (up ? candles[k].close < refPrice : candles[k].close > refPrice) { invalidated = true; break; }
      }
    }
    const name = { bos: 'Break of structure', choch: 'Change of character', mss: 'Market structure shift' }[b.kind];
    out.push(newMsg({
      topic: 'structure',
      type: `${b.kind}_${b.dir}`,
      direction: b.dir,
      level: { lo: b.swing.price, hi: b.swing.price },
      price: b.swing.price,
      atMs: closeMs(candles[b.t], tf),
      measurements: {
        swingPrice: b.swing.price, breakClose: candles[b.t].close, bodyAtr: Number.isFinite(atr[b.t]) ? b.body / atr[b.t] : 0,
        trendBefore: b.trend, barsAgo: n - 1 - b.t,
      },
      evidence: ev(RANKS[b.kind]),
      validity: invalidated ? 'invalidated' : 'valid',
      invalidation: refPrice === null ? null : { text: `close ${up ? 'below' : 'above'} ${fmt(refPrice)}`, price: refPrice },
      summary: `${name} ${up ? 'up' : 'down'}: price closed ${up ? 'above' : 'below'} the swing at ${fmt(b.swing.price)} while the trend was ${b.trend}.`,
    }));
  }

  const trend = trendOf(highs, lows);
  if (trend) {
    const lh = highs[highs.length - 1];
    const ll = lows[lows.length - 1];
    const hiLab = lh.price > highs[highs.length - 2].price ? 'HH' : 'LH';
    const loLab = ll.price > lows[lows.length - 2].price ? 'HL' : 'LL';
    out.push(newMsg({
      topic: 'structure',
      type: 'trend',
      direction: trend === 'bullish' ? 'up' : trend === 'bearish' ? 'down' : 'none',
      level: null,
      price: candles[n - 1].close,
      atMs: closeMs(candles[n - 1], tf),
      measurements: { trend, lastHigh: hiLab, lastLow: loLab, swingHigh: lh.price, swingLow: ll.price },
      evidence: ev(RANKS.trend),
      invalidation: null,
      summary: `Structure is ${trend}: last swing high ${hiLab}, last swing low ${loLab}.`,
    }));
  }
  return out;
}

export const ENGINE = { code: 'MSE', name: 'Market structure', stage: 1, prefix: 'mse', topics: ['structure'], run };
