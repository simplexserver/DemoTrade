/**
 * chart.js — Professional multi-type chart view.
 * Supports: Candlestick · Line · Area · Baseline · OHLC Bars
 * Volume histogram always shown below.
 * Real-time tick → candle aggregation built-in.
 * Auto-subscribes to Deriv public ticks; no manual refresh needed.
 */

import { MARKET_BY_SYMBOL } from '../market/catalogue.js';

function lwcLib() { return globalThis.LightweightCharts || null; }

const TF_SECONDS = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};

const CHART_TYPES = ['candlestick', 'line', 'area', 'baseline', 'bars'];

function tickToBar(prevBar, price, timeSec, tfSec) {
  const bucket = Math.floor(timeSec / tfSec) * tfSec;
  if (!prevBar || prevBar.time !== bucket) {
    return { time: bucket, open: price, high: price, low: price, close: price };
  }
  return {
    time:  prevBar.time,
    open:  prevBar.open,
    high:  Math.max(prevBar.high, price),
    low:   Math.min(prevBar.low,  price),
    close: price,
  };
}

export class ChartView {
  constructor(container, opts = {}) {
    this._container = container;
    this._chart     = null;
    this._series    = null;      // main price series
    this._volSeries = null;      // volume histogram
    this._markers   = [];
    this._bars      = [];
    this._tf        = '1m';
    this._tfSec     = TF_SECONDS['1m'];
    this._symbol    = null;
    this._label     = null;
    this._type      = opts.type || 'candlestick'; // chart type
    this._destroyed = false;
    this._lastBar   = null;      // for real-time tick→bar
    this._ohlcEl    = null;      // OHLCV bar element ref
    this._init(opts.theme || 'dark');
  }

