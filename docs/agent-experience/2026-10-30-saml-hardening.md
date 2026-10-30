# 2026-10-30 — SAML protocol hardening (#1955)

- **node-saml `CacheProvider`'ı tek kullanımlık yapmak:** bir yanıtın doğrulanması sırasında
  `getAsync(id)` iki kez çağrılıyor (Response'un ve SubjectConfirmationData'nın
  InResponseTo'su), `removeAsync` sonra. Oku-sonra-sil yarışa açık; ilk `getAsync`'te
  koşullu `updateMany` ile harca, sağlayıcı örneği (istek başına) harcadığını hatırlasın.
- **Stub IdP'de redirect-binding imza doğrulaması:** imzalanan baytlar `SAMLRequest`,
  `RelayState`, `SigAlg` parametrelerinin **geldiği haliyle (ham, URL-encoded)** sıralı
  birleşimi; `URLSearchParams` ile decode edip yeniden kurmak imzayı bozar. SP sertifikası,
  ACS URL'sinden türetilen metadata URL'sinden alınıyor — gerçek IdP gibi.
- **`xml-encryption` (node-saml'ın bağımlılığı) stub'da doğrudan kullanılabiliyor;**
  aes256-gcm + rsa-oaep-mgf1p ile şifrelenen assertion'ı node-saml `decryptionPvk` ile açıyor.
- **Ret sebebini doğrula:** ACS ret sebebini `console.error`'a yazıyor; e2e sonrası
  `InResponseTo is not valid` / `is missing` satırları her negatifin kendi sebebiyle düştüğünü
  gösterdi.
