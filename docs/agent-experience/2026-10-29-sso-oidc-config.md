# 2026-10-29 — OIDC config kolonları (#1926)

- **Yeni bir kimlik bilgisi kolonu üç listeye girer:** `ORG_CREDENTIAL_FIELDS`
  (`src/lib/orgCredentials.ts` — echo edilen her Organization satırından silinir),
  `ORGANIZATION_DIFF_SPEC` (`src/lib/events/diff.ts` — `redact` = yalnız parmak izi) ve
  admin rotasının `setsIdpTrust` listesi (yalnız süper admin yazar, #1575). Biri eksikse
  sızıntı ya da yetki açığı sessizce oluşur.
- **Mühürlü bir değer "değişmedi" diye karşılaştırılamaz:** gelen her boş olmayan secret bir
  güven yazımıdır.
- **`src/lib/sso.ts` `@/` import ettiği için düz `node --test` ile yüklenemez;** saf
  fonksiyon testleri `e2e/*.unit.spec.ts` (browserless, `@smoke`) olarak yazılır ve
  `npx playwright test <dosya> --no-deps` ile saniyeler içinde koşar.
- **Main'i aldıktan sonra `tsc` "roi-calculator is not assignable…" derse** scope manifesti
  eskidir: `node scripts/i18n-scopes.mjs`.
