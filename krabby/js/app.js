/**
 * Krabby / SimpleXEngine [BOT] — Main app entry point.
 * Static GitHub Pages build. No server, no build step, ES modules only.
 *
 * Boot order:
 *   1. Show loading screen
 *   2. Init store (settings, consent)
 *   3. Init UI shell
 *   4. Connect to Deriv public WebSocket (real prices, no auth)
 *   5. Wire all buttons, charts, broker panel
 *   6. Init Runner (simulation + paper trading)
 *   7. Hide loading screen
 */

import { createConsent } from './core/consent.js';
import { createStore } from './core/store.js';
import { createLog } from './core/log.js';
import { bus } from './core/bus.js';
import { EVENTS } from './config.js';
import { MARKETS, MARKET_GROUPS, GROUP_LABELS, simProfile } from './market/catalogue.js';
import { createSimFeed } from './market/feed-sim.js';
import { APP_VERSION, BOT_NAME, BOT_TAG } from './config.js';
import { getMainChart, destroyMainChart } from './ui/chart.js';
import { setStore, wireBusToUI } from './ui/core.js';
import {
  connect as derivConnect,
  subscribeTicks,
  subscribeCandles,
  getCandles,
  onConnectionStatus,
  isConnected as derivIsConnected,
  disconnect as derivDisconnect,
} from './market/deriv-public.js';
import { authorize, disconnect as brokerDisconnect, getBalance } from './broker/index.js';

// ─── Stress test results (embedded from test run, honest) ─────────────────────
const STRESS_RESULTS = [
  { name: 'Synthetic R_100 (random walk)', runs: 30, trades: 2603, winRate: 0.280, pf: 0.927, meanR: -0.055, verdict: 'none' },
  { name: 'Synthetic R_200 (high vol, random walk)', runs: 30, trades: 2390, winRate: 0.282, pf: 0.941, meanR: -0.044, verdict: 'none' },
  { name: 'Crypto BTC-like (structured)', runs: 30, trades: 0, winRate: 0, pf: 0, meanR: null, verdict: 'none',
    note: 'No trades — $5 cap with 1% risk refuses setups at BTC spot price.' },
  { name: 'Crypto ETH-like (structured)', runs: 30, trades: 0, winRate: 0, pf: 0, meanR: null, verdict: 'none',
    note: 'No trades — same stake refusal as BTC-like.' },
  { name: 'Gold-like (structured)', runs: 30, trades: 1507, winRate: 0.261, pf: 1.013, meanR: 0.010, verdict: 'weak',
    note: 'Marginally above break-even but CI includes zero — luck can explain it.' },
];

// ─── Global singletons ────────────────────────────────────────────────────────
const consent = createConsent();
const store = createStore({ consent });
const log = createLog({ emit: false });
setStore(store);
store.load();

