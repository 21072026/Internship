# Enterprise SSO (SAML / OIDC) — #545

Per-tenant single sign-on for the multi-tenancy track. An `Organization` can
carry the identity-provider (IdP) config so its users authenticate against the
tenant's own IdP instead of email+password.

## What's implemented now

- **Config storage** on `Organization`: `ssoEnabled`, `ssoProvider`
  (`saml` | `oidc`), `ssoIssuer`, `ssoEntryPoint`, `ssoCertificate` (PEM).
  **SAML is the only provider that works** — see *OIDC* below.
- **Admin UI**: Admin → Organizations → *Enterprise SSO* card — pick a tenant,
  fill in the IdP details, optionally flip *Enable SSO*. The provider list
  offers SAML; OIDC is rendered disabled ("coming soon").
- **Validation & gating** (`src/lib/sso.ts`):
  - `validateSsoConfig()` — rejects a non-`https` entry point, an unknown
    provider, `oidc` (see below), and enabling SSO before the config is complete.
  - `isSsoConfigComplete()` — provider + issuer + entry point (plus certificate
    for SAML).
  - `isSsoActive()` — the single guard the auth path checks: enabled, complete
    **and** naming an implemented provider (`SSO_IMPLEMENTED_PROVIDERS`).
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

The tenant's stored `ssoIssuer` is **not** passed to node-saml as `idpIssuer`,
so the assertion's `<Issuer>` string is not compared against it. What binds an
assertion to the tenant is the **certificate** it is signed with, which is
per-tenant and pinned — an assertion from another IdP fails the signature check
regardless of what it calls itself. Pinning the issuer as well would be belt and
braces; it is deliberately out of scope for the harness in #1936 because turning
it on is a behaviour change for any tenant whose stored issuer does not match
their IdP's entity ID character for character.

### SP identifiers to register in the IdP (per tenant)
**Don't copy these by hand — we publish them.** For a tenant with slug `<slug>`
on base URL `<BASE>` (e.g. `https://preview.interncrm.com`):

