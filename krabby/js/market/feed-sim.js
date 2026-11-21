// Simulated market: repeatable M1 candles. The same seed and settings always give the same market.
// kind 'regimes' (default): trend up, trend down, range and volatile regimes, displacement bars, and sweeps (a wick
// through a recent extreme that closes back), so the engines have things to find. It is built WITH structure, so a
// profit here only shows that the machinery can capture structure when structure exists.
// kind 'random_walk': constant volatility and nothing else: no drift, no ranges, no displacement, no sweeps. Every
// price change is independent of the past, which is the null case. Deriv's synthetic indices are designed to behave
// this way, so this is the honest control: nothing should make money here except luck, and costs make it lose.
// Pure: a seeded generator, no clock, no storage.
import { mulberry32, fnv1a } from '../core/hash.js';

const MIN = 60;
const r3 = (x) => Math.round(x * 1000) / 1000;

function gauss(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

export function createSimFeed({
  seed = 20260105, assets = ['R_100'], startIso = '2026-01-05T00:00:00Z', starts = {}, volPct = 0.04,
  regimeBars = 240, spikeChance = 0.02, outageEvery = 0, kind = 'regimes',
} = {}) {
  const walk = kind === 'random_walk';
  const t0 = Math.floor(Date.parse(startIso) / 1000) || 1767571200;
  const books = new Map();

  const book = (asset) => {
    let b = books.get(asset);
    if (!b) {
      const start = Number(starts[asset]) > 0 ? Number(starts[asset]) : 1000;
      b = {
        rnd: mulberry32((Number(seed) ^ parseInt(fnv1a(String(asset)), 16)) >>> 0),
        i: 0, epoch: t0, price: start, center: start, regime: 'range', left: 0, recent: [], gap: false,
      };
      books.set(asset, b);
    }
    return b;
  };

  function pickRegime(b) {
    const r = b.rnd();
    b.regime = r < 0.25 ? 'trend_up' : r < 0.5 ? 'trend_down' : r < 0.8 ? 'range' : 'volatile';
    if (b.regime === 'range') b.center = b.price;
    b.left = Math.max(20, Math.round(regimeBars * (0.5 + b.rnd())));
  }

  // The next M1 candle for an asset. Epoch is the open time in seconds, UTC.
  function next(asset) {
    const b = book(asset);
    if (!walk && b.left <= 0) pickRegime(b);
    b.left -= 1;
    b.gap = false;
    if (outageEvery > 0 && b.i > 0 && b.i % outageEvery === 0) {
      b.epoch += 3 * MIN;
      b.gap = true;
    }
    const vol = volPct / 100;
    const o = b.price;
    const mult = !walk && b.regime === 'volatile' ? 2.2 : 1;
    let drift = 0;
    if (walk) drift = 0;
    else if (b.regime === 'trend_up') drift = 0.3 * vol;
    else if (b.regime === 'trend_down') drift = -0.3 * vol;
    else if (b.regime === 'range') drift = -0.08 * ((o - b.center) / b.center);
    let ret = drift + vol * mult * gauss(b.rnd);
    if (!walk && b.rnd() < 0.03) ret *= 3; // displacement bar
    let c = o * (1 + ret);
    let h = Math.max(o, c) + o * vol * mult * b.rnd() * 0.8;
    let l = Math.min(o, c) - o * vol * mult * b.rnd() * 0.8;

    if (!walk && b.recent.length >= 20 && b.rnd() < spikeChance) {
      let rh = -Infinity;
      let rl = Infinity;
      for (const x of b.recent) {
        if (x.high > rh) rh = x.high;
        if (x.low < rl) rl = x.low;
      }
      if (b.rnd() < 0.5) {
        h = Math.max(h, rh * (1 + vol * 0.4));
        c = Math.min(c, rh - o * vol * 0.1);
      } else {
        l = Math.min(l, rl * (1 - vol * 0.4));
        c = Math.max(c, rl + o * vol * 0.1);
      }
    }
    h = Math.max(h, o, c);
    l = Math.max(Math.min(l, o, c), o * 0.5);
    const candle = { epoch: b.epoch, open: r3(o), high: r3(h), low: r3(l), close: r3(c) };
    b.price = candle.close;
    b.recent.push({ high: candle.high, low: candle.low });
    if (b.recent.length > 40) b.recent.shift();
    b.epoch += MIN;
    b.i += 1;
    return candle;
  }

  // True when the candle just returned came right after a three-bar gap.
  const outageActive = (asset) => book(asset).gap;
  const count = (asset) => book(asset).i;
  return { next, outageActive, count, assets: [...assets] };
}

// Builds a feed from the normalised 'data' settings group.
export function simFeedFromSettings(dataCfg, assets) {
  return createSimFeed({
    seed: dataCfg.simSeed,
    assets: assets || dataCfg.assets,
    startIso: dataCfg.simStart,
    starts: dataCfg.simStarts,
    volPct: dataCfg.simVolPct,
    regimeBars: dataCfg.simRegimeBars,
    spikeChance: dataCfg.simSpikeChance,
    outageEvery: dataCfg.simOutageEvery,
    kind: dataCfg.simKind,
  });
}
