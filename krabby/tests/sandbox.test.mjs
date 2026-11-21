import test from 'node:test';
import assert from 'node:assert/strict';
import { scanCode, stripLiterals, compileStrategy, runSandboxed, normaliseSignal, BLOCKED_GLOBALS, LIMITS, API_DOC } from '../js/sandbox/core.js';
import { runStrategy } from '../js/sandbox/host.js';
import { StrategyLibrary } from '../js/strategies/library.js';
import { EXAMPLES } from '../js/strategies/examples.js';
import { sma, ema, rsi, atr } from '../js/engine/indicators.js';
import { simCandles, aggregate } from './helpers/sim.mjs';
import { nodeWorkerFactory } from './helpers/node-worker.mjs';

const M1 = simCandles(1500, 11);
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---------------------------------------------------------------- the static scan

test('scan: words in comments, strings and property names are fine; real uses are named with their line', () => {
  const fine = [
    'function onBar(ctx) {',
    '  // fetch the close from location',
    '  const c = ctx.candle();',
    '  const label = "window and self and import";',
    '  const t = `price ${c.close} close`;',
    '  return c.close > c.open ? { side: "buy", stop: 1, target: 3, reason: "close above" } : null;',
    '}',
  ].join('\n');
  assert.deepEqual(scanCode(fine), { ok: true, problems: [] });

  const bad = scanCode('function onBar(ctx) {\n  fetch("x");\n  return (() => 1).constructor("return 1")();\n}');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => [p.line, p.name]), [[2, 'fetch'], [3, 'constructor']]);
  assert.match(bad.problems[0].text, /Line 2: "fetch" is not available/);

  assert.equal(scanCode('const a = `${self.name}`;').ok, false, 'code inside a template expression is scanned');
  assert.equal(scanCode('import("https://example.com/x.js");').ok, false);
  assert.equal(scanCode('const x = obj.import; const y = obj.fetch;').ok, true, 'a property named like a global is not the global');
  assert.equal(scanCode('x.__proto__ = null;').ok, false, 'prototype access is refused even as a property');
  for (const name of BLOCKED_GLOBALS) assert.equal(scanCode(`${name}.x;`).ok, false, name);
});

test('scan: empty code and over-long code are refused with plain words', () => {
  assert.match(scanCode('').problems[0].text, /no strategy code/);
  assert.match(scanCode('x'.repeat(30), { maxChars: 10 }).problems[0].text, /limit is 10/);
  assert.equal(stripLiterals("a // b\n'c' /* d */ e").replace(/ +/g, ' ').trim(), 'a \n e');
});

// ---------------------------------------------------------------- compile and the wrapper

test('compile: syntax errors, a missing onBar and a throw at load are told apart', () => {
  assert.equal(compileStrategy('function onBar( {').code, 'compile_error');
  assert.equal(compileStrategy('const x = 1;').code, 'no_onbar');
  assert.equal(compileStrategy('throw new Error("boom"); function onBar() {}').code, 'load_error');
  assert.equal(compileStrategy('const onBar = (ctx) => null;').ok, true, 'a const arrow function counts');
});

test('wrapper: the blocked names are undefined even without the scan, and Math.random throws', () => {
  const { onBar } = compileStrategy(`function onBar() {
    return [typeof fetch, typeof eval, typeof Function, typeof self, typeof globalThis, typeof Date, typeof process,
      typeof setTimeout, typeof localStorage, typeof Math.max].join(',');
  }`);
  assert.equal(onBar(), 'undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,function');
  const r = compileStrategy('function onBar() { return Math.random(); }').onBar;
  assert.throws(() => r(), /Math\.random is not allowed/);
  const strict = compileStrategy('function onBar() { try { undefinedVariable = 1; } catch (e) { return e.name; } return "no error"; }').onBar;
  assert.equal(strict(), 'ReferenceError', 'strict mode: an undeclared assignment is an error, not a new global');
});

// ---------------------------------------------------------------- the context

