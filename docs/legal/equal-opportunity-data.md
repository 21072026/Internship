# Fırsat eşitliği verisi — işleme konumu (#819)

> Hukuki tavsiye değildir. Demografik veri toplanmasına karar verilirse, veri koruma
> hukukçusu / DPO onayı gerekir.

## Bugünkü konum: **demografik veri toplanmıyor**

Bu ürün, kullanıcılarından **cinsiyet, etnik köken, engellilik durumu, yaş grubu veya
benzeri hiçbir demografik veriyi toplamıyor.** Şemada böyle bir alan yok
(`gender` / `diversity` / `eeo` aramaları `prisma/schema.prisma` ve `src/` içinde iş
anlamında sıfır sonuç veriyor), hiçbir API bunu kabul etmiyor, hiçbir ekran bunu
sormuyor.

Bu **bilinçli bir karardır**, eksik bir uygulama değil. #819 kabul kriteri şunu
şart koşuyor:

> Ürün sahibi onayı alınmadan demografik alan eklenmiyor (bu maddenin işaretlenmesi
> için issue'da açık onay yorumu olmalı).

Böyle bir onay **henüz verilmedi**. Onay gelene kadar şema değişikliği yapılmayacak.

## Neden "toplamamak" da geçerli bir üründe karar

- **Özel nitelikli veri.** Cinsiyet, etnik köken ve sağlık/engellilik durumu KVKK m.6
  ve GDPR Art. 9 kapsamında özel nitelikli kişisel veri sayılabilir. Açık rıza dışında
  pratikte işleme dayanağı yoktur; açık rıza ise her an geri çekilebilir, dolayısıyla
  üzerine kurulan rapor da her an eksilir.
- **k<5 hücre gizlemek yetmiyor.** Küçük bir programda iki farklı kırılımın farkı
  alınarak birey tespit edilebilir (*differencing attack*). Bunu gerçekten kapatmak,
  hücre gizlemenin ötesinde kırılım kombinasyonlarını da sınırlamayı gerektirir — yani
  raporun analitik değerinin bir kısmından vazgeçmeyi.
- **Ölçek asimetrisi.** Program bugünkü ölçekteyken demografik kırılımın istatistiksel
  olarak söyleyebileceği şey sınırlı; risk ise ölçekten bağımsız olarak tam.

Toplanmayan veri sızdırılamaz, yanlış yorumlanamaz ve geri çekilme talebi doğurmaz.

## Bunun yerine ne gönderildi: kör inceleme modu

Fırsat eşitliğine **demografik veri toplamadan** katkı veren yarım, #819'un kendi
tavsiyesi doğrultusunda ayrı gönderildi: mülakat panelinde aday kimliğinin
(isim / foto / üniversite) gizlenmesi, org bazlı bir ayarla.

- Org bazlı, kişi bazlı değil: önyargı azaltma ancak herkes için varsayılan olduğunda
  işe yarar, "isteyen açar" olduğunda değil. Varsayılan **kapalı** — mevcut
  kurulumlarda hiçbir şey değişmez.
- Uygulandığı yer mülakat panelidir, çünkü kör incelemenin anlamlı olduğu yer orasıdır:
  haftalık görüştüğün mentee'ni körlemek bir şey ifade etmez, ilk kez puanladığın adayı
  körlemek eder.
- Kimlik, panel üyesi kendi puanını gönderene kadar gizli kalır, sonra açılır — mevcut
  "kendi puanını göndermeden başkasınınkini göremezsin" kapısıyla aynı mantık.

## Karar değişirse: onaydan önce netleşmesi gerekenler

Aşağıdakiler **karara bağlanmadan** hiçbir demografik alan eklenmemelidir.

| Soru | Neden şimdi cevaplanmalı |
|---|---|
| Hangi alanlar? | Liste ürün sahibi kararıdır; "sonra daraltırız" bu veri sınıfında geçerli değil. |
| Hukuki dayanak | Pratikte yalnızca **açık rıza**. Mevcut `UserConsent` + `ConsentType` altyapısına ayrı bir tür olarak oturur. |
| Saklama süresi | `src/lib/retention.ts` ile aynı çerçevede, ayrı ve daha kısa bir süre. |
| Geri çekilme | Rıza geri çekilince veri **silinir** — gizlenmekle yetinilmez. |
| Erişim | Ham veri **hiçbir** arayüzde birey bazında gösterilmez; mentöre, şirkete, admine bile. Yalnızca toplu rapor. |
| Yeniden tanımlanamazlık | k<5 hücre gizleme **ve** kırılım kombinasyonu sınırı; differencing attack senaryosu teste bağlanmalı. |
| Serbest metin | Yok. Serbest metin ayrıştırılabilirlik riski yaratır; her alanda "belirtmek istemiyorum" seçeneği olur. |

Kurumsal veya AB fonlu bir müşteri talebi somutlaştığında bu doküman güncellenerek
karar yeniden açılabilir; kör inceleme modu o senaryoda da bağımsız olarak yerinde
durmaya devam eder.

## İlgili

- Issue: #819 (epic #799)
- Rıza altyapısı: `prisma/schema.prisma` → `UserConsent` / `ConsentType`,
  `src/components/ConsentSettings.tsx`, `src/lib/consent.ts`
- Anonim toplu raporlama örneği: `src/components/admin/ProgramBenchmark.tsx`
- Gizlilik zemini: `src/lib/privacy.ts`, `src/lib/retention.ts`,
  [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md)
