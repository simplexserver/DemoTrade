// Backtest and edge gate. Pure: candles and signals in, statistics out. No DOM, no network.
// An outcome compares the close `horizon` candles ahead with the signal candle's close.
// A signal wins only when the outcome has the same direction. A flat outcome (tie) loses.

import { fmtPct, toNumber, wilson } from '../core/util.js';

// Outcome per candle: 'up' | 'down' | 'flat', or null for the last `horizon` candles (no future close yet).
export function outcomes(candles, horizon = 1) {
  const n = candles.length;
  const h = Math.max(1, Math.floor(Number(horizon)) || 1);
  const out = new Array(n).fill(null);
  for (let i = 0; i + h < n; i++) {
    const now = candles[i].close;
    const later = candles[i + h].close;
    out[i] = later > now ? 'up' : later < now ? 'down' : 'flat';
  }
  return out;
}

// Pass only when n >= minSamples AND the Wilson lower bound is above break-even.
export function edgeGate({ wins, n, breakEven, minSamples = 100, z = 1.96 }) {
  if (!(n >= minSamples)) return { pass: false, reason: `n=${n} below ${minSamples} samples` };
  if (!(n > 0)) return { pass: false, reason: 'no signals with a known outcome yet' };
  if (!(breakEven > 0 && breakEven < 1)) {
    return { pass: false, reason: `break-even ${fmtPct(breakEven * 100)} is not a usable probability` };
  }
  const { lo } = wilson(wins, n, z);
  const loText = fmtPct(lo * 100);
  const beText = fmtPct(breakEven * 100);
  if (lo > breakEven) return { pass: true, reason: `lower bound ${loText} > break-even ${beText} (n=${n})` };
  return { pass: false, reason: `lower bound ${loText} <= break-even ${beText}` };
}

// Break-even win rate of a binary contract: ask price / payout. 0.5 when the quote is missing.
export function breakEvenFromQuote({ askPrice, payout } = {}) {
  const ask = toNumber(askPrice);
  const pay = toNumber(payout);
  if (!(ask > 0) || !(pay > 0)) return 0.5;
  return ask / pay;
}

// Win rate of a signal series at a horizon, with a Wilson interval and the edge gate.
// Only signals with a known outcome are counted. edge = winRate - breakEven.
// expectancy = winRate / breakEven - 1, the expected return per unit stake for a contract that pays at breakEven.
export function evaluateSignals(candles, signals, { horizon = 1, breakEven = 0.5, minSamples = 100, z = 1.96 } = {}) {
  const outs = outcomes(candles, horizon);
  let n = 0;
  let wins = 0;
  for (let i = 0; i < outs.length; i++) {
    const dir = signals[i];
    const out = outs[i];
    if ((dir !== 'up' && dir !== 'down') || out === null) continue;
    n += 1;
    if (dir === out) wins += 1;
  }
  const winRate = n > 0 ? wins / n : NaN;
  const ci = wilson(wins, n, z);
  const gate = edgeGate({ wins, n, breakEven, minSamples, z });
  return {
    n,
    wins,
    winRate,
    lo: ci.lo,
    hi: ci.hi,
    breakEven,
    edge: n > 0 ? winRate - breakEven : NaN,
    expectancy: n > 0 && breakEven > 0 ? winRate / breakEven - 1 : NaN,
    pass: gate.pass,
    reason: gate.reason,
  };
}
