# Tenant lifecycle — rename, archive, export, delete

Story #1580 (tasks #1582, #1584). An organization is born through
`provisionOrganization()` (#2065); this page is everything after that.

| Act | Door | Who | Reversible |
|-----|------|-----|------------|
| Rename / change slug | `POST /api/admin/organizations/[id]/rename` | super admin of the org's world (`platform.org.write`) | yes |
| Archive | `POST /api/admin/organizations/[id]/archive` | same | yes — `DELETE` on the same route |

The rule (what may change) is pure in `src/lib/orgLifecycleRule.ts`
(unit-tested, `scripts/test/org-lifecycle-rule.test.mjs`); the only writer is
`src/lib/orgLifecycle.ts`. A tenant `ADMIN` — of that very org included — holds
no `platform.*` permission and is refused with the `authz.capability_denied`
row `requirePermission()` writes. Every write leaves an `ActivityLog` entry and
an org-stamped `AuditLog` row naming old → new (`org.renamed`, `org.archived`,
`org.unarchived`) and raises `org.config.changed` with the redacted diff
(#1699), so the tenant's audit drain sees it.

## Rename

- `name` (1–120) and/or `slug` (normalised by `slugifyOrg`); a slug another org
  holds is **409 `slug_taken`** (the unique index is the final arbiter).
- **The `default` org keeps its slug** (`default_org_slug`):
  `src/lib/defaultOrg.ts` finds it by that slug, so a new one would make the
  next upsert mint a second, empty default org.
- **An SSO tenant's slug is locked** (`sso_slug_locked`): the SAML Entity ID
  and ACS URL are derived from it (`src/lib/ssoSaml.ts`), so a new slug breaks
  the customer's IdP. `force: true` overrides it once the IdP is reconfigured;
  the audit row then says `FORCED` at warning level.
- An archived tenant is not renamed (unarchive first).

## Archive

`Organization.archivedAt` (+ `archivedById`). Archiving **destroys nothing**:

- **Every sign-in door refuses** the tenant's people — password, SSO grant,
  remember-me, magic link, impersonation — read fresh from the row on each
  door (`tenantArchived()` in `src/lib/auth.ts`), with the door's ordinary
  generic message: the password form answers exactly what a wrong password
  answers, so a refusal is no oracle for the tenant's state.
- **Live sessions end** on their next request: the jwt callback's per-request
  account lookup already reads the org, and an archived one invalidates the
  token (no extra query).
- **No mail** reaches the tenant: `prepareEmail()` skips every group, essential
  included, when the `orgId` the sender passed — or, without one, the recipient
  account's org — is archived, recording `SKIPPED` / `Tenant archived`. The
  account mails (invitation, reset, magic link, verification, role change, 2FA
  reset) pass the recipient's `orgId` for this. The flag is read through
  `src/lib/orgArchive.ts` with a 30 s memo (cleared at once by the writer in its
  own process). Mail already on the queue before the archive is not recalled.
- The tenant sinks to the bottom of the operator's organization list with an
  **Archived** badge; it stays there to be exported or brought back.
- Refused: the `default` org (it holds every legacy org-less account) and the
  operator's own org (nobody would be left to undo it).

Background jobs keep running over an archived tenant's rows (retention,
rollups); their mail is what stops.
