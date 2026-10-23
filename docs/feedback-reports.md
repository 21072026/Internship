# In-app bug & feedback reports

Epic #3129 · Phase 1 #3130 (this document) · Phase 2 session replay #3131 · Phase 3 GitHub / notifications / retention #3132

A floating button on every signed-in screen lets a person report a problem or
give feedback with a screenshot and the technical context of the page attached.
The support team reads, filters and triages the reports at
`/admin/support/reports`, next to the conversation queue at `/admin/support`.

## Why a report is not a `SupportTicket`

A ticket is a **conversation** (messages back and forth, assignment, read
state). A report is a **structured record** the support team triages: type,
rating, screenshot, console and network context, a status. Folding the second
into the first would have put a JSON blob and a screenshot into a chat bubble
and given the ticket a second status vocabulary. They stay two models; Phase 3
can link a report to a ticket when the person allowed contact.

## The flow

1. `FeedbackWidget` (mounted once in `src/app/providers.tsx`, renders nothing
   signed out) installs the collector when the session is authenticated.
2. Opening the panel **takes the screenshot first**, before the panel renders,
   so the panel is never in the picture. The person can remove or retake it.
3. The person picks bug / feedback, optionally rates 1–5, describes the problem,
   optionally attaches files (picker, drag & drop, or paste), and **must** say
   whether we may contact them.
4. Send posts one `multipart/form-data` request to `POST /api/support/reports`.

