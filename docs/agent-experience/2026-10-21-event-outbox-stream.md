## 2026-10-21 — the event catalogue and the transactional outbox (#1691 / #3051, #1680)

- **An issue's "seven public events" can be fifteen by the time you start it.** #1691 was written
  against a 7-name `WEBHOOK_EVENTS`; main had 15. Pin what main publishes today (the unit spec
  lists the names literally), not the issue's count.
- **`Prisma.TransactionClient` alone does not refuse the root client** — `PrismaClient` is
  structurally assignable to it. `Prisma.TransactionClient & { $transaction?: never }` does, and
  a `// @ts-expect-error` probe under `npx tsc --noEmit` proves it in a minute.
- **A relay that must survive `MT_ENFORCE_ISOLATION` binds `runWithOrg(null, …)` itself.** An
  in-process kick inherits the publishing request's tenant; the mutation test (drop the bind,
  rerun the flag-on spec) showed the other tenant's row stuck PENDING.
- **Two events in one transaction tie on `createdAt` (ms).** A per-process monotonic stamp in
  `domainEventData()` keeps per-subject order without a schema change.
- **The e2e app server would race a spec that drives a background loop.** Turn the loop off on
  both webServers (`EVENTS_RELAY_ENABLED: '0'` in `playwright.config.ts`) and call it in-process.
- **After main's schema moves, an old local DB can refuse `db push`** ("Cannot drop index …
  needed in a foreign key constraint"). For a synthetic local DB: `DROP DATABASE` + `db push` +
  `db seed`; never on a shared one.
- **`scripts/test/schema-push-safety.test.mjs` "the real #2249 commit" fails in these containers
  on untouched main too** once a `git fetch` makes `aa257b2` reachable — check a clean main
  checkout before chasing it in your diff.
- **Worktree + symlinked `node_modules` shares one generated Prisma client.** Rerun
  `npx prisma generate` in the worktree you are about to test, every time you switch.
