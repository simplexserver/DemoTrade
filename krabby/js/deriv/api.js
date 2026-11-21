// Deriv API layer. Pure helpers first (no DOM, network or storage at import, so Node tests can load them),
// then the `deriv` singleton: accounts, validation, market data, quotes, trades and streams.
import { ENDPOINTS, EVENTS, TRADE_TYPES, TRADE_TYPE_BY_ID, DEFAULT_MULTIPLIERS, DEFAULT_GROWTH_RATES } from '../config.js';
import { bus } from '../core/bus.js';
import { dailyBalances, store } from '../core/store.js';
import { parseStakeLimits, toNumber, utcDayKey } from '../core/util.js';
import { DerivError, DerivSocket } from './connection.js';

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };
// Synthetic indices tick about every 2 seconds. Forex and other ticks vary, so tick horizons are estimates.
const SECONDS_PER_TICK = 2;

const isMultiplierCode = (code) => typeof code === 'string' && code.startsWith('MULT');

// Duration from {value, unit} or from a plain value plus input.durationUnit.
function durationOf(input) {
  const d = input.duration && typeof input.duration === 'object'
    ? input.duration
    : { value: input.duration, unit: input.durationUnit };
  return { value: toNumber(d.value, NaN), unit: d.unit || null };
}

// Builds the body of a `proposal` call (without proposal:1 or subscribe). Pure and unit-tested.
// input: {typeId, symbol, side:'up'|'down', stake, duration?, barrier?, barrier2?, digit?, multiplier?, growth?,
//         sl?, tp?, cancellation?, currency?, fallback? (basket: use TRADE_TYPE.fallbackContracts)}.
// mode 'new' sends underlying_symbol, mode 'legacy' sends symbol.
export function buildProposalParams(input = {}, mode = 'new') {
  const type = TRADE_TYPE_BY_ID[input.typeId];
  if (!type) throw new DerivError(`Unknown trade type: ${input.typeId}`, { code: 'InputValidationFailed' });
  if (input.side !== 'up' && input.side !== 'down') throw new DerivError('Side must be up or down.', { code: 'InputValidationFailed' });
  const codes = input.fallback && type.fallbackContracts ? type.fallbackContracts : type.contracts;
  const contractType = codes[input.side];
  if (!contractType) throw new DerivError(`${type.label} has no ${input.side} side.`, { code: 'InputValidationFailed' });
  const stake = toNumber(input.stake, NaN);
  if (!Number.isFinite(stake) || stake <= 0) throw new DerivError('Stake must be a positive number.', { code: 'InputValidationFailed' });
  if (!input.symbol) throw new DerivError('Symbol is required.', { code: 'InputValidationFailed' });

  const multi = isMultiplierCode(contractType);
  const accu = contractType === 'ACCU';
  const params = {
    amount: stake,
    basis: 'stake',
    contract_type: contractType,
    currency: input.currency || 'USD',
    [mode === 'legacy' ? 'symbol' : 'underlying_symbol']: input.symbol,
  };

  // Options take a duration. Fixed-tick types (High/Low Tick, params []) always use their configured 5 ticks.
  if (!multi && !accu) {
    const fixed = type.family === 'options' && !type.params.includes('duration') && type.duration;
    const d = fixed ? type.duration : durationOf(input);
    if (!Number.isFinite(d.value) || !d.unit) throw new DerivError('Duration is required.', { code: 'InputValidationFailed' });
    params.duration = d.value;
    params.duration_unit = d.unit;
  }

  // Digit types use the digit as their barrier. Higher/Lower style types use the barrier string.
  if (type.params.includes('digit')) {
    params.barrier = String(input.digit ?? type.digit);
  } else if (type.params.includes('barrier')) {
    params.barrier = String(input.barrier ?? type.barrier);
  }
  if (type.params.includes('barrier2')) params.barrier2 = String(input.barrier2 ?? type.barrier2);

  if (multi) {
    const multiplier = toNumber(input.multiplier, NaN);
    if (!Number.isFinite(multiplier) || multiplier <= 0) throw new DerivError('Multiplier is required.', { code: 'InputValidationFailed' });
    params.multiplier = multiplier;
  }
  if (accu) {
    const growth = toNumber(input.growth, NaN);
    if (!Number.isFinite(growth) || growth <= 0) throw new DerivError('Growth rate is required.', { code: 'InputValidationFailed' });
    params.growth_rate = growth / 100;
  }

  // Multipliers take stop loss and take profit. Accumulators take take profit only.
  if (multi || accu) {
    const limit = {};
    const tp = toNumber(input.tp, NaN);
    const sl = toNumber(input.sl, NaN);
    if (Number.isFinite(tp) && tp > 0) limit.take_profit = tp;
    if (!accu && Number.isFinite(sl) && sl > 0) limit.stop_loss = sl;
    if (Object.keys(limit).length) params.limit_order = limit;
  }

  if (input.cancellation) params.cancellation = String(input.cancellation);
  return params;
}

