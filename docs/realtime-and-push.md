# Canlı mesajlaşma ve bildirimler

Bu doküman, mesajlaşmanın "yeni bir şey oldu" sinyalini taşıyan üç kanalı ve
bunların neden bu şekilde kurulduğunu anlatır (#1464, #675).

| Kanal | Ne zaman çalışır | Nerede görünür |
|---|---|---|
| Canlı akış (SSE) | Uygulama bir sekmede açıkken | Gelen kutusu, açık thread, başlıktaki sayaç, zil |
| In-app bildirim + e-posta | Her zaman | Zil, `/notifications`, e-posta yansıtması |
| Web Push | Uygulama kapalıyken (izin verildiyse) | İşletim sisteminin bildirim alanı |

## 1. Okunmadı sinyali tek bir gerçektir

Aynı olay iki ayrı yerde saklanıyor: mesaj sayaçları (`Message.readAt`,
`ConversationParticipant.lastReadAt`) ve `notify()`'ın yazdığı `Notification`
satırı. Bir thread okunduğunda **ikisi de** kapanmak zorunda; yoksa mesaj
okunmuş olmasına rağmen zildeki mavi "yeni mesaj" satırı duruyor — #1464'ün
bildirilen hatası tam olarak buydu.

Tek giriş noktası `markThreadRead()` (`src/lib/threadRead.ts`): sayaçları, katılımcı
imlecini ve `markThreadNotificationsRead()` üzerinden bildirim satırlarını birlikte
kapatır. Thread'i okumanın **her** yolu buradan geçer — ekranda açmak
(`GET /api/messages`), e-postayla cevaplamak, bildirim e-postasındaki "okundu
işaretle" linki. Yeni bir okuma yolu eklerken bu fonksiyonu çağır, kendi
`updateMany`'ini yazma.

Bildirim satırları `link` üzerinden eşleşiyor (`/messages/c/<id>` veya
`/messages/<relationId>`) — ayrı bir `threadId` kolonu yerine link, çünkü
insanların zilinde **zaten duran** satırlar da bu şekilde temizleniyor ve bir 1:1
thread hayatı boyunca iki link biçimi de kullanmış oluyor (#1156).

## 2. Canlı akış: neden SSE, WebSocket/SignalR değil

Mesaj ekranlarının ihtiyacı tek yönlü: sunucu → istemci, "şu thread değişti,
tazele". Gönderme hâlâ sıradan bir `POST /api/messages` — yetkilendirme,
doğrulama ve ek dosya işleme zaten orada.

- **SSE düz HTTP.** Plesk'in nginx'i arkasında tek bir başlıkla
  (`X-Accel-Buffering: no`) çalışıyor; WebSocket ayrı bir upgrade yolu ve ayrı
  proxy ayarı isteyecekti.
- **`EventSource` yeniden bağlanmayı kendi yapıyor.** İstemcide backoff yazmak
  yok; sunucu `retry:` ile aralığı söylüyor.
- **Ek bağımlılık ve ek süreç yok.** SignalR .NET tarafının çözümü; Node
  dünyasındaki karşılığı (socket.io + bir broker) burada çalıştırılacak ve
  izlenecek altyapı demek — ortam başına tek bir konteyner varken (bkz.
  CLAUDE.md deploy tablosu) getirisi sıfır.

### Parçalar

- `src/lib/realtimeBus.ts` — süreç içi pub/sub. Yazan taraf (mesaj POST'u,
  gelen e-posta köprüsü, `notify()`) ilgili kullanıcı id'lerine tek satırlık bir
  olay yayınlar. Kullanıcı başına açık bağlantı sayısı sınırlı
  (`MAX_CONNECTIONS_PER_USER`).
- `src/app/api/realtime/stream/route.ts` — SSE ucu. 25 saniyede bir heartbeat
  yazar (aynı zamanda nginx'in `proxy_read_timeout`'unu ve telefon radyosunu
  uyanık tutan şey) ve **her heartbeat'te okunmadı sayaçlarını veritabanından
  yeniden okur**. Bus teslimatı anlık yapar; veritabanı kontrolü doğruluğu
  garanti eder — yani ileride replika sayısı artarsa davranış "bir heartbeat
  gecikmeli" olur, bozulmaz.
- `src/lib/realtimeClient.ts` — tarayıcı tarafı. Sekme başına **tek** bir
  `EventSource`; başlıktaki sayaç, zil, gelen kutusu ve açık thread aynı bağlantıyı
  paylaşır. Akış kurulamazsa (proxy yutuyorsa, bağlantı sınırı doluysa)
  `/api/messages/unread` poll'una düşer ve 5 dakika sonra akışı tekrar dener.
- `src/hooks/useRealtime.ts` — `useRealtime(handler)` ve `useUnreadCounts()`.
  Handler bir ref'te tutulur, effect yalnızca oturum durumuna bağlıdır: aksi
  hâlde her render'da bağlantı kopar ve yeniden kurulurdu.

Akış **yalnızca id taşır**, mesaj gövdesi taşımaz. İstemci sinyali duyunca normal
yetkili uca gidip thread'i yeniden çeker — böylece bir mesajı okumanın tek bir
kod yolu kalır ve bu uç ikinci, daha zayıf bir okuma kapısına dönüşemez.

### Replikalar arası teslimat (#1698)

`REALTIME_REDIS_URL` ayarlıysa bus, her yayını yerel dinleyicilere verdikten
sonra aynı sinyali bir Redis pub/sub kanalına da yazar
(`src/lib/realtimeBroker.ts`); öbür replikalar onu kendi dinleyicilerine
dağıtır, yayıncı kendi yankısını `origin` ile tanıyıp atlar. Ayarlı değilse
davranış birebir eskisi: süreç içi teslimat + heartbeat düzeltmesi.

- **Kanaldan geçen yalnızca sinyal.** Olay tipi, en çok üç id ve alıcı
  kullanıcı id'leri — `src/lib/realtimeBrokerRule.ts` bunu iki uçta da zorlar
  (bilinmeyen anahtar atılır, bilinmeyen tip reddedilir, id'ler log-güvenli
  alfabede, alıcı sayısı ≤ 500, yük ≤ 64 KB). Mesaj gövdesi broker'a hiç
  konmaz: konsaydı broker, birinin mesajlarını okumanın ikinci ve daha zayıf
  yolu olurdu.
- **Kanal ortam başına:** `realtime:<REALTIME_CHANNEL>` ya da
  `realtime:<NEXTAUTH_URL host'u>`. Prod ve preview aynı Redis'i paylaşsa bile
  birbirinin sinyalini duymaz.
- **Broker düşerse sessizlik yok:** yerel teslimat sürer, kesinti bir kez
  `warning` olarak loglanır, bağlantı 1 sn'den 60 sn'ye katlanan aralıklarla
  yeniden kurulur ve dönüş bir kez `info` olarak yazılır. Arada kaçan sinyali
  heartbeat'teki veritabanı kontrolü düzeltir — bu yüzden o kontrol kalıyor.
- **Bağımlılık yok:** rate-limit deposunun RESP kodlayıcı/ayrıştırıcısını
  (`src/lib/rateLimitRedis.ts`) kullanır; iki soket (PUBLISH ve SUBSCRIBE), AUTH
  ve SELECT. Aynı Redis'i `RATE_LIMIT_REDIS_URL` ile paylaşabilir — ayrı bir
  servis gerekmez.

Kanıt: `scripts/test/realtime-broker.test.mjs` gerçek soket üzerinde küçük bir
RESP sunucusuyla (AUTH/SELECT/SUBSCRIBE/PUBLISH) iki broker arasında teslimatı,
yanlış parolayı (log'a parola sızmadan), bağlantı kopup yeniden kurulmasını ve
bus'ın bir eş replikanın yayınını yerel dinleyiciye verip kendi yankısını
atladığını doğrular. Ölçülen bağlantı maliyeti ve heartbeat sapması için
`k6/sse-load.js` (#1612).

### Doğrulama

```bash
# Akışın gerçekten aktığını gör (oturum çerezi gerekir):
curl -N -H 'Accept: text/event-stream' --cookie jar.txt https://<host>/api/realtime/stream
```
İlk saniyede `retry:` ve `event: ready`, sonra 25 saniyede bir `: ping` görmelisin.
Yanıt hiç gelmiyorsa arada tampon yapan bir proxy var; `X-Accel-Buffering: no`
başlığının yanıtta olduğunu kontrol et.

`public/sw.js`'in fetch handler'ı bu yolu **kasıtla** atlıyor: aksi hâlde yarım
saat açık kalan bir GET'in gövdesi Cache API'ye yazılır ve sonraki bir çevrimdışı
isabet `EventSource`'a eski akışın sonlu bir kopyasını verir — bu da "bağlantı
kapandı" diye okunup yeniden bağlanma döngüsüne dönüşür.

## 3. Web Push (arka plan bildirimi)

#675'in Kademe 1'i sekme açıkken `new Notification(...)` gösteriyordu; Kademe 2
uygulama kapalıyken de bildirim gönderir. Push servisi **service worker'ı**
uyandırır, bildirimi sayfa değil worker gösterir.

> **Native uygulama (#2775):** `sendPushToUser` aynı yükü ve aynı kategori kontrolünü
> uygulama kurulumlarına da (`NativePushToken`, Expo push servisi) dağıtır; VAPID
> gerektirmez. Ayrıntı: [`mobile-push.md`](mobile-push.md).

### Kurulum

1. Anahtar çiftini bir kez üret: `npx web-push generate-vapid-keys`
2. `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` env'lerini ayarla
   (bkz. `.env.example`). Deploy edilen ortamlarda bunlar **sunucudaki env
   dosyasına** yazılır (`/etc/internship-crm/prod.env`,
   `/etc/internship-crm/preview.env`) — GitHub secret'ına değil; özel anahtar
   hiçbir zaman repoya girmez. Konteynere geçmesi için `infra/deploy-prod.sh`
   içindeki `app_env_args()` listesinde ve `infra/server/topic-deploy.sh`'in
   `docker run` satırlarında da yer alması gerekir; bu PR ikisine de ekledi.
   **Env dosyasına yazmak tek başına yetmez** — o listede olmayan bir değişken
   uygulamaya hiç ulaşmaz.
3. Kullanıcı `/account` → "Tarayıcı bildirimleri" anahtarını açar. Aynı anahtar
   hem ön plan bildirimini hem push aboneliğini yönetir.

**Anahtar yoksa hiçbir şey bozulmaz:** `pushConfigured()` false döner, gönderim
no-op olur, `/api/push/subscribe` 503 verir ve uygulama eskisi gibi davranır.

### Parçalar

- `src/lib/webPush.ts` — VAPID yapılandırması ve gönderim. 404/410 aboneliği
  siler (push servisi "bu endpoint artık yok" diyor); diğer hatalar geçici kabul
  edilip `failureCount` ile sayılır, üst üste 5 hatadan sonra satır düşer.
- `src/lib/messagePush.ts` — bildirim metnini **alıcının dilinde**, zilin
  kullandığı sözlük şablonundan üretir; böylece bildirim alanı ile uygulama içi
  satır aynı şeyi söyler. Push gönderen yalnızca iki kanal var: mesajlar
  (`sendNewMessagePush`) ve destek hattı (`sendSupportPush`, #3154: kullanıcının
  destek mesajı org'unun admin'lerine, admin yanıtı talep sahibine; kapatma push
  göndermez). Hangi destek olayının push gönderdiği `src/lib/supportPushRule.ts`'te;
  ayrıntı [`mobile-push.md`](mobile-push.md) § The shape.
- `src/app/api/push/config` (GET), `src/app/api/push/subscribe` (GET/POST/DELETE).
  Public key build-time `NEXT_PUBLIC_*` değişkeni **değil** bir uç: imajlar
  GitHub runner'ında derleniyor, anahtarlar yalnızca sunucuda runtime env olarak
  var (next.config.js'teki JaaS host'uyla aynı gerekçe).
- `src/lib/pushDevices.ts` — `/account`'taki cihaz listesi (#1716).
- `src/lib/deviceLabel.ts` — user-agent → "Chrome on Android". `trustedDevice.ts`
  ile **ortak** tablo; iki liste aynı cihazı aynı kelimelerle adlandırsın diye.
- `public/sw.js` — `push`, `notificationclick`, `pushsubscriptionchange` (aynı
  dosyadaki `fetch`/`message` handler'ları için bkz. § 4).
- `src/lib/pushNotifications.ts` — tarayıcı tarafı abone ol/çık.
- `src/components/ServiceWorkerRegistrar.tsx` — `/sw.js` kaydı (root layout'tan,
  her ziyaretçi için).

### Cihaz listesi (#1716)

`GET /api/push/subscribe` kullanıcının kendi aboneliklerini döner:
`{ id, label, createdAt, lastSeenAt, current }` — ve **başka hiçbir şey**.
`endpoint`, `p256dh` ve `auth` o tarayıcıya gönderim yapmanın kimlik bilgisidir;
listenin hiçbirine ihtiyacı yok, bu yüzden `listPushDevices` içindeki açık
`select` izin listesinden geçerler ve sunucudan çıkmazlar. Modele bir sütun
eklemek sessizce sızıntı başlatamaz.

**`enabled` ile satırlar birbirinden ayrı iki gerçektir.** Yanıt ikisini ayrı
taşır: `enabled` bu kurulumun hâlâ push gönderip gönderemediğini söyler (VAPID
anahtarı var mı), satırlar ise her hâlükârda döner. Sayfa bölümü **yalnızca**
push kapalıyken *ve* kayıtlı satır yokken gizler; satır varsa listeler ve üstüne
"şu anda gönderim yapılmıyor" notunu koyar. Aksi hâlde anahtarlarını kaybetmiş
bir kurulumda kullanıcı, kendi verdiği izinleri ne görebilir ne geri alabilirdi —
listenin var olma sebebi tam olarak buydu. Aynı gerekçeyle **başarısız bir GET
listeyi silmez**: bilinen son cevap ekranda kalır, üstüne "yenilenemedi" notu
düşer, ve bir revoke başarılıysa o satır yanıtı beklemeden yerel olarak da
listeden çıkar.

`label` **sunucuda** üretilir: `userAgent` sütunu şemada "serbest metin ve
güvenilmez — yalnızca gösterim" diye işaretli, bu yüzden sabit bir tablodan
geçirilir, ham hâliyle asla render edilmez.

`current` oturumdan bilinemez — bir push aboneliği kişiye değil *tarayıcı
profiline* aittir — bu yüzden sayfa kendi service worker'ının tuttuğu endpoint'i
`x-push-endpoint` başlığıyla gönderir, eşleştirme sunucuda yapılır. Query
parametresi değil **başlık**: query string erişim loglarına düşer.

`DELETE /api/push/subscribe?id=<id>` tek bir tarayıcıyı kaldırır; sorgu rotada
`{ id, userId }` ile daraltıldığı için başkasının id'si 200 değil **404**
döner. Service worker'ın gövdeyle (`{ endpoint }`) yaptığı kendi aboneliğinden
çıkışı olduğu gibi durur.

**"Ben kaldırdım" ile "kendiliğinden düştü" ayrı şeylerdir.** Push servisinin
404/410'u ve #1678'in saklama süpürmesi de satır siler; bu yüzden 404 dönen bir
revoke, kullanıcıya bir iptal olarak değil "zaten aboneliği yoktu" diye
bildirilir ve liste altındaki açıklama bir tarayıcının kendi başına da
düşebileceğini söyler.

Kişinin *oturduğu* tarayıcıyı kaldırması yerel aboneliği de iptal eder ve
`/account`'taki anahtarı kapatır — yoksa bir sonraki ziyarette sessiz yeniden
abonelik, az önce silinen satırı sunucuya geri verirdi. Geçersiz kılınacak bir
önbellek yok: `sendPushToUser` tabloyu her gönderimde okur.

### Hangi olaylar push atar (#1715)

Push, bildirim yönlendiricisinin (`notifyEvent()`) dördüncü kanalıdır:
`src/lib/notifications/adapters/push.ts`. Hangi olayın telefonu titreteceği
`src/lib/notifications/catalog.ts` içinde olay başına `defaultChannels`'a `push`
yazılarak, gerekçesiyle birlikte karar verilir: toplantı başlıyor/taşındı/iptal,
teklif gönderildi/cevaplandı, kişinin kendi aşama değişikliği, destek yanıtı,
mülakat planlandı/iptal ve hemen eylem gerektiren güvenlik bildirimleri. Özetler,
raporlar, bülten sayıları ve `batched` olaylar **asla** push atmaz — bunu
`scripts/test/notification-catalog.test.mjs` sabitler. Tepsideki satır zilin
cümlesiyle aynıdır (`renderNotification()`, alıcının dilinde); kategori anahtarı
zil gibi push'u da susturur; cihazı olmayan kişi için ledger'a `SKIPPED no_device`
yazılır. Yeni mesaj push'u (iş parçacığı başına `tag`) şimdilik `messagePush.ts`'te
kalır.

### Platform sınırları

- **iOS/iPadOS:** yalnızca ana ekrana eklenmiş PWA'da çalışır (16.4+); Safari
  sekmesinde push yok. İzin isteği **bir tık handler'ının içinde** olmalı — iOS
  effect'ten veya `setTimeout` içinden çağrılan `requestPermission()`'ı sessizce
  yok sayar. `/account` anahtarı bu yüzden olduğu yerde duruyor.
- Bir push endpoint'i sessizce ölür (site verisi temizlenir, token döner). Bu
  yüzden `/account` açıldığında izni zaten verilmiş kullanıcı için abonelik
  sessizce yeniden doğrulanır.
- Bildirimler kategori tercihine saygı duyar (`notificationPrefs.messages`) —
  `/account`'ta mesaj bildirimlerini kapatan kişi push de almaz.

## 4. Service worker önbelleği yalnızca herkese açık baytları tutar (#1550)

Cache API **tarayıcı profiline** bağlıdır, hesaba değil. Yani service worker'ın
sakladığı her şey, o cihazda bir sonraki giren kişinin de okuyabildiği şeydir.
v3 worker'ı aynı kaynaktan gelen **her** GET'i tek bir önbelleğe yazıyordu —
kimlik doğrulamalı JSON dâhil — ve çıkışta hiçbir şey silinmiyordu; paylaşılan
bir cihazda çevrimdışı bir gezinme başka bir hesabın yanıtıyla karşılanabiliyordu.

Kural **istek ve yanıt** üzerinden karar verir, rota listesi üzerinden değil: bir
liste yalnızca yazıldığı gündeki rotaları kapsar, sonradan eklenen uç sessizce
eski davranışı miras alır (`mayCacheRequest` / `mayCacheResponse`, `public/sw.js`).

| Önbelleğe **girmez** | Önbelleğe **girer** |
|---|---|
| `/api/` altındaki her şey (yanıt, eklenen oturum çerezine göre değişir) | `/_next/static/*`, ikonlar, manifest |
| `Authorization` başlığı taşıyan istek | `/offline` (install sırasında precache) |
| Sunucunun `Cache-Control: private/no-store` ya da `Vary: Cookie` dediği yanıt — yani kimlik doğrulamalı **sayfa** render'ı da | Sunucunun önbelleklenebilir dediği herkese açık sayfa |
| `ok` olmayan yanıt (404/500) | |

Aynı kapı **okuma** yolunda da uygulanır: yazmayacağımız bir isteği önbellekten
de yanıtlamayız — eski bir worker sürümünün bıraktığı satır olsa bile — ve arama
`caches.match()` ile tüm origin'de değil, yalnızca kendi önbelleğimizde yapılır.

**Çıkışta temizlik.** `CACHE` adı `internship-crm-v4`'e yükseltildi; `activate`
adı farklı olan her önbelleği sildiği için hâlihazırda kurulu istemciler v3'ün
tuttuğu her şeyi bırakır. Ayrıca worker'a `{ type: 'PURGE_CACHE' }` mesajı gelince
**tüm** önbellekler silinir ve yalnızca herkese açık precache (`/offline`,
`/icon.svg`) yeniden tohumlanır. Mesajı `signOutEverywhere()`
(`src/lib/signOutClient.ts`) atar ve yönlendirmeden **önce** ack'i bekler;
kontrol eden worker yoksa silmeyi sayfa kendisi yapar. Oturumu geçersiz kılan
yeni bir yol eklerken bunu unutmayın: çerezi düşürüp önbelleği bırakmak, işin
yarısıdır.

**Kayıt herkese açıktır.** `/sw.js` kaydı `InstallAppButton`'dan alınıp
`ServiceWorkerRegistrar`'a (root `layout.tsx`) taşındı: buton yalnızca giriş
yapılmış rol kenar çubuklarında duruyordu, dolayısıyla landing sayfasındaki
ziyaretçi ne çevrimdışı kabuğu ne de `beforeinstallprompt`'u görüyordu.

**Doğrulama.** `scripts/test/service-worker-cache.test.mjs` — `public/sw.js`'i
sahte bir worker scope'unda çalıştırıp fetch handler'a sentetik istekler verir
(tarayıcı ve veritabanı gerekmez, her PR'da koşar; `npm run test:service-worker`).
`e2e/sw-cache-scoping.spec.ts` — canlı worker ile: giriş yapmadan kaydolur,
`/api/` satırı oluşmaz, çıkış her şeyi siler. Süitin geri kalanı service
worker'ları **blokluyor** (`playwright.config.ts`), bu yüzden `serviceWorkers:
'allow'` yalnızca o dosyada.

## Yük testi notu

`GET /api/realtime/stream` gece çalışan anonim k6 senaryosunda yok (oturumsuz 401
döner), ama #1612'den beri **yalnız demo ortamına** karşı çalışan `k6/sse-load.js`
onu ölçüyor: N eşzamanlı akış, kurulum süresi (TTFB), `ready` oranı ve sunucu
heartbeat sapması. Bunun için uç iki küçük şey kabul ediyor: `?maxSeconds=`
(5 sn…30 dk arası kısıtlı, akışı yalnızca kısaltabilir — tarayıcı göndermez) ve
heartbeat yorumunda sunucu saati (`: ping <epoch ms>`; EventSource yorumları yok
sayar). Ayrıntı: `docs/testing.md` § The demo-only scenarios. Bağlantı başına
maliyet, heartbeat'te iki indeksli `COUNT` ile sınırlı ve kullanıcı başına
bağlantı sayısı `MAX_CONNECTIONS_PER_USER` ile kapalı.
