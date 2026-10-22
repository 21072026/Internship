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
- **Yerel MariaDB 12'de bir `$transaction` içindeki yazma 1020 ile 500 dönebilir** ("Record
  has changed since last read"): 11.6'dan beri `innodb_snapshot_isolation=1` varsayılan, CI'daki
  MySQL 8'de bu yok. Support spec'leri buna takıldı. Koşu süresince
  `mysql -e "SET GLOBAL innodb_snapshot_isolation=0"`, ardından `=1` ile geri aç.
- **Paylaşılan yerel `internship_e2e` başka dalın şemasında kalabilir** (`db push`
  "Cannot drop index … needed in a foreign key constraint" der). Onu sıfırlama: soket üzerinden
  (`mysql -e …`, OS kullanıcısı yönetici) `internship_e2e_<issue>` aç, `e2e`'ye yetki ver,
  oraya `db push` yap. Ayrıca `db push … | tail` çıkış kodunu yutar; Playwright o zaman eski
  şemaya karşı koşar ve yanıltıcı biçimde düşer.
- Worktree'nin `node_modules`'ı `main`'in gerisinde kalınca `tsc` yeni paketlerde (`@visx/*`,
  `modern-screenshot`) düşer: `npm install --ignore-scripts` + `npx prisma generate` +
  `rm -rf .next/types`.
