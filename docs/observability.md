# Database observability (#1608)

We measure HTTP latency nightly (k6, [docs/testing.md](testing.md)); this is the instrument for
what the database does underneath it. Three pieces, all fed by one timing hook:

| Piece | Where | On by default |
|---|---|---|
| Slow-query log | `src/lib/dbQueryObserver.ts` ← `src/lib/prisma.ts` | off in production, 200 ms elsewhere |
| Per-request query count + ceiling warning | `src/lib/requestContext.ts` | always (warning); header outside production |
| N+1 report | `e2e/db-query-report.spec.ts` ← `/api/dev/db-tally` | e2e server only |

## The hook

`src/lib/prisma.ts` registers one Prisma middleware, first, guarded by
`globalForPrisma.queryObserverInstalled` (the same one-time pattern as the tenant middleware in
`src/lib/orgContext.ts`). It times every operation and calls
`observeQuery(model, action, durationMs)`. Being first, the time includes every middleware after
it — the tenant filter — which is the cost the caller actually paid.

**Never the params.** A query's values carry e-mail addresses, names and message bodies. The
hook passes the model, the action and the duration, and the logger adds the request id from
#1601 — nothing else. `scripts/test/db-query-observer.test.mjs` asserts statically that neither
the hook nor the observer reads `params.args`.

## Slow-query log — `DB_SLOW_QUERY_MS`

Any operation slower than the threshold logs one `warning`:

```
[WARNING] Slow database query {"level":"warning","message":"Slow database query","requestId":"…","orgId":"…","model":"EmailLog","action":"findFirst","durationMs":412,"thresholdMs":250}
```

- **Production: off until measured.** A guessed threshold either floods the log or says
  nothing. Set `DB_SLOW_QUERY_MS` on the server once you have a baseline (e.g. the p99 of a
  quiet day plus margin), and lower it as the known offenders are fixed.
- **Elsewhere: 200 ms** by default, so a developer sees the slow ones without asking.
- `0` switches it off explicitly; anything unparseable is off.

## Per-request query count — `DB_QUERY_WARN_CEILING`

