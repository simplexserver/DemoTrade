// Backtests: the same trading session that runs live paper trading, driven by stored candles, one closed candle at a time.
// Nothing here can see the future: a candle is shown to the session only after the one before it was fully handled, a
// higher timeframe candle is built only once its last base candle has closed, and a strategy's signals come from the
// sandbox, which gives each bar only the candles up to that bar. Costs (spread, slippage, commission) are the paper trader's.
// Async only so the page stays responsive; the result does not depend on timing. Pure apart from the optional callbacks.
import { TradingSession } from '../runtime/session.js';
import { cfgFor, withValue } from '../core/schema.js';
import { metricsOf, closedSorted } from '../trading/analytics.js';
import { runStrategy } from '../sandbox/host.js';
import { tfSeconds } from '../market/mde.js';
import { ruleSignals, describeRule } from '../learning/scanner.js';

export const WARMUP_BARS = 300;
export const CLUSTER_BARS = 100; // trades opened within the same 100 bars are treated as one cluster when the range of the average is worked out
// The widest values the settings allow for the account-level stops. A backtest that asks for "relaxed" limits uses them so
// that every setup gets measured; a daily loss stop that trips after five losses would otherwise hide most of the sample.
export const RELAXED_LIMITS = Object.freeze({ 'risk.dailyLossPct': 20, 'risk.drawdownPct': 50, 'risk.maxOpen': 10, 'risk.maxPending': 20 });
const MAX_TRADES_RETURNED = 5000;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clone = (x) => JSON.parse(JSON.stringify(x));

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  }
  return out;
}

// The saved values with the backtest's own fields forced: one market, the base timeframe plus the higher ones, nothing else.
export function backtestValues(settings, { asset, tf, htfs, overrides = {} }) {
  let values = merge(clone(settings || {}), {
    data: { assets: [asset], timeframes: [tf, ...htfs], maxBars: 2000 },
    engine: { tradeAssets: [asset], tradeTimeframes: [tf] },
  });
  for (const [key, raw] of Object.entries(overrides)) values = withValue(values, key, raw);
  return values;
}

// Higher timeframes worth running next to the base one: configured, longer, an exact multiple, the two shortest.
export function higherTimeframes(settings, tf) {
  const configured = cfgFor('data', settings).timeframes.map(Number);
  return [...new Set(configured)].filter((x) => x > tf && x % tf === 0).sort((a, b) => a - b).slice(0, 2);
}

function makeYielder(signal, everyMs = 30) {
  let last = Date.now();
  return async () => {
    if (signal && signal.aborted) return false;
    if (Date.now() - last >= everyMs) {
      await new Promise((r) => setTimeout(r, 0));
      last = Date.now();
      if (signal && signal.aborted) return false;
    }
    return true;
  };
}

// Two-sided critical value of Student's t for df degrees of freedom (Cornish-Fisher series; close enough for df >= 3).
function tCrit(z, df) {
  if (!(df >= 1)) return NaN;
  const z3 = z ** 3;
  const z5 = z ** 5;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df);
}

// Mean result per trade in R and its range. Trades that open close together are not independent (they ride the same price
// moves), so with clusterMs the range is built from clusters of trades opened in the same time slice. That is wider, and honest.
export function rStats(trades, z = 1.96, { clusterMs = 0 } = {}) {
  const items = trades.filter((t) => isNum(t.rMultiple));
  const n = items.length;
  if (n === 0) return { n: 0, mean: null, sd: null, lo: null, hi: null, sum: 0, clusters: 0 };
  const sum = items.reduce((a, t) => a + t.rMultiple, 0);
  const mean = sum / n;
  if (n < 2) return { n, mean, sd: null, lo: null, hi: null, sum, clusters: 0 };
  const sd = Math.sqrt(items.reduce((a, t) => a + (t.rMultiple - mean) ** 2, 0) / (n - 1));
  if (!(clusterMs > 0)) {
    const se = sd / Math.sqrt(n);
    return { n, mean, sd, lo: mean - z * se, hi: mean + z * se, sum, clusters: n };
  }
  const groups = new Map();
  for (const t of items) {
    const k = Math.floor((isNum(t.entryMs) ? t.entryMs : 0) / clusterMs);
    groups.set(k, (groups.get(k) || 0) + (t.rMultiple - mean));
  }
  const G = groups.size;
  if (G < 3) return { n, mean, sd, lo: null, hi: null, sum, clusters: G };
  let ss = 0;
  for (const v of groups.values()) ss += v * v;
  const se = Math.sqrt(ss * (G / (G - 1))) / n;
  const crit = tCrit(z, G - 1);
  return { n, mean, sd, lo: mean - crit * se, hi: mean + crit * se, sum, clusters: G };
}

