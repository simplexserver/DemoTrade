// The opportunity scanner: causal features, honest outcomes, multiple-testing control, and the two controls that matter:
// a planted pattern must be found, and a market with no pattern must produce nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures, outcomes, summaryOf, bhQ, scan, autoDepth, ruleSignals, ruleMatchesLast, describeRule, WARMUP, FEATURES } from '../js/learning/scanner.js';
import { mulberry32 } from '../js/core/hash.js';
import { simCandles } from './helpers/sim.mjs';

function gauss(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}
// A random walk with an optional drift that depends on the bar (for planting a pattern).
function walk({ n, seed, tf = 300, sigma = 0.0004, drift = () => 0 }) {
  const rnd = mulberry32(seed);
  let price = 1000;
  const t0 = Math.floor(Date.parse('2026-01-05T00:00:00Z') / 1000);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const epoch = t0 + i * tf;
    const o = price;
    const c = o * (1 + sigma * gauss(rnd) + drift(epoch, i) * sigma);
    const h = Math.max(o, c) + o * sigma * 0.5 * rnd();
    const l = Math.min(o, c) - o * sigma * 0.5 * rnd();
    out.push({ epoch, open: o, high: h, low: l, close: c });
    price = c;
  }
  return out;
}
const hourOf = (epoch, tf) => new Date((epoch + tf) * 1000).getUTCHours();

test('bhQ: known values', () => {
  const q = bhQ([0.01, 0.04, 0.03, 0.005]);
  assert.deepEqual(q.map((x) => Math.round(x * 1000) / 1000), [0.02, 0.04, 0.04, 0.02]);
  assert.deepEqual(bhQ([]), []);
  assert.ok(bhQ([0.5, 0.9]).every((x) => x <= 1));
});

test('summaryOf: mean, spread and one-sided p', () => {
  const s = summaryOf([1, 2, 3, 4, 5]);
  assert.equal(s.n, 5);
  assert.equal(s.mean, 3);
  assert.ok(Math.abs(s.sd - Math.sqrt(2.5)) < 1e-12);
  assert.ok(s.p < 0.05 && s.p > 0);
  assert.equal(summaryOf([]).mean, null);
  assert.equal(summaryOf([7]).p, null);
  const flat = summaryOf([-1, 1, -1, 1, -1, 1]);
  assert.ok(flat.p > 0.4, 'a mean of zero is no evidence');
});

test('features use only the past: cutting or changing the future changes nothing', () => {
  const c = simCandles(900, 5, { kind: 'regimes' });
  const full = computeFeatures(c, { tf: 60 });
  const cut = computeFeatures(c.slice(0, 700), { tf: 60 });
  const changed = computeFeatures(c.slice(0, 700).concat(simCandles(200, 99, { kind: 'regimes' }).map((x, i) => ({ ...x, epoch: c[700 + i].epoch }))), { tf: 60 });
  for (const feat of FEATURES) {
    for (let i = 0; i < 700; i += 1) {
      assert.equal(cut.f[feat.id][i], full.f[feat.id][i], `${feat.id} at ${i} (cut)`);
      assert.equal(changed.f[feat.id][i], full.f[feat.id][i], `${feat.id} at ${i} (changed)`);
    }
  }
  assert.ok(full.f.trend.some((v) => v === 0) && full.f.trend.some((v) => v === 2), 'levels vary');
  assert.equal(full.f.rsi[10], -1, 'nothing is used before the warm-up');
});

function flat(n, price = 100) {
  return Array.from({ length: n }, (_, i) => ({ epoch: i * 60, open: price, high: price + 0.1, low: price - 0.1, close: price }));
}

test('outcomes: target, stop, same-candle tie, gap and time-out, with costs', () => {
  const c = flat(WARMUP + 40);
  const at = WARMUP; // the signal bar; the trade opens at the open of at + 1
  const A = new Float64Array(c.length).fill(1);
  const opts = { stopAtr: 1.5, rr: 2, horizon: 10, costPrice: 0.3 };
  const D = 1.5;
  // Target first: the buy reaches 103 on the second bar.
  let k = c.map((x) => ({ ...x }));
  k[at + 2] = { ...k[at + 2], high: 103.2, low: 99.9 };
  let o = outcomes(k, A, opts);
  assert.ok(Math.abs(o.buy[at] - (2 - 0.3 / D)) < 1e-9, `buy target ${o.buy[at]}`);
  assert.equal(o.buyExit[at], at + 2);
  // Stop and target in the same candle count as the stop.
  k = c.map((x) => ({ ...x }));
  k[at + 2] = { ...k[at + 2], high: 103.2, low: 98.4 };
  o = outcomes(k, A, opts);
  assert.ok(Math.abs(o.buy[at] - (-1 - 0.3 / D)) < 1e-9, 'a tie is a loss');
  // A gap down through the stop fills at the open, which is worse than -1.
  k = c.map((x) => ({ ...x }));
  k[at + 3] = { epoch: k[at + 3].epoch, open: 97, high: 97.2, low: 96.8, close: 97 };
  o = outcomes(k, A, opts);
  assert.ok(Math.abs(o.buy[at] - (-3 / D - 0.3 / D)) < 1e-9, `gap ${o.buy[at]}`);
  // The sell side of the same path: the gap down is a win.
  assert.ok(o.sell[at] > 1.5, `sell gap ${o.sell[at]}`);
  // Nothing happens: the trade ends at the horizon close and loses only the cost.
  o = outcomes(c, A, opts);
  assert.ok(Math.abs(o.buy[at] - (0 - 0.3 / D)) < 1e-9);
  assert.equal(o.buyExit[at], at + 10);
});

