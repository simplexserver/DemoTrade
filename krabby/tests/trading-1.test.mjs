import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../js/core/schema.js';
import { Board } from '../js/engine/board.js';
import { newMsg, finalizeAll } from '../js/engine/common.js';
import { evaluateCase, isApproved, consumeApproval, ENGINE as RME } from '../js/engine/risk.js';
import { buildCases, caseSnapshot, ENGINE as TDC } from '../js/engine/coordinator.js';
import { ENGINE as AI } from '../js/engine/ai.js';
import { utcDayKey, dailyState } from '../js/trading/daily.js';
import { multiplierLimits, compounderNext } from '../js/trading/sizing.js';
import * as sizing from '../js/trading/sizing.js';
import { roleOf, can, allowedWrite } from '../js/trading/roles.js';

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const settingsWith = (over = {}) => normalise(over);
const S = settingsWith();

const caseFor = (asset, entry, stop, extra = {}) => ({
  id: `TDC:${asset}:60:${NOW}:${NOW}:0`, asset, tf: 60, evidence: { rank: 80, cls: 'strong' }, measurements: {},
  plan: { side: 'buy', entry, stop }, ...extra,
});
const acct = (over = {}) => ({
  balance: 1000, peakBalance: 1000, dayStartUsable: 5, realizedTodayUsd: 0, floatingUsd: 0, openCount: 0, pendingCount: 0,
  entriesThisHour: 0, emergencyStop: false, setupStatus: () => null, ...over,
});
const mkt = (over = {}) => ({ health: { ok: true, status: 'ok', reason: '' }, atr: 1, spreadPrice: 0.02, ...over });
const run = (o = {}) => evaluateCase({
  caseMsg: caseFor('R_100', 1000, 999), settings: S, account: acct(), market: mkt(), reducedNow: false, evidenceRank: 80, nowMs: NOW, ...o,
});
const codes = (r) => r.reasons.map((x) => x.code);

test('engine constants', () => {
  assert.deepEqual({ code: RME.code, stage: RME.stage }, { code: 'RME', stage: 2 });
  assert.equal(TDC.code, 'TDC');
  assert.equal(AI.status, 'off');
  assert.deepEqual(AI.run(), []);
});

test('hand check: R_100 stake 0.5, riskUsd 0.05, approved', () => {
  const r = run();
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.riskUsd - 0.05) < 1e-12);
  assert.ok(Math.abs(r.stake - 0.5) < 1e-12);
  assert.equal(r.multiplier, 100);
  assert.ok(isApproved(r.approval));
  assert.ok(Object.isFrozen(r.approval));
  assert.equal(r.approval.caseId, r.caseId);
});

test('hand check: XAU stake 0.2 is below the minimum and refused', () => {
  const r = run({ caseMsg: caseFor('frxXAUUSD', 2000, 1995), market: mkt({ atr: 5, spreadPrice: 0.1 }) });
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.stake - 0.2) < 1e-12);
  assert.deepEqual(codes(r), ['stake_below_min']);
  assert.equal(r.approval, null);
});

test('reduced mode halves riskUsd', () => {
  const r = run({ reducedNow: true });
  assert.ok(Math.abs(r.riskUsd - 0.025) < 1e-12);
  assert.ok(Math.abs(r.stake - 0.25) < 1e-12);
  assert.ok(codes(r).includes('stake_below_min'));
});

test('multiplier override per market', () => {
  const s = settingsWith({ risk: { multiplierOverrides: { R_100: 200 } } });
  const r = run({ settings: s });
  assert.equal(r.multiplier, 200);
  assert.ok(Math.abs(r.stake - 0.25) < 1e-12);
});

test('stake above max is capped down with a note, not rejected', () => {
  const s = settingsWith({ risk: { maxStakeUsd: 1 } });
  const r = run({ settings: s, caseMsg: caseFor('R_100', 1000, 999.9) });
  assert.equal(r.ok, true);
  assert.equal(r.stake, 1);
  assert.ok(r.notes.includes('stake_capped'));
  assert.ok(r.riskUsd <= 0.05 + 1e-12);
});

test('approval is single use and a copy is not an approval', () => {
  const r = run();
  assert.equal(isApproved({ ...r.approval }), false);
  assert.equal(consumeApproval({ ...r.approval }), false);
  assert.equal(consumeApproval(r.approval), true);
  assert.equal(consumeApproval(r.approval), false);
  assert.equal(isApproved(r.approval), false);
});

test('reason: emergency_stop', () => assert.ok(codes(run({ account: acct({ emergencyStop: true }) })).includes('emergency_stop')));

