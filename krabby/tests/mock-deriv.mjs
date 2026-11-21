// Local stand-in for the Deriv trading API. Run by hand with `npm run test:mock`, or let tests/smoke.mjs start it.
// It speaks the shared JSON protocol (DESIGN 7c) on the new options paths and on the legacy path.
// Prices are a random walk and contracts settle from it. This is a test double, not a market.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

export const MOCK_TOKEN = 'krabby-mock-token';
const STAKE_MIN_DEFAULT = 0.35;
const STAKE_MAX = 50000;
const TICK_MS = 500;
const OTP_TTL_MS = 120000;
const UNIT_MS = { t: 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 }; // ticks are treated as 1 s each
const MULTIPLIERS = [5, 10, 20, 30, 40, 50, 100, 200, 300, 400, 500, 1000, 2000];
const UP = ['CALL', 'CALLE', 'MULTUP', 'TURBOSLONG', 'VANILLALONGCALL', 'ONLYUPS', 'RESETCALL'];
const DOWN = ['PUT', 'PUTE', 'MULTDOWN', 'TURBOSSHORT', 'VANILLALONGPUT', 'ONLYDOWNS', 'RESETPUT'];
const OTHER = ['ONETOUCH', 'NOTOUCH', 'EXPIRYRANGE', 'EXPIRYMISS', 'RANGE', 'UPORDOWN', 'DIGITMATCH', 'DIGITDIFF',
  'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'ASIANU', 'ASIAND', 'TICKHIGH', 'TICKLOW', 'ACCU'];
const CONTRACT_CODES = [...UP, ...DOWN, ...OTHER];
const TWO_BARRIERS = ['EXPIRYRANGE', 'EXPIRYMISS', 'RANGE', 'UPORDOWN'];
const ONE_BARRIER = ['CALLE', 'PUTE', 'ONETOUCH', 'NOTOUCH', 'DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER',
  'VANILLALONGCALL', 'VANILLALONGPUT', 'TURBOSLONG', 'TURBOSSHORT', 'RESETCALL', 'RESETPUT'];
const AUTH_CALLS = new Set(['buy', 'sell', 'proposal_open_contract', 'balance', 'profit_table']);
const MARKETS = [
  { symbol: 'R_100', name: 'Volatility 100 Index', market: 'synthetic_index', submarket: 'random_index', pip: 0.01, start: 1000 },
  { symbol: 'R_50', name: 'Volatility 50 Index', market: 'synthetic_index', submarket: 'random_index', pip: 0.0001, start: 500 },
  { symbol: 'frxXAUUSD', name: 'Gold/USD', market: 'commodities', submarket: 'metals', pip: 0.01, start: 2000 },
  { symbol: 'frxEURUSD', name: 'EUR/USD', market: 'forex', submarket: 'major_pairs', pip: 0.00001, start: 1.08 },
  { symbol: 'frxGBPUSD', name: 'GBP/USD', market: 'forex', submarket: 'major_pairs', pip: 0.00001, start: 1.27 },
  { symbol: 'WLDAUD', name: 'AUD Basket', market: 'basket_index', submarket: 'non_stop', pip: 0.01, start: 100 },
];

class MockError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const decimalsOf = (pip) => {
  const s = String(pip);
  return s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] || '').length;
};
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const dirOf = (code) => (UP.includes(code) ? 1 : DOWN.includes(code) ? -1 : 0);
const stepPrice = (m, p) => round(Math.max(m.pip, p + (Math.random() - 0.5) * m.pip * 6), decimalsOf(m.pip));

function contractsAvailable() {
  return CONTRACT_CODES.map((code) => {
    const e = { contract_type: code, min_contract_duration: '1t', max_contract_duration: '365d' };
    if (TWO_BARRIERS.includes(code)) e.barriers = 2;
    else if (ONE_BARRIER.includes(code)) e.barriers = 1;
    if (code === 'MULTUP' || code === 'MULTDOWN') e.multiplier_range = MULTIPLIERS;
    if (code === 'ACCU') e.growth_rate_range = [0.01, 0.05];
    return e;
  });
}

