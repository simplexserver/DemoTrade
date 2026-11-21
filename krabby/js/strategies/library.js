// The strategy library: named strategies, each with a version history. Every save adds a version and old versions are
// kept (the newest 20), so a change can always be undone. Pure apart from the injected persist hook and clock.
// Entries are plain JSON, so the store, the IndexedDB adapter and export/import can all carry them as they are.

const MAX_NAME = 60;
const MAX_PARAMS_CHARS = 4000;

const plain = (x) => JSON.parse(JSON.stringify(x));

// Returns { ok: true, value } with a clean copy, or { ok: false, error }.
function cleanParams(params) {
  if (params === undefined || params === null) return { ok: true, value: {} };
  if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'The parameters must be an object, for example { "fast": 9 }.' };
  let text;
  try {
    text = JSON.stringify(params);
  } catch (_) {
    return { ok: false, error: 'The parameters must be plain JSON.' };
  }
  if (text.length > MAX_PARAMS_CHARS) return { ok: false, error: `The parameters are too long (${text.length} characters, the limit is ${MAX_PARAMS_CHARS}).` };
  return { ok: true, value: JSON.parse(text) };
}

export class StrategyLibrary {
  constructor({ persist = null, nowFn = () => Date.now(), maxVersions = 20, maxStrategies = 100, maxCodeChars = 200000 } = {}) {
    this.persistFn = typeof persist === 'function' ? persist : null;
    this.nowFn = nowFn;
    this.maxVersions = Math.max(1, Math.floor(maxVersions));
    this.maxStrategies = Math.max(1, Math.floor(maxStrategies));
    this.maxCodeChars = maxCodeChars;
    this.map = new Map();
  }

  _changed() {
    if (!this.persistFn) return;
    try {
      const r = this.persistFn(this.export());
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) { /* saving is best effort; the library in memory is still right */ }
  }

  _nextId() {
    let top = 0;
    for (const id of this.map.keys()) {
      const n = Number(String(id).replace(/^S/, ''));
      if (Number.isFinite(n) && n > top) top = n;
    }
    return `S${top + 1}`;
  }

  _view(entry, v) {
    return { id: entry.id, name: v.name, code: v.code, params: plain(v.params), version: v.version, createdMs: entry.createdMs, updatedMs: v.savedMs };
  }

  list() {
    const rows = [];
    for (const e of this.map.values()) {
      const v = e.versions[e.versions.length - 1];
      rows.push({ id: e.id, name: v.name, version: v.version, versions: e.versions.length, createdMs: e.createdMs, updatedMs: v.savedMs, codeLength: v.code.length });
    }
    return rows.sort((a, b) => b.updatedMs - a.updatedMs || a.id.localeCompare(b.id, 'en', { numeric: true }));
  }

  get(id) {
    const e = this.map.get(id);
    return e ? this._view(e, e.versions[e.versions.length - 1]) : null;
  }

  getVersion(id, versionNo) {
    const e = this.map.get(id);
    const v = e ? e.versions.find((x) => x.version === Number(versionNo)) : null;
    return v ? this._view(e, v) : null;
  }

  // Newest first. Code is left out to keep the list light; getVersion has it.
  versions(id) {
    const e = this.map.get(id);
    if (!e) return [];
    return e.versions.slice().reverse().map((v) => ({ version: v.version, savedMs: v.savedMs, name: v.name, codeLength: v.code.length, params: plain(v.params), note: v.note || '' }));
  }

  // save({ id?, name, code, params }) -> { ok, id, version, unchanged? } or { ok: false, error }.
  save({ id = null, name, code, params = {}, note = '' } = {}) {
    const nm = typeof name === 'string' ? name.trim() : '';
    if (!nm) return { ok: false, error: 'Give the strategy a name.' };
    if (nm.length > MAX_NAME) return { ok: false, error: `The name is too long (${MAX_NAME} characters at most).` };
    if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'There is no code to save.' };
    if (code.length > this.maxCodeChars) return { ok: false, error: `The code is ${code.length} characters long. The limit is ${this.maxCodeChars}.` };
    const p = cleanParams(params);
    if (!p.ok) return p;
    const now = this.nowFn();
    let entry = id ? this.map.get(id) : null;
    if (id && !entry) return { ok: false, error: 'That strategy does not exist (it may have been deleted).' };
    if (!entry) {
      if (this.map.size >= this.maxStrategies) return { ok: false, error: `The library holds ${this.maxStrategies} strategies at most. Delete one first.` };
      entry = { id: this._nextId(), createdMs: now, nextVersion: 1, versions: [] };
      this.map.set(entry.id, entry);
    } else {
      const last = entry.versions[entry.versions.length - 1];
      if (last.name === nm && last.code === code && JSON.stringify(last.params) === JSON.stringify(p.value)) {
        return { ok: true, id: entry.id, version: last.version, unchanged: true };
      }
    }
    const version = entry.nextVersion;
    entry.nextVersion += 1;
    entry.versions.push({ version, savedMs: now, name: nm, code, params: p.value, note: String(note || '').slice(0, 120) });
    if (entry.versions.length > this.maxVersions) entry.versions.splice(0, entry.versions.length - this.maxVersions);
    this._changed();
    return { ok: true, id: entry.id, version };
  }

  // Saves the old version again as the newest one. History is never rewritten.
  restoreVersion(id, versionNo) {
    const v = this.getVersion(id, versionNo);
    if (!v) return { ok: false, error: 'That version does not exist.' };
    return this.save({ id, name: v.name, code: v.code, params: v.params, note: `Restored from version ${v.version}` });
  }

  remove(id) {
    const had = this.map.delete(id);
    if (had) this._changed();
    return had;
  }

  // Replaces the library with saved entries. Anything damaged is dropped. Returns how many strategies were kept.
  load(entries) {
    this.map.clear();
    for (const raw of Array.isArray(entries) ? entries : []) {
      if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.versions)) continue;
      const versions = [];
      for (const v of raw.versions) {
        if (!v || typeof v.code !== 'string' || typeof v.name !== 'string' || !Number.isFinite(v.version)) continue;
        const p = cleanParams(v.params);
        versions.push({ version: v.version, savedMs: Number.isFinite(v.savedMs) ? v.savedMs : 0, name: v.name.slice(0, MAX_NAME), code: v.code.slice(0, this.maxCodeChars), params: p.ok ? p.value : {}, note: typeof v.note === 'string' ? v.note.slice(0, 120) : '' });
      }
      if (!versions.length) continue;
      versions.sort((a, b) => a.version - b.version);
      const top = versions[versions.length - 1].version;
      this.map.set(raw.id, { id: raw.id, createdMs: Number.isFinite(raw.createdMs) ? raw.createdMs : versions[0].savedMs, nextVersion: Math.max(top + 1, Number.isFinite(raw.nextVersion) ? raw.nextVersion : 0), versions: versions.slice(-this.maxVersions) });
    }
    return this.map.size;
  }

  export() {
    return [...this.map.values()].map((e) => ({ id: e.id, createdMs: e.createdMs, nextVersion: e.nextVersion, versions: plain(e.versions) }));
  }
}
