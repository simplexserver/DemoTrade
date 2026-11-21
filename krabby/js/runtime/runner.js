// The runner: everything that keeps the app alive between screens. It owns the trading session and decides where candles come
// from (the simulator, an imported file, or Deriv's public feed), keeps the clock honest when a tab is throttled overnight,
// saves to this device only when the person accepted storage, keeps the screen awake, downloads deep history, runs scans
// (on background workers when the person allowed it), and hands the screens one plain snapshot to draw.
// No DOM, no direct storage and no network of its own: the page gives it the store, the consent, the IndexedDB wrapper, the
// Deriv API loader and the timers, so the same code runs in a browser and in the tests.
import { cfgFor, LEARNABLE_KEYS } from '../core/schema.js';
import { TradingSession } from './session.js';
import { createSimFeed } from '../market/feed-sim.js';
import { createDerivFeed } from '../market/feed-deriv.js';
import { parseCandles } from '../market/feed-replay.js';
import { aggregateCandles, simHistoryCandlesAsync } from '../market/aggregate.js';
import { backfill, createCandleCache } from '../market/backfill.js';
import { tfSeconds } from '../market/mde.js';
import { createPool, capabilities, probeGpu } from '../compute/pool.js';
import { RuleBook } from '../learning/rules.js';
import { runBacktest } from '../backtest/run.js';

export const SIM_WARMUP_BARS = 43800 + 600; // a month of minutes, so even the daily candles have 30 bars to analyse
const MAX_BARS_PER_TICK = 1200;
const TICK_MS = 250;
const TICK_WORK_MS = 120;
const IDB_STORES = ['journal', 'audit', 'learning', 'proposals', 'candles', 'strategies', 'meta'];
const getPath = (obj, path) => path.split('.').reduce((n, p) => (n !== null && typeof n === 'object' ? n[p] : undefined), obj);
const plain = (x) => JSON.parse(JSON.stringify(x));

export class Runner {
  // deps: { store, consent, idb, log, nowFn, timers: { setInterval, clearInterval }, workerFactory, nav, doc, loadDeriv,
  //         warmupBars, perfNow, tickWorkMs, maxBarsPerTick }  (the last three only matter to tests)
  constructor(deps = {}) {
    this.store = deps.store;
    this.consent = deps.consent;
    this.idb = deps.idb;
    this.log = deps.log || null;
    this.nowFn = deps.nowFn || (() => Date.now());
    this.timers = deps.timers || { setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: (t) => globalThis.clearInterval(t) };
    this.workerFactory = deps.workerFactory || null;
    this.nav = deps.nav === undefined ? globalThis.navigator : deps.nav;
    this.doc = deps.doc === undefined ? globalThis.document : deps.doc;
    this.loadDeriv = deps.loadDeriv || (async () => { const m = await import('../deriv/api.js'); return { api: m.deriv, cleanCandles: m.cleanCandles }; });
    this.warmupBars = deps.warmupBars ?? SIM_WARMUP_BARS;
    this.perfNow = deps.perfNow || (() => (globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance.now() : Date.now()));
    this.tickWorkMs = deps.tickWorkMs ?? TICK_WORK_MS;
    this.maxBarsPerTick = Math.max(1, deps.maxBarsPerTick ?? MAX_BARS_PER_TICK);
    this.cache = createCandleCache(this.idb);
    this.rules = new RuleBook({ nowFn: this.nowFn, onChange: () => { this._dirty = true; } });
    this.session = null;
    this.run = { status: 'stopped', source: null, message: '', startedMs: null, simBars: 0, speed: 0, error: null };
    this.history = { state: 'idle', message: '', items: [], startedMs: null, finishedMs: null };
    this.scanState = { state: 'idle', message: '', startedMs: null, finishedMs: null, current: null };
    this.lab = { state: 'idle', progress: null, result: null, error: null, label: '' };
    this.compute = { pool: null, size: 0, gpu: null };
    this._series = new Map();     // 'asset|tf' -> long candle arrays for scans and backtests
    this._listeners = new Set();
    this._timer = null;
    this._saveTimer = null;
    this._feed = null;
    this._sim = null;
    this._lastTickMs = 0;
    this._budget = 0;
    this._dirty = false;
    this._lastSaveMs = null;
    this._wake = null;
    this._histAbort = null;
    this._scanAbort = null;
    this._labAbort = null;
    this._scanTimerMs = 0;
    this._inited = false;
  }

