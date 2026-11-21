// Stake and state rules. Pure: plain numbers in, numbers out. No DOM, no network.
// The martingale, hedge and DCA helpers were removed in this build.
import { round, toNumber } from '../core/util.js';

const MIN_STAKE = 0.35;

// Compounder: stake x multiplierOnWin after a win (capped at maxStake). Back to the base stake after a loss.
export function compounderNext(stake, result, { base = MIN_STAKE, multiplierOnWin = 1.2, maxStake = 2 } = {}) {
  const b = Math.max(MIN_STAKE, toNumber(base, MIN_STAKE));
  if (result === 'win') {
    const grown = Math.max(b, toNumber(stake, b) * toNumber(multiplierOnWin, 1.2));
    return round(Math.min(grown, Math.max(b, toNumber(maxStake, 2))), 2);
  }
  if (result === 'loss') return round(b, 2);
  return round(Math.max(b, toNumber(stake, b)), 2);
}

// Stop loss and take profit in USD for a multiplier entry, as a share of the stake. Null when a share is zero.
export function multiplierLimits(stake, { slPct = 50, tpPct = 0 } = {}) {
  const s = toNumber(stake, 0);
  const sl = toNumber(slPct, 0) > 0 ? round(s * (toNumber(slPct, 0) / 100), 2) : null;
  const tp = toNumber(tpPct, 0) > 0 ? round(s * (toNumber(tpPct, 0) / 100), 2) : null;
  return { sl, tp };
}
