// Shared core of BSL (buy-side liquidity) and SSL (sell-side liquidity). SSL is the exact mirror of BSL:
// the work is done in a "transformed" space where sell-side prices are negated, so one code path serves both.
// Pure: no DOM, no storage, no clock. Linear in the lookback times the (small) number of candidates.
import { atrOf, lastFinite, confirmedSwings, closeMs, newMsg, clampRank, classOf } from './common.js';
import { cfgFor } from '../core/schema.js';

export const LIQ_NOTE = 'Estimated from visible structure; not seen.';

const PRIO = { equal: 0, level: 1, swing: 2, previous: 3 };
const fmt = (x) => String(Number(Number(x).toPrecision(8)));

export function buildLiquidity(ctx, side) {
  const buy = side === 'buy';
  const s = buy ? 1 : -1;
  const cfg = ctx.cfg;
  const candles = ctx.candles;
  if (!Array.isArray(candles) || candles.length < 5 || !cfg) return [];
  const n = candles.length;
  const A = lastFinite(atrOf(candles, cfg.atrPeriod));
  if (!(A > 0)) return [];
  const settings = ctx.settings || {};
  const wing = cfgFor('sre', settings).wing; // no bsl.wing / ssl.wing key: nearest is sre.wing
  const lseLook = cfgFor('lse', settings).lookback;
  const hiT = (i) => (buy ? candles[i].high : -candles[i].low);
  const clT = (i) => s * candles[i].close;
  const last = clT(n - 1);
  const tol = cfg.eqTolAtr * A;
  const T = buy
    ? { equal: 'equal_highs', swing: 'swing_high', previous: 'previous_high', level: 'resistance', word: 'Buy-side', where: 'above', kind: 'high' }
    : { equal: 'equal_lows', swing: 'swing_low', previous: 'previous_low', level: 'support', word: 'Sell-side', where: 'below', kind: 'low' };

  const swings = confirmedSwings(candles, wing, cfg.lookback)
    .filter((x) => x.type === T.kind)
    .map((x) => ({ idx: x.index, p: s * x.price }))
    .sort((a, b) => a.p - b.p || a.idx - b.idx);

  const cands = [];
  // (a) equal levels and (b) single swings
  let group = [];
  let sum = 0;
  const flush = () => {
    if (!group.length) return;
    if (group.length >= cfg.minTouches) {
      cands.push({
        kind: 'equal', type: T.equal, p: sum / group.length,
        idx: Math.max(...group.map((x) => x.idx)), first: Math.min(...group.map((x) => x.idx)),
      });
    } else {
      for (const x of group) cands.push({ kind: 'swing', type: T.swing, p: x.p, idx: x.idx, first: x.idx });
    }
    group = [];
    sum = 0;
  };
  for (const x of swings) {
    if (group.length && Math.abs(x.p - sum / group.length) > tol) flush();
    group.push(x);
    sum += x.p;
  }
  flush();

  // (c) previous high or low: extreme of the window n-2*prevBars .. n-prevBars-1
  const pe = n - cfg.prevBars - 1;
  const ps = Math.max(0, n - 2 * cfg.prevBars);
  if (pe >= ps) {
    let bi = -1;
    let bv = -Infinity;
    for (let i = ps; i <= pe; i += 1) {
      if (hiT(i) > bv) { bv = hiT(i); bi = i; }
    }
    if (bi >= 0) cands.push({ kind: 'previous', type: T.previous, p: bv, idx: bi, first: bi });
  }

  // (d) SRE levels on this side
  if (cfg.useLevels && ctx.board && typeof ctx.board.query === 'function') {
    const found = ctx.board.query({ topic: 'levels', asset: ctx.asset, tf: ctx.tf, type: T.level, validOnly: true });
    for (const m of found) {
      const price = Number.isFinite(m.price) ? m.price : (m.level ? (m.level.lo + m.level.hi) / 2 : NaN);
      if (!Number.isFinite(price)) continue;
      const age = Number(m.measurements && m.measurements.ageBars);
      const idx = Math.max(0, Math.min(n - 1, n - 1 - (Number.isFinite(age) ? age : 0)));
      cands.push({ kind: 'level', type: T.level, p: s * price, idx, first: idx });
    }
  }

  // Judge each candidate against the candles after it formed.
  const kept = [];
  for (const c of cands) {
    let sweptIdx = -1;
    let brokenIdx = -1;
    for (let k = c.idx + 1; k < n; k += 1) {
      if (sweptIdx < 0 && hiT(k) > c.p) sweptIdx = k;
      if (brokenIdx < 0 && clT(k) > c.p) brokenIdx = k;
      if (sweptIdx >= 0 && brokenIdx >= 0) break;
    }
    const ahead = c.p > last;
    const recentlySwept = sweptIdx >= n - lseLook;
    let validity = null;
    if (ahead) {
      // A swing is unbroken when no close beyond it happened before the recent sweep window.
      if (c.kind !== 'swing' || brokenIdx < 0 || brokenIdx >= n - lseLook) validity = 'valid';
    } else if (recentlySwept) {
      validity = 'invalidated'; // taken, and price now sits beyond it; the sweep engine still needs to see it
    }
    if (!validity) continue;
    if (Math.abs(c.p - last) > cfg.maxDistAtr * A) continue;
    c.sweptIdx = sweptIdx;
    c.validity = validity;
    c.touches = swings.reduce((a, x) => a + (Math.abs(x.p - c.p) <= tol ? 1 : 0), 0);
    kept.push(c);
  }

  // One per price: keep the strongest kind first, merge anything within the tolerance.
  kept.sort((a, b) => PRIO[a.kind] - PRIO[b.kind] || b.touches - a.touches || b.idx - a.idx || a.p - b.p);
  const merged = [];
  for (const c of kept) {
    if (merged.some((m) => Math.abs(m.p - c.p) <= tol)) continue;
    merged.push(c);
  }
  merged.sort((a, b) => Math.abs(a.p - last) - Math.abs(b.p - last) || a.p - b.p);

  const srd = cfgFor('srd', settings);
  return merged.map((c) => {
    const price = s * c.p;
    const swept = c.sweptIdx >= 0;
    const ageBars = n - 1 - c.first;
    const rank = clampRank(
      20 * Math.min(c.touches, 4) + (c.kind === 'equal' ? 20 : 0) + (swept ? 0 : 15) + 10 * (1 - Math.min(1, ageBars / cfg.lookback)),
    );
    const distanceAtr = (c.p - last) / A;
    const label = c.type.replace('_', ' ');
    const state = swept ? 'already swept' : 'not yet swept';
    const rel = c.validity === 'valid'
      ? `${Math.abs(distanceAtr).toFixed(1)} ATR ${T.where} price`
      : 'now behind price (taken)';
    return newMsg({
      topic: `liquidity.${side}`,
      type: c.type,
      direction: buy ? 'up' : 'down',
      level: { lo: price - tol, hi: price + tol },
      price,
      atMs: closeMs(candles[c.idx], ctx.tf),
      measurements: {
        touches: c.touches,
        ageBars,
        distanceAtr: Math.round(distanceAtr * 1000) / 1000,
        swept,
        sweptEpoch: swept ? candles[c.sweptIdx].epoch : null,
      },
      evidence: { rank, cls: classOf(rank, srd.weakBelow, srd.strongFrom) },
      validity: c.validity,
      invalidation: { text: `Taken when price trades ${buy ? 'above' : 'below'} ${fmt(price)}`, price },
      summary: `${T.word} liquidity (${label}) near ${fmt(price)}, ${rel}, ${state}. ${LIQ_NOTE}`,
    });
  });
}
