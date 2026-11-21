import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../js/core/schema.js';
import { AuditLog } from '../js/engine/board.js';
import { evaluateCase, isApproved } from '../js/engine/risk.js';
import { issueApproval } from '../js/engine/approval.js';
import { PaperTrader } from '../js/trading/trader.js';
import { performanceReport, metricsOf, closedSorted, drawdownAndCurve, streaks, consistencyOf } from '../js/trading/analytics.js';
import { wilson } from '../js/core/util.js';

const T0 = 1767571200; // 2026-01-05T00:00:00Z
const ASSET = 'R_100';
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not close to ${b}`);
const c = (i, o, h, l, cl, tf = 60) => ({ epoch: T0 + i * tf, open: o, high: h, low: l, close: cl });
const nowAt = (i, tf = 60) => (T0 + (i + 1) * tf) * 1000;

function make(over = {}) {
  const settings = normalise(over);
  const audit = new AuditLog();
  return { t: new PaperTrader({ settings, audit }), settings, audit };
}

// Places an order the real way: the risk engine approves it, then the trader takes the approval.
let caseSeq = 0;
function order(ctx, { side = 'buy', entry = 1000, stop = 999, asset = ASSET, tf = 60, at = 0, expiryBars, features, atr = 1, familySig = 'levels+zones' } = {}) {
  caseSeq += 1;
  const caseId = `TDC:${asset}:${tf}:${nowAt(at, tf)}:${nowAt(at, tf)}:${caseSeq}`;
  const plan = { side, entry, stop, target: side === 'buy' ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry), invalidation: stop, zone: { lo: Math.min(entry, stop), hi: Math.max(entry, stop) }, riskPrice: Math.abs(entry - stop), objectiveR: 2, rr: 2, stopAtr: 1, orderType: 'limit' };
  const caseMsg = { id: caseId, asset, tf, evidence: { rank: 80, cls: 'strong' }, measurements: {}, plan };
  const verdict = evaluateCase({
    caseMsg, settings: ctx.t.settings, account: ctx.t.accountFor(nowAt(at, tf)), market: { health: { ok: true, status: 'ok', reason: '' }, atr, spreadPrice: 0.02 },
    reducedNow: false, evidenceRank: 80, nowMs: nowAt(at, tf),
  });
  assert.ok(verdict.ok, `case not approved: ${JSON.stringify(verdict.reasons)}`);
  const pending = ctx.t.place(verdict.approval, {
    caseId, planId: caseId, asset, tf, side, entry, stop, target: plan.target, invalidation: stop, zone: plan.zone,
    objectiveR: 2, expiryBars, features, familySig,
  }, nowAt(at, tf));
  return { verdict, pending };
}

const feed = (ctx, i, o, h, l, cl, extra = {}) => ctx.t.onCandle({ asset: ASSET, tf: 60, candle: c(i, o, h, l, cl), nowMs: nowAt(i), ...extra });

// ---------------------------------------------------------------- approvals

test('place: needs a real approval for the same case, uses it once, and takes the stake from it', () => {
  const ctx = make();
  const stakeFree = (a) => ctx.t.place(a, { caseId: 'x', asset: ASSET, tf: 60, side: 'buy', entry: 1000, stop: 999 }, nowAt(0));
  assert.throws(() => stakeFree(null), { code: 'NOT_APPROVED' });
  assert.throws(() => stakeFree({ caseId: 'x', stake: 99 }), { code: 'NOT_APPROVED' });
  const forged = issueApproval({ id: 'a', caseId: 'x', asset: ASSET, tf: 60, side: 'buy', stake: 1, riskUsd: 1, multiplier: 100 });
  assert.ok(isApproved(forged), 'issueApproval is the only door, and the risk engine uses it');
  // A different case id is refused and does not use the approval up.
  assert.throws(() => ctx.t.place(forged, { caseId: 'other', asset: ASSET, tf: 60, side: 'buy', entry: 1000, stop: 999 }, nowAt(0)), { code: 'NOT_APPROVED' });
  assert.ok(isApproved(forged));
  assert.throws(() => ctx.t.place(forged, { caseId: 'x', asset: ASSET, tf: 60, side: 'sell', entry: 1000, stop: 1001 }, nowAt(0)), { code: 'APPROVAL_MISMATCH' });

  const { verdict, pending } = order(ctx);
  assert.equal(pending.stake, verdict.stake, 'stake comes from the approval');
  assert.equal(pending.riskUsd, verdict.riskUsd);
  assert.equal(isApproved(verdict.approval), false, 'single use');
  assert.throws(() => ctx.t.place(verdict.approval, { caseId: pending.caseId, asset: ASSET, tf: 60, side: 'buy', entry: 1000, stop: 999 }, nowAt(0)), { code: 'NOT_APPROVED' });
  approx(pending.stake, 0.5);
  approx(pending.riskUsd, 0.05);
});

test('place: the same case cannot be placed twice', () => {
  const ctx = make();
  const { pending } = order(ctx);
  const again = evaluateCase({
    caseMsg: { id: pending.caseId, asset: ASSET, tf: 60, evidence: { rank: 80, cls: 'strong' }, measurements: {}, plan: { side: 'buy', entry: 1000, stop: 999 } },
    settings: ctx.t.settings, account: { ...ctx.t.accountFor(nowAt(0)), hasCase: () => false, setupStatus: () => null },
    market: { health: { ok: true }, atr: 1, spreadPrice: 0.02 }, reducedNow: false, evidenceRank: 80, nowMs: nowAt(0),
  });
  assert.ok(again.ok);
  assert.throws(() => ctx.t.place(again.approval, { caseId: pending.caseId, asset: ASSET, tf: 60, side: 'buy', entry: 1000, stop: 999 }, nowAt(0)), { code: 'DUPLICATE_CASE' });
});

// ---------------------------------------------------------------- fills

test('buy limit: waits one candle, fills at the entry plus half the spread when the low touches it', () => {
  const ctx = make();
  order(ctx);
  // The order never fills on the candle it was placed on: it only sees later candles.
  const r1 = feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  assert.equal(r1.filled.length, 1);
  const pos = ctx.t.state().positions[0];
  approx(pos.entry, 1000.01);
  approx(pos.stop, 999);
  assert.equal(pos.trailingArmed, false);
  assert.equal(ctx.t.state().account.pendingCount, 0);
});

test('buy limit: a candle that opens at or below the entry fills at the open', () => {
  const ctx = make();
  order(ctx);
  feed(ctx, 1, 999.6, 1000.4, 999.4, 1000.1);
  approx(ctx.t.state().positions[0].entry, 999.6 + 0.01);
});

test('buy limit: a candle that stays above the entry does not fill', () => {
  const ctx = make();
  order(ctx);
  const r = feed(ctx, 1, 1002, 1003, 1000.5, 1001);
  assert.equal(r.filled.length, 0);
  assert.equal(ctx.t.state().account.pendingCount, 1);
});

test('sell limit: the mirror. Fills at the entry minus half the spread, or at the open when it gaps above', () => {
  const a = make();
  order(a, { side: 'sell', entry: 1000, stop: 1001 });
  feed(a, 1, 999.5, 1000.3, 999, 999.4);
  approx(a.t.state().positions[0].entry, 999.99);
  const b = make();
  order(b, { side: 'sell', entry: 1000, stop: 1001 });
  feed(b, 1, 1000.6, 1000.9, 999.8, 1000.2);
  approx(b.t.state().positions[0].entry, 1000.6 - 0.01);
});

test('an old or repeated candle is ignored, so an order cannot fill twice', () => {
  const ctx = make();
  order(ctx);
  assert.equal(feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6).filled.length, 1);
  const again = feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  assert.deepEqual(again, { filled: [], closed: [], cancelled: [] });
  assert.equal(ctx.t.counters.filled, 1);
  const older = feed(ctx, 0, 1000, 1001, 900, 950);
  assert.deepEqual(older.closed, []);
});

// ---------------------------------------------------------------- stops and costs

test('stop: exit at the stop minus half the spread. P&L is the hand-worked figure', () => {
  const ctx = make();
  order(ctx);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6); // fill at 1000.01
  const r = feed(ctx, 2, 1000.2, 1000.4, 998.8, 999.1);
  assert.equal(r.closed.length, 1);
  const t = ctx.t.trades()[0];
  assert.equal(t.exitReason, 'stop');
  approx(t.exitPrice, 998.99);
  const gross = 0.5 * 100 * (998.99 - 1000.01) / 1000.01; // stake x multiplier x move / entry
  approx(t.grossUsd, gross);
  approx(t.netUsd, gross);
  approx(t.rMultiple, gross / 0.05);
  assert.equal(t.result, 'loss');
  approx(ctx.t.balance, 1000 + gross);
  approx(ctx.t.state().account.realizedTodayUsd, gross);
});

test('stop: commission and slippage are charged and counted in the cost', () => {
  const ctx = make({ cost: { spreadPrice: 0.02, slippagePrice: 0.05, commissionPct: 0.1 } });
  order(ctx);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  feed(ctx, 2, 1000.2, 1000.4, 998.8, 999.1);
  const t = ctx.t.trades()[0];
  const exit = 999 - 0.01 - 0.05;
  const gross = 0.5 * 100 * (exit - 1000.01) / 1000.01;
  const commission = 0.1 / 100 * 0.5 * 2;
  approx(t.exitPrice, exit);
  approx(t.commissionUsd, commission);
  approx(t.netUsd, gross - commission);
  approx(t.costUsd, ((0.01 + 0.01 + 0.05) * 0.5 * 100) / 1000.01 + commission);
});

test('gap through the stop fills at the open by default, or at the stop when asked', () => {
  const open = make();
  order(open);
  feed(open, 1, 1000.5, 1001, 999.8, 1000.6);
  feed(open, 2, 997, 998, 996, 997.5);
  approx(open.t.trades()[0].exitPrice, 997 - 0.01);
  const stop = make({ cost: { gapFillMode: 'stop' } });
  order(stop);
  feed(stop, 1, 1000.5, 1001, 999.8, 1000.6);
  feed(stop, 2, 997, 998, 996, 997.5);
  approx(stop.t.trades()[0].exitPrice, 999 - 0.01);
});

test('the loss never exceeds the stake, even on a huge gap', () => {
  const ctx = make();
  order(ctx);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  feed(ctx, 2, 500, 501, 499, 500);
  const t = ctx.t.trades()[0];
  approx(t.netUsd, -0.5);
  approx(t.rMultiple, -10);
  assert.ok(t.grossUsd < -20, 'gross is far below the cap; the cap is what limits the loss');
});

test('a wide candle that fills the order and takes the stop in the same bar is a loss, not a cancel', () => {
  const ctx = make();
  order(ctx);
  const r = feed(ctx, 1, 1000.5, 1001, 998.5, 998.8);
  assert.equal(r.filled.length, 1);
  assert.equal(r.closed.length, 1);
  const t = ctx.t.trades()[0];
  assert.equal(t.exitReason, 'stop');
  assert.equal(t.result, 'loss');
  assert.equal(ctx.t.counters.invalidated, 0);
});

test('a candle that reaches the entry and closes below the stop is a fill and a loss, not an invalidation', () => {
  const ctx = make();
  order(ctx);
  const r = feed(ctx, 1, 1000.4, 1000.6, 998, 998.2);
  assert.equal(r.filled.length, 1);
  assert.equal(ctx.t.trades()[0].result, 'loss');
  assert.equal(ctx.t.counters.cancelled + ctx.t.counters.invalidated, 0);
});

// ---------------------------------------------------------------- profit management

test('trailing: arms at the net objective on the close, the new stop starts next candle, then it trails and exits', () => {
  const ctx = make();
  order(ctx);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6); // fill 1000.01
  // Arms at the close: net at 1002.09 is about 0.104 and the objective is 2 x 0.05 = 0.10.
  const r2 = feed(ctx, 2, 1000.6, 1002.2, 1000.4, 1002.1);
  assert.equal(r2.closed.length, 0, 'the low 1000.4 is below the new stop 1001.2, but the new stop only counts from the next candle');
  const p = ctx.t.state().positions[0];
  assert.equal(p.trailingArmed, true);
  approx(p.stop, 1002.2 - 1);
  approx(p.bestPrice, 1002.2);
  // The stop only moves up.
  feed(ctx, 3, 1002.1, 1002.6, 1001.9, 1002.4);
  const p3 = ctx.t.state().positions[0];
  approx(p3.stop, 1002.6 - 1);
  feed(ctx, 4, 1002.4, 1002.5, 1002.0, 1002.1);
  approx(ctx.t.state().positions[0].stop, 1001.6, 1e-9);
  const r5 = feed(ctx, 5, 1002.0, 1002.1, 1001.3, 1001.5);
  assert.equal(r5.closed.length, 1);
  const t = ctx.t.trades()[0];
  assert.equal(t.exitReason, 'trail');
  approx(t.exitPrice, 1001.6 - 0.01);
  const gross = 0.5 * 100 * (1001.6 - 0.01 - 1000.01) / 1000.01;
  approx(t.netUsd, gross);
  assert.equal(t.result, 'win');
  approx(t.maeR, 1000.01 - 999.8); // the fill candle dipped to 999.8: adverse excursion counts in full
  approx(t.mfeR, 1002.6 - 1000.01); // the best high after the fill, in units of the initial risk (1.0)
});

test('trailing: turned off, the stop never moves', () => {
  const ctx = make({ dpm: { enabled: false } });
  order(ctx);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  feed(ctx, 2, 1000.6, 1005, 1000.4, 1004.5);
  const p = ctx.t.state().positions[0];
  assert.equal(p.trailingArmed, false);
  approx(p.stop, 999);
});

test('max hold: closes at the candle close with its own reason', () => {
  const ctx = make({ dpm: { maxHoldBars: 3 } });
  order(ctx);
  feed(ctx, 1, 1000.5, 1000.8, 999.9, 1000.4);
  feed(ctx, 2, 1000.4, 1000.7, 1000.1, 1000.3);
  feed(ctx, 3, 1000.3, 1000.6, 1000.1, 1000.2);
  assert.equal(ctx.t.state().positions.length, 1);
  const r = feed(ctx, 4, 1000.2, 1000.5, 1000.0, 1000.3);
  assert.equal(r.closed.length, 1);
  const t = ctx.t.trades()[0];
  assert.equal(t.exitReason, 'max_hold');
  approx(t.exitPrice, 1000.3 - 0.01);
  assert.equal(t.openBars, 3);
});

test('sell trade: stop above, loss worked by hand', () => {
  const ctx = make();
  order(ctx, { side: 'sell', entry: 1000, stop: 1001 });
  feed(ctx, 1, 999.5, 1000.3, 999, 999.4); // fill 999.99
  feed(ctx, 2, 999.4, 1001.2, 999.3, 1000.9);
  const t = ctx.t.trades()[0];
  approx(t.exitPrice, 1001.01);
  const gross = -0.5 * 100 * (1001.01 - 999.99) / 999.99;
  approx(t.netUsd, gross);
  assert.equal(t.result, 'loss');
});

// ---------------------------------------------------------------- waiting orders

test('expiry: the order gets its full number of candles to fill, then expires', () => {
  const quiet = make();
  order(quiet, { expiryBars: 3 });
  feed(quiet, 1, 1002, 1003, 1001, 1002);
  feed(quiet, 2, 1002, 1003, 1001, 1002);
  assert.equal(quiet.t.state().account.pendingCount, 1);
  feed(quiet, 3, 1002, 1003, 1001, 1002);
  assert.equal(quiet.t.state().account.pendingCount, 0);
  assert.equal(quiet.t.counters.expired, 1);
  assert.equal(quiet.t.state().cancelled[0].status, 'expired');

  const late = make();
  order(late, { expiryBars: 3 });
  feed(late, 1, 1002, 1003, 1001, 1002);
  feed(late, 2, 1002, 1003, 1001, 1002);
  const r = feed(late, 3, 1002, 1003, 999.5, 1001);
  assert.equal(r.filled.length, 1, 'a touch on the last allowed candle still fills');
  assert.equal(late.t.counters.expired, 0);
});

test('the re-check runs only when a fill is due, and a failing check cancels with its code', () => {
  const ctx = make();
  order(ctx);
  let calls = 0;
  const recheck = (p) => { calls += 1; return { ok: false, reasons: [{ code: 'data_unreliable' }], id: p.id }; };
  feed(ctx, 1, 1002, 1003, 1001, 1002, { recheck });
  assert.equal(calls, 0, 'no fill due, no re-check');
  const r = feed(ctx, 2, 1001, 1001.5, 999.5, 1000.5, { recheck });
  assert.equal(calls, 1);
  assert.equal(r.filled.length, 0);
  assert.equal(ctx.t.counters.cancelled, 1);
  assert.equal(ctx.t.counters.byCancelReason.data_unreliable, 1);
  assert.equal(ctx.t.state().account.pendingCount, 0);

  const ok = make();
  order(ok);
  feed(ok, 1, 1001, 1001.5, 999.5, 1000.5, { recheck: () => ({ ok: true, reasons: [] }) });
  assert.equal(ok.t.state().positions.length, 1);
});

test('a throwing re-check cancels the order safely', () => {
  const ctx = make();
  order(ctx);
  feed(ctx, 1, 1001, 1001.5, 999.5, 1000.5, { recheck: () => { throw new Error('boom'); } });
  assert.equal(ctx.t.counters.byCancelReason.recheck_error, 1);
  assert.equal(ctx.t.state().positions.length, 0);
});

// ---------------------------------------------------------------- duplicates and cooldown

test('setupStatus: duplicate within a quarter ATR, cooldown after a close, clear afterwards', () => {
  const ctx = make({ risk: { cooldownBars: 3 } });
  order(ctx);
  const plan = (entry, side = 'buy') => ({ side, entry, stop: entry - 1 });
  const status = (p, tf = 60, at = nowAt(0)) => ctx.t.setupStatus(p, ASSET, tf, 1, at);
  assert.equal(status(plan(1000.2)), 'duplicate');
  assert.equal(status(plan(999.8)), 'duplicate');
  assert.equal(status(plan(1000.3)), null);
  assert.equal(status(plan(1000.2, 'sell')), null);
  assert.equal(status(plan(1000.2), 300), null);
  // Fill and stop out: the open trade is still a duplicate, then the closed one is a cooldown.
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  assert.equal(status(plan(1000.1), 60, nowAt(1)), 'duplicate');
  feed(ctx, 2, 1000.2, 1000.4, 998.8, 999.1);
  assert.equal(ctx.t.state().positions.length, 0);
  assert.equal(status(plan(1000.1), 60, nowAt(2)), 'cooldown');
  assert.equal(status(plan(1000.1), 60, nowAt(2) + 2 * 60000), 'cooldown');
  assert.equal(status(plan(1000.1), 60, nowAt(2) + 3 * 60000), null);
  assert.equal(status(plan(1000.5), 60, nowAt(2)), null, 'a different place is not blocked');
});

test('the risk engine refuses a duplicate setup through the account the trader provides', () => {
  const ctx = make();
  order(ctx);
  const verdict = evaluateCase({
    caseMsg: { id: 'TDC:R_100:60:1:1:9', asset: ASSET, tf: 60, evidence: { rank: 80, cls: 'strong' }, measurements: {}, plan: { side: 'buy', entry: 1000.1, stop: 999.1 } },
    settings: ctx.t.settings, account: ctx.t.accountFor(nowAt(0)), market: { health: { ok: true }, atr: 1, spreadPrice: 0.02 },
    reducedNow: false, evidenceRank: 80, nowMs: nowAt(0),
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.code === 'duplicate'));
});

// ---------------------------------------------------------------- stops, manual actions, days

test('emergency stop: cancels waiting orders, closes open trades at the last close, blocks new orders, can be cleared', () => {
  const ctx = make({ risk: { maxOpen: 5, maxPending: 5 } });
  order(ctx, { entry: 1000, stop: 999 });
  order(ctx, { entry: 990, stop: 989 });
  const spare = evaluateCase({
    caseMsg: { id: 'TDC:R_100:60:7:7:7', asset: ASSET, tf: 60, evidence: { rank: 80, cls: 'strong' }, measurements: {}, plan: { side: 'buy', entry: 980, stop: 979 } },
    settings: ctx.t.settings, account: ctx.t.accountFor(nowAt(0)), market: { health: { ok: true }, atr: 1, spreadPrice: 0.02 },
    reducedNow: false, evidenceRank: 80, nowMs: nowAt(0),
  });
  assert.ok(spare.ok);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  assert.equal(ctx.t.state().positions.length, 1);
  ctx.t.emergencyStop('test', nowAt(1));
  const s = ctx.t.state();
  assert.equal(s.positions.length, 0);
  assert.equal(s.pendings.length, 0);
  assert.equal(s.emergencyStop.on, true);
  assert.equal(ctx.t.trades()[0].exitReason, 'emergency');
  approx(ctx.t.trades()[0].exitRaw, 1000.6);
  assert.throws(() => ctx.t.place(spare.approval, { caseId: 'TDC:R_100:60:7:7:7', asset: ASSET, tf: 60, side: 'buy', entry: 980, stop: 979 }, nowAt(1)), { code: 'EMERGENCY_STOP' });
  assert.equal(isApproved(spare.approval), true, 'a refused order does not use the approval');
  assert.equal(ctx.t.accountFor(nowAt(1)).emergencyStop, true);
  assert.equal(ctx.t.clearEmergencyStop(nowAt(1)), true);
  assert.equal(ctx.t.state().emergencyStop.on, false);
});

test('closeNow closes one trade at the last close, and cancelPending removes one waiting order', () => {
  const ctx = make({ risk: { maxPending: 5 } });
  order(ctx, { entry: 1000, stop: 999 });
  order(ctx, { entry: 990, stop: 989 });
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  const id = ctx.t.state().positions[0].id;
  const rec = ctx.t.closeNow(id, 'manual', nowAt(1));
  assert.equal(rec.exitReason, 'manual');
  assert.equal(ctx.t.closeNow('nope'), null);
  const waiting = ctx.t.state().pendings[0].id;
  assert.equal(ctx.t.cancelPending(waiting, 'user', nowAt(1)), true);
  assert.equal(ctx.t.cancelPending(waiting), false);
  assert.equal(ctx.t.state().account.pendingCount, 0);
});

test('a new UTC day resets today\'s result and the day-start usable amount, not the balance', () => {
  const ctx = make();
  const dayEnd = 24 * 60 - 3; // minute index, three bars before midnight UTC
  const base = dayEnd - 3;
  ctx.t.onCandle({ asset: ASSET, tf: 60, candle: c(base, 1001, 1002, 1000.5, 1001.5), nowMs: nowAt(base) });
  order(ctx, { at: base });
  ctx.t.onCandle({ asset: ASSET, tf: 60, candle: c(base + 1, 1000.5, 1001, 999.8, 1000.6), nowMs: nowAt(base + 1) });
  ctx.t.onCandle({ asset: ASSET, tf: 60, candle: c(base + 2, 1000.2, 1000.4, 998.8, 999.1), nowMs: nowAt(base + 2) });
  const loss = ctx.t.trades()[0].netUsd;
  assert.ok(loss < 0);
  approx(ctx.t.state().account.realizedTodayUsd, loss);
  assert.equal(ctx.t.state().account.dayKey, '2026-01-05');
  const next = 24 * 60 + 1;
  ctx.t.onCandle({ asset: ASSET, tf: 60, candle: c(next, 999, 1000, 998, 999.5), nowMs: nowAt(next) });
  const a = ctx.t.state().account;
  assert.equal(a.dayKey, '2026-01-06');
  assert.equal(a.realizedTodayUsd, 0);
  approx(a.balance, 1000 + loss);
  approx(a.dayStartUsable, 5);
});

test('the usable amount is capped at the usable-balance cap, whatever the paper balance is', () => {
  const rich = make({ paper: { startBalance: 100000 } });
  approx(rich.t.state().account.usable, 5);
  approx(rich.t.state().account.balance, 100000);
  const poor = make({ paper: { startBalance: 10 } });
  poor.t.balance = 3;
  approx(poor.t.state().account.usable, 3);
});

test('resetPaper starts clean and the audit log keeps the history of what happened', () => {
  const ctx = make();
  order(ctx);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  feed(ctx, 2, 1000.2, 1000.4, 998.8, 999.1);
  const kinds = ctx.audit.list({ limit: 100 }).map((e) => e.kind);
  assert.deepEqual(kinds, ['order_placed', 'order_filled', 'close']);
  ctx.t.resetPaper(250, nowAt(3));
  const s = ctx.t.state();
  assert.equal(s.account.balance, 250);
  assert.equal(s.account.closedCount, 0);
  assert.equal(ctx.audit.list({ limit: 100 }).at(-1).kind, 'reset');
  assert.equal(ctx.audit.list({ limit: 100 }).length, 4, 'the earlier entries are still there');
});

// ---------------------------------------------------------------- persistence

test('saveState and loadState: a restored trader gives the same state and the same future', () => {
  const a = make({ risk: { maxPending: 5 } });
  order(a, { entry: 1000, stop: 999 });
  order(a, { entry: 990, stop: 989 });
  feed(a, 1, 1000.5, 1001, 999.8, 1000.6);
  const saved = JSON.parse(JSON.stringify(a.t.saveState()));
  const b = make({ risk: { maxPending: 5 } });
  assert.equal(b.t.loadState(saved), true);
  assert.deepEqual(b.t.state(nowAt(1)), a.t.state(nowAt(1)));
  const seq = [[2, 1000.6, 1002.2, 1000.4, 1002.1], [3, 1002.1, 1002.6, 1001.9, 1002.4], [4, 1002.4, 1002.5, 1000.9, 1001.0], [5, 995, 996, 988, 989]];
  for (const x of seq) {
    feed(a, ...x);
    feed(b, ...x);
  }
  assert.equal(JSON.stringify(a.t.trades()), JSON.stringify(b.t.trades()));
  assert.equal(JSON.stringify(a.t.state(nowAt(5))), JSON.stringify(b.t.state(nowAt(5))));
  // A repeated candle after a restore is still ignored.
  assert.deepEqual(b.t.onCandle({ asset: ASSET, tf: 60, candle: c(5, 995, 996, 988, 989), nowMs: nowAt(5) }), { filled: [], closed: [], cancelled: [] });
});

test('loadState refuses bad data and changes nothing', () => {
  const ctx = make();
  const before = JSON.stringify(ctx.t.saveState());
  for (const bad of [null, 5, {}, { version: 99 }, { version: 1, balance: 'x', startBalance: 1, peakBalance: 1 }, { version: 1, balance: 1, startBalance: 1, peakBalance: 1, pendings: 5, positions: [], closed: [] }]) {
    assert.equal(ctx.t.loadState(bad), false);
  }
  assert.equal(JSON.stringify(ctx.t.saveState()), before);
});

// ---------------------------------------------------------------- performance report

const trade = (i, net, extra = {}) => ({
  id: `T${i}`, asset: ASSET, tf: 60, side: 'buy', engine: 'BLE', netUsd: net, grossUsd: net, costUsd: 0.001, rMultiple: net / 0.05,
  result: net > 0 ? 'win' : net < 0 ? 'loss' : 'breakeven', exitReason: net > 0 ? 'trail' : 'stop', exitMs: (T0 + i * 3600) * 1000, openBars: 5, stake: 0.5, ...extra,
});

test('metrics: hand-worked win rate, Wilson range, break-even, expectancy, profit factor, drawdown and streaks', () => {
  const nets = [0.1, -0.05, -0.05, -0.05, 0.1, 0.1, 0.1, 0.1, -0.05, 0.1];
  const trades = nets.map((n, i) => trade(i, n));
  const m = metricsOf(trades);
  assert.equal(m.n, 10);
  assert.equal(m.wins, 6);
  assert.equal(m.losses, 4);
  approx(m.winRate, 0.6);
  const w = wilson(6, 10, 1.96);
  approx(m.winRateLo, w.lo);
  approx(m.winRateHi, w.hi);
  approx(m.avgWinUsd, 0.1);
  approx(m.avgLossUsd, -0.05);
  approx(m.breakEvenWinRate, 0.05 / 0.15);
  approx(m.netUsd, 0.6 - 0.2);
  approx(m.expectancyUsd, 0.04);
  approx(m.profitFactor, 3);
  assert.equal(m.edgeProven, false, 'ten trades are not enough: the lower bound 0.26 is below break-even 0.33');
  assert.equal(m.bestWin, 4, 'four wins in a row at trades 5 to 8');
  assert.equal(m.worstLoss, 3);
  const dd = drawdownAndCurve(closedSorted(trades));
  approx(dd.abs, 0.15);
  approx(m.maxDrawdownUsd, 0.15);
  assert.deepEqual(streaks(closedSorted(trades)), { bestWin: 4, worstLoss: 3, currentWin: 1, currentLoss: 0 });
});

test('metrics: a hundred trades at 60% do clear break-even, and zero trades give no numbers rather than NaN', () => {
  const many = Array.from({ length: 100 }, (_, i) => trade(i, i % 5 < 3 ? 0.1 : -0.05));
  const m = metricsOf(many);
  assert.equal(m.edgeProven, true);
  assert.ok(m.winRateLo > m.breakEvenWinRate);
  const none = metricsOf([]);
  assert.equal(none.n, 0);
  assert.equal(none.winRate, null);
  assert.equal(none.breakEvenWinRate, null);
  assert.equal(none.expectancyUsd, null);
  assert.equal(none.edgeProven, false);
  const onlyWins = metricsOf([trade(1, 0.1), trade(2, 0.1)]);
  assert.equal(onlyWins.breakEvenWinRate, null, 'break-even needs both a win and a loss');
  assert.equal(onlyWins.profitFactor, null);
});

test('report: groups by engine, asset, exit and condition, with consistency, rejections and execution counts', () => {
  const trades = [
    trade(0, 0.1, { engine: 'BLE', familySig: 'levels+zones' }),
    trade(1, -0.05, { engine: 'SLE', side: 'sell', asset: 'frxXAUUSD', familySig: 'levels+structure+zones' }),
    trade(2, 0.1, { engine: 'BLE', familySig: 'levels+zones' }),
    trade(30, -0.05, { engine: 'SLE', side: 'sell', exitMs: (T0 + 30 * 3600) * 1000, volClass: 'high' }),
    { id: 'open', result: 'open', netUsd: 5 },
  ];
  const r = performanceReport(trades, {
    rejected: [{ ok: false, reasons: [{ code: 'max_open' }, { code: 'duplicate' }] }, { ok: false, reasons: [{ code: 'duplicate' }] }, { ok: true, reasons: [] }],
    expired: 3, execution: { placed: 10, filled: 4, cancelled: 2, expired: 3, invalidated: 1 },
  });
  assert.equal(r.overall.n, 4, 'open trades are not counted');
  assert.deepEqual(Object.keys(r.byEngine).sort(), ['BLE', 'SLE']);
  assert.equal(r.byEngine.BLE.n, 2);
  assert.equal(r.byEngine.SLE.losses, 2);
  assert.equal(r.byAsset.frxXAUUSD.n, 1);
  assert.equal(r.byExit.stop.n, 2);
  assert.equal(r.byCondition['levels+zones'].wins, 2);
  assert.equal(r.byVolatility.high.n, 1);
  assert.equal(r.bySide.sell.n, 2);
  assert.equal(r.rejected.total, 2);
  assert.deepEqual(r.rejected.byReason[0], { code: 'duplicate', count: 2 });
  assert.equal(r.expired, 3);
  assert.equal(r.execution.fillRate, 0.4);
  assert.equal(r.consistency.days, 2);
  assert.match(r.edge.text, /does not clear break-even|not yet both/);
  const empty = performanceReport([]);
  assert.equal(empty.overall.n, 0);
  assert.match(empty.edge.text, /nothing to measure/);
  assert.deepEqual(empty.byEngine, {});
});

test('report: the trader\'s own closed trades flow straight into it', () => {
  const ctx = make();
  order(ctx);
  feed(ctx, 1, 1000.5, 1001, 999.8, 1000.6);
  feed(ctx, 2, 1000.2, 1000.4, 998.8, 999.1);
  const r = performanceReport(ctx.t.trades(), { execution: { placed: ctx.t.counters.placed, filled: ctx.t.counters.filled } });
  assert.equal(r.overall.n, 1);
  assert.equal(r.byEngine.BLE.losses, 1);
  assert.equal(r.byExit.stop.n, 1);
  assert.equal(r.execution.fillRate, 1);
  assert.equal(r.consistency.days, 1);
  const cons = consistencyOf(closedSorted(ctx.t.trades()));
  assert.equal(cons.positiveDays, 0);
});
