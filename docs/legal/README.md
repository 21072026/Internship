# Ticarileşme ön-koşulları — kararlar ve taslaklar

> **Uyarı:** Bu klasördeki metinler hukuki tavsiye değildir; ürünü ticarileştirmeden
> önceki belirsizliği azaltmak için hazırlanmış **karar dokümanları ve taslaklardır**.
> İlk premium satıştan / ilk imzadan önce bir avukat ve mali müşavir tarafından
> gözden geçirilmelidir.

**İki ayrı kavramı karıştırmayın:**

- **Hak sahipliği (IP):** Yazılımın tek hak sahibi **Mehmet Erşahin** (gerçek kişi) —
  bkz. `LICENSE` ve [cla-contributor-agreement.md](cla-contributor-agreement.md).
  Fikri mülkiyet hiçbir tüzel kişiye devredilmemiştir.
- **Ticari yürütme (fatura/sözleşme):** Gelirin hangi taraf üzerinden faturalandığı ayrı
  bir vergisel karardır ve **ilk satışa kadar bilinçli olarak ertelendi**
  ([legal-tax-framework.md](legal-tax-framework.md)). Adaylar: Almanya merkezli
  **bcsit GmbH** veya hak sahibinin şahsı. GmbH seçilirse, fatura kesilmeden önce hak
  sahibinden GmbH'ye yazılı bir ticari dağıtım lisansı gerekir.

Story #523 (Epic #517) kapsamındaki kod-dışı ön koşullar. Her biri ayrı dosyada,
somut bir **karar** ve gerekçesiyle.

| Konu | Issue | Karar (özet) | Dosya |
|------|-------|--------------|-------|
| Lisans stratejisi | — | AGPL-3.0-or-later + ikili lisanslama korunur; marka hakkı saklı; premium katman ileride ayrı kapalı modülde | [licensing-strategy.md](licensing-strategy.md) |
| Katkı sözleşmesi (CLA) | #548 | Tek hak sahibi **Mehmet Erşahin**; mentee katkıları hak talebi doğurmaz; gelecek katkılar PR şablonu + onboarding onayıyla yazılı hale gelir | [cla-contributor-agreement.md](cla-contributor-agreement.md) |
| Katkı şartları — uygulama içi onay | — | Elektronik onay geçerli; tek blanket onay değil **üç katmanlı** (platform + proje + PR) kurgu; şartlar veri olarak modellenir | [contributor-terms-in-app.md](contributor-terms-in-app.md) |
| Ticari lisans sözleşmesi | — | Kullanıma hazır taslak + Annex A iskeleti; yıllık abonelik ya da süresiz lisans + %20 bakım | [commercial-license-template.md](commercial-license-template.md) |
| Hukuki/vergisel çerçeve | #549 | Faturalayan taraf **ilk satışa ertelendi** (aday: **bcsit GmbH** veya şahıs); SaaS abonelik faturalaması (KDV/USt dahil); klasik success-fee'den kaçın (AÜG riski) | [legal-tax-framework.md](legal-tax-framework.md) |
| Mentee görünürlük rızası | #551 | Yalnızca kamuya-açık alanlar (ad, üniversite, beceri, hedef pozisyon); e-posta/telefon asla; anında geri çekilebilir | [talent-pool-consent-policy.md](talent-pool-consent-policy.md) |
| Fırsat eşitliği verisi | #819 | Demografik veri **toplanmıyor**; ürün sahibi açık onayı gelmeden şema değişikliği yok. Kör inceleme modu ayrı ve gönderildi | [equal-opportunity-data.md](equal-opportunity-data.md) |
| Ödeme altyapısı | #552 | Faz 1 manuel fatura; ölçeklenince Stripe Billing + webhook → entitlement | [payment-infrastructure.md](payment-infrastructure.md) |
| Üçüncü taraf lisans envanteri | #2059 | **Üretilen dosya** — her PR'da `npm run check:licenses` ile doğrulanıyor; AGPL dağıtımını *veya* ticari hakkı imkânsız kılan bir lisans CI'ı kırıyor | [third-party-licenses.md](third-party-licenses.md) |

## Üçüncü taraf lisansları (#2059)

[third-party-licenses.md](third-party-licenses.md) **elle düzenlenmez** —
`npm run check:licenses -- --write` üretiyor. Neden ayrı bir kapı: bir bağımlılık
iki ayrı sınavı geçmek zorunda ve bunlar aynı soru değil.

1. AGPL-3.0-or-later altında dağıtabilir miyiz?
2. Hak sahibi bunun üzerine **AGPL olmayan** bir ticari lisans da verebilir mi?

GPL-3.0 / AGPL-3.0 bir bağımlılık birinciyi rahatça geçer, ikinciyi öldürür:
başkasının copyleft kodunu kapalı şartlarla alt-lisanslayamayız. Lisansı hiç
belirtilmemiş bir paket ikisini de öldürür — sessizlik izin değildir. Politika
tablosu ve elle çözülmüş paketlerin gerekçeleri `scripts/license-policy.mjs`
içinde; sınıflandırılmamış bir SPDX kimliği **bilinmiyor** sayılıp build'i
kırıyor, "muhtemelen sorun yoktur" saymıyor.

Güvenlik tarafındaki eşi: [`docs/trust/vulnerability-management.md`](../trust/vulnerability-management.md).

## Veri erişim kuralı (#523 kalemi — zaten uygulandı)
Katkı veren mentee'ler gerçek/preview PII'ye erişmez; geliştirme sentetik seed ile
yapılır. Bkz. [../DATA_ACCESS_POLICY.md](../DATA_ACCESS_POLICY.md) — bu kalem koda
bağlanmış durumda (demo seeder yerel-olmayan `DATABASE_URL`'i reddediyor).
