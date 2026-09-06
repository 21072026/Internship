# InternCRM — Dağıtım (Go-to-Market) Planı

> Durum: taslak (2026-09-06)

Tarih: 2026-09-06 · Sürüm referansı: **`npm run check:release-fragments` çıktısının son satırı**
(bugün 0.156.21-beta + 4 bekleyen fragman → **0.156.25-beta**) · Sahibi: Mehmet Erşahin (gerçek kişi)
Takvim: göreli (hafta 1..12), sabit tarih yok.

---

## 1. Amaç ve kapsam

Bu doküman **dağıtım katmanını** tarif eder: ürünü hangi kanaldan, kime, hangi dilde, hangi ön koşulla
duyuracağımız ve neyi kategorik olarak yapmayacağımız.

| Kapsam İÇİ (bu doküman) | Kapsam DIŞI (başka yerde) |
|---|---|
| Kanal seçimi, sıralama, faz kapıları | On-site SEO, metadata, hreflang, OG kartları → **epic #1360** |
| Kanal başına gönderim kuralı ve etik sınır | Fiyat sayfasının kendisi → **#1403** |
| Almanya hukuku: soğuk temas neyin mümkün | Ürün ekran görüntüleri → **#1399** |
| Ölçüm KPI'ları ve ölçülebilirlik durumu | Dönüşüm olayı + utm yakalama → **#1388 / #1390** |
| Riskler, durdurma kuralları | Landing metni → `docs/landing-value-proposition.md` |

Konumlandırmanın kanıt tabanı: `docs/research/competitive-analysis-2026-08.md` (16 rakip).
Bu doküman #1360'ı **tekrar etmez**, ona **bağımlıdır**: aşağıdaki tabloların "ön koşul" sütunu
çoğu yerde #1360 kalemlerine işaret eder.

---

## 2. Bugünkü durum — kanıtlı tablo

| Konu | Bugünkü gerçek | Kanıt |
|---|---|---|
| Web'de iz | Ürün adıyla arama sonucu yok, hiçbir dizinde kayıt yok | Araştırma taraması, 2026-09-06 |
| Ürün canlı mı | Evet, https://interncrm.com (`/api/health` ok) | canlı |
| Public demo | Evet, https://demo.interncrm.com — 3 rol, sentetik veri, `robots.txt: Disallow: /` | canlı |
| Demo kimlikleri | `admin.demo@…`, `mentor.aylin@…`, `mentee.deniz@…` / `DemoPass123!` | https://demo.interncrm.com/demo |
| Eski demo adresi | `crm-demo.ersah.in` — kodda kalmıştı, #2216/PR #2218 ile düzeltildi (canlıda `0.158.0-beta`) | dokümanlarda **kullanılmaz** |
| Metadata | Tüm sayfalar tek İngilizce title/description paylaşıyor | `src/app/layout.tsx:19-21` |
| OG/Twitter kartı | Pazarlama sayfalarında **yok** (yalnız `/p/[userId]` var) | #1362 #1376 #1378 |
| Dil ve URL | Dil **sadece çerezle** seçiliyor; `/de`, `/tr` rotası yok, hreflang yok | `src/i18n/server.ts`, `src/app/sitemap.ts` |
| Fiyat sayfası | **Yok** | #1403 |
| Ekran görüntüsü | Landing'de **tek bir ürün ekranı yok** | #1399 |
| Impressum | İletişim/veri sorumlusu hâlâ "operatör tarafından doldurulacak" | #1371 kapsamı |
| Ölçüm | Dönüşüm olayı ve `utm_*` yakalama yok; analytics yalnız sayfa görüntülüyor | #1388 #1390 |
| Public sayılar | 3 mentor, 4 açık proje, 0 bekleyen aday | `/api/public/stats` |
| Çok kiracılılık | `MT_ENFORCE_ISOLATION=false` → çok kiracılı SaaS **satılamaz** | `docs/tenant-isolation.md` |
| GitHub vitrini | 2 yıldız, 4 fork, 643 açık issue, **topics boş**, **homepage boş**, Discussions açık | github.com/21072026/Internship |
| GitHub release | **Sıfır release, sıfır tag** (`list_releases` → `[]`, `list_tags` → `[]`) | API, 2026-09-06 |
| Self-host yolu | Üretim compose'u yok; `docker-compose.dev.yml` başlığı "NOT used in production" | repo kökü, `docs/` (32 dosya, `self-hosting.md` yok) |
| Ürün yüzeyi | **46 kayıtlı özellik, 92 Prisma modeli**, EN/TR/DE tam sözlük, **389 dosyalık** Playwright paketi, k6, PWA, `/trust`, `/release-notes` | Doğrulanmış sayı tablosu: `copy-bank.md` §0.1 (tek kaynak). Komutlar: `grep -c '^model ' prisma/schema.prisma` → 92 · `ls e2e \| wc -l` → 389 · `src/lib/features.ts` → 46 |

**Bu tablonun okunuşu:** ürün hazır, vitrin hazır değil. Dağıtımın ilk işi kanal açmak değil,
kanalın gönderdiği trafiğin çarpacağı yüzeyi düzeltmektir.

---

## 3. Konumlandırma

### 3.1 Kama (wedge) — tek paragraf

