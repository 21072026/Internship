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

## Remaining wiring checklist (needs the credentials above to test)

1. **Token store** — a `GoogleCalendarConnection` model (or fields on `User`):
   `userId`, `accessToken`, `refreshToken`, `expiresAt`, `googleEmail`,
   `calendarId`. Store the refresh token encrypted.
2. **Connect route** `/api/integrations/google/connect` — generate + persist a
   `state`, redirect to `googleConsentUrl(state)`.
3. **Callback route** `/api/integrations/google/callback` — verify `state`,
   exchange `code` for tokens (`googleapis` or a direct token POST), upsert the
   connection for the signed-in user.
4. **Event push** — when a `Meeting` is created/updated for a user with a live
   connection, create/patch the Google event (with `conferenceData` for the Meet
   link) using their token; refresh on expiry. Keep the existing `.ics` path as
   the fallback for unconnected users.
5. **Disconnect** — revoke + delete the stored tokens.
6. **Tests** — connect/callback happy path against a mocked token endpoint;
   ensure unconnected users still get `.ics` + reminders unchanged.

## Security notes
- Request the narrowest scope (`calendar.events`, not full `calendar`).
- Store refresh tokens encrypted; never log them; never return them to the
  client (the status endpoint only reports `configured` / `connected`).
- The whole flow is per-user and consent-based; the app acts only on calendars
  a user explicitly connected.
