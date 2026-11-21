// The learning loop. It records every case and what became of it, fits models on closed paper trades, tests them
// out of sample with a walk-forward test, and writes PROPOSALS. A proposal changes nothing. It reaches the settings
// only through approve(): every gate check must pass and a person must type the approval phrase for that proposal.
// The loop never writes settings itself: approve() hands the changes to applySettings(), supplied by the caller.
// Pure apart from the injected audit log, logger, persist function and clock. No DOM and no network.
import { cfgFor, LEARNABLE_KEYS, isLocked } from '../core/schema.js';
import { wilson } from '../core/util.js';
import { can } from '../trading/roles.js';
import { buildFeatures, featureNames } from './features.js';
import { fitModel, predictModel, serialize, deserialize, featureImportance } from './model.js';
import { metricsFor, walkForward, breakEvenRate, calibrationTable, calibrationError, brier, chronoSplit } from './eval.js';
import { gateChecks, approve as gateApprove, MIN_CLOSED_FLOOR, MIN_TAKEN } from './gate.js';
import { replayPlan } from './shadow.js';

const STATE_VERSION = 1;
const MAX_WF_ROWS = 1500;
const MAX_SHADOW_QUEUE = 300;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const plain = (o) => JSON.parse(JSON.stringify(o));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function fail(code, text) {
  const e = new Error(text);
  e.code = code;
  return e;
}

export const familySigOf = (snap) => {
  const f = snap && snap.families && typeof snap.families === 'object' ? snap.families : {};
  return Object.keys(f).filter((k) => f[k]).sort().join('+');
};

// Settings that act as plain filters on the cases that were taken. Only a stricter value than the one in force can be
// judged from past trades, because the cases a looser filter would have let through were never taken.
export const FILTER_SPECS = Object.freeze([
  { key: 'tdc.minEvidence', label: 'Lowest evidence score', grid: [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90], read: (s) => cfgFor('tdc', s).minEvidence, tighter: (v, cur) => v > cur, keep: (snap, side, v) => snap.evidenceRank >= v },
  { key: 'tdc.minFamilies', label: 'Families that must agree', grid: [2, 3, 4], read: (s) => cfgFor('tdc', s).minFamilies, tighter: (v, cur) => v > cur, keep: (snap, side, v) => snap.agreeCount >= v },
  { key: 'ble.maxStopAtr', label: 'Widest buy stop', side: 'buy', grid: [0.8, 1, 1.25, 1.5, 2, 2.5, 3], read: (s) => cfgFor('ble', s).maxStopAtr, tighter: (v, cur) => v < cur, keep: (snap, side, v) => side !== 'buy' || snap.stopAtr <= v },
  { key: 'sle.maxStopAtr', label: 'Widest sell stop', side: 'sell', grid: [0.8, 1, 1.25, 1.5, 2, 2.5, 3], read: (s) => cfgFor('sle', s).maxStopAtr, tighter: (v, cur) => v < cur, keep: (snap, side, v) => side !== 'sell' || snap.stopAtr <= v },
]);

// Win or loss for a closed paper trade, by the chosen label mode.
function labelOf(trade, cfg) {
  if (cfg.labelMode === 'target_hit') return trade.trailingArmed ? 1 : 0;
  if (cfg.labelMode === 'r_multiple') return isNum(trade.rMultiple) && trade.rMultiple >= cfg.labelR ? 1 : 0;
  return trade.netUsd > 0 ? 1 : 0;
}

function shadowLabel(res, cfg) {
  if (cfg.labelMode === 'target_hit') return res.status === 'win' ? 1 : 0;
  if (cfg.labelMode === 'r_multiple') return res.rMultiple >= cfg.labelR ? 1 : 0;
  return res.rMultiple > 0 ? 1 : 0;
}

export class LearningLoop {
  constructor({ getSettings, applySettings = null, persist = null, audit = null, log = null, nowFn = () => Date.now() } = {}) {
    if (typeof getSettings !== 'function') throw new Error('LearningLoop needs getSettings().');
    this.getSettings = getSettings;
    this.applySettings = applySettings;
    this.persist = persist;
    this.audit = audit;
    this.log = log;
    this.nowFn = nowFn;
    this.reset();
  }

