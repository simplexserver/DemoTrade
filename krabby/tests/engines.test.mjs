import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, cfgFor } from '../js/core/schema.js';
import { Board, AuditLog } from '../js/engine/board.js';
import { newMsg, finalizeAll } from '../js/engine/common.js';
import { runAnalysis, ANALYSIS, MIN_BARS } from '../js/engine/pipeline.js';
import { ENGINE_REGISTRY, ENGINE_BY_CODE } from '../js/engine/registry.js';
import { buildCases, caseSnapshot } from '../js/engine/coordinator.js';
import { buildFeatures } from '../js/learning/features.js';
import { createSimFeed, simFeedFromSettings } from '../js/market/feed-sim.js';
import { parseCandles } from '../js/market/feed-replay.js';
import { createDerivFeed } from '../js/market/feed-deriv.js';
import { MarketData, validateCandle } from '../js/market/mde.js';

const SETTINGS = normalise({});
const ASSET = 'R_100';

const simCandles = (n, seed = 7, over = {}) => {
  const f = createSimFeed({ seed, assets: [ASSET], starts: { [ASSET]: 1000 }, ...over });
  return Array.from({ length: n }, () => f.next(ASSET));
};

// Complete higher-timeframe candles from M1, the way the runner builds them.
function aggregate(m1, tf) {
  const per = tf / 60;
  const out = [];
  const buckets = new Map();
  for (const c of m1) {
    const start = c.epoch - (c.epoch % tf);
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(c);
  }
  for (const [start, list] of [...buckets].sort((a, b) => a[0] - b[0])) {
    if (list.length !== per) continue;
    out.push({
      epoch: start, open: list[0].open, high: Math.max(...list.map((c) => c.high)),
      low: Math.min(...list.map((c) => c.low)), close: list[list.length - 1].close,
    });
  }
  return out;
}

const nowOf = (candles, tf) => (candles[candles.length - 1].epoch + tf) * 1000;

function walkNumbers(value, visit, path = '') {
  if (typeof value === 'number') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkNumbers(v, visit, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkNumbers(v, visit, `${path}.${k}`);
}

// Runs the pipeline on growing windows. Returns every run so tests can inspect them.
function runAll(candles, tf, { from = 100, step = 9, settings = SETTINGS, board = new Board({ audit: new AuditLog() }) } = {}) {
  const runs = [];
  for (let n = from; n <= candles.length; n += step) {
    const window = candles.slice(Math.max(0, n - 1500), n);
    const nowMs = nowOf(window, tf);
    runs.push({ n, nowMs, window, ...runAnalysis({ asset: ASSET, tf, candles: window, board, settings, nowMs, audit: false }) });
  }
  return { runs, board };
}

// ---------------------------------------------------------------- feeds

test('sim feed: same seed gives the same market, other seeds differ, candles are valid', () => {
  const a = simCandles(400, 5);
  const b = simCandles(400, 5);
  const c = simCandles(400, 6);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const k of a) assert.ok(validateCandle(k).ok, JSON.stringify(k));
  for (let i = 1; i < a.length; i += 1) assert.equal(a[i].epoch - a[i - 1].epoch, 60);
  assert.ok(a.some((k) => (k.high - k.low) / k.open > 0.0015), 'has some larger candles');
});

test('sim feed: each market has its own stream and the settings helper reads the data group', () => {
  const f = createSimFeed({ seed: 3, assets: ['A', 'B'] });
  const a = Array.from({ length: 50 }, () => f.next('A'));
  const b = Array.from({ length: 50 }, () => f.next('B'));
  assert.notDeepEqual(a.map((x) => x.close), b.map((x) => x.close));
  const f2 = simFeedFromSettings(cfgFor('data', SETTINGS), ['R_100']);
  const x = f2.next('R_100');
  assert.ok(validateCandle(x).ok);
  assert.equal(f2.count('R_100'), 1);
});

test('sim feed: outages leave a three-bar gap and say so', () => {
  const f = createSimFeed({ seed: 1, assets: [ASSET], outageEvery: 50 });
  const list = [];
  const flags = [];
  for (let i = 0; i < 120; i += 1) {
    list.push(f.next(ASSET));
    flags.push(f.outageActive(ASSET));
  }
  const gaps = [];
  for (let i = 1; i < list.length; i += 1) if (list[i].epoch - list[i - 1].epoch > 60) gaps.push(i);
  assert.deepEqual(gaps, [50, 100]);
  assert.deepEqual(flags.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [50, 100]);
  assert.equal(list[50].epoch - list[49].epoch, 4 * 60);
});