Inside a request bound by `withRequestScope` (#1601), every query is counted against that
request. When the count passes the ceiling (default **50**), one warning names the top models:

```
[WARNING] Request exceeded the database query ceiling {"requestId":"…","ceiling":50,"queries":51,"top":"Conversation×38, User×6, Message×4"}
```

A loop that issues one query per row is the shape this catches: invisible at ten rows, an
outage at ten thousand. Outside production the count is also returned as the
**`x-db-queries`** response header, so it is visible in the network tab while working.
Production never sends it — it would be a free map of what each endpoint costs.

## N+1 report — CI, reporting only

`e2e/db-query-report.spec.ts` opens `/messages` (the inbox's per-relation conversation lookup),
`/admin/board` and `/admin/candidates` (#1436–#1438) and records, per Prisma model, every query
the page cost — the server render plus each API call it makes before the network goes quiet.
Results land in the Playwright report as an annotation and a JSON attachment per page; any
model above 25 queries is annotated `suspected-n+1`.

It **does not fail on a count.** A gate on day one would only be red on offenders that already
have their own fixes queued. Promote it to a gate once those land.

How it counts: the e2e server runs with `DB_QUERY_TALLY=1` (`playwright.config.ts`), which turns
on a process-wide per-model tally. The spec resets it, loads the page, and reads it back from
`GET /api/dev/db-tally`. Playwright runs one worker against one server, so nothing else queries
between the reset and the read. The route answers 404 on every server without the flag, and
requires an ADMIN session on the one that has it.

## Indexes added with this change

| Model | Index | Query it serves |
|---|---|---|
| `EmailLog` | `[status, createdAt]` | `/api/health`'s `findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' } })`; the email-log screen's `groupBy` over `{ status, createdAt: { gte } }` |
| `ActivityLog` | `[orgId, createdAt]` | `/admin/activity`: one tenant's rows, `orderBy: { createdAt: 'desc' }`, paginated |
| `Message` | `[senderId, createdAt]` | the activity report's sent/received counts (`senderId` + `createdAt: { gte }`), the message-retention sweep (#2056) and erasure |

Reviewed and left alone: `PageView` already has `[userId, createdAt]` for its only per-user
reader; `MentorshipRelation`'s hot filters (`mentorId`, `menteeId`, `orgId`) are foreign keys
MySQL indexes already, and its low-cardinality `status` adds little as a second column.

# Error tracking (#1600)

A runtime failure used to exist only as container stdout. Now it can also become a grouped
event with a stack, a route, a role, an org id, a request id and a release — in any tracker that
speaks the **Sentry envelope protocol**.

## The decision: a protocol, not an SDK

| | |
|---|---|
| Receiver | Anything that accepts Sentry envelopes: Sentry (hosted free tier to start), or self-hosted **GlitchTip** / **Bugsink** on our own box. Switching is a DSN change. |
| Client | Ours — `src/lib/errorTrackingRule.ts` (rules, pure) + `src/lib/errorTracking.ts` (the one sender, `fetch` only). No vendor SDK. |
| Why no SDK | It would have to load from `src/instrumentation.ts`, which Next also compiles for the edge runtime (see its header), and it auto-collects request bodies, headers and breadcrumbs that we would then have to scrub after the fact. An allowlist we own is easier to prove than a scrubber over someone else's payload. |
| Performance traces | **Not collected** (sample rate 0). This is error tracking only; latency is the nightly k6 run's job (`docs/testing.md`). A future tracing slice must state its own sample rate here. |

## Where events come from

| Source | Hook | Tags |
|---|---|---|
| Server (uncaught throw in a route handler, server component, server action) | `onRequestError` in `src/instrumentation.ts` | `source=server`, `route` (the route **template**, e.g. `/api/users/[id]`), `method`, `role` (from the role shell `/admin`·`/mentor`·`/portal`·`/company`; none for `/api`), `requestId` (the `x-request-id` the middleware forwarded, #1601), `digest` |
| Job worker — every failed attempt and the DEAD_LETTER | `onError` option of `createWorker()`, wired in `/api/jobs/worker/tick` | `source=job`, `job`, `attempt` (`2/5`), `outcome` (`retried` = warning, `dead_letter` = error), `orgId`; grouped per job name + outcome |
| Browser (error boundaries, `window.onerror`, unhandled rejections) | `reportBoundaryError()` + `<ErrorTrackingListener>` → `POST /api/telemetry/errors` | `source=browser`, `route` (masked path), `scope`, `digest`, `role` + `orgId` **from the session** |

Every event also carries `release` (`GIT_SHA`), the `version` tag (`APP_VERSION`) and
`environment` (`ERROR_TRACKING_ENVIRONMENT`, else `NEXT_PUBLIC_APP_ENV`). `requestId`/`orgId`
are filled from the ambient context when the caller does not pass them.

A route that catches its own error and answers 500 is **not** reported — `onRequestError` only
sees uncaught throws. Cron schedules run as jobs through the worker (#1676), so a throw in a
scheduled body is a job failure and is reported.

The browser never talks to the tracker: the relay keeps the DSN server-side, needs no CSP
`connect-src` host (relevant to #1552), requires a session (signed-out visitors are not
reported), is rate-limited to 30 per person per 10 min, and answers **204 doing nothing** when
no DSN is set.

## PII posture — what an event may carry

An **allowlist**, not a scrubber over everything:

- the error type, the **first line** of its message and its stack frames (file, function,
  line, column). A multi-line message is where an ORM dumps the failed call's arguments
  (`Invalid prisma.user.create() invocation: { data: { email: … } }`), so only line one survives;
- masked by `maskText` / `maskUrl` from `src/lib/feedbackContext.ts` — the same and only masking
  path as in-app bug reports (#3130): e-mail addresses, bearer tokens, JWTs, `password=`-style
  pairs, query values, opaque token path segments;
- tags from `TAG_KEYS` only, each value in a log-safe alphabet (an unsafe value is dropped,
  never truncated);
- release, version, environment.

**Never:** a request body, a header, a cookie, a user object, an e-mail address, a name, a
message body, CV text or a file name. `e2e/error-tracking.unit.spec.ts` (`@smoke`) builds an
event from a representative failure and asserts none of it survives.

A per-process throttle allows 10 events per error per minute, so a loop that throws on every
request does not become a bill.

**Retention:** set on the receiver, not here. Recommended: **30 days** for events (enough to
compare two releases), no "store request data" option enabled on the project, and the
receiver's IP-address collection turned off — our events carry no IP, but a hosted SDK default
might add one on ingest.

## Variables

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `ERROR_TRACKING_DSN` | server env (runtime) | unset → **off** | `https://<publicKey>@<host>[/<path>]/<projectId>`; https only (http for localhost). Malformed reads as off. |
| `ERROR_TRACKING_ENVIRONMENT` | server env (runtime) | `NEXT_PUBLIC_APP_ENV` | The `environment` field. |
| `NEXT_PUBLIC_ERROR_TRACKING` | build arg | unset → browser reporter off | `1` attaches the browser listeners. Inlined at build time; without a DSN the relay still does nothing. |

