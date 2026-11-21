// Shadow replay: what would a refused or unfilled case have done? Used only to give the learning loop extra labelled
// rows. These rows never count toward the 100 closed trades and never appear in the performance numbers.
// Pure: no DOM, storage, network or clock. Fill rules match the paper trader: a limit fills at the open when the bar
// opens through it, else at the entry when the bar reaches it. The stop is read before the target within a bar.

// plan: { side, entry, stop, target }. candles: closed candles AFTER the case bar, oldest first.
// horizon: bars to wait for a fill, and bars to hold after it. halfSpread is charged on both sides.
// Returns { status: 'pending' | 'nofill' | 'win' | 'loss' | 'timeout' | 'invalid', rMultiple?, fillIndex?, exitIndex? }.
export function replayPlan({ plan, candles, horizon = 24, halfSpread = 0 }) {
  if (!plan || !Number.isFinite(plan.entry) || !Number.isFinite(plan.stop) || !Number.isFinite(plan.target)) return { status: 'invalid' };
  const buy = plan.side !== 'sell';
  const dir = buy ? 1 : -1;
  const risk = Math.abs(plan.entry - plan.stop);
  if (!(risk > 0)) return { status: 'invalid' };
  const costR = (2 * halfSpread) / risk;
  const rOf = (px, fill) => (dir * (px - fill)) / risk - costR;
  const wait = Math.max(1, Math.floor(horizon));

  let fillAt = -1;
  let fillPx = NaN;
  for (let i = 0; i < candles.length && i < wait; i += 1) {
    const c = candles[i];
    if (buy ? c.open <= plan.entry : c.open >= plan.entry) {
      fillAt = i;
      fillPx = c.open;
      break;
    }
    if (buy ? c.low <= plan.entry : c.high >= plan.entry) {
      fillAt = i;
      fillPx = plan.entry;
      break;
    }
  }
  if (fillAt < 0) return candles.length >= wait ? { status: 'nofill' } : { status: 'pending' };

  for (let i = fillAt; i < candles.length; i += 1) {
    const c = candles[i];
    const stopHit = buy ? c.low <= plan.stop : c.high >= plan.stop;
    if (stopHit) {
      const gap = i > fillAt && (buy ? c.open <= plan.stop : c.open >= plan.stop);
      return { status: 'loss', rMultiple: rOf(gap ? c.open : plan.stop, fillPx), fillIndex: fillAt, exitIndex: i };
    }
    // On the fill bar only the stop counts: the high may have come before the fill.
    if (i > fillAt && (buy ? c.high >= plan.target : c.low <= plan.target)) {
      return { status: 'win', rMultiple: rOf(plan.target, fillPx), fillIndex: fillAt, exitIndex: i };
    }
    if (i - fillAt >= wait) return { status: 'timeout', rMultiple: rOf(c.close, fillPx), fillIndex: fillAt, exitIndex: i };
  }
  return { status: 'pending' };
}
