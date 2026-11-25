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
  Transaction içindeki düz okuma kilit almaz (InnoDB, REPEATABLE READ); bu yüzden silmeden hemen önce
  emekliye ayrılan anahtarlardaki kayıtlar `SELECT … FOR UPDATE` ile **kilitli** yeniden okunur. Plan
  okunduktan sonra o anahtarlardan birine taşınmış bir kayıt bulunursa çalıştırma reddedilir ve hiçbir
  şey yazılmaz (exit 1, "Run it again").
- Presetin SLA'larını `PUT /api/admin/stage-sla`'nın `templateSlaPayload()`'ı yazdığı gibi yazar: her
  preset aşaması presetteki gün sayısını alır ya da hiç almaz, mevcut `wipLimit` korunur, ikisi de boş
  kalan satır silinir.
- MARKETING olmayan org'u reddeder (exit 1). İdempotent: ikinci çalıştırma "nothing to do" der.

`replaceStages()` (editörün tek yazıcısı) burada kullanılmıyor: TypeScript, sunucudaki imajda `src/`
yok; ayrıca hepsini-sil-yeniden-yaz şekli canlı bir org'da kayıtları var olmayan bir anahtarda
bırakırdı. Script aynı satırları aynı normalizasyonla yazan minimal bir düz-ESM aynasıdır; preset,
SLA'lar ve ret kuralları `scripts/test/marketing-ops-clis.test.mjs`'de TS asıllarıyla karşılaştırılır
— preseti değiştiren commit aynayı da değiştirir. Uçtan uca: `e2e/marketing-ops-clis.spec.ts`.

## Renaming a preset label (#3907)

`LEAD_QUALIFIED` reads **"Bedarf geklärt"** in German since #3907 — "Qualifiziert"
read as a person's qualification, while the stage means *the customer's need is
clear*. English ("Qualified") and Turkish ("Nitelendirildi") are unchanged.

No org needed a data change, and none got one. A stored stage label that is
blank or one of OUR labels for its key in any locale is "untouched" and reads
back in the viewer's language (#2268, `curatedStageLabel()`); the preset is
provisioned in English, so those orgs show the new German label at once. A row
that still stores the **old** German default is covered by
`FORMER_STAGE_LABELS` (`src/lib/programTemplates.ts`): "Qualifiziert" on
`LEAD_QUALIFIED` still counts as ours (`isOurStageLabel()`), so it too reads
"Bedarf geklärt" in German and "Qualified" in English. A label the tenant typed
is never one of ours, so it is shown verbatim, untouched.

That is the recipe for the next rename: change the label in the preset and
append the old one to `FORMER_STAGE_LABELS` under its key — never remove an
entry, or every org still storing that word freezes on it. No backfill script.
