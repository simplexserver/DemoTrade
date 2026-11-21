// The opportunity scanner: looks through a long stretch of past candles for conditions that were followed by a profit
// after costs, and tells the truth about what survived.
//
// How it avoids fooling itself (all of this is on purpose):
//  - History is cut into three consecutive parts. TRAIN is used to find candidates. VALIDATION must agree with them. TEST is
//    never looked at until the very end, and it is the only part whose numbers are reported as the expected result.
//  - Every condition tried is counted. The p-values of all of them go through Benjamini-Hochberg, so the more things are
//    tried, the harder it gets to pass. On a market with no pattern, nothing should survive.
//  - A condition may only trade again after its previous trade ended, so one price move is not counted many times.
//  - Costs (spread, slippage, commission) are charged on every trade. The stop is a multiple of the recent range (ATR).
//  - Every feature uses candles up to and including the bar it describes, and nothing later (tested).
//  - How complicated a condition may be grows with the amount of history: one feature for a short history, two for a medium
//    one, three for a long one. More data affords more complexity; less data does not.
// It is a research tool. A survivor is a lead to forward-test on paper, not a promise. Pure: no DOM, storage, network or clock.
import { ema, atr, rsi } from '../engine/indicators.js';

export const WARMUP = 250;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const FEATURES = Object.freeze([
  { id: 'hour', label: 'Hour of day (UTC)', levels: ['00-03', '04-07', '08-11', '12-15', '16-19', '20-23'] },
  { id: 'dow', label: 'Weekday', levels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },
  { id: 'vol', label: 'Volatility', levels: ['quiet', 'normal', 'busy'] },
  { id: 'trend', label: 'Trend', levels: ['down', 'mixed', 'up'] },
  { id: 'rsi', label: 'RSI', levels: ['below 30', '30 to 45', '45 to 55', '55 to 70', 'above 70'] },
  { id: 'dist', label: 'Distance from the 20-bar average', levels: ['far below', 'below', 'near', 'above', 'far above'] },
  { id: 'streak', label: 'Run of closes', levels: ['3+ down', '2 down', '1 down', '1 up', '2 up', '3+ up'] },
  { id: 'bar', label: 'Last candle', levels: ['big bull', 'big bear', 'small', 'ordinary'] },
  { id: 'range', label: 'Last candle size', levels: ['tight', 'normal', 'wide'] },
  { id: 'break', label: '20-bar breakout', levels: ['closed above the high', 'closed below the low', 'inside'] },
  { id: 'sweep', label: 'Liquidity sweep', levels: ['swept the highs', 'swept the lows', 'none'] },
]);
const FEATURE_INDEX = Object.fromEntries(FEATURES.map((f, i) => [f.id, i]));

// ---------------------------------------------------------------- features

