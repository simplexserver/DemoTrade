// Settings schema: every option in the app, in one list. The UI builds its forms from it, the store
// fills in defaults from it, and each engine reads its own group with cfgFor(prefix, values).
// Keys are dotted: 'sre.lookback' is stored at settings.sre.lookback. A row with locked: true cannot be
// changed in this build; its value is fixed by the lock reason shown in the UI. Pure: no DOM, no storage.

export const GROUPS = Object.freeze([
  { id: 'app', label: 'App and display', help: 'Look, number format, screen and notifications.' },
  { id: 'data', label: 'Market data', help: 'Where candles come from, which markets and timeframes, and data quality checks.' },
  { id: 'conn', label: 'Deriv connection', help: 'Public market data only. The account gateways are locked in this build.' },
  { id: 'paper', label: 'Paper account', help: 'Simulated money for testing. It is not your Deriv balance.' },
  { id: 'cost', label: 'Costs and fills', help: 'Spread, slippage and commission applied to every paper trade.' },
  { id: 'sre', label: 'Support and resistance (engine 3)', help: 'Levels where price has reacted before.' },
  { id: 'cde', label: 'Consolidation (engine 4)', help: 'Ranges of several sizes and durations, tracked at the same time.' },
  { id: 'pde', label: 'Premium and discount (engine 5)', help: 'Midpoint of each relevant range and where price sits inside it.' },
  { id: 'fvg', label: 'Fair value gap (engine 6)', help: 'Three-candle gaps that carry displacement.' },
  { id: 'obe', label: 'Order block (engine 7)', help: 'Zones found in their structure context, not by candle colour.' },
  { id: 'bsl', label: 'Buy-side liquidity (engine 8)', help: 'Estimated buy-stop clusters above price.' },
  { id: 'ssl', label: 'Sell-side liquidity (engine 9)', help: 'Estimated sell-stop clusters below price.' },
  { id: 'lse', label: 'Liquidity sweep (engine 10)', help: 'Sweeps followed by rejection, and breakouts that continue.' },
  { id: 'mse', label: 'Market structure (engine 11)', help: 'Swings, BOS, CHoCH and MSS on each timeframe.' },
  { id: 'bde', label: 'Breakout (engine 12)', help: 'Breakouts from ranges and levels, with a genuine-or-false verdict.' },
  { id: 'srd', label: 'Strong reversal (engine 13)', help: 'Weighted reversal evidence. The score ranks setups; it is not a probability.' },
  { id: 'qae', label: 'Quantitative analysis (engine 14)', help: 'ATR, volatility classes and the statistics used everywhere.' },
  { id: 'ble', label: 'Buy limit (engine 15)', help: 'Buy-limit proposals near support and discount areas.' },
  { id: 'sle', label: 'Sell limit (engine 16)', help: 'Sell-limit proposals near resistance and premium areas.' },
  { id: 'tdc', label: 'Trade coordinator (engine 17)', help: 'How many engine families must agree before a case is built.' },
  { id: 'risk', label: 'Risk management (engine 18)', help: 'Limits, sizing, news windows and the emergency stop. Learning cannot change these.' },
  { id: 'dpm', label: 'Dynamic profit management (engine 19)', help: 'Per-trade objective and trailing stop.' },
  { id: 'dpt', label: 'Daily profit target (engine 20)', help: 'Reduced-risk mode at the target. The bot never stops because of it and never adds trades.' },
  { id: 'll', label: 'Learning loop (engine 25)', help: 'How outcomes are recorded, what the model learns from, and the approval gate.' },
  { id: 'bt', label: 'Backtest (engine 23)', help: 'Out-of-sample and walk-forward splits, and an optional parameter grid.' },
  { id: 'sb', label: 'Strategy sandbox (engine 22)', help: 'Limits for user strategy code, which runs in a Web Worker.' },
  { id: 'hist', label: 'History download', help: 'Deep candle history from Deriv, kept on this device so the scanner and the learning loop have years to look at.' },
  { id: 'scan', label: 'Opportunity scanner', help: 'Looks through history for conditions that were followed by a profit after costs, and checks them on data it has not seen.' },
  { id: 'compute', label: 'Local computing', help: 'Lets the scanner use your processor in the background. Off until you turn it on. Nothing leaves this device.' },
  { id: 'ui', label: 'Screens', help: 'Chart and refresh options.' },
  { id: 'store', label: 'Storage', help: 'What is kept on this device. Needs the storage consent.' },
  { id: 'engine', label: 'Engine', help: 'Roles, which markets and timeframes may trade, and locked switches.' },
]);

const rows = [];
const row = (key, type, label, def, o = {}) => {
  rows.push({ key, group: key.split('.')[0], type, label, default: def, help: '', ...o });
};
const int = (key, label, def, min, max, step = 1, o = {}) => row(key, 'int', label, def, { min, max, step, ...o });
const num = (key, label, def, min, max, step = 0.01, o = {}) => row(key, 'num', label, def, { min, max, step, ...o });
const bool = (key, label, def, o = {}) => row(key, 'bool', label, def, o);
const sel = (key, label, def, options, o = {}) => row(key, 'sel', label, def, { options, ...o });
const text = (key, label, def, o = {}) => row(key, 'text', label, def, o);
const list = (key, label, def, item, o = {}) => row(key, 'list', label, def, { item, ...o });
const json = (key, label, def, o = {}) => row(key, 'json', label, def, o);

