// The trading session: one closed candle through storage, paper trader, learning, engines, cases, risk and orders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradingSession } from '../js/runtime/session.js';
import { simCandles, ASSET } from './helpers/sim.mjs';

const TFS = [60, 300];
const settingsOf = (extra = {}) => ({ data: { timeframes: TFS }, engine: { tradeTimeframes: TFS }, ...extra });

// One M1 candle, then the M5 candle if that M1 candle just finished one (the way the runner does it).
function feedOne(s, c) {
  const first = s.ingest({ asset: ASSET, tf: 60, candle: c });
  const agg = s.mde.aggregateLast(ASSET, 60, 300);
  if (agg) s.ingest({ asset: ASSET, tf: 300, candle: agg });
  return first;
}
function feed(s, m1, from = 0, to = m1.length) {
  let bad = 0;
  for (let i = from; i < to; i += 1) if (!feedOne(s, m1[i]).ok) bad += 1;
  return bad;
}
const snapshotOf = (s) => JSON.stringify({
  counts: s.stats.counts,
  closed: s.trader.trades().map((t) => [t.id, t.exitMs, t.pnlUsd ?? t.netUsd ?? null]),
  open: s.trader.state(s.nowMs).positions.length,
  pend: s.trader.state(s.nowMs).pendings.length,
  verdicts: s.verdicts.map((v) => [v.id, v.ok]),
});
function nonFinite(x, path = '', out = []) {
  if (typeof x === 'number' && !Number.isFinite(x)) out.push(path);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) nonFinite(v, `${path}.${k}`, out);
  return out;
}

const N = 500;
const m1 = simCandles(N, 21);

let sharedRun = null;
function shared() {
  if (!sharedRun) {
    const s = new TradingSession({ settings: settingsOf() });
    const snaps = {};
    for (let i = 0; i < N; i += 1) {
      feedOne(s, m1[i]);
      if (i === 349) snaps.at350 = snapshotOf(s);
    }
    sharedRun = { s, snaps };
  }
  return sharedRun;
}

test('ingest: the first candles are only stored, later ones run the whole chain', () => {
  const s = new TradingSession({ settings: settingsOf() });
  const r = s.ingest({ asset: ASSET, tf: 60, candle: m1[0] });
  assert.equal(r.ok, true);
  assert.equal(r.closeMs, (m1[0].epoch + 60) * 1000);
  assert.deepEqual(r.filled, []);
  assert.deepEqual(r.placed, []);
  assert.equal(r.built, 0);
  assert.equal(s.stats.counts.candles, 1);
  assert.equal(s.stats.counts.cases, 0, 'with fewer than 30 candles the engines have nothing to propose');
});

test('ingest: a repeated candle is replaced, an older one is refused and recorded', () => {
  const s = new TradingSession({ settings: settingsOf() });
  s.ingest({ asset: ASSET, tf: 60, candle: m1[0] });
  s.ingest({ asset: ASSET, tf: 60, candle: m1[1] });
  const again = s.ingest({ asset: ASSET, tf: 60, candle: m1[1] });
  assert.deepEqual(again, { ok: true, replaced: true });
  assert.equal(s.stats.counts.candles, 2, 'a replaced candle is not a new bar');
  const old = s.ingest({ asset: ASSET, tf: 60, candle: m1[0] });
  assert.equal(old.ok, false);
  assert.ok(old.reason);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].message, /refused/);
});

test('ingest: a timeframe that is not analysed is stored and nothing else happens', () => {
  const s = new TradingSession({ settings: settingsOf() });
  const hour = { epoch: 3600 * 100, open: 100, high: 101, low: 99, close: 100.5 };
  const r = s.ingest({ asset: ASSET, tf: 3600, candle: hour });
  assert.equal(r.ok, true);
  assert.equal(r.stored, true);
  assert.equal(s.mde.series(ASSET, 3600).length, 1);
  assert.equal(s.stats.counts.runs, 0);
});

test('the chain runs and trades, and nothing in the state is broken', () => {
  const { s } = shared();
  const st = s.state();
  assert.ok(st.stats.counts.runs > 400, 'the engines ran on every candle after the warm-up');
  assert.ok(st.stats.counts.built > 0, 'some cases were built');
  assert.ok(st.counters.placed > 0, 'some paper orders were placed');
  assert.ok(st.account.closedCount > 0, 'some paper trades finished');
  assert.equal(st.mode, 'paper');
  assert.equal(st.errors.length, 0, JSON.stringify(st.errors));
  assert.ok(st.engines.length >= 26, 'one row per engine');
  assert.deepEqual(nonFinite(st), [], 'no NaN or Infinity may reach a screen');
  const copy = JSON.parse(JSON.stringify(st));
  assert.equal(copy.account.closedCount, st.account.closedCount, 'the state survives JSON');
  assert.ok(st.account.usable <= 5 + 1e-9, 'the usable balance never passes the $5 cap');
});