// Deriv minimum-duration strings look like '5t', '60s', '1d'. Returns the unit letter or null.
function unitOf(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/([a-z])$/i);
  return m ? m[1].toLowerCase() : null;
}

function contractTypeEntry(a) {
  const min = a.min_contract_duration ?? null;
  const max = a.max_contract_duration ?? null;
  return {
    contractType: a.contract_type,
    minDuration: min,
    maxDuration: max,
    durationUnit: unitOf(min) ?? unitOf(max),
    barriers: a.barriers ?? null,
    multiplierRange: a.multiplier_range ?? null,
    growthRateRange: a.growth_rate_range ?? null,
    raw: a,
  };
}

// Config defaults, used only when Deriv returns no contracts_for list. Marked verified:false by the caller.
function fallbackContractTypes() {
  const seen = new Map();
  const add = (code) => {
    if (!code || seen.has(code)) return;
    const multi = isMultiplierCode(code);
    const range = (list) => [Math.min(...list), Math.max(...list)];
    seen.set(code, {
      contractType: code,
      minDuration: null,
      maxDuration: null,
      durationUnit: null,
      barriers: null,
      multiplierRange: multi ? range(DEFAULT_MULTIPLIERS) : null,
      growthRateRange: code === 'ACCU' ? range(DEFAULT_GROWTH_RATES).map((g) => g / 100) : null,
      raw: null,
    });
  };
  for (const t of TRADE_TYPES) {
    Object.values(t.contracts).forEach(add);
    Object.values(t.fallbackContracts || {}).forEach(add);
  }
  return [...seen.values()];
}

// Parses a contracts_for reply (the whole message or its contracts_for body) into the ContractsInfo shape.
export function normaliseContracts(raw, symbol) {
  const body = raw && raw.contracts_for ? raw.contracts_for : raw || {};
  const available = Array.isArray(body.available) ? body.available : [];
  if (!available.length) return { symbol, verified: false, types: fallbackContractTypes() };
  return { symbol, verified: true, types: available.map(contractTypeEntry) };
}

// Parses one active_symbols entry into the Market shape. pip falls back to 0.01 when Deriv omits it.
export function normaliseMarket(raw = {}) {
  return {
    symbol: raw.symbol,
    name: raw.display_name || raw.symbol,
    market: raw.market || '',
    submarket: raw.submarket || '',
    type: raw.symbol_type || '',
    pipSize: toNumber(raw.pip, 0.01),
    isOpen: Boolean(raw.exchange_is_open),
    isSuspended: Boolean(raw.is_trading_suspended),
  };
}

// Candle shape from a candles entry or an ohlc live update (open_time is the fallback epoch).
export function normaliseCandle(raw = {}) {
  return {
    epoch: toNumber(raw.epoch ?? raw.open_time, NaN),
    open: toNumber(raw.open, NaN),
    high: toNumber(raw.high, NaN),
    low: toNumber(raw.low, NaN),
    close: toNumber(raw.close, NaN),
  };
}

// Open-contract shape from a proposal_open_contract object (or the whole message that carries it).
export function normalisePoc(raw = {}) {
  const p = raw.proposal_open_contract || raw;
  const isSold = Boolean(p.is_sold);
  return {
    contractId: p.contract_id ?? null,
    buyPrice: toNumber(p.buy_price, NaN),
    bidPrice: toNumber(p.bid_price, NaN),
    currentSpot: toNumber(p.current_spot, NaN),
    entrySpot: toNumber(p.entry_spot, NaN),
    profit: toNumber(p.profit, NaN),
    payout: toNumber(p.payout, NaN),
    isSold,
    status: p.status || (isSold ? 'sold' : 'open'),
    dateExpiry: toNumber(p.date_expiry, NaN),
    sellPrice: toNumber(p.sell_price, NaN),
    longcode: p.longcode || '',
    currency: p.currency || 'USD',
  };
}

// Quote shape from a proposal reply. Deriv does not echo the currency, so the caller passes it.
export function normaliseQuote(raw = {}, currency = 'USD') {
  const p = raw.proposal || raw;
  return {
    id: p.id ?? null,
    askPrice: toNumber(p.ask_price, NaN),
    payout: toNumber(p.payout, NaN),
    spot: toNumber(p.spot, NaN),
    longcode: p.longcode || '',
    displayValue: p.display_value ?? null,
    currency,
    raw: p,
  };
}

