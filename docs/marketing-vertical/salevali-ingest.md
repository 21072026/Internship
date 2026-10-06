# SaleVali hesap olaylarının CRM'e alınması (#2450 / #2451 / #2452)

Sözleşme: [`salevali-provider-contract.md`](salevali-provider-contract.md) (#2565, taslak).
Bu dosya CRM tarafında **ne yapıldığını** ve hangi kararların alındığını yazar.

## Kapı

`POST /api/integrations/salevali/events` — **`/api/v1` dışında** (`/api/v1` donuk,
#2348 açık karar 3). Kimlik doğrulama `withApiKey(request, 'companies:write')`:
ilk **yazma** kapsamı. Tenant, anahtarın bağlı olduğu org'dur; istek host'u değil.
Anahtar başına hız sınırı `withApiKey`'in içinde. Ardından
`requireCapability(orgId, 'companies')`. Gövde, sözleşmenin olay zarfıdır
(`src/lib/salevaliIngestSchema.ts`, zod; bilinmeyen alanlar atılır,
`schema_version ≠ 1` reddedilir). `check:api-key-routes` bu rotayı
`KEY_ROUTES_OUTSIDE_V1` listesinde gerekçesiyle ister.

Pull (K-2) seçilirse aynı yazıcı (`ingestSaleValiEvent`, `src/lib/salevaliIngest.ts`)
bir zamanlanmış işten çağrılır; yalnızca çağıran değişir.

## Ne yapar

| Olay | Sonuç |
|---|---|
| `account_created`, `trial_started` — hesap **yok** | Varsayılan lead sahibinin (#2580) funnel'ında yeni hesap + stand-in lead + kayıt, **`TRIAL_ACTIVE`**'de — import'un create-only yazıcısıyla (`createMarketingAccount`, origin `ingest`). `externalId` yazılır, deneme tarihleri **SaleVali'ninkidir**, `Source` = `leadSourceName()` (affiliate > UTM > acquisition_source), iletişim izni yalnızca makine `NONE` satırı |
| aynı, hesap **var** (`externalId` ile, ya da ad/VAT ile eşleşip `externalId` boşluğu doldurulan) | Kayıt `TRIAL_ACTIVE`'e taşınır (`StatusChange`, `changedById = null`). Hesap alanları yalnızca **boşsa** doldurulur (`planFieldUpdates`, yetkili değil) |
| aynı, kayıt **kaybedilmiş / kapanmış** | Eski kayıt **yeniden açılmaz**: `COMPLETED` olur ve `previousRelationId` ile zincirli **yeni** bir journey açılır (aynı lead, aynı sahip) |
| `converted` | `DEAL_WON`'a taşınır. Hesap bilinmiyorsa `unknown_account`, yaratılmaz |
| diğer her tür | **Yalnızca kaydedilir** (`ActivityLog`), funnel'a dokunmaz — açık kararlar: K-5 (`upgrade_confirmed`), K-6 (`passivated` neden kodu), #2572 (DEAL_WON sonrası) |

## Bir kez, geri gitmeden

- **İdempotency (#2451):** her olay önce bir `IntegrationEvent` satırı olarak
  yazılır; `(orgId, provider, eventId)` tekil indeksi **claim**'dir (CompanyInquiry
  deseni). Aynı `event_id` ikinci kez `duplicate` döner, hiçbir şey yazmaz. 10
  dakikadan eski `processing` claim'i ölü bir çalıştırmanındır ve devralınır;
  hata fırlatan bir çalıştırma claim'ini bırakır (kaynak yeniden dener).
- **Yüksek su işareti:** aynı hesap için **uygulanmış** en yeni olaydan daha eski
  `occurred_at` taşıyan olay `stale` olur, durumu değiştirmez.
- **Geri taşımama:** her aşama yazımı `isBackwardMove()`'dan geçer
  (`src/lib/stageDirection.ts`, `stageChange.ts`'ten re-export, birim testli).
  Off-path'e (kayıp) çıkış her yerden serbesttir; off-path'ten yola dönmek her zaman
  geri sayılır (sıra numarası tek başına kayıp → kazanıldı'yı "ileri" sanırdı).
  Reddedilen hareket **loglanır** (`salevali.backward_refused`, warning).
  Kural **opt-in**'dir: yalnızca makine yazıcıları sorar; insan hareketi ve deneme
  uzatması etkilenmez.

## Kararlar (bu iş içinde verildi)

- **Yeni yaratılan kayıt için `StatusChange` yazılmaz.** Import'un kuralıyla aynı:
  bir kaydı o aşamada YARATMAK bir hareket değildir; `stageEnteredAt()` geçmiş
  yokken `startDate`'ten okur ve sahte bir `from→to` satırı her "aşama hareketi"
  sayısını şişirirdi. Var olan bir kaydın taşınması `StatusChange` yazar — #2452'nin
  "aynı olay iki kez → tek StatusChange" iddiası o yolda doğrulanır.
- **`trialEndsAt` = `trial_ends_at` (serbest dönemin sonu)** — sözleşmenin K-5
  önerisi. K-5 değişirse tek satır (`createAccount` / `moveRelation`).
- **Varsayılan sahip yoksa `409 no_default_owner`** ve claim bırakılır: hiçbir şey
  yazılmaz, olay org'a varsayılan lead sahibi atandıktan sonra yeniden gönderilebilir.
- SaleVali'nin önceden işaretli newsletter bayrağı (`newsletter`) şemada kabul edilir
  ve **yok sayılır** (#2577).

Kanıt: `e2e/salevali-ingest.spec.ts` (iki kritik iddia guard'sız kırmızı verir —
mutasyonla doğrulandı), `scripts/test/salevali-ingest-rule.test.mjs`,
`scripts/test/stage-direction.test.mjs`.