- **SP metadata (#1931):** `GET <BASE>/api/auth/sso/<slug>/metadata` returns SAML
  2.0 SP metadata as `application/samlmetadata+xml`, which most IdPs import in
  one click. Public and pre-auth by nature (it carries nothing secret), served
  even while `ssoEnabled` is still off — that is exactly when IT needs it — and
  `404` for an unknown slug. Admin → Organizations → **Enterprise SSO** shows
  the same three values with copy buttons.

For an IdP that cannot import metadata, register the values by hand:
- **ACS / Reply URL:** `<BASE>/api/auth/sso/<slug>/acs`
- **SP Entity ID / Audience:** `<BASE>/sso/<slug>`
- **NameID format:** emailAddress; email in NameID or an `email` attribute;
  optional `name` / `firstName`+`lastName` for the display name.

## OIDC — refused at the write boundary (#1537)

`'oidc'` stays in the `SsoProvider` type: it is a real roadmap item (Wave 4) and
the column already stores it. What it is *not* is implemented — the login route
(`/api/auth/sso/[slug]/login`) unconditionally builds a SAML `AuthnRequest`. So
saving a tenant as OIDC used to return a green "saved" and then lock every user
of that tenant out behind a broken redirect.

Two gates close that, both in `src/lib/sso.ts` so every write path inherits them:

- `validateSsoConfig()` returns *"OIDC single sign-on is not supported yet — use
  SAML"* (HTTP 400 from `PATCH /api/admin/organizations`) for any config naming
  `oidc`, whether or not `ssoEnabled` is being flipped.
- `isSsoActive()` additionally requires an *implemented* provider
  (`SSO_IMPLEMENTED_PROVIDERS`), so a row written before this shipped is inert:
  that tenant falls through to password login (`?error=sso_unavailable`) rather
  than a dead-end redirect.

Implementing OIDC means adding it to `SSO_IMPLEMENTED_PROVIDERS`, branching the
login/ACS routes on the provider, and re-enabling the option in the admin card.
That is #1929; the customer-facing setup it will need is already written up in
[`docs/sso-oidc.md`](sso-oidc.md), and the e2e stub IdP below already serves the
OIDC endpoints.

## Enforced SSO — closing every other door (#1950)

`Organization.ssoEnforced` is the promise a customer's security questionnaire is
actually asking about: *"can our users still sign in with a password?"* Answering
"no" is only honest if **every** session-minting path refuses, not just the login
form. There are six, and five of them derive from a password:

| # | Door | Where it is refused |
|---|------|---------------------|
| 1 | password sign-in | `credentials` provider, `src/lib/auth.ts` |
| 2 | "remember me" silent re-auth | `POST /api/auth/remember/refresh` **and** the `remember` provider |
| 3 | password reset completion (`RESET` **and** `SET_INITIAL`) | `POST /api/auth/reset` |
| 4 | invitation / self registration (it sets a password) | `POST /api/register` |
| 5 | self-service password change | `PUT /api/account` |
| 6 | impersonation | **not refused — see below** |

The rule itself lives in exactly one place, `src/lib/ssoEnforcement.ts`, and
every door above calls it. A door that does not call it is the bug this feature
exists to prevent — including the doors that do not exist yet (magic link,
social sign-in): they inherit the rule by calling the same helper.

Adjacent, non-authoritative refusals for the same reason: `POST /api/auth/forgot`
silently skips the mail (the link would be refused on submit anyway) and
`POST /api/admin/users/[id]/reset-password` answers the admin honestly instead of
looking like broken SMTP.

### Impersonation is deliberately still allowed

An `impersonate` grant mints a session without a password — but it is not a
password door. The admin who starts it is already signed in, and in an enforced
tenant that session came from the IdP. The grant is single-use, minted only by an
admin-guarded route, the session is time-capped, and every start and stop is
audited and notified to the account holder. Refusing it under enforcement would
withdraw support access from exactly the tenants whose IdP is having a bad day —
which is when support access matters most. **Decision: enforcement does not apply
to impersonation.** If that is ever unacceptable to a customer, the lever to add
is a per-tenant "no impersonation" setting, not a change to this rule.

### The two interlocks

1. **Anti-lockout.** `PATCH /api/admin/organizations` refuses to switch
   `ssoEnforced` on unless (a) `isSsoActive(org)` is true for the config the
   request *leaves* the org on, and (b) at least one **active `ADMIN` of that org
   holds `ssoExempt`**. Without (b) a tenant with an expired IdP certificate has
   no way back into its own account except our database console. The same rule is
   enforced from the other end: `POST /api/admin/users/[id]/sso-exempt` refuses to
   revoke the *last* exemption while the org is enforcing — **and from a third
   direction**, `PATCH /api/users/[id]` refuses to set `isActive: false` on the
   last exempt admin. `countExemptAdmins` counts only *active* admins, so
   switching the holder off removes the way back in exactly like revoking the
   exemption, except that it looks like routine offboarding and warns nobody.
   All three refusals answer with `code: 'last_sso_exemption'`. Demoting an
   admin is already impossible (`PATCH /api/users/[id]` only converts between
   `MENTOR` and `MENTEE`) and there is no user-delete route, so those are the
   three doors.
2. **Fail-open on a broken IdP.** Enforcement only *applies* while
   `isSsoActive(org)` still holds. A plan downgrade (SSO_SAML is an Enterprise
   feature, #1742) or a config an admin broke would otherwise leave a tenant with
   no working door at all; instead the flag stays set, password login works again,
   and enforcement re-engages the moment SSO does.

### The break-glass exemption

`User.ssoExempt` is granted and revoked through
`POST /api/admin/users/[id]/sso-exempt` (`{ "exempt": true|false }`), and it is
narrow on purpose:

- ADMIN only, never from an impersonation session, never across tenants (checked
  against `user.orgId` explicitly, not via the isolation middleware, which is off
  in production — #1549);
- only an **active `ADMIN`** may hold one. An exemption on a mentee account is a
  permanent password back door into a tenant that told its auditors it had none;
- every grant and revocation writes an `AuditLog` row (`SSO_EXEMPT_GRANTED` /
  `SSO_EXEMPT_REVOKED`) and an `ActivityLog` row (`sso.exempt_granted` /
  `sso.exempt_revoked`, level `warning`), and the holder is notified;
- it is surfaced as a badge in **Admin → Users**. An exemption nobody can see is
  how a temporary back door becomes a permanent one.

It is deliberately **not time-boxed**. An exemption that silently expires
recreates exactly the lockout it exists to prevent, on a day nobody chose; the
narrowing is *who holds it*, not *for how long*, and the audit trail is what
makes a stale one findable.

### The sweep on flip

Turning enforcement on ends the sessions that were obtained by password —
otherwise "we enforce SSO" is false for another twelve hours, for everyone who
was already signed in. `applySsoEnforcement()` stamps `sessionsValidFrom = now()`
for every non-exempt user of the org **and** revokes their trusted devices, in
batches of 500, then writes one audited `sso.enforced` row carrying the count.

Both halves, always. Stamping `sessionsValidFrom` alone does nothing: the
remembered browser trades its cookie for a fresh session on its next visit and
nobody is signed out (CLAUDE.md's hard rule, [`docs/remember-me.md`](remember-me.md)).
The sweep runs only on the OFF → ON edge, so re-saving an enforcing tenant does
not sign it out again, and it is idempotent if it ever does run twice.

### Honest errors, and what they reveal

A refused password sign-in throws the `SSO_REQUIRED` provider error (allow-listed
in `src/lib/authErrors.ts`, so it reaches the browser instead of becoming
`UNEXPECTED_ERROR`), and the sign-in page renders "your organization requires
single sign-on" with a link to `/auth/sso`. The API doors answer
`{ code: "sso_required" }` with the same message.

That is a deliberate, narrow enumeration trade — it confirms that an address
belongs to an SSO-enforced organization, which the generic "Invalid email or
password" avoids for everyone else. It is recorded in
[`docs/security-exceptions.md`](security-exceptions.md), not left implicit.

## What CI proves (#1936)

`e2e/sso-roundtrip.spec.ts` drives the **whole** SP-initiated flow — `/auth/sso`
→ login route → IdP → HTTP-POST back to our ACS → `/auth/sso/complete` → session
— against a local stub IdP, `e2e/support/idp-mock.mjs`, started by
`playwright.config.ts` the same way the Google Calendar stub is. Nothing leaves
the machine, so it runs in the PR gate; the happy path is tagged `@smoke`.

The stub generates an RSA key pair and a self-signed certificate **at start-up**
and hands the certificate to the spec over HTTP, which stores it on the tenant
exactly as a customer would paste theirs in. No key material is committed —
a private key in a public repo is a finding whatever it protects.

It signs real assertions with `xml-crypto` (the library node-saml verifies
with), so the app's verification path runs for real. It can also produce, on
request, an assertion that is wrong in exactly one way, and the spec asserts
each is refused with a redirect to `/auth/signin?error=sso_failed` — never a 500
and never a session:

| Case | What it stands for |
|------|--------------------|
| signed by an unadvertised key | an assertion from an IdP this tenant never trusted |
| one byte of `SignatureValue` flipped | tampering in transit |
| no `<Signature>` at all | `wantAssertionsSigned` must not be optional |
| `NotOnOrAfter` in the past | a captured assertion replayed later |
| `AudienceRestriction` naming another SP | a genuine assertion issued for a different service |
| a consumed `SsoLoginGrant` reused | a leaked or logged `/auth/sso/complete?token=…` URL |

Each negative is preceded by a **control**: the same machinery, one flag apart,
producing an assertion the ACS accepts. Without it a broken harness would look
exactly like working security.

### What the stub cannot prove

- that Okta / Entra ID / Google Workspace emit what we accept — claim names,
  NameID formats and signing choices vary, and only a real tenant settles it;
- that a real IdP accepts our SP metadata and AuthnRequest as we send them;
- anything about consent screens, MFA or conditional access;
- clock-skew behaviour between two real hosts.

So before enabling a tenant, still do one live sign-in against their IdP on
preview — the recipe below.

## Verifying on preview with mock-saml.com (a public IdP, no real tenant needed)

[mocksaml.com](https://mocksaml.com) is a free public test IdP. CI no longer
depends on it (that is what the stub above is for) — this is the manual,
human-in-the-loop check that a *real, remote* IdP over TLS also works, which the
stub cannot answer. Do it on preview before enabling a tenant:

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
