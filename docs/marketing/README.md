# InternCRM — pazarlama dokümanları

> Durum: taslak (2026-09-06)

Bu klasör InternCRM'in **dağıtım katmanını** tarif eder: hangi kanal, ne zaman, hangi dilde, hangi
metinle, hangi ön koşulla. **On-site** katman (SEO, metadata, hreflang, OG kartları, ölçüm/dönüşüm)
bu klasörün kapsamı dışındadır ve epic **#1360** altındadır; burada yalnız ön koşul olarak anılır.

Beş doküman **birbirini tekrar etmez, birbirine bağlanır.** Aynı olguyu iki yerde farklı yazmak bu
klasörün en sık düştüğü hataydı (2026-09-06 eleştiri turunun bulgularının çoğu tam olarak buydu),
bu yüzden her olgunun **tek bir sahibi** vardır — aşağıdaki tablo o sahipliği tanımlar.

---

## 1. Dizin

| Dosya | Ne olduğu | Sahibi olduğu karar |
|---|---|---|
| [`go-to-market.md`](go-to-market.md) | Dağıtım planı: kanal matrisi, dört fazlı kapı sistemi, Almanya hukuku, KPI'lar, riskler | **Faz → hafta → dil tablosu** · kanal seçimi ve sırası · yasak ifadeler tablosu (§3.3) · hukuki sınırlar |
| [`content-calendar.md`](content-calendar.md) | 12 haftalık uygulama takvimi: hangi hafta ne yayınlanır, haftalık zaman bütçesi, içerik pilerleri (P1-P7), yayınlamama kuralları (Y1-Y10) | **Gönderi konularının tek kaynağı** (§2 tablosu + §2.0 metin eşlemesi) · haftalık kapasite bütçesi · faz-dil hizalaması |
| [`linkedin-playbook.md`](linkedin-playbook.md) | LinkedIn'e özgü mekanik: sayfa/profil alan alan denetim listesi, format ve uzunluk kuralları, etkileşim protokolü, UTM şeması, ölçüm | **Kanonik demo adresi kuralı** (§3.3) · UTM şeması (§7.2) · sayfa ve profil alanlarının doğru değerleri · ÖK1/ÖK2/ÖK3 |
| [`copy-bank.md`](copy-bank.md) | Kopyala-yapıştır metin bankası: GitHub, Show HN, Product Hunt, awesome PR'ları, Reddit, 10 LinkedIn gönderisi, ilk temas metinleri, one-pager | **Doğrulanmış sayı tablosu** (§0.1 — beş dokümanın tek sayı kaynağı) · yayın öncesi kontrol listesi (§12) · metinlerin kendisi |
| [`autoposter-interncrm-line.md`](autoposter-interncrm-line.md) | Autoposter'ın InternCRM hattının işletim sözleşmesi: kategori seti, fikir şeması (`fikirler.json`), tekrar engelleme, görsel politikası, kategorik yayın yasağı | **Hattın nasıl beslendiği** · fikir şeması alanları · görsel çekme prosedürü · §8 yayın yasağı |

---

## 2. Hangi soruya hangi dosya cevap veriyor

| Soru | Dosya | Bölüm |
|---|---|---|
| Bu kanalı açmalı mıyız, sırası ne? | `go-to-market.md` | §5 kanal matrisi · §5.1 elenen kanallar |
| Şu an hangi fazdayız, hangi dilde yazıyoruz? | `go-to-market.md` (tablo) → `content-calendar.md` (kaynak) | §4 faz-dil tablosu · §1.5 |
| Bu hafta ne yayınlıyorum? | `content-calendar.md` | §2 haftalık tablo |
| Bu haftanın metni hazır mı, nerede? | `content-calendar.md` → `copy-bank.md` | §2.0 eşleme tablosu → §7 |
| Bu cümleyi yazabilir miyim? (vaat sınırı) | `go-to-market.md` | §3.3 yasak ifadeler |
| Bu sayı doğru mu? | `copy-bank.md` | §0.1 doğrulanmış olgular |
| Bu gönderiyi bugün atabilir miyim? (durdurma) | `content-calendar.md` | §6 Y1-Y10 |
| Göndermeden önce neye bakmalıyım? | `copy-bank.md` · `linkedin-playbook.md` | §12 · §5.4 |
| Almanya'da bu temas yasal mı? | `go-to-market.md` | §7.1 yapılamaz · §7.2 yapılabilir |
| Soğuk e-posta yerine ne yapabilirim? | `copy-bank.md` | §9 (özellikle §9.2 mektup, §9.7 DOI akışı) |
| LinkedIn sayfasının şu alanına ne yazılır? | `linkedin-playbook.md` | §1.1 denetim tablosu |
| Kişisel profil mi şirket sayfası mı? | `linkedin-playbook.md` | §4 iş bölümü |
| Gönderi ne kadar uzun, link nereye? | `linkedin-playbook.md` | §5.3 |
| Yayından sonra ne yapıyorum? | `linkedin-playbook.md` | §6 etkileşim protokolü |
| Kanal işe yarıyor mu, nereden okurum? | `linkedin-playbook.md` · `content-calendar.md` · `go-to-market.md` | §7 · §7 · §8 |
| Demo linkini hangi biçimde yazarım? | `linkedin-playbook.md` | §3.3 kanonik kural kutusu |
| Impressum linki ne? | Hepsi — kanonik yol `https://interncrm.com/imprint` | `copy-bank.md` §12 kontrol maddesi |
| Ekran görüntüsünü nereden alırım? | `autoposter-interncrm-line.md` | §7.2 prosedür |
| Hatta fikir nasıl beslenir? | `autoposter-interncrm-line.md` | §5 şema · §10 haftalık akış |
| Ajan neyi yapamaz? | `autoposter-interncrm-line.md` | §8 kategorik yayın yasağı |
| Sürüm numarası kaç? | Hiçbiri — `npm run check:release-fragments` çıktısının son satırı | — |