Clicks: open → (type the description, choose contact) → Send. The contact
choice is a required answer by design (#3130), which is why the count is
"open + Send" plus two answers rather than two clicks flat.

## What is captured, and how it is masked

| Layer | Where | Rule |
|---|---|---|
| Screenshot | `src/lib/feedbackScreenshot.ts` | DOM → image in the browser (`modern-screenshot`), visible viewport only, JPEG. Anything under `[data-feedback-ui]` is left out; `input[type=password]`, `autocomplete="one-time-code"` / `cc-*` inputs and anything marked `data-private` or `.rr-block` are painted over **in the copy** before rendering. Its own image/font fetches are not recorded as failed requests. |
| Console | `src/lib/feedbackCollector.ts` | the newest 20 of `console.error`, `window.onerror`, `unhandledrejection` |
| Network | same | the newest 20 failed `fetch` calls (status ≥ 400 or no response): method, URL, status, duration, `x-request-id` (the middleware echoes one on every response, #1601). The report endpoint itself is never recorded. |
| Page | form fields | `location.href` and the viewport size |
| Build | server | `APP_VERSION (GIT_SHA)`, `APP_ENV`, the request's `User-Agent` — never what the client claims |

**Masking is one pure module, `src/lib/feedbackContext.ts`**, unit-tested in
`e2e/feedback-context.unit.spec.ts`:

- a URL keeps origin + path; every query **value** becomes `***`, the fragment
  and `user:pass@` are dropped, and an opaque path segment of 32+ token
  characters becomes `:token` (reset, magic-link and invite links). A cuid
  (25 chars) stays, because it is the id the support team needs;
- free text loses bearer tokens, JWTs, `password=` / `token=` / `secret:` …
  pairs and e-mail addresses (`[email]`), and URLs inside it get the URL rule;
- lists are capped at 20, strings at 2 000 characters (URLs at 512).

The collector masks **before** it keeps an entry, and the route runs
`sanitizeFeedbackContext()` again on what arrives — a request body is never
trusted. Nothing is sent before Send: the buffers live in the tab's memory.

## Session replay (Phase 2, #3131)

An rrweb recording of the last ~90 seconds can ride along with a report, so
the support team watches what happened instead of reading about it.

- **Switch:** `FEEDBACK_REPLAY_ENABLED` — `1`/`true` on, `0`/`false` off,
  **unset = on in a preview build (topic envs, preview) and OFF in
  production.** Turning it on for real users is a deliberate env change.
  The root layout reads it per request (`replayConfig()` in
  `src/lib/feedbackReplayRule.ts`) and hands it to the widget, so flipping it
  needs a restart, not a rebuild. The route refuses a replay while it is off
  (`400 replay_disabled`).
- **Window:** `FEEDBACK_REPLAY_SECONDS`, default 90, clamped 30…300.
- **Recorder** (`src/lib/feedbackRecorder.ts`): starts once the session is
  authenticated, stops and **forgets the buffer on sign-out**, loads rrweb on
  demand. Options: `maskAllInputs: true` (every typed value replays as `*`),
  `blockClass: 'rr-block'` and `blockSelector: '[data-private], [data-feedback-ui]'`
  (replayed as an empty box of the same size — the feedback panel included),
  no canvas, no inlined images or fonts, `slimDOMOptions: 'all'`, sampled
  mouse moves (50 ms) and scrolls (150 ms).
- **Rolling buffer** (`ReplayBuffer`): a full snapshot every window/3
  (`checkoutEveryNms`) opens a segment; segments wholly older than the window
  are dropped, so memory is bounded and a replay always starts on a snapshot it
  can render. It covers between 1× and 1⅓× the window.
- **Consent:** the form shows "Attach a recording of the last ~90 seconds",
  ticked by default, untickable. Nothing leaves the tab before Send — pinned by
  `e2e/feedback-replay.spec.ts`, which watches every request body.
- **Preview:** "Preview recording" plays, inside the panel, exactly what would
  be sent — the window is frozen at that moment (`freezeRollingWindow()`) and
  packed once, and Send attaches that same blob, so what the person watched is
  what leaves. Duration and compressed size are shown next to the checkbox.
  The player (`ReplayView`, rrweb-player + its stylesheet) is loaded only when a
  preview is opened (`next/dynamic`).
- **A recording the person makes:** "Start a new recording" closes the panel
  and replaces the button with a red "Recording m:ss · Stop" pill. It begins
  on a fresh full snapshot (`record.takeFullSnapshot(true)`) and keeps every
  event — not a window — until Stop or **20 minutes** (`ManualRecording`,
  `FEEDBACK_MANUAL_MAX_MS`; at the limit it stops itself and says so). Stop
  reopens the panel with the description kept, a fresh screenshot of where it
  ended, and "Attach my recording (3:12 · 1,8 MB)" + preview + discard. A
  reload or a typed address would lose it (it is in memory), so the page asks
  before unloading while it runs. Measured ≈ 3 KB/s of activity, so 20 minutes
  stays well inside the 8 MB upload limit; a larger one is refused in the panel
  with its size, before anything is sent.
- **Upload:** `CompressionStream('gzip')` in the browser, a `replay` multipart
  part. The route checks the gzip magic, ≤ 8 MB compressed, decompresses with a
  **80 MB ceiling** (`maxOutputLength`, so a gzip bomb stops there) and
  `checkReplayEvents()` (an array of rrweb events with a full snapshot).
  Stored as `SupportReportFile` kind `REPLAY`.
- **Player** (`src/components/ReplayPlayer.tsx`, `rrweb-player`, loaded only on
  the detail screen): the report's console errors (red) and failed requests
  (orange) are injected as rrweb custom events at their timestamps, plus the
  moment the report was sent (blue), so the timeline shows where it broke.


- `SupportReport` — `orgId` (in `TENANT_MODELS`, stamped from the reporter's
  row by the route), `userId`, `type`, `rating?`, `description`, `url`,
  `appVersion`, `env`, `userAgent`, `viewport`, `context Json?`,
  `contactAllowed`, `status`, `githubIssueUrl?` (Phase 3).
  `context` is **nullable on purpose**: a new non-null `Json` column backfills
  `''` on MariaDB and breaks every existing row.
- `SupportReportFile` — `kind` (`SCREENSHOT` | `ATTACHMENT`) and the bytes,
  reached only through its report (deliberately unregistered, the same shape as
  `SupportAttachment`). The list query never reads it.

Blobs live in the database, like every other upload in this codebase (there is
no object store in the app). The upload rules are the support channel's:
PNG / JPEG / PDF, magic-byte checked, 10 MB each, at most 10 files per report
(`src/lib/supportAttachments.ts`).

## Who may do what

| Action | Who |
|---|---|
| `POST /api/support/reports` | any signed-in role; 5 per 15 minutes **per person** |
| list / read / change status / download a file | `ADMIN` of the report's org; another org's id answers **404** |

Each admin route checks `getServerSession()` + `role === 'ADMIN'` in its own
file (the route-auth and OpenAPI analysers follow a guard only within the file);
`reportAdminOrg()` in `src/lib/supportReportAccess.ts` resolves the org.

## Personal data

- **Erasure** (`src/lib/accountErasure.ts`) deletes a person's reports; the
  files cascade.
- **Account merge** (`src/lib/mergeUsers.ts`) re-points `SupportReport.userId`.
- **Retention** (default 90 days) is Phase 3 (#3132).

## Tests

- `e2e/feedback-context.unit.spec.ts` (`@smoke`, browserless): the masking rules.
- `e2e/feedback-report.spec.ts` (`@smoke`): a person sends a report with a
  screenshot after a failed request and a console error carrying secrets; the
  stored context is masked; the reporter and an anonymous caller are refused by
  the admin routes; an admin finds the report, reads the console and network
  tabs and resolves it.
