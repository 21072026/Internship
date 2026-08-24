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
