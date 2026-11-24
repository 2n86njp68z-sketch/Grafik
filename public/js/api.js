// Sunucu API'si için küçük, önbellekli istemci.

const cache = new Map();

async function getJson(url, ttlMs) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.exp > now) return hit.p;
  const p = fetch(url).then(async (r) => {
    let body = null;
    try { body = await r.json(); } catch { /* boş gövde */ }
    if (!r.ok) throw new Error(body?.error || `Sunucu hatası (HTTP ${r.status})`);
    return body;
  }).catch((e) => {
    cache.delete(url);
    if (e instanceof TypeError) throw new Error('Sunucuya ulaşılamadı. Uygulama penceresi (node server.js) açık mı?');
    throw e;
  });
  cache.set(url, { exp: now + ttlMs, p });
  return p;
}

export const api = {
  catalog: () => getJson('data/catalog.json', 24 * 3600e3),
  daily: (symbol) => getJson(`api/daily?symbol=${encodeURIComponent(symbol)}`, 5 * 60e3),
  intraday: (symbol, range) => getJson(`api/intraday?symbol=${encodeURIComponent(symbol)}&range=${range}`, 60e3),
  info: () => getJson('api/info', 0),
  search: (q) => getJson(`api/search?q=${encodeURIComponent(q)}`, 10 * 60e3),
};
