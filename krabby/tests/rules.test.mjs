// The rule book and the full loop: scan history, keep the survivors, watch for them now, trade them on paper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleBook, ruleId, pickDistinct } from '../js/learning/rules.js';
import { scan, matchingRules, signalFor, describeRule } from '../js/learning/scanner.js';
import { TradingSession } from '../js/runtime/session.js';
import { mulberry32 } from '../js/core/hash.js';

function gauss(rnd) { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
// A market where the hours 08-11 UTC drift up. A planted pattern for the whole loop.
function planted({ n, seed, tf = 300, from = '2026-01-05T00:00:00Z' }) {
  const rnd = mulberry32(seed);
  const t0 = Math.floor(Date.parse(from) / 1000);
  let price = 1000;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const epoch = t0 + i * tf;
    const h = new Date((epoch + tf) * 1000).getUTCHours();
    const o = price;
    const c = o * (1 + 0.0004 * gauss(rnd) + (h >= 8 && h < 12 ? 0.35 : 0) * 0.0004);
    out.push({ epoch, open: o, high: Math.max(o, c) + o * 0.0002 * rnd(), low: Math.min(o, c) - o * 0.0002 * rnd(), close: c });
    price = c;
  }
  return out;
}
const TF = 300;
const history = planted({ n: 30000, seed: 11 });
let scanned = null;
const scanOnce = async () => scanned || (scanned = await scan(history, { tf: TF, costPrice: 0.05, depth: 1 }));

test('ruleId is stable and order-free', () => {
  const a = { side: 'buy', conds: [{ feature: 'hour', level: 2 }, { feature: 'trend', level: 2 }], stopAtr: 1.5, rr: 2 };
  const b = { ...a, conds: [...a.conds].reverse() };
  assert.equal(ruleId('R_100', 300, a), ruleId('R_100', 300, b));
  assert.notEqual(ruleId('R_100', 300, a), ruleId('R_100', 900, a));
  assert.notEqual(ruleId('R_100', 300, a), ruleId('R_100', 300, { ...a, rr: 3 }));
});

test('the book keeps the best distinct survivors and remembers what was switched off', async () => {
  const r = await scanOnce();
  assert.ok(r.survivors.length >= 1);
  const book = new RuleBook({ nowFn: () => 1234 });
  const res = book.recordScan('R_100', TF, r);
  assert.ok(res.added >= 1);
  const list = book.list({ asset: 'R_100', tf: TF });
  assert.equal(list.length, res.added);
  assert.ok(list.every((x) => x.enabled && x.test.lo > 0));
  assert.ok(list[0].test.lo >= list[list.length - 1].test.lo, 'best first');
  const keys = list.map((x) => `${x.rule.side}|${x.rule.conds.map((c) => c.feature).sort().join(',')}`);
  assert.equal(new Set(keys).size, keys.length, 'no two rules are the same idea');
  book.setEnabled(list[0].id, false);
  book.recordScan('R_100', TF, r);
  assert.equal(book.get(list[0].id).enabled, false, 'a rule the person switched off stays off after a rescan');
  assert.equal(book.scans['R_100|300'].atMs, 1234);
  assert.equal(book.scans['R_100|300'].verdict.level, 'shown');
});

test('a failed scan is recorded and removes nothing', async () => {
  const book = new RuleBook();
  book.recordScan('R_100', TF, await scanOnce());
  const n = book.list().length;
  book.recordScan('R_100', TF, { ok: false, code: 'too_few_candles', error: 'too short' });
  assert.equal(book.list().length, n);
  assert.equal(book.scans['R_100|300'].error, 'too short');
});

test('the radar shows a rule only when its condition holds on the newest candle', async () => {
  const book = new RuleBook();
  book.recordScan('R_100', TF, await scanOnce());
  const hourRule = book.list().find((x) => x.rule.conds.length === 1 && x.rule.conds[0].feature === 'hour' && x.rule.conds[0].level === 2);
  assert.ok(hourRule, 'the planted hour rule is in the book');
  const hourOf = (c) => new Date((c.epoch + TF) * 1000).getUTCHours();
  const inside = history.slice(0, 20000).findLastIndex((c) => hourOf(c) === 9);
  const outside = history.slice(0, 20000).findLastIndex((c) => hourOf(c) === 15);
  const on = book.radar('R_100', TF, history.slice(0, inside + 1));
  const off = book.radar('R_100', TF, history.slice(0, outside + 1));
  assert.ok(on.some((x) => x.id === hourRule.id));
  assert.ok(!off.some((x) => x.id === hourRule.id));
  assert.deepEqual(book.radar('R_100', 60, history.slice(0, inside + 1)), [], 'another timeframe has no rules');
  assert.deepEqual(book.radar('R_100', TF, history.slice(0, 100)), [], 'too little history gives nothing');
});

test('signalFor builds a valid limit order from a rule', () => {
  const rule = { side: 'sell', conds: [{ feature: 'hour', level: 0 }], stopAtr: 1.5, rr: 2 };
  const s = signalFor(rule, { close: 100, atr: 1 });
  assert.equal(s.side, 'sell');
  assert.equal(s.entry, 100);
  assert.equal(s.stop, 101.5);
  assert.equal(s.target, 97);
  assert.equal(signalFor(rule, { close: 100, atr: 0 }), null);
  assert.match(s.reason, /^Sell when/);
});

