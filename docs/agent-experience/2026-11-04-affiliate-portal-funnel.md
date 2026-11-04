# 2026-11-04 — Affiliate partner funnel in the portal (#3543)

- **Playwright workers do not read `.env`.** The dev server Playwright boots does,
  but a spec that talks to Prisma directly (seeding, or calling a `src/lib`
  aggregate to compare numbers) fails with `Environment variable not found:
  DATABASE_URL`. Export it for the run: `set -a && source ./.env && set +a && npx playwright test …`.
- **`signInAndSettle(page, …, landing)` waits for the role's redirect target**, not
  for a page you choose: an AFFILIATE always lands on `/affiliate`. Pass that, then
  `gotoSettled()` to the page under test; a deeper `landing` times out after 20 s.
- **Two parallel sessions writing the "same shared module"** cross messages easily.
  Agree on the file paths and the vocabulary (here: the funnel periods, which one
  issue fixed and the other left open) before writing, and drop copies of the
  files in the shared notes folder so the second branch can take them verbatim —
  identical content merges without a conflict.
- **A stacked worktree's local DB**: `internship_crm` had #3542's column but not
  #3541's table. `prisma db push` WITHOUT `--accept-data-loss` added the missing
  table and would have refused anything destructive to a sibling's schema.
