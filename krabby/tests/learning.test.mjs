import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, LEARNABLE_KEYS } from '../js/core/schema.js';
import { mulberry32 } from '../js/core/hash.js';
import { AuditLog } from '../js/engine/board.js';
import { buildFeatures, featureNames } from '../js/learning/features.js';
import { fitLogistic, predictLogistic, fitBuckets, predictBuckets, fitModel, predictBlend, serialize, deserialize, featureImportance } from '../js/learning/model.js';
import { brier, logLoss, aucRank, calibrationTable, breakEvenRate, metricsFor, walkForward, chronoSplit } from '../js/learning/eval.js';
import { replayPlan } from '../js/learning/shadow.js';
import { gateChecks, approve as gateApprove, approvalPhrase, MIN_CLOSED_FLOOR } from '../js/learning/gate.js';
import { LearningLoop, familySigOf, FILTER_SPECS } from '../js/learning/loop.js';
import { cfgFor } from '../js/core/schema.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not close to ${b}`);
const T0 = 1_700_000_000_000;

// A synthetic set of cases. In 'edge' mode the win chance rises with evidence, a sweep and a higher-timeframe
// agreement. In 'noise' mode it is 30% for every case and a win pays 1.95 R against a 1.05 R loss (a losing system).
function makeCase(rnd, i, mode) {
  const fam = { levels: rnd() < 0.7, structure: rnd() < 0.6, liquidity: rnd() < 0.5, zones: rnd() < 0.7 };
  const snap = {
    side: rnd() < 0.5 ? 'buy' : 'sell', families: fam, agreeCount: Object.values(fam).filter(Boolean).length,
    evidenceRank: 30 + Math.round(rnd() * 65), sweepSeen: rnd() < 0.5, fvgObOk: rnd() < 0.5, structureOk: rnd() < 0.6,
    volClass: ['low', 'normal', 'high'][Math.floor(rnd() * 3)], atrPct: Math.round(rnd() * 100), hourUtc: Math.floor(rnd() * 24),
    rr: 2, stopAtr: 0.5 + rnd() * 2.5, zoneDepth: rnd(), htfAgrees: rnd() < 0.5, breakoutPresent: rnd() < 0.3, recentStreak: 0,
  };
  const p = mode === 'edge' ? sigmoid(-1.4 + 0.06 * (snap.evidenceRank - 60) + 1.2 * (snap.sweepSeen ? 1 : 0) + 0.6 * (snap.htfAgrees ? 1 : 0)) : 0.3;
  const win = rnd() < p;
  return { snap, win, R: win ? 1.95 : -1.05, caseId: `C${i}`, nowMs: T0 + i * 60000 };
}

function makeLoop(n, seed, mode, settingsOver = {}, hooks = {}) {
  const settings = normalise(settingsOver);
  const audit = new AuditLog();
  const applied = [];
  const loop = new LearningLoop({
    getSettings: () => settings, audit,
    applySettings: hooks.applySettings || ((changes) => { applied.push(changes); return { ok: true }; }),
    nowFn: () => T0 + 10_000_000_000,
  });
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i += 1) {
    const c = makeCase(rnd, i, mode);
    loop.recordCase(c.snap, { caseId: c.caseId, asset: 'R_100', tf: 60, side: c.snap.side, nowMs: c.nowMs, plan: { side: c.snap.side, entry: 100, stop: 99, target: 102, rr: 2 }, placed: true });
    loop.recordOutcome(c.caseId, { netUsd: c.R * 0.05, rMultiple: c.R, exitMs: c.nowMs + 30000, trailingArmed: c.win });
  }
  return { loop, settings, audit, applied };
}

function dataset(n, seed, mode) {
  const rnd = mulberry32(seed);
  const cfg = cfgFor('ll', normalise({}));
  const X = [];
  const y = [];
  for (let i = 0; i < n; i += 1) {
    const c = makeCase(rnd, i, mode);
    X.push(buildFeatures(c.snap, cfg).values);
    y.push(c.win ? 1 : 0);
  }
  return { X, y, cfg, names: featureNames(cfg) };
}

const LL = cfgFor('ll', normalise({}));

// ---------------------------------------------------------------- features

test('features: names match values, every family can be switched off, a missing value becomes 0 and is counted', () => {
  const full = buildFeatures({ families: { levels: true, structure: false, liquidity: true, zones: true }, agreeCount: 3, evidenceRank: 70, hourUtc: 6 }, LL);
  assert.equal(full.names.length, full.values.length);
  assert.ok(full.missing > 0);
  assert.ok(full.values.every(Number.isFinite));
  const off = { ...LL, feat: Object.fromEntries(Object.keys(LL.feat).map((k) => [k, false])) };
  assert.deepEqual(buildFeatures({ evidenceRank: 50 }, off).names, []);
  const some = { ...LL, feat: { ...off.feat, evidence: true, time: true } };
  assert.deepEqual(featureNames(some), ['evidence_rank', 'hour_sin', 'hour_cos']);
  assert.deepEqual(buildFeatures({}, LL).names, featureNames(LL));
});

// ---------------------------------------------------------------- models

test('logistic: learns a real signal, scores held-out data above chance, and is repeatable', () => {
  const a = dataset(600, 1, 'edge');
  const train = { X: a.X.slice(0, 450), y: a.y.slice(0, 450) };
  const test = { X: a.X.slice(450), y: a.y.slice(450) };
  const m1 = fitLogistic(train.X, train.y, a.cfg);
  const m2 = fitLogistic(train.X, train.y, a.cfg);
  assert.deepEqual(m1, m2, 'same data and seed, same model');
  assert.equal(m1.degenerate, false);
  const probs = test.X.map((x) => predictLogistic(m1, x));
  assert.ok(probs.every((p) => p > 0 && p < 1));
  assert.ok(aucRank(probs, test.y) > 0.68, `auc ${aucRank(probs, test.y)}`);
  assert.ok(brier(probs, test.y) < brier(probs.map(() => train.y.reduce((s, v) => s + v, 0) / train.y.length), test.y));
  const other = fitLogistic(train.X, train.y, { ...a.cfg, seed: 7 });
  assert.notDeepEqual(other.w, m1.w, 'a different seed shuffles differently');
  assert.ok(m1.epochs >= 1 && m1.epochs <= a.cfg.epochs);
});

test('logistic: thin data or one class gives a base-rate model instead of an error', () => {
  const one = fitLogistic([[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 1], [1, 1], [2, 2]], new Array(11).fill(1), LL);
  assert.equal(one.degenerate, true);
  assert.ok(predictLogistic(one, [3, 3]) > 0.99);
  const tiny = fitLogistic([[1], [2]], [0, 1], LL);
  assert.equal(tiny.degenerate, true);
  approx(predictLogistic(tiny, [5]), 0.5, 1e-6);
  const none = fitLogistic([], [], LL);
  assert.equal(none.degenerate, true);
});

