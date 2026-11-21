// The trading session: everything that runs one paper-trading account, with no server.
// It owns the market data store, the signal board, the 14 analysis engines' pipeline, the case and risk decisions, the paper
// trader and the learning loop, and it moves one closed candle through all of them in a fixed order:
//   1. store the candle   2. the paper trader reads it (fills, stops, trailing)   3. the learning loop reads it
//   4. the analysis engines run   5. cases are built, vetoed or approved, and approved ones become paper orders.
// Real balance and live orders do not exist here: every order is simulated (D14, D15). The same class runs live paper
// trading, replays and backtests; only the candles it is given differ. Pure apart from the injected clock and hooks.
import { cfgFor, normalise, coerce, LEARNABLE_KEYS, isLocked } from '../core/schema.js';
import { Board, AuditLog } from '../engine/board.js';
import { runAnalysis, MIN_BARS } from '../engine/pipeline.js';
import { evaluateCase } from '../engine/risk.js';
import { atr as atrSeries } from '../engine/indicators.js';
import { MarketData, tfSeconds } from '../market/mde.js';
import { PaperTrader } from '../trading/trader.js';
import { performanceReport } from '../trading/analytics.js';
import { dailyState } from '../trading/daily.js';
import { can } from '../trading/roles.js';
import { LearningLoop } from '../learning/loop.js';
import { decideBar } from './decide.js';
import { buildState } from './view.js';

const LOG_CAP = 300;
const ERR_CAP = 50;
const STATE_VERSION = 1;
const plain = (x) => JSON.parse(JSON.stringify(x));

function lastAtr(candles, period) {
  const w = candles.slice(-Math.max(period * 8, 60));
  const s = atrSeries(w, period);
  for (let i = s.length - 1; i >= 0; i -= 1) if (Number.isFinite(s[i])) return s[i];
  return NaN;
}

export class TradingSession {
  // settings: the saved values (any shape normalise accepts). nowFn: wall clock; without one the session uses the
  // time of the last candle it was given, which keeps replays and backtests repeatable.
  // audit: undefined makes a log, null switches it off. learning: true makes a loop, false none, or pass a loop.
  // analysis: false skips the 14 engines (strategy backtests give their own signals).
  constructor({
    settings = {}, nowFn = null, audit, log = null, learning = true, analysis = true, startBalance = null,
    onSettings = null, persistLearning = null, boardMaxPerKey = 200,
  } = {}) {
    this.values = plain(settings || {});
    this.settings = normalise(this.values);
    this._nowFn = typeof nowFn === 'function' ? nowFn : null;
    this.nowMs = 0;
    this.lastCloseMs = 0;
    this.analysis = analysis !== false;
    this.log = log;
    this.onSettings = typeof onSettings === 'function' ? onSettings : null;
    const keep = cfgFor('store', this.settings).keepAudit;
    this.audit = audit === undefined ? new AuditLog({ max: keep }) : audit;
    this.board = new Board({ audit: this.audit, maxPerKey: boardMaxPerKey });
    this.mde = new MarketData({ maxBars: cfgFor('data', this.settings).maxBars, nowFn: () => this.clockNow() });
    this.trader = new PaperTrader({ settings: this.settings, audit: this.audit, log, nowFn: () => this.clockNow() });
    if (Number.isFinite(startBalance) && startBalance > 0) this.trader.resetPaper(startBalance, null, { silent: true });
    if (learning instanceof LearningLoop) this.learning = learning;
    else if (learning === false) this.learning = null;
    else {
      this.learning = new LearningLoop({
        getSettings: () => this.settings, applySettings: (changes) => this.applySettingsChanges(changes),
        persist: persistLearning, audit: this.audit, log, nowFn: () => this.clockNow(),
      });
    }
    this.running = false;
    this.verdicts = [];
    this.caseLog = []; // cases that were built
    this.dropLog = []; // the most recent cases that were dropped, with their reasons
    this.refusalMemo = new Map();
    this.errors = [];
    this.lastMarket = new Map();
    this.stats = {
      engines: {},
      counts: { candles: 0, runs: 0, cases: 0, built: 0, dropped: 0, approved: 0, refused: 0 },
      refusals: {},
      haltBars: {},
      skipped: { duplicate: 0, cooldown: 0, repeat: 0 },
    };
  }

