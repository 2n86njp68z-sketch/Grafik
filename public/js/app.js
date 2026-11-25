import {
  makeDailySeries, makeIntradaySeries, makeRateLookup, convertSeries, convertValue, conversionPlan,
  normalizeCurrency, RANGES, rangeStartKey, baseIndexForKey, endIndexForKey, sliceSeries,
  changeBetweenDates, changeBetweenIndices, daysBetween, annualized, lastIndexAtOrBefore, keyToSec,
} from './calc.js';
import * as F from './format.js';
import { api } from './api.js';
import { PriceChart } from './chart.js';
import qrcode from '../vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem('grafik:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('grafik:' + k, JSON.stringify(v)); } catch { /* gizli mod vb. */ } },
};

const DEFAULT_SYMBOL = 'XU100.IS';
const TYPE_LABEL = { stock: 'Hisse', index: 'Endeks', etf: 'ETF', commodity: 'Emtia', fx: 'Döviz', crypto: 'Kripto' };
const QT_TYPE = { EQUITY: 'stock', ETF: 'etf', INDEX: 'index', FUTURE: 'commodity', CURRENCY: 'fx', CRYPTOCURRENCY: 'crypto', MUTUALFUND: 'etf' };
const EXCHANGE_LABEL = { Istanbul: 'Borsa İstanbul', IST: 'Borsa İstanbul', CCY: 'Döviz', CCC: 'Kripto' };

const state = {
  catalog: { groups: [], items: [] },
  bySym: new Map(),
  item: null,
  range: '1Y',
  lastRange: '1Y',
  custom: null,
  mode: store.get('mode', 'price'),
  cur: store.get('cur', 'TRY'),
  tr: store.get('tr', true),
  log: store.get('log', false),
  measure: { kind: 'period' },
  picking: 0,
  pickX0: null,
  group: store.get('group', 'all'),
  favs: store.get('favs', []),
  query: '',
  yahooResults: [],
  view: null,
};

let D = null;          // seçili enstrümanın verisi
let chart = null;
let loadToken = 0;
let renderToken = 0;

// ---------------------------------------------------------------------------
// Veri katmanı
// ---------------------------------------------------------------------------

async function loadSymbol(sym, given) {
  const token = ++loadToken;
  const item = state.bySym.get(sym) || given || { s: sym, n: sym, g: [] };
  state.item = item;
  state.measure = { kind: 'period' };
  state.picking = 0;
  state.pickX0 = null;
  if (state.range === 'CUSTOM') state.range = state.lastRange;
  store.set('last', sym);
  writeHash();
  markActiveRow();
  renderHeaderPlaceholder(item);
  updatePickUI();
  setLoading(true);
  hideMsg();
  try {
    const baseSym = item.base || sym;
    const daily = await api.daily(baseSym);
    if (token !== loadToken) return;
    const norm = normalizeCurrency(daily.currency);
    const fxSyms = [...new Set([...conversionPlan(norm.cur, 'TRY'), ...conversionPlan(norm.cur, 'USD')].map((p) => p.fx))];
    const fxRes = await Promise.allSettled(fxSyms.map((s) => api.daily(s)));
    if (token !== loadToken) return;
    const fxDaily = {};
    fxSyms.forEach((s, i) => { if (fxRes[i].status === 'fulfilled') fxDaily[s] = makeDailySeries(fxRes[i].value, false); });
    D = {
      sym,
      item: {
        ...item,
        n: item.n && item.n !== sym ? item.n : daily.name,
        t: item.t || QT_TYPE[daily.type] || 'stock',
      },
      daily,
      native: norm.cur,
      scale: norm.scale * (item.scale || 1),
      fxDaily,
      fxIntra: {},
      intra: {},
      memo: new Map(),
      loadedAt: Date.now(),
    };
    await render();
  } catch (e) {
    if (token !== loadToken) return;
    D = null;
    state.view = null;
    setLoading(false);
    showError(e, () => loadSymbol(sym, given));
  }
}

function hasDivs() {
  return !!(D && D.daily.divs.length);
}

function useAdj() {
  return state.tr && hasDivs();
}

function effectiveCur() {
  if (!D) return state.cur;
  if (D.item.lockCur) return D.item.lockCur;
  if (!convAvailable(state.cur)) return D.native === 'TRY' || D.native === 'USD' ? D.native : state.cur;
  return state.cur;
}

function convAvailable(cur) {
  return conversionPlan(D.native, cur).every((p) => D.fxDaily[p.fx]);
}

function planSteps(cur, intraRange) {
  const steps = [];
  for (const p of conversionPlan(D.native, cur)) {
    const daily = D.fxDaily[p.fx];
    if (!daily) return null;
    const intra = intraRange ? D.fxIntra[`${p.fx}|${intraRange}`] : null;
    steps.push({ op: p.op, rate: intraRange ? makeRateLookup(intra, daily) : makeRateLookup(daily) });
  }
  return steps;
}

function memo(key, fn) {
  if (!D.memo.has(key)) D.memo.set(key, fn());
  return D.memo.get(key);
}

function fullSeries(cur, adj) {
  return memo(`d|${cur}|${adj}`, () => {
    const steps = planSteps(cur, null);
    if (!steps) return null;
    return convertSeries(makeDailySeries(D.daily, adj, D.scale), steps);
  });
}

function intradaySeries(cur, adj, range) {
  return memo(`i|${range}|${cur}|${adj}`, () => {
    const intra = D.intra[range];
    const steps = planSteps(cur, range);
    if (!intra || !steps) return null;
    return convertSeries(makeIntradaySeries(intra, adj, D.scale), steps);
  });
}