// Per-bar level of every feature. Returns { n, f: { id: Int8Array }, atr: Float64Array }. A bar before WARMUP, or one whose
// features cannot be computed, has level -1 for all of them and is never used.
export function computeFeatures(candles, { tf = 60 } = {}) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const a14 = atr(candles, 14);
  const r14 = rsi(closes, 14);
  const f = {};
  for (const feat of FEATURES) f[feat.id] = new Int8Array(n).fill(-1);
  // ATR percentile over the previous 200 bars, by rank. O(n * 200); fine.
  const volPct = new Float64Array(n).fill(NaN);
  for (let i = WARMUP; i < n; i += 1) {
    if (!isNum(a14[i])) continue;
    let below = 0;
    let cnt = 0;
    for (let k = i - 200; k < i; k += 1) {
      if (isNum(a14[k])) { cnt += 1; if (a14[k] < a14[i]) below += 1; }
    }
    if (cnt >= 100) volPct[i] = below / cnt;
  }
  const intraday = tf < 86400;
  for (let i = WARMUP; i < n; i += 1) {
    const c = candles[i];
    const A = a14[i];
    if (!isNum(A) || !(A > 0) || !isNum(e20[i]) || !isNum(e50[i]) || !isNum(r14[i]) || !isNum(volPct[i])) continue;
    const closeMs = (c.epoch + tf) * 1000;
    const d = new Date(closeMs);
    f.hour[i] = intraday ? Math.floor(d.getUTCHours() / 4) : -1;
    f.dow[i] = d.getUTCDay();
    f.vol[i] = volPct[i] < 1 / 3 ? 0 : (volPct[i] < 2 / 3 ? 1 : 2);
    f.trend[i] = c.close > e50[i] && e20[i] > e50[i] ? 2 : (c.close < e50[i] && e20[i] < e50[i] ? 0 : 1);
    const R = r14[i];
    f.rsi[i] = R < 30 ? 0 : (R < 45 ? 1 : (R < 55 ? 2 : (R < 70 ? 3 : 4)));
    const dist = (c.close - e20[i]) / A;
    f.dist[i] = dist < -2 ? 0 : (dist < -0.75 ? 1 : (dist <= 0.75 ? 2 : (dist <= 2 ? 3 : 4)));
    let up = 0;
    let dn = 0;
    for (let k = i; k > i - 3 && k > 0; k -= 1) {
      if (candles[k].close > candles[k - 1].close && dn === 0) up += 1;
      else if (candles[k].close < candles[k - 1].close && up === 0) dn += 1;
      else break;
    }
    f.streak[i] = dn >= 3 ? 0 : (dn === 2 ? 1 : (dn === 1 ? 2 : (up === 1 ? 3 : (up === 2 ? 4 : (up >= 3 ? 5 : 2)))));
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    f.bar[i] = range > 0 && body / range >= 0.7 ? (c.close > c.open ? 0 : 1) : (range > 0 && body / range < 0.3 ? 2 : 3);
    const rr = range / A;
    f.range[i] = rr < 0.7 ? 0 : (rr <= 1.3 ? 1 : 2);
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - 20; k < i; k += 1) { if (candles[k].high > hi) hi = candles[k].high; if (candles[k].low < lo) lo = candles[k].low; }
    f.break[i] = c.close > hi ? 0 : (c.close < lo ? 1 : 2);
    f.sweep[i] = c.high > hi && c.close <= hi ? 0 : (c.low < lo && c.close >= lo ? 1 : 2);
  }
  return { n, f, atr: Float64Array.from(a14, (x) => (isNum(x) ? x : NaN)) };
}

// ---------------------------------------------------------------- outcomes

// The result in R of a trade taken at the open of the bar after i, for both sides. The stop is stopAtr x ATR away and the
// target rr times that. Both stop and target inside one candle count as the stop (the cautious choice). Costs come off
// the result: costPrice is the whole round-trip price cost (spread plus slippage). exit is the bar the trade ended on.
export function outcomes(candles, atrArr, { stopAtr = 1.5, rr = 2, horizon = 24, costPrice = 0 } = {}) {
  const n = candles.length;
  const buy = new Float64Array(n).fill(NaN);
  const sell = new Float64Array(n).fill(NaN);
  const buyExit = new Int32Array(n).fill(-1);
  const sellExit = new Int32Array(n).fill(-1);
  for (let i = WARMUP; i < n - 1; i += 1) {
    const A = atrArr[i];
    if (!(A > 0)) continue;
    const D = stopAtr * A;
    const E = candles[i + 1].open;
    const costR = costPrice / D;
    for (const side of [1, -1]) {
      const stop = E - side * D;
      const target = E + side * rr * D;
      let raw = null;
      let exitBar = Math.min(n - 1, i + horizon);
      for (let j = i + 1; j <= Math.min(n - 1, i + horizon); j += 1) {
        const c = candles[j];
        const o = c.open;
        const stopHit = side === 1 ? c.low <= stop : c.high >= stop;
        const targetHit = side === 1 ? c.high >= target : c.low <= target;
        if (j > i + 1) {
          // A gap through a level fills at the open, not at the level.
          if (side === 1 ? o <= stop : o >= stop) { raw = (side * (o - E)) / D; exitBar = j; break; }
          if (side === 1 ? o >= target : o <= target) { raw = (side * (o - E)) / D; exitBar = j; break; }
        }
        if (stopHit) { raw = -1; exitBar = j; break; }
        if (targetHit) { raw = rr; exitBar = j; break; }
      }
      if (raw === null) raw = (side * (candles[exitBar].close - E)) / D;
      const R = raw - costR;
      if (side === 1) { buy[i] = R; buyExit[i] = exitBar; } else { sell[i] = R; sellExit[i] = exitBar; }
    }
  }
  return { buy, sell, buyExit, sellExit };
}

