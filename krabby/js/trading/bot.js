// Deriv Bot: the only automatic trader. It runs the methods switched on in the Deriv Bot tab and the Smart Basket method.
// Every entry passes the edge gate (backtest with a 95% lower bound above break-even) and the risk checks in trader.js.
import { EDGE_DEFAULTS, EVENTS, STRATEGIES, STRATEGY_BY_ID, TIMING } from '../config.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { round, toNumber } from '../core/util.js';
import { DerivError } from '../deriv/connection.js';
import { deriv, estimateHorizonCandles } from '../deriv/api.js';
import { breakEvenFromQuote, evaluateSignals } from '../engine/backtest.js';
import { basketConfluence, basketCurrency, componentSymbols } from '../engine/basket.js';
import { evaluateLatest, momentumAdxMin, signalSeries } from '../engine/strategies.js';
import { emaTrendSeries } from '../engine/trend.js';
import { pending, smartLimitPlan } from './orders.js';
import { realLockCheck, trader } from './trader.js';
import {
  compounderNext, dcaCanAdd, hedgeDue, hedgeNetReached, martingaleNextStep, martingaleStake, multiplierLimits,
} from './sizing.js';

const LOG_LIMIT = 200;
const HALT_CODES = new Set(['SESSION_TARGET', 'SESSION_LIMIT', 'DAILY_STOP', 'DAILY_STOP_NO_BASELINE']);
const STOP_CODES = new Set(['REAL_LOCKED', 'NotConnected']);
const RETRY_CODES = new Set(['InvalidOfferings', 'ContractBuyValidationError', 'InputValidationFailed']);
const BASKET_HORIZON = 5;
const MAX_BASKET_COMPONENTS = 12;

const state = {
  running: false,
  message: 'Stopped',
  startedAt: 0,
  stats: { entries: 0, skipped: 0, lastSkip: '', wins: 0, losses: 0 },
  logs: [],
  streams: [],
  candles: new Map(),        // 'symbol:granularity' -> candles (the newest entry is the forming candle)
  basketComponents: [],
  busy: new Set(),
  edgeCache: new Map(),      // strategyId -> {key, result}
  breakEven: new Map(),      // 'strategyId' -> {value, at}
  lastSkipBy: new Map(),
  martingaleStep: 0,
  compounderStake: null,
  queue: Promise.resolve(),
};

const keyOf = (symbol, gran) => `${symbol}:${gran}`;
const isBotSource = (src) => Boolean(src) && src !== 'Manual';
const copy = (x) => JSON.parse(JSON.stringify(x));

function log(level, source, message) {
  const entry = { time: Date.now(), level, source, message };
  state.logs.push(entry);
  if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
  bus.emit(EVENTS.BOT_LOG, entry);
}

function emitState() {
  bus.emit(EVENTS.BOT_STATE, { running: state.running, status: state.running ? 'running' : 'stopped', message: state.message, stats: copy(state.stats) });
}

// A skip is logged once per distinct reason, so a quiet market does not flood the log.
function skip(strategyLabel, reason) {
  state.stats.skipped += 1;
  state.stats.lastSkip = reason;
  if (state.lastSkipBy.get(strategyLabel) !== reason) {
    state.lastSkipBy.set(strategyLabel, reason);
    log('warn', strategyLabel, reason);
  }
  emitState();
}

function enabledStrategies() {
  const auto = store.get('auto') || {};
  return STRATEGIES.filter((s) => auto[s.id] && auto[s.id].on);
}

const basketOn = () => Boolean(store.get('basket.enabled')) && Boolean(store.get('basket.symbol'));

function paramsOf(id) {
  const out = { ...(store.get(`auto.${id}.params`) || {}) };
  if (id === 'trend' && store.get('risk.momentum.on')) out.adxMinOverride = momentumAdxMin(store.get('risk.momentum.value'));
  return out;
}

