# 2026-11-04 — Affiliate customer status (#3542)

- **Worktrees share one local MySQL server, and the `crm` user cannot create a
  database.** `CREATE DATABASE` is refused; only the databases already granted
  exist (one per parallel session, set up by someone with root). Before a
  `db push`, look at `SHOW DATABASES` / `SHOW GRANTS`: push into your own granted
  database, or into the shared `internship_crm` only when your schema change is
  purely additive (run it WITHOUT `--accept-data-loss`, so Prisma refuses
  instead of dropping a sibling session's table).
- **A worktree has no `.env`.** Copy the main checkout's (it is gitignored);
  `prisma validate` fails on the missing `DATABASE_URL` otherwise.
- **`npm run lint` / `next lint` fails inside `.claude/worktrees/`**: ESLint
  finds the parent checkout's `.eslintrc.json` too and reports a plugin conflict.
  `npx eslint --no-eslintrc -c .eslintrc.json <files>` lints with the
  worktree's config only.
- **A pure `*Rule.ts` that imports a sibling without an extension** needs the
  `ts-extensionless-resolve.mjs` loader in its unit test (`register(...)` then a
  dynamic `import()`), like `affiliate-attribution-rule.test.mjs`.
- **`gitignore-exports.test.mjs` failed locally** (`scripts/fixtures/accounts.CSV
  must be ignored`) on a branch that does not touch `.gitignore`; cause not
  investigated (possibly the case-insensitive macOS file system). Not a
  regression of an unrelated change — check `main` before chasing it.
