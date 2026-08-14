# Kabul edilen bağımlılık bulguları / Accepted dependency findings

`npm audit` çıktısında **bilerek açık bırakılan** bulgular ve gerekçeleri. CI
kapısı (`.github/workflows/security-audit.yml`) yalnız `critical` seviyesinde
kırılıyor; buradaki her satır, "neden hâlâ kırmızı ve neden sorun değil"
sorusunun cevabı.

Bir bastırma dosyası yerine düz metin: gerekçe diğer güvenlik dokümanlarının
yanında okunabilir kalıyor ve biri okuduğunda **hâlâ geçerli mi** diye sorması
gerektiği belli oluyor.

Son gözden geçirme: **2026-08-07** · Kaynak epic: [#823](https://github.com/21072026/Internship/issues/823)

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

## Yeni bir istisna eklerken

1. Neden düzeltilemediğini yaz (yama yok / majör gerekiyor / geçişli).
2. **Bu uygulamada sömürülebilir mi** — sadece "advisory var" yetmez, kod yolunu adlandır.
3. Kalıcı çözümü ve takip issue'sunu yaz.
4. Üstteki "son gözden geçirme" tarihini güncelle.
