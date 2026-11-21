// PDE: premium and discount. For each relevant range, the midpoint and where the close sits inside it. Pure.
// Discount does not mean buy and premium does not mean sell; the message only describes position.
import { atrOf, lastFinite, newMsg, evidence, fmtPrice } from './common.js';

const r3 = (x) => Math.round(x * 1000) / 1000;

function priceOf(m) {
  if (Number.isFinite(m.price)) return m.price;
  return m.level ? (m.level.lo + m.level.hi) / 2 : NaN;
}

export function run(ctx) {
  const { candles, cfg, board, asset, tf, nowMs } = ctx;
  if (!Array.isArray(candles) || candles.length < 3 || !cfg || !board) return [];
  const A = lastFinite(atrOf(candles, cfg.atrPeriod));
  if (!(A > 0)) return [];
  const close = candles[candles.length - 1].close;
  const cands = [];

  if (cfg.includeCde) {
    for (const m of board.query({ topic: 'ranges', asset, tf, validOnly: true })) {
      if (m.level) cands.push({ lo: m.level.lo, hi: m.level.hi, id: m.id, source: `cde-${m.type}`, rank: m.evidence ? m.evidence.rank : 50 });
    }
  }
  if (cfg.includeSr) {
    let sup = null;
    let res = null;
    for (const m of board.query({ topic: 'levels', asset, tf, validOnly: true })) {
      const p = priceOf(m);
      if (!Number.isFinite(p)) continue;
      if (m.type === 'support' && p < close && (!sup || p > sup.p)) sup = { p, id: m.id };
      if (m.type === 'resistance' && p > close && (!res || p < res.p)) res = { p, id: m.id };
    }
    if (sup && res) cands.push({ lo: sup.p, hi: res.p, id: `${sup.id}+${res.id}`, source: 'sr', rank: 50 });
  }

  const out = [];
  for (const r of cands) {
    if (!(r.hi > r.lo) || close < r.lo || close > r.hi || r.hi - r.lo < cfg.minRangeAtr * A) continue;
    const mid = (r.hi + r.lo) / 2;
    const pos = (close - r.lo) / (r.hi - r.lo);
    const type = pos < 0.5 - cfg.equilibriumBand ? 'discount' : pos > 0.5 + cfg.equilibriumBand ? 'premium' : 'equilibrium';
    out.push(newMsg({
      topic: 'premium',
      type,
      direction: 'none',
      level: { lo: r.lo, hi: r.hi },
      price: mid,
      atMs: nowMs,
      measurements: {
        midpoint: mid,
        position: r3(pos),
        pctCompleted: r3(pos * 100),
        distanceFromMidAtr: r3((close - mid) / A),
        rangeId: r.id,
        rangeLo: r.lo,
        rangeHi: r.hi,
        source: r.source,
      },
      evidence: evidence(r.rank),
      invalidation: { text: `Close outside ${fmtPrice(r.lo)} to ${fmtPrice(r.hi)}`, price: null },
      summary: `Price sits in ${type} (${(pos * 100).toFixed(0)}% of the range ${fmtPrice(r.lo)} to ${fmtPrice(r.hi)}, midpoint ${fmtPrice(mid)}).`,
    }));
  }
  return out;
}

export const ENGINE = { code: 'PDE', name: 'Premium and discount', stage: 1, prefix: 'pde', topics: ['premium'], run };
