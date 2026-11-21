// MDE: market data store. Closed candles per (asset, tf), validated on the way in. Pure apart from the default nowFn.
// Candle shape: { epoch (open time, seconds, UTC), open, high, low, close }.

const WEEK = 604800;

// Seconds in one bar of a timeframe id (60, 300, ..., 86400, 'W', 'MN'). MN is nominal (30 days); windows use real months.
export function tfSeconds(tf) {
  if (tf === 'W') return WEEK;
  if (tf === 'MN') return 2592000;
  const n = Number(tf);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

// Start and end (epoch seconds) of the period of timeframe `tf` that contains `epoch`.
// candles.js periodStart only knows W and MN and imports config.js, so numeric timeframes are floored here and the W / MN rules are copied.
export function windowOf(epoch, tf) {
  if (tf === 'MN') {
    const d = new Date(epoch * 1000);
    return [Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000), Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000)];
  }
  if (tf === 'W') {
    const d = new Date(epoch * 1000);
    const fromMonday = (d.getUTCDay() + 6) % 7;
    const start = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - fromMonday) / 1000);
    return [start, start + WEEK];
  }
  const t = tfSeconds(tf);
  const start = epoch - (((epoch % t) + t) % t);
  return [start, start + t];
}

// Returns { ok, reason }. Reasons: not_object, bad_epoch, non_finite, non_positive, high_below_body, low_above_body.
export function validateCandle(c) {
  if (!c || typeof c !== 'object') return { ok: false, reason: 'not_object' };
  if (typeof c.epoch !== 'number' || !Number.isFinite(c.epoch) || c.epoch <= 0) return { ok: false, reason: 'bad_epoch' };
  for (const k of ['open', 'high', 'low', 'close']) {
    if (typeof c[k] !== 'number' || !Number.isFinite(c[k])) return { ok: false, reason: 'non_finite' };
  }
  if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return { ok: false, reason: 'non_positive' };
  if (c.high < Math.max(c.open, c.close)) return { ok: false, reason: 'high_below_body' };
  if (c.low > Math.min(c.open, c.close)) return { ok: false, reason: 'low_above_body' };
  return { ok: true, reason: null };
}

const pick = (c) => ({ epoch: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close });

export class MarketData {
  constructor({ maxBars = 5000, nowFn = () => Date.now() } = {}) {
    this.maxBars = Math.max(1, Math.floor(maxBars) || 5000);
    this.nowFn = nowFn;
    this._m = new Map();
    this._subs = new Set();
    this.listenerErrors = [];
  }

  _slot(asset, tf, create = false) {
    const key = `${asset}|${tf}`;
    let s = this._m.get(key);
    if (!s && create) {
      s = { candles: [], source: null, pushes: 0, replaced: 0, rejected: { invalid: 0, out_of_order: 0 }, lastReject: null, gapsSeen: 0 };
      this._m.set(key, s);
    }
    return s || null;
  }

  _emit(ev) {
    for (const fn of [...this._subs]) {
      try { fn(ev); } catch (err) { this.listenerErrors.push({ message: String(err && err.message ? err.message : err) }); if (this.listenerErrors.length > 20) this.listenerErrors.shift(); }
    }
  }