test('autoDepth grows with the amount of history', () => {
  assert.equal(autoDepth(1000), 1);
  assert.equal(autoDepth(10000), 2);
  assert.equal(autoDepth(100000), 3);
});

test('a planted pattern is found, validated and confirmed on untouched data', async () => {
  const tf = 300;
  const c = walk({ n: 30000, seed: 11, tf, drift: (epoch) => { const h = hourOf(epoch, tf); return h >= 8 && h < 12 ? 0.35 : 0; } });
  const r = await scan(c, { tf, costPrice: 0.05, depth: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.tested > 20);
  assert.ok(r.survivors.length >= 1, r.verdict.text);
  const top = r.survivors.find((s) => s.rule.side === 'buy' && s.rule.conds.length === 1 && s.rule.conds[0].feature === 'hour' && s.rule.conds[0].level === 2);
  assert.ok(top, `the 08-11 buy was found among: ${r.survivors.map((s) => s.text).join(' | ')}`);
  assert.ok(top.test.lo > 0 && top.test.mean > 0.1);
  assert.equal(r.verdict.level, 'shown');
  assert.match(describeRule(top.rule), /^Buy when hour of day \(utc\) is 08-11$/);
});

test('a market with no pattern produces no survivors (false alarms stay rare)', async () => {
  let survivors = 0;
  let candidates = 0;
  for (let seed = 1; seed <= 8; seed += 1) {
    const c = simCandles(9000, seed * 31, { kind: 'random_walk' });
    const r = await scan(c, { tf: 60, costPrice: 0.02, depth: 2 });
    assert.equal(r.ok, true);
    survivors += r.survivors.length;
    candidates += r.candidates;
    if (r.survivors.length === 0) assert.equal(r.verdict.level, 'none');
  }
  assert.ok(survivors <= 1, `${survivors} survivors on random walks (${candidates} candidates passed training)`);
});

test('costs matter: a small planted edge disappears when costs are large', async () => {
  const tf = 300;
  const c = walk({ n: 30000, seed: 11, tf, drift: (epoch) => { const h = hourOf(epoch, tf); return h >= 8 && h < 12 ? 0.35 : 0; } });
  const cheap = await scan(c, { tf, costPrice: 0.05, depth: 1 });
  const dear = await scan(c, { tf, costPrice: 3, depth: 1 });
  assert.ok(dear.survivors.length < cheap.survivors.length || dear.survivors.every((s) => s.test.mean < cheap.survivors[0].test.mean));
  const t1 = cheap.survivors[0].test.mean;
  const t2 = (dear.survivors[0] || { test: { mean: -1 } }).test.mean;
  assert.ok(t2 < t1);
});

test('the scan is repeatable and can be cancelled', async () => {
  const c = simCandles(5000, 3, { kind: 'regimes' });
  const a = await scan(c, { tf: 60, costPrice: 0.02, depth: 1 });
  const b = await scan(c, { tf: 60, costPrice: 0.02, depth: 1 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const x = await scan(c, { tf: 60, costPrice: 0.02, depth: 1, signal: { aborted: true } });
  assert.equal(x.ok, false);
  assert.equal(x.code, 'cancelled');
  const few = await scan(c.slice(0, 300), {});
  assert.equal(few.ok, false);
  assert.equal(few.code, 'too_few_candles');
});

test('a rule gives the same bars as its description and valid signals', () => {
  const tf = 300;
  const c = walk({ n: 2000, seed: 4, tf });
  const rule = { side: 'buy', conds: [{ feature: 'hour', level: 2 }], stopAtr: 1.5, rr: 2, horizon: 24 };
  const sigs = ruleSignals(rule, c, { tf });
  assert.ok(sigs.length > 50);
  for (const s of sigs) {
    assert.equal(hourOf(c[s.index].epoch, tf) >= 8 && hourOf(c[s.index].epoch, tf) < 12, true);
    assert.ok(s.stop < s.entry && s.entry < s.target, 'a buy has its stop below and its target above');
    assert.ok(Math.abs((s.target - s.entry) / (s.entry - s.stop) - 2) < 1e-9);
  }
  const last = sigs[sigs.length - 1];
  assert.equal(ruleMatchesLast(rule, c.slice(0, last.index + 1), tf), true);
  assert.equal(ruleMatchesLast(rule, c.slice(0, last.index + 1).slice(0, -1).concat([{ ...c[last.index], epoch: c[last.index].epoch + 3600 * 6 }]), tf), false, 'the same candle six hours later is a different hour');
});
