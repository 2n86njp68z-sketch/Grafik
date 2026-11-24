import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateKey, tzOffsetSec, keyToSec, processDaily, processIntraday, makeDailySeries, makeIntradaySeries,
  makeRateLookup, convertSeries, conversionPlan, rangeStartKey, changeBetweenDates, baseIndexForKey,
  annualized, normalizeCurrency,
} from '../public/js/calc.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

// Yahoo günlük bar zaman damgası: borsanın açılış saati (İstanbul 10:00 = 07:00 UTC)
const ist = (k) => keyToSec(k) + 7 * 3600;

function yahoo({ keys, closes, tz = 'Europe/Istanbul', divs = [], currency = 'TRY', ts }) {
  const dividends = {};
  for (const [k, amount] of divs) dividends[ist(k)] = { amount, date: ist(k) };
  return {
    meta: { symbol: 'TEST', currency, exchangeTimezoneName: tz, instrumentType: 'EQUITY' },
    timestamp: ts || keys.map(ist),
    indicators: { quote: [{ close: closes }] },
    events: { dividends },
  };
}

test('dateKey borsanın yerel takvimini kullanır', () => {
  const t = Date.UTC(2024, 2, 10, 23, 30) / 1000; // 10 Mart 23:30 UTC
  assert.equal(dateKey(t, 'Europe/Istanbul'), '2024-03-11');
  assert.equal(dateKey(t, 'America/New_York'), '2024-03-10');
  assert.equal(tzOffsetSec(t, 'Europe/Istanbul'), 3 * 3600);
  // New York yaz saati: 10 Mart 2024'te başladı (UTC-4)
  assert.equal(tzOffsetSec(t, 'America/New_York'), -4 * 3600);
});

test('temettü düzeltmesi: ex-date öncesi fiyatlar (1 - D/P) ile çarpılır', () => {
  const d = processDaily(yahoo({
    keys: ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'],
    closes: [100, 102, 101, 103, 104],
    divs: [['2024-01-04', 2]],
  }));
  const f = 1 - 2 / 102;
  close(d.a[0], 100 * f);
  close(d.a[1], 102 * f);
  close(d.a[2], 101);
  close(d.a[4], 104);
  assert.deepEqual(d.c, [100, 102, 101, 103, 104]);
  assert.equal(d.divs.length, 1);
  // Toplam getiri = fiyat getirisi + yeniden yatırılan temettü
  close(d.a[4] / d.a[1] - 1, (104 / 102) * (102 / (102 - 2)) - 1);
});

test('bozuk temettü kaydı (kapanışın %50+) atlanır', () => {
  const d = processDaily(yahoo({
    keys: ['2024-01-02', '2024-01-03', '2024-01-04'],
    closes: [0.3, 0.31, 0.32],
    divs: [['2024-01-03', 69696.99]],
  }));
  assert.deepEqual(d.a, d.c);
  assert.equal(d.fixes[0].type, 'div-skip');
});

test('20 kat üstü ani sıçrama veri hatası olarak düzeltilir (2005 YTL geçişi)', () => {
  const d = processDaily(yahoo({
    keys: ['2004-12-29', '2004-12-30', '2005-01-03', '2005-01-04'],
    closes: [0.00101, 0.00102, 1.0017, 0.989],
  }));
  close(d.c[0], 1.01);
  close(d.c[1], 1.02);
  close(d.c[2], 1.0017);
  assert.deepEqual(d.fixes, [{ type: 'rescale', k: '2005-01-03', factor: 1000 }]);
});

test('aynı güne ait tekrar eden bar sonuncusuyla güncellenir, boş kapanışlar atlanır', () => {
  const keys = ['2024-01-02', '2024-01-03', '2024-01-04'];
  const ts = [...keys.map(ist), ist('2024-01-04') + 3600];
  const d = processDaily(yahoo({ keys, closes: [10, null, 11, 11.5], ts }));
  assert.deepEqual(d.k, ['2024-01-02', '2024-01-04']);
  assert.deepEqual(d.c, [10, 11.5]);
});

