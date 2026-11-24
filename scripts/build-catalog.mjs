#!/usr/bin/env node
// Sembol kataloğunu (public/data/catalog.json) yeniden üretir.
// Her sembol Yahoo Finance'e sorulup doğrulanır; işlem görmeyenler elenir.
//
//   node scripts/build-catalog.mjs
//
// Not: Uygulamanın çalışması için bu betiği çalıştırmak gerekmez; katalog repoda hazır gelir.
// Yeni halka arzları vb. eklemek için aşağıdaki listelere ekleyip tekrar çalıştırabilirsiniz.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'catalog.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SP500_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

const GROUPS = [
  { id: 'cmd', name: 'Emtia', short: 'Emtia' },
  { id: 'bist-idx', name: 'BIST Endeksleri', short: 'BIST Endeks' },
  { id: 'us-idx', name: 'ABD Endeksleri', short: 'ABD Endeks' },
  { id: 'fx', name: 'Döviz & Kripto', short: 'Döviz/Kripto' },
  { id: 'bist', name: 'BIST Hisseleri', short: 'BIST Hisse' },
  { id: 'sp500', name: 'S&P 500 Hisseleri', short: 'S&P 500' },
  { id: 'dow', name: 'Dow Jones 30 Hisseleri', short: 'Dow 30' },
  { id: 'us-pop', name: 'Diğer Popüler ABD Hisseleri', short: 'ABD Diğer' },
  { id: 'etf', name: 'ABD ETF\'leri', short: 'ETF' },
];

const COMMODITIES = [
  { s: 'GC=F', n: 'Altın (Ons)', note: 'COMEX altın vadeli kontratı (ons başına)' },
  { s: 'GRAMALTIN', base: 'GC=F', scale: 1 / 31.1034768, n: 'Gram Altın', note: 'Ons altın ÷ 31,1035 (gram başına)' },
  { s: 'SI=F', n: 'Gümüş (Ons)', note: 'COMEX gümüş vadeli kontratı (ons başına)' },
  { s: 'GRAMGUMUS', base: 'SI=F', scale: 1 / 31.1034768, n: 'Gram Gümüş', note: 'Ons gümüş ÷ 31,1035 (gram başına)' },
  { s: 'PL=F', n: 'Platin (Ons)' },
  { s: 'PA=F', n: 'Paladyum (Ons)' },
  { s: 'HG=F', n: 'Bakır (libre)' },
  { s: 'CL=F', n: 'Ham Petrol (WTI, varil)' },
  { s: 'BZ=F', n: 'Brent Petrol (varil)' },
  { s: 'NG=F', n: 'Doğal Gaz (MMBtu)' },
];

const FX = [
  { s: 'TRY=X', n: 'Dolar / TL (USD/TRY)', t: 'fx', lockCur: 'TRY' },
  { s: 'EURTRY=X', n: 'Euro / TL (EUR/TRY)', t: 'fx' },
  { s: 'GBPTRY=X', n: 'Sterlin / TL (GBP/TRY)', t: 'fx' },
  { s: 'EURUSD=X', n: 'Euro / Dolar (EUR/USD)', t: 'fx' },
  { s: 'DX-Y.NYB', n: 'Dolar Endeksi (DXY)', t: 'index' },
  { s: 'BTC-USD', n: 'Bitcoin', t: 'crypto' },
  { s: 'ETH-USD', n: 'Ethereum', t: 'crypto' },
];

// tr: aynı endeksin temettüler dahil "toplam getiri" versiyonu
const US_INDICES = [
  { s: '^GSPC', n: 'S&P 500', tr: '^SP500TR' },
  { s: '^SP500TR', n: 'S&P 500 Toplam Getiri (TR)' },
  { s: '^IXIC', n: 'Nasdaq Composite' },
  { s: '^NDX', n: 'Nasdaq 100', tr: '^XNDX' },
  { s: '^XNDX', n: 'Nasdaq 100 Toplam Getiri (TR)' },
  { s: '^DJI', n: 'Dow Jones Sanayi (30)', tr: '^DJITR' },
  { s: '^DJITR', n: 'Dow Jones Toplam Getiri (TR)' },
  { s: '^RUT', n: 'Russell 2000', tr: '^RUTTR' },
  { s: '^RUTTR', n: 'Russell 2000 Toplam Getiri (TR)' },
  { s: '^RUI', n: 'Russell 1000' },
  { s: '^RUA', n: 'Russell 3000' },
  { s: '^OEX', n: 'S&P 100' },
  { s: '^SP400', n: 'S&P MidCap 400' },
  { s: '^SP600', n: 'S&P SmallCap 600', tr: '^SP600TR' },
  { s: '^SP600TR', n: 'S&P SmallCap 600 Toplam Getiri (TR)' },
  { s: '^SPXEW', n: 'S&P 500 Eşit Ağırlıklı' },
  { s: '^NDXE', n: 'Nasdaq 100 Eşit Ağırlıklı' },
  { s: '^NYA', n: 'NYSE Composite' },
  { s: '^XAX', n: 'NYSE American Composite' },
  { s: '^W5000', n: 'Wilshire 5000 (Tüm Piyasa)' },
  { s: '^SOX', n: 'PHLX Yarı İletken (SOX)' },
  { s: '^DJT', n: 'Dow Jones Ulaştırma' },
  { s: '^DJU', n: 'Dow Jones Kamu Hizmetleri' },
  { s: '^VIX', n: 'VIX Volatilite Endeksi' },
];

