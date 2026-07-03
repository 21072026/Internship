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
| **Stress / load** | Latency percentiles, throughput, error rate under sustained concurrency | `scripts/stress-test.mjs` | **nightly cron** (`stress.yml`) + on demand |

The first ten are **functional / correctness** tests: given an input, is the output
right? The stress test is a **non-functional** test: the app may be correct yet too
slow or fragile under load — this catches that.

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
on a schedule — **02:30 UTC nightly** — and can also be triggered manually from the
Actions tab (with an optional target-URL override). It targets the URL in the
`STRESS_TARGET_URL` secret, falling back to production.

If any threshold is breached, the job fails and the **"Email alert on failure"** step
sends a notification via [`scripts/send-alert-email.mjs`](../scripts/send-alert-email.mjs),
reusing the app's existing `SMTP_*` secrets. The recipient is the `ALERT_EMAIL_TO`
secret. When SMTP is not configured the script logs and skips (exit 0) so it never masks
the underlying failure.

### Required GitHub secrets for the alert

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — already used by deploy.
- `ALERT_EMAIL_TO` — comma-separated recipient(s) for failure alerts. **(new)**
- `STRESS_TARGET_URL` — optional; the env to stress. Defaults to `https://crm.ersah.in`. **(new)**

The same alert script can be reused by any other CI job that wants to email on failure
(e.g. adding an `if: failure()` step to `e2e.yml`).

## Ideas for further test types

- **Contract / API tests** for `/api/v1/*` against the published OpenAPI spec.
- **Visual regression** (Playwright screenshots) to catch unintended UI drift.
- **Dependency/SCA scanning** (`npm audit`, Dependabot) on a schedule.
- **Load-with-auth** scenarios (currently the stress test only hits public routes).
