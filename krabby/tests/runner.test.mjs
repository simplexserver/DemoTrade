// The runner: the clock, saving only with consent, restoring, wiping, history, scans, rules on paper, replay, the live feed.
// Everything runs on a fake clock, in-memory storage and in-memory IndexedDB, so the tests are quick and repeatable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, QUICK } from './helpers/env.mjs';
import { simCandles } from './helpers/sim.mjs';
import { nodePoolWorkerFactory } from './helpers/node-pool-worker.mjs';
import { SCHEMA_BY_KEY } from '../js/core/schema.js';

const withSpeed = (speed, over = {}) => ({ ...QUICK, ...over, data: { ...QUICK.data, simSpeed: speed, ...(over.data || {}) } });
const RULE = { side: 'buy', conds: [{ feature: 'trend', level: 2 }], stopAtr: 1.5, rr: 2, horizon: 24 };
const scanResult = (rule = RULE) => ({
  ok: true, bars: 5000, tried: 11, tested: 11, candidates: 1, depth: 1, warnings: [], verdict: { level: 'shown', text: 'x' },
  survivors: [{ rule, text: 'Buy when trend is up', train: { n: 50, mean: 0.2 }, val: { n: 20, mean: 0.2 }, test: { n: 30, mean: 0.3, lo: 0.1, hi: 0.5 } }],
});
const lastEpoch = (r) => r.session.candles('R_100', 60, 1)[0].epoch;

test('init and snapshot: everything the screens draw is there, and it can be written as JSON', async () => {
  const e = makeEnv({ consent: 'unset' });
  await e.runner.init();
  const snap = e.runner.snapshot();
  for (const k of ['run', 'session', 'settings', 'consent', 'storage', 'history', 'scan', 'rules', 'compute', 'lab']) assert.ok(k in snap, k);
  assert.equal(snap.consent, 'unset');
  assert.equal(snap.run.status, 'stopped');
  assert.equal(snap.session.account.balance, 1000);
  assert.equal(snap.session.account.usableCapUsd, 5, 'the $5 cap is in force from the first moment');
  assert.equal(snap.compute.enabled, false);
  assert.equal(snap.compute.caps.workers, false, 'no worker support here, so the pool would run inline');
  assert.doesNotThrow(() => JSON.stringify(snap));
  assert.equal(await e.runner.init(), e.runner, 'init is safe to call twice');
});

test('clock: the simulated market runs at the chosen speed, whatever the timers do', async () => {
  const e = makeEnv({ settings: withSpeed('60') });
  await e.runner.start();
  assert.equal(e.runner.run.status, 'running');
  assert.equal(e.clock.intervals.size, 2, 'one timer for the market, one for saving');
  e.clock.advance(10_000);
  assert.equal(e.runner.run.simBars, 600, '60 bars a second for ten seconds');
  assert.equal(e.runner.session.stats.counts.candles, 600 + 120, 'M1 candles plus the M5 candles built from them');
  assert.ok(e.runner.run.speed > 0);
  await e.runner.dispose();
});

test('clock: a tab that was asleep works off what it owes over the next ticks, with a limit', async () => {
  const e = makeEnv({ settings: withSpeed('60'), extra: { maxBarsPerTick: 300 } });
  await e.runner.start();
  e.clock.sleepThenFire(20_000); // the browser held the timers for twenty seconds: 1,200 bars are owed, capped at three ticks' worth
  assert.equal(e.runner.run.simBars, 300, 'at most 300 bars in one tick, so the page stays responsive');
  e.clock.advance(250);
  assert.equal(e.runner.run.simBars, 600, 'the rest is not thrown away');
  e.clock.advance(250);
  assert.equal(e.runner.run.simBars, 900);
  e.clock.advance(250);
  assert.equal(e.runner.run.simBars, 945, 'the debt was capped at 900, plus what the normal ticks added');
  e.clock.advance(250);
  assert.equal(e.runner.run.simBars, 960, 'back to 15 bars a tick');
  await e.runner.dispose();
});