test('reason: data_unreliable', () => {
  assert.ok(codes(run({ market: mkt({ health: { ok: false, reason: 'stale' } }) })).includes('data_unreliable'));
  assert.ok(codes(run({ market: { atr: 1, spreadPrice: 0.02 } })).includes('data_unreliable'));
});

test('reason: news_window', () => {
  const s = settingsWith({ risk: { newsEvents: [{ at: NOW + 5 * 60000, title: 'NFP' }] } });
  assert.ok(codes(run({ settings: s })).includes('news_window'));
  const far = settingsWith({ risk: { newsEvents: [{ at: NOW + 60 * 60000, title: 'NFP' }] } });
  assert.ok(!codes(run({ settings: far })).includes('news_window'));
});

test('reason: daily_loss_stop, and noLimitDailyStop only for manual', () => {
  const a = acct({ realizedTodayUsd: -0.2, floatingUsd: -0.05 });
  assert.ok(codes(run({ account: a })).includes('daily_loss_stop'));
  assert.ok(!codes(run({ account: acct({ realizedTodayUsd: -0.2 }) })).includes('daily_loss_stop'));
  const s = settingsWith({ risk: { noLimitDailyStop: true } });
  assert.ok(codes(run({ settings: s, account: a })).includes('daily_loss_stop'));
  const manual = caseFor('R_100', 1000, 999, { manual: true });
  assert.ok(!codes(run({ settings: s, account: a, caseMsg: manual })).includes('daily_loss_stop'));
});

test('reason: drawdown_stop', () => {
  assert.ok(codes(run({ account: acct({ balance: 850, peakBalance: 1000 }) })).includes('drawdown_stop'));
  assert.ok(!codes(run({ account: acct({ balance: 851, peakBalance: 1000 }) })).includes('drawdown_stop'));
});

test('reason: max_open and max_pending', () => {
  assert.ok(codes(run({ account: acct({ openCount: 3 }) })).includes('max_open'));
  assert.ok(codes(run({ account: acct({ pendingCount: 5 }) })).includes('max_pending'));
  assert.deepEqual(codes(run({ account: acct({ openCount: 2, pendingCount: 4 }) })), []);
});

test('reason: duplicate and cooldown', () => {
  assert.ok(codes(run({ account: acct({ setupStatus: () => 'duplicate' }) })).includes('duplicate'));
  assert.ok(codes(run({ account: acct({ setupStatus: () => 'cooldown' }) })).includes('cooldown'));
  let args = null;
  run({ account: acct({ setupStatus: (...a) => { args = a; return null; } }) });
  assert.equal(args[1], 'R_100');
  assert.equal(args[2], 60);
  assert.equal(args[3], 1);
  assert.equal(args[4], NOW);
  assert.ok(codes(run({ account: acct({ setupStatus: undefined }) })).includes('duplicate'));
});

test('reason: reduced_hourly_limit and reduced_weak_evidence', () => {
  const r = run({ reducedNow: true, account: acct({ entriesThisHour: 1 }), evidenceRank: 50 });
  assert.ok(codes(r).includes('reduced_hourly_limit'));
  assert.ok(codes(r).includes('reduced_weak_evidence'));
  assert.ok(!codes(run({ account: acct({ entriesThisHour: 5 }), evidenceRank: 10 })).some((c) => c.startsWith('reduced_')));
});

test('reason: spread_too_wide', () => {
  assert.ok(codes(run({ market: mkt({ spreadPrice: 0.25 }) })).includes('spread_too_wide'));
  assert.ok(codes(run({ market: mkt({ atr: NaN }) })).includes('spread_too_wide'));
});

test('reason: stake_below_min is never rounded up', () => {
  const r = run({ account: acct({ balance: 1 }), caseMsg: caseFor('R_100', 1000, 999.0) });
  assert.ok(Math.abs(r.stake - 0.01 * 1000 / 100) < 1e-9 || r.stake < 0.35);
  const tiny = run({ caseMsg: caseFor('R_100', 1000, 990) });
  assert.ok(codes(tiny).includes('stake_below_min'));
  assert.ok(tiny.stake < 0.35);
});

test('reason: invalid_plan fails closed', () => {
  const r = run({ caseMsg: { id: 'x', asset: 'R_100', tf: 60, plan: null } });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('invalid_plan'));
  assert.equal(run({ caseMsg: caseFor('R_100', 1000, 1000) }).ok, false);
});

test('multiple failures all listed in order', () => {
  const r = run({ account: acct({ emergencyStop: true, openCount: 9 }), market: mkt({ health: { ok: false } }) });
  assert.deepEqual(codes(r), ['emergency_stop', 'data_unreliable', 'max_open']);
});

