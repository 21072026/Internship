# LinkedIn oyun kitabı — InternCRM

**Tarih:** 2026-09-06 · **Kapsam:** LinkedIn kanalının kurulumu, denetimi, yayın ritmi ve ölçümü.
**Bu doküman tek başına yeterli değildir:** kanalın *neden* seçildiği ve diğer kanallarla sırası
[`go-to-market.md`](go-to-market.md) §6.6'da, haftalık takvim ve içerik pilerleri
[`content-calendar.md`](content-calendar.md)'da, gönderi metinlerinin kendisi `copy-bank.md`'de.
Burada yalnız **LinkedIn'e özgü mekanik** var: hangi alana ne yazılır, hangi ölçü, hangi tık yolu.

> **TODO — sayfa URL'i bilinmiyor.**
> InternCRM'in LinkedIn şirket sayfası **zaten açık**, ama bu oturumda URL'i tespit edilemedi ve arama
> motorlarında bulunamıyor (büyük olasılıkla boş ve indekssiz). İlk iş: sayfayı bul, URL'ini buraya yaz.
> Bulma yolu: linkedin.com'da oturum aç → sağ üst **Me** → **Manage** başlığı altında yönetici olduğun
> sayfalar listelenir. Görünmüyorsa sayfa başka bir hesapla açılmış demektir; o hesaptan
> **Admin tools → Manage admins** ile Mehmet super admin olarak eklenir.
> `LINKEDIN_PAGE_URL = <doldurulacak>` — bu değer §2.6'daki karşılıklı bağ işleri için ön koşuldur.

Bu doküman "yeni sayfa açma" değil **"denetle ve düzelt"** biçiminde yazılmıştır: §1 tablosu var olan
sayfanın üzerinden tek tek geçilecek bir denetim listesidir.

---

## 0. Yayın öncesi üç sert ön koşul

Aşağıdaki üçü yeşil olmadan LinkedIn'de **tek gönderi bile yayınlanmaz**. Bu bir tercih değil; ilki
hukuki, diğer ikisi kanalın işe yaramasının şartı.

