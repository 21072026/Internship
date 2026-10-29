# 2026-10-29 — /signup ve ilk-koşu paneli (#1751)

- **Yeni bir `src/app/<dizin>` = yeni bir `<I18nScope>` layout'u** (#3224'ten beri). Unutursan
  `check:i18n-scopes` kırmızı olur; `scopes.generated.ts` gitignore'da, dal değiştirince
  `node scripts/i18n-scopes.mjs` (ya da `npm ci`) çalıştırmazsan `tsc` "Cannot find module
  './scopes.generated'" der.
- **`/admin` gösterge panelini koşula bağlamak e2e'yi sessizce etkileyebilir.** CI DB'si boş
  başlar, yani yeni bir "sıfır ilişki" dalı varsayılan org admin'ini görebilir. İlişki
  oluşturan spec'ler (`dashboard.spec.ts`) etkilenmedi, ama `/admin` içeriğine bakan her
  spec'i koş.
- **Bu container'da dev-sunucu e2e'leri yavaş:** `dashboard-links.spec.ts` temiz `main`'de
  de zaman aşımına uğruyor (`/admin/candidates` "Loading…"). Kendi değişikliğini suçlamadan
  önce aynı spec'i `origin/main`'de koş.
- **Sunucu bileşenine i18n alt-nesnesi (`t.firstRun`) prop olarak geçmek** istemci sözlüğünü
  etkilemez; yalnız `useT()` ile okunan namespace'ler scope taramasına girer.