  clockNow() {
    return this._nowFn ? this._nowFn() : this.nowMs;
  }

  // A wall clock for live use (the Deriv feed). Null goes back to the time of the newest candle (simulated and imported data).
  setClock(fn) {
    this._nowFn = typeof fn === 'function' ? fn : null;
  }

  _error(scope, message) {
    this.errors.push({ atMs: this.clockNow(), scope, message: String(message).slice(0, 300) });
    if (this.errors.length > ERR_CAP) this.errors.splice(0, this.errors.length - ERR_CAP);
    if (this.log && typeof this.log.warn === 'function') this.log.warn(scope, String(message));
  }

  // ---------------------------------------------------------------- settings

  // Replaces all saved values. Anything locked or invalid falls back to its default (normalise does that).
  setSettings(values) {
    this.values = plain(values || {});
    this.settings = normalise(this.values);
    this.trader.setSettings(this.settings);
    this.mde.maxBars = Math.max(1, cfgFor('data', this.settings).maxBars);
    return { ok: true };
  }

  // Dotted keys to raw values. All or none: a bad key, a locked key or an unusable value changes nothing.
  // With learnedOnly (the learning loop's route) only the learnable keys are allowed.
  applySettingsChanges(changes, { learnedOnly = true } = {}) {
    const errors = [];
    const next = plain(this.values);
    for (const [key, raw] of Object.entries(changes || {})) {
      if (learnedOnly && (!LEARNABLE_KEYS.includes(key) || isLocked(key))) {
        errors.push(`${key} may not be changed by the learning loop.`);
        continue;
      }
      const res = coerce(key, raw);
      if (!res.ok) {
        errors.push(res.error);
        continue;
      }
      const parts = key.split('.');
      let o = next;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
        o = o[parts[i]];
      }
      o[parts[parts.length - 1]] = res.value;
    }
    if (errors.length) return { ok: false, errors };
    this.setSettings(next);
    if (this.onSettings) {
      try { this.onSettings(plain(this.values)); } catch (e) { this._error('settings', `Saving the settings failed: ${(e && e.message) || e}`); }
    }
    return { ok: true, errors: [] };
  }

  // ---------------------------------------------------------------- data in

  seed(asset, tf, candles, source = null) {
    return this.mde.setSeries(asset, tfSeconds(tf), candles, source);
  }

  candles(asset, tf, n = 500) {
    return this.mde.series(asset, tfSeconds(tf)).slice(-Math.max(1, n));
  }

  _market(asset, tfSec, candles, wallMs) {
    const q = cfgFor('qae', this.settings);
    const m = {
      health: this.mde.health(asset, tfSec, wallMs, cfgFor('data', this.settings)),
      atr: lastAtr(candles, q.atrPeriod),
      spreadPrice: cfgFor('cost', this.settings).spreadPrice,
    };
    this.lastMarket.set(`${asset}|${tfSec}`, m);
    return m;
  }

  _series(asset) {
    return (tfSec) => {
      const s = this.mde.series(asset, tfSec);
      return s.length ? s.slice(-1500) : null;
    };
  }

  _runAnalysis(asset, tfSec, closeMs, market) {
    const candles = this.mde.series(asset, tfSec).slice(-1500);
    const res = runAnalysis({
      asset, tf: tfSec, candles, series: this._series(asset), board: this.board, settings: this.settings, nowMs: closeMs, health: market.health, audit: this.audit !== null,
    });
    this.stats.counts.runs += 1;
    for (const [code, n] of Object.entries(res.perEngine)) {
      const e = this.stats.engines[code] || (this.stats.engines[code] = { runs: 0, lastRunMs: null, lastMessages: 0, totalMessages: 0, errors: 0, lastError: null });
      e.runs += 1;
      e.lastRunMs = closeMs;
      e.lastMessages = n;
      e.totalMessages += n;
    }
    for (const er of res.errors) {
      const e = this.stats.engines[er.engine] || (this.stats.engines[er.engine] = { runs: 0, lastRunMs: null, lastMessages: 0, totalMessages: 0, errors: 0, lastError: null });
      e.errors += 1;
      e.lastError = er.message;
      this._error(`engine.${er.engine}`, er.message);
    }
    return { candles, ...res };
  }

  // Runs the analysis on the newest stored candle without trading, so the screens have something to show after a seed.
  analyseLatest(asset, tf, wallMs = null) {
    const tfSec = tfSeconds(tf);
    const candles = this.mde.series(asset, tfSec);
    if (candles.length < MIN_BARS || !this.analysis) return { ok: false, reason: 'too_few_candles' };
    const last = candles[candles.length - 1];
    const closeMs = (last.epoch + tfSec) * 1000;
    this.nowMs = Math.max(this.nowMs, wallMs ?? closeMs);
    this.lastCloseMs = Math.max(this.lastCloseMs, closeMs);
    const market = this._market(asset, tfSec, candles, wallMs ?? closeMs);
    this._runAnalysis(asset, tfSec, closeMs, market);
    return { ok: true, closeMs };
  }

  // One closed candle. signals (an array, possibly empty) replaces the engines' proposals with a strategy's own.
  // extra: [{ strategyName, signals }] adds more strategy proposals next to whatever else runs (the scanner's rules).
  // Returns { ok, reason?, replaced?, stored?, closeMs, filled, closed, cancelled, built, placed, refused }.
  ingest({ asset, tf, candle, wallMs = null, signals = undefined, strategyName = null, extra = null, source = null, analyse = true } = {}) {
    const tfSec = tfSeconds(tf);
    const pushed = this.mde.push(asset, tfSec, candle, source);
    if (!pushed.ok) {
      this._error('data', `A ${asset} ${tfSec}s candle was refused (${pushed.reason}).`);
      return { ok: false, reason: pushed.reason };
    }
    if (pushed.replaced) return { ok: true, replaced: true };
    const closeMs = (candle.epoch + tfSec) * 1000;
    const wall = Number.isFinite(wallMs) ? wallMs : closeMs;
    this.nowMs = Math.max(this.nowMs, wall);
    this.lastCloseMs = Math.max(this.lastCloseMs, closeMs);
    this.stats.counts.candles += 1;
    const analysed = cfgFor('data', this.settings).timeframes.map(Number).includes(tfSec);
    if (!analyse || !analysed) return { ok: true, stored: true, closeMs };

    const series = this.mde.series(asset, tfSec);
    const market = this._market(asset, tfSec, series, wall);
    const cost = cfgFor('cost', this.settings);
    const out = { ok: true, closeMs, filled: [], closed: [], cancelled: [], built: 0, placed: [], refused: 0 };

    // 2. The paper trader reads the candle.
    const recheck = (pending) => {
      const base = this.trader.accountFor(closeMs);
      const account = { ...base, pendingCount: Math.max(0, base.pendingCount - 1), setupStatus: () => null, hasCase: () => false };
      const caseMsg = { id: pending.caseId, asset, tf: tfSec, plan: { side: pending.side, entry: pending.entry, stop: pending.stop, target: pending.target }, evidence: { rank: 100 } };
      const v = evaluateCase({ caseMsg, settings: this.settings, account, market, reducedNow: false, evidenceRank: 100, nowMs: closeMs });
      return { ok: v.ok, reasons: v.reasons };
    };
    const step = this.trader.onCandle({ asset, tf: tfSec, candle, nowMs: closeMs, recheck });
    out.filled = step.filled;
    out.closed = step.closed;
    out.cancelled = step.cancelled;

    // 3. The learning loop reads it: shadow replays, finished trades, orders that never filled.
    if (this.learning) {
      try {
        this.learning.onCandle({ asset, tf: tfSec, candle, halfSpread: cost.spreadPrice / 2 + cost.slippagePrice });
        for (const id of step.closed) {
          const t = this.trader.closed.find((x) => x.id === id);
          if (t) this.learning.recordOutcome(t.caseId, t);
        }
        for (const id of step.cancelled) {
          const c = this.trader.cancelled.find((x) => x.id === id);
          if (c) this.learning.recordNoFill(c.caseId, c.reason);
        }
      } catch (e) {
        this._error('learning', (e && e.message) || e);
      }
    }

    // 4. The analysis engines.
    if (this.analysis) this._runAnalysis(asset, tfSec, closeMs, market);

    // 5. Cases, risk and orders. Only markets and timeframes that may trade, and only a role that may place trades.
    const eng = cfgFor('engine', this.settings);
    const tradable = can('trade.place', this.settings) && eng.tradeAssets.includes(asset) && eng.tradeTimeframes.map(Number).includes(tfSec);
    const acct = this.trader.accountFor(closeMs);
    const dpt = cfgFor('dpt', this.settings);
    const day = dailyState({ realizedTodayUsd: acct.realizedTodayUsd, floatingUsd: acct.floatingUsd, targetUsd: dpt.targetUsd, includeFloating: dpt.includeFloating, reducedOnTarget: dpt.reducedOnTarget });
    const lastClose = series[series.length - 1].close;
    if (series.length >= MIN_BARS) {
      // Up to three sources of proposals for this bar: the engines, a strategy's own signals (these replace the engines for the
      // bar), and extra signal groups such as rules found by the scanner. Each goes through the same risk checks.
      const groups = [];
      if (Array.isArray(signals)) groups.push({ plans: null, signals, strategyName });
      else if (this.analysis) {
        groups.push({
          plans: [
            ...this.board.query({ topic: 'entries.buy', asset, tf: tfSec, current: true }),
            ...this.board.query({ topic: 'entries.sell', asset, tf: tfSec, current: true }),
          ],
          signals: undefined,
          strategyName: null,
        });
      }
      for (const g of Array.isArray(extra) ? extra : []) {
        if (g && Array.isArray(g.signals) && g.signals.length) groups.push({ plans: null, signals: g.signals, strategyName: g.strategyName || 'strategy' });
      }
      for (const g of groups) {
        let d;
        try {
          d = decideBar({
            asset, tf: tfSec, nowMs: closeMs, settings: this.settings, board: this.board, trader: this.trader, learning: this.learning,
            plans: g.plans, signals: g.signals, strategyName: g.strategyName, market, lastClose, reducedNow: day.mode === 'reduced', tradable, audit: this.audit,
            memo: this.refusalMemo,
          });
        } catch (e) {
          this._error('decide', (e && e.message) || e);
          d = null;
        }
        if (!d) continue;
        if (d.cases.length) {
          this.board.markRun('TDC', asset, tfSec, closeMs);
          this.board.publish(d.cases, { audit: this.audit !== null });
          for (const c of d.cases) (c.type === 'build' ? this.caseLog : this.dropLog).push(c);
          if (this.caseLog.length > LOG_CAP) this.caseLog.splice(0, this.caseLog.length - LOG_CAP);
          if (this.dropLog.length > 100) this.dropLog.splice(0, this.dropLog.length - 100);
        } else if (!Array.isArray(g.signals)) {
          this.board.markRun('TDC', asset, tfSec, closeMs);
        }
        const k = this.stats.counts;
        k.cases += d.cases.length;
        k.built += d.built.length;
        k.dropped += d.cases.filter((c) => c.type === 'drop').length;
        for (const v of d.verdicts) {
          this.verdicts.push(v);
          if (v.ok) k.approved += 1;
          else {
            k.refused += 1;
            out.refused += 1;
            for (const code of v.codes) this.stats.refusals[code] = (this.stats.refusals[code] || 0) + 1;
          }
        }
        if (this.verdicts.length > LOG_CAP) this.verdicts.splice(0, this.verdicts.length - LOG_CAP);
        this.stats.skipped.duplicate += d.skipped.duplicate;
        this.stats.skipped.cooldown += d.skipped.cooldown;
        this.stats.skipped.repeat += d.skipped.repeat;
        for (const code of d.halts) this.stats.haltBars[code] = (this.stats.haltBars[code] || 0) + 1;
        out.built += d.built.length;
        out.placed.push(...d.placed.map((p) => p.id));
      }
    }

    if (this.learning) {
      try { this.learning.maybePropose(closeMs); } catch (e) { this._error('learning', (e && e.message) || e); }
    }
    return out;
  }

  // ---------------------------------------------------------------- the account

  setEmergencyStop(on, reason = 'manual') {
    if (on) this.trader.emergencyStop(reason, this.clockNow());
    else this.trader.clearEmergencyStop(this.clockNow());
    return this.trader.state(this.clockNow()).emergencyStop;
  }

  closeNow(positionId) {
    return this.trader.closeNow(positionId, 'manual', this.clockNow());
  }

  resetPaper(startBalance = null) {
    this.trader.resetPaper(startBalance === null ? undefined : startBalance, this.clockNow() || null);
    this.verdicts = [];
    this.stats.refusals = {};
    this.stats.haltBars = {};
    this.stats.skipped = { duplicate: 0, cooldown: 0, repeat: 0 };
    this.refusalMemo.clear();
    this.stats.counts.approved = 0;
    this.stats.counts.refused = 0;
    return this.trader.state(this.clockNow()).account;
  }

  performance() {
    const t = this.trader.state(this.nowMs);
    return performanceReport(this.trader.trades(), {
      z: cfgFor('qae', this.settings).z,
      rejected: this.stats.refusals,
      expired: t.counters.expired,
      execution: t.counters,
      startBalance: t.account.startBalance,
      resetHour: cfgFor('dpt', this.settings).resetUtcHour,
    });
  }

  // The plain object every screen draws from.
  state(opts = {}) {
    return buildState(this, opts);
  }

  // ---------------------------------------------------------------- saving

  exportState() {
    return {
      version: STATE_VERSION,
      savedMs: this.clockNow(),
      trader: this.trader.saveState(),
      learning: this.learning ? this.learning.exportState() : null,
      verdicts: plain(this.verdicts.slice(-LOG_CAP)),
      stats: plain({ counts: this.stats.counts, refusals: this.stats.refusals, haltBars: this.stats.haltBars, skipped: this.stats.skipped }),
    };
  }

  // Returns { ok, trader, learning }. A part that cannot be read is left as it was.
  importState(s) {
    const res = { ok: false, trader: false, learning: false };
    if (!s || typeof s !== 'object' || s.version !== STATE_VERSION) return res;
    res.trader = Boolean(s.trader) && this.trader.loadState(s.trader);
    res.learning = Boolean(this.learning && s.learning) && this.learning.importState(s.learning);
    if (Array.isArray(s.verdicts)) this.verdicts = plain(s.verdicts.filter((v) => v && typeof v.caseId === 'string').slice(-LOG_CAP));
    if (s.stats && typeof s.stats === 'object') {
      const c = s.stats.counts || {};
      for (const k of Object.keys(this.stats.counts)) if (Number.isFinite(c[k])) this.stats.counts[k] = c[k];
      if (s.stats.refusals && typeof s.stats.refusals === 'object') this.stats.refusals = plain(s.stats.refusals);
      if (s.stats.haltBars && typeof s.stats.haltBars === 'object') this.stats.haltBars = plain(s.stats.haltBars);
      if (s.stats.skipped && typeof s.stats.skipped === 'object') this.stats.skipped = { duplicate: Number(s.stats.skipped.duplicate) || 0, cooldown: Number(s.stats.skipped.cooldown) || 0, repeat: Number(s.stats.skipped.repeat) || 0 };
    }
    res.ok = res.trader || res.learning;
    return res;
  }
}
