# Uygulamanın maddi değeri — değerleme çalışması

> **Durum: tartışma / karar-öncesi doküman.** Hukuki, mali veya yatırım tavsiyesi
> değildir. Gerçek bir satış görüşmesinden önce mali müşavir (Steuerberater) ve
> avukat gözden geçirmesi gerekir. Fiyat bantları burada **savunulabilir aralık**
> olarak verilir; tek bir "doğru sayı" yoktur.
>
> Kardeş doküman: [premium-model-calismasi.md](premium-model-calismasi.md) (gelir
> hatları), [legal/licensing-strategy.md](legal/licensing-strategy.md) (AGPL + ikili
> lisans), [legal/legal-tax-framework.md](legal/legal-tax-framework.md) (hak sahipliği
> ve faturalayan taraf).

## 0. Sorunun doğru hâli

"Birisi projeyi satın almak istese ne kadar eder?" sorusunun tek cevabı yok, çünkü
**neyin satıldığı** ve **kime satıldığı** cevabı 10 kat değiştirir:

| Ne satılıyor | Alıcı tipi | Değerin kaynağı |
|---|---|---|
| Kaynak kod + telif + marka (asset deal) | Finansal alıcı, marketplace | Yeniden yazma maliyetinden kaçınma |
| Yukarıdakiler + kurucunun geçiş dönemi desteği | Stratejik alıcı (bootcamp, üniversite, İK/staffing firması) | Pazara çıkış süresi + hazır uyum (GDPR) altyapısı |
| Yukarıdakiler + gelir | Herhangi bir alıcı | ARR çarpanı |
| Yukarıdakiler + mentor ağı ve operasyon | Stratejik alıcı | Kopyalanamaz varlık |

**Bugünkü gerçek:** gelir yok, canlı kullanım pilot ölçekte (aşağıya bakınız). Yani
bugün satılabilecek şey esasen **birinci satır**, kısmen ikinci satırdır.

## 1. Ölçülen gerçekler (2026-08-29)

Bu bölümdeki sayılar repo'dan ve **herkese açık** uçlardan ölçülmüştür; gerçek
kullanıcı verisine (prod/preview DB) bakılmamıştır — bu
[DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md) gereği yasaktır.

**Kod tabanı ölçeği**

| Ölçüt | Değer |
|---|---|
| Sürüm kontrolündeki dosya | 1.277 |
| Kod satırı (ts/tsx/js/mjs/css/prisma) | ~143.900 |
| `src/` toplam | ~101.200 satır / 724 dosya |
| API route handler (`route.ts`) | 215 |
| Sayfa (`page.tsx`) | 126 |
| React bileşeni | 156 |
| `src/lib` modülü | 183 |
| Prisma modeli / enum | 88 / 30 |
| Playwright e2e spec dosyası | 353 (~35.000 satır) |
| GitHub Actions workflow | 19 |
| Doküman (`docs/`) | 30 dosya / ~10.500 satır |
| i18n sözlüğü (EN/TR/DE) | ~10.500 satır |
| Yayımlanmış sürüm sayısı | `CHANGELOG.md` ~4.590 satır, 45 bekleyen fragment |

**Fonksiyonel kapsam:** 5 rol (ADMIN/MENTOR/MENTEE/COMPANY/SOURCE), 13 aşamalı
pipeline + denetim izi, mesajlaşma, toplantı/RSVP + Google Calendar entegrasyonu,
video görüşme (JaaS), hedefler, değerlendirmeler, projeler/görevler, kohortlar,
şirket ihtiyaçları + shortlist, davet/onboarding, duyuru + e-bülten, bildirim/push
(PWA), webhook + API key + OpenAPI (`/api/v1`), AI CV çıkarımı (rızaya bağlı),
SSO/SAML, beyaz etiket altyapısı (`orgBranding`), GDPR rıza/saklama otomasyonu,
entitlement/plan kapıları (`entitlements.ts`, `planGate.ts`, `orgPlans.ts`),
`Organization` modeli ve 57 yerde `orgId` (multi-tenancy **kısmen** hazır).

**İşletme durumu (canlı, herkese açık uçlar)**

