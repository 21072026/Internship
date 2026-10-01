# SaleVali'nin ticari modeli

SaleVali, BCS-IT GmbH'nin online satıcılara sattığı bulut tabanlı çok kanallı
ERP'sidir (Warenwirtschaft). Marketing dikeyi **SaleVali'nin müşterilerini** takip
eder: Amazon, eBay, OTTO, Shopify gibi kanallarda satan tüccarlar. Pazarlama ekibi
takip edilen kayıt değil, **operatördür**.

Bu dosya ilk hâliyle kapatılan `21072026/Marketing` repo'sunun `src/lib/constants.ts`,
`prisma/schema.prisma` ve `CLAUDE.md`'sinden çıkarılmıştı. **Fiyat, deneme ve fesih
kuralları ile dil ve kanal listeleri 2026-09-29'da (#2574) SaleVali'nin kendi koduna
eşitlendi** — tek doğru kaynak artık `salevali-server` repo'sudur; bu bölümlerdeki her
rakam kaynağının dosya:satırını taşır. Yaşam döngüsü, SEPA ve müşteri kaynağı bölümleri
kapatılan Marketing CRM'in modelini **tarihçe olarak** anlatır.
Satır numaraları, bu makinedeki kardeş checkout'un (`../salevali-server`) 2026-09-29
hâlinden okunmuştur; SaleVali tarafında bir değişiklik olursa önce kaynak, sonra bu dosya.

> Not: aşağıdaki yaşam döngüsü enum'ları Marketing CRM'in **kendi** modelidir. Bu repoda
> huni `PipelineStage` satırlarıdır ve `MARKETING_FUNNEL` preset'inden gelir
> (`src/lib/programTemplates.ts:546-570`). Bu tablo bire bir uygulanacak bir şema değil,
> alanın anlamının kaydıdır.

Kısaltma: `admin-helper.ts` = `salevali-server/src/services/admin/_helpers/admin-helper.ts`,
`user.service.ts` = `salevali-server/src/services/auth-service/user.service.ts`.

## Fiyatlandırma — V2 (2026-09 faturalama döneminden itibaren)

**Tek model var**; API bağlantısı olan/olmayan müşteri ayrımı V2'de **kaldırıldı**
(`admin-helper.ts:208-210`). Hangi dönemin hangi modelle fiyatlandığını
`PRICING_MODEL_V2_FROM_PERIOD = '2026-09'` belirler (`admin-helper.ts:187`); 2026-09 ve
sonrası V2, öncesi V1 (`calculateTieredPriceForPeriod`, `admin-helper.ts:265-281`).
Kod yorumu V2'nin `salevali.de/de/preise` ile birebir olduğunu söyler (`admin-helper.ts:198`).

**İşlem sayısı** T = siparişler + elle kesilen faturalar + elle kesilen Gutschrift'ler
(`admin-helper.ts:200`).

| Bileşen | Değer | Kaynak |
| --- | --- | --- |
| Ücretsiz kota | T ≤ **10** → **0 €**, hiçbir ücret yok (sabit ücret de yok) | `free_quota` `admin-helper.ts:59`, uygulaması `:222-224` |
| Sabit aylık ücret | **9,90 €**, T > 10 olduğunda; ilk **11** işlemi kapsar | `fixed_fee` `:55`, `base_covers` `:60` |
| Kademe 1 | 12. – 100. işlem: **0,20 €** / işlem | `tier_1_price` `:56`, formül `:226` |
| Kademe 2 | 101. – 1000. işlem: **0,05 €** / işlem | `tier_2_price` `:57`, formül `:227` |
| Kademe 3 | 1001. işlemden itibaren: **0,033 €** / işlem | `tier_3_price` `:58`, formül `:228` |

