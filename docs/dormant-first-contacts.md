# Pasif ilk temaslar (#1499, #1508)

> Kayıt olan, kendisine bir mesaj gönderilen ve bir daha hiç görünmeyen insanlar.
> Bu doküman onları nasıl tanıdığımızı, ne yaptığımızı ve **ne yapmadığımızı** anlatır.

## Problem

Mentor panosundaki "Dikkat gerektiriyor" listesi 26 satıra çıkmıştı ve her satırda aynı
iki rozet vardı: *Yakın zamanda temas yok* + *Açık hedef veya yapılacak yok*. Bunlar
başvuru yapıp ilk mesajdan sonra hiç dönmeyen kişilerdi. `APPLICATION_100` aşamasında
sonsuza kadar bekledikleri için hatırlatmalar her gün yeniden tetikleniyor, gerçekten iş
gerektiren satırlar bu gürültünün altında kalıyordu.

## Kural

Bir ilişki şu koşulların **hepsi** sağlandığında "pasif ilk temas" sayılır
(`src/lib/dormantFirstContact.ts`):

| Koşul | Neden |
|---|---|
| Pipeline'ın **ilk aşamasında** (varsayılan `APPLICATION_100`; tenant'ın kendi ilk aşaması, #747) | Süreç hiç başlamamış demektir |
| **Bir temas var**: `InteractionLog` **veya** mentee dışında birinin (mentor/admin) attığı bir mesaj — hangisi daha yeniyse | Mentor üzerine düşeni yapmış. Mesaj atmak ile "etkileşim kaydı" formunu doldurmak aynı şey değil; kural yalnızca `InteractionLog`'a bakarsa, dört kez yazılmış bir mentee listede kalır (#1512) |
| **Sessizliğin başlangıcından** (mentee'nin yanıtlamadığı **ilk** temas) en az **`DORMANT_GRACE_DAYS` (14) gün** geçmiş | Dünkü sessizlik bir cevap değildir. Sayaç **son** temastan ölçülürse mentorun ısrarına ait olur: üç haftadır yanıt vermeyen birine atılan bir "Hi?" onu iki hafta daha listeye döndürür ve her kovalama bir iki hafta daha satın alır (#1516) |
| Mentee'nin **son mesajından sonra en az bir cevapsız temas var**, **yanıtsız soru yok**, **bekleyen toplantı talebi yok** | Soru "top kimde?" — mentee'nin son mesajından beri mentor hiç yazmamışsa cevap borcu **mentordadır**, kişi listede kalır |
| Aşamaya **mentor tarafından konmuş bir termin yok** (`stageDeadline`) | Termin, "bunu takip et" demenin bilinçli hâlidir |

Hiç kimsenin yazmadığı bir ilişki **asla** pasif sayılmaz: orada eksik olan şey zaten
mentorun göndermediği ilk mesajdır.

## Ne oluyor

1. **Mentor kuyruğundan düşer.** `getAttentionItems` kuralı canlı değerlendirir; kuyruk
   kaç satırın gizlendiğini dipnot olarak yazar ("… ilk temas gizlendi").
2. **Günlük hatırlatma e-postasından düşer.** `checkMentorInteractionReminders` aynı
   kuralı okur, yoksa aynı 26 kişi bu kez e-postayla geri gelirdi.
3. **`dormantSince` damgalanır.** Günlük süpürme (`sweepDormantFirstContacts`) bu
   durumun tek yazarıdır; kural eşleşmeyi bıraktığı anda damga **ve sayaçlar** silinir.
4. **Mentee'ye iki kez "hâlâ ilgileniyor musun?" e-postası gider**
   (`sendDormantCheckIns`): 14. gün ve ~45. gün. İlki `dormantSince` damgasına bağlıdır —
   damga zaten 14 günlük sessizlikten sonra vurulduğu için **işaretlenmek = vakti gelmiş
   olmak**; iş, temasın ne zaman olduğunu yeniden hesaplamaz (hesaplasaydı yine yalnızca
   `InteractionLog`'a bakma tuzağına düşerdi). İkincisi *ilk hatırlatmadan* 31 gün sonra
   ölçülür — aksi hâlde bu özellik yayına alındığı gün, teması aylar öncesine dayanan
   herkes iki maili peş peşe alırdı. Tur başına en fazla `DORMANT_NUDGE_MAX_PER_RUN` (50)
   e-posta gider; kalanı ertesi gün.
5. **Sonra susar.** İki maili yanıtsız bırakan kişi "Pasif" etiketiyle kalır. Aşaması
   değişmez, ilişki `ACTIVE` kalır, hiçbir veri silinmez.

Mentee listesinde (`/mentor/mentees`) pasifler varsayılan olarak **gizlidir**; bir tıkla
gösterilir, "Pasif" rozeti ve kaç hatırlatma gittiği kartta görünür.

## Sınırlar (bilerek konmuş)

- **Üçüncü mail yok.** İki maili görmezden gelen birine üçüncüsünü yazmak ısrar değil,
  gönderen alan adını spam'e yazdırmanın yoludur — bedelini her toplantı daveti ve her
  parola sıfırlama maili öder.
- **Uygulama içi bildirim yok.** Bu özelliğin tüm varsayımı zaten giriş yapmayan bir
  insan. Kimsenin bakmayacağı bir zil satırı ikinci bir deneme değildir.
- **Otomatik kapatma / aşama değiştirme yok.** Karar mentorda kalır.
- **Tercihler önce okunur, sonra sayaç harcanır.** E-postayı kapatmış bir kişinin iki
  hakkı, hiç gönderilmemiş maillerle tükenmez; sonradan açarsa hatırlatmayı alır.
  E-posta grubu: `announcements` (`re-engagement` ile aynı grup — okuyucunun bunu
  kapatmak için uzanacağı düğme odur).

## Elle çalıştırma

```
GET /api/cron?job=dormant     # süpürme + due olan check-in'ler (ADMIN)
```

Günlük cron'da 09:00'da, hatırlatma işlerinden **önce** çalışır.

## Testler

- `e2e/dormant-first-contact.spec.ts` — kuralın kendisi ve kuyruğa geri dönmenin beş yolu.
- `e2e/dormant-check-in.spec.ts` — damga, iki mail kadansı, üst sınır, sayaç sıfırlama,
  opt-out davranışı.
