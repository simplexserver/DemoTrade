// PM: the performance monitor. Pure: takes closed paper trades and returns summaries. No DOM, storage, network or clock.
// Rates are fractions (0 to 1). Money is plain numbers in USD; the screens format it with the util formatters.
// Break-even is measured after costs: the win rate at which the average net win and the average net loss cancel.
// A trade record: { id, asset, tf, side, engine, strategy, familySig, volClass, netUsd, grossUsd, costUsd, rMultiple,
//                   result, exitReason, exitMs, openBars, stake }.
import { wilson } from '../core/util.js';
import { utcDayKey } from './daily.js';

const CLOSED = new Set(['win', 'loss', 'breakeven']);
const n0 = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const netOf = (t) => n0(t.netUsd);
const timeOf = (t) => n0(t.exitMs, n0(t.entryMs, 0));

// Closed trades only, oldest first by exit time (stable for equal times).
export function closedSorted(trades) {
  return (Array.isArray(trades) ? trades : [])
    .filter((t) => t && CLOSED.has(t.result))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => timeOf(a.t) - timeOf(b.t) || a.i - b.i)
    .map((x) => x.t);
}

// Cumulative result from zero and the largest peak-to-trough fall (abs in USD, pct of the starting balance plus peak).
export function drawdownAndCurve(closed, startBalance = 0) {
  let equity = 0;
  let peak = 0;
  let abs = 0;
  let pct = 0;
  const curve = [];
  for (const t of closed) {
    equity += netOf(t);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > abs) abs = dd;
    const base = n0(startBalance) + peak;
    if (base > 0 && dd / base > pct) pct = dd / base;
    curve.push({ t: timeOf(t), equity });
  }
  return { abs, pct, curve };
}

// Longest run of wins and of losses. A break-even trade ends both runs. Also the current run.
export function streaks(closed) {
  let bestWin = 0;
  let worstLoss = 0;
  let win = 0;
  let loss = 0;
  for (const t of closed) {
    if (t.result === 'win') { win += 1; loss = 0; } else if (t.result === 'loss') { loss += 1; win = 0; } else { win = 0; loss = 0; }
    if (win > bestWin) bestWin = win;
    if (loss > worstLoss) worstLoss = loss;
  }
  return { bestWin, worstLoss, currentWin: win, currentLoss: loss };
}

// Measures for one group of trades. z is the Wilson confidence value (1.96 = 95%).
export function metricsOf(trades, { z = 1.96, startBalance = 0 } = {}) {
  const closed = closedSorted(trades);
  const wins = closed.filter((t) => t.result === 'win');
  const losses = closed.filter((t) => t.result === 'loss');
  const flat = closed.filter((t) => t.result === 'breakeven');
  const n = closed.length;
  const grossWin = sum(wins.map(netOf));
  const grossLoss = Math.abs(sum(losses.map(netOf)));
  const net = sum(closed.map(netOf));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? -grossLoss / losses.length : null;
  const w = wilson(wins.length, n, z);
  // Break-even win rate from the measured averages. Unknown until there is at least one win and one loss.
  const breakEven = avgWin !== null && avgLoss !== null && avgWin + Math.abs(avgLoss) > 0 ? Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss)) : null;
  const dd = drawdownAndCurve(closed, startBalance);
  const rs = closed.map((t) => t.rMultiple).filter(Number.isFinite);
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    breakeven: flat.length,
    winRate: n ? wins.length / n : null,
    winRateLo: n ? w.lo : null,
    winRateHi: n ? w.hi : null,
    breakEvenWinRate: breakEven,
    // True only when even the pessimistic end of the win-rate range beats break-even after costs.
    edgeProven: n > 0 && breakEven !== null && w.lo > breakEven,
    netUsd: net,
    grossWinUsd: grossWin,
    grossLossUsd: grossLoss,
    avgWinUsd: avgWin,
    avgLossUsd: avgLoss,
    expectancyUsd: n ? net / n : null,
    expectancyR: rs.length ? mean(rs) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0),
    costUsd: sum(closed.map((t) => n0(t.costUsd))),
    avgHoldBars: closed.length ? mean(closed.map((t) => n0(t.openBars))) : null,
    maxDrawdownUsd: dd.abs,
    maxDrawdownPct: dd.pct,
    ...streaks(closed),
  };
}