// ---------------------------------------------------------------- statistics

function normCdf(x) {
  // Abramowitz and Stegun 7.1.26 on erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export function summaryOf(rs, z = 1.96) {
  const n = rs.length;
  if (n === 0) return { n: 0, mean: null, sd: null, t: null, p: null, lo: null, hi: null };
  let s = 0;
  for (const r of rs) s += r;
  const mean = s / n;
  if (n < 2) return { n, mean, sd: null, t: null, p: null, lo: null, hi: null };
  let ss = 0;
  for (const r of rs) ss += (r - mean) ** 2;
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = se > 0 ? mean / se : 0;
  return { n, mean, sd, t, p: 1 - normCdf(t), lo: mean - z * se, hi: mean + z * se };
}

// Benjamini-Hochberg: returns q-values in the input order.
export function bhQ(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(m);
  let next = 1;
  for (let k = m - 1; k >= 0; k -= 1) {
    const val = (order[k][0] * m) / (k + 1);
    next = Math.min(next, val);
    q[order[k][1]] = Math.min(1, next);
  }
  return q;
}

// ---------------------------------------------------------------- the scan

// Takes the trades of one condition and side inside [from, to): bar i is used only if no earlier trade of this condition
// is still running.
function tradesOf(match, outRs, outExit, from, to) {
  const rs = [];
  let freeAt = from;
  for (let i = Math.max(from, WARMUP); i < to; i += 1) {
    if (i < freeAt) continue;
    if (!match(i)) continue;
    const r = outRs[i];
    if (!isNum(r)) continue;
    if (outExit[i] >= to) continue; // a trade that would end after this part is left out, so no label reaches across the cut
    rs.push(r);
    freeAt = outExit[i] + 1;
  }
  return rs;
}

export function autoDepth(bars) {
  return bars < 4000 ? 1 : (bars < 30000 ? 2 : 3);
}

function combos(items, k) {
  const out = [];
  const go = (start, cur) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < items.length; i += 1) { cur.push(items[i]); go(i + 1, cur); cur.pop(); }
  };
  go(0, []);
  return out;
}

export function describeRule(rule) {
  const side = rule.side === 'buy' ? 'Buy' : 'Sell';
  const parts = rule.conds.map((c) => `${FEATURES[FEATURE_INDEX[c.feature]].label.toLowerCase()} is ${FEATURES[FEATURE_INDEX[c.feature]].levels[c.level]}`);
  return `${side} when ${parts.join(' and ')}`;
}