  reset() {
    this.rows = []; // every record, in the order cases were seen
    this.proposals = [];
    this.approved = null; // { proposalId, approvedMs, actor, bundle, threshold, names }
    this.shadowQueue = [];
    this.propSeq = 0;
    this.closedAtLastPropose = 0;
    this.lastReport = null;
    this.lastInfo = { reason: 'Nothing has been tried yet.', atMs: null };
  }

  // ---------------------------------------------------------------- small helpers

  _cfg() {
    return cfgFor('ll', this.getSettings());
  }

  _say(level, text, data) {
    try {
      if (this.log && typeof this.log[level] === 'function') this.log[level]('learning', text, data);
    } catch (_) { /* logging must never break learning */ }
  }

  _audit(kind, data, atMs) {
    try {
      if (this.audit) this.audit.append(kind, data, Number.isFinite(atMs) ? atMs : this.nowFn());
    } catch (_) { /* the audit log must never break learning */ }
  }

  _persist() {
    try {
      if (typeof this.persist === 'function') {
        const r = this.persist(this.exportState());
        if (r && typeof r.catch === 'function') r.catch(() => {});
      }
    } catch (_) { /* saving is best effort */ }
  }

  // ---------------------------------------------------------------- recording

  // Called when a case is built. placed: whether an order was actually placed. A case that was refused is only kept
  // when the shadow option is on, and then only to be replayed forward for a counterfactual label.
  recordCase(snap, { caseId, asset, tf, side, nowMs, plan = null, placed = true } = {}) {
    const cfg = this._cfg();
    if (!cfg.enabled || !caseId || !snap) return null;
    if (this.rows.some((r) => r.caseId === caseId)) return null;
    if (!placed && !(cfg.shadow && plan)) return null;
    const rec = {
      caseId, asset, tf: Number(tf), side, nowMs, familySig: familySigOf(snap), kind: placed ? 'real' : 'shadow',
      snap: { ...plain(snap), recentStreak: this._streak() },
      plan: plan ? { side: plan.side, entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr } : null,
      rr: isNum(snap.rr) ? snap.rr : null,
      status: placed ? 'open' : 'queued', y: null, rMultiple: null, netUsd: null, closedMs: null, trailingArmed: false,
    };
    this.rows.push(rec);
    if (!placed) {
      this.shadowQueue.push({ caseId, asset, tf: Number(tf), plan: rec.plan, bars: [] });
      if (this.shadowQueue.length > MAX_SHADOW_QUEUE) {
        const gone = this.shadowQueue.shift();
        const r = this.rows.find((x) => x.caseId === gone.caseId);
        if (r && r.status === 'queued') r.status = 'dropped';
      }
    }
    const cap = Math.max(100, cfg.maxRecords);
    if (this.rows.length > cap) {
      const drop = new Set(this.rows.slice(0, this.rows.length - cap).map((r) => r.caseId));
      this.rows = this.rows.slice(this.rows.length - cap);
      this.shadowQueue = this.shadowQueue.filter((q) => !drop.has(q.caseId));
    }
    return rec.caseId;
  }

  // The closed trade for a placed case. Returns the label (1 or 0), or null when the case is not known.
  recordOutcome(caseId, trade) {
    const rec = this.rows.find((r) => r.caseId === caseId && r.kind === 'real');
    if (!rec || !trade) return null;
    const cfg = this._cfg();
    rec.y = labelOf(trade, cfg);
    rec.rMultiple = isNum(trade.rMultiple) ? trade.rMultiple : null;
    rec.netUsd = isNum(trade.netUsd) ? trade.netUsd : null;
    rec.closedMs = isNum(trade.exitMs) ? trade.exitMs : null;
    rec.trailingArmed = Boolean(trade.trailingArmed);
    rec.status = 'closed';
    return rec.y;
  }

  // A placed order that never filled (cancelled or expired). It has no outcome and is not used for training.
  recordNoFill(caseId, reason = 'nofill') {
    const rec = this.rows.find((r) => r.caseId === caseId && r.kind === 'real');
    if (rec && rec.status === 'open') {
      rec.status = 'nofill';
      rec.noFillReason = reason;
    }
  }