// Stake for one entry: martingale on the base strategy, compounding on the compounder, percent-of-balance, or fixed.
function stakeFor(strategy) {
  const minStake = deriv.minStake();
  let stake = toNumber(store.get('bot.stake'), 1);
  if (store.get('bot.stakeMode') === 'percent' && deriv.account && Number.isFinite(deriv.account.balance)) {
    stake = (deriv.account.balance * toNumber(store.get('bot.percent'), 1)) / 100;
  }
  if (strategy.id === 'compounder' && state.compounderStake) stake = state.compounderStake;
  const mart = store.get('auto.martingale');
  if (mart && mart.on && mart.params && mart.params.baseStrategy === strategy.id) {
    stake = martingaleStake(stake, state.martingaleStep, mart.sizing.multiplier, mart.sizing.maxSteps);
  }
  return round(Math.max(minStake, stake), 2);
}

// Trade input for one strategy and side. Multipliers get a stop loss; DCA also gets its take profit.
function inputFor(strategy, side, stake, params = {}) {
  const symbol = store.get('bot.market');
  if (strategy.family === 'multipliers') {
    const tpPct = strategy.id === 'dca' ? toNumber(params.targetPct, 2) : 0;
    const limits = multiplierLimits(stake, { slPct: 50, tpPct });
    return { typeId: 'multiplier', symbol, side, stake, multiplier: toNumber(store.get('bot.multiplier'), 100), sl: limits.sl, tp: limits.tp };
  }
  return { typeId: strategy.typeId, symbol, side, stake, duration: strategy.duration };
}

// Break-even win rate for an options contract: ask / payout. Multipliers and the basket use 0.5 (direction test).
async function breakEvenFor(strategy) {
  if (strategy.family !== 'options') return { value: 0.5, note: 'direction test (50%)' };
  const hit = state.breakEven.get(strategy.id);
  if (hit && Date.now() - hit.at < 60000) return hit;
  try {
    const q = await deriv.quote(inputFor(strategy, 'up', deriv.minStake()));
    const value = breakEvenFromQuote({ askPrice: q.askPrice, payout: q.payout });
    const out = { value, at: Date.now(), note: `from a live quote (ask ${round(q.askPrice, 4)}, payout ${round(q.payout, 4)})` };
    state.breakEven.set(strategy.id, out);
    return out;
  } catch (err) {
    return { value: 0.5, at: Date.now(), note: `no live quote (${err.message}), using 50%` };
  }
}

// Backtest of one strategy on closed candles, with break-even and horizon. Shared by the bot and the Auto tab.
export async function evaluateStrategy(strategyId, candles) {
  const strategy = STRATEGY_BY_ID[strategyId];
  if (!strategy) return { pass: false, reason: 'Unknown method.', n: 0 };
  const closed = Array.isArray(candles) ? candles : [];
  const params = paramsOf(strategyId);
  const signals = signalSeries(strategyId, closed, params);
  const horizon = strategy.family === 'options' ? estimateHorizonCandles(strategy.duration, strategy.timeframe) : BASKET_HORIZON;
  const be = await breakEvenFor(strategy);
  const res = evaluateSignals(closed, signals, {
    horizon,
    breakEven: be.value,
    minSamples: toNumber(store.get('bot.minSamples'), EDGE_DEFAULTS.minSamples),
    z: EDGE_DEFAULTS.z,
  });
  return { ...res, horizon, breakEvenNote: be.note, dirCount: signals.filter(Boolean).length };
}

// Edge gate for a strategy on the newest closed candles. Cached per candle so each candle is tested once.
async function edgeFor(strategy, closed) {
  const newest = closed[closed.length - 1];
  const key = `${closed.length}:${newest ? newest.epoch : 0}`;
  const hit = state.edgeCache.get(strategy.id);
  if (hit && hit.key === key) return hit.result;
  const result = await evaluateStrategy(strategy.id, closed);
  state.edgeCache.set(strategy.id, { key, result });
  return result;
}

function failure(strategy, err) {
  const label = strategy.source;
  if (HALT_CODES.has(err.code)) return stop(err.message, { halt: true, code: err.code });
  if (STOP_CODES.has(err.code)) return stop(err.message);
  skip(label, err.message);
  return undefined;
}

