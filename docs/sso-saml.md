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

## The live round-trip (now wired)

The SP-initiated SAML flow is implemented with `@node-saml/node-saml`
(`src/lib/ssoSaml.ts`) and stays **gated** — it only activates for a tenant when
`isSsoActive(org)` is true, so password login is unchanged everywhere else:

1. **Entry** — `/auth/sso` (linked from the sign-in page) asks for the org code
   (slug) and sends the browser to `/api/auth/sso/[slug]/login`.
2. **Login route** — resolves the org; if SSO is active, builds a signed-nothing
   AuthnRequest and redirects to `ssoEntryPoint` (the IdP).
3. **ACS** — `POST /api/auth/sso/[slug]/acs` verifies the posted assertion's
   signature against the org's `ssoCertificate` (audience + recipient + expiry
   checked by node-saml), maps the profile (`mapSamlProfile`), JIT-provisions the
   user (`provisionSsoUser`), then mints a **single-use `SsoLoginGrant`**.
4. **Session** — the browser lands on `/auth/sso/complete`, which consumes the
   grant via the `sso` NextAuth Credentials provider (mirrors the impersonation
   grant flow) to issue the session. No password, no IdP secret in our env.

`validateInResponseTo` is `never` (stateless SP, no shared request cache; also
allows IdP-initiated). The assertion signature + audience/recipient/expiry are
the security anchors.

### SP identifiers to register in the IdP (per tenant)
For a tenant with slug `<slug>` on base URL `<BASE>` (e.g.
`https://crm-preview.ersah.in`):
- **ACS / Reply URL:** `<BASE>/api/auth/sso/<slug>/acs`
- **SP Entity ID / Audience:** `<BASE>/sso/<slug>`
- **NameID format:** emailAddress; email in NameID or an `email` attribute;
  optional `name` / `firstName`+`lastName` for the display name.

## Verifying on preview with mock-saml.com (no real IdP needed)

[mocksaml.com](https://mocksaml.com) is a free public test IdP. To verify the
round-trip end-to-end on the preview environment:

1. **Admin → Organizations** → create an org, e.g. name *SSO Test*, slug
   `sso-test`. Open its **Enterprise SSO** card and set:
   - Provider: `saml`
   - Issuer: `https://saml.example.com/entityid`
   - Entry point: `https://mocksaml.com/api/saml/sso`
   - Certificate (PEM): mock-saml's public signing cert (from
     `https://mocksaml.com/api/saml/metadata`)
   - **Enable SSO** ✅ (validation requires all fields first)
2. Sign out. Go to **/auth/sso**, enter `sso-test`, **Continue** → you're sent to
   mock-saml. Enter any email (e.g. `you@example.com`), submit.
3. mock-saml posts the signed assertion to our ACS → you land signed in as a
   JIT-provisioned MENTEE in the *SSO Test* org.

To point at a **real** IdP (Okta/Azure/Auth0) later, just paste that IdP's
issuer / SSO URL / signing certificate into the same card — no code change.

### Operator notes
- Give the IdP admin the ACS + SP Entity ID above.
- Store only the IdP's **public** signing certificate; never a private key.
- Turning on production SSO for a tenant is purely a config step (fill the card +
  enable); it does not require the `MT_ENFORCE_ISOLATION` isolation flag.