  // One closed candle. Advances the shadow replays for that market. halfSpread comes from the cost settings.
  onCandle({ asset, tf, candle, halfSpread = 0 }) {
    if (!this.shadowQueue.length || !candle) return 0;
    const cfg = this._cfg();
    let done = 0;
    for (const q of [...this.shadowQueue]) {
      if (q.asset !== asset || q.tf !== Number(tf)) continue;
      q.bars.push({ open: candle.open, high: candle.high, low: candle.low, close: candle.close });
      const res = replayPlan({ plan: q.plan, candles: q.bars, horizon: cfg.shadowHorizon, halfSpread });
      if (res.status === 'pending') {
        if (q.bars.length > cfg.shadowHorizon * 2 + 2) this._finishShadow(q, { status: 'nofill' }, cfg);
        continue;
      }
      this._finishShadow(q, res, cfg);
      done += 1;
    }
    return done;
  }

  _finishShadow(q, res, cfg) {
    this.shadowQueue = this.shadowQueue.filter((x) => x !== q);
    const rec = this.rows.find((r) => r.caseId === q.caseId);
    if (!rec) return;
    if (['win', 'loss', 'timeout'].includes(res.status) && isNum(res.rMultiple)) {
      rec.y = shadowLabel(res, cfg);
      rec.rMultiple = res.rMultiple;
      rec.status = 'closed';
      rec.shadowResult = res.status;
    } else {
      rec.status = res.status === 'nofill' ? 'nofill' : 'dropped';
    }
  }

  _streak() {
    const closed = this._real().slice(-12);
    let run = 0;
    for (let i = closed.length - 1; i >= 0; i -= 1) {
      const s = closed[i].y ? 1 : -1;
      if (run === 0 || Math.sign(run) === s) run += s;
      else break;
    }
    return Math.max(-5, Math.min(5, run));
  }

  // ---------------------------------------------------------------- reading

  _real() {
    return this.rows.filter((r) => r.kind === 'real' && r.y !== null).sort((a, b) => a.nowMs - b.nowMs);
  }

  _labelled() {
    return this.rows.filter((r) => r.y !== null).sort((a, b) => a.nowMs - b.nowMs);
  }

  closedCount() {
    return this._real().length;
  }

  status() {
    const cfg = this._cfg();
    const need = Math.max(MIN_CLOSED_FLOOR, cfg.minClosed);
    const closed = this.closedCount();
    return {
      enabled: cfg.enabled, closed, needed: need, ready: closed >= need,
      shadowLabelled: this._labelled().length - closed, shadowQueued: this.shadowQueue.length,
      lastReason: this.lastInfo.reason, lastAtMs: this.lastInfo.atMs,
      model: this.approved ? { proposalId: this.approved.proposalId, approvedMs: this.approved.approvedMs, threshold: this.approved.threshold, kind: this.approved.bundle.kind } : null,
      modelActive: Boolean(cfg.modelActive && this.approved),
    };
  }

  // Win-rate estimate for a kind of setup, from closed real trades. Falls back from the exact group to wider ones.
  estimateFor({ asset, tf, side, familySig } = {}) {
    const cfg = this._cfg();
    const tdc = cfgFor('tdc', this.getSettings());
    const real = this._real();
    if (!real.length) return null;
    const levels = [
      { group: `${asset}|${tf}|${side}|${familySig}`, pick: (r) => r.asset === asset && r.tf === Number(tf) && r.side === side && r.familySig === familySig },
      { group: `${side}|${familySig}`, pick: (r) => r.side === side && r.familySig === familySig },
      { group: side, pick: (r) => r.side === side },
      { group: 'all', pick: () => true },
    ];
    let chosen = null;
    for (const lv of levels) {
      const rows = real.filter(lv.pick);
      if (!rows.length) continue;
      if (!chosen) chosen = { group: lv.group, rows };
      if (rows.length >= tdc.minSamples) {
        chosen = { group: lv.group, rows };
        break;
      }
    }
    if (!chosen) return null;
    const wins = chosen.rows.filter((r) => r.y).length;
    const w = wilson(wins, chosen.rows.length, cfg.z);
    let be = null;
    if (cfg.breakEven === 'payout') {
      const rrs = chosen.rows.map((r) => r.rr).filter((x) => isNum(x) && x > 0);
      be = rrs.length ? 1 / (1 + mean(rrs)) : null;
    } else {
      be = breakEvenRate(chosen.rows.map((r) => ({ y: r.y, r: isNum(r.rMultiple) ? r.rMultiple : r.netUsd })));
    }
    return {
      n: chosen.rows.length, winRate: w.p, lo: w.lo, hi: w.hi, breakEven: be,
      passes: chosen.rows.length >= tdc.minSamples && be !== null && w.lo > be, group: chosen.group,
    };
  }

