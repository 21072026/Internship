# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/). The app
version is shown in the sidebar footer of every page (links to the
[user-facing release notes](src/lib/releaseNotes.ts), rendered at
`/release-notes`) and in the landing-page footer.

## [0.41.4-beta] - 2026-08-04

### Changed
- **A project goal assigned to someone now lives on that person's profile, not on the project
  page.** `ProjectGoals` used to list "my goals" and "the team's goals" next to the unassigned
  pool, so every member read everyone's personal checklist. The project page now keeps only the
  unassigned goals anyone may claim, plus a count of how many are assigned; the goals themselves
  are rendered by the new `PersonProjectGoals` panel on `/portal/profile` (your own),
  `/mentor/mentees/[id]` and `/admin/candidates/[id]`.
- New `GET /api/project-goals[?userId=]` — one person's assigned goals across all their projects,
  grouped by project. Readable by the person themselves, an ADMIN, or their mentor; each goal
  carries `canEdit` mirroring the tick rules of `PATCH /api/project-tasks/[taskId]` (your own
  goals, or any goal if you lead the project). "Release" (hand a goal back to the open pool)
  moved along with the goal, so nothing that was possible on the project page was lost.
- Notifications about a new goal now link to where the goal actually is
  (`src/lib/projectGoalLink.ts`: `/portal/profile` for a mentee, the project otherwise) instead
  of a project page that no longer shows it.

### Added
- **A shared starter pool of 20 project-goal templates** (`prisma/seed-goal-templates.mjs`,
  wired into `infra/deploy-prod.sh` next to `seed-templates`). Every project's template pool is
  "its own templates + the shared ones", and the shared half was empty, so the "send the starter
  goals" button had nothing to offer until a mentor had typed the set by hand. Idempotent: only
  missing titles are inserted (MySQL does not enforce the `@@unique([projectId, title])` key
  across NULL `projectId`s, so existence is checked in the script).

## [0.41.3-beta] - 2026-08-04

### Changed
- **Mentee names on the mentor dashboard are links to their mentorship page.** The onboarding
  card (`MenteeOnboardingWizard`) rendered the mentee's name as plain text inside its subtitle;
  it now links to `/mentor/mentees/<relationId>` (plain text when the pair is only connected
  through a shared project, where there is no relation page to open). The same applies to the
  name in the "my mentees" card and to the mentee in the "recent interactions" list on
  `/mentor`, which previously offered only a separate "view details" link.
- The onboarding checklist's tick buttons now carry a `title` explaining why some of them are
  not clickable: an auto-detected step is the app's own observation, the rest are the mentor's
  to set (`menteeOnboarding.autoHint` / `markHint` / `unmarkHint`, EN/TR/DE).

### Fixed
- The "recent interactions" list on `/mentor` printed a hard-coded English `with <name>` on
  every locale; it now uses `mentor.interactionWith` (EN/TR/DE).

## [0.41.2-beta] - 2026-08-04

