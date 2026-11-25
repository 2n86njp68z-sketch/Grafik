// İş Yatırım: BIST hisseleri için resmi sermaye artırımı / bölünme / temettü kayıtları.
// Şirket kartı sayfasının kullandığı uç nokta; her olay için resmi "fiyat ayar oranı"nı verir
// (SHHE_FIYAT_AYAR_OR: olaydan önceki fiyatların çarpılacağı oran; nakit temettüde 1 - temettü/fiyat).
// Resmi bir API değildir; erişilemezse uygulama Yahoo verisi + tahmine geri döner.
import { dateKey } from '../public/js/calc.js';

const BASE = 'https://www.isyatirim.com.tr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** "THYAO.IS" → "THYAO"; BIST hissesi değilse (endeks dahil) null. */
export function isyCode(symbol) {
  const m = /^([A-Z0-9]{3,6})\.IS$/i.exec(symbol || '');
  if (!m || /^X[A-Z0-9]{2,5}$/i.test(m[1])) return null; // XU100, XBANK… endeks
  return m[1].toUpperCase();
}

/** Ham kayıtları sade olay listesine çevirir: [{ k, t, f, d? }] (d: hisse başı brüt temettü, TL). */
export function toCorporateActions(list) {
  const out = [];
  for (const x of list || []) {
    const f = Number(x?.SHHE_FIYAT_AYAR_OR);
    const ms = Number(x?.SHHE_TARIH);
    if (!(f > 0) || !Number.isFinite(f) || !(ms > Date.UTC(1990, 0, 1))) continue;
    const k = dateKey(ms / 1000, 'Europe/Istanbul');
    const t = String(x.SHT_KODU || '');
    const d = x.SHHE_NAKIT_TM_ORAN > 0 ? x.SHHE_NAKIT_TM_ORAN / 100 : null; // nominal 1 TL başına
    if (t === '04') { out.push({ k, t, f, d }); continue; }
    if (t === '05') {
      // Bedelsiz + nakit temettü aynı gün: fiyat kısmı (bedelsiz) ile temettü kısmını ayır
      const bz = (+x.SHHE_BDSZ_IK_ORAN || 0) + (+x.SHHE_BDSZ_TM_ORAN || 0) + (+x.SHHE_BDSZ_BU_ORAN || 0);
      const fc = 1 / (1 + bz / 100);
      const fd = f / fc;
      if (bz > 0 && fd > 0.5 && fd < 1) {
        out.push({ k, t: '02', f: fc });
        out.push({ k, t: '04', f: fd, d });
        continue;
      }
    }
    out.push({ k, t, f });
  }
  return out.sort((a, b) => a.k.localeCompare(b.k));
}

/** Depolama için sıkıştırma: [k, t, f, d] dizileri. */
export const packCA = (ca) => ca.map((e) => (e.d != null ? [e.k, e.t, Number(e.f.toPrecision(10)), Number(e.d.toPrecision(8))] : [e.k, e.t, Number(e.f.toPrecision(10))]));
export const unpackCA = (rows) => (Array.isArray(rows) ? rows.map(([k, t, f, d]) => ({ k, t, f, ...(d != null ? { d } : {}) })) : null);

/** Bir hissenin olaylarını çeker. Hata durumunda istisna fırlatır. */
export async function fetchCorporateActions(symbol, { timeout = 30000 } = {}) {
  const code = isyCode(symbol);
  if (!code) return null;
  const r = await fetch(`${BASE}/_layouts/15/IsYatirim.Website/StockInfo/CompanyInfoAjax.aspx/GetSermayeArttirimlari`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeout),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: `${BASE}/tr-tr/analiz/hisse/Sayfalar/sirket-karti.aspx?hisse=${code}`,
      Origin: BASE,
    },
    body: JSON.stringify({ hisseKodu: code, hisseTanimKodu: '', yil: 0, zaman: 'HEPSI', endeksKodu: '09', sektorKodu: '' }),
  });
  if (!r.ok) throw new Error(`İş Yatırım HTTP ${r.status}`);
  const body = await r.json();
  const list = typeof body?.d === 'string' ? JSON.parse(body.d) : body?.d;
  if (!Array.isArray(list)) throw new Error('İş Yatırım: beklenmeyen yanıt');
  return toCorporateActions(list);
}