function groupBy(trades, keyOf, opts) {
  const groups = new Map();
  for (const t of closedSorted(trades)) {
    const key = String(keyOf(t) ?? 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = {};
  for (const [k, v] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) out[k] = metricsOf(v, opts);
  return out;
}

// Share of trading days with a positive result, plus the best and worst day.
export function consistencyOf(closed, resetHour = 0) {
  const days = new Map();
  for (const t of closed) {
    const key = utcDayKey(timeOf(t) || 0, resetHour);
    days.set(key, (days.get(key) || 0) + netOf(t));
  }
  const list = [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, netUsd]) => ({ day, netUsd }));
  const nums = list.map((d) => d.netUsd);
  return {
    days: list.length,
    positiveDays: nums.filter((x) => x > 0).length,
    share: nums.length ? nums.filter((x) => x > 0).length / nums.length : null,
    best: nums.length ? Math.max(...nums) : null,
    worst: nums.length ? Math.min(...nums) : null,
    daily: list,
  };
}

// Counts of why entries were refused. Takes verdicts ({ ok, reasons: [{ code }] }) or a { code: count } object.
function rejectedSummary(rejected) {
  const counts = new Map();
  let total = 0;
  if (Array.isArray(rejected)) {
    for (const v of rejected) {
      if (!v || v.ok) continue;
      total += 1;
      for (const r of Array.isArray(v.reasons) ? v.reasons : []) counts.set(r.code, (counts.get(r.code) || 0) + 1);
    }
  } else if (rejected && typeof rejected === 'object') {
    for (const [code, c] of Object.entries(rejected)) {
      const k = n0(c);
      counts.set(code, k);
      total += k;
    }
  }
  return { total, byReason: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => ({ code, count })) };
}

function executionSummary(execution) {
  const e = execution && typeof execution === 'object' ? execution : {};
  const placed = n0(e.placed);
  const filled = n0(e.filled);
  return {
    placed,
    filled,
    cancelled: n0(e.cancelled),
    expired: n0(e.expired),
    invalidated: n0(e.invalidated),
    fillRate: placed > 0 ? filled / placed : null,
  };
}

// The full report for the Performance screen and for the learning loop.
export function performanceReport(trades, { z = 1.96, rejected = null, expired = 0, execution = null, startBalance = 0, resetHour = 0 } = {}) {
  const closed = closedSorted(trades);
  const opts = { z, startBalance };
  const overall = metricsOf(closed, opts);
  const dd = drawdownAndCurve(closed, startBalance);
  const edge = overall.n === 0 ? { text: 'No closed trades yet, so there is nothing to measure.' }
    : overall.breakEvenWinRate === null ? { text: `After ${overall.n} closed trades there is not yet both a win and a loss, so break-even cannot be measured.` }
      : {
        text: overall.edgeProven
          ? `After ${overall.n} closed trades the lower end of the win rate (${Math.round(overall.winRateLo * 1000) / 10}%) is above break-even (${Math.round(overall.breakEvenWinRate * 1000) / 10}%).`
          : `After ${overall.n} closed trades the lower end of the win rate (${Math.round(overall.winRateLo * 1000) / 10}%) does not clear break-even (${Math.round(overall.breakEvenWinRate * 1000) / 10}%). No edge is shown yet.`,
      };
  return {
    overall,
    edge,
    byEngine: groupBy(closed, (t) => t.engine || (t.side === 'sell' ? 'SLE' : 'BLE'), opts),
    byStrategy: groupBy(closed, (t) => t.strategy || 'engines', opts),
    byAsset: groupBy(closed, (t) => t.asset, opts),
    byTf: groupBy(closed, (t) => t.tf, opts),
    bySide: groupBy(closed, (t) => t.side, opts),
    byExit: groupBy(closed, (t) => t.exitReason, opts),
    byCondition: groupBy(closed, (t) => t.familySig || 'none', opts),
    byVolatility: groupBy(closed, (t) => t.volClass || 'unknown', opts),
    consistency: consistencyOf(closed, resetHour),
    drawdown: { abs: dd.abs, pct: dd.pct, curve: dd.curve },
    streaks: streaks(closed),
    rejected: rejectedSummary(rejected),
    expired: n0(expired),
    execution: executionSummary(execution),
  };
}

// Convenience for callers that only want the grouped numbers for a list of trades.
export const summarize = (trades, opts) => ({ overall: metricsOf(trades, opts), byAsset: groupBy(trades, (t) => t.asset, opts) });