function intradayBase(cur, adj, range) {
  const b = D.intra[range]?.base;
  if (!b) return null;
  const raw = (adj ? b.a : b.c) * D.scale;
  if (!b.k) return { v: raw, k: null };
  const v = convertValue(raw, keyToSec(b.k), b.k, planSteps(cur, null) || []);
  return v == null ? null : { v, k: b.k };
}

async function ensureIntraday(range) {
  if (D.intra[range]) return;
  const d = D;
  const baseSym = d.item.base || d.sym;
  const fxSyms = Object.keys(d.fxDaily);
  const [main, ...fx] = await Promise.allSettled([
    api.intraday(baseSym, range), ...fxSyms.map((s) => api.intraday(s, range)),
  ]);
  if (main.status === 'rejected') throw main.reason;
  if (!main.value.t.length) throw new Error('Bu dönem için gün içi veri yok');
  d.intra[range] = main.value;
  fxSyms.forEach((s, i) => {
    if (fx[i].status === 'fulfilled' && fx[i].value.t.length) d.fxIntra[`${s}|${range}`] = makeIntradaySeries(fx[i].value, false);
  });
}

/** Seçili dönemin serisi + baz değeri. */
function buildView(cur, adj) {
  const intraRange = RANGES[state.range]?.intraday;
  if (intraRange) {
    const s = intradaySeries(cur, adj, intraRange);
    if (!s || !s.v.length) return null;
    const base = intradayBase(cur, adj, intraRange);
    return {
      s, intraday: true, base: base ? base.v : s.v[0], baseKey: base ? base.k : s.k[0],
      baseIsPrevClose: !!base, truncated: false,
    };
  }
  const full = fullSeries(cur, adj);
  if (!full || !full.v.length) return null;
  let i0 = 0;
  let i1 = full.v.length - 1;
  let wantFrom = D.daily.k[0];
  if (state.range === 'CUSTOM' && state.custom) {
    wantFrom = state.custom.from;
    i0 = baseIndexForKey(full.k, state.custom.from);
    i1 = endIndexForKey(full.k, state.custom.to);
    if (i1 < i0) i1 = i0;
  } else if (state.range !== 'MAX') {
    wantFrom = rangeStartKey(state.range, full.k[i1]);
    i0 = baseIndexForKey(full.k, wantFrom);
  }
  const s = sliceSeries(full, i0, i1);
  return {
    s, intraday: false, base: s.v[0], baseKey: s.k[0], baseIsPrevClose: false,
    truncated: isTruncated(full, wantFrom),
  };
}

/** Aralık ölçümü (tarih kutusu). */
function computeMeasure(cur, adj) {
  const m = state.measure;
  if (m.kind === 'dates') {
    const full = fullSeries(cur, adj);
    if (!full) return null;
    const r = changeBetweenDates(full, m.from, m.to);
    if (!r) return null;
    return {
      ...r, label0: F.fmtDateKey(r.k0), label1: F.fmtDateKey(r.k1), days: daysBetween(r.k0, r.k1),
      closes: true, truncated: isTruncated(full, m.from),
    };
  }
  const view = buildView(cur, adj);
  if (!view || !view.s.v.length) return null;
  const s = view.s;
  if (m.kind === 'points') {
    let i0 = lastIndexAtOrBefore(s.x, m.x0);
    const i1 = lastIndexAtOrBefore(s.x, m.x1);
    if (i0 < 0) i0 = 0;
    if (i1 <= i0) return null;
    const r = changeBetweenIndices(s, i0, i1);
    return {
      ...r, label0: F.fmtChartTime(s.time[i0], view.intraday), label1: F.fmtChartTime(s.time[i1], view.intraday),
      days: daysBetween(r.k0, r.k1),
    };
  }
  // dönem: baz -> son
  const last = s.v.length - 1;
  const v0 = view.base;
  const v1 = s.v[last];
  const label0 = view.baseIsPrevClose ? `${F.fmtDateKey(view.baseKey)} kapanış` : F.fmtDateKey(view.baseKey);
  const label1 = view.intraday ? F.fmtChartTime(s.time[last], true) : F.fmtDateKey(s.k[last]);
  return {
    v0, v1, pct: v1 / v0 - 1, k0: view.baseKey || s.k[0], k1: s.k[last], x0: null, x1: s.x[last],
    label0, label1, days: view.baseKey ? daysBetween(view.baseKey, s.k[last]) : 0,
    closes: !view.intraday, truncated: view.truncated,
  };
}

/** Kur verisi eksikliği yüzünden istenen başlangıçtan daha geç mi başlıyor? */
function isTruncated(full, wantFrom) {
  return !!(full.dropped > 0 && full.k.length && wantFrom && wantFrom < full.k[0] && D.daily.k[0] < full.k[0]);
}

// ---------------------------------------------------------------------------
// Çizim
// ---------------------------------------------------------------------------

function minDec() {
  return D && (D.item.t === 'fx' || D.daily.currency === 'TRY' && D.item.s === 'TRY=X') ? 4 : 2;
}

