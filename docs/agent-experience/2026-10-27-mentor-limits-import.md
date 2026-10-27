# 2026-10-27 — Mentor limits CSV import (#1808, part 2)

- **A new importer is a copy of the attribute importer's shape, not of its code.**
  Pure half (`mapColumns` / `validateRow` / `changed…`) + Prisma half (`resolve` batched,
  `apply` = one `$transaction` per chunk, `dryRun` returns before writing) + route + panel.
  `runImport()` does the rest; the preview cannot drift from the run.
- **A CSV contract's column names trip the MARKETING leak ratchet** (`mentorCapacity`
  contains "mentor"). They cannot be overlaid, so the namespace goes into `LEAK_EXEMPT` with
  the gating argument (gatePage + requireCapability), not into an overlay.
- **Local DB e2e needs the env in the TEST process too**: `next dev` reads `.env`, but
  `e2e/helpers/db.ts`'s Prisma client does not — `set -a && . ./.env && set +a` first.
  Playwright 1.64 wanted `chromium_headless_shell-1248`; a symlink to the installed 1243
  build worked (same directory layout).