// One entry through trader.buy, with the source tag, the stats and the max-trades cap.
async function enter(strategy, side, stake, input, meta) {
  if (state.busy.has(strategy.id)) return;
  state.busy.add(strategy.id);
  try {
    await trader.buy({ ...input, stake, source: strategy.source, meta: { strategy: strategy.id, ...meta } });
    state.stats.entries += 1;
    log('ok', strategy.source, `${side === 'up' ? 'Up / Rise' : 'Down / Fall'} ${stake} USD placed. ${meta.reason || ''}`.trim());
    const cap = toNumber(store.get('bot.maxTrades'), 0);
    if (cap > 0 && state.stats.entries >= cap) stop(`Reached the maximum of ${cap} trades.`);
  } catch (err) {
    failure(strategy, err);
  } finally {
    state.busy.delete(strategy.id);
    emitState();
  }
}

// Entry for a signal strategy: edge gate first, then sizing, then the trade.
async function runSignal(strategy, closed) {
  const params = paramsOf(strategy.id);
  const ev = evaluateLatest(strategy.id, closed, params);
  if (!ev.dir) return;
  const gate = await edgeFor(strategy, closed);
  if (!gate.pass) return skip(strategy.source, `Edge test not passed: ${gate.reason}.`);
  if (strategy.id === 'dca' && !dcaCanAdd(openCount(strategy.source), params.maxAdds)) {
    return skip(strategy.source, `DCA has its maximum of ${params.maxAdds} adds open.`);
  }
  const stake = stakeFor(strategy);
  const input = inputFor(strategy, ev.dir, stake, params);
  return enter(strategy, ev.dir, stake, input, { reason: ev.reason, regime: ev.regime });
}

const openCount = (source) => trader.positions().filter((p) => p.source === source && p.status === 'open').length;

function cancelWaiting(source) {
  for (const o of pending.list()) {
    if (o.status === 'waiting' && o.input && o.input.source === source) pending.cancel(o.id);
  }
}

// Grid: a ladder of virtual limits around the mean while the market is in a range. Re-planned on each closed candle.
async function runGrid(strategy, closed) {
  const params = paramsOf(strategy.id);
  const ev = evaluateLatest(strategy.id, closed, params);
  cancelWaiting(strategy.source);
  if (!ev.levels || ev.regime !== 'range') return;
  const gate = await edgeFor(strategy, closed);
  if (!gate.pass) return skip(strategy.source, `Edge test not passed: ${gate.reason}.`);
  const stake = stakeFor(strategy);
  const symbol = store.get('bot.market');
  for (const level of ev.levels.lower) {
    pending.add({ type: 'limit', side: 'up', symbol, triggerPrice: level, input: { ...inputFor(strategy, 'up', stake, params), source: strategy.source, meta: { strategy: strategy.id } } });
  }
  for (const level of ev.levels.upper) {
    pending.add({ type: 'limit', side: 'down', symbol, triggerPrice: level, input: { ...inputFor(strategy, 'down', stake, params), source: strategy.source, meta: { strategy: strategy.id } } });
  }
  log('info', strategy.source, `Grid placed ${ev.levels.lower.length} buy and ${ev.levels.upper.length} sell virtual limits around ${round(ev.levels.mid, 4)}.`);
}

// Smart Limit: buy limit just above support, sell limit just below resistance, only during consolidation.
async function runSmartLimit(strategy, closed) {
  const params = paramsOf(strategy.id);
  cancelWaiting(strategy.source);
  const plan = smartLimitPlan(closed, { adxMax: params.adxMax, lookback: params.lookback, bufferAtr: params.bufferAtr });
  if (!plan) return;
  const gate = await edgeFor(strategy, closed);
  if (!gate.pass) return skip(strategy.source, `Edge test not passed: ${gate.reason}.`);
  const stake = stakeFor(strategy);
  const symbol = store.get('bot.market');
  pending.add({ type: 'limit', side: 'up', symbol, triggerPrice: plan.up.price, input: { ...inputFor(strategy, 'up', stake, params), source: strategy.source, meta: { strategy: strategy.id } } });
  pending.add({ type: 'limit', side: 'down', symbol, triggerPrice: plan.down.price, input: { ...inputFor(strategy, 'down', stake, params), source: strategy.source, meta: { strategy: strategy.id } } });
  log('info', strategy.source, `Limits placed: buy ${round(plan.up.price, 4)}, sell ${round(plan.down.price, 4)}.`);
}

// Strategies with no entry signal of their own (hedging and martingale) are handled elsewhere.
const POSITION_ONLY = new Set(['hedge', 'martingale']);

