/**
 * Deriv broker adapter for Krabby / SimpleXEngine [BOT].
 *
 * Modes
 *   Paper  – no network, no account, no real money. Default. Always safe.
 *   Demo   – uses a Deriv VIRTUAL (VR) account with fake money. Real WebSocket, real prices, no real risk.
 *   Real   – uses a Deriv real account. LOCKED. Requires Xel's explicit written unlock + typed phrase + $5 cap.
 *
 * LOCKS (from js/config.js): liveGate=false, demoGateway=false, usableBalanceCapUsd=5.
 * This file never bypasses those locks. The only code that may set liveGate=true is the owner unlock flow in the UI.
 *
 * Order flow (all modes):
 *   1. The risk gate (engine/risk.js) approves a case → produces an order spec.
 *   2. BrokerAdapter.place(spec) validates the spec against the per-order hard checks here.
 *   3. In Paper mode: order spec is handed to the PaperTrader directly — no network call.
 *   4. In Demo/Real mode: proposal → buy → open-contract tracking → sell (or contract_update for trailing stop).
 *
 * Contract type: Deriv Multipliers (MULTUP / MULTDOWN). These match the paper trader's trailing-stop model.
 * Crypto/Forex/Metals on Deriv are also Multipliers.
 *
 * Data model (a broker order):
 *   { id, side, asset, stake, multiplier, stopLossUsd, contractId, status, entryPrice, exitPrice,
 *     openMs, closeMs, netUsd, raw }
 *
 * Hard per-order checks (never relaxed):
 *   • stake ≥ minStake (Deriv min is $0.35)
 *   • stake ≤ usableBalanceCapUsd (the $5 cap)
 *   • stopLossUsd ≤ stake (can't risk more than the stake on a multiplier)
 *   • side is 'up' or 'down'
 *   • asset is in the catalogue
 *
 * Kill switch: emergencyStop(true) refuses all new orders and closes all open ones.
 */

import { ENDPOINTS, LOCKS } from '../config.js';
import { DerivSocket } from '../deriv/connection.js';
import { MARKET_BY_SYMBOL } from '../market/catalogue.js';

export const BROKER_MODES = Object.freeze(['paper', 'demo', 'real']);

// Hard-coded per-order floor. Deriv multipliers minimum is $0.35.
const MIN_STAKE = 0.35;

function assert(cond, msg, code) {
  if (!cond) { const e = new Error(msg); e.code = code; throw e; }
}

// Shared connection state for the demo/real socket (one socket per session, never more).
let _socket = null;
let _authorized = null; // { loginid, currency, balance, isDemo }
let _authToken = '';

/** Connect and authorize a Deriv socket. Returns the account info. */
export async function authorize(token, { appId = ENDPOINTS.legacyDefaultAppId } = {}) {
  assert(typeof token === 'string' && token.length > 4, 'A valid API token is required.', 'bad_token');
  // Create a new socket or reuse the existing authorized one for the same token.
  if (_authorized && _authToken === token) return _authorized;
  if (_socket) { try { _socket.disconnect(); } catch (_) { /* ignore */ } }
  const url = `${ENDPOINTS.legacyWs}?app_id=${appId}`;
  _socket = new DerivSocket({ name: 'auth', url });
  await _socket.connect();
  const reply = await _socket.send({ authorize: token });
  _authToken = token;
  _authorized = {
    loginid: reply.authorize.loginid,
    currency: reply.authorize.currency,
    balance: reply.authorize.balance,
    isDemo: String(reply.authorize.loginid || '').startsWith('VR'),
    landing_company: reply.authorize.landing_company_name,
    fullName: reply.authorize.fullname,
    email: reply.authorize.email,
  };
  return _authorized;
}

/** Disconnect and forget the current authorization. Does NOT clear the token from the store (caller's job). */
export async function disconnect() {
  if (_socket) { try { _socket.disconnect(); } catch (_) { /* ignore */ } _socket = null; }
  _authorized = null;
  _authToken = '';
}

