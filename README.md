# Grafik

ABD ve Borsa İstanbul hisseleri, endeksler, altın, gümüş ve diğer emtialar için
**toplam getiri (temettü düzeltmeli)** grafik uygulaması. Fiyatlar tek tıkla **TL ↔ USD**
çevrilir, iki tarih arasındaki getiri büyük ve net bir şekilde gösterilir.

## 👉 Hemen aç: **https://2n86njp68z-sketch.github.io/Grafik/**

Kurulum yok; telefondan da bilgisayardan da linke dokunup açın. Telefonda tarayıcı menüsünden
**“Ana Ekrana Ekle”** derseniz uygulama gibi simgesiyle açılır. Veriler hafta içi gün boyunca
saatte bir, hafta sonu günde bir otomatik güncellenir (sayfanın altında son güncelleme saati yazar).

![Ekran görüntüsü](docs/ekran.png)

## Neler var?

- **~1.200 hazır enstrüman**, sol menüde gruplar halinde:
  - **BIST**: 596 hisse + BIST 100, BIST 30, BIST Banka, BIST Sınai endeksleri
    (diğer BIST endekslerinin geçmiş verisi Yahoo Finance'te bulunmuyor)
  - **ABD**: S&P 500'ün tamamı (503 hisse), Dow Jones 30, popüler diğer hisseler (ASML, TSM, Shopify…),
    21 endeks (S&P 500, Nasdaq, Dow, Russell, SOX, VIX; S&P 500 ve Russell 2000'in **toplam getiri** versiyonları), 26 ETF
  - **Emtia**: Altın, **Gram Altın**, Gümüş, Gram Gümüş, Platin, Paladyum, Bakır, Petrol (WTI/Brent), Doğal Gaz
  - **Döviz & Kripto**: USD/TRY, EUR/TRY, GBP/TRY, EUR/USD, Dolar Endeksi, Bitcoin, Ethereum
  - Bilgisayarda çalışan sürümde listede olmayan her şey arama kutusundan bulunur (Yahoo Finance'teki tüm semboller)
- **Dönemler**: 1G · 1H · 1A · 3A · 6A · 1Y · 5Y · 10Y · Tümü
- **Fiyat** veya **yüzde %** gösterimi; uzun dönemler için **logaritmik** ölçek
- **TL / USD** dönüşümü: her gün, o günün USD/TRY kuruyla çevrilir
  (ör. bir BIST hissesinin dolar bazında gerçek getirisi)
- **Temettü dahil (toplam getiri)**: hisse ve ETF grafikleri varsayılan olarak temettüler
  yeniden yatırılmış gibi gösterilir; anahtarla sadece fiyata dönebilirsiniz
- **Tarih aralığı getirisi**: başlangıç ve bitiş tarihi girin (veya *Grafikten seç* ile
  grafikte iki noktaya tıklayın) — ne kadar artmış/düşmüş büyük yazıyla görünür.
  Yanında süre, yıllık ortalama getiri, diğer para birimindeki getiri ve temettüsüz getiri de yazar.
- **Telefondan aç**: bilgisayarda çalışırken QR kodu okutup aynı Wi-Fi'daki telefondan kullanın, ana ekrana ekleyin
- Favoriler (☆), açık/koyu tema, paylaşılabilir bağlantı (`#s=THYAO.IS&r=5Y`)

## Kendi bilgisayarında çalıştırmak (isteğe bağlı)

Web sürümü yeterliyse bu bölüm gerekmez. Bilgisayarda çalışan sürümün farkı: veriler anlık gelir ve
arama kutusu Yahoo Finance'teki her sembolü bulur.

Tek gereksinim **[Node.js](https://nodejs.org) 18 veya üstü** (LTS sürümünü kurmanız yeterli).
Başka hiçbir paket kurulmaz, internet bağlantısı veriyi çekmek için gereklidir.

1. Bu projeyi indirin: GitHub'da **Code → Download ZIP**, sonra zip'i bir klasöre açın.
2. Başlatın:
   - **Windows**: `baslat.bat` dosyasına çift tıklayın.
   - **macOS**: `baslat.command` dosyasına çift tıklayın (ilk seferde *sağ tık → Aç* gerekebilir).
   - **Terminal** (her sistem): klasörde `npm start` (ya da `node server.js --open`).
3. Tarayıcı kendiliğinden açılır: <http://localhost:3000>.
   Açık kalan siyah pencere uygulamanın kendisidir; kapatınca uygulama da kapanır.

### Telefondan kullanmak

1. Uygulamayı bilgisayarda yukarıdaki gibi başlatın.
2. Sağ üstteki **telefon simgesine** tıklayın, çıkan **QR kodu** telefonun kamerasıyla okutun.
3. İsterseniz telefonda tarayıcı menüsünden **“Ana Ekrana Ekle”** deyin; uygulama simgesiyle açılır.

Telefon ile bilgisayar **aynı Wi-Fi**'da olmalı ve bilgisayardaki uygulama penceresi açık kalmalı.
İlk açılışta Windows “erişime izin ver” diye sorarsa **İzin ver**'e basın (Mac'te “Gelen bağlantılara
izin ver” → İzin Ver). Telefon bağlanamıyorsa Windows'ta Wi-Fi ağının **Özel ağ** olarak ayarlı olduğundan
emin olun.

Telefon erişimini istemiyorsanız uygulamayı `node server.js --open` ile başlatın; o zaman yalnızca
bu bilgisayardan açılır. Port değiştirmek için `PORT=8080` ortam değişkeni kullanılabilir.

## Hesaplamalar nasıl yapılıyor?

**Toplam getiri (temettü düzeltmesi).** Her temettü için, temettünün hak kullanım (ex-date)
gününden önceki tüm kapanışlar `1 − temettü / önceki kapanış` ile çarpılır. Bu, temettünün
alındığı gün aynı hisseye yeniden yatırıldığı varsayımıyla elde edilen getiriye eşittir
(Yahoo'nun *Adj Close* değeriyle birebir aynı yöntem; birim testlerle doğrulanır).
Bölünmeler ve bedelsiz sermaye artırımları fiyatlara zaten yansıtılmıştır.

**BIST hisseleri: resmi temettü ve sermaye artırımı kayıtları (İş Yatırım).** Yahoo'nun BIST
temettü ve bedelsiz/bedelli kayıtları eksik ya da hatalı olabildiği için bu bilgiler İş Yatırım'ın
şirket kartındaki resmi kayıtlardan alınır. Her olayın resmi *fiyat ayar oranı* kullanılır:
nakit temettüde `1 − temettü / önceki kapanış`, bedelsizde `1 / (1 + oran)`, bedelli artırımda
teorik fiyata göre oran. Fiyatlar Yahoo'dan gelir; resmi olay Yahoo fiyatında düzeltilmemiş bir
sıçramaya denk geliyorsa (Yahoo bazı bölünmeleri birkaç gün kaydırıyor) o gün resmi oranla
düzeltilir, Yahoo zaten düzeltmişse dokunulmaz. Kayıtlar sitede her hisse için günde birkaç kez
yenilenir (`data/isy.json`); İş Yatırım'a erişilemezse aşağıdaki tahmin yöntemine geri dönülür.
Bu resmi bir API değildir; yalnızca kişisel kullanım içindir.

**TL ↔ USD.** Her günün fiyatı, aynı günün (yoksa önceki son günün) USD/TRY kapanış kuruyla
çevrilir. Gün içi grafiklerde gün içi kur kullanılır. USD/TRY verisi 3 Ocak 2005'ten başladığı için
daha eski fiyatlar çevrilmiş para biriminde gösterilemez (uygulama bunu not olarak belirtir).

**Tarih aralığı.** Başlangıç için o tarihteki ya da (tatil/hafta sonuysa) ondan önceki son
**kapanış**, bitiş için o tarihteki ya da önceki son kapanış alınır; kullanılan tarihler sonuçta yazar.
1G görünümünde baz, bir önceki günün kapanışıdır.

**Veri temizliği.** Yahoo verisindeki bilinen hatalar otomatik düzeltilir ve not olarak gösterilir
(resmi kaydı olmayan ya da resmi kayıtla açıklanamayan durumlar için):
- Bir günde 20 kattan fazla sıçrama (ör. bazı BIST hisselerinde 2005'teki 6 sıfır atılmasının
  düzeltilmemiş olması) önceki fiyatlar ölçeklenerek giderilir.
- Yahoo'nun fiyata yansıtmadığı bölünme / bedelsiz sermaye artırımları: Yahoo'da bölünme kaydı varsa
  (tarihi kaymış olsa bile) kaydın tam oranı kullanılır. Kayıt yoksa, Borsa İstanbul'un günlük fiyat
  sınırının izin vermediği hareket bedelsiz / bedelli / bölünme / birleştirme kabul edilir ve önceki
  fiyatlar o güne göre ölçeklenir. Sınır 13 Mart 2020'den beri %10:
  bu dönemde tek günde %21'den fazla düşüş ya da %23'ten fazla yükseliş (Yahoo'nun bir günü atlamasına
  karşı iki günlük sınır payıyla); öncesinde (%20 sınır) ve uzun aralarda %40 düşüş / %70 yükseliş.
- Herhangi bir piyasada ertesi gün geri dönen %70+ tek günlük sıçrama hatalı fiyat sayılır.
- Kapanış fiyatının yarısından büyük, bozuk görünen temettü kayıtları hesaba katılmaz.

### Bilinmesi gerekenler

- Fiyatlar **Yahoo Finance**'ten gelir; borsalarda ~15 dakikaya kadar gecikmeli olabilir. BIST
  hisselerinin temettü ve sermaye artırımı kayıtları **İş Yatırım**'dan alınır.
- **Endeksler fiyat endeksidir** (temettü içermez). S&P 500 ve Russell 2000 için listede ayrıca
  *Toplam Getiri (TR)* versiyonları vardır; uygulama bunlara bağlantı verir. Diğer endekslerin temettü dahil
  getirisi için ETF'lerine bakın (ör. Nasdaq 100 → QQQ, Dow → DIA): ETF grafikleri temettü dahildir.
- **Altın/gümüş** fiyatları COMEX vadeli kontratlarıdır (spot fiyata çok yakındır).
  **Gram altın** = ons fiyatı ÷ 31,1035.
- BIST'te **bedelli sermaye artırımları** Yahoo verisinde düzeltilmeyebilir; böyle bir günde
  grafikte gerçek olmayan bir düşüş görülebilir.
- Yatırım tavsiyesi değildir.

## Geliştirme

```bash
npm test          # birim testleri (hesaplamalar + sunucu)
npm run catalog   # sembol listesini Yahoo'ya karşı yeniden doğrulayıp public/data/catalog.json'u üretir
node scripts/build-static.mjs site   # web (GitHub Pages) sürümünü site/ klasörüne üretir
```

Yeni halka arzları eklemek için `scripts/build-catalog.mjs` içindeki listeye sembolü ekleyip
`npm run catalog` çalıştırın.

Web sürümü `.github/workflows/pages.yml` ile GitHub Actions'ta derlenip `gh-pages` branch'ine yazılır; GitHub Pages o branch'i yayınlar.
GitHub'ın zamanlayıcısı güvenilir çalışmadığından saatlik güncellemeyi `.github/workflows/dongu.yml` başlatır:
bir saat bekler, siteyi güncelletir ve kendini yeniden başlatır.

```
server.js                 Yerel web sunucusu (bağımlılıksız Node.js)
lib/yahoo.js              Yahoo Finance istemcisi + önbellek
lib/isyatirim.js          İş Yatırım: BIST resmi temettü / sermaye artırımı kayıtları
public/index.html         Arayüz
public/style.css          Açık / koyu tema
public/js/app.js          Uygulama mantığı (liste, dönemler, ölçüm, notlar)
public/js/calc.js         Saf hesaplamalar: temettü düzeltmesi, veri temizliği, kur, aralık getirisi
public/js/chart.js        Grafik katmanı (TradingView Lightweight Charts v4)
public/js/format.js       Türkçe sayı/tarih biçimleri
public/data/catalog.json  Hazır sembol listesi
scripts/build-catalog.mjs Sembol listesini üretir
scripts/build-static.mjs  Web sürümünü (hazır veri dosyalarıyla) üretir
test/                     node:test birim testleri
```

Grafik kütüphanesi: [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/)
(Apache 2.0) ve QR kod: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT),
ikisi de `public/vendor/` içinde.
