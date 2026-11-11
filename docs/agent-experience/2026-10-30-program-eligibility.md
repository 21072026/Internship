# 2026-10-30 — Programme eligibility rules (#1945)

- **`POST /api/mentorship` carries no programme.** A direct assignment has no cohort, so
  "programme eligibility" there means the org-wide scope; only match rounds (`MatchRound.cohortId`)
  know their programme. Design the evaluator around `(orgId, programId | null)`.
- **Order SSO checks after the directory sync.** Eligibility reads the department the IdP just
  wrote; judging before `syncSsoProfile()` would read an empty profile and hold everyone.
- **The `?error=` codes the SSO routes append were never rendered on `/auth/signin`.** The new
  `sso_pending_approval` code is mapped onto the existing pending-approval notice; the older
  `sso_failed`/`sso_conflict` codes still show nothing (out of scope here).
- **A public endpoint's first hit can time out in the dev server** (cold compile of `/api/apply`
  took >15 s twice); the same test passed on a warm server. Re-run once before debugging.
- **`check:text-limits` flags a new enum-like VarChar on a registered model** — register it as
  `ENUMERATED` with the guard that bounds it.
