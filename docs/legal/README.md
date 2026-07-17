# Ticarileşme ön-koşulları — kararlar ve taslaklar

> **Uyarı:** Bu klasördeki metinler hukuki tavsiye değildir; ürünü ticarileştirmeden
> önceki belirsizliği azaltmak için hazırlanmış **karar dokümanları ve taslaklardır**.
> İlk premium satıştan / ilk imzadan önce bir avukat ve mali müşavir tarafından
> gözden geçirilmelidir. Bağlam: ürün, Almanya merkezli **bcsit GmbH** üzerinden
> yürütülüyor (kurucu e-postası `@bcsit-gmbh.de`); kararlar bu yapıya göre verildi.

Story #523 (Epic #517) kapsamındaki kod-dışı ön koşullar. Her biri ayrı dosyada,
somut bir **karar** ve gerekçesiyle.

| Konu | Issue | Karar (özet) | Dosya |
|------|-------|--------------|-------|
| Katkı sözleşmesi (CLA) | #548 | Kısa yazılı IP-devri; tüm mevcut+gelecek katkıcı mentee'lere imzalatılır, onboarding'e eklenir | [cla-contributor-agreement.md](cla-contributor-agreement.md) |
| Hukuki/vergisel çerçeve | #549 | Mevcut **bcsit GmbH** üzerinden; SaaS abonelik faturalaması (KDV/USt dahil); klasik success-fee'den kaçın (AÜG riski) | [legal-tax-framework.md](legal-tax-framework.md) |
| Mentee görünürlük rızası | #551 | Yalnızca kamuya-açık alanlar (ad, üniversite, beceri, hedef pozisyon); e-posta/telefon asla; anında geri çekilebilir | [talent-pool-consent-policy.md](talent-pool-consent-policy.md) |
| Ödeme altyapısı | #552 | Faz 1 manuel fatura (GmbH); ölçeklenince Stripe Billing + webhook → entitlement | [payment-infrastructure.md](payment-infrastructure.md) |

## Veri erişim kuralı (#523 kalemi — zaten uygulandı)
Katkı veren mentee'ler gerçek/preview PII'ye erişmez; geliştirme sentetik seed ile
yapılır. Bkz. [../DATA_ACCESS_POLICY.md](../DATA_ACCESS_POLICY.md) — bu kalem koda
bağlanmış durumda (demo seeder yerel-olmayan `DATABASE_URL`'i reddediyor).