  // The approved model's win probability for a case, or null (no approved model, or the features no longer match).
  score(snap) {
    if (!this.approved) return null;
    const f = buildFeatures(snap, this._cfg());
    const names = this.approved.names || [];
    if (names.length !== f.names.length || names.some((n, i) => n !== f.names[i])) return null;
    const p = predictModel(this.approved.bundle, f.values);
    return Number.isFinite(p) ? p : null;
  }

  // What the approved model says about a case, when it is switched on (ll.modelActive). It can only hold a case back:
  // { active: false } when there is nothing to apply, otherwise { active: true, p, threshold, pass }.
  // When the model cannot score the case (its features no longer match the settings) it does not filter, and says so.
  modelFilter(snap) {
    const cfg = this._cfg();
    if (!cfg.modelActive || !this.approved) return { active: false };
    const threshold = isNum(cfg.threshold) ? cfg.threshold : this.approved.threshold;
    const p = this.score(snap);
    if (p === null) return { active: true, p: null, threshold, pass: true, note: 'The approved model could not score this case because its features no longer match the settings, so it did not filter it.' };
    return { active: true, p, threshold, pass: p >= threshold };
  }

  // ---------------------------------------------------------------- fitting

  _dataset(rows, cfg) {
    let names = featureNames(cfg);
    const X = rows.map((r) => {
      const f = buildFeatures(r.snap, cfg);
      names = f.names;
      return f.values;
    });
    return { X, y: rows.map((r) => (r.y ? 1 : 0)), names };
  }

  // The probability threshold. With the search option on, it is chosen on the newest slice of the training rows.
  _threshold(train, cfg) {
    if (!cfg.thresholdSearch || train.length < 30) return cfg.threshold;
    const cut = Math.floor(train.length * (1 - Math.min(0.4, Math.max(0.05, cfg.valSplit))));
    const fitRows = train.slice(0, cut);
    const valRows = train.slice(cut);
    const a = this._dataset(fitRows, cfg);
    const bundle = fitModel(a.X, a.y, cfg, a.names);
    const probs = valRows.map((r) => predictModel(bundle, buildFeatures(r.snap, cfg).values));
    let best = null;
    for (let t = 0.3; t <= 0.7001; t += 0.02) {
      const taken = valRows.filter((_, i) => probs[i] >= t);
      const rs = taken.map((r) => r.rMultiple).filter(isNum);
      if (taken.length < Math.max(5, Math.floor(valRows.length * 0.2)) || !rs.length) continue;
      const m = mean(rs);
      if (!best || m > best.m + 1e-9) best = { t, m };
    }
    return best ? Math.round(best.t * 100) / 100 : cfg.threshold;
  }

  _filters(train, settings) {
    const out = [];
    const withR = train.filter((r) => isNum(r.rMultiple));
    for (const spec of FILTER_SPECS) {
      const rows = withR.filter((r) => !spec.side || r.side === spec.side);
      if (rows.length < 40) continue;
      const cur = spec.read(settings);
      const base = mean(rows.map((r) => r.rMultiple));
      let best = null;
      for (const v of spec.grid) {
        if (!spec.tighter(v, cur)) continue;
        const kept = rows.filter((r) => spec.keep(r.snap, r.side, v));
        if (kept.length < Math.max(20, Math.ceil(rows.length * 0.4))) continue;
        const m = mean(kept.map((r) => r.rMultiple));
        if (m > (best ? best.m : base + 0.02)) best = { key: spec.key, label: spec.label, value: v, m, kept: kept.length, of: rows.length };
      }
      if (best) out.push(best);
    }
    return out;
  }

  _fitRule(train, cfg, settings) {
    const d = this._dataset(train, cfg);
    return { bundle: fitModel(d.X, d.y, cfg, d.names), threshold: this._threshold(train, cfg), filters: this._filters(train, settings) };
  }

  _filterPass(filters, rec) {
    return filters.every((f) => FILTER_SPECS.find((s) => s.key === f.key).keep(rec.snap, rec.side, f.value));
  }

