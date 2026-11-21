// Pure order helpers for the paper execution engine (DEE) and the profit manager (DPM).
// No DOM, no storage, no network, no clock: every time and price is an argument.
// Sides are 'buy' and 'sell'. dir is +1 for buy and -1 for sell.
import { adx, atr, last, swingLevels } from '../engine/indicators.js';

const num = (v, d = NaN) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const r10 = (x) => Math.round(x * 1e10) / 1e10;

export const dirOf = (side) => (side === 'sell' ? -1 : 1);

// Gross P&L in USD from fill prices (spread and slippage are already inside them). Sell flips the sign.
export function grossUsd({ side, stake, multiplier, entry, exit }) {
  const e = num(entry);
  if (!(e > 0)) return 0;
  return r10(dirOf(side) * num(stake, 0) * num(multiplier, 1) * (num(exit) - e) / e);
}

// Net P&L: gross minus commission, never below minus the stake (Deriv caps the loss at the stake).
export function netOf(gross, commissionUsd, stake) {
  return r10(Math.max(-num(stake, 0), gross - num(commissionUsd, 0)));
}

// Result label from a net amount. |net| < 1e-9 is breakeven.
export function resultOf(net) {
  if (Math.abs(net) < 1e-9) return 'breakeven';
  return net > 0 ? 'win' : 'loss';
}

// Fixed-order reading of one candle for a pending limit entry.
// pending: { side, entry, invalidation, expiryBars, barsWaiting }. candle: { open, high, low, close }.
// invalid: optional true (or a reason string) when the caller already knows the setup is dead.
// halfSpread is added against us on the fill. Limit fills take no slippage.
// Returns { status: 'waiting' | 'cancelled' | 'expired' | 'filled', reason?, fillPrice?, rawPrice? }.
export function pendingStep({ pending, candle, invalid = false, halfSpread = 0 }) {
  const buy = pending.side !== 'sell';
  if (invalid) return { status: 'cancelled', reason: typeof invalid === 'string' ? invalid : 'setup_invalidated' };
  const inv = num(pending.invalidation);
  if (Number.isFinite(inv) && (buy ? candle.close < inv : candle.close > inv)) {
    return { status: 'cancelled', reason: 'setup_invalidated' };
  }
  const exp = num(pending.expiryBars, 0);
  if (exp > 0 && num(pending.barsWaiting, 0) >= exp) return { status: 'expired', reason: 'expired' };
  const entry = num(pending.entry);
  let raw = null;
  if (buy) {
    if (candle.open <= entry) raw = candle.open;
    else if (candle.low <= entry) raw = entry;
  } else if (candle.open >= entry) raw = candle.open;
  else if (candle.high >= entry) raw = entry;
  if (raw === null) return { status: 'waiting' };
  return { status: 'filled', rawPrice: raw, fillPrice: r10(raw + (buy ? 1 : -1) * num(halfSpread, 0)) };
}

// Profit protection for one open position after a candle whose stop check did not hit.
// position: { side, entry, stop, initialStop, bestPrice, trailingArmed, stake, multiplier, objectiveUsd, openBars }
// (openBars already counts this candle). cfg = dpm group. rMoney = initial risk in USD, rPrice = initial risk in price.
// Optional: exitCost (half spread + slippage, price units) and commissionUsd, so arming is measured net of costs.
// Arming is read at the candle CLOSE (conservative). bestPrice follows the highs (buy) or lows (sell).
// The new stop is for the NEXT candle. It only moves in the favourable direction and never sits worse than initialStop.
// Returns { stop, bestPrice, armed, exit: null | { reason, price } }.
export function manageTrade({ position, candle, cfg = {}, rMoney = NaN, rPrice = NaN, exitCost = 0, commissionUsd = 0 }) {
  const p = position;
  const dir = dirOf(p.side);
  const entry = num(p.entry);
  const initial = Number.isFinite(num(p.initialStop)) ? num(p.initialStop) : num(p.stop);
  let stop = num(p.stop, initial);
  let best = num(p.bestPrice, entry);
  let armed = Boolean(p.trailingArmed);
  if (cfg.enabled !== false) {
    best = dir > 0 ? Math.max(best, candle.high) : Math.min(best, candle.low);
    if (!armed) {
      const objective = Number.isFinite(num(p.objectiveUsd)) ? num(p.objectiveUsd)
        : num(cfg.objectiveR, 0) * num(rMoney, 0);
      const exitPx = candle.close - dir * num(exitCost, 0);
      const net = netOf(grossUsd({ side: p.side, stake: p.stake, multiplier: p.multiplier, entry, exit: exitPx }), commissionUsd, p.stake);
      if (objective > 0 && net >= objective) armed = true;
    }
    if (armed && num(rPrice, 0) > 0) {
      const trail = best - dir * num(cfg.trailR, 1) * rPrice;
      let next = dir > 0 ? Math.max(stop, trail) : Math.min(stop, trail);
      next = dir > 0 ? Math.max(next, initial) : Math.min(next, initial);
      stop = next;
    }
  }
  const hold = num(cfg.maxHoldBars, 0);
  const exit = hold > 0 && num(p.openBars, 0) >= hold ? { reason: 'max_hold', price: candle.close } : null;
  return { stop, bestPrice: best, armed, exit };
}

