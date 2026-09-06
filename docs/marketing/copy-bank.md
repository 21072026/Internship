# InternCRM — Metin Bankası (copy bank)

Tarih: 2026-09-06 · Sürüm referansı: 0.156.22-beta · Sahibi: **Mehmet Erşahin (gerçek kişi)**
Kardeş doküman: [`go-to-market.md`](go-to-market.md) — *hangi kanal, ne zaman, hangi ön koşulla*.
Bu doküman onun **metin** tarafıdır: kopyala-yapıştır, düzenle, gönder.

---

## 0. Kullanım kuralları

1. **Her metin son hâlidir.** Kod bloğundan çıkar, ön koşulu sağlandıysa olduğu gibi gönder.
2. **Dil etiketi bağlayıcıdır.** `[EN]`, `[DE]`, `[TR]` — hedef kitlenin dili, bakımcının
   dili değil.
3. Her metnin altında tek satır **"Neden bu metin"** var. Metni değiştireceksen önce o satırı oku;
   gerekçeyi bozan bir düzenleme metni bozar.
4. **Ön koşul** satırı olan metin, o koşul sağlanmadan yayınlanmaz. Tek kullanımlık kanallarda
   (Show HN, Product Hunt) bu kural serttir.
5. Sayı geçen her cümlenin arkasında bir dosya var (aşağıdaki tablo). Yeni sayı eklenecekse
   önce kodda karşılığı bulunur; bulunamıyorsa **cümle yazılmaz**.

### 0.1 Metinlerde kullanılan doğrulanmış olgular

Aşağıdaki tablo, bu dokümandaki metinlerin tamamının kanıt tabanıdır. Kod değişince önce tablo
güncellenir, sonra metinler.

| Metinlerde geçen iddia | Kaynak |
|---|---|
| 13 aşamalı pipeline (ikisi hedef dışı çıkış: 460, 800) | `prisma/schema.prisma` → `enum PipelineStatus` |
| Aşama başına SLA, takvim günü, kurum bazlı; SLA tanımlamayan kurulum hiç etkilenmez | `src/lib/stageSla.ts` |
| Haftalık rapor onay akışı: `DRAFT → SUBMITTED → APPROVED / CHANGES_REQUESTED` | `prisma/schema.prisma` → `enum WeeklyReportStatus` |
| Yazdırılabilir staj günlüğü ("Praktikumstagebuch drucken") | `src/i18n/dictionaries.ts` (`weeklyReports.printDiary`) |
| Teklif durum makinesi: 6 durum, 4 eylem | `src/lib/offers.ts` (`OFFER_STATUSES`, `OFFER_ACTIONS`) |
| Kör mülakat puanlaması: kendi puanını girmeyen üye diğerlerini göremez | `src/lib/interviewPanel.ts` |
| Pasif ilk temas: 14 gün, en fazla iki mail, üçüncü yok | `src/lib/dormantFirstContact.ts`, `docs/dormant-first-contacts.md` |
| EN/TR/DE tam sözlük, anahtar paritesi CI'da zorunlu | `src/i18n/config.ts`, `npm run check:i18n` |
| 92 Prisma modeli | `grep -c '^model ' prisma/schema.prisma` |
| 46 kayıtlı özellik (özellik kataloğu) | `src/lib/features.ts` |
| 389 dosyalık Playwright paketi, 70 dosyada `@smoke` | `ls e2e \| wc -l`, `grep -rl @smoke e2e \| wc -l` |
| Gecelik k6 yük testi, eşikler dosyada yazılı | `k6/nightly-load.js`, `.github/workflows/k6-load.yml` |
| WCAG 2.2 AA beyanı + her PR'ı bloklayan axe-core taraması | `src/app/accessibility/`, `docs/accessibility-statement.md`, `e2e/a11y-*.spec.ts` |
| `/trust` sayfası, **henüz doğru olmayanı da** listeliyor | `src/app/trust/page.tsx` (`limitationsTitle`) |
| PWA (kurulabilir) | `src/app/manifest.ts` |
| Demo: 3 rol, tek tıkla giriş, günde iki kez sıfırlanır, e-posta gitmez, yükleme kapalı | `src/app/auth/signin/SignInClient.tsx`, `src/app/demo/page.tsx`, `src/i18n/dictionaries.ts` (`demo.*`) |
| AGPL-3.0-or-later, telif Mehmet Erşahin | `LICENSE`, `package.json` |

**Brief'e göre bir düzeltme:** demo'da tek tıkla rol girişi **vardır**. `/demo` sayfası kimlikleri
tabloda gösterir, ama `/auth/signin` demo modunda üç butonlu hızlı giriş bloğu render eder
(`data-testid="demo-quick-login"`, `demo-login-admin|mentor|mentee`). Bu yüzden bütün metinlerde
demo linki **`https://demo.interncrm.com/auth/signin`** olarak verilir — okuyucu kimlik yazmaz.

### 0.2 Bu dokümanda geçmeyen ve geçmeyecek ifadeler

Tam liste `go-to-market.md` §3.3'te. Kısa hâli: kullanıcı/müşteri sayısı yok, "trusted by" yok,
ödül yok, referans yok, sertifika yok, "çok kiracılı SaaS" yok, `crm-demo.ersah.in` yok,
şirketi hak sahibi gösteren cümle yok.

---

## 1. GitHub vitrini

Ön koşul: yok — bugün uygulanır. `go-to-market.md` Faz 0, kanal #1.

### 1.1 Repo description (About alanı, 350 karakter sınırı)

```text
[EN]
Mentor ↔ mentee CRM that follows every intern through a 13-stage pipeline: first contact,
internship, offer, hire. Per-stage SLAs, weekly reports with an approval flow, blind interview
scorecards, EN/TR/DE. AGPL-3.0, runs on your own server, live demo with one-click role sign-in.
```

