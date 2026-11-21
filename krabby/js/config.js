// Krabby configuration. Data only: endpoints, trade catalogue, strategy catalogue, defaults.
// The Deriv layer, the engine and the UI all read from here, so behaviour is changed in one place.

export const APP_NAME = 'Krabby Demo';
export const APP_VERSION = '1.0.0';

// The bot is ours. SimpleXEngine is the name and [BOT] the tag. Deriv is only the broker the API reaches.
export const BOT_NAME = 'SimpleXEngine';
export const BOT_TAG = '[BOT]';
// The one approved beta wording. It promises no result and does not claim that the bot earns more with time.
export const BETA_NOTICE = 'SimpleXEngine is a beta. It learns from the market data and trades it sees on this device, so the more you use it here, the more data it learns from. More data can improve its model. Nothing is guaranteed: no forecast or method wins every time, and you can lose the stake.';
export const STORAGE_PREFIX = 'krabby.v1.';

const DEFAULT_ENDPOINTS = {
  // New API. REST (PAT + app id) issues an OTP, the OTP URL opens an authenticated socket.
  newApiBase: 'https://api.derivws.com',
  newPublicWs: 'wss://api.derivws.com/trading/v1/options/ws/public',
  newAuthWsBase: 'wss://api.derivws.com/trading/v1/options/ws', // + '/demo' or '/real' ; the OTP URL is used as returned
  // Legacy API. One socket, authorised with an API token sent as {authorize: token}.
  legacyWs: 'wss://ws.derivws.com/websockets/v3', // + '?app_id=<APP_ID>'
  legacyDefaultAppId: '1089',
};

// Tests and mirrors can override endpoints by setting globalThis.KRABBY_ENDPOINTS before this module loads.
export const ENDPOINTS = Object.freeze({ ...DEFAULT_ENDPOINTS, ...(globalThis.KRABBY_ENDPOINTS || {}) });

// Chart timeframes. base = the Deriv granularity fetched. aggregate = bars built from base candles (weekly, monthly, UTC).
export const TIMEFRAMES = [
  { id: 60, label: '1m', base: 60 }, { id: 120, label: '2m', base: 120 }, { id: 180, label: '3m', base: 180 },
  { id: 300, label: '5m', base: 300 }, { id: 600, label: '10m', base: 600 }, { id: 900, label: '15m', base: 900 },
  { id: 1800, label: '30m', base: 1800 }, { id: 3600, label: '1H', base: 3600 }, { id: 7200, label: '2H', base: 7200 },
  { id: 14400, label: '4H', base: 14400 }, { id: 86400, label: '1D', base: 86400 },
  { id: 'W', label: '1W', base: 86400, aggregate: 'W', count: 1000 },
  { id: 'MN', label: '1MN', base: 86400, aggregate: 'MN', count: 5000 },
];

// Numeric timeframes in seconds (the strategy catalogue and the bot use these).
export const GRANULARITIES = TIMEFRAMES.filter((t) => typeof t.id === 'number').map((t) => ({ seconds: t.id, label: t.label }));

