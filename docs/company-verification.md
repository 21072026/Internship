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

## Self-signup

`/for-companies/signup` (internship hosts only; linked from `/for-companies`)
posts to `POST /api/public/signup/company`. The flow:

- **Anti-abuse:** a per-IP rate limit (5/h), a honeypot and a minimum
  render-to-submit time. A submission caught by the honeypot or the timer is
  answered with the ordinary 202 and dropped.
- **Address check:** free-mail domains are refused (`free_mail_domain`; the
  list is in `src/lib/companySignup.ts`). The work domain is stored as
  `signupDomain`.
- **Provisioning:** `provisionSelfSignupCompany()` (`src/lib/companyProvisioning.ts`)
  creates the PENDING company and a COMPANY invitation in **one transaction**.
  The invitation has `invitedById: null`, because nobody invited the company.
  The link is mailed and **never returned**. Registration goes through the
  ordinary `/auth/register?token=…` flow.
- **No probing:** the answer is the same 202 `check_inbox` for a new address,
  an existing account or a live invitation.
- **Admin notice:** the org's admins are told through `notifyEvent()` with
  `signup.companySelf` (in-app + mail).

## Domain proof (fast path)

`GET /api/company/onboarding` gives a PENDING company its DNS TXT record:
`interncrm-verification=<token>`. The token is an HMAC of the company id under
`NEXTAUTH_SECRET`, so nothing is stored.

`POST /api/company/onboarding/domain-proof` (rate-limited) looks the record up
on the **stored** `signupDomain`, never on a domain from the request. If the
record is there, it flips `PENDING → VERIFIED` with a guarded `updateMany`.
The change is audited and `verifiedById` stays NULL. A REJECTED or SUSPENDED
company cannot use this path: an admin's decision is not overturned by DNS.

## Onboarding checklist

The card on `/company` lists: complete the profile (`/company/profile`), draft
the first role, get verified. Each item is **derived** from live data
(`onboardingChecklist()`), never a stored boolean, and the card disappears once
every item is done. "Invite a teammate" joins the list with team seats (#1870);
until then it would be an item nobody can tick.
