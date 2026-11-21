// The strategy sandbox core: check a strategy's code, compile it with the dangerous names shadowed, give it a context
// bar by bar, and collect and validate the signals it returns.
// Pure: no DOM, storage, network or clock. The worker imports it, and Node tests run it in-process.
//
// THIS IS NOT A SECURITY BOUNDARY. It limits what honest and careless code can reach (decision D11). Code written to
// get out can try harder than these layers. Run only code you have read. The layers are:
//   1. a static scan that refuses the names below with a clear message,
//   2. a wrapper that shadows those names, so a name the scan missed is undefined,
//   3. in the worker only: the same names are removed from the worker's own global object and Function.prototype.constructor
//      is switched off before any strategy code runs (worker.js), and
//   4. the host (host.js) kills the worker at the time limit.
import { sma as smaSeries, ema as emaSeries, rsi as rsiSeries, atr as atrSeries } from '../engine/indicators.js';
import { mean as meanOf, stdev as stdevOf } from '../core/util.js';
import { mulberry32 } from '../core/hash.js';

export const LIMITS = Object.freeze({
  lookback: 500, // bars in ctx.candles
  warmup: 20, // bars before the first onBar call
  perBar: 3, // most signals one bar may return
  maxReason: 200,
  maxError: 300,
  maxExamples: 10,
  maxExpiry: 500,
});

// Every name here is a parameter of the wrapper (so it reads as undefined in strategy code) and is refused by the scan.
export const BLOCKED_GLOBALS = Object.freeze([
  'self', 'globalThis', 'window', 'document', 'parent', 'top', 'frames', 'global',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'importScripts',
  'indexedDB', 'caches', 'navigator', 'location', 'localStorage', 'sessionStorage', 'cookieStore',
  'postMessage', 'close', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'MessagePort',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'Function', 'eval', 'Proxy', 'Reflect', 'WebAssembly', 'Atomics', 'SharedArrayBuffer',
  'process', 'require', 'module', 'exports', 'Buffer', 'performance', 'crypto', 'Date',
]);