async function render(keepRange = false) {
  if (!D) return;
  const token = ++renderToken;
  const d = D;
  const intraRange = RANGES[state.range]?.intraday;
  if (intraRange && !d.intra[intraRange]) {
    setLoading(true);
    try {
      await ensureIntraday(intraRange);
    } catch (e) {
      if (token !== renderToken || d !== D) return;
      setLoading(false);
      if (/gün içi veri yok/.test(e?.message || '')) {
        // Bazı enstrümanların Yahoo'da gün içi verisi hiç yok: hata değil, bilgi göster
        state.view = null;
        syncControls();
        renderHeader();
        chart.setView({ points: [], formatter: (v) => String(v), up: true });
        renderLegend(null);
        renderMeasure(null, effectiveCur(), useAdj());
        showMsg('Bu enstrüman için gün içi (1G / 1H) veri yok. Daha uzun bir dönem seçin.');
        return;
      }
      showError(e, () => render());
      return;
    }
  }
  if (token !== renderToken || d !== D) return;
  setLoading(false);
  hideMsg();

  const cur = effectiveCur();
  const adj = useAdj();
  const view = buildView(cur, adj);
  state.view = view;
  syncControls();
  renderHeader();
  if (!view) {
    showMsg('Bu dönem için veri yok.');
    chart.setView({ points: [], formatter: (v) => String(v), up: true });
    renderMeasure(null, cur, adj);
    renderNotes(null, cur, false);
    return;
  }
  const pct = state.mode === 'pct';
  const s = view.s;
  const points = s.time.map((t, i) => ({ time: t, value: pct ? s.v[i] / view.base : s.v[i] }));
  const up = s.v[s.v.length - 1] >= view.base;
  const formatter = pct ? (r) => F.fmtPctAxis(r - 1) : (v) => F.fmtPrice(v, cur, minDec());

  const m = computeMeasure(cur, adj);
  const { selection, markers } = measureOverlay(m, view, points);
  chart.setView({
    points, intraday: view.intraday, up, log: state.log, formatter,
    baseValue: pct ? 1 : view.base,
    baseTitle: view.baseIsPrevClose ? 'Önceki kapanış' : '',
    selection, markers,
  }, keepRange);
  renderLegend(null);
  renderMeasure(m, cur, adj);
  const earliest = m?.k0 && m.k0 < s.k[0] ? m.k0 : s.k[0];
  renderNotes(view, cur, !!(view.truncated || m?.truncated), earliest);
}

function measureOverlay(m, view, points) {
  const markers = [];
  let selection = null;
  const s = view.s;
  if (state.picking === 2 && state.pickX0 != null) {
    const i = lastIndexAtOrBefore(s.x, state.pickX0);
    if (i >= 0) markers.push({ time: points[i].time, text: 'Başlangıç' });
    return { selection, markers };
  }
  if (!m || state.measure.kind === 'period') return { selection, markers };
  const x0 = state.measure.kind === 'dates' ? keyToSec(m.k0) : m.x0;
  const x1 = state.measure.kind === 'dates' ? keyToSec(m.k1) : m.x1;
  if (view.intraday && state.measure.kind === 'dates') return { selection, markers };
  const i0 = lastIndexAtOrBefore(s.x, x0);
  const i1 = lastIndexAtOrBefore(s.x, x1);
  if (i0 < 0 || i1 <= i0 || s.x[i0] !== x0) return { selection, markers };
  const whole = i0 === 0 && i1 === s.x.length - 1;
  if (!whole) selection = points.slice(i0, i1 + 1);
  markers.push({ time: points[i0].time, text: 'Başlangıç' }, { time: points[i1].time, text: 'Bitiş' });
  return { selection, markers };
}

