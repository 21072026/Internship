# SaleVali'nin ticari modeli

SaleVali, BCS-IT GmbH'nin online satıcılara sattığı bulut tabanlı çok kanallı
ERP'sidir (Warenwirtschaft). Marketing dikeyi **SaleVali'nin müşterilerini** takip
eder: Amazon, eBay, OTTO, Shopify gibi kanallarda satan tüccarlar. Pazarlama ekibi
takip edilen kayıt değil, **operatördür**.

Bu dosya, kapatılan `21072026/Marketing` repo'sunun `src/lib/constants.ts`,
`prisma/schema.prisma` ve `CLAUDE.md`'sinden çıkarılmıştır. Kod artık gitti; bu
rakamlar ve kurallar **başka hiçbir yerde yazılı değil** ve yeniden türetilmesi
pahalı olurdu.

> Not: aşağıdaki enum'lar Marketing CRM'in **kendi** modelidir. Bu repoda huni
> `PipelineStage` satırlarıdır ve `MARKETING_FUNNEL` preset'inden gelir
> (`src/lib/programTemplates.ts`). Bu tablo bire bir uygulanacak bir şema değil,
> alanın anlamının kaydıdır.

## Fiyatlandırma

İki model var; müşteri API bağlantısı kuruyor mu kurmuyor mu, ayrım bu.

**1 · Yalnızca fatura (`INVOICE_ONLY_FIXED`)** — sabit **9,90 €/ay**.
API bağlantısı yok, müşteri yalnızca fatura kesiyor.

**2 · API/işlem başına (`API_TRANSACTION_TIERED`)** — kademeli, aylık işlem sayısına göre:

| İşlem aralığı | İşlem başına |
| --- | --- |
| ilk 100 | 0,20 € |
| 101 – 1000 | 0,05 € |
| 1001 ve üzeri | 0,033 € |

Kademeler **birikimlidir**: 1200 işlem = (100 × 0,20) + (900 × 0,05) + (200 × 0,033)
= 20,00 + 45,00 + 6,60 = **71,60 €**. İlk kademenin fiyatı tüm hacme uygulanmaz.

## Deneme (trial)

- Süre **30 gün** (`TRIAL_LENGTH_DAYS`).
- **Kendiliğinden yenilenmez ve otomatik olarak ücretli sözleşmeye dönmez.**
  Bu yüzden "hiçbir trial kaçmasın" epic'i vardı: kimse bakmazken biten bir
  deneme, sessizce kaybedilmiş bir müşteridir.

## Fesih

Fesih bildiriminden **30 gün** sonra sözleşme biter (`CANCELLATION_NOTICE_DAYS`).
Yani `CANCELLATION_NOTICE_800` aşamasına geçen bir müşteride sözleşme bitiş tarihi
= bildirim tarihi + 30 gün.

## Yaşam döngüsü aşamaları

Numaralar sıralama içindir (Internship'in `PipelineStatus`'ündeki emsalin aynısı):

`PROSPECT_100` → `CONTACTED_200` → `DEMO_SCHEDULED_300` → `DEMO_COMPLETED_400` →
`TRIAL_ACTIVE_500` → `TRIAL_EXPIRED_600` → `CUSTOMER_ACTIVE_700` →
`CANCELLATION_NOTICE_800` → `CHURNED_900`

Huni dışı iki uç: `LOST_950` (kaybedildi), `DISQUALIFIED_990` (uygun değil).

Aşamaya bağlı tarihler tek bir yerden türetiliyordu (`lifecycleTimestampsFor()`):
trial başlangıç/bitiş, dönüşüm, fesih bildirimi, churn, kapanış. İki kural vardı ve
ikisi de bilinçliydi: **var olan bir tarih asla üzerine yazılmaz** (denemeye ikinci
kez girmek ilk pencereyi korur) ve **kapanmış bir müşteri yeniden açılırsa
`closedAt` temizlenir, `churnedAt` tarih olarak kalır.**

## SEPA mandası

`NONE` → `REQUESTED` → `ACTIVE`, ve başarısızlık hâli `FAILED`. Ödeme SEPA doğrudan
borçlandırma ile alınıyor.

## Satış kanalları

Bir tüccarın bağlı olduğu pazaryerleri, mağaza yazılımları ve kargo firmaları:

**Pazaryeri/mağaza:** Amazon, eBay, Kaufland, OTTO, Etsy, Shopify, Shopware,
WooCommerce, PrestaShop
**Kargo:** DHL, DPD, GLS, UPS, Hermes
**Diğer:** özel API, diğer

Bir müşteri birden çok kanal çalıştırır ve kanal başına tek kayıt tutulurdu
(`[customerId, channel]` üzerinde tekil).

## Müşteri kaynağı

`WEBSITE_TRIAL`, `DEMO_REQUEST`, `AFFILIATE`, `CONSULTANT`, `REFERRAL`,
`MARKETPLACE`, `OUTBOUND`, `ADS`, `EVENT`, `OTHER`.

## Dil

SaleVali DE/EN/TR olarak satılıyor; müşterinin çalıştığı arayüz dili kayıtta
tutuluyordu.