// opts: { tf, costPrice, stopAtr, rr, horizon, trainFrac, valFrac, minTrain, minVal, minTest, q, depth, features, maxConditions,
//         signal, yieldFn }
// Resolves with { ok, ... }. Async only so a long scan can yield to the page; the answer does not depend on timing.
export async function scan(candles, opts = {}) {
  const {
    tf = 60, costPrice = 0, stopAtr = 1.5, rr = 2, horizon = 24, trainFrac = 0.5, valFrac = 0.25, minTrain = 40, minVal = 15,
    minTest = 15, q = 0.1, maxConditions = 30000, signal = null, yieldFn = null,
  } = opts;
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n < WARMUP + 400) return { ok: false, code: 'too_few_candles', error: `The scanner needs at least ${WARMUP + 400} candles; there are ${n}.` };
  const depth = Math.min(3, Math.max(1, Math.floor(opts.depth || autoDepth(n))));
  const feats = (Array.isArray(opts.features) && opts.features.length ? opts.features : FEATURES.map((f) => f.id)).filter((id) => id in FEATURE_INDEX);
  const warnings = [];
  const a = Math.floor(n * trainFrac);
  const b = Math.floor(n * (trainFrac + valFrac));
  const fe = computeFeatures(candles, { tf });
  const usable = feats.filter((id) => fe.f[id][WARMUP + 5] !== -1 || fe.f[id].some((v) => v !== -1));
  const out = outcomes(candles, fe.atr, { stopAtr, rr, horizon, costPrice });
  if (signal && signal.aborted) return { ok: false, code: 'cancelled', error: 'The scan was cancelled.' };
  const tick = async () => {
    if (signal && signal.aborted) return false;
    if (typeof yieldFn === 'function') await yieldFn();
    return !(signal && signal.aborted);
  };

  // Every condition: a list of (feature, level) pairs, 1 to depth of them, on different features.
  const levelsOf = (id) => FEATURES[FEATURE_INDEX[id]].levels.map((_, k) => k);
  const conditions = [];
  for (let d = 1; d <= depth; d += 1) {
    for (const set of combos(usable, d)) {
      const sizes = set.map((id) => levelsOf(id));
      const go = (idx, cur) => {
        if (conditions.length >= maxConditions) return;
        if (idx === set.length) { conditions.push(cur.map((lv, k) => ({ feature: set[k], level: lv }))); return; }
        for (const lv of sizes[idx]) go(idx + 1, [...cur, lv]);
      };
      go(0, []);
    }
  }
  if (conditions.length >= maxConditions) warnings.push(`There were more candidate conditions than the limit of ${maxConditions}, so the later ones were not tried.`);

  const matcherFor = (conds) => {
    const arrs = conds.map((c) => fe.f[c.feature]);
    const lvls = conds.map((c) => c.level);
    if (arrs.length === 1) { const A = arrs[0]; const L = lvls[0]; return (i) => A[i] === L; }
    if (arrs.length === 2) { const A = arrs[0]; const B = arrs[1]; const L0 = lvls[0]; const L1 = lvls[1]; return (i) => A[i] === L0 && B[i] === L1; }
    return (i) => { for (let k = 0; k < arrs.length; k += 1) if (arrs[k][i] !== lvls[k]) return false; return true; };
  };

  // 1. TRAIN: every condition on both sides.
  const tested = [];
  let step = 0;
  for (const conds of conditions) {
    const match = matcherFor(conds);
    for (const side of ['buy', 'sell']) {
      const rs = tradesOf(match, side === 'buy' ? out.buy : out.sell, side === 'buy' ? out.buyExit : out.sellExit, WARMUP, a);
      if (rs.length < minTrain) continue;
      const s = summaryOf(rs);
      tested.push({ conds, side, train: s, match });
    }
    step += 1;
    if (step % 20 === 0 && !(await tick())) return { ok: false, code: 'cancelled', error: 'The scan was cancelled.' };
  }
  const qs = bhQ(tested.map((t) => (t.train.p === null ? 1 : t.train.p)));
  tested.forEach((t, i) => { t.train.q = qs[i]; });
  const candidates = tested.filter((t) => t.train.mean > 0 && t.train.q <= q);

  // 2. VALIDATION and 3. TEST for the candidates only.
  const survivors = [];
  const rejected = [];
  for (const cd of candidates) {
    const outRs = cd.side === 'buy' ? out.buy : out.sell;
    const outEx = cd.side === 'buy' ? out.buyExit : out.sellExit;
    const val = summaryOf(tradesOf(cd.match, outRs, outEx, a, b));
    const test = summaryOf(tradesOf(cd.match, outRs, outEx, b, n));
    const rule = { side: cd.side, conds: cd.conds, stopAtr, rr, horizon };
    const rec = { rule, text: describeRule(rule), train: cd.train, val, test };
    const valOk = val.n >= minVal && val.mean > 0 && val.p !== null && val.p < 0.1;
    const testOk = test.n >= minTest && test.lo !== null && test.lo > 0;
    rec.status = !valOk ? 'failed_validation' : (!testOk ? 'failed_test' : 'survived');
    (rec.status === 'survived' ? survivors : rejected).push(rec);
  }
  survivors.sort((x, y) => y.test.lo - x.test.lo);
  rejected.sort((x, y) => (y.train.mean ?? -9) - (x.train.mean ?? -9));

  // The strongest-looking conditions that did not hold up, so the screen can show how misleading training results are.
  const nearMisses = rejected.slice(0, 5);
  const bestTrain = tested.slice().sort((x, y) => (y.train.t ?? -99) - (x.train.t ?? -99)).slice(0, 5).map((t) => ({ text: describeRule({ side: t.side, conds: t.conds }), train: t.train }));

  const verdict = survivors.length
    ? { level: 'shown', text: `${survivors.length} of ${tested.length} conditions held up on data they had never seen. The best: "${survivors[0].text}" averaged ${(survivors[0].test.mean).toFixed(2)} R per trade after costs on the untouched test part (95% range ${survivors[0].test.lo.toFixed(2)} to ${survivors[0].test.hi.toFixed(2)} R, ${survivors[0].test.n} trades). That is a lead to forward-test on paper, not a promise.` }
    : { level: 'none', text: tested.length === 0
      ? 'No condition came up often enough in the training part to test.'
      : `No pattern survived. ${tested.length} conditions were tested${candidates.length ? `; ${candidates.length} looked good in training but none held up on unseen data` : ' and none looked better than luck once the number tried was taken into account'}. On this history, after costs, there is nothing here to trade.` };

  if (n < 4000 && depth === 1) warnings.push('The history is short, so only single conditions were tried. A longer history allows combinations.');
  return {
    ok: true, bars: n, depth, features: usable, segments: { train: [WARMUP, a], validation: [a, b], test: [b, n] },
    tried: conditions.length, tested: tested.length, candidates: candidates.length, survivors, nearMisses, bestTrain, verdict, warnings,
    settings: { tf, costPrice, stopAtr, rr, horizon, trainFrac, valFrac, minTrain, minVal, minTest, q },
  };
}

