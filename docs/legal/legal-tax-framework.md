# Hukuki / vergisel çerçeve kararı (#549)

> Hukuki/mali tavsiye değildir; mali müşavir (Steuerberater) ve avukat onayı gerekir.

## Karar
Ticarileşme **mevcut bcsit GmbH** (Almanya) üzerinden yürütülür. Yeni bir tüzel yapı
kurulmaz — GmbH zaten var, sınırlı sorumluluk sağlıyor ve B2B SaaS faturalaması için
uygun.

### 1. Tüzel yapı
- **Yürütücü:** bcsit GmbH (Almanya). Gelir, sözleşmeler ve faturalar GmbH üzerinden.
- Gerekçe: hazır yapı, sınırlı sorumluluk, kurumsal müşterinin (Enterprise) sözleşme
  yapmak isteyeceği tüzel kişilik.

### 2. Vergi / faturalama
- **KDV (Umsatzsteuer):** GmbH KDV mükellefi; faturalarda %19 USt gösterilir.
  - AB içi B2B müşteride **reverse-charge** (alıcının VAT-ID'si ile), fatura üzerinde
    "Steuerschuldnerschaft des Leistungsempfängers" notu.
  - AB dışı müşteride yerel kurallara göre.
- **Fatura zorunlu alanları** (§ 14 UStG): GmbH adı/adresi, vergi no (USt-IdNr),
  fatura no, tarih, hizmet tanımı, net + KDV + brüt.
- Muhasebe Steuerberater ile; SaaS geliri düzenli (aylık/yıllık abonelik) tanınır.

### 3. Gelir modeli seçimi — **success-fee'den kaçın**
- **Karar:** Gelir **SaaS abonelik / yazılım lisans ücreti** olarak yapılandırılır
  (şirketler yetenek havuzu erişimi için; kurumlar programı yürütmek için öder).
- **Neden success-fee (yerleştirme başına komisyon) DEĞİL:** Almanya'da bir adayı
  bir işverene yerleştirip başarı ücreti almak **iş aracılığı (Arbeitsvermittlung)**
  sayılabilir; bu, Arbeitnehmerüberlassungsgesetz (AÜG) / SGB III kapsamında ek
  yükümlülük, kayıt ve — bazı kurgularda — lisans gerektirebilir. Erken aşamada bu
  karmaşıklık ve risk gereksiz.
- Success-fee ileride istenirse: ayrı hukuki değerlendirme + muhtemelen ayrı sözleşme
  yapısı gerekir; SaaS gelirinden bağımsız ele alınmalı.

### 4. Sözleşme şablonları (ihtiyaç listesi)
- **B2B SaaS Abonelik Sözleşmesi** (şirket/kurum müşteri): kapsam, ücret, süre, SLA
  (Enterprise), fesih.
- **DPA (Auftragsverarbeitungsvertrag, Art. 28 GDPR):** kurum müşteri kişisel veri
  işlettiği için zorunlu (özellikle multi-tenancy/Enterprise'da).
- **Kullanım Şartları + Gizlilik** (mevcut `/terms`, `/privacy` ile uyumlu).

## Aksiyon listesi
- [ ] Steuerberater ile KDV/reverse-charge faturalama akışını netleştir.
- [ ] Avukatla B2B SaaS sözleşme + DPA şablonları hazırlat.
- [ ] Success-fee kullanılacaksa AÜG/SGB III değerlendirmesi (ayrı, ertelenebilir).