test('logistic: a missing feature value is treated as the average, never as NaN', () => {
  const a = dataset(300, 2, 'edge');
  const m = fitLogistic(a.X, a.y, a.cfg);
  const x = a.X[0].slice();
  x[2] = NaN;
  x[5] = undefined;
  const p = predictLogistic(m, x);
  assert.ok(Number.isFinite(p) && p > 0 && p < 1);
});

test('logistic: balanced class weights pull predictions toward the minority class, and every scaler works', () => {
  const rnd = mulberry32(5);
  const X = [];
  const y = [];
  for (let i = 0; i < 400; i += 1) {
    const x = rnd();
    X.push([x, rnd()]);
    y.push(rnd() < 0.1 + 0.15 * x ? 1 : 0);
  }
  const plainFit = fitLogistic(X, y, { ...LL, classWeight: 'none', patience: 0 });
  const balanced = fitLogistic(X, y, { ...LL, classWeight: 'balanced', patience: 0 });
  const meanP = (m) => X.reduce((s, x) => s + predictLogistic(m, x), 0) / X.length;
  assert.ok(meanP(balanced) > meanP(plainFit) + 0.1, `${meanP(balanced)} vs ${meanP(plainFit)}`);
  for (const standardize of ['zscore', 'minmax', 'none']) {
    const m = fitLogistic(X, y, { ...LL, standardize });
    assert.equal(m.standardize, standardize);
    assert.ok(Number.isFinite(predictLogistic(m, [0.5, 0.5])));
  }
});

test('logistic: age decay changes the fit, and the old rows weigh less', () => {
  const rnd = mulberry32(9);
  const X = [];
  const y = [];
  for (let i = 0; i < 300; i += 1) {
    const x = rnd();
    X.push([x]);
    // the relationship flips halfway: old rows say high x wins, new rows say low x wins
    y.push((i < 150 ? rnd() < x : rnd() < 1 - x) ? 1 : 0);
  }
  const flat = fitLogistic(X, y, { ...LL, decayHalfLife: 0, patience: 0, classWeight: 'none' });
  const decay = fitLogistic(X, y, { ...LL, decayHalfLife: 40, patience: 0, classWeight: 'none' });
  assert.ok(decay.w[0] < flat.w[0], 'with decay the slope follows the newer rows');
});

test('buckets: bins with rates and Wilson bounds, and predictions that follow the data', () => {
  const rnd = mulberry32(3);
  const X = [];
  const y = [];
  for (let i = 0; i < 500; i += 1) {
    const a = rnd();
    const b = rnd() < 0.5 ? 1 : 0;
    X.push([a, b, 0.5]);
    y.push(rnd() < 0.15 + 0.6 * a * (b ? 1 : 0.4) ? 1 : 0);
  }
  const m = fitBuckets(X, y, { ...LL, bins: 5 }, ['a', 'b', 'c']);
  assert.equal(m.features.length, 3);
  assert.equal(m.features[0].cells.length, 5);
  assert.equal(m.features[1].cells.length, 2, 'a yes/no feature gets two bins');
  assert.equal(m.features[2].cells.length, 1, 'a constant feature gets one and adds nothing');
  for (const f of m.features) for (const c of f.cells) {
    assert.ok(c.rate >= 0 && c.rate <= 1);
    if (c.n) assert.ok(c.lo <= c.rate + 1e-9 || c.n < 20) && assert.ok(c.hi >= c.lo);
  }
  assert.ok(predictBuckets(m, [0.95, 1, 0.5]) > predictBuckets(m, [0.05, 0, 0.5]) + 0.2);
  assert.equal(m.features[0].cells.reduce((s, c) => s + c.n, 0), 500);
  const strong = fitBuckets(X, y, { ...LL, bins: 5, priorStrength: 0 });
  const weak = fitBuckets(X, y, { ...LL, bins: 5, priorStrength: 200 });
  const spread = (mm) => predictBuckets(mm, [0.95, 1, 0.5]) - predictBuckets(mm, [0.05, 0, 0.5]);
  assert.ok(spread(weak) < spread(strong), 'a strong prior shrinks the estimates toward the base rate');
});

test('model bundle: kinds, blend weights, importance order, and a save and load that round-trips', () => {
  const a = dataset(500, 4, 'edge');
  for (const kind of ['logistic', 'bucket', 'blend']) {
    const b = fitModel(a.X, a.y, { ...a.cfg, model: kind }, a.names);
    assert.equal(b.kind, kind);
    assert.equal(Boolean(b.logistic), kind !== 'bucket');
    assert.equal(Boolean(b.bucket), kind !== 'logistic');
    const p = predictBlend(b, a.X[0]);
    assert.ok(p > 0 && p < 1);
  }
  const blend = fitModel(a.X, a.y, { ...a.cfg, model: 'blend' }, a.names);
  approx(predictBlend(blend, a.X[3], 1), predictLogistic(blend.logistic, a.X[3]), 1e-12);
  approx(predictBlend(blend, a.X[3], 0), predictBuckets(blend.bucket, a.X[3]), 1e-12);
  const imp = featureImportance(blend);
  assert.ok(['evidence_rank', 'sweep_seen', 'htf_agrees'].includes(imp[0].name), `top feature ${imp[0].name}`);
  assert.ok(imp.slice(0, 5).some((r) => r.name === 'sweep_seen'));
  const back = deserialize(JSON.parse(JSON.stringify(serialize(blend))));
  assert.deepEqual(back, blend);
  approx(predictBlend(back, a.X[7]), predictBlend(blend, a.X[7]), 1e-12);
  assert.equal(deserialize(null), null);
  assert.equal(deserialize({ kind: 'nope' }), null);
  const bad = JSON.parse(JSON.stringify(blend));
  bad.logistic.w[0] = 'x';
  assert.equal(deserialize(bad), null);
  const bad2 = JSON.parse(JSON.stringify(blend));
  bad2.logistic.scale[0] = 0;
  assert.equal(deserialize(bad2), null);
  const bad3 = JSON.parse(JSON.stringify(blend));
  bad3.bucket.features[0].cells.pop();
  assert.equal(deserialize(bad3), null);
});

// ---------------------------------------------------------------- evaluation