  // ---------------------------------------------------------------- plumbing

  settings() { return this.store.settings(); }
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _notify() { for (const fn of [...this._listeners]) { try { fn(); } catch (_) { /* a screen must not stop the runner */ } } }
  _say(level, scope, msg) { if (this.log && typeof this.log[level] === 'function') this.log[level](scope, msg); }

  _newSession() {
    return new TradingSession({
      settings: this.settings(), log: this.log, nowFn: this.run.source === 'deriv' ? this.nowFn : null,
      onSettings: (values) => this._adoptSettings(values),
    });
  }

  // The live source runs on the wall clock; simulated and imported candles run on the time of their newest candle.
  _clockFor(source) { this.session.setClock(source === 'deriv' ? this.nowFn : null); }

  // Settings the learning loop changed after an approval are written to the store, so they survive a reload.
  _adoptSettings(values) {
    const cur = this.settings();
    for (const key of LEARNABLE_KEYS) {
      const v = getPath(values, key);
      if (v !== undefined && JSON.stringify(v) !== JSON.stringify(getPath(cur, key))) this.store.setSetting(key, v);
    }
  }

  // The one place a setting is changed by the person. Locked and invalid values are refused by the schema.
  setSetting(key, value) {
    const res = this.store.setSetting(key, value);
    if (res.ok && this.session) {
      this.session.setSettings(this.settings());
      if (key.startsWith('compute.')) this._reshapePool();
    }
    this._notify();
    return res;
  }

  // ---------------------------------------------------------------- start up and saving

  // Reads what was saved (only if storage was accepted) and builds the session. Safe to call more than once.
  async init() {
    if (this._inited) return this;
    this._inited = true;
    this.session = this._newSession();
    if (this.consent.allowsStorage()) await this.restore();
    this._notify();
    return this;
  }

  async _loadMeta(key) {
    const all = await this.idb.getAll('meta');
    if (!Array.isArray(all)) return null;
    const row = all.find((r) => r && r.key === key);
    return row ? row.value : null;
  }

  async restore() {
    try {
      const saved = await this._loadMeta('session');
      if (saved && saved.state && !this.settings().paper.resetOnStart) {
        const res = this.session.importState(saved.state);
        if (res.ok) { this.run.simBars = Number(saved.simBars) || 0; this._say('info', 'runner', 'The saved paper account and learning data were loaded.'); }
      }
      const rules = await this._loadMeta('rules');
      if (rules) this.rules.importState(rules);
      return true;
    } catch (e) {
      this._say('warn', 'runner', `Loading saved data failed: ${(e && e.message) || e}`);
      return false;
    }
  }

  // Saves to this device. Refused, and says why, unless storage was accepted and the setting is on.
  async save() {
    if (!this.consent.allowsStorage()) return { ok: false, reason: 'consent' };
    if (!this.settings().store.persist) return { ok: false, reason: 'setting' };
    if (!this.session) return { ok: false, reason: 'nothing' };
    try {
      const a = await this.idb.put('meta', { key: 'session', value: { savedMs: this.nowFn(), simBars: this.run.simBars, state: this.session.exportState() } });
      const b = await this.idb.put('meta', { key: 'rules', value: this.rules.exportState() });
      if (a === null || b === null) return { ok: false, reason: 'unavailable' };
      this._lastSaveMs = this.nowFn();
      this._dirty = false;
      return { ok: true, savedMs: this._lastSaveMs };
    } catch (e) {
      return { ok: false, reason: 'error', error: String((e && e.message) || e) };
    }
  }

  // Accept or refuse storage. Refusing keeps the app fully working; nothing is written and nothing is read next time.
  // Accepting writes what this page already holds (settings, account, rules) so nothing the person did is lost.
  // Taking an earlier acceptance back deletes what was saved on this device; what is running keeps running in memory.
  async setConsent(value) {
    if (!this.consent.set(value)) return this.consent.get();
    if (value === 'accepted') {
      this.store.persistNow();
      await this.save();
    } else if (value === 'declined') {
      await this._forgetDevice();
    }
    this._notify();
    return this.consent.get();
  }

