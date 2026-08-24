# Google Calendar integration — #417

EPIC D (meetings, RSVP, in-app calendar, auto Meet link, `.ics` export, reminder
emails) is shipped. This document covers the remaining acceptance item —
**user-consented Google Calendar OAuth** — and how to finish wiring it.

## Why it's config-gated, not on

Turning meetings into real Google Calendar events needs:

1. **The operator's Google Cloud OAuth client** (client id/secret + an
   authorized redirect URI). The app must never create Google accounts or act
   without the user's consent.
2. **A testable OAuth round-trip** — the code exchange + refresh-token storage
   can't be verified without a real Google project, so it isn't enabled blindly
   on production.

So today the integration ships as **detection + guidance**: Admin →
Integrations shows *Configured* / *Setup required*, and `src/lib/googleCalendar.ts`
provides `isGoogleCalendarConfigured()` and a pure `googleConsentUrl(state)`
builder ready for the connect route.

## Operator setup (one-time)

1. Google Cloud Console → APIs & Services → **Enable "Google Calendar API"**.
2. **OAuth consent screen**: external, add the scopes
   `.../auth/calendar.events`, `openid`, `email`; add test users while in
   testing.
3. **Credentials → OAuth client ID → Web application**. Authorized redirect URI:
   `https://crm.ersah.in/api/integrations/google/callback`
   (and the preview URL for staging).
4. Put the client id/secret in the server env file (`/etc/internship-crm/prod.env`):

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   # optional; otherwise derived from NEXTAUTH_URL:
   GOOGLE_OAUTH_REDIRECT_URI=https://crm.ersah.in/api/integrations/google/callback
   ```

   Redeploy. The Integrations page will flip to **Configured**.

## What is wired (#709)

All of it. The pieces the earlier note listed as "remaining" now exist:

| Piece | Where |
|---|---|
| Encrypted token store | `GoogleCalendarConnection` (AES-256-GCM via `src/lib/secretBox.ts`) |
| Meeting → event mapping | `GoogleCalendarEventLink`, per **(meeting, user)** |
| Connect | `GET /api/integrations/google/connect` → signed state → Google |
| Callback | `GET /api/integrations/google/callback` → state check → token exchange → sealed store |
| Event push | `src/lib/googleCalendarSync.ts`, called from `POST /api/meetings` |
| Disconnect | `DELETE /api/integrations/google/connection` — revokes at Google, then forgets |
| User-facing control | "Google Calendar" card on `/account` |

Design notes worth knowing before changing any of it:

- **The event mapping is per (meeting, user), not per meeting.** The same meeting
  is mirrored onto every connected participant's own calendar and each gets a
  different Google event id; one column on `Meeting` could only ever remember one
  of them.
- **The refresh token is encrypted, not hashed.** Everything else sensitive here
  is one-way, because for passwords and evidence one-way is safer. A refresh
  token has to leave the database *usable*, so it needs encryption. The key is
  derived from `NEXTAUTH_SECRET` through HKDF with a per-purpose label. This does
  not defend against an attacker holding both the database and the server env —
  nothing short of a KMS does — but a database dump or a stray backup yields no
  usable tokens.
- **Google returns a refresh token only on the first consent.** Re-consenting
  without one must not wipe the stored one, or the connection quietly becomes
  read-once and dies at the next expiry.
- **The push is fire-and-forget and swallows failures**, recording them on the
  connection. A third party's calendar API must never be able to make scheduling
  a meeting fail or hang. The meeting is the product; the mirror is a convenience.
- **Rotating `NEXTAUTH_SECRET` invalidates every stored token.** Decryption
  returns null rather than throwing, so connections simply stop working and
  people are asked to reconnect — no 500s. Say so in the release notes if you
  ever rotate it.

## Turning it on

The switch is **`GOOGLE_CALENDAR_ENABLED=1`**, and it is separate from having
credentials on purpose: client id/secret can sit in the env for a staging trial
long before anyone wants meetings flowing into real calendars.

1. Do the operator setup above on **preview** first, with the preview redirect URI.
2. Set `GOOGLE_CALENDAR_ENABLED=1` in the preview env and redeploy.
3. Sign in, `/account` → **Connect Google Calendar**, complete Google's consent
   screen, then schedule a meeting and check it appears in that Google account's
   calendar.
4. Only then repeat on production.

### Rollback

Unset `GOOGLE_CALENDAR_ENABLED` (or set it to `0`) and redeploy. Every entry
point checks it, so the connect button disappears and no meeting is mirrored;
stored connections are left untouched and resume if it is switched back on.
To also cut existing connections, have people press **Disconnect** (which
revokes at Google) or delete the `GoogleCalendarConnection` rows — the tokens
are then gone from this side, though a row deleted directly is *not* revoked at
Google, so prefer the button.

## What is tested, and what only real credentials can prove

`e2e/google-calendar.spec.ts` drives the whole loop — connect, a tampered state
being refused, the code exchange, tokens sealed at rest (the spec asserts the
plaintext is **not** in the row), a meeting mirrored, disconnect revoking — with
Google's endpoints pointed at a local stub (`e2e/support/google-mock.mjs`, wired
in `playwright.config.ts`). That is what makes this slice shippable at all: the
exchange used to be reachable only through live Google, which is why it sat
unfinished for so long.

What the stub **cannot** prove, and what the flag is therefore still guarding:

- that Google accepts our exact request shapes and scopes;
- that the consent screen behaves as expected for a real user;
- whether `conferenceData` yields a Meet link on the operator's OAuth client
  (not requested yet — the existing Jitsi link is still what invites carry).

Those need the real credentials from the setup section above. Do step 3 of
"Turning it on" before trusting the integration anywhere that matters.