test('eval: Brier, log loss and AUC on hand-worked values', () => {
  const p = [0.9, 0.8, 0.3, 0.2];
  const y = [1, 1, 0, 0];
  approx(brier(p, y), (0.01 + 0.04 + 0.09 + 0.04) / 4);
  approx(logLoss(p, y), -(Math.log(0.9) + Math.log(0.8) + Math.log(0.7) + Math.log(0.8)) / 4);
  assert.equal(aucRank(p, y), 1);
  assert.equal(aucRank([0.5, 0.5, 0.5, 0.5], y), 0.5, 'ties count half');
  assert.ok(Number.isNaN(aucRank([0.1, 0.2], [1, 1])), 'one class has no AUC');
  // Wins are 0.2 and 0.9, losses are 0.3 and 0.8. Of the four win-loss pairs only 0.9 beats both losses: 2 of 4.
  approx(aucRank([0.2, 0.9, 0.3, 0.8], y), 0.5);
  // Wins 0.9 and 0.3, losses 0.8 and 0.2: three of the four pairs rank the win higher.
  approx(aucRank([0.9, 0.3, 0.8, 0.2], y), 0.75);
  assert.equal(aucRank([0.1, 0.2, 0.8, 0.9], y), 0, 'a perfectly backwards score is 0');
  assert.ok(Number.isNaN(brier([], [])));
});

test('eval: calibration table, break-even rate and the metrics for the rows taken', () => {
  const t = calibrationTable([0.05, 0.15, 0.95, 0.9], [0, 0, 1, 0], 10);
  assert.equal(t.length, 10);
  assert.equal(t[0].n, 1);
  assert.equal(t[9].n, 2);
  approx(t[9].rate, 0.5);
  approx(t[9].meanP, 0.925);
  // Wins pay +2, losses cost -1: break-even is 1/3.
  approx(breakEvenRate([{ y: 1, r: 2 }, { y: 1, r: 2 }, { y: 0, r: -1 }]), 1 / 3);
  assert.equal(breakEvenRate([{ y: 1, r: 2 }]), null);
  assert.equal(breakEvenRate([{ y: 1, r: 2 }, { y: 0, r: 0.2 }]), 0, 'if even the losers made money, break-even is 0');
  const recs = [
    { y: 1, rMultiple: 2, netUsd: 0.1 }, { y: 0, rMultiple: -1, netUsd: -0.05 }, { y: 1, rMultiple: 2, netUsd: 0.1 },
    { y: 0, rMultiple: -1, netUsd: -0.05 }, { y: 0, rMultiple: -1, netUsd: -0.05 },
  ];
  const m = metricsFor(recs, [0.9, 0.2, 0.8, 0.3, 0.4], 0.5);
  assert.equal(m.n, 5);
  assert.equal(m.taken, 2);
  assert.equal(m.winRate, 1);
  approx(m.expectancyR, 2);
  approx(m.expectancyRAll, (2 - 1 + 2 - 1 - 1) / 5);
  approx(m.baseRate, 0.4);
  assert.equal(m.auc, 1);
  approx(m.brier, ((0.1) ** 2 + (0.2) ** 2 + (0.2) ** 2 + (0.3) ** 2 + (0.4) ** 2) / 5);
  const all = metricsFor(recs, [], 0, { take: recs.map(() => true) });
  assert.equal(all.taken, 5);
  approx(all.winRate, 0.4);
  approx(all.breakEven, 1 / 3);
  approx(all.profitFactor, 4 / 3);
  assert.equal(all.brier, null, 'no probabilities, no Brier');
  assert.equal(all.maxDrawdownR, 2, 'two losses in a row after a win... peak 1, trough -1');
});

test('walk-forward: test slices tile the records, training never touches them, purge leaves a gap', () => {
  const records = Array.from({ length: 100 }, (_, i) => ({ i }));
  const seen = [];
  const res = walkForward(records, {
    window: 30, step: 10, purge: 2,
    fit: (train, test) => { seen.push({ train: [train[0].i, train.at(-1).i], test: [test[0].i, test.at(-1).i], tn: train.length }); return test.map((r) => r.i); },
  });
  assert.equal(seen[0].train[1], 29);
  assert.equal(seen[0].test[0], 32, 'two records are skipped between training and test');
  for (const s of seen) {
    assert.ok(s.train[1] + 2 < s.test[0] + 1, 'training ends before the purge gap');
    assert.ok(s.tn <= 30);
  }
  assert.deepEqual(res.rows.map((r) => r.index), Array.from({ length: 68 }, (_, k) => 32 + k), 'tiles 32..99 with no overlap or hole');
  assert.ok(res.rows.every((r) => r.out === r.record.i));
  assert.equal(res.windows[0].trainFrom, 0);
  assert.equal(res.windows[1].trainFrom, 10, 'the window rolls forward');
  assert.throws(() => walkForward(records, { window: 30, step: 10, fit: () => [] }), /one output per test row/);
  assert.deepEqual(walkForward(records.slice(0, 20), { window: 30, step: 10, fit: () => [] }).rows, []);
  const split = chronoSplit(records, 0.2);
  assert.equal(split.train.length, 80);
  assert.equal(split.test[0].i, 80);
});

// ---------------------------------------------------------------- shadow replay

test('shadow replay: fills, stop before target in the same bar, target, gap, timeout and no fill', () => {
  const plan = { side: 'buy', entry: 100, stop: 99, target: 102 };
  const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });
  // No bar reaches the entry within the horizon.
  assert.equal(replayPlan({ plan, candles: [bar(103, 104, 101, 103), bar(103, 104, 101, 103)], horizon: 2 }).status, 'nofill');
  assert.equal(replayPlan({ plan, candles: [bar(103, 104, 101, 103)], horizon: 2 }).status, 'pending');
  // Fills at the entry, then the target is hit on a later bar: +2R.
  const win = replayPlan({ plan, candles: [bar(101, 101.5, 99.5, 100.5), bar(100.5, 102.5, 100.2, 102.2)], horizon: 5 });
  assert.equal(win.status, 'win');
  approx(win.rMultiple, 2);
  assert.equal(win.fillIndex, 0);
  assert.equal(win.exitIndex, 1);
  // A bar that touches both the stop and the target counts as the stop.
  const both = replayPlan({ plan, candles: [bar(101, 101.5, 99.5, 100.5), bar(100.5, 102.5, 98.5, 100)], horizon: 5 });
  assert.equal(both.status, 'loss');
  approx(both.rMultiple, -1);
  // The fill bar counts only for the stop: a target-high on the fill bar is not a win.
  const fillBar = replayPlan({ plan, candles: [bar(101, 103, 99.5, 100.5)], horizon: 5 });
  assert.equal(fillBar.status, 'pending');
  // A gap through the stop exits at the open.
  const gap = replayPlan({ plan, candles: [bar(101, 101.5, 99.5, 100.5), bar(97, 98, 96, 97.5)], horizon: 5 });
  assert.equal(gap.status, 'loss');
  approx(gap.rMultiple, -3);
  // Costs: half spread 0.1 each way is 0.2 / 1 = 0.2 R.
  approx(replayPlan({ plan, candles: [bar(101, 101.5, 99.5, 100.5), bar(100.5, 102.5, 100.2, 102.2)], horizon: 5, halfSpread: 0.1 }).rMultiple, 1.8);
  // Timeout after the horizon: marked at the close.
  const slow = [bar(101, 101.5, 99.5, 100.5), bar(100.5, 100.8, 100.1, 100.5), bar(100.5, 100.9, 100.2, 100.6)];
  const timeout = replayPlan({ plan, candles: slow, horizon: 2 });
  assert.equal(timeout.status, 'timeout');
  approx(timeout.rMultiple, 0.6);
  // Sell mirror.
  const sell = replayPlan({ plan: { side: 'sell', entry: 100, stop: 101, target: 98 }, candles: [bar(99, 100.5, 98.8, 99.5), bar(99.5, 99.8, 97.9, 98.1)], horizon: 5 });
  assert.equal(sell.status, 'win');
  approx(sell.rMultiple, 2);
  assert.equal(replayPlan({ plan: { side: 'buy', entry: 100, stop: 100, target: 101 }, candles: [] }).status, 'invalid');
  assert.equal(replayPlan({ plan: null, candles: [] }).status, 'invalid');
});