const dmy = (k) => `${k.slice(8, 10)}-${k.slice(5, 7)}-${k.slice(0, 4)}`;

/**
 * Verilen günlerin gerçek fiyat değişimi: İş Yatırım ham kapanışı (HG_KAPANIS) ile o günün
 * önceki işlem gününe oranı, o gün resmi bir sermaye olayı varsa onun oranına bölünmüş.
 * Dönen: { 'YYYY-MM-DD': oran | 0 } (0: veri yok; tekrar sorulmasın diye saklanır).
 * Geçmiş fiyatlar değişmediği için bir kez çekilip saklanır. Uç nokta yavaş (5-30 sn).
 */
export async function fetchDayReturns(symbol, days, ca = [], { timeout = 60000 } = {}) {
  const code = isyCode(symbol);
  if (!code || !days.length) return {};
  const out = {};
  for (const k of days) {
    out[k] = 0;
    const from = new Date(Date.parse(k) - 10 * 864e5).toISOString().slice(0, 10);
    const r = await fetch(`${BASE}/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?hisse=${code}&startdate=${dmy(from)}&enddate=${dmy(k)}`, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE}/tr-tr/analiz/hisse/Sayfalar/sirket-karti.aspx?hisse=${code}` },
    });
    if (!r.ok) throw new Error(`İş Yatırım HTTP ${r.status}`);
    const rows = ((await r.json())?.value || [])
      .map((x) => ({ k: String(x.HGDG_TARIH || '').split('-').reverse().join('-'), p: Number(x.HG_KAPANIS) }))
      .filter((x) => x.p > 0 && x.k <= k)
      .sort((a, b) => a.k.localeCompare(b.k));
    const n = rows.length;
    if (n < 2 || rows[n - 1].k !== k) continue;
    const f = ca.filter((e) => e.k === k && e.t !== '04').reduce((acc, e) => acc * e.f, 1);
    out[k] = rows[n - 1].p / rows[n - 2].p / f;
  }
  return out;
}

/**
 * Bir tarih aralığının ham (işlem gören) kapanışları: { 'YYYY-MM-DD': HG_KAPANIS }.
 * Yahoo'nun fiyatı güncellemediği (donuk) dönemleri doldurmak için.
 */
export async function fetchRawCloses(symbol, from, to, { timeout = 120000 } = {}) {
  const code = isyCode(symbol);
  if (!code) return {};
  const r = await fetch(`${BASE}/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?hisse=${code}&startdate=${dmy(from)}&enddate=${dmy(to)}`, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE}/tr-tr/analiz/hisse/Sayfalar/sirket-karti.aspx?hisse=${code}` },
  });
  if (!r.ok) throw new Error(`İş Yatırım HTTP ${r.status}`);
  const out = {};
  for (const x of (await r.json())?.value || []) {
    const k = String(x.HGDG_TARIH || '').split('-').reverse().join('-');
    const p = Number(x.HG_KAPANIS);
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && p > 0) out[k] = p;
  }
  return out;
}

// Yerel sunucu için bellek önbelleği (olaylar nadiren değişir)
const cache = new Map();
const OK_TTL = 12 * 3600 * 1000;
const FAIL_TTL = 10 * 60 * 1000;

/** Önbellekli; hata ya da kayıt yoksa null (çağıran Yahoo verisine geri döner). */
export async function getCorporateActions(symbol) {
  const code = isyCode(symbol);
  if (!code) return null;
  const hit = cache.get(code);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v = null, ttl = OK_TTL;
  try {
    const ca = await fetchCorporateActions(symbol, { timeout: 8000 });
    v = ca && ca.length ? ca : null;
  } catch {
    ttl = FAIL_TTL;
  }
  cache.set(code, { exp: Date.now() + ttl, v });
  return v;
}
