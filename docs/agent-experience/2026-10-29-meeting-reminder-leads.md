# 2026-10-29 — meeting reminder lead times (#1636)

- **`NOT: { col: 0 }` in Prisma drops NULL rows** — SQL's `NOT (col = 0)` is NULL for a
  NULL column, so the filter silently excluded every meeting that had never set the new
  nullable column. `{ not: 0 }` does the same. Write the NULL branch out:
  `OR: [{ col: null }, { col: { gt: 0 } }]`. An in-process e2e (no app server,
  `BASE_URL=http://localhost:9`, calling the job function directly) caught it in seconds.
- **Prove "nothing configured is byte-identical" by brute force**: the unit test walks
  every half-minute of the old lookahead and compares the new rule to the old function
  pasted verbatim.
- **Changing an enum column under `db push`**: never re-type in place; make it nullable,
  add the new column beside it, dual-write, and keep BOTH unique keys so a row written
  before the deploy still collides with one written after.
- **A local DB e2e that drives the UI against `next dev` times out on cold compiles**;
  a production build (`npm run build`, then `npm run start`) is what CI runs and is the
  fair local comparison.
- **Run every `check:*` of `ci.yml` before merging, not only the ones you think you
  touched.** #1638 (#3334) merged a `prisma.setting.count()` in a route, which
  `check:settings-accessor` forbids (`resolveSettings()` returns the `sources` per key —
  use that to ask "is this layer overridden?"); this PR carries the fix. A one-liner
  lists them: `grep -oE "npm run check:[a-z0-9:-]+" .github/workflows/ci.yml | sort -u`.
- To tell "mine" from "already red on main", run the failing test files in a
  `git worktree add <dir> origin/main` with `node_modules` symlinked in — seconds, no
  reinstall. `check:demo-fidelity` needs `npm run seed:demo` against the local DB first.
