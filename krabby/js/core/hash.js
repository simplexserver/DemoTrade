// Hashes and a seeded random generator. Pure: no DOM, no storage, no clock.

// 32-bit FNV-1a over a string, as 8 hex characters.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// JSON with sorted keys, so the same object always gives the same text.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export const hashObject = (value) => fnv1a(stableStringify(value));

// Mixes one number into a running 32-bit hash. Values are rounded to 1e-6 first, so tiny float noise cannot change it.
function mix(h, v) {
  const x = Math.round(Number(v) * 1e6);
  let out = Math.imul(h ^ (x | 0), 0x01000193);
  out = Math.imul(out ^ (Math.floor(x / 4294967296) | 0), 0x01000193);
  return out;
}

// Fingerprint of the last `window` candles and the settings used. Engines store it on every message ("inputs").
export function fingerprint(candles, window, cfg) {
  let h = 0x811c9dc5;
  const from = Math.max(0, candles.length - Math.max(1, window | 0));
  for (let i = from; i < candles.length; i += 1) {
    const c = candles[i];
    h = mix(h, c.epoch);
    h = mix(h, c.open);
    h = mix(h, c.high);
    h = mix(h, c.low);
    h = mix(h, c.close);
  }
  const text = stableStringify(cfg || {});
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Mulberry32: a small seeded generator. The same seed always gives the same sequence in [0, 1).
export function mulberry32(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
