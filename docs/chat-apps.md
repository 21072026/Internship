# Slack and Microsoft Teams apps — #1923

**Nothing is implemented yet.** There is no `ChatWorkspace` / `ChatIdentity` /
`ChatDelivery` model in `prisma/schema.prisma`, no `src/lib/chat*`, no
`/api/integrations/chat/*` route, no card renderer and no e2e stub — searching
`src/` and `prisma/` for `slack` or `teams` returns link-preview marketing copy,
a release note and a comment about Jitsi clock drift, and nothing else. The
epic's own hard blockers have not landed either: `src/lib/notifications/router.ts`
(#1705/#1706) and the `ChatTransport` contract (#1712) do not exist, and #1923
says in as many words that starting before them writes the fan-out logic a third
time into `emailService.ts`.

This document is therefore written **ahead of the code, on purpose**: the env
contract, the credentials an operator has to obtain from each provider, the
store-submission burden and the commercial decision are the parts that get lost
between the review that made them and the PR that needs them. Every section
below describes what an operator *will* do; none of it describes something you
can do today. When Story 1 (#1925) lands, the parts of this file that turn into
claims should be checked against the code in the same PR — a runbook that
describes a route which does not exist is worse than no runbook.

## The commercial gate

The go-to-market review put a chat app on the *deliberately do not build* list
for year 1. Quoted from
[`docs/research/competitive-analysis-2026-08.md`](research/competitive-analysis-2026-08.md)
§8.2 ("Explicit non-goals, with the reason and the sentence we say instead"),
verbatim:

> **We will not build:** Microsoft Teams app and Slack app
> **Reason:** The most-repeated integration in the category *and* the loudest
> omission — but ~15 story points each for a segment we are not selling to; our
> buyer's programme runs on email and a browser
> **What we say:** "Zapier and signed webhooks. Revisit when three paying
> customers ask in writing."

That answer is still shipped and still true: `/admin/integrations` carries
admin-managed outbound **webhooks** (HMAC-signed over the body —
`src/lib/webhooks.ts`, eight event types in `WEBHOOK_EVENTS`) and **API keys**
for `/api/v1/*`, which is what a Zapier or Make recipe consumes.

**What changed, honestly: not the condition.** The three-paying-customers bar has
**not** been met — no customer has asked for this in writing. #1923 was put in
scope by an **owner scope decision on 2026-08-30**, recorded in that issue's own
goal section ("In scope by owner decision (2026-08-30) … the owner has put this
epic in scope for this round, which supersedes that gate"). So the gate was
*overridden*, not *satisfied*. The structural half of the same review's objection
was **not** overridden and is now a hard dependency: Slack and Teams are two
`ChatTransport` implementations on the one `chat` channel of the notification
router (#1712), never a second and third fan-out.

Consequences worth keeping in view while building it: the research documents
still show the old ordering, the ~15 story points per platform have not become
cheaper, and if the round ends before the epic does, the honest answer to a
prospect is the webhook/Zapier sentence above — not a half-built app.

Epic: #1923 · governance story: #1932 · this task: #1961.

## Environment variables

Two states, and they are deliberately different (the same discipline as Google
Calendar — `isGoogleCalendarConfigured()` vs `isGoogleCalendarEnabled()` in
`src/lib/googleCalendar.ts`, checked at
`src/app/api/integrations/google/connect/route.ts`):

- **configured** — the operator has obtained credentials from Slack / Microsoft
  and put them in the env. Nothing is delivered yet.
- **enabled** — `CHAT_APPS_ENABLED=1` as well. Credentials can sit in a preview
  env through days of trial installs before anyone wants a real notification
  landing in a customer's workspace.

| Variable | Platform | Where it comes from | Required |
|---|---|---|---|
| `SLACK_CLIENT_ID` | Slack | app settings → **Basic Information → App Credentials**. Not secret (it appears in the install URL). | for Slack |
| `SLACK_CLIENT_SECRET` | Slack | same panel. **Secret** — server env / GitHub secrets only. | for Slack |
| `SLACK_SIGNING_SECRET` | Slack | same panel. **Secret**. Verifies an inbound interaction really came from Slack (`X-Slack-Signature` over `v0:<ts>:<raw body>`). | for Slack |
| `TEAMS_APP_ID` | Teams | the Entra ID app registration's **Application (client) ID**, reused as the bot's app id. Not secret. | for Teams |
| `TEAMS_APP_PASSWORD` | Teams | the client secret created on that registration. **Secret**, and it **expires** — record the expiry where an operator will see it. | for Teams |
| `TEAMS_TENANT_ID` | Teams | the **Directory (tenant) ID**. Set it for a single-tenant app; leave it unset for a multi-tenant one. | single-tenant only |
| `CHAT_OAUTH_REDIRECT_URI` | both | Optional override. Defaults to `<NEXTAUTH_URL>/api/integrations/chat/<platform>/callback`, the same derivation `googleRedirectUri()` uses. Set it only when the public URL differs from `NEXTAUTH_URL`. | no |
| `CHAT_APPS_ENABLED` | both | The master switch. Unset or `0`: no install button, no delivery, inbound endpoints answer 404. | to deliver |
| `SLACK_API_BASE` / `TEAMS_API_BASE` | both | **Test/staging only** — point the platform APIs at a local stub. Never set in a real deployment. | no |

Rules that are not negotiable: a bot or refresh token is sealed with
`src/lib/secretBox.ts` (`seal()` / `open()`), never stored in the clear, never
logged and never returned by an API — the same treatment
`GoogleCalendarConnection` gives its refresh token. Placeholders only in this
file and in `.env.example`; a real secret in git is a rotation, not a typo.

## Operator setup (one-time)

**Teams first** — #1923 sequences it that way because the buyer who pays for
this is enterprise HR.

### Microsoft Teams

1. **Entra ID (Azure portal) → App registrations → New registration.** Name it
   for the deployment (e.g. *Internship CRM (preview)*). Pick **single tenant**
   unless you intend to publish to the Teams store, which needs multi-tenant.
2. Copy the **Application (client) ID** → `TEAMS_APP_ID`, and the **Directory
   (tenant) ID** → `TEAMS_TENANT_ID`.
3. **Certificates & secrets → New client secret.** Copy the value once (it is
   never shown again) → `TEAMS_APP_PASSWORD`. Note the expiry date: when it
   lapses, delivery stops with a 401 and nothing else changes.
4. **Bot Framework channel registration** (Azure Bot resource): use the same app
   id, set the **messaging endpoint** to
   `<NEXTAUTH_URL>/api/integrations/chat/teams/messages`, and add the
   **Microsoft Teams** channel.
5. Build the **Teams app package** — `manifest.json` plus a 192×192 colour icon
   and a 32×32 transparent outline icon, zipped. The manifest declares the bot,
   the embedded tab and any commands.
6. **Upload it**: Teams admin center → *Teams apps → Manage apps → Upload new
   app* for the whole tenant, or *Apps → Manage your apps → Upload a custom app*
   for a single-user trial. Neither needs a store listing.
7. Put the three variables in the server env file
   (`/etc/internship-crm/prod.env`) and redeploy. Leave `CHAT_APPS_ENABLED`
   unset until the verification below has been done on preview.

Note on the embedded tab: `next.config.js` currently sends
`frame-ancestors 'none'` and `X-Frame-Options: DENY`, so a Teams tab **cannot**
load this app until that is loosened deliberately for the Teams host origins.
That is #1923's Story 4, not an operator setting.

### Slack

1. **api.slack.com/apps → Create New App → From an app manifest.** The manifest
   is what makes the install reproducible across environments; do not
   hand-configure a second workspace and hope it matches.
2. **OAuth & Permissions → Redirect URLs**: add
   `<NEXTAUTH_URL>/api/integrations/chat/slack/callback` — one entry per
   environment, since preview and production are different URLs (and preferably
   different apps).
3. **Bot token scopes**, and no more than these: `chat:write` (post a DM or a
   channel message), `users:read` and `users:read.email` (match a Slack member to
   a CRM user by verified email while linking identities). Every extra scope is a
   question in the security review and a line in the store listing.
4. **Interactivity & Shortcuts**: request URL
   `<NEXTAUTH_URL>/api/integrations/chat/slack/interactions`. Slash commands, if
   any, point at the same route.
5. **Install to Workspace** (admin consent), then copy **Client ID**, **Client
   Secret** and **Signing Secret** from *Basic Information → App Credentials*
   into the env and redeploy.
6. Confirm the signing secret is actually being used: an interaction POST with a
   wrong, missing or replayed signature must be rejected before anything is
   derived from it. A chat member id is an identifier, never a credential —
   authorization is re-derived server-side from the linked CRM user.

### Verifying, in this order

1. Do the setup above on **preview**, with the preview URLs.
2. Install into a throwaway workspace / tenant, never a customer's.
3. Link one identity and check it resolved to the right CRM user.
4. Deliver one notification, act on it once from inside chat, then **uninstall**
   and confirm the tables are clean (#1932).
5. Only then repeat on production, and only then set `CHAT_APPS_ENABLED=1`
   there.

### Rollback

Unset `CHAT_APPS_ENABLED` (or set it to `0`) and redeploy: nothing is delivered
over chat and the router falls back to the person's other channels, so nobody
loses a notification. That is the fast, global switch. The per-workspace switch
and the real uninstall (revoke platform-side, *then* delete the workspace and
its identities) belong to #1932 — a deleted row with a live token on their side
is not an uninstall.

## Running the local stub

**The stub does not exist yet.** It is owned by the story that ships delivery
(#1925), and it is the thing that will make this epic testable at all — the same
lesson as Google Calendar, where the token exchange sat unfinished for months
precisely because it was reachable only through live Google.

The shape to copy is already in the repo: `e2e/support/google-mock.mjs`, wired in
`playwright.config.ts` and reached through the test-only
`GOOGLE_OAUTH_TOKEN_URL` / `GOOGLE_OAUTH_REVOKE_URL` / `GOOGLE_CALENDAR_API_BASE`
overrides (see `.env.example`). For chat that means:

- `e2e/support/chat-mock.mjs` — a small local HTTP server answering the OAuth
  code exchange, `chat.postMessage` / the Bot Framework send, and `users.info`;
- `SLACK_API_BASE` / `TEAMS_API_BASE` pointed at it, set **only** by
  `playwright.config.ts`;
- placeholder credentials plus `CHAT_APPS_ENABLED=1` in the test env, so the e2e
  exercises the enabled path while every real deployment stays dormant.

What a stub can prove: the install round-trip, that a tampered signature is
refused, that tokens are sealed at rest (assert the plaintext is **not** in the
row), that a notification renders and is delivered, and that uninstall leaves
nothing behind. What it cannot prove — and what therefore keeps
`CHAT_APPS_ENABLED` guarding production — is that Slack and Microsoft accept our
exact request shapes and scopes, that both card dialects render as intended in
the real clients, and that admin consent behaves as expected in a real tenant.

## Store-submission checklist

Both listings are review-gated, and both reviews bounce for the same
non-engineering reasons. Neither store is on the critical path for a single
customer: a Teams **custom app upload** and a Slack **install to workspace** need
no listing at all, so treat submission as a later, separate decision.

| Requirement | Slack App Directory | Microsoft Teams store |
|---|---|---|
| Privacy policy URL | required | required |
| Terms of use URL | required | required |
| Support contact / URL | required | required |
| Publisher identity | app owner details | **Microsoft Partner Center account + publisher verification** |
| Scope / permission justification | one sentence per scope; reviewers do push back on `users:read.email` | permissions declared in the manifest |
| Screenshots + short/long description | required | required |
| Working **uninstall** that revokes and deletes | required | required |
| Localisation | the listing is EN, but the app must not break in TR/DE | same |
| Accessibility | — | reviewed |
| Turnaround | days to weeks, iterative | weeks; Partner Center validation is stricter |

The uninstall row is the one that reaches back into the code: both stores expect
removing the app to actually stop everything and drop what we hold. That is
exactly #1932's acceptance criterion — "uninstall leaves **no** sealed token and
no chat identity behind, proven by a test that queries the tables after the
call". Do not submit either listing before that test is green.

## What data leaves the app

Written for a security reviewer. Read alongside
[`docs/DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md) and
[`docs/pii-access-lifecycle.md`](pii-access-lifecycle.md).

**Crossing the boundary, by design:**

- a **display name** and the event's own wording (the ~110 keys under
  `notifications.events` in `src/i18n/dictionaries.ts`, rendered in the
  recipient's locale);
- a **date, time and timezone** for a meeting or a deadline;
- a **deep link** back into the CRM, where authorization is checked as usual;
- for an in-chat action, an opaque **signed token** — the pattern already shipped
  for e-mail one-click actions (`src/lib/emailActionToken.ts`,
  `Meeting.rsvpToken`), scoped to one action and expiring.

**Not crossing it:** CV files and extracted CV content, phone numbers, postal
addresses, evaluation text and scores, interview feedback, message-thread
bodies, salary and offer figures, and anything else a deep link can carry the
person to instead. A notification says *what happened and where to look*; it is
not a copy of the record. Assume every message is retained indefinitely by the
platform, is visible to that workspace's admins, and is out of our control the
moment it is accepted — which is the whole argument for minimisation here.

**What we hold, and for how long:** a sealed bot/refresh token per workspace and
a per-person platform member id (a `ChatIdentity`, created only after the person
links their own account — never inferred from an email match alone). Both are
deleted on uninstall; only `ChatDelivery` *metadata* (event type, outcome,
timestamp, failure reason) is retained for the support window, and it carries no
message body.

**Third parties:** Slack Technologies / Salesforce and Microsoft become
processors for whatever is delivered. A deployment carrying real mentee data
needs them in its subprocessor register and its privacy notice before the first
customer install — the `OPERATOR_*` variables in `.env.example` are where that
page's content comes from.

### Feature-catalogue entry (deferred)

Item 3 of #1961 — a `chatApps` entry in the `platform` category of
`src/lib/features.ts` plus its EN/TR/DE strings in the `featureCatalog` block of
`src/i18n/dictionaries.ts` — was **deliberately not shipped with this
document**. The landing cards and `/features` are a product claim made to the
public, and CLAUDE.md's rule is to keep those claims in sync with shipped
features; the shipped feature here is currently zero lines of code, so the card
would advertise something a prospect cannot use.

It lands in the PR that first delivers a real chat notification (#1925 / #1926),
together with that PR's release fragment and its user-facing notes. The nine
original `landing.f*` keys stay untouched either way — several e2e specs assert
those exact strings.