const BIST_INDICES = [
  ['XU100', 'BIST 100'], ['XU030', 'BIST 30'], ['XU050', 'BIST 50'], ['XUTUM', 'BIST Tüm'],
  ['XYUZO', 'BIST 100-30'], ['XTUMY', 'BIST Tüm-100'], ['XBANA', 'BIST Ana'], ['XYLDZ', 'BIST Yıldız'],
  ['XBANK', 'BIST Banka'], ['XLBNK', 'BIST Likit Banka'], ['X10XB', 'BIST Banka Dışı Likit 10'],
  ['XUSIN', 'BIST Sınai'], ['XUMAL', 'BIST Mali'], ['XUHIZ', 'BIST Hizmetler'], ['XUTEK', 'BIST Teknoloji'],
  ['XHOLD', 'BIST Holding ve Yatırım'], ['XTM25', 'BIST Temettü 25'], ['XHARZ', 'BIST Halka Arz'],
  ['XK030', 'BIST Katılım 30'], ['XK050', 'BIST Katılım 50'], ['XK100', 'BIST Katılım 100'], ['XKTUM', 'BIST Katılım Tüm'],
  ['XUSRD', 'BIST Sürdürülebilirlik'], ['XSD25', 'BIST Sürdürülebilirlik 25'], ['XKURY', 'BIST Kurumsal Yönetim'],
  ['XUGRA', 'BIST Geri Alım'], ['XKOBI', 'BIST KOBİ Sanayi'],
  ['XAKUR', 'BIST Aracı Kurumlar'], ['XBLSM', 'BIST Bilişim'], ['XELKT', 'BIST Elektrik'],
  ['XFINK', 'BIST Finansal Kiralama Faktoring'], ['XGIDA', 'BIST Gıda İçecek'], ['XGMYO', 'BIST Gayrimenkul Y.O.'],
  ['XILTM', 'BIST İletişim'], ['XINSA', 'BIST İnşaat'], ['XKAGT', 'BIST Orman Kağıt Basım'],
  ['XKMYA', 'BIST Kimya Petrol Plastik'], ['XMADN', 'BIST Madencilik'], ['XMANA', 'BIST Metal Ana'],
  ['XMESY', 'BIST Metal Eşya Makina'], ['XSGRT', 'BIST Sigorta'], ['XSPOR', 'BIST Spor'],
  ['XTAST', 'BIST Taş Toprak'], ['XTCRT', 'BIST Ticaret'], ['XTEKS', 'BIST Tekstil Deri'],
  ['XTRZM', 'BIST Turizm'], ['XULAS', 'BIST Ulaştırma'], ['XYORT', 'BIST Menkul Kıymet Y.O.'],
  ['XSIST', 'BIST İstanbul'], ['XSANK', 'BIST Ankara'], ['XSIZM', 'BIST İzmir'], ['XSBUR', 'BIST Bursa'],
  ['XSKOC', 'BIST Kocaeli'], ['XSADA', 'BIST Adana'], ['XSANT', 'BIST Antalya'], ['XSBAL', 'BIST Balıkesir'],
  ['XSDNZ', 'BIST Denizli'], ['XSKAY', 'BIST Kayseri'], ['XSKON', 'BIST Konya'], ['XSMNS', 'BIST Manisa'],
  ['XSTKR', 'BIST Tekirdağ'],
];