// ---------- coordinator ----------
const planMsg = (checks, over = {}) => {
  const m = newMsg({
    topic: 'entries.buy', type: 'buy', direction: 'up', price: 100, atMs: NOW,
    measurements: { checks, checksPassed: 0, opposing: [], rr: 2, stopAtr: 1, riskPrice: 1, position: 0.2 },
    plan: { side: 'buy', entry: 100, stop: 99, target: 102, invalidation: 98.5, zone: { lo: 99, hi: 100 }, riskPrice: 1, objectiveR: 2, rr: 2, stopAtr: 1, orderType: 'limit' },
    ...over,
  });
  return finalizeAll({ code: 'BLE', asset: 'R_100', tf: 60, runMs: NOW, inputs: 'abcd1234' }, [m])[0];
};
const three = { approachingSupport: true, structureOk: true, sweepSeen: true, discountZone: false, fvgObOk: false };
const two = { approachingSupport: true, structureOk: true, sweepSeen: false, discountZone: false, fvgObOk: false };
const args = (plans, extra = {}) => ({ plans, board: new Board(), settings: S, nowMs: NOW, asset: 'R_100', tf: 60, ...extra });

test('coordinator: three families build, two drop', () => {
  const r = buildCases(args([planMsg(three), planMsg(two, { atMs: NOW })]));
  assert.equal(r.cases.length, 2);
  assert.equal(r.cases[0].type, 'build');
  assert.equal(r.cases[1].type, 'drop');
  assert.equal(r.built.length, 1);
  assert.equal(r.drops.length, 1);
  assert.deepEqual(r.cases[0].measurements.agree, ['levels', 'structure', 'liquidity']);
  assert.equal(r.cases[0].measurements.agreeCount, 3);
  assert.equal(r.cases[0].topic, 'cases');
  assert.equal(r.cases[0].engine, 'TDC');
  assert.ok(r.cases[1].measurements.reasons.length > 0);
  assert.ok(r.cases[0].plan && r.cases[0].plan.entry === 100);
  // The built case is accepted by the risk engine as the case message.
  assert.equal(typeof r.cases[0].id, 'string');
});

test('coordinator: no plan, no case; stale plans ignored', () => {
  assert.equal(buildCases(args([])).cases.length, 0);
  assert.equal(buildCases(args([planMsg(three, { atMs: NOW - 60000 })])).cases.length, 0);
});

test('coordinator: strict mode drops when estimate.passes is false', () => {
  const strict = settingsWith({ tdc: { edgeMode: 'strict' } });
  const est = (passes) => () => ({ n: 120, winRate: 0.5, lo: 0.4, hi: 0.6, breakEven: 0.45, passes });
  let seen = null;
  const spy = (q) => { seen = q; return est(false)(); };
  const no = buildCases(args([planMsg(three)], { settings: strict, estimateFor: spy }));
  assert.equal(no.cases[0].type, 'drop');
  assert.equal(seen.familySig, 'levels+liquidity+structure');
  assert.equal(seen.side, 'buy');
  assert.equal(buildCases(args([planMsg(three)], { settings: strict })).cases[0].type, 'drop');
  assert.equal(buildCases(args([planMsg(three)], { settings: strict, estimateFor: est(true) })).cases[0].type, 'build');
  assert.equal(buildCases(args([planMsg(three)], { estimateFor: est(false) })).cases[0].type, 'build');
});

test('coordinator: strong opposing reversal blocks, invalidation crossed drops', () => {
  const board = new Board();
  const rev = finalizeAll({ code: 'SRD', asset: 'R_100', tf: 60, runMs: NOW, inputs: 'x' }, [newMsg({
    topic: 'reversal', type: 'bearish_reversal', direction: 'down', atMs: NOW, evidence: { rank: 80, cls: 'strong' },
  })]);
  board.publish(rev);
  assert.equal(buildCases(args([planMsg(three)], { board })).cases[0].type, 'drop');
  assert.equal(buildCases(args([planMsg(three)], { lastClose: 98 })).cases[0].type, 'drop');
  assert.equal(buildCases(args([planMsg(three)], { lastClose: 99.5 })).cases[0].type, 'build');
});

test('coordinator: buildCases twice gives identical JSON', () => {
  const plans = [planMsg(three), planMsg(two)];
  const a = JSON.stringify(buildCases(args(plans)));
  const b = JSON.stringify(buildCases(args(plans)));
  assert.equal(a, b);
});

test('coordinator: a built case feeds the risk engine', () => {
  const c = buildCases(args([planMsg(three)])).built[0];
  const r = evaluateCase({ caseMsg: c, settings: S, account: acct(), market: mkt(), reducedNow: false, evidenceRank: c.evidence.rank, nowMs: NOW });
  assert.equal(r.caseId, c.id);
  assert.ok(codes(r).every((x) => x === 'stake_below_min'));
});

