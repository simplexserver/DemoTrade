// Trade ticket. One form that morphs per family. Value edits refresh only the live region (quotes,
// warnings, buttons) so typing never loses focus. Structural edits (family, type, switches) re-render the form.
import { TRADE_FAMILIES, TRADE_TYPES, TRADE_TYPE_BY_ID, DEFAULT_MULTIPLIERS, DEFAULT_GROWTH_RATES, DURATION_UNITS, ORDER_TYPES, EVENTS } from '../config.js';
import { store } from '../core/store.js';
import { bus } from '../core/bus.js';
import { fmtMoney, escapeHtml, toNumber, debounce, round, uid } from '../core/util.js';
import { switchHtml, numberField, textField, selectField, bindPaths, bindActions, toast, renderInto } from './core.js';
import { deriv } from '../deriv/api.js';
import { trader } from '../trading/trader.js';
import { pending } from '../trading/orders.js';

const QUOTE_DEBOUNCE_MS = 300;
const STOP_FAMILIES = new Set(['multipliers', 'cfd', 'basket', 'accumulators']); // SL/TP and trailing
const DYNAMIC_TP_FAMILIES = new Set(['multipliers', 'cfd', 'basket']);
const ORDER_FAMILIES = new Set(['options', 'multipliers', 'cfd', 'basket']);
const VIRTUAL_NEEDS = {
  limit: ['triggerPrice'], stop: ['triggerPrice'], stop_limit: ['triggerPrice', 'limitPrice'],
  oco: ['triggerPrice', 'limitPrice'], trailing_stop_limit: ['trailDistance'],
};
const FIELD_LABEL = { triggerPrice: 'the trigger price', limitPrice: 'the limit price', trailDistance: 'the trail distance' };

let markets = [];                       // normalised Market[] from deriv.getMarkets / MARKETS
let contractsCache = { symbol: null, info: null };
let quotes = { up: null, down: null };  // {quote} | {error} per side
let streams = [];
let streamSeq = 0;
let renderedKey = null;

const trade = () => store.get('settings.trade') || {};
const currencyOf = (t) => t.currency || 'USD';
const familyOf = (t) => TRADE_FAMILIES.find((f) => f.id === t.family) || TRADE_FAMILIES[0];
const marketFor = (symbol) => markets.find((m) => m.symbol === symbol) || null;

// The type must belong to the chosen family. A stale typeId falls back to the family's first type.
function typeFor(t) {
  const byId = TRADE_TYPE_BY_ID[t.typeId];
  if (byId && byId.family === t.family) return byId;
  return TRADE_TYPES.find((x) => x.family === t.family) || TRADE_TYPES[0];
}

function enabledOrderIds() {
  const orders = store.get('settings.orders') || {};
  return ORDER_TYPES.filter((o) => o.id === 'market' || orders[o.id]).map((o) => o.id);
}

// Only enabled order types count. A disabled type falls back to Market.
function orderTypeOf(t) {
  const ids = enabledOrderIds();
  return ids.includes(t.orderType) ? t.orderType : 'market';
}

// Trader input for the current ticket and side. Used by Submit, the live quote and the one-click bar.
export function buildInput(t, side) {
  const type = typeFor(t);
  const fam = type.family;
  const stops = STOP_FAMILIES.has(fam);
  const sl = stops && fam !== 'accumulators' && t.slOn ? toNumber(t.sl, null) : null;
  const tp = stops && t.tpOn ? toNumber(t.tp, null) : null;
  const trailing = stops && t.trailing?.on
    ? { on: true, activatePct: toNumber(t.trailing.activatePct, 20), trailPct: toNumber(t.trailing.trailPct, 10), peakPct: 0, armed: false }
    : { on: false };
  const dynamicTp = DYNAMIC_TP_FAMILIES.has(fam) && t.dynamicTp?.on
    ? { on: true, atrMultiple: toNumber(t.dynamicTp.atrMultiple, 1.5) }
    : { on: false };
  return {
    typeId: type.id, symbol: t.symbol, side, stake: toNumber(t.stake, 0), source: 'Manual',
    duration: t.duration, barrier: t.barrier, barrier2: t.barrier2, digit: t.digit,
    multiplier: t.multiplier, growth: t.growth, sl, tp,
    rules: { trailing, dynamicTp },
  };
}