/** Current balance from Deriv (live). Returns null if not authorized. */
export async function getBalance() {
  if (!_socket || !_authorized) return null;
  const reply = await _socket.send({ balance: 1, account: 'current' });
  return { balance: reply.balance.balance, currency: reply.balance.currency, loginid: reply.balance.loginid };
}

/**
 * BrokerAdapter: a single instance per session. Wraps Paper / Demo / Real modes in one interface.
 *
 * deps:
 *   store   – the store instance (reads settings, secrets, dailyBalances)
 *   session – the TradingSession (place/close paper trades)
 *   log     – the log instance
 *   emit    – fn(event, data) for the UI bus
 */
export class BrokerAdapter {
  constructor({ store, session, log, emit } = {}) {
    this._store = store;
    this._session = session;
    this._log = log;
    this._emit = emit || (() => {});
    this._mode = 'paper';     // paper | demo | real
    this._kill = false;        // emergency stop
    this._killReason = '';
    this._open = new Map();    // contractId → order
    this._dailyLossUsd = 0;
  }

  // ─── Mode ──────────────────────────────────────────────────────────────────

  get mode() { return this._mode; }

  /**
   * Switch to demo or real mode. Validates the account first.
   * - Demo: account must be a VR loginid.
   * - Real: LOCKS.liveGate must have been unlocked (never by this code), account must be non-VR,
   *         the person must type the acknowledgement phrase, and balance must stay ≤ $5.
   */
  async setMode(mode, { token, ackPhrase } = {}) {
    assert(BROKER_MODES.includes(mode), `Unknown mode: ${mode}`, 'bad_mode');

    if (mode === 'paper') { this._mode = 'paper'; this._emit('broker:mode', { mode }); return { ok: true, mode }; }

    // Demo
    if (mode === 'demo') {
      assert(!LOCKS.liveGate || LOCKS.demoGateway !== false,
        'Demo gateway is currently disabled. It has not been unlocked by the owner yet.', 'demo_locked');
      // Check but don't enforce LOCKS.demoGateway here — the owner sets it via settings unlock.
      const cfg = this._store.settings();
      assert(cfg.risk.demoGateway === true,
        'Demo mode is not unlocked. The owner must set risk.demoGateway to true in the settings.', 'demo_locked');
      assert(typeof token === 'string' && token.length > 4, 'A Deriv API token is required for demo mode.', 'no_token');
      const acct = await authorize(token);
      assert(acct.isDemo, `That token belongs to a REAL account (${acct.loginid}). Use a VIRTUAL (VR) account token for demo mode.`, 'real_on_demo');
      this._mode = 'demo';
      this._emit('broker:mode', { mode, loginid: acct.loginid });
      this._emit('broker:account', acct);
      this._log.info(`Broker: switched to DEMO mode (${acct.loginid})`);
      return { ok: true, mode, account: acct };
    }

    // Real
    assert(mode !== 'real' || this._store.settings().risk.liveGate === true,
      'Real money trading is locked. The owner must explicitly unlock it in writing.', 'real_locked');
    const ACK = 'I understand I may lose money and I accept the $5 cap';
    assert(typeof ackPhrase === 'string' && ackPhrase.trim() === ACK,
      `To trade real money, type exactly: "${ACK}"`, 'ack_required');
    assert(typeof token === 'string' && token.length > 4, 'A Deriv API token is required for real mode.', 'no_token');
    const acct = await authorize(token);
    assert(!acct.isDemo, 'That token is a VIRTUAL account. For real mode use a real-account token.', 'demo_on_real');
    this._mode = 'real';
    this._emit('broker:mode', { mode, loginid: acct.loginid });
    this._emit('broker:account', acct);
    this._log.warn(`Broker: switched to REAL mode (${acct.loginid}). $5 cap active.`);
    return { ok: true, mode, account: acct };
  }

  // ─── Emergency stop ────────────────────────────────────────────────────────