function renderLegend(hover) {
  const el = $('legend');
  el.textContent = '';
  const v = state.view;
  if (!v || !v.s.v.length) return;
  let i = v.s.v.length - 1;
  if (hover) {
    i = chart.indexAtTime(hover.time);
    if (i < 0) i = 0;
  }
  const cur = effectiveCur();
  const val = v.s.v[i];
  const p = val / v.base - 1;
  const pctMode = state.mode === 'pct';
  const a = document.createElement('span');
  a.className = 'lg-val';
  a.textContent = pctMode ? F.fmtPct(p) : F.fmtPrice(val, cur, minDec());
  const b = document.createElement('span');
  b.className = 'lg-pct ' + (pctMode ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat');
  b.textContent = pctMode ? F.fmtPrice(val, cur, minDec()) : F.fmtPct(p);
  const c = document.createElement('span');
  c.className = 'lg-date';
  c.textContent = F.fmtChartTime(v.s.time[i], v.intraday);
  el.append(a, b, c);
}

function renderHeaderPlaceholder(item) {
  $('symName').textContent = item.n || item.s;
  $('symSub').textContent = F.displaySymbol(item.s);
  $('lastPrice').textContent = '';
  $('dayChange').textContent = '';
  document.title = `${F.displaySymbol(item.s)} — Grafik`;
  renderFav();
}

function renderHeader() {
  const it = D.item;
  $('symName').textContent = it.n;
  const ex = EXCHANGE_LABEL[D.daily.exchange] || D.daily.exchange || '';
  const curNote = D.native === 'TRY' ? 'TL' : D.native;
  $('symSub').textContent = [F.displaySymbol(it.s), ex, TYPE_LABEL[it.t] || '', curNote].filter(Boolean).join(' · ');
  const cur = effectiveCur();
  const full = fullSeries(cur, false);
  if (full && full.v.length) {
    const n = full.v.length;
    const last = full.v[n - 1];
    $('lastPrice').textContent = F.fmtPrice(last, cur, minDec());
    const dc = $('dayChange');
    if (n > 1) {
      const p = last / full.v[n - 2] - 1;
      dc.textContent = `${p > 0 ? '▲' : p < 0 ? '▼' : ''} ${F.fmtPct(p)} · ${F.fmtDateKey(full.k[n - 1])}`;
      dc.className = 'delta ' + (p > 0 ? 'up' : p < 0 ? 'down' : 'flat');
    } else dc.textContent = '';
  }
  document.title = `${F.displaySymbol(it.s)} ${$('lastPrice').textContent} — Grafik`;
  renderFav();
}

function renderMeasure(m, cur, adj) {
  const hero = $('resPct');
  const detail = $('resDetail');
  const extra = $('resExtra');
  detail.textContent = '';
  extra.textContent = '';
  $('resetMeasure').hidden = state.measure.kind === 'period';
  if (D) {
    $('fromDate').min = $('toDate').min = D.daily.k[0];
    $('fromDate').max = $('toDate').max = D.daily.k[D.daily.k.length - 1];
  }
  if (!m) {
    hero.textContent = '—';
    hero.className = 'hero flat';
    detail.textContent = 'Seçilen aralıkta veri yok.';
    return;
  }
  const typed = state.measure.kind === 'dates';
  $('fromDate').value = (typed ? state.measure.from : m.k0) || '';
  $('toDate').value = (typed ? state.measure.to : m.k1) || '';
  hero.className = 'hero ' + (m.pct > 0 ? 'up' : m.pct < 0 ? 'down' : 'flat');
  hero.textContent = '';
  const arrow = document.createElement('span');
  arrow.className = 'arrow-icon';
  arrow.textContent = m.pct > 0 ? '▲' : m.pct < 0 ? '▼' : '';
  hero.append(arrow, document.createTextNode(F.fmtPct(m.pct)));

  const md = minDec();
  detail.append(
    document.createTextNode(`${F.fmtPrice(m.v0, cur, md)} → ${F.fmtPrice(m.v1, cur, md)}  `),
    span('muted', `${m.label0} → ${m.label1}${m.closes ? ' (kapanış)' : ''}`),
  );

  const items = [];
  if (m.days >= 1) items.push(['Süre', F.fmtDuration(m.k0, m.k1, m.days)]);
  const ann = annualized(m.pct, m.days);
  if (ann != null) items.push(['Yıllık ortalama', F.fmtPct(ann)]);
  const other = cur === 'TRY' ? 'USD' : 'TRY';
  if (!D.item.lockCur && convAvailable(other)) {
    const mo = safe(() => computeMeasure(other, adj));
    if (mo) {
      // Kur verisi eksikliğinden farklı bir tarihten başlıyorsa belirt
      const note = mo.k0 && m.k0 && mo.k0 !== m.k0 && state.measure.kind !== 'points' ? ` (başlangıç ${F.fmtDateKeyNumeric(mo.k0)})` : '';
      items.push([`${F.CUR_LABEL[other]} bazında${note}`, F.fmtPct(mo.pct)]);
    }
  }
  if (hasDivs()) {
    const ma = safe(() => computeMeasure(cur, !adj));
    if (ma && Math.abs(ma.pct - m.pct) > 5e-5) items.push([adj ? 'Temettüsüz (sadece fiyat)' : 'Temettü dahil', F.fmtPct(ma.pct)]);
  }
  for (const [k, v] of items) {
    const el = document.createElement('span');
    el.append(span('muted', k + ': '), Object.assign(document.createElement('b'), { textContent: v }));
    extra.append(el);
  }
}

function renderNotes(view, cur, truncated, earliest) {
  const el = $('notes');
  el.textContent = '';
  if (!D) return;
  const add = (...nodes) => { const p = document.createElement('p'); p.append(...nodes); el.append(p); };
  const it = D.item;
  if (it.note) add(`ℹ️ ${it.note}.`);
  if (it.tr) {
    const tr = state.bySym.get(it.tr);
    const btn = document.createElement('button');
    btn.className = 'linklike';
    btn.textContent = tr ? tr.n : it.tr;
    btn.onclick = () => selectSymbol(it.tr);
    add('ℹ️ Bu bir fiyat endeksidir, temettüleri içermez. Toplam getiri için: ', btn);
  } else if (it.t === 'index' && D.native === 'TRY') {
    add('ℹ️ BIST endeksleri fiyat endeksidir (temettüler hariç).');
  }
  if (it.lockCur) add('ℹ️ Bu enstrüman zaten bir kur olduğu için yalnızca TL cinsinden gösterilir.');
  {
    // Fiyat uzun süredir hiç değişmiyorsa (işlem durdurulmuş olabilir) uyar
    const c = D.daily.c;
    let i = c.length - 1;
    while (i > 0 && c[i - 1] === c[i]) i--;
    if (c.length - 1 - i >= 20) add(`⚠️ Fiyat ${F.fmtDateKeyNumeric(D.daily.k[i])} tarihinden beri hiç değişmiyor; bu enstrüman işleme kapalı olabilir.`);
  }
  if (state.tr && !hasDivs() && (it.t === 'stock' || it.t === 'etf')) add('ℹ️ Bu enstrüman için temettü kaydı bulunmuyor; grafik fiyat getirisini gösterir.');
  if (useAdj()) {
    const src = D.daily.src === 'isyatirim' ? ' (temettü ve sermaye artırımı kayıtları: İş Yatırım)' : '';
    add(`✓ Toplam getiri: ${D.daily.divs.length} temettü ödemesi, ödendiği gün yeniden yatırılmış kabul edildi${src}.`);
  }
  if (cur !== D.native && !it.lockCur) {
    const fxNames = conversionPlan(D.native, cur).map((p) => 'USD/' + p.fx.replace('=X', ''));
    const conv = `${F.CUR_LABEL[cur] || cur} karşılığı, her günün ${fxNames.join(' ve ')} kuru ile hesaplanır.`;
    add(`↔ ${conv}`);
    const full = fullSeries(cur, useAdj());
    if (truncated && full) {
      add(`⚠️ Kur verisi ${F.fmtDateKeyNumeric(full.k[0])} tarihinden itibaren mevcut; daha eski fiyatlar ${F.CUR_LABEL[cur] || cur} cinsinden gösterilemiyor.`);
    }
  }
  if (!convAvailable(state.cur) && !it.lockCur) add(`⚠️ Kur verisi alınamadığı için ${D.native} cinsinden gösteriliyor.`);
  // Düzeltme görüntülenen dönemi etkiliyorsa not düş; çoksa (eski BIST verisi) tek satırda özetle
  const fixes = (D.daily.fixes || []).filter((f) => earliest && (f.to || f.k) >= earliest); // dönem düzeltmesi görünen aralıkla kesişiyorsa
  if (fixes.length > 3) {
    const last = fixes[fixes.length - 1];
    add(`🔧 Bu dönemde Yahoo verisindeki ${fixes.length} hata düzeltildi (fiyata yansıtılmamış bedelsiz/bölünmeler, hatalı fiyatlar). En sonuncusu: ${F.fmtDateKeyNumeric(last.k)}.`);
  } else {
    for (const f of fixes) add(fixNote(f));
  }
}

// İş Yatırım olay türleri (SHT_KODU)
const CA_NAMES = {
  '01': 'Bedelli sermaye artırımı', '02': 'Bedelsiz sermaye artırımı', '03': 'Bedelli ve bedelsiz sermaye artırımı',
  '05': 'Bedelsiz sermaye artırımı ve temettü', '06': 'Bedelli sermaye artırımı ve temettü', '07': 'Sermaye artırımı (rüçhan hakkı kısıtlanarak)',
  '08': 'Bedelli, bedelsiz sermaye artırımı ve temettü', '09': 'Bedelsiz sermaye artırımı (temettüden)', '78': 'Sermaye azaltımı',
  '89': 'Bedelsiz pay ayrılması', '90': 'Birleşme', '98': 'İkincil halka arz',
};

function fixNote(f) {
  const day = F.fmtDateKeyNumeric(f.k);
  const shares = (r) => F.fmtNumber(r, Number.isInteger(r) ? 0 : 2);
  switch (f.type) {
    case 'ca':
      return `🔧 ${day}: ${CA_NAMES[f.t] || 'Sermaye değişikliği'}; önceki fiyatlar resmi ayar oranıyla (×${F.fmtNumber(f.factor, f.factor < 0.1 ? 4 : 3)}) düzeltildi (kaynak: İş Yatırım).`;
    case 'split':
      return `🔧 ${day}: Bölünme / bedelsiz (1 pay → ${shares(f.ratio)} pay) Yahoo verisinde fiyata yansıtılmamıştı; önceki fiyatlar buna göre düzeltildi.`;
    case 'corp':
      return f.factor < 1
        ? `🔧 ${day}: Fiyattaki ani ${F.fmtPct(f.factor - 1)} değişim bedelsiz / bölünme kaynaklı (Borsa İstanbul'da günlük sınır %10); önceki fiyatlar buna göre düzeltildi.`
        : `🔧 ${day}: Fiyattaki ani ${F.fmtPct(f.factor - 1)} değişim sermaye azaltımı / pay birleştirme ya da veri hatası (Borsa İstanbul'da günlük sınır %10); önceki fiyatlar buna göre düzeltildi.`;
    case 'spike':
      return `🔧 ${day}: Ertesi gün geri dönen hatalı fiyat düzeltildi.`;
    case 'phantom':
      return `🔧 ${day}: Yahoo'nun uyguladığı bölünme / bedelsiz (1 pay → ${shares(f.ratio)} pay) resmi kayıtlarda yok; geri alındı.`;
    case 'frozen':
      return `🔧 ${day} – ${F.fmtDateKeyNumeric(f.to)}: Yahoo bu dönemde fiyatı güncellememişti; gerçek işlem fiyatları İş Yatırım'dan alındı.`;
    case 'rescale':
      return `🔧 Veri düzeltmesi: ${day} tarihindeki hatalı fiyat sıçraması (×${F.fmtNumber(f.factor, f.factor >= 10 ? 0 : 2)}) düzeltildi.`;
    case 'div-skip':
      return `🔧 ${day} tarihli hatalı görünen temettü kaydı hesaba katılmadı.`;
    default:
      return `🔧 ${day}: Veri düzeltmesi yapıldı.`;
  }
}

const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
const safe = (fn) => { try { return fn(); } catch { return null; } };

// ---------------------------------------------------------------------------
// Durum mesajları
// ---------------------------------------------------------------------------

function setLoading(on) {
  $('chartCard').classList.toggle('loading', on);
  if (on && !state.view) showMsg('Yükleniyor…');
}

function showMsg(text) {
  const el = $('chartMsg');
  el.textContent = text;
  el.hidden = false;
}

function hideMsg() {
  $('chartMsg').hidden = true;
}

function showError(e, retry) {
  const el = $('chartMsg');
  el.textContent = '';
  const box = document.createElement('div');
  box.className = 'err';
  const b = document.createElement('b');
  b.textContent = 'Veri alınamadı';
  const p = document.createElement('div');
  p.textContent = e?.message || String(e);
  box.append(b, p);
  if (retry) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.marginTop = '10px';
    btn.textContent = 'Tekrar dene';
    btn.onclick = retry;
    box.append(btn);
  }
  el.append(box);
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Kontroller
// ---------------------------------------------------------------------------

function buildRangeButtons() {
  const seg = $('rangeSeg');
  for (const [key, r] of Object.entries(RANGES)) {
    const b = document.createElement('button');
    b.dataset.v = key;
    b.textContent = r.label;
    seg.append(b);
  }
}

function syncControls() {
  for (const b of $('rangeSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.range));
  for (const b of $('modeSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.mode));
  const cur = effectiveCur();
  for (const b of $('curSeg').children) {
    b.setAttribute('aria-pressed', String(b.dataset.v === cur));
    b.disabled = !!(D && (D.item.lockCur || !convAvailable(b.dataset.v)));
  }
  const trOk = hasDivs();
  $('trChk').checked = state.tr;
  $('trChk').disabled = !trOk;
  $('trWrap').classList.toggle('disabled', !trOk);
  $('trWrap').title = trOk
    ? 'Temettüler ödendiği gün yeniden yatırılmış gibi hesaplanır (toplam getiri)'
    : 'Bu enstrümanda temettü yok (endeks, emtia, kur vb.)';
  $('logChk').checked = state.log;
}

function setRange(r) {
  if (state.range !== 'CUSTOM') state.lastRange = state.range;
  state.range = r;
  if (r !== 'CUSTOM') { state.lastRange = r; store.set('range', r); }
  state.measure = { kind: 'period' };
  cancelPick(false);
  writeHash();
  render();
}

function setMeasureDates(from, to) {
  if (!from || !to || !D) return;
  if (from > to) [from, to] = [to, from];
  state.measure = { kind: 'dates', from, to };
  const v = state.view;
  const inWindow = v && !v.intraday && from >= v.s.k[0] && to <= v.s.k[v.s.k.length - 1];
  if (!inWindow) {
    if (state.range !== 'CUSTOM') state.lastRange = state.range;
    state.range = 'CUSTOM';
    state.custom = { from, to };
  }
  render(inWindow);
}

function resetMeasure() {
  state.measure = { kind: 'period' };
  if (state.range === 'CUSTOM') state.range = state.lastRange;
  render();
}

function updatePickUI() {
  const hint = $('pickHint');
  $('pickBtn').classList.toggle('active', state.picking > 0);
  $('chartCard').classList.toggle('picking', state.picking > 0);
  hint.hidden = !state.picking;
  hint.textContent = state.picking === 1 ? '1/2 · Başlangıç noktasına tıklayın' : '2/2 · Bitiş noktasına tıklayın';
}

function cancelPick(rerender = true) {
  if (!state.picking) return;
  state.picking = 0;
  state.pickX0 = null;
  updatePickUI();
  if (rerender) render(true);
}

function onChartClick(time) {
  if (!state.picking || !state.view) return;
  const s = state.view.s;
  const i = chart.indexAtTime(time);
  if (i < 0) return;
  if (state.picking === 1) {
    state.pickX0 = s.x[i];
    state.picking = 2;
    updatePickUI();
    render(true);
    return;
  }
  let i0 = lastIndexAtOrBefore(s.x, state.pickX0);
  let i1 = i;
  if (i1 < i0) [i0, i1] = [i1, i0];
  if (i0 === i1) return;
  state.picking = 0;
  state.pickX0 = null;
  updatePickUI();
  state.measure = state.view.intraday
    ? { kind: 'points', x0: s.x[i0], x1: s.x[i1] }
    : { kind: 'dates', from: s.k[i0], to: s.k[i1] };
  render(true);
}

function bindControls() {
  $('rangeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setRange(b.dataset.v);
  });
  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.mode = b.dataset.v;
    store.set('mode', state.mode);
    render(true);
  });
  $('curSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    state.cur = b.dataset.v;
    store.set('cur', state.cur);
    render(true);
  });
  $('trChk').addEventListener('change', (e) => {
    state.tr = e.target.checked;
    store.set('tr', state.tr);
    render(true);
  });
  $('logChk').addEventListener('change', (e) => {
    state.log = e.target.checked;
    store.set('log', state.log);
    render(true);
  });
  const onDate = () => setMeasureDates($('fromDate').value, $('toDate').value);
  $('fromDate').addEventListener('change', onDate);
  $('toDate').addEventListener('change', onDate);
  $('pickBtn').addEventListener('click', () => {
    if (state.picking) return cancelPick();
    state.picking = 1;
    state.pickX0 = null;
    updatePickUI();
  });
  $('resetMeasure').addEventListener('click', resetMeasure);
  $('favBtn').addEventListener('click', toggleFav);
  $('themeBtn').addEventListener('click', toggleTheme);
  $('menuBtn').addEventListener('click', () => document.body.classList.add('drawer-open'));
  $('closeSide').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { cancelPick(); closeDrawer(); }
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); document.body.classList.add('drawer-open'); $('search').focus(); }
  });
  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (h.r && h.r !== state.range && RANGES[h.r]) { state.range = h.r; state.measure = { kind: 'period' }; }
    if (h.s && h.s !== D?.sym && h.s !== state.item?.s) loadSymbol(h.s);
    else render();
  });
}

