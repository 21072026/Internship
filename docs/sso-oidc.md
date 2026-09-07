# Enterprise SSO — OIDC (#1929)

The OpenID Connect twin of [`docs/sso-saml.md`](sso-saml.md): what a customer's
identity team registers, which claims we read, and what the automated tests do
and do not prove.

> **Status — read this before sending it to a customer.**
> OIDC is **not a working sign-in path yet**. `validateSsoConfig()` refuses a
> config naming `oidc` and `isSsoActive()` will not activate one, so a tenant
> saved as OIDC falls back to password login rather than dead-ending
> (`src/lib/sso.ts`, #1537). The login route, the callback and the ID-token
> verification land in **#1929**; the config columns in #1926.
> This document exists ahead of them so the customer-facing contract — redirect
> URI, claims, scopes — is agreed once and the e2e harness already speaks it.
> The **stub IdP** (`e2e/support/idp-mock.mjs`) serves discovery, JWKS,
> authorize and token today, and `e2e/sso-roundtrip.spec.ts` carries the round
> trip as a test that un-skips itself the moment `'oidc'` joins
> `SSO_IMPLEMENTED_PROVIDERS`.

## The flow

Authorization code with **PKCE (S256)**, `state` and `nonce` — the same shape
Entra ID and Google Workspace document for a confidential web app:

1. **Entry** — `/auth/sso` asks for the org code (slug) and sends the browser to
   `GET /api/auth/sso/<slug>/login`.
2. **Login route** — resolves the tenant, and for an OIDC tenant fetches the
   discovery document, builds the authorization URL (code + PKCE + state +
   nonce) and redirects to the IdP.
3. **IdP** — authenticates the person and redirects back to our callback with
   `code` and `state`.
4. **Callback** — `GET /api/auth/sso/<slug>/callback` consumes the single-use
   state row, exchanges the code with the PKCE verifier, and **verifies the ID
   token against the IdP's JWKS: signature, `iss`, `aud`, `exp` and the `nonce`
   we issued.**
5. **Session** — the verified claims go through the same `provisionSsoUser()` +
   single-use `SsoLoginGrant` + `/auth/sso/complete` bridge SAML already uses.
   There is deliberately only one session-minting path.

An ID token that fails any check lands the browser on
`/auth/signin?error=sso_failed`. No session is issued and no user is
provisioned.

## What the customer registers

For a tenant with slug `<slug>` on base URL `<BASE>` (e.g.
`https://preview.interncrm.com`):

| Field | Value |
|-------|-------|
| **Redirect URI** (a.k.a. reply URL / authorised redirect URI) | `<BASE>/api/auth/sso/<slug>/callback` |
| **Response type** | `code` |
| **Scopes** | `openid email profile` |
| **PKCE** | required (S256) |
| **Application type** | Web (confidential — we hold a client secret) |

The tenant hands us back three values, which go into the **Enterprise SSO** card
in Admin → Organizations:

- **Discovery URL** — `https://.../.well-known/openid-configuration`. We read
  the authorization, token and JWKS endpoints from it rather than asking for
  them one by one, so a key rotation on the IdP side needs nothing from us.
- **Client ID**
- **Client secret**

### Microsoft Entra ID

1. **Entra admin centre → App registrations → New registration.** Name it
   however the tenant likes; *Supported account types* is normally "Accounts in
   this organizational directory only".
2. **Redirect URI** → platform **Web** → the URL from the table above.
   Entra requires HTTPS for anything other than `localhost`.
3. **Certificates & secrets → New client secret.** Copy the *Value* (not the
   Secret ID) immediately — Entra shows it once. Note the expiry date; a lapsed
   secret is the most common cause of "SSO stopped working overnight".
4. **Token configuration → Add optional claim → ID → `email`.** Entra omits
   `email` from the ID token by default for many directory configurations. If
   the tenant's accounts have no mail attribute populated, ask them to add
   `upn` as well and tell us — we can map it, but only if we know.
5. **Overview** gives the discovery URL:
   `https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration`
   (use the **v2.0** endpoint; the v1 one emits different claim names).
6. Optional but recommended: **Enterprise applications → Users and groups** to
   restrict who may sign in. We do no group-based authorisation — every SSO user
   arrives as a `MENTEE` and an admin elevates them.

### Google Workspace

1. **Google Cloud console → APIs & Services → Credentials → Create credentials →
   OAuth client ID → Web application.** The project may be any project in the
   customer's organisation.
2. **Authorised redirect URIs** → the URL from the table above. Google rejects
   a URI with a fragment or a wildcard, and requires HTTPS.
3. Copy the **Client ID** and **Client secret**.
4. **OAuth consent screen** → *Internal* keeps the app to the Workspace domain,
   which is what a corporate SSO setup wants. An *External* app would have to go
   through Google verification and would let personal accounts in.
5. The discovery URL is the same for every Google tenant:
   `https://accounts.google.com/.well-known/openid-configuration`.
6. Because that issuer is shared, Google's `hd` (hosted domain) claim is the
   only thing distinguishing one Workspace from another. A Google-backed tenant
   should tell us its domain so the callback can require it.

## Claims we read

| Our field | Claim, in order of preference |
|-----------|-------------------------------|
| email | `email` — required. Where the IdP also sends `email_verified`, it must be true. |
| full name | `name`, else `given_name` + `family_name`, else the email |
| subject | `sub` (stored for correlation; the email is the identity key) |

Everything else is ignored. In particular **we read no role or group claim** —
an IdP cannot grant someone `ADMIN` here. Every SSO user is JIT-provisioned as a
least-privilege `MENTEE` in the tenant's org, and an admin elevates them
(`src/lib/ssoProvisioning.ts`). That is a deliberate boundary: a
misconfigured group mapping at the customer should never be able to mint an
administrator in our product.

An email that already belongs to a **different** tenant is refused rather than
moved (`?error=sso_conflict`).

## Operator notes

- Store only the client ID, the client secret and the discovery URL. **Never a
  private key**, and never the IdP's own signing key material — we fetch the
  public JWKS.
- Rotating the client secret is a config-card edit; rotating the IdP's signing
  key needs nothing at all, because the JWKS is refetched on an unknown `kid`.
- The discovery URL is admin-supplied and therefore attacker-influenced. Every
  outbound fetch on this path goes through `assertPublicHttpsUrl()`
  (`src/lib/ssrfGuard.ts`).
- Turning SSO on for a tenant is a config step; it does not require the
  `MT_ENFORCE_ISOLATION` isolation flag.
- SSO is an **Enterprise-plan** feature. `isSsoActive()` also checks the
  entitlement (#1742), so a downgraded tenant stops accepting IdP logins while
  keeping its config — an upgrade resumes SSO with nothing re-entered.

## What the tests prove, and what only a real IdP can

`e2e/sso-roundtrip.spec.ts` runs against a **local stub IdP**
(`e2e/support/idp-mock.mjs`, started by `playwright.config.ts` exactly as the
Google Calendar stub is). The stub generates an RSA key pair at start-up — no
key material is committed, which is the whole reason it generates one — serves
`/.well-known/openid-configuration`, a JWKS, an authorization endpoint that
redirects back with a code, and a token endpoint that returns an ID token signed
by the advertised key. It can also produce, on request, a token with a **wrong
`aud`**, a **wrong `nonce`**, a past **`exp`**, or a signature from a key it
never advertises.

That makes our half of the protocol testable in CI with no external network:
state and PKCE handling, the code exchange, ID-token verification, claim
mapping, JIT provisioning, and the refusal paths.

What the stub **cannot** prove:

- that Entra ID or Google accepts our exact authorization-request shape, scopes
  and redirect URI registration;
- that a real directory actually emits `email` (Entra frequently does not until
  the optional claim of step 4 is added) — the single most common real-world
  failure, and one a stub that always sends `email` can never surface;
- how a real IdP behaves on consent, MFA, conditional access, or a session that
  is already signed in elsewhere;
- clock-skew behaviour between two real hosts;
- that key rotation on the IdP side is picked up, since the stub never rotates.

So treat a green suite as "our side is correct", not as "this customer will work".
Before enabling a tenant, do one live sign-in against their IdP on preview.

## See also

- [`docs/sso-saml.md`](sso-saml.md) — the shipped SAML path and its SP metadata.
- [`docs/testing.md`](testing.md) — where this sits among the test types.
- [`docs/google-calendar.md`](google-calendar.md) — the stub-server pattern this
  copies, and the honest caveat section this one is modelled on.
