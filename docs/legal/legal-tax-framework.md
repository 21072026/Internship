# Hukuki / vergisel çerçeve kararı (#549)

> Hukuki/mali tavsiye değildir; mali müşavir (Steuerberater) ve avukat onayı gerekir.

## Önce netleştirilmesi gereken ayrım — IP ≠ faturalayan taraf

**Yazılımın hak sahibi Mehmet Erşahin'dir (gerçek kişi)**; fikri mülkiyet hiçbir
tüzel kişiye devredilmemiştir (bkz. `LICENSE`,
[cla-contributor-agreement.md](cla-contributor-agreement.md)). Bu doküman yalnızca
**gelirin hangi taraf üzerinden faturalandığını** ele alır — bu ayrı bir vergisel
karardır ve hak sahipliğini değiştirmez.

## Karar: faturalayan taraf **ilk satışa kadar ertelendi** (maintainer, 2026-08-01)

Faturalamanın bcsit GmbH üzerinden mi, hak sahibinin şahsı üzerinden mi yapılacağı
**şimdi karara bağlanmıyor**; ilk gerçek satış/talep geldiğinde karara bağlanacak. Bu
bilinçli bir erteleme ve güvenlidir, çünkü:

- Hak sahipliği **zaten net** (Mehmet Erşahin) — erteleyen karar yalnızca faturayı kimin
  kestiği; bu, yazılımın hakları üzerinde hiçbir etki doğurmaz.
- Karar, ilk müşterinin kim olduğuna göre değişebilir (kurumsal alıcı tüzel kişi ister,
  küçük müşteri şahıs faturasını sorun etmez) — şimdi verilecek karar erken olur.
- Geriye dönük düzeltilemeyen tek şey **fatura kesildikten sonrası**dır; imzadan önce
  seçmek yeterli.

> ⚠️ **İlk satıştan/imzadan önce yapılması gerekenler** (ertelemenin şartı):
> 1. Faturalayan tarafı seç.
> 2. **GmbH seçilirse**, hak sahibinden GmbH'ye **yazılı bir ticari dağıtım lisansı**
>    (münhasır olmayan, alt-lisans verilebilir) imzalanmalı — aksi halde GmbH, hakkı
>    kendisinde olmayan bir yazılımı satmış olur. Tek sayfalık bir metin yeterli, ama
>    **fatura tarihinden önce** tarihli olmalı.
> 3. Şahıs seçilirse iç lisansa gerek yok; ancak sınırlı sorumluluk avantajı olmaz ve
>    Enterprise alıcılar genelde tüzel kişiyle sözleşme yapmak ister.
>
> Bunlar yapılmadan sözleşme imzalanmamalı/fatura kesilmemeli.

### 1. Tüzel yapı
- **Aday (henüz seçilmedi):** bcsit GmbH (Almanya) — gelir, sözleşmeler ve faturalar GmbH
  üzerinden; yazılımın hakları hak sahibinde kalır, GmbH iç lisansla satar.
- Gerekçe: hazır yapı, sınırlı sorumluluk, kurumsal müşterinin (Enterprise) sözleşme
  yapmak isteyeceği tüzel kişilik.
- **Alternatif:** hak sahibinin şahsı üzerinden faturalama (iç lisans gerekmez, kurulum
  maliyeti sıfır; sınırlı sorumluluk yok).

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
- [x] Kararı ilk satışa ertele (yukarıdaki şartlarla) — 2026-08-01.
- [ ] **İlk talep geldiğinde:** faturalayan tarafı seç (bcsit GmbH mi, şahıs mı).
- [ ] GmbH seçilirse: hak sahibi → GmbH ticari dağıtım lisansını **fatura öncesi** imzala.
- [ ] Steuerberater ile KDV/reverse-charge faturalama akışını netleştir.
- [ ] Avukatla B2B SaaS sözleşme + DPA şablonları hazırlat.
- [ ] Success-fee kullanılacaksa AÜG/SGB III değerlendirmesi (ayrı, ertelenebilir).