test('clock: a slow device does less per tick instead of freezing, and keeps what it owes', async () => {
  let t = 0;
  const e = makeEnv({ settings: withSpeed('60'), extra: { perfNow: () => { t += 50; return t; }, tickWorkMs: 120 } });
  await e.runner.start();
  e.clock.advance(250);
  assert.equal(e.runner.run.simBars, 2, 'the time limit allows two bars here');
  assert.equal(e.runner.run.speed, 8);
  e.clock.advance(250);
  assert.equal(e.runner.run.simBars, 4);
  await e.runner.dispose();
});

test('clock: the fastest speed never stalls and is limited per tick', async () => {
  const e = makeEnv({ settings: withSpeed('max'), extra: { maxBarsPerTick: 200 } });
  await e.runner.start();
  e.clock.advance(250);
  assert.equal(e.runner.run.simBars, 200);
  await e.runner.dispose();
});

test('pause, resume and stop leave the account alone and clean up every timer', async () => {
  const e = makeEnv({ settings: withSpeed('60') });
  await e.runner.start();
  e.clock.advance(2000);
  assert.equal(e.runner.run.simBars, 120);
  await e.runner.pause();
  assert.equal(e.runner.run.status, 'paused');
  assert.equal(e.runner.session.running, false);
  assert.equal(e.clock.intervals.size, 1, 'only the saving timer is left');
  e.clock.advance(5000);
  assert.equal(e.runner.run.simBars, 120, 'nothing moves while paused');
  await e.runner.resume();
  assert.equal(e.runner.run.status, 'running');
  e.clock.advance(1000);
  assert.equal(e.runner.run.simBars, 180, 'time spent paused is not owed afterwards');
  await e.runner.stop();
  assert.equal(e.runner.run.status, 'stopped');
  assert.equal(e.clock.intervals.size, 0);
  assert.equal((await e.runner.pause()).status, 'stopped', 'pausing a stopped runner does nothing');
  await e.runner.dispose();
});

test('listeners hear about changes, can leave, and a broken listener cannot stop the runner', async () => {
  const e = makeEnv({ settings: withSpeed('60') });
  let heard = 0;
  const off = e.runner.on(() => { heard += 1; });
  e.runner.on(() => { throw new Error('a screen broke'); });
  await e.runner.start();
  e.clock.advance(1000);
  assert.ok(heard > 4);
  assert.equal(e.runner.run.simBars, 60, 'the broken listener did not stop the market');
  off();
  const before = heard;
  e.clock.advance(1000);
  assert.equal(heard, before);
  await e.runner.dispose();
});

test('wake lock: asked for while running, released on stop, asked again when the page is visible', async () => {
  const calls = { request: 0, release: 0 };
  const nav = { hardwareConcurrency: 4, wakeLock: { request: async (kind) => { calls.request += 1; assert.equal(kind, 'screen'); return { release: async () => { calls.release += 1; } }; } } };
  const e = makeEnv({ nav, settings: withSpeed('60') });
  await e.runner.start();
  assert.equal(calls.request, 1);
  await e.runner.onVisible();
  assert.equal(calls.request, 2, 'browsers drop the lock when a tab is hidden, so it is asked for again');
  await e.runner.stop();
  assert.equal(calls.release, 1);
  const off = makeEnv({ nav, settings: withSpeed('60', { app: { wakeLock: false } }) });
  await off.runner.start();
  assert.equal(calls.request, 2, 'switched off in the settings: never asked');
  await off.runner.dispose();
  await e.runner.dispose();
});

test('consent refused: the app works and nothing at all is written or read', async () => {
  const e = makeEnv({ consent: 'declined', settings: withSpeed('60') });
  await e.runner.start();
  e.clock.advance(40_000); // past the autosave
  assert.equal(e.runner.run.simBars, 2400);
  assert.deepEqual(await e.runner.save(), { ok: false, reason: 'consent' });
  e.runner.setSetting('data.simSpeed', '120');
  await e.runner.stop();
  assert.equal(e.idb.writes, 0, 'no record was written');
  assert.deepEqual(e.idb.sizes(), { journal: 0, audit: 0, learning: 0, proposals: 0, candles: 0, strategies: 0, meta: 0 });
  assert.deepEqual(e.ls.keys(), ['krabby.v2.consent'], 'the only thing on the device is the answer itself');
  assert.equal(e.runner.snapshot().storage.lastSaveMs, null);
  assert.equal(e.runner.snapshot().settings.data.simSpeed, '120', 'the change is kept in memory for this page');
  await e.runner.dispose();
});