- `crm.ersah.in/api/health` → `status: ok`, sürüm `0.128.0-beta`.
- `crm.ersah.in/api/public/stats` → **3 mentor, 4 açık proje, 0 bekleyen aday.**
- Bilinen gelir: **0 €** (ödeme altyapısı yok; Stripe vb. uygulanmadı).

> Bu üç sayı değerlemenin en belirleyici girdisidir: ürün teknik olarak olgun,
> **ticari olarak henüz doğrulanmamış**.

**Ölçülemeyenler (maintainer doldurmalı):** gerçek harcanan saat (buradaki klon
sığ/shallow, tam commit geçmişi okunamıyor), aylık işletme maliyeti (sunucu, alan
adı, SMTP, yedek), gerçek kullanıcı/ilişki sayıları, yapılan yerleştirme sayısı.

## 2. Yöntem A — Yeniden yazma maliyeti (cost approach)

Alıcının "bunu sıfırdan yaptırsam kaça mal olurdu?" sorusunun cevabı. Bu bir **tavan**
değil, bir **referans**tır: kimse yeniden yazma maliyetinin tamamını ödemez.

**Klasik COCOMO II (organic) 144 KLOC için ≈ 440 adam-ay** çıkarır. Bu sayı bu proje
için **kullanılamaz** — modern framework'ler (Next.js/Prisma kod üretimi), hazır UI
kütüphaneleri ve yoğun AI destekli geliştirme COCOMO'nun kalibre edildiği dünyayı
geçersiz kılıyor. Aşağıda aşağıdan-yukarı (bottom-up) tahmin kullanılmıştır.

| İş paketi | Adam-ay (kıdemli, AI'sız) |
|---|---|
| Veri modeli + şema (88 model, 30 enum) | 1,5 – 2,5 |
| 215 API route (yetki, doğrulama, hata yönetimi dahil) | 5 – 6 |
| 126 sayfa + 156 bileşen, responsive + dark mode | 6 – 8 |
| 353 e2e spec + 19 workflow + 4 ortam (prod/preview/topic/CI) | 3 – 4 |
| 3 dilli i18n | 1 – 1,5 |
| GDPR/rıza/saklama + güvenlik denetimi + 30 doküman | 2 – 3 |
| Entegrasyonlar (SMTP/bülten, Takvim, video, push/PWA, webhook/API v1, SSO) | 3 – 4 |
| **Toplam** | **~22 – 29 adam-ay** |

Bunu maliyete çevirmek (1 adam-ay ≈ 20 iş günü):

| Senaryo | Birim | Yeniden yazma maliyeti |
|---|---|---|
| Almanya ajans (800–1.100 €/gün) | 16–22 k€/adam-ay | **350 – 650 k€** |
| Almanya kıdemli freelancer (600–750 €/gün) | 12–15 k€/adam-ay | **260 – 440 k€** |
| Türkiye / nearshore ekip | 4–7 k€/adam-ay | **90 – 200 k€** |
| 2 kişilik, yoğun AI destekli ekip (%40–50 hızlanma → 11–17 adam-ay) | — | **TR 50–120 k€ / DE 150–280 k€** |

**Sonuç (yeniden yazma referansı): ~150 – 400 k€** (Almanya perspektifi), Türkiye
maliyet tabanıyla **~80 – 200 k€**. Dürüst uyarı: bir ekip *işlevsel çekirdeği*
(testler, dokümanlar ve uyum katmanı olmadan) bugün bunun çok altına, 50–100 k€'ya
çıkarabilir. Buradaki farkın adı **kalite ve devralınabilirlik**tir — ve bir alıcı
için gerçek ama iskontolu bir değerdir.

## 3. Yöntem B — Bugünkü piyasa değeri (market approach)

Gelir sıfır olduğu için ciro çarpanı uygulanamaz. Karşılaştırılabilir işlem tipleri:

- **Marketplace (Acquire.com vb.) verisi:** bootstrapped SaaS'lar tipik olarak
  **2,5–4× ARR** bandında el değiştiriyor; ilanların ortalaması ~203 k$ ciro üzerine
  ~484 k$ istek fiyatı. **Gelirsiz** listelemeler pratikte alıcı bulamıyor ya da
  sembolik rakamlara (5–40 k€) iniyor.
- **AGPL etkisi (bu projeye özgü ve önemli):** repo public ve `AGPL-3.0-or-later`.
  Yani alıcı "kodu ele geçirmek" için para vermez — kodu zaten yasal olarak
  fork'layabilir. Satılan şey **telif hakkı + yeniden lisanslama yetkisi** (ikili
  lisans satabilme), marka/alan adı, operasyon ve kurucunun sürekliliğidir. Bu,
  finansal alıcı için değeri **düşürür**, ticari lisans satmak isteyen stratejik alıcı
  için ise anlamlı kılar.
