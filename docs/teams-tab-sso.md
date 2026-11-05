# Teams tab and Teams SSO — design (#1954)

**Status: design, awaiting approval. No code yet.**

The goal is to render the app's own role home inside a Microsoft Teams tab, with a real session,
**without weakening clickjacking protection on any other route** and **without opening a sign-in
door that skips a rule the other doors enforce**. This note records how the token flows, what is
verified, which account a token may become, which host and world it lands on, and what stays
closed.

## Off by default

Everything below is inert unless all of these hold:

- `CHAT_APPS_ENABLED=1`;
- `TEAMS_SSO_CLIENT_ID` is set (the Entra app registration the tab's token is minted for);
- the person's org has an **enabled `TEAMS` `ChatWorkspace`** whose `externalId` is the Entra tenant
  id (`tid`). That row is written only by the admin's own install (#1935).

Without these, the cases are:

- `POST /api/integrations/chat/teams/sso` answers **404**, the same as an unknown route, and reads
  nothing from the request.
- The `chat` credentials provider refuses every grant.
- `/embed/*` serves its "link your account" screen and keeps `frame-ancestors 'none'`. Without a
  configured client id there is no Teams host to allow.

No credential, no tenant row: nothing opens.

## The flow

```
Teams tab (iframe, /embed/…)
  1. microsoftTeams.authentication.getAuthToken()            → Entra access token (JWT)
  2. POST /api/integrations/chat/teams/sso  { token }        → verify (below), resolve, mint
       ← { grant }                                             single-use ChatLoginGrant
  3. signIn('chat', { grant, totp? })                        → CredentialsProvider 'chat'
       consumes the grant, re-checks the account, issues the session
       (claims decided ONLY in the jwt callback, like sso/remember/magic)
  4. redirect to roleHome(role) under /embed
```

### Step 2: verifying the token

This step uses **`jose`**, already a dependency, with a remote JWKS: Entra's published keys, a
cached key set, and one refetch on an unknown `kid`. The JWKS URL comes from env
(`TEAMS_SSO_JWKS_URL`) with the real default, so the e2e can point it at the existing Bot
Framework stub. It is operator config, never request input.

The token is accepted only when ALL of these hold:

| Claim | Rule |
|---|---|
| signature | RS256 against a published key, by `kid`; an unverifiable token is refused, and a JWKS fetch failure refuses (fail closed) |
| `aud` | exactly `TEAMS_SSO_CLIENT_ID` or `api://<served host>/<TEAMS_SSO_CLIENT_ID>`; nothing else |
| `iss` | `https://login.microsoftonline.com/<tid>/v2.0` or `https://sts.windows.net/<tid>/` — and the `<tid>` in `iss` equals the `tid` claim |
| `tid` | a GUID that equals the `externalId` of an **enabled** `TEAMS` `ChatWorkspace` |
| `exp` / `nbf` | current, with five minutes of clock skew; a token without `exp` is refused |
| `oid` | present; this is the member's AAD object id |

The **raw token is never logged, stored or echoed back.** A refusal logs only a reason code
(`bad_signature`, `wrong_audience`, `unknown_tenant`, `expired`, …) and answers the same opaque
`401` whatever failed. The route is rate limited per IP and per `tid`.

### Step 2: which account

The token is **never** the account. It is a lookup key:

```
(workspace for tid, oid) → ChatIdentity with verifiedAt ≠ null → its User
```

The same rule applies as for the interaction dispatcher (#1948). The person has confirmed this
link themselves on their account page (#1937). An admin's proposal is not enough.

- **No implicit account creation, no provisioning, no matching by e-mail.**
- An unknown `oid`, an unconfirmed identity, or an identity in another workspace answers
  `{ link: true }`. The tab then shows the "link your account" screen (EN/TR/DE) and no grant is
  minted.
- The workspace's `orgId` must equal the user's `orgId`. A workspace never signs in a person of
  another org.

### Step 2: the grant

`ChatLoginGrant` is a new, **additive** model:

| Field | Notes |
|---|---|
| `id` | |
| `tokenHash` | sha256 of 32 random bytes; the raw value is returned once and never stored |
| `userId` | |
| `orgId` | registered in `TENANT_MODELS` |
| `identityId` | |
| `host` | the request host it was minted for |
| `expiresAt` | 60 s, like the remember-me grant |
| `used` | `Boolean @default(false)` |
| `createdAt` | |

Every column is nullable or has a server default, so `db push` applies it to a populated
database (`check:schema-push`).

The grant is spent the same way as every other grant, through `spendGrant()`
(`src/lib/grantSpend.ts`): **one conditional `updateMany`** on
`{ id, used: false, expiresAt: { gt: now } }`. Of two concurrent redemptions, exactly one sees
`count === 1`.

### Step 3: the `chat` provider, the same refusals as every other door

Once the grant is read, the provider applies the same checks as `magic`, in the same order and
with the same messages:

1. **inactive**, **unverified** and **pending approval** are refused;
2. **SSO-enforced** (`isPasswordLoginBlocked`) is refused. A Teams token proves an Entra session.
   It is not the org's configured IdP, so an org that enforces SSO signs in through its SSO and
   nowhere else;
3. an **archived tenant** is refused;
4. **world/host**: `assertAccountMatchesHost(user, req)`. The tab URL's host decides the world
   (`hostWorld.ts`), and the grant's `host` must equal the redeeming request's host;
5. **2FA (enrolled)**: if `twoFactorEnabled`, `requireSecondFactor()` runs **before** the grant is
   spent. The first redemption answers `2FA_REQUIRED` without spending it, and the tab asks for
   the code and redeems again with it, exactly like the magic link. A Teams token is not a second
   factor for a CRM account that enrolled one.
6. **2FA (policy)**: `is2faRequiredFor(role, orgId)` is not special-cased. The role shells' existing
   server-side gate redirects a person who must enrol to `/security-setup`, inside the tab like
   anywhere else. Enrolment needs a scanner, so that page offers "open in browser".

Only after all six does the conditional spend run. The session is then issued by the jwt
callback, the one place a token's claims are decided. An `auth.teams_sso_used` activity row is
written, carrying neither the token, its hash nor the grant.

### The `/embed` surface and the headers

- `/embed` is a route group that renders the **existing** role-home components in a chrome-free
  layout: no global nav, no chat widget, and `data-app-chrome` hidden as in the native app. It has
  its own `<I18nScope scope="embed">`.
- `next.config.js` `headers()` splits by source:
  - `/embed/:path*` sends `frame-ancestors` with exactly the Teams hosts and **no
    `X-Frame-Options`**: `https://teams.microsoft.com`, `https://*.teams.microsoft.com`,
    `https://*.cloud.microsoft` and `https://*.office.com`.
  - Every other source keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- The host list is one exported constant (`TEAMS_FRAME_ANCESTORS`), kept beside the CSP builder in
  `src/lib/cspPolicy.cjs` the way the meeting hosts are kept in `EMBEDDABLE_MEETING_HOSTS`.
- A header test fails if any non-embed path loses `DENY`.
- Slack has no tab surface, so `app.slack.com` is **not** added, unlike the issue's sketch. A host
  that serves nothing of ours is not one to allow.

## ⚠ Open decision: the session cookie inside an iframe

Teams web (`teams.microsoft.com`) frames our origin **cross-site**. The NextAuth session cookie is
`SameSite=Lax`, and browsers do not send a Lax cookie to a cross-site iframe. A session minted
inside the tab would be invisible to the very next request from the tab. There are three ways out:

- **A.** Make the session cookie `SameSite=None; Secure` everywhere. This is simple, but it
  changes the CSRF posture of every route. The middleware's write-origin check
  (`writeOriginVerdict`) still stands, but SameSite would no longer be a second line.
- **B.** For sessions minted by the `chat` provider only, write the session cookie
  `SameSite=None; Secure; Partitioned` (CHIPS). It is keyed to the Teams top-level site, so it
  exists only inside Teams and never in a normal tab. Every other session keeps `Lax`. This needs
  a small wrapper around NextAuth's cookie options, keyed on the sign-in provider.
- **C.** Do not keep a session in the tab at all. The tab only deep-links out ("open in browser")
  after SSO. That is safe, but the tab is then a launcher, not "the product inside Teams".

**Recommendation: B.** It is the only option that delivers the tab without touching the CSRF
posture outside Teams, and the partitioned cookie cannot leak into a first-party browsing context.

## Security tests (@smoke)

All of these refuse, and none of them mints a grant or creates an account:

- wrong `tid`;
- wrong `aud`;
- expired `exp`;
- a token signed by a foreign key;
- unknown or unconfirmed `oid`;
- a reused grant, which answers "invalid or expired" and creates no second session;
- an inactive user;
- an SSO-enforced org;
- a wrong-world host.

The header test must show `/embed` scoped and every other path still `DENY`. One positive test
covers the happy path: token → grant → session → role home.
