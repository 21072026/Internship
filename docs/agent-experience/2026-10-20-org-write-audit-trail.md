## 2026-10-20: org writes audited in the target org (#1575)

- **`logActivity()` without `orgId` stamps the ACTOR's org.** For anything a super admin does
  to another tenant that is the wrong tenant — and for tenant creation it leaks the new
  customer's name into the operator org's feed. Organization writes go through
  `recordOrgWrite()` (`src/lib/orgAudit.ts`), which writes the AuditLog row and the activity
  entry with the target org in one call. A new org-config route should use it, not a bare
  `logActivity`.
- **Super admins read `/api/admin/activity` scoped to their own home org** (`tenantWhere`), so
  the super admin itself is a valid reader for an "it does not leak into the operator feed"
  assertion — no second admin needed.
- **`apt-get install mysql-server-8.0` needs an `apt-get update` first** in a fresh container;
  without it apt reports "Couldn't find any package by regex".
- **`e2e/sso-enforced.spec.ts:146` times out at 60s against a local `next dev`** (it is long
  and compiles many routes on first hit) — on main as well. CI runs a production build, so a
  local timeout there is not a regression signal.
