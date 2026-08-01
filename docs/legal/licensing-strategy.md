# Lisans stratejisi kararı

> Hukuki tavsiye değildir; ilk ticari lisans satışından önce avukat gözden geçirmesi
> gerekir.

## Karar

**Mevcut kurgu korunur: `AGPL-3.0-or-later` + ikili lisanslama (dual licensing).**
Repo public kalır; AGPL dışı kullanım isteyen taraflara ayrıca **ticari lisans**
satılır. Bu, GitLab / Grafana / Mattermost / Metabase gibi ürünlerin kullandığı
standart modeldir ve bu projenin hedefine (açık staj projesi + ileride ticari gelir)
uyar.

**Tek hak sahibi: Mehmet Erşahin** (gerçek kişi). İkili lisanslama ancak hakların tek
elde olmasıyla mümkündür; bu koşul sağlanmış durumda (bkz.
[cla-contributor-agreement.md](cla-contributor-agreement.md)).

## Gerekçe

### AGPL ne sağlıyor
- Kimse kodu **kapalı kaynak** bir ürüne gömemez. Kurumsal bir kullanıcı bunu kendi
  ürününe entegre etmek isterse ya tüm değişikliklerini yayınlamak (kurumsal alıcıların
  neredeyse hiç kabul etmediği bir şey) ya da **ticari lisans satın almak** zorunda.
  AGPL'in işlevi teknik bir kilit değil, **satın almaya iten ticari kaldıraçtır**.
- "Network use = distribution" maddesi sayesinde, MIT/Apache'nin aksine, kodu servis
  olarak sunan taraf da değişikliklerini yayınlamak zorundadır.
- **Hak sahibi AGPL'e bağlı değildir.** Kendi SaaS'ı (crm.ersah.in), kapalı premium
  modüller, white-label sürümü istediği gibi lisanslanabilir. AGPL yalnızca üçüncü
  tarafları bağlar.

### AGPL ne sağlamıyor (bilinçli kabul edilen risk)
- **Rakip olmayı engellemez:** biri repo'yu fork'layıp kendi sunucusunda barındırıp
  satabilir; tek yükümlülüğü değişikliklerini yayınlamaktır.
- **Premium kapıları korumaz:** `src/lib/entitlements.ts`, `planGate.ts`, `orgPlans.ts`
  public repo'da; bir fork bu kapıları kaldırabilir.

**Neden bu risk kabul edilebilir:** Bu üründe değerin kaynağı kod değil — doğrulanmış
aday havuzu (`Evaluation`, `InteractionLog`, `Project` geçmişi), mentor ağı, operasyonun
kendisi ve marka güveni. Fork bunları kopyalayamaz; sıfır veri, sıfır mentor, sıfır
referansla başlar. B2B alıcı da kaynak kodu değil **sorumluluk alan bir muhatap** satın
alır (SLA, DPA, destek, fatura) — fork bunu sunamaz.

## Değerlendirilen alternatifler

| Seçenek | Rakip koruması | Topluluk/portföy değeri | Karar |
|---|---|---|---|
| MIT / Apache-2.0 | Yok | En yüksek | ✗ ticari plan varsa yanlış |
| **AGPL-3.0-or-later + ikili lisans** | Orta-yüksek | Yüksek | ✅ **seçilen** |
| Open-core (çekirdek AGPL + premium modüller kapalı) | Yüksek | Yüksek | ↗ doğal sonraki adım |
| BSL / FSL (kaynak-açık, N yıl sonra açılır) | En yüksek | Düşer | ⏸ ancak gerçek rakip belirirse |
| Tamamen kapalı | Tam | Yok | ✗ mentorluk/portföy modelini öldürür |

Şu aşamada AGPL'den ayrılmanın maliyeti var, faydası yok: repo public ve mentee'lerin
portföy hikâyesi bunun üzerine kurulu. Ayrıca lisans **geriye dönük daraltılamaz** —
yayınlanmış her sürüm sonsuza dek AGPL kalır; yalnızca gelecek sürümler değiştirilebilir.

## Premium katmanın kod sınırı (Faz 3'e girmeden karar verilecek)

Çekirdek AGPL'de kalır. `docs/premium-model-calismasi.md` Faz 3 kalemleri (SSO/SAML,
beyaz etiket, ATS entegrasyonları, gelişmiş rapor ihracı) istenirse **ayrı bir özel
repo'da tescilli lisansla** geliştirilebilir → "açık çekirdek + kapalı kurumsal katman".
Bu sınır **kod yazılmadan önce** çizilmeli; sonradan iç içe geçmiş kodu ayırmak pahalıdır.
Bugün ücretsiz olan hiçbir özellik ücretli katmana taşınmaz (bkz. premium doküman § 0).

## Marka hakkı

AGPL **marka hakkı vermez**. "Internship CRM" adı, logosu ve `crm.ersah.in` alan adı
lisans kapsamı dışındadır; fork'lar farklı isim/marka kullanmak zorundadır. Bu, rakip
fork'ları caydırmanın en ucuz ve en etkili yoludur (`README.md` → *Trademarks*).

## AGPL uyumu — kendi tarafımız

Hak sahibi kendi lisansına bağlı olmasa da, hosted sürümü AGPL kodunu çalıştırdığı
sürece kullanıcılara kaynak erişimi sunmak iyi pratiktir (ve Enterprise satışında
sorulur). Repo public olduğu için ek yük yok; ürün içinde bir "kaynak kodu" bağlantısı
bulundurmak yeterlidir.

## Aksiyon listesi
- [x] Tek hak sahibini her yerde sabitle (`LICENSE`, `README.md`, `package.json`, CLA).
- [x] Marka hakkı notunu ekle (`README.md`, `LICENSE` başlığı).
- [x] Katkı şartlarını gelecek katkılar için yazılı hale getir (CONTRIBUTING + PR şablonu).
- [x] **Ticari lisans şablonu** taslağı hazır —
      [commercial-license-template.md](commercial-license-template.md) (avukat turu bekliyor).
- [ ] Premium/kapalı modül sınırını Faz 3'e girmeden yazılı olarak belirle.
- [ ] Ürün içine "kaynak kodu" bağlantısı ekle (küçük UI işi; ayrı issue).
