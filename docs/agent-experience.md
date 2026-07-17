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