Kademe sınırları (100 / 1000) V1 ile aynıdır (`TIER_1_LIMIT`/`TIER_2_LIMIT`,
`admin-helper.ts:50-52`). Kademeler **birikimlidir** — ilk kademenin fiyatı tüm hacme
uygulanmaz. Tutarlar affiliate indirimi **öncesi** liste tutarlarıdır; KDV dahil mi hariç
mi olduğu bu fonksiyondan okunamaz (aynı dosyada `pricing_summary.total` "brüt,
indirim-öncesi" diye geçiyor, `admin-helper.ts:297`) — KDV durumu teyit edilene kadar
satışta "net" ya da "brüt" denmez.

Örnekler (`calculateTieredPriceV2`, `admin-helper.ts:212-234`):

| T | Hesap | Aylık |
| --- | --- | --- |
| 10 | ücretsiz kota | **0,00 €** |
| 11 | yalnız sabit ücret | **9,90 €** |
| 50 | 9,90 + (50 − 11) × 0,20 = 9,90 + 7,80 | **17,70 €** |
| 1200 | 9,90 + (100 − 11) × 0,20 + 900 × 0,05 + 200 × 0,033 = 9,90 + 17,80 + 45,00 + 6,60 | **79,30 €** |

Bir tenant'ın `UserSettings.pricing`'inde kendi oranları olabilir; eski kayıtlarda
`free_quota`/`base_covers` yoksa varsayılana düşülür (`admin-helper.ts:218-220`). Yani
yukarıdaki tablo **varsayılan** fiyat listesidir, sözleşmeye özel fiyat değil.

**V1 (2026-09 öncesi dönemler, yalnız geçmiş faturalar için)** — `calculateTieredPrice`,
`admin-helper.ts:74-150`: API bağlantısı olmayan müşteri T ≤ 100'de yalnız 9,90 € öder,
üstünde ilk 100 işlem ücretsizdir; API bağlantısı olan müşteride ilk 100 işlem de 0,20 €'dan
kademelenir; T = 0 bile sabit ücreti doğurur. Devralınan dokümandaki
`INVOICE_ONLY_FIXED` / `API_TRANSACTION_TIERED` ayrımı bu V1'in adlarıydı; oradaki
"1200 işlem = 71,60 €" örneği sabit ücreti de dışarıda bırakıyordu (V1'de API'li müşteri
için doğrusu 81,50 €). Satış konuşmasında V1 rakamı **kullanılmaz**.

**Affiliate indirimi:** `affiliate_user` lisansındaki dönem **%20 indirimle** (× 0,8)
fiyatlanır — indirim fatura oluşturulurken uygulanır (`admin-user.service.ts:109-119`,
sürekli hâlde `tieredTotal * 0.8`). Ay ortasında premium'a geçişte fatura iki döneme
bölünür ve yalnız A (affiliate) dönemi indirimli fiyatlanır; **sabit ücret tamamen B
dönemine yazılır, indirilmez** (`admin-helper.ts:152-161`). Bu lisansa girişten **120 gün** sonra kullanıcı onayı
gerekmeden `premium`'a geçer ve indirim biter (`user.service.ts:735-750`).

> **Açık soru (ürün ekibine — #2574):** `POSITION_OPTIONS` içinde
> `{ title: 'connections', price: 6 }` duruyor (`admin-helper.ts:42-45`); diğer bütün
> pozisyonlar `price: 0`. `salevali-server/src` ve `salevali-client/src` içinde bu sabiti
> testler dışında okuyan kod yok (grep, 2026-09-29), V2 formülü de bağlantı sayısını hiç
> almıyor. Bağlantı başına 6 € ek ücret mi, ölü bir kalıntı mı? Cevap gelene kadar satış
> konuşmasında **bağlantı ücreti vaat edilmez ve anılmaz**.

## Deneme (trial) — serbest dönem + karar penceresi

Tek kaynak `hasTrialPeriodElapsed()` (`user.service.ts:496-533`); süre formülü
`(type === 'trial' ? 30 : 60) + graceDays` (`:531`), referans tarihi bu lisans tipine
geçilen an, `license.updated_at` (`:505-506`, `:528`).

| Lisans | Serbest dönem | + Karar penceresi | Pasifleşme |
| --- | --- | --- | --- |
| `trial` | **30 gün** | **+30 gün** | 60. günden sonra |
| `affiliate_trial` | **60 gün** | **+30 gün** | 90. günden sonra |

(`user.service.ts:510-517`, `:538-554`.)

- **Serbest dönem bitince** giriş **engellenmez**; giriş yanıtındaki `license_expired`
  bayrağı arayüzü "premium'a geç?" sorusuna yönlendirir (`user.service.ts:262-268`).
- **Kullanıcı yükseltmeyi önceden onayladıysa** (`license.is_upgrade_confirm === true`)
  günlük cron serbest dönem sonunda lisansı kendiliğinden çevirir: `trial` → `premium`
  (`checkAndUpgradeTrialLicense`, `user.service.ts:801-825`), `affiliate_trial` →
  `affiliate_user` (`checkAndTransitionAffiliateTrial`, `:870-893`).
- **Onay yoksa** karar penceresi de dolunca hesap `passive` olur
  (`checkAndPassivateExpiredLicense`, `user.service.ts:547-554`); geri dönüş yalnız
  e-posta anahtarı ya da admin ile (`:515-517`).
- Yani deneme **onaysız hiçbir zaman kendiliğinden ücretliye dönmez** — "hiçbir trial
  kaçmasın" epic'inin gerekçesi hâlâ geçerli, ama kaçırılacak pencere 30 değil
  **30 + 30** gündür: satışın asıl işi karar penceresidir.

Bu repodaki karşılığı: `trialLengthDays` org ayarı (varsayılan 30,
`DEFAULT_TRIAL_LENGTH_DAYS`, `src/lib/trialReminderRule.ts:99-105`) yalnız **serbest
dönemi** modeller; karar penceresinin funnel'da nasıl duracağı #2572'de karar
bekliyor. Bugün serbest dönemi biten kayıt `TRIAL_EXPIRED`'a park edilir
(`src/lib/trialReminderRule.ts:91-97`, #2417).

## Fesih

Fesih bildirimi hesabı `status = 'cancellation_request'`'e alır. `account_log`'daki son
`cancellation` kaydından **30 günden fazla** (kesin `daysDiff > 30`) geçtiyse, statü
`cancelled`'a **bir sonraki girişte** çevrilir (`user.service.ts:253-259`, gün hesabı
`getDaysSinceLastCancellation` `:643`; ayrıca `user.controller.ts:1814`). Bunu yapan bir
cron **yok** — kullanıcı hiç girmezse statü `cancellation_request`'te kalır — ve
`cancelled` bir hesap hâlâ kimlik doğrulayabilir (`user.service.ts:244`,
`jwt.service.ts:82`). Sözleşmesel fesih süresi (Kündigungsfrist) AGB'den gelir, bu koddan
değil; satışta 30 gün bir sözleşme süresi olarak aktarılmaz. Marketing CRM'in modelinde bu, `CANCELLATION_NOTICE_800` aşamasındaki müşteride
sözleşme bitiş tarihi = bildirim tarihi + 30 gün demekti.

## Yaşam döngüsü aşamaları

Marketing CRM'in kendi aşamaları — numaralar sıralama içindir (Internship'in
`PipelineStatus`'ündeki emsalin aynısı):

`PROSPECT_100` → `CONTACTED_200` → `DEMO_SCHEDULED_300` → `DEMO_COMPLETED_400` →
`TRIAL_ACTIVE_500` → `TRIAL_EXPIRED_600` → `CUSTOMER_ACTIVE_700` →
`CANCELLATION_NOTICE_800` → `CHURNED_900`

Huni dışı iki uç: `LOST_950` (kaybedildi), `DISQUALIFIED_990` (uygun değil).

**Bu repoda** aynı yolculuk `MARKETING_FUNNEL` preset'inin anahtarlarıyla yürür
(`src/lib/programTemplates.ts:546-570`):

`LEAD_NEW` → `LEAD_CONTACTED` → `LEAD_QUALIFIED` → `TRIAL_ACTIVE` → `TRIAL_EXPIRED` →
`DEAL_PROPOSAL` → `DEAL_NEGOTIATION` → `DEAL_WON` | `DEAL_LOST` (off-path, terminal)

DEAL_WON sonrası müşteri durumu (aktif müşteri, fesih bildirimi, churn) preset'te yok;
bu açık karar #2572'dedir.

Aşamaya bağlı tarihler tek bir yerden türetiliyordu (`lifecycleTimestampsFor()`):
trial başlangıç/bitiş, dönüşüm, fesih bildirimi, churn, kapanış. İki kural vardı ve
ikisi de bilinçliydi: **var olan bir tarih asla üzerine yazılmaz** (denemeye ikinci
kez girmek ilk pencereyi korur) ve **kapanmış bir müşteri yeniden açılırsa
`closedAt` temizlenir, `churnedAt` tarih olarak kalır.**

## SEPA mandası

`NONE` → `REQUESTED` → `ACTIVE`, ve başarısızlık hâli `FAILED`. Ödeme SEPA doğrudan
borçlandırma ile alınıyor.

## Satış kanalları

Bir tüccarın bağlı olduğu pazaryerleri, mağaza yazılımları ve kargo firmaları. Liste
SaleVali'nin entegrasyon klasörlerinden alınmıştır (`salevali-server/src/services/shops/`
ve `src/services/shippers/`, 2026-09-29):

**Pazaryeri/mağaza:** About You, Amazon (+ Amazon Prime/FBA), Avocadostore, bol.com,
eBay, Etsy, Hood, Kaufland, Manomano, OTTO, PrestaShop, Shop Apotheke, Shopify (REST +
GraphQL), Shopware 5, Shopware 6, Temu, TikTok Shop, WooCommerce
**Kargo:** Deutsche Post, DHL, DPD, DPD Depot, FedEx, GLS, GLS ShipIT (farm), Hermes, UPS

Kapatılan Marketing CRM'in kanal enum'u bunun eski ve dar bir alt kümesiydi (Amazon, eBay,
Kaufland, OTTO, Etsy, Shopify, Shopware, WooCommerce, PrestaShop; DHL, DPD, GLS, UPS,
Hermes; artı "özel API" ve "diğer"). O CRM'de bir müşteri birden çok kanal çalıştırır ve
kanal başına tek kayıt tutulurdu (`[customerId, channel]` üzerinde tekil).

## Müşteri kaynağı

`WEBSITE_TRIAL`, `DEMO_REQUEST`, `AFFILIATE`, `CONSULTANT`, `REFERRAL`,
`MARKETPLACE`, `OUTBOUND`, `ADS`, `EVENT`, `OTHER`.

## Dil

SaleVali DE/EN/TR/FR olarak satılıyor (`salevali-server` `src/i18n/config.ts:9`
`SUPPORTED_LANGUAGES`; client kataloğu `messages/{de,en,tr,fr}.json`); müşterinin çalıştığı arayüz dili kayıtta
tutuluyordu.
