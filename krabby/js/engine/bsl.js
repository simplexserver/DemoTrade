// BSL: estimated buy-stop clusters above price (equal highs, swing highs, previous high, SRE resistance).
// Estimated from visible structure; not seen. The work is shared with SSL in liq-core.js.
import { buildLiquidity } from './liq-core.js';

export function run(ctx) {
  return buildLiquidity(ctx, 'buy');
}

export const ENGINE = { code: 'BSL', name: 'Buy-side liquidity', stage: 2, prefix: 'bsl', topics: ['liquidity.buy'], run };