test('paper signals: only enabled rules with a positive test lower bound, at most maxRules', async () => {
  const book = new RuleBook();
  book.recordScan('R_100', TF, await scanOnce());
  const hourOf = (c) => new Date((c.epoch + TF) * 1000).getUTCHours();
  const i = history.slice(0, 20000).findLastIndex((c) => hourOf(c) === 9);
  const win = history.slice(0, i + 1);
  const all = book.paperSignals('R_100', TF, win, { maxRules: 5 });
  assert.ok(all.length >= 1);
  assert.ok(all.every((g) => g.signals.length === 1 && g.signals[0].stop !== g.signals[0].target));
  for (const r of book.list()) book.setEnabled(r.id, false);
  assert.deepEqual(book.paperSignals('R_100', TF, win), []);
  for (const r of book.list()) book.setEnabled(r.id, true);
  assert.ok(book.paperSignals('R_100', TF, win, { maxRules: 1 }).length <= 1);
});

test('save and load: a round trip keeps the rules and the scan notes', async () => {
  const a = new RuleBook();
  a.recordScan('R_100', TF, await scanOnce());
  const blob = JSON.parse(JSON.stringify(a.exportState()));
  const b = new RuleBook();
  assert.equal(b.importState(blob), true);
  assert.equal(JSON.stringify(b.list()), JSON.stringify(a.list()));
  assert.equal(b.importState({ version: 9 }), false);
  assert.equal(b.importState(null), false);
});

test('forward results count only trades whose strategy is the rule, and never history', () => {
  const book = new RuleBook();
  book.rules.set('R:a', { id: 'R:a', asset: 'R_100', tf: 300, rule: { side: 'buy', conds: [{ feature: 'hour', level: 2 }] }, text: 'Buy when hour of day (UTC) is 08-11', test: { lo: 0.1 }, enabled: true, forward: { n: 0, sumR: 0 } });
  book.noteForward([
    { strategy: 'Buy when hour of day (UTC) is 08-11', rMultiple: 2 },
    { strategy: 'Buy when hour of day (UTC) is 08-11', rMultiple: -1 },
    { strategy: 'engines', rMultiple: 5 },
    { strategy: 'something else', rMultiple: 5 },
  ]);
  assert.deepEqual(book.get('R:a').forward, { n: 2, sumR: 1 });
});

test('the whole loop: discover on history, then paper-trade the rule on a market it has never seen', async () => {
  const book = new RuleBook();
  book.recordScan('R_100', TF, await scanOnce());
  // A different market with the same pattern, later in time. The rule must earn there too, with real costs.
  const fresh = planted({ n: 6000, seed: 777, from: '2026-06-01T00:00:00Z' });
  const s = new TradingSession({
    settings: { data: { assets: ['R_100'], timeframes: [TF] }, engine: { tradeAssets: ['R_100'], tradeTimeframes: [TF] }, risk: {}, cost: { spreadPrice: 0.02 } },
    learning: false, analysis: false, audit: null,
  });
  let candles = [];
  let placed = 0;
  for (const c of fresh) {
    candles.push(c);
    if (candles.length > 700) candles = candles.slice(-700);
    const extra = book.paperSignals('R_100', TF, candles, { maxRules: 2 });
    const r = s.ingest({ asset: 'R_100', tf: TF, candle: c, extra });
    placed += r.placed.length;
  }
  const trades = s.trader.trades();
  assert.ok(placed > 20, `${placed} orders placed`);
  assert.ok(trades.length > 20, `${trades.length} trades`);
  assert.ok(trades.every((t) => t.engine === 'SB' && /^(Buy|Sell) when /.test(t.strategy)));
  const net = trades.reduce((a, t) => a + t.netUsd, 0);
  const meanR = trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length;
  assert.ok(meanR > 0 && net > 0, `mean R ${meanR.toFixed(3)}, net ${net.toFixed(2)}`);
});

test('the same loop on a market with no pattern finds nothing to trade', async () => {
  const rnd = mulberry32(5);
  let price = 1000;
  const flat = [];
  const t0 = Math.floor(Date.parse('2026-01-05T00:00:00Z') / 1000);
  for (let i = 0; i < 30000; i += 1) {
    const o = price;
    const c = o * (1 + 0.0004 * gauss(rnd));
    flat.push({ epoch: t0 + i * TF, open: o, high: Math.max(o, c) + o * 0.0002 * rnd(), low: Math.min(o, c) - o * 0.0002 * rnd(), close: c });
    price = c;
  }
  const r = await scan(flat, { tf: TF, costPrice: 0.05, depth: 1 });
  assert.equal(r.survivors.length, 0);
  const book = new RuleBook();
  book.recordScan('R_100', TF, r);
  assert.equal(book.list().length, 0);
  assert.deepEqual(book.paperSignals('R_100', TF, flat.slice(-600)), []);
});
