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
| **Accessibility (a11y)** | Landmarks, roles, keyboard/contrast basics | `e2e/a11y.spec.ts`, `e2e/board-a11y.spec.ts` | with E2E |
| **Security** | Headers, IDOR/RBAC, rate limiting, 2FA, login hardening | `e2e/security-headers.spec.ts`, `e2e/authz-idor.spec.ts`, `e2e/idor-hardening.spec.ts`, `e2e/rate-limit.spec.ts`, `e2e/login-security.spec.ts`, `e2e/two-factor-*.spec.ts` | with E2E |
| **XSS / injection** | User input is escaped, never executed as HTML/JS | `e2e/xss-injection.spec.ts` | with E2E |
| **Responsive / mobile** | Layout at small viewports | `e2e/mobile.spec.ts`, `e2e/users-responsive.spec.ts` | with E2E |
| **PWA / offline** | Manifest, service worker, offline page | `e2e/pwa.spec.ts`, `e2e/offline-page.spec.ts` | with E2E |
| **Health probe** | `/api/health` liveness + optional DB readiness | `e2e/health.spec.ts` | with E2E |
| **Stress / load** | Latency percentiles, throughput, error rate under sustained concurrency | `scripts/stress-test.mjs` | **weekly cron**, Mon 02:30 UTC (`stress.yml`) + on demand |
| **Load / performance (k6)** | Staged VU ramp: per-endpoint latency budgets, error rate, "was this endpoint even reached" | `k6/nightly-load.js` | **nightly cron**, 23:40 UTC (`k6-load.yml`) + on demand |

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

## Ideas for further test types

- **Contract / API tests** for `/api/v1/*` against the published OpenAPI spec.
- **Visual regression** (Playwright screenshots) to catch unintended UI drift.
- **Dependency/SCA scanning** (`npm audit`, Dependabot) on a schedule.
- **Load-with-auth** scenarios — both load tests are anonymous-GET-only by design. The
  natural home is the demo environment (its own DB, publishable credentials), not prod.