  // The honest test: fit on a rolling window, judge on the rows that follow it, never the other way round.
  _walk(rows, cfg, settings) {
    const use = rows.slice(-MAX_WF_ROWS);
    const n = use.length;
    const window = Math.min(cfg.wfWindow, Math.max(30, Math.floor(n * 0.6)));
    const step = Math.min(cfg.wfStep, Math.max(10, Math.floor(n * 0.2)));
    if (n - window - cfg.purge < 10) return { windows: [], rows: [], window, step, purge: cfg.purge, tooFew: true };
    const res = walkForward(use, {
      window, step, purge: cfg.purge,
      fit: (train, test) => {
        const rule = this._fitRule(train, cfg, settings);
        const baseP = train.length ? train.filter((r) => r.y).length / train.length : 0.5;
        return test.map((r) => {
          const p = predictModel(rule.bundle, buildFeatures(r.snap, cfg).values);
          return { p, baseP, take: p >= rule.threshold, filterTake: this._filterPass(rule.filters, r) };
        });
      },
    });
    return { ...res, window, step, purge: cfg.purge, tooFew: false };
  }

  _oosMetrics(rows, cfg) {
    const real = rows.filter((x) => x.record.kind === 'real');
    const recs = real.map((x) => x.record);
    const z = cfg.z;
    const baseline = metricsFor(recs, recs.map(() => 0.5), 0, { take: recs.map(() => true), z });
    const model = metricsFor(recs, real.map((x) => x.out.p), 0, { take: real.map((x) => x.out.take), z });
    const filters = metricsFor(recs, [], 0, { take: real.map((x) => x.out.filterTake), z });
    const y = recs.map((r) => (r.y ? 1 : 0));
    return {
      n: recs.length, baseline, model, filters,
      modelBrier: real.length ? brier(real.map((x) => x.out.p), y) : null,
      baseBrier: real.length ? brier(real.map((x) => x.out.baseP), y) : null,
      calibration: calibrationTable(real.map((x) => x.out.p), y, 10),
      calibrationError: real.length ? calibrationError(calibrationTable(real.map((x) => x.out.p), y, 10)) : null,
    };
  }

  // ---------------------------------------------------------------- proposals

  // Tries to write a proposal. Returns it, or null (and says why in status().lastReason).
  propose(nowMs = this.nowFn()) {
    const cfg = this._cfg();
    const settings = this.getSettings();
    const need = Math.max(MIN_CLOSED_FLOOR, cfg.minClosed);
    const closed = this._real();
    const stop = (reason) => {
      this.lastInfo = { reason, atMs: nowMs };
      this._say('info', `No proposal: ${reason}`);
      return null;
    };
    if (!cfg.enabled) return stop('The learning loop is switched off.');
    if (!can('brain.learn', settings)) return stop('The engine role does not allow learning.');
    if (closed.length < need) return stop(`${closed.length} closed paper trades so far. The loop needs ${need} before it proposes anything.`);
    const rows = this._labelled();
    const wins = closed.filter((r) => r.y).length;
    if (wins === 0 || wins === closed.length) return stop('Every closed trade has the same result, so there is nothing to learn from yet.');

    const walk = this._walk(rows, cfg, settings);
    this.closedAtLastPropose = closed.length;
    if (walk.tooFew || !walk.rows.length) return stop('Too few trades for an out-of-sample test with these window settings.');
    const oos = this._oosMetrics(walk.rows, cfg);
    const rule = this._fitRule(rows, cfg, settings);
    const importance = featureImportance(rule.bundle).slice(0, 12);
    const holdoutSplit = chronoSplit(rows, cfg.testSplit);
    let holdout = null;
    if (holdoutSplit.train.length >= 30 && holdoutSplit.test.length >= 5) {
      const hr = this._fitRule(holdoutSplit.train, cfg, settings);
      const real = holdoutSplit.test.filter((r) => r.kind === 'real');
      if (real.length) holdout = metricsFor(real, real.map((r) => predictModel(hr.bundle, buildFeatures(r.snap, cfg).values)), hr.threshold, { z: cfg.z });
    }

    const notes = [];
    const base = oos.baseline;
    const better = (m) => m && m.taken >= MIN_TAKEN && isNum(m.expectancyR) && m.expectancyR > 0 && isNum(base.expectancyR) && m.expectancyR > base.expectancyR;
    let useModel = better(oos.model) && (!cfg.requireBrier || (isNum(oos.modelBrier) && isNum(oos.baseBrier) && oos.modelBrier < oos.baseBrier));
    if (!useModel) notes.push('The model did not beat taking every trade out of sample, so it is not proposed.');
    let useFilters = rule.filters.length > 0 && better(oos.filters);
    if (rule.filters.length && !useFilters) notes.push('The filter changes did not beat taking every trade out of sample, so they are not proposed.');
    if (!rule.filters.length) notes.push('No stricter filter value improved the average result.');

    const changes = {};
    if (useFilters) for (const f of rule.filters) changes[f.key] = f.value;
    if (useModel) {
      changes['ll.modelActive'] = true;
      changes['ll.threshold'] = Math.round(rule.threshold * 100) / 100;
    }
    const metrics = {
      closed: closed.length,
      labelled: rows.length,
      shadow: rows.length - closed.length,
      overall: metricsFor(closed, closed.map(() => 0.5), 0, { take: closed.map(() => true), z: cfg.z }),
      oos, holdout, importance, window: walk.window, step: walk.step, purge: walk.purge, windows: walk.windows.length, notes,
    };
    this.lastReport = { atMs: nowMs, metrics: plain(metrics), filters: rule.filters.map((f) => ({ key: f.key, label: f.label, value: f.value, kept: f.kept, of: f.of })), proposed: Object.keys(changes).length > 0 };
    if (!Object.keys(changes).length) return stop('Out of sample, nothing beat taking every trade. The numbers are in the report.');

    for (const p of this.proposals) if (p.status === 'proposed') p.status = 'superseded';
    this.propSeq += 1;
    const proposal = {
      id: `L${this.propSeq}`, createdMs: nowMs, status: 'proposed', changes,
      filters: useFilters ? rule.filters.map((f) => ({ key: f.key, label: f.label, value: f.value, kept: f.kept, of: f.of })) : [],
      model: useModel ? serialize(rule.bundle) : null, threshold: useModel ? rule.threshold : null,
      metrics: plain(metrics), notes,
    };
    this.proposals.push(proposal);
    this.lastInfo = { reason: `Proposal ${proposal.id} written.`, atMs: nowMs };
    this._audit('learning_proposal', { id: proposal.id, changes, closed: closed.length, oosTaken: oos.model && oos.model.taken }, nowMs);
    this._say('info', `Proposal ${proposal.id}: ${Object.keys(changes).length} change(s). Nothing is applied until it is approved.`);
    this._persist();
    return plain(proposal);
  }

