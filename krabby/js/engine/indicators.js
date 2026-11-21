// Technical indicators. Pure: arrays in, arrays out. No DOM, no network, nothing at import time.
// Conventions: every series array keeps the input length; warm-up entries are NaN.
// RSI, ATR and ADX use Wilder smoothing. EMA is seeded with the SMA of the first `period` values.
// Bollinger uses the SAMPLE standard deviation (n - 1), the same as util.stdev.

import { mean, stdev } from '../core/util.js';

const nanArray = (n) => new Array(n).fill(NaN);
// Whole-number period >= 1, or NaN. Coerces strings so a form value cannot break the arithmetic.
const toPeriod = (p) => {
  const v = Math.floor(Number(p));
  return v >= 1 ? v : NaN;
};

// Simple moving average. Entry i is the mean of values[i - p + 1 .. i].
export function sma(values, p) {
  const out = nanArray(values.length);
  const per = toPeriod(p);
  if (!per) return out;
  for (let i = per - 1; i < values.length; i++) out[i] = mean(values.slice(i - per + 1, i + 1));
  return out;
}

// Exponential moving average, alpha = 2 / (p + 1). Seeded with the SMA of the first p values, at index p - 1.
export function ema(values, p) {
  const out = nanArray(values.length);
  const per = toPeriod(p);
  if (!per || values.length < per) return out;
  const alpha = 2 / (per + 1);
  let prev = mean(values.slice(0, per));
  out[per - 1] = prev;
  for (let i = per; i < values.length; i++) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

// Wilder RSI. The first value is at index p (it needs p price changes). A flat series reads 50.
function rsiValue(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function rsi(values, p = 14) {
  const n = values.length;
  const out = nanArray(n);
  const per = toPeriod(p);
  if (!per || n <= per) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= per; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / per;
  let avgLoss = loss / per;
  out[per] = rsiValue(avgGain, avgLoss);
  for (let i = per + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (per - 1) + Math.max(d, 0)) / per;
    avgLoss = (avgLoss * (per - 1) + Math.max(-d, 0)) / per;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

// EMA that skips a leading NaN warm-up. Used for the MACD signal line.
function emaAfterWarmup(values, p) {
  const out = nanArray(values.length);
  const start = values.findIndex(Number.isFinite);
  if (start < 0) return out;
  const tail = ema(values.slice(start), p);
  for (let i = 0; i < tail.length; i++) out[start + i] = tail[i];
  return out;
}

// MACD line = EMA(fast) - EMA(slow). Signal = EMA(signal) of the MACD line. Histogram = MACD - signal.
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line = values.map((_, i) => fastLine[i] - slowLine[i]);
  const sig = emaAfterWarmup(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { macd: line, signal: sig, hist };
}

// Bollinger Bands: middle = SMA(p), bands = middle +/- k * sample standard deviation. Needs p >= 2.
export function bollinger(values, p = 20, k = 2) {
  const n = values.length;
  const mid = nanArray(n);
  const upper = nanArray(n);
  const lower = nanArray(n);
  const per = toPeriod(p);
  const width = Number(k);
  if (!per || per < 2 || n < per) return { mid, upper, lower };
  for (let i = per - 1; i < n; i++) {
    const win = values.slice(i - per + 1, i + 1);
    const m = mean(win);
    const band = width * stdev(win);
    mid[i] = m;
    upper[i] = m + band;
    lower[i] = m - band;
  }
  return { mid, upper, lower };
}

// True range per candle. Index 0 has no previous close, so it is NaN.
function trueRange(candles) {
  const tr = nanArray(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return tr;
}

// Wilder ATR. Seeded with the mean of true ranges 1..p, so the first value is at index p.
export function atr(candles, p = 14) {
  const n = candles.length;
  const out = nanArray(n);
  const per = toPeriod(p);
  if (!per || n <= per) return out;
  const tr = trueRange(candles);
  let prev = mean(tr.slice(1, per + 1));
  out[per] = prev;
  for (let i = per + 1; i < n; i++) {
    prev = (prev * (per - 1) + tr[i]) / per;
    out[i] = prev;
  }
  return out;
}

// Directional index (DX) from smoothed sums. Zero when there is no movement.
function dxValue(sPlus, sMinus, sTr) {
  if (!(sTr > 0)) return 0;
  const plusDi = (100 * sPlus) / sTr;
  const minusDi = (100 * sMinus) / sTr;
  const total = plusDi + minusDi;
  return total > 0 ? (100 * Math.abs(plusDi - minusDi)) / total : 0;
}

// Wilder ADX. Directional movement and true range use Wilder sums; the first DX is at index p,
// and the first ADX (mean of the first p DX values) is at index 2p - 1.
export function adx(candles, p = 14) {
  const n = candles.length;
  const out = nanArray(n);
  const per = toPeriod(p);
  if (!per || n < 2 * per) return out;
  const tr = trueRange(candles);
  const plusDm = nanArray(n);
  const minusDm = nanArray(n);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  let sTr = 0;
  let sPlus = 0;
  let sMinus = 0;
  for (let i = 1; i <= per; i++) {
    sTr += tr[i];
    sPlus += plusDm[i];
    sMinus += minusDm[i];
  }
  const dx = nanArray(n);
  dx[per] = dxValue(sPlus, sMinus, sTr);
  for (let i = per + 1; i < n; i++) {
    sTr = sTr - sTr / per + tr[i];
    sPlus = sPlus - sPlus / per + plusDm[i];
    sMinus = sMinus - sMinus / per + minusDm[i];
    dx[i] = dxValue(sPlus, sMinus, sTr);
  }
  let prev = mean(dx.slice(per, 2 * per));
  out[2 * per - 1] = prev;
  for (let i = 2 * per; i < n; i++) {
    prev = (prev * (per - 1) + dx[i]) / per;
    out[i] = prev;
  }
  return out;
}

// True when candle j is strictly higher (field 'high') or strictly lower (field 'low') than its `w` neighbours each side.
function isSwing(candles, j, w, field) {
  const v = candles[j][field];
  for (let k = j - w; k <= j + w; k++) {
    if (k === j) continue;
    const other = candles[k][field];
    if (field === 'high' ? other >= v : other <= v) return false;
  }
  return true;
}

// Latest confirmed swing low (support) and swing high (resistance) among the last `lookback` candles.
// A swing is confirmed only once `wing` candles have formed after it. Null when none exists.
export function swingLevels(candles, lookback = 20, wing = 2) {
  const n = candles.length;
  const w = toPeriod(wing) || 2;
  const span = toPeriod(lookback) || 20;
  let support = null;
  let resistance = null;
  const first = Math.max(w, n - span);
  const lastJ = n - 1 - w;
  for (let j = lastJ; j >= first; j--) {
    if (support === null && isSwing(candles, j, w, 'low')) support = candles[j].low;
    if (resistance === null && isSwing(candles, j, w, 'high')) resistance = candles[j].high;
    if (support !== null && resistance !== null) break;
  }
  return { support, resistance };
}

// Last element of an array, undefined when empty (same as arr.at(-1)).
export const last = (arr) => arr[arr.length - 1];
export const closes = (candles) => candles.map((c) => c.close);
export const highs = (candles) => candles.map((c) => c.high);
export const lows = (candles) => candles.map((c) => c.low);

// ---------- Added for the chart catalogue. Same conventions: arrays keep input length, warm-up is NaN. ----------

// Mean over a window of p; NaN when any value in the window is NaN (so warm-ups propagate).
export function rollingMean(values, p) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (!(p >= 1)) return out;
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) sum += v; else bad += 1;
    if (i >= p) {
      const old = values[i - p];
      if (Number.isFinite(old)) sum -= old; else bad -= 1;
    }
    if (i >= p - 1 && bad === 0) out[i] = sum / p;
  }
  return out;
}

// Smoothed moving average (Wilder). Seeded with the first SMA, then (prev*(p-1)+x)/p.
export function smma(values, p) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (!(p >= 1) || n < p) return out;
  let seed = 0;
  for (let i = 0; i < p; i++) seed += values[i];
  let prev = seed / p;
  out[p - 1] = prev;
  for (let i = p; i < n; i++) {
    prev = (prev * (p - 1) + values[i]) / p;
    out[i] = prev;
  }
  return out;
}