const BIST_STOCKS = `
A1CAP A1YEN ACSEL ADEL ADESE ADGYO AEFES AFYON AGESA AGHOL AGROT AGYO AHGAZ AHSGY AKBNK AKCNS AKENR AKFGY AKFIS
AKFYE AKGRT AKMGY AKSA AKSEN AKSGY AKSUE AKYHO ALARK ALBRK ALCAR ALCTL ALFAS ALGYO ALKA ALKIM ALKLC ALTNY ALVES
ANELE ANGEN ANHYT ANSGR ARASE ARCLK ARDYZ ARENA ARMGD ARSAN ARTMS ARZUM ASELS ASGYO ASTOR ASUZU ATAGY ATAKP ATATP
ATATR ATEKS ATLAS ATSYH AVGYO AVHOL AVOD AVPGY AVTUR AYCES AYDEM AYEN AYES AYGAZ AZTEK BAGFS BAHKM BAKAB BALAT
BALSU BANVT BARMA BASCM BASGZ BAYRK BEGYO BERA BESLR BESTE BEYAZ BFREN BIENY BIGCH BIGEN BIGTK BIMAS BINBN BINHO
BIOEN BIZIM BJKAS BLCYT BLUME BMSCH BMSTL BNTAS BOBET BORLS BORSK BOSSA BRISA BRKO BRKSN BRKVY BRLSM BRMEN BRSAN
BRYAT BSOKE BTCIM BUCIM BULGS BURCE BURVA BVSAN BYDNR CANTE CASA CATES CCOLA CELHA CEMAS CEMTS CEMZY CEOEM CGCAM
CIMSA CLEBI CMBTN CMENT CONSE COSMO CRDFA CRFSA CUSAN CVKMD CWENE DAGI DAPGM DARDL DCTTR DENGE DERHL DERIM DESA
DESPC DEVA DGATE DGGYO DGNMO DIRIT DITAS DMRGD DMSAS DNISI DOAS DOCO DOFER DOFRB DOGUB DOHOL DOKTA DSTKF DUNYH
DURDO DURKN DYOBY DZGYO EBEBK ECILC ECOGR ECZYT EDATA EDIP EFOR EGEEN EGEGY EGEPO EGGUB EGPRO EGSER EKGYO EKIZ
EKOS EKSUN ELITE EMKEL EMNIS ENDAE ENERY ENJSA ENKAI ENSRI ENTRA EPLAS ERBOS ERCB EREGL ERSU ESCAR ESCOM ESEN
ETILR ETYAT EUHOL EUKYO EUPWR EUREN EUYO EYGYO FADE FENER FLAP FMIZP FONET FORMT FORTE FRIGO FRMPL FROTO FZLGY
GARAN GARFA GEDIK GEDZA GENIL GENTS GEREL GESAN GIPTA GLBMD GLCVY GLRMK GLRYH GLYHO GMTAS GOKNR GOLTS GOODY GOZDE
GRNYO GRSEL GRTHO GSDDE GSDHO GSRAY GUBRF GUNDG GWIND GZNMI HALKB HATEK HATSN HDFGS HEDEF HEKTS HKTM HLGYO HOROZ
HRKET HTTBT HUBVC HUNER HURGZ ICBCT ICUGS IDGYO IEYHO IHAAS IHEVA IHGZT IHLAS IHLGM IHYAY IMASM INDES INFO INGRM
INTEK INTEM INVEO INVES ISATR ISBIR ISBTR ISCTR ISDMR ISFIN ISGSY ISGYO ISKPL ISMEN ISSEN ISYAT IZENR IZFAS IZINV
IZMDC JANTS KAPLM KAREL KARSN KARTN KATMR KAYSE KBORU KCAER KCHOL KENT KERVN KFEIN KGYO KIMMR KLGYO KLKIM KLMSN
KLNMA KLRHO KLSER KLSYN KLYPV KMPUR KNFRT KOCMT KONKA KONTR KONYA KOPOL KORDS KOTON KRDMA KRDMB KRDMD KRGYO KRONT
KRPLS KRSTL KRTEK KRVGD KSTUR KTLEV KTSKR KUTPO KUVVA KUYAS KZBGY KZGYO LIDER LIDFA LILAK LINK LKMNH LMKDC LOGO
LRSHO LUKSK LYDHO LYDYE MAALT MACKO MAGEN MAKIM MAKTK MANAS MARBL MARMR MARTI MAVI MEDTR MEGAP MEGMT MEKAG MEPET
MERCN MERIT MERKO METRO MEYSU MGROS MHRGY MIATK MMCAS MNDRS MNDTR MOBTL MOGAN MOPAS MPARK MRGYO MRSHL MSGYO MTRKS
MTRYO MZHLD NATEN NETAS NIBAS NTGAZ NTHOL NUGYO NUHCM OBAMS OBASE ODAS ODINE OFSYM ONCSM ONRYT ORCAY ORGE ORMA
OSMEN OSTIM OTKAR OTTO OYAKC OYAYO OYLUM OYYAT OZATD OZGYO OZKGY OZRDN OZSUB OZYSR PAGYO PAHOL PAMEL PAPIL PARSN
PASEU PATEK PCILT PEKGY PENGD PENTA PETKM PETUN PGSUS PINSU PKART PKENT PLTUR PNLSN PNSUT POLHO POLTK PRDGS PRKAB
PRKME PRZMA PSDTC PSGYO QNBFK QNBTR QUAGR RALYH RAYSG REEDR RGYAS RNPOL RODRG RTALB RUBNS RYGYO RYSAS SAFKR SAHOL
SAMAT SANEL SANFM SANKO SARKY SASA SAYAS SDTTR SEGMN SEGYO SEKFK SEKUR SELEC SELVA SERNT SEYKM SILVR SISE SKBNK
SKTAS SKYLP SKYMD SMART SMRTG SMRVA SNGYO SNICA SNPAM SODSN SOKE SOKM SONME SRVGY SUMAS SUNTK SURGY SUWEN SVGYO
TABGD TARKM TATEN TATGD TAVHL TBORG TCELL TCKRC TDGYO TEHOL TEKTU TERA TEZOL TGSAS THYAO TKFEN TKNSA TLMAN TMPOL
TMSN TNZTP TOASO TRALT TRCAS TRENJ TRGYO TRHOL TRILC TRMET TSGYO TSKB TSPOR TTKOM TTRAK TUCLK TUKAS TUPRS TUREX
TURGG TURSG UCAYM UFUK ULAS ULKER ULUFA ULUSE ULUUN UMPAS UNLU USAK VAKBN VAKFA VAKFN VAKKO VANGD VBTYZ VERTU
VERUS VESBE VESTL VKFYO VKGYO VKING VRGYO VSNMD YAPRK YATAS YAYLA YBTAS YEOTK YESIL YGGYO YIGIT YKBNK YKSLN YONGA
YUNSA YYAPI YYLGD ZEDUR ZERGY ZOREN ZRGYO
`.split(/\s+/).filter(Boolean);

