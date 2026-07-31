# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/). The app
version is shown in the sidebar footer of every page (links to the
[user-facing release notes](src/lib/releaseNotes.ts), rendered at
`/release-notes`) and in the landing-page footer.

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
