# Employer verification (#1865)

Self-serve employer sign-up brings fake postings aimed at students with it, so
a company that is **not VERIFIED reaches no candidate**.

## The status

`Company.verificationStatus`: `PENDING | VERIFIED | REJECTED | SUSPENDED`.

**The column defaults to `VERIFIED`.** Every company that existed before this
change was created by an admin and stays visible on deploy. Only the public
self-signup path writes `PENDING`. A `PENDING` default would hide every
existing company's roles overnight.

The rule is pure in `src/lib/companyVerification.ts` and unit-tested
(`scripts/test/company-verification.test.mjs`). An unknown stored value counts
as not verified.

## The gate, enforced in queries

| Surface | How |
|---|---|
| Mentee job board (`/api/portal/requisitions`, `[id]`, applying) | `visibleJobsWhere()` (`src/lib/portalJobs.ts`) adds `VERIFIED_COMPANY_WHERE` **inside** the Prisma `where`, so the total and the pages stay right; the detail answers 404 |
| Publishing a role | `POST /api/requisitions` with `status: OPEN`, or a `PATCH` that sets `status: OPEN`, answers `403 company_not_verified`; drafts stay allowed |
| Company→candidate channel | `POST /api/company/outreach` answers `403 company_not_verified` |

A `PENDING` company can still sign in, edit its profile and draft roles.

## The admin's decision

`POST /api/admin/companies/[id]/verification` with `{ action, reason? }`, guarded by `company.write`:

- `approve`: `PENDING | REJECTED → VERIFIED`
- `reject`: `PENDING → REJECTED` (needs a reason)
- `suspend`: `VERIFIED → SUSPENDED` (needs a reason)
- `reinstate`: `SUSPENDED → VERIFIED`

The write is a guarded `updateMany`; a race answers `409 state_conflict`. Every
decision writes an `AuditLog` row (`COMPANY_VERIFICATION`, with `orgId`). The
company's active users get an in-app notification, with the reason on a
refusal.

`/admin/companies?verification=PENDING` is the review queue (internship tenants only).

## A COMPANY user edits its own company

`PUT /api/companies/[id]` admits a COMPANY user for its **own** company only
(another id answers 404). The user may change exactly
`description, logoUrl, industry, size, address, contactEmail`. Any other key
(`quota`, `name`, `orgId`, `verificationStatus`, …) is named and refused with
`403 protected_fields`; it is never silently stripped.

## Still to come (second PR of #1865)

The public sign-up route (`POST /api/public/signup/company`, which writes
`PENDING`), the domain-proof fast path and the onboarding checklist on `/company`.