  // When the loop is on, auto-propose is on, and enough new trades have closed since the last try.
  maybePropose(nowMs = this.nowFn()) {
    const cfg = this._cfg();
    if (!cfg.enabled || !cfg.autoPropose) return null;
    const need = Math.max(MIN_CLOSED_FLOOR, cfg.minClosed);
    const closed = this.closedCount();
    if (closed < need) return null;
    const since = closed - this.closedAtLastPropose;
    if (this.closedAtLastPropose > 0 && since < Math.max(10, Math.floor(need / 4))) return null;
    return this.propose(nowMs);
  }

  find(id) {
    return this.proposals.find((p) => p.id === id) || null;
  }

  // The gate, evaluated now on the closed trades as they stand.
  gate(id) {
    const p = this.find(id);
    if (!p) return null;
    const settings = this.getSettings();
    return gateChecks({ records: this._real(), proposal: p, cfg: this._cfg(), roleOk: can('brain.learn', settings) });
  }

  // The only way a proposal changes anything. Throws unless the phrase matches and every gate check passes.
  approve(id, phrase, actor, nowMs = this.nowFn()) {
    const p = this.find(id);
    if (!p) throw fail('NOT_FOUND', 'There is no such proposal.');
    const gate = this.gate(id);
    const approval = gateApprove(p, phrase, actor, nowMs, gate);
    for (const key of Object.keys(p.changes)) {
      if (!LEARNABLE_KEYS.includes(key) || isLocked(key)) throw fail('KEY_NOT_ALLOWED', `The setting ${key} may not be changed by the learning loop.`);
    }
    if (typeof this.applySettings !== 'function') throw fail('NO_APPLY', 'Nothing is connected to apply the settings.');
    const res = this.applySettings({ ...approval.changes });
    if (!res || res.ok !== true) {
      this._audit('learning_apply_failed', { id, errors: res && res.errors }, nowMs);
      throw fail('APPLY_FAILED', `The settings could not be applied${res && res.errors && res.errors.length ? `: ${res.errors.join('; ')}` : '.'}`);
    }
    if (p.model) {
      const bundle = deserialize(p.model);
      if (bundle) this.approved = { proposalId: p.id, approvedMs: nowMs, actor, bundle, threshold: p.threshold, names: bundle.names || [] };
    }
    p.status = 'approved';
    p.approvedMs = nowMs;
    p.approvedBy = actor;
    this._audit('learning_approved', { id, actor, changes: p.changes, gate: gate.checks.map((c) => `${c.id}:${c.ok ? 'pass' : 'fail'}`) }, nowMs);
    this._say('warn', `Proposal ${id} approved by ${actor}. ${Object.keys(p.changes).length} setting(s) changed.`);
    this._persist();
    return plain(p);
  }

