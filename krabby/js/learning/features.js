// Learning features. Pure: no DOM, storage, network, clock or randomness.
// buildFeatures(caseSnap, cfg) -> { names, values, missing }
// cfg is the 'll' group (cfgFor('ll', settings)); each feature family is gated by cfg.feat.*.
// A missing value becomes 0 and is counted in `missing`; nothing throws.

const VOL_CLASSES = ['low', 'normal', 'high'];
const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Number, boolean (as 0/1) or null when the value is not usable.
function asNum(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

// Names for a given cfg, without data. Same order as buildFeatures.
export function featureNames(cfg = {}) {
  return buildFeatures({}, cfg).names;
}

export function buildFeatures(caseSnap, cfg = {}) {
  const snap = caseSnap && typeof caseSnap === 'object' ? caseSnap : {};
  const feat = (cfg && (cfg.feat || (cfg.ll && cfg.ll.feat))) || {};
  const on = (key) => feat[key] !== false;
  const names = [];
  const values = [];
  let missing = 0;

  const add = (name, raw, map = (x) => x) => {
    names.push(name);
    const v = asNum(raw);
    if (v === null) {
      values.push(0);
      missing += 1;
    } else {
      values.push(map(v));
    }
  };

  if (on('families')) {
    const fam = snap.families && typeof snap.families === 'object' ? snap.families : {};
    for (const key of ['levels', 'structure', 'liquidity', 'zones']) add(`family_${key}`, fam[key]);
    add('agree_count', snap.agreeCount, (v) => clip(v, 0, 4) / 4);
  }
  if (on('evidence')) add('evidence_rank', snap.evidenceRank, (v) => clip(v, 0, 100) / 100);
  if (on('sweep')) add('sweep_seen', snap.sweepSeen);
  if (on('fvgOb')) add('fvg_ob', snap.fvgObOk);
  if (on('structure')) add('structure_ok', snap.structureOk);
  if (on('volatility')) {
    const cls = typeof snap.volClass === 'string' ? snap.volClass : null;
    const known = VOL_CLASSES.includes(cls);
    for (const c of VOL_CLASSES) {
      names.push(`vol_${c}`);
      values.push(known && cls === c ? 1 : 0);
    }
    if (!known) missing += 1;
    add('atr_pct', snap.atrPct, (v) => clip(v, 0, 100) / 100);
  }
  if (on('time')) {
    const h = asNum(snap.hourUtc);
    names.push('hour_sin', 'hour_cos');
    if (h === null) {
      values.push(0, 0);
      missing += 2;
    } else {
      const angle = (2 * Math.PI * (((h % 24) + 24) % 24)) / 24;
      values.push(Math.sin(angle), Math.cos(angle));
    }
  }
  if (on('streak')) add('recent_streak', snap.recentStreak, (v) => (clip(v, -5, 5) + 5) / 10);
  if (on('rr')) {
    add('rr', snap.rr, (v) => clip(v, 0, 10) / 10);
    add('stop_atr', snap.stopAtr, (v) => clip(v, 0, 5) / 5);
  }
  if (on('zones')) add('zone_depth', snap.zoneDepth, (v) => clip(v, 0, 1));
  if (on('htf')) add('htf_agrees', snap.htfAgrees);
  if (on('breakout')) add('breakout_present', snap.breakoutPresent);

  return { names, values, missing };
}
