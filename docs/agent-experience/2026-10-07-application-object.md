## 2026-10-07 — the Application object (#1828)

- **A P1 item whose prerequisite is open is not "the first unblocked one".** Both P1 hiring
  tasks named `src/lib/applications.ts` as existing (#1828); it did not, and neither did the
  models. Before claiming, `cat` the files an issue says to "open first" — an issue written
  ahead of its dependency reads as if the dependency had landed.
- **A coarse `status` next to a fine `stage` is only worth a column if it is derived.** The
  issue gave both the same default; a status that repeats the stage name is a second thing
  to keep in sync. `statusForStage()` makes it a function of the stage (ACTIVE until a
  terminal stage), which is what an `[orgId, status]` index is for.
- **A rule that a deploy backfill needs gets an ESM mirror and a corpus test**, the pattern
  `prisma/skill-split.mjs` set: the server runs plain Node 20, so the mapping lives twice and
  `scripts/test/applications.test.mjs` compares the two over the same inputs.
- **A backfill that creates rows is idempotent only if the DB says so.** `findUnique` on the
  compound key, then `create`, then treat `P2002` as "skipped" — two deploys racing cannot
  double-create, and the second run prints `created=0`.
- **The local DB needs `prisma db push` after a schema change in a branch**, and the
  container's MariaDB stops on a worker restart: `service mariadb start` first.