const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : x);
const r3 = (x) => (isNum(x) ? Math.round(x * 1000) / 1000 : x);

// What the numbers say, in plain words, and a label the screens can colour. Conservative: "shown" needs the whole 95%
// range of the average result per trade to sit above zero on enough trades.
export function judge(stats, { minTrades = 30, label = 'out of sample' } = {}) {
  if (!stats || stats.n === 0) return { level: 'none', text: `There are no ${label} trades, so nothing can be said about an edge.` };
  if (stats.n < minTrades || stats.lo === null) {
    return { level: 'unknown', text: `Only ${stats.n} ${label} trades. At least ${minTrades} are needed before the average means anything. The average so far is ${r2(stats.mean)} R per trade.` };
  }
  const range = `95% range ${r2(stats.lo)} to ${r2(stats.hi)} R, ${stats.n} trades`;
  if (stats.lo > 0) return { level: 'shown', text: `Edge shown ${label}: the average result is ${r2(stats.mean)} R per trade after costs (${range}). One test on one sample is not a promise, so keep it running forward on paper.` };
  if (stats.mean > 0) return { level: 'weak', text: `No edge shown ${label}. The average is ${r2(stats.mean)} R per trade after costs, but the range (${r2(stats.lo)} to ${r2(stats.hi)} R over ${stats.n} trades) includes zero or less, so luck explains it just as well.` };
  return { level: 'none', text: `No edge ${label}: the average result is ${r2(stats.mean)} R per trade after costs (${range}).` };
}

function slimTrade(t, segment) {
  return {
    id: t.id, side: t.side, engine: t.engine, strategy: t.strategy, segment, entryMs: t.entryMs, exitMs: t.exitMs, entry: t.entry,
    exitPrice: t.exitPrice, stake: t.stake, riskUsd: t.riskUsd, netUsd: t.netUsd, costUsd: t.costUsd, rMultiple: t.rMultiple,
    exitReason: t.exitReason, openBars: t.openBars, familySig: t.familySig, mfeR: t.mfeR, maeR: t.maeR, result: t.result,
  };
}

function groupSummary(trades, opts) {
  const sorted = closedSorted(trades);
  return { metrics: metricsOf(sorted, opts), r: rStats(sorted, opts.z, { clusterMs: opts.clusterMs }) };
}

// One pass of a session over candles[0..end). Returns the finished trades and what the session counted.
async function runPass({ asset, tf, candles, end, htfs, values, signalsByIndex, strategyName, yielder, report }) {
  const fromStrategy = signalsByIndex !== null;
  const session = new TradingSession({ settings: values, audit: null, learning: false, analysis: !fromStrategy });
  const firstEpoch = candles[0].epoch;
  const finished = [];
  let seen = 0;
  for (let i = 0; i < end; i += 1) {
    const c = candles[i];
    const r = session.ingest({ asset, tf, candle: c, signals: fromStrategy ? (signalsByIndex.get(i) || []) : undefined, strategyName });
    if (r.closed && r.closed.length) {
      const tail = session.trader.closed;
      for (let k = tail.length - 1, left = r.closed.length; k >= 0 && left > 0; k -= 1) {
        if (r.closed.includes(tail[k].id)) { finished.push(tail[k]); left -= 1; }
      }
    }
    for (const htf of htfs) {
      const agg = session.mde.aggregateLast(asset, tf, htf);
      if (agg && agg.epoch >= firstEpoch) session.ingest({ asset, tf: htf, candle: agg });
    }
    seen += 1;
    if (seen % 25 === 0) {
      if (!(await yielder())) return { cancelled: true };
      if (report) report(seen);
    }
  }
  // Anything still open or waiting at the end is not a result: it is reported, not counted.
  const st = session.trader.state(session.nowMs);
  return {
    cancelled: false,
    session,
    trades: finished,
    unfinished: { open: st.positions.length, waiting: st.pendings.length },
    counters: st.counters,
    refusals: session.stats.refusals,
    halts: session.stats.haltBars,
    skipped: session.stats.skipped,
    counts: session.stats.counts,
    errors: session.errors.slice(),
    engineErrors: Object.entries(session.stats.engines).filter(([, e]) => e.errors > 0).map(([code, e]) => `${code}: ${e.lastError}`),
  };
}

