# Conferencing: which room a meeting gets (#2007, #2009)

Every meeting-creation path gets its room from `resolveMeetingLink()` (`src/lib/meetingRoom.ts`);
the precedence is pure in `src/lib/conferencingRule.ts`. The organization picks a policy
(`Organization.conferencingPolicy`, set on the admin settings page):

| Policy | Room, in order |
|---|---|
| `BUILTIN` (default) | pasted link → a room of ours |
| `PREFER_PERSONAL` | pasted link → the organizer's saved personal room → a room of ours |
| `REQUIRE_EXTERNAL` | pasted link → saved personal room → **refused** (`external_link_required`) |
| `GENERATE_PROVIDER` | pasted link → **a Google Meet / Microsoft Teams room on the organizer's connected calendar** → saved personal room → a room of ours |

## Generated Meet and Teams rooms (#2009)

`src/lib/conferenceGeneration.ts` sits on top of the provider interface
(`CalendarSyncProvider.createConference`, `src/lib/calendar/provider.ts`). Generation happens when
three things hold: the policy is `GENERATE_PROVIDER`, the meeting has a time, and the organizer
has a connected calendar (`CalendarConnection`). The meeting path then creates the event on
**their own** calendar together with the provider's own room:

- **Google:** `conferenceData.createRequest` with `conferenceDataVersion=1`. The answer's
  `hangoutLink` is the room.
- **Microsoft 365:** `isOnlineMeeting: true` with `onlineMeetingProvider: 'teamsForBusiness'`.
  The answer's `onlineMeeting.joinUrl` is the room.

The room becomes `Meeting.meetLink`. When both providers are connected, Google is tried first,
following the registry's order. No new scope or consent is needed.

**One link, never two.** The invite mail goes out in the same request, so the request waits for
the provider for at most `GENERATE_TIMEOUT_MS` (4 s). That is option (a) in the issue: a bounded
hold. Past the timeout, or on any error, the meeting uses the next room in the table, and the
reason is recorded on the connection (`lastError`, prefixed `CONFERENCE_NOTE_PREFIX`, shown on
`/account`). The mirror push clears only its own errors, never that note.

What happens to the generated event afterwards:

- An event that arrives after the timeout is deleted, never adopted.
- The generated event is adopted as the row's calendar mirror (`adoptProviderEvent`), so the
  background push PATCHes it instead of creating a second event.
- If the booking loses a race (409), the event is removed (`discardProviderEvent`).

Paths that generate: `POST /api/meetings` (timed), interview scheduling, and accepting a meeting
request (the mentor's calendar). Instant meetings, recurring series and group sessions have no
single slot to put a room in, so they never generate.

The e2e stubs are `e2e/support/google-mock.mjs` and `e2e/support/microsoft-mock.mjs`. Sending
`POST /__conference {"fail":true}` to the Google stub makes Meet creation fail. The spec is
`e2e/conference-generation.spec.ts`.

## Zoom: deferred by decision

Zoom is **not** a gap to re-file. It needs its own OAuth app, its own marketplace review and its
own token store. Meanwhile a pasted Zoom link, or a saved personal room holding a PMI, already
works under every policy and is validated by `checkPastedMeetingLink()`. Revisit it only when a
customer needs auto-generated Zoom rooms specifically.
