/**
 * deriv-public.js — Real Deriv tick & candle data via public WebSocket.
 * No authentication required. Uses Deriv's legacy API with app_id=1089.
 *
 * Provides:
 *   DerivPublic.connect()          → opens the WebSocket
 *   DerivPublic.subscribeTicks(sym, cb) → real-time price ticks
 *   DerivPublic.getCandles(sym, granularity, count) → OHLCV candle history
 *   DerivPublic.subscribeCandles(sym, granularity, count, cb) → streaming candles
 *   DerivPublic.unsubscribeAll()   → forget all subscriptions
 *   DerivPublic.disconnect()       → close socket
 *
 * All callbacks receive strongly-typed objects, never raw API payloads.
 */

import { ENDPOINTS } from '../config.js';

const APP_ID = ENDPOINTS.legacyDefaultAppId || '1089';
const WS_URL = `${ENDPOINTS.legacyWs}?app_id=${APP_ID}`;
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT = 8;

let _ws = null;
let _seq = 0;
let _pending = new Map();   // reqId → { resolve, reject, timer }
let _subs    = new Map();   // subId  → handler
let _tickSubs = new Map();  // symbol → Set<cb>
let _candleSubs = new Map();// key → { subId, cb }
let _connected = false;
let _connecting = false;
let _reconnectCount = 0;
let _statusCbs = new Set();

function onStatus(status, msg) {
  for (const cb of _statusCbs) { try { cb(status, msg); } catch (_) {} }
}

/** Returns true if the public socket is currently open. */
export function isConnected() { return _connected; }

/** Register a status listener: cb(status: 'connecting'|'open'|'closed'|'error', message) */
export function onConnectionStatus(cb) {
  _statusCbs.add(cb);
  return () => _statusCbs.delete(cb);
}

/**
 * Open the public WebSocket. Resolves when open.
 * Safe to call multiple times — returns immediately if already open.
 */
export function connect() {
  if (_connected) return Promise.resolve();
  if (_connecting) return new Promise((res) => setTimeout(() => res(connect()), 200));
  return _open();
}

function _open() {
  _connecting = true;
  onStatus('connecting', 'Connecting to Deriv…');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; ws.close(); reject(new Error('Deriv connection timed out')); }
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        _ws = ws;
        _connected = true;
        _connecting = false;
        _reconnectCount = 0;
        onStatus('open', 'Connected to Deriv');
        resolve();
      }
    };
    ws.onmessage = (ev) => _onMessage(ev.data);
    ws.onerror = () => {
      clearTimeout(timer);
      if (!settled) { settled = true; _connecting = false; reject(new Error('Deriv WebSocket error')); }
    };
    ws.onclose = () => {
      _connected = false;
      _connecting = false;
      onStatus('closed', 'Disconnected from Deriv');
      _rejectPending();
      _subs.clear();
      _scheduleReconnect();
    };
  });
}

function _scheduleReconnect() {
  if (_reconnectCount >= MAX_RECONNECT) return;
  _reconnectCount++;
  setTimeout(() => {
    if (!_connected) _open().catch(() => {});
  }, RECONNECT_DELAY * Math.min(_reconnectCount, 4));
}

function _rejectPending() {
  const err = new Error('WebSocket closed');
  for (const { reject, timer } of _pending.values()) { clearTimeout(timer); reject(err); }
  _pending.clear();
}

function _onMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  const reqId = msg.req_id;
  const subId = msg.subscription?.id;

  // Route to pending one-shot resolver
  if (reqId !== undefined && _pending.has(reqId)) {
    const p = _pending.get(reqId);
    _pending.delete(reqId);
    clearTimeout(p.timer);
    if (msg.error) { p.reject(new Error(msg.error.message || 'Deriv error')); return; }
    if (p.handler && subId) { _subs.set(subId, p.handler); p.handler(msg); }
    p.resolve(msg);
    return;
  }

  // Route to subscription handler
  if (subId && _subs.has(subId)) {
    try { _subs.get(subId)(msg); } catch (_) {}
  }

  // Route ticks to tick subscribers
  if (msg.msg_type === 'tick' && msg.tick) {
    const sym = msg.tick.symbol;
    const callbacks = _tickSubs.get(sym);
    if (callbacks) {
      const tick = { symbol: sym, price: msg.tick.quote, time: msg.tick.epoch * 1000, id: msg.tick.id };
      for (const cb of callbacks) { try { cb(tick); } catch (_) {} }
    }
  }

  // Route candle updates to candle subscribers
  if (msg.msg_type === 'ohlc' && msg.ohlc) {
    const o = msg.ohlc;
    const key = `${o.symbol}|${o.granularity}`;
    const sub = _candleSubs.get(key);
    if (sub) {
      try {
        sub.cb({ symbol: o.symbol, time: o.open_time * 1000, open: +o.open, high: +o.high, low: +o.low, close: +o.close, granularity: o.granularity });
      } catch (_) {}
    }
  }
}

