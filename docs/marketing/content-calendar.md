# İçerik takvimi — InternCRM dağıtım katmanı (12 hafta)

> **Durum:** uygulama planı, 2026-09-06. Bu doküman **dağıtım** katmanını tarifler: ne zaman, hangi
> kanala, hangi dilde, hangi metin. **On-site** katman (SEO, meta, ölçüm, dönüşüm) epic **#1360**
> kapsamındadır ve burada tekrar edilmez — sadece ön koşul olarak referans verilir.
>
> **Hafta numaraları görelidir.** Hafta 1 = bu planın onaylandığı ilk tam hafta. Doküman 2026-09-06'da
> yazıldığı için hafta 1–12 kabaca **Eylül başı – Kasım sonu** penceresine düşer; §5'teki sezon tablosu
> bu hizalamaya göre kurulmuştur. Plan başka bir tarihte başlarsa §5 yeniden hizalanmalıdır.
>
> Satır genişliği ~100 karakter; **tablolar bu kuralın dışındadır** (hücreler tek başına uygulanabilir
> olsun diye uzun tutuldu).

---

## 0. Bu takvimin dayandığı sert kısıtlar

Bunlar tercih değil, kısıt. Takvimin her satırı bunlara uyar.

| # | Kısıt | Kaynak / kanıt | Takvimdeki sonucu |
|---|---|---|---|
| K1 | Haftada **~2–3 saat** pazarlama kapasitesi, tek kişi | Bakımcının beyanı | §1 bütçesi; haftada 3 gönderiyi geçme yasağı |
| K2 | **Sayı gösterme kuralı**: zayıf sayı gösterilmez, uydurulmaz, ima edilmez | `docs/landing-value-proposition.md` §4.3 (satır 277-278) | Hiçbir metinde kullanıcı/müşteri/mentor sayısı yok. `/api/public/stats` bugün 3 mentor, 4 açık proje, 0 bekleyen aday |
| K3 | **Çok kiracılı izolasyon KAPALI** (`MT_ENFORCE_ISOLATION=false`) | `docs/tenant-isolation.md` | Hiçbir metinde "çok kiracılı SaaS", "hemen kaydol kullan" vaadi yok. Satılan: tek kiracılı kurulum / self-host / pilot |
| K4 | **Fikri hak sahibi Mehmet Erşahin (gerçek kişi)**, bcsit GmbH değil | `CLAUDE.md` § Licensing & IP, `docs/legal/legal-tax-framework.md` | Hiçbir metinde, hiçbir profilde şirket hak sahibi gösterilmez. LinkedIn sayfası adı ürün adı ("InternCRM") |
| K5 | **Kategorik yayın yasağı** (autoposter hattı) | `it-meme-content` skill kuralları | Ajan LinkedIn'e doğrudan istek atmaz, Telegram onay butonlarına basmaz. Her gönderi insan onayından geçer |
| K6 | Metni **HAT yazar**, fikir besleyen taraf metin yazmaz | Aynı skill | Pazartesi brief'i fikir + kanıt + asset üretir, hazır post metni üretmez (§3.1 istisnası: kanal metni önceden onaylanmış şablonlar) |
| K7 | Dış link **ne gövdede ne ilk yorumda** | van der Blom 2026 (medyan erişim −%18,8); yorumdaki linkler %80'e kadar bastırılıyor | Her LinkedIn gönderisi native yazılır; link profil "website" alanı + sayfa custom button'da durur |
| K8 | **utm_\* yakalama ve dönüşüm olayı YOK** | #1388, #1390 | Hafta 1–6 başarı ölçüleri utm'siz ölçülebilir şeylere bağlanır (GitHub Traffic, LinkedIn members reached) |
| K9 | Tek kullanımlık kozlar (Show HN, Product Hunt) hazırlıksız ateşlenmez | HN: başarısız gönderim ~1 yıl tekrar edilemez. PH: yeniden lansman 6 ay kilitli | Show HN hafta 6'dan önce yok; Product Hunt 12 hafta içinde **yok** |

---

## 1. Ritim kuralı — 2-3 saatlik haftaya sığan takvim

### 1.1 Neden araştırmanın önerdiği ritimden daha az yayınlıyoruz

LinkedIn araştırması kişisel profil için haftada 3, şirket sayfası için haftada 2 gönderi öneriyor
(toplam 5). Aynı araştırma **ilk 60 dakika kuralını** da veriyor: yayından sonraki 60 dakika boyunca
yorumlara yanıt verecek durumda değilsen o gönderiyi yayınlama. Bu iki kural birlikte haftada 5 gönderi
için ~5 saat ister. Kapasite 2-3 saat.

**Karar:** gönderi sayısını değil, **izleme penceresi gerektiren gönderi sayısını** kısıyoruz.

- **Şirket sayfası gönderileri izleme penceresi almaz.** Feed dağıtımının ~%5'i sayfalara gidiyor; o
  saatin karşılığı yok. Sayfa bir **vitrin ve arşiv** katmanıdır: gelen kişi "bu ürün yaşıyor mu"
  sorusuna cevap arar, orada tartışma aramaz.
- **Kişisel profilde haftada en fazla 2 "ana" gönderi** — ikisi de izleme penceresiyle.
- **Üçüncü gönderi opsiyoneldir** ve düşük bahislidir (kısa build-in-public notu). Kapasite kalmadıysa
  atlanır ve bu bir başarısızlık değildir.

### 1.2 Haftalık zaman bütçesi (hedef: ≤150 dakika)

