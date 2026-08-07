# Değer Önerisi Çalışması — Internship CRM Landing

> **Durum:** tartışma dokümanı (2026-08-05). Landing'in üç ana ikna bölümünü (mentee /
> mentör / firma) kurmak için yapılan fikir çalışması. Tasarım ve metin uygulaması
> **sonraki adım** — bu doküman onaylanmadan `src/app/page.tsx` veya `dictionaries.ts`
> değiştirilmemeli. İş modeli bağlamı için bkz.
> [premium-model-calismasi.md](premium-model-calismasi.md).

*Fikir aşaması dokümanı. Kod yazılmadı; tüm etiketler koddan doğrulanmış envantere dayanıyor.*
Etiketler: **[BUGÜN VAR]** = kodda çalışıyor · **[YARIM]** = var ama bir kapının/başkasının arkasında · **[YOK]** = ürün işi gerekli, bu cümle bugün yazılamaz.

---

## 1. Tek cümlelik konumlandırma

Ziyaretçinin 5 saniyede anlaması gereken şey **ne sattığımız değil, çarkın nasıl döndüğü**. "Mentorluk platformu" cümlesi ziyaretçiyi kaybediyor çünkü rakip 40 sitenin hepsi bunu yazıyor.

**Alternatif A — Kanıt ekseni (farklılaştırıcı)**
> "Burada aday CV'siyle değil, onunla aylarca çalışmış bir mentörün imzasıyla tanınır."

*Artı:* üründe gerçekten var olan ve rakiplerde olmayan tek şeyi söylüyor (mentör değerlendirmesi + gerçek proje kaydı).
*Eksi:* mentee tek başına okuduğunda "bana ne" demiyor; firma diliyle yazılmış.

**Alternatif B — Çark ekseni (üç kitleyi aynı anda çağırır)**
> "Deneyim isteyen firmalar, deneyimi olmayan adaylar ve arada duran mentörler. Üçünü aynı yere koyduk: burada deneyim üretiliyor, sonra da belgeleniyor."

*Artı:* "bunun amacı ne ya?" sorusunun doğrudan cevabı; üç bölümün mantığını hero'da kuruyor.
*Eksi:* uzun, iki cümle.

**Alternatif C — Mentee acısı ekseni (en yüksek dönüşüm)**
> "Deneyimin yok diye almıyorlarsa, deneyimini burada üretirsin."

*Artı:* hedef kitlenin %80'i mentee; acıyı onun kelimeleriyle söylüyor.
*Eksi:* mentörü ve firmayı dışarıda bırakıyor, sayfanın kalanı kopuk duruyor.

**ÖNERİ: B'yi hero başlığı, C'yi mentee bölümünün başlığı, A'yı firma bölümünün başlığı yap.** Hero tek bir kitleyi seçmemeli — çünkü bugün eksik olan taraf mentee değil, mentör ve firma arzı. Hero'nun işi ayrıştırmak, ikna etmek değil.

**Önerilen hero paketi:**
- Başlık: *"Deneyim isteyen firmalar, deneyimi olmayan adaylar ve arada duran mentörler."*
- Alt başlık: *"Üçünü aynı yere koyduk. Aday gerçek bir işin içinde çalışır, mentörü ne yaptığını yazar, firma da CV'ye değil o kayda bakarak karar verir. Mentee ve mentör tarafı her zaman ücretsiz — parayı yetenek arayan firmalar öder."*
- Altında tek satır durum şeridi (canlı veriden, sıfırsa gizlenerek): *"Şu an: N mentör · X açık proje · Y mentör bekleyen aday"*

İş modeli cümlesi **hero'nun hemen altında** olmalı. Cevapsız fiyat her zaman "pahalı" diye okunur; "ücretsiz" ise sebebi söylenmezse "verimi mi satıyorlar" diye okunur. İkisini de tek cümle çözüyor.

---

## 2. Neden üç kitle birbirine muhtaç — çark

**Bu, sitenin ana argümanı olmalı. Özellik listesi değil, bu.**

Her tarafın fazlası, diğerinin eksiği:

| Taraf | Getirdiği | Bulamadığı | Çarktan aldığı |
|---|---|---|---|
| **Mentee** | Zaman, emek, öğrenme isteği, ham yetenek | Deneyim, referans, kapı | Yol gösteren biri + üzerine imza atılmış bir kayıt |
| **Mentör** | 10+ yıllık tecrübe, seçicilik, ağ | Kaldıraç ve hafıza (kimin nerede kaldığı) | Organize bir liste + emeğinin görünür sonucu + kendi ekibine aday |
| **Firma** | Gerçek fırsat (staj, iş) ve — ileride — para | Güvenilebilir junior sinyali | Aylarca gözlemlenmiş, önceden süzülmüş aday |

**Anlatının kilidi — kanıt zinciri:**

> Firmanın güveni mentörün imzasından doğuyor.
> Mentörün imzası, mentee'nin gerçekten yaptığı işten doğuyor.
> Mentee'nin motivasyonu, firmanın gerçek fırsatından doğuyor.

Yani bu bir ilan sitesi ya da CV havuzu değil; **kanıt üreten bir döngü**. Bir CV havuzunda taraflar birbirinden bağımsızdır ve kimse kimseye kefil olmaz. Burada üçüncü bir insan — mentör — hem adayı tanıyor hem de adını ortaya koyuyor. Çarkın kırıldığı yer de bu: mentör yoksa kanıt yok, kanıt yoksa firma yok, firma yoksa mentee'nin gitmek istediği bir yer yok.

**Landing'de nasıl anlatılmalı:** üç kutu ve aralarında dönen üç ok; her okun üstünde tek cümle ("emeğini koyar" → "gördüğünü yazar" → "fırsatı açar"). Metin değil şema. Bu şema aynı zamanda ziyaretçiye "ben bu resimde neredeyim" sorusunu kendi kendine cevaplatır ve rol kartlarına doğal geçiş yapar.

