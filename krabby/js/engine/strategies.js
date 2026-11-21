// Strategy signals. Pure: candles and params in, 'up' | 'down' | null out. No DOM, no network.
// 'up' means Rise, Multiplier Up or Buy. 'down' means Fall, Multiplier Down or Sell.
// Each signal uses only candles up to its own index, so the series never looks ahead.
// The newest closed candle is the LAST index of the array.

import { STRATEGY_BY_ID } from '../config.js';
import { adx, atr, bollinger, closes, donchian, dmi, ema, ichimoku, keltner, macd, rsi, supertrend, swingLevels } from './indicators.js';
import { fmtNum, mean, round, toNumber } from '../core/util.js';

const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const GRID_WINDOW = 20;
const REGIME_ADX = 25; // ADX at or above this reads as a trend, below it as a range.
const NOT_ENOUGH = "Not enough candles yet for this strategy's indicators.";

const hold = (reason) => ({ dir: null, reason });
const num = (x, digits = 1) => fmtNum(x, digits);
const price = (x) => String(round(x, 4));

// Merge caller params over the catalogue defaults. Numeric defaults are coerced, so "30" from a form still works.
function resolveParams(strategyId, params) {
  const base = STRATEGY_BY_ID[strategyId]?.params || {};
  const out = { ...base };
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    if (typeof base[key] === 'number' || key === 'adxMinOverride') out[key] = toNumber(value, base[key]);
    else out[key] = value;
  }
  return out;
}

// ADX minimum for trend entries: the momentum override when the caller gives one, otherwise params.adxMin.
const adxThreshold = (p) => (Number.isFinite(p.adxMinOverride) ? p.adxMinOverride : p.adxMin);

// 'up' when the fast line crossed above the slow line on candle i, 'down' when it crossed below, else null.
function crossAt(fast, slow, i) {
  if (i < 1) return null;
  const f0 = fast[i - 1];
  const s0 = slow[i - 1];
  const f1 = fast[i];
  const s1 = slow[i];
  if (![f0, s0, f1, s1].every(Number.isFinite)) return null;
  if (f0 <= s0 && f1 > s1) return 'up';
  if (f0 >= s0 && f1 < s1) return 'down';
  return null;
}

// Mean reversion on Bollinger Bands and RSI. A numeric adxMax adds the range-only filter; null skips it.
function bandRsiPlan(candles, p, adxMax) {
  const c = closes(candles);
  const bands = bollinger(c, p.bbPeriod, p.bbK);
  const r = rsi(c, p.rsiPeriod);
  const adxSeries = adxMax === null ? null : adx(candles, ADX_PERIOD);
  return {
    at(i) {
      const close = c[i];
      const lo = bands.lower[i];
      const hi = bands.upper[i];
      const rv = r[i];
      if (![close, lo, hi, rv].every(Number.isFinite)) return hold(NOT_ENOUGH);
      if (adxSeries) {
        if (!Number.isFinite(adxSeries[i])) return hold(NOT_ENOUGH);
        if (adxSeries[i] >= adxMax) {
          return hold(`ADX ${num(adxSeries[i])} is at or above ${adxMax}, so the market is trending. Mean reversion stays out.`);
        }
      }
      if (close < lo && rv < p.rsiLow) {
        return { dir: 'up', reason: `Close ${price(close)} is below the lower band ${price(lo)} and RSI ${num(rv)} is under ${p.rsiLow}. Rise signal.` };
      }
      if (close > hi && rv > p.rsiHigh) {
        return { dir: 'down', reason: `Close ${price(close)} is above the upper band ${price(hi)} and RSI ${num(rv)} is over ${p.rsiHigh}. Fall signal.` };
      }
      if (close < lo) return hold(`Close is below the lower band, but RSI ${num(rv)} is not under ${p.rsiLow}. No signal.`);
      if (close > hi) return hold(`Close is above the upper band, but RSI ${num(rv)} is not over ${p.rsiHigh}. No signal.`);
      return hold('Close is inside the Bollinger Bands. No signal.');
    },
  };
}

