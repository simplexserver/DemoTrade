// Three example strategies for the Strategy lab. Each is a complete `function onBar(ctx)` that uses only ctx helpers,
// so it runs in the sandbox as it is. Copy one into your own strategies and change it.
// They are teaching examples, not recommendations: none of them is claimed to make money.

const EMA_CROSS = `// EMA cross with an ATR stop.
// Buys when the fast EMA crosses above the slow EMA and sells when it crosses below.
// The stop is stopAtr x ATR from the entry and the target is rr x the stop distance.
// The entry is a limit at this bar's close. Parameters: fast, slow, stopAtr, rr.
function onBar(ctx) {
  const p = ctx.params;
  const fast = p.fast || 9;
  const slow = p.slow || 21;
  const stopAtr = p.stopAtr || 1.5;
  const rr = p.rr || 2;
  const f0 = ctx.ema(fast);
  const f1 = ctx.ema(fast, 1);
  const s0 = ctx.ema(slow);
  const s1 = ctx.ema(slow, 1);
  const a = ctx.atr(14);
  if (!(a > 0) || !Number.isFinite(f0 + f1 + s0 + s1)) return null;
  const c = ctx.candle().close;
  const risk = a * stopAtr;
  if (f1 <= s1 && f0 > s0) {
    return { side: 'buy', entry: c, stop: c - risk, target: c + risk * rr, reason: 'EMA ' + fast + ' crossed above EMA ' + slow };
  }
  if (f1 >= s1 && f0 < s0) {
    return { side: 'sell', entry: c, stop: c + risk, target: c - risk * rr, reason: 'EMA ' + fast + ' crossed below EMA ' + slow };
  }
  return null;
}
`;

const RANGE_FADE = `// Range fade at the edges of a 20-bar channel.
// The channel is the highest high and lowest low of the 20 bars before this one. It must be at least
// minWidthAtr x ATR wide, or there is not enough room to pay for the trade.
// Buys when this bar dips to the channel low and closes back above it. Sells at the channel high the same way.
// The stop sits stopAtr x ATR beyond the edge. The target is the middle of the channel.
// Parameters: lookback, minWidthAtr, stopAtr.
function onBar(ctx) {
  const p = ctx.params;
  const n = p.lookback || 20;
  const minWidthAtr = p.minWidthAtr || 3;
  const stopAtr = p.stopAtr || 0.5;
  const hi = ctx.highest(n, 1);
  const lo = ctx.lowest(n, 1);
  const a = ctx.atr(14);
  if (!(a > 0) || !Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  if (hi - lo < minWidthAtr * a) return null;
  const c = ctx.candle();
  const mid = (hi + lo) / 2;
  const touch = a * 0.1;
  if (c.low <= lo + touch && c.close > lo && c.close < mid) {
    return { side: 'buy', entry: c.close, stop: Math.min(c.low, lo) - a * stopAtr, target: mid, reason: 'Touched the channel low and closed back above it' };
  }
  if (c.high >= hi - touch && c.close < hi && c.close > mid) {
    return { side: 'sell', entry: c.close, stop: Math.max(c.high, hi) + a * stopAtr, target: mid, reason: 'Touched the channel high and closed back below it' };
  }
  return null;
}
`;

const FAILED_BREAKOUT = `// Failed breakout reversal.
// A bar closes beyond the highest high (or lowest low) of the n bars before it, and then price closes back inside
// within failBars bars. A failed break up is sold. A failed break down is bought.
// It fires once, on the first close back inside. The stop is beyond the extreme of the failed move (plus padAtr x ATR)
// and the target is rr x the stop distance. Parameters: lookback, failBars, padAtr, rr.
function onBar(ctx) {
  const p = ctx.params;
  const n = p.lookback || 20;
  const failBars = p.failBars || 3;
  const padAtr = p.padAtr || 0.25;
  const rr = p.rr || 2;
  const a = ctx.atr(14);
  if (!(a > 0)) return null;
  const c = ctx.candle();
  for (let k = 1; k <= failBars; k++) {
    const b = ctx.candle(k);
    if (!b) break;
    const hi = ctx.highest(n, k + 1);
    const lo = ctx.lowest(n, k + 1);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    let stayedUp = b.close > hi;
    let stayedDown = b.close < lo;
    for (let j = 1; j < k; j++) {
      const m = ctx.candle(j);
      if (m.close <= hi) stayedUp = false;
      if (m.close >= lo) stayedDown = false;
    }
    if (stayedUp && c.close < hi) {
      const stop = ctx.highest(k + 1) + a * padAtr;
      const risk = stop - c.close;
      if (risk > 0) {
        return { side: 'sell', entry: c.close, stop: stop, target: c.close - risk * rr, reason: 'Failed break above the ' + n + '-bar high' };
      }
    }
    if (stayedDown && c.close > lo) {
      const stop = ctx.lowest(k + 1) - a * padAtr;
      const risk = c.close - stop;
      if (risk > 0) {
        return { side: 'buy', entry: c.close, stop: stop, target: c.close + risk * rr, reason: 'Failed break below the ' + n + '-bar low' };
      }
    }
  }
  return null;
}
`;

export const EXAMPLES = Object.freeze([
  Object.freeze({
    id: 'ema_cross',
    name: 'EMA cross with ATR stop',
    summary: 'Trend following. Buys a fast-over-slow EMA cross, sells the opposite, with an ATR stop.',
    params: Object.freeze({ fast: 9, slow: 21, stopAtr: 1.5, rr: 2 }),
    code: EMA_CROSS,
  }),
  Object.freeze({
    id: 'range_fade',
    name: 'Range fade (20-bar channel)',
    summary: 'Mean reversion. Fades a touch of the channel low or high, aiming for the middle.',
    params: Object.freeze({ lookback: 20, minWidthAtr: 3, stopAtr: 0.5 }),
    code: RANGE_FADE,
  }),
  Object.freeze({
    id: 'failed_breakout',
    name: 'Failed breakout reversal',
    summary: 'Reversal. Trades against a break of the 20-bar extreme that closes back inside within three bars.',
    params: Object.freeze({ lookback: 20, failBars: 3, padAtr: 0.25, rr: 2 }),
    code: FAILED_BREAKOUT,
  }),
]);
