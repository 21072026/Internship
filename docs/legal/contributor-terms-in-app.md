# Katkı şartlarının uygulama içinde onaylanması — tasarım

> Hukuki tavsiye değildir; uygulanmadan önce (özellikle § 40 UrhG kısmı) avukat
> gözden geçirmesi gerekir. Bağlam:
> [cla-contributor-agreement.md](cla-contributor-agreement.md).

## Soru

Yeni geliştiriciler zaten bu platforma kaydoluyor. **Kayıt sırasında onayladıkları metne
katkı şartlarını koymak yeterli mi?** Yoksa bir projeye eklenirken ayrıca onay almalı mıyız?

## Cevap: elektronik onay yeterlidir — ama tek bir "ömür boyu" onay değil

**Elektronik kabul (click-wrap) hukuken geçerlidir.** Alman hukukunda kullanım hakkı
tanınması (Nutzungsrechtseinräumung, § 31 UrhG) kural olarak **yazılı şekle tabi değildir**;
tıklayarak verilen onay da bağlayıcıdır. Geçerli olması için gereken pratik koşullar:

1. **Metin onaydan önce görünür** olmalı (link değil, okunabilir içerik; link ise metin tek
   tıkla ve giriş yapmadan erişilebilir olmalı).
2. **İşaretsiz kutu** — önceden işaretli gelmemeli; kabul, kullanıcının aktif eylemi olmalı.
3. **Sürümlü metin** — hangi sürümün kabul edildiği kayıtlı olmalı; metin değişince
   **yeniden onay** istenmeli (eski onay yeni metni kapsamaz).
4. **Kanıt kaydı** — kim, hangi sürümü, ne zaman, hangi IP'den kabul etti.
5. **Kalıcı kopya** — kullanıcı kabul ettiği metni sonradan görebilmeli/indirebilmeli.

**Ama iki hukuki sınır var** ve tasarımı bunlar belirliyor:

- **§ 40 UrhG** — henüz yaratılmamış, yalnızca "türüyle" tanımlanmış **gelecek eserler**
  üzerine yapılan sözleşmeler **yazılı şekil** gerektirir ve 5 yıl sonra feshedilebilir.
  Yani "bundan sonraki tüm katkılarım şimdiden devredilmiştir" tarzı **tek ve süresiz bir
  blanket onay zayıftır**.
- **§ 31a UrhG** — bilinmeyen kullanım türleri için de yazılı şekil gerekir.

**Tasarım sonucu:** onayı *geleceğe dönük tek bir taahhüt* olarak değil, **kapsamı belirli
ve tekrarlanan** bir onay zinciri olarak kur:

| Katman | Nerede | Neyi kapsar |
|---|---|---|
| **Platform onayı** | Kayıt / onboarding | Genel katkı şartları — bu kullanıcının bu platformdaki katkılarına uygulanacak kurallar |
| **Proje onayı** | Kullanıcı bir projeye eklendiğinde | O projenin şartları (varsayılan veya projeye özel), kapsamı somut hale getirir |
| **Katkı onayı** | Her PR (mevcut şablon kutusu) | O somut katkı — hukuken en güçlü halka, çünkü eser artık mevcut ve belirli |

Üçü birlikte, tek bir blanket onaydan çok daha sağlam. **Bu yüzden "projeye eklenirken onay
alalım" fikri doğru** — sadece ek bir tıklama değil, kapsamı belirlediği için hukuken
anlamlı. Kağıt/e-imza yalnızca **mentorluk dışı** (ücretli çalışan, harici geliştirici,
ajans, kurumsal katkı) durumlarda gerekli kalır.

## Genel tasarım (çok projeli düşünülmüş)

İleride başka projeler olacağı ve her projenin IP kuralı farklı olabileceği için şartlar
**veri** olarak modellenir, koda gömülmez.

```prisma
model ContributorTerms {
  id            String   @id @default(cuid())
  key           String   // 'default' | 'project-x' ...
  version       String   // '1.0' — değişince yeni satır, eski satır saklanır
  locale        String   // 'en' | 'tr' | 'de' (biri "asıl metin" işaretlenir)
  body          String   @db.Text  // markdown
  isAuthoritative Boolean @default(false)
  effectiveFrom DateTime
  createdAt     DateTime @default(now())
  @@unique([key, version, locale])
}

model ContributorTermsAcceptance {
  id        String   @id @default(cuid())
  userId    String
  termsKey  String
  version   String
  projectId String?  // null = platform seviyesi onay
  acceptedAt DateTime @default(now())
  ipHash    String?  // kanıt (ham IP değil, hash — mevcut clientIp deseni)
  uaHash    String?
  @@unique([userId, termsKey, version, projectId])
}
```

`Project` tarafında iki alan yeter:

```prisma
// model Project
contributorTermsKey      String?  // null → platform varsayılanı
contributorTermsRequired Boolean  @default(true)
```

**Akış:**
1. Onboarding'e bir adım: metin gösterilir, işaretsiz kutu, kabul → `Acceptance` (platform).
2. Bir kullanıcı projeye eklendiğinde: proje şartları kabul edilmemişse proje sayfası
   **gate**'lenir (görev listesi görünmez, "şartları oku ve kabul et" ekranı çıkar).
   Aynı desen `planGate`/`consent` katmanında mevcut — yeni bir mimari gerekmez.
3. Metin sürümü değişirse: bir sonraki girişte yeniden onay istenir (mevcut
   `consentRenew.ts` deseni birebir uygun).
4. `/contributor-terms` sayfası: yürürlükteki metin + kullanıcının kabul geçmişi, indirilebilir.
5. Admin: üye başına "kabul edildi mi / hangi sürüm / ne zaman" raporu + CSV/Excel ihracı
   (due-diligence'ta istenecek olan tam olarak bu; `src/lib/excel.ts` mevcut).

**Not:** Onay ekranı bir **hak talebinden feragat** de içerdiği için (bkz. CLA § 5), metnin
sade dille yazılması ve tıklamadan önce tam görünmesi önemli — gizlenmiş bir feragat maddesi
sürpriz madde (überraschende Klausel) sayılıp geçersiz olabilir.

## Kapsam dışı bırakılanlar (bilinçli)

- **Kimlik doğrulama/e-imza değil.** Nitelikli elektronik imza (QES) yalnızca § 40 UrhG
  kapsamına giren blanket gelecek-eser sözleşmesi için gerekli olurdu; yukarıdaki üç
  katmanlı kurgu o ihtiyacı ortadan kaldırıyor.
- **Mevcut katkıcılara geriye dönük uygulama yok** — maintainer kararı (CLA dokümanı).
  Sistem canlıya alındığında mevcut kullanıcılardan da bir kez onay istenebilir; bu
  ileriye dönük netlik sağlar, geçmişi değiştirmez.

## Uygulama dilimleri (issue'lara bölünmüş)

1. **Şema + platform onayı** — `ContributorTerms`, `ContributorTermsAcceptance`,
   `hasAcceptedContributorTerms()` helper'ı, onboarding adımı, `/contributor-terms` sayfası.
2. **Proje seviyesi onay** — `Project.contributorTermsKey/Required`, projeye eklenince gate,
   sürüm değişince yeniden onay.
3. **Admin raporu + ihracat** — üye başına kabul durumu, filtre, Excel/CSV.

Her dilim tek başına değer üretir ve junior-dostudur; 1. dilim olmadan 2 ve 3 anlamsızdır.
