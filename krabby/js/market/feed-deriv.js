// Deriv public candle feed: history, then live closed candles, for each market and timeframe. Public data only:
// no token, no account. This is the only module that uses the network, and only through js/deriv/api.js.
// The Deriv stream also sends the candle that is still forming. This adapter holds it back and reports a candle
// only once the next one has started, so the engines only ever see closed candles.

export function createDerivFeed({
  assets = [], timeframes = [], historyBars = 500, onCandle = () => {}, onStatus = () => {}, onHistory = () => {}, api = null, nowFn = () => Date.now(),
} = {}) {
  let state = 'idle';
  let message = '';
  let stops = [];
  const forming = new Map();

  const setStatus = (s, m = '') => {
    state = s;
    message = m;
    try { onStatus(s, m); } catch (_) { /* a status listener must not break the feed */ }
  };

  function handle(asset, tf, ev) {
    const key = `${asset}|${tf}`;
    if (!ev) return;
    if (ev.type === 'history') {
      let hist = Array.isArray(ev.candles) ? ev.candles.slice() : [];
      const last = hist[hist.length - 1];
      if (last && (last.epoch + tf) * 1000 > nowFn()) {
        forming.set(key, last);
        hist = hist.slice(0, -1);
      }
      onHistory(asset, tf, hist);
      return;
    }
    const c = ev.candle;
    if (!c) return;
    const prev = forming.get(key);
    if (prev && c.epoch > prev.epoch) onCandle(asset, tf, prev);
    forming.set(key, c);
  }

  async function start() {
    if (state === 'running' || state === 'connecting') return;
    setStatus('connecting');
    let a = api;
    if (!a) {
      try {
        a = (await import('../deriv/api.js')).deriv;
      } catch (e) {
        setStatus('error', `The Deriv module could not load: ${(e && e.message) || e}`);
        return;
      }
    }
    for (const asset of assets) {
      for (const tf of timeframes) {
        try {
          const stop = a.streamCandles(asset, tf, (ev) => handle(asset, tf, ev), historyBars);
          if (typeof stop === 'function') stops.push(stop);
        } catch (e) {
          setStatus('error', `Subscribing to ${asset} ${tf}s failed: ${(e && e.message) || e}`);
        }
      }
    }
    if (state !== 'error') setStatus('running');
  }

  function stop() {
    for (const s of stops) {
      try { s(); } catch (_) { /* already closed */ }
    }
    stops = [];
    forming.clear();
    setStatus('idle');
  }

  return { start, stop, status: () => ({ state, message }) };
}
