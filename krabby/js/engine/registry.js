// The 26 engines of the architecture, with their numbers, names and where they live. The Engines screen reads this.
// Numbers follow the labels in the settings schema. status: 'on' runs in this build; 'off' is locked or not built.
export const ENGINE_REGISTRY = Object.freeze([
  { number: 1, code: 'MDE', name: 'Market data engine', status: 'on', where: 'js/market/mde.js', role: 'Collects candles, checks them, and says when data is stale or has gaps.' },
  { number: 2, code: 'DEE', name: 'Execution engine (paper)', status: 'on', where: 'js/trading/trader.js', role: 'Simulates fills for approved orders. No real or demo order is ever sent.' },
  { number: 3, code: 'SRE', name: 'Support and resistance', status: 'on', where: 'js/engine/sre.js', role: 'Levels where price has reacted before.' },
  { number: 4, code: 'CDE', name: 'Consolidation', status: 'on', where: 'js/engine/cde.js', role: 'Ranges of four sizes, tracked at the same time.' },
  { number: 5, code: 'PDE', name: 'Premium and discount', status: 'on', where: 'js/engine/pde.js', role: 'Where price sits inside each relevant range.' },
  { number: 6, code: 'FVG', name: 'Fair value gap', status: 'on', where: 'js/engine/fvg.js', role: 'Three-candle gaps that carry displacement.' },
  { number: 7, code: 'OBE', name: 'Order block', status: 'on', where: 'js/engine/obe.js', role: 'Zones found in their structure context.' },
  { number: 8, code: 'BSL', name: 'Buy-side liquidity', status: 'on', where: 'js/engine/bsl.js', role: 'Estimated buy-stop clusters above price.' },
  { number: 9, code: 'SSL', name: 'Sell-side liquidity', status: 'on', where: 'js/engine/ssl.js', role: 'Estimated sell-stop clusters below price.' },
  { number: 10, code: 'LSE', name: 'Liquidity sweep', status: 'on', where: 'js/engine/lse.js', role: 'Sweeps followed by rejection, and breakouts that continue.' },
  { number: 11, code: 'MSE', name: 'Market structure', status: 'on', where: 'js/engine/mse.js', role: 'Swings, BOS, CHoCH and MSS.' },
  { number: 12, code: 'BDE', name: 'Breakout', status: 'on', where: 'js/engine/bde.js', role: 'Breakouts from ranges and levels, genuine or false.' },
  { number: 13, code: 'SRD', name: 'Strong reversal', status: 'on', where: 'js/engine/srd.js', role: 'Weighted reversal evidence. A score, not a probability.' },
  { number: 14, code: 'QAE', name: 'Quantitative analysis', status: 'on', where: 'js/engine/qae.js', role: 'ATR, volatility class, and the statistics used everywhere.' },
  { number: 15, code: 'BLE', name: 'Buy limit', status: 'on', where: 'js/engine/ble.js', role: 'Buy-limit proposals near support and discount areas.' },
  { number: 16, code: 'SLE', name: 'Sell limit', status: 'on', where: 'js/engine/sle.js', role: 'Sell-limit proposals near resistance and premium areas.' },
  { number: 17, code: 'TDC', name: 'Trade decision coordinator', status: 'on', where: 'js/engine/coordinator.js', role: 'Builds or drops a case. It never forces a trade.' },
  { number: 18, code: 'RME', name: 'Risk management', status: 'on', where: 'js/engine/risk.js', role: 'Veto and sizing. Learning cannot change it.' },
  { number: 19, code: 'DPM', name: 'Dynamic profit management', status: 'on', where: 'js/trading/orders.js', role: 'Per-trade objective and trailing stop.' },
  { number: 20, code: 'DPT', name: 'Daily profit target', status: 'on', where: 'js/trading/daily.js', role: 'Switches to reduced-risk mode at the target. Never stops the bot.' },
  { number: 21, code: 'PM', name: 'Performance monitor', status: 'on', where: 'js/trading/analytics.js', role: 'Results after measured costs, with ranges.' },
  { number: 22, code: 'SB', name: 'Strategy sandbox', status: 'on', where: 'js/sandbox/host.js', role: 'Runs strategy code in a Web Worker. Not a security boundary.' },
  { number: 23, code: 'BT', name: 'Backtest', status: 'on', where: 'js/backtest/run.js', role: 'Out-of-sample and walk-forward tests through the same engine code.' },
  { number: 24, code: 'DT', name: 'Decision trace', status: 'on', where: 'js/runtime/session.js', role: 'Records why each case was built, dropped, vetoed or filled.' },
  { number: 25, code: 'LL', name: 'Learning loop', status: 'on', where: 'js/learning/loop.js', role: 'Learns from outcomes. Proposes only; approval is a separate logged step.' },
  { number: 26, code: 'AI', name: 'AI coding assistant', status: 'off', where: 'js/engine/ai.js', role: 'Off in this build (D12).' },
]);

export const ENGINE_BY_CODE = Object.freeze(Object.fromEntries(ENGINE_REGISTRY.map((e) => [e.code, e])));