test('the analysis engines raised no errors on simulated data', () => {
  const { s } = shared();
  for (const [code, e] of Object.entries(s.stats.engines)) assert.equal(e.errors, 0, `${code}: ${e.lastError}`);
});

test('every approved order carried the risk engine\'s stake, and every stake respects the minimum', () => {
  const { s } = shared();
  const min = 0.35;
  for (const t of s.trader.trades()) {
    assert.ok(t.stake >= min - 1e-9, `${t.id} stake ${t.stake}`);
    assert.ok(t.riskUsd > 0 && t.riskUsd <= 0.0501 + 1e-9, `${t.id} risk ${t.riskUsd}`);
  }
});

test('refusals are logged as episodes, not once per bar', () => {
  const { s } = shared();
  const refused = s.stats.counts.refused;
  const runs = s.stats.counts.runs;
  assert.ok(refused < runs, `${refused} refusals over ${runs} runs is one per bar or worse`);
  const ids = s.verdicts.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'verdict ids are unique');
});

test('determinism, and the future cannot change the past', () => {
  const { snaps } = shared();
  // The same first 350 candles, then a different future.
  const tail = simCandles(N, 99);
  const other = m1.slice(0, 350).concat(tail.slice(350).map((c, i) => ({ ...c, epoch: m1[350 + i].epoch })));
  const s = new TradingSession({ settings: settingsOf() });
  let snap = null;
  for (let i = 0; i < N; i += 1) {
    feedOne(s, other[i]);
    if (i === 349) snap = snapshotOf(s);
  }
  assert.equal(snap, snaps.at350, 'everything up to candle 350 is identical whatever came after');
  assert.notEqual(snapshotOf(s), snapshotOf(shared().s), 'the different future did change the later result');
});

test('the emergency stop places nothing, and the halt is reported once, not on every bar', () => {
  const s = new TradingSession({ settings: settingsOf() });
  s.setEmergencyStop(true, 'test');
  const before = s.state().emergencyStop;
  assert.equal(before.on ?? before, true);
  feed(s, m1, 0, 300);
  const st = s.state();
  assert.equal(st.counters.placed, 0);
  assert.equal(st.account.closedCount, 0);
  assert.ok((st.stats.haltBars.find((h) => h.code === 'emergency_stop') || { count: 0 }).count > 5, 'the halt lasted many bars');
  const notTrading = s.verdicts.filter((v) => v.source === 'account');
  assert.ok(notTrading.length >= 1);
  assert.ok(notTrading.length * 5 < st.stats.haltBars.reduce((a, h) => a + h.count, 0), 'one entry per halt, not one per bar');
  assert.match(notTrading[0].summary, /^Not trading: /);
  // Turning it off lets trading start again.
  s.setEmergencyStop(false);
  feed(s, m1, 300, 500);
  assert.ok(s.state().counters.placed > 0, 'orders resume after the stop is cleared');
});

test('settings: locked and non-learnable keys cannot be changed by the learning route', () => {
  const s = new TradingSession({ settings: settingsOf(), learning: false });
  let saved = null;
  s.onSettings = (v) => { saved = v; };
  const locked = s.applySettingsChanges({ 'risk.usableCapUsd': 50 });
  assert.equal(locked.ok, false);
  assert.equal(s.settings.risk.usableCapUsd, 5);
  const notLearnable = s.applySettingsChanges({ 'cost.spreadPrice': 0.5 });
  assert.equal(notLearnable.ok, false);
  assert.match(notLearnable.errors[0], /learning loop/);
  assert.equal(saved, null, 'a refused change is never saved');
  const bad = s.applySettingsChanges({ 'ble.rr': 'banana' });
  assert.equal(bad.ok, false);
  const good = s.applySettingsChanges({ 'ble.rr': 3, 'tdc.minFamilies': 3 });
  assert.equal(good.ok, true);
  assert.equal(s.settings.ble.rr, 3);
  assert.equal(s.settings.tdc.minFamilies, 3);
  assert.equal(saved.ble.rr, 3, 'an accepted change is handed to the saver');
});

test('settings: the person may change a non-learnable key, but the $5 cap stays locked', () => {
  const s = new TradingSession({ settings: settingsOf(), learning: false });
  const r = s.applySettingsChanges({ 'cost.spreadPrice': 0.05 }, { learnedOnly: false });
  assert.equal(r.ok, true);
  assert.equal(s.settings.cost.spreadPrice, 0.05);
  const cap = s.applySettingsChanges({ 'risk.usableCapUsd': 20 }, { learnedOnly: false });
  assert.equal(cap.ok, false, 'the cap has min = max = 5, so no value but 5 is accepted by anyone');
  assert.equal(s.settings.risk.usableCapUsd, 5);
});