// Trend: EMA fast/slow cross, confirmed by the MACD histogram sign and an ADX minimum.
function trendPlan(candles, p) {
  const c = closes(candles);
  const fast = ema(c, p.emaFast);
  const slow = ema(c, p.emaSlow);
  const m = macd(c, p.macdFast, p.macdSlow, p.macdSignal);
  const adxSeries = adx(candles, ADX_PERIOD);
  const minAdx = adxThreshold(p);
  return {
    at(i) {
      const cross = crossAt(fast, slow, i);
      if (!cross) return hold(`No EMA ${p.emaFast} / EMA ${p.emaSlow} cross on the last closed candle.`);
      const word = cross === 'up' ? 'above' : 'below';
      const hist = m.hist[i];
      const av = adxSeries[i];
      if (!Number.isFinite(hist) || !Number.isFinite(av)) return hold(NOT_ENOUGH);
      if (av < minAdx) {
        return hold(`EMA ${p.emaFast} crossed ${word} EMA ${p.emaSlow}, but ADX ${num(av)} is under the minimum of ${minAdx}.`);
      }
      const macdAgrees = cross === 'up' ? hist > 0 : hist < 0;
      if (!macdAgrees) {
        return hold(`EMA ${p.emaFast} crossed ${word} EMA ${p.emaSlow}, but the MACD histogram ${cross === 'up' ? 'is not positive' : 'is not negative'}.`);
      }
      return {
        dir: cross,
        reason: `EMA ${p.emaFast} crossed ${word} EMA ${p.emaSlow}, MACD histogram agrees and ADX ${num(av)} clears ${minAdx}. ${cross === 'up' ? 'Rise' : 'Fall'} signal.`,
      };
    },
  };
}

// Plain EMA cross with no filters (used by Scalping).
function crossPlan(candles, fastN, slowN) {
  const c = closes(candles);
  const fast = ema(c, fastN);
  const slow = ema(c, slowN);
  return {
    at(i) {
      const cross = crossAt(fast, slow, i);
      if (!cross) return hold(`No EMA ${fastN} / EMA ${slowN} cross on the last closed candle.`);
      const word = cross === 'up' ? 'above' : 'below';
      return { dir: cross, reason: `EMA ${fastN} crossed ${word} EMA ${slowN}. ${cross === 'up' ? 'Rise' : 'Fall'} signal.` };
    },
  };
}

// Grid: in a range (ADX below adxMax), ladders sit at mid +/- k * atrSpacing * ATR, where mid is the mean of the last 20 closes.
// The signal fires at the nearest rung: close at or below the lowest buy level, or at or above the highest sell level.
function gridPlan(candles, p) {
  const c = closes(candles);
  const a = atr(candles, ATR_PERIOD);
  const adxSeries = adx(candles, ADX_PERIOD);
  const rungs = Math.max(1, Math.floor(Number(p.levels)) || 1);
  return {
    at(i) {
      if (i < GRID_WINDOW - 1 || !Number.isFinite(a[i]) || !Number.isFinite(adxSeries[i])) return hold(NOT_ENOUGH);
      const step = p.atrSpacing * a[i];
      const mid = mean(c.slice(i - GRID_WINDOW + 1, i + 1));
      const lower = [];
      const upper = [];
      for (let k = 1; k <= rungs; k++) {
        lower.push(mid - k * step);
        upper.push(mid + k * step);
      }
      const levels = { mid, step, lower, upper };
      const av = adxSeries[i];
      if (av >= p.adxMax) {
        return { dir: null, reason: `ADX ${num(av)} is at or above ${p.adxMax}, so the market is trending. The grid stays out.`, levels };
      }
      if (c[i] <= lower[0]) {
        return { dir: 'up', reason: `Close ${price(c[i])} is at or below the nearest buy level ${price(lower[0])}. Range market, ADX ${num(av)}.`, levels };
      }
      if (c[i] >= upper[0]) {
        return { dir: 'down', reason: `Close ${price(c[i])} is at or above the nearest sell level ${price(upper[0])}. Range market, ADX ${num(av)}.`, levels };
      }
      return { dir: null, reason: 'Price is between the nearest buy and sell levels. No signal.', levels };
    },
  };
}

