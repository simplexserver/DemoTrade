/**
 * chart.js — Lightweight Charts integration for SimpleXEngine [BOT].
 *
 * Manages a single LightweightCharts instance inside #main-chart.
 * Receives candle bars from the sim feed or the live Deriv tick stream.
 * Owned by the app layer; never imports from runtime or broker.
 *
 * Usage:
 *   import { ChartView } from './chart.js';
 *   const chart = new ChartView(document.getElementById('main-chart'));
 *   chart.setSymbol('cryBTCUSD', 'BTC/USD');
 *   chart.addBar({ time: epochSec, open, high, low, close });
 *   chart.addTrade({ time, side, price }); // marker
 *   chart.destroy();
 */

import { MARKET_BY_SYMBOL } from '../market/catalogue.js';

/** True when LightweightCharts is available from the vendor bundle. */
function lwcLib() {
  return globalThis.LightweightCharts || null;
}

const TF_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

/** Build a compact candle from raw ticks for a given timeframe bucket. */
function tickToBar(prevBar, tick, tfSec) {
  const bucket = Math.floor(tick.time / tfSec) * tfSec;
  if (!prevBar || prevBar.time !== bucket) {
    return { time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price };
  }
  return {
    time: prevBar.time,
    open: prevBar.open,
    high: Math.max(prevBar.high, tick.price),
    low: Math.min(prevBar.low, tick.price),
    close: tick.price,
  };
}

export class ChartView {
  /**
   * @param {HTMLElement} container – the #main-chart div
   * @param {{ theme?: 'dark'|'light' }} opts
   */
  constructor(container, opts = {}) {
    this._container = container;
    this._chart = null;
    this._candleSeries = null;
    this._volumeSeries = null;
    this._markers = [];
    this._bars = [];
    this._tf = '1m';
    this._tfSec = TF_SECONDS['1m'];
    this._symbol = null;
    this._label = null;
    this._destroyed = false;
    this._init(opts.theme || 'dark');
  }

  _init(theme) {
    const LWC = lwcLib();
    if (!LWC) {
      this._container.innerHTML = `<div class="chart-fallback">Chart library not loaded.</div>`;
      return;
    }

    const bg = theme === 'dark' ? '#090d13' : '#ffffff';
    const textCol = theme === 'dark' ? '#94a3b8' : '#334155';
    const gridCol = theme === 'dark' ? '#131c28' : '#e2e8f0';
    const borderCol = theme === 'dark' ? '#1e293b' : '#cbd5e1';

    this._chart = LWC.createChart(this._container, {
      layout: { background: { color: bg }, textColor: textCol, fontSize: 11, fontFamily: "'Inter', 'Segoe UI', sans-serif" },
      grid: { vertLines: { color: gridCol }, horzLines: { color: gridCol } },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: borderCol, scaleMargins: { top: 0.08, bottom: 0.25 } },
      timeScale: { borderColor: borderCol, timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });

    this._candleSeries = this._chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    this._volumeSeries = this._chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // Fit on first resize
    const ro = new ResizeObserver(() => this._onResize());
    ro.observe(this._container);
    this._ro = ro;
  }

  _onResize() {
    if (!this._chart || this._destroyed) return;
    const { offsetWidth: w, offsetHeight: h } = this._container;
    if (w > 0 && h > 0) this._chart.resize(w, h);
  }

  /** Switch the chart to a new market symbol. Clears all data. */
  setSymbol(symbol, label) {
    this._symbol = symbol;
    this._label = label || symbol;
    this._bars = [];
    this._markers = [];
    if (this._candleSeries) this._candleSeries.setData([]);
    if (this._volumeSeries) this._volumeSeries.setData([]);
    this._updateTitle();
  }

  _updateTitle() {
    const titleEl = this._container.closest('.chart-panel')?.querySelector('.chart-symbol-label');
    if (titleEl) titleEl.textContent = this._label || this._symbol || '—';
  }

