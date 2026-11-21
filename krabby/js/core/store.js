// Persistent state for the paper build. Settings are validated by the schema and kept in localStorage,
// but only while the storage consent is 'accepted'. Without consent everything lives in memory until the
// page closes. The Deriv token (never used by the paper build, kept for api.js) lives in sessionStorage only:
// never localStorage, never a cookie (D2). Every storage call is wrapped, so blocked storage cannot throw.
import { EVENTS } from '../config.js';
import { bus as defaultBus } from './bus.js';
import { consent as defaultConsent } from './consent.js';
import { idb as defaultIdb } from './idb.js';
import * as defaultSchema from './schema.js';
import { deepClone, isPlainObject } from './util.js';

export const KEYS = Object.freeze({ settings: 'krabby.v2.settings', data: 'krabby.v2.data', daily: 'krabby.v2.daily', token: 'krabby.v2.token' });
export const EXPORT_FORMAT = 'krabby-export';
export const EXPORT_VERSION = 2;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(node[parts[i]])) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}
const getPath = (obj, path) => path.split('.').reduce((n, p) => (n !== null && typeof n === 'object' ? n[p] : undefined), obj);

// storage: localStorage-like. session: sessionStorage-like. Both are looked up lazily when left undefined.
// idb: the IndexedDB wrapper. consent: { allowsStorage() }. schema: the schema module (SCHEMA, coerce, ...).
export function createStore({ storage, session, idb = defaultIdb, consent = defaultConsent, schema = defaultSchema, bus = defaultBus } = {}) {
  const local = () => { try { return storage === undefined ? globalThis.localStorage || null : storage; } catch (_) { return null; } };
  const sess = () => { try { return session === undefined ? globalThis.sessionStorage || null : session; } catch (_) { return null; } };
  const allowed = () => { try { return consent.allowsStorage() === true; } catch (_) { return false; } };
  const read = (s, key) => { try { return s ? s.getItem(key) : null; } catch (_) { return null; } };
  const write = (s, key, value) => { try { if (!s) return false; s.setItem(key, value); return true; } catch (_) { return false; } };
  const remove = (s, key) => { try { if (s) s.removeItem(key); } catch (_) { /* ignore */ } };
  const parse = (text) => { try { const v = JSON.parse(text); return isPlainObject(v) ? v : null; } catch (_) { return null; } };

  let rawSettings = {};   // only values that passed coerce, as a nested tree
  let data = {};          // other app data, by top-level name
  let daily = {};         // { loginid: { dayKey: balance } }
  let memToken = '';
  let cache = null;

  // Settings need the consent. Other data also needs the 'store.persist' switch.
  const persistSettings = () => { if (allowed()) write(local(), KEYS.settings, JSON.stringify(rawSettings)); };
  const persistData = () => {
    if (allowed() && api.settings().store.persist) write(local(), KEYS.data, JSON.stringify(data));
  };
  const persistDaily = () => {
    if (allowed() && api.settings().store.persist) write(local(), KEYS.daily, JSON.stringify(daily));
  };
  const changed = (path, value) => { cache = null; bus.emit(EVENTS.STORE, { path, value: deepClone(value) }); };

  // Applies one validated setting to the raw tree without persisting or emitting.
  function applyOne(key, raw) {
    const res = schema.coerce(key, raw);
    if (res.ok) setPath(rawSettings, key, deepClone(res.value));
    return res;
  }

  const api = {
    // Reads saved settings and data. Nothing is read unless the consent is 'accepted'.
    load() {
      rawSettings = {}; data = {}; daily = {}; cache = null;
      if (!allowed()) return api;
      const saved = parse(read(local(), KEYS.settings));
      if (saved) for (const row of schema.SCHEMA) { const v = getPath(saved, row.key); if (v !== undefined) applyOne(row.key, v); }
      const d = parse(read(local(), KEYS.data));
      if (d) for (const k of Object.keys(d)) if (!UNSAFE.has(k)) data[k] = d[k];
      const dd = parse(read(local(), KEYS.daily));
      if (dd) daily = dd;
      cache = null;
      return api;
    },
    // Dotted path. 'settings' and 'settings.<group>.<key>' read the normalised settings; others read data.
    get(path) {
      const parts = String(path).split('.');
      const tree = parts[0] === 'settings' ? { settings: api.settings() } : data;
      let node = tree;
      for (const p of parts) {
        if (node === null || node === undefined || typeof node !== 'object') return undefined;
        node = node[p];
      }
      return isPlainObject(node) || Array.isArray(node) ? deepClone(node) : node;
    },
    // 'settings.<key>' goes through setSetting (and throws on a rejected value). Other paths store data.
    set(path, value) {
      const parts = String(path).split('.');
      if (UNSAFE.has(parts[0]) || parts.some((p) => UNSAFE.has(p))) throw new Error('That name is not allowed.');
      if (parts[0] === 'settings') {
        const key = parts.slice(1).join('.');
        if (schema.SCHEMA_BY_KEY[key]) {
          const res = api.setSetting(key, value);
          if (!res.ok) throw new Error(res.error);
          return res.value;
        }
        if (isPlainObject(value)) { api.patch(path, value); return value; }
        throw new Error(`Unknown setting: ${key}`);
      }
      setPath(data, path, deepClone(value));
      persistData();
      changed(path, value);
      return value;
    },
    // Shallow-merges an object into the value at path. For settings, every key is validated on its own;
    // the result lists the keys that were rejected.
    patch(path, obj) {
      if (!isPlainObject(obj)) throw new Error('A patch must be an object.');
      const parts = String(path).split('.');
      if (parts[0] === 'settings') {
        const prefix = parts.slice(1).join('.');
        const errors = [];
        for (const k of Object.keys(obj)) {
          const key = prefix ? `${prefix}.${k}` : k;
          const res = schema.SCHEMA_BY_KEY[key] ? api.setSetting(key, obj[k]) : { ok: false, error: `Unknown setting: ${key}` };
          if (!res.ok) errors.push({ key, error: res.error });
        }
        return { ok: errors.length === 0, errors };
      }
      const current = api.get(path);
      return api.set(path, { ...(isPlainObject(current) ? current : {}), ...obj });
    },
    snapshot() { return { settings: api.settings(), data: deepClone(data) }; },
    // Normalised settings: every key present, every value coerced, locked keys at their fixed value.
    settings() {
      if (!cache) cache = schema.normalise(rawSettings);
      return deepClone(cache);
    },
    // Validated by the schema. Returns { ok, value } or { ok: false, error }. Never throws.
    setSetting(key, raw) {
      const row = schema.SCHEMA_BY_KEY[key];
      if (!row) return { ok: false, error: `Unknown setting: ${key}` };
      const res = applyOne(key, raw);
      if (!res.ok) return { ok: false, error: res.error };
      persistSettings();
      changed(`settings.${key}`, res.value);
      return { ok: true, value: res.value };
    },
    resetSettings() {
      rawSettings = {};
      if (allowed()) remove(local(), KEYS.settings);
      changed('settings', null);
      return api.settings();
    },
    // Writes what is held in memory to this device. Used the moment storage is accepted, so what the person already changed
    // on this page is kept rather than replaced by an older saved copy. Returns false (and writes nothing) without consent.
    persistNow() {
      if (!allowed()) return false;
      persistSettings();
      persistData();
      persistDaily();
      return true;
    },
    // Deletes what this app saved on the device (settings, data, daily balances); the consent answer itself stays. With
    // memory: true the copy held on this page goes too. Always allowed, because taking consent back must always work.
    forget({ memory = false } = {}) {
      for (const k of [KEYS.settings, KEYS.data, KEYS.daily]) remove(local(), k);
      if (memory) { rawSettings = {}; data = {}; daily = {}; cache = null; changed('forget', null); }
      return true;
    },
    // One plain object for a backup file. Locked settings, the token and the log are never included.
    exportAll() {
      const flat = {};
      const norm = api.settings();
      for (const row of schema.SCHEMA) if (!row.locked) flat[row.key] = deepClone(getPath(norm, row.key));
      return { format: EXPORT_FORMAT, version: EXPORT_VERSION, settings: flat, data: deepClone(data), daily: deepClone(daily) };
    },
    // Validates every key. Unknown keys are skipped, rejected values (locked, wrong type) go to errors.
    // Returns { ok, applied: [keys], skipped: [keys], errors: [{key, error}] }.
    importAll(obj) {
      const applied = []; const skipped = []; const errors = [];
      if (!isPlainObject(obj)) return { ok: false, applied, skipped, errors: [{ key: '', error: 'The file is not a Krabby export.' }] };
      if (obj.format !== undefined && obj.format !== EXPORT_FORMAT) errors.push({ key: 'format', error: 'The file is not a Krabby export.' });
      else {
        const walk = (prefix, value) => {
          if (schema.SCHEMA_BY_KEY[prefix]) {
            const res = applyOne(prefix, value);
            if (res.ok) applied.push(prefix); else errors.push({ key: prefix, error: res.error });
          } else if (isPlainObject(value) && prefix !== '') {
            for (const k of Object.keys(value)) if (UNSAFE.has(k)) skipped.push(`${prefix}.${k}`); else walk(`${prefix}.${k}`, value[k]);
          } else skipped.push(prefix);
        };
        if (isPlainObject(obj.settings)) {
          for (const k of Object.keys(obj.settings)) if (UNSAFE.has(k)) skipped.push(k); else walk(k, obj.settings[k]);
        }
        if (isPlainObject(obj.data)) {
          for (const k of Object.keys(obj.data)) if (!UNSAFE.has(k)) { data[k] = deepClone(obj.data[k]); applied.push(`data.${k}`); }
        }
        if (isPlainObject(obj.daily)) { daily = deepClone(obj.daily); applied.push('daily'); }
        cache = null;
        persistSettings(); persistData(); persistDaily();
        changed('import', null);
      }
      return { ok: errors.length === 0, applied, skipped, errors };
    },
    // Writes one record to IndexedDB, but only with consent and the persist switch on.
    async record(storeName, value) {
      if (!allowed() || !api.settings().store.persist) return null;
      try { return await idb.put(storeName, value); } catch (_) { return null; }
    },
    idb,
    // Deriv token. sessionStorage only (D2): cleared when the tab closes, never in localStorage or a cookie.
    secrets: {
      getToken() { return read(sess(), KEYS.token) || memToken || ''; },
      hasToken() { return Boolean(api.secrets.getToken()); },
      setToken(token) {
        const value = String(token || '').trim();
        api.secrets.clearToken();
        if (!value) return;
        if (!write(sess(), KEYS.token, value)) memToken = value;
      },
      clearToken() { memToken = ''; remove(sess(), KEYS.token); },
    },
    // Start-of-day balances per account and UTC day (kept 14 days). In memory unless storage is allowed.
    dailyBalances: {
      get(loginid, dayKey) {
        const v = daily?.[loginid]?.[dayKey];
        return Number.isFinite(v) ? v : null;
      },
      setIfMissing(loginid, dayKey, balance) {
        if (UNSAFE.has(String(loginid))) return balance;
        const acct = isPlainObject(daily[loginid]) ? daily[loginid] : (daily[loginid] = {});
        if (!Number.isFinite(acct[dayKey])) {
          acct[dayKey] = balance;
          const keys = Object.keys(acct).sort();
          while (keys.length > 14) delete acct[keys.shift()];
          persistDaily();
        }
        return acct[dayKey];
      },
    },
  };
  return api;
}

export const store = createStore();
export const secrets = store.secrets;
export const dailyBalances = store.dailyBalances;