// DCA: a dip is a close more than atrSpacing * ATR below EMA(emaSlow). Only 'up' (buy) signals.
function dcaPlan(candles, p) {
  const c = closes(candles);
  const e = ema(c, p.emaSlow);
  const a = atr(candles, ATR_PERIOD);
  return {
    at(i) {
      if (!Number.isFinite(e[i]) || !Number.isFinite(a[i])) return hold(NOT_ENOUGH);
      const trigger = e[i] - p.atrSpacing * a[i];
      if (c[i] < trigger) {
        return { dir: 'up', reason: `Close ${price(c[i])} is more than ${p.atrSpacing} ATR below EMA ${p.emaSlow} (${price(e[i])}). Dip buy.` };
      }
      return hold(`Close ${price(c[i])} is not yet ${p.atrSpacing} ATR below EMA ${p.emaSlow}. No dip.`);
    },
  };
}

// Strategies that never produce an entry signal from candles.
const fixedPlan = (reason) => ({ at: () => hold(reason) });

// Smart Limit as a fill test: consolidation (ADX below adxMax) and a close inside the buy-limit zone just above
// swing support (or the sell-limit zone just below resistance). That is the bar on which a virtual limit would fill.
function smartLimitPlan(candles, p) {
  const c = closes(candles);
  const adxS = adx(candles, ADX_PERIOD);
  const a = atr(candles, ATR_PERIOD);
  return {
    at(i) {
      if (!Number.isFinite(adxS[i]) || !Number.isFinite(a[i])) return hold(NOT_ENOUGH);
      if (adxS[i] >= p.adxMax) return hold(`ADX ${num(adxS[i])} is at or above ${p.adxMax}. No consolidation, so no limit plan.`);
      const { support, resistance } = swingLevels(candles.slice(0, i + 1), p.lookback, 2);
      if (support === null || resistance === null) return hold('No confirmed swing levels yet.');
      const buffer = p.bufferAtr * a[i];
      const buyAt = support + buffer;
      const sellAt = resistance - buffer;
      const levels = { buy: buyAt, sell: sellAt, support, resistance };
      if (c[i] <= buyAt && c[i] > support) {
        return { dir: 'up', reason: `Close ${price(c[i])} is inside the buy-limit zone above support ${price(support)}. Consolidation, ADX ${num(adxS[i])}.`, levels };
      }
      if (c[i] >= sellAt && c[i] < resistance) {
        return { dir: 'down', reason: `Close ${price(c[i])} is inside the sell-limit zone below resistance ${price(resistance)}. Consolidation, ADX ${num(adxS[i])}.`, levels };
      }
      return { dir: null, reason: 'Price is not at a support or resistance zone yet.', levels };
    },
  };
}

// Supertrend: a flip of the trend on the closed candle is the signal. Holding a trend is not an entry.
function supertrendPlan(candles, p) {
  const st = supertrend(candles, p.atrPeriod, p.multiplier);
  return {
    at(i) {
      const t = st.trend[i];
      const prev = st.trend[i - 1];
      if (!t || !prev) return hold(NOT_ENOUGH);
      if (t === prev) return hold(`Supertrend is still ${t}. No flip on this candle.`);
      return { dir: t, reason: `Supertrend flipped ${t} on this candle (line ${price(st.line[i])}). ${t === 'up' ? 'Rise' : 'Fall'} signal.` };
    },
  };
}