  subscribe(fn) {
    if (typeof fn !== 'function') throw new Error('subscribe needs a function.');
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  // Replaces the whole series. Invalid candles are dropped, duplicates keep the last, the rest is sorted ascending.
  setSeries(asset, tf, candles, source = null) {
    const s = this._slot(asset, tf, true);
    const byEpoch = new Map();
    let dropped = 0;
    for (const c of Array.isArray(candles) ? candles : []) {
      if (validateCandle(c).ok) byEpoch.set(c.epoch, pick(c));
      else dropped += 1;
    }
    const list = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
    if (list.length > this.maxBars) list.splice(0, list.length - this.maxBars);
    s.candles = list;
    s.source = source;
    s.lastReject = null;
    s.rejected.invalid += dropped;
    this._emit({ type: 'series', asset, tf, count: list.length, dropped });
    return { ok: true, count: list.length, dropped };
  }

  // Adds one closed candle. Returns { ok, reason, replaced?, missing? }.
  // A candle with the same epoch as the newest replaces it. An older one is refused (out_of_order). A jump of more than one bar is accepted with reason 'gap'.
  push(asset, tf, candle, source = null) {
    const s = this._slot(asset, tf, true);
    const v = validateCandle(candle);
    if (!v.ok) {
      s.rejected.invalid += 1;
      s.lastReject = `invalid_${v.reason}`;
      return { ok: false, reason: `invalid_${v.reason}` };
    }
    const c = pick(candle);
    const list = s.candles;
    const last = list[list.length - 1];
    if (source) s.source = source;
    if (last && c.epoch < last.epoch) {
      s.rejected.out_of_order += 1;
      s.lastReject = 'out_of_order';
      return { ok: false, reason: 'out_of_order' };
    }
    s.lastReject = null;
    s.pushes += 1;
    if (last && c.epoch === last.epoch) {
      list[list.length - 1] = c;
      s.replaced += 1;
      this._emit({ type: 'push', asset, tf, candle: c, replaced: true });
      return { ok: true, reason: null, replaced: true };
    }
    const t = tfSeconds(tf);
    const missing = last ? Math.max(0, Math.round((c.epoch - last.epoch) / t) - 1) : 0;
    list.push(c);
    if (list.length > this.maxBars) list.splice(0, list.length - this.maxBars);
    if (missing > 0) s.gapsSeen += missing;
    this._emit({ type: 'push', asset, tf, candle: c, replaced: false });
    return missing > 0 ? { ok: true, reason: 'gap', replaced: false, missing } : { ok: true, reason: null, replaced: false };
  }

  // Closed candles, oldest first. A copy, so callers cannot change the store.
  series(asset, tf) {
    const s = this._slot(asset, tf);
    return s ? s.candles.slice() : [];
  }

  // The tf candle that the newest base candle has just completed, or null.
  aggregateLast(asset, baseTf, tf) {
    const s = this._slot(asset, baseTf);
    if (!s || !s.candles.length) return null;
    const base = tfSeconds(baseTf);
    if (tfSeconds(tf) <= base) return null;
    const newest = s.candles[s.candles.length - 1];
    const [start, end] = windowOf(newest.epoch, tf);
    if (newest.epoch + base < end) return null;
    let out = null;
    for (let i = s.candles.length - 1; i >= 0; i -= 1) {
      const c = s.candles[i];
      if (c.epoch < start) break;
      if (c.epoch >= end) continue;
      if (!out) out = { epoch: start, open: c.open, high: c.high, low: c.low, close: c.close };
      else {
        out.open = c.open;
        out.high = Math.max(out.high, c.high);
        out.low = Math.min(out.low, c.low);
      }
    }
    return out;
  }

  stats(asset, tf) {
    const s = this._slot(asset, tf);
    if (!s) return { count: 0, firstEpoch: null, lastEpoch: null, source: null, pushes: 0, replaced: 0, rejected: { invalid: 0, out_of_order: 0 }, gaps: 0, maxBars: this.maxBars };
    const n = s.candles.length;
    return {
      count: n,
      firstEpoch: n ? s.candles[0].epoch : null,
      lastEpoch: n ? s.candles[n - 1].epoch : null,
      source: s.source,
      pushes: s.pushes,
      replaced: s.replaced,
      rejected: { ...s.rejected },
      gaps: s.gapsSeen,
      maxBars: this.maxBars,
    };
  }

  // cfg = normalised 'data' group: staleFactor, gapTolerance, gapWindowBars.
  health(asset, tf, nowMs = this.nowFn(), cfg = {}) {
    const staleFactor = Number.isFinite(cfg.staleFactor) ? cfg.staleFactor : 2;
    const gapTolerance = Number.isFinite(cfg.gapTolerance) ? cfg.gapTolerance : 0;
    const gapWindow = Number.isFinite(cfg.gapWindowBars) ? cfg.gapWindowBars : 50;
    const s = this._slot(asset, tf);
    const out = { status: 'empty', ok: false, reason: 'No candles yet.', lastCloseMs: null, ageMs: null, gaps: 0, gapWindow };
    if (!s || !s.candles.length) return out;
    const t = tfSeconds(tf);
    const list = s.candles;
    const last = list[list.length - 1];
    out.lastCloseMs = (last.epoch + t) * 1000;
    out.ageMs = nowMs - out.lastCloseMs;
    let gaps = 0;
    for (let i = Math.max(1, list.length - gapWindow); i < list.length; i += 1) {
      const miss = Math.round((list[i].epoch - list[i - 1].epoch) / t) - 1;
      if (miss > 0) gaps += miss;
    }
    out.gaps = gaps;
    if (s.lastReject && s.lastReject.startsWith('invalid')) return { ...out, status: 'invalid', reason: `The last candle was refused (${s.lastReject}).` };
    if (out.ageMs > staleFactor * t * 1000) return { ...out, status: 'stale', reason: `No new candle for ${Math.round(out.ageMs / 1000)} s (limit ${Math.round(staleFactor * t)} s).` };
    if (gaps > gapTolerance) return { ...out, status: 'gap', reason: `${gaps} candles missing in the last ${gapWindow} bars (tolerance ${gapTolerance}).` };
    return { ...out, status: 'ok', ok: true, reason: null };
  }
}
