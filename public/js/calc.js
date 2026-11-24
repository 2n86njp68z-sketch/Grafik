// Saf hesaplama fonksiyonları — hem sunucu (Node) hem tarayıcı tarafından kullanılır.
// DOM'a veya ağa dokunmaz; bu yüzden test/calc.test.mjs ile birim testi yapılır.

// ---------------------------------------------------------------------------
// Tarih / saat dilimi yardımcıları
// ---------------------------------------------------------------------------

const fmtCache = new Map();

function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      f = partsFormatter('UTC');
    }
    fmtCache.set(tz, f);
  }
  return f;
}

/** Unix saniyesini verilen saat diliminde yerel takvim/saat parçalarına ayırır. */
export function localParts(ts, tz) {
  const p = {};
  for (const { type, value } of partsFormatter(tz || 'UTC').formatToParts(new Date(ts * 1000))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour % 24, M: +p.minute, S: +p.second };
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** Borsanın yerel takvimine göre 'YYYY-MM-DD' gün anahtarı. */
export function dateKey(ts, tz) {
  const p = localParts(ts, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** Saat diliminin UTC'ye göre farkı (saniye, yaz saati dahil). */
export function tzOffsetSec(ts, tz) {
  const p = localParts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) / 1000 - Math.floor(ts);
}

/** 'YYYY-MM-DD' -> o günün UTC gece yarısı (saniye). */
export function keyToSec(k) {
  return Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 1000;
}

/** UTC saniye -> 'YYYY-MM-DD'. */
export function secToKey(s) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

/** Sıralı dizide değeri <= x olan son indeks; yoksa -1. */
export function lastIndexAtOrBefore(arr, x) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Sıralı dizide değeri >= x olan ilk indeks; yoksa arr.length. */
export function firstIndexAtOrAfter(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const round7 = (v) => (v == null ? v : Number(v.toPrecision(7)));

// ---------------------------------------------------------------------------
// Yahoo verisini temizleme + temettü düzeltmesi (toplam getiri)
// ---------------------------------------------------------------------------

// Bir günde 20 kattan fazla değişim gerçek bir fiyat hareketi değil, veri hatasıdır
// (ör. 2005 YTL geçişinde 6 sıfır atılmasının bazı hisselerde düzeltilmemiş olması).
const GLITCH_RATIO = 20;
// Kapanışın %50'sinden büyük tek seferlik temettü kaydı bozuk kabul edilir.
const MAX_DIV_YIELD = 0.5;

/**
 * Yahoo /v8/finance/chart günlük yanıtını işler.
 * Dönen `c` bölünmelere göre düzeltilmiş kapanış, `a` ise temettüler yeniden
 * yatırılmış kabul edilerek geriye doğru düzeltilmiş kapanıştır (toplam getiri).
 */
export function processDaily(res) {
  const meta = res?.meta || {};
  const tz = meta.exchangeTimezoneName || 'UTC';
  const ts = res?.timestamp || [];
  const close = res?.indicators?.quote?.[0]?.close || [];

  const K = [], T = [], C = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    const k = dateKey(ts[i], tz);
    const n = K.length;
    if (n && K[n - 1] === k) { T[n - 1] = ts[i]; C[n - 1] = c; continue; } // aynı gün tekrar: sonuncusu güncel
    if (n && k < K[n - 1]) continue;
    K.push(k); T.push(ts[i]); C.push(c);
  }
  const n = K.length;
  const fixes = [];

  // --- Temettü faktörleri (ham kapanışlarla, tutarlı birimde) ---
  const divsRaw = Object.values(res?.events?.dividends || {})
    .filter((d) => d && Number.isFinite(d.amount) && d.amount > 0)
    .sort((a, b) => a.date - b.date);
  const divs = [];
  const factorEvents = []; // [index, faktör] — index ve sonrası etkilenmez, öncesi çarpılır
  for (const d of divsRaw) {
    const k = dateKey(d.date, tz);
    const i = firstIndexAtOrAfter(K, k);
    if (i <= 0 || i >= n) continue;
    const prev = C[i - 1];
    const r = d.amount / prev;
    if (!(r > 0 && r < MAX_DIV_YIELD)) {
      fixes.push({ type: 'div-skip', k, amount: d.amount });
      continue;
    }
    divs.push([K[i], round7(d.amount)]);
    factorEvents.push([i, 1 - r]);
  }
  const A = new Array(n);
  let cum = 1;
  for (let j = n - 1, e = factorEvents.length - 1; j >= 0; j--) {
    while (e >= 0 && factorEvents[e][0] > j) { cum *= factorEvents[e][1]; e--; }
    A[j] = C[j] * cum;
  }

  // --- Veri hatası düzeltmesi (ani 20x+ sıçramalar) ---
  const jumpAt = new Map();
  for (let j = 1; j < n; j++) {
    const ratio = C[j] / C[j - 1];
    if (ratio > GLITCH_RATIO || ratio < 1 / GLITCH_RATIO) {
      const lg = Math.log10(ratio);
      // 10'un kuvvetine yakınsa (birim/sıfır hatası) tam kuvveti kullan
      const k = Math.abs(lg - Math.round(lg)) < 0.15 ? Math.pow(10, Math.round(lg)) : ratio;
      jumpAt.set(j, k);
      fixes.push({ type: 'rescale', k: K[j], factor: round7(k) });
    }
  }
  if (jumpAt.size) {
    let mult = 1;
    for (let j = n - 1; j >= 0; j--) {
      if (jumpAt.has(j + 1)) mult *= jumpAt.get(j + 1);
      if (mult !== 1) { C[j] *= mult; A[j] *= mult; }
    }
  }

  const splits = Object.values(res?.events?.splits || {})
    .sort((a, b) => a.date - b.date)
    .map((s) => [dateKey(s.date, tz), s.splitRatio || `${s.numerator}:${s.denominator}`]);

  return {
    symbol: meta.symbol,
    name: meta.longName || meta.shortName || meta.symbol,
    currency: meta.currency || 'USD',
    type: meta.instrumentType,
    exchange: meta.fullExchangeName || meta.exchangeName,
    tz,
    k: K,
    t: T,
    c: C.map(round7),
    a: A.map(round7),
    divs,
    splits,
    fixes,
    price: meta.regularMarketPrice,
    priceTime: meta.regularMarketTime,
  };
}

/**
 * Gün içi (1G / 1H) yanıtını işler. Toplam getiri için her barın gününe ait
 * günlük düzeltme oranı (a/c) kullanılır, böylece günlük grafikle tutarlı kalır.
 * `base` = gün içi verinin başladığı günden önceki son günlük kapanış.
 */
export function processIntraday(res, daily) {
  const meta = res?.meta || {};
  const tz = meta.exchangeTimezoneName || daily?.tz || 'UTC';
  const ts = res?.timestamp || [];
  const close = res?.indicators?.quote?.[0]?.close || [];
  const T = [], C = [], A = [];
  const dk = daily?.k || [];
  let lastKey = null, lastIdx = -1;
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    if (T.length && ts[i] <= T[T.length - 1]) continue;
    const k = dateKey(ts[i], tz);
    if (k !== lastKey) { lastKey = k; lastIdx = lastIndexAtOrBefore(dk, k); }
    const di = lastIdx >= 0 ? lastIdx : 0;
    const f = dk.length ? daily.a[di] / daily.c[di] : 1;
    T.push(ts[i]); C.push(round7(c)); A.push(round7(c * f));
  }
  let base = null;
  if (T.length && dk.length) {
    const firstKey = dateKey(T[0], tz);
    let bi = lastIndexAtOrBefore(dk, firstKey);
    if (bi >= 0 && dk[bi] === firstKey) bi--; // gün içi verinin ilk gününden ÖNCEKİ kapanış
    if (bi >= 0) base = { k: dk[bi], c: daily.c[bi], a: daily.a[bi] };
  }
  if (!base && meta.chartPreviousClose && T.length) {
    base = { k: null, c: meta.chartPreviousClose, a: meta.chartPreviousClose };
  }
  return { symbol: meta.symbol, tz, t: T, c: C, a: A, base };
}

// ---------------------------------------------------------------------------
// İstemci tarafı seri işlemleri
// Seri: { x:[], time:[], k:[], v:[] }
//   x    : hizalama anahtarı (günlük: gün başı UTC sn, gün içi: gerçek unix sn)
//   time : grafiğe verilecek zaman (borsa yerel saati UTC gibi gösterilsin diye kaydırılmış)
//   k    : borsa yerel gün anahtarı
// ---------------------------------------------------------------------------

export function makeDailySeries(daily, useAdj, scale = 1) {
  const src = useAdj ? daily.a : daily.c;
  const x = daily.k.map(keyToSec);
  return { x, time: x, k: daily.k.slice(), v: src.map((v) => v * scale), intraday: false };
}

export function makeIntradaySeries(intra, useAdj, scale = 1) {
  const src = useAdj ? intra.a : intra.c;
  const x = intra.t.slice();
  const time = [], k = [];
  let cachedOff = null, cachedHour = null;
  for (const t of x) {
    const hour = Math.floor(t / 3600);
    if (hour !== cachedHour) { cachedHour = hour; cachedOff = tzOffsetSec(t, intra.tz); }
    time.push(t + cachedOff);
    k.push(secToKey(t + cachedOff));
  }
  return { x, time, k, v: src.map((v) => v * scale), intraday: true };
}

/** FX serisinden x anında geçerli kur (x'ten önceki son değer). */
export function makeRateLookup(fxSeries, fallbackDaily) {
  return (x, k) => {
    if (fxSeries) {
      const i = lastIndexAtOrBefore(fxSeries.x, x);
      if (i >= 0) return fxSeries.v[i];
    }
    if (fallbackDaily && k) {
      const i = lastIndexAtOrBefore(fallbackDaily.x, keyToSec(k));
      if (i >= 0) return fallbackDaily.v[i];
      // gün içi seri günlük FX geçmişinden önce başlıyorsa ilk kuru kullan
      if (fxSeries && fallbackDaily.v.length) return fallbackDaily.v[0];
    }
    return null;
  };
}

/**
 * Para birimi dönüşümü. steps: [{ op: 'mul' | 'div', rate: (x, k) => number|null }]
 * Kuru bulunamayan noktalar atılır; `dropped` sayısı döner.
 */
export function convertSeries(s, steps) {
  if (!steps.length) return { ...s, dropped: 0 };
  const out = { x: [], time: [], k: [], v: [], intraday: s.intraday };
  let dropped = 0;
  for (let i = 0; i < s.x.length; i++) {
    let v = s.v[i];
    let ok = true;
    for (const st of steps) {
      const r = st.rate(s.x[i], s.k[i]);
      if (!r || !Number.isFinite(r)) { ok = false; break; }
      v = st.op === 'mul' ? v * r : v / r;
    }
    if (!ok) { dropped++; continue; }
    out.x.push(s.x[i]); out.time.push(s.time[i]); out.k.push(s.k[i]); out.v.push(v);
  }
  out.dropped = dropped;
  return out;
}

/** Tek bir değeri (ör. önceki kapanış) aynı adımlarla dönüştürür. */
export function convertValue(v, x, k, steps) {
  for (const st of steps) {
    const r = st.rate(x, k);
    if (!r || !Number.isFinite(r)) return null;
    v = st.op === 'mul' ? v * r : v / r;
  }
  return v;
}

/** Hedef para birimine dönüşüm için hangi kur serilerinin gerektiğini söyler. */
export function conversionPlan(nativeCur, displayCur) {
  // Kur sembolleri Yahoo kuralı: "XXX=X" = 1 USD kaç XXX
  if (nativeCur === displayCur) return [];
  const steps = [];
  if (nativeCur !== 'USD') steps.push({ op: 'div', fx: `${nativeCur}=X` });
  if (displayCur !== 'USD') steps.push({ op: 'mul', fx: `${displayCur}=X` });
  return steps;
}

/** Yahoo alt birimlerini (GBp, ILA, ZAc) ana birime çevirir. */
export function normalizeCurrency(cur) {
  if (cur === 'GBp' || cur === 'GBX') return { cur: 'GBP', scale: 0.01 };
  if (cur === 'ILA') return { cur: 'ILS', scale: 0.01 };
  if (cur === 'ZAc') return { cur: 'ZAR', scale: 0.01 };
  return { cur: cur || 'USD', scale: 1 };
}

// ---------------------------------------------------------------------------
// Dönem / aralık hesapları
// ---------------------------------------------------------------------------

export const RANGES = {
  '1D': { label: '1G', intraday: '1d' },
  '1W': { label: '1H', intraday: '5d' },
  '1M': { label: '1A', months: 1 },
  '3M': { label: '3A', months: 3 },
  '6M': { label: '6A', months: 6 },
  '1Y': { label: '1Y', months: 12 },
  '5Y': { label: '5Y', months: 60 },
  '10Y': { label: '10Y', months: 120 },
  MAX: { label: 'Tümü' },
};

/** Son günden geriye `months` ay giden başlangıç gün anahtarı. */
export function rangeStartKey(range, lastKey) {
  const r = RANGES[range];
  if (!r || !r.months) return null;
  const d = new Date(keyToSec(lastKey) * 1000);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - r.months);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.toISOString().slice(0, 10);
}