// ---------------------------------------------------------------- the gate

const goodMetrics = () => ({
  oos: {
    n: 150, baseBrier: 0.24, modelBrier: 0.21,
    baseline: { n: 150, taken: 150, expectancyR: 0.1 },
    model: { n: 150, taken: 60, expectancyR: 0.9 },
    filters: { n: 150, taken: 80, expectancyR: 0.5 },
  },
});
const goodProposal = (over = {}) => ({
  id: 'L1', status: 'proposed', changes: { 'tdc.minEvidence': 60, 'll.modelActive': true }, model: { kind: 'blend' }, filters: [{ key: 'tdc.minEvidence', value: 60 }], metrics: goodMetrics(), ...over,
});
const edgeRecords = (n = 200, winShare = 0.55) => Array.from({ length: n }, (_, i) => ({ y: i % 20 < winShare * 20 ? 1 : 0, rMultiple: i % 20 < winShare * 20 ? 2 : -1, netUsd: 0.1, rr: 2 }));

test('gate: passes only when every check passes, and each failure names the right check', () => {
  const cfg = cfgFor('ll', normalise({}));
  const ok = gateChecks({ records: edgeRecords(), proposal: goodProposal(), cfg, roleOk: true });
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
  assert.deepEqual(ok.checks.map((c) => c.id), ['closed_trades', 'wilson_above_breakeven', 'oos_pass', 'brier_beats_base', 'role', 'learnable_only', 'has_changes']);
  const failing = (over, id) => {
    const g = gateChecks({ records: over.records || edgeRecords(), proposal: over.proposal || goodProposal(), cfg: over.cfg || cfg, roleOk: over.roleOk ?? true });
    assert.equal(g.ok, false, id);
    assert.deepEqual(g.checks.filter((c) => !c.ok).map((c) => c.id), [id], id);
    return g.checks.find((c) => c.id === id);
  };
  failing({ records: edgeRecords(99) }, 'closed_trades');
  failing({ records: edgeRecords(200, 0.3) }, 'wilson_above_breakeven');
  failing({ roleOk: false }, 'role');
  failing({ proposal: goodProposal({ changes: { 'risk.riskPct': 5 } }) }, 'learnable_only');
  failing({ proposal: goodProposal({ changes: { 'engine.liveEnabled': true } }) }, 'learnable_only');
  failing({ proposal: goodProposal({ changes: {} }) }, 'has_changes');
  // Nothing at all in the proposal: nothing was tested out of sample and nothing would change, so both checks say so.
  const empty = gateChecks({ records: edgeRecords(), proposal: goodProposal({ changes: {}, model: null, filters: [] }), cfg, roleOk: true });
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.checks.filter((c) => !c.ok).map((c) => c.id), ['oos_pass', 'has_changes']);
  const m = goodMetrics();
  m.oos.model.expectancyR = 0.05;
  assert.match(failing({ proposal: goodProposal({ metrics: m }) }, 'oos_pass').text, /no better than taking every trade/);
  const few = goodMetrics();
  few.oos.model.n = 20;
  assert.match(failing({ proposal: goodProposal({ metrics: few }) }, 'oos_pass').text, /only 20 out-of-sample/);
  const rare = goodMetrics();
  rare.oos.model.taken = 5;
  assert.match(failing({ proposal: goodProposal({ metrics: rare }) }, 'oos_pass').text, /only 5 of them/);
  const neg = goodMetrics();
  neg.oos.filters.expectancyR = -0.1;
  assert.match(failing({ proposal: goodProposal({ metrics: neg }) }, 'oos_pass').text, /not above zero/);
  const worse = goodMetrics();
  worse.oos.modelBrier = 0.26;
  failing({ proposal: goodProposal({ metrics: worse }) }, 'brier_beats_base');
  // No out-of-sample result at all: neither the test nor the Brier score can be judged.
  const none = gateChecks({ records: edgeRecords(), proposal: goodProposal({ metrics: { oos: null } }), cfg, roleOk: true });
  assert.deepEqual(none.checks.filter((c) => !c.ok).map((c) => c.id), ['oos_pass', 'brier_beats_base']);
});

test('gate: the closed-trade floor is 100 even when the setting is lower, and the requirement switches work', () => {
  assert.equal(MIN_CLOSED_FLOOR, 100);
  const low = { ...cfgFor('ll', normalise({})), minClosed: 10 };
  const g = gateChecks({ records: edgeRecords(60), proposal: goodProposal(), cfg: low, roleOk: true });
  assert.equal(g.checks[0].ok, false);
  assert.match(g.checks[0].text, /100 needed/);
  const off = { ...cfgFor('ll', normalise({})), requireOos: false, requireBrier: false };
  const m = goodMetrics();
  m.oos.model.expectancyR = -1;
  m.oos.modelBrier = 0.5;
  const g2 = gateChecks({ records: edgeRecords(), proposal: goodProposal({ metrics: m }), cfg: off, roleOk: true });
  assert.equal(g2.ok, true);
  const payout = gateChecks({ records: edgeRecords(200, 0.4), proposal: goodProposal(), cfg: { ...cfgFor('ll', normalise({})), breakEven: 'payout' }, roleOk: true });
  assert.match(payout.checks[1].text, /break-even 33\.3%/);
});