  // Deletes every record this app saved on this device (IndexedDB and the settings copy). Memory is untouched.
  async _forgetDevice() {
    for (const s of IDB_STORES) { try { await this.idb.clear(s); } catch (_) { /* ignore */ } }
    this.store.forget();
    this.cache = createCandleCache(this.idb);
    this._lastSaveMs = null;
  }

  // Deletes everything this app keeps, on the device and in memory, and starts clean. Settings go back to their defaults.
  async wipe() {
    if (this.run.status === 'running' || this.run.status === 'paused') await this.stop();
    this.cancelHistory();
    this.cancelScan();
    this.cancelBacktest();
    await this._forgetDevice();
    this.store.forget({ memory: true });
    this.rules.clear();
    this._series.clear();
    this._replay = null;
    this.run.simBars = 0;
    this._dirty = false;
    this.history = { state: 'idle', message: '', items: [], startedMs: null, finishedMs: null };
    this.scanState = { state: 'idle', message: '', startedMs: null, finishedMs: null, current: null };
    this.lab = { state: 'idle', progress: null, result: null, error: null, label: '' };
    this.session = this._newSession();
    this._clockFor(this.run.source);
    this._notify();
    return { ok: true };
  }

  // ---------------------------------------------------------------- running

  _assets() { return cfgFor('engine', this.settings()).tradeAssets; }

  async start() {
    if (this.run.status === 'running' || this.run.status === 'starting') return this.run;
    await this.init();
    const s = this.settings();
    const source = cfgFor('data', s).source;
    this.run = { status: 'starting', source, message: 'Starting.', startedMs: this.nowFn(), simBars: this.run.simBars, speed: 0, error: null };
    this._notify();
    try {
      if (s.paper.resetOnStart && !this._resetDone) { this.session.resetPaper(); this._resetDone = true; }
      this.session.setSettings(s);
      this._clockFor(source);
      if (source === 'sim') this._startSim();
      else if (source === 'replay') this._startReplay();
      else await this._startDeriv();
      if (this.run.status === 'error') return this.run;
      this.run.status = 'running';
      this.run.message = source === 'sim' ? 'Simulated market running.' : (source === 'replay' ? 'Replaying imported candles.' : 'Connected to the Deriv public feed.');
      this.session.running = true;
      this._lastTickMs = this.nowFn();
      this._budget = 0;
      this._timer = this.timers.setInterval(() => this._tick(), TICK_MS);
      this._armSave();
      await this._wakeLock(true);
      this._say('info', 'runner', `Started with the ${source} source.`);
    } catch (e) {
      this.run.status = 'error';
      this.run.error = String((e && e.message) || e);
      this.run.message = this.run.error;
      this._say('error', 'runner', this.run.error);
    }
    this._notify();
    return this.run;
  }

  _armSave() {
    if (this._saveTimer) this.timers.clearInterval(this._saveTimer);
    const sec = this.settings().app.autosaveSec;
    this._saveTimer = this.timers.setInterval(() => { if (this._dirty || this.session) this.save(); }, Math.max(5, sec) * 1000);
  }

  async stop() {
    if (this._timer) this.timers.clearInterval(this._timer);
    if (this._saveTimer) this.timers.clearInterval(this._saveTimer);
    this._timer = null;
    this._saveTimer = null;
    if (this._feed && this._feed.stop) { try { this._feed.stop(); } catch (_) { /* already closed */ } }
    this._feed = null;
    if (this.session) this.session.running = false;
    this.run.status = 'stopped';
    this.run.message = 'Stopped.';
    await this._wakeLock(false);
    await this.save();
    this._notify();
    return this.run;
  }

  async pause() {
    if (this.run.status !== 'running') return this.run;
    if (this._timer) this.timers.clearInterval(this._timer);
    this._timer = null;
    if (this._feed && this._feed.stop) { try { this._feed.stop(); } catch (_) { /* already closed */ } }
    if (this.run.source === 'deriv') this._feed = null;
    this.session.running = false;
    this.run.status = 'paused';
    this.run.message = 'Paused. The paper account is unchanged.';
    await this.save();
    this._notify();
    return this.run;
  }

