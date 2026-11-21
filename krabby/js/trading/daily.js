// Daily rules. Pure: no DOM, storage, network or clock (time is passed in).
import { fmtMoney } from '../core/util.js';

// Trading day as 'YYYY-MM-DD' (UTC). The day starts at resetHour UTC, so the clock is shifted back by resetHour.
export function utcDayKey(ms, resetHour = 0) {
  const t = Number(ms);
  if (!Number.isFinite(t)) throw new Error('utcDayKey needs a time in milliseconds.');
  const h = Number.isFinite(Number(resetHour)) ? Math.max(0, Math.min(23, Math.floor(Number(resetHour)))) : 0;
  return new Date(t - h * 3600000).toISOString().slice(0, 10);
}

// Daily profit target. It only changes the mode (normal or reduced). It never returns a stop and never adds trades.
export function dailyState({ realizedTodayUsd = 0, floatingUsd = 0, targetUsd = 0, includeFloating = true, reducedOnTarget = true } = {}) {
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const pnlUsd = n(realizedTodayUsd) + (includeFloating ? n(floatingUsd) : 0);
  const target = Math.max(0, n(targetUsd));
  const targetReached = target > 0 && pnlUsd >= target;
  const mode = targetReached && reducedOnTarget ? 'reduced' : 'normal';
  let reason = 'No daily target is set.';
  if (target > 0) {
    if (!targetReached) reason = `Today's result ${fmtMoney(pnlUsd)} is below the target of ${fmtMoney(target)}.`;
    else reason = reducedOnTarget
      ? `The daily target of ${fmtMoney(target)} is reached. Risk is reduced; trading continues.`
      : `The daily target of ${fmtMoney(target)} is reached. Reduced-risk mode is off, so nothing changes.`;
  }
  return { mode, pnlUsd, targetUsd: target, targetReached, reason };
}
