# Agent Experience Log

A running retrospective for AI agents (Claude Code) working in this repo. **Standing
convention: at the end of each session, append a short dated entry here** with the
concrete, reusable lessons you learned — environment quirks, tooling limits, process
gotchas — so the next session starts smarter. Keep tactical, fast-changing tips here;
promote anything that becomes a durable rule into `CLAUDE.md`.

Newest entries on top.

---

## 2026-08-06 — `origin/main` merge'ünde smoke false-positive'leri: `npm run dev` vs prod build

**`npm run test:e2e:smoke`'u yerelde çalıştırmak `npm run dev`'i başlatır, CI ise
`npm run start`'la prod build'e karşı koşar** (`playwright.config.ts`: `command:
process.env.CI ? 'npm run start' : 'npm run dev'`). Bu fark üç sahte kırmızıya yol açtı:
`auth.spec.ts`'teki `button[aria-haspopup="menu"]` locator'ı dev modunda enjekte edilen
"Next.js Dev Tools" düğmesiyle de eşleşip strict-mode ihlali veriyor (prod'da o düğme yok);
`pipeline.spec.ts` dev sunucusunun Fast Refresh rebuild'i tam da PUT isteği uçuşurken
tetiklenince isteği düşürüyor; `smoke.spec.ts`'teki `/admin/candidates` navigasyonu
on-demand derleme yüzünden 30s'yi aşıyor. Üçü de `CI=true npm run build && npm run
test:e2e:smoke` ile (prod build'e karşı) tekrar koşulunca temiz geçti — **merge'ün veya PR'ın
kendisiyle ilgisi yoktu.**

**Yerel `.env`'deki gerçek ama bu sandbox'tan erişilemeyen `SMTP_HOST`, e-posta gönderen her
akışı TCP timeout'una kadar (~20-30s) bloke ediyor.** `.github/workflows/e2e.yml`'de SMTP
secret'ları hiç tanımlı değil — `nodemailer.createTransport({host: undefined, ...})` orada
hızlı başarısız oluyor, yerelde ise `crm.ersah.in:465`'e gerçek bir bağlantı denemesi ETIMEDOUT
ile bitene kadar isteği bloke ediyor ve bu da `signInAndSettle`'daki `waitForLoadState
('networkidle')`'ı 30s timeout'a düşürüyor (`invite.spec.ts`, `mentee-signup.spec.ts`). Tanı
için `.env`'deki `SMTP_*` satırlarını geçici olarak yorum satırına aldım (dosya
`.gitignore`'da, commit'e girmiyor), koştum, sonra geri açtım.

**Ama hepsi bu değildi: `instant-meeting`, `pii-access-lifecycle`, `project-team-and-goals`,
`upcoming-meeting` (×2) SMTP kapalıyken de aynı 30-33s `networkidle` timeout'unda kırmızı
kaldı.** Trace ağ günlüğü giriş sonrası ~150ms içinde biten 80'den fazla istek gösteriyor,
sonra timeout'a kadar **hiçbir yeni istek yok** — yani tekrarlayan bir poll değil, muhtemelen
Playwright'ın `networkidle` sezgisiyle çakışan bir keep-alive/service-worker bağlantısı
(`/sw.js` her girişte kayıtlı). Bu 4-5 spec merge'ün dokunmadığı dosyalar ve merge'ün
dokunmadığı sayfaları test ediyor — üç ayrı koşuda tutarlı biçimde aynı testler kırmızı kaldı,
bu yüzden makine/ortam kaynaklı, PR'a özgü olmayan bir flake olarak işaretledim (CLAUDE.md'nin
"bilinen flake" listesine ikisi zaten kayıtlı; bu dördü/beşi de aynı kategoriye giriyor gibi
duruyor, ayrı bir issue'yu hak ediyor).

**Ders: bir smoke kırmızısını "PR'la ilgili mi" diye sınıflandırmadan önce, dosyanın merge/diff
kapsamında olup olmadığına bak, sonra prod build'e karşı tekrar koştur.** `npm run dev`'in
kendine özgü davranışları (HMR, Dev Tools düğmesi, on-demand derleme) CI'da hiç olmayan
kırmızılar üretebiliyor; gerçek sinyal her zaman prod build'e karşı koşan sonuç.

---

## 2026-08-03 — Yaklaşan toplantı banner'ı + "Katıl" pili (#51 devamı, 0.41.0-beta)

**`ResponsiveShell` header bileşenlerini İKİ kez render eder** — mobil üst bar ve
masaüstü şeridi. Yani oraya koyduğun her `data-testid` DOM'da iki düğüme çözülür ve
`getByTestId(...)` strict-mode ihlali verir; biri o viewport'ta `lg:hidden` ile
gizli olduğu için `.first()` de yetmez. Repodaki yerleşik çözüm:
`page.locator('[data-testid="x"]:visible').first()` (bkz. `messages-inbox.spec.ts`
mesaj ikonunu tam böyle buluyor). Kabuk header'ına yeni bir şey eklerken testi
baştan böyle yaz.

**Aynı cevabı isteyen iki bileşen tek poll paylaşmalı.** Banner (panelde) ve pil
(header'da) aynı anda mount oluyor; her biri kendi `setInterval`'ını kursa dakikada
iki istek olurdu. `src/hooks/useUpcomingMeeting.ts`'teki modül seviyesi store
(abone kümesi + tek timer) hem isteği tekilleştiriyor hem de sonradan mount olan
bileşene mevcut cevabı anında veriyor.

**Şemada bitiş saati yoksa "devam ediyor"u sen tanımlarsın.** `Meeting`'in süresi
yok; "hâlâ sürüyor" başlangıçtan sonra sabit bir pencere (`MEETING_DURATION_MINUTES`,
maintainer'ın onayıyla 60 dk) olarak tanımlandı. Böyle bir varsayımı sabit olarak
dışa aç ve yorumda kimin onayladığını yaz — sonraki oturum bunu tahmin etmesin.

---

## 2026-08-02 — #51'in kullanıcı geri bildirim turları (0.40.1/0.40.2-beta)

Aynı oturumda özellik canlıya gitmeden önce üç tur geri bildirim geldi; hepsi
"kod doğru ama davranış yanlış" cinsindendi.

**Bir e-posta göndericisi döngünün içindeyse kaç kez çağrıldığını say.**
`generateForSeries`, `sendMeetingInviteEmail`'i `tekrar × ilişki` döngüsünün
içinde çağırıyordu: 6 mentee × 7 hafta = tek tıkla 42 e-posta. Kod #774'ten beri
böyleydi ama UI olmadığı için kimse tetiklemiyordu — **var olan bir backend'e UI
eklemek, o backend'in maliyetini de senin devraldığın anlamına geliyor.** Ölçüt:
"bir kullanıcı eylemi kaç e-posta üretiyor?" sorusunu UI'ı yazmadan önce sor.

**İki cron aynı satırı hedefliyorsa çift bildirim gider.** Yeni proje-bazlı
hatırlatma ile mevcut ilişki-bazlı `sendMeetingReminders` aynı seri
`Meeting` satırlarını eşleştiriyordu; hem ilişkisi hem üyeliği olan kişi 1 saat
önce iki e-posta alıyordu. Yeni bir bildirim yolu eklerken **eski yolun aynı
kaydı görüp görmediğini** kontrol et (`seriesId: null` ile dışladım) — ve dışlama
yaptığında eski yolun kapsadığı kişileri yeni yolun da kapsadığından emin ol
(`loadProjectTeam`, yalnız `ProjectMember` değil).

**App shell'in dışındaki route mobilde başlıksız kalır.** `/projects/[id]` public
ziyaretçi okuyabilsin diye admin/mentor layout'unun dışında; sonuç: projeyi açınca
header tamamen kayboluyor, telefonda sidebar da olmadığı için ne başlık ne çıkış
yolu kalıyor. Layout dışına sayfa koyarken kendi bar'ını da koy.

**Responsive'i akıl yürütmeyle değil ekran görüntüsüyle doğrula — ama panelleri
bekle.** 390px'te `page.screenshot()` aldığımda client panelleri boş çıktı; dev
server route'u derlerken `networkidle` yetmiyor. `locator(...).waitFor()` ile
beklemek gerçek durumu gösterdi. Kalıcı kontrol için mekanik denetim yazdım
(yatay taşma yok + 120px altı metin alanı yok, açılır formlar açık halde):
`e2e/mobile-responsive.spec.ts`. 20 ekranlık süpürme temiz çıktı, yani sorun
uygulamanın genelinde değil tek bir kartta.

**`signInAsFreshUser` sonrası `page.goto` yerine `gotoSettled` kullan.**
Helper URL eşleşince dönüyor, landing push'u hâlâ uçuşta: "Navigation … is
interrupted by another navigation" alıyorsun. `helpers/auth.ts` bunu zaten
belgeliyor, yeni spec yazarken atlamak kolay.

**Bu container'da MariaDB uzun koşular arasında kendi kendine düşüyor.** Testte
"Can't reach database server at 127.0.0.1:3306" görünce ilk iş
`service mariadb start` — değişikliğini suçlamadan önce.

**Deploy beklemek için foreground `sleep` bloklu.** `until curl … | grep -q
'"sha":"<sha>'; do sleep 15; done` komutunu `run_in_background: true` ile başlat;
prod `/api/health` sha'yı flip ettiğinde bildirim geliyor.

---

## 2026-08-02 — Proje ekipleri, hedefler, katılma talepleri, davet/referans (#51, 0.40.0-beta)

**"Yanlış isim görünüyor" şikâyeti neredeyse hep iki kaynaklı veridir.** Proje kartı
"2 stajyer" derken üye panelinde 6 mentee vardı: sayı ve chip'ler `MentorshipRelation.projectId`
(eski yol) üzerinden, panel ise `ProjectMember` (#617'den beri kanonik tablo) üzerinden
okuyordu. Çözüm tek bir birleştirici (`src/lib/projectTeam.ts` → `mergeTeam`) ve *her*
tüketicinin ondan beslenmesi. Benzer bir uyumsuzluk görürsen önce "kaç tablo bu soruyu
cevaplıyor?" diye sor.

**"Alan yok" sanılan şey bazen sadece render edilmemiştir.** Haftalık toplantı için
`MeetingSeries` modeli + tam CRUD API'si #774'ten beri duruyordu; `grep -rln MeetingSeries src/`
tek dosya döndürdü: kendi route'u. Yeni özelliğe başlamadan bu grep'i yapmak, sıfırdan model
tasarlamakla mevcut backend'e GET + UI eklemek arasındaki farkı belirliyor.

**Görünürlük kuralı ile üyelik kuralı ayrı yerlerde yaşıyor.** `canViewProject()` yalnızca
sahiplik + `isPublic` bakıyordu, dolayısıyla projeye eklenmiş bir mentee kendi projesini
göremiyordu (özel projede 404). Üyelik bir okuma hakkıysa bunu üç yere birlikte eklemek gerekti:
route (`GET /api/projects/[id]`), rol kapsamı (`authzScope.ts` → MENTEE) ve sayfanın kendi
`canInternal` hesabı. Birini atlarsan sonuç sessizce tutarsız olur.

**Hatırlatmayı taşıyan satır yoksa hatırlatma da yoktur.** Proje toplantısını `Meeting`
satırlarına bağlamak işe yaramaz: proje üyelerinin çoğunun o projeye bağlı bir
`MentorshipRelation`'ı yok, `generateForSeries` de yalnızca ilişkili mentee'lere satır üretiyor.
Kuraldan (seri + occurrence) türeten ayrı bir cron ve idempotency için `(seriesId, occurrenceAt,
lead)` unique satırı gerekti — "önce claim et, sonra gönder" deseni `sendMeetingReminders`'tan
kopyalandı.

**`ensureReferralCode` dersi: retry'ı hata koduna bağla.** İlk sürüm her hatada 5 kez deneyip
"Could not allocate a referral code" atıyordu; e2e sırasında kullanıcı silindiği için P2025
alıyordu ve gerçek sebep kayboluyordu. Yalnızca P2002'de (gerçek çakışma) tekrar dene, P2025'te
null dön, geri kalanı olduğu gibi fırlat.

**Bu container'da iki pre-existing e2e hatası var** (temiz ağaçta `git stash` ile doğruladım,
değişiklikle ilgisi yok): `smoke.spec.ts:53` (`/admin` → next-auth `CLIENT_FETCH_ERROR`, in-flight
session fetch navigasyonla iptal ediliyor) ve `pipeline.spec.ts:8` (aşama değişimi 1800 ms
içinde persist etmiyor). Bir hatayı kendine yazmadan önce **stash'leyip baseline al** — 30
saniyelik iş, yanlış teşhisten çok daha ucuz.

**Playwright tarayıcı sürümü yine tutmadı.** Beklenen `chromium_headless_shell-1234`, kurulu olan
`-1194`. `playwright install` yerine dizin yapısını taklit eden symlink:
`mkdir -p /opt/pw-browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64 && ln -s
…-1194/chrome-linux/headless_shell …/chrome-headless-shell` (binary adı da farklı,
`headless_shell` → `chrome-headless-shell`).

**`seed:demo` `.env`'i okumuyor.** `npm run seed:demo` `DATABASE_URL` yoksa önce
"does not look local" der (yanıltıcı), sonra Prisma init hatası verir. `export DATABASE_URL=…
SEED_DEMO_FORCE=1` ile çalıştır.

**60 sn'lik test bütçesi tek başına geçip suite içinde patlar.** İki sign-in + beş navigasyon
içeren yeni spec tek başına ~50 sn, yüklü suite'te 60 sn'yi aştı. `test.slow()` (bütçeyi 3'e
katlar) doğru araç; timeout'u global olarak yükseltmek değil.

---

## 2026-07-31 — Inbound mail bridge (#974, 0.29.0/0.29.1-beta)

**"The email can't go out" was actually "the email arrives and nothing reads
it."** Before touching code, check the whole path on the server. Here MX,
catch-all, `Reply-To` generation and `/api/inbound-email` were all fine; the
missing piece was the mailbox reader, which `docs/EMAIL_DELIVERABILITY.md` had
been honestly flagging as "still required in infrastructure" all along. Read the
feature's own doc before assuming a bug.

**`docker run` in `infra/deploy-prod.sh` passes an explicit `-e` allowlist.**
Adding a key to `/etc/internship-crm/prod.env` is *not* enough — unlisted keys
never reach the container, silently. Any new runtime env var needs a line in that
`docker run` **and** in the env-derivation `for k in …` fallback above it (that
fallback rebuilds the env file from the running container, so a var missing there
gets dropped on some later deploy). Verify with
`docker exec internship-crm printenv | grep YOUR_VAR` after deploying.

**`instrumentation.ts` is compiled for the edge runtime too, because this repo
has `src/middleware.ts`.** A `process.env.NEXT_RUNTIME === 'nodejs'` guard does
not help: webpack still traces the import graph, so importing anything with
node-only deps (here `imapflow` → `net`/`tls`/`stream`) fails the build, and
`serverExternalPackages` does not apply to the edge bundle. Workaround used: keep
instrumentation dependency-free (`fetch` only) and have it call a node-runtime
route handler that does the socket work.

**Probing SMTP from `127.0.0.1` on the mail server proves nothing.** localhost is
in `mynetworks`, so `permit_mynetworks` accepts any recipient and you get a
misleading `250`. To learn whether an address is really deliverable, inspect the
maps instead — `postmap -q "@domain" hash:/var/spool/postfix/plesk/virtual`
reveals a catch-all, and `postconf recipient_delimiter` tells you whether
`user+ext@` collapses to `user@`.

**Plesk plus-addressing beats a catch-all, in that order.** With
`recipient_delimiter = +`, creating mailbox `reply@` captures every
`reply+<token>@` before the domain catch-all sees it — a clean way to divert
machine mail out of a personal inbox without touching the catch-all.

**Don't `rm` mail out of a Maildir behind dovecot's back.** It leaves a stale
index entry, so IMAP `search` returns a UID whose source won't fetch. It
self-heals on the next rescan, but it looks exactly like a bridge bug for a
minute. Delete via IMAP, or expect the noise.

**`npm run lint` fails in a `.claude/worktrees/…` worktree** with `Plugin
"@next/next" was conflicted between ".eslintrc.json" and "../../../.eslintrc.json"`
— the worktree sits inside the parent repo, so ESLint finds both configs. It is
not your change: confirm by linting an untouched file, and trust CI (which
checks out flat). Same cause as the "multiple lockfiles" Next warning.

**`register()` in `instrumentation.ts` resolves *before* the server accepts
connections.** So `await fetch('http://127.0.0.1:PORT/…')` inside it can never
succeed — it deadlocks or burns every retry against a closed port. Defer
self-calls onto a `setTimeout`. (Caught before shipping, but only by asking why
the mail bridge's `setInterval` worked while the cron start-call wouldn't.)

**Before enabling anything that sends email, measure the first tick.** Several
scheduled jobs here are "everything not yet marked" queries and the marker had
never been set, so the first run would have mailed the whole backlog: 3 people a
digest of 3-week-old messages. Count it against the prod DB first, then write a
one-shot baseline. Make it **one-shot** (a `Setting` key), not just idempotent —
an every-deploy backfill would keep marking *newly* stale work as handled and
permanently suppress the feature it protects.

**Check `emailAllowed` when touching any job that mails users.** Every scheduled
job in `emailService.ts` consults it except `checkMentorInteractionReminders`,
which also sent one mail per relation rather than per mentor — 7 unstoppable
emails a day for one mentor. Worth grepping for the odd one out before assuming
the batch is uniform.

**A guard field may not guard what its name suggests.**
`stalenessReminderSentAt` gates only the in-app bell; the email loop reads every
stale relation on every run. Read where a field is *consumed* before designing a
backfill around it — baselining it would have hidden notifications without
preventing a single email.

**Count before you claim a number.** Grepping the maildir for `reply+` matched 21
files, but that pattern also hits *outbound* copies whose `Reply-To` carries the
token. Anchoring on recipient headers (`To|Cc|Delivered-To|X-Original-To`) gave
the real figure: 9 files, 5 distinct replies, of which only 1 was still
recoverable (the other threads had been deleted). Anchor the grep, and check the
relation still exists before promising a backfill.

## 2026-07-24 — Shared messaging UI and attachment-only support messages

**Extract UI primitives before aligning parallel chat pages.** The mentorship
thread and support thread had independently implemented composers, pending-file
previews, and bubbles. Moving the stable presentation into
`components/MessageThread.tsx` let both pages use identical spacing and controls
without coupling their different APIs, file rules, or authorization models.

**Validate the message/attachment combination after multipart parsing.** An
optional body schema alone is insufficient: trim the body, then reject only when
the trimmed body and parsed file list are both empty. For attachment-only ticket
creation, derive the ticket subject from the first filename while leaving
attachment validation and transactional storage untouched.

## 2026-07-23 — Meeting series auto-generation API (#774, 0.25.10-beta)

**Playwright in this sandbox needs two env prerequisites before tests even boot:**
`NEXTAUTH_SECRET` (otherwise NextAuth throws `NO_SECRET` and webServer times out)
and `DATABASE_URL` (otherwise Prisma seeding in e2e helpers fails immediately with
`Environment variable not found: DATABASE_URL`). When a new API e2e test appears
"broken" at startup, check env first before debugging test logic.

**Recurring generation idempotency is easiest at the leaf key level.** For
`MeetingSeries` with per-relation `Meeting` rows, de-dup on
`seriesId + relationId + scheduledAt` and skip existing keys during forward-fill.
That keeps reruns safe without changing legacy manual meetings (`seriesId = null`).

## 2026-07-23 — Bulk meeting shared-link bug fix (#759, 0.25.7-beta)

**Bug pattern — resource generated inside a per-item loop.** `POST /api/meetings`
(`src/app/api/meetings/route.ts`) built the auto Jitsi link *inside* the
`for (const rel of relations)` loop, so a bulk ("select all") schedule gave every
mentee a *different* room instead of one shared meeting. Fix = hoist the
link generation above the loop; keep the genuinely per-person bits (here
`rsvpToken`) inside. When triaging "bulk does N separate things instead of one",
look first for a shared resource created per-iteration.

**Fresh worktree is missing installed deps → build fails on unrelated modules.**
The build died on `Module not found: @node-saml/node-saml` (SSO code, nothing to
do with my change) because the worktree's `node_modules` was incomplete. `npm
install` in the worktree fixed it. Run `npm install` first in a new worktree
before trusting a build failure — the module-not-found may be a stale tree, not
your diff.

**This repo has NO PR CI checks + auto-merge is disabled.** `gh pr checks` reports
"no checks reported", `statusCheckRollup` is empty, and REST `check-runs`
total_count is 0 — there is no PR quality gate wired on the PR branch (the e2e
smoke workflow doesn't trigger here), and `gh pr merge --auto` errors with
"Auto merge is not allowed for this repository". So: gate locally with `npm run
build` (+ `npm run check:i18n`), then merge manually with `gh pr merge <n>
--squash --delete-branch`. Don't sit waiting for checks that never arrive.

**Version-bump conflicts on rebase (recurring).** While this PR sat, `main`
shipped #760 as `0.25.6`, colliding on exactly the version-bump files
(`package.json`, `package-lock.json`, `CHANGELOG.md`, `releaseNotes.ts`). Resolve
by taking my bump to the *next* free version (`0.25.7-beta`) and placing my
CHANGELOG/releaseNotes block as its own section above main's — never `--ours` the
whole file (you'd drop main's release entry). Same lesson as the earlier "Sürüm
çakışması" note; it keeps happening, so rebase-before-merge is the habit.

**Remote moved to the org.** `git push` prints "This repository moved" — the local
remote still points at `mersahin/Internship` but redirects to `21072026/Internship`
(the canonical location for `gh --repo`). Pushes work through the redirect; use the
`21072026/Internship` slug for all `gh` calls.

## 2026-07-22 — 4-lens roadmap features: analytics pages, bulk stage-advance, milestone badges (#370, 0.22.0→0.23.0)

**TR locale apostrophe in single-quoted strings.** The TR locale in both `src/i18n/dictionaries.ts` and `src/lib/releaseNotes.ts` uses single-quoted JS strings. Any Turkish word with a possessive/suffix apostrophe (e.g., `banner'ı`) must use the Unicode RIGHT SINGLE QUOTATION MARK U+2019 (`'`) rather than the straight ASCII apostrophe `'` — otherwise the string terminates early and the build fails with a cryptic "Expected ',', got 'ı'" syntax error. Pattern seen twice in this session; always check after writing any TR string containing an apostrophe.

**Remove redundant type casts after Prisma schema is exact.** If `pipelineStatus` is typed as the Prisma enum (exact same type as `PIPELINE_STATUSES[number]`), there's no need for `as (typeof PIPELINE_STATUSES)[number]`. The code reviewer caught this; trust TypeScript rather than casting away what you know.

**`package-lock.json` version must match `package.json`.** After bumping the semver in `package.json`, run `npm install` to regenerate the lockfile so its top-level `"version"` field also updates. Skipping this creates a mismatch flagged by automated code review.

**Build-errors-only grep pattern.** When checking build output, grep for `(error|Error|FAILED|failed)` rather than the full build output — keeps the signal clean. On a success the build output shows only page sizes at the end; if you see "Build failed because of webpack errors", scroll up or re-run with a grep for the surrounding lines to find the filename + line number.

**`node_modules` is not pre-installed in the sandbox.** Claude Code web containers require `npm install` before `npm run lint` / `npm run build` — otherwise `next: not found`. Run it first if `node_modules/` is missing.

---

## 2026-07-21 — Otomatik PR-başına topic preview (Plesk-native routing) (#583, 0.14.6→0.14.7)

Bu oturumda `#679` + `#690` prod'a çıktı (0.14.7) ve **her PR'a otomatik topic
preview** özelliği canlıya alındı (`crm-pr<N>.ersah.in`). Uzun ve öğretici bir
altyapı yolculuğuydu; tekrar kullanılabilir dersler:

**Self-hosted runner = sunucunun kendisi → SSH gerekmez, loglardan iterate et.**
Sandbox'ta `ssh`/`gh` binary'si YOK. Ama `topic-preview.yml`/`deploy-prod.yml`
`runs-on: self-hosted` ile sunucuda çalışıyor. Sunucuyu teşhis/onarmak için
komutları workflow adımına koyup `mcp__github__get_job_logs` ile oku — cert
sorununu, 404'ü, Plesk desenini hep böyle çözdüm (SSH'siz).

**Plesk kutusunda ham `conf.d` nginx bloğu KAZANMAZ.** Her site Plesk vhost'u ve
`listen <IP>:443 ssl` ile **spesifik IP**'ye bind. Ham `listen 443 ssl`
(tüm-adres) bloğu nginx'in adres-grubu eşleşmesini kaybeder → `server_name`'in hiç
değerlendirilmez → istek Plesk default vhost'una (`login_up.php` / 404) düşer.
Belirti: `curl /` → 303 → `login_up.php`, `<title>Plesk Obsidian`. Çözüm:
**Plesk-native subdomain** (`plesk bin subdomain --create <label> -domain <parent>`)
+ ters proxy'yi Plesk'in desteklediği `vhost_nginx.conf`'a yaz
(`location ~ ^/.* { proxy_pass http://0.0.0.0:<port>; }`, crm-preview deseni) +
`plesk sbin httpdmng --reconfigure-domain <fqdn>`. Teardown:
`plesk bin subdomain --remove`.

**Bir sibling'i (crm-preview) diagnostik dök, deseni birebir kopyala.** Kör Plesk
CLI yazmak yerine önce `/var/www/vhosts/system/<fqdn>/conf/` + `plesk bin subdomain
--info` + `nginx -T | grep` çıktısını log'a döktürdüm; `proxy_pass 0.0.0.0:3201`
ve spesifik-IP `listen`'i oradan öğrendim.

**Wildcard cert'i Plesk'e import edip subdomain'e ata.** `*.ersah.in` acme.sh
fullchain'i `/etc/nginx/ssl/`'de. Fullchain'i leaf + CA olarak ayır (`awk`),
`plesk bin certificate --create <name> -domain <parent> -cert-file <leaf>
-key-file <key> -cacert-file <chain>`, sonra `plesk bin subdomain --update ...
-certificate-name <name>`. Per-topic LE gerekmez.

**Cloudflare-proxied wildcard DNS + edge TLS:** `infra-setup.yml` DNS (`*.ersah.in`
A, proxied) + acme.sh wildcard cert'i tek dispatch'te kurar; **`CF_API_TOKEN`
secret'ı şart** (yoksa DNS adımı 7 sn'de düşer). Token'ı chat'e aldırma —
`gh secret set` ile kullanıcı eklesin.

**Sandbox TLS doğrulaması yanıltıcı:** Anthropic egress-gateway HTTPS'i MITM'liyor;
`curl` cert subject/issuer'ı proxy'nin, `ssl_verify_result`/`-k`'sız hata sitenin
değil. Servisin gerçekten çalıştığını **HTTP status + gövde** ile doğrula
(`/api/health` → 200 + JSON), cert zinciriyle değil.

**`set -euo pipefail` + bloğu silerken değişken tanımı:** cert-precheck bloğunu
silince onunla gelen `CONF=` tanımı da gitti; ilerideki referans `unbound variable`
ile deploy'u container ayağa kalktıktan sonra düşürdü. Blok silerken o bloğun
tanımladığı ama sonrasında kullanılan değişkenleri koru.

---