test('replay parser: csv with a header, bad rows, duplicates and unsorted rows', () => {
  const text = [
    'time,open,high,low,close',
    '2026-01-05T00:01:00Z,10,11,9,10.5',
    '2026-01-05T00:00:00Z,9,10,8,9.5',
    '2026-01-05T00:00:00Z,9,10.2,8,9.6',
    '2026-01-05T00:02:00Z,10,9,9,9.5',
    'nonsense,1,2,3,4',
    '2026-01-05T00:04:00Z,10,12,9,11',
  ].join('\n');
  const { candles, report } = parseCandles(text, { format: 'csv' });
  assert.equal(candles.length, 3);
  assert.deepEqual(candles.map((c) => c.close), [9.6, 10.5, 11]);
  assert.equal(report.rows, 6);
  assert.equal(report.bad, 2);
  assert.equal(report.duplicates, 1);
  assert.equal(report.sorted, false);
  assert.equal(report.gaps, 2, 'one candle missing between 00:01 and 00:04 counted per missing step');
  assert.equal(report.stepSeconds, 60);
});

test('replay parser: csv without a header, epoch milliseconds and json', () => {
  const csv = '1767571200,100,101,99,100.5\n1767571260,100.5,102,100,101';
  const a = parseCandles(csv);
  assert.equal(a.candles.length, 2);
  assert.equal(a.candles[0].epoch, 1767571200);
  const ms = parseCandles('epoch,open,high,low,close\n1767571200000,1,2,0.5,1.5', { format: 'csv' });
  assert.equal(ms.candles[0].epoch, 1767571200);
  const j = parseCandles(JSON.stringify({ candles: [{ epoch: 1, open: 1, high: 2, low: 1, close: 2 }] }), { format: 'json' });
  assert.equal(j.candles.length, 1);
  const bad = parseCandles('{oops', { format: 'json' });
  assert.equal(bad.candles.length, 0);
  assert.match(bad.report.error, /not valid JSON/);
});

test('deriv feed: history first, then each candle only after the next one starts', async () => {
  const handlers = [];
  const api = {
    streamCandles(asset, tf, handler) {
      handlers.push({ asset, tf, handler });
      return () => handlers.splice(handlers.indexOf(handlers.find((h) => h.handler === handler)), 1);
    },
  };
  const got = { candles: [], histories: [], status: [] };
  const feed = createDerivFeed({
    assets: ['R_100'], timeframes: [60], api, nowFn: () => (1000 + 60) * 1000 + 5000,
    onCandle: (a, tf, c) => got.candles.push(c), onHistory: (a, tf, h) => got.histories.push(h), onStatus: (s) => got.status.push(s),
  });
  await feed.start();
  assert.deepEqual(got.status, ['connecting', 'running']);
  const h = handlers[0].handler;
  const c = (epoch, close) => ({ epoch, open: close, high: close + 1, low: close - 1, close });
  // The last history candle is still forming (it closes at (1000+60)*1000 > now?). now = 1065000, close of 1000 is 1060000 so it is closed.
  h({ type: 'history', candles: [c(880, 10), c(940, 11), c(1000, 12)] });
  assert.equal(got.histories[0].length, 3);
  h({ type: 'live', candle: c(1060, 13), isNew: true });
  assert.equal(got.candles.length, 0, 'a candle that just started is held back');
  h({ type: 'live', candle: c(1060, 14), isNew: false });
  assert.equal(got.candles.length, 0);
  h({ type: 'live', candle: c(1120, 15), isNew: true });
  assert.deepEqual(got.candles.map((x) => [x.epoch, x.close]), [[1060, 14]]);
  feed.stop();
  assert.equal(handlers.length, 0);
  assert.equal(feed.status().state, 'idle');
});