// Donchian breakout: the close moves beyond the previous N-candle high or low for the first time.
function donchianPlan(candles, p) {
  const c = closes(candles);
  const ch = donchian(candles, p.period);
  return {
    at(i) {
      if (i < 1 || !Number.isFinite(ch.upper[i]) || !Number.isFinite(ch.upper[i - 1])) return hold(NOT_ENOUGH);
      if (c[i] > ch.upper[i] && !(c[i - 1] > ch.upper[i - 1])) {
        return { dir: 'up', reason: `Close ${price(c[i])} broke above the ${p.period}-candle high ${price(ch.upper[i])}. Rise signal.` };
      }
      if (c[i] < ch.lower[i] && !(c[i - 1] < ch.lower[i - 1])) {
        return { dir: 'down', reason: `Close ${price(c[i])} broke below the ${p.period}-candle low ${price(ch.lower[i])}. Fall signal.` };
      }
      return hold(`Close ${price(c[i])} is inside the ${p.period}-candle channel.`);
    },
  };
}

// MACD trend cross: the MACD line crosses its signal line on the trend side of zero.
function macdCrossPlan(candles, p) {
  const c = closes(candles);
  const m = macd(c, p.fast, p.slow, p.signal);
  return {
    at(i) {
      const cross = crossAt(m.macd, m.signal, i);
      if (!cross) return hold('No MACD / signal cross on this candle.');
      if (cross === 'up' && m.macd[i] > 0) return { dir: 'up', reason: `MACD crossed above its signal line above zero (${num(m.macd[i], 5)}). Rise signal.` };
      if (cross === 'down' && m.macd[i] < 0) return { dir: 'down', reason: `MACD crossed below its signal line below zero (${num(m.macd[i], 5)}). Fall signal.` };
      return hold(`MACD crossed ${cross} on the wrong side of zero. No trend-side signal.`);
    },
  };
}

// Ichimoku: Tenkan crosses Kijun, and the close sits beyond the cloud on the same side.
function ichimokuPlan(candles, p) {
  const c = closes(candles);
  const ich = ichimoku(candles, p.tenkan, p.kijun, p.senkou);
  return {
    at(i) {
      const cross = crossAt(ich.tenkan, ich.kijun, i);
      if (!cross) return hold('No Tenkan / Kijun cross on this candle.');
      const top = Math.max(ich.spanA[i], ich.spanB[i]);
      const bottom = Math.min(ich.spanA[i], ich.spanB[i]);
      if (!Number.isFinite(top)) return hold(NOT_ENOUGH);
      if (cross === 'up' && c[i] > top) return { dir: 'up', reason: `Tenkan crossed above Kijun and the close ${price(c[i])} is above the cloud (top ${price(top)}). Rise signal.` };
      if (cross === 'down' && c[i] < bottom) return { dir: 'down', reason: `Tenkan crossed below Kijun and the close ${price(c[i])} is below the cloud (bottom ${price(bottom)}). Fall signal.` };
      return hold('The Tenkan / Kijun cross is inside the cloud or against it. No signal.');
    },
  };
}

// DMI: +DI crosses -DI while ADX is at or above the minimum.
function dmiPlan(candles, p) {
  const d = dmi(candles, p.period);
  const adxS = adx(candles, ADX_PERIOD);
  return {
    at(i) {
      const cross = crossAt(d.plusDI, d.minusDI, i);
      if (!cross) return hold('No +DI / -DI cross on this candle.');
      if (!Number.isFinite(adxS[i])) return hold(NOT_ENOUGH);
      if (adxS[i] < p.adxMin) return hold(`+DI / -DI crossed, but ADX ${num(adxS[i])} is under ${p.adxMin}.`);
      return { dir: cross, reason: `+DI crossed ${cross === 'up' ? 'above' : 'below'} -DI with ADX ${num(adxS[i])} at or above ${p.adxMin}. ${cross === 'up' ? 'Rise' : 'Fall'} signal.` };
    },
  };
}

