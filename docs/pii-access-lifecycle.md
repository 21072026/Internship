# PII erişiminde yaşam döngüsü / PII access lifecycle

Yetkilendirme "**erişebilir mi?**" sorusunu doğru cevaplıyordu; bu doküman
"**ne kadar süre**" ve "**ne kadarına**" sorularının cevabını yazıyor.

Kaynak kod: [`src/lib/retention.ts`](../src/lib/retention.ts)
(`accessGrantingRelation`), [`src/lib/cvAccess.ts`](../src/lib/cvAccess.ts),
[`src/lib/documentAccess.ts`](../src/lib/documentAccess.ts),
[`src/app/api/users/route.ts`](../src/app/api/users/route.ts).

İlgili: story [#832](https://github.com/21072026/Internship/issues/832),
task'lar [#854](https://github.com/21072026/Internship/issues/854) ·
[#855](https://github.com/21072026/Internship/issues/855). Rol bazlı kapsamlama
ayrı bir katman: [`role-access-matrix.md`](role-access-matrix.md).

## 1. Ne kadar süre — mentorluk sonrası erişim penceresi

### Ürün kararı

**Mentorluk `COMPLETED` olarak işaretlendikten sonra mentorun (ve bağlı
şirketin) mentee'nin CV ve belgelerine erişimi 6 ay daha sürer, sonra kapanır.**

`POST_MENTORSHIP_ACCESS_MONTHS = 6` — [`src/lib/retention.ts`](../src/lib/retention.ts).

### Önceki durum

`canAccessCv` ve `canAccessUserDocs`, ilişkinin **var olup olmadığına** bakıyor,
`status` alanına hiç bakmıyordu. Yani ilişki bittikten sonra da erişim
sürüyordu — süresiz. `MentorshipRelation.status` (`ACTIVE | COMPLETED`) şemada
zaten vardı, bu kontrollerde kullanılmıyordu.

### Değerlendirilen alternatif

| | Seçenek A — anında kapat | Seçenek B — 6 ay pencere ✅ |
|---|---|---|
| Amaçla sınırlılık (KVKK m.4, GDPR Art. 5(1)(b)) | En sıkı | Uyumlu; süre sınırlı ve gerekçeli |
| Referans yazma / staj sonrası soru | Kırılıyor | Karşılanıyor |
| Gerçek dünyadaki davranış | Mentoru **özel kopya tutmaya** iter — veri kontrolden çıkar | Erişim sistem içinde ve denetlenebilir kalır |

Seçilen: **B**. Savunulamayan şey erişimin *var olması* değil, **süresiz**
olmasıydı. Mentorun stajdan sonra referans yazması işin gerçek bir parçası;
ilişkiyi `COMPLETED` işaretler işaretlemez erişimi kesmek, mentorları CV'yi
kendi diskine indirmeye iter ve veriyi uygulamanın denetim izinin dışına
taşır — mahremiyet açısından net bir kayıp.

### Uygulama

`MentorshipRelation.completedAt` (yeni, nullable) pencereyi çapalıyor:

- `PUT /api/mentorship/[id]` durumu `COMPLETED`'a çevirdiğinde damgalanıyor.
- Aynı ilişki tekrar `ACTIVE` yapılırsa `null`'a dönüyor — pencere yeniden başlar.
- Erişim koşulu: `status = ACTIVE` **veya** (`status = COMPLETED` ve
  `completedAt >= bugün - 6 ay`).

**Sahip ve ADMIN etkilenmez** — kendi CV'sine erişim ve admin erişimi her zaman
açık.

#### Eski kayıtlar

`completedAt: { gte: ... }` karşılaştırması `NULL`'ları **eşleştirmez**, yani
kolon eklenmeden önce `COMPLETED` olmuş ilişkiler bu özellik canlıya çıktığı an
erişimi kaybederdi. [`prisma/backfill-relation-completed-at.mjs`](../prisma/backfill-relation-completed-at.mjs)
bu satırları deploy anıyla damgalıyor: pencereleri yükseltme anından başlıyor,
6 ay içinde normal şekilde kapanıyorlar. Sadece `NULL` doldurduğu için
idempotent; `infra/deploy-prod.sh` içinde kalıcı olarak duruyor.

## 2. Ne kadarına — veri minimizasyonu

`GET /api/users` ADMIN dalı **tüm** kullanıcıları, e-posta ve telefon dahil tüm
alanlarla, tek yanıtta döndürüyordu. Ele geçirilmiş tek bir admin oturumu tek
istekte tüm PII tablosunu alabiliyordu.

### Alan kümeleri / Field sets

`?view=` parametresi çağıranın **gerçekten render ettiği** alanları istemesini
sağlıyor:

| `view` | Alanlar | Kullanan |
|---|---|---|
| `picker` | `id, fullName, role` | `/admin/mentorship` atama menüleri, `ProjectsManager` |
| `directory` | `id, fullName, email, role, isActive, emailVerified` | `/admin/users` listesi |
| *(yok)* | tarihsel tam küme | `/admin/candidates`, `/admin/mentors` — üniversite/beceri/kapasite sütunlarını gösteriyorlar |

MENTOR dalı zaten PII'sız (`id, fullName, role`) ve **değişmedi**.

### Sayfalama

`?page=` verildiğinde sayfalanıyor: varsayılan `perPage=25`, üst sınır `100`,
yanıt `{ users, total, page, perPage, archivedCount }`.

Sayfalama **opt-in** — bu, `/api/mentorship`'in zaten kullandığı sözleşmenin
aynısı. Varsayılan olarak sayfalamak `/admin/candidates` ve `/admin/mentors`
ekranlarını sessizce bozardı: ikisi de tüm kümeyi çekip tarayıcıda filtreliyor
ve kırpılmış bir listeyi tam liste sanardı.

`/admin/users` artık sunucu tarafında sayfalanıyor; rol filtresi, arşiv sekmesi
ve arama da sunucuya taşındı (arama 300 ms debounce'lu).

### Kalan iş

`/admin/candidates` ve `/admin/mentors` hâlâ tam listeyi tam alan kümesiyle
çekiyor. İkisi de gerçekten PII sütunları gösteriyor, dolayısıyla düzeltme
"alanları kırp" değil "sunucu tarafı filtre + sayfalama"dan geçiyor — ayrı bir
iş. Erişim **loglanmıyor**; PII erişim kaydı
[#821](https://github.com/21072026/Internship/issues/821) kapsamında.

## Canlı parola linkleri yanıt gövdesine yazılmaz (#987)

**Karar: A** — parola belirleme linki yalnızca e-posta ile gider; API yanıtı
`{ ok, emailSent }` döner. `POST /api/admin/company-users` ve
`POST /api/admin/source-users` artık `setPasswordUrl` döndürmüyor.

Gerekçe: bu link canlı, tek kullanımlık bir kimlik bilgisi. HTTP yanıt gövdesine
koymak onu ters proxy log'larına, tarayıcı devtools'una ve her ekran paylaşımına
koymak demek — `/api/admin/users/[id]/reset-password` için #875'te kapatılan
desenin aynısı. İki kural olması uzun vadede kafa karıştırır.

Issue, A'nın gerçek bir operasyonel maliyeti olduğunu varsayıyordu: hesabı admin
oluşturuyor, e-posta gitmezse hesap erişilemez kalıyor. **Ölçtük, öyle değildi:**
`src/app/admin/companies/page.tsx` ve `src/app/admin/sources/page.tsx` yanıttaki
linki hiç okumuyordu — yalnızca başarı mesajı gösterip formu temizliyorlardı.
Yani link, hiçbir tüketicisi olmadan sızıyordu; kaldırmanın maliyeti sıfır.

Asıl kusur başka yerdeydi ve aynı işte düzeltildi: her iki uç da e-posta hatasını
yutup yine `ok: true` dönüyordu. Admin "hesap oluşturuldu" görüyordu, posta hiç
gitmemişken. Artık:

- yanıt `emailSent` taşıyor ve arayüz gönderilemediğini açıkça söylüyor
  (hesap var, kimse giremiyor, posta düzelince "Parolayı sıfırla");
- denetim kaydının `detail` alanına da yazılıyor, çünkü bu durumu sonradan
  açıklamaya çalışan kişi oraya bakacak.

Posta arızasında kurtarma yolu değişmedi: kullanıcı üzerinde parola sıfırlama
akışını tekrar tetiklemek. Link elle paylaşılacaksa bunun için ayrı ve denetlenen
bir yol var (#670, e-postasız davet linkleri) — "yanıt gövdesinde döndür" o yol
değil.

## Silme ne kadarına ulaşıyor (#2052)

Hesap sayfası ve yönetici akışı iki seçenek sunuyor — **anonimleştir** ya da
**tamamen sil** — ve gizlilik metni silme hakkını taahhüt ediyor. Kaynak kod:
[`src/lib/accountErasure.ts`](../src/lib/accountErasure.ts). Her iki yol da
**elle ve yönetici tarafından** başlatılır; `src/lib/retention.ts` kimin
gözden geçirilmesi gerektiğini gösterir, hiçbir şeyi kendiliğinden silmez.

### Önceki durum

`anonymizeUser()` yalnızca `User` satırını yeniden yazıyor ve yüklenen dosyaları
siliyordu. Kişinin yazdığı **her serbest metin** yerinde kalıyordu: mesaj
gövdeleri ve ekleri, destek konuşması ve ekleri, hakkında yazılmış notlar,
etkileşim kayıtları. Yani "artık kimseyi tanımlamıyor" diyen bir satırın yanında
telefon numarası, adres ve mentörün özel notları duruyordu. `Message.senderId`'in
`User`'a **foreign key'i yok**, dolayısıyla tamamen silmede de cascade
çalışmıyor: `relationId` taşımayan (konuşma katmanındaki) bir mesaj hesaptan
sonra da yaşıyordu.

### İki kural

Serbest metnin sahibi kim olduğuna göre davranış değişir:

| | Kişinin **yazdığı** içerik | Kişi **hakkında** yazılan içerik |
|---|---|---|
| Ne olur | **Mezar taşı**: gövde boşaltılır, ek satırları silinir, **satır kalır** | **Temizlenir**: serbest metin gider, satırın tarihi/türü/aşaması kalır |
| Neden | Karşı tarafın konuşması anlamsızlaşmasın — mevcut `Message.deletedForEveryoneAt` maskesi zaten "mesaj silindi" yer tutucusunu gösteriyor | Tarih, tür ve aşama kurumun operasyonel geçmişi; metin gittikten sonra PII taşımıyorlar |
| Kapsam | `Message.body` + `MessageAttachment`, `SupportMessage.body` + `SupportAttachment`, `SupportTicket.subject` (kişinin ilk mesajının ilk 80 karakterinin birebir kopyası), `MentorshipRequest.message`, kişinin kendi `PersonalNote` satırları (yalnızca kendisine ait → doğrudan silinir) | `InteractionLog.notes`/`subject`, `RelationNote.body`, kişinin toplantısında alınmış `PersonalNote.body` |

`User` satırında ayrıca gözden kaçmış üç alan temizleniyor: `country`,
`referralSource`, `reEngageNote`.

"Hakkında" kapsamı **mentee olduğu ilişkilerle** sınırlı: kişinin *mentör*
olduğu bir ilişkideki aynı kolonlar üçüncü bir kişinin kaydıdır, onları silmek
başkasının geçmişini silmek olur (tamamen silmede o ilişkiler cascade ile
zaten gidiyor). `PersonalNote` **yazarına** bağlı, özneye değil; özneye tek
bağlantı `meetingId` → toplantının ilişkisi ya da kişiyle olan `DIRECT` (1:1)
konuşması.

### İki sıra kuralı

- Her iki yolda da temizlik **tek bir `$transaction`** içinde: yarım kalmış bir
  silme mümkün olmamalı.
- Tamamen silmede temizlik **ilişkiler silinmeden önce** çalışır.
  `PersonalNote.meetingId` `SetNull` olduğu için, ilişki (ve onunla toplantı)
  silindikten sonra not metniyle birlikte hayatta kalır ve özneye giden tek
  bağı kopmuş olur — hiçbir sorgunun bir daha bulamayacağı bir PII.

### Şema değişikliği yok

Boşaltmak (`''`) null'lamak yerine tercih edilmedi, **şema öyle**:
`Message.body`, `SupportMessage.body`, `PersonalNote.body`, `RelationNote.body`
ve `InteractionLog.notes` zorunlu kolonlar. Boş gövde bu yüzeylerde zaten
ulaşılabilir ve zaten render edilen bir durum (yalnızca ek içeren destek
mesajı, mezar taşı yapılmış sohbet mesajı).

### Ulaşılamayanlar — sessiz boşluk yok

Kanıt testi: [`e2e/erasure-free-text.spec.ts`](../e2e/erasure-free-text.spec.ts)
— bir mentee'ye ilişki, mesajlar+ekler, destek konuşması, mentörün notu ve
etkileşim kaydı serbest metinleriyle yazılır, **iki yol da** koşulur, sonra
tohumlanan PII dizeleri doğrudan Prisma ile aranır.

Kodda `KNOWN GAPS` bloğunda sayılan ve [#2106](https://github.com/21072026/Internship/issues/2106)
ile takip edilen kalan yüzeyler:

- **Toplantısız `PersonalNote`** (`meetingId: null`): yazarına bağlı, özneye
  hiçbir bağı yok. Bu notun bu kişi hakkında mı yoksa bir başkası hakkında mı
  olduğunu ayırt eden bir sorgu yazılamaz — ürün kararı gerektiriyor.
- Grup konuşması / proje toplantısında alınan notlar: not toplantı hakkındadır,
  kişi hakkında değil.
- `scripts/sanitize-db.mjs` başlığındaki envanterin geri kalanı (değerlendirme
  yorumları, haftalık raporlar, hedef açıklamaları, teklif/görüşme notları,
  bildirim metinleri, denetim kaydı `detail` alanları). Bunların çoğu **tamamen
  silmede** cascade ile gidiyor ama **anonimleştirmede** kalıyor.

Aşağıdaki bölümdeki uyarı burada da geçerli ve iki yönlü: yeni bir serbest metin
kolonu eklerken hem `scripts/sanitize-db.mjs` envanterine hem de
`accountErasure.ts`'e eklenmezse sızıntı olur.

## Önizleme verisi: anonimleştirme (#1186)

Paylaşılan önizleme ortamı gerçek veriyle çalışıyordu. `scripts/sanitize-db.mjs`
(`npm run sanitize:preview`) bunu tersine çevirir: **yapıyı korur, kişiyi siler.**

- Her hesap `userN@demo.example.com` + sahte ad + tek bilinen parola olur;
  telefon, adres, biyografi, kişisel bağlantılar temizlenir.
- Yüklenen dosyalar (CV, avatar, doküman, ek) ve **her türlü kimlik bilgisi**
  (davet/sıfırlama/doğrulama token'ları, API anahtarları, webhook secret'ları,
  impersonation/SSO grant'ları) silinir.
- Kişi tarafından ya da kişi hakkında yazılmış **serbest metnin tamamı** yer
  tutucuyla değiştirilir: ilişki notları, mesaj gövdeleri, değerlendirme
  yorumları, etkileşim notları, haftalık raporlar, bildirim metinleri,
  ActivityLog `detail`/`ip`/`userAgent`, EmailLog alıcı ve konusu.
- **Korunur:** ilişkiler, aşama geçmişi, tarihler, puanlar, sayılar — önizlemenin
  test değeri buradan geliyor. Kayıt sayıları öncesi/sonrası aynı kalır.

İki koruma:

1. **Hedef kontrolü.** Script yalnızca veritabanı *adında* `preview` ya da
   `internship_pr` geçiyorsa çalışır ve **zorlama bayrağı yoktur** — prod'a
   yöneltilebilmesi mümkün olmamalı. (`seed:demo`'nun yerel-DB korumasının tam
   tersi.) Kontrol URL'nin tamamında değil, ayrıştırılmış **veritabanı adında**
   yapılır; böylece içinde "preview" geçen bir sunucu adı prod'un kapısını açamaz.
2. **Kendi kendini doğrulama.** Çalışma bittiğinde geriye gerçek bir adres,
   telefon, dosya, not ya da kimlik bilgisi kaldıysa **exit 1** verir — yarım
   kalmış bir temizlik "güvenli görünen ama olmayan" veriden çok daha kötüdür.
   `npm run sanitize:verify` bu kontrolü tek başına, hiçbir şeyi değiştirmeden
   koşar (geri yükleme veya içe aktarma sonrası "önizleme hâlâ temiz mi?").

Şema büyüdükçe **envanteri güncel tutmak şart**: `scripts/sanitize-db.mjs`
başlığındaki liste hangi modelin yeniden yazıldığını, hangisinin boşaltıldığını,
hangisinin silindiğini ve hangisinin **bilerek** dokunulmadığını sayar. Yeni bir
PII alanı eklerken o listeye de eklenmezse sızıntı olur.