function _send(payload, handler = null) {
  if (!_ws || !_connected) return Promise.reject(new Error('Not connected'));
  _seq++;
  const reqId = _seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(reqId);
      reject(new Error('Deriv request timed out'));
    }, 15000);
    _pending.set(reqId, { resolve, reject, timer, handler });
    _ws.send(JSON.stringify({ ...payload, req_id: reqId }));
  });
}

/**
 * Subscribe to real-time price ticks for a symbol.
 * cb receives { symbol, price, time (ms epoch), id }
 * Returns an unsubscribe function.
 */
export async function subscribeTicks(symbol, cb) {
  await connect();
  if (!_tickSubs.has(symbol)) _tickSubs.set(symbol, new Set());
  _tickSubs.get(symbol).add(cb);

  // Send tick subscription if first subscriber for this symbol
  if (_tickSubs.get(symbol).size === 1) {
    try {
      await _send({ ticks: symbol, subscribe: 1 }, () => {});
    } catch (e) {
      _tickSubs.get(symbol).delete(cb);
      throw e;
    }
  }
  return () => {
    const set = _tickSubs.get(symbol);
    if (set) { set.delete(cb); if (set.size === 0) _tickSubs.delete(symbol); }
  };
}

/**
 * Fetch historical candles (OHLCV) for a symbol.
 * @param {string} symbol   – Deriv market symbol
 * @param {number} granularity – seconds (60, 300, 3600, etc.)
 * @param {number} count    – number of bars (max 5000)
 * @returns {Promise<Array<{time,open,high,low,close}>>}
 */
export async function getCandles(symbol, granularity = 60, count = 500) {
  await connect();
  const reply = await _send({
    ticks_history: symbol,
    end: 'latest',
    count,
    granularity,
    style: 'candles',
  });
  if (!reply.candles) throw new Error('No candle data');
  return reply.candles.map(c => ({
    time: c.epoch,         // seconds
    open: +c.open,
    high: +c.high,
    low:  +c.low,
    close: +c.close,
  }));
}

/**
 * Subscribe to streaming candles (live OHLC updates).
 * cb receives { symbol, time (ms), open, high, low, close, granularity }
 * Returns an unsubscribe function.
 */
export async function subscribeCandles(symbol, granularity, count = 300, cb) {
  await connect();
  const key = `${symbol}|${granularity}`;

  // Unsubscribe old if any
  if (_candleSubs.has(key)) {
    const old = _candleSubs.get(key);
    if (old.subId) _subs.delete(old.subId);
    _candleSubs.delete(key);
  }

  _candleSubs.set(key, { cb, subId: null });

  const reply = await _send({
    ticks_history: symbol,
    end: 'latest',
    count,
    granularity,
    style: 'candles',
    subscribe: 1,
  }, (streamMsg) => {
    // Stream messages: ohlc updates handled by _onMessage above
  });

  const subId = reply.subscription?.id;
  if (subId && _candleSubs.has(key)) {
    _candleSubs.get(key).subId = subId;
    _subs.set(subId, (msg) => {
      if (msg.msg_type === 'ohlc' && msg.ohlc) {
        const o = msg.ohlc;
        try {
          cb({ symbol: o.symbol, time: o.open_time * 1000, open: +o.open, high: +o.high, low: +o.low, close: +o.close, granularity: o.granularity });
        } catch (_) {}
      }
    });
  }

  // Return historical candles in the reply
  const history = (reply.candles || []).map(c => ({
    time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close,
  }));

  return {
    history,
    stop: () => {
      if (subId) { _subs.delete(subId); }
      _candleSubs.delete(key);
    },
  };
}

/** Forget all subscriptions and disconnect. */
export function disconnect() {
  _tickSubs.clear();
  _candleSubs.clear();
  _subs.clear();
  _rejectPending();
  if (_ws) { try { _ws.close(); } catch (_) {} _ws = null; }
  _connected = false;
}