// ---------- app ----------
sel('app.mode', 'Mode', 'paper', [
  { value: 'paper', label: 'Paper (simulated)' }, { value: 'demo', label: 'Deriv demo (locked)' }, { value: 'live', label: 'Live (locked)' },
], { locked: true, lockReason: 'Only paper mode runs in this build. Demo and live need the written approvals in the architecture (D2, D14).', help: 'Every order in this build is simulated.' });
sel('app.theme', 'Colour theme', 'classic', [{ value: 'classic', label: 'Classic (green buy, red sell)' }, { value: 'alternative', label: 'Alternative (blue buy, red sell)' }]);
int('app.fontScale', 'Text size (%)', 100, 85, 130, 5);
sel('app.numberStyle', 'Number style', 'smart', [{ value: 'smart', label: 'Smart (K/M above threshold)' }, { value: 'full', label: 'Full amounts' }, { value: 'compact', label: 'Compact (K/M)' }]);
int('app.fullDecimals', 'Decimals for money', 2, 0, 2);
int('app.compactDecimals', 'Decimals for K/M amounts', 1, 0, 2);
num('app.smartThreshold', 'Smart style switches to K/M at', 10000, 0, 1e9, 1000);
sel('app.decimalSep', 'Decimal separator', '.', [{ value: '.', label: 'Point (1.5)' }, { value: ',', label: 'Comma (1,5)' }]);
sel('app.thousandsSep', 'Thousands separator', ',', [{ value: ',', label: 'Comma (1,000)' }, { value: '.', label: 'Point (1.000)' }, { value: ' ', label: 'Space (1 000)' }, { value: '', label: 'None' }]);
bool('app.showCurrency', 'Show currency symbol', true);
bool('app.wakeLock', 'Keep the screen awake while running', true, { help: 'Uses the browser wake lock where it is supported. A suspended page stops the bot (D17).' });
bool('app.notify', 'Browser notifications for fills and closes', false, { help: 'Asks the browser for permission the first time it is turned on.' });
int('app.autosaveSec', 'Save to this device every (seconds)', 30, 5, 300, 5);
sel('app.logLevel', 'Log level', 'info', [{ value: 'error', label: 'Errors' }, { value: 'warn', label: 'Warnings' }, { value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]);

// ---------- data ----------
sel('data.source', 'Candle source', 'sim', [
  { value: 'sim', label: 'Simulated market (seeded, repeatable)' },
  { value: 'replay', label: 'Imported candles (CSV or JSON file)' },
  { value: 'deriv', label: 'Deriv public feed (untested here)' },
], { help: 'Simulated is the default. The Deriv feed needs a browser that can reach Deriv; the architecture lists that as Probe 4.' });
list('data.assets', 'Markets', ['R_100', 'frxXAUUSD'], 'text', { help: 'Default: R_100 and frxXAUUSD (decision D1).' });
list('data.timeframes', 'Timeframes (seconds)', [60, 300, 900, 3600, 14400, 86400], 'number', { help: 'Default M1, M5, M15, H1, H4 and D1 (D1). 60 = M1, 300 = M5, 900 = M15, 3600 = H1, 14400 = H4, 86400 = D1.' });
int('data.historyBars', 'Bars requested per timeframe (Deriv feed)', 500, 100, 5000, 50);
int('data.maxBars', 'Bars kept in memory per market and timeframe', 5000, 200, 50000, 100);
num('data.staleFactor', 'Stale after (x timeframe length)', 2, 1, 10, 0.5, { help: 'No new candle for this many timeframe lengths means the data is stale and no new trade opens.' });
int('data.gapTolerance', 'Missing candles tolerated in the window', 0, 0, 50);
int('data.gapWindowBars', 'Gap window (bars)', 50, 5, 500);
int('data.simSeed', 'Simulation seed', 20260105, 1, 999999999, 1, { help: 'The same seed and settings give the same market, every time.' });
text('data.simStart', 'Simulation start (UTC, ISO)', '2026-01-05T00:00:00Z');
json('data.simStarts', 'Simulation start prices by market', { R_100: 1000, frxXAUUSD: 2000 }, { help: 'JSON object of market to starting price.' });
num('data.simVolPct', 'Simulation volatility (% per minute)', 0.04, 0.005, 0.5, 0.005);
int('data.simRegimeBars', 'Simulation regime length (bars)', 240, 20, 2000, 10);
num('data.simSpikeChance', 'Simulation sweep chance per bar', 0.02, 0, 0.2, 0.005, { help: 'Chance per bar of a wick that pierces a level and reverses.' });
sel('data.simKind', 'Simulated market type', 'regimes', [{ value: 'regimes', label: 'With structure (trends, ranges, sweeps)' }, { value: 'random_walk', label: 'Random walk (no structure: the honest control)' }], { help: 'The first has patterns built in, so the engines have something to find. The second has none: every price change is independent of the past, like Deriv synthetic indices are designed to be. Nothing should make money on it.' });
int('data.simOutageEvery', 'Simulated outage every N bars (0 = never)', 0, 0, 10000, 1, { help: 'Test switch: a three-bar gap every N bars, to exercise the stale and gap checks.' });
sel('data.simSpeed', 'Simulation speed', '60', [
  { value: '1', label: '1 bar per second' }, { value: '10', label: '10 bars per second' },
  { value: '60', label: '60 bars per second' }, { value: '600', label: '600 bars per second' }, { value: 'max', label: 'As fast as possible' },
]);

// ---------- conn ----------
sel('conn.mode', 'Deriv endpoint', 'new', [
  { value: 'new', label: 'New API (api.derivws.com)' }, { value: 'legacy', label: 'Legacy API (ws.derivws.com)' },
], { help: 'Public market data only. Used only when the data source is the Deriv feed.' });
text('conn.legacyAppId', 'Legacy app id (public feed)', '1089');
int('conn.pingSec', 'Keep-alive ping (seconds)', 25, 10, 60);
int('conn.reconnectMaxSec', 'Longest wait between reconnects (seconds)', 30, 5, 120);
bool('conn.realGateway', 'Real-money gateway', false, { locked: true, lockReason: 'Locked. The real gateway stays closed until the live gate (D14) and your written approval.' });
bool('conn.demoGateway', 'Deriv demo account gateway', false, { locked: true, lockReason: 'Locked in this build: the balance is not connected, so no account is used.' });

// ---------- paper ----------
num('paper.startBalance', 'Starting paper balance (USD)', 1000, 10, 1000000, 10, { help: 'Simulated only. The usable amount is capped at the usable-balance cap below.' });
bool('paper.resetOnStart', 'Reset paper account when the app starts', false);
sel('paper.currency', 'Paper currency', 'USD', [{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'GBP', label: 'GBP' }, { value: 'AUD', label: 'AUD' }]);

// ---------- cost ----------
num('cost.spreadPrice', 'Spread (price units, half each side)', 0.02, 0, 10, 0.001);
num('cost.slippagePrice', 'Slippage on market fills (price units)', 0, 0, 10, 0.001, { help: 'Adverse move applied to market fills. Limit fills take no slippage.' });
num('cost.commissionPct', 'Commission (% of stake, each side)', 0, 0, 1, 0.01, { help: 'Deriv does not state the rate on the pages checked. Measured on demo (Probe 10).' });
sel('cost.gapFillMode', 'Fill a gap through a stop at', 'open', [{ value: 'open', label: 'The open of the gap bar' }, { value: 'stop', label: 'The stop price' }]);

// ---------- sre ----------
int('sre.lookback', 'Lookback (bars)', 300, 150, 1000, 10);
int('sre.wing', 'Swing wing (bars each side)', 3, 2, 10);
num('sre.tolAtr', 'Cluster tolerance (x ATR)', 0.2, 0.05, 1, 0.01);
num('sre.zoneAtr', 'Zone half-width (x ATR)', 0.15, 0, 1, 0.01);
int('sre.minReactions', 'Minimum reactions for a level', 2, 1, 10);
num('sre.breakAtr', 'Break needs a close beyond (x ATR)', 0.1, 0, 1, 0.01);
int('sre.maxAgeBars', 'Forget levels older than (bars)', 800, 50, 5000, 10);
num('sre.majorAtr', 'Major swing amplitude (x ATR)', 3, 1, 10, 0.1);
int('sre.maxLevels', 'Most levels kept per market and timeframe', 12, 1, 50);
int('sre.atrPeriod', 'ATR period', 14, 5, 50);

// ---------- cde ----------
int('cde.lookback', 'Lookback (bars)', 600, 200, 2000, 10);
int('cde.atrPeriod', 'ATR period', 14, 5, 50);
int('cde.smallBars', 'Small range window (bars)', 12, 6, 30);
int('cde.mediumBars', 'Medium range window (bars)', 30, 20, 60);
int('cde.largeBars', 'Large range window (bars)', 80, 50, 150);
int('cde.longBars', 'Long range window (bars)', 200, 120, 400);
num('cde.smallMaxAtr', 'Small: range at most (x ATR)', 3, 1, 10, 0.1);
num('cde.mediumMaxAtr', 'Medium: range at most (x ATR)', 5, 2, 15, 0.1);
num('cde.largeMaxAtr', 'Large: range at most (x ATR)', 8, 3, 25, 0.1);
num('cde.longMaxAtr', 'Long: range at most (x ATR)', 12, 4, 40, 0.1);
int('cde.minReactions', 'Boundary reactions required (0 = none)', 1, 0, 10);
int('cde.maxPerSize', 'Ranges kept per size', 3, 1, 10);
int('cde.graceBars', 'Bars a range stays active after its last window', 2, 0, 20);
num('cde.breakBufferAtr', 'Break buffer (x ATR)', 0.1, 0, 1, 0.01);

// ---------- pde ----------
bool('pde.includeCde', 'Use consolidation ranges', true);
bool('pde.includeSr', 'Use support and resistance pairs', true);
num('pde.minRangeAtr', 'Ignore ranges smaller than (x ATR)', 1, 0, 20, 0.1);
num('pde.equilibriumBand', 'Equilibrium band around 50%', 0.02, 0, 0.2, 0.005, { help: 'Positions within this distance of the midpoint are called equilibrium.' });
int('pde.atrPeriod', 'ATR period', 14, 5, 50);

// ---------- fvg ----------
int('fvg.lookback', 'Lookback (bars)', 200, 20, 1000, 10);
int('fvg.atrPeriod', 'ATR period', 14, 5, 50);
num('fvg.minGapAtr', 'Smallest gap (x ATR)', 0.1, 0, 2, 0.01);
num('fvg.dispAtr', 'Displacement body (x ATR)', 1, 0.2, 5, 0.05);
num('fvg.bodyRatio', 'Displacement body share of range', 0.5, 0, 1, 0.01);
int('fvg.maxAgeBars', 'Forget gaps older than (bars)', 300, 10, 2000, 10);
bool('fvg.requireDisplacement', 'Require displacement', true, { help: 'A gap alone is not a trade (architecture section 8).' });

// ---------- obe ----------
int('obe.lookback', 'Lookback (bars)', 200, 30, 1000, 10);
int('obe.atrPeriod', 'ATR period', 14, 5, 50);
num('obe.dispAtr', 'Impulse body (x ATR)', 1.5, 0.5, 5, 0.05);
int('obe.bosWindow', 'Break-of-structure window (bars)', 30, 5, 100);
int('obe.searchBars', 'Bars searched back for the zone candle', 5, 1, 10);
bool('obe.useBody', 'Zone uses the candle body (not the wick)', false);
int('obe.maxAgeBars', 'Forget zones older than (bars)', 300, 10, 2000, 10);
bool('obe.requireStructure', 'Require break of structure', true);

// ---------- bsl / ssl ----------
for (const [p, side, word] of [['bsl', 'buy', 'above'], ['ssl', 'sell', 'below']]) {
  const label = side === 'buy' ? 'Buy-side' : 'Sell-side';
  int(`${p}.lookback`, `${label}: lookback (bars)`, 200, 30, 1000, 10);
  int(`${p}.atrPeriod`, `${label}: ATR period`, 14, 5, 50);
  num(`${p}.eqTolAtr`, `${label}: equal-level tolerance (x ATR)`, 0.1, 0, 1, 0.01);
  int(`${p}.minTouches`, `${label}: touches for equal levels`, 2, 2, 6);
  bool(`${p}.useLevels`, `${label}: include resistance or support levels`, true);
  int(`${p}.prevBars`, `${label}: previous high or low window (bars)`, 24, 5, 500);
  num(`${p}.maxDistAtr`, `${label}: ignore levels further than (x ATR ${word} price)`, 15, 1, 50, 0.5);
}

// ---------- lse ----------
int('lse.lookback', 'Lookback (bars)', 30, 5, 200);
int('lse.minLiquidityRank', 'Weakest liquidity level that can be swept (evidence 0-100)', 40, 0, 100, 1, { learnable: true, help: 'Levels with less evidence than this (for example a lone swing high) are ignored, so a sweep means something.' });
int('lse.atrPeriod', 'ATR period', 14, 5, 50);
num('lse.pierceAtr', 'Pierce needed beyond the level (x ATR)', 0.05, 0, 2, 0.01);
int('lse.confirmBars', 'Bars to confirm a rejection or a continuation', 3, 1, 10);
int('lse.reclaimBars', 'Bars allowed for a reclaim', 5, 1, 20);

// ---------- mse ----------
int('mse.wing', 'Swing wing (bars each side)', 2, 1, 10);
int('mse.lookback', 'Lookback (bars)', 300, 50, 1000, 10);
int('mse.atrPeriod', 'ATR period', 14, 5, 50);
num('mse.dispAtr', 'MSS displacement (x ATR)', 1.2, 0.5, 5, 0.05);
bool('mse.closeBeyond', 'Break needs a close beyond the swing', true);

// ---------- bde ----------
int('bde.atrPeriod', 'ATR period', 14, 5, 50);
int('bde.lookback', 'Lookback for breakouts (bars)', 30, 5, 200);
num('bde.breakAtr', 'Break needs a close beyond (x ATR)', 0.2, 0.05, 1, 0.01);
int('bde.followBars', 'Follow-through window (bars)', 5, 1, 20);
num('bde.followAtr', 'Follow-through needed (x ATR)', 1, 0.1, 5, 0.05);
int('bde.failBars', 'Bars back inside that mark a false break', 3, 1, 20);
int('bde.retestBars', 'Retest window (bars)', 10, 1, 50);

// ---------- srd ----------
int('srd.lookback', 'Lookback (bars)', 30, 5, 100);
int('srd.wSweep', 'Weight: liquidity sweep', 20, 0, 50);
int('srd.wReclaim', 'Weight: reclaim of a level', 10, 0, 50);
int('srd.wMss', 'Weight: market structure shift', 20, 0, 50);
int('srd.wBos', 'Weight: break of structure', 10, 0, 50);
int('srd.wDisp', 'Weight: displacement', 10, 0, 50);
int('srd.wFvg', 'Weight: fair value gap in direction', 10, 0, 50);
int('srd.wOb', 'Weight: order block in direction', 5, 0, 50);
int('srd.wLevel', 'Weight: support or resistance reclaimed', 10, 0, 50);
int('srd.wMomentum', 'Weight: momentum turning', 5, 0, 50);
int('srd.wHtf', 'Weight: higher timeframe agrees', 10, 0, 50);
int('srd.wFailed', 'Weight: failed continuation', 5, 0, 50);
num('srd.weakBelow', 'Weak below (score)', 40, 0, 100, 1);
num('srd.strongFrom', 'Strong from (score)', 70, 0, 100, 1);
int('srd.minCategories', 'Categories needed for strong', 3, 1, 6);
num('srd.pullbackRatio', 'Pullback: retrace below (share of impulse)', 0.5, 0.1, 1, 0.05);
int('srd.atrPeriod', 'ATR period', 14, 5, 50);
int('srd.rsiPeriod', 'RSI period (momentum)', 14, 2, 50);
num('srd.dispAtr', 'Displacement body (x ATR)', 1.2, 0.5, 5, 0.05);
int('srd.htfFactor', 'Higher timeframe multiple (x this timeframe)', 4, 2, 20);

// ---------- qae ----------
int('qae.atrPeriod', 'ATR period', 14, 5, 50);
int('qae.volLookback', 'Volatility lookback (bars)', 200, 50, 1000, 10);
num('qae.lowVolPct', 'Low volatility below (percentile)', 33, 0, 50, 1);
num('qae.highVolPct', 'High volatility above (percentile)', 67, 50, 100, 1);
num('qae.z', 'Confidence z (1.645 = 90%, 1.96 = 95%, 2.576 = 99%)', 1.96, 1.5, 3, 0.001);

// ---------- ble / sle (proposals) ----------
for (const [p, side, zoneWord] of [['ble', 'buy', 'support'], ['sle', 'sell', 'resistance']]) {
  const label = side === 'buy' ? 'Buy limit' : 'Sell limit';
  int(`${p}.atrPeriod`, `${label}: ATR period`, 14, 5, 50);
  num(`${p}.rr`, `${label}: profit objective (x risk)`, 2, 0.5, 10, 0.1, { learnable: true, help: 'Initial objective as a multiple of the risk to the stop (D10: 2).' });
  num(`${p}.minRR`, `${label}: minimum reward to risk`, 1.5, 0.5, 5, 0.1);
  num(`${p}.stopAtr`, `${label}: stop beyond the ${zoneWord} zone (x ATR)`, 0.5, 0.1, 5, 0.05, { learnable: true });
  num(`${p}.minStopAtr`, `${label}: smallest stop (x ATR)`, 0.3, 0.1, 3, 0.05);
  num(`${p}.maxStopAtr`, `${label}: widest stop (x ATR)`, 3, 0.5, 10, 0.1, { learnable: true, help: 'A filter: proposals with a wider stop are dropped. The learning loop may suggest a tighter value.' });
  num(`${p}.zoneNearAtr`, `${label}: distance to the ${zoneWord} zone (x ATR)`, 1, 0, 5, 0.1, { learnable: true });
  num(`${p}.zoneSideLimit`, `${label}: ${side === 'buy' ? 'discount' : 'premium'} position limit (0-1)`, 0.5, 0, 1, 0.01);
  int(`${p}.maxProposals`, `${label}: most proposals per bar`, 10, 1, 50);
  int(`${p}.expiryBars`, `${label}: pending entry expires after (bars)`, 24, 1, 500);
  int(`${p}.sweepWithinBars`, `${label}: a sweep counts if it happened within (bars)`, 15, 1, 500, 1, { learnable: true, help: 'An old sweep is not evidence for a trade now. Older than this and the sweep check fails.' });
  int(`${p}.structureWithinBars`, `${label}: a structure break counts if it happened within (bars)`, 30, 1, 500, 1, { learnable: true, help: 'The trend direction always counts. A break of structure counts only while it is recent.' });
  bool(`${p}.requireSweep`, `${label}: require a liquidity sweep`, false);
  bool(`${p}.requireStructure`, `${label}: require supporting structure`, false, { help: 'Off by default so structure stays one of the four families the coordinator counts. Turn it on to make it a hard requirement.' });
  bool(`${p}.requireFvgOb`, `${label}: require a matching FVG or order block`, false);
}

// ---------- tdc ----------
int('tdc.minFamilies', 'Families that must agree (of 4)', 3, 1, 4, 1, { learnable: true, help: 'D8 default: three of four families (levels, structure, liquidity or sweep, zones).' });
sel('tdc.edgeMode', 'Edge check before a case', 'collect', [
  { value: 'collect', label: 'Collect data (paper only, no edge check)' },
  { value: 'strict', label: 'Strict (needs the cost-adjusted lower bound above break-even)' },
], { help: 'Strict is the D8 rule. Collect lets paper trades run before there is enough history, so the learning loop can gather outcomes. Paper only.' });
int('tdc.minSamples', 'Closed trades before the strict check can pass', 100, 10, 1000, 10, { help: 'D13 default: 100 closed demo trades on the setup.' });
int('tdc.minEvidence', 'Lowest evidence score to build a case', 40, 0, 100, 1, { learnable: true });
int('tdc.maxPerBar', 'Most cases built per bar', 2, 1, 20, 1, { learnable: true, help: 'When several proposals pass on one bar, only the best ranked are built. The rest are dropped with the reason shown.' });
bool('tdc.blockOpposingStrong', 'A strong opposing reversal blocks the case', true, { learnable: true });

// ---------- risk ----------
num('risk.riskPct', 'Risk per trade (% of usable balance)', 1, 0.05, 5, 0.05, { help: 'D4 default: 1%. The stake is set so a stop-out loses this amount.' });
num('risk.dailyLossPct', 'Daily loss stop (% of the day\'s starting usable balance)', 5, 1, 20, 0.5, { help: 'D5 default: 5%. Halts new entries until the UTC reset.' });
num('risk.drawdownPct', 'Drawdown stop (% from peak balance)', 15, 5, 50, 0.5, { help: 'D5 default: 15%. Halts new entries until you reset it.' });
int('risk.maxOpen', 'Most open positions', 3, 1, 10, 1, { help: 'D5 default: 3.' });
int('risk.maxPending', 'Most pending entries', 5, 1, 20, 1, { help: 'D5 default: 5.' });
int('risk.cooldownBars', 'Bars before the same setup may re-enter', 3, 0, 200, 1, { help: 'After a trade closes, the same setup (same market, side and entry area) waits this many bars.' });
num('risk.usableCapUsd', 'Usable balance cap (USD)', 5, 5, 5, 1, { locked: true, lockReason: 'D15: the bot may use at most $5. Raising it needs a strict unlock that only the owner can take. Not available in this build.' });
num('risk.minStakeUsd', 'Minimum stake (USD)', 0.35, 0.01, 10, 0.01, { help: 'Assumed from the earlier build. The Deriv pages checked do not state it; Probe 6 reads it. A trade below this is refused, never rounded up.' });
num('risk.maxStakeUsd', 'Maximum stake (USD)', 2000, 1, 50000, 1, { help: 'Not stated by Deriv on the pages checked. A stake above this is capped down, which only lowers the risk.' });
num('risk.maxSpreadAtr', 'Refuse when spread exceeds (x ATR)', 0.2, 0, 1, 0.01);
num('risk.maxSlippageAtr', 'Refuse a fill that slips more than (x ATR)', 0.1, 0, 1, 0.01);
num('risk.reducedFactor', 'Reduced-risk mode: risk multiplied by', 0.5, 0.1, 1, 0.05, { help: 'D9 default: half the risk.' });
int('risk.reducedMaxPerHour', 'Reduced-risk mode: new entries per hour', 1, 1, 10, 1, { help: 'D9 default: one new entry per hour.' });
int('risk.reducedMinEvidence', 'Reduced-risk mode: evidence score needed', 70, 0, 100, 1, { help: 'D9 default: only strong evidence may enter.' });
int('risk.newsBefore', 'News blackout: minutes before an event', 10, 0, 120, 1);
int('risk.newsAfter', 'News blackout: minutes after an event', 10, 0, 120, 1);
json('risk.newsEvents', 'News events (JSON list of {at, title})', [], { help: 'Entered by hand (D7). No automatic calendar yet.' });
bool('risk.noLimitDailyStop', 'Turn off the daily loss stop for manual trades', false, { confirm: 'NO LIMIT', help: 'D6: manual trades only, behind a typed confirmation. The bot always keeps the stop.' });
bool('risk.demoGateway', 'Enable Deriv demo (virtual) account connection', true, { help: 'Default on. Allows connecting a Deriv VIRTUAL (VR) token for demo trading with real prices and fake money.' });
num('risk.multiplier', 'Multiplier for sizing', 100, 1, 2000, 1, { help: 'Deriv offers fixed multipliers per market; the allowed list is read from quotes (Probe 6).' });
json('risk.multiplierOverrides', 'Multiplier by market (JSON)', {}, { help: 'Example: {"frxXAUUSD": 100}. Empty uses the default above.' });

// ---------- dpm ----------
bool('dpm.enabled', 'Trailing profit protection on', true);
num('dpm.objectiveR', 'Initial profit objective (x initial risk)', 2, 1, 10, 0.1, { learnable: true, help: 'D10 default: 2 times the initial risk, net of measured costs. Reaching it does not close the trade.' });
num('dpm.trailR', 'Trailing distance (x initial risk)', 1, 0.2, 5, 0.1, { learnable: true, help: 'D10 default: 1 times the initial risk behind the best price.' });
int('dpm.maxHoldBars', 'Close a trade after (bars, 0 = no limit)', 0, 0, 10000);
bool('dpm.stopNeverWorse', 'The stop never sits worse than the entry risk', true, { locked: true, lockReason: 'Fixed rule from the architecture (section 16). It cannot be turned off.' });

// ---------- dpt ----------
num('dpt.targetUsd', 'Daily profit target (USD, 0 = none)', 0, 0, 100000, 1, { help: 'D9 default: no target until you set one.' });
bool('dpt.reducedOnTarget', 'Switch to reduced-risk mode at the target', true, { help: 'The bot never stops and never adds trades because of the target.' });
bool('dpt.includeFloating', 'Count open profit and loss toward the target', true);
int('dpt.resetUtcHour', 'Daily reset hour (UTC)', 0, 0, 23, 1, { help: 'D5 default: 00:00 UTC.' });

// ---------- ll (learning) ----------
bool('ll.enabled', 'Learning loop on', true, { help: 'It learns from outcomes on this device. It never changes live settings without written approval.' });
bool('ll.autoPropose', 'Propose changes automatically', true, { help: 'A proposal is only a proposal. Approval is always a separate, logged step.' });
int('ll.minClosed', 'Closed paper trades before a proposal (minimum 100)', 100, 100, 100000, 10, { help: 'D13: 100 closed demo trades on the setup. The app will not go below 100.' });
sel('ll.labelMode', 'What counts as a win', 'net_win', [
  { value: 'net_win', label: 'Net profit after costs is above zero' },
  { value: 'target_hit', label: 'The objective was reached before the stop' },
  { value: 'r_multiple', label: 'Net result is at least a set number of R' },
]);
num('ll.labelR', 'R needed for a win (when set to R)', 1, 0, 5, 0.1);
sel('ll.breakEven', 'Break-even method', 'measured', [
  { value: 'measured', label: 'Measured from the trades after costs' },
  { value: 'payout', label: 'From the payout ratio of the setup' },
]);
num('ll.z', 'Wilson confidence z for the gate', 1.96, 1.5, 3, 0.001, { help: '1.96 = the 95% lower bound in D13.' });
sel('ll.model', 'Model', 'blend', [
  { value: 'logistic', label: 'Logistic regression (gradient descent)' },
  { value: 'bucket', label: 'Bucket calibration (Wilson, interpretable)' },
  { value: 'blend', label: 'Blend of both' },
]);
num('ll.lr', 'Learning rate', 0.05, 0.0001, 1, 0.0001);
int('ll.epochs', 'Training passes (epochs)', 80, 1, 1000, 1);
int('ll.batch', 'Mini-batch size', 16, 1, 512, 1);
num('ll.l2', 'L2 regularisation', 0.01, 0, 10, 0.001);
sel('ll.classWeight', 'Class weighting', 'balanced', [{ value: 'none', label: 'None' }, { value: 'balanced', label: 'Balanced' }]);
sel('ll.standardize', 'Feature scaling', 'zscore', [{ value: 'zscore', label: 'Z-score (fit on training data)' }, { value: 'minmax', label: 'Min-max (fit on training data)' }, { value: 'none', label: 'None' }]);
num('ll.valSplit', 'Validation share (chronological)', 0.15, 0.05, 0.4, 0.01);
num('ll.testSplit', 'Test share (chronological, never used to train)', 0.15, 0.05, 0.4, 0.01);
int('ll.patience', 'Early stopping patience (epochs, 0 = off)', 10, 0, 100, 1);
int('ll.seed', 'Random seed', 42, 1, 999999, 1);
int('ll.decayHalfLife', 'Forget old trades (half-life in trades, 0 = off)', 0, 0, 100000, 10);
int('ll.bins', 'Bucket calibration: bins per feature', 5, 2, 20, 1);
num('ll.priorStrength', 'Bucket calibration: prior strength (pseudo-trades)', 10, 0, 100, 1);
num('ll.blendWeight', 'Blend: weight on the logistic model', 0.5, 0, 1, 0.05);
num('ll.threshold', 'Decision threshold (probability)', 0.5, 0, 1, 0.01, { learnable: true, help: 'With the approved model switched on, a case is refused when its predicted win probability is below this.' });
bool('ll.modelActive', 'Use the approved model to filter new cases', false, { learnable: true, help: 'Does nothing until a model proposal has been approved. Cases the model scores below the threshold are refused, with the reason shown.' });
bool('ll.thresholdSearch', 'Search the threshold on validation data', false);
int('ll.wfWindow', 'Walk-forward training window (trades)', 200, 50, 100000, 10);
int('ll.wfStep', 'Walk-forward step (trades)', 50, 10, 100000, 10);
int('ll.purge', 'Purge gap between train and test (trades)', 2, 0, 500, 1);
bool('ll.requireOos', 'Gate needs a passing out-of-sample test', true);
bool('ll.requireBrier', 'Gate needs the Brier score to beat the base rate', true);
int('ll.minOosTrades', 'Gate needs this many out-of-sample trades', 30, 10, 10000, 1);
bool('ll.shadow', 'Label rejected cases by replaying them forward', false, { help: 'Adds counterfactual labels for learning only. They do not count toward the 100 closed trades.' });
int('ll.shadowHorizon', 'Shadow replay horizon (bars)', 24, 1, 500, 1);
int('ll.maxRecords', 'Most learning records kept', 20000, 100, 500000, 100);
bool('ll.feat.families', 'Feature: engine families agreeing', true);
bool('ll.feat.evidence', 'Feature: evidence score', true);
bool('ll.feat.sweep', 'Feature: liquidity sweep present', true);
bool('ll.feat.fvgOb', 'Feature: FVG or order block present', true);
bool('ll.feat.structure', 'Feature: structure agrees', true);
bool('ll.feat.volatility', 'Feature: volatility class and ATR percentile', true);
bool('ll.feat.time', 'Feature: hour of day (UTC)', true);
bool('ll.feat.streak', 'Feature: recent win or loss streak', true);
bool('ll.feat.rr', 'Feature: reward to risk and stop size', true);
bool('ll.feat.zones', 'Feature: premium and discount position', true);
bool('ll.feat.htf', 'Feature: higher timeframe agrees', true);
bool('ll.feat.breakout', 'Feature: breakout present', true);

// ---------- bt ----------
num('bt.oosFraction', 'Out-of-sample share of history (last part)', 0.3, 0.1, 0.5, 0.01, { help: 'This part is never used to choose parameters.' });
int('bt.wfTrain', 'Walk-forward train window (bars)', 500, 100, 100000, 10);
int('bt.wfTest', 'Walk-forward test window (bars)', 150, 50, 50000, 10);
int('bt.wfStep', 'Walk-forward step (bars)', 150, 50, 50000, 10);
bool('bt.grid', 'Search a small parameter grid on training data', false);
list('bt.gridMinFamilies', 'Grid: families needed (values)', [2, 3, 4], 'number');
list('bt.gridRR', 'Grid: reward to risk (values)', [1.5, 2, 3], 'number');
int('bt.maxBars', 'Most bars per backtest', 10000, 500, 200000, 500);

// ---------- sb (sandbox) ----------
int('sb.timeoutMs', 'Time limit per strategy run (ms)', 3000, 200, 20000, 100);
int('sb.maxSignals', 'Most signals a strategy may return', 5000, 10, 100000, 10);
int('sb.maxCodeChars', 'Most characters of strategy code', 20000, 1000, 200000, 500);

// ---------- hist, scan, compute ----------
bool('hist.autoLoad', 'Download deep history after connecting to Deriv', true, { help: 'Only public candle data is requested. It runs in the background and can be stopped.' });
int('hist.targetBars', 'Candles to collect per market and timeframe', 50000, 1000, 500000, 1000, { help: 'Deriv sends at most 5,000 per request, so 50,000 is ten requests. How far back that reaches depends on the timeframe.' });
list('hist.timeframes', 'Timeframes to download (seconds)', [300, 900, 3600], 'number', { help: '60, 300, 900, 3600, 14400 or 86400.' });
int('hist.pageDelayMs', 'Pause between requests (ms)', 250, 0, 5000, 50, { help: 'Keeps the download polite so Deriv does not rate-limit it.' });
bool('hist.cache', 'Keep downloaded history on this device', true, { help: 'Needs the storage consent. If you refuse it, the history lives in memory until you close the page.' });

num('scan.stopAtr', 'Scanner: stop distance (x ATR)', 1.5, 0.5, 5, 0.1);
num('scan.rr', 'Scanner: target (x the stop)', 2, 0.5, 6, 0.1);
int('scan.horizon', 'Scanner: longest a trade may last (bars)', 24, 4, 200, 1);
num('scan.trainFrac', 'Scanner: share of history used to find candidates', 0.5, 0.3, 0.7, 0.05);
num('scan.valFrac', 'Scanner: share used to confirm them', 0.25, 0.1, 0.4, 0.05, { help: 'What is left over is the untouched test part.' });
int('scan.minTrain', 'Scanner: fewest training trades a condition needs', 40, 20, 500, 5);
int('scan.minVal', 'Scanner: fewest confirmation trades', 15, 5, 200, 1);
int('scan.minTest', 'Scanner: fewest test trades', 15, 5, 200, 1);
num('scan.q', 'Scanner: false-discovery rate', 0.1, 0.01, 0.25, 0.01, { help: 'Lower is stricter. The more conditions are tried, the harder each one must work to pass.' });
int('scan.depth', 'Scanner: most features in one condition (0 = automatic)', 0, 0, 3, 1, { help: 'Automatic grows with the amount of history: 1 for a short one, 2 for a medium one, 3 for a long one.' });
int('scan.maxConditions', 'Scanner: most conditions to try', 30000, 1000, 100000, 1000);
sel('scan.use', 'What to do with the conditions that survive', 'radar', [
  { value: 'off', label: 'Nothing' }, { value: 'radar', label: 'Show them on the radar when they match' }, { value: 'paper', label: 'Radar, and trade them on paper' },
], { help: 'Paper trades go through the same risk checks and cost model as every other trade. They are simulated.' });
int('scan.maxRules', 'Most scanner rules traded on paper at once', 3, 1, 10, 1);
num('scan.everyHours', 'Scan again every (hours, 0 = only when asked)', 0, 0, 168, 1);

bool('compute.enabled', 'Use this device\'s processor for scans', false, { help: 'Runs scans in background workers. It makes the device warmer and the fan louder while it runs. Off by default.' });
int('compute.threads', 'Workers to use (0 = automatic)', 0, 0, 8, 1, { help: 'Automatic leaves one core free for the page.' });
bool('compute.probeGpu', 'Check whether a graphics card is available', false, { help: 'Information only. The models here are small and run faster on the processor, so the card is not used.' });

// ---------- ui ----------
sel('ui.defaultTab', 'Open this screen first', 'overview', [
  { value: 'overview', label: 'Overview' }, { value: 'markets', label: 'Markets' }, { value: 'chart', label: 'Chart' },
  { value: 'engines', label: 'Engines' }, { value: 'decisions', label: 'Decisions' }, { value: 'trading', label: 'Trading' },
  { value: 'performance', label: 'Performance' }, { value: 'learning', label: 'Learning' }, { value: 'lab', label: 'Strategy lab' },
  { value: 'risk', label: 'Risk' }, { value: 'settings', label: 'Settings' }, { value: 'about', label: 'About and log' },
]);
int('ui.chartCandles', 'Candles shown on the chart', 300, 50, 2000, 10);
bool('ui.chartLevels', 'Chart: draw levels and ranges', true);
bool('ui.chartZones', 'Chart: draw FVG and order block zones', true);
bool('ui.chartTrades', 'Chart: draw trades and fills', true);
int('ui.refreshMs', 'Screen refresh (ms)', 1000, 250, 5000, 50);
bool('ui.showHelp', 'Show short help under each control', true);
bool('ui.compact', 'Compact tables', false);

// ---------- store ----------
bool('store.persist', 'Keep data on this device', true, { help: 'Needs the storage consent. Without it, everything lasts until you close the page.' });
int('store.keepJournal', 'Most closed trades kept', 5000, 100, 100000, 100);
int('store.keepAudit', 'Most audit entries kept', 50000, 1000, 500000, 1000);
int('store.keepCandles', 'Most candles cached per market and timeframe', 20000, 200, 200000, 500);

// ---------- engine ----------
sel('engine.roleId', 'Engine role', 'operator', [
  { value: 'observer', label: 'Observer: looks only, places no paper trade' },
  { value: 'trainer', label: 'Trainer: may learn, places no paper trade' },
  { value: 'operator', label: 'Operator: may place paper trades' },
], { help: 'Roles from js/trading/roles.js. The engine can never change its own role.' });
list('engine.tradeAssets', 'Markets allowed to trade', ['R_100', 'frxXAUUSD'], 'text');
list('engine.tradeTimeframes', 'Timeframes allowed to trade (seconds)', [60, 300, 900, 3600, 14400, 86400], 'number');
bool('engine.aiEnabled', 'AI coding assistant', false, { locked: true, lockReason: 'Off in the first build (D12). Turning it on needs your choice of provider and your own key.' });
bool('engine.liveEnabled', 'Live trading', false, { locked: true, lockReason: 'Locked (D14). Four weeks of demo review against written criteria, then your written approval.' });

export const SCHEMA = Object.freeze(rows.map((r) => Object.freeze(r)));
export const SCHEMA_BY_KEY = Object.freeze(Object.fromEntries(SCHEMA.map((r) => [r.key, r])));

// Nested defaults: { sre: { lookback: 300, ... }, ll: { feat: { families: true, ... } } }.
function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}
const getPath = (obj, path) => path.split('.').reduce((n, p) => (n && typeof n === 'object' ? n[p] : undefined), obj);
// Deep copy of plain data (objects, arrays, numbers, text, booleans). Faster than a round trip through JSON.
function fastClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i += 1) out[i] = fastClone(v[i]);
    return out;
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = fastClone(v[k]);
  return out;
}
const clone = fastClone;