const medianPrice = (c) => c.map((x) => (x.high + x.low) / 2);
const typicalPrice = (c) => c.map((x) => (x.high + x.low + x.close) / 3);

// Commodity Channel Index (p = 20, constant 0.015).
export function cci(candles, p = 20) {
  const tp = typicalPrice(candles);
  const avg = rollingMean(tp, p);
  const out = new Array(candles.length).fill(NaN);
  for (let i = p - 1; i < candles.length; i++) {
    let dev = 0;
    for (let j = i - p + 1; j <= i; j++) dev += Math.abs(tp[j] - avg[i]);
    dev /= p;
    out[i] = dev === 0 ? 0 : (tp[i] - avg[i]) / (0.015 * dev);
  }
  return out;
}

// Stochastic oscillator: %K (smoothed by `slow`) and %D (SMA of %K).
export function stochastic(candles, k = 5, d = 3, slow = 3) {
  const n = candles.length;
  const raw = new Array(n).fill(NaN);
  for (let i = k - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - k + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
    }
    raw[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  const main = rollingMean(raw, slow);
  return { k: main, d: rollingMean(main, d) };
}

// Momentum: price / price[p] x 100.
export function momentum(values, p = 14) {
  const out = new Array(values.length).fill(NaN);
  for (let i = p; i < values.length; i++) {
    if (values[i - p] !== 0) out[i] = (values[i] / values[i - p]) * 100;
  }
  return out;
}

// Envelopes: SMA(p) moved up and down by pct percent.
export function envelopes(values, p = 14, pct = 0.1) {
  const mid = rollingMean(values, p);
  const k = pct / 100;
  return { mid, upper: mid.map((m) => (Number.isFinite(m) ? m * (1 + k) : NaN)), lower: mid.map((m) => (Number.isFinite(m) ? m * (1 - k) : NaN)) };
}

// Ichimoku lines at the current bar. Clouds are not displaced 26 bars forward (the chart draws them at the bar).
export function ichimoku(candles, tenkan = 9, kijun = 26, senkouB = 52) {
  const mid = (len) => {
    const out = new Array(candles.length).fill(NaN);
    for (let i = len - 1; i < candles.length; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - len + 1; j <= i; j++) {
        hi = Math.max(hi, candles[j].high);
        lo = Math.min(lo, candles[j].low);
      }
      out[i] = (hi + lo) / 2;
    }
    return out;
  };
  const t = mid(tenkan);
  const k = mid(kijun);
  const b = mid(senkouB);
  return { tenkan: t, kijun: k, spanA: t.map((v, i) => (Number.isFinite(v) && Number.isFinite(k[i]) ? (v + k[i]) / 2 : NaN)), spanB: b };
}