test('deriv feed: a history whose last candle is still forming is held back', async () => {
  let handler;
  const api = { streamCandles: (a, tf, h) => { handler = h; return () => {}; } };
  const got = { candles: [], histories: [] };
  const feed = createDerivFeed({
    assets: ['X'], timeframes: [60], api, nowFn: () => 1030 * 1000,
    onCandle: (a, tf, c) => got.candles.push(c), onHistory: (a, tf, h) => got.histories.push(h),
  });
  await feed.start();
  const c = (epoch, close) => ({ epoch, open: close, high: close + 1, low: close - 1, close });
  handler({ type: 'history', candles: [c(900, 1), c(960, 2), c(1000, 3)] });
  assert.equal(got.histories[0].length, 2, 'the forming candle at 1000 is removed from history');
  handler({ type: 'live', candle: c(1000, 4), isNew: false });
  handler({ type: 'live', candle: c(1060, 5), isNew: true });
  assert.deepEqual(got.candles.map((x) => x.close), [4]);
});

// ---------------------------------------------------------------- market data

test('market data: push, gaps, out of order, aggregate, health', () => {
  const m = new MarketData({ maxBars: 50 });
  const list = simCandles(120);
  for (const c of list.slice(0, 60)) assert.ok(m.push(ASSET, 60, c).ok);
  assert.equal(m.series(ASSET, 60).length, 50, 'capped at maxBars');
  assert.equal(m.push(ASSET, 60, list[10]).reason, 'out_of_order');
  assert.equal(m.push(ASSET, 60, { epoch: 1, open: 1, high: 0.5, low: 1, close: 1 }).reason, 'invalid_high_below_body');
  const skip = list[61];
  const r = m.push(ASSET, 60, { ...skip, epoch: list[59].epoch + 3 * 60 });
  assert.equal(r.reason, 'gap');
  assert.equal(r.missing, 2);
  const now = (m.series(ASSET, 60).at(-1).epoch + 60) * 1000;
  const h = m.health(ASSET, 60, now, { gapTolerance: 0, gapWindowBars: 20 });
  assert.equal(h.status, 'gap');
  assert.equal(m.health(ASSET, 60, now + 10 * 60 * 1000, { staleFactor: 2 }).status, 'stale');
  assert.equal(m.health('NOPE', 60, now).status, 'empty');
});

test('market data: aggregateLast returns the higher candle only when it completes', () => {
  const m = new MarketData();
  const list = simCandles(30);
  const seen = [];
  for (const c of list) {
    m.push(ASSET, 60, c);
    const a = m.aggregateLast(ASSET, 60, 300);
    if (a) seen.push(a);
  }
  const expected = aggregate(list, 300);
  assert.deepEqual(seen, expected);
});

// ---------------------------------------------------------------- board

const mk = (engine, type, atMs, i, extra = {}) => newMsg({ topic: 'levels', type, direction: 'none', atMs, summary: `${engine} ${type}`, evidence: { rank: 50, cls: 'developing' }, ...extra });
const publishRun = (board, engine, runMs, items, audit = false) => {
  const msgs = finalizeAll({ code: engine, asset: ASSET, tf: 60, runMs, inputs: null }, items.map((x) => mk(engine, x.type, x.atMs)));
  board.markRun(engine, ASSET, 60, runMs);
  board.publish(msgs, { audit });
  return msgs;
};

test('board: a new run replaces the previous snapshot, history stays available', () => {
  const board = new Board({ audit: new AuditLog() });
  publishRun(board, 'SRE', 1000, [{ type: 'support', atMs: 900 }, { type: 'resistance', atMs: 950 }]);
  assert.equal(board.query({ topic: 'levels', asset: ASSET, tf: 60 }).length, 2);
  publishRun(board, 'SRE', 2000, [{ type: 'support', atMs: 900 }]);
  const now = board.query({ topic: 'levels', asset: ASSET, tf: 60 });
  assert.equal(now.length, 1);
  assert.equal(now[0].runMs, 2000);
  assert.equal(board.query({ topic: 'levels', asset: ASSET, tf: 60, current: false }).length, 3);
  // An empty run replaces the snapshot with nothing.
  publishRun(board, 'SRE', 3000, []);
  assert.equal(board.query({ topic: 'levels', asset: ASSET, tf: 60 }).length, 0);
  assert.equal(board.query({ topic: 'levels', asset: ASSET, tf: 60, current: false }).length, 3);
});

test('board: each engine keeps its own current run', () => {
  const board = new Board();
  publishRun(board, 'SRE', 1000, [{ type: 'support', atMs: 1 }]);
  publishRun(board, 'CDE', 500, [{ type: 'small', atMs: 1 }]);
  publishRun(board, 'SRE', 2000, [{ type: 'support', atMs: 1 }]);
  const all = board.query({ topic: 'levels', asset: ASSET, tf: 60 });
  assert.deepEqual(all.map((m) => `${m.engine}@${m.runMs}`).sort(), ['CDE@500', 'SRE@2000']);
});

