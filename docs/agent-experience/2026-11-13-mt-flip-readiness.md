## 2026-11-13 — MT_ENFORCE_ISOLATION flip readiness (#3588, #3700, #3702)

- **With `CI=1`, Playwright serves the app with `npm run start`, which runs the existing `.next` build.**
  A code fix you have not rebuilt is not what the browser hits. The spec "still failed" after a
  correct fix until `npm run build`. Without `CI`, it runs `next dev` and recompiles on demand.
- **A flag-on full suite is mostly noise until the fixtures carry an org.** `seedUser()` in
  `e2e/helpers/db.ts` writes `orgId = NULL` by default. The strict tenant filter hides those rows,
  and ~30 specs go red for a reason production cannot have. To separate those from real flag
  failures: re-run only the failures with the flag off, then re-run the flag-only set with a
  **local** MySQL `BEFORE INSERT` trigger per `orgId` table
  (`SET NEW.orgId = COALESCE(NEW.orgId, '<default org id>')`), which emulates the deploy
  backfill. 31 → 3 left, one of them a real bug. Drop the triggers afterwards: they break specs
  that assert a NULL on purpose (`worlds.spec.ts:162`).
- **Anything that means "every org of a product" must run unscoped.** The middleware adds the
  bound org to every query, so a world-wide lookup inside a request or job silently becomes
  per-org. With the flag on, that let `/api/v1` import create a duplicate account in one world.
  Wrap it in `runUnscoped()` (from `@/lib/tenantAmbient`, client-safe seam).
- **Attributing NULL-org rows: snapshot the counts per model before and after the run, then
  join each NULL row to its subject** (actorId/userId → `User.orgId`). A NULL row whose subject
  has an org is a writer bug. One whose subject is org-less or deleted is a fixture artefact.
- **`check:demo-fidelity` can run locally like CI:** a fresh DB on `127.0.0.1`, then
  `prisma db push`, `prisma db seed`, `npm run seed:demo`, `npm run check:demo-fidelity` (about
  3 min). Without the seed it only reports missing demo rows.
