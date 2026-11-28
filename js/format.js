// Türkçe sayı / tarih biçimlendirme yardımcıları.

export const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const MONTHS_LONG = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

const nfCache = new Map();
function nf(key, opts) {
  let f = nfCache.get(key);
  if (!f) { f = new Intl.NumberFormat('tr-TR', opts); nfCache.set(key, f); }
  return f;
}

export function priceDecimals(v, minDec = 2) {
  const a = Math.abs(v);
  const d = a >= 1 || a === 0 ? 2 : a >= 0.01 ? 4 : 6;
  return Math.max(d, minDec);
}

export function fmtPrice(v, cur, minDec = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = priceDecimals(v, minDec);
  if (cur === 'TRY' || cur === 'USD' || cur === 'EUR' || cur === 'GBP') {
    return nf(`c${cur}${d}`, { style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  }
  return nf(`n${d}`, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v) + (cur ? ' ' + cur : '');
}

export function fmtNumber(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return nf(`n${d}`, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

/** Oranı (0.1234) "+%12,34" biçiminde yazar. */
export function fmtPct(p, opts = {}) {
  if (p == null || !Number.isFinite(p)) return '—';
  const big = Math.abs(p) >= 10;
  const d = opts.decimals ?? (big ? 0 : 2);
  return nf(`p${d}${opts.minDec ?? d}`, {
    style: 'percent', signDisplay: 'exceptZero',
    minimumFractionDigits: opts.minDec ?? d, maximumFractionDigits: d,
  }).format(p);
}

/** Değişimi kat olarak yazar: +%878 → "9,78 kat", -%40 → "0,60 kat". */
export function fmtMult(p) {
  const m = 1 + p;
  if (p == null || !Number.isFinite(m) || m <= 0) return '';
  return `${fmtNumber(m, m >= 100 ? 0 : m >= 10 ? 1 : 2)} kat`;
}

/** Grafik ekseni için kısa yüzde ("+%5", "-%2,5"). */
export function fmtPctAxis(p) {
  if (!Number.isFinite(p)) return '';
  const a = Math.abs(p);
  const d = a >= 10 ? 0 : a >= 1 ? 1 : 2;
  return fmtPct(p, { decimals: d, minDec: 0 });
}

export function fmtDateKey(k, long = false) {
  if (!k) return '—';
  const y = k.slice(0, 4), m = +k.slice(5, 7), d = +k.slice(8, 10);
  return `${d} ${(long ? MONTHS_LONG : MONTHS)[m - 1]} ${y}`;
}

export function fmtDateKeyNumeric(k) {
  if (!k) return '—';
  return `${k.slice(8, 10)}.${k.slice(5, 7)}.${k.slice(0, 4)}`;
}

/** Grafik zamanı (yerel saat UTC gibi kaydırılmış saniye). */
export function fmtChartTime(sec, withTime) {
  const d = new Date(sec * 1000);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!withTime) return base;
  return `${base} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function fmtTick(sec, type) {
  const d = new Date(sec * 1000);
  switch (type) {
    case 0: return String(d.getUTCFullYear());
    case 1: return MONTHS[d.getUTCMonth()];
    case 2: return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    default: return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/** İki gün anahtarı arasındaki süreyi takvime göre yazar: "1 yıl 2 ay (427 gün)". */
export function fmtDuration(k0, k1, days) {
  if (!k0 || !k1 || days == null) return '';
  if (days < 1) return 'gün içi';
  if (days < 45) return `${days} gün`;
  const [y0, m0, d0] = k0.split('-').map(Number);
  const [y1, m1, d1] = k1.split('-').map(Number);
  let months = (y1 - y0) * 12 + (m1 - m0);
  // ay sonuna denk gelen tatil/hafta sonu kaymalarında birkaç günlük farkı yuvarla
  const dd = d1 - d0;
  if (dd < -3) months -= 1;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const parts = [];
  if (years) parts.push(`${years} yıl`);
  if (rem) parts.push(`${rem} ay`);
  return `${parts.join(' ') || days + ' gün'} (${nf('n0', { maximumFractionDigits: 0 }).format(days)} gün)`;
}

/** Arama için: küçük harf, Türkçe karakterleri sadeleştir. */
export function normalizeText(s) {
  return String(s || '')
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function displaySymbol(s) {
  if (!s) return '';
  if (s.endsWith('.IS')) return s.slice(0, -3);
  if (s === 'GRAMALTIN') return 'GRAM';
  if (s === 'GRAMGUMUS') return 'GRAM-AG';
  return s.replace(/^\^/, '');
}

export const CUR_LABEL = { TRY: 'TL', USD: 'USD' };