// Account type from account_type, then type, then is_virtual. Unknown stays 'unknown' and counts as real,
// so the real-money lock applies when Deriv's reply is unclear.
function accountTypeOf(raw) {
  const t = String(raw.account_type ?? raw.type ?? '').toLowerCase();
  if (t === 'demo' || t === 'real') return t;
  if (raw.is_virtual !== undefined && raw.is_virtual !== null) return raw.is_virtual ? 'demo' : 'real';
  return 'unknown';
}

function parseAccount(raw) {
  const accountId = raw.account_id ?? raw.accountId ?? raw.id ?? raw.loginid ?? null;
  const loginid = raw.loginid ?? accountId;
  const type = accountTypeOf(raw);
  return {
    accountId: accountId == null ? null : String(accountId),
    loginid: loginid == null ? null : String(loginid),
    type,
    isVirtual: type === 'demo',
    currency: raw.currency || 'USD',
    balance: toNumber(raw.balance, NaN),
    raw,
  };
}

// Accounts from the REST reply {data: [...]} or a bare array. Every entry keeps raw for diagnostics.
export function parseAccounts(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : [];
  return list.filter((x) => x && typeof x === 'object').map(parseAccount);
}

// Candles covering a contract's duration, rounded and at least 1. Used to size the edge-gate backtest horizon.
export function estimateHorizonCandles(duration, granularity) {
  const gran = toNumber(granularity, NaN);
  const value = toNumber(duration && duration.value, NaN);
  const unit = duration && duration.unit;
  if (!Number.isFinite(gran) || gran <= 0 || !Number.isFinite(value) || value <= 0) return 1;
  const seconds = unit === 't' ? value * SECONDS_PER_TICK : value * (UNIT_SECONDS[unit] || 0);
  if (!seconds) return 1;
  return Math.max(1, Math.round(seconds / gran));
}

// ---------- Deriv singleton: helpers shared by the methods below ----------

const ACCOUNTS_PATH = '/trading/v1/options/accounts';
const MARKET_TTL_MS = 10 * 60 * 1000;
const CONTRACT_TTL_MS = 10 * 60 * 1000;
const CANDLE_COUNT = 500;
const DEFAULT_MIN_STAKE = 0.35;

const safeCall = (fn, arg) => {
  try { fn(arg); } catch (err) { console.error('[deriv] handler failed', err && err.message); }
};

// One diagnostic step. Emitted as DIAG_STEP and returned so callers can keep a list.
const diagStep = (step, ok, message, detail) => {
  const d = { step, ok, message, detail };
  bus.emit(EVENTS.DIAG_STEP, d);
  return d;
};

const validCandle = (c) => Number.isFinite(c.epoch) && Number.isFinite(c.open) && Number.isFinite(c.high)
  && Number.isFinite(c.low) && Number.isFinite(c.close);

// Candles sorted by time, one per epoch (the later copy wins). Rows that do not parse are dropped.
export function cleanCandles(list) {
  const byEpoch = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const c = normaliseCandle(raw);
    if (validCandle(c)) byEpoch.set(c.epoch, c);
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

// Hint text for a failed REST call. Written for the person, not for Deriv's code names.
function restHint(code, message) {
  if (/InvalidToken|AuthorizationRequired|^HTTP40[13]$/.test(code)) {
    return 'Deriv rejected this token. Create a new Personal Access Token with the trade scope for your app id, then paste it again.';
  }
  return message;
}

// REST call with Bearer auth and the app id header. Fetch failures become a readable DerivError.
async function restCall(method, url, token, appId) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Deriv-App-ID': String(appId), Accept: 'application/json' },
    });
  } catch (err) {
    const host = new URL(url).host;
    throw new DerivError(`The browser could not reach ${host}. Check your connection, or switch to Legacy mode. (${err && err.message ? err.message : 'network error'})`, { code: 'NetworkError' });
  }
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (!res.ok) {
    const e = (body && (body.error || (Array.isArray(body.errors) ? body.errors[0] : null))) || {};
    const code = String(e.code || `HTTP${res.status}`);
    throw new DerivError(restHint(code, e.message || `Deriv answered HTTP ${res.status}.`), { code, details: e.details, raw: body });
  }
  return body;
}

// Accounts from a legacy authorize reply: account_list when present, otherwise the logged-in account.
function legacyAccounts(auth = {}) {
  const list = Array.isArray(auth.account_list) && auth.account_list.length ? auth.account_list : [auth];
  return list.filter((a) => a && a.loginid).map((a) => {
    const isVirtual = Number(a.is_virtual) === 1 || a.is_virtual === true;
    const own = a.loginid === auth.loginid;
    return {
      accountId: String(a.loginid),
      loginid: String(a.loginid),
      type: isVirtual ? 'demo' : 'real',
      isVirtual,
      currency: a.currency || auth.currency || 'USD',
      balance: toNumber(a.balance ?? (own ? auth.balance : undefined), NaN),
      raw: a,
    };
  });
}

