// Learning models. Pure: no DOM, storage, network or clock. The only randomness is a seeded generator, so the same
// data and settings always give the same model.
//   - Logistic regression by mini-batch gradient descent: L2, class weights, age decay, early stopping.
//   - Bucket calibration: per-feature equal-frequency bins with smoothed rates and Wilson bounds. Easy to read.
//   - A blend of the two.
// cfg is the 'll' group of the settings (cfgFor('ll', settings)).
import { mulberry32 } from '../core/hash.js';
import { wilson } from '../core/util.js';

const EPS = 1e-9;
const clipP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const logit = (p) => Math.log(clipP(p) / (1 - clipP(p)));
const finite = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const MODEL_KINDS = ['logistic', 'bucket', 'blend'];

// ---------------------------------------------------------------- logistic regression

function fitScaler(rows, mode) {
  const d = rows.length ? rows[0].length : 0;
  const mean = new Array(d).fill(0);
  const scale = new Array(d).fill(1);
  if (mode === 'none' || !rows.length) return { mean, scale };
  for (let j = 0; j < d; j += 1) {
    if (mode === 'minmax') {
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of rows) {
        const v = finite(r[j]);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mean[j] = lo;
      scale[j] = hi - lo > EPS ? hi - lo : 1;
    } else {
      let s = 0;
      for (const r of rows) s += finite(r[j]);
      const m = s / rows.length;
      let v = 0;
      for (const r of rows) v += (finite(r[j]) - m) ** 2;
      const sd = Math.sqrt(v / rows.length);
      mean[j] = m;
      scale[j] = sd > EPS ? sd : 1;
    }
  }
  return { mean, scale };
}

const standardizeRow = (x, mean, scale) => x.map((v, j) => (Number.isFinite(v) ? (v - mean[j]) / scale[j] : 0));

function lossOf(Z, y, w, b) {
  let s = 0;
  for (let i = 0; i < Z.length; i += 1) {
    let z = b;
    const zi = Z[i];
    for (let j = 0; j < zi.length; j += 1) z += w[j] * zi[j];
    const p = clipP(sigmoid(z));
    s += -(y[i] ? Math.log(p) : Math.log(1 - p));
  }
  return Z.length ? s / Z.length : NaN;
}

// X: rows of numbers. y: 0 or 1 per row, oldest first. Returns a plain-object model. Never throws on thin data:
// with too little data or one class only it returns a model that predicts the base rate (degenerate: true).
export function fitLogistic(X, y, cfg = {}) {
  const n = X.length;
  const d = n ? X[0].length : 0;
  const pos = y.reduce((a, v) => a + (v ? 1 : 0), 0);
  const base = n ? pos / n : 0.5;
  const mode = ['zscore', 'minmax', 'none'].includes(cfg.standardize) ? cfg.standardize : 'zscore';
  const model = {
    kind: 'logistic', d, w: new Array(d).fill(0), b: logit(base), mean: new Array(d).fill(0), scale: new Array(d).fill(1),
    standardize: mode, n, pos, base, epochs: 0, trainLoss: null, valLoss: null, seed: finite(cfg.seed, 42), degenerate: false,
  };
  if (n < 10 || pos === 0 || pos === n || d === 0) {
    model.degenerate = true;
    return model;
  }
  const patience = Math.max(0, Math.floor(finite(cfg.patience, 10)));
  const valShare = Math.min(0.4, Math.max(0.05, finite(cfg.valSplit, 0.15)));
  let valN = patience > 0 ? Math.max(5, Math.floor(n * valShare)) : 0;
  if (n - valN < 10) valN = 0;
  const trainN = n - valN;
  const Xtr = X.slice(0, trainN);
  const ytr = y.slice(0, trainN);
  const trPos = ytr.reduce((a, v) => a + (v ? 1 : 0), 0);
  if (trPos === 0 || trPos === trainN) {
    model.degenerate = true;
    return model;
  }
  const { mean, scale } = fitScaler(Xtr, mode);
  const Ztr = Xtr.map((r) => standardizeRow(r, mean, scale));
  const Zva = X.slice(trainN).map((r) => standardizeRow(r, mean, scale));
  const yva = y.slice(trainN);

  // Sample weights: class balance, then age decay (newest weigh most), scaled to mean 1.
  const half = Math.max(0, finite(cfg.decayHalfLife, 0));
  const sw = new Array(trainN).fill(1);
  if (cfg.classWeight === 'balanced') {
    const wPos = trainN / (2 * trPos);
    const wNeg = trainN / (2 * (trainN - trPos));
    for (let i = 0; i < trainN; i += 1) sw[i] = ytr[i] ? wPos : wNeg;
  }
  if (half > 0) for (let i = 0; i < trainN; i += 1) sw[i] *= 0.5 ** ((trainN - 1 - i) / half);
  const swMean = sw.reduce((a, v) => a + v, 0) / trainN;
  for (let i = 0; i < trainN; i += 1) sw[i] /= swMean;

  const lr = Math.max(1e-6, finite(cfg.lr, 0.05));
  const l2 = Math.max(0, finite(cfg.l2, 0.01));
  const epochs = Math.max(1, Math.floor(finite(cfg.epochs, 80)));
  const batch = Math.max(1, Math.floor(finite(cfg.batch, 16)));
  const rnd = mulberry32(model.seed >>> 0);
  const order = Array.from({ length: trainN }, (_, i) => i);
  let w = new Array(d).fill(0);
  let b = logit(trPos / trainN);
  let best = { w: w.slice(), b, loss: valN ? lossOf(Zva, yva, w, b) : lossOf(Ztr, ytr, w, b), epoch: 0 };
  let since = 0;
  let used = 0;
  for (let e = 1; e <= epochs; e += 1) {
    for (let i = trainN - 1; i > 0; i -= 1) {
      const k = Math.floor(rnd() * (i + 1));
      const t = order[i];
      order[i] = order[k];
      order[k] = t;
    }
    for (let s = 0; s < trainN; s += batch) {
      const end = Math.min(trainN, s + batch);
      const gw = new Array(d).fill(0);
      let gb = 0;
      let wsum = 0;
      for (let q = s; q < end; q += 1) {
        const i = order[q];
        const zi = Ztr[i];
        let z = b;
        for (let j = 0; j < d; j += 1) z += w[j] * zi[j];
        const err = (sigmoid(z) - ytr[i]) * sw[i];
        for (let j = 0; j < d; j += 1) gw[j] += err * zi[j];
        gb += err;
        wsum += sw[i];
      }
      const norm = wsum > 0 ? wsum : 1;
      for (let j = 0; j < d; j += 1) w[j] -= lr * (gw[j] / norm + l2 * w[j]);
      b -= lr * (gb / norm);
    }
    used = e;
    const loss = valN ? lossOf(Zva, yva, w, b) : lossOf(Ztr, ytr, w, b);
    if (loss < best.loss - 1e-9) {
      best = { w: w.slice(), b, loss, epoch: e };
      since = 0;
    } else {
      since += 1;
      if (patience > 0 && valN > 0 && since >= patience) break;
    }
  }
  const keep = patience > 0 && valN > 0 ? best : { w, b, loss: best.loss, epoch: used };
  model.w = keep.w;
  model.b = keep.b;
  model.mean = mean;
  model.scale = scale;
  model.epochs = keep.epoch || used;
  model.trainLoss = lossOf(Ztr, ytr, model.w, model.b);
  model.valLoss = valN ? lossOf(Zva, yva, model.w, model.b) : null;
  return model;
}