  /** Set the timeframe. Rebuilds bars from tick history if any. */
  setTimeframe(tf) {
    if (!TF_SECONDS[tf]) return;
    this._tf = tf;
    this._tfSec = TF_SECONDS[tf];
    // Rebuild from stored raw bars (they are already aggregated candles)
    // If we had ticks we'd re-aggregate; here we just clear since we reload on symbol switch anyway.
    this._bars = [];
    this._markers = [];
    if (this._candleSeries) this._candleSeries.setData([]);
    if (this._volumeSeries) this._volumeSeries.setData([]);
  }

  /**
   * Add or update the last bar (upsert).
   * bar: { time: epochSeconds, open, high, low, close, volume? }
   */
  addBar(bar) {
    if (!this._candleSeries || this._destroyed) return;
    // Ensure bars are sorted (Lightweight Charts requires ascending time)
    const last = this._bars[this._bars.length - 1];
    if (last && last.time === bar.time) {
      this._bars[this._bars.length - 1] = bar;
    } else {
      this._bars.push(bar);
    }
    this._candleSeries.update(bar);
    if (typeof bar.volume === 'number') {
      const volBar = { time: bar.time, value: bar.volume, color: bar.close >= bar.open ? '#22c55e44' : '#ef444444' };
      this._volumeSeries.update(volBar);
    }
  }

  /**
   * Bulk-load bars (replaces existing data).
   * bars: Array<{ time, open, high, low, close, volume? }>
   */
  setBars(bars) {
    if (!this._candleSeries || this._destroyed) return;
    this._bars = [...bars].sort((a, b) => a.time - b.time);
    this._candleSeries.setData(this._bars);
    const vols = this._bars.filter(b => typeof b.volume === 'number').map(b => ({
      time: b.time, value: b.volume, color: b.close >= b.open ? '#22c55e44' : '#ef444444',
    }));
    if (vols.length) this._volumeSeries.setData(vols);
    this._chart.timeScale().fitContent();
  }

  /**
   * Ingest a price tick and auto-build/update the current candle.
   * tick: { time: epochSeconds, price }
   */
  addTick(tick) {
    const last = this._bars[this._bars.length - 1] || null;
    const bar = tickToBar(last, tick, this._tfSec);
    this.addBar(bar);
  }

  /**
   * Add a trade marker (buy/sell arrow).
   * trade: { time: epochSeconds, side: 'up'|'down', price, label? }
   */
  addTrade(trade) {
    if (!this._candleSeries || this._destroyed) return;
    const isBuy = trade.side === 'up';
    const marker = {
      time: trade.time,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color: isBuy ? '#22c55e' : '#ef4444',
      shape: isBuy ? 'arrowUp' : 'arrowDown',
      text: trade.label || (isBuy ? '▲' : '▼'),
    };
    this._markers.push(marker);
    // Sort markers by time (required by LWC)
    this._markers.sort((a, b) => a.time - b.time);
    this._candleSeries.setMarkers(this._markers);
  }

  /** Draw a horizontal price line (e.g. stop loss, take profit). */
  addPriceLine(price, { color = '#f59e0b', title = '', lineStyle = 2 } = {}) {
    if (!this._candleSeries) return null;
    return this._candleSeries.createPriceLine({ price, color, title, lineStyle, lineWidth: 1, axisLabelVisible: true });
  }

  removePriceLine(ref) {
    if (this._candleSeries && ref) {
      try { this._candleSeries.removePriceLine(ref); } catch (_) { /* noop */ }
    }
  }

  /** Scroll the chart to the latest bar. */
  scrollToNow() {
    if (this._chart && !this._destroyed) this._chart.timeScale().scrollToRealTime();
  }

  /** Fit all bars in view. */
  fitContent() {
    if (this._chart && !this._destroyed) this._chart.timeScale().fitContent();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._chart) { this._chart.remove(); this._chart = null; }
    this._candleSeries = null;
    this._volumeSeries = null;
  }
}

/**
 * Module-level singleton: one chart for the main chart view.
 * Created lazily on first call to getMainChart().
 */
let _mainChart = null;

export function getMainChart(container) {
  if (_mainChart && !_mainChart._destroyed) return _mainChart;
  if (!container) {
    container = document.getElementById('main-chart');
  }
  if (!container) return null;
  _mainChart = new ChartView(container, { theme: 'dark' });
  return _mainChart;
}

export function destroyMainChart() {
  if (_mainChart) { _mainChart.destroy(); _mainChart = null; }
}
