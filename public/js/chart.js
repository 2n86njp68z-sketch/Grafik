// TradingView Lightweight Charts (v4) üzerine ince bir katman.
import { fmtChartTime, fmtTick } from './format.js';

const LWC = window.LightweightCharts;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class PriceChart {
  constructor(el, { onClick, onCrosshair } = {}) {
    this.el = el;
    this.intraday = false;
    this.formatter = (v) => String(v);
    this.chart = LWC.createChart(el, {
      autoSize: true,
      layout: { attributionLogo: false, fontFamily: cssVar('--font') || 'system-ui, sans-serif', fontSize: 12 },
      grid: { vertLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: {
        borderVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (t, type) => fmtTick(t, type),
      },
      crosshair: { mode: LWC.CrosshairMode.Magnet, vertLine: { labelVisible: true }, horzLine: { labelVisible: true } },
      localization: {
        locale: 'tr-TR',
        timeFormatter: (t) => fmtChartTime(t, this.intraday),
        priceFormatter: (v) => this.formatter(v),
      },
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    this.area = this.chart.addAreaSeries({
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      priceFormat: { type: 'custom', minMove: 0.000001, formatter: (v) => this.formatter(v) },
    });
    this.sel = this.chart.addLineSeries({
      lineWidth: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'custom', minMove: 0.000001, formatter: (v) => this.formatter(v) },
    });
    this.baseLine = null;
    this.data = [];
    this.applyTheme();

    // Tıklamaları doğrudan dinliyoruz: kütüphanenin subscribeClick'i art arda hızlı
    // tıklamaları çift tık sayıp yutabiliyor. Sürükleme (kaydırma) tıklama sayılmaz.
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('click', (e) => {
      if (!onClick || !this.data.length) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const x = e.clientX - el.getBoundingClientRect().left;
      const ts = this.chart.timeScale();
      if (x < 0 || x > ts.width()) return;
      const logical = ts.coordinateToLogical(x);
      if (logical == null) return;
      const i = Math.max(0, Math.min(this.data.length - 1, Math.round(logical)));
      onClick(this.data[i].time);
    });
    this.chart.subscribeCrosshairMove((p) => {
      if (!onCrosshair) return;
      if (p.time == null || !p.point) return onCrosshair(null);
      const d = p.seriesData.get(this.area);
      onCrosshair(d ? { time: p.time, value: d.value } : null);
    });
  }

  applyTheme() {
    this.colors = {
      up: cssVar('--up'), down: cssVar('--down'), accent: cssVar('--accent'),
      surface: cssVar('--surface'), text: cssVar('--text-muted'), grid: cssVar('--grid'), base: cssVar('--axis'),
    };
    const c = this.colors;
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: c.surface }, textColor: c.text },
      grid: { horzLines: { color: c.grid } },
      crosshair: {
        vertLine: { color: c.base, labelBackgroundColor: c.text },
        horzLine: { color: c.base, labelBackgroundColor: c.text },
      },
    });
    this.sel.applyOptions({ color: c.accent });
    this.area.applyOptions({ crosshairMarkerBorderColor: c.surface });
    if (this.lastView) this.setView(this.lastView, true);
  }

  /**
   * view: {
   *   points: [{time, value}], intraday, up, log, formatter,
   *   baseValue (kesikli çizgi; null = yok), selection: [{time, value}] | null,
   *   markers: [{time, text}]
   * }
   */
  setView(view, keepRange = false) {
    this.lastView = view;
    this.intraday = !!view.intraday;
    this.formatter = view.formatter;
    const c = this.colors;
    const color = view.up ? c.up : c.down;
    this.area.applyOptions({ lineColor: color, topColor: withAlpha(color, 0.22), bottomColor: withAlpha(color, 0.0) });
    this.chart.applyOptions({ timeScale: { timeVisible: this.intraday, secondsVisible: false } });
    this.chart.priceScale('right').applyOptions({ mode: view.log ? LWC.PriceScaleMode.Logarithmic : LWC.PriceScaleMode.Normal });

    const r = keepRange ? this.chart.timeScale().getVisibleLogicalRange() : null;
    const range = r ? { from: r.from, to: r.to } : null;
    this.data = view.points;
    this.area.setData(view.points);
    // Seçim serisi her zaman tüm zaman eksenini kapsar (seçim dışı = boşluk noktası).
    // Aksi halde serinin son noktası değiştiğinde kütüphane görünür aralığı kaydırıyor.
    const sel = view.selection;
    if (sel && sel.length) {
      const t0 = sel[0].time, t1 = sel[sel.length - 1].time;
      this.sel.setData(view.points.map((p) => (p.time >= t0 && p.time <= t1 ? p : { time: p.time })));
    } else {
      this.sel.setData(view.points.map((p) => ({ time: p.time })));
    }
    this.area.setMarkers((view.markers || []).map((m) => ({
      time: m.time, position: 'aboveBar', shape: 'circle', color: c.accent, text: m.text, size: 1,
    })));

    if (this.baseLine) { this.area.removePriceLine(this.baseLine); this.baseLine = null; }
    if (view.baseValue != null) {
      this.baseLine = this.area.createPriceLine({
        price: view.baseValue, color: c.base, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
        axisLabelVisible: false, title: view.baseTitle || '',
      });
    }
    if (range && keepRange) this.chart.timeScale().setVisibleLogicalRange(range);
    else this.chart.timeScale().fitContent();
  }

  /** Grafik zamanına en yakın (öncesindeki) noktanın indeksi. */
  indexAtTime(time) {
    let lo = 0, hi = this.data.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.data[mid].time <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
}