function gridCandidates(settings, fromSignals) {
  if (fromSignals) return [];
  const bt = cfgFor('bt', settings);
  const out = [];
  for (const f of bt.gridMinFamilies) {
    for (const rr of bt.gridRR) {
      out.push({ label: `${f} families, ${rr}R`, overrides: { 'tdc.minFamilies': f, 'ble.rr': rr, 'sle.rr': rr } });
    }
  }
  return out;
}

// opts:
//   asset, tf, candles (oldest first, complete candles at tf), settings (saved values), source (strategy code or null),
//   rule (a rule found by the scanner: it is traded with the same paper trader and costs as everything else),
//   strategyName, params (strategy), seed, overrides ({ 'key': value } on top of settings), candidates ([{ label, overrides?, params? }]),
//   limits ('as_set' keeps the account stops as the settings have them; 'relaxed' widens them to measure every setup),
//   oosFraction, signal ({ aborted }), onProgress({ phase, done, total }), workerFactory (tests), minOosTrades.
// Resolves (never rejects) with { ok: true, ... } or { ok: false, code, error }.
export async function runBacktest(opts = {}) {
  const t0 = Date.now();
  const { asset = 'R_100', source = null, rule = null, strategyName = 'strategy', params = {}, seed = 1, signal = null, onProgress = null, workerFactory = null } = opts;
  const fromSignals = Boolean(source || rule);
  const tf = tfSeconds(opts.tf || 60);
  const settings = opts.settings || {};
  const bt = cfgFor('bt', settings);
  const sb = cfgFor('sb', settings);
  const qae = cfgFor('qae', settings);
  const z = qae.z;
  if (!Array.isArray(opts.candles) || opts.candles.length < WARMUP_BARS + 100) {
    return { ok: false, code: 'too_few_candles', error: `A backtest needs at least ${WARMUP_BARS + 100} candles; there are ${Array.isArray(opts.candles) ? opts.candles.length : 0}.` };
  }
  const candles = opts.candles.slice(-bt.maxBars);
  const n = candles.length;
  const oosFraction = isNum(opts.oosFraction) ? Math.min(0.5, Math.max(0.1, opts.oosFraction)) : bt.oosFraction;
  const split = Math.max(WARMUP_BARS + 50, Math.floor(n * (1 - oosFraction)));
  const htfs = higherTimeframes(settings, tf);
  const warnings = [];
  const limits = opts.limits === 'relaxed' ? 'relaxed' : 'as_set';
  const baseOverrides = { ...(limits === 'relaxed' ? RELAXED_LIMITS : {}), ...(opts.overrides || {}) };
  if (limits === 'relaxed') warnings.push('The account stops (daily loss, drawdown, open and pending limits) were widened to their largest allowed values so every setup was measured. Live paper trading keeps your own limits, which means fewer trades, not different odds per trade.');
  const yielder = makeYielder(signal);
  const say = (phase, done, total) => { if (typeof onProgress === 'function') { try { onProgress({ phase, done, total }); } catch (_) { /* a progress hook must not stop a run */ } } };

  let candidates = Array.isArray(opts.candidates) && opts.candidates.length ? opts.candidates : (opts.grid === false ? [] : (opts.grid || bt.grid ? gridCandidates(settings, fromSignals) : []));
  if ((opts.grid || bt.grid) && fromSignals && !(Array.isArray(opts.candidates) && opts.candidates.length)) {
    warnings.push('The parameter grid is for the engines. Give the strategy its own parameter sets to search them.');
  }
  candidates = candidates.slice(0, 40);

  // The strategy's signals for a set of parameters: one sandbox run over the candles it is allowed to see.
  async function signalsFor(p, upTo) {
    if (rule) {
      const sigs = ruleSignals(rule, candles.slice(0, upTo), { tf, expiryBars: 1 });
      const map = new Map();
      for (const sg of sigs) map.set(sg.index, [...(map.get(sg.index) || []), sg]);
      return { ok: true, map, rejected: { total: 0, byReason: {} }, truncated: false, count: sigs.length };
    }
    const r = await runStrategy({
      code: source, candles: candles.slice(0, upTo), params: p, timeoutMs: sb.timeoutMs, maxSignals: sb.maxSignals, maxCodeChars: sb.maxCodeChars,
      warmup: 20, lookback: 500, tf, seed,
    }, workerFactory);
    if (!r.ok) return { ok: false, code: r.code, error: r.error };
    const map = new Map();
    for (const s of r.signals) {
      if (!map.has(s.index)) map.set(s.index, []);
      map.get(s.index).push(s);
    }
    return { ok: true, map, rejected: r.rejected, truncated: r.truncated, count: r.signals.length };
  }

  let chosen = { label: 'as set', overrides: baseOverrides, params };
  let gridReport = null;
  const totalWork = (candidates.length > 1 ? candidates.length * split : 0) + n;
  let doneWork = 0;

  try {
    if (candidates.length > 1) {
      gridReport = [];
      let best = null;
      for (const cand of candidates) {
        const overrides = { ...baseOverrides, ...(cand.overrides || {}) };
        const p = { ...params, ...(cand.params || {}) };
        let sigs = null;
        if (fromSignals) {
          const sg = await signalsFor(p, split);
          if (!sg.ok) return { ok: false, code: sg.code, error: sg.error };
          sigs = sg.map;
        }
        const base = doneWork;
        const pass = await runPass({
          asset, tf, candles, end: split, htfs, values: backtestValues(settings, { asset, tf, htfs, overrides }), signalsByIndex: sigs, strategyName, yielder,
          report: (k) => say('search', base + k, totalWork),
        });
        if (pass.cancelled) return { ok: false, code: 'cancelled', error: 'The backtest was cancelled.' };
        doneWork += split;
        // Only trades after the warm-up count, and only the training part may be looked at here.
        const warmMs = (candles[WARMUP_BARS].epoch) * 1000;
        const inSample = pass.trades.filter((t) => t.entryMs >= warmMs);
        const rs = rStats(inSample, z, { clusterMs: CLUSTER_BARS * tf * 1000 });
        // Score by the pessimistic end of the average, so a lucky small sample does not win.
        const score = rs.n >= 30 && rs.lo !== null ? rs.lo : (rs.mean !== null ? rs.mean - 1 : -Infinity);
        gridReport.push({ label: cand.label, n: rs.n, meanR: r3(rs.mean), lowR: r3(rs.lo), score: r3(score), overrides: cand.overrides || {}, params: cand.params || {} });
        if (!best || score > best.score) best = { cand, score, overrides, p };
      }
      chosen = { label: best.cand.label, overrides: best.overrides, params: best.p };
      warnings.push(`${candidates.length} settings were tried on the training part only and "${chosen.label}" scored best. Only the out-of-sample figures are fair; the in-sample ones are flattering by construction.`);
    }

    let signalsByIndex = null;
    let strategyInfo = null;
    if (fromSignals) {
      const sg = await signalsFor(chosen.params, n);
      if (!sg.ok) return { ok: false, code: sg.code, error: sg.error };
      signalsByIndex = sg.map;
      strategyInfo = { signals: sg.count, rejected: sg.rejected, truncated: sg.truncated };
      if (sg.truncated) warnings.push('The strategy produced more signals than the limit, so the rest were dropped.');
      if (sg.rejected && sg.rejected.total > 0) warnings.push(`${sg.rejected.total} signals were malformed and dropped (${Object.entries(sg.rejected.byReason || {}).map(([k, v]) => `${k} ${v}`).join(', ')}).`);
    }
    const startWork = doneWork;
    const pass = await runPass({
      asset, tf, candles, end: n, htfs, values: backtestValues(settings, { asset, tf, htfs, overrides: chosen.overrides }), signalsByIndex, strategyName, yielder,
      report: (k) => say('run', startWork + k, totalWork),
    });
    if (pass.cancelled) return { ok: false, code: 'cancelled', error: 'The backtest was cancelled.' };
    say('done', totalWork, totalWork);

    // ---- classify: warm-up, in sample, out of sample, by the time the order filled
    const warmMs = candles[WARMUP_BARS].epoch * 1000;
    const splitMs = candles[split].epoch * 1000;
    const all = closedSorted(pass.trades);
    const warm = all.filter((t) => t.entryMs < warmMs);
    const counted = all.filter((t) => t.entryMs >= warmMs);
    const isTrades = counted.filter((t) => t.entryMs < splitMs);
    const oosTrades = counted.filter((t) => t.entryMs >= splitMs);
    const usable = cfgFor('risk', settings).usableCapUsd;
    const opts2 = { z, startBalance: usable, clusterMs: CLUSTER_BARS * tf * 1000 };
    const summary = { all: groupSummary(counted, opts2), is: groupSummary(isTrades, opts2), oos: groupSummary(oosTrades, opts2) };
    const minOos = isNum(opts.minOosTrades) ? opts.minOosTrades : cfgFor('ll', settings).minOosTrades;
    const verdict = {
      oos: judge(summary.oos.r, { minTrades: minOos, label: 'out of sample' }),
      all: judge(summary.all.r, { minTrades: 30, label: 'over the whole period' }),
    };

    // ---- windows: how steady the result is from one stretch of time to the next (a single continuous run, no refit)
    const windows = [];
    const startAt = Math.max(WARMUP_BARS, bt.wfTrain);
    for (let a = startAt; a + bt.wfTest <= n; a += bt.wfStep) {
      const lo = candles[a].epoch * 1000;
      const hi = candles[Math.min(n - 1, a + bt.wfTest)].epoch * 1000;
      const inWin = counted.filter((t) => t.entryMs >= lo && t.entryMs < hi);
      const rs = rStats(inWin, z);
      windows.push({ fromBar: a, toBar: a + bt.wfTest, fromMs: lo, toMs: hi, n: rs.n, sumR: r2(rs.sum), meanR: r3(rs.mean) });
    }
    const withTrades = windows.filter((w) => w.n > 0);
    const windowStats = { windows: windows.length, withTrades: withTrades.length, positive: withTrades.filter((w) => w.sumR > 0).length };

    // ---- costs and the market itself
    const costUsd = counted.reduce((a, t) => a + (isNum(t.costUsd) ? t.costUsd : 0), 0);
    const netUsd = counted.reduce((a, t) => a + (isNum(t.netUsd) ? t.netUsd : 0), 0);
    const first = candles[0];
    const last = candles[n - 1];
    const market = { bars: n, fromMs: first.epoch * 1000, toMs: (last.epoch + tf) * 1000, firstClose: first.close, lastClose: last.close, changePct: first.close ? ((last.close - first.close) / first.close) * 100 : null };
    const costs = {
      spreadPrice: cfgFor('cost', settings).spreadPrice, slippagePrice: cfgFor('cost', settings).slippagePrice, commissionPct: cfgFor('cost', settings).commissionPct,
      totalUsd: costUsd, grossUsd: netUsd + costUsd, netUsd, costShareOfGross: netUsd + costUsd > 0 ? costUsd / (netUsd + costUsd) : null,
    };

    // ---- warnings that change how much to trust the numbers
    if (counted.length < 100) warnings.push(`Only ${counted.length} counted trades. Fewer than 100 closed trades is too few to rely on, whatever the average looks like.`);
    if (oosTrades.length < minOos) warnings.push(`The out-of-sample part has ${oosTrades.length} trades; ${minOos} are needed for a verdict.`);
    const refusedTotal = Object.values(pass.refusals).reduce((a, b) => a + b, 0);
    const belowMin = pass.refusals.stake_below_min || 0;
    if (refusedTotal >= 20 && belowMin / refusedTotal > 0.3) {
      warnings.push(`${belowMin} of ${refusedTotal} refusals were "stake below the minimum": with only $${usable} usable and ${cfgFor('risk', settings).riskPct}% risked per trade, setups with a wide stop are skipped, so the trades taken are the tight-stop ones.`);
    }
    if (pass.unfinished.open || pass.unfinished.waiting) warnings.push(`${pass.unfinished.open} open trades and ${pass.unfinished.waiting} waiting orders at the end are not counted.`);
    if (pass.engineErrors.length) warnings.push(`Engine errors: ${pass.engineErrors.slice(0, 3).join(' | ')}`);
    if (warm.length) warnings.push(`${warm.length} trades in the first ${WARMUP_BARS} bars were left out (warm-up).`);

    const segOf = (t) => (t.entryMs < warmMs ? 'warmup' : (t.entryMs < splitMs ? 'is' : 'oos'));
    return {
      ok: true,
      mode: rule ? 'rule' : (source ? 'strategy' : 'engines'),
      strategy: rule ? describeRule(rule) : (source ? strategyName : null),
      strategyInfo,
      asset, tf, htfs, bars: n, warmupBars: WARMUP_BARS, limits,
      split: { index: split, atMs: splitMs, oosFraction },
      chosen: { label: chosen.label, overrides: chosen.overrides, params: chosen.params },
      grid: gridReport,
      summary,
      verdict,
      windows,
      windowStats,
      costs,
      market,
      trades: all.slice(-MAX_TRADES_RETURNED).map((t) => slimTrade(t, segOf(t))),
      curve: (() => { let e = 0; return counted.map((t) => ({ t: t.exitMs, equity: (e += isNum(t.netUsd) ? t.netUsd : 0) })); })(),
      execution: pass.counters,
      refusals: Object.entries(pass.refusals).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
      halts: Object.entries(pass.halts).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
      unfinished: pass.unfinished,
      warnings,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, code: 'backtest_failed', error: String((e && e.message) || e) };
  }
}