  async resume() {
    if (this.run.status !== 'paused') return this.run;
    if (this.run.source === 'deriv') {
      this.run.status = 'stopped';
      return this.start();
    }
    this.run.status = 'running';
    this.run.message = 'Running.';
    this.session.running = true;
    this._lastTickMs = this.nowFn();
    this._budget = 0;
    this._timer = this.timers.setInterval(() => this._tick(), TICK_MS);
    this._notify();
    return this.run;
  }

  _tick() {
    const now = this.nowFn();
    const elapsed = Math.max(0, now - this._lastTickMs);
    this._lastTickMs = now;
    if (this.run.source === 'sim' || this.run.source === 'replay') {
      const speedSetting = cfgFor('data', this.settings()).simSpeed;
      const perSec = speedSetting === 'max' ? Infinity : Number(speedSetting) || 1;
      // Bars owed = time passed x speed. A tab that was throttled overnight wakes up owing a lot; it works it off over the next
      // ticks (at most maxBarsPerTick each), and the debt is capped so it never grows without limit on a slow device.
      let n = this.maxBarsPerTick;
      if (Number.isFinite(perSec)) {
        this._budget = Math.min(this._budget + (elapsed / 1000) * perSec, this.maxBarsPerTick * 3);
        n = Math.min(Math.floor(this._budget), this.maxBarsPerTick);
      }
      const t0 = this.perfNow();
      let done = 0;
      // The work is capped by time as well as by count, so a slow device stays responsive rather than freezing.
      while (done < n && this.perfNow() - t0 < this.tickWorkMs) {
        if (this.run.source === 'sim') this._simStep(); else if (!this._replayStep()) break;
        done += 1;
      }
      if (Number.isFinite(perSec)) this._budget = Math.max(0, this._budget - done);
      this.run.speed = elapsed > 0 ? Math.round((done / elapsed) * 10000) / 10 : 0;
    }
    this._scheduledScan(now);
    this._notify();
  }

  // ---------------------------------------------------------------- the simulated market

  _startSim() {
    const s = this.settings();
    const d = cfgFor('data', s);
    const assets = d.assets;
    const feed = createSimFeed({
      seed: d.simSeed, assets, startIso: d.simStart, starts: d.simStarts, volPct: d.simVolPct, regimeBars: d.simRegimeBars,
      spikeChance: d.simSpikeChance, outageEvery: d.simOutageEvery, kind: d.simKind,
    });
    this._sim = { feed, assets, tfs: d.timeframes.map(Number) };
    // Fast-forward to where the saved run stopped, then seed every timeframe from the same minutes.
    const total = this.warmupBars + this.run.simBars;
    const m1 = Object.fromEntries(assets.map((a) => [a, []]));
    for (let i = 0; i < total; i += 1) for (const a of assets) m1[a].push(feed.next(a));
    for (const a of assets) {
      for (const tf of this._sim.tfs) {
        const list = tf === 60 ? m1[a] : aggregateCandles(m1[a], 60, tf);
        this.session.seed(a, tf, list.slice(-d.maxBars), 'sim');
      }
      for (const tf of this._sim.tfs) this.session.analyseLatest(a, tf);
    }
  }

  _simStep() {
    const { feed, assets, tfs } = this._sim;
    for (const asset of assets) {
      const c = feed.next(asset);
      this._ingest(asset, 60, c);
      for (const tf of tfs) {
        if (tf === 60) continue;
        const agg = this.session.mde.aggregateLast(asset, 60, tf);
        if (agg) this._ingest(asset, tf, agg);
      }
    }
    this.run.simBars += 1;
  }

  // One closed candle into the session, with the scanner's rules as extra proposals when the person chose to trade them.
  _ingest(asset, tf, candle) {
    const s = this.settings();
    let extra = null;
    if (cfgFor('scan', s).use === 'paper' && this.rules.list({ asset, tf }).length) {
      const series = this.session.candles(asset, tf, 700);
      const win = series.length && series[series.length - 1].epoch >= candle.epoch ? series : series.concat([candle]);
      extra = this.rules.paperSignals(asset, tf, win, { maxRules: cfgFor('scan', s).maxRules });
    }
    const wallMs = this.run.source === 'deriv' ? this.nowFn() : null;
    const r = this.session.ingest({ asset, tf, candle, wallMs, extra });
    if (r && r.ok && (r.filled.length || r.closed.length) && this.settings().app.notify) this._toast(`${asset}: ${r.filled.length} filled, ${r.closed.length} closed`);
    return r;
  }

