# 2026-11-11 — analytics sub-routes in the leak matrix (#1577)

- **Pick markers from a probe, not from reading loaders.** A throwaway spec under
  `e2e/isolation/` that seeds `seedTwoTenants()` + `seedLeakRows()`, signs in as A's
  admin and dumps every route's body, then a grep of the seed's string values over
  the bodies, told in one run which analytics routes name a row at all. Most of them
  (attendance, closure, scorecard, surveys, match-quality, outcomes, skills-gap) are
  aggregates only — a marker row cannot have a negative control there.
- **The seeded stage labels are a tenant marker.** Every stage label is prefixed
  `Iso A · ` / `Iso B · `, and the forecast, benchmark and source reports print the
  tenant's finished-stage label — enough for a control without new seed rows.
- **Premium analytics needs the tier in the seed.** `setOrgFeature(orgId,
  'ADVANCED_ANALYTICS', true)`; `OrgEntitlement` cascades with the organization, so
  the tenant cleanup takes it.
- **An empty report is not a 404.** Tenant-filtered loaders made a foreign
  `cohortId` harmless but still answered 200 with the id echoed; the fix is the
  `skills-gap` shape — `findFirst(withinTenant({ id }, tenant))` before the report.
- **Container:** the isolation `webServer` (`npm run dev`) took more than its 120 s
  timeout to compile here. Start it by hand on :3010 with the same env
  (`MT_ENFORCE_ISOLATION=true|false`, `NEXTAUTH_URL=http://localhost:3010`) — the
  config reuses it outside CI. MariaDB (apt) also stopped once between calls; check
  `mysqladmin ping` before blaming a 500. The pinned headless shell (1254) was
  missing — symlinking `chromium_headless_shell-1248` to it worked.
