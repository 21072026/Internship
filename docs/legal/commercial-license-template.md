# Ticari lisans sözleşmesi — taslak

> **Hukuki tavsiye değildir.** Bu, ilk talep geldiğinde sıfırdan yazmak zorunda kalmamak
> için hazırlanmış **çalışma taslağıdır**. İlk imzadan önce Alman hukukuna aşina bir
> avukat tarafından gözden geçirilmelidir — özellikle sorumluluk sınırlaması (§ 305 vd.,
> § 309 BGB: genel işlem koşullarında ağır kusur için sorumluluk sınırlanamaz), garanti
> ve kabul (Abnahme) maddeleri.

## Ne zaman kullanılır

AGPL-3.0-or-later herkese yeterlidir; ticari lisans **yalnızca** AGPL yükümlülüklerini
kabul edemeyen taraf için gerekir:

| Durum | Gereken |
|---|---|
| Kendi sunucusunda kurup kullanmak, değişiklikleri yayınlamak | AGPL — lisans satışı **yok** |
| Hosted sürümü (crm.ersah.in) kullanmak | Abonelik sözleşmesi (SaaS) — bu doküman değil |
| Yazılımı **kapalı kaynak** bir ürüne gömmek / OEM olarak dağıtmak | **Ticari lisans** |
| Değiştirilmiş sürümü müşterilerine servis olarak sunup kaynağı **açmak istememek** | **Ticari lisans** |

Fiyat, AGPL'den kaçınmanın alıcıya sağladığı değere göre belirlenir (maliyet artı değil).
Pratik iskelet: **yıllık abonelik** (kapsam metriğine bağlı) veya **süresiz lisans + %20
yıllık bakım**. İlk müşterilerde yıllık abonelik daha güvenli — hem gelir öngörülebilir
hem yazılım gelişmeye devam ediyor.

---

## TASLAK — Commercial Software Licence Agreement

**Parties**

**Licensor:** Mehmet Erşahin, [address], Germany — sole rights holder of the Software.
**Licensee:** [company, legal form, address, register no., VAT-ID].

**1. Definitions**

1.1 **"Software"** — the "Internship CRM" application authored by the Licensor, in source
and object form, including its documentation.
1.2 **"Licensed Version"** — the release(s) delivered under this Agreement, as identified
in Annex A (version / commit).
1.3 **"Public Version"** — the Software as published under AGPL-3.0-or-later at
https://github.com/21072026/internship.
1.4 **"Modifications"** — changes the Licensee makes to the Software.
1.5 **"Permitted Scope"** — the use case, metric and volume set out in Annex A.

**2. Grant of licence**

2.1 The Licensor grants the Licensee a **non-exclusive, non-transferable, worldwide** right,
for the Term, to use, reproduce, modify and internally distribute the Licensed Version
within the Permitted Scope.
2.2 **Relief from AGPL obligations.** The Licensed Version is provided under this Agreement
**instead of** AGPL-3.0-or-later. Within the Permitted Scope the Licensee is therefore not
subject to the AGPL's copyleft or source-disclosure obligations (including AGPL § 13,
network use), and may combine the Software with proprietary code.
2.3 Depending on Annex A, the grant includes the right to (a) operate the Software as a
service for the Licensee's own end users, and/or (b) distribute it in object form as an
integrated component of the Licensee's own product (OEM). Sub-licensing is limited to what
is technically necessary for (a)/(b); end users receive no rights beyond use of the
Licensee's product.
2.4 Affiliates: [included / excluded — if included, define "Affiliate" and make the Licensee
liable for their compliance].
2.5 The Public Version remains available to the Licensee under AGPL; this Agreement does not
restrict rights the Licensee has under the AGPL.

**3. Restrictions**

The Licensee shall not: (a) exceed the Permitted Scope; (b) resell, rent or transfer this
licence as such; (c) remove or alter copyright, licence or attribution notices in the source;
(d) use the Licensor's trademarks, the name "Internship CRM", its logo or the domain
`crm.ersah.in` (see § 9); (e) publish the Licensed Version's source code publicly (this would
defeat the purpose of the commercial licence, and § 2.2 relief does not extend to it).

**4. Delivery, updates**

4.1 Delivery is electronic: access to the source repository and/or container images, within
[N] business days of the first payment.
4.2 During the Term the Licensee receives all maintenance and feature releases the Licensor
publishes for the Software. Custom development is not included and is agreed separately.
4.3 Installation, migration and configuration are not included unless stated in Annex B.

**5. Support**

No support is owed unless Annex B (support / SLA) is agreed. Absent Annex B, the Licensor
answers questions on a best-effort basis and the security-reporting process in `SECURITY.md`
applies.

**6. Fees, term, termination**

