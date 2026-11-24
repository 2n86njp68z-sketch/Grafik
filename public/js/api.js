// Veri istemcisi: yerelde sunucu API'si, GitHub Pages sürümünde hazır JSON dosyaları.
import { STATIC, BUILT_AT } from './config.js';
import { staticFileName, unpackDaily, unpackIntraday } from './calc.js';

const cache = new Map();

function getJson(url, ttlMs, transform = (x) => x) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.exp > now) return hit.p;
  const p = fetch(url).then(async (r) => {
    let body = null;
    try { body = await r.json(); } catch { /* boş gövde */ }
    if (!r.ok) {
      if (STATIC && r.status === 404) throw new Error('Bu sembol için hazır veri yok.');
      throw new Error(body?.error || `Sunucu hatası (HTTP ${r.status})`);
    }
    return transform(body);
  }).catch((e) => {
    cache.delete(url);
    if (e instanceof TypeError) {
      throw new Error(STATIC ? 'İnternet bağlantısı yok gibi görünüyor.' : 'Sunucuya ulaşılamadı. Uygulama penceresi (node server.js) açık mı?');
    }
    throw e;
  });
  cache.set(url, { exp: now + ttlMs, p });
  return p;
}

const live = {
  daily: (symbol) => getJson(`api/daily?symbol=${encodeURIComponent(symbol)}`, 5 * 60e3),
  intraday: (symbol, range) => getJson(`api/intraday?symbol=${encodeURIComponent(symbol)}&range=${range}`, 60e3),
  info: () => getJson('api/info', 0),
  search: (q) => getJson(`api/search?q=${encodeURIComponent(q)}`, 10 * 60e3),
};

const stat = {
  daily: (symbol) => {
    const f = staticFileName(symbol);
    return Promise.all([getJson(`data/d/${f}.json`, 60 * 60e3), getJson(`data/r/${f}.json`, 10 * 60e3)])
      .then(([hist, rec]) => unpackDaily(hist, rec));
  },
  intraday: (symbol, range) => getJson(`data/i/${staticFileName(symbol)}.json`, 10 * 60e3).catch(() => null).then((j) => {
    const v = unpackIntraday(j?.[range]);
    if (!v || !v.t.length) throw new Error('Bu dönem için gün içi veri yok');
    return v;
  }),
  info: async () => ({ lan: false, urls: [], static: true }),
  search: async () => [],
};

export const api = {
  isStatic: STATIC,
  builtAt: BUILT_AT,
  catalog: () => getJson('data/catalog.json', 24 * 3600e3),
  ...(STATIC ? stat : live),
};
