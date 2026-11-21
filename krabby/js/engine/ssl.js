// SSL: estimated sell-stop clusters below price (equal lows, swing lows, previous low, SRE support).
// Estimated from visible structure; not seen. Mirror of BSL, shared code in liq-core.js.
import { buildLiquidity } from './liq-core.js';

export function run(ctx) {
  return buildLiquidity(ctx, 'sell');
}

export const ENGINE = { code: 'SSL', name: 'Sell-side liquidity', stage: 2, prefix: 'ssl', topics: ['liquidity.sell'], run };