function closeDrawer() {
  document.body.classList.remove('drawer-open');
}

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

function applyStoredTheme() {
  const t = store.get('theme', null);
  if (t) document.documentElement.dataset.theme = t;
}

function currentThemeIsDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function toggleTheme() {
  const next = currentThemeIsDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  chart.applyTheme();
}

// ---------------------------------------------------------------------------
// Liste, arama, favoriler
// ---------------------------------------------------------------------------

function indexCatalog() {
  state.bySym = new Map(state.catalog.items.map((it) => [it.s, it]));
  state.catalog.items.forEach((it, i) => {
    it._sym = F.normalizeText(F.displaySymbol(it.s));
    it._name = F.normalizeText(it.n);
    it._i = i; // katalog sırası (ETF'ler fon büyüklüğüne göre sıralı)
  });
}

function renderChips() {
  const el = $('groupChips');
  el.textContent = '';
  const chips = [{ id: 'all', short: 'Tümü' }, { id: 'fav', short: '★ Favoriler' }, ...state.catalog.groups];
  if (!chips.some((c) => c.id === state.group)) state.group = 'all';
  for (const g of chips) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.setAttribute('role', 'tab');
    b.dataset.g = g.id;
    b.textContent = g.short;
    b.setAttribute('aria-selected', String(g.id === state.group));
    el.append(b);
  }
  el.onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.group = b.dataset.g;
    store.set('group', state.group);
    for (const c of el.children) c.setAttribute('aria-selected', String(c === b));
    renderList();
    $('list').scrollTop = 0;
  };
}

