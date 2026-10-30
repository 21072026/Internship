# Tenant lifecycle — rename, archive, export, delete

Story #1580 (tasks #1582, #1584). An organization is born through
`provisionOrganization()` (#2065); this page is everything after that.

| Act | Door | Who | Reversible |
|-----|------|-----|------------|
| Rename / change slug | `POST /api/admin/organizations/[id]/rename` | super admin of the org's world (`platform.org.write`) | yes |
| Archive | `POST /api/admin/organizations/[id]/archive` | same | yes — `DELETE` on the same route |
| Hard delete (stage 1 / 2) | `POST`/`DELETE …/[id]/deletion`, then `DELETE /api/admin/organizations/[id]` | super admin, **only when the deployment sets `TENANT_HARD_DELETE_ENABLED`** (off by default) | **no** |
| Export | `GET /api/admin/organizations/[id]/export` | super admin (`platform.org.read`) **or the org's own ORG_ADMIN** (`org.export`) | n/a (reads only) |

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

## Export

`GET /api/admin/organizations/[id]/export` streams one JSON document — the
tenant's answer to "how do we get our data out". Format
`interncrm.tenant-export/1`:

```
{ "_meta":        { format, exportedAt, organization, encoding, omittedModels, omittedFields },
  "organization": { …the org row… },
  "collections":  { "<Model>": [ …rows… ], … },
  "_summary":     { "<Model>": <row count>, … } }
```

- **What is in it** (`src/lib/orgExport.ts`): the walk is driven by Prisma's
  own schema model, not a hand list — every model with this org's `orgId`, then,
  level by level, every model reached by a single-column foreign key from rows
  already exported (InteractionLog and Message through their relation,
  MessageAttachment through its message, …). A model added to the schema is in
  the next export without a code change. Rows are read in id-ordered pages and
  written as they are read; only the key sets the next level needs stay in
  memory. Bytes are base64, BigInt/Decimal strings, dates ISO-8601;
  notifications carry a `renderedText` (#921 stores params, not text).
- **What is never in it** (`src/lib/orgExportPolicy.ts`): credentials — the
  password hash, TOTP secret, API key hash, webhook/drain signing secrets, OAuth
  tokens, SSO keys and certificate, bearer tokens of invitations/RSVPs/reviews —
  and whole credential tables (reset/sign-in/remember-me tokens, recovery codes,
  push endpoints) plus the platform queue. All of it is listed in `_meta`. The
  policy fails closed: `scripts/test/org-export-policy.test.mjs` runs it against
  the real schema, and a new column whose name looks like a credential that
  nobody decided fails the unit test.
- **Whose PII**: only the tenant's own rows — its people, as data of that
  tenant. The e2e spec asserts no id of a second tenant appears anywhere in the
  file.
- **Who**: the world's super admin, or the org's own ORG_ADMIN (`org.export`,
  held by no narrower tier and never through impersonation). Another tenant's
  admin gets 403 with an `authz.capability_denied` row. Every export writes
  `org.exported` (ActivityLog + the tenant's AuditLog) before the first byte.
- A tenant ADMIN finds the download on `/admin/organizations`; the operator on
  the lifecycle card there.

## Hard delete — off by default

Permanent deletion is written, tested and **switched off**: every door answers
`403 hard_delete_disabled` unless the deployment sets
`TENANT_HARD_DELETE_ENABLED=1`. Nothing in this repository sets it — not CI,
not the topic environments, not preview or production. Turning it on is the
maintainer's decision, per deployment.

With the switch on, four locks, all required (`src/lib/orgDeletionRule.ts`,
unit-tested):

1. the tenant is **archived** (and unarchiving withdraws a pending request);
2. **stage 1** — `POST …/[id]/deletion { confirmSlug }` records
   `deletionRequestedAt` (audited `org.deletion_requested`); `DELETE` on the same
   route withdraws it;
3. **stage 2** — `DELETE /api/admin/organizations/[id] { confirmSlug, password }`
   runs only `TENANT_HARD_DELETE_WAIT_HOURS` (default 72, floor 24) after the
   request, only if a **full export was taken after the request**
   (`org.exported`), and only with the operator's **own password**;
4. never the `default` org, never the operator's own org; super admin of the
   org's world only (`platform.org.write`).

**What is deleted** is planned from the schema (`planDeletion()`), never left to
`db push` or to `onDelete` cascades: every model with this org's `orgId`, then
every model without an `orgId` that hangs off those rows by a single-column
foreign key, to a fixed point, plus three bearer-grant tables that hold a user
id without a declared relation (`SOFT_LINKS`). Every optional link into that set
is nulled first — a row of another org that only points here keeps living —
except the ownership column `orgId` itself, which is how the org-scoped rows are
found. The deletes run children-first in a topological order of the required
links, in **one transaction** (`src/lib/orgDeletionExec.ts`): any failure rolls
everything back. A cycle of required links or a multi-column link into the
tenant is a plan error, and the unit test runs the plan on the real schema so it
surfaces in CI. `e2e/tenant-hard-delete.spec.ts` runs the real executor on a
synthetic tenant and checks that no `orgId` model references the org afterwards
and that the second tenant is untouched.

**What is kept**: `org.deleted` — written **before** the transaction to the
**operator's** org (everything stamped with the deleted org goes with it), naming
the tenant's id, slug and name; a rolled-back run adds `org.delete_failed`.
Mail already queued is part of the deleted `Job` rows. Off-site backups follow
their own retention (`docs/disaster-recovery.md`).