export const DEFAULTS = (() => {
  const out = {};
  for (const r of SCHEMA) setPath(out, r.key, clone(r.default));
  return out;
})();

// Coerces one raw value (from a form, an import or code) to the row's type. Never throws.
export function coerce(key, raw) {
  const r = SCHEMA_BY_KEY[key];
  if (!r) return { ok: false, error: `Unknown setting: ${key}` };
  if (r.locked) return { ok: false, error: r.lockReason || 'This setting is locked in this build.' };
  switch (r.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return { ok: true, value: true };
      if (s === 'false' || s === '0' || s === 'off' || s === 'no' || s === '') return { ok: true, value: false };
      return { ok: false, error: `${r.label} needs yes or no.` };
    }
    case 'int':
    case 'num': {
      const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
      if (!Number.isFinite(n)) return { ok: false, error: `${r.label} needs a number.` };
      let v = Math.min(r.max, Math.max(r.min, n));
      if (r.type === 'int') v = Math.round(v);
      return { ok: true, value: v };
    }
    case 'sel': {
      const s = String(raw);
      return r.options.some((o) => o.value === s) ? { ok: true, value: s } : { ok: false, error: `${r.label}: choose a listed option.` };
    }
    case 'text': return { ok: true, value: String(raw ?? '').trim() };
    case 'list': {
      const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
      const items = parts.map((x) => String(x).trim()).filter((x) => x !== '');
      if (r.item === 'number') {
        const nums = items.map(Number);
        if (nums.some((n) => !Number.isFinite(n))) return { ok: false, error: `${r.label} needs numbers separated by commas.` };
        return { ok: true, value: nums };
      }
      return { ok: true, value: items };
    }
    case 'json': {
      if (raw && typeof raw === 'object') return { ok: true, value: clone(raw) };
      try {
        const parsed = JSON.parse(String(raw ?? ''));
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        return { ok: true, value: parsed };
      } catch (_) {
        return { ok: false, error: `${r.label} must be valid JSON.` };
      }
    }
    default: return { ok: false, error: `Unsupported type for ${key}` };
  }
}

