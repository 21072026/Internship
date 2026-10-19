# Mevcut bir MARKETING tenant'ını güncel aşama setine getirmek (#2959)

Bir MARKETING org'u aşama setini (`MARKETING_FUNNEL`, `src/lib/programTemplates.ts`) **bir kez**,
kurulurken alır (`provisionStagePreset`). Preset sonradan değişince mevcut org'lar değişmez: #2840
öncesi kurulan bir tenant'ta hâlâ `DEAL_PROPOSAL` / `DEAL_NEGOTIATION` vardır, `TRIAL_ACTIVE` /
`TRIAL_EXPIRED` yoktur. Operatör bunu tek komutla düzeltir:

```bash
node prisma/apply-marketing-stage-preset.mjs --org <org slug veya id>            # dry run: önce/sonra farkı
node prisma/apply-marketing-stage-preset.mjs --org <org slug veya id> --apply    # yaz
```

Ne yapar (tek transaction):

- Presetteki her aşamayı `(orgId, key)` üzerinden **upsert** eder: etiket, sıra, terminal / off-path
  bayrakları ve renk presetteki gibi (İngilizce etiket saklanır; okuyanın dili okurken çözülür, #2268).
  Tenant'ın elle değiştirdiği bir etiket de presete döner — dry run bunu `~` satırı olarak gösterir.
- Presette olmayan bir anahtarı **yalnızca** hiçbir funnel kaydı (herhangi bir durumda) üzerinde
  durmuyorsa ve onu adlandıran bir `StageSla` satırı yoksa siler. Aksi halde **tüm çalıştırmayı
  reddeder**, hiçbir şey yazmaz ve hangi anahtarın neden engellediğini söyler
  (`templateApplyBlockers()` ile aynı iki ret: `stranded_relations`, `stale_slas`). Çözüm: kayıtları
  önce preset aşamasına taşı; SLA'yı aşama hâlâ varken `/admin/settings`'te temizle.
- Presetin SLA'larını `PUT /api/admin/stage-sla`'nın `templateSlaPayload()`'ı yazdığı gibi yazar: her
  preset aşaması presetteki gün sayısını alır ya da hiç almaz, mevcut `wipLimit` korunur, ikisi de boş
  kalan satır silinir.
- MARKETING olmayan org'u reddeder (exit 1). İdempotent: ikinci çalıştırma "nothing to do" der.

`replaceStages()` (editörün tek yazıcısı) burada kullanılmıyor: TypeScript, sunucudaki imajda `src/`
yok; ayrıca hepsini-sil-yeniden-yaz şekli canlı bir org'da kayıtları var olmayan bir anahtarda
bırakırdı. Script aynı satırları aynı normalizasyonla yazan minimal bir düz-ESM aynasıdır; preset,
SLA'lar ve ret kuralları `scripts/test/marketing-ops-clis.test.mjs`'de TS asıllarıyla karşılaştırılır
— preseti değiştiren commit aynayı da değiştirir. Uçtan uca: `e2e/marketing-ops-clis.spec.ts`.
