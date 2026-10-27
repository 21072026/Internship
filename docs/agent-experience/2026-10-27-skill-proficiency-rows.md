# 2026-10-27 — Beceri seviyesi kanonik satırda (#1822, 1. kısım)

- **`UserSkill.source` zaten vardı ve "satır nereden geldi" demek** (SELF|ADMIN|BACKFILL|CV|IMPORT).
  Issue "seviyenin kaynağı" için aynı adı istiyordu; anlamı ezmemek için ayrı `levelSource`
  kolonu açıldı. Bir issue'daki kolon adını şemaya körü körüne yazmadan önce mevcut kolonları oku.
- **`@updatedAt` dolu bir tabloya `db push` ile eklenemez** (zorunlu, DB default'u yok →
  `check:schema-push` reddeder). Yerine nullable `levelUpdatedAt DateTime?` kullanıldı.
- **Geçmiş tablosunda çift yazımı önlemek:** seviye değişimi `updateMany({ where: { id, level: from } })`
  ile korumalı; `count !== 1` ise geçmiş satırı yazılmaz. İki sekme aynı anda kaydederse tek satır.
- `npx prisma validate` bu konteynerde `DATABASE_URL` ister; sahte bir
  `mysql://u:p@localhost:3306/x` yeter.
- `scripts/test/schema-push-safety.test.mjs`'deki "#2249 commit" testi sığ klonda main'de de
  düşüyor (git o commit'e ulaşamıyor) — regresyon değil.