// Start the mock. Resolves with {url, wsUrl, port, tokens, stats, close()}.
// port 0 picks a free port. stakeMin and failNext can also come from MOCK_STAKE_MIN and MOCK_FAIL.
export function startMockServer({
  port = 0,
  tokens = [MOCK_TOKEN],
  stakeMin = Number(process.env.MOCK_STAKE_MIN) || STAKE_MIN_DEFAULT,
  failNext = process.env.MOCK_FAIL || null,
} = {}) {
  const prices = Object.fromEntries(MARKETS.map((m) => [m.symbol, m.start]));
  const accounts = [
    { account_id: 'VRTC1000001', account_type: 'demo', currency: 'USD', balance: 10000 },
    { account_id: 'CR1000002', account_type: 'real', currency: 'USD', balance: 0 },
  ];
  const acct = (id) => accounts.find((a) => a.account_id === id);
  const contracts = new Map();
  const proposals = new Map();
  const subs = new Map();
  const otps = new Map();
  const sockets = new Set();
  const stats = { connections: { public: 0, legacy: 0, otp: 0 }, calls: {}, buys: 0, sells: 0, failures: 0, rejects: 0, otpIssued: 0 };
  let seq = 100000;
  const nextId = () => { seq += 1; return seq; };
  let globalFail = failNext;
  let timer = null;

  const marketOr = (symbol) => {
    const m = MARKETS.find((x) => x.symbol === symbol);
    if (!m) throw new MockError('InputValidationFailed', `${symbol} is not a known symbol.`);
    return m;
  };
  // One injected failure: the socket's ?fail= option first, then the global MOCK_FAIL. Each fires once.
  const takeFailure = (sock) => {
    if (sock.failNext) { const code = sock.failNext; sock.failNext = null; return code; }
    if (globalFail) { const code = globalFail; globalFail = null; return code; }
    return null;
  };
  const sendTo = (sock, msg) => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)); };
  const epochSec = () => Math.floor(Date.now() / 1000);
  const tickBody = (symbol, id) => ({ symbol, quote: prices[symbol], epoch: epochSec(), pip_size: marketOr(symbol).pip, id });
  const proposalBody = (p) => ({
    id: p.id, ask_price: p.ask, payout: p.payout, spot: prices[p.symbol],
    longcode: p.longcode, display_value: p.ask.toFixed(2),
  });

  // Value of an open contract. Options move with spot and cap at the payout. Multipliers lose at most the stake.
  function bidOf(c, spot) {
    const move = c.entry ? (spot - c.entry) / c.entry : 0;
    if (c.expiry !== null) return clamp(c.stake * (1 + 20 * c.dir * move), 0, c.payout);
    return Math.max(0, c.stake * (1 + c.mult * c.dir * move));
  }
  function pocBody(c) {
    const open = c.status === 'open';
    const spot = prices[c.symbol];
    const bid = round(open ? bidOf(c, spot) : c.sellPrice);
    return {
      contract_id: c.id, buy_price: c.stake, bid_price: bid, current_spot: spot, entry_spot: c.entry,
      profit: round(bid - c.stake), payout: c.payout, is_sold: open ? 0 : 1, status: c.status,
      date_expiry: c.expiry === null ? null : Math.floor(c.expiry / 1000),
      sell_price: open ? null : c.sellPrice, longcode: c.longcode, currency: acct(c.loginid).currency,
    };
  }
  // Options settle at expiry: a directional contract wins when spot moved its way, ties lose.
  function settle(c, t) {
    const won = c.dir !== 0 ? c.dir * (prices[c.symbol] - c.entry) > 0 : Math.random() < 0.5;
    c.status = won ? 'won' : 'lost';
    c.sellPrice = won ? c.payout : 0;
    c.closedAt = t;
    const a = acct(c.loginid);
    a.balance = round(a.balance + c.sellPrice);
  }
  function addSub(sock, data) {
    const id = nextId();
    subs.set(id, { id, sock, ...data });
    return id;
  }
  // Candles ending at the current price, built backwards so the last close matches the live price.
  function makeCandles(symbol, gran, count) {
    const m = marketOr(symbol);
    const end = Math.floor(epochSec() / gran) * gran;
    const out = [];
    let close = prices[symbol];
    for (let i = count - 1; i >= 0; i -= 1) {
      let open = close;
      let high = close;
      let low = close;
      for (let k = 0; k < 4; k += 1) {
        open = stepPrice(m, open);
        high = Math.max(high, open);
        low = Math.min(low, open);
      }
      out.unshift({ epoch: end - (count - 1 - i) * gran, open, high, low, close });
      close = open;
    }
    return out;
  }

  // Sends one update for a subscription. Called every TICK_MS.
  function pump(sub, sec) {
    if (sub.sock.readyState !== WebSocket.OPEN) { subs.delete(sub.id); return; }
    const send = (type, body) => sendTo(sub.sock, { msg_type: type, [type]: body, subscription: { id: sub.id } });
    if (sub.kind === 'ticks') { send('tick', tickBody(sub.symbol, sub.id)); return; }
    if (sub.kind === 'ohlc') {
      const bucket = Math.floor(sec / sub.gran) * sub.gran;
      const p = prices[sub.symbol];
      if (bucket !== sub.bucket) { sub.bucket = bucket; sub.open = sub.close; sub.high = sub.open; sub.low = sub.open; }
      sub.high = Math.max(sub.high, p);
      sub.low = Math.min(sub.low, p);
      sub.close = p;
      send('ohlc', {
        open_time: bucket, epoch: sec, open: sub.open, high: sub.high, low: sub.low, close: sub.close,
        granularity: sub.gran, symbol: sub.symbol, id: sub.id,
      });
      return;
    }
    if (sub.kind === 'proposal') {
      const p = proposals.get(sub.proposalId);
      if (!p) { subs.delete(sub.id); return; }
      send('proposal', proposalBody(p));
      return;
    }
    if (sub.kind === 'poc') {
      const c = contracts.get(sub.contractId);
      send('proposal_open_contract', pocBody(c));
      if (c.status !== 'open') subs.delete(sub.id);
      return;
    }
    if (sub.kind === 'balance') {
      const a = acct(sub.loginid);
      if (a.balance !== sub.last) {
        sub.last = a.balance;
        send('balance', { balance: a.balance, currency: a.currency, loginid: a.account_id });
      }
    }
  }
  function tick() {
    for (const m of MARKETS) prices[m.symbol] = stepPrice(m, prices[m.symbol]);
    const t = Date.now();
    for (const c of contracts.values()) {
      if (c.status === 'open' && c.expiry !== null && c.expiry <= t) settle(c, t);
    }
    const sec = Math.floor(t / 1000);
    for (const sub of [...subs.values()]) pump(sub, sec);
  }

  // REST auth: Deriv-App-ID header plus a known bearer token. Returns null when allowed.
  function restCheck(req) {
    if (!req.headers['deriv-app-id']) return { code: 'AuthorizationRequired', message: 'Deriv-App-ID header is required.' };
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !tokens.includes(m[1])) return { code: 'InvalidToken', message: 'The bearer token is invalid.' };
    return null;
  }
  // Maps a WebSocket upgrade path to a socket profile. null = unknown path. {rejected} = refuse with 401.
  function routeSocket(url) {
    const fail = url.searchParams.get('fail');
    if (url.pathname === '/trading/v1/options/ws/public') return { kind: 'public', mode: 'new', authed: false, fail };
    if (url.pathname === '/websockets/v3') return { kind: 'legacy', mode: 'legacy', authed: false, fail };
    const m = /^\/trading\/v1\/options\/ws\/(demo|real)$/.exec(url.pathname);
    if (!m) return null;
    const otpValue = url.searchParams.get('otp');
    const otp = otps.get(otpValue);
    if (!otp || otp.expires < Date.now() || acct(otp.accountId).account_type !== m[1]) return { rejected: true };
    otps.delete(otpValue); // OTPs are single use
    return { kind: 'otp', mode: 'new', authed: true, loginid: otp.accountId, fail };
  }
  function onConnection(ws, meta) {
    Object.assign(ws, { mode: meta.mode, authed: meta.authed, loginid: meta.loginid || null, failNext: meta.fail });
    sockets.add(ws);
    stats.connections[meta.kind] += 1;
    ws.on('message', (data) => onMessage(ws, data.toString()));
    ws.on('close', () => {
      sockets.delete(ws);
      for (const [id, s] of subs) if (s.sock === ws) subs.delete(id);
    });
    ws.on('error', () => {});
  }

  // Each handler returns {type, body, subscription?}. Errors are thrown as MockError.
  const HANDLERS = {
    authorize(sock, token) {
      if (!tokens.includes(token)) throw new MockError('InvalidToken', 'The token is invalid.');
      const demo = accounts[0];
      Object.assign(sock, { authed: true, loginid: demo.account_id });
      return {
        type: 'authorize',
        body: {
          loginid: demo.account_id, currency: 'USD', balance: demo.balance, is_virtual: 1,
          email: 'mock@krabby.test', fullname: 'Krabby Mock', scopes: ['read', 'trade'],
          account_list: accounts.map((a) => ({ loginid: a.account_id, is_virtual: a.account_type === 'demo' ? 1 : 0, currency: a.currency })),
        },
      };
    },
    ping: () => ({ type: 'ping', body: 'pong' }),
    active_symbols: () => ({
      type: 'active_symbols',
      body: MARKETS.map((m) => ({
        symbol: m.symbol, display_name: m.name, market: m.market, market_display_name: m.market.replace(/_/g, ' '),
        submarket: m.submarket, submarket_display_name: m.submarket.replace(/_/g, ' '), symbol_type: m.market,
        pip: m.pip, exchange_is_open: 1, is_trading_suspended: 0,
      })),
    }),
    ticks(sock, symbol, req) {
      marketOr(symbol);
      const subscription = req.subscribe ? addSub(sock, { kind: 'ticks', symbol }) : undefined;
      return { type: 'tick', body: tickBody(symbol, subscription), subscription };
    },
    forget(sock, id) {
      const sub = subs.get(Number(id));
      if (sub && sub.sock === sock) subs.delete(Number(id));
      return { type: 'forget', body: 1 };
    },
    ticks_history(sock, symbol, req) {
      marketOr(symbol);
      const count = Math.min(Number(req.count) || 100, 5000);
      if (req.style === 'ticks') {
        const m = marketOr(symbol);
        const times = [];
        const values = [];
        let p = prices[symbol];
        const start = epochSec() - count;
        for (let i = 0; i < count; i += 1) { p = stepPrice(m, p); values.push(p); times.push(start + i); }
        return { type: 'history', body: { prices: values, times } };
      }
      const gran = Number(req.granularity) || 60;
      const candles = makeCandles(symbol, gran, count);
      const last = candles[candles.length - 1];
      const subscription = req.subscribe
        ? addSub(sock, { kind: 'ohlc', symbol, gran, bucket: last.epoch, open: last.open, high: last.high, low: last.low, close: last.close })
        : undefined;
      return { type: 'candles', body: candles, subscription };
    },
    contracts_for(sock, symbol) {
      marketOr(symbol);
      return { type: 'contracts_for', body: { available: contractsAvailable() } };
    },
    proposal(sock, _value, req) {
      // New-mode trading requests name the symbol underlying_symbol. Legacy uses symbol.
      const field = sock.mode === 'new' ? 'underlying_symbol' : 'symbol';
      const m = marketOr(req[field]);
      if (!CONTRACT_CODES.includes(req.contract_type)) {
        throw new MockError('InputValidationFailed', `Unknown contract_type ${req.contract_type}.`);
      }
      const amount = Number(req.amount);
      if (!(amount >= stakeMin && amount <= STAKE_MAX)) {
        throw new MockError('InputValidationFailed', `Stake must be between ${stakeMin.toFixed(2)} and ${STAKE_MAX.toFixed(2)}`);
      }
      const id = `P${nextId()}`;
      const p = { id, symbol: m.symbol, ask: round(amount), payout: round(amount * 1.95), longcode: `${req.contract_type} on ${m.symbol}`, req };
      proposals.set(id, p);
      const subscription = req.subscribe ? addSub(sock, { kind: 'proposal', proposalId: id }) : undefined;
      return { type: 'proposal', body: proposalBody(p), subscription };
    },
    buy(sock, proposalId, req) {
      const p = proposals.get(proposalId);
      if (!p) throw new MockError('ContractBuyValidationError', 'The quote is not available. Request a new one.');
      const failure = takeFailure(sock);
      if (failure) {
        stats.failures += 1;
        throw new MockError(failure, failure === 'PriceMoved' ? 'The underlying price has moved. Request a new quote.' : `Injected ${failure} error.`);
      }
      if (req.price !== undefined && Number(req.price) < p.ask) {
        throw new MockError('PriceMoved', `Price moved from ${req.price} to ${p.ask}.`);
      }
      const a = acct(sock.loginid);
      if (p.ask > a.balance) throw new MockError('InsufficientBalance', 'Insufficient balance.');
      const contract = {
        id: nextId(), txn: nextId(), loginid: a.account_id, symbol: p.symbol, type: p.req.contract_type,
        dir: dirOf(p.req.contract_type), stake: p.ask, payout: p.payout, entry: prices[p.symbol], start: epochSec(),
        expiry: p.req.duration === undefined ? null : Date.now() + Number(p.req.duration) * (UNIT_MS[p.req.duration_unit] || 1000),
        mult: Number(p.req.multiplier) || 0, status: 'open', sellPrice: null, closedAt: null, longcode: p.longcode,
      };
      a.balance = round(a.balance - p.ask);
      contracts.set(contract.id, contract);
      proposals.delete(proposalId);
      stats.buys += 1;
      return {
        type: 'buy',
        body: {
          contract_id: contract.id, buy_price: p.ask, payout: p.payout, balance_after: a.balance,
          transaction_id: contract.txn, start_time: contract.start, longcode: contract.longcode,
        },
      };
    },
    sell(sock, id) {
      const c = contracts.get(Number(id));
      if (!c || c.loginid !== sock.loginid) throw new MockError('InputValidationFailed', 'Contract not found.');
      if (c.status !== 'open') throw new MockError('InvalidSellContractProposal', 'This contract is no longer open.');
      const a = acct(c.loginid);
      const bid = round(bidOf(c, prices[c.symbol]));
      Object.assign(c, { status: 'sold', sellPrice: bid, closedAt: Date.now() });
      a.balance = round(a.balance + bid);
      stats.sells += 1;
      return { type: 'sell', body: { sold_for: bid, balance_after: a.balance, transaction_id: nextId(), contract_id: c.id } };
    },
    proposal_open_contract(sock, id, req) {
      const c = contracts.get(Number(id));
      if (!c || c.loginid !== sock.loginid) throw new MockError('InputValidationFailed', 'Contract not found.');
      const subscription = req.subscribe && c.status === 'open' ? addSub(sock, { kind: 'poc', contractId: c.id }) : undefined;
      return { type: 'proposal_open_contract', body: pocBody(c), subscription };
    },
    balance(sock, _value, req) {
      const a = acct(sock.loginid);
      const subscription = req.subscribe ? addSub(sock, { kind: 'balance', loginid: a.account_id, last: a.balance }) : undefined;
      return { type: 'balance', body: { balance: a.balance, currency: a.currency, loginid: a.account_id }, subscription };
    },
    profit_table(sock, _value, req) {
      const limit = Number(req.limit) || 50;
      const rows = [...contracts.values()]
        .filter((c) => c.loginid === sock.loginid && c.status !== 'open')
        .sort((x, y) => y.id - x.id)
        .slice(0, limit)
        .map((c) => ({
          transaction_id: c.txn, contract_id: c.id, buy_price: c.stake, sell_price: c.sellPrice,
          purchase_time: c.start, sell_time: Math.floor(c.closedAt / 1000), longcode: c.longcode, shortcode: `${c.type}_${c.symbol}`,
        }));
      return { type: 'profit_table', body: { count: rows.length, transactions: rows } };
    },
  };

  function sendError(sock, call, reqId, code, message) {
    stats.rejects += 1;
    sendTo(sock, { msg_type: call, error: { code, message }, req_id: reqId });
  }
  function onMessage(sock, raw) {
    let req;
    try { req = JSON.parse(raw); } catch (_) { sendError(sock, 'unknown', undefined, 'InputValidationFailed', 'Request is not valid JSON.'); return; }
    const call = req && typeof req === 'object' ? Object.keys(req).find((k) => k !== 'req_id' && Object.hasOwn(HANDLERS, k)) : undefined;
    if (!call) { sendError(sock, 'unknown', req && req.req_id, 'InputValidationFailed', 'No known call in request.'); return; }
    stats.calls[call] = (stats.calls[call] || 0) + 1;
    try {
      if (AUTH_CALLS.has(call) && !sock.authed) throw new MockError('AuthorizationRequired', 'Please log in.');
      const out = HANDLERS[call](sock, req[call], req);
      const msg = { msg_type: out.type, [out.type]: out.body, req_id: req.req_id };
      if (out.subscription !== undefined) msg.subscription = { id: out.subscription };
      sendTo(sock, msg);
    } catch (e) {
      sendError(sock, call, req.req_id, e instanceof MockError ? e.code : 'InternalError', e.message);
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  function handleHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Deriv-App-ID, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://mock');
    const otpMatch = /^\/trading\/v1\/options\/accounts\/([^/]+)\/otp$/.exec(url.pathname);
    const isList = url.pathname === '/trading/v1/options/accounts' && req.method === 'GET';
    if (!isList && !(otpMatch && req.method === 'POST')) {
      sendJson(res, 404, { error: { code: 'NotFound', message: 'Unknown mock route.' } });
      return;
    }
    const denied = restCheck(req);
    if (denied) {
      stats.rejects += 1;
      sendJson(res, 401, { error: denied });
      return;
    }
    if (isList) {
      const data = accounts.map(({ account_id, account_type, currency, balance }) => ({ account_id, account_type, currency, balance }));
      sendJson(res, 200, { data, meta: {} });
      return;
    }
    const acc = acct(decodeURIComponent(otpMatch[1]));
    if (!acc) { sendJson(res, 404, { error: { code: 'NotFound', message: 'Unknown account.' } }); return; }
    const otp = randomBytes(12).toString('hex');
    otps.set(otp, { accountId: acc.account_id, expires: Date.now() + OTP_TTL_MS });
    stats.otpIssued += 1;
    sendJson(res, 200, { data: { url: `ws://${req.headers.host}/trading/v1/options/ws/${acc.account_type}?otp=${otp}` }, meta: {} });
  }

  const http = createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const profile = routeSocket(new URL(req.url, 'http://mock'));
    if (!profile) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (profile.rejected) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, profile));
  });

  return new Promise((resolvePromise, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => {
      const actual = http.address().port;
      timer = setInterval(tick, TICK_MS);
      resolvePromise({
        url: `http://127.0.0.1:${actual}`,
        wsUrl: `ws://127.0.0.1:${actual}`,
        port: actual,
        tokens,
        stats,
        close: () => new Promise((done) => {
          clearInterval(timer);
          for (const ws of sockets) ws.terminate();
          subs.clear();
          wss.close();
          http.closeAllConnections();
          http.close(() => done());
        }),
      });
    });
  });
}

// Standalone: node tests/mock-deriv.mjs --port 8787
async function main() {
  const i = process.argv.indexOf('--port');
  const port = i === -1 ? 8787 : Number(process.argv[i + 1]);
  const mock = await startMockServer({ port });
  console.log(`Krabby mock Deriv: ${mock.url}`);
  console.log(`  new public socket : ${mock.wsUrl}/trading/v1/options/ws/public`);
  console.log(`  legacy socket     : ${mock.wsUrl}/websockets/v3?app_id=1089 (send authorize with "${MOCK_TOKEN}")`);
  console.log('Press Ctrl+C to stop.');
  process.on('SIGINT', async () => { await mock.close(); process.exit(0); });
}
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
