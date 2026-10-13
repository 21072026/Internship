# Password policy and breached-password screening

**Issue:** #1544 (closes the long-open #1215 for good) · **Code:** `src/lib/passwordPolicyRule.ts`
(the rules, pure, unit-tested in `scripts/test/password-policy.test.mjs`), `src/lib/password.ts`
(the server entry point), `src/lib/breachedPassword.ts` (the Have I Been Pwned lookup),
`src/lib/passwordPolicyClient.ts` + `src/components/auth/PasswordRules.tsx` (the forms),
`GET /api/auth/password-policy` · **E2E:** `e2e/password-policy.spec.ts` against
`e2e/support/hibp-mock.mjs`.

## One rule, read by everyone

The rule a **new** password is judged by is **data**: five settings read through the per-org
settings chain (`src/lib/settings.ts`: the org's row → the global row → the code default):

| Setting | Default | Meaning |
|---|---|---|
| `passwordMinLength` | `8` | Minimum length in code points. Clamped on read to **8 … 128**: no stored value can weaken the rule below what the app always had, and `PUT /api/admin/settings` refuses a minimum outside that range instead of storing something it would not honour. |
| `passwordRequireUpper` | `true` | At least one upper-case letter (Unicode-aware: `Ş`, `Ä` count). |
| `passwordRequireLower` | `true` | At least one lower-case letter. |
| `passwordRequireDigit` | `false` | At least one digit. |
| `passwordRequireSymbol` | `false` | At least one character that is neither a letter, a digit nor whitespace. |
| `breachedPasswordCheck` | `true` | Screen the password against Have I Been Pwned (below). |

The defaults are exactly the old hard-coded rule, so a deployment that never opens the controls
behaves as before. An admin changes them at `/admin/settings` next to the 2FA policy; the
change applies to the next registration, reset or password change with no redeploy.

**Every path that accepts a new password calls `checkPassword(password, orgId)`** from
`src/lib/password.ts` — register (`/api/register`, the account's org: the invitation's or the
default org), reset (`/api/auth/reset`, the org of the account the link was minted for) and
the account page (`PUT /api/account`, the caller's org). `passwordSchema` is now only the
*shape* (a non-empty string ≤ 200 characters); the policy cannot sit in a module-scope zod
schema because it is resolved per org and asynchronously. A refused password is a `400` with
`{ error, code: 'password_policy', failed: ['upper', …] }` or `{ code: 'password_breached' }`.
A new path that takes a password calls `checkPassword()`; it does not re-read the settings and
it does not write a regex.

### The browser shows the same rules (#1215)

`GET /api/auth/password-policy` returns `{ policy, rules, breachCheck }` — the caller's org
when signed in, the invitation token's org (`?token=`) on sign-up, else the default org. The
three forms (`/auth/register`, `/auth/reset`, `/account`) fetch it once through
`usePasswordPolicy()`, list the rules under the field (`<PasswordRules>`, ticking as the user
types) and validate with **the same pure function the server runs**
(`failedPasswordRules()`), so the form never accepts what the API refuses. A refusal that does
reach the API (the browser was mid-fetch, or the breach check) is rendered from its `code` in
the user's language. The texts are the `passwordPolicy` dictionary block (EN/TR/DE), keyed by
rule id.

## Breached-password screening (Have I Been Pwned, k-anonymity)

`lookupBreachedPassword()` SHA-1s the candidate and sends **only the first five hex characters**
to `https://api.pwnedpasswords.com/range/<prefix>` with `Add-Padding: true`; the response is
every suffix in that range with a count, and the match happens locally (`matchHibpRange()`,
padding rows with count `0` are not breaches). The password and its full hash never leave the
process and are never logged — not even in the warning below.

Three properties are load-bearing:

- **It fails open.** A timeout (2 s), a non-2xx, a DNS failure, a refused URL — any failure —
  answers `checked: false`, logs **one** warning (`breached-password check unavailable; failing
  open`) and the password is accepted as not known to be breached. A third-party outage may
  never block a sign-up, a reset or a password change.
- **It goes through the SSRF guard** (`assertPublicHttpsUrl`) like every other server-side
  fetch. `HIBP_RANGE_URL` can point it elsewhere (a mirror); the e2e run points it at a plain-http
  loopback stub and sets `HIBP_ALLOW_INSECURE_STUB=1` to skip the guard — a test-only switch
  that logs when it takes effect and is **never set on a deployment**.
- **It runs after the policy**, so a password the rule already refuses is never sent anywhere,
  and it runs only when `breachedPasswordCheck` is `true` for the org.

The real endpoint is `api.pwnedpasswords.com` (the issue text's `api.pwned.passwords.com` is a
typo). No API key is needed for the range API.

## Testing

- `npm run test:unit` → `scripts/test/password-policy.test.mjs`: parse + floor/ceiling, the
  rule check (including Unicode letters and code-point length), prefix/suffix split, range
  matching with padding and CRLF.
- `e2e/password-policy.spec.ts`: the server contract is `@smoke` (a weak password named by rule,
  `Password123` refused with exactly one 5-character prefix seen by the stub, the same password
  **accepted** during a stub outage, a stricter policy applied on the next registration, the
  switch off); the form's rule list and client-side refusal, and the admin controls with the
  floor, are untagged.
