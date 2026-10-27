# 2026-10-27 — Org'suz API anahtarı reddi kasıtlı (#2311)

- **Eski CI-kırmızı issue'larını kapatmadan önce spec'in bugünkü halini oku.** #2311'in iki
  spec'i (`integrations`, `api-explorer`) zaten admin'e `defaultOrgId()` atıyor; kalan tek
  soru "ürün davranışı kasıtlı mı" idi. Cevap `withApiKey()`'in yorumunda ve tenant
  kuralında duruyor: org'suz anahtar = kapsamsız sorgu, o yüzden `403 org_unbound`.
- **Karar issue'da değil dokümanda yaşasın.** `docs/public-api.md` § The door'a eklendi;
  bir sonraki ajan kırmızı bir spec'i bu kontrolü gevşeterek "düzeltmesin".
