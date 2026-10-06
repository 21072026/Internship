# MARKETING canlıya alma — ilk gün, ilk hafta (#2581)

Story #2578. Amaç: "kullanmaya başladık" hissini ölçüye çevirmek ve satış ekibinin takıldığı her
yeri kaybolmadan issue'ya dönüştürmek. Her kutu işaretlendikçe tarih + kim yazılır; hafta sonunda
bu dosyanın durumu #2578'e yorum olarak geçer.

## 0. Ön koşullar (bir kez, operatör)

- [ ] Prod MARKETING org'u var; `TRIAL_ACTIVE` ve `TRIAL_EXPIRED` aşamaları mevcut
      (`/admin/settings` → aşamalar; ya da deploy logundaki trial-reminders `inScope` satırı) — #2579
- [ ] Host eşlemesi: `node prisma/set-public-host.mjs --list` prod'da `marketing.bcsit-gmbh.de`'yi
      bu org'a bağlı gösteriyor; landing'de demo formu **açık** ([`demo-form.md`](demo-form.md))
- [ ] `MARKETING_OPERATOR_*` prod + preview env dosyasında; `https://marketing.bcsit-gmbh.de/imprint`
      **BCS-IT GmbH** gösteriyor ([`postal-campaigns.md`](postal-campaigns.md) § Operatör adımı)
- [ ] Uptime içerik probu yeşil (`uptime.yml`, açık `uptime-content-alert` issue'su yok)
- [ ] Hukuki sayfalar (#2543) ve `outreach-compliance.md` + mektup şablonu **avukata gönderildi**
      (onay gelmeden posta kampanyası postalanmaz)

## 1. İlk gün

- [ ] Satış ekibinin her üyesi davet edildi, **marketing host'unda** giriş yaptı, 2FA açık
- [ ] Her temsilci `/sales` panosunu, kendi hesap listesini ve dikkat kuyruğunu görüyor
- [ ] Org düzeyinde **varsayılan lead sahibi** ayarlı (`/admin/settings`) — demo talebi sahipsiz kalmıyor
- [ ] Test lead'i elle açıldı (`/admin/companies` → yeni lead), board'da ilk aşamada görüldü, silindi
- [ ] Test demo talebi landing'den (`?utm_source=test`) gönderildi → `/admin/company-inquiries`'de
      kaynağıyla göründü → lead'e dönüştü → silindi
- [ ] İlk posta kampanyası **taslağı** açıldı: kaynak + Interessenabwägung dolduruldu, 20–30 hesap
      seçildi, bir mektup yazdırılıp kâğıt üzerinde kontrol edildi (adres pencereye oturuyor, arka
      yüz Art. 14 notu var, kısa link + QR çalışıyor)

## 2. İlk hafta — her iş günü

- [ ] Her yeni demo talebi **≤ 1 iş günü** içinde sahiplendi (sahipsiz sayaç: `/admin/company-inquiries`)
- [ ] Her `TRIAL_ACTIVE` kaydında `trialEndsAt` dolu
- [ ] Her temas `InteractionLog` olarak girildi (görüşme, e-posta, telefon) — "son temas" ve ilk temas
      süresi buna dayanır ([`../last-contact.md`](../last-contact.md)). Giden e-postalar için
      `/admin/settings` → "Gönderilen e-postaları BCC ile kaydet" adresini BCC'ye eklemek yeter
      ([`sales-email-capture.md`](sales-email-capture.md)); telefon ve görüşme hâlâ elle
- [ ] Gelen her itiraz (mektup/telefon/e-posta) **aynı gün** hesap sayfasında "Werbewiderspruch
      erfassen" ile kaydedildi
- [ ] Temsilcinin takıldığı her şey bir issue oldu ve #2348 altındaki doğru story'ye bağlandı

## 3. Hafta sonu ölçümü (PII'siz, mevcut ekranlardan)

| Metrik | Nereden | Hedef (ilk hafta) |
| --- | --- | --- |
| Trial tarih kapsamı — `trialEndsAt` dolu `TRIAL_ACTIVE` oranı | `/admin/analytics` funnel | %100 |
| İlk temas süresi medyanı (talep → ilk InteractionLog) | `/admin/analytics` aşama yaşlanması | ≤ 1 iş günü |
| Kaynak atfı oranı — Source'u dolu yeni lead'ler | `/admin/analytics` kaynak kırılımı | ≥ %80 |
| Posta kampanyası: gönderilen / demo talebi / hesaba dönüşen | `/admin/acquisition` | ilk parti için yanıt oranı kaydı |

Sonuç #2578'e yorum olarak yazılır; çıkan işler issue olarak açılır.

## 4. Hafta sonu toplantısı (30 dk)

1. Metrikler (yukarıdaki tablo)
2. Açılan issue'lar — öncelik
3. Posta kampanyası: yanıtlar, itirazlar, bir sonraki parti
4. Bir sonraki hafta: tek bir iyileştirme hedefi