// Returns a copy of values with key set to the coerced raw value. Throws on invalid input (callers catch).
export function withValue(values, key, raw) {
  const res = coerce(key, raw);
  if (!res.ok) throw new Error(res.error);
  const out = clone(values || {});
  setPath(out, key, res.value);
  return out;
}

// Config for one engine group: its defaults overlaid with the saved values for that prefix.
// cfgFor('sre', values) -> { lookback: 300, wing: 3, ... }. Missing or bad saved values fall back to defaults.
// It is called many times for every candle, so two things keep it cheap: the rows of each group are listed once, and a group
// object that normalise() made (complete, coerced, never edited afterwards) is validated once and then only copied.
// Every caller still gets its own copy, so editing the result cannot affect anyone else.
const GROUP_ROWS = new Map();
function groupRows(prefix) {
  let g = GROUP_ROWS.get(prefix);
  if (!g) {
    g = SCHEMA.filter((r) => r.key.startsWith(`${prefix}.`)).map((r) => ({ row: r, rel: r.key.slice(prefix.length + 1) }));
    GROUP_ROWS.set(prefix, g);
  }
  return g;
}
const TRUSTED = new WeakSet();     // group objects made by normalise()
const GROUP_CACHE = new WeakMap(); // trusted group object -> its validated config

