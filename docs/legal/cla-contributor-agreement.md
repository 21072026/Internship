# Katkı Sözleşmesi (CLA) — mevcut & gelecek mentee'ler (#548)

> Hukuki tavsiye değildir; imzadan önce avukat gözden geçirmesi gerekir.

## Karar
Mentee'ler mentorluk anlaşması gereği projeye emek/kod katkısı veriyor. Ticarileşme
anında bu katkıların fikri mülkiyetinin **bcsit GmbH**'ye ait olduğu **yazılı** olmalı;
sözlü anlaşma yeterli değildir ve geriye dönük toplanamaz.

**Uygulanacak model:** Kısa bir **fikri hak devri + katkı lisansı** sözleşmesi (CLA
benzeri). Tüm **mevcut** katkıcılara imzalatılır; **yeni** katılımcılar için
onboarding'in zorunlu adımı yapılır. İmza durumu basit bir kayıtla (aşağıda opsiyonel
şema önerisi) izlenir.

**Neden devir (assignment) + geri-lisans, yalnız lisans değil:** Ürün tek elden
ticarileştirileceği ve yatırımcı/Enterprise müşteri "IP kimde?" diye soracağı için
net sahiplik gerekir. Katkıcıya, kendi katkısını portföyünde kullanabilmesi için
geniş bir geri-lisans verilir (adil ve motive edici).

## Sözleşme taslağı (TR)

**KATKI VE FİKRİ HAK DEVRİ SÖZLEŞMESİ**

1. **Taraflar.** bcsit GmbH ("Şirket") ve aşağıda imzası bulunan katkı veren
   ("Katkıcı").
2. **Kapsam.** Katkıcı'nın "Internship CRM" projesine sağladığı tüm kod, tasarım,
   doküman ve diğer eserler ("Katkılar").
3. **Devir.** Katkıcı, Katkılar üzerindeki tüm dünya çapındaki fikri mülkiyet
   haklarını, mevzuatın izin verdiği azami ölçüde, süresiz ve bedelsiz olarak
   Şirket'e devreder. Almanya telif hukukunda eserin kendisi devredilemediğinden
   (§ 29 UrhG), Katkıcı Şirket'e **münhasır, süresiz, dünya çapında, alt-lisans
   verilebilir kullanım hakkı** (ausschließliches Nutzungsrecht) tanır.
4. **Geri-lisans.** Şirket, Katkıcı'ya kendi Katkılarını kişisel portföy/eğitim
   amacıyla ticari olmayan biçimde sergileme hakkı tanır.
5. **Taahhütler.** Katkıcı, Katkıların özgün olduğunu ve üçüncü kişi haklarını
   ihlal etmediğini beyan eder.
6. **Ücret.** Katkılar mentorluk ilişkisi kapsamında karşılıksız verilmiştir;
   ek ücret doğurmaz.
7. **Uygulanacak hukuk.** Alman hukuku; yetkili mahkeme Şirket'in merkezi.

İmza / Tarih / Ad-Soyad.

## Contribution & IP Assignment Agreement (EN, short form)
The Contributor grants bcsit GmbH an exclusive, perpetual, worldwide,
sub-licensable right to use all contributions to the "Internship CRM" project
(assignment where permitted; exclusive exploitation right under German © law,
§ 31 UrhG), with a non-exclusive grant-back to the Contributor for
non-commercial portfolio use. Contributions are made without additional
remuneration within the mentorship. Governed by German law.

## Opsiyonel: imza takibi (ileride, gerekirse)
Zorunlu değil (kağıt/DocuSign yeterli). İstenirse basit bir model:

```prisma
model ContributorAgreement {
  id        String   @id @default(cuid())
  userId    String   @unique
  version   String   // sözleşme metni sürümü
  signedAt  DateTime @default(now())
  ipHash    String?  // imza anındaki IP (kanıt)
}
```
Onboarding akışına "sözleşmeyi okudum ve kabul ediyorum" adımı eklenebilir.

## Aksiyon listesi
- [ ] Metni avukata onaylat (özellikle § 31/29 UrhG ifadeleri).
- [ ] Mevcut katkıcı mentee'lere imzalat (kağıt/e-imza).
- [ ] Onboarding'e imza adımı ekle (kod işi; ayrı issue açılabilir).