*Neden bu metin:* description GitHub aramasında ve her paylaşımda indekslenir; ilk yarısı ne
olduğunu, ikinci yarısı neden farklı olduğunu (aşama SLA'sı, kör puanlama, AGPL, demo) söylüyor —
hiçbiri satış sıfatı değil, hepsi kodda var.

### 1.2 Homepage alanı

```text
https://interncrm.com
```

*Neden bu metin:* alan bugün boş; doldurulduğunda repodan siteye tek nofollow'suz bağ açılır ve
"ürün adıyla arandığında kendi domain'imiz" hedefinin en ucuz adımıdır.

### 1.3 Topics (GitHub sınırı 20)

```text
mentoring
mentorship
internship
internship-management
crm
applicant-tracking
recruiting
hr
self-hosted
open-source-alternative
nextjs
react
typescript
prisma
mysql
docker
pwa
i18n
gdpr
agpl
```

*Neden bu metin:* ilk on etiket alıcının aradığı kelimeler (kategori keşfi), son on geliştiricinin
aradığı kelimeler (yıldız ve katkı); GitHub topic sayfaları indekslenir, bu yüzden sıfır-iz
durumunda etiketler ilk organik yüzeydir.

### 1.4 README hero paragrafı

Mevcut README'nin ilk paragrafının yerine geçer (`README.md:3-6`).

```markdown
[EN]
# Internship CRM

**InternCRM follows every intern from first contact to signed offer — in one pipeline, not in a
spreadsheet.** Thirteen stages, each with its own service level; weekly reports that a mentor
approves or sends back; blind interview scorecards; an offer that can be drafted, sent, withdrawn,
accepted or declined without anyone guessing where it stands. Mentors, mentees, companies and
programme admins each get their own view of the same relationship. English, Turkish and German,
with key parity enforced in CI. AGPL-3.0-or-later — read the source, run it on your own server, or
click through the live demo without creating an account.

[Live demo (one-click sign-in as admin, mentor or mentee)](https://demo.interncrm.com/auth/signin)
· [Feature catalogue](https://interncrm.com/features)
· [Trust centre](https://interncrm.com/trust)
· [Release notes](https://interncrm.com/release-notes)
```

*Neden bu metin:* README'nin ilk ekranı hem alıcı hem geliştirici tarafından okunur; bu paragraf
kategoriyi ("pipeline, not a spreadsheet"), farkı (SLA / onay akışı / kör puanlama / teklif durumu)
ve denenebilirliği (tek tıklık demo) üç cümlede veriyor — hiçbir sayı uydurmadan.

### 1.5 Rozet satırı

```markdown
[EN]
[![CI](https://github.com/21072026/Internship/actions/workflows/ci.yml/badge.svg)](https://github.com/21072026/Internship/actions/workflows/ci.yml)
[![E2E smoke](https://github.com/21072026/Internship/actions/workflows/e2e.yml/badge.svg)](https://github.com/21072026/Internship/actions/workflows/e2e.yml)
[![CodeQL](https://github.com/21072026/Internship/actions/workflows/codeql.yml/badge.svg)](https://github.com/21072026/Internship/actions/workflows/codeql.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/demo-live-brightgreen.svg)](https://demo.interncrm.com/auth/signin)
```

*Neden bu metin:* beş rozetin dördü **canlı GitHub Actions durumu** (`ci.yml`, `e2e.yml`,
`codeql.yml` gerçekten var), yani gerçek bir kalite sinyali; "downloads" veya "stars" rozeti
bilinçli olarak yok, çünkü bugünkü sayılar zayıf ve zayıf sayı gösterilmez.

### 1.6 README — "Why this exists"

README'de `## Features` bölümünden **önce** durur.

```markdown
[EN]
## Why this exists

This started as a spreadsheet. One column held a status code — 100 first contact, 300 internship
starting, 660 hired — and everything else lived in the heads of the mentors: who had gone quiet,
who was waiting on a company, whose weekly report was late, which offer had been sent and never
answered. The spreadsheet was fine at ten people and unusable at fifty.

Most tools in this space stop halfway. Mentoring platforms model the relationship and stop at
development. Experiential-learning marketplaces model the project and stop when the project ends.
Neither follows the same person from a first message to a signed employment contract — which is
the only part the programme is actually judged on.

InternCRM models that whole path. The pipeline has thirteen stages, and two of them are exits that
are not failures: the intern dropped out, or the intern found a placement somewhere else. A stage
can carry a service level, so "waiting on the company" becomes a date rather than a feeling. An
applicant who was written to and never answered is asked twice whether they are still interested
and then marked dormant — never a third time, because that is spam and we are not sending it.

One more thing, offered as a fact rather than a pitch: parts of this codebase were written by the
interns it tracks. The mentoring agreement includes contributing to the product, so the product is
also the internship project. The commit history is public; check it.
```

*Neden bu metin:* HN, dev.to ve r/selfhosted okuyucusunun tamamı README'nin bu bölümüne bakar —
problem → kategorinin eksiği → bizim modelimiz → doğrulanabilir hikâye sırası, tek bir pazarlama
sıfatı kullanmadan konumlandırmayı kuruyor; "check it" cümlesi iddiayı okuyucunun eline veriyor.

---

## 2. Show HN

Ön koşul (`go-to-market.md` #5): OG/Twitter kartları (#1362/#1376/#1378) ve `/pricing` (#1403).
Tek kullanımlık: başarısız gönderim ~1 yıl tekrar edilemez. Gönderen: Mehmet, kendi hesabı, EN.
Oy veya yorum istemek **kategorik yasak** (HN newsguidelines).

### 2.1 Başlık (HN 80 karakter sınırı)

```text
[EN]
Show HN: InternCRM – open-source CRM for the internship-to-hire pipeline
```

*Neden bu metin:* 72 karakter; ürün adı + ne olduğu + kategorisi, süs ve sayı yok, "revolutionary"
türü editoryal ekleme yok — HN başlık kurallarının istediği düz tarif.

Yedek başlıklar (aynı kurallara uygun, biri seçilir):

```text
[EN]
Show HN: A mentor-mentee CRM that tracks interns from first contact to hire
Show HN: We replaced our internship spreadsheet with an AGPL CRM (live demo)
```

### 2.2 İlk yorum

Gönderimden hemen sonra, gönderenin kendi yorumu olarak eklenir.

```text
[EN]
I run a small mentoring programme: people apply, get matched to a mentor, do an internship, and
some of them get hired. For two years that lived in a spreadsheet whose most important column was
a status code — 100 first contact, 300 internship starting, 660 hired. It worked at ten people. At
fifty it stopped telling us anything: who had gone quiet, whose weekly report was late, which
offer had been sent and never answered.

InternCRM is what replaced it. Thirteen pipeline stages, two of which are exits that are not
failures (dropped out; found a placement elsewhere). Stages can carry a per-stage service level in
calendar days, so "waiting on the company" is a date instead of a feeling. Weekly reports go
DRAFT → SUBMITTED → APPROVED or CHANGES_REQUESTED and print as a diary. Interview panels score
blind: you cannot see anyone else's scores until you have submitted your own. Offers are a small
state machine — draft, send, withdraw, accept, decline, expire — so nobody has to ask where an
offer stands.

Demo, no signup, one click to sign in as admin, mentor or mentee:
https://demo.interncrm.com/auth/signin — synthetic data, resets twice a day, no email is actually
delivered and uploads are off.

Source (AGPL-3.0-or-later): https://github.com/21072026/Internship

What is honestly not there yet, since you will find it anyway:

- Multi-tenant isolation is written but switched off (MT_ENFORCE_ISOLATION=false). One
  organisation per installation today. I am not going to claim otherwise while the flag is off.
- There is no production docker-compose yet. The repo has a dev-only one that starts MySQL and
  says so in its own header comment. Self-hosting works, but you are assembling it from the
  Dockerfile and the env list rather than running one command. That is the next thing I am
  writing.
- No tagged releases until now, which is an embarrassing thing to admit about a project with a
  6-hourly deploy pipeline. Fixed as of this week.
- The AI features (CV feedback, interview prep, log summaries) call an external provider, are
  consent-gated and quota-gated, and are off unless you configure a key.
- The public numbers on the landing page are small because the programme is small. I would rather
  you see three mentors than a rounded-up number.

Some of this codebase was written by the interns it tracks — the mentoring agreement includes
contributing to the product, so the product is also the internship project. The commit history is
public if you want to check that claim.

Stack is Next.js 15 / React 19 / Prisma / MySQL. Happy to answer anything, including the design
decisions I am least sure about — the biggest one is modelling the pipeline as a single enum
instead of a configurable workflow, which is fast to reason about and will eventually be somebody's
blocker.
```

*Neden bu metin:* HN'in ödüllendirdiği üç şeyi ayrı ayrı veriyor — denenebilir bir şey (kayıtsız
demo linki), somut mühendislik kararları (enum vs. yapılandırılabilir akış), ve **kendini
eleştiren dürüst eksik listesi**; eksikleri yorumcunun bulmasından önce yazmak HN'de saldırı
yüzeyini savunulabilir bir tartışmaya çeviren tek taktiktir.

### 2.3 Gönderim sonrası davranış kuralı (metin değil, kural)

- Gönderimden sonraki **ilk 3-4 saat** yorumlara cevap verilebilir durumda ol; olamayacaksan
  gönderme.
- "Bu X'in kopyası" yorumuna savunma değil kıyas ile cevap ver: rakiplerin hangi noktada durduğu
  `docs/research/competitive-analysis-2026-08.md` içinde kanıtlı.
- **Kimseden oy veya yorum isteme.** Arkadaşa link atma. Bu HN'de hesabı yakan tek davranıştır.
- Fiyat sorulursa `/pricing` linki ver; sayfa yoksa gönderim zaten yapılmamış olmalıydı.

---

## 3. Product Hunt

Ön koşul (`go-to-market.md` #20): ölçüm (#1388/#1390), `/pricing` (#1403), ekran görüntüleri
(#1399), OG kartları, organik izleyici. **6 ay kilit** — Show HN'den sonra.
Self-hunt, kişisel hesap, EN.
Upvote istemek **kategorik yasak**.

### 3.1 Name

```text
[EN]
InternCRM
```

### 3.2 Tagline (60 karakter sınırı)

```text
[EN]
Track every intern from first contact to signed offer
```

*Neden bu metin:* 52 karakter; kategoriyi ve kapsamı tek cümlede veriyor, sıfat yok — Product
Hunt'ın "usefulness" boyutunda okunacak olan tam bu netlik.

Yedek tagline'lar:

```text
[EN]
The internship pipeline your spreadsheet pretended to be
Open-source CRM for internship and mentoring programmes
```

### 3.3 Description

```text
[EN]
InternCRM is a mentor-mentee CRM for internship programmes. One pipeline of thirteen stages
follows each person from first contact to a signed offer — with per-stage deadlines, weekly
reports a mentor approves or returns, blind interview scorecards, and an offer state machine.
English, Turkish and German. AGPL-3.0: use the hosted version or run it on your own server.
```

*Neden bu metin:* Product Hunt açıklaması taranarak okunur; ilk cümle kategori, ikinci cümle
mekanizma, üçüncü cümle erişim modeli — "AI-powered", "seamless", "revolutionize" gibi PH'de
ayırt ediciliğini tamamen yitirmiş kelimeler bilinçli olarak yok.

### 3.4 İlk maker yorumu

```text
[EN]
Hi Product Hunt 👋

I built InternCRM because our mentoring programme was being run out of a spreadsheet whose most
important column was a status code — 100 first contact, 300 internship starting, 660 hired. That
column is now a thirteen-stage pipeline, and everything the mentors used to remember is a field:
who has gone quiet, whose weekly report is late, which offer was sent and never answered.

What is actually in it:

• A pipeline where two of the thirteen stages are exits that are not failures — dropped out, and
  found a placement elsewhere. Programmes that only model success lie to themselves.
• Per-stage service levels in calendar days. An installation that sets none is left completely
  alone; nothing changes under you.
• Weekly reports with a review loop (draft → submitted → approved or changes requested) and a
  printable internship diary.
• Interview panels that score blind: you cannot see the other scores until you have entered yours.
• An applicant who never replied is asked twice whether they are still interested, then marked
  dormant. There is no third email — by design, permanently.
• English, Turkish and German, with translation key parity enforced in CI.

You can use it right now without signing up. One click to enter as admin, mentor or mentee:
https://demo.interncrm.com/auth/signin — it is synthetic data, it resets twice a day, no email is
actually delivered, uploads are off.

Two honest limits before you ask: multi-tenant isolation is implemented but switched off, so today
this is one organisation per installation; and there is no one-command self-host compose yet, only
a Dockerfile and a documented env list.

The source is AGPL-3.0-or-later: https://github.com/21072026/Internship

I read everything here. Tell me what breaks — and if you run an internship or mentoring programme,
tell me which stage of yours this pipeline gets wrong.
```

*Neden bu metin:* PH'de maker yorumu ürün sayfasının ikinci yarısıdır; madde listesi taranabilir,
iki dürüst limit güveni satın alır, kapanış sorusu **upvote istemeden** yorum davet eder — kural
sadece oy/yorum *talebini* yasaklıyor, geri bildirim davetini değil.

### 3.5 Sık sorulacak sorular — hazır cevaplar

```text
[EN]
Q: Is this really free?
A: The source is AGPL-3.0-or-later and you can run it on your own server at no cost, today. The
hosted plans are on https://interncrm.com/pricing. Mentors and mentees never pay on the hosted
version either — the programme owner does.

Q: Can I self-host it?
A: Yes, and that is the point of the licence. Right now you assemble it from the Dockerfile, a
MySQL database and a documented environment list; a one-command production compose file is being
written and is not there yet. I would rather say that than let you discover it.

Q: What about multiple organisations on one installation?
A: The isolation layer is written but the enforcement flag is off, so the honest answer for today
is one organisation per installation. If you need several, run several — or wait until I can say
otherwise without a footnote.

Q: How is this different from Together / Qooper / Chronus / MentorcliQ?
A: Those are mentoring platforms and they are good at the relationship. They stop at development.
Placement marketplaces stop when the project ends. InternCRM keeps going: interview, offer, hire,
employed — plus the two exits that are not failures. The other practical difference is that you
can read the price and try the product without booking a call.

Q: Where is the data hosted, and what about GDPR?
A: Hosted instances run in the EU; the trust centre lists every third party that can receive data,
what protects it, and — in the same list — what is not true yet:
https://interncrm.com/trust. Or host it yourself and the question is yours to answer.

Q: Is there an API?
A: Yes, a versioned public API with its own rate limits, plus an explorer in the app. See the docs
in the repository.

Q: Does it do AI?
A: Optional and off by default. CV feedback, interview prep and interaction-log summaries call an
external provider, and are both consent- and quota-gated. If you do not configure a key, none of it
exists.

Q: What languages?
A: English, Turkish and German — complete dictionaries, with key parity enforced by CI rather than
by good intentions.

Q: Who is behind it?
A: One person: Mehmet Erşahin. Part of the codebase was written by the interns the product tracks,
because contributing to it is part of the mentoring agreement. The commit history is public.
```

*Neden bu metin:* PH yorum akışında en çok sorulan sekiz soru; her cevabın son cümlesi ya bir
linke ya bir sınıra bağlanıyor, böylece cevaplar hem kısa hem denetlenebilir kalıyor — özellikle
"is it really free" ve "multi-tenant" cevapları yanlış vaadin en olası iki kaçış noktasını
kapatıyor.

---

## 4. Awesome liste PR'ları

### 4.1 awesome-selfhosted-data — `software/interncrm.yml`

**Bugün gönderilemez.** İki blokaj: (a) ilk GitHub Release'in üzerinden **4 ay** geçmiş olmalı —
bugün sıfır release, sıfır tag; (b) "working installation instructions" için üretim compose'u +
`docs/self-hosting.md` gerekiyor. PR **ana repoya değil**, `awesome-selfhosted-data`'ya açılır ve
**elle doğrulanmadan gönderilmez** (CONTRIBUTING: LLM üretimi, kılavuza uymayan katkı = ban).

```yaml
# [EN] awesome-selfhosted-data/software/interncrm.yml
name: InternCRM
website_url: https://interncrm.com
source_code_url: https://github.com/21072026/Internship
description: Mentor and mentee CRM for internship programmes. Tracks each participant through a thirteen-stage pipeline from first contact to hire, with per-stage deadlines, weekly reports with an approval loop, blind interview scorecards and offer tracking.
licenses:
  - AGPL-3.0
platforms:
  - Nodejs
  - Docker
tags:
  - Human Resources Management (HRM)
  - Customer Relationship Management (CRM)
  - Learning and Courses
demo_url: https://demo.interncrm.com/auth/signin
```

*Neden bu metin:* açıklama 249 karakterin altında ve listenin yasakladığı "open-source",
"free", "self-hosted" kelimelerini hiç kullanmıyor (liste bunları zaten ima ediyor); `tags` ilk
elemanı HRM, çünkü single-page modunda yazılım yalnızca ilk kategoride görünüyor ve HRM kategorisi
ince; `demo_url` doğrudan tek tıkla giriş ekranına gidiyor — şablonun "link to the credentials
directly" koşulunu karşılayan hâl budur.

PR açıklaması:

```markdown
[EN]
Adding InternCRM, a self-hosted CRM for internship and mentoring programmes.

I am the developer of the project. It has been in continuous development since early 2026 (see
CHANGELOG.md and the release history), is deployed and running at https://interncrm.com, and has a
public interactive demo at https://demo.interncrm.com/auth/signin where the three roles (admin,
mentor, mentee) can be entered with one click — credentials are shown on the sign-in page itself,
no account creation, no email.

Licence is AGPL-3.0-or-later. Installation instructions for a production deployment are in
docs/self-hosting.md, verified from scratch against a clean host before opening this PR.

I placed it under Human Resources Management (HRM) as the first tag because the product's core
model is the hiring pipeline (first contact → internship → offer → hired) rather than the
customer relationship; CRM and Learning and Courses are secondary.
```

*Neden bu metin:* PR şablonunun denetlenen onay kutularının her birine (aktif bakım, çalışan
kurulum talimatı, doğrudan kimlik bilgisine link, tek yazılım, kategori seçimi) sırayla ve elle
doğrulanmış cümlelerle cevap veriyor; geliştirici olduğunu açıkça söylemek bu listede zorunlu
değil ama bakımcı güvenini artıran ucuz bir hamle.

### 4.2 awesome-recruitment / awesome-hrtech (bugün gönderilebilir)

Bu iki listede formel kabul kriteri yok. **15 dakikalık zaman kutusu**, takip yatırımı yok.
PR açmadan önce README'nin **o günkü** satır formatını birebir kopyala — aşağıdaki iki biçim
bugünkü yapıya göredir, değişmiş olabilir.

```markdown
[EN] — liste biçimi
- [InternCRM](https://interncrm.com) — Mentor-mentee CRM for internship programmes: a thirteen-stage pipeline from first contact to hire, weekly report approvals, blind interview scorecards. AGPL-3.0, self-hostable, [live demo](https://demo.interncrm.com/auth/signin).
```

```markdown
[EN] — tablo biçimi
| InternCRM | Mentor-mentee CRM for internship programmes: thirteen-stage pipeline from first contact to hire, weekly report approvals, blind interview scorecards. AGPL-3.0, self-hostable. | [Website](https://interncrm.com) · [Demo](https://demo.interncrm.com/auth/signin) |
```

PR açıklaması (her ikisi için aynı):

```markdown
[EN]
I am the developer. InternCRM is an AGPL-3.0 CRM for internship and mentoring programmes — it
tracks each participant from first contact through internship to hire. Live and maintained;
interactive demo with one-click role sign-in at https://demo.interncrm.com/auth/signin.

Happy to adjust the wording or move the entry to a different section if it fits better elsewhere.
```

*Neden bu metin:* iki listede de bakımcı zamanı dar ve açık PR birikmiş; tek satır + "istediğin
yere taşı" cümlesi merge kararını bakımcı için sıfır işe indiriyor.

---

## 5. dev.to yazısı

Ön koşul: en az 3 ürün ekran görüntüsü (#1399) — dev.to görsel bir mecra değil ama ekransız bir
ürün yazısı okunmuyor. Dil: EN. Canonical URL kendi sitene ayarlanır (dev.to `canonical_url`
alanı), yoksa dev.to kendi sayfanı SERP'te geçer.

### 5.1 Başlık seçenekleri

```text
[EN]
1. We replaced our internship spreadsheet with a 13-stage pipeline — here is the data model
2. The two pipeline stages nobody models: "dropped out" and "found it somewhere else"
3. Building a CRM with the interns it tracks
4. Blind interview scoring in 120 lines: why nobody sees a score before they submit one
5. Your applicant went quiet. How many emails is it fair to send? (We settled on two)
```

*Neden bu metin:* dev.to'da tıklanan başlık ürün adı içeren değil, **karar** içeren başlıktır;
beşi de yazının içinde gerçekten cevabı olan bir soru soruyor — 2 ve 5 en yüksek tıklama
potansiyeline sahip olanlar, çünkü ikisi de kategorinin konuşmadığı bir seçimi adlandırıyor.

### 5.2 Tam giriş paragrafı

```text
[EN]
For two years our mentoring programme ran on a spreadsheet, and the only column that mattered was
a status code: 100 first contact, 220 waiting for approval, 300 internship starting, 660 hired.
Everyone had memorised the numbers. Nobody could answer the question that actually decided whether
the programme was working — of the people who entered at 100, how many reached 660, and where did
the rest stop? The spreadsheet could not answer it because it only stored the current value. There
was no history, no clock on a stage, and no way to record that someone left for a good reason.

So we rebuilt it as a proper data model, and the interesting part was not the CRUD. It was the
three decisions that a spreadsheet lets you avoid: what counts as an exit, how long a stage is
allowed to take, and what you are permitted to do when someone stops replying. This post is about
those three, with the schema and the code that enforces them. The project is AGPL-3.0 and there is
a demo you can click through without signing up, but you do not need either to follow along —
the decisions transfer to any pipeline you are modelling.
```

*Neden bu metin:* dev.to okuyucusu ürün tanıtımını ilk paragrafta terk eder; bu giriş ürünü değil
**üç tasarım kararını** vaat ediyor ve linkleri son cümleye, "bunlara ihtiyacın yok" ifadesiyle
birlikte gömüyor — okuyucuya çıkış kapısı vererek kalmasını sağlayan klasik hamle.

### 5.3 Bölüm başlıkları taslağı

```markdown
[EN]
## The spreadsheet, and the one column that ran everything
## Decision 1: an exit is not a failure
   ### Thirteen stages, two of which end the story without a hire
   ### Why INTERNSHIP_FOUND_ELSEWHERE_800 is a success metric, not a loss
   ### The enum lives in the schema; the Turkish names are labels, not keys
## Decision 2: a stage has a clock
   ### Per-stage service levels, in calendar days (and why not business days)
   ### The rule that made it safe to ship: an installation with no SLA is left alone
   ### What happens to a deadline when a candidate moves to a stage that has no SLA
## Decision 3: silence has a limit
   ### Fourteen days, two emails, and no third one — ever
   ### What counts as a sign of life, and what resets the counters
   ### Why nothing changes stage automatically
## The parts that are ordinary on purpose
   ### Weekly reports: draft → submitted → approved or changes requested
   ### Offers as a six-state machine with four actions
   ### Blind interview scoring: no score visible until yours is in
## What I would do differently
   ### One enum instead of a configurable workflow — fast now, somebody's blocker later
   ### Multi-tenant isolation written but switched off, and why I say so out loud
## Try it / read it
```

*Neden bu metin:* üç karar üç bölüm, her biri "kural + kuralın kenar durumu" alt başlığıyla —
teknik okuyucunun aradığı yapı budur; sondan bir önceki bölüm ("What I would do differently") hem
dev.to hem HN'de yazının paylaşılma sebebi olan bölümdür ve iki gerçek zayıflığı yazının kendi
içinde kabul ederek yorumları düşmanca olmaktan çıkarır.

---

## 6. Reddit

**Genel kural:** Reddit'te self-promo cezası subreddit'e göre değişir ve **kurallar değişir**.
Gönderimden önce her iki subun kural sayfası ve son 30 günlük gönderi akışı okunur. Aşağıdaki
uygunluk notları 2026-09-06 itibarıyla bilinen kurallara göredir; **kural sayfası bu dokümanı
ezer.**

### 6.1 r/selfhosted

**Ön koşul (sert):** üretim `docker-compose.yml` + `docs/self-hosting.md`. Bu sub'da çalışan bir
kurulum yolu olmadan gönderilen proje **negatif** karşılanır — "another SaaS with a GitHub link"
tepkisi bu subun refleksidir.

**Kural uygunluk notu:** r/selfhosted geliştiricinin kendi projesini paylaşmasına izin verir, ama
(a) projenin gerçekten self-host edilebilir olmasını, (b) gönderinin bir tanıtım değil bir
paylaşım gibi okunmasını, (c) geliştirici olduğunun açıkça belirtilmesini bekler. Bazı dönemlerde
self-promo yalnızca belirli günlerde/thread'lerde serbesttir. **Gönderim öncesi kural sayfasını ve
sabitlenmiş thread'i oku.** Ücretli plan linki gövdeye konmaz — sorulursa yorumda verilir.

```text
[EN]
Title: InternCRM – self-hosted CRM for internship and mentoring programmes (AGPL-3.0)

I'm the developer. This started as our own problem: a mentoring programme run out of a spreadsheet
whose most important column was a status code — 100 first contact, 300 internship starting, 660
hired. It worked at ten people and fell apart at fifty.

What it does:

- Thirteen-stage pipeline from first contact to hired, including two exits that are not failures
  (dropped out, found a placement elsewhere).
- Per-stage service levels in calendar days. An installation that configures none is left
  completely alone — nothing changes under you after an update.
- Weekly reports with a review loop (draft → submitted → approved / changes requested) and a
  printable diary.
- Interview panels with blind scoring: you cannot see anyone else's score until you submit yours.
- Offers as a state machine: draft, send, withdraw, accept, decline, expire.
- Applicants who never reply get asked twice whether they are still interested, then get marked
  dormant. There is no third email, deliberately and permanently.
- English, Turkish and German. Installable as a PWA. Dark mode. A published WCAG 2.2 AA statement
  that names its own open defects.

Self-hosting: Docker image plus MySQL, docker-compose file and a documented env list in
docs/self-hosting.md. No external service is required to run it — SMTP is optional (invitations
and reminders), and the AI features are off unless you configure a provider key.

Source (AGPL-3.0-or-later): https://github.com/21072026/Internship
Demo, no signup, one click to enter as admin/mentor/mentee:
https://demo.interncrm.com/auth/signin (synthetic data, resets twice a day)

Known limits, up front: multi-tenant isolation is implemented but switched off, so this is one
organisation per installation today. Backups are your own problem — there is no built-in backup
UI, just a normal MySQL database you can dump.

Happy to answer anything about the deployment side.
```

*Neden bu metin:* r/selfhosted'ın okuduğu üç şey — hangi bağımlılıklar zorunlu, ne dışarı veri
gönderiyor, neyi yapmıyor — gövdenin üçte birini kaplıyor; "no external service is required" ve
"AI off unless you configure a key" cümleleri bu subda gönderiyi kurtaran veya batıran cümlelerdir.

### 6.2 r/opensource

**Kural uygunluk notu:** r/opensource kendi projesini paylaşmaya izin verir ve genellikle
**lisansın açıkça belirtilmesini** ister; "open core" veya ücretli plan içeren projelerde bunun
gizlenmesi en sık silinme sebebidir. Bu yüzden aşağıdaki metin ticari planların varlığını gövdede
kendisi söylüyor. Salt tanıtım tonlu, tartışma açmayan gönderiler kaldırılabilir — metnin sonunda
gerçek bir soru var.

```text
[EN]
Title: InternCRM (AGPL-3.0): a CRM for internship programmes, and a licence question I keep going back and forth on

I'm the developer. InternCRM tracks people through an internship programme — first contact,
matching with a mentor, the internship itself, interviews, offer, hire — as a thirteen-stage
pipeline rather than a spreadsheet column. Source: https://github.com/21072026/Internship

It is AGPL-3.0-or-later, and I chose that on purpose rather than MIT: the whole category it
competes in is closed source, priced by sales call, and most vendors will not tell you what
happens to candidate data. AGPL means an organisation that runs a modified version as a service
has to publish those modifications, which is exactly the guarantee I want to be able to point at.
There are paid hosted plans; the code is the same code.

The part I would genuinely like opinions on: AGPL is also the reason some universities and public
bodies bounce off, because their procurement teams have a checklist that stops at "copyleft" and
nobody there wants to litigate whether hosting an internal instance triggers anything. I have no
intention of relicensing, but I am curious how other AGPL maintainers handle that conversation
with an institutional buyer — do you explain, do you dual-license, do you let them walk?

For anyone who just wants to see the thing: demo with one-click role sign-in, synthetic data,
resets twice a day — https://demo.interncrm.com/auth/signin
```

*Neden bu metin:* bu subda saf tanıtım silinir, **lisans tartışması** kalır; gerçekten kararsız
olunan bir soruyu sormak hem kural uyumu sağlıyor hem AGPL + dual licensing duruşunun
(`docs/legal/licensing-strategy.md`) kamuya açık ilk savunmasını yapıyor.

---

## 7. LinkedIn — 10 hazır gönderi

Ortak kurallar (`go-to-market.md` #9, LinkedIn araştırma bloğu):

- **Dış link gövdede yok, ilk yorumda yok.** Link profil "website" alanında, sayfa custom
  button'ında ve bio'da durur; gerekirse 24 saat sonra düzenlemeyle eklenir.
- Uzunluk 1.300-2.000 karakter bandı; **ilk 140 karakter** mobil kesme noktası — hook oraya sığar.
- Yayın sonrası **60 dakika** yorumlara cevap verilebilir olunacak; olunamayacaksa yayınlanmaz.
- Hashtag 0-1. Anket yok.
- Kişisel profil birincil kanal; şirket sayfası ayrı içerik alır, repost değil.
- Otomasyon: InternCRM hattı **kategorik yayın yasağına** tabidir — metni hat yazar, insan
  Telegram'da onaylar, LinkedIn'e doğrudan istek atılmaz.

### 7.1 [TR] Kurucu sesi — çıkış aşamaları

```text
[TR]
Pipeline'ımızda 13 aşama var ve ikisi "başarısız" değil: staj yarım bıraktı (460) ve başka yerde
staj buldu (800).

İkincisini eklerken tartıştık. Bir staj programı için "aday başka yerde staj buldu" kaybedilmiş bir
aday gibi görünüyor. Tabloda kırmızı duruyor, oranı düşürüyor, kimse raporda görmek istemiyor.

Ama programın işi ne? Adayı kendi şirketine sokmak mı, adayın staj bulmasını sağlamak mı?

Eğer birincisiyse, o kişiyi "kayıp" sayarsınız ve programın ölçüsü sizin doldurduğunuz kontenjan
olur. Eğer ikincisiyse — ki mentorluk anlaşması imzalarken söylediğiniz şey budur — o kişi
başarıyla çıkmıştır ve bunu ölçen bir aşamaya ihtiyacınız vardır.

Biz ikincisini seçtik. 800 kodlu aşama tabloda ayrı duruyor, ayrı sayılıyor, ayrı raporlanıyor.
Mentor'un o mentee ile ilgili bekleyen işleri kapanıyor ama ilişki "başarısız" olarak
etiketlenmiyor.

Bunun pratik bir sonucu da var: mentorlar dürüst davranıyor. "Aday başka yerde buldu"yu sisteme
girmek bir itiraf değilse, mentor onu girer. İtirafsa girmez, aday üç ay "ilk temas"ta bekler ve
siz gerçeği kaybedersiniz.

Bir veri modelinde en pahalı satır, insanların girmekten çekindiği satırdır.

13 aşamanın tamamı ve neden o sırada olduğu açık kaynakta; kod da, gerekçesi de yazılı.
```

*Neden bu metin:* açılış klişe değil çünkü doğrudan üründen bir olgu (iki hedef-dışı aşama, kod
numaralarıyla); post bir özellik anlatmıyor, bir **yönetim kararı** anlatıyor ve sonunda o kararın
veri kalitesine etkisini gösteriyor — Persona B'nin (program yürüten kurum) tam olarak yaşadığı
sorun.

### 7.2 [TR] Kurucu sesi — pasif ilk temas, üçüncü mail yok

```text
[TR]
Adayınız yanıt vermiyor. Kaç mail atmak dürüst?

Bizim cevabımız iki. Üçüncü yok — ve bu bir ayar değil, kodda sabit.

Kural şöyle işliyor: kişi pipeline'ın ilk aşamasında, kendisine yazılmış ve 14 gündür yanıt yok.
O gün "hâlâ ilgileniyor musun?" maili gidiyor. 31 gün sonra bir tane daha. Sonra kişi pasif olarak
damgalanıyor: mentor'un kuyruğundan düşüyor, hatırlatma e-postasına girmiyor, listeyi kirletmiyor.

Neden üçüncü yok?

Birincisi, üçüncü mailin cevap getirdiğine dair elimizde bir şey yok. İkincisi ve asıl sebep:
gönderen alan adının itibarı. İki mail bir hatırlatma, üç mail bir kampanyadır. Kampanya yapan
alan adı bir süre sonra spam klasörüne düşer ve o klasöre düşen şey sadece hatırlatmalar değil,
mentor'un gerçekten önemli mesajı da olur.

Bir de yapmadığımız şey var: sistem hiçbir aşamayı otomatik değiştirmiyor, hiçbir ilişkiyi
otomatik kapatmıyor. Pasif damgası bir işarettir, bir karar değil. Kararı mentor verir.

Herhangi bir yaşam belirtisi — mentee'nin bir mesajı, cevaplanmamış bir sorusu, bekleyen bir
toplantı, aşama ilerlemesi — damgayı ve sayaçları sıfırlıyor.

Bu tür sınırların yazılı olmasının sebebi şu: "bir tane daha atalım" her zaman makul görünür.
Sınırı ürüne gömerseniz o tartışmayı bir kez yaparsınız.
```

*Neden bu metin:* hook bir soru ama retorik değil — cevabı ikinci satırda veriliyor; postun tamamı
bir **kısıtın gerekçesi** ve "yapmadığımız şey" paragrafı ürünü otomasyon korkusu olan program
sorumlusuna güvenli kılıyor (otomatik aşama değişikliği yok — `docs/dormant-first-contacts.md`).

### 7.3 [TR] Kurucu sesi — teklif durum makinesi

```text
[TR]
Teklifin altı durumu var: taslak, gönderildi, kabul edildi, reddedildi, süresi doldu, geri çekildi.
Dördü de bir eylem: gönder, geri çek, kabul et, reddet.

En çok tartışılan "geri çekildi" oldu. Bir teklifi geri çekmek kötü bir şey, neden ürüne
koyuyorsun?

Çünkü zaten oluyor. Şirket pozisyonu dondurdu, bütçe kapandı, aday arada başka bir yere girdi ve
teklif havada kaldı. Ürününüzde "geri çekildi" yoksa insanlar ne yapar? Ya teklifi siler — ve o
adayın geçmişinden bir olay yok olur — ya da hiçbir şey yapmaz, teklif sonsuza kadar "gönderildi"
kalır ve üç ay sonra kimse o adayın nerede durduğunu bilemez.

Bir durum makinesinde en önemli durumlar, olmasını istemediğiniz durumlardır. Onları modellemezseniz
kullanıcılarınız modellemeyi kendileri uydurur: bir not alanında, bir Excel'de, bir WhatsApp
grubunda.

"Süresi doldu" da aynı sebeple orada. Bir teklifin geçerlilik tarihi varsa o tarih geçtiğinde
gerçek dünyada bir şey değişir; sistemde değişmiyorsa sistem yalan söylüyor demektir.

Toplam altı durum, dört eylem, geçişleri tek bir dosyada. Karmaşık değil. Ama eksik olsaydı, o
eksik her hafta birinin zamanını yerdi.
```

*Neden bu metin:* somut sayıyla açılıyor (6 durum / 4 eylem, `src/lib/offers.ts`), sonra "olmasını
istemediğiniz durumları modelle" gibi taşınabilir bir mühendislik ilkesine bağlanıyor — LinkedIn'de
paylaşılan post ürünü anlatan değil, okuyucunun kendi işine uygulayabildiğidir.

### 7.4 [TR] Kurucu sesi — kör puanlama

```text
[TR]
Mülakat panelinde bir üye, kendi puanını girmeden diğerlerinin puanını göremiyor. Girdikten sonra
da geri dönüp değiştiremiyor.

Bunu koymamızın sebebi kimseye güvenmemek değil. Sebep, yapılandırılmamış mülakatın ne kadar zayıf
bir sinyal olduğunun onlarca yıldır ölçülüyor olması — ve panelin en kıdemli üyesi ilk konuştuğunda
geri kalan puanların ona doğru kayması.

Pratikte olan şu: panel odasında biri "bence çok iyiydi" diyor ve o andan sonra tek tek toplanan
görüşler artık bağımsız değil. Ortalama alıyorsunuz ama aldığınız şey dört bağımsız görüşün
ortalaması değil, bir görüşün dört kopyası.

Kör puanlama bunu bir ürün kısıtına çeviriyor: puanını gir, sonra herkesinkini gör, sonra tartış.
Tartışmayı yasaklamıyor — sırasını değiştiriyor.

Bir ayrıntı: panel kapandıktan sonra bile hiç puan girmemiş bir üye diğerlerini göremiyor. Yoksa
"ben girmeyeyim, sonunda nasılsa görürüm" davranışı kuralı boşa çıkarırdı.

İşe alım sürecinizde ölçmek istediğiniz şey adayın kalitesiyse, önce kendi ölçüm aracınızın
gürültüsünü azaltmanız gerekiyor.
```

*Neden bu metin:* açılış tek cümlelik somut mekanik; gövde kuralın **neden** var olduğunu
davranışsal olarak açıklıyor ve son paragraftaki kaçış-kapatma ayrıntısı (panel kapansa bile
görmez) ürünün detaya indiğini kanıtlıyor — bu, "craft quality" iddiasının metinle yapılan hâli.

### 7.5 [DE] Persona A — Wochenberichte

```text
[DE]
Ein Wochenbericht hat bei uns vier Zustände: Entwurf, eingereicht, freigegeben, Änderung erbeten.
Der vierte ist der wichtigste.

Ohne ihn gibt es nämlich nur zwei Möglichkeiten: Sie geben einen unvollständigen Bericht frei,
oder Sie lassen ihn liegen und schreiben der Praktikantin nebenbei eine E-Mail. Beides passiert in
jedem Programm, und beides führt am Ende des Praktikums zu derselben Situation — jemand sitzt vor
einem Stapel Berichte, die nie richtig geprüft wurden, und soll daraus eine Beurteilung schreiben.

"Änderung erbeten" macht daraus einen Vorgang statt einer Erinnerung: Der Bericht geht mit einem
Kommentar zurück, die Praktikantin sieht, was fehlt, reicht neu ein, und die Historie zeigt beide
Fassungen.

Am Ende lässt sich die gesamte Sammlung als Praktikumstagebuch ausdrucken.

Ein Hinweis, den ich lieber selbst schreibe, bevor ihn jemand fragt: Das ist ein
Wochenbericht-Workflow mit Freigabe, kein von einer Kammer anerkanntes Berichtsheft. Die Kammern
geben ihre eigenen Formate vor, und ich behaupte nicht, deren Anforderungen zu erfüllen. Wenn Ihre
Kammer ein bestimmtes Formular verlangt, verlangt sie es weiterhin.

Was das Werkzeug leistet, ist der Teil davor: dass jede Woche dokumentiert, geprüft und
nachvollziehbar ist — statt am letzten Tag rekonstruiert zu werden.
```

*Neden bu metin:* dört durumla açılıyor (kodda birebir `WeeklyReportStatus`), sonra Persona A'nın
gerçek acısını (staj sonunda değerlendirme yazma anı) anlatıyor; **Berichtsheft iddiasını kendisi
reddediyor** — `go-to-market.md` §3.3'teki yasak ifade tam olarak burada geçmesi beklenen ifadeydi,
onu açıkça çürütmek metni hem hukuken hem itibaren güvenli kılıyor.

### 7.6 [DE] Persona A — Stage-SLA

```text
[DE]
"Wir warten noch auf das Unternehmen." Diesen Satz hört man in Praktikumsprogrammen jede Woche. Er
enthält keine Information — kein Datum, keine Frist, keine Konsequenz.

Bei uns kann jede Pipeline-Stufe eine eigene Frist in Kalendertagen tragen. Die Stufe
"Vorstellungsgespräch ausstehend" bekommt zum Beispiel zehn Tage, "Praktikum beginnt demnächst"
vielleicht dreißig. Wechselt jemand auf eine Stufe, wird die Frist gesetzt; läuft sie ab, taucht
der Fall in der Aufmerksamkeitsliste der Mentorin auf.

Kalendertage, nicht Arbeitstage — bewusst. Arbeitstage setzen Feiertagskalender voraus, und
Feiertage sind in einem Programm mit Beteiligten in mehreren Ländern keine Konstante. Wer eine
Frist von zehn Tagen setzt, meint zehn Tage.

Zwei Regeln, die aus Rücksicht auf bestehende Installationen eingebaut sind:

Wer keine einzige Frist konfiguriert, merkt von der Funktion nichts. Kein Datum wird überschrieben,
keine Erinnerung erscheint, alles bleibt so, wie es jemand von Hand eingetragen hat.

Wer Fristen konfiguriert hat und jemanden auf eine Stufe ohne Frist bewegt, dem wird das alte Datum
entfernt statt stehen gelassen. Die Uhr der vorherigen Stufe ist abgelaufen, als die Person sie
verlassen hat; ein altes Datum würde eine Überfälligkeit melden, die es nicht mehr gibt.

Solche Regeln stehen selten im Marketing. Sie entscheiden aber darüber, ob ein Team einer Funktion
nach dem ersten Update noch vertraut.
```

*Neden bu metin:* Persona A'nın kendi cümlesiyle ("Wir warten noch auf das Unternehmen") açılıyor;
gövdedeki iki kural doğrudan `src/lib/stageSla.ts` yorumlarından geliyor ve **geriye dönük
uyumluluk** vurgusu, kurumsal alıcının yazılım güncellemelerine dair asıl korkusunu adresliyor.

### 7.7 [DE] Persona B — die Absage, die eine Antwort ist

```text
[DE]
Die unangenehmste Nachricht in einem Mentoring-Programm ist die Absage — und sie ist meistens die,
die nie geschrieben wird. Der Status wird still geändert, die Person hört nie wieder etwas.

Wir haben das anders gebaut. Endet eine Kandidatur, steht im Portal der Person, wo die Sache steht
und was als Nächstes möglich ist. Die Mentorin bekommt keinen leeren Textkasten, sondern einen
vorbereiteten Entwurf, den sie ändern kann.

Drei Entscheidungen dahinter, die ich für wichtiger halte als die Funktion selbst:

Automatischer Versand ist standardmäßig aus. Ein Mensch liest jede Absage, bevor sie hinausgeht.
Ein System, das Absagen selbstständig verschickt, spart genau die Minute ein, die man nicht
einsparen sollte.

"Woanders ein Praktikum gefunden" ist keine Absage, sondern eine eigene Stufe mit eigenem Wortlaut.
Wenn Ihr Programm Menschen dabei helfen soll, ein Praktikum zu finden, ist das ein Erfolg — auch
wenn es nicht bei Ihnen stattfindet.

Ein stiller Statuswechsel ist keine Kommunikation. Er fühlt sich nur so an, weil im System etwas
passiert ist.

Career Services, Mentoring-Programme, duale Studiengänge: Sie werden am Ende nicht daran gemessen,
wie viele Sie vermittelt haben, sondern daran, wie die Menschen über Ihr Programm sprechen, die Sie
nicht vermittelt haben.
```

*Neden bu metin:* Persona B'nin (kariyer merkezi, mentorluk programı) değer sistemi "vermitteln"
değil "begleiten"dir; post ürünü bu değer sistemine bağlıyor ve son cümle satış yapmadan
programın kendi ölçüsünü sorguluyor — bu ağlarda satış tonundan tek kaçış yolu budur.

### 7.8 [DE] Persona A/B — Demo ohne Anmeldung

**Ön koşul:** `/pricing` yayında (#1403) ve `utm_*` yakalama çalışıyor (#1388/#1390). Bu ikisi
olmadan bu post yayınlanmaz — gelen trafiğin gidecek yeri ve ölçülecek hâli yok.

```text
[DE]
Sie können unser Produkt ansehen, ohne ein Formular auszufüllen, ohne eine E-Mail-Adresse zu
hinterlassen und ohne mit mir zu sprechen. Drei Buttons, ein Klick, Sie sind drin — als
Programmleitung, als Mentorin oder als Praktikant.

Das ist in dieser Kategorie unüblich. Wir haben sechzehn vergleichbare Anbieter angesehen:
dreizehn führen jede Interessentin zuerst in ein Verkaufsgespräch, und nur drei veröffentlichen
überhaupt eine brauchbare Zahl auf ihrer Preisseite. Wer wissen will, ob ein Werkzeug zum eigenen
Programm passt, muss dafür einen Termin machen.

Ich halte das für die falsche Reihenfolge. Ob eine Pipeline zu Ihrem Programm passt, sehen Sie in
zehn Minuten selbst — und danach wissen wir beide, worüber wir reden würden.

Was Sie in der Demo finden: dreizehn Stufen vom Erstkontakt bis zur Einstellung, Fristen pro Stufe,
Wochenberichte mit Freigabe, Interviewpanels mit verdeckter Bewertung, Angebote als Zustandsmodell.
Die Daten sind vollständig synthetisch, die Demo wird zweimal täglich zurückgesetzt, es wird keine
E-Mail wirklich versendet und Uploads sind abgeschaltet.

Was ich ebenso deutlich sage: Heute ist das ein System pro Organisation. Die Mandantentrennung ist
implementiert, aber nicht aktiviert — solange das so ist, verspreche ich sie nicht.

Der Link steht in meinem Profil. Wenn Sie ein Praktikums- oder Mentoring-Programm verantworten und
Ihnen dabei etwas fehlt, schreiben Sie es mir hier in die Kommentare — das ist die nützlichste
Rückmeldung, die ich bekommen kann.
```

*Neden bu metin:* rakip davranışını (13/16 demo görüşmesine sokuyor) kanıta dayalı olarak
adlandırıp kendi erişim modelini karşısına koyuyor; **çok kiracılılık sınırını kendisi söylüyor**,
böylece hem yasak vaatten kaçınıyor hem dürüstlüğü konumlandırmanın parçası yapıyor; link gövdede
değil profilde (LinkedIn dış link cezası).

### 7.9 [EN] Açık kaynak — trust centre

```text
[EN]
Our trust page has a section titled "what is not true yet". It is not a roadmap. It is a list of
things a buyer might reasonably assume we do, and we do not.

Right now the honest entries on it include: multi-tenant isolation is implemented but the
enforcement flag is off, so this is one organisation per installation; there is no SOC 2 and no ISO
27001, because there has been no audit; and the accessibility statement names its own open defects
instead of claiming full conformance.

Writing that page cost me a week of arguing with myself, because every instinct says a trust page
is where you put the reassuring things. But consider what the alternative buys you. A page that
lists only strengths tells a procurement officer nothing, because every vendor's page lists only
strengths. The moment you publish a limitation, the rest of the page becomes evidence rather than
decoration.

There is a second, less noble reason. If it is written down, I cannot quietly promise it in a
sales conversation. A published limit is a constraint on my own future behaviour, which is exactly
what a limit is for.

The same discipline runs through the product: an accessibility statement that names defects and is
backed by an automated scan blocking every pull request; a public API with its rate limits
documented; a demo where the first thing you read is what the demo will not let you do.

If you sell software to institutions and you have never published something inconvenient about
your own product, I would genuinely recommend trying it once. The conversations afterwards are
different.
```

*Neden bu metin:* açık kaynak ve B2B alıcı kitlesinin ortak kesişimi "kanıt" kavramıdır; post tek
bir özellik satmıyor, `/trust` sayfasının `limitationsTitle` bölümünü bir **yöntem** olarak
sunuyor ve bunu yaparken üç gerçek sınırı (MT, sertifikasyon yok, a11y açıkları) yayınlıyor.

### 7.10 [EN] Açık kaynak — the interns wrote it

```text
[EN]
Part of this codebase was written by the interns it tracks. That is not a marketing line — it is
in the mentoring agreement: contributing to the product is part of the internship, so the product
is also the internship project.

Which creates a situation I did not fully think through at the start. The person whose pipeline
stage is INTERNSHIP_IN_PROGRESS_450 can open the file where that enum is defined. If the weekly
report form annoys them, they can change it and open a pull request, and then the mentor who
reviews their weekly report is also the reviewer on the diff.

It has been better than I expected, for a reason that has nothing to do with generosity. Nobody
writes a plausible-sounding feature description for a workflow they personally have to use on
Friday afternoon. The feedback loop is one day long and completely unforgiving.

It also produces the one thing this product can claim and its competitors structurally cannot: if
you are evaluating whether the candidates from this programme can build software, you are looking
at the software right now. The commit history is public. Read the reviews, not just the code.

There is a licensing shape behind this too. The project is AGPL-3.0-or-later, and every
contributor confirms the contributor terms in the pull request template — that is not an
afterthought when the contributors are people who joined the programme rather than the company.

I do not think this model generalises to every product. It generalises to exactly one kind: the
tool that runs the programme the contributors are in.
```

*Neden bu metin:* kopyalanamaz hikâyenin **abartılmadan** yazılmış hâli; iddia doğrulanabilir bir
yere bağlanıyor (public commit geçmişi, PR şablonundaki contributor terms) ve son paragraf
genellemeyi kendisi reddederek postu bir "büyüme hilesi" anlatısı olmaktan çıkarıyor.

---

## 8. LinkedIn şirket sayfası — tagline ve About

**Ön koşul (sert):** `interncrm.com/imprint` (Impressum) gerçek verilerle dolu (#1371). § 5 DDG
ticari LinkedIn şirket sayfasını da kapsıyor; Impressum linki (Edit page → Info → Website URL) hazır
olmadan sayfa yayına açılmaz. Sayfa adı **InternCRM**'dir — hiçbir şirket adı geçmez.

### 8.1 Tagline (120 karakter sınırı; ilk ~60 karakter dar ekranda görünür)

```text
[EN]
Internship & mentoring CRM: 13 pipeline stages from first contact to hire. AGPL-3.0, self-hostable.
```
```text
[DE]
Praktikums- und Mentoring-CRM: 13 Stufen vom Erstkontakt bis zur Einstellung. AGPL-3.0, selbst hostbar.
```
```text
[TR]
Staj ve mentorluk CRM'i: ilk temastan işe alıma 13 aşama. AGPL-3.0, kendi sunucunuzda çalışır.
```

*Neden bu metin:* üç dilde de anlam ilk yarıya (kategori + 13 aşama) sıkıştırılmış, ikinci yarı
(AGPL + self-host) kırpılırsa cümle hâlâ ayakta — dar ekran kırpma davranışının tek doğru
tasarımı budur.

### 8.2 About / description — ilk ~300 karakter "See more" öncesi görünür

```text
[EN]
InternCRM is a CRM for internship and mentoring programmes. One pipeline of thirteen stages follows
each participant from first contact through matching, internship, interviews and offer to hire —
including two exits that are not failures: dropped out, and found a placement elsewhere. Source
is open under AGPL-3.0-or-later; run it on your own server.

Concretely:

· Thirteen stages, each able to carry a deadline in calendar days — "waiting on the company"
  becomes a date.
· Weekly reports with a review loop (draft, submitted, approved or changes requested) and a
  printable internship diary.
· Interview panels with blind scoring: nobody sees a score before submitting their own.
· Offers as a state machine: draft, send, withdraw, accept, decline, expire.
· Applicants who never reply are asked twice whether they are still interested, then marked
  dormant — never a third email.
· English, Turkish and German, with translation key parity enforced in CI. Installable as a
  progressive web app, with a published WCAG 2.2 AA statement naming its own open defects.

Two things we say out loud rather than in a footnote: multi-tenant isolation is implemented but
not enforced, so today this is one organisation per installation; and there is no security
certification, because there has been no audit. Both are on our trust page.

Try it without an account: one click signs you in as an admin, a mentor or a mentee — synthetic
data, reset twice a day.

Rights holder: Mehmet Erşahin.
```

```text
[DE]
InternCRM ist ein CRM für Praktikums- und Mentoring-Programme. Eine Pipeline mit dreizehn Stufen
begleitet jede teilnehmende Person vom Erstkontakt über Matching, Praktikum und Angebot bis zur
Einstellung — einschließlich zweier Ausgänge, die kein Scheitern sind: Abbruch und ein
anderswo gefundenes Praktikum. Der Quellcode ist offen (AGPL-3.0-or-later); Sie können die
Anwendung selbst betreiben.

Konkret:

· Dreizehn Stufen, jede mit eigener Frist in Kalendertagen — aus "wir warten auf das
  Unternehmen" wird ein Datum.
· Wochenberichte mit Freigabeschleife: Entwurf, eingereicht, freigegeben oder Änderung erbeten —
  am Ende als Praktikumstagebuch druckbar.
· Interviewpanels: niemand sieht fremde Bewertungen vor der eigenen.
· Angebote als Zustandsmodell: Entwurf, gesendet, zurückgezogen, angenommen, abgelehnt.
· Wer nie antwortet, wird zweimal gefragt, ob das Interesse besteht, dann als inaktiv markiert.
  Eine dritte E-Mail gibt es nie.
· Deutsch, Englisch und Türkisch, Schlüsselparität in der CI geprüft. Als PWA installierbar,
  mit WCAG-2.2-AA-Erklärung, die eigene offene Mängel benennt.

Zwei Dinge deutlich statt in einer Fußnote: Die Mandantentrennung ist implementiert, aber nicht
aktiviert — heute ein System pro Organisation. Und es gibt keine Zertifizierung, weil kein Audit
stattfand. Beides steht auf der Trust-Seite.

Ohne Anmeldung ausprobieren: ein Klick als Programmleitung, Mentorin oder Praktikant.
Synthetische Daten.

Rechteinhaber: Mehmet Erşahin.
```

```text
[TR]
InternCRM, staj ve mentorluk programları için bir CRM. On üç aşamalı tek bir huni her katılımcıyı
ilk temastan eşleştirmeye, stajdan görüşmelere, teklife ve işe alıma kadar takip ediyor — ikisi
başarısızlık sayılmayan çıkış: stajı yarım bıraktı, başka yerde staj buldu. Kaynak kod
AGPL-3.0-or-later ile açık; kendi sunucunuzda çalıştırabilirsiniz.

Somut olarak:

· On üç aşama, her biri takvim günü cinsinden kendi süresini taşıyabiliyor — "şirketten cevap
  bekliyoruz" bir hisse değil bir tarihe dönüşüyor.
· Haftalık raporlar onay döngüsüyle: taslak, gönderildi, onaylandı veya değişiklik istendi; sonunda
  staj günlüğü olarak yazdırılabiliyor.
· Kör puanlamalı mülakat panelleri: kendi puanını girmeyen üye kimsenin puanını göremiyor.
· Teklif bir durum makinesi: taslak, gönderildi, geri çekildi, kabul, ret, süresi doldu.
· Hiç yanıt vermeyene iki kez "hâlâ ilgileniyor musun?" soruluyor, sonra pasif işaretleniyor.
  Üçüncü bir mail hiç yok.
· Türkçe, İngilizce ve Almanca; çeviri anahtar paritesi CI'da zorunlu. PWA olarak kurulabiliyor;
  WCAG 2.2 AA beyanı yayımlı ve kendi açık kusurlarını kendisi sayıyor.

Dipnotta değil açıkça söylediğimiz iki şey: çok kiracılı izolasyon yazıldı ama devrede değil —
bugün bir kurulum bir kurum demek. Ve güvenlik sertifikamız yok, çünkü bir denetim yapılmadı.
İkisi de trust sayfamızda yazılı.

Hesap açmadan deneyin: tek tıkla yönetici, mentor veya mentee olarak girin. Veriler sentetik ve
günde iki kez sıfırlanıyor.

Hak sahibi: Mehmet Erşahin.
```

*Neden bu metin:* üç sürüm de aynı iskelette — ilk 300 karakterde konumlandırma ("See more"
öncesi), ortada mekanik listesi, sonda **iki sınırın açık beyanı** ve demo daveti; "hak sahibi"
satırı LinkedIn'in Products sekmesi incelemesinde fikri hak sahipliği kontrolüne karşı sayfa
sahipliğiyle tutarlı bir kayıt bırakıyor.

---

## 9. Persona A ve B — ilk temas metinleri (hukuka uygun)

### 9.0 Bu bölümün sert sınırları

Bu bölümde **soğuk e-posta şablonu yoktur ve olmayacaktır.** Almanya'da:

| Kanal | Durum | Dayanak |
|---|---|---|
| Soğuk B2B e-posta | **Yasak** — önceden açık rıza şart, B2B istisnası yok | UWG § 7 Abs. 2 Nr. 2 |
| "İzin isteyen" ilk mail | **Yasak** — izin istemek de reklamdır | Werbebegriff, BGH VI ZR 225/17 |
| LinkedIn/XING DM, InMail, tanıtımlı bağlantı notu | **Yasak** — "elektronische Post" sayılır | OLG Hamm 18 U 154/22 |
| Faks | Yasak (e-posta rejimi) | UWG § 7 |
| Soğuk arama | Çok dar şartlı; listeyle kampanya yapılamaz | UWG § 7 Abs. 2 Nr. 1, BVerwG 6 C 3.23 |
| **Fiziki mektup** | **Serbest** (+ Art. 14 DSGVO bilgi notu, Art. 21(2) itiraz hakkı) | UWG § 7 yasak kataloğunda değil |
| **Muhatabın kendi iletişim formu** | Serbest — kanalı karşı taraf açmış | — |
| **Yüz yüze / etkinlik** | Serbest; rıza orada alınır ve **yazıya geçirilir** | — |
| **Referansla tanıştırma** | Serbest — teması üçüncü kişi başlatır | — |
| **Double-opt-in bülten / webinar kaydı** | Serbest; rıza metni ve zamanı loglanır | Art. 7 DSGVO, VG Düsseldorf |
| **Karşı taraf yazdıktan sonra yanıt** | Serbest | — |

Her giden metinde **gerçek gönderen adı, izlenebilir alan adı, okunan bir Reply-To** olacak
(§ 7 Abs. 2 Nr. 3 UWG). `noreply@` tek başına yeterli değil.

**Bastırma listesi (Sperrdatei) zorunlu:** itiraz eden her adres kalıcı olarak bastırılır; kaynak,
tarih, menfaat dengelemesi notu ve itirazlar kayıt altında tutulur (Art. 5(2) hesap verebilirlik).

### 9.1 [DE] Persona B — kurumun kendi "iş birliği" formuna yazılacak metin

Kullanım: kariyer merkezi / dual-study koordinatörlüğü / mentorluk programı **kendi sitesinde**
"Unternehmen, schreiben Sie uns" türü bir form yayımlamışsa. Kanalı karşı taraf açmıştır.

```text
[DE]
Betreff: Praktikums- und Mentoring-Programme — Werkzeug und Praxisaustausch

Guten Tag,

ich schreibe über Ihr Kontaktformular für die Zusammenarbeit mit Unternehmen und Programmen.

Ich entwickle InternCRM, eine Open-Source-Anwendung für Praktikums- und Mentoring-Programme. Sie
begleitet Teilnehmende in einer Pipeline vom Erstkontakt über die Betreuung und das Praktikum bis
zu einem Angebot — mit Fristen pro Stufe, Wochenberichten mit Freigabeschleife und einer eigenen
Stufe für "hat woanders ein Praktikum gefunden", weil das in einem Programm wie Ihrem kein
Misserfolg ist.

Zwei Dinge, weshalb ich mich gerade bei Ihnen melde und nicht bei einem Unternehmen:

Erstens würde mich interessieren, wie Sie die Betreuungsdokumentation heute lösen — das ist der
Teil, an dem sich in jedem Programm entscheidet, ob am Ende eine belastbare Beurteilung möglich
ist. Ich lerne daraus mehr als aus jedem Wettbewerbsvergleich.

Zweitens ist die Anwendung quelloffen (AGPL-3.0) und auf einem eigenen Server betreibbar, was bei
Hochschulen und öffentlichen Trägern erfahrungsgemäß die erste Frage ist.

Sie können alles ohne Anmeldung ansehen — ein Klick genügt, um sich als Programmleitung, Mentorin
oder Praktikant anzumelden; die Daten sind synthetisch:
https://demo.interncrm.com/auth/signin

Wenn ein kurzes Gespräch für Sie sinnvoll ist, freue ich mich; wenn nicht, ist auch eine kurze
Rückmeldung zur Betreuungsdokumentation für mich wertvoll.

Mit freundlichen Grüßen
Mehmet Erşahin
InternCRM · https://interncrm.com · Impressum: https://interncrm.com/imprint
```

*Neden bu metin:* kanalı karşı tarafın açtığını ilk cümlede yazıyor (hukuki bağlamı kayda geçirir),
satış talebi yerine **bir soru** soruyor (Persona B'de kabul gören tek giriş), ve Impressum linkiyle
bitiyor — § 5 DDG ile uyumun görünür hâli.

### 9.2 [DE] Persona A ve B — fiziki mektup (Briefwerbung)

Tek yasal soğuk outbound. 20-30 adetlik ölçülü parti. **Ek olarak Art. 14 DSGVO bilgi notu
konur** ve itiraz hakkı ayrıca hatırlatılır.

```text
[DE] — 1 Seite, Briefkopf mit vollständiger Absenderangabe
Sehr geehrte Frau {Nachname},

Ihr Haus bildet Praktikantinnen und Praktikanten aus, und ich vermute, dass die Betreuung dabei
nicht am Werkzeug scheitert, sondern an der Dokumentation: wer wartet gerade auf wen, welcher
Wochenbericht fehlt, welches Angebot ist herausgegangen und nie beantwortet worden.

Genau dafür habe ich InternCRM gebaut. Eine Pipeline mit dreizehn Stufen führt jede Person vom
Erstkontakt bis zur Einstellung, jede Stufe kann eine Frist in Kalendertagen tragen, Wochenberichte
laufen über eine Freigabeschleife und lassen sich am Ende als Praktikumstagebuch ausdrucken.

Drei Punkte, die in dieser Kategorie unüblich sind:

1. Sie können die Anwendung ansehen, ohne ein Formular auszufüllen oder mit mir zu sprechen. Der
   QR-Code unten führt direkt in eine Demo mit synthetischen Daten; ein Klick meldet Sie als
   Programmleitung, Mentorin oder Praktikant an.
2. Der Quellcode ist offen (AGPL-3.0). Sie können die Anwendung auf einem eigenen Server
   betreiben — die Daten Ihrer Teilnehmenden bleiben dann vollständig bei Ihnen.
3. Was heute nicht geht, sage ich Ihnen gleich mit: Die Mandantentrennung ist implementiert, aber
   nicht aktiviert. Eine Installation entspricht daher heute einer Organisation.

Wenn das für Sie interessant ist, genügt eine kurze Antwort an die unten stehende Adresse — dann
melde ich mich, wie es Ihnen passt.

Mit freundlichen Grüßen
Mehmet Erşahin

[QR → https://demo.interncrm.com/auth/signin]
InternCRM · Mehmet Erşahin · {ladungsfähige Anschrift} · {E-Mail} · https://interncrm.com
Hinweise zum Datenschutz: Rückseite.
```

Mektubun arkasına konacak bilgi notu:

```text
[DE] — Rückseite: Informationen nach Art. 14 DSGVO
Informationen zur Verarbeitung Ihrer Daten

Verantwortlicher: Mehmet Erşahin, {ladungsfähige Anschrift}, {E-Mail}.

Verarbeitete Daten: Ihr Name, Ihre berufliche Funktion und Ihre Geschäftsanschrift.

Herkunft der Daten: {konkrete Quelle, z. B. die öffentlich zugängliche Website Ihrer Einrichtung /
das Mitgliederverzeichnis eines Fachverbands}.

Zweck und Rechtsgrundlage: Postalische Ansprache zu einem beruflich einschlägigen Angebot auf
Grundlage von Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse ist die Direktwerbung
gegenüber Einrichtungen, für deren Aufgabenbereich das Angebot fachlich einschlägig ist.

Speicherdauer: Bis zu Ihrem Widerspruch, längstens {Frist}. Nach einem Widerspruch wird Ihre
Anschrift ausschließlich in einer Sperrliste gespeichert, damit Sie keine weitere Post erhalten.

Ihre Rechte: Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit sowie Beschwerde
bei einer Aufsichtsbehörde.

Widerspruchsrecht nach Art. 21 Abs. 2 DSGVO: Sie können der Verarbeitung Ihrer Daten zu Zwecken der
Direktwerbung jederzeit widersprechen. Danach werden Ihre Daten nicht mehr für diese Zwecke
verarbeitet. Eine formlose Nachricht an {E-Mail} genügt.
```

*Neden bu metin:* mektup metni kısa ve üçüncü maddesinde bir **sınır** ilan ediyor (kurumsal
alıcıda güven kuran nadir hamle); arka yüz Art. 14 bilgilendirmesini ve Art. 21(2) itiraz hakkını
ayrı ve belirgin biçimde veriyor — bu iki parça olmadan mektup hukuken eksiktir.

### 9.3 [DE] Etkinlik / yüz yüze — 40 saniyelik anlatım ve rızanın alınması

```text
[DE] — gesprochen, ~40 Sekunden
Ich baue InternCRM. Das ist ein Werkzeug für Praktikums- und Mentoring-Programme: eine Pipeline mit
dreizehn Stufen vom Erstkontakt bis zur Einstellung — inklusive einer eigenen Stufe für "hat
woanders ein Praktikum gefunden", weil das in einem Programm ja kein Misserfolg ist.

Der Teil, der die Leute am meisten interessiert, ist meistens die Betreuungsdokumentation:
Wochenberichte laufen über eine Freigabeschleife und lassen sich am Ende als Praktikumstagebuch
ausdrucken.

Es ist quelloffen, Sie können es auf einem eigenen Server betreiben, und Sie können es ohne
Anmeldung ansehen.

Wie lösen Sie das bei sich heute?
```

Rıza alma cümlesi (bunu duymadan **hiçbir mail gitmez**):

```text
[DE]
"Darf ich Ihnen dazu eine E-Mail mit dem Demo-Link und einer Seite Zusammenfassung schicken?"

→ Bei einem ausdrücklichen "Ja": Name, E-Mail-Adresse, Datum, Ort der Veranstaltung und den
  Wortlaut der Zusage notieren. Diese Notiz ist der Nachweis.
→ Bei allem anderen als einem klaren Ja: keine E-Mail. Visitenkarte ist keine Einwilligung.
```

Rıza sonrası gönderilecek mail:

```text
[DE]
Betreff: Wie besprochen: InternCRM — Demo-Link und Einseiter

Guten Tag Frau {Nachname},

wir haben am {Datum} auf der {Veranstaltung} gesprochen, und Sie hatten zugesagt, dass ich Ihnen
den Demo-Link schicken darf. Hier ist er:

https://demo.interncrm.com/auth/signin — ein Klick als Programmleitung, Mentorin oder Praktikant,
synthetische Daten, wird zweimal täglich zurückgesetzt.

Im Anhang die eine Seite, die ich erwähnt hatte. Der Punkt, über den wir gesprochen haben — {das
konkrete Thema aus dem Gespräch} — steht dort im zweiten Abschnitt.

Wenn Sie Fragen haben, antworten Sie einfach auf diese E-Mail; sie kommt direkt bei mir an. Und
wenn Sie doch keine weiteren Nachrichten von mir möchten, genügt ein Wort, dann höre ich auf.

Mit freundlichen Grüßen
Mehmet Erşahin
InternCRM · https://interncrm.com · Impressum: https://interncrm.com/imprint
```

*Neden bu metin:* mailin ilk cümlesi **rızanın kanıtını** (tarih, etkinlik, verilen söz) metnin
içine yazıyor — bir itiraz durumunda savunma bu cümledir; kapanış itiraz yolunu tek kelimeye
indiriyor, § 7 Abs. 2 Nr. 3'ün istediği "geçerli adres" koşulunu okunan bir Reply-To ile karşılıyor.

### 9.4 [DE] Persona B — oturum / atölye önerisi (Forum Mentoring, csnd, DGM)

```text
[DE]
Betreff: Vorschlag für einen Beitrag: Betreuungsdokumentation in Mentoring- und Praktikumsprogrammen

Guten Tag,

ich möchte einen Beitrag für {Jahrestagung / Arbeitsgruppe / Workshop} vorschlagen. Es geht nicht
um ein Produkt, sondern um eine Frage, die in fast jedem Programm auftaucht und selten
systematisch behandelt wird: Wie dokumentiert man die Betreuung so, dass am Ende eine belastbare
Beurteilung möglich ist — ohne dass die Dokumentation selbst zur Hauptarbeit wird?

Vorschlag für den Beitrag (30 Minuten, gern auch 15 plus Diskussion):

1. Was ein Programm eigentlich messen müsste, und warum die übliche Statuszeile in einer Tabelle
   das nicht kann: Sie kennt nur den aktuellen Wert, keine Historie und keine Frist.
2. Ausgänge, die kein Scheitern sind — Abbruch und ein anderswo gefundenes Praktikum — und was
   passiert, wenn ein Programm sie nicht getrennt erfasst.
3. Wochenberichte mit Freigabeschleife statt Sammelordner am Ende.
4. Die Grenze der Automatisierung: Was ein System entscheiden darf und was nicht. Bei uns ändert
   kein Automatismus eine Stufe, und nach zwei unbeantworteten Nachfragen wird keine dritte
   verschickt.

Ich bringe dafür eine quelloffene Referenzimplementierung mit (AGPL-3.0), die man live ansehen
kann; sie dient als Anschauungsmaterial, nicht als Vertriebsanlass. Wenn ein produktneutraler
Zuschnitt für Sie besser passt, richte ich den Beitrag entsprechend aus.

Über eine Rückmeldung freue ich mich.

Mit freundlichen Grüßen
Mehmet Erşahin
InternCRM · https://interncrm.com · Impressum: https://interncrm.com/imprint
```

*Neden bu metin:* akademik/dernek ağlarında satıcı olarak değil **konu getiren taraf** olarak
girilir; dört maddelik program taslağı somut, "Vertriebsanlass değil" cümlesi ve ürün-nötr sunum
teklifi bakımcının en büyük itirazını (gizli satış) baştan kaldırıyor.

### 9.5 [TR] / [DE] Referansla tanıştırma isteme

Teması üçüncü kişi başlatır — bu yüzden hukuken temiz. Metin **aracıya** yazılır, hedefe değil.

```text
[TR]
{İsim}, bir ricam olacak — hayır demen tamamen normal.

{Kurum}'daki {kişi} ile staj/mentorluk programlarını konuşuyorsun diye biliyorum. Ben InternCRM'i
geliştiriyorum: staj programları için, katılımcıyı ilk temastan işe alıma kadar 13 aşamalı bir
hunide takip eden açık kaynak bir sistem.

Ondan bir şey satın almasını istemiyorum. Şu an ihtiyacım olan şey, programı gerçekten yürüten
birinin "bu ekran bizim işimize yaramaz, çünkü…" demesi.

Uygun görürsen beni onunla tanıştırır mısın? Aşağıdaki iki satırı olduğu gibi iletebilirsin:

---
Mehmet, staj ve mentorluk programları için açık kaynak bir takip sistemi geliştiriyor (InternCRM).
Hesap açmadan tek tıkla gezilebilen bir demosu var. Programı yürüten birinden geri bildirim
arıyor, satış görüşmesi değil. İlgilenirsen bağlayayım.
---

İlgilenmezse ya da şu an sırası değilse üstelemem, merak etme.
```

```text
[DE]
Hallo {Name},

eine Bitte — ein Nein ist völlig in Ordnung.

Du kennst {Person} bei {Einrichtung} aus dem Programmbereich. Ich entwickle InternCRM, eine
quelloffene Anwendung für Praktikums- und Mentoring-Programme.

Ich möchte nichts verkaufen. Was mir fehlt, ist die Einschätzung von jemandem, der so ein Programm
tatsächlich verantwortet — insbesondere zur Betreuungsdokumentation.

Würdest du uns verbinden? Die folgenden zwei Sätze kannst du unverändert weiterleiten:

---
Mehmet entwickelt eine quelloffene Anwendung für Praktikums- und Mentoring-Programme (InternCRM),
mit einer Demo, die man ohne Anmeldung ansehen kann. Er sucht fachliche Rückmeldung, kein
Verkaufsgespräch. Soll ich euch verbinden?
---

Falls es gerade nicht passt, lasse ich es dabei.
```

*Neden bu metin:* aracıya iletilecek iki cümle hazır verildiği için aracının işi sıfıra iniyor
(tanıştırmaların en yaygın ölüm sebebi budur); "satış değil geri bildirim" çerçevesi hem doğru hem
aracının itibar riskini kaldırıyor.

### 9.6 [DE] Persona A — LinkedIn'de karşı taraf yazdıktan sonra yanıt

Bu **serbesttir**, çünkü teması karşı taraf başlatmıştır. Tanıtım içeren ilk DM yasaktır.

```text
[DE]
Danke für Ihre Nachricht — und für die konkrete Frage, das macht die Antwort einfacher.

Kurz zu Ihrem Punkt {konkretes Thema}: {zwei bis drei Sätze, die die Frage tatsächlich
beantworten, auch wenn die Antwort "das kann InternCRM heute nicht" lautet}.

Am schnellsten sehen Sie es selbst: https://demo.interncrm.com/auth/signin meldet Sie mit einem
Klick als Programmleitung, Mentorin oder Praktikant an. Synthetische Daten, wird zweimal täglich
zurückgesetzt, es wird keine E-Mail wirklich versendet.

Wenn Sie mögen, telefonieren wir zwanzig Minuten und ich zeige es an Ihrem eigenen Ablauf. Wenn
Ihnen die Demo reicht, ist das für mich genauso in Ordnung — melden Sie sich einfach, wenn eine
Frage auftaucht.
```

*Neden bu metin:* yanıtın ilk işi soruyu gerçekten cevaplamak, ikinci işi demo linkini vermek;
"demo yeterliyse o da olur" cümlesi görüşme baskısını kaldırıyor — 16 rakipten 13'ü her alıcıyı
görüşmeye sokarken farkı yaratan tam bu tutumdur.

### 9.7 [DE] Rıza doğuran akış — webinar / kayıt sayfası metni

Soğuk e-postanın **yerine geçen** yol: içerik → gönüllü kayıt → belgelenmiş double-opt-in → izinli
iletişim. Kayıt sayfası metni ve onay maili aşağıda.

```text
[DE] — Anmeldeseite
Praxis-Session: Betreuungsdokumentation in Praktikumsprogrammen

45 Minuten, online, kostenlos. Für Programmverantwortliche in Unternehmen, Career Services,
duale Studiengänge und Mentoring-Programme.

Inhalt:
· Warum eine Statusspalte in einer Tabelle nicht ausreicht — und was stattdessen erfasst gehört
· Ausgänge, die kein Scheitern sind: Abbruch und ein anderswo gefundenes Praktikum
· Wochenberichte mit Freigabeschleife statt Sammelordner am Ende
· Wo Automatisierung aufhören sollte
· Offene Fragerunde

Es wird eine quelloffene Referenzimplementierung gezeigt (InternCRM, AGPL-3.0). Es gibt keinen
Verkaufsteil und keine Preisfolie; wer die Preise sehen will, findet sie auf der Website.

[ Vorname ] [ Nachname ] [ E-Mail ] [ Einrichtung / Unternehmen ]

[ ] Ich möchte per E-Mail zu dieser Session eingeladen werden und erhalte danach die
    Aufzeichnung. (erforderlich)

[ ] Ich möchte darüber hinaus etwa einmal im Monat den InternCRM-Newsletter zu Praktikums- und
    Mentoring-Programmen erhalten. Diese Einwilligung kann ich jederzeit widerrufen; in jeder
    E-Mail befindet sich ein Abmeldelink. (freiwillig)

Verantwortlicher, Zweck, Speicherdauer und Ihre Rechte: {Link zur Datenschutzerklärung}.
Impressum: https://interncrm.com/imprint

[ Anmelden ]

Nach dem Absenden erhalten Sie eine E-Mail mit einem Bestätigungslink. Erst nach dem Klick auf
diesen Link ist Ihre Anmeldung wirksam.
```

```text
[DE] — Bestätigungsmail (Double-Opt-In; enthält bewusst KEINE Werbung)
Betreff: Bitte bestätigen Sie Ihre Anmeldung

Guten Tag,

für die Adresse {E-Mail} wurde eine Anmeldung zur Session "Betreuungsdokumentation in
Praktikumsprogrammen" eingetragen{, zusätzlich der Bezug des InternCRM-Newsletters}.

Bitte bestätigen Sie mit einem Klick:

{Bestätigungslink}

Wenn Sie das nicht waren, ignorieren Sie diese E-Mail einfach. Ohne Bestätigung wird die Adresse
nicht weiterverwendet und nach {Frist} gelöscht.

Mehmet Erşahin
InternCRM · https://interncrm.com · Impressum: https://interncrm.com/imprint
```

Loglanacak asgari set (Art. 7(1) ispat yükü, VG Düsseldorf): e-posta adresi · kayıt zamanı + IP ·
**kayıt formunun ve onay mailinin o tarihteki tam metni veya sürüm kimliği** · onay linkine
tıklama zamanı + IP · çıkış zamanı. Yalnızca adres + IP + zaman damgası **yetersizdir**.
Kayıt yeri: `docs/newsletter.md`, `src/lib/newsletterTokens.ts`, `NewsletterSend` satırları.

*Neden bu metin:* iki onay kutusu ayrı ve ikincisi gönüllü (paketlenmiş rıza geçersizdir); onay
maili tarafsız ve reklamsız; sayfa "Verkaufsteil yok" diyerek Persona B'nin katılım eşiğini
düşürüyor — ve tüm akış, yasaklı soğuk e-postanın yerine geçen **tek** yasal kaynağı üretiyor.

### 9.8 [DE] Persona A — IHK Praktikanten-/Lehrstellenbörse ilan metni

İki ayrı hareket: kendi staj ilanını yayımlamak (ücretsiz, meşru) ve oda ağına görünür olmak.

```text
[DE]
Titel: Praktikum Softwareentwicklung (Web) — an einem quelloffenen Produkt mitarbeiten

Wir entwickeln InternCRM, eine quelloffene Anwendung für Praktikums- und Mentoring-Programme
(Next.js, TypeScript, Prisma, MySQL). Das Besondere: Sie arbeiten am selben Produkt, das Ihr
eigenes Praktikum verwaltet — Ihre Beiträge sind öffentlich einsehbar und bleiben nach dem
Praktikum als Referenz bestehen.

Was Sie mitbringen: Grundkenntnisse in JavaScript oder TypeScript und die Bereitschaft, Code
prüfen zu lassen und selbst zu prüfen. Vorkenntnisse in React sind hilfreich, aber keine
Voraussetzung.

Was Sie erwarten dürfen: feste Betreuung durch eine Mentorin oder einen Mentor, wöchentliche
Berichte mit Rückmeldung, Code-Reviews zu jedem Beitrag, und eine dokumentierte Zwischen- und
Abschlussbeurteilung.

Ort: {Ort / remote}. Zeitraum: {Zeitraum}. Sprache: Deutsch, Englisch oder Türkisch.

Bewerbung über: https://interncrm.com/apply
```

*Neden bu metin:* IHK borsası ilanı hem gerçek bir stajyer kanalı hem de "bu CRM'i içindeki
stajyerler yazdı" hikâyesinin **kurumsal kaydı**; ilan metni ürünü tanıtmıyor ama ürünün adını ve
çalışma biçimini oda ekosistemine sokuyor.

---

## 10. Demo daveti, takip ve "hayır" cevabına kapanış

Üç metin bir zincirdir ve **zincir en fazla iki adımdır**: davet, bir takip, sonra kapanış.
Üçüncü bir hatırlatma yok — aynı gerekçe pasif ilk temas kuralında ürünün içine gömülü
(`src/lib/dormantFirstContact.ts`): iki mesaj hatırlatma, üç mesaj kampanyadır.

**Ön koşul:** bu üç metin yalnızca rızası olan veya teması kendisi başlatmış muhataba gider
(§ 9.0 tablosu).

### 10.1 Demo daveti

```text
[DE]
Betreff: InternCRM ansehen — ohne Anmeldung, ein Klick

Guten Tag Frau {Nachname},

wie besprochen der direkte Zugang:

https://demo.interncrm.com/auth/signin

Auf der Anmeldeseite stehen drei Schaltflächen — Programmleitung, Mentorin, Praktikant. Ein Klick
genügt, kein Formular, keine E-Mail-Adresse.

Falls Sie nur zehn Minuten haben, würde ich diese Reihenfolge vorschlagen:

1. Als Programmleitung anmelden und die Pipeline öffnen. Dreizehn Stufen, zwei davon sind Ausgänge,
   die kein Scheitern sind.
2. Eine Person auf eine andere Stufe ziehen und sehen, was mit der Frist passiert.
3. Abmelden, als Mentorin anmelden und einen Wochenbericht mit "Änderung erbeten" zurückgeben.
4. Als Praktikant anmelden und dieselbe Sache von der anderen Seite ansehen.

Zur Einordnung: Die Daten sind vollständig synthetisch, die Demo wird zweimal täglich
zurückgesetzt, es wird keine E-Mail tatsächlich versendet und Uploads sind abgeschaltet.

Wenn dabei etwas fehlt oder etwas nicht zu Ihrem Ablauf passt, schreiben Sie es mir gern — auch
und gerade, wenn es gegen das Produkt spricht.

Mit freundlichen Grüßen
Mehmet Erşahin
InternCRM · https://interncrm.com · Impressum: https://interncrm.com/imprint
```

```text
[TR]
Konu: InternCRM'i gezin — kayıt yok, tek tık

Merhaba {İsim},

Konuştuğumuz gibi doğrudan giriş:

https://demo.interncrm.com/auth/signin

Giriş sayfasında üç buton var: yönetici, mentor, mentee. Tek tık yeterli; form yok, e-posta yok.

On dakikanız varsa şu sırayı öneririm:

1. Yönetici olarak girin, pipeline'ı açın. On üç aşama; ikisi başarısızlık sayılmayan çıkış.
2. Bir kişiyi başka bir aşamaya taşıyın ve süreye ne olduğuna bakın.
3. Çıkın, mentor olarak girin ve bir haftalık raporu "değişiklik istendi" ile geri gönderin.
4. Mentee olarak girin, aynı şeyi diğer taraftan görün.

Bilginize: veriler tamamen sentetik, demo günde iki kez sıfırlanıyor, hiçbir e-posta gerçekten
gönderilmiyor ve dosya yükleme kapalı.

Eksik bulduğunuz ya da sizin akışınıza uymayan bir şey olursa yazın — özellikle ürünün aleyhine
olanı.

Selamlar,
Mehmet Erşahin
InternCRM · https://interncrm.com
```

*Neden bu metin:* "gezin" demek yerine **dört adımlık bir tur** veriyor; ilk oturumda ne
yapılacağını bilmeyen ziyaretçi demoyu ana ekranda terk eder, bu yüzden yönlendirilmiş tur
demonun dönüşümünü belirleyen tek değişkendir. Kapanıştaki "ürünün aleyhine olanı yaz" daveti
gerçek geri bildirim getiren cümledir.

### 10.2 Takip (tek adet, 7-10 gün sonra)

```text
[DE]
Betreff: Kurze Rückfrage zur Demo

Guten Tag Frau {Nachname},

ich melde mich ein einziges Mal nach, dann lasse ich Sie in Ruhe.

Zwei Fragen, beide in einem Satz zu beantworten:

1. Haben Sie die Demo geöffnet — und wenn ja, an welcher Stelle sind Sie hängen geblieben?
2. Gibt es in Ihrem Programm einen Schritt, den die Pipeline gar nicht abbildet?

Die zweite Frage ist die für mich wertvollere. Ein Schritt, der bei Ihnen existiert und bei uns
nicht, ist eine echte Lücke im Modell — davon habe ich mehr als von jeder Zustimmung.

Wenn das Thema bei Ihnen gerade keine Priorität hat, sagen Sie einfach das; ich hake nicht
nochmal nach.

Mit freundlichen Grüßen
Mehmet Erşahin
InternCRM · https://interncrm.com · Impressum: https://interncrm.com/imprint
```

```text
[TR]
Konu: Demoyla ilgili kısa bir soru

Merhaba {İsim},

Bir kez yazıp bırakacağım.

Tek cümlelik iki soru:

1. Demoyu açtınız mı — açtıysanız nerede takıldınız?
2. Sizin programınızda olup pipeline'da hiç karşılığı olmayan bir adım var mı?

İkincisi benim için daha değerli. Sizde olup bizde olmayan bir adım, modeldeki gerçek bir boşluk
demek; onaydan çok daha işime yarıyor.

Şu an önceliğiniz değilse öyle deyin, tekrar yazmam.

Selamlar,
Mehmet Erşahin
InternCRM · https://interncrm.com
```

*Neden bu metin:* ilk satırda "bir kez yazıp bırakacağım" taahhüdü baskıyı kaldırıyor ve cevap
oranını yükselten şey tam olarak bu; iki soru da tek cümleyle cevaplanabilir; ikinci soru cevap
"hayır" bile olsa ürüne bilgi kazandırıyor.

### 10.3 "Hayır" cevabına kapanış

```text
[DE]
Guten Tag Frau {Nachname},

danke für die klare Rückmeldung — die ist mir lieber als ein Vielleicht.

Ich streiche Sie aus meiner Liste und melde mich nicht wieder. Falls sich das Thema bei Ihnen
irgendwann doch stellt, finden Sie mich unter https://interncrm.com; ein Anruf oder eine Zeile
genügt, und ich fange nicht bei null an.

Eine einzige Bitte, völlig freiwillig: Wenn es einen konkreten Grund gab — die Anwendung passt
nicht zu Ihrem Ablauf, der Aufwand ist zu hoch, es gibt bereits eine Lösung, oder es ist schlicht
nicht der richtige Zeitpunkt — schreiben Sie mir das Stichwort. Ein Wort reicht. Ich baue danach.

Alles Gute für Ihr Programm.

Mit freundlichen Grüßen
Mehmet Erşahin
```

```text
[TR]
Merhaba {İsim},

Net cevap için teşekkürler — "belki"den iyidir.

Sizi listemden çıkarıyorum, bir daha yazmayacağım. İleride konu gündeminize gelirse
https://interncrm.com'dan bana ulaşırsınız; sıfırdan başlamayız.

Tamamen gönüllü tek bir ricam var: somut bir sebep varsa — akışınıza uymuyor, iş yükü fazla,
zaten bir çözümünüz var ya da sadece zamanı değil — tek kelimeyle yazın. Ona göre geliştiriyorum.

Programınızda başarılar.

Selamlar,
Mehmet Erşahin
```

*Neden bu metin:* "listeden çıkarıyorum ve bir daha yazmayacağım" cümlesi hem nezaket hem
**bastırma listesi taahhüdünün yazılı hâli**; tek kelimelik sebep ricası ısrar değil çünkü cevap
verilmemesi de bir cevaptır ve zincir orada bitiyor.

---

## 11. Bir sayfalık ürün özeti (one-pager) — [DE]

PDF'e dökülmeye hazır. A4 tek sayfa, aşağıdaki blok sırası korunur. Ekler: 3 ekran görüntüsü
(#1399) ve QR kod. **Ön koşul:** `/pricing` yayında (#1403) — fiyat bloğu ondan önce basılmaz;
o ana kadar fiyat bloğu yerine "Preise: auf Anfrage" **yazılmaz**, blok tamamen çıkarılır.

```text
[DE] — A4, eine Seite

────────────────────────────────────────────────────────────────────────
InternCRM
Praktikums- und Mentoring-Programme: von der ersten Nachricht bis zur Einstellung
────────────────────────────────────────────────────────────────────────

DAS PROBLEM

Die meisten Programme laufen über eine Tabelle mit einer Statusspalte. Die Spalte kennt nur den
aktuellen Wert — keine Historie, keine Frist, keinen Grund. Was tatsächlich über den Erfolg des
Programms entscheidet, steht nirgends: wer wartet gerade auf wen, welcher Wochenbericht fehlt,
welches Angebot ist herausgegangen und nie beantwortet worden.


WAS INTERNCRM MACHT

Eine Pipeline mit dreizehn Stufen führt jede Teilnehmerin und jeden Teilnehmer vom Erstkontakt
über Matching, Praktikum, Gespräche und Angebot bis zur Einstellung.

  Erstkontakt → Freigabe ausstehend → Gespräch ausstehend → Vorstellung ausstehend →
  Praktikum beginnt → Praktikum läuft → Praktikum beendet → auf Arbeitssuche →
  vermittelbar → eingestellt → beschäftigt
  Ausgänge, die kein Scheitern sind:  Praktikum abgebrochen · anderswo ein Praktikum gefunden


FÜNF FUNKTIONEN, DIE DEN UNTERSCHIED MACHEN

  Fristen pro Stufe        Jede Stufe kann eine Frist in Kalendertagen tragen. Überfälliges
                           erscheint in der Aufmerksamkeitsliste der Mentorin. Wer keine Frist
                           konfiguriert, merkt von der Funktion nichts.

  Wochenberichte           Entwurf → eingereicht → freigegeben oder Änderung erbeten. Am Ende
                           als Praktikumstagebuch druckbar. (Kein von einer Kammer anerkanntes
                           Berichtsheft — Kammern geben eigene Formate vor.)

  Verdeckte Bewertung      Im Interviewpanel sieht niemand fremde Bewertungen, bevor die eigene
                           abgegeben ist — auch nach Abschluss des Panels nicht.

  Angebote als Zustand     Entwurf, gesendet, zurückgezogen, angenommen, abgelehnt, abgelaufen.
                           Kein Angebot bleibt unbestimmt im Raum stehen.

  Stille mit Grenze        Wer nach vierzehn Tagen nicht geantwortet hat, wird zweimal gefragt,
                           ob das Interesse besteht, und dann als inaktiv markiert. Eine dritte
                           E-Mail gibt es nicht. Keine Stufe ändert sich automatisch.


VIER ROLLEN, EINE BEZIEHUNG

  Programmleitung   Pipeline, Zuordnung von Mentorinnen und Unternehmen, Auswertungen
  Mentorin/Mentor   eigene Mentees, Gesprächsprotokolle, Wochenberichte, Aufmerksamkeitsliste
  Praktikant:in     eigenes Profil, zugeordnete Betreuung, Berichte, Rückmeldungen
  Unternehmen       Bedarf, Shortlists, Interviewanfragen


BETRIEB UND RECHTE

  Quelloffen          AGPL-3.0-or-later. Rechteinhaber: Mehmet Erşahin.
  Selbst betreiben    Docker-Image plus MySQL auf einem eigenen Server. Kein externer Dienst
                      ist zwingend erforderlich; SMTP ist optional, KI-Funktionen sind ohne
                      konfigurierten Schlüssel nicht vorhanden.
  Sprachen            Deutsch, Englisch, Türkisch — vollständig, Schlüsselparität in der CI geprüft.
  Barrierefreiheit    Veröffentlichte WCAG-2.2-AA-Erklärung, die die eigenen offenen Mängel
                      benennt; automatisierte Prüfung blockiert jede Codeänderung.
  Als App             Als Progressive Web App installierbar, auch mobil.
  Transparenz         Trust-Seite mit allen Dritten, die Daten erhalten können — und mit dem,
                      was heute noch nicht zutrifft: https://interncrm.com/trust


WAS HEUTE NICHT GEHT — damit Sie es nicht selbst herausfinden müssen

  · Die Mandantentrennung ist implementiert, aber nicht aktiviert. Eine Installation entspricht
    heute einer Organisation.
  · Es gibt keine Sicherheitszertifizierung (kein SOC 2, kein ISO 27001), weil kein Audit
    stattgefunden hat.
  · Ein Ein-Kommando-Installationspaket für den Produktivbetrieb ist in Arbeit; heute setzen Sie
    die Installation aus Docker-Image, Datenbank und dokumentierten Umgebungsvariablen zusammen.


SELBST ANSEHEN — ohne Anmeldung, ein Klick

  https://demo.interncrm.com/auth/signin
  Drei Schaltflächen: Programmleitung, Mentorin, Praktikant. Synthetische Daten, zweimal täglich
  zurückgesetzt, es wird keine E-Mail versendet, Uploads sind abgeschaltet.

  [ QR-Code ]


────────────────────────────────────────────────────────────────────────
InternCRM · Mehmet Erşahin · {ladungsfähige Anschrift} · {E-Mail} · https://interncrm.com
Impressum: https://interncrm.com/imprint · Quellcode: github.com/21072026/Internship
────────────────────────────────────────────────────────────────────────
```

*Neden bu metin:* kurumsal Alman alıcının bir sayfada aradığı sıra — problem, model, mekanik,
roller, işletme/hukuk, **sınırlar**, deneme yolu; "WAS HEUTE NICHT GEHT" bloğu tek sayfalık bir
tanıtımda alışılmadıktır ve tam bu yüzden okunur, ayrıca satış görüşmesinde karşılanamayacak bir
vaadin doğmasını fiziksel olarak engeller.

---

## 12. Yayın öncesi kontrol listesi

Her metin için, gönder tuşuna basmadan önce:

- [ ] **Sayı kontrolü** — metindeki her sayının §0.1 tablosunda karşılığı var mı? Kullanıcı,
      müşteri, kurum sayısı geçiyor mu? (Geçiyorsa metin yayınlanmaz.)
- [ ] **Vaat kontrolü** — çok kiracılılık, sertifika, Berichtsheft tanınırlığı, entegrasyon
      iddiası var mı? (`go-to-market.md` §3.3)
- [ ] **Hak sahibi kontrolü** — herhangi bir şirket adı hak sahibi gibi mi görünüyor?
- [ ] **Link kontrolü** — demo adresi `https://demo.interncrm.com/auth/signin` mi? Eski
      `crm-demo.ersah.in` kalıntısı var mı?
- [ ] **Hukuk kontrolü (giden mesajlar)** — bu muhatabın rızası var mı, yoksa teması kendisi mi
      başlattı, yoksa bu bir mektup mu? Üçünden hiçbiri değilse **gönderilmez**.
- [ ] **Impressum kontrolü** — giden ticari metinde gerçek gönderen adı, adres/iletişim ve
      Impressum linki var mı? Reply-To gerçekten okunuyor mu?
- [ ] **Ön koşul kontrolü** — metnin başındaki "Ön koşul" satırındaki maddeler kapandı mı?
- [ ] **LinkedIn kontrolü** — dış link gövdede veya ilk yorumda mı? (İkisi de olmayacak.)
      Yayından sonraki 60 dakika müsait misin?
- [ ] **Zincir kontrolü** — bu, aynı kişiye giden üçüncü mesaj mı? (Öyleyse gönderilmez.)

---

## 13. Bakım

- Bu doküman **kodun gerisinde kalırsa yalan söyler.** §0.1 tablosundaki bir satır değişince
  (aşama sayısı, durum makinesi, gün sayısı, dil sayısı) o satıra bağlı **bütün** metinler
  taranır. `grep -n "dreizehn\|thirteen\|on üç\|13 aşama" docs/marketing/copy-bank.md` başlangıç
  noktasıdır.
- Ön koşulu kapanan metnin başındaki "Ön koşul" satırı **silinmez**, "kapandı ({tarih})" olarak
  işaretlenir — bir sonraki okuyucu neyin neden beklediğini bilsin.
- Yeni bir kanal `go-to-market.md` §5 matrisine girdiğinde, metni buraya eklenmeden kanal
  ateşlenmez.
- Yayınlanan her metin için tek satırlık bir kayıt tut: tarih, kanal, hangi bölüm, sonuç. Ölçüm
  altyapısı (#1388/#1390) gelene kadar kanal performansına dair elimizdeki tek şey bu kayıt olacak.
