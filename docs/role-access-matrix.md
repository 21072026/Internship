# Rol-erişim matrisi / Role access matrix

Bu doküman, her rolün hangi veriyi görebildiğini tek yerde tanımlar. Kaynak kod
karşılığı: [`src/lib/authzScope.ts`](../src/lib/authzScope.ts). Kod ile bu tablo
ayrışırsa **kod doğrudur** — tabloyu güncelleyin.

İlgili: epic [#814](https://github.com/21072026/Internship/issues/814), story
[#831](https://github.com/21072026/Internship/issues/831), denetim playbook'u
[`security-audit-playbook.md`](security-audit-playbook.md).

## Neden fail-closed / Why fail-closed

Route'lar kapsamı "tanıdığım rolü filtrele" mantığıyla kuruyordu:

```ts
if (role === 'MENTOR')      where.relation = { mentorId: self };
else if (role === 'MENTEE') where.relation = { menteeId: self };
// else YOK → COMPANY, SOURCE ve sonradan eklenen her rol filtresiz sorgu çalıştırır
```

`else` dalı olmadığı için, zincirin adını anmadığı rol boş bir `where` ile
devam ediyor ve **ADMIN görünürlüğü** alıyordu. Bu "allowlist-by-omission"
deseni, `COMPANY` ve `SOURCE` rolleri eklendiğinde sessizce yetki yükseltmesine
dönüştü ([#847](https://github.com/21072026/Internship/issues/847),
[#848](https://github.com/21072026/Internship/issues/848)).

Bugünkü kural: **kapsamı tanımlı olmayan rol reddedilir.**

```mermaid
flowchart TD
  R[İstek] --> SW["scopeForRole(user, resource)"]
  SW --> K{rol için builder var mı?}
  K -- evet --> F[kapsanmış where] --> Q[(Prisma)]
  K -- hayır --> D403["403 Forbidden<br/>+ authz.scope_denied (warning)"]
  style D403 fill:#ddffdd,stroke:#0e8a16,stroke-width:2px
```

`schema.prisma`'daki `Role` enum'una yeni bir rol eklemek, `authzScope.ts`'e
builder eklenmediği sürece o role **erişim vermez** — sessizce genişletmek
artık mümkün değil.

## Kapsanan kaynaklar / Scoped resources

`scopeForRole(user, resource)` iki kaynak tanıyor. `{}` = kasıtlı olarak
kapsamsız; `—` = builder yok, yani **403**.

### `relation` — `MentorshipRelation` ve üzerinden erişilen her şey

`GET /api/mentorship`, `GET /api/interactions`

| Rol | Kapsam | Gerekçe |
|---|---|---|
| `ADMIN` | `{}` (tümü) | Tenant'ın tamamı tasarım gereği |
| `MENTOR` | `mentorId = self` | Kendi mentilerini takip eder |
| `MENTEE` | `menteeId = self` | Kendi ilişkisi |
| `COMPANY` | `companyId = self.companyId ?? '__none__'` | Salt-okunur; yalnız kendi şirketine atanmış ilişkiler |
| `SOURCE` | `mentee.sourceId = <kendi sourceId'si> ?? '__none__'` | Yalnız kendi yönlendirdiği adaylar |
| diğer | — | 403 |

`companyId`/`sourceId` boşsa `'__none__'` sentinel'i devreye girer: hiçbir cuid
ile eşleşmediği için sonuç kümesi **boş** olur. Bu önemli — şirketi atanmamış
bir `COMPANY` hesabı "filtre yok" değil "hiçbir şey" görmeli.

### `project` — `Project`

`GET /api/projects`

| Rol | Kapsam | Gerekçe |
|---|---|---|
| `ADMIN` | `{}` (tümü) | |
| `MENTOR` | sahibi **veya** üyesi olduğu projeler | [#617](https://github.com/21072026/Internship/issues/617) / [#619](https://github.com/21072026/Internship/issues/619) |
| `MENTEE` | `isPublic = true` | Yalnız açık vitrin |
| `COMPANY` | `ownerCompanyId = self.companyId ?? '__none__'` | Kendi şirketinin projeleri |
| `SOURCE` | `isPublic = true` | Kendine ait proje akışı yok; menti ile aynı vitrin |
| diğer | — | 403 |

Vitrin rolleri (`MENTEE`, `SOURCE`) için yanıt ayrıca **PII'dan arındırılıyor**:
üye ve ilişki isimleri çıkarılıp yalnız sayı bırakılıyor.

## Bu matrisin dışında kalanlar / Out of scope for this matrix

Aşağıdaki alanlar `scopeForRole` kullanmıyor çünkü zaten fail-closed bir desenle
yazılmışlar; denetimde temiz çıktılar ve **bozulmamalı**:

| Alan | Desen | Dosya |
|---|---|---|
| CV erişimi | `canAccessCv()` — sonda açık `return false` | [`src/lib/cvAccess.ts`](../src/lib/cvAccess.ts) |
| Belge erişimi | aynı desen | [`src/lib/documentAccess.ts`](../src/lib/documentAccess.ts) |
| Mesajlaşma | `getThreadIfAllowed()` | [`src/lib/messaging.ts`](../src/lib/messaging.ts) |
| Proje detayı/üyeleri | `isProjectMember()` + sahiplik | [`src/lib/projectAccess.ts`](../src/lib/projectAccess.ts) |
| Rol-kapılı route'lar | Girişte rol allowlist'i → 401 (`/api/users`, `/api/search`, `/api/meetings`, `/api/availability`, `/api/company/*`, `/api/mentor/*`, `/api/admin/*`) | ilgili `route.ts` |
| Kayıt bazlı yetki | `allowed = ADMIN \|\| katılımcı` (varsayılan `false`) | `/api/evaluations`, `/api/questions/[id]`, `/api/mentorship/[id]`, `/api/users/[id]/activity` |

Erişimin *süresi* ve *kapsamı* (mentorluk sonrası pencere, alan minimizasyonu)
da ayrı bir katman: [`pii-access-lifecycle.md`](pii-access-lifecycle.md).

Tenant (organizasyon) izolasyonu **ayrı bir katman**: `withTenantScope()` /
`MT_ENFORCE_ISOLATION` — bkz. [`tenant-isolation.md`](tenant-isolation.md). Bu
matris tenant *içi* rol kapsamlamasını tanımlar.

## Yazma işlemleri / Write access

Bu matris **okuma** kapsamıdır. Yazma yolları ayrı korunuyor ve bu değişiklikle
ellenmedi; en kritikleri:

| İşlem | Kural |
|---|---|
| `POST /api/interactions` | `ADMIN` veya ilişkinin mentoru |
| `POST /api/mentorship` | yalnız `ADMIN` |
| `POST /api/projects` | `ADMIN` veya `MENTOR` (mentor daima sahip olur) |
| `POST /api/source/mentees` | yalnız `SOURCE`, kendi `sourceId`'si ile |
| `GET/POST /api/sources` | `ADMIN` veya `MENTOR` — birleşik "getiren kişi / kaynak" seçiminin listesi ve yerinde kaynak yaratma (#1296). Yönetim uçları (istatistik, silme) `ADMIN`-only `/api/admin/sources` altında kalıyor. |

## Yapay zekâ uçları / AI endpoints

Beş uç bir dil modeline metin gönderir. Hepsi rol kapılı **ve** ayrıca
[`runAiGated`](../src/lib/aiGate.ts) üzerinden geçer: rıza → aylık kota →
sağlayıcı. Rol kontrolünü geçmek tek başına yetmez.

| Uç | Rol | Ek kapı |
|---|---|---|
| `POST /api/cv/[userId]/extract-ai` | `canAccessCv()` kime izin veriyorsa | CV sahibinin `AI_CV_PARSING` rızası |
| `POST /api/cv/feedback` | oturum açmış herkes — **yalnızca kendi CV'si** (uç, gövdedeki id'yi değil oturumu okur) | çağıranın `AI_CV_PARSING` rızası |
| `POST /api/interactions/summary` | `MENTOR` veya `ADMIN`, `getThreadIfAllowed()` ile kendi ilişkisinde | **mentee'nin** `AI_INTERACTION_SUMMARY` rızası |
| `POST /api/interview-prep` | yalnız `MENTEE`, kendisi için | rıza yok — kimlik taşıyan hiçbir alan gönderilmez |
| `POST /api/admin/mentor-suggest` | yalnız `ADMIN` | rıza yok — mentorlar A–E harfleriyle anonim gider |

`GET /api/cv/feedback` ve `GET /api/interview-prep` yalnızca "bu özellik açık
mı" bilgisini döndürür; kişisel veri taşımaz.

Her ucun ne gönderip neyi bilerek göndermediği, saklama ve bozulma davranışı:
[`ai.md`](ai.md).

## Regresyon testi / Regression test

İki spec bu matrisi kilitliyor:

- [`e2e/authz-matrix.spec.ts`](../e2e/authz-matrix.spec.ts) (`@smoke`) — matrisin
  **çalıştırılabilir** hâli. Tablo [`e2e/fixtures/authz-matrix.ts`](../e2e/fixtures/authz-matrix.ts)
  içinde; her rol × uç hücresi `all` / `own` / `deny`. Yeni bir kaynak veya rol
  eklerken **önce oraya satır ekleyin**.
- [`e2e/role-scoping.spec.ts`](../e2e/role-scoping.spec.ts) (`@smoke`) — özgün
  sızıntının somut senaryosu.

Her ikisi de Test **satır sahipliğini** doğruluyor,
HTTP status'unu değil — sızıntı boyunca her istek `200` dönüyordu, dolayısıyla
yalnız status kontrol eden bir test bunu yakalayamazdı.

Yeni bir rol veya yeni bir kapsanan kaynak eklerken:

1. `authzScope.ts` içindeki `BUILDERS`'a rolü ekleyin (eklemezseniz rol 403 alır — güvenli varsayılan).
2. Bu dokümandaki tabloyu güncelleyin.
3. [`e2e/fixtures/authz-matrix.ts`](../e2e/fixtures/authz-matrix.ts) tablosuna rolü/ucu ekleyin — `own` hücresi
   için `ownership` yüklemini de yazın.
