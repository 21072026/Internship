# 2026-10-27 — Eski beceri seviyelerinin backfill'i (#1822)

- **"Insert-only" bir backfill'i satır düzeyinde tanımla:** satır yalnızca `level` boşsa VE
  hiç `UserSkillLevelChange` geçmişi yoksa doldurulur. Geçmiş şartı, sonradan bilinçli olarak
  *silinmiş* bir puanın her deploy'da JSON'dan geri gelmesini engelliyor — yalnızca `level: null`
  kontrolü bunu yapamaz.
- Yeni bir deploy backfill'i `prisma/backfills/registry.mjs`'e bir satırdır; sıra bağımlılığı
  `scripts/test/backfill-registry.test.mjs`'te bir `indexOf` iddiasıyla sabitlenir.
- Sunucu Node 20 ile TS import edemez: kural düz ESM'de (`prisma/skill-taxonomy-lib.mjs`),
  testi mevcut mirror test dosyasına eklendi (orada `lib` namespace import'u zaten var).
