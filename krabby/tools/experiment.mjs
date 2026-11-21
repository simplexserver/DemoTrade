// Profit experiment: runs the engines and strategies over many simulated markets and reports what happened, honestly.
//   node tools/experiment.mjs --kinds regimes,random_walk --seeds 8 --bars 4000 --strategies 1 --engines 0 --out result.json
// Two kinds of market are always worth running side by side:
//   regimes      - built WITH structure (trends, ranges, sweeps). A strategy that cannot make money here has no edge to find.
//   random_walk  - built with NO structure. A strategy that "makes money" here is fooling itself. The share of seeds where the
//                  verdict says "edge shown" is the false-alarm rate; it should be about 5% or lower.
// Nothing here touches the network. Results are about simulated markets only; they say nothing about a real market.
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runBacktest, rStats, CLUSTER_BARS } from '../js/backtest/run.js';
import { simCandles } from '../tests/helpers/sim.mjs';
import { nodeWorkerFactory } from '../tests/helpers/node-worker.mjs';
import { EXAMPLES } from '../js/strategies/examples.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? acc.concat([[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']]) : acc), []));
const kinds = String(args.kinds || 'regimes,random_walk').split(',');
const seeds = Number(args.seeds || 8);
const bars = Number(args.bars || 4000);
const withStrategies = args.strategies !== '0';
const withEngines = args.engines === '1';
const spreadMult = Number(args.spreadMult || 1);
const jobsWanted = Number(args.jobs || 2);

const settingsOf = () => ({ data: { timeframes: [60, 300, 900] }, cost: { spreadPrice: 0.02 * spreadMult } });

async function runJob(job) {
  const candles = simCandles(bars, job.seed, { kind: job.kind });
  const base = { asset: 'R_100', tf: 60, candles, settings: settingsOf(), limits: 'relaxed', oosFraction: 0.3, workerFactory: nodeWorkerFactory };
  const r = job.config === 'engines'
    ? await runBacktest(base)
    : await runBacktest({ ...base, source: EXAMPLES[job.config].code, strategyName: EXAMPLES[job.config].name, params: EXAMPLES[job.config].params });
  if (!r.ok) return { ...job, ok: false, error: r.error };
  return {
    ...job, ok: true,
    n: r.summary.all.r.n, meanR: r.summary.all.r.mean, loR: r.summary.all.r.lo, hiR: r.summary.all.r.hi, sdR: r.summary.all.r.sd,
    nOos: r.summary.oos.r.n, meanOos: r.summary.oos.r.mean, loOos: r.summary.oos.r.lo,
    level: r.verdict.all.level, levelOos: r.verdict.oos.level,
    netUsd: r.costs.netUsd, costUsd: r.costs.totalUsd, grossUsd: r.costs.grossUsd,
    tr: r.trades.filter((t) => t.segment !== 'warmup').map((t) => [t.entryMs, t.rMultiple]),
    ms: r.ms,
  };
}

if (process.send) {
  process.on('message', async (job) => {
    try { process.send({ result: await runJob(job) }); } catch (e) { process.send({ result: { ...job, ok: false, error: String(e && e.message || e) } }); }
  });
} else {
  const jobs = [];
  for (const kind of kinds) {
    for (let seed = 1; seed <= seeds; seed += 1) {
      if (withStrategies) for (let c = 0; c < EXAMPLES.length; c += 1) jobs.push({ kind, seed: seed * 7919, config: c });
      if (withEngines) jobs.push({ kind, seed: seed * 7919, config: 'engines' });
    }
  }
  const results = [];
  const queue = jobs.slice();
  const t0 = Date.now();
  await new Promise((resolve) => {
    let active = 0;
    const pump = () => {
      if (!queue.length && active === 0) { resolve(); return; }
      while (active < jobsWanted && queue.length) {
        const job = queue.shift();
        active += 1;
        const child = fork(new URL(import.meta.url).pathname, process.argv.slice(2));
        child.on('message', (m) => { results.push(m.result); child.kill(); });
        child.on('exit', () => { active -= 1; process.stderr.write(`\r${results.length}/${jobs.length} done, ${Math.round((Date.now() - t0) / 1000)} s   `); pump(); });
        child.send(job);
      }
    };
    pump();
  });
  process.stderr.write('\n');

  const names = (c) => (c === 'engines' ? 'Engines (default settings)' : EXAMPLES[c].name);
  const lines = [];
  const summary = [];
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const f = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d));
  lines.push(`bars per run: ${bars}, runs per cell: ${seeds}, spread x${spreadMult}, account stops relaxed, costs on`);
  lines.push('');
  lines.push('market | config | trades | pooled mean R [95% range] | seeds with mean>0 | seeds "edge shown" | net USD (sum) | costs USD (sum)');
  lines.push('--- | --- | --- | --- | --- | --- | --- | ---');
  for (const kind of kinds) {
    for (const config of [...(withStrategies ? EXAMPLES.map((_, i) => i) : []), ...(withEngines ? ['engines'] : [])]) {
      const rs = results.filter((r) => r.kind === kind && r.config === config);
      const ok = rs.filter((r) => r.ok);
      // Cluster-robust pooled average: each seed is its own market, and trades opened close together share a cluster.
      const pseudo = ok.flatMap((r, si) => r.tr.map(([entryMs, rMultiple]) => ({ entryMs: entryMs + si * 1e13, rMultiple })));
      const st = rStats(pseudo, 1.96, { clusterMs: CLUSTER_BARS * 60 * 1000 });
      const n = st.n;
      const m = st.mean;
      const lo = st.lo;
      const hi = st.hi;
      const pos = ok.filter((r) => r.meanR > 0).length;
      const shown = ok.filter((r) => r.level === 'shown').length;
      const net = ok.reduce((a, r) => a + r.netUsd, 0);
      const cost = ok.reduce((a, r) => a + r.costUsd, 0);
      lines.push(`${kind} | ${names(config)} | ${n} | ${f(m)} [${f(lo)}, ${f(hi)}] | ${pos}/${ok.length} | ${shown}/${ok.length} | ${f(net, 2)} | ${f(cost, 2)}`);
      summary.push({ kind, config: names(config), n, meanR: m, loR: lo, hiR: hi, seedsPositive: pos, seedsShown: shown, runs: ok.length, failed: rs.length - ok.length, netUsd: net, costUsd: cost });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) lines.push('', `FAILED RUNS: ${failed.length}. First: ${failed[0].error}`);
  console.log(lines.join('\n'));
  if (args.out) writeFileSync(args.out, JSON.stringify({ args, summary, results: results.map(({ tr, ...r }) => r) }, null, 1));
}
