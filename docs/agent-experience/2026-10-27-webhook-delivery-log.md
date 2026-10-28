## 2026-10-27 — webhook delivery as a queued subscriber (#1695)

- **Drive a queue handler through the real worker in a unit spec.** `createMemoryQueueStore()` +
  `createWorker({ now, random })` with a hand-moved clock reproduces retries, attempt numbers and the
  terminal state exactly — `e2e/webhook-delivery.unit.spec.ts` ticks, jumps the clock 2 h, ticks again.
  The memory store has no `findJobById`; read a job back with `findJobByIdempotencyKey`.
- **A handler that "gives up" should resolve, not throw on its last attempt.** Throwing on the final
  attempt dead-letters the job and feeds the daily DLQ alert with receiver outages the delivery log
  already records. Only a retryable attempt throws.
- **`fetch` follows redirects by default — that walks around `assertPublicHttpsUrl`.** The guard
  judges the registered URL; a 3xx to `http://127.0.0.1` was followed silently. Outbound calls to
  user-supplied URLs need `redirect: 'manual'`.
- **The SSRF guard's "could not be resolved" is a refusal but not a permanent one** — split it
  (`SsrfUnresolvedError extends SsrfBlockedError`) before treating every `SsrfBlockedError` as final.
- **The local DB e2e recipe from the newest retros worked as written**: apt MariaDB, `.env`,
  `prisma db push`, `ln -sfn chromium-1243 chromium-1248` (+ headless shell), start `npm run dev`
  yourself, then `set -a; . ./.env; set +a; npx playwright test …`. Three specs took ~2.7 min.