test('caseSnapshot reads the board', () => {
  const board = new Board();
  const c = buildCases(args([planMsg(three)], { board })).built[0];
  board.publish(finalizeAll({ code: 'QAE', asset: 'R_100', tf: 60, runMs: NOW, inputs: 'x' }, [newMsg({
    topic: 'measures', type: 'measures', atMs: NOW, measurements: { planId: c.measurements.planId, volClass: 'normal', atrPct: 55 },
  })]));
  board.publish(finalizeAll({ code: 'MSE', asset: 'R_100', tf: 240, runMs: NOW, inputs: 'x' }, [newMsg({
    topic: 'structure', type: 'trend', direction: 'up', atMs: NOW, measurements: { trend: 'bullish' },
  })]));
  board.publish(finalizeAll({ code: 'BDE', asset: 'R_100', tf: 60, runMs: NOW, inputs: 'x' }, [newMsg({
    topic: 'breakouts', type: 'bullish', direction: 'up', atMs: NOW, measurements: { verdict: 'pending' },
  })]));
  const snap = caseSnapshot(c, board, S, NOW);
  assert.equal(snap.side, 'buy');
  assert.equal(snap.families.length, 4);
  assert.equal(snap.agreeCount, 3);
  assert.equal(snap.volClass, 'normal');
  assert.equal(snap.atrPct, 55);
  assert.equal(snap.hourUtc, 12);
  assert.equal(snap.htfAgrees, true);
  assert.equal(snap.breakoutPresent, true);
  assert.equal(snap.recentStreak, 0);
  assert.ok(Math.abs(snap.zoneDepth - 0.8) < 1e-12);
  const bare = caseSnapshot(c, new Board(), S, NOW);
  assert.equal(bare.volClass, null);
  assert.equal(bare.htfAgrees, null);
  assert.equal(bare.breakoutPresent, false);
});

// ---------- daily, sizing, roles ----------
test('daily: utcDayKey with reset hour', () => {
  assert.equal(utcDayKey(NOW), '2026-01-05');
  assert.equal(utcDayKey(Date.UTC(2026, 0, 5, 3, 0, 0), 5), '2026-01-04');
  assert.equal(utcDayKey(Date.UTC(2026, 0, 5, 5, 0, 0), 5), '2026-01-05');
});

test('daily: dailyState never returns a stop', () => {
  const cases = [
    { realizedTodayUsd: -100, floatingUsd: -100, targetUsd: 10 },
    { realizedTodayUsd: 50, floatingUsd: 0, targetUsd: 10 },
    { realizedTodayUsd: 50, floatingUsd: 0, targetUsd: 10, reducedOnTarget: false },
    { realizedTodayUsd: 5, floatingUsd: 5, targetUsd: 10, includeFloating: false },
    {},
  ];
  for (const c of cases) {
    const d = dailyState(c);
    assert.ok(['normal', 'reduced'].includes(d.mode));
    assert.ok(!('stop' in d) && !('halted' in d));
  }
  assert.equal(dailyState(cases[1]).mode, 'reduced');
  assert.equal(dailyState(cases[0]).mode, 'normal');
  assert.equal(dailyState(cases[2]).mode, 'normal');
  assert.equal(dailyState(cases[2]).targetReached, true);
  assert.equal(dailyState(cases[3]).pnlUsd, 5);
  assert.equal(dailyState(cases[4]).targetReached, false);
});

test('sizing: only multiplierLimits and compounderNext remain', () => {
  assert.deepEqual(Object.keys(sizing).sort(), ['compounderNext', 'multiplierLimits']);
  assert.deepEqual(multiplierLimits(2, { slPct: 50, tpPct: 0 }), { sl: 1, tp: null });
  assert.equal(compounderNext(1, 'loss'), 0.35);
});

test('roles: role comes from the settings object', () => {
  assert.equal(roleOf(settingsWith({ engine: { roleId: 'trainer' } })).id, 'trainer');
  assert.equal(roleOf({}).id, 'observer');
  assert.equal(can('trade.place', S), true);
  assert.equal(can('trade.place', settingsWith({ engine: { roleId: 'trainer' } })), false);
  assert.equal(allowedWrite('engine.roleId', 'operator', S).ok, false);
  assert.equal(allowedWrite('risk.usableCapUsd', 50, S).ok, false);
  assert.equal(allowedWrite('risk.maxOpen.on', true, S).ok, true);
  assert.equal(allowedWrite('risk.maxOpen.on', true, settingsWith({ engine: { roleId: 'observer' } })).ok, false);
});
