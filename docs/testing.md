# Testing

This project is validated by several **kinds** of automated test, each catching a
different class of regression. This document is the map: what exists today, and how
the newer non-functional tests (stress + nightly automation) are wired.

## Test types in this repo

| Type | What it checks | Where | When it runs |
|------|----------------|-------|--------------|
| **Static analysis** | Lint + strict TypeScript typecheck | `npm run lint`, `npx tsc --noEmit` | CI (`ci.yml`) on every PR |
| **Build test** | Production build compiles | `npm run build` | CI (`ci.yml`) |
| **i18n parity** | EN/TR/DE translation keys stay in sync | `npm run check:i18n` | CI (`ci.yml`) |
| **Smoke / functional (E2E)** | App boots, auth works, core pages render without errors | `e2e/*.spec.ts` (Playwright) | CI (`e2e.yml`) on every PR |
| **Accessibility (a11y)** | Landmarks, roles, keyboard/contrast basics, status messages (4.1.3), reflow at 320px; OS media preferences (reduced motion, increased contrast, forced colors) | `e2e/a11y.spec.ts`, `e2e/board-a11y.spec.ts`, `e2e/live-region.spec.ts`, `e2e/mobile-layout-audit.spec.ts`, `e2e/a11y-media-preferences.spec.ts` | with E2E |
| **Security** | Headers, IDOR/RBAC, rate limiting, 2FA, login hardening | `e2e/security-headers.spec.ts`, `e2e/authz-idor.spec.ts`, `e2e/idor-hardening.spec.ts`, `e2e/rate-limit.spec.ts`, `e2e/login-security.spec.ts`, `e2e/two-factor-*.spec.ts` | with E2E |
| **XSS / injection** | User input is escaped, never executed as HTML/JS | `e2e/xss-injection.spec.ts` | with E2E |
| **Responsive / mobile** | Layout at small viewports | `e2e/mobile.spec.ts`, `e2e/users-responsive.spec.ts` | with E2E |
| **PWA / offline** | Manifest, service worker, offline page | `e2e/pwa.spec.ts`, `e2e/offline-page.spec.ts` | with E2E |
| **Health probe** | `/api/health` liveness + optional DB readiness | `e2e/health.spec.ts` | with E2E |
| **Stress / load** | Latency percentiles, throughput, error rate under sustained concurrency | `scripts/stress-test.mjs` | **weekly cron**, Mon 02:30 UTC (`stress.yml`) + on demand |
| **Load / performance (k6)** | Staged VU ramp: per-endpoint latency budgets, error rate, "was this endpoint even reached" | `k6/nightly-load.js` | **nightly cron**, 23:40 UTC (`k6-load.yml`) + on demand |
| **Demo-seed fidelity** | Every differentiating screen has demo rows behind it | `scripts/check-demo-fidelity.mjs` + `scripts/demo-fidelity.json` | CI (`ci.yml`, `demo-fidelity` job) on every PR |

The first ten are **functional / correctness** tests: given an input, is the output
right? The last two are **non-functional**: the app may be correct yet too slow or
fragile under load — those catch that. They are not redundant with each other.
`stress-test.mjs` is a flat hammer (fixed concurrency, one aggregate p95, weekly);
the k6 scenario adds a *ramp* (where does latency start to bend?), *per-endpoint*
budgets, and a threshold engine that names exactly which budget broke.

## Async UI states

Use `AsyncSection` for new asynchronous lists and panels: loading, error and empty are distinct states.
Loading must never render the empty state, and errors should offer a retry when the caller can reload.
The component owns presentation only; fetching, state and retry behavior stay in the caller.
Choose the smallest matching `list`, `card` or `stats` skeleton variant.

## Stress / load test

`scripts/stress-test.mjs` is a dependency-free (native `fetch`) load generator. It
fires sustained concurrent GET requests at a set of public, read-only routes for a
fixed duration, then reports throughput and latency percentiles (p50/p95/p99) and the
error rate. It **exits non-zero** when any threshold is breached, so it can gate CI and
trigger the failure-email alert. It only issues side-effect-free GETs, so it is safe to
point at a live preview/production environment.

```bash
# Against local dev (start the app first with `npm run dev`)
npm run test:stress

# Against a deployed environment
BASE_URL=https://crm-preview.ersah.in npm run test:stress
```

### Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `BASE_URL` | `http://localhost:3000` | Target origin |
| `STRESS_PATHS` | `/,/auth/signin,/api/health` | Comma-separated paths to hammer |
| `STRESS_CONCURRENCY` | `20` | Parallel workers |
| `STRESS_DURATION_MS` | `20000` | Test duration |
| `STRESS_WARMUP_MS` | `1000` | Ignore samples before this (skips cold-start) |
| `STRESS_TIMEOUT_MS` | `10000` | Per-request timeout |
| `STRESS_MAX_ERROR_RATE` | `0.02` | Fail above 2% errors |
| `STRESS_MAX_P95_MS` | `2000` | Fail if p95 latency exceeds this |
| `STRESS_MIN_RPS` | `0` (off) | Fail if throughput drops below this |
| `STRESS_SUMMARY_FILE` | — | If set, writes a JSON summary (used by the alert email) |

## Nightly automation (the cron)

[`.github/workflows/stress.yml`](../.github/workflows/stress.yml) runs the stress test
on a schedule — **02:30 UTC every Monday** — and can also be triggered manually from
the Actions tab (with an optional target-URL override). It targets the URL in the
`STRESS_TARGET_URL` secret, falling back to production.

If any threshold is breached, the job fails and the **"Email alert on failure"** step
sends a notification via [`scripts/send-alert-email.mjs`](../scripts/send-alert-email.mjs),
reusing the app's existing `SMTP_*` secrets. The recipient defaults to the maintainer
and can be overridden with an `ALERT_EMAIL_TO` secret. When SMTP is not configured the
script logs a GitHub Actions warning and skips (exit 0) so it never masks the underlying
failure.

### Required GitHub secrets for the alert

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — already used by deploy.
- `ALERT_EMAIL_TO` — optional; comma-separated recipient(s) for failure alerts. Defaults to the maintainer if unset. **(new)**
- `STRESS_TARGET_URL` — optional; the env to stress. Defaults to `https://crm.ersah.in`. **(new)**

The same alert script can be reused by any other CI job that wants to email on failure
(e.g. adding an `if: failure()` step to `e2e.yml`).

## Load / performance test (k6)

[`k6/nightly-load.js`](../k6/nightly-load.js) walks the **public, read-only** surface of a
*deployed* environment under a staged VU ramp and fails the run when a latency, error-rate
or per-endpoint budget is exceeded. k6 is a standalone binary, **not** an npm dependency —
`npm run test:load` assumes it is on your `PATH`.

```bash
# Install k6 (Linux; see https://grafana.com/docs/k6/latest/set-up/install-k6/ for other OSes)
curl -fsSL https://github.com/grafana/k6/releases/download/v1.8.1/k6-v1.8.1-linux-amd64.tar.gz \
  | tar -xz --strip-components=1 -C ~/.local/bin

BASE_URL=https://crm-preview.ersah.in npm run test:load   # ~6m00s, the real ramp
K6_SMOKE=1 K6_PEAK_VUS=3 npm run test:load                # ~40s, "does my script still parse"
```

`K6_SMOKE=1` is a **script check, not a measurement** — the sample is far too small to judge
an environment by, and a run that short may not reach the 1-in-6 `health_db` probe, which
legitimately fails its `count>0` threshold.

### Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `BASE_URL` | `https://crm-preview.ersah.in` | Target origin. Preview, not prod, so a reflexive `npm run test:load` cannot ramp the live site |
| `K6_PEAK_VUS` | `20` | Peak virtual users; the ramp's intermediate steps scale with it. Clamped to 1–50 |
| `K6_SMOKE` | — | `1` collapses the ramp to ~40s (script check only) |
| `K6_SUMMARY_FILE` | `k6-summary.json` | Where `handleSummary` writes the machine-readable summary |

### The ramp

`30s → 5 VU · 1m @ 5 · 30s → 15 · 2m @ 15 · 30s → 20 · 1m @ 20 · 30s → 0` — 6m00s of stages and
~10 req/s at peak. Peak 20 VU is deliberately *below* the 25 concurrent `stress.yml` has run
against production since 2026-07: what k6 adds here is **duration and shape**, not depth.

### Endpoint mix

Every request is `GET`, anonymous, and tagged `{ ep: <name> }` so it gets its own budget.