**Dürüstlük notu (site metnine girmez, ekip için):** çark bugün tam dönmüyor. Mentee ve mentör tarafı (eşleşme sonrası deneyim, proje, değerlendirme) kodda gerçekten çalışıyor; firma tarafı elle açılan hesaplar ve elle açılan yetkilerle duruyor. Landing bunu "erken erişim / kurucu kohort" çerçevesiyle dürüstçe taşıyabilir — ama "çark dönüyor" diye yazamaz.

---

## 3. Üç bölüm

### 3.1 MENTEE

**Başlık:** Deneyimin yok diye almıyorlarsa, deneyimini burada üretirsin.
**Alt başlık:** Seni tanıyan bir mentör, üstünde çalışacağın gerçek bir proje ve firmaya CV'nden önce giden bir referans. Mentee tarafı tamamen ücretsiz — parayı yetenek arayan firmalar ödüyor.

**Maddeler**

1. **Sana bir mentör eşleştiriyoruz — ilana başvurup cevap beklemiyorsun.** [YARIM]
   Mentörleri tek tek biz davet ediyoruz; herkes mentör olamıyor. Talebini alıp alanına uygun birini eşleştiriyoruz. Eşleşme kurulduğunda uygulama içinden yazışıyor, görüşme talebi açıyor, takıldığın soruyu toplantı beklemeden soruyorsun.
   *Neden yarım:* mentör dizini yok, mentörü sen seçmiyorsun — atamayı admin yapıyor. Bu, cümlede açıkça söylenmeli ("mentör dizini yolda"), gizlenmemeli.

2. **"Unutuldum mu?" diye kimseye yazmazsın.** [BUGÜN VAR]
   Başvurudan staja, stajdan işe alıma kadar hangi noktada olduğunu ve sıradaki adımı her açtığında görüyorsun. Mentörünle konuştuğunuz her şey, koyduğunuz her hedef kayıtta.
   *Yazma:* "13 aşama" deme. Mentee'ye görünen 11 adım ve etiketler iç jargon ("220 · Onay bekliyor"). Sayı, fayda değil bürokrasi vaadi. Ekran görüntüsü koy, sayı sayma.

3. **Senin yerine konuşan bir insan var.** [BUGÜN VAR — firmaya gitmesi YARIM]
   Mentörün seni teknik yetkinlik, iletişim, güvenilirlik ve gelişim başlıklarında değerlendiriyor, yorum yazıyor — ve yazdığı her şeyi sen de okuyorsun. Tamamladığın proje görevleri tek tek kayda geçiyor.
   *Sınır:* bu karnenin firmaya gitmesi premium bir yetkiye bağlı ve bugün pratikte hiçbir firmada açık değil. "Her firma görüyor" **yazılamaz**; "paylaşmayı seçtiğin firmaya bu değerlendirme de gider" doğru sınır.

4. **Portfolyonu izleyerek değil, çalışarak yaparsın.** [YARIM]
   Açık projelere geliştirici, test veya pazarlama rolüyle katılıyorsun; ekip listesinde yerini alıyor, grup sohbetine giriyor, sana atanan görevleri üstleniyorsun. Aynı projede çalıştığın herkesle doğrudan yazışabiliyorsun.
   *Neden yarım:* portal menüsünde projelere link yok, mentee proje açamıyor, katılım sahibin onayına bağlı ve arz belirsiz. **Kural: açık proje sayısı 0 ise bu bölüm yayınlanmaz.** Sayı varsa canlı 3 proje kartı bas.

5. **Mentörün atanmadan da başlarsın.** [BUGÜN VAR — koşullu]
   Hesabın açılır açılmaz CV'ni yükleyip başlık başlık geri bildirim alıyorsun, gireceğin pozisyona göre mülakat hazırlığı çıkarıyorsun, ön yazı ve referans isteme şablonlarını hazır buluyorsun. Hepsi ücretsiz.
   *Koşul:* her ikisi de AI sağlayıcı yapılandırması yoksa kendini tamamen gizliyor. **Prod'da kapalıysa bu madde landing'den çıkar** — vaat edilip bulunamayan özellik, ödeme duvarından daha çok güven kaybettirir.

6. **Görünürlüğün senin kontrolünde.** [BUGÜN VAR — geri bildirim YOK]
   Profilini herkese açtığında paylaşılabilir bir linkin oluyor; ayrıca izin verirsen firmaların aday aramasında çıkıyorsun. İkisi de varsayılan kapalı, istediğin an geri alıyorsun. E-postan, telefonun ve doğum tarihin hiçbir koşulda görünmüyor.
   *Yazılamayacak cümle:* "Bir firma seninle ilgilendiğinde bunu görürsün." Bugün o sinyal **yalnızca mentöre** gidiyor. Dürüst hali: "Bir firma ilgilendiğinde sinyal önce mentörüne gidiyor; mentörün seni haberdar ediyor."

**Kanıt cümlesi** (test sayısı ve AGPL burada kullanılmaz — 22 yaşındaki adaya "bu bir hobi yazılım projesi" diye okunur):
> "Yeniyiz ve bunu saklamıyoruz: henüz başarı hikâyesi yayınlamadık, uydurma referans da yazmıyoruz. Bugün gösterebileceğimiz kanıt şu: mentörleri tek tek davet ediyoruz, mentee tarafında hiçbir ekran para istemiyor, verini izin vermeden kimseye göstermiyoruz ve istediğin an hesabını CV'nle birlikte silebiliyorsun. İlk gelenlerden biri olmanın karşılığı: mentör başına düşen aday sayısı bir daha hiç bu kadar az olmayacak."

