# Kabul edilen bağımlılık bulguları / Accepted dependency findings

`npm audit` çıktısında **bilerek açık bırakılan** bulgular ve gerekçeleri. CI
kapısı (`.github/workflows/security-audit.yml`) yalnız `critical` seviyesinde
kırılıyor; buradaki her satır, "neden hâlâ kırmızı ve neden sorun değil"
sorusunun cevabı.

Bir bastırma dosyası yerine düz metin: gerekçe diğer güvenlik dokümanlarının
yanında okunabilir kalıyor ve biri okuduğunda **hâlâ geçerli mi** diye sorması
gerektiği belli oluyor.

Son gözden geçirme: **2026-08-24** · Kaynak epic: [#823](https://github.com/21072026/Internship/issues/823)

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

**Karar: tek bir choke point** — `src/lib/objectUrl.ts` içindeki
`objectUrlSrc()`, `blob:` ile başlamayan her değeri boş string'e çeviriyor ve
üç çağrı yerinin de kullandığı tek yol o. Çalışma zamanında gereksiz; amacı,
yukarıdaki muhakemenin dayandığı değişmezi üç ayrı yorum yerine **kodda tek
yerde** tutmak. Yeni bir kompozit ekleyen kişi de aynı yoldan geçer, uyarı
listesine bir satır daha eklemez.

⚠️ Bu koruma yalnızca **CodeQL onu tanırsa** uyarıyı kapatır. Tanımıyorsa
doğru hamle üç uyarıyı Security sekmesinden "false positive" olarak
kapatmaktır — gerekçe zaten burada yazılı. Hangi yolun geçerli olduğu
#1005'te kayıtlı; motor tanımadıysa bu bölüm "dismiss edildi" olarak
güncellenmeli, koruma yine de kalabilir (zararsız ve niyeti belgeliyor).

## Yeni bir istisna eklerken

0. Bulgu kod taramasından mı geliyor (bağımlılık değil)? Üstteki "Kod taraması"
   bölümüne yaz; sorular aynı, "paket" yerine dosya/kural adı geçer.
1. Neden düzeltilemediğini yaz (yama yok / majör gerekiyor / geçişli).
2. **Bu uygulamada sömürülebilir mi** — sadece "advisory var" yetmez, kod yolunu adlandır.
3. Kalıcı çözümü ve takip issue'sunu yaz.
4. Üstteki "son gözden geçirme" tarihini güncelle.
