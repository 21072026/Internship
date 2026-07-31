# Agent Experience Log

A running retrospective for AI agents (Claude Code) working in this repo. **Standing
convention: at the end of each session, append a short dated entry here** with the
concrete, reusable lessons you learned — environment quirks, tooling limits, process
gotchas — so the next session starts smarter. Keep tactical, fast-changing tips here;
promote anything that becomes a durable rule into `CLAUDE.md`.

Newest entries on top.

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