---

## 3. Okuma sırası

**İlk kez okuyorsan (≈90 dk), sırayla:**

1. **`go-to-market.md` §2-§4** — bugünkü durum, konumlandırma, faz kapıları. *Neden* sorusunun cevabı
   burada; gerisi bunun uygulaması.
2. **`go-to-market.md` §7** — Almanya hukuku. Bu bölüm bağlayıcıdır ve diğer dört dokümanı kısıtlar;
   erken okunmazsa sonraki her plan yanlış varsayımla okunur.
3. **`content-calendar.md` §0-§2** — sert kısıtlar, haftalık bütçe, 12 haftalık tablo. Planın
   *ne zaman* tarafı.
4. **`copy-bank.md` §0** — kullanım kuralları ve doğrulanmış sayı tablosu. Metinlere bakmadan önce
   bu iki sayfa okunur; sayı tablosu bütün metinlerin kanıt tabanıdır.
5. **`linkedin-playbook.md` §0-§1** — ön koşullar ve sayfa denetimi. LinkedIn ilk açılacak kanal.
6. Geri kalanı **ihtiyaç anında** okunur: `copy-bank.md`'nin metin bölümleri gönderirken,
   `linkedin-playbook.md` §5-§7 yayın günü, `autoposter-interncrm-line.md` hattı kurarken.

**Haftalık iş yaparken (Pazartesi, ≈10 dk):**

1. `content-calendar.md` §2 → bu haftanın satırı.
2. `content-calendar.md` §2.0 → metin hazır mı, hangi bölümde.
3. `content-calendar.md` §6 → Y1-Y10'dan biri tetiklendi mi. (Tetiklendiyse hafta durur.)
4. `copy-bank.md` §12 → gönder tuşundan önce.

**Bir metni değiştirirken:** önce metnin altındaki *"Neden bu metin"* satırını oku (`copy-bank.md`
§0 kural 3), sonra `go-to-market.md` §3.3'ü. Sayı değiştiriyorsan önce `copy-bank.md` §0.1 tablosunu
güncelle, sonra metni.

---

## 4. Bu klasörün kuralları

- **Tek olgu, tek sahip.** Bir sayı, bir URL, bir faz aralığı iki dokümanda birden tanımlanmaz;
  ikinci doküman birinciye **atıf yapar**. Yukarıdaki dizin tablosunun "sahibi olduğu karar"
  sütunu bunu belirler.
- **Her sayının arkasında bir komut var.** `copy-bank.md` §0.1'de karşılığı olmayan sayı hiçbir
  metne girmez (`content-calendar.md` Y8).
- **Ön koşul satırı silinmez**, kapandığında "kapandı ({tarih})" diye işaretlenir
  (`copy-bank.md` §13) — bir sonraki okuyucu neyin neden beklediğini bilsin.
- **Her dosyanın sonunda bir "Açık sorular" bölümü var.** Cevaplanan soru ilgili bölüme işlenir ve
  satır silinir; oradaki bir satır, o dokümanın henüz karar vermediği bir şeydir.
- **Kod değişince doküman yalan söyler.** Aşama sayısı, durum makinesi, gün sayısı, rota adı ya da
  model sayısı değiştiğinde önce `copy-bank.md` §0.1 güncellenir, sonra ona bağlı metinler taranır.