// ---------------------------------------------------------------- using a rule

// The condition at the last candle of a window, using the same features the scan used. Returns true or false.
export function ruleMatchesLast(rule, candles, tf = 60) {
  if (!Array.isArray(candles) || candles.length < WARMUP + 5) return false;
  const win = candles.slice(-(WARMUP + 260));
  const fe = computeFeatures(win, { tf });
  const i = win.length - 1;
  return rule.conds.every((c) => fe.f[c.feature][i] === c.level);
}

// The signal a rule gives on a candle that closed at `close` when the average range is `atr`: a limit order at the close,
// with the stop and target at the rule's own multiples. Returns null when the range is unusable.
export function signalFor(rule, { close, atr: A, expiryBars = 1 }) {
  if (!(A > 0) || !(close > 0)) return null;
  const D = (rule.stopAtr || 1.5) * A;
  const dir = rule.side === 'buy' ? 1 : -1;
  return { side: rule.side, entry: close, stop: close - dir * D, target: close + dir * (rule.rr || 2) * D, reason: describeRule(rule), expiryBars };
}

// Which of these rules hold on the last candle of the window? Features are worked out once for all of them.
// rules: rule objects or entries with a .rule. Returns [{ entry, rule, atr, close }].
export function matchingRules(rules, candles, tf = 60) {
  if (!Array.isArray(rules) || !rules.length || !Array.isArray(candles) || candles.length < WARMUP + 5) return [];
  const win = candles.slice(-(WARMUP + 260));
  const fe = computeFeatures(win, { tf });
  const i = win.length - 1;
  const out = [];
  for (const entry of rules) {
    const rule = entry && entry.rule ? entry.rule : entry;
    if (!rule || !Array.isArray(rule.conds)) continue;
    if (rule.conds.every((c) => fe.f[c.feature][i] === c.level)) out.push({ entry, rule, atr: fe.atr[i], close: win[i].close });
  }
  return out;
}

// Strategy signals for every bar of a history (for the backtester): { index, side, entry, stop, target, reason }.
// The entry is the signal candle's close, as for every strategy; the stop and target follow the rule's own multiples.
export function ruleSignals(rule, candles, { tf = 60, expiryBars = 1 } = {}) {
  const fe = computeFeatures(candles, { tf });
  const sigs = [];
  for (let i = WARMUP; i < candles.length; i += 1) {
    if (!rule.conds.every((c) => fe.f[c.feature][i] === c.level)) continue;
    const sig = signalFor(rule, { close: candles[i].close, atr: fe.atr[i], expiryBars });
    if (sig) sigs.push({ index: i, ...sig });
  }
  return sigs;
}