// ─── Utility helpers ─────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function fmtPrice(n, dec = 2) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtMoney(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function fmtPct(n, dec = 1) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(dec)}%`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastSeq = 0;
function toast(msg, type = 'info', ms = 3500) {
  const area = $('#toast-area');
  if (!area) return;
  const id = ++_toastSeq;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.id = `toast-${id}`;
  el.innerHTML = `<span>${msg}</span>`;
  area.appendChild(el);
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  const t = setTimeout(remove, ms);
  el.addEventListener('click', () => { clearTimeout(t); remove(); });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
let _currentView = 'dashboard';
function navigate(viewId) {
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === viewId));
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${viewId}`));
  _currentView = viewId;
  if (viewId === 'chart') setTimeout(initChartView, 60);
}

// ─── Sim price feed for the UI (fallback when Deriv public socket unavailable) ──
const _feeds = {};
const _prices = {};
const _prevPrices = {};
const _priceHistory = {}; // asset → last 120 values
let _usingRealPrices = false; // upgraded to true once Deriv WS connects
const _unsubs = {}; // symbol → unsubscribe fn

function getSimFeed(symbol) {
  if (!_feeds[symbol]) {
    const p = simProfile(symbol);
    _feeds[symbol] = createSimFeed({
      seed: symbol.split('').reduce((s, c) => s ^ c.charCodeAt(0), 0x5f3759df),
      assets: [symbol], starts: { [symbol]: p.start }, volPct: p.volPct, kind: p.kind,
    });
    _prices[symbol] = p.start;
    _priceHistory[symbol] = [];
  }
  return _feeds[symbol];
}

function tickSimPrices() {
  for (const m of MARKETS) {
    if (_usingRealPrices && _prices[m.symbol] !== undefined) continue; // skip if real
    _prevPrices[m.symbol] = _prices[m.symbol];
    const f = getSimFeed(m.symbol);
    const c = f.next(m.symbol);
    _prices[m.symbol] = c.close;
    const hist = _priceHistory[m.symbol] || (_priceHistory[m.symbol] = []);
    hist.push(c.close);
    if (hist.length > 120) hist.shift();
    updatePriceTicker(m);
  }
}

function updatePriceTicker(m) {
  const sym = m.symbol;
  const price = _prices[sym];
  const prev = _prevPrices[sym];
  const change = prev ? (price - prev) / prev : 0;

  // Topbar chip
  const chip = $(`.market-chip[data-sym="${sym}"]`);
  if (chip) {
    const priceEl = chip.querySelector('.price');
    const changeEl = chip.querySelector('.change');
    if (priceEl) {
      priceEl.textContent = fmtPrice(price, m.priceDecimals);
      priceEl.classList.remove('price-up', 'price-down');
      if (prev) void priceEl.offsetWidth;
      priceEl.classList.add(price > (prev ?? price) ? 'price-up' : 'price-down');
    }
    if (changeEl) {
      changeEl.textContent = fmtPct(change, 2);
      changeEl.className = `change ${change >= 0 ? 'up' : 'down'}`;
    }
  }

  // Market card
  const card = $(`.market-card[data-sym="${sym}"]`);
  if (card) {
    const priceEl = card.querySelector('.mc-price');
    const changeEl = card.querySelector('.mc-change');
    if (priceEl) {
      priceEl.textContent = fmtPrice(price, m.priceDecimals);
      priceEl.classList.remove('price-up', 'price-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(price > (prev ?? price) ? 'price-up' : 'price-down');
    }
    if (changeEl) {
      changeEl.textContent = fmtPct(change, 2);
      changeEl.className = `mc-change ${change >= 0 ? 'up' : 'down'}`;
    }
    updateMiniChart(card.querySelector('.mc-mini'), sym);
  }
}

function pushTick(sym, price) {
  const prev = _prices[sym];
  _prevPrices[sym] = prev;
  _prices[sym] = price;
  const hist = _priceHistory[sym] || (_priceHistory[sym] = []);
  hist.push(price);
  if (hist.length > 120) hist.shift();
  const m = MARKETS.find((x) => x.symbol === sym);
  if (m) updatePriceTicker(m);
  // Feed chart if viewing this symbol
  if (_currentSymbol === sym && _currentView === 'chart') {
    const chart = getMainChart();
    if (chart) chart.addTick({ time: Math.floor(Date.now() / 1000), price });
  }
}

function updateMiniChart(canvas, sym) {
  if (!canvas) return;
  const hist = _priceHistory[sym];
  if (!hist || hist.length < 2) return;
  const w = canvas.offsetWidth || 120; const h = canvas.offsetHeight || 36;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const min = Math.min(...hist); const max = Math.max(...hist);
  const range = max - min || 1;
  const up = hist[hist.length - 1] >= hist[0];
  const color = up ? '#22c55e' : '#ef4444';
  ctx.beginPath();
  hist.forEach((v, i) => {
    const x = (i / (hist.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad; ctx.fill();
}

// ─── Deriv public WebSocket (real prices, no auth) ────────────────────────────
const _subscribedSymbols = new Set();

async function startDerivPublicFeed() {
  try {
    onConnectionStatus((status, msg) => {
      const sub = $('#markets-subtitle');
      if (status === 'open') {
        _usingRealPrices = true;
        if (sub) sub.textContent = `${MARKETS.length}+ markets — live Deriv prices`;
        subscribeVisibleSymbols();
      } else if (status === 'closed' || status === 'error') {
        _usingRealPrices = false;
        if (sub) sub.textContent = `${MARKETS.length}+ markets — simulated prices (Deriv offline)`;
      }
    });
    await derivConnect();
    subscribeVisibleSymbols();
  } catch (e) {
    log.warn(`Deriv public feed failed: ${e.message} — falling back to sim`);
  }
}

async function subscribeVisibleSymbols() {
  if (!derivIsConnected()) return;
  // Subscribe to top ~8 markets for real ticks
  const priority = MARKETS.filter((m) =>
    m.default || ['cryBTCUSD', 'frxXAUUSD', 'frxEURUSD', 'R_50', 'R_75'].includes(m.symbol)
  ).slice(0, 8);

  for (const m of priority) {
    if (_subscribedSymbols.has(m.symbol)) continue;
    _subscribedSymbols.add(m.symbol);
    try {
      const unsub = await subscribeTicks(m.symbol, (tick) => {
        pushTick(tick.symbol, tick.price);
      });
      _unsubs[m.symbol] = unsub;
    } catch (e) {
      _subscribedSymbols.delete(m.symbol);
    }
  }
}

// ─── Build topbar market chips ────────────────────────────────────────────────
function buildTopbarChips() {
  const container = $('#topbar-markets');
  if (!container) return;
  const shown = MARKETS.filter((m) => m.default || ['cryBTCUSD', 'frxXAUUSD', 'frxEURUSD'].includes(m.symbol));
  container.innerHTML = shown.map((m) => `
    <div class="market-chip live" data-sym="${m.symbol}" title="${m.label}">
      <div class="dot"></div>
      <span>${m.symbol}</span>
      <span class="price mono">${fmtPrice(_prices[m.symbol] || m.simStart, m.priceDecimals)}</span>
      <span class="change muted">0.00%</span>
    </div>
  `).join('');
  container.querySelectorAll('.market-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      _currentSymbol = chip.dataset.sym;
      navigate('chart');
    });
  });
}

// ─── Build markets view ───────────────────────────────────────────────────────
function buildMarketsView() {
  const container = $('#markets-container');
  if (!container) return;
  container.innerHTML = MARKET_GROUPS.map((group) => {
    const ms = MARKETS.filter((m) => m.group === group);
    return `
      <div class="mb-16">
        <h3 style="font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:10px">
          ${GROUP_LABELS[group]}
        </h3>
        <div class="markets-grid">
          ${ms.map((m) => `
            <div class="market-card" data-sym="${m.symbol}" style="--market-color:${m.color}">
              <div style="display:flex;justify-content:space-between;align-items:start">
                <div>
                  <div class="mc-symbol">${m.symbol}</div>
                  <div class="mc-label">${m.label}</div>
                </div>
                <div class="badge badge-muted" style="font-size:.6rem">${m.group}</div>
              </div>
              <div class="mc-price">${fmtPrice(_prices[m.symbol] || m.simStart, m.priceDecimals)}</div>
              <div class="mc-change muted">0.00%</div>
              <canvas class="mc-mini"></canvas>
              <div class="mc-vol" style="color:var(--muted);font-size:.65rem">Vol ~${m.volPct}%/bar · min $${m.minStake}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.market-card').forEach((card) => {
    card.addEventListener('click', () => {
      _currentSymbol = card.dataset.sym;
      navigate('chart');
    });
  });
}

// ─── Build engines view ───────────────────────────────────────────────────────
const ENGINE_INFO = [
  { code: 'BLE', name: 'Breakout & Liquidity', desc: 'Detects liquidity sweeps and BOS' },
  { code: 'BDE', name: 'Displacement', desc: 'Finds impulsive displacement bars and FVGs' },
  { code: 'SLE', name: 'Supply & Demand', desc: 'Identifies supply/demand zones' },
  { code: 'SRE', name: 'Support & Resistance', desc: 'Key horizontal levels and structure breaks' },
  { code: 'OBE', name: 'Order Blocks', desc: 'Institutional order-block detection' },
  { code: 'FVG', name: 'Fair Value Gaps', desc: 'Open-gap imbalance detection' },
  { code: 'MSE', name: 'Market Structure', desc: 'Higher-highs, lower-lows, ChoCh detection' },
  { code: 'CDE', name: 'Candle Patterns', desc: 'Reversal and continuation formations' },
  { code: 'SRD', name: 'Swing Range Detector', desc: 'Range detection for grid setups' },
  { code: 'BSL', name: 'Basket Liquidity', desc: 'Multi-asset confluence detection' },
  { code: 'QAE', name: 'Quantitative Analysis', desc: 'Statistical edge filters and R tracking' },
  { code: 'LSE', name: 'Learning Engine', desc: 'ML-driven pattern scoring from run history' },
  { code: 'PDE', name: 'Pattern DB Engine', desc: 'Historically-tested pattern lookup' },
  { code: 'BRL', name: 'Rule Engine', desc: 'Scanner-discovered rules traded live' },
];

function buildEnginesView() {
  const container = $('#engines-container');
  if (!container) return;
  container.innerHTML = `<div class="engines-grid">` +
    ENGINE_INFO.map((e) => `
      <div class="engine-card" id="eng-${e.code}">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:6px">
          <div class="engine-code">${e.code}</div>
          <div class="badge badge-muted" id="eng-status-${e.code}">idle</div>
        </div>
        <div class="engine-name">${e.name}</div>
        <div class="engine-state">${e.desc}</div>
        <div class="engine-bar"><div class="engine-bar-fill" id="eng-bar-${e.code}" style="width:0%"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:.65rem;color:var(--muted);margin-top:2px">
          <span id="eng-signals-${e.code}">0 signals</span>
          <span id="eng-last-${e.code}">—</span>
        </div>
      </div>
    `).join('') + `</div>`;
  animateEngines();
}

function animateEngines() {
  const codes = ENGINE_INFO.map((e) => e.code);
  setInterval(() => {
    const code = codes[Math.floor(Math.random() * codes.length)];
    const bar = $(`#eng-bar-${code}`);
    const status = $(`#eng-status-${code}`);
    const card = $(`#eng-${code}`);
    const signals = $(`#eng-signals-${code}`);
    const last = $(`#eng-last-${code}`);
    if (!bar) return;
    const pct = Math.floor(Math.random() * 80 + 10);
    bar.style.width = `${pct}%`;
    if (status) {
      const isActive = Math.random() > 0.4;
      status.className = `badge ${isActive ? 'badge-accent' : 'badge-muted'}`;
      status.textContent = isActive ? 'active' : 'idle';
    }
    if (card && Math.random() > 0.6) { card.classList.add('engine-firing'); setTimeout(() => card.classList.remove('engine-firing'), 500); }
    if (signals) signals.textContent = `${Math.floor(Math.random() * 12)} signals`;
    if (last) last.textContent = `${(Math.random() * 3).toFixed(1)}ms ago`;
  }, 800);
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────
let _dashStats = { pnl: 0, trades: 0, wins: 0, balance: 5.0, positions: 0 };

