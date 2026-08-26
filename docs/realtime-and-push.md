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

### Kurulum

1. Anahtar çiftini bir kez üret: `npx web-push generate-vapid-keys`
2. `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` env'lerini ayarla
   (bkz. `.env.example`). Prod/preview için GitHub secret'ı olarak ver; özel
   anahtar hiçbir zaman repoya girmez.
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
  satır aynı şeyi söyler.
- `src/app/api/push/config` (GET), `src/app/api/push/subscribe` (POST/DELETE).
  Public key build-time `NEXT_PUBLIC_*` değişkeni **değil** bir uç: imajlar
  GitHub runner'ında derleniyor, anahtarlar yalnızca sunucuda runtime env olarak
  var (next.config.js'teki JaaS host'uyla aynı gerekçe).
- `public/sw.js` — `push`, `notificationclick`, `pushsubscriptionchange`.
- `src/lib/pushNotifications.ts` — tarayıcı tarafı abone ol/çık.

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

## Yük testi notu

`GET /api/realtime/stream` k6 senaryosuna **alınmadı**: `k6/` kuralları
kimlik doğrulamalı uçları yasaklıyor (bkz. CLAUDE.md ve `docs/testing.md`) ve bu
uç oturum olmadan hemen 401 döner — ölçülecek bir şey kalmaz. Bağlantı başına
maliyet, heartbeat'te iki indeksli `COUNT` ile sınırlı ve kullanıcı başına
bağlantı sayısı `MAX_CONNECTIONS_PER_USER` ile kapalı.
