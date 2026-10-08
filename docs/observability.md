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