| `ep` tag | Path | Frequency | Why it is in the mix |
|----------|------|-----------|----------------------|
| `landing` | `/` | every iteration | The heaviest safe GET (SSR + published stories + cached public stats) and the page every visitor sees |
| `signin` | `/auth/signin` | 1 in 2 | SSR with zero Prisma — if this is slow, the Node process itself is saturated |
| `features` | `/features` | 1 in 3 | Rendered from the in-process feature catalogue, no DB |
| `stories_api` | `/api/public/stories` | 1 in 3 | Small JSON, one Prisma read |
| `health` | `/api/health` | 1 in 4 | Liveness. Costs four `EmailLog` queries unless `HEALTH_TOKEN` is set on the server |
| `health_db` | `/api/health?db=1` | 1 in 6 | The above plus a `SELECT 1` round-trip to MySQL |

### Thresholds

Each one carries its reasoning as a comment in `options.thresholds`. The two aggregate limits
deliberately match the ones production has been held to since `stress.yml` shipped.

| Metric | Limit | Why |
|--------|-------|-----|
| `http_req_failed` | `rate<0.02` | Same 2% as `STRESS_MAX_ERROR_RATE`. Carries `abortOnFail` (after a 1-minute grace) so a genuinely dead target stops the run early |
| `http_req_duration` | `p(95)<2500`, `p(99)<5000` | p95 mirrors `STRESS_MAX_P95_MS`; p99 gets 2× headroom so a fat tail shows without a single outlier firing |
| `http_req_waiting` | `p(95)<2000` | TTFB isolates server think-time from transfer |
| `checks` | `rate>0.98` | A wrong status (unexpected redirect, 503). One check per request, so this is ~1 − the error rate; at `0.99` it would silently replace the 2% error budget with a 1% one |
| `http_req_duration{ep:health}` | `p(95)<800` | Budgeted for the un-tokened detail path; ~50ms once `HEALTH_TOKEN` is set |
| `http_req_failed{ep:health}` | `rate<0.01` | The liveness probe failing is an outage — the tightest budget here. Not tighter: a run makes ~220 health requests, so `0.005` would mean "at most one failed probe all night" |
| `http_req_failed{ep:*}` | `rate<0.02` | Every other endpoint carries the aggregate error budget individually, so one broken path cannot hide behind five healthy ones |
| `http_req_duration{ep:health_db}` | `p(95)<1000` | Health plus one MySQL round-trip |
| `http_req_duration{ep:landing}` | `p(95)<2000` | Heaviest page, most generous page budget |
| `http_req_duration{ep:signin}` | `p(95)<1500` | No DB work at all |
| `http_req_duration{ep:features}` | `p(95)<1500` | No DB work at all |
| `http_req_duration{ep:stories_api}` | `p(95)<1200` | One small read |
| `http_reqs{ep:*}` | `count>0` | Asserts each endpoint was actually exercised — a path that silently drops out of the mix would otherwise look green |

Per-endpoint budgets are tighter than the aggregate *because they are allowed to be*: holding
`/auth/signin` to the landing page's 2500ms would make it untestable.

#### Measured baseline (2026-08-26, production, 1 VU)

The budgets above were set by reasoning about what each endpoint does, then sanity-checked
against an unloaded production baseline. They are **not** derived from a loaded run, so treat
the first few nightly results as calibration rather than as a verdict:

| `ep` | baseline p95 | budget | headroom |
|------|--------------|--------|----------|
| `health` | 156ms | 800ms | 81% |
| `stories_api` | 164ms | 1200ms | 86% |
| `signin` | 539ms | 1500ms | 64% |
| `features` | 677ms | 1500ms | 55% |
| `landing` | 777ms | 2000ms | 61% |

Roughly 2–6× baseline. That is deliberate: latency at 20 VU is higher than at 1 VU, and a
budget with no room for the load the test itself applies would fire every night. If the real
nightly numbers land far from these, move the budgets — and say so in the comment next to them.

### Safety rules (these are hard constraints)

A k6 script in this repo points at a **live, shared environment**, so:

- **GET only.** No `POST`/`PUT`/`PATCH`/`DELETE`, ever. Nothing may mutate a row.
- **No authentication.** No login (bcrypt is deliberately expensive, and the failed-login
  bucket would lock the runner's IP out), no session cookie, no API key.
- **No endpoint** that sends email, calls an AI provider, polls IMAP, talks to Google/JaaS, or
  increments a counter (so: never `/api/profile-view`).
- **No rate-limited route.** All VUs share one source IP, hence one rate-limit bucket —
  `/api/public/stats` (60 / 10 min) and `/api/v1/*` (120 / min) are excluded on purpose. A 429
  in a report means the mix drifted, not that the app is unhealthy.

### The nightly cron and the alert

[`.github/workflows/k6-load.yml`](../.github/workflows/k6-load.yml) runs the scenario at
**23:40 UTC daily** (01:40 Europe/Berlin CEST, 02:40 Europe/Istanbul) against
`STRESS_TARGET_URL` — the same secret `stress.yml` uses — falling back to production. A manual
`workflow_dispatch` takes a target URL and a peak-VU override.

There is **no drift gate** here, unlike `e2e-full.yml` and the deploy workflows: those skip a
scheduled firing when the commit has not changed, because re-testing the same code repeats the
same verdict. A load test measures the *environment*, and an environment degrades (a full disk,
a bloated table, a noisy neighbour) without any commit changing.

**Green sends nothing.** Silence is the "all fine" signal. On red,
[`scripts/k6-report-email.mjs`](../scripts/k6-report-email.mjs) sends a Turkish breach report:
which thresholds broke with *actual vs limit*, the run totals, and a per-endpoint table
(requests, p95, p99, error %). Set the repository **variable** `K6_REPORT_MODE=always` for a
green summary too.

The verdict comes from the summary artifact, **not** from k6's exit code — deliberately, so
that "k6 crashed before it wrote anything" is red with its own subject line rather than silence.
Preview an email without SMTP:

```bash
# K6_REPORT_MODE=always matters here: without it a green summary is skipped
# silently (which is the whole point in CI) and you see no preview at all.
K6_REPORT_DRY_RUN=1 K6_REPORT_MODE=always \
  K6_SUMMARY_FILE=k6-summary.json node scripts/k6-report-email.mjs
```

### Required GitHub secrets / variables

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — already used by deploy.
- `ALERT_EMAIL_TO` — optional; defaults to the maintainer.
- `STRESS_TARGET_URL` — optional; shared with `stress.yml`. Defaults to `https://crm.ersah.in`.
- `K6_REPORT_MODE` — optional repository *variable*; `always` to get green summaries too.

### Adding a new k6 test

Writing one is **expected** when a change puts real load on a surface the nightly mix does
not cover.

1. Create `k6/<name>.js`. **Keep it `.js`.** A `.ts` file here is picked up by
   `tsconfig.json`'s `**/*.ts` include and `npx tsc --noEmit` fails on the missing `k6/*`
   module types — that is deliberate, so the rule enforces itself rather than relying on
   anyone remembering it.
2. Export `options` with your `scenarios` and `thresholds`, and a default function.
3. **Tag every request** `{ ep: '<name>' }` and give each tag a
   `http_req_duration{ep:…}` budget plus a `http_reqs{ep:…}: ['count>0']` line — a tagged
   sub-metric only appears in the JSON summary when a threshold references it, and the alert
   email builds its per-endpoint table from exactly those sub-metrics.
4. **Every stat a threshold names must also be in `options.summaryTrendStats`.** k6 evaluates
   the threshold either way, but the summary only carries the stats listed there, so a
   `p(99)<…` breach on k6's default trend stats reaches the email with no number attached.
   Copy the list from `nightly-load.js`.
5. Reuse the `handleSummary` shape from `nightly-load.js` so the same reporter can read it.
6. Stay inside the safety rules above.
7. Validate in under a minute: `K6_SMOKE=1 K6_PEAK_VUS=3 BASE_URL=http://localhost:3000 k6 run k6/<name>.js`,
   then `npm run check:k6` (a `k6 archive` parse of everything in `k6/`).
8. Wire it up in **its own workflow**, modelled on `k6-load.yml`. Do *not* add a second
   `k6 run` step to `k6-load.yml`: it hardcodes one summary filename in three places (the run
   step's env, the artifact path, and the reporter's input), so a second scenario would
   overwrite the first one's summary and the nightly email would silently describe only the
   last one to finish.
9. Add a row to the tables above.

**Nothing in `k6/` is linted or typechecked** — `next lint` only visits `src/`, and
`tsconfig.json`'s `include` lists only `*.ts|tsx`, so a `.js` file there is invisible to
both. That is what `npm run check:k6` is for: it runs `k6 archive`, which bundles and
evaluates the init context (catching syntax errors, bad imports, invalid `options` keys and
thresholds naming a metric that does not exist) without issuing a single request. CI runs it
on every PR, so a typo fails the PR instead of surfacing at 23:40 UTC as a "the load test
crashed" email.

### If `ep:health` goes red first, look here

`/api/health` runs four `EmailLog` queries per request when `HEALTH_TOKEN` is unset on the
server, and one of them is `findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt:
'desc' } })`. `EmailLog` has single-column indexes on `status` and `createdAt` but **no
composite `[status, createdAt]** (`prisma/schema.prisma`), so on an append-only ledger MySQL
must either filesort the FAILED set or walk `createdAt` backwards past every non-FAILED row.
As the table grows, that query — not the app — is the likeliest cause of an `ep:health`
breach. Setting `HEALTH_TOKEN` on the server removes the whole detail path from the anonymous
probe and is the cheaper fix.

## OS accessibility media preferences

Three user preferences the browser exposes as media features are **supported and
tested** (#2045). Before that work a repo-wide grep for them returned zero hits in
`src/` and `e2e/`, and axe never noticed — it scans one rendering, with no preference
emulated, so a clean baseline said nothing at all about any of this.

| Media feature | What the app does | Where |
|---------------|-------------------|-------|
| `prefers-reduced-motion: reduce` | Blanket `animation-duration`/`transition-duration` collapse on `*, *::before, *::after`, plus `scroll-behavior: auto`. Behaviour is untouched: the mobile drawer still opens and closes, it just arrives instantly. Skeleton placeholders (whose only affordance is the pulse) switch to a static fill + inset ring. The two *scripted* scrolls (message thread → newest bubble, project editor → its form) ask in JS, because an explicit `ScrollOptions.behavior` beats any CSS `scroll-behavior`. | `src/app/globals.css` (media-preference block at the end of the file), `src/components/ui/Skeleton.tsx`, `src/lib/reducedMotion.ts` |
| `prefers-contrast: more` | Hairline borders (`border-gray-100/200`, `divide-gray-50/100`) and secondary text (`text-gray-400/500`) are re-tinted through the same flat-utility remap the dark-mode layer uses — every rule duplicated for `html.dark`, because the dark layer scores (0,2,0) and would otherwise swallow a bare utility selector. | `src/app/globals.css` |
| `forced-colors: active` (Windows High Contrast) | The focus ring names the system `Highlight` colour instead of a hardcoded `#2563eb`; `forced-color-adjust: none` is applied **only** to the `/account` accent swatches, where the fill *is* the content; badges get an inset outline and board drop targets a `Highlight` outline, so no state is carried by background colour alone. | `src/app/globals.css`, `src/components/ui/Badge.tsx`, `src/components/AccountSettings.tsx`, `src/app/{admin,mentor}/board/page.tsx` |

Everything lives inside its media query, so a user who has set no preference gets the
default light and dark themes byte-for-byte unchanged — which is also why the axe
baseline (`e2e/a11y-baseline.json`, empty across 18 keys) is unaffected.

### How to test them

`e2e/a11y-media-preferences.spec.ts` is the regression net. Playwright emulates all
three:

```ts
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.emulateMedia({ contrast: 'more' });
await page.emulateMedia({ forcedColors: 'active' });
```

`emulateMedia` **merges** into what is already emulated, so a loop over several
preferences must spell out all three keys (`null` resets one) or the second iteration
is silently "reduced motion AND high contrast".

The spec asserts: the drawer's computed `transition-duration` is effectively zero yet
`data-open` still flips both ways; a frozen skeleton is still drawn; a keyboard focus
ring is still visible under forced colors; the accent swatches keep six distinct fills;
and neither the landing page nor a signed-in page scrolls sideways under any of the
three. It is **not** `@smoke` — it runs in the scheduled full suite.

Run just this file:

```bash
npx playwright test e2e/a11y-media-preferences.spec.ts
```

By hand, in Chrome DevTools: **Rendering** panel → *Emulate CSS media feature
prefers-reduced-motion / prefers-contrast / forced-colors*.

Two things the spec deliberately does **not** cover, so nobody goes looking for them:
the JS side (`prefersReducedMotion()` / `scrollBehavior()` in `src/lib/reducedMotion.ts`)
would need a seeded conversation and a thread long enough to scroll to assert anything
real, and the *visual* result of `prefers-contrast: more` is a colour judgement, not a
threshold — the spec only proves the layout survives it.

VPAT rows (#2037) can cite this section for WCAG 2.3.3 (Animation from Interactions),
1.4.11 (Non-text Contrast) and 2.4.7 (Focus Visible) under forced colors.

## Scheduled full E2E summary email

The scheduled full suite (`e2e-full.yml`, 4×/day, 4-way sharded) sends a **Turkish
summary email after every run** via
[`scripts/e2e-report-email.mjs`](../scripts/e2e-report-email.mjs): on green a
`✅ … 238/238 test geçti` heartbeat with the run stats (toplam/geçen/başarısız/flaky/
atlanan, süre); on red the failing tests with file, title, and error snippet. The
script aggregates the per-shard Playwright JSON reports and flags a shard that crashed
before writing its report (`E2E_EXPECTED_REPORTS`). Recipients come from
`ALERT_EMAIL_TO`; set the repository **variable** `E2E_REPORT_MODE=failures` to switch
back to red-only alerts.

## Demo-seed fidelity gate (#2063)

The demo seed (`prisma/seed-demo.mjs`) is the only data most people ever see: the
public demo, every per-PR topic environment at `crm-pr<N>.ersah.in`, and every new
contributor's local box. The failure mode this gate exists for is not a crash — a
feature ships, nobody adds a matching block to the seeder, and its screen renders
*perfectly* and *empty* in all three places. Nothing goes red; the first person to
notice is whoever is mid-demo.

`scripts/demo-fidelity.json` declares, per screen, how many rows the seed must
produce. `npm run check:demo-fidelity` counts them with Prisma, prints a
`model / expected / actual` table, and exits 1 naming both the **screen** and the
**owning issue** for every shortfall. CI runs it in the `demo-fidelity` job in
`ci.yml`, which spins up a throwaway MySQL and does
`prisma db push` → `prisma db seed` → `npm run seed:demo` → the check.

It refuses any `DATABASE_URL` the demo seeder itself would refuse, using the *same*
predicate — `prisma/demoTarget.mjs`, imported by both. Counting is read-only, but a
manifest tuned to synthetic data says nothing about a real database, and pointing it
at prod would be a PII read. Never fork that predicate: two copies that can disagree
are not a guard. `scripts/test/demo-target.test.mjs` covers it.

### The manifest is a ratchet

Each entry carries two numbers:

- **`minRows`** — the *enforced* floor, set to what the seeder produces **today**.
  A count below it fails the build. So coverage can go up and never quietly back down.
- **`target`** — how many rows the screen needs to stop reading as empty.

A row where `minRows < target` is reported as **pending**, with its owning issue, on
every single run. That is deliberate: the screens that still have zero seed coverage
(requisitions, interview requests, offers, panels, company interest, weekly reports,
mentor questions, documents, `SOURCE` users — owned by **#2062** and **#1419**) stay
listed and visible instead of being dropped from the manifest to make the table look
tidy. Run with `DEMO_FIDELITY_STRICT=1` to enforce `target` as well; that is how the
owning issue verifies its own seeding before raising `minRows`.

### How to add a screen to the demo-fidelity manifest

Do this in the **same PR** that ships the feature, the same way a user-visible feature
gets a `src/lib/features.ts` entry and a release fragment.

1. **Seed the rows** in `prisma/seed-demo.mjs`. Keep it idempotent and namespaced
   (`@demo.example.com` emails, "Demo" in names) like everything else there.
2. **Add an entry** to the `entries` array in `scripts/demo-fidelity.json`:
   ```json
   {
     "model": "WeeklyReport",
     "minRows": 4,
     "target": 4,
     "screen": "/weekly-reports — mentee weekly reporting",
     "issue": "#1419"
   }
   ```
   - `model` must match a model name in `prisma/schema.prisma`. The checker resolves it
     against the Prisma client and **hard-fails on a name it cannot find** — a typo here
     would count nothing and pass silently, which is the exact bug this gate prevents.
   - `screen` is what a reviewer reads in the failure message. Give the route(s), not
     the model name again.
   - `issue` is who to talk to when it goes red.
   - Optional `where` (a Prisma filter) plus `label` narrows the count — that is how the
     `SOURCE`-role user row works: `"where": { "role": "SOURCE" }`.
3. **Set `minRows` honestly.** It is the count the seeder actually produces, not an
   aspiration. If you cannot seed the screen yet, still add the row with `minRows: 0`,
   a real `target`, and the issue that will close the gap — it will list as pending on
   every run. Do **not** omit the row; an absent screen is exactly the silence this
   gate replaces.
4. **Verify locally** against a scratch database (see the top of this file / the
   security playbook for standing one up):
   ```bash
   npx prisma db push && npx prisma db seed && npm run seed:demo
   npm run check:demo-fidelity
   ```
   Then delete your new seed block and re-run against a fresh database — if the checker
   does not go red, the entry is not wired to anything.
## Accessibility regression gate (axe)

[`e2e/a11y-scan.spec.ts`](../e2e/a11y-scan.spec.ts) runs `@axe-core/playwright` over the
app against WCAG 2.0/2.1/2.2 A+AA and compares each page's *critical* and *serious*
counts with the frozen [`e2e/a11y-baseline.json`](../e2e/a11y-baseline.json). It carries
no `@smoke` tag, so `e2e.yml` runs it as **its own step** on every PR — the smoke set
stays small while the gate still blocks. The human-readable report is
[`docs/a11y-audit.md`](a11y-audit.md); both files are regenerated together:

```bash
A11Y_UPDATE_BASELINE=1 npx playwright test e2e/a11y-scan.spec.ts
```

**Coverage** — fifteen pages, each scanned twice (light, then `#dark` with a full reload,
never by pasting `.dark` onto an already-rendered page):

| Context | Pages |
|---|---|
| public | `/`, `/auth/signin`, `/apply/:mentorId` |
| mentee | `/portal`, `/portal/profile`, `/messages`, `/notifications` |
| mentor | `/mentor`, `/mentor/mentees`, `/mentor/board` |
| admin | `/admin`, `/admin/candidates`, `/admin/board`, `/admin/settings` |
| company | `/company` |

The six non-portal screens were added in #2043, on the shared
`seedMenteeWithRelation()` fixture in [`e2e/helpers/db.ts`](../e2e/helpers/db.ts) — a real
mentor ↔ mentee relation with a company, a goal, an interaction and an upcoming meeting.
That fixture is the point: a board with no cards, or an inbox with no threads, scans clean
and proves nothing, so a board scan asserts a `board-card` is visible *before* axe runs.
Add a page by extending the list in the matching context, not by seeding a second fixture.

**Never widen the baseline silently.** A regenerate that raises a count prints
`⚠️ This regenerate WIDENS the accessibility baseline` and repeats the list in the report
header; each widened key must be fixed or justified in the PR body (#1333 is the run where
a quiet widening got in). A dynamic route is keyed separately from its URL — `/apply/:mentorId`
— so a fresh fixture's id cannot invent a new baseline entry on every run.

## Accessibility media preferences (#2045)

The browser reports three OS-level accessibility settings, and the app honours all
three. The rules live in one block at the **end of `src/app/globals.css`** (last, so
they win on source order over the `html.dark` / `html[data-accent]` layers above),
and `e2e/a11y-media-preferences.spec.ts` asserts them — **not `@smoke`**, so they run
in the scheduled full suite. Cite this section for the VPAT rows.

| Media feature | What the app does | How it is tested |
|---|---|---|
| `prefers-reduced-motion: reduce` | Blanket near-zero `animation-duration` / `transition-duration` on `*` — the mobile drawer, `animate-pulse` skeletons, `animate-spin` spinners, `animate-ping` and every `transition-*`. State changes still happen instantly (the drawer still opens and closes); nothing listens for `transitionend`. Programmatic smooth scrolling passes `behavior` as an argument, which CSS cannot override, so those call sites go through `scrollBehavior()` in [`src/lib/motion.ts`](../src/lib/motion.ts). | `page.emulateMedia({ reducedMotion: 'reduce' })` — computed `transition-duration` is effectively zero, and the drawer's bounding box still moves on open/close |
| `prefers-contrast: more` | Gray borders (`border-gray-100/200/300`, the `divide-*` rules) darken and secondary text (`text-gray-400/500`) lifts to gray-700; dark mode gets its own values because `html.dark .border-gray-200` outranks the bare utility. The focus ring goes to 3px. | `page.emulateMedia({ contrast: 'more' })` — the computed border and text colours are measurably darker than the default |
| `forced-colors: active` (Windows High Contrast) | The focus ring is restated as `outline: 3px solid Highlight !important` (the accent rule outscores a bare `a:focus-visible`); the accent swatches — the one place the colour *is* the information — opt out with `forced-color-adjust: none` via `[data-accent-swatch]`; badges gain a border so a pill flattened to Canvas-on-Canvas still reads as one. | `page.emulateMedia({ forcedColors: 'active' })` — after a `Tab`, the focused element still has a solid outline ≥ 2px |

Each test also re-runs the no-sideways-scroll rule, since a preference that changes
border widths or text size can push a layout past the viewport.

**When adding UI**: a new animation needs nothing (the blanket rule covers it), but a
new element whose *state* is carried by background colour alone needs a border, an
icon or text as well — that is the one thing `forced-colors` cannot rescue.

## The three WCAG categories axe cannot reach (#2047)

An empty axe report is a clean *automated* scan, not an AA claim. Three criteria are
structurally out of a scanner's reach, and each has its own procedure here. Cite this
section, and [`docs/a11y-audit.md`](a11y-audit.md), for the VPAT rows.

| Criterion | Why axe cannot see it | Where it is covered |
|---|---|---|
| **4.1.3 Status Messages** | axe can find an `aria-live` container; it cannot tell whether text ever *arrives* in one, and a live region mounted together with its message is silent in every screen reader. | One app-wide region: [`src/components/ui/LiveRegion.tsx`](../src/components/ui/LiveRegion.tsx), mounted empty in `src/app/providers.tsx`. Asserted by `e2e/live-region.spec.ts`. |
| **1.4.10 Reflow** | Needs a measurement at a specific viewport, which a DOM scan does not perform. | `e2e/mobile-layout-audit.spec.ts` — 320×568 and 320×256 (the 400%-zoom equivalent), in German and Turkish. |
| **Manual AT testing** | Nothing automated substitutes for it. | The task list, the findings and — honestly — what has **not** been run yet, in the manual section of [`docs/a11y-audit.md`](a11y-audit.md). |

**Announcing a status message.** Call `useAnnounce()` and speak through the one region;
do not add an `aria-live` container of your own. Three rules that keep it usable:

- announce only what has no visible home of its own, or whose visible home is too terse
  to be understood out of context — a `Toast` and `AsyncSection`'s error branch are
  already `role="status"` / `role="alert"`, and announcing them again speaks them twice;
- never per keystroke. A filter goes through
  [`useFilterAnnouncement`](../src/hooks/useFilterAnnouncement.ts), which debounces and
  de-duplicates; a threshold (the `Textarea` character counter) announces on the
  crossing, not on the value;
- every announced string needs EN/TR/DE keys, under the `a11y:` block of
  `src/i18n/dictionaries.ts`. `npm run check:i18n` enforces the parity.

**Measuring reflow.** 320 CSS pixels is the criterion's floor, and 400% zoom on a
1280×1024 desktop lays out in a quarter of each dimension — so a 320×256 viewport *is*
the 400% case. Run both, in German and Turkish: those dictionaries carry the longest
labels, and a control that fits in English overflows once translated (the calendar's
view switcher did exactly that). At 320px the useful assertion is the one 1.4.10 makes
— *does the page force scrolling in two directions* — rather than the stricter
four-rule sweep the same file runs at 360px, because the board and the calendar contain
deliberate scrollers.

**Running the manual walkthrough.** The task list is written out in
[`docs/a11y-audit.md`](a11y-audit.md) so it is repeated rather than reinvented. Record
the AT and browser versions, the date and the tester; file every finding as its own
issue and link it from the findings table. If you did not actually run it, say so in
the document — a fabricated manual-testing record is worse than an empty one.

## Ideas for further test types

- **Contract / API tests** for `/api/v1/*` against the published OpenAPI spec.
- **Visual regression** (Playwright screenshots) to catch unintended UI drift.
- **Dependency/SCA scanning** (`npm audit`, Dependabot) on a schedule.
- **Load-with-auth** scenarios — both load tests are anonymous-GET-only by design. The
  natural home is the demo environment (its own DB, publishable credentials), not prod.
