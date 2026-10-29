# 2026-10-28 — Mentor application screening (#1807)

- **A new free-text column trips three guards at once**: `check:erasure-coverage` (every
  `@db.Text` needs ERASED or a reason), `check:text-limits` (every String column needs a
  `TEXT_LIMITS` key or an exemption in `textLimitsRegistry.ts`, including the new FK id) and
  — not a guard, but the same inventory — `scripts/sanitize-db.mjs`. Add all three in the commit
  that adds the column; a new `User` FK also goes into `mergeUsers.ts`'s FK list.
- **A per-org policy is a string setting, not a new table**: `SETTING_DEFAULTS` + `SETTING_SCHEMA`
  (`scopes: O`), read with `resolveSettingRaw(key, { orgId: await settingsOrgOf(session) })`,
  written with `setSetting(key, value, orgId)` — the safeguarding settings route is the template.
- **Gate inside the transaction that flips the status.** The approve handler reads the
  checklist with `tx` and throws a signal error, the same shape as the existing
  `RoleConflictError`; an empty policy skips the read entirely, so "no policy = unchanged" holds.
- The local MariaDB does not survive a container restart; `service mariadb start` again.
