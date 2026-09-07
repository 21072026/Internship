# Beceri listeleri: bölme, uyarı, limit

**Tek kural, tek dosya:** [`src/lib/skills.ts`](../src/lib/skills.ts). İstemci de sunucu da
oradan okur. Bir sınırın yalnızca bir tarafta durması sınır değildir (#2314).

## Ne oldu (kuralın var olma sebebi)

`/admin` panosundaki **Yeni Adaylar** kartında bir adayın beceri rozeti kartın yarısını
kapladı:

> Java C# / .NET Backend Development REST API / API Development SQL / PostgreSQL Spring Boot
> FastAPI Python Generative AI / AI Tools Power BI Microsoft Excel Git / GitHub Swagger / API
> Testing Entity Framework Core Data Analysis Database Management

Bu **tek bir** `User.skills` girdisiydi. Üç karar üst üste gelince oluştu:

1. Her form yalnızca virgülle bölüyordu (`skills.split(',')`).
2. Alan tek satırlık bir `<input>`'tu — **tarayıcı, çok satırlı bir yapıştırmanın satır
   sonlarını atar**. CV'den kopyalanan satır satır liste, boşlukla birleşmiş hâlde, yani
   bölünecek hiçbir ayırıcı kalmadan geldi.
3. Hiçbir yazma yolunda sınır yoktu: `/api/profile` şeması `z.array(z.string())`'ti — ne
   beceri başına uzunluk ne adet.

Dersi tersten okumak gerekiyor: (2) yüzünden **sunucuda ya da migration'da telafi
edilemez** bir kayıp oluşuyor. Ayırıcıların hâlâ durduğu tek yer panodur.

## Kural

### Bölme (`splitSkillInput`)

Ayırıcılar: `,` `;` satır sonu, sekme, `•` `·` `|` ve satır başındaki liste işaretleri
(`-` `*` `–` `—`, `1.`, `2)`).

Kasten **ayırıcı olmayanlar**:

| Neden bölmüyor | Örnek |
|---|---|
| `/` — insanlar tek bir beceriyi böyle yazıyor | `SQL / PostgreSQL`, `Generative AI / AI Tools` |
| `&`, `+`, `-` | `R&D`, `C++`, `front-end` |
| boşluk | `Data Analysis` |
| parantez/köşeli parantez **içindeki** ayırıcı | `Microsoft Office (Word, Excel, PowerPoint)` |

Tekilleştirme Türkçe farkındadır (`skillKey`): `Yazılım` ile `yazilim` aynı beceridir, ilk
yazım korunur.

### Limit

| | Profil (`SKILL_LIMITS`) | İş talebi (`REQUISITION_SKILL_LIMITS`) |
|---|---|---|
| Beceri sayısı | 40 | 50 |
| Bir beceri | 60 karakter | 100 karakter |

40/60 cömert: olaydaki yapıştırma 15 gerçek beceri, deneyimli bir mentor 25-30 yazıyor.
Ötesi bir profil değil, hiçbir kartın, rozet satırının veya eşleşme sorgusunun anlamlı
kullanamadığı bir anahtar kelime yığınıdır.

### İki mod: reddet mi, kırp mı

`parseSkills` **hiçbir şeyi kırpmaz**; sorunları `issues` olarak bildirir
(`split`, `duplicate`, `too_long`, `too_many`). Karar çağıranın:

* **Reddeden yollar** — karşısında kendi profilini düzenleyen bir insan var, hata
  eyleme dönüşebilir: `/api/profile`, `/api/users/[id]`, `normalizeSkills`
  (iş talepleri). `blockingSkillIssue` + `skillErrorBody` → 400,
  `code: 'too_long' | 'too_many'`. Yarım bir cümleyi sessizce kaydetmek en kötü seçenek.
* **Kırpan yollar** (`capSkills`) — bir beceri alanı yüzünden başarısız olmaması gerekenler:
  herkese açık başvuru (`/api/apply`), mentor başvurusu, kaynak (SOURCE) girişi, **kayıt
  birleştirme** (40+40 birleşimi 80 olabilir; birleştirme asla bunun yüzünden düşmemeli) ve
  AI/CV çıkarımı.

### Uyarı (istemci)

[`src/components/ui/SkillsField.tsx`](../src/components/ui/SkillsField.tsx) — paylaşılan
chip editörü. **Yapıştırmayı `onPaste` ile panodan okur**, `<input>`'un değerinden değil:
bu bileşenin var olma sebebi tek başına budur. Ayrıca:

* canlı sayaç (`12 / 40`; 30'dan sonra amber, sınırda kırmızı),
* yapıştırmadan sonra "N ayrı beceri olarak eklendi",
* reddedilen girdi için sebebi (`skillsInput.tooLong` — metin kutuda kalır ki yeniden
  yazılmasın), tekrar eden beceri için bildirim,
* kayıtlı listesi kuralı çiğneyen eski bir satır için uyarı — kaydetme 400 dönmeden önce.

Kullandığı yerler: mentee profili, iki onboarding sihirbazı, herkese açık başvuru, mentor
başvurusu, kaynak portalı, admin mentor-uzmanlık dialogu, iş talebi editörü. **Beceri
girilen yeni bir alan da bunu kullanmalı** — düz bir `<Input>` + `split(',')` geri gelirse
hata da geri gelir.

## Görüntüleme ağı

`clipSkillLabel` yoğun listelerde etiketi kırpar, tam metni `title` ile verir
(`/admin`, `/admin/candidates` her iki liste, `/mentors`). Veri artık kuralla korunuyor;
bu ağ **düzeltmeden önce yazılmış satırlar** için — bir tanesi hiçbir kartı bir daha
bozmasın diye.

## Eski kayıtlar

[`prisma/backfill-skill-lists.mjs`](../prisma/backfill-skill-lists.mjs) —
`User.skills` ve `MentorApplication.expertise`'i yeniden böler. Öntanımlı olarak dry-run;
`--apply` yazar, `--verbose` her değişikliği basar. `infra/deploy-prod.sh`'e bağlı (prod +
preview aynı script). Kural bir sabit nokta olduğu için ikinci çalıştırma no-op'tur.

Ayırıcıları **zaten yok olmuş** bir blob burada kurtarılamaz — "Data Analysis"in bir mi iki
beceri mi olduğunu söylemenin yolu yok. Onlar 60 karaktere kırpılır ve **sayılarak
raporlanır**, tahmin edilmez; kalanı, artık yapıştırmayı bozmayan bir alanda kişi kendisi
yazabilir.

## İki uygulama, tek kural

`prisma/skill-split.mjs`, kuralın düz ESM aynası: backfill sunucuda `node prisma/*.mjs`
olarak çalışır (Node 20, tip soyma yok, `@/` alias yok), yani TypeScript modülünü import
edemez — `src/lib/plans.ts` ile plan backfill'inin yaşadığı bölünmenin aynısı (#1731).
Karşılaştırılmayan kopya kayan kopyadır: `scripts/test/skills.test.mjs` bir korpusu
**ikisinden de** geçirir ve ilk ayrışmada kırmızı olur. Birini değiştiren aynı commit'te
diğerini de değiştirir.
