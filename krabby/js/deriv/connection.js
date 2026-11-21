// Deriv WebSocket layer. One DerivSocket per socket: the public market socket, or the authorised trading socket.
// Handles req_id routing, request timeouts, keepalive ping, reconnect with backoff and subscription forget.
// Auth payloads carry the API token, so the echoed authorize request is redacted from every incoming message.
// Nothing here logs payloads.
import { TIMING } from '../config.js';
import { bus } from '../core/bus.js';

const OPEN_STATE = 1; // WebSocket.OPEN, kept as a literal so this module never reads the global at import
const STOP_RECONNECT_CODES = new Set(['InvalidToken', 'AuthorizationRequired']);

// Error from Deriv or from this layer. code = Deriv error code or a local code; details and raw from the reply.
export class DerivError extends Error {
  constructor(message, { code = 'Error', details, raw } = {}) {
    super(message);
    this.name = 'DerivError';
    this.code = code;
    this.details = details;
    this.raw = raw;
  }
}

// Drop the echoed authorize request (it contains the API token) before any message leaves this module.
function redact(msg) {
  const echo = msg.echo_req;
  if (!echo || typeof echo !== 'object' || !('authorize' in echo)) return msg;
  const cleanEcho = { ...echo };
  delete cleanEcho.authorize;
  return { ...msg, echo_req: cleanEcho };
}

// Name of the call key in a request, e.g. 'ticks' or 'authorize'. Used in messages instead of the payload.
function callName(payload) {
  return Object.keys(payload).find((k) => k !== 'req_id') || 'unknown';
}

function toDerivError(msg) {
  const e = msg.error || {};
  return new DerivError(e.message || 'Deriv returned an error.', { code: e.code || 'Unknown', details: e.details, raw: msg });
}

function safeCall(fn, arg) {
  try { fn(arg); } catch (err) { console.error('[deriv] handler failed', err && err.message); }
}

export class DerivSocket {
  // name: 'public' | 'auth' (shown in conn:status). getUrl: optional async function returning a fresh URL on every open.
  constructor({ name, url = null, getUrl = null, label = null } = {}) {
    this.name = name || 'socket';
    this.url = url;
    this.getUrl = getUrl;
    this.label = label || this.name;
    this.ws = null;
    this.connecting = null;
    this.seq = 0;
    this.gen = 0;
    this.pending = new Map();
    this.subs = new Map();
    this.listeners = new Map();
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.intentional = true;
    this.autoReconnect = true;
    this.opening = null;
    this.onReconnected = null; // async () => void, set by api.js to re-authorise and re-subscribe
  }

  get isOpen() {
    return Boolean(this.ws) && this.ws.readyState === OPEN_STATE;
  }

  // Opens the socket. Resolves when open, rejects on failure or timeout. Safe to call twice.
  open() {
    if (this.isOpen) return Promise.resolve();
    if (this.opening) return this.opening;
    this.intentional = false;
    this.opening = this.doOpen().finally(() => { this.opening = null; });
    return this.opening;
  }

