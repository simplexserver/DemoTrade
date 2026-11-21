# SimpleXEngine [BOT] — Krabby

**Static trading bot for GitHub Pages · Deriv API · No server · $5 cap always enforced**

> ⚠ Beta software. No profit is guaranteed. You can lose the stake on every trade.
> Demo mode is the default. Real money stays locked until the owner approves it in writing.

---

## What it is

SimpleXEngine [BOT] is a fully browser-based algorithmic trading assistant built on the [Deriv](https://deriv.com) API. It runs on any static host (GitHub Pages, Netlify, Cloudflare Pages) with zero server-side code, zero build steps, and zero runtime dependencies beyond the vendored Lightweight Charts library.

The bot analyses price data with a 14-engine pipeline (BLE, BDE, SLE, SRE, OBE, FVG, MSE, CDE, SRD, BSL, QAE, LSE, PDE, BRL), proposes entries, scores them through a risk gate, and places Deriv Multipliers contracts — all while keeping a strict **$5 usable-balance cap** that cannot be overridden.

---

## Quickstart

```
1. Clone or download the zip
2. Open index.html in any browser (file:// works for paper mode)
3. For demo/real mode: deploy to GitHub Pages (or any static host)
4. Connect a Deriv VIRTUAL account token to unlock demo mode
```

No `npm install`, no build, no Node.js required to run.

---

## Modes

| Mode   | Money         | Network        | How to unlock                                              |
|--------|--------------|----------------|------------------------------------------------------------|
| Paper  | Fake ($1,000) | None           | Default — always available                                  |
| Demo   | Deriv virtual | Real WS + API  | Owner sets `risk.demoGateway = true` + VR account token    |
| Real   | Real money    | Real WS + API  | Owner sets `LOCKS.liveGate = true` in source + ACK phrase  |

Real mode is **locked in this build**. The only way to unlock it is to edit `js/config.js` (set `LOCKS.liveGate: true`) and deploy — no UI toggle, no API call, no learning loop can do it.

---

## Safety guarantees (hard-coded, never bypassed)

| Rule | Detail |
|---|---|
| **$5 cap** | `LOCKS.usableBalanceCapUsd = 5`. Every order is rejected if `stake > 5`. |
| **Min stake** | `$0.35` — Deriv's floor for multipliers. Orders below this are rejected. |
| **Token never stored** | The API token lives in memory only. Never in localStorage, cookies, or the repo. |
| **Demo gate** | `risk.demoGateway` must be `true` (owner-set) before demo mode can activate. |
| **Real gate** | `LOCKS.liveGate` must be `true` (owner-edits source) before real mode is reachable. |
| **ACK phrase** | Real mode requires typing: *"I understand I may lose money and I accept the $5 cap"* |
| **Emergency stop** | One click halts all new orders and closes all open live contracts. |
| **Daily loss limit** | Configurable; defaults to 20 % of the day-start balance. |

---

## Markets

30+ markets across four groups:

- **Synthetics** — R_10, R_25, R_50, R_75, R_100, 1HZ10V, 1HZ100V, BOOM500, BOOM1000, CRASH500, CRASH1000, STPDWN300, STPUP300
- **Crypto** — BTC/USD, ETH/USD, LTC/USD, XRP/USD, SOL/USD, ADA/USD
- **Forex** — EUR/USD, GBP/USD, USD/JPY, USD/CAD, AUD/USD, EUR/GBP
- **Metals** — XAU/USD (Gold), XAG/USD (Silver), XPT/USD (Platinum)

All markets run a live price simulator in the UI (independent from the trading runner). Demo/real mode streams real prices from Deriv's WebSocket API.

---

## Engines (14 active)

| Engine | Full name |
|---|---|
| BLE | Breaker Level Engine |
| BDE | Bias/Direction Engine |
| SLE | Structural Level Engine |
| SRE | Support/Resistance Engine |
| OBE | Order Block Engine |
| FVG | Fair Value Gap Engine |
| MSE | Market Structure Engine |
| CDE | Candle Dynamics Engine |
| SRD | Smart Reversal Detector |
| BSL | Buy-Side Liquidity Engine |
| QAE | Quantitative Advantage Engine |
| LSE | Liquidity Sweep Engine |
| PDE | Premium/Discount Engine |
| BRL | Break-and-Retest Level Engine |

Each engine scores the current bar independently. The coordinator (`js/engine/coordinator.js`) combines their outputs into a `TradingCase` with a risk-adjusted verdict before the risk gate sees it.

---

## Architecture

```
index.html ──► js/app.js ──► js/runtime/runner.js
                              │
                              ├── js/runtime/session.js  (paper trader, candle store)
                              ├── js/engine/pipeline.js  (14-engine analysis)
                              ├── js/engine/coordinator.js (TDC buildCases)
                              ├── js/engine/risk.js      (RME, $5 cap gate)
                              ├── js/learning/loop.js    (online learning, never rewrites live code)
                              ├── js/broker/index.js     (paper/demo/real, Deriv WS)
                              └── js/market/catalogue.js (30+ markets, sim profiles)

No build, no bundler. All imports are relative ES module paths ending in .js.
```

---

## Learning module

The learning loop (`js/learning/loop.js`) watches closed trades and proposes parameter adjustments. Every proposal must be:

1. Scored ≥ a confidence threshold
2. Tested on ≥ 100 closed paper trades (D13)
3. **Approved in writing by the owner** via the Learning view UI

The loop never rewrites live engine code, never touches risk limits, and never bypasses the $5 cap.

---

## File layout

```
/
├── index.html              — full UI shell (10 views, loading screen, consent banner)
├── css/app.css             — dark trading terminal design system
├── js/
│   ├── app.js              — main entry point
│   ├── config.js           — ENDPOINTS, LOCKS, EVENTS, schema constants
│   ├── broker/index.js     — Deriv adapter (paper/demo/real)
│   ├── core/               — bus, store, consent, log, util
│   ├── deriv/              — WebSocket connection, reconnect, redaction
│   ├── engine/             — 14 engines + coordinator, risk gate, indicators
│   ├── learning/           — scanner, model, eval, gate, loop
│   ├── market/             — catalogue, sim feed, aggregate, backfill
│   ├── runtime/            — runner, session, view, decide
│   ├── sandbox/            — strategy sandbox (documented non-security boundary)
│   ├── strategies/         — example and library strategies
│   ├── trading/            — analytics, sizing, roles, orders, daily tracker
│   └── ui/                 — chart.js (Lightweight Charts), core.js (helpers)
├── vendor/
│   └── lightweight-charts.standalone.production.js
└── tests/
    ├── unit.mjs            — test runner (node:test)
    ├── smoke.mjs           — static smoke checks (110 checks)
    └── *.test.mjs          — 194 unit tests
```

---

## Deploying to GitHub Pages

1. Push the repo (no build step needed)
2. Settings → Pages → Source: `main` branch, `/ (root)`
3. The site is live at `https://<user>.github.io/<repo>/`
4. Tokens never go in the repo — enter them in the Broker panel at runtime

---

## Honest limits

- **No profit guarantee.** The engines have a slight negative expected value on random-walk synthetics (win rate ~28%, PF ~0.93 from 150 backtests). They show a marginal edge on structured markets (Gold-like PF ~1.01) which is within noise.
- **BTC/ETH pricing** at real spot prices makes the $5 × 1% risk stake ($0.05) smaller than Deriv's $0.35 minimum — so the bot places no orders on crypto markets at this balance. A larger balance or a Deriv accumulator contract would solve this.
- **This is a beta.** Use demo mode first. Never risk money you cannot afford to lose.

---

## Running the tests

```bash
# 194 unit tests (no network, no DOM)
node tests/unit.mjs

# 110 smoke checks (syntax, exports, HTML structure)
node tests/smoke.mjs

# Full runner integration tests (spawns worker threads; run separately)
node --test-timeout=90000 tests/runner.test.mjs
```

---

*SimpleXEngine [BOT] v1.0.0 · Static · Deriv API · $5 cap always on*
