// The approval gate. Nothing the learning loop proposes reaches the settings unless every check here passes AND a person
// types the approval phrase for that proposal. Pure: no DOM, storage, network or clock.
import { wilson } from '../core/util.js';
import { LEARNABLE_KEYS, isLocked } from '../core/schema.js';
import { breakEvenRate } from './eval.js';

// D13: never fewer than 100 closed paper trades, whatever the setting says.
export const MIN_CLOSED_FLOOR = 100;
// A part of a proposal needs at least this many out-of-sample trades that it would have taken.
export const MIN_TAKEN = 10;

export const approvalPhrase = (id) => `APPROVE ${id}`;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const num = (x, d = 2) => (isNum(x) ? String(Math.round(x * 10 ** d) / 10 ** d) : 'n/a');

function fail(code, text) {
  const e = new Error(text);
  e.code = code;
  return e;
}

// records: the real, closed, labelled paper trades ({ y, rMultiple, netUsd, rr }). proposal: from the loop.
// cfg: the 'll' group. roleOk: whether the engine role may learn.
export function gateChecks({ records, proposal, cfg, roleOk }) {
  const checks = [];
  const add = (id, label, ok, text) => checks.push({ id, label, ok: Boolean(ok), text });
  const n = records.length;
  const need = Math.max(MIN_CLOSED_FLOOR, Math.floor(Number(cfg.minClosed) || MIN_CLOSED_FLOOR));
  add('closed_trades', `At least ${need} closed paper trades`, n >= need, `${n} closed paper trades so far, ${need} needed.`);

  const wins = records.filter((r) => r.y).length;
  const z = Number(cfg.z) || 1.96;
  const w = wilson(wins, n, z);
  let be = null;
  if (cfg.breakEven === 'payout') {
    const rrs = records.map((r) => r.rr).filter((x) => isNum(x) && x > 0);
    be = rrs.length ? 1 / (1 + rrs.reduce((a, b) => a + b, 0) / rrs.length) : null;
  } else {
    be = breakEvenRate(records.map((r) => ({ y: r.y, r: isNum(r.rMultiple) ? r.rMultiple : r.netUsd })));
  }
  add(
    'wilson_above_breakeven',
    'Win rate lower bound above break-even after costs',
    n > 0 && be !== null && w.lo > be,
    n === 0 ? 'No closed trades yet.' : be === null
      ? 'Break-even cannot be measured yet: it needs at least one win and one loss.'
      : `Win rate ${pct(w.p)}, lower bound ${pct(w.lo)} (z ${num(z, 2)}), break-even ${pct(be)}.`,
  );

  const oos = proposal && proposal.metrics ? proposal.metrics.oos : null;
  const parts = [];
  if (oos && proposal.model && oos.model) parts.push(['model', oos.model]);
  if (oos && proposal.filters && proposal.filters.length && oos.filters) parts.push(['filters', oos.filters]);
  const base = oos ? oos.baseline : null;
  const oosFails = [];
  for (const [name, m] of parts) {
    if (!(m.n >= cfg.minOosTrades)) oosFails.push(`${name}: only ${m.n} out-of-sample trades (need ${cfg.minOosTrades})`);
    else if (!(m.taken >= MIN_TAKEN)) oosFails.push(`${name}: it would have taken only ${m.taken} of them (need ${MIN_TAKEN})`);
    else if (!(isNum(m.expectancyR) && m.expectancyR > 0)) oosFails.push(`${name}: average result ${num(m.expectancyR)} R is not above zero`);
    else if (!(base && isNum(base.expectancyR) && m.expectancyR >= base.expectancyR)) oosFails.push(`${name}: no better than taking every trade (${num(m.expectancyR)} R against ${num(base && base.expectancyR)} R)`);
  }
  if (!cfg.requireOos) add('oos_pass', 'Out-of-sample test passes', true, 'The out-of-sample requirement is switched off in the settings.');
  else if (!parts.length) add('oos_pass', 'Out-of-sample test passes', false, 'Nothing in this proposal was tested out of sample.');
  else {
    add(
      'oos_pass',
      'Out-of-sample test passes',
      oosFails.length === 0,
      oosFails.length ? oosFails.join('; ') : parts.map(([name, m]) => `${name}: ${m.taken} of ${m.n} out-of-sample trades taken, average ${num(m.expectancyR)} R against ${num(base.expectancyR)} R for all`).join('; '),
    );
  }

  if (!proposal || !proposal.model) add('brier_beats_base', 'Model beats the base rate (Brier score)', true, 'No model in this proposal.');
  else if (!cfg.requireBrier) add('brier_beats_base', 'Model beats the base rate (Brier score)', true, 'The Brier requirement is switched off in the settings.');
  else {
    const mb = oos && isNum(oos.modelBrier) ? oos.modelBrier : null;
    const bb = oos && isNum(oos.baseBrier) ? oos.baseBrier : null;
    add('brier_beats_base', 'Model beats the base rate (Brier score)', mb !== null && bb !== null && mb < bb,
      mb === null || bb === null ? 'The Brier scores could not be measured.' : `Model ${num(mb, 4)} against the base rate ${num(bb, 4)} (lower is better).`);
  }

  add('role', 'The engine role may learn', roleOk === true, roleOk === true ? 'The engine role allows learning.' : 'The engine role does not allow learning. Change it in Settings, then try again.');

  const keys = proposal && proposal.changes ? Object.keys(proposal.changes) : [];
  const bad = keys.filter((k) => !LEARNABLE_KEYS.includes(k) || isLocked(k));
  add('learnable_only', 'Only settings the loop may change', bad.length === 0, bad.length ? `Not allowed: ${bad.join(', ')}.` : `${keys.length} setting${keys.length === 1 ? '' : 's'}, all allowed.`);
  add('has_changes', 'The proposal changes something', keys.length > 0, keys.length ? 'There is something to approve.' : 'Empty proposal.');

  return { ok: checks.every((c) => c.ok), checks };
}

// Checks the typed phrase and the gate. Returns a frozen record of the approval, or throws with a code.
export function approve(proposal, phraseTyped, actor, nowMs, gate) {
  if (!proposal || proposal.status !== 'proposed') throw fail('NOT_OPEN', 'Only a proposal that is still open can be approved.');
  if (typeof actor !== 'string' || !actor) throw fail('NO_ACTOR', 'Approval needs to say who approved it.');
  if (typeof phraseTyped !== 'string' || phraseTyped.trim() !== approvalPhrase(proposal.id)) throw fail('BAD_PHRASE', `Type exactly: ${approvalPhrase(proposal.id)}`);
  if (!gate || gate.ok !== true) {
    const failing = gate && Array.isArray(gate.checks) ? gate.checks.filter((c) => !c.ok).map((c) => c.label).join('; ') : 'the gate was not run';
    throw fail('GATE_FAILED', `The approval gate has not passed: ${failing}.`);
  }
  return Object.freeze({ proposalId: proposal.id, actor, atMs: nowMs, phrase: phraseTyped.trim(), changes: Object.freeze({ ...proposal.changes }), withModel: Boolean(proposal.model) });
}
