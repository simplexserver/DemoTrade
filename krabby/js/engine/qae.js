// QAE: quantitative analysis. A small pure maths library used across the app, and the measures step that attaches
// stop size, reward to risk and volatility class to each entry proposal. Pure.
import { atrOf, lastFinite, newMsg, evidence } from './common.js';
import { cfgFor } from '../core/schema.js';

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

// Share of values at or below x, as 0 to 100.
export function percentile(values, x) {
  const v = values.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(x)) return NaN;
  let c = 0;
  for (const a of v) if (a <= x) c += 1;
  return (c / v.length) * 100;
}

export function volClassOf(atrNow, atrHistory, lowPct, highPct) {
  const p = percentile(atrHistory, atrNow);
  if (!Number.isFinite(p)) return null;
  return p < lowPct ? 'low' : p > highPct ? 'high' : 'normal';
}

export function stopMath({ entry, stop, side }) {
  return { riskPrice: Math.abs(entry - stop), dir: side === 'sell' ? -1 : 1 };
}

export function rewardToRisk(entry, target, stop) {
  const risk = Math.abs(entry - stop);
  return risk > 0 ? Math.abs(target - entry) / risk : NaN;
}

// Win rate at which average win and average loss break even. 0.5 when undefined.
export function breakEvenWinRate(avgWin, avgLoss) {
  const w = Math.abs(avgWin);
  const l = Math.abs(avgLoss);
  return Number.isFinite(w) && Number.isFinite(l) && w + l > 0 ? l / (w + l) : 0.5;
}

export function expectancy(list) {
  const v = list.filter(Number.isFinite);
  return v.length ? sum(v) / v.length : 0;
}

export function profitFactor(wins, losses) {
  const w = sum(wins.map(Math.abs));
  const l = sum(losses.map(Math.abs));
  return l > 0 ? w / l : (w > 0 ? Infinity : 0);
}

// Largest peak-to-trough fall of an equity series: { abs, pct } (pct as a fraction of the peak).
export function maxDrawdown(equity) {
  let peak = -Infinity;
  let abs = 0;
  let pct = 0;
  for (const e of equity) {
    if (!Number.isFinite(e)) continue;
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > abs) abs = dd;
    if (peak > 0 && dd / peak > pct) pct = dd / peak;
  }
  return { abs, pct };
}

// Share of days with a positive result.
export function consistency(dailyPnls) {
  const v = dailyPnls.filter(Number.isFinite);
  return v.length ? v.filter((x) => x > 0).length / v.length : 0;
}

export function run(ctx) {
  const { candles, tf, cfg, board, asset, nowMs, settings } = ctx;
  if (!Array.isArray(candles) || candles.length < 5 || !cfg || !board) return [];
  const atr = atrOf(candles, cfg.atrPeriod);
  const A = lastFinite(atr);
  if (!(A > 0)) return [];
  const hist = atr.slice(-cfg.volLookback).filter(Number.isFinite);
  const atrPct = percentile(hist, A);
  const volClass = volClassOf(A, hist, cfg.lowVolPct, cfg.highVolPct);
  const out = [];
  for (const topic of ['entries.buy', 'entries.sell']) {
    const ec = cfgFor(topic === 'entries.buy' ? 'ble' : 'sle', settings);
    for (const m of board.query({ topic, asset, tf, validOnly: true })) {
      if (m.atMs !== nowMs || !m.plan) continue;
      const p = m.plan;
      const stopDistance = Math.abs(p.entry - p.stop);
      const stopAtr = stopDistance / A;
      const rr = rewardToRisk(p.entry, p.target, p.stop);
      const rank = (rr >= ec.minRR ? 40 : 10) + (volClass === 'normal' ? 30 : volClass === 'high' ? 15 : 10)
        + 30 * (1 - Math.max(0, Math.min(1, stopAtr / ec.maxStopAtr)));
      out.push(newMsg({
        topic: 'measures',
        type: 'plan_measures',
        direction: 'none',
        price: p.entry,
        atMs: nowMs,
        measurements: {
          planId: m.id, stopDistance, stopAtr: r3(stopAtr), rr: r3(rr), atrPct: r3(atrPct), volClass,
        },
        evidence: evidence(rank),
        summary: `Stop is ${stopAtr.toFixed(2)} ATR away, reward to risk ${Number.isFinite(rr) ? rr.toFixed(2) : 'n/a'}, volatility ${volClass || 'unknown'}.`,
      }));
    }
  }
  return out;
}

export const ENGINE = { code: 'QAE', name: 'Quantitative analysis', stage: 2, prefix: 'qae', topics: ['measures'], run };