- **Veri devri otomatik değildir:** prod'daki kişisel veri GDPR nedeniyle satışla
  birlikte serbestçe devredilemez (hukuki dayanak, bilgilendirme, muhtemelen yeniden
  rıza gerekir). Yani "veri havuzu" bugün fiyatlanabilir bir varlık değil.

| Alıcı tipi | Bugün gerçekçi bant | Koşul |
|---|---|---|
| Finansal alıcı / marketplace | **15 – 50 k€** | Kurucu olmadan, sadece varlık |
| Stratejik alıcı (bootcamp, üniversite kariyer merkezi, İK/staffing, mentorluk yazılımı satıcısı) | **60 – 150 k€** | 3–12 aylık geçiş/danışmanlık kurucuyla |
| Acqui-hire (ürün + kurucu istihdamı) | **120 – 250 k€** | İş sözleşmesiyle birlikte |

**Tek cümlelik cevap:** bugün, bu hâliyle, nakit karşılığı savunulabilir bant
**≈ 50 – 150 k€**'dur ve bu ancak **stratejik bir alıcıyla** ve **kurucunun geçiş
desteğiyle** gerçekleşir. Yeniden yazma maliyeti (150–400 k€) fiyat değil, pazarlık
argümanıdır.

## 4. Yöntem C — Gelir senaryoları (income approach)

Değeri 6–7 haneye taşıyan tek şey **ARR**'dir. Piyasa fiyat çıpaları (2026):

| Ürün | Giriş fiyatı |
|---|---|
| Mentorloop | ~299 $/ay / 50 katılımcı (≈ 3,6 k$/yıl) |
| MentorcliQ | ~9.900 $/yıl (100 çalışan) |
| Chronus | ~14.995 $/yıl giriş; kurumsal 25–50 k$/yıl |

Bu çıpalarla [premium-model-calismasi.md](premium-model-calismasi.md)'deki üç gelir
hattını sayısallaştırırsak:

| Senaryo | Varsayım | ARR | Çarpan (3–5×) | Şirket değeri |
|---|---|---|---|---|
| **S1 — İlk doğrulama (12 ay)** | 6 program × 5 k€ + 8 şirket koltuğu × 250 €/ay | **54 k€** | 3–4× | **160 – 215 k€** |
| **S2 — Büyüme (24 ay)** | 20 program × 6 k€ + 25 koltuk × 300 €/ay | **210 k€** | 3,5–5× | **735 k€ – 1,05 M€** |
| **S3 — Satış olmazsa** | Gelir 0, bakım yükü sürer | 0 | — | Bant Bölüm 3'te kalır, zamanla **düşer** |

Kritik nokta: **0 → ilk ödeyen müşteri** geçişi, değerdeki en büyük tek sıçramadır
(yaklaşık 3 katı). Ondan sonrası çarpan matematiğidir.

## 5. Değeri artıran ve azaltan etkenler

**Artıranlar (bu projede fiilen mevcut — küçük projelerde nadir):**
- 353 e2e spec, 19 workflow, 4 ortam, drift kapıları → alıcının **due diligence**
  maliyetini ve devralma riskini düşürür.
- Temiz **IP zinciri**: tek hak sahibi (gerçek kişi), CLA/katkı şartları PR şablonunda
  onaylanıyor. Küçük projelerde satışı bozan bir numaralı sorun tam olarak budur.
- GDPR rıza/saklama otomasyonu, DPA/DR/güvenlik denetimi dokümanları → Enterprise
  satışının ön koşulları hazır.
- 3 dilli ürün, beyaz etiket ve entitlement altyapısının bir kısmı hazır.
- Ürünün kendisinin bir mentorluk programı tarafından inşa edilmiş olması —
  kopyalanması zor bir anlatı.