test('gate: approval needs the exact typed phrase, an open proposal, a passing gate and a named actor', () => {
  const cfg = cfgFor('ll', normalise({}));
  const gate = gateChecks({ records: edgeRecords(), proposal: goodProposal(), cfg, roleOk: true });
  assert.equal(approvalPhrase('L1'), 'APPROVE L1');
  const rec = gateApprove(goodProposal(), 'APPROVE L1', 'user', 5, gate);
  assert.ok(Object.isFrozen(rec) && Object.isFrozen(rec.changes));
  assert.equal(rec.actor, 'user');
  assert.throws(() => gateApprove(goodProposal(), 'approve L1', 'user', 5, gate), { code: 'BAD_PHRASE' });
  assert.throws(() => gateApprove(goodProposal(), 'APPROVE L2', 'user', 5, gate), { code: 'BAD_PHRASE' });
  assert.throws(() => gateApprove(goodProposal(), 'yes', 'user', 5, gate), { code: 'BAD_PHRASE' });
  assert.throws(() => gateApprove(goodProposal(), null, 'user', 5, gate), { code: 'BAD_PHRASE' });
  assert.throws(() => gateApprove(goodProposal(), 'APPROVE L1', '', 5, gate), { code: 'NO_ACTOR' });
  assert.throws(() => gateApprove(goodProposal({ status: 'rejected' }), 'APPROVE L1', 'user', 5, gate), { code: 'NOT_OPEN' });
  assert.throws(() => gateApprove(null, 'APPROVE L1', 'user', 5, gate), { code: 'NOT_OPEN' });
  const closed = gateChecks({ records: edgeRecords(50), proposal: goodProposal(), cfg, roleOk: true });
  assert.throws(() => gateApprove(goodProposal(), 'APPROVE L1', 'user', 5, closed), (e) => e.code === 'GATE_FAILED' && /closed paper trades/i.test(e.message));
  assert.throws(() => gateApprove(goodProposal(), 'APPROVE L1', 'user', 5, null), { code: 'GATE_FAILED' });
});

// ---------------------------------------------------------------- the loop

test('loop: records cases, labels outcomes three ways, and tracks the recent streak', () => {
  const run = (over, trade) => {
    const { loop } = makeLoop(0, 1, 'edge', over);
    loop.recordCase({ side: 'buy', families: { levels: true, structure: false, liquidity: true, zones: true }, agreeCount: 3, evidenceRank: 70 }, { caseId: 'a', asset: 'R_100', tf: 60, side: 'buy', nowMs: 1 });
    return { loop, y: loop.recordOutcome('a', trade) };
  };
  assert.equal(run({}, { netUsd: 0.01, rMultiple: 0.2, exitMs: 2 }).y, 1);
  assert.equal(run({}, { netUsd: -0.01, rMultiple: -0.2, exitMs: 2 }).y, 0);
  assert.equal(run({ ll: { labelMode: 'target_hit' } }, { netUsd: 0.5, rMultiple: 3, exitMs: 2, trailingArmed: false }).y, 0);
  assert.equal(run({ ll: { labelMode: 'target_hit' } }, { netUsd: -0.01, rMultiple: -0.1, exitMs: 2, trailingArmed: true }).y, 1);
  assert.equal(run({ ll: { labelMode: 'r_multiple', labelR: 1.5 } }, { netUsd: 0.1, rMultiple: 1.4, exitMs: 2 }).y, 0);
  assert.equal(run({ ll: { labelMode: 'r_multiple', labelR: 1.5 } }, { netUsd: 0.1, rMultiple: 1.6, exitMs: 2 }).y, 1);
  assert.equal(familySigOf({ families: { levels: true, structure: false, liquidity: true, zones: true } }), 'levels+liquidity+zones');
  assert.equal(familySigOf({}), '');

  const { loop } = makeLoop(0, 1, 'edge');
  const snap = { side: 'buy', families: { levels: true }, agreeCount: 1, evidenceRank: 50 };
  const streaks = [];
  for (let i = 0; i < 4; i += 1) {
    loop.recordCase(snap, { caseId: `s${i}`, asset: 'R_100', tf: 60, side: 'buy', nowMs: 100 + i });
    streaks.push(loop.rows.at(-1).snap.recentStreak);
    loop.recordOutcome(`s${i}`, { netUsd: i < 3 ? 0.1 : -0.1, rMultiple: i < 3 ? 2 : -1, exitMs: 200 + i });
  }
  assert.deepEqual(streaks, [0, 1, 2, 3]);
  loop.recordCase(snap, { caseId: 'after', asset: 'R_100', tf: 60, side: 'buy', nowMs: 500 });
  assert.equal(loop.rows.at(-1).snap.recentStreak, -1, 'the last trade lost, so the streak is one loss');
  assert.equal(loop.recordCase(snap, { caseId: 'after', asset: 'R_100', tf: 60, side: 'buy', nowMs: 500 }), null, 'the same case is only recorded once');
  assert.equal(loop.recordOutcome('missing', { netUsd: 1 }), null);
});

test('loop: nothing is proposed before 100 closed trades, and it says why', () => {
  const { loop } = makeLoop(99, 1, 'edge');
  assert.equal(loop.propose(5), null);
  assert.match(loop.status().lastReason, /99 closed paper trades so far\. The loop needs 100/);
  assert.equal(loop.status().ready, false);
  const { loop: off } = makeLoop(300, 1, 'edge', { ll: { enabled: false } });
  assert.equal(off.propose(5), null);
  assert.match(off.status().lastReason, /switched off/);
  const { loop: obs } = makeLoop(300, 1, 'edge', { engine: { roleId: 'observer' } });
  assert.equal(obs.propose(5), null);
  assert.match(obs.status().lastReason, /role does not allow learning/);
  const { loop: same } = makeLoop(0, 1, 'edge');
  for (let i = 0; i < 120; i += 1) {
    same.recordCase({ side: 'buy', families: { levels: true }, agreeCount: 1, evidenceRank: 60 }, { caseId: `w${i}`, asset: 'R_100', tf: 60, side: 'buy', nowMs: i });
    same.recordOutcome(`w${i}`, { netUsd: 0.1, rMultiple: 2, exitMs: i });
  }
  assert.equal(same.propose(5), null);
  assert.match(same.status().lastReason, /same result/);
});

