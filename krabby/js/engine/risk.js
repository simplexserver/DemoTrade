// RME: the risk engine. It is the veto on money. Paper only: it issues an approval token and nothing else.
// Pure: no DOM, no storage, no network, no clock (time is passed in). When unsure, it refuses.
import { cfgFor } from '../core/schema.js';
import { issueApproval, isApproved, consumeApproval } from './approval.js';
import { fmtMoney } from '../core/util.js';

export const ENGINE = Object.freeze({ code: 'RME', name: 'Risk engine', stage: 2 });
export { isApproved, consumeApproval };

const num = (x, fallback = NaN) => {
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
};

const eventMs = (at) => (typeof at === 'number' ? at : Date.parse(at));

// Blocked when nowMs is inside [event - minutesBefore, event + minutesAfter]. Returns the nearest such event.
export function newsBlocked(nowMs, events, minutesBefore = 0, minutesAfter = 0) {
  const before = Math.max(0, num(minutesBefore, 0)) * 60000;
  const after = Math.max(0, num(minutesAfter, 0)) * 60000;
  let best = null;
  let bestGap = Infinity;
  for (const ev of Array.isArray(events) ? events : []) {
    const t = eventMs(ev && ev.at);
    if (!Number.isFinite(t)) continue;
    if (nowMs >= t - before && nowMs <= t + after) {
      const gap = Math.abs(nowMs - t);
      if (gap < bestGap) {
        best = ev;
        bestGap = gap;
      }
    }
  }
  return best ? { blocked: true, event: best } : { blocked: false, event: null };
}

// Kept under the old name too.
export const newsBlock = newsBlocked;

// Multiplier for a market: the per-market override when set and valid, else the default.
export function multiplierFor(risk, asset) {
  const over = risk && risk.multiplierOverrides && typeof risk.multiplierOverrides === 'object'
    ? num(risk.multiplierOverrides[asset]) : NaN;
  return over > 0 ? over : num(risk.multiplier);
}