## 2026-07-21 — Transfer sonrası: yazma yolu, CI kotası reset, backlog süpürmesi (0.12.0→0.14.1)

**Repo `mersahin/Internship` → `21072026/Internship`'e taşındı.** Bu oturumun büyük
teması transfer artıklarını temizlemek + kotanın reset'inden faydalanmak oldu.

**GitHub Project board — GitHub-standardında kal (over-engineering dersi):** Board
org `21072026` proje `1`. İş üretirken (bkz. `backlog` skill) hiyerarşi **native
sub-issue** ile kurulur (Epic→Story→Task); board'da **Group by → Parent issue**
epic/story/task şeritlerini bedavaya verir. Öncelik **P1/P2/P3 label**'dır (board
etikete göre grupla/sırala); akış **Status** kolonları. **Custom alan yok.**
> Bu oturumda önce custom `Katman` (Epic/Story/Task) + `Prio` (P1-P3) single-select
> alanları + toplu `gh` script (`board.sh`) + bir issue-açılışı auto-field workflow'u
> kurdum — maintainer haklı olarak "gereksiz iş yükü, GitHub-standardında kalalım"
> dedi ve geri aldık. **Ders:** native sub-issue hiyerarşisi + P-etiketleri zaten
> tür ve önceliği taşıyor; bunları custom alanla kopyalamak = kalıcı bakım yükü
> (her issue'da alan doldurma, PAT secret, workflow). Yerlisi neyi ifade ediyorsa
> onu tekrar üretme. Sub-issue linkleme + etiketleme agent'ın App'iyle çalışır;
> *proje-scope'lu* custom alan/board yerleşimi yazılamaz.

**AMA resmî org "Priority" alanı YAZILABİLİR (önemli düzeltme):** Board'daki resmî
Priority, proje custom alanı değil bir **org-seviyesi issue alanı** (Urgent/High/
Medium/Low; `Effort`, `Start date`, `Target date` de öyle). `mcp__github__list_issue_fields`
(owner+repo ile; owner-only 403) görür, ve agent bunu **`mcp__github__issue_write`**
(`method:update`, `issue_fields:[{field_name:"Priority",field_option_name:"High"}]`)
ile **set edebilir**. Bu yüzden custom "Prio" gereksizdi — resmî alanı P-etiketinden
doldur: **P0→Urgent, P1→High, P2→Medium, P3→Low**. (Bu oturumda 33 açık issue'ya
tek tek uygulandı, `list_issues` field_filter=Priority ile doğrulandı.)

**Transfer yazma yolunu AÇTI (önceki oturum 403 alıyordu):** yeni repoya scoped
oturumda `git push` + `mcp__github__*` sorunsuz çalıştı. Transfer sonrası ilk iş:
repo-path referanslarını güncelle (ONBOARDING clone URL, CHANGELOG footer link'leri,
infra/README issue link'i, backlog+intern-issue skill'lerindeki repo adı, deploy-prod.yml
runner-setup yorumu). **GitHub Project board repo ile TAŞINMIYOR** —
`e2e/project-board-url.spec.ts` ve intern-issue skill'indeki `gh project --owner mersahin`
+ proje/field ID'leri hâlâ eski board'a bakıyor; yeni board URL'i olmadan bunları
güncelleyemedim (maintainer'a soruldu, beklemede).

**Transfer GitHub Actions kotasını SIFIRLADI (temiz ~2000h/ay).** Kota tükendiği için
`workflow_dispatch`-only'e duraklatılmış hosted workflow'ları dikkatli geri açtım:
- **Aç:** `ci.yml` (~2 dk) + `e2e.yml` (@smoke, ~3.5 dk) → `push`+`pull_request`. PR
  başına ~6 dk, ayda binlerce PR bile <100h.
- **Dispatch-only KALSIN:** `e2e-full` (4×/gün × 4 shard ≈ aylık kotanın çoğunu yiyen
  asıl tüketici), `stress`, `topic-preview`. Bütçeyi bunlar belirliyor, PR gate'i değil.
- **`deploy.yml` PAUSED kalsın:** prod artık self-hosted `deploy-prod` ile iniyor; hosted
  deploy hem kota yer hem çift-deploy riski. Doğrulama: re-enable PR'ının KENDİSİNDE
  iki check de yeşil koştu (gate uçtan uca kanıtlandı).

**`infra/deploy-prod.sh` tamamen parametrik → preview deploy bedava geldi.** Script
`CONTAINER`/`PORT`/`IMAGE`/`ENV_FILE` env override'larını kabul ediyor; preview =
aynı script'i `internship-crm-preview` / `:3201` / `preview.env` ile çağırmak. Yeni
`deploy-preview.yml` (self-hosted, dispatch-only) bunu yapıyor. Env dosyası yoksa script
çalışan preview container'ından türetiyor (satır ~65), yani ek kurulum gerekmedi. Preview
hosted deploy duraklayınca 0.7.0'da kalmıştı; bu workflow ile prod+preview birlikte
güncellenebilir.

**Claude Code / Copilot oturum-task sayfaları DIŞARIDAN OKUNMUYOR:**
`github.com/OWNER/REPO/tasks/<uuid>` linkleri WebFetch'te 404/auth veriyor. Copilot
uygulama-denetimi task'ı aslında **taslak bir PR'a** dönüşmüştü (#676) — bulguları o PR
gövdesinden okudum, kodda `file:line` ile doğruladım, 7 backlog issue açtım (#678–#684).
İkinci inceleme repoda hiç iz bırakmamıştı (sadece geçici keşif betiği commit'lemiş);
bulguları maintainer sohbete yapıştırınca doğrulayıp açtım (#689–#692). Ders: oturum-task
URL'i verilirse ya karşılık gelen PR'ı bul, ya da içeriği iste — sayfayı fetch etme.

**i18n TR ekindeki tuzaktan kaçış:** "3 aydır/gündür/yıldır" gibi ekli ifadeler ünlü
uyumu yüzünden template'le zor; `durationSince()` yalnızca `{count, unit}` döndürüp ismi
(gün/ay/yıl) sözlükten aldım ve cümleyi "Üyelik süresi: {d}" / "Projede: {d}" gibi ek
gerektirmeyen kalıba kurdum. `.replace('{d}', ...)` deseni repoda zaten standart.

**Tarayıcı bildirimi (foreground) deseni:** izin cihaz-başına olduğu için tercih
`localStorage`'da (DB'de değil). Popup patlamasını önlemek için `NotificationBell`'de
ilk poll yalnızca "görülen id" baseline'ı kurar, sonraki poll'larda yeni-okunmamış id'ler
için tek tek `new Notification()` atılır.

**Bu oturumda inen (hepsi self-hosted deploy + health-check ile prod'da doğrulandı):**
üyelik süresi göstergesi (0.12.0), foreground tarayıcı bildirimleri #675-K1 (0.13.0),
projeye mentee üye + işlevsel rol #51 (0.14.0), meet-link "Google Meet"→"Meeting link"
düzeltmesi (0.14.1). Prod health `0.14.1-beta`/`593656f`.

## 2026-07-07 — Test tooling, a session-null fix, an email-in-history purge, and relicensing

**What shipped (all merged to `main`):**
- Non-functional test tooling: dependency-free stress/load harness (`scripts/stress-test.mjs`),
  a nightly cron workflow (`.github/workflows/stress.yml`) that emails on failure
  (`scripts/send-alert-email.mjs`), an XSS/injection e2e spec, and a `/api/health` probe (#506).
- `fix(mentor)`: the mentor dashboard used `session!.user.id`; a session revoked between the
  layout gate and the server render 500'd. Guarded with `if (!session?.user?.id) redirect(...)`
  like the portal page (#508). This was the real root cause of the `sign-out-all` e2e flake.
- Relicensed **MIT → AGPL-3.0-or-later** to keep the project open source while enabling a
  commercial/dual-licensing moat (#515).

**This remote environment ("Claude Code on the web") — hard limits, don't fight them:**
- **No `gh` CLI and no direct `api.github.com`.** GitHub is reachable *only* via the
  `mcp__github__*` tools. Direct `curl https://api.github.com/...` returns *"GitHub access is
  not enabled for this session."* (Note: `CLAUDE.md` mentions `gh` fallbacks — those apply to a
  *different* environment; ignore them here.)
- **The agent proxy blocks two write surfaces outright**, regardless of token: GitHub Actions
  **secrets** (`.../actions/secrets/...` → "not permitted through this proxy") and **repo
  settings** (`PATCH /repos/... {private:true}` → "Repository settings writes are not permitted").
  So *adding a secret* and *changing repo visibility* **must be done by the human** — don't
  promise to do them; give exact Settings-UI steps instead.
- Consequence for the nightly alert: since I can't create the `ALERT_EMAIL_TO` secret, the
  workflow defaults the recipient inline (`${{ secrets.ALERT_EMAIL_TO || '<maintainer>' }}`) so
  it works out of the box; a secret still overrides.

**GitHub MCP tooling gotchas:**
- `mcp__github__actions_list` returns a **huge** payload that overflows the tool-result budget.
  It saves to a file instead — parse that file with `python3` and filter by `head_sha`
  (branch/`per_page` filters are effectively ignored server-side). PR runs are keyed by the PR
  **head commit SHA**, not a merge SHA.
- `mcp__github__actions_get get_workflow_run` can return **stale/cached** data (frozen
  `updated_at`, status stuck `in_progress`). Cross-check completion with `get_job_logs`
  (`failed_only:true` → `failed_jobs:0`) *plus* a fresh `actions_list` conclusion; don't trust a
  single read.
- To read CI failures: `get_job_logs` with `failed_only:true` gives the failed job id, then
  `get_job_logs return_content:true tail_lines:~230` for the Playwright summary (the failing
  test list sits just above the run's cleanup logs).

**Branch protection / history rewrite (needed to purge a leaked email from history):**
- A force-push to `main` needs the maintainer to (1) enable *Allow force pushes* **and**
  temporarily disable (2) *Require a pull request* and (3) *Require status checks* — enabling
  only force-push isn't enough; the "require PR" rule still rejects any direct push.
- **Ref deletion is blocked** (`git push --delete` → HTTP 403 via the proxy), but ref *updates*
  are allowed — to neutralize a stale branch, force-push it to a clean commit instead of
  deleting it.
- History rewrite is **not** full erasure: the merged PR's diff page, existing **forks**, and
  GitHub's commit cache (reachable by old SHA until GC) still hold the content. Full removal
  needs making the repo private and/or a GitHub Support purge request. Say this plainly.

**Process:**
- Squash-merge means the designated branch's PR can already be **merged** with only the first
  commit; follow-up commits pushed afterward are separate. Rebase follow-ups onto the latest
  `main` and open a fresh PR (`git rebase --onto origin/main <old-base> <branch>`).
- The e2e suite is genuinely flaky (see `CLAUDE.md` for the known specs). Re-running only the
  failed jobs (`actions_run_trigger rerun_failed_jobs`) usually goes green; read the actual
  failure log before assuming your change broke something.

## 2026-07-10 — Premium Faz 1 tamamlama + küçük backlog süpürmesi

**Pipelining beats polling (maintainer feedback, now standing):** don't idle-wait on CI.
Open the PR, immediately start the next item on a fresh branch off `origin/main`, and merge
green PRs opportunistically whenever you happen to check. `git stash` + `checkout -B <new>
origin/main` + `stash pop` cleanly moves work-in-progress to its own branch when you started
it on the wrong one.

**Parallel PRs need disjoint files.** The batch (#575/#576/#577) worked because each PR
touched different files; `dictionaries.ts` is the common collision point — add i18n keys in
separate blocks and rebase quickly if two PRs touch it.

**Cross-PR dependencies:** a seed/script referencing a new enum value must merge *after* the
schema PR that adds it (noted in the PR body, e.g. #581 after #579). Squash-merges make the
order matter — GitHub won't warn you.

**Entitlement-gating pattern is settled:** `hasFeature(companyId, KEY)` in the route +
`feature_locked` 403 + e2e that flips the flag via direct `prisma.companyEntitlement` writes.
The free-core regression spec (`e2e/free-core-regression.spec.ts`, #526) is the shield —
extend it if you add core routes.

**Consent-gated visibility:** company-facing mentee exposure now requires BOTH
`publicProfile` AND an active `TALENT_POOL_VISIBILITY` consent (`grantedAt` set, `revokedAt`
null). Any new company-facing query must include the same `consents.some` clause — copy it
from `talent-pool/route.ts`.

**Faz 2/3 premium işleri bilinçli beklemede:** story #521 "task'lar Faz 1 geliri
doğrulandıktan sonra bölünecek" diyor; analytics gating'in alıcısı (admin vs şirket) da
belirsiz. Bunlara başlamadan maintainer'dan ürün kararı iste.

**Verify-before-build:** `npm run build` in the sandbox needs
`PRISMA_QUERY_ENGINE_LIBRARY` exported; a chained `format && validate && generate` without
`DATABASE_URL` fails at validate — pass a dummy `DATABASE_URL` for validate only.

## 2026-07-11 — Premium Faz 2 tamamlama (analitik + AI paketi)

**Faz 2 gating kararları (uygulandı, gerekçeli):** admin-facing premium analitik
tek-tenant'ta `premiumAnalytics` Setting flag'i ile kapatıldı (hasFeature şirket-bazlı
olduğu için admin'e uymuyor; Faz 3 multi-tenancy'de per-tenant entitlement'a taşınır).
AI tarafında merkezi kapı `runAiGated` (src/lib/aiGate.ts): consent → kota → sağlayıcı →
çağrı → ölçüm; kota `aiMonthlyQuota` Setting + `AiUsage` satırları (yalnızca BAŞARILI
çağrı kredi tüketir). Yeni AI özelliği eklerken sağlayıcıyı doğrudan çağırma — kapıdan geç.

**Mentee'ye asla paywall:** mentee-facing AI özellikleri (CV feedback, interview prep)
kota bitince nötr "şu an kullanılamıyor" der; kota/fiyat mekaniği yalnızca admin'e görünür.

**Kişisel veri sağlayıcıya gitmiyor:** eşleştirme/interview-prep yalnızca skills/pozisyon
string'leri gönderir; mentörler anonim etiketlerle (A-E) sıralanıp lokalde geri eşlenir.
Yeni AI özelliklerinde bu deseni koru; kişi-verisi işleyen özellik için özel ConsentType aç
(örn. AI_INTERACTION_SUMMARY).

**dictionaries.ts çakışma pratiği:** aynı bölgeye dokunan paralel PR'larda squash sonrası
rebase kaçınılmaz. Çözüm kalıbı: HEAD bloğunu tut + "  }," kapat + gelen dalın yalnızca
yeni bloğunu ekle (python regex ile 3 locale'de tek seferde). `check:i18n` anında doğrular.

**Stale Prisma client tuzağı (yine):** rebase sonrası `tsc` yeni enum değerini tanımazsa
önce `npx prisma generate` — kod hatası sanma.

**CI kırmızısı triage:** "228 passed" + exit 1 → altyapı flake'i (Chromium SIGSEGV, teardown);
`rerun_failed_jobs` yeterli. Log'da gerçek spec hatası olup olmadığına mutlaka bak; benim
diff'ime dokunmayan spec'te strict-mode ihlali de tipik flake işareti.

## 2026-07-11 — Ürün turu: self-serve intake, destek sistemi, katalog, topic preview (0.6.0-beta)

**Pipelining artık standart:** PR açar açmaz sıradaki işi kodla; CI sonuçlarını toplu
"sweep"le kontrol edip yeşilleri merge et. Bekleme molası yok — kullanıcının açık talebi.

**PR "dirty" ise CI hiç tetiklenmez:** #609'da check-run listesi bomboştu; sebep workflow
değil, PR'ın merge conflict'i (mergeable_state: dirty — GitHub merge commit'i üretemeyince
pull_request workflow'ları koşmaz). Boş check listesi gördüğünde önce `pull_request_read get`
ile mergeable_state'e bak; rebase + çöz + push sonrası CI kendiliğinden gelir.

**Ortamdaki GITHUB_TOKEN doğrudan API'ye kapalı:** curl ile api.github.com "GitHub access
is not enabled for this session" döner — CI izleme/merge yalnızca mcp__github__* araçlarıyla.
Kendi kendine check-in için `send_later` (claude-code-remote) çalışıyor; Monitor + curl çalışmıyor.

**Aynı dashboard'a ikinci link eklerken mevcut spec'leri tara:** #591'in kapı kutusundaki
"Upload your CV" linki, onboarding-checklist spec'inin kapsamsız `getByText`'ini strict-mode
ihlaline düşürdü. Yeni UI metni eklemeden önce `grep -rn "<metin>" e2e/` — çakışan spec'i
aynı PR'da kapsamlandır (`data-testid` + scoped locator).

**DOM-duplikasyon flake'i tekrar etti:** bazı koşularda sayfa içeriği DOM'da iki kez görünüyor
(iki `#name`, iki arama kutusu; export-filter/skill-match/sources/api-docs değişen kurbanlar).
Diff'inle ilgisiz strict-mode "resolved to 2 elements" bunun işareti — rerun yeterli. Kendi
yeni spec'lerinde DB yan-etki assert'lerini `expect.poll` ile yaz (bubble render ≠ commit bitti).

**E2E'de destek sistemi deseni:** iki browser context (user + admin) tek spec'te tam döngüyü
(ticket aç → kuyrukta gör → yanıtla → durum geçişi → bildirim) doğrulayabiliyor; API çağrılarını
`page.request` ile atıp UI'ı yalnızca kritik noktalarda assert etmek hem hızlı hem az kırılgan.

## 2026-07-11 (2. tur) — CI hızlandırma + Projeler yenileme (0.7.0-beta)

**Smoke gate kanıtlandı:** PR gate @smoke setine indirildikten sonra Playwright
job'ı ~10 dk'dan ~3,5 dk'ya düştü (ilk kanıt: #630'un kendi CI'ı). Yeni kritik
akış spec'i yazarken `{ tag: '@smoke' }` eklemeyi unutma; tam suite güvenlik ağı
`e2e-full.yml` (4×/gün, 4 shard, kırmızıda tek mail).

**Stacked PR ritmi oturdu:** base merge → `git rebase --onto origin/main <eski-base>
<branch>` → force-push-with-lease → PR. Aynı include bloğuna dokunan paralel
branch'lerde (örn. /api/projects include) conflict beklenen durum; iki tarafı da
tutup birleştir.

**Owner-perms deseni (#619):** sunucu tarafında alan-bazlı yetki için "owner
değilse gönderilen korumalı alanları 403 + alan listesiyle reddet" yaklaşımı,
UI'da da aynı alanları disabled yapıp payload'dan çıkarmakla eşleşiyor — UI'a
güvenmeden net hata mesajı veriyor.

**Actions runner'ı sunucu eli olarak kullan:** bu konteynerde SSH anahtarı yok ama
runner'da var — tek seferlik sunucu işleri (wildcard cert, izin doğrulama) için
`workflow_dispatch` + deploy.yml'in SSH deseni yeterli (infra-setup.yml). Adımları
ayrı ayrı atlanabilir ve idempotent yap; root gerektiren işleri deneme, TODO yaz.

## 2026-07-17 — CI-independent deploy + Faz 3 multi-tenancy + prod auth fix (0.8.0-beta)

**Bu sandbox'tan SSH YOK — self-hosted runner sunucu elin:** `ssh` binary yok ve
:22 kapalı (yalnızca HTTPS-proxy). Deploy'u GitHub Actions hosted kotasından
bağımsızlaştırmak için sunucuya **self-hosted runner** + `deploy-prod.yml`
(`workflow_dispatch`, `runs-on: self-hosted`) kur; deploy'u GitHub MCP ile
tetikle (`actions_run_trigger run_workflow`). Sırlar sunucudaki env dosyasından
(`/etc/internship-crm/prod.env`), repoya asla girmez. Kök: root için runner'da
`RUNNER_ALLOW_RUNASROOT=1`.

**Deploy doğrulaması kotasız:** `curl https://crm.ersah.in/api/health` `sha` ve
`version` döndürüyor — merge sonrası bir `until [ "$sha" = "<yeni>" ]` döngüsüyle
prod'un gerçekten yeni SHA'ya geçtiğini uçtan uca doğrula (deploy run "success"
demek yetmez, health kanıttır). Build ~2-3 dk; foreground `sleep` bloklu, until +
`sleep 5` kullan.

**Hosted kota tükenince pipeline gürültüsünü kes:** her hosted workflow anında
patlayıp mail atıyor. `on:` bloklarını `workflow_dispatch`-only yap (orijinali
yorumda bırak). Önemli: `pull_request` workflow tanımları **PR head'inden**
okunur — tetikleyiciyi kaldıran PR o workflow'ları kendi üstünde ÇALIŞTIRMAZ, yani
değişiklik yeni hata maili üretmeden iner.

**Prod şema değişikliklerini seri + doğrulamalı sür:** `deploy-prod` concurrency
grubu (`cancel-in-progress: false`) deploy'ları sıraya sokuyor, yarış yok. Yine de
her additive şema PR'ından (nullable kolon/enum) sonra bir sonrakini yığmadan önce
health/SHA ile doğrula. `prisma validate` için dummy `DATABASE_URL` + engine
env'i (`PRISMA_QUERY_ENGINE_LIBRARY=.../libquery_engine-debian-openssl-3.0.x.so.node`).

**Riskli dilimi test edemeden AÇMA — güvenli/kapalı/dokümante bırak:** canlı
tek-kiracılı prod'da global tenant-izolasyonunu (her sorguyu orgId ile filtreleme)
veya test edilemeyen SAML/Google OAuth token akışını açmak yerine; yapı taşlarını
(orgScope helpers, config + gating) + bir env bayrağı (`MT_ENFORCE_ISOLATION`,
default off) + runbook ile ver. Local DB/CI yokken (sandbox'ta docker daemon da
yok) untested auth/izolasyon kodunu prod'a sürmek sorumsuzluk; dürüst kapsam:
tsc+build+check:i18n yeşil, kalan wiring dokümante.

**i18n toplu ekleme tuzağı:** Python `str.replace(x, en_block, 1)` ile üç locale'e
blok eklerken, EN bloğunun İÇİNDE tekrar eden bir anahtar (örn. `plan: 'Plan',`)
varsa bir sonraki `replace` yanlış (yeni eklenen) satırı yakalar. Her locale için
o dile ÖZGÜ bir çapa anahtarı kullan (ör. TR `plan: 'Plan',` yerine benzersiz bir
komşu satır) ve `assert count==1` ile doğrula; sonra `npm run check:i18n`.

**Squash sadece ilk commit'i alma tuzağı (hatırlatma):** PR açtıktan SONRA
push'lanan commit'ler squash'a girmeyebiliyor — branch'i PR'dan önce tam hazırla,
ya da tek commit tut.

---

## 2026-07-22 (öğleden sonra) — MT enforcement engine, contributor PR entegrasyonu

**Tenant izolasyonunu "unutulamaz" hale getir: gated Prisma `$use` middleware +
AsyncLocalStorage.** Opt-in `orgScoped()` helper'ları "her sorgu izole" kriterini
garanti edemez (çağıran unutabilir). Çözüm: `runWithOrg(orgId, fn)` bir
`AsyncLocalStorage` context'i bağlar; tek bir `prisma.$use` middleware'i
tenant-anchor modellerinde (`User/Source/Company/Project/Cohort/
MentorshipRelation`) `where`/`data`'ya `orgId` enjekte eder. Tamamen
`MT_ENFORCE_ISOLATION` (default off) arkasında: kapalıyken `runWithOrg` düz
passthrough, middleware erken döner → tek-kiracılı prod bit-bit aynı.

**`node:async_hooks`'u `prisma.ts`'e KOYMA — client bundle patlar.** prisma.ts
onlarca client-erişilebilir modül tarafından (sabit sızıntıları üzerinden)
import ediliyor; `async_hooks` eklemek `UnhandledSchemeError` veriyor. Middleware +
ALS'i ayrı **server-only** `orgContext.ts`'e koy (yalnızca route handler'lar
import eder), `prisma.ts`'i minimal tut. Middleware'i `runWithOrg` ilk
çağrıldığında lazy + global-guard ile kaydet.

**Prisma 5 `extendedWhereUnique`:** `findUnique`/`update`/`delete` artık `where`'de
unique alanın YANINA ekstra filtre (ör. `orgId`) kabul ediyor — cross-tenant
`findUnique` null döner. Middleware'de tüm where-tabanlı action'lar için tek tip
`{...where, orgId}` merge yeterli; create/createMany/upsert için `data`'ya enjekte.

**İzolasyon testini middleware'i uçtan uca kanıtlar şekilde yaz:** helper unit
testi yetmez; app `prisma`'sını + `runWithOrg`'u kullanıp `orgScoped()` HİÇ
çağırmayan düz bir `findMany`'nin bayrak açıkken izole, kapalıyken no-op olduğunu
doğrula (seed'i middleware'siz `helpers/db` client'ıyla yap).

**Contributor/Copilot PR'ını merge'den önce adversarial review + düzelt:** #740'ta
bir subagent review'ı iki gerçek bug yakaladı (bulk "advance stage" ham enum
`indexOf+1` ile in-progress stajı "dropped"a itiyordu; company-analytics
`companyId` null olan COMPANY kullanıcıya TÜM veriyi sızdırıyordu). Rebase +
düzelt + i18n/build yeşil + kısa açıklayıcı PR yorumu, sonra squash.

**Sürüm çakışması:** paralel PR'lar aynı `x.y.z`'yi almaya çalışır (intern #656 +
benim #739 ikisi de 0.23.0). Rebase'te CHANGELOG/releaseNotes/package(-lock).json
çakışmalarını yeni sürümü en üste koyacak şekilde elle çöz; `git checkout --ours`
sadece benim tarafım tümüyle doğruysa. `get_check_runs` CI'ın tek doğru kaynağı
(get_status legacy commit-status API'si total_count 0 gösteriyor); self-hosted
"topic" check'i de yeşil olmalı.

**Ağır alt-işi kendi issue'suna böl:** #546'nın "özel pipeline aşamaları
(enum→dinamik)" parçası çok geniş/kesişen — `sub_issue_write` ile #747 olarak
ayırıp #546 altına bağladım (dikkat: `sub_issue_id` node **id**'si, issue numarası
değil).

---

## 2026-07-23 — #517 (Premium/Enterprise epic) kapatıldı: MT izolasyon + SSO + özel pipeline

**Enum → String prod göçünü dilimle + `db push`'u topic'te önce doğrula.** `#747`
için `MentorshipRelation.pipelineStatus` (+ `StatusChange`) Prisma **enum**'unu
**String**'e çevirdim. Kilit noktalar: (a) MySQL `ENUM → VARCHAR` mevcut değerleri
**korur** (veri-güvenli), (b) bir Prisma enum'u **hiçbir model alanı** referans
etmeyince Prisma client onu **artık export etmez** → `import { X } from
'@prisma/client'` kırılır; enum'u kanonik "varsayılan anahtar kaydı" olarak
şemada bıraktım ama 3 çağrı yerini `@/lib/pipeline` string-union'ına / string
literal'a taşıdım. (c) Göçün gerçek testi topic-preview'ın data-taşıyan DB'sinde
`db push`; smoke fresh-DB olduğu için ENUM→VARCHAR ALTER'ı test etmez. (d) Yazma
yolundaki zod doğrulayıcıları da enum→`z.string()` yapmayı unutma (yoksa özel
anahtar 400 yer): `PUT /api/mentorship/[id]`, `POST /api/status-changes`.

**Geniş, tekdüze UI dönüşümlerini paralel subagent'lara böl (disjoint dosyalar).**
17 dosyalık pipeline-etiketi dönüşümünü (server sayfa + client component karışık)
3 subagent'a bölüp her birine kesin kontrat + `npx tsc --noEmit | grep <kendi
dosyaları>` self-check verdim; sonra tek `npm run build` ile entegre ettim. Aynı
deseni #543'ün 63-route sarımında da kullandım. Server/client ayrımı: server
sayfa `await resolvePipelineStages(orgId, locale)` + `stageLabel(...)`; client
component `PipelineStagesProvider` (role layout'ta) + `useResolvedStages()/
useStageLabel()`. `node:async_hooks`/DB import'unu client'a sokmamak için saf
yardımcıları (`ResolvedStage`, `defaultPipelineStages`, `stageLabel`) client-safe
`pipeline.ts`'e taşı; DB'li `resolvePipelineStages` ayrı server modülde kalsın.
Dikkat: bir hook'u `useState(...)` başlangıç değerinde kullanacaksan hook'u
bileşenin EN başında, useState'lerden önce çağır.

**Client'a taşıyınca `locale` "unused" olup build'i kırar.** `pipelineLabel(x,
locale)` → `label(x)` (hook) yapınca `const locale = useLocale()` çoğu dosyada
kullanılmaz kalıyor; `@typescript-eslint/no-unused-vars` bu repoda **ERROR**.
Dönüşüm sonrası kullanılmayan `locale`/`useLocale`/`pipelineLabel` import'larını
temizle (subagent kontratına ekle).

**GitHub GraphQL kotası REST'ten ayrı ve bu oturumda tükendi.** Onlarca
merge/issue-update sonrası GraphQL (`issue_write` node-id, `list_issue_fields`,
Projects) "rate limit exceeded" verdi ~saatlik; REST (get_me, `create_pull_request`,
`merge_pull_request`, get_check_runs) çalışmaya devam etti. Yani kota tükenince
PR açıp merge edebilirsin ama issue **kapatamazsın/board yazamazsın** — bekle ya
da REST-tabanlı adımları sürdür.

**Board Status kolonu (Ready/In Progress/In Review) mevcut GitHub MCP araçlarıyla
YAZILAMIYOR.** `list_issue_fields` yalnızca Priority/Effort/tarih alanlarını
döndürüyor; Projects v2 **Status** alanı yok. Kullanıcının "işi Ready→In
Progress→In Review taşı" süreç kuralını ancak **assignee + PR açık/merge** ile
sinyalleyebildim. Kolon otomasyonu gerekiyorsa ayrı bir GitHub Action lazım.

**Self-hosted "topic" check'i dalgalı — iki farklı infra hatası gördüm:** (1)
`next build` sırasında OOM (exit 255), (2) `P1001: Can't reach database server at
host.docker.internal:3306` (preview DB anlık düşük). İkisi de kod/göç hatası
DEĞİL (build+smoke yeşilken). `rerun_failed_jobs` + birkaç dk bekleme genelde
yeşile çeviriyor; kullanıcının "yeşil olmadan merge etme" kuralı gereği topic
yeşile dönene kadar bekledim (kod tarafı build+smoke ile zaten doğrulanmış olsa
da). Ayrıca: bir PR'da GitHub Actions hiç tetiklenmedi (event düşmedi); boş commit
(`git commit --allow-empty`) ile yeniden tetikledim.

**Contributor/Copilot PR'ını merge'den önce adversarial review + rebase.** #740'ta
subagent review'ı iki gerçek bug yakaladı (bulk advance off-path'e itiyor;
company-analytics companyId'siz kullanıcıya tüm veriyi sızdırıyor); rebase +
düzelt + yeşil + kısa açıklayıcı yorum, sonra squash.

**Test edilemeyen auth'u da gerçek IdP ile doğrula: mock-saml.com.** #545 SAML
round-trip'ini gerçek IdP olmadan bitiremiyordum; `mocksaml.com` (BoxyHQ) ücretsiz
public test IdP — metadata/sertifikası public, sunucu ACS'yi tarayıcı üzerinden
POST'ladığı için sandbox'tan erişim gerekmiyor. Kullanıcı 3 adımda (org oluştur +
mocksaml config yapıştır + /auth/sso) prod'da uçtan uca doğruladı; gerçek Okta/
Azure'a geçiş sadece config yapıştırmak.

## 2026-07-24 — #782 Textarea character counter

**Versioning üçlüsünü her PR'da birlikte yap; hiç atlama.** `package.json` bump +
`CHANGELOG.md` entry + `src/lib/releaseNotes.ts` entry — üçü birden gerekli.
CLAUDE.md'deki versioning kuralı zaten mevcut ama bu PR'da atlandı ve reviewer
tarafından sonradan hatırlatıldı. Bu üç dosyayı PR'ın son commitinde birlikte
güncellemek standart operasyondur; birini bile atlamak eksik kalır.

**Topic Preview'un "build hatası" genellikle kod değil infra sorunudur.** `CI` ve
`E2E Tests` geçiyorsa (`npm run build` + TypeScript clean) kod sorun değil. Bu
PR'da iki farklı infra hatası gördüm: (1) Docker build'de OOM (exit 255), (2)
`prisma db push` sırasında `P1001: Can't reach host.docker.internal:3306`.
İkisi de sunucu tarafı — kod değişikliği gerekmez, sadece infra durumunu açıkla.

---

## 2026-07-28 — #800/#803 Preview & prod otomatik deploy

**"X deploy edilmiyor" şikayetinde ilk iş `event` alanına bakmak.** Preview'in
bayatlaması bir *hata* değil, eksik tetikleyiciydi: `deploy-preview.yml` ve
`deploy-prod.yml` ikisi de `workflow_dispatch`-only'di. `actions_list` çıktısında
her koşunun `event`'i `workflow_dispatch` görünüyorsa o workflow **otomatik
değildir** — prod 44 kez elle dispatch edilerek "güncel" görünüyordu, yani
"canlı sürüm doğru" olması otomasyonun çalıştığını KANITLAMAZ. Preview toplam 3
kez koşmuş, 7 gün bayat, 72 commit geride. CLAUDE.md/README ise hâlâ durdurulmuş
`deploy.yml`'i ve "her PR preview deploy eder"i anlatıyordu; bir davranışı
değiştirmeden önce dokümanın gerçeği yansıttığını doğrula.

**Ortamın gerçekte ne koştuğunu `/api/health` söyler — bu altın kaynak.**
`{"version","sha"}` döndürüyor (GIT_SHA image'a build-arg ile basılıyor). İki
ortamı karşılaştırmak sorunu 30 saniyede kanıtladı. Deploy gate'i de bunun
üzerine kurdum: canlı `sha` == `origin/main` ise build'e girmeden çık.

**Gate'te hedef sha'yı ASLA yerel ref'ten okuma — `git ls-remote` kullan.** Bu
oturumda yerel `origin/main` `d9894f6` derken gerçek uç `380a47b`'ydi. Self-hosted
runner workspace'i paylaşımlı ve shallow; `git rev-parse origin/main` sessizce
yanlış cevap verir. `git ls-remote origin refs/heads/main | cut -c1-7` doğrudan
remote'a sorar.

**Otomatik deploy'da "checkout edilen commit"i değil `origin/main`'in UCUNU
deploy et.** Aksi halde kuyrukta bekleyen eski koşu yenisinin üstüne eski kodu
yazar (#794'ün prod için çözdüğü sınıf; preview'de `--no-pull` ile duruyordu).
`cancel-in-progress: true` bunun çözümü DEĞİL — container swap'ın ortasında
iptal ortamı düşürür. Doğrusu: kuyruğa al + gate ile gereksiz koşuyu no-op yap.

**Elle tetiklenen bir workflow otomatikleşince "yıkıcı" adımları tekrar gözden
geçir.** `deploy-preview.yml` her koşuda `preview.env`'i `rm -f` ediyordu (sırlar
çalışan container'dan yeniden türetiliyor diye). Gözetimsiz koşan bir workflow
için bu, container gittiği an sırların tek kopyasını yok etmek demek. Silmek
yerine doğrula: `( set -a; . "$ENV_FILE"; [ -n "$DATABASE_URL" ] )` başarısızsa sil.

**Sandbox'tan `127.0.0.1`'e curl HTTPS_PROXY'ye takılır.** Gate'i yerel stub
health endpoint'lerle test ederken proxy araya girip "unreachable" verdi; proxy
değişkenlerini `unset` etmek gerekti (sunucuda proxy yok, bu sadece test
artefaktı). Aynı testte gerçek bir kusur da çıktı: `sed` deseni `"sha":"…"`
bekliyordu, `"sha": "…"` (boşluklu) biçimi kaçırıyordu → `[[:space:]]*` ekledim.
**Gate mantığını uydurma health payload'larıyla matris hâlinde test et** (güncel /
bayat / container down / manual) — 11 senaryo, hepsi bash'te, deploy'a dokunmadan.

**Issue numarasını uydurma.** Header'lara `#795` yazdım, sonra `issue_read` ile
baktığımda #795 zaten merge edilmiş başka bir PR çıktı. Referans vereceksen ya
issue'yu gerçekten oluştur (ben #800'ü açtım) ya da numara yazma.

**`paths-ignore` + drift gate birlikte çelişir.** Docs-only merge'i `push`'ta
filtrelersen gate bir sonraki tick'te sha farkını görüp yine build eder — yani
atlamaz, sadece geciktirir ve "neden 4 saat sonra deploy oldu?" sorusu doğar.
`paths-ignore`'u kaldırıp "canlı == origin/main" invaryantını korumak daha temiz.

**`mcp__github__actions_list` çıktısı bağlamı patlatır (~380 KB).** `minimal_output:
true` bile işe yaramadı. Tek koşu için `actions_get`, liste için kaydedilen JSON'u
python ile parse et (`run_number/event/conclusion/head_sha`) — 3 satır yeter.

---

## 2026-07-28 — HR/PO gözüyle uygulama turu + backlog doldurma (#736 altına 8 epic)

Bu oturumda kod yazılmadı: uygulama yerelde ayağa kaldırıldı, Playwright ile 5 rol
bağlamında 69 sayfa gezildi, bulgular epic/story/task ağacına çevrildi. Aşağıdaki
notlar ortam kurulumu, MCP araç maliyeti ve backlog konvansiyonu hakkında.

### Ortamı ayağa kaldırma (Claude Code web container)

**Docker daemon çalışmıyor, elle başlatman gerekiyor.** `docker compose -f
docker-compose.dev.yml up -d` ilk denemede şunu verir: *"failed to connect to the
docker API at unix:///var/run/docker.sock"*. `docker` ve `dockerd` binary'leri
kurulu, sadece daemon ayakta değil. Çözüm: `sudo dockerd > /tmp/dockerd.log 2>&1 &`
sonra `docker info` ile doğrula, sonra compose çalışır. `mysql:8` imajını çekmek
+ MySQL'in hazır olması toplam ~1-2 dk; `docker exec crm-dev-db mysqladmin ping
-h 127.0.0.1 -proot` ile bekle, sabit `sleep` yazma.

**Yerel kurulumun tam sırası (docs/local-dev.md Option A çalışıyor):** compose up →
`.env.local` (DATABASE_URL/NEXTAUTH_URL/NEXTAUTH_SECRET) → `DATABASE_URL=... npx
prisma db push` → `npx prisma db seed` (SEED_ADMIN_* env'leriyle) → `npm run
seed:demo` → `npm run seed:templates` → `npm run dev`. Prisma CLI `.env.local`
OKUMAZ, sadece `.env` okur — o yüzden prisma komutlarına `DATABASE_URL=` prefix'i
şart. `npm install` da gerekli (deps preinstalled değil).

**Demo hesapları:** `admin@local.test` / `admin12345`; `mentor.aylin@demo.example.com`,
`mentee.gizem@demo.example.com`, `company.1@demo.example.com` — hepsi
`DemoPass123!`. `seed-demo.mjs` SOURCE rolü için hesap üretmiyor; o rolü test
etmek isteyen elle oluşturmalı.

### Playwright: pinned build uyumsuzluğunda symlink YETMEZ

CLAUDE.md "pinned browser build eksikse kurulu build'i beklenen sürüm dizinine
symlink'le" diyor. **Bu oturumda symlink işe yaramadı** ve nedeni önemli: kurulu
build `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, beklenen ise
`/opt/pw-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/
chrome-headless-shell`. Yani sadece **sürüm numarası** değil **dizin yapısı ve
binary adı** da farklı (`chrome-linux` vs `chrome-linux64`), dolayısıyla sürüm
dizinini symlink'lemek yolu düzeltmiyor.

Çalışan çözüm — launch'a doğrudan yol ver:
`chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })`.
(`playwright.config.ts` üzerinden koşuyorsan `use: { launchOptions: { executablePath } }`.)

**`playwright` paketi yok, `@playwright/test` var.** Ad-hoc gezinti script'i
yazarken `import { chromium } from '@playwright/test'` kullan ve script'i **repo
kökünden** çalıştır, yoksa `ERR_MODULE_NOT_FOUND` alırsın (scratchpad'den
çalıştırmak node_modules çözümünü bozuyor).

**Tek script'le çok rollü tur çok verimli.** Rol → sayfa listesi haritası + her
sayfada `screenshot({ fullPage: true })` + `pageerror`/`console` toplama ile 69
sayfa tek koşuda geziliyor. İki tuzak: (1) giriş sonrası `page.url()` hâlâ
`/auth/signin` gösterebilir ama oturum kurulmuştur — sonraki sayfaların 200
dönmesine bak, login'i "başarısız" sayma; (2) rıza banner'ı tıklamayı ele al
(`getByRole('button', { name: /kabul|accept|tümünü/i })`) yoksa modal tıklamaları
yiyor.

### MCP araç maliyeti — bu oturumun en büyük sürprizi

**`sub_issue_write` yanıtı EBEVEYNİN TÜM GÖVDESİNİ döndürüyor.** Uzun epic
gövdeleriyle her tek bağlama çağrısı ~10-15 KB context yiyor. 8 epic + 20 story +
12 task'lık bir ağacı bağlamak 40 çağrı = yüz binlerce karakter demek ve context'i
bitiriyor. Pratik sonuç: **gövdeleri uzun yaz ama ağacı bağlarken bunu bütçele**;
kısa gövdeli item'ları önce bağla, uzun epic'leri sona bırak. `[_ROOT_]` (#736)
gövdesi boş olduğu için ona bağlamak neredeyse bedava.

**`list_issues` / `search_issues` token limitini aşıyor** (bu oturumda 56 KB ve
263 KB). Yanıt dosyaya kaydediliyor; doğru okuma yolu `Read` değil (satırlar çok
uzun) — `python3 -c "import json; d=json.load(open('...')); ..."` ile sadece
number/title/labels çıkar. Mükerrer kontrolü için `collections.Counter(titles)`
tek satırda iş görüyor.

**Priority'yi create çağrısında ver.** `issue_write` (method `create`) `labels` ve
`issue_fields`'i aynı çağrıda kabul ediyor → P-label + org "Priority" alanı tek
turda set edilir, ayrı `update` çağrısına gerek yok. Çağrı sayısını yarıya indirir.

### Backlog konvansiyonu: `[_ROOT_]` #736

**Yeni epic açan herkes onu #736 `[_ROOT_]` altına bağlamalı.** Bu repo tüm
hiyerarşiyi tek kökten indiriyor: `#736 → epic → story → task`. Ben ilk turda
epic'leri parentless bıraktım (`.claude/skills/backlog` dokümanı "mega-parent
yapma, kökler No Parent'ta kalsın" diyor) ve kullanıcı düzeltti. **Skill dokümanı
bu noktada repo pratiğiyle çelişiyor** — güncellenmeli.

### Paralel oturum çakışması gerçek bir risk

Ben backlog doldururken **başka bir oturum aynı repoda ~50 issue açtı** (8 güvenlik
epic'i + 5 UX epic'i ve alt işleri). Sinyal: oluşturduğun issue numaralarında
boşluklar (796, 797, ..., 799, **801**, 802, **804**...). Sonuç olarak kapsam
kesişmesi oluştu (ör. "✨ Arayüz güveni" ↔ benim a11y/boş-durum işlerim;
"🔔 Bildirim kalitesi" ↔ olumsuz sonuç iletişimi). **Rapor etmeden önce başlık
bazlı mükerrer kontrolü yap** ve kesişmeleri kullanıcıya triyaj için açıkça söyle;
"ben şunları oluşturdum" demekle iş bitmiyor.

### Ürün analizi yaparken: "yok" demeden önce grep'le

Bu repo göründüğünden **çok** zengin; ilk izlenimle "eksik" sanılan şeylerin
yarısı mevcut çıktı. Bu oturumda VAR olduğu için tekrar yazılmaması gerekenler:
`SavedViews` (kaydedilmiş görünüm), `mentorAttention` (dikkat kuyruğu),
`analytics/aging` (StatusChange audit izinden gerçek bekleme süresi + SLA overdue),
`rsvp/[token]` + `replyToken` (girişsiz token'la yanıt), `orgBranding` (white-label),
`entitlements` (özellik kapısı), `ProgramBenchmark` (anonim toplu raporlama),
`documentAccess` + erişim log'u, `retention` (KVKK saklama), `MentorshipRequest` /
`MeetingRequest` ("talep → admin onayı" deseni iki kez çözülmüş).

Gerçekten sıfır olanlar (grep ile doğrulanmış): teklif/`Offer`,
`StatusChange.reason*`, `tag` modeli, anket/NPS, mükerrer aday tespiti/merge,
haftalık rapor/devam takibi, sertifika üretimi (enum değeri var, üretici yok),
`@axe-core/playwright`.

**Ayrım önemli:** "grep sıfır sonuç verdi" ile "ben görmedim" farklı iddialardır.
Her "Mevcut durum" maddesini `dosya:satır` ile bağla; iddiayı doğrulanabilir yap.

## 2026-07-28 — Güvenlik denetimi (Playwright + hacker gözü) → backlog #814–#903

**Bu container'da Docker daemon YOK; lokal DB için `apt-get install mariadb-server`.**
`docker compose -f docker-compose.dev.yml up -d` çalışmıyor (`/var/run/docker.sock`
yok, `service docker start` ulimit hatası veriyor). Çalışan yol: `apt-get update`
(bu şart — bayat apt listesi 404 veriyor) `&& apt-get install -y mariadb-server`,
sonra `service mariadb start`. Prisma `mysql` provider'ı MariaDB 10.11 ile
sorunsuz `db push` yaptı. Root socket-auth kullanıyor, o yüzden Prisma için
parolalı kullanıcı gerekiyor:
`CREATE USER 'crm'@'%' IDENTIFIED BY 'crm'; GRANT ALL PRIVILEGES ON *.* TO 'crm'@'%';`

**Playwright: `chromium_headless_shell` symlink'i işe yaramaz, `executablePath` kullan.**
CLAUDE.md "eksik sürümü symlink'le" diyor ama 1194 build'inin dizin yapısı farklı
(`chrome-linux/headless_shell`), Playwright 1.61 ise
`chrome-headless-shell-linux64/chrome-headless-shell` arıyor. Çalışan çözüm:
`chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })`.
Ayrıca scratchpad'den çalıştırırken `import ... from '@playwright/test'` çözülmüyor —
mutlak yol ver: `/home/user/Internship/node_modules/@playwright/test/index.mjs`.

**Login otomasyonunda hidrasyonu bekle — yoksa parola URL'e düşer.**
`goto` + hemen `click('button[type=submit]')` React hydrate olmadan native GET
submit tetikliyor ve URL `?email=...&password=...` oluyor. `waitUntil:'networkidle'`
+ ~4 sn bekleyince düzeldi. Bu bir test tuzağı değil, **gerçek bir bulgu** çıktı:
formlarda `method="post"` yok (#873).

**Yetki testinde status kodu tek başına yeterli DEĞİL.** En kritik bulgu (#847:
COMPANY/SOURCE tüm görüşme kayıtlarını okuyor) `200` dönüyordu — sızıntı dönen
satırların içeriğindeydi. Rol matrisi testi her satırın sahipliğini doğrulamalı.
Ayrıca `405` yanıtları yanlış pozitif üretiyor (route o metodu desteklemiyor),
bulgu sayarken filtrele.

**`seed:demo` SOURCE kullanıcısı üretmiyor.** Rolü test etmek için elle oluşturmak
gerekti (`prisma` + `bcrypt.hash`). Kapsamlama boşluğu tam bu rolde çıktı — seed'e
eklenmesi #899'un kabul kriterlerinde.

**`sub_issue_write` yanıtları ebeveynin TÜM gövdesini geri döndürüyor.** 37 bağlantı
için bu çok büyük context tüketimi demek. Öğrenilen sıra: önce tüm issue'ları
oluştur (yanıtlar küçük), ID eşlemesini bir scratchpad dosyasına yaz, bağlantıları
en sona bırak. Ayrıca issue numaraları oluşturma sırasıyla ardışık gelmiyor
(814, 816, 818… atlıyor) — gövdede "bkz #N" yazarken numarayı önceden tahmin etme,
sonradan düzelt.

## 2026-07-28 — CI'ı sunucudan GitHub Actions'a geri taşıma (#955 / PR #956)

**Repo public olunca kota gerekçesiyle alınmış her karar yeniden değerlendirilmeli.**
Haziran 2026'da hosted Actions kotası tükendiği için build'ler self-hosted runner'a,
yani *production sunucusunun kendisine* taşınmıştı (#636); e2e-full ve stress cron'ları
tamamen kapatılmıştı (#648). Repo Temmuz'da public oldu — standart hosted runner'lar
ücretsiz ve sınırsız. Ama kodda hiçbir şey bunu haber vermiyor: workflow yorumları
hâlâ "PAUSED (quota exhausted)" diyordu ve kimse geri açmadı. Kota kaynaklı geçici
çözümlerin yorumuna **hangi koşul değişince geri alınacağını** yaz.

**CLAUDE.md gerçeği yansıtmayabilir — dosyayı oku, dokümanı değil.** CLAUDE.md
"full suite 4× a day, 4-way sharded" diyordu; `e2e-full.yml`'de schedule tamamen
yorumdaydı ve tek job'a (sharding yok) indirilmişti. Ters yönde de: `deploy-preview`
`NEXT_PUBLIC_APP_ENV` build-arg'ını hiç geçmiyordu, yani preview #636'dan beri
production mavisi giyiyordu — kimse fark etmemiş. Doğrulanmamış her doküman iddiası
`dosya:satır` ile teyit edilmeli.

**Git geçmişi en iyi "eski hale döndür" kaynağı.** Sharded e2e-full'ü sıfırdan
yazmak yerine `git log --oneline -- <dosya>` → `git show <sha>:<dosya>` ile #627'deki
orijinali çıkardım; sonradan eklenen browser-cache adımını üstüne koydum. Uydurmaktan
hızlı ve niyet kaybı olmuyor.

**Runner'ı tamamen kaldırmak yerine "ne mecburen orada olmalı" diye sor.** SSH+secret
modeline (legacy `deploy.yml`) dönmek cazipti ama sunucu sırlarını GitHub secrets'a
taşımak gerekirdi. Bunun yerine deploy'u üçe böldüm: gate (self-hosted, bir curl) →
build (`ubuntu-latest`) → deploy (self-hosted, sadece pull+swap). Drift gate bilerek
sunucuda kaldı: okuduğu doğru kaynak `127.0.0.1:<port>/api/health`, dışa açıklık /
firewall / auth gerektirmiyor. Kanıtı da çıktı: bu oturumda sunucu erişilemez
durumdaydı ve **dışarıdan `curl https://crm.ersah.in` de timeout veriyordu** — gate
hosted runner'a taşınmış olsaydı her koşuda "unreachable → drift" deyip boşuna
deploy tetikleyecekti.

**İki job build'i ve deploy'u ayırıyorsa sha'yı bir kez çöz, aşağıya taşı.** Eski tek
job'lı akışta `deploy-prod.sh` kendisi `git reset --hard origin/main` yapıyordu; build
ile deploy ayrıldığında bu, imajın build edildiği commit ile deploy edilen commit'in
ayrışması demek. Çözüm: gate hedef sha'yı `outputs.sha`'ya yazıyor, image tag'i /
`GIT_SHA` / checkout / `DEPLOY_SHA` hepsi ona pinlenmiş, script `--no-pull` ile
çağrılıyor. `FORWARD_ONLY` guard'ı `git merge-base --is-ancestor` kullandığı için o
job'da `fetch-depth: 0` şart — shallow clone soruyu cevaplayamaz.

**Sunucuya dokunan değişikliği doğrulayamıyorsan hata yolunun güvenli olduğunu göster.**
Runner offline olduğu için `--pull-image` yolunu canlıda deneyemedim. Bunun yerine
sıralamayı doğruladım: script `set -euo pipefail` ile 2. adımda imajı alıyor,
container'a 5. adımda dokunuyor — başarısız bir `docker pull` prod ayakta kalarak
abort ediyor. "Doğrulanmadı" demek yeterli değil, **doğrulanmamışsa ne olacağını** söyle.

**Kuyrukta bekleyen self-hosted job, hosted job'ın koşmasını engellemiyor.** Runner
offline iken benim PR'ımın Topic Preview run'ı `in_progress` oldu (build ubuntu'da),
diğer PR'ların eski tek-job run'ları ise `queued` kaldı. Değişikliğin kendisi
ücretsiz bir kanıt üretti. Ayrıca `gh api repos/<owner>/<repo>/actions/runners`
runner sağlığını görmenin en hızlı yolu — SSH'ı beklemeye gerek yok.

**`gh repo view` ile `git remote -v` farklı isim gösterebilir.** origin
`mersahin/Internship`, kanonik ad `21072026/Internship` (transfer sonrası redirect).
Push doğru yere gidiyor ama `--repo` bayrağı gereken komutlarda kanonik adı kullan.
Yerel `gh` token'ında `read:packages` scope'u yok, o yüzden ghcr paket sürümlerini
API'den listeleyemedim; imajın gerçekten push edildiğini **build job'ının step
sonuçlarından** doğruladım (`Build and push: success`).

**Worktree'de `git checkout main` çalışmaz.** Ana worktree main'i tutuyor;
`git checkout -b <yeni> origin/main` diyerek dallandım — ama merge sonrası `git fetch`
etmediğim için branch bayat bir `origin/main`'e oturdu ve tüm dosyalar "değişmiş"
göründü. Merge'den sonra dallanmadan önce `git fetch origin`.

## 2026-07-28 — e2e-full'e her-koşuda Türkçe özet e-postası (+ hızlı-main dersleri)

**Paralel oturum çarpışması (iki kez!):** Aynı gün başka oturumlar (a) smoke gate'i
çoktan shiplemiş, (b) benim "self-hosted'a taşı" PR'ımın tam tersi yönde #956'yı merge
etmişti (repo public olunca hosted runner bedava → her şey hosted'a geri). Ders: PR'ı
yeniden inşa etmeden önce SON main'i tekrar incele ve "bu iş hâlâ gerekli mi, hangi
parçası kaldı?" sorusunu sor. Ben kapsamı iki kez daralttım: sonunda kalan tek eksik,
kullanıcının istediği her-koşuda "X/Y test geçti" heartbeat maili idi — onu restore
edilmiş hosted e2e-full'e ekledim (shard başına JSON raporu + always() report job'ı).

**Conflict'li PR = 0 workflow:** Base'i geride kalmış PR'da `pull_request` check'leri
HİÇ tetiklenmez (0 check run + `mergeable_state: dirty/unknown`); "CI koşmuyor" diye
debug etmeden önce buna bak. `merge-tree` ile conflict'i push'lamadan görebilirsin.

**Sharded koşuda özet:** her shard'a `PLAYWRIGHT_JSON_OUTPUT_NAME` + `--reporter=list,html,json`,
JSON'ları artifact olarak topla, `E2E_EXPECTED_REPORTS` ile "shard çöktü ama rapor yok →
sahte yeşil" tuzağını kapat. Süre = shard'ların max'ı, toplamı değil.

**Ultracode limiti:** 8 agent'lık workflow hesap limitine takılıp 0 agent'la döndü; ana
oturum çalışmaya devam edebildi — işi inline bitir, `resumeFromRunId` cebinde dursun.

**Write tool + ESC baytı:** regex'e `\x1b` yazarken dosyaya ham ESC gömülebilir; `cat -A`
ile kontrol et; ANSI'li fixture'ları heredoc yerine python/json ile üret.

## 2026-07-28 — Bekleyen backlog işleri (batch), proje tabanlı mesajlaşma zinciri

### Alt-ajanlar bir anda tamamen kullanılamaz hale gelebilir — planı buna göre kur

Bir workflow'un iki ajanı da **hiçbir dosya değiştirmeden** BLOCKED döndü. Sebep
harness'ın permission katmanıydı: her araç çağrısı şu hatayla reddedildi —

```
The permission handler returned updatedInput for <Tool> that failed schema validation:
The required parameter `<param>` is missing
```

Kaybolan parametreler: `Read`→`file_path`, `Bash`→`command`, `Glob`/`Grep`→`pattern`,
`Write`→`file_path`+`content` (ikisi birden), `ToolSearch`→`query`. Yani `updatedInput`
boş obje olarak dönüyor; girdinin bir kısmı değil **tamamı** düşüyor. Deterministik,
retry çözmüyor. `ToolSearch`'ün de reddedilmesi kritik: deferred araçları yükleyip
GitHub üzerinden dosya okuma kaçış yolu da kapanıyor.

Dersler: (1) **Ajan raporlarını `git status` ile doğrula** — bu ikisi dürüsttü ama
"yaptım" diyen bir ajan da olabilirdi. (2) Ajanlar tahmine dayalı kod yazmayı
reddettiği için doğru davrandı; repoyu okumadan yazılan kod geri uyumu sessizce
bozardı. (3) Blokaj altyapısalsa aynı görevi tekrar spawn etmek aynı sonucu verir —
işi kendin yaz. Bu oturumda #769 ve #770'in tamamı elle yazıldı.

### `prisma validate` şema-DB farkını görmez; `db push` tuzakları yalnızca deploy'da patlar

İki kez düştüm, ikisi de yerelde **tamamen sessiz**:

1. **FK kolonuna `@@index` eklemek.** `ConversationParticipant`'a `@@index([userId])`
   ekledim. MySQL FK için o indeksi zaten tutuyor; Prisma onu `..._userId_idx` adına
   çevirmek isteyip DROP+CREATE denedi, MySQL de FK'nin dayandığı indeksi düşürmeyi
   reddetti: `Can't DROP INDEX 'ConversationParticipant_userId_fkey'`. **İnce tarafı:
   bu tuzak yalnızca tablo zaten deploy edilmişse kurulur** — Prisma tabloyu sıfırdan
   yaratırken indeksi kendi kurar, FK onu yeniden kullanır, sorun görünmez. FK kolonuna
   ayrı indeks zaten gereksiz.
2. **Varsayılansız `NOT NULL` kolon.** `Conversation.updatedAt`'i `@default` olmadan
   ekledim; tabloda satır olsa `db push` orada duracaktı. `@default(now())` çözdü.

`prisma format`/`validate`/`generate` üçü de geçti — şema geçerliydi, sorun şemanın
**canlı tabloyla farkı**. Paylaşımlı DB'ye `db push` yasak olduğu için bu sınıfı ancak
topic deploy gösterir; doğru yerde yakalandı ama hata mesajı **ilk başarısız adımda
kesiliyor**, o yüzden bir tuzağı düzeltirken sıradakini de arayın.

### Projects v2 kolonu bu ortamdan yazılamıyor — otomasyon tek çıkış

`CLAUDE.md` "kartı ilgili kolona taşı" diyor ama: Projects v2 **yalnızca GraphQL** ile
yazılır (REST karşılığı yok), GraphQL bu oturumda kapalı ("only the pinned set of
PR-review operations"), doğrudan REST 403, MCP'de Projects v2 aracı yok. `Status` alanı
`list_issue_fields`'de de **görünmez** — o yalnızca org seviyesi issue alanlarını
(`Priority`, `Start date`, `Target date`, `Effort`) döndürür; `Status` board'un kendi
alanı. Yapılabilen: issue atama + `Start date`. Kalıcı çözüm `.github/workflows/
project-status.yml` (bu oturumda eklendi) — `PROJECTS_TOKEN` secret'ı gerekiyor,
çünkü varsayılan `GITHUB_TOKEN` Projects v2'ye yazamaz.

### Küçük ama zaman yakan şeyler

- **`npm run build | head` yapma.** SIGPIPE build'i yarıda kesip `.next`'i bozuk
  bırakıyor, sonraki koşu yanıltıcı `ENOENT: routes-manifest.json` veriyor. Çıktıyı
  dosyaya yaz, sonra `grep`le.
- **e2e'yi koşturmak için DB'yi apt'den kur.** Ben "docker yok, o yüzden imkânsız"
  diye bıraktım ve spec'i çalıştırmadan gönderdim; aynı gün başka bir oturum doğru yolu
  bulmuş (yukarıdaki güvenlik denetimi girdisi): docker daemon gerçekten yok ama
  `apt-get update && apt-get install -y mariadb-server` çalışıyor. **Ders: "docker yok"
  ile "yerel DB imkânsız" aynı şey değil** — paket yöneticisini denemeden vazgeçme.
  Yine de çalıştıramadıysan PR'da açıkça yaz, "test ettim" deme; `@smoke`'a eklemezsen
  ilk gerçek koşu gecelik tam takımda olur.
- **e2e locator'ını dil metnine bağlama.** `getByRole('button', {name:/send|gönder/i})`
  yerine `data-testid`. `MessageComposer` zaten `sendTestId`/`textareaTestId` kabul
  ediyor.
- **Merge sonrası dal:** squash merge'den sonra uzak dal squash öncesi commit'i tutuyor
  ve normal push reddediliyor. `git diff --stat origin/main origin/<dal>` boşsa içerik
  main'de demektir, `--force-with-lease` güvenli.
- **Kuyrukta iş var ama hiçbiri çalışmıyorsa runner ölmüştür — "meşgul" değil.** Bunu
  ilk seferinde yanlış okudum: `topic` 30 dk "queued" kaldı, ben "runner meşgul" sandım.
  Doğru sinyal: `list_workflow_runs status=in_progress` → **0** iken `status=queued` → 10.
  Meşgul bir runner'da en az biri `in_progress` olur. Ayrıca kuyruktaki işin
  `runner_id: 0` / `runner_name: ""` olması "hiçbir runner almadı" demektir.
  Kök sebep runner servisi değil sunucunun kendisiydi: `runner-watchdog` (hosted runner'dan
  SSH deniyor) `Connection timed out` ile patladı — yani watchdog da kurtaramaz, çünkü
  kurtarmak için SSH gerekiyor. Bu kesinti prod deploy'unu da bloke etti.
  **Bu tek-runner kırılganlığı #955 ile çözüldü** (imajlar yine GitHub-hosted runner'larda
  derleniyor), o yüzden "topic ~15 dk sürer" gözlemim artık geçersiz.

### Mevcut nullable kolonun alt uçlarını kontrol et

#768 `Message.relationId`'yi nullable yaptı. Alt uçlar (`PATCH`/`DELETE
/api/messages/[id]`, `[id]/reactions`, `attachments/[id]`) hepsi
`getThreadIfAllowed(message.relationId)` ile yetkilendiriyordu ve `null`'da fail-closed
dönüyordu: konuşma mesajı **gönderilebilir ama düzenlenemez, silinemez, tepki alamaz,
eki indirilemez**. Ortak bir `canAccessMessage()` gerekti. Bir kolonu nullable yaparken
onu okuyan **tüm** yetki yollarını greple.

Ayrıca: yetkiyi *katılımcılık* ile *canlı izin* olarak ayırmak gerekti. Okuma kalıcı
(geçmiş kaybolmasın), yazma yeniden kontrol ediliyor (`canPostToConversation`) — yoksa
projeden çıkarılan üye süresiz yazmaya devam ederdi.


## 2026-07-31 — #787'nin ikinci conflict turu: sürüm defter tutma + merge sonrası doğrulama

Aynı PR bir kez daha çakıştı: 2026-07-29'daki çözüm `main`'i 98bf718'de yakalamıştı,
merge edilene kadar `main` 85df9f7'ye ilerledi. Bu turda çakışan 5 dosyanın 4'ü saf
**sürüm defter tutması**ydı, sadece biri kod.

### Bayat bir PR'da sürüm çakışması her zaman "bump'ı main'in üstüne taşı" demek

`package.json` / `package-lock.json` / `CHANGELOG.md` / `releaseNotes.ts` dördü birden
çakışıyorsa düşünülecek bir şey yok, mekanik bir kural var: **yeni sürüm = main'in
sürümü + patch** (burada 0.28.1-beta → 0.28.2-beta), sonra CHANGELOG bölüm başlığını
*ve* `releaseNotes.ts` girdisini o sürüme + bugünün tarihine yeniden yazıp main'in
girdilerinin üstüne koy. Dalın kendi eski sürüm numarasını (0.27.1-beta) korumak
CHANGELOG'u geçmişe sıralar ve `/release-notes`'ta yanlış sırayla görünür.

`package-lock.json`'da aynı çakışma **iki** yerdedir (kök `version` ve
`packages[""].version`) — biri gözden kaçarsa dosya sessizce tutarsız kalır:

```
perl -0pi -e 's/<<<<<<< HEAD\n(\s*)"version": "X",\n=======\n\s*"version": "Y",\n>>>>>>> origin\/main\n/$1"version": "Z",\n/g' package-lock.json
```

### Yan yana import çakışması = iki tarafı da al, ama gövdeyi oku

`src/app/api/mentor/email/route.ts`'te tek çakışma iki komşu `import` satırıydı
(dalın `emailAllowed`'ı, main'in `TEXT_LIMITS`'i). Çözüm bariz — ikisini de tut — ama
asıl iş dosyanın **geri kalanını** okumak: iki değişikliğin bağımsız olduğunu
(zod şeması hâlâ `TEXT_LIMITS` ile sınırlıyor, gönderim hâlâ `messages` opt-out'una
bağlı, `InteractionLog` her hâlükârda yazılıyor) doğrulamadan "sadece import'tu"
denemez. Otomatik merge olmuş hunk'lar conflict marker'ı üretmez ama semantiği bozabilir.

### `gh pr merge --auto` bu repoda "şimdi merge et" demek

Bu depoda **required status check yok**. Yani `--auto`, PR mergeable olur olmaz
squash'ı geçiriyor — smoke gate'in raporlamasını *beklemiyor*. #787 çakışma çözümü
push edildikten ~saniyeler sonra, `Lint · Typecheck · Build` ve `Playwright smoke`
daha başlamadan merge oldu. CI'ın gerçekten kapı görevi görmesini istiyorsan merge'den
önce kendin `gh pr checks --watch` ile bekle; yerel `npx tsc --noEmit` +
`npm run check:i18n` bu yüzden merge öncesi tek gerçek güvence oluyor.

### `main`'deki push-run'ın "cancelled" olması hata değil

`main`'e arka arkaya merge geldiğinde her yeni push, workflow'un concurrency grubu
üzerinden bir öncekinin push-run'ını iptal ediyor. #787'nin (f639d8f) smoke run'ı
böyle iptal oldu, ardından #789'unki (9b975fd) de. **Cancelled'ı regresyon sanma** —
doğrulamayı commit'inin *herhangi bir ardılında* yeşil olan en yeni run üzerinden yap;
sabit bir sha'yı izlemek yoğun bir günde hiç sonuçlanmıyor.

## 2026-07-29 — Uzun süre açık kalmış PR'ın conflict'ini çözme (#787 / #668)

### Eski bir PR'ı çözmeden önce iki tarafı da merge-base'e karşı diff'le

#787 açık kaldığı sürede `main` **aynı işi bağımsız olarak yapıp** 0.26.0'da göndermişti
(#668 denetimi). 10 dosya çakıştı. Reflex olarak "HEAD benim dalım, onu koru" demek
burada yanlış olurdu — `main`'in uygulaması her çakışan dosyada daha iyiydi
(markalı `emailBrand`/`brandHeader` şablonları vs. dalın satır-içi HTML'i;
`NOTIFICATION_CATEGORIES.map()` vs. elle yazılmış liste; yeniden yazılmış idempotent
`sendMeetingReminders`).

**Yöntem:** `MB=$(git merge-base origin/<dal> origin/main)`, sonra **iki** diff'i
yan yana oku:

```
git diff $MB origin/<dal> -- <dosya>
git diff $MB origin/main  -- <dosya>
```

`git diff HEAD` veya sadece conflict marker'larına bakmak yetmiyor; aynı sorunun iki
farklı çözümünü görmeden hangisinin daha iyi olduğuna karar veremiyorsun. Bu diff
çiftinden sonra "çakışan her şeyde `--theirs`, dalın **geri kalanı** korunur" net bir
karar oldu — ve PR'ın gerçekten katkısı olan 3 şey ortaya çıktı:
`POST /api/mentorship`'in tamamen sessiz olması (main sadece *talep onayı* yolunu
kapatmış, doğrudan atamayı atlamış), `POST /api/mentor/email`'in `messages` opt-out'unu
yok sayması, ve cron e-posta hata yönetimi.

### `git checkout --theirs` tüm dosyayı alır — kısmi çözüm için `checkout -m`

`emailService.ts`'te iki hunk çakışıyordu ama dosyanın **başka** yerlerinde dalın
otomatik merge olmuş faydalı değişiklikleri (try/catch + hata loglama) vardı.
`git checkout --theirs <dosya>` stage 3'ün tamamını yazıyor, yani o otomatik merge olmuş
kısımları da siliyor. Fark etmezsem PR'ın gerçek katkısının bir bölümü sessizce kaybolurdu.
Kurtarma: `git checkout -m <dosya>` conflict'i geri getiriyor, sonra sadece marker'lı
hunk'ları elle çöz.

**Ders: `--theirs`/`--ours` yalnızca dosyanın *tamamı* karşı tarafa gidecekse doğru.**
Karma dosyada `checkout -m` + elle hunk çözümü gerekiyor. Çözümden sonra
`git diff origin/main -- <dosya>` ile "dalın main üstüne gerçekten ne kattığı"nı doğrula —
beklediğin katkı orada görünmüyorsa bir şeyi ezmişsin.

### Kategori adı değişirse e2e assert'lerini de taşı

Dal `applications` + `mentorshipRequests` kategorilerini eklemişti, main tek bir
`mentorship` ile aynı kapsamı çözdü. `notif-prefs.spec.ts` "New applications" toggle'ını
assert ediyordu — artık var olmayan bir UI. `tsc` bunu yakalamıyor (Playwright locator'ı
string), `check:i18n` de yakalamıyor (anahtar zaten silinmiş). Çözüm tarafında sözlük
anahtarı/kategori adı değiştiyse **spec'leri greple**: `grep -rn "<eski-kategori>" e2e/`.

### Başka birinin PR'ında scope

PR sahibi başka bir katkıcı olduğunda retrospektifi o dala **commit'lemeyin** — diff'i
kirletiyor. Ayrı `docs/` dalı + ayrı PR (bu giriş öyle geldi).
## 2026-07-28 (2. tur) — #782 takibi: limitler DB ile uyumsuzdu + deploy güveni

**"Özellik canlıda yok" şikâyetini önce shallow clone ile doğrula.** Konteynerdeki
klon `--depth 50` ile geliyor ve `origin/main` ref'i bayat olabiliyor: `git
merge-base --is-ancestor 5486563 origin/main` "değil" dedi, `git fetch origin main`
sonrası aynı commit main'in içinde çıktı. Yani #782 hem merge'lenmişti hem canlıydı.
Herhangi bir "bu commit main'de mi?" iddiasından önce `git fetch` veya
`git ls-remote origin refs/heads/main` — yerel ref'e asla güvenme. Aynı tuzağın
`infra/deploy-prod.sh`'deki FORWARD_ONLY guard'ını da sessizce **fail-open** yaptığını
bu sayede fark ettim (hiçbir workflow `fetch-depth` set etmiyordu).

**Kullanıcı "canlıda yok" derken çoğu zaman "benim baktığım yerde yok" demek
istiyor.** Sayaç 12 komponente bağlanmıştı ama sweep sadece `src/components/**`
altında gezmiş; 9 raw `<textarea>` kalmıştı ve maintainer'ın ekran görüntüsü tam
olarak onlardan birindeydi (Duyurular). CHANGELOG "her raw textarea değiştirildi"
diyordu, releaseNotes "tüm metin alanları" diyordu — ikisi de yanlıştı. **Sweep
yaparken `git grep -l "<textarea"` ile bitir, iddiayı ondan sonra yaz.**

**Client `maxLength` + server `zod` + Prisma kolon genişliği: üçü tek kaynaktan
gelmeli.** Üçü ayrı ayrı yazıldığı için sayaç, write'ın kaldıramayacağı limitleri
reklam ediyordu — özelliğin amacının tam tersi. En sinsi hâli: `String` (yani
VARCHAR(191)) bir kolona 5 000 karakter vaat etmek. 192 karakterlik normal bir not
Prisma P2000 → 500 veriyordu ve sayaç o noktada hâlâ gri "191/5000" gösteriyordu.
`src/lib/textLimits.ts` açtım; hem zod hem `maxLength` oradan import ediyor.
**`@db.Text` 65 535 BYTE'tır, karakter değil** — utf8mb4'te Türkçe/Almanca metin
karakter başına 2-3 byte, yani güvenli üst sınır ~20 000 karakter.

**Controlled/uncontrolled: `value = ''` default'u react-hook-form'u kırar.**
`Textarea` `value={value}` bağlıyordu, `register()` ise `value` döndürmüyor →
CompanyForm'un açıklama kutusu kalıcı olarak boş bir controlled input olmuştu, yani
**hiç yazı yazılamıyordu**. Ortak bir input komponentine `value` default'u koyma;
`value !== undefined` ise controlled, değilse state'e mirror'la.

**Ortak komponente sarmalayıcı `div` eklerken çağıran tarafın layout class'ını
taşı.** `<textarea className="flex-1">` → `<Textarea className="flex-1">` sessiz bir
layout regresyonu: artık flex child sarmalayıcı div, `flex-1` içteki textarea'ya
gidiyor ve hiçbir şey yapmıyor. `wrapperClassName` prop'u ekledim.

**Test yokluğu "scheduling" ile açıklanmaz.** Sayaç için 215 spec'lik suite'te tek
assertion yoktu; `announcements.spec.ts` ~25 karakterlik string post ediyordu, tüm
interaction spec'leri 'Weekly sync' gibi notlar kullanıyordu. Smoke gate suçlu
değildi — 4x/gün koşan full suite'te de yoktu. **Bir limiti test edecekseniz limitin
yakınında bir değer kullanın**; happy-path uzunlukları hiçbir sınırı egzersiz etmez.

**Deploy güvensizliği haklıydı ama sebep tahmin edilenden farklıydı.** Regresyon ya
da force-push yoktu; ikisi de `workflow_dispatch`-only idi. 46 deploy-prod koşusunun
#803'ten öncekilerin hepsi manueldi, deploy-preview'un toplam 5 koşusu vardı ve
preview 07-21'den beri 72 commit geride duruyordu. **"Merge = deploy" invaryantını
iddia eden her repoda gerçek koşu geçmişini `actions_list` ile doğrula** — header
yorumu değil, `event` alanı söyler. `git log`'da görünmeyen tek şey neyin deploy
edildiğidir.

**Yeşil bir job "her şey yolunda" demek değildir.** İki sessiz durum buldum: (1)
FORWARD_ONLY refuse yolu `exit 0` ile SUCCESS raporluyordu, yani prod main'in
dışında sonsuza kadar sabitlenebiliyordu; (2) health check kök sayfayı curl ediyordu
— bozuk `DATABASE_URL`'li konteyner de 200 döner ve hangi build'in koştuğunu
söylemez, üstelik drift gate kararını aynı endpoint'in `sha`'sından veriyor. Deploy
sonrası **ne deploy ettiğini doğrula**: `/api/health?db=1` + served `sha == ${GIT_SHA:0:7}`.
Reddedilen/atlanan deploy `::warning::` + step summary yazsın.

**Sunucuda build eden bir pipeline, kendi düzeltmesini de rehin alabilir.** 22:00
civarı `deploy-prod` #51 imajı hâlâ sunucuda build ediyordu (#956 öncesi yol);
`next build` **exit 255** (bu repoda belgelenen OOM imzası) ile öldü ve hemen
ardından "The runner has received a shutdown signal" geldi. Sonuç zinciri: box
SSH'e kapandı (watchdog #19 → `connect ... Connection timed out`, oysa #17/#18
başarılıydı), üç ortam da 503 döndü (prod + preview + `crm-pr946` topic), ve
self-hosted runner düştüğü için kuyruktaki deploy'lar (#53, #55) başlayamadı —
**o kuyrukta duran şey tam olarak sunucuda build etmeyi bitiren #956'ydı.**
Ders: kök nedeni ortadan kaldıran değişiklik, kök nedenin bozduğu altyapıya
bağımlıysa kurtarma yolu yoktur. Böyle bir geçişte hosted bir kaçış yolu bırak.

**"Ortam ayakta mı?" sorusunu kendi ağ yolunu doğrulamadan cevaplama.** HTTPS
`Connection reset by peer` verirken `http://` **503** döndü — yani nginx ayakta,
container yok. `example.com` ve `api.github.com` 200 dönüyordu, dolayısıyla sorun
sandbox'ta değildi. Bir kesinti bildirmeden önce: (1) başka bir dış host'a curl,
(2) 80 ve 443'ü ayrı dene, (3) `$HTTPS_PROXY/__agentproxy/status`. Aksi hâlde
proxy arızasını prod kesintisi diye rapor etme riski var.

**Container swap'ın geri dönüş hedefi yok — bu artık teorik değil.** PR #946'da
"kapsam dışı" diye not ettiğim şey aynı gece canlı kesintiye dönüştü:
`docker stop`/`rm`, `docker run`'dan önce çalışıyor ve `docker image prune -af`
önceki imajı siliyor. Doğrusu: yeni container'ı geçici adla başlat, health-check
et, ancak sonra eskiyi kaldır.

**Hızlı akan bir main'de PR'ı elde merge etmeye çalışmak yarış kaybettirir.**
Bu oturumda main inceleme sırasında ~10 commit ilerledi; üç kez elle merge
denedim, her seferinde tazE bir çakışma. Doğru hamle: çakışmayı çöz, push et ve
**auto-merge (squash) aç** — gate yeşile döndüğü anda kendisi girer. Ayrıca
`topic` check'i self-hosted; runner düşükken sonsuza kadar `queued` kalır, bu
yüzden onu beklemeyin (zorunlu check değil).

---

## 2026-07-28 — Uygulamayı gerçek kullanıcı gözüyle gezip backlog doldurma (SO/PSO turu)

**Docker olmayan Claude Code web container'ında yerel DB: MariaDB'yi apt ile kur.**
`docker-compose.dev.yml` bu ortamda çalışmıyor (docker daemon yok). Çalışan yol:
`apt-get update && apt-get install -y mariadb-server` → `mkdir -p /var/run/mysqld &&
chmod 777 /var/run/mysqld` (aksi hâlde "Bind on unix socket: No such file or
directory") → `nohup mariadbd --user=root --datadir=/var/lib/mysql --port=3306 &`.
MariaDB'de `root` unix_socket ile doğrulanır, Prisma TCP ile bağlandığı için
"Access denied for user 'root'@'localhost'" alırsınız — ayrı bir kullanıcı açın:
`CREATE USER 'crm'@'127.0.0.1' IDENTIFIED BY 'crm'; GRANT ALL …`. Sonrası standart:
`.env` → `prisma db push` → `prisma db seed` → `npm run seed:demo`.
`apt-get install` ilk denemede 404 verirse önce `apt-get update` çalıştırın.

**Playwright ile tur atarken hidrasyonu bekleyin.** `page.goto` + hemen
`fill/click` yaparsanız form React hidrasyonundan önce **native GET submit**
ediyor: `GET /auth/signin?email=…&password=…` → giriş sessizce başarısız, tüm tur
anonim olarak dönüyor (ve fark etmek zor, çünkü sayfalar 200 dönüyor). `waitUntil:
'load'` + ~3 sn bekleme + `getByRole('button')` ile tıklama sorunu çözdü. Turun
gerçekten giriş yaptığını her rol için loglayın (`--- mentor logged in -> /mentor`).

**Ekran turunda "2 saniye" ile "9 saniye" farklı ürünler gösteriyor.** Client
bileşenleri boş dizi ile başlayıp `useEffect`'te veri çektiği için ilk saniyelerde
**yanlış boş durum** görünüyor ("Henüz atanmış mentee yok" — oysa 3 mentee var).
Screenshot'ı 2,5 sn'de alırsanız bunu bug sanır, 9 sn'de alırsanız hiç görmezsiniz.
Her iki anı da yakalayın: bu, gerçek bir UX bulgusu (#891) ve tek başına en çok
"bu uygulama veri mi kaybetti?" hissi yaratan sınıf.

**Chromium yolu:** `/opt/pw-browsers/chromium/chrome-linux/chrome` yok;
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` var. `executablePath` ile
doğrudan verin, `playwright install` çalıştırmayın.

**MCP `sub_issue_write` yanıtı ebeveyn issue'nun tüm gövdesini döndürüyor.**
Uzun gövdeli epic/story'lerde her bağlama çağrısı binlerce token; 38 task'ı
bağlamak bağlam bütçesinin ciddi kısmını yiyor. Önce **tüm** issue'ları oluşturup
(create yanıtı kısa: id + url), child id → parent number eşlemesini bir dosyaya
yazın, bağlamayı en sona bırakın — böylece bağlam özetlenirse eşleme kaybolmaz.

**Hiyerarşiyi bitirdikten sonra kökü de doğrulayın: epic'ler #736 `[_ROOT_]`
altına bağlanır.** Task→Story ve Story→Epic bağlarını kurup "ağaç tamam" dedim;
kullanıcı "epic'ler de root'a bağlandı mı?" diye sorunca 5 epic'in de parentsız
kaldığını gördüm. Bu repoda tek bir kök issue var (#736) ve ürün epic'leri
(#417, #478, #517, #714, #717, #796–#805) ona bağlı — board'un *Group by →
Parent issue* görünümü tek ağaç göstersin diye. `backlog` skill'i bunun tersini
söylüyordu ("never a mega-parent; No Parent holds the top-level epics"); skill'i
gerçeğe göre düzelttim. Ders: **oluşturma bittiğinde `issue_read`
(`get_sub_issues`) ile #736'yı ve her epic'i okuyup her kalemin tam olarak bir
ebeveyni olduğunu doğrulayın**, raporu ondan sonra yazın. (Not: geçen seansın 8
güvenlik epic'i #814–#829 hâlâ root'a bağlı değil.)

**Skill dosyası ile repo gerçeği çeliştiğinde repoyu kaynak alın ve skill'i
düzeltin.** Yanlış talimat sessizce yanlış çıktı üretiyor ve bir sonraki oturum
aynı hatayı tekrarlıyor; düzeltme maliyeti iki satır.

**Aynı gün paralel oturumlar aynı dosyanın sonuna yazıyor: `agent-experience.md`
çatışması normaldir, çözümü "ikisini de tut".** Bu PR'da `origin/main` iki kez
ilerledi ve iki kez aynı yerde çatıştı (bir oturum deploy kaydı, biri HR/PO turu
kaydı ekledi). Doğru çözüm birini seçmek değil: main'in bölümü önce, kendi
bölümün sonra, aralarına `---`. Merge'den önce `git fetch origin main` +
`git merge origin/main` yapıp çatışmayı **kendiniz** çözün; PR'ı merge etmeye
çalışıp 405 `Pull Request has merge conflicts` almak zaman kaybı.

**"Şu kalem hâlâ eksik" gibi durum notlarını yazmadan önce API'den doğrulayın —
paralel oturum düzeltmiş olabilir.** Skill'e "#814–#829 root'a bağlı değil" diye
yazdım; merge öncesi kontrolde başka bir oturumun **#951 `Initiative` şemsiyesi**
açıp 8 epic'i ona bağladığı çıktı (ama #951'in kendisi parentsız → board'da iki
kök). Not yanlış yayınlanacaktı. Kural: hiyerarşi/durum iddiasını `issue_read`
(`get`/`get_parent`/`get_sub_issues`) ile teyit et, sonra yaz.

## 2026-07-29 — #958 kök neden: lazy PrismaPromise × AsyncLocalStorage

Zamanlanmış tam suite'i 11 Temmuz'dan beri kırmızı tutan deterministik hata
(`e2e/tenant-isolation.spec.ts:85`) gerçek bir ürün açığıydı: **Prisma sorgu
promise'leri lazy** — sorgu (ve `$use` middleware'i) ilk `.then()`'de ateşlenir.
`runWithOrg(org, () => prisma.x.findMany())` deseninde `await` dışarıda olunca
abonelik ALS bağlamının dışında gerçekleşiyor, middleware `currentOrgId() =
undefined` görüp org filtresini sessizce atlıyordu. Çözüm: `runWithOrg` thenable
dönen fn'lerde aboneliği bağlamın içinde başlatır (`new Promise((res, rej) =>
result.then(res, rej))`). Ders: ALS + lazy-client kombinasyonunda bağlam,
promise'in YARATILDIĞI yerde değil `.then()`'in çağrıldığı yerde okunur —
context-bağımlı her sarmalayıcı thenable'ları içeride abone etmeli.

Repro tekniği: hipotezi tek dosyalık geçici bir spec ile izole et (aynı sorgu,
await içeride vs dışarıda) — `node --experimental-strip-types` repo'nun uzantısız
relative import'larında çalışmıyor, Playwright runner'ı kullan. Lokal DB: apt
MariaDB (playbook'taki yol) sorunsuz.

## 2026-07-31 — Zamanlanmış koşunun 2 kırmızısı: merge'den kalan "hayalet" assertion + oturum değiştirme yarışı

**Bir merge, bileşeni main'den + spec'i branch'ten alabilir.** #786
(goals sıralama/arşiv) merge edilirken `GoalsPanel` main'in sürümüyle (#918,
sayaçlar) çözülmüş ama spec branch'in sürümüyle (ilerleme çubuğu, `0/2
completed`) kalmış → spec artık hiç render edilmeyen markup'ı doğruluyordu. PR
gate sadece `@smoke` koştuğu için bu drift ancak gece koşusunda görüldü. Ders:
aynı özelliğin UI'ı ve spec'i birlikte çakıştıysa **ikisini birden oku**;
`git log -S'<assertion metni>' -- <spec>` ve `git show <branch-tip>:<component>`
hangi tarafın kazandığını 10 saniyede söylüyor. Yan kontrol: aynı özelliğin
*diğer* spec'i (`goals-archive-sort`) doğru sayaçları kullanıyordu — iki spec
aynı UI için farklı şey iddia ediyorsa biri bayattır.

**`clearCookies()` NextAuth oturumunu bitirmeye yetmiyor.** Ayrılmakta olduğun
sayfa `/api/auth/session`'ı çağırmayı sürdürüyor ve NextAuth bu yanıtlarda
session cookie'sini yeniden yazıyor; temizlikten hemen sonra düşen bir yanıt
oturumu geri getiriyor. `/auth/signin` `status === 'authenticated'` görüp bir
önceki kullanıcının paneline yönleniyor — test hâlâ forma yazarken. Doğrusu:
önce `page.goto('about:blank')` (eski sayfa ve istekleri ölsün), sonra temizlik,
üstelik **sadece** `next-auth.session-token` — komple `clearCookies()`
`storageState`'ten gelen consent cookie'sini de siliyor ve banner formun üstüne
geri geliyor. `e2e/helpers/auth.ts` → `signInAsFreshUser()`.

**Kapsamlanmamış locator, yönlendirmede başka sayfada bir butona bağlanıyor.**
`page.click('button[type="submit"]')` yönlendirmeden sonra mentee portalındaki
*disabled* "Add goal" butonuna denk geldi ve 15 sn action timeout'u boyunca
sessizce onu denedi. Submit'i formun içine kapsamla
(`page.locator('form', { has: page.locator('input[type="password"]') })`) —
yönlendirme olursa test hızlı ve okunur şekilde düşer.

**Playwright'ın `getByText`'i `<textarea>`/`<input>` value'larını da eşliyor.**
`notes.spec` düzenlemeden hemen sonra `getByText('<yeni metin>')` bekliyordu; bu
daha PATCH gönderilmeden, açık editöre yazdığımız metinle eşleşti ve peşindeki
Prisma okuması yazmayla yarıştı (flaky). Doğrusu: editörün kapanmasını bekle
(`expect(note.locator('textarea')).toHaveCount(0)`), sonra metni/DB'yi doğrula.

**Teşhis yolu:** `gh run view --log-failed` bu repoda sadece cleanup loglarını
döküyor (asıl hata "Run full E2E suite" adımının içinde). İşe yarayan:
`gh run view --log --job <id>` (worktree'de cwd repo kökü değilse `-R owner/repo`
şart) + `gh api repos/<o>/<r>/actions/artifacts/<id>/zip` ile
`playwright-report-full-shard-N`'i indirip `data/*.md` (error-context) ve
failure screenshot'ına bakmak — ekran görüntüsü "mentee portalındayız" diyerek
hipotezi tek karede doğruladı.

## 2026-07-31 — #973'ün conflict'i: iki PR aynı sürüm numarasını kaptığında

#787'nin kuralı ("bump'ı main'in üstüne taşı", yukarıda) burada bir varyantla karşılaştı:
dal **kendi sürümünü main'de zaten kullanılmış** bir numaraya bump etmişti. #973 ve
#972 (#879 anket kopyası) bağımsız olarak `0.28.4-beta` iddia etmişti, dolayısıyla
`CHANGELOG.md` ve `releaseNotes.ts` çakışmaları *aynı sürüm başlığının altında* iki
farklı içerik olarak göründü — "hangi taraf?" değil, "iki taraf da ama farklı sürümde"
sorusu. Çözüm: main'in `0.28.4-beta` bölümünü **olduğu gibi bırak** (o zaten merge oldu,
tarih sırası doğru), dalın girdilerini main'in tepesinin bir üstüne (`0.29.1-beta` →
`0.29.2-beta`) yeni bir bölüm/`RELEASE_NOTES` girdisi olarak taşı. Çakışma bloğunun
içinde kendi metnini korumaya çalışmak CHANGELOG'da tek sürüm başlığı altında iki ayrı
release yaratır.

**`main`'in `package-lock.json`'ı `package.json`'la senkron olmayabilir.** Burada main'in
lock'u hâlâ `0.28.4-beta` derken `package.json` `0.29.1-beta`'daydı — yani lock
çakışmasında "main tarafını al" yanlış cevap. Her iki yerdeki (`version` +
`packages[""].version`) değeri de yeni sürüme elle yaz, tarafları seçme.

**Worktree'de `node_modules` yok, ama bu her şeyi durdurmuyor.** `npx prisma generate` ve
`npm run check:i18n` (tsx'i npx indirdi) `npm install` olmadan çalıştı; `npm run build`
için install şart. Install sonrası `package-lock.json`'a darwin'e özgü tek bir
gürültü hunk'ı düşüyor (`fsevents` girdilerine `"dev": true`) — bunu commit'e karıştırma,
`git checkout package-lock.json` ile at, sonra build'i çalıştır.

**Ek tur (aynı gün):** conflict çözülüp CI yeşile döndükten sonra, auto-merge kuyruktaki
image build'i beklerken `main`'e #977 girdi ve *aynı üç dosya* yine çakıştı (`0.29.2` →
main `0.30.0`, bizim entry `0.30.1`'e taşındı). Bu depoda `main` saatte birkaç kez
ilerliyor, yani sürüm defter tutması çakışması **çözülünce kapanmıyor** — merge kuyruğunda
beklerken tekrar açılıyor. Pratik sonuç: çözümü push ettikten sonra dalı bırakıp gitme;
merge olana kadar `gh pr view --json mergeable` ile izle, tekrar `DIRTY` olursa aynı
mekanik kuralı uygula. Üçüncü turda `npx tsc --noEmit` + `check:i18n` tam `npm run build`
yerine yeterli hızlı güvence (çakışan dosyalar sadece CHANGELOG/releaseNotes/sürüm ise).

## 2026-07-31 — Bakımcının macOS'unda çalışırken: lokal DB yok, tek `.env` preview'a bakıyor

**Bu depo iki farklı ortamda geliştiriliyor ve doğrulama imkânları aynı değil.** Playbook'un
"lokal DB: apt MariaDB" yolu Claude Code web container'ı için geçerli; bakımcının
Mac'indeki worktree'de ise `mysql`/`mysqld`/`mariadb` PATH'te yok, brew ile kurulu değil ve
`docker ps` "Cannot connect to the Docker daemon" diyor. Üstelik depodaki tek `.env`
(`~/Desktop/github/Internship/.env`) `DATABASE_URL`'i **paylaşılan preview DB'sine**
(`crm-preview.ersah.in`) yönlendiriyor — yani DATA_ACCESS_POLICY ve "paylaşılan DB'ye
`db push` yok" kuralı gereği DB'ye dokunan bir UI'ı tarayıcıda kendin doğrulayamıyorsun
(oturum açmak bile DB istiyor). Pratik sonuç: bu makinede `tsc --noEmit` + `lint` +
`build` + `check:i18n` derleme güvencesi, **fonksiyonel** kanıt ise CI'daki e2e (kendi MySQL
service'i var). Bunu PR'da açıkça yaz — "yerelde denedim" izlenimi bırakma. Yeni özelliğin
e2e spec'ini yazmak burada isteğe bağlı değil; tek gerçek doğrulama o.

**`prisma validate`/`generate` dummy de olsa `DATABASE_URL` istiyor.** Worktree'de `.env`
yok, o yüzden ikisi de P1012 "Environment variable not found: DATABASE_URL" ile düşüyor.
`DATABASE_URL="mysql://u:p@localhost:3306/db" npx prisma validate` şeklinde satır içi dummy
ver; `npm run build` için ek olarak `NEXTAUTH_SECRET` + `NEXTAUTH_URL` gerekiyor.

**Sürüm bump'ını dalı `origin/main`'e taşıdıktan SONRA yap.** Worktree'nin base'i açıldığı
andaki `main` — bu turda 4 commit geride kalmıştı (`package.json` worktree'de `0.31.4-beta`,
`origin/main`'de `0.32.1-beta`). Hiç commit atmadan önce fark edilirse en temiz hamle
`git stash -u` → `git reset --hard origin/main` → `git stash pop`: burada
`prisma/schema.prisma` ve `dictionaries.ts` sorunsuz auto-merge oldu ve CHANGELOG çakışması
hiç doğmadı. Yukarıdaki #973 dersinin ucuz versiyonu: çakışmayı çözmek yerine oluşmasını
engelle. (`package-lock.json`'daki sürüm yine `package.json`'la senkron değildi — lock
`0.30.1-beta` derken package.json `0.32.1-beta`'daydı; her iki yeri de elle yaz.)

**JSON gövdesi bekleyen bir route'a multipart eklerken JSON'u koru.** `POST
/api/admin/announcements`'a dosya yükleme eklerken `request.json()`'ı `formData()` ile
değiştirmek üç spec'i (`announcements-feed`, `comms`, `text-limits`) sessizce kırardı —
hepsi `page.request.post(..., { data: {...} })` ile JSON gönderiyor. `content-type`'a
bakıp iki gövdeyi tek şekle normalize et. İki tuzak: FormData'da `undefined` yok, atlanan
opsiyonel alan `null` okunuyor ve zod'un `.optional()`'ı bunu reddediyor (boş olanları
anahtar olarak hiç ekleme); ve `formData()`/`json()` bozuk gövdede exception atıyor —
try/catch olmadan 400 yerine 500 dönüyor.

---

## 2026-07-31 — #935 sabit alt bant × gövde boşluğu (mobil ilk izlenim)

**`fixed bottom-0` bir bant, altındaki içeriği "yok" saymaz — yeri ayrılmadıkça
CTA'yı gömer.** Çerez bandı iPhone 13'te (390×664) görünür alanın %40'ını kaplıyor
ve `/auth/register`'daki "Create Account" butonunun üstüne biniyordu. Çözümü tek bir
bileşene gömmek yerine paylaşılabilir bir mekanizma yaptım: `useFixedBottomInset(ref,
active)` her sabit alt bandın ölçülen yüksekliğini (ResizeObserver ile — bant dil/
yönlendirme değişince yeniden sarılıyor) `<html>` üzerinde `--fixed-bottom-inset`
olarak yayınlıyor, `globals.css` bunu `body { padding-bottom }`'a çeviriyor. Bant
kapanınca değişken `0px`'e dönüyor, artık boşluk kalmıyor. #917'nin mobil hızlı
eylem çubuğu aynı hook'u kullanabilir — ikinci bir mekanizma icat etmeyin.

**Geometrik e2e testi yazdıktan sonra NEGATİF KONTROL yapın.** `globals.css`'teki tek
satırı yorum satırına alıp testi tekrar koştum: `Expected: <= 465, Received: 527` —
tam olarak issue'daki ölçümler (buton alt kenarı 527, bant üst kenarı 464). Bu 30
saniyelik adım olmadan "yeşil" testin hatayı gerçekten yakaladığını bilemezsiniz;
ekran görüntüsü testi yerine `boundingBox()` karşılaştırması da hem hızlı hem stabil.

**Playwright'ı yerelde koşarken `DATABASE_URL`'i EXPORT edin.** `.env` dosyası Next
dev sunucusuna yükleniyor ama test runner'ın kendi process'ine geçmiyor; `e2e/helpers/db.ts`
üzerinden Prisma kullanan specler `Environment variable not found: DATABASE_URL` ile
patlıyor (test mantığında hata yok). `export DATABASE_URL=... && npx playwright test ...`.

**Yerelde `npm run dev` üzerinde koşarken kapsamsız locator'lar Next.js Dev Tools
butonuna çarpıyor.** `e2e/layout.spec.ts:6` yerelde `strict mode violation:
button[aria-haspopup="menu"] resolved to 2 elements` veriyor; ikinci eleman
`<button id="next-logo" aria-haspopup="menu" aria-label="Open Next.js Dev Tools">`,
yani **sadece dev modunda var** (CI `npm run start` ile prod build koşuyor, orada yok).
Değişikliklerimi stash'leyip aynı hatayı aldım → regresyon değil. Ders: yerelde çıkan
bir strict-mode ihlalini ürün hatası sanmadan önce (a) stash'leyip tekrar koş, (b)
eşleşen elemanların `outerHTML`'ini dök.

**Bu container'da Playwright config'i override etmek gerekiyor.** Kurulu build
`chromium-1194`, Playwright 1.61 `chromium_headless_shell-1228` arıyor. Commit
edilmeyen bir `playwright.local.ts` (repo config'ini import edip `use.launchOptions.
executablePath = /opt/pw-browsers/chromium-1194/chrome-linux/chrome` ekler) ile
`npx playwright test --config playwright.local.ts` tüm suite'i çalıştırıyor —
ad-hoc script yazmaya gerek yok. Dosyayı commit'e sızdırmayın.

## 2026-07-31 — Zamanlanmış tam koşudaki "timeout" her zaman flake değil

`e2e-full` raporu `project-dm.spec.ts` için `locator.click: Timeout 15000ms exceeded —
waiting for getByTestId('new-chat-toggle')` dedi. Timeout + tek test = refleks olarak
"flake, rerun" demek cazip; ama burada element **yavaş değildi, hiç render edilmiyordu**.
Ayırt eden sinyal: aynı koşudaki 5 gerçek flake'in hepsi `failed,passed` (retry'da geçti),
bu test `failed,failed`. **Retry deseni, hata tipinden daha iyi bir flake göstergesi.**

Deseni çıkarmanın hızlı yolu (log kazmaya gerek yok) — shard JSON'larını indirip
`status !== "expected"` olanları dök:

```
gh run download <run-id> -D <dir> -p 'e2e-json-shard-*'
# sonra suites'i özyinelemeli gezip t.status + t.results.map(r=>r.status)
```

Kalan 5 flake'in hepsi aynı kökten: signin sonrası yönlendirme, hemen ardından gelen
`page.goto`'yu kesiyor (`Navigation to /mentor/mentees/X is interrupted by another
navigation to /mentor`) ya da signin formu 15 sn içinde gelmiyor. Kod değişikliğiyle
ilgisi yok.

**Kök neden dersi:** `/messages`, "zaten DM'i olanlar" kümesini *yüklediği tüm*
conversation'lardan kuruyordu. 988d791 sorguya proje GROUP sohbetlerini ekleyince, her
proje arkadaşı grup sohbetinin de katılımcısı olduğu için tüm adaylar elendi;
`StartConversationPicker` boş listede `null` döndürüyor, dolayısıyla toggle DOM'a hiç
girmedi. Bir sorgunun kapsamı genişletildiğinde, **o sorgunun sonucunu kullanan her
türetilmiş kümeyi** gözden geçir — tip alanı (`DIRECT`/`GROUP`) select'e eklenmişti ama
filtreye eklenmemişti.

**Doğrulama, MySQL'siz makinede:** bu Mac'te docker daemon kapalı ve MySQL yok, yani
spec yerelde koşmuyor. `e2e.yml`'ye manuel dispatch için opsiyonel `grep` input'u
eklemek (varsayılan `@smoke`) tek bir non-smoke spec'i dalda doğrulamayı sağlıyor —
`e2e-full`'ü dispatch etmek 4 shard koşturur *ve* her koşuda özet e-postası gönderir,
sırf bir testi görmek için istenmeyecek bir yan etki. Input'u shell'e interpolate etme,
env değişkeniyle geçir.

**Worktree'de `npm run lint` çalışmıyor:** worktree ana repo checkout'unun içinde durduğu
için ESLint iki `.eslintrc.json` görüyor ve `Plugin "@next/next" was conflicted` ile
düşüyor. Ortam kaynaklı, değişiklikle ilgisi yok; `npx tsc --noEmit` + `npm run check:i18n`
yerel güvence olarak yeterli, lint'i CI'ya bırak.

## 2026-07-31 — Davranış Kuralları (Code of Conduct), 3 dilde

**"Code of conduct ekle" isteği iki yere birden bakar.** Bu depoda README, LICENSE,
CONTRIBUTING ve SECURITY vardı; GitHub community-standards listesinde eksik olan tek
kalem `CODE_OF_CONDUCT.md`'ydi — ama uygulamanın kendisinde de `/privacy` ve `/terms`
gibi i18n'li kamuya açık sayfalar var. İkisi de yapıldı: depo dosyası katkıcılar için
(kök `CODE_OF_CONDUCT.md` + `docs/code-of-conduct.tr.md` / `.de.md`), uygulama sayfası
(`/code-of-conduct`) program katılımcıları için. Metni Contributor Covenant'ı birebir
kopyalamak yerine projeye göre yazmak daha isabetli oldu: jenerik şablonun kaçırdığı iki
şey burada asıl mesele — mentor ↔ mentee arasındaki güç asimetrisi ve rolün verdiği
erişimle mentee PII'sine ulaşmanın kötüye kullanımı.

**Uygulama içi metinlerde iletişim adresini sabitleme.** Depo dosyasında bakımcının
e-postası doğru; uygulama sayfasında değil — her kurulumun kendi operatörü var.
`privacy` bloğunun kullandığı dil ("bu kurulumun operatörü/yöneticisi") burada da doğru
kalıp.

**Nested worktree'de `npm run lint` yanlış alarm veriyor.** Worktree depo kökünün altında
(`.claude/worktrees/…`) durduğu için ESLint yukarı yürüyüp üst dizindeki `.eslintrc.json`
+ `node_modules`'u da buluyor ve `Plugin "@next/next" was conflicted…` diyerek **exit 1**
dönüyor — değişiklikle ilgisi yok, temiz checkout'ta koşan CI'da çıkmıyor. Gerçek güvence
için `npx tsc --noEmit` + `npm run build` yeterli oldu.

**Sözlükte dizi (array) değerler sorunsuz.** `check-i18n.ts` dizileri `String(v)` ile tek
değer sayıyor, yani madde listelerini `expected: [...]` olarak yazmak parite kontrolünü
bozmuyor (`weekdays`/`topics` zaten öyle). Madde başına `bullet1..n` anahtarı uydurmaya
gerek yok — ama dizi uzunluğu diller arasında tutarlı olmalı, onu kontrol eden yok.

**`npm install` lock'taki sürümü de düzeltiyor.** Kurulum öncesi `package-lock.json`
`0.30.1-beta`de kalmıştı (`package.json` 0.31.4'teyken); install sonrası ikisi de yeni
sürüme geldi — bu hunk gürültü değil, commit'e dahil edilmeli.

## 2026-07-31 — Güvenlik denetimi #951: 8 epic'i tek oturumda kapatmak

**Rapordaki "fixAvailable: true"ya güvenme, kendin doğrula.** #882 `next`/`postcss`/
`sharp`'ı "majör gerekmiyor" grubuna koymuştu, `npm audit` de öyle diyordu. Gerçekte
audit'in önerdiği "düzeltme" **`next@9.3.3`'e düşmekti**; `next@15.5.22` `postcss@8.4.31`
ve `sharp@0.34.5`'i tam sürüm sabitliyor ve **Next 16.2.12 de aynı ikisini sabitliyor**
(kurup build alarak doğruladım — temiz derledi, ama audit tablosu değişmedi). Tek çözüm
`overrides` oldu. Bir denetim raporu ne kadar iyi yazılmış olursa olsun, paket
gerçekliği aylar içinde kayıyor.

**`overrides` + doğrudan bağımlılık = `EOVERRIDE`.** `postcss` hem devDependency hem
next'in geçişli bağımlılığı. npm, doğrudan aralıkla çelişen bir override'ı reddediyor.
Sıra önemli: önce doğrudan aralığı yükselt (`^8` → `^8.5.18`), sonra aynı aralıkla
override ekle.

**Fail-closed varsayılan bazen yanlış karar.** `/api/health` detayını (#897) doğrudan
kapatmak doğru refleks gibi görünüyor — ama prod **ve** preview deploy drift gate'leri
`sha`'yı tam o uçtan okuyor. Kapatmak merge anında ikisini birden kör ederdi ve secret'ı
ekleyecek olan ben değilim. Doğru hamle: kapıyı yaz, boru hattını uçtan uca bağla
(`deploy-prod.sh` container'a geçiriyor, iki gate de env dosyasından okuyup header
gönderiyor), varsayılanı eski davranışta bırak ve **PR'da operatör aksiyonu olarak
işaretle**. Sessizce fail-open bırakmakla, gürültüyle fail-closed yapmak arasında üçüncü
bir yol var.

**İçe aktarma döngüsü, iki iyi fikrin kesişiminde çıkar.** Rate limiter aşımları
`logActivity` ile yazmaya başladı (#864); aynı gün `logActivity` IP kaydetmeye başladı
(#881) ve IP `rateLimit.ts`'teydi. `clientIp()`'i `src/lib/clientIp.ts`'e taşıyıp eski
yerinden re-export etmek hem döngüyü kırdı hem tek bir çağıranı değiştirmedi.

**NextAuth `authorize(credentials, req)` WHATWG `Request` vermiyor** — düz bir header
nesnesi veriyor, `events.signIn/signOut` ise hiçbir şey vermiyor. Küçük bir
`HeaderSource` arayüzü + `headerSource()` adaptörü ikisini de çözüyor. Başarılı giriş
kaydını `events.signIn`'den `authorize()`'a taşımak gerekti (IP orada var); event
tarafında `account?.provider === 'credentials'` kontrolüyle çift kayıt engellendi.

**Aynı bucket'ı paylaşan e2e testleri aynı dosyada kalmalı.** Rate limit spoof testi
(#859) mevcut flood testiyle aynı süreç içi sayacı kullanıyor. Ayrı dosyaya koymak,
Playwright'ın dosya sırasına bağlı sessiz bir kırılganlık yaratırdı. Ayrıca `@smoke`
alt kümesinde **tek başına** koştuğunda da anlamlı kalmalı: "hepsi 429" yerine "en az
bir 429" assertion'ı iki senaryoda da doğru.

**Yeni bir güvenlik başlığını test ederken ortamı da ona göre kur.** `TRUSTED_PROXY_COUNT=0`
ve `HEALTH_TOKEN` `playwright.config.ts`'in webServer `env`'ine eklendi — ikisi de
Playwright'ın gerçekten içinde olduğu topolojinin **doğru** ayarı (araya nginx girmiyor),
ve o ayar olmadan yazdığın assertion'lar boşa düşüyor.

**`git add -A` + rebase conflict = bozuk commit.** Bir `--continue` sırasında
`package.json` hâlâ conflict marker'ı taşırken commit'lendi; `npm pkg set` `EJSONPARSE`
ile patladı ama rebase yine de "başarılı" dedi. Conflict çözerken `git add -A` yerine
dosya dosya eklemek ya da eklemeden önce `grep -c '<<<<<<<'` çalıştırmak gerekiyor.

**Uzun oturumda `main` altından kayar.** 12 PR boyunca başka oturumlardan 4 PR daha
main'e indi; her biri `CHANGELOG.md` + `package.json` sürümünde conflict üretti. Stack'i
küçük tutmak (her PR merge olur olmaz bir sonrakini rebase etmek) ve conflict'i mekanik
çözmek işe yaradı — ama en temizi, geride kalmış bir dalı **yeniden kurmak**: `git
checkout -b yeni origin/main` + ilgili dosyaları `git checkout <eski-dal> -- <dosyalar>`.
Squash-merge sonrası eski commit'i yeniden oynatmaya çalışmaktan çok daha az acı verdi.

## 2026-07-31 — #936 board mobil: iki layout, bayat closure ve sürüm defteri yarışı

**Mobil ve masaüstü iki farklı layout ise İKİSİNİ AYNI ANDA RENDER ETME.**
İlk içgüdü `lg:hidden` / `hidden lg:block` ile ikisini birden basmak; bu her kartı
DOM'a iki kez koyar → Playwright strict mode ihlali (bir mentee adı iki eşleşme) ve
ekran okuyucu için çift içerik. Çözüm `useIsNarrow()` (matchMedia, `useState(false)`
ile başlar ki ilk client render sunucuyla aynı olsun) ve **tek** dalı render etmek.

**`toast(...)` içine koyduğun geri-al callback'i, o render'ın state'ini hatırlar.**
`moveTo` optimistic güncelleme için `relations`'ı okuyordu; toast'taki "Geri al"
kullanıcı tıkladığında çalıştığı için closure bayat listeyi görüyor, `from === hedef`
çıkıyor ve **sessizce hiçbir şey yapmıyordu** (test yakaladı: DB hâlâ yeni aşamada).
Kural: gecikmeli çalışan callback'ler state'i `useRef` üzerinden okumalı.

**Türetilmiş varsayılan (derived default) sinsi bir davranış üretir.** Mobil aşama
filtresini her render'da "ilk dolu aşama" diye hesaplayınca, kartı taşıdığında görünüm
kartın peşinden yeni aşamaya atlıyor — kullanıcı kartın gittiğini hiç görmüyor.
Veri gelince filtreyi bir kez state'e **sabitle** (effect), sonra türetme.

**Locator tuzakları (CLAUDE.md listesine iki yeni madde):**
- `div.w-64` **app shell'in sidebar'ına** da uyuyor (`ResponsiveShell` drawer'ı
  `w-64`). Board kolonlarını sayacaksan `data-testid="board-columns"` kullan.
- Admin board **veritabanındaki tüm ilişkileri** listeler, dolayısıyla
  `getByLabel('Move to stage')` gibi kapsamsız bir locator, başka bir spec'in (veya
  yarım kalmış bir koşunun) ilişkisi aynı aşamada olduğu an strict-mode ile patlar.
  Kartlara `data-testid="board-card"` eklendi; seçiciyi
  `getByTestId('board-card').filter({ hasText: '<ad>' })` ile kapsa.

**320 px taşması genelde board'da değil app shell'inde.** `-mr-2` taşıyan hamburger
butonu + kısalamayan wordmark, mobil üst bar'ı 2 px fazla yapıyordu (her rolde).
`document.documentElement.scrollWidth - clientWidth` ölçüp `getBoundingClientRect()`
ile suçluyu bulmak 1 dakika sürüyor — tahmin etmeyin, ölçün.

**Yerel ortam iki kez ısırdı:** (1) MariaDB koşular arasında **düşüyor** — bütün
specler ~16 s'de aynı anda kırmızıya dönerse önce `service mariadb start`. (2) Önceki
`npm run dev` 3000'i tutuyorsa Playwright 3001'e kaçıyor ve `webServer` 120 s'de
timeout veriyor; koşudan önce `pkill -f "next dev"` + portu doğrula.

**Sürüm defteri yarışı (bu repoda gerçek bir maliyet):** paralel oturumlar `main`'e
~3 dakikada bir merge ediyor ve **her PR** `package.json` + `CHANGELOG.md` +
`releaseNotes.ts` dosyalarının aynı satırlarına dokunuyor. PR'ım 5 kez `dirty` oldu ve
**conflict'li PR'da hiç check koşmuyor** → auto-merge de takılıyor. İşe yarayanlar:
- Conflict çözümünü script'le (main'in sürümü + 1, benim bölüm en üste) ve **sonucu
  assert et**: iki taraf aynı başlık metnini taşıdığında git onu ortak bağlam sayıyor,
  "benim" hunk'ı **başlıksız** geliyor ve sessizce başlıksız bir bölüm oluşuyor.
  Regex'in dosyadaki **ilk** conflict'i değil, iki conflict'i birden yutmasına da
  dikkat (releaseNotes'ta tam bunu yaptı, dosyayı bozdum ve push'ladım).
- Çakışan sürüm numarasını **rebase'den önce** kendi commit'inde değiştir; iki taraf
  farklı numara taşıyınca conflict önemsiz bir ekleme hâline geliyor.
- Aynı temaya ait iki iş varsa (burada #935 + #936) **tek PR** yap: iki yarış yerine bir.

---

## 2026-07-31 — Mobil sohbet kabuğu (#1006)

**"Gereksiz scroll" şikâyeti neredeyse her zaman iki iç içe scroll'dur.** Mesaj
thread'i normal bir dokümandı: başlık + `max-h-[55vh]` baloncuk kutusu + composer
birlikte kayıyordu, yani cevap yazmak için sayfayı aşağı, baloncukları yukarı
kaydırmak gerekiyordu. Doğru düzeltme "biraz padding kısmak" değil, **ekranı çerçeve
yapmak**: `h-[calc(100dvh_-_var(--fixed-bottom-inset))] + overflow-hidden` bir flex
kolon, içinde tek `min-h-0 flex-1 overflow-y-auto` liste. Ölçüsü de nesnel:
`documentElement.scrollHeight - innerHeight` → düzeltmeden önce **1208 px**, sonra 0.

**Tailwind arbitrary value içinde `calc()` boşluk ister:** `h-[calc(100dvh-var(--x))]`
geçersiz CSS üretir (sessizce çalışmaz), `h-[calc(100dvh_-_var(--x))]` doğrusu —
alt çizgi Tailwind'in boşluğu. Bir önceki oturumun `--fixed-bottom-inset` değişkeni
(#935) burada bedavaya geldi: çerez bandı açıkken çerçeve kendiliğinden kısalıyor.

**`bg-white/95` globals.css'in retint ettiği `bg-white` DEĞİLDİR.** Opaklık ekli
utility ayrı bir sınıf adı, dolayısıyla dark mode'da bembeyaz kalır — sticky/blur
başlıklarda `dark:bg-gray-900/95`'i elle yazın (computed style ile doğrulayın).

**Mobil-özel başlık eklerken sayfanın kendi `<h1>`'ini kaldırın.** İkisi birden
kalırsa hem telefonda ekranın üçte biri boşa gider hem de `getByText(ad)` iki eşleşme
bulup strict-mode'u patlatır. `useIsNarrow()` ile **tek varyant** render edin
(`lg:hidden` DOM'da ikisini de bırakır) — kabuktaki başlık mobilde `<h1>` olsun,
sayfa başlığı sadece `lg:`'de.

**Animasyonlu scroll'u tek ölçümle assert etmeyin.** `scrollIntoView({behavior:
'smooth'})` sonrası `scrollTop` daha yolda: ilk denemede liste dibe 67 px uzaktı.
`expect.poll(...)` ile ölçün.

**Bu container'da bilinen iki kırmızı, benimle ilgisiz:** `pipeline.spec.ts`
("Navigation ... is interrupted by another navigation") ve `smoke.spec.ts` admin
sayfaları (`[next-auth][error][CLIENT_FETCH_ERROR]`) — `git stash` ile baseline'da da
kırmızı. Ayrıca elle başlatılan `npm run dev`'i Playwright yeniden kullandığı için
`webServer.env` (HEALTH_TOKEN, TRUSTED_PROXY_COUNT) uygulanmıyor: `health.spec` ve
`rate-limit.spec` bu yüzden düşer. Playwright tarayıcısı için playbook'taki
`executablePath` numarasını geçici bir `playwright.local.config.ts` ile verdim
(`{...base, use: {...base.use, launchOptions: {executablePath: '/opt/pw-browsers/chromium'}}}`)
— commit etmeyin.

### Ek: 2026-08-01 — "alt kısım tam sıfıra dayanmıyor" (#1009)

**`100dvh` görünür yükseklik DEĞİL.** Android'de kurulu PWA (edge-to-edge) sistem
gezinme çubuğunun *arkasına* çiziyor, yani `100dvh` gördüğünüzden ~48 px fazla. Tam
`100dvh` yüksekliğinde bir çerçeve kurunca dokümanda taşma da olmuyor → gizli kalan
şerit **kaydırılarak da erişilemiyor**. Kullanıcının tarifi tam buydu: "en aşağı kısım
tam sıfıra dayanmıyor, biraz fazladan aşağı gidiyor, scroll yapılamıyor."

- `env(safe-area-inset-bottom)` bunun tek CSS sinyali, ama **`viewport-fit=cover`
  olmadan 0 döner**. Next App Router'da `viewport` export'u **layout başına** yapılabilir
  (`src/app/messages/layout.tsx`), yani cover'ı tüm uygulamaya açmak zorunda değilsiniz —
  iç içe export kök export'u *değiştirir* (merge etmez), o yüzden kökteki alanları
  (themeColor, interactiveWidget) tekrar yazın.
- İki düzeltmeyi **toplamayın**: biri çıkarma (`height: calc(100dvh - env(...))`), diğeri
  **clamp** (`max-height: var(--visible-viewport-height)`) olsun. İkisi de aynı 48 px'i
  bildirdiğinde clamp'te küçük olan kazanır; toplarsanız 96 px çıkarıp boşluk açarsınız.
  Aynı sebeple `max(--fixed-bottom-inset, env(safe-area-inset-bottom))`: sabit alt bar
  zaten kendi içinde inset kadar padding taşıyor (#935).
- Tailwind arbitrary value içinde `max()`/`env()` sorunsuz derleniyor
  (`h-[calc(100dvh_-_max(var(--x),env(safe-area-inset-bottom,0px)))]`), üretilen CSS'i
  `grep "height:calc(100dvh" .next/static/css/*.css` ile doğrulayın.
- **Cihaz elinizde olmasa da test edilebilir:** gizli şeridi, kabuğun dinlediği aynı
  sinyali JS'ten kısarak taklit edin (`--visible-viewport-height = innerHeight - 48`) ve
  composer'ın kalan alanda kaldığını assert edin. Negatif kontrol clamp'i silmekle
  yapılıyor (630 > 616).

## 2026-08-01 — CodeQL merge'ü check olarak değil, *konuşma* olarak bloke ediyor

**Zorunlu check listesinde olmayan CodeQL yine de merge'ü durdurabiliyor.** #1004'te üç
zorunlu check (`Lint · Typecheck · Build`, `Playwright smoke`, `Deploy topic environment`)
yeşildi, `mergeable: MERGEABLE` idi ama `mergeStateStatus: BLOCKED` takılı kaldı ve
auto-merge girmedi. Sebep dal korumasındaki `required_conversation_resolution: true`:
`github-advanced-security` botu bulguyu diff üzerine bir **inceleme başlığı** olarak
bırakıyor ve o başlık çözülmeden PR merge edilemiyor. Yani "CodeQL zorunlu check değil,
bloke etmez" yanlış bir çıkarım. Teşhis yolu — `gh pr checks` bunu göstermiyor:
```
gh api graphql -f query='{repository(owner:"O",name:"R"){pullRequest(number:N){
  reviewThreads(first:20){nodes{isResolved path line}}}}}'
```
Çözünce durum anında `UNSTABLE`'a (= zorunlular yeşil, zorunlu-olmayan kırmızı) düşüyor ve
auto-merge çalışıyor. Not: başlığı çözmek **uyarıyı kapatmıyor**; alert Security
sekmesinde açık kalıyor, o yüzden ikisi ayrı karar.

**Object-URL önizlemeleri `js/xss-through-dom` (high) veriyor ve bu bir false positive.**
`URL.createObjectURL(file)` → `<img src>` deseni her ek/görsel önizlemesinde var; main'de
`MessageThread.tsx:42,44` zaten aynı şekilde işaretli. Değer tarayıcının ürettiği
`blob:<origin>/<uuid>`, `javascript:`/`data:` olamaz ve `<img src>` SVG byte'ları için bile
script çalıştırmaz. **Yeni bir composer eklerken bunu bekle**; toplu karar #1005'te.

**`pull_request` olayları bir PR için sessizce kesilebiliyor.** #992'de ilk açılışta 4
workflow koştu, sonraki iki push ve `close`+`reopen` hiçbir run yaratmadı — head commit'te
sıfır check, dolayısıyla zorunlular hiç oluşmadı (aynı anda başka PR'lar sorunsuz
koşuyordu, yani depo/kota sorunu değildi). Boş commit de tetiklemedi. İşe yarayan iki şey:
`gh workflow run <wf>.yml --ref <branch>` (dispatch run'ları check-run'larını **head
commit'e** iliştiriyor, yani zorunlu context'leri karşılıyorlar) ve nihayetinde aynı daldan
**yeni bir PR** açmak. Teşhis: `gh api repos/O/R/commits/<sha>/check-runs` boş dönüyorsa
olay hiç gelmemiş demektir.

**PR gate `@smoke` koştuğu için yeni spec'in gate'te hiç çalışmıyor.** Etiketlemediysen
(ki küçük tutmak için genelde etiketlememelisin) tek gerçek doğrulama
`gh workflow run e2e-full.yml --ref <branch>`. Bunu PR'ı merge etmeden önce yap ve sonucu
PR'a yaz; aksi halde "CI yeşil" yalnızca özelliğinin *derlendiğini* söylüyor.

**Kırmızı tam suite'i regresyon sanmadan önce main'de kontrol koşusu al.** Bu turda dal 3
testte kırmızıydı; aynı anda başlamış `main` zamanlanmış koşusu **6** testte kırmızıydı
(üst küme). `gh run list --workflow e2e-full.yml --branch main` ile en yakın koşuyu bulup
`✘` satırlarını karşılaştırmak, "benim mi, zaten bozuk mu" sorusunu tek adımda kapatıyor.

**Paste'i e2e'de test etmek:** Playwright işletim sistemi panosuna görsel yazamıyor.
Görsel için sentetik `ClipboardEvent` + `DataTransfer` gönder (`el.dispatchEvent`) — handler
`clipboardData`'yı okuduğu için bu gerçek yolu kapsıyor. Ama **sentetik olay tarayıcının
varsayılan yapıştırmasını tetiklemiyor**, o yüzden "düz metin hâlâ kutuya yazılıyor" testi
`toHaveValue` ile yazılamaz; onun yerine sözleşmeyi ölç: `event.defaultPrevented === false`.

---

## 2026-08-01 — Admin ↔ mentor görünüm anahtarı (#1014, 0.37.0-beta)

**"Garip bir hata" bazen zaten var olan bir yetki + eksik bir arayüz.** Kullanıcı,
bildirime tıklayınca admin panelinin birden mentör paneline dönüşmesini hata sandı.
Kod tarafında hata yoktu: `src/app/mentor/layout.tsx`'in rol kontrolü **her zaman**
`ADMIN`'i kabul ediyordu, yani `/mentor/*` çoktan erişilebilirdi. Eksik olan tek şey
oraya götüren bir kontrol ve "şu an oradasın" işaretiydi. **Yeni bir özellik yazmadan
önce mevcut rol guard'larını oku** — bazen iş, yeni yetki eklemek değil, var olanı
görünür kılmak.

**Modu URL'den türet, saklama.** Cookie/DB'de "mentör modundayım" bayrağı tutmak, tam
da bu senaryoyu (dışarıdan gelen bir link seni öbür kabuğa düşürüyor) kenar çubuğu ile
adres çubuğunun çelişmesine çeviriyordu. `modeOf(pathname)` + `counterpartPath()`
(`src/lib/appMode.ts`) ile şema, session ve API yüzeyi hiç değişmeden çözülüyor.

**Sürüm çakışması artık kural, istisna değil.** Dalı açtığımda main 0.35.3-beta idi;
PR'ı açana kadar paralel bir oturum **0.36.0-beta**'yı (#976 mentör global arama)
shiplemişti ve ben de 0.36.0-beta'ya bump etmiştim. Ders: **bump'ı rebase anında
doğrula**, dal açılışında değil — `git show origin/main:package.json | grep version`.
Aynı gün main 8 commit ilerledi (dependabot + iki feature); `git diff origin/main`
sana *kendi* commit'ini değil, main'in de ilerlemesini gösterir — kendi diff'ini
görmek için `git show --stat HEAD` ya da `git diff origin/main..HEAD` kullan.

**Smoke olmayan yeni spec'leri ucuza koştur:** `e2e.yml`'nin `workflow_dispatch`
`grep` girdisi 4-shard e2e-full'e gerek bırakmıyor —
`gh workflow run e2e.yml --ref <dal> -f grep='<başlık regex>'` üç testi 11.5 sn'de
koşturdu. **Ama logda `Running N tests` satırını doğrula**: yanlış yazılmış bir grep
0 test koşup yeşil döner, yani sahte yeşil.

**`gh pr merge` worktree'de "başarısız" görünüp aslında merge edebiliyor.** Başka bir
worktree `main`'i tuttuğunda `fatal: 'main' is already used by worktree ...` hatası
alıyorsun — ama bu hata **uzaktaki merge'den sonra**, yerel checkout adımında oluşuyor.
Tekrar denemeden önce `gh pr view <n> --json state,mergedAt` ile bak (bende MERGED'di);
sonra uzak dalı elle sil:
`gh api --method DELETE repos/O/R/git/refs/heads/<dal>`.

**DB'siz makinede görsel doğrulama.** Bu oturumdaki Mac'te ne MySQL ne Docker vardı,
yani giriş gerektiren ekran açılamıyor. Salt CSS/yerleşim için işe yarayan yol:
projenin **gerçek** Tailwind'ini statik bir mock'a derle —
`npx tailwindcss -i src/app/globals.css -o out.css --content mock.html` — CSS'i inline
et, `python3 -m http.server` ile servis et, açık+koyu tema ekran görüntüsü al. `globals.css`'teki
dark-mode retint tuzağını DB olmadan yakalıyor. (Mock'a `<meta charset="utf-8">` koymayı
unutma, yoksa Türkçe dizeler mojibake görünür ve olmayan bir hatayı kovalarsın.)

**Worktree'de `npm run lint` yanıltıcı:** `.claude/worktrees/` repo'nun *içinde* olduğu
için üst dizinin `.eslintrc.json`'ı da yükleniyor ve ESLint
`Plugin "@next/next" was conflicted between ...` ile ölüyor. Bu senin değişikliğinle
ilgili değil; `npm run build` ve CI'ya güven.

**Bayat Prisma client'ın imzası:** dokunmadığın dosyalarda (`src/lib/auth.ts`,
`announcements/route.ts`, `src/lib/activity.ts`) ~18 hayalet TS hatası. `npm install &&
npx prisma generate` temizliyor. CLAUDE.md bunu söylüyor ama *belirti* şekli — "hiç
açmadığım dosyalar kırmızı" — teşhisi tek bakışta veriyor.

---

## 2026-08-01 — Değerlendirme silme (#1013, 0.38.0-beta)

**Kesilen `pull_request` olayı bu kez ilk push'ta oldu — ve rebase force-push'u
tetikledi.** PR açıldı, `gh pr checks` "no checks reported" dedi,
`gh api repos/O/R/commits/<sha>/check-runs` → `total_count: 0`. 20 dakika bekledim,
hiçbir şey gelmedi. Sonra main'e rebase edip `git push --force-with-lease` yapınca beş
workflow da 8 saniye içinde koştu. Yani #992'de işe yaramayan boş commit'in aksine
**gerçek bir yeni head SHA** (rebase) olayı geri getiriyor. Önceki oturumun önerdiği
`gh workflow run` yolunu denemeye gerek kalmadı. Pratik sıra: PR açtıktan ~1 dk sonra
`check-runs` sayısına bak; 0 ise beklemeden dalı main'e rebase edip force-push et —
sürüm çakışmasını da aynı anda çözüyorsun.

**`releaseNotes.ts` çakışmasında "benimkini al" karşı tarafın notunu siler.** Sürüm
çakışması bu oturumda üçüncü kez yaşandı (main 0.35.3 → 0.37.0 ilerlemişti) ama asıl
tuzak çözümdeydi: `RELEASE_NOTES` dizisinde çakışma **en üstteki girdinin *içine*** düşüyor
— `<<<<<<<` HEAD'in sürüm numarası + `=======` senin metnin şeklinde. Blok olarak
"benimkini al" dersen karşı tarafın sürüm numarası kalır, **kullanıcıya görünen notu
kaybolur**. Doğrusu: HEAD tarafını olduğu gibi bırak, kendi girdini dizinin başına *yeni*
bir eleman olarak ekle. Aynı hata `CHANGELOG.md`'de daha görünür (başlık kaybolur), ama
release notes'ta sessiz. Çözdükten sonra `grep -n "version: '0\." src/lib/releaseNotes.ts`
ile sürümlerin azalan sırada ve tekrarsız olduğunu doğrula.

**`@smoke` olmayan yeni bir spec'i doğrulamanın ucuz yolu `e2e-full` değil.**
`e2e.yml` workflow_dispatch bir `grep` girdisi alıyor:
`gh workflow run e2e.yml --ref <dal> -f grep="testin başlığından bir parça"`. Tek test,
~1 dakika, 4-shard suite'i ve zorunlu özet e-postasını hiç uyandırmadan. Sonucu körlemesine
"success" diye okuma — `gh run view <id> --log | grep -E "Running [0-9]+ test|passed"` ile
testin **gerçekten koştuğunu** teyit et (`Running 1 test` + `1 passed`), yoksa hiçbir şeyle
eşleşmeyen bir grep de yeşil görünebilir.

**Yetki matrisi olan bir endpoint'te e2e, tarayıcı doğrulamasının yerine geçebiliyor.**
Bu makinede yerel MySQL yok, yani paneli tıklayarak deneyemedim. Bunun yerine spec iki
yönü de ölçtü: mentee'nin değerlendirmesine `403` + satır duruyor, mentorun kendi
kaydına `200` + satır gitti. Görsel doğrulama yapılamayan ortamda **kuralı** test etmek,
"derlendi" demekten çok daha fazlasını veriyor — PR'a da bu logu yapıştır.

## 2026-08-01 — Zamanlanmış koşuda 2 kırmızı + 6 flaky: üçü de farklı sınıf

Tek bir e2e raporundaki üç grup, üç ayrı iş çıkardı. Ayırt etme sırası şu:

**1. `failed,failed` mi `failed,passed` mi?** Shard JSON'larını indirip retry desenine bak
(yöntem bir önceki girdide). Bu koşuda 2 test retry'da da düştü → gerçek kırılma;
6 test retry'da geçti → yarış koşulu. İkisine bakış açısı tamamen farklı: birincide
"hangi commit bunu bozdu", ikincide "hangi bekleme eksik".

**2. Kırmızıların ikisi de "test ortamı bir fail-open'a yaslanmış" sınıfındaydı.**
`inbound-email` 401 veriyordu çünkü #870 webhook'un dev-dışı fail-open'ını kapattı ve CI
production build (`next start`) servis ediyor — `NODE_ENV=production` + `INBOUND_SECRET`
yok = 401. Endpoint doğru davranıyordu; **test ortamı, kapatılmış olan gevşek yola
bağlıydı**. Doğru düzeltme testi gevşetmek değil, `playwright.config.ts`'in `webServer.env`
bloğuna sırrı eklemek (`HEALTH_TOKEN` ile aynı desen) ve spec'ten göndermek — böylece test
production'ın gerçek şeklini koşuyor. Bir güvenlik PR'ı bir fail-open'ı kapattığında,
**o fail-open'a yaslanan e2e'ler o PR'da güncellenmeli**; yoksa fatura zamanlanmış koşuya
kesiliyor.

**3. Diğer kırmızı, CLAUDE.md'de zaten yazan locator tuzağının aynısı.** #881
`/admin/activity` satırına bir IP çipi ekledi — o da `text-gray-400` ve DOM'da tarihten
önce. `span.text-gray-400.first()` artık IP'yi yakalıyor ("unknown", çünkü e2e sunucusu
bilerek `TRUSTED_PROXY_COUNT=0` ile koşuyor). Sınıf tabanlı locator, o sınıfı kullanan
**yeni bir kardeş eklendiği gün** kırılır. `data-testid` ekle.

**4. Altı flaky'nin hepsi, repoda zaten var olan yardımcıları kullanmıyordu.**
`e2e/helpers/auth.ts` bu iki şekli önlemek için yazılmış ve doc comment'lerinde tam olarak
bu hataları anlatıyor; spec'ler sadece geçmemişti. Yeni bir flake görünce **önce helper'ın
var olup olmadığına bak** — muhtemelen problem çözülmüş, sadece uygulanmamış.
İkinci şeklin sebebi blanket `clearCookies()`: `storageState`'ten gelen consent cookie'sini
de siliyor *ve* terk edilen sayfanın uçuştaki `/api/auth/session` çağrısı session
cookie'sini geri yazıyor, böylece `/auth/signin` test hâlâ yazarken eski dashboard'a
`router.replace()` ediyor. `two-factor`'da submit, önceki sayfanın **disabled "Add note"**
düğmesine çözünüp 15 sn boyunca onu denedi. Belirtisi hep aynı: hata mesajında
"locator resolved to <...>" ile gelen element, o an bulunduğunu sandığın sayfaya ait değil.

**Yardımcıyı bölerken:** 2FA açık hesap submit'ten sonra `/auth/signin`'de kalmalı, yani
`signInAsFreshUser`'ın landing beklemesi orada yanlış. Gövdesini `submitSignInForm` olarak
dışa aç, `signInAsFreshUser` onu çağırsın — guard'lar tek yerde kalır.

**Süreç notu:** iki iş (kırmızı onarımı + flaky onarımı) ayrı PR'lara ayrıldı. Aynı dala
yığmak, kırmızı düzeltmesinin merge'ünü flaky işinin CI'sine bağlardı; `git stash` + yeni
dal (`git checkout -B <yeni> origin/main` + `stash pop`) bunu 10 saniyede ayırıyor.

**Ek ders (aynı oturum, ilk denemem kırdı):** flaky'leri helper'a taşırken
`submitSignInForm`'u "about:blank → sadece session cookie'sini sil → /auth/signin" olarak
yazmak `two-factor.spec.ts`'i **deterministik olarak** bozdu (failed,failed) — parola alanı
hiç gelmedi. Sebep: `/auth/signin` girişi tamamlarken `/api/auth/session`'ı yoklayıp
`window.location.assign(roleHome)` yapıyor. `waitForURL()` dönüyor ama **terk edilen sayfa
hâlâ session okuyor**; `clearCookies()`'ten sonra düşen bir yanıt cookie'yi geri yazıyor,
sıradaki `/auth/signin` `authenticated` görüp dashboard'a `router.replace()` ediyor.
Ekranda bunu söyleyen hiçbir şey yok — belirti sadece "parola alanı 15 sn'de gelmedi".
Çözüm: cookie'yi düşürmeden **önce** çıkan sayfanın susmasını bekle (`networkidle`), form
yine yoksa cookie'yi bir kez daha düşürüp yeniden yükle.

İki genel kural: (1) blanket `clearCookies()`'i seçmeli silmeyle değiştirirken, o blanket
silmenin **yan etkisiyle** neyi maskelediğini varsayma — doğrula; (2) grep'li dispatch
koşusu bittikten sonra logu **oku**, "yaklaşım doğru" diye peşinen yeşil ilan etme. Bu
oturumda 8 testten 7'si geçmişti; kalan 1'i sadece log gösterdi.

## 2026-08-02 — "Düğme hiçbir şey yapmıyor" aslında bir *okuma* hatasıydı (#1028, 0.38.1-beta)

Bildirim: Müsaitlik sayfasında **Ekle**'ye basınca hiçbir şey olmuyor. İlk refleks — submit
handler'ı, `Button`'ın `type`'ı, hidrasyon — hepsi temizdi. Hata yazma yolunda değil,
**okuma** yolundaydı: `POST /api/availability` ADMIN'i kabul ediyor (admin mentor kabuğuna
0.37.0-beta'daki görünüm anahtarıyla giriyor), ama `GET` `mentorId`'yi yalnızca
`role === 'MENTOR'` iken oturumdaki kullanıcıya düşürüyor, diğer herkese `{ slots: [] }`
dönüyordu. Yani: 201 dönüyor, sayfa listeyi yeniden yüklüyor, boş dizi alıyor ve
"Saatlerin (0)"da kalıyor. Yazma sessizce başarılı, ekranda sıfır iz.

**Genel kural:** bir kaynağın POST'u ile GET'i **farklı rol kümesine** varsayılan
davranıyorsa, kullanıcıya görünen belirti "kayıt olmuyor" değil "düğme ölü" olur. Bir
endpoint çiftine dokunurken yazma tarafının kabul ettiği rolleri okuma tarafının
varsayılanıyla yan yana koy; ikisi ayrışıyorsa bu tek başına bir bug'dır.

**Test dersi:** `e2e/calendar.spec.ts`'teki mevcut müsaitlik testi bu hata boyunca hep
yeşildi — çünkü `page.request.post` ile **sadece API'yi** ve sadece MENTOR'ü deniyordu.
Yazma+okuma döngüsünün kırıldığı yerde API-seviyesi test hiçbir şey kanıtlamaz; regresyon
testi sayfayı sürmeli (giriş → `/mentor/availability` → formu gönder → satırı gör).

**Ortam notu:** dal değiştirdikten sonra `tsc --noEmit` 20+ Prisma tipi hatası verdi
(`lastTotpStep does not exist`, `announcementImage` yok…). Hepsi bayat client; tek
`npx prisma generate` ile sıfırlandı. Bu Mac'te DB yok, o yüzden doğrulama grep'li
`e2e.yml` dispatch'i ile yapıldı (`-f grep='<test başlığı>'`) — 1 test, ~8 sn, PR
smoke gate'ini beklemeden fix'i kanıtlıyor.

## 2026-08-02 — Sunucunun saati kullanıcının saati değildir (#1030, 0.38.2-beta)

Bildirim: uygulamada **09:00** görünen toplantının hatırlatma e-postası **07:00** diyor.
İki ekran görüntüsü tek başına kök nedeni veriyordu: fark tam **2 saat**, yani okuyanın
ofseti GMT+2 (Europe/Berlin) ve sunucu UTC. Koda bakmadan önce farkı hesapla — hangi iki
saat diliminin karşı karşıya olduğunu söyler, gerisi doğrulamadır.

Hata `Date.toLocaleString('en-GB', …)`'in **`timeZone` verilmeden** çağrılmasıydı:
`timeZone` yoksa Node süreç saat dilimini kullanır, container ise UTC. Tarayıcı tarafında
aynı çağrı doğru çalışıyor (`lib/relativeTime.ts`), çünkü orada süreç saati = kullanıcının
saati. **Genel kural:** kullanıcının tarayıcı *dışında* okuyacağı her tarih — e-posta,
DB'ye yazılan bildirim metni, PDF, webhook payload'u — açık bir IANA dilimi taşımalı;
istemci formatlayıcısını sunucuya kopyalamak sessizce yanlış çıktı üretir.

**Asıl tuzak — alan var, veri yok:** `User.timezone` şemada zaten vardı, ama picker
yalnızca mentee profil formunda. Mentor ve adminlerde alan hep `null`, yani "alıcının
dilimini kullan" düzeltmesi tam da şikâyet eden kullanıcı için hiçbir şey değiştirmezdi.
Bir alanı okumaya başlamadan önce **kimlerde dolu olduğunu** sor; şemada bulunması
doldurulduğu anlamına gelmiyor. Çözüm: tarayıcı dilimini oturumda bir kez yakalayıp
**yalnızca boşsa** yazmak (kullanıcının elle seçtiği dilim asla ezilmez).

**Intl ayrıntısı:** `dateStyle`/`timeStyle` ile `timeZoneName` aynı anda verilemez
(TypeError). Ofset etiketini (`(GMT+2)`) ikinci bir `formatToParts` çağrısından alıp
metne eklemek gerekiyor.

**DB'siz doğrulama:** `TZ=UTC node --experimental-strip-types` ile `src/lib/timezone.ts`'i
doğrudan import etmek container davranışını birebir taklit ediyor — rapordaki gerçek anı
(`2026-08-02T07:00:00Z`) verip Berlin alıcısında `09:00 (GMT+2)` çıktığını görmek, tüm
uygulamayı ayağa kaldırmadan en ucuz kanıt.

**Kapsam notu:** regresyon testi `e2e/cron-jobs.spec.ts`'e eklendi ve bu spec `@smoke`
değil — yani PR gate'i yeşil dönmesi o testin **çalıştığı** anlamına gelmiyor; kanıt bir
sonraki zamanlanmış tam koşuda geliyor. Smoke dışı bir spec'e test eklerken bunu açıkça
söyle, "CI yeşil" diye kapatma.

## 2026-08-02 — Global durum, sayfa kabuğuna gömülmez (#1034, 0.38.3-beta)

Bildirim: kimlik taklidi bandı ("… olarak görüntülüyorsun / Kendi hesabına dön")
Mesajlar ekranında yok. Kök neden tek satırdı: bant `ResponsiveShell` içinde
render ediliyordu, yani yalnızca rol kabuğu olan alanlarda (`/admin`, `/mentor`,
`/portal`, `/company`, `/source`) vardı. Kendi chrome'unu üreten rotalar
(`/messages`, `/account`, `/notifications`, `/announcements`) o kabuğu hiç
kullanmıyor. **Kural:** "her ekranda görünmeli" diyen bir öğe (oturum uyarısı,
bakım bandı, global hata) sayfa kabuğuna değil `Providers`'a konur; yoksa yeni
kabuksuz her rota sessizce aynı hatayı tekrar eder. Bir bileşenin nerede
görüneceğini `grep -rn '<Bileşen'` ile değil, **hangi layout'ların onu içeren
kabuğu kullandığıyla** ölç.

**Yan etki — `100dvh` çerçeveler üstten eklenen şeridi göremez:** `MessagesShell`
kendini `calc(100dvh - …)` ile boyutluyor. Belgenin en üstüne akışta duran 61px'lik
bir şerit koyunca toplam yükseklik viewport'u tam o kadar aşıyor ve composer
görünmez alana düşüyor. Çözüm mevcut `--fixed-bottom-inset`/#935 kalıbının aynası:
`useTopBannerInset` şeridin ölçülen yüksekliğini `--top-banner-inset` olarak
yayınlıyor, çerçeve hem `height` hem `--visible-viewport-height` clamp'inden
düşüyor. Viewport'a göre boyutlanan bir ekranın üstüne/altına bir şey eklerken
her zaman bu iki yeri birlikte gözden geçir.

**Doğrulama (bu Mac'te DB yok):** Browser pane, proje dışındaki `file://` sayfaları
"statik snapshot" olarak açıyor — script çalışmıyor, `javascript_tool`/`resize_window`
"No site is open in this tab" diyor. Bunun yerine CSS matematiğini birebir kopyalayan
bir mock HTML yazıp **doğrudan Playwright ile headless** açmak (repoda kurulu,
`chromium.launch()` sorunsuz) en ucuz kanıt: 375×812'de `banner 61px + frame 751px =
812px`, `docOverflow=0`, listeyi kaydırınca `banner.top === 0`. Layout/`calc()`
işlerinde uygulamayı ayağa kaldırmadan gerçek tarayıcı ölçümü alınabiliyor.

**Ortam tuzağı:** `npm run lint`, `.claude/worktrees/<ad>` içinden çalıştırıldığında
üst repodaki `.eslintrc.json` ile çakışıp `Plugin "@next/next" was conflicted…` ile
exit 1 veriyor. Kodla ilgisi yok — CI depo kökünden koştuğu için yeşil; worktree'de
kırmızı lint görürsen önce bunu ele.

**Kapsam notu:** eklenen iddialar `e2e/impersonation.spec.ts` içinde ve bu spec
`@smoke` değil — PR gate'inde çalışmadılar, kanıt bir sonraki zamanlanmış tam koşuda.

## 2026-08-02 — Sunucu reddediyorsa arayüz de sormamalı; silme yetkisi kimin parolasıyla? (#1036/#1037, 0.38.4 / 0.39.0-beta)

Bildirim: "başkasının hesabına admin olarak girip o hesabı silmek istediğimde hesap
parolası soruyor, ama ben o parolayı bilmiyorum." İki ayrı iş çıktı.

**1) Ölü arayüz tuzağı (#1036).** `/api/account` PUT ve DELETE, `session.user.impersonatorId`
doluysa 400 dönüyordu — yani sunucu tarafı zaten doğruydu. Ama `AccountSettings` e-posta,
parola ve "Hesabı sil" kartlarını her koşulda render ediyordu. Sonuç: kullanıcıya
bilemediği bir parola sorulan, doğru girse bile 400 dönecek bir form. **Kural:** bir
endpoint'e koşullu bir red eklerken (`if (impersonating) return 400`) aynı koşulu
arayüzde de ara; yoksa doğru sunucu davranışı, kullanıcıya "bozuk özellik" olarak
görünür. Bunu bulmanın hızlı yolu: guard'ı ekleyen commit'te `grep` ile o endpoint'i
çağıran bileşenleri kontrol et.

**2) Adım-yükseltmeli kimlik doğrulama, doğru parolayla (#1037).** Self-service silmede
hesap sahibinin parolası sorulur; admin yolunda böyle bir karşılık yok. Var olan
`/api/admin/users/[id]/erase` yalnızca "hedefin tam adını yaz" kapısına dayanıyordu —
bu yanlış-tıklama koruması, kimlik doğrulama değil: çalınmış bir admin oturumu hiç
parola bilmeden hesap silebilirdi. Eklenen `adminPassword`, **admin'in kendi**
parolasıdır; hedefin parolası hiçbir zaman istenmez (istenmesi zaten 1. maddedeki
tuzağın kaynağıydı).

**Restrict modundaki FK'lar sessiz mayın.** `hardDeleteUser` yalnızca
`mentorshipRelation` + `statusChange` temizliyordu. `SupportTicket.assignedAdminId`,
`MentorshipRequest.decidedById` ve `Project.ownerUserId` ise cascade **değil** (şemada
`onDelete` yok → restrict), dolayısıyla proje sahibi bir mentoru silmek anlaşılmaz bir
FK hatasıyla patlıyordu — self-service silme de aynı fonksiyondan geçtiği için bu hata
yeni kod olmadan da erişilebilirdi. **Kural:** `user.delete` yazan bir yol eklemeden önce
`grep -n "User? \+@relation" prisma/schema.prisma` ile cascade'i olmayan opsiyonel
referansları çıkar; org'a ait satırları silmek değil, `null`'a çekmek gerekiyor.

**`logActivity` → `activityLog`, `auditLog` değil.** Impersonation testleri
`prisma.auditLog`'a bakıyor (o tabloya `IMPERSONATE_*` yazılıyor), ama `logActivity`
`prisma.activityLog`'a yazıyor. Yeni bir eylemin loglandığını test ederken hangi tabloya
yazıldığını `src/lib/activity.ts` içinden doğrula; yanlış tablo sorgusu sessizce `null`
döner ve test "log yok" diye yanlış yerde kırılır.

**Smoke dışı spec'i merge'den önce doğrulamanın yolu var.** Bu depoda tekrar eden şikâyet
("kanıt bir sonraki zamanlanmış tam koşuda") için çözüm: `e2e-full.yml` `workflow_dispatch`
kabul ediyor, yani `gh workflow run e2e-full.yml --ref <branch>` ile tam suite'i **kendi
branch'inde** koşturabiliyorsun (4 shard, ~5 dk, ubuntu-latest → public repo'da ücretsiz).
Bu turda dört ilgili spec'in de (`admin-user-erase`, güncellenen `candidate-erasure` ×2,
yeni `impersonation` vakası) gerçekten koşup geçtiği böyle görüldü. Shard 4'teki tek
kırmızı `e2e/questions.spec.ts:17` idi ve **aynı test main'in 03:00 UTC koşusunda da
kırmızıydı** — yani mevcut bir sorun. Bir shard kırmızı olduğunda önce aynı testin son
main koşusundaki durumuna bak; "benim değişikliğim mi" sorusunu 30 saniyede kapatıyor.

## 2026-08-02 — Guard'ı yazmak kolay, endpoint'in *bütün* yüzeylerini bulmak asıl iş (#1039, 0.39.1-beta)

`/api/account/2fa` impersonation guard'ı olmayan tek hesap endpoint'iydi: "Kullanıcı olarak
gir" ile giren admin, sahibinin elinde olmayan bir authenticator'ı hesaba bağlayabiliyor
(30 dakikalık impersonation penceresinden sonra da yaşayan kalıcı bir ikinci kimlik
bilgisi) ya da sahibi koruyan faktörü söküp atabiliyordu.

**Aynı endpoint'in ikinci bir arayüz yüzeyi vardı.** `/account` kartı bariz olanıydı;
`/security-setup` (org 2FA zorunluluk kapısı) aynı endpoint'e POST ediyor. Rol layout'ları
bu kapıyı impersonation'da zaten atlıyor, yani oraya ancak URL elle yazılarak ulaşılıyor —
ama guard eklendikten sonra orası da "gönderilince 400 dönen form" olacaktı, yani bir
önceki dersin (#1036) tuzağının aynısı. **Kural:** guard eklerken `grep -rn
"api/<endpoint>" src/` çalıştır ve çıkan her çağrı noktasını ayrı ayrı karara bağla; kartı
gizlemek "arayüz tarafı bitti" demek değil.

**Engellemeden önce alternatif yolun var mı diye bak.** `sign-out-all`'ı da kapattım, ama
önce admin'in bir kullanıcıyı kilitleme yolu olup olmadığını kontrol ettim:
`POST /api/admin/users/[id]/reset-password` var ve **admin'in kendi id'siyle** loglanıyor.
Olmasaydı doğru hamle "engelle" değil, "engelle + admin tarafı eşdeğerini ekle" olurdu —
yoksa guard bir yeteneği karşılıksız siler.

**Denetim kaydı tek başına guard gerekçesidir.** `logActivity` bu rotalarda
`actorId: session.user.id` yazıyor; impersonation'da bu, işlemi yapan admin değil
*kullanıcı* demek. İşleme izin verilseydi bile kayıt yanlış kişiyi gösterecekti. Bir
eylemin impersonation'da serbest olup olmayacağını tartışırken "kim yaptı diye sorulursa
kayıt ne diyor?" sorusu, "zararlı mı?" sorusundan daha hızlı sonuç veriyor.

**GET'i engelleme.** Salt-okunur durum sorgusunu da 400'lemek arayüzün mount'ta yaptığı
`fetch`'i kırar, karşılığında hiçbir şey kazandırmaz. Guard mutasyona konur.

**`gh run view --job X --log | grep` sessizce boş dönebiliyor.** Dört shard'da da yeni
testin adını aradım, dördü de `0` eşleşme verdi — test koşmamış gibi göründü. Aynı log'u
önce dosyaya yazıp (`> s$j.log`) grep'leyince eşleşmeler çıktı (shard 2, `✓
impersonation.spec.ts:136`). **Log'da bir şey bulamamak "yok" demek değil**: önce dosyaya
yaz, sonra ara.

**Ve merge'den önce koştur.** Bir önceki dersin tam da bunu söylediğini (`gh workflow run
e2e-full.yml --ref <branch>`) merge ettikten *sonra* fark ettim; bu turda tam suite main'de
koşup 349/349 geçti, ama doğru sıra branch'te koşturmak. `docs/agent-experience.md`'yi
oturumun *başında* okumanın nedeni bu — sonunda yazmak yetmiyor.

## 2026-08-02 — `questions.spec.ts`: "sorular UI'ı değişmiş" değildi, *ikinci* giriş yarışıydı

Zamanlanmış tam koşuda (shard 4/4) sürekli kırmızı olan tek test. Bildirimdeki tahmin
"sorular ekranı değişti, spec geride kaldı" idi — **yanlış**. Spec, sorular UI'ına hiç
dokunmuyor: üç `page.request` çağrısıyla `/api/questions`'ı sürüyor. `page.fill` /
`page.click` yalnızca kendi yazdığı `signIn()` yardımcısının içinde geçiyor. Yığın izi
zaten bunu söylüyordu (`at signIn (…:12:14)` ← `…:31:5`, yani **mentor** girişi).

**Kural: hata satırını değil, hatanın geçtiği fonksiyonu oku.** "Timeout on `page.fill`"
görüp özellik ekranını aramak, yığın izinin ilk satırını atlamaktır. Testin adı ("mentee
asks a question") nerede kırıldığını söylemez.

**Kesin kanıt, teoriden ucuzdu.** `gh run download <run-id> -R 21072026/Internship -n
playwright-report-full-shard-4` ile inen rapordaki `data/*.png`, hata anında ekranda
**önceki kullanıcının portal panosunu** ("Welcome, QA Mentee!", sol altta mentee çipi)
gösteriyor — `/auth/signin` değil. Bu tek kare tüm tartışmayı bitirdi: `router.replace()`
testi mentee portalına geri atmış, parola alanı hiç var olmamış. Retry #1'de aynı sebep
başka yüzle geldi: `button[type="submit"]` **5 elemana** çözündü ve ilki portalın
*disabled* "Add" düğmesiydi. Zamanlanmış koşuda bir spec kırıldığında **önce artifact'ı
indir**; log'daki "locator resolved to <…>" satırı ve ekran görüntüsü, hangi sayfada
olduğunu tahmin etmekten hızlıdır.

**Sebep, repoda zaten yazılı ve zaten çözülmüştü.** `e2e/helpers/auth.ts`'in doc
comment'leri bu iki belirtiyi (kaybolan parola alanı + disabled "Add" düğmesi) birebir
anlatıyor; #965/#969/#1018 altı spec'i bu yardımcılara taşıdı. `questions.spec.ts`
o süpürmelerde **atlanmış** — #342'den beri hiç dokunulmamış. Düzeltme tek satır:
kendi `signIn()`'ini sil, `signInAsFreshUser` kullan. Bir önceki girdinin kuralı bir kez
daha geçerli: *yeni bir flake görünce önce helper'ın var olup olmadığına bak.*

**Bu Mac'te yarış tekrar üretilemiyor — ve bunu dürüstçe söylemek gerekiyor.** Lokal DB
kuruldu (`brew install mariadb`; `mariadbd-safe --datadir=/usr/local/var/mysql &`, root
socket-auth olduğu için `mariadb -u <os-kullanıcısı>` ile bağlanıp `crm`/`crm` kullanıcısı
açıldı — playbook'un `apt` tarifi macOS'ta geçmiyor, Docker daemon da kapalı). Spec hem
dev sunucuda hem `CI=1` + production build ile **geçti** (2.8 s). `/api/auth/session`'ı
2.5 sn geciktirip yavaş runner'ı taklit etmek de yarışı tetiklemedi. Yani "lokalde geçiyor"
bu sınıf için **kanıt değil**; yarış GitHub runner'ının yavaşlığına bağlı. Doğrulama
zinciri: artifact (ne olduğu) + helper'ın doc comment'i (neden) + zamanlanmış koşu (düzeldi mi).

**`@smoke` kararı: hayır, dışarıda kalıyor.** Gerekçe: (1) smoke seti şu an **31** test,
CLAUDE.md'nin hedefi ~15-20 — her "bu da önemli" eklemesi tam olarak bu aşımı üretti;
(2) bu spec üç API iddiası için **iki tam UI girişi** ödüyor (CI'da ~16 sn), gate ~3,5 dk;
(3) konusu olan rol-aşırı yetkilendirme smoke'ta zaten `authz-matrix` + `role-scoping` ile
temsil ediliyor; (4) kırılma bir ürün regresyonu değildi, ortak yardımcıya geçmemiş bir
spec'ti — ve artık geçti. Tespit mekanizması da çalıştı: bunu zamanlanmış koşunun özet
e-postası yakaladı. Smoke'a terfi, PR'da görünürlük isteyen **ürün** yollarına saklanmalı.

**Açık kalan (kapsam dışı bırakıldı):** kullanıcı **değiştiren** ve hâlâ kendi giriş
yardımcısını yazan başka spec'ler var (`grep -l "goto('/auth/signin')" e2e/*.spec.ts` ile
`helpers/auth` import etmeyenleri kesiştir; ≥2 giriş yapanlar riskli). Şu an yeşiller, yani
aynı yarış onlarda **uykuda**. Hepsini bu PR'da taşımak yeşil testleri riske atardı;
ayrı bir süpürme işi.

## 2026-08-02 — Uykudaki giriş yarışının süpürmesi (#1043): "≥2 giriş" değil, "aynı `page`'te ≥2 giriş"

Bir önceki girdinin (`questions.spec.ts`) kapsam dışı bıraktığı iş. Başlangıç ölçütü —
"`goto('/auth/signin')` içeren ama `helpers/auth` import etmeyen, ≥2 giriş yapan spec'ler" —
doğru yere bakıyor ama **çok geniş**: 27 dosya eşleşiyor, gerçekte taşınması gereken **7**.

**Eleyen soru "kaç giriş?" değil, "aynı oturum devrediliyor mu?".** Yarış ancak *aynı*
`page` üstünde ikinci bir giriş yapılınca oluşuyor. Üç yaygın yanlış pozitif:

1. **Girişler ayrı `test()` bloklarında.** Her test taze bir `page` fixture'ı alır; devreden
   bir çerez yok. 27 adayın 18'i bu. (`account`, `evaluation`, `impersonation`, `projects`, …)
2. **Her kullanıcıya kendi `browser.newContext()`'i.** Ayrı çerez kavanozu, yarış yok.
   (`admin-support`, `free-core-regression`, `interaction-summary`, `sign-out-all`,
   `support-attachments`, `talent-pool-early-access`, `mentorship-request`'in 3 testinden 2'si)
3. **İkinci `goto('/auth/signin')` iddianın kendisi.** `redirect.spec.ts` bir kez giriyor;
   ikinci gidiş "giriş yapmış kullanıcı buradan atılmalı" testi.

Ayıklama grep'le değil, **test bloğu başına sayarak** yapılır: dosyayı satır satır gez,
`test(` görünce sayacı sıfırla, `goto('/auth/signin')` *veya yerel giriş yardımcısının çağrısı*
görünce artır. Yerel yardımcı adımı şart — `announcements-feed` gibi dosyalarda dosyada tek
bir `goto` literali var ama yardımcı test başına iki kez çağrılıyor; sadece literal sayan bir
tarama bunları **kaçırır**.

**Aynı kullanıcıya yeniden giriş de bu sınıfa girebiliyor.** `email-verification` iki kez
*aynı* hesapla giriyor, dolayısıyla "kullanıcı değişimi" filtresine takılmıyor — ama amacı
bayat JWT'deki `emailVerified: false`'ı tazelemek. Eski oturumla sessizce `/mentor`'a
dönmek `waitForURL`'i geçirir ve testi *yanlış sebeple* kırar (banner hâlâ ekranda).
Ölçüt "farklı e-posta" değil, **"bu girişin gerçekten yeniden kimlik doğrulaması gerekiyor mu"**.

**Girişin bir iniş sayfası yoksa `submitSignInForm`.** `admin-user-active`'de ikinci giriş
devre dışı bırakılmış bir hesapla yapılıyor: doğru sonuç `/auth/signin`'de kalmak.
`signInAsFreshUser` orada 20 sn bekleyip düşerdi. Aynı ayrım `two-factor.spec.ts`'te de var.

**Yeşil testleri taşırken doğrulama CI'da yapılır, lokalde değil.** Bu yarış hızlı makinede
tekrar üretilemiyor (bir önceki girdi), dolayısıyla "lokalde geçti" hiçbir şey söylemiyor.
Kullanılan zincir: `gh workflow run e2e.yml --ref <branch> -f grep='<8 testi kapsayan regex>'`
→ log'da **`Running 8 tests`** satırını doğrula (0 olsaydı regex tutmamış demektir, ve koşu
yine de yeşil raporlardı — sessiz yanlış pozitif) → merge'den önce `e2e-full.yml` branch'te.
`npx playwright test --list --grep '<regex>'` lokalde regex'i bedavaya doğruluyor; dispatch
etmeden önce onu koştur.

## 2026-08-03 — Aynı hatanın diğer yarısı: *giriş* yönü (#1061, 0.40.4-beta)

#1030 (bir gün önce, hemen yukarıda) tarih/saatin **çıkış** yönünü düzeltmişti: sunucuda
`timeZone` vermeden formatlamak. Bugün gelen bildirim neredeyse aynı görünüyordu — "16:30
seçtim, 18:30 oldu", yine tam **2 saat**, yine Berlin/UTC — ama kök neden **karşı yönde**
idi: bu kez format değil, **parse**.

**Ayırt edici soru: yanlış olan gösterim mi, saklanan veri mi?** #1030'da DB doğruydu,
e-posta yanlış render ediyordu. Burada e-posta *doğru* render ediyordu ("18:30 (GMT+2)" —
saklanan an gerçekten 18:30 Berlin'di); bozuk olan `scheduledAt`'in kendisiydi. Ekran
görüntülerinden bunu ayırmanın yolu: **ilan edilen ofset etiketiyle** tutarlı mı? "18:30
(GMT+2)" iç tutarlı bir cümle, dolayısıyla formatlayıcı suçlu değil. Tutarlıysa yukarı,
yazma yoluna bak.

**Kural:** `<input type="date">` + `<input type="time">` (ve `datetime-local`) **saat dilimi
taşımayan** bir duvar saati üretir (`"2026-08-03T16:30"`). ECMAScript'e göre belirteçsiz bir
tarih-saat dizesi **çalışma zamanının yerel diliminde** yorumlanır — tarayıcıda kullanıcının
dilimi, sunucuda ise UTC. Yani aynı dize iki uçta **iki farklı an** demek. Bu dize asla ham
hâlde POST edilmemeli; `new Date(bareString)` sunucuda her zaman bir hatadır.

**Neden hem istemci hem sunucu düzeltildi:** istemci tarafı yetkili çözüm (kullanıcının
dilimini yalnızca tarayıcı bilir), ama sunucu tarafı `new Date()` çağrısı bırakılırsa
önbellekteki eski paketle gelen tarayıcı ve API tüketicileri hatayı yaşamaya devam eder.
Sunucuda "diliminden emin değilsen" fallback'i organizatörün `User.timezone`'u → `APP_TIMEZONE`
→ Europe/Istanbul; UTC varsaymaktan her koşulda daha iyi (ama #1030'un tuzağı burada da
geçerli: bu alan mentor/adminlerde boş olabilir, o yüzden istemci düzeltmesi asıl olan).

**IANA duvar saati → an dönüşümü, kütüphanesiz:** aradığın ofset, çözmeye çalıştığın anın
kendisine bağlıdır (DST). Yineleyerek çöz — duvar saatini UTC varsay, oradaki ofsetle
düzelt, bir kez daha düzelt. İki geçiş, ofseti ~1 saatten az kayan her dilim için tam
sonuç veriyor. Ofseti `Intl.DateTimeFormat(...).formatToParts` ile geri okumak, kendi ofset
tablonu tutmaktan iyidir. `hour12: false` bazı ICU sürümlerinde gece yarısını **"24"**
döndürür — `% 24` şart.

**Regex tuzağı — "saat dilimi belirteci var mı":** naif `/(?:Z|[+-]\d{2}:?\d{2})$/` deseni
yalnızca-tarih olan `"2026-08-03"`'ü de **eşleştirir** (`-08-03` bir "-08:03" ofseti gibi
okunur) ve dizeyi "zaten dilimli" sayıp UTC gece yarısına çevirir. Belirteci **bir saatin
ardından** aramak gerekiyor; `.000Z` için kesirli saniyeyi de kapsa.

**Düzeltmenin gerçekten çalıştığını kanıtlama — testi eski kodda kırmızı gör.** Yeni e2e
`git stash push -- src/` ile düzeltme geri alınıp koşuldu: `Received: 16:30Z` (bildirilen
hatanın tam kendisi), düzeltmeyle `14:30Z`. Yeşil bir test tek başına hiçbir şey kanıtlamaz;
Playwright'ta `test.use({ timezoneId: 'Europe/Berlin' })` bu tür hataları görünür kılan tek
satırdır — **UTC tarayıcıda bu hata görünmez**, yani varsayılan dilimle yazılmış bir test
sessizce yeşil kalırdı. Ayrıca iddia **saklanan anı** (`prisma.meeting.findFirst` →
`scheduledAt.toISOString()`) kontrol etmeli; ekranda okunan metin hem doğru hem yanlış
veriyle "16:30" gösterebilir.

**Formattan bağımsız iddia yaz:** ekrandaki saati doğrulayan satır ilk denemede kırıldı,
çünkü liste `Intl`'i tarayıcının **locale**'iyle çalıştırıyor ve `en-US` 12 saatlik
("4:30 PM") biçim veriyor. `/(16:30|4:30\s*PM)/` gibi iki biçimi de kabul et — yoksa test
saat dilimini değil locale'i test eder.

**Geriye dönük veri:** düzeltmeden önce oluşmuş satırlar kayık kalıyor ve toptan bir
backfill **yapılmadı** — form kaynaklı satırı doğru saklanmış satırdan (seri tekrarları,
kabul edilmiş toplantı istekleri) ayırt edecek bir işaret yok, `createdById` üzerinden ofset
tahmini doğru satırları bozardı. Yerinde düzeltme için bir yeniden planlama/iptal yolu da
yok (`/api/meetings` yalnızca GET+POST). Bunu kullanıcıya **açıkça söyle**; "düzelttim"
demek yeni kayıtlar için doğru, mevcut kayıt için değil.

**Ortam:** yerel MariaDB + `.env` + `db push` playbook'taki gibi sorunsuz kuruldu. Playwright
runner'ı için `executablePath` override'ı ayrı bir config dosyasına yazılıyor ve bu dosya
**repo kökünde** olmalı — `playwright.config.ts` içindeki `globalSetup: './e2e/global-setup.ts'`
gibi göreli yollar config'in bulunduğu dizine göre çözülüyor, scratchpad'e koyunca
`MODULE_NOT_FOUND` veriyor. Commit'ten önce silmeyi unutma.

## 2026-08-03 — Anlık görüşme + yüzen not penceresi paketi (#1051–#1059, 0.40.5→0.40.9-beta)

Beş PR'lık bir zincir (şema → endpoint → butonlar/yan panel → proje & sohbet → not penceresi
→ nottan işe). Çıkan dersler, sırayla en pahalıya mal olanlar:

**`git checkout -B <dal> origin/main` upstream'i `origin/main` yapar.** Squash-merge edilmiş
bir PR'ın üstüne yeni dal kurarken bunu kullandım; sonrasındaki düz `git push` **dalıma
değil main'e** gitmeye çalıştı. Main korumalı olduğu için reddedildi (yoksa doğrudan main'e
commit'lerdim), ama asıl zarar sessizdi: dalın uzaktaki hâli **eski commit'te kaldı**, PR o
eski commit'le açıldı ve **hiç CI tetiklenmedi**. "PR'da 0 check var" gördüğünde önce
`git status -sb` ile upstream'e bak; `-B` sonrası her zaman
`git push origin <dal>:<dal>` yaz ya da `--set-upstream-to`'yu düzelt.

**Squash-merge edilen bir PR'ın üstündeki dalı `rebase` etme, `cherry-pick`'le yeniden kur.**
Zincirdeki her PR bir öncekinin dalından çıkıyordu; üsttekiler squash'lanınca
`git rebase origin/main` her seferinde aynı içeriği "AA" çakışmasıyla getirdi. Doğrusu:
`git checkout -B <dal> origin/main && git cherry-pick <kendi commit'im>`.

**Headless Chromium `documentPictureInPicture`'ı SUNUYOR.** "Tarayıcı desteklemiyor, o yüzden
fallback'i test ederim" varsayımı yanlış — o test sessizce **PiP dalını** çalıştırır ve
Safari/Firefox hakkında hiçbir şey kanıtlamaz. İki dalı da `context.addInitScript` ile zorla:
biri `delete window.documentPictureInPicture`, diğeri `requestWindow`'u `window.open` ile
stub'lar. Gerçek "her şeyin üstünde durma" davranışı headless doğrulanamıyor; elle bakıldı.

**Transient user activation, `await`'ten sonra tükenmiş sayılır.** `documentPictureInPicture
.requestWindow()` ve `window.open()` canlı bir kullanıcı jesti istiyor. "Görüşme başlat"
akışında pencereyi `await fetch(...)`'ten **sonra** açmak sessiz bir başarısızlık — hata yok,
pencere de yok. Sıra: tıklama handler'ının senkron başında pencereyi aç, fetch'i paralel
yürüt, oda dönünce pencereye iliştir. Yanıt hatalıysa pencereyi kapat, yoksa hiçbir şeye ait
olmayan boş bir pencere ekranda yüzer.

**"Gezinmeye rağmen ayakta kalıyor" iki ayrı iddiadır.** Paneli sayfa kabuklarının üstüne
(`Providers`) mount etmek **client-side** gezinmeyi çözer; `page.goto()` ise tam belge
yüklemesidir ve React state'ini siler. Smoke testi bunu ilk turda yakaladı — düzeltmesi
`sessionStorage`'a yazıp mount sonrası geri okumak (render sırasında değil: hidrasyon kırılır).
`localStorage` değil `sessionStorage`: oda bu sekmeye ait, yarın açılan sekmeye musallat
olmamalı.

**CSP ve `Permissions-Policy`, gömülü görüşmeyi iki ayrı şekilde öldürüyordu.**
`camera=(), microphone=()` **kendi frame'imiz dahil** her şeyi kapatıyor; CSP'de `frame-src`
yoksa `default-src 'self'` iframe'i tamamen bloke ediyor. İkisini de tek host'a daralt ve
allowlist'i kodda aynala (`EMBEDDABLE_MEETING_HOSTS`) — birini genişletip diğerini unutmak ya
boş kutu ya görüntüsüz görüşme demek. Header'ları `curl -sI` ile gerçek yanıtta doğrula.

**Client bileşeninin kullanacağı yardımcıyı Prisma'lı modülden ayır.** `isEmbeddableMeetingLink`
başta `meetingContext.ts` içindeydi; oradan import etmek Prisma'yı (ve `node:crypto`'yu)
tarayıcı paketine sürüklerdi. Import'suz ayrı bir `meetingLink.ts` doğru yer.

**`ProjectMember` bir `TENANT_MODEL` değil, `Project` öyle.** Üyeleri doğrudan sorgulamak
kiracılar arası okuma demek. Önce `prisma.project.findUnique` (org-scoped), sonra üyelik.

**Nullable'a çevrilen bir kolon, onu deref eden her yeri kırar — ama `tsc` hepsini gösterir.**
`Meeting.relationId`'yi nullable yapmak yalnızca 3 hata verdi; asıl iş, mevcut endpoint'lerin
**şeklini korumaktı**: `GET /api/meetings`, `/api/calendar-events` ve hatırlatma cron'u
`relationId: { not: null }` ile süzülerek birebir aynı davranışta bırakıldı.

**Yerel MariaDB'de `root` sudo istiyor, ama oturum kullanıcısı unix_socket ile giriyor.**
`mysql -u <kullanıcı>` çalışıyor; oradan TCP parolalı bir kullanıcı açıp
(`CREATE USER 'e2e'@'127.0.0.1'`) Prisma'yı ona bağlamak, sudo beklemeden yerel e2e koşmanın
en hızlı yolu. Bir kere kurunca **her PR'ı push'lamadan önce yerelde koşabildim** — bu paket
için CI'a giden tek kırmızı, bu kurulumdan *önceki* PR'dı.

**Dev sunucusu eski Prisma client'ıyla kalır.** `prisma generate` sonrası `next dev`'i
yeniden başlatmazsan yeni kolona yazan endpoint 500 döner ve hata testin değil sunucunun
olur. Şema değişince sunucuyu yeniden başlat.

## 2026-08-06 — Zamanlanmış tam koşunun 5 kırmızısı: ikisi de "ürün değişti, test değişmedi"

**Duyarlı (responsive) ikinci liste, strict mode'u sessizce silahlandırıyor.** #1008
`/admin/candidates`'e `md:hidden` bir mobil kart listesi ekledi; masaüstü grid'i zaten
duruyordu. Artık **her aday DOM'da iki kez** var. Playwright'ın strict mode'u *görünür*
eşleşmeyi değil **eşleşen düğüm sayısını** sayar, dolayısıyla `md:hidden` olması hiçbir şeyi
kurtarmaz: `getByText('<isim>')` 2 döner ve `toBeVisible()` daha görünürlüğe bakmadan patlar.
Dört spec (`admin-bulk-candidates`, `dashboard-links`, `export-filter`, `export`) tam bu yüzden
düştü — hepsi `candidates-desktop-list` kapsamına alındı. Aynı sayfanın testid ile çalışan
assertion'ları (`candidate-card-<id>`) hiç etkilenmedi; ders bu: **isimle değil kapsamla/testid
ile hedefle.** `toHaveCount(0)` yazan yokluk assertion'ları kırmızıya düşmediği için bu ikizleme
PR gate'inde de gizli kaldı (bu 4 spec `@smoke` değil).

**"Yokluk" assertion'ı, bozulmuş bir locator'ı maskeler.** `getByText(x)).toHaveCount(0)` hem
"öğe yok" hem "locator artık yanlış" durumunda yeşil. Bir sayfanın DOM'u ikizlendiğinde önce
*varlık* assertion'ları düşer; yokluk olanlar aynı yanlışlığı taşıdıkları halde susar. İkizleme
düzeltilirken ikisini birlikte kapsamla.

**`dashboard-links`'te ikinci bir bomba ilk hatanın arkasında bekliyordu:** `getByRole('link',
{ name: 'ZZ InStage Mentee' })` de 2 eşleşiyordu. İlk `getByText` düzeltilse ve o satır
bırakılsa, spec bir sonraki koşuda aynı yerden yine düşerdi. Aynı sayfadaki **bütün** isim
tabanlı locator'ları tek seferde tara.

**Header testi, ürün kararının fotoğrafını çekmişti.** `security-headers` hâlâ Jitsi öncesi
`camera=()`'yi arıyordu; gömülü görüşme için `Permissions-Policy` bilerek
`camera=(self "https://meet.jit.si")`'ye genişletilmişti. Doğru düzeltme sabiti güncellemek
değil, **niyeti** test etmek: yetkiler tek host'a delege edilmiş mi, `geolocation=()` kapalı mı,
ve hiçbir direktif `*`'a açılmış mı. Böylesi bir gevşetme bir daha sessizce geçmez.

**Yerel `.env` paylaşılan preview DB'sine bakıyor — e2e'yi ona karşı koşmak veri yazmak demek.**
Doğru yol: `DATABASE_URL`'i komut satırında geçersiz kılmak. `process.env`, `.env`'i ezdiği için
`DATABASE_URL='mysql://...' npx playwright test ...` yeterli, dosyaya dokunmak gerekmiyor.

**MariaDB'ye parola üretmeden bağlanmanın yolu unix socket.** Önceki notta TCP'li bir `e2e`
kullanıcısı açılmış ama parolası oturumla birlikte gitmiş. `root` sudo istiyor. Prisma socket'i
destekliyor: `mysql://<oturum-kullanıcısı>@localhost/<db>?socket=/tmp/mysql.sock` — `unix_socket`
plugin'i sayesinde parolasız geçiyor, yeni kullanıcı/parola kurmaya gerek yok.

**Playwright tarayıcısı pinlenen sürümü istiyorsa, indirmeden önce cache'e bak.**
`~/Library/Caches/ms-playwright/` içinde komşu build'lar (1234) varken eksik olan yalnızca
beklenen sürüm dizini (1228) olabilir; `chromium-1228 -> chromium-1234` ve aynısı
`chromium_headless_shell` için symlink, ~150MB indirmeden koşmayı açıyor.

## 2026-08-06 — Tekrarlayan toplantı: satır üretmek yerine kural okumak (#1110, 0.45.0-beta)

**Şikâyet "silinen toplantı takvimde kalıyor"du; kök neden özelliğin şeklindeydi.** Seri
kurulduğunda her mentee × her tekrar için bir `Meeting` satırı üretiliyordu (6 kişi × 7 hafta =
84 satır). `DELETE` yalnızca `active`'i false yapıyordu; satırlar takvimde kalıyordu. Saati
değiştirmek de eskiyi silmiyor, yenisini *yanına* yazıyordu. Tek tek bug'ları kapatmak yerine
doğru düzeltme malzemeleştirmeyi tamamen bırakmaktı: seri artık sadece bir kural, tekrarlar
okunurken `lib/meetingSeriesOccurrences.ts` ile hesaplanıyor. "Silme" davranışı, silinecek bir
şey kalmayınca kendiliğinden doğru oluyor.

**Aynı kuralı üç yerde ayrı ayrı açan üç kopya vardı** (takvim, dashboard banner'ı, hatırlatma
cron'u) — üçü de "duvar saatini UTC'ye çivile" diyordu. Tek uygulamaya indirince ortaya çıkan
şey bir bug'dı: arayüzün "09:00" gösterdiği kural, İstanbul'daki bir mentee'ye "12:00 (GMT+3)"
olarak hatırlatılıyordu. `MeetingSeries.timeZone` eklendi; eski kayıtlar `null` kalıp deployment
varsayılanına düşüyor — yani arayüzün zaten gösterdiği saate. Zaman dilimi yalnızca *oluştururken*
gönderiliyor: mevcut bir kuralı başka ülkeden düzenlemek toplantıyı herkes için kaydırmasın diye.

**Bir davranışı değiştirirken, o davranışı *doğrulayan* testler değil, ona *dayanan* testler de
kırılır.** `upcoming-meeting.spec.ts` seriyi `timeOfDay`'i UTC'den türeterek kuruyordu ve bunu
yorumda açıkça yazmıştı; `project-team-and-goals.spec.ts` ise `createdMeetings > 5` bekliyordu.
İkisi de yeni sözleşmeye taşındı (`timeZone: 'UTC'`, ve "hiç satır üretilmedi" assertion'ı).
Yorumda "X şöyle çalışıyor" yazan her test, X değiştiğinde aday listesindedir — `grep` ile ara.

**Ay ızgarasında hücre başına 3 çip sınırı koymak, ilgisiz bir spec'i kırabilir.** Paylaşılan
DB'de "bugün" hücresi taşınca `getByText('Cal Mentee')` görünmez oluyor. Böyle bir sınır
eklerken, o günün *tam* listesini gösteren bir görünüm (gün görünümü) üzerinden assert etmeye
geçmek hem daha sağlam hem daha okunur.

**Bu konteynerde Playwright'ın beklediği build dizini `/opt/pw-browsers/chromium-1194`'ten
farklı (1234) ve ikisinin *iç yapısı* da farklı:** headless shell 1194'te
`chrome-linux/headless_shell`, beklenen yol ise
`chrome-headless-shell-linux64/chrome-headless-shell`. Dizini symlink'lemek yetmiyor — dizini
gerçek olarak oluşturup içindeki her girdiyi tek tek symlink'lemek, artı binary'ye beklenen adla
bir symlink daha atmak gerekiyor. `INSTALLATION_COMPLETE` dosyasını da unutma.

**`npx playwright test` `.env`'i okumaz.** Next dev sunucusu okur, test süreci okumaz; spec'ler
Prisma'ya doğrudan bağlandığı için `DATABASE_URL` yoksa P1012 ile düşerler. `export $(grep -v
'^#' .env | sed 's/"//g' | xargs -d '\n')` ile bir kez dışa aktarmak yeterli.

**Ekran görüntüsü alırken "sayfa yüklendi" ≠ "veri geldi".** Dev sunucusunun ilk derlemesi
sırasında alınan görüntüde takvim tamamen boş çıktı ve bir an gerçek bir hata sanıldı; DOM'u
`innerHTML` ile yazdırmak 30 saniyede doğruyu söyledi. Görsel doğrulamada önce DOM'a sor,
sonra piksele.

## 2026-08-06 — Yapılacaklar listesi: kopya değil referans (0.46.0-beta)

**"Aynı madde listede defalarca" şikâyetinin kaynağı iki *örtük* yakalamaydı.** `POST
/api/projects/[id]/tasks` elle yazılan her görevi şablon havuzuna `upsert` ediyordu, `GET
.../task-templates` ise okuma anında projenin mevcut görevlerinden havuzu backfill ediyordu. Ortak
havuzdan gönderilen bir madde ise *atanan kişinin diline çevrilerek* saklandığı için backfill o
çeviriyi projeye ait yeni bir şablon olarak benimsiyordu: aynı hedef, gönderildiği her dil için bir
kez havuza dönüyordu ve her turda büyüyordu. Ders: bir listeyi "kullanıcı ne yazdıysa onu hatırla"
diye otomatik beslemek, o listenin aynı zamanda *kaynak* olduğu her yerde çift sayıma dönüşür.
İki yakalama da kaldırıldı; havuza ekleme artık kendi input'u olan bilinçli bir eylem.

**Çok dilli bir metni satıra kopyalamak, dinamikliği daha o anda kaybetmek demek.** Eskiden şablon
görev satırına düz string olarak yazılıyordu; sonradan metni düzeltmek kimseye ulaşmıyordu ve kişi
dilini değiştirdiğinde eski dildeki metinle kalıyordu. `ProjectTask.templateId` ile satır artık
şablona *referans*: metin her render'da okuyucunun dilinde çözülüyor (`resolveTaskTitle`), tek
düzenleme herkese ulaşıyor. `title` kolonu snapshot olarak kalıyor — bildirim metni, arama ve
şablon satırı yokolduğu gün için.

**Referans varsa "sil" artık silme değildir.** Şablonu gerçekten silmek, onu almış herkesin
metnini boşaltır. `archivedAt` (soft delete) + "aynı metni yeniden eklemek arşivdeki satırı
canlandırır" kuralı, `@@unique([projectId, title])` ile de doğal olarak uyuşuyor. Karşılığında:
arşivli satır unique anahtarı tuttuğu için PATCH'teki çakışma kontrolü arşivlileri de *görmek*
zorunda, yoksa DB seviyesinde patlar.

**Kişiye ait bir kaydı `projectId`'yi nullable yaparak aynı modelde tutmak (yeni model açmak
yerine) tek listeyi ucuza getirdi**, ama izin mantığında "lead" tanımını ikiye ayırmayı gerektirdi:
projesi olan satırda proje sahibi, projesi olmayan satırda *yazan kişi*. Atanan kişiyi lead saymak,
"mentorun verdiği ortak maddeyi silemez" kuralını sessizce deliyordu.

**Testlerden biri kırmızıysa önce `git stash` ile temiz ağaçta çalıştır.** `pipeline.spec.ts` ve
`smoke.spec.ts:53` bu değişiklikle birlikte kırmızı geldi; stash'leyip tekrar koşmak ikisinin de
değişiklikten önce de kırmızı olduğunu 1 dakikada gösterdi (yerelde tohumlanmış admin/dev sunucusu
kaynaklı). Suçlu aramaya girişmeden önce taban çizgisini ölç.

## 2026-08-06 — "Mentee projesini göremiyor": yetki değil, bağlantı eksikliği (0.49.0-beta)

**Bir "göremiyorum" şikâyetinde önce yetki katmanını değil, oraya giden bağlantıyı ara.** Bu
oturumun tamamı `authzScope.ts`'de bir hata aramakla geçebilirdi; oysa `MENTEE` scope'u projeyi
zaten döndürüyordu ve `/projects/[id]` üye olan mentee'ye zaten içeriden görünümü veriyordu. Eksik
olan tek şey **linkti**: `PortalNav`'da girdi yok, panelin ilişki sorgusunda `project` seçilmiyor,
ve tek liste sayfası olan `/projects` `isPublic: true` vitrini. Üç ayrı yerde "yok", tek bir yerde
"yasak" değil. Teşhis sırası işe yaradı: (1) veri modeli, (2) API scope'u, (3) sayfanın gating'i,
(4) *sayfaya giden link*. Dördüncüsü en sık atlanan ve bu sefer tek suçlu olan basamaktı.

**Üyelik iki kaynaktan geliyorsa, yeni yazdığın her sorgu ikisini de okumak zorunda.** `mergeTeam`
zaten `ProjectMember` ∪ `MentorshipRelation.projectId` birleşimini yapıyordu, ama yeni bir liste
yazarken yalnızca birine bakmak çok kolay — pre-#617 atamalarını görünmez yapan hata tam olarak bu.
Bu yüzden `lib/menteeProjects.ts` tek bir yardımcı olarak yazıldı ve hem sayfa hem panel onu
kullanıyor; e2e testi de iki kaynağı ayrı ayrı tohumluyor.

**Panel kartını `activeRelation` bloğunun içine koymak, düzelttiğin hatayı tekrar üretmek olurdu.**
Bir mentee ilişkisi olmadan da `ProjectMember` olabiliyor; kartı o dalın içine koymak "mentoru
olmayan mentee projesini görmez" diye yeni bir kör nokta açacaktı. Koşulu yazarken "bu veriyi
görebilecek en dar durum hangisi?" diye sormak gerekti.

**Geri linki de bir görünürlük yüzeyi.** Detay sayfasındaki geri linki mentee'yi `/projects`'e,
yani projesinin *bulunmadığı* vitrine gönderiyordu. Sayfayı erişilebilir yapmak yeterli değil;
oradan çıkış yolunun da aynı kapsamı bilmesi gerekiyor.

**Repo'nun içine yerleşmiş bir git worktree'de `npm run lint` çalışmıyor.** Worktree
`<repo>/.claude/worktrees/...` altında olduğu için ESLint yukarı yürüyüp *iki* `.eslintrc.json`
buluyor ve `@next/next` eklentisini tekil olarak çözemediği için hata veriyor — hiç
dokunulmamış dosyada da aynı şekilde patlıyor, yani diff'le ilgisi yok. Taban çizgisini ölçmek
(`npx eslint src/lib/version.ts`) 30 saniyede ayırt etti. Değişen dosyaları gerçekten denetlemek
için: `npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . <dosyalar>`.
CI düz bir checkout'ta lint'lediği için orada sorun yok — nitekim "Lint · Typecheck · Build" yeşil
geçti.

**Playwright ve `node <script>.mjs`, `.env`'i kendiliğinden okumaz.** `playwright.config.ts`
dotenv yüklemiyor (CI'da değişken gerçek env olarak geliyor), bu yüzden yerelde
`DATABASE_URL=... npx playwright test ...` diye vermek gerekiyor; tek dosyalık script'ler için
`node --env-file=.env ...` iş görüyor. Ayrıca ESM çözümlemesi *dosyanın* konumuna baktığı için
scratchpad'e yazılan bir `.mjs` worktree'nin `node_modules`'ünü göremiyor — script'i worktree
içine koyup sonra silmek gerekti.

**Browser panelinin viewport'u 0×0 gelirse `read_page`/screenshot boş döner ama sayfa aslında
yüklüdür** (`javascript_tool` ile `document.body.innerText.length` bunu hemen gösteriyor).
`resize_window` düzeltmedi; doğrulamayı Playwright'a taşımak hem daha hızlı hem daha güçlü kanıt
oldu — zaten yazılması gereken e2e testi görsel kontrolün yerini fazlasıyla aldı.

**Karanlık modda `bg-*-50` kutu + `text-gray-900` metni varsayarak "kırık" demeyin, ölçün.**
`globals.css`'teki mevcut override'lar `text-gray-900`'ü kutu içinde `rgb(243,244,246)`'ya
çeviriyor; hesaplanan değeri mevcut mentor kutusuyla karşılaştırmak yeni bir compound kurala
gerek olmadığını kanıtladı. Kontrast tahmininde `getComputedStyle` gözden hızlıdır.

## 2026-08-06 — Çakışmayı çözmeden önce sor: bu iş zaten yapıldı mı? (#1076 → #1120)

**`git merge` çıktısındaki `CONFLICT (add/add)` bir uyarı işareti, sıradan bir çakışma değil.**
İki taraf da *aynı yolu sıfırdan eklemişse* bu, iki paralel implementasyon demektir — hunk'ları
birleştirmek yanlış cevaptır. #1076 (#906 mentör başvuru onay kuyruğu) `main`'e #1048 + #1072
ile inen işle aynı dosyaları yaratmıştı. Sekiz çakışmalı dosyanın ikisi add/add'di ve tanı bu
iki satırdan çıktı; hunk okumaya hiç gerek kalmadı.

**Çakışma çözmeden önce iki tarafı özellik düzeyinde karşılaştır.** `git show origin/main:<yol>`
ile karşı tarafın dosyasını okumak (diff'e bakmak değil) dakikalar sürüyor ve kararı tersine
çevirebiliyor: `main`'in versiyonunda `UNDER_REVIEW` ara durumu, `withTenantScope`, mevcut
MENTEE hesabını yükseltme, EN/TR/DE markalı e-postalar ve 6 `@smoke` testi vardı; PR'ınkinde
hiçbiri yoktu. "Birleştirmek" burada daha iyi olanın üzerine yazmak olurdu. Kapatma kararını,
issue'nun kabul kriterlerini tek tek `main`'in kodunda işaretleyerek gerekçelendirmek de
tartışmayı bitirdi.

**Yinelenen bir PR'ı kapatırken içindeki tekil parçayı ara.** #1076'nın 952 satırının
yalnızca ~25'i `main`'de yoktu (nav'daki bekleyen başvuru rozeti). Onu ayrı bir PR'a taşımak
hem katkıyı boşa çıkarmıyor hem de kapatma yorumunu "işin çöpe gitti" olmaktan çıkarıyor.
Taşırken körü körüne kopyalamayın: 60 sn'lik `setInterval` polling'i her admin sayfasından
çalışıyordu; her karar detay sayfasından ayrıldığı için `pathname` bağımlılığı aynı tazeliği
sıfır timer'la veriyor.

**Bu container'da `node_modules` yok.** `npm install` (~1 dk) arka planda başlatılıp bu sırada
düzenlemeler yapılabiliyor; `npx prisma generate` sonrası `tsc --noEmit` + `npm run build` +
`npm run check:i18n` üçlüsü lint uyarı gürültüsünden bağımsız net sinyal veriyor.
