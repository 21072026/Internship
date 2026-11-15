# 2026-11-13 — no company portal in MARKETING (#2348 MKT-2)

- **`requireCapability()` answers `capability_unavailable`**, not
  `capability_missing`. A route that must say `capability_missing` (the admin
  company-login provisioning, whose form branches on it) builds its own 403.
- **A shared helper is the cheaper gate.** All six `/api/company/integrations/*`
  handlers resolve the caller's company through `ownCompany()`
  (`src/lib/companyIntegrations.ts`); one `requireCapability` there covers them.
- **Look past the named routes.** `GET /api/companies/[id]` hands a COMPANY
  reader its company's `mentorships` with mentor/mentee names and e-mails — the
  same funnel as `/api/mentorship`. The fix is the relation scope
  (`{ id: NO_MATCH }`), not a 403: the company record itself stays readable.
- **Prove a boundary spec is load-bearing:** `git stash push -- src`, run the
  spec (the MARKETING cases must go red), `git stash pop`. A red run against
  unfixed code can create rows the fixture does not clean (here a COMPANY user
  minted by the old route) — delete them by hand afterwards.
- **Container:** `seedTwoTenants({ verticalA: 'MARKETING' })` + `putOnWorld()`
  gives a MARKETING tenant with every actor; `signInAsFreshUser(…, '/account')`
  signs in a login whose `roleHome` redirects. The first default-project run
  compiles each route cold, so a 15 s `apiRequestContext` timeout on the first
  hit of a route is the dev server compiling, not the code under test — rerun.
