# Self-serve tenant signup (#1747)

A visitor turns a form into a working Community tenant with nobody from our side
in the loop. Server half: `POST /api/public/signup/org` (#1749). Client half: the
`/signup` page and the first-run panel (#1751).

## The switch

`SELF_SERVE_SIGNUP=true` turns it on; anything else answers `503 not_enabled`.
The ONE reading is `selfServeSignupEnabled()` (`src/lib/selfServeSignup.ts`); the
handler checks it before it does anything else (pinned by
`scripts/test/self-serve-signup.test.mjs`). **Off in production** until tenant
isolation (`MT_ENFORCE_ISOLATION`, `docs/tenant-isolation.md`) is enforced there:
a live second tenant on an unenforced deployment is a data-exposure risk. The
deploy scripts do not thread the variable yet — turning it on is a deliberate
infra change. The e2e server runs with it on.

## What one signup writes — in one transaction

`provisionOrganization()` (`src/lib/orgProvisioning.ts`, #2065) does the
organization half exactly as the super admin's wizard does: the row (`plan:
FREE` = Community, `vertical: INTERNSHIP`), the stage preset, the starter pack
(#2066). Its `firstAdminAccount` step runs the signup's own writes **inside the
same transaction**: the ADMIN `User` (inactive, unverified), its
`UserConsent`, and the org's `Subscription` (`getOrCreateSubscription(orgId, tx)`).
A throw anywhere rolls all of it back — `e2e/signup-org.spec.ts` forces one
(the `x-e2e-fail-signup` header, honoured only under the `E2E_ERROR_ROUTES`
test switch) and counts rows.

After the commit: the verification mail, an `org.self_signup` activity line and
one notice to `ALERT_EMAIL_TO` (org name and slug only).

## The rules

- **No session, no id.** The response is `{ ok, orgSlug }`. The account admits
  itself through the ordinary `/api/auth/verify-email` link — one activation
  story, shared with open registration.
- **Not an enumeration oracle.** An address already in this product (worlds,
  `docs/worlds.md`: `emailTakenInWorld(email, 'INTERNSHIP')`) and an
  organization that cannot be created answer the same `409 signup_unavailable`.
  A taken slug never surfaces: it gets a short random suffix.
- **INTERNSHIP only.** A MARKETING host is invitation-only (#2501) and gets
  `403 invitation_required` — the permitted use of the host header listed in
  `src/lib/hostVertical.ts`. The new tenant's product is never read from it.
- **Password policy:** `checkPassword(password, null)` — the deployment default,
  which is what the new org starts with.
- **Rate limit:** 5 per IP per hour (`SIGNUP_ORG_RATE_LIMIT`), spent before the
  body is parsed.
