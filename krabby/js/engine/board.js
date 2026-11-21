// The signal board: the only shared path between engines. Engines read it through a read-only view.
// Snapshot rule: each run of an engine for (asset, tf) publishes that engine's full current view, stamped with runMs.
// Queries return the current run by default: the newest runMs seen for each engine, asset and timeframe.
// The audit log is append-only. Pure: no DOM, no storage. The app persists the audit log through onAppend.

export class AuditLog {
  constructor({ max = 50000 } = {}) {
    this.max = Math.max(100, max | 0);
    this.items = [];
    this.seq = 0;
    this.onAppend = null;
  }

  append(kind, data = {}, atMs = 0) {
    this.seq += 1;
    const entry = { seq: this.seq, atMs, kind, ...data };
    this.items.push(entry);
    if (this.items.length > this.max * 1.1) this.items.splice(0, this.items.length - this.max);
    if (this.onAppend) this.onAppend(entry);
    return entry;
  }

  // Newest last. Optional filter by kind and by a minimum seq (for incremental saves).
  list({ kind = null, sinceSeq = 0, limit = 500 } = {}) {
    const out = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const e = this.items[i];
      if (e.seq <= sinceSeq) break;
      if (kind && e.kind !== kind) continue;
      out.push(e);
    }
    return out.reverse();
  }

  size() {
    return this.items.length;
  }

  // Replaces the in-memory log with saved entries (oldest first). Used at start-up.
  load(entries) {
    const list = Array.isArray(entries) ? entries.slice(-this.max) : [];
    this.items = list;
    this.seq = list.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  }
}

export class Board {
  constructor({ audit = null, maxPerKey = 400 } = {}) {
    this.audit = audit;
    this.maxPerKey = Math.max(10, maxPerKey | 0);
    this.byId = new Map();
    this.byKey = new Map(); // "topic|asset|tf" -> [ids], oldest first
    this.runs = new Map(); // "engine|asset|tf" -> newest runMs published
    // Indexes that make "the current run" cheap to read (every candle asks for it many times):
    this.keyMeta = new Map(); // "topic|asset|tf" -> { topic, asset, tf }
    this.latestRun = new Map(); // "topic|asset|tf" -> Map(engine -> { runMs, ids }) the newest run each engine published there
    this.untimed = new Map(); // "topic|asset|tf" -> [ids] of messages with no runMs (they are always current)
    this.order = new Map(); // id -> publish order, to keep results oldest first
    this.counter = 0;
  }

  runKey(m) {
    return `${m.engine}|${m.asset}|${m.tf}`;
  }

  // Marks a run even when it published nothing, so an empty snapshot replaces the previous one.
  markRun(engine, asset, tf, runMs) {
    const k = `${engine}|${asset}|${tf}`;
    const prev = this.runs.get(k);
    if (prev === undefined || runMs > prev) this.runs.set(k, runMs);
  }

  // True when the message belongs to the newest run of its engine, asset and timeframe.
  isCurrent(m) {
    if (typeof m.runMs !== 'number') return true;
    return this.runs.get(this.runKey(m)) === m.runMs;
  }

