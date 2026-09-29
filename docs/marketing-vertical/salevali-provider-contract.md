# SaleVali sağlayıcı sözleşmesi: SaleVali'den ne istiyoruz (#2565 / story #2399)

[`salevali-usage-feed.md`](salevali-usage-feed.md) CRM'in kullanım beslemesini
**nasıl okuyacağını** yazıyor. Bu dosya onun karşı yüzü: SaleVali ekibine
verilecek tek, yazılı istek — hangi anahtarla, hangi uçlardan, hangi alanlar,
hangi kimlik doğrulamayla, neyin **gönderilmeyeceği**, ve bunun için SaleVali
repolarında (`salevali-server`, `salevali-client`) hangi işlerin açılması
gerektiği. CRM tarafında bu sözleşmeyi bekleyen üç iş var ve üçü de buradaki
anahtarı ve alan adlarını kullanmak zorunda: import kolonu (#2554), gecelik
kullanım işi (#2447), makineden makineye lead ingest'i (#2450).

> **Durum: taslak, maintainer onayı bekliyor.** "Karar" diye işaretli maddeler
> önerilen varsayılandır ve CRM işleri bunun üzerinden ilerler; **"Açık karar"**
> diye işaretli maddeler onay olmadan uygulanmaz. Hepsi aşağıda
> [§ Açık kararlar](#açık-kararlar) altında bir kez daha toplu duruyor.
>
> **Satır numaraları.** SaleVali atıfları `salevali-server` / `salevali-client`
> `develop` dalının 2026-09-29 hâline, CRM atıfları `origin/main`'e göre. Bir
> satır kayarsa dosya + sembol adı doğrudur, numara değil.

## Özet: SaleVali'den istenen üç şey

| # | Ne | Yön | Kim çağırır | Bugün SaleVali'de |
|---|---|---|---|---|
| **A** | Hesap × gün kullanım export'u | CRM **çeker** | CRM gecelik işi (#2447) | **Yok.** `TenantUsage` kümülatif, `TenantUsageMonthly` aylık; günlük seri yok |
| **B** | Hesap/lisans olay akışı (kayıt, deneme, onay, dönüşüm, pasifleşme, fesih, geri dönüş) | CRM çeker (**öneri**) ya da SaleVali iter — [Açık karar K-2](#k-2) | CRM işi ya da SaleVali | **Yok.** Olayların yarısı hiçbir yerde kalıcı olarak kaydedilmiyor (aşağıda) |
| **C** | Kayıt formunda önceden işaretli newsletter kutusunun kaldırılması + DOI | — | — | Kutu önceden işaretli (`salevali-client/src/app/pages/auth/Registration.jsx:46`) |

C bir veri ucu değil ama sözleşmenin parçası: CRM SaleVali'nin newsletter
bayrağını **hiçbir koşulda** pazarlama izni saymaz (#2577), ve bu kural C
yapılsa da değişmez — C yalnızca SaleVali'nin kendi listesini temizler.

## Karar K-1: `externalId` = SaleVali `User._id`

**Anahtar, MAIN_DB `User` koleksiyonundaki belgenin `_id`'sidir** — 24 karakterlik
küçük harf hex dize (`^[0-9a-f]{24}$`). CRM'de `Company.externalId`'ye
(`prisma/schema.prisma:1365`, `VarChar(191)`, `@@index([orgId, externalId])` :1392)
**tam bu biçimde, küçük harfle** yazılır; import (#2554), besleme (#2447) ve
ingest (#2450) aynı normalizasyonu uygular. `user_number` yalnızca **görüntüleme**
alanıdır ve CRM'e taşınırsa bile eşleştirmede kullanılmaz.

Gerekçe — `_id` SaleVali'de zaten "hesabın kimliği" olarak kullanılan tek değer:

- **Tenant veritabanının adı odur.** Kayıtta tenant DB `createdUser.id` ile açılır
  ve tenant'taki kullanıcı aynası `user_id: createdUser.id.toString()` alır
  (`salevali-server/src/controllers/users/_helpers/provision-tenant.ts:69`, `:84`);
  bağlantı güvenlik kontrolü DB adının kullanıcı id'sine eşit olduğunu doğrular
  (`src/services/auth-service/connections-db.service.ts` → `validateConnectionForUser`).
  Bir hesabın `_id`'si değişirse verisi bulunamaz; yani fiilen değişmezdir.
- **Kullanım tabloları zaten bununla anahtarlı:** `TenantUsage.user_id` —
  "Tenant kimligi (= `User._id` = tenant Mongo DB adi)"
  (`src/models/tenant-usage/tenant-usage.model.ts:192-210`), `TenantUsageMonthly.user_id`
  aynı (`tenant-usage-monthly.model.ts:84-91`). Export A'yı yazacak kod bu anahtarı
  hiçbir çeviri yapmadan verir.
- **`user_number` bir anahtar değil, bir etikettir.** Admin panelinden
  düzenlenebilir (`src/controllers/admin/admin.controller.ts:1541-1579`, tenant
  aynasına yayılması :1691), bir sayaçtan türetilir (`src/repositories/users/user.repository.ts:53-73`,
  "en son numara + 1") ve geçmişte mükerrer üretilmiştir — bunu temizlemek için bir
  migration var (`src/migrations/scripts/userNumberDedupe.migration.ts`). Düzenlenebilen
  ve bir kez çakışmış bir değerle eşleştirmek, sessizce yanlış hesaba yazmak demektir.
- **`User.user_id` de değil.** MAIN_DB'de yeni belgede `user_id = id` diye
  kopyalanır ve yorumu "user_id kaldırılınca" der (`user.repository.ts:98-105`);
  personel hesaplarında `MAIN_DB` değerini taşır ve benzersiz değildir
  (`admin.controller.ts:163`). Kaldırılması planlanan bir kopya anahtar olamaz.
- **E-posta hiç değil.** Değişir (`PATCH /user/change-email`,
  `src/controllers/users/user.controller.ts:2255`) ve kişisel veridir; anahtar
  olarak her satırda dolaşması PII minimizasyonuna aykırı.

**`TempUser._id` bir `externalId` değildir.** E-postası doğrulanmamış kayıt
`TempUser`'dadır; doğrulamada **yeni** bir `User` yaratılır ve `TempUser`
silinir (`user.controller.ts:563`/`:569`, admin onayı `:791`/`:797`, davet
kabulü `:1171`/`:1219`; Google ile kayıt doğrudan `User` yaratır, `:1965`). Yani
`TempUser._id` hesabın ömrü boyunca yaşamaz. Doğrulanmamış kayıtların CRM'e
gelip gelmeyeceği [Açık karar K-3](#k-3).

## Kapsam: hangi hesaplar gönderilir

Yalnızca **müşteri** hesapları. SaleVali'nin kendi faturalamasının kullandığı
allowlist'in aynısı çıkış noktasıdır (`src/services/admin/admin-user.service.ts:351-367`:
`user_id ≠ MAIN_DB`, lisans tipi allowlist'i) — ama CRM denemeyi de görmek
zorunda olduğu için allowlist daha geniş:

| Gönderilir (`license.type`) | Gönderilmez |
|---|---|
| `trial`, `affiliate_trial`, `premium`, `affiliate_user` | `tester`, `test_user`, `development` (test/iç hesaplar) |
| | `support`, `finance`, `admin`, `system_admin` (personel — lisans enum'u bunları da içeriyor, `src/models/users/license/license.model.ts:13`) |
| | `user_id == MAIN_DB` olan her kayıt |
| | `standard` — [Açık karar K-4](#k-4): enum'da var, faturalanmıyor, anlamı yazılı değil |

Allowlist, blocklist değil: lisans enum'una ileride eklenen bir tip **varsayılan
olarak gönderilmez** — `admin-user.service.ts:361-364`'teki gerekçenin aynısı.
Bir hesap allowlist dışına çıkarsa (ör. `premium` → `tester`) bu da bir olaydır
(`excluded`) ve CRM kaydı kapatmaz, yalnızca beslemeyi durdurur.

## Uç A: hesap × gün kullanım export'u

CRM tarafı [`salevali-usage-feed.md`](salevali-usage-feed.md)'de karara bağlı:
**pull, HTTPS, CSV**, örtüşen 7 günlük pencere, mutlak sayılar. SaleVali'nin
sağlaması gereken:

```
GET /integrations/crm/usage-daily?from=YYYY-MM-DD&to=YYYY-MM-DD
X-Crm-Export-Secret: <paylaşılan sır>
→ 200 text/csv; charset=utf-8
```

| Sütun | Tip | Zorunlu | SaleVali'deki kaynağı |
|---|---|---|---|
| `external_id` | 24-hex | evet | `User._id` (K-1) |
| `date` | `YYYY-MM-DD`, **UTC günü** | evet | aşağıya bakın |
| `transactions` | tam sayı ≥ 0 | evet | **faturalanan işlem tanımı**: sipariş + manuel fatura + iade faturası (credit), `created_at` o UTC gününe düşen |
| `orders` | tam sayı ≥ 0 | hayır | `Order` sayısı, aynı gün |
| `documents` | tam sayı ≥ 0 | hayır | `Invoice + Credit + Waybill + Offer` sayısı, aynı gün — CRM'de henüz sütunu yok, yok sayılır (I-5) |

- **`transactions` = SaleVali'nin fatura kestiği sayı, `LogEntry` değil.**
  Aylık fatura `orderCount + manuel_invoice_count + creditCount`'tur
  (`admin-user.service.ts:525`; manuel fatura tanımı `marketplace` ya da
  `order_id` boş olan `Invoice`, :512-520). 🚨 Aynı kelime SaleVali'de **başka
  bir şey** için de kullanılıyor: `TenantUsage.activity.transactions` ve
  `TenantUsageMonthly.activity.transactions` `LogEntry` sayısıdır
  (`src/services/usage/tenant-usage.service.ts:470-487`, `:613`) — yani
  veri değiştiren istek sayısı, saklama süresi `LOG_RETENTION_DAYS` kadar (koddaki
  varsayılan 90 gün, `src/services/cronjob/cronjob-log-retention.service.ts:49`).
  Churn sinyali satın alınan hacmi okumalı; export `LogEntry` sayısını
  `transactions` adıyla **göndermez**. İstenirse ayrı bir `api_activity`
  sütunu olarak gelir ve CRM onu yok sayar.
- **Gün sınırı UTC.** Faturalama da UTC sınırıyla sayıyor (`admin-user.service.ts`
  pro-rating yorumu, "UTC hesap (#7)"); `TenantUsageMonthly` ise tenant'ın iş saat
  diliminde kovalıyor (`tenant-usage-monthly.model.ts:26-37`). CRM'in
  `CompanyUsage.date`'i bir takvim günüdür (`prisma/schema.prisma:1423`) ve
  faturayla aynı sınırı kullanır: UTC.
- **Geçmiş doldurulabilir.** Belgeler kalıcı olduğu için (`LogEntry`'nin aksine) ilk
  koşu geniş pencereyle bütün geçmişi çekebilir; `from`/`to` bunun için var.
  Tek istekte en fazla 31 gün önerilir; CRM geniş aralığı parçalar.
- **Yanıt yalnızca kapsam içindeki hesapları içerir** (yukarıdaki tablo) ve o
  gün hiç işlemi olmayan hesap için `0` satırı yazar — eksik satır "veri yok",
  `0` "iş yok" demektir ve churn kuralı bu ikisini ayırmak zorunda.
- **Maliyet SaleVali'de.** Her gece her tenant DB'sinde 7 günlük `$group`
  koşmak yerine önerilen yol, `TenantUsageCronJob`'ın (05:00, zaten her
  tenant'ı geziyor) günlük kovaları MAIN_DB'de ayrı bir koleksiyona yazması ve
  ucun yalnızca onu okuması (SV-3). CRM çekme saati buna göre 06:00 UTC'den
  sonra ayarlanır.

## Uç B: hesap ve lisans olayları

### Bugün neyin kaydı var, neyin yok

SaleVali lisans yaşam döngüsünün kuralları tek yerde (`src/services/auth-service/user.service.ts`,
`salevali-server/docs/LICENSE_GUIDE.md`) ama **olayların** yarısı hiçbir yerde
kalıcı değil — yalnızca log satırı:

| Olay | SaleVali'de nerede olur | Kalıcı iz |
|---|---|---|
| Hesap açıldı / deneme başladı | `User` yaratan dört yol (yukarıda) | `license_history` `source: 'signup'` (`src/models/users/license/license-history.model.ts:40-53`) |
| Yükseltme onayı | `PATCH /user/license-upgrade-confirm` (`user.controller.ts:3531`), anahtarla `:3600` → `license.is_upgrade_confirm`, `upgrade_confirm_date` (`license.model.ts:29-37`) | alan var, **tarihçe yok** |
| Ücretliye geçiş | Günlük cron: `checkAndUpgradeTrialLicense` (`user.service.ts:801`), `checkAndTransitionAffiliateTrial` (`:870`), `checkAndUpgradeAffiliateLicense` (`:735`, affiliate_user → premium, 120 gün) — çağıran `cronjob-check-connection-email.service.ts:132-156` | `license_history` (`cron_trial_upgrade` / `cron_affiliate_trial` / `cron_affiliate_upgrade`) |
| Pasifleşme (karar penceresi bitti) | `checkAndPassivateExpiredLicense` (`user.service.ts:547-553`) | **yalnızca** `[LICENSE_PASSIVATE]` log satırı — `status: 'passive'` yazılır, geçmiş yok |
| Fesih talebi | `POST /user/account` → `POST /user/cancellation/verify` (`user.controller.ts:3099`, `:3374`); anket `addAccountLog(…, 'cancellation', surveys, description)` (`:3286`) | `account_log` `type: 'cancellation'` + `User.cancellation_request` (`user.model.ts:235-240`) |
| Fesih tamamlandı (+30 gün) | **İki** yazar: cron `checkAndUpdateCancellationStatus` (`user.service.ts:666-697`) ve login sırasında tembel geçiş (`user.controller.ts:1814-1826`) | **yalnızca** `[USER_STATUS_UPDATE]` log satırı |
| Geri dönüş | Admin reaktivasyonu (`admin.controller.ts:867-884`), e-posta anahtarıyla self-servis dönüş | `account_log` `type: 'activation'` (admin yolu) |
| Silindi | `cancelled` + 60 gün → `deleted` (`user.service.ts:663`), `UserPurgeCronJob` | `status` |

Bu yüzden B'nin önkoşulu SaleVali'de bir **olay kaydı** (outbox): her geçiş
noktası, iş yazmasıyla birlikte MAIN_DB'deki ekleme-yalnız bir koleksiyona bir
satır yazar (SV-1). Uç B o koleksiyonu okur. Olayları `license_history` +
`account_log` + `status`'tan geriye doğru türetmek pasifleşmeyi ve fesih
tamamlanmasını **hiç göremez** — o yüzden türetme reddedildi.

### Taşıma ([Açık karar K-2](#k-2)) — öneri: pull

```
GET /integrations/crm/events?after=<cursor>&limit=500
X-Crm-Export-Secret: <paylaşılan sır>
→ 200 application/json  { "items": [ <olay>, … ], "next_cursor": "<cursor>" | null }
```

İmleç `<occurred_at ISO>|<event_id>`; SaleVali kendi `DemoLeadSyncCronJob`'ında
tam bu deseni kullanıyor (`src/services/demo-lead/demo-lead-sync.service.ts`:
"YÖN: prod ÇEKER", imleç `<ended_at>|<source_session_id>`, `MAX_PAGES` tavanı,
başarısız tur imleci ilerletmediği için veri kaybı yok). Pull'un gerekçeleri
[`salevali-usage-feed.md` § Taşıma](salevali-usage-feed.md#taşıma-crm-çeker-salevali-itmez)'dakiyle
aynı, bir ek ile: SaleVali'de **outbound webhook altyapısı yok**; push, bir
teslim işçisi + yeniden deneme + CRM anahtarını SaleVali ortamında saklamayı
gerektirir, pull yalnızca salt-okunur bir uç.

Push seçilirse şekil #2450'de yazılı ve burada değişmez: `POST
/api/integrations/salevali/events` (**`/api/v1` dışında** — `/api/v1` donuk,
#2348 açık karar 3), kimlik doğrulama `withApiKey` (`src/lib/apiKey.ts:90`) +
yeni **yazma** scope'u `companies:write` (`src/lib/apiScopes.ts:17` bugün yalnızca
`candidates:read`), tenant anahtardan çözülür (anahtar başına org bağlama,
`apiKey.ts:114-119`), gövde aynı olay şemasıdır. İki yolda da CRM'deki
**yazıcı aynıdır**; fark yalnızca kimin çağırdığı.

JSON burada "ikinci ayrıştırıcı" kuralını (`CLAUDE.md` → *One import engine, one
parser*) çiğnemiyor: o kural sınırlandırılmış **dosya** içe aktarımı içindir
(kullanım export'u bu yüzden CSV). Olaylar bir API yanıtıdır ve her route
gövdesi gibi zod ile doğrulanır.

### Olay zarfı

Her olay **olaydan sonraki durumun tam anlık görüntüsünü** taşır, yalnızca
değişeni değil. Tekrar ve sıra dışı gelme böyle zararsız olur (kullanım
beslemesindeki "mutlak sayılar, delta değil" kuralının olay karşılığı).

| Alan | Tip | Anlamı |
|---|---|---|
| `event_id` | 24-hex | Outbox belgesinin `_id`'si — **idempotency anahtarı** |
| `schema_version` | tam sayı | Bugün `1`; alan kaldırmak/anlam değiştirmek sürümü artırır |
| `event_type` | enum, aşağıda | |
| `occurred_at` | ISO 8601, UTC an | Geçişin SaleVali'de gerçekleştiği an — gönderildiği an değil |
| `external_id` | 24-hex | K-1 |
| `license_type` | `trial` \| `affiliate_trial` \| `premium` \| `affiliate_user` | Olaydan **sonraki** tip |
| `status` | `first_login` \| `active` \| `passive` \| `cancellation_request` \| `cancelled` \| `deleted` | `user.model.ts:33-42` enum'u |
| `trial_started_at` | ISO an \| null | Deneme tipindeyken `license.updated_at` — `hasTrialPeriodElapsed`'ın referansı (`user.service.ts:521-532`) |
| `trial_ends_at` | ISO an \| null | **Serbest dönemin** sonu: trial +30 gün, affiliate_trial +60 gün |
| `decision_ends_at` | ISO an \| null | **Karar penceresinin** sonu: +30 gün daha (trial 60, affiliate_trial 90); pasifleşme eşiği (`user.service.ts:547-549`) |
| `is_upgrade_confirm` | bool | `license.is_upgrade_confirm` |
| `upgrade_confirmed_at` | ISO an \| null | `license.upgrade_confirm_date` |
| `cancellation_notice_ends_at` | ISO an \| null | Fesih talebi + 30 gün (`admin-user.service.ts:407-426`, `CANCELLATION_NOTICE_DAYS`) |
| `channels` | dize dizisi | Bağlı kanal adları — `TenantUsage.connections.names` (`tenant-usage.model.ts:111-121`) |
| `acquisition_source` | enum \| null | `search_engine` \| `social_media` \| `youtube` \| `referral` \| `advertisement` \| `other` (`user.model.ts:172-178`) |
| `reference` | dize \| null | Affiliate referansı (`user.model.ts:167-170`) |
| `language` | `de` \| `en` \| `tr` \| `fr` | Arayüz dili |
| `contact` | nesne \| yok | **Yalnızca `account_created`'da**: `name`, `surname`, `email`, `company_name` (varsa) |
| `cancellation` | nesne \| yok | **Yalnızca `cancellation_requested`'da**: `reason_codes` (dize dizisi, SV-5) |

Tarihleri **SaleVali hesaplar, CRM yeniden hesaplamaz.** Pencere uzunlukları
(30/60 + 30) SaleVali kuralıdır ve orada değişirse CRM'in kendi sabitiyle
ayrışmamalı. CRM'in `trialWindowFor()`'u (`src/lib/trialReminderRule.ts:169`)
yalnızca alan boş geldiğinde yedektir.

### Olay türleri

| `event_type` | SaleVali tetikleyicisi |
|---|---|
| `account_created` | Kapsam içi `User` ilk kez yaratıldı (dört yol) — genelde deneme başlangıcı |
| `trial_started` | Mevcut bir hesap deneme tipine alındı (admin ataması) |
| `upgrade_confirmed` | `is_upgrade_confirm` `true` oldu |
| `converted` | trial → premium, affiliate_trial → affiliate_user |
| `license_changed` | Diğer kapsam içi tip geçişleri (affiliate_user → premium, admin elle) |
| `passivated` | Karar penceresi bitti, `status: 'passive'` |
| `cancellation_requested` | Fesih doğrulandı, `status: 'cancellation_request'` |
| `cancelled` | İhbar süresi doldu, `status: 'cancelled'` — **iki yazarın ikisi de** olay yazar (SV-1) |
| `reactivated` | `passive` / `cancellation_request` / `cancelled` → `active` |
| `excluded` | Hesap kapsam dışına çıktı (tip allowlist dışına geçti) |
| `deleted` | `status: 'deleted'` ya da purge — [Açık karar K-7](#k-7) |

## İdempotency ve sıra

- **`event_id` tekildir**; CRM işlenmiş olay id'lerini org başına saklar ve aynı
  id'yi ikinci kez gördüğünde hiçbir şey yazmaz (I-1). İmleç tekrar çekmeyi zaten
  sınırlar, ama push yolunda aynı olay birden çok kez gelebilir.
- **Hesap başına yüksek su işareti:** bir olay, o hesap için uygulanmış son
  olaydan daha eski `occurred_at` taşıyorsa **durum alanlarını değiştirmez**
  (anlık görüntü zaten daha yenisini söyledi); yalnızca rapora "geç geldi" diye
  düşer.
- **Hiçbir olay kaydı funnel'da geriye taşımaz** (#2451, `src/lib/stageChange.ts`'e
  gelecek kural). `DEAL_WON`'daki bir hesap için geç gelen `account_created`
  aşamaya dokunmaz.
- **Kullanım export'u (A)** idempotentliğini sözleşmenin kendisinden alır: mutlak
  sayılar + `@@unique([companyId, date])`.

## CRM'de alan eşlemesi

Funnel kaydının ne olduğu [`pipeline-record.md`](pipeline-record.md)'de bağlayıcı:
hesap = `Company`, funnel kaydı = `MentorshipRelation`, lead kişi = `MENTEE`
`User`. Aşama yazmaları yalnızca `src/lib/stageChange.ts`'ten, ilişki yazmaları
yalnızca `src/lib/activeMentorship.ts`'ten geçer.

| SaleVali alanı | CRM hedefi | Kural |
|---|---|---|
| `external_id` | `Company.externalId` | Eşleştirme `{ orgId, externalId }`; boşsa gap-fill (`planFieldUpdates`, `src/lib/externalSyncPolicy.ts:65`) |
| `contact.company_name` (yoksa `name surname`) | `Company.name` | Yalnızca hesap yaratılırken |
| `contact.email` | `Company.contactEmail` (`prisma/schema.prisma:1302`) | Gap-fill. Lead `User`'ın adresi **gerçek adres değil**, `leadStandInEmail(…)` (`src/lib/marketingImport.ts:244`) |
| `contact.name` + `surname` | `Company.contactName` (:1324) + lead `User` adı | Gap-fill |
| `trial_started_at` | `MentorshipRelation.trialStartedAt` (`prisma/schema.prisma:2249`) | Var olan tarih üzerine yazılmaz |
| `trial_ends_at` **ya da** `decision_ends_at` | `MentorshipRelation.trialEndsAt` (:2250) | Hangisi — [Açık karar K-5](#k-5) (#2572 soru 2) |
| `acquisition_source`, `reference` | `Source` (`User.sourceId`, :403) | #2570'in eşleme fonksiyonu |
| `language` | — | CRM'de hesap dili alanı yok; bugün yok sayılır (I-6) |
| `channels` | — | Hesap düzeyinde kanal alanı yok; bugün yok sayılır (I-5) |
| `status`, `license_type`, `is_upgrade_confirm` | `StatusChange` üzerinden aşama | Aşağıdaki tablo |
| `cancellation.reason_codes` | `StatusChange.reasonCode` (:2919) | #2573 listesine eşleme — [Açık karar K-6](#k-6) |

Olay → aşama (`MARKETING_FUNNEL`, `src/lib/programTemplates.ts:543-570`):

| Olay | Aşama | Not |
|---|---|---|
| `account_created`, `trial_started` | → `TRIAL_ACTIVE` | #2450'nin kabul kriteri |
| (serbest dönem bitti) | → `TRIAL_EXPIRED` | **Olay gerekmez:** CRM'in `expireTrials` süpürgesi (`src/lib/jobs/trialReminders.ts:375`) `trialEndsAt`'te kendisi taşır |
| `upgrade_confirmed` | ? | SaleVali'de "teklif" yok, gerçek karar noktası bu onay (#2572) — [K-5](#k-5) |
| `converted` | → `DEAL_WON` | Faturalama bu andan başlar |
| `passivated` | → `DEAL_LOST` + neden kodu | Off-path, `reasonCode` zorunlu; hangi kod — [K-6](#k-6) |
| `cancellation_requested`, `cancelled`, `reactivated` | — | `DEAL_WON` sonrası müşteri durumu #2572 soru 3-4'e bağlı; o gelene kadar yalnızca `ActivityLog` |

## Kimlik doğrulama, SSRF, üzerine yazma

Hiçbiri burada yeniden tanımlanmıyor:

- **Pull (A ve öneri B):** SaleVali ucu **amaca özel bir header** ile paylaşılan sır
  ister, `Authorization: Bearer` değil. Gerekçe SaleVali'nin kendi kodunda:
  `dynamic-datasource-action.provider.ts` her isteğin `Authorization` header'ını
  tenant JWT'si sanıp doğruluyor, düz bir sır her zaman 401 üretir
  (`src/services/demo-lead/demo-lead-sync.service.ts:71-76`, `X-Demo-Export-Secret`
  emsali). CRM tarafında sır bir DB satırında **durmaz**: yapılandırma ortam
  değişkeninin **adını** saklar (`RosterFeed.credentialEnvVar`,
  `prisma/schema.prisma:4242`). URL `assertPublicHttpsUrl()` (`src/lib/ssrfGuard.ts:60`)
  ile, `redirect: 'error'` ve boyut tavanıyla çekilir.
- **Push (K-2 alternatifi):** `withApiKey` + `companies:write`, anahtar başına
  hız sınırı (`withApiKey` içinde, `subject: key:<id>`), `requireCapability(orgId,
  'companies')` (`src/lib/capabilityGate.ts`). Bugünkü `check:api-key-routes`
  yalnızca `src/app/api/v1`'i tarıyor (`scripts/check-api-key-routes.mjs`, `V1_DIR`);
  `/api/v1` dışındaki bir `withApiKey` rotası o kapıyı genişletmeden sevk edilmez (#2450).
- **Üzerine yazma:** `planFieldUpdates` — boş alan doldurulur, operatörün yazdığı
  alan yetkili olmayan kaynak için `withheld` raporlanır. SaleVali beslemesi
  varsayılan olarak **yetkili değildir**; hesap adını ya da iletişim bilgisini
  operatör CRM'de düzelttiyse SaleVali onu geri yazmaz.
- **Kiracılık:** oturumsuz yazıcı `runWithOrg(feed.orgId, …)` içinde çalışır
  (`src/lib/rosterIngestStore.ts` deseni). Sözleşme bir MARKETING `Organization`
  başınadır, "CRM" başına değil.

## PII minimizasyonu

Sözleşme **hesabın hacmini ve yaşam döngüsünü** taşır, kişiyi değil.

- Kişi alanları (`contact`) **yalnızca `account_created`**'da gelir; sonraki
  hiçbir olay ad ya da e-posta taşımaz, eşleştirme `external_id` ile yapılır.
- **Hiç gönderilmeyenler:** parola hash'i, `google_sub`, MFA sırları, `fail_log`,
  `success_login`, `client_info` / IP / tarayıcı, banka bilgisi, `phone`,
  `acquisition_note` (serbest metin), fesih anketinin `description`'ı (serbest
  metin — [K-6](#k-6)), tüccarın **kendi müşterilerine** ait her şey (sipariş
  satırları, alıcı adları, adresler), ve para (ciro, fatura tutarı, MRR — CRM'in
  kendi kaydı).
- **`newsletter` bayrağı gönderilmez.** Taşınsaydı biri onu izin sanardı; CRM'in
  makine yolları iletişim iznine yalnızca `NONE` yazar (#2577). Kayıt formunda kutu
  önceden işaretli olduğu için (`Registration.jsx:46`) bu bayrak bugün zaten rıza
  değildir; SV-6 yapıldıktan sonra da CRM için dayanak sayılmaz.
- **DemoLead** (demo oturumundan yalnızca e-posta, `src/models/demo-lead/demo-lead.model.ts`)
  bu sözleşmede **yok** — [Açık karar K-3](#k-3).
- Veri koruma kaydı burada yeniden yazılmıyor: [`docs/trust/subprocessors.md`](../trust/subprocessors.md)
  (besleme **gelen** yönlüdür) ve [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md)
  kural 5 (katkıcı gerçek beslemeye bağlanmaz).

## SaleVali karşı işleri (SaleVali repolarında açılacak)

Her biri SaleVali repolarında ayrı bir issue olur ve buraya linklenir (#2565'in
kabul kriteri). Buradan açılmadı — SaleVali backlog'u o ekibin.

| # | Repo | İş | Dayanak |
|---|---|---|---|
| **SV-1** | server | **Yaşam döngüsü outbox'ı**: MAIN_DB'de ekleme-yalnız bir koleksiyon (index `src/indexes/specs.ts`'te, `scope: 'main'`); yukarıdaki her geçiş noktası iş yazmasıyla birlikte bir satır yazar. Pasifleşme (`user.service.ts:551`) ve fesih tamamlanması — **iki** yazarı: `user.service.ts:688-693` ve `user.controller.ts:1825` — bugün yalnızca log satırı bırakıyor | Uç B'nin önkoşulu |
| **SV-2** | server | **Olay export ucu** `GET /integrations/crm/events` (imleç, sayfa tavanı, allowlist kapsamı) — ya da K-2 push seçilirse outbox'tan CRM'e teslim eden bir iş (`JobQueueService`, yeniden deneme) | Uç B |
| **SV-3** | server | **Günlük kullanım kovaları + export ucu** `GET /integrations/crm/usage-daily`: `TenantUsageCronJob` her tenant'ın son 7 UTC gününü faturalama tanımıyla (`admin-user.service.ts:505-525`) MAIN_DB'deki günlük bir koleksiyona yazar; uç onu CSV verir | Uç A |
| **SV-4** | server | **Makine kimlik doğrulaması**: iki uç için amaca özel header'lı paylaşılan sır (`X-Demo-Export-Secret` emsali), sabit zamanlı karşılaştırma, `RATE_LIMITER_BY_METHOD` kaydı, `AuditLog` kaydı, OpenAPI `security: []` + kendi kontrolü; `docs/SECURITY_GUIDE.md` §13 checklist'i | A, B |
| **SV-5** | client + server | **Fesih anketi kod göndersin, çevrilmiş etiket değil.** İstemci seçili seçeneğin **etiketini** gönderiyor (`salevali-client/.../account-dialogs/AccountCancellationDialog.jsx:106-110` → `selectedSurvey.push(item.label)`), yani sunucuda anket kullanıcının dilinde serbest metin olarak duruyor (`user.model.ts:237`, `account-log.model.ts` `surveys`). Kodlar zaten istemcide var: `service`, `price`, `dissatisfaction`, `difficulty`, `other` (:43-69). Eski kayıtlar için dört dildeki etiketten koda bir backfill | K-6, #2573 |
| **SV-6** | client | **Newsletter kutusu varsayılan kapalı + DOI** (`Registration.jsx:46` `newsletter: true`). Aynı nesnede `acceptTerms: true` (:45) da önceden işaretli — o SaleVali'nin kendi hukuki sorusu, bu sözleşmenin değil, ama aynı satırda görüldüğü için not edildi | C, #2577 |
| **SV-7** | server | Ölü alan: `license.cancellation` (`LicenseCancelled`, `cancelledBy`/`cancelledAt`/`description`) hiçbir yerde yazılmıyor; ya yazılsın ya kaldırılsın. Sözleşme ona dayanmıyor | temizlik |
| **SV-8** | server (opsiyonel) | Kayıtta UTM alanları yok (`User`/`TempUser`'da yalnızca `acquisition_source` anketi ve `reference`); #2450 UTM taşımak istiyorsa önce SaleVali yakalamalı | #2450 madde 6 |

## SaleVali karşı işi gelince CRM'de açılacaklar (şimdi açılmadı)

| # | İş | Bağımlılık |
|---|---|---|
| **I-1** | Olay işleyici: pull işi ya da #2450 ucu, işlenmiş `event_id` kaydı, hesap başına yüksek su işareti, aşama eşlemesi `stageChange.ts` üzerinden | SV-1, SV-2, K-2, K-5 |
| **I-2** | Fesih anketi kodlarını #2573'ün MARKETING kayıp nedeni kodlarına eşleme | SV-5, #2573, K-6 |
| **I-3** | Fesih / win-back penceresi için dikkat sebebi | #2572 kararı |
| **I-4** | (Push seçilirse) `companies:write` scope'u, `check:api-key-routes`'un `/api/v1` dışını kapsaması, `docs/security-audit-playbook.md` matrisine satır | K-2, #2450 |
| **I-5** | `CompanyUsage.documents` (nullable) ve hesap düzeyinde `channels` — ikisi de export'ta var, CRM'de sütunu yok | #2447 |
| **I-6** | Hesap dili (`language`) için bir hedef ya da bilinçli "tutulmaz" kararı | — |

#2554 (import kolonu), #2447 (gecelik iş) ve #2450 (ingest) gövdeleri bu dosyaya
atıf yapmalı ve K-1'in biçimini (küçük harf 24-hex) kullanmalı.

## Açık kararlar

<a id="k-1"></a>**K-1 · `externalId` = `User._id`** — *öneri, onay bekliyor.*
Yukarıda gerekçesiyle. Onaylanırsa #2554'ün "öneri" ifadesi karar olur.

<a id="k-2"></a>**K-2 · Olay taşıması: pull mu push mu?** — *açık.* Öneri **pull**
(SaleVali'de outbound altyapı yok, DemoLeadSync emsali, sır tek tarafta, kaçan
tur kendiliğinden kapanır). Push'un tek gerçek artısı gecikme: pull 15 dakikada
bir koşarsa (DemoLeadSync `*/15`) bir deneme lead'i en geç ~15 dakikada CRM'de.
Pull seçilirse #2450'nin "uç" kısmı bir pull işine dönüşür; yazıcı aynı kalır.

<a id="k-3"></a>**K-3 · Doğrulanmamış kayıtlar (`TempUser`) ve DemoLead CRM'e gelir mi?** —
*açık.* Öneri **hayır**: `TempUser` doğrulanmamış e-postadır (bot, yazım hatası),
id'si yaşamaz; DemoLead yalnızca bir e-posta + oturum süresidir ve kişiye yazma
dayanağı yoktur. İkisi de SaleVali'nin kendi admin ekranlarında kalır. "Kayıt
başladı ama doğrulanmadı" bir satış sinyali olarak istenirse ayrı, kişisiz bir
sayaç olarak gelir.

<a id="k-4"></a>**K-4 · `standard` lisans tipi** — *açık.* Enum'da var
(`license.model.ts:13`), faturalanmıyor (`admin-user.service.ts:366`). Kullanılan
bir tip mi, eski mi? Cevaba göre kapsam tablosuna girer ya da çıkar.

<a id="k-5"></a>**K-5 · `trialEndsAt` ve `upgrade_confirmed`'ın aşaması** — *açık,
#2572'ye bağlı.* Öneri: `trialEndsAt` = **serbest dönemin sonu** (`trial_ends_at`),
çünkü "premium'a geç?" sorusu o an çıkar ve satışçının araması gereken an odur;
`decision_ends_at` pencereyi kapatan tarih olarak ayrıca taşınır ve
`TRIAL_EXPIRED` SLA'sı (bugün 3 gün, `programTemplates.ts:589`) pencereyle
uyumlu hâle getirilir. `upgrade_confirmed` için iki seçenek: (a) `DEAL_WON`'a
taşır (taahhüt anı), `converted` yalnızca faturalama başlangıcını damgalar;
(b) aşamaya dokunmaz, `DEAL_WON` `converted` ile gelir.

<a id="k-6"></a>**K-6 · Pasifleşme ve fesih nedenleri** — *açık.* Pasifleşmenin
`DEAL_LOST` neden kodu (öneri `NO_RESPONSE`: kullanıcı karar penceresinde hiçbir
şey seçmedi). Fesih anketi → #2573 kodları için önerilen eşleme:
`price` → `PRICE`, `service` → `TECHNICAL_ISSUE`, `difficulty` → `NOT_A_FIT`,
`dissatisfaction` → `MISSING_FEATURE`, `other` → `OTHER` — ilk ikisi dışındakiler
yorum, onay ister. Anketin serbest metni (`description`) **gönderilmez** öneriyle;
gönderilecekse yalnızca admin'in okuduğu `ActivityLog`'a gider, ilişkiye değil
(`docs/mentor-transfer.md`'deki gerekçenin aynısı).

<a id="k-7"></a>**K-7 · Silinen hesap** — *açık.* SaleVali'de silinen ya da purge
edilen bir hesabın CRM'deki `Company` + lead `User`'ına ne olur: silme yüzeyi
(#2559) tetiklenir mi, yoksa kayıt `externalId` boşaltılıp ticari geçmiş olarak
kalır mı? Öneri: `deleted` olayı kişisiz gelir, CRM kaydı otomatik silmez ama
operatöre silme yüzeyinde gösterir.

<a id="k-8"></a>**K-8 · `transactions` tanımı** — *öneri, onay bekliyor.*
Faturalanan işlem (sipariş + manuel fatura + credit), `LogEntry` değil. Onay
SaleVali ürün ekibinden de gelmeli: churn sinyali ile fatura aynı sayıyı konuşur.
