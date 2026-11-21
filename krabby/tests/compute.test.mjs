// The compute pool: background workers for scans, with an in-page fallback, cancellation, and honest capability reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, capabilities, probeGpu } from '../js/compute/pool.js';
import { scan } from '../js/learning/scanner.js';
import { nodePoolWorkerFactory } from './helpers/node-pool-worker.mjs';
import { simCandles } from './helpers/sim.mjs';

const candles = simCandles(3500, 9, { kind: 'regimes' });
const opts = { tf: 60, costPrice: 0.02, depth: 1 };

test('inline pool: a scan gives the same answer as calling the scanner', async () => {
  const pool = createPool({ size: 0 });
  assert.deepEqual(await pool.run({ type: 'ping' }), { pong: true, inline: true });
  const a = await pool.run({ type: 'scan', candles, opts });
  const b = await scan(candles, opts);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  await assert.rejects(pool.run({ type: 'nope' }), /Unknown job type/);
  pool.terminate();
});

test('worker pool: scans run in parallel and match the in-page answer', async () => {
  const pool = createPool({ size: 2, workerFactory: nodePoolWorkerFactory });
  try {
    assert.deepEqual(await pool.run({ type: 'ping' }), { pong: true });
    const [x, y, z] = await Promise.all([
      pool.run({ type: 'scan', candles, opts }),
      pool.run({ type: 'scan', candles, opts: { ...opts, stopAtr: 1 } }),
      pool.run({ type: 'scan', candles, opts }),
    ]);
    const direct = await scan(candles, opts);
    assert.equal(JSON.stringify(x), JSON.stringify(direct));
    assert.equal(JSON.stringify(z), JSON.stringify(direct));
    assert.notEqual(JSON.stringify(y), JSON.stringify(direct));
    assert.equal(pool.size, 2);
    assert.equal(pool.stats.finished, 4);
  } finally { pool.terminate(); }
});

test('worker pool: a job that fails rejects, and the pool keeps working', async () => {
  const pool = createPool({ size: 1, workerFactory: nodePoolWorkerFactory });
  try {
    await assert.rejects(pool.run({ type: 'nope' }), /Unknown job type/);
    const r = await pool.run({ type: 'scan', candles: candles.slice(0, 100), opts });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'too_few_candles');
  } finally { pool.terminate(); }
});

test('worker pool: cancelling stops running and waiting jobs and the pool recovers', async () => {
  const pool = createPool({ size: 1, workerFactory: nodePoolWorkerFactory });
  try {
    const big = simCandles(9000, 2, { kind: 'regimes' });
    const running = pool.run({ type: 'scan', candles: big, opts: { tf: 60, costPrice: 0.02, depth: 2 } });
    const waiting = pool.run({ type: 'ping' });
    await new Promise((r) => setTimeout(r, 50));
    pool.cancelAll();
    await assert.rejects(running, (e) => e.cancelled === true);
    await assert.rejects(waiting, (e) => e.cancelled === true);
    assert.deepEqual(await pool.run({ type: 'ping' }), { pong: true });
    assert.ok(pool.stats.cancelled >= 2);
  } finally { pool.terminate(); }
});

test('worker pool: a closed pool refuses work, and a cancelled signal never starts', async () => {
  const pool = createPool({ size: 1, workerFactory: nodePoolWorkerFactory });
  await assert.rejects(pool.run({ type: 'ping' }, { signal: { aborted: true } }), (e) => e.cancelled === true);
  pool.terminate();
  await assert.rejects(pool.run({ type: 'ping' }), /closed/);
});

test('capabilities and the graphics probe are honest', async () => {
  const c8 = capabilities({ hardwareConcurrency: 8, gpu: {} });
  assert.equal(c8.cores, 8);
  assert.equal(c8.suggestedThreads, 4, 'one core is always left for the page and the cap is four');
  assert.equal(c8.webgpu, true);
  assert.equal(capabilities({ hardwareConcurrency: 1 }).suggestedThreads, 1);
  assert.equal(capabilities({}).cores, 1);
  const none = await probeGpu({});
  assert.equal(none.available, false);
  assert.equal(none.used, false);
  const some = await probeGpu({ gpu: { requestAdapter: async () => ({ info: { description: 'Test GPU' } }) } });
  assert.equal(some.available, true);
  assert.equal(some.name, 'Test GPU');
  assert.equal(some.used, false, 'it is detected but never used');
  assert.match(some.note, /not used/);
  const broken = await probeGpu({ gpu: { requestAdapter: async () => { throw new Error('x'); } } });
  assert.equal(broken.available, false);
});