function groupBadge(it) {
  if (it._yahoo) return it.ex || 'Yahoo';
  const g = it.g?.[0];
  return ({ cmd: 'Emtia', 'bist-idx': 'BIST', 'us-idx': 'ABD', fx: it.t === 'crypto' ? 'Kripto' : 'Döviz', bist: 'BIST', sp500: 'ABD', dow: 'ABD', 'us-pop': 'ABD', etf: 'ETF' })[g] || '';
}

function rowEl(it) {
  const b = document.createElement('button');
  b.className = 'row';
  b.setAttribute('role', 'option');
  b.dataset.s = it.s;
  if (it._yahoo) b.dataset.yahoo = '1';
  b.setAttribute('aria-selected', String(it.s === state.item?.s));
  b.append(span('r-sym', F.displaySymbol(it.s)), span('r-name', it.n), span('r-badge', groupBadge(it)));
  b.title = `${it.s} — ${it.n}`;
  return b;
}

function sectionEl(text) {
  return span('list-sec', text);
}

function favItems() {
  return state.favs.map((f) => state.bySym.get(f.s) || { ...f, g: [], _yahoo: true });
}

function searchCatalog(q) {
  const out = [];
  for (const it of state.catalog.items) {
    let sc = 0;
    if (it._sym === q) sc = 100;
    else if (it._name === q) sc = 90;
    else if (it._sym.startsWith(q)) sc = 80;
    else if ((' ' + it._name + ' ').includes(' ' + q + ' ')) sc = 65; // tam kelime ("gold" → Gold, Goldman değil)
    else if (it._name.startsWith(q)) sc = 60;
    else if (it._name.includes(' ' + q)) sc = 50;
    else if (it._sym.includes(q)) sc = 40;
    else if (it._name.includes(q)) sc = 30;
    if (sc) out.push([sc, it]);
  }
  // Eşit eşleşmede katalog sırası: önce emtia/endeks/hisseler, ETF'lerde büyük fon önce
  out.sort((a, b) => b[0] - a[0] || a[1]._i - b[1]._i);
  return out.slice(0, 120).map((x) => x[1]);
}