test('consent accepted: it saves on its own, and a new page picks up where it stopped', async () => {
  const a = makeEnv({ consent: 'accepted', settings: withSpeed('600') });
  await a.runner.start();
  a.clock.advance(35_000); // the autosave fires at 30 seconds
  assert.equal(a.idb.sizes().meta, 2, 'the account and the rule book');
  a.runner.rules.recordScan('R_100', 60, scanResult());
  await a.runner.stop();
  const saved = a.runner.session.exportState();
  const bars = a.runner.run.simBars;
  const endEpoch = lastEpoch(a.runner);
  const acct = a.runner.snapshot().session.account;
  assert.ok(bars > 1000);

  const b = makeEnv({ consent: 'accepted', settings: withSpeed('600'), ls: a.ls, ss: a.ss, idb: a.idb, clock: makeClock(a.clock.now + 3_600_000) });
  await b.runner.init();
  assert.equal(b.runner.run.simBars, bars, 'it remembers how far the simulated market had gone');
  const back = b.runner.session.exportState();
  assert.deepEqual(back.trader, saved.trader);
  assert.deepEqual(back.learning, saved.learning);
  assert.deepEqual(back.stats, saved.stats);
  assert.equal(b.runner.rules.list().length, 1, 'the rule book came back too');
  const acct2 = b.runner.snapshot().session.account;
  assert.equal(acct2.balance, acct.balance);
  assert.equal(acct2.closedCount, acct.closedCount);

  await b.runner.start();
  assert.equal(lastEpoch(b.runner), endEpoch, 'the market continues from the same minute, with no gap and no repeat');
  assert.equal(b.runner.snapshot().session.account.closedCount, acct.closedCount, 'starting again does not trade the past');
  b.clock.advance(1000);
  const tail = b.runner.session.candles('R_100', 60, 601);
  for (let i = 1; i < tail.length; i += 1) assert.equal(tail[i].epoch - tail[i - 1].epoch, 60);
  assert.equal(lastEpoch(b.runner), endEpoch + 600 * 60);
  await b.runner.dispose();
  await a.runner.dispose();
});

test('the "reset on start" setting starts a fresh paper account but keeps the rule book', async () => {
  const a = makeEnv({ consent: 'accepted', settings: withSpeed('600') });
  await a.runner.start();
  a.clock.advance(6000);
  a.runner.rules.recordScan('R_100', 60, scanResult());
  await a.runner.stop();
  assert.ok(a.runner.run.simBars > 0);
  const b = makeEnv({ consent: 'accepted', settings: withSpeed('600', { paper: { resetOnStart: true } }), ls: a.ls, ss: a.ss, idb: a.idb });
  await b.runner.init();
  assert.equal(b.runner.run.simBars, 0);
  assert.equal(b.runner.snapshot().session.account.closedCount, 0);
  assert.equal(b.runner.rules.list().length, 1);
  await b.runner.dispose();
  await a.runner.dispose();
});

test('accepting after changes keeps those changes and saves them right away', async () => {
  const e = makeEnv({ consent: 'unset', settings: withSpeed('60') });
  await e.runner.init();
  assert.equal(e.runner.setSetting('data.simSpeed', '120').ok, true);
  assert.equal(e.ls.getItem('krabby.v2.settings'), null, 'nothing written before the answer');
  assert.equal(await e.runner.setConsent('accepted'), 'accepted');
  assert.equal(e.runner.snapshot().settings.data.simSpeed, '120', 'the change on this page was not replaced by an older copy');
  assert.equal(JSON.parse(e.ls.getItem('krabby.v2.settings')).data.simSpeed, '120');
  assert.equal(e.idb.sizes().meta, 2);
  assert.equal(e.runner.snapshot().consent, 'accepted');
  assert.equal(await e.runner.setConsent('nonsense'), 'accepted', 'a value that is not an answer changes nothing');
  await e.runner.dispose();
});