test('gün içi: baz = önceki günün kapanışı, düzeltme oranı günlükten gelir', () => {
  const daily = processDaily(yahoo({
    keys: ['2024-01-02', '2024-01-03', '2024-01-04'],
    closes: [100, 102, 101],
    divs: [['2024-01-04', 2]],
  }));
  const t0 = Date.UTC(2024, 0, 3, 7, 0) / 1000;
  const intra = processIntraday({
    meta: { symbol: 'TEST', exchangeTimezoneName: 'Europe/Istanbul' },
    timestamp: [t0, t0 + 900, t0 + 86400, t0 + 86400 + 900],
    indicators: { quote: [{ close: [101, 102, 100, 101] }] },
  }, daily);
  assert.deepEqual(intra.base, { k: '2024-01-02', c: 100, a: daily.a[0] });
  const f = 1 - 2 / 102;
  close(intra.a[0], 101 * f);
  close(intra.a[3], 101);
  const s = makeIntradaySeries(intra, true);
  // grafik zamanı İstanbul yerel saatine kaydırılır (+3 saat)
  assert.equal(s.time[0], t0 + 3 * 3600);
  assert.equal(s.k[2], '2024-01-04');
});

test('kur dönüşümü: aynı gün ya da önceki son kur kullanılır, kur yoksa nokta atılır', () => {
  const asset = makeDailySeries({ k: ['2004-12-31', '2005-01-03', '2005-01-04', '2005-01-05'], c: [10, 11, 12, 13], a: [10, 11, 12, 13] }, false);
  const fx = makeDailySeries({ k: ['2005-01-03', '2005-01-05'], c: [1.5, 2], a: [1.5, 2] }, false);
  const plan = conversionPlan('USD', 'TRY');
  assert.deepEqual(plan, [{ op: 'mul', fx: 'TRY=X' }]);
  const out = convertSeries(asset, [{ op: 'mul', rate: makeRateLookup(fx) }]);
  assert.deepEqual(out.k, ['2005-01-03', '2005-01-04', '2005-01-05']);
  assert.deepEqual(out.v, [16.5, 18, 26]);
  assert.equal(out.dropped, 1);
  // TL -> USD bölme
  assert.deepEqual(conversionPlan('TRY', 'USD'), [{ op: 'div', fx: 'TRY=X' }]);
  assert.deepEqual(conversionPlan('EUR', 'TRY'), [{ op: 'div', fx: 'EUR=X' }, { op: 'mul', fx: 'TRY=X' }]);
  assert.deepEqual(conversionPlan('USD', 'USD'), []);
  assert.deepEqual(normalizeCurrency('GBp'), { cur: 'GBP', scale: 0.01 });
});

test('dönem başlangıcı ay sonlarını doğru hesaplar', () => {
  assert.equal(rangeStartKey('1M', '2024-03-31'), '2024-02-29');
  assert.equal(rangeStartKey('1Y', '2024-02-29'), '2023-02-28');
  assert.equal(rangeStartKey('3M', '2026-11-24'), '2026-08-24');
  assert.equal(rangeStartKey('10Y', '2026-11-24'), '2016-11-24');
  assert.equal(rangeStartKey('MAX', '2026-11-24'), null);
});

test('tarih aralığı: tatil gününe denk gelen başlangıç önceki kapanışı kullanır', () => {
  const s = makeDailySeries({ k: ['2014-12-30', '2014-12-31', '2015-01-02', '2015-01-05'], c: [40, 42, 41, 43], a: [40, 42, 41, 43] }, false);
  const r = changeBetweenDates(s, '2015-01-01', '2015-01-05');
  assert.equal(r.k0, '2014-12-31');
  assert.equal(r.k1, '2015-01-05');
  close(r.pct, 43 / 42 - 1);
  // veri başlangıcından önceki tarih ilk bara düşer
  assert.equal(baseIndexForKey(s.k, '2000-01-01'), 0);
  // ters ya da boş aralık
  assert.equal(changeBetweenDates(s, '2015-01-05', '2015-01-05'), null);
});

test('yıllıklandırılmış getiri', () => {
  assert.equal(annualized(0.5, 100), null);
  close(annualized(1, 3652.5), Math.pow(2, 0.1) - 1);
  close(annualized(0.1, 365.25), 0.1);
});

test('statik site: dosya adı ve sıkıştırılmış günlük veri', async () => {
  const { staticFileName, unpackDaily } = await import('../public/js/calc.js');
  assert.equal(staticFileName('^GSPC'), '_5eGSPC');
  assert.equal(staticFileName('GC=F'), 'GC_3dF');
  assert.equal(staticFileName('XU100.IS'), 'XU100.IS');
  const d = unpackDaily({ k0: '2024-02-28', dk: [0, 1, 1, 4], c: [1, 2, 3, 4] });
  assert.deepEqual(d.k, ['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-05']);
  assert.deepEqual(d.a, [1, 2, 3, 4]);
  assert.equal(d.dk, undefined);
});
