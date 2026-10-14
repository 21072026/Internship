# MARKETING_FUNNEL aşamaları ve DEAL_WON sonrası müşteri durumu (#2572)

> **Durum: KARAR — maintainer onayı 2026-10-07.** Aşağıdaki "Öneri" satırlarının hepsi
> onaylandı ve karar oldu; [§ Maintainer'a açık sorular](#maintainera-açık-sorular) da
> aşağıda verilen varsayılanlarla kapandı. Uygulama task'ları
> [§ Uygulama task'ları](#onaylanırsa-açılacak-uygulama-taskları-taslak) altında issue
> numaralarıyla duruyor; [`pipeline-record.md`](pipeline-record.md) → "Around the trial
> and after `DEAL_WON`" buraya işaret eder.
>
> Parent: #2571 · İlgili: #2425 (churn/retention), #419 (bir mentee bir aktif mentor),
> #2391 / #2555 (gerçek tablo cutover'ı), #2565 (upstream kaynağın karşı işi: hesap olayları).

Satır numaraları `origin/main` üzerinde doğrulandı (2026-09-29).

## Neden şimdi

Cutover (#2555) MARKETING kiracısının mevcut ücretli müşterilerini **bir aşamayla** içe aktaracak. O
aşamanın ne olduğu, müşteri durumunu (aktif / fesih bildirdi / feshetti / geri kazanıldı)
nerede tuttuğumuza bağlı. Bu dosya o soruyu, kodun bugün gerçekte ne yaptığına dayanarak
cevaplar.

## Bugün kodda olan (değiştirilmeyen zemin)

| Gerçek | Nerede |
| --- | --- |
| Preset: `LEAD_NEW → LEAD_CONTACTED → LEAD_QUALIFIED → TRIAL_ACTIVE → TRIAL_EXPIRED → DEAL_PROPOSAL → DEAL_NEGOTIATION → DEAL_WON` + off-path `DEAL_LOST` | `src/lib/programTemplates.ts:546-570` |
| `DEAL_WON` terminal + on-path; `DEAL_LOST` terminal + **off-path** | `src/lib/programTemplates.ts:566`, `:568` |
| SLA'lar: `TRIAL_EXPIRED` 3 gün, `DEAL_PROPOSAL` 5, `DEAL_NEGOTIATION` 7; `TRIAL_ACTIVE`'in bilinçli olarak SLA'sı yok | `src/lib/programTemplates.ts:573-592` (`:589` = TRIAL_EXPIRED) |
| Off-path bir aşamaya geçiş `reasonCode` ister (whitelist); `OTHER` ayrıca not ister | `src/lib/stageChange.ts:21-24` (`isNegativeStage`), `:39-54` (`validateDropoffReason`) |
| Drop-off kodları staj diline göre yazılmış: `CANDIDATE_WITHDREW`, `NO_RESPONSE`, `ACCEPTED_ELSEWHERE`, …, `COMPANY_CANCELLED`, `OTHER` | `src/lib/dropoffReasons.ts:6-16` |
| Terminal bir aşamadan çıkışı (ör. `DEAL_WON → DEAL_LOST`) engelleyen **hiçbir** yazma kuralı yok | `src/app/api/status-changes`, `src/app/api/mentorship/[id]` — `isTerminal` okunmuyor |
| Terminal/off-path aşamada aşama saati durur | `src/lib/stageClock.ts:148-156` (`stageClockStopped`) |
| **#2425 kararı zaten kodda:** churn = "kazanıldıktan **sonra** bir kayıp aşamasına varış", yeni `CHURNED` aşaması **yok** | `src/lib/funnelKpi.ts:322-348` (yorum), `:350` (`retentionTriangle`) |
| Kohortlar ve triangle yalnızca **aynı ilişkinin** `StatusChange` satırlarını okur; `status` filtresi yok (COMPLETED de dahil) | `src/app/api/admin/analytics/funnel/route.ts:105-123`, `:131-137` |
| "Kazanıldı olarak başlayan" (içe aktarılmış) bir yolculuk, `startDate` ayında kazanılmış sayılır | `src/lib/funnelKpi.ts:382-383`; `startedAt: r.startDate` → `route.ts:136` |
| "Kazanıldı" = son on-path aşama ve ötesi; "kayıp" = off-path aşamalar | `src/lib/pipelineStages.ts:243-258` (`outcomeStageKeysFrom`) |
| Faturalanan birim: `status ∈ ['ACTIVE']` **ve** ayda herhangi bir aktivite; `COMPLETED` sayılmaz | `src/lib/meteringRules.ts:45`, `src/lib/metering.ts:62-73` |
| Dikkat kuyruğu yalnız `status: 'ACTIVE'` ilişkileri okur; `trial_expired` bir sebep | `src/lib/mentorAttention.ts:12`, `:56`, `:151` |
| Deneme süresi varsayılanı 30 gün; hatırlatma basamakları 7/3/0 gün | `src/lib/trialReminderRule.ts:81`, `:105` |
| Süresi dolan deneme `TRIAL_ACTIVE → TRIAL_EXPIRED` otomatik taşınır (#2417) | `src/lib/jobs/trialReminders.ts:375` (`expireTrials`) |
| Sözleşmesel tarih `stageDeadline`'a değil kendi kolonuna yazılır (`trialEndsAt`) | `prisma/schema.prisma:2242-2250` (gerekçe yorumu) |
| `previousRelationId` bugün **yalnız** mentör transferinde yazılır; şirket sayfası zinciri "önceki eşleştirme (mentör X)" diye okur | `src/lib/mentorTransfer.ts:275`, `:423`; `src/lib/companyDetail.ts:90-111` |
| İlişki sonu kodları: `lifecycleState ∈ {ENDED_REMATCHED, ENDED_REASSIGNED}` | `src/lib/relationLifecycle.ts:17-31` |
| `Company` üzerinde müşteri durumu / fesih alanı **yok** | `prisma/schema.prisma:1295` (`model Company`) |
| Hesap × gün kullanım tablosu var (`transactions`), henüz okuyan yok | `prisma/schema.prisma:1407` (`CompanyUsage`), [`usage-feed.md`](../usage-feed.md) |

Kiracının ürünü (upstream kaynak sistem) tarafındaki model, kararın dayandığı kadarıyla:
bir **serbest dönem** (deneme), ardından bir **karar penceresi** — müşteri pencere içinde
ücretli plana geçişi kendisi onaylamazsa hesap kapanır. Serbest dönemin uzunluğu deneme
tipine göre değişebilir; karar penceresi değişmez. Kazanma anı müşterinin **kendi
yükseltme onayıdır**: ürünün teklif ya da pazarlık adımı **yoktur**. Fesih bir **ihbar
süresiyle** işler: müşteri fesih bildirir, sözleşme ihbar süresinin sonunda biter.

Kaynak sistemin bu durumları hangi alanlarda tuttuğu ve cutover'ın hangi alanı okuyacağı
kiracıya özgüdür ve bu repoda tutulmaz. Tek genel ders: fesih tarihi, kaynağın gerçekten
**yazdığı** alandan okunmalıdır — model dosyasında duran ama hiçbir kodun yazmadığı bir alana
dayanan bir cutover veya besleme hiçbir fesih bulmaz ve ihbar süresindeki her müşteriyi düz
aktif diye aktarır.

## Asıl soru (3): DEAL_WON sonrası müşteri durumu nerede?

### Seçenek A — `Company` üzerinde durum alanı + tarihler

`Company.customerStatus` (`ACTIVE | NOTICE_GIVEN | CHURNED | WON_BACK`) +
`customerSince`, `cancellationNoticeAt`, `contractEndsAt`, `churnedAt`.

- **Artı:** Tek bakışta okunur; şirket listesinde filtre kolay; bir hesabın birden çok
  funnel kaydı olsa da durum tektir.
- **Eksi — ikinci durum makinesi.** `pipeline-record.md` "`Company` üzerinde
  `pipelineStatus` yok" ve "Company düzeyinde aşama geçmişi yok" diyor; müşteri durumu tam
  olarak o, yalnızca başka bir adla. Geçmişi `StatusChange` tutmaz, dolayısıyla
  `retentionTriangle` (`funnelKpi.ts:350`) churn'ü **görmez** — ya ikinci bir churn hesabı
  yazılır (#2425'in reddettiği şey) ya da iki kaynak elle senkron tutulur.
- **Eksi — `Company` dikeyler arası master data.** INTERNSHIP dikeyinde aynı model
  "stajyer alan şirket"tir; `customerStatus` orada anlamsız bir kolon olur.
- **Eksi:** Dikkat kuyruğu, SLA, aşama saati, board hiçbirini okumaz; her biri yeniden
  öğretilir.

### Seçenek B — yeni preset aşamaları (`CUSTOMER_ACTIVE`, `CANCELLATION_NOTICE`, `CHURNED`)

Ayrı bir müşteri yaşam döngüsü — *aktif müşteri → fesih bildirdi → churn* — ayrı bir CRM'in
tutacağı türden, preset aşaması olarak.

- **Artı:** Board'da görünür; `StatusChange` geçmişi kendiliğinden; `CHURNED` off-path
  olursa triangle onu kayıp sayar.
- **Eksi — #2425'e doğrudan aykırı.** `funnelKpi.ts:322-348` gerekçeyi yazıyor: preset
  aşaması yalnız o preset'i alan ve o günden sonra kurulan org'larda olur; mevcut org'lar
  "müşteri ayrıldı"yı ifade edemez.
- **Eksi — "kazanıldı" tanımı kayar.** `outcomeStageKeysFrom` (`pipelineStages.ts:243-251`)
  kanonik bir sonuç anahtarı bulamayınca **son on-path aşamayı** çapa alır. `DEAL_WON`
  terminal kalırken ardına on-path `CUSTOMER_ACTIVE`/`CANCELLATION_NOTICE` eklenirse çapa
  `CANCELLATION_NOTICE` olur ve "kazanıldı" = yalnız fesih bildirenler — dönüşüm oranı ve
  triangle sessizce yanlış olur. Düzeltmek, sonuç kuralını değiştirmek demektir.
- **Eksi:** `DEAL_WON` terminal (`programTemplates.ts:566`) — saat duruyor; ardına aşama
  eklemek "terminal"in anlamını da bozar. `e2e/vertical-stage-preset.spec.ts:38-40`
  preset listesini sabitler.

### Seçenek C — funnel `DEAL_WON`'da biter; durum = olay + tek sözleşme tarihi + dikkat sebebi *(karar)*

| Müşteri durumu | Nasıl ifade edilir | Yeni şey |
| --- | --- | --- |
| **Aktif** | `pipelineStatus = DEAL_WON`, `status = ACTIVE` | yok |
| **Fesih bildirdi** | hâlâ `DEAL_WON` (müşteri ihbar süresince **öder**); ilişkide sözleşmesel bitiş tarihi + yeni dikkat sebebi `cancellation_pending` | `MentorshipRelation.contractEndsAt DateTime?` (nullable, additive — `trialEndsAt`'in aynı deseni ve aynı gerekçesi, `schema.prisma:2242-2250`); `AttentionReason`'a bir değer |
| **Feshetti** | `DEAL_WON → DEAL_LOST` `StatusChange`, `reasonCode` ile | yeni drop-off kodu (ör. `CUSTOMER_CANCELLED`) — `COMPANY_CANCELLED` stajda "şirket stajı iptal etti" demek, yeniden kullanmak iki anlamı bir koda yığar |
| **Geri kazanıldı** | yeni yolculuk (yeni ilişki), `previousRelationId` → eski ilişki; bkz. soru 4 | eski ilişkiyi kapatan bir `lifecycleState` değeri (ör. `ENDED_CHURNED`) |

- **Artı — #2425 ile birebir.** Churn tam olarak `funnelKpi.ts:322-348`'in tanımıdır:
  kazanımdan sonra `DEAL_LOST`'a varış. Triangle, kohortlar, sonuç kuralı hiç değişmez;
  mevcut org'lar da ilk günden doğru churn okur.
- **Artı — ikinci taşıyıcı yok.** `pipeline-record.md`'nin dışladığı her şeyden uzak durur;
  `Company` master data olarak kalır.
- **Artı — sözleşmesel tarih doğru yerde.** İhbar tarihi bir SLA değil (`stageSla.ts` her
  aşama değişikliğinde `stageDeadline`'ı yeniden yazar); aşama değişikliğine dayanması
  gereken bir tarih — `trialEndsAt` ile aynı sınıf.
- **Eksi:** "Fesih bildirmiş müşteriler" board'da ayrı sütun değildir; dikkat kuyruğu ve
  (gerekirse) bir filtre ile görünür.
- **Eksi:** Metering — kazanılmış müşteri `ACTIVE` kalır ve ayda bir etkileşim alırsa
  `activeMatchedPairs` onu sayar (`metering.ts:62-73`). Bu MARKETING kiracısı için "bakımdaki
  müşteri" anlamına gelir ve tanım gereği doğrudur; ama bugün `DEAL_LOST` kayıtlar da
  `ACTIVE` kalıyor (hiçbir yazma yolu `status`'u değiştirmiyor), dolayısıyla dokunulan bir
  kayıp da sayılır. Bkz. açık soru 5.
- **Eksi — kazanılmış müşterinin sahibini değiştirmek rutinleşir ve bugün "ikinci kazanım"
  üretir.** Müşteri ömrü boyunca `DEAL_WON`'da kaldığı için hesap sahibi değişikliği sık bir
  işlem olur. Geçmişi olan bir ilişkide `POST /api/mentorship/[id]/transfer`, `CARRIED_OVER_FIELDS`'ı
  (`src/lib/relationHistory.ts:60-68`: `pipelineStatus`, `trialEndsAt`, …) kopyalayan ve
  **yeni `startDate`** taşıyan yeni bir ilişki açar. Funnel route'u status filtresi uygulamaz
  (`route.ts:132-137`) ve triangle kazanılmış aşamada başlayan yolculuğu `startDate` ayında
  kazanılmış sayar (`funnelKpi.ts:382-383`): müşteri transfer ayında **ikinci kez kazanılmış**
  görünür, sonraki churn yalnız halef ilişkide kayda geçer. Ayrıca `contractEndsAt`
  `CARRIED_OVER_FIELDS`'a eklenmezse ihbar süresindeki bir transfer sözleşme bitişini
  **sessizce** düşürür. Uygulama task'ları 2 ve 9 bunu kapatır; triangle'ın zinciri nasıl
  birleştireceği açık soru 6.

"Salt olay kaydı" (tarih kolonu olmadan, ihbarı yalnız `InteractionLog`/`ActivityLog`'a
yazmak) değerlendirildi ve **reddedildi**: dikkat sebebi ve bitiş hatırlatması bir tarihe
ihtiyaç duyar; o tarihi serbest metinli bir olay satırından türetmek, `trialEndsAt`'in
kaçındığı kırılganlığın aynısıdır.

**Karar: C.**

## Diğer sorular

### 1. `DEAL_PROPOSAL` ve `DEAL_NEGOTIATION` preset'te kalsın mı?

Kiracının ürününde teklif/pazarlık adımı yok; kazanma müşterinin kendi yükseltme onayıdır.
Bugünkü preset `TRIAL_EXPIRED`'dan sonra iki aşama daha ister ve bunlara SLA bağlar
(`programTemplates.ts:590-591`), yani bir kayıt hiç olmayan bir adımda "gecikmiş"
görünebilir.

**Öneri:** yeni MARKETING org'larının preset'inden **kaldır**; mevcut org'larda backfill
**yok** (kiracı kendi siler — `PipelineStage` satırları kiracınındır, #747). Maliyet —
aynı PR'da güncellenmesi gerekenler:
- `e2e/vertical-stage-preset.spec.ts:38-40` (preset listesi) ve `docs/marketing-import.md:80`;
- `prisma/seed-demo-marketing.mjs:89-100` — `MARKETING_DEMO_STAGES` preset'in düz ESM
  aynasıdır ve `scripts/test/marketing-demo-tenant.test.mjs:52` onu preset'le `deepEqual`
  karşılaştırır; ayrıca bu aşamalardaki demo kayıtları (`:164-170`, `droppedFrom` ile `:178-179`)
  ve aşama başına etkileşim metinleri (`:245-249`) yeniden dağıtılır;
- `scripts/fixtures/marketing-accounts-sample.csv:4` — `DEAL_PROPOSAL` satırı yeni bir org'a
  aktarılamaz hâle gelir;
- `docs/marketing-vertical/pipeline-record.md:38-39` preset diyagramı;
- `src/lib/programTemplates.ts:587` ve `src/lib/mentorAttention.ts:135` yorumları ("teklife
  ya da kayba dönüşür").

`scripts/test/funnel-cohorts.test.mjs` bu anahtarları yalnız saf fonksiyon fikstürü olarak
kullanır, preset'e bağlı değildir. Uyarı: preset **tüm** MARKETING org'ları içindir — başka
bir (teklif veren) MARKETING kiracısı beklenirse kaldırmak yerine yalnız o kiracının org'unda
silmek daha dürüst olur (açık soru 1).

### 2. `TRIAL_EXPIRED` = 30 günlük karar penceresi mi? `trialEndsAt` neyin sonu?

Kiracının ürününün iki eşiği var: serbest dönemin sonu ve karar penceresinin sonu (serbest
dönemden sonra sabit bir süre; pencere kapanınca hesap kapanır).

**Öneri:**
- `trialEndsAt` = **serbest kullanımın sonu**. `DEFAULT_TRIAL_LENGTH_DAYS = 30`
  (`trialReminderRule.ts:105`) ve 7/3/0 hatırlatmaları (`:81`) zaten bunu sayıyor — 30 gün
  yalnız bir varsayılandır; daha uzun serbest dönemli bir deneme varsayılana güvenmez,
  importer'ın gerçek `trial_ends_at` kolonu (task 7) her tipi kapsar; "ücretli plana geç?"
  sorusunun ürün içinde göründüğü an budur, satış temasının en değerli olduğu an da budur.
- `TRIAL_EXPIRED` = **karar penceresi** olarak etiketlenir/açıklanır; pencerenin sonu ayrı
  bir kolon değil, `trialEndsAt + 30 gün` olarak türetilir (tek sabit, `trialReminderRule.ts`'te;
  pencere her deneme tipinde aynıdır).
- SLA: 3 gün "kimse dokunmadıysa gecikmiş" anlamında bir **iç** saat olarak savunulabilir,
  ama 30 günlük pencereyle yan yana "3 günde karar ver" gibi okunur. **7 gün** öner
  (sona erişten sonraki ilk bir hafta içinde insan teması); pencerenin kapanmasına yakın
  (ör. `trialEndsAt + 23 g`) ayrı bir "karar penceresi kapanıyor" hatırlatması uygulama
  task'ı olur. Otomatik süre dolumu artık aynı transaction'da `changedById: null` ile bir
  `StatusChange` yazıyor (#2527, `src/lib/jobs/trialReminders.ts:414-428`, satır `:426-427`),
  dolayısıyla aşama saati ve SLA başlangıcı doğru. (`mentorAttention.ts:144-150`'deki "sweep
  `StatusChange` yazmıyor" yorumu bayattır; o dosyaya dokunan ilk PR düzeltir.)

### 3. DEAL_WON sonrası durum

Yukarıda — **Seçenek C**.

### 4. Feshedip geri gelen müşteri: yeni journey mi, durum geri dönüşü mü?

- **İhbar süresi içinde vazgeçen** müşteri hiç `DEAL_WON`'dan çıkmadı: `contractEndsAt`
  temizlenir, aşama hareketi **yok**. Churn sayılmaz — doğru.
- **Sözleşmesi bitmiş (`DEAL_LOST`) ve sonra dönen** müşteri: **yeni journey**, yeni
  ilişkinin `previousRelationId`'si eski ilişkiye işaret eder; eski ilişki `COMPLETED` +
  yeni `lifecycleState` (ör. `ENDED_CHURNED`) ile kapanır — #419 gereği aynı lead kişinin
  iki `ACTIVE` ilişkisi olamaz (`src/lib/activeMentorship.ts`), ve kapanış "başarılı
  tamamlanma" gibi okunmamalıdır (`relationLifecycle.ts` bu ayrım için var).
  Yeni journey gerçekten girdiği aşamada başlar (yeniden deneme → `TRIAL_ACTIVE`, doğrudan
  yeniden imza → `DEAL_WON`).
- **Neden yerinde `DEAL_LOST → DEAL_WON` değil:** triangle ilk kazanımı ve ilk kaybı sayar
  (`funnelKpi.ts:398-401`) — yerinde geri dönüş churn'ü doğru tutar ama geri kazanımı hiçbir
  kohortta **kazanım** olarak göstermez ve ikinci bir deneme penceresini (`trialEndsAt` asla
  üzerine yazılmaz) açamaz. Yeni journey her ikisini de doğru sayar.
- **Bedel:** `previousRelationId` bugün transfer anlamı taşıyor ve `companyDetail.ts:90-111`
  zinciri "önceki eşleştirme (mentör X)" diye basıyor. Zincirin sebebi (`lifecycleState`)
  okunarak etiket ayrılmalı — uygulama task'ı. Yeni kolon gerekmiyor.

### 5. Canlı demo nerede kayıtlı?

**Öneri:** `InteractionLog` (`type = Meeting`, `schema.prisma:39-45`) — yeterli. Aşama
**değil** (ayrı bir "demo planlandı / yapıldı" aşaması alınmıyor): demo, son
temas kuralının (`docs/last-contact.md`) ve metering aktivite sinyallerinin
(`meteringRules.ts:66-74`) zaten okuduğu bir olaydır. Planlanmış demo için `Meeting` modeli
ve sahibin `nextActionAt`'i (#2563) var. "Demo yapıldı mı?" oranı gerekirse bir analitik
sorgusudur, aşama değil.

### 6. Ücretsiz kota aşımı upsell sinyali olarak nerede?

**Öneri:** `CompanyUsage.transactions` (`schema.prisma:1407`) üzerinden, gecelik kullanım
işinin (#2447) hesapladığı **dikkat sebebi** (ör. `free_quota_exceeded`) — aşama değil,
`Company` durumu değil. Sinyal ilgili hesabın **açık** funnel kaydına düşer (dikkat kuyruğu
`status: 'ACTIVE'` okur, `mentorAttention.ts:56`). Kota eşiği bir kiracı ayarıdır,
koda gömülmez. Tetik kuralı ve eşik [`usage-feed.md`](../usage-feed.md)'ye
yazılır.

### 7. Cutover: mevcut ücretli müşteriler hangi aşama/durumla içe aktarılır?

| Kaynak sistemdeki hâl | Aşama | Ek alan |
| --- | --- | --- |
| Ücretli, aktif | `DEAL_WON` | `startDate` = **müşteri olduğu tarih** (kaynağın yükseltme onayı tarihi) |
| Ücretli, fesih bildirmiş | `DEAL_WON` | `contractEndsAt` = fesih bildiriminin tarihi + ihbar süresi — kaynağın gerçekten yazdığı alandan |
| Deneme, serbest dönemde | `TRIAL_ACTIVE` | `trialEndsAt` = kaynaktaki **gerçek** serbest dönem sonu |
| Deneme, karar penceresinde | `TRIAL_EXPIRED` | `trialEndsAt` = aynı |
| Pasif / feshetmiş | **aktarılmaz** ilk turda (win-back listesi ayrı karar) | — |

Her hücrenin kaynak alanı kiracıya özgüdür ve bu repoda tutulmaz.

**Kritik:** triangle içe aktarılan kazanılmış bir kaydı `startDate` ayında kazanılmış sayar
(`funnelKpi.ts:382-383`, `route.ts:136`). `startDate` varsayılanla (`now()`,
`schema.prisma:2204`) yazılırsa **tüm** müşteri tabanı cutover ayının kohortuna yığılır ve
o satırın retention'ı anlamsızlaşır. Importer'ın bugün böyle bir kolonu yok
(`docs/marketing-import.md:55-72`'de `customer_since` yok) → uygulama task'ı. Aynı tuzak
denemede de var: importer `TRIAL_ACTIVE`'e yazdığı kayda `trialEndsAt` = **çalışma anı** +
`trialLengthDays` damgalar (`docs/marketing-import.md:183-188`) — yarısı geçmiş bir
deneme 30 gün uzamış görünür; gerçek bitişi taşıyan bir `trial_ends_at` kolonu aynı task'a
girer. `DEAL_LOST`
aktarımı off-path olduğu için `reasonCode` gerektirir; ilk turda dışarıda bırakmak bu
yüzden de basittir.

## Uyum kontrolü (kabul kriteri 2)

- **#2425:** yeni aşama yok; churn = kazanımdan sonra `DEAL_LOST`. ✔ (Seçenek C)
- **#419:** geri kazanım yeni ilişki açmadan önce eskisini kapatır; hiçbir yol iki `ACTIVE`
  ilişki bırakmaz. ✔
- **Donuk `Role` enum'u:** yeni rol yok. ✔
- **`pipeline-record.md`:** ikinci taşıyıcı yok, `Company`'de aşama/durum yok. ✔

## Onaylanırsa açılacak uygulama task'ları (taslak)

Açıldı (2026-10-07): 1 → #2840 · 2+3 → #2841 · 4 → #2842 · 5 → #2843 · 6 → #2846 ·
7 → #2844 · 8 → upstream kaynak sistemin kendi işi (bu repo dışında) ·
9 → #2845 · açık soru 5 → #2847.

1. Preset: `DEAL_PROPOSAL`/`DEAL_NEGOTIATION` yeni org'lardan kaldırılır; `TRIAL_EXPIRED`
   SLA'sı 3 → 7; e2e preset spec'i, `marketing-import.md`, demo seed aynası
   (`MARKETING_DEMO_STAGES` + demo kayıtları, parite testi `marketing-demo-tenant.test.mjs`),
   örnek CSV fikstürü, `pipeline-record.md` diyagramı ve `programTemplates.ts`/`mentorAttention.ts`
   yorumları aynı PR'da güncellenir (bkz. soru 1).
2. `MentorshipRelation.contractEndsAt` (nullable) + `cancellation_pending` dikkat sebebi +
   sözleşme bitiş günü hatırlatması; MENTEE'ye dönen okuma yollarında gizleme
   (`stripNextActionFor` deseni); `contractEndsAt` `CARRIED_OVER_FIELDS`'a
   (`relationHistory.ts:60-68`) ve `scripts/test/mentor-transfer.test.mjs` aynasına eklenir —
   yoksa ihbar süresindeki bir transfer bitiş tarihini düşürür.
3. `CUSTOMER_CANCELLED` drop-off kodu (EN/TR/DE etiket, `check:i18n`).
4. `lifecycleState = ENDED_CHURNED` + geri kazanım akışı (eski ilişkiyi kapat, yeni ilişkiyi
   `previousRelationId` ile aç — `activeMentorship.ts` üzerinden) + `companyDetail.ts` zincir
   etiketinin sebebe göre ayrılması.
5. Karar penceresi sonu türetimi (`trialEndsAt + 30`) ve "pencere kapanıyor" hatırlatması.
6. Kota aşımı dikkat sebebi (#2447'ye bağlı).
7. Importer: `customer_since` → `startDate`, `trial_ends_at` → `trialEndsAt` (çalışma anı
   yerine), `contract_ends_at` → `contractEndsAt`
   (#2555 bu dosyanın 7. maddesine referans verir).
8. Upstream kaynağın karşı işi (#2565): onay ve fesih olaylarının beslemeye çıkması —
   yükseltme onayı ve tarihi; fesih bildirimi ve kapanış geçişleri, her biri kaynağın
   gerçekten yazdığı alandan. 2 ve 4'ün otomatik tetiği.
9. Triangle/kohortlar sahip değişikliğini kazanım saymaz: `ENDED_REASSIGNED` +
   `previousRelationId` ile zincirlenen ilişkiler tek yolculuk olarak birleştirilir (ya da halef
   atlanır), churn zincirin ilk kazanımına bağlanır (bkz. Seçenek C eksileri, açık soru 6).

## Maintainer'a açık sorular

Hepsi 2026-10-07'de kapandı ("önerileri olduğu gibi onayla"). Açık bir önerisi olmayan
sorularda kararlaştırılan varsayılan, ilkesiyle birlikte:

1. **Preset tüm MARKETING kiracıları içindir** → `DEAL_PROPOSAL`/`DEAL_NEGOTIATION` yeni
   org'ların preset'inden kalkar; mevcut org'larda backfill yok (kiracı kendi siler).
2. **`TRIAL_EXPIRED` SLA'sı 7 gün.**
3. **İhbar süresi dolunca otomatik `DEAL_WON → DEAL_LOST` yok** — yalnız dikkat sebebi
   (`cancellation_pending`, bitiş gününde de) ve insan kararı. Gerekçe: bir müşterinin kaybı,
   otomatik bir yazmanın yanlış kaydedemeyeceği kadar pahalı bir olay; geri dönüşü olmayan
   bir aşama hareketinin bir insanı olmalı. Otomatik tetik, kaynağın `cancelled` olayı
   (uygulama task'ı 8) geldiğinde ayrı bir karar olarak yeniden açılır.
4. **Pasif/feshetmiş eski hesaplar ilk cutover'da aktarılmaz** (tablo 7'deki öneri).
5. **`DEAL_LOST`'a düşen kaydın `status`'u** — bu karardan bağımsız; ayrı issue olarak
   açıldı, burada karar verilmedi.
6. **Transfer zinciri tek yolculuk olarak birleşir** (task 9): `ENDED_REASSIGNED` +
   `previousRelationId` zincirinin halefi kohortlarda ikinci kazanım sayılmaz; churn
   zincirin ilk kazanımına bağlanır.