function renderList() {
  const el = $('list');
  el.textContent = '';
  const frag = document.createDocumentFragment();
  const q = F.normalizeText(state.query.trim());
  if (q) {
    const found = searchCatalog(q);
    if (found.length) frag.append(...found.map(rowEl));
    // Katalogda yeterince sonuç varsa Yahoo'nun bulanık eşleşmelerini gösterme
    const extra = found.length >= 5 ? [] : state.yahooResults.filter((r) => !state.bySym.has(r.s));
    if (extra.length) {
      frag.append(sectionEl('Yahoo Finance sonuçları'));
      frag.append(...extra.map((r) => rowEl({ ...r, _yahoo: true })));
    }
    if (!found.length && !extra.length) {
      const d = document.createElement('div');
      d.className = 'list-empty';
      d.textContent = api.isStatic
        ? 'Sonuç yok. Web sürümünde yalnızca listedeki ~2.700 sembol var.'
        : state.query.trim().length >= 2 ? 'Aranıyor…' : 'Sonuç yok';
      frag.append(d);
    }
  } else if (state.group === 'fav') {
    const favs = favItems();
    if (favs.length) frag.append(...favs.map(rowEl));
    else {
      const d = document.createElement('div');
      d.className = 'list-empty';
      d.textContent = 'Henüz favori yok. Başlıktaki ☆ ile ekleyebilirsiniz.';
      frag.append(d);
    }
  } else if (state.group === 'all') {
    const seen = new Set();
    const favs = favItems();
    if (favs.length) {
      frag.append(sectionEl('★ Favoriler'));
      frag.append(...favs.map(rowEl));
    }
    for (const g of state.catalog.groups) {
      const items = state.catalog.items.filter((it) => it.g.includes(g.id) && !seen.has(it.s));
      if (!items.length) continue;
      items.forEach((it) => seen.add(it.s));
      frag.append(sectionEl(`${g.name} (${items.length})`));
      frag.append(...items.map(rowEl));
    }
  } else {
    const g = state.catalog.groups.find((x) => x.id === state.group);
    const items = state.catalog.items.filter((it) => it.g.includes(state.group));
    if (g) frag.append(sectionEl(`${g.name} (${items.length})`));
    frag.append(...items.map(rowEl));
  }
  el.append(frag);
}

function markActiveRow() {
  for (const r of $('list').querySelectorAll('.row')) r.setAttribute('aria-selected', String(r.dataset.s === state.item?.s));
}

let searchTimer = null;
let searchSeq = 0;
function onSearchInput() {
  state.query = $('search').value;
  state.yahooResults = [];
  renderList();
  clearTimeout(searchTimer);
  const q = state.query.trim();
  if (q.length < 2 || api.isStatic) return; // web sürümünde yalnızca hazır liste aranır
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    try {
      const res = await api.search(q);
      if (seq !== searchSeq) return;
      state.yahooResults = res;
    } catch {
      if (seq !== searchSeq) return;
      state.yahooResults = [];
    }
    renderList();
  }, 350);
}

function selectSymbol(sym, given) {
  closeDrawer();
  if (D && D.sym === sym && state.item?.s === sym) return;
  loadSymbol(sym, given);
}