function buildCfg(prefix, saved) {
  const merged = deepMerge(clone(DEFAULTS[prefix] || {}), saved);
  // Re-coerce every row of the group so a hand-edited import cannot push a value out of range.
  for (const { row, rel } of groupRows(prefix)) {
    const got = getPath(merged, rel);
    const res = coerce(row.key, got === undefined ? row.default : got);
    setPath(merged, rel, res.ok ? res.value : clone(row.default));
  }
  return merged;
}

export function cfgFor(prefix, values = {}) {
  const saved = (values && values[prefix]) || null;
  if (saved && TRUSTED.has(saved)) {
    let hit = GROUP_CACHE.get(saved);
    if (!hit) { hit = buildCfg(prefix, saved); GROUP_CACHE.set(saved, hit); }
    return fastClone(hit);
  }
  return buildCfg(prefix, saved || {});
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return a;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) && b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])
      ? deepMerge(a[k], b[k])
      : b[k];
  }
  return out;
}

// Full settings object with every row coerced. Used by import and by the pipeline snapshot.
export function normalise(values = {}) {
  const out = clone(DEFAULTS);
  for (const r of SCHEMA) {
    const got = getPath(values, r.key);
    if (got === undefined) continue;
    const res = coerce(r.key, got);
    if (res.ok) setPath(out, r.key, res.value);
  }
  for (const k of Object.keys(out)) if (out[k] && typeof out[k] === 'object') TRUSTED.add(out[k]);
  return out;
}

// Keys whose values the learning loop may propose to change (thresholds and model-facing rules only).
// Risk controls, costs, the usable cap, the roles and the gates are never in this list.
export const LEARNABLE_KEYS = Object.freeze(SCHEMA.filter((r) => r.learnable).map((r) => r.key));

export const isLocked = (key) => Boolean(SCHEMA_BY_KEY[key]?.locked);
