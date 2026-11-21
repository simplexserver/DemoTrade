// Imported candles: parses a CSV or JSON file into valid, ascending candles and reports what was fixed or dropped.
// CSV header: epoch,open,high,low,close or time,open,high,low,close (time is ISO text or epoch seconds).
// Pure: no DOM, no storage, no clock.

function toEpoch(v) {
  if (v === undefined || v === null || v === '') return NaN;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN;
}

function clean(row) {
  const epoch = toEpoch(row.epoch !== undefined ? row.epoch : (row.time !== undefined ? row.time : row.t));
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  if (![epoch, open, high, low, close].every(Number.isFinite)) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return { epoch, open, high, low, close };
}

export function parseCandles(text, { format = 'csv' } = {}) {
  const report = { rows: 0, bad: 0, duplicates: 0, outOfOrder: 0, gaps: 0, sorted: true };
  let raw = [];
  if (format === 'json') {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch (_) {
      return { candles: [], report: { ...report, error: 'The file is not valid JSON.' } };
    }
    raw = Array.isArray(data) ? data : (data && Array.isArray(data.candles) ? data.candles : []);
  } else {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return { candles: [], report };
    const head = lines[0].toLowerCase().split(',').map((s) => s.trim());
    const hasHeader = head.some((h) => /[a-z]/.test(h));
    const cols = hasHeader ? head : ['epoch', 'open', 'high', 'low', 'close'];
    raw = (hasHeader ? lines.slice(1) : lines).map((line) => {
      const parts = line.split(',');
      const o = {};
      cols.forEach((c, i) => { o[c] = parts[i] !== undefined ? parts[i].trim() : undefined; });
      return o;
    });
  }
  report.rows = raw.length;
  const byEpoch = new Map();
  let prev = -Infinity;
  for (const r of raw) {
    const c = clean(r || {});
    if (!c) {
      report.bad += 1;
      continue;
    }
    if (c.epoch < prev) {
      report.outOfOrder += 1;
      report.sorted = false;
    }
    prev = Math.max(prev, c.epoch);
    if (byEpoch.has(c.epoch)) report.duplicates += 1;
    byEpoch.set(c.epoch, c);
  }
  const candles = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  if (candles.length > 2) {
    const diffs = new Map();
    for (let i = 1; i < candles.length; i += 1) {
      const d = candles[i].epoch - candles[i - 1].epoch;
      diffs.set(d, (diffs.get(d) || 0) + 1);
    }
    let step = 0;
    let best = 0;
    for (const [d, k] of diffs) if (k > best) { best = k; step = d; }
    if (step > 0) {
      for (let i = 1; i < candles.length; i += 1) {
        const miss = Math.round((candles[i].epoch - candles[i - 1].epoch) / step) - 1;
        if (miss > 0) report.gaps += miss;
      }
    }
    report.stepSeconds = step;
  }
  return { candles, report };
}