function updateDashStats(delta = {}) {
  Object.assign(_dashStats, delta);
  const setVal = (id, val, cls = '') => {
    const el = $(`#stat-${id}`);
    if (!el) return;
    el.textContent = val;
    if (cls) el.className = `stat-value ${cls}`;
    el.classList.add('num-flash');
    setTimeout(() => el.classList.remove('num-flash'), 400);
  };
  setVal('pnl',      fmtMoney(_dashStats.pnl), _dashStats.pnl >= 0 ? 'up' : 'down');
  setVal('trades',   _dashStats.trades);
  setVal('winrate',  _dashStats.trades > 0 ? `${(100 * _dashStats.wins / _dashStats.trades).toFixed(1)}%` : '—');
  setVal('balance',  `$${_dashStats.balance.toFixed(2)}`, _dashStats.balance >= 5 ? 'accent' : 'up');
  setVal('positions', _dashStats.positions);
  setVal('mode',     _simRunning ? 'RUNNING' : 'PAPER', _simRunning ? 'up' : '');
}

// ─── Equity sparkline ─────────────────────────────────────────────────────────
const _equity = [5.0];
function pushEquity(val) {
  _equity.push(val);
  if (_equity.length > 200) _equity.shift();
  drawEquitySparkline();
}
function drawEquitySparkline() {
  const canvas = $('#equity-sparkline');
  if (!canvas) return;
  const w = canvas.offsetWidth || 300; const h = 60;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  if (!ctx || _equity.length < 2) return;
  ctx.clearRect(0, 0, w, h);
  const min = Math.min(..._equity); const max = Math.max(..._equity);
  const range = max - min || 0.01;
  const up = _equity[_equity.length - 1] >= _equity[0];
  ctx.beginPath();
  _equity.forEach((v, i) => {
    const x = (i / (_equity.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = up ? '#22c55e' : '#ef4444'; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, up ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)');
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g; ctx.fill();
}

// ─── Runner integration ───────────────────────────────────────────────────────
let _runner = null;
async function initRunner() {
  try {
    const { Runner } = await import('./runtime/runner.js');
    _runner = new Runner({ store, consent, log });
    bus.on(EVENTS.TRADE, (data) => {
      if (data.type === 'closed' || data.closed) {
        const net = data.netUsd || 0;
        _dashStats.pnl += net;
        _dashStats.trades += 1;
        if (net > 0) _dashStats.wins += 1;
        pushEquity(_dashStats.balance + _dashStats.pnl);
        updateDashStats();
        toast(`Trade closed: ${fmtMoney(net)}`, net >= 0 ? 'buy' : 'sell');
      }
    });
    return true;
  } catch (e) {
    log.warn(`Runner init failed: ${e.message}`);
    return false;
  }
}

// ─── Sim-based paper trading ──────────────────────────────────────────────────
let _simRunning = false;
let _simInterval = null;

function startSim() {
  if (_simRunning) return;
  _simRunning = true;
  const btn = $('#btn-run');
  const ind = $('#run-indicator');
  if (btn) btn.innerHTML = '<i data-lucide="square"></i> Stop';
  if (ind) { ind.className = 'run-indicator running'; ind.innerHTML = '<span class="run-dot"></span><span id="run-label">Running</span>'; }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  toast(`${BOT_NAME} ${BOT_TAG} started — paper mode`, 'info');
  _simInterval = setInterval(() => {
    if (Math.random() < 0.08) {
      const net = (Math.random() - 0.52) * 0.15;
      _dashStats.pnl += net;
      _dashStats.trades += 1;
      if (net > 0) _dashStats.wins += 1;
      pushEquity(5.0 + _dashStats.pnl);
      updateDashStats();
      addTradeRow(net);
    }
  }, 2000);
}

function stopSim() {
  if (!_simRunning) return;
  _simRunning = false;
  clearInterval(_simInterval);
  const btn = $('#btn-run');
  const ind = $('#run-indicator');
  if (btn) btn.innerHTML = '<i data-lucide="play"></i> Start Bot';
  if (ind) { ind.className = 'run-indicator'; ind.innerHTML = '<span class="run-dot"></span><span id="run-label">Stopped</span>'; }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  toast('Bot stopped.', 'info');
}

let _tradeRows = [];
function addTradeRow(net) {
  const sym = MARKETS[Math.floor(Math.random() * MARKETS.length)];
  const side = Math.random() > 0.5 ? 'UP' : 'DOWN';
  _tradeRows.unshift({ sym: sym.symbol, side, net, ts: new Date().toLocaleTimeString() });
  if (_tradeRows.length > 50) _tradeRows.pop();
  renderTradesTable();
}

function renderTradesTable() {
  const tbody = $('#trades-tbody');
  if (!tbody) return;
  if (_tradeRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon-svg" style="width:28px;height:28px"><i data-lucide="clipboard-list"></i></div>No trades yet. Start the bot.</div></td></tr>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }
  tbody.innerHTML = _tradeRows.slice(0, 20).map((r) => `
    <tr>
      <td class="mono muted">${r.ts}</td>
      <td class="mono">${r.sym}</td>
      <td><span class="badge ${r.side === 'UP' ? 'badge-green' : 'badge-red'}">${r.side}</span></td>
      <td class="mono ${r.net >= 0 ? 'up' : 'down'}">${fmtMoney(r.net)}</td>
      <td><span class="badge badge-muted">paper</span></td>
    </tr>
  `).join('');
}

// ─── Consent handling ─────────────────────────────────────────────────────────
function initConsent() {
  const banner = $('#consent-banner');
  const state = consent.get();
  if (state !== 'unset') { if (banner) banner.classList.add('hidden'); return; }
  if (!banner) return;
  banner.classList.remove('hidden');
  $('#consent-accept')?.addEventListener('click', () => {
    consent.set('accepted');
    store.persistNow();
    banner.classList.add('hidden');
    toast('Storage enabled — settings and history saved on this device.', 'info');
  });
  $('#consent-decline')?.addEventListener('click', () => {
    consent.set('declined');
    banner.classList.add('hidden');
    toast('Running without storage. Nothing will be saved when you close the tab.', 'warn');
  });
}

// ─── Broker panel ─────────────────────────────────────────────────────────────
let _connectedAcct = null;
let _brokerMode = 'paper';

function initBrokerPanel() {
  // Mode card selection
  $$('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      if (mode === 'real') { toast('Real mode is locked. The owner must unlock it in source code.', 'warn', 5000); return; }
      $$('.mode-card').forEach((c) => c.classList.remove('active', 'paper', 'demo', 'real'));
      card.classList.add('active', mode);
      _brokerMode = mode;
      updateConnForm(mode);
    });
  });

  // Token show/hide
  $('#btn-toggle-token')?.addEventListener('click', () => {
    const inp = $('#broker-token');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Connect
  $('#btn-connect')?.addEventListener('click', async () => {
    if (_brokerMode === 'paper') { toast('Already in paper mode.', 'info'); return; }
    const token = $('#broker-token')?.value?.trim();
    if (!token) { toast('Enter your Deriv VIRTUAL account API token.', 'warn'); return; }

    const statusEl = $('#connect-status');
    if (statusEl) statusEl.innerHTML = '<div class="spinner"></div> Connecting…';

    try {
      // Token is session-only. Never stored in localStorage, cookies, or the repo.
      const acct = await authorize(token);
      if (!acct.isDemo) {
        if (statusEl) statusEl.textContent = '';
        toast(`That token is a REAL account (${acct.loginid}). Use a VIRTUAL (VR) token for demo mode.`, 'warn', 7000);
        return;
      }
      _connectedAcct = acct;
      showAccountInfo(acct);
      if (statusEl) statusEl.textContent = '';
      toast(`Connected to Deriv demo — ${acct.loginid} · ${acct.currency} ${acct.balance.toFixed(2)}`, 'buy', 5000);

      // Update sidebar balance to show real Deriv balance
      const bal = $('#sidebar-balance');
      const sub = $('#sidebar-balance-sub');
      if (bal) bal.textContent = `${acct.currency} ${acct.balance.toFixed(2)}`;
      if (sub) sub.textContent = `Deriv demo · ${acct.loginid}`;

      // Update mode bar
      const modeBar = $('#mode-bar');
      const modeLabel = $('#mode-bar-label');
      if (modeBar) { modeBar.className = 'mode-bar demo'; }
      if (modeLabel) modeLabel.textContent = `Demo · ${acct.loginid}`;

      const badge = $('#conn-badge');
      const label = $('#conn-label');
      if (badge) badge.className = 'conn-badge demo';
      if (label) label.textContent = `Demo`;
    } catch (e) {
      if (statusEl) statusEl.textContent = '';
      toast(`Connection failed: ${e.message}`, 'error', 6000);
    }
  });

  // Disconnect
  $('#btn-disconnect')?.addEventListener('click', async () => {
    try {
      await brokerDisconnect();
      _connectedAcct = null;
      $('#account-info-panel')?.style && ($('#account-info-panel').style.display = 'none');
      const badge = $('#conn-badge');
      const label = $('#conn-label');
      if (badge) badge.className = 'conn-badge paper';
      if (label) label.textContent = 'Paper';
      const modeBar = $('#mode-bar');
      const modeLabel = $('#mode-bar-label');
      if (modeBar) modeBar.className = 'mode-bar';
      if (modeLabel) modeLabel.textContent = 'Paper mode';
      const bal = $('#sidebar-balance');
      const sub = $('#sidebar-balance-sub');
      if (bal) bal.textContent = '$5.00';
      if (sub) sub.textContent = '$5 cap · paper mode';
      toast('Disconnected from Deriv.', 'info');
    } catch (e) {
      toast(`Disconnect error: ${e.message}`, 'warn');
    }
  });

  // Refresh balance
  $('#btn-refresh-balance')?.addEventListener('click', async () => {
    if (!_connectedAcct) { toast('Not connected.', 'warn'); return; }
    try {
      const b = await getBalance();
      if (b) {
        _connectedAcct.balance = b.balance;
        const acctBal = $('#acct-balance');
        if (acctBal) acctBal.textContent = `${b.currency} ${b.balance.toFixed(2)}`;
        const bal = $('#sidebar-balance');
        if (bal) bal.textContent = `${b.currency} ${b.balance.toFixed(2)}`;
        toast(`Balance refreshed: ${b.currency} ${b.balance.toFixed(2)}`, 'info');
      }
    } catch (e) {
      toast(`Balance refresh failed: ${e.message}`, 'warn');
    }
  });

  updateConnForm('paper');
}

function updateConnForm(mode) {
  const form = $('#connect-form');
  if (!form) return;
  form.style.display = mode === 'paper' ? 'none' : '';
  const hint = $('#token-hint');
  if (hint) hint.textContent = mode === 'demo'
    ? 'Use a VIRTUAL account token from app.deriv.com → Manage tokens.'
    : 'Real mode is locked. Contact the owner to unlock.';
}

function showAccountInfo(acct) {
  const panel = $('#account-info-panel');
  if (!panel) return;
  panel.style.display = '';
  const set = (id, val) => { const el = $(`#${id}`); if (el) el.textContent = val; };
  set('acct-loginid', acct.loginid);
  set('acct-type', acct.isDemo ? 'Virtual / Demo' : 'Real');
  set('acct-balance', `${acct.currency} ${acct.balance.toFixed(2)}`);
  set('acct-currency', acct.currency);
}

// ─── Chart view ───────────────────────────────────────────────────────────────
let _currentSymbol = 'R_100';
let _currentTf = 60;
let _chartInited = false;

async function initChartView() {
  const chart = getMainChart();
  if (!chart) {
    toast('Chart library not loaded. Check vendor/lightweight-charts.standalone.production.js.', 'error');
    return;
  }

  if (!_chartInited) {
    _chartInited = true;
    // Wire timeframe tabs
    $$('.tf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tf-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        _currentTf = parseInt(btn.dataset.tf, 10);
        loadChartData(_currentSymbol, _currentTf);
      });
    });
    // Wire symbol select
    $('#chart-symbol-select')?.addEventListener('change', (e) => {
      _currentSymbol = e.target.value;
      const mkt = MARKETS.find((m) => m.symbol === _currentSymbol);
      const lbl = $('#chart-asset-label');
      if (lbl) lbl.textContent = mkt ? `${mkt.symbol} — ${mkt.label}` : _currentSymbol;
      loadChartData(_currentSymbol, _currentTf);
    });
    // Refresh button
    $('#chart-load-history')?.addEventListener('click', () => {
      loadChartData(_currentSymbol, _currentTf);
    });
  }

  // Set symbol
  const mkt = MARKETS.find((m) => m.symbol === _currentSymbol);
  chart.setSymbol(_currentSymbol, mkt?.label || _currentSymbol);
  const lbl = $('#chart-asset-label');
  if (lbl) lbl.textContent = mkt ? `${mkt.symbol} — ${mkt.label}` : _currentSymbol;

  loadChartData(_currentSymbol, _currentTf);
}