  _toast(text) {
    try {
      if (typeof globalThis.Notification === 'function' && globalThis.Notification.permission === 'granted') new globalThis.Notification('Krabby', { body: text });
    } catch (_) { /* notifications are optional */ }
  }

  // ---------------------------------------------------------------- imported candles

  // text: the contents of a CSV or JSON file with candles. They replace the simulator as the source for the base timeframe.
  loadReplay({ asset, tf, text, format = 'csv' }) {
    const parsed = parseCandles(text, { format });
    if (!parsed.candles.length) return { ok: false, error: parsed.report.error || 'No usable candles were found in that file.', report: parsed.report };
    this._replay = { asset, tf: tfSeconds(tf), candles: parsed.candles, i: 0, report: parsed.report };
    this._series.set(`${asset}|${tfSeconds(tf)}`, parsed.candles);
    this._notify();
    return { ok: true, count: parsed.candles.length, report: parsed.report };
  }

  _startReplay() {
    if (!this._replay) throw new Error('Import a candle file first (Settings, Market data, or the Lab).');
    const { asset, tf, candles } = this._replay;
    const d = cfgFor('data', this.settings());
    this._replay.i = Math.min(candles.length, Math.max(0, this._replay.i));
    const head = candles.slice(0, Math.min(candles.length, Math.max(this._replay.i, 400)));
    this._replay.i = head.length;
    this.session.seed(asset, tf, head.slice(-d.maxBars), 'replay');
    this.session.analyseLatest(asset, tf);
  }

  _replayStep() {
    const r = this._replay;
    if (!r || r.i >= r.candles.length) { this.run.message = 'The imported candles ended.'; return false; }
    const c = r.candles[r.i];
    r.i += 1;
    this._ingest(r.asset, r.tf, c);
    return true;
  }

  // ---------------------------------------------------------------- Deriv

  async _startDeriv() {
    const { api } = await this.loadDeriv();
    const d = cfgFor('data', this.settings());
    this._feed = createDerivFeed({
      assets: d.assets, timeframes: d.timeframes.map(Number), historyBars: d.historyBars, api, nowFn: this.nowFn,
      onHistory: (asset, tf, hist) => { this.session.seed(asset, tf, hist, 'deriv'); this.session.analyseLatest(asset, tf, this.nowFn()); this._notify(); },
      onCandle: (asset, tf, candle) => { this._ingest(asset, tf, candle); this._notify(); },
      onStatus: (state, message) => {
        if (state === 'error') { this.run.status = 'error'; this.run.error = message; this.run.message = message; }
        else if (state === 'running') this.run.message = 'Connected to the Deriv public feed.';
        this._notify();
      },
    });
    await this._feed.start();
    if (this.settings().hist.autoLoad) this.loadHistory().catch(() => {});
  }

  // ---------------------------------------------------------------- wake lock

  async _wakeLock(on) {
    try {
      if (!on) { if (this._wake && this._wake.release) await this._wake.release(); this._wake = null; return; }
      if (!this.settings().app.wakeLock || !this.nav || !this.nav.wakeLock) return;
      this._wake = await this.nav.wakeLock.request('screen');
    } catch (_) { this._wake = null; }
  }

  // Called by the page when it becomes visible again: browsers release the lock when a tab is hidden.
  async onVisible() {
    if (this.run.status === 'running') await this._wakeLock(true);
    this._lastTickMs = this.nowFn();
    this._notify();
  }

  // ---------------------------------------------------------------- history and scans

