# Satış e-postalarının CRM'e düşmesi — karar (#2564)

> **Durum: UYGULANDI (#2809).** Spike #2564'ün kararı; iki açık soru maintainer tarafından
> önerildiği gibi kapatıldı (aşağıda). Hukuki danışmanlık değildir.

## Sorun

Satışçı müşteriye kendi posta kutusundan (Outlook, Gmail) yazıyor. Bu yazışma CRM'e elle
`InteractionLog` olarak girilmezse "son temas" (`src/lib/lastContact.ts`), ilk temas süresi
metriği ve dikkat kuyruğu kör kalır; `go-live-checklist.md` § 2 bunu bugün her gün elle
kontrol ettiriyor.

Mevcut gelen-posta hattı bu işi **görmüyor**: `routeInboundEmail` (`src/lib/inboundEmail.ts`)
yalnızca HMAC'li `reply+<token>@INBOUND_EMAIL_DOMAIN` adresine gelen ve göndereni o mesaj
başlığının katılımcısı olan yanıtları kabul ediyor. Satışçının kendi mailinde token yok;
MARKETING lead'inin `User` adresi de stand-in olduğu için (`leadStandInEmail`) katılımcı
eşleşmesi de tutmaz.

## Değerlendirilen yollar

| # | Yol | Artı | Eksi |
| --- | --- | --- | --- |
| 1 | **BCC-to-CRM**: org başına gizli bir adres; satışçı müşteriye yazarken BCC'ye ekler | Satışçının alışkanlığına oturur (Outlook/Gmail'de "her zaman BCC" kuralı); mevcut IMAP köprüsü ve posta kutusu yeter | Gelen yanıtları görmez (yalnız giden); adresin sızması = sahte kayıt riski |
| 2 | Yalnız konu + tarih + yön (gövdesiz) | En az kişisel veri | Tek başına bir taşıma yolu değil — 1'in **veri politikası** olarak birleşir |
| 3 | Bilinçli hayır; elle giriş | Sıfır kod, sıfır veri | Bugünkü kör nokta kalır |
| — | OAuth ile Gmail/M365 posta kutusu senkronu | Gelen + giden, tam | Yeni alt işleyen (Google/Microsoft API), kapsamlı OAuth izni, satışçının özel postası da görünür — orantısız |

## Karar

**1 + 2: BCC-to-CRM, yalnız meta veri.**

