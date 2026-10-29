# Conferencing: which room a meeting gets (#2007, #2009)

Every meeting-creation path gets its room from `resolveMeetingLink()` (`src/lib/meetingRoom.ts`);
the precedence is pure in `src/lib/conferencingRule.ts`. The organization picks a policy
(`Organization.conferencingPolicy`, set on the admin settings page):

| Policy | Room, in order |
|---|---|
| `BUILTIN` (default) | pasted link → a room of ours |
| `PREFER_PERSONAL` | pasted link → the organizer's saved personal room → a room of ours |
| `REQUIRE_EXTERNAL` | pasted link → saved personal room → **refused** (`external_link_required`) |
| `GENERATE_PROVIDER` | pasted link → **a Google Meet room on the organizer's connected calendar** → saved personal room → a room of ours |

## Generated Google Meet rooms (#2009)

`src/lib/conferenceGeneration.ts`. When the policy is `GENERATE_PROVIDER`, the meeting has a time,
and the organizer has connected their Google Calendar (`GoogleCalendarConnection`), the meeting
path creates the event on **their own** calendar with `conferenceData.createRequest`
(`conferenceDataVersion=1`). The returned `hangoutLink` becomes `Meeting.meetLink`. No new scope or
consent is needed, because `calendar.events` already covers Meet creation.

**One link, never two.** The invite mail goes out in the same request, so the request waits for
Google for at most `GENERATE_TIMEOUT_MS` (4 s). That is option (a) in the issue: a bounded hold.
Past the timeout, or on any error, the meeting uses the next room in the table. The reason is
recorded on the connection (`lastError`, prefixed `Meet link generation`, shown on `/account`).
A Meet event that arrives late is deleted, never adopted. The generated event is then adopted as
the row's calendar mirror (`adoptProviderEvent`), so the background push PATCHes it instead of
creating a second event. If the booking loses a race (409), the event is removed
(`discardProviderEvent`).

Paths that generate: `POST /api/meetings` (timed), interview scheduling, and accepting a meeting
request (the mentor's calendar). Instant meetings, recurring series and group sessions have no
single slot to put a room in, so they never generate.

The e2e stub is `e2e/support/google-mock.mjs`; `POST /__conference {"fail":true}` makes Meet
creation fail. The spec is `e2e/conference-generation.spec.ts`.

## Microsoft Teams: waiting on the Graph connection

Teams uses the same shape: `isOnlineMeeting: true` + `onlineMeetingProvider: 'teamsForBusiness'`
on the event create, returning `onlineMeeting.joinUrl`. It needs the Microsoft 365 calendar
connection (#1991) and the provider-neutral `CalendarProvider` (#1989), and neither exists yet.
Once they land, Teams becomes a second branch inside `generateProviderConference()`. Nothing
else changes.

## Zoom: deferred by decision

Zoom is **not** a gap to re-file. It needs its own OAuth app, its own marketplace review and its
own token store. Meanwhile a pasted Zoom link, or a saved personal room holding a PMI, already
works under every policy and is validated by `checkPastedMeetingLink()`. Revisit it only when a
customer needs auto-generated Zoom rooms specifically.
