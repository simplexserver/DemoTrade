// Market catalogue. Every market the bot can trade, with metadata for the UI and the broker.
// source 'deriv' = real Deriv API symbol. source 'sim' = simulator only (no live data).
// group: 'synthetic' | 'crypto' | 'forex' | 'metals' | 'indices'
// volatilityPct: M1 bar vol estimate (% of price) used by the simulator.
// minStake: Deriv minimum stake in USD for multipliers.
// multipliers: available Deriv multiplier values.
// priceDecimals: display precision.
// liveUrl: Deriv chart URL for reference.

export const MARKETS = [
  // ─── Deriv Synthetics (always available on Deriv demo/real) ───────────────────
  {
    symbol: 'R_10',   label: 'Volatility 10 Index',   group: 'synthetic', source: 'deriv',
    desc: 'Simulates 10% constant volatility. Deriv proprietary synthetic.',
    volPct: 0.01, priceDecimals: 3, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 10000, color: '#14b8a6',
  },
  {
    symbol: 'R_25',   label: 'Volatility 25 Index',   group: 'synthetic', source: 'deriv',
    desc: 'Simulates 25% constant volatility.',
    volPct: 0.025, priceDecimals: 3, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 10000, color: '#06b6d4',
  },
  {
    symbol: 'R_50',   label: 'Volatility 50 Index',   group: 'synthetic', source: 'deriv',
    desc: 'Simulates 50% constant volatility. Mid-range synthetic.',
    volPct: 0.05, priceDecimals: 3, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 10000, color: '#8b5cf6',
  },
  {
    symbol: 'R_75',   label: 'Volatility 75 Index',   group: 'synthetic', source: 'deriv',
    desc: 'Simulates 75% constant volatility. High-vol synthetic.',
    volPct: 0.075, priceDecimals: 3, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 500, color: '#f59e0b',
  },
  {
    symbol: 'R_100',  label: 'Volatility 100 Index',  group: 'synthetic', source: 'deriv',
    desc: 'Simulates 100% constant volatility. The standard test asset.',
    volPct: 0.04, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 1000, color: '#ef4444', default: true,
  },
  {
    symbol: '1HZ10V',  label: 'Volatility 10 (1s)',   group: 'synthetic', source: 'deriv',
    desc: '1-second ticks, 10% vol. Tick trading.',
    volPct: 0.001, priceDecimals: 3, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 10000, color: '#10b981',
  },
  {
    symbol: '1HZ100V', label: 'Volatility 100 (1s)',  group: 'synthetic', source: 'deriv',
    desc: '1-second ticks, 100% vol.',
    volPct: 0.04, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 1000, color: '#f97316',
  },
  {
    symbol: 'BOOM500',  label: 'Boom 500 Index',      group: 'synthetic', source: 'deriv',
    desc: 'On average one boom spike (upward) every 500 ticks.',
    volPct: 0.03, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 2000, color: '#22c55e',
  },
  {
    symbol: 'BOOM1000', label: 'Boom 1000 Index',     group: 'synthetic', source: 'deriv',
    desc: 'On average one boom spike every 1000 ticks.',
    volPct: 0.025, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 3000, color: '#4ade80',
  },
  {
    symbol: 'CRASH500',  label: 'Crash 500 Index',    group: 'synthetic', source: 'deriv',
    desc: 'On average one crash spike (downward) every 500 ticks.',
    volPct: 0.03, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 2000, color: '#ef4444',
  },
  {
    symbol: 'CRASH1000', label: 'Crash 1000 Index',   group: 'synthetic', source: 'deriv',
    desc: 'On average one crash spike every 1000 ticks.',
    volPct: 0.025, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 3000, color: '#f87171',
  },
  {
    symbol: 'STPDWN300', label: 'Step Down 300',      group: 'synthetic', source: 'deriv',
    desc: 'Price steps down by exactly one pip each tick, 300 possible outcomes.',
    volPct: 0.02, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 1000, color: '#a78bfa',
  },
  {
    symbol: 'STPUP300',  label: 'Step Up 300',        group: 'synthetic', source: 'deriv',
    desc: 'Price steps up by exactly one pip each tick.',
    volPct: 0.02, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 1000, color: '#818cf8',
  },

  // ─── Crypto (Deriv cryXXXUSD symbols) ────────────────────────────────────────
  {
    symbol: 'cryBTCUSD', label: 'Bitcoin / USD',      group: 'crypto', source: 'deriv',
    desc: 'BTC/USD synthetic on Deriv. Tracks real Bitcoin price with synthetic random walk.',
    volPct: 0.5, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50,100,200],
    simStart: 95000, color: '#f59e0b',
  },
  {
    symbol: 'cryETHUSD', label: 'Ethereum / USD',     group: 'crypto', source: 'deriv',
    desc: 'ETH/USD synthetic on Deriv.',
    volPct: 0.35, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50,100],
    simStart: 3400, color: '#6366f1',
  },
  {
    symbol: 'cryLTCUSD', label: 'Litecoin / USD',     group: 'crypto', source: 'deriv',
    desc: 'LTC/USD synthetic on Deriv.',
    volPct: 0.4, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 95, color: '#94a3b8',
  },
  {
    symbol: 'cryXRPUSD', label: 'XRP / USD',          group: 'crypto', source: 'deriv',
    desc: 'XRP/USD synthetic on Deriv.',
    volPct: 0.4, priceDecimals: 5, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 2.5, color: '#38bdf8',
  },
  {
    symbol: 'crySOLUSD', label: 'Solana / USD',       group: 'crypto', source: 'deriv',
    desc: 'SOL/USD synthetic on Deriv.',
    volPct: 0.45, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 230, color: '#a855f7',
  },
  {
    symbol: 'cryADAUSD', label: 'Cardano / USD',      group: 'crypto', source: 'deriv',
    desc: 'ADA/USD synthetic on Deriv.',
    volPct: 0.4, priceDecimals: 5, minStake: 0.35, multipliers: [5,10,20,30,40,50],
    simStart: 0.9, color: '#06b6d4',
  },

  // ─── Forex (frxXXXYYY symbols) ────────────────────────────────────────────────
  {
    symbol: 'frxEURUSD', label: 'EUR / USD',           group: 'forex', source: 'deriv',
    desc: 'Euro vs US Dollar. The most liquid forex pair.',
    volPct: 0.025, priceDecimals: 5, minStake: 0.35, multipliers: [5,10,20,30,40,50,100,200,300,500],
    simStart: 1.085, color: '#3b82f6',
  },
  {
    symbol: 'frxGBPUSD', label: 'GBP / USD',           group: 'forex', source: 'deriv',
    desc: 'British Pound vs US Dollar.',
    volPct: 0.03, priceDecimals: 5, minStake: 0.35, multipliers: [5,10,20,30,40,50,100,200,300,500],
    simStart: 1.265, color: '#10b981',
  },
  {
    symbol: 'frxUSDJPY', label: 'USD / JPY',           group: 'forex', source: 'deriv',
    desc: 'US Dollar vs Japanese Yen.',
    volPct: 0.025, priceDecimals: 3, minStake: 0.35, multipliers: [5,10,20,30,40,50,100,200,300,500],
    simStart: 154.2, color: '#f43f5e',
  },
  {
    symbol: 'frxUSDCAD', label: 'USD / CAD',           group: 'forex', source: 'deriv',
    desc: 'US Dollar vs Canadian Dollar.',
    volPct: 0.025, priceDecimals: 5, minStake: 0.35, multipliers: [5,10,20,30,40,50,100],
    simStart: 1.398, color: '#f97316',
  },
  {
    symbol: 'frxAUDUSD', label: 'AUD / USD',           group: 'forex', source: 'deriv',
    desc: 'Australian Dollar vs US Dollar.',
    volPct: 0.025, priceDecimals: 5, minStake: 0.35, multipliers: [5,10,20,30,40,50,100],
    simStart: 0.643, color: '#fbbf24',
  },
  {
    symbol: 'frxEURGBP', label: 'EUR / GBP',           group: 'forex', source: 'deriv',
    desc: 'Euro vs British Pound. Cross pair.',
    volPct: 0.02, priceDecimals: 5, minStake: 0.35, multipliers: [5,10,20,30,40,50,100],
    simStart: 0.858, color: '#a78bfa',
  },

  // ─── Metals ───────────────────────────────────────────────────────────────────
  {
    symbol: 'frxXAUUSD', label: 'Gold / USD',          group: 'metals', source: 'deriv',
    desc: 'Spot gold vs US Dollar. Safe-haven asset.',
    volPct: 0.08, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50,100,200,300,500,1000],
    simStart: 2650, color: '#fbbf24',
  },
  {
    symbol: 'frxXAGUSD', label: 'Silver / USD',        group: 'metals', source: 'deriv',
    desc: 'Spot silver vs US Dollar.',
    volPct: 0.1, priceDecimals: 3, minStake: 0.35, multipliers: [5,10,20,30,40,50,100],
    simStart: 30.8, color: '#94a3b8',
  },
  {
    symbol: 'frxXPTUSD', label: 'Platinum / USD',      group: 'metals', source: 'deriv',
    desc: 'Spot platinum vs US Dollar.',
    volPct: 0.09, priceDecimals: 2, minStake: 0.35, multipliers: [5,10,20,30,40,50,100],
    simStart: 968, color: '#e2e8f0',
  },
];

export const MARKET_BY_SYMBOL = Object.freeze(Object.fromEntries(MARKETS.map((m) => [m.symbol, m])));

export const MARKET_GROUPS = ['synthetic', 'crypto', 'forex', 'metals'];
export const GROUP_LABELS = { synthetic: 'Synthetics', crypto: 'Crypto', forex: 'Forex', metals: 'Metals' };

export function defaultMarket() { return MARKETS.find((m) => m.default) || MARKETS[0]; }

// Volatility profile for the simulator: maps from Deriv symbol to feed-sim params.
export function simProfile(symbol) {
  const m = MARKET_BY_SYMBOL[symbol] || defaultMarket();
  return { volPct: m.volPct, start: m.simStart, kind: m.group === 'synthetic' ? 'random_walk' : 'regimes' };
}