const DOW30 = 'AAPL AMGN AMZN AXP BA CAT CRM CSCO CVX DIS GS HD HON IBM JNJ JPM KO MCD MMM MRK MSFT NKE NVDA PG SHW TRV UNH V VZ WMT'.split(' ');

// S&P 500 dışında kalan, Türkiye'de de çok takip edilen ABD'de işlem gören hisseler
const US_POPULAR = `ASML AZN PDD MELI ARM TEAM MDB GFS CCEP SHOP MSTR ZS JD BIDU NTES RIVN LCID SIRI ZM DOCU OKTA
BABA TSM NVO SONY TM SAP RBLX SNOW NET U SPOT SOFI RKLB IONQ NIO COIN HOOD PLTR APP DDOG TTD`.split(/\s+/).filter(Boolean);

const ETFS = 'SPY VOO IVV QQQ DIA IWM VTI VT VXUS SCHD VIG VYM XLK XLF XLE XLV SMH SOXX ARKK TLT IEF GLD IAU SLV GDX SIL'.split(' ');

async function yahooMeta(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) return null;
      const ts = res.timestamp || [];
      const closes = (res.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
      return { meta: res.meta, lastTs: ts.length ? ts[ts.length - 1] : 0, bars: closes.length };
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Yahoo erişilemedi: ${sym}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function validateAll(symbols) {
  const out = new Map();
  let i = 0;
  const now = Date.now() / 1000;
  async function worker() {
    while (i < symbols.length) {
      const s = symbols[i++];
      const m = await yahooMeta(s);
      // Bazı semboller için Yahoo'da yalnızca anlık fiyat var, geçmiş yok: grafiği çizilemez, ele.
      if (m && m.lastTs && now - m.lastTs < 45 * 86400 && m.bars >= 5) out.set(s, m.meta);
      else console.warn('  elendi:', s, !m ? '(bulunamadı)' : m.bars < 5 ? '(geçmiş veri yok)' : '(eski veri)');
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

function cleanCompanyName(name) {
  let n = (name || '').replace(/\s+/g, ' ').trim();
  const suffix = /[\s,]+(A\.?\s?S\.?|A\.Ş\.?|AS|AŞ|Anonim Sirketi|Anonim Şirketi|Anonim Ortakligi|Anonim Ortaklığı|T\.A\.S\.?|T\.A\.Ş\.?|A\.O\.?)$/i;
  for (let k = 0; k < 3; k++) n = n.replace(suffix, '').trim();
  return n;
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', q = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (q) {
        if (ch === '"' && line[k + 1] === '"') { cur += '"'; k++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k]])));
}

