# Posta kampanyaları — giden müşteri kazanımı (#2697)

> **Hukuki danışmanlık değildir.** Kanal kuralları [`outreach-compliance.md`](outreach-compliance.md)'dedir
> ve Fachanwalt incelemesi bekler. Bu dosya o kuralların CRM'deki uygulamasıdır. **İlk gerçek
> gönderimden önce** mektup metni, Art. 14 notu ve Interessenabwägung şablonu avukata gösterilmelidir.

## Neden posta

Almanya'da bir işletmeye **soğuk** ulaşmanın yasal tek kanalı mektuptur (Briefwerbung):

| Kanal | Soğuk temas | Kaynak |
| --- | --- | --- |
| E-posta, LinkedIn/XING DM, iletişim formu, SMS | **Yasak** — rıza gerekir (B2B'de de) | § 7 Abs. 2 Nr. 2 UWG |
| Telefon | **Yasak** — somut, kanıtlanabilir ilgi gerekir; listeden arama olmaz | § 7 Abs. 2 Nr. 1 UWG, BVerwG 6 C 3.23 |
| **Posta** | **Serbest** — UWG rıza istemez; DSGVO kaydı gerekir | § 7 Abs. 1 UWG; Art. 6(1)(f), 14, 21 DSGVO |

Gelen talep (demo formu, #2569) zaten vardı. Bu araç **giden** tarafı ekler: mektup → kısa link →
demo formu → lead. Mektuba gelen yanıt (`INQUIRY_REPLY`) ve formdaki DOI kutusu, ardından gelen
e-posta temasının yasal dayanağını üretir.

## Akış

1. **Hesapları topla.** Elle (`/admin/companies` → yeni lead, #2562) ya da CSV içe aktarımıyla
   (`docs/marketing-import.md`). Kaynak: tüccarın **herkese açık Impressum'u** (§ 5 DDG) — adres,
   firma adı, yetkili. Satın alınmış liste kullanılmaz.
2. **Kampanya aç** — `/admin/acquisition` (ADMIN, `companies` modülü):
   - **Adreslerin kaynağı** (zorunlu, ≥10 karakter) — her mektubun arkasına basılır
     (Art. 14 Abs. 2 lit. f).
   - **Interessenabwägung** (zorunlu, ≥20 karakter) — basılmaz; Art. 5 Abs. 2 hesap verebilirlik kaydı.
     Dikeye göre hazır bir taslakla gelir (`src/lib/postCampaignTemplates.ts`).
   - **Mektup metni** — SaleVali için hazır taslakla gelir; yer tutucular `{salutation}`,
     `{company}`, `{link}`. Hitap cinsiyet tahmin etmez ("Guten Tag Eva Weber," /
     "Sehr geehrte Damen und Herren,").
   - **Kampanya kodu** — `utm_campaign` ve kısa link `/b/<kod>`.
3. **Alıcı seç.** Listede her hesap uygunluğuyla görünür; uygun olmayanlar **gerekçesiyle** görünür
   ama seçilemez. Sunucu, ekleme anında kuralı **yeniden** uygular.
4. **Yazdır** — `/print/post-campaign/<id>`: A4, DIN 5008 Form B (DL pencereli zarf; adres alanı
   20 mm / 45 mm), katlama işaretleri, sağ üstte gönderen, QR + kısa link, altta Impressum satırı;
   **arka sayfa** Art. 14 + Art. 21 Abs. 2 notu → **çift taraflı** yazdırın.
5. **"Postalandı" işaretle.** Kampanya `SENT` olur ve **kilitlenir**: düzenlenemez, alıcı
   değiştirilemez, silinemez — neyin kime hangi dayanakla gittiğinin kaydıdır. Baskı ile postalama
   arasında itiraz eden hesap "gönderildi" diye işaretlenmez, sayısı gösterilir.
6. **Sonuç.** `/b/<kod>` → `/?utm_source=brief&utm_medium=post&utm_campaign=<kod>#demo`. Gelen
   demo talepleri kampanya sayfasında sayılır; lead'e dönüşünce Source'u `utm:brief/post/<kod>`
   olur (#2570, `src/lib/leadSourceName.ts`) ve funnel/atıf raporlarında görünür.

## Uygunluk kuralı — tek dosya

`src/lib/postCampaignRule.ts` (bağımlılıksız, `scripts/test/post-campaign.test.mjs`):

| Sebep | Anlamı |
| --- | --- |
| `objected` | Sahibi itiraz etti (opt-out linki **veya** kaydedilen itiraz) |
| `suppressed` | Engel listesinde — hesabı silinmiş bir itirazın yeniden gelmesi |
| `revoked` | Biz POST kanalını kapattık (itiraz değil) |
| `no_address` | Posta adresi yok |
| `recently_mailed` | Son **90 gün** içinde mektup aldı (`POST_COOLDOWN_DAYS`) — § 7 Abs. 1 "unzumutbare Belästigung" |

## Werbewiderspruch (Art. 21) ve engel listesi

İtiraz şekle bağlı değildir: mektupla, telefonla, e-postayla gelebilir. Hesap sayfasında
**"Werbewiderspruch erfassen"** (ADMIN) → `PUT /api/admin/companies/[id]/contact-permission`
`{ action: 'objection' }`:

- **Üç kanal** da `revokedVia = 'OBJECTION'` ile geri alınır. `OBJECTION`, opt-out linkindeki
  `LINK` gibi **sahibin itirazıdır** ve satırı kilitler (`OWNER_OBJECTION_VIAS`,
  `src/lib/contactPermissionRule.ts`): hiçbir admin yazısı (nötr `NONE` dahil) üzerine yazamaz.
  Yalnız kişinin kendi yeni DOI onayı kilidi açar.
- Hesabın her kimlik anahtarı — VAT, ad+ülke, iletişim e-postası, posta adresi (normalize) —
  **HMAC'lenip** `ContactSuppression`'a yazılır. Hesap silinirse izin satırları cascade ile gider;
  engel listesi **kalır**. Aynı tüccar aynı VAT ya da adla tekrar girerse `suppressed` olur.
  Tablo yalnızca "engelli mi?" sorusuna cevap verir; anahtarın kendisi saklanmaz.

## Gönderen kimliği (§ 5 DDG, § 7 Abs. 2 Nr. 3 UWG)

Mektubun göndereni ve marketing host'undaki `/imprint`, `/privacy`, `/trust`, `/accessibility`
artık **dünyaya göre** okunur (`operatorIdentity(env, world)`, `src/lib/imprint.ts`):

- MARKETING dünyası → `MARKETING_OPERATOR_*` (ör. BCS-IT GmbH); set eksikse (`NAME` + `EMAIL`)
  bütünüyle `OPERATOR_*`'a düşer — asla karışık bir kimlik değil.
- Mektup, admin hangi host'ta olursa olsun **kampanyanın org'unun dünyasının** kimliğini ve
  origin'ini basar.

### Operatör adımı — ilk gönderimden ÖNCE

`/etc/internship-crm/prod.env` ve `preview.env`'e ekleyin (deploy betikleri iletir):

```bash
MARKETING_OPERATOR_NAME="BCS-IT GmbH"
MARKETING_OPERATOR_ADDRESS="<Straße Nr.>|<PLZ Ort>"
MARKETING_OPERATOR_EMAIL="<okunan bir adres — itirazlar buraya gelir>"
MARKETING_OPERATOR_REGISTER="Amtsgericht <…> HRB <…>"
MARKETING_OPERATOR_VAT_ID="DE…"
MARKETING_OPERATOR_RESPONSIBLE="<Geschäftsführer>"
```

Bu yapılmadan marketing host'unun Impressum'u ve mektuplar InternCRM operatörünü gösterir —
outreach-compliance § 6'daki sert blokaj.

## Ne YAPMAZ

- Mektubu kendisi göndermez (print-mail API yok) — yazdırılır, elle postalanır. 20–30'luk ölçülü
  partiler önerilir (`copy-bank.md` § 9.2).
- E-posta göndermez; kampanya listesi bir e-posta listesi değildir.
- "Keine Werbung" levhasını bilemez — süreç.
- Saklama süresi (Art. 14 notundaki 24 ay, `PROSPECT_RETENTION_MONTHS`) henüz otomatik
  uygulanmıyor; ilk silme turu elle (#2559 yüzeyi). Gönderilmiş kampanya kaydı için öneri:
  kampanya + 3 yıl.

## Veri modeli

`PostCampaign` (kod `@@unique([orgId, code])`, `DRAFT|SENT`), `PostCampaignRecipient`
(basılan adres bloğunun anlık görüntüsü, `sentAt`), `ContactSuppression`
(`@@unique([orgId, channel, keyHash])`). Üçü de `TENANT_MODELS`'te; her yazan `orgId`'yi
kendisi geçer, her okuma `tenantWhere` ile daraltılır.