test('ctx: indicators match the engine indicators, `back` reads earlier bars, and nothing looks ahead', () => {
  const closes = M1.map((c) => c.close);
  const E = ema(closes, 9);
  const S = sma(closes, 20);
  const R = rsi(closes, 14);
  const A = atr(M1, 14);
  // A strategy cannot hand values back except through its signals, so this one writes what it saw into the reason.
  const probe = `function onBar(ctx) {
    if (ctx.i !== 100 && ctx.i !== 700) return null;
    const c = ctx.candle();
    return { side: 'buy', entry: c.close, stop: c.close - 1, target: c.close + 1, reason: JSON.stringify([ctx.ema(9), ctx.ema(9, 3), ctx.sma(20), ctx.rsi(14), ctx.atr(14), ctx.highest(5, 2), ctx.lowest(5, 2), ctx.closes(3), ctx.time]) };
  }`;
  const r = runSandboxed({ code: probe, candles: M1, warmup: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.signals.length, 2);
  for (const s of r.signals) {
    const i = s.index;
    const [e0, e3, s0, r0, a0, hi, lo, cl, t] = JSON.parse(s.reason);
    approx(e0, E[i]);
    approx(e3, E[i - 3]);
    approx(s0, S[i]);
    approx(r0, R[i]);
    approx(a0, A[i]);
    approx(hi, Math.max(...M1.slice(i - 2 - 4, i - 2 + 1).map((c) => c.high)));
    approx(lo, Math.min(...M1.slice(i - 2 - 4, i - 2 + 1).map((c) => c.low)));
    assert.deepEqual(cl, M1.slice(i - 2, i + 1).map((c) => c.close));
    assert.equal(t, M1[i].epoch);
  }
});

test('ctx: signals made from the first N bars do not change when later bars change (no look-ahead)', () => {
  for (const ex of EXAMPLES) {
    const full = runSandboxed({ code: ex.code, candles: M1, params: ex.params });
    const cut = 900;
    const head = runSandboxed({ code: ex.code, candles: M1.slice(0, cut), params: ex.params });
    assert.equal(full.ok && head.ok, true, ex.id);
    assert.deepEqual(full.signals.filter((s) => s.index < cut), head.signals, ex.id);
    // And with a different future altogether.
    const other = M1.slice(0, cut).concat(simCandles(600, 99).map((c, i) => ({ ...c, epoch: M1[cut - 1].epoch + 60 * (i + 1) })));
    const alt = runSandboxed({ code: ex.code, candles: other, params: ex.params });
    assert.deepEqual(alt.signals.filter((s) => s.index < cut), head.signals, `${ex.id}: other future`);
  }
});

test('ctx: candles cannot be changed, ctx.candles is capped, params are read only, and the random numbers repeat', () => {
  const edit = runSandboxed({ code: 'function onBar(ctx) { ctx.candle().close = 1; return null; }', candles: M1 });
  assert.equal(edit.ok, false);
  assert.equal(edit.code, 'runtime_error');
  assert.match(edit.error, /^Bar 20: TypeError/);
  assert.equal(edit.errorBar, 20);
  const param = runSandboxed({ code: 'function onBar(ctx) { ctx.params.x = 2; return null; }', candles: M1, params: { x: 1 } });
  assert.equal(param.code, 'runtime_error');
  const own = runSandboxed({ code: 'function onBar(ctx) { ctx.i = 999; return null; }', candles: M1 });
  assert.equal(own.code, 'runtime_error', 'ctx itself is frozen');

  const len = runSandboxed({
    code: "function onBar(ctx) { return ctx.i === 1000 ? { side: 'buy', stop: 1, target: 9e9, entry: 2, reason: String(ctx.candles.length) } : null; }",
    candles: M1,
    lookback: 120,
  });
  assert.equal(len.signals[0].reason, '120');

  const rnd = "function onBar(ctx) { return ctx.i === 50 ? { side: 'buy', entry: 2, stop: 1, target: 3, reason: String(ctx.random()) } : null; }";
  const a = runSandboxed({ code: rnd, candles: M1, params: { seed: 5 } });
  const b = runSandboxed({ code: rnd, candles: M1, params: { seed: 5 } });
  const c = runSandboxed({ code: rnd, candles: M1, params: { seed: 6 } });
  assert.equal(a.signals[0].reason, b.signals[0].reason);
  assert.notEqual(a.signals[0].reason, c.signals[0].reason);
});

test('ctx: state declared above onBar lives from bar to bar, and the warm-up decides the first bar', () => {
  const code = "let calls = 0;\nfunction onBar(ctx) { calls += 1; return calls === 5 ? { side: 'buy', entry: 2, stop: 1, target: 3, reason: 'bar ' + ctx.i } : null; }";
  const r = runSandboxed({ code, candles: M1, warmup: 50 });
  assert.equal(r.signals[0].reason, 'bar 54');
  assert.equal(r.firstBar, 50);
  assert.equal(r.barsRun, M1.length - 50);
});

// ---------------------------------------------------------------- signals

test('signals: aliases, the default entry, geometry, caps and clean-up', () => {
  const bar = { epoch: 1, open: 10, high: 11, low: 9, close: 10 };
  assert.deepEqual(normaliseSignal({ side: 'LONG', stop: 9, target: 12 }, bar, 5), { index: 5, side: 'buy', entry: 10, stop: 9, target: 12, reason: '' });
  assert.deepEqual(normaliseSignal({ side: 'short', entry: 10, stop: 11, target: 8, reason: 'x'.repeat(500), expiryBars: 9999 }, bar, 5, {}).reason.length, LIMITS.maxReason);
  assert.equal(normaliseSignal({ side: 'short', entry: 10, stop: 11, target: 8, expiryBars: 9999 }, bar, 5).expiryBars, LIMITS.maxExpiry);
  assert.equal(normaliseSignal({ side: 'buy', stop: 9, target: 12 }, bar, 5, { expiryBars: 12 }).expiryBars, 12, 'the default expiry is used when the signal has none');
  const rej = (raw) => normaliseSignal(raw, bar, 5).reject;
  assert.equal(rej(null), 'not_an_object');
  assert.equal(rej([]), 'not_an_object');
  assert.equal(rej({ side: 'up', stop: 9, target: 12 }), 'bad_side');
  assert.equal(rej({ side: 'buy', stop: NaN, target: 12 }), 'not_a_number');
  assert.equal(rej({ side: 'buy', stop: '9', target: 12 }), 'not_a_number', 'a string is not a price');
  assert.equal(rej({ side: 'buy', stop: 11, target: 12 }), 'bad_geometry', 'a buy stop above the entry');
  assert.equal(rej({ side: 'buy', stop: 9, target: 9.5 }), 'bad_geometry', 'a buy target below the entry');
  assert.equal(rej({ side: 'sell', stop: 9, target: 8 }), 'bad_geometry');
  assert.equal(rej({ side: 'buy', entry: 10, stop: 10, target: 12 }), 'bad_geometry', 'no distance to the stop');
  assert.equal(rej({ side: 'buy', entry: -1, stop: -2, target: 5 }), 'bad_price', 'prices must be above zero');
  assert.equal(rej({ side: 'sell', entry: 5, stop: 6, target: 0 }), 'bad_price');
});

test('run: bad signals are counted by reason, never thrown; per-bar and total caps apply; async onBar is refused', () => {
  const code = `function onBar(ctx) {
    if (ctx.i % 10 !== 0) return null;
    const c = ctx.candle().close;
    if (ctx.i % 20 === 0) return [{ side: 'buy', stop: c - 1, target: c + 1 }, { side: 'sell', stop: c + 1, target: c - 1 }, { side: 'buy', stop: c - 2, target: c + 2 }, { side: 'buy', stop: c - 3, target: c + 3 }];
    return { side: 'buy', stop: c + 5, target: c + 6 };
  }`;
  const r = runSandboxed({ code, candles: M1, maxSignals: 100000 });
  assert.equal(r.ok, true);
  assert.equal(r.rejected.byReason.bad_geometry > 0, true);
  assert.equal(r.rejected.byReason.too_many_on_bar > 0, true);
  assert.ok(r.signals.every((s) => s.index % 20 === 0), 'only the good bars produced signals');
  const per = new Map();
  for (const s of r.signals) per.set(s.index, (per.get(s.index) || 0) + 1);
  assert.ok([...per.values()].every((n) => n <= LIMITS.perBar));
  assert.ok(r.rejected.examples.length <= LIMITS.maxExamples);

  const capped = runSandboxed({ code: "function onBar(ctx) { const c = ctx.candle().close; return { side: 'buy', stop: c - 1, target: c + 1 }; }", candles: M1, maxSignals: 25 });
  assert.equal(capped.signals.length, 25);
  assert.equal(capped.truncated, true);
  const exact = runSandboxed({ code: "function onBar(ctx) { const c = ctx.candle().close; return ctx.i === 30 ? { side: 'buy', stop: c - 1, target: c + 1 } : null; }", candles: M1, maxSignals: 1 });
  assert.equal(exact.signals.length, 1);

  const async = runSandboxed({ code: 'async function onBar(ctx) { return null; }', candles: M1 });
  assert.equal(async.code, 'async_onbar');
});

test('run: bad input is refused before any code runs', () => {
  assert.equal(runSandboxed({ code: 'function onBar() {}', candles: [] }).code, 'bad_input');
  assert.equal(runSandboxed({ code: 'function onBar() {}', candles: [{ epoch: 1, open: 1, high: 1, low: 1, close: 1 }, { epoch: 1, open: 1, high: 1, low: 1, close: 1 }] }).code, 'bad_input', 'repeated epoch');
  assert.equal(runSandboxed({ code: 'function onBar() {}', candles: [{ epoch: 1, open: 1, high: 1, low: 1, close: 1 }, { epoch: 2, open: 1, high: NaN, low: 1, close: 1 }] }).code, 'bad_input', 'NaN price');
  assert.equal(runSandboxed({ code: 'function onBar() {}', candles: M1, params: { big: 10n } }).code, 'bad_input', 'a BigInt cannot be written as JSON');
  assert.equal(runSandboxed({ code: 'function onBar() {}', candles: M1, params: { f: () => 1 } }).ok, true, 'a function value is dropped from the parameters');
  assert.equal(runSandboxed({ code: 'fetch("x"); function onBar() {}', candles: M1 }).code, 'blocked_code');
  assert.equal(runSandboxed({ code: 'function onBar() {}', candles: M1, maxCodeChars: 5 }).code, 'blocked_code');
});

// ---------------------------------------------------------------- the examples

test('examples: three of them, each compiles, passes the scan, and gives valid, repeatable signals on M1 and M5', () => {
  assert.equal(EXAMPLES.length, 3);
  assert.deepEqual(EXAMPLES.map((e) => e.id), ['ema_cross', 'range_fade', 'failed_breakout']);
  const M5 = aggregate(M1, 300);
  for (const ex of EXAMPLES) {
    assert.equal(scanCode(ex.code).ok, true, ex.id);
    assert.match(ex.code, /function onBar\(ctx\)/);
    for (const candles of [M1, M5]) {
      const r = runSandboxed({ code: ex.code, candles, params: ex.params });
      assert.equal(r.ok, true, `${ex.id}: ${r.error}`);
      assert.ok(r.signals.length > 3, `${ex.id} gave ${r.signals.length}`);
      assert.equal(r.rejected.total, 0, `${ex.id} rejected ${JSON.stringify(r.rejected.byReason)}`);
      assert.deepEqual(r.signals, runSandboxed({ code: ex.code, candles, params: ex.params }).signals, 'repeatable');
      assert.ok(r.signals.some((s) => s.side === 'buy') && r.signals.some((s) => s.side === 'sell'), ex.id);
      for (const s of r.signals) {
        assert.ok(s.reason.length > 0);
        assert.equal(s.entry, candles[s.index].close, 'the entry is the close of the signal bar');
      }
    }
    // They also work with no parameters at all: the defaults are in the code.
    assert.equal(runSandboxed({ code: ex.code, candles: M1, params: {} }).ok, true);
  }
  assert.ok(API_DOC.length >= 10 && API_DOC.every((d) => d.name && d.text));
});

// ---------------------------------------------------------------- the library

test('library: save, version, restore, remove, and the rules', () => {
  let clock = 1000;
  const saved = [];
  const lib = new StrategyLibrary({ nowFn: () => (clock += 1), persist: (entries) => saved.push(entries.length), maxVersions: 3 });
  assert.deepEqual(lib.list(), []);
  const a = lib.save({ name: ' First ', code: 'function onBar(ctx) { return null; }', params: { x: 1 } });
  assert.deepEqual(a, { ok: true, id: 'S1', version: 1 });
  assert.equal(lib.get('S1').name, 'First');
  assert.deepEqual(lib.save({ id: 'S1', name: 'First', code: 'function onBar(ctx) { return null; }', params: { x: 1 } }), { ok: true, id: 'S1', version: 1, unchanged: true });
  assert.equal(saved.length, 1, 'an unchanged save does not persist again');
  const b = lib.save({ id: 'S1', name: 'First', code: 'function onBar(ctx) { return 1; }', params: { x: 2 } });
  assert.equal(b.version, 2);
  assert.equal(lib.save({ name: 'Second', code: 'function onBar() {}' }).id, 'S2');
  assert.deepEqual(lib.list().map((r) => r.id), ['S2', 'S1'], 'newest first');

  lib.save({ id: 'S1', name: 'First', code: 'function onBar(ctx) { return 2; }' });
  lib.save({ id: 'S1', name: 'First', code: 'function onBar(ctx) { return 3; }' });
  assert.deepEqual(lib.versions('S1').map((v) => v.version), [4, 3, 2], 'only the newest three are kept, and version numbers are never reused');
  assert.equal(lib.get('S1').version, 4);
  assert.equal(lib.getVersion('S1', 1), null);
  assert.match(lib.getVersion('S1', 2).code, /return 1/);

  const r = lib.restoreVersion('S1', 2);
  assert.equal(r.version, 5);
  assert.match(lib.get('S1').code, /return 1/);
  assert.deepEqual(lib.get('S1').params, { x: 2 });
  assert.equal(lib.restoreVersion('S1', 99).ok, false);
  assert.equal(lib.versions('S1')[0].note, 'Restored from version 2');

  assert.equal(lib.remove('S2'), true);
  assert.equal(lib.remove('S2'), false);
  assert.equal(lib.get('S2'), null);
  assert.equal(lib.save({ name: 'Third', code: 'function onBar() {}' }).id, 'S2', 'a free id is reused for a new strategy');
});

test('library: bad input is refused with plain words, and a copy cannot change the stored strategy', () => {
  const lib = new StrategyLibrary({ maxStrategies: 2, maxCodeChars: 50 });
  assert.match(lib.save({ name: '', code: 'x' }).error, /name/);
  assert.match(lib.save({ name: 'x'.repeat(61), code: 'x' }).error, /too long/);
  assert.match(lib.save({ name: 'a', code: '   ' }).error, /no code/);
  assert.match(lib.save({ name: 'a', code: 'x'.repeat(51) }).error, /limit is 50/);
  assert.match(lib.save({ name: 'a', code: 'x', params: [1] }).error, /must be an object/);
  assert.match(lib.save({ name: 'a', code: 'x', params: { big: 'y'.repeat(5000) } }).error, /too long/);
  assert.match(lib.save({ id: 'S9', name: 'a', code: 'x' }).error, /does not exist/);
  assert.equal(lib.save({ name: 'a', code: 'x' }).ok, true);
  assert.equal(lib.save({ name: 'b', code: 'x' }).ok, true);
  assert.match(lib.save({ name: 'c', code: 'x' }).error, /2 strategies at most/);
  const got = lib.get('S1');
  got.params.hack = true;
  got.code = 'changed';
  assert.equal(lib.get('S1').code, 'x');
  assert.deepEqual(lib.get('S1').params, {});
});

test('library: export and load round-trip, damaged entries are dropped, and ids carry on', () => {
  const lib = new StrategyLibrary({ nowFn: () => 5 });
  lib.save({ name: 'A', code: 'function onBar() {}', params: { k: 1 } });
  lib.save({ id: 'S1', name: 'A', code: 'function onBar() { return null; }' });
  lib.save({ name: 'B', code: 'function onBar() {}' });
  const dump = JSON.parse(JSON.stringify(lib.export()));
  const again = new StrategyLibrary({ nowFn: () => 6 });
  assert.equal(again.load([...dump, null, { id: 'S7' }, { id: 'S8', versions: [{ code: 5 }] }, { id: 'S9', versions: 'no' }]), 2);
  assert.deepEqual(again.export(), lib.export());
  assert.equal(again.save({ name: 'C', code: 'function onBar() {}' }).id, 'S3');
  assert.equal(again.save({ id: 'S1', name: 'A', code: 'function onBar() { return 7; }' }).version, 3, 'version numbering continues after a load');
});

// ---------------------------------------------------------------- the host with a stub worker

const stubFactory = (behave, log = {}) => () => {
  const w = {
    terminated: 0,
    postMessage(msg) {
      log.sent = msg;
      behave(w, msg);
    },
    terminate() {
      w.terminated += 1;
      log.terminated = (log.terminated || 0) + 1;
    },
  };
  log.worker = w;
  return w;
};

test('host: a good answer resolves and the worker is always ended', async () => {
  const log = {};
  const r = await runStrategy(
    { code: 'function onBar(ctx) { return null; }', candles: M1.slice(0, 50), params: { a: 1 }, maxSignals: 7 },
    stubFactory((w) => w.onmessage({ data: { ok: true, signals: [], rejected: { total: 0, byReason: {}, examples: [] }, truncated: false, barsRun: 30, firstBar: 20 } }), log),
  );
  assert.equal(r.ok, true);
  assert.equal(typeof r.ms, 'number');
  assert.equal(log.terminated, 1);
  assert.equal(log.sent.maxSignals, 7);
  assert.deepEqual(log.sent.params, { a: 1 });
});

test('host: a refused strategy never starts a worker', async () => {
  let started = 0;
  const factory = () => {
    started += 1;
    return { postMessage() {}, terminate() {} };
  };
  const blocked = await runStrategy({ code: 'fetch("x"); function onBar() {}', candles: M1.slice(0, 50) }, factory);
  assert.equal(blocked.code, 'blocked_code');
  assert.match(blocked.error, /"fetch" is not available/);
  const nothing = await runStrategy({ code: 'function onBar() {}', candles: [] }, factory);
  assert.equal(nothing.code, 'bad_input');
  const long = await runStrategy({ code: 'function onBar() {}'.padEnd(500, ' '), candles: M1.slice(0, 50), maxCodeChars: 100 }, factory);
  assert.equal(long.code, 'blocked_code');
  assert.equal(started, 0);
  const none = await runStrategy({ code: 'function onBar() {}', candles: M1.slice(0, 50) });
  assert.equal(none.code, 'no_worker', 'no Worker in Node and no factory given');
  const boom = await runStrategy({ code: 'function onBar() {}', candles: M1.slice(0, 50) }, () => { throw new Error('nope'); });
  assert.equal(boom.code, 'no_worker');
});

test('host: errors, wrong-shaped answers and silence all end the worker with a clear code', async () => {
  const code = 'function onBar() { return null; }';
  const candles = M1.slice(0, 50);
  let log = {};
  const err = await runStrategy({ code, candles }, stubFactory((w) => w.onerror({ message: 'kaboom', preventDefault() {} }), log));
  assert.equal(err.code, 'worker_error');
  assert.match(err.error, /kaboom/);
  assert.equal(log.terminated, 1);

  log = {};
  const shape = await runStrategy({ code, candles }, stubFactory((w) => w.onmessage({ data: 'hello' }), log));
  assert.equal(shape.code, 'worker_error');
  assert.equal(log.terminated, 1);

  log = {};
  const bad = await runStrategy({ code, candles }, stubFactory((w) => w.onmessageerror(), log));
  assert.equal(bad.code, 'worker_error');

  log = {};
  const t0 = Date.now();
  const slow = await runStrategy({ code, candles, timeoutMs: 80 }, stubFactory(() => {}, log));
  assert.equal(slow.code, 'timed_out');
  assert.ok(Date.now() - t0 >= 70 && Date.now() - t0 < 1500);
  assert.equal(log.terminated, 1);
  // A late answer after the time limit is ignored, and the worker is not ended twice.
  log.worker.onmessage({ data: { ok: true, signals: [] } });
  assert.equal(log.terminated, 1);

  log = {};
  const thrown = await runStrategy({ code, candles }, stubFactory(() => { throw new Error('clone failed'); }, log));
  assert.equal(thrown.code, 'bad_input');
  assert.equal(log.terminated, 1);
});

// ---------------------------------------------------------------- the real worker, in a Node worker thread

test('real worker: runs an example through worker.js and gives the same signals as in-process', async () => {
  const ex = EXAMPLES[0];
  const inProcess = runSandboxed({ code: ex.code, candles: M1, params: ex.params });
  const r = await runStrategy({ code: ex.code, candles: M1, params: ex.params, timeoutMs: 8000 }, nodeWorkerFactory);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.signals, inProcess.signals);
  assert.deepEqual(r.rejected, inProcess.rejected);
});

