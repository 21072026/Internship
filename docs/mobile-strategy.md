# Mobil strateji: PWA, mağaza kabukları ve çevrimdışı (#2085)

> **Karar — 2026-10-05 (maintainer):** ikinci bir native istemci **yok**. Android için
> Play Store'a bir **Trusted Web Activity (TWA)** kabuğu, şimdi. iOS için mağaza kabuğu
> yalnızca somut bir müşteri / RFP talebiyle. Gerçek çevrimdışı mod ertelendi.
> Mağaza hesapları **bcsit GmbH** adına açılır.

| | Karar | Durum |
|---|---|---|
| PWA (kurulabilir, Web Push, kısayollar, share target) | Ana mobil istemci olarak kalır | Canlıda (`src/app/manifest.ts`, `public/sw.js`) |
| Android — Play Store | TWA (Bubblewrap), iki kayıt: InternshipCRM + SaleVali | **Faz 1 başladı** — bu doküman + `mobile/android/` + `android-build.yml` |
| iOS — App Store | Capacitor kabuğu + native eklentiler, **talep olursa** | Ertelendi (§ iOS) |
| React Native / Flutter / Swift+Kotlin | Yapılmayacak | — |
| Gerçek çevrimdışı (mentee listesi, kuyruklu yazma) | Ertelendi, önce ölçüm | — |

## Neden ikinci bir native istemci değil

Mobilde yapılan iş mesaj, push, yapılacaklar ve toplantı; hepsi PWA'da zaten var.
Admin'in işi (pipeline panosu, geniş tablolar) masaüstünde. Native bir istemci bunlara
yeni bir yetenek eklemez, ama bu kod tabanının üç temel varsayımını bozar:

1. **Her merge anında canlı.** Bugün `main`'e giren her şey dakikalar içinde prod'da ve
   her kurulu PWA'da. Native bir istemcide sahada eski sürümler kalır; API'nin
   sürümlenmesi ve geriye uyumlu tutulması gerekir. TWA bu varsayımı korur: kabuk canlı
   siteyi açar, web deploy'u uygulamaya kendiliğinden ulaşır.
