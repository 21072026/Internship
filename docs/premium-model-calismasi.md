# Premium Model Çalışması (Brainstorm)

> Durum: **Tartışma dokümanı** — uygulanmış hiçbir şey yok. Amaç, Internship CRM'in
> hangi katmanlarının ücretli hale getirilebileceğini, piyasa pratikleriyle birlikte
> değerlendirmek. (Temmuz 2026)

## İşletme modeli bağlamı

Bu çalışmanın çerçevesini belirleyen gerçek durum:

- Uygulamayı **tek kişi** (15+ yıl tecrübeli kurucu) geliştiriyor; tüm haklar onda.
- Mentee'ler mesleğe yeni başlayanlar ve mentorluk anlaşmasının parçası olarak
  **projeye emek vererek katkı** sağlıyorlar (kazan-kazan: piyasa tecrübesi ↔ emek).
- Yani uygulama aynı zamanda mentorluk programının **staj projesi**: ürün, eğitim
  aracı ve portföy tek gövdede.

Bunun premium modele üç doğrudan etkisi var:

1. **Mentee/mentor ücretsizliği tartışmasızdır** — mentee'ler yalnızca kullanıcı
   değil, ürünün emekçisi. Onlardan ücret istemek modelin kendisiyle çelişir.
2. **Geliştirme kapasitesi sınırlıdır** (1 deneyimli + junior'lar). Yol haritası
   "en az bakım yüküyle en erken gelir"e göre sıralanmalı; multi-tenancy gibi
   büyük yatırımlar ancak gelir doğrulandıktan sonra anlamlı.
3. **Hikâyenin kendisi satış argümanı**: "Bu platformdaki adaylar platformu bizzat
   inşa etti" — şirketlere aday kalitesini kanıtlayan, kopyalanması zor bir sinyal.
   Mevcut `Project` + `ProjectTask` modülü bu katkıyı zaten görünür kılıyor;
   premium aday profilinde öne çıkarılabilir.

**Dikkat edilmesi gereken iki nokta:**

- **Fikri haklar**: sözlü anlaşma yeterli değil; her katkı verenle "katkılar işverene
  aittir" maddesi içeren kısa yazılı bir katkı sözleşmesi (CLA benzeri) imzalanmalı.
  Ticarileşme anında geriye dönük hak iddiasını en baştan kapatır.
- **Veri erişimi**: katkı veren mentee'ler kod tabanında çalışırken **gerçek kullanıcı
  verisine** (paylaşılan preview DB dahil) erişmemeli. Ticarileşme öncesi, geliştirme
  ortamlarının seed/sahte veriyle çalışması kural haline getirilmeli — hem GDPR gereği
  hem Enterprise satışında sorulacak ilk soru.

## 0. Temel ilke: Mentee ve mentor her zaman ücretsiz

Bu varsayım **doğru** ve piyasa pratiğiyle birebir örtüşüyor:

- **Mentorluk platformları** (Mentorloop, Together, Chronus, MentorcliQ, Qooper):
  hiçbiri katılımcıdan (mentor/mentee) para almaz; **programı yürüten kurum** öder
  (katılımcı başına yıllık lisans ya da program paketi).
- **Yetenek pazaryerleri** (Handshake, RippleMatch vb.): aday her zaman ücretsizdir;
  **işveren** erişim için öder.
- Nedeni ekonomik: iki taraflı pazarda arz tarafı (yetenek + onları tanıyan mentorlar)
  **veri ve ağ etkisinin kaynağıdır**. Katılımcıya bariyer koymak huninin tepesini
  kurutur; `InteractionLog`, `Evaluation`, `PipelineStatus` gibi verilerin kalitesi
  düşer — ki satılabilir olan tam da bu verinin ürettiği içgörü.

**Sonuç:** "Premium mentee / premium mentor" asla olmamalı. Ödeme yapabilecek üç
taraf var: **şirketler**, **program yürüten kurumlar** (B2B) ve — dolaylı olarak —
**yerleştirme başarısı** (success fee).

Aynı sebeple ücret duvarının arkasına **asla konmaması** gerekenler: mesajlaşma,
toplantı/RSVP, hedefler, değerlendirmeler, etkileşim kayıtları, CV yükleme.
Bunlar veri üretimini besleyen çekirdek döngüdür; kısıtlanırsa ürünün değeri düşer.

## 1. Uygulamanın bugünkü değer envanteri

Premium'a dönüşebilecek varlıklar zaten kodda mevcut:

| Varlık | Mevcut durum | Premium potansiyeli |
|---|---|---|
| Pipeline verisi (`PipelineStatus`, `StatusChange`) | 13 aşamalı huni + denetim izi | Analitik, benchmark, success-fee ölçümü |
| `COMPANY` rolü + `CompanyInterest` (shortlist) + `CompanyNeed` | Şirketler adayları izleyip ilgi işaretliyor | **Ücretli şirket koltuğu / yetenek havuzu erişimi** |
| `SOURCE` rolü (eğitim kurumu/ajans) | Mentee kaynağı takibi | Kaynak kurumlara raporlama paneli (ücretli) |
| Analitik (funnel, aging, trend, mentor yükü) | Admin'e açık | Gelişmiş raporlama/ihracat katmanı |
| Webhook + API key + OpenAPI (`/api/v1`) | Temel altyapı hazır | Entegrasyon/API katmanı (ücretli) |
| AI CV çıkarımı (consent'li) | Opsiyonel, tek özellik | AI paketi (eşleştirme, özetleme, hazırlık) |
| GDPR consent + retention otomasyonu | Tam işleyen | Compliance/kurumsal güven — Enterprise satış argümanı |
| Çok dillilik (EN/TR/DE), tema, PWA | Hazır | Beyaz etiket (white-label) altyapısının yarısı |

## 2. Kim öder? Üç gelir hattı

### Hat A — Şirket tarafı (en hızlı uygulanabilir)

`COMPANY` rolü ve shortlist mekanizması zaten var; bugün şirketler yalnızca kendilerine
bağlanan (`MentorshipRelation.companyId`) adayları görüyor. Premium şirket koltuğu:

- **Yetenek havuzu erişimi**: `HIREABLE_600` / `JOB_SEEKING_500` aşamasındaki tüm
  adaylarda (mentee onayıyla) arama — beceri, seviye (`skillLevels`), şehir, üniversite,
  hedef pozisyon filtreleri.
- **Doğrulanmış profiller**: mentor değerlendirmeleri (`Evaluation`) ve proje geçmişi
  (`Project`) ile zenginleştirilmiş aday kartı — CV'den daha güvenilir bir sinyal;
  platformun kopyalanamaz farkı budur.
- **Erken erişim**: yeni `HIREABLE_600` olan adayların premium şirketlere X gün önce
  gösterilmesi.
- **İlan/kontenjan yönetimi**: `CompanyNeed` bugün pasif kayıt; premium'da eşleşen aday
  çıktığında otomatik bildirim + eşleştirme önerisi.
- **Çoklu kullanıcı**: şirket başına 1 gözlemci hesap ücretsiz, ek İK koltukları ücretli.

Fiyat modeli: aylık/yıllık şirket aboneliği (havuz erişimi) — basit ve öngörülebilir.

### Hat B — Success fee (pipeline verisinin benzersiz avantajı)

`HIRED_660` / `EMPLOYED_700` geçişi sistemde denetim iziyle (`StatusChange`) kayıtlı.
Yani "bu işe alım bu platform üzerinden oldu" iddiası **ölçülebilir**. Abonelik yerine
veya düşük abonelik + işe alım başına ücret (klasik staffing modelinin hafif sürümü).
Riski: şirketleri platform dışında anlaşmaya teşvik edebilir; bu yüzden genelde
"abonelik ana gelir + success fee opsiyonel" kurgusu daha sağlıklı.

### Hat C — B2B SaaS: platformu başka kurumlara satmak (en büyük fırsat)

Uygulama bugün tek kiracılı (tek organizasyonun CRM'i). Asıl ölçeklenebilir gelir,
aynı yazılımı **başka mentorluk/staj programlarına** (üniversite kariyer merkezleri,
bootcamp'ler, dernekler/NGO'lar, ticaret odaları, kurum içi mentorluk programları)
kiralamak. Piyasadaki Mentorloop/Together/Chronus tam olarak bunu yapıyor ve
katılımcı sayısına göre kuruma fatura kesiyor — katılımcı yine ücretsiz.

- **Free**: 1 program, ~25 aktif mentee, temel analitik, topluluk desteği.
- **Pro**: sınırsız mentee, cohort karşılaştırma, gelişmiş analitik, e-posta
  özelleştirme, öncelikli destek.
- **Enterprise**: SSO/SAML, beyaz etiket (kendi alan adı + logo + e-posta şablonları),
  API/webhook, SLA, veri işleme sözleşmesi (DPA), özel veri saklama politikaları.

Teknik maliyet: **multi-tenancy** (her modele `orgId`) — büyük ama tek seferlik yatırım.
Mevcut GDPR/consent/retention altyapısı Enterprise satışında ciddi bir artı.

## 3. Özellik bazında premium adayları

Ücretli katmana **girebilecekler** (veri üretimini kısıtlamayanlar):

1. **Gelişmiş analitik & raporlama** — cohort karşılaştırması (model hazır: `Cohort`),
   kaynak (`Source`) bazlı dönüşüm raporu, PDF/Excel ihracat, zamanlanmış e-posta
   raporları, program-arası benchmark ("sizin huni dönüşümünüz %X, ortalama %Y").
2. **AI paketi** (altyapı `cvExtractAi` ile başladı) — mentor-mentee eşleştirme önerisi
   (`/api/admin/suggest-mentors` zaten var; AI ile derinleştirilebilir), etkileşim
   kayıtlarının otomatik özeti, CV iyileştirme geri bildirimi, mülakat hazırlık asistanı.
   Önemli: AI çıktısını mentee **ücretsiz** alır — maliyeti kurum/şirket aboneliği taşır
   (kredi/kota modeli). Consent altyapısı hazır.
3. **Entegrasyonlar** — ATS (Greenhouse/Personio/Teamtailor), Slack/Teams bildirimleri,
   çift yönlü takvim senkronu (Google/Outlook; bugün tek yönlü ICS var), SCIM ile
   kullanıcı sağlama. Webhook/API-key temeli mevcut; ücretli katmanda genişletilir.
4. **Beyaz etiket & özelleştirme** — özel alan adı, logo, e-posta şablonları, özel
   pipeline aşamaları (bugün enum → ayarlanabilir hale getirmek gerekir).
5. **SOURCE kurumlarına rapor paneli** — kendi gönderdikleri mentee'lerin yerleşme
   başarısını gösteren pano; eğitim kurumları bu veriyi pazarlamada kullanır, ödemeye
   istekli olabilirler.
6. **Compliance+** — denetim log'u ihracı, gelişmiş saklama politikaları, DPA, bölgesel
   barındırma garantisi.

Ücretsiz **kalması gerekenler**: kayıt/davet, profil/CV, mesajlaşma, toplantılar,
hedefler, sorular, değerlendirmeler, kişisel notlar, temel pano ve pipeline yönetimi,
temel analitik (admin'in işini yapabilmesi için).

## 4. Önerilen kademelendirme (özet)

| Katman | Kime | İçerik | Model |
|---|---|---|---|
| **Free** | Mentor, mentee, (tek küçük program) | Çekirdek döngünün tamamı | Sonsuza dek ücretsiz |
| **Company** | İşe alan şirketler | Yetenek havuzu, doğrulanmış profil, erken erişim, eşleştirme bildirimi | Aylık abonelik (+ ops. success fee) |
| **Pro** | Program yürüten kurumlar | Sınırsız ölçek, gelişmiş analitik, AI paketi, kaynak raporları | Yıllık, aktif mentee başına |
| **Enterprise** | Büyük kurum/üniversite | SSO, beyaz etiket, API, DPA, SLA | Yıllık sözleşme |

## 5. Yol haritası önerisi

Tek geliştirici + junior katkı kapasitesine göre sıralandı: her faz kendi başına
değer üretir, bir sonrakine geçiş gelir/ilgi doğrulamasına bağlıdır. Fazların
alt görevleri aynı zamanda mentee'lere verilecek **staj görevleri** olarak
bölünebilir — ürün yol haritası ile mentorluk müfredatı bilinçli olarak örtüşür.

1. **Faz 0 — Entitlement altyapısı**: `Plan`/feature-flag katmanı (mevcut `Setting`
   modeli üzerinden başlanabilir), ücretli özellikleri kapıdan geçiren tek bir
   `hasFeature(org|company, key)` yardımcı fonksiyonu. Küçük, izole, junior-dostu.
2. **Faz 1 — Company premium** (mevcut tek kiracılı yapıda bile satılabilir):
   yetenek havuzu + erken erişim + eşleştirme bildirimi. En düşük teknik maliyet,
   en hızlı gelir doğrulaması. Faturalama manuel başlar (Stripe sonra).
3. **Faz 2 — AI paketi + gelişmiş analitik**: mevcut consent ve analytics API'lerinin
   üstüne inşa.
4. **Faz 3 — Multi-tenancy + Pro/Enterprise**: en büyük yatırım, en büyük pazar.
   Ancak Faz 1–2 gelir üretmeye başladıktan ve bakım yükü ölçüldükten sonra —
   tek kişilik çekirdek ekiple erkenden girilecek bir iş değil.

## 6. Açık sorular

- Ürünün hukuki/vergisel çerçevesi (şahıs mı, şirket mi; hangi ülke?) success-fee
  ve abonelik faturalamasını etkiler. Ticarileşmeden önce netleşmeli.
- Katkı sözleşmeleri: mevcut mentee'lerle yazılı IP devri var mı? Yoksa ilk iş bu.
- Yetenek havuzu görünürlüğü **mentee'nin açık rızasına** bağlanmalı (mevcut
  `publicProfile` + `UserConsent` deseni genişletilerek) — hem GDPR gereği hem güven.
- Katkı veren mentee'lerin gerçek kullanıcı verisine erişimi nasıl sınırlanacak?
  (Seed'li lokal geliştirme zorunluluğu + preview DB'nin anonimleştirilmesi.)
- Ödeme altyapısı (Stripe vb.) bu dokümanın kapsamı dışında; Faz 1'de manuel
  faturalama ile bile başlanabilir.