// Property names that open a way to the Function constructor or the prototype chain. Refused wherever they appear.
export const BLOCKED_PROPS = Object.freeze(['constructor', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

// Math without random: a random strategy would give different results on every run. Use ctx.random().
const SAFE_MATH = (() => {
  const m = {};
  for (const k of Object.getOwnPropertyNames(Math)) if (k !== 'random') m[k] = Math[k];
  m.random = () => {
    throw new Error('Math.random is not allowed because results would change on every run. Use ctx.random() instead.');
  };
  return Object.freeze(m);
})();

const RealFunction = Function;

const clean = (e) => {
  const text = e && e.message ? `${e.name || 'Error'}: ${e.message}` : String(e);
  return text.length > LIMITS.maxError ? `${text.slice(0, LIMITS.maxError)}...` : text;
};

// ---------------------------------------------------------------- the static scan

// Replaces comments and the text inside strings with spaces (newlines kept), so a word in a message is not a name.
// Text inside ${ } of a template stays, because that is code.
export function stripLiterals(src) {
  const out = [];
  const stack = [];
  const n = src.length;
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const ch = src[i];
    const t = stack[stack.length - 1];
    if (t && t.type === 'tpl') {
      if (ch === '\\') {
        out.push(' ', i + 1 < n ? blank(src[i + 1]) : ' ');
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        out.push(' ');
        i += 1;
      } else if (ch === '$' && src[i + 1] === '{') {
        stack.push({ type: 'expr', depth: 0 });
        out.push(' ', ' ');
        i += 2;
      } else {
        out.push(blank(ch));
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i += 1) out.push(blank(src[i]));
      continue;
    }
    if (ch === '"' || ch === "'") {
      out.push(' ');
      i += 1;
      while (i < n && src[i] !== ch && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(' ', blank(src[i + 1]));
          i += 2;
        } else {
          out.push(' ');
          i += 1;
        }
      }
      if (i < n && src[i] === ch) {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      stack.push({ type: 'tpl' });
      out.push(' ');
      i += 1;
      continue;
    }
    if (t && t.type === 'expr') {
      if (ch === '{') t.depth += 1;
      else if (ch === '}') {
        if (t.depth === 0) {
          stack.pop();
          out.push(' ');
          i += 1;
          continue;
        }
        t.depth -= 1;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

const lineOf = (text, index) => {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
};

const GLOBAL_RE = new RegExp(`(?<![\\w$.])(${BLOCKED_GLOBALS.join('|')})(?![\\w$])`, 'g');
const PROP_RE = new RegExp(`(?<![\\w$])(${BLOCKED_PROPS.join('|')})(?![\\w$])`, 'g');
const IMPORT_RE = /(?<![\w$.])import(?![\w$])/g;

// Checks length and refuses blocked names. Returns { ok, problems: [{ line, name, text }] }.
export function scanCode(code, { maxChars = 20000 } = {}) {
  const problems = [];
  if (typeof code !== 'string' || !code.trim()) return { ok: false, problems: [{ line: 0, name: '', text: 'There is no strategy code.' }] };
  if (code.length > maxChars) return { ok: false, problems: [{ line: 0, name: '', text: `The code is ${code.length} characters long. The limit is ${maxChars}.` }] };
  const text = stripLiterals(code);
  const seen = new Set();
  const add = (re, make) => {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m) {
      const line = lineOf(text, m.index);
      const key = `${line}:${m[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        problems.push({ line, name: m[0], text: make(m[0], line) });
      }
      m = re.exec(text);
    }
  };
  add(GLOBAL_RE, (name, line) => `Line ${line}: "${name}" is not available in strategy code.`);
  add(PROP_RE, (name, line) => `Line ${line}: ".${name}" is not allowed in strategy code.`);
  add(IMPORT_RE, (name, line) => `Line ${line}: "import" is not allowed in strategy code.`);
  problems.sort((a, b) => a.line - b.line);
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- compile

// Wraps the code so every blocked name is a parameter (undefined) and the code itself is in strict mode. The outer
// wrapper is sloppy on purpose: a strict function cannot have a parameter named eval.
export function compileStrategy(code) {
  const body = `return (function () { "use strict";\n${code}\n;return typeof onBar === 'function' ? onBar : undefined; })();`;
  let factory;
  try {
    factory = new RealFunction(...BLOCKED_GLOBALS, 'Math', body);
  } catch (e) {
    return { ok: false, code: 'compile_error', error: `The code does not compile. ${clean(e)}` };
  }
  let onBar;
  try {
    onBar = factory.call(undefined, ...BLOCKED_GLOBALS.map(() => undefined), SAFE_MATH);
  } catch (e) {
    return { ok: false, code: 'load_error', error: `The code failed before the first bar. ${clean(e)}` };
  }
  if (typeof onBar !== 'function') return { ok: false, code: 'no_onbar', error: 'The code must define function onBar(ctx).' };
  return { ok: true, onBar };
}

// ---------------------------------------------------------------- the context given to onBar

const HELPERS = Object.freeze({
  mean: (xs) => meanOf(Array.isArray(xs) ? xs : []),
  sum: (xs) => (Array.isArray(xs) ? xs.reduce((a, b) => a + b, 0) : NaN),
  stdev: (xs) => stdevOf(Array.isArray(xs) ? xs : []),
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  round: (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d,
  pct: (from, to) => (from ? ((to - from) / Math.abs(from)) * 100 : NaN),
  body: (c) => Math.abs(c.close - c.open),
  range: (c) => c.high - c.low,
  upperWick: (c) => c.high - Math.max(c.open, c.close),
  lowerWick: (c) => Math.min(c.open, c.close) - c.low,
  isBull: (c) => c.close > c.open,
  isBear: (c) => c.close < c.open,
});

function makeContext(all, params, tf, lookback, seed) {
  let cur = 0;
  const cache = new Map();
  const series = (kind, period) => {
    const p = Math.max(1, Math.floor(Number(period)) || 14);
    const key = `${kind}:${p}`;
    let s = cache.get(key);
    if (!s) {
      // Each of these is causal: the value at bar k uses bars 0..k only, so reading it at the current bar looks ahead nowhere.
      if (kind === 'ema') s = emaSeries(all.map((c) => c.close), p);
      else if (kind === 'sma') s = smaSeries(all.map((c) => c.close), p);
      else if (kind === 'rsi') s = rsiSeries(all.map((c) => c.close), p);
      else s = atrSeries(all, p);
      cache.set(key, s);
    }
    return s;
  };
  const at = (kind, period, back) => {
    const k = cur - Math.max(0, Math.floor(Number(back)) || 0);
    return k >= 0 ? series(kind, period)[k] : NaN;
  };
  const window = (n, back) => {
    const len = Math.max(1, Math.floor(Number(n)) || 1);
    const end = cur - Math.max(0, Math.floor(Number(back)) || 0);
    const start = end - len + 1;
    return start >= 0 && end <= cur ? all.slice(start, end + 1) : null;
  };
  const rand = mulberry32(seed);
  const ctx = {
    tf,
    params,
    helpers: HELPERS,
    atr: (n = 14, back = 0) => at('atr', n, back),
    ema: (n, back = 0) => at('ema', n, back),
    sma: (n, back = 0) => at('sma', n, back),
    rsi: (n = 14, back = 0) => at('rsi', n, back),
    candle: (back = 0) => {
      const k = cur - (Math.max(0, Math.floor(Number(back)) || 0));
      return k >= 0 ? all[k] : null;
    },
    // The n highest highs and lowest lows, over the n bars that end `back` bars before this one. NaN when there are fewer.
    highest: (n, back = 0) => {
      const w = window(n, back);
      return w ? Math.max(...w.map((c) => c.high)) : NaN;
    },
    lowest: (n, back = 0) => {
      const w = window(n, back);
      return w ? Math.min(...w.map((c) => c.low)) : NaN;
    },
    closes: (n, back = 0) => {
      const w = window(n, back);
      return w ? w.map((c) => c.close) : [];
    },
    random: () => rand(),
  };
  Object.defineProperties(ctx, {
    i: { get: () => cur, enumerable: true },
    time: { get: () => all[cur].epoch, enumerable: true },
    candles: { get: () => all.slice(Math.max(0, cur - lookback + 1), cur + 1), enumerable: true },
  });
  Object.freeze(ctx);
  return { ctx, setBar: (i) => { cur = i; } };
}

// ---------------------------------------------------------------- signals

const SIDE_ALIAS = { buy: 'buy', long: 'buy', sell: 'sell', short: 'sell' };
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// One raw return value to a clean signal, or { reject: code }.
export function normaliseSignal(raw, bar, index, defaults = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reject: 'not_an_object' };
  const side = SIDE_ALIAS[String(raw.side || '').toLowerCase()];
  if (!side) return { reject: 'bad_side' };
  const entry = raw.entry === undefined || raw.entry === null ? bar.close : raw.entry;
  if (!finite(entry) || !finite(raw.stop) || !finite(raw.target)) return { reject: 'not_a_number' };
  const ok = side === 'buy' ? raw.stop < entry && entry < raw.target : raw.target < entry && entry < raw.stop;
  if (!ok) return { reject: 'bad_geometry' };
  if (!(entry > 0 && raw.stop > 0 && raw.target > 0)) return { reject: 'bad_price' };
  const out = { index, side, entry, stop: raw.stop, target: raw.target, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, LIMITS.maxReason) : '' };
  const ex = raw.expiryBars === undefined || raw.expiryBars === null ? defaults.expiryBars : raw.expiryBars;
  if (finite(ex)) out.expiryBars = Math.max(1, Math.min(LIMITS.maxExpiry, Math.floor(ex)));
  return out;
}

const failure = (code, error, extra = {}) => ({ ok: false, code, error, signals: [], ...extra });

// Runs the strategy over the candles, bar by bar. A signal returned at bar i is made from bars 0..i only; the backtest
// places it as a limit order that can fill from bar i + 1 on.
// Returns { ok, signals, rejected: { total, byReason, examples }, truncated, barsRun, firstBar }
// or { ok: false, code, error, errorBar? }.
export function runSandboxed({ code, candles, params = {}, maxSignals = 5000, warmup = LIMITS.warmup, lookback = LIMITS.lookback, expiryBars = null, maxCodeChars = 200000, tf = 0, seed = null } = {}) {
  const scan = scanCode(code, { maxChars: maxCodeChars });
  if (!scan.ok) return failure('blocked_code', scan.problems.map((p) => p.text).join(' '), { problems: scan.problems });
  if (!Array.isArray(candles) || candles.length < 2) return failure('bad_input', 'The strategy needs at least two candles.');
  const all = new Array(candles.length);
  let prev = -Infinity;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (!c || !finite(c.epoch) || !finite(c.open) || !finite(c.high) || !finite(c.low) || !finite(c.close) || c.epoch <= prev) {
      return failure('bad_input', `Candle ${i} is missing a number, or is out of order.`);
    }
    prev = c.epoch;
    all[i] = Object.freeze({ epoch: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  Object.freeze(all);
  let frozenParams;
  try {
    frozenParams = Object.freeze(JSON.parse(JSON.stringify(params || {})));
  } catch (_) {
    return failure('bad_input', 'The strategy parameters must be plain JSON.');
  }

  const built = compileStrategy(code);
  if (!built.ok) return failure(built.code, built.error);

  const seedValue = finite(frozenParams.seed) ? frozenParams.seed >>> 0 : (finite(seed) ? seed >>> 0 : 1);
  const { ctx, setBar } = makeContext(all, frozenParams, Number(tf) || 0, Math.max(2, Math.floor(lookback) || LIMITS.lookback), seedValue);
  const cap = Math.max(1, Math.floor(maxSignals));
  const first = Math.max(1, Math.floor(warmup) || 0);
  const signals = [];
  const rejected = { total: 0, byReason: {}, examples: [] };
  const reject = (code2, index) => {
    rejected.total += 1;
    rejected.byReason[code2] = (rejected.byReason[code2] || 0) + 1;
    if (rejected.examples.length < LIMITS.maxExamples) rejected.examples.push({ index, reason: code2 });
  };
  let truncated = false;
  let barsRun = 0;
  for (let i = first; i < all.length; i += 1) {
    setBar(i);
    let out;
    try {
      out = built.onBar(ctx);
    } catch (e) {
      return failure('runtime_error', `Bar ${i}: ${clean(e)}`, { errorBar: i });
    }
    barsRun += 1;
    if (out && typeof out.then === 'function') return failure('async_onbar', 'onBar must return its signal directly. It cannot return a promise.', { errorBar: i });
    if (!out) continue;
    const list = Array.isArray(out) ? out : [out];
    let used = 0;
    for (const raw of list) {
      if (used >= LIMITS.perBar) {
        reject('too_many_on_bar', i);
        continue;
      }
      const sig = normaliseSignal(raw, all[i], i, { expiryBars });
      if (sig.reject) {
        reject(sig.reject, i);
        continue;
      }
      signals.push(sig);
      used += 1;
      if (signals.length >= cap) break;
    }
    if (signals.length >= cap) {
      truncated = i < all.length - 1;
      break;
    }
  }
  return { ok: true, signals, rejected, truncated, barsRun, firstBar: first };
}

// What the strategy editor shows as help. Plain words.
export const API_DOC = Object.freeze([
  { name: 'function onBar(ctx)', text: 'Called once for every closed candle, oldest first. Return null for nothing, one signal object, or an array of signals.' },
  { name: 'signal', text: '{ side: "buy" | "sell", entry, stop, target, reason, expiryBars } . Every signal is a LIMIT order. entry defaults to the close of this bar. A buy needs stop < entry < target; a sell needs target < entry < stop. reason is shown in the results.' },
  { name: 'ctx.i, ctx.time, ctx.tf', text: 'Index of this bar, its open time in seconds, and the timeframe in seconds.' },
  { name: 'ctx.candle(back = 0)', text: 'The candle `back` bars ago ({ epoch, open, high, low, close }), or null before the start. Candles cannot be changed.' },
  { name: 'ctx.candles', text: 'The most recent 500 candles up to and including this one, oldest first.' },
  { name: 'ctx.ema(n, back), ctx.sma(n, back), ctx.rsi(n, back), ctx.atr(n, back)', text: 'Indicator values at this bar, or `back` bars ago. NaN until there is enough history. They use only bars up to this one.' },
  { name: 'ctx.highest(n, back), ctx.lowest(n, back)', text: 'Highest high and lowest low of the n bars that end `back` bars before this one. NaN when there are fewer.' },
  { name: 'ctx.closes(n, back)', text: 'Array of n closes ending `back` bars before this one.' },
  { name: 'ctx.params', text: 'The parameter object saved with the strategy. Read only.' },
  { name: 'ctx.random()', text: 'A repeatable random number from 0 to 1 (set params.seed to change it). Math.random is not allowed.' },
  { name: 'ctx.helpers', text: 'mean, sum, stdev, clamp, round, pct, body, range, upperWick, lowerWick, isBull, isBear.' },
  { name: 'State', text: 'Variables you declare above onBar keep their value from bar to bar.' },
  { name: 'Not available', text: `${BLOCKED_GLOBALS.join(', ')}.` },
  { name: 'Limits', text: 'A time limit per run, a cap on signals and on code length (Settings, Strategy sandbox). The sandbox is not a security boundary: run only code you have read.' },
]);
