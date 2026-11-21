// The analysis pipeline: runs the 14 analysis engines in a fixed order for one market and timeframe.
// Each engine sees the current messages of the engines before it. Every run is a full snapshot (see board.js).
// Pure: no DOM, no storage, no clock. The caller passes the closed candles and the time of the newest close.
import { cfgFor } from '../core/schema.js';
import { finalizeAll, inputsOf } from './common.js';
import { ENGINE as MSE } from './mse.js';
import { ENGINE as SRE } from './sre.js';
import { ENGINE as CDE } from './cde.js';
import { ENGINE as PDE } from './pde.js';
import { ENGINE as FVG } from './fvg.js';
import { ENGINE as OBE } from './obe.js';
import { ENGINE as BSL } from './bsl.js';
import { ENGINE as SSL } from './ssl.js';
import { ENGINE as LSE } from './lse.js';
import { ENGINE as BDE } from './bde.js';
import { ENGINE as SRD } from './srd.js';
import { ENGINE as BLE } from './ble.js';
import { ENGINE as SLE } from './sle.js';
import { ENGINE as QAE } from './qae.js';

// Order matters: later engines read the messages of earlier ones.
export const ANALYSIS = Object.freeze([MSE, SRE, CDE, PDE, FVG, OBE, BSL, SSL, LSE, BDE, SRD, BLE, SLE, QAE]);

// Smallest number of candles worth analysing. Below this, engines return nothing.
export const MIN_BARS = 30;

export function runAnalysis({ asset, tf, candles, series = () => null, board, settings, nowMs, health = null, audit = true }) {
  const perEngine = {};
  const errors = [];
  const messages = [];
  if (!Array.isArray(candles) || candles.length < MIN_BARS) {
    for (const E of ANALYSIS) board.markRun(E.code, asset, tf, nowMs);
    return { messages, perEngine, errors };
  }
  const view = board.view();
  for (const E of ANALYSIS) {
    const cfg = cfgFor(E.prefix, settings);
    let produced = [];
    try {
      produced = E.run({ asset, tf, candles, series, board: view, cfg, nowMs, health, settings }) || [];
    } catch (e) {
      errors.push({ engine: E.code, message: String((e && e.message) || e) });
      produced = [];
    }
    const meta = { code: E.code, asset, tf, runMs: nowMs, inputs: inputsOf(candles, cfg.lookback || 200, cfg) };
    const finished = finalizeAll(meta, produced);
    board.markRun(E.code, asset, tf, nowMs);
    board.publish(finished, { audit });
    perEngine[E.code] = finished.length;
    messages.push(...finished);
  }
  return { messages, perEngine, errors };
}