**Azaltanlar:**
- **Gelir yok, referans müşteri yok** (en büyük iskonto kalemi).
- Canlı kullanım pilot ölçekte (3 mentor) → ürün-pazar uyumu kanıtlanmamış.
- **Kilit kişi riski**: hak sahibi + ana geliştirici aynı kişi; katkıcılar rotasyonlu
  mentee'ler. Kurucu gitmezse değerin bir kısmı gider.
- AGPL/public repo → münhasırlık satılamaz (bkz. Bölüm 3).
- Multi-tenancy **yarım** (Organization + orgId var, tam kiracı izolasyonu değil).
- Ödeme/faturalama altyapısı yok.
- Altyapı tek bir Plesk sunucusuna ve self-hosted runner'a bağlı → alıcı taşıma
  maliyeti görür.
- Faturalayan taraf kararı ertelenmiş durumda (şahıs mı, GmbH mi) → asset deal
  yapısını ve vergiyi doğrudan etkiler.

## 6. Değeri en hızlı artıracak 6 hamle

Kabaca etki sırasına göre:

1. **İlk ödeyen müşteri** (tek bir şirket koltuğu veya tek bir program lisansı bile).
   Değerlemeyi "kod" sınıfından "işletme" sınıfına taşır. → Premium doküman Faz 1.
2. **Faturalama** (manuel fatura yeterli, Stripe sonra) — ARR ölçülebilir olmadan
   çarpan uygulanamaz.
3. **Faturalayan tarafı seç** ve GmbH seçilirse yazılı iç lisansı imzala
   (`legal-tax-framework.md`'deki üç ön koşul). İmzasız bir yapı satışı geciktirir.
4. **Multi-tenancy'yi tamamla** — B2B SaaS hattının (en büyük pazar) teknik ön koşulu.
5. **Anonimleştirilmiş sonuç metrikleri**: kaç mentee kaç günde `HIRED_660`'a ulaştı.
   `StatusChange` verisi zaten var; satış argümanına dönüştürülmesi gerekiyor.
6. **Marka/alan adı sahipliğini netleştir** (tescil dahil) — satılan varlık listesinin
   parçası.

## 7. Satılırsa devredilecek varlık listesi (kontrol listesi)

- Repo'nun telif hakkı + **yeniden lisanslama yetkisi** (ikili lisansın özü)
- Marka adı, `ersah.in` alt alan adları / ayrı bir alan adı, logo, tasarım varlıkları
- Docker imajları (ghcr.io), CI/CD yapılandırması, sunucu/runner erişimi
- Dokümantasyon seti (`docs/`) — devralma kılavuzu işlevi görüyor
- SMTP/gönderen alan adı itibarı, e-posta şablonları
- Müşteri/kurum ilişkileri (varsa), mentor ağı — **kişisel veri devri ayrı hukuki
  süreçtir**, otomatik değildir
- Kurucu geçiş desteği (süre ve kapsam sözleşmede yazılmalı — fiyatın önemli bir kısmı
  buna bağlanır)

## 8. Özet

| Soru | Cevap |
|---|---|
| Yeniden yazdırsak kaça mal olur? | **150 – 400 k€** (DE), 80 – 200 k€ (TR maliyet tabanı) |
| Bugün nakit karşılığı ne eder? | **50 – 150 k€**, stratejik alıcı + kurucu geçişiyle; finansal alıcıda 15 – 50 k€ |
| 54 k€ ARR'a ulaşırsa? | **160 – 215 k€** |
| 210 k€ ARR'a ulaşırsa? | **735 k€ – 1,05 M€** |
| Değeri belirleyen tek şey? | **İlk ödeyen müşteri.** Kod tarafı zaten hazır. |

Kaynaklar (piyasa çıpaları): [Chronus fiyatlandırması](https://mentorcruise.com/blog/chronus-pricing-breakdown-what-youll-actually-pay-in-2026-30161/),
[Mentorloop fiyatlandırması](https://www.g2.com/products/mentorloop-mentoring-software/pricing),
[mentorluk platformu fiyat karşılaştırması](https://www.mentorgain.com/blog/mentoring-platform-pricing-comparison),
[SaaS değerleme çarpanları 2026](https://bigideasdb.com/saas-valuation-guide-2026),
[micro-SaaS değerleme](https://livmo.com/blog/micro-saas-valuation/).
