# SaleVali kullanım beslemesi: veri sözleşmesi (#2445 / story #2399)

Bir tüccarın SaleVali'de ne kadar iş yaptığı, CRM'de **elle yazılan** bir sayı.
Elle yazılan sayı tanımı gereği bayattır, ve bu dikeyin sattığı iki sinyalden
biri — *hacmi düşen müşteri gidiyor* — tam olarak o sayıya dayanıyor. Bu dosya,
o sayının SaleVali'den CRM'e **nasıl** geleceğinin yazılı hâli: taşıma, kimlik
anahtarı, alanlar, tanecik, yenileme penceresi, kimin neyin üzerine
yazabileceği ve motorun **yapmadıkları**.

Şekli bilerek [`docs/roster-feed.md`](../roster-feed.md)'den alıyor: bu repo'da
zaten **bir** dış besleme motoru var ve ikincisi yazılmayacak. Aşağıdaki
kararların çoğu da yeniden verilmiş kararlar değil — repo'da bir kez verilmiş ve
burada yalnızca **atıfta bulunulan** kararlar.

> **Sahiplik.** Sözleşmenin CRM tarafındaki sahibi dikeyin operatörü (org'un
> ADMIN'i), kaynak tarafındaki sahibi SaleVali ürün ekibi. Alan eklemek,
> kaldırmak veya anlamını değiştirmek **bu dosyayı aynı değişiklikte
> güncellemek** demektir; sessizce değişen bir sütun, gecelik işin sessizce
> yanlış sayı yazması demektir.
>
> **Veri koruma burada yeniden anlatılmıyor.** Üçüncü taraf kaydı
> [`docs/trust/subprocessors.md`](../trust/subprocessors.md)'de (§ *Not
> subprocessors* — besleme **gelen** yönlüdür), katkıcıların gerçek bir
> beslemeye bağlanmama kuralı ise
> [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md) kural 5'te.

## Parçalar nerede yaşıyor

