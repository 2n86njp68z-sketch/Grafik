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
import { getDaily, getIntraday } from '../lib/yahoo.js';
import { dateKey, lastIndexAtOrBefore, staticFileName } from '../public/js/calc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'site'));
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;
const LIMIT = Number(process.env.LIMIT) || Infinity; // test için: ilk N sembol

const r6 = (v) => (v == null ? v : Number(v.toPrecision(6)));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

/** Günlük veriyi küçült: tarihleri gün farkı olarak, temettü yoksa a'yı hiç yazma. */
function packDaily(d) {
  const dk = [];
  let prev = null;
  for (const k of d.k) {
    const s = Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 86400000;
    dk.push(prev == null ? 0 : s - prev);
    prev = s;
  }
  const c = d.c.map(r6);
  const a = d.a.map(r6);
  const sameA = a.every((v, i) => v === c[i]);
  return {
    v: 1, symbol: d.symbol, name: d.name, currency: d.currency, type: d.type, exchange: d.exchange, tz: d.tz,
    k0: d.k[0], dk, c, ...(sameA ? {} : { a }), divs: d.divs, splits: d.splits, fixes: d.fixes,
    price: d.price, priceTime: d.priceTime,
  };
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
  fs.mkdirSync(path.join(OUT, 'data', 'i'), { recursive: true });

  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'catalog.json'), 'utf8'));
  const symbols = [...new Set(['TRY=X', ...catalog.items.map((it) => it.base || it.s)])].slice(0, LIMIT);
  const failed = [];
  let bytes = 0;
  const write = (rel, obj) => {
    const s = JSON.stringify(obj);
    bytes += s.length;
    fs.writeFileSync(path.join(OUT, 'data', rel), s);
  };

  const extraFx = new Set();
  const doSymbol = async (sym) => {
    try {
      const daily = await getDaily(sym);
      write(`d/${staticFileName(sym)}.json`, packDaily(daily));
      if (daily.currency && !['USD', 'TRY', 'GBp', 'ILA', 'ZAc'].includes(daily.currency)) extraFx.add(`${daily.currency}=X`);
      try {
        const intra = await getIntraday(sym, '5d');
        const packed = packIntraday(intra, daily);
        if (packed) write(`i/${staticFileName(sym)}.json`, packed);
      } catch (e) {
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
  write('meta.json', { builtAt, symbols: symbols.length - failed.length, failed });

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`Bitti: ${symbols.length - failed.length}/${symbols.length} sembol, ${(bytes / 1e6).toFixed(1)} MB veri, ${secs} sn -> ${OUT}`);
  // Yahoo erişimi büyük ölçüde başarısızsa yayınlamayı durdur (önceki site yayında kalır)
  if (failed.length > symbols.length * 0.2) {
    console.error(`Çok fazla hata (${failed.length}); site yayınlanmayacak.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
