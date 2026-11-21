// The rule book: what the scanner found, kept so the radar and the paper trader can use it later.
// A rule is a condition on the market (for example "the hour is 08-11 and the trend is up") with a side, a stop and a target.
// Rules come only from a scan whose untouched test part supported them. They can be switched off one by one, and they
// are traded, if the person chose that, on paper only and through the same risk checks as everything else.
// Pure: no DOM, storage, network or clock. The caller saves exportState() wherever it keeps things.
import { fnv1a, stableStringify } from '../core/hash.js';
import { matchingRules, signalFor, describeRule } from './scanner.js';

const STATE_VERSION = 1;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function ruleId(asset, tf, rule) {
  return `R:${fnv1a(stableStringify({ asset, tf, side: rule.side, conds: [...rule.conds].sort((a, b) => (a.feature < b.feature ? -1 : 1)), stopAtr: rule.stopAtr, rr: rule.rr }))}`;
}

// Many survivors are the same idea with a different extra condition. One per (side, set of features), best test lower bound
// first, so the list the person sees is varied and short.
export function pickDistinct(survivors, limit = 20) {
  const seen = new Set();
  const out = [];
  for (const s of survivors) {
    const key = `${s.rule.side}|${s.rule.conds.map((c) => c.feature).sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export class RuleBook {
  constructor({ onChange = null, nowFn = () => Date.now() } = {}) {
    this.rules = new Map();
    this.scans = {};
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.nowFn = nowFn;
  }

  _changed() { if (this.onChange) { try { this.onChange(); } catch (_) { /* a listener must not break the book */ } } }

  // Stores the outcome of a scan of one market and timeframe. Rules from an earlier scan of the same market are replaced,
  // except that a rule the person switched off stays off if it comes back.
  recordScan(asset, tf, result, { limit = 20 } = {}) {
    const key = `${asset}|${tf}`;
    const now = this.nowFn();
    this.scans[key] = {
      asset, tf, atMs: now, ok: Boolean(result && result.ok), bars: result && result.bars, tried: result && result.tried, tested: result && result.tested,
      candidates: result && result.candidates, survivors: result && result.survivors ? result.survivors.length : 0,
      verdict: result && result.verdict ? result.verdict : null, depth: result && result.depth, warnings: (result && result.warnings) || [],
      error: result && !result.ok ? result.error : null,
    };
    if (!result || !result.ok) { this._changed(); return { added: 0, kept: 0 }; }
    const off = new Set([...this.rules.values()].filter((r) => r.asset === asset && r.tf === tf && !r.enabled).map((r) => r.id));
    for (const [id, r] of [...this.rules]) if (r.asset === asset && r.tf === tf) this.rules.delete(id);
    let added = 0;
    for (const s of pickDistinct(result.survivors, limit)) {
      const id = ruleId(asset, tf, s.rule);
      this.rules.set(id, {
        id, asset, tf, rule: s.rule, text: describeRule(s.rule), train: s.train, val: s.val, test: s.test, addedMs: now, enabled: !off.has(id),
        forward: { n: 0, sumR: 0 },
      });
      added += 1;
    }
    this._changed();
    return { added, kept: off.size };
  }

  list({ asset = null, tf = null } = {}) {
    return [...this.rules.values()].filter((r) => (asset === null || r.asset === asset) && (tf === null || r.tf === tf)).sort((a, b) => (b.test.lo ?? -9) - (a.test.lo ?? -9));
  }

  get(id) { return this.rules.get(id) || null; }
  setEnabled(id, on) { const r = this.rules.get(id); if (!r) return false; r.enabled = Boolean(on); this._changed(); return true; }
  remove(id) { const ok = this.rules.delete(id); if (ok) this._changed(); return ok; }
  clear() { this.rules.clear(); this.scans = {}; this._changed(); }

  // Rules that hold on the last candle of this market and timeframe right now. Switched-off rules are listed but flagged.
  radar(asset, tf, candles) {
    const mine = this.list({ asset, tf });
    if (!mine.length) return [];
    const hits = matchingRules(mine, candles, tf);
    return hits.map((h) => ({ id: h.entry.id, text: h.entry.text, side: h.rule.side, enabled: h.entry.enabled, test: h.entry.test, train: h.entry.train, atr: h.atr, close: h.close, forward: h.entry.forward }));
  }

  // Signals for the paper trader: the best `maxRules` enabled rules that match now. Each is { strategyName, signals, id }.
  paperSignals(asset, tf, candles, { maxRules = 3 } = {}) {
    const mine = this.list({ asset, tf }).filter((r) => r.enabled && r.test && isNum(r.test.lo) && r.test.lo > 0).slice(0, Math.max(1, maxRules));
    if (!mine.length) return [];
    const out = [];
    for (const h of matchingRules(mine, candles, tf)) {
      const sig = signalFor(h.rule, { close: h.close, atr: h.atr, expiryBars: 1 });
      if (sig) out.push({ id: h.entry.id, strategyName: h.entry.text, signals: [sig] });
    }
    return out;
  }

  // Forward paper results per rule, by the rule's text (the strategy name on the trade). Never counts history.
  noteForward(trades) {
    const byText = new Map([...this.rules.values()].map((r) => [r.text, r]));
    for (const r of this.rules.values()) r.forward = { n: 0, sumR: 0 };
    for (const t of trades || []) {
      const r = t && t.strategy ? byText.get(t.strategy) : null;
      if (r && isNum(t.rMultiple)) { r.forward.n += 1; r.forward.sumR += t.rMultiple; }
    }
  }

  exportState() { return { version: STATE_VERSION, rules: [...this.rules.values()], scans: this.scans }; }

  importState(s) {
    if (!s || s.version !== STATE_VERSION || !Array.isArray(s.rules)) return false;
    this.rules.clear();
    for (const r of s.rules) {
      if (r && typeof r.id === 'string' && r.rule && Array.isArray(r.rule.conds) && typeof r.asset === 'string' && isNum(r.tf)) this.rules.set(r.id, { ...r, forward: r.forward || { n: 0, sumR: 0 } });
    }
    this.scans = s.scans && typeof s.scans === 'object' ? s.scans : {};
    return true;
  }
}
