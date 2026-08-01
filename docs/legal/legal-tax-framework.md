# Hukuki / vergisel çerçeve kararı (#549)

> Hukuki/mali tavsiye değildir; mali müşavir (Steuerberater) ve avukat onayı gerekir.

## Önce netleştirilmesi gereken ayrım — IP ≠ faturalayan taraf

**Yazılımın hak sahibi Mehmet Erşahin'dir (gerçek kişi)**; fikri mülkiyet hiçbir
tüzel kişiye devredilmemiştir (bkz. `LICENSE`,
[cla-contributor-agreement.md](cla-contributor-agreement.md)). Bu doküman yalnızca
**gelirin hangi taraf üzerinden faturalandığını** ele alır — bu ayrı bir vergisel
karardır ve hak sahipliğini değiştirmez.

## Karar (teyit bekliyor)
Ticarileşmenin **mevcut bcsit GmbH** (Almanya) üzerinden yürütülmesi öneriliyor. Yeni
bir tüzel yapı kurulmaz — GmbH zaten var, sınırlı sorumluluk sağlıyor ve B2B SaaS
faturalaması için uygun.

> ⚠️ **Açık karar:** Faturalamanın GmbH üzerinden mi, hak sahibinin şahsı üzerinden mi
> yapılacağı maintainer tarafından teyit edilmeli. GmbH seçilirse, hak sahibinden
> GmbH'ye **yazılı bir kullanım/dağıtım lisansı** (ör. münhasır olmayan, alt-lisans
> verilebilir ticari dağıtım hakkı) gerekir — aksi halde GmbH, hakkı kendisinde olmayan
> bir yazılımı satmış olur. Şahıs üzerinden faturalanırsa bu iç lisansa gerek kalmaz,
> ancak sınırlı sorumluluk avantajı da kaybedilir; Enterprise müşteriler genelde tüzel
> kişiyle sözleşme yapmayı tercih eder.

### 1. Tüzel yapı
- **Yürütücü (varsayım):** bcsit GmbH (Almanya). Gelir, sözleşmeler ve faturalar GmbH
  üzerinden; yazılımın hakları hak sahibinde kalır, GmbH iç lisansla satar.
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
- [ ] **Faturalayan tarafı teyit et** (bcsit GmbH mi, hak sahibinin şahsı mı).
- [ ] GmbH seçilirse: hak sahibi → GmbH ticari dağıtım lisansını yazılı hale getir.
- [ ] Steuerberater ile KDV/reverse-charge faturalama akışını netleştir.
- [ ] Avukatla B2B SaaS sözleşme + DPA şablonları hazırlat.
- [ ] Success-fee kullanılacaksa AÜG/SGB III değerlendirmesi (ayrı, ertelenebilir).