async function runStrategy(strategy, closed) {
  if (!state.running || POSITION_ONLY.has(strategy.id)) return;
  if (strategy.id === 'grid') return runGrid(strategy, closed);
  if (strategy.id === 'smartlimit') return runSmartLimit(strategy, closed);
  return runSignal(strategy, closed);
}

// Smart Basket: every component must lean one way (confluence), the basket's own EMA trend must agree, and the trend must pass the edge gate.
async function runBasket(closedBasket, symbol, gran) {
  const cfg = store.get('basket') || {};
  const currency = basketCurrency(symbol);
  const comps = state.basketComponents
    .map((sym) => ({ symbol: sym, candles: closedOf(keyOf(sym, gran)) }))
    .filter((c) => c.candles.length >= cfg.emaSlow + 5);
  const conf = basketConfluence({ currency, components: comps, emaFast: cfg.emaFast, emaSlow: cfg.emaSlow, threshold: cfg.threshold });
  if (!conf.pass || !conf.direction) return skip('Basket', conf.reason || 'Confluence below the threshold.');
  const trend = emaTrendSeries(closedBasket, cfg.emaFast, cfg.emaSlow);
  const trendNow = trend[trend.length - 1];
  if (trendNow !== conf.direction) return skip('Basket', 'Basket trend and component confluence disagree.');
  const gate = evaluateSignals(closedBasket, trend, { horizon: BASKET_HORIZON, breakEven: 0.5, minSamples: toNumber(store.get('bot.minSamples'), EDGE_DEFAULTS.minSamples), z: EDGE_DEFAULTS.z });
  if (!gate.pass) return skip('Basket', `Edge test not passed: ${gate.reason}.`);
  const stake = stakeFor({ id: 'basket' });
  const limits = multiplierLimits(stake, { slPct: 50 });
  const base = { symbol, side: conf.direction, stake, multiplier: toNumber(store.get('bot.multiplier'), 100), sl: limits.sl, tp: null };
  return placeBasket(base, { reason: conf.reason, score: conf.score });
}

// Basket entry. If Deriv refuses the basket multiplier, it is retried once as Rise/Fall (the basket's fallback contracts).
async function placeBasket(base, meta) {
  if (state.busy.has('basket')) return;
  state.busy.add('basket');
  try {
    try {
      await trader.buy({ ...base, typeId: 'basket', source: 'Basket', meta: { strategy: 'basket', ...meta } });
    } catch (err) {
      if (!RETRY_CODES.has(err.code)) throw err;
      log('info', 'Basket', 'Deriv refused the basket multiplier. Retrying as Rise/Fall.');
      await trader.buy({
        symbol: base.symbol, side: base.side, stake: base.stake, typeId: 'basket', fallback: true,
        duration: { value: 5, unit: 'm' }, source: 'Basket', meta: { strategy: 'basket', ...meta },
      });
    }
    state.stats.entries += 1;
    log('ok', 'Basket', `${base.side === 'up' ? 'Buy' : 'Sell'} ${base.stake} USD on the basket. ${meta.reason || ''}`.trim());
  } catch (err) {
    failure({ source: 'Basket' }, err);
  } finally {
    state.busy.delete('basket');
    emitState();
  }
}

function closedOf(key) {
  const arr = state.candles.get(key);
  return arr ? arr.slice(0, -1) : [];
}

// Applies one live candle to the stored series (a new bar, or an update of the forming bar).
function applyLive(arr, ev) {
  const last = arr[arr.length - 1];
  if (ev.isNew) arr.push(ev.candle);
  else if (last && last.epoch === ev.candle.epoch) arr[arr.length - 1] = ev.candle;
}

// Work for the candle streams. Evaluations run one at a time so two entries never race.
function queue(task) {
  state.queue = state.queue.then(task).catch((err) => log('error', 'Bot', `Evaluation failed: ${err && err.message ? err.message : err}`));
}