test('loop: with a real edge it proposes a model and filters that beat taking every trade out of sample', () => {
  const { loop, audit, applied } = makeLoop(400, 1, 'edge');
  const p = loop.propose(T0 + 99);
  assert.ok(p, loop.status().lastReason);
  assert.equal(p.id, 'L1');
  assert.equal(p.status, 'proposed');
  assert.ok(p.model && p.model.kind === 'blend');
  assert.equal(p.changes['ll.modelActive'], true);
  assert.ok(p.changes['ll.threshold'] > 0 && p.changes['ll.threshold'] < 1);
  for (const key of Object.keys(p.changes)) assert.ok(LEARNABLE_KEYS.includes(key), `${key} must be learnable`);
  const oos = p.metrics.oos;
  assert.ok(oos.n >= 150);
  assert.ok(oos.model.taken >= 10 && oos.model.expectancyR > oos.baseline.expectancyR && oos.model.expectancyR > 0);
  assert.ok(oos.modelBrier < oos.baseBrier);
  assert.ok(p.metrics.importance.length > 0);
  assert.equal(p.metrics.closed, 400);
  assert.ok(p.metrics.holdout && p.metrics.holdout.n > 0, 'the final holdout is reported');
  assert.ok(p.metrics.windows >= 3);
  assert.equal(applied.length, 0, 'a proposal changes nothing');
  assert.equal(audit.list({ limit: 50 }).filter((e) => e.kind === 'learning_proposal').length, 1);
  const gate = loop.gate('L1');
  assert.equal(gate.ok, true, JSON.stringify(gate.checks.filter((c) => !c.ok)));
  assert.equal(loop.snapshot().gate.ok, true);
  assert.equal(loop.snapshot().proposals[0].id, 'L1');
});

test('loop: the same trades always give the same proposal', () => {
  const a = makeLoop(300, 2, 'edge').loop.propose(T0 + 5);
  const b = makeLoop(300, 2, 'edge').loop.propose(T0 + 5);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('loop: a losing system with no signal gets no proposal, and the gate would not pass anyway', () => {
  for (const seed of [4, 5, 6]) {
    const { loop } = makeLoop(400, seed, 'noise');
    const p = loop.propose(T0 + 5);
    if (p) {
      assert.equal(loop.gate(p.id).ok, false, `seed ${seed}`);
      assert.equal(loop.gate(p.id).checks.find((c) => c.id === 'wilson_above_breakeven').ok, false);
    } else {
      assert.match(loop.status().lastReason, /nothing beat taking every trade/);
      assert.ok(loop.lastReport.metrics.oos.n > 100, 'the report still shows the numbers');
    }
  }
});

test('loop: approval is the only thing that applies changes, and only learnable keys, and only with the phrase', () => {
  const { loop, applied, audit } = makeLoop(400, 1, 'edge');
  const p = loop.propose(T0 + 99);
  assert.throws(() => loop.approve('L1', 'yes please', 'user'), { code: 'BAD_PHRASE' });
  assert.throws(() => loop.approve('L1', 'APPROVE L9', 'user'), { code: 'BAD_PHRASE' });
  assert.throws(() => loop.approve('L9', 'APPROVE L9', 'user'), { code: 'NOT_FOUND' });
  assert.equal(applied.length, 0, 'wrong phrases changed nothing');
  assert.equal(loop.score({ side: 'buy', families: {}, evidenceRank: 80 }), null, 'no approved model yet');
  const done = loop.approve('L1', 'APPROVE L1', 'user', T0 + 200);
  assert.equal(done.status, 'approved');
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], p.changes);
  assert.ok(Object.keys(applied[0]).every((k) => LEARNABLE_KEYS.includes(k)));
  assert.equal(loop.status().model.proposalId, 'L1');
  const strong = loop.score({ side: 'buy', families: { levels: true, structure: true, liquidity: true, zones: true }, agreeCount: 4, evidenceRank: 90, sweepSeen: true, fvgObOk: true, structureOk: true, volClass: 'normal', atrPct: 50, hourUtc: 8, rr: 2, stopAtr: 1, zoneDepth: 0.2, htfAgrees: true, breakoutPresent: false, recentStreak: 0 });
  const weak = loop.score({ side: 'buy', families: { levels: false, structure: false, liquidity: false, zones: true }, agreeCount: 1, evidenceRank: 35, sweepSeen: false, fvgObOk: false, structureOk: false, volClass: 'normal', atrPct: 50, hourUtc: 8, rr: 2, stopAtr: 1, zoneDepth: 0.2, htfAgrees: false, breakoutPresent: false, recentStreak: 0 });
  assert.ok(strong > weak + 0.2, `${strong} vs ${weak}`);
  assert.ok(audit.list({ limit: 50 }).some((e) => e.kind === 'learning_approved'));
  assert.throws(() => loop.approve('L1', 'APPROVE L1', 'user'), { code: 'NOT_OPEN' }, 'an approved proposal cannot be approved again');
});

test('loop: approval is refused when the gate fails, when settings cannot be applied, and for a role that cannot learn', () => {
  const young = makeLoop(150, 3, 'edge');
  const p = young.loop.propose(T0 + 9);
  assert.ok(p);
  assert.equal(young.loop.gate(p.id).ok, false);
  assert.throws(() => young.loop.approve(p.id, `APPROVE ${p.id}`, 'user'), { code: 'GATE_FAILED' });
  assert.equal(young.applied.length, 0);
  assert.equal(young.loop.find(p.id).status, 'proposed');

  const broken = makeLoop(400, 1, 'edge', {}, { applySettings: () => ({ ok: false, errors: ['tdc.minEvidence: out of range'] }) });
  broken.loop.propose(T0 + 99);
  assert.throws(() => broken.loop.approve('L1', 'APPROVE L1', 'user'), (e) => e.code === 'APPLY_FAILED' && /out of range/.test(e.message));
  assert.equal(broken.loop.find('L1').status, 'proposed', 'a failed apply leaves the proposal open');
  assert.equal(broken.loop.status().model, null);
  assert.ok(broken.audit.list({ limit: 50 }).some((e) => e.kind === 'learning_apply_failed'));

  const noApply = makeLoop(400, 1, 'edge');
  noApply.loop.propose(T0 + 99);
  noApply.loop.applySettings = null;
  assert.throws(() => noApply.loop.approve('L1', 'APPROVE L1', 'user'), { code: 'NO_APPLY' });

  const guarded = makeLoop(400, 1, 'edge');
  guarded.loop.propose(T0 + 99);
  guarded.loop.proposals[0].changes['risk.riskPct'] = 50; // a tampered proposal
  assert.throws(() => guarded.loop.approve('L1', 'APPROVE L1', 'user'), { code: 'GATE_FAILED' });
  assert.equal(guarded.applied.length, 0);

  const demoted = makeLoop(400, 1, 'edge');
  demoted.loop.propose(T0 + 99);
  demoted.settings.engine.roleId = 'observer';
  assert.throws(() => demoted.loop.approve('L1', 'APPROVE L1', 'user'), { code: 'GATE_FAILED' });
});

test('loop: reject closes a proposal, a newer one supersedes an older open one, and the model can be cleared', () => {
  const { loop, audit } = makeLoop(400, 1, 'edge');
  loop.propose(T0 + 1);
  assert.equal(loop.reject('L1', 'user', T0 + 2), true);
  assert.equal(loop.find('L1').status, 'rejected');
  assert.equal(loop.reject('L1'), false);
  loop.propose(T0 + 3);
  loop.propose(T0 + 4);
  assert.equal(loop.find('L2').status, 'superseded');
  assert.equal(loop.find('L3').status, 'proposed');
  assert.deepEqual(loop.list().map((p) => p.id), ['L3', 'L2', 'L1']);
  loop.approve('L3', 'APPROVE L3', 'user', T0 + 5);
  assert.equal(loop.clearModel('user', T0 + 6), true);
  assert.equal(loop.status().model, null);
  assert.equal(loop.clearModel(), false);
  assert.ok(audit.list({ limit: 50 }).some((e) => e.kind === 'learning_rejected'));
});