  async doOpen() {
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') throw new DerivError('This browser has no WebSocket support.', { code: 'NoWebSocket' });
    const gen = this.gen;
    this.emitStatus('connecting', `Connecting to ${this.label}`);
    let url;
    try {
      url = this.getUrl ? await this.getUrl() : this.url;
    } catch (err) {
      this.emitStatus('error', `Could not get a connection address for ${this.label}`);
      throw err;
    }
    if (gen !== this.gen) throw new DerivError('Connection cancelled.', { code: 'SocketClosed' });
    return new Promise((resolve, reject) => {
      let ws = null;
      let settled = false;
      let timer = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        if (ws) {
          ws.onopen = null;
          ws.onerror = null;
          ws.onclose = null;
          try { ws.close(); } catch (_) { /* already closed */ }
        }
        this.emitStatus('error', err.message);
        reject(err);
      };
      timer = setTimeout(() => {
        fail(new DerivError(`${this.label} did not open within ${TIMING.requestTimeoutMs / 1000} s.`, { code: 'RequestTimeout' }));
      }, TIMING.requestTimeoutMs);
      try {
        ws = new WS(url);
      } catch (_) {
        fail(new DerivError(`Could not open ${this.label}.`, { code: 'ConnectionFailed' }));
        return;
      }
      this.connecting = ws;
      ws.onopen = () => {
        if (settled) return;
        if (gen !== this.gen) { fail(new DerivError('Connection cancelled.', { code: 'SocketClosed' })); return; }
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        this.ws = ws;
        this.attach(ws);
        this.startPing();
        this.emitStatus('open', `${this.label} connected`);
        resolve();
      };
      ws.onerror = () => fail(new DerivError(`Could not connect to ${this.label}. Check your connection.`, { code: 'ConnectionFailed' }));
      ws.onclose = () => fail(new DerivError(`${this.label} closed before it opened.`, { code: 'ConnectionFailed' }));
    });
  }

  attach(ws) {
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => { /* the close event that follows carries the state */ };
    ws.onclose = () => this.handleDrop(ws);
  }

  // Closes the socket on purpose. Pending requests reject, subscriptions are dropped, no reconnect.
  close(reason = 'closed') {
    this.intentional = true;
    this.gen += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const ws = this.ws;
    const connecting = this.connecting;
    this.ws = null;
    this.connecting = null;
    this.rejectPending(new DerivError(`Connection closed: ${reason}`, { code: 'SocketClosed' }));
    this.subs.clear();
    if (ws) { try { ws.close(); } catch (_) { /* already closed */ } }
    if (connecting) { try { connecting.close(); } catch (_) { /* already closed */ } }
    this.emitStatus('closed', reason);
  }

  // Sends one call and resolves with the reply. Rejects with DerivError on an error reply or timeout.
  send(payload) {
    return this.call(payload, null);
  }

  call(payload, handler) {
    const name = callName(payload);
    if (!this.isOpen) {
      return Promise.reject(new DerivError(`${this.label} is not connected.`, { code: 'SocketClosed', raw: { call: name } }));
    }
    this.seq += 1;
    const reqId = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new DerivError(`Deriv did not reply to ${name} within ${TIMING.requestTimeoutMs / 1000} s.`, { code: 'RequestTimeout', raw: { call: name } }));
      }, TIMING.requestTimeoutMs);
      this.pending.set(reqId, { resolve, reject, timer, handler });
      try {
        this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
      } catch (_) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(new DerivError('Could not send the request.', { code: 'SocketClosed', raw: { call: name } }));
      }
    });
  }

  // Starts a subscription. handler receives every update for the returned id, including the first reply.
  async subscribe(payload, handler) {
    const first = await this.call({ ...payload, subscribe: 1 }, handler);
    const id = first.subscription && first.subscription.id;
    if (!id) throw new DerivError('Deriv did not return a subscription id.', { code: 'NoSubscription', raw: { call: callName(payload) } });
    return { id, stop: () => this.forget(id) };
  }

  // Stops a subscription on Deriv and locally. Never rejects.
  forget(id) {
    this.subs.delete(id);
    if (!this.isOpen) return Promise.resolve();
    return this.send({ forget: id }).then(() => undefined, () => undefined);
  }

  // Listens to every message of a given msg_type. Returns an unsubscribe function.
  on(msgType, fn) {
    if (!this.listeners.has(msgType)) this.listeners.set(msgType, new Set());
    this.listeners.get(msgType).add(fn);
    return () => { const set = this.listeners.get(msgType); if (set) set.delete(fn); };
  }

  onMessage(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return; }
    if (!parsed || typeof parsed !== 'object') return;
    const msg = redact(parsed);
    const reqId = msg.req_id;
    const sid = msg.subscription && msg.subscription.id;
    if (reqId !== undefined && this.pending.has(reqId)) {
      const p = this.pending.get(reqId);
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(toDerivError(msg));
      } else {
        if (p.handler && sid) { this.subs.set(sid, p.handler); safeCall(p.handler, msg); }
        p.resolve(msg);
      }
    } else if (sid && this.subs.has(sid)) {
      safeCall(this.subs.get(sid), msg);
    }
    const set = this.listeners.get(msg.msg_type);
    if (set) for (const fn of [...set]) safeCall(fn, msg);
  }

  handleDrop(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopPing();
    this.rejectPending(new DerivError('The connection dropped before the reply arrived.', { code: 'SocketClosed' }));
    this.subs.clear();
    this.emitStatus('closed', `${this.label} disconnected`);
    if (!this.intentional && this.autoReconnect) this.scheduleReconnect();
  }

  rejectPending(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.isOpen) return;
      this.send({ ping: 1 }).catch(() => {
        // A ping that gets no reply means the socket is dead. Closing it lets the reconnect logic take over.
        if (this.ws) { try { this.ws.close(); } catch (_) { /* already closed */ } }
      });
    }, TIMING.pingEveryMs);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // Backoff: reconnectBaseMs doubling per attempt, capped at reconnectMaxMs.
  scheduleReconnect() {
    if (this.intentional || this.reconnectTimer) return;
    const delay = Math.min(TIMING.reconnectMaxMs, TIMING.reconnectBaseMs * 2 ** Math.min(this.attempt, 10));
    this.attempt += 1;
    this.emitStatus('closed', `Reconnecting ${this.label} in ${Math.round(delay / 1000)} s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retry();
    }, delay);
  }

  async retry() {
    if (this.intentional) return;
    try {
      await this.open();
    } catch (err) {
      if (err instanceof DerivError && STOP_RECONNECT_CODES.has(err.code)) {
        this.autoReconnect = false;
        return;
      }
      this.scheduleReconnect();
      return;
    }
    this.attempt = 0;
    if (typeof this.onReconnected !== 'function') return;
    try {
      await this.onReconnected();
    } catch (err) {
      if (err instanceof DerivError && STOP_RECONNECT_CODES.has(err.code)) this.autoReconnect = false;
      this.emitStatus('error', `Could not restore ${this.label}. ${err && err.message ? err.message : ''}`.trim());
      if (this.ws) { try { this.ws.close(); } catch (_) { /* already closed */ } }
    }
  }

  // conn:status payload: {socket, status: 'connecting'|'open'|'closed'|'error', message}. Never contains the token or an OTP URL.
  emitStatus(status, message) {
    bus.emit('conn:status', { socket: this.name, status, message });
  }
}
