# SaleVali satış iletişimi — kanal kuralları (UWG § 7 / DSGVO)

Issue #2576 · üst story #2575 · kardeş görev #2577 (izin kaydı) · epic #2348

> ### ⚠️ Keine Rechtsberatung / Hukuki danışmanlık değildir
>
> Bu doküman bir **mühendislik ve süreç metnidir**: satış ekibinin ve CRM'in aynı kuralları
> okuması için yazıldı. Hukuki tavsiye değildir ve bir avukatın değerlendirmesinin yerine
> geçmez. Kurallar bilerek **en dar ve en güvenli yorumla** yazıldı; sınıra yaklaşan her
> taktik "yasak" tarafındadır. Fiili outbound (satış ekibinin ilk soğuk teması, ilk bülten,
> ilk telefon kampanyası) başlamadan önce bir **Fachanwalt für IT-Recht** veya **Fachanwalt
> für gewerblichen Rechtsschutz** tarafından incelenmelidir.
>
> | Alan | Değer |
> | --- | --- |
> | Doküman sürümü | `2026-09-29` |
> | İnceleyen (Fachanwalt) | _— henüz incelenmedi —_ |
> | İnceleme tarihi | _— boş —_ |
> | İnceleme sonucu / notlar | _— boş —_ |
> | Bir sonraki gözden geçirme | İlk inceleme + 12 ay, veya UWG/DDG/DSGVO'da değişiklik olduğunda |
>
> İnceleme yapıldığında bu tablo doldurulur, avukatın itiraz ettiği her satır aynı PR'da
> düzeltilir ve doküman sürümü yükseltilir. İnceleme yapılmadan bu dosya "Fachanwalt onaylı"
> diye hiçbir yerde anılmaz.

## 0. Bu doküman neyi kapsar, neyi kapsamaz

- **Kapsar:** BCS-IT GmbH'nin **SaleVali** ürünü için potansiyel ve mevcut **B2B**
  müşterilere (online satıcılar, `salevali-domain.md`) yapılan reklam amaçlı temas — e-posta,
  telefon, LinkedIn/XING mesajı, posta — ve bu temasın CRM'de (MARKETING dikeyi) nasıl
  kaydedildiği.
- **Kapsamaz:** InternCRM'in kendi pazarlaması (o `docs/marketing/go-to-market.md` §7 ve
  `docs/marketing/copy-bank.md` §9'da; bu doküman onların hukuki çerçevesini SaleVali'ye
  uyarlar), işlemsel e-postalar (şifre sıfırlama, fatura, sistem bildirimi — reklam değildir,
  ama içine reklam eklenirse reklam olur, bkz. §2.6), B2C.
- **Sıralama:** Bu doküman ile `go-to-market.md` §7 çelişirse, **daha dar olan** kural geçerlidir
  ve çelişki bir issue olarak açılır.

## 1. İki ayrı katman: UWG ≠ DSGVO

Her temas iki ayrı sorudan **ikisini de** geçmek zorundadır. Birini geçmek diğerini geçmek değildir
(`go-to-market.md` §7.3):

| Katman | Soru | Temel hüküm | Yaptırım |
| --- | --- | --- | --- |
| **UWG** (Gesetz gegen den unlauteren Wettbewerb) | Bu kişiye **bu kanaldan** reklam gönderebilir miyim? | § 7 Abs. 1-3 UWG ("unzumutbare Belästigung") | Abmahnung → Unterlassungserklärung → Vertragsstrafe (rakipler, dernekler; ayrıca muhatabın kendisi BGB §§ 823, 1004 üzerinden) |
| **DSGVO** | Bu kişisel veriyi (ad, e-posta, telefon) bu amaçla **işleyebilir miyim**? | Art. 6 Abs. 1 lit. a (Einwilligung) veya lit. f (berechtigtes Interesse); Art. 7 (Nachweis), Art. 13/14 (Information), Art. 21 Abs. 2-3 (Widerspruch gegen Direktwerbung) | Aufsichtsbehörde (Art. 83), Schadensersatz (Art. 82) |

Pratik sonuç: DSGVO açısından Art. 6 Abs. 1 lit. f ile savunulabilen bir posta reklamı UWG'ye
takılmaz; ama e-postada **UWG § 7 Abs. 2 Nr. 2 Einwilligung ister**, ve orada lit. f **hiçbir
şey kurtarmaz**. Ayrıca UWG'deki rıza ile DSGVO'daki rıza aynı standarda bağlanır
(§ 7 Abs. 2 Nr. 2 UWG → Art. 4 Nr. 11, Art. 7 DSGVO: freiwillig, für den bestimmten Fall,
informiert, unmissverständlich).

