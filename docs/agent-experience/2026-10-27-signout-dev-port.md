# 2026-10-27 — Çıkış sonrası yönlendirme portu koruyor (#3174)

- **Port, hostname eşleşmesinden sonra parçalardan yeniden kurulan URL'de düşüyordu.**
  `resolveRedirectTarget()` kabul ettiği URL'yi `protocol//hostname+path` olarak yeniden
  kuruyordu; aynı origin olmayan her served host'ta port kayboluyordu. Kural artık
  `servedHosts.ts`'te tek yerde (`keptPort()`): yalnızca **yapılandırılmış origin'in kendi
  portu** her served host'ta kalır. Prod/preview/topic'te `NEXTAUTH_URL` portsuz olduğu için
  davranış değişmez — birim testi bu iki şekli de sabitliyor.
- **`requestOrigin`, `resolveRedirectTarget`, `servedOrigin` aynı port kuralını paylaşmalı.**
  Yalnızca birini düzeltmek, lokalde sign-out'u onarıp SSO dönüşünü (RelayState) portsuz
  bırakırdı. Üçünü birlikte değiştir, `npm run test:served-hosts` ile doğrula.
- **Host-coherent e2e spec'i port'lu vakayı yalnızca port'lu bir base'de koşar** (`test.skip`
  deployed env'de); base'i `signOutUrl('/')`'den okumak, `BASE_URL` ile preview'a karşı da
  koşulabilir kalmasını sağlıyor.
