# Ticarileşme ön-koşulları — kararlar ve taslaklar

> **Uyarı:** Bu klasördeki metinler hukuki tavsiye değildir; ürünü ticarileştirmeden
> önceki belirsizliği azaltmak için hazırlanmış **karar dokümanları ve taslaklardır**.
> İlk premium satıştan / ilk imzadan önce bir avukat ve mali müşavir tarafından
> gözden geçirilmelidir.

**İki ayrı kavramı karıştırmayın:**

- **Hak sahipliği (IP):** Yazılımın tek hak sahibi **Mehmet Erşahin** (gerçek kişi) —
  bkz. `LICENSE` ve [cla-contributor-agreement.md](cla-contributor-agreement.md).
  Fikri mülkiyet hiçbir tüzel kişiye devredilmemiştir.
- **Ticari yürütme (fatura/sözleşme):** Gelirin hangi tüzel kişi üzerinden
  faturalandığı ayrı bir vergisel karardır; mevcut çalışma
  [legal-tax-framework.md](legal-tax-framework.md) içinde Almanya merkezli
  **bcsit GmbH**'yi varsayıyor (kurucu e-postası `@bcsit-gmbh.de`) ve **teyit
  bekliyor**. Satış GmbH üzerinden yapılacaksa hak sahibinden GmbH'ye bir iç lisans
  gerekir; şahıs üzerinden faturalanacaksa buna gerek yoktur.

Story #523 (Epic #517) kapsamındaki kod-dışı ön koşullar. Her biri ayrı dosyada,
somut bir **karar** ve gerekçesiyle.

| Konu | Issue | Karar (özet) | Dosya |
|------|-------|--------------|-------|
| Lisans stratejisi | — | AGPL-3.0-or-later + ikili lisanslama korunur; marka hakkı saklı; premium katman ileride ayrı kapalı modülde | [licensing-strategy.md](licensing-strategy.md) |
| Katkı sözleşmesi (CLA) | #548 | Tek hak sahibi **Mehmet Erşahin**; mentee katkıları hak talebi doğurmaz; gelecek katkılar PR şablonu + onboarding onayıyla yazılı hale gelir | [cla-contributor-agreement.md](cla-contributor-agreement.md) |
| Hukuki/vergisel çerçeve | #549 | Faturalama tüzel kişisi teyit bekliyor (varsayım: **bcsit GmbH**); SaaS abonelik faturalaması (KDV/USt dahil); klasik success-fee'den kaçın (AÜG riski) | [legal-tax-framework.md](legal-tax-framework.md) |
| Mentee görünürlük rızası | #551 | Yalnızca kamuya-açık alanlar (ad, üniversite, beceri, hedef pozisyon); e-posta/telefon asla; anında geri çekilebilir | [talent-pool-consent-policy.md](talent-pool-consent-policy.md) |
| Ödeme altyapısı | #552 | Faz 1 manuel fatura; ölçeklenince Stripe Billing + webhook → entitlement | [payment-infrastructure.md](payment-infrastructure.md) |

## Veri erişim kuralı (#523 kalemi — zaten uygulandı)
Katkı veren mentee'ler gerçek/preview PII'ye erişmez; geliştirme sentetik seed ile
yapılır. Bkz. [../DATA_ACCESS_POLICY.md](../DATA_ACCESS_POLICY.md) — bu kalem koda
bağlanmış durumda (demo seeder yerel-olmayan `DATABASE_URL`'i reddediyor).