## 2. Kanal × dayanak tablosu

CRM kodları #2577'nin önerdiği modelle **birebir aynıdır**:
kanal `EMAIL` / `PHONE` / `POST`, dayanak `DOI_CONFIRMED` / `EXISTING_CUSTOMER_7_3` /
`INQUIRY_REPLY` / `NONE`.

| Kanal (CRM) | Reklam için gerekli dayanak | İzinli CRM dayanakları | Yasak olan | Hüküm |
| --- | --- | --- | --- | --- |
| **E-posta** (`EMAIL`) | Önceden **ausdrückliche Einwilligung** — B2B'de de. Tek istisna § 7 Abs. 3 | `DOI_CONFIRMED`, `EXISTING_CUSTOMER_7_3`, `INQUIRY_REPLY` (yalnız sorulan soruya yanıt, bkz. §2.4) | Soğuk mail, "izin verir misiniz?" maili, satın alınmış liste, web'den toplanmış adres | § 7 Abs. 2 Nr. 2, Abs. 3 UWG; BGH 10.07.2018 – VI ZR 225/17 |
| **LinkedIn / XING DM, InMail, tanıtımlı bağlantı notu** | E-postayla **aynı rejim** ("elektronische Post") | `EMAIL` ile aynı; CRM'de ayrı kanal yok → `EMAIL` iznine bakılır (açık soru 3) | Soğuk DM, bağlantı isteğine reklam notu | OLG Hamm 03.05.2023 – 18 U 154/22 |
| **Faks / SMS / WhatsApp** | E-postayla aynı rejim | `EMAIL` ile aynı | Hepsi soğuk | § 7 Abs. 2 Nr. 2 UWG |
| **Telefon** (`PHONE`) | B2B: en azından **mutmaßliche Einwilligung** — kanıtlanabilir, somut bir bağ | `DOI_CONFIRMED` (telefon için açıkça verilmiş rıza), `INQUIRY_REPLY` (muhatap geri aranmayı istedi) | Liste/rehber numarasıyla kampanya, "sektör genelde faydalanır" gerekçesi, otomatik arama | § 7 Abs. 2 Nr. 1 UWG; BVerwG 29.01.2025 – 6 C 3.23 |
| **Posta / Briefwerbung** (`POST`) | UWG rıza istemez; DSGVO Art. 6 Abs. 1 lit. f + Art. 14 bilgisi + Art. 21 itiraz | `NONE` **yeterlidir**, bastırma listesinde değilse | Itiraz etmiş adrese göndermek, "Keine Werbung" levhalı posta kutusu, Art. 14 notu olmadan | § 7 Abs. 1 UWG; Art. 6(1)(f), 14, 21 DSGVO |
| **Yüz yüze / fuar / etkinlik** | Serbest; orada alınan rıza **yazıya geçirilir** | Sonradan e-posta için: `DOI_CONFIRMED` (kartvizit ≠ rıza, DOI maili yine gerekir) | Kartvizitle bültene eklemek | Art. 7(1) DSGVO |
| **Muhatabın kendi iletişim formu** | Kanalı karşı taraf açmış; serbest, ama formun amacına uygun | — (giden temas, CRM izni üretmez) | "Keine Werbung"/"nur Bewerbungen" diyen formlar | `copy-bank.md` §9.0 |

### 2.1 E-posta — en sık hata

- "B2B'de meşru menfaat yeter" **yanlıştır**. Telefondaki B2B hafifletmesi (mutmaßliche
  Einwilligung) e-postada **yoktur**.
- "İzin isteyen" ilk mail de reklamdır (Werbebegriff geniş; BGH VI ZR 225/17 memnuniyet
  anketini bile reklam saydı).
- Ortak kutu (`info@`, `kontakt@`) kişisel adres olmasa da UWG'ye tabidir — UWG kişisel veri
  değil, **alıcının rahatsız edilmemesi** sorusudur.
- Tek bir izinsiz mail bir Abmahnung için yeterlidir; Unterlassungserklärung imzalandıktan
  sonraki her mail Vertragsstrafe doğurur (`go-to-market.md` §7.4). Tek kişilik bir ekipte
  asıl risk ceza miktarı değil, **sistemin yanlışlıkla attığı tek mail**dir — bu yüzden §5'teki
  makine kuralı vardır.

### 2.2 Telefon

- B2B'de yeterli olan, muhatabın **somut ve kanıtlanabilir** bir ilgisidir: kendi yayımladığı
  ihtiyaç ilanı, etkinlikte "beni arayın" demesi, formda geri arama istemesi.
