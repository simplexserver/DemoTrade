// One bar of decisions: from entry proposals (or strategy signals) to cases, risk verdicts and paper orders.
// TDC builds the cases, RME vetoes or approves each one, and only an approved case becomes a paper order (DEE).
// The learning loop's approved model can hold a case back and can never let one through that RME refused.
// Pure apart from the objects it is given: no DOM, storage, network or clock.
import { cfgFor } from '../core/schema.js';
import { fmtMoney } from '../core/util.js';
import { buildCases, caseSnapshot } from '../engine/coordinator.js';
import { evaluateCase } from '../engine/risk.js';
import { familySigOf } from '../learning/loop.js';

// Reasons that are about the account or the data, not about the setup. When one of these is present the account could not
// have traded anyway, so the whole bar is one "not trading" entry instead of one refusal per setup.
export const ACCOUNT_CODES = new Set(['daily_loss_stop', 'drawdown_stop', 'emergency_stop', 'max_open', 'max_pending', 'data_unreliable', 'news_window']);

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// A strategy signal as a case. Strategy plans carry no evidence score, so their rank is 0 and they are never claimed to
// have one. The case id is stable for the same bar and the same signal.
export function strategyCase(sig, { asset, tf, nowMs, atr, index, name }) {
  const risk = Math.abs(sig.entry - sig.stop);
  const rr = Math.abs(sig.target - sig.entry) / risk;
  const id = `SB:${asset}:${tf}:${nowMs}:${index}`;
  const stopAtr = atr > 0 ? risk / atr : null;
  const direction = sig.side === 'buy' ? 'up' : 'down';
  return {
    id,
    engine: 'SB',
    asset,
    tf: Number(tf),
    topic: 'cases',
    type: 'build',
    direction,
    price: sig.entry,
    atMs: nowMs,
    runMs: nowMs,
    validity: 'valid',
    evidence: { rank: 0, cls: 'none' },
    summary: `Strategy ${name || ''} signal: ${sig.side} limit at ${sig.entry} on ${asset}${sig.reason ? `. ${sig.reason}` : ''}`.replace('  ', ' '),
    measurements: {
      planId: id, side: sig.side, families: { levels: false, structure: false, liquidity: false, zones: false }, agree: [], agreeCount: 0,
      rr, stopAtr, riskPrice: risk, source: 'strategy', strategy: name || null, reason: sig.reason || '',
    },
    plan: {
      side: sig.side, entry: sig.entry, stop: sig.stop, target: sig.target, invalidation: sig.stop, zone: null, riskPrice: risk,
      objectiveR: rr, rr, stopAtr, orderType: 'limit', expiryBars: sig.expiryBars,
    },
  };
}