  /* ── Initialise LightweightCharts ───────────────────────────────────── */
  _init(theme) {
    const LWC = lwcLib();
    if (!LWC) {
      this._container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ef4444;font-size:.85rem;font-family:monospace">
        vendor/lightweight-charts.standalone.production.js not found</div>`;
      return;
    }

    const D = theme === 'dark';
    const BG  = D ? '#0b0f17' : '#ffffff';
    const TXT = D ? '#94a3b8' : '#374151';
    const GRD = D ? 'rgba(255,255,255,0.03)' : '#f1f5f9';
    const BDR = D ? '#1e293b'  : '#e2e8f0';

    this._chart = LWC.createChart(this._container, {
      layout: {
        background: { type: 'solid', color: BG },
        textColor: TXT,
        fontSize: 11,
        fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
      },
      grid: {
        vertLines: { color: GRD, style: 1 },
        horzLines: { color: GRD, style: 1 },
      },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: '#475569', labelBackgroundColor: '#1e293b' },
        horzLine: { color: '#475569', labelBackgroundColor: '#1e293b' },
      },
      rightPriceScale: {
        borderColor: BDR,
        scaleMargins: { top: 0.08, bottom: 0.22 },
        minimumWidth: 68,
      },
      timeScale: {
        borderColor: BDR,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 5,
        shiftVisibleRangeOnNewBar: true,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    // Volume histogram (bottom 20%)
    this._volSeries = this._chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: '#3b82f622',
    });
    this._chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    this._buildSeries();

    // OHLCV bar update on crosshair move
    this._chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !this._series) return;
      const bar = param.seriesData.get(this._series);
      if (bar) this._updateOhlcBar(bar);
    });

    // Auto-resize
    this._ro = new ResizeObserver(() => {
      if (this._chart && !this._destroyed) {
        const { offsetWidth: w, offsetHeight: h } = this._container;
        if (w > 0 && h > 0) this._chart.resize(w, h);
      }
    });
    this._ro.observe(this._container);
  }

  /* ── Build the main price series for the current type ─────────────── */
  _buildSeries() {
    const LWC = lwcLib();
    if (!LWC || !this._chart) return;

    // Remove old series
    if (this._series) {
      try { this._chart.removeSeries(this._series); } catch (_) {}
      this._series = null;
    }

    const UP   = '#22c55e';
    const DOWN = '#ef4444';

    switch (this._type) {
      case 'line':
        this._series = this._chart.addLineSeries({
          color: '#3b82f6',
          lineWidth: 2,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
          lastValueVisible: true,
          priceLineVisible: true,
          priceLineColor: '#3b82f6',
        });
        break;

      case 'area':
        this._series = this._chart.addAreaSeries({
          lineColor:   '#3b82f6',
          topColor:    'rgba(59,130,246,0.25)',
          bottomColor: 'rgba(59,130,246,0)',
          lineWidth: 2,
          crosshairMarkerVisible: true,
          lastValueVisible: true,
        });
        break;

      case 'baseline':
        this._series = this._chart.addBaselineSeries({
          baseValue: { type: 'price', price: 0 },
          topLineColor:    UP,
          topFillColor1:   'rgba(34,197,94,0.28)',
          topFillColor2:   'rgba(34,197,94,0.05)',
          bottomLineColor:    DOWN,
          bottomFillColor1:   'rgba(239,68,68,0.05)',
          bottomFillColor2:   'rgba(239,68,68,0.28)',
          lastValueVisible: true,
        });
        break;

      case 'bars':
        this._series = this._chart.addBarSeries({
          upColor: UP, downColor: DOWN,
          thinBars: false,
        });
        break;

      case 'candlestick':
      default:
        this._series = this._chart.addCandlestickSeries({
          upColor: UP, downColor: DOWN,
          borderUpColor: UP, borderDownColor: DOWN,
          wickUpColor: UP, wickDownColor: DOWN,
          borderVisible: true,
          wickVisible: true,
        });
        break;
    }

    // Reapply markers after series rebuild
    if (this._markers.length) {
      try { this._series.setMarkers(this._markers); } catch (_) {}
    }
  }

  /* ── Convert bars to the right format for the current series type ─── */
  _barsForType(bars) {
    if (this._type === 'line' || this._type === 'area' || this._type === 'baseline') {
      return bars.map(b => ({ time: b.time, value: b.close }));
    }
    return bars; // candlestick / bars use full OHLC
  }

  /* ── Set chart type and reload current data ─────────────────────────── */
  setType(type) {
    if (!CHART_TYPES.includes(type)) return;
    this._type = type;
    this._buildSeries();
    if (this._bars.length) {
      this._series.setData(this._barsForType(this._bars));
      this._chart.timeScale().fitContent();
    }
  }

  /* ── Set timeframe ─────────────────────────────────────────────────── */
  setTimeframe(tf) {
    if (!TF_SECONDS[tf]) return;
    this._tf    = tf;
    this._tfSec = TF_SECONDS[tf];
    this._lastBar = null;
    this._bars  = [];
    this._markers = [];
    if (this._series) this._series.setData([]);
    if (this._volSeries) this._volSeries.setData([]);
  }

  /* ── Set symbol (clears data) ─────────────────────────────────────── */
  setSymbol(symbol, label) {
    this._symbol  = symbol;
    this._label   = label || symbol;
    this._lastBar = null;
    this._bars    = [];
    this._markers = [];
    if (this._series)    this._series.setData([]);
    if (this._volSeries) this._volSeries.setData([]);
  }

  /* ── Bulk-load bars (replaces existing) ───────────────────────────── */
  setBars(bars) {
    if (!this._series || this._destroyed) return;
    this._bars   = [...bars].sort((a, b) => a.time - b.time);
    this._lastBar = this._bars[this._bars.length - 1] || null;
    this._series.setData(this._barsForType(this._bars));

    // Volume
    const vols = this._bars
      .filter(b => typeof b.volume === 'number')
      .map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? '#22c55e33' : '#ef444433' }));
    if (vols.length) this._volSeries.setData(vols);

    this._chart.timeScale().fitContent();

    // Show latest bar in OHLCV strip
    if (this._lastBar) this._updateOhlcBar(this._lastBar);
  }

  /* ── Add / update a single bar (upsert by time) ─────────────────── */
  addBar(bar) {
    if (!this._series || this._destroyed) return;
    const last = this._bars[this._bars.length - 1];
    if (last && last.time === bar.time) {
      this._bars[this._bars.length - 1] = { ...last, ...bar };
    } else {
      this._bars.push(bar);
    }
    this._lastBar = this._bars[this._bars.length - 1];

    // Series update format depends on type
    const point = (this._type === 'line' || this._type === 'area' || this._type === 'baseline')
      ? { time: bar.time, value: bar.close ?? bar.value }
      : bar;
    this._series.update(point);

    if (typeof bar.volume === 'number') {
      this._volSeries.update({
        time: bar.time, value: bar.volume,
        color: bar.close >= bar.open ? '#22c55e33' : '#ef444433',
      });
    }
    this._updateOhlcBar(bar);
  }

  /* ── Ingest a raw tick → aggregate into current candle ──────────── */
  addTick({ time, price }) {
    if (this._destroyed) return;
    const bar = tickToBar(this._lastBar, price, time, this._tfSec);
    this.addBar(bar);
  }

  /* ── Trade entry marker ──────────────────────────────────────────── */
  addTrade({ time, side, price, label }) {
    if (!this._series || this._destroyed) return;
    const isBuy = side === 'up';
    const marker = {
      time,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color:    isBuy ? '#22c55e' : '#ef4444',
      shape:    isBuy ? 'arrowUp' : 'arrowDown',
      text:     label || (isBuy ? 'BUY' : 'SELL'),
      size: 1,
    };
    this._markers.push(marker);
    this._markers.sort((a, b) => a.time - b.time);
    try { this._series.setMarkers(this._markers); } catch (_) {}
  }

  /* ── Price line (SL/TP) ──────────────────────────────────────────── */
  addPriceLine(price, { color = '#f59e0b', title = '', lineStyle = 2 } = {}) {
    if (!this._series) return null;
    return this._series.createPriceLine({ price, color, title, lineStyle, lineWidth: 1, axisLabelVisible: true });
  }
  removePriceLine(ref) {
    if (this._series && ref) try { this._series.removePriceLine(ref); } catch (_) {}
  }

  /* ── Set baseline price (for baseline chart type) ────────────────── */
  setBaseline(price) {
    if (this._type === 'baseline' && this._series) {
      this._series.applyOptions({ baseValue: { type: 'price', price } });
    }
  }

  scrollToNow()  { if (this._chart && !this._destroyed) this._chart.timeScale().scrollToRealTime(); }
  fitContent()   { if (this._chart && !this._destroyed) this._chart.timeScale().fitContent(); }

  /* ── OHLCV info bar update ───────────────────────────────────────── */
  _updateOhlcBar(bar) {
    if (!this._ohlcEl) {
      this._ohlcEl = document.getElementById('chart-ohlcv');
    }
    if (!this._ohlcEl) return;
    const dec = MARKET_BY_SYMBOL[this._symbol]?.priceDecimals ?? 2;
    const fmt = (n) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(dec) : '—';
    const change = (bar.close && bar.open) ? ((bar.close - bar.open) / bar.open * 100) : 0;
    const up = change >= 0;

    // Handle both OHLC bars and line/value bars
    const o = bar.open  ?? bar.value ?? null;
    const h = bar.high  ?? bar.value ?? null;
    const l = bar.low   ?? bar.value ?? null;
    const c = bar.close ?? bar.value ?? null;

    this._ohlcEl.innerHTML =
      `<span class="ohlcv-item"><span class="ohlcv-label">O</span><span class="ohlcv-value">${fmt(o)}</span></span>` +
      `<span class="ohlcv-item"><span class="ohlcv-label">H</span><span class="ohlcv-value up">${fmt(h)}</span></span>` +
      `<span class="ohlcv-item"><span class="ohlcv-label">L</span><span class="ohlcv-value down">${fmt(l)}</span></span>` +
      `<span class="ohlcv-item"><span class="ohlcv-label">C</span><span class="ohlcv-value">${fmt(c)}</span></span>` +
      (bar.volume ? `<span class="ohlcv-item"><span class="ohlcv-label">V</span><span class="ohlcv-value muted">${bar.volume.toFixed(0)}</span></span>` : '') +
      `<span class="ohlcv-change ${up ? 'up' : 'down'}">${up ? '+' : ''}${change.toFixed(2)}%</span>`;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._chart) { this._chart.remove(); this._chart = null; }
    this._series = null;
    this._volSeries = null;
  }
}

/* ── Module-level singleton ───────────────────────────────────────────── */
let _mainChart = null;

export function getMainChart(container) {
  if (_mainChart && !_mainChart._destroyed) return _mainChart;
  if (!container) container = document.getElementById('main-chart');
  if (!container) return null;
  _mainChart = new ChartView(container, { theme: 'dark' });
  return _mainChart;
}

export function destroyMainChart() {
  if (_mainChart) { _mainChart.destroy(); _mainChart = null; }
}