**CTA**
- Birincil: **"Ücretsiz hesap aç — 2 dakika"** → `/auth/register`
- Altında tek satır: *"E-postanı doğrula; başvurunu inceleyip hesabını açıyoruz. CV'ni sonra, mentör eşleşmesi için istiyoruz."*
  (Bugünkü taslak CTA'nın altında CV + insan onayı + e-posta doğrulama birlikte itiraf ediliyor; üstelik ürün kayıt anında CV istemiyor — kendi aleyhine yanlış söylüyor.)
- İkincil, kayıt istemeyen: **"Önce açık projelere göz at →"** → `/projects`

**İtirazlar & cevaplar**

| İtiraz | Cevap |
|---|---|
| "Kaydolayım da bakayım, hemen kullanabilir miyim?" | "Hesabını e-posta doğrulamandan sonra biz açıyoruz — genelde 1 iş günü. O arada beklemen gereken bir şey yok; biz sana uygun mentörü arıyoruz." *(Süreyi ancak tutabiliyorsan yaz.)* |
| "Ne kadar zamanımı alır, okulumla çakışır mı?" | "Ritmi mentörünle sen belirliyorsun; tipik akış ayda 1-2 görüşme, arada asenkron soru-cevap. Mentörler haftalık müsait saatlerini giriyor, sen o slotlardan talep açıyorsun. Sınav haftasında ara vermek serbest." |
| "Kabul edilmeme ihtimalim var mı?" | "Öğrenci ya da yeni mezun olman yeterli. Not ortalamana, okuluna, deneyimine bakmıyoruz. Kaydını inceliyoruz çünkü sahte hesap istemiyoruz; seçme sınavı yapmıyoruz." |
| "CV'mi yüklersem ne oluyor?" | "CV'ni yalnızca mentörün ve — sen izin verirsen — ilişkili olduğun firma görür. Yapay zekâ geri bildirimi ayrı bir onaya bağlı; sen açmazsan CV'n hiçbir modele gitmez. Hesabını sildiğinde CV'n de silinir." |
| "Neden ücretsiz, verimi mi satıyorsunuz?" | "Mentee ve mentör tarafı her zaman ücretsiz. Geliri yetenek arayan firmalardan alıyoruz — senin verini değil, sana ulaşma imkânını satıyoruz ve o da ancak sen izin verirsen." |
| "Bana iş bulacak mısınız?" | "Hayır, garanti veremeyiz ve veren kimseye de inanma. Yaptığımız şu: gerçek bir işin içine sokuyoruz, ne yaptığını yazıya döküyoruz ve o yazıyı firmaya götürüyoruz." |

---

### 3.2 MENTÖR

**Başlık:** Bir kişiye yardım etmek kolay. Sekiz kişiye aynı anda yardım etmek, kimin nerede kaldığını hatırlamaya çalışmak demek.
**Alt başlık:** Hatırlama işini biz yapıyoruz. Mentör tarafı ücretsiz.

*Alternatif başlık (canlı veri varsa daha güçlü):* **"Şu an mentör bekleyen N kişi var."** — bu kitleyi harekete geçiren şey soyut fayda değil, adıyla çağrılmak. Sayı yoksa kullanma.

**Maddeler**

1. **Kendi başvuru bağlantın olur — kaç kişiye açık olduğuna sen karar verirsin.** [YARIM]
   Linkini paylaşırsın; başvuran formu doldurur, doğrudan senin listene düşer, kimsenin onayını beklemez.
   *Neden yarım:* kapasite kontrolü ve mentörün kabul/ret adımı **kodda yok** — link bugün sınırsız. "Kontenjanın dolduğunda link kapanır / her başvuruyu önce görürsün" cümlesi, o ürün işi yapılmadan yazılamaz. Yazılırsa bu kitlenin bir numaralı korkusunu (sınırsız bağlanma) tetiklersin.

2. **Haftada 10 dakikan varsa, ürün onu kime harcayacağını söyler.** [BUGÜN VAR]
   Panoyu açarsın; uzun süredir konuşmadığın, sorusu cevapsız kalan ve toplantı bekleyen kişiler en üstte sıralanmıştır. İki kişiyle ilgilenir, kapatırsın.
   *Bu, üründeki en rakipsiz ve en az anlatılan özellik. Mentör bölümünün merkezinde durmalı.*

3. **Altı ay sonra "bu çocukla en son ne konuşmuştuk" diye düşünmezsin.** [BUGÜN VAR]
   Her kişi için: hangi aşamada, en son ne zaman görüştünüz, ne konuştunuz, senin özel notların. Notları yalnız sen görürsün. Kişi eklemek 30 saniye.
   *Sınır:* e-postası olmayan kişi için açılan hesap giriş yapamıyor. Dürüst hali: "E-postası olmayanı da listene ekleyebilirsin — o kişi sisteme giremez, senin özel takip kaydın olur."

4. **Yarın bir pozisyon açtığında, aday aramana gerek kalmaz.** [BUGÜN VAR — çerçeveleme]
   Mentörlük yaptığın insanlar, gerçekten nasıl çalıştıklarını gördüğün tek aday havuzun. Kendi ekibine alacağın kişiyi CV'den değil, altı aylık gözlemden seçersin.
   *Bu bir özellik değil, mevcut yeteneğin doğru çerçevelenmesi — ve taslakta tamamen atlanmış en güçlü bencil sebep.*

5. **Birebir yerine dört kişiyi aynı işin içinde yetiştir.** [YARIM]
   Kendi projeni açar, ekip kurarsın: roller, görev listesi, grup sohbeti, haftalık toplantı.
   *Neden yarım:* mentör **kendi mentee'sini kendi projesine ekleyemiyor** (üye seçici listesi mentör için her zaman boş). Bu bug düzeltilmeden bu madde yazılamaz.

6. **Bir yıl sonra kaç kişiyle çalıştığını hatırlamak için kimseye sormazsın.** [BUGÜN VAR]
   Kendi hunin, kaç kişinin işe girdiği, ortalama süre — kendi analitik ekranında.
   *Yazma:* "ölçüm" dili kullanma; kendi doldurduğun tabloyu sana "ölçüm" diye geri satmak ters teper. Yıl sonu değerlendirmesi / kuruma rapor bağlamına otur.

**Güven şeridi (koca bir maddeye gerek yok, tek satır):**
> Ücretsiz · Aday e-postası ve telefonu hiçbir şirkete gitmez · Notların dışarı kapalı · Açık kaynak (AGPL-3.0) · Verini istediğin an dışa aktarırsın

**Kanıt cümlesi**
> "Ürün beta: mentör panosu, aşama takibi, etkileşim günlüğü, hedefler, toplantı ve müsaitlik yönetimi bugün canlı ve ücretsiz. Henüz kullanıcı referansımız yok — ilk 20 mentörden birisin, ne yapılacağına sen de karar vereceksin. Kod tamamen açık; girdiğin her kaydı istediğin an dışa aktarabilirsin."

**CTA**
- Birincil: **"Listeni taşı — ilk 5 kişini 10 dakikada gir."**
  Alt metin: *"Kısa bir form dolduruyorsun, 2 iş günü içinde hesabını açıyoruz. Mentör tarafını bilerek yavaş büyütüyoruz."*
- İkincil: *"Henüz kimseye mentörlük yapmıyorum, başlamak istiyorum."*

> **YAYIN BLOKERİ:** Mentör başvurusunu alan API çalışıyor ama **inceleme ekranı yok** (admin bildirimi 404'e gidiyor) ve **onaylanan başvurudan hesap doğmuyor**. Bu iki iş bitmeden mentör CTA'sı canlıya alınmamalı; geçici olarak doğrudan kurucuya giden bir e-posta/randevu bağlantısı kullanılmalı. Aksi halde ilk kohort sessizce kaybolur.

**İtirazlar & cevaplar**

| İtiraz | Cevap |
|---|---|
| "Vaktim yok, bir sistem daha öğrenemem." | "İlk kurulum 10 dakika: kişilerinin adını gir. Sonrası haftada yaklaşık 10 dakika — panoyu aç, işaretlenmiş iki kişiyle ilgilen, kapat. Not yazmak istemezsen yazma; sistem yine de kimle ne zaman temas ettiğini tutar." |
| "Ne kadar bağlanıyorum, çıkabilir miyim?" | "Kaç kişiye açık olduğuna sen karar veriyorsun; ara vermek istersen kontenjanını sıfırlarsın." *(Önce kapasite kontrolü shiplenmeli.)* |
| "Bu bir yıl sonra duruyor olacak mı?" | "Bunu küçük bir ekip yazıyor ve kodu tamamen açık (AGPL-3.0). Kapanma riskine karşı verdiğimiz tek somut söz şu: girdiğin her kaydı tek tıkla dışa aktarabilirsin." |
| "Mentör olduğum dışarıda görünecek mi?" | "Bugün hayır. Mentör profili ve dizini yol haritasında — vaat etmeden önce yapacağız." *(Tarihsiz "yol haritası" bu kitlede "yok" demektir; bir çeyrek ver.)* |
| "Karşılığında ben ne alıyorum?" | "Üç şey: hatırlama yükünden kurtulmak, aynı emekle bir kişi yerine bir ekibe yol göstermek, ve yarın kendi ekibine alacağın insanı altı aydır tanıyor olmak." |

---

### 3.3 FİRMA

**Başlık:** Adayı CV'sinden değil, onunla aylarca çalışan mentöründen tanıyın.
**Alt başlık:** Stajyerlerinizi ilk günden buradan izleyin, işe alım kararını iki mülakata değil aylara yayılmış yazılı bir kayda bakarak verin. Pilot dönemdeyiz: hesabı biz açıyoruz, ücret almıyoruz, sözleşme yok.

**Maddeler** — *sıra kritik: bugün çalışan şey önce, arama en sona.*

1. **Stajyeriniz nerede, ne durumda?** [BUGÜN VAR]
   Şirketinize bağlı her adayın hangi aşamada olduğunu, mentörünün kim olduğunu ve sürecin hunisini tek ekranda görürsünüz.
   *Sınır — kasıtlı tasarım kararı olarak anlatın:* "Görüşme notlarını ve hedefleri mentör tutar; siz durumu ve mentörün dönemsel değerlendirmesini okursunuz. Yazma yetkisi sizde değil — kaydı tutan tarafın tarafsız kalması için."
   **"Kimseye e-posta atmanız gerekmez" cümlesi yazılamaz** — etkileşim kayıtları, toplantılar, dokümanlar ve hedefler şirket panelinde yok.

2. **Önce birlikte çalışın, sonra karar verin.** [BUGÜN VAR]
   Süreç tek bir hatta izlenir: staj başlayacak → staj devam ediyor → işe alınabilir → işe alındı. Adayı bir mülakat performansıyla değil, aylarca süren gerçek işle tanırsınız.
   *Bu, bu kitlenin bir numaralı satın alma sebebi ve bugünkü taslakta hiç yok.*

3. **Junior'un yetiştirilme maliyeti senior mühendisinizin masasına düşmüyor.** [BUGÜN VAR — çerçeveleme]
   Stajyerin zaten bir mentörü var: hedeflerini koyan, düzenli görüşen, ilerlemesini yazan, dönemsel değerlendirme üreten biri.

4. **Mentör imzalı aday karnesi.** [YARIM]
   Şirketinizde stajı başlayan her aday için mentörü iki kez — ara ve final — dört başlıkta (teknik, iletişim, güvenilirlik, gelişim) puan ve yazılı yorum girer; yanında adayın tamamladığı gerçek proje görevleri durur.
   *Dürüstlük:* premium bir yetkiye bağlı ve elle açılıyor; ayrıca **havuzdan bulduğunuz adayda bu karne yoktur**. Doğru anlatım: "Karne, birlikte geçen zamanın ürünüdür. Havuz tanışma yeridir, karar yeri değil."

5. **Pozisyonunuza uyan aday çıkınca haber veriyoruz.** [YARIM]
   "Pozisyonlarınızı şu an biz sisteme giriyoruz (dakikalar sürüyor). Anahtar kelimelerinizle örtüşen yeni bir aday havuza girdiğinde panelde bildirim ve e-posta alırsınız — sıralanmış kısa liste değil, 'buna bir bak' uyarısı."
   *Yazılamaz:* "işe alınabilir hale geldiğinde" — eşleşme taraması aşama filtresi kullanmıyor. "Akıllı eşleşme" de denemez; kaba bir anahtar kelime kontrolü.

6. **Rızaya dayalı, küçük ama gerçek bir havuz.** [YARIM]
   "Havuzda yalnızca 'firmalar beni görsün' kutusunu kendi eliyle işaretlemiş adaylar var. Bugün N aday — az, biliyoruz; o yüzden asıl işi aramaya değil bildirime yaptırıyoruz. E-posta ve telefonlarını size hiç göstermiyoruz."
   *"KVKK/GDPR uyumlu" klişesini yazmayın; mekanizmayı yazın. Elde gerçek substans var, klişenin altına gömmeyin.*

7. **Doğrudan mesajlaşma** [YOK]
   Bugün şirket kullanıcısı aday ile uygulama içinden yazışamıyor. "Yetenek avına çıkarsın" **yazılamaz**. Bugünkü dürüst hali: "Beğendiğiniz adayı işaretleyip notunuzu yazarsınız; bildirim adayı takip eden mentöre gider, tanıştırmayı o yapar. Dönüş gelmezse bize yazın, biz takip ederiz."

**Kanıt — cümle değil, ekran.** Sayfanın en ikna edici unsuru anonimleştirilmiş bir aday karnesi görseli olmalı (dört kriter, ara+final, mentör yorumu, tamamlanan proje görevleri). Bu kitle beş maddeyi okumaz, bir ekran görüntüsüne bakar.
Altına doğrulanabilir üç satır: *Kodun tamamı açık — AGPL-3.0, GitHub'da · 104 sürüm, değişiklik günlüğü herkese açık · 388 otomatik test, günde 4 kez koşuyor.* (Bu kanıtlar **sadece burada** işe yarar.)

**CTA**
- **"Havuzda bugün kaç aday var ve hangileri sizin açık pozisyonunuza uyuyor — 15 dakikada ekranda gösterelim."**
- Altında: *"Pilot dönemdeyiz: hesabı biz açıyoruz, ücret almıyoruz, sözleşme yok, istediğiniz gün verinizi siliyoruz."*
- **Teknik uyarı:** bugün landing'deki tüm CTA'lar `/auth/register`'a gidiyor ve orası firma için kapalı kapı. Bu buton bir `/for-companies` sayfası + form yazılmadan canlıya alınmamalı; ara çözüm olarak doğrudan `mailto` bile daha iyidir.
- "Kurulum görüşmesi" demeyin — kurulum alıcının maliyeti, satıcının faydası. Kimse kurulum istemez, aday ister.

**İtirazlar & cevaplar**

| İtiraz | Cevap |
|---|---|
| "Ne kadar sürede ilk adayı görürüm?" | "Hesabınızı biz açıp mevcut stajyerlerinizi sisteme bağlıyoruz; panelde en az bir gerçek aday olmadan size link göndermiyoruz." *(Bunu bir operasyon kuralı yapın — "boş ekranla kalmazsınız" bir cümle olarak tutulamaz, ürün boş ekranı bekliyor.)* |
| "Bir sistem daha mı? ATS'imiz var." | "ATS'inizin yerini almıyoruz, onu besliyoruz. Salt-okunur REST API, OpenAPI şeması ve imzalı webhook'lar var — aday verinizi kendi sisteminize akıtabilirsiniz, kimseyi kilitlemiyoruz." |
| "Kaça patlar?" | "Pilot dönemde ücretsiz. Ödeme altyapımız henüz yok; fiyatlandırmayı ilk firmalarla birlikte belirleyeceğiz." |
| "Bırakmak istersem verime ne olur?" | "İstediğiniz gün hesabınızı ve verinizi siliyoruz. Taahhüt yok." |
| "Kaç aday var?" | Gerçek sayıyı söyleyin. Küçük bir sayı, sayısızlıktan güvenilirdir. |

---

## 4. Sosyal kanıt planı

**Değişmez kural: uydurma referans yok. Stok fotoğraf + hayali isim yok. Doğrulanamayan toplu sayı ("1000+ aday") yok. Logo bandı yok.** Beta bir üründe yakalanmanın maliyeti, referanssızlığın maliyetinden kat kat büyük.

### 4.1 Bugün dürüstçe gösterebileceklerimiz

| Kanıt | Kime | Durum |
|---|---|---|
| Kodun tamamı açık — AGPL-3.0, GitHub linki | Firma, mentör | [BUGÜN VAR] — landing'de bugün **hiç yok**, eklenmesi bedava güven |
| 104 sürüm notu, EN/TR/DE, `/release-notes` | Firma, mentör | [BUGÜN VAR] — "bu proje yaşıyor" kanıtı |
| 388 otomatik test, günde 4 kez koşuyor | Firma (mühendislik alıcısı) | [BUGÜN VAR] — mentee bölümünde **kullanma**, ters teper |
| `/features` — 17 özellik, tek kaynaktan | Herkes | [BUGÜN VAR] |
| Rıza mimarisi: çift opt-in, sürümlü rıza kaydı, public profilde PII yok | Mentee, firma | [BUGÜN VAR] — klişe değil mekanizma olarak anlat |
| Üç dilde tam parite (TR/EN/DE) | Firma | [BUGÜN VAR] |
| Kurucunun adı, yüzü, neden yaptığı | Herkes | [YOK] — sayfada hiç yok; beta bir üründe kimliksizlik en büyük güven kırıcı. **En ucuz P0.** |
| Canlı sayılar: aktif mentör, açık proje, bekleyen talep | Herkes | [YOK] — veriden hesaplanabilir, endpoint yok |
| "Ürünü kullananlar ürünün kendisini inşa ediyor" hikâyesi | Herkes | **Doğrulanmadı.** Public proje vitrini bunu taşıyabilir — ama yalnızca gerçekten öyleyse ve isimler izinliyse. Uydurulacak bir hikâye değil. |

### 4.2 Kurulacak mekanizma — dört faz

**Faz 0 — Elle, şema değişikliği yok (bugün başlanabilir, S)**
İzin alınmış 3-5 gerçek mentee/mentör için kısa alıntı + `/p/<id>` public profil linki. Yazılı izin e-postayla alınır ve saklanır. Gerçek hikâye çıkana kadar bölüm **boş bırakılır** — "yakında referanslar" gibi bir yer tutucu bile konmaz.

**Faz 1 — Rıza altyapısı (M)**
- `UserConsent` tiplerine **TESTIMONIAL / PUBLIC_STORY** ekle (mevcut dört tipin yanına).
- `Evaluation`'a `sharedPublicly` + `publishedAt` alanları. Ham madde zaten birikiyor: değerlendirme çift yönlü, puan + serbest yorum içeriyor. Bir referans metninin istediği tam olarak bu.
- Kural: rıza olmadan tek kelime yayınlanmaz; rıza her zaman geri alınabilir ve geri alındığında içerik anında düşer.

**Faz 2 — Moderasyon ve yayın (M)**
- Admin tarafında "öne çıkar" ekranı: yayınlanacak alıntıyı seçme, kısaltma, yazarın onayına gönderme.
- Public okuma endpoint'i (bugün değerlendirmeleri yalnızca ilişkinin tarafları ve admin görebiliyor).
- `/stories` sayfası + landing'de bir bölüm; `dictionaries`'e `landing.testimonials` bloğu (EN/TR/DE parite zorunlu).

**Faz 3 — Sayılarla kanıt (S, ama veri bekler)**
Pipeline'ın sonu zaten `ISE_ALINDI` / `IS_BULDU`. Gerçek rakam oluştuğu an sayfanın en üstüne konacak tek şey budur: "N kişi buradan işe alındı." O güne kadar bu satır **yazılmaz**; oran da verilmez.

### 4.3 Sayı gösterme kuralı
Canlı hesaplansın, metne elle gömülmesin (bayatlar, ayrıca landing metinlerini e2e testleri birebir doğruluyor). **Sıfırsa o parça gizlensin** — "0 açık proje" yazan bir kart, hiç olmayan karttan kötüdür. Küçük ama gerçek sayı ("bugün 40 aday") her zaman sayısızlıktan güvenilirdir.

---

## 5. Landing bilgi mimarisi

### 5.1 Format kararı: rol seçtiren üst bölüm + ardışık tam bölümler

Üç seçeneği tarttım:

- **Sekmeli (tabs):** içeriğin üçte ikisi gizli kalır, mobilde keşfedilmez, arama motorlarına ve doğrudan linke kapalı. **Hayır.**
- **Üç sütun yan yana:** mobilde alt alta ezilir; masaüstünde ziyaretçiye üç metni birden okutur, hiçbirini okumaz. Ayrıca çarkın "birbirine muhtaç" mesajını sütunlara böler. **Hayır.**
- **Rol kartları (yumuşak yönlendirme) + altında ardışık üç tam bölüm:** ziyaretçi kendini 3 saniyede eşleştirir ve kart tıklamasıyla kendi bölümüne atlar; atlamayan aşağı kaydırarak hepsini okur. Çark anlatısı bozulmaz — tersine kartlar çarkın görsel karşılığı olur. **Öneri bu.**

### 5.2 Bölüm sırası

| # | Bölüm | İçerik | CTA |
|---|---|---|---|
| 1 | **Hero** | Çark başlığı + iş modeli alt satırı + canlı durum şeridi (sıfırsa gizli) | Yok — hero'da düğme yok, aşağı yönlendirme var |
| 2 | **Çark şeması** | Üç kutu, üç ok, ok başına tek cümle. Sitenin ana argümanı. | Yok |
| 3 | **Rol kartları** | "Staj/iş arıyorum" · "Yol göstermek istiyorum" · "Yetenek arıyorum" | Her kart kendi bölümüne kaydırır |
| 4 | **Mentee bölümü** | 6 madde + kanıt cümlesi | Birincil: ücretsiz kayıt · İkincil: projelere göz at |
| 5 | **Mentör bölümü** | 6 madde + güven şeridi + kanıt | "Listeni taşı" *(başvuru akışı bitene kadar kurucuya giden bağlantı)* |
| 6 | **Firma bölümü** | 6 madde + **anonim aday karnesi ekran görüntüsü** | "15 dakikada gösterelim" → `/for-companies` |
| 7 | **Nasıl işliyor** | 3 adımlık şema (başvuru → eşleşme + proje → kanıt ve tanıştırma). Firma bölümündeki "ilgi → mentör" akışı buraya taşınır. | Yok |
| 8 | **Şeffaflık şeridi** | Açık kaynak + GitHub · 104 sürüm · 388 test · 3 dil · rıza mimarisi · beta rozeti (gizlenmeden) | `/features`, `/release-notes` linkleri |
| 9 | **Hikâyeler** | Faz 0 tamamlanana kadar **yayında değil** | — |
| 10 | **SSS** | Üç kitlenin itirazları, rol filtreli | — |
| 11 | **Kapanış CTA** | Üç düğme yan yana, aynı hiyerarşide | Rol başına ayrı hedef |

### 5.3 CTA matrisi

| Kim | Metin | Hedef | Bugünkü durum |
|---|---|---|---|
| Mentee | "Ücretsiz hesap aç — 2 dakika" | `/auth/register` | [BUGÜN VAR] — ama kayıt formu "davetiye gerekiyor" izlenimi veriyor, düzeltilmeli |
| Mentee (düşük taahhüt) | "Açık projelere göz at" | `/projects` | [BUGÜN VAR] |
| Mentör | "Listeni taşı" | `/apply/mentor` (yeni) | [YOK] — yazılana kadar kurucuya doğrudan bağlantı |
| Firma | "15 dakikada gösterelim" | `/for-companies` (yeni) | [YOK] — bugün `/auth/register`'a, yani kapalı kapıya gidiyor |

**Bugünkü kritik hata:** landing'deki üç CTA da aynı adrese gidiyor. Üç kitleye üç bölüm yazıp hepsini mentee kayıt formuna göndermek, metnin tamamını çürütür.

---

## 6. Ürün eksikleri backlog'u

*Yalnızca vaatleri dürüst kılmak için gereken işler. Mevcut özellikler tekrarlanmadı.*

### P0 — bunlar olmadan landing yayına giremez

| # | İş | Efor | Gerekçe (tek satır) |
|---|---|---|---|
| 1 | `/admin/mentor-applications` inceleme kuyruğu | M | Gelen mentör başvurusu bugün hiçbir ekranda görünmüyor; bildirim 404'e gidiyor. |
| 2 | Onaylanan başvurudan davet/hesap üretimi | M | Onaylansa bile hesap doğmuyor — süreç tıkalı. |
| 3 | Public mentör başvuru sayfası | S | API hazır, tek satır arayüz yok; mentör CTA'sının varacağı yer bu. |
| 4 | `/for-companies` sayfası + iletişim/demo formu | S | Firma CTA'sının bugün gidebileceği hiçbir kapı yok. |
| 5 | Kayıt kapısını çöz: e-posta doğrulanınca otomatik aktifleştir **ya da** ayrı `PENDING_APPROVAL` hatası + süre taahhüdü | S | Bugün onay bekleyen kullanıcıya "e-postan doğrulanmadı" deniyor; sessiz duvar en kötü seçenek. |
| 6 | Kayıt formunu "açık kayıt" gibi göster (token alanını katla, alt başlığı değiştir) | S | Form bugün "davetiye gerekiyor" izlenimi veriyor; hero'nun vaadiyle çelişiyor. |
| 7 | Portal menüsüne "Projeler" linki | S | "Takım çalışması" vaadinin giriş kapısı bugün gizli. |
| 8 | Landing'e GitHub linki + iş modeli/ücretsizlik satırı + kurucu kimliği | S | Elde olan en ucuz üç güven kazancı, bugün sayfada hiç yok. |
| 9 | `/apply` akışına kapasite kontrolü + mentörün kabul/ret adımı | M | "Kaç kişiye açık olduğuna sen karar verirsin" cümlesi bunsuz yalan olur. |

### P1 — ilk 4-6 hafta; vaatleri zayıftan güçlüye çıkarır

| # | İş | Efor | Gerekçe |
|---|---|---|---|
| 10 | Canlı sayı endpoint'i (aktif mentör, açık proje, bekleyen talep) | S | Hero'daki tek sayı, beş paragraf metinden fazla ikna eder. |
| 11 | Şirket ilgisi sinyalini mentee'ye de düşür | M | "Firmalar seni keşfeder" vaadi bunsuz yazılamıyor. |
| 12 | Mentörün kendi mentee'sini kendi projesine ekleyebilmesi (bug) | S | "1'e N yetiştir" maddesinin önkoşulu; seçici listesi mentör için hep boş. |
| 13 | Public profile'a projeler + tamamlanan görevler + (izinli) değerlendirme özeti | M | Üründeki en güçlü kanıt bugün vitrine hiç yansımıyor. |
| 14 | Mentöre toplu "bana gelen geri bildirimler" + kendi ortalama puanı | S | "Mentee de seni değerlendirir, sen de okursun" bugün ancak tek tek sayfa gezerek doğru. |
| 15 | Testimonial altyapısı: `TESTIMONIAL` rıza tipi + `sharedPublicly`/`publishedAt` + moderasyon + public endpoint | M | Sosyal kanıt Faz 1-2'nin tamamı; sahte referans yazmamanın tek yolu. |
| 16 | Şirketin kendi açık pozisyonunu (CompanyNeed) girmesi | S | Satılan eşleşme bildirimi, admin'in elle girdiği en statik veriye bağlı. |
| 17 | Anonim landing ölçümü (rızaya uygun) | M | Bugün yalnızca giriş yapmış kullanıcı izleniyor; hangi bölümün ikna ettiği bilinemiyor. |
| 18 | Onboarding ve portal etkileşim sayfasındaki sabit İngilizce başlıklar | S | TR ziyaretçi ilk adımda dil kırılması görüyor. |
| 19 | İlk mentee ekranını "boş + 3 uyarı"dan kurtar (tek "3 adımda başla" kartı, somut bekleme beklentisi) | M | Landing vaadi ile ilk ekran arasındaki uçurum en büyük terk sebebi. |

### P2 — vaat edilmeden önce yapılması gerekenler

| # | İş | Efor | Gerekçe |
|---|---|---|---|
| 20 | Mentör dizini + mentee'nin mentör seçebilmesi | L | "Aradığın mentörlüğü yakalarsın" ancak bununla tam doğru olur. |
| 21 | Mentör profili/vitrini + firmaya görünürlük | L | "Firmalara karşı görünür olursun" bugün karşılığı sıfır olan tek mentör vaadi. |
| 22 | Şirket ↔ aday rızaya dayalı uygulama içi kanal | M | "Doğrudan iletişim" vaadi bunsuz yazılamaz. |
| 23 | Açık pozisyon ilanları + mentee başvuru akışı | L | Veri modeli var, mentee tarafında okuyan tek ekran yok. |
| 24 | Tamamlanan program için paylaşılabilir sertifika/rozet | M | Mentee'nin dışarı taşıyabileceği tek çıktı; bugün sadece portal içi banner. |
| 25 | Self-servis şirket kaydı + `/pricing` + ödeme | L | "Ucuz" iddiası ancak arkasında satın alınabilir bir şey varken yazılabilir. |
| 26 | Etkinlik / topluluk yüzeyi (üye dizini ya da etkinlik) | L | "Network kurarsın" bugün yalnızca ortak proje üzerinden; klişe yazmamak için ya bu ya sessizlik. |

---

## 7. Riskler ve dikkat edilecekler

**Asla yazılmayacak iddialar**

1. **İşe alım garantisi ya da oran.** "Sana iş buluruz", "%X işe girdi" — huni verisi oluşana kadar hiçbir oran verilemez. Verildiğinde bile "garanti" kelimesi kullanılamaz.
2. **"Firmalar seni keşfeder / bir firma seninle ilgilendiğinde görürsün."** Sinyal bugün yalnızca mentöre gidiyor. Bu tek yanlış madde, kalan beş dürüst maddenin güvenilirliğini de yakar.
3. **"Hem junior hem senior yetenek."** Senior tarafı üründe hiç yok — havuz sorgusu yalnızca mentee rolünü tarıyor. Doğrudan yanlış beyan olur.
4. **"Stajyerlerinizi yönetin."** Şirket paneli salt-okunur; ürünün kendi sözlüğü "read-only" diyor. "İzleyin/görün" doğru fiil.
5. **"Yeteneğe ulaşmak hiç bu kadar ucuz olmamıştı."** Kodda tek bir fiyat, paket, abonelik yok. Fiyat iddiası, arkasında satın alınabilir hiçbir şey yokken söylenmiş olur. Yerine: "Pilot dönemde ücretsiz."
6. **"Her aday kartında mentör değerlendirmesi var."** Premium yetkiye bağlı ve elle açılıyor; bugün gören firma sayısı muhtemelen sıfır. Gelecek zaman kullanın.
7. **"Akıllı eşleşme."** Eşleşme kaba bir anahtar kelime kontrolü, aşama filtresi yok, aday başına tek bildirim. "Buna bir bak uyarısı" dürüst tanımı.
8. **Sayı uydurma, logo bandı, stok fotoğraflı referans.** Beta bir üründe yakalanmanın maliyeti telafi edilemez.

**Operasyonel riskler**

- **Talep yaratıp karşılayamamak.** Mentee tarafı zaten kolay dolar; mentör arzı yoksa bekleyen talepler birikir ve ilk kohort küser. Landing mentee tarafında agresifleşmeden önce mentör başvuru akışı bitmeli. Gerekirse açıkça bekleme listesi denmeli.
- **AI özellikleri ortama bağlı.** CV geri bildirimi ve mülakat hazırlığı, sağlayıcı yapılandırılmamışsa kendini tamamen gizliyor. Prod'da kapalıyken landing'de vaat edilirse, kullanıcı vaat edilen kartı arayıp bulamaz — ödeme duvarından daha ağır bir güven kaybı.
- **Çalışmayan CTA, olmayan CTA'dan kötüdür.** Firma ve mentör düğmeleri arkalarındaki sayfa yazılmadan canlıya alınmamalı.

**Hukuk / veri**

- **Değerlendirme yayını rıza olmadan yapılamaz.** Mentör yorumu üçüncü kişi hakkında yazılmış kişisel veri; hem yazarın hem hakkında yazılanın açık, geri alınabilir rızası gerekir. "GDPR uyumlu" yazmak yerine mekanizmayı anlatın — elde gerçek substans var.
- **Public profilde PII yok** kuralı korunmalı; landing'de bunu somut söyleyin ("e-posta ve telefon hiçbir koşulda görünmez"), klişeye çevirmeyin.
- **IP/lisans dili:** proje AGPL-3.0-or-later ve tek hak sahibi bir gerçek kişi. Landing'de sahip olarak bir şirket adı geçmemeli.
- **Negatif değerlendirme riski:** mentörün yazdığını mentee okuyor; bu doğru ve korunmalı, ama landing "firmaya karne gider" derken adayın kaygısını da kapatmalı ("yazdığı her şeyi sen de okursun").

**Repo disiplini (metin yazılırken)**

- Landing metinleri `src/i18n/dictionaries.ts` içindeki üç `landing:` bloğunda, EN/TR/DE tam paritede olmalı (`npm run check:i18n` ve CI zorluyor).
- `e2e/landing-i18n.spec.ts` bazı landing dizelerini birebir doğruluyor; metin değişirse spec aynı PR'da güncellenmeli.
- Yeni vaat edilen her özellik `src/lib/features.ts` + `featureCatalog` ile senkron tutulmalı — landing kartları ve `/features` aynı kaynaktan besleniyor.
- Canlı sayılar metne elle gömülmemeli; hem bayatlar hem e2e assert'lerini kırar.
