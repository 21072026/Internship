# Autoposter — InternCRM hattı (işletim dokümanı)

> **Durum:** uygulama sözleşmesi, 2026-09-06. Bu doküman `autoposter.ersah.in` üzerinde açılacak
> **ikinci hattın** — InternCRM hattının — kimliğini, kategori setini, fikir şemasını, tekrar
> engelleme kayıtlarını, görsel politikasını ve yayın yasağını tanımlar.
>
> **Kardeş doküman:** `it-meme-content` skill'i (BCSIT / IT-meme hattının sözleşmesi). Buradaki
> kurallar o hattan **devralınır**; sadece kimlik, kategori ve içerik kaynağı değişir. Devralınan üç
> kural tartışmaya kapalıdır: metni **hat** yazar, fikir ekleme dışında yazma endpoint'i yoktur,
> **kategorik yayın yasağı** geçerlidir (§8).
>
> **Bu doküman takvim değildir.** Ne zaman ne yayınlanacağı `content-calendar.md`'de, LinkedIn
> mekaniği `linkedin-playbook.md`'de, hazır metinler `copy-bank.md`'de. Burada sadece **hattın nasıl
> beslendiği** var. On-site katman (SEO, meta, ölçüm) epic **#1360** kapsamındadır, burada tekrar
> edilmez.
>
> Satır genişliği ~100 karakter; tablolar bu kuralın dışındadır. Hafta numaraları görelidir
> (hafta 1 = planın onaylandığı ilk tam hafta).

---

## 1. Neden ayrı hat

BCSIT hattı bugün çalışıyor: fikir → Gemini zinciri → Cloudflare flux görseli → **Telegram'da
önizleme ve insan onayı** → LinkedIn. Teknik olarak InternCRM içeriğini de aynı hatta sokmak
mümkün. Yapılmayacak. Üç somut zarar var:

| # | Zarar | Nasıl ortaya çıkar | Sonucu |
|---|---|---|---|
| Z1 | **Kitle çakışması** | BCSIT kitlesi KOBİ'nin IT karar vericisi (sysadmin, CIO, IT-Leiter). InternCRM kitlesi İK/staj programı sorumlusu, kariyer merkezi koordinatörü, dual-study danışmanı. Ortak kesişim neredeyse yok | Aynı takipçi kütlesine iki alakasız ürün gider; her iki tarafta da erişim düşer |
| Z2 | **Ses çakışması** | BCSIT sesi: "Wir sehen im Alltag:", KOBİ hizmet sağlayıcısı ağzı, memeden beslenen mizah. InternCRM sesi: kurucu/build-in-public, kanıt gösteren, mizahsız | Hattın tekrar önleme ve ton tutarlılığı mekanizması iki sesi ortalar; ikisi de silikleşir |
| Z3 | **Tekrar engelleme kaydının kirlenmesi** | BCSIT hattı son gönderileri tarayıp tekrarı önlüyor. Karışık kayıtta "son 5 gönderi" iki markadan gelir | InternCRM tarafı yanlış "yakında anlattık" sinyali alır, gerçek tekrar yakalanmaz |

Ek olarak **hukuki bir ayrım** var ve bu opsiyonel değil: InternCRM'in fikri hak sahibi **Mehmet
Erşahin (gerçek kişi)**, bcsit GmbH değil (`CLAUDE.md` § Licensing & IP,
`docs/legal/legal-tax-framework.md`). Aynı hattan yayınlanan iki ürün, yayın kimliği düzeyinde de
karışır. InternCRM hattı **InternCRM adına** yayınlar; hiçbir metinde, hiçbir profilde şirket hak
sahibi gösterilmez.

**Ayrım nerede biter:** altyapı (Gemini zinciri, flux, Telegram bot, onay akışı) ortaktır ve
paylaşılır. Ayrılan şey **hat yapılandırması**dır: kategori seti, ses/dil kuralı, fikir kaynağı,
tekrar kaydı, hedef LinkedIn hesabı.

---

## 2. Hattın kimliği

### 2.1 Dil dağılımı

Bir gönderi **tek dilde** yazılır; karışık yazılmaz. Dil, gönderinin kitlesinden çıkar, hattın
varsayılanından değil:

| Dil | Payı (steady state) | Kim için | Ses |
|---|---|---|---|
| **DE** | ~%60 | Persona A (100-1000 çalışanlı DE/AT/CH işvereni) + Persona B (kariyer merkezi, dual-study koordinatörü, meslek eğitimi sağlayıcısı, mentorluk derneği) | Sakin, kanıt gösteren ürün sesi. Almanca terimler yerelleştirilmez: `Praktikum`, `Berichtsheft`, `Ausbildungsnachweis`, `duales Studium`, `Werkstudent` |
| **EN** | ~%25 | Open source / self-host / GitHub / HN kitlesi | Build-in-public, teknik, mühendis-mühendise. Pazarlama sıfatı yok |
| **TR** | ~%15 | TR işveren tarafı ve TR yazılım/kariyer topluluğu | **Kurucu sesi** — birinci tekil, "bunu neden böyle yaptım". Tek "ben" konuşan dil budur |