// Bill Williams Alligator: smoothed median price, jaw 13, teeth 8, lips 5 (not displaced forward).
export function alligator(candles) {
  const m = medianPrice(candles);
  return { jaw: smma(m, 13), teeth: smma(m, 8), lips: smma(m, 5) };
}

// Gator oscillator: |jaw - teeth| above zero, -|teeth - lips| below zero.
export function gator(candles) {
  const a = alligator(candles);
  return {
    upper: a.jaw.map((j, i) => (Number.isFinite(j) && Number.isFinite(a.teeth[i]) ? Math.abs(j - a.teeth[i]) : NaN)),
    lower: a.teeth.map((t, i) => (Number.isFinite(t) && Number.isFinite(a.lips[i]) ? -Math.abs(t - a.lips[i]) : NaN)),
  };
}

// Bill Williams Fractals: a bar whose high (low) is the highest (lowest) of five. Confirmed two bars later.
export function fractals(candles) {
  const n = candles.length;
  const up = new Array(n).fill(NaN);
  const down = new Array(n).fill(NaN);
  for (let i = 2; i < n - 2; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    if (h > candles[i - 1].high && h > candles[i - 2].high && h > candles[i + 1].high && h > candles[i + 2].high) up[i] = h;
    if (l < candles[i - 1].low && l < candles[i - 2].low && l < candles[i + 1].low && l < candles[i + 2].low) down[i] = l;
  }
  return { up, down };
}

// Bears / Bulls power against EMA(p): low - EMA and high - EMA.
export function bearsBulls(candles, p = 13) {
  const e = ema(closes(candles), p);
  return {
    bears: candles.map((c, i) => (Number.isFinite(e[i]) ? c.low - e[i] : NaN)),
    bulls: candles.map((c, i) => (Number.isFinite(e[i]) ? c.high - e[i] : NaN)),
  };
}