2. **Çerez tabanlı güvenlik modeli.** NextAuth JWT çerezi, remember-me rotasyonu
   (`docs/remember-me.md`), 2FA, CSRF kapısı (`src/middleware.ts`) ve SW önbellek
   kuralları (#1550) tarayıcıya göre kurulu. Native istemci token tabanlı ikinci bir
   auth yolu ister. TWA Chrome'un çerez kavanozunu kullanır: değişiklik sıfır.
3. **Tek okuma yolu.** Gerçek zamanlı akış yalnızca id taşır, istemci yetkili uçtan
   okur (`docs/realtime-and-push.md`). İkinci istemci, ikinci bir okuma yüzeyi demek.

## Android — Trusted Web Activity (Faz 1)

TWA, siteyi Chrome'da tam ekran açan ince bir Android kabuğudur. URL çubuğu yalnızca
**site uygulamaya kefil olursa** kalkar: host'taki `/.well-known/assetlinks.json`
uygulamanın paket adını ve imza sertifikasının SHA-256'sını listelemelidir. Kefalet
yoksa uygulama yine çalışır, ama URL çubuklu bir Custom Tab olarak — mağaza kaydının
var olma sebebi olan görünümün tam tersi.

### İki dünya, iki uygulama

Oturum açılan host ürünü seçer (`docs/worlds.md`) ve bir TWA tek bir host'a bağlıdır.
Bu yüzden iki ayrı Play kaydı var:

| Uygulama | Paket adı | Host | Yapılandırma |
|---|---|---|---|
| Internship CRM | `de.bcsitgmbh.interncrm` | `interncrm.com` | `mobile/android/interncrm/twa-manifest.json` |
| SaleVali | `de.bcsitgmbh.salevali` | `marketing.bcsit-gmbh.de` | `mobile/android/salevali/twa-manifest.json` |

**Paket adları kalıcıdır.** Play yayımlanmış bir paketin adını değiştirtmez. Ad,
yayıncının (bcsit GmbH, `bcsit-gmbh.de`) ters alan adından gelir. Java paket
segmentinde tire geçersiz olduğu için `bcsitgmbh`. Paket adı iki yerde duruyor
(`src/lib/androidAppLinks.ts` ve `twa-manifest.json`), ve
`npm run test:android-app-links` ikisini karşılaştırır.

**Kapsam dışı:** kendi alan adındaki white-label tenant'lar (#546). Bir mağaza
uygulaması tek bir origin'e kefalet alır. Bu tenant'lar PWA'yı kullanmaya devam eder.

### Repoda olanlar

- `src/lib/androidAppLinks.ts`: paket adları, SHA-256 parmak izleri ve
  `assetLinksFor(vertical)`. Saf fonksiyon, birim testli. Parmak izleri **kodda**
  durur, env'de değil. Bunlar zaten herkese açık bilgi, ve env'e konan bir değerin
  `infra/deploy-prod.sh`, `topic-deploy.sh` ve sunucudaki env dosyası olmak üzere üç
  ayrı yerde unutulma riski var. Bozuk biçimli bir parmak izi sunulmak yerine
  **hata fırlatır**, çünkü doğrulayıcı bütün ifadeyi sessizce reddederdi.
- `src/app/.well-known/assetlinks.json/route.ts`: host'un vertical'ine göre ifade
  döner (`hostVertical()`, çerezsiz). Parmak izi yokken `[]` döner; bu "ilişki yok"
  demektir, yani bugünkü davranışla aynıdır.
- `mobile/android/<app>/twa-manifest.json`: Bubblewrap yapılandırması. Değerler canlı
  manifest'ten türetildi: aynı ikonlar, kısayollar, `share_target`, tema rengi
  (`THEME_COLOR`, `src/lib/accent.ts`) ve `orientation: any` (#2084). Ayrıca
  `enableNotifications: true` açık: Web Push bildirimleri Chrome'un değil
  **uygulamanın** adıyla görünür (notification delegation) ve Android 13+ izin
  diyaloğunu uygulama sorar.
- `mobile/android/generate-project.mjs`: manifest'ten Gradle projesini üretir
  (`@bubblewrap/core`). Gradle projesi **commit edilmez**, her build'de yeniden
  üretilir. Bubblewrap şablonundaki bir güncelleme böylece 40 dosyalık bir diff
  olmadan uygulamaya ulaşır.
- `.github/workflows/android-build.yml`: `ubuntu-latest` üzerinde çalışır (sunucuda
  derleme yok). `mobile/android/**`'a dokunan PR'larda iki uygulamanın imzasız
  bundle'ını derler (kırılma koruması). `workflow_dispatch` ile seçilen uygulamayı
  upload key ile imzalar ve `.aab`'yi artifact olarak yükler.

Doğrulama (2026-10-05, bu ortamda): her iki manifest `TwaManifest.validate()`'ten
geçti. Üretilen proje (targetSdk 36, Gradle 8.11.1) `bundleRelease` ile derlendi.
Geçici bir anahtarla `jarsigner` imzası ve doğrulaması çalıştı. Dev sunucusunda
`/.well-known/assetlinks.json` her iki host'ta `200 application/json` döndü, ve geçici
bir parmak iziyle yalnızca o host'un paketini listeledi.

### Hesap ve hukuki ön koşullar (yayından önce, bu sırayla)

1. **Hak sahibinden bcsit GmbH'ye yazılı dağıtım lisansı.** Yazılımın hak sahibi
   Mehmet Erşahin'dir (gerçek kişi). Mağazada yayıncı bcsit GmbH olacağı için GmbH,
   hakkı kendisinde olmayan bir yazılımı dağıtmış olmasın diye
   `docs/legal/legal-tax-framework.md`'nin "GmbH seçilirse" maddesindeki münhasır
   olmayan dağıtım lisansı **ilk yüklemeden önce** imzalanmalı. Bu yalnızca dağıtım
   kararıdır: faturalayan taraf kararı hâlâ ilk satışa ertelenmiş durumda, ve hak
   sahipliği değişmez.
2. **D-U-N-S numarası** (bcsit GmbH için). Play organizasyon hesabı bunu istiyor; Apple
   da ileride aynı numarayı isteyecek.
3. **Play Console organizasyon hesabı** (bir kerelik 25 USD). Organizasyon hesabı,
   2023 sonrası açılan kişisel hesaplara getirilen "12 testçi × 14 gün kapalı test"
   şartına tabi değil.
4. **AB DSA satıcı (trader) beyanı.** Adres, telefon ve e-posta mağazada herkese açık
   yayımlanır. SaleVali için `MARKETING_OPERATOR_*`, InternshipCRM için `OPERATOR_*`
   Impressum değerleriyle tutarlı olmalı.

### Mağaza kaydı kontrol listesi (uygulama başına)

- [ ] Gizlilik politikası URL'i: `https://<host>/privacy`
- [x] **Hesap silme URL'i:** `https://<host>/delete-account`. Play, hesap
      oluşturulabilen uygulamalardan, uygulamayı kurmadan da erişilebilen bir silme
      açıklaması istiyor. Sayfa uygulama içi yolu (`/account` → `DELETE /api/account`),
      giriş yapılamıyorsa e-posta talebini, nelerin silindiğini ve nelerin kaldığını
      `hardDeleteUser` (`src/lib/accountErasure.ts`) ile birebir anlatır; erasure
      değişirse metin aynı diff'te değişir. `/account-deletion` değil, çünkü
      `robots.ts` `/account` önekini engelliyor.
- [ ] Data safety formu (toplanan veriler: hesap, mesajlar, dosyalar; şifreleme: TLS;
      silme: evet)
- [ ] İçerik derecelendirmesi, hedef kitle (çocuklar **değil**), reklam yok
- [ ] Mağaza görselleri: yalnızca demo verisinden (`docs/DATA_ACCESS_POLICY.md`; #2084
      ve #1399 aynı yakalama hattını kuruyor)
- [ ] İlk sürüm **internal testing** kanalına, sonra production

### İmzalama

- **Play App Signing** kullanılır. Uygulamanın asıl imza anahtarını Google tutar.
  Biz yalnızca **upload key** ile imzalarız; bu anahtar kaybolursa Play desteğiyle
  sıfırlanabilir.
- Upload key bir kez üretilir, bir parola yöneticisinde saklanır, **asla commit
  edilmez** (`.gitignore`: `*.jks`, `*.keystore`):
  ```bash
  keytool -genkeypair -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
  base64 -w0 upload.jks   # → ANDROID_UPLOAD_KEYSTORE_BASE64
  ```
- GitHub secrets: `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`,
  `ANDROID_UPLOAD_KEY_PASSWORD`. Alias `upload` olarak sabit. Secret yoksa dispatch
  build'i imzasız bundle üretir ve bir uyarı yazar; Play bu bundle'ı kabul etmez.
- İki uygulama aynı upload key'i paylaşabilir (Play buna izin veriyor). Asıl imza
  anahtarları zaten uygulama başına ayrı ve Google'da.

### Yayın akışı

1. Actions → *Android app bundle (TWA)* → `app`, `version_code` (Play'e yüklenen son
   değerden **kesin büyük** bir tamsayı) ve isteğe bağlı `version_name`.
2. Artifact'taki `.aab`'yi Play Console → Internal testing'e yükle.
3. Play Console → *App integrity*'den iki SHA-256'yı al: **app signing key** ve
   **upload key**. Bunları `ANDROID_APPS[...].sha256CertFingerprints`'e ekleyen bir PR
   aç. Merge olunca prod deploy'u ile `assetlinks.json` canlıya çıkar.
4. Telefonda doğrula: URL çubuğu yoksa kefalet çalışıyor. Ayrıca
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://interncrm.com&relation=delegate_permission/common.handle_all_urls`
   ile kontrol edilebilir.
5. Production'a terfi ettir.

**Yeni bir mağaza sürümü ne zaman gerekir:** yalnızca **kabuk** değiştiğinde. Yani
ikon, ad, renkler, kısayollar, Bubblewrap/targetSdk güncellemesi (Play'in yıllık
targetSdk şartı) ya da yeni bir izin. Web'deki hiçbir değişiklik mağaza sürümü
gerektirmez.

**Preview / topic ortamları:** `assetlinks.json` vertical'e göre çalıştığı için preview
host'u da aynı paketi listeler. Bu zararsızdır, çünkü uygulama yalnızca kendi
host'unu açar. Preview'a bakan ayrı bir test uygulaması kapsam dışı.

## iOS — ertelendi

Tetikleyici: iOS uygulamasını şart koşan somut bir müşteri ya da RFP. O güne kadar
iOS kullanıcıları PWA kullanır (iOS 16.4+ ana ekrana kurulu PWA'da Web Push çalışır;
AB'de de, Apple 2024'teki kaldırma kararından döndü). `InstallAppButton` iOS'ta "Ana
Ekrana Ekle" ipucunu zaten gösteriyor.

Neden TWA kadar ucuz değil:

- **App Store Guideline 4.2 (asgari işlevsellik):** siteyi saran ince bir `WKWebView`
  reddedilir. Geçebilmek için web'in veremediği native yetenekler gerekir: **APNs
  push** (VAPID değil, `webPush.ts` yanına ikinci bir gönderici ve abonelik
  tablosunda platform alanı), Face ID ile remember-me, share extension, belki widget.
  Gerçekçi araç: Capacitor kabuğu + bu eklentiler. Tahmini birkaç hafta, artı her iOS
  sürümüyle gelen bakım.
- **Kurumsal SSO:** Google Workspace gibi IdP'ler gömülü webview'ı reddeder. SAML/OIDC
  akışı `ASWebAuthenticationSession` üzerinden geçmeli (`docs/sso-saml.md`,
  `docs/sso-oidc.md`).
- **Yerine getirilmiş olanlar:** uygulama içi hesap silme (5.1.1(v)) var
  (`DELETE /api/account`). Sign in with Apple (4.8) muhtemelen gerekmiyor, çünkü
  sosyal giriş yok (Google yalnızca takvim için) ve giriş kimlik bilgileri ile
  kurumsal SSO üzerinden; yine de inceleme öncesi doğrulanmalı. B2B faturalama
  uygulama dışında olduğu için IAP gerekmez; uygulama içinde fiyat ya da "satın al"
  akışı gösterilmemeli.
- **Hesap:** Apple Developer Program, organizasyon (bcsit GmbH, aynı D-U-N-S), yıllık
  99 USD.

## Çevrimdışı — ertelendi

GTM incelemesinin "şimdi yapılmayacaklar" listesinde. #2085 en küçük yararlı yüzeyi
tanımlıyor: mentorun kendi mentee'leri, hedefleri ve bugünkü toplantıları (salt
okunur) artı bir kuyruklu yazma (etkileşim kaydı). Bu doküman bunu **ölçmedi**; ölçüm
bir sonraki adım. Bağlayıcı kurallar:

- Önbelleğe alınmış bir mentee listesi oturum kapanınca **ve** güvenilen cihaz iptal
  edilince **silinmek zorunda** (`docs/remember-me.md`). Bu bir veri koruma şartı.
- `public/sw.js`'in `/api/realtime/*` ve `text/event-stream` istisnaları korunur
  (`docs/realtime-and-push.md` § 2).
- İncelenmemiş bir önbellek stratejisi `main`'e girmez.

Native olmak çevrimdışını bedavaya getirmez; aynı iş native tarafta da yapılmak zorunda.

## RFP cevabı ("Do you have a mobile app?")

> Yes. InternshipCRM is an installable progressive web app on every phone, for every
> role and at every tier, with push notifications, home-screen shortcuts and sharing
> into the app. On Android it is also distributed through Google Play (publisher
> bcsit GmbH), so it can be found in the store and rolled out through your MDM. On
> iPhone it installs from Safari in two taps and receives push notifications (iOS
> 16.4+). Because the store app opens the same live application, every improvement
> reaches every device the day it ships — no app update, no version skew between
> users.

*(Play kaydı yayımlanana kadar "is also distributed through Google Play" cümlesi
"will be available on Google Play" olarak kullanılır.)*

## Kaynaklar

- [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), [Digital Asset Links](https://developers.google.com/digital-asset-links/v1/getting-started)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (4.2, 4.8, 5.1.1(v))
- [MobiLoud — webview wrapper ve 4.2](https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper/)
- [MagicBell — iOS PWA sınırları 2026](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- Rakip tablosu: `docs/research/competitive-analysis-2026-08.md` (Native mobile app satırı)
