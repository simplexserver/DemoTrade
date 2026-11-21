// Evaluation for the learning loop. Pure: no DOM, storage, network or clock.
// A record is { y (1 win, 0 loss), rMultiple, netUsd, ... }, oldest first. The test rows are never used to fit.
import { wilson } from '../core/util.js';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));

// Mean squared error of the probabilities. Lower is better. 0.25 is what always answering 0.5 scores.
export function brier(probs, y) {
  const n = Math.min(probs.length, y.length);
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i += 1) s += (probs[i] - (y[i] ? 1 : 0)) ** 2;
  return s / n;
}

export function logLoss(probs, y) {
  const n = Math.min(probs.length, y.length);
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const p = clip(probs[i]);
    s += y[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / n;
}

// Probability that a random win is scored above a random loss (ties count half). NaN with only one class.
export function aucRank(probs, y) {
  const n = Math.min(probs.length, y.length);
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => probs[a] - probs[b]);
  let pos = 0;
  let rankSum = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && probs[idx[j + 1]] === probs[idx[i]]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      if (y[idx[k]]) {
        pos += 1;
        rankSum += avg;
      }
    }
    i = j + 1;
  }
  const neg = n - pos;
  if (pos === 0 || neg === 0) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// Equal-width bins on [0, 1]. Each: how many, the mean predicted probability and the win rate actually seen.
export function calibrationTable(probs, y, bins = 10) {
  const k = Math.max(2, Math.floor(bins));
  const cells = Array.from({ length: k }, (_, i) => ({ lo: i / k, hi: (i + 1) / k, n: 0, sumP: 0, wins: 0 }));
  const n = Math.min(probs.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const c = cells[Math.min(k - 1, Math.max(0, Math.floor(probs[i] * k)))];
    c.n += 1;
    c.sumP += probs[i];
    if (y[i]) c.wins += 1;
  }
  return cells.map((c) => ({ lo: c.lo, hi: c.hi, n: c.n, meanP: c.n ? c.sumP / c.n : null, rate: c.n ? c.wins / c.n : null }));
}

// Weighted gap between what was predicted and what happened. 0 is perfectly calibrated.
export function calibrationError(table) {
  const total = table.reduce((a, c) => a + c.n, 0);
  if (!total) return NaN;
  return table.reduce((a, c) => a + (c.n && c.meanP !== null ? (c.n / total) * Math.abs(c.meanP - c.rate) : 0), 0);
}

// The win rate at which the average win and the average loss cancel, from the rows' own results.
// rows: [{ y, r }] where r is the result in R (or USD). Null until there is at least one of each.
export function breakEvenRate(rows) {
  const w = rows.filter((x) => x.y && isNum(x.r)).map((x) => x.r);
  const l = rows.filter((x) => !x.y && isNum(x.r)).map((x) => x.r);
  if (!w.length || !l.length) return null;
  const r1 = mean(w);
  const r0 = mean(l);
  if (r0 >= 0) return 0;
  if (r1 <= 0) return 1;
  return -r0 / (r1 - r0);
}

// Numbers for the rows that were taken (probability at or above the threshold, or an explicit mask) and for the
// model's scores over all rows. z is the Wilson confidence value.
export function metricsFor(records, probs, threshold = 0.5, { take = null, z = 1.96 } = {}) {
  const n = records.length;
  const mask = take || records.map((_, i) => isNum(probs[i]) && probs[i] >= threshold);
  const taken = records.filter((_, i) => mask[i]);
  const ys = records.map((r) => (r.y ? 1 : 0));
  const wins = taken.filter((r) => r.y).length;
  const w = wilson(wins, taken.length, z);
  const rs = taken.map((r) => r.rMultiple).filter(isNum);
  const gain = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const lossR = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  const usd = taken.map((r) => r.netUsd).filter(isNum);
  const probed = probs.length === n && probs.every(isNum);
  return {
    n,
    taken: taken.length,
    baseRate: n ? ys.reduce((a, b) => a + b, 0) / n : null,
    winRate: taken.length ? wins / taken.length : null,
    lo: taken.length ? w.lo : null,
    hi: taken.length ? w.hi : null,
    breakEven: breakEvenRate(taken.map((r) => ({ y: r.y, r: isNum(r.rMultiple) ? r.rMultiple : r.netUsd }))),
    expectancyR: rs.length ? mean(rs) : null,
    expectancyUsd: usd.length ? mean(usd) : null,
    expectancyRAll: records.map((r) => r.rMultiple).filter(isNum).length ? mean(records.map((r) => r.rMultiple).filter(isNum)) : null,
    profitFactor: lossR > 0 ? gain / lossR : (gain > 0 ? null : 0),
    maxDrawdownR: dd,
    brier: probed ? brier(probs, ys) : null,
    logLoss: probed ? logLoss(probs, ys) : null,
    auc: probed ? aucRank(probs, ys) : null,
  };
}

// Walk-forward test. The training window rolls along the records; the rows right after it (after a purge gap) are the
// test rows. fit(train, test) must return one output per test row. Test slices tile the records with no overlap.
// Returns { windows: [{ trainFrom, trainTo, testFrom, testTo, n }], rows: [{ index, record, out }] }.
export function walkForward(records, { window, step, purge = 0, fit }) {
  const n = records.length;
  const win = Math.max(1, Math.floor(window));
  const stp = Math.max(1, Math.floor(step));
  const gap = Math.max(0, Math.floor(purge));
  const windows = [];
  const rows = [];
  for (let t = win; t + gap < n; t += stp) {
    const trainFrom = Math.max(0, t - win);
    const testFrom = t + gap;
    const testTo = Math.min(n, testFrom + stp);
    const train = records.slice(trainFrom, t);
    const test = records.slice(testFrom, testTo);
    const outs = fit(train, test);
    if (!Array.isArray(outs) || outs.length !== test.length) throw new Error('walkForward: fit must return one output per test row.');
    for (let i = 0; i < test.length; i += 1) rows.push({ index: testFrom + i, record: test[i], out: outs[i] });
    windows.push({ trainFrom, trainTo: t, testFrom, testTo, n: test.length });
  }
  return { windows, rows };
}

// Oldest rows first, with the last `share` of them split off as a test set.
export function chronoSplit(records, share) {
  const cut = Math.max(0, Math.min(records.length, records.length - Math.round(records.length * share)));
  return { train: records.slice(0, cut), test: records.slice(cut) };
}