function onCandleEvent(symbol, gran, ev) {
  const key = keyOf(symbol, gran);
  if (ev.type === 'history') {
    state.candles.set(key, ev.candles.slice());
    return;
  }
  const arr = state.candles.get(key);
  if (!arr) return;
  applyLive(arr, ev);
  if (!ev.isNew || !state.running) return;
  if (symbol === store.get('bot.market')) {
    for (const s of enabledStrategies()) {
      if (s.timeframe === gran) queue(() => runStrategy(s, closedOf(key)));
    }
  }
  if (basketOn() && symbol === store.get('basket.symbol') && gran === toNumber(store.get('basket.timeframe'), 60)) {
    queue(() => runBasket(closedOf(key), symbol, gran));
  }
}

// Stops every method. Open positions stay open. Waiting grid and limit orders are cancelled.
function stop(reason = 'Stopped', opts = {}) {
  if (!state.running && state.streams.length === 0) return;
  state.running = false;
  for (const s of state.streams.splice(0)) {
    try { s.stop(); } catch (_) { /* stream already gone */ }
  }
  cancelWaiting('Bot-Grid');
  cancelWaiting('Bot-Limit');
  state.message = reason;
  if (opts.halt) {
    log('error', 'Risk', reason);
    bus.emit(EVENTS.RISK_HALT, { reason, code: opts.code });
    if (opts.code === 'DAILY_STOP' && store.get('risk.dailyStop.lockManual')) {
      store.patch('risk.dailyStop', { locked: true });
      log('warn', 'Risk', 'Manual trading is locked until you unlock it in Risk.');
    }
  } else {
    log('info', 'Bot', `Stopped: ${reason} Open positions stay open.`);
  }
  emitState();
}

// Closes the pair when the hedge net target is reached, and opens the opposite leg once a bot position is down enough.
function hedgeCheck() {
  const cfg = store.get('auto.hedge');
  if (!cfg || !cfg.on) return;
  const trigger = toNumber(cfg.params && cfg.params.triggerPct, 30);
  const target = toNumber(cfg.params && cfg.params.netTargetPct, 5);
  const list = trader.positions();
  for (const p of list) {
    if (p.status !== 'open' || !isBotSource(p.source) || p.source === 'Bot-Hedge') continue;
    const leg = list.find((h) => h.meta && h.meta.hedgeOf === p.contractId && h.status !== 'closed');
    if (!leg) {
      if (hedgeDue(p.pnlPct, trigger) && !state.busy.has(`hedge:${p.contractId}`)) openHedge(p);
    } else if (hedgeNetReached(p.profit, leg.profit, p.stake, leg.stake, target) && !state.busy.has(`close:${p.contractId}`)) {
      closePair(p.contractId, leg.contractId);
    }
  }
}

function openHedge(p) {
  const strategy = STRATEGY_BY_ID.hedge;
  const id = `hedge:${p.contractId}`;
  state.busy.add(id);
  const input = {
    typeId: p.typeId, symbol: p.symbol, side: p.side === 'up' ? 'down' : 'up', stake: p.stake,
    duration: strategy.duration, multiplier: p.multiplier || undefined,
  };
  trader.buy({ ...input, source: 'Bot-Hedge', meta: { hedgeOf: p.contractId, strategy: 'hedge' } })
    .then(() => {
      state.stats.entries += 1;
      log('ok', 'Bot-Hedge', `Opposite leg opened against contract ${p.contractId}.`);
    })
    .catch((err) => log('warn', 'Bot-Hedge', `Hedge not opened: ${err.message}`))
    .finally(() => { state.busy.delete(id); emitState(); });
}

function closePair(a, b) {
  const id = `close:${a}`;
  state.busy.add(id);
  Promise.allSettled([trader.sell(a, 'hedge net target'), trader.sell(b, 'hedge net target')])
    .then(() => log('ok', 'Bot-Hedge', 'Hedge pair closed at the net target.'))
    .finally(() => state.busy.delete(id));
}

// Result of a closed bot trade drives the martingale and compounder states, and the win/loss stats.
function onPositionClosed(position) {
  if (!position || !isBotSource(position.source)) return;
  const result = position.profit > 0 ? 'win' : position.profit < 0 ? 'loss' : 'breakeven';
  const mart = store.get('auto.martingale');
  if (mart && mart.on) state.martingaleStep = martingaleNextStep(state.martingaleStep, result, mart.sizing.maxSteps);
  if (position.source === 'Bot-Compounder') {
    const cs = store.get('auto.compounder.sizing') || {};
    const base = toNumber(store.get('bot.stake'), 1);
    state.compounderStake = compounderNext(state.compounderStake || base, result, { base, multiplierOnWin: cs.multiplierOnWin, maxStake: cs.maxStake });
  }
  if (state.running) {
    if (result === 'win') state.stats.wins += 1;
    if (result === 'loss') state.stats.losses += 1;
  }
  emitState();
}