- BVerwG 6 C 3.23: yayımlanmış bir numara reklam aramasına yetki vermez; Art. 6(1)(f) de dayanak
  olmaz. Satın alınmış veya kazınmış numara listesiyle arama **yasaktır**.
- CRM'de `PHONE` izni yalnızca `DOI_CONFIRMED` (telefon kanalı için açıkça verilmiş, metni
  saklanan rıza) veya `INQUIRY_REPLY` ile verilir; bağın **ne olduğu** kanıt alanına yazılır.

### 2.3 Posta

- UWG § 7 yasak kataloğunda değildir — tek yasal "soğuk" outbound kanal budur
  (`go-to-market.md` §7.2, `copy-bank.md` §9.2).
- DSGVO şartları zorunludur: Art. 6 Abs. 1 lit. f için **yazılı Interessenabwägung notu**;
  Art. 14 bilgi notu (mektubun arkasında, `copy-bank.md` §9.2'deki DE şablonu SaleVali/BCS-IT
  için uyarlanır); Art. 21 Abs. 2 itiraz hakkına açık atıf; itiraz edenin **kalıcı** bastırılması.
- Verinin kaynağı (Art. 14 Abs. 2 lit. f) kaydedilir: hangi dizin, hangi site, hangi tarih.

### 2.4 `INQUIRY_REPLY` — sorulan soruya yanıt