### Fixed
- **A backdated status change could drag "average days to hire" negative** (#933).
  `GET /api/mentor/analytics` and `GET /api/admin/analytics/cohorts` compute the average
  from `HIRED`/`EMPLOYED` transition timestamps minus the relation's `startDate`; a manually
  corrected or imported transition dated before `startDate` produced a negative duration that
  was averaged in as-is, pulling the whole metric down (or below zero). The mentor route now
  drops negative durations from the average instead of counting them — matching the admin
  cohorts route, which already excluded them (`d >= 0`, since #538) — and reports
  `avgDaysToHired: null` when no valid duration remains. Positive durations are unaffected.

## [0.41.1-beta] - 2026-08-04

### Added
- **Public "become a mentor" application API** (#904). `POST /api/mentor-applications` accepts
  an unauthenticated submission (name, email, phone, expertise, experience, motivation,
  capacity, LinkedIn URL, locale) without creating a `User` — turning an approved application
  into an account is a later task. IP- and email-rate-limited (429 past the limit), rejects a
  second submission while one is `PENDING` (409), and never reveals whether the email already
  belongs to an account (same neutral `{ ok: true }` response either way, no row created).
  `consentAt` is stamped server-side on every real submission. Active admins get an in-app
  notification linking to `/admin/mentor-applications` (no admin UI yet — that and the
  approve/reject decision endpoint are follow-up work). `GET /api/mentor-applications` is
  ADMIN-only, filterable by `status`, and paginated like `/api/admin/activity`. New
  `MentorApplication` model/`MentorApplicationStatus` enum in `prisma/schema.prisma`.

## [0.41.0-beta] - 2026-08-04

### Added
- **"A meeting is about to start" on the dashboard, and a join link while it runs.**
  `src/lib/upcomingMeeting.ts` answers one question for a user — the meeting in progress,
  else the next one starting within `MEETING_LEAD_MINUTES` (30) — from *both* sources that
  can put a meeting on someone's calendar: `Meeting` rows (either side of the relation) and
  `MeetingSeries` rules on projects the user belongs to, so a member with no mentorship for
  the project still sees the recurring call. A meeting has no end time in the schema, so
  "still going" is a fixed `MEETING_DURATION_MINUTES` (60) window after the start; an
  occurrence and the `Meeting` row generated from it are deduplicated.
- `GET /api/meetings/upcoming` (`no-store`), `UpcomingMeetingBanner` on the three dashboards,
  and `JoinMeetingPill` in `ResponsiveShell` — the pill shows **only while the meeting is
  running**, so it keeps meaning something, and it follows the user across every page in the
  shell. Both components share one poll a minute via `useUpcomingMeeting` rather than one
  each.

## [0.40.10-beta] - 2026-08-04

### Changed
- **The admin candidate list is now usable at 375px without horizontal page overflow.**
  Mobile shows compact candidate cards with name, pipeline stage and mentor first, followed
  by education, city and skills. The seven existing filters stay unchanged but are collapsed
  behind a visible Filters control on small screens. The existing desktop candidate grid and
  its actions remain unchanged.

## [0.40.9-beta] - 2026-08-03

### Added
- **Starting a meeting opens the notes window in the same click** (#1058). The subtle part:
  `notes.open()` is called *before* the `fetch`, not after. Opening a floating window needs
  transient user activation and awaiting the API round trip spends it — the window would
  then silently never open. So the window is opened on the click and the room is attached to
  it once the server answers (`notes.attach`). If the meeting fails to start, the window is
  closed rather than left floating with nothing to belong to.
- **A per-device toggle** in account settings for that behaviour (default on). Per-device
  like the composer's enter-to-send: which machine you take notes on is a property of the
  machine, not the account.
- **A note line becomes a goal or a project task** (#1059). `POST /api/notes/[id]/convert`
  reuses the existing `Goal` / `ProjectTask` models — no new one needed. The target follows
  the meeting: a mentorship meeting yields a goal, a project meeting a task. Where there is
  neither (a chat meeting, or no meeting), the affordance is hidden rather than offered and
  then refused.
- `e2e/note-to-work.spec.ts` — the window opening on the same click and its notes landing
  against that meeting, a line converting exactly once, and both refusals below.

### Security
- The convert endpoint checks that the line **is actually in the note** — otherwise it is a
  generic "create a goal anywhere" wearing a note id — and that the caller may write to the
  target (the relation's mentor, or a member of the project; admins too). An assignee who
  isn't on the project is rejected rather than handed a task they cannot see.

### Changed
- A converted line is marked `✓` in place rather than deleted: the note is the record of
  what was said, and quietly removing sentences from it would rewrite history. The mark is
  also what makes a second click a no-op (409) instead of a duplicate.

## [0.40.8-beta] - 2026-08-03

### Added
- **A notes window that floats above everything** (#1057). `openFloatingWindow`
  (`src/lib/floatingWindow.ts`) opens a Document Picture-in-Picture window — the only web
  API that gives an always-on-top window with a real DOM — and falls back to a plain popup
  where it is missing (Safari, Firefox, mobile). Rendered through a React portal, so it is
  ordinary UI code in the opener's context. Autosaves 2s after typing stops, flushes on
  close (a debounce that never fired would lose the last sentence), and mirrors every
  keystroke into `localStorage` so a failed request can't take the notes with it. The
  fallback says out loud that it can't stay on top; a blocked popup says so too.
- **`PersonalNote.meetingId`** (#1056) — a note taken in a meeting now knows which one, and
  `GET /api/notes?meetingId=` reads them back. `onDelete: SetNull`, not Cascade: deleting the
  meeting must not delete what was written in it. A note created with a `meetingId` defaults
  to the `MEETING` category without anyone selecting it, and `NotesPanel` shows the room's
  name on the note.
- `e2e/meeting-notes.spec.ts` — the note↔meeting link surviving the meeting's deletion, both
  window branches (each *forced*, see below), and a popup-fallback window that really saves.

### Security
- Attaching a note to a meeting is authorized server-side (`src/lib/noteMeeting.ts`): the
  author must have been in the room — organizer, either side of the relation, project member,
  or chat participant (admins too). The note itself is private, but the id is a foreign key
  into someone else's meeting, and `?meetingId=` would otherwise confirm it exists. `PATCH`
  is guarded identically — re-pointing a note at a meeting you weren't in is a probe, not an
  edit.

### Note for future test-writers
- **Headless Chromium *does* expose `documentPictureInPicture`.** A test that just asserts the
  fallback would silently exercise the PiP branch and prove nothing about Safari/Firefox
  users. Both branches are therefore forced with `addInitScript` — one deletes the API, the
  other stubs `requestWindow`. The genuine always-on-top behaviour can't be asserted
  headlessly and is verified by hand.

## [0.40.7-beta] - 2026-08-03

### Added
- **Start a meeting for a whole project team** (#1055). A button next to the recurring rule
  on the project page — the two sit together but are different things: one books a weekly
  slot, the other opens a room now. Visible to admins and OWNER/MENTOR members, mirroring
  the server rule in `resolveMeetingContext`; mentee members join a call, they don't summon
  one. `ProjectWeeklyMeeting` no longer hides itself when there is no series but the viewer
  may still start a call.
- **Start a meeting from a group chat, and the link lands in the chat** (#1055). Button in
  the thread header (and its own row on a phone, where that header is hidden). The
  conversation branch of `/api/meetings/instant` now also posts the room into the thread, as
  the organizer rather than a faceless system row — `Message` has no system flag, and "who
  called us in" is worth knowing. Any participant may start one; a non-participant gets 403
  and no message is written.
- `e2e/instant-meeting-team.spec.ts` — team call by an owner (incl. the member's in-app
  notification), a mentee member refused, a chat call landing in the thread, and an outsider
  refused with nothing posted.

### Note
- Only *conversation* threads get the button. The legacy relation thread is left out: its
  mentee would be refused server-side anyway (relations are mentor-scoped), and a button
  that always fails is worse than no button. Mentors reach 1:1 calls from the mentee card.

## [0.40.6-beta] - 2026-08-03

### Added
- **"Start meeting" wherever the person already is** (#1053). A button on each mentee card
  (`/mentor/mentees`), on the candidate detail scheduler and on the bulk selection in
  `MeetingsManager`. One click asks for the topic — nothing else — and calls
  `/api/meetings/instant`; the link is copied to the clipboard and the room opens on screen
  without a list refresh. The candidate/bulk buttons sit next to the existing form on
  purpose: booking a time and calling now are different intents.
- **In-app meeting side panel** (#1054). `MeetingLauncherProvider` is mounted in
  `Providers`, *above* every page shell, so a call in progress survives navigating from the
  mentee list to their profile — a panel owned by a page would drop the meeting. Jitsi rooms
  are embedded in an iframe; anything else (Meet/Zoom/Teams send `X-Frame-Options`) gets an
  explicit "open in a new tab" instead of an empty box. On a phone the panel is a bar with a
  Join button — a video that small helps nobody.
- `e2e/instant-meeting.spec.ts` — one-click start from a mentee card (`@smoke`, also asserts
  the panel survives navigation), the endpoint returning its link, and a mentor being unable
  to start a meeting for someone else's mentee.

### Fixed
- **The embedded call would have had no camera and no frame.** `Permissions-Policy` was a
  blanket `camera=(), microphone=()`, which disables them for every frame including our own,
  and the CSP had no `frame-src`, so `default-src 'self'` blocked the Jitsi iframe outright.
  Both are now narrowed to the one host we generate links for —
  `frame-src 'self' https://meet.jit.si` and `camera=(self "https://meet.jit.si")` (same for
  `microphone` / `display-capture`); `geolocation` stays fully denied. The allowlist is
  mirrored in `EMBEDDABLE_MEETING_HOSTS` (`src/lib/meetingLink.ts`) — widening one without
  the other yields an empty box or a call with no picture.

### Changed
- `isEmbeddableMeetingLink` moved from `meetingContext.ts` to a new import-free
  `src/lib/meetingLink.ts`, so client components can use it without pulling Prisma (or
  `node:crypto`) into the browser bundle. It now also requires `https:`.

## [0.40.5-beta] - 2026-08-03

### Added
- **`POST /api/meetings/instant` — start a meeting now and get the room back in the
  response** (#1052). `POST /api/meetings` answers `{ created }`, so a UI that wants to
  show or open the link has to re-fetch the list; that round trip is what makes "call this
  person" feel slow. The new endpoint always creates a time-less room (no RSVP, no
  reminder) and returns `{ meetingId, meetLink, invited }`. Invitees get an in-app
  notification unconditionally and an email when `emailAllowed(user, 'meetingReminders')`.
  Rate-limited to 10/min per IP — each call fans out invitations. The existing
  `POST /api/meetings` contract is untouched.
- **`Meeting` can hang off a project or a conversation, not only a mentorship** (#1051).
  `relationId` is now nullable and joined by `projectId` / `conversationId`. MySQL can't
  express "exactly one of three" as a CHECK, so the rule and the membership authorization
  live in `src/lib/meetingContext.ts` (`resolveMeetingContext`) and every write path goes
  through it: project meetings need an OWNER/MENTOR membership (or admin), conversation
  meetings need participation, relation meetings keep the mentor-scoped rule. The project
  lookup goes through `prisma.project` first because `Project` is a `TENANT_MODEL` and
  `ProjectMember` is not — querying members directly would reach across tenants.

### Changed
- Jitsi room generation moved out of the route into `generateMeetingLink()` so the two
  endpoints can't drift; `isEmbeddableMeetingLink()` joins it for the upcoming side panel.
- `GET /api/meetings`, `/api/calendar-events` and the meeting-reminder cron now filter on
  `relationId: { not: null }`, keeping their shape and behaviour identical now that the
  column is nullable.

## [0.40.4-beta] - 2026-08-03

### Fixed
- **Scheduled meetings landed at the wrong time for any organizer outside UTC** (#1061).
  The scheduler's split Date + Time inputs produce a bare wall clock
  (`"2026-08-03T16:30"`) with no zone, and it was POSTed as-is and read with
  `new Date()` on a server that runs UTC — so the string was taken to mean 16:30 **UTC**.
  An organizer in Germany (CEST, GMT+2) who picked 16:30 got a meeting stored at
  `16:30Z`, which the app and the reminder email then correctly rendered in their zone
  as **18:30**: every meeting silently jumped forward by the organizer's offset, and the
  invitees were told the wrong time. Fixed on both sides — `MeetingsManager` and
  `MeetingSchedulerPanel` now send a zone-qualified instant built from the viewer's own
  clock (`wallClockToInstantISO`), and `/api/meetings` + `/api/meeting-requests` no longer
  hand a bare wall clock to `new Date()`: `parseUserDateTime` anchors it to the
  organizer's saved `User.timezone` (→ `APP_TIMEZONE` → Europe/Istanbul), so API clients
  and browsers on a cached bundle are covered too. New `parseWallClockInZone` resolves the
  offset through `Intl`, iteratively, so DST is handled per date rather than assumed.
- As a side effect, **date-only meetings** (no clock time) are now stored at local midnight
  instead of UTC midnight, so they no longer show up on the previous day on the calendar for
  viewers west of UTC.
- Note: `Meeting` rows created *before* this fix keep their shifted `scheduledAt` — there is
  no reschedule/cancel path to correct them in place, and a blanket backfill can't tell a
  form-created row from a correctly-stored one (series occurrences and accepted meeting
  requests always were correct).

### Added
- `e2e/meeting-timezone.spec.ts` — schedules 16:30 in a `Europe/Berlin` browser and asserts
  the **stored instant** is `14:30Z`. Verified to fail (`16:30Z`) against the pre-fix code.

## [0.40.3-beta] - 2026-08-03

### Fixed
- **Three scheduled full-suite failures caused by the new selects** (#51 follow-up). The
  candidate page gained a "who referred them" picker and the project page gained the member
  pickers, and an `<option>` is text like any other: `getByText('Detail Mentor')` and
  `getByTestId('project-internal').getByText('Detail Member')` became strict-mode violations,
  while `locator('select').first()` on the candidate page stopped resolving to the stage
  dropdown (the profile card above it now has a select of its own). Fixed at the source
  rather than in the assertions alone — `data-testid="stage-select"`,
  `data-testid="referred-by-select"` and `data-testid="mentorship-mentor"` on the candidate
  page — and the three specs target those (the project one scopes to `project-team`).

## [0.40.2-beta] - 2026-08-02

### Fixed
- **Setting up a recurring meeting no longer mails everyone once per occurrence.**
  `generateForSeries` fills the calendar `weeksAhead` (default 7) and used to call
  `sendMeetingInviteEmail` inside the occurrence × relation loop — one click on "save"
  meant e.g. 6 mentees × 7 weeks = 42 near-identical invitations. Only the *next*
  occurrence is announced now; every later one is covered by the day-before and
  hour-before reminders. The response reports `invitesSent` alongside `createdMeetings`.
- **Series meetings were reminded twice.** `sendMeetingReminders()` (per relation, an hour
  before) and `sendProjectMeetingSeriesReminders()` (per project, a day and an hour before)
  both matched a series-generated `Meeting`, so anyone with both a relation and a membership
  got two hour-before emails. The per-relation job now skips `seriesId != null`; the
  project-level one is the single source for recurring meetings, and it reads the merged
  team (`loadProjectTeam`) so a mentee attached only through a relation is still reminded.
- **The project page had no header.** It lives outside the admin/mentor shell so a public
  visitor can read it, which meant opening a project on a phone replaced the app chrome with
  nothing — no title, and no way back other than a small text link. It carries its own brand
  bar now, linking to the viewer's own dashboard (or `/` when signed out).

## [0.40.1-beta] - 2026-08-02

### Changed
- **One project screen instead of two** (#51 follow-up). A project card carried its own
  half-view of the project — an editable flat task checklist and the expandable
  "Manage owners & mentors" panel — while `/projects/[id]` grew the team, the recurring
  meeting and per-person goals. An account that is both admin and mentor reaches the same
  list at `/admin/projects` and `/mentor/projects`, so the two views alternated depending on
  where you came from. The card is now a summary (roster, progress, links) and everything
  about one project lives on its page: `ProjectMembersPanel` moved there, the card's members
  icon links to it, and the card's task checklist is gone (goals belong to a person now, and
  keeping an editable copy in the card guaranteed the two would disagree).

### Fixed
- **Phone layout of the project screens.** The card's "add a task" box shared a row with its
  button and collapsed to a few pixels wide at 390px — the widest instance of a pattern that
  also affected the goal composer, the recurring-meeting form, the member pickers and the
  referral link box. Those rows now stack below `sm`, long goal titles wrap, and the project
  page uses phone-sized padding. `e2e/mobile-responsive.spec.ts` locks it down mechanically:
  no horizontal overflow and no text field under 120px, with the collapsible forms expanded.
- `PATCH /api/projects/[id]/join-requests` answers 404 instead of 500 when the request is
  already gone (a double-clicked *Approve* hit Prisma's P2025).

## [0.40.0-beta] - 2026-08-02

### Added
- **Project teams are read from the membership table, with roles** (#51). `src/lib/projectTeam.ts`
  merges `ProjectMember` (the canonical table since #617) with the legacy
  `MentorshipRelation.projectId` rows into one roster and derives the intern count from it.
  The admin/mentor cards, the project detail page and the group chat all consume it, and each
  name carries its functional role (developer / tester / marketing).
- **Project members get the internal view of their own project.** `canViewProject` only ever
  considered ownership and the public flag, so a mentee added to a project saw the anonymous
  visitor page (three links and an intern count) and a *private* project was invisible to them
  entirely. Membership is now a read right: `GET /api/projects/[id]`, the `MENTEE` project scope
  in `authzScope.ts` and `/projects/[id]` all accept it, and `GET /api/projects` strips names only
  for projects the caller is *not* on.
- **Recurring project meetings are visible and manageable** (`ProjectWeeklyMeeting`). `MeetingSeries`
  and its API landed in #774 but nothing ever rendered them — there was no field anywhere saying
  "the weekly call is Mon+Thu 09:30, link here". Adds `GET /api/meeting-series?projectId=`
  (member-readable) plus a day/time/link editor for owners.
- **Reminders for the recurring meeting go to the whole project.** `sendProjectMeetingSeriesReminders()`
  drives off the series rule instead of the per-relation `Meeting` rows (most project members have no
  `MentorshipRelation` carrying the project), at two lead times — a day before and an hour before.
  Idempotency is a new `MeetingSeriesReminder` row per `(series, occurrence, lead)`, claimed before
  anything is sent. Honors `emailAllowed(user, 'meetingReminders')`; in-app notifications are
  unconditional as everywhere else.
- **Goals belong to people** (`ProjectTask.assigneeId`, `doneAt`). A member sees their own goals and
  ticks them off, an unassigned goal can be claimed ("üstlen") or handed over by a lead. Renaming and
  assigning to someone else stay owner-only; a mentee can only delete their own goal.
- **A goal-template pool** (`ProjectTaskTemplate`): every goal written on a project is captured, the
  pool is backfilled from pre-existing tasks on first read, and a lead sends any selection to a new
  member in one call (`POST /api/projects/[id]/tasks` with `templateIds`).
- **Join requests for public projects** (`ProjectJoinRequest` + `/api/projects/[id]/join-requests`).
  Anyone signed in may ask; the owner or an admin approves, which is what creates the `ProjectMember`
  row (with the requested functional role) and pulls them into the group chat. Owners are notified
  in-app and by email (`mentorship` category).
- **Group chats say who is in them.** `GET /api/messages?conversationId=` now returns the conversation
  type, its project and each participant's project role, and the thread header lists them with a link
  back to the project.
- **Shortcuts**: "message the owner" and "group chat" on a project, "send a message" and (for admins)
  "login as" on a person's profile.
- **Invitations can connect people on registration** — `InvitationToken` gained `invitedById`,
  `mentorId`, `menteeId` and `projectId`. An admin picks the counterpart in the invite form and the
  mentorship (and project membership) exists the moment the invitee registers, which is what a
  mentor's own invite has always done. Mentors and mentees may now create invitations too, limited to
  the roles they are allowed to invite.
- **Personal referral links** (`User.referralCode`, `/api/referral`, `/auth/register?ref=`): mentees,
  mentors and admins each get a shareable link, and whoever registers through it is recorded in
  `User.referredById`. Admins can also set that pointer by hand on a candidate — any person, not only
  a `Source` row, can be the source.
- **A mentor-side onboarding wizard** for a newly joined mentee (`MenteeOnboarding`,
  `/api/mentee-onboarding`, shown on the mentor dashboard). Steps the app can observe — a first
  message, a booked meeting, project membership, assigned goals, a pipeline move — tick themselves; a
  stored tick covers what happened outside the app.

### Changed
- `GET /api/invite` returns the caller's own invitations for non-admins (admins still see all).
- `MeetingSeries` list/read is available to project members, not just managers.

### Fixed
- `ensureReferralCode` only retries on a genuine unique collision (`P2002`) and returns null for a
  deleted account, instead of looping five times and reporting "could not allocate a referral code".

## [0.39.1-beta] - 2026-08-02

### Fixed
- **Impersonated sessions can no longer change the account holder's second factor**
  (#1039). `POST /api/account/2fa` had no impersonation guard, so an admin using
  "Login as" could run `setup`/`enable` — enrolling an authenticator the owner does not
  hold, which outlives the 30-minute impersonation window — or `disable`, stripping the
  factor that protects the owner from that same admin. Both were written to the activity
  log as the *user* (`actorId: session.user.id`), so the audit trail named the wrong
  person. The route now 400s on POST while `session.user.impersonatorId` is set, matching
  `/api/account`. GET (read-only status) stays available.
- **`POST /api/account/sign-out-all` is refused while impersonating** too, for the same
  reasons plus one of its own: it stamped `sessionsValidFrom` on the impersonated user,
  which revoked the impersonation session along with the user's, dropping the admin at
  the sign-in page as if they had been signed out. An admin who needs to lock someone out
  uses `POST /api/admin/users/[id]/reset-password`, which is audited under their own id.

### Changed
- The two-factor and sessions cards are hidden on `/account` during impersonation, and
  the impersonation notice now names all four disabled actions and points at the
  admin-side password reset. Same treatment the credential/delete cards got in #1036 —
  a card whose endpoint 400s is a trap, not a feature.
- `/security-setup` (the org 2FA enforcement gate) redirects home during impersonation
  instead of rendering an enrolment form the endpoint now refuses. The role layouts
  already skipped the gate there; only hand-typing the URL could reach it.

## [0.39.0-beta] - 2026-08-02

### Added
- **Admin-side account deletion from the user list** (`/admin/users`). Every non-admin
  row gets an "Erase account" action that opens the erasure panel inline;
  `POST /api/admin/users/[id]/erase` backs both it and the candidate danger zone. This
  is the answer to "how does an admin delete someone else's account?" — previously the
  only account-deletion UI was the self-service one, which asks for the account
  holder's own password and refuses to run inside an impersonation session.
- **Step-up authentication on admin erasure**: the endpoint now requires the acting
  admin's OWN password (`adminPassword`, bcrypt-compared against their row) on top of
  the existing "type the target's exact full name" gate. The name is a misclick guard,
  not authentication — without a password check, a hijacked admin session could erase
  accounts silently. It is deliberately never the target's password: no admin can know
  that one.

### Changed
- The erase endpoint accepts every role except `ADMIN` (was: `MENTEE` only). Admin
  targets are refused with a clear message — demote the account first, or let its owner
  delete it — which also keeps the last admin account from disappearing. Anonymize
  stays candidate-only, since preserving pipeline history only means something there.
  Self-targeting is refused too, and an impersonation session is rejected outright so
  an erasure can never be attributed to a merely-impersonated admin.
- Audit action renamed `candidate.erase.*` → `user.erase.*` (nothing consumed the old
  names) and now records the target's role + name in `detail` plus the request IP/UA —
  after a hard delete the log line is the only remaining trace of the account.
- `hardDeleteUser` detaches the three user references that neither cascade nor were
  cleaned up (`SupportTicket.assignedAdminId`, `MentorshipRequest.decidedById`,
  `Project.ownerUserId`). They belong to the org rather than the user, and left in
  place they aborted the delete with an opaque FK error — reachable from the
  self-service delete too, not just the new admin path.
- `CandidateEraseDangerZone` now wraps the shared `UserEraseForm` (same
  `data-testid="erasure-confirm-name"`, new `data-testid="erasure-admin-password"`),
  so the candidate page and the user list can't drift apart.

## [0.38.4-beta] - 2026-08-02

### Fixed
- **The account page offered credential changes and account deletion inside an
  impersonation session, where the API refuses all three.** `/api/account` PUT and
  DELETE both bail out with 400 when `session.user.impersonatorId` is set, but
  `AccountSettings` rendered the e-mail card, the password card and the "Delete
  account" danger zone regardless. An admin who opened a user's account settings to
  delete it was asked for "current password" — a password only the account holder
  knows, and one the endpoint would have rejected anyway. The three cards are now
  hidden while impersonating and replaced by a notice
  (`data-testid="impersonation-account-notice"`) pointing at the admin path;
  the danger zone carries `data-testid="delete-account-card"` so the e2e spec can
  assert its absence. Nothing changes for a user in their own session.

## [0.38.3-beta] - 2026-08-02

### Fixed
- **The impersonation banner disappeared on the screens that have no app shell.**
  "You are viewing the app as …" + "Return to your account" was rendered by
  `ResponsiveShell`, so it existed only on the role-scoped areas (/admin, /mentor,
  /portal, /company, /source). Open Messages — or /account, /notifications,
  /announcements, which render their own chrome — and the bar was simply gone: no
  warning that the session belongs to someone else, and no way back except typing an
  admin URL by hand. The banner now renders once app-wide in `Providers`, above every
  page shell, as a sticky full-width strip (`data-testid="impersonation-banner"`), and
  `ResponsiveShell` no longer renders its own copy.
- The strip is in normal flow, which the viewport-sized chat frame (`MessagesShell`,
  `100dvh`) cannot see, so it would have pushed the composer below the fold. New
  `useTopBannerInset` hook publishes the strip's measured height as
  `--top-banner-inset` (mirror of `--fixed-bottom-inset`/#935) and the frame subtracts
  it from both its height and its `--visible-viewport-height` clamp.
- `e2e/impersonation.spec.ts` now asserts the banner on /messages and /account and
  returns to the admin account from a shell-less screen.

## [0.38.2-beta] - 2026-08-02

### Fixed
- **Meeting reminder emails printed the wrong time.** A meeting the app showed at
  09:00 arrived as "07:00" in the reminder. The instant stored in the DB was right
  the whole time; the *rendering* was not. Emails and the stored text of in-app
  notifications are produced server-side, where `toLocaleString()` without a
  `timeZone` falls back to the process zone — and the container runs on UTC. So
  every recipient read every meeting time on the UTC clock while the browser
  showed it on theirs. Server-rendered times now name an explicit zone
  (`src/lib/timezone.ts`): the recipient's saved `User.timezone`, else
  `APP_TIMEZONE`, else `Europe/Istanbul` — and carry a `(GMT+3)`-style suffix so a
  time is never ambiguous across zones. Applies to the meeting reminder, the
  meeting invite, the meeting request and the request-decision emails; the
  reminder resolves the zone per participant, so a mentor and a mentee in
  different zones each read their own clock.

### Added
- **The browser's timezone is captured for profiles that have none**
  (`TimezoneSync` → `POST /api/profile/timezone`, once per browser session). Only
  the mentee profile form exposes a zone picker, so mentors and admins had no zone
  at all and would have kept reading times on the deployment default. The endpoint
  fills the field **only when it is empty** — an explicitly chosen zone is never
  overwritten — and ignores impersonated sessions.

## [0.38.1-beta] - 2026-08-01

### Fixed
- **Availability: the "Add" button did nothing for admins.** `POST /api/availability`
  has always accepted ADMINs — they reach the mentor shell through the view switch
  added in 0.37.0-beta — but `GET` only defaulted `mentorId` to the session user when
  the role was `MENTOR`, and returned `{ slots: [] }` for everyone else. So an admin's
  slot was created (201), the page reloaded the list, got nothing back, and stayed on
  "Your slots (0)": a silent write with no visible effect. `GET` without `?mentorId=`
  now means "my own slots" for any role, matching what `POST` writes. Regression test
  drives the page through the UI (`e2e/calendar.spec.ts`) — the existing mentor test
  hits the API only and passed the entire time this was broken.

## [0.38.0-beta] - 2026-08-01

### Added
- **An evaluation can be deleted** (`DELETE /api/evaluations/[id]`, trash icon in
  `EvaluationPanel`). Until now a mis-clicked rating was permanent: the panel only ever
  appended, and there was no route to remove a row. Only the evaluation's **own author**
  (or an ADMIN) may delete it — an evaluation is the author's judgement, so the other
  side of the relation cannot erase one written about them. The list endpoint now returns
  a `canDelete` flag per evaluation so the button only appears where the DELETE route
  would actually allow it, and the deletion is recorded in the activity log
  (`evaluation.deleted`).

## [0.37.0-beta] - 2026-08-01

### Added
- **A view switch for admins who also mentor** (`ModeSwitcher`, pinned above the account
  menu in both the admin and the mentor shell, `ADMIN`-only). An admin was already
  *allowed* into `/mentor/*` — the mentor layout's role check has always accepted `ADMIN`
  — but nothing in the UI led there, so the only way in was to follow a link that happened
  to point at it (a reminder notification, say), and the entire shell would change with no
  visible cause. Now it is a deliberate, reversible control, and the active segment
  doubles as the "why does this look different" marker that was missing.
- The switch **keeps your place**: sections that exist in both shells map 1:1
  (`/admin/board` ⇄ `/mentor/board`, and the same for projects, meetings, calendar,
  email, mentee-activity, analytics), `candidates`/`mentorship` map to `mentees` and back,
  and anything without a counterpart falls back to the target dashboard rather than
  guessing (`src/lib/appMode.ts`).

### Notes
- The mode is **derived from the URL**, never stored. A persisted flag is exactly what
  would let the sidebar, the page and the address bar disagree after an inbound link drops
  an admin into the other shell — the bug this feature grew out of. No schema change, no
  session change, no new API surface: an admin in mentor view is just an admin on a
  `/mentor` route, with the same per-mentor data scoping (`where: { mentorId }`) every
  mentor page already applies.

## [0.36.0-beta] - 2026-08-01

### Added
- **Mentors get global search too.** `GlobalSearch` (previously admin-only) is now also
  in the `/mentor` header. `GET /api/search` already scoped mentor results to their own
  mentees (`menteeRelations: { some: { mentorId } }`); it now also returns each hit's
  `relationId`, so a mentor's search result opens `/mentor/mentees/<relationId>` instead
  of the admin candidate route. Admin search behaviour and response shape are unchanged.
  Input gained `data-testid="global-search-input"`.

## [0.35.3-beta] - 2026-08-01

### Added
- **An announcement image can be pasted** into the message box, not only picked from
  disk (`/admin/announcements`). A screenshot is the most common thing attached to a
  broadcast, and "save to disk, then browse for it" was pure friction. Same gesture and
  same implementation shape as the message composer (`MessageThreadView`): the paste
  handler takes the first `image/*` item off `clipboardData`, renames it (clipboard
  images all arrive as `image.png`), and runs it through the *existing* `pickImage()`,
  so a pasted file gets exactly the same type/size/signature validation as a picked
  one. A paste carrying no image is left alone — it is not `preventDefault`-ed, so
  ordinary text paste keeps working.

## [0.35.2-beta] - 2026-08-01

### Fixed
- **The chat frame's bottom edge now lands on the *visible* bottom** (#1009). Follow-up
  to #1006, reported from an installed PWA on Android: the end of the composer (and the
  last row of the inbox) sat behind the system navigation bar and could not be scrolled
  into view. `100dvh` is the *layout* viewport, and an edge-to-edge PWA draws behind the
  navigation bar, so it is ~48px taller than what you can see — and since the frame
  fits `100dvh` exactly, the document has no overflow either, which is why nothing
  scrolled. Two independent corrections, neither of which does anything when there is
  nothing hidden:
  - The frame subtracts `env(safe-area-inset-bottom)`, and `/messages` opts into real
    inset values with a **route-scoped** `viewport-fit=cover` (`viewport` export in
    `src/app/messages/layout.tsx`, so no other route changes behaviour). The header
    picks up `env(safe-area-inset-top)` and the frame the left/right insets for
    landscape notches. `max(--fixed-bottom-inset, env(safe-area-inset-bottom))` rather
    than a sum — the cookie banner already pads itself past the inset (#935), so
    subtracting both would leave a gap above it.
  - New `useVisibleViewportHeight` publishes `min(innerHeight, visualViewport.height)`
    as `--visible-viewport-height`, which the frame applies as a **`max-height`
    clamp**. Being a clamp and not a second subtraction is the point: if both signals
    report the same hidden strip, the smaller one simply wins instead of the strip
    being deducted twice. Pinch-zoom (`scale > 1.01`) is ignored, and the clamp also
    tracks the on-screen keyboard.
- `e2e/mobile-chat-layout.spec.ts` grew two assertions: the frame's height equals the
  visible height (a malformed `calc()` shows up immediately), and — reproducing the
  reported condition through the same signal the shell listens to — with 48px of the
  viewport hidden the whole composer still fits inside what is left. Negative control:
  without the clamp the send button sits 630px into a 616px visible area. A third test
  pins the `viewport-fit=cover` scoping (present on `/messages`, absent on `/mentor`).

## [0.35.1-beta] - 2026-08-01

### Changed
- **Chat screens are a real app shell on a phone** (#1006). A thread was a plain
  document: the page title, the bubble list (its own `max-h-[55vh]` scroller) and the
  composer all scrolled *together*, so on an iPhone 13 the document overflowed by
  ~1200px and writing a reply meant scrolling the page down while the bubbles scrolled
  up — two nested scrolls for one conversation.
  - New `MessagesShell` (used by `/messages/layout.tsx`) is, below `lg:`, a fixed-height
    flex column — `calc(100dvh - var(--fixed-bottom-inset))`, so it also shrinks around
    the cookie banner from #935 — with the content area as `min-h-0 flex-1`. The thread,
    the support chat and the inbox fill that area; the bubble list is the only scroller
    (`overscroll-contain`), the composer never moves, and the document does not scroll
    at all. Desktop keeps the previous document flow and the `55vh` bubble box.
  - The shell also renders the **mobile header** the message screens never had: a back
    arrow (to the inbox, or to the role home when already there), the thread's title —
    the person you are talking to — and a home shortcut. There is no sidebar below
    `lg:`, so the browser's back button used to be the only way out.
  - The pages drop their own heading on mobile (the header is the `<h1>` there), which
    is what buys the list its space back. Rendered via `useIsNarrow()` rather than
    `lg:hidden` so only one variant is ever in the DOM (strict-mode locators).
  - `viewport.interactiveWidget = 'resizes-content'`: the on-screen keyboard now shrinks
    the layout viewport instead of overlaying it, so a full-height screen keeps its
    composer above the keyboard.
  - New `e2e/mobile-chat-layout.spec.ts` asserts it geometrically at 390×664 (document
    overflow ≤ 1px, composer on screen and clickable, the list is the scroller and stays
    pinned to the newest message) plus header navigation, and that desktop still shows
    the page heading. Verified by negative control: with the old document flow the same
    spec reports 1208px of overflow.

## [0.35.0-beta] - 2026-08-01

### Added
- **Announcements can carry an image.** The admin composer at `/admin/announcements`
  gets an optional picker (PNG/JPEG/WebP/GIF, up to 5 MB) with a local preview, and
  the image is rendered on `/announcements`, in the dashboard `AnnouncementsCard`
  (as a thumbnail) and in the admin history list. Stored in the DB as a new
  `AnnouncementImage` row — the same approach as `AvatarFile`/`CvFile`, so it
  survives container redeploys — and served from `/api/announcements/<id>/image`
  behind an authenticated session, with `nosniff`. No `imageUrl` column: the URL is
  a pure function of the announcement id, so mirroring it would only add a second
  write that can disagree with reality.
- `POST /api/admin/announcements` now accepts `multipart/form-data` in addition to
  JSON (the JSON contract is unchanged, so existing API clients and specs keep
  working). When "also send by email" is checked, the image travels as an **inline
  `cid:` attachment** — the serving route needs a session, so a URL would have
  rendered as a broken image in every mail client. `sendEmail`'s `attachments`
  therefore accept an optional `cid`.
- Uploads are validated against a single source of truth (`src/lib/announcementImage.ts`)
  on both the client and the server, so a rejected file is reported at the picker
  rather than as a bare 400 after Broadcast. SVG is deliberately excluded (it can
  carry `<script>`, and the blob is served from our own origin), and the content
  signature is checked with the shared `contentMatchesType()` from `src/lib/fileType.ts`
  (#888) — so a file that merely *claims* to be a PNG is refused, in the same words as
  every other upload route, before any notification fan-out happens.

## [0.34.0-beta] - 2026-07-31

Both halves of the "mobile first impression" story (#898): the two touchpoints a
mentee and a mentor actually hit on a phone.

### Added
- **The pipeline board is usable on a phone** (#936). It is the mentor's main tool for
  stage management, and on a phone it was unusable: 13 stage columns scrolled sideways
  (only ~1.2 fit at 390px) and drag-and-drop — a gesture touch never fires — was the
  only way to change a stage. The mentor board had no alternative at all; the admin
  board already had a per-card select, so half of this is parity.
  - Below `lg:` both boards render a **stage filter plus a single-column list** instead
    of the kanban (`BoardStageFilter`, `data-testid="board-stage-filter"`). Stages come
    from the same `useResolvedStages()` source, so custom org stages appear in the
    filter and the picker. `useIsNarrow()` picks *one* of the two layouts rather than
    rendering both behind `lg:hidden` — that would put every card in the DOM twice and
    break strict-mode locators.
  - Every card carries the shared `CardStageSelect` (`aria-label="Move to stage"`), so
    a stage change works by touch **and** by keyboard on both boards. Desktop
    drag-and-drop is untouched. The mentee name is now a real link, so a card is
    reachable and openable with the keyboard instead of click-only.
  - A stage change offers **Undo** in the toast for 7s — a mis-tap is easy on a phone
    and was previously only fixable with another move. `Toast` gained an optional
    action for this; `moveTo` reads the live relation list through a ref, because the
    toast callback runs long after the render that created it (with the closed-over
    state, undo silently no-op'd).
  - The phone filter is **pinned** once data loads. Deriving it from "first stage with
    items" on every render made the view follow a card into its new stage, so you never
    saw it leave the stage you were looking at.
  - Both board pages tag their desktop layout `data-testid="board-columns"` and their
    cards `data-testid="board-card"`.

Both halves of the "mobile first impression" story (#898): the two touchpoints a
mentee and a mentor actually hit on a phone.

### Added
- **The pipeline board is usable on a phone** (#936). It is the mentor's main tool for
  stage management, and on a phone it was unusable: 13 stage columns scrolled sideways
  (only ~1.2 fit at 390px) and drag-and-drop — a gesture touch never fires — was the
  only way to change a stage. The mentor board had no alternative at all; the admin
  board already had a per-card select, so half of this is parity.
  - Below `lg:` both boards render a **stage filter plus a single-column list** instead
    of the kanban (`BoardStageFilter`, `data-testid="board-stage-filter"`). Stages come
    from the same `useResolvedStages()` source, so custom org stages appear in the
    filter and the picker. `useIsNarrow()` picks *one* of the two layouts rather than
    rendering both behind `lg:hidden` — that would put every card in the DOM twice and
    break strict-mode locators.
  - Every card carries the shared `CardStageSelect` (`aria-label="Move to stage"`), so
    a stage change works by touch **and** by keyboard on both boards. Desktop
    drag-and-drop is untouched. The mentee name is now a real link, so a card is
    reachable and openable with the keyboard instead of click-only.
  - A stage change offers **Undo** in the toast for 7s — a mis-tap is easy on a phone
    and was previously only fixable with another move. `Toast` gained an optional
    action for this; `moveTo` reads the live relation list through a ref, because the
    toast callback runs long after the render that created it (with the closed-over
    state, undo silently no-op'd).
  - The phone filter is **pinned** once data loads. Deriving it from "first stage with
    items" on every render made the view follow a card into its new stage, so you never
    saw it leave the stage you were looking at.
  - Both board pages tag their desktop layout `data-testid="board-columns"` and their
    cards `data-testid="board-card"`.

### Fixed
- **No horizontal overflow at 320px** (#936). The app-shell mobile top bar was 2px
  wider than the screen: the hamburger's `-mr-2` pushed it past the bar's `px-4`, and
  the wordmark + beta badge + three icon buttons could not shrink. The wordmark
  truncates now and the icon group is `flex-shrink-0`. Affects every role's mobile
  header, not just the board.
- **`e2e/board-a11y.spec.ts`** scoped its stage select to its own card. The admin board
  lists every relation in the database, so the unscoped `getByLabel('Move to stage')`
  broke (strict-mode, 2 elements) as soon as any other relation shared the stage —
  latent flake, hit locally on the first run.
- **Fixed bottom bars no longer cover page content on phones** (#935) — the cookie
  banner is `fixed bottom-0`, and nothing reserved space for it, so on an iPhone 13
  (390×664) it filled 40% of the viewport and painted over the *"Create Account"*
  button on `/auth/register`: the first action in the product could not be completed
  without dismissing the banner first.
  - New `useFixedBottomInset(ref, active)` hook (`src/hooks/`): each fixed bottom bar
    publishes its measured height (ResizeObserver, so a re-wrapped banner re-measures)
    and the tallest one lands on `<html>` as `--fixed-bottom-inset`. `globals.css`
    turns that into `body { padding-bottom }`, so the document grows and the content
    scrolls above the bar; the inset returns to `0px` when the bar unmounts, leaving
    no leftover gap. Deliberately shared so the mobile quick-action bar (#917) can
    reuse it instead of inventing a second mechanism.
  - The banner itself is more compact on small screens: tighter padding, body text
    clamped to two lines below `sm:` (full sentence from `sm:` up — no new strings, so
    EN/TR/DE stay in parity), and the three buttons in one `grid-cols-3` row instead
    of wrapping to a second line. Desktop markup is unchanged.
  - Safe-area support: the banner's bottom padding is
    `max(0.75rem, env(safe-area-inset-bottom))`. Note the app does not set
    `viewport-fit=cover`, so `env()` currently resolves to `0` — this is future-proofing
    for when it does, not a live change.
  - New `e2e/mobile-fixed-bars.spec.ts` — geometric (`boundingBox`) assertions rather
    than screenshots: on `/auth/register`, `/auth/signin` and `/portal`, scrolling to
    the bottom of the document leaves the primary action (and the whole `main` content
    area) above the banner; the register CTA also survives a real `click()`, which
    Playwright rejects when another element is on top of it; and dismissing the banner
    drops the body inset back to `0px`.

## [0.33.2-beta] - 2026-07-31

### Security
- **Open dependency advisories cut from 10 (1 critical, 7 high) to 5 (2 high, 3
  moderate)** (#882). Closed: `js-yaml` (quadratic-CPU DoS via merge keys),
  `brace-expansion` (exponential expansion), `next` 15.5.14 → 15.5.22 (middleware/
  proxy bypass, cache poisoning, image-optimisation DoS — the middleware advisories
  matter here because `src/middleware.ts` *is* a security control), `postcss`
  (arbitrary file read via `sourceMappingURL`) and `sharp` (four libvips CVEs).
  `next-auth`'s critical cleared with them.
  **`npm audit` was misleading on three of these.** It reported `fixAvailable: true`
  for next/postcss/sharp, but the "fix" it had in mind was downgrading to `next@9.3.3`
  — Next pins `postcss@8.4.31` and `sharp@0.34.5` exactly, and **Next 16.2.12 pins the
  same two** (verified by building against it). A major jump would not have closed
  them; `overrides` was the only real fix. `postcss` is also a direct devDependency,
  and npm refuses an override that conflicts with one, so its direct range moved to
  `^8.5.18` first. The remaining five need major upgrades or have no published patch,
  and each is written up with its exploitability in `docs/security-exceptions.md`.

### Added
- **`.github/workflows/security-audit.yml`** (#885) — `npm audit` on every PR, on
  `main`, and weekly, with a severity table in the job summary. It fails only on
  `critical`: the remaining `high` findings have no non-major fix today, and a gate
  that is always red is one everyone learns to scroll past. Tightening it to `high`
  is a one-word change once those land.
- **`.github/dependabot.yml`** (#885) — weekly npm updates grouped into a single
  minor/patch PR (twenty near-identical bumps is how a review queue starts getting
  ignored) and monthly GitHub Actions updates. Majors are ignored on purpose: they
  land as deliberate, tested work, not as an automated PR.
- **`docs/security-exceptions.md`** — the accepted findings, each with why it can't
  be fixed, whether it is reachable *in this application* (naming the code path, not
  just the advisory), and what the permanent fix is.

### Fixed
- **Talent-pool empty states now distinguish loading, no search results and an empty pool.**
  The company talent pool keeps its existing skeleton while loading, shows filter guidance
  when a search has no matches, and explains when no candidates have made their profiles
  public yet. Both empty states reuse the shared, dark-mode-safe `EmptyState` pattern and
  expose `data-testid="talent-pool-empty-state"` for stable UI checks.

## [0.33.1-beta] - 2026-07-31

### Added

- **The role × endpoint read matrix is now executable** (#899).
  `e2e/fixtures/authz-matrix.ts` declares, per role and per endpoint, whether the
  answer should be `all`, `own` or `deny`; `e2e/authz-matrix.spec.ts` (`@smoke`)
  enforces it. Crucially an `own` cell asserts **ownership of every row returned**,
  not the status code — the original leak answered `200` throughout, so a
  status-only test would have passed against it. The audit's worst finding survived
  a *closed* RBAC epic (#278) precisely because nothing executable said "this role
  must not see that".
- **`.github/workflows/codeql.yml`** (#903) — static analysis on PRs, pushes to
  `main`, and weekly, with the `security-extended` query set. Not a required check:
  the first run on an existing codebase always surfaces a backlog, and blocking every
  PR on triage that hasn't happened teaches people to ignore the gate. CodeQL cannot
  see role-scoping bugs — that is what the matrix spec above is for; the two are
  complements.

### Documentation
- **`SECURITY.md` now leads with a disclosure policy** (#901) — the file previously
  described the security *model* and offered two lines on reporting ("email the
  maintainer"). It now opens with GitHub private vulnerability reporting, response
  targets, scope, and explicit limits for researchers (no load testing against live,
  no touching real user data — the same line `docs/DATA_ACCESS_POLICY.md` draws for
  contributors). The security overview follows underneath, unchanged.

## [0.33.0-beta] - 2026-07-31

### Fixed
- **A reply sent from any address other than the one on your profile was silently
  dropped.** Found on live traffic hours after the mail bridge shipped: a reply to
  a notification never appeared in its thread. The bridge had done everything
  right — mail fetched, token verified — and then refused it, because
  `routeInboundEmail` identified the writer *only* by matching `From` against a
  participant's account email. The notification had gone to the mentor's
  `@bcsit-gmbh.de` address, which forwards to Gmail; replying from there put a
  `@gmail.com` address in `From`, so the reply was rejected with
  `403 Sender is not a participant`. Reproduced against production with the real
  token. Anyone whose mail forwards — which is most people — hit this.
  - The reply token now names the **recipient** as well as the thread:
    `reply+<relationId>~<recipientUserId>.<hmac>`. When `From` matches a
    participant that still wins; otherwise the reply is attributed to the user the
    token was minted for, provided they are a participant. Logged when the weaker
    signal is used.
  - Not a weakening of the gate: the token is delivered only to that user's own
    registered address, and whoever holds that mail can already take the account
    over via a password reset, so this grants no new access. The residual exposure
    is a *forwarded* notification — the recipient of the forward can post as the
    original addressee. The fallback stays bounded to the token's own recipient: a
    signed token naming a non-participant is still refused.
  - Tokens already sitting in delivered mail carry a bare `relationId`; they keep
    verifying and fall back to `From` matching only.
  - `src/app/api/mentor/email/route.ts` now selects `mentee.id` so it can scope the
    token it mints.
- `e2e/inbound-email.spec.ts` covers all four paths: legacy token + participant,
  legacy token + stranger (403), scoped token from an unknown address (threaded,
  attributed to the token's user), and a scoped token naming an outsider (403).
## [0.32.4-beta] - 2026-07-31

### Added
- **Code of Conduct, in three languages.** The repository had a README, licence,
  contributing guide and security policy but no code of conduct — the one GitHub
  community-standards item still missing. `CODE_OF_CONDUCT.md` (English) plus
  [`docs/code-of-conduct.tr.md`](docs/code-of-conduct.tr.md) and
  [`docs/code-of-conduct.de.md`](docs/code-of-conduct.de.md) cover contributors
  *and* platform participants: the pledge, expected/unacceptable behaviour, scope,
  a confidential reporting route (`ersahin@bcsit-gmbh.de`) and a four-step
  enforcement ladder. Written for this project rather than dropped in verbatim —
  it names the two things a generic template misses here, the power asymmetry in
  the mentor ↔ mentee relationship and the misuse of role-granted access to
  mentee PII. Linked from `README.md` and `CONTRIBUTING.md`.
- **`/code-of-conduct` page** — the participant-facing summary of the same rules,
  fully translated via the `codeOfConduct` dictionary block (EN/TR/DE) and linked
  from the landing-page footer next to Privacy and Terms. Reporting is worded
  against "an administrator of this instance" rather than a hard-coded address,
  since every deployment has its own operator; the page links out to the full
  repository version for contributors.

## [0.32.3-beta] - 2026-07-31

### Fixed
- **"New chat" picker was empty for anyone in a project** — a regression from the
  project group chats landing in the inbox. `/messages` builds the set of people the
  viewer already has a DM with in order to exclude them from the picker, and that set
  was taken from *all* the viewer's conversations. Since every project co-member is
  also a participant of the shared project's GROUP chat, every candidate matched the
  exclusion, `candidates` came out empty and `StartConversationPicker` rendered
  `null` — so the "new chat" toggle disappeared entirely and no project DM could be
  started from the UI. The exclusion set is now built from `DIRECT` conversations
  only. Caught by `e2e/project-dm.spec.ts` in the scheduled full run.

### Changed
- The `E2E Tests` workflow takes an optional `grep` input on manual dispatch
  (default `@smoke`), so a single non-smoke spec can be re-verified on a branch
  without dispatching the 4-shard `e2e-full` suite and its summary email.

## [0.32.2-beta] - 2026-07-31

### Security
- **Upload validation trusted the client's word about the file type** (#888). Every
  route checked `file.type`, which is a multipart header the client writes; the bytes
  were never looked at. That matters more here than usual because the declared type
  is *stored* and returned on download — a mislabelled file arrives on an employer's
  machine wearing the word "CV". `src/lib/fileType.ts` now checks the content
  signature (dependency-free — a sniffing library would be one more parser inside the
  trust boundary) on CV, avatar, document and message-attachment uploads. DOCX and
  XLSX are both ZIP containers and cannot be told apart by signature, so the check is
  "the bytes are a ZIP", not more: rejecting legitimate Office files would be the
  worse failure. Support attachments already did this and are untouched.
- **Stored uploads were served `inline` with a barely-sanitised filename** (#890).
  CVs, documents and non-image message attachments now download as `attachment`
  instead of rendering on our own origin; `src/lib/download.ts` strips control
  characters (a `\r\n` in a name could have split the header), quotes, backslashes
  and semicolons, bounds the length, and adds `filename*=UTF-8''…` so a Turkish CV
  name survives the trip. Every file route now carries its own
  `X-Content-Type-Options: nosniff` — the global one in `next.config.js` still
  applies, this is the layer that survives a change to it. Avatars and images in a
  message thread stay `inline`: the UI renders them.

## [0.32.1-beta] - 2026-07-31

### Security
- **Webhook URLs were called from the server with no restriction (SSRF)** (#893).
  Validation was `z.string().url()`, which happily accepts `http://127.0.0.1:3306`
  and `http://169.254.169.254/latest/meta-data/` — the database and the cloud
  metadata service, both reachable from the server's network position but not from
  the admin's browser. `src/lib/ssrfGuard.ts` now requires https, no embedded
  credentials, and a hostname that **resolves** to a public address (every answer
  checked, not just the first — one private record is enough for a resolver to hand
  `fetch` the internal one). Checked at registration *and* again at delivery: DNS
  moves, and rows created before the guard existed were never checked at all. The
  HMAC signature was never the problem and is untouched.
- **`/api/health` told anonymous callers the version and git sha** (#897) — a
  ready-made answer to "which CVEs apply to this deployment?". Setting `HEALTH_TOKEN`
  narrows the anonymous response to `{ status, timestamp }` (all an uptime monitor
  acts on) and releases the detail only to an admin session or a caller sending
  `X-Health-Token`. **With the token unset the response is unchanged** — a
  fail-closed default would blind the production and preview deploy drift gates,
  which read `sha` from this endpoint, the moment it merged. `infra/deploy-prod.sh`
  and both gates now send the header when the server env has it, so turning it on is
  a one-variable change.

### Fixed
- **Outgoing HTTP had no timeouts** (#895). Webhook delivery ran under `Promise.all`
  with no deadline, so one unresponsive receiver stalled the whole batch and held the
  request handler open indefinitely — now 5s. The Anthropic SDK's default is 10
  minutes, long enough for a user to give up first; the five AI clients now pass 60s,
  which fits how long generation actually takes. `dispatchWebhook` still never throws:
  an abort lands in the existing catch and is logged like any other delivery failure.

## [0.32.0-beta] - 2026-07-31

### Security
- **Admin password reset handed out a live reset link and left no trace** (#875).
  `POST /api/admin/users/[id]/reset-password` returned `resetUrl` in the response body
  — so an account could be taken over with no access to the target's mailbox at all,
  and the credential landed in reverse-proxy logs, browser devtools and any
  screen-share. It also had **no target restriction**, so one admin could reset
  another admin's password: horizontal admin takeover, which the impersonation
  endpoint has always blocked outright. And it wrote **no audit record**. Now: the
  response carries only `{ ok, emailSent }`, resetting another admin's password is
  refused (an admin who has genuinely lost access uses forgot-password with their own
  mailbox), and the action writes both an `AuditLog` row and an `admin.reset_password`
  activity entry at warning level. The account owner is notified, mirroring
  impersonation.

### Added
- **Audit records for privileged actions that had none** (#878): API key create/revoke,
  webhook create/delete, invitation created, user activated/deactivated, organization
  created/updated (warning level when the change touches SSO config — that can redirect
  authentication itself), source created/deleted, company- and source-user accounts
  created, and mentorship-request decisions.
- **`ActivityLog` records where an action came from** (#881) — new optional `ip` and
  `userAgent` columns, populated when the call site has a request. "Who did what"
  could never answer "was this really the user?". Sign-in, failed sign-in, failed 2FA,
  impersonation and every action above now carry an origin; the IP shows in
  `/admin/activity` with the user-agent as its tooltip. Successful sign-in moved from
  NextAuth's `events.signIn` into `authorize()` because the event callback has no
  request — sign-out stays there and carries no origin, which is a deliberate
  omission, not an oversight.

### Changed
- `clientIp()` moved from `src/lib/rateLimit.ts` to `src/lib/clientIp.ts` (re-exported
  from its old home, so no call site changes). The rate limiter now logs breaches via
  `logActivity`, and the audit logger needs the IP — leaving both in one module made
  an import cycle.

## [0.31.4-beta] - 2026-07-31

### Added
- **Rate-limit breaches are now recorded** (#864). `enforceRateLimit` returned 429
  silently, so being under attack looked exactly like being idle. Breaches log
  `ratelimit.exceeded` at warning level and show up on `/admin/activity`. Written
  fire-and-forget so `enforceRateLimit` stays synchronous and its six callers are
  untouched, and **coalesced to one row per bucket+IP per minute** — a flood is
  precisely when this fires, and one DB insert per blocked request would make the
  rate limiter an amplifier for the attack it exists to absorb.

### Fixed
- **The rate-limit bucket map grew for the life of the process** (#864).
  `sweepRateLimitBuckets()` was written but never called anywhere. It now runs every
  100 `rateLimit()` calls, plus immediately whenever the map passes 50 000 entries —
  proportional to traffic, with no scheduler to own.

## [0.31.3-beta] - 2026-07-31

### Security
- **The 2FA code could be guessed without limit** (#865). `clearRateLimit(failKey)`
  ran the moment the *password* verified — before the TOTP check — so the 6-digit
  code that followed had no limiter behind it at all: the whole 10⁶ space, as fast
  as the server would answer. Since `twoFactorPolicy.ts` makes 2FA mandatory by role,
  this hit the admin and mentor accounts hardest. The counter is now cleared only
  after the credential check is completely through, and failed codes get their own
  bucket (`totp-fail:<email>`, 5 per 15 min) so a user fumbling their code doesn't
  spend the password allowance and an attacker past the password doesn't get a fresh
  one. Failures are logged as `auth.totp_failed` at warning level.
- **A used 2FA code was accepted again inside its window** (#865). Three codes are
  valid at any moment (±1 step for clock skew, ~90s). `User.lastTotpStep` now records
  the consumed step and a code must beat it, so one captured over a shoulder or
  through a phishing page is spent. The skew tolerance is unchanged — nobody gets
  locked out by a slow clock. Enabling 2FA does not burn the enrolment code: that
  window is not the exposed one, and burning it would break enrol-then-sign-in.

## [0.31.2-beta] - 2026-07-31

### Security
- **Changing or resetting a password did not end existing sessions** (#868). The
  revocation machinery already worked — `auth.ts` compares `token.authTime` against
  `User.sessionsValidFrom` on every request — but `sessionsValidFrom` was written in
  exactly one place: the "sign out of all devices" button. So the standard response
  to a stolen session (change the password) left the thief's JWT valid for the rest
  of its 12 hours, and nothing in the UI suggested pressing the other button. Both
  `PUT /api/account` and `POST /api/auth/reset` now stamp it. **This ends the
  caller's own session too, on purpose** — issuing a replacement token would mean
  "revoke everything except the request I just received", and that request is
  exactly what an attacker holding the current password would send. The account page
  says what happened and returns to sign-in. Any unused reset tokens for the account
  are consumed at the same time, so a link already sitting in a mailbox can't undo
  the change.
- **Two HMAC signing helpers fell back to a hard-coded `'dev-secret'`** (#870). The
  repository is public, so an environment missing `NEXTAUTH_SECRET` would verify
  tokens anyone could mint: reply tokens route an inbound email into a message
  thread, consent-renewal tokens record data-processing consent for another person.
  `requireServerSecret()` (`src/lib/serverSecret.ts`) now throws instead. Nothing
  legitimate breaks — NextAuth cannot authenticate anyone without that secret either.
  Related fail-open: `/api/inbound-email` treated a missing `INBOUND_SECRET` as
  "allowed, the HMAC gate will catch it" while that gate was itself defaulted; in
  production it now returns 401, and dev/CI keep the lenient path.
- **Auth forms had no `method`, so a pre-hydration submit put the password in the
  URL** (#873). A native GET was observed live:
  `…/auth/signin?email=…&password=ChangeMe123%21` — which then lands in browser
  history, the `Referer` header and nginx access logs. `method="post"` added to
  sign-in, register, forgot, reset and both credential forms on the account page.
  With JS working the behaviour is unchanged.

## [0.31.1-beta] - 2026-07-31

### Security
- **Every IP-based rate limit could be bypassed with a rotating
  `X-Forwarded-For`** (#858). `clientIp()` returned `xff.split(',')[0]` — the
  *leftmost* entry, which is whatever the client wrote. Our nginx uses
  `$proxy_add_x_forwarded_for`, which **appends** the real peer address, so the
  trustworthy value is on the right and the code was reading the one part of the
  header an attacker fully controls. Measured on `/api/auth/forgot` (5 per 15 min):
  12 spoofed requests all returned 200 where the honest control got 7× 429. Each
  fabricated value also opened a new key in the in-memory bucket map, so the spoof
  doubled as unbounded memory growth.
  `clientIp()` now counts back from the right by `TRUSTED_PROXY_COUNT` hops
  (default `1` = our single nginx; `0` ignores the header entirely), falls back to
  the rightmost entry when the list is shorter than the configured chain, and
  validates the result as an IPv4/IPv6 literal before it becomes a bucket key.
  `enforceRateLimit`'s signature is unchanged, so all six calling endpoints are
  untouched. The login limit is keyed on email, not IP, and was never affected.

### Documentation
- `.env.example` and `infra/README.md` cover `TRUSTED_PROXY_COUNT`: what the value
  means per environment, and that it must be raised to `2` if a hostname is ever
  moved behind Cloudflare's proxy (verified today that `crm.ersah.in` is not —
  no `cf-ray`, so one hop).

## [0.31.0-beta] - 2026-07-31

### Security
- **A mentor kept CV and document access to a former mentee forever** (#854).
  `canAccessCv` / `canAccessUserDocs` asked only whether a `MentorshipRelation`
  existed, never what its `status` was, so marking a mentorship COMPLETED changed
  nothing. Access now expires `POST_MENTORSHIP_ACCESS_MONTHS` (6) after completion.
  **Product decision — a window, not an immediate cut-off:** writing a reference
  after the internship is real work, and revoking on the spot pushes mentors to keep
  private copies, which moves the data outside the app's audit trail entirely. What
  was indefensible was the *indefinite* part. Rationale, the alternative considered
  and the legal basis: `docs/pii-access-lifecycle.md`. Owner and ADMIN access are
  unaffected.
- **`/api/users` dumped every user's full PII in one request** (#855). The admin
  branch had no `take`/`skip` and returned email, phone, university, department and
  more for the entire tenant — one compromised admin session walked off with the lot.
  Added a `?view=` field set (`picker` = id/name/role, `directory` =
  id/name/email/role/active/verified) and opt-in pagination
  (`?page=`, `perPage` default 25, max 100, response carries `total`/`archivedCount`).
  `/admin/users` now paginates, filters and searches server-side instead of pulling
  the whole table and slicing it in the browser; `/admin/mentorship` and
  `ProjectsManager` switched to `view=picker`, so their requests no longer carry any
  PII at all. The MENTOR branch is untouched.

### Added
- `MentorshipRelation.completedAt`, stamped when a relation is marked COMPLETED and
  cleared if it is reopened — the anchor for the access window above.
  `prisma/backfill-relation-completed-at.mjs` (idempotent, wired into
  `infra/deploy-prod.sh`) stamps relations that were already COMPLETED before the
  column existed, so they get a window instead of losing access the moment this
  deploys.

### Documentation
- **`docs/pii-access-lifecycle.md`** — how long access lasts and how much data each
  caller gets, plus what is deliberately left for later (`/admin/candidates` and
  `/admin/mentors` still fetch full lists; PII access logging is #821).

## [0.30.3-beta] - 2026-07-31

### Security
- **`/api/projects` let SOURCE read every project, private ones included** (#849).
  Same allowlist-by-omission shape as #847/#848: the role chain covered
  MENTOR/COMPANY/MENTEE and SOURCE fell through to an unfiltered query. SOURCE now
  gets the public showcase only (and the same PII stripping mentees get — member and
  relation names removed, count kept).

### Changed
- **Role scoping is now centralised in `scopeForRole(user, resource)`**
  (`src/lib/authzScope.ts`), used by `/api/interactions`, `/api/mentorship` and
  `/api/projects`. Scopes are declared as a per-resource, per-role builder table
  instead of an `if/else if` chain in each route, so a role missing from the table
  gets `403` + an `authz.scope_denied` warning rather than an unfiltered query.
  Adding a role to the `Role` enum can no longer silently grant it access.

### Documentation
- **`docs/role-access-matrix.md`** (#851) — the role × resource read matrix, why
  fail-closed, which areas deliberately sit outside it (CV/document/messaging access
  and the role-gated routes, all already fail-closed and not to be regressed), and
  the three steps to follow when adding a role or a scoped resource.

## [0.30.2-beta] - 2026-07-31

### Security
- **COMPANY and SOURCE accounts could read every mentee's interaction logs and
  mentorship relations** (#847, #848). `GET /api/interactions` scoped its `where`
  clause with an `if (MENTOR) … else if (MENTEE) …` chain and no final `else`, and
  `GET /api/mentorship` covered MENTOR/MENTEE/COMPANY but not SOURCE. Any role the
  chain didn't name fell through with an empty filter and got ADMIN visibility —
  confirmed live: a SOURCE account with zero referred mentees read all 12 interaction
  logs across 8 mentees. Scoping is now **fail-closed** via
  `relationScopeForRole()` in `src/lib/authzScope.ts`: COMPANY is limited to its own
  company's relations, SOURCE to the mentees it referred (a source with no `sourceId`
  matches nothing), and a role with no defined scope gets `403` plus an
  `authz.scope_denied` activity log at warning level. ADMIN/MENTOR/MENTEE result sets
  are unchanged. Passing `?relationId=` for an out-of-scope relation no longer
  bypasses the filter. Locked down by `e2e/role-scoping.spec.ts` (`@smoke`), which
  asserts row ownership rather than status codes — the leak returned `200` throughout.

## [0.30.1-beta] - 2026-07-31

### Fixed
- **Mentor/admin targeted-email recipient counter only showed the selected count**
  (#680). `TargetedEmailComposer` (shared by `/mentor/email` and `/admin/email`) rendered
  `Recipients (3)` instead of `Recipients (3/10)`, so there was no way to tell how many
  mentees were selected out of the total without scrolling the checkbox list. Now shows
  `chosen.length` over `relations.length`.

## [0.30.0-beta] - 2026-07-31

### Added
- **The scheduled jobs now actually run.** `initCronJobs()` had no caller
  anywhere in the repo, and nothing on the server drove `GET /api/cron` either
  (no crontab entry, no systemd timer) — so mentor-interaction reminders, stage
  deadline reminders, meeting reminders, the weekly mentor digest, the daily
  activity digest, the analytics report and the hourly unread-message digest had
  never fired on a schedule in production. Noted as a follow-up in 0.29.0; this
  closes it.
  - `POST /api/cron/start` (node runtime, `CRON_SECRET` required) registers the
    schedules in the server process; `src/instrumentation.ts` calls it shortly
    after boot. Same edge-runtime workaround as the mail bridge — instrumentation
    can't import `emailService` directly, because `middleware.ts` makes Next
    compile instrumentation for the edge runtime too, where Prisma and nodemailer
    don't resolve.
  - The call is **deferred onto a timer, not awaited** in `register()`: that hook
    resolves before the server accepts connections, so awaiting a request to
    ourselves would deadlock.
  - Gated on `CRON_SECRET`, which belongs in production only — the preview DB is
    shared with every topic env and holds the same addresses, so a scheduler
    running there would email real users. `CRON_ENABLED=0` is the kill switch.
  - `GET /api/cron` (admin, runs everything once) is unchanged.

### Fixed
- **Mentor interaction reminders: one mail per mentee per day, with no way to
  opt out.** `checkMentorInteractionReminders` sent a separate email for every
  stale relation on every run, and — alone among the scheduled jobs — never
  consulted `emailAllowed`. On the production data that meant one mentor would
  have received 7 emails a day, indefinitely, with no opt-out. Now grouped into a
  single summary per mentor listing each mentee and how long it has been, and it
  honours the `deadlines` preference (the same category as the stage-deadline
  nudge). Returns `emailed` alongside `checked`/`reminded`.

### Infrastructure
- `prisma/backfill-cron-baseline.mjs`, wired into `deploy-prod.sh` — a **one-shot**
  baseline so the first tick doesn't mail out history. The unread-message digest
  selects every message with `digestedAt: null` and no lower bound on age, and
  `digestedAt` had never been set, so switching the scheduler on would have sent
  3 people a digest of messages up to 3 weeks old. It marks the pre-existing
  backlog handled and records `Setting['cronBaselineAt']`, skipping every
  subsequent run — deliberately one-shot rather than merely idempotent, since
  re-running it would mark *newly* stale work as handled on every deploy and
  permanently suppress the very reminders it protects.
  Not baselined on purpose: `retentionReminderSentAt` (consent renewal is a
  compliance path — and nothing is due, retention is 12 months and the oldest
  `consentAt` is 2026-06-30), `Meeting.reminderSentAt` (only looks 60 minutes
  ahead, so it has no backlog), and `stalenessReminderSentAt` (it gates only the
  in-app bell, not the email — the daily-mail problem was the ungrouped send,
  fixed above).
- `CRON_SECRET` / `CRON_ENABLED` forwarded by `infra/deploy-prod.sh` (explicit
  `-e` allowlist, plus the env-derivation fallback).

### Tests
- `e2e/cron-start.spec.ts` (`@smoke`) — neither `/api/cron/start` nor
  `/api/inbound-email/poll` may return 200 to an unauthenticated caller.

## [0.29.1-beta] - 2026-07-31

### Fixed
- **Quote trimming missed most clients' attribution line.** `stripQuoted` only
  knew the `On … wrote:` form, so a reply that actually arrived through the new
  bridge — `"cevap veriyorum\n\nJuly 2, 2026 at 3:50 PM, noreply@crm.ersah.in
  wrote:\n> …"` — kept that attribution line in the threaded message. It now
  cuts at any line ending in the local "wrote:" verb (`wrote` / `yazdı` /
  `schrieb` — the app's three locales), at an Outlook `____` divider, or at the
  first `>` line, whichever comes first. Covered in `e2e/inbound-email.spec.ts`
  with the exact body that exposed it.
- The bridge no longer fails a message silently: a UID that the search returned
  but whose source can't be fetched (a stale dovecot index entry, or mail
  expunged under it) is now logged instead of just incrementing a counter. Found
  because a hand-deleted probe left exactly that state behind.

## [0.29.0-beta] - 2026-07-31

### Added
- **Reply-by-email actually works now: the mail bridge that was never built.**
  Outgoing message notifications have carried
  `Reply-To: reply+<relationId>.<hmac>@crm.ersah.in` for a while, and
  `POST /api/inbound-email` has been able to thread such a reply since it
  shipped — but nothing ever *read the mailbox*, so every reply sat there
  unprocessed. `docs/EMAIL_DELIVERABILITY.md` recorded this honestly ("what's
  still required in infrastructure is a mail bridge"). Unprocessed replies had
  been accumulating in the catch-all mailbox since 2026-07-01 — 9 mails, which
  are 5 distinct replies (the catch-all delivered most of them twice, which is
  exactly what `inboundMessageId` now guards against).
  - `src/services/inboundMailBridge.ts` — IMAP poller (`imapflow` +
    `mailparser`). Every `INBOUND_IMAP_POLL_SECONDS` (default 60) it drains
    unseen mail from the reply mailbox, pulls the token out of whichever
    recipient header carries it (`Delivered-To` / `X-Original-To` / `To` / `Cc` /
    `X-Envelope-To` — the MTA-added ones are what survive a catch-all or alias),
    and threads it. Started at server boot from `src/instrumentation.ts`.
  - `src/lib/inboundEmail.ts` — the token + participant checks and the message
    write, extracted out of the route handler so the HTTP endpoint and the bridge
    share one code path instead of the bridge re-implementing the rules.
  - `Message.inboundMessageId` (`@unique`) makes delivery idempotent. IMAP is
    at-least-once — a crash between writing the reply and setting `\Seen` replays
    the mail — and a catch-all can deliver two copies of one email. A replay is
    now a no-op instead of a duplicate message in the thread.
  - Mail is flagged `\Seen` once routed *or* permanently rejected (bad token,
    unknown thread, stranger); a transient failure leaves it unseen so the next
    tick retries it rather than dropping the reply.
  - The bridge starts only where `INBOUND_IMAP_HOST`/`USER`/`PASS` are all set,
    which is production alone — two containers polling one mailbox would race
    over the `\Seen` flag. `INBOUND_IMAP_ENABLED=0` stops it without removing the
    credentials.

### Infrastructure
- `infra/deploy-prod.sh` forwards the `INBOUND_*` vars into the container.
  `docker run` there passes an explicit `-e` allowlist, so env-file keys that
  aren't listed are silently dropped — the bridge would have started nowhere no
  matter what `prod.env` said. The env-derivation fallback (used when the env
  file is missing) carries them too, so a re-derived file doesn't quietly
  disable the bridge on the next deploy.
- Dedicated `reply@crm.ersah.in` mailbox on `s.ersah.in`. Postfix runs with
  `recipient_delimiter = +`, so `reply+<token>@crm.ersah.in` now lands there
  instead of in the `m@ersah.in` catch-all — reply traffic stays out of a
  personal inbox. `INBOUND_IMAP_*` and `INBOUND_SECRET` added to
  `/etc/internship-crm/prod.env` (`INBOUND_SECRET` had never been set in prod, so
  the endpoint was relying on the HMAC token alone).

### Notes
- `initCronJobs()` in `src/services/emailService.ts` **has no caller anywhere in
  the repo**, and nothing on the server drives `GET /api/cron` either (no
  crontab entry, no systemd timer) — so the mentor-reminder, meeting-reminder and
  digest jobs are not running on a schedule in production. Found while looking
  for a place to hook the bridge in; deliberately **not** fixed here, because
  switching those on would start sending reminder and digest email as a side
  effect of an inbound-mail change. `src/instrumentation.ts` therefore starts the
  bridge and nothing else. Needs its own issue.

## [Unreleased]

### Fixed
- **Scheduled full e2e suite: the 2 reds and 1 flake left by run
  [30608852159](https://github.com/21072026/Internship/actions/runs/30608852159)**
  (#963). Again no product bug — all three are test defects.
  - **`evaluation-goals`** still asserted the goals panel's old `"0/2 completed"`
    progress bar and its `0%` label. #785 (PR #786) replaced that bar with the
    `goals-active-count` / `goals-completed-count` counters, but the merge kept
    main's `GoalsPanel` (from #918) *and* the branch's spec, so the spec asserted
    markup that no longer exists. It now asserts the counters, like the
    `goals-archive-sort` spec that shipped with the same feature.
  - **`meeting-requests`** switches user mid-test, and `clearCookies()` alone does
    not end the old session: the page being left keeps hitting
    `/api/auth/session`, and NextAuth re-issues the session cookie on those
    responses — one landing just after the clear restores it. `/auth/signin` then
    saw `status === 'authenticated'` and redirected to the *previous* user's
    dashboard mid-typing, so `page.click('button[type="submit"]')` re-resolved
    against the mentee portal and spent the whole action timeout retrying its
    disabled "Add goal" button. New `signInAsFreshUser()` in `e2e/helpers/auth.ts`
    tears the old page down (`about:blank`) before dropping the session cookie,
    keeps the consent cookie seeded by `storageState`, and clicks the submit
    button *inside the sign-in form*, so a stray redirect fails fast instead of
    clicking something unrelated. `evaluation-goals` uses it too.
  - **`notes`** (the run's flake) read the database straight after
    `expect(page.getByText('Prepare portfolio for interview')).toBeVisible()` —
    but Playwright's text matching includes `<textarea>` values, so that matched
    the text just typed into the still-open editor and the read raced the PATCH.
    It now waits for the editor to close first.
- **The scheduled full e2e suite is green again — 9 failing specs** (#954). The suite's
  daily schedule had been left commented out since before the Actions quota was
  restored, so failures accumulated unseen while the `@smoke` PR gate stayed green.
  None of the nine was a product bug; all were test/locator defects, and three of them
  masked a second defect behind the first. Verified locally against an apt-installed
  MariaDB (see `docs/security-audit-playbook.md`).
  - **`getByText` substring collisions** (`candidates-archive`, `dashboard-links`,
    `i18n`): `getByText('Inactive')` also matched the seeded address
    `arch-inactive-…@e2e.local`; `'660 · Hired'` matched both the filter chip and an
    `<option>` in the stage `<select>`; the TR label `'Davet Gönder'` matched both the
    sidebar link and the dashboard quick-action card (in EN they differ, so only the
    Turkish half broke). Fixed with `exact: true`, a new
    `data-testid="candidates-status-filter-chip"`, and scoping nav assertions to the
    navigation landmark.
  - **Post-login navigation race** (`admin-organizations`, `company-shortlist`,
    `message-attachments`): `waitForURL()` returns as soon as the URL matches, which can
    be before the sign-in page's push to the role landing page has committed — so a
    deep-link `goto()` was aborted with *"interrupted by another navigation"*. New
    `e2e/helpers/auth.ts` exposes `signInAndSettle()` and a `gotoSettled()` that retries
    only that specific error.
  - **`admin-organizations`** additionally used `getByLabel('Name', { exact: true })`,
    but `Input` renders the required marker inside the `<label>`, so the label's text is
    literally `"Name*"` and an exact match can never succeed. Now an anchored regex —
    plain `'Name'` would also match `"Brand name"`.
  - **`message-attachments`** asserted `getByText('screenshot.png')`, but image
    attachments render as an `<img alt=…>` thumbnail with no text node; only non-image
    files show the filename. Now scoped to a new `data-testid="pending-attachments"`.
  - **`project-owners-ui`** was not a removal bug: the member-picker `<select>` lists
    exactly the users *not* in the project, so a removed member reappears there and a
    panel-wide text match still found them. Assertions now scope to a new
    `data-testid="owners-members"`, and the row's remove button gained
    `data-testid="member-remove-<userId>"` instead of being reached via
    `locator('div', { hasText }).last()`.
  - **`project-dm` / `support-chat`** read the database immediately after a UI
    assertion, assuming the write had committed. Both now use `expect.poll`, which still
    fails if the row genuinely never appears.

No version bump: test and `data-testid` changes only, no user-visible behaviour change.

## [0.28.4-beta] - 2026-07-31

### Added
- **Program satisfaction survey copy** (#879) — EN/TR/DE strings only, no API/model/UI yet.
  New `programSurvey` namespace in `src/i18n/dictionaries.ts`: a single NPS question (with
  0/10 scale-endpoint labels) shared by both roles, plus up to two role-specific follow-ups
  — mentee: communication availability and whether the program matched expectations;
  mentor: adequacy of program support and mentoring-workload sustainability (phrased about
  the workload/pace, not the mentee, to stay neutral) — capping every respondent at NPS + 2
  questions. Also adds the invite-email and thank-you copy. Every question is worded about
  the program experience, not a rating of a specific person. TR copy kept short and in the
  app's existing informal `sen` voice, matching `src/lib/templates.ts` /
  `src/lib/pipeline.ts`.

## [0.28.3-beta] - 2026-07-31

### Changed
- **Shared date formatters instead of ad-hoc `toLocaleDateString`/`toLocaleString` calls**
  (#703). `formatDate`/`formatDateTime` (`src/lib/relativeTime.ts`) now take an optional
  third `Intl.DateTimeFormatOptions` argument that's spread over their existing defaults —
  backwards-compatible, since every prior call site passed only `(date, locale)`. This let
  `src/app/portal/interactions/page.tsx`'s long weekday/month format move over too, on top
  of `src/app/admin/analytics/report/page.tsx`'s report-generated-on date and
  `src/app/rsvp/[token]/page.tsx`'s meeting date/time — all three now follow the app's
  selected locale instead of the browser's default, visually unchanged. Left untouched: the
  four `toLocaleString` calls in `src/services/emailService.ts`, which use the
  `dateStyle`/`timeStyle` shorthand — that can't be mixed with the helpers' explicit
  year/month/day fields (`Intl.DateTimeFormat` throws if both are present) — for a
  deliberately fixed `en-GB` email-template format that's independent of the recipient's
  app locale, not ad-hoc duplication of the same concern.

## [0.28.2-beta] - 2026-07-30

### Added
- **Notification history page** (#919) at `/notifications`, reachable from a new "View all"
  link in the bell dropdown. Every request is scoped to the signed-in user's own
  `Notification` rows server-side; supports a read/unread status filter, a type filter
  (populated from the viewer's own notification types), and pagination — all backed by
  optional `page`/`pageSize`/`read`/`type` query params added to `GET /api/notifications`.
  The bell's existing no-param call (and its mark-as-read behavior) is unchanged.
  Notifications render as spaced cards with a per-type icon, a clearly highlighted unread
  state (tinted background, bold text, dot) versus a faded read state, a total count badge,
  a "1–20 / 48" range readout next to the pager, and a "Clear filters" action. Every
  clickable row/button meets the WCAG 2.2 44×44px minimum target size.
- **Announcements card** (#920) on the mentee and mentor dashboards, showing the most
  recent admin broadcasts. Reads directly from the `Announcement` table via a new
  `GET /api/announcements` (any authenticated user — every broadcast already targets all
  active users, so there is no per-role/org filtering to apply) rather than the
  notification bell, with its own "View all" link to a new shared `/announcements` history
  page. The admin composer at `/admin/announcements` is unchanged.
- **Automatic project group chat** (#771) — every project now has one shared GROUP
  conversation whose participants stay synchronized with `ProjectMember`. Owners, mentors
  and mentees can use the existing message flow, including attachments and reactions;
  removed members keep no access, while message history remains intact. Message emails
  continue to respect the recipient's Messages preference.
- Project group chats are discoverable from the **Messages** inbox: open the chat icon in
  the header and select the row labeled with the project name and **Project group**.

### Schema
- `Conversation` now has a compound unique constraint on `[type, projectId]`, preventing
  concurrent requests from creating more than one GROUP conversation per project.

### Fixed
- **The last three gaps from the email-delivery audit** (#668, follow-up to the sweep
  shipped in 0.26.0).
  - **A direct admin assignment was completely silent** (`POST /api/mentorship`). Unlike
    the request-approval path, an admin wiring a mentor to a mentee sent neither an in-app
    notification nor an email, so neither side learned about it until they happened to log
    in. Both now get a `mentorship_request` notification, plus an email gated on the
    `mentorship` opt-out: a new `sendMentorAssignedEmail` for the mentee (the
    request-approval copy does not fit — the mentee never asked) and the existing
    `sendMenteeAssignedEmail` for the mentor. Both are branded via `emailBrand` and their
    failures are logged without failing the assignment.
  - **`POST /api/mentor/email` ignored the recipient's preferences.** The mentor's bulk
    mentee mail went out even to mentees who had switched email notifications off; it is
    now gated on `messages`, matching `/api/messages`. The `InteractionLog` entry is still
    written either way, so the mentor's outreach record is unchanged.
  - **Cron email failures were swallowed or aborted the job.** `checkMentorInteractionReminders`
    and `checkRetentionReminders` awaited `sendEmail` unguarded, so one bad address aborted
    the whole run mid-way and left the remaining recipients unprocessed; `checkStageDeadlineReminders`,
    `checkCompanyNeedMatches` and `sendWeeklyAnalyticsReport` used `.catch(() => {})`, discarding
    the error entirely. The first two are now wrapped in `try/catch` and all five log the
    failure with the relation/user id for context.

### Added
- E2E coverage for the notification paths above: `e2e/mentorship-direct-assign.spec.ts`
  (direct assignment notifies both sides), three new cases in `e2e/mentorship-request.spec.ts`
  (admin-queue notification, approve notifies both sides, reject notifies the mentee with no
  relation created), and an `e2e/notif-prefs.spec.ts` case asserting the `mentorship` and
  `meetingReminders` toggles render and persist through the account-settings UI.

## [0.28.1-beta] - 2026-07-29

### Fixed
- **Tenant auto-scoping now also covers lazily-awaited Prisma queries** (#958) — Prisma's
  query promises only execute on their first `.then()`, so
  `runWithOrg(org, () => prisma.x.findMany())` awaited *outside* the call ran the query
  after the AsyncLocalStorage context was gone and the central middleware silently skipped
  the org filter. `runWithOrg` now subscribes to thenable results inside the bound context,
  so the query always fires with the tenant attached. This was also the deterministic red
  (`e2e/tenant-isolation.spec.ts:85`) that had kept the scheduled full e2e suite failing
  since 2026-07-11. No behavior change when `MT_ENFORCE_ISOLATION` is off.


## [0.28.0] - 2026-07-28

### Fixed
- **Character limits now match the database, and the counter no longer advertises a
  limit the write cannot honour** (#782 follow-up). The counter PR set `maxLength` on
  the client independently of the `zod` cap on the server and of the column width in
  `schema.prisma`; all three had drifted apart, which inverted the feature's purpose.
  - `InteractionLog.notes` was a bare `String` — VARCHAR(191) in MySQL — while the log
    form offered 5 000 characters and `/api/interactions` had **no** cap. A
    three-sentence meeting note (192 chars) raised Prisma P2000 and surfaced as a 500.
    `/api/mentor/email` writes `"<subject> — <body>"` into the same column *after* the
    mail is sent, so overflowing it failed the request post-delivery and a retry
    re-mailed every recipient.
  - `Company.description` (2 000 offered) and `CompanyInterest.note` (1 000 accepted,
    uncapped in the form) had the same VARCHAR(191) column; `Announcement.link` /
    `Notification.link` were VARCHAR(191) against a 500-char `zod` cap.
  - All widened to `@db.Text` (`link` to `@db.VarChar(500)`), and the client/server
    caps unified in a new **`src/lib/textLimits.ts`** imported by both the `zod`
    schemas and the `maxLength` props, so the two can no longer disagree. That also
    corrects the mentorship-request box (advertised 2 000 against a 1 000 server cap —
    a regression introduced by #782 raising the client number alone) and the public
    contact form (5 000 against 2 000).
- **The company description box could not be typed into at all.** `Textarea`
  hard-bound `value={value}` with a `''` default, and `CompanyForm` passes
  `{...register('description')}`, which supplies no `value` — making it a controlled
  input pinned to the empty string. `Textarea` now binds `value` only when the caller
  provides one and mirrors uncontrolled text into state so the counter still tracks.
- **The counter reached six more textareas, including Announcements.** The #782 sweep
  only walked `src/components/**`, so nine raw `<textarea>`s survived — among them the
  Duyurular message box, where an invisible 20 000-character cap presented as an
  untranslated "Validation failed" *after* the admin finished writing. The CSV import
  and SSO certificate boxes stay raw deliberately. `CHANGELOG.md`'s earlier claim that
  every raw textarea had been replaced was inaccurate.
- **Counter no longer blocks the resize handle or overlaps text** — it sits on the
  native grabber, so it gains `pointer-events-none`, and the textarea gains `pb-7`
  when a counter is shown. New `wrapperClassName` prop for layout classes that belong
  on the positioning wrapper (`flex-1`) rather than the inner textarea.

### Added
- **`e2e/text-limits.spec.ts`** — there was no e2e assertion anywhere in the suite for
  the counter or for any text length, and `announcements.spec.ts` posts a ~25-char
  string, so none of the above was reachable from CI on either the smoke gate or the
  4×-daily full run. Covers counter render/count/warning-band transitions (via a new
  `data-counter-state` attribute rather than colour classes), long-form announcement
  submission, a 900-char company description round-trip, and a direct-to-API
  over-limit post returning 400 rather than 500. The 1 200-char interaction-note
  persistence test is tagged `@smoke`.

### Changed
- **The production forward-only guard fails closed instead of open** (`infra/deploy-prod.sh`).
  No workflow set `fetch-depth`, so `actions/checkout` cloned depth 1 and the guard's
  `git cat-file -e` / `git merge-base --is-ancestor` could not answer; AND-chained with
  stderr suppressed, an unanswerable question read as "not older than live" and the
  deploy proceeded — precisely inverted. Now `fetch-depth: 0`, unshallow before asking,
  and refuse (`FORCE=1` overrides) when ancestry cannot be proven. The baseline also
  comes from the container's `/api/health` rather than a state file only this script
  writes, and the ancestor/descendant deadlock — which pinned prod off-`main` while
  every 6-hourly run reported SUCCESS — now deploys forward and warns.
- **Deploy health check verifies what is actually running.** It curled the root page,
  which answers 200 from a container with a broken `DATABASE_URL` and reveals nothing
  about which build is live — while the drift gate decides "already current" from that
  same endpoint's `sha`, so a stale-but-answering container could suppress every future
  build. Now probes `/api/health?db=1` and asserts `status`, `db`, and that the served
  `sha` is the commit just built.
- **Both deploy workflows email on failure** (the `stress.yml` `ALERT_EMAIL_TO`
  pattern). A failed swap leaves no container running — `docker stop` precedes
  `docker run` — and was previously just a red tick in the Actions tab. Refusals and
  skips now emit `::warning::` and a step-summary line instead of hiding in a green log.

## [0.27.0-beta] - 2026-07-28

### Added
- **Project co-members can message each other from `/messages`** (#770) — the piece that
  makes the #768 authorization layer and the #769 API reachable. Two mentees on the same
  project, with no mentorship between them, can now find each other and start a DM;
  previously the inbox was built purely from `mentorshipRelation.findMany`, so they were
  invisible to one another.
  - A **"New chat" picker** on `/messages` lists the viewer's project co-members. The
    candidate list is derived **on the server** from `ProjectMember` (membership *is* the
    permission — see `canMessage`), so the client never decides who is messageable, and
    `POST /api/conversations` re-checks anyway. People you already have a DM with are
    filtered out (they're in the thread list), and duplicates from two shared projects are
    deduped. A filter box appears past six candidates.
  - **`/messages/c/[conversationId]`** renders conversations. Rather than duplicate ~430
    lines of message UI, the thread view moved to `src/components/MessageThreadView.tsx`
    and both routes are thin wrappers over it, so attachments, pasted images, reactions,
    edit/delete, read receipts and the Enter-to-send preference work identically on both.
  - Conversations appear in the same inbox list as mentorship threads, sorted together by
    last activity, with the same unread badge.

### Changed
- **Losing the shared project makes a DM read-only instead of unreachable** (#770).
  Reading a conversation stays participant-based and permanent — history doesn't vanish —
  but posting is re-checked against the live permission by a new
  `canPostToConversation()`. `POST /api/messages` enforces it (403) and `GET` returns a
  `canPost` flag so the thread renders a read-only notice instead of a composer that would
  fail on send. Without this, participation alone would have kept a removed member writing
  indefinitely, since #769 authorized conversation posts purely by participation.
  GROUP conversations are governed by their own membership, so participation remains the
  rule there.

### Tests
- `e2e/project-dm.spec.ts` — two project co-members (no mentorship) start a DM, the message
  is stored against the conversation with a null `relationId`, the DM shows up in the
  inbox, and after removing one from the project the history is still readable while the
  composer is gone and the API returns 403 to a direct POST. Deliberately **not** `@smoke`,
  to keep the PR gate small. Locators use `data-testid` (`message-input`, `message-send`,
  `new-chat-*`) rather than localized button labels.

## [0.26.2-beta] - 2026-07-28

### Added
- **1:1 direct-message API for project co-members** (#769), building on the #768
  authorization layer. No user-visible surface yet — nothing in the UI calls these
  endpoints; the `/messages` picker (#770) is what will expose them, so no release note
  accompanies this entry.
  - `POST /api/conversations` — create-or-get the DIRECT conversation with another user.
    Idempotent, and 403 when `canMessage()` says no. Authorization lives *inside*
    `findOrCreateDirectConversation()` rather than in the route, so no future caller can
    skip it.
  - `GET`/`POST /api/messages` now accept **`conversationId`** alongside the existing
    `relationId` (JSON *and* multipart/attachment paths). Exactly one link is queried per
    request — never an `OR` across both, which would leak the sibling layer's messages
    into a thread view. Posting notifies **every** other participant
    (`otherConversationParticipants`) and mirrors to email for those who haven't opted
    out of `messages`.
  - The message sub-routes — `PATCH`/`DELETE /api/messages/[id]`,
    `POST /api/messages/[id]/reactions`, `GET /api/messages/attachments/[id]` — now
    authorize through a shared `canAccessMessage()` that follows whichever link the
    message carries. Without this they would have kept failing closed on conversation
    messages (`relationId` is null there since #768), i.e. a DM could be sent but never
    edited, deleted, reacted to, or have its attachments downloaded.
  - `GET /api/messages/unread` counts conversation messages too, so project DMs reach the
    unread badge instead of being invisible to it.
  - Reply-by-email stays mentorship-only: the `Reply-To` token is relation-scoped
    (`replyAddress(relationId)`), so conversation recipients get the notification email
    without a `Reply-To` rather than one that would bounce into nowhere.

### Schema
- `Conversation.directKey String? @unique` — the two participant ids sorted and joined,
  giving a DIRECT conversation one deterministic identity. Create-or-get leans on the
  constraint (catching `P2002`) instead of a read-then-write race, so two simultaneous
  "message this person" clicks can't create two conversations for the same pair. Matching
  on the key also means a GROUP conversation, or one containing both users *plus a third*,
  can never be returned by mistake. Null for groups — MySQL allows many NULLs in a unique
  index.

## [0.26.1-beta] - 2026-07-28

### Changed
- **Meeting reminders now fire ~1 hour before the meeting, reach both participants, and
  respect notification preferences** (#777). `sendMeetingReminders()` looked 24 hours
  ahead, emailed the **mentee only**, sent **no in-app notification**, and ignored the
  category opt-outs entirely — the one notification path the #668 audit left unfixed.
  It now scans a 60-minute window (`MEETING_REMINDER_WINDOW_MINUTES`) and, for every
  participant (mentee *and* mentor):
  - posts an in-app notification **unconditionally** (bell items aren't subject to the
    email category switches), and
  - sends email **only** when `emailAllowed(user, 'meetingReminders')` is on, using the
    org-branded template (`emailBrand`/`brandHeader`/`ctaBlock`) with an escaped title
    and a role-aware deep link (`/portal` for mentees, `/mentor/meetings` otherwise).
  - The cron moved from hourly to `*/15 * * * *`: a 60-minute window on an hourly tick
    fired anywhere from 0 to 60 minutes ahead (a meeting could be "reminded" 3 minutes
    before), so a quarter-hourly tick is what actually delivers 45–60 minutes' notice.
  - **Idempotency:** `reminderSentAt` is now *claimed before sending* via
    `updateMany({ where: { id, reminderSentAt: null } })` and skipped when
    `count === 0`, so overlapping ticks can't double-send and the in-app notification
    and the email sit behind a single marker. A mid-send failure loses a reminder rather
    than duplicating one — the deliberate trade-off for a 4×-per-hour cron. Email errors
    stay swallowed-and-logged so one bad address can't stop the remaining participants.

### Added
- **Server-side messaging authorization derived from project membership** (#768) —
  `src/lib/conversations.ts`: `canMessage()` (same project **or** a mentorship, admins
  always allowed), `sharesProject()`, `hasMentorship()`, `projectMemberIds()`,
  `messageableUserIds()` and `getConversationIfAllowed()` (participants or admin only).
  Mentorship remains an *additional* permission source, so the existing mentor ↔ mentee
  thread path is untouched. Foundation only — no user-visible surface yet; the DM API
  (#769) and the `/messages` picker (#770) build on this.

### Schema
- `Conversation.updatedAt` (`@updatedAt`) and `ConversationParticipant.lastReadAt` +
  `@@index([userId])` added; the `Conversation`/`ConversationParticipant` models
  themselves already landed with #784. `ConversationParticipant.addedAt` was **kept**
  (the spec called it `joinedAt`) because the column is already deployed — renaming it
  would drop data on `prisma db push` against the shared preview/prod DB.
- `Message.relationId` is now **nullable** (`String?`, relation `MentorshipRelation?`) so
  conversation-only messages can be written. Every pre-existing row keeps its
  `relationId`, so the mentorship messaging path is unchanged; `getThreadIfAllowed()`
  now takes `string | null | undefined` and **fails closed** on a missing id, which
  keeps the legacy message/reaction/attachment routes safe (a conversation-only message
  is simply unreachable through them). `sendUnreadMessageDigests()` filters on
  `relationId: { not: null }`.

### Changed
- **Preview and production now deploy automatically on every merge to `main`.** Both
  `deploy-preview.yml` and `deploy-prod.yml` were `workflow_dispatch`-only, so
  "merging to `main` deploys" held only while someone remembered to click *Run
  workflow*. Prod survived on 44 consecutive manual dispatches; the shared preview
  did not — once per-PR topic previews (#583) took over the per-PR job, nobody
  dispatched the shared one and https://crm-preview.ersah.in sat **72 commits / 11
  minor versions behind** prod (0.14.1-beta vs 0.25.14-beta) for a week. Both
  workflows now trigger on `push` to `main` (plus a 6-hourly safety net and manual
  dispatch), keeping preview as the always-current staging environment ahead of the
  planned weekly production release train — the switch to which is documented in
  `deploy-prod.yml`'s header.
  - **Drift gate:** automatic runs compare the live container's `/api/health` `sha`
    with `origin/main` and exit without building when they match, so the scheduled
    run is a no-op unless a push was genuinely missed (the self-hosted runner can be
    offline) — and an unreachable container counts as drift, so the deploy also
    repairs a down environment. `workflow_dispatch` bypasses the gate and still takes
    any branch/tag/SHA.
  - Automatic runs deploy the **tip of `origin/main`** rather than the commit they
    checked out, so a run queued behind a newer one can never land an older commit on
    top of it (the regression class fixed for prod in #794, now closed for preview too).
  - `deploy-preview.yml` no longer deletes `/etc/internship-crm/preview.env` on every
    run. It validates the file and removes it only when it fails to `source` or lacks
    `DATABASE_URL` — a workflow that now runs unattended must not be able to destroy
    the only copy of secrets derived from a container that may since have gone away.
  - A manual dispatch of a **tag or SHA** now deploys it correctly (previously
    `git reset --hard origin/<tag>` would have failed; non-branch refs deploy as
    checked out).
  - Infra/CI only; no application change, so no version bump. Closes #800.

### Fixed
- **Production deploys are now forward-only and deterministic (deploy oscillation).**
  Prod could regress to an older version after some merges ("one step forward, one
  step back"): the `deploy-prod.yml` / `deploy-preview.yml` jobs share one
  self-hosted runner workspace and called `deploy-prod.sh --no-pull`, which builds
  whatever commit the shared workspace was left at rather than `origin/main`; and
  two uncoordinated deployers (the cron `autodeploy.sh` poller + the workflow) write
  the prod container with no guard against out-of-order builds. Prod deploy now
  hard-resets to `origin/main` at deploy time (dropped `--no-pull`) and a
  `FORWARD_ONLY=1` guard in `deploy-prod.sh` refuses to deploy a commit older than
  the one already live (recorded per-container; `FORCE=1` overrides for a deliberate
  rollback). Preview/topic deploys are unaffected. Infra-only; no app change.

## [0.26.0] - 2026-07-28

### Added
- **Email-delivery audit — seven "in-app notification, no email" gaps closed** (#668).
  Audited every notification-producing event (all `notify()` call sites, the three
  direct `prisma.notification.create` sites, and every `@/services/emailService`
  importer) against "does it email → which function → consent check → error
  handling". 16 transactional emails and 9 cron digests were already correct; the
  gaps fixed are:
  - Mentorship request **approved** → email to the mentee *and* to the newly
    assigned mentor; **rejected** → email to the mentee
    (`api/admin/mentorship-requests`, was `notify()`-only).
  - **New mentorship request** → email to active admins (`api/mentorship-requests`)
    — the queue was in-app-only, so a request was invisible until an admin logged in.
  - **Public-profile contact form** → email to the profile owner with `Reply-To` set
    to the sender (`api/public-contact/[userId]`) — an outside enquiry could
    previously sit unseen indefinitely.
  - **Meeting request** created / accepted / declined → email to the mentor and
    back to the requester (accept carries the time + Jitsi link).
  - `api/apply` mentor notification now honours the opt-out (it emailed
    unconditionally, ignoring `emailNotifications`).

  New templates follow the existing `emailBrand`/`brandHeader` pattern and route
  through `sendEmail`, so the no-SMTP silent-skip and swallow-but-log error
  handling are preserved. Adds a `mentorship` opt-out category
  (`NOTIFICATION_CATEGORIES`), and `AccountSettings` now renders that constant
  instead of a hard-coded list so a new email category cannot ship without a
  toggle. Nine events are deliberately left in-app-only with a written rationale
  (pipeline stage changes, goal/evaluation updates and similar high-frequency,
  low-signal events).
- **Goals: sorting and an archive for completed goals** (#785). The goals panel
  gains a **Newest → Oldest / Oldest → Newest** selector (default newest-first,
  applied to both lists) and an **Active | Archive** toggle following the same
  `role="tablist"` pattern as the candidates archive (#0.25.14). Marking a goal
  done moves it out of the active list into the archive, where it keeps its
  completion date and can be reopened. Derived from the existing `Goal.status` and
  `Goal.completedAt` — **no schema change and no API change**.
- **Support: attachments on admin replies** (#788). Admins replying to a support
  ticket can now attach files and images — message only, attachments only, or
  both. The admin reply box reuses the shared `MessageComposer` /
  `PendingAttachmentList` components and the same validation as the user side
  (PNG/JPEG/PDF, ≤10 MB, ≤10 files, magic-byte checks, duplicate rejection), with
  previews and per-file removal before sending. Object URLs are revoked on send
  and when switching tickets. `POST /api/admin/support` now accepts
  `multipart/form-data` in addition to the original JSON text-only shape.

### Changed
- Support attachment validation is now shared between the user channel and the
  admin reply endpoint (`src/lib/supportAttachments.ts` gains
  `appendSupportAttachments`; new `src/lib/supportMessageRequest.ts` holds the
  server-side `readSupportMessageRequest` / `buildSupportAttachments`), replacing
  the duplicated logic in `api/support` and `messages/support`. Behaviour,
  error messages and status codes are unchanged.

### Tests
- `e2e/goals-archive-sort.spec.ts` (new) and additions to
  `e2e/support-attachments.spec.ts`. Neither is `@smoke`-tagged, keeping the PR
  gate fast.

## [0.25.15] - 2026-07-28

### Fixed
- **`ProjectsManager` no longer shows a misleading `(0)` while loading** (#682). The
  "All projects" heading rendered `({projects.length})` from the initial empty array
  at the same time as the loading indicator, so users could not tell "no projects"
  from "still loading". The counter is now suppressed until `loading` is false.

### Changed
- **Page-level search inputs carry a unique `data-testid`** (#702). `AdminNav`
  renders its own sidebar `input[type="search"]` on every admin page, so an
  unscoped `input[type="search"]` locator in an e2e spec silently matched the
  sidebar filter instead of the page's own search box (the pitfall documented in
  `CLAUDE.md`). Added `mentorship-search`, `users-search`, `board-search`,
  `mentors-search`, `interactions-search` and `company-search` (cohorts,
  organizations and sources already had one). Attribute-only; no behaviour change.
- Synced the stale `version` field in `package-lock.json` with `package.json`.

## [0.25.14] - 2026-07-24

### Changed
- **Deactivated candidates are archived by default.** The Adaylar (candidates)
  list now shows only **active** candidates by default; deactivated ("Devre dışı")
  candidates move to a separate **Archive** view via an Active | Archived toggle.
  `GET /api/candidates` defaults to `isActive: true` and accepts `?archived=1` to
  return the deactivated set (the toggle also drives CSV/Excel export, so exports
  match the visible view). Bulk activate from the archive restores candidates to
  the active list.

## [0.25.13] - 2026-07-27

### Added
- **Attachments in admin support replies.** Admins can now attach up to 10 PNG,
  JPEG, or PDF files/images when replying to a support ticket, reusing the same
  composer, image preview, pre-send removal, and client/server validation as the
  requester's side. A reply may contain text only, attachment(s) only, or both.
  Sent attachments render in the thread and remain downloadable by the requester
  and support admins via the existing protected attachment route.

## [0.25.12] - 2026-07-27

### Fixed
- **Projects list heading flashed a stale count while loading.** The "All
  projects" heading in `ProjectsManager` now only shows the `(N)` count after
  the initial fetch finishes, instead of showing `(0)` during the loading
  state.
- **Improved goal management (#785).** Goals can now be sorted newest or oldest
  first and edited inline. Completed goals are kept separate in a collapsible
  archive, where they can still be reopened or deleted.

## [0.25.11] - 2026-07-24

### Added
- **Reusable `Textarea` component** (`src/components/ui/Textarea.tsx`) with
  built-in character counting and visual feedback. Extends native `<textarea>`
  with `maxLength` and `showCounter` props. Counter displays current/max (e.g.
  "42/2000") and transitions: normal (gray) → warning (amber, 80 %+) → error
  (red, 100 %). Forwards ref; inherits dark-mode styling from the design system.
- **`useCharacterCounter` hook** (`src/hooks/useCharacterCounter.ts`) — returns
  `count`, `remaining`, `percentage`, and `state`; memoized to avoid unnecessary
  re-renders.
- Replaced every raw `<textarea>` across the app with the new component:
  `NotesPanel` (3 000), `RelationNotesPanel` (5 000), `QuestionsPanel` (2 000),
  `ProjectsManager` (5 000), `MentorshipRequestPanel` (2 000),
  `AddInteractionForm` (5 000), `EvaluationPanel` (2 000),
  `TargetedEmailComposer` (10 000), `CompanyForm` (2 000),
  `PublicContactForm` (5 000). All instances now have consistent styling, dark-mode
  support, and live character feedback.

## [0.25.10] - 2026-07-23

### Added
- **Recurring meeting-series API with automatic forward generation (#774).**
  Added `POST/PUT/DELETE /api/meeting-series` (ADMIN/MENTOR) to create, edit and
  cancel recurring meeting rules. A series rule (`daysOfWeek` + `timeOfDay` +
  horizon window) now auto-generates forward `Meeting` rows with `seriesId`
  linkage, deriving participants from project-member mentees and their active
  `MentorshipRelation`s (no manual relation selection). If no link is provided, a
  single stable Jitsi room is generated once per series and reused across all
  generated instances. Generation is idempotent per `seriesId + relationId +
  scheduledAt` (re-runs skip existing rows). Cancelling (`DELETE` / `active=false`)
  keeps existing meetings but stops new generation.

## [0.25.9] - 2026-07-23

### Added
- **Schema: `MeetingSeries` model + `Meeting.seriesId`** — foundation for recurring
  meetings. `MeetingSeries` stores the recurrence rule (`daysOfWeek`, `timeOfDay`,
  optional `projectId` / `fixedLink`). `Meeting.seriesId` (nullable) links
  auto-generated meeting instances back to their series; manually scheduled
  meetings are unaffected (backward-compatible, `seriesId` stays `null`).
- **Attachments for support messages.** Support messages now accept up to 10
  PNG, JPEG, or PDF attachments with client-side previews and validation.
  Attachments are stored atomically with their message and are available only
  to the requester and support admins.

### Changed
- **Support conversations now use the shared messaging UI.** Support message
  bubbles, pending-attachment previews, composer spacing, attachment button, and
  send button now come from the same shared components as mentorship messages.
  Support messages may contain text, attachments, or both; only an empty trimmed
  message with no attachments is rejected. Existing file validation, protected
  downloads, storage, and authorization are unchanged.

## [0.25.8] - 2026-07-23

### Fixed
- **Admins can now publish long announcements.** `POST /api/admin/announcements`
  capped `text` at 2 000 chars and returned a bare `400 Validation failed`, so
  long-form broadcasts (release notes, articles) were rejected. The cap is raised
  to 20 000 chars, and `Announcement.text` / `Notification.text` are widened from
  the Prisma default `VARCHAR(191)` to `@db.Text` so the longer text is actually
  stored (otherwise raising the cap would just move the failure to a DB 500). The
  400 response now also includes the zod `details` for easier debugging.

## [0.25.7] - 2026-07-23

### Fixed
- **Bulk meeting scheduling now creates one shared link (#759).** When
  scheduling a meeting for several mentees at once ("select all") without pasting
  a link, the auto-generated Jitsi room was created *inside* the per-relation loop
  — so each participant got a different room instead of joining the same meeting.
  The link is now generated once and shared across all selected participants; the
  per-person RSVP token stays unique. `src/app/api/meetings/route.ts`; regression
  test in `e2e/auto-meet-link.spec.ts`.

## [0.25.6] - 2026-07-23

### Changed
- **Per-tenant pipeline stages across all remaining surfaces (#747, Slice B —
  final).** The mentor & company shells now provide the stage context; the
  mentor/company/admin **analytics funnels** + dashboards, the mentor **kanban
  board**, and the candidate/mentor/company **detail** views all render the
  viewer tenant's resolved stage labels/order/colors. The write path
  (`PUT /api/mentorship/[id]`, `POST /api/status-changes`) now accepts free-string
  stage keys so custom stages can be assigned. Behavior-preserving for the default
  single-tenant setup. **Completes #747** — a tenant can define its own pipeline
  stages (Admin → Organizations → Edit stages) and see them everywhere. Known
  canonical-model limitations (board 3-phase grouping, bulk advance) documented in
  `docs/pipeline-stages.md`.

## [0.25.5] - 2026-07-23

### Changed
- **Per-tenant pipeline stages on the admin board + candidate filter (#747,
  Slice B — chunk 2).** The admin Kanban board (stage labels + the per-card
  "move to" stage picker) and the candidates page (pipeline-stage filter dropdown
  + stage labels + CSV/Excel export) now render the viewer tenant's resolved
  stages via the shared context (`PipelineStagesProvider` now wired into the admin
  layout too). Behavior-preserving for the default single-tenant setup; the board's
  three-phase grouping remains the canonical model (custom relabels/colors show
  through). Remaining: analytics funnels + mentor/company mirror surfaces.

### Changed
- **Per-tenant pipeline stages on the mentee journey (#747, Slice B — chunk 1).**
  The portal Journey tracker now renders the viewer tenant's resolved stages
  (custom labels / order / on-path / terminal) instead of the hardcoded canonical
  path — via a server-fed client context (`PipelineStagesProvider` +
  `useResolvedStages`/`useStageLabel`) wrapped in the portal layout. The pure
  stage helpers (`ResolvedStage`, `defaultPipelineStages`, `onPathKeys`,
  `stageLabel`) moved to the client-safe `src/lib/pipeline.ts`. Behavior-preserving
  for the default single-tenant setup (falls back to the canonical, locale-aware
  defaults). Remaining surfaces (board / candidate filter / analytics) follow in
  the next chunk.

### Changed
- **Pipeline stage storage is now a free String (#747, Slice C).**
  `MentorshipRelation.pipelineStatus` and `StatusChange.fromStatus/toStatus`
  changed from the `PipelineStatus` enum to `String`, so a tenant can store its
  **own** stage keys (not just the canonical 13). **Data-safe:** MySQL
  `ENUM → VARCHAR` preserves every existing value, and the canonical keys/labels
  still live in `src/lib/pipeline.ts` (the enum block is retained as the default
  key registry), so single-tenant behaviour is identical. Covered by
  `e2e/pipeline-custom-key.spec.ts` (custom keys persist; canonical keys still
  work). Surfaces rendering resolved custom stages land in Slice B.

### Added
- **Per-tenant pipeline stages — admin UI (#747, Slice A.2).** Admin →
  Organizations now has an **Edit stages** link per tenant → a
  `/admin/organizations/[id]/pipeline` editor to relabel, reorder (▲/▼),
  recolor, and mark stages on-path/terminal, or reset to the built-in defaults.
  Backed by the Slice-A management API; premium-gated (saving disabled on FREE)
  and behavior-preserving (a tenant with no custom stages still uses the
  canonical defaults).

## [0.25.1] - 2026-07-22

### Added
- **Per-tenant pipeline stages — foundation (#747, part of white-label #546).**
  New `PipelineStage` model (per-org: key / label / order / on-path / terminal /
  color) plus a resolution layer (`src/lib/pipelineStages.ts`,
  `resolvePipelineStages`) that falls back to the built-in canonical 13 stages
  when a tenant has none — so single-tenant production is unchanged. Admin-only,
  premium-gated management API at
  `/api/admin/organizations/[id]/pipeline-stages` (GET / PUT / DELETE-reset).
  Relations still store the `PipelineStatus` enum in this phase (no data
  migration); applying resolved stages to the board/filters/analytics/journey and
  moving storage off the enum land in later slices. Additive `db push`.

### Added
- **Enterprise SSO — live SAML sign-in (closes the wiring for #545 / story #522).**
  The SP-initiated SAML round-trip is now implemented with
  `@node-saml/node-saml`, gated behind `isSsoActive(org)`:
  - `/auth/sso` (linked from the sign-in page) → `/api/auth/sso/[slug]/login`
    builds the AuthnRequest and redirects to the tenant's IdP.
  - `/api/auth/sso/[slug]/acs` verifies the signed assertion against the org's
    stored certificate (audience/recipient/expiry checked), maps the profile
    (`mapSamlProfile`), JIT-provisions the user (`provisionSsoUser`), and mints a
    single-use `SsoLoginGrant`.
  - A new `sso` NextAuth Credentials provider consumes that grant on
    `/auth/sso/complete` to issue the session — mirroring the impersonation grant
    flow. No password, no IdP secret stored in our env.
  - New `SsoLoginGrant` model (single-use, short-lived; additive `db push`).
  - **Gated + non-breaking:** SSO only activates for a tenant whose config is
    complete and enabled; password login is unchanged for everyone else. No org
    has SSO enabled in production, so this is inert there until configured.
  - Verify on preview with mock-saml.com (no real IdP needed) — see
    `docs/sso-saml.md`. Pointing at a real Okta/Azure/Auth0 IdP is a config-only
    step (paste issuer / SSO URL / signing cert into Admin → Organizations).

## [0.24.3] - 2026-07-22

### Added
- **SSO just-in-time (JIT) provisioning (part of #545 / story #522).** New
  `provisionSsoUser()` (`src/lib/ssoProvisioning.ts`) maps a verified IdP identity
  to a `User` in the tenant org — creating one on first login (default
  least-privilege `MENTEE`, or an IdP-mapped role), adopting a not-yet-tenanted
  user into the org, and refusing to relocate an email that already belongs to a
  different tenant. Idempotent per email; covered by
  `e2e/sso-provisioning.spec.ts`. This is the tenant-mapping half of #545's
  criteria; the live SAML/OIDC round-trip that calls it stays deferred until a
  real tenant IdP is available (see `docs/sso-saml.md`). No runtime auth change.

### Changed
- **Tenant isolation rolled out to all authenticated API routes (part of #543 /
  story #522).** Every API route handler that queries a tenant-anchored model now
  wraps its body in `withTenantScope(session, …)`, so the central enforcement
  middleware auto-scopes all of its queries to the request's organization once
  `MT_ENFORCE_ISOLATION` is enabled. Behavior-neutral while the flag is off
  (`withTenantScope` is a pure passthrough), so single-tenant production is
  unchanged. Public/token-based routes (register, apply, forgot-password, invite
  acceptance) are intentionally left unscoped (no session; subject resolved from
  the token).

### Added
- **Tenant-branded transactional emails (part of #546 / story #522).** The
  account-lifecycle emails (invitation, password reset / set-initial, email
  verification) now render the recipient organization's white-label brand — brand
  name in the subject + From display name + heading, the org logo when set, and
  the org accent color on the heading/button — resolved via `getOrgBranding`.
  Callers that have the recipient's `orgId` (invite, forgot-password, admin
  reset/company-user/source-user creation, apply, mentee creation, verification
  resend) pass it through; when no org resolves it falls back to the product
  defaults, so single-tenant emails are unchanged. `sendEmail` gained an optional
  `fromName` override.

### Added
- **Tenant isolation enforcement engine (part of #543 / story #522).** A single
  central Prisma `$use` middleware, driven by a request-scoped
  `AsyncLocalStorage` org context (`src/lib/orgContext.ts`), now auto-scopes
  every query on a tenant-anchored model (`User`, `Source`, `Company`,
  `Project`, `Cohort`, `MentorshipRelation`) to the current request's
  organization — the "can't forget the filter" guarantee behind the guarded
  multi-tenancy rollout. Reads/updates/deletes get an `orgId` `where` filter
  (Prisma 5 `extendedWhereUnique` covers `findUnique`/`update`/`delete`);
  `create`/`createMany`/`upsert` get `orgId` stamped into their data.
  - Route handlers opt in by wrapping their body in
    `withTenantScope(session, …)`; adopted on `GET/POST /api/mentorship`,
    `/api/companies`, `/api/projects` as the reference implementation (the rest
    roll out incrementally).
  - **Entirely gated behind `MT_ENFORCE_ISOLATION` (default off):** when the
    flag is off, `withTenantScope`/`runWithOrg` are straight passthroughs and
    the middleware early-returns, so single-tenant production is unchanged. The
    engine is server-only (`node:async_hooks`) and kept out of `prisma.ts` so it
    never enters a client bundle.
  - `e2e/tenant-isolation.spec.ts` now proves a **plain query that never called
    `orgScoped()`** is still isolated purely by running inside `runWithOrg()`
    with the flag on — and is a no-op with the flag off.

## [0.23.3] - 2026-07-22

### Added
- **Mentor analytics page** (`/mentor/analytics`) — mentor-scoped pipeline funnel,
  interaction total, active mentee count, hired/employed outcomes, and goal summary;
  part of issue #370 Mentor lens.
- **Company analytics page** (`/company/analytics`) — company-scoped candidate funnel
  by pipeline stage plus interest-signal breakdown (interested / shortlisted / pass /
  pending); part of issue #370 Company lens.
- **Bulk stage-advance for candidates** — admins can now multi-select candidates on
  `/admin/candidates` and click "Advance stage" to push all selected mentees one
  pipeline step forward along the on-path sequence (with `StatusChange` audit records);
  part of issue #370 HR lens.
- **Milestone recognition banner** in the mentee portal journey tracker — a gold Trophy
  banner appears at key stages (internship starting, in-progress, completed, hired,
  employed) to celebrate progress; part of issue #370 Mentee lens.
- Navigation links added to mentor and company sidebars for their respective analytics
  pages.

## [0.23.2] - 2026-07-22

### Fixed
- **Emoji reaction can now be changed, not just removed (closes #735).** Previously,
  clicking a different emoji in the picker when you already had a reaction would add a
  *second* reaction alongside the existing one; clicking your own reaction chip would
  immediately remove it with no way to swap it for another. Now:
  - Selecting a **different** emoji atomically replaces the current reaction (server
    deletes the old row and inserts the new one in a single transaction).
  - Clicking your **own** reaction chip opens the emoji picker so you can choose a
    new emoji or click the same one to remove it.
  - The picker **highlights** the emoji you have already selected, making the current
    state immediately visible.

## [0.23.1] - 2026-07-22

### Fixed
- **"Enter to send" toggle knob overlapped the label** — the switch knob's travel
  overshot the track and clipped the first letter of the label when on; the knob
  now stays within the track (`translate-x-3`, `shrink-0`).

### Added
- **Composer hint + edit-last shortcut** — a small hint under the reply box notes
  you can paste an image and that **↑ (ArrowUp)** on an empty box edits your last
  message (WhatsApp/Slack/Telegram style).

## [0.23.0] - 2026-07-22

### Added
- **Inline editing for mentee portal notes (closes #656)** — mentees can now edit their own notes directly in the portal, save or cancel their changes, and receive validation and update feedback. Related E2E coverage verifies editing, cancellation, whitespace validation, and owner-only authorization.

## [0.22.0] - 2026-07-21

### Added
- **White-label chrome — tenant brand applied to the live app (part of #546 /
  story #522).** The app wordmark (sidebar header + mobile top bar across the
  admin/mentor/portal/company/source shells) now renders the signed-in user's
  **organization brand name and logo** instead of the hardcoded "Internship CRM".
  A new self-resolving `BrandWordmark` server component reads the org branding
  (`getOrgBranding`) and falls back to the product default when the org has no
  branding or there's no org, so single-tenant chrome is unchanged. Branding is
  managed at `/admin/organizations` (already shipped). Follow-ups tracked
  separately: applying `brandColor` to the accent palette, per-recipient email
  branding, and custom pipeline stages (#546 remainder).

## [0.21.0] - 2026-07-21

### Added
- **"Enter to send" toggle in the message composer** — a small per-user switch
  under the reply box lets you choose how Enter behaves. When on, **Enter sends**
  and **Shift+Enter** inserts a new line; when off (the default), **Enter** inserts
  a new line and **Shift+Enter** sends. The choice is remembered per device
  (`localStorage`). Handles IME composition (won't send mid-composition).

## [0.20.0] - 2026-07-21

### Added
- **Unread-message email digest (closes #667)** — an hourly cron
  (`sendUnreadMessageDigests`) gathers messages left unread for over an hour,
  groups them per recipient, and sends **one** summary email (sender + preview +
  "Open" link) instead of nagging per message. Idempotent via a new
  `Message.digestedAt` flag (a message is never digested twice), and it respects
  each recipient's email opt-out (`emailAllowed(user, 'messages')`). The instant
  in-app notification is unchanged; this is an additive "still unread" reminder.
  Completes the WhatsApp-like messaging story (#663) under the Communication
  epic (#717).

## [0.19.0] - 2026-07-21

### Added
- **Emoji reactions on messages (closes #665)** — react to a message with 👍 ❤️
  😂 😮 🎉 (WhatsApp/Slack style). Reaction chips show the emoji + count and
  highlight the ones you added; tapping a chip or picking from the emoji button
  toggles your reaction.
  - Schema: new `MessageReaction` model (`@@unique([messageId, userId, emoji])`),
    `Message.reactions` (additive `db push`).
  - API: `POST /api/messages/[id]/reactions` toggles the caller's reaction
    (thread participants/admin only; emoji restricted to the fixed set);
    `GET /api/messages` returns a per-message reaction summary (emoji → count +
    whether you reacted).
  - Advances the WhatsApp-like messaging story (#663) under the Communication
    epic (#717).

## [0.18.0] - 2026-07-21

### Changed
- **WhatsApp-style read receipts (closes #664)** — in a conversation thread, your
  own messages now show tick icons instead of a "Sent/Read" text label: a single
  tick (✓) when delivered and a blue double tick (✓✓) once the other party has
  opened the thread. Shown on every message you sent (not just the last), with
  accessible `Sent`/`Read` labels retained on the icons. Part of the WhatsApp-like
  messaging story (#663) under the Communication epic (#717).

## [0.17.1] - 2026-07-21

### Fixed
- **Dark-mode contrast on colored info boxes (closes #658, #659)** — the compound
  dark-mode override "safety net" in `globals.css` now also remaps the darker
  `text-*-800/900` and lighter `text-*-500` shades (not just 600/700) on
  `bg-*-50` boxes, for blue/green/red/amber/indigo/yellow/**purple**. This fixes
  the dark-on-dark text on the portal's amber "complete your profile" heading
  (`text-yellow-800`) and blue/green labels (`text-blue-500`, `text-green-500`)
  without per-element `dark:` utilities, and covers the same class of boxes
  app-wide. Completes the dark-mode contrast story (#657) under the UX epic (#718).

## [0.17.0] - 2026-07-21

### Added
- **Candidate list: filter by pipeline stage (closes #691)** — the admin
  candidates filter panel now has a pipeline-stage dropdown (bound to the existing
  `statusFilter`, so it stays in sync with the dashboard bars, the `?status=` URL
  param, and Saved Views). Clear-filters resets it too.

### Changed
- **Portal journey tracker moved above the fold (closes #692)** — a mentee now
  sees their pipeline stage as soon as the portal loads, above the (longer)
  mentorship card, instead of having to scroll past it.
- Both complete the Pipeline stage-visibility story (#704) under the UX epic (#718).

## [0.16.0] - 2026-07-21

### Added
- **Admin ⊇ mentor parity — completes the Admin Capabilities epic (#719; closes
  #661, #707, #708).** Admins can now do, from their own UI, what a mentor can:
  - **Log an interaction** from the candidate detail screen (Meeting/Feedback/
    Email/Call/WhatsApp) via a new inline `AddInteractionForm` — `POST
    /api/interactions` already authorized ADMIN.
  - **Send targeted email to mentees** from a new `/admin/email` page (AdminNav
    entry). The mentor and admin screens now share a `TargetedEmailComposer`
    component; `/api/mentor/email` already authorized ADMIN and respects each
    recipient's email opt-out.
  - (Meeting parity + copy-link shipped earlier in 0.9.0.)

## [0.15.0] - 2026-07-21

### Added
- **Message editing + advanced delete (closes #666)** — in a conversation thread
  you can now **edit** your own messages (an "edited" label appears) and **delete**
  them WhatsApp-style: **delete for everyone** (sender/admin — the message is
  masked server-side and shows a "This message was deleted" placeholder for both
  sides, body + attachments dropped) or **delete for me** (any participant — hides
  it from your own view only).
  - Schema: `Message.editedAt`, `Message.deletedForEveryoneAt`, and a new
    `MessageHiddenFor` model for per-user hiding (additive `db push`).
  - API: `PATCH /api/messages/[id]` (edit, sender-only) and
    `DELETE /api/messages/[id]?scope=everyone|me` with server-side authorization;
    `GET /api/messages` masks deleted-for-everyone bodies and filters out
    hidden-for-me messages so nothing leaks.

## [0.14.7] - 2026-07-21

### Fixed
- **Mentor onboarding checklist never dismissed (closes #690)** — the
  `scheduleMeeting` step was hard-coded `done: false` and, being counted by the
  `steps.every(done)` check, kept the checklist on screen forever even after the
  mentor finished everything. `scheduleMeeting.done` is now computed from the
  mentor's actual meeting count, and `OnboardingChecklist` decides completion
  from **required** steps only, so an optional step can no longer pin the
  checklist open.

## [0.14.6] - 2026-07-21

### Fixed
- **Silent API failures swallowed with `.catch(() => {})` (closes #679)** — the
  admin analytics page and the candidate-detail dropdowns dropped fetch errors
  on the floor, so a failed load looked like empty data with no signal. The
  analytics page now surfaces a load error banner (and logs it); the
  candidate-detail project/cohort/source dropdown loads log their failures
  instead of swallowing them; and the evaluation panel shows an inline error
  when a submission fails instead of silently doing nothing.

## [0.14.5] - 2026-07-21

### Fixed
- **Account language selector out of sync with the UI (closes #653)** — the
  selector read the DB `preferredLanguage` while `getLocale()` lets the `locale`
  cookie win, so a `tr` cookie + `en`/null preference showed "English" over a
  Turkish UI. The selector now reflects the effective (cookie-first) locale and
  converges `preferredLanguage` to it so they can't diverge again; the locale
  cookie is written with `samesite=lax` (matching theme/accent).

## [0.14.4] - 2026-07-21

### Fixed
- **Portal "email mentor" dead button (closes #654)** — the mentee portal had a
  bare `mailto:` button that did nothing when no mail client was configured.
  Removed it; the reliable **in-app "Message mentor"** button (already primary)
  stays, and the mentor's email address is now a `mailto:` link itself (visible +
  copyable + best-effort), so contact works in every environment.

## [0.14.3] - 2026-07-21

### Fixed
- **CSV bulk import now sets `orgId` (closes #678)** — imported MENTEE users
  inherited no org, so they fell outside the tenant's plan-limit counts and
  (with `MT_ENFORCE_ISOLATION`) isolation. `POST /api/admin/import` now sets
  `orgId: resolveOrgId(session)` on create, matching every other create path
  (mentor add-mentee, apply). Null-org admins are unaffected (single-tenant).

## [0.14.2] - 2026-07-21

### Fixed
- **`/icon.svg` 500 (closes #689)** — `public/icon.svg` and `src/app/icon.svg`
  both claimed the `/icon.svg` route (the App Router serves `src/app/icon.svg`
  as `/icon.svg` automatically, and the `public/` copy collided). Removed the
  duplicate `public/icon.svg`; the app-router icon still serves the favicon and
  manifest/layout references.

## [0.14.1] - 2026-07-20

### Fixed
- **Meeting links were mislabeled "Google Meet"** — the app auto-generates
  **Jitsi** meeting links, but the invite email and the scheduler label called
  them "Google Meet". Relabeled to a provider-neutral "Meeting link"
  (email template + `meetLink` in EN/TR/DE), and corrected the feature-catalog
  comms description ("video meeting invites" instead of "Google Meet invites").

## [0.14.0] - 2026-07-20

### Added
- **Mentee project members with functional roles (#51)** — projects can now
  include **mentee** members, each tagged with a functional (job) role:
  Developer, Tester, or Marketing. Managed from the project owners/members panel
  (`/admin/projects`, `/mentor/projects`) via a dedicated mentee picker.
  - Schema: `ProjectMember.functionalRole` (nullable enum
    `ProjectFunctionalRole`), plus `MENTEE` added to `ProjectMemberRole`
    (additive, safe `db push`).
  - `POST /api/projects/[id]/members` accepts `role: 'MENTEE'` + `functionalRole`;
    mentees can never be owners, and the last-owner protection is unchanged.

## [0.13.0] - 2026-07-20

### Added
- **Browser notifications for new messages (foreground, #675 Kademe 1)** — when
  the user opts in (Account → Notifications) and grants the browser permission,
  a desktop notification fires for each new unread in-app notification while the
  app is open in a tab. Per-device preference in `localStorage` (no schema
  change); dedupes by notification id and never bursts on the first poll. New
  `src/lib/browserNotifications.ts` helper, wired into `NotificationBell`.
  Background web-push (Kademe 2) remains a separate follow-up.

## [0.12.0] - 2026-07-20

### Added
- **Membership duration indicator** — the account page now shows how long you've
  been a member ("Member for 3 months", from `User.createdAt`), and the project
  owners/members panel shows how long each person has been on that project (from
  `ProjectMember.addedAt`). New `durationSince` helper in `src/lib/relativeTime.ts`
  and a localized `membership` i18n block (EN/TR/DE). `/api/projects` now includes
  `addedAt` on member rows.

## [0.11.0] - 2026-07-20

### Added
- **Paste images into a message** — paste from the clipboard straight into the
  reply box; pasted images (and picked files) appear as instant thumbnails you
  can click to preview and remove before sending.
- **Multiple attachments per message** (closes #655) — the compose box and
  `POST /api/messages` now accept several files at once (`form.getAll('file')`,
  capped at 10); each becomes a `MessageAttachment`.
- **Attachments are included in the notification email** — pasted images and
  files are mirrored into the recipient's email as attachments (`sendEmail` now
  supports `attachments`).

### Added
- **"Select all" in the meeting scheduler** — one checkbox to select every
  mentee in the list at once (`MeetingsManager`).

### Changed
- **Meeting time is now optional** (#417): `Meeting.scheduledAt` is nullable.
  A meeting **with** a time behaves as before (RSVP expected + reminder email);
  a meeting **without** a time is just a shared link — no RSVP ask, no reminder.
  The scheduler no longer requires a time, and the invite email / list UI omit
  the "when" + RSVP parts when there is no time.

### Fixed
- **Project detail back link** — the top link on `/projects/[id]` now returns
  internal viewers to their own project list (`/admin/projects` or
  `/mentor/projects`) with a clear back arrow, instead of always sending them to
  the public showcase. Public visitors keep the showcase link.

## [0.9.0] - 2026-07-20

Admin↔mentor parity and quality-of-life additions on top of the multi-tenancy
foundations.

### Added
- **Admin meetings** (#661): a `/admin/meetings` page (shared `MeetingsManager`
  with the mentor screen) so admins can schedule/see meetings, plus a **one-click
  "Copy link"** on every meeting (mentors benefit too). AdminNav entry added.
- **Schedule a meeting from the candidate screen** (#661): a meeting scheduler +
  copyable-link panel on `/admin/candidates/[id]`, scoped to the candidate's
  mentorship relation.
- **Archive/restore mentors** from the Mentors list — Active/Archived view + a
  per-row deactivate/activate action, reusing the Users archive mechanism (#570).

### Changed
- **Plan limits are now enforced** (#547): the FREE/PRO active-mentorship limit
  is a real gate at the four relation-create paths (existing mentees are never
  affected; the grandfathered default org is ENTERPRISE/unlimited so single-
  tenant prod is unchanged).

## [0.8.0] - 2026-07-17

Multi-tenancy foundations (an operator can now run several programs on one
instance), a cross-program benchmark, a Google Calendar integration surface,
and a production sign-in fix.

### Added
- **Multi-tenancy — organizations** (#543/#544): `Organization` model +
  nullable `orgId` on the tenant-scoped models with an idempotent backfill to a
  default org; super-admin **Organizations** screen (create tenants, per-tenant
  row counts). Additive and reversible — single-tenant behaviour unchanged.
- **Per-tenant plan tiers** (#547): `OrgPlan` (FREE/PRO/ENTERPRISE) with an
  in-code limits catalogue (`src/lib/orgPlans.ts`); the admin screen shows
  usage-vs-limit and a per-tenant plan selector. Limits are advisory this phase;
  the legacy default org is grandfathered to ENTERPRISE.
- **Per-tenant white-label branding** (#546): name/logo/accent/support overrides
  on `Organization` + resolver (`src/lib/branding.ts`) + admin editor.
  Documented in `docs/white-label.md` (applied once tenant resolution lands).
- **Per-tenant enterprise SSO config** (#545): SAML/OIDC config + validation +
  gating (`src/lib/sso.ts`); admin editor; the certificate is never returned to
  the client. Login wiring documented in `docs/sso-saml.md`.
- **Tenant-isolation enforcement building blocks** (#543): `src/lib/orgScope.ts`
  (`orgScoped`/`requireOrg`/`assertSameOrg`) behind `MT_ENFORCE_ISOLATION`
  (default off) + `orgId` carried in the session; `docs/tenant-isolation.md`
  describes the guarded roll-out.
- **Cross-program benchmark** (#542): anonymized, aggregated funnel conversion
  vs. platform average with a k-anonymity floor; gated by `premiumAnalytics`.
- **Google Calendar integration surface** (#417): config detection + admin
  status card + `docs/google-calendar.md` runbook (OAuth wiring deferred until
  operator credentials exist). In-app calendar/.ics/reminders unchanged.

### Fixed
- **Safari sign-in loop**: after `signIn`, the immediate session read could miss
  the just-set cookie in Safari, redirecting to the wrong place or bouncing back
  to sign-in. Now polls for the session then does a full-page navigation.
- **Forgot-password never arriving**: email lookups are now normalized
  (trim + lowercase) at register/sign-in/forgot, so a casing/whitespace
  difference can't silently miss the account (SMTP itself was healthy).

### Changed
- **CI cost control**: hosted workflows (ci, e2e, deploy preview/prod, e2e-full,
  stress, topic-preview) paused to `workflow_dispatch`-only while the GitHub
  Actions quota is exhausted; production deploys via the self-hosted
  `deploy-prod.yml`. Re-enable by restoring the commented triggers.

## [0.7.0] - 2026-07-11

A faster CI feedback loop and a rebuilt Projects experience with true
multi-owner/multi-mentor collaboration.

### Added
- **Projects redesign** (#614): card-first screen — the create/edit form only
  opens via "Add project" or a card's edit action (#615); detailed cards with
  member chips + a Detail link, and an internal `/projects/[id]` view for
  admins/owners (status, dates, goals, members, task progress) while the
  public showcase stays PII-free (#616).
- **Multiple owners & mentors per project** (#617) — new `ProjectMember`
  model with an idempotent backfill on deploy/seed; `/api/projects/[id]/members`
  with a last-owner guard; legacy single-owner pointer kept in sync.
- **Owner management & transfer UI** (#618) — per-card panel to add/remove
  members, change roles and transfer ownership in one flow; mentors get a
  minimal PII-free directory for the picker.
- **Owner-only field permissions** (#619) — name/status/visibility/dates and
  deletion are owner-only (server-enforced 403 + disabled inputs); description,
  technologies, links, goals and tasks are collaborative for all members, and
  mentors now see projects they are members of.
- **One-time infra-setup workflow** (#583 follow-up) — wildcard DNS, wildcard
  TLS (acme.sh over SSH) and nginx-permission verification as a manual,
  idempotent Actions run.

### Changed
- **PR quality gate now runs the `@smoke` subset** (17 tagged critical-path
  tests, ~3.5 min instead of ~10) (#621–#623); the **full suite runs 4× a day**
  via `e2e-full.yml` (4-way sharded) and emails the team on failure (#624).


## [0.6.0] - 2026-07-11

Self-serve mentee intake, a built-in support channel, a public feature
catalogue, and isolated per-topic preview environments for the growing
contributor team.

### Added
- **Mentee self-registration** (#589) — the token-less signup now creates a
  MENTEE (inactive until admin approval) instead of a MENTOR; new mentees land
  on the portal after activation.
- **Mentorship requests** (#590, #591) — mentees without an active mentorship
  request one from the portal (one pending request at a time, rate-limited);
  admins approve from a queue on /admin/mentorship, picking the mentor —
  approval creates the relation and notifies both sides. Requests are gated on
  onboarding: profile basics (university + skills) and an uploaded CV are
  required, enforced server-side and explained in the UI.
- **Support tickets** (#592–#594) — every user gets a pinned "Support"
  conversation in Messages: the first message opens a ticket, replies join the
  open ticket, closed tickets start fresh ones. Admins work a queue at
  /admin/support with status filters (open / in progress / closed), inline
  reply, assignment and status transitions; both sides get notifications.
- **Feature catalogue** (#587, #588) — public /features page (EN/TR/DE,
  categorized) backed by a single-source feature list that also feeds the
  landing cards; "All features" links from the landing header, grid and footer.
- **Topic-based ephemeral previews** (#583) — branches carrying a `topicN`
  token deploy to their own `crm-<topic>.ersah.in` container and are torn down
  when the PR closes; topic-less branches keep the shared preview. Includes a
  wildcard-TLS/nginx runbook under `infra/`.


## [0.5.0] - 2026-07-11

Premium Faz 1 completion (GDPR consent) and the full Faz 2 tier — premium
analytics and the AI package — plus small admin/mentor improvements. Mentor
and mentee experience stays free; mentees never see a paywall.

### Added
- **Talent-pool visibility consent** (Faz 1, #527) — company-facing exposure now
  requires an explicit, revocable mentee consent in addition to publicProfile;
  talent-pool search and need-match alerts enforce it. A portal banner nudges
  undecided mentees (decision — grant or decline — dismisses it permanently).
- **Premium analytics tier** (Faz 2, gated by the new premiumAnalytics setting;
  basic analytics stay free):
  - Cohort comparison — conversion, time-to-hire, engagement side by side (#538)
  - Source conversion report — hire rate per referral source (#539)
  - Full report export — multi-sheet Excel + print/PDF report page (#540)
  - Weekly scheduled analytics email to admins (#541)
- **AI package** (Faz 2, all through the central AI gate):
  - Central AI gate — consent → monthly quota (aiMonthlyQuota setting, AiUsage
    metering; only successful calls consume credit) → provider (#537)
  - AI summary of interaction logs for mentors, gated by a new mentee consent (#534)
  - AI CV improvement feedback for mentees — free for the mentee (#535)
  - AI interview-prep assistant on the mentee portal — free for the mentee (#536)
  - AI-deepened mentor matching with rationale + graceful rule-based fallback;
    no personal identifiers ever reach the provider (#533)
- **Free-core regression shield** (#526) — e2e proving every core mentor/mentee
  flow works with zero entitlements.
- **Synthetic demo seed + contributor data-access policy** (#550) — `npm run
  seed:demo`, local-only guard, docs/DATA_ACCESS_POLICY.md.

### Fixed
- Company edit no longer fails on empty optional fields (#569).

## [0.4.0] - 2026-07-10

Company Premium (freemium Faz 0 + Faz 1) plus messaging, activity reporting,
email deliverability and a round of UX fixes — shipped as individual PRs. The
mentor and mentee experience stays fully free.

### Added
- **Premium entitlement infrastructure** (Faz 0) — per-company feature flags
  (`CompanyEntitlement`), a client-safe feature catalogue, `hasFeature` gating,
  and an admin toggle UI. Row-presence = feature on; nothing on by default so
  the free core is preserved (#557).
- **Talent-pool search** (Faz 1) — companies with the entitlement can search a
  privacy-safe pool of mentees who opted into a public profile (#560).
- **Verified candidate card** (Faz 1) — gated section on the company candidate
  view surfacing mentor evaluations + project contributions (#529).
- **CompanyNeed match alerts** (Faz 1) — a daily scan notifies premium companies
  when a consenting candidate matches an open position, deduped per candidate
  (#530).
- **Early-access window** (Faz 1) — newly-hireable candidates are visible only to
  early-access companies for a configurable window before opening to all
  subscribers (#531).
- **Messaging inbox icon** — a header entry point (admin/mentor) plus a unified
  `/messages` inbox (#512).
- **Daily mentee activity report** — page-view/dwell tracking foundation plus a
  daily digest and in-app view (#513/#514).
- **Admin email-test tool** — send a probe to any address and see SMTP status,
  for diagnosing deliverability (#553).
- **Mentor engagement signals** — a "no open goal" attention-queue badge and a
  stale-mentee in-app notification, deduped per staleness episode (#571/#572/#573).
- **Archive view for users** — deactivated accounts drop out of the default
  Users list and live under an "Archived" tab (#570).
- **User-selectable accent color** + a fuller preview-green theme (#511).
- **Inline mentor assignment** from the admin Candidates screen (#564).

### Fixed
- **P0 mobile account menu** — the responsive drawer no longer closes on the
  account toggle, so mobile users can reach Sign out (#563).
- **Company edit validation** — optional fields left empty (NULL in the DB) no
  longer fail with "Expected string, received null" (#569).
- **Email deliverability** — plain-text alternative part + a named From header
  to improve inbox placement (#562).
- **Company interest note** now auto-saves after typing stops (#532).

## [0.3.0] - 2026-07-03

Backlog epics A–L plus user-reported feedback, shipped as individual PRs.

### Added
- **Meetings, RSVP & calendar** (EPIC D) — meetings surface on the admin/mentor
  calendar, RSVP flows feed analytics, auto Meet link + reminders (#417/#432).
- **Mentor management & capacity** (EPIC A/B) — skill-overlap matching, mentor
  expertise + capacity, at-capacity flags, mentor detail page (#414/#415).
- **Analytics accuracy** (EPIC G) — time-in-stage computed from real
  `StatusChange` history + a date-range selector (#420).
- **Kanban grouping** (EPIC I) — 13 stages grouped into collapsible phases
  (pre/internship/outcome), WIP warnings, overdue badges (#422).
- **Auth hardening** (EPIC J) — role-based 2FA enforcement gate, 12h session
  timeout, and "sign out of all devices" session revocation (#423).
- **Category cookie consent** (EPIC K) (#424) and full EN/TR/DE localization
  (EPIC E) (#418).
- **CI/CD gates** (EPIC L) — production deploy gated on E2E success
  (`workflow_run`) + i18n EN/TR/DE parity check (#425).
- **List UX** (EPIC H) — candidates + mentorships pagination and search (#421).
- Invitation lifecycle with timestamped history (#433/#434); change toasts on
  candidate detail (#436); editable notes; a dedicated My Notes page; interaction
  log subject/filter; message attachments; adjustable font size (Betül feedback).

### Fixed
- P0: never-activated users were shown a "deactivated" dead-end at sign-in with
  no way to resend verification (#447).
- Generated mentee placeholder emails are ASCII-transliterated (EPIC F) (#419).
- Onboarding checklist card on the dashboard was nearly unreadable in dark mode (#389).

## [0.2.0] - 2026-07-01

### Added
- **Dark mode** — OS-aware by default, user-togglable, preference persisted per-user (#343).
- **CV tools**:
  - Local, no-AI parsing of an uploaded CV → suggests contact links and skills for the profile (#361).
  - Reusable per-user consent framework (GDPR) gating optional data processing (#362).
  - Optional AI-assisted CV extraction (name, city, university, department, target position), gated behind explicit consent and only active when configured (#363).
- **Document templates v2** — multilingual (EN/TR/DE) catalog with an in-app preview and export to PDF / TXT / Markdown (#357).
- **Public profile**: language + theme toggles, a link back to the product, and a spam-protected contact form that notifies the profile owner (#382).
- **Skill self-assessment** — replaced the 1–5 numeric dropdown with a click-to-set star rating (#384).
- **App version display** + this changelog + a user-facing "What's new" page at `/release-notes`.
- Secure local-dev database setup docs (Docker MySQL, no shared-DB exposure) (#366).

### Fixed
- CV URL field no longer shows the internal upload path; hidden once a file CV exists (#355).
- Dark-mode contrast/visibility issues: hover states, native `<input>`/`<select>`, the translucent landing header, role cards, and the impersonation banner (#364, #380).
- Mentee portal sidebar now highlights the active page (#380).
- Public contact form's honeypot no longer leaks the anti-spam trap via a validation error.

## [0.1.0] - 2026-01-01

Initial platform baseline (predates formal changelog tracking): mentor↔mentee
pipeline tracking, role-scoped dashboards (admin/mentor/mentee/company/source),
interaction logging, Kanban board, calendar & reminders, analytics, document
uploads with versioning, two-factor authentication, invitation-based
registration, and English/Turkish/German localization.

[Unreleased]: https://github.com/21072026/Internship/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/21072026/Internship/releases/tag/v0.2.0
[0.1.0]: https://github.com/21072026/Internship/releases/tag/v0.1.0
