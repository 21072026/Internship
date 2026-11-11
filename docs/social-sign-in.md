# Social sign-in (#1962)

"Continue with Google / Microsoft / LinkedIn" on `/auth/signin` and on the
open `/auth/register` (an invitation is still redeemed by the form). It runs
on the tenant-SSO OIDC engine (`src/lib/ssoOidc.ts`, #1929) with a provider
client: discovery, PKCE, state and nonce in the single-use `SsoAuthRequest`
row (`kind = social:<provider>`), and ID-token verification against the
provider's JWKS.

The differences between providers are in `src/lib/socialProvidersRule.ts`
(pure; tested in `scripts/test/social-sign-in.test.mjs`). The Prisma half is
`src/lib/socialSignIn.ts`.

## Configuration (operator, installation-wide)

| Env | Meaning |
|---|---|
| `SOCIAL_SIGN_IN=1` | The feature flag. Off means no provider is offered anywhere. |
| `SOCIAL_<P>_CLIENT_ID`, `SOCIAL_<P>_CLIENT_SECRET` | Per provider (`GOOGLE`, `MICROSOFT`, `LINKEDIN`). A provider without both is **invisible**: no button, and its routes answer 404. |
| `SOCIAL_<P>_DISCOVERY_URL`, `SOCIAL_<P>_ISSUER` | Overrides for the e2e stub IdP, a single-tenant Microsoft directory, or a sovereign cloud. |

- The secret stays in the server environment; no API returns it.
- The redirect URI to register at each provider is `<NEXTAUTH_URL>/api/auth/social/<provider>/callback`. There is one per provider, like the SSO callback. The host the sign-in started on rides along in the request row.

Provider notes, so the quirks live in one place:

- **Microsoft**'s multi-tenant endpoint publishes a templated issuer.
  - The token's `iss` must equal `https://login.microsoftonline.com/<tid>/v2.0`, where `tid` is taken from the token itself.
  - It has no `email_verified` claim. Its optional `xms_edov` claim is read instead. Without that claim, a Microsoft address **never** links to an existing account.
- **LinkedIn** ("Sign In with LinkedIn using OpenID Connect") needs the scopes `openid profile email`.
  - It authenticates the token request with `client_secret_post`. The engine picks that method from the discovery document, so there is no LinkedIn-specific code for it.

## The linking rule

1. A known `(provider, subject)` signs in to its account, always. The link is on the **subject**, never the email, because an email changes at the provider and a subject does not.
2. "Connect" from `/account` (`?link=1`, which needs a signed-in, non-impersonated session) links the identity to that account. The person has already proved who they are with their own password.
3. A new subject whose address matches an account in this world links **only when the provider asserts the email is verified**. A missing claim counts as unverified. Otherwise nothing is linked and nothing is created (`?error=social_unverified_email`).
4. A new subject with no matching account creates a MENTEE in the default organization, on a verified email only. It is created as pending approval when `selfRegistration` is `manual`.

Each link writes `auth.identity_linked` to the activity log at warning level.

Two more boundaries:

- **Worlds.** The INTERNSHIP world only; the marketing product is invitation-only.
- **Tenants.** An existing account is signed in to its own org. A social identity never moves a user between tenants.

## The session comes from the magic door

The callback mints no session. Once the linking rule names an account, the
callback mints a single-use sign-in link (`createLoginLinkToken`, #1959), and
the browser redeems it through the **`magic`** provider. Every rule of that
password-equivalent door therefore applies, with no second copy:

- inactive, unverified and pending accounts are refused;
- enforced SSO is refused (#1950; also checked before anything is linked);
- an archived tenant is refused;
- the host's world must match the account's world;
- the account's **own second factor** is required, so a Google login never skips an enrolled authenticator.

## Account settings

`/account` lists the linked identities (provider, address, last used; the
subject is never shown) and offers Connect and Disconnect. The **last way in
cannot be removed**: an account without a usable password keeps at least one
identity (`409 last_sign_in_method`). Account anonymisation deletes the
identities.
