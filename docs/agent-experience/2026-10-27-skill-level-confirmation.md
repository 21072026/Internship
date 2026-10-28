# 2026-10-27 — Mentor onayı ve yerel e2e (#1822)

- **Bu konteynerde e2e gerçekten koşulabiliyor** (`docs/security-audit-playbook.md` § 1):
  apt MariaDB + `.env` + `prisma db push` + `npm run dev`, sonra
  `set -a && . ./.env && set +a && BASE_URL=http://localhost:3000 npx playwright test <spec> --project=chromium`.
  `.env`'i shell'e yüklemeden spec helper'ları (`e2e/helpers/db.ts`) `DATABASE_URL` bulamaz.
- **Playwright tarayıcı sürümü uyuşmazsa** (`chromium_headless_shell-1248` aranıyor, 1243 kurulu):
  `ln -sfn /opt/pw-browsers/chromium_headless_shell-1243 /opt/pw-browsers/chromium_headless_shell-1248`
  bu sefer çalıştı — dizin yapısı aynıydı.
- İlk koşu soğuk derlemede (`next dev`) giriş 20 sn'yi aşabiliyor; ikinci koşu geçer. Hata değil.
- `/api/profile` **PUT**'tur, PATCH 405 döner.
- **Kanonik beceri satırları org ister:** `seedUser` org'suz hesap açar ve `syncUserSkills` org'suz
  kullanıcıda hiçbir şey yazmaz. Kanonik satırı test eden spec kendi org'unu açıp kullanıcıları
  ve ilişkiyi oraya taşımalı.
- MARKETING sızıntı sayacı 0'da kilitli: mentor kabuğu dışında görünen metinlerde "mentor/mentee"
  kelimesi kullanılmadı ("program içinde onaylandı"), böylece `LEAK_EXEMPT` gerekmedi.
