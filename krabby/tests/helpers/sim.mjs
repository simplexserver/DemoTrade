// Shared test helpers: deterministic simulated candles, and higher timeframes built from M1 the way the runner does.
import { createSimFeed } from '../../js/market/feed-sim.js';

export const ASSET = 'R_100';

export const simCandles = (n, seed = 7, over = {}, asset = ASSET) => {
  const f = createSimFeed({ seed, assets: [asset], starts: { [asset]: 1000 }, ...over });
  return Array.from({ length: n }, () => f.next(asset));
};

// Complete higher-timeframe candles from M1 (an incomplete bucket is dropped).
export function aggregate(m1, tf) {
  const per = tf / 60;
  const out = [];
  const buckets = new Map();
  for (const c of m1) {
    const start = c.epoch - (c.epoch % tf);
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(c);
  }
  for (const [start, list] of [...buckets].sort((a, b) => a[0] - b[0])) {
    if (list.length !== per) continue;
    out.push({
      epoch: start, open: list[0].open, high: Math.max(...list.map((c) => c.high)),
      low: Math.min(...list.map((c) => c.low)), close: list[list.length - 1].close,
    });
  }
  return out;
}

export const nowOf = (candles, tf) => (candles[candles.length - 1].epoch + tf) * 1000;
