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
   `https://interncrm.com/api/integrations/google/callback`
   (and the preview URL for staging).
4. Put the client id/secret in the server env file (`/etc/internship-crm/prod.env`):

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   # optional; otherwise derived from NEXTAUTH_URL:
   GOOGLE_OAUTH_REDIRECT_URI=https://interncrm.com/api/integrations/google/callback
   ```

   Redeploy. The Integrations page will flip to **Configured**.

## What is wired (#709)

All of it. The pieces the earlier note listed as "remaining" now exist:

| Piece | Where |
|---|---|
| Encrypted token store | `CalendarConnection` with `provider = GOOGLE` (AES-256-GCM via `src/lib/secretBox.ts`) — see § Provider-neutral tables below |
| Meeting → event mapping | `CalendarEventLink`, per **(meeting, connection)** |
| Connect | `GET /api/integrations/google/connect` → signed state → Google |
| Callback | `GET /api/integrations/google/callback` → state check → token exchange → sealed store |
| Event push | `src/lib/googleCalendarSync.ts`, called from `POST /api/meetings` |
| Recurring series push (#2654) | `src/lib/googleCalendarSeriesSync.ts`, called from `/api/meeting-series` (POST, PUT, DELETE) |
| Disconnect | `DELETE /api/integrations/google/connection` — revokes at Google, then forgets |
| User-facing control | "Google Calendar" card on `/account` |

Design notes worth knowing before changing any of it:

- **The event mapping is per (meeting, user), not per meeting.** The same meeting
  is mirrored onto every connected participant's own calendar and each gets a
  different Google event id; one column on `Meeting` could only ever remember one
  of them.
- **A recurring series is ONE recurring event per connected member (#2654)**,
  keyed by `CalendarEventLink.seriesId` (exactly one of `meetingId` /
  `seriesId` is set). Its occurrences have no `Meeting` row (#1110) and must
  never get one for this: the event carries `recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=…']`
  (`src/lib/seriesRrule.ts`, unit-tested) and the series' own `timeZone`, which
  Google needs to read BYDAY and the wall clock across a DST change. The
  audience is the project's members. `syncSeries()` *reconciles*: an active
  series is POSTed or PATCHed (same Google id) for every connected member, and
  every other link — a member who left, a series moved to another project, a
  cancelled one — is withdrawn. Create and schedule changes sync in the
  background; a cancel (DELETE, or PUT to inactive) awaits the same bounded
  withdrawal as `withdrawMeetings()`. Covered by `e2e/google-calendar-series.spec.ts`.
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

### Connecting from the marketing host (#2494)
Only ONE redirect URI is registered with Google (`NEXTAUTH_URL`'s host), and
sessions are host-only cookies, so a user who pressed "Connect" on the
marketing host used to come back to a host where they had no session. The
connect route now signs the originating origin into the OAuth `state`
(`userId.nonce.expiry.origin64.sig`; the 4-part form without an origin still
verifies, so a flow in flight across a deploy is not refused). The callback on
the registered host, given a state that **verifies** and whose origin passes
`servedOrigin()` and differs from its own, answers with one redirect to the
same callback path on that host, query untouched; that request then does
everything a callback always did — including the check that the state belongs
to *this* session, which is what makes a forwarded code safe. The token
exchange sends the registered `redirect_uri` from config, so it succeeds from
either host. **No operator step:** do not register the marketing host as a
second redirect URI — it is not needed, and a second URI is a second thing to
keep in sync.

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
revokes at Google) or delete the `CalendarConnection` rows with `provider = GOOGLE` — the tokens
are then gone from this side, though a row deleted directly is *not* revoked at
Google, so prefer the button.

## Provider-neutral tables (#1989)

Since #1989 the connection and the event mapping live in `CalendarConnection`
(key `(userId, provider)`, so one person can hold a Google **and** a Microsoft
connection) and `CalendarEventLink` (`externalEventId`). This is the **expand**
half of an expand/contract change:

- The old `GoogleCalendarConnection` / `GoogleCalendarEventLink` tables are still
  in the schema, **no longer read or written** — except that **Disconnect**
  deletes the person's old row too, so a token they asked us to forget does not
  survive there. They are the rollback.
- `prisma/backfill-calendar-connections.mjs` (registry `0035`, **once**) copies
  them across at deploy, insert-only; its log line prints the old and new counts.
- The **contract** step — dropping the two old models — is a separate PR, and
  only after the production log reads `old <= new` for both. Renaming instead
  would have been a drop-and-recreate under `db push --accept-data-loss` and
  destroyed every stored consent.

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

## Free/busy (#1997)

Bookings also respect what a person's **real** calendar says is taken. This
covers more than the meetings this app created.

- `providerBusy(userIds, from, to)` in `src/lib/calendarFreeBusy.ts` calls
  `POST {apiBase}/freeBusy` for each connected user whose stored `scope` permits
  it (`calendar.freebusy`, `calendar.readonly` or `calendar`). It returns busy
  windows by user id.
- **Only `{ start, end }` crosses the boundary.** The response is mapped field by
  field. No summary, attendee or location reaches a caller, a log or a row. The
  windows carry an empty title, so a refusal says "already taken" and never what
  the other appointment is.
- **Never inside the booking lock.** The write paths fetch before their
  transaction, padded by 4 hours so a buffer (#2003) can see neighbouring
  blocks. They pass the result into `busyWindows()` / `findConflict(For)` /
  `findPolicyViolation` as `external`. After that the answer is one list, and
  callers cannot tell where each window came from.
- **Degrade, never block.** A user with no connection, a connection without the
  scope, a 4xx/5xx or a timeout (5 s, `AbortSignal.timeout`) all fall back to
  today's database-only answer for that person. The reason is written to the
  connection's `lastError`. A later successful push overwrites it, because
  `lastError` describes the most recent calendar operation.
- **Bounded:** at most 5 people at a time, and a 60 s in-process cache keyed by
  (connection, quarter-hour window). There is no durable cache.
- **Scope:** `calendar.freebusy` is now requested on connect. Existing
  connections keep pushing on their old grant, and the Connected calendars card
  *offers* a reconnect (`freeBusy: false` in `/api/integrations/calendar/status`).
- **Testing:** the e2e stub (`e2e/support/google-mock.mjs`) answers `freeBusy`
  with blocks set through `POST /__freebusy` (`{ busy, fail }`). Every block it
  returns carries a fake `summary`, which `e2e/calendar-free-busy.spec.ts`
  proves never leaves the server.

Microsoft's `POST /me/calendar/getSchedule` will join here once its connection
exists (#1991). The provider-neutral interface belongs to #1989.