| # | Ön koşul | Bugünkü durum | Neden bloklayıcı |
|---|---|---|---|
| ÖK1 | `interncrm.com/impressum` gerçek verilerle dolu (ad, ladungsfähige Adresse, e-posta, sorumlu kişi) | **Kırmızı** — "operatör tarafından doldurulacak" placeholder (#1371) | Ticari kullanılan sosyal medya varlığı § 5 DDG kapsamında impressum yükümlüsü. Eksik impressumla sayfa açmak, kendi kanalını Abmahnung'a açmaktır. Hak sahibi **Mehmet Erşahin (gerçek kişi)** yazılır, bcsit GmbH değil |
| ÖK2 | En az 3 ürün ekran görüntüsü (#1399) | **Kırmızı** | Sayfa banner'ı, gönderi görselleri ve carousel'in ortak hammaddesi. Görselsiz LinkedIn = text-only, en zayıf format |
| ÖK3 | Sayfadan gidilecek iniş sayfası hazır: `/features`, `/for-companies`, `/pricing` (#1403) | `/pricing` **kırmızı**, diğerleri yeşil | Custom button'ın hedefi. Fiyat sayfası yokken "yayımlanmış EUR fiyat" konumlandırması gönderide iddia edilemez |

`utm_*` yakalama (#1390) ve dönüşüm olayı (#1388) **bloklayıcı değildir** — ama ölçüm yalnız
§7.3'teki geçici çözüme dayanır ve bunu bilerek başlarız.

---

## 1. Sayfa denetim listesi

Sayfayı super admin olarak aç → sağ üstte **Edit page** (bazı görünümlerde kalem simgesi). Aşağıdaki
tablodaki her satırı sırayla kontrol et; "doğru değer" sütunundaki metinler kopyalanabilir hâldedir.

### 1.1 Kimlik ve görseller

| Alan | Doğru değer / ölçü | Neden | Kaynak |
|---|---|---|---|
| **Sayfa adı** | `InternCRM` | Ürün adı. Tüzel kişilik hâlâ açık soru (`docs/legal/legal-tax-framework.md`) ve hak sahibi gerçek kişi — sayfayı bcsit GmbH adıyla taşımak IP anlatısıyla çelişir | [LinkedIn Help — Pages oluşturma](https://www.linkedin.com/help/linkedin/answer/a543852) |
| **Logo** | **400×400 px** (mutlak min. 268×268), PNG veya JPEG, **≤3 MB**, **opak zemin** | LinkedIn logoyu hem açık hem koyu zeminde gösteriyor; şeffaf PNG'de koyu logo koyu zeminde kayboluyor. Bizde şans var: `src/app/icon.svg` zaten opak `#1D4ED8` yuvarlak kare üzerine beyaz mezuniyet kepi — 400×400 PNG'ye **şeffaflık olmadan** export et, kenarlık eklemeye gerek yok | [Image specifications for Pages](https://www.linkedin.com/help/linkedin/answer/a563309/image-specifications-for-your-linkedin-pages-and-career-pages?lang=en) |
| **Cover / banner** | **1512×256 px** (≈5,9:1), PNG/JPEG, ≤3 MB, animasyon yok | Üçüncü taraf 2026 blogları 1128×191 ve 4200×700 veriyor; **resmî LinkedIn Help ile çelişiyorlar** — resmî değeri kullan. Görsel farklı ekranlarda kırpılır: kritik metni ortadaki güvenli alana koy ve **sol-alt köşeyi boş bırak** (logo oraya biner) | aynı kaynak |
| **Tagline** | 120 karakter sınırı; anlamı **ilk 60-70 karaktere** sığdır. Öneri: `Mentor → Praktikum → Einstellung: 13 Stufen, offener Quellcode, veröffentlichte Preise.` | Arama sonuçlarında ve dar ekranda yalnız ilk yarı görünür. **Sayı çelişkisi notu:** 120 karakteri resmî Help sayfaları yazmıyor; birden çok üçüncü taraf tutarlı veriyor — güvenli tarafta kal, 110 karakteri geçme | [Tagline alanı](https://derrick-app.com/linkedin/company-information/tagline) (üçüncü taraf) |
| **About / Overview** | **1.500 karakterin altında** yaz. Konumlandırma ilk **300 karaktere** sığmalı: yayımlanmış EUR fiyat + mentor/mentee'ye ücretsiz çekirdek + AGPL self-host + mentee→staj→işe alım hunisi | "See more" kesme noktası ~300 karakter. **Sınır çelişkili:** kaynaklar 1.500 / 2.000 / 2.600 diyor, resmî Help hiçbir sayı vermiyor. 1.500 altı her senaryoda güvenli | [Karakter limitleri](https://authoredup.com/blog/linkedin-character-limit) (üçüncü taraf, çelişkili) |
| **Industry** | `Software Development` | Products sekmesi uygunluğu B2B software olmaya bağlı; ayrıca **Invite to follow** kilidini açan üç alandan biri | [Products sekmesi](https://www.linkedin.com/help/linkedin/answer/a564431) |
| **Company size** | `1-10 employees` | Invite to follow kilidini açan alan. Küçük olmak dezavantaj değil — hikâyemiz zaten "tek kurucu + stajyerler" | [Sayfa tamamlama](https://www.linkedin.com/help/linkedin/answer/a553372/vyplneni-vasi-stranky-linkedin?lang=en-us&intendedLocale=cs) |
| **Company type** | Tüzel kişilik netleşene kadar en dar doğru seçenek (`Self-Employed` / `Privately Held`); **GmbH işaretleme** | Yanlış tüzel kişilik beyanı hem IP anlatısıyla hem `legal-tax-framework.md` ile çelişir | [Pages oluşturma](https://www.linkedin.com/help/linkedin/answer/a543852) |
| **Website URL** | **`https://interncrm.com/impressum`** (ÖK1 yeşil olduktan sonra) | LinkedIn'de ayrı Impressum alanı **yok**. Kabul gören çözüm: Website URL alanına kendi sitendeki tam Impressum linki — "iki tık" kuralı. Sayfanın ana sitesine giden link zaten custom button'da duruyor | [§5 DDG + LinkedIn](https://www.e-recht24.de/impressum/13397-impressum-linkedin.html), [§ 5 DDG](https://www.gesetze-im-internet.de/ddg/__5.html) |
| **Location** | Gerçek ladungsfähige adres (Impressum ile **birebir aynı**) | İki yerde farklı adres, impressum tartışmasında en kolay yakalanan tutarsızlık | § 5 DDG |
| **Custom button** | `Visit website` → `https://interncrm.com/for-companies?utm_source=linkedin&utm_medium=page&utm_campaign=cta_button` | Seçenekler **kapalı liste**: Contact us · Learn more · Register · Sign up · Visit website. "Increase button visibility" toggle'ını da aç. Tıklama sayısı Visitor analytics'te ayrı raporlanıyor — bu bizim **tek gerçek attribution köprümüz** (§7.3) | [Custom button](https://www.linkedin.com/help/linkedin/answer/a5993422) |
| **Hashtags** | **En fazla 3.** Başlangıç: `#Praktikum` `#DualesStudium` `#Mentoring` | Sayfa o akışlara girer ve **sayfa kimliğiyle** beğeni/yorum yapabilir — markanın topluluğa girmesinin tek yolu. TR tarafı ayrı gönderilerde hashtag'siz denenir | [Hashtag ilişkilendirme](https://www.linkedin.com/help/linkedin/answer/a1493822/associate-a-hashtag-with-your-linkedin-page?lang=en-us&intendedLocale=en) |
| **Gönderi görseli (sayfa)** | 1200×627 px (1,91:1), min genişlik 200 px, PNG/JPEG, ≤3 MB | Resmî spec bu. Kare (1080×1080) ve portre (1080×1350) mobilde daha çok dikey alan kaplar — üçüncü taraf önerisi, resmî spec değil; ikisi de kabul ediliyor | [Image specifications](https://www.linkedin.com/help/linkedin/answer/a563309/image-specifications-for-your-linkedin-pages-and-career-pages?lang=en) |
| **Life tab / Career Pages** | **Dokunma.** Hafta 1-12'de gereksiz | Ana görsel 1128×376, modüller 502×282, foto min 264×176 — ücretli Career Pages ürününe bağlı olup olmadığı resmî spec'ten doğrulanamadı, kapasitemiz yok | aynı kaynak |
| **Verified badge** | **Bugün başvurma.** Hafta 12+ | Uygunluk düzenli paylaşım + üye etkileşimi + **LinkedIn ile ticari ilişki** (reklam, iş ilanı veya Premium) istiyor. Bizde ticari ilişki sıfır. Domain sahipliği kanıtı 48 saate kadar sürer, zaman aşımında baştan başlanır | [Sayfa doğrulama](https://www.linkedin.com/help/linkedin/answer/a7174627) |

### 1.2 Tamamlanmışlık — neden tek tek uğraşıyoruz

LinkedIn'in kendi ifadesi: *"Pages with complete information such as logo, description, and website URL
are more discoverable and potentially receive **30% more weekly views**."* Ve daha sertçesi:
**Industry + Company size + Overview tamamlanmadan "Invite to follow" özelliği kullanılamaz** — sıfır
takipçiden çıkmanın tek organik aracı odur.
Kaynak: [Sayfa tamamlama](https://www.linkedin.com/help/linkedin/answer/a553372/vyplneni-vasi-stranky-linkedin?lang=en-us&intendedLocale=cs)

**Invite to follow mekaniği:** sayfaya aylık davet kredisi tanımlanıyor, tüm adminler arasında paylaşılıyor,
her ayın ilk günü yenileniyor; **kabul edilen davet krediyi geri kazandırıyor** (bakiyeye yansıması 72 saati
bulabilir). LinkedIn kesin sayı vermiyor ve kredi politikasını değiştirdiğini not düşüyor; dolaşımdaki
"100 kredi / 250 kredi" iddiaları **doğrulanamadı**. Pratik kural: bakiyeyi *Invite connections*
penceresinden oku, **her ay tamamını kullan**, ay sonuna kredi bırakma.
Kaynak: [Invite to follow](https://www.linkedin.com/help/linkedin/answer/a547492)

### 1.3 Denetim çıktısı

Denetimi bitirdiğinde bu satırı doldur ve dokümanı güncelle:

```
Sayfa denetimi — <tarih>
URL: ...
Yeşil: ... / 15   Kırmızı: ...   Bloklayıcı: ÖK1 ÖK2 ÖK3 durumu
```

---

## 2. Sayfayı bulunabilir yapmak

Bugünkü sorun keşif değil **varlık**: ürün adıyla arama yapıldığında hiçbir şey çıkmıyor. Sayfanın
kendisi bir SEO varlığıdır (LinkedIn sayfaları Google'da indekslenir), ama ancak doluysa.

### 2.1 Vanity URL (özel URL)

**Tık yolu:** Edit page → **Page info** → **LinkedIn public URL** → `linkedin.com/company/interncrm`.
`interncrm` alınmışsa sırasıyla dene: `interncrm-app`, `interncrm-software`, `getinterncrm`.
Hedef URL'i `LINKEDIN_PAGE_URL` olarak §0'daki TODO'ya yaz.
*Not: LinkedIn public URL sayfa oluşturmanın zorunlu alanlarından biri
([kaynak](https://www.linkedin.com/help/linkedin/answer/a543852)); sonradan **kaç kez** değiştirilebildiği
doğrulanamadı — bir kez seç, bir daha dokunma.*

### 2.2 Anahtar kelimeli tagline ve About

LinkedIn sayfa aramasında tagline ve About metni taranıyor. İçine gerçekten aranan kelimeler koy:
`Praktikum`, `Praktikantenverwaltung`, `Berichtsheft`, `duales Studium`, `Mentoring-Programm`,
`Bewerbermanagement`. **Kelime doldurma yapma** — About'un ilk 300 karakteri insan için yazılır,
kelimeler onu takip eden paragraflara doğal biçimde girer.
Yasak ifadeler burada da geçerli: kullanıcı/müşteri sayısı yok, "çok kiracılı SaaS" yok
(`MT_ENFORCE_ISOLATION=false`), `crm-demo.ersah.in` yok — tek demo adresi `https://demo.interncrm.com`.

### 2.3 Hashtag'ler (sayfa kimliğiyle topluluğa girmek)

Edit page → **Hashtags** → en fazla 3. Eklendikten sonra sayfa görünümünde bu akışları gezip
**sayfa olarak** yorum yapabilirsin. Haftada bir kez, 10 dakika: `#Praktikum` akışında 2-3 gerçek yoruma
yanıt bırak (satış değil, cevap). Bu, sıfır takipçili bir sayfanın feed dışında görünmesinin tek ücretsiz yolu.

### 2.4 Products sekmesi

InternCRM **B2B software** olduğu için uygun (resmî uygun sektör listesi: B2B software, computer hardware,
financial services, insurance, education, healthcare, pharmaceuticals).
**Tık yolu:** sayfa admin görünümü → **Products** → **Add product** → ad `InternCRM`, kategori, medya, iniş
URL'i. Her yeni ürün sayfası **yayın öncesi LinkedIn ekibince incelenir** ve ürünün fikri hakkına sahip
olmadığın tespit edilirse reddedilir — bizde hak sahibi Mehmet Erşahin, sayfa sahipliğiyle tutarlı olmalı.
Medyada MP4/kısa klip öneriliyor.
Üçüncü taraf iddiaları (500 karakter açıklama sınırı, 35 ek ürün sayfası, ziyaretçiye son 10'unun
gösterilmesi) resmî sayfada **yok** — plan yaparken bunlara dayanma.
Kaynak: [Products](https://www.linkedin.com/help/linkedin/answer/a564431)
**Zamanlama:** hafta 4-5. ÖK2 (ekran görüntüleri) ve ÖK3 (`/pricing`) bitmeden açma; inceleme reddi
tekrar denemeyi geciktirir.

### 2.5 Newsletter (sayfa + kişisel)

- **Kişisel profil:** bugün başlatılabilir — eski Creator Mode kapısı kalktı, tüm üyeler açabiliyor.
- **Sayfa:** *"Pages with more than 150 followers and/or connections are eligible to be evaluated"* +
  düzenli özgün içerik + Professional Community Policies açısından iyi durum.
- **Değeri:** bülten feed algoritmasını **atlıyor**, abonelere push bildirimi + e-posta gidiyor.
- **Karar:** hafta 6'da 150 takipçi geçilirse **aylık InternCRM sürüm bülteni** sayfadan başlatılır
  (`src/lib/releaseNotes.ts` → `/release-notes` zaten kaynak). LinkedIn bülteni, ürünün kendi
  DOI'li e-posta bülteninin (`docs/newsletter.md`) yerine geçmez; ikisi ayrı kitle.
- Kaynak: [Newsletter uygunluğu](https://www.linkedin.com/help/linkedin/answer/a591266)

### 2.6 Karşılıklı bağ (sayfayı sitemizden ve repodan linkleyelim)

`LINKEDIN_PAGE_URL` netleştikten sonra üç ayrı yerde iş var. Üçü de ayrı PR olabilir; hepsi **#1360
kapsamındaki on-site SEO işinden bağımsız**, küçük ve mekanik:

| Nereye | Ne yapılır | Dosya |
|---|---|---|
| Sitenin footer'ı | LinkedIn ikon linki (`rel="me"`), üç dilde aynı | `src/components/` altındaki footer bileşeni + `src/i18n/dictionaries.ts` |
| README rozet satırı | `[![LinkedIn](...)](LINKEDIN_PAGE_URL)` — mevcut rozet dizisinin sonuna | `README.md` |
| GitHub About | homepage alanı `https://interncrm.com` (bugün **boş**), topics eklenir | GitHub UI → repo sağ üst ⚙ |

Ayrıca ters yön: LinkedIn sayfasında Website URL **Impressum'a** gider (§1.1), custom button ise
`/for-companies`'e. Sitenin footer'ı → LinkedIn, LinkedIn → site: karşılıklı bağ tamamlanır.
GitHub topics önerisi (bugün **hiç yok**): `mentorship`, `internship`, `crm`, `nextjs`, `prisma`,
`self-hosted`, `agpl`, `applicant-tracking`.

---

## 3. Kurucu profili (birincil kanal)

Feed dağıtımının büyük kısmı kişisel profillere gidiyor; şirket sayfalarının organik erişimi 2024-2026
arasında ciddi biçimde düştü. Tek kurucuda "çalışan advocacy" kaldıracı da yok. **Sonuç: birincil kanal
Mehmet Erşahin'in kişisel profili, şirket sayfası vitrin/kanıt katmanı.**
Kaynaklar: [socialpilot](https://www.socialpilot.co/blog/linkedin-algorithm),
[tryordinal](https://www.tryordinal.com/blog/the-declining-reach-of-linkedin-company-pages) — üçüncü
taraf, LinkedIn resmî teyidi yok; katsayılar (7x, 8x, %561) kaynaklar arasında **çelişiyor**, yön tutarlı.

### 3.1 Headline — üç sürüm

220 karakter sınırı içinde kal; ilk ~50 karakter yorum listelerinde ve arama sonuçlarında görünür.
Üçünü de dene, 3 hafta sonra "search appearances" metriğine bakarak birini bırak.

**A — Kanıt öncelikli (Persona B için, DE):**
```
Ich baue InternCRM: Mentoring → Praktikum → Einstellung in einer Anwendung · geschrieben von den
Praktikant:innen, die darin betreut werden · Open Source (AGPL)
```

**B — Sorun öncelikli (Persona A için, DE):**
```
Praktikumsbetreuung läuft immer noch in Excel. Ich baue die Alternative: 13 Pipeline-Stufen,
Berichtsheft-Freigabe, veröffentlichte Preise · InternCRM (AGPL, self-hostable)
```

**C — Teknik/topluluk (hafta 3-6 EN fazı için):**
```
Building InternCRM — an open-source mentee→internship→hire pipeline (Next.js, Prisma, AGPL).
15+ yrs shipping software. Public demo, published pricing, no demo-call gate.
```

Kural: hangisi seçilirse seçilsin içinde **sayı iddiası yok** (kullanıcı/müşteri sayısı) ve
**"multi-tenant SaaS" yok**.

### 3.2 About metni iskeleti

İlk 3 satır "…see more" öncesi görünür — hook oraya sığar. Toplam 1.200-2.000 karakter hedefle.

```
[1] Kanca (2 satır): somut sahne. "Bir mentorluk programını yıllarca elektronik tabloda yürüttüm."
[2] Ne yaptım (3-4 satır): InternCRM ne — mentee→staj→işe alım hunisi, 13 aşama, aşama SLA'sı,
    çıkış nedeni taksonomisi, Berichtsheft onay akışı. Ürünü değil MESELEYİ anlat.
[3] Kopyalanamaz hikâye (2-3 satır): ürünü, içinde mentorluk alan stajyerler yazıyor.
    Adayın kalitesini ürünün kendisi kanıtlıyor.
[4] Duruş (3 satır): kaynak açık (AGPL-3.0-or-later), demo herkese açık ve yazılabilir,
    fiyat yayımlanmış, demo görüşmesi kapısı yok. Kategorinin 16 satıcısından yalnız 3'ü
    fiyat yayımlıyor — bu bir tercih, bir eksiklik değil.
[5] Kimim (2 satır): 15+ yıl senior developer, Almanya'da.
[6] Ne isterim (1 satır, soru): "Staj sürecinizi bugün nerede kaydediyorsunuz?" — yorum daveti.
```

**Uzun düz metin yaz** — madde işaretli About'lar dwell time üretmiyor. Link koyma; linkler
Featured ve Contact info'da duruyor.

### 3.3 Featured bölümü — tam olarak dört öğe

**Tık yolu:** profil → **Add profile section** → **Recommended** → **Add featured** → **Add a link**.

| Sıra | Ne | URL | Neden |
|---|---|---|---|
| 1 | Herkese açık demo | `https://demo.interncrm.com/?utm_source=linkedin&utm_medium=profile&utm_campaign=featured_demo` | Kanıtın kendisi. Sentetik veri, `robots.txt: Disallow: /` — indeksleme derdi yok |
| 2 | Özellik kataloğu | `https://interncrm.com/features?utm_source=linkedin&utm_medium=profile&utm_campaign=featured_features` | `src/lib/features.ts` (46 kayıtlı özellik) tek kaynaktan besleniyor; iddiaların doğrulanabilir hâli |
| 3 | GitHub deposu | `https://github.com/21072026/Internship` | AGPL + açık geliştirme; "self-host edebilirsin" iddiasının kanıtı |
| 4 | Fiyat sayfası | `https://interncrm.com/pricing?...&utm_campaign=featured_pricing` | **ÖK3 bitince eklenir** (#1403). Kama'nın en keskin ucu: yayımlanmış fiyat |

**Featured'ın gizli faydası:** LinkedIn'in gövde-içi dış link cezası (§5.3) Featured bölümünü
kapsamıyor — link burada durur, gönderiye girmez.

### 3.4 Contact info ve banner

- **Contact info → Add website** → `https://interncrm.com/impressum`, tür: **Other**, etiket `Impressum`.
  Ticari kullanılan **kişisel profil** de § 5 DDG kapsamında ([e-recht24](https://www.e-recht24.de/impressum/13396-impressum-social-media.html)).
- **Banner:** ürün ekranından bir kesit + tek cümle. Metni ortada tut; profil fotoğrafı sol-altı kapatır.
- **Profil fotoğrafı:** gerçek yüz. Tek kurucu ürününde logo profil fotoğrafı, kanalın en büyük kaldıracını
  (kişisel profil dağıtımı) elle bırakmaktır.

### 3.5 Profilin ürünle bağı

Profil bir CV değil, ürünün **kanıt yüzeyi**. Üç bağ zorunlu:
1. Featured → demo (§3.3) — tıklanabilir kanıt.
2. Experience'ta InternCRM kaydı → sayfa etiketli (şirket sayfası seçilerek), böylece profilden sayfaya
   trafik akar. Sayfa açılmadan/etiketlenmeden bu bağ yoktur.
3. Her sürümde `/release-notes`'a bakıp o hafta "ne değişti" notu — profilin canlı olduğunun kanıtı.

---

## 4. Kişisel profil ↔ şirket sayfası iş bölümü

### 4.1 Kim ne yayınlar

| | **Kişisel profil (KP)** — birincil | **Şirket sayfası (SP)** — vitrin |
|---|---|---|
| Sıklık | 2 ana gönderi / hafta (+0-1 opsiyonel) | 1 / hafta |
| Gün | Çarşamba + Perşembe **veya** Cuma | Cuma |
| Ses | Birinci tekil. "Yıllarca elektronik tabloda yürüttüm" | Kurumsal ama kuru değil. "Bu sürümde şu değişti" |
| İçerik | Mesele, karar, hata, build-in-public, sektör gözlemi | Sürüm notu, özellik kartı, demo daveti, doküman/carousel tekrarı |
| Format | Metin+ekran görüntüsü / doküman PDF / kısa not | Görsel + kısa metin, ayda 1 doküman |
| Yayın | Autoposter hattı (§5.5) veya elle | **Elle** — sayfa API'si partner-gated |
| Link | Gövdede **asla** | Gövdede asla; custom button zaten duruyor |

**Sıklık notu — kaynaklar doğrudan çelişiyor, saklamıyoruz.** Buffer 2M+ gönderiyi ölçtü ve frekans
arttıkça **gönderi başına** performansın da arttığını buldu (11+ gönderi/hafta: +16.946 impression,
3x engagement, düşüş yok). Van der Blom 2026 tam tersini söylüyor: sweet spot 2-4/hafta, günlük
paylaşımda gönderi başına erişim %26 düşüyor, zamanla -%45 içerik yorgunluğu.
Kaynaklar: [Buffer](https://buffer.com/resources/how-often-to-post-on-linkedin/),
[van der Blom aktarımı](https://melaniegoodmanlinkedinconsultant.substack.com/p/linkedin-algorithm-2026-reach-topic-authority)
**Bizim kararımız çelişkiyi çözmüyor, kapasiteyi çözüyor:** haftalık bütçe ≤150 dakika
(`content-calendar.md` §1.2) → KP 2+1, SP 1. Araştırma "KP 3 / SP 2" öneriyordu; **bilerek daha az
yayınlıyoruz**, çünkü sürdürülemeyen ritim 4. haftada duruyor ve bu, düşük frekanstan kötü.

### 4.2 Çapraz besleme kuralı

**Kural 1 — SP, KP'nin repost'u değildir.** Aynı fikir sayfada **yeniden yazılır**: kişisel gönderi
"neden böyle karar verdim", sayfa gönderisi "ürün bugün şunu yapıyor". Repost, sayfaya zaten düşük olan
erişimden bir de tekrar cezası ekler.

**Kural 2 — Sıra: önce KP, sonra SP.** Kişisel gönderi Çarşamba, aynı fikrin kurumsal hâli Cuma.
Aynı gün ikisi birden yayınlanmaz.

**Kural 3 — Sayfa gönderisini kişisel profilden paylaşma alışkanlığı yapma.** Ayda **en fazla bir kez**,
ve paylaşırken kendi yorumunu ekle (boş paylaşım erişim almaz). Aksi hâlde kişisel profil, sayfanın
megafonuna dönüşür ve kendi sesini kaybeder.

**Kural 4 — Yorumlar KP'den, sayfa kimliğiyle yorum yalnız hashtag akışlarında (§2.3).** Sayfa
kimliğiyle rastgele gönderilere yorum yapmak marka spam'i gibi okunuyor.

**Kural 5 — Bir fikir en fazla iki kanalda.** Aynı carousel'i KP + SP + newsletter + GitHub Discussion'a
dağıtmak dördünde de zayıflatır.

---

## 5. İlk 10 gönderi planı

Metinler **burada değil** — `copy-bank.md`'de. Burada konu, format, asset ve ön koşul var.
Piler kısaltmaları `content-calendar.md` §4'ten: P1 kırık huni · P2 Berichtsheft · P3 stajyerlerin yazdığı
ürün · P4 self-host · P5 fiyat gizlemesi · P6 üç dilli ürün · P7 yazılabilir demo.

### 5.1 Plan

| # | Hafta / gün | Kanal | Dil | Piler | Konu | Format | Asset | Ön koşul |
|---|---|---|---|---|---|---|---|---|
| 1 | H3 Çar | KP | EN | P3 | "Bu CRM'i, içinde mentorluk alan stajyerler yazdı" — açılış gönderisi, kanalın manifestosu | Metin 1.500-1.800 kr + ekran görüntüsü | Pipeline board ekranı | ÖK1, ÖK2 |
| 2 | H3 Cum | SP | EN | — | Sayfa açılışı: InternCRM ne yapar, demo herkese açık | Görsel + 600-800 kr | Landing hero kesiti | §1 denetimi yeşil |
| 3 | H4 Çar | KP | EN | P1 | Neden 13 aşama: "Applied / Interviewing / Hired" üçlüsünün gizlediği şey | **Doküman PDF, 10 slayt** | Aşama listesi carousel'i (`docs/pipeline-stages.md`) | ÖK2 |
| 4 | H4 Per | KP | EN | P7 | Demo'yu **yazılabilir** bırakmak: güven mühendisliği ve bunun bedeli | Kısa metin 700-900 kr, görselsiz | — | demo.interncrm.com ayakta |
| 5 | H5 Çar | KP | DE | P2 | Berichtsheft/haftalık staj raporu onayı: kâğıttan akışa | Metin + ekran görüntüsü | Rapor onay ekranı (DE arayüz) | DE arayüz demo'da gezinebilir |
| 6 | H5 Cum | SP | DE | P2 | Aynı meselenin kurumsal hâli: özellik kartı + demo daveti | Görsel + 500 kr | `/features` kartı | Products sekmesi (§2.4) |
| 7 | H6 Çar | KP | EN | P5 | 16 rakip inceledim, 3'ü fiyat yayımlıyor: kategorinin demo-call kapısı | **Doküman PDF, 8-12 slayt** | Rakip/fiyat tablosu (`docs/research/competitive-analysis-2026-08.md`) | **ÖK3 — `/pricing` yayında** (#1403) |
| 8 | H6 Per | KP | EN | P4 | Bir CRM'i self-host etmek: docker compose'dan ilk kullanıcıya | Metin + terminal/compose görseli | `docs/self-hosting.md` | Self-hosting dokümanı hazır |
| 9 | H7 Çar | KP | DE | P1 | Aşama SLA'sı ve çıkış nedeni taksonomisi: "neden düştü" sorusunun cevabı | Metin 1.800+ kr, görselsiz (dwell time) | — | — |
| 10 | H7 Cum | SP | DE | P6 | Üç dilli ürün geliştirmenin maliyeti (EN/TR/DE, CI'da anahtar paritesi) | Görsel + 600 kr | `npm run check:i18n` çıktısı görseli | — |

**Not:** liste `content-calendar.md` §2'deki faz sırasıyla uyumlu (H3-6 EN, H5-10 DE). Bir gönderi
**tek dilde** yazılır; çakışma haftalarında iki ana gönderi iki farklı fazın dilinde ve **farklı günlerde**.

### 5.2 Yayın saatleri

- **Gün:** Çarşamba en güçlü, sonra Perşembe ve Cuma (Buffer, 4,8M gönderi).
- **Saat:** hafta içi **yerel 15:00-20:00** (Berlin). Çarşamba 16:00 en güçlü nokta; Cuma 15:00-16:00.
  Buffer verisi 2025'e göre değişti: **akşam artık sabahtan iyi**. Diğer kaynaklar sabahı savunuyor —
  **çelişkili**; 15:00-20:00 bandını 6 hafta tut, sonra kendi verinle karar ver.
- Kaynak: [Buffer — en iyi zaman](https://buffer.com/resources/how-often-to-post-on-linkedin/)
- **Sert kural:** yayın saatinden sonraki 60 dakika boyunca yorumlara yanıt verecek durumda değilsen
  **o gönderiyi yayınlama**, ertele (§6.1).

### 5.3 Uzunluk, format, link

- **Uzunluk:** 1.300-2.000 karakter bandı. AuthoredUp 372.126 gönderi (Eyl 2025-Şub 2026): 1.301-2.500
  karakter aralığı, 400 karakter altına göre **+%27 engagement**. Sınır 3.000.
  [Kaynak](https://authoredup.com/blog/linkedin-character-limit)
- **Kanca ilk 140 karaktere sığar** — mobil "see more" kesme noktası (desktop ~210).
- **Format sıralaması 2026:** native doküman/carousel (PDF) ≈ %6,60-7,00 > native video %5,60
  (ama ortalama izlenme %36 düştü) > text-only ≈ %2,00. **Anket kullanma** (%0,07 — tek kaynak,
  doğrulanamadı, ama hiçbir kaynak anketi önermiyor).
- **Doküman post spec:** PDF/PPT/PPTX/DOC/DOCX, ≤100 MB, ≤300 sayfa; **PDF'e export et** (her cihazda
  tutarlı render). Tasarım 1080×1080 veya 1080×1350 (mobilde en çok dikey alan). 8-12 slayt, slayt başına
  tek fikir, <60 kelime. [Kaynak](https://www.trymypost.com/blog/linkedin-pdf-carousel-specs) (üçüncü taraf)
- **Dwell time beğeniden önemli:** 61+ saniye dwell alan gönderilerde engagement %15,6; 3 saniyenin altında
  taranan gönderilerde %1,2. Tasarım sonucu: **uzun, okunması zaman alan native içerik**, linkli kısa
  gönderiden yapısal olarak üstün.
- **Dış link:** gövdeye **koyma**. En sağlam ölçüm: gövdedeki bir dış link medyan erişimi **%18,8**
  düşürüyor (van der Blom, 1,3M gönderi). Dolaşımdaki "%40" ve "%60" rakamları kaynaksız —
  **%18,8'i taban al, %60'a dayanarak strateji kurma.**
- **"Link in comments" ÖLDÜ.** Dış link içeren yorumların görünürlüğü %80'e kadar bastırılıyor;
  algoritma "bridge behavior"ı tespit ediyor, workaround 2026 başında kapatıldı.
  [sparktoro](https://sparktoro.com/blog/how-to-overcome-the-link-in-comments-problem-on-linkedin-and-other-social-platforms/)
- **Link istiyorsan üç meşru yer:** (a) profil Featured + Contact info, (b) sayfa custom button,
  (c) LinkedIn **Article** olarak yayınla — Article dış link cezası taşımıyor.
- **Hashtag:** gönderide 0-1. Hashtag'siz gönderiler %5-10 daha iyi performans gösteriyor
  (van der Blom 2026). Sayfa hashtag'leri (§2.3) ayrı mekanizma, onlar 3 kalır.

### 5.4 Yayın öncesi kontrol listesi (her gönderi, 60 saniye)

```
[ ] Kanca ilk 140 karakterde mi?
[ ] Uzunluk 1.300-2.000 arasında mı? (kısa notlar hariç)
[ ] Gövdede dış link YOK
[ ] İlk yorumda dış link YOK
[ ] Hashtag 0-1
[ ] Tek dil (karışık değil)
[ ] Kullanıcı/müşteri SAYISI yok, "multi-tenant SaaS" yok
[ ] Demo adresi: demo.interncrm.com  (crm-demo.ersah.in DEĞİL)
[ ] Sonraki 60 dakika yorum yanıtlamaya müsait mi?
```

### 5.5 Otomasyon (autoposter InternCRM hattı)

- **Kişisel profil: bugün otomatikleştirilebilir.** Developer app'e self-serve "Share on LinkedIn" ürünü
  eklenir, `w_member_social` scope'u onaysız gelir; metin/görsel/video/doküman/multi-image aynı gün
  yayınlanabilir.
- **Şirket sayfası: partner-gated.** `w_organization_social` Community Management API'ye bağlı;
  vetted, Development Tier + Standard Tier (Standard için screencast'li başvuru). Development Tier resmî
  rate limit: uygulama başına 500, üye başına 100 istek. `r_member_social` **kapalı** ("we're not accepting
  access requests at this time"). Onay süresi üçüncü tarafa göre iyi senaryoda 4-8 hafta, tipik 3-4 ay.
  → **Hafta 1-12'de sayfa gönderileri elle atılır.**
  [Kaynak](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-08)
- **API içerik tipi kısıtı:** organik **carousel API'den atılamaz**; carousel içeriği `documents` tipiyle
  (PDF) gönderilir. Article gönderisinde LinkedIn URL scraping yapmıyor — thumbnail (Images API'den image
  URN), title, description **elle** set edilir; yani API'den atılan gönderide link önizlemesi otomatik
  oluşmaz. Bu, sitede OG/Twitter kartı olmaması sorununu (#1362/#1376/#1378) API tarafında tekrar ediyor.
  [Kaynak](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- **Hattın kuralları (BCSIT hattından devralınır, tartışmaya kapalı):** metni **hat** yazar, fikir besleyen
  taraf metin yazmaz; fikir ekleme endpoint'i dışında yazma endpoint'i kullanılmaz; **kategorik yayın
  yasağı** — LinkedIn'e doğrudan istek yok, Telegram onay butonlarına ajan basmaz, yayın kararı insana ait.
- **InternCRM hattı BCSIT hattından ayrı olmalı:** farklı kitle (staj/mentorluk), farklı ses, farklı
  kategoriler. Aynı hatta karıştırmak iki kitleyi de bozar.

---

## 6. Etkileşim protokolü

### 6.1 İlk 60 dakika

Erken engagement hızı ilk-5 sıralama sinyalinden biri; kritik pencere **ilk 30-60 dakika**. Bir kaynak
ilk saatte düşük performans gösteren gönderilerin yalnız %5'inin toparlandığını söylüyor (**tek kaynak,
doğrulanamadı**). Brief'teki "60-90 dakika" eşiği hiçbir kaynakta bu şekilde geçmiyor — **60 dakika** al.

Operasyonel karşılığı, dakika dakika:

| Dakika | Ne yapılır |
|---|---|
| 0 | Yayınla. Sekmeyi kapatma |
| 0-5 | Gönderiyi mobilde aç, kesme noktasını gör: kanca "see more"dan önce tamamlanıyor mu? Değilse **düzenle** (ilk dakikalarda düzenleme cezası gözlenmiyor; 60 dk sonra düzenlemekten kaçın) |
| 5-60 | Gelen her yoruma **60 dakika içinde** yanıt ver. Yanıt tek kelime olmasın — soru sor, konuşmayı uzat (yorum uzunluğu ve alt-yorum sayısı sinyal) |
| 60 | Pencere kapandı. Gönderiyi bırak |
| +24 sa | İkinci tur: gecikmiş yorumlara yanıt. Bu turda gönderiye link **eklenebilir** (düzenleme) — ama kural olarak eklemiyoruz |

**Yayınlamama kuralı:** sonraki 60 dakikada toplantıdaysan, yoldaysan veya çevrimdışıysan gönderiyi
ertele. Kötü zamanlanmış iyi gönderi, ertelenmiş iyi gönderiden değersizdir.

### 6.2 Yorum yanıtlama biçimi

- Beğeni değil **yorum** hedefle: yorum ve alt-yorumlar erişimi taşıyor.
- Yanıtta **soru bırak** — konuşma iki turdan uzun sürerse gönderi ikinci bir dağıtım turu alıyor.
- "Teşekkürler 🙏" tipi yanıt yazma; sinyal üretmiyor, üstelik ciddiyetsiz.
- Muhalif yoruma savunmayla değil **veriyle** yanıt ver: `docs/research/competitive-analysis-2026-08.md`
  ve `src/lib/features.ts` elinin altında.
- **Yorumda satış yok, DM daveti yok.** Karşı taraf "nasıl deneyebilirim" derse: "demo herkese açık,
  profilimde Featured'ta" — link yazma (§5.3).

### 6.3 Başkalarının gönderilerine yorum (haftada 30 dakika)

Bu, sıfır takipçili bir hesapta **kendi gönderilerinden daha çok** iş görür. Haftada 3 oturum × 10 dk,
oturumda 3-5 gerçek yorum. Yorum en az 2 cümle ve gönderinin içeriğine özgü olsun.

**Takip edilecek sayfa ve kişi türleri:**

| Küme | Ne aranır | Neden |
|---|---|---|
| Persona B kurumları | Üniversite kariyer merkezleri, DHBW kampüsleri, Studierendenwerke, dual-study koordinatörleri | Doğrudan alıcı; içerikleri kamuya açık ve etkileşime aç |
| Mentorluk ağları | Forum Mentoring e.V., Deutsche Gesellschaft für Mentoring (DGM) sayfaları ve üyeleri | Ürünün çekirdek kavramına en yakın topluluk |
| IHK'lar | Bölgesel IHK sayfaları (Ausbildung/Praktikum içerikleri) | Persona A'ya kurumsal köprü |
| HR-tech gözlemcileri | DE HR-tech yorumcuları, "Recruiting Kaffee" tipi topluluklar | Kategori tartışmasına giriş |
| Açık kaynak / self-host | AGPL, self-hosted SaaS tartışan geliştiriciler (EN) | Hafta 3-6 EN fazının kitlesi |

**Katılınacak gruplar:** LinkedIn grupları 2026'da düşük değerli — **en fazla iki** gruba gir
(DE mentorluk/Praktikum odaklı) ve oraya **gönderi atma**, yalnız var olan tartışmalara yanıt ver.
Grup gönderisi ile feed gönderisi aynı dağıtımı almıyor; grup, ilişki kurma yeri.

### 6.4 Hukuki sınır — DM ve InMail

**LinkedIn DM'i hukuken soğuk e-postayla aynıdır.** OLG Hamm 03.05.2023 - 18 U 154/22: sosyal ağların
mesajlaşma işlevi üzerinden gönderilen doğrudan mesajlar § 7 UWG anlamında "elektronische Post"tur.

| Serbest | Yasak |
|---|---|
| Sayfadan ve profilden organik içerik | Tanıtım içeren DM veya InMail |
| Başkalarının gönderilerine yorum | Tanıtım metni gömülü bağlantı isteği |
| Gruplarda tartışmaya katılma | "Bülten göndermemize izin verir misiniz?" tipi ilk temas (rıza istemek de reklamdır) |
| **Karşı taraf yazdıktan sonra** yanıt | Sales Navigator + kişiselleştirilmiş sequence |
| LinkedIn'in ücretli reklam envanteri (Ads / Lead Gen Form) | Liste bazlı toplu bağlantı isteği |

Kaynaklar: [OLG Hamm aktarımı](https://www.it-recht-kanzlei.de/elektronische-werbemails-linkedin-xing.html),
[§ 7 UWG](https://www.gesetze-im-internet.de/uwg_2004/__7.html)

**Boş bağlantı isteği (notsuz) gönderilebilir mi?** Metinsiz bağlantı isteği reklam içermez; ama isteğe
tanıtım notu eklendiği anda § 7 kapsamına girer. Pratik kural: **bağlantı isteğine hiç not yazma**,
ya da hiç istek gönderme — ilişkiyi yorumdan kur, karşı taraf istek göndersin.

---

## 7. Ölçüm

### 7.1 Haftalık bakılacak beş metrik

Pazartesi 10 dakika. Sayıları bir tabloya yaz; **trend** okunur, tek hafta okunmaz.

| # | Metrik | Nerede | Hedef yönü | Neden bu |
|---|---|---|---|---|
| M1 | **Members reached** (KP, haftalık toplam) | Profil → Analytics → Post impressions | Artan | Tekil kişi sayar. **Impressions bunun yerine geçmez** — impressions her gösterimi (aynı kişiyi tekrar) sayar; ikisinin farkı tekrar görüntülenmedir ve bu olumlu sinyaldir |
| M2 | **Gönderi başına yorum sayısı** (beğeni değil) | Gönderi altı | ≥3 / gönderi | Yorum ve alt-yorum erişimi taşıyan sinyal; beğeni ucuz |
| M3 | **Search appearances + profil görüntülenme** (KP) | Profil → Analytics | Artan | Headline A/B kararını (§3.1) veren metrik |
| M4 | **Sayfa takipçi net artışı + custom button tıklaması** | Sayfa admin → Analytics → Visitors | Takipçi +, tık >0 | Custom button tıklaması **tek gerçek attribution köprüsü** (§7.3) |
| M5 | **Site tarafında LinkedIn kaynaklı giriş** | §7.3'teki geçici çözüm | >0 ve artan | Kanalın işe yarayıp yaramadığının tek dış kanıtı |

**Başarı sayılmayanlar:** takipçi sayısı tek başına, impression tek başına, beğeni. Ve hiçbir metrik
**yayımlanmaz** — `/api/public/stats` bugün 3 mentor gösteriyor; `docs/landing-value-proposition.md` §4.3
"zayıf sayı gösterilmez" kuralı bu dokümanın çıktıları için de geçerli.

**Benchmark uyarısı:** 2026 ortalama engagement rate için kaynaklar %3,85 (kişisel) / %2,1 (sayfa) ile
%5,20 (platform ortalaması) arasında **çelişiyor**. Tek bir sayıya bağlanma; kendi 4 haftalık taban
çizgini çıkar ve ona göre oku.
[Kaynak](https://www.cleverly.co/blog/linkedin-impressions-vs-members-reached)

### 7.2 UTM şeması

LinkedIn paylaşılan veya sponsorlu URL'lerden UTM parametrelerini **silmiyor**. Kayıp asıl olarak iç içe
yönlendirme zincirlerinden geliyor (kendi kısaltıcını `lnkd.in`'in üstüne koymak) — **kendi kısaltıcını
kullanma**, tam URL'i yapıştır. Referrer kaybolsa bile UTM URL'in içinde taşındığı için hayatta kalır.
[Kaynak](https://gettrack.link/utm-parameters-for-linkedin) (üçüncü taraf)

Sabit şema — `utm_source` **her zaman** `linkedin`:

| `utm_medium` | Nerede kullanılır |
|---|---|
| `page` | Şirket sayfası custom button, sayfa Website URL |
| `profile` | Kişisel profil Featured, Contact info |
| `post` | Gönderi içi link (kural gereği **neredeyse hiç**; yalnız Article'da) |
| `company-post` | Sayfa gönderisi içindeki link |
| `newsletter` | LinkedIn newsletter içindeki link |
| `comment` | **Kullanılmaz** — yorumda link yok (§5.3) |

`utm_campaign` isimlendirmesi:

| Tür | Biçim | Örnek |
|---|---|---|
| Kalıcı yerleşim | `cta_button`, `featured_demo`, `featured_features`, `featured_pricing` | `utm_campaign=cta_button` |
| Gönderi | `w<hafta>_<piler>` | `w04_p1_pipeline`, `w06_p5_pricing` |
| Bülten | `nl_<yyyymm>` | `nl_202611` |

Kanonik örnekler (kopyala-yapıştır):

```
https://interncrm.com/for-companies?utm_source=linkedin&utm_medium=page&utm_campaign=cta_button
https://demo.interncrm.com/?utm_source=linkedin&utm_medium=profile&utm_campaign=featured_demo
https://interncrm.com/features?utm_source=linkedin&utm_medium=profile&utm_campaign=featured_features
https://interncrm.com/pricing?utm_source=linkedin&utm_medium=profile&utm_campaign=featured_pricing
```

**Yayın öncesi zincir testi:** URL'i tarayıcıda aç, adres çubuğunda `utm_` parametrelerinin **hâlâ orada**
olduğunu gör. Bir yönlendirme (www→apex, http→https, i18n) parametreleri düşürüyorsa önce o düzeltilir.

### 7.3 Bugün bunu ölçemiyoruz — ve geçici çözüm

**Gerçek:** `utm_*` yakalama yok (#1390), dönüşüm olayı yok (#1388). Analytics yalnız **sayfa
görüntülüyor**. Yani yukarıdaki UTM şemasını bugün uygulasan da site tarafında hiçbir yerde
`utm_source=linkedin` diye bir kayıt oluşmuyor. Bunu bilerek etiketliyoruz: etiketler **geriye dönük**
kazanılamaz, yakalama açıldığı gün tüm eski linkler zaten doğru etiketli olur.

**Geçici çözüm — kanal başına ayrı iniş sayfası.** Sayfa görüntüleme sayımı elimizde olduğuna göre,
her LinkedIn yerleşimine **farklı bir iniş yolu** ver; böylece UTM olmadan da ayrışırlar:

| Yerleşim | İniş yolu | Ayrışma mantığı |
|---|---|---|
| Sayfa custom button | `/for-companies` | Bu sayfaya başka kanaldan neredeyse hiç trafik gelmiyor |
| Profil Featured — demo | `demo.interncrm.com` | Ayrı alan adı, ayrı sayım |
| Profil Featured — katalog | `/features` | — |
| Profil Featured — fiyat | `/pricing` | ÖK3 sonrası; ayrıca en yüksek niyet sinyali |

**Haftalık elle çapraz okuma (10 dk):**
1. Sayfa admin → Analytics → Visitors: **custom button tıklaması** (n).
2. Site analytics: aynı hafta `/for-companies` görüntülenmesi (m).
3. `n` ile `m` arasındaki ilişki, kanalın gerçekten trafik getirip getirmediğinin proxy'sidir.
4. LinkedIn analytics'i **CSV olarak export et** ve sakla — LinkedIn geçmiş pencereyi sınırlıyor,
   kendi taban çizgin ancak biriktirdiğin veriyle oluşur.

**Bu çözüm attribution değil, işaret.** Gerçek ölçüm #1390 + #1388 ile gelir; ikisi tamamlanana kadar
LinkedIn hakkında "şu kadar dönüşüm getirdi" cümlesi kurulmaz.

---

## 8. Yapılmayacaklar

Her satırın somut riski var. Bunlar "dikkatli kullanılacak" şeyler değil, **hattan tamamen çıkarılmış**
şeyler — tek kişilik bir üründe tehlike miktar değil **kesintidir**.

| Yapılmayacak | Somut risk |
|---|---|
| **Otomasyon / scraping araçları** (Dux-Soup, PhantomBuster, Expandi, Waalaxy, Sales Navigator kazıma) | LinkedIn User Agreement, hesabı yazılım/bot/scraper ile kullanmayı açıkça yasaklıyor; yaptırım **kalıcı hesap kapatma**. Mehmet'in kişisel profili kanalın **birincil** varlığı — kaybı, sayfa kaybından ağır. [Kullanıcı sözleşmesi](https://www.linkedin.com/legal/user-agreement) |
| **Toplu bağlantı isteği botları** | Aynı yasak + yüksek "I don't know this person" oranı bağlantı gönderme yetkisini kısıtlıyor. Ayrıca isteğe tanıtım notu eklendiği anda § 7 UWG (OLG Hamm) devreye giriyor |
| **Satın alınan takipçi** | Etkileşim oranını çöktürür (payda büyür, pay büyümez) → algoritma sayfayı daha az dağıtır. Sahte takipçi temizliğinde bakiye geri gitmez. Ve **Verified badge** başvurusunun uygunluk incelemesini zora sokar |
| **Engagement pod** (karşılıklı beğeni grupları) | LinkedIn bunları tespit ediyor ve bastırıyor; sinyal sahte olduğu için gerçek kitleye ulaşım azalır. Ayrıca M2 (yorum sayısı) metriğini bozar — kendi ölçü aletini kırmış olursun |
| **InMail / DM spam'i, "izin isteyen" ilk temas maili** | OLG Hamm 18 U 154/22: DM = elektronische Post → § 7 UWG. Yaptırım para cezası değil **Abmahnung + Unterlassungserklärung + Vertragsstrafe** zinciri: Streitwert 3.000-6.000 EUR, avukat maliyeti ~308-1.000+ EUR, sonraki tek ihlalde klasik Vertragsstrafe **5.001 EUR**. İmzalanmış bir Unterlassungserklärung'dan sonra sistemin yanlışlıkla attığı **tek** mesaj dört haneli otomatik borç doğurur. [§ 7 UWG](https://www.gesetze-im-internet.de/uwg_2004/__7.html) |
| **Gövdeye veya ilk yoruma dış link** | Gövde: medyan erişim **-%18,8**. Yorum: dış linkli yorumlar **%80'e kadar** bastırılıyor, "bridge behavior" olarak tespit ediliyor. Yani ceza ödeyip karşılığında tık da alamıyorsun |
| **Anket gönderisi** | Format sıralamasının en altı (%0,07 — tek kaynak, doğrulanamadı). Hiçbir kaynak önermiyor. Zayıf performans hesabın dağıtım geçmişini de aşağı çeker |
| **Sayfa gönderisini kişisel profilden boş paylaşmak** | Kendi yorumu olmayan paylaşım erişim almıyor; üstelik kişisel profili sayfanın megafonuna çevirir (§4.2 Kural 3) |
| **Kullanıcı/müşteri sayısı yazmak veya ima etmek** | `/api/public/stats` bugün 3 mentor, 4 açık proje, 0 bekleyen aday. Zayıf sayı gösterilmez (`docs/landing-value-proposition.md` §4.3). Yuvarlamak, "büyüyen topluluk" demek de aynı yasağa girer |
| **"Çok kiracılı SaaS" vaadi** | `MT_ENFORCE_ISOLATION=false`. Karşılanamayan performans vaadi hem sözleşme ihlali hem **UWG § 5** (yanıltıcı ticari beyan) riski. Satılabilir olan: tek kiracılı kurulum / self-host / pilot |
| **`crm-demo.ersah.in` yazmak** | Eski adres; kodda hâlâ linkli ama ayrı PR ile düzeltiliyor. Tek geçerli demo adresi `https://demo.interncrm.com` |
| **Autoposter hattının insan onayını atlaması** | Kategorik yayın yasağı: LinkedIn'e doğrudan istek yok, Telegram onay butonlarına ajan basmaz. İhlal görülürse **hat durdurulur** (`go-to-market.md` R10) |

---

## 9. Uygulama sırası — ilk üç hafta

| Hafta | İş | Bitti kabul ölçüsü |
|---|---|---|
| H1 | Sayfayı bul, super admin ol, URL'i §0'a yaz | `LINKEDIN_PAGE_URL` dolu |
| H1 | ÖK1: `/impressum` gerçek verilerle (#1371) | Placeholder yok |
| H1 | §1 denetim tablosunu baştan sona uygula | 15 satırın ≥13'ü yeşil |
| H1 | Kişisel profil: headline (§3.1), About (§3.2), Featured 3 öğe (§3.3), Contact info Impressum | Profil "All-star" |
| H2 | ÖK2: ≥3 ürün ekran görüntüsü (#1399); banner + logo export | Asset klasörü dolu |
| H2 | Vanity URL, hashtag'ler, Website URL = Impressum, custom button + UTM | §1 tablosu tam yeşil |
| H2 | Karşılıklı bağ (§2.6): footer linki, README rozeti, GitHub topics + homepage | 3 PR merge |
| H2 | Invite to follow: aylık kredinin tamamını kullan | Kredi bakiyesi 0 |
| H3 | Gönderi #1 (KP, EN) ve #2 (SP, EN) — §5.1 | 60 dk penceresi uygulandı |
| H3 | M1-M5 taban çizgisi ölçümü (§7.1) | Tablo ilk satırı dolu |

**Yayın yok kuralı:** H1-H2 kurulum haftalarıdır, gönderi yayınlanmaz
(`content-calendar.md` Faz 0 ile uyumlu). Boş bir sayfaya trafik göndermek, en pahalı ilk izlenimi
en zayıf hâliyle harcamaktır.

---

## 10. Kaynak güvenilirliği notu

Bu dokümandaki dış iddiaların üç sınıfı var; karar verirken sınıfı da oku:

- **Resmî (LinkedIn Help / Microsoft Learn / Gesetze-im-Internet):** görsel ölçüleri, custom button
  seçenekleri, hashtag limiti, Products uygunluğu, API scope'ları, § 5 DDG ve § 7 UWG metinleri.
  Bunlara güven.
- **Doğrulanmış üçüncü taraf (birden çok bağımsız kaynak aynı yönde):** kişisel profil ≫ sayfa erişim
  farkı, "link in comments" ölümü, doküman/carousel üstünlüğü, 1.300-2.000 karakter bandı, ilk 60 dakika.
  Yöne güven, katsayıya güvenme.
- **Çelişkili / doğrulanamayan:** banner ölçüsünde blog vs resmî (resmîyi al), About karakter sınırı
  (1.500 altı kal), haftalık frekans (Buffer ↔ van der Blom), en iyi saat (sabah ↔ akşam), dış link
  cezasının büyüklüğü (%18,8 ↔ %60), engagement benchmark'ları, Invite to follow kredi sayısı,
  anket %0,07. Bunların hiçbiri üzerine strateji kurulmaz; 4-6 haftalık kendi verinle karar ver.