Faz sırası (`content-calendar.md` §1.5) bu payları haftalık olarak eğer: hafta 3-6 EN ağırlıklı,
hafta 5-10 DE ağırlıklı, hafta 11-12'den itibaren TR devreye girer. Yukarıdaki oran **12 haftanın
toplamı** için geçerlidir, tek bir hafta için değil.

### 2.2 Ton kuralları

| Kural | Gerekçe |
|---|---|
| **Mizah yok.** BCSIT hattının meme ekseni buraya geçmez | Alıcı bir program sorumlusu; kararın maliyeti bir staj dönemi. Mizah güveni değil samimiyeti artırır, burada güven lazım |
| **Her iddia bir kanıta bağlı**: ürün iddiası → dosya yolu, dış kural/limit → URL | `content-calendar.md` Y8. Depo public, demo public, `/api/public/stats` public — kontrol edilir |
| **Sayı gösterme kuralı**: kullanıcı/müşteri/mentor sayısı yok, uydurulmaz, ima edilmez, "yüzlerce" diye belirsizleştirilmez | K2, `docs/landing-value-proposition.md` §4.3. Bugün `/api/public/stats`: 3 mentor, 4 açık proje, 0 bekleyen aday |
| **Çok kiracılı SaaS vaadi yok** | `MT_ENFORCE_ISOLATION=false` (`docs/tenant-isolation.md`). Satılabilir olan: tek kiracılı kurulum, self-host, pilot |
| **Eksiği saklama** | Beta etiketi, `/pricing` sayfasının olmaması, prod docker-compose'un olmaması dürüstçe söylenir. `copy-bank.md`'deki Show HN metni bu tonu zaten kurmuş |
| **Rakip adı geçmez** | 16 rakibin fiyat gizlemesi bir **kategori gözlemi** olarak anlatılır (P5), isim vererek değil |
| **Emoji: gövdede 0** | Kurucu sesi + B2B alıcı. Carousel içi ikonlar bu kuralın dışındadır |

### 2.3 Uzunluk, kapanış, hashtag

- **Uzunluk:** 1.300-2.000 karakter (ana gönderi). Kanca ilk **140** karaktere sığar — mobil kesme
  noktası. Opsiyonel kısa not: 400-800 karakter.
- **Kapanış sorusu:** her ana gönderi **tek** soruyla biter ve soru **cevaplanabilir** olur.
  Yasak kalıp: "Ne düşünüyorsunuz?" / "Was denkt ihr?". İşleyen kalıp: karşı tarafın kendi
  pratiğini soran somut soru — "Wie dokumentiert ihr die Wochenberichte heute?" gibi.
- **Hashtag:** kişisel profil gönderisinde **0-1**. Şirket sayfasında sayfa kimliğine bağlı üç
  hashtag zaten var (`#Praktikum #DualesStudium #Mentoring`, `linkedin-playbook.md` §2.3) —
  gönderi içinde tekrar edilmez.
- **Dış link:** ne gövdede ne ilk yorumda (K7). Link profil "website" alanında ve sayfa custom
  button'ında durur.

---

## 3. Kategori seti

BCSIT hattının `IT-Sicherheit | Managed Services | Backup | Identity Management | Microsoft 365 |
IT-Infrastruktur | Compliance | Mitarbeiter-Awareness` setinin InternCRM karşılığı. Anahtarlar
**Almanca** (yayının ağırlık dili DE; TR/EN gönderi de aynı kategori anahtarını kullanır):