- Muhatap bize **yazdı** (demo formu #2569, e-posta, telefon). Onun sorusuna yanıt reklam
  kısıtlamasına takılmaz — **ama yalnız o soruya**.
- Sınırları: (a) konu muhatabın sorduğu şeydir; (b) yanıt zinciri bittikten sonra bu dayanakla
  bülten, kampanya veya "yeni özelliklerimiz" maili **gönderilmez**; (c) sorulmamış ürün/ek
  paket teklifini aynı maile iliştirmek riskli bölgedir → yapılmaz.
- CRM'de süre sınırı önerisi: son gelen mesajdan **90 gün** sonra `INQUIRY_REPLY` artık yeni bir
  giden temasa dayanak olmaz (açık soru 4 — süre bir hukuki değer değil, iç tedbir).
- Demo formundaki **ürün haberleri kutusu** `INQUIRY_REPLY` üretmez; o bir DOI **talebidir**
  (§3.4).

### 2.5 `EXISTING_CUSTOMER_7_3` — § 7 Abs. 3 UWG istisnası

Dört koşul **birlikte** sağlanmalıdır; biri eksikse istisna yoktur ve e-posta için
`DOI_CONFIRMED` gerekir:

1. Adres, bir mal veya hizmetin **satışıyla bağlantılı olarak** (im Zusammenhang mit dem Verkauf)
   müşterinin kendisinden alındı.
2. Reklam yalnızca **benzer** (ähnliche) mal/hizmetler içindir — SaleVali müşterisine SaleVali
   modülleri; BCS-IT'nin başka bir ürünü (ör. InternCRM) **benzer sayılmaz**.
3. Müşteri bu kullanıma **itiraz etmedi**.
4. Adres alınırken **ve her mailde** açık ve kolay itiraz imkânı gösterildi; itirazın temel
   tarifeler dışında masraf doğurmadığı belirtildi.

**SaleVali için sınırlar (dar yorum):**

| Durum | § 7 Abs. 3? | Gerekçe |
| --- | --- | --- |
| Demo talebi (`CompanyInquiry`, `DEMO_SCHEDULED_300`) | **Hayır** | Satış yok |
| 30 günlük ücretsiz deneme (`TRIAL_ACTIVE_500`, `TRIAL_EXPIRED_600`) | **Hayır** | Deneme otomatik ücretli sözleşmeye dönmez (`salevali-domain.md` § Deneme); ücretsiz deneme bir "Verkauf" değildir — içtihat tartışmalı, dar yorum seçildi (açık soru 1) |
| Ücretli sözleşme, SEPA mandası `ACTIVE` (`CUSTOMER_ACTIVE_700`) | **Evet**, koşul 1'de adres satış sırasında müşteriden alındıysa ve koşul 4 kayıtta ilan edildiyse | Satış var |
| Fesih bildirimi verilmiş (`CANCELLATION_NOTICE_800`) | Evet ama **dikkatli** — "geri kazanma" maili benzer hizmettir; itiraz varsa hayır | Koşul 3 |
| Churn (`CHURNED_900`) | Makul süre sınırı (öneri: sözleşme bitiminden 12 ay) — içtihatta sabit süre yok (açık soru 2) | Bağlantı zamanla zayıflar |
| Satış sırasında alınmamış, sonradan bulunmuş başka bir çalışanın adresi | **Hayır** | Koşul 1: adres müşteriden alınmadı |

CRM kuralı: `EXISTING_CUSTOMER_7_3` **yalnızca elle**, yalnızca ücretli müşteride ve **gerekçe
metniyle** verilir (#2577 § 2). Hiçbir makine yolu onu yazamaz.

### 2.6 İşlemsel e-posta ile reklam arasındaki sınır

Fatura, deneme bitiş hatırlatması, sistem bildirimi reklam değildir **sürece** içlerinde reklam
yoktur. Deneme bitiş mailine "şimdi Pro'ya geçin, %20 indirim" eklemek o maili reklama çevirir
ve dayanağını gerektirir (BGH VI ZR 225/17 çizgisi; "Werbung in Transaktionsmails" tartışması).
Deneme süresince SaleVali'nin gönderdiği onboarding mailleri → açık soru 5.

## 3. Double-Opt-In (DOI) — ne saklanır

### 3.1 Akış

1. Form: **işaretsiz** (nicht vorangekreuzt), ayrı ve amaca özel bir kutu. Gizlilik onayına veya
   kullanım koşullarına bağlanmaz (Koppelungsverbot, Art. 7 Abs. 4 DSGVO).
2. Onay maili: **tarafsız** — içinde reklam yok, yalnız "bu adres için şunu istediniz, onaylıyor
   musunuz?" + onay bağlantısı + Impressum. Onay maili kendisi reklam sayılabileceği için
   (tartışmalı) içeriği kısa ve reklamsız tutulur.
3. Onay tıklaması → `DOI_CONFIRMED`. Tıklanmayan talep **hiçbir şey** değildir; hatırlatma maili
   gönderilmez.
4. Hız sınırı: alıcı başına en fazla **1 onay maili / gün** (#2577 § 3, `demo-form.md` § Rate
   limit) + formun mevcut `company-inquiry` kovası (saatte IP başına 3,
   `src/app/api/company-inquiry/route.ts:60`). Aksi halde form, üçüncü kişilere onay maili
   bombardımanı aracına dönüşür.

### 3.2 Kanıt kaydı (Art. 7 Abs. 1 DSGVO — ispat yükü gönderende)

| Alan | Neden | Bugün InternCRM'de |
| --- | --- | --- |
| E-posta adresi | Rızanın kime ait olduğu | `CompanyInquiry.email` |
| Talep zamanı | Ne zaman istendi | `CompanyInquiry.consentAt` (gizlilik onayı zamanı; talep ile aynı an) |
| **Form metninin sürümü** (tam metin geri üretilebilir olmalı) | "Neye rıza verdi?" sorusu | `marketingOptInTextVersion` = `MARKETING_OPT_IN_TEXT_VERSION` (`src/lib/privacy.ts:25`), dil = `locale` |
| Gizlilik metni sürümü | Art. 13 bilgilendirmesinin hangi hâli | `consentTextVersion` = `PRIVACY_POLICY_VERSION` (`src/lib/privacy.ts:19`) |
| **Onay mailinin** o tarihteki metni/sürümü | Onay neye yapıldı | **Yok** (onay maili yok) |
| **Onay tıklamasının zamanı** | DOI'nin kendisi | `marketingOptInConfirmedAt` — her satırda `NULL` (`prisma/schema.prisma:1624`) |
| Talep ve onay IP'si | İspat kalitesi; `go-to-market.md` §7.2 bunu listeler | **Bilinçli olarak yok** — `demo-form.md` § What is stored: "No IP address" (açık soru 6) |
| Opt-out zamanı ve kanalı | Rızanın bittiği an | #2577 modeli (`ContactPermission` opt-out zamanı) |

`go-to-market.md` §7.2, VG Düsseldorf'un (27.07.2026) yalnız adres + IP + zaman damgasını
**yetersiz** bulduğunu, form ve onay mailinin o tarihteki tam metninin de gerektiğini aktarır —
metin **sürümü** bu yüzden zorunludur ve sürüm yükseltildiğinde eski metin repo geçmişinden
(`src/i18n/dictionaries.ts` + git) geri üretilebilir olmalıdır. Karar kaynağı Fachanwalt
tarafından teyit edilmelidir (açık soru 7).

### 3.3 Rıza metninin içeriği

Metin şunları söyler: **kim** gönderecek (BCS-IT GmbH, SaleVali), **ne** (ürün haberleri — kapsamı
dar ve adlı), **hangi kanal** (yalnız e-posta; telefon ayrı kutu ve ayrı rıza), **nasıl geri
alınır** (her mailde bağlantı, Art. 7 Abs. 3). "Ve iş ortaklarımızdan teklifler" gibi geniş
ifadeler "für den bestimmten Fall" şartını boşa çıkarır → yasak.

### 3.4 Demo formundaki kutu bugün ne?

`CompanyInquiry.marketingOptInRequested` (`prisma/schema.prisma:1616`) bir **talep**tir, izin
değildir: herkes herkesin adresi için tikleyebilir. `marketingOptInConfirmedAt` dolmadıkça hiçbir
kod, dışa aktarım veya kişi bu değere dayanarak mail gönderemez (`demo-form.md`; şema yorumu
`prisma/schema.prisma:1611-1624`; sunucu yazımı `src/app/api/company-inquiry/route.ts:110-130`).
#2577 geldiğinde bu satır `ContactPermission(channel=EMAIL, basis=NONE)` + bekleyen DOI talebi
olarak taşınır; `DOI_CONFIRMED` yalnız onay tıklamasıyla oluşur.

## 4. SaleVali'nin newsletter bayrağı neden rıza değildir

SaleVali kaydında (ayrı repo `BCS-IT-Gmbh/salevali-client`, `salevali-server`; 2026-09-29'daki
yerel checkout'ta doğrulandı):

- **Form:** `salevali-client/src/app/pages/auth/Registration.jsx:45` — Formik
  `initialValues` içinde `newsletter: true`. Kutu **önceden işaretli** gelir. (Issue metni :46
  diyor; satır bugün :45.) Aynı nesnede `acceptTerms: true` da önceden işaretli (:44) — ayrı bir
  sorun, bu dokümanın kapsamı dışında ama not edildi.
- **Google ile kayıt:** `salevali-server/src/controllers/users/user.controller.ts:1741` —
  gövdede `newsletter` yoksa varsayılan `true`; değer `performGoogleRegister` (:1781 → :1942)
  üzerinden kullanıcıya yazılır. Kullanıcı hiçbir kutu görmeden "abone" olur.
- **Standart kayıt:** `user.controller.ts:243` gövdeden `newsletter` alır, :301'de yazar — form
  varsayılanı `true` olduğu için sonuç aynıdır.
- **DOI yok.**

Neden rıza sayılmaz:

1. **Önceden işaretli kutu geçerli Einwilligung değildir** — EuGH 01.10.2019, C-673/17
   (*Planet49*); BGH 28.05.2020 – I ZR 7/16 (*Cookie-Einwilligung II*). Art. 4 Nr. 11 DSGVO
   "eindeutige bestätigende Handlung" ister; susmak veya işareti kaldırmamak eylem değildir.
2. Google yolunda kutu **hiç gösterilmez**: bilgilendirilmiş rıza (informiert) olamaz.
3. DOI olmadığı için adresin sahibinin tıkladığı **kanıtlanamaz** (Art. 7 Abs. 1).
4. Kayıt bir **deneme** kaydıdır, satış değildir → § 7 Abs. 3 de kapsamaz (§2.5).

**CRM kuralı:** SaleVali'den gelen `newsletter` değeri — kullanım beslemesi
(`salevali-usage-feed.md`, #2445), import veya başka bir yol üzerinden — **hiçbir dayanak
üretmez**; CRM onu okusa bile `NONE` yazar (#2577 § 2). Eski kayıtlarda `newsletter = true`
olan kullanıcılar için yeniden DOI kampanyası **e-postayla yapılamaz** (izin isteyen mail de
reklamdır, §2.1); yeni rıza yalnız ürün içinde (oturum açmış kullanıcıya gösterilen işaretsiz
kutu + DOI) alınabilir. Önceden işaretli kutunun kaldırılması ve DOI, SaleVali tarafının işidir
(#2575'te belirtildiği gibi #2565'te listelenir) — bu repo onu düzeltmez.

## 5. Makine yolları: `NONE`'dan başka bir şey yazamaz

Kural (#2577 § 2): **hiçbir otomatik yol bir iletişim izni üretemez.** Yalnız iki şey izin üretir:
bir insanın gerekçeli kararı (`EXISTING_CUSTOMER_7_3`, `INQUIRY_REPLY`) ve adres sahibinin onay
tıklaması (`DOI_CONFIRMED`).

| Yol | Yazabileceği dayanak | Not |
| --- | --- | --- |
| CSV/roster import (`src/lib/marketingImport.ts`; lead'ler stand-in `User`, `leadStandInEmail` :244) | `NONE` | Kaynak dosyada "opt-in: yes" sütunu olsa bile — o sütunun kanıtı bizde yok |
| SaleVali kullanım beslemesi / ingest (`salevali-usage-feed.md`, #2445) | `NONE` | `newsletter` bayrağı dahil (§4) |
| Kayıt birleştirme / duplicate merge | Mevcut izinleri **korur**, yenisini üretmez; iki kayıttan daha dar olan kazanır | Açık soru 8 |
| Demo formu (`POST /api/company-inquiry`) | `NONE` + DOI talebi | Kutu tiklense bile |
| DOI onay tıklaması (oturumsuz) | `DOI_CONFIRMED` — tek otomatik istisna, çünkü kanıt adres sahibinin eylemidir | `orgId`'yi kendisi geçer (CLAUDE.md § Multi-tenancy) |
| Opt-out tıklaması / `List-Unsubscribe` (one-click) | İzni **geri alır**; hiçbir zaman vermez | `src/app/api/unsubscribe/one-click/route.ts`, `src/services/emailService.ts:389-390` kalıbı |
| AI çıkarımı, e-posta imzasından ayrıştırma, web kazıma | `NONE` | — |

Birim testi bu kuralı kilitler (#2577 kabul kriteri 1).

## 6. Gönderen kimliği, Impressum ve opt-out altbilgisi

Her giden **reklam** iletisinde (e-posta, DM, mektup):

| Şart | Kaynak | SaleVali için |
| --- | --- | --- |
| Gönderenin kimliği gizlenmez; gerçek şirket adı | § 7 Abs. 2 Nr. 3 UWG (a.F. Nr. 4) — rıza olsa bile ihlal | "BCS-IT GmbH · SaleVali", kişi adıyla |
| İtiraz için **geçerli bir adres** (masrafsız, temel tarife dışı ücret yok) | § 7 Abs. 2 Nr. 3, Abs. 3 Nr. 4 UWG | Okunan bir Reply-To; `noreply@` tek başına **yetmez** (`copy-bank.md` §9.0) |
| Ticari iletişimin tanınabilirliği, göndericinin açıkça belirlenmesi | § 6 Abs. 1 DDG (eski § 6 TMG) | Konu satırı reklam niteliğini gizlemez |
| Impressum | § 5 DDG — kolay fark edilir, doğrudan ulaşılabilir, sürekli erişilebilir; ticari sosyal medya profilleri dahil | Her mailin altbilgisinde Impressum **bağlantısı**; LinkedIn şirket sayfasında Impressum bağlantısı |
| Her mailde opt-out bağlantısı + tek tıkla abonelikten çıkış | Art. 7 Abs. 3, Art. 21 Abs. 3 DSGVO; § 7 Abs. 3 Nr. 4 UWG | `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058), bu repoda `src/services/emailService.ts:389-390` |
| Posta: Art. 14 bilgi notu | Art. 14 DSGVO | Mektup arkası, `copy-bank.md` §9.2 şablonu BCS-IT'ye uyarlanır |

**Impressum'da kim yazar?** InternCRM'in `/imprint` sayfası (`src/app/imprint/page.tsx`) kimliği
**deployment ortamından** okur (`operatorIdentity()`, `src/lib/imprint.ts`) — host'a göre değişmez.
Aynı container `marketing.bcsit-gmbh.de`'yi de sunduğu için (CLAUDE.md § Deployment, #2540) o host
üzerindeki Impressum bugün **InternCRM operatörünü** gösterir. SaleVali reklamının Impressum'u ise
**BCS-IT GmbH**'yi göstermelidir. Bu, ilk SaleVali reklam mailinden önce çözülmesi gereken bir
**sert blokajdır** (açık soru 9). IP sahipliği kuralı (CLAUDE.md § Licensing) burada ilgisizdir:
Impressum **hizmet sağlayıcıyı** gösterir, yazılımın hak sahibini değil.

Altbilgi şablonu (DE, doldurulacak):

```text
BCS-IT GmbH · SaleVali · <Anschrift> · Impressum: <URL>
Sie erhalten diese E-Mail, weil <Grund: Sie haben am <Datum> bestätigt … | Sie sind Kunde von SaleVali>.
Keine weiteren E-Mails: <Abmelde-Link> — oder antworten Sie einfach auf diese E-Mail.
```

"Neden bu maili alıyorsunuz" satırı dayanağın kendisini söyler: `DOI_CONFIRMED` → onay tarihi;
`EXISTING_CUSTOMER_7_3` → müşteri olduğu + itiraz hakkı.

## 7. Kayıt tutma (Rechenschaftspflicht, Art. 5 Abs. 2 DSGVO)

Kaydın tutulduğu **yer** değil **varlığı** zorunludur. CRM'de tutulması gerekenler:

| Kayıt | Nerede (hedef) | Saklama |
| --- | --- | --- |
| İzin satırı: kanal, dayanak, kanıt (metin sürümü, talep zamanı, onay zamanı), opt-out zamanı | `ContactPermission` (#2577, `TENANT_MODELS`'e kayıtlı) | İzin geçerli olduğu sürece + ispat için makul süre (açık soru 10) |
| `EXISTING_CUSTOMER_7_3` / `INQUIRY_REPLY` gerekçesi ve veren admin | İzin satırı + `ActivityLog` | Aynı |
| Posta kampanyası: veri kaynağı, tarih, Interessenabwägung notu, Art. 14 notunun gönderildiği an | Kampanya kaydı (henüz yok) | Kampanya + 3 yıl (öneri) |
| **Bastırma listesi (Sperrliste)** — itiraz eden her adres, kanal başına | Silme yüzeyi (#2559) sonrasında yalnız **hash** + opt-out zamanı + kanal | Süresiz — silinen kişiye tekrar yazmamanın tek yolu; gerekçe #2577 § 6'da yazılır |
| İtirazlar ve yanıtlar | `ActivityLog` | — |

Bastırma listesi her dayanaktan **önce** gelir: bastırılmış bir adres için `DOI_CONFIRMED` dahi
yeniden verilmez, yalnız adres sahibinin yeni bir DOI tıklaması kaydı açar.

## 8. CRM'in uyguladığı ve uygulamadığı

| Kural | CRM uygular mı? | Nasıl / neden değil |
| --- | --- | --- |
| Makine yolları yalnız `NONE` yazar | **Evet** (#2577) | Birim testi |
| DOI tıklaması → `DOI_CONFIRMED`; opt-out geri alır | **Evet** (#2577) | e2e |
| Alıcı başına günde 1 onay maili | **Evet** (#2577) | e2e |
| `EXISTING_CUSTOMER_7_3` yalnız ücretli müşteride, elle, gerekçeyle | **Kısmen** — elle ve gerekçe zorunlu; "ücretli mi" kontrolü aşamaya (`CUSTOMER_ACTIVE_700`) bakabilir ama koşul 1'i (adres satış sırasında mı alındı) **doğrulayamaz** | İnsan kararı |
| İzni olmayan hesapta e-posta aksiyonu uyarı gösterir | **Evet — uyarı, engel değil** (#2577 § 4) | CRM, bir insanın elle attığı maili durduramaz (dış posta istemcisi) |
| LinkedIn/XING DM yasağı | **Hayır** | CRM DM göndermez; kural satış ekibinin disiplinidir |
| Telefon araması için somut bağ | **Hayır** — yalnız `PHONE` izin satırını ve gerekçesini gösterir | Aramanın kendisi CRM dışında |
| Posta: Art. 14 notu, "Keine Werbung" levhası | **Hayır** | Süreç |
| Rıza metninin doğru, dar ve işaretsiz olması | **Kısmen** — metin sürümü damgalanır; metnin hukuki yeterliliği Fachanwalt'ın işi | — |
| İşlemsel maile reklam eklenmemesi | **Hayır** | Metin yazarı + gözden geçirme |
| SaleVali'nin önceden işaretli kutusu | **Hayır** — bu repo dışında | #2565 (SaleVali karşı işi) |
| Impressum doğru kimliği gösterir | **Hayır, bugün yanlış kimlik** (§6) | Açık soru 9 |

"Hayır" satırları için satış ekibinin tek kontrolü bu dokümandır; bir CRM uyarısının yokluğu
**izin anlamına gelmez**.

## 9. Kaynaklar

Kanun metinleri:

- UWG § 7 — https://www.gesetze-im-internet.de/uwg_2004/__7.html
- UWG § 13 (Abmahnung) — https://www.gesetze-im-internet.de/uwg_2004/__13.html
- DDG § 5 (Impressum) — https://www.gesetze-im-internet.de/ddg/__5.html
- DDG § 6 (kommerzielle Kommunikation) — https://www.gesetze-im-internet.de/ddg/__6.html
- DSGVO Art. 4, 6, 7, 13, 14, 21 — https://dsgvo-gesetz.de/art-6-dsgvo/ ·
  https://dsgvo-gesetz.de/art-7-dsgvo/ · https://dsgvo-gesetz.de/art-14-dsgvo/ ·
  https://dsgvo-gesetz.de/art-21-dsgvo/

Kararlar:

- EuGH 01.10.2019 – C-673/17 *Planet49* — https://curia.europa.eu/juris/liste.jsf?num=C-673/17
- BGH 28.05.2020 – I ZR 7/16 *Cookie-Einwilligung II* — https://juris.bundesgerichtshof.de/cgi-bin/rechtsprechung/document.py?Gericht=bgh&Art=en&nr=107623
- BGH 10.07.2018 – VI ZR 225/17 (Kundenzufriedenheitsbefragung = Werbung) — https://www.lhr-law.de/magazin/wettbewerbsrecht-kartellrecht/kundenzufriedenheitsumfrage-e-mail-werbung-ordnungsgeld/
- OLG Hamm 03.05.2023 – 18 U 154/22 (LinkedIn-DM = elektronische Post) — https://medien-internet-und-recht.de/volltext.php?mir_dok_id=3302
- BVerwG 29.01.2025 – 6 C 3.23 (B2B-Telefonwerbung) — https://www.bverwg.de/290125U6C3.23.0
- VG Düsseldorf 27.07.2026 (DOI-Nachweis), `go-to-market.md` §7.2 üzerinden — https://shopbetreiber-blog.de/vg-duesseldorf-nachweispflichten-beim-double-opt-in-verfahren

Bu repoda:

- `docs/marketing/go-to-market.md` §7 (InternCRM için aynı çerçeve; bağlayıcı) ·
  `docs/marketing/copy-bank.md` §9.0 (kanal tablosu), §9.2 (Art. 14 mektup şablonu), §9.7 (DOI akışı)
- `docs/marketing-vertical/demo-form.md` (demo formu, ne saklanır)
- `docs/marketing-vertical/salevali-domain.md` (deneme ve yaşam döngüsü)
- `docs/marketing-vertical/salevali-usage-feed.md` (besleme sözleşmesi)
- `prisma/schema.prisma:597-645` (`ConsentType`, `UserConsent` — pazarlama türü yok),
  `:1590-1624` (`CompanyInquiry` rıza alanları)
- `src/lib/privacy.ts:19,25` (metin sürümleri) · `src/lib/newsletterTokens.ts` (DOI için token kalıbı)

## 10. Maintainer / Fachanwalt için açık sorular

1. **Ücretsiz deneme § 7 Abs. 3 anlamında "Verkauf" mı?** Doküman dar yorumu seçti (hayır).
   Literatürde ücretsiz sözleşmeleri de kapsayan görüş var; avukat teyidi gerekli.
2. **Churn sonrası § 7 Abs. 3 ne kadar sürer?** 12 ay öneri, hukuki bir sabit değil.
3. **LinkedIn/XING DM ayrı bir CRM kanalı mı olmalı?** #2577 yalnız `EMAIL/PHONE/POST` öneriyor;
   doküman DM'i `EMAIL` iznine bağladı. Ayrı `SOCIAL_DM` kanalı istenir mi?
4. **`INQUIRY_REPLY` süre sınırı** (öneri 90 gün) CRM'de zorlanacak mı, yoksa yalnız uyarı mı?
5. **SaleVali deneme süresindeki onboarding/aktivasyon mailleri** işlemsel mi reklam mı? İçerikleri
   denetlenmeli.
6. **DOI kanıtında IP.** `go-to-market.md` §7.2 IP'yi listeliyor; `demo-form.md` bilinçli olarak IP
   saklamıyor (veri minimizasyonu). Onay tıklamasında IP (veya hash'i) saklanmalı mı?
7. **VG Düsseldorf 27.07.2026 kararı** yalnız ikincil kaynaktan (blog) alındı; dosya numarası ve
   tam metin teyit edilmeli.
8. **Duplicate merge'de iki farklı izin** — "daha dar olan kazanır" kuralı uygun mu?
9. **Impressum kimliği (sert blokaj):** `marketing.bcsit-gmbh.de` host'unda BCS-IT GmbH'yi
   gösteren bir Impressum nasıl yayınlanacak — host başına operatör kimliği (`src/lib/imprint.ts`
   değişikliği, ayrı issue) mi, yoksa SaleVali'nin kendi Impressum URL'sine bağlantı mı?
10. **Saklama süreleri:** izin kanıtı ve kampanya kayıtları için süre (öneri: izin bitiminden
    sonra 3 yıl, § 195 BGB Regelverjährung paraleli) avukatla belirlenmeli.
11. **`acceptTerms: true`** (`Registration.jsx:44`) — önceden işaretli AGB/gizlilik kutusu;
    #2565'e eklenmeli mi?
