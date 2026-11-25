#!/usr/bin/env node
// GitHub Pages için sunucusuz (statik) site üretir:
//   node scripts/build-static.mjs [çıktı-klasörü]   (varsayılan: site)
//
// Katalogdaki her sembolün günlük ve gün içi verisini Yahoo Finance'ten çekip,
// sunucunun yaptığı işlemenin aynısını uygulayarak JSON dosyaları olarak yazar.
// Ön yüz bu dosyaları /api yerine okur (public/js/config.js -> STATIC = true).
// GitHub Actions bu betiği gün içinde düzenli aralıklarla çalıştırır (.github/workflows/pages.yml).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDailyRaw, getIntraday } from '../lib/yahoo.js';
import { fetchCorporateActions, fetchDayReturns, fetchRawCloses, isyCode, packCA, unpackCA } from '../lib/isyatirim.js';
import { dateKey, lastIndexAtOrBefore, processDaily, staticFileName } from '../public/js/calc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'site'));
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;
const LIMIT = Number(process.env.LIMIT) || Infinity; // test için: ilk N sembol
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null; // test için: yalnızca bu semboller

const r6 = (v) => (v == null ? v : Number(v.toPrecision(6)));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// Günlük veri iki dosyaya bölünür ki her güncellemede yalnızca küçük dosyalar değişsin
// (gh-pages branch'i şişmesin): geçen ayın başından önceki geçmiş (d/, ayda bir değişir)
// ve son günler + bilgiler (r/, her seferinde değişir). Temettü düzeltmeli değerler
// gönderilmez; istemci faktörlerden hesaplar (calc.js applyFactors), böylece yeni bir
// temettü geçmiş dosyasını değiştirmez.
const now = new Date();
const CUT = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);

function packKeys(keys) {
  const dk = [];
  let prev = null;
  for (const k of keys) {
    const s = Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 86400000;
    dk.push(prev == null ? 0 : s - prev);
    prev = s;
  }
  return { k0: keys[0] || null, dk };
}

function packDaily(d) {
  let split = 0;
  while (split < d.k.length && d.k[split] < CUT) split++;
  const c = d.c.map(r6);
  const hist = { v: 2, ...packKeys(d.k.slice(0, split)), c: c.slice(0, split) };
  const rec = {
    v: 2, symbol: d.symbol, name: d.name, currency: d.currency, type: d.type, exchange: d.exchange, tz: d.tz,
    cut: CUT, ...packKeys(d.k.slice(split)), c: c.slice(split), fe: d.fe, divs: d.divs, splits: d.splits,
    fixes: d.fixes, src: d.src, price: d.price, priceTime: d.priceTime,
  };
  return { hist, rec };
}

/** 5 günlük gün içi veriden hem 1H (5d) hem 1G (son gün) görünümü. */
function packIntraday(i5, daily) {
  const pack = (t, c, a, base) => {
    const sameA = a.every((v, j) => v === c[j]);
    return { tz: i5.tz, t, c, ...(sameA ? {} : { a }), base };
  };
  if (!i5.t.length) return null;
  const lastKey = dateKey(i5.t[i5.t.length - 1], i5.tz);
  let from = i5.t.length - 1;
  while (from > 0 && dateKey(i5.t[from - 1], i5.tz) === lastKey) from--;
  let base1 = null;
  if (daily?.k.length) {
    let bi = lastIndexAtOrBefore(daily.k, lastKey);
    if (bi >= 0 && daily.k[bi] === lastKey) bi--;
    if (bi >= 0) base1 = { k: daily.k[bi], c: daily.c[bi], a: daily.a[bi] };
  }
  return {
    '5d': pack(i5.t, i5.c, i5.a, i5.base),
    '1d': pack(i5.t.slice(from), i5.c.slice(from), i5.a.slice(from), base1),
  };
}

