# Agent Experience Log

A running retrospective for AI agents (Claude Code) working in this repo. **Standing
convention: at the end of each session, append a short dated entry here** with the
concrete, reusable lessons you learned — environment quirks, tooling limits, process
gotchas — so the next session starts smarter. Keep tactical, fast-changing tips here;
promote anything that becomes a durable rule into `CLAUDE.md`.

Newest entries on top.

---

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
