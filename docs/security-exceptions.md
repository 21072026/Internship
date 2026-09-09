# Kabul edilen bağımlılık bulguları / Accepted dependency findings

`npm audit` çıktısında **bilerek açık bırakılan** bulgular ve gerekçeleri. CI
kapısı (`.github/workflows/security-audit.yml`) yalnız `critical` seviyesinde
kırılıyor; buradaki her satır, "neden hâlâ kırmızı ve neden sorun değil"
sorusunun cevabı.

Bir bastırma dosyası yerine düz metin: gerekçe diğer güvenlik dokümanlarının
yanında okunabilir kalıyor ve biri okuduğunda **hâlâ geçerli mi** diye sorması
gerektiği belli oluyor.

Son gözden geçirme: **2026-09-09** · Kaynak epic: [#823](https://github.com/21072026/Internship/issues/823)

## Açık bulgular

| Paket | Şiddet | Durum | Gerekçe |
|---|---|---|---|
| `xlsx` | high | **Yama yok** | Prototype pollution + ReDoS. Upstream (SheetJS) npm'deki `xlsx` paketini terk etti; düzeltme yalnız kendi CDN'lerinde yayınlanıyor. Tek kullanım yerimiz `src/lib/excel.ts`: **istemci tarafında**, dinamik `import('xlsx')` ile, yalnız `XLSX.writeFile` — hiç dosya okumuyoruz. Her iki advisory de *parse* yolunda, üstelik kod sunucuda değil tarayıcıda çalışıyor. Kalıcı çözüm paketi değiştirmek — ayrı iş. |
| `node-cron` · `uuid` | moderate | Majör gerekiyor (3.x → 4.x) | `uuid` v3/v5/v6'da buffer sınır kontrolü eksikliği; `node-cron` üzerinden geliyor. Bu kod yolunu **hiç çağırmıyoruz** — cron yalnız zamanlama için kullanılıyor. |

## Kapatılanlar (2026-08-07, #1143)

| Paket | Nasıl |
|---|---|
| `nodemailer` | 7.0.13 → 9.0.5. Yalnız kök aralığı bumplamak yetmiyordu: `next-auth@4.24.15` `peerOptional nodemailer@"^7.0.7"` istiyor ve `npm ci` ERESOLVE ile düşüyor (Dependabot'un #1129'u tam olarak burada kırıldı). `overrides` ile `next-auth`'un peer'i köke bağlandı (`"next-auth": { "nodemailer": "$nodemailer" }`) — güvenli, çünkü `src/lib/auth.ts` yalnız `CredentialsProvider` kullanıyor, `EmailProvider` yok, yani next-auth nodemailer'ı runtime'da hiç yüklemiyor. |
| `next-auth` | Kendi kodundan değil `nodemailer` üzerinden geliyordu; onunla birlikte kapandı. |

## Kapatılanlar (2026-07-31, #882)

| Paket | Nasıl |
|---|---|
| `js-yaml` · `brace-expansion` | `npm audit fix` — geçişli, majör gerekmedi |
| `next` | 15.5.14 → 15.5.22 (yama sürümü) |
| `postcss` | ⚠️ `next@15.5.22` **postcss 8.4.31'i sabitliyor** ve bu sürüm hâlâ açık. Doğrudan bağımlılık aralığı `^8.5.18`'e yükseltilip `overrides` ile geçişli kopya da ona sabitlendi. Semver-uyumlu (8.4 → 8.5), risk düşük. |
| `sharp` | Aynı durum: `next` 0.34.5'i sabitliyor, libvips CVE'leri 0.35.0'da kapanıyor. `overrides` ile `^0.35.0`. |

### `npm audit`'in yanılttığı nokta

`npm audit` bu üçü için `fixAvailable: true` diyordu; gerçekte önerdiği "düzeltme"
`next@9.3.3`'e **düşmekti**. Next 16.2.12 denendi — **o da** postcss 8.4.31 ve
sharp 0.34.5 sabitliyor, yani majöre çıkmak bu bulguları kapatmıyordu.
`overrides` tek gerçek çözümdü.

## Kod taraması (CodeQL)

### `js/xss-through-dom` — object-URL önizlemeleri (#1005)

CodeQL, `URL.createObjectURL()` sonucunu bir `<img src>`'e veren her
ek/görsel **önizlemesini** high olarak işaretliyordu: `MessageThread.tsx` (iki
satır) ve `admin/announcements/page.tsx`. Kural haklı bir taint görüyor —
DOM'dan gelen bir `File` bir `src` niteliğine ulaşıyor — ama bu hedef onu
çalıştırabilecek bir hedef değil:

- `URL.createObjectURL()` `blob:<origin>/<uuid>` üretir. Şemayı **tarayıcı**
  koyar, dosya değil; dolayısıyla asla `javascript:` ya da `data:` olamaz.
- `<img>`, baytlar SVG olsa bile script çalıştırmaz. SVG script'i yalnızca
  belge **belge olarak** yüklendiğinde çalışır (iframe, object, doğrudan
  gezinme).
- Duyuru seçicisi ayrıca dosyayı `ANNOUNCEMENT_IMAGE_MIME` + `contentMatchesType()`
  ile doğruluyor ve SVG zaten izin listesinde değil (#888/#990).

**Karar: 1 — üç uyarı "false positive" olarak kapatılır.**

Önce seçenek 2 denendi (#1325): `objectUrlSrc()` adında tek bir yardımcı,
`blob:` ile başlamayan her değeri boş string'e çeviriyor ve üç çağrı yeri de
oradan geçiyordu. **Ölçüldü ve işe yaramadı** — CodeQL bu yardımcıyı sanitizer
olarak tanımıyor; PR'da uyarılar aynı satırlarda yeniden tetiklendi
(*"3 new alerts including 3 high severity security vulnerabilities"*). Kod
değişikliği geri alındı: motorun tanımadığı bir koruma uyarıyı kapatmıyor,
üstelik o satırlara dokunan **her** PR'da "3 yeni yüksek uyarı" üretiyor —
insanları CodeQL'i görmezden gelmeye alıştıran türden bir gürültü.

Kapatılacak uyarılar (Security → Code scanning):

| # | Dosya | Kural |
|---|---|---|
| [19](https://github.com/21072026/Internship/security/code-scanning/19) | `src/app/admin/announcements/page.tsx` | `js/xss-through-dom` |
| [20](https://github.com/21072026/Internship/security/code-scanning/20) | `src/components/MessageThread.tsx` | `js/xss-through-dom` |
| [21](https://github.com/21072026/Internship/security/code-scanning/21) | `src/components/MessageThread.tsx` | `js/xss-through-dom` |

Kapatma gerekçesi olarak yukarıdaki üç madde yeterli; "used in tests" değil
**"false positive"** seçilmeli.

⚠️ Yeni bir ek/görsel kompoziti aynı deseni kullanırsa aynı uyarı yeniden
çıkar. O zaman da doğru cevap dosyayı buraya eklemek ve uyarıyı kapatmaktır —
`<img>` bir blob URL'ini çalıştıramaz, bu değişmedi.

## Bilerek yapılan tasarım tercihleri

Bağımlılık ya da tarama bulgusu değil: bir güvenlik özelliğini yaparken bilerek
verilmiş, dar kapsamlı bir taviz. Aynı sorular geçerli — neden, nerede, ne kadar.

### `SSO_REQUIRED` bir adresin SSO zorunlu bir kiracıya ait olduğunu açık eder (#1950)

**Ne:** Zorunlu SSO açık bir organizasyonun kullanıcısı parolayla giriş
denediğinde `src/lib/auth.ts` bcrypt karşılaştırmasından **önce**
`SSO_REQUIRED` fırlatıyor; giriş sayfası "kurumun tek oturum açmayı zorunlu
kılıyor" diyor ve `/auth/sso` bağlantısını gösteriyor. Aynı bilgi
`POST /api/auth/reset`, `/api/register` ve `PUT /api/account` yanıtlarında
`code: "sso_required"` olarak dönüyor.

**Taviz:** Giriş uç noktası bugüne kadar bilinmeyen e-posta ile yanlış parolayı
aynı genel hatayla yanıtlıyordu, yani bir adresin kayıtlı olup olmadığını
söylemiyordu. Bu yeni hata, SSO zorunlu kiracılar için o özelliği bozuyor:
cevabı alan kişi hem adresin var olduğunu hem de hangi tür kiracıya ait
olduğunu öğreniyor.

**Neden kabul edildi:**
- Alternatifi, parolası **doğru** olan bir kullanıcıya "e-posta veya parola
  hatalı" demek. O kişi tekrar deniyor, hesabını kilitliyor ve destek arıyor —
  yani yanlış cevap gerçek bir operasyonel maliyet üretiyor.
- Açığa çıkan bilgi bir bit: "bu adres SSO zorunlu bir organizasyona ait".
  Parola, oturum ya da yetki hakkında hiçbir şey vermiyor.
- Aynı bilgi zaten büyük ölçüde kamuya açık: kiracının SP metadata uç noktası
  (`/api/auth/sso/<slug>/metadata`) kimlik doğrulamasız yayında (#1931) ve
  kurumsal SSO müşterinin kendi duyurduğu bir şey.
- Kontrol, bcrypt'ten **önce** duruyor. Bu bilinçli: verdiğimiz söz "parolayla
  giriş kapalı", "parolayla giriş genelde başarısız" değil — zorunlu bir
  kiracının parola hash'i hiç karşılaştırılmıyor.

**Kapsam:** Yalnızca `ssoEnforced` **ve** `isSsoActive()` doğru olan
organizasyonlar. Muaf (`ssoExempt`) kullanıcılar ve zorunluluk uygulanmayan her
kiracı eski genel hatayı almaya devam ediyor. Ayrıntılar:
[`docs/sso-saml.md`](sso-saml.md) § *Enforced SSO*.

## Yeni bir istisna eklerken

0. Bulgu kod taramasından mı geliyor (bağımlılık değil)? Üstteki "Kod taraması"
   bölümüne yaz; sorular aynı, "paket" yerine dosya/kural adı geçer.
1. Neden düzeltilemediğini yaz (yama yok / majör gerekiyor / geçişli).
2. **Bu uygulamada sömürülebilir mi** — sadece "advisory var" yetmez, kod yolunu adlandır.
3. Kalıcı çözümü ve takip issue'sunu yaz.
4. Üstteki "son gözden geçirme" tarihini güncelle.