test('taking consent back deletes what was saved and the app keeps running in memory', async () => {
  const e = makeEnv({ consent: 'accepted', settings: withSpeed('600') });
  await e.runner.start();
  e.clock.advance(3000);
  await e.runner.save();
  assert.ok(e.idb.sizes().meta > 0);
  assert.ok(e.ls.keys().includes('krabby.v2.settings'));
  await e.runner.setConsent('declined');
  assert.deepEqual(e.idb.sizes(), { journal: 0, audit: 0, learning: 0, proposals: 0, candles: 0, strategies: 0, meta: 0 });
  assert.deepEqual(e.ls.keys(), ['krabby.v2.consent']);
  assert.equal(e.runner.run.status, 'running');
  const bars = e.runner.run.simBars;
  e.clock.advance(40_000);
  assert.ok(e.runner.run.simBars > bars, 'it carries on');
  assert.deepEqual(await e.runner.save(), { ok: false, reason: 'consent' });
  assert.equal(e.idb.sizes().meta, 0, 'and still writes nothing');
  await e.runner.dispose();
});

test('wipe: everything saved and everything in memory goes, settings return to their defaults', async () => {
  const e = makeEnv({ consent: 'accepted', settings: withSpeed('600') });
  await e.runner.start();
  e.clock.advance(4000);
  e.runner.rules.recordScan('R_100', 60, scanResult());
  await e.runner.loadHistory({ assets: ['R_100'], tfs: [300] });
  assert.equal(e.runner.snapshot().history.held.length, 1);
  await e.runner.save();
  const before = e.runner.session;
  const res = await e.runner.wipe();
  assert.equal(res.ok, true);
  assert.equal(e.runner.run.status, 'stopped', 'a running market is stopped first');
  assert.deepEqual(e.idb.sizes(), { journal: 0, audit: 0, learning: 0, proposals: 0, candles: 0, strategies: 0, meta: 0 });
  assert.deepEqual(e.ls.keys(), ['krabby.v2.consent'], 'the answer to the banner is not part of the data');
  assert.notEqual(e.runner.session, before, 'a clean session');
  const snap = e.runner.snapshot();
  assert.equal(snap.session.account.closedCount, 0);
  assert.deepEqual(snap.settings.data.assets, ['R_100', 'frxXAUUSD'], 'back to the defaults');
  assert.equal(snap.rules.list.length, 0);
  assert.equal(snap.history.held.length, 0);
  assert.equal(snap.run.simBars, 0);
  assert.equal(e.clock.intervals.size, 0);
  await e.runner.dispose();
});

test('settings go through the schema: the $5 cap cannot be changed from here', async () => {
  const e = makeEnv({ consent: 'accepted', settings: withSpeed('60') });
  await e.runner.init();
  const res = e.runner.setSetting('risk.usableCapUsd', 50);
  assert.equal(res.ok, false);
  assert.equal(e.runner.snapshot().settings.risk.usableCapUsd, 5);
  assert.equal(e.runner.snapshot().session.account.usableCapUsd, 5);
  assert.equal(e.runner.setSetting('no.such.setting', 1).ok, false);
  assert.equal(e.runner.setSetting('data.simSpeed', 'warp nine').ok, false);
  await e.runner.dispose();
});

test('changes the learning loop makes after an approval are written to the settings store', async () => {
  const e = makeEnv({ consent: 'accepted', settings: withSpeed('60') });
  await e.runner.init();
  const key = 'lse.minLiquidityRank';
  assert.ok(SCHEMA_BY_KEY[key].learnable);
  const res = e.runner.session.applySettingsChanges({ [key]: 61 });
  assert.equal(res.ok, true);
  assert.equal(e.runner.snapshot().settings.lse.minLiquidityRank, 61);
  assert.equal(JSON.parse(e.ls.getItem('krabby.v2.settings')).lse.minLiquidityRank, 61, 'it survives a reload');
  const locked = e.runner.session.applySettingsChanges({ 'risk.usableCapUsd': 50 });
  assert.equal(locked.ok, false, 'the learning loop can never touch the cap');
  assert.equal(e.runner.approveProposal('P:none', 'APPROVE P:none').ok, false);
  await e.runner.dispose();
});

