# Bir hesabın muhatapları — adres defteri (#2442)

Bir firma (hesap) artık birden fazla muhatap tutar ve aralarından **biri birinciltir**.

## Model kararı

| Soru | Karar |
|---|---|
| Birincil muhatap nerede? | `Company.contactName` / `contactEmail` / `contactPhone` / `contactPosition` — **olduğu yerde**. Bu dört kolon birincil muhataptır. |
| Diğerleri? | `CompanyContact` satırları (`companyId`, `name`, `email`, `phone`, `position`). |
| Neden `isPrimary` bayrağı yok? | Birincil muhatabı okuyan yerler zaten var ve çok: iletişim izni (#2577, UWG § 7 — izin *o adrese* aittir), mektup kampanyaları, içe aktarma, export, silme kuralı (#2434), talep dönüşümü. Bir `isPrimary` aynası bu kolonları yazan **altı** yolun hepsine bir senkron yükümlülüğü ekler; biri unutulunca iki "birincil" olur. Birincili kolonlarda tutmak "tek birincil"i **yapısal** yapar: iki tane olamaz. |
| Neden `User` değil? | `User` bir oturum sahibidir (parola, kilit, davet, GDPR silme, rol). Tüccarın muhatabı hiç giriş yapmaz. |
| Funnel taşıyıcısı mı? | Hayır — funnel kaydı `MentorshipRelation` olarak kalır (`docs/marketing-vertical/pipeline-record.md`). Adres defteri yalnızca adres defteridir. |

Kural (bağımlılıksız, birim testli): `src/lib/companyContactsRule.ts`
(`scripts/test/company-contacts.test.mjs`). Prisma yarısı: `src/lib/companyContacts.ts`.

## Birincil yapmak = takas

"Bunu birincil yap" seçilen satırı kolonlara taşır, önceki birincili **yeni bir satır**
olarak yazar, seçilen satırı siler. Hepsi **tek transaction** içinde ve önce firma
satırının kilidi alınır (`SELECT … FOR UPDATE`):

- Aynı firmada iki eşzamanlı istek **sıraya girer**; hiçbir kişi kaybolmaz ya da çoğalmaz.
- Aynı satır için iki istek: ilki satırı tüketir, ikincisi `404` alır — tekrar eden bir
  istek iki kişiyi **geri takas etmez** (önceki birinciline seçilen satırın id'si
  verilmediği için).
- Birincil değişince `contactEmail` de değişir; bir iletişim izni hâlâ **izni veren
  adrese** aittir (`marketingEmailAllowed`), yeni birincile otomatik geçmez.

Hesabın **ilk** muhatabı doğrudan birincil olur.

## Taşıma

İnsanlar iş değiştirir: `POST /api/companies/[id]/contacts/[contactId]/move` `{ companyId }`
bir muhatabı (satır ya da `primary`) **aynı kiracıdaki** başka bir hesaba taşır. Hedefin
birincili yoksa kişi onun birincili olur; varsa satır **kendi id'si ve `createdAt`'i ile**
taşınır. Geçmiş, `company_contact.moved` ActivityLog kaydıdır (hangi hesaptan hangisine,
hedefteki id ile). Başka kiracının hesabı yokmuş gibi `404`.

## Kim neyi görür, kim yazar

- **Okuma** `GET /api/companies/[id]/contacts`: firmayı okuyabilen herkes
  (`scopeForRole(user, 'company')`). ADMIN dışındaki okur `name`, `phone`, `position`
  görmez (`redactContactForReader`, `src/lib/companyVisibility.ts`) — birincilin
  `contactName`/`contactPhone`/`contactPosition` kolonlarıyla aynı kural.
- **Yazma** (ekle, düzenle, sil, birincil yap, taşı): yalnızca ADMIN, `companies`
  capability'si olan bir org, ve kendi kiracısındaki firma (`adminCompany()`,
  `src/lib/companyContactsAccess.ts`). `check:capability-writers` modeli `companies`
  modülüne bağlar.
- Adres **firma başına** tekildir (`@@unique([companyId, email])` + birincilin adresi),
  asla global değil: iki kiracı aynı tüccarı tutabilir. Adresler küçük harfle saklanır.

## Silme ve export

- Bir adresi unutmak (DSGVO Art. 17 — hesap silme ve `forget`, #2434/#2559) o adresi
  taşıyan adres defteri satırlarını **siler** (satırın tamamı kişisel veridir) ve
  birincil kolonlarını (artık `contactPosition` dahil) temizler — aynı kiracı kuralıyla.
- Firma export'u (#2435) `contacts` dizisini içerir; firma silinince adres defteri
  cascade ile gider.

## Arayüz

`/admin/companies/[id]` → **Muhataplar** kartı: liste (birincil rozetli), ekle,
düzenle, kaldır, birincil yap, başka hesaba taşı (`CompanyContactsEditor`). Satış
temsilcisinin hesap görünümü aynı listeyi salt okunur ve maskelenmiş gösterir.
