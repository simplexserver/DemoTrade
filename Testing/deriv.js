(() => {
  'use strict';
  // Robust Deriv WebSocket client for static hosting (GitHub Pages etc.)
  // Uses classic endpoint that works from browsers without CORS issues.
  const DEFAULT_APP = 1089;
  const url = (id) => `wss://ws.derivws.com/websockets/v3?app_id=${id || DEFAULT_APP}`;

  const LIMITS = {
    trading: { max: 25, window: 60000 },
    balance: { max: 12, window: 60000 },
    ticks:   { max: 50, window: 60000 },
    other:   { max: 40, window: 60000 }
  };
  const TYPE_BUCKET = {
    proposal: 'trading', buy: 'trading', sell: 'trading',
    proposal_open_contract: 'trading',
    balance: 'balance', portfolio: 'balance', statement: 'balance',
    ticks: 'ticks', ticks_history: 'ticks', candles: 'ticks', ohlc: 'ticks'
  };

  let ws = null, running = false, token = '', appId = DEFAULT_APP;
  let state = 'off', fails = 0, authOk = false, balance = null;
  let reqId = 1, pingT = 0, reconT = 0;
  const hits = {}, pending = new Map(), tickCbs = new Map();

  function bucket(t) { return TYPE_BUCKET[t] || 'other'; }
  function allowed(t) {
    const b = bucket(t), lim = LIMITS[b], now = Date.now();
    hits[b] = (hits[b] || []).filter(x => now - x < lim.window);
    return hits[b].length < lim.max;
  }
  function hit(t) { (hits[bucket(t)] = hits[bucket(t)] || []).push(Date.now()); }

  function emit(s, msg) {
    state = s;
    window.dispatchEvent(new CustomEvent('deriv:status', {
      detail: { state: s, msg, authorized: authOk, balance }
    }));
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return 0;
    const t = Object.keys(obj)[0];
    if (!allowed(t)) { emit('limit', 'Rate limited – waiting…'); return 0; }
    if (!obj.req_id) obj.req_id = reqId++;
    hit(t);
    try { ws.send(JSON.stringify(obj)); return obj.req_id; }
    catch { return 0; }
  }

  function request(obj, ms = 15000) {
    return new Promise((resolve, reject) => {
      const id = send(obj);
      if (!id) return reject(new Error('Not connected or rate limited'));
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, ms);
      pending.set(id, { resolve, reject, timer });
    });
  }

  function onMsg(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.req_id && pending.has(m.req_id)) {
      const p = pending.get(m.req_id);
      clearTimeout(p.timer);
      pending.delete(m.req_id);
      if (m.error) p.reject(new Error(m.error.message || 'Error'));
      else p.resolve(m);
    }

    if (m.msg_type === 'tick' && m.tick) {
      const cb = tickCbs.get(m.tick.symbol);
      if (cb) cb(m.tick);
      window.dispatchEvent(new CustomEvent('deriv:tick', { detail: m.tick }));
    }
    if (m.msg_type === 'balance' && m.balance) {
      balance = m.balance;
      window.dispatchEvent(new CustomEvent('deriv:balance', { detail: m.balance }));
    }
    if (m.msg_type === 'proposal_open_contract') {
      window.dispatchEvent(new CustomEvent('deriv:contract', { detail: m.proposal_open_contract }));
    }
    if (m.error) {
      const msg = m.error.message || '';
      if (/rate.?limit|too many/i.test(msg)) emit('limit', 'Rate limited by server');
    }
  }

  function connect() {
    if (!running) return;
    emit('connecting', 'Connecting…');
    try { ws = new WebSocket(url(appId)); }
    catch (e) { emit('down', 'WebSocket blocked'); schedule(); return; }

    ws.onopen = async () => {
      fails = 0;
      clearInterval(pingT);
      pingT = setInterval(() => send({ ping: 1 }), 20000);

      if (token) {
        try {
          emit('auth', 'Authorizing…');
          const res = await request({ authorize: token });
          if (res.authorize) {
            authOk = true;
            balance = {
              balance: res.authorize.balance,
              currency: res.authorize.currency || 'USD',
              loginid: res.authorize.loginid
            };
            send({ balance: 1, subscribe: 1 });
            emit('ok', `Authorized · ${res.authorize.loginid}`);
            request({ active_symbols: 'brief' }).then(r => {
              if (r.active_symbols) {
                window.dispatchEvent(new CustomEvent('deriv:symbols', { detail: r.active_symbols }));
              }
            }).catch(() => {});
          }
        } catch (err) {
          authOk = false;
          emit('down', 'Auth failed: ' + (err.message || 'check token'));
        }
      } else {
        authOk = false;
        emit('ok', 'Public feed live (no token)');
      }
    };

    ws.onmessage = e => onMsg(e.data);
    ws.onerror = () => { if (running) emit('down', 'Connection error'); };
    ws.onclose = () => {
      clearInterval(pingT);
      authOk = false;
      if (!running) return;
      fails++;
      emit('down', 'Disconnected – reconnecting…');
      schedule();
    };
  }

  function schedule() {
    clearTimeout(reconT);
    const d = Math.min(2500 * Math.pow(1.5, fails), 40000);
    reconT = setTimeout(connect, d);
  }

  const Deriv = {
    start(opts = {}) {
      this.stop(true);
      token = (opts.token || '').trim();
      appId = opts.appId || DEFAULT_APP;
      running = true;
      fails = 0;
      connect();
    },
    stop(quiet) {
      running = false;
      clearTimeout(reconT);
      clearInterval(pingT);
      authOk = false;
      balance = null;
      tickCbs.clear();
      if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
      if (!quiet) emit('off', 'Stopped');
    },
    get state() { return state; },
    get authorized() { return authOk; },
    get balance() { return balance; },

    subscribeTicks(symbol, cb) {
      tickCbs.set(symbol, cb);
      return send({ ticks: symbol, subscribe: 1 });
    },
    unsubscribeTicks(symbol) { tickCbs.delete(symbol); },

    async candles(symbol, granularity = 60, count = 200) {
      const res = await request({
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: 'latest',
        granularity,
        style: 'candles'
      });
      if (!res.candles) throw new Error('No candles');
      return res.candles.map(c => ({
        t: c.epoch * 1000, o: +c.open, h: +c.high, l: +c.low, c: +c.close
      }));
    },

    async proposal(p) {
      const body = {
        proposal: 1,
        amount: p.amount,
        basis: p.basis || 'stake',
        contract_type: p.contract_type,
        currency: p.currency || 'USD',
        symbol: p.symbol,
        duration: p.duration,
        duration_unit: p.duration_unit || 't'
      };
      if (p.multiplier) body.multiplier = p.multiplier;
      if (p.barrier) body.barrier = p.barrier;
      if (p.growth_rate) body.growth_rate = p.growth_rate;
      return request(body);
    },

    async buy(id, price) { return request({ buy: id, price }); },
    async sell(id, price = 0) { return request({ sell: id, price }); },
    subscribeContract(id) {
      return send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
    },

    async quickCheck(tok, app = DEFAULT_APP) {
      return new Promise(resolve => {
        let settled = false;
        const finish = (r) => { if (settled) return; settled = true; try { tw.close(); } catch {} resolve(r); };
        const tw = new WebSocket(url(app));
        const timer = setTimeout(() => finish({ ok: false, reason: 'Timeout – just click Connect' }), 9000);
        tw.onopen = () => {
          try { tw.send(JSON.stringify({ authorize: tok, req_id: 99 })); }
          catch { finish({ ok: false, reason: 'Send failed' }); }
        };
        tw.onmessage = e => {
          clearTimeout(timer);
          try {
            const m = JSON.parse(e.data);
            if (m.error) finish({ ok: false, reason: m.error.message || 'Invalid token' });
            else if (m.authorize) finish({
              ok: true,
              loginid: m.authorize.loginid,
              balance: m.authorize.balance,
              currency: m.authorize.currency
            });
            else finish({ ok: false, reason: 'Unexpected reply' });
          } catch { finish({ ok: false, reason: 'Parse error' }); }
        };
        tw.onerror = () => { clearTimeout(timer); finish({ ok: false, reason: 'Network / blocked' }); };
        tw.onclose = () => { clearTimeout(timer); if (!settled) finish({ ok: false, reason: 'Closed early' }); };
      });
    }
  };

  window.Deriv = Deriv;
})();
