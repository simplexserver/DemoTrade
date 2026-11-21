// App log. A ring buffer of the last 1000 entries, with redaction of anything that looks like a token.
// Never throws: logging must not be the thing that breaks the app.
import { bus } from './bus.js';
import { EVENTS } from '../config.js';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const KEY_NAME = /token|key|secret|authorization/i;
const LONG_SECRET = /[A-Za-z0-9_-]{32,}/g;
// "token=abc...", "apiKey: abc...", "Authorization: Bearer abc...", '"secret": "abc..."'
const INLINE = /([A-Za-z0-9_.-]*(?:token|key|secret|authorization)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([A-Za-z0-9_-]{32,})/gi;
const REDACTED = '[redacted]';
const MAX_STRING = 2000;

export function redactText(text) {
  return String(text).replace(INLINE, `$1${REDACTED}`).slice(0, MAX_STRING);
}

// Copies a value into plain data, redacting token-like values under token-like keys.
export function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return redactText(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (depth >= 4) return '[nested]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1, seen));
  const out = {};
  for (const k of Object.keys(value).slice(0, 40)) {
    const v = value[k];
    if (KEY_NAME.test(k) && typeof v === 'string') out[k] = v.replace(LONG_SECRET, REDACTED).slice(0, MAX_STRING);
    else out[k] = sanitize(v, depth + 1, seen);
  }
  return out;
}

export function createLog({ capacity = 1000, nowFn = () => Date.now(), emit = true } = {}) {
  let entries = [];
  let emitting = false;

  function write(level, scope, message, data) {
    try {
      const entry = {
        atMs: nowFn(),
        level,
        scope: redactText(scope === undefined ? '' : scope),
        message: redactText(message === undefined ? '' : message),
        data: data === undefined ? undefined : sanitize(data),
      };
      entries.push(entry);
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
      if (emit && !emitting) {
        emitting = true; // a listener that logs must not recurse
        try { bus.emit(EVENTS.LOG, { ...entry }); } finally { emitting = false; }
      }
      return entry;
    } catch (_) {
      return null;
    }
  }

  const api = {
    recent(n = 100) {
      try { return entries.slice(-Math.max(0, n)).map((e) => ({ ...e })); } catch (_) { return []; }
    },
    clear() { entries = []; },
    size() { return entries.length; },
    exportText() {
      try {
        return entries.map((e) => {
          const when = Number.isFinite(e.atMs) ? new Date(e.atMs).toISOString() : '-';
          const extra = e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
          return `${when} ${e.level.toUpperCase()} [${e.scope}] ${e.message}${extra}`;
        }).join('\n');
      } catch (_) { return ''; }
    },
  };
  for (const level of LEVELS) api[level] = (scope, message, data) => write(level, scope, message, data);
  return api;
}

export const log = createLog();
