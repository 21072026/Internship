# 2026-10-29 — MatchDecision denetim kaydı (#1789)

- **"Sunucu hesaplar" alanları için zaten tutulan bir kayıt var mı diye bak.** "Öneriyi ezdi mi?"
  için yeni bir öneri-seti tablosu gerekmedi: `MatchFeedback` her önerilen listeyi `batchId` +
  `rank` ile zaten SHOWN satırları olarak yazıyor. İstemci yalnızca batch id'yi geri yolluyor,
  karar sunucunun okuduğu satırlardan çıkıyor.
- **Karar kaydı ilişki oluşturulduktan SONRA yazılıyor**; bu yüzden puanlama girdilerinde yeni
  ilişki bir kez fazla sayılıyor: mentorun aktif yükünden 1 düş, mentee'nin geçmiş eşleşmelerinden
  bu mentorun bir geçişini çıkar — yoksa `capacityHeadroom` / `previousPairing` kaydedilen çifti
  engellenmiş gösterir.
- `scripts/check-i18n.ts` MARKETING sızıntı sayacı: yalnız internship'te görünen bir namespace için
  `LEAK_EXEMPT`'e, okuyucusunun hangi kapı tarafından kapatıldığını yazan bir gerekçeyle ekle.
- Ayrı oturumlar arası `src/i18n/scopes.generated.ts` eskiyebilir (yeni bir `src/app` dizini main'e
  gelince tsc "scope" tipinde düşer): `npm run i18n:scopes`.
