# 2026-10-23 — Support kanalı push gönderiyor (#3154)

- **"Hangi kategori?" sorusunun cevabı çoğu zaman katalogda yazılı.** Bir olayın /account
  anahtarı `src/lib/notifications/catalog.ts`'te `category` olarak duruyor; support olayları
  orada zaten `messages`. Yeni bir tercih kategorisi icat etmeden önce oraya bak; bir birim
  test (`support-push.test.mjs`) push'un kullandığı kategoriyi katalogla bağlıyor.
- **Push başlığı için yeni i18n anahtarı açma.** Zilin `notifications.events[type]` şablonu
  alıcının dilinde `renderNotification()` ile işleniyor; tepsi ile zil aynı cümleyi söylüyor ve
  MARKETING sızıntı sayacı yerinde kalıyor.
- **`scripts/test` altındaki birim testler `@/` takma adını çözemez.** `notificationText.ts`
  veya `notificationLink.ts` gibi `@/` import eden modüller düz `node --test` ile yüklenmiyor;
  test edilecek kural bağımlılıksız bir `*Rule.ts` dosyasına konmalı (burada
  `supportPushRule.ts`). Rotaların kablolaması `ai-never-autosend.test.mjs`'teki gibi kaynak
  metni okunarak sabitlenebilir.
- **İç içe worktree'de `npm run lint` iki `.eslintrc.json` görüp "plugin conflicted" ile
  düşer** (`.claude/worktrees/…` ana deponun içinde). Aynı denetim:
  `ESLINT_USE_FLAT_CONFIG=false npx eslint --no-eslintrc -c .eslintrc.json --ext .ts,.tsx src`.
- **macOS'ta `gitignore-exports.test.mjs` kırmızı olabilir.** `core.ignorecase=true` büyük
  harfli `accounts.CSV`'yi Linux'tan farklı eşliyor; CI'da geçer, bir regresyon değildir.
- Worktree'nin `node_modules`'ı `main`'in gerisinde kalınca `tsc` yeni paketlerde (`@visx/*`,
  `modern-screenshot`) düşer: `npm install --ignore-scripts` + `npx prisma generate` +
  `rm -rf .next/types`.