export const CHART_TYPES = [
  { id: 'candles', label: 'Candlestick' },
  { id: 'bars', label: 'Bars (OHLC)' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
];

// Deriv duration units: t = ticks, s = seconds, m = minutes, h = hours, d = days.
export const DURATION_UNITS = [
  { id: 't', label: 'ticks' }, { id: 's', label: 'seconds' }, { id: 'm', label: 'minutes' },
  { id: 'h', label: 'hours' }, { id: 'd', label: 'days' },
];

export const TRADE_FAMILIES = [
  { id: 'options', label: 'Options', hint: 'Fixed payout and fixed expiry. Choose a type below.' },
  { id: 'multipliers', label: 'Multipliers', hint: 'Up or Down exposure. Loss is capped at your stake. Optional stop loss and take profit.' },
  { id: 'cfd', label: 'CFD', hint: 'Buy or Sell wording on Deriv Multipliers. MT5 CFDs (BTCLTC, XAUUSD on MT5) are not on the Deriv API.' },
  { id: 'accumulators', label: 'Accumulators', hint: 'Single direction. Payout grows each tick while price stays in the range. Stake is lost if price leaves the range.' },
  { id: 'basket', label: 'Basket', hint: 'Basket indices (Gold, AUD, EUR, GBP, USD baskets). Smart confluence gate on the Basket tab.' },
];

// Every trade type: contract codes sent to Deriv, the one-word buttons shown, and the inputs it needs.
// params: duration | barrier | barrier2 | digit | multiplier | growth | stake | limit (SL/TP) | cancellation
// contracts/buttons: 'up' = first side, 'down' = second side (accumulators have only 'up').
export const TRADE_TYPES = [
  { id: 'rise_fall', family: 'options', label: 'Rise / Fall', contracts: { up: 'CALL', down: 'PUT' }, buttons: { up: 'RISE', down: 'FALL' },
    params: ['duration'], duration: { value: 5, unit: 't' },
    description: 'Win the payout if the exit tick is higher (Rise) or lower (Fall) than the entry at expiry.' },
  { id: 'higher_lower', family: 'options', label: 'Higher / Lower', contracts: { up: 'CALLE', down: 'PUTE' }, buttons: { up: 'HIGHER', down: 'LOWER' },
    params: ['duration', 'barrier'], duration: { value: 5, unit: 't' }, barrier: '+0.10',
    description: 'Win if the exit price is above (Higher) or below (Lower) your barrier at expiry.' },
  { id: 'touch', family: 'options', label: 'Touch / No Touch', contracts: { up: 'ONETOUCH', down: 'NOTOUCH' }, buttons: { up: 'TOUCH', down: 'NO TOUCH' },
    params: ['duration', 'barrier'], duration: { value: 5, unit: 't' }, barrier: '+0.10',
    description: 'Touch wins if price reaches the barrier before expiry. No Touch wins if it never does.' },
  { id: 'ends_in_out', family: 'options', label: 'Ends Between / Outside', contracts: { up: 'EXPIRYRANGE', down: 'EXPIRYMISS' }, buttons: { up: 'IN', down: 'OUT' },
    params: ['duration', 'barrier', 'barrier2'], duration: { value: 5, unit: 't' }, barrier: '+0.10', barrier2: '-0.10',
    description: 'Win if the exit price is between (In) or outside (Out) two barriers, judged only at expiry.' },
  { id: 'stays_in_out', family: 'options', label: 'Stays Between / Goes Outside', contracts: { up: 'RANGE', down: 'UPORDOWN' }, buttons: { up: 'IN', down: 'OUT' },
    params: ['duration', 'barrier', 'barrier2'], duration: { value: 5, unit: 't' }, barrier: '+0.10', barrier2: '-0.10',
    description: 'Stays Between wins if price never leaves the two barriers. Goes Outside wins if it breaks out at any time before expiry.' },
  { id: 'matches_differs', family: 'options', label: 'Matches / Differs', contracts: { up: 'DIGITMATCH', down: 'DIGITDIFF' }, buttons: { up: 'MATCH', down: 'DIFFER' },
    params: ['duration', 'digit'], duration: { value: 5, unit: 't' }, digit: 5,
    description: 'Win if the last digit of the exit price matches (or differs from) your chosen digit 0-9.' },
  { id: 'even_odd', family: 'options', label: 'Even / Odd', contracts: { up: 'DIGITEVEN', down: 'DIGITODD' }, buttons: { up: 'EVEN', down: 'ODD' },
    params: ['duration'], duration: { value: 5, unit: 't' },
    description: 'Win if the last digit of the exit price is even (Even) or odd (Odd).' },
  { id: 'over_under', family: 'options', label: 'Over / Under', contracts: { up: 'DIGITOVER', down: 'DIGITUNDER' }, buttons: { up: 'OVER', down: 'UNDER' },
    params: ['duration', 'digit'], duration: { value: 5, unit: 't' }, digit: 5,
    description: 'Win if the last digit of the exit price is over (Over) or under (Under) your chosen digit.' },
  { id: 'asians', family: 'options', label: 'Asians', contracts: { up: 'ASIANU', down: 'ASIAND' }, buttons: { up: 'RISE', down: 'FALL' },
    params: ['duration'], duration: { value: 5, unit: 't' },
    description: 'Asian option: compares the average of the ticks over the period with the starting price. Read the longcode before trading.' },
  { id: 'reset_call_put', family: 'options', label: 'Reset Call / Put', contracts: { up: 'RESETCALL', down: 'RESETPUT' }, buttons: { up: 'CALL', down: 'PUT' },
    params: ['duration', 'barrier'], duration: { value: 5, unit: 't' }, barrier: '+0.10',
    description: 'A Higher/Lower variant where a favourable move before expiry can reset the reference level. Check the longcode for the exact rule.' },
  { id: 'high_low_tick', family: 'options', label: 'High Tick / Low Tick', contracts: { up: 'TICKHIGH', down: 'TICKLOW' }, buttons: { up: 'HIGH', down: 'LOW' },
    params: [], duration: { value: 5, unit: 't' },
    description: 'Win if the tick you pick is the highest (High) or lowest (Low) among the next five ticks.' },
  { id: 'only_ups_downs', family: 'options', label: 'Only Ups / Only Downs', contracts: { up: 'ONLYUPS', down: 'ONLYDOWNS' }, buttons: { up: 'UPS', down: 'DOWNS' },
    params: ['duration'], duration: { value: 5, unit: 't' },
    description: 'Keeps paying while price keeps moving only up (Ups) or only down (Downs). Read the longcode for the exact end rule.' },
  { id: 'vanillas', family: 'options', label: 'Vanillas', contracts: { up: 'VANILLALONGCALL', down: 'VANILLALONGPUT' }, buttons: { up: 'CALL', down: 'PUT' },
    params: ['duration', 'barrier'], duration: { value: 5, unit: 'm' }, barrier: '+0.10',
    description: 'Option with a strike you choose. Payout depends on the strike distance and the time left.' },
  { id: 'turbos', family: 'options', label: 'Turbos', contracts: { up: 'TURBOSLONG', down: 'TURBOSSHORT' }, buttons: { up: 'UP', down: 'DOWN' },
    params: ['duration', 'barrier'], duration: { value: 5, unit: 'm' }, barrier: '-0.10',
    description: 'Knock-out option: a higher payout while price stays on your side of the barrier. Touching the barrier ends it early.' },
  { id: 'multiplier', family: 'multipliers', label: 'Multiplier', contracts: { up: 'MULTUP', down: 'MULTDOWN' }, buttons: { up: 'UP', down: 'DOWN' },
    params: ['multiplier', 'limit'], description: 'Profit or loss = % price move x multiplier x stake. Loss cannot exceed the stake. Stop loss and take profit optional.' },
  { id: 'cfd', family: 'cfd', label: 'CFD (Buy / Sell)', contracts: { up: 'MULTUP', down: 'MULTDOWN' }, buttons: { up: 'BUY', down: 'SELL' },
    params: ['stake', 'multiplier', 'limit'], description: 'Buy/Sell wording for the same Deriv Multipliers contract. Volume is your stake in USD, because Deriv has no lot size.' },
  { id: 'accumulator', family: 'accumulators', label: 'Accumulator', contracts: { up: 'ACCU' }, buttons: { up: 'BUY' },
    params: ['growth', 'limit'], description: 'Buy only. Each tick that stays in the barrier range grows the payout by the growth rate. Leaving the range ends it and loses the stake.' },
  { id: 'basket', family: 'basket', label: 'Basket (Buy / Sell)', contracts: { up: 'MULTUP', down: 'MULTDOWN' }, buttons: { up: 'BUY', down: 'SELL' },
    params: ['stake', 'multiplier', 'limit'], fallbackContracts: { up: 'CALL', down: 'PUT' },
    description: 'Buy/Sell a basket index using Multipliers when Deriv offers them for that basket, otherwise Rise/Fall.' },
];

export const TRADE_TYPE_BY_ID = Object.freeze(Object.fromEntries(TRADE_TYPES.map((t) => [t.id, t])));

// Trade types shown by default, one per family. Every other type appears only when "Show all contract types" is on.
export const CURATED_TYPE_IDS = Object.freeze(['rise_fall', 'higher_lower', 'touch', 'multiplier', 'cfd', 'accumulator', 'basket']);
export const DEFAULT_MULTIPLIERS = [5, 10, 20, 30, 40, 50, 100, 200, 300, 400, 500, 1000, 2000];
export const DEFAULT_GROWTH_RATES = [1, 2, 3, 4, 5];

// Order types. Market is always on. The others are virtual: Krabby watches the price and fires the order
// while the app is open. Deriv has no server-side pending orders for these products.
export const ORDER_TYPES = [
  { id: 'market', label: 'Market', defaultOn: true, note: 'Executes now at the quoted ask price.' },
  { id: 'limit', label: 'Limit', defaultOn: false, note: 'Fires when price reaches your level (virtual, runs while Krabby is open).' },
  { id: 'stop', label: 'Stop', defaultOn: false, note: 'Fires when price breaks through your level (virtual).' },
  { id: 'stop_limit', label: 'Stop Limit', defaultOn: false, note: 'Stop triggers a limit order at your price (virtual).' },
  { id: 'oco', label: 'OCO', defaultOn: false, note: 'One-cancels-other: when one side fills, the other is cancelled.' },
  { id: 'trailing_stop_limit', label: 'Trailing Stop Limit', defaultOn: false, note: 'Trailing stop that triggers a limit order (virtual).' },
];

// Money display. style 'smart' shows full amounts below smartThreshold and K / M / B amounts at or above it.
export const FORMAT_DEFAULTS = Object.freeze({
  style: 'smart', smartThreshold: 10000, compactDecimals: 1, fullDecimals: 2,
  decimalSep: '.', thousandsSep: ',', showCurrency: true,
});

// Colour tokens for the two built-in looks. settings.appearance.tokens holds the live values.
export const APPEARANCE_PRESETS = Object.freeze({
  classic: { buy: '#22c55e', sell: '#ef4444', bg: '#0b1117', surface: '#121b24', text: '#e6edf3', muted: '#8b98a5', accent: '#14b8a6', chartBg: '#0b1117', grid: '#1b2631', candleUp: '#22c55e', candleDown: '#ef4444', line: '#14b8a6' },
  alternative: { buy: '#3b82f6', sell: '#ef4444', bg: '#0a0f1c', surface: '#111a2b', text: '#e5ecf8', muted: '#8ea0bd', accent: '#38bdf8', chartBg: '#0a0f1c', grid: '#1a2740', candleUp: '#3b82f6', candleDown: '#ef4444', line: '#38bdf8' },
});
export const APPEARANCE_DEFAULTS = Object.freeze({
  preset: 'classic', tokens: { ...APPEARANCE_PRESETS.classic }, fontScale: 100, radius: 8,
});

export const THEMES = [
  { id: 'classic', label: 'Classic', buy: '#22c55e', sell: '#ef4444', note: 'Green buy, red sell.' },
  { id: 'alternative', label: 'Alternative', buy: '#3b82f6', sell: '#ef4444', note: 'Blue buy, red sell.' },
];

// Every trade the app places is tagged with one of these sources (Analytics splits on them).
export const SOURCES = ['Manual', 'Bot-Compounder', 'Bot-Trend', 'Bot-Grid', 'Bot-DCA', 'Bot-Hedge',
  'Bot-Scalp', 'Bot-MeanRev', 'Bot-Martingale', 'Bot-Limit', 'Bot-Supertrend', 'Bot-Donchian', 'Bot-MACD',
  'Bot-Ichimoku', 'Bot-DMI', 'Bot-Keltner', 'Basket'];

// Strategy catalogue. paramSpecs drive the UI controls. sizing: base null = Deriv minimum stake.
export const STRATEGIES = [
  { id: 'compounder', source: 'Bot-Compounder', name: 'Micro-Compounder', timeframe: 60, family: 'options', typeId: 'rise_fall',
    duration: { value: 3, unit: 'm' }, bias: 'mean-reversion',
    summary: 'Bollinger Bands (20, 2.0) and RSI (14) on 1-minute candles. Rise below the lower band with RSI under 30. Fall above the upper band with RSI over 70.',
    caution: 'Stake multiplies after each win and resets after a loss. Compounding changes how big the swings get, not the expected value.',
    params: { bbPeriod: 20, bbK: 2, rsiPeriod: 14, rsiLow: 30, rsiHigh: 70 },
    sizing: { multiplierOnWin: 1.2, maxStake: 2 },
    paramSpecs: [
      { key: 'bbPeriod', label: 'Bollinger period', min: 5, max: 60, step: 1 },
      { key: 'bbK', label: 'Bollinger width (sigma)', min: 1, max: 3.5, step: 0.1 },
      { key: 'rsiPeriod', label: 'RSI period', min: 2, max: 50, step: 1 },
      { key: 'rsiLow', label: 'RSI oversold', min: 5, max: 45, step: 1 },
      { key: 'rsiHigh', label: 'RSI overbought', min: 55, max: 95, step: 1 },
    ],
    sizingSpecs: [
      { key: 'multiplierOnWin', label: 'Stake x after a win', min: 1, max: 3, step: 0.05 },
      { key: 'maxStake', label: 'Maximum stake (USD)', min: 0.35, max: 1000, step: 0.05 },
    ] },
  { id: 'trend', source: 'Bot-Trend', name: 'Trend Sniper', timeframe: 60, family: 'multipliers', typeId: 'multiplier', bias: 'trend',
    summary: 'EMA 9 crossing EMA 21, confirmed by MACD (12, 26, 9) and ADX above a threshold. Momentum Sensitivity moves the ADX threshold.',
    caution: 'Trend signals lag and whipsaw in ranges. Keep the ADX filter on.',
    params: { emaFast: 9, emaSlow: 21, macdFast: 12, macdSlow: 26, macdSignal: 9, adxMin: 25 },
    sizing: {},
    paramSpecs: [
      { key: 'emaFast', label: 'EMA fast', min: 2, max: 50, step: 1 },
      { key: 'emaSlow', label: 'EMA slow', min: 5, max: 200, step: 1 },
      { key: 'adxMin', label: 'ADX minimum', min: 5, max: 50, step: 1 },
    ] },
  { id: 'grid', source: 'Bot-Grid', name: 'Grid', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 2, unit: 'm' }, bias: 'range',
    summary: 'In a range (ADX below the limit) it lays a ladder of virtual buy-limits below price and sell-limits above it, spaced by ATR.',
    caution: 'Grids lose heavily when a range breaks. Set the session stop loss.',
    params: { levels: 3, atrSpacing: 1.0, adxMax: 20 },
    sizing: {},
    paramSpecs: [
      { key: 'levels', label: 'Ladder levels per side', min: 1, max: 6, step: 1 },
      { key: 'atrSpacing', label: 'Spacing (x ATR)', min: 0.3, max: 3, step: 0.1 },
      { key: 'adxMax', label: 'Range ADX maximum', min: 5, max: 35, step: 1 },
    ] },
  { id: 'scalp', source: 'Bot-Scalp', name: 'Scalping', timeframe: 60, family: 'multipliers', typeId: 'multiplier', bias: 'trend',
    summary: 'Short EMA 5/13 crosses on 1-minute candles with tight stop loss and take profit.',
    caution: 'Spreads and slippage eat small targets. Check the net result in Analytics.',
    params: { emaFast: 5, emaSlow: 13 },
    sizing: {},
    paramSpecs: [
      { key: 'emaFast', label: 'EMA fast', min: 2, max: 30, step: 1 },
      { key: 'emaSlow', label: 'EMA slow', min: 5, max: 60, step: 1 },
    ] },
  { id: 'meanrev', source: 'Bot-MeanRev', name: 'Mean Reversion', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 3, unit: 'm' }, bias: 'mean-reversion',
    summary: 'Bollinger Bands plus RSI. Buys a close below the lower band with RSI under the oversold level, sells a close above the upper band with RSI over the overbought level, only when ADX is low.',
    caution: 'Mean reversion fails in strong trends. The ADX filter reduces that risk but does not remove it.',
    params: { bbPeriod: 20, bbK: 2, rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, adxMax: 25 },
    sizing: {},
    paramSpecs: [
      { key: 'adxMax', label: 'ADX maximum (ranges only)', min: 5, max: 50, step: 1 },
      { key: 'rsiLow', label: 'RSI oversold', min: 5, max: 45, step: 1 },
      { key: 'rsiHigh', label: 'RSI overbought', min: 55, max: 95, step: 1 },
    ] },
  { id: 'smartlimit', source: 'Bot-Limit', name: 'Smart Limit (support / resistance)', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 5, unit: 'm' }, bias: 'range',
    summary: 'Only during consolidation (ADX below the limit). Places virtual buy-limits just above recent swing lows (support) and sell-limits just below recent swing highs (resistance), waiting for a bounce.',
    caution: 'Support breaks. A pending order fills even when the level fails. Use the session stop.',
    params: { adxMax: 20, lookback: 20, bufferAtr: 0.1 },
    sizing: {},
    paramSpecs: [
      { key: 'adxMax', label: 'Consolidation ADX maximum', min: 5, max: 35, step: 1 },
      { key: 'lookback', label: 'Swing lookback (candles)', min: 5, max: 100, step: 1 },
      { key: 'bufferAtr', label: 'Buffer above/below level (x ATR)', min: 0, max: 1, step: 0.05 },
    ] },
  { id: 'supertrend', source: 'Bot-Supertrend', name: 'Supertrend', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 5, unit: 'm' }, bias: 'trend',
    summary: 'ATR bands around the median price form a Supertrend line. Rise when the trend flips up on a closed candle, Fall when it flips down.',
    caution: 'Flips whipsaw in sideways markets. The edge test on the chosen market decides whether it trades at all.',
    params: { atrPeriod: 10, multiplier: 3 }, sizing: {},
    paramSpecs: [
      { key: 'atrPeriod', label: 'ATR period', min: 3, max: 50, step: 1 },
      { key: 'multiplier', label: 'ATR multiplier', min: 1, max: 6, step: 0.1 },
    ] },
  { id: 'donchian', source: 'Bot-Donchian', name: 'Donchian Breakout', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 5, unit: 'm' }, bias: 'trend',
    summary: 'Rise when a closed candle breaks above the highest high of the last N candles. Fall when it breaks below the lowest low.',
    caution: 'Breakouts often fail in ranges and around news. A breakout is a first move, not a confirmed trend.',
    params: { period: 20 }, sizing: {},
    paramSpecs: [{ key: 'period', label: 'Channel length (candles)', min: 5, max: 100, step: 1 }] },
  { id: 'macdcross', source: 'Bot-MACD', name: 'MACD Trend Cross', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 5, unit: 'm' }, bias: 'trend',
    summary: 'The MACD line crosses its signal line. Rise only when the cross is above zero, Fall only when it is below zero, so the signal agrees with the trend side.',
    caution: 'Crosses lag price. The zero-line filter reduces false signals but does not remove them.',
    params: { fast: 12, slow: 26, signal: 9 }, sizing: {},
    paramSpecs: [
      { key: 'fast', label: 'Fast EMA', min: 2, max: 50, step: 1 },
      { key: 'slow', label: 'Slow EMA', min: 5, max: 100, step: 1 },
      { key: 'signal', label: 'Signal EMA', min: 2, max: 30, step: 1 },
    ] },
  { id: 'ichimoku', source: 'Bot-Ichimoku', name: 'Ichimoku Cloud Cross', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 5, unit: 'm' }, bias: 'trend',
    summary: 'Tenkan-sen crosses Kijun-sen. Rise only when the close is above the cloud, Fall only when it is below the cloud.',
    caution: 'Ichimoku is slow and noisy in ranges. The cloud here is drawn at the current bar, not displaced 26 bars ahead.',
    params: { tenkan: 9, kijun: 26, senkou: 52 }, sizing: {},
    paramSpecs: [
      { key: 'tenkan', label: 'Tenkan period', min: 2, max: 50, step: 1 },
      { key: 'kijun', label: 'Kijun period', min: 5, max: 100, step: 1 },
      { key: 'senkou', label: 'Senkou B period', min: 10, max: 200, step: 1 },
    ] },
  { id: 'dmi', source: 'Bot-DMI', name: 'DMI Trend (+DI / -DI)', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 5, unit: 'm' }, bias: 'trend',
    summary: 'The +DI line crosses the -DI line while ADX is at or above a minimum. Rise on a bullish cross, Fall on a bearish cross.',
    caution: 'The ADX filter keeps it out of flat markets, but a strong ADX can still reverse quickly.',
    params: { period: 14, adxMin: 20 }, sizing: {},
    paramSpecs: [
      { key: 'period', label: 'DMI period', min: 2, max: 50, step: 1 },
      { key: 'adxMin', label: 'ADX minimum', min: 5, max: 50, step: 1 },
    ] },
  { id: 'keltner', source: 'Bot-Keltner', name: 'Keltner Breakout', timeframe: 60, family: 'options', typeId: 'rise_fall', duration: { value: 5, unit: 'm' }, bias: 'trend',
    summary: 'EMA 20 with ATR(10) x 2 channels. Rise when a close breaks above the upper channel, Fall when it breaks below the lower channel.',
    caution: 'Channel breaks in low-volatility markets fail often. Read the edge test before you switch it on.',
    params: { emaPeriod: 20, atrPeriod: 10, multiplier: 2 }, sizing: {},
    paramSpecs: [
      { key: 'emaPeriod', label: 'Centre EMA', min: 5, max: 100, step: 1 },
      { key: 'atrPeriod', label: 'ATR period', min: 3, max: 50, step: 1 },
      { key: 'multiplier', label: 'ATR multiplier', min: 0.5, max: 5, step: 0.1 },
    ] },
];