// Demo accounts first. The account the person picked wins when it is in the list.
function pickAccount(list, wanted) {
  if (wanted) {
    const hit = list.find((a) => a.accountId === String(wanted));
    if (hit) return hit;
  }
  return list.find((a) => a.isVirtual) || list[0];
}

const candlesRequest = (symbol, granularity, count) => ({
  ticks_history: symbol,
  style: 'candles',
  granularity: Number(granularity),
  count: Number(count) || CANDLE_COUNT,
  end: 'latest',
  adjust_start_time: 1,
});

// One Deriv subscription that is sent again after its socket reconnects. kind: 'public' | 'auth'.
class Feed {
  constructor(api, kind, payload, handler) {
    this.api = api;
    this.kind = kind;
    this.payload = payload;
    this.handler = handler;
    this.sub = null;
    this.stopped = false;
  }

  async start() {
    const sock = this.kind === 'auth' ? this.api._requireAuth() : await this.api.ensurePublic();
    const sub = await sock.subscribe(this.payload, this.handler);
    this.sub = sub;
    if (this.stopped) sub.stop();
    return sub;
  }

  stop() {
    this.stopped = true;
    this.api._feeds.delete(this);
    if (this.sub) this.sub.stop();
    this.sub = null;
  }
}

// Process functions turn raw messages into events. hub.replay is what a handler joining later receives at once.
function tickProcess(msg, hub) {
  const t = msg.tick;
  if (!t) return null;
  const event = { symbol: t.symbol, quote: toNumber(t.quote, NaN), epoch: toNumber(t.epoch, NaN), pipSize: toNumber(t.pip_size, NaN) };
  if (!Number.isFinite(event.quote)) return null;
  hub.replay = event;
  bus.emit(EVENTS.TICK, event);
  return event;
}

function candleProcess(msg, hub) {
  if (Array.isArray(msg.candles)) {
    hub.candles = cleanCandles(msg.candles);
    hub.replay = { type: 'history', candles: hub.candles };
    return hub.replay;
  }
  if (msg.msg_type === 'ohlc' && msg.ohlc && hub.candles) {
    const c = normaliseCandle({ ...msg.ohlc, epoch: msg.ohlc.open_time ?? msg.ohlc.epoch });
    if (!validCandle(c)) return null;
    const list = hub.candles;
    const last = list[list.length - 1];
    if (!last || c.epoch > last.epoch) {
      list.push(c);
      return { type: 'live', candle: c, isNew: true };
    }
    if (c.epoch === last.epoch) {
      list[list.length - 1] = c;
      return { type: 'live', candle: c, isNew: false };
    }
  }
  return null;
}

function balanceProcess(msg, hub) {
  const b = msg.balance;
  if (!b || typeof b !== 'object') return null;
  const event = { balance: toNumber(b.balance, NaN), currency: b.currency || 'USD', loginid: b.loginid || null };
  hub.replay = event;
  return event;
}

function pocProcess(msg, hub) {
  const raw = msg.proposal_open_contract;
  if (!raw) return null;
  const event = normalisePoc(raw);
  hub.replay = event;
  return event;
}

// ---------- Deriv singleton: sessions, validation and sockets ----------

const accountsUrl = () => `${ENDPOINTS.newApiBase}${ACCOUNTS_PATH}`;

