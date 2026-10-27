# 2026-10-27 — terminology tokens over the overlay (#1629)

- **An issue older than the mechanism it extends needs its premise re-read.** #1629
  (written 2026-08) asked for `{{mentor}}` placeholders in the base dictionary; the
  vertical overlay landed since and a maintainer-facing comment on the issue offered
  "tokens feed the overlay" as option 1. Built that: a stored terminology becomes
  whole-word swaps over the overlaid dictionary, no base string changes, so
  `EXPECTED_LEAKS` and every landing-string spec stay untouched.
- **A whole-word swap over 28k lines needs explicit non-word neighbours**: `{mentor}`
  interpolation tokens, `/mentor/…` paths, `mentor.example` hosts, `mentor_id`, and
  Turkish `Mentor'un` (an apostrophe suffix would half-build "Coach'un"). The unit spec
  pins that every `{…}` token of every string survives an override.
- **Running a DB e2e spec in this container**: Playwright's test process does not read
  `.env` — `set -a; . ./.env; set +a` before `npx playwright test`, or every seed helper
  fails with "Environment variable not found: DATABASE_URL". The first dev-server compile
  outlasts `signInViaApi`'s 15 s timeout; start `npm run dev` yourself, curl
  `/api/auth/csrf` and `/auth/signin` once, then run (`reuseExistingServer` picks it up).
  The pinned headless shell was `-1248` while `/opt/pw-browsers` held `-1243`:
  `ln -sfn …-1243 …-1248` worked.
- `*.unit.spec.ts` run without the web server via `BASE_URL=http://localhost:9`.