test('loop: estimates by group fall back to wider groups and pass only with enough trades above break-even', () => {
  const settings = normalise({});
  const loop = new LearningLoop({ getSettings: () => settings });
  const add = (n, win, extra = {}) => {
    for (let i = 0; i < n; i += 1) {
      const id = `${extra.asset || 'R_100'}-${extra.side || 'buy'}-${loop.rows.length}`;
      loop.recordCase({ side: extra.side || 'buy', families: { levels: true, zones: true }, agreeCount: 2, evidenceRank: 60 }, { caseId: id, asset: extra.asset || 'R_100', tf: 60, side: extra.side || 'buy', nowMs: loop.rows.length });
      const w = i < win;
      loop.recordOutcome(id, { netUsd: w ? 0.1 : -0.05, rMultiple: w ? 2 : -1, exitMs: loop.rows.length });
    }
  };
  assert.equal(loop.estimateFor({ asset: 'R_100', tf: 60, side: 'buy', familySig: 'levels+zones' }), null, 'no trades, no estimate');
  add(20, 11);
  const small = loop.estimateFor({ asset: 'R_100', tf: 60, side: 'buy', familySig: 'levels+zones' });
  assert.equal(small.n, 20);
  assert.equal(small.passes, false, 'too few trades');
  assert.equal(small.group, 'R_100|60|buy|levels+zones');
  approx(small.winRate, 0.55);
  approx(small.breakEven, 1 / 3, 1e-9);
  add(110, 66);
  const big = loop.estimateFor({ asset: 'R_100', tf: 60, side: 'buy', familySig: 'levels+zones' });
  assert.equal(big.n, 130);
  assert.equal(big.passes, true);
  assert.ok(big.lo > big.breakEven);
  // A group with no trades of its own uses a wider group.
  const wide = loop.estimateFor({ asset: 'frxXAUUSD', tf: 300, side: 'buy', familySig: 'levels+zones' });
  assert.equal(wide.group, 'buy|levels+zones');
  assert.equal(wide.n, 130);
  const none = loop.estimateFor({ asset: 'R_100', tf: 60, side: 'sell', familySig: 'x' });
  assert.equal(none.group, 'all', 'falls back all the way to every trade');
  // A losing group does not pass however many trades.
  const losing = new LearningLoop({ getSettings: () => settings });
  for (let i = 0; i < 150; i += 1) {
    losing.recordCase({ side: 'buy', families: { levels: true }, agreeCount: 1, evidenceRank: 60 }, { caseId: `l${i}`, asset: 'R_100', tf: 60, side: 'buy', nowMs: i });
    losing.recordOutcome(`l${i}`, { netUsd: i % 4 === 0 ? 0.1 : -0.05, rMultiple: i % 4 === 0 ? 2 : -1, exitMs: i });
  }
  assert.equal(losing.estimateFor({ asset: 'R_100', tf: 60, side: 'buy', familySig: 'levels' }).passes, false);
});

test('loop: shadow replay labels refused cases for learning only, and they never count as closed trades', () => {
  const off = makeLoop(0, 1, 'edge');
  assert.equal(off.loop.recordCase({ side: 'buy' }, { caseId: 'x', asset: 'R_100', tf: 60, side: 'buy', nowMs: 1, plan: { side: 'buy', entry: 100, stop: 99, target: 102, rr: 2 }, placed: false }), null, 'shadow is off by default');

  const { loop } = makeLoop(0, 1, 'edge', { ll: { shadow: true, shadowHorizon: 5 } });
  const snap = { side: 'buy', families: { levels: true }, agreeCount: 1, evidenceRank: 60, stopAtr: 1, rr: 2 };
  const plan = { side: 'buy', entry: 100, stop: 99, target: 102, rr: 2 };
  assert.equal(loop.recordCase(snap, { caseId: 'win', asset: 'R_100', tf: 60, side: 'buy', nowMs: 1, plan, placed: false }), 'win');
  loop.recordCase(snap, { caseId: 'loss', asset: 'R_100', tf: 60, side: 'buy', nowMs: 2, plan, placed: false });
  loop.recordCase(snap, { caseId: 'never', asset: 'R_100', tf: 60, side: 'buy', nowMs: 3, plan: { ...plan, entry: 90, stop: 89, target: 92 }, placed: false });
  assert.equal(loop.status().shadowQueued, 3);
  const feed = [
    { open: 101, high: 101.5, low: 99.5, close: 100.5 }, // fills both at 100
    { open: 100.5, high: 102.4, low: 100.2, close: 102.2 }, // target
  ];
  // The loss case needs a stop: send a second market's candles only to the matching market.
  for (const c of feed) loop.onCandle({ asset: 'OTHER', tf: 60, candle: c });
  assert.equal(loop.status().shadowQueued, 3, 'candles from another market do nothing');
  for (const c of feed) loop.onCandle({ asset: 'R_100', tf: 60, candle: c });
  assert.equal(loop.status().shadowQueued, 0 + loop.shadowQueue.length);
  const byId = Object.fromEntries(loop.rows.map((r) => [r.caseId, r]));
  assert.equal(byId.win.y, 1);
  assert.equal(byId.win.kind, 'shadow');
  assert.equal(byId.win.shadowResult, 'win');
  assert.equal(byId.loss.y, 1, 'both fill at 100 and reach 102 in the second bar, so both are wins');
  for (let i = 0; i < 12; i += 1) loop.onCandle({ asset: 'R_100', tf: 60, candle: { open: 105, high: 106, low: 103, close: 104 } });
  assert.equal(byId.never.status, 'nofill');
  assert.equal(loop.closedCount(), 0, 'shadow rows are not closed paper trades');
  assert.equal(loop.status().closed, 0);
  assert.equal(loop.status().shadowLabelled, 2);
  assert.equal(loop.records().filter((r) => r.kind === 'shadow').length, 3);
});

