// DEE: the paper execution engine. Every order here is simulated; nothing is ever sent to Deriv.
// It only places an order that carries a single-use approval from the risk engine (RME), fills limit entries from
// candles, manages the stop and the trailing protection (DPM), and keeps the paper account.
// Pure apart from the injected audit log, logger and clock. No DOM, storage or network.
import { cfgFor } from '../core/schema.js';
import { isApproved, consumeApproval } from '../engine/approval.js';
import { utcDayKey } from './daily.js';
import { dirOf, grossUsd, netOf, resultOf, pendingStep, manageTrade } from './orders.js';

export const ENGINE = Object.freeze({ code: 'DEE', name: 'Execution engine (paper)', stage: 3 });

const STATE_VERSION = 1;
const HOUR = 3600000;
const num = (x, d = NaN) => {
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : d;
};
const keyOf = (asset, tf) => `${asset}|${tf}`;
const plain = (o) => JSON.parse(JSON.stringify(o));

function fail(code, text) {
  const e = new Error(text);
  e.code = code;
  return e;
}

export class PaperTrader {
  constructor({ settings, audit = null, log = null, nowFn = () => Date.now() } = {}) {
    this.audit = audit;
    this.log = log;
    this.nowFn = nowFn;
    this.settings = settings;
    this.resetPaper(num(this._cfg('paper').startBalance, 1000), null, { silent: true });
  }

  // ---------------------------------------------------------------- small helpers

  _cfg(prefix) {
    return cfgFor(prefix, this.settings);
  }

  _say(level, text, data) {
    try {
      if (this.log && typeof this.log[level] === 'function') this.log[level]('trader', text, data);
    } catch (_) { /* logging must never break trading */ }
  }

  _audit(kind, data, atMs) {
    try {
      if (this.audit) this.audit.append(kind, data, Number.isFinite(atMs) ? atMs : this.lastNowMs || 0);
    } catch (_) { /* the audit log must never break trading */ }
  }

  setSettings(settings) {
    this.settings = settings;
  }

  _usable(balance = this.balance) {
    return Math.min(balance, num(this._cfg('risk').usableCapUsd, 5));
  }

  _costs() {
    const c = this._cfg('cost');
    return { half: num(c.spreadPrice, 0) / 2, slip: num(c.slippagePrice, 0), commissionPct: num(c.commissionPct, 0), gap: c.gapFillMode };
  }

  _commission(stake) {
    return (this._costs().commissionPct / 100) * stake * 2;
  }

  _rollDay(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    this.lastNowMs = Math.max(this.lastNowMs || 0, nowMs);
    const key = utcDayKey(nowMs, this._cfg('dpt').resetUtcHour);
    if (this.dayKey === key) return;
    const first = this.dayKey === null;
    this.dayKey = key;
    if (!first) {
      this.dayStartBalance = this.balance;
      this.dayStartUsable = this._usable();
      this.realizedToday = 0;
      this._audit('day_start', { dayKey: key, balance: this.balance }, nowMs);
    }
  }

  // ---------------------------------------------------------------- the account

  floatingUsd() {
    const { half, slip } = this._costs();
    let total = 0;
    for (const p of this.positions) total += this._markUsd(p, half + slip);
    return total;
  }

  _markUsd(p, exitCost) {
    const last = this.lastClose.get(keyOf(p.asset, p.tf));
    if (!Number.isFinite(last)) return 0;
    const dir = dirOf(p.side);
    const gross = grossUsd({ side: p.side, stake: p.stake, multiplier: p.multiplier, entry: p.entry, exit: last - dir * exitCost });
    return netOf(gross, this._commission(p.stake), p.stake);
  }

  entriesThisHour(nowMs = this.lastNowMs) {
    this.entryTimes = this.entryTimes.filter((t) => nowMs - t < HOUR);
    return this.entryTimes.length;
  }

