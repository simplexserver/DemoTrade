// Builds the plain object every screen draws from. Read-only: it never changes the session. JSON-safe.
import { cfgFor } from '../core/schema.js';
import { dailyState } from '../trading/daily.js';
import { ENGINE_REGISTRY } from '../engine/registry.js';
import { tfSeconds } from '../market/mde.js';

const slim = (m) => ({
  id: m.id, engine: m.engine, asset: m.asset, tf: m.tf, topic: m.topic, type: m.type, direction: m.direction, price: m.price, level: m.level,
  atMs: m.atMs, validity: m.validity, summary: m.summary, evidence: m.evidence, plan: m.plan,
});

const sortedCounts = (obj) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => ({ code, count }));

function engineRows(s, t) {
  const ls = s.learning ? s.learning.status() : null;
  const ts = s.trader.state(s.nowMs);
  const daily = ts.account;
  const dpt = cfgFor('dpt', s.settings);
  const day = dailyState({ realizedTodayUsd: daily.realizedTodayUsd, floatingUsd: daily.floatingUsd, targetUsd: dpt.targetUsd, includeFloating: dpt.includeFloating, reducedOnTarget: dpt.reducedOnTarget });
  const dyn = {
    MDE: { runs: s.stats.counts.candles, lastRunMs: s.lastCloseMs || null, messages: 0, note: `${t.health.filter((h) => h.ok).length} of ${t.health.length} markets healthy` },
    DEE: { runs: ts.counters.placed, lastRunMs: s.lastCloseMs || null, messages: ts.counters.filled, note: `${ts.counters.placed} placed, ${ts.counters.filled} filled, ${ts.counters.cancelled} cancelled` },
    TDC: { runs: s.stats.counts.runs, lastRunMs: s.lastCloseMs || null, messages: s.stats.counts.cases, note: `${s.stats.counts.built} built, ${s.stats.counts.dropped} dropped` },
    RME: { runs: s.verdicts.length, lastRunMs: s.verdicts.length ? s.verdicts[s.verdicts.length - 1].atMs : null, messages: s.stats.counts.refused, note: `${s.stats.counts.approved} approved, ${s.stats.counts.refused} refused` },
    DPM: { runs: ts.positions.length, lastRunMs: null, messages: ts.positions.filter((p) => p.trailingArmed).length, note: `${ts.positions.length} open, ${ts.positions.filter((p) => p.trailingArmed).length} trailing` },
    DPT: { runs: 0, lastRunMs: null, messages: 0, note: day.reason },
    PM: { runs: ts.account.closedCount, lastRunMs: null, messages: 0, note: `${ts.account.closedCount} closed paper trades` },
    DT: { runs: s.verdicts.length, lastRunMs: s.verdicts.length ? s.verdicts[s.verdicts.length - 1].atMs : null, messages: s.caseLog.length, note: 'Every case and verdict is kept in the log.' },
    LL: ls
      ? { runs: ls.closed, lastRunMs: ls.lastAtMs, messages: 0, note: ls.enabled ? `${ls.closed} of ${ls.needed} closed trades${ls.modelActive ? ', model active' : ''}` : 'Switched off in Settings.', off: !ls.enabled }
      : { runs: 0, lastRunMs: null, messages: 0, note: 'No learning loop in this session.', off: true },
    SB: { runs: 0, lastRunMs: null, messages: 0, note: 'Used by the Strategy lab.' },
    BT: { runs: 0, lastRunMs: null, messages: 0, note: 'Used by the Strategy lab.' },
  };
  return ENGINE_REGISTRY.map((e) => {
    const st = s.stats.engines[e.code];
    const d = dyn[e.code];
    let status = e.status;
    let note = e.role;
    let runs = 0;
    let lastRunMs = null;
    let messages = 0;
    if (st) {
      runs = st.runs;
      lastRunMs = st.lastRunMs;
      messages = st.lastMessages;
      if (st.errors > 0) {
        status = 'partial';
        note = `${st.errors} error(s). Last: ${st.lastError}`;
      }
    } else if (d) {
      runs = d.runs;
      lastRunMs = d.lastRunMs;
      messages = d.messages;
      note = d.note;
      if (d.off) status = 'off';
    }
    return { number: e.number, code: e.code, name: e.name, role: e.role, status, runs, lastRunMs, messages, note };
  });
}

export function buildState(s, { maxMessages = 300, maxVerdicts = 100, maxCases = 100 } = {}) {
  const data = cfgFor('data', s.settings);
  const ts = s.trader.state(s.nowMs);
  const dpt = cfgFor('dpt', s.settings);
  const wall = s.clockNow();
  const health = [];
  for (const asset of data.assets) {
    for (const tf of data.timeframes) {
      const tfSec = tfSeconds(tf);
      const h = s.mde.health(asset, tfSec, wall, data);
      const st = s.mde.stats(asset, tfSec);
      health.push({ asset, tf: tfSec, status: h.status, ok: h.ok, reason: h.reason, lastCloseMs: h.lastCloseMs, ageMs: h.ageMs, gaps: h.gaps, count: st.count, source: st.source });
    }
  }
  const day = dailyState({ realizedTodayUsd: ts.account.realizedTodayUsd, floatingUsd: ts.account.floatingUsd, targetUsd: dpt.targetUsd, includeFloating: dpt.includeFloating, reducedOnTarget: dpt.reducedOnTarget });
  const current = s.board.query({ current: true });
  const messages = current.slice(-Math.max(1, maxMessages)).reverse().map(slim);
  const ll = s.learning ? s.learning.snapshot() : null;
  return {
    nowMs: s.nowMs,
    lastCloseMs: s.lastCloseMs,
    running: s.running,
    mode: 'paper',
    emergencyStop: ts.emergencyStop,
    account: { ...ts.account, daily: day },
    health,
    engines: engineRows(s, { health }),
    messages,
    cases: s.caseLog.slice(-Math.max(1, maxCases)).reverse().map(slim),
    drops: s.dropLog.slice(-50).reverse().map(slim),
    verdicts: s.verdicts.slice(-Math.max(1, maxVerdicts)).reverse(),
    pendings: ts.pendings,
    positions: ts.positions,
    closed: ts.closed,
    cancelled: ts.cancelled,
    counters: ts.counters,
    learning: ll,
    stats: { counts: { ...s.stats.counts }, refusals: sortedCounts(s.stats.refusals), haltBars: sortedCounts(s.stats.haltBars), skipped: { ...s.stats.skipped } },
    audit: s.audit ? { size: s.audit.size(), recent: s.audit.list({ limit: 200 }).reverse() } : { size: 0, recent: [] },
    board: s.board.stats(),
    errors: s.errors.slice().reverse(),
  };
}
