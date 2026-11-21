// SRE: support and resistance zones from clustered confirmed swings, with reactions counted.
// Pure: no DOM, no storage, no clock.
import { atrOf, lastFinite, confirmedSwings, zoneOf, closeMs, clampRank, classOf, newMsg } from './common.js';

const fmt = (x) => String(Math.round(x * 1e5) / 1e5);

// Counts reactions of one zone from candle `from`. Highs clusters react below the zone, lows clusters above it.
function countReactions(candles, from, zone, isHigh) {
  let count = 0;
  let armed = true;
  for (let i = from; i < candles.length; i += 1) {
    const c = candles[i];
    const touches = c.high >= zone.lo && c.low <= zone.hi;
    const away = isHigh ? c.close < zone.lo : c.close > zone.hi;
    let counted = false;
    if (armed && touches && away) {
      count += 1;
      armed = false;
      counted = true;
    }
    if (!armed && !counted && away) armed = true;
  }
  return count;
}

export function run(ctx) {
  const { candles, tf, cfg } = ctx || {};
  if (!Array.isArray(candles) || !cfg) return [];
  const n = candles.length;
  const wing = cfg.wing;
  if (n < 2 * wing + 3) return [];
  const A = lastFinite(atrOf(candles, cfg.atrPeriod));
  if (!(A > 0)) return [];
  const close = candles[n - 1].close;
  const swings = confirmedSwings(candles, wing, cfg.lookback);
  const found = [];

  for (const kind of ['high', 'low']) {
    const isHigh = kind === 'high';
    const list = swings.filter((s) => s.type === kind).sort((a, b) => a.price - b.price || a.index - b.index);
    const clusters = [];
    for (const s of list) {
      const cl = clusters[clusters.length - 1];
      if (cl && Math.abs(s.price - cl.mean) <= cfg.tolAtr * A) {
        cl.items.push(s);
        cl.sum += s.price;
        cl.mean = cl.sum / cl.items.length;
      } else clusters.push({ items: [s], sum: s.price, mean: s.price });
    }
    for (const cl of clusters) {
      const level = cl.mean;
      if (level === close) continue;
      const zone = zoneOf(level, cfg.zoneAtr * A);
      const idxs = cl.items.map((s) => s.index);
      const firstIdx = Math.min(...idxs);
      const lastIdx = Math.max(...idxs);
      const age = n - 1 - firstIdx;
      if (age > cfg.maxAgeBars) continue;
      const reactions = countReactions(candles, firstIdx, zone, isHigh);
      if (reactions < cfg.minReactions) continue;
      let broken = false;
      for (let i = firstIdx; i < n && !broken; i += 1) {
        broken = isHigh ? candles[i].close > zone.hi + cfg.breakAtr * A : candles[i].close < zone.lo - cfg.breakAtr * A;
      }
      const backOnSide = isHigh ? close < zone.lo : close > zone.hi;
      const invalidated = broken && backOnSide;
      const equal = cl.items.length >= 2 ? (isHigh ? 'highs' : 'lows') : 'none';
      const major = cl.items.some((s) => {
        const a = Math.max(0, s.index - 3 * wing);
        const b = Math.min(n - 1, s.index + 3 * wing);
        let hi = -Infinity;
        let lo = Infinity;
        for (let i = a; i <= b; i += 1) {
          if (candles[i].high > hi) hi = candles[i].high;
          if (candles[i].low < lo) lo = candles[i].low;
        }
        return hi - lo >= cfg.majorAtr * A;
      });
      const recency = Math.max(0, Math.min(1, 1 - age / cfg.lookback));
      const rank = clampRank(12 * Math.min(reactions, 6) + 20 * recency + (major ? 15 : 0) + (equal !== 'none' ? 10 : 0));
      const type = level > close ? 'resistance' : 'support';
      const res = type === 'resistance';
      const edge = res ? zone.hi : zone.lo;
      found.push(newMsg({
        topic: 'levels',
        type,
        direction: res ? 'down' : 'up',
        level: zone,
        price: level,
        atMs: closeMs(candles[lastIdx + wing], tf),
        measurements: { reactions, ageBars: age, broken, equal, major, distanceAtr: (level - close) / A },
        evidence: { rank, cls: classOf(rank, ctx.settings?.srd?.weakBelow, ctx.settings?.srd?.strongFrom) },
        validity: invalidated ? 'invalidated' : 'valid',
        invalidation: { text: `close ${res ? 'above' : 'below'} ${fmt(edge)}`, price: edge },
        summary: `${res ? 'Resistance' : 'Support'} at ${fmt(level)} (zone ${fmt(zone.lo)} to ${fmt(zone.hi)}): ${reactions} reactions`
          + `${equal !== 'none' ? `, equal ${equal}` : ''}${major ? ', major swing' : ''}${invalidated ? ', now invalidated' : ''}.`,
      }));
    }
  }
  found.sort((a, b) => b.evidence.rank - a.evidence.rank || a.price - b.price);
  return found.slice(0, cfg.maxLevels);
}

export const ENGINE = { code: 'SRE', name: 'Support and resistance', stage: 1, prefix: 'sre', topics: ['levels'], run };
