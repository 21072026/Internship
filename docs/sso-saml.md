# Enterprise SSO (SAML / OIDC) — #545

Per-tenant single sign-on for the multi-tenancy track. An `Organization` can
carry the identity-provider (IdP) config so its users authenticate against the
tenant's own IdP instead of email+password.

## What's implemented now

- **Config storage** on `Organization`: `ssoEnabled`, `ssoProvider`
  (`saml` | `oidc`), `ssoIssuer`, `ssoEntryPoint`, `ssoCertificate` (PEM).
- **Admin UI**: Admin → Organizations → *Enterprise SSO* card — pick a tenant,
  fill in the IdP details, optionally flip *Enable SSO*.
- **Validation & gating** (`src/lib/sso.ts`):
  - `validateSsoConfig()` — rejects a non-`https` entry point, an unknown
    provider, and enabling SSO before the config is complete.
  - `isSsoConfigComplete()` — provider + issuer + entry point (plus certificate
    for SAML).
  - `isSsoActive()` — the single guard the auth path will check: enabled **and**
    complete.
- The API never returns the raw certificate; the list only exposes
  `ssoCertificateSet` and `active`.
- **JIT provisioning** (`src/lib/ssoProvisioning.ts`): `provisionSsoUser()` maps a
  verified IdP identity to a `User` in the tenant org — creating one on first
  login (default least-privilege `MENTEE`, or an IdP-mapped role), adopting a
  not-yet-tenanted user into the org, and refusing to relocate an email that
  already belongs to a different tenant. Idempotent per email; unit-tested in
  `e2e/sso-provisioning.spec.ts`. It trusts its inputs, so the callback must only
  call it AFTER verifying the signed assertion.

## What's NOT wired yet (and why)

The **live login redirect is intentionally not connected**. Turning a stored
config into a working sign-in needs two things this slice deliberately stops
short of, because neither can be exercised safely without a real tenant IdP:

1. **A SAML/OIDC library + endpoints** — e.g. `@node-saml/node-saml` for the
   AuthnRequest/ACS round-trip, or an OIDC client for the code flow. Adding an
   untested assertion-verification path to a live auth system is a security risk.
2. **Tenant resolution** — knowing which org (hence which IdP) a login belongs
   to, which arrives with the `#543` query-isolation slice (subdomain/host or a
   pre-entered work email).

So today the config is **managed, validated and gated** but `isSsoActive()` has
no live consumer. This mirrors how Google Calendar OAuth (#417) waits on the
customer's own credentials.

## Wiring checklist (next slice — needs the tenant's IdP metadata)

1. Add the SSO library dependency and an ACS/callback route
   (`/api/auth/sso/[org]/callback`).
2. Resolve the tenant from the request (subdomain or work-email lookup).
3. If `isSsoActive(org)`: build the AuthnRequest from `ssoEntryPoint` /
   `ssoIssuer`, redirect to the IdP.
4. On callback: verify the signed assertion against `ssoCertificate`, then call
   `provisionSsoUser({ orgId, email, fullName, role })` (already implemented) to
   map the IdP subject to a `User` in that org, and issue the NextAuth session.
5. Fall back to password login whenever SSO is not active for the tenant.

### Operator notes
- The IdP's ACS/redirect URL will be the callback route above; give it to the
  customer's IdP admin along with our SP entity ID.
- Store only the IdP's **public** signing certificate; never a private key.
