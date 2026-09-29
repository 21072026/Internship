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
  `authorize()`'a düz bir nesne verir), `originForWorld(world)`, `worldOrigins()`.

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
4. Zorunlu-SSO kapısı, tek hesaplı yoldaki gibi bcrypt'ten önce durur (#1950).
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

**Giriş sayfası** (`src/app/auth/signin`). Sunucu sayfası `worldOrigins()`'i hesaplar
ve istemciye prop olarak verir — istemci env okuyamaz, `MARKETING_HOSTS` çalışma
zamanı değişkenidir ve sayfa bu yüzden `force-dynamic`. `WRONG_WORLD_*` gelince
form ham kodu göstermez; "e-posta ve parolan doğru ama bu hesap {ürün} içinde"
der (`t.auth.wrongWorld`, EN/TR/DE; ürün adı `productNameFor()`'dan) ve
`<öbür origin>/auth/signin` bağlantısını verir (`data-testid="wrong-world-link"`).
`callbackUrl` taşınmaz: o bir yol, öbür üründe anlamı yok.

**Grant sağlayıcıları** (`impersonate`, `sso`, `remember`) kullanıcıyı host değil
grant seçtiği için tersinden korunur: `assertAccountMatchesHost` hesabın dünyası
host'un dünyasından farklıysa `WRONG_WORLD_*` fırlatır.
`POST /api/admin/impersonate` aynı kuralı bir adım **önce** sorar (`400
wrong_world`): yoksa grant basılır, `IMPERSONATE_START` yazılır ve hedefe "hesabına
erişildi" bildirimi gider — sonra girişi reddedilen, hiç olmamış bir erişim için.
`POST /api/auth/remember/refresh` cihaz sırrını **döndürmeden önce** reddeder ve
çerezleri temizler.

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
- Kayıt sayfası, marketing host'unda (`isMarketing`) formun altında şunu söyler:
  "Bu adresle zaten Internship CRM kullanıyor musun? Bu ayrı bir SaleVali hesabı
  oluşturur…" (`t.auth.separateAccountHint`). Adresin öbür üründe gerçekten hesabı
  olup olmadığını **söylemez** — söyleyemez, söylerse yoklama aracı olurdu.
  Internship host'undaki açık kayıt olduğu gibi bırakıldı.

**Bakımcı marketing hesabını nasıl alır?** Kendi adresini marketing org'una davet
ederek:

1. Marketing org'unun bir `ADMIN`'i varsa: o admin `/admin/invite`'tan rol `ADMIN`
   ile bakımcının adresini davet eder. Postadaki bağlantı marketing host'unu
   açar, "Davet Token'ı" dolu gelir, kayıt marketing org'unda **ikinci** satırı
   yaratır; internship hesabına dokunulmaz. Sonra iki host'ta da aynı adresle girilir;
   parolalar iki ayrı satırdır, aynı seçilse bile biri değişince öbürü değişmez.
2. Marketing org'unun hiç admin'i yoksa (ilk kurulum): süper-admin
   `/admin/organizations`'ta org'u açar ve `vertical = MARKETING` yapar, ama o ekran
   **insan davet etmez**; `POST /api/invite` daveti her zaman *oturumun kendi
   org'una* yazar (`resolveOrgId(session)`), yani bir internship admin'i bugün
   marketing org'una davet gönderemez. Bu bir **açık boşluktur**: çare, yalnızca
   süper-admin için `orgId` alan bir davet yolu ya da org ekranında "ilk admin'i
   davet et" düğmesidir. O gelene kadar ilk admin satırını gözden geçirilmiş
   tek seferlik bir betikle açmak gerekir (böyle bir betik henüz yok).

Süper-admin org ekranı ürünü de değiştirebilir (`PATCH` `vertical`) ve bu bir
**taşımadır**: org'un bütün insanları tek `UPDATE`'te öbür dünyaya geçer. Hedef
dünyada, taşınan org'un bir adresini zaten tutan hesap varsa `409
vertical_move_email_conflict` ile reddedilir (`src/lib/verticalMove.ts`); yanıt
yalnızca **sayıyı** verir, adres vermez — adresler iki farklı kiracının insanlarına
ait.

## Parola sıfırlama ve doğrulama

Bir akış bir hesaba **etki ediyorsa** (parola sıfırlama, e-posta doğrulama, hesap
silme, e-posta değiştirme, kilit temizleme, bildirim, abonelikten çıkma) yalnızca
üretildiği satıra / oturumun satırına etki eder — "bu e-postalı her satıra" değil.
Token'lar `userId` ile anahtarlıdır ve öyle kalmalıdır.

- **`POST /api/auth/forgot`** oturumsuzdur; dünyayı **form'un sunulduğu host**
  söyler. O dünyada hesap yoksa ve adresin başka dünyada **tam bir** hesabı varsa
  sıfırlama o hesap için yollanır ve postadaki bağlantı **o hesabın kendi ürününü**
  açar (yanlış kapıda kalmış kişiyi doğru kapıya götürür). Birden çok aday varsa
  tahmin edilmez, hiçbir şey yollanmaz. Yanıt her durumda aynıdır — "bulundu",
  "öbür dünyada bulundu", "belirsiz", "yok" dışarıdan ayırt edilemez
  (`findAccountsForMailedLink`, `src/lib/passwordReset.ts`).
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
| Akışın işi zaten dünyalar arası (giriş sayfasının "öbür kapı"sı, hesap silme, "yanlış kapı" kurtarma postası) | `findUsersByEmail`, **neden** olduğunu söyleyen bir yorumla |

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
- Sunucunun kurduğu **mutlak** marketing bağlantıları (posta, giriş sayfasının "öbür
  site" bağlantısı) portsuz çıkar (`http://marketing.localhost`), çünkü port yalnızca
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
  girmeye çalışan biri "yanlış kapı" mesajını alır, ama bağlantı varsayılan (üretim)
  marketing host'una gider, topic ortamına değil.
- **Org'un ürününü değiştirmek insanlarını taşır** ve hedefte aynı adresli hesap
  varsa reddedilir; reddedildiği için sayısı bilinir, adresleri bilinmez — çözüm
  kiracının kendi admin'iyle adresi değiştirmek ya da eski kopyayı silmektir.
- **İlk marketing admin'ini davet edecek ekran yok** ([İkinci dünyaya davet](#ikinci-dünyaya-davet)).
- **Yanlış kapı hesabın varlığını açık eder** (yalnızca parolanın sahibine); karar
  ve gerekçe `docs/security-exceptions.md`'de.

## Değiştirirken

- Bir `User` oluşturan **her** yeni yol `emailTakenInWorld` / `emailTakenInOrgWorld`
  çağırır. Veritabanı bunu tek başına yakalamaz.
- Bir postaya bağlantı koyuyorsan origin'i `NEXTAUTH_URL`'den değil alıcının
  org'undan al (`appUrlFor`).
- Yeni bir "e-postadan hesap bul" ihtiyacı `userWorld.ts`'e girer, başka yere değil.
- Bir oturum sağlayıcısı (grant) eklersen `assertAccountMatchesHost`'u çağır; yoksa
  o yol, host'un dünyasını görmezden gelen bir kapı olur.
- Bu belgeyi ve `CLAUDE.md`'deki maddeyi aynı commit'te güncelle.