export const STRATEGY_BY_ID = Object.freeze(Object.fromEntries(STRATEGIES.map((s) => [s.id, s])));

// Chart indicator catalogue. overlay = drawn on the price chart. pane = its own strip below the chart.
// Alligator, Ichimoku and Gator are drawn at the current bar, not displaced forward as in MetaTrader.
export const INDICATORS = Object.freeze([
  { id: 'sma', label: 'Moving Average (simple)', group: 'Trend', placement: 'overlay', params: { period: 20 } },
  { id: 'ema', label: 'Moving Average (exponential)', group: 'Trend', placement: 'overlay', params: { period: 9 } },
  { id: 'ichi', label: 'Ichimoku Kinko Hyo', group: 'Trend', placement: 'overlay', params: { tenkan: 9, kijun: 26, senkou: 52 } },
  { id: 'bb', label: 'Bollinger Bands', group: 'Volatility', placement: 'overlay', params: { period: 20, dev: 2 } },
  { id: 'env', label: 'Envelopes', group: 'Volatility', placement: 'overlay', params: { period: 14, pct: 0.1 } },
  { id: 'alligator', label: 'Alligator', group: 'Bill Williams', placement: 'overlay', params: {} },
  { id: 'fractals', label: 'Fractals', group: 'Bill Williams', placement: 'overlay', params: {} },
  { id: 'rsi', label: 'RSI', group: 'Oscillators', placement: 'pane', params: { period: 14 } },
  { id: 'macd', label: 'MACD', group: 'Oscillators', placement: 'pane', params: { fast: 12, slow: 26, signal: 9 } },
  { id: 'stoch', label: 'Stochastic', group: 'Oscillators', placement: 'pane', params: { k: 5, d: 3, slow: 3 } },
  { id: 'cci', label: 'CCI', group: 'Oscillators', placement: 'pane', params: { period: 20 } },
  { id: 'mom', label: 'Momentum', group: 'Oscillators', placement: 'pane', params: { period: 14 } },
  { id: 'demarker', label: 'DeMarker', group: 'Oscillators', placement: 'pane', params: { period: 14 } },
  { id: 'adx', label: 'ADX', group: 'Trend strength', placement: 'pane', params: { period: 14 } },
  { id: 'atr', label: 'ATR', group: 'Volatility', placement: 'pane', params: { period: 14 } },
  { id: 'bears_bulls', label: 'Bears / Bulls Power', group: 'Bill Williams', placement: 'pane', params: { period: 13 } },
  { id: 'ao', label: 'Awesome Oscillator', group: 'Bill Williams', placement: 'pane', params: {} },
  { id: 'ac', label: 'Accelerator Oscillator', group: 'Bill Williams', placement: 'pane', params: {} },
  { id: 'gator', label: 'Gator Oscillator', group: 'Bill Williams', placement: 'pane', params: {} },
]);