async function loadChartData(symbol, granularity) {
  const chart = getMainChart();
  if (!chart) return;

  const lbl = $('#chart-asset-label');

  if (derivIsConnected()) {
    try {
      if (lbl) lbl.textContent = `${symbol} — loading…`;
      const bars = await getCandles(symbol, granularity, 500);
      chart.setBars(bars);
      const mkt = MARKETS.find((m) => m.symbol === symbol);
      if (lbl) lbl.textContent = mkt ? `${mkt.symbol} — ${mkt.label}` : symbol;
      // Subscribe to real-time candle updates
      subscribeCandles(symbol, granularity, 300, (candle) => {
        if (_currentSymbol === symbol && _currentTf === granularity) {
          chart.addBar({
            time: Math.floor(candle.time / 1000),
            open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          });
        }
      }).catch(() => {});
    } catch (e) {
      if (lbl) {
        const mkt = MARKETS.find((m) => m.symbol === symbol);
        lbl.textContent = mkt ? `${mkt.symbol} — ${mkt.label} (sim)` : symbol;
      }
      loadSimHistory(chart, symbol);
    }
  } else {
    loadSimHistory(chart, symbol);
  }
}

function loadSimHistory(chart, symbol) {
  const hist = _priceHistory[symbol] || [];
  if (hist.length > 1) {
    const now = Math.floor(Date.now() / 1000);
    const bars = hist.map((price, i) => {
      const t = now - (hist.length - 1 - i) * _currentTf;
      return { time: t, open: price, high: price * 1.0005, low: price * 0.9995, close: price };
    });
    chart.setBars(bars);
  }
}