test('real worker: an endless loop is stopped at the time limit and the thread is ended', async () => {
  const t0 = Date.now();
  let raw = null;
  const factory = () => {
    const w = nodeWorkerFactory();
    raw = w.raw;
    return w;
  };
  const r = await runStrategy({ code: 'function onBar(ctx) { while (true) {} }', candles: M1, timeoutMs: 300 }, factory);
  assert.equal(r.code, 'timed_out');
  assert.ok(Date.now() - t0 < 5000);
  await new Promise((resolve) => (raw.threadId === -1 ? resolve() : raw.once('exit', resolve)));
  assert.equal(raw.threadId, -1, 'the worker thread has ended');
});

test('real worker: a loop at load time, an error, and a blocked name each come back as a clear result', async () => {
  const top = await runStrategy({ code: 'while (true) {}\nfunction onBar() {}', candles: M1, timeoutMs: 300 }, nodeWorkerFactory);
  assert.equal(top.code, 'timed_out');
  const err = await runStrategy({ code: 'function onBar(ctx) { return ctx.nothing.deeper; }', candles: M1, timeoutMs: 5000 }, nodeWorkerFactory);
  assert.equal(err.code, 'runtime_error');
  assert.match(err.error, /^Bar 20: TypeError/);
});

test('real worker: the lockdown removes the network, timers and the route to the Function constructor', async () => {
  // Ask the thread what is left after worker.js has locked it down.
  const factory = nodeWorkerFactory();
  const diag = await new Promise((resolve) => {
    // The worker's own handler also answers (it has no code to run), so wait for the diagnostics reply.
    factory.onmessage = (ev) => {
      if (ev.data && ev.data.diag) resolve(ev.data.diag);
    };
    factory.postMessage({ diag: true });
  });
  factory.terminate();
  assert.deepEqual(diag, { fetch: 'undefined', setTimeout: 'undefined', process: 'undefined', self: 'undefined', globalThis: 'undefined', functionCtor: 'undefined', asyncCtor: 'undefined', math: 'function' });

  // The classic escape, written so that the static scan cannot see it: build a Function from a string.
  const escape = "function onBar(ctx) { const f = []['con' + 'structor']['con' + 'structor']; return typeof f === 'function' ? { side: 'buy', entry: 2, stop: 1, target: 3, reason: 'ESCAPED' } : null; }";
  assert.equal(scanCode(escape).ok, true, 'the scan alone is evaded by string concatenation (that is why it is only one layer)');
  const inProcess = runSandboxed({ code: escape, candles: M1 });
  assert.equal(inProcess.signals[0].reason, 'ESCAPED', 'in-process, with no lockdown, the escape works');
  const inWorker = await runStrategy({ code: escape, candles: M1, timeoutMs: 5000 }, nodeWorkerFactory);
  assert.equal(inWorker.ok, true);
  assert.equal(inWorker.signals.length, 0, 'in the worker the same code finds no Function constructor');
});