  // The account view the risk engine reads. setupStatus is bound so the duplicate and cooldown rules live here.
  accountFor(nowMs = this.lastNowMs) {
    this._rollDay(nowMs);
    return {
      balance: this.balance,
      peakBalance: this.peakBalance,
      dayStartUsable: this.dayStartUsable,
      realizedTodayUsd: this.realizedToday,
      floatingUsd: this.floatingUsd(),
      openCount: this.positions.length,
      pendingCount: this.pendings.length,
      entriesThisHour: this.entriesThisHour(nowMs),
      emergencyStop: this.stopped.on,
      hasCase: (caseId) => this.hasCase(caseId),
      setupStatus: (plan, asset, tf, atr, at) => this.setupStatus(plan, asset, tf, atr, at),
    };
  }

  hasCase(caseId) {
    return this.pendings.some((p) => p.caseId === caseId) || this.positions.some((p) => p.caseId === caseId);
  }

  // null, 'duplicate' (a waiting order or open trade at the same place) or 'cooldown' (the same setup closed a moment ago).
  setupStatus(plan, asset, tf, atr, nowMs = this.lastNowMs) {
    if (!plan || !Number.isFinite(plan.entry)) return null;
    const tol = 0.25 * (atr > 0 ? atr : Math.abs(plan.entry) * 0.002);
    const same = (o) => o.asset === asset && Number(o.tf) === Number(tf) && o.side === plan.side
      && Math.abs(num(o.plannedEntry, num(o.entry)) - plan.entry) <= tol;
    if (this.pendings.some(same) || this.positions.some(same)) return 'duplicate';
    const wait = num(this._cfg('risk').cooldownBars, 0) * Number(tf) * 1000;
    if (wait > 0) {
      const from = Math.max(0, this.closed.length - 200);
      for (let i = this.closed.length - 1; i >= from; i -= 1) {
        const t = this.closed[i];
        if (nowMs - t.exitMs < wait && same(t)) return 'cooldown';
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- placing

  // Places a simulated limit order. Throws NOT_APPROVED unless the order carries a live approval for the same case.
  place(approval, order, nowMs = this.nowFn()) {
    if (!isApproved(approval) || !order || approval.caseId !== order.caseId) throw fail('NOT_APPROVED', 'The order has no valid approval from the risk engine.');
    if (this.stopped.on) throw fail('EMERGENCY_STOP', 'The emergency stop is on. No new orders.');
    if (approval.asset !== order.asset || Number(approval.tf) !== Number(order.tf) || approval.side !== order.side) {
      throw fail('APPROVAL_MISMATCH', 'The approval was issued for a different market, timeframe or side.');
    }
    if (!(num(order.entry) > 0) || !Number.isFinite(num(order.stop)) || order.entry === order.stop) throw fail('BAD_ORDER', 'The order needs an entry and a different stop.');
    if (this.hasCase(order.caseId)) throw fail('DUPLICATE_CASE', 'This case already has an order.');
    if (!consumeApproval(approval)) throw fail('NOT_APPROVED', 'The approval was already used.');
    this._rollDay(nowMs);
    this.seq += 1;
    const key = keyOf(order.asset, order.tf);
    const pending = {
      id: `P${this.seq}`,
      caseId: order.caseId,
      planId: order.planId || order.caseId,
      asset: order.asset,
      tf: Number(order.tf),
      side: order.side,
      engine: typeof order.engine === 'string' && order.engine ? order.engine : (order.side === 'sell' ? 'SLE' : 'BLE'),
      strategy: order.strategy || 'engines',
      entry: num(order.entry),
      plannedEntry: num(order.entry),
      stop: num(order.stop),
      target: num(order.target),
      invalidation: Number.isFinite(num(order.invalidation)) ? num(order.invalidation) : num(order.stop),
      zone: order.zone ? { lo: order.zone.lo, hi: order.zone.hi } : null,
      // Stake, risk and multiplier come from the approval, never from the order.
      stake: approval.stake,
      riskUsd: approval.riskUsd,
      multiplier: approval.multiplier,
      objectiveR: num(order.objectiveR, num(this._cfg('dpm').objectiveR, 2)),
      expiryBars: Math.max(1, Math.floor(num(order.expiryBars, 24))),
      familySig: order.familySig || '',
      volClass: order.volClass || null,
      features: order.features ? plain(order.features) : null,
      status: 'waiting',
      placedMs: nowMs,
      placedIndex: this.bars.get(key) || 0,
      barsWaiting: 0,
      reason: null,
    };
    this.pendings.push(pending);
    this.entryTimes.push(nowMs);
    this.counters.placed += 1;
    this._audit('order_placed', { id: pending.id, caseId: pending.caseId, asset: pending.asset, tf: pending.tf, side: pending.side, entry: pending.entry, stop: pending.stop, stake: pending.stake }, nowMs);
    this._say('info', `Paper order ${pending.id} placed: ${pending.side} limit ${pending.entry} on ${pending.asset}.`);
    return plain(pending);
  }

  cancelPending(id, reason = 'cancelled', nowMs = this.lastNowMs) {
    const i = this.pendings.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this._finishPending(this.pendings[i], 'cancelled', reason, nowMs);
    return true;
  }

  _finishPending(p, status, reason, nowMs) {
    this.pendings = this.pendings.filter((x) => x !== p);
    p.status = status;
    p.reason = reason;
    if (status === 'expired') this.counters.expired += 1;
    else if (reason === 'setup_invalidated') this.counters.invalidated += 1;
    else this.counters.cancelled += 1;
    this.counters.byCancelReason[reason] = (this.counters.byCancelReason[reason] || 0) + 1;
    this.cancelled.push({ id: p.id, caseId: p.caseId, asset: p.asset, tf: p.tf, side: p.side, entry: p.entry, status, reason, atMs: nowMs });
    if (this.cancelled.length > 300) this.cancelled.splice(0, this.cancelled.length - 300);
    this._audit(status === 'expired' ? 'order_expired' : 'order_cancelled', { id: p.id, caseId: p.caseId, reason }, nowMs);
    this._say('info', `Paper order ${p.id} ${status}: ${reason}.`);
  }

  // ---------------------------------------------------------------- candles

  // One closed candle for one market and timeframe. Order of work: fills, then stops and management.
  // recheck(pending, candle) -> { ok, reasons: [{ code }] } is supplied by the session and runs only when a fill is due.
  onCandle({ asset, tf, candle, nowMs, recheck = null }) {
    const none = { filled: [], closed: [], cancelled: [] };
    if (!candle || !Number.isFinite(candle.close)) return none;
    const key = keyOf(asset, tf);
    // Each closed candle is read once. An older or repeated candle is ignored, so a replay cannot fill an order twice.
    if (Number.isFinite(candle.epoch) && candle.epoch <= (this.lastEpoch.get(key) ?? -Infinity)) return none;
    if (Number.isFinite(candle.epoch)) this.lastEpoch.set(key, candle.epoch);
    const at = Number.isFinite(nowMs) ? nowMs : (candle.epoch + Number(tf)) * 1000;
    this._rollDay(at);
    const seen = (this.bars.get(key) || 0) + 1;
    this.bars.set(key, seen);
    this.lastClose.set(key, candle.close);
    const out = { filled: [], closed: [], cancelled: [] };
    const costs = this._costs();

    // 1. Waiting orders, oldest first. Fill first: a candle that reaches the entry fills it even if it closes beyond the stop.
    for (const p of [...this.pendings]) {
      if (p.asset !== asset || p.tf !== Number(tf)) continue;
      p.barsWaiting = seen - p.placedIndex;
      if (p.barsWaiting < 1) continue; // an order never fills on the candle it was placed on
      const step = pendingStep({ pending: { ...p, expiryBars: 0, invalidation: NaN }, candle, halfSpread: costs.half });
      if (step.status === 'filled') {
        let verdict = { ok: true, reasons: [] };
        if (typeof recheck === 'function') {
          try { verdict = recheck(plain(p), candle) || verdict; } catch (e) { verdict = { ok: false, reasons: [{ code: 'recheck_error' }] }; }
        }
        if (!verdict.ok) {
          const code = (verdict.reasons && verdict.reasons[0] && verdict.reasons[0].code) || 'recheck_failed';
          this._finishPending(p, 'cancelled', code, at);
          out.cancelled.push(p.id);
          continue;
        }
        const pos = this._open(p, step.fillPrice, step.rawPrice, candle, at, seen);
        out.filled.push(pos.id);
        const exit = this._fillCandleStop(pos, candle, costs);
        if (exit) {
          out.closed.push(this._close(pos, exit.raw, exit.reason, at).id);
          continue;
        }
        this._manageOnFillCandle(pos, candle, costs);
        continue;
      }
      const buy = p.side !== 'sell';
      const dead = buy ? candle.close < p.invalidation : candle.close > p.invalidation;
      if (Number.isFinite(p.invalidation) && dead) {
        this._finishPending(p, 'cancelled', 'setup_invalidated', at);
        out.cancelled.push(p.id);
      } else if (p.barsWaiting >= p.expiryBars) {
        this._finishPending(p, 'expired', 'expired', at);
        out.cancelled.push(p.id);
      }
    }

    // 2. Open positions that were open before this candle.
    for (const pos of [...this.positions]) {
      if (pos.asset !== asset || pos.tf !== Number(tf) || pos.entryIndex === seen) continue;
      pos.openBars += 1;
      const hit = this._stopHit(pos, candle, costs);
      this._excursion(pos, candle);
      if (hit) {
        out.closed.push(this._close(pos, hit.raw, hit.reason, at).id);
        continue;
      }
      const m = manageTrade({
        position: pos, candle, cfg: this._cfg('dpm'), rMoney: pos.riskUsd, rPrice: pos.riskPrice,
        exitCost: costs.half + costs.slip, commissionUsd: this._commission(pos.stake),
      });
      pos.stop = m.stop;
      pos.bestPrice = m.bestPrice;
      pos.trailingArmed = m.armed;
      if (m.exit) out.closed.push(this._close(pos, m.exit.price, m.exit.reason, at).id);
    }
    return out;
  }

  _open(p, fillPrice, rawPrice, candle, at, seen) {
    this.pendings = this.pendings.filter((x) => x !== p);
    const pos = {
      id: p.id.replace(/^P/, 'T'),
      caseId: p.caseId,
      planId: p.planId,
      asset: p.asset,
      tf: p.tf,
      side: p.side,
      engine: p.engine,
      strategy: p.strategy,
      familySig: p.familySig,
      volClass: p.volClass,
      features: p.features,
      plannedEntry: p.plannedEntry,
      entry: fillPrice,
      rawFill: rawPrice,
      stop: p.stop,
      initialStop: p.stop,
      target: p.target,
      invalidation: p.invalidation,
      riskPrice: Math.abs(p.plannedEntry - p.stop),
      stake: p.stake,
      riskUsd: p.riskUsd,
      multiplier: p.multiplier,
      objectiveR: p.objectiveR,
      objectiveUsd: p.objectiveR * p.riskUsd,
      bestPrice: fillPrice,
      trailingArmed: false,
      openBars: 0,
      entryMs: at,
      entryIndex: seen,
      placedMs: p.placedMs,
      waitedBars: p.barsWaiting,
      mfe: 0,
      mae: 0,
      status: 'open',
    };
    this.positions.push(pos);
    this.counters.filled += 1;
    this._audit('order_filled', { id: pos.id, caseId: pos.caseId, asset: pos.asset, side: pos.side, fill: fillPrice, stake: pos.stake }, at);
    this._say('info', `Paper order ${p.id} filled at ${fillPrice} (${pos.side} ${pos.asset}).`);
    return pos;
  }

  // Did this candle take the stop? Gap through the stop fills at the open (or at the stop, by setting).
  _stopHit(pos, candle, costs) {
    const buy = pos.side !== 'sell';
    const through = buy ? candle.low <= pos.stop : candle.high >= pos.stop;
    if (!through) return null;
    const gap = buy ? candle.open <= pos.stop : candle.open >= pos.stop;
    const raw = gap && costs.gap === 'open' ? candle.open : pos.stop;
    const moved = pos.trailingArmed && pos.stop !== pos.initialStop;
    return { raw, reason: moved ? 'trail' : 'stop' };
  }

  // On the candle that filled the order the stop is checked too, so a wide candle cannot hide a loss.
  _fillCandleStop(pos, candle, costs) {
    return this._stopHit(pos, candle, costs);
  }

  // The fill candle counts only from the fill to the close for favourable moves, and fully for adverse ones.
  _manageOnFillCandle(pos, candle, costs) {
    const clipped = { open: pos.entry, high: Math.max(pos.entry, candle.close), low: Math.min(pos.entry, candle.close), close: candle.close };
    const buy = pos.side !== 'sell';
    pos.mae = Math.max(pos.mae, buy ? pos.entry - candle.low : candle.high - pos.entry);
    pos.mfe = Math.max(pos.mfe, buy ? clipped.high - pos.entry : pos.entry - clipped.low);
    const m = manageTrade({
      position: pos, candle: clipped, cfg: { ...this._cfg('dpm'), maxHoldBars: 0 }, rMoney: pos.riskUsd, rPrice: pos.riskPrice,
      exitCost: costs.half + costs.slip, commissionUsd: this._commission(pos.stake),
    });
    pos.stop = m.stop;
    pos.bestPrice = m.bestPrice;
    pos.trailingArmed = m.armed;
  }

  _excursion(pos, candle) {
    const buy = pos.side !== 'sell';
    pos.mfe = Math.max(pos.mfe, buy ? candle.high - pos.entry : pos.entry - candle.low);
    pos.mae = Math.max(pos.mae, buy ? pos.entry - candle.low : candle.high - pos.entry);
  }

  // Closes a position at a raw price. Spread (half) and slippage go against us; commission is charged on both sides.
  _close(pos, rawExit, reason, at) {
    const { half, slip } = this._costs();
    const dir = dirOf(pos.side);
    const exitFill = rawExit - dir * (half + slip);
    const gross = grossUsd({ side: pos.side, stake: pos.stake, multiplier: pos.multiplier, entry: pos.entry, exit: exitFill });
    const commission = this._commission(pos.stake);
    const net = netOf(gross, commission, pos.stake);
    const priceCost = 2 * half + slip; // half the spread each way, plus slippage on the exit
    const costUsd = (priceCost * pos.stake * pos.multiplier) / pos.entry + commission;
    this.positions = this.positions.filter((x) => x !== pos);
    const rec = {
      ...pos,
      status: 'closed',
      exitPrice: exitFill,
      exitRaw: rawExit,
      exitReason: reason,
      exitMs: at,
      grossUsd: gross,
      commissionUsd: commission,
      costUsd,
      netUsd: net,
      rMultiple: pos.riskUsd > 0 ? net / pos.riskUsd : null,
      result: resultOf(net),
      mfeR: pos.riskPrice > 0 ? pos.mfe / pos.riskPrice : null,
      maeR: pos.riskPrice > 0 ? pos.mae / pos.riskPrice : null,
    };
    this.balance += net;
    this.realizedToday += net;
    if (this.balance > this.peakBalance) this.peakBalance = this.balance;
    this.closed.push(rec);
    const keep = Math.max(100, num(this._cfg('store').keepJournal, 5000));
    if (this.closed.length > keep) this.closed.splice(0, this.closed.length - keep);
    this._audit('close', { id: rec.id, caseId: rec.caseId, asset: rec.asset, side: rec.side, result: rec.result, netUsd: net, reason }, at);
    this._say('info', `Paper trade ${rec.id} closed (${reason}): ${rec.result}, net ${net}.`);
    if (this.balance <= 0 && !this.stopped.on) this.emergencyStop('balance_depleted', at);
    return rec;
  }

  // ---------------------------------------------------------------- stops and manual actions

  emergencyStop(reason = 'manual', nowMs = this.lastNowMs) {
    if (!this.stopped.on) this.stopped = { on: true, reason, sinceMs: nowMs };
    for (const p of [...this.pendings]) this._finishPending(p, 'cancelled', 'emergency', nowMs);
    for (const pos of [...this.positions]) {
      const last = this.lastClose.get(keyOf(pos.asset, pos.tf));
      this._close(pos, Number.isFinite(last) ? last : pos.entry, 'emergency', nowMs);
    }
    this._audit('emergency_stop', { reason }, nowMs);
    this._say('warn', `Emergency stop: ${reason}. Orders cancelled and trades closed.`);
  }

  clearEmergencyStop(nowMs = this.lastNowMs) {
    if (!this.stopped.on) return false;
    this.stopped = { on: false, reason: null, sinceMs: null };
    this._audit('emergency_clear', {}, nowMs);
    return true;
  }

  closeNow(positionId, reason = 'manual', nowMs = this.lastNowMs) {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return null;
    const last = this.lastClose.get(keyOf(pos.asset, pos.tf));
    return plain(this._close(pos, Number.isFinite(last) ? last : pos.entry, reason, nowMs));
  }

  resetPaper(startBalance = num(this._cfg('paper').startBalance, 1000), nowMs = null, { silent = false } = {}) {
    const b = Math.max(1, num(startBalance, 1000));
    this.startBalance = b;
    this.balance = b;
    this.peakBalance = b;
    this.dayKey = null;
    this.dayStartBalance = b;
    this.dayStartUsable = this._usable(b);
    this.realizedToday = 0;
    this.pendings = [];
    this.positions = [];
    this.closed = [];
    this.cancelled = [];
    this.counters = { placed: 0, filled: 0, cancelled: 0, expired: 0, invalidated: 0, byCancelReason: {} };
    this.bars = new Map();
    this.lastEpoch = new Map();
    this.lastClose = new Map();
    this.entryTimes = [];
    this.seq = 0;
    this.stopped = { on: false, reason: null, sinceMs: null };
    this.lastNowMs = Number.isFinite(nowMs) ? nowMs : 0;
    if (!silent) {
      this._audit('reset', { startBalance: b }, nowMs);
      this._say('warn', 'Paper account reset.');
    }
  }

  // ---------------------------------------------------------------- views and persistence

  state(nowMs = this.lastNowMs) {
    const floating = this.floatingUsd();
    const { half, slip } = this._costs();
    const drawdownPct = this.peakBalance > 0 ? Math.max(0, (this.peakBalance - this.balance) / this.peakBalance) * 100 : 0;
    return {
      emergencyStop: { ...this.stopped },
      account: {
        startBalance: this.startBalance,
        balance: this.balance,
        peakBalance: this.peakBalance,
        usableCapUsd: num(this._cfg('risk').usableCapUsd, 5),
        usable: this._usable(),
        dayKey: this.dayKey,
        dayStartUsable: this.dayStartUsable,
        realizedTodayUsd: this.realizedToday,
        floatingUsd: floating,
        drawdownPct,
        openCount: this.positions.length,
        pendingCount: this.pendings.length,
        closedCount: this.closed.length,
        entriesThisHour: this.entriesThisHour(nowMs),
      },
      pendings: this.pendings.map((p) => ({
        id: p.id, caseId: p.caseId, asset: p.asset, tf: p.tf, side: p.side, engine: p.engine, strategy: p.strategy, entry: p.entry, stop: p.stop, target: p.target,
        stake: p.stake, status: p.status, placedMs: p.placedMs, barsWaiting: p.barsWaiting, expiryBars: p.expiryBars, reason: p.reason,
      })),
      positions: this.positions.map((p) => ({
        id: p.id, caseId: p.caseId, asset: p.asset, tf: p.tf, side: p.side, engine: p.engine, strategy: p.strategy, entry: p.entry, stop: p.stop, initialStop: p.initialStop,
        bestPrice: p.bestPrice, trailingArmed: p.trailingArmed, objectiveUsd: p.objectiveUsd, stake: p.stake, openBars: p.openBars,
        floatingUsd: this._markUsd(p, half + slip), status: p.status, entryMs: p.entryMs,
      })),
      closed: this.closed.slice(-200).map((t) => plain(t)),
      cancelled: this.cancelled.slice(-100).map((c) => ({ ...c })),
      counters: { ...this.counters, byCancelReason: { ...this.counters.byCancelReason } },
    };
  }

  // Every closed trade, oldest first (for analytics and learning). A copy.
  trades() {
    return this.closed.map((t) => plain(t));
  }

  saveState() {
    return plain({
      version: STATE_VERSION,
      startBalance: this.startBalance,
      balance: this.balance,
      peakBalance: this.peakBalance,
      dayKey: this.dayKey,
      dayStartBalance: this.dayStartBalance,
      dayStartUsable: this.dayStartUsable,
      realizedToday: this.realizedToday,
      pendings: this.pendings,
      positions: this.positions,
      closed: this.closed,
      cancelled: this.cancelled,
      counters: this.counters,
      bars: [...this.bars],
      lastEpoch: [...this.lastEpoch],
      lastClose: [...this.lastClose],
      entryTimes: this.entryTimes,
      seq: this.seq,
      stopped: this.stopped,
      lastNowMs: this.lastNowMs,
    });
  }

  // Restores a saved state. Returns false (and changes nothing) when the data is not a usable state.
  loadState(s) {
    if (!s || typeof s !== 'object' || s.version !== STATE_VERSION) return false;
    if (![s.balance, s.startBalance, s.peakBalance].every((x) => Number.isFinite(x))) return false;
    if (!Array.isArray(s.pendings) || !Array.isArray(s.positions) || !Array.isArray(s.closed)) return false;
    this.startBalance = s.startBalance;
    this.balance = s.balance;
    this.peakBalance = Math.max(s.peakBalance, s.balance);
    this.dayKey = typeof s.dayKey === 'string' ? s.dayKey : null;
    this.dayStartBalance = num(s.dayStartBalance, s.balance);
    this.dayStartUsable = num(s.dayStartUsable, this._usable());
    this.realizedToday = num(s.realizedToday, 0);
    this.pendings = plain(s.pendings);
    this.positions = plain(s.positions);
    this.closed = plain(s.closed);
    this.cancelled = Array.isArray(s.cancelled) ? plain(s.cancelled) : [];
    this.counters = { placed: 0, filled: 0, cancelled: 0, expired: 0, invalidated: 0, byCancelReason: {}, ...(s.counters || {}) };
    this.bars = new Map(Array.isArray(s.bars) ? s.bars : []);
    this.lastEpoch = new Map(Array.isArray(s.lastEpoch) ? s.lastEpoch : []);
    this.lastClose = new Map(Array.isArray(s.lastClose) ? s.lastClose : []);
    this.entryTimes = Array.isArray(s.entryTimes) ? s.entryTimes.filter(Number.isFinite) : [];
    this.seq = Math.max(0, Math.floor(num(s.seq, 0)));
    this.stopped = s.stopped && typeof s.stopped === 'object' ? { on: Boolean(s.stopped.on), reason: s.stopped.reason || null, sinceMs: s.stopped.sinceMs || null } : { on: false, reason: null, sinceMs: null };
    this.lastNowMs = num(s.lastNowMs, 0);
    return true;
  }
}
