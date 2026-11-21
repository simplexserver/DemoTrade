// Basket indices and confluence. Pure: symbols, markets and candles in, a vote out. No DOM, no network.
// A basket such as WLDAUD tracks one currency (or gold, XAU) against the others. Its confluence is a vote
// across the forex pairs and metals that contain that currency:
//   - currency is the BASE of the pair (AUDUSD): the pair's EMA trend is the vote.
//   - currency is the QUOTE of the pair (EURAUD): the vote is inverted.

import { closes, ema } from './indicators.js';
import { toNumber } from '../core/util.js';

const MIN_COMPONENTS = 3;

const flip = (dir) => (dir === 'up' ? 'down' : 'up');

// Currency or metal code of a basket index: 'WLDAUD' -> 'AUD', 'WLDXAU' -> 'XAU'. Null for other symbols.
export function basketCurrency(symbol) {
  const m = String(symbol ?? '').toUpperCase().match(/^WLD([A-Z]{3})$/);
  return m ? m[1] : null;
}

// Where a currency sits in a six-letter pair symbol (frx prefix optional): 'base', 'quote', or null.
function pairRole(symbol, currency) {
  const body = String(symbol ?? '').toUpperCase().replace(/^FRX/, '');
  if (body.length !== 6) return null;
  if (body.slice(0, 3) === currency) return 'base';
  if (body.slice(3) === currency) return 'quote';
  return null;
}

// Forex and commodity symbols whose pair contains the currency, e.g. ['frxEURUSD', 'frxGBPEUR'] for EUR.
export function componentSymbols(currency, markets) {
  const code = String(currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || !Array.isArray(markets)) return [];
  return markets
    .filter((m) => (m?.market === 'forex' || m?.market === 'commodities') && pairRole(m.symbol, code))
    .map((m) => m.symbol);
}

// Pair trend on the last candle: EMA(fast) against EMA(slow). Null while either is not yet defined.
function trendOf(candles, fastP, slowP) {
  const c = closes(Array.isArray(candles) ? candles : []);
  const fast = ema(c, fastP);
  const slow = ema(c, slowP);
  const i = c.length - 1;
  if (i < 0 || !Number.isFinite(fast[i]) || !Number.isFinite(slow[i])) return null;
  if (fast[i] > slow[i]) return 'up';
  if (fast[i] < slow[i]) return 'down';
  return null;
}

// Confluence of a basket's components. Each component votes with its pair's trend, inverted when the currency is the quote.
// score = share of votes on the larger side (0-100). pass needs >= 3 votes, a direction and score >= threshold.
// detail[].dir is the pair's own trend; detail[].vote is the vote for the currency.
export function basketConfluence({ currency, components = [], emaFast = 9, emaSlow = 21, threshold = 60 } = {}) {
  const code = String(currency ?? '').toUpperCase();
  const fastP = toNumber(emaFast, 9);
  const slowP = toNumber(emaSlow, 21);
  const minPct = toNumber(threshold, 60);
  const detail = [];
  let ignored = 0;
  for (const comp of Array.isArray(components) ? components : []) {
    const role = pairRole(comp?.symbol, code);
    if (!role) {
      ignored += 1;
      continue;
    }
    const dir = trendOf(comp.candles, fastP, slowP);
    const vote = dir === null || role === 'base' ? dir : flip(dir);
    detail.push({ symbol: comp.symbol, dir, role, vote });
  }
  const upVotes = detail.filter((d) => d.vote === 'up').length;
  const downVotes = detail.filter((d) => d.vote === 'down').length;
  const total = upVotes + downVotes;
  const direction = upVotes === downVotes ? null : upVotes > downVotes ? 'up' : 'down';
  const agreeing = Math.max(upVotes, downVotes);
  const score = total > 0 ? Math.round((100 * agreeing) / total) : 0;
  const pass = total >= MIN_COMPONENTS && direction !== null && score >= minPct;

  let reason;
  if (!code) reason = 'Choose a basket first.';
  else if (total === 0) reason = `No component has a trend reading for ${code} yet.`;
  else if (total < MIN_COMPONENTS) reason = `Only ${total} component${total === 1 ? '' : 's'} can vote for ${code}. At least ${MIN_COMPONENTS} are needed.`;
  else if (direction === null) reason = `The components are evenly split for ${code} (${upVotes} up, ${downVotes} down).`;
  else if (score < minPct) reason = `${agreeing} of ${total} components point ${direction} for ${code} (${score}%), below the ${minPct}% threshold.`;
  else reason = `${agreeing} of ${total} components point ${direction} for ${code} (${score}%). Meets the ${minPct}% threshold.`;
  if (ignored > 0 && code) reason += ` ${ignored} component${ignored === 1 ? ' was' : 's were'} ignored because ${ignored === 1 ? 'it does' : 'they do'} not contain ${code}.`;

  return { score, direction, agreeing, total, pass, reason, detail };
}