export function predictLogistic(model, x) {
  if (!model || !Array.isArray(model.w)) return NaN;
  let z = model.b;
  for (let j = 0; j < model.w.length; j += 1) {
    const v = x[j];
    if (Number.isFinite(v)) z += model.w[j] * ((v - model.mean[j]) / model.scale[j]);
  }
  return clipP(sigmoid(z));
}

// ---------------------------------------------------------------- bucket calibration

function edgesFor(values, bins) {
  const uniq = [...new Set(values.map((v) => finite(v)))].sort((a, b) => a - b);
  if (uniq.length <= 1) return [];
  if (uniq.length <= 2) return [(uniq[0] + uniq[1]) / 2];
  const sorted = values.map((v) => finite(v)).sort((a, b) => a - b);
  const nb = Math.min(Math.max(2, Math.floor(bins)), uniq.length);
  const edges = [];
  for (let k = 1; k < nb; k += 1) {
    const e = sorted[Math.min(sorted.length - 1, Math.floor((k * sorted.length) / nb))];
    const prev = edges.length ? edges[edges.length - 1] : -Infinity;
    if (e > prev && e < uniq[uniq.length - 1]) edges.push(e);
  }
  return edges;
}

const binOf = (edges, v) => {
  let i = 0;
  while (i < edges.length && v > edges[i]) i += 1;
  return i;
};

// names is optional and only for display. Each feature gets bins; each bin gets a smoothed rate and a Wilson range.
export function fitBuckets(X, y, cfg = {}, names = []) {
  const n = X.length;
  const d = n ? X[0].length : 0;
  const pos = y.reduce((a, v) => a + (v ? 1 : 0), 0);
  const base = n ? pos / n : 0.5;
  const prior = Math.max(0, finite(cfg.priorStrength, 10));
  const bins = Math.max(2, Math.floor(finite(cfg.bins, 5)));
  const z = finite(cfg.z, 1.96);
  const features = [];
  for (let j = 0; j < d; j += 1) {
    const col = X.map((r) => r[j]);
    const edges = edgesFor(col, bins);
    const cells = Array.from({ length: edges.length + 1 }, () => ({ n: 0, wins: 0 }));
    for (let i = 0; i < n; i += 1) {
      const c = cells[binOf(edges, finite(col[i]))];
      c.n += 1;
      if (y[i]) c.wins += 1;
    }
    features.push({
      name: names[j] || `f${j}`,
      edges,
      cells: cells.map((c) => {
        const w = wilson(c.wins, c.n, z);
        return { n: c.n, wins: c.wins, rate: (c.wins + prior * base) / (c.n + prior || 1), lo: c.n ? w.lo : null, hi: c.n ? w.hi : null };
      }),
    });
  }
  return { kind: 'bucket', n, pos, base, prior, bins, d, z, features };
}