| Kategori anahtarı | Piler karşılığı | Ne anlatılır | Ne anlatılmaz |
|---|---|---|---|
| `Praktikumsmanagement` | P1 (operasyon ucu) | Staj programının günlük işletimi: aşama SLA'sı takvim günü üzerinden (`src/lib/stageSla.ts`), kimin hangi aşamada beklediği, pasif ilk temas kuralı (`src/lib/dormantFirstContact.ts`) | Öğrenci bulma vaadi (pazaryeri değiliz), okul/üniversite entegrasyonu (OBS/BİLSİS yok — Y5) |
| `Ausbildung-Berichtsheft` | P2 | Haftalık rapor + mentor yorumu + onay damgası tek akış (`WeeklyReport.status/mentorComment/reviewedAt`), haftada tek rapor garantisi (`@@unique([relationId, weekStart])`), yazdırılabilir rapor (`src/app/weekly-reports/print/`) | **"IHK-geçerli Ausbildungsnachweis"** — bu iddia yok, resmî denklik iddiası edilmez (Y5) |
| `Mentoring-Programme` | P3 | Mentor ↔ mentee eşleştirmesi, etkileşim günlüğü, mentorun imzasının ne anlama geldiği, mentorluk anlaşması kapsamında koda katkı hikâyesi | Koçluk/gelişim metodolojisi dersleri (rakiplerin durduğu yer orası), "kültür dönüşümü" söylemi |
| `Recruiting-Pipeline` | P1 (işe alım ucu) | 13 aşamalı huni, 2 aşamanın **çıkış** olması ve bunun başarısızlık olmaması, çıkış nedeni taksonomisi, kör puanlamalı mülakat paneli (`Evaluation.submittedAt`), teklif durum makinesi | ATS yerine geçme iddiası, CV parsing vaadi (`docs/research/cv-parsing.md` araştırma aşamasında — shipping değil) |
| `Open-Source-Selfhosting` | P4, P6 | AGPL-3.0-or-later + çift lisans mantığı, kendi sunucunda çalıştırma (`Dockerfile`, `.env.example`, `/api/health`), üç dilli geliştirmenin maliyeti, CI'da anahtar paritesi (`npm run check:i18n`) | "tek komutla kurulum" — bugün prod docker-compose **yok**, `copy-bank.md` bunu zaten açıkça yazıyor |
| `Datenschutz-DSGVO` | P4, P7 | Self-host'un veri sorumluluğuna etkisi, rol × endpoint erişim matrisi (`docs/role-access-matrix.md`), PII yaşam döngüsü (`docs/pii-access-lifecycle.md`), `/trust` sayfası, güvenlik denetimi playbook'unun açık olması | **Hukuki tavsiye.** "DSGVO-konform" tek başına bir vaat olarak kullanılmaz; "weil du es selbst hostest" gibi **mekanizmayı** anlatan biçimde kullanılır. AVV/DPA şablonu vaadi yok |
| `Markt-und-Preise` | P5 | Kategorinin fiyat gizlemesi (16 satıcıdan 3'ü kullanılabilir rakam yayımlıyor, 7'sinde ne ücretsiz sürüm ne deneme var — `docs/research/competitive-analysis-2026-08.md`), birimin neden "aylık aktif eşleşmiş çift" olduğu, mentor/mentee çekirdeğinin sonsuza kadar ücretsiz olması | **Kesin fiyat rakamı — `/pricing` sayfası yayında değil (#1403).** Rakam ancak sayfa yayına girdikten sonra metne girer. İsim vererek rakip fiyatı karşılaştırması yok |
| `Produkt-Update` | Sürüm notları | Merge olmuş sürüm fragmanlarından çıkan kullanıcıya dönük değişiklik (`releases/unreleased/*.json` → `notes`), yeni özellik kartı (`src/lib/features.ts`, bugün 46 kayıt) | Yol haritası vaadi ("yakında gelecek"). Sadece **shipping olan** anlatılır: fragman + features kaydı yoksa gönderi yok (`content-calendar.md` §3.3) |

**Kategori çeşitliliği kuralı:** bir haftalık partide 6 fikrin **3'ü aynı kategori olamaz**
(BCSIT hattındaki kuralın aynısı). `Produkt-Update` haftada **en fazla 1** fikir alır — ürün
güncellemesi hattın omurgası değil, ritim işaretidir.

---

## 4. Kitle dağılımı ve haftalık kota

BCSIT hattı günlük 6 fikir üretiyor. InternCRM hattı **haftalık 6 fikir** üretir — kapasite
haftada 2-3 gönderi (K1), o yüzden parti bir **havuz**dur, yayın kuyruğu değil.

| Adet | Kitle (`audience`) | Konu havuzu | Baskın dil |
|---|---|---|---|
| 3 | **`persona-b`** — yerleştirme yapan kurum (kariyer merkezi, dual-study koordinatörü, meslek eğitimi sağlayıcısı, mentorluk derneği) | Berichtsheft onay akışı, aşama SLA'sı, pasif ilk temas, çıkış nedeni taksonomisi, mentor imzası | DE |
| 2 | **`persona-a`** — 100-1000 çalışanlı işverenin staj/graduate program sorumlusu | Kırık huni, kör puanlamalı mülakat, teklif durum makinesi, fiyat şeffaflığı, birim seçimi | DE |
| 1 | **`oss`** — open source / self-host / GitHub / HN | AGPL + çift lisans, self-host, üç dilli geliştirme, demo'nun yazılabilir olması, güvenlik playbook'u | EN |

**TR kotası ayrı bir satır değildir**, bir **dönüşümdür**: hafta 11'den itibaren `persona-a`
fikirlerinden **biri** TR'ye çevrilir (dil alanı `tr`, ses kurucu sesi). Ayrı bir TR fikri
üretilmez — aynı fikir, farklı kitle, farklı ses.

### 4.1 Parti → yayın dönüşümü (BCSIT hattından bilinçli sapma)

BCSIT hattında 6 fikrin **6'sı da** hatta beslenir. Burada beslenmez:

1. Ajan 6 fikri `fikirler.json`'a yazar (havuz).
2. Pazartesi brief'i havuzdan **3'ünü kısa listeye** alır (`content-calendar.md` §3.1).
3. İnsan 3'ten **2'sini** seçer.
4. **Sadece seçilen 2 fikir** hatta POST edilir.

Gerekçe: hatta beslenen her fikir bir Gemini zinciri + bir flux görseli + bir Telegram önizlemesi
demek. 6 önizlemenin 4'ünü silmek hem model bütçesini hem 20 dakikalık insan bütçesini yakar.
Seçilmeyen fikir çöpe gitmez, bir sonraki haftanın havuzuna düşer.

---

## 5. Fikir şeması — `fikirler.json` (InternCRM sürümü)

Dosya: `<calisma-klasoru>/<YYYY-MM-DD>/fikirler.json` (klasör kararı §9.2).

```json
{
  "line": "interncrm",
  "generatedAt": "2026-09-07T09:00:00+02:00",
  "week": 1,
  "phase": "faz-1-oss",
  "items": [
    {
      "id": "ic_20260907_1",
      "tema": "off-path-aussteigsgruende",
      "piler": "P1",
      "kaynak": "repo:src/lib/pipeline.ts#ON_PATH_STATUSES",
      "kanit": "13 aşamanın 2'si çıkış: INTERNSHIP_DROPPED_460, INTERNSHIP_FOUND_ELSEWHERE_800",
      "hint": "Huninin 13 aşamasından ikisinin çıkış olduğunu, çıkışın başarısızlık sayılmadığını anlat. Sadece başarıyı modelleyen program kendini kandırır fikri. Kanıt dosyada duruyor. Persona B'ye, program sorumlusu gözünden.",
      "audience": "persona-b",
      "dil": "de",
      "kategori": "Recruiting-Pipeline",
      "duzen": "screenshot",
      "zeitbezug": "immergruen",
      "gorsel": {
        "tur": "produkt-screenshot",
        "kaynakUrl": "https://demo.interncrm.com/admin/pipeline",
        "rol": "admin.demo@demo.example.com",
        "dosya": "gorseller/ic_20260907_1-pipeline-board.png",
        "durum": "cekilecek"
      }
    }
  ]
}
```

### 5.1 Alanlar

| Alan | Zorunlu | Değer | Not |
|---|---|---|---|
| `id` | ✔ | `ic_<YYYYMMDD>_<n>` | Parti içinde benzersiz. `ic_` = InternCRM; BCSIT hattının `f_` öneki ile karışmasın |
| `tema` | ✔ | kebab-case slug | **Tekrar engellemenin kararlı anahtarı** (§6). Ürün özelliğinin adı değil, **anlatılan fikrin** adı: `off-path-aussteigsgruende`, `blind-scorecard`, `warum-agpl` |
| `piler` | ✔ | `P1`…`P7` | `content-calendar.md` §4 pilerleri. Faz rotasyonu buradan denetlenir |
| `kaynak` | ✔ | `repo:<yol>` \| `docs:<yol>` \| `issue:#<n>` \| `release:releases/unreleased/<slug>.json` \| `research:<yol>` | Fikrin **nereden geldiği**. Endpoint'e `source` olarak `interncrm:` önekiyle gider |
| `kanit` | ✔ | tek satır TR | İddianın doğrulanabilir hâli. **Kanıtı olmayan fikir yazılmaz** (`content-calendar.md` §4, Y8) |
| `hint` | ✔ | **tek satır Türkçe, ≤400 karakter** | §5.2 |
| `audience` | ✔ | `persona-a` \| `persona-b` \| `oss` | §4 kotası bu alandan denetlenir |
| `dil` | ✔ | `de` \| `en` \| `tr` | Hattın yazacağı dil. Faz dilini `content-calendar.md` §1.5 belirler |
| `kategori` | ✔ | §3 tablosundaki 8 anahtardan biri | Endpoint'e `kategorie` olarak gider |
| `duzen` | ✔ | `screenshot` \| `carousel` \| `langform` \| `kurznotiz` \| `codebild` | Gönderi formatı (`content-calendar.md` §1.4). BCSIT'in `split`/`headline` meme düzenlerinin karşılığı — meme düzeni **kullanılmaz** |
| `zeitbezug` | ✔ | `immergruen` \| `zeitkritisch` | `Produkt-Update` ve sezon pencerelerine bağlı fikirler `zeitkritisch` |
| `gorsel` | ✔ | nesne (aşağıda) | Görselsiz fikir de olabilir: `{"tur": "yok"}` |
| `gorsel.tur` | ✔ | `produkt-screenshot` \| `codebild` \| `tablo` \| `carousel-pdf` \| `yok` | §7 |
| `gorsel.kaynakUrl` | koşullu | demo URL'i | `produkt-screenshot` ise zorunlu ve **demo.interncrm.com** ile başlamak zorunda |
| `gorsel.rol` | koşullu | demo hesabı | Hangi rolde giriş yapılıp çekileceği |
| `gorsel.dosya` | koşullu | `gorseller/<id>-<slug>.png` | Çekildikten sonra doldurulur |
| `gorsel.durum` | ✔ | `cekilecek` \| `hazir` \| `yok` | `hazir` olmayan görselli fikir hatta beslenmez |

### 5.2 `hint` kuralı — BCSIT'in "Almanca cümle yasağı"nın buradaki karşılığı

BCSIT hattında kural basitti: hint Türkçe yazılır, **Almanca cümle içeremez** — çünkü yayın dili
Almancaydı ve Almanca cümle yazmak metni yazmak demekti. InternCRM hattı **TR'de de yayınlıyor**,
yani dil temelli bir yasak burada işlemez: Türkçe hint ile Türkçe post metni aynı dilde.

**Kural dil temelli değil, biçim temelli olur.** `hint` bir **yön tarifi**dir, bir taslak değildir.
Aşağıdakilerden **herhangi biri** varsa hint reddedilir ve yeniden yazılır:

| Yasak | Örnek (yanlış) |
|---|---|
| Yayına hazır cümle — hangi dilde olursa olsun | `"Wir sehen im Alltag: Praktikanten verschwinden nach der ersten Mail."` |
| Tırnak içinde hazır kanca / açılış cümlesi | `"Şöyle başla: 'Bir stajyer kaybetmenin maliyeti…'"` |
| Kapanış sorusunun metni | `"Sonunda 'Wie macht ihr das?' diye sor"` |
| Hashtag, CTA metni, emoji | `"#Praktikum ile bitir"` |
| Almanca/İngilizce tam cümle (terim değil) | Terim serbest: `Berichtsheft`, `Werkstudent`, `duales Studium` |

**Doğru hint şu üçünü söyler:** (1) anlatılacak mekanizma, (2) hangi acıya oturduğu, (3) kime
hitap ettiği. Kanıt zaten `kanit` alanında. Örnek:

> "Haftalık raporun mentor onayından geçmesini anlat: rapor + mentor yorumu + onay damgası tek
> akışta. Excel'de tutulan Berichtsheft'in onay adımı kaybolur. Persona B'ye, koordinatör gözünden."

Metin yazmaya kalkarsan iki farklı ses çıkar ve hattın tekrar önleme mekanizması devre dışı kalır.
Örnek cümle yazma isteği geldiğinde dur: o iş hattın.

---

## 6. Tekrar engelleme

Kayıt dosyası: `<calisma-klasoru>/kullanilmis-temalar.json`. BCSIT hattının
`kullanilmis-formatlar.json`'unun karşılığı — **ayrı dosya**, asla aynı dosya (Z3).

```json
{
  "items": [
    {
      "tema": "off-path-aussteigsgruende",
      "piler": "P1",
      "kategori": "Recruiting-Pipeline",
      "kanit": "repo:src/lib/pipeline.ts#ON_PATH_STATUSES",
      "dil": "de",
      "usedAt": "2026-09-10",
      "durum": "yayinlandi"
    }
  ]
}
```

`durum`: `yayinlandi` | `onaylanmadi` (Telegram'da reddedildi) | `havuzda` (üretildi, seçilmedi).

**Karşılaştırma anahtarı `tema`**, `kaynak` değil — aynı dosyadan üç farklı fikir çıkabilir
(`pipeline.ts`'ten hem "13 aşama" hem "off-path" hem "index'leme bug'ı" çıkıyor). `usedAt` değeri
bugünün tarihi olan kayıtlar **kendi partisinin** çıktısıdır, filtrede sayılmaz.

| Kural | Süre | Neyi engeller |
|---|---|---|
| **T1 — aynı `tema`** | **90 gün** | Aynı fikri aynı sözlerle tekrar anlatmak. `durum: onaylanmadi` olanlar T1'e **girmez** (reddedilen fikir yeniden denenebilir) |
| **T2 — aynı `kaynak`** | **14 gün** | Aynı dosyadan/issue'dan arka arkaya içerik sağmak. 14 gün sonra aynı dosyadan **farklı bir tema** serbest |
| **T3 — aynı `piler` ana gönderide** | **üst üste 2 hafta yasak** | `content-calendar.md` §4 piler rotasyonu. İçerik yorgunluğu etkisi |
| **T4 — aynı ürün özelliği** | **çeyrekte en fazla 2 kez** | En sık düşülen tuzak: 46 özelliğin (`src/lib/features.ts`) 5'ini döndürüp durmak. `kanit` alanındaki dosya yolu/özellik anahtarı üzerinden sayılır |
| **T5 — temizlik** | 180 günden eski kayıtlar silinir | Dosya şişmesin. BCSIT'te 90 gün; burada içerik hacmi 1/7 olduğu için pencere iki katı |

**T4 özel notu:** bir özelliği ikinci kez anlatmak ancak **yeni bir açıdan** meşrudur —
birincisi "ne yapıyor", ikincisi "neden böyle karar verildi". Üçüncü açı yoktur; üçüncü kez
anlatılıyorsa havuz kurumuş demektir, `content-calendar.md` §4'ten yeni piler açılır.

---

## 7. Görsel politikası

BCSIT hattı görselini Cloudflare flux ile **üretiyor**. InternCRM hattında bu **varsayılan
değildir**: ürün iddiası taşıyan görsel üretilmez, **çekilir**.

| `gorsel.tur` | Kaynak | Ne zaman |
|---|---|---|
| `produkt-screenshot` | **Yalnız `https://demo.interncrm.com`** | Ürün yüzeyi anlatılıyorsa. Varsayılan seçim |
| `codebild` | Lokal depo, kod parçası görseli | `piler: P1/P2/P6/P7` teknik gönderileri |
| `tablo` | Depodaki tablo (ör. `docs/role-access-matrix.md`) | Karşılaştırma/matris anlatımı |
| `carousel-pdf` | Elle üretilen 8-12 slayt PDF | `duzen: carousel` |
| `yok` | — | Kısa build-in-public notu |
| ~~flux üretimi~~ | **Kullanılmaz** | Soyut/dekoratif görsel bir ürün iddiasını desteklemez; üstelik "AI görseli" bu kitlede güven düşürür |

### 7.1 Sert kurallar

- **GERÇEK PII ASLA.** Ekran görüntüsü **yalnız demo veya lokal sentetik veriden** alınır
  (`docs/DATA_ACCESS_POLICY.md`). Preview/prod ortamından alınmış görsel **çöpe gider**
  (`content-calendar.md` Y9) — preview yeşil aksan + "preview" rozetiyle tanınır
  (`src/lib/appEnv.ts`).
- **Demo banner'ı kırpılmaz.** `src/components/DemoModeBanner.tsx` görünür kalır: gösterilen
  verinin sentetik olduğu görselin kendisinden anlaşılsın.
- **Telifli karakter / marka yasağı.** Görselde tanınan kişi, karakter veya üçüncü taraf logosu
  bulunamaz; `hint` içinde de adı geçmez. Ekran görüntüsündeki demo şirket adları sentetiktir,
  sorun değil.
- **Sayı gösterme kuralı görselde de geçerlidir** (K2): ekran görüntüsündeki bir sayaç "müşteri
  sayısı" gibi sunulamaz. Demo verisi demo verisidir.

### 7.2 Ekran görüntüsü alma prosedürü

Demo günde iki kez sıfırlanıyor: **02:00 ve 14:00 UTC** (`.github/workflows/demo-reset.yml`).
Görsel çekmek için **sıfırlamadan hemen sonraki pencere** kullanılır — veri o an kanonik hâlindedir,
başka birinin demo üzerindeki denemeleri kadrajda görünmez.

1. **Ön kontrol:** `https://demo.interncrm.com` açılıyor mu, üç rolde giriş çalışıyor mu. Çalışmıyorsa
   Y1 devreye girer: görsel de gönderi de durur.
2. **Giriş:** `gorsel.rol` alanındaki hesapla — `admin.demo@demo.example.com` /
   `mentor.aylin@demo.example.com` / `mentee.deniz@demo.example.com`, parola `DemoPass123!`
   (`docs/DEMO.md`).
3. **Kadraj:** viewport **1440×900**, tarayıcı chrome'u kadrajda yok, **açık tema** (LinkedIn feed'inde
   koyu ekran görüntüsü kontrastı kaybediyor). Koyu tema yalnız gönderinin konusu koyu tema ise.
4. **Kırpma:** ilgili panele kırpılır, sol menü tam ya da hiç. Ok/çerçeve vurgusu tek renk, tek
   kalınlık; metin eklenmez (metni hat yazar).
5. **Kayıt:** PNG, uzun kenar ≥1.200 px, `gorseller/<id>-<slug>.png`.
6. **`fikirler.json` güncellenir:** `gorsel.dosya` doldurulur, `gorsel.durum` → `hazir`.
7. **OKUBENI.md:** klasöre dosya adı, fikir `id`'si, `tema`, hangi rolde/hangi URL'den çekildiği ve
   `hint`in ilk ~100 karakteri yazılır. Kullanıcı bu klasörü açıp doğru dosyayı Telegram'a
   sürükleyecek — dosyanın tek amacı budur.

**Nereye konur:** görseller **depoya commit edilmez** — çalışma klasöründe kalır (§9.2). İstisna:
bir görsel depodaki bir dokümanda kullanılacaksa normal PR süreciyle girer.

---

## 8. Yayın yasağı — kategorik (BCSIT hattından aynen devralınır)

Yayın yapma, hiçbir biçimde. Kural endpoint adına değil **sonuca** bağlıdır: bir eylem içeriği
LinkedIn yayın kuyruğuna sokabiliyorsa yapılmaz.

| | Eylem | Durum |
|---|---|---|
| ✅ | `/fikir/add` — **yalnızca** hat yapılandırma dosyası mevcutsa ve `line: "interncrm"` alanı doluysa | **Tek izinli yazma işlemi** |
| ❌ | `/linkedin/add`, `/api/posts` ve `autoposter.ersah.in` üzerindeki diğer **her** yazma endpoint'i | Yasak |
| ❌ | Autoposter panelini tarayıcıyla kullanmak (`/linkedin`, `/settings`, `/notlar` dahil) | Yasak |
| ❌ | Telegram'da `ok` / `retry` / `img` / `del` butonlarına basmak, bota mesaj yazmak | Yasak |
| ❌ | Chrome eklentisini tetiklemek | Yasak |
| ❌ | LinkedIn'e doğrudan istek (API, tarayıcı, herhangi bir yol) | Yasak |
| ❌ | LinkedIn şirket sayfası gönderisi atmak | Sayfa API'si partner-gated; **elle** atılır (`linkedin-playbook.md` §5.5) |

**Metni hat yazar.** Fikir besleyen taraf metin yazmaz — bu kuralın en sık sızdığı yer `hint`
alanıdır (§5.2). **Onay insanda kalır:** Telegram önizlemesini insan onaylar, yayın kararı insanındır.

Emin değilsen **YAPMA** ve brief'e not düş. İhlal görülürse hat durdurulur
(`go-to-market.md` R10, `linkedin-playbook.md` §8).

---

## 9. Entegrasyon TODO'su

### 9.1 Bilinmeyen: autoposter bugün ikinci hattı destekliyor mu

**Bilmiyoruz.** Bugünkü autoposter tek marka (bcsit GmbH) için kurulmuş; hat/kanal ayrımı olup
olmadığı doğrulanmadı. Doğrulama **insana** aittir (ajanın panele girmesi §8 gereği yasak).

Gereken alanlar — hat desteği varsa yapılandırılacak, yoksa açılacak:

| # | Gereksinim | Neden |
|---|---|---|
| G1 | **Hat/kanal ayrımı** — her fikir ve her gönderi bir `line` (`bcsit` \| `interncrm`) taşır | Z1-Z3. Fikir kuyruğu, gönderi geçmişi ve tekrar taraması hat bazında filtrelenmeli |
| G2 | **Hat başına kategori seti** | §3'teki 8 kategori BCSIT'in setinden tamamen farklı; tek listede birleşirlerse hat yanlış kategori seçer |
| G3 | **Hat başına sistem promptu / ses** | §2.2 ton kuralları. BCSIT'in "Wir sehen im Alltag:" kalıbı buraya sızarsa Z2 |
| G4 | **Hat başına dil** — `de` \| `en` \| `tr`, fikir seviyesinde | BCSIT tek dilli (DE). Burada dil fikirden gelir |
| G5 | **Hat başına hedef LinkedIn hesabı** | InternCRM kişisel profil + InternCRM şirket sayfası; bcsit sayfası değil |
| G6 | **Hat başına Telegram konusu/kanalı** | İki hattın önizlemeleri tek sohbette karışırsa yanlış butona basılır |
| G7 | **Hat başına tekrar taraması** | §6 kayıtları ayrı; "son gönderiler" taraması `line` ile filtrelenmeli |

### 9.2 Hat yapılandırma dosyası

BCSIT hattındaki `hat-ayari.json`'un karşılığı: **`hat-ayari-interncrm.json`** — ayrı dosya.
Dosya **yoksa POST edilmez** (§8).

```json
{
  "line": "interncrm",
  "endpoint": "https://autoposter.ersah.in/fikir/add",
  "supportsLineField": false,
  "calismaKlasoru": "content-interncrm/",
  "kategoriler": ["Praktikumsmanagement", "Ausbildung-Berichtsheft", "Mentoring-Programme",
                  "Recruiting-Pipeline", "Open-Source-Selfhosting", "Datenschutz-DSGVO",
                  "Markt-und-Preise", "Produkt-Update"]
}
```

`supportsLineField: false` iken **POST edilmez** — hat ayrımı yoksa fikir BCSIT kuyruğuna düşer ve
Z1-Z3'ün üçü birden gerçekleşir.

Alan eşlemesi (BCSIT sözleşmesiyle aynı şekil): `kategori` → `kategorie`, `zeitbezug` → `zeitbezug`,
`duzen` → `duzen`, `kaynak` → `source` (**`interncrm:` önekiyle**), `gorsel.dosya`/`kaynakUrl` →
`image_url`. `audience`, `piler`, `dil`, `kanit`, `tema` alanlarının endpoint karşılığı **olmayabilir**
— varsa gönderilir, yoksa `fikirler.json`'da kalır ve hint'in içinden zaten anlaşılır. `429`/`502`
yeniden denenmez; `duplicate` normal sonuçtur.

### 9.3 Destek yoksa — geçici çözüm (bugünün varsayılanı)

Hat ayrımı doğrulanana kadar **POST yok**. Akış tamamen elle:

1. Ajan `fikirler.json` + `gorseller/` + `brief.md` üretir, **depo altında**:
   `docs/marketing/ideas/<YYYY-MM-DD>/`. Bu klasör depoya girer (içerik sentetik ve public;
   PII yok) ve normal PR süreciyle merge edilir.
   **Görseller bu geçici çözümde de commit edilmez** — `docs/marketing/ideas/.gitignore` ile
   `gorseller/` hariç tutulur; klasör lokalde durur, insan Telegram'a oradan sürükler.
2. İnsan `brief.md`'yi okur, 3'ten 2'sini seçer (§4.1).
3. İnsan seçilen fikrin `hint`ini Telegram bot'a **elle** yazar, görseli forward eder.
4. Hat metni yazar, Telegram'da önizler; insan onaylar.
5. Yayın sonrası `kullanilmis-temalar.json` güncellenir (`durum: yayinlandi` + `usedAt`).

Bu çözüm §8'i ihlal etmez: ajan hiçbir yazma endpoint'ine dokunmaz, Telegram'a mesaj yazan da
butona basan da insandır.

---

## 10. Haftalık üretim akışı

| Adım | Girdi | Çıktı | Kim | Süre |
|---|---|---|---|---|
| **0. Idempotency** | `<klasor>/<YYYY-MM-DD>/fikirler.json` var mı | Varsa **hiçbir şey üretilmez**, üzerine yazılmaz; "bu haftanın fikirleri zaten üretilmiş (\<yol\>, \<generatedAt\>)" dönülür | Ajan | — |
| **1. Girdi toplama** | `content-calendar.md`'nin **o haftası** (faz, dil, baskın piler, sezon penceresi) + geçen hafta merge olan `releases/unreleased/*.json` fragmanları + `src/lib/releaseNotes.ts` diff'i + kapanan issue'lar + `src/lib/features.ts` diff'i | Ham malzeme listesi | Ajan | 5 dk |
| **2. Tekrar filtresi** | `kullanilmis-temalar.json` | T1-T5 elemesinden geçen aday temalar | Ajan | 2 dk |
| **3. Fikir üretimi** | Adım 1+2 | 6 fikir: 3 `persona-b`, 2 `persona-a`, 1 `oss`; kategori çeşitliliği sağlanmış | Ajan | 10 dk |
| **4. Doğrulama** | §11 listesi | Geçmeyen fikir yeniden yazılır | Ajan | 3 dk |
| **5. Görsel** | `gorsel.durum: cekilecek` olanlar | Ekran görüntüleri + `OKUBENI.md`, `durum: hazir` | İnsan (§7.2) | 20 dk |
| **6. Kısa liste + brief** | 6 fikir | `brief.md`: kaynak durumu (kaç aday bakıldı, kaçı neden düştü — **mahsul zayıfsa açıkça yaz, sahte iyimserlik yapma**), 3 kısa liste fikri, 1 asset ihtiyacı, 1 kanal işi | Ajan | 5 dk |
| **7. Seçim** | `brief.md` | 3'ten 2 seçilir; kalanlar havuza (`durum: havuzda`) | İnsan | 5 dk |
| **8. Hatta besleme** | Seçilen 2 fikir | `hat-ayari-interncrm.json` varsa POST; yoksa §9.3 elle akış | Ajan / İnsan | 5 dk |
| **9. İnsan onayı** | Telegram önizlemesi | Onay veya ret. **Ajan butona basmaz** (§8) | İnsan | 10 dk |
| **10. Kayıt** | Yayın sonucu | `kullanilmis-temalar.json` güncellenir; 180 günden eskiler temizlenir | Ajan | 2 dk |

Toplam ajan süresi ~27 dk, insan süresi ~40 dk (görsel dahil) — `content-calendar.md` §1.2'nin
haftalık ≤150 dk bütçesine sığar.

**Yayın öncesi son kapı:** `content-calendar.md` §6'daki Y1-Y10 yayınlamama kuralları **her hafta**
kontrol edilir. Y1 (demo çöktü) veya Y2 (prod sağlıksız) tetiklendiyse fikir üretimi de durur —
kırık bir ürünün içeriğini üretmenin anlamı yok.

---

## 11. Doğrulama listesi (her parti, adım 4)

```
[ ] 6 fikir, id'ler benzersiz, `ic_` önekli
[ ] Kitle dağılımı: 3 persona-b / 2 persona-a / 1 oss
[ ] Hiçbir kategori 3 kez geçmiyor; Produkt-Update en fazla 1
[ ] Her fikrin `kanit` alanı dolu ve doğrulanabilir (dosya yolu / URL / issue)
[ ] Hiçbir `tema` son 90 günde kullanılmamış (T1)
[ ] Hiçbir `kaynak` son 14 günde kullanılmamış (T2)
[ ] Baskın piler, geçen haftanın ana gönderi pileri DEĞİL (T3)
[ ] Hiçbir ürün özelliği bu çeyrekte 2 kezden fazla geçmiyor (T4)
[ ] Her `hint` ≤400 karakter, Türkçe, ve §5.2'deki yasak biçimlerden hiçbirini içermiyor
[ ] Hiçbir metinde kullanıcı/müşteri/mentor SAYISI yok (K2)
[ ] Hiçbir metinde "multi-tenant SaaS" / self-servis kaydol-kullan vaadi yok (K3)
[ ] Hiçbir metinde IHK-geçerli Ausbildungsnachweis / MÜDEK / OBS-BİLSİS iddiası yok (Y5)
[ ] Hiçbir metinde kesin fiyat rakamı yok (/pricing yayında değil — #1403)
[ ] Hiçbir görsel preview/prod ortamından değil; hepsi demo.interncrm.com veya lokal sentetik
[ ] Demo adresi yalnız https://demo.interncrm.com (crm-demo.ersah.in DEĞİL)
[ ] Hiçbir metinde/profilde bcsit GmbH hak sahibi gösterilmiyor
[ ] `gorsel.durum` hazır olmayan hiçbir fikir hatta beslenmedi
[ ] Hiçbir yazma endpoint'ine dokunulmadı; Telegram butonuna basılmadı (§8)
```

---

## 12. Başarı ölçüsü — hattın kendisi

Hattın işe yarayıp yaramadığı gönderi metriğiyle değil, **üretim sürtünmesiyle** ölçülür (içerik
metrikleri `content-calendar.md` §7'de):

| Ölçü | Hedef | Nerede görülür | Tutmazsa |
|---|---|---|---|
| Ajanın ürettiği 6 fikirden **en az 3'ünün** kısa listeye layık olması | ≥3/6 | `brief.md` | Kaynak havuzu kurumuş; §3'ten yeni kategori veya `content-calendar.md` §4'ten yeni piler açılır |
| Telegram önizlemesinin **ilk denemede** onaylanma oranı | ≥%50 | Onay/ret sayısı | Ses ayarı bozuk: §2.2 hat sistem promptuna geri beslenir (G3) |
| Haftalık insan süresi | ≤40 dk | Fiili | Görsel adımı (20 dk) en pahalı kalem; `carousel`/`kurznotiz` oranı artırılır |
| Yanlış hatta düşen fikir sayısı | **0** | BCSIT kuyruğu | G1 doğrulanana kadar §9.3 elle akışa dönülür |
| §8 ihlali | **0** | — | Hat durdurulur (`go-to-market.md` R10) |