- Her MARKETING (ve isteyen INTERNSHIP) org'u için bir adres:
  `crm+<orgToken>@<INBOUND_EMAIL_DOMAIN>`. `orgToken` = `orgId` + HMAC (sunucu sırrı,
  `replyToken.ts` kalıbı; amaç öneki `crm-bcc:`), tahmin edilemez; admin ekranında gösterilir
  ve **döndürülebilir** (bir sürüm sayacı HMAC'e girer — eski adres anında geçersiz olur).
- Aynı IMAP posta kutusu, aynı köprü: `pollInboundMailbox` yerel kısma bakıp yönlendirir —
  `reply+` → mevcut başlık yolu, `crm+` → yeni BCC yolu. Yeni altyapı, yeni alt işleyen yok.
- **Kimlik doğrulama — iki şart birlikte:** (a) token doğrulanır ve bir org'a çözülür;
  (b) `From`, o org'un **aktif personeli** (ADMIN / MENTOR / satış temsilcisi) — o dünyada
  (`findUserInWorld`, docs/worlds.md; çıplak e-posta araması yok). `From` sahtelenebilir,
  token sızabilir; ikisinin birlikte sahtelenmesi gerekir ve sonuç yalnız "bir temas kaydı"
  olur — veri okunmaz, izin üretilmez.
- **Eşleştirme:** `To` + `Cc` adresleri, o org'un `Company.contactEmail` ve
  `CompanyContact.email` (#2442) değerlerine karşı (küçük harf, tam eşleşme). Eşleşen her
  hesabın **aktif funnel kaydına** (ACTIVE `MentorshipRelation`; birden çoksa göndereni sahibi
  olan, yoksa en yenisi) bir `InteractionLog` yazılır:
  `type: Email`, `autoLogged: true`, `date` = mailin `Date` başlığı (yoksa alınma anı),
  `subject` = konu (200 karakterle kırpılır), `notes` = sabit bir metin
  ("BCC ile kaydedildi — gövde saklanmaz") + alıcı adres(ler)i.
- **Gövde ve ekler saklanmaz.** Son temas, ilk temas süresi ve kuyruk yalnız tarihe bakar;
  gövde, üçüncü kişinin (müşteri) verisini ve satışçının yazdığı her şeyi CRM'e taşır ve kendi
  saklama/erişim/silme yükünü getirir. Konu satırı tutulur çünkü kaydı bir insanın tanıması
  için gerekir; o da kırpılır.
- **Eşleşmeyen mail:** hiçbir şey yazılmaz; yalnız sayaç ve bir log satırı (alıcı adresi
  olmadan — PII). Satışçıya geri bildirim yok (mail döngüsü riski).
- **Tekrar:** RFC `Message-ID` × hesap çifti benzersiz (aynı mailin birden fazla teslimi tek
  kayıt). IMAP teslimatı en-az-bir-kez; mevcut köprü kalıbı.
- **İletişim izni etkilenmez.** Bir BCC kaydı hiçbir `ContactPermission` üretmez ve
  değiştirmez (`docs/contact-permission.md` — makine yolları `NONE` dışında yazamaz; bu yol hiç
  yazmaz). Bir satışçının izinsiz attığı reklam maili CRM'e "temas" olarak düşer ama bu
  onu meşru yapmaz — `outreach-compliance.md` § 8'deki "CRM durduramaz" satırı geçerli kalır.

## Etkiler

- **`docs/last-contact.md`:** kural değişmez — `InteractionLog` zaten temas sayılıyor; BCC
  kaydı da bir `InteractionLog`. "Yalnız giden" olduğu bilinçli: müşterinin cevabı gelmeden
  temas tazelenir ki bu, elle girişte de böyledir.
- **`docs/trust/subprocessors.md`:** değişmez — kendi posta sunucumuz, kendi IMAP kutumuz.
- **DSGVO:** Art. 6 Abs. 1 lit. f (iş yazışmasının belgelenmesi); veri minimizasyonu (Art. 5
  Abs. 1 lit. c) gövdesizlikle. Gizlilik metnine bir cümle: "Satış ekibinin size yazdığı
  e-postaların tarihi, konusu ve alıcı adresi CRM'de kayıt altına alınabilir; içerik
  saklanmaz." `PRIVACY_POLICY_VERSION` yükselir.
- **Saklama:** kayıt, bağlı olduğu funnel kaydıyla yaşar ve onunla silinir (`onDelete:
  Cascade`); hesabın silme yüzeyi (#2441/#2559) zaten kapsar.

## Açık sorular — kapandı

1. INTERNSHIP: aynı kod, varsayılan **kapalı**, org ayarıyla açılır (`crmBccEnabled`).
2. Gelen yanıtlar (müşteri → satışçı): satışçı yanıtı CRM adresine **yönlendirir** — uygulandı
   (#2815, aşağıda § Yönlendirilen yanıtlar).

## Uygulama (#2809)

| Parça | Yer |
| --- | --- |
| Kural (token ayrıştırma, müşteri adresleri, kayıt seçimi, konu kırpma, açık/kapalı) | `src/lib/crmBccRule.ts` — `scripts/test/crm-bcc.test.mjs` |
| HMAC (`crm-bcc:` öneki, sürüm imzada) | `src/lib/crmBccTokens.ts` |
| Yönlendirme + yazma | `src/lib/crmBcc.ts` — `routeInboundMail()` IMAP köprüsü ve `POST /api/inbound-email` için tek giriş: `reply+` varsa başlık yolu, yoksa `crm+` |
| Tekrar koruması | `InteractionLog.sourceRef` (`bcc:<sha256(Message-ID)>`, Message-ID yoksa gönderen+tarih+konu+alıcılar) + `@@unique([relationId, sourceRef])` |
| Ayarlar | `crmBccEnabled` (`''` = vertical varsayılanı), `crmBccVersion` (döndürme = +1) |
| Admin ekranı | `/admin/settings` → "Gönderilen e-postaları BCC ile kaydet" (`/api/admin/crm-bcc`: göster, kopyala, yeni adres, aç/kapat, varsayılana dön) |
| Gizlilik metni | `privacy.purposesBody` (MARKETING overlay + temel metin), `PRIVACY_POLICY_VERSION = 2026-10-07` |
| E2E | `e2e/crm-bcc.spec.ts` |

Notlar:

- `notes` alanı `BCC → <eşleşen alıcılar>` biçimindedir; "gövde saklanmaz" bir politika olduğu
  için her kayda yazılmaz.
- Adres yalnızca admin ekranında görünür; satışçılara admin iletir. Sızarsa "Yeni adres" eskisini
  anında geçersiz kılar (sürüm imzanın parçası, yönlendirme yalnız güncel sürümü kabul eder).
- `INBOUND_EMAIL_DOMAIN` tanımsız bir ortamda adres gösterilemez; kart bunu söyler.
- Gönderen kontrolü: `findUsersInWorld` ile org'un dünyasında arama, sonra org eşleşmesi (NULL
  `orgId` = varsayılan org kuralı); yalnız aktif `ADMIN`/`MENTOR`.

## Yönlendirilen yanıtlar (#2815)

Müşterinin cevabı satışçının posta kutusuna gelir; satışçı onu aynı `crm+` adresine **yönlendirir**.

- Aynı iki şart: imzalı adres + gönderen (yönlendiren) o org'un aktif personeli.
- Asıl gönderen, tarih ve konu şuradan okunur:
  - ek olarak iletilmiş mesajın (`message/rfc822`, Outlook "Ek olarak ilet") kendi başlıkları —
    köprü (`forwardedAttachment` in `src/services/inboundMailBridge.ts`) yalnız bu dört alanı çıkarır;
  - yoksa satır içi yönlendirmenin başlık bloğu (`parseForwardedHeaders` in
    `src/lib/crmBccRule.ts`): Gmail, Outlook EN/DE/TR (kalın `*From:*` dahil), Apple Mail
    (`> ` önekli). Korpus `scripts/test/crm-bcc.test.mjs`'te.
- **Gövde yalnız bellekte okunur**, yalnız bu üç alanı bulmak için; hiçbir parçası yazılmaz.
- Asıl gönderen bir müşteri adresiyse (personel/CRM adresi değilse) kayıt **gelen** olarak düşer:
  `notes = "BCC ← <adres>"`, `date` = asıl mailin tarihi (okunamazsa yönlendirmenin tarihi),
  `subject` = asıl konu (yoksa yönlendirme konusunun `Fwd:`/`WG:`/`İlt:` önekleri atılmış hâli).
- Tekrar koruması: asıl mailin Message-ID'si (ekli iletide) ya da gönderen + tarih + konu —
  aynı yanıtı iki kez yönlendirmek tek kayıt.
- Yerelleştirilmiş uzun tarih ("Montag, 5. Oktober 2026 09:00") okunmaz; o zaman yönlendirmenin
  kendi tarihi kullanılır — bilinçli: yanlış güne yazmaktan iyidir.
