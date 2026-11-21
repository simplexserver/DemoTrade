// TDC: the coordinator. It turns entry proposals into cases (build or drop). It never forces a trade:
// no plan, no case. Pure: reads the board and settings only. No DOM, storage, network or clock.
import { cfgFor } from '../core/schema.js';
import { newMsg, finalizeAll, classOf, clampRank } from './common.js';

export const ENGINE = Object.freeze({ code: 'TDC', name: 'Trade decision coordinator', stage: 2, prefix: 'tdc', topics: ['cases'] });

const FAMILIES = ['levels', 'structure', 'liquidity', 'zones'];
const sideDir = (side) => (side === 'buy' ? 'up' : 'down');
const trendAgrees = (trend, side) => (side === 'buy' ? trend === 'bullish' : trend === 'bearish');

// Reads the four family booleans from a proposal's checks. Sell proposals may use the mirrored names.
export function familiesOf(checks, side) {
  const c = checks || {};
  const levels = Boolean(c.approachingSupport || c.approachingResistance || c.approaching || c.validRange);
  const zones = Boolean(side === 'sell' ? (c.premiumZone || c.fvgObOk) : (c.discountZone || c.fvgObOk));
  return { levels, structure: Boolean(c.structureOk), liquidity: Boolean(c.sweepSeen), zones };
}

// Opposing evidence on the board that explains a false family, in plain words.
function boardDisagreement(board, asset, tf, side, fam) {
  const out = [];
  if (!fam.structure) {
    const t = board.latest('structure', asset, tf, { type: 'trend' });
    const trend = t && t.measurements ? t.measurements.trend : null;
    if (trend === (side === 'buy' ? 'bearish' : 'bullish')) out.push(`structure trend is ${trend}`);
  }
  return out;
}

// A strong reversal on the other side of the plan.
function opposingStrong(board, asset, tf, side) {
  const r = board.latest('reversal', asset, tf);
  if (!r || !r.evidence || r.evidence.cls !== 'strong') return null;
  const against = side === 'buy' ? 'bearish_reversal' : 'bullish_reversal';
  return r.type === against ? r : null;
}

// heldFn(plan) -> null | 'duplicate' | 'cooldown': a setup that is already waiting, open or just closed is dropped here,
// before the ranking, so it cannot use up one of the few cases a bar may build.
export function buildCases({ plans, board, settings, nowMs, asset, tf, estimateFor, reducedNow = false, lastClose = null, heldFn = null } = {}) {
  const cfg = cfgFor('tdc', settings);
  const srd = cfgFor('srd', settings);
  const list = (Array.isArray(plans) ? plans : []).filter((p) => p && p.plan && p.asset === asset && Number(p.tf) === Number(tf)
    && p.atMs === nowMs && p.validity !== 'invalidated' && p.validity !== 'expired');
  const raw = [];
  for (const pm of list) {
    const plan = pm.plan;
    const side = plan.side;
    const m = pm.measurements || {};
    const fam = familiesOf(m.checks, side);
    const agree = FAMILIES.filter((f) => fam[f]);
    const disagree = [...(Array.isArray(m.opposing) ? m.opposing : []), ...boardDisagreement(board, asset, tf, side, fam)];
    const familySig = agree.slice().sort().join('+');
    const estimate = typeof estimateFor === 'function' ? (estimateFor({ asset, tf, side, familySig }) || null) : null;
    const edgeOk = cfg.edgeMode === 'collect' || Boolean(estimate && estimate.passes);
    const sweepSeen = Boolean(m.checks && m.checks.sweepSeen);
    const fvgObOk = Boolean(m.checks && m.checks.fvgObOk);
    const rr = Number.isFinite(m.rr) ? m.rr : plan.rr;
    const rank = clampRank(25 * agree.length + (sweepSeen ? 10 : 0) + (fvgObOk ? 10 : 0) + (rr >= 2 ? 5 : 0));
    const reasons = [];
    if (agree.length < cfg.minFamilies) reasons.push(`Only ${agree.length} of 4 families agree (${cfg.minFamilies} needed).`);
    if (!edgeOk) {
      reasons.push(estimate ? 'The measured edge does not clear break-even after costs.' : 'There is no measured edge yet, and strict mode needs one.');
    }
    if (rank < cfg.minEvidence) reasons.push(`Evidence ${rank} is below the minimum of ${cfg.minEvidence}.`);
    if (cfg.blockOpposingStrong && opposingStrong(board, asset, tf, side)) reasons.push('A strong reversal on the opposite side blocks this case.');
    if (Number.isFinite(lastClose) && Number.isFinite(plan.invalidation)
      && (side === 'buy' ? lastClose < plan.invalidation : lastClose > plan.invalidation)) {
      reasons.push('Price has already crossed the invalidation level.');
    }
    const held = typeof heldFn === 'function' ? heldFn(plan) : null;
    if (held === 'cooldown') reasons.push('The same setup closed a moment ago, so it is cooling down.');
    else if (held) reasons.push('The same setup is already waiting or open.');
    const build = reasons.length === 0;
    const price = Number.isFinite(plan.entry) ? plan.entry : null;
    raw.push(newMsg({
      topic: 'cases',
      type: build ? 'build' : 'drop',
      direction: sideDir(side),
      level: plan.zone ? { lo: plan.zone.lo, hi: plan.zone.hi } : null,
      price,
      atMs: nowMs,
      measurements: {
        planId: pm.id, side, families: fam, agree, agreeCount: agree.length, disagree, reasons,
        estimate: estimate ? { n: estimate.n, winRate: estimate.winRate, lo: estimate.lo, breakEven: estimate.breakEven, passes: estimate.passes } : null,
        edgeMode: cfg.edgeMode, edgeOk, sweepSeen, fvgObOk, structureOk: fam.structure, rr: Number.isFinite(rr) ? rr : null,
        stopAtr: Number.isFinite(m.stopAtr) ? m.stopAtr : (Number.isFinite(plan.stopAtr) ? plan.stopAtr : null),
        riskPrice: Number.isFinite(m.riskPrice) ? m.riskPrice : plan.riskPrice,
        zoneDepth: zoneDepthOf(m.position, side),
        reducedNow: Boolean(reducedNow),
      },
      evidence: { rank, cls: classOf(rank, srd.weakBelow, srd.strongFrom) },
      invalidation: Number.isFinite(plan.invalidation)
        ? { text: `${side === 'buy' ? 'close below' : 'close above'} ${plan.invalidation}`, price: plan.invalidation } : null,
      summary: build
        ? `Case built for a ${side} limit at ${plan.entry} on ${asset}: ${agree.join(', ')} agree.`
        : `Case dropped for a ${side} limit at ${plan.entry} on ${asset}: ${reasons.join(' ')}`,
      plan: { ...plan },
    }));
  }
  // Keep only the best few built cases on one bar, so one busy bar cannot fill every slot with near copies.
  if (Number.isFinite(cfg.maxPerBar) && cfg.maxPerBar > 0) {
    const builtIdx = raw.map((m, i) => i).filter((i) => raw[i].type === 'build');
    builtIdx.sort((a, b) => raw[b].evidence.rank - raw[a].evidence.rank
      || Math.abs((raw[a].price ?? 0) - (lastClose ?? 0)) - Math.abs((raw[b].price ?? 0) - (lastClose ?? 0)) || a - b);
    for (const i of builtIdx.slice(cfg.maxPerBar)) {
      const m = raw[i];
      const why = `Ranked below the ${cfg.maxPerBar} best cases on this bar.`;
      m.type = 'drop';
      m.measurements.reasons = [...m.measurements.reasons, why];
      m.summary = `Case dropped for a ${m.measurements.side} limit at ${m.plan.entry} on ${asset}: ${why}`;
    }
  }
  const cases = finalizeAll({ code: 'TDC', asset, tf, runMs: nowMs, inputs: null }, raw);
  return { cases, built: cases.filter((c) => c.type === 'build'), drops: cases.filter((c) => c.type === 'drop') };
}