// Average, over features, of how far each feature's bin moves the log-odds from the base rate. Averaging (not
// summing) keeps correlated features from making the result overconfident.
export function predictBuckets(model, x) {
  if (!model || !Array.isArray(model.features) || !model.features.length) return NaN;
  const b0 = logit(model.base);
  let total = 0;
  let used = 0;
  for (let j = 0; j < model.features.length; j += 1) {
    const f = model.features[j];
    if (f.edges.length === 0) continue;
    const cell = f.cells[binOf(f.edges, finite(x[j]))];
    total += logit(cell.rate) - b0;
    used += 1;
  }
  return clipP(sigmoid(b0 + (used ? total / used : 0)));
}

// ---------------------------------------------------------------- the bundle used by the loop

// kind is the 'll.model' setting: 'logistic', 'bucket' or 'blend'.
export function fitModel(X, y, cfg = {}, names = []) {
  const kind = MODEL_KINDS.includes(cfg.model) ? cfg.model : 'blend';
  const bundle = { kind, names: names.slice(), logistic: null, bucket: null, blendWeight: Math.min(1, Math.max(0, finite(cfg.blendWeight, 0.5))) };
  if (kind !== 'bucket') bundle.logistic = fitLogistic(X, y, cfg);
  if (kind !== 'logistic') bundle.bucket = fitBuckets(X, y, cfg, names);
  return bundle;
}

export function predictBlend(bundle, x, weight = bundle && bundle.blendWeight) {
  if (!bundle) return NaN;
  const a = bundle.logistic ? predictLogistic(bundle.logistic, x) : NaN;
  const b = bundle.bucket ? predictBuckets(bundle.bucket, x) : NaN;
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  const w = Math.min(1, Math.max(0, finite(weight, 0.5)));
  return clipP(w * a + (1 - w) * b);
}

export const predictModel = (bundle, x) => predictBlend(bundle, x);

// Which features matter, largest first. Logistic: size of the weight on the scaled feature.
// Buckets: spread between the best and worst bin rate. Both are scaled to the largest value so they can be compared.
export function featureImportance(bundle) {
  if (!bundle) return [];
  const names = bundle.names || [];
  const rows = [];
  const d = Math.max(bundle.logistic ? bundle.logistic.w.length : 0, bundle.bucket ? bundle.bucket.features.length : 0);
  for (let j = 0; j < d; j += 1) {
    const lw = bundle.logistic ? Math.abs(bundle.logistic.w[j]) : 0;
    let spread = 0;
    if (bundle.bucket) {
      const rates = bundle.bucket.features[j].cells.filter((c) => c.n > 0).map((c) => c.rate);
      spread = rates.length ? Math.max(...rates) - Math.min(...rates) : 0;
    }
    rows.push({ name: names[j] || `f${j}`, weight: bundle.logistic ? bundle.logistic.w[j] : null, logistic: lw, spread });
  }
  const maxL = Math.max(EPS, ...rows.map((r) => r.logistic));
  const maxS = Math.max(EPS, ...rows.map((r) => r.spread));
  const parts = [bundle.logistic ? 1 : 0, bundle.bucket ? 1 : 0];
  return rows
    .map((r) => ({ ...r, score: ((bundle.logistic ? r.logistic / maxL : 0) + (bundle.bucket ? r.spread / maxS : 0)) / Math.max(1, parts[0] + parts[1]) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- saving and loading

const numArray = (a, len) => Array.isArray(a) && (len === undefined || a.length === len) && a.every((v) => typeof v === 'number' && Number.isFinite(v));

export function serialize(bundle) {
  return bundle ? JSON.parse(JSON.stringify(bundle)) : null;
}

// Returns the bundle, or null when the data is not a model this code wrote.
export function deserialize(obj) {
  if (!obj || typeof obj !== 'object' || !MODEL_KINDS.includes(obj.kind)) return null;
  const lg = obj.logistic;
  if (lg) {
    const d = Array.isArray(lg.w) ? lg.w.length : -1;
    if (lg.kind !== 'logistic' || !numArray(lg.w) || !numArray(lg.mean, d) || !numArray(lg.scale, d) || !Number.isFinite(lg.b)) return null;
    if (lg.scale.some((v) => !(v > 0))) return null;
  }
  const bk = obj.bucket;
  if (bk) {
    if (bk.kind !== 'bucket' || !Array.isArray(bk.features) || !Number.isFinite(bk.base)) return null;
    for (const f of bk.features) {
      if (!f || !numArray(f.edges) || !Array.isArray(f.cells) || f.cells.length !== f.edges.length + 1) return null;
      if (!f.cells.every((c) => c && Number.isFinite(c.rate) && Number.isFinite(c.n))) return null;
    }
  }
  if (obj.kind === 'logistic' && !lg) return null;
  if (obj.kind === 'bucket' && !bk) return null;
  if (obj.kind === 'blend' && !(lg && bk)) return null;
  return serialize(obj);
}