// Basket presets: Deriv basket indices (WLD + currency or metal code). Components are the forex and metal pairs found on Deriv.
export const BASKET_PRESETS = Object.freeze([
  { id: 'xau', label: 'Gold basket', symbol: 'WLDXAU', currency: 'XAU', hint: 'Gold against the currencies on Deriv. Gold pairs and metals vote.' },
  { id: 'aud', label: 'AUD basket', symbol: 'WLDAUD', currency: 'AUD', hint: 'Australian dollar pairs vote.' },
  { id: 'eur', label: 'EUR basket', symbol: 'WLDEUR', currency: 'EUR', hint: 'Euro pairs vote.' },
  { id: 'gbp', label: 'GBP basket', symbol: 'WLDGBP', currency: 'GBP', hint: 'Sterling pairs vote.' },
  { id: 'usd', label: 'USD basket', symbol: 'WLDUSD', currency: 'USD', hint: 'US dollar pairs vote.' },
]);

// Time, timing and limit constants.
export const TIMING = {
  requestTimeoutMs: 20000,
  pingEveryMs: 25000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  tickThrottleMs: 250,
  pendingPollMs: 1000,
  monitorEveryMs: 500,
  tokenValidateDebounceMs: 450,
  maxJournalEntries: 5000,
  maxWatchStreams: 30,
};