  reject(id, actor = 'user', nowMs = this.nowFn()) {
    const p = this.find(id);
    if (!p || p.status !== 'proposed') return false;
    p.status = 'rejected';
    p.rejectedMs = nowMs;
    p.rejectedBy = actor;
    this._audit('learning_rejected', { id, actor }, nowMs);
    this._persist();
    return true;
  }

  // Removes the approved model. Settings that were changed by approval stay as they are (change them in Settings).
  clearModel(actor = 'user', nowMs = this.nowFn()) {
    if (!this.approved) return false;
    this._audit('learning_model_cleared', { proposalId: this.approved.proposalId, actor }, nowMs);
    this.approved = null;
    this._persist();
    return true;
  }

  // ---------------------------------------------------------------- views and persistence

  list() {
    return this.proposals.slice().reverse().map((p) => plain(p));
  }

  records(limit = 200) {
    return this.rows.slice(-limit).map((r) => ({
      caseId: r.caseId, asset: r.asset, tf: r.tf, side: r.side, kind: r.kind, status: r.status, familySig: r.familySig, nowMs: r.nowMs,
      y: r.y, rMultiple: r.rMultiple, netUsd: r.netUsd, closedMs: r.closedMs,
    }));
  }

  snapshot() {
    const open = this.proposals.find((p) => p.status === 'proposed');
    return {
      records: this.rows.length,
      closed: this.closedCount(),
      status: this.status(),
      report: this.lastReport ? plain(this.lastReport) : null,
      proposals: this.proposals.slice(-20).reverse().map((p) => ({ id: p.id, createdMs: p.createdMs, status: p.status, metrics: plain(p.metrics), changes: { ...p.changes }, filters: plain(p.filters), notes: p.notes, hasModel: Boolean(p.model) })),
      gate: open ? this.gate(open.id) : null,
    };
  }

  exportState() {
    return plain({
      version: STATE_VERSION, rows: this.rows, proposals: this.proposals, propSeq: this.propSeq, closedAtLastPropose: this.closedAtLastPropose,
      approved: this.approved ? { ...this.approved, bundle: serialize(this.approved.bundle) } : null, lastReport: this.lastReport, shadowQueue: this.shadowQueue,
    });
  }

  // Restores saved state. Returns false (and changes nothing) when the data is not usable. A saved model that fails
  // its checks is dropped, not trusted.
  importState(s) {
    if (!s || typeof s !== 'object' || s.version !== STATE_VERSION || !Array.isArray(s.rows) || !Array.isArray(s.proposals)) return false;
    const rows = s.rows.filter((r) => r && typeof r.caseId === 'string' && r.snap && typeof r.snap === 'object');
    this.rows = plain(rows);
    this.proposals = plain(s.proposals.filter((p) => p && typeof p.id === 'string' && p.changes && typeof p.changes === 'object'));
    this.propSeq = Math.max(this.proposals.reduce((m, p) => Math.max(m, Number(String(p.id).slice(1)) || 0), 0), Number(s.propSeq) || 0);
    this.closedAtLastPropose = Number(s.closedAtLastPropose) || 0;
    this.lastReport = s.lastReport && typeof s.lastReport === 'object' ? plain(s.lastReport) : null;
    this.shadowQueue = Array.isArray(s.shadowQueue) ? plain(s.shadowQueue.filter((q) => q && q.plan && Array.isArray(q.bars))) : [];
    this.approved = null;
    if (s.approved && s.approved.bundle) {
      const bundle = deserialize(s.approved.bundle);
      if (bundle) this.approved = { proposalId: s.approved.proposalId, approvedMs: s.approved.approvedMs, actor: s.approved.actor, bundle, threshold: s.approved.threshold, names: bundle.names || [] };
    }
    return true;
  }
}