  // Publishes messages. Duplicate ids are ignored, so a re-run of the same candle changes nothing.
  // Audit: only findings made on the newest candle (atMs === runMs) and superseding messages are logged.
  publish(messages, { audit = true } = {}) {
    const ids = [];
    for (const m of messages) {
      if (!m || !m.id || !m.topic || !m.asset) throw new Error('Board: a message needs an id, a topic and an asset.');
      if (this.byId.has(m.id)) continue;
      this.byId.set(m.id, m);
      this.order.set(m.id, this.counter += 1);
      const key = `${m.topic}|${m.asset}|${m.tf}`;
      let list = this.byKey.get(key);
      if (!list) {
        list = [];
        this.byKey.set(key, list);
        this.keyMeta.set(key, { topic: m.topic, asset: m.asset, tf: m.tf });
      }
      list.push(m.id);
      if (list.length > this.maxPerKey) {
        const gone = list.splice(0, list.length - this.maxPerKey);
        for (const old of gone) { this.byId.delete(old); this.order.delete(old); }
        const un = this.untimed.get(key);
        if (un && un.length) {
          // The always-current ids are in publish order too, so the ones that were pruned are a prefix.
          const drop = new Set(gone);
          let i = 0;
          while (i < un.length && drop.has(un[i])) i += 1;
          if (i) un.splice(0, i);
        }
      }
      if (typeof m.runMs === 'number') {
        const rk = this.runKey(m);
        const prev = this.runs.get(rk);
        if (prev === undefined || m.runMs > prev) this.runs.set(rk, m.runMs);
        let engines = this.latestRun.get(key);
        if (!engines) { engines = new Map(); this.latestRun.set(key, engines); }
        const cur = engines.get(m.engine);
        if (!cur || m.runMs > cur.runMs) engines.set(m.engine, { runMs: m.runMs, ids: [m.id] });
        else if (m.runMs === cur.runMs) cur.ids.push(m.id);
      } else {
        const un = this.untimed.get(key);
        if (un) un.push(m.id); else this.untimed.set(key, [m.id]);
      }
      const logIt = typeof m.runMs !== 'number' || m.atMs === m.runMs || Boolean(m.supersedes);
      if (audit && this.audit && logIt) {
        this.audit.append('message', {
          id: m.id, engine: m.engine, asset: m.asset, tf: m.tf, topic: m.topic, type: m.type, validity: m.validity, summary: m.summary,
        }, m.atMs);
      }
      ids.push(m.id);
    }
    return ids;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  // Messages for a topic, market and timeframe (any filter may be omitted). Oldest first.
  // current: true (default) keeps only the newest run of each engine; false returns every stored run.
  query({ topic = null, asset = null, tf = null, engine = null, type = null, validOnly = false, current = true, limit = 0 } = {}) {
    let out = [];
    const useKey = topic && asset && tf !== null && tf !== undefined;
    const keys = useKey
      ? [`${topic}|${asset}|${tf}`]
      : [...this.byKey.keys()].filter((key) => {
        const meta = this.keyMeta.get(key);
        return (!topic || meta.topic === topic) && (!asset || meta.asset === asset) && (tf === null || tf === undefined || String(meta.tf) === String(tf));
      });
    for (const key of keys) {
      const ids = current ? this._currentIds(key) : (this.byKey.get(key) || []);
      for (const id of ids) {
        const m = this.byId.get(id);
        if (!m) continue;
        if (engine && m.engine !== engine) continue;
        if (type && m.type !== type) continue;
        if (validOnly && m.validity !== 'valid') continue;
        out.push(m);
      }
    }
    if (!useKey) out.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (limit) out = out.slice(-limit);
    return out;
  }

  // Ids under one key that belong to the newest run of their engine, oldest first. An engine's newest run under this key counts
  // only while it is also the newest run that engine made for the market and timeframe (a later run that published nothing here
  // replaces it), which is the same rule isCurrent applies to a single message.
  _currentIds(key) {
    const meta = this.keyMeta.get(key);
    if (!meta) return [];
    const ids = [];
    const engines = this.latestRun.get(key);
    if (engines) {
      for (const [eng, cur] of engines) {
        if (this.runs.get(`${eng}|${meta.asset}|${meta.tf}`) === cur.runMs) for (const id of cur.ids) ids.push(id);
      }
    }
    const un = this.untimed.get(key);
    if (un) for (const id of un) ids.push(id);
    if (ids.length > 1) ids.sort((a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0));
    return ids;
  }

  // Newest message for a topic and market, valid only by default. Optional type filter. Current run by default.
  latest(topic, asset, tf, { type = null, validOnly = true, current = true } = {}) {
    const key = `${topic}|${asset}|${tf}`;
    const ids = current ? this._currentIds(key) : (this.byKey.get(key) || []);
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const m = this.byId.get(ids[i]);
      if (!m) continue;
      if (type && m.type !== type) continue;
      if (validOnly && m.validity !== 'valid') continue;
      return m;
    }
    return null;
  }

  // Publishes a new message that names the one it replaces, with validity 'invalidated'. Never edits the old one.
  invalidate(id, reason, atMs) {
    const old = this.byId.get(id);
    if (!old) return null;
    const next = {
      ...old,
      id: `${old.id}>inv`,
      supersedes: old.id,
      validity: 'invalidated',
      summary: reason || `Invalidated: ${old.summary}`,
      atMs: atMs ?? old.atMs,
    };
    this.publish([next]);
    return next;
  }

  // Read-only view handed to engines. They can query and read, never publish.
  view() {
    return {
      query: (q) => this.query(q),
      latest: (topic, asset, tf, opts) => this.latest(topic, asset, tf, opts),
      get: (id) => this.get(id),
    };
  }

  stats() {
    return { keys: this.byKey.size, messages: this.byId.size, runs: this.runs.size };
  }
}