// Bus event names. Payloads are documented in DESIGN.md.
export const EVENTS = Object.freeze({
  DERIV_STATUS: 'deriv:status',       // {state: 'idle'|'validating'|'connecting'|'ok'|'reconnecting'|'error', message, step, detail}
  DIAG_STEP: 'diag:step',             // {step, ok: true|false|null, message, detail}
  ACCOUNT: 'account:update',          // {loginid, currency, isVirtual, accountId, balance, scopes}
  BALANCE: 'balance:update',          // {balance, currency}
  MARKETS: 'markets:update',          // {symbols: [...normalised]}
  TICK: 'tick',                       // {symbol, quote, epoch, pipSize}
  CANDLES: 'candles:update',          // {symbol, granularity, candles: [{epoch, open, high, low, close}]}
  CANDLE_LIVE: 'candle:live',         // {symbol, granularity, candle, isNew}
  POSITION_OPEN: 'position:opened',   // {position}
  POSITION_UPDATE: 'position:update', // {contractId, position}
  POSITION_CLOSED: 'position:closed', // {contractId, position, journalEntry}
  PENDING: 'pending:update',          // {orders}
  BOT_STATE: 'bot:state',             // {running, status: 'running'|'stopped', message, stats}
  BOT_LOG: 'bot:log',                 // {time, level, source, message}
  RISK_HALT: 'risk:halt',             // {reason}
  JOURNAL: 'journal:update',          // {}
  TRADE_ERROR: 'trade:error',         // {message, code, context}
  TOAST: 'toast',                     // {kind: 'info'|'ok'|'warn'|'error', message}
  STORE: 'store:change',              // {path, value}
  NAVIGATE: 'ui:navigate',            // {tab}
  OPEN_CONNECT: 'ui:open-connect',    // {}
  OPEN_BOT_POPUP: 'ui:open-bot-popup',// {}
  LOG: 'log',                         // {level, message}
  BRAIN_STATE: 'brain:state',         // {status, samples, accuracy, lo, hi, minSamples, threads, simsPerSec, simulated, markets, message}
  BRAIN_LESSON: 'brain:lesson',       // {time, market, strategy, kind: 'trade'|'backtest'|'model', text}
  BOT_ACTION: 'bot:action',           // {time, kind: 'tab'|'setting'|'trade'|'note', label, ok, message}
  BOT_CURSOR: 'bot:cursor',           // {phase: 'move'|'click'|'hide', label, x, y}
  ENGINE_MESSAGES: 'engine:messages', // {asset, tf, messages}
  CASE: 'case:built',                 // {case}
  VERDICT: 'verdict',                 // {verdict}
  FILL: 'fill',                       // {fill}: a paper order filled
  CLOSE: 'close',                     // {trade}: a paper position closed
  HEALTH: 'market:health',            // {asset, tf, status, ok, reason}
  PROPOSAL: 'learn:proposal',         // {proposal}: a learning proposal was made or changed
  APPROVAL: 'learn:approval',         // {proposalId, approved, actor}
  SESSION: 'session:state',           // the session.state() snapshot
});