// Buy: deeper in discount is higher; sell: higher in premium is higher. 0.5 when the position is unknown.
function zoneDepthOf(position, side) {
  if (!Number.isFinite(position)) return 0.5;
  const p = Math.max(0, Math.min(1, position));
  return side === 'buy' ? 1 - p : p;
}

// The inputs the learning features need, read from a case and the current board.
export function caseSnapshot(caseMsg, board, settings, nowMs) {
  const m = caseMsg.measurements || {};
  const side = m.side;
  const srd = cfgFor('srd', settings);
  const measure = board.query({ topic: 'measures', asset: caseMsg.asset, tf: caseMsg.tf })
    .filter((x) => x.measurements && x.measurements.planId === m.planId).pop() || null;
  const htf = board.latest('structure', caseMsg.asset, caseMsg.tf * srd.htfFactor, { type: 'trend' });
  const htfAgrees = htf && htf.measurements ? trendAgrees(htf.measurements.trend, side) : null;
  const breakoutPresent = board.query({ topic: 'breakouts', asset: caseMsg.asset, tf: caseMsg.tf, validOnly: true })
    .some((b) => b.direction === sideDir(side) && !(b.measurements && b.measurements.verdict === 'false'));
  return {
    side,
    families: FAMILIES.map((f) => Boolean(m.families && m.families[f])),
    agreeCount: m.agreeCount || 0,
    evidenceRank: caseMsg.evidence ? caseMsg.evidence.rank : 0,
    sweepSeen: Boolean(m.sweepSeen),
    fvgObOk: Boolean(m.fvgObOk),
    structureOk: Boolean(m.structureOk),
    volClass: measure && measure.measurements.volClass ? measure.measurements.volClass : null,
    atrPct: measure && Number.isFinite(measure.measurements.atrPct) ? measure.measurements.atrPct : null,
    hourUtc: new Date(nowMs).getUTCHours(),
    rr: m.rr,
    stopAtr: m.stopAtr,
    zoneDepth: Number.isFinite(m.zoneDepth) ? m.zoneDepth : 0.5,
    htfAgrees,
    breakoutPresent,
    recentStreak: 0,
  };
}
