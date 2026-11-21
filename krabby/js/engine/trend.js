// EMA trend state per candle: 'up' when the fast EMA is above the slow one, 'down' below, null during warm-up.
// Pure. Used by the Smart Basket method, which backtests this state before it may trade.
import { closes, ema } from './indicators.js';

export function emaTrendSeries(candles, fast = 9, slow = 21) {
  const c = closes(candles);
  const f = ema(c, fast);
  const s = ema(c, slow);
  return candles.map((_, i) => {
    if (!Number.isFinite(f[i]) || !Number.isFinite(s[i])) return null;
    if (f[i] > s[i]) return 'up';
    if (f[i] < s[i]) return 'down';
    return null;
  });
}