// Switches that stay closed in this build. Nothing in the app may change them.
export const LOCKS = Object.freeze({ usableBalanceCapUsd: 5, liveGate: false, aiEnabled: false, demoGateway: false });

// The limit lines the app shows, in plain words. Show them exactly as written.
export const HONEST_LINES = Object.freeze([
  'Demo is the default. Real money stays locked until you approve it in writing.',
  'SimpleXEngine cannot promise profit. Results are shown after measured costs and labelled as past results.',
  'A win rate, an evidence score or a probability is an estimate from past data, shown with a range. It is not a chance of winning.',
  'Pending entries are held by the app, not by Deriv. They fire only while the page is open and the device is awake.',
  'The app runs in your browser on GitHub Pages and has no server. A static page cannot trade while every device is off or asleep. When the page is suspended, the app stops and opens no new trades.',
  'A stop set at purchase is applied by Deriv, as the multiplier pages describe. Moving a stop while the app is closed depends on Deriv supporting that change, which the Stage 1 probes will confirm.',
  'Learning data stays on this device. Clearing site data erases it. Export a backup to keep it.',
  'The bot may use at most $5 of balance. Anything higher needs an unlock that only the owner can make.',
  'If market data is stale or the connection drops, SimpleXEngine opens no new trades until the data is fresh again.',
  'Strategy code runs in a sandbox in your browser. The sandbox limits what code can reach. It is not a guarantee about code nobody has checked.',
  'Learning changes are proposals. They reach live settings only after approval.',
]);

