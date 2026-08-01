# Katkı Sözleşmesi (CLA) — hak sahipliği ve gelecek katkılar (#548)

> Hukuki tavsiye değildir; imzadan / ilk ticari lisans satışından önce avukat
> gözden geçirmesi gerekir.

## Karar

**Projenin tek hak sahibi Mehmet Erşahin'dir** (gerçek kişi). Ürünün fikri
mülkiyeti bir tüzel kişiye (bcsit GmbH dahil) devredilmemiştir; telif
`LICENSE` dosyasında da bu şekilde kayıtlıdır (`Copyright (C) 2026 Mehmet
Erşahin`). İkili lisanslama (AGPL-3.0-or-later + ayrıca ticari lisans) yetkisi
yalnızca hak sahibine aittir.

Katkı veren geliştiriciler, hak sahibinin **mentorluk verdiği mentee'lerdir**;
katkı, mentorluk ilişkisinin karşılığı olarak verilir (piyasa tecrübesi ↔ emek)
ve **bu uygulama üzerinde lisans/telif hakkı talebi doğurmaz**. Mentee'ler bu
çerçeveyi bilerek ve onaylayarak katkı veriyor.

### Geçmiş katkılar
Mevcut katkıcılarla bu çerçeve **sözlü olarak mutabık** kalınmıştır; katkıcılar
uygulama üzerinde hak talep etmeyeceklerini teyit etmiştir. Maintainer kararı:
geçmiş katkılar için geriye dönük imza toplanmayacak; bu doküman kaydın kendisi
sayılacaktır. (Bir yatırımcı ya da Enterprise müşteri due-diligence sırasında
yazılı teyit isterse, aşağıdaki taslak "hak talebinde bulunmuyorum" beyanı olarak
o an da imzalatılabilir.)

### Gelecek katkılar — uygulanacak model
Yeni katkılarda hak sahipliği **en baştan yazılı** hale gelir:

1. **PR'da onay** — her PR, şablondaki katkı şartları maddesi işaretlenerek
   açılır (`.github/PULL_REQUEST_TEMPLATE.md`). Şartların tanımı
   [CONTRIBUTING.md → Contributor terms (IP)](../../CONTRIBUTING.md#contributor-terms-ip).
2. **Onboarding'de bilgilendirme** — mentorluk başlangıcında katkı şartları
   anlatılır; mentee kabul ettiğini beyan eder.
3. **Mentorluk dışı katkıcı** (ücretli çalışan, harici geliştirici, ajans, kurumsal
   katkı) için aşağıdaki **yazılı sözleşme imzalatılır** — bu durumda zorunludur,
   PR onayı yeterli sayılmaz.

**Neden münhasır kullanım hakkı + geri-lisans:** Ürün tek elden ticarileştirileceği
ve müşteri/yatırımcı "haklar kimde?" diye soracağı için net sahiplik gerekir.
Katkıcıya, kendi katkısını portföyünde gösterebilmesi için geniş bir geri-lisans
verilir (adil ve motive edici; mentorluk modelinin özü).

## Sözleşme taslağı (TR)

**KATKI VE FİKRİ HAK SÖZLEŞMESİ**

1. **Taraflar.** Mehmet Erşahin ("Hak Sahibi") ve aşağıda imzası bulunan katkı
   veren ("Katkıcı").
2. **Kapsam.** Katkıcı'nın "Internship CRM" projesine sağladığı tüm kod, tasarım,
   doküman ve diğer eserler ("Katkılar").
3. **Hak devri / kullanım hakkı.** Katkıcı, Katkılar üzerindeki tüm dünya çapındaki
   mali hakları, mevzuatın izin verdiği azami ölçüde, süresiz ve bedelsiz olarak Hak
   Sahibi'ne devreder. Alman telif hukukunda telif hakkının kendisi devredilemediği
   için (§ 29 UrhG), Katkıcı Hak Sahibi'ne **münhasır, süresiz, dünya çapında,
   alt-lisans verilebilir kullanım hakkı** (ausschließliches Nutzungsrecht,
   § 31 Abs. 3 UrhG) tanır.
4. **İkili lisanslama yetkisi.** Katkıcı, Hak Sahibi'nin Katkıları hem
   AGPL-3.0-or-later altında hem de ayrı bir **ticari lisans** altında sunmasına
   açıkça onay verir.
5. **Hak talebinde bulunmama.** Katkıcı, Katkılar nedeniyle uygulama üzerinde
   telif, lisans, ücret, ortaklık veya pay talebinde bulunmayacağını kabul eder.
6. **Geri-lisans.** Hak Sahibi, Katkıcı'ya kendi Katkılarını kişisel portföy/eğitim
   amacıyla ticari olmayan biçimde sergileme hakkı tanır.
7. **Taahhütler.** Katkıcı, Katkıların özgün olduğunu ve üçüncü kişi haklarını ihlal
   etmediğini beyan eder.
8. **Ücret.** Katkılar mentorluk ilişkisi kapsamında karşılıksız verilmiştir; ek
   ücret doğurmaz.
9. **Uygulanacak hukuk.** Alman hukuku; yetkili mahkeme Hak Sahibi'nin yerleşim yeri.

İmza / Tarih / Ad-Soyad.

## Contribution & IP Agreement (EN, short form)

The Contributor grants Mehmet Erşahin ("Rights Holder") an exclusive, perpetual,
worldwide, sub-licensable right to use all contributions to the "Internship CRM"
project (assignment of economic rights where permitted; exclusive exploitation right
under German copyright law, § 31 (3) UrhG), and consents to those contributions being
offered both under AGPL-3.0-or-later **and** under a separate commercial licence. The
Contributor makes no copyright, licence, fee, or equity claim over the application,
and receives a non-exclusive grant-back for non-commercial portfolio use.
Contributions are made without additional remuneration within the mentorship.
Governed by German law.

## Uygulama içi kabul (planlandı)

Maintainer kararı: geliştiriciler zaten platforma kaydolduğu için onay **uygulama içine**
alınacak — kayıt/onboarding'de platform şartları, bir projeye eklenirken o projenin
şartları. Elektronik onay hukuken geçerlidir; ancak tek bir "gelecekteki tüm katkılarım"
onayı yerine kapsamı belirli, tekrarlanan bir onay zinciri kurulur (§ 40 UrhG).
Tasarım, şema ve uygulama dilimleri: **[contributor-terms-in-app.md](contributor-terms-in-app.md)**.

Kağıt/e-imza yalnızca **mentorluk dışı** katkıcılar (ücretli, harici, ajans, kurumsal) için
gerekli kalır.

## Aksiyon listesi
- [x] Hak sahibini tek isimde sabitle (Mehmet Erşahin) — `LICENSE`, `README.md`,
      `package.json` ve bu doküman.
- [x] Gelecek katkılar için PR şablonuna katkı şartları onayı ekle.
- [x] Uygulama içi kabul akışını tasarla — [contributor-terms-in-app.md](contributor-terms-in-app.md).
- [ ] Metni avukata onaylat (özellikle § 29 / § 31 / § 40 UrhG ifadeleri ve madde 5).
- [ ] Mentorluk dışı (ücretli/harici) bir katkıcı gelirse yazılı sözleşme imzalat.
- [ ] Uygulama içi kabul akışını kodla (3 dilim — tasarım dokümanındaki issue'lar).