  _scanOptsFor(tf) {
    const s = this.settings();
    const sc = cfgFor('scan', s);
    const cost = cfgFor('cost', s);
    return {
      tf, costPrice: cost.spreadPrice + 2 * cost.slippagePrice, stopAtr: sc.stopAtr, rr: sc.rr, horizon: sc.horizon, trainFrac: sc.trainFrac,
      valFrac: sc.valFrac, minTrain: sc.minTrain, minVal: sc.minVal, minTest: sc.minTest, q: sc.q, depth: sc.depth || undefined, maxConditions: sc.maxConditions,
    };
  }

  // The longest series held for a market and timeframe: downloaded or simulated history if there is one, else what the session has.
  candlesFor(asset, tf) {
    const long = this._series.get(`${asset}|${tf}`);
    const live = this.session ? this.session.candles(asset, tf, 50000) : [];
    return long && long.length >= live.length ? long : live;
  }

  _reshapePool() {
    const c = cfgFor('compute', this.settings());
    const caps = capabilities(this.nav || {});
    const want = c.enabled && caps.workers && this.workerFactory ? (c.threads || caps.suggestedThreads) : 0;
    if (this.compute.pool && this.compute.size === want) return this.compute.pool;
    if (this.compute.pool) this.compute.pool.terminate();
    this.compute.pool = createPool({ size: want, workerFactory: this.workerFactory });
    this.compute.size = want;
    return this.compute.pool;
  }

  async checkGpu() {
    this.compute.gpu = await probeGpu(this.nav || {});
    this._notify();
    return this.compute.gpu;
  }

  cancelHistory() { if (this._histAbort) this._histAbort.aborted = true; }

  // Downloads (Deriv) or generates (simulator) deep history for every market that may trade and every chosen timeframe.
  async loadHistory({ assets = null, tfs = null } = {}) {
    if (this.history.state === 'running') return this.history;
    // The handle exists before anything is awaited, so a cancel pressed at once still stops it.
    this._histAbort = { aborted: false };
    this.history = { state: 'running', message: 'Collecting history.', items: [], startedMs: this.nowFn(), finishedMs: null };
    await this.init();
    const s = this.settings();
    const h = cfgFor('hist', s);
    const d = cfgFor('data', s);
    const list = [];
    for (const a of assets || this._assets()) for (const tf of tfs || h.timeframes.map(Number)) list.push({ asset: a, tf, state: 'waiting', have: 0, target: h.targetBars, pages: 0, oldestEpoch: null, newestEpoch: null, gaps: null, error: null });
    this.history.items = list;
    this._notify();
    const source = d.source;
    let derivApi = null;
    if (source === 'deriv') {
      try { derivApi = await this.loadDeriv(); } catch (e) { this.history.state = 'error'; this.history.message = `The Deriv module could not load: ${(e && e.message) || e}`; this._notify(); return this.history; }
    }
    for (const item of list) {
      if (this._histAbort.aborted) { item.state = 'cancelled'; continue; }
      item.state = 'running';
      this._notify();
      if (source === 'sim') {
        const c = await simHistoryCandlesAsync(createSimFeed, d, item.asset, item.tf, Math.min(h.targetBars, 200000), {
          yieldFn: () => new Promise((r) => setTimeout(r, 0)), signal: this._histAbort,
          onProgress: (f) => { item.have = Math.round(f * h.targetBars); this._notify(); },
        });
        if (c === null) { item.state = 'cancelled'; continue; }
        this._series.set(`${item.asset}|${item.tf}`, c);
        Object.assign(item, { state: 'done', have: c.length, oldestEpoch: c[0] ? c[0].epoch : null, newestEpoch: c.length ? c[c.length - 1].epoch : null, pages: 0 });
        continue;
      }
      if (source !== 'deriv') { item.state = 'skipped'; item.error = 'History is downloaded from Deriv or made by the simulator. Imported files are used as they are.'; continue; }
      const fetchPage = async ({ asset, tf, endEpoch, count }) => {
        const resp = await derivApi.api.request({ ticks_history: asset, style: 'candles', granularity: tf, count, end: endEpoch, adjust_start_time: 1 }, { auth: false });
        return derivApi.cleanCandles(resp.candles);
      };
      const keep = cfgFor('store', s).keepCandles;
      const cache = h.cache && this.consent.allowsStorage()
        ? { load: (a, t) => this.cache.load(a, t), save: (a, t, c) => this.cache.save(a, t, c, { keep }) }
        : null;
      const res = await backfill({
        asset: item.asset, tf: item.tf, targetBars: h.targetBars, fetchPage, cache,
        delayMs: h.pageDelayMs, signal: this._histAbort, nowFn: this.nowFn,
        onProgress: (p) => { item.have = p.have; item.pages = p.pages; item.oldestEpoch = p.oldestEpoch; this._notify(); },
      });
      if (res.candles.length) this._series.set(`${item.asset}|${item.tf}`, res.candles);
      Object.assign(item, { state: res.cancelled ? 'cancelled' : (res.ok ? 'done' : 'error'), have: res.candles.length, pages: res.pages, oldestEpoch: res.oldestEpoch, newestEpoch: res.newestEpoch, gaps: res.gaps, error: res.error || null });
    }
    const errs = list.filter((i) => i.state === 'error').length;
    this.history.state = this._histAbort.aborted ? 'cancelled' : (errs ? 'error' : 'done');
    this.history.finishedMs = this.nowFn();
    this.history.message = this._histAbort.aborted ? 'Stopped. What was collected is kept.' : (errs ? `${errs} download(s) failed. What was collected is kept.` : 'History collected.');
    this._notify();
    return this.history;
  }