| Dosya | Sahip olduğu şey | Durum |
|---|---|---|
| `prisma/schema.prisma` → `CompanyUsage`, `Company.externalId` | Tablo ve dış kimlik sütunu (#2446) | **Var** |
| `src/lib/orgContext.ts` → `TENANT_MODELS` | `CompanyUsage`'ın kiracı kapsamı | **Var** |
| `src/lib/retentionEntries.ts` → `companyUsage` girdisi | 400 günlük pencere, tek saklama zamanlaması | **Var** |
| `src/lib/ssrfGuard.ts` → `assertPublicHttpsUrl()` | Kiracının verdiği URL'i çekmenin **tek** güvenli yolu | Var (#893) |
| `src/lib/externalSyncPolicy.ts` → `planFieldUpdates()` | "Operatörün yazdığının üzerine kim yazabilir" — tüm ağaç için tek cevap | Var (#1943/#1965) |
| `src/lib/importPreview.ts` | Paylaşılan ayrıştırıcı ve `runImport` motoru | Var (#2072) |
| `src/lib/jobs/lease.ts`, `src/app/api/cron/route.ts` | Ortam başına tek koşan iş | Var (#1701) |
| Gecelik `salevali-usage` işi | Çekme, eşleştirme, upsert, raporlama | **Yok — #2447** |
| Kullanım sparkline'ı / churn filtresi | Okuma yüzeyleri | **Yok — #2448 / #2449** |

Bu dilim **tablo ve sözleşmedir**. Bugün `CompanyUsage`'a yazan hiçbir kod,
okuyan hiçbir ekran yok; ilk yazar #2447.

## Sözleşme bir MARKETING organizasyonu başınadır

Sözleşme "CRM ile SaleVali arasında" değil, **`Organization` ile SaleVali
arasında**. Bu bir kelime oyunu değil, üç somut sonucu var:

- URL, kimlik bilgisi ve yenileme penceresi org'un yapılandırmasıdır; ikinci bir
  MARKETING kiracısı kendi beslemesini tanımlar ve birincinin verisini görmez.
- Dış id'ler **yalnızca kendi org'u içinde** çözümlenir (aşağıya bakın).
- INTERNSHIP dikeyindeki bir kiracı için besleme diye bir şey yoktur; tablo
  vardır, dolduran yoktur.

## Taşıma: CRM çeker, SaleVali itmez

**Pull, HTTPS.** Karar ve gerekçesi:

- Bir push, SaleVali'nin CRM'in kimlik bilgisini taşıması ve CRM'in kiracı
  haritasını bilmesi demektir — sır iki tarafa birden dağılır.
- Başarısız bir push kaybolur; başarısız bir pull **kendi kendine yeniden
  denenir**, çünkü bir sonraki gece pencereyi örterek yeniden çeker.
- Çekme yarısı zaten yazılı: `assertPublicHttpsUrl()` (kiracının verdiği URL
  sunucunun ağ konumundan çekiliyor — SSRF varsayımsal değil), `redirect:
  'error'`, boyut tavanı, dosya hash'i eşitse **no-op**.

Kimlik bilgisi asla bir DB satırında yaşamaz. `RosterFeed.credentialEnvVar`
deseni aynen geçerlidir: satır ortam değişkeninin **adını** saklar, değerini
değil — *bir veritabanı satırındaki sır, her yedekteki sırdır*.

Biçim **sınırlandırılmış metindir** (CSV; tırnaklı satır sonları, CRLF, BOM ve
Alman Excel'inin `;`'si dâhil) ve paylaşılan ayrıştırıcıdan geçer. JSON kabul
edilmiyor — kabul etmek **ikinci bir ayrıştırıcı** yazmak demek, ki bu repo'nun
açık kuralıdır (`CLAUDE.md` → *One import engine, one parser*).

## Kimlik anahtarı: kiracı kapsamlı, benzersiz **olmayan** dış id

Anahtar `Company.externalId` — SaleVali'deki hesabın kendi kimliği.

- Sütun `@unique` **değil**, `@@index([orgId, externalId])` var. Devralınan
  backlog `@unique` istiyordu; MySQL benzersiz indekste NULL'ları *farklı*
  saydığı için nullable bir çift üzerindeki bileşik unique hiçbir şeyi
  tekilleştirmez — gerekçe repo'da iki kez yazılı (`User.externalId`,
  `Job.idempotencyKey`) ve sütunun kendi yorumunda üçüncü kez.
- Eşleştirme **her zaman org içinde**: `{ orgId, externalId }`. Küresel bir
  arama, iki kiracının aynı id'yi kullanmasını bir çakışmaya çevirir.
- **Eşleşmeyen id düşürülmez, raporlanır** (sayı + örnek). O sayı, "içe aktarım
  birini atlamış" ya da "kimsenin haberi olmadan yeni bir tüccar gelmiş"in tek
  göstergesi.
- **İki eşleşme bir hatadır**, tahmin değil: satır `ERROR` olarak kaydedilir ve
  hiçbir şey yazılmaz.
- Besleme **hesap açmaz**. Bir dış id'den `Company` yaratmak ayrı bir
  sözleşmedir (makineden makineye lead ingest, #2450) ve kendi idempotency
  kuralı vardır.

## Alanlar ve tanecik: hesap × gün

| Sütun | Tip | Zorunlu | Anlamı |
|---|---|---|---|
| `external_id` | metin, ≤ 191 | evet | SaleVali hesabının kimliği; `Company.externalId` ile eşleşir |
| `date` | `YYYY-MM-DD`, **UTC günü** | evet | Kullanımın gerçekleştiği gün — an değil |
| `transactions` | tam sayı ≥ 0 | evet | O günün **mutlak** işlem sayısı |
| `orders` | tam sayı ≥ 0 | hayır | O günün sipariş sayısı; besleme taşımıyorsa boş |

Tanecik **hesap × gün**, ve bu tabloyu `UsageRollup`'tan ayıran şey tam olarak
bu: `UsageRollup` (org, metrik, **takvim ayı**) bazlı faturalama ölçümüdür ve
aylık toplamlardan yapılmış bir churn sinyali, tüccar iş yapmayı bıraktıktan
altı hafta sonra gelir.

Sayılar **mutlaktır, delta değildir**: bir günü yeniden çekmek o günün
**üzerine yazar**. Örtüşen pencere ancak böyle zararsız olur.

**Sözleşmede bilerek olmayanlar:** tüccarın müşterisine ait hiçbir şey (isim,
e-posta, adres, sipariş satırları), serbest metin, ve **para**. Ciro, MRR,
anlaşma değeri CRM'in kendi kaydıdır; bir beslemenin bunları oynatabilmesi,
operatörün savunduğu bir sayıyı doğrulanamaz hâle getirir.

## Yenileme penceresi: örtüşen, "son koşudan beri" değil

Gecelik koşu **son 7 günü** yeniden çeker. "Son başarılı koşudan beri" yaklaşımı
bir kaçan geceyi (düşen iş, yeniden başlayan konteyner, ağ hıçkırığı) grafikte
**kalıcı bir deliğe** çevirir; örtüşen pencere onu kendiliğinden kapatır ve
`@@unique([companyId, date])` tekrarı idempotent kılar.

- Günün kendisi kısmi olabilir; yarın mutlak sayıyla üzerine yazılır.
- Geçmişi ilk kez doldurmak aynı yolun daha geniş pencereli tek seferlik
  koşusudur — ikinci bir mekanizma değil.
- Dosya hash'i bir öncekiyle aynıysa koşu **no-op**'tur: değişmeyen bir dışa
  aktarım, `updatedAt` sütunlarını ve denetim izini kirletmemelidir.

## Kimin yazdığının üzerine kim yazabilir

İki ayrı soru, ve yalnızca ikincisi gerçek bir soru:

1. **`CompanyUsage` satırları.** İnsan yazmaz, yalnızca besleme yazar. Üzerine
   yazma politikası bu tabloda *doğmaz*; bir günün yeniden yazılması sözleşmenin
   kendisidir (mutlak sayılar).
2. **`Company` alanları.** Besleme yalnızca **boş** bir `externalId`'yi
   doldurabilir (bir boşluğu kapatmak). Başka hiçbir alana — isim, iletişim,
   sektör, kota — dokunmaz.

İkinci sorunun cevabı burada **yeniden tanımlanmıyor**: tüm ağaç için bir kez
`src/lib/externalSyncPolicy.ts`'te verilmiş (`planFieldUpdates`): boş alan
doldurulabilir; dolu alan kiracının kendi verisidir ve **yetkili olmayan** bir
kaynak ona dokunmaz, `withheld` olarak raporlar; yalnızca kiracının "bu sistem
kaynağın kendisidir" dediği **yetkili** bir besleme üzerine yazar. İkinci bir
cevap yazılmayacak.

## Kiracılık

Gecelik koşunun **oturumu yoktur**, dolayısıyla `withTenantScope(session, …)`
ona kapalıdır. Besleme satırı hangi kiracı olduğunu söyleyen şeydir ve koşu tüm
işi `runWithOrg(feed.orgId, …)` içinde yapar — `src/lib/rosterIngestStore.ts`
ile birebir aynı desen. `CompanyUsage` `TENANT_MODELS`'te kayıtlıdır; **kayıt
yazmaları da değiştirir** (middleware `create`'e `orgId`'yi kendi koyar), bu
yüzden bağlam bağlamayan her yazıcı `orgId`'yi kendisi geçmek zorundadır.

## Saklama

Günde hesap başına bir satır, sonsuza kadar — bu, `PageView`'ın dersinin aynısı
(`prisma/schema.prisma`, `@@index([createdAt])` üzerindeki not). Bu yüzden tablo
tek saklama kayıt defterine **yazan ilk kod gelmeden önce** girdi:
`src/lib/retentionEntries.ts` → `companyUsage`, **400 gün**. En geniş okuyucu 90
gün (sparkline) ve 120 gün (churn kuralı); 400 gün, yıldan yıla bir
karşılaştırmanın iki ucunu da içeride tutar. İkinci bir temizlik işi açılmıyor.

## Bu beslemede olmayanlar

- **Push ucu.** SaleVali'nin CRM'e satır yazması ayrı bir sözleşmedir (#2450) ve
  kendi idempotency + "kaydı funnel'da geriye taşıma" kuralıyla gelir (#2451).
- **Aşama değişikliği.** Hiçbir kullanım verisi bir kaydı ilerletmez, geriletmez
  ya da kapatır. Aşama yazmaları `src/lib/stageChange.ts`'ten geçer; churn
  filtresi (#2449) yalnızca **gösterir**.
- **Hesap açma.** Eşleşmeyen dış id raporlanır; `Company` yaratılmaz.
- **Para ve faturalama.** Faturalanabilir birim `src/lib/meteringRules.ts`'te
  tanımlıdır ve bu tabloyu okumaz. Kullanım **raporlanır, kapı olmaz**.
- **Kişisel veri.** Sözleşme tüccarın *hacmini* taşır, müşterisini değil.
- **SFTP.** Yalnızca HTTPS; roster motorunun SFTP istemcisi de henüz yok ve
  sessizce daha zayıf bir taşımaya düşmek yerine gürültüyle reddediyor.
- **İkinci bir şey.** İkinci ayrıştırıcı, ikinci içe aktarım motoru, ikinci cron
  kayıt defteri, ikinci kiralama (lease) mekanizması yok.