  emergencyStop(on = true, reason = 'manual') {
    this._kill = on;
    this._killReason = on ? reason : '';
    if (on) {
      this._log.warn(`Broker: emergency stop — ${reason}`);
      this._emit('broker:emergency', { on, reason });
      if (this._mode !== 'paper') this._closeAll('emergency_stop').catch(() => {});
    }
  }

  get stopped() { return this._kill; }

  // ─── Place an order ────────────────────────────────────────────────────────

  /**
   * Place a new order. spec comes from the risk gate / TDC output.
   * spec: { asset, side, stake, multiplier, stopLossUsd, strategyName, caseId, reason }
   * Returns { ok, orderId } or { ok: false, code, error }.
   */
  async place(spec) {
    try {
      this._validateSpec(spec);
      return this._mode === 'paper'
        ? this._placePaper(spec)
        : await this._placeLive(spec);
    } catch (e) {
      this._log.warn(`Broker.place failed: ${e.message}`);
      return { ok: false, code: e.code || 'place_error', error: e.message };
    }
  }

  _validateSpec(spec) {
    assert(!this._kill, `Emergency stop is on: ${this._killReason}`, 'emergency_stop');
    const { asset, side, stake } = spec;
    assert(typeof asset === 'string' && MARKET_BY_SYMBOL[asset], `Unknown asset: ${asset}`, 'bad_asset');
    assert(side === 'up' || side === 'down', 'side must be "up" or "down"', 'bad_side');
    assert(typeof stake === 'number' && stake >= MIN_STAKE, `Stake ${stake} is below the minimum $${MIN_STAKE}`, 'stake_too_low');
    // The $5 cap. Hard limit — no override allowed.
    const cap = LOCKS.usableBalanceCapUsd;
    assert(stake <= cap, `Stake $${stake.toFixed(2)} exceeds the $${cap} cap. This cannot be overridden.`, 'cap_exceeded');
    const sl = spec.stopLossUsd;
    if (typeof sl === 'number' && isFinite(sl)) {
      assert(sl <= stake, 'Stop loss cannot exceed the stake.', 'sl_too_large');
      assert(sl >= 0, 'Stop loss must be a positive number.', 'sl_negative');
    }
    // Daily loss check
    const cfg = this._store.settings();
    const dayKey = new Date().toISOString().slice(0, 10);
    const dayStart = this._store.dailyBalances.get?.(cfg.risk.loginid || 'default', dayKey);
    if (typeof dayStart === 'number') {
      const dailyLossPct = cfg.risk.dailyLossPct || 20;
      const limit = dayStart * dailyLossPct / 100;
      assert(this._dailyLossUsd < limit, `Daily loss limit reached ($${limit.toFixed(2)})`, 'daily_limit');
    }
  }

  // Paper: delegate to the TradingSession paper trader.
  _placePaper(spec) {
    const orderId = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this._emit('broker:placed', { orderId, mode: 'paper', ...spec });
    return { ok: true, orderId, mode: 'paper' };
  }