test('board: ids are stable and the audit log only records what is new on a run', () => {
  const audit = new AuditLog();
  const board = new Board({ audit });
  const a = publishRun(board, 'SRE', 1000, [{ type: 'support', atMs: 1000 }, { type: 'resistance', atMs: 400 }], true);
  assert.equal(a[0].id, `SRE:${ASSET}:60:1000:1000:0`);
  const logged = audit.list({ kind: 'message' });
  assert.equal(logged.length, 1, 'only the message about the newest candle is new');
  assert.equal(logged[0].id, a[0].id);
});

// ---------------------------------------------------------------- engines and pipeline

test('engine set: fourteen analysis engines, in the registry, with the contract shape', () => {
  assert.equal(ANALYSIS.length, 14);
  assert.deepEqual(ANALYSIS.map((e) => e.code), ['MSE', 'SRE', 'CDE', 'PDE', 'FVG', 'OBE', 'BSL', 'SSL', 'LSE', 'BDE', 'SRD', 'BLE', 'SLE', 'QAE']);
  for (const e of ANALYSIS) {
    assert.equal(typeof e.run, 'function', e.code);
    assert.ok(e.prefix && e.name && Array.isArray(e.topics), e.code);
    assert.ok(ENGINE_BY_CODE[e.code], `${e.code} is in the registry`);
    assert.equal(ENGINE_BY_CODE[e.code].status, 'on');
  }
  assert.equal(ENGINE_REGISTRY.length, 26);
  assert.deepEqual(ENGINE_REGISTRY.map((e) => e.number), Array.from({ length: 26 }, (_, i) => i + 1));
  assert.equal(ENGINE_BY_CODE.AI.status, 'off');
});

test('pipeline: no engine errors, and every message obeys the message rules', () => {
  const candles = simCandles(900);
  const { runs } = runAll(candles, 60);
  assert.ok(runs.length > 50);
  const seenEngines = new Set();
  for (const r of runs) {
    assert.deepEqual(r.errors, [], `engine errors at n=${r.n}`);
    const ids = new Set();
    for (const m of r.messages) {
      seenEngines.add(m.engine);
      assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
      ids.add(m.id);
      assert.ok(m.atMs <= r.nowMs, `${m.engine} ${m.type} is about the future`);
      assert.equal(m.runMs, r.nowMs);
      assert.ok(m.id.startsWith(`${m.engine}:${ASSET}:60:${r.nowMs}:${m.atMs}:`), m.id);
      assert.ok(typeof m.summary === 'string' && m.summary.length > 0, `${m.engine} summary`);
      assert.ok(m.evidence && m.evidence.rank >= 0 && m.evidence.rank <= 100, `${m.engine} evidence`);
      assert.ok(['valid', 'invalidated', 'expired'].includes(m.validity), `${m.engine} validity ${m.validity}`);
      walkNumbers(m, (v, path) => assert.ok(Number.isFinite(v), `${m.engine}/${m.type} ${path} is ${v}`));
    }
  }
  for (const code of ['MSE', 'SRE', 'CDE', 'PDE', 'FVG', 'OBE', 'BSL', 'SSL', 'LSE', 'BDE', 'SRD', 'BLE', 'SLE', 'QAE']) {
    assert.ok(seenEngines.has(code), `${code} produced something`);
  }
});

test('pipeline: plans have the right geometry and stay close to price', () => {
  const candles = simCandles(900, 11);
  const { runs } = runAll(candles, 60);
  let plans = 0;
  for (const r of runs) {
    const last = r.window[r.window.length - 1].close;
    for (const m of r.messages.filter((x) => x.plan)) {
      plans += 1;
      const p = m.plan;
      if (p.side === 'buy') assert.ok(p.stop < p.entry && p.entry < p.target && p.entry < last, `buy ${JSON.stringify(p)}`);
      else assert.ok(p.stop > p.entry && p.entry > p.target && p.entry > last, `sell ${JSON.stringify(p)}`);
      assert.equal(p.invalidation, p.stop);
      assert.equal(p.orderType, 'limit');
      assert.ok(Math.abs(Math.abs(p.target - p.entry) - p.rr * Math.abs(p.entry - p.stop)) < 1e-6, 'objective is rr times the risk');
      assert.ok(Math.abs(p.entry - last) / last < 0.05);
      assert.equal(m.atMs, r.nowMs, 'a proposal is about the bar that just closed');
    }
  }
  assert.ok(plans > 20, `plans seen: ${plans}`);
});

