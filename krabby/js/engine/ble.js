// BLE: buy-limit proposals near support and discount areas. The work is shared with SLE in entry-core.js.
import { buildEntries } from './entry-core.js';

export function run(ctx) {
  return buildEntries(ctx, 'buy');
}

export const ENGINE = { code: 'BLE', name: 'Buy limit', stage: 2, prefix: 'ble', topics: ['entries.buy'], run };