// args: { asset, tf, nowMs, settings, board, trader, learning, plans, signals, strategyName, market, lastClose, reducedNow,
//         tradable, audit, memo }
// memo: a Map the caller keeps between bars. The same setup refused for the same reasons on the next bar is one refusal,
// not one per bar, so the counts mean something and the learning loop gets one row for it, not a run of copies.
// plans: entry proposal messages (engines). signals: strategy signals for this bar (backtests), or undefined.
// market: { health, atr, spreadPrice }.
// Returns { cases, built, verdicts, placed, skipped }. cases are the TDC messages to publish (empty for strategies).
export function decideBar(args) {
  const { asset, tf, nowMs, settings, board, trader, learning, plans, signals, strategyName, market, lastClose, reducedNow, tradable, audit, memo } = args;
  const out = { cases: [], built: [], verdicts: [], placed: [], skipped: { duplicate: 0, cooldown: 0, repeat: 0 }, halts: [] };
  const halted = new Map();
  const fromStrategy = Array.isArray(signals);
  let built;
  if (fromStrategy) {
    built = signals.map((sig, i) => strategyCase(sig, { asset, tf, nowMs, atr: market.atr, index: i, name: strategyName }));
  } else {
    const r = buildCases({
      plans, board, settings, nowMs, asset, tf, reducedNow, lastClose,
      estimateFor: learning ? (q) => learning.estimateFor(q) : undefined,
      heldFn: (plan) => trader.setupStatus(plan, asset, tf, market.atr, nowMs),
    });
    out.cases = r.cases;
    built = r.built.slice().sort((a, b) => b.evidence.rank - a.evidence.rank || (a.id < b.id ? -1 : 1));
  }
  out.built = built;
  if (!tradable) return out;

  for (const c of built) {
    const side = c.measurements.side;
    const snap = fromStrategy ? null : caseSnapshot(c, board, settings, nowMs);
    const verdict = evaluateCase({
      caseMsg: c, settings, account: trader.accountFor(nowMs), market, reducedNow, evidenceRank: c.evidence.rank, nowMs,
    });
    const reasons = verdict.reasons.map((r) => ({ ...r }));
    const codes0 = reasons.map((r) => r.code);
    // The same proposal returns on many bars. A setup that is already held is not a refusal worth recording.
    if (!verdict.ok && (codes0.includes('duplicate') || codes0.includes('cooldown'))) {
      out.skipped[codes0.includes('duplicate') ? 'duplicate' : 'cooldown'] += 1;
      continue;
    }
    if (!verdict.ok && reasons.some((r) => ACCOUNT_CODES.has(r.code))) {
      for (const r of reasons) if (ACCOUNT_CODES.has(r.code) && !halted.has(r.code)) halted.set(r.code, r.text);
      continue;
    }
    let ok = verdict.ok;
    const notes = [...(verdict.notes || [])];

    if (ok && learning && snap) {
      const f = learning.modelFilter(snap);
      if (f.active && f.p === null && f.note) notes.push('model_could_not_score');
      if (f.active && f.pass === false) {
        ok = false;
        reasons.push({ code: 'model_below_threshold', text: `The approved model scores this case ${pct(f.p)} and the threshold is ${pct(f.threshold)}, so it is not taken.` });
      }
    }

    if (!ok && memo) {
      const bucket = Math.round(c.plan.entry / (0.25 * (market.atr > 0 ? market.atr : Math.abs(c.plan.entry) * 0.002)));
      const key = `${asset}|${tf}|${side}|${bucket}`;
      const sig = reasons.map((r) => r.code).join(',');
      const prev = memo.get(key);
      memo.set(key, { sig, atMs: nowMs });
      if (memo.size > 3000) for (const [k, v] of memo) if (nowMs - v.atMs > Number(tf) * 1000 * 50) memo.delete(k);
      if (prev && prev.sig === sig && nowMs - prev.atMs <= Number(tf) * 1000 * 2) {
        out.skipped.repeat += 1;
        continue;
      }
    }

    let pending = null;
    if (ok) {
      const plan = c.plan;
      const ex = fromStrategy ? plan.expiryBars : null;
      const side0 = side === 'buy' ? 'ble' : 'sle';
      const order = {
        caseId: c.id,
        planId: c.measurements.planId,
        asset,
        tf,
        side,
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        invalidation: plan.invalidation,
        zone: plan.zone,
        riskUsd: verdict.riskUsd,
        stake: verdict.stake,
        multiplier: verdict.multiplier,
        objectiveR: isNum(plan.objectiveR) ? plan.objectiveR : undefined,
        expiryBars: isNum(ex) ? ex : cfgFor(side0, settings).expiryBars,
        features: snap,
        familySig: snap ? familySigOf(snap) : '',
        volClass: snap ? snap.volClass : null,
        strategy: fromStrategy ? (strategyName || 'strategy') : 'engines',
        engine: fromStrategy ? 'SB' : undefined,
      };
      try {
        pending = trader.place(verdict.approval, order, nowMs);
      } catch (e) {
        ok = false;
        reasons.push({ code: String((e && e.code) || 'place_failed').toLowerCase(), text: String((e && e.message) || e) });
      }
    }

    if (learning && snap) {
      learning.recordCase(snap, { caseId: c.id, asset, tf, side, nowMs, plan: c.plan, placed: ok });
    }

    const rec = {
      id: `V:${c.id}`,
      caseId: c.id,
      asset,
      tf: Number(tf),
      side,
      ok,
      reasons: reasons.map((r) => r.text),
      codes: reasons.map((r) => r.code),
      stake: verdict.stake,
      riskUsd: verdict.riskUsd,
      atMs: nowMs,
      source: fromStrategy ? 'strategy' : 'engines',
      notes,
      summary: ok
        ? `Approved: ${side} limit at ${c.plan.entry} on ${asset}, stake ${fmtMoney(verdict.stake, 'USD', 4)}, risking ${fmtMoney(verdict.riskUsd, 'USD', 4)}.`
        : `Refused: ${reasons[0] ? reasons[0].text : 'no reason given'}`,
    };
    out.verdicts.push(rec);
    if (pending) out.placed.push(pending);
    try {
      if (audit) audit.append('verdict', { caseId: c.id, ok, codes: rec.codes, stake: verdict.stake }, nowMs);
    } catch (_) { /* the audit log must never stop a decision */ }
  }
  const haltKey = `halt|${asset}|${tf}`;
  if (halted.size) {
    out.halts = [...halted.keys()];
    const sig = out.halts.join(',');
    const prev = memo ? memo.get(haltKey) : null;
    // One entry when a halt starts or its reason changes, and a reminder if it lasts very long. Not one per bar.
    const fresh = !(prev && prev.sig === sig && nowMs - prev.loggedMs < Number(tf) * 1000 * 60);
    if (memo && fresh) memo.set(haltKey, { sig, loggedMs: nowMs });
    if (fresh) {
      const first = [...halted.values()][0];
      out.verdicts.push({
        id: `V:halt:${asset}:${tf}:${nowMs}`, caseId: `halt:${asset}:${tf}:${nowMs}`, asset, tf: Number(tf), side: null, ok: false,
        reasons: [...halted.values()], codes: out.halts.slice(), stake: 0, riskUsd: 0, atMs: nowMs, source: 'account', notes: [],
        summary: `Not trading: ${first}`,
      });
    }
  } else if (memo && built.length > 0) {
    memo.delete(haltKey); // setups were looked at and the halt is over
  }
  return out;
}