function bindList() {
  $('search').addEventListener('input', onSearchInput);
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('list').querySelector('.row');
      if (first) first.click();
    }
  });
  $('list').addEventListener('click', (e) => {
    const r = e.target.closest('.row');
    if (!r) return;
    const s = r.dataset.s;
    let given;
    if (r.dataset.yahoo) {
      const y = state.yahooResults.find((x) => x.s === s) || state.favs.find((x) => x.s === s);
      if (y) given = { s, n: y.n, t: QT_TYPE[y.qt] || y.t, g: [] };
    }
    selectSymbol(s, given);
  });
}

function isFav(sym) {
  return state.favs.some((f) => f.s === sym);
}

function renderFav() {
  const b = $('favBtn');
  const on = !!state.item && isFav(state.item.s);
  b.textContent = on ? '★' : '☆';
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Favorilerden çıkar' : 'Favorilere ekle');
}

function toggleFav() {
  const it = D?.item || state.item;
  if (!it) return;
  if (isFav(it.s)) state.favs = state.favs.filter((f) => f.s !== it.s);
  else state.favs = [...state.favs, { s: it.s, n: it.n, t: it.t }];
  store.set('favs', state.favs);
  renderFav();
  if (state.group === 'all' || state.group === 'fav') renderList();
}

// ---------------------------------------------------------------------------
// URL (#s=THYAO.IS&r=1Y)
// ---------------------------------------------------------------------------

function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { s: p.get('s'), r: p.get('r') };
}

function writeHash() {
  const sym = state.item?.s;
  if (!sym) return;
  const p = new URLSearchParams();
  p.set('s', sym);
  if (state.range !== 'CUSTOM') p.set('r', state.range);
  const h = '#' + p.toString();
  if (location.hash !== h) history.replaceState(null, '', h);
}

// ---------------------------------------------------------------------------
// Otomatik yenileme (sayfa açıkken)
// ---------------------------------------------------------------------------

async function refresh() {
  if (!D || document.hidden || state.picking) return;
  const d = D;
  const intraRange = RANGES[state.range]?.intraday;
  try {
    if (Date.now() - d.loadedAt > 5 * 60e3) {
      const daily = await api.daily(d.item.base || d.sym);
      if (d !== D) return;
      d.daily = daily;
      d.loadedAt = Date.now();
      d.memo.clear();
    }
    if (intraRange) {
      d.intra = {};
      d.fxIntra = {};
      for (const k of [...d.memo.keys()]) if (k.startsWith('i|')) d.memo.delete(k);
      await ensureIntraday(intraRange);
      if (d !== D) return;
    }
    render(true);
  } catch { /* sessizce bir sonraki turu bekle */ }
}

// ---------------------------------------------------------------------------
// Telefondan aç (QR kod)
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Telefonda açmak için QR kod');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

async function openPhoneDialog() {
  const dlg = $('phoneDlg');
  const box = $('qrBox');
  const urlEl = $('phoneUrl');
  box.textContent = '';
  urlEl.textContent = 'Adres alınıyor…';
  if (!dlg.open) dlg.showModal();
  let info = { lan: false, urls: [] };
  try { info = await api.info(); } catch { /* sunucuya ulaşılamadı */ }
  const ok = !!(info.lan && info.urls.length);
  $('phoneSteps').hidden = !ok;
  $('phoneNote').hidden = !ok;
  $('phoneOff').hidden = ok || info.lan;
  if (!ok) {
    urlEl.textContent = info.lan ? 'Bilgisayarın ağ adresi bulunamadı. Wi-Fi\'a bağlı mı?' : '';
    return;
  }
  const clean = (u) => u.replace(/\/$/, '');
  box.append(qrSvg(info.urls[0] + location.hash));
  urlEl.textContent = clean(info.urls[0]);
  if (info.urls.length > 1) {
    const sm = document.createElement('small');
    sm.textContent = 'Olmazsa: ' + info.urls.slice(1).map(clean).join('  ·  ');
    urlEl.append(sm);
  }
}

function bindPhone() {
  // Telefondan ya da web (GitHub Pages) sürümünden açılmışsa gösterme
  if (api.isStatic || !LOCAL_HOSTS.has(location.hostname)) return;
  $('phoneBtn').hidden = false;
  $('phoneBtn').addEventListener('click', openPhoneDialog);
  $('phoneDlg').addEventListener('click', (e) => { if (e.target === $('phoneDlg')) $('phoneDlg').close(); });
}

// ---------------------------------------------------------------------------

async function init() {
  applyStoredTheme();
  buildRangeButtons();
  bindControls();
  bindList();
  bindPhone();
  chart = new PriceChart($('chart'), { onClick: onChartClick, onCrosshair: renderLegend });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => chart.applyTheme());
  try {
    state.catalog = await api.catalog();
  } catch (e) {
    console.warn('Katalog yüklenemedi', e);
  }
  if (api.isStatic && api.builtAt) {
    const t = new Date(api.builtAt);
    const pad = (n) => String(n).padStart(2, '0');
    $('dataAge').textContent = ` · Son güncelleme: ${t.getDate()} ${F.MONTHS[t.getMonth()]} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  indexCatalog();
  renderChips();
  renderList();
  const h = readHash();
  const r = h.r && RANGES[h.r] ? h.r : store.get('range', '1Y');
  state.range = RANGES[r] ? r : '1Y';
  state.lastRange = state.range;
  syncControls();
  loadSymbol(h.s || store.get('last', DEFAULT_SYMBOL));
  setInterval(refresh, 60e3);
}

init();

// Hata ayıklama / testler için
window.grafik = { state, get chart() { return chart; }, get data() { return D; } };