// Exported for the one-click bar: the same input the ticket would send.
export function tradeInputFromForm(side = 'up') {
  return buildInput(trade(), side);
}

function virtualIssues(t) {
  const ot = orderTypeOf(t);
  const missing = (VIRTUAL_NEEDS[ot] || []).filter((k) => !Number.isFinite(toNumber(t[k], NaN)));
  if (!missing.length) return [];
  return [`Set ${missing.map((k) => FIELD_LABEL[k]).join(' and ')} for this order.`];
}

// Problems that disable the buttons. Each one is shown with its reason.
function blockers(t) {
  const out = [];
  const cur = currencyOf(t);
  const min = deriv.minStake(cur);
  const stake = toNumber(t.stake, NaN);
  if (!Number.isFinite(stake) || stake < min) out.push(`Stake must be at least ${fmtMoney(min, cur)}.`);
  if (t.family === 'basket' && markets.length && marketFor(t.symbol)?.market !== 'basket_index') {
    out.push('Pick a basket index.');
  }
  if (VIRTUAL_NEEDS[orderTypeOf(t)]) out.push(...virtualIssues(t));
  return out;
}

// Advisory notices. They do not block the buttons.
function warnings(t) {
  const out = [];
  const m = marketFor(t.symbol);
  if (m && m.isOpen === false) out.push(`${t.symbol} is closed. Deriv rejects orders until it reopens.`);
  if (m && m.isSuspended) out.push(`${t.symbol} is suspended.`);
  if (contractsCache.info && contractsCache.info.verified === false) {
    out.push('Contract limits for this market are not confirmed by Deriv. Defaults are used.');
  }
  return out;
}

// Keys that change the shape of the form. A change to any of these re-renders the whole form.
function structureKey(t) {
  const info = contractsCache.info;
  return [
    t.family, t.typeId, orderTypeOf(t), Boolean(t.slOn), Boolean(t.tpOn), Boolean(t.trailing?.on),
    Boolean(t.dynamicTp?.on), enabledOrderIds().join(','), t.symbol, deriv.isAuthed(),
    marketFor(t.symbol)?.isOpen, info ? info.types?.length : 'none', markets.length,
  ].join('|');
}

function familyButtons(active) {
  return TRADE_FAMILIES.map((f) => `<button type="button" class="seg-btn${f.id === active ? ' active' : ''}" data-action="trade-family" data-id="${escapeHtml(f.id)}" aria-pressed="${f.id === active}">${escapeHtml(f.label)}</button>`).join('');
}

function optionsSelect(t) {
  const opts = TRADE_TYPES.filter((x) => x.family === 'options').map((x) => ({ value: x.id, label: x.label }));
  return selectField({ path: 'settings.trade.typeId', label: 'Options type', value: t.typeId, options: opts });
}

function stepperStake(t, cur) {
  return `<div class="field"><label class="field-label" for="f-stake">Volume (${escapeHtml(cur)} stake)</label>
    <div class="stepper">
      <button type="button" class="btn btn-ghost btn-sm" data-action="trade-step" data-arg="-0.1" aria-label="Decrease volume">-</button>
      <input class="input mono" id="f-stake" type="number" inputmode="decimal" step="0.01" min="0" data-path="settings.trade.stake" value="${escapeHtml(t.stake)}">
      <button type="button" class="btn btn-ghost btn-sm" data-action="trade-step" data-arg="0.1" aria-label="Increase volume">+</button>
    </div></div>`;
}

function stakeField(t) {
  const cur = currencyOf(t);
  if (t.family === 'cfd') return stepperStake(t, cur);
  return numberField({ path: 'settings.trade.stake', label: 'Stake', value: t.stake, min: 0, step: 0.01, unit: cur });
}

function durationFields(t, type) {
  if (!type.params.includes('duration')) return '';
  const d = t.duration || type.duration;
  const units = DURATION_UNITS.map((u) => ({ value: u.id, label: u.label }));
  return `<div class="grid-2">
    ${numberField({ path: 'settings.trade.duration.value', label: 'Duration', value: d.value, min: 1, step: 1 })}
    ${selectField({ path: 'settings.trade.duration.unit', label: 'Unit', value: d.unit, options: units })}
  </div>${durationHint(type)}`;
}