// The open decisions from the architecture review. status: 'answered' | 'default' (no answer yet, the
// default applies) | 'requested' (asked for by Xel, waiting for the partner to confirm).
const decision = (id, title, value, status, note) => Object.freeze({ id, title, value, status, note });
export const DECISIONS = Object.freeze([
  decision('D1', 'Markets and timeframes', 'R_100 and frxXAUUSD on M1, M5, M15, H1, H4 and D1', 'default', 'The list already in the app. Needed before Stage 1.'),
  decision('D2', 'Connection and credentials', 'New API, personal access token and app id, token kept for the session only, demo gateway only', 'default', 'Needed before Stage 1. The token is never written to localStorage or a cookie.'),
  decision('D3', 'Products first', 'Multipliers', 'default', 'The only family with a stop loss and take profit set at purchase.'),
  decision('D4', 'Risk per trade', '1% of usable balance; reduced-risk mode halves it', 'default', 'Interacts with the $5 cap (D15).'),
  decision('D5', 'Account limits and daily reset', 'Daily loss stop 5%, drawdown stop 15%, 3 open, 5 pending, reset 00:00 UTC', 'default', ''),
  decision('D6', 'No-limit option on the daily loss stop', 'Manual trades only, behind a typed confirmation; the bot always has the stop', 'default', ''),
  decision('D7', 'News and event filter', 'Blackout windows entered by hand, no automatic calendar', 'default', ''),
  decision('D8', 'Minimum agreement before a trade', 'At least 3 of 4 families agree, cost-adjusted estimate passes its bound, no strong opposing reversal', 'default', ''),
  decision('D9', 'Daily target and reduced risk', 'No target until set; reduced risk is half risk, strong evidence only, one entry per hour', 'default', ''),
  decision('D10', 'Per-trade objective and trailing', 'Objective 2R net of costs; trailing from the objective, 1R behind the best price; stop never worse than entry risk', 'default', ''),
  decision('D11', 'Strategy sandbox', 'Web Worker with network and storage removed and a time limit; not a boundary against hostile code', 'default', ''),
  decision('D12', 'AI assistant', 'Off in the first build', 'default', 'Needs your provider and your own key.'),
  decision('D13', 'Learning changes', '100 closed demo trades, Wilson lower bound above break-even after costs, written approval logged', 'default', ''),
  decision('D14', 'Live trading gate', 'Locked; four weeks of demo review and written approval; half risk at first', 'default', ''),
  decision('D15', 'Usable balance cap', 'At most $5 of balance; a higher cap needs an owner-only strict unlock', 'requested', 'Requested by Xel. The bot and the learning loop can never unlock it.'),
  decision('D16', 'Hosting, storage and cookies', 'Static site on GitHub Pages, browser storage after consent, no cookies, one-file export and import', 'requested', 'Requested by Xel. The token is never stored in a cookie.'),
  decision('D17', 'Overnight operation', 'Runs only while the page is open and the device is awake; no new trades when suspended or offline', 'requested', 'Requested by Xel.'),
]);