// --- İş Yatırım resmi sermaye olayları / temettüler (BIST hisseleri) ---
// Olaylar nadiren değişir; her hissenin kaydı önceki yayından (data/isy.json) okunur ve her turda
// yalnızca en eskileri, süre sınırı içinde yenilenir (siteyi yormamak için). Kaydı olmayan hisse
// geçici olarak Yahoo verisi + tahminle işlenir.
const ISY_MAX_AGE = 6 * 3600 * 1000;
async function loadIsyCache() {
  const local = process.env.ISY_CACHE; // test için yerel dosya
  if (local && fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  const url = process.env.PREV_SITE_URL || (repo ? `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/` : null);
  if (url) {
    try {
      const r = await fetch(url + 'data/isy.json', { signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch { /* ilk yayın ya da erişim hatası */ }
  }
  return { v: 1, s: {} };
}

async function refreshIsy(cache, symbols) {
  const now = Date.now();
  const stale = symbols.filter((s) => !(now - Date.parse(cache.s[s]?.at || 0) < ISY_MAX_AGE))
    .sort((a, b) => Date.parse(cache.s[a]?.at || 0) - Date.parse(cache.s[b]?.at || 0));
  const missing = symbols.filter((s) => !cache.s[s]).length;
  const budgetSec = Number(process.env.ISY_BUDGET_SEC) || (missing > symbols.length / 2 ? 12 * 60 : 4 * 60);
  const deadline = now + budgetSec * 1000;
  let ok = 0, fail = 0, i = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < stale.length && Date.now() < deadline) {
      const sym = stale[i++];
      try {
        const ca = await fetchCorporateActions(sym, { timeout: 30000 });
        cache.s[sym] = { at: new Date().toISOString(), e: packCA(ca || []) };
        ok++;
      } catch {
        fail++;
        if (fail >= 15 && ok === 0) i = stale.length; // erişilemiyor: bu turda vazgeç
      }
    }
  }));
  const have = symbols.filter((s) => cache.s[s]).length;
  console.log(`İş Yatırım: ${ok} hisse yenilendi, ${fail} hata; kayıtlı ${have}/${symbols.length} (eskimiş ${stale.length})`);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

async function main() {
  const t0 = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'public'), OUT);
  fs.mkdirSync(path.join(OUT, 'data', 'd'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'data', 'r'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'data', 'i'), { recursive: true });

  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'catalog.json'), 'utf8'));
  const symbols = [...new Set(['TRY=X', ...catalog.items.map((it) => it.base || it.s)])]
    .filter((s) => !ONLY || ONLY.includes(s) || s === 'TRY=X').slice(0, LIMIT);
  const failed = [];
  const failedIntra = [];
  let bytes = 0;
  const write = (rel, obj) => {
    const s = JSON.stringify(obj);
    bytes += s.length;
    fs.writeFileSync(path.join(OUT, 'data', rel), s);
  };

  const isy = await loadIsyCache();
  isy.s = isy.s || {};
  await refreshIsy(isy, symbols.filter((s) => isyCode(s)));
  // Tahminle düzeltilen günlerin gerçek değişimi için ayrı süre (uç nokta yavaş; sonuçlar kalıcı)
  const hintDeadline = Date.now() + (Number(process.env.ISY_HINT_SEC) || 300) * 1000;
  let hintsFetched = 0;

  const extraFx = new Set();
  const doSymbol = async (sym) => {
    try {
      const isyRec = isy.s[sym];
      const ca = isyRec?.e?.length ? unpackCA(isyRec.e) : null;
      const raw = await getDailyRaw(sym);
      let daily = processDaily(raw, ca, isyRec?.dr || null, isyRec?.px || null);
      if (ca && Date.now() < hintDeadline) {
        let again = false;
        // Yahoo'nun donuk fiyat dönemleri: İş Yatırım ham kapanışlarını bir kez çekip sakla
        for (const [from, anchor] of (daily.needPx || []).slice(-2)) {
          try {
            const got = await fetchRawCloses(sym, from, anchor);
            isyRec.px = { ...(isyRec.px || {}), ...got, [anchor]: got[anchor] || 0 };
            hintsFetched++;
            again = true;
          } catch { break; }
        }
        if (again) daily = processDaily(raw, ca, isyRec.dr || null, isyRec.px);
        // Resmi kayıtla açıklanamayan sıçramalar tahminle düzeltilir; o günün gerçek değişimini
        // İş Yatırım ham fiyatından bir kez alıp sakla (yoksa o gün değişim 0 sayılır)
        const need = (daily.need || []).filter((k) => !(isyRec.dr && k in isyRec.dr)).slice(-6); // en yeniler önce
        if (need.length) {
          try {
            isyRec.dr = { ...(isyRec.dr || {}), ...(await fetchDayReturns(sym, need, ca)) };
            hintsFetched += need.length;
            daily = processDaily(raw, ca, isyRec.dr, isyRec.px || null);
          } catch { /* sonraki tura */ }
        }
      }
      if (!daily.k.length) throw new Error('Bu sembol için fiyat geçmişi yok');
      const { hist, rec } = packDaily(daily);
      write(`d/${staticFileName(sym)}.json`, hist);
      write(`r/${staticFileName(sym)}.json`, rec);
      if (daily.currency && !['USD', 'TRY', 'GBp', 'ILA', 'ZAc'].includes(daily.currency)) extraFx.add(`${daily.currency}=X`);
      try {
        const intra = await getIntraday(sym, '5d');
        const packed = packIntraday(intra, daily);
        // Gün içi verisi olmayanlar için de dosya yaz (tarayıcıda 404 hatası olmasın)
        write(`i/${staticFileName(sym)}.json`, packed || { '5d': null, '1d': null });
      } catch (e) {
        if (e.status === 404) write(`i/${staticFileName(sym)}.json`, { '5d': null, '1d': null });
        else failedIntra.push(sym);
        console.warn(`  gün içi yok: ${sym} (${e.message})`);
      }
    } catch (e) {
      failed.push(sym);
      console.warn(`  HATA: ${sym} (${e.message})`);
    }
  };

  console.log(`${symbols.length} sembol işleniyor (eşzamanlı ${CONCURRENCY})…`);
  let done = 0;
  await pool(symbols, CONCURRENCY, async (sym) => {
    await doSymbol(sym);
    if (++done % 100 === 0) console.log(`  ${done}/${symbols.length}`);
  });
  const fx = [...extraFx].filter((s) => !symbols.includes(s));
  if (fx.length) await pool(fx, CONCURRENCY, doSymbol);

  // Ön yüzü statik moda al
  const builtAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'js', 'config.js'),
    `// build-static.mjs tarafından üretildi\nexport const STATIC = true;\nexport const BUILT_AT = ${JSON.stringify(builtAt)};\n`);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  // Bu turda alınamayanların önceki sürümdeki dosyaları korunur (iş akışı bu listeyi kullanır)
  const failedFiles = [
    ...failed.flatMap((s) => ['d', 'r', 'i'].map((dir) => `data/${dir}/${staticFileName(s)}.json`)),
    ...failedIntra.map((s) => `data/i/${staticFileName(s)}.json`),
  ];
  if (hintsFetched) console.log(`İş Yatırım: ${hintsFetched} gün / dönem için ham fiyat alındı`);
  write('isy.json', isy);
  write('meta.json', { builtAt, symbols: symbols.length - failed.length, failed, failedFiles });

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`Bitti: ${symbols.length - failed.length}/${symbols.length} sembol, ${(bytes / 1e6).toFixed(1)} MB veri, ${secs} sn -> ${OUT}`);
  // Yahoo erişimi büyük ölçüde başarısızsa yayınlamayı durdur (önceki site yayında kalır)
  if (failed.length > symbols.length * 0.2) {
    console.error(`Çok fazla hata (${failed.length}); site yayınlanmayacak.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