// Allowed duration range from contracts_for, shown as text (units differ by contract, so not validated here).
function durationHint(type) {
  const info = contractsCache.info;
  const row = info?.types?.find((x) => x.contractType === type.contracts.up);
  if (!row || (row.minDuration == null && row.maxDuration == null)) return '';
  return `<div class="hint">Deriv allows ${escapeHtml(row.minDuration ?? '?')} to ${escapeHtml(row.maxDuration ?? '?')}.</div>`;
}

function barrierFields(t, type) {
  const out = [];
  if (type.params.includes('barrier')) {
    out.push(textField({ path: 'settings.trade.barrier', label: 'Barrier', value: t.barrier, type: 'text' }));
  }
  if (type.params.includes('barrier2')) {
    out.push(textField({ path: 'settings.trade.barrier2', label: 'Second barrier', value: t.barrier2, type: 'text' }));
  }
  if (type.params.includes('digit')) {
    const opts = Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: String(i) }));
    out.push(selectField({ path: 'settings.trade.digit', label: 'Digit', value: String(t.digit ?? 5), options: opts, numeric: true }));
  }
  return out.length ? `<div class="grid-2">${out.join('')}</div>` : '';
}

function multiplierField(t) {
  const row = contractsCache.info?.types?.find((x) => x.contractType === 'MULTUP');
  const fromDeriv = Array.isArray(row?.multiplierRange) ? row.multiplierRange.map(Number).filter(Number.isFinite) : [];
  const base = fromDeriv.length ? fromDeriv : DEFAULT_MULTIPLIERS;
  const values = [...new Set([...base, Number(t.multiplier)])].filter(Number.isFinite).sort((a, b) => a - b);
  const opts = values.map((v) => ({ value: String(v), label: `x${v}` }));
  return selectField({ path: 'settings.trade.multiplier', label: 'Multiplier', value: String(t.multiplier), options: opts, numeric: true });
}

function growthField(t) {
  const row = contractsCache.info?.types?.find((x) => x.contractType === 'ACCU');
  const fromDeriv = Array.isArray(row?.growthRateRange) ? row.growthRateRange.map(Number).filter(Number.isFinite) : [];
  const base = fromDeriv.length ? fromDeriv : DEFAULT_GROWTH_RATES;
  const values = [...new Set([...base, Number(t.growth)])].filter(Number.isFinite).sort((a, b) => a - b);
  const opts = values.map((g) => ({ value: String(g), label: `${g}%` }));
  return selectField({ path: 'settings.trade.growth', label: 'Growth rate', value: String(t.growth), options: opts, numeric: true });
}

function basketSelect(t) {
  const list = markets.filter((m) => m.market === 'basket_index').map((m) => ({ value: m.symbol, label: m.name || m.symbol }));
  if (!list.some((o) => o.value === t.symbol)) list.unshift({ value: t.symbol, label: t.symbol });
  return selectField({ path: 'settings.trade.symbol', label: 'Basket', value: t.symbol, options: list });
}

function sltpBlock(t) {
  const acc = t.family === 'accumulators';
  const sl = acc ? '' : `${switchHtml({ path: 'settings.trade.slOn', label: 'Stop loss', checked: Boolean(t.slOn) })}
    ${t.slOn ? numberField({ path: 'settings.trade.sl', label: 'Stop loss (USD)', value: t.sl, min: 0, step: 0.01, nullable: true }) : ''}`;
  const tp = `${switchHtml({ path: 'settings.trade.tpOn', label: 'Take profit', sub: acc ? 'Accumulators allow take profit only.' : '', checked: Boolean(t.tpOn) })}
    ${t.tpOn ? numberField({ path: 'settings.trade.tp', label: 'Take profit (USD)', value: t.tp, min: 0, step: 0.01, nullable: true }) : ''}`;
  return `<div class="stack">${sl}${tp}</div>`;
}

function formFields(t, type) {
  const f = t.family;
  if (f === 'options') return [optionsSelect(t), stakeField(t), durationFields(t, type), barrierFields(t, type)].join('');
  if (f === 'basket') return [basketSelect(t), stakeField(t), multiplierField(t), sltpBlock(t)].join('');
  if (f === 'accumulators') return [stakeField(t), growthField(t), sltpBlock(t)].join('');
  return [stakeField(t), multiplierField(t), sltpBlock(t)].join('');
}

