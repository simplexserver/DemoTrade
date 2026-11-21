// LSE: liquidity sweeps. A sweep pierces a buy-side or sell-side liquidity level. It is a rejection when price
// closes back, and a continuation when price holds beyond it. Reads the current BSL and SSL messages. Pure.
import { atrOf, lastFinite, closeMs, newMsg, evidence, fmtPrice } from './common.js';

const r3 = (x) => Math.round(x * 1000) / 1000;

export function run(ctx) {
  const { candles, tf, cfg, board, asset } = ctx;
  if (!Array.isArray(candles) || !cfg || !board || candles.length < 5) return [];
  const n = candles.length;
  const A = lastFinite(atrOf(candles, cfg.atrPeriod));
  if (!(A > 0)) return [];
  const from = Math.max(1, n - cfg.lookback);
  const out = [];

  for (const [topic, buy] of [['liquidity.buy', true], ['liquidity.sell', false]]) {
    for (const m of board.query({ topic, asset, tf })) {
      const L = m.price;
      if (!Number.isFinite(L)) continue;
      if ((m.evidence ? m.evidence.rank : 0) < cfg.minLiquidityRank) continue;
      const age = m.measurements && Number.isFinite(m.measurements.ageBars) ? m.measurements.ageBars : n;
      const formed = Math.max(0, n - 1 - age);
      let armed = true;
      for (let k = formed + 1; k < n; k += 1) {
        const c = candles[k];
        const pierced = buy ? c.high > L + cfg.pierceAtr * A : c.low < L - cfg.pierceAtr * A;
        if (armed && pierced) {
          armed = false;
          if (k >= from) {
            // Closes considered: the sweep candle itself, then the next confirmBars candles.
            let rejectOffset = -1;
            const after = Math.min(cfg.confirmBars, n - 1 - k);
            for (let o = 0; o <= after; o += 1) {
              const close = candles[k + o].close;
              if (buy ? close < L : close > L) {
                rejectOffset = o;
                break;
              }
            }
            let outcome = 'pending';
            if (rejectOffset >= 0) outcome = 'rejection';
            else if (after >= cfg.confirmBars) outcome = 'continuation';
            const reclaimed = outcome === 'rejection' && rejectOffset <= cfg.reclaimBars;
            const extreme = buy ? c.high : c.low;
            const direction = outcome === 'pending' ? 'none' : (outcome === 'rejection') === buy ? 'down' : 'up';
            const rank = outcome === 'rejection' ? (reclaimed ? 80 : 70) : outcome === 'continuation' ? 40 : 50;
            const word = buy ? 'above' : 'below';
            out.push(newMsg({
              topic: 'sweeps',
              type: buy ? 'sweep_high' : 'sweep_low',
              direction,
              level: { lo: L, hi: L },
              price: L,
              atMs: closeMs(c, tf),
              measurements: {
                pierceAtr: r3(Math.abs(extreme - L) / A),
                outcome,
                reclaimed,
                liquidityRef: m.id,
                barsSince: n - 1 - k,
                sweepExtreme: extreme,
              },
              evidence: evidence(rank),
              invalidation: { text: `${buy ? 'Close above' : 'Close below'} ${fmtPrice(extreme)}`, price: extreme },
              summary: `Price swept the ${buy ? 'buy' : 'sell'}-side liquidity ${word} ${fmtPrice(L)} (${m.type.replace('_', ' ')}); outcome: ${outcome}${reclaimed ? ', reclaimed' : ''}.`,
            }));
          }
          continue;
        }
        if (!armed && (buy ? c.close < L : c.close > L)) armed = true;
      }
    }
  }
  return out;
}

export const ENGINE = { code: 'LSE', name: 'Liquidity sweep', stage: 2, prefix: 'lse', topics: ['sweeps'], run };