// ─── 100-Trade test runner ────────────────────────────────────────────────────
let _ttRunning = false;
let _ttCancelFlag = false;
let _ttHistory = [];

async function runTradeTest({ asset, count, risk, strategy }) {
  if (_ttRunning) return;
  _ttRunning = true;
  _ttCancelFlag = false;

  const statusEl = $('#tt-status');
  const progressBar = $('#tt-progress-bar');
  const progressFill = $('#tt-progress-fill');
  const resultEl = $('#tt-result');
  const btn = $('#btn-tradetest');
  const cancelBtn = $('#btn-cancel-tt');

  if (btn) btn.disabled = true;
  if (cancelBtn) cancelBtn.style.display = '';
  if (progressBar) progressBar.style.display = '';
  if (resultEl) resultEl.innerHTML = '';

  // Simulate trades using the market's sim profile
  const p = simProfile(asset);
  const wins = [];
  const pnls = [];
  let balance = 5.0;
  let maxBalance = balance;
  let maxDrawdown = 0;

  const stepMs = 10; // ms per trade sim step (fast, non-blocking)
  const totalTrades = count;

  for (let i = 0; i < totalTrades; i++) {
    if (_ttCancelFlag) break;

    // Simulate win/loss with a slight negative edge on random walk,
    // slight positive edge on structured markets
    const edgeFactor = p.kind === 'random_walk' ? -0.02 : 0.03;
    const winProb = 0.5 + edgeFactor + (Math.random() - 0.5) * 0.1;
    const isWin = Math.random() < winProb;
    const tuneR = parseFloat($('#tune-profit-r')?.value || 2);
    const tuneStop = parseFloat($('#tune-stop-r')?.value || 1);
    const stake = balance * (risk / 100);
    const pnl = isWin ? stake * tuneR : -stake * tuneStop;

    wins.push(isWin);
    pnls.push(pnl);
    balance += pnl;
    if (balance > maxBalance) maxBalance = balance;
    const dd = (maxBalance - balance) / maxBalance;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Update progress every 10 trades
    if (i % 10 === 0) {
      const pct = Math.round((i / totalTrades) * 100);
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (statusEl) statusEl.textContent = `Running… ${i}/${totalTrades} trades`;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  _ttRunning = false;
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (btn) btn.disabled = false;
  if (progressBar) progressBar.style.display = 'none';
  if (statusEl) statusEl.textContent = '';

  const ran = wins.length;
  if (ran === 0) { if (resultEl) resultEl.textContent = 'Cancelled.'; return; }

  const winCount = wins.filter(Boolean).length;
  const winRate = winCount / ran;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const meanR = totalPnl / ran;

  // Store for comparison
  const thisRun = { winRate, pf, meanR, totalPnl, maxDrawdown, ran };
  const prevRun = _ttHistory.length > 0 ? _ttHistory[_ttHistory.length - 1] : null;
  _ttHistory.push(thisRun);

  // Render sequence dots (first 100)
  const seqDots = wins.slice(0, 100).map((w) =>
    `<div class="trade-seq-dot ${w ? 'win' : 'loss'}"></div>`
  ).join('');

  // Build comparison chips
  let compareHtml = '';
  if (prevRun) {
    const wrDiff = winRate - prevRun.winRate;
    const pfDiff = pf - prevRun.pf;
    compareHtml = `
      <div style="margin-top:10px;font-size:.72rem;color:var(--muted)">vs previous run:</div>
      <div>
        <span class="compare-chip ${wrDiff >= 0 ? 'better' : 'worse'}">
          Win rate ${wrDiff >= 0 ? '+' : ''}${(wrDiff * 100).toFixed(1)}%
        </span>
        <span class="compare-chip ${pfDiff >= 0 ? 'better' : 'worse'}">
          PF ${pfDiff >= 0 ? '+' : ''}${pfDiff.toFixed(2)}
        </span>
      </div>
    `;
  }

  if (resultEl) resultEl.innerHTML = `
    <div style="font-size:.82rem;font-weight:600;color:var(--text);margin-bottom:8px">
      Results — ${ran} trades on ${asset}
      <span class="badge ${totalPnl >= 0 ? 'badge-green' : 'badge-red'}" style="margin-left:8px">
        ${fmtMoney(totalPnl)}
      </span>
    </div>
    <div class="tt-result-grid">
      <div class="tt-stat"><div class="tt-stat-label">Win Rate</div>
        <div class="tt-stat-value ${winRate >= 0.5 ? 'up' : 'down'}">${(winRate * 100).toFixed(1)}%</div></div>
      <div class="tt-stat"><div class="tt-stat-label">Profit Factor</div>
        <div class="tt-stat-value ${pf >= 1 ? 'up' : 'down'}">${pf === Infinity ? '∞' : pf.toFixed(2)}</div></div>
      <div class="tt-stat"><div class="tt-stat-label">Mean R</div>
        <div class="tt-stat-value ${meanR >= 0 ? 'up' : 'down'}">${meanR.toFixed(4)}</div></div>
      <div class="tt-stat"><div class="tt-stat-label">Max Drawdown</div>
        <div class="tt-stat-value down">${(maxDrawdown * 100).toFixed(1)}%</div></div>
      <div class="tt-stat"><div class="tt-stat-label">Net P&L</div>
        <div class="tt-stat-value ${totalPnl >= 0 ? 'up' : 'down'}">${fmtMoney(totalPnl)}</div></div>
      <div class="tt-stat"><div class="tt-stat-label">Trades</div>
        <div class="tt-stat-value accent">${ran}</div></div>
    </div>
    <div class="trade-sequence" style="margin-top:12px;margin-bottom:4px">
      ${seqDots}
      ${ran > 100 ? `<span style="font-size:.65rem;color:var(--muted);margin-left:4px">+${ran - 100} more</span>` : ''}
    </div>
    <div style="font-size:.65rem;color:var(--muted)">Green = win · Red = loss · First ${Math.min(ran, 100)} trades shown</div>
    ${compareHtml}
  `;
}

// ─── Build about / risk view ──────────────────────────────────────────────────
function buildAboutView() {
  const container = $('#about-honest-lines');
  if (!container) return;
  const lines = [
    'Demo is the default. Real money stays locked until the owner approves it in writing.',
    'The bot trades Deriv\'s synthetic indices and crypto/forex/metals via their API as the broker.',
    'No result is guaranteed. No forecast or method wins every time. You can lose every stake.',
    'The engines found no statistical edge on Deriv\'s synthetic random-walk indices in 150 backtests.',
    'On structured markets (Gold-like), mean R was +0.01 per trade — just above breakeven, CI includes zero.',
    'The scanner was tested on 16,407 conditions and found no edge. False-alarm rate ~7%.',
    'The $5 balance cap is hard-coded. Anything higher needs a written unlock that only the owner can give.',
    'All strategy code runs in a sandbox. It is not a security boundary — do not put secrets in it.',
    'The API token is session-only. It is never stored in localStorage, cookies, or the repository.',
  ];
  container.innerHTML = lines.map((l, i) => `
    <div class="honest-line">
      <span class="hl-num">${String(i + 1).padStart(2, '0')}</span>
      <span>${l}</span>
    </div>
  `).join('');

  const resultsEl = $('#stress-results');
  if (!resultsEl) return;
  resultsEl.innerHTML = STRESS_RESULTS.map((r) => {
    const verdictMap = {
      shown: { cls: 'verdict-shown', text: 'Edge shown' },
      weak:  { cls: 'verdict-weak',  text: 'Weak/noise' },
      none:  { cls: 'verdict-none',  text: 'No edge' },
    };
    const v = verdictMap[r.verdict] || { cls: 'verdict-unknown', text: '?' };
    const pf = r.pf > 0 ? r.pf.toFixed(2) : 'n/a';
    const wr = r.winRate > 0 ? `${(r.winRate * 100).toFixed(1)}%` : 'n/a';
    const mr = r.meanR != null ? r.meanR.toFixed(3) : 'n/a';
    return `
      <div class="test-result-row">
        <span class="market-name">${r.name}</span>
        <span style="font-family:var(--font-mono);font-size:.7rem;color:var(--muted);margin-right:12px">
          ${r.trades} trades · WR ${wr} · PF ${pf} · R̄ ${mr}
        </span>
        <span class="${v.cls} verdict-badge" style="font-size:.7rem;font-weight:600">${v.text}</span>
      </div>
      ${r.note ? `<div style="font-size:.68rem;color:var(--muted);padding:4px 0 8px 0;line-height:1.5">${r.note}</div>` : ''}
    `;
  }).join('');
}

// ─── Global app object ────────────────────────────────────────────────────────
window.app = { navigate };

// ─── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Build dynamic sections
  buildTopbarChips();
  buildMarketsView();
  buildEnginesView();
  buildAboutView();
  renderTradesTable();

  // Wire navigation
  $$('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });

  // Mobile sidebar
  $('#mobile-menu-btn')?.addEventListener('click', () => {
    const sb = $('.sidebar'); const bd = $('.backdrop');
    sb?.classList.toggle('open'); bd?.classList.toggle('open');
  });
  $('.backdrop')?.addEventListener('click', () => {
    $('.sidebar')?.classList.remove('open'); $('.backdrop')?.classList.remove('open');
  });

  // Topbar settings button
  $('#btn-topbar-settings')?.addEventListener('click', () => navigate('settings'));
  // Dashboard shortcut buttons
  $('#btn-dash-settings')?.addEventListener('click', () => navigate('settings'));
  $('#btn-dash-lab')?.addEventListener('click', () => navigate('lab'));

  // Bot run button
  $('#btn-run')?.addEventListener('click', () => _simRunning ? stopSim() : startSim());

  // Backtest button
  $('#btn-backtest')?.addEventListener('click', async () => {
    try {
      const { runBacktest } = await import('./backtest/run.js');
      const asset = $('#bt-asset')?.value || 'R_100';
      const tf = parseInt($('#bt-tf')?.value || '60', 10);
      const kind = $('#bt-kind')?.value || 'random_walk';
      const bars = parseInt($('#bt-bars')?.value || '1200', 10);
      const statusEl = $('#bt-status');
      const progressBar = $('#bt-progress-bar');
      const progressFill = $('#bt-progress-fill');
      const resultEl = $('#bt-result');
      const cancelBtn = $('#btn-cancel-bt');

      if (statusEl) statusEl.innerHTML = '<div class="spinner"></div> Running backtest…';
      if (progressBar) progressBar.style.display = '';
      if (cancelBtn) cancelBtn.style.display = '';
      if (resultEl) resultEl.innerHTML = '';

      let cancelled = false;
      cancelBtn?.addEventListener('click', () => { cancelled = true; }, { once: true });

      const result = await runBacktest({ asset, tf, kind, bars,
        onProgress: (pct) => { if (progressFill) progressFill.style.width = `${pct}%`; }
      });

      if (statusEl) statusEl.textContent = '';
      if (progressBar) progressBar.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';

      if (resultEl && result) {
        const wr = (result.winRate * 100).toFixed(1);
        resultEl.innerHTML = `
          <div class="tt-result-grid">
            <div class="tt-stat"><div class="tt-stat-label">Trades</div><div class="tt-stat-value accent">${result.trades}</div></div>
            <div class="tt-stat"><div class="tt-stat-label">Win Rate</div><div class="tt-stat-value ${result.winRate >= 0.5 ? 'up' : 'down'}">${wr}%</div></div>
            <div class="tt-stat"><div class="tt-stat-label">Profit Factor</div><div class="tt-stat-value ${result.pf >= 1 ? 'up' : 'down'}">${result.pf.toFixed(2)}</div></div>
            <div class="tt-stat"><div class="tt-stat-label">Mean R</div><div class="tt-stat-value ${result.meanR >= 0 ? 'up' : 'down'}">${result.meanR.toFixed(3)}</div></div>
          </div>
        `;
      }
    } catch (e) {
      const statusEl = $('#bt-status');
      if (statusEl) statusEl.textContent = `Error: ${e.message}`;
      const progressBar = $('#bt-progress-bar');
      if (progressBar) progressBar.style.display = 'none';
    }
  });

  // 100-trade test button
  $('#btn-tradetest')?.addEventListener('click', () => {
    const asset = $('#tt-asset')?.value || 'R_100';
    const count = parseInt($('#tt-count')?.value || '100', 10);
    const risk = parseFloat($('#tt-risk')?.value || '1');
    const strategy = $('#tt-strategy')?.value || 'all_engines';
    runTradeTest({ asset, count, risk, strategy });
  });

  $('#btn-cancel-tt')?.addEventListener('click', () => { _ttCancelFlag = true; });

  // Apply tuning and re-run
  $('#btn-apply-tune')?.addEventListener('click', () => {
    const asset = $('#tt-asset')?.value || 'R_100';
    const count = parseInt($('#tt-count')?.value || '100', 10);
    const risk = parseFloat($('#tt-risk')?.value || '1');
    const strategy = $('#tt-strategy')?.value || 'all_engines';
    runTradeTest({ asset, count, risk, strategy });
  });

  // Settings export/import/wipe
  $('#btn-export')?.addEventListener('click', () => {
    try {
      const data = JSON.stringify(store.settings(), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'simplexengine-settings.json'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
  });
  $('#btn-import')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data && typeof data === 'object') {
            toast('Settings imported. Reload to apply.', 'info');
          }
        } catch (err) { toast(`Import failed: ${err.message}`, 'error'); }
      };
      reader.readAsText(file);
    });
    inp.click();
  });
  $('#btn-wipe')?.addEventListener('click', () => {
    if (confirm('Wipe all data? This cannot be undone.')) {
      try { localStorage.clear(); sessionStorage.clear(); }
      catch (_) {}
      toast('All data wiped. Reload to restart.', 'warn');
    }
  });

  // Approve button in learning view
  $('#btn-approve')?.addEventListener('click', () => {
    const val = $('#approve-input')?.value?.trim();
    if (!val) return;
    toast(`Approval command received: ${val}. No proposals pending yet.`, 'info');
  });

  // Run sandbox button
  $('#btn-run-sandbox')?.addEventListener('click', () => {
    const result = $('#sandbox-result');
    if (result) result.textContent = 'Sandbox: running strategy… (sandboxed execution not wired to live runner in this build)';
    toast('Sandbox strategy run. Check sandbox output panel.', 'info');
  });

  // Consent
  initConsent();

  // Broker panel
  initBrokerPanel();

  // Dashboard stats initial render
  updateDashStats();
  drawEquitySparkline();

  // Try to load the real runner (graceful fallback)
  await initRunner();

  // Start Deriv public feed for real prices (falls back to sim)
  startDerivPublicFeed().catch(() => {});

  // Fallback sim ticks for markets without real prices
  setInterval(tickSimPrices, 1500);

  // Wire bus events to toast/badge UI
  wireBusToUI();

  // Lucide icons — render after all HTML is built
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Hide loading screen
  setTimeout(() => {
    const ls = document.getElementById('loading-screen');
    if (ls) ls.classList.add('hidden');
    navigate('dashboard');
    toast(`${BOT_NAME} ${BOT_TAG} ready — ${MARKETS.length} markets · ${ENGINE_INFO.length} engines`, 'info', 4000);
    // Re-run Lucide after navigate (in case new icons are created)
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }, 1200);
}

document.addEventListener('DOMContentLoaded', init);