// Awesome Oscillator: SMA(5) - SMA(34) of the median price.
export function awesome(candles) {
  const m = medianPrice(candles);
  const f = rollingMean(m, 5);
  const s = rollingMean(m, 34);
  return f.map((v, i) => (Number.isFinite(v) && Number.isFinite(s[i]) ? v - s[i] : NaN));
}

// Accelerator Oscillator: AO - SMA(5) of AO.
export function accelerator(candles) {
  const ao = awesome(candles);
  const s = rollingMean(ao, 5);
  return ao.map((v, i) => (Number.isFinite(v) && Number.isFinite(s[i]) ? v - s[i] : NaN));
}

// DeMarker (0-1): share of upward demand in the last p bars.
export function demarker(candles, p = 14) {
  const n = candles.length;
  const dMax = new Array(n).fill(NaN);
  const dMin = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    dMax[i] = up > 0 ? up : 0;
    dMin[i] = dn > 0 ? dn : 0;
  }
  const a = rollingMean(dMax, p);
  const b = rollingMean(dMin, p);
  return a.map((v, i) => (Number.isFinite(v) && Number.isFinite(b[i]) && v + b[i] > 0 ? v / (v + b[i]) : NaN));
}

// ---------- Trend indicators for the bot methods ----------

// Supertrend: ATR bands around the median price. Trend flips when a close breaks the active band.
export function supertrend(candles, p = 10, mult = 3) {
  const n = candles.length;
  const a = atr(candles, p);
  const trend = new Array(n).fill(null);
  const line = new Array(n).fill(NaN);
  let fu = NaN;
  let fl = NaN;
  let prevClose = NaN;
  let up = true;
  let started = false;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!Number.isFinite(a[i])) { prevClose = c.close; continue; }
    const mid = (c.high + c.low) / 2;
    const bu = mid + mult * a[i];
    const bl = mid - mult * a[i];
    fu = !Number.isFinite(fu) || bu < fu || prevClose > fu ? bu : fu;
    fl = !Number.isFinite(fl) || bl > fl || prevClose < fl ? bl : fl;
    if (!started) { up = c.close >= mid; started = true; }
    else if (up && c.close < fl) up = false;
    else if (!up && c.close > fu) up = true;
    trend[i] = up ? 'up' : 'down';
    line[i] = up ? fl : fu;
    prevClose = c.close;
  }
  return { trend, line };
}

// Donchian channel of the previous p candles. The current candle is not included.
export function donchian(candles, p = 20) {
  const n = candles.length;
  const upper = new Array(n).fill(NaN);
  const lower = new Array(n).fill(NaN);
  for (let i = p; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - p; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

// Directional movement: +DI and -DI with Wilder smoothing.
export function dmi(candles, p = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  }
  const smooth = (arr) => {
    const out = new Array(n).fill(NaN);
    if (n <= p) return out;
    let s = 0;
    for (let i = 1; i <= p; i++) s += arr[i];
    let prev = s;
    out[p] = prev;
    for (let i = p + 1; i < n; i++) {
      prev = prev - prev / p + arr[i];
      out[i] = prev;
    }
    return out;
  };
  const sTr = smooth(tr);
  const sPlus = smooth(plusDM);
  const sMinus = smooth(minusDM);
  return {
    plusDI: sPlus.map((v, i) => (Number.isFinite(v) && sTr[i] > 0 ? (100 * v) / sTr[i] : NaN)),
    minusDI: sMinus.map((v, i) => (Number.isFinite(v) && sTr[i] > 0 ? (100 * v) / sTr[i] : NaN)),
  };
}

// Keltner channel: EMA(emaP) plus or minus mult x ATR(atrP).
export function keltner(candles, emaP = 20, atrP = 10, mult = 2) {
  const mid = ema(closes(candles), emaP);
  const a = atr(candles, atrP);
  return {
    mid,
    upper: mid.map((m, i) => (Number.isFinite(m) && Number.isFinite(a[i]) ? m + mult * a[i] : NaN)),
    lower: mid.map((m, i) => (Number.isFinite(m) && Number.isFinite(a[i]) ? m - mult * a[i] : NaN)),
  };
}
