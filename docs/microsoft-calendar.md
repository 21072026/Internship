# Microsoft 365 / Outlook calendar — #1991

The second calendar provider, next to Google (`docs/google-calendar.md`). A
person connects their own Microsoft account on **Account → Connected
calendars**, and every meeting they are part of is mirrored into their Outlook
calendar: created, patched in place when it moves, removed when it is cancelled
or deleted. Default **off**.

## Operator setup (one-time) — needs real credentials

These are secrets: they live in the server env file and GitHub secrets only,
never in this repository.

1. **Microsoft Entra admin center → App registrations → New registration.**
   - Supported account types: *Accounts in any organizational directory and
     personal Microsoft accounts* (matches `MICROSOFT_TENANT=common`), or your
     own tenant only.
   - Redirect URI (Web): `https://interncrm.com/api/integrations/microsoft/callback`
     — and the preview URL for staging.
2. **API permissions → Microsoft Graph → Delegated**: `offline_access`,
   `User.Read`, `Calendars.ReadWrite`. **Never application permissions** — the
   app writes only to the calendar of a person who consented.
3. **Certificates & secrets → New client secret.** Note its expiry: an expired
   secret makes every connect and refresh fail (`lastError` on the rows says so).
4. Server env (`/etc/internship-crm/prod.env`):

   ```
   MICROSOFT_CLIENT_ID=<Application (client) ID>
   MICROSOFT_CLIENT_SECRET=<client secret value>
   MICROSOFT_TENANT=common            # or `organizations`, or a tenant id
   # optional; otherwise derived from NEXTAUTH_URL:
   MICROSOFT_OAUTH_REDIRECT_URI=https://interncrm.com/api/integrations/microsoft/callback
   MICROSOFT_CALENDAR_ENABLED=1       # only after a real round trip on preview
   ```

Configured (credentials present) and enabled (`MICROSOFT_CALENDAR_ENABLED=1`)
are separate on purpose, exactly like Google.

## How it works

| Piece | Where |
|---|---|
| Config, consent URL, master switch | `src/lib/microsoftCalendar.ts` |
| Token exchange, refresh (60 s early), sealed storage, `/me` account e-mail | `src/lib/microsoftCalendarClient.ts` |
| Graph event body — local wall clock + zone name | `src/lib/calendar/microsoftEvent.ts` (pure, unit-tested across DST) |
| The provider behind the shared sync loop | `src/lib/calendar/microsoft.ts`, registered in `src/lib/calendar/provider.ts` |
| Routes | `/api/integrations/microsoft/{connect,callback,connection}` |
| Token store | `CalendarConnection` with `provider = MICROSOFT`, sealed with the `microsoft-calendar` secretBox purpose |

- **Times.** Graph's `start`/`end` take a *local* `dateTime` plus a `timeZone`
  name. We write the wall clock the meeting shows in its stored zone
  (`Meeting.timeZone`), or UTC when it has none — never a UTC instant with a zone
  attached, which Outlook would read as local and shift by the offset.
- **Failures never block scheduling.** A Graph error is recorded on the
  connection's `lastError` and shown on the card; the meeting is saved anyway.
- **Disconnect** deletes the tokens and the event links here. Microsoft has no
  revocation endpoint an app can call for one delegated grant: the person
  removes the app at <https://myaccount.microsoft.com> → *Apps and services*
  (work accounts) or <https://account.live.com/consent/Manage> (personal).
  Account erasure disconnects Microsoft as it does Google.

## Not in this slice

- **Free/busy from Outlook** (Graph `getSchedule`) — bookings consult Google's
  free/busy and the database; Outlook busy blocks are a follow-up.
- **Recurring series as one Outlook series** — Google gets one RRULE event per
  series (#2654); on Outlook a series is not mirrored yet.

## Testing

`e2e/microsoft-calendar.spec.ts` drives connect → callback → push → move →
cancel → disconnect against `e2e/support/microsoft-mock.mjs` (the token
endpoint and Graph, from `MICROSOFT_OAUTH_TOKEN_URL` / `MICROSOFT_GRAPH_API_BASE`
in `playwright.config.ts`) with no real credentials. What only a real tenant can
prove is that Graph accepts our request shapes — try one connect on preview with
the real registration before setting `MICROSOFT_CALENDAR_ENABLED=1` on prod.