test('loop: shadow rows help training but never count in the out-of-sample judgement or the gate', () => {
  const { loop } = makeLoop(300, 1, 'edge', { ll: { shadow: true } });
  const rnd = mulberry32(99);
  for (let i = 0; i < 150; i += 1) {
    const c = makeCase(rnd, 1000 + i, 'edge');
    loop.recordCase(c.snap, { caseId: `sh${i}`, asset: 'R_100', tf: 60, side: c.snap.side, nowMs: T0 + (1000 + i) * 60000, plan: { side: 'buy', entry: 100, stop: 99, target: 102, rr: 2 }, placed: false });
    const row = loop.rows.at(-1);
    row.y = c.win ? 1 : 0;
    row.rMultiple = c.R;
    row.status = 'closed';
  }
  assert.equal(loop.closedCount(), 300);
  const p = loop.propose(T0 + 1e10);
  assert.ok(p);
  assert.equal(p.metrics.closed, 300);
  assert.equal(p.metrics.shadow, 150);
  assert.equal(p.metrics.overall.n, 300, 'the overall numbers are real trades only');
  assert.equal(loop.gate(p.id).checks[0].text, '300 closed paper trades so far, 100 needed.');
});

test('loop: auto-propose waits for enough new trades since the last try', () => {
  const { loop } = makeLoop(120, 1, 'edge');
  const first = loop.maybePropose(T0 + 1);
  assert.ok(first || loop.status().lastReason, 'the first call runs');
  const before = loop.propSeq;
  assert.equal(loop.maybePropose(T0 + 2), null, 'no new trades, no new try');
  assert.equal(loop.propSeq, before);
  for (let i = 0; i < 30; i += 1) {
    const rnd = mulberry32(500 + i);
    const c = makeCase(rnd, 5000 + i, 'edge');
    loop.recordCase(c.snap, { caseId: `n${i}`, asset: 'R_100', tf: 60, side: c.snap.side, nowMs: T0 + (5000 + i) * 60000, placed: true });
    loop.recordOutcome(`n${i}`, { netUsd: c.R * 0.05, rMultiple: c.R, exitMs: T0 + (5000 + i) * 60000 + 1, trailingArmed: c.win });
  }
  loop.maybePropose(T0 + 3);
  assert.ok(loop.lastInfo.atMs === T0 + 3, 'it tried again after 25 more trades');
  const { loop: manual } = makeLoop(400, 1, 'edge', { ll: { autoPropose: false } });
  assert.equal(manual.maybePropose(T0), null);
  assert.equal(manual.propSeq, 0);
});

test('loop: the threshold search and every model kind produce a valid proposal', () => {
  for (const over of [{ ll: { thresholdSearch: true } }, { ll: { model: 'logistic' } }, { ll: { model: 'bucket' } }, { ll: { standardize: 'minmax', classWeight: 'none' } }]) {
    const { loop } = makeLoop(400, 1, 'edge', over);
    const p = loop.propose(T0 + 1);
    if (p) {
      for (const key of Object.keys(p.changes)) assert.ok(LEARNABLE_KEYS.includes(key));
      if (p.model) assert.equal(p.model.kind, over.ll.model || 'blend');
    } else assert.ok(loop.lastReport, 'a report is kept even without a proposal');
  }
  const { loop } = makeLoop(400, 1, 'edge', { ll: { thresholdSearch: true } });
  const p = loop.propose(T0 + 1);
  assert.ok(p && p.threshold >= 0.3 && p.threshold <= 0.7);
});

test('loop: filter candidates only tighten, and each is a real learnable key', () => {
  assert.deepEqual(FILTER_SPECS.map((s) => s.key), ['tdc.minEvidence', 'tdc.minFamilies', 'ble.maxStopAtr', 'sle.maxStopAtr']);
  for (const s of FILTER_SPECS) assert.ok(LEARNABLE_KEYS.includes(s.key), s.key);
  const settings = normalise({ tdc: { minEvidence: 70 } });
  const { loop } = makeLoop(400, 1, 'edge', { tdc: { minEvidence: 70 } });
  void settings;
  const p = loop.propose(T0 + 1);
  if (p && p.changes['tdc.minEvidence'] !== undefined) assert.ok(p.changes['tdc.minEvidence'] > 70, 'a looser value cannot be judged from trades taken at 70');
});

test('loop: save and load keeps the records, proposals and the approved model, and drops a damaged model', () => {
  const a = makeLoop(400, 1, 'edge');
  a.loop.propose(T0 + 1);
  a.loop.approve('L1', 'APPROVE L1', 'user', T0 + 2);
  const saved = JSON.parse(JSON.stringify(a.loop.exportState()));
  const b = makeLoop(0, 1, 'edge');
  assert.equal(b.loop.importState(saved), true);
  assert.equal(b.loop.closedCount(), 400);
  assert.equal(b.loop.list()[0].status, 'approved');
  const snap = { side: 'buy', families: { levels: true, structure: true, liquidity: true, zones: true }, agreeCount: 4, evidenceRank: 85, sweepSeen: true, fvgObOk: true, structureOk: true, volClass: 'normal', atrPct: 50, hourUtc: 8, rr: 2, stopAtr: 1, zoneDepth: 0.2, htfAgrees: true, breakoutPresent: false, recentStreak: 0 };
  approx(b.loop.score(snap), a.loop.score(snap), 1e-12);
  const bad = JSON.parse(JSON.stringify(saved));
  bad.approved.bundle.logistic.w[0] = 'nope';
  const c = makeLoop(0, 1, 'edge');
  assert.equal(c.loop.importState(bad), true);
  assert.equal(c.loop.status().model, null, 'a model that fails its checks is not trusted');
  for (const junk of [null, 3, {}, { version: 9 }, { version: 1, rows: 4, proposals: [] }]) assert.equal(c.loop.importState(junk), false);
  assert.equal(c.loop.closedCount(), 400, 'a refused import changes nothing');
  assert.equal(saved.version, 1);
  let calls = 0;
  const p = makeLoop(0, 1, 'edge').loop;
  p.persist = () => { calls += 1; return Promise.reject(new Error('disk full')); };
  p._persist();
  assert.equal(calls, 1, 'a failing save never breaks the loop');
});

test('loop: the record cap keeps the newest, and the records view is plain data', () => {
  const { loop } = makeLoop(0, 1, 'edge', { ll: { maxRecords: 100 } });
  for (let i = 0; i < 130; i += 1) {
    loop.recordCase({ side: 'buy', families: { levels: true }, agreeCount: 1, evidenceRank: 50 }, { caseId: `r${i}`, asset: 'R_100', tf: 60, side: 'buy', nowMs: i });
  }
  assert.equal(loop.rows.length, 100);
  assert.equal(loop.rows[0].caseId, 'r30');
  const view = loop.records(5);
  assert.equal(view.length, 5);
  assert.equal(JSON.stringify(view), JSON.stringify(JSON.parse(JSON.stringify(view))));
  loop.recordNoFill('r129', 'expired');
  assert.equal(loop.rows.at(-1).status, 'nofill');
  assert.equal(loop.closedCount(), 0);
  assert.throws(() => new LearningLoop({}), /getSettings/);
});