// Decides one case. Every failed check adds a reason; ok only when none failed.
export function evaluateCase({ caseMsg, settings, account, market, reducedNow = false, evidenceRank, nowMs } = {}) {
  const risk = cfgFor('risk', settings);
  const acct = account || {};
  const mkt = market || {};
  const reasons = [];
  const notes = [];
  const add = (code, text) => reasons.push({ code, text });
  const caseId = caseMsg && caseMsg.id ? caseMsg.id : null;
  const plan = caseMsg && caseMsg.plan ? caseMsg.plan : null;
  const manual = Boolean(caseMsg && (caseMsg.manual === true || (caseMsg.measurements && caseMsg.measurements.manual === true)));
  const rank = Number.isFinite(evidenceRank) ? evidenceRank : num(caseMsg && caseMsg.evidence && caseMsg.evidence.rank);

  const entry = plan ? num(plan.entry) : NaN;
  const stop = plan ? num(plan.stop) : NaN;
  const stopDistance = Math.abs(entry - stop);
  const planOk = Boolean(plan) && entry > 0 && Number.isFinite(stopDistance) && stopDistance > 0
    && (plan.side === 'buy' || plan.side === 'sell');
  if (!planOk) add('invalid_plan', 'The case has no usable entry and stop, so no stake can be sized.');

  if (acct.emergencyStop) add('emergency_stop', 'The emergency stop is on. No new entries.');

  const health = mkt.health;
  if (!health || health.ok !== true) {
    add('data_unreliable', `Market data is not reliable (${health && health.reason ? health.reason : 'no health reading'}).`);
  }

  const news = newsBlocked(nowMs, risk.newsEvents, risk.newsBefore, risk.newsAfter);
  if (news.blocked) add('news_window', `A news event (${(news.event && news.event.title) || 'scheduled'}) is inside its blackout window.`);

  const dayStart = num(acct.dayStartUsable);
  const dayPnl = num(acct.realizedTodayUsd, 0) + num(acct.floatingUsd, 0);
  const dayLimit = (risk.dailyLossPct / 100) * dayStart;
  if (!(manual && risk.noLimitDailyStop) && !(dayPnl > -dayLimit)) {
    add('daily_loss_stop', `Today's result ${fmtMoney(dayPnl)} has reached the daily loss stop of -${fmtMoney(Number.isFinite(dayLimit) ? dayLimit : 0)}.`);
  }

  const balance = num(acct.balance);
  const peak = num(acct.peakBalance);
  if (!(balance > peak * (1 - risk.drawdownPct / 100))) {
    add('drawdown_stop', `Balance is ${risk.drawdownPct}% or more below its peak. New entries are halted.`);
  }

  if (!(num(acct.openCount, Infinity) < risk.maxOpen)) add('max_open', `The limit of ${risk.maxOpen} open positions is reached.`);
  if (!(num(acct.pendingCount, Infinity) < risk.maxPending)) add('max_pending', `The limit of ${risk.maxPending} pending entries is reached.`);

  let status = null;
  if (typeof acct.setupStatus === 'function' && plan) status = acct.setupStatus(plan, caseMsg.asset, caseMsg.tf, num(mkt.atr), nowMs);
  else if (typeof acct.setupStatus !== 'function') status = 'duplicate';
  if (status === 'duplicate' || (typeof acct.hasCase === 'function' && acct.hasCase(caseId))) {
    add('duplicate', 'The same setup is already waiting or open.');
  } else if (status === 'cooldown') {
    add('cooldown', `The same setup closed fewer than ${risk.cooldownBars} bars ago.`);
  } else if (status) {
    add('duplicate', 'The setup check gave an unknown answer, so the entry is refused.');
  }

  if (reducedNow) {
    if (!(num(acct.entriesThisHour, Infinity) < risk.reducedMaxPerHour)) {
      add('reduced_hourly_limit', `Reduced-risk mode allows ${risk.reducedMaxPerHour} new entries per hour.`);
    }
    if (!(rank >= risk.reducedMinEvidence)) {
      add('reduced_weak_evidence', `Reduced-risk mode needs evidence of ${risk.reducedMinEvidence} or more.`);
    }
  }

  const atr = num(mkt.atr);
  const spread = num(mkt.spreadPrice, NaN);
  if (!Number.isFinite(spread) || (spread > 0 && !(atr > 0)) || spread > risk.maxSpreadAtr * atr) {
    add('spread_too_wide', 'The spread is too wide for the current ATR, or it is unknown.');
  }

  // Sizing. Never rounds up: a stake below the minimum is refused.
  const multiplier = multiplierFor(risk, caseMsg && caseMsg.asset);
  const usable = Math.min(balance, risk.usableCapUsd);
  let riskUsd = (usable * risk.riskPct / 100) * (reducedNow ? risk.reducedFactor : 1);
  let stake = planOk && multiplier > 0 ? (riskUsd * entry) / (multiplier * stopDistance) : 0;
  if (!Number.isFinite(stake)) stake = 0;
  if (stake > risk.maxStakeUsd) {
    stake = risk.maxStakeUsd;
    riskUsd = (stake * multiplier * stopDistance) / entry;
    notes.push('stake_capped');
  }
  if (!(stake >= risk.minStakeUsd)) {
    add('stake_below_min', `The sized stake ${fmtMoney(stake, 'USD', 4)} is below the minimum of ${fmtMoney(risk.minStakeUsd, 'USD', 2)}. It is not rounded up.`);
  }

  const ok = reasons.length === 0;
  let approval = null;
  if (ok) {
    approval = issueApproval({
      id: `RME:${caseId}`, caseId, asset: caseMsg.asset, tf: caseMsg.tf, side: plan.side, stake, riskUsd, multiplier, issuedAtMs: nowMs,
    });
  }
  return { ok, caseId, reasons, stake, riskUsd, multiplier, approval, notes };
}