With the DSN unset the app behaves exactly as before: `captureError()` returns before building
anything — no fetch, no timer, no console line. A send that fails (wrong DSN, receiver down)
logs one `[error-tracking] send failed` warning per process and is otherwise silent; it never
fails the request or changes how a job settles.

# Core Web Vitals (#1593)

k6 measures the server; this measures the visitor's browser. Two halves:

## Field data — `NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE`

`<WebVitalsReporter>` (mounted in `providers.tsx`, Next's `useReportWebVitals`) beacons LCP,
CLS, INP, FCP and TTFB for a sampled share of page loads to `POST /api/telemetry/vitals`, which
writes one structured log line per metric:

```
[INFO] web_vital {"requestId":"…","metric":"LCP","value":2140,"rating":"good","route":"/portal/meetings/[id]","navigationType":"navigate"}
```

- **Sample rate**: build-time, 0…1, unset = **off** (the reporter does nothing and the route
  answers 204). Recommended start: `0.1` — enough samples for a p75 per route on a normal day,
  one small beacon per metric per sampled load.
- **What a sample carries** (`src/lib/webVitalsRule.ts`): name, value, rating band, a route
  **template** (`/admin/candidates/[id]` — the query dropped, every id-like segment replaced) and
  the navigation type. No user, session, user agent or query string. The route re-derives the
  template, because a body is never trusted.
- Anonymous by design (the landing page is the screen that matters), so it is rate-limited to
  60 per 10 min per IP and writes nothing to the database. The p75 per route is a log query:
  `grep web_vital | jq` over the container log.

## The CI budget — `e2e/web-vitals-budget.spec.ts` (`@smoke`)

Runs in the PR gate against the production build it already serves (`npm run start`) and loads
`/` (anonymous) and `/portal` (a seeded mentee, fresh browser cache) with buffered
`PerformanceObserver`s. Budgets per page are in `e2e/web-vitals-budget.json`, each next to the
value it was set from:

| Number | Why it is budgeted |
|---|---|
| `jsKb` — compressed JavaScript of the first load | deterministic per build: the budget that catches a heavy library landing in a shared chunk |
| `cls` | stable on a runner; a layout shift is a real regression |
| `lcpMs` | runner-noisy — a ceiling for "something broke", not a tuning target. The runner is not throttled, so a 4G phone is slower than this number |

**Known debt:** `/portal` measures a CLS of ~0.19–0.24 (Google's "good" is ≤ 0.1). The budget
pins it at 0.3 so it cannot get worse; the fix lowers the budget in the same PR.

A local `npm run dev` run skips it (unminified bundles); `PERF_BUDGET=1` runs it against a local
`npm run start`. Raising a budget is a deliberate line in the PR that pays for it.