| İş | Süre | Ne zaman | Kim |
|---|---|---|---|
| Pazartesi brief üretimi (§3.1) — ajan çalıştırır, insan 3 fikirden 2'sini seçer | 20 dk | Pazartesi | Ajan + Mehmet |
| Haftanın asset'i (ekran görüntüsü / carousel PDF / kod bloğu görseli) | 20 dk | Salı | Mehmet |
| Ana gönderi #1 — hat yazar, Telegram'da onay, yayın | 10 dk | Çarşamba | Hat + Mehmet |
| Ana gönderi #1 — ilk 60 dk erişilebilirlik penceresi (fiili iş 10-20 dk) | 20 dk | Çarşamba | Mehmet |
| Ana gönderi #2 — onay + yayın | 10 dk | Perşembe **veya** Cuma | Hat + Mehmet |
| Ana gönderi #2 — ilk 60 dk penceresi | 20 dk | Aynı gün | Mehmet |
| Şirket sayfası gönderisi (elle — sayfa API'si partner-gated) | 15 dk | Cuma | Mehmet |
| Haftanın tek kanal işi (dizin kaydı, PR, outreach maili) | 30 dk | Değişken | Mehmet |
| **Toplam** | **≈145 dk** | | |

Opsiyonel 3. gönderi bütçeye **dahil değil**. Kapasite artarsa eklenir, azalırsa ilk düşen odur.

### 1.3 Kanal / dil / format matrisi

| Kanal | Sıklık | Gün + saat | Dil kuralı | Format |
|---|---|---|---|---|
| **Kişisel profil** (birincil kanal) | 2 ana + 0-1 opsiyonel / hafta | Çarşamba ve Perşembe/Cuma, **yerel 15:00-20:00** (Berlin) | Faza göre tek dil (§2). **Bir gönderi = tek dil**, karışık yazılmaz | 1.300-2.000 karakter, hook ilk **140** karaktere sığar (mobil kesme), 0-1 hashtag, link yok |
| **Şirket sayfası** (`InternCRM`) | 1 / hafta | Cuma | Kişisel gönderiyle aynı dil, **yeniden yazılmış** — repost değil | Sürüm notu / özellik kartı / demo daveti. Custom button: "Visit website" |
| **GitHub deposu** | Sürekli | — | EN | Topics, homepage, README, Release notları. Kanal değil ama **her kanalın iniş noktası** |
| **Awesome listeleri** | Tek seferlik | Hafta 4 (recruitment/hrtech), hafta 4+16 (selfhosted) | EN | PR |
| **Yazılım dizinleri** (Capterra.de, GetApp, OMR, SoftwareAdvice) | Tek seferlik | Hafta 5-6 | DE + EN profil | Satıcı profili |
| **Show HN** | Tek seferlik | Hafta 6 **karar noktası** | EN | Başlık + demo linki + ilk yorumda bağlam |
| **Doğrudan outreach** (Forum Mentoring e.V., digital-affin.de, Webrazzi) | Haftada ≤2 mail | Salı | Muhataba göre DE/TR/EN | E-posta |
| **Product Hunt** | **12 hafta içinde YOK** | — | — | K9 gereği ertelendi |

### 1.4 Format dönüşümü (haftalık)

Araştırma format sıralaması net: native döküman/carousel (PDF) > native görsel > text-only; anket
pratikte ölü. Haftalık dönüşüm:

- **Çarşamba (ana #1):** metin + **ürün ekran görüntüsü**. Ekran görüntüsü zorunlu — landing'de tek
  görsel olmaması (#1399) zaten bir eksiklik; içerikte aynı hatayı tekrarlamıyoruz.
- **Perşembe/Cuma (ana #2):** **döküman/carousel PDF** (8-12 slayt, slayt başına tek fikir, <60 kelime,
  1080×1350) — ayda 2 hafta; diğer 2 hafta uzun metin (1.800+ karakter, dwell time için).
- **Opsiyonel 3.:** kısa build-in-public notu, görselsiz, 400-800 karakter.

### 1.5 Dil stratejisi ve faz sırası

Bir gönderi tek dilde yazılır. Faz sırası dili belirler:

| Faz | Hafta | Birincil dil | Neden |
|---|---|---|---|
| Vitrin hazırlığı | 1-2 | — (yayın yok) | Kanallar kurulur, ilk iz atılır |
| Open source + build-in-public | 3-6 | **EN** | GitHub / HN / awesome kitlesi İngilizce; site zaten İngilizce (lokalize rota yok — #1360 ön koşulu bu fazı bloklamaz) |
| Persona B (yerleştirme yapan kurumlar) | 5-10 | **DE** | Praktikantenamt, dual-study koordinatörü, Forum Mentoring e.V. üyeleri |
| Persona A (100-1000 çalışanlı işverenler) | 8-12 | **DE**, hafta 11-12'den itibaren **+TR** | DE/AT/CH işveren; TR işveren tarafı staj sezonu öncesi ısıtılır |

Fazlar üst üste biner (5-6 ve 8-10 çakışma haftaları): çakışma haftasında iki ana gönderi **iki farklı
fazın** dilinde yazılır, aynı gün değil farklı günlerde yayınlanır.

---

## 2. 12 haftalık takvim

Kısaltmalar: **KP** = kişisel profil · **SP** = şirket sayfası · **ÖK** = ön koşul.
"Yayın yok" haftalarında LinkedIn gönderisi atılmaz; iş **altyapıdır**.

### Faz 0 — Vitrin hazırlığı (hafta 1-2, yayın YOK)

| Hafta | Tema | Ana içerik (kanal + dil) | Destek işler | Gereken asset | ÖK issue | Başarı ölçüsü |
|---|---|---|---|---|---|---|
| **1** | Ürünü bulunabilir yap | **Yayın yok.** GitHub deposunu vitrine çevir: `topics` ekle (`mentoring`, `internship`, `crm`, `self-hosted`, `open-source-alternative`, `nextjs`, `prisma`, `gdpr`), `homepage` alanına `https://interncrm.com`, description'ı "Mentor-Mentee CRM & Internship Management System" → mentee→staj→işe alım hunisini içeren bir cümleyle güncelle | **İlk git tag + GitHub Release** (`v0.156.22-beta` veya sonrası). Bu haftanın en önemli işi: awesome-selfhosted'ın 4 aylık sayacı CHANGELOG'dan değil bir **Release**'in varlığından başlıyor — bugün depoda 0 tag, 0 release var. Release gövdesi `CHANGELOG.md` + `/release-notes` üzerinden üretilir | Yok (metinsel iş) | Yok — **issue aç**: "GitHub Release + repo vitrini" | Depoda ≥1 Release görünür; topics sayfalarında (`github.com/topics/mentoring`) depo listeleniyor; GitHub Insights → Traffic'te referrer kaydı başlıyor |
| **2** | Kanalları aç, hukuki kapıyı kapat | **Yayın yok.** LinkedIn şirket sayfası "InternCRM" adıyla açılır (desktop/iOS — Android desteklemiyor). Zorunlu alanlar: industry (B2B software), company size, overview, description, logo, website URL. Bu üçü (industry + size + overview) dolmadan **"Invite to follow" kullanılamaz** — sıfır takipçiden çıkışın tek organik aracı odur | `/impressum` doldurulur (**yayın öncesi sert blokaj**: § 5 DDG, ticari LinkedIn varlığı impressum yükümlüsü). Kişisel profil headline + banner. SP custom button "Visit website" → `interncrm.com/?utm_source=linkedin&utm_medium=page&utm_campaign=cta_button`. 3 hashtag: `#Praktikum #DualesStudium #Mentoring`. Autoposter'da **InternCRM hattı** kurulur (BCSIT hattından ayrı: farklı kitle, farklı ses, farklı kategoriler; Telegram onay adımı korunur) | Logo 400×400 PNG (açık **ve** koyu zeminde okunur — `src/app/icon.svg` türevi, opak zemin veya kontrast kenarlık), cover 1512×256 (sol-alt köşe logoya bırakılır) | **#1371** (impressum — sert blokaj) | Sayfa "complete" rozetini alır (LinkedIn: tam sayfalar haftalık ~%30 daha çok görüntüleme); "Invite to follow" açık; autoposter InternCRM hattı Telegram'a ilk önizlemeyi düşürüyor |

### Faz 1 — Open source + build-in-public (hafta 3-6, dil: EN)

| Hafta | Tema | Ana içerik (kanal + dil) | Destek gönderiler | Gereken asset | ÖK issue | Başarı ölçüsü |
|---|---|---|---|---|---|---|
| **3** | "Neden AGPL" | **KP / EN, metin+görsel (Çar):** Bir mentorluk CRM'ini neden AGPL-3.0-or-later ile açtık — kategoride 16 rakibin 13'ü her alıcıyı demo görüşmesine sokarken kaynak kodu göstermenin ne anlama geldiği. Kanıt: `LICENSE`, `docs/legal/licensing-strategy.md` | **KP / EN, uzun metin (Per):** "88 Prisma modeli ne işe yarar" — veri modelinin turu, `prisma/schema.prisma` üzerinden. **SP / EN (Cum):** depo linki + Release duyurusu | Depo README ekran görüntüsü; `prisma/schema.prisma` pipeline enum'unun sözdizimi renklendirilmiş kod görseli | Yok | GitHub Traffic'te LinkedIn referrer'ı görünür; depo yıldızı ≥1 artış; KP members reached temel çizgisi kurulur (bu ilk gerçek ölçüm haftası) |
| **4** | Self-host edilebilirlik | **KP / EN, carousel PDF (Per):** "Bir mentorluk CRM'ini kendi sunucunda çalıştırmak" — 8-12 slayt: Docker imajı, MySQL, `prisma db push`, env değişkenleri, sağlık kontrolü | **KP / EN, kısa (Çar):** haftanın merge'lenen sürüm fragmanından tek bir teknik detay. **SP / EN (Cum):** `/source` sayfasına davet | Carousel PDF (1080×1350), `docker-compose` örneği kod görseli | Yok — **issue aç**: "üretim için self-host yolu (`docs/self-hosting.md` + üretim compose)". Repoda bugün sadece `docker-compose.dev.yml` var ve kendi başlık yorumu "NOT used in production or CI" diyor | **awesome-recruitment** ve **awesome-hrtech** PR'ları açılır (her biri 15 dk **zaman kutusu**, takip yatırımı yok, 8 hafta içinde merge gelmezse kanal kapanır). Ölçü: PR açıldı + carousel'in dwell time'ı text-only temel çizgisinin üstünde |
| **5** | Kırık huni (P1 açılışı) | **KP / EN, metin+görsel (Çar):** "13 aşamalı bir huni neden bir elektronik tabloda tutulamaz" — `src/lib/pipeline.ts`'teki 11 on-path + 2 off-path aşama, `nextOnPathStatus`'un neden ham diziyi indeksleyemediği (devam eden stajı "yarım bıraktı"ya göndermesi) | **KP / EN, kısa (Per):** aşama SLA'sı — `prisma/schema.prisma` `StageSla` (satır 186), takvim günü / iş günü tercihi. **SP / EN (Cum):** `/features` kartı | Pipeline ekran görüntüsü (demo verisinden — **gerçek veri asla**, `docs/DATA_ACCESS_POLICY.md`), `ON_PATH_STATUSES` kod görseli | **#1399** (ürün ekran görüntüsü seti) | Demo'da `/admin` pipeline sayfası görüntülemeleri; GitHub Traffic'te "unique visitors" haftalık artış; Persona B kanal işine paralel: **Capterra.de + GetApp + OMR Reviews + SoftwareAdvice satıcı profilleri açılır** |
| **6** | Yazılabilir demo + **Show HN karar noktası** | **KP / EN, uzun metin (Çar):** "Demo'yu yazılabilir bırakmak" — her düğmesi 403 dönen bir demo hiçbir şey göstermez; `src/lib/demoMode.ts` `DEMO_BLOCKED_WRITES` (satır 55) yalnızca üç kategoriyi reddediyor: hesap ele geçirme/kilitleme, demo dışına erişim, keyfi dosya depolama. Reset bir **operasyonel iş**, HTTP endpoint'i değil — `prisma/reset-demo.mjs` adı `_demo` ile bitmeyen bir veritabanına dokunmayı reddediyor ve `infra/test/reset-demo-guard.test.sh` bunu CI'da doğruluyor | **KP / EN, kısa (Per):** demo daveti (link gövdede değil — profil website alanında). **SP / EN (Cum):** `docs/DEMO.md` özeti | Demo'da üç rolün ekran görüntüsü (admin/mentor/mentee) | **Show HN ön koşulları:** (a) demo'da **tek tıkla rol girişi** — issue aç; bugün `/demo` kimlikleri tabloda gösterip elle yazdırıyor, HN kuralı tam bunu hedefliyor ("without barriers such as signups or emails"); (b) **#1362/#1376/#1378** OG/Twitter kartı — paylaşılan her link bugün önizlemesiz gri kutu | **KARAR:** iki ön koşul da kapandıysa Show HN hafta 6 sonunda ateşlenir (EN, Mehmet'in kendi hesabı, tek gönderim, sonrasında saatlerce yorumda). Kapanmadıysa **ertelenir** — K9. Ölçü: ön sayfa değil; depo yıldızı, demo'da rol bazlı oturum, `/features` + `/trust` görüntülemeleri |

### Faz 2 — Persona B: yerleştirme yapan kurumlar (hafta 5-10, dil: DE)

| Hafta | Tema | Ana içerik (kanal + dil) | Destek gönderiler | Gereken asset | ÖK issue | Başarı ölçüsü |
|---|---|---|---|---|---|---|
| **7** | Praktikumsverwaltung | **KP / DE, carousel PDF (Çar):** "Was ein Praktikantenamt eigentlich in Excel verwaltet" — bir Praktikantenamt'ın elektronik tabloda tuttuğu 13 sütun, ve her birinin üründeki karşılığı. Bu, SEO araştırmasının **en zayıf rakipli** terimi: ilk 5'te tek bir gerçek ürün pazarlama sayfası yok | **KP / DE, kısa (Per):** çıkış nedeni taksonomisi — bir stajın neden yarım kaldığını kaydetmezsen ertesi yıl aynı hatayı yaparsın. **SP / DE (Cum):** `/for-companies`'e davet | Pipeline carousel'inin **Almancası** (aynı ekran, `?lang=de` çerezi ile), 8-12 slayt | **#1360** (lokalize rota + hreflang) — **not:** LinkedIn gönderisi bu blokaja tabi **değil** (gönderi native, siteye link yok); blokaj yalnızca `/de/praktikumsverwaltung` iniş sayfasını erteler | KP DE gönderisinde members reached; Almanca yorum sayısı (dil sinyalinin tuttuğunun kanıtı); **Forum Mentoring e.V.** (`https://forum-mentoring.de/`, ~120 üye, tam Persona B) üyelik/etkinlik takvimi incelenir ve ilk temas maili yazılır |
| **8** | Berichtsheft / haftalık rapor | **KP / DE, metin+görsel (Çar):** "Wochenbericht mit Freigabe — was ein Berichtsheft-Tool nicht abdeckt". Ürün kanıtı: `prisma/schema.prisma` `WeeklyReport` (satır 2711) — `summary`, `hoursSpent`, `blockers`, `status`, `mentorComment`, `reviewedById`, `reviewedAt`; `@@unique([relationId, weekStart])` haftada tek rapor garantisi; `WeeklyReportReminder` teslimat idempotency'si. **HUKUKİ SINIR:** BBiG anlamında IHK'ya kabul ettirilebilir bir *Ausbildungsnachweis* olduğu **iddia edilmez** — "Berichtsheft-benzeri haftalık rapor onayı" denir | **KP / DE, kısa (Per):** onay akışının kendisi — raporu bir işe alım hunisine bağlamak, ücretsiz Berichtsheft araçlarının yapmadığı tek şey. **SP / DE (Cum):** `/weekly-reports` özellik kartı | Haftalık rapor + mentor onayı ekran görüntüsü (demo verisi), `WeeklyReport` şema kesiti | Yok | **digital-affin.de**'nin "Top 10+ digitales Berichtsheft" listesine editöryel temas maili gönderilir (SERP'te kendin sıralanmak yerine sıralanan sayfanın içinde ol). Ölçü: mail gönderildi + yanıt; DE gönderinin kaydetme (save) sayısı |
| **9** | DSGVO = kod görünür + kendi sunucun | **KP / DE, uzun metin (Çar):** "DSGVO-konform, weil du es selbst hostest" — bir vaat ile bir kanıt arasındaki fark. Ürün kanıtı: `/trust` sayfası, `docs/pii-access-lifecycle.md`, `docs/security-audit-playbook.md`, AGPL deposu. **K3 UYARISI:** bu gönderide çok kiracılı SaaS vaadi **yok**; satılan tek kiracılı kurulum / self-host / pilot | **KP / DE, kısa (Per):** rol × endpoint erişim matrisi (`docs/role-access-matrix.md`) — güvenliği anlatmanın en sıkıcı ve en ikna edici yolu. **SP / DE (Cum):** `/trust` daveti | `/trust` sayfası ekran görüntüsü, rol matrisi tablosu görseli | Yok | Persona B'de ilk **nitelikli konuşma** (bir kurumdan gelen soru/demo talebi) hedefi bu hafta açılır. Ölçü: 1+ doğrudan mesaj veya mail |
| **10** | Fiyat gizleme (P5 açılışı) | **KP / DE, carousel PDF (Çar):** "16 Anbieter, 3 Preise" — `docs/research/competitive-analysis-2026-08.md` bulgusu: incelenen 16 satıcının yalnızca 3'ü kullanılabilir rakam yayımlıyor, 13'ü her alıcıyı demo görüşmesine sokuyor, 7'sinde ne ücretsiz sürüm ne deneme var. Kategorinin giriş noktası ~5.000-10.000 USD/yıl | **KP / DE, kısa (Per):** "mentor ve mentee tarafı sonsuza kadar ücretsiz — parayı yetenek arayan taraf öder" iş modeli cümlesi. **SP / DE (Cum):** `/pricing` yayındaysa ona davet, değilse `/features` | Fiyat karşılaştırma carousel'i (rakip adları **verilir**, rakamlar yalnızca yayımlanmış olanlar için) | **#1403** (`/pricing` sayfası). **Yayında değilse** bu gönderi yine atılır ama CTA `/features`'a gider — fiyat sayfası olmayan bir "fiyat şeffaflığı" gönderisi ikiyüzlü olur, o yüzden metinde planlanan fiyatlar (Community €0 / Program €149 / Program Plus €399 / Enterprise €749, birim: **aylık aktif eşleşmiş çift**) açıkça "planlanan, henüz yayında değil" diye yazılır | En yüksek etkileşim beklenen hafta (kategorinin en çok şikâyet edilen davranışı). Ölçü: yorum sayısı; #1403'ün önceliğinin yükselmesi |

### Faz 3 — Persona A: 100-1000 çalışanlı işverenler (hafta 8-12, dil: DE, hafta 11-12'den +TR)

| Hafta | Tema | Ana içerik (kanal + dil) | Destek gönderiler | Gereken asset | ÖK issue | Başarı ölçüsü |
|---|---|---|---|---|---|---|
| **11** | Zanaat kanıtı + TR açılışı | **KP / EN, uzun metin (Çar):** "Üç dilli bir ürünü CI'da dürüst tutmanın maliyeti" — `src/i18n/dictionaries.ts` 12.859 satır, EN/TR/DE anahtar paritesi `npm run check:i18n` ile CI'da zorunlu; parite kırılırsa build kırılır. Neden bu bir pazarlama iddiası değil, bir mühendislik kararı | **KP / TR, kısa (Per) — TR açılışı:** "Staj sürecini yöneten bir CRM'i açık kaynak yaptık" — KVKK + kendi sunucunda çalıştırma ekseni; TR mentorluk SERP'inde bu eksen tamamen boş. **SP / DE (Cum):** sürüm notu | i18n CI çıktısının ekran görüntüsü, `check:i18n` başarısız çalıştırmasının log görseli | Yok | TR gönderisinde ilk TR etkileşimi; **Webrazzi** ve **webhakim** liste içeriklerine editöryel temas maili. Ölçü: TR gönderide ≥1 nitelikli yorum |
| **12** | Stajyerlerin yazdığı ürün (P3 kapanışı) + 12 hafta geri bakışı | **KP / DE, metin+görsel (Çar):** "Dieses CRM haben die Praktikanten selbst geschrieben" — mentee'ler mentorluk anlaşması kapsamında koda katkı veriyor, ürün aynı zamanda staj projesi. Satış argümanı: adayın kalitesini ürünün kendisi kanıtlıyor. **Doğrulanabilir** — okuyucu depoyu açıp commit'lere bakabilir. Bu, hiçbir rakibin yazamayacağı tek gönderi | **KP / TR, metin (Per):** aynı hikâyenin TR versiyonu (çeviri değil, TR kitlesi için yeniden yazılmış). **SP / DE (Cum):** 12 haftanın sürüm özeti | Commit grafiği ekran görüntüsü, `/projects` ve `/stories` sayfaları | Yok | **Aylık geri bakış #3 = 12 hafta değerlendirmesi** (§3.2). Karar çıktıları: hangi pilerler devam eder, Show HN atıldıysa sonucu, Product Hunt hafta 13+ için hazır mı, awesome-selfhosted sayacı ne zaman doluyor |

### Faz sonrası (hafta 13+, bu takvimin dışında ama şimdi planlanır)

| Ne zaman | İş | Neden burada |
|---|---|---|
| Hafta ~18-20 | **awesome-selfhosted PR'ı** (`software/interncrm.yml`, ilk tag `Human Resources Management (HRM)`) | Hafta 1'de atılan Release'ten **4 ay sonra**. Kategori bugün 3 kayıtlı ve ince; AGPL-3.0 kabul ediliyor (MintHCM emsali). **Ön koşul:** üretim self-host yolu (hafta 4'te açılan issue) — "working installation instructions" kriteri. **AJAN UYARISI:** o repo CONTRIBUTING'i "Machine/LLM-generated contributions ... will result in a ban" diyor; PR elle doğrulanmadan gönderilmez |
| Hafta 13+ (koşullu) | **Product Hunt** self-hunt | K9 + ön koşullar: #1388/#1390 ölçüm, #1403 `/pricing`, #1399 görsel, #1362/#1376/#1378 OG, ve **200+ kişilik organik ön ilgi** (upvote istemek kategorik yasak, sonradan telafi edilemez) |
| Hafta 6+ | LinkedIn **Newsletter** — sayfa 150 takipçiyi geçince | Bülten feed algoritmasını atlayıp push + e-posta ile gidiyor. Kişisel profilden bugün de açılabilir; sayfa bülteni 150 takipçi sonrası |

---

## 3. Tekrarlayan ritim

### 3.1 Pazartesi brief'i (haftada 20 dk)

Ajan çalıştırır, insan seçer. **Brief metin yazmaz** (K6) — fikir, kanıt ve asset ihtiyacı üretir; metni
autoposter hattı yazar, Telegram'da onaylanır.

Brief'in girdileri:

| Girdi | Nereden | Ne çıkarılır |
|---|---|---|
| Geçen hafta merge olan sürüm fragmanları | `releases/unreleased/*.json` ve merge sonrası `CHANGELOG.md` | Her fragmanın `changelog` alanı bir teknik gönderi fikri, `notes` alanı bir kullanıcıya dönük gönderi fikri |
| `/release-notes` sayfasının diff'i | `src/lib/releaseNotes.ts` | Kullanıcıya dönük dilin hazır hâli — EN/TR/DE üçü de mevcut, çeviri işi yok |
| Kapanan issue'lar | GitHub | "Neden böyle yaptık" tipi gönderi fikirleri (en yüksek dwell time'lı tür) |
| Ürün yüzeyi değişikliği | `src/lib/features.ts` diff'i | Yeni özellik kartı → SP gönderisi + `/features` daveti |
| Geçen haftanın metrikleri | LinkedIn analytics, GitHub Traffic | Hangi pilerin tuttuğu; §4'te pilerlerin sırasını değiştirir |

Brief'in çıktısı **tam olarak şu**: 3 gönderi fikri (her biri: pilere, faza, dile, formata ve **kanıt
dosya yoluna** bağlı) + 1 asset ihtiyacı + 1 kanal işi. İnsan 3'ten 2'sini seçer. Seçilmeyen fikir
çöpe gitmez — bir sonraki haftanın havuzuna düşer.

