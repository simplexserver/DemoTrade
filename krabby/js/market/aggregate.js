// Builds longer candles from shorter ones. A bucket is kept only when every base candle in it is present, so a gap never
// produces a candle that looks complete but is not. Pure.
export function aggregateCandles(base, baseTf, tf) {
  if (!Array.isArray(base) || !base.length || !(baseTf > 0) || !(tf >= baseTf) || tf % baseTf !== 0) return [];
  const per = tf / baseTf;
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.n === per) out.push({ epoch: cur.epoch, open: cur.open, high: cur.high, low: cur.low, close: cur.close }); };
  for (const c of base) {
    const start = Math.floor(c.epoch / tf) * tf;
    if (!cur || cur.epoch !== start) {
      flush();
      cur = { epoch: start, open: c.open, high: c.high, low: c.low, close: c.close, n: 1 };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.n += 1;
    }
  }
  flush();
  return out;
}

// Simulated history for the scanner: a path that is independent of the live simulation (a different seed), so whatever is
// learned from it is tested on data it has never seen. Returns candles at tf, oldest first. The minutes are folded into
// candles as they are made, so a long history never holds millions of minute candles at once, and the number of minutes
// is capped (about three years), so a daily history is shorter than an hourly one rather than slow to make.
export const SIM_HISTORY_MAX_MINUTES = 1500000;

function* historySteps(createFeed, dataCfg, asset, tf, bars, chunk) {
  const per = Math.max(1, Math.round(tf / 60));
  const want = Math.max(1, Math.min(Math.floor(bars), Math.floor(SIM_HISTORY_MAX_MINUTES / per)));
  const startMs = Date.parse(dataCfg.simStart) - want * tf * 1000;
  const feed = createFeed({
    seed: (Number(dataCfg.simSeed) || 1) + 7777, assets: [asset], startIso: new Date(startMs).toISOString(), starts: dataCfg.simStarts, volPct: dataCfg.simVolPct,
    regimeBars: dataCfg.simRegimeBars, spikeChance: dataCfg.simSpikeChance, outageEvery: 0, kind: dataCfg.simKind,
  });
  const out = [];
  let cur = null;
  const total = want * per;
  for (let i = 0; i < total; i += 1) {
    const c = feed.next(asset);
    if (per === 1) out.push(c);
    else {
      const start = Math.floor(c.epoch / tf) * tf;
      if (!cur || cur.epoch !== start) {
        if (cur && cur.n === per) out.push({ epoch: cur.epoch, open: cur.open, high: cur.high, low: cur.low, close: cur.close });
        cur = { epoch: start, open: c.open, high: c.high, low: c.low, close: c.close, n: 1 };
      } else {
        if (c.high > cur.high) cur.high = c.high;
        if (c.low < cur.low) cur.low = c.low;
        cur.close = c.close;
        cur.n += 1;
      }
    }
    if (chunk > 0 && i % chunk === chunk - 1) yield i / total;
  }
  if (cur && cur.n === per) out.push({ epoch: cur.epoch, open: cur.open, high: cur.high, low: cur.low, close: cur.close });
  return out;
}

export function simHistoryCandles(createFeed, dataCfg, asset, tf, bars) {
  const it = historySteps(createFeed, dataCfg, asset, tf, bars, 0);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

// The same, but it hands control back to the page every `chunk` minutes (yieldFn) and stops early when signal.aborted.
// Resolves with the candles, or null when it was stopped.
export async function simHistoryCandlesAsync(createFeed, dataCfg, asset, tf, bars, { yieldFn = null, signal = null, chunk = 100000, onProgress = null } = {}) {
  const it = historySteps(createFeed, dataCfg, asset, tf, bars, chunk);
  let r = it.next();
  while (!r.done) {
    if (typeof onProgress === 'function') { try { onProgress(r.value); } catch (_) { /* a progress hook must not stop it */ } }
    if (typeof yieldFn === 'function') await yieldFn();
    if (signal && signal.aborted) return null;
    r = it.next();
  }
  return r.value;
}