test('history from the simulator: made on demand, held for scans, independent of the live run', async () => {
  const e = makeEnv({ consent: 'declined', settings: withSpeed('60') });
  const res = await e.runner.loadHistory({ assets: ['R_100'], tfs: [300] });
  assert.equal(res.state, 'done');
  assert.equal(res.items[0].state, 'done');
  assert.equal(res.items[0].have, 3500);
  const snap = e.runner.snapshot();
  assert.deepEqual(snap.history.held.map((h) => [h.key, h.bars]), [['R_100|300', 3500]]);
  assert.equal(e.runner.candlesFor('R_100', 300).length, 3500);
  assert.equal(e.runner.candlesFor('R_100', 3600).length, 0, 'nothing for a timeframe that was not loaded');
  await e.runner.dispose();
});

test('scan: finds nothing to scan before history exists, then scans, records and can be cancelled', async () => {
  const e = makeEnv({ consent: 'declined', settings: withSpeed('60') });
  const none = await e.runner.scan();
  assert.equal(none.state, 'error');
  assert.match(none.message, /no history/i);
  await e.runner.loadHistory({ assets: ['R_100'], tfs: [300] });
  const done = await e.runner.scan({ asset: 'R_100', tf: 300 });
  assert.equal(done.state, 'done');
  assert.equal(done.results.length, 1);
  assert.equal(done.results[0].ok, true);
  assert.ok(done.results[0].tested > 0);
  const snap = e.runner.snapshot();
  assert.equal(snap.rules.scans['R_100|300'].ok, true);
  assert.equal(snap.compute.size, 0, 'computing on the page is off, so the scan ran on the page itself');

  const p = e.runner.scan({ asset: 'R_100', tf: 300 });
  e.runner.cancelScan();
  const stopped = await p;
  assert.equal(stopped.state, 'cancelled');
  await e.runner.dispose();
});

test('scan on background workers gives the same rules as on the page', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class FakeWorker {}; // only so the capability check says workers exist; the factory makes real ones
  try {
    const inline = makeEnv({ consent: 'declined', settings: withSpeed('60') });
    await inline.runner.loadHistory({ assets: ['R_100'], tfs: [300] });
    await inline.runner.scan();
    const w = makeEnv({ consent: 'declined', settings: withSpeed('60', { compute: { enabled: true, threads: 2 } }), workerFactory: nodePoolWorkerFactory });
    await w.runner.loadHistory({ assets: ['R_100'], tfs: [300] });
    const done = await w.runner.scan();
    assert.equal(done.state, 'done');
    assert.equal(w.runner.snapshot().compute.size, 2, 'two background workers were used');
    assert.equal(JSON.stringify(w.runner.rules.exportState().rules), JSON.stringify(inline.runner.rules.exportState().rules));
    await w.runner.dispose();
    await inline.runner.dispose();
  } finally {
    if (had) Object.defineProperty(globalThis, 'Worker', had); else delete globalThis.Worker;
  }
});

test('rules the scanner kept are traded on paper through the same risk checks, and counted by name', async () => {
  const e = makeEnv({ consent: 'declined', settings: withSpeed('600', { scan: { use: 'paper' } }) });
  await e.runner.init();
  e.runner.rules.recordScan('R_100', 60, scanResult());
  await e.runner.start();
  e.clock.advance(8000);
  const verdicts = e.runner.session.verdicts.filter((v) => v.source === 'strategy');
  assert.ok(verdicts.length > 10, `the rule produced proposals (${verdicts.length})`);
  for (const v of verdicts) assert.ok(v.ok || v.codes.length > 0, 'every proposal was approved or refused with a reason');
  const snap = e.runner.snapshot();
  assert.equal(snap.session.account.usableCapUsd, 5);
  const radar = e.runner.snapshot().rules.radar;
  assert.ok(Array.isArray(radar));
  await e.runner.dispose();

  const off = makeEnv({ consent: 'declined', settings: withSpeed('600', { scan: { use: 'radar' } }) });
  await off.runner.init();
  off.runner.rules.recordScan('R_100', 60, scanResult());
  await off.runner.start();
  off.clock.advance(4000);
  assert.equal(off.runner.session.verdicts.filter((v) => v.source === 'strategy').length, 0, 'radar only watches; it never trades');
  await off.runner.dispose();
});

test('emergency stop halts new orders at once and the reason is on record', async () => {
  const e = makeEnv({ consent: 'declined', settings: withSpeed('600') });
  await e.runner.start();
  const st = e.runner.emergencyStop(true, 'test');
  assert.equal(st.on, true);
  e.clock.advance(4000);
  const snap = e.runner.snapshot();
  assert.equal(snap.session.account.openCount + snap.session.account.pendingCount + snap.session.account.closedCount, 0);
  assert.ok(snap.session.stats.refusals.some((r) => r.code === 'emergency_stop'));
  assert.equal(e.runner.emergencyStop(false).on, false);
  await e.runner.dispose();
});