function virtualFields(t, ot) {
  if (!VIRTUAL_NEEDS[ot]) return '';
  const trigLabel = ot === 'oco' ? 'Buy stop above' : ot === 'trailing_stop_limit' ? 'Activation price' : 'Trigger price';
  const parts = [numberField({ path: 'settings.trade.triggerPrice', label: trigLabel, value: t.triggerPrice, min: 0, step: 0.00001, nullable: true })];
  if (ot === 'stop_limit' || ot === 'oco') {
    parts.push(numberField({ path: 'settings.trade.limitPrice', label: ot === 'oco' ? 'Sell stop below' : 'Limit price', value: t.limitPrice, min: 0, step: 0.00001, nullable: true }));
  }
  if (ot === 'trailing_stop_limit') {
    parts.push(numberField({ path: 'settings.trade.trailDistance', label: 'Trail distance', value: t.trailDistance, min: 0, step: 0.00001, nullable: true }));
  }
  return `<div class="grid-2">${parts.join('')}</div>
    <div class="hint">Virtual order: Krabby watches the price and fires it while the app is open.</div>`;
}

function orderBlock(t) {
  const ot = orderTypeOf(t);
  const opts = ORDER_TYPES.filter((o) => enabledOrderIds().includes(o.id)).map((o) => ({ value: o.id, label: o.label }));
  const note = ORDER_TYPES.find((o) => o.id === ot)?.note || '';
  return `<div class="stack">
    ${selectField({ path: 'settings.trade.orderType', label: 'Order type', value: ot, options: opts })}
    <div class="hint">${escapeHtml(note)}</div>
    ${virtualFields(t, ot)}
  </div>`;
}

function trailingBlock(t) {
  const tr = t.trailing || {};
  return `<div class="stack">
    ${switchHtml({ path: 'settings.trade.trailing.on', label: 'Trailing stop', sub: 'Arms at the activation profit, closes after a drop from the peak.', checked: Boolean(tr.on) })}
    ${tr.on ? `<div class="grid-2">
      ${numberField({ path: 'settings.trade.trailing.activatePct', label: 'Activate at profit (%)', value: tr.activatePct, min: 1, step: 1 })}
      ${numberField({ path: 'settings.trade.trailing.trailPct', label: 'Trail by (%)', value: tr.trailPct, min: 1, step: 1 })}
    </div>` : ''}
  </div>`;
}

function dynamicBlock(t) {
  const d = t.dynamicTp || {};
  return `<div class="stack">
    ${switchHtml({ path: 'settings.trade.dynamicTp.on', label: 'Dynamic take profit (ATR)', sub: 'Take profit at an ATR multiple of recent price movement.', checked: Boolean(d.on) })}
    ${d.on ? numberField({ path: 'settings.trade.dynamicTp.atrMultiple', label: 'ATR multiple', value: d.atrMultiple ?? 1.5, min: 0.1, step: 0.1 }) : ''}
  </div>`;
}

function buttonsHtml(type, enabled) {
  const dis = enabled ? '' : ' disabled';
  const up = `<button type="button" class="btn btn-buy btn-block" data-action="trade-submit" data-id="up"${dis}>${escapeHtml(type.buttons.up)}</button>`;
  if (!type.buttons.down) return up;
  const down = `<button type="button" class="btn btn-sell btn-block" data-action="trade-submit" data-id="down"${dis}>${escapeHtml(type.buttons.down)}</button>`;
  return `<div class="grid-2">${up}${down}</div>`;
}

function quoteErrorText(err) {
  if (err?.limits) return `Stake must be between ${err.limits.min} and ${err.limits.max}.`;
  return String(err?.message || 'Quote failed.');
}

function quoteRows(type) {
  const sides = type.buttons.down ? ['up', 'down'] : ['up'];
  return sides.map((side) => {
    const label = escapeHtml(type.buttons[side]);
    const cls = side === 'up' ? 'buy-text' : 'sell-text';
    const q = quotes[side];
    if (!q) return `<div class="row"><span class="${cls}">${label}</span><span class="muted small">Waiting for quote</span></div>`;
    if (q.error) return `<div class="row"><span class="${cls}">${label}</span><span class="small">${escapeHtml(q.error)}</span></div>`;
    const x = q.quote;
    return `<div class="card">
      <div class="row"><span class="${cls}">${label}</span><span class="mono">Ask ${escapeHtml(fmtMoney(x.askPrice, x.currency || 'USD'))}</span><span class="mono">Payout ${escapeHtml(fmtMoney(x.payout, x.currency || 'USD'))}</span></div>
      <div class="small muted">${escapeHtml(x.longcode || type.description)}</div>
    </div>`;
  }).join('');
}