// ---- Older pure helpers kept for the lab and tests ----

// Trailing state in percent of stake. Arms at activatePct, closes trailPct below the peak.
export function trailingUpdate(runtime, pnlPct, { activatePct = 20, trailPct = 10 } = {}) {
  const activate = num(activatePct, 20);
  const trail = num(trailPct, 10);
  const armed = Boolean(runtime?.armed) || pnlPct >= activate;
  if (!armed) return { armed: false, peakPct: null, close: false };
  const peakPct = Math.max(num(runtime?.peakPct, -Infinity), pnlPct);
  return { armed: true, peakPct, close: trail > 0 && pnlPct <= peakPct - trail };
}

// Take profit target as % of stake: (atrMultiple x ATR / price) x multiplier. Null when an input is not positive.
export function dynamicTpTargetPct(atrValue, price, atrMultiple, multiplier) {
  const a = num(atrValue);
  const p = num(price);
  const k = num(atrMultiple);
  const m = num(multiplier);
  if (!(a > 0 && p > 0 && k > 0 && m > 0)) return null;
  return ((a * k) / p) * 100 * m;
}

function withinLimit(up, quote, limit) {
  if (!Number.isFinite(limit)) return true;
  return up ? quote <= limit : quote >= limit;
}

// Tick-level fill test for one order shape. Returns { fire, patch }. Kept for the strategy lab.
export function evaluateOrderTick(order, quote) {
  const q = num(quote);
  const trig = num(order.triggerPrice);
  const lim = num(order.limitPrice);
  const up = order.side === 'up';
  switch (order.type) {
    case 'limit': return { fire: up ? q <= trig : q >= trig, patch: null };
    case 'stop': return { fire: up ? q >= trig : q <= trig, patch: null };
    case 'stop_limit': {
      const triggered = Boolean(order.triggered) || (up ? q >= trig : q <= trig);
      return { fire: triggered && withinLimit(up, q, lim), patch: triggered && !order.triggered ? { triggered: true } : null };
    }
    case 'trailing_stop_limit': {
      const dist = num(order.trailDistance);
      const seen = num(order.bestPrice);
      const best = Number.isFinite(seen) ? (up ? Math.min(seen, q) : Math.max(seen, q)) : q;
      const triggered = Boolean(order.triggered) || (up ? q >= best + dist : q <= best - dist);
      return { fire: triggered && withinLimit(up, q, lim), patch: { bestPrice: best, ...(triggered && !order.triggered ? { triggered: true } : {}) } };
    }
    default: return { fire: false, patch: null };
  }
}

// Buy limit just above swing support, sell limit just below swing resistance, only in a quiet market (ADX below adxMax).
export function smartLimitPlan(candles, { adxMax = 20, lookback = 20, bufferAtr = 0.1 } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const adxNow = last(adx(candles, 14));
  if (!Number.isFinite(adxNow) || adxNow >= num(adxMax, 20)) return null;
  const atrNow = last(atr(candles, 14));
  if (!Number.isFinite(atrNow) || atrNow <= 0) return null;
  const { support, resistance } = swingLevels(candles, lookback, 2);
  if (support === null || resistance === null) return null;
  const buffer = num(bufferAtr, 0.1) * atrNow;
  return { up: { price: support + buffer }, down: { price: resistance - buffer } };
}
