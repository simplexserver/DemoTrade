// Shared helpers: formatting, maths, time, and safe parsing. No DOM, no network.
import { FORMAT_DEFAULTS } from '../config.js';

export const now = () => Date.now();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
export const round = (n, digits = 2) => {
  if (!Number.isFinite(n)) return NaN;
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
};
export const toNumber = (x, fallback = NaN) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : fallback;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};
export const sum = (arr) => arr.reduce((a, b) => a + b, 0);
export const mean = (arr) => (arr.length ? sum(arr) / arr.length : NaN);
export const stdev = (arr) => {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  return Math.sqrt(sum(arr.map((x) => (x - m) ** 2)) / (arr.length - 1));
};

let uidCounter = 0;
export const uid = (prefix = 'id') => {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
};

// ---------- Money and number display ----------
// The user's format lives in settings.format. The app sets it with setMoneyFormat() on load and on every change.
// Examples with the defaults: 28.38 -> "$28.38", 127400 -> "$127.4K", 1159 -> "$1,159.00".
// With decimalSep ',' and thousandsSep '.': 127400 -> "$127,4K", 1159 -> "$1.159,00".

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', CAD: 'C$' };
const UNITS = [{ v: 1e9, s: 'B' }, { v: 1e6, s: 'M' }, { v: 1e3, s: 'K' }];
let activeFormat = { ...FORMAT_DEFAULTS };

// Cleans a partial format object and makes it the active one. Returns the active format.
export function setMoneyFormat(next = {}) {
  const f = { ...FORMAT_DEFAULTS };
  for (const key of Object.keys(FORMAT_DEFAULTS)) {
    if (next && next[key] !== undefined) f[key] = next[key];
  }
  if (!['smart', 'full', 'compact'].includes(f.style)) f.style = FORMAT_DEFAULTS.style;
  f.smartThreshold = Math.max(0, toNumber(f.smartThreshold, FORMAT_DEFAULTS.smartThreshold));
  f.compactDecimals = clamp(Math.round(toNumber(f.compactDecimals, FORMAT_DEFAULTS.compactDecimals)), 0, 2);
  f.fullDecimals = clamp(Math.round(toNumber(f.fullDecimals, FORMAT_DEFAULTS.fullDecimals)), 0, 2);
  if (!['.', ','].includes(f.decimalSep)) f.decimalSep = FORMAT_DEFAULTS.decimalSep;
  if (![',', '.', ' ', ''].includes(f.thousandsSep)) f.thousandsSep = FORMAT_DEFAULTS.thousandsSep;
  if (f.thousandsSep === f.decimalSep) f.thousandsSep = f.decimalSep === '.' ? ',' : '.';
  f.showCurrency = f.showCurrency !== false;
  activeFormat = f;
  return { ...f };
}
export function getMoneyFormat() {
  return { ...activeFormat };
}

// Groups the digits of a whole-number string with the thousands separator (none when empty).
function groupDigits(whole, sep) {
  return sep ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : whole;
}

// Fixed decimals for a non-negative number, using the format's separators.
function plainBody(f, abs, decimals) {
  const [whole, frac] = abs.toFixed(decimals).split('.');
  const grouped = groupDigits(whole, f.thousandsSep);
  return decimals > 0 ? `${grouped}${f.decimalSep}${frac}` : grouped;
}

// K / M / B amount for a non-negative number of 1000 or more. Rounding up to 1000 moves to the next unit.
function compactBody(f, abs, decimals) {
  for (let i = 0; i < UNITS.length; i += 1) {
    const unit = UNITS[i];
    if (abs >= unit.v) {
      let text = (abs / unit.v).toFixed(decimals);
      let label = unit.s;
      if (Number(text) >= 1000 && i > 0) {
        label = UNITS[i - 1].s;
        text = (abs / UNITS[i - 1].v).toFixed(decimals);
      }
      return `${text.replace('.', f.decimalSep)}${label}`;
    }
  }
  return plainBody(f, abs, decimals);
}

// Formats a number as money with an explicit format object. digits (optional) overrides fullDecimals in full amounts.
export function formatMoneyWith(f, n, currency = 'USD', digits) {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const compact = f.style === 'compact' ? abs >= 1000 : f.style === 'smart' ? abs >= f.smartThreshold : false;
  const decimals = compact ? f.compactDecimals : (Number.isFinite(digits) ? digits : f.fullDecimals);
  const body = compact ? compactBody(f, abs, decimals) : plainBody(f, abs, decimals);
  const shownZero = !compact && Math.round(abs * 10 ** decimals) === 0;
  const sign = n < 0 && !shownZero ? '-' : '';
  if (!f.showCurrency || !currency) return `${sign}${body}`;
  const symbol = SYMBOLS[currency] || `${currency} `;
  return `${sign}${symbol}${body}`;
}

// Money in the user's format, e.g. "$28.38", "$127.4K", "-$1,159.00".
export function fmtMoney(n, currency = 'USD', digits) {
  return formatMoneyWith(activeFormat, n, currency, digits);
}
export const fmtBalance = (n, currency = 'USD') => fmtMoney(n, currency);

// Signed money with a leading + or -, e.g. "+$12.40" or "-$3.10".
export function fmtSigned(n, currency = 'USD', digits) {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) < 1e-9) return fmtMoney(0, currency, digits);
  return n > 0 ? `+${fmtMoney(n, currency, digits)}` : `-${fmtMoney(-n, currency, digits)}`;
}

// A plain number in the user's separators (no currency). Used for stakes, volumes and counts.
export function fmtNum(n, digits = 2) {
  if (!Number.isFinite(n)) return '-';
  const sign = n < 0 && Math.round(Math.abs(n) * 10 ** digits) !== 0 ? '-' : '';
  return `${sign}${plainBody(activeFormat, Math.abs(n), digits)}`;
}

// A compact number such as 1.2K or 3.45M in the user's separators.
export function fmtCompact(n, decimals = activeFormat.compactDecimals) {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return abs >= 1000 ? `${sign}${compactBody(activeFormat, abs, decimals)}` : `${sign}${plainBody(activeFormat, abs, activeFormat.fullDecimals)}`;
}

export function fmtPct(n, digits = 1) {
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(digits).replace('.', activeFormat.decimalSep)}%`;
}

export function fmtTime(ts) {
  if (!Number.isFinite(ts)) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function fmtDateTime(ts) {
  if (!Number.isFinite(ts)) return '-';
  const d = new Date(ts);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Decimal places implied by a pip size such as 0.01 (2) or 0.00001 (5).
export function decimalsForPip(pip) {
  if (!Number.isFinite(pip) || pip <= 0) return 2;
  const s = String(pip);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// UTC calendar day, e.g. "2026-10-28". Used for the daily stop.
export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Wilson score interval for a proportion. Returns the observed rate and the 95% (default) bounds.
export function wilson(successes, n, z = 1.96) {
  if (!n || n <= 0) return { p: NaN, lo: NaN, hi: NaN, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
}

export function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

// Plain-object deep clone (no functions, no class instances). Good enough for settings objects.
export function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Pull a minimum and maximum stake out of a Deriv error such as "Stake must be between 0.35 and 50000.00".
export function parseStakeLimits(message) {
  if (typeof message !== 'string') return null;
  const m = message.match(/between\s+([\d.]+)\s+and\s+([\d.]+)/i);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  const min = message.match(/minimum[^\d]*([\d.]+)/i);
  if (min) return { min: Number(min[1]), max: NaN };
  return null;
}