// Keltner breakout: the close moves beyond the upper or lower channel for the first time.
function keltnerPlan(candles, p) {
  const c = closes(candles);
  const k = keltner(candles, p.emaPeriod, p.atrPeriod, p.multiplier);
  return {
    at(i) {
      if (i < 1 || !Number.isFinite(k.upper[i]) || !Number.isFinite(k.upper[i - 1])) return hold(NOT_ENOUGH);
      if (c[i] > k.upper[i] && !(c[i - 1] > k.upper[i - 1])) return { dir: 'up', reason: `Close ${price(c[i])} broke above the upper Keltner band ${price(k.upper[i])}. Rise signal.` };
      if (c[i] < k.lower[i] && !(c[i - 1] < k.lower[i - 1])) return { dir: 'down', reason: `Close ${price(c[i])} broke below the lower Keltner band ${price(k.lower[i])}. Fall signal.` };
      return hold('Close is inside the Keltner channel.');
    },
  };
}

function planFor(strategyId, candles, params) {
  const p = resolveParams(strategyId, params);
  switch (strategyId) {
    case 'compounder': return bandRsiPlan(candles, p, null);
    case 'meanrev': return bandRsiPlan(candles, p, p.adxMax);
    case 'trend': return trendPlan(candles, p);
    case 'scalp': return crossPlan(candles, p.emaFast, p.emaSlow);
    case 'grid': return gridPlan(candles, p);
    case 'dca': return dcaPlan(candles, p);
    case 'supertrend': return supertrendPlan(candles, p);
    case 'donchian': return donchianPlan(candles, p);
    case 'macdcross': return macdCrossPlan(candles, p);
    case 'ichimoku': return ichimokuPlan(candles, p);
    case 'dmi': return dmiPlan(candles, p);
    case 'keltner': return keltnerPlan(candles, p);
    case 'hedge': return fixedPlan('Hedging is position logic in the trader, not an entry signal.');
    case 'martingale': return fixedPlan('Martingale changes stake size only. Its signals come from the base strategy in params.baseStrategy.');
    case 'smartlimit': return smartLimitPlan(candles, p);
    default: return fixedPlan(`Unknown strategy "${strategyId}". No signals.`);
  }
}

// Regime from ADX: 'trend' at or above REGIME_ADX, 'range' below, 'unknown' while ADX is not defined.
const regimeOf = (v) => (Number.isFinite(v) ? (v >= REGIME_ADX ? 'trend' : 'range') : 'unknown');

// Signal per candle, aligned to the input. Indicators are computed once.
export function signalSeries(strategyId, candles, params) {
  const cs = Array.isArray(candles) ? candles : [];
  const plan = planFor(strategyId, cs, params);
  return cs.map((_, i) => plan.at(i).dir);
}

// Decision for the newest closed candle (the last index). Returns {dir, reason, regime, atr, levels?}.
// levels is present only for grid: {mid, step, lower[], upper[]}.
export function evaluateLatest(strategyId, candles, params) {
  const cs = Array.isArray(candles) ? candles : [];
  if (cs.length === 0) return { dir: null, reason: 'No candles yet.', regime: 'unknown', atr: NaN };
  const idx = cs.length - 1;
  const d = planFor(strategyId, cs, params).at(idx);
  const out = {
    dir: d.dir,
    reason: d.reason,
    regime: regimeOf(adx(cs, ADX_PERIOD)[idx]),
    atr: atr(cs, ATR_PERIOD)[idx],
  };
  if (d.levels) out.levels = d.levels;
  return out;
}

// Smallest ADX that counts as momentum: max(10, round(35 - 2.5 * sensitivity)). Sensitivity 1-10; invalid reads as 5.
export function momentumAdxMin(sensitivity) {
  const s = toNumber(sensitivity, 5);
  return Math.max(10, Math.round(35 - 2.5 * s));
}