export const deriv = {
  state: 'idle',           // 'idle' | 'validating' | 'connecting' | 'ok' | 'reconnecting' | 'error'
  account: null,           // {loginid, accountId, currency, isVirtual, type, balance} while connected
  stakeMin: DEFAULT_MIN_STAKE,
  diagnostics: [],         // steps of the last connect attempt
  _session: null,          // {mode, appId, token, accountId} while connected. The token stays in memory only.
  _auth: null,             // authorised DerivSocket
  _pub: null,              // market-data DerivSocket (no login needed)
  _pubUrl: null,
  _feeds: new Set(),
  _hubs: new Map(),
  _markets: null,
  _marketsAt: 0,
  _contracts: new Map(),
  _wired: false,
  _connecting: false,

  get mode() {
    return store.get('settings.conn.mode') === 'legacy' ? 'legacy' : 'new';
  },

  isAuthed() {
    return Boolean(this._auth && this._auth.isOpen && this.account);
  },

  minStake() {
    return this.stakeMin || DEFAULT_MIN_STAKE;
  },

  _setState(state, message) {
    this.state = state;
    bus.emit(EVENTS.DERIV_STATUS, { state, message });
  },

  _publicUrl(mode = this.mode) {
    if (mode === 'legacy') {
      const id = store.get('settings.conn.legacyAppId') || ENDPOINTS.legacyDefaultAppId;
      return `${ENDPOINTS.legacyWs}?app_id=${encodeURIComponent(id)}`;
    }
    return ENDPOINTS.newPublicWs;
  },

  _publicSocket() {
    const url = this._publicUrl();
    if (!this._pub || this._pubUrl !== url) {
      if (this._pub) this._pub.close('settings changed');
      this._pubUrl = url;
      this._pub = new DerivSocket({ name: 'public', label: 'market data', url });
      this._pub.onReconnected = async () => this._restartFeeds('public');
    }
    return this._pub;
  },

  // Opens the market-data socket when needed. Safe to call from many places at once.
  async ensurePublic() {
    const sock = this._publicSocket();
    if (!sock.isOpen) await sock.open();
    return sock;
  },

  _requireAuth() {
    if (!this.isAuthed()) throw new DerivError('Connect to your Deriv account first.', { code: 'NotConnected' });
    return this._auth;
  },

  // Stops every feed of one socket kind and forgets its shared streams.
  _dropFeeds(kind) {
    for (const f of [...this._feeds]) if (f.kind === kind) f.stop();
    for (const [key, hub] of [...this._hubs]) if (hub.feed.kind === kind) this._hubs.delete(key);
  },

  // Sends every live feed of a socket kind again after that socket reconnects.
  _restartFeeds(kind) {
    for (const f of [...this._feeds]) {
      if (f.kind !== kind || f.stopped) continue;
      f.sub = null;
      f.start().catch((err) => bus.emit(EVENTS.TOAST, { kind: 'warn', message: `A live feed could not resume: ${err.message}` }));
    }
  },

  // Shared subscription: one Deriv stream per key, many handlers. Resolves with {stop()}.
  async _shared(kind, key, payload, process, handler) {
    let hub = this._hubs.get(key);
    if (!hub) {
      hub = { feed: null, handlers: new Set(), replay: null, candles: null, ready: null };
      const dispatch = (msg) => {
        const event = process(msg, hub);
        if (!event) return;
        for (const fn of [...hub.handlers]) safeCall(fn, event);
      };
      hub.feed = new Feed(this, kind, payload, dispatch);
      this._feeds.add(hub.feed);
      this._hubs.set(key, hub);
      hub.ready = hub.feed.start().catch((err) => {
        if (this._hubs.get(key) === hub) this._hubs.delete(key);
        this._feeds.delete(hub.feed);
        throw err;
      });
    }
    await hub.ready;
    hub.handlers.add(handler);
    if (hub.replay) safeCall(handler, hub.replay);
    return {
      stop: () => {
        hub.handlers.delete(handler);
        if (hub.handlers.size === 0 && this._hubs.get(key) === hub) {
          this._hubs.delete(key);
          hub.feed.stop();
        }
      },
    };
  },

  // Listens once to socket status and maps the authorised socket onto the app status dot.
  _wireStatus() {
    if (this._wired) return;
    this._wired = true;
    bus.on('conn:status', (ev) => {
      if (!this._session || this._connecting || ev.socket !== 'auth') return;
      if (ev.status === 'open') this._setState('ok', ev.message);
      else if (ev.status === 'connecting') this._setState('connecting', ev.message);
      else if (ev.status === 'closed') this._setState('reconnecting', ev.message);
      else if (ev.status === 'error') this._setState('error', ev.message);
    });
  },

  // Connection address for the authorised socket. New API: a fresh single-use OTP each time. Legacy: a fixed address.
  async _authUrl() {
    const s = this._session;
    if (!s) throw new DerivError('Not connected.', { code: 'NotConnected' });
    if (s.mode === 'legacy') return `${ENDPOINTS.legacyWs}?app_id=${encodeURIComponent(s.appId)}`;
    const body = await restCall('POST', `${accountsUrl()}/${encodeURIComponent(s.accountId)}/otp`, s.token, s.appId);
    const url = body && body.data && body.data.url;
    if (!url) throw new DerivError('Deriv did not return a connection link (OTP).', { code: 'NoOtp' });
    return url;
  },

  async _openAuth() {
    this._auth = new DerivSocket({ name: 'auth', label: 'your account', getUrl: () => this._authUrl() });
    this._auth.onReconnected = async () => {
      if (!this._session) return;
      if (this._session.mode === 'legacy') await this._authorise();
      this._restartFeeds('auth');
      this._setState('ok', 'Reconnected to Deriv.');
    };
    await this._auth.open();
  },

  // Legacy login: sends {authorize: token}. The token is never echoed back (see connection.js redact).
  async _authorise() {
    const resp = await this._auth.send({ authorize: this._session.token });
    const a = resp.authorize || {};
    const isVirtual = Number(a.is_virtual) === 1 || a.is_virtual === true;
    this.account = {
      loginid: String(a.loginid || ''),
      accountId: String(a.loginid || ''),
      currency: a.currency || 'USD',
      isVirtual,
      type: isVirtual ? 'demo' : 'real',
      balance: toNumber(a.balance, NaN),
    };
    return this.account;
  },

  async _startBalance() {
    return this._shared('auth', 'balance', { balance: 1, subscribe: 1 }, balanceProcess, (ev) => this._onBalance(ev));
  },

  _onBalance(ev) {
    if (!Number.isFinite(ev.balance)) return;
    if (this.account) this.account.balance = ev.balance;
    const loginid = this.account ? this.account.loginid : ev.loginid;
    if (loginid) dailyBalances.setIfMissing(loginid, utcDayKey(), ev.balance);
    bus.emit(EVENTS.BALANCE, { balance: ev.balance, currency: ev.currency });
    if (this.account) bus.emit(EVENTS.ACCOUNT, { ...this.account, currency: ev.currency || this.account.currency });
  },

  // Checks a token without keeping a session. Opens and closes its own sockets. Never throws.
  async validate({ mode = 'new', appId = '', token = '' } = {}) {
    const diagnostics = [];
    const step = (name, ok, message, detail) => { diagnostics.push(diagStep(name, ok, message, detail)); };
    const m = mode === 'legacy' ? 'legacy' : 'new';
    const app = String(appId || (m === 'legacy' ? ENDPOINTS.legacyDefaultAppId : '')).trim();
    const tok = String(token || '').trim();
    if (!tok) {
      step('input', false, 'Paste your token.');
      return { ok: false, message: 'Paste your token.', accounts: [], diagnostics };
    }
    if (!app) {
      step('input', false, 'Enter your app id.');
      return { ok: false, message: 'Enter your app id.', accounts: [], diagnostics };
    }
    step('input', true, 'Token and app id are present.');
    try {
      if (m === 'new') {
        const body = await restCall('GET', accountsUrl(), tok, app);
        const accounts = parseAccounts(body);
        if (!accounts.length) {
          const message = 'Deriv returned no accounts for this token. Check the Personal Access Token scopes and the app id.';
          step('accounts', false, message, { raw: body });
          return { ok: false, message, accounts, diagnostics };
        }
        step('accounts', true, `${accounts.length} account(s) found.`);
        const probe = new DerivSocket({ name: 'probe', url: ENDPOINTS.newPublicWs, label: 'market data' });
        try {
          await probe.open();
          await probe.send({ ping: 1 });
          step('market', true, 'Market data socket answered.');
        } finally {
          probe.close('validation finished');
        }
        return { ok: true, message: `Token works. ${accounts.length} account(s) found.`, accounts, diagnostics };
      }
      const probe = new DerivSocket({ name: 'probe', url: `${ENDPOINTS.legacyWs}?app_id=${encodeURIComponent(app)}`, label: 'Deriv' });
      try {
        await probe.open();
        step('socket', true, 'Socket open.');
        const resp = await probe.send({ authorize: tok });
        const accounts = legacyAccounts(resp.authorize || {});
        step('authorize', true, `Authorised as ${(resp.authorize && resp.authorize.loginid) || 'an account'}.`);
        return { ok: true, message: `Token works. ${accounts.length} account(s) found.`, accounts, diagnostics };
      } finally {
        probe.close('validation finished');
      }
    } catch (err) {
      const message = err && err.message ? err.message : 'Validation failed.';
      step(m === 'new' ? 'accounts' : 'authorize', false, message, { code: err && err.code });
      return { ok: false, message, accounts: [], diagnostics };
    }
  },

  // Opens the authorised session. Demo accounts are chosen by default. Real accounts are visible but trading stays locked until allowed.
  async connect({ mode = 'new', appId = '', token = '', accountId = null } = {}) {
    const m = mode === 'legacy' ? 'legacy' : 'new';
    const app = String(appId || (m === 'legacy' ? ENDPOINTS.legacyDefaultAppId : '')).trim();
    const tok = String(token || '').trim();
    this.diagnostics = [];
    const ok = (step, message) => { this.diagnostics.push(diagStep(step, true, message)); };
    this._wireStatus();
    this._connecting = true;
    this._setState('connecting', 'Connecting to Deriv');
    try {
      if (!tok) throw new DerivError('Paste your token first.', { code: 'NoToken' });
      if (!app) throw new DerivError('Enter your app id first.', { code: 'NoAppId' });
      ok('input', 'Token and app id are present.');
      await this.disconnect('switching', { quiet: true });
      store.patch('settings.conn', m === 'legacy' ? { mode: m, legacyAppId: app } : { mode: m });
      if (this._pubUrl && this._pubUrl !== this._publicUrl(m)) this._dropFeeds('public');
      this._session = { mode: m, appId: app, token: tok, accountId: accountId ? String(accountId) : null };

      let account;
      if (m === 'new') {
        const body = await restCall('GET', accountsUrl(), tok, app);
        const list = parseAccounts(body);
        if (!list.length) throw new DerivError('Deriv returned no accounts for this token. Check the Personal Access Token scopes and the app id.', { code: 'NoAccounts', raw: body });
        const chosen = pickAccount(list, accountId);
        this._session.accountId = chosen.accountId;
        ok('accounts', `${list.length} account(s). Using ${chosen.loginid || chosen.accountId} (${chosen.type}).`);
        account = {
          loginid: chosen.loginid || chosen.accountId,
          accountId: chosen.accountId,
          currency: chosen.currency,
          isVirtual: chosen.isVirtual,
          type: chosen.type,
          balance: chosen.balance,
        };
        await this._openAuth();
        ok('socket', 'Authenticated socket open.');
      } else {
        await this._openAuth();
        ok('socket', 'Socket open.');
        account = await this._authorise();
        ok('authorize', `Logged in as ${account.loginid} (${account.type}).`);
      }
      this.account = account;
      await this._startBalance();
      ok('balance', `Balance ${Number.isFinite(account.balance) ? account.balance : 'not reported yet'} ${account.currency || ''}`.trim());
      await this.ensurePublic();
      ok('market', 'Market data socket open.');
      this._connecting = false;
      this._setState('ok', `Connected to ${account.loginid} (${account.type}).`);
      bus.emit(EVENTS.ACCOUNT, { ...account });
      return account;
    } catch (err) {
      const message = err && err.message ? err.message : 'Connection failed.';
      this.diagnostics.push(diagStep('connect', false, message, { code: err && err.code }));
      await this.disconnect('connect failed', { quiet: true });
      this._connecting = false;
      this._setState('error', message);
      throw err instanceof DerivError ? err : new DerivError(message, { code: 'ConnectFailed' });
    }
  },

  // Closes the authorised socket and forgets the session. Market data stays up. Positions are not closed.
  async disconnect(reason = 'disconnected', { quiet = false } = {}) {
    this._session = null;
    this._dropFeeds('auth');
    if (this._auth) {
      this._auth.autoReconnect = false;
      this._auth.close(reason);
      this._auth = null;
    }
    const hadAccount = Boolean(this.account);
    this.account = null;
    if (hadAccount) bus.emit(EVENTS.ACCOUNT, null);
    if (!quiet) this._setState('idle', reason);
  },

  // Active markets from active_symbols. Cached for ten minutes and announced as MARKETS.
  async getMarkets(force = false) {
    if (!force && this._markets && Date.now() - this._marketsAt < MARKET_TTL_MS) return this._markets;
    const sock = await this.ensurePublic();
    const resp = await sock.send({ active_symbols: 'brief', product_type: 'basic' });
    const list = Array.isArray(resp.active_symbols) ? resp.active_symbols.map(normaliseMarket).filter((m) => m.symbol) : [];
    this._markets = list;
    this._marketsAt = Date.now();
    bus.emit(EVENTS.MARKETS, { symbols: list });
    return list;
  },

  // Contract types and limits for one symbol. Falls back to config defaults (verified:false) when Deriv does not answer.
  async getContracts(symbol) {
    const hit = this._contracts.get(symbol);
    if (hit && Date.now() - hit.at < CONTRACT_TTL_MS) return hit.info;
    let info;
    try {
      const sock = await this.ensurePublic();
      const resp = await sock.send({ contracts_for: symbol, currency: 'USD', product_type: 'basic' });
      info = normaliseContracts(resp, symbol);
    } catch (err) {
      info = normaliseContracts({}, symbol);
      info.error = err && err.message ? err.message : 'contracts_for failed';
    }
    this._contracts.set(symbol, { at: Date.now(), info });
    return info;
  },

  // One-shot history. Returns candles sorted by time.
  async getCandles({ symbol, granularity, count = CANDLE_COUNT } = {}) {
    const sock = await this.ensurePublic();
    const resp = await sock.send(candlesRequest(symbol, granularity, count));
    return cleanCandles(resp.candles);
  },

  // Live price for one symbol. Shared between callers. Emits TICK for every update.
  streamTicks(symbol, handler) {
    return this._shared('public', `tick:${symbol}`, { ticks: symbol }, tickProcess, handler);
  },

  // Candle history, then live updates. handler({type:'history', candles}) once, then handler({type:'live', candle, isNew}).
  streamCandles(symbol, granularity, handler, count = CANDLE_COUNT) {
    const payload = { ...candlesRequest(symbol, granularity, count), subscribe: 1 };
    return this._shared('public', `candles:${symbol}:${granularity}`, payload, candleProcess, (ev) => {
      if (ev.type === 'history') {
        bus.emit(EVENTS.CANDLES, { symbol, granularity, candles: ev.candles });
        safeCall(handler, { type: 'history', candles: ev.candles.slice() });
      } else {
        bus.emit(EVENTS.CANDLE_LIVE, { symbol, granularity, candle: ev.candle, isNew: ev.isNew });
        safeCall(handler, ev);
      }
    });
  },

  // Price and payout for a set of trade inputs. Prefers the authorised socket. Stake errors carry err.limits.
  async quote(params = {}) {
    const sock = this.isAuthed() ? this._auth : await this.ensurePublic();
    const body = buildProposalParams(params, this._session ? this._session.mode : this.mode);
    try {
      const resp = await sock.send({ proposal: 1, ...body });
      return normaliseQuote(resp, body.currency);
    } catch (err) {
      const limits = parseStakeLimits(err && err.message);
      if (limits) {
        this.stakeMin = limits.min;
        err.limits = limits;
      }
      throw err;
    }
  },

  // Live quote stream for the ticket. Each update is a Quote with a fresh proposal id.
  async streamQuote(params, handler) {
    const kind = this.isAuthed() ? 'auth' : 'public';
    const body = buildProposalParams(params, this._session ? this._session.mode : this.mode);
    const feed = new Feed(this, kind, { proposal: 1, subscribe: 1, ...body }, (msg) => {
      if (msg.proposal) safeCall(handler, normaliseQuote(msg, body.currency));
    });
    this._feeds.add(feed);
    try {
      await feed.start();
    } catch (err) {
      this._feeds.delete(feed);
      const limits = parseStakeLimits(err && err.message);
      if (limits) {
        this.stakeMin = limits.min;
        err.limits = limits;
      }
      throw err;
    }
    return { stop: () => feed.stop() };
  },

  // Buys a quoted proposal. Requires the authorised socket.
  async buy(proposalId, price) {
    const sock = this._requireAuth();
    const resp = await sock.send({ buy: proposalId, price: Number(price) });
    const b = resp.buy || {};
    const balanceAfter = toNumber(b.balance_after, NaN);
    if (Number.isFinite(balanceAfter)) this._onBalance({ balance: balanceAfter, currency: this.account.currency });
    return {
      contractId: b.contract_id ?? null,
      buyPrice: toNumber(b.buy_price, NaN),
      payout: toNumber(b.payout, NaN),
      balanceAfter,
      transactionId: b.transaction_id ?? null,
      startTime: b.start_time ?? null,
      longcode: b.longcode || '',
    };
  },

  // Sells an open contract at the current bid (price 0). Requires the authorised socket.
  async sell(contractId, price = 0) {
    const sock = this._requireAuth();
    const resp = await sock.send({ sell: contractId, price: Number(price) || 0 });
    const s = resp.sell || {};
    const balanceAfter = toNumber(s.balance_after, NaN);
    if (Number.isFinite(balanceAfter)) this._onBalance({ balance: balanceAfter, currency: this.account.currency });
    return { soldFor: toNumber(s.sold_for, NaN), balanceAfter, transactionId: s.transaction_id ?? null };
  },

  // Live state of one open contract. handler receives normalisePoc() output on every update.
  streamContract(contractId, handler) {
    const payload = { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 };
    return this._shared('auth', `poc:${contractId}`, payload, pocProcess, handler);
  },

  // Full paged history from Deriv (newest first). Returns {rows, count} so the caller can page.
  async profitTable(opts = {}) {
    const o = typeof opts === 'number' ? { limit: opts } : (opts || {});
    const limit = Math.min(500, Math.max(1, Math.floor(toNumber(o.limit, 50))));
    const offset = Math.max(0, Math.floor(toNumber(o.offset, 0)));
    const resp = await this._requireAuth().send({ profit_table: 1, description: 1, sort: 'DESC', limit, offset });
    const pt = resp.profit_table || {};
    const rows = (Array.isArray(pt.transactions) ? pt.transactions : []).map((t) => ({
      contractId: t.contract_id ?? null,
      buyPrice: toNumber(t.buy_price, NaN),
      sellPrice: toNumber(t.sell_price, NaN),
      purchaseTime: toNumber(t.purchase_time, NaN),
      sellTime: toNumber(t.sell_time, NaN),
      longcode: t.longcode || '',
      shortcode: t.shortcode || '',
    }));
    return { rows, count: toNumber(pt.count, rows.length) };
  },

  // Escape hatch for a call this module does not wrap. Returns the raw reply.
  async request(payload, { auth = true } = {}) {
    const sock = auth ? this._requireAuth() : await this.ensurePublic();
    return sock.send(payload);
  },
};
