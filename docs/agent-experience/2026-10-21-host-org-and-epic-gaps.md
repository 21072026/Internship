## 2026-10-21 — host → org resolution and the survey/health epic's last gaps (#1661, #1894, #1906)

- **Auditing an epic's stories turned up two real privacy and correctness gaps under all-closed tasks.**
  A pause keeps `status: ACTIVE`, so anything that excludes "not active" pairs must also check `lifecycleState`.
  A breakdown floored bucket-by-bucket still leaks by subtraction next to a published total, so use `applyResponseFloor`.
- **After a container restart, check the environment before blaming the code.**
  - `service mysql start` brings the database back.
  - Re-check the `/opt/pw-browsers` symlinks.
  - When main adds a dependency (here `@visx/*`), a worktree's symlinked `node_modules` goes stale. `tsc` and `build` then
    fail on "Cannot find module". Run `npm ci` once and point the other worktrees' `node_modules` symlinks at that copy.
- **A local `db push` can be refused by main's own expand/contract steps** (here "Cannot drop index … needed in a
  foreign key constraint"). The local database is synthetic, so recreate it rather than fight it:
  `DROP DATABASE internship; CREATE DATABASE internship;`, then `db push` and `db seed`.
- **Do not let `prisma format` realign a whole model.** A new field name longer than the existing column width makes it
  rewrite every line of `Organization`, and every parallel stream then conflicts with you. Put new fields in their own
  blank-line-separated group (format aligns per group); the diff stays at your lines.
- **A cache keyed by attacker-chosen hosts must be bounded, and must be keyed per host.**
  - Bounded: cap the `Map` size.
  - Per host: a single cached set of "verified hosts" made a domain verified a second ago invisible for the whole TTL,
    and made the e2e order-dependent.
