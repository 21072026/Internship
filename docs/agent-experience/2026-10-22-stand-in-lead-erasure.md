## 2026-10-22 — erasing a lead on a stand-in address left its real contact on the account (#3136)

- **A lead's own address is not the person's address in the MARKETING world.** Leads made by the
  import, account events or the pull connector live on `leadStandInEmail()` (`@import.local`);
  the real mailbox is only on `Company.contactEmail`. Anything that finds "this person's rows" by
  the `User.email` silently misses them — go through the lead's links (`User.companyId`, relation
  `companyId`, connector link `companyId`) and re-derive the stand-in from the stored contact to
  prove it is the same person.
- **`runMarketingAccountImport({ apply: true })` cannot run inside a Playwright spec locally.** Its
  org lease (`src/lib/jobs/lease.ts`) loads `./leaseStore` with a dynamic `import()`, which the
  spec runner's transform rejects ("Cannot use import statement outside a module"); the lease
  then reads as "held" and the run throws `import_running` (`e2e/deal-value.spec.ts` fails the
  same way locally). `createMarketingAccountsBatch()` drives the same planner and writer without
  a lease — use it to seed import-made leads.
- **The local `internship_e2e` database is shared and drifts.** Other sessions push their branch
  schema to it; `db push` then wants `--accept-data-loss`. The `e2e` user may create `test_*`
  databases — `CREATE DATABASE test_<slug>` and point `DATABASE_URL` there instead of forcing it.
  A spec that never opens a page runs with `BASE_URL=http://localhost:9` (skips the web server).
- **`gh` may be installed but not on `PATH`** on this Mac: `/usr/local/Cellar/gh/<ver>/bin/gh`.