test('backtest through the runner: runs, reports progress, and can be cancelled', async () => {
  const e = makeEnv({ consent: 'declined', settings: withSpeed('60') });
  const candles = simCandles(1300, 5, { kind: 'regimes' });
  const progress = [];
  e.runner.on(() => { if (e.runner.lab.progress) progress.push(e.runner.lab.progress.phase); });
  const res = await e.runner.backtest({ asset: 'R_100', tf: 60, candles, limits: 'relaxed', label: 'engines' });
  assert.equal(res.state, 'done', res.error || '');
  assert.ok(res.result.ok);
  assert.ok(progress.length > 0);
  assert.equal(e.runner.snapshot().lab.state, 'done');
  const p = e.runner.backtest({ asset: 'R_100', tf: 60, candles, limits: 'relaxed' });
  e.runner.cancelBacktest();
  assert.equal((await p).state, 'cancelled');
  await e.runner.dispose();
});

test('imported candles: loaded, replayed through the same session, and the end is reported', async () => {
  const e = makeEnv({ consent: 'declined', settings: withSpeed('600', { data: { source: 'replay' } }) });
  const none = await e.runner.start();
  assert.equal(none.status, 'error', 'replay with no file');
  assert.match(none.message, /Import a candle file/);
  const bad = e.runner.loadReplay({ asset: 'R_100', tf: 60, text: 'not,a,candle\nfile' });
  assert.equal(bad.ok, false);
  const m1 = simCandles(900, 3);
  const csv = ['epoch,open,high,low,close', ...m1.map((c) => `${c.epoch},${c.open},${c.high},${c.low},${c.close}`)].join('\n');
  const ok = e.runner.loadReplay({ asset: 'R_100', tf: 60, text: csv });
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 900);
  e.runner.run.status = 'stopped';
  await e.runner.start();
  assert.equal(e.runner.run.status, 'running');
  e.clock.advance(1000);
  assert.equal(e.runner.session.candles('R_100', 60, 5000).length, 900, 'all the imported candles went through the session');
  assert.match(e.runner.run.message, /ended/);
  await e.runner.dispose();
});

// A stand-in for the Deriv API object the feed expects (streamCandles and request).
function fakeDeriv(clock, { bars = 200 } = {}) {
  const tf = 60;
  const nowSec = Math.floor(clock.now / 1000);
  const lastClosed = nowSec - (nowSec % tf) - tf;
  const all = simCandles(bars + 1, 11).map((c, i) => ({ ...c, epoch: lastClosed - (bars - i) * tf + tf }));
  const streams = [];
  const requests = [];
  const api = {
    streamCandles(asset, granularity, cb, count) {
      const list = all.filter((c) => granularity === tf).slice(-count);
      streams.push({ asset, granularity, cb, stopped: false });
      cb({ type: 'history', candles: list });
      return () => { streams[streams.length - 1].stopped = true; };
    },
    async request(req) {
      requests.push(req);
      const end = req.end === 'latest' ? Infinity : req.end;
      return { candles: all.filter((c) => c.epoch <= end).slice(-req.count) };
    },
  };
  return { api, streams, requests, all, loader: async () => ({ api, cleanCandles: (x) => x }) };
}