async function main() {
  console.log('S&P 500 listesi indiriliyor…');
  const csv = await (await fetch(SP500_CSV, { headers: { 'User-Agent': UA } })).text();
  const sp500 = parseCsv(csv).map((r) => ({ s: r.Symbol.replace(/\./g, '-'), n: r.Security }));
  const spNames = new Map(sp500.map((x) => [x.s, x.n]));

  const all = new Set([
    ...COMMODITIES.map((c) => c.base || c.s), ...FX.map((x) => x.s), ...US_INDICES.map((x) => x.s),
    ...BIST_INDICES.map(([s]) => s + '.IS'), ...BIST_STOCKS.map((s) => s + '.IS'),
    ...sp500.map((x) => x.s), ...DOW30, ...US_POPULAR, ...ETFS,
  ]);
  console.log(`${all.size} sembol Yahoo Finance üzerinde doğrulanıyor…`);
  const valid = await validateAll([...all]);

  const items = new Map();
  const add = (item, group) => {
    const ex = items.get(item.s);
    if (ex) { if (!ex.g.includes(group)) ex.g.push(group); return; }
    items.set(item.s, { ...item, g: [group] });
  };

  for (const c of COMMODITIES) if (valid.has(c.base || c.s)) add({ ...c, t: 'commodity', cur: 'USD' }, 'cmd');
  for (const x of FX) if (valid.has(x.s)) add({ ...x, cur: valid.get(x.s).currency }, 'fx');
  for (const x of US_INDICES) if (valid.has(x.s)) add({ ...x, t: 'index', cur: 'USD' }, 'us-idx');
  for (const [s, n] of BIST_INDICES) if (valid.has(s + '.IS')) add({ s: s + '.IS', n, t: 'index', cur: 'TRY' }, 'bist-idx');
  for (const s of [...BIST_STOCKS].sort()) {
    const m = valid.get(s + '.IS');
    if (m) add({ s: s + '.IS', n: cleanCompanyName(m.longName || m.shortName || s), t: 'stock', cur: 'TRY' }, 'bist');
  }
  for (const x of [...sp500].sort((a, b) => a.s.localeCompare(b.s))) if (valid.has(x.s)) add({ s: x.s, n: x.n, t: 'stock', cur: 'USD' }, 'sp500');
  for (const s of DOW30) if (valid.has(s)) add({ s, n: spNames.get(s) || cleanCompanyName(valid.get(s).longName), t: 'stock', cur: 'USD' }, 'dow');
  for (const s of [...US_POPULAR].sort()) {
    if (spNames.has(s) || !valid.has(s)) continue;
    const m = valid.get(s);
    add({ s, n: cleanCompanyName(m.longName || m.shortName || s), t: 'stock', cur: m.currency || 'USD' }, 'us-pop');
  }
  for (const s of ETFS) if (valid.has(s)) add({ s, n: valid.get(s).longName || s, t: 'etf', cur: 'USD' }, 'etf');

  const catalog = {
    generated: new Date().toISOString().slice(0, 10),
    source: 'Yahoo Finance (doğrulama), S&P 500 listesi: github.com/datasets/s-and-p-500-companies',
    groups: GROUPS,
    items: [...items.values()].map((it) => {
      if (it.tr && !items.has(it.tr)) delete it.tr; // toplam getiri versiyonu Yahoo'da yoksa bağlantı verme
      const o = { s: it.s, n: it.n, t: it.t, cur: it.cur, g: it.g };
      for (const k of ['base', 'scale', 'tr', 'note', 'lockCur']) if (it[k] !== undefined) o[k] = it[k];
      return o;
    }),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(catalog));
  const counts = Object.fromEntries(GROUPS.map((g) => [g.id, catalog.items.filter((i) => i.g.includes(g.id)).length]));
  console.log('Yazıldı:', path.relative(ROOT, OUT), counts);
}

main().catch((e) => { console.error(e); process.exit(1); });