// The live region: notices, quotes and the buttons. Refreshed on every value change.
function liveHtml(t) {
  const type = typeFor(t);
  const connected = deriv.isAuthed();
  const issues = blockers(t);
  const ready = connected && issues.length === 0;
  let notice = '';
  if (!connected) notice = '<div class="notice warn">Not connected. Open Connect in the header to trade. Quotes need a connected account.</div>';
  else notice = issues.map((x) => `<div class="notice warn">${escapeHtml(x)}</div>`).join('');
  const rows = ready ? quoteRows(type) : '';
  return `${notice}${rows}<div class="stack">${buttonsHtml(type, ready)}</div>`;
}

function renderLive() {
  renderInto('trade-live', liveHtml(trade()));
}

function renderTicket() {
  const t = trade();
  renderedKey = structureKey(t);
  const family = familyOf(t);
  const symbolLine = t.family === 'basket' ? '' : `<div class="small muted">Symbol <span class="mono">${escapeHtml(t.symbol)}</span>. Change it on the chart.</div>`;
  const html = `<div class="card stack">
    <div class="segmented" role="group" aria-label="Trade family">${familyButtons(t.family)}</div>
    <div class="muted small">${escapeHtml(family.hint)}</div>
    ${symbolLine}
    ${warnings(t).map((w) => `<div class="notice warn">${escapeHtml(w)}</div>`).join('')}
    <div class="stack">${formFields(t, typeFor(t))}</div>
    ${ORDER_FAMILIES.has(t.family) ? orderBlock(t) : ''}
    ${STOP_FAMILIES.has(t.family) ? trailingBlock(t) : ''}
    ${DYNAMIC_TP_FAMILIES.has(t.family) ? dynamicBlock(t) : ''}
    <div id="trade-live" class="stack"></div>
  </div>`;
  renderInto('trade-form', html);
  renderLive();
}

function stopStreams() {
  for (const s of streams) { try { s.stop(); } catch (_) { /* already closed */ } }
  streams = [];
}

// Restart the live quote streams for the current ticket. Called on a 300 ms debounce.
function restartQuotes() {
  const seq = ++streamSeq;
  stopStreams();
  quotes = { up: null, down: null };
  const t = trade();
  if (!deriv.isAuthed() || blockers(t).length) { renderLive(); return; }
  const type = typeFor(t);
  const sides = type.buttons.down ? ['up', 'down'] : ['up'];
  for (const side of sides) {
    const params = buildInput(t, side);
    deriv.streamQuote(params, (msg) => {
      if (seq !== streamSeq) return;
      quotes[side] = msg?.error ? { error: quoteErrorText(msg.error) } : { quote: msg };
      renderLive();
    }).then((s) => {
      if (seq !== streamSeq) s.stop(); else streams.push(s);
    }).catch((err) => {
      if (seq !== streamSeq) return;
      quotes[side] = { error: quoteErrorText(err) };
      renderLive();
    });
  }
  renderLive();
}

const debouncedRestart = debounce(restartQuotes, QUOTE_DEBOUNCE_MS);

function refreshKeyed() {
  const key = structureKey(trade());
  if (key !== renderedKey) renderTicket();
  else renderLive();
  debouncedRestart();
}

// Stop loss / take profit / volume values are typed by the user. The switches are separate settings.
function placeVirtual(t, input) {
  const ot = orderTypeOf(t);
  const num = (k) => toNumber(t[k], null);
  const base = { symbol: t.symbol, triggerPrice: num('triggerPrice'), limitPrice: num('limitPrice'), trailDistance: num('trailDistance') };
  if (ot === 'oco') {
    const group = uid('oco');
    pending.add({ ...base, type: 'stop', side: 'up', limitPrice: null, ocoGroup: group, input: { ...input, side: 'up' } });
    pending.add({ ...base, type: 'stop', side: 'down', triggerPrice: base.limitPrice, limitPrice: null, ocoGroup: group, input: { ...input, side: 'down' } });
    return;
  }
  pending.add({ ...base, type: ot, side: input.side, input });
}

