// SLE: sell-limit proposals near resistance and premium areas. The work is shared with BLE in entry-core.js.
import { buildEntries } from './entry-core.js';

export function run(ctx) {
  return buildEntries(ctx, 'sell');
}

export const ENGINE = { code: 'SLE', name: 'Sell limit', stage: 2, prefix: 'sle', topics: ['entries.sell'], run };