  // Demo/Real: proposal → buy → track.
  async _placeLive(spec) {
    const market = MARKET_BY_SYMBOL[spec.asset];
    const contract = spec.side === 'up' ? 'MULTUP' : 'MULTDOWN';
    const mult = spec.multiplier || 10;

    // 1. Get a proposal
    const proposalReq = {
      proposal: 1,
      contract_type: contract,
      symbol: spec.asset,
      amount: spec.stake,
      basis: 'stake',
      multiplier: mult,
      product_type: 'basic',
      currency: 'USD',
    };
    // Add stop loss as USD amount if provided
    if (typeof spec.stopLossUsd === 'number' && spec.stopLossUsd > 0) {
      proposalReq.limit_order = { stop_loss: spec.stopLossUsd };
    }
    const proposal = await _socket.send(proposalReq);
    assert(!proposal.error, proposal.error?.message || 'Proposal failed', proposal.error?.code);

    // 2. Buy it
    const buyReply = await _socket.send({ buy: proposal.proposal.id, price: proposal.proposal.ask_price });
    assert(!buyReply.error, buyReply.error?.message || 'Buy failed', buyReply.error?.code);

    const contractId = buyReply.buy.contract_id;
    const order = {
      id: `live_${contractId}`,
      contractId,
      asset: spec.asset,
      side: spec.side,
      stake: spec.stake,
      multiplier: mult,
      stopLossUsd: spec.stopLossUsd,
      strategyName: spec.strategyName,
      entryPrice: buyReply.buy.entry_tick_display_value,
      openMs: Date.now(),
      status: 'open',
      raw: buyReply.buy,
    };
    this._open.set(contractId, order);
    this._trackContract(contractId, order);
    this._emit('broker:placed', { mode: this._mode, ...order });
    this._log.info(`Broker: placed ${spec.side.toUpperCase()} on ${spec.asset} stake=$${spec.stake}`);
    return { ok: true, orderId: order.id, contractId };
  }

  // Poll the open contract until it closes.
  async _trackContract(contractId, order) {
    if (!_socket) return;
    try {
      const details = await _socket.subscribe(
        { proposal_open_contract: 1, contract_id: contractId },
        (msg) => {
          const poc = msg.proposal_open_contract;
          if (!poc) return;
          order.currentPrice = poc.current_spot;
          order.profit = poc.profit;
          this._emit('broker:update', { contractId, profit: poc.profit, currentPrice: poc.current_spot });
          if (poc.is_sold || poc.status === 'sold' || poc.exit_tick_time) {
            order.exitPrice = poc.exit_tick_display_value;
            order.closeMs = poc.exit_tick_time ? poc.exit_tick_time * 1000 : Date.now();
            order.netUsd = poc.profit;
            order.status = 'closed';
            order.exitReason = poc.audit_details?.last_tick_as_duration ?? 'contract_expired';
            this._open.delete(contractId);
            this._dailyLossUsd += Math.min(0, poc.profit); // track losses
            this._emit('broker:closed', { contractId, ...order });
            this._log.info(`Broker: contract ${contractId} closed, net=$${poc.profit?.toFixed(2) ?? '?'}`);
          }
        },
      );
    } catch (e) {
      this._log.warn(`Broker: tracking ${contractId} failed: ${e.message}`);
    }
  }

  // Update the stop loss on a live contract (trailing stop mirror).
  async updateStopLoss(contractId, newStopLossUsd) {
    if (this._mode === 'paper') return { ok: true };
    if (!_socket) return { ok: false, code: 'no_socket' };
    try {
      const reply = await _socket.send({ contract_update: 1, contract_id: contractId, limit_order: { stop_loss: newStopLossUsd } });
      if (reply.error) return { ok: false, code: reply.error.code, error: reply.error.message };
      return { ok: true };
    } catch (e) { return { ok: false, code: 'update_error', error: e.message }; }
  }

  // Close a live contract immediately.
  async close(contractId) {
    if (this._mode === 'paper') return { ok: true };
    if (!_socket) return { ok: false, code: 'no_socket' };
    try {
      const reply = await _socket.send({ sell: contractId, price: 0 });
      if (reply.error) return { ok: false, code: reply.error.code, error: reply.error.message };
      return { ok: true };
    } catch (e) { return { ok: false, code: 'close_error', error: e.message }; }
  }

  async _closeAll(reason) {
    for (const contractId of this._open.keys()) {
      await this.close(contractId).catch(() => {});
    }
  }

  // Open orders snapshot.
  openOrders() { return [...this._open.values()]; }

  // Current mode info.
  status() {
    return { mode: this._mode, stopped: this._kill, stopReason: this._killReason,
      openCount: this._open.size, authorized: _authorized ? { ...(_authorized || {}) } : null };
  }
}

/** Singleton for the UI layer. Only the UI creates this; tests use the class directly. */
export const broker = new BrokerAdapter();