test('settings: all or nothing', () => {
  const s = new TradingSession({ settings: settingsOf(), learning: false });
  const r = s.applySettingsChanges({ 'ble.rr': 3, 'cost.spreadPrice': 1 });
  assert.equal(r.ok, false);
  assert.equal(s.settings.ble.rr, 2, 'the valid half was not applied either');
});

test('saving: export, JSON, import gives the same account and the same learning rows', () => {
  const { s } = shared();
  const blob = JSON.parse(JSON.stringify(s.exportState()));
  const t = new TradingSession({ settings: settingsOf() });
  const res = t.importState(blob);
  assert.equal(res.ok, true);
  assert.equal(res.trader, true);
  assert.equal(res.learning, true);
  assert.equal(t.trader.trades().length, s.trader.trades().length);
  assert.equal(t.trader.balance, s.trader.balance);
  assert.equal(t.learning.records().length, s.learning.records().length);
  assert.equal(t.stats.counts.built, s.stats.counts.built);
  assert.equal(t.verdicts.length, s.verdicts.length);
});

test('saving: a wrong version or junk is refused and changes nothing', () => {
  const t = new TradingSession({ settings: settingsOf() });
  const before = t.trader.balance;
  assert.equal(t.importState(null).ok, false);
  assert.equal(t.importState({ version: 99, trader: {} }).ok, false);
  assert.equal(t.importState('hello').ok, false);
  assert.equal(t.trader.balance, before);
});

test('strategy signals: the engines are skipped and the signal goes through the same risk gate', () => {
  const s = new TradingSession({ settings: settingsOf(), learning: false, analysis: false, audit: null });
  const candles = simCandles(90, 5);
  let last = null;
  for (let i = 0; i < 80; i += 1) last = s.ingest({ asset: ASSET, tf: 60, candle: candles[i], signals: [] });
  assert.equal(s.stats.counts.runs, 0, 'no engine ran');
  const atr = s.lastMarket.get(`${ASSET}|60`).atr;
  assert.ok(atr > 0);
  const close = candles[79].close;
  const sig = { side: 'buy', entry: close, stop: close - 0.9 * atr, target: close + 1.8 * atr, reason: 'test' };
  const r = s.ingest({ asset: ASSET, tf: 60, candle: candles[80], signals: [sig], strategyName: 'unit' });
  assert.equal(r.ok, true);
  const v = s.verdicts[s.verdicts.length - 1];
  assert.ok(v, 'a verdict was written');
  assert.equal(v.source, 'strategy');
  assert.ok(last.ok);
  if (v.ok) {
    assert.equal(r.placed.length, 1);
    const p = s.trader.state(s.nowMs).pendings[0];
    assert.equal(p.engine, 'SB');
    assert.equal(p.strategy, 'unit');
  } else {
    assert.ok(v.reasons.length > 0, 'a refusal always says why');
  }
});

test('strategy signals: a bad signal never becomes an order', () => {
  const s = new TradingSession({ settings: settingsOf(), learning: false, analysis: false, audit: null });
  const candles = simCandles(90, 5);
  for (let i = 0; i < 80; i += 1) s.ingest({ asset: ASSET, tf: 60, candle: candles[i], signals: [] });
  const close = candles[79].close;
  // Stop on the wrong side of the entry for a buy: the risk engine must refuse it.
  const bad = { side: 'buy', entry: close, stop: close + 2, target: close + 4, reason: 'wrong side' };
  const r = s.ingest({ asset: ASSET, tf: 60, candle: candles[80], signals: [bad], strategyName: 'bad' });
  assert.equal(r.placed.length, 0);
  assert.equal(s.trader.state(s.nowMs).pendings.length, 0);
});

test('a role that may not trade places nothing', () => {
  for (const roleId of ['observer', 'trainer']) {
    const s = new TradingSession({ settings: { data: { timeframes: TFS }, engine: { tradeTimeframes: TFS, roleId } } });
    const bad = feed(s, m1, 0, 200);
    assert.equal(bad, 0);
    assert.equal(s.state().counters.placed, 0, roleId);
  }
});

test('the learning loop counted every finished trade once', () => {
  const { s } = shared();
  const rows = s.learning.records();
  const closedReal = rows.filter((r) => r.kind === 'real' && r.status === 'closed');
  assert.equal(closedReal.length, s.state().account.closedCount);
  assert.equal(new Set(rows.map((r) => r.caseId)).size, rows.length, 'one row per case');
});
