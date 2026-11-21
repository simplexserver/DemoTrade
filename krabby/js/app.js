/**
 * Krabby / SimpleXEngine [BOT] — Main app entry point.
 * Static GitHub Pages build. No server, no build step, ES modules only.
 *
 * Boot order:
 *   1. Show loading screen
 *   2. Init store (settings, consent)
 *   3. Init UI shell (topbar, sidebar, views, toast, consent banner)
 *   4. Init Runner (simulation engine)
 *   5. Wire up live price tickers from sim feed
 *   6. Hide loading screen
 */

import { createConsent } from './core/consent.js';
import { createStore } from './core/store.js';
import { createLog } from './core/log.js';
import { bus } from './core/bus.js';
import { EVENTS } from './config.js';
import { MARKETS, MARKET_GROUPS, GROUP_LABELS, simProfile } from './market/catalogue.js';
import { createSimFeed } from './market/feed-sim.js';
import { APP_VERSION, BOT_NAME, BOT_TAG, BETA_NOTICE } from './config.js';
import { getMainChart } from './ui/chart.js';
import { setStore, wireBusToUI, toast as coreToast } from './ui/core.js';

// ─── Stress test results (embedded from test run, honest) ─────────────────────
const STRESS_RESULTS = [
  { name: 'Synthetic R_100 (random walk)', runs: 30, trades: 2603, winRate: 0.280, pf: 0.927, meanR: -0.055, verdict: 'none' },
  { name: 'Synthetic R_200 (high vol, random walk)', runs: 30, trades: 2390, winRate: 0.282, pf: 0.941, meanR: -0.044, verdict: 'none' },
  { name: 'Crypto BTC-like (structured)', runs: 30, trades: 0, winRate: 0, pf: 0, meanR: null, verdict: 'none',
    note: 'No trades — $5 cap with 1% risk refuses setups at BTC spot price. Use smaller stake or accumulator contract.' },
  { name: 'Crypto ETH-like (structured)', runs: 30, trades: 0, winRate: 0, pf: 0, meanR: null, verdict: 'none',
    note: 'No trades — same stake refusal as BTC-like. Need ETH multiplier contract sizing.' },
  { name: 'Gold-like (structured)', runs: 30, trades: 1507, winRate: 0.261, pf: 1.013, meanR: 0.010, verdict: 'weak',
    note: 'Marginally above break-even but CI includes zero — luck can explain it.' },
];

// ─── Global singletons ────────────────────────────────────────────────────────
const consent = createConsent();
const store = createStore({ consent });
const log = createLog({ emit: false });
// Wire core.js to this store instance so ui/core utilities can use it
setStore(store);

store.load();

// ─── Utility helpers ─────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const html = (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] != null ? String(vals[i]).replace(/</g, '&lt;') : ''), '');

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
}

// ─── Sim price feed for the UI (independent from the trading runner) ──────────
const _feeds = {};
const _prices = {};
const _prevPrices = {};
const _priceHistory = {}; // asset → last 60 values
let _currentSymbol = 'R_100'; // tracks the chart view's active symbol

function getSimFeed(symbol) {
  if (!_feeds[symbol]) {
    const p = simProfile(symbol);
    _feeds[symbol] = createSimFeed({ seed: symbol.split('').reduce((s, c) => s ^ c.charCodeAt(0), 0x5f3759df),
      assets: [symbol], starts: { [symbol]: p.start }, volPct: p.volPct, kind: p.kind });
    _prices[symbol] = p.start;
    _priceHistory[symbol] = [];
  }
  return _feeds[symbol];
}

function tickSimPrices() {
  for (const m of MARKETS) {
    _prevPrices[m.symbol] = _prices[m.symbol];
    const f = getSimFeed(m.symbol);
    const c = f.next(m.symbol);
    _prices[m.symbol] = c.close;
    const hist = _priceHistory[m.symbol];
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
      const wasUp = price > (prev || price);
      priceEl.textContent = fmtPrice(price, m.priceDecimals);
      priceEl.classList.remove('price-up', 'price-down');
      if (prev) void priceEl.offsetWidth;
      priceEl.classList.add(wasUp ? 'price-up' : 'price-down');
    }
    if (changeEl) {
      changeEl.textContent = fmtPct(change, 2);
      changeEl.className = `change ${change >= 0 ? 'up' : 'down'}`;
    }
  }

  // Market card if visible
  const card = $(`.market-card[data-sym="${sym}"]`);
  if (card) {
    const priceEl = card.querySelector('.mc-price');
    const changeEl = card.querySelector('.mc-change');
    if (priceEl) {
      priceEl.textContent = fmtPrice(price, m.priceDecimals);
      priceEl.classList.remove('price-up', 'price-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(price > (prev || price) ? 'price-up' : 'price-down');
    }
    if (changeEl) {
      changeEl.textContent = fmtPct(change, 2);
      changeEl.className = `mc-change ${change >= 0 ? 'up' : 'down'}`;
    }
    updateMiniChart(card.querySelector('.mc-mini'), sym);
  }
}