export const bot = {
  // Starts the methods that are switched on. Refuses when disconnected, when real trading is locked, or when nothing is on.
  async start() {
    if (state.running) return;
    if (!deriv.isAuthed() || !deriv.account) throw new DerivError('Connect to your Deriv account first (Run at the top).', { code: 'NotConnected' });
    const lock = realLockCheck(store.get('risk'), deriv.account.isVirtual);
    if (!lock.ok) throw new DerivError(lock.reasons[0].message, { code: 'REAL_LOCKED' });
    const strategies = enabledStrategies().filter((s) => !POSITION_ONLY.has(s.id));
    const basket = basketOn();
    if (!strategies.length && !basket) throw new DerivError('Switch on at least one entry method (Micro-Compounder, Trend Sniper and so on, or Smart Basket).', { code: 'NoMethods' });
    const market = store.get('bot.market');
    if (strategies.length && !market) throw new DerivError('Choose a market for the bot.', { code: 'NoMarket' });

    trader.init();
    trader.markSession();
    state.running = true;
    state.startedAt = Date.now();
    state.stats = { entries: 0, skipped: 0, lastSkip: '', wins: 0, losses: 0 };
    state.martingaleStep = 0;
    state.compounderStake = null;
    state.edgeCache.clear();
    state.lastSkipBy.clear();
    state.message = 'Starting';
    emitState();
    log('info', 'Bot', `Started: ${strategies.map((s) => s.name).join(', ') || 'no candle methods'}${basket ? ' + Smart Basket' : ''}.`);

    try {
      const frames = new Set(strategies.map((s) => s.timeframe));
      for (const gran of frames) {
        const stream = await deriv.streamCandles(market, gran, (ev) => onCandleEvent(market, gran, ev), EDGE_DEFAULTS.historyCandles);
        state.streams.push(stream);
      }
      if (basket) await this._startBasketStreams();
    } catch (err) {
      stop(`Could not start the candle feeds: ${err.message}`);
      throw err;
    }
    state.message = 'Watching the market';
    emitState();
  },

  async _startBasketStreams() {
    const symbol = store.get('basket.symbol');
    const gran = toNumber(store.get('basket.timeframe'), 60);
    const currency = basketCurrency(symbol);
    const markets = await deriv.getMarkets();
    state.basketComponents = componentSymbols(currency, markets).slice(0, MAX_BASKET_COMPONENTS);
    const all = [symbol, ...state.basketComponents];
    for (const sym of all) {
      const stream = await deriv.streamCandles(sym, gran, (ev) => onCandleEvent(sym, gran, ev), EDGE_DEFAULTS.historyCandles);
      state.streams.push(stream);
    }
    log('info', 'Basket', `Watching ${state.basketComponents.length} components for ${symbol}.`);
  },

  stop(reason = 'Stopped by you.') {
    stop(reason);
  },

  // Entry checks for one trade from the Deriv Bot tab. Returns the risk verdict without placing anything.
  status() {
    return {
      running: state.running,
      message: state.message,
      startedAt: state.startedAt,
      stats: copy(state.stats),
      methods: enabledStrategies().map((s) => s.name),
      basket: basketOn(),
    };
  },

  logs() {
    return state.logs.slice();
  },

  evaluateStrategy,

  // Wires position and account events. Called once from app.js.
  init() {
    bus.on(EVENTS.POSITION_CLOSED, ({ position }) => onPositionClosed(position));
    bus.on(EVENTS.POSITION_UPDATE, () => { if (state.running) hedgeCheck(); });
    bus.on(EVENTS.ACCOUNT, (acct) => { if (!acct && state.running) stop('Disconnected from Deriv.'); });
    setInterval(() => emitState(), TIMING.monitorEveryMs * 10);
  },
};
