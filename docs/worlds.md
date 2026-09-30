# Bir kişi, iki dünya — girdiğin URL hangi ürünü kullandığını belirler (#2590)

> Aynı e-posta adresinin hem internship CRM'de hem marketing CRM'de (SaleVali)
> ayrı birer hesabı olabilir. Hangisine gireceğini **oturum açtığın host**
> seçer: `interncrm.com` internship'i, `marketing.bcsit-gmbh.de` marketing'i
> açar — ve oturum boyunca öyle **kalır**.

## Problem

Epic #2348 ile marketing, bu çekirdeğin ikinci bir **dikeyi** oldu: iki ürün, iki
host, tek deploy. Ama `User.email` global olarak `@unique` idi. Bir kişi — ilk
olarak bakımcının kendisi — iki üründe aynı adresle hesap açamıyordu; üstelik
`marketing.bcsit-gmbh.de`'de `ersahin@bcsit-gmbh.de` ile giriş yapınca dikey
çözümlemesi oturum-önce olduğu için (`resolveRequestVertical`: önce oturumun
org'u, sonra host) kişi kendi internship org'una düşüp **internship
uygulamasını** görüyordu. İstenen bunun tersi: marketing host'unda giriş =
marketing uygulaması.

## Model

| Kavram | Karar |
|---|---|
| **Dünya** | Bir organizasyonun dikeyi: `Organization.vertical` (`INTERNSHIP` \| `MARKETING`). `User`'da **saklanmaz**, türetilir: `user.orgId → org.vertical`; `orgId == null` ⇒ varsayılan org ⇒ `INTERNSHIP` |
| **Bir kişi** | Dünya başına **bir `User` satırı** — aynı e-posta, farklı `orgId` |
| **Kural** | (e-posta, dünya) başına **en fazla bir** hesap |

`User.email` artık `@unique` **değil**; veritabanında `@@unique([email, orgId])`.
Bu indeks yalnızca *aynı org*'daki iki satırı yakalar — ve `orgId` NULL iken onu
da yakalamaz, çünkü MySQL unique indekste NULL'ları ayrı sayar. Asıl kural
uygulamada: **her `user.create`'ten önce** `emailTakenInWorld()` /
`emailTakenInOrgWorld()` (`src/lib/userWorld.ts`) çağrılır.

### Neden üyelik (membership) değil, neden iki satır

Tek satır + birden çok org üyeliği daha derli toplu görünür ve pahalı olan
hamledir: `User.orgId` tenant filtrelerinin anahtarıdır (`tenantWhere`, Prisma
middleware'in `TENANT_MODELS` listesi). Yabancı bir `orgId` taşıyan kullanıcı
kendi org'unun listelerinden **kaybolur**; mentorluk ve lead ilişkilerinin
`User` üzerinden yaptığı her join aynı şekilde kırılır. İki satır her
kiracının veri modelini olduğu gibi bırakır; tek yeni soru "bu e-posta bu
dünyada hangi hesap?" ve onu tek bir dosya cevaplıyor.

Bedeli açık: iki satır, **her amaç için iki insan**dır. Ayrı parola, ayrı profil,
ayrı 2FA ve kurtarma kodları, ayrı `sessionsValidFrom` ("her yerden çıkış"
yalnızca o dünyayı etkiler), ayrı güvenilir cihazlar, ayrı bildirim tercihleri.
Birleşik bir profil isteniyorsa o ayrı bir karardır; bu belge onu vermiyor.

## Host → dünya

Kural `src/lib/hostWorld.ts`'te (saf; yalnızca iki bağımlılıksız modülü içe alır):

| İsteğin host'u | Dünya |
|---|---|
| `MARKETING_HOSTS`'ta listelenen her host (varsayılan: `marketing.bcsit-gmbh.de`) | `MARKETING` |
| Diğer her host — bilinmeyen ve başlıksız istek dahil | `INTERNSHIP` |

- **Sinyal:** önce proxy'nin `x-forwarded-host`'u, sonra `host` — `hostVertical.ts`
  ile aynı (Caddy `X-Forwarded-Host`'u kendi kabul ettiği host ile **ezer**). Kural
  tek yerde, `worldForHostHeader`; `verticalForHost` ona delege eder. Böylece
  "hangi host marketing landing'ini gösterir" ile "hangi host marketing hesabına
  girdirir" iki ayrı kopya olarak birbirinden kayamaz.
- **`MARKETING_HOSTS`:** virgülle ayrılmış çıplak host adları. Yok, boş ya da yalnız
  boşluk = varsayılan. Liste varsayılanın **yerine geçer**, üzerine eklenmez —
  preview `marketing.bcsit-gmbh.dev`'i böyle koyar ve bu yüzden prod adına cevap
  vermez. Aynı küme yönlendirme allowlist'ini de besler (`servedHosts.ts`, #2488);
  runbook `infra/README.md` § The marketing hosts.
- **API:** `worldForHeaders(get)`, `worldForHeaderBag(bag)` (NextAuth
  `authorize()`'a düz bir nesne verir), `originForWorld(world)`.

**Güven notu.** Host, bir kişinin **kendi** hesaplarından hangisine gireceğini
seçebilir ve bir isteği **reddettirebilir**; erişimi asla **genişletmez**. Sahte
bir `X-Forwarded-Host` en fazla sahtekârın kendi girişini başarısız kılar ya da
kendi öbür hesabını seçtirir. Tenant kapsamı, roller ve veri erişimi hâlâ
oturumun org'undan gelir, host'tan değil.

## Giriş

`authOptions` içindeki `credentials` sağlayıcısı (`src/lib/auth.ts`):

1. Adres normalize edilir; **adrese göre** tutulan kilit kapısı bcrypt'ten önce
   sorulur (aşağıda: [Kilitleme paylaşımı](#kilitleme-paylaşımı)).
2. Dünya istek host'undan çıkar; hesap **o dünyadaki** satırdır
   (`findUsersInWorld`).
3. O dünyada hesap yoksa, adresin başka dünyadaki hesapları yalnızca **parola
   kontrolüne katılır** (`findUsersByEmail`) — yanlış parola bugünkü gibi
   sayılır ve kilitler — ama bununla oturum **açılamaz**.
4. Zorunlu-SSO kapısı, tek hesaplı yoldaki gibi bcrypt'ten önce durur (#1950) —
   ama `SSO_REQUIRED` yalnızca **bu dünyadaki** hesaba söylenir. Öbür dünyanın
   SSO zorunlu bir tenant'ına ait hesap bilinmeyen adres gibi cevaplanır
   (`Invalid email or password`): hash'i yine karşılaştırılmaz, başarısızlık
   kullanıcı/org'suz kaydedilir; sayfa öbür ürünün tenant'ından söz etmez ve
   bu host'ta zaten reddedilecek bir `/auth/sso` bağlantısı sunmaz.
5. Parola yanlışsa cevap hep aynı `Invalid email or password`. Parola **doğru**
   ama hesap öbür dünyadaysa: `WRONG_WORLD_<VERTICAL>` (`authWrongWorld` /
   `parseWrongWorld`, `src/lib/authErrors.ts`; `<VERTICAL>` hesabın **gerçek**
   dünyasıdır). Oturum yok, 2FA istemi yok.
6. Diğer her şey (2FA, doğrulanmamış e-posta, onay bekleyen hesap…) aynı
   dünyadaki hesap için eskisi gibi.

Bir dünyada aynı adresi iki org tutuyorsa parola satırı seçer (`pickAccount`). Bu
durum tasarım gereği oluşmamalı — her kayıt yolu `emailTakenInWorld` sorar, bir
org'un ürününü değiştirmek de bu çakışmada reddedilir (bkz.
[Bilinen sınırlar](#bilinen-sınırlar)); yalnızca eşzamanlı iki kayıt ya da elle veri
müdahalesi üretebilir ve `pickAccount` bu durumda tahmin yürütmek yerine parolaya
bakar.

**Giriş sayfası** (`src/app/auth/signin`). Ürün kuralı: bir eylem hangi dünyada
başladıysa ürettiği her şey — sayfa metni, bağlantı, posta — o dünyada kalır.
`WRONG_WORLD_*` gelince form ham kodu göstermez ve öbür ürünü **ne adlandırır ne
bağlar**; yalnızca bulunduğu ürünün adıyla "bu bilgilerle bir {ürün} hesabı yok"
der (`t.auth.wrongWorld`, EN/TR/DE; ürün adı sayfanın kendi dikeyinden,
`productNameFor(useVertical())`). Sunucunun kodu değişmedi; öbür kapıya giden
bağlantı, onu besleyen `worldOrigins` prop'u ve `hostWorld.ts`'teki `worldOrigins()`
yardımcısı kaldırıldı — sayfa metni öbür dünyaya asla bağlantı vermez.

**Grant sağlayıcıları** (`impersonate`, `sso`, `remember`) kullanıcıyı host değil
grant seçtiği için tersinden korunur: `assertAccountMatchesHost` hesabın dünyası
host'un dünyasından farklıysa `WRONG_WORLD_*` fırlatır.
`POST /api/admin/impersonate` aynı kuralı bir adım **önce** sorar (`400
wrong_world`): yoksa grant basılır, `IMPERSONATE_START` yazılır ve hedefe "hesabına
erişildi" bildirimi gider — sonra girişi reddedilen, hiç olmamış bir erişim için.
`POST /api/auth/remember/refresh` cihaz sırrını **döndürmeden önce** reddeder ve
çerezleri temizler.

**SP başlatımlı SSO** (`GET /api/auth/sso/[slug]/login`) öbür dünyanın org kodunu
**bilinmeyen bir kod gibi** reddeder (aynı host'ta `/auth/signin?error=sso_unavailable`),
AuthnRequest kurmadan. ACS tarayıcıyı org'un kendi dünyasına indirir
(`landingOrigin(org.id)`), yani buradan başlayan akış öbür üründe biterdi; aynı
cevap bu host'un öbür üründe hangi kodların var olduğunu doğrulamasını da önler.
Giriş kapısı korunduğu için her AuthnRequest org'un dünyasının bir host'unda
başlar ve ACS'nin başarı yolu değişmeden doğru yere döner.

## Oturum bağlama

Bir oturum **tek** dünyaya aittir ve yalnızca o dünyanın host'unda çalışır.
`jwt` callback'i her istekte `token.worldMismatch`'i yeniden hesaplar (org'un
**şimdiki** ürünü ≠ isteğin host dünyası); `session` callback'i bunu görünce
`null` döner, yani `getServerSession()` / `useSession()` isteği oturumsuz sayar.
Üç şey bilinmeli:

- **Yapışkan değildir.** Her istekte org'un o anki dikeyinden yeniden hesaplanır;
  host listesi ya da org'un ürünü değişirse kendiliğinden düzelir.
- **İstek yoksa oturum kapanmaz.** Host okunamayan yerde (cron, betik, birim test)
  `requestWorld()` null verir ve `worldMismatch` false kalır: karşılaştırılacak
  bir host yok, dolayısıyla reddedilecek bir şey de yok.
- **Middleware buna bakmaz.** Edge çalışma zamanının veritabanı yok; middleware
  yalnızca JWT'yi çözer. Yanlış host'ta gelen token oradan geçer, ama
  `getServerSession()` null aldığı için handler'ın kendi guard'ı 401 / girişe
  yönlendirme verir: bu kapı daraltır, hiçbir zaman izin vermez
  (`src/middleware.ts`'teki WORLDS notu; `invalidated` ile aynı yol).

"Beni hatırla" çerezleri Domain'siz (host-only) olduğu için bir dünyanın
host'undan öbürüne zaten taşınmaz; `refresh` uç noktası bunu hesabın dünyasına
karşı bir kez daha doğrular.

## E-posta bağlantıları

Bir kullanıcıya giden postadaki bağlantı, **kullanıcının hesabının yaşadığı
ürünü** açmalıdır. Kaynak `originForWorld(world)`:

- `INTERNSHIP` = bugüne dek her e-posta yapıcısının kullandığı origin
  (`NEXT_PUBLIC_APP_URL`, yoksa yapılandırılmış origin) — tek dünyalı her kullanıcı
  için **bayt-bayt aynı**;
- `MARKETING` = `MARKETING_HOSTS`'un ilk girdisi, dağıtımın kendi şemasıyla. Port
  yalnızca marketing host'u yapılandırılmış host'un **kendisi** ise geri konur
  (geliştiricinin `localhost`'u), gerçek bir alan adı için asla.

Postayı yollayan kod org'u zaten bilir: `appUrlFor(orgId)`
(`src/services/emailService.ts`; org'suz = internship), davet bağlantısı için
`invitationRegisterUrl(token, world)` (`src/lib/inviteCreate.ts`). Origin'in
aranması **hata verirse hata verir**, internship'e düşmez: sıfırlama / doğrulama /
davet gibi vazgeçilmez bağlantıda yanlış dünyanın bağlantısı, "gönderilemedi"
diyen postadan kötüdür. Tarayıcıya dönük URL'ler ise hâlâ `NEXTAUTH_URL`'den değil
isteğin kendisinden kurulur (`requestOrigin` / `absoluteHere`, #2488).

## İkinci dünyaya davet

"Bu e-posta zaten kayıtlı" artık **bu dünyada** demektir. Öbür dünyada hesabı
olan bir kişi, o adrese yollanmış bir davetle burada ikinci, bağımsız hesabı
açabilir — davet, posta kutusunun kontrolünü zaten kanıtlar.

- `POST /api/invite` ve toplu davet (`/api/admin/invite/bulk`) "zaten üye mi?" ve
  "bekleyen davet var mı?" sorularını **davet edenin dünyasında** sorar
  (`emailTakenInOrgWorld`, `invitationOrgWhere` = (adres, org) çifti). Yalnızca
  öbür dünyada yaşayan bir adres, hiç bilinmeyen bir adres gibi okunur; form,
  başka bir üründe kimin hesabı olduğunu yoklamak için kullanılamaz.
- `POST /api/register` daveti token'dan okur, org'u davetten alır ve aynı kontrolü
  **o org'un dünyasında** yapar. Token'sız kayıt varsayılan org'a düşer, yani
  internship dünyasında kontrol edilir.
- Davetin org'u **isteğin host'unun dünyasında değilse** token bilinmeyen bir token
  gibi reddedilir (`400 Invalid invitation token`, kullanılmış / süresi dolmuş
  durumu okunmadan önce): buradan kabul etmek öbür ürünün hesabını — bildirimleri
  ve postalarıyla — bu host'tan açardı. `POST /api/invite/opened` da böyle bir
  daveti "açıldı" saymaz. Davet postasının bağlantısı zaten davetin kendi ürününü
  açar (`invitationRegisterUrl`), yani meşru bir davetli bu kapıya takılmaz.
- Kayıt sayfası, marketing host'unda (`isMarketing`) formun altında yalnızca kendi
  ürününü adlandırır: "Bu işlem, kendi parolası ve kendi verisi olan bir SaleVali
  hesabı oluşturur." (`t.auth.separateAccountHint`). Öbür ürünün adı geçmez.
  Veri paylaşımı kutusu (`dataSharingTitle` / `dataSharingBody`) MARKETING
  katmanında lead / temsilci diliyle konuşur. Internship host'undaki açık kayıt
  olduğu gibi bırakıldı.

**Bakımcı marketing hesabını nasıl alır?** Kendi adresini marketing org'una davet
ederek:

1. Marketing org'unun bir `ADMIN`'i varsa: o admin `/admin/invite`'tan rol `ADMIN`
   ile bakımcının adresini davet eder. Postadaki bağlantı marketing host'unu
   açar, "Davet Token'ı" dolu gelir, kayıt marketing org'unda **ikinci** satırı
   yaratır; internship hesabına dokunulmaz. Sonra iki host'ta da aynı adresle girilir;
   parolalar iki ayrı satırdır, aynı seçilse bile biri değişince öbürü değişmez.
2. Marketing org'unun hiç admin'i yoksa (ilk kurulum): süper-admin
   `/admin/organizations`'ta org'u açar (`vertical = MARKETING`) ve org
   satırındaki **"Admin davet et"** ile bakımcının adresini davet eder
   (`POST /api/admin/organizations/[id]/invite-admin`, yalnızca süper-admin;
   düz bir tenant ADMIN'i — o org'un kendi admin'i dahil — 403 alır). Bu yol
   `POST /api/invite`'ın aynısıdır, tek farkı daveti oturumun org'una değil
   **hedef org'a** yazmasıdır: "zaten kayıtlı mı?" hedef org'un dünyasında
   sorulur (`emailTakenInOrgWorld` → `409 email_taken_in_world`), açık davet
   (adres, hedef org) çiftiyle aranır (`invitationOrgWhere` → `409
   invitation_pending`), token tek yazardan çıkar (`createInvitation`, rol
   `ADMIN`) ve kayıt bağlantısı hedef org'un kendi ürün host'undadır
   (`appOriginForOrg`, #2495). Ekran telefondan kullanılabilir: davetten sonra
   bağlantı bir salt-okunur alanda, **Kopyala** ve (tarayıcı destekliyorsa)
   **Paylaş** (`navigator.share`) düğmeleriyle gösterilir; adres verildiyse
   posta da gider, gitmediyse ekran bunu söyler. E-posta boş bırakılırsa
   yalnızca bağlantı üretilir. Kayıttan sonrası 1. maddeyle aynıdır.

(2. maddedeki süper-admin, **o org'un dünyasının** süper-admin'idir — aşağıya bak.
Bir INTERNSHIP süper-admin'i bir MARKETING org'una admin davet edemez: `404`.)

Bir org'un ürününü (`PATCH` `vertical`) değiştirmek artık **hiçbir oturumdan
yapılamaz**: dünya değiştirmek org'u, işlemi yapan süper-admin'in erişiminden
çıkarıp öbür dünyanın operatörüne verir, yani tek bir oturumun işi değildir —
`403 vertical_other_world` (no-op ve kayıtsız bir anahtarın zaten okunduğu dünyaya
normalleşmesi geçer). Eski taşıma kontrolü (`409 vertical_move_email_conflict`,
`src/lib/verticalMove.ts`) ikinci kilit olarak yerinde duruyor; bir operatör yolu
bu reddi gevşetirse yine çalışır.

## Süper-admin dünya başınadır

Bakımcı kuralı: **INTERNSHIP süper-admin'i ile MARKETING süper-admin'i ayrı
hesaplardır**; her biri yalnızca kendi ürününün org'larını görür ve yönetir, ve
bir süper-admin oturumu öbür dünyanın host'unda **etkisizdir**. Aynı kişi ikisi de
olabilir — her dünyadaki kendi hesabıyla, tıpkı sıradan iki hesap gibi.

- **Kural tek yerde.** Saf yarısı [`src/lib/superAdminWorld.ts`](../src/lib/superAdminWorld.ts)
  (`superAdminWorldFrom`, `superAdminReaches`, `creatableVertical`, `orgWorldWhere`;
  birim testli: `scripts/test/super-admin-world.test.mjs`); canlı yarısı
  [`src/lib/superAdmin.ts`](../src/lib/superAdmin.ts): `superAdminWorld(session)` bayrağı,
  `isActive`'i ve **kullanıcının org'unu** her istekte veritabanından okur, dünyayı
  `worldOfOrg` ile türetir ve isteğin host'unun dünyası (`worldForHeaders`) farklıysa
  `null` döner. `isSuperAdminFor(session, targetOrgId)` = bu dünyanın süper-admin'i
  **ve** hedef org aynı dünyada. `isSuperAdmin(session)` artık "kendi dünyasının
  süper-admin'i, burada" demektir. İstek dışı bir bağlamda (host yok) cevap `null`'dır —
  kapalı başarısızlık.
- **Oturum callback'i zaten** öbür host'ta oturumu `null` yapıyor (#2590); host kontrolü
  ikinci, bağımsız kilittir.
- **Varsayılan dünya** = başka bir dikeyde olmayan her org (kayıtsız anahtar ve org'suz
  kullanıcı dahil) — `worldUserWhere`'in org düzeyindeki aynası (`orgWorldWhere`).
- **Tüketiciler:**
  - `GET /api/admin/organizations` yalnızca çağıranın dünyasındaki org'ları listeler;
    yanıt `world` ve `verticals` (= oluşturulabilir dikeyler, yani yalnızca kendi dünyası)
    taşır.
  - `POST /api/admin/organizations`: `vertical` **zorunlu** (`400 vertical_required`) ve
    çağıranın dünyasında olmalı (`403 vertical_other_world`, `authz.scope_denied` yazar);
    sütun varsayılanına asla düşmez. Ekranda seçim zorunlu ve yalnız kendi dünyası sunulur.
  - `PATCH /api/admin/organizations`: öbür dünyanın org'u için süper-admin bir tenant
    admin'i gibi okunur → `403`; dikey taşıma yukarıdaki gibi reddedilir.
  - `…/[id]/invite-admin`: öbür dünyanın org'u **`404`** (olmayan id ile aynı yanıt,
    yoklama yapılamaz); süper-admin olmayan `403`.
  - `…/[id]/pipeline-stages`, `POST /api/admin/users/[id]/sso-exempt`,
    `documentRequirementAccess.ts`: `isSuperAdminFor` (öbür dünya → `403`).
  - `GET /api/admin/email-log`: yalnızca **bu dünyada hesabı olan adreslere** giden posta.
    `EmailLog`'da `orgId` yok, tek bağ adres: iki dünyada hesabı olan bir adres iki logda da
    görünür (aynı posta kutusu), henüz hesabı olmayan bir adrese giden posta (davet, demo
    formu onayı) hiçbirinde görünmez. 24 saatlik SMTP kotası (`last24h`) iki dünyanın ortak
    rölesidir, kurulum geneli kalır ve adres taşımaz.
- **Açık kalan:** `publicHost` hâlâ yalnızca CLI ile atanır (`prisma/set-public-host.mjs`);
  yeni bir dikeyin **ilk** org'unu o dünyanın süper-admin'i henüz olmadığı için bir operatör
  açar (seed/CLI) — sonra aşağıdaki script ile o dünyaya bir süper-admin verilir.

### Süper-admin atamak: `prisma/set-super-admin.mjs`

```bash
node prisma/set-super-admin.mjs --email ops@example.com --world MARKETING            # kuru çalışma (varsayılan)
node prisma/set-super-admin.mjs --email ops@example.com --world MARKETING --confirm  # yazar
node prisma/set-super-admin.mjs --email ops@example.com --world INTERNSHIP --revoke --confirm
node prisma/set-super-admin.mjs --list
```

Adresin **yalnızca o dünyadaki** hesabına `isSuperAdmin` yazar; aynı adresin öbür
dünyadaki hesabına dokunmaz. İdempotent (ikinci koşu `unchanged`), `--confirm` olmadan
hiçbir şey yazmaz. Reddeder: o dünyada hesap yoksa (önce davet et), birden fazla hesap
varsa (tahmin etmez) ve hesap aktif bir `ADMIN` değilse. Dünya kuralı `worldUserWhere`'in
düz-ESM aynasıdır (sunucudaki Node 20 TS import edemez); birim testi ikisini karşılaştırır.

## Yalnız-internship yüzeyleri (kapı: menü + URL + API)

Bir yüzeyi menüden gizlemek erişim kontrolü değildir. `src/lib/navLinks.ts`'te bir
`capability` etiketi taşıyan her hedef, o yeteneği olmayan bir dikey için:

1. menüden ve komut paletinden düşer (`visibleNavLinks`, #2351);
2. **URL'si `notFound()` verir**: kural `src/lib/navRouteCapability.ts`
   (`capabilityForPath` — en uzun eşleşen link kazanır, segment bazlı), sunucu kapısı
   `src/lib/pageCapabilityGate.ts` (`gatePage(href)`). Kapı kök `admin/layout.tsx`'te
   **değil**, her kapılı segmentin tek satırlık `layout.tsx`'indedir: bir layout'un
   pathname'i yoktur ve paylaşılan bir layout istemci tarafı gezinmede yeniden
   render edilmez; segmentin kendi layout'u ise her girişte çalışır.
   `scripts/test/nav-route-capability.test.mjs`, etiketli bir `/admin/*` linkinin
   kapılı layout'u yoksa kırılır;
3. **API'si `requireCapability()` ile `403 capability_unavailable`** döner (okumalar dahil).

Bülten (`/admin/newsletters`, `/newsletters`, `api/admin/newsletters/**`,
`api/newsletters`) **`mentorship`** ile etiketlendi, ayrı bir `newsletter` yeteneği
açılmadı: kitlesi MENTEE/MENTOR'dur ve yalnızca mentorluğun olduğu yerde vardır; hep
birlikte gezen ikinci bir anahtar yalnızca kayabilir. Aynı etiket: `/admin/email`
(menti'lere e-posta), `/admin/re-engagement`, ve zaten etiketli olan
`/admin/testimonials` (+ `api/admin/testimonials`), `api/admin/mentorship-requests`
— son ikisi ayrıca elle tenant filtresiyle (`tenantWhere`/`withinTenant`) okur ve id ile
yazmadan önce satırın çağıranın tenant'ında olduğunu doğrular (yabancı id → `404`).

## Parola sıfırlama ve doğrulama

Bir akış bir hesaba **etki ediyorsa** (parola sıfırlama, e-posta doğrulama, hesap
silme, e-posta değiştirme, kilit temizleme, bildirim, abonelikten çıkma) yalnızca
üretildiği satıra / oturumun satırına etki eder — "bu e-postalı her satıra" değil.
Token'lar `userId` ile anahtarlıdır ve öyle kalmalıdır.

- **`POST /api/auth/forgot`** oturumsuzdur; dünyayı **form'un sunulduğu host**
  söyler ve yalnızca **o dünyadaki** hesap(lar) için posta yollanır. O dünyada hesap
  yoksa hiçbir şey yollanmaz — adresin öbür dünyadaki hesabına "kurtarma" postası
  da gitmez: SaleVali'de istenen sıfırlama bir Internship CRM postası ve
  interncrm.com bağlantısı üretmemeli. Yanıt her durumda aynıdır — "bulundu" ile
  "bu dünyada yok" dışarıdan ayırt edilemez (`findAccountsForMailedLink`,
  `src/lib/passwordReset.ts`). `POST /api/auth/verify-email/resend`'in oturumsuz
  yolu aynı yardımcıyı kullanır.
- **`POST /api/auth/reset`** yalnızca token'ın basıldığı `record.userId`'nin
  parolasını değiştirir, oturumlarını iptal eder, cihazlarını temizler. Öbür
  dünyadaki hesap aynı parolayla **kalır**: parolalar ayrıdır.
- **`POST /api/auth/verify-email`** davetin `verifiedAt` damgasını (adres, doğrulanan
  hesabın org'u) çiftine göre atar, yalnız adrese göre değil: bir posta kutusuna iki
  dünyadan da davet gelmiş olabilir ve birinin doğrulanması öbürününkini doğrulamaz.
- **Hesap silme** (`hardDeleteUser`) tek satıra etki eder; adrese göre tutulan
  temizlik (`EmailLog`, `NewsletterSend`) adresi başka bir hesap hâlâ tutuyorsa
  susar. "Son admin silinemez" kuralı aynı adresi taşıyan öbür dünya hesabını
  *halef* saymaz.
- **E-posta değiştirme** (`PUT /api/account`) "kullanımda" sorusunu hesabın kendi
  dünyasında sorar; `Email already in use` metni aynı kaldı ve artık "bu ürün
  içinde" demektir.

## Kilitleme paylaşımı

Yanlış-parola sayacı (`AccountLockout`) **adrese** göre tutulur, hesaba göre değil
— ve bu bilinçli. Sınırlanan şey bir posta kutusunun kimlik bilgilerine yönelik
tahmindir; iki dünyaya bölünmüş 10'ar deneme, sınırı ikiye katlamak olurdu.
Sonuçları:

- Marketing host'unda 10 yanlış parola, internship girişini de aynı pencere
  boyunca frenler (ve tersi). `totp` ve `recovery` kovaları da öyle.
- Başarılı bir giriş adresin sayaçlarını iki dünya için birden sıfırlar
  (`clearLockoutByEmail`).
- Admin kilidi açma (`DELETE /api/admin/users/[id]/lockout`) yalnızca *kendi
  kiracısındaki* hesabı hedefleyebilir, ama silinen sayaç adrese aittir, yani
  öbür dünyanın hesabı için de açılmış olur. Parola sıfırlama sayaca **dokunmaz**.

## E-postadan kullanıcı arama: tek kapı

`prisma.user.findUnique({ where: { email } })` artık tip denetiminden geçmez ve
**çıplak `findFirst({ where: { email } })` ile "düzeltilmemelidir"**: o, hangi
dünyanın satırını döndüreceğini rastgele seçer — yani bir kişiyi sessizce yanlış
ürüne alır ya da kiracılar arası sızdırır. Her arama hangi dünyada olduğunu
söyler:

| Durum | Kullan |
|---|---|
| Akışın bir org'u var (davetin, oturumun, kurulan org) | `worldOfOrg(orgId)` → `findUserInWorld` / `emailTakenInOrgWorld` |
| Oturumsuz, herkese açık akış | `worldForHeaders(...)` / `worldForHeaderBag(...)` → `findUserInWorld` |
| Akışın işi zaten dünyalar arası (girişin `WRONG_WORLD_*` parola kontrolü, hesap silme) | `findUsersByEmail`, **neden** olduğunu söyleyen bir yorumla |

E-postadan kullanıcı arayan tek kod `src/lib/userWorld.ts`'tir. `select`
**zorunludur** (`Json` sütunları okurken patlayabilir, #1150 —
`scripts/check-auth-reads.mjs`). Düz ESM betikler (`prisma/seed*.mjs`,
`scripts/*.mjs`) TypeScript'i içe alamaz; `worldUserWhere`'in elle yazılmış
aynasını kullanır. Bunu CI'da `scripts/check-user-email-lookups.mjs` zorlar:
`userWorld.ts` dışında e-postayla kullanıcı arayan bir yer eklemek kırmızı
yapar; neyi taradığı ve hangi istisnalara izin verdiği için betiğin kendisine bak.

## Yerel geliştirme ve e2e

**Elle.** `.env`'e `MARKETING_HOSTS=marketing.localhost` koy, `npm run dev`'i yeniden
başlat:

- `http://localhost:3000` → internship dünyası, `http://marketing.localhost:3000` →
  marketing dünyası. Chrome ve Firefox `*.localhost`'u hosts dosyası olmadan
  `127.0.0.1`'e çözer; iki host'un çerezleri ayrıdır, yani aynı kişi ikisinde birden
  açık olabilir.
- Sunucunun kurduğu **mutlak** marketing bağlantıları (posta) portsuz çıkar (`http://marketing.localhost`), çünkü port yalnızca
  yapılandırılmış host'un kendisi için geri konur. `:3000`'i elle ekle.
- `MARKETING_HOSTS=localhost` bütün dev sunucusunu marketing ürünü yapar (port o
  zaman korunur); iki dünyayı yan yana denemek için işe yaramaz.
- İki dünyayı hazır görmek için `npm run seed:demo` marketing kiracısını da ekler
  (`prisma/seed-demo-marketing.mjs`); aynı e-postayı iki org'a elle koymak da
  yeterlidir (`@@unique([email, orgId])`).

**e2e.** Marketing host'u sahte başlıkla taklit edilir; proxy yoktur, başlığı istemci
yazar (güven notu bunu güvenli kılıyor):
`{ 'x-forwarded-host': 'marketing.bcsit-gmbh.de' }` — `page.setExtraHTTPHeaders(...)`
tarayıcı için, `page.request.get(path, { headers })` doğrudan istek için
(`e2e/host-coherent-redirects.spec.ts`, `e2e/host-vertical-public-pages.spec.ts`).
İki kiracılı fixture `e2e/helpers/tenants.ts`'te (`verticalA` / `verticalB`).

## Deploy ve geçiş

`prisma db push` `User_email_key` benzersiz indeksini **düşürür** ve
`(email, orgId)` benzersiz indeksini **ekler**: eski kısıt her adresi zaten tek
satıra indirdiği için yeni kısıtı ihlal edecek satır olamaz. **Uygulanabilir ve
veri kaybı yoktur**; zorunlu, istemci tarafı varsayılanlı yeni sütun ya da `@id`
değişikliği (`npm run check:schema-push`'un yakaladığı türden) yok. Adres araması
için ayrı bir indeks gerekmez: bileşik indeksin en soldaki sütunu `email`'dir.

Deploy `db push`'u konteyner değişiminden önce çalıştırır; o pencerede eski konteyner
eski koduyla ayakta kalır ve kırılmaz — eski `findUnique({ where: { email } })` düz
bir `WHERE email = ?` olarak çalışmaya devam eder (kaybolan tek şey, eski kodun
zaten "tek hesap" varsaydığı benzersizlik kısıtıdır). Şema değiştiği için dal
değiştirince `npx prisma generate` şart: eski istemci `email`'i hâlâ benzersiz
sanır ve tip denetimi yanlış yerde susar. Yeni bir yapılandırma değişkeni yok;
`MARKETING_HOSTS` zaten vardı ve artık bir **kimlik doğrulama** ayarıdır
(bkz. `.env.example`).

## Bilinen sınırlar

- **Ürün başına tek hesap:** (e-posta, ürün) başına bir. Aynı posta kutusu için
  ikinci bir `MARKETING` org'unda hesap açmak reddedilir (`emailTakenInWorld`);
  iki org'a aynı ürün içinde üye olmak bu modelde yok.
- **Topic ortamları tek host sunar** (`pr<N>.interncrm.com`): `MARKETING_HOSTS`
  verilmedikçe yalnızca internship dünyasını gösterirler. Marketing hesabıyla
  girmeye çalışan biri yalnızca "bu bilgilerle bir Internship CRM hesabı yok"
  mesajını alır.
- **Org'un ürününü değiştirmek oturumdan yapılamaz** (süper-admin dünya başına);
  gerekirse bu bir operatör işidir ve taşıma kontrolü (aynı adresli hesap) yine geçerlidir.
- **Yanlış kapı hesabın varlığını açık eder** (yalnızca parolanın sahibine: cevap
  "e-posta veya parola hatalı"dan farklıdır, ama sayfa öbür ürünü adlandırmaz);
  karar ve gerekçe `docs/security-exceptions.md`'de.

## Değiştirirken

- Bir `User` oluşturan **her** yeni yol `emailTakenInWorld` / `emailTakenInOrgWorld`
  çağırır. Veritabanı bunu tek başına yakalamaz.
- Bir postaya bağlantı koyuyorsan origin'i `NEXTAUTH_URL`'den değil alıcının
  org'undan al (`appUrlFor`).
- Yeni bir "e-postadan hesap bul" ihtiyacı `userWorld.ts`'e girer, başka yere değil.
- Bir oturum sağlayıcısı (grant) eklersen `assertAccountMatchesHost`'u çağır; yoksa
  o yol, host'un dünyasını görmezden gelen bir kapı olur.
- Bu belgeyi ve `CLAUDE.md`'deki maddeyi aynı commit'te güncelle.