**Sürüm notları içeriğin hammaddesidir ve bu tesadüf değil:** her PR zaten bir fragman yazıyor (CLAUDE.md
versiyonlama checklist'i). Yani içerik hattının hammaddesi, ürün geliştirme sürecinin zaten ürettiği bir
yan üründür. Ayrı bir "içerik fikri bulma" işi yoktur — olsaydı 2-3 saatlik bütçe tutmazdı.

### 3.2 Aylık geri bakış (hafta 4, 8, 12 — her biri 45 dk)

Ayın son gönderisinden sonra, tek oturumda:

| Soru | Veri kaynağı | Karar |
|---|---|---|
| Hangi pilerler tuttu? | LinkedIn members reached + kaydetme sayısı, gönderi başına | Tutmayan piler bir sonraki ayda **sıklığını yarıya indirir**, iki ay üst üste tutmazsa **kapanır** |
| Depo hareket ediyor mu? | GitHub Insights → Traffic (unique visitors, referrers), yıldız/fork | LinkedIn referrer'ı yoksa link stratejisi (profil website alanı) çalışmıyor demektir → SP custom button'a ağırlık ver |
| Kanal işleri sonuç verdi mi? | Açılan PR'lar, gönderilen outreach mailleri, dizin profilleri | 8 hafta yanıtsız kanal **kapanır** (awesome-recruitment kuralı §2 hafta 4) |
| Kapasite tuttu mu? | Fiili harcanan saat | Tutmadıysa **gönderi sayısı düşer**, kalite düşmez. Bu sırayı tersine çevirme |
| Yayınlamama kuralı işledi mi? | §6 tetiklendi mi, kaç kez | Sık tetikleniyorsa sorun içerikte değil üründe; takvim durur, ürün onarılır |

Geri bakışın çıktısı bu dokümana **işlenir** (takvim canlı bir dokümandır). Ayrıca
`docs/agent-experience.md`'e dated bir satır düşer — CLAUDE.md'nin end-of-session retrospektif kuralı.

### 3.3 Sürüm notu → içerik dönüşüm kuralı

| Fragman tipi | İçerik karşılığı | Kanal | Dil |
|---|---|---|---|
| `bump: minor` + `notes` dolu (kullanıcıya dönük özellik) | Ekran görüntülü KP gönderisi + SP özellik kartı | KP + SP | Faz dili |
| `bump: minor`, `notes` yok (iç mimari) | Uzun metin "neden böyle yaptık" — en yüksek dwell time'lı tür | KP | EN |
| `bump: patch` (düzeltme) | Kısa build-in-public notu (opsiyonel 3. gönderi) | KP | EN |
| Fragman yok (docs/CI) | İçerik yok. Zorlama | — | — |

**Sayı gösterme kuralı burada da geçerlidir (K2):** "N. sürüm", "X özellik", "Y kullanıcı" gibi ifadeler
yalnızca sayı gerçekten güçlüyse kullanılır. `0.156.22-beta` bir sürüm numarası olarak güçlü değil —
"beta" etiketi dürüsttür ve saklanmaz, ama gönderinin başlığı olmaz.

---

## 4. İçerik pilerleri

Yedi piler. Her biri en az 5 somut gönderi fikri taşıyor. Her fikir bir **kanıt dosya yoluna** bağlı —
kanıtı olmayan fikir yazılmaz.

### P1 — Kırık huni (13 aşama, SLA, çıkış nedeni)

Ürün kanıtı: `src/lib/pipeline.ts`, `prisma/schema.prisma` (`PipelineStatus`, `StageSla` satır 186,
`PipelineStage`), `docs/pipeline-stages.md`.

| # | Fikir | Format | Dil | Kanıt |
|---|---|---|---|---|
| 1.1 | "13 aşama neden bir elektronik tabloda tutulamaz" — 11 on-path + 2 off-path, ve off-path'in neden ayrı bir liste olduğu | Metin + ekran görüntüsü | EN/DE | `src/lib/pipeline.ts` `ON_PATH_STATUSES` |
| 1.2 | "Bir dizide bir sonraki aşamaya geçmek neden bug üretir" — ham `PIPELINE_STATUSES` indekslendiğinde devam eden staj "yarım bıraktı"ya, işe alınmış mentee "başka yerde buldu"ya gider | Kod görseli + metin | EN | `nextOnPathStatus` yorumu, aynı dosya |
| 1.3 | "Aşama SLA'sı takvim günü mü iş günü mü" — `StageSla.days` kararının arkasındaki tartışma | Kısa metin | EN | `src/lib/stageSla.ts` satır 10 yorumu |
| 1.4 | "Çıkış nedeni taksonomisi" — bir stajın neden bittiğini kaydetmezsen ertesi yıl aynı hatayı yaparsın | Carousel | DE | Pipeline off-path aşamaları |
| 1.5 | "Pasif ilk temaslar" — 14 gün yanıt vermeyen adayı kuyruktan düşürmek, **en fazla iki** hatırlatma maili, otomatik aşama değişikliği **yok** | Uzun metin | EN/DE | `src/lib/dormantFirstContact.ts`, `docs/dormant-first-contacts.md` |
| 1.6 | "Rakiplerin hiçbiri bu huniyi modellemiyor" — mentorluk satıcıları gelişimde durur, deneyimsel öğrenme pazaryerleri projede durur | Carousel | DE | `docs/research/competitive-analysis-2026-08.md` |

### P2 — Berichtsheft / haftalık staj raporu

Ürün kanıtı: `prisma/schema.prisma` `WeeklyReport` (satır 2711), `WeeklyReportReminder` (2737),
`src/app/weekly-reports/`.

**Sabit hukuki sınır:** BBiG anlamında IHK'ya kabul ettirilebilir bir *Ausbildungsnachweis* olduğu
iddia edilmez. Odalar (IHK/HWK/ZDH) kendi formatlarını dayatıyor ve bunu doğrulayan kaynağımız yok.
Kullanılan ifade: "Berichtsheft-benzeri haftalık rapor **onay akışı**".

| # | Fikir | Format | Dil | Kanıt |
|---|---|---|---|---|
| 2.1 | "Wochenbericht mit Freigabe" — rapor + mentor yorumu + onay damgası, tek akış | Metin + ekran görüntüsü | DE | `WeeklyReport.status`, `mentorComment`, `reviewedAt` |
| 2.2 | "Haftada bir rapor, veritabanı seviyesinde garanti" — `@@unique([relationId, weekStart])` | Kod görseli | EN | Şema satır 2730 |
| 2.3 | "Hatırlatma nasıl iki kere gitmez" — idempotency işaretçisi rapor içeriği taşımaz | Kısa metin | EN | `WeeklyReportReminder` yorumu (satır 2736) |
| 2.4 | "Ücretsiz Berichtsheft araçlarının yapmadığı tek şey" — raporu bir işe alım hunisine bağlamak | Carousel | DE | P1 + P2 birleşimi |
| 2.5 | "`blockers` alanı neden zorunlu değil ama en değerli alan" — mentorun haftalık müdahale sinyali | Kısa metin | DE | `WeeklyReport.blockers` |
| 2.6 | "Yazdırılabilir haftalık rapor" — `/weekly-reports/print`, çünkü bazı kurumlar hâlâ ıslak imza istiyor | Ekran görüntüsü | DE | `src/app/weekly-reports/print/` |

### P3 — Stajyerlerin yazdığı ürün (kopyalanamaz hikâye)

Ürün kanıtı: deponun commit geçmişi, `/projects`, `/stories`, `CONTRIBUTING.md` § Contributor terms.

Bu pilerin gücü **doğrulanabilir olmasında**: okuyucu depoyu açıp bakabilir. Bu yüzden hiçbir cümlesi
abartılmaz — abartılırsa aynı doğrulanabilirlik aleyhe döner.

| # | Fikir | Format | Dil | Kanıt |
|---|---|---|---|---|
| 3.1 | "Bu CRM'i içindeki stajyerler yazdı" — mentorluk anlaşması kapsamında koda katkı, ürün aynı zamanda staj projesi | Metin + commit grafiği | DE/TR | Depo commit geçmişi |
| 3.2 | "Bir stajyerin ilk PR'ı nasıl merge olur" — PR şablonu, contributor terms, CI kapısı | Carousel | EN | `CONTRIBUTING.md`, `.github/` |
| 3.3 | "Adayın kalitesini ürünün kendisi kanıtlıyor" — CV yerine kod | Kısa metin | DE | `/projects`, `/stories` |
| 3.4 | "Mentorun imzası ne demek" — kanıt zinciri: firma güveni ← mentor imzası ← mentee'nin işi | Uzun metin | DE | `docs/landing-value-proposition.md` §2 |
| 3.5 | "Kör puanlamalı mülakat paneli" — bir scorecard yalnızca gönderildiğinde sayılır ve panelin geri kalanına görünür olur; gönderilmemiş puan kimseyi etkilemez | Metin + ekran görüntüsü | EN/DE | `prisma/schema.prisma` `Evaluation.submittedAt` yorumu (~satır 1911) |
| 3.6 | "Bir değerlendirmeyi düzeltmek ile bir kaydı güncellemek farklı şeylerdir" — `correctedAt` neden `@updatedAt` değil | Kod görseli | EN | Aynı model, `correctedAt` yorumu |

### P4 — Açık kaynak CRM'i self-host etmek

Ürün kanıtı: `LICENSE` (AGPL-3.0-or-later), `docs/legal/licensing-strategy.md`, `Dockerfile`,
`/source`, `/trust`, `docs/tenant-isolation.md`.

**K3 sınırı:** self-host anlatılırken çok kiracılı SaaS vaadi verilmez.

| # | Fikir | Format | Dil | Kanıt |
|---|---|---|---|---|
| 4.1 | "Neden AGPL, neden çift lisans" | Uzun metin | EN | `docs/legal/licensing-strategy.md` |
| 4.2 | "Bir mentorluk CRM'ini kendi sunucunda çalıştırmak" — imaj, MySQL, `db push`, env, health check | Carousel | EN/DE | `Dockerfile`, `.env.example`, `/api/health` |
| 4.3 | "DSGVO-konform, weil du es selbst hostest" — vaat ile kanıt arasındaki fark | Uzun metin | DE | `/trust`, `docs/pii-access-lifecycle.md` |
| 4.4 | "KVKK uyumu için kodu görebilmek" — TR karşılığı, TR SERP'inde bu eksen boş | Metin | TR | Aynı |
| 4.5 | "Rol × endpoint erişim matrisi" — güvenliği anlatmanın en sıkıcı, en ikna edici yolu | Tablo görseli | EN/DE | `docs/role-access-matrix.md` |
| 4.6 | "Bir güvenlik denetimi nasıl yürütülür" — playbook'un kendisi açık | Metin | EN | `docs/security-audit-playbook.md` |

### P5 — Kategorinin fiyat gizlemesi

Ürün kanıtı: `docs/research/competitive-analysis-2026-08.md`.

| # | Fikir | Format | Dil | Kanıt |
|---|---|---|---|---|
| 5.1 | "16 Anbieter, 3 Preise" — 16 rakipten 3'ü kullanılabilir rakam yayımlıyor, 13'ü demo görüşmesine sokuyor | Carousel | DE | Rekabet analizi |
| 5.2 | "7 satıcıda ne ücretsiz sürüm ne deneme var" — kategoriye girmenin bedeli | Kısa metin | DE | Aynı |
| 5.3 | "Birim neden 'aylık aktif eşleşmiş çift'" — koltuk başına fiyatlama mentorluk programında neden yanlış sinyal verir | Uzun metin | DE/EN | Planlanan fiyat modeli, `docs/premium-model-calismasi.md` |
| 5.4 | "Mentor ve mentee tarafı sonsuza kadar ücretsiz — parayı yetenek arayan taraf öder" | Kısa metin | DE/TR | `docs/landing-value-proposition.md` §1 |
| 5.5 | "Bir demo görüşmesi olmadan ürünü denemek" — demo linki ve üç rol | Ekran görüntüsü | EN/DE | `https://demo.interncrm.com` |
| 5.6 | "Kategorinin giriş noktası ~5.000-10.000 USD/yıl" — 20 kişilik bir programın bunu neden ödeyemediği | Metin | DE | Rekabet analizi |

**Kural:** fiyat gönderilerinde planlanan rakamlar (Community €0 / Program €149 / Program Plus €399 /
Enterprise €749) yazılırsa **"planlanan, henüz yayında değil"** ibaresi zorunludur — `/pricing` bugün
yok (#1403).

### P6 — Üç dilli ürün geliştirmenin maliyeti

Ürün kanıtı: `src/i18n/dictionaries.ts` (12.859 satır), `npm run check:i18n`, CI parite kapısı,
`e2e/landing-i18n.spec.ts`.

| # | Fikir | Format | Dil | Kanıt |
|---|---|---|---|---|
| 6.1 | "Anahtar paritesini CI'da zorunlu tutmak" — parite kırılırsa build kırılır, çeviri sonraya kalmaz | Metin + log görseli | EN | `npm run check:i18n`, `ci.yml` |
| 6.2 | "12.859 satırlık bir sözlük dosyası nasıl yönetilir" | Kod görseli | EN | `src/i18n/dictionaries.ts` |
| 6.3 | "E2E testleri landing metinlerini birebir doğruluyor" — pazarlama metnini değiştirmek bir test değişikliğidir | Metin | EN | `e2e/landing-i18n.spec.ts` |
| 6.4 | "Neden EN/TR/DE, neden bu üçü" — pazarın kendisi (DE/AT/CH + TR) | Kısa metin | DE/TR | Persona tanımları |
| 6.5 | "Sürüm notlarını üç dilde yazmak" — `notes` alanı ya üçü ya hiçbiri | Kod görseli | EN | `releases/README.md` |
| 6.6 | "Bir dil eklemenin gerçek maliyeti" — sözlük değil, e2e + release notları + e-posta şablonları | Uzun metin | EN | `src/services/emailService.ts`, `docs/newsletter.md` |

### P7 — Demo'yu yazılabilir bırakmak (güven mühendisliği)

Ürün kanıtı: `docs/DEMO.md`, `src/lib/demoMode.ts` (`DEMO_BLOCKED_WRITES` satır 55),
`prisma/reset-demo.mjs`, `infra/test/reset-demo-guard.test.sh`, `.github/workflows/demo-reset.yml`.

Bu pilerin dağıtım değeri yüksek: HN'in "denenebilir bir şey" testini geçmemizin sebebi bu, ve
"her düğmesi 403 dönen demo" kategoride yaygın bir şikâyet.

| # | Fikir | Format | Dil | Kanıt |
|---|---|---|---|---|
| 7.1 | "Her düğmesi 403 dönen bir demo hiçbir şey göstermez" — yazma varsayılan olarak **açık** | Uzun metin | EN | `src/lib/demoMode.ts` satır 13-15 |
| 7.2 | "Neyi reddediyoruz ve neden" — üç kategori: hesap ele geçirme/kilitleme, demo dışına erişim, keyfi dosya depolama | Carousel | EN | `DEMO_BLOCKED_WRITES` |
| 7.3 | "Neden `/api/demo/reset` yok" — yıkıcı yol public internete açılmaz, sızacak bir reset secret'ı olmaz | Metin | EN | `docs/DEMO.md` |
| 7.4 | "Bir guard'ı env flag'e değil veritabanı adına bağlamak" — `_demo` ile bitmeyen bir DB'ye dokunmayı reddetmek, ve bunu CI'da gerçek prod/preview adlarıyla test etmek | Kod görseli | EN | `prisma/reset-demo.mjs`, `infra/test/reset-demo-guard.test.sh` |
| 7.5 | "Demo'da e-posta nasıl 'gönderilir'" — `SKIPPED` satırı yazılır, davet akışı tıklanabilir kalır, admin e-posta logu ne gideceğini gösterir | Metin + ekran görüntüsü | EN | `docs/DEMO.md` |
| 7.6 | "Günde iki kez sıfırlanan bir demo" — 02:00 ve 14:00 UTC | Kısa metin | EN | `.github/workflows/demo-reset.yml` |

### Piler rotasyonu

Faz dilini piler seçimi belirlemez; piler faza **hizmet eder**:

| Faz | Baskın pilerler | Destek |
|---|---|---|
| Hafta 3-6 (OSS/BIP, EN) | P4, P7, P6 | P1 |
| Hafta 5-10 (Persona B, DE) | P1, P2 | P4, P5 |
| Hafta 8-12 (Persona A, DE/TR) | P5, P3 | P1, P6 |

Aynı piler **üst üste iki hafta ana gönderi olamaz** — tekrar, van der Blom'un ölçtüğü içerik
yorgunluğu etkisini (−%45'e kadar) hızlandırır.

---

## 5. Sezonluk pencereler

> **Güven notu:** bu bölümün tamamı **varsayımdır**. Elimizde InternCRM'e özgü sezon verisi yok
> (K8: ölçüm altyapısı yok). Aşağıdaki takvim, Almanya'daki Ausbildung/Praktikum ve üniversite dönem
> yapısına ve Türkiye'deki zorunlu staj sezonuna ilişkin **genel bilgiden mantıkla türetildi**.
> İlk ölçüm dönemi (hafta 4/8/12 geri bakışları) bu varsayımları ya doğrular ya çöpe atar. Bir
> gönderiyi bu tablo yüzünden ertelemek yerine, tabloyu gönderinin sonucuna göre düzeltin.

### 5.1 Almanya (DE/AT/CH) — varsayım

| Pencere | Kabaca ne zaman | Kimin acısı yüksek | Hangi mesaj karşılık bulur | Bu takvimdeki hafta |
|---|---|---|---|---|
| **Ausbildung başvuru sezonunun ortası** | Sonbahar — bir sonraki Ağustos/Eylül'de başlayacak Ausbildungsjahr için başvurular bu dönemde toplanır | Ausbildungsleiter, Praktikantenamt: elinde yüzlerce başvuru, elektronik tabloda takip | **P1 kırık huni**, aşama SLA'sı, çıkış nedeni | 5, 7 |
| **Wintersemester başlangıcı** (Ekim) | Ekim başı | Üniversite kariyer merkezleri, dual-study koordinatörleri: yeni kohort, yeni eşleştirme dalgası | **P1 + P4** (DSGVO/self-host — kamu kurumunda satın alma tetikleyicisi) | 7, 9 |
| **Berichtsheft yorgunluğu** | Dönem içi, ilk 6-8 haftadan sonra | Ausbilder: haftalık raporlar birikti, kimse onaylamadı | **P2 Berichtsheft** | 8 |
| **Bütçe planlama dönemi** | Sonbahar sonu — bir sonraki yılın bütçesi yapılır | Program sorumlusu: satıcı fiyatı bulamıyor, bütçe kalemi yazamıyor | **P5 fiyat gizleme** — yılın en iyi zamanlaması | 10 |
| **Yıl sonu sessizliği** | Aralık ortasından itibaren | — | Yayın durur; bu takvim hafta 12'de bittiği için çakışma yok. Hafta 13+ planlanırken hesaba katılmalı | — |

**Varsayımın en riskli parçası:** bütçe penceresi. Doğruysa hafta 10 (P5) yılın en yüksek getirili
haftası; yanlışsa sadece ortalama bir hafta olur. Kaybetme riski düşük, kazanma potansiyeli yüksek —
bu yüzden P5 hafta 10'a konuldu.

### 5.2 Türkiye — varsayım

| Pencere | Kabaca ne zaman | Kimin acısı yüksek | Hangi mesaj karşılık bulur | Bu takvimdeki hafta |
|---|---|---|---|---|
| **Yaz stajı planlaması** | Kış sonu / ilkbahar başı — yaz stajı başvuruları | İşveren İK: staj kontenjanı, başvuru yığını | **P1 + P5** (TR) | Bu takvimin **dışında** (hafta 20+) |
| **Zorunlu staj sezonu** | Yaz | Üniversite staj birimi | Bizim hedefimiz **değil** — stajsistemi.com'un MÜDEK/YÖKAK ve OBS entegrasyonu bizde yok, vaat edilmez | — |
| **TR açılış penceresi** | Bu takvimde hafta 11-12 | TR işveren ve yerleştirme yapan kurum | **P3** (stajyerlerin yazdığı ürün) + **P4** (KVKK/açık kaynak) — ikisi de sezondan bağımsız, kimlik kurma gönderileri | 11, 12 |

**TR stratejisinin özeti:** hafta 11-12'de sezon avlamıyoruz, **kimlik kuruyoruz**. TR staj sezonu bu
takvimin ilerisinde; oraya sıfır izle girmemek için TR varlığı şimdi açılır.

### 5.3 Sezondan bağımsız pilerler

P3 (stajyerlerin yazdığı ürün), P4 (self-host), P6 (üç dillilik), P7 (yazılabilir demo) **her hafta**
yayınlanabilir. Sezon tablosu yalnızca P1, P2 ve P5'in yerleşimini etkiler. Bir sezon penceresi
kaçarsa sezondan bağımsız bir piler devreye alınır — takvim boş kalmaz, ama zorlama da yapılmaz.

---

## 6. Yayınlamama kuralları

Bu kurallar **tetiklendiği anda** o haftanın planı iptal olur. Tartışılmaz, "ama içerik hazırdı" diye
esnetilmez. Bir gönderiyi kaçırmanın maliyeti bir haftadır; kırık bir ürünü tanıtmanın maliyeti kanaldır.

| # | Tetikleyici | Nasıl anlaşılır | Ne yapılır | Ne zaman geri dönülür |
|---|---|---|---|---|
| **Y1** | **Demo çöktü veya bozuk** | `https://demo.interncrm.com` açılmıyor, giriş çalışmıyor, ya da reset workflow'u kırmızı | Tüm gönderiler durur. Demo linki taşıyan hiçbir şey yayınlanmaz — HN/awesome/dizin başvuruları dahil | Demo üç rolde de elle doğrulandıktan sonra |
| **Y2** | **Prod sağlıksız** | `https://interncrm.com/api/health` `ok` dönmüyor, ya da deploy kırmızı | Yayın durur | Health yeşil + bir sonraki başarılı deploy |
| **Y3** | **Smoke suite kırmızı ve sebebi bilinmiyor** | `@smoke` PR gate'i kırmızı, bilinen flake'lerden (`account-self-service.spec.ts:52`, `sign-out-all.spec.ts:24`) değil | Ürün gönderisi yayınlanmaz. Sezondan bağımsız, ürüne referans vermeyen bir gönderi (ör. P6 6.1) yayınlanabilir | Kök neden bulunup düzeltildikten sonra |
| **Y4** | **Sayı zayıf** | Gönderi bir sayı içeriyor ve o sayı bugün zayıf (`/api/public/stats`: 3 mentor, 4 açık proje, 0 bekleyen aday) | **Sayı çıkarılır, gönderi kalır.** Sayıyı güçlendirmek için beklenmez, uydurulmaz, ima edilmez, "yüzlerce" gibi belirsizleştirilmez (K2, `docs/landing-value-proposition.md` §4.3) | Sayı gerçekten güçlendiğinde |
| **Y5** | **Vaat ürünü aşıyor** | Metinde çok kiracılı SaaS, self-servis kaydol-kullan, IHK-geçerli Ausbildungsnachweis, MÜDEK/YÖKAK raporlama, OBS/BİLSİS entegrasyonu geçiyor | Gönderi **yeniden yazılır** — bunların hiçbiri bugün yok (K3 ve §2 hafta 8 notu). Yayınlanmaz | Özellik gerçekten shipping olduğunda (fragman + `src/lib/features.ts` kaydı ile) |
| **Y6** | **İlk 60 dakika müsait değil** | Yayın saatinden sonraki 60 dk boyunca yorumlara erişilebilir olunmayacak | **O gönderi yayınlanmaz**, ertesi güne veya haftaya kayar. İlk saatte ölen gönderi toparlanmıyor; boşa harcanmış bir fikirdir | Müsait bir gün |
| **Y7** | **Hukuki kapı açık** | `/impressum` eksik (#1371) veya iletişim/veri sorumlusu hâlâ "operatör tarafından doldurulacak" | Ticari LinkedIn varlığı **yayına açılmaz** (§ 5 DDG, Abmahnung riski) | Impressum tamamlandığında |
| **Y8** | **Metin gerçeği doğrulanmadı** | Gönderi bir dış kural/limit/ölçü iddia ediyor ama URL yok, ya da bir ürün iddiası var ama dosya yolu yok | Gönderi durur, kanıt bulunur veya iddia çıkarılır | Kanıt eklendiğinde |
| **Y9** | **Gerçek veri sızma riski** | Ekran görüntüsü preview/prod ortamından alınmış | Görsel çöpe. Tüm görseller **demo veya lokal sentetik veriden** alınır (`docs/DATA_ACCESS_POLICY.md`) | Yeni görsel demo'dan alındığında |
| **Y10** | **Kapasite yok** | Hafta 2-3 saatlik bütçeyi karşılamıyor (yoğun sprint, tatil, ürün krizi) | **Sıklık düşer, kalite düşmez.** Sırayla düşen: opsiyonel 3. gönderi → SP gönderisi → ana #2. Ana #1 en son düşer | Kapasite döndüğünde. Kaçırılan hafta telafi edilmez, üst üste yayın yapılmaz |

### Y-kurallarının tek istisnası yoktur

Özellikle şu üç durumda esnetme baskısı gelecektir ve gelmesi normaldir:

- "Show HN penceresi kaçıyor" → kaçsın. HN'de başarısız bir gönderim ~1 yıl tekrar edilemez; kırık bir
  demoyla atılan Show HN, kozun kendisini yakar.
- "Carousel hazır, atmasak yazık" → hazır asset bir gerekçe değil. Asset bir sonraki hafta da hazır.
- "Sadece bir sayı, kimse kontrol etmez" → depo public, demo public, `/api/public/stats` public.
  Kontrol edilir.

---

## 7. Bu takvimin ölçüldüğü yer

Hafta 1-6 için ölçüm, utm olmadan yapılabilecek şeylerle sınırlıdır (K8):

| Metrik | Nereden | Hangi haftadan itibaren |
|---|---|---|
| Depo unique visitors + referrers | GitHub Insights → Traffic | Hafta 1 |
| Yıldız / fork | GitHub | Hafta 1 |
| LinkedIn **members reached** (impressions değil — impressions tekrar sayar) | LinkedIn analytics | Hafta 3 |
| Gönderi başına kaydetme (save) | LinkedIn analytics | Hafta 3 |
| SP custom button tıklamaları | LinkedIn Visitor analytics | Hafta 3 |
| Demo'da rol bazlı oturum | Demo DB / erişim logu (elle sorgu) | Hafta 3 |
| `utm_source=linkedin` oturumu, dönüşüm olayı | **#1388 / #1390 kapandıktan sonra** | Hafta ? |

**Hafta 12 hedefleri** (araştırmadan devralındı, K2'ye uygun — hiçbiri dışarıya iddia olarak yazılmaz):
kişisel profil takipçi +300 · `utm_source=linkedin` ile 200+ oturum (ölçüm hazırsa) ·
demo.interncrm.com'da 25+ demo girişi · 5+ nitelikli mentor/işveren konuşması.

**Takipçi sayısı ve impression tek başına başarı sayılmaz.** Bu takvimin tek gerçek başarı ölçüsü,
hafta 12 sonunda ürünle ilgili **konuşmaya girmiş nitelikli insan sayısıdır**.
