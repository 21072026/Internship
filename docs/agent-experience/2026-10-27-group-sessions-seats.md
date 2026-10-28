# 2026-10-27 — Group sessions: a race-safe seat counter (#1856)

- **A capacity check is a counter column plus a guarded `updateMany`, not a COUNT.**
  `ProgramEvent.seatsTaken` is claimed with `updateMany({ where: { seatsTaken: { lt:
  prisma.programEvent.fields.capacity } }, data: { increment: 1 } })` — Prisma 5 field
  references compare two columns in SQL, so no read-then-write window exists.
- **Lock the parent row first in every seat transaction** (`$queryRaw SELECT … FOR UPDATE`).
  The guarded update is the correctness; the lock is the *ordering* — it keeps a newcomer
  from taking a seat between a cancellation's release and the waitlist promotion, and keeps
  lock order identical across register / cancel / capacity paths (no deadlocks).
- **An API-only e2e spec needs no browser:** `playwright.request.newContext()` +
  `signInViaApi()` per person, and `Promise.all` of two POSTs is a real race against the dev
  server. Seed users *into an org* (`seedUser(..., orgId)`): an org-less seeded user has a
  `null` session orgId and every org-requiring route answers 403.
- `check:text-limits` fails on `main` today (`Company.productPlan`) — pre-existing, not yours.