Kategori standardı: 16 rakibin **13'ü** her alıcıyı demo görüşmesine sokuyor, sadece 3'ü kullanılabilir
fiyat yayımlıyor, 7'sinde ne ücretsiz sürüm ne deneme var; giriş noktası ~5.000-10.000 USD/yıl.
Bizim kamamız: **yayımlanmış EUR fiyat + self-servis + mentor/mentee'ye sonsuza kadar ücretsiz çekirdek +
AGPL self-host + mentee→staj→işe alım hunisi** (13 aşama, aşama SLA'sı, çıkış nedeni taksonomisi),
Berichtsheft benzeri **haftalık rapor onay akışı**, kör puanlamalı mülakat panelleri, teklif durum makinesi.
Mentorluk satıcıları "gelişimde" durur, deneyimsel öğrenme pazaryerleri "projede" durur; huniyi kimse modellemiyor.

### 3.2 Persona başına tek cümle (yayına hazır — fiyat yan cümlesi `/pricing` yayına girdikten sonra, #1403)

> **Ön koşul:** aşağıdaki Persona A cümlelerinde geçen "prices published in euro / veröffentlichten
> Preisen / fiyatı görüşmeye girmeden okursunuz" yan cümlesi, `/pricing` (#1403) yayına girene kadar
> **çıkarılır**; cümlenin geri kalanı ön koşulsuz kullanılabilir. `copy-bank.md` §11'in "blok tamamen
> çıkarılır" kuralının aynısı: yerine "fiyat için yazın" **yazılmaz**.

**Persona A — 100-1000 çalışanlı işverenin staj/graduate program sorumlusu (DE/AT/CH, TR)**

- **EN:** InternCRM follows every intern from first contact to signed offer in one 13-stage pipeline —
  with prices published in euro instead of a sales call, and source code you can host yourself.
- **DE:** InternCRM begleitet jede Praktikantin und jeden Praktikanten vom Erstkontakt bis zum
  unterschriebenen Vertrag in einer 13-stufigen Pipeline — mit veröffentlichten Preisen in Euro statt
  Verkaufsgespräch und mit Quellcode, den Sie selbst hosten können.
- **TR:** InternCRM her stajyeri ilk temastan imzalı teklife kadar 13 aşamalı tek bir hunide takip eder;
  fiyatı görüşmeye girmeden okursunuz, kaynağı kendi sunucunuzda çalıştırırsınız.

**Persona B — yerleştiren kurum (kariyer merkezi, dual-study koordinatörü, meslek eğitimi sağlayıcısı,
mentorluk programı yürüten dernek/vakıf)**

- **EN:** InternCRM replaces the spreadsheet behind your mentoring or placement programme with a system
  that logs every interaction, routes weekly student reports through approval, and shows per stage who is
  stuck and for how long.
- **DE:** InternCRM ersetzt die Tabelle hinter Ihrem Mentoring- oder Vermittlungsprogramm durch ein System,
  das jede Interaktion dokumentiert, Wochenberichte zur Freigabe führt und pro Stufe zeigt, wer wie lange
  feststeckt.
- **TR:** InternCRM mentorluk/yerleştirme programınızın arkasındaki elektronik tabloyu, her etkileşimi
  kaydeden, haftalık raporları onaydan geçiren ve hangi aşamada kimin ne kadardır takıldığını gösteren bir
  sisteme çevirir.

**Persona C — Persona B kanalından aday alan işveren**

- **EN:** The candidate arrives with the record attached: every interaction, every approved weekly report and
  every interview score already sits in the pipeline your placement partner runs.
- **DE:** Die Kandidatin kommt mit ihrer Historie: jede Interaktion, jeder freigegebene Wochenbericht und
  jede Interviewbewertung liegen bereits in der Pipeline Ihres Vermittlungspartners.
- **TR:** Aday geçmişiyle birlikte gelir: her etkileşim, onaylanmış her haftalık rapor ve her mülakat puanı
  zaten yerleştirme partnerinizin yürüttüğü hunide durur.

**Kopyalanamaz hikâye (her üç personada da anlatılır, abartılmadan):** bu CRM'i, içindeki stajyerler yazdı.
Mentee'ler mentorluk anlaşması kapsamında koda katkı veriyor; ürün aynı zamanda staj projesi. Doğrulanabilir:
commit geçmişi public. Satış cümlesi değil, olgudur — öyle sunulur.

### 3.3 Asla söylemeyeceğimiz şeyler

| Yasak ifade | Neden |
|---|---|
| "X şirket / Y kullanıcı bize güveniyor", herhangi bir kullanıcı-müşteri sayısı | Bugün 3 mentor, 4 proje, 0 aday. `docs/landing-value-proposition.md` §4.3: zayıf sayı gösterilmez |
| "Çok kiracılı SaaS", "kurumların verisi aynı kurulumda güvenle ayrışır" | `MT_ENFORCE_ISOLATION=false`. Karşılanamayan performans vaadi + UWG § 5 yanıltıcı beyan riski |
| "SOC 2 / ISO 27001 sertifikalı / uyumlu" | Böyle bir denetim yok. Söylenebilir olan: `/trust` sayfasında yayımlanan güvenlik duruşu |
| "DSGVO/KVKK sertifikalı" | Sertifika yok. Söylenebilir: "kaynağı açık, kendi sunucunuzda çalıştırılabilir" |
| "BBiG anlamında Ausbildungsnachweis / IHK'ya kabul edilen Berichtsheft" | Doğrulanmadı; odalar kendi formatını dayatıyor. Denir: "haftalık rapor + onay akışı" |
| "MÜDEK/YÖKAK raporlaması", "BİLSİS/OBS entegrasyonu" | Yok. TR'de üniversite idaresine bu eksenden girilmez |
| Şirketi hak sahibi göstermek (bcsit GmbH vb.) | Hak sahibi Mehmet Erşahin, gerçek kişi. Faturalama tüzel kişiliği hâlâ açık (`docs/legal/legal-tax-framework.md`) |
| "Kurumsal düzeyde ölçeklenir", ölçüsüz büyüklük iddiaları | Yük profili k6 ile ölçülüyor; ölçülmemiş rakam verilmez |
| `crm-demo.ersah.in` | Eski adres. Tek demo adresi: https://demo.interncrm.com |
| **"DSGVO-konform" / "DSGVO-compliant" tek başına** (ör. "DSGVO-konform, weil Sie es selbst hosten") | Uyumu **operatör** kurar, ürün kurmaz: TOM, Verarbeitungsverzeichnis, silme süreleri, AVV. Kayıtsız şartsız uyum beyanı UWG § 5 riski. Denir: "Sie hosten selbst — die Verarbeitung bleibt in Ihrer Infrastruktur und in Ihrer Verantwortung" |
| "Barındırılan planlarımız var / hosted plans" | Bugün satılabilir bir barındırma teklifi **yok**, `/pricing` sayfası da yok (#1403). Denir: "self-host bugün ücretsiz; barındırılan plan planlanıyor, henüz yok" |

---

## 4. Dört fazlı plan

Fazlar **kapılıdır**: giriş koşulu sağlanmadan o fazın kanalları ateşlenmez. Tek kullanımlık kozlar
(Show HN, Product Hunt) erken harcanamaz.

**Faz → hafta → dil tablosu (tek kaynak).** Dört dokümanın tamamı bu tabloya atıf yapar; farklı bir
aralık gören her yer hatadır. Kaynak tablo `content-calendar.md` §2'nin gerçek haftalık tablosudur:

| Faz | Hafta | Birincil dil |
|---|---|---|
| Faz 0 — Vitrin | 1-2 | — (yayın yok) |
| Faz 1 — Açık kaynak & build-in-public | 3-6 | EN |
| Faz 2 — Persona B kurumları | 7-10 | DE |
| Faz 3 — Persona A işverenler | 11-12 | DE + TR (hafta 11 Çarşamba zanaat gönderisi bilinçli EN istisnası) |
| Faz sonrası | 13+ | duruma göre |

Fazlar **çakışmaz**; kurumsal ağ işleri (Faz 2) Faz 1 haftalarında da arka planda yürür, ama
*yayın dili* yukarıdaki tablodan okunur.

### Faz 0 — Vitrin (hafta 1-2)

Kanal açmadan önce, kanalın gönderdiği trafiğin çarpacağı yüzeyi düzeltmek.

- **Giriş koşulu:** yok, bugün başlar.
- **İşler:** (1) `git tag` + **GitHub Release** — 4 aylık awesome-selfhosted sayacını başlatır;
  (2) GitHub topics + homepage alanı + description + README konumlandırması;
  (3) `interncrm.com/imprint` gerçek verilerle (#1371) — Almanya'da kanal açmanın hukuki ön koşulu;
  (4) #1360'tan **minimum set**: sayfa başına title/description, OG/Twitter kartı, en az 3 ürün ekran
  görüntüsü (#1399); (5) `utm_*` yakalama + demo giriş/oturum dönüşüm olayı (#1388/#1390);
  (6) üretim self-host yolu (`docs/self-hosting.md` + üretim compose).
- **Çıkış ölçüsü:** bir GitHub Release yayımlandı; paylaşılan her URL önizlemeli geliyor; Impressum dolu;
  bir dış link tıklaması analytics'te utm ile görünüyor. `/pricing` (#1403) Faz 0 hedefidir ama çıkış
  koşulu değildir — yayında değilse yalnız fiyat iddiası içeren metinler bekler.

### Faz 1 — Açık kaynak & build-in-public (hafta 3-6, EN)

Ürünün en savunulabilir iddiası (AGPL + self-host + demo) üzerinden ilk izi bırakmak.

- **Giriş koşulu:** Faz 0'ın (1)(2)(4)(5) maddeleri bitti; self-host yolu yazıldı.
  `/pricing` (#1403) **fazın kapısı değildir**: yalnız **fiyat iddiası taşıyan** metinlerin ön koşuludur
  (`linkedin-playbook.md` ÖK3). Fiyat sayfası yokken fiyat cümlesi kurulmaz — kanal yine de açılır.
- **Kanallar:** GitHub vitrini, dizin kayıtları (Capterra.de/GetApp/OMR/SoftwareAdvice),
  awesome-recruitment + awesome-hrtech, **Show HN**, r/selfhosted, LinkedIn organik + InternCRM autoposter hattı.
- **Çıkış ölçüsü:** ürün adıyla arandığında kendi domain'imiz ilk sonuç; en az 3 dizin profili canlı;
  Show HN gönderildi ve yorumları yanıtlandı; demo'da rol bazlı oturum sayısı ölçülebilir hâlde ve sıfırdan farklı.

### Faz 2 — Persona B kurumları (hafta 7-10, DE — kurumsal temaslar Faz 1 boyunca arka planda hazırlanır)

Kurumsal ağlar yavaştır; erken başlatılır, geç meyve verir.

- **Giriş koşulu:** Impressum dolu, Almanca ekran görüntüleri hazır, demo'da DE arayüz gezilebilir.
  Fiyat konuşulan temaslarda (dizin profili, mektup, teklif) ek ön koşul: `/pricing` yayında (#1403).
- **Kanallar:** Forum Mentoring e.V., csnd (Career Service Netzwerk Deutschland), DGM, DHBW dualer Partner,
  IHK Praktikanten-/Lehrstellenbörse, fiziki mektup (Briefwerbung), etkinlik/oturum önerileri.
- **Çıkış ölçüsü:** 3 kurumdan yanıt; 2 tanıtım görüşmesi; 1 pilot niyeti veya 1 duale-Partner statüsü.

### Faz 3 — Persona A işverenler (hafta 11-12, DE + TR)

- **Giriş koşulu:** Faz 2'den en az bir referans anlatısı (pilot ya da kurumsal kullanım) ve
  ölçülebilir bir huni (utm → demo → pilot talebi).
- **Kanallar:** Product Hunt, DE SEO sayfaları (`/de/praktikumsverwaltung`, `/de/preise`),
  TR işveren sayfaları (`/tr/staj-yonetimi`, `/tr/fiyatlandirma`), IHK üzerinden işveren teması,
  double-opt-in bülten.
- **Çıkış ölçüsü:** ayda ≥5 nitelikli pilot talebi; ilk ücretli kurulum; CAC'ı olmayan kanalların
  (organik + topluluk) toplam talebe oranı ≥%60.

---

## 5. KANAL MATRİSİ

Emek: **S** ≤2 saat · **M** yarım–1 gün · **L** çok günlü / süregelen.
Getiri, bugünkü sıfır iz durumuna göre **göreli** yazılmıştır; mutlak sayı iddiası yok.

| # | Kanal | Persona | Dil | Emek | Beklenen getiri | Ön koşul | Faz | İlk adım |
|---|---|---|---|---|---|---|---|---|
| 1 | GitHub vitrini (topics, homepage, description, README) | A/B/C + geliştirici | EN | S | Yüksek — sıfır maliyetli ilk indekslenebilir iz | Yok | 0 | Repo Settings → About → topics: `mentoring`, `internship`, `crm`, `self-hosted`, `nextjs`, `prisma`, `gdpr`, `open-source-alternative`; homepage: https://interncrm.com |
| 2 | GitHub Release + git tag | — (ön koşul) | EN | S | Dolaylı ama kritik: awesome-selfhosted 4 ay sayacını başlatır | Yok | 0 | Tag, o an bekleyen fragmanların türettiği **en son** sürümle atılır (bugün `v0.156.25-beta`). Numarayı tag atmadan önce `npm run check:release-fragments` ile doğrula — çıktının son satırı canlı sürümdür. Ardından GitHub Release notu (`/release-notes` içeriğinden) |
| 3 | Üretim self-host yolu (`docs/self-hosting.md` + compose) | geliştirici/B | EN | M | Orta-yüksek; iki kanalın (awesome-selfhosted, r/selfhosted) kabul koşulu | Yok | 0 | Dockerfile + MySQL için tek komutluk üretim compose'u yaz, sıfırdan doğrula |
| 4 | Dizin kayıtları: Capterra.de, GetApp, OMR Reviews, SoftwareAdvice | A/B | EN+DE | M (dört profil ≈ iki yarım gün, **tek 30 dk kutusuna sığmaz**) | Yüksek — "web'de sıfır iz"i tek hamlede kıran en ucuz iş; kategori SERP'ini dizinler tutuyor | Impressum, ekran görüntüleri; **fiyat alanı doldurulacaksa** `/pricing` (#1403) | 1 | Hafta 5 ve 6'ya **ikişer** profil (R3: aynı anda en fazla 2 aktif kanal). Her birinde ücretsiz satıcı profili aç, aynı ekran görüntüsü setini yükle |
| 5 | Show HN | geliştirici → A/B'ye sıçrama | EN | M | En yüksek asimetrik getiri; tek kullanımlık | **Tek kalan ön koşul: OG kartları (#1362/#1376/#1378).** Demo'da tek tıkla rol girişi **zaten shipping** (`src/app/auth/signin/SignInClient.tsx:246`, `data-testid="demo-quick-login"`; `e2e/landing-demo-cta.spec.ts:37` test ediyor) | 1 | OG kartları bitince Mehmet kendi hesabından gönderir, saatlerce yorumda kalır |
| 6 | r/selfhosted | geliştirici | EN | S | Orta; self-host yolu yoksa negatif | Üretim compose + self-hosting dokümanı; **gönderim öncesi subreddit kurallarını oku** | 1 | Kural sayfasını oku, self-promo/gönderim gününe uy, demo + repo + compose linkiyle tek gönderi |
| 7 | awesome-recruitment (Sjamilla) | B | EN | S | Düşük — birkaç yüz görüntüleme + backlink | Yok | 1 | README'ye tek satır ekleyen PR; 15 dk zaman kutusu, takip yatırımı yok |
| 8 | awesome-hrtech (Talentbait) | B | EN | S | Düşük | Yok | 1 | Aynı: tek satır PR |
| 9 | LinkedIn organik (kişisel profil + şirket sayfası) | A/B | **EN (hafta 3-6) → DE (7-10) → DE+TR (11-12)** (§4 faz-dil tablosu) | L | Orta-yüksek, süregelen; DE'de tek yasal "outbound benzeri" görünürlük | **Sayfa Impressum linki hazır olmadan yayına açık kalmaz** — sayfa hâlihazırda açıksa (`linkedin-playbook.md` §0) hafta 1'de ya alan doldurulur ya sayfa yayından kaldırılır | 1→3 | Önce sayfanın var olup olmadığını doğrula (Me → Manage); sonra kişisel profilden başla, Info → Website URL = tam Impressum linki |
| 10 | InternCRM autoposter hattı (Telegram onaylı) | A/B | **EN (3-6) → DE (7-10) → DE+TR (11-12)**; 12 haftanın toplamı ~%60 DE / %25 EN / %15 TR (`autoposter-interncrm-line.md` §2.1) | M | Orta; içerik üretimini sürdürülebilir kılar | BCSIT hattından ayrı kategori/ses; kategorik yayın yasağına tabi | 1 | Yeni içerik kategorisi tanımla, fikir besle; metni HAT yazar, insan Telegram'da onaylar |
| 11 | awesome-selfhosted (HRM kategorisi) | B + geliştirici | EN | M | **Stratejik olarak en değerli liste**; HRM kategorisi ince (3 kayıt) | Release'ten **4 ay** + çalışan kurulum talimatı | Faz sonrası (hafta ~18) | Bugün değil: takvime "Release + 4 ay" notu; sonra `software/interncrm.yml` PR'ı |
| 12 | Forum Mentoring e.V. | B | DE | M | Yüksek nitelik: 120+ üniversitede program yürüten koordinatörler | DE ekran görüntüleri | 2 | AG/Jahrestagung takvimini izle; kalite standartları ↔ ekran eşleme tablosunu (1 sayfa DE) hazırla |
| 13 | csnd — Career Service Netzwerk Deutschland | B | DE | M | Yüksek: ~200 üye, Persona B'nin en yoğun havuzu | Impressum, `/pricing`, DE demo | 2 | Üye listesinden hedef listesi çıkar (**soğuk e-posta listesi değil**); Geschäftsstelle'ye oturum önerisi |
| 14 | DGM — Deutsche Gesellschaft für Mentoring | A/B | DE | M | Orta-yüksek; sertifikalı program listesi = adresli Persona B | Kendi mentorluk programının yazılı tanımı; sertifikasyon ücretli | 2 | Üyelik başvurusu; ardından kendi programını DGM standardına göre sertifikalandırmayı değerlendir |
| 15 | DHBW ve diğer duale Hochschulen — "Dualer Partner" | B + C | DE | L | Yüksek ama yavaş (~3 ay onay, kampüs başına ayrı) | Impressum, `/pricing`, ekran görüntüleri | 2 | Kampüs bazlı "Dualer Partner werden" formu; **iki ayrı hareket**: kendi stajyerleri için partner olmak ≠ ürünü tanıtmak |
| 16 | IHK Praktikanten-/Lehrstellenbörse + Ausbildungsberater | A + B | DE | M | Orta; ücretsiz ilan + oda ağına giriş | Impressum | 2 | ihk-boerse.de'de şirket profili + kendi staj ilanı; sonra yerel IHK Ausbildungsberater teması |
| 17 | Fiziki mektup (Briefwerbung) | A + B | DE | M | Orta ama **tek yasal soğuk outbound**; DE kurumsal alıcıda ayırt edici | Art. 14 DSGVO bilgi notu eki + bastırma listesi | 2 | 1 sayfa mektup + veri koruma notu + demo.interncrm.com QR; 20-30 adetlik ölçülü parti |
| 18 | Liste içeriğine ürün olarak girme (digital-affin.de) | A/B (DE) | DE | S | Orta; SERP'te kendin sıralanmak yerine sıralanan sayfada olmak | Ürün sayfası + ekran görüntüsü | 2 | "Top 10+ digitales Berichtsheft" yazısının editörüne ekleme talebi |
| 19 | Liste içeriğine girme (Webrazzi, webhakim — TR) | A/B (TR) | TR | S | Düşük-orta; TR'de kategori listelerini Mentornity çevrelemiş | TR ürün sayfası | 2 | Editöryel temas; ürün + demo + fiyat linki |
| 20 | Product Hunt (self-hunt) | A | EN | M | Orta; **6 ay kilit**, tek kullanımlık | Ölçüm (#1388/#1390), `/pricing`, ekran görüntüleri, OG, organik izleyici | 3 | Salı/Çarşamba 12:01 AM PT; Mehmet kişisel hesabından; upvote istemek **kategorik yasak** |
| 21 | DE SEO sayfaları (`/de/praktikumsverwaltung`, `/de/mentoring-software-open-source`, `/de/preise`, `/de/mentoring-hochschule`) | A/B | DE | L | Yüksek nitelik, düşük hacim; `Praktikumsverwaltung` SERP'i pazarlama amacıyla tutulmuyor | **Lokalize rota + per-page metadata + hreflang (#1360)** — bu olmadan yazılan sayfa İngilizce URL'de gömülür | 3 | #1360 bitince sayfa sayfa; her sayfada demo + fiyat + self-host kutusu |
| 22 | TR SEO sayfaları (`/tr/staj-yonetimi`, `/tr/acik-kaynak-mentorluk`, `/tr/fiyatlandirma`, `/tr/mentorluk-yazilimi`) | A/B | TR | L | Orta; ticari uzun kuyruk neredeyse boş, ana terimler öğrenci trafiği | Aynı #1360 ön koşulu | 3 | İşveren/kurum odaklı yaz; "öğrenciysen okulunun sistemi burada değil" yönlendirme satırı koy |
| 23 | Vaka/blog yazısı: "bu CRM'i içindeki stajyerler yazdı" | A/B/C | TR + DE + EN | M | Orta-yüksek; rakiplerin yazamayacağı tek içerik | Ekran görüntüleri (#1399) | 2-3 | Genel rehber yazma; kendi programını, 13 aşamayı, veri modelini anlat; `/projects`, `/stories`, `/release-notes`'a bağla |
| 24 | Double-opt-in bülten | A/B | DE + TR | M | Uzun vadeli; tek yasal e-posta kanalı | DOI kaydı: form+onay maili metni/sürümü, zaman+IP, opt-out | 3 | Mevcut altyapıyı kullan: `docs/newsletter.md`, `src/lib/newsletterTokens.ts`, `NewsletterSend` |
| 25 | Lobste.rs (`show` etiketi) | geliştirici | EN | M | Düşük-orta; davet gerekiyor, yeni kullanıcı kısıtları var | Davet + topluluk katılımı; self-promo < %25 | 3 | Zorlanmaz: önce sohbet odasında katılım, davet gelirse `show` ile tek gönderi |

### 5.1 Elenen kanallar — neden hayır

| Kanal / taktik | Neden hayır |
|---|---|
| awesome-oss-alternatives (Runa Capital) | 100+ yıldız eşiği (bugün 2) **ve** "private for-profit company" kriteri; hak sahibi gerçek kişi. Yıldız satın almak ToS ihlali, şirket uydurmak brief ihlali |
| awesome-sysadmin | Kategorik kapsam uyuşmazlığı: InternCRM altyapı aracı değil. Ret gerekçesi "better suited for awesome-selfhosted" olur, ayrıca çift kayıt yasağı asıl şansı zayıflatır |
| Soğuk e-posta (sequence araçları dahil) | UWG § 7 Abs. 2 Nr. 2 — B2B'de istisna yok. Hatta "izin ister misiniz?" maili de reklamdır |
| LinkedIn/XING soğuk DM, InMail, tanıtımlı bağlantı notu | OLG Hamm 18 U 154/22: sosyal ağ DM'i "elektronische Post" — e-postayla aynı yasak |
| Liste satın alıp soğuk arama | BVerwG 6 C 3.23: rehberde/sitede yayımlanmış numara reklam aramasına yetki vermez |
| Faks reklamı | E-posta ile aynı yasak rejim |
| SEO: "Onboarding Software / Onboarding Tool Vergleich" | Yanlış kategori (onboarding işe alımdan **sonra** başlar) + affiliate/HR suite bütçeleriyle dolu SERP |
| SEO: jenerik "Chronus alternative / Together alternative" | SERP'i rakiplerin kendi içerikleri ve G2 tutuyor; 0 otoriteyle girilmez. Kapı içerik değil, **dizinlerde listelenmek** (#4) |
| SEO: TR "staj takip sistemi / staj otomasyonu" ana terimleri | Niyet yanlış: sonuçlar üniversitelerin kendi sistem sayfaları, arayanlar öğrenci. Trafik dönüşmez, kalite sinyalini bozar |
| SEO: "digitales Berichtsheft" ana terimi | IHK/HWK/ZDH ücretsiz ve otorite; para kazanılabilirliği yok. Yol: #18 (listeye girmek) |
| TR üniversite idaresine satış (MÜDEK/YÖKAK/OBS ekseni) | stajsistemi.com'un kozu tam burada; bizde bu özellikler yok. TR'de işveren + yerleştiren kurum hedeflenir |
| Çok kiracılı self-servis SaaS lansmanı | `MT_ENFORCE_ISOLATION=false`. Satılabilir olan: tek kiracılı kurulum / self-host / pilot |

---

## 6. Kanal uygulama notları

### 6.1 GitHub vitrini (Faz 0, EN)

**Tam olarak nereye:** repo ana sayfası → sağ üstteki About dişlisi. Doldurulacaklar: Description
("Open-source mentoring & internship CRM: mentee → internship → hire, in one pipeline"), Website =
`https://interncrm.com`, Topics = `mentoring`, `internship`, `crm`, `self-hosted`, `nextjs`, `prisma`,
`typescript`, `gdpr`, `open-source-alternative`. Ardından README'nin ilk ekranı: bir cümlelik konumlandırma,
demo linki + kimlikler, ekran görüntüsü, self-host bölümü, lisans.
**Etik/etiket:** yok — kendi repon.
**Tipik hata:** 643 açık issue'yu gizlemeye çalışmak. Gizlenmez; "aktif geliştirme" olarak çerçevelenir,
`/release-notes` ve CHANGELOG bunu destekler.
**Neden önce bu:** GitHub topic sayfaları indeksleniyor; maliyeti 20 dakika, bugün mümkün olan tek "iz".

### 6.2 GitHub Release + tag (Faz 0)

**Neden:** awesome-selfhosted'ın "ilk sürümden bu yana 4 ay" sayacı CHANGELOG'dan değil **bir release'in
varlığından** başlar ("This count initiates only after a release has been created"). Bugün sıfır release,
sıfır tag var → bugün gönderilen PR "No tagged releases" ile kapanır.
**İş:** `git tag` + GitHub Release; notu `src/lib/releaseNotes.ts` / `/release-notes` içeriğinden üret.
**Maliyet:** bir tag. **Getiri:** 4 aylık sayacın bugün başlaması.

### 6.3 Show HN (Faz 1, EN — tek kullanımlık)

**Neden geçer:** HN'in testi "insanların oynayabileceği bir şey". Bizde çalışan public demo var ve
kimlikler bir sayfada yayımlı — landing page reddedilir, demo reddedilmez.
**Nereye:** news.ycombinator.com → submit; başlık `Show HN: ` ile başlar, URL = demo değil ürün sayfası veya
repo (hangisi anlatıyı daha iyi taşıyorsa), ilk yorumda demo linki + kimlikler + neyi nasıl yaptığın.
**Hazır başlık (EN):** `Show HN: InternCRM – open-source CRM for mentoring and internship pipelines`
**Hazır ilk yorum iskeleti (EN):** ne olduğu (2 cümle) → neden yazıldığı: bir tabloyu yerinden etmek →
**stajyerlerin kendisi yazdı** → demo linki + üç rolün kimlikleri → self-host tek komut → AGPL → bugün
eksik olanlar (çok kiracılı izolasyon kapalı, fiyatlar yeni yayımlandı) — eksikleri kendin söylemek burada
kazandırır.
**Etik:** oy/yorum istemek **kategorik yasak** ("Please don't ask friends to upvote or comment"), çoklu hesap
yasak, self-promo ara sıra olmalı.
**Tipik red/ölüm sebebi:** (a) kayıt duvarı — bizde **yok**: demo'da tek tıkla rol girişi shipping
(`src/app/auth/signin/SignInClient.tsx:246`), bu madde bizim için **kapalı**; (b) gönderen yorumlarda
yok; (c) başlıkta süsleme/sayı; (d) landing page göndermek.
**Zamanlama kuralı:** başarısız gönderim ~1 yıl tekrar edilemez. Kalan tek kapı **OG kartları**
(#1362/#1376/#1378); onlar bitmeden ateşlenmez.

### 6.4 Dizin kayıtları — Capterra.de / GetApp / OMR Reviews / SoftwareAdvice (Faz 1, EN+DE)

**Neden:** "Mentoring Software Vergleich/Anbieter" SERP'ini bu dizinler tekelinde tutuyor; 0 otoriteyle
organik girilmez, ama **profil açmak ücretsiz** ve aynı SERP'e içeriden girilir.
**Nereye:** her platformun "vendor / Anbieter werden" akışı. Aynı varlık setini yükle: 3-5 ekran görüntüsü,
kategori (Mentoring / HR), EUR fiyat, demo linki.
**Kural:** yorum/derecelendirme talep ederken teşvik verilmez; sahte inceleme kategorik olarak dışarıda.
**Tipik red:** ürün canlı değil, ekran görüntüsü yok, fiyat "contact us" — üçü de bizde Faz 0 sonrası çözülü.
**Ayırt edici cümle (DE):** "Sie hosten selbst — die Verarbeitung bleibt in Ihrer Infrastruktur und in
Ihrer Verantwortung; wir erhalten keine Teilnehmerdaten."
**Neden bu biçim:** kayıtsız şartsız "DSGVO-konform" beyanı hem UWG § 5 açısından klasik bir Abmahnung
hedefi hem içerik olarak yanlış — self-host uyumu üretmez; kendi sunucusunda çalıştıran kurum
*Verantwortlicher* olur ve uyum TOM'lara, Verarbeitungsverzeichnis'e, silme sürelerine ve AVV'lere
bağlıdır. Söylenebilecek olan **mekanizma**dır, uyum sonucu değil (bkz. §3.3 son satır).

### 6.5 awesome-selfhosted (Faz sonrası, hafta ~18 — hafta 1 Release + 4 ay, EN)

**Nereye:** PR **ana repoya gitmez**; `awesome-selfhosted/awesome-selfhosted-data` içinde
`software/interncrm.yml`.
**Zorunlu alanlar:** name, website_url, source_code_url, description (<250 karakter, cümle düzeni),
licenses (`AGPL-3.0` listede kabul — MintHCM emsali), platforms (`Nodejs`, `Docker`), tags, demo_url.
**Kategori:** `tags` listesinin **ilk** öğesi tek sayfa görünümünü belirler → **Human Resources Management (HRM)**
(kategori ince: 3 kayıt), sonra CRM / Learning and Courses.
**Kabul kriterleri:** PR başına tek yazılım · aktif bakım · **ilk sürümden 4 ay** · çalışan kurulum talimatı ·
demo linki etkileşimli ve **kimlik bilgilerine doğrudan link** (bizde `/demo` sayfası kimlikleri
listelediği için o koşulu karşılayan sayfa odur; `demo_url` alanına ise sürtünmesiz giriş ekranı
yazılır — `copy-bank.md` §4.1 ile birebir aynı: `https://demo.interncrm.com/auth/signin`) ·
yorumlar ve kullanılmayan alanlar silinmiş · dosya adı kebab-case.
**Ajan uyarısı (bu repo için kritik):** CONTRIBUTING açık: "Machine/LLM-generated contributions, that do not
respect project guidelines are not allowed and will result in a ban." PR elle doğrulanmadan gönderilmez.
**Açıklama yazım kuralı:** "open-source", "free", "self-hosted" gibi gereksiz terimler yasak (liste zaten ima
ediyor); rakip alternatifiyse sonuna `(alternative to …)`.
**Süre:** onaydan sonra merge ~1 hafta. **Listede kalma:** 6-12 ay faaliyet yoksa çıkarılır.

### 6.6 LinkedIn organik + autoposter InternCRM hattı (Faz 1→3, DE + TR)

**Serbest olan:** şirket sayfasından ve kişisel profilden organik içerik, başkalarının gönderilerine yorum,
gruplarda tartışma, karşı taraf yazdıktan **sonra** yanıt, LinkedIn'in ücretli reklam envanteri.
**Yasak olan:** tanıtım içeren DM/InMail, tanıtım metni gömülü bağlantı isteği (OLG Hamm).
**Impressum:** ticari kullanılan sosyal medya profili § 5 DDG kapsamında — sayfa **yayına açık kalmadan
önce** Info → Website URL alanına kendi sitendeki tam Impressum linki konur
(`https://interncrm.com/imprint`; iki tık kuralı, açıkça etiketli).
**Uyarı:** şirket sayfasının **zaten açık** olma ihtimali var ve URL'i bu oturumda tespit edilemedi
(`linkedin-playbook.md` §0). Hafta 1'in ilk işi bunu belirlemektir: sayfa varsa Impressum alanı
**derhal** doldurulur veya sayfa yayından kaldırılır; yoksa hafta 2'de açılır. Impressumsuz ve
hâlihazırda yayında olan ticari bir sayfa, açılmamış bir sayfadan daha büyük risktir.
**Autoposter hattı:** InternCRM hattı BCSIT hattından **ayrı** olmalı (farklı kitle, ses, kategoriler).
Hattın kuralları aynen geçerli: metni **hat** yazar, fikir besleyen taraf metin yazmaz; fikir ekleme
endpoint'i dışında yazma endpoint'i kullanılmaz; **kategorik yayın yasağı** — LinkedIn'e doğrudan istek yok,
Telegram butonlarına ajan basmaz, yayın kararı insana aittir.
**Hazır ilk post (DE, kişisel profil):**
> Wir haben unser Mentoring-Programm jahrelang in einer Tabelle geführt. Heute läuft es in einer eigenen
> Anwendung — geschrieben von den Praktikantinnen und Praktikanten, die darin betreut werden. Der Quellcode
> ist offen (AGPL), die Demo ist öffentlich: demo.interncrm.com. Was mich interessiert: wie dokumentiert ihr
> Praktikumsbetreuung heute?
**Hazır ilk post (TR):**
> Mentorluk programımızı yıllarca elektronik tabloda yürüttük. Bugün kendi uygulamasında çalışıyor — ve o
> uygulamayı, içinde mentorluk alan stajyerler yazdı. Kaynak açık (AGPL), demo herkese açık:
> demo.interncrm.com. Merak ettiğim: siz staj sürecini bugün nerede kaydediyorsunuz?

### 6.7 Persona B kurumsal ağları (Faz 2, DE)

**Forum Mentoring e.V.** — akademik mentorluk koordinatörlerinin birliği; gündem "eşit fırsat + genç
araştırmacı desteği", ticari HR değil. Ses tonu: satış değil araç paylaşımı. Somut çıktı:
kalite standartları ↔ InternCRM ekranları **birebir eşleme tablosu (1 sayfa, DE)**. Bu tablo, bu ağda
broşürden kat kat etkili. Giriş: AG/Jahrestagung takvimi.
**csnd** — ~200 üye, Geschäftsstelle HRK bünyesinde. Kurum üyeliği üniversiteye özgü → **biz üye olamayız**;
girilecek yer içerik/oturum tarafı. Oturum önerisi konusu satış değil mesele olmalı:
*"Praktikumsbetreuung und Berichtsheft-Freigabe digitalisieren — eine quelloffene Referenzimplementierung."*
Üye listesi bir **hedef listesidir, soğuk e-posta listesi değil** (§ 7 UWG): temas biçimi mektup, kurumun
kendi sitesindeki iş birliği formu veya etkinlikte yüz yüze.
**DGM** — üyelik tüzel/gerçek kişilere açık, program sertifikasyonu ücretli. İki kaldıraç: sertifikalı program
yürüten kurumların listesine erişim; ve kendi programımızı sertifikalandırarak "standardı kendi üzerinde
uygulayan satıcı" konumu.
**DHBW dualer Partner** — program bazlı onay, tipik ~3 ay, kampüs başına ayrı süreç. İki hareketi karıştırma:
(1) kendi stajyer ekibimiz için duale Partner olmak (hikâyenin kurumsal kanıtı), (2) Studiengangsleitung ve
Duale-Partner-Service birimlerine ürünü tanıtmak.
**Tipik red sebebi (hepsinde ortak):** ağın gündemine değil kendi ürününe konuşmak; Almanca olmayan materyal;
Impressum'suz bir siteye link vermek.

### 6.8 IHK (Faz 2, DE)

Odalar staj/dual-study/EQ ilanlarını **ücretsiz** yayımlıyor (ihk-boerse.de) ve şirket profili açılabiliyor.
İki ayrı kullanım: (1) kendi staj ilanımızı yayımlamak (gerçek aday kanalı + hikâyenin kanıtı),
(2) Ausbildungsberater ağı üzerinden Persona A/B temasının **davetli** hâli.
**Tipik hata:** borsayı bir reklam panosu gibi kullanmak; ilan gerçek bir pozisyon olmalı.

### 6.9 Fiziki mektup — Briefwerbung (Faz 2, DE)

Almanya'da **rıza gerektirmeyen tek soğuk temas** biçimi (§ 7 UWG yasak kataloğunda yok).
**Paket:** 1 sayfa kişiselleştirilmiş mektup (muhatabın kendi programına atıf) + Art. 14 DSGVO veri koruma
bilgi notu + Art. 21(2) itiraz hakkı bildirimi + demo.interncrm.com QR kodu.
**Zorunlu kayıt:** veri kaynağı, tarih, menfaat dengelemesi notu, itirazlar → **bastırma listesi (Sperrdatei)**.
İtiraz gelen adres kalıcı olarak bastırılır.
**Hazır açılış (DE):**
> Sehr geehrte Frau …, Sie koordinieren bei … das Mentoring-Programm. Wir haben für genau diesen Ablauf eine
> quelloffene Anwendung gebaut — von den Praktikantinnen und Praktikanten, die darin betreut werden.
> Ausprobieren ohne Registrierung: demo.interncrm.com/auth/signin — ein Klick, drei Rollen.

**Fiyat cümlesi ön koşulludur.** `/pricing` (#1403) yayına girene kadar mektuba fiyat satırı
**hiç yazılmaz** — "Preise auf Anfrage" da yazılmaz, blok tamamen çıkarılır (`copy-bank.md` §11 kuralı).
Sayfa yayına girdiğinde eklenecek cümle: "Preise stehen offen auf interncrm.com/pricing."
**Ölçek kuralı:** 20-30 adetlik ölçülü partiler; toplu kampanya değil.

### 6.10 Product Hunt (Faz 3, EN — tek kullanımlık, 6 ay kilit)

**Hesap:** yalnız **kişisel** hesap ("We don't allow company or brand accounts to post products or comment") —
Mehmet self-hunt eder; hunter zorunlu değil. Kurumsal marka hesabı açılmaz, bcsit adı geçmez.
**Zamanlama:** gün 12:01 AM PT'de başlar; ilk saatte yayımlanan lansman tam 24 saatlik pencere alır.
**Etik:** upvote istemek, toplu mesaj, teşvik → kategorik yasak; yakalanan lansman unfeatured edilebiliyor.
Söylenebilecek tek şey: "göz atın, dürüst geri bildirim verin".
**Neden Faz 3:** ölçüm yoksa (#1388/#1390) tek kullanımlık koz ölçülemeden harcanır; `/pricing` yoksa gelen
ziyaretçinin gidecek ticari sayfası olmaz; görsel mecrada ekran görüntüsü yoksa gönderi zayıf kalır.
**Konumlandırma uyarısı:** ürün sayfasında "self-servis SaaS" değil **"self-host / tek kiracılı kurulum /
pilot"** denir. Yeniden lansman için 6 ay + anlamlı güncelleme gerekir (fiyat planı değişikliği anlamlı sayılmaz).

### 6.11 awesome-recruitment / awesome-hrtech (Faz 1, EN)

Formel kabul kriteri yok → bugün gönderilebilecek nadir awesome kanalı. README'ye tek satır ekleyen PR;
PR açıklamasında geliştirici olduğunu belirt (zorunlu değil, güven artırır).
**Dürüst beklenti:** bakımcı README'de listeyi güncel tutamadığını yazıyor, 13 açık PR birikmiş.
**Kural:** kanal başına 15 dakika zaman kutusu, takip yatırımı yok; 8 hafta içinde merge yoksa kanal kapatılır.

---

## 7. Hukuki sınırlar (Almanya) — yapılabilir / yapılamaz

Bu bölüm bağlayıcıdır: aşağıda "yapılamaz" yazan hiçbir taktik, "dikkatli yapılırsa" diye plana geri girmez.
Tek kişilik bir üründe asıl tehlike ceza miktarı değil **kesintidir**: bir Unterlassungserklärung imzalandıktan
sonra sistemin yanlışlıkla attığı tek bir mail dört haneli otomatik borç doğurur.

### 7.1 YAPILAMAZ

| Taktik | Hüküm / karar | Kaynak |
|---|---|---|
| B2B soğuk e-posta (kurumsal adrese, ilgili teklifle bile) | UWG § 7 Abs. 2 Nr. 2 — önceden **açık** rıza olmadan her hâlde "unzumutbare Belästigung"; telefondaki B2B hafifletmesi e-postada **yok** | https://www.gesetze-im-internet.de/uwg_2004/__7.html |
| "Bülten göndermemize izin verir misiniz?" maili | Werbung kavramı geniş; BGH 10.07.2018 - VI ZR 225/17 memnuniyet anketini bile reklam saydı → izin isteyen mail **kendisi** izinsiz reklam | https://www.lhr-law.de/magazin/wettbewerbsrecht-kartellrecht/kundenzufriedenheitsumfrage-e-mail-werbung-ordnungsgeld/ |
| LinkedIn/XING DM, InMail, tanıtımlı bağlantı notu | OLG Hamm 03.05.2023 - 18 U 154/22: sosyal ağ DM'i § 7 anlamında "elektronische Post" | https://medien-internet-und-recht.de/volltext.php?mir_dok_id=3302 |
| Liste satın alıp/rehberden numara alıp soğuk arama | BVerwG 29.01.2025 - 6 C 3.23: yayımlanmış numara reklam aramasına yetki vermez; "sektör genelde faydalanır" varsayımı yetersiz; Art. 6(1)(f) de dayanak olmaz | https://www.bverwg.de/290125U6C3.23.0 |
| Faks reklamı | E-posta ile aynı rejim | https://www.gesetze-im-internet.de/uwg_2004/__7.html |
| Takma gönderen / cevaplanmayan `noreply@` tek başına | UWG § 7 Abs. 2 Nr. 3 — kimliğin gizlenmesi veya geçerli adres yokluğu, rıza olsa bile ihlal | https://www.gesetze-im-internet.de/uwg_2004/__7.html |
| Impressum'suz ticari web sitesi / LinkedIn şirket sayfası | § 5 DDG — kolay fark edilir, doğrudan ulaşılabilir, sürekli; sosyal medya profilleri dahil | https://www.gesetze-im-internet.de/ddg/__5.html · https://www.e-recht24.de/impressum/13397-impressum-linkedin.html |

### 7.2 YAPILABİLİR (koşullarıyla)

| Taktik | Koşul | Kaynak |
|---|---|---|
| **Fiziki mektupla reklam** | § 7 yasak kataloğunda değil; rıza gerekmez. Art. 14 DSGVO bilgilendirmesi (en geç 1 ay, ilk iletişimden geç olmamak üzere) + Art. 21(2) itiraz hakkı + bastırma listesi | https://www.dr-datenschutz.de/werbung-per-post-neukunden-dsgvo-konform-akquirieren/ · https://dsgvo-gesetz.de/art-14-dsgvo/ |
| **B2B telefon araması** | Yalnızca **kanıtlanabilir somut bağ** varsa: muhatabın kendi yayımladığı program ilanı + açıkça belirttiği ihtiyaç, etkinlikte yüz yüze tanışma, kurumun sitesindeki "iş birliği için yazın" daveti. Bağın kaydı tutulur | https://www.bverwg.de/290125U6C3.23.0 · UWG § 7 Abs. 2 Nr. 1 |
| **Double-opt-in bülten** | Art. 7(1) DSGVO ispat yükü: e-posta, kayıt zaman+IP, **form ve onay mailinin o tarihteki tam metni/sürümü**, onay tıklama zaman+IP, opt-out zamanı. Onay maili tarafsız (içinde reklam yok). Her bültende geçerli çıkış adresi + Impressum. VG Düsseldorf 27.07.2026: yalnız adres+IP+zaman damgası **yetersiz** | https://shopbetreiber-blog.de/vg-duesseldorf-nachweispflichten-beim-double-opt-in-verfahren |
| **Organik sosyal içerik, yorum, grup katılımı, gelen mesaja yanıt** | Reklam mesajı **göndermediğin** sürece serbest | OLG Hamm 18 U 154/22 (ayrımı belirler) |
| **LinkedIn ücretli reklam / Lead Gen Form** | Platformun kendi envanteri; § 7 DM yasağının dışında | — |
| **Mevcut müşteriye benzer ürün maili (§ 7 Abs. 3)** | Dört koşul birlikte: adres bir **satış** sırasında alınmış · yalnız benzer mal/hizmet · itiraz yok · her mailde açık itiraz hakkı. **Demo hesabı açmak / Community indirmek / issue açmak satış değildir** → bugün bu istisna bize **kapalı** | https://www.gesetze-im-internet.de/uwg_2004/__7.html |

### 7.3 İki ayrı katman: UWG ≠ DSGVO

UWG "bu adrese reklam gönderebilir miyim?", DSGVO "bu kişisel veriyi işleyebilir miyim?" sorusunu ayrı
yanıtlar. Birini geçmek diğerini geçmek değildir. Outbound tutulacaksa (yalnız mektup + nitelikli arama)
şunlar **yazılı** tutulur: veri kaynağı, tarih, Interessenabwägung notu, Art. 14 bilgilendirmesinin
gönderildiği an, itirazlar. Kaydın tutulduğu **yer** değil, **varlığı** zorunludur (Art. 5(2)).

### 7.4 Ceza ve maliyet gerçeği

B2B izinsiz e-posta/DM için idari para cezası yolu yok; yaptırım **Abmahnung → Unterlassungserklärung →
Vertragsstrafe** zinciriyle gelir. Uygulamada Streitwert 3.000-6.000 EUR (OLG München bir olayda 1.000 EUR'a
indirdi), avukat maliyeti birkaç yüz ile 1.000+ EUR arası, sonraki tek ihlalde klasik Vertragsstrafe 5.001 EUR.
UWG § 13 Abs. 4, Impressum gibi bilgilendirme ihlallerinde ve 250'den az çalışanlı işletmelerin DSGVO
ihlallerinde masraf tazminini kapatır — ama durdurma talebi ve DSGVO idari cezaları (Art. 83) bundan bağımsızdır.
Kaynak: https://www.gesetze-im-internet.de/uwg_2004/__13.html · https://www.gesetze-im-internet.de/uwg_2004/__20.html

### 7.5 Kamu alıcısı — ihale eşiği altı (Persona B için kritik)

Devlet üniversiteleri, DHBW, Studierendenwerke ve odalar kamu alıcısıdır, ama her alım ihale değildir:
§ 14 UVgO doğrudan sipariş (Direktauftrag) yolunu tanır; 2026-01-01 itibarıyla federal alıcılarda sınır
15.000 EUR net (Vergabebeschleunigungsgesetz ile 50.000 EUR öngörülüyor), AB eşikleri çok yukarıda
(mal/hizmette 140.000 / 216.000 EUR net). Eyalet üniversiteleri eyalet Wertgrenze'lerine tabidir —
muhataba "sizin Wertgrenze'niz nedir?" diye sormak meşru ve normaldir.
**Fiyatla bağı:** Program €149/ay ≈ 1.788 EUR/yıl, Program Plus €399/ay ≈ 4.788 EUR/yıl — ikisi de her eşiğin
çok altında. Rakiplerin ~5.000-10.000 USD/yıl giriş noktası çoğu Alman kamu alıcısını ihale/onay sürecine
sokar; bizimki sokmaz. **Pilotu bilinçli olarak eşiğin altında fiyatla ve teklifte NET tutar yaz.**
Kaynak: https://www.vergabevorschriften.de/uvgo/14 · https://www.auftragsberatungsstellen.de/wertgrenzen

---

## 8. Ölçüm

**Bugünkü kısıt:** `utm_*` yakalama ve dönüşüm olayı yok; analytics yalnız sayfa görüntülüyor
(#1388, #1390). Aşağıdaki "ölçülebilir mi?" sütunu bu gerçeğe göre doldurulmuştur.
**Kural:** ölçülemeyen bir kanal ateşlenmez — özellikle tek kullanımlık kozlar (Show HN, Product Hunt).

| Faz | KPI | Hedef (12 hafta ufku) | Bugün ölçülebilir mi? |
|---|---|---|---|
| 0 | GitHub Release sayısı | ≥1 | Evet (GitHub API) |
| 0 | Önizlemeli paylaşılan URL oranı | %100 (OG kartı olan pazarlama sayfası) | Evet (elle: paylaşım debug araçları) |
| 0 | Impressum tamlığı | Placeholder yok | Evet (elle) |
| 0 | utm ile etiketlenmiş oturum kaydı | >0 | **Hayır → #1388/#1390 ön koşul** |
| 0 | `/pricing` yayında mı | Evet | Evet (#1403) |
| 1 | GitHub yıldız + fork | Yıldız trendi pozitif, haftalık delta izlenir | Evet |
| 1 | Referral kaynağına göre oturum (dizinler, HN, Reddit) | Kanal başına ayrıştırılabilir | **Kısmen** — referrer var, utm yok (#1390) |
| 1 | Demo'da **rol bazlı** oturum sayısı (admin/mentor/mentee) | Haftalık >0 ve artan | **Hayır → dönüşüm olayı gerekiyor (#1388)** |
| 1 | Dizin profili sayısı (canlı) | ≥3 | Evet (elle) |
| 1 | Show HN sonrası 48 saatte demo oturumu | Kanal-ilişkilendirilmiş | **Hayır → #1388/#1390** |
| 2 | Yanıt veren kurum sayısı (Forum Mentoring/csnd/DGM/DHBW/IHK) | ≥3 | Evet (elle CRM kaydı) |
| 2 | Tanıtım görüşmesi | ≥2 | Evet (elle) |
| 2 | Mektup → yanıt oranı | ≥%5 | Evet (elle; QR'a utm eklenirse otomatik) |
| 2 | Konferans/AG oturum kabulü | ≥1 | Evet (elle) |
| 2 | awesome-selfhosted PR durumu | Açıldı / merge | Evet (GitHub) |
| 3 | Nitelikli pilot talebi / ay | ≥5 | **Hayır → dönüşüm olayı** |
| 3 | Kanal başına talep maliyeti (nakit + saat) | Nakit ~0 kanallar payı ≥%60 | Kısmen (saat elle) |
| 3 | DE/TR lokalize sayfalarda organik giriş | >0 ve artan | **Hayır → #1360 (hreflang, lokalize rota) yapılmadan sayfa yok** |
| 3 | Bülten DOI abone sayısı + opt-out oranı | Opt-out <%1/gönderi | Evet (`NewsletterSend`, `docs/newsletter.md`) |

**Ölçüm borcu (dağıtımın ön koşulu, öncelik sırası):** (1) `utm_*` yakalama (#1390),
(2) dönüşüm olayları: demo girişi, rol seçimi, `/pricing` görüntüleme, pilot talebi (#1388),
(3) lokalize rota + hreflang (#1360) — 3'süz DE/TR SEO ölçülemez de yapılamaz da.

---

## 9. Riskler ve durdurma kuralları

| # | Risk | Erken uyarı | **Durdurma kuralı** |
|---|---|---|---|
| R1 | Topluluk kanallarında spam algısı (awesome listeleri, HN, Reddit, Lobste.rs) | Bir PR "self-promo" gerekçesiyle kapanır; bir gönderi flag'lenir | O kanalda **60 gün** yeni gönderim yok; aynı kanala ikinci deneme yapılmadan kural metni yeniden okunur |
| R2 | LLM üretimi katkı yasağı ihlali (awesome-selfhosted **ban** yazıyor) | — | Bu listelere giden hiçbir PR **elle doğrulanmadan** gönderilmez; ajan tek başına PR açmaz |
| R3 | Tek kişilik ekip kapasitesi | Aynı hafta ikiden fazla kanal açık; iş listesi büyüyor, hiçbiri bitmiyor | **Aynı anda en fazla 2 aktif kanal.** Yeni kanal, ancak biri ölçüsüne ulaşınca veya kapatılınca açılır |
| R4 | Tek kullanımlık kozun israfı (Show HN 1 yıl, Product Hunt 6 ay) | Ön koşul listesinde açık madde varken "hızlıca ateşleyelim" baskısı | Ön koşulların **tamamı** yeşil değilse gönderim yapılmaz; kararı faz kapısı verir, heves değil |
| R5 | Demo yükü / kötüye kullanım (HN dalgası, botlar) | Demo yanıt süresi bozuluyor, veri kirleniyor | Demo verisinin periyodik sıfırlanması + oran sınırı; gerekirse gönderiye "demo yenileniyor" notu. Demo `robots.txt: Disallow: /` **kalır** |
| R6 | Yanlış trafik (TR "staj takip" öğrenci trafiği, "Praktikum" kelime çakışması) | Bounce yüksek, demo dönüşümü sıfır | O anahtar kelime kümesi negatif listeye alınır; sayfada açık yönlendirme satırı zorunlu |
| R7 | Hukuki geri tepme (Abmahnung) | Bir muhatap itiraz eder | İtiraz eden adres derhal bastırma listesine; ilgili kanal **incelenene kadar** durur; bir Unterlassungserklärung imzalandıysa tüm otomatik gönderim hatları kapatılır |
| R8 | Vaadin ürünü aşması (çok kiracılılık, sertifika, entegrasyon) | Bir teklif/sayfada §3.3 listesinden bir ifade beliriyor | Metin yayına çıkmaz; §3.3 tablosu her yayın öncesi kontrol listesi olarak okunur |
| R9 | Ölü kanala emek gömme (awesome-recruitment tipi) | 8 hafta merge yok / yanıt yok | Kanal kapatılır, tekrar denenmez; emek kalan kanallara aktarılır |
| R10 | Autoposter hattının kural ihlali | Hat, insan onayı olmadan yayın yapmaya çalışıyor | Kategorik yayın yasağı korunur: LinkedIn'e doğrudan istek yok, Telegram butonlarına ajan basmaz; ihlal görülürse hat durdurulur |
| R11 | Eski demo adresinin dolaşıma girmesi | Bir metinde `crm-demo.ersah.in` | Metin düzeltilmeden yayımlanmaz; tek adres https://demo.interncrm.com |

---

## 10. İlk 10 iş (sırayla, hafta 1-2)

1. `git tag` + GitHub Release (4 aylık sayaç başlasın).
2. GitHub About: topics, homepage, description; README ilk ekranı.
3. `interncrm.com/imprint` gerçek verilerle (#1371) — kanal açmanın hukuki ön koşulu.
4. Sayfa başına title/description + OG/Twitter kartı (#1362/#1376/#1378, #1360 kapsamı).
5. En az 3 ürün ekran görüntüsü (#1399) — beş kanalın ortak varlığı.
6. `utm_*` yakalama (#1390) + demo girişi/rol seçimi dönüşüm olayı (#1388).
7. `/pricing` yayına (#1403) — hem SEO hem Persona B'nin eşik-altı satın alma argümanı.
8. `docs/self-hosting.md` + üretim compose; sıfırdan doğrula.
9. ~~Demo'ya tek tıkla rol girişi butonları~~ — **kapandı (2026-09-06)**: `demo-quick-login` bloğu
   shipping (`src/app/auth/signin/SignInClient.tsx:246`). Show HN'in sürtünme testi bugün geçiliyor.
10. Dizin profilleri: Capterra.de, GetApp, OMR Reviews, SoftwareAdvice — hafta 5 ve 6'ya **ikişer**
    dağıtılır (R3: aynı anda en fazla 2 aktif kanal; dört profili tek 30 dakikalık kutuya sığdırmak
    bu kuralı ve M eforunu ihlal ediyordu).

Bunlar bittiğinde Faz 1 kapısı açılır: Show HN, r/selfhosted, awesome-recruitment/hrtech, LinkedIn hattı.

---

## Açık sorular

*2026-09-06 eleştiri turunda uygulanan düzeltmelerin bıraktığı açık uçlar. Her satır tek bir soru;
cevaplandığında ilgili bölüme işlenir ve satır buradan silinir.*

- `/impressum` → `/imprint` **kalıcı yönlendirmesi** (Alman kullanıcı refleksle `/impressum` yazar) bu
  turda **açılmadı**: görev yalnız `docs/marketing/` altındaki beş dosyayı değiştirmeye izin veriyordu,
  `next.config.js` dokunulmadı. Dokümanlar kanonik `/imprint`'e sabitlendi; yönlendirme isteniyorsa ayrı
  bir issue gerekiyor ve Faz 0 iş listesine madde olarak eklenmeli. Bu, hiçbir metnin ön koşulu değildir.
- ÖK3 (`/pricing`, #1403) için sunulan iki seçenekten **daraltma** uygulandı: fiyat sayfası artık yalnız
  *fiyat iddiası taşıyan* metinlerin kapısı. Alternatif — #1403'ü hafta 1-2 işi yapıp ÖK3'ü gerçekten
  kapatmak — hâlâ tercih edilebilir; o kararı veren kişi §4 Faz 0 iş listesine ve takvimin hafta 1-2
  satırlarına aynı anda yazmalı. **Bugünkü hâlde `/pricing` Faz 0 hedefi, hiçbir fazın kapısı değil.**
- Persona A cümlelerindeki fiyat yan cümlesi ön koşullu hâle getirildi ama **üç dilde ayrı bir
  "fiyatsız sürüm" yazılmadı**; cümleyi kullanan kişi yan cümleyi elle çıkarıyor. Yayına girmeden önce
  üç dilde fiyatsız sürümlerin `copy-bank.md`'ye eklenmesi daha güvenli olur.
- Kanal matrisindeki "Beklenen getiri" sütunu hâlâ göreli ve ölçümsüz (#1388/#1390). Ölçüm açıldığında
  bu sütun gerçek sayılarla değiştirilmeli; bugün bir tahmin olduğu **yazılı değil**.