// Submit a Manual trade (or arm a virtual order). side is 'up' or 'down'.
export async function submit(side) {
  const t = trade();
  if (!deriv.isAuthed()) { toast('warn', 'Connect to Deriv before trading.'); return; }
  const issues = blockers(t);
  if (issues.length) { toast('warn', issues[0]); return; }
  const input = buildInput(t, side);
  try {
    if (VIRTUAL_NEEDS[orderTypeOf(t)]) {
      placeVirtual(t, input);
      toast('ok', 'Virtual order armed. Krabby fires it while open.');
    } else {
      await trader.buy(input);
      toast('ok', 'Trade placed.');
    }
  } catch (err) {
    toast('error', err?.message || 'Trade failed.');
  }
}

function chooseFamily(family) {
  const first = TRADE_TYPES.find((x) => x.family === family);
  if (!first) return;
  store.set('settings.trade.family', family);
  store.set('settings.trade.typeId', first.id);
}

// When the type changes, its own defaults (duration, barriers, digit) replace the old ones.
function applyTypeDefaults() {
  const type = typeFor(trade());
  if (type.params.includes('duration') && type.duration) store.set('settings.trade.duration', { ...type.duration });
  if (type.params.includes('barrier') && type.barrier) store.set('settings.trade.barrier', type.barrier);
  if (type.params.includes('barrier2') && type.barrier2) store.set('settings.trade.barrier2', type.barrier2);
  if (type.params.includes('digit') && type.digit !== undefined) store.set('settings.trade.digit', type.digit);
}

function stepStake(dir) {
  const t = trade();
  const min = deriv.minStake(currencyOf(t));
  const next = round(Math.max(min, toNumber(t.stake, 0) + dir), 2);
  store.set('settings.trade.stake', next);
  renderTicket();
}

async function loadContracts(symbol) {
  if (!symbol || contractsCache.symbol === symbol) return;
  contractsCache = { symbol, info: null };
  try {
    const info = await deriv.getContracts(symbol);
    if (trade().symbol !== symbol) return;
    contractsCache = { symbol, info };
    refreshKeyed();
  } catch (_) {
    // Contract limits are optional. The ticket keeps the config defaults and the quote reports real errors.
  }
}

function isTradePath(path) {
  return path === 'settings' || path === 'import' || path.startsWith('settings.trade') || path === 'settings.orders' || path === 'settings.ui.symbol';
}

function onStore({ path }) {
  if (!path || !isTradePath(path)) return;
  if (path === 'settings.trade.typeId') applyTypeDefaults();
  if (path === 'settings.ui.symbol' && trade().family !== 'basket') store.set('settings.trade.symbol', store.get('settings.ui.symbol'));
  if (path === 'settings.trade.symbol' || path === 'settings' || path === 'import') loadContracts(trade().symbol);
  refreshKeyed();
}

function onMarkets(payload) {
  if (Array.isArray(payload?.symbols)) markets = payload.symbols;
  refreshKeyed();
}

export function initTrade() {
  const root = document.getElementById('trade-form');
  if (!root) return;
  bindPaths(root);
  bindActions(root, {
    'trade-family': (el) => chooseFamily(el.dataset.id),
    'trade-submit': (el) => submit(el.dataset.id),
    'trade-step': (el) => stepStake(Number(el.dataset.arg)),
  });
  window.__krabbyTrade = { submit };
  bus.on(EVENTS.STORE, onStore);
  bus.on(EVENTS.MARKETS, onMarkets);
  bus.on(EVENTS.ACCOUNT, refreshKeyed);
  bus.on(EVENTS.DERIV_STATUS, refreshKeyed);
  deriv.getMarkets().then((list) => { markets = Array.isArray(list) ? list : []; refreshKeyed(); }).catch(() => {});
  const t = trade();
  if (t.family !== 'basket' && store.get('settings.ui.symbol') && store.get('settings.ui.symbol') !== t.symbol) {
    store.set('settings.trade.symbol', store.get('settings.ui.symbol'));
  }
  loadContracts(trade().symbol);
  renderTicket();
  debouncedRestart();
}