  cancelScan() { if (this._scanAbort) this._scanAbort.aborted = true; const p = this.compute.pool; if (p) p.cancelAll('Scan cancelled.'); }

  // Scans one market and timeframe (or all history held when none is given) and keeps the survivors in the rule book.
  async scan({ asset = null, tf = null } = {}) {
    if (this.scanState.state === 'running') return this.scanState;
    this._scanAbort = { aborted: false };
    this.scanState = { state: 'running', message: 'Scanning.', startedMs: this.nowFn(), finishedMs: null, current: null, done: 0, total: 0, results: [] };
    await this.init();
    const jobs = [];
    for (const key of [...this._series.keys()]) {
      const [a, t] = key.split('|');
      if ((asset === null || a === asset) && (tf === null || Number(t) === Number(tf))) jobs.push({ asset: a, tf: Number(t), candles: this._series.get(key) });
    }
    if (!jobs.length) {
      this.scanState = { state: 'error', message: 'There is no history to scan yet. Collect history first.', startedMs: null, finishedMs: null, current: null };
      this._notify();
      return this.scanState;
    }
    this.scanState.total = jobs.length;
    this._notify();
    const pool = this._reshapePool();
    const yieldFn = () => new Promise((r) => setTimeout(r, 0));
    const one = async (job) => {
      this.scanState.current = `${job.asset} ${job.tf}s`;
      this._notify();
      const opts = this._scanOptsFor(job.tf);
      let res;
      try {
        res = await pool.run({ type: 'scan', candles: job.candles, opts: pool.size > 0 ? opts : { ...opts, yieldFn } }, { signal: this._scanAbort });
      } catch (e) {
        res = { ok: false, code: e && e.cancelled ? 'cancelled' : 'scan_failed', error: String((e && e.message) || e) };
      }
      if (res.ok || res.code !== 'cancelled') this.rules.recordScan(job.asset, job.tf, res);
      this.scanState.done += 1;
      this.scanState.results.push({ asset: job.asset, tf: job.tf, ok: res.ok, code: res.code || null, error: res.error || null, survivors: res.ok ? res.survivors.length : 0, tested: res.tested || 0, verdict: res.ok ? res.verdict : null, depth: res.depth || null, bars: res.bars || job.candles.length });
      this._notify();
    };
    if (pool.size > 0) await Promise.all(jobs.map(one)); else for (const job of jobs) { if (this._scanAbort.aborted) break; await one(job); }
    this.scanState.state = this._scanAbort.aborted ? 'cancelled' : 'done';
    this.scanState.finishedMs = this.nowFn();
    this.scanState.current = null;
    this.scanState.message = this._scanAbort.aborted ? 'Scan stopped.' : 'Scan finished.';
    this._scanTimerMs = this.nowFn();
    await this.save();
    this._notify();
    return this.scanState;
  }