test('the Deriv source: seeds from history, trades closed candles only, and runs on the wall clock', async () => {
  const clock = makeClock();
  const f = fakeDeriv(clock);
  const e = makeEnv({ consent: 'declined', clock, loadDeriv: f.loader, settings: { ...QUICK, data: { ...QUICK.data, source: 'deriv', timeframes: [60], historyBars: 200 }, engine: { ...QUICK.engine, tradeTimeframes: [60] } } });
  await e.runner.start();
  assert.equal(e.runner.run.status, 'running', e.runner.run.error || '');
  assert.equal(e.runner.run.source, 'deriv');
  assert.equal(e.clock.intervals.has(1), true);
  const seeded = e.runner.session.candles('R_100', 60, 1000);
  assert.ok(seeded.length >= 190, `history seeded the session (${seeded.length})`);
  assert.equal(e.runner.session.clockNow(), clock.now, 'the session reads the wall clock when live');
  const stream = f.streams[0];
  const next = f.all[f.all.length - 1].epoch + 60;
  const before = e.runner.session.stats.counts.candles;
  stream.cb({ type: 'candle', candle: { epoch: next, open: 1000, high: 1001, low: 999, close: 1000.5 } });
  assert.equal(e.runner.session.stats.counts.candles, before, 'the forming candle is held back');
  stream.cb({ type: 'candle', candle: { epoch: next + 60, open: 1000.5, high: 1002, low: 1000, close: 1001 } });
  assert.equal(e.runner.session.stats.counts.candles, before + 1, 'it is used once the next one starts');
  await e.runner.stop();
  assert.ok(f.streams.every((s) => s.stopped), 'the stream was closed');
  await e.runner.dispose();
});

test('the Deriv source: a download error is reported and nothing crashes', async () => {
  const e = makeEnv({ consent: 'declined', loadDeriv: async () => { throw new Error('offline'); }, settings: { ...QUICK, data: { ...QUICK.data, source: 'deriv' } } });
  const res = await e.runner.start();
  assert.equal(res.status, 'error');
  assert.match(res.message, /offline/);
  assert.equal(e.clock.intervals.size, 0);
  await e.runner.dispose();
});

test('history from Deriv: downloaded in pages, cached only with consent, and the public feed needs no token', async () => {
  const clock = makeClock();
  const f = fakeDeriv(clock, { bars: 4000 });
  const settings = { ...QUICK, data: { ...QUICK.data, source: 'deriv' }, hist: { ...QUICK.hist, targetBars: 3500, timeframes: [60], pageDelayMs: 0, cache: true } };
  const a = makeEnv({ consent: 'accepted', clock, loadDeriv: f.loader, settings });
  const res = await a.runner.loadHistory({ assets: ['R_100'], tfs: [60] });
  assert.equal(res.state, 'done', JSON.stringify(res.items));
  assert.equal(res.items[0].have, 3500);
  assert.ok(f.requests.length >= 1);
  for (const r of f.requests) {
    assert.equal(r.ticks_history, 'R_100');
    assert.equal(r.style, 'candles');
    assert.equal('authorize' in r, false, 'no token is sent for public candles');
  }
  assert.ok(a.idb.sizes().candles >= 1, 'cached on this device because storage was accepted');
  assert.equal(a.runner.snapshot().history.held[0].bars, 3500);

  const d = makeEnv({ consent: 'declined', clock, loadDeriv: f.loader, settings });
  const res2 = await d.runner.loadHistory({ assets: ['R_100'], tfs: [60] });
  assert.equal(res2.state, 'done');
  assert.equal(d.idb.sizes().candles, 0, 'refused cookies: nothing cached');
  await a.runner.dispose();
  await d.runner.dispose();
});

test('history from Deriv can be cancelled and keeps what it had', async () => {
  const clock = makeClock();
  const f = fakeDeriv(clock, { bars: 4000 });
  const settings = { ...QUICK, data: { ...QUICK.data, source: 'deriv' }, hist: { ...QUICK.hist, targetBars: 3500, timeframes: [60, 300], pageDelayMs: 0 } };
  const e = makeEnv({ consent: 'declined', clock, loadDeriv: f.loader, settings });
  const p = e.runner.loadHistory({ assets: ['R_100'], tfs: [60, 300] });
  e.runner.cancelHistory();
  const res = await p;
  assert.equal(res.state, 'cancelled');
  assert.ok(res.items.every((i) => i.state === 'cancelled' || i.state === 'done'));
  await e.runner.dispose();
});

test('the default way of loading the Deriv module is lazy: nothing touches the network unless asked', async () => {
  let called = 0;
  const e = makeEnv({ consent: 'declined', loadDeriv: async () => { called += 1; throw new Error('should not be called'); }, settings: withSpeed('600') });
  await e.runner.start();
  e.clock.advance(2000);
  await e.runner.loadHistory({ assets: ['R_100'], tfs: [300] });
  assert.equal(called, 0, 'the simulator never loads the Deriv module');
  await e.runner.dispose();
});
