// Candle helpers. Pure: no DOM, no network. Weekly and monthly bars are built from daily candles in UTC.
import { TIMEFRAMES } from '../config.js';

export const timeframeOf = (id) => TIMEFRAMES.find((t) => String(t.id) === String(id)) || null;

// The Deriv granularity to fetch for a timeframe id (seconds, 'W' or 'MN').
export function baseGranularity(id) {
  const t = timeframeOf(id);
  if (t) return t.base;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

// Start of the period containing epoch (seconds): the Monday 00:00 UTC of its ISO week, or the 1st of its month.
export function periodStart(epoch, mode) {
  const d = new Date(epoch * 1000);
  if (mode === 'MN') return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  const fromMonday = (d.getUTCDay() + 6) % 7;
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - fromMonday) / 1000);
}

// Groups candles into weekly ('W') or monthly ('MN') bars. Any other mode returns a copy unchanged.
export function aggregateCandles(candles, mode) {
  if (mode !== 'W' && mode !== 'MN') return (candles || []).slice();
  const out = [];
  for (const c of candles || []) {
    const key = periodStart(c.epoch, mode);
    const last = out[out.length - 1];
    if (last && last.epoch === key) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else {
      out.push({ epoch: key, open: c.open, high: c.high, low: c.low, close: c.close });
    }
  }
  return out;
}