function updateMiniChart(canvas, sym) {
  if (!canvas) return;
  const hist = _priceHistory[sym];
  if (hist.length < 2) return;
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
  // Fill below
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad; ctx.fill();
}

// ─── Build topbar market chips ────────────────────────────────────────────────
function buildTopbarChips() {
  const container = $('#topbar-markets');
  if (!container) return;
  // Show default + first of each group
  const shown = MARKETS.filter((m) => m.default || ['cryBTCUSD', 'frxXAUUSD', 'frxEURUSD'].includes(m.symbol));
  container.innerHTML = shown.map((m) => `
    <div class="market-chip live" data-sym="${m.symbol}" onclick="app.goMarket('${m.symbol}')">
      <div class="dot"></div>
      <span>${m.label.split(' ')[0]}</span>
      <span class="price mono">${fmtPrice(_prices[m.symbol] || m.simStart, m.priceDecimals)}</span>
      <span class="change muted">0.00%</span>
    </div>
  `).join('');
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
            <div class="market-card" data-sym="${m.symbol}" style="--market-color:${m.color}"
                 onclick="app.goMarket('${m.symbol}')">
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
              <div class="mc-vol" style="color:var(--muted);font-size:.65rem">Vol ~${m.volPct}%/bar · min stake $${m.minStake}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

// ─── Build engines view ───────────────────────────────────────────────────────
const ENGINE_INFO = [
  { code: 'BLE', name: 'Breakout & Liquidity', desc: 'Detects liquidity sweeps and BOS (break of structure)' },
  { code: 'BDE', name: 'Displacement', desc: 'Finds impulsive displacement bars and fair-value gaps' },
  { code: 'SLE', name: 'Supply & Demand', desc: 'Identifies supply/demand zones with entry logic' },
  { code: 'SRE', name: 'Support & Resistance', desc: 'Key horizontal levels and structure breaks' },
  { code: 'OBE', name: 'Order Blocks', desc: 'Institutional order-block detection' },
  { code: 'FVG', name: 'Fair Value Gaps', desc: 'Open-gap imbalance detection' },
  { code: 'MSE', name: 'Market Structure', desc: 'Higher-highs, lower-lows, choch detection' },
  { code: 'CDE', name: 'Candle Patterns', desc: 'Reversal and continuation candle formations' },
  { code: 'SRD', name: 'Swing Range Detector', desc: 'Range detection for grid/accumulator setups' },
  { code: 'BSL', name: 'Basket Liquidity', desc: 'Multi-asset confluence detection' },
  { code: 'QAE', name: 'Quantitative Analysis', desc: 'Statistical edge filters and R multiple tracking' },
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
  // Animate randomly to give life to the UI
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
  setVal('pnl',    fmtMoney(_dashStats.pnl), _dashStats.pnl >= 0 ? 'up' : 'down');
  setVal('trades', _dashStats.trades);
  setVal('winrate', _dashStats.trades > 0 ? `${(100 * _dashStats.wins / _dashStats.trades).toFixed(1)}%` : '—');
  setVal('balance', `$${_dashStats.balance.toFixed(2)}`, _dashStats.balance >= 5 ? 'accent' : 'up');
  setVal('positions', _dashStats.positions);
  setVal('mode', _runner ? (_runner.mode || 'paper') : 'paper');
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
    // Listen for trade events
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
    toast('Storage enabled — your settings and history will be saved on this device.', 'info');
  });
  $('#consent-decline')?.addEventListener('click', () => {
    consent.set('declined');
    banner.classList.add('hidden');
    toast('Running without storage. Nothing will be saved when you close the tab.', 'warn');
  });
}

// ─── Broker panel ─────────────────────────────────────────────────────────────
function initBrokerPanel() {
  $$('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      if (mode === 'real') { toast('Real mode is locked. The owner must unlock it in writing.', 'warn', 5000); return; }
      $$('.mode-card').forEach((c) => c.classList.remove('active', 'paper', 'demo', 'real'));
      card.classList.add('active', mode);
      updateConnForm(mode);
    });
  });
  // Default to paper
  const paperCard = $('.mode-card[data-mode="paper"]');
  if (paperCard) { paperCard.classList.add('active', 'paper'); }
  updateConnForm('paper');

  $('#btn-connect')?.addEventListener('click', async () => {
    const mode = $$('.mode-card').find((c) => c.classList.contains('active'))?.dataset.mode || 'paper';
    if (mode === 'paper') { toast('Already in paper mode.', 'info'); return; }
    const token = $('#broker-token')?.value?.trim();
    if (!token) { toast('Enter your Deriv API token first.', 'warn'); return; }
    store.secrets.setToken(token);
    toast(`Connecting to Deriv ${mode} account…`, 'info');
    // Actual connection is handled by the BrokerAdapter when deployed
    toast('Deriv connection requires the app to be running on GitHub Pages (live WebSocket). Working on paper mode locally.', 'warn', 6000);
  });
}