test('pipeline: the same candles give the same messages, byte for byte', () => {
  const candles = simCandles(500, 3);
  const a = runAll(candles, 60, { from: 200, step: 50 }).runs.map((r) => r.messages);
  const b = runAll(candles, 60, { from: 200, step: 50 }).runs.map((r) => r.messages);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('pipeline: a window of candles gives the same answer however it was reached', () => {
  const candles = simCandles(700, 9);
  const window = candles.slice(100, 600);
  const nowMs = nowOf(window, 60);
  const one = runAnalysis({ asset: ASSET, tf: 60, candles: window, board: new Board(), settings: SETTINGS, nowMs, audit: false });
  const warm = new Board();
  for (let n = 450; n <= 600; n += 25) {
    const w = candles.slice(100, n);
    runAnalysis({ asset: ASSET, tf: 60, candles: w, board: warm, settings: SETTINGS, nowMs: nowOf(w, 60), audit: false });
  }
  const two = runAnalysis({ asset: ASSET, tf: 60, candles: window, board: warm, settings: SETTINGS, nowMs, audit: false });
  assert.equal(JSON.stringify(one.messages), JSON.stringify(two.messages), 'earlier runs on the board do not leak into a later run');
});

test('pipeline: higher timeframes built from M1 run clean too', () => {
  const m1 = simCandles(4000, 21, { volPct: 0.05 });
  for (const tf of [300, 900, 3600]) {
    const candles = aggregate(m1, tf);
    assert.ok(candles.length >= 60, `tf ${tf} has ${candles.length} candles`);
    const { runs } = runAll(candles, tf, { from: 40, step: 3 });
    for (const r of runs) assert.deepEqual(r.errors, [], `tf ${tf} n=${r.n}`);
    const total = runs.reduce((s, r) => s + r.messages.length, 0);
    assert.ok(total > 0, `tf ${tf} produced messages`);
  }
});

test('pipeline: too few candles mark every engine run empty and replace the old snapshot', () => {
  const candles = simCandles(300);
  const board = new Board();
  const first = runAnalysis({ asset: ASSET, tf: 60, candles, board, settings: SETTINGS, nowMs: nowOf(candles, 60), audit: false });
  assert.ok(first.messages.length > 0);
  assert.ok(board.query({ asset: ASSET, tf: 60 }).length > 0);
  const few = candles.slice(0, MIN_BARS - 1);
  const second = runAnalysis({ asset: ASSET, tf: 60, candles: few, board, settings: SETTINGS, nowMs: nowOf(candles, 60) + 1000, audit: false });
  assert.deepEqual(second.messages, []);
  assert.equal(board.query({ asset: ASSET, tf: 60 }).length, 0, 'no stale messages stay current');
  const none = runAnalysis({ asset: ASSET, tf: 60, candles: [], board, settings: SETTINGS, nowMs: 5, audit: false });
  assert.deepEqual(none.errors, []);
});

test('pipeline: flat, spiky and tiny-range candles do not break any engine', () => {
  const flat = Array.from({ length: 200 }, (_, i) => ({ epoch: 1767571200 + i * 60, open: 100, high: 100, low: 100, close: 100 }));
  const tiny = Array.from({ length: 200 }, (_, i) => {
    const p = 1.0001 + (i % 2) * 1e-9;
    return { epoch: 1767571200 + i * 60, open: p, high: p + 1e-9, low: p - 1e-9, close: p + 1e-10 };
  });
  const base = simCandles(220, 4);
  const spiky = base.map((c, i) => (i % 37 === 0 ? { ...c, high: c.high * 1.2, low: c.low * 0.85 } : c));
  const jump = base.map((c, i) => (i >= 120 ? { epoch: c.epoch, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 } : c));
  for (const [name, candles] of [['flat', flat], ['tiny', tiny], ['spiky', spiky], ['jump', jump]]) {
    const { runs } = runAll(candles, 60, { from: 60, step: 20 });
    for (const r of runs) {
      assert.deepEqual(r.errors, [], `${name} n=${r.n}`);
      for (const m of r.messages) walkNumbers(m, (v, path) => assert.ok(Number.isFinite(v), `${name} ${m.engine}/${m.type} ${path}`));
    }
  }
});

test('settings reach the engines: a stricter setting finds fewer things', () => {
  const candles = simCandles(600, 7);
  const count = (settings) => runAll(candles, 60, { from: 300, step: 30, settings }).runs.reduce((s, r) => s + r.messages.filter((m) => m.engine === 'SRE').length, 0);
  const loose = count(normalise({ sre: { minReactions: 1 } }));
  const strict = count(normalise({ sre: { minReactions: 6 } }));
  assert.ok(loose > strict, `${loose} should be more than ${strict}`);
});

// ---------------------------------------------------------------- proposals to cases

test('cases: built from the current plans, capped per bar, and they feed the learning features', () => {
  const candles = simCandles(900, 7);
  const board = new Board();
  let builtTotal = 0;
  let dropped = 0;
  let caseRuns = 0;
  for (let n = 150; n <= candles.length; n += 3) {
    const window = candles.slice(0, n);
    const nowMs = nowOf(window, 60);
    const r = runAnalysis({ asset: ASSET, tf: 60, candles: window, board, settings: SETTINGS, nowMs, audit: false });
    const plans = r.messages.filter((m) => m.plan);
    const res = buildCases({ plans, board, settings: SETTINGS, nowMs, asset: ASSET, tf: 60, estimateFor: () => null, lastClose: window.at(-1).close });
    assert.equal(res.cases.length, plans.length);
    assert.ok(res.built.length <= cfgFor('tdc', SETTINGS).maxPerBar);
    for (const c of res.cases) {
      assert.ok(['build', 'drop'].includes(c.type));
      assert.ok(c.measurements.planId && c.plan.entry > 0);
      if (c.type === 'drop') assert.ok(c.measurements.reasons.length > 0, 'a drop always says why');
      if (c.type === 'build') {
        assert.ok(c.measurements.agreeCount >= cfgFor('tdc', SETTINGS).minFamilies);
        assert.equal(c.measurements.reasons.length, 0);
      }
    }
    builtTotal += res.built.length;
    dropped += res.drops.length;
    if (res.built.length) {
      caseRuns += 1;
      const snap = caseSnapshot(res.built[0], board, SETTINGS, nowMs);
      const f = buildFeatures(snap, cfgFor('ll', SETTINGS));
      assert.equal(f.names.length, f.values.length);
      for (const v of f.values) assert.ok(Number.isFinite(v));
    }
  }
  assert.ok(builtTotal > 0 && dropped > 0 && caseRuns > 0, `built ${builtTotal}, dropped ${dropped}`);
});

test('cases: strict edge mode drops everything until an estimate passes', () => {
  const candles = simCandles(500, 7);
  const board = new Board();
  const strict = normalise({ tdc: { edgeMode: 'strict' } });
  let built = 0;
  let strictDrops = 0;
  for (let n = 200; n <= candles.length; n += 5) {
    const window = candles.slice(0, n);
    const nowMs = nowOf(window, 60);
    const r = runAnalysis({ asset: ASSET, tf: 60, candles: window, board, settings: strict, nowMs, audit: false });
    const res = buildCases({ plans: r.messages.filter((m) => m.plan), board, settings: strict, nowMs, asset: ASSET, tf: 60, estimateFor: () => null });
    built += res.built.length;
    strictDrops += res.drops.filter((c) => c.measurements.reasons.some((x) => /no measured edge/i.test(x))).length;
  }
  assert.equal(built, 0);
  assert.ok(strictDrops > 0);
  // The same plans pass once an estimate clears break-even.
  const window = candles.slice(0, 400);
  const nowMs = nowOf(window, 60);
  const r = runAnalysis({ asset: ASSET, tf: 60, candles: window, board: new Board(), settings: strict, nowMs, audit: false });
  const good = () => ({ n: 150, winRate: 0.5, lo: 0.42, hi: 0.58, breakEven: 0.36, passes: true });
  const res = buildCases({ plans: r.messages.filter((m) => m.plan), board, settings: strict, nowMs, asset: ASSET, tf: 60, estimateFor: good });
  assert.ok(res.cases.every((c) => c.measurements.edgeOk));
});
