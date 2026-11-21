// SRD: strong reversal evidence. ONE message per run. It weighs sweeps, reclaims, structure shifts, displacement,
// gaps, order blocks, level reclaims, momentum, the higher timeframe and failed breakouts. The score ranks setups;
// it is not a probability. Pure.
import { atrOf, lastFinite, closeMs, confirmedSwings, newMsg, classOf, clampRank } from './common.js';

// Wilder RSI. Warm-up entries are NaN.
function rsiSeries(candles, period) {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < candles.length; i += 1) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

const WEIGHT = {
  sweep: 'wSweep', reclaim: 'wReclaim', mss: 'wMss', bos: 'wBos', disp: 'wDisp', fvg: 'wFvg',
  ob: 'wOb', level: 'wLevel', momentum: 'wMomentum', htf: 'wHtf', failed: 'wFailed',
};

export function run(ctx) {
  const { candles, tf, cfg, board, asset, nowMs } = ctx;
  if (!Array.isArray(candles) || !cfg || !board || candles.length < 10) return [];
  const n = candles.length;
  const A = lastFinite(atrOf(candles, cfg.atrPeriod));
  if (!(A > 0)) return [];
  const rsi = rsiSeries(candles, cfg.rsiPeriod);
  const winMs = closeMs(candles[Math.max(0, n - cfg.lookback)], tf);
  const inWin = (m) => m.atMs >= winMs;
  const q = (topic, extra = {}) => board.query({ topic, asset, tf, ...extra });
  const sweeps = q('sweeps').filter(inWin);
  const structure = q('structure').filter(inWin);
  const fvgs = q('fvg', { validOnly: true });
  const obs = q('orderblocks', { validOnly: true });
  const levels = q('levels', { validOnly: true });
  const breakouts = q('breakouts').filter(inWin);
  const htfMsg = board.latest('structure', asset, tf * cfg.htfFactor, { type: 'trend' });
  const htfTrend = htfMsg && htfMsg.measurements ? htfMsg.measurements.trend : null;

  const close = candles[n - 1].close;
  const last3 = candles.slice(-3);
  const prev = candles[Math.max(0, n - 4)];
  const r1 = rsi[n - 1];
  const r4 = rsi[Math.max(0, n - 4)];
  const recentRsi = rsi.slice(-5).filter(Number.isFinite);

  const swings = confirmedSwings(candles, 2, 100);
  const lastHigh = [...swings].reverse().find((s) => s.type === 'high') || null;
  const lastLow = [...swings].reverse().find((s) => s.type === 'low') || null;

  const scoreSide = (bull) => {
    const side = bull ? 'bullish' : 'bearish';
    const has = {};
    has.sweep = sweeps.some((m) => m.measurements.outcome === 'rejection' && m.type === (bull ? 'sweep_low' : 'sweep_high'));
    has.reclaim = sweeps.some((m) => m.measurements.outcome === 'rejection' && m.measurements.reclaimed && m.type === (bull ? 'sweep_low' : 'sweep_high'));
    has.mss = structure.some((m) => m.type === (bull ? 'mss_up' : 'mss_down'));
    has.bos = structure.some((m) => m.type === (bull ? 'bos_up' : 'bos_down') || m.type === (bull ? 'choch_up' : 'choch_down'));
    has.disp = last3.some((c) => Math.abs(c.close - c.open) >= cfg.dispAtr * A && (bull ? c.close > c.open : c.close < c.open));
    has.fvg = fvgs.some((m) => m.type === side && inWin(m));
    has.ob = obs.some((m) => m.type === side);
    has.level = levels.some((m) => m.level && (bull
      ? prev.close <= m.level.hi && last3.some((c) => c.close > m.level.hi) && Math.abs(close - m.level.hi) <= 3 * A
      : prev.close >= m.level.lo && last3.some((c) => c.close < m.level.lo) && Math.abs(close - m.level.lo) <= 3 * A));
    has.momentum = Number.isFinite(r1) && Number.isFinite(r4) && (bull
      ? (r4 < 50 && r1 >= 50) || (recentRsi.length > 0 && Math.min(...recentRsi) < 30 && r1 > 30)
      : (r4 > 50 && r1 <= 50) || (recentRsi.length > 0 && Math.max(...recentRsi) > 70 && r1 < 70));
    has.htf = htfTrend === side;
    has.failed = breakouts.some((m) => m.measurements.verdict === 'false' && m.type === (bull ? 'bearish' : 'bullish'));

    const cats = [];
    let score = 0;
    for (const [cat, key] of Object.entries(WEIGHT)) {
      if (has[cat] && cfg[key] > 0) {
        cats.push(cat);
        score += cfg[key];
      }
    }
    // A bounce that has retraced little of the last impulse is a pullback, not a reversal, unless structure shifted.
    let pullback = false;
    if (lastHigh && lastLow && lastHigh.price > lastLow.price) {
      const range = lastHigh.price - lastLow.price;
      if (bull && lastLow.index > lastHigh.index) pullback = (close - lastLow.price) / range < cfg.pullbackRatio;
      if (!bull && lastHigh.index > lastLow.index) pullback = (lastHigh.price - close) / range < cfg.pullbackRatio;
    }
    return { score: Math.min(100, score), cats, pullback, hasMss: has.mss };
  };

  const bull = scoreSide(true);
  const bear = scoreSide(false);
  let winner = null;
  if (bull.score > bear.score) winner = { ...bull, side: 'bullish' };
  else if (bear.score > bull.score) winner = { ...bear, side: 'bearish' };

  if (!winner || winner.score <= 0) {
    return [newMsg({
      topic: 'reversal',
      type: 'none',
      direction: 'none',
      atMs: nowMs,
      measurements: { bullScore: bull.score, bearScore: bear.score, categories: [], pullback: false },
      evidence: { rank: 0, cls: 'weak' },
      summary: 'No reversal evidence in the recent candles.',
    })];
  }
  let cls = classOf(winner.score, cfg.weakBelow, cfg.strongFrom);
  if (cls === 'strong' && winner.cats.length < cfg.minCategories) cls = 'developing';
  if (winner.pullback && !winner.hasMss) cls = 'weak';
  const rank = clampRank(winner.score);
  return [newMsg({
    topic: 'reversal',
    type: `${winner.side}_reversal`,
    direction: winner.side === 'bullish' ? 'up' : 'down',
    atMs: nowMs,
    measurements: {
      bullScore: bull.score, bearScore: bear.score, categories: winner.cats, pullback: winner.pullback,
    },
    evidence: { rank, cls },
    invalidation: null,
    summary: `${winner.side[0].toUpperCase()}${winner.side.slice(1)} reversal evidence is ${cls} (score ${rank}): ${winner.cats.join(', ')}${winner.pullback && !winner.hasMss ? '. Looks like a pullback, so it is held at weak' : ''}.`,
  })];
}

export const ENGINE = { code: 'SRD', name: 'Strong reversal', stage: 2, prefix: 'srd', topics: ['reversal'], run };