6.1 Fees, metric and billing cycle: **Annex A**. Prices are net; VAT / reverse charge is
added as applicable. Payment within [14] days of invoice.
6.2 Term: [12] months from the Effective Date, renewing automatically for further [12] month
periods unless terminated in writing [3] months before the end of a period.
6.3 Either party may terminate for cause. The Licensor may terminate on the Licensee's
material breach (in particular §§ 3, 6.1) or payment default after written notice and a
[14] day cure period.
6.4 **Effect of termination.** *Subscription model:* the rights under § 2 end; the Licensee
must stop using the Licensed Version outside the AGPL (it may continue under AGPL, with the
AGPL's obligations). *Perpetual model (if agreed in Annex A):* the § 2 rights for the
delivered Licensed Version survive; only updates and support end.

**7. Warranty**

7.1 The Licensor warrants that it holds the rights necessary to grant this licence.
7.2 The Software contains third-party open-source components; their licences apply to those
components. A current list is available on request (`package.json` / lock file).
7.3 The Licensor warrants that the Licensed Version substantially conforms to its
documentation at delivery. Beyond that the Software is provided **without further warranty**
as to fitness for a particular purpose. Claims for defects lapse [12] months after delivery.
7.4 The warranty does not cover defects caused by the Licensee's Modifications, its
environment, or unsupported third-party components.

**8. Liability**

8.1 The Licensor is liable without limitation for intent, gross negligence, injury to life,
body or health, and under mandatory statutory liability.
8.2 For simple negligence the Licensor is liable only for breach of a material contractual
obligation, limited to foreseeable, typical damage, and in total capped at the fees paid in
the **12 months** preceding the event.
8.3 Liability for lost profits, loss of data (beyond the cost of restoring properly kept
backups) and indirect damage is excluded within the limits of § 8.1.
8.4 The Licensee is responsible for backups and for the lawfulness of the data it processes.

**9. Intellectual property, trademarks**

9.1 All rights in the Software remain with the Licensor. This Agreement grants a licence, not
a transfer of rights.
9.2 The Licensee owns its own Modifications but acquires no rights in the Software itself.
Modifications may not be published in a way that discloses the Licensed Version's source
(§ 3(e)).
9.3 Trademarks and the name/logo/domain are **not** licensed. Factual reference ("built on
Internship CRM") is permitted; implying endorsement or partnership is not.
9.4 Optional contribution-back: if the Licensee offers Modifications to the Licensor, the
contributor terms in `CONTRIBUTING.md` apply. This is voluntary.

**10. Confidentiality**

Each party keeps the other's non-public information confidential for the Term and [3] years
thereafter. The existence of this Agreement is not confidential; naming the Licensee as a
reference requires its prior written consent.

**11. Data protection**

If the Licensor processes personal data on the Licensee's behalf (e.g. hosting, support
access to production data), the parties conclude a **data processing agreement**
(Art. 28 GDPR / AVV) as **Annex C** before such processing begins. Where the Licensee
self-hosts and the Licensor has no access, no DPA is required.

**12. Final provisions**

12.1 Written form (including qualified electronic signature) is required for amendments.
12.2 Assignment requires the other party's consent; the Licensor may assign to a legal entity
it controls, having notified the Licensee.
12.3 Severability: an invalid provision is replaced by what the parties would have reasonably
agreed.
12.4 **Governing law: German law**, excluding the CISG. Venue: the Licensor's domicile, as far
as legally permissible.

**Annexes** — A: Permitted Scope, metric, fees, model (subscription / perpetual) ·
B: Support & SLA (optional) · C: DPA (if applicable).

Place, date — Licensor / Licensee signatures.

---

## Annex A iskeleti (doldurulacak alanlar)

| Alan | Örnek / seçenek |
|---|---|
| Kullanım tipi | Dahili kullanım · kendi müşterilerine SaaS · OEM/gömülü dağıtım |
| Metrik | Aktif mentee sayısı · kiracı (tenant) sayısı · kurulum (instance) sayısı · şirket koltuğu |
| Hacim / üst sınır | ör. 500 aktif mentee, 3 kurulum |
| Model | Yıllık abonelik · süresiz lisans + %20 yıllık bakım |
| Ücret | [tutar] / yıl, net |
| Lisanslı sürüm | ör. `v1.4.x` hattı / commit `abc123` |
| İştirakler | dahil / değil |
| Ek modüller | white-label, SSO, API/entegrasyon paketi (varsa) |

## Kontrol listesi — imzadan önce

- [ ] Avukat gözden geçirmesi (özellikle §§ 7, 8 ve alıcı Almanya'daysa AGB kontrolü).
- [ ] Faturalayan taraf netleşti mi? Tüzel kişi üzerinden satılacaksa hak sahibinden o
      tüzel kişiye **iç lisans** gerekir (bkz. [legal-tax-framework.md](legal-tax-framework.md)).
- [ ] KDV/reverse-charge doğru mu (AB içi B2B → alıcının VAT-ID'si + § 13b UStG notu).
- [ ] Kişisel veri işlenecekse Annex C (DPA) hazır mı?
- [ ] Üçüncü taraf açık kaynak bileşen listesi güncel mi (lisans uyumu: AGPL çekirdek +
      bağımlılıklar)?
- [ ] Alıcı Almanca sözleşme isterse: DE çeviri avukat tarafından hazırlanmalı (İngilizce
      metin Almanya'da geçerlidir, ancak kurumsal alıcılar DE ister).
