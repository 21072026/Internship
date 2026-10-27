# 2026-10-27 — Self-serve org signup API (#1749)

- **Eski issue'nun "dosya:satır" referansları kaymış olur; önce bugünkü helper'a bak.**
  #1749 `provisionOrganization()`'ın "yoksa yarat" diyordu; #2065 onu çoktan getirmişti
  ama kendi `$transaction`'ını açıyor ve ilk admin'i **davet** olarak yaratıyordu. Çözüm
  ikinci bir transaction değil, helper'a transaction-içi bir kanca (`firstAdminAccount`)
  eklemek oldu; yetkisiz (actor'suz) çağrı için `actor` opsiyonel oldu.
- **"Zorla başarısızlık" testi için yeni test anahtarı icat etme:** `E2E_ERROR_ROUTES`
  zaten e2e sunucusunda açık; bir istek başlığıyla (`x-e2e-fail-signup`) birlikte
  okunuyor, deploy'da set edilmediği için prod'da etkisiz.
- **`.env.example`'a yeni değişken = `docs/secrets-and-rotation.md` envanteri.**
  `secrets-inventory.test.mjs` aksi halde `test:unit`'i kırar.
- **Lokal e2e:** apt MariaDB 10.11 + `.env` (gitignore'da) + `db push` + `db seed`
  yeterli. Playwright 1248 headless shell'i bekleyip 1243 bulursa:
  `mkdir -p /opt/pw-browsers/chromium_headless_shell-1248 && ln -sfn …-1243/chrome-headless-shell-linux64 …-1248/`.
  İlk dev-sunucu koşusunda `waitForURL` 20 s zaman aşımları soğuk derlemedir; spec'i
  tek başına tekrar koş, ayırt et.