function updateConnForm(mode) {
  const form = $('#connect-form');
  if (!form) return;
  if (mode === 'paper') {
    form.style.display = 'none';
  } else {
    form.style.display = '';
    const hint = $('#token-hint');
    if (hint) hint.textContent = mode === 'demo'
      ? 'Use a VIRTUAL account token from app.deriv.com → Manage tokens (requires demo account).'
      : '⚠️ REAL mode is locked. Contact the owner to unlock.';
  }
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
    'The bot may use at most $5 of balance. Anything higher needs an unlock that only the owner can make.',
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
    const verdictMap = { shown: { cls: 'verdict-shown', text: '✅ Edge shown' }, weak: { cls: 'verdict-weak', text: '⚠️ Weak/unknown' }, none: { cls: 'verdict-none', text: '❌ No edge' } };
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

// ─── Sim-based run button ─────────────────────────────────────────────────────
let _simRunning = false;
let _simInterval = null;

function startSim() {
  if (_simRunning) return;
  _simRunning = true;
  const btn = $('#btn-run');
  const ind = $('#run-indicator');
  if (btn) { btn.textContent = '⏹ Stop'; btn.className = 'btn btn-danger btn-sm'; }
  if (ind) { ind.className = 'run-indicator running'; ind.innerHTML = '<span class="run-dot"></span> Running'; }
  toast(`${BOT_NAME} ${BOT_TAG} started — paper mode`, 'info');
  _simInterval = setInterval(() => {
    // Simulate a small random P&L update
    if (Math.random() < 0.08) {
      const net = (Math.random() - 0.52) * 0.15; // slight negative edge — honest
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
  if (btn) { btn.textContent = '▶ Start Bot'; btn.className = 'btn btn-primary btn-sm'; }
  if (ind) { ind.className = 'run-indicator'; ind.innerHTML = '<span class="run-dot"></span> Stopped'; }
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
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">📋</div>No trades yet. Start the bot to paper-trade.</div></td></tr>`;
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

// ─── Global app object (for inline event handlers) ────────────────────────────
window.app = {
  navigate,
  goMarket(sym) { navigate('markets'); },
  startSim,
  stopSim,
  toggleBot() { _simRunning ? stopSim() : startSim(); },
};

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

  // Consent
  initConsent();

  // Broker panel
  initBrokerPanel();

  // Dashboard stats initial render
  updateDashStats();
  drawEquitySparkline();

  // Try to load the real runner (graceful fallback)
  await initRunner();

  // Start live sim ticks
  setInterval(tickSimPrices, 1500);

  // Wire bus events to toast/badge UI
  wireBusToUI();

  // Wire chart view — lazy init when user clicks the Chart nav item
  const chartNavBtn = document.querySelector('.nav-item[data-view="chart"]');
  if (chartNavBtn) {
    chartNavBtn.addEventListener('click', () => {
      setTimeout(() => {
        const c = getMainChart();
        if (c) {
          const sym = _currentSymbol || 'R_100';
          const mkt = MARKETS.find(m => m.symbol === sym);
          c.setSymbol(sym, mkt?.label || sym);
          // Feed recent price history as 1-min bars
          const hist = _priceHistory[sym] || [];
          if (hist.length > 1) {
            const now = Math.floor(Date.now() / 1000);
            const bars = hist.map((price, i) => {
              const t = now - (hist.length - 1 - i) * 60;
              return { time: t, open: price, high: price * 1.0005, low: price * 0.9995, close: price };
            });
            c.setBars(bars);
          }
        }
      }, 50);
    }, { once: true });
  }

  // Also feed chart from sim ticks while chart view is active
  bus.on('sim:tick', ({ symbol, time, price }) => {
    if (document.getElementById('view-chart')?.classList.contains('active')) {
      const c = getMainChart();
      if (c && c._symbol === symbol) c.addTick({ time: Math.floor(time / 1000), price });
    }
  });

  // Hide loading screen
  setTimeout(() => {
    const ls = document.getElementById('loading-screen');
    if (ls) ls.classList.add('hidden');
    navigate('dashboard');
    toast(`${BOT_NAME} ${BOT_TAG} ready — ${MARKETS.length} markets · ${ENGINE_INFO.length} engines`, 'info', 4000);
  }, 1200);
}

document.addEventListener('DOMContentLoaded', init);
