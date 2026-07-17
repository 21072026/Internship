# Mentee görünürlük rızası — politika & metinler (#551)

> Bu politika, koddaki teknik rıza mekanizmasını (#527, `UserConsent` +
> `TALENT_POOL_VISIBILITY`) **tanımlar/gerekçelendirir**. Metinler `/privacy` ve
> consent UI ile tutarlı olmalıdır.

## Karar — rıza kapsamı
Yetenek havuzu görünürlüğü **açık, özgür (opt-in) ve geri-alınabilir** rızaya bağlıdır
(GDPR Art. 6(1)(a) + Art. 7). Varsayılan **kapalı**.

### Şirkete görünen alanlar (yalnız bunlar)
- Ad-soyad, üniversite/bölüm, beceriler (+ self-assessment seviyeleri), hedef pozisyon,
  mentor değerlendirme **özeti** (ham yorum değil), tamamlanan proje katkıları.

### Asla paylaşılmayan
- E-posta, telefon, adres, ham iletişim bilgisi
- Mentor-özel notlar (`RelationNote`), kişisel notlar, ham değerlendirme yorumları
- CV dosyasının kendisi (yalnız rıza kapsamındaki türetilmiş alanlar)

### Kimlerle
- Yalnızca **entitlement'ı açık** (premium) şirket kullanıcıları; yalnızca rıza vermiş
  mentee'ler havuzda görünür.

### Süre & geri çekme
- Rıza istendiği an geri çekilebilir; geri çekilince mentee **anında** havuz
  aramasından ve eşleşme uyarılarından çıkar (mevcut davranış).
- Saklama: rıza kaydı retention politikasıyla uyumlu tutulur; görünürlük yalnızca rıza
  aktifken vardır.

## Rıza metni (UI — EN/TR/DE)
Koddaki `consent.items.talentPoolVisibility` ile birebir aynı olmalı:

- **TR:** "Şirketlere görünürlük (yetenek havuzu) — Partner şirketlerin profilini
  yetenek havuzu aramasında bulmasına ve açık pozisyonları için eşleşme uyarısı
  almasına izin ver. Yalnızca kamuya açık profilini görürler (ad, üniversite,
  beceriler, hedef pozisyon) — e-posta veya telefonunu asla. Varsayılan kapalı;
  istediğin an geri çekebilirsin ve şirket aramasından anında çıkarsın."
- **EN:** "Visibility to companies (talent pool) — Allow partner companies to find
  your profile in talent-pool search and receive match alerts. They see your public
  profile (name, university, skills, target position) — never your email or phone.
  Off by default; withdraw anytime and you disappear from company search immediately."
- **DE:** "Sichtbarkeit für Unternehmen (Talentpool) — Erlaube Partnerunternehmen,
  dein Profil in der Talentpool-Suche zu finden und Match-Hinweise zu erhalten. Sie
  sehen dein öffentliches Profil (Name, Universität, Fähigkeiten, Zielposition) —
  niemals E-Mail oder Telefon. Standardmäßig aus; jederzeit widerrufbar, du
  verschwindest sofort aus der Unternehmenssuche."

## /privacy güncellemesi (gerekli cümleler)
- Yetenek havuzu paylaşımı ve kapsamı (yukarıdaki alanlar)
- Hukuki dayanak: açık rıza (Art. 6(1)(a))
- Geri çekme hakkı ve etkisi (anında çıkış)
- Alıcı kategorisi: rıza kapsamında partner şirketler

## Aksiyon listesi
- [ ] `/privacy` metnine yukarıdaki paragrafı ekle (küçük kod işi; ayrı issue).
- [ ] consent UI metinleriyle bu politikayı senkron tut (değişirse ikisini birlikte).