/**
 * Başlangıç tarihi için baz bar: o tarihteki veya ondan önceki son kapanış.
 * Tarih verinin başlangıcından önceyse ilk bar.
 */
export function baseIndexForKey(keys, startKey) {
  if (!keys.length) return -1;
  const i = lastIndexAtOrBefore(keys, startKey);
  return i >= 0 ? i : 0;
}

/** Bitiş tarihi için: o tarihteki veya önceki son kapanış (yoksa -1). */
export function endIndexForKey(keys, endKey) {
  return lastIndexAtOrBefore(keys, endKey);
}

/** Bir serinin [i0, i1] dilimi. */
export function sliceSeries(s, i0, i1 = s.x.length - 1) {
  return {
    x: s.x.slice(i0, i1 + 1), time: s.time.slice(i0, i1 + 1), k: s.k.slice(i0, i1 + 1),
    v: s.v.slice(i0, i1 + 1), intraday: s.intraday,
  };
}

/** İki tarih arasındaki değişim. Tarihler 'YYYY-MM-DD'. */
export function changeBetweenDates(s, fromKey, toKey) {
  const i0 = baseIndexForKey(s.k, fromKey);
  const i1 = endIndexForKey(s.k, toKey);
  if (i0 < 0 || i1 < 0 || i1 <= i0) return null;
  return changeBetweenIndices(s, i0, i1);
}

export function changeBetweenIndices(s, i0, i1) {
  const v0 = s.v[i0], v1 = s.v[i1];
  return { i0, i1, k0: s.k[i0], k1: s.k[i1], x0: s.x[i0], x1: s.x[i1], v0, v1, pct: v1 / v0 - 1 };
}

/** İki gün anahtarı arasındaki gün sayısı. */
export function daysBetween(k0, k1) {
  return Math.round((keyToSec(k1) - keyToSec(k0)) / 86400);
}

/** Yıllıklandırılmış getiri (1 yıldan kısa dönemler için null). */
export function annualized(pct, days) {
  if (!(days >= 365) || !(pct > -1)) return null;
  return Math.pow(1 + pct, 365.25 / days) - 1;
}
