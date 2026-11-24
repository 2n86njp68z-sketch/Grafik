// Yahoo Finance istemcisi: ham veriyi çeker, işler ve bellekte önbelleğe alır.
import { processDaily, processIntraday } from '../public/js/calc.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const TTL = {
  daily: 10 * 60 * 1000,
  intraday: 60 * 1000,
  search: 60 * 60 * 1000,
};

export class YahooError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const SYMBOL_RE = /^[A-Za-z0-9.^=_\-]{1,32}$/;

export function validSymbol(s) {
  return typeof s === 'string' && SYMBOL_RE.test(s);
}

const cache = new Map();
const MAX_CACHE = 600;

function cached(key, ttl, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.p;
  const p = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { exp: now + ttl, p });
  if (cache.size > MAX_CACHE) {
    for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
    // hâlâ fazlaysa en eski kayıtları at (Map ekleme sırasını korur)
    for (const k of cache.keys()) { if (cache.size <= MAX_CACHE) break; cache.delete(k); }
  }
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(pathAndQuery) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    try {
      const r = await fetch(host + pathAndQuery, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 404) {
        const body = await r.json().catch(() => null);
        const msg = body?.chart?.error?.description;
        throw new YahooError(msg ? `Sembol bulunamadı (${msg})` : 'Sembol bulunamadı', 404);
      }
      if (r.status === 429 || r.status >= 500) {
        lastErr = new YahooError(`Veri kaynağı yoğun (HTTP ${r.status}), tekrar deneniyor…`);
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        const msg = body?.chart?.error?.description || body?.finance?.error?.description;
        const err = new YahooError(`Veri kaynağı hatası (HTTP ${r.status})${msg ? ': ' + msg : ''}`);
        err.final = r.status >= 400 && r.status < 500; // istemci hatası: tekrar denemek anlamsız
        throw err;
      }
      return await r.json();
    } catch (e) {
      if (e instanceof YahooError && (e.status === 404 || e.final)) throw e;
      lastErr = e;
      await sleep(400 * (attempt + 1));
    }
  }
  if (lastErr instanceof YahooError) throw lastErr;
  throw new YahooError(`Yahoo Finance'e ulaşılamadı: ${lastErr?.cause?.code || lastErr?.message || 'bilinmeyen hata'}`);
}

function chartResult(json) {
  const res = json?.chart?.result?.[0];
  if (!res) {
    const msg = json?.chart?.error?.description;
    throw new YahooError(msg ? `Veri yok: ${msg}` : 'Bu sembol için veri bulunamadı', 404);
  }
  return res;
}

export function getDaily(symbol) {
  return cached(`d:${symbol}`, TTL.daily, async () => {
    // range=max uzun geçmişlerde aylık veri döndürdüğü için tarih aralığıyla istiyoruz.
    // Yahoo tek istekte en fazla 100 yıllık günlük veri veriyor (S&P 500 bile 1927'de başlıyor).
    const end = Math.floor(Date.now() / 1000) + 86400;
    const start = end - Math.floor(99.9 * 365.25 * 86400);
    const json = await getJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}` +
      '&interval=1d&events=div%2Csplits&includeAdjustedClose=true');
    const out = processDaily(chartResult(json));
    if (!out.k.length) throw new YahooError('Bu sembol için fiyat geçmişi yok', 404);
    return out;
  });
}

const INTRADAY = { '1d': '5m', '5d': '15m' };

export function getIntraday(symbol, range) {
  const interval = INTRADAY[range];
  if (!interval) return Promise.reject(new YahooError('Geçersiz aralık', 400));
  return cached(`i:${symbol}:${range}`, TTL.intraday, async () => {
    const [json, daily] = await Promise.all([
      getJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`),
      getDaily(symbol).catch(() => null),
    ]);
    return { ...processIntraday(chartResult(json), daily), interval };
  });
}

const SEARCH_TYPES = new Set(['EQUITY', 'ETF', 'INDEX', 'FUTURE', 'CURRENCY', 'CRYPTOCURRENCY', 'MUTUALFUND']);

export function search(q) {
  const query = String(q || '').trim().slice(0, 60);
  if (!query) return Promise.resolve([]);
  return cached(`s:${query.toLowerCase()}`, TTL.search, async () => {
    const json = await getJson(`/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0` +
      '&listsCount=0&enableFuzzyQuery=false&lang=tr-TR&region=TR');
    return (json?.quotes || [])
      .filter((x) => x.symbol && SEARCH_TYPES.has(x.quoteType) && validSymbol(x.symbol))
      .map((x) => ({
        s: x.symbol,
        n: x.longname || x.shortname || x.symbol,
        ex: x.exchDisp || x.exchange || '',
        qt: x.quoteType,
      }));
  });
}

export function _clearCache() {
  cache.clear();
}