  _scheduledScan(now) {
    const hours = cfgFor('scan', this.settings()).everyHours;
    if (!(hours > 0) || this.scanState.state === 'running' || !this._series.size) return;
    if (!this._scanTimerMs) { this._scanTimerMs = now; return; }
    if (now - this._scanTimerMs >= hours * 3600 * 1000) this.scan().catch(() => {});
  }

  // ---------------------------------------------------------------- backtests

  cancelBacktest() { if (this._labAbort) this._labAbort.aborted = true; }

  // opts: { asset, tf, source (strategy code) | rule | none for the engines, params, limits, grid, label }
  async backtest(opts = {}) {
    if (this.lab.state === 'running') return this.lab;
    this._labAbort = { aborted: false };
    this.lab = { state: 'running', progress: { phase: 'start', done: 0, total: 1 }, result: null, error: null, label: opts.label || '' };
    await this.init();
    const asset = opts.asset || this._assets()[0];
    const tf = Number(opts.tf || 60);
    const candles = opts.candles || this.candlesFor(asset, tf);
    this._notify();
    const res = await runBacktest({
      asset, tf, candles, settings: this.settings(), source: opts.source || null, rule: opts.rule || null, strategyName: opts.strategyName || opts.label || 'strategy',
      params: opts.params || {}, limits: opts.limits || 'as_set', grid: opts.grid, signal: this._labAbort, workerFactory: opts.workerFactory,
      onProgress: (p) => { this.lab.progress = p; this._notify(); },
    });
    this.lab = { state: res.ok ? 'done' : (res.code === 'cancelled' ? 'cancelled' : 'error'), progress: null, result: res.ok ? res : null, error: res.ok ? null : res.error, label: opts.label || '' };
    this._notify();
    return this.lab;
  }

  // ---------------------------------------------------------------- the account

  emergencyStop(on, reason = 'manual') { const r = this.session.setEmergencyStop(on, reason); this._notify(); return r; }

  resetPaper() { const a = this.session.resetPaper(); this._dirty = true; this._notify(); return a; }

  approveProposal(id, phrase, actor = 'user') {
    try { const p = this.session.learning.approve(id, phrase, actor); this._dirty = true; this._notify(); return { ok: true, proposal: p }; } catch (e) { return { ok: false, error: String((e && e.message) || e), code: e && e.code }; }
  }

  rejectProposal(id) { const ok = this.session.learning.reject(id, 'user'); this._dirty = true; this._notify(); return { ok }; }

  proposeNow() { const p = this.session.learning.propose(this.session.clockNow()); this._notify(); return p; }

  // ---------------------------------------------------------------- what the screens draw

  snapshot(opts = {}) {
    const s = this.settings();
    const sess = this.session ? this.session.state(opts) : null;
    this.rules.noteForward(this.session ? this.session.trader.trades() : []);
    const radar = [];
    if (this.session && cfgFor('scan', s).use !== 'off') {
      for (const asset of this._assets()) {
        for (const tf of new Set([...cfgFor('hist', s).timeframes.map(Number), ...cfgFor('data', s).timeframes.map(Number)])) {
          if (!this.rules.list({ asset, tf }).length) continue;
          for (const hit of this.rules.radar(asset, tf, this.session.candles(asset, tf, 700))) radar.push({ asset, tf, ...hit });
        }
      }
    }
    return {
      run: { ...this.run },
      session: sess,
      settings: s,
      consent: this.consent.get(),
      storage: { available: this.idb.available(), lastSaveMs: this._lastSaveMs, dirty: this._dirty },
      history: { ...this.history, held: [...this._series.entries()].map(([k, v]) => ({ key: k, bars: v.length, fromEpoch: v[0] ? v[0].epoch : null, toEpoch: v.length ? v[v.length - 1].epoch : null })) },
      scan: { ...this.scanState },
      rules: { list: this.rules.list(), scans: { ...this.rules.scans }, radar },
      compute: { enabled: cfgFor('compute', s).enabled, size: this.compute.size, caps: capabilities(this.nav || {}), gpu: this.compute.gpu, workerFactory: Boolean(this.workerFactory) },
      lab: { ...this.lab },
    };
  }

  async dispose() {
    await this.stop();
    if (this.compute.pool) this.compute.pool.terminate();
    this._listeners.clear();
  }
}

export { plain };
