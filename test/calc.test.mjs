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

function yahoo({ keys, closes, tz = 'Europe/Istanbul', divs = [], splits = [], currency = 'TRY', ts, symbol = 'TEST' }) {
  const dividends = {};
  for (const [k, amount] of divs) dividends[ist(k)] = { amount, date: ist(k) };
  const splitEv = {};
  for (const [k, numerator, denominator] of splits) splitEv[ist(k)] = { date: ist(k), numerator, denominator, splitRatio: `${numerator}:${denominator}` };
  return {
    meta: { symbol, currency, exchangeTimezoneName: tz, instrumentType: 'EQUITY' },
    timestamp: ts || keys.map(ist),
    indicators: { quote: [{ close: closes }] },
    events: { dividends, splits: splitEv },
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

test('Yahoo bölünme kaydı var ama fiyata yansımamışsa (tarihi kaymış) tam oranla düzeltilir', () => {
  // CCOLA: 1 Ağustos 2024'te 1'e 11 bedelsiz; Yahoo kaydı 13 Ağustos'ta, kapanışlar düzeltilmemiş,
  // temettü tutarları ise 11'e bölünmüş.
  const d = processDaily(yahoo({
    symbol: 'CCOLA.IS',
    keys: ['2024-05-24', '2024-05-27', '2024-07-31', '2024-08-01', '2024-08-02'],
    closes: [600, 590, 843.84, 78.27, 77.6],
    divs: [['2024-05-27', 0.715]],
    splits: [['2024-08-13', 1100, 100]],
  }));
  close(d.c[2], 843.84 / 11);
  close(d.c[0], 600 / 11);
  close(d.c[3], 78.27);
  assert.deepEqual(d.fixes, [{ type: 'split', k: '2024-08-01', ratio: 11 }]);
  // O günün gerçek hareketi korunur (+%1,7), sıçrama yok
  close(d.c[3] / d.c[2] - 1, 78.27 / (843.84 / 11) - 1);
  // Temettü verimi düzeltilmiş fiyata göre: 0,715 / (600 / 11)
  close(d.a[0] / d.c[0], 1 - 0.715 / (600 / 11));
});

test('BIST: bölünme kaydı olmadan tek günde %40+ düşüş bedelsiz kabul edilip giderilir', () => {
  const d = processDaily(yahoo({
    symbol: 'ADEL.IS',
    keys: ['2023-12-28', '2023-12-29', '2024-01-02', '2024-01-03'],
    closes: [100, 101, 9.26, 9.4],
    divs: [['2023-12-29', 2]],
  }));
  close(d.c[1], 9.26);
  close(d.c[0], 100 * 9.26 / 101);
  close(d.c[3], 9.4);
  assert.equal(d.fixes[0].type, 'corp');
  // Temettü tutarı ham fiyatla aynı birimde: verim 2 / 100
  close(d.a[0] / d.c[0], 1 - 2 / 100);
});

test('BIST ±%10 döneminde (2020-03-16 sonrası) iki günlük sınırı aşan hareket de düzeltilir', () => {
  // YYAPI 2025-08-26: %50 bedelsiz → -%35 (eski -%40 eşiğine takılmıyordu)
  const d = processDaily(yahoo({
    symbol: 'YYAPI.IS',
    keys: ['2025-08-22', '2025-08-25', '2025-08-26', '2025-08-27'],
    closes: [30, 30.6, 19.92, 19.07],
  }));
  close(d.c[1], 19.92);
  assert.equal(d.fixes[0].type, 'corp');
  // Yahoo'nun bir günü atladığı iki günlük -%19 hareket (0,9 × 0,9) gerçektir, dokunulmaz
  const g = processDaily(yahoo({ symbol: 'IHLAS.IS', keys: ['2026-11-23', '2026-11-25'], closes: [10, 8.1] }));
  assert.deepEqual(g.c, [10, 8.1]);
  // ±%20 döneminde -%28 gerçek olabilir; deprem sonrası gibi uzun aralar da geniş eşikle bakılır
  const old = processDaily(yahoo({ symbol: 'TEST.IS', keys: ['2019-05-02', '2019-05-03'], closes: [10, 7.2] }));
  assert.deepEqual(old.c, [10, 7.2]);
  const quake = processDaily(yahoo({ symbol: 'CCOLA.IS', keys: ['2023-02-07', '2023-02-15'], closes: [160.6, 190.8] }));
  assert.deepEqual(quake.c, [160.6, 190.8]);
});

test('İş Yatırım resmi olayı: Yahoo kaydırılmış sıçrama resmi oranla düzeltilir, temettüler resmi kayıttan', () => {
  // CCOLA: resmi bedelsiz 13.08.2024 (oran 1/11) ama Yahoo 1-12 Ağustos'u da 11'e bölmüş (sıçrama 1 Ağustos'ta)
  const ca = [
    { k: '2024-05-27', t: '04', f: 0.99, d: 7.8626 },
    { k: '2024-08-13', t: '02', f: 1 / 11 },
  ];
  const d = processDaily(yahoo({
    symbol: 'CCOLA.IS',
    keys: ['2024-05-24', '2024-05-27', '2024-07-31', '2024-08-01', '2024-08-13', '2024-08-14'],
    closes: [790, 780, 846, 78.27, 69.35, 67.75],
    divs: [['2024-05-27', 0.715]], // Yahoo'nun temettüsü kullanılmaz
  }), ca);
  close(d.c[2], 846 / 11);
  close(d.c[0], 790 / 11);
  assert.deepEqual(d.fixes, [{ type: 'ca', k: '2024-08-13', t: '02', factor: 0.09090909 }]);
  assert.equal(d.src, 'isyatirim');
  assert.deepEqual(d.divs, [['2024-05-27', 7.8626]]);
  close(d.a[0] / d.c[0], 0.99); // resmi temettü ayar oranı
});

test('İş Yatırım küçük olay: olağan günden ayırt edilemez; o günün gerçek değişimine göre karar verilir', () => {
  const ca = [{ k: '2025-03-10', t: '02', f: 1 / 1.1 }]; // %10 bedelsiz
  const keys = ['2025-03-06', '2025-03-07', '2025-03-10', '2025-03-11'];
  // Gerçek değişim bilinmiyorsa dokunulmaz, o gün "gerekli" olarak bildirilir (derleme İş Yatırım'dan çeker)
  const unknown = processDaily(yahoo({ symbol: 'TEST.IS', keys, closes: [100, 101, 92.3, 93] }), ca);
  assert.deepEqual(unknown.c, [100, 101, 92.3, 93]);
  assert.deepEqual(unknown.need, ['2025-03-10']);
  // O gün gerçek değişim +%0,5: Yahoo'daki -%8,6 düzeltilmemiş bedelsizdir → uygulanır
  const dayRet = { '2025-03-10': 1.0052 };
  const raw = processDaily(yahoo({ symbol: 'TEST.IS', keys, closes: [100, 101, 92.3, 93] }), ca, dayRet);
  close(raw.c[1], 101 / 1.1);
  assert.equal(raw.fixes[0].type, 'ca');
  // Yahoo zaten düzeltmişse (o gün +%0,5 görünüyor) uygulanmaz
  const adjusted = processDaily(yahoo({ symbol: 'TEST.IS', keys, closes: [90.9, 91.8, 92.3, 93] }), ca, dayRet);
  assert.deepEqual(adjusted.c, [90.9, 91.8, 92.3, 93]);
  assert.deepEqual(adjusted.fixes, []);
});

test('İş Yatırım: Yahoo olayı kendi yanlış oranıyla kısmen uygulamışsa kalan kısım düzeltilir', () => {
  // SEYKM 2022-09-22: resmi oran 0,6949; Yahoo kaydı 1,0989 ile ölçeklemiş, fiyatta -%19,9 kalmış
  const ca = [{ k: '2022-09-22', t: '09', f: 0.6949 }];
  const d = processDaily(yahoo({
    symbol: 'SEYKM.IS', keys: ['2022-09-20', '2022-09-21', '2022-09-22', '2022-09-23'], closes: [5.3, 5.34, 4.28, 4.3],
    splits: [['2022-09-22', 109.888886, 100]],
  }), ca);
  close(d.c[2] / d.c[1], 4.28 / (5.34 * 0.6949 * 1.09888886)); // o günün gerçek hareketi (+%5) korunur
  assert.equal(d.fixes[0].type, 'ca');
});

test('İş Yatırım: resmi karşılığı olmayan Yahoo bölünmesi geri alınır', () => {
  // HLGYO: Yahoo 2025-06-18'de %4,35 bedelsiz uygulamış (önceki fiyatlar /1,0435), resmi kayıtta yalnız temettü var
  const ca = [{ k: '2025-06-18', t: '04', f: 0.9984 }, { k: '2025-09-18', t: '09', f: 1 / 1.0435 }];
  const d = processDaily(yahoo({
    symbol: 'HLGYO.IS', keys: ['2025-06-16', '2025-06-17', '2025-06-18', '2025-06-19'],
    closes: [2.3 / 1.0434782, 2.31 / 1.0434782, 2.32, 2.33],
    splits: [['2025-06-18', 104.34782, 100], ['2025-09-18', 104.34782, 100]],
  }), ca);
  close(d.c[1], 2.31);
  assert.deepEqual(d.fixes.map((f) => f.type), ['phantom']);
});

test('Yahoo donuk fiyat dönemi (BIST) İş Yatırım ham kapanışlarıyla doldurulur', () => {
  // KSTUR: Yahoo fiyatı aylarca 11,81'de takılı, sonra gerçek fiyat (310) geliyor
  const keys = [], closes = [], px = {};
  for (let i = 0; i < 12; i++) {
    const k = `2023-03-${String(6 + i).padStart(2, '0')}`;
    keys.push(k); closes.push(11.81); px[k] = 250 + i * 3;
  }
  keys.push('2023-03-24'); closes.push(310); px['2023-03-24'] = 310;
  const unknown = processDaily(yahoo({ symbol: 'KSTUR.IS', keys, closes }));
  assert.deepEqual(unknown.needPx, [['2023-03-06', '2023-03-24']]);
  const d = processDaily(yahoo({ symbol: 'KSTUR.IS', keys, closes }), null, null, px);
  close(d.c[0], 250);
  close(d.c[11], 283);
  assert.equal(d.fixes[0].type, 'frozen');
  assert.ok(!d.fixes.some((f) => f.type === 'rescale')); // sahte 26 kat sıçrama kalmadı
});

test('BIST dışı: gerçek sert düşüş (ör. bilanço sonrası %52) düzeltilmez', () => {
  const d = processDaily(yahoo({
    symbol: 'AAPL', tz: 'America/New_York', currency: 'USD',
    keys: ['2000-09-27', '2000-09-28', '2000-09-29', '2000-10-02'],
    closes: [53.5, 53.5, 25.75, 24.9],
  }));
  assert.deepEqual(d.c, [53.5, 53.5, 25.75, 24.9]);
  assert.deepEqual(d.fixes, []);
});

test('ertesi gün geri dönen tek günlük sıçrama komşularıyla değiştirilir', () => {
  const d = processDaily(yahoo({
    symbol: 'BEN', tz: 'America/New_York', currency: 'USD',
    keys: ['1984-12-27', '1984-12-28', '1984-12-31', '1985-01-02'],
    closes: [10, 10.2, 4.1, 10.3],
  }));
  close(d.c[2], Math.sqrt(10.2 * 10.3));
  assert.deepEqual([d.c[0], d.c[1], d.c[3]], [10, 10.2, 10.3]);
  assert.equal(d.fixes[0].type, 'spike');
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
  const hist = { k0: '2024-02-28', dk: [0, 1], c: [100, 102] };
  const rec = { symbol: 'X', currency: 'USD', k0: '2024-03-01', dk: [0, 4], c: [101, 104], fe: [['2024-03-01', 0.98]] };
  const d = unpackDaily(hist, rec);
  assert.deepEqual(d.k, ['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-05']);
  assert.deepEqual(d.c, [100, 102, 101, 104]);
  assert.deepEqual(d.a.map((v) => +v.toFixed(6)), [98, 99.96, 101, 104]);
  assert.equal(d.symbol, 'X');
  assert.equal(d.dk, undefined);
  // istemci tarafı faktör uygulaması sunucunun a değerleriyle aynı olmalı
  const { processDaily } = await import('../public/js/calc.js');
  const ist = (k) => keyToSec(k) + 7 * 3600;
  const keys = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'];
  const srv = processDaily({
    meta: { exchangeTimezoneName: 'Europe/Istanbul' }, timestamp: keys.map(ist),
    indicators: { quote: [{ close: [100, 102, 101, 103] }] },
    events: { dividends: { a: { amount: 2, date: ist('2024-01-04') } } },
  });
  const cli = unpackDaily({ k0: null, dk: [], c: [] }, { k0: keys[0], dk: [0, 1, 1, 1], c: srv.c, fe: srv.fe });
  cli.a.forEach((v, i) => close(v, srv.a[i]));
});
