# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/). The app
version is shown in the sidebar footer of every page (links to the
[user-facing release notes](src/lib/releaseNotes.ts), rendered at
`/release-notes`) and in the landing-page footer.

Since #1457 **one shipped change = one section**: its own version, the UTC time
it was merged and a link to the commit. Sections up to and including
`0.85.0-beta` predate that and can group several changes; the entries from
`0.86.0-beta` to `0.110.1-beta` were reconstructed from the release fragments'
add-commits (the 2026-08-24 compaction had folded all 45 of them into a single
`0.110.1-beta` section).

## [0.128.2-beta] - 2026-08-30

_Shipped 2026-08-30 07:11 UTC · commit [bb2fef7](https://github.com/21072026/Internship/commit/bb2fef7434d5f7be83b9338b47eedd11e9df776b)_

- **The dormant fortnight is measured from the start of the silence** (#1516), not from the most recent outreach. Measuring from the last message made the clock belong to the mentor's persistence rather than to the mentee's silence: somebody ignored for three weeks who got one more "Hi?" was back on the attention queue for another fortnight, and every chase bought another one — the exact treadmill the feature exists to end. The window now starts at the first outreach the mentee never answered, so a later nudge is more of the same silence rather than a fresh start. A genuine reply still resets it in full, and a relation where the mentor has not written since the mentee's last message stays on the queue, because there the answer is owed by the mentor.

## [0.128.1-beta] - 2026-08-29

_Shipped 2026-08-29 22:39 UTC · commit [9f4b626](https://github.com/21072026/Internship/commit/9f4b6261d3114aaf78ceeb8bb4d93a5af6395923)_

- **The dormant-first-contact rule now counts messenger outreach** (#1512): it only ever read `InteractionLog`, so a mentee written to four times through the in-app messenger — with no interaction ever logged — had "no outreach" by the rule and stayed in the attention queue permanently, which is the exact case the feature was built for. The outreach date is now the later of the last logged interaction and the last message from anybody who is not the mentee. A mentee reply also only counts as a sign of life when it came *after* that outreach: somebody who chatted in June, was written to in August and has said nothing since is dormant again, while somebody who answered yesterday stays on the queue because the mentor owes *them* a reply. The first check-in is anchored on `dormantSince` rather than re-derived from the interaction log, so it cannot fall into the same trap.

## [0.128.0-beta] - 2026-08-29

_Shipped 2026-08-29 20:49 UTC · commit [6efdc24](https://github.com/21072026/Internship/commit/6efdc246f3fa4ca3fa3780b095bcdd1d86030917)_

- **Dormant first contacts are marked and asked** (#1508): the daily sweep stamps `MentorshipRelation.dormantSince` on a relation still parked in the pipeline's first stage whose outreach is 14+ days old with nothing back, and the platform then e-mails the mentee twice — day 14, then 31 days later — asking whether they are still interested. Two is the hard cap; after that the relation simply stays marked dormant (stage unchanged, nothing closed, no data touched). Any sign of life clears the stamp and the nudge counters, so a later silence is a new episode. The mentee list hides dormant relations behind a one-click toggle and badges them. New e-mail category `dormant-check-in` in the `announcements` group, so an opt-out works; preferences are read before the counter is spent. Runnable on its own via `GET /api/cron?job=dormant`.

## [0.127.0-beta] - 2026-08-29

_Shipped 2026-08-29 15:44 UTC · commit [1ac0a50](https://github.com/21072026/Internship/commit/1ac0a5061f7a4925861f0310a1f46ad4d945ff61)_

- **Dormant first contacts leave the attention queue** (#1499): a mentee still parked in the pipeline's first stage who was already messaged and never replied — no message back, no unanswered question, no pending meeting request, no stage deadline — is dropped from the mentor's "needs attention" queue and from the daily staleness reminder. A relation with no outreach yet is untouched (the first message is still the mentor's to send), and any sign of life puts it straight back. Filter only: nothing is written to the relation and the mentee stays visible everywhere else. The queue footnotes how many were hidden.

## [0.126.0-beta] - 2026-08-28

_Shipped 2026-08-28 10:01 UTC · commit [053857d](https://github.com/21072026/Internship/commit/053857d83cb4e2d328696422dfc05f4abf393cfc)_

- **"Keep me signed in" (#1495).** New `TrustedDevice` model: a rotating, hashed, revocable persistent-login token per device, 30-day sliding / 90-day absolute expiry, with replay of a superseded token treated as theft (device revoked + `auth.device_token_reuse` logged). The 12h session JWT is unchanged — `POST /api/auth/remember/refresh` verifies and rotates the device cookie and mints a single-use grant that the new `remember` NextAuth provider trades for a session, so tokens keep being issued in exactly one place. Devices are listed and revocable under Account → sessions, and are revoked on sign-out, password change, password reset and "sign out of all devices".

## [0.125.1-beta] - 2026-08-28

_Shipped 2026-08-28 07:18 UTC · commit [7c8abb7](https://github.com/21072026/Internship/commit/7c8abb7586c644fb6cbf25538c8f89a4c3c4f7ae)_

- **Attention queue counts to-dos as open work** (#1491). `getAttentionItems` derived `no_open_goal` from `Goal` rows only, so a mentee whose work was handed out as to-dos (everything from the shared pool is a `ProjectTask`, not a `Goal`) was permanently flagged "no open goal". Open to-dos visible to the mentor now suppress the flag, and the label names both.

## [0.125.0-beta] - 2026-08-28

_Shipped 2026-08-28 07:04 UTC · commit [0cbe2c9](https://github.com/21072026/Internship/commit/0cbe2c91ef5a92dd43eda2c138d9d9bf4615ce24)_

- **A meeting that took place logs itself as an interaction** (#1489). Relation meetings write their own `InteractionLog` (`type: Meeting`, `autoLogged`, unique `meetingId`) — on the "meeting is over" click, and via a quarter-hourly sweep for the ones nobody ended (2h grace, DECLINED invitations skipped). The auto entry is marked in the UI, editable and deletable like any other, and is filtered out of the calendar's logged-meeting feed so a meeting is never listed twice.

## [0.124.3-beta] - 2026-08-27

_Shipped 2026-08-27 17:41 UTC · commit [acc4b75](https://github.com/21072026/Internship/commit/acc4b7515a3eab72b3720611fd36f8901f6a99d5)_

- **Mentee portal:** Kept the portal tab bar in one consistent place on every portal page (#1424).

## [0.124.2-beta] - 2026-08-27

_Shipped 2026-08-27 17:40 UTC · commit [866f832](https://github.com/21072026/Internship/commit/866f832dbfed3e70cde49d8d087bf294504a01e5)_

- **Pipeline history integrity**: ignore same-stage writes and hide legacy no-op transitions while preserving custom stage keys.

## [0.124.1-beta] - 2026-08-27

_Shipped 2026-08-27 16:43 UTC · commit [75030fb](https://github.com/21072026/Internship/commit/75030fb90f2c012b57ac271e2715818b36245d98)_

- **Requisitions:** Fixed Turkish-aware de-duplication for required skills (#1389).

## [0.124.0-beta] - 2026-08-27

_Shipped 2026-08-27 11:45 UTC · commit [17d8500](https://github.com/21072026/Internship/commit/17d8500ac22c64cf64d635cb04a93e1b933a57d2)_

- **Imprint page and a named controller** (#1396). New `/imprint` (EN/TR/DE), linked from the public footer, published from `OPERATOR_*` env vars (`src/lib/imprint.ts`) so a self-hosted instance never inherits ours. The privacy notice now names the controller and a real contact address instead of the placeholder saying the operator would supply them before production use; `PRIVACY_POLICY_VERSION` → 2026-08-25.

## [0.123.5-beta] - 2026-08-27

_Shipped 2026-08-27 11:26 UTC · commit [abd78e1](https://github.com/21072026/Internship/commit/abd78e13db7965b164908060afab62ae89e89619)_

- **Accessible color contrast**: raise low-contrast helper, loading, empty-state, mode-switch, and profile-completion text to WCAG AA-compliant palette tones.

## [0.123.4-beta] - 2026-08-27

_Shipped 2026-08-27 11:02 UTC · commit [cc6af7c](https://github.com/21072026/Internship/commit/cc6af7c214e89482525f3883931f6c6e2e56ac7b)_

- **Accessibility:** Added an accessible label to the evaluation type selector (#1413).

## [0.123.3-beta] - 2026-08-27

_Shipped 2026-08-27 06:50 UTC · commit [5997a24](https://github.com/21072026/Internship/commit/5997a2497bfaebd152d3f51b4a8d5e777609bc0f)_

**Fixed** — the upcoming stages in the mentee journey tracker were below the WCAG AA contrast threshold in both themes (measured 2.54:1 and 2.31:1 in light, 2.35:1 and 2.13:1 in dark). The dark half was worse than it looked in the source: the badge's `dark:bg-gray-800` never applied, because a flat `html.dark` rule in globals.css outranks the variant. Now 4.83:1–8.33:1 across both themes.

## [0.123.2-beta] - 2026-08-27

_Shipped 2026-08-27 01:41 UTC · commit [38da361](https://github.com/21072026/Internship/commit/38da3618af1f5597793bdf76603167cb29ec4950)_

**A completed mentorship no longer empties the mentee's portal** (#1408) — `/portal`, `/portal/journey`, `/portal/goals` and `/portal/requests` each asked for `status: 'ACTIVE'` and nothing else, so the moment a mentorship was marked `COMPLETED` the mentee's mentor, company, stage bar, goals, evaluations and question history vanished and the portal told them "no mentor assigned yet — an admin will assign you one once your profile is reviewed". Finishing the programme is its success case, and it read as a data loss. The four pages now resolve the relation through `pickMenteeRelation()` (ACTIVE, else the most recently completed one) and render the finished mentorship as a labelled archive: the record stays readable while the actions that need a live mentorship — asking a question, requesting a meeting, moving goals, filing a weekly report — are closed, in the UI *and* in `/api/questions`, `/api/meeting-requests` and `/api/goals`, which now answer `409 inactive_relation` to a mentee writing on a mentorship that has ended. Mentor and admin writes are untouched: the certificate flow keys off exactly the COMPLETED state, and a mentee's evaluation of their mentor stays open because it is usually written after the mentorship ends. The "request a mentor" panel is offered on an archive too, so finishing one round is a way into the next rather than a dead end.

## [0.123.1-beta] - 2026-08-27

_Shipped 2026-08-27 00:40 UTC · commit [d417b8e](https://github.com/21072026/Internship/commit/d417b8e915aa23f63ae7ef13177194b7391e6574)_

- **Candidates:** Removed the duplicate disabled graduation-year filter option (#1441).

## [0.123.0-beta] - 2026-08-26

_Shipped 2026-08-26 14:03 UTC · commit [a1586c7](https://github.com/21072026/Internship/commit/a1586c71fc6fa3351aa298bf8c2edc85d1b7b873)_

**Per-group e-mail unsubscribe with RFC 8058 one-click** (#1444) — every mail the app sends now belongs to exactly one of twelve e-mail groups (`src/lib/emailGroups.ts`), and each non-essential group has its own switch. `sendEmail` enforces the group centrally, before the demo/SMTP short-circuits, so an opt-out applies to all 41 send sites and not only the ones that remembered to check — nine of them had no per-user guard at all. Non-essential mail carries a one-line unsubscribe footer (in both MIME parts) plus `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; bulk groups additionally get `List-Id`, `Precedence: bulk` and auto-response suppression. `account_security` mail advertises nothing and ignores every switch — an unsubscribable password reset is a lockout, not a preference. The signed token has no expiry (an opt-out that expires fails exactly when someone is annoyed enough to use it) and `/u/<token>` applies the choice and renders the whole preference centre with no login and no Save button; the mutation runs from the browser so Outlook Safe Links and antivirus gateways prefetching the URL cannot unsubscribe anyone. Preferences live in the existing `User.notificationPrefs` JSON under prefixed `email:<group>` keys, so there is no schema change, and the eleven legacy in-app keys still gate in-app notifications and still suppress the group they used to suppress. The bulk SMTP channel list is now derived from the taxonomy instead of hand-maintained. `sendEmail` accepts an optional pre-resolved `prefs` so a caller that already loaded the row does not pay for a second read: the announcement broadcast selects every recipient's preferences in one query and now passes them through, which halves the pooled query count on the largest send the product makes (1000 recipients previously meant 1000 duplicate point reads inside a single `Promise.all`, doubling the window for a pool timeout). The parameter is data and not a bypass — omitting it costs a query, it cannot skip the check. The account-settings switches (both the new e-mail groups and the older in-app categories) now stay disabled until `GET /api/profile` answers: they write the whole `notificationPrefs` blob back and `PUT /api/profile` replaces that column, so a click before the fetch resolved used to persist one key over the top of every preference the user actually had.

## [0.122.2-beta] - 2026-08-26

_Shipped 2026-08-26 23:47 UTC · commit [0c00c88](https://github.com/21072026/Internship/commit/0c00c883b18e423a5c428b5cb453c371bd91aaa5)_

- **Copy buttons share one clipboard helper with a fallback** (#701). Four call sites (invitation link, mentee setup link, application link, meeting link) each called `navigator.clipboard.writeText` directly, so in any context where the modern Clipboard API is unavailable — an insecure origin, an older browser, a denied permission — the copy silently did nothing while the UI still flashed success. `src/lib/clipboard.ts` now feature-detects the API, falls back to a hidden `textarea` + `execCommand('copy')`, guards both `navigator` and `document` for SSR, always removes the temporary node, and returns a boolean the callers check before showing the copied state.

## [0.122.1-beta] - 2026-08-26

_Shipped 2026-08-26 23:35 UTC · commit [dc1c8e2](https://github.com/21072026/Internship/commit/dc1c8e2f27807efeffc40fd982cda38f0fc623a7)_

**Fixed** — every bar in the admin analytics Trends chart rendered at 0px. The bars size themselves with percentage heights, but no ancestor had a definite height, so the percentages resolved to `auto`. The month labels kept rendering (text has intrinsic height), which made an empty chart look like missing data rather than a broken layout.

## [0.122.0-beta] - 2026-08-26

_Shipped 2026-08-26 23:12 UTC · commit [d11ba53](https://github.com/21072026/Internship/commit/d11ba531887194881a1e783bc76f8dcfe4bd5645)_

- **Every shipped change gets its own version, dated and traceable to its commit (#1457)** — the release-fragment mechanism (#1275) collapsed a whole compaction window into one section: the 2026-08-24 run buried 45 changes under `## [0.110.1-beta]`, and the 25 versions the app had actually served in between (0.86 → 0.110) were recorded nowhere. Worse, fragments were ordered by FILENAME, so a `patch` fragment whose name sorted before the last `minor` fragment's was erased by that minor's `patch = 0` reset — three consecutive merges all shipped as `0.114.0-beta`. Fragments are now ordered by MERGE order, read from the commit that added each one (`--diff-filter=A`, `--topo-order`), and each becomes its own release: its own version, the UTC minute it was merged and a link to its commit, in `CHANGELOG.md`, in `src/lib/releaseNotes.ts` and on `/release-notes`. That ordering is what makes the number a build displays the number the changelog later records — a fragment's version depends only on the fragments that shipped before it, so a later merge can never renumber an earlier one. Compaction now **fails closed** rather than date a release it cannot see (a shallow clone), so the workflows that stamp check out with `fetch-depth: 0`; `.git` is `.dockerignore`d, so `build-image.yml` resolves the stamps on the runner and passes them into the image as `RELEASE_STAMPS`. `scripts/release-resplit.mjs` re-split the one lumped section into its 45 dated releases, verified two ways: the replay lands back on the published `0.110.1-beta`, and every bullet and highlight survives unedited. New `npm run test:release` (13 cases, in CI) guards the arithmetic and both old failure modes.

## [0.121.1-beta] - 2026-08-26

_Shipped 2026-08-26 22:58 UTC · commit [1348ceb](https://github.com/21072026/Internship/commit/1348ceb7eb0a6cbbef0c8f6e3218687c2e305087)_

- **The 404 page keeps the public site shell** (#1409). `not-found.tsx` rendered a bare centred block, so a visitor who mistyped a URL lost the header, the language and theme switches and the footer — every route out of the page except a single "back home" button. It now renders inside `PublicShell` with direct links to register, apply as a mentor and the company page, plus a localized title and `noindex, nofollow` robots metadata.

## [0.121.0-beta] - 2026-08-26

_Shipped 2026-08-26 17:31 UTC · commit [a8612c0](https://github.com/21072026/Internship/commit/a8612c03ec65701729268fecf23eee53c4a985e7)_

**Fixed** — reading a message now clears the *notification* it produced (#1464). Two independent unread signals describe the same event (the message counters and the `Notification` row `notify()` writes), and opening a thread only ever cleared the first one — so the blue "new message from X" row survived reading the message and even answering it, until the reader happened to open the bell. `markThreadRead()` now retires both, which covers every way of reading a thread (opening it, replying by e-mail, the "mark as read" link in the notification mail); the pinned support thread does the same for `support.replied`.
**Added** — live messaging over SSE. An in-process bus (`src/lib/realtimeBus.ts`) plus `GET /api/realtime/stream` push a signal to whoever has a thread, the inbox or the header badge on screen; the client shares one `EventSource` per tab and falls back to polling `/api/messages/unread` when the stream is blocked. Chosen over a WebSocket/SignalR-style channel because everything needed is one-directional and SSE survives the Plesk reverse proxy with one header, no broker and no extra dependency. The stream re-reads the unread counters from the database on every 25s heartbeat, so a missed event self-heals rather than leaving a stale badge. Details and the reasoning in `docs/realtime-and-push.md`.
**Added** — background Web Push for new messages (#675 Kademe 2): `PushSubscription` model, `web-push` + VAPID env, `POST/DELETE /api/push/subscribe`, `GET /api/push/config`, and `push`/`notificationclick`/`pushsubscriptionchange` handlers in `public/sw.js`. Wired to the existing "Browser notifications" switch on /account, composed in the recipient's language from the same dictionary template the bell renders, and self-pruning (404/410 deletes the endpoint). Entirely optional: with no VAPID keys configured every send is a no-op and the app behaves exactly as before.

## [0.120.0-beta] - 2026-08-26

_Shipped 2026-08-26 16:42 UTC · commit [bd4ccec](https://github.com/21072026/Internship/commit/bd4ccec69f73a1f0f9b89ee7f57c8c7d3dc24da6)_

- **Interactive API explorer for admins** (#1447). New page `/admin/api-explorer` mounts real Swagger UI, bundled from `swagger-ui-dist` in `node_modules` (no CDN — `script-src` is `'self'`) with `validatorUrl: null` so the spec never leaves the origin. It is driven by the ADMIN-only `GET /api/admin/openapi`, which describes the whole surface including the internal admin/cron/webhook endpoints. Two auth modes: "Try it out" rides the caller's existing NextAuth session cookie (`withCredentials` plus a `requestInterceptor` pinning `credentials: 'same-origin'`), and a Bearer key for `/api/v1/*` can be minted in-page through the existing `POST /api/admin/api-keys` and pushed into the Authorize dialog with `preauthorizeApiKey` — no copy-paste, no new auth path. Linked from `/admin/integrations` and `/admin/api-docs`; the ~1.2 MB bundle is `await import()`ed inside an effect so no other route pays for it.

## [0.119.2-beta] - 2026-08-26

_Shipped 2026-08-26 15:41 UTC · commit [d6d6bd2](https://github.com/21072026/Internship/commit/d6d6bd2d7a65d534b7b5e80ec738fd83f3af64e3)_

- **Mentee onboarding headings are fully localized** (#1420). The profile setup title and subtitle now use the active EN/TR/DE dictionary instead of hard-coded English.

## [0.119.1-beta] - 2026-08-26

_Shipped 2026-08-26 14:52 UTC · commit [fb61482](https://github.com/21072026/Internship/commit/fb61482b71c0cef6adfe82a50c87a8882e5d8e1c)_

**Fixed** — the **Messages** notification category silenced e-mail but not the in-app bell. Four message paths (direct messages, the mentor bulk composer, emailed replies, and public-profile contact) called `notify()` ungated, in some cases four lines above an e-mail branch that did check the same preference. All four now honour it, failing open on a missing user row.

## [0.119.0-beta] - 2026-08-26

_Shipped 2026-08-26 16:54 UTC · commit [f44a4e6](https://github.com/21072026/Internship/commit/f44a4e6f11e0cf13683864ba89374e9b101d2112)_

- **E-mail newsletter module** (#1469). New `Newsletter` / `NewsletterImage` / `NewsletterSend` models plus a curated library of ten career issues in EN/TR/DE (`src/lib/newsletterContent.ts`). An issue is a fixed shape (subject, preheader, intro, 1-5 emoji tips, ten-minute action, optional CTA, mentor-only note) rendered as email-safe table HTML with an inline hero image; `MENTEE` / `MENTOR` / `BOTH` audiences, with mentors seeing the coaching block on a shared issue. Admin composer at `/admin/newsletters` (library picker, three language tabs, live preview through the real renderer, test send to self, schedule, cadence) with an immutable record of every send; reader archive at `/newsletters`; one-click unsubscribe at `/newsletter/unsubscribe` behind an HMAC token, a new `newsletter` notification category and `List-Unsubscribe` headers. Two cron jobs (`*/15` dispatch, daily 06:00 cadence queue), one `NewsletterSend` row per recipient so a resumed run never double-mails, and newsletter sends are cleared by both account-erasure paths.

## [0.118.4-beta] - 2026-08-26

_Shipped 2026-08-26 14:27 UTC · commit [00acb82](https://github.com/21072026/Internship/commit/00acb82fb0851f0c8dd30918648e52414e5ae73e)_

**Fixed** — four endpoints reported `emailSent: true` when nothing had been delivered. `sendEmail` returns normally (recording a SKIPPED row) when SMTP is unconfigured or demo mode is on, and the callers read that silence as success — so creating a company or source login, resetting a password, or activating a mentee claimed the set-password link was on its way while the delivery log said SKIPPED, leaving an account nobody could sign in to. `sendEmail` and its wrappers now return `'SENT' | 'SKIPPED' | 'FAILED'`, all six routes derive `emailSent` from that, and the invite routes' `!!process.env.SMTP_USER` guess is gone — it was right about a missing SMTP_USER and wrong about demo mode.

## [0.118.3-beta] - 2026-08-26

_Shipped 2026-08-26 14:26 UTC · commit [df2f097](https://github.com/21072026/Internship/commit/df2f0973c3016b3a371a0a85ae9a4ba75c81178e)_

**Nightly k6 load test** — a new `k6/` source directory with `k6/nightly-load.js`: a 6-minute staged VU ramp (peak 20) over the public, anonymous, read-only surface (`/`, `/auth/signin`, `/features`, `/api/public/stories`, `/api/health`, `/api/health?db=1`), with per-endpoint latency budgets on top of the aggregate error-rate and p95/p99 gates that `stress.yml` already enforces. Runs at 23:40 UTC via `.github/workflows/k6-load.yml` — no drift gate, because a load test measures the environment rather than the commit. `scripts/k6-report-email.mjs` emails a Turkish breach report (threshold, actual vs limit, per-endpoint table) **only when a threshold fails**; a green run is silent, and `K6_REPORT_MODE=always` restores a green summary. The verdict is read from k6's summary artifact rather than its exit code, so a crash that produced no summary is red rather than silent. `npm run test:load` runs it locally; `K6_SMOKE=1` collapses the ramp to ~40s for validating a script change.

## [0.118.2-beta] - 2026-08-26

_Shipped 2026-08-26 14:14 UTC · commit [2173cd7](https://github.com/21072026/Internship/commit/2173cd753393aea0e6b6d01d807a09e615d973c8)_

**Fixed** — talent-pool search read 60 rows from the database and only then applied the skill filter, so a skill held by nobody in the 60 most recently updated candidates returned nothing at all — and the response carried no total, so an incomplete answer looked identical to an empty one. The search now counts and paginates over the whole matching set, the early-access embargo is part of the database filter rather than a post-filter, and the screen shows the result count with a pager.

## [0.118.1-beta] - 2026-08-26

_Shipped 2026-08-26 13:41 UTC · commit [59ebadc](https://github.com/21072026/Internship/commit/59ebadc64afd8e766283a8aaaed852fc53d30a44)_

- **Mentee calendar and onboarding contrast now meets AA targets** (#1417). Month day numbers, inactive calendar view tabs, onboarding step labels and future-step badges use accessible light/dark colours.

## [0.118.0-beta] - 2026-08-26

_Shipped 2026-08-26 12:46 UTC · commit [a7c65b8](https://github.com/21072026/Internship/commit/a7c65b83b4ab7880ddc1f0d7383760889ff2a4b5)_

**Added** — a company requesting an interview for a shortlisted candidate can now attach an optional note (up to 1000 characters) and up to 5 proposed time slots, added or removed inline before submitting. Both stay optional — submitting with neither still creates a plain request, unchanged from before.

## [0.117.5-beta] - 2026-08-26

_Shipped 2026-08-26 12:44 UTC · commit [6981f37](https://github.com/21072026/Internship/commit/6981f373b60ea6cbf0b7b37b5befb2bbb48f3b29)_

- **Offer requisitions are selected safely** (#1407). The offer wizard now lists company-scoped open requisitions, validates the selection on create and draft edit, and shows requisition titles in offer management.

## [0.117.4-beta] - 2026-08-26

_Shipped 2026-08-26 11:43 UTC · commit [b8c404c](https://github.com/21072026/Internship/commit/b8c404cda2e02dc2a10c67b117772c812e61a205)_

**Fixed** — premium open-position match alerts scanned only the legacy `CompanyNeed` table, so a role opened through the Requisition screen never matched anybody: a premium company could have several open requisitions and receive nothing. The job now reads both sources. Only requisitions with status `OPEN` and unfilled openings alert, and the existing per-(company, candidate) dedupe means a role present in both tables still alerts once.

## [0.117.3-beta] - 2026-08-26

_Shipped 2026-08-26 10:43 UTC · commit [8f3313f](https://github.com/21072026/Internship/commit/8f3313f65031194c83ca4205bfc1efba40937534)_

- **Async UI states**: centralize loading, error, retry and empty presentation with shared skeleton variants.

## [0.117.2-beta] - 2026-08-26

_Shipped 2026-08-26 10:42 UTC · commit [dd17c87](https://github.com/21072026/Internship/commit/dd17c875a687e05973088bc76f689bb647421346)_

- **Candidate history deletion**: surface failed stage-history deletes and avoid reloading stale candidate data.

## [0.117.1-beta] - 2026-08-26

_Shipped 2026-08-26 10:39 UTC · commit [31d150c](https://github.com/21072026/Internship/commit/31d150c1927ec636d931fd10176ca9e18bda0c1e)_

- **The calendar no longer flashes a false empty state** (#931). `CalendarView` rendered "nothing scheduled" while the range request was still in flight, and a failed request degraded silently into the same empty calendar. Loading, loaded-empty and error are now distinct: an in-flight range shows a skeleton overlay (`role="status"`, `aria-live="polite"`) over the grid so the layout does not jump, a failure shows an error overlay (`role="alert"`) with Retry, and the per-cell/agenda empty texts are suppressed until the range that is actually displayed has settled. In-flight requests are cancelled with `AbortController` on range change, so an old month's events can never land in the new month's grid.

## [0.117.0-beta] - 2026-08-26

_Shipped 2026-08-26 08:11 UTC · commit [2df864e](https://github.com/21072026/Internship/commit/2df864e2b9f4a2143c049670b1803f5bc19c4507)_

- **Invite people from outside the platform to a meeting** (#1446). The meeting scheduler (both `/mentor/meetings` · `/admin/meetings` and the candidate detail panel) gains an email chip field: type an address and that person is invited to the same room with the same Yes/No RSVP buttons — no account, no sign-up. New `MeetingGuest` model carries its own unguessable `rsvpToken`, so `/rsvp/<token>` and `/api/calendar/<token>` work for a guest exactly as they do for a participant, while a guest's answer is recorded against their own row and never onto the participant's. `POST /api/meetings` takes a `guests` array; `GET|POST|DELETE /api/meetings/[id]/guests` adds, lists and withdraws invitations after the fact (deleting the row kills the token). Guests are reminded by the meeting cron too — they have no dashboard to fall back on — unless they already declined. Guarded by: a per-meeting cap of 20, new rate limits on scheduling, the public RSVP read and the public `.ics`, a MENTOR/ADMIN gate on top of meeting participation (being the organizer is not enough — `/api/meetings/instant` lets a mentee create a meeting), and a rule that an address belonging to an existing account is never minted a guest token: that person is reached the normal way and the organizer is told so. `scripts/sanitize-db.mjs` scrubs guest addresses and re-mints their tokens, since a guest's email is the PII of someone with no account and no self-service erasure path.
- Fixed `e2e/meetings-rsvp.spec.ts`, which had been failing on `main`: it ticked the invitee by clicking their name, and that stopped toggling the checkbox when the name became a `PersonHoverCard` (whose `onClick` `preventDefault()`s so opening the card does not toggle the `<label>` around it). It now targets the checkbox.

## [0.116.0-beta] - 2026-08-26

_Shipped 2026-08-26 07:39 UTC · commit [5b4b898](https://github.com/21072026/Internship/commit/5b4b8988f54bc8cd25520a269ed766392a8e7312)_

**Added** — a mentee requesting a meeting now picks from their mentor's posted weekly hours, expanded into concrete date-times for the next three weeks and resolved in the mentor's time zone (DST-correct). The mentor's request list marks which requests landed on their own hours. A mentor who has posted no hours is unchanged: the free-text request stays. Closes the loop the landing FAQ has been promising — until now nothing in the product read an availability slot.

## [0.115.0-beta] - 2026-08-25

_Shipped 2026-08-25 09:25 UTC · commit [b174c20](https://github.com/21072026/Internship/commit/b174c20b245caa33f6d10c9a3beba43586f0ed96)_

**Added** — the availability screen now states which time zone the weekly hours are read in (the mentor's profile zone), prompts for one when none is saved, and groups slots by day. **Fixed** — an interval overlapping one already on that weekday, exact repeats included, is refused with 409 and the message names the interval it collided with; previously the same hours could be added twice.

## [0.114.3-beta] - 2026-08-25

_Shipped 2026-08-25 09:15 UTC · commit [361ec61](https://github.com/21072026/Internship/commit/361ec618f1c9ee781eaa7fada7bce5fe505c7094)_

**Fixed** — `GET /api/availability?mentorId=` returned any mentor's weekly hours to any signed-in account, across organizations: `AvailabilitySlot` carries no `orgId` and is not a tenant-anchored model, so the central isolation middleware never saw the query. Reading another mentor's hours now requires being an admin in the same organization, a mentee with an active relation to that mentor, or the mentor having opted into the directory. The admin delete escape hatch is scoped to the admin's own organization for the same reason.

## [0.114.2-beta] - 2026-08-25

_Shipped 2026-08-25 01:36 UTC · commit [d1133e4](https://github.com/21072026/Internship/commit/d1133e4facae6fceac410805c2642cf95a9f337e)_

**Fixed** — the desktop admin board iterated the built-in stage list, so an organization with a customized pipeline saw its stages on a phone but no columns at all on a desktop. It now groups the organization's own resolved stages; stage keys outside the built-in phases get their own group. Added a 768px tablet layout tier, phone-width audits of the profile pages, a dark-mode phone audit, and board tests that seed 3-stage and 13-stage custom pipelines.

## [0.114.1-beta] - 2026-08-25

_Shipped 2026-08-25 01:36 UTC · commit [d1133e4](https://github.com/21072026/Internship/commit/d1133e4facae6fceac410805c2642cf95a9f337e)_

**The accessibility gate now actually gates** (#826) — the 9-page axe scan shipped in #862 carried no `@smoke` tag while the PR job runs `--grep @smoke`, so the baseline comparison only ever ran in the scheduled suite and a PR introducing a new *serious* violation was never blocked (#1333 is that failure realised). It now runs as its own CI step, outside the grep. Regenerating the baseline also **says out loud what got wider**, in the console and in the audit report, so a violation can no longer freeze itself in silently on a page nobody touched. And the scan now runs **twice per page, light and dark** — dark results keyed `<page>#dark` so they gate independently. That immediately surfaced six previously invisible serious contrast failures; four are fixed here.

## [0.114.0-beta] - 2026-08-24

_Shipped 2026-08-24 23:48 UTC · commit [29e072a](https://github.com/21072026/Internship/commit/29e072a02b4d3daff8f007b9de993582ccb0d2f2)_

**Growth analytics, off by default** (#1242, #966) — a dependency-free, multi-provider layer (Plausible / GA4 / PostHog) that resolves the two objections that held #1221 back. **CSP no longer loosens unconditionally**: provider hosts are added only when that provider's `NEXT_PUBLIC_*` variable is set, so a deployment with no analytics configured allows no analytics host at all. **The loader is mounted on the public shell, never the root layout**, so nothing runs on signed-in CRM pages where a pageview would carry a mentee's name to a vendor — and nothing loads at all without the visitor's `analytics` cookie consent, re-read live on the consent-change event. PostHog's autocapture, session recording and localStorage persistence are forced off in code rather than left to the dashboard.

## [0.113.0-beta] - 2026-08-24

_Shipped 2026-08-24 23:03 UTC · commit [6c0e748](https://github.com/21072026/Internship/commit/6c0e7487396064b1f5f77e77a7582f86cd252ad4)_

**Talent re-engagement pool** (#834) — candidates who did not place this cycle can be given an explicit "we'll write in September" date instead of sitting in the pipeline forever. Joining requires the person's own consent (new `ConsentType.RE_ENGAGEMENT_POOL`) and **never touches `User.consentAt`**, so it cannot extend how long data is kept — the two permissions are deliberately separate and a test asserts it. One click from the e-mail (signed token, no login) leaves the pool and revokes the permission. An idempotent cron sends the reminder once per date. Pooled candidates drop out of the aging report's `overdue` list — which is what stops that report rotting — and appear in a `pooledCount` instead, with their own admin page at `/admin/re-engagement`.

## [0.112.0-beta] - 2026-08-24

_Shipped 2026-08-24 22:42 UTC · commit [6c8b027](https://github.com/21072026/Internship/commit/6c8b027acd88c420428e54f6ae773ee574fcbb0f)_

**Tag management** (#845, completing the story #887 started) — a new admin screen at `/admin/tags` lists the org's labels with how many people carry each, and lets an admin **rename** one (in place, so the tag keeps its id and nobody loses the label or has a saved view silently empty), **recolour** it, **merge** it into another, or delete it behind a confirmation that names the usage count. New `PATCH /api/tags/:id` and `POST /api/tags/:id/merge`, both ADMIN-only and org-scoped. Merge moves everyone onto the target — carrying over the original tagger rather than the admin doing the merge — and the `(userId, tagId)` unique means someone who already had both simply keeps one.

## [0.111.0-beta] - 2026-08-24

_Shipped 2026-08-24 22:17 UTC · commit [3ba4083](https://github.com/21072026/Internship/commit/3ba40837423edb975b7fc1bcbfb54588e316fdbd)_

**Google Calendar, connected by the user** (#709) — the last open piece of the meetings epic. `/account` gains a "Connect Google Calendar" card: connect your own Google account and the meetings you are part of are mirrored onto your calendar; disconnect revokes the access at Google rather than only forgetting it here. Refresh tokens are encrypted at rest (new `src/lib/secretBox.ts`, AES-256-GCM keyed from `NEXTAUTH_SECRET` via HKDF), the OAuth `state` is HMAC-signed and bound to the session that started the flow, and the meeting→event mapping is per (meeting, user) so each participant gets the event on their own calendar. Gated behind `GOOGLE_CALENDAR_ENABLED` (default off) and separate from merely having credentials; unconnected users keep the in-app calendar, `.ics` and reminders unchanged. The token exchange and calendar write are now covered by an e2e that points Google's endpoints at a local stub.

## [0.110.2-beta] - 2026-08-24

_Shipped 2026-08-24 22:13 UTC · commit [c50bdb8](https://github.com/21072026/Internship/commit/c50bdb86475cf4027048e4b1e139210b85067b2c)_

- **Candidate filter accessibility**: add localized accessible names to the graduation-year and source filters on the admin candidate list.

## [0.110.1-beta] - 2026-08-24

_Shipped 2026-08-24 21:47 UTC · commit [b0d36f4](https://github.com/21072026/Internship/commit/b0d36f484100a431ef542b23e4e8820b5cf41536)_

- **Mentor deadline notification link (#1266)**: deadline reminders now open the mentor's relation-scoped mentee detail page.

## [0.110.0-beta] - 2026-08-24

_Shipped 2026-08-24 21:37 UTC · commit [30d79fc](https://github.com/21072026/Internship/commit/30d79fc9497de5a045c73df873668b5ccd34663e)_

**Contributor terms: admin acceptance report** (#1027) — `/admin/contributor-terms` answers "who accepted which terms, for what, and when" from one screen instead of a database console. One row per person × scope (platform, plus every project they are on that asks), including the rows where the answer is no: `Accepted` / `Outdated version` / `Not accepted`, filterable by status and by project, exportable to Excel. Evidence is reported as *recorded*, never as the stored hash. ADMIN only, checked on the page itself rather than relying on the layout.

## [0.109.0-beta] - 2026-08-24

_Shipped 2026-08-24 21:07 UTC · commit [c6343ee](https://github.com/21072026/Internship/commit/c6343ee598fa2f8c4ee4cae33654ad68a8009fd8)_

**Project-level contributor terms** (#1026) — a project now names the terms its members contribute under (`contributorTermsKey`, or the platform default) and can opt out entirely (`contributorTermsRequired`). A member opening a project whose terms they have not accepted gets the text and an unticked checkbox in place of the internal view; accepting writes an acceptance scoped to that project, distinct from the platform-level one. Admins are never gated — they look in to administer, not to contribute — and the public showcase view is untouched. The acceptance API now verifies membership and derives the terms key from the project, so a row cannot be minted for a project the caller is not on.

## [0.108.0-beta] - 2026-08-24

_Shipped 2026-08-24 20:56 UTC · commit [aac75ae](https://github.com/21072026/Internship/commit/aac75ae4052e4e2bda4f01dd75d2a840dc5d89a2)_

- **Names are clickable across the app** (#1166 follow-up). The person card now sits behind the names on the project join-request queue, project rosters and goal assignees, the mentor's application inbox, the admin mentorship-request and interview queues, the meeting scheduler and list, group-chat participants, support tickets, the retention and user lists, the mentor/mentee dashboards and the mentee portal. Pending requests (project join, mentor application) now authorize the lookup, so an applicant's name resolves before the membership or relation exists.
- **Fixed** the card's "open profile" link for mentors: /mentor/mentees is keyed by the relation, not the person, so the link built from the user id landed on "relation not found". The card endpoint now returns the viewer's relation id.

## [0.107.3-beta] - 2026-08-24

_Shipped 2026-08-24 20:53 UTC · commit [4ed3ec5](https://github.com/21072026/Internship/commit/4ed3ec5be47c32c67e5445928d1121f1d05fd58a)_

- **Accessible focus management for modal dialogs** (#871). A new `useModalFocus` hook (`src/components/ui/useModalFocus.ts`) gives every blocking dialog initial focus inside itself, a two-way Tab trap, Escape-to-close through the existing handler, and focus restoration to whatever opened it. Applied to `ConfirmDialog`, `DropoffReasonDialog`, `TemplatesLibrary`, `CertificateGenerator`, `OfferWizardModal`, `RequisitionsManager`, `CompanyEntitlements`, `MeetingLauncher` and the bare admin modals on the companies/mentors/mentorship pages, which also gained the `role="dialog"` / `aria-modal` / `aria-labelledby` they were missing. Focusable-element detection filters on computed visibility, and a dialog with no focusable child falls back to the container. E2E coverage in `e2e/templates-library.spec.ts`.

## [0.107.2-beta] - 2026-08-24

_Shipped 2026-08-24 20:46 UTC · commit [4a87a47](https://github.com/21072026/Internship/commit/4a87a472eb2acdff4217a380c39c0dafb0f71a64)_

- **No more false empty states on the meetings page** (#930). `MeetingsManager` fetched mentorships and meetings without tracking load state, so mentors with mentees briefly saw "No mentees assigned yet" and a `Meetings (0)` heading before the responses landed, and a non-2xx response silently degraded into the same empty list. Loading, loaded-empty and error are now distinct states: skeleton rows while loading, the empty text only after a successful empty load, and a visible error card with Retry when a request fails. EN/TR/DE load-error strings; regression in `e2e/meeting-schedule-form.spec.ts` covers the failure path.

## [0.107.1-beta] - 2026-08-24

_Shipped 2026-08-24 20:43 UTC · commit [cb3fdb5](https://github.com/21072026/Internship/commit/cb3fdb58b9a6eb79db9add1dd46b2323f48f8ec3)_

- **WCAG touch targets (#1265)**: primary actions, icon buttons, candidate filters, tabs, inputs, selects, and related controls now provide minimum 44×44 px interactive areas while preserving visual icon sizes.

## [0.107.0-beta] - 2026-08-24

_Shipped 2026-08-24 20:34 UTC · commit [31f010f](https://github.com/21072026/Internship/commit/31f010fffba707c1e63db74d9e9b3c4903f519b2)_

**Contributor terms accepted in the app** (#1025) — the terms are versioned rows in the database rather than a paragraph in the code: `/contributor-terms` shows the text in force to anyone (no sign-in), lets a signed-in user download it and read back what they accepted, and `/onboarding/contributor-terms` is the acceptance step — full text on screen, an unticked checkbox, and the displayed version sent with the POST so a text that changed while it was being read is refused instead of recorded. Accepting writes an evidence row (who, which version, when, HMAC-hashed IP/user-agent — never a raw address). `/portal/projects` is gated on acceptance; the rest of the portal is deliberately not.

## [0.106.3-beta] - 2026-08-24

_Shipped 2026-08-24 20:26 UTC · commit [d99e463](https://github.com/21072026/Internship/commit/d99e46380f658ee4a3280fcf6c0bd31205684ed7)_

- Centralize role-safe notification destinations with exhaustive fallback coverage (#929).

## [0.106.2-beta] - 2026-08-24

_Shipped 2026-08-24 20:26 UTC · commit [3958cba](https://github.com/21072026/Internship/commit/3958cba224e82f8f80f9cb1c56423a3069485b6e)_

- **Role-compatible notification links**: notification targets now use the recipient’s mentorship side and the correct relation or conversation identifier across evaluations, goals, requests, questions, invitations, meetings, and document reminders.

## [0.106.1-beta] - 2026-08-24

_Shipped 2026-08-24 20:26 UTC · commit [cd59f4b](https://github.com/21072026/Internship/commit/cd59f4bbca94ad1d47814a5e26ecf713edbb7b33)_

- **Pipeline board scroll affordance (#684)**: admin and mentor boards now show state-aware horizontal edge fades when more columns are available, including dark-mode styling and non-interactive overlays.

## [0.106.0-beta] - 2026-08-24

_Shipped 2026-08-24 20:25 UTC · commit [bea228b](https://github.com/21072026/Internship/commit/bea228b894ae99766677bf80015e8145422dd646)_

- **Mentor received-feedback dashboard (#1105)**: adds a tenant-scoped mentor-only aggregate API and read-only dashboard with rubric averages, a six-month trend, and individual mentee feedback.

## [0.105.8-beta] - 2026-08-24

_Shipped 2026-08-24 19:45 UTC · commit [77cbcd1](https://github.com/21072026/Internship/commit/77cbcd1c160391ae9e74da36b2af3362fb6bd7a6)_

- **The privacy notice names tawk.to (#1177)** — the live chat on the public home page receives the visitor's IP address and message content, which the consent gate and cookie banner already said but the notice itself did not. `PRIVACY_POLICY_VERSION` bumped to 2026-08-24 so new consent records reference the current text.

## [0.105.7-beta] - 2026-08-24

_Shipped 2026-08-24 19:36 UTC · commit [a575e73](https://github.com/21072026/Internship/commit/a575e73ab472e50c5af0a72ab9c293b56b7f9140)_

- **Set-password links no longer travel in API responses (#987)** — `POST /api/admin/company-users` and `/api/admin/source-users` emailed the link *and* returned it, putting a live single-use credential into reverse-proxy logs, devtools and screen shares; neither admin screen ever read it. They now return `{ ok, emailSent }`, matching the decision taken for `reset-password` in #875. The same change makes a failed set-password email visible instead of silent: it is reported in the UI and written to the audit trail, where before the admin was told the account was created and nothing else.

## [0.105.6-beta] - 2026-08-24

_Shipped 2026-08-24 19:25 UTC · commit [08dc49d](https://github.com/21072026/Internship/commit/08dc49dae1d581b71e8672f6d86f819a61709c21)_

- **The public demo stops aging (#1249)** — every preview deploy now puts the demo container on the image it just shipped and re-seeds it, instead of leaving it on the image from provisioning day. Measured before the fix: the demo served 0.78.0-beta while prod and preview served 0.105.0-beta. The twice-daily data reset and the redeploy share one script (`infra/server/demo-refresh.sh`), and a host without the demo provisioned is a no-op rather than a failed deploy.

## [0.105.5-beta] - 2026-08-24

_Shipped 2026-08-24 19:08 UTC · commit [dbef492](https://github.com/21072026/Internship/commit/dbef49264ad0b68be417215539f4880f7f298fbe)_

- **The restore drill can actually run (#1183 follow-up)** — it creates its scratch database through the same admin route the topic deploys use, because the app user cannot `CREATE DATABASE` on the server and the drill would otherwise fail before exercising a restore. The backup alert now names which half failed: a stale backup and an unproven restore are different problems, and sending "BACKUP CHECK FAILED" for a drill error reports broken backups that are in fact fine.

## [0.105.4-beta] - 2026-08-24

_Shipped 2026-08-24 19:00 UTC · commit [8297867](https://github.com/21072026/Internship/commit/829786758ccd2301955a699821ccc47f2754a0ef)_

- **Deploys can no longer take an environment down (#961)** — the container swap is now blue/green: the new image is proved as a canary (health, database, served sha) before the running container is touched, so a bad image fails the deploy instead of leaving nothing serving. The replaced image is kept as `<container>:previous` and excluded from image pruning, and `./infra/deploy-prod.sh --rollback` puts it back without git, a registry or a schema push.

## [0.105.3-beta] - 2026-08-24

_Shipped 2026-08-24 18:38 UTC · commit [59e23e7](https://github.com/21072026/Internship/commit/59e23e7add08b5c1d43b2f79b14914e4741a6702)_

- **Deploys stop dying on a 429 (#1239)** — self-hosted jobs no longer use any GitHub Action. Downloading an action archive from codeload answered 429 from the server's IP and failed the job before any repo code ran, taking down every topic preview and every prod/preview deploy; those jobs now fetch the repo with plain git, and the steps that genuinely need an action (the topic-preview comment) moved to a GitHub-hosted job.

## [0.105.2-beta] - 2026-08-24

_Shipped 2026-08-24 18:21 UTC · commit [8deb83e](https://github.com/21072026/Internship/commit/8deb83eea78f93f9596851e5d4fde522c09170bc)_

- **Per-PR preview databases (#1185, closes #1114)** — each topic environment now gets its own `internship_pr<N>` database, seeded with synthetic demo data and dropped when the PR closes, instead of sharing the preview database with every other PR. A `prisma db push` on one PR no longer reshapes the schema under the others, and no real preview data is reachable from a topic environment. `SEED_DEMO_FORCE` is narrowed from a blanket bypass to `internship_pr<N>` targets only, and the daily topic sweep now reclaims leaked databases as well as leaked containers.

## [0.105.1-beta] - 2026-08-24

_Shipped 2026-08-24 18:02 UTC · commit [c2f3f94](https://github.com/21072026/Internship/commit/c2f3f94d887b032a55123a4ad2e6b1aa004a89c8)_

- **Backup verification & restore drill (#1183)** — `infra/check-backups.sh` verifies daily that backups are still being taken (freshness, size, gzip integrity, retention window) and emails `ALERT_EMAIL_TO` when they are not; `infra/restore-drill.sh` rehearses the restore into a throwaway database and measures RPO/RTO. `docs/disaster-recovery.md` gained the failure playbook and the drill log.

## [0.105.0-beta] - 2026-08-24

_Shipped 2026-08-24 17:56 UTC · commit [c77a3c0](https://github.com/21072026/Internship/commit/c77a3c0746e0043a4ee5108eb68adb30aa4fbea8)_

- **Tags on people (#887)** — an org-scoped `Tag`/`UserTag` model, a multi-tag candidate filter evaluated server-side with an explicit any/all switch, tag chips on candidate rows and an inline editor on the candidate page, bulk tag/untag from the candidate list, and tag state carried in saved views. Mentors may tag their own mentees; limits (20 per person, 100 per org) are enforced server-side on both the single and the bulk path.

## [0.104.0-beta] - 2026-08-24

_Shipped 2026-08-24 16:00 UTC · commit [5cb9447](https://github.com/21072026/Internship/commit/5cb94473c0946807950eb0df1b7fec660e562c88)_

- **Preview-data sanitizer (#1186)**: `scripts/sanitize-db.mjs` (`npm run sanitize:preview`) rewrites a preview database into synthetic data — every account becomes `userN@demo.example.com` with a fake name and one shared password; phones, addresses, bios and personal links are cleared; uploaded files and every credential (invite/reset/verification tokens, API keys, webhook secrets, impersonation and SSO grants) are deleted; and all free text written by or about a person is replaced, including relation notes, message bodies, evaluation comments, interaction notes, weekly reports, notification text and ActivityLog detail/ip/userAgent. Relationships, pipeline history, dates and counts survive untouched — that is preview's test value. Two guards: it refuses to run unless the parsed database NAME contains `preview` or `internship_pr` and has no force flag (the mirror image of `seed:demo`'s local-only check), and it verifies itself afterwards, exiting non-zero if any real address, phone, file, note or credential survived. `npm run sanitize:verify` runs that check alone, changing nothing. The script header carries a full model-by-model inventory, including the models left alone on purpose.

## [0.103.0-beta] - 2026-08-24

_Shipped 2026-08-24 15:44 UTC · commit [5b124be](https://github.com/21072026/Internship/commit/5b124be7036d77a58a7ee0dd8a7d4be3927894af)_

- **Blind interview review (#819, the half that needs no demographic data)**: a new org setting `blindReview` (off by default) withholds a candidate's name, photo, university and id from an interviewer until that interviewer submits their own scorecard — from the API response, not just the screen, and in the panel list as well as the detail view. The assignment notification switches to a wording that names nobody, since a push that says who it is undoes the blinding before the panel is opened. A stable per-candidate label ("Candidate #A3F2") lets a panel discuss the same person without knowing who it is. Identity returns the moment the scores are submitted, and an admin who is not on the panel is never blinded — they have no scorecard to bias and they run the calibration. Deliberately an organisation-wide setting rather than a per-reviewer toggle: a bias control people opt into is one the reviewers who most need it skip.

## [0.102.0-beta] - 2026-08-24

_Shipped 2026-08-24 15:15 UTC · commit [0e35ece](https://github.com/21072026/Internship/commit/0e35ece72ed7e53203f6ac48b67c2230e6dd3207)_

- **Per-stage service levels (#817)**: an org states "nobody waits more than N days at this stage" once, in `/admin/settings`, and every stage move applies it. New `StageSla` model keyed by stage key — deliberately not a column on `PipelineStage`, whose editor is premium-gated and rewrites its whole set on save, because candidate experience stays in the free core and an SLA must survive a stage rename. The deadline is written in `emitStageChange`, the single chokepoint all three stage-writing endpoints already route through, so the board, the candidate page and bulk advance cannot disagree; a hand-typed `stageDeadline` still wins. Days are **calendar days**, recorded as such in the schema, the admin hint and this note. An org that configures nothing is untouched — its deadlines stay exactly as manual as before. Moving to a stage with no rule clears the deadline rather than leaving the previous stage's date to report a meaningless overdue. The existing overdue reminder now respects the `deadlines` preference in-app as well as by e-mail and is runnable on its own (`/api/cron?job=stage-deadlines`); the overdue count surfaces on the admin dashboard, and only when it is non-zero.

## [0.101.1-beta] - 2026-08-24

_Shipped 2026-08-24 14:35 UTC · commit [17bf246](https://github.com/21072026/Internship/commit/17bf2464da401c526c2f77469557d9925580861b)_

- **Phone-width row layouts (#1305)**: rows whose action cluster was pinned `flex-shrink-0` opposite the identity column now stack or wrap on a phone — `/admin/mentors` (the name/email column was squeezed to ~18px, chips ran under the buttons), `/admin/activity` (actor cut to `adm…`), `/mentor/mentees` (the third action clipped at the card edge), `/company` and the funnel/aging/stat rows on `/admin` + `/admin/analytics` + `/mentor/analytics`. The mobile top bar now truncates the brand *name* instead of the whole row, so the beta badge is no longer cut in half. `/admin/analytics`, `/admin/companies` and `/admin/support` also stopped pushing the page into horizontal scroll in German. New `e2e/mobile-layout-audit.spec.ts` audits four mechanical rules (no sideways scroll, nothing past the right edge, no box spilling its own content, no text box under 110px) across admin/mentor screens at 360px in Turkish and German; the reported-screens test is tagged `@smoke`.

## [0.101.0-beta] - 2026-08-24

_Shipped 2026-08-24 14:34 UTC · commit [ed29227](https://github.com/21072026/Internship/commit/ed29227ac51948eec9f4e3a913547d2cd4db75fd)_

- **Hiring-funnel KPIs (#815)**: new `src/lib/funnelKpi.ts` (pure) and `GET /api/admin/analytics/funnel` derive stage-to-stage conversion and time-to-hire from the same StatusChange trail the aging report reads, plus mentor capacity resolved through the existing `getMentorAvailability` so the report cannot contradict the assignment screen. Stage order comes from the tenant's own pipeline (#747) — no key like `HIRED_660` is assumed, and "finished" is that order's last on-path stage, whose label the screen names. Conversion counts the furthest stage a journey reached, so a skipped stage still counts as passed; a stage nobody entered reports "no data" rather than 0%, and the terminal stage reports no rate at all ("0% advanced" from the end of a funnel describes people who finished). Time-to-hire counts **only completed journeys** and the card states that population ("completed journeys only — N of M"), because candidates still moving have no end date and averaging them in reports a number about nobody. Both KPIs join the existing Excel and full-report exports.

## [0.100.0-beta] - 2026-08-24

_Shipped 2026-08-24 14:01 UTC · commit [cff9f16](https://github.com/21072026/Internship/commit/cff9f164179b6227d59d5bf3cd343e2825875a12)_

- **Interview scorecards with blind scoring (#824)**: a new `InterviewPanel` (+ `InterviewPanelMember`) assigns a candidate, a rubric and N interviewers; each writes an independent scorecard, and only once the panel is complete does the calibration view put them side by side with a per-criterion spread flag (≥3 points). Blind scoring is enforced in the API — `GET /api/interview-panels/[id]` withholds other interviewers' scores until the panel is complete AND the viewer has submitted their own, and the e2e asserts the response body rather than the screen. `EvaluationType` gains `INTERVIEW`; `Evaluation.relationId` becomes nullable with `subjectId`/`panelId`/`submittedAt` alongside it, so a scorecard can exist before any mentorship does — every existing query filters by `relationId` or traverses the relation and is unaffected, and a relation-less row is never a testimonial. A submitted scorecard cannot be edited, an admin can close a panel a no-show would otherwise stall (revealing only what was submitted, and never to the member who skipped), and the rubric is snapshotted from the org framework (#822) at creation so mid-round changes cannot split the panel.

## [0.99.0-beta] - 2026-08-24

_Shipped 2026-08-24 13:29 UTC · commit [fb7e7ab](https://github.com/21072026/Internship/commit/fb7e7ab2ff4de68c84324866db661fdd66a69aa0)_

- **Negative-outcome communication (#830)**: reaching the end of the road is no longer silent. `src/lib/outcomeComms.ts` maps a stage (plus its #810 drop-off reason) to one of three outcomes — `noMatch`, `placedElsewhere`, `poolInvite` — each with a full EN/TR/DE e-mail template. Landing on an outcome stage notifies the mentor with a link into the targeted-email composer, recipient ticked and template applied (`?relation=&template=`), and gives the mentee outcome-specific wording *instead of* the generic "your stage changed" line. Nothing is mailed automatically unless an admin turns on the new `outcomeAutoSend` setting, which ships off. The portal's journey card replaces the bare off-path label with where things stand plus concrete next steps, and the "🎉 Milestone reached!" banner no longer sits above a rejection. `INTERNSHIP_FOUND_ELSEWHERE_800` — and any drop-off marked `ACCEPTED_ELSEWHERE` — reads as the success it is, with its own celebratory wording.

## [0.98.0-beta] - 2026-08-24

_Shipped 2026-08-24 13:29 UTC · commit [fb7e7ab](https://github.com/21072026/Internship/commit/fb7e7ab2ff4de68c84324866db661fdd66a69aa0)_

- **Org-level competency framework (#822)**: evaluation criteria moved from hardcoded TypeScript arrays to per-tenant data, following the same three-file split #747 used for pipeline stages — `src/lib/evaluation.ts` stays client-safe (defaults + pure helpers), `src/lib/evaluationTemplates.ts` resolves from the DB server-side, `src/lib/evaluationCriteriaClient.tsx` provides the hooks. New `EvaluationTemplate` / `EvaluationCriterion` models with per-language labels, edited from `/admin/settings`. Score validation in `POST /api/evaluations` reads the tenant's resolved keys instead of the `ALL_CRITERIA` constant, and each evaluation is stamped with `templateId` so a record renders with the labels of its own era; criteria are retired (`active: false`), never deleted, and saving an empty list restores the built-ins. An org that defines no template keeps exactly the built-in four-plus-four and today's behaviour, proven by e2e. The public profile's evaluation average now averages whatever criteria a row actually carries rather than four fixed names.

## [0.97.0-beta] - 2026-08-24

_Shipped 2026-08-24 12:44 UTC · commit [a974a49](https://github.com/21072026/Internship/commit/a974a497f3e645ffd6c17257178689e7cd4f33a5)_

- **Email-less invitation links (#670)**: an invitation no longer needs an address. `InvitationToken.email` is nullable and gains a private `label`; leaving the email empty mints a shareable single-use, 7-day link instead of sending mail, and registration through it skips the address match, writes the registrant's address back onto the row and auto-links the mentorship the invitation already carried. Because such a link proves nothing about the address typed into the form, those accounts are created unverified and get the standard confirmation mail (named invitations stay verified-on-arrival). New `/mentor/invite` page (nav entry, role fixed to MENTEE server-side) lets mentors mint their own links; the invite list hands a still-usable email-less link back to the person who minted it, and resend/cancel now work for the invitation's own sender, not only admins.

## [0.96.0-beta] - 2026-08-24

_Shipped 2026-08-24 12:28 UTC · commit [8ede0a7](https://github.com/21072026/Internship/commit/8ede0a757194536dfe539f8c939f1247913fc103)_

- **One field for "who brought this person in" (#1296).** `User.referredById` (a registered person) and `User.sourceId` (a `Source` row) were two selects on two different cards of the candidate screen; they are now a single grouped picker (`ReferrerPicker`, `src/lib/referrer.ts`) whose kinds are mutually exclusive — `PATCH /api/users/[id]` rejects both at once and clears the other kind on every write. A source can be created from inside the picker (`GET/POST /api/sources`, admin + mentor), so an unregistered referrer no longer means a trip to `/admin/sources`. The mentor's "new mentee" form uses the same picker instead of the old free-text "Referans" input, and pre-merge free text is shown with a one-click "save as source".

## [0.95.2-beta] - 2026-08-24

_Shipped 2026-08-24 11:57 UTC · commit [f397baf](https://github.com/21072026/Internship/commit/f397bafecfd0a989d94bbc04670ff8cb02e4a049)_

- **Accessibility regression gate (#862, story #826)**: `@axe-core/playwright` now scans nine pages across five contexts (public, mentee, mentor, admin, company) against WCAG 2.0/2.1/2.2 A+AA. Today's critical/serious violations are frozen per page in `e2e/a11y-baseline.json`, so any NEW one fails the run while moderate/minor findings are reported without gating; both the baseline and the severity-classified report in `docs/a11y-audit.md` are regenerated with `A11Y_UPDATE_BASELINE=1`. The nine-page scan runs in the scheduled full suite; the PR gate gains only a single lightweight check (critical violations on the sign-in page, ~3 s). No application code changed — the audit report is the input for the fix issues.

## [0.95.1-beta] - 2026-08-24

_Shipped 2026-08-24 11:13 UTC · commit [953ecca](https://github.com/21072026/Internship/commit/953ecca77e3547bbd9f4c957ac64852c802b5881)_

- **Brand logo URL is now validated and fetched safely (#1294)**: `Organization.brandLogoUrl` was only length-checked (`z.string().max(2000)`), and the certificate renderer fetched it from the server without the SSRF guard the webhook sender already used (#893) — so an admin-set `http://169.254.169.254/…` or `http://127.0.0.1:3306` was reachable from the server's network position (blind SSRF: bytes are only ever embedded as an image, never echoed back). `tryEmbedImage` now goes through `assertPublicHttpsUrl`, and new `isSafeBrandLogoUrl` validates the field on write (`https://` without credentials, a same-origin `/path`, or an inline `data:image/…`; `http://`, `javascript:` and protocol-relative `//host/x` refused). The same field and the brand name/color are now attribute-escaped in `brandHeader`, where an unescaped `"` could inject markup into every transactional email an org sends. Adds `npm run check:query-scalars` (CI): a static guard that fails the build when an unvalidated `request.json()` field is used as a Prisma `where` value, where an object is read as a filter operator (`{"not": "…"}`) rather than a scalar id. Triage of the SAST report that prompted this — 25 findings, all false positives — is written up in `docs/security-audit-playbook.md` § 8.

## [0.95.0-beta] - 2026-08-24

_Shipped 2026-08-24 10:54 UTC · commit [c12bf9b](https://github.com/21072026/Internship/commit/c12bf9bb8f9dd30b1b6a5c2e33b613b12ce3eb8e)_

- **Signup funnel visibility (#1191)**: the admin analytics page gains a "Signup funnel" card — registered → verified → active counts plus verification and activation rates for the last 7 and 30 days, computed live and always outside the date-range picker (it answers "is the front door working right now?"). With enough volume and an unusually low verification rate the card turns amber and points at the e-mail health panel; a window with no sign-ups shows "—" and never warns. Completes story #1189 (make silent failures visible) alongside #1190.

## [0.94.0-beta] - 2026-08-24

_Shipped 2026-08-24 06:44 UTC · commit [55c8ed4](https://github.com/21072026/Internship/commit/55c8ed427f0ed579ae7c274b10812d0603c8b723)_

- **Public profile showcase (#1091, #1094 — story #1086)**: `/p/[userId]` gains two proof sections. Projects (#1091): memberships in PUBLIC projects with functional-role badge and technology chips plus the completed-task count — private projects leak nothing (both queries filter `isPublic`), task titles are never shown, and a new `User.publicShowProjects` toggle (profile settings, default on) hides the section. Evaluation summary (#1094): the mentor→mentee criteria averaged over PUBLISHED evaluations plus the latest author-approved excerpt with the mentor's display-style name — rendered only when the mentee's and the author's TESTIMONIAL consents are active, raw scores/comment never leave the server, and with any gate down the section does not render at all.

## [0.93.0-beta] - 2026-08-24

_Shipped 2026-08-24 06:26 UTC · commit [9cf5146](https://github.com/21072026/Internship/commit/9cf51463c0f3fdf69ae657f05bc83c4724995e9a)_

- **Live landing numbers (#1099)**: new session-less `GET /api/public/stats` returns exactly three integers (active mentors, open public projects, candidates waiting for a mentor) — rate-limited, 10-minute in-process cache, zero PII. The hero gains a live status strip fed by the same cached helper; a zero count drops its piece and with all three at zero the strip is not rendered at all. Numbers are computed, never hand-written into copy (reusing the placeholder templates #1107 pre-seeded).

## [0.92.0-beta] - 2026-08-24

_Shipped 2026-08-24 06:14 UTC · commit [d6f897d](https://github.com/21072026/Internship/commit/d6f897dc3f1d3aab6b6bb87e6f3c5e81e3d2c5be)_

- **Consent-based testimonials (#1096, #1098, #1100 — story #1087)**: new `TESTIMONIAL` consent type (both roles; revoking unpublishes in the same request via `revokePublishedFor`), `Evaluation.sharedPublicly/publishedAt/publicExcerpt/excerptApprovedAt` and a `User.testimonialNameStyle` display preference (initials by default). `/admin/testimonials` moderation: only both-sides-consented evaluations enter the pool, the admin drafts an excerpt (original comment never edited), the AUTHOR approves the exact wording at `/testimonials/approve`, and only then can publish succeed — every move audit-logged. Public chain: session-less `GET /api/public/stories` (four server-side gates re-checked per request, no scores/comment/contact fields), `/stories` page (404 when empty), and a landing stories section that does not exist in the DOM until a real story is published (no placeholders, per the landing honesty rules).

## [0.91.1-beta] - 2026-08-24

_Shipped 2026-08-24 04:59 UTC · commit [3c726b0](https://github.com/21072026/Internship/commit/3c726b039b82ac93f20b0b343f43475dd6364e1e)_

- **Landing founder identity (#1097)**: the transparency section gains a "Who is behind this?" block and the public footer a "Built and maintained by" line — both naming the founder (a natural person, per the licensing/IP rule: no company as owner) with a link to his public GitHub profile, in EN/TR/DE. Completes #1097; the GitHub links, business-model line and transparency strip landed earlier via #1107.

## [0.91.0-beta] - 2026-08-23

_Shipped 2026-08-23 20:24 UTC · commit [3236bac](https://github.com/21072026/Internship/commit/3236bacb58de4047b82b927fd81e475e1f924055)_

- **Binding mentor capacity (#1188)**: the public application link now closes itself when the mentor's `mentorCapacity` is reached (counting active relations plus pending applications) or when the mentor paused new mentees — `POST /api/apply` refuses with a clear reason and the public page explains the closed state instead of showing a form. Applications now land as PENDING `MentorshipRequest`s in the mentor's new `/mentor/applications` inbox; accept starts the relation, decline notifies the applicant politely — both via the shared `decideMentorshipRequest` service the admin queue was refactored onto. A null capacity keeps the link open as before; landing copy (`audMentor1D`, `faqMentor2A`) updated to the now-true promise.

## [0.90.0-beta] - 2026-08-23

_Shipped 2026-08-23 20:08 UTC · commit [d993a39](https://github.com/21072026/Internship/commit/d993a3976a5a1c71dda322414659d6e5c47b85ec)_

- **Mentee meeting visibility (#874)**: `GET /api/meetings` now serves MENTEE sessions their own relations' meetings (fail-closed for unlisted roles, #913); the portal dashboard gains an "Upcoming meetings" card with join link, in-app RSVP (reusing the meeting's own token credential) and per-meeting .ics download (#914); `/portal/calendar` renders the shared CalendarView for mentees plus a personal, rotatable/revocable ICS subscription feed (`User.icsFeedToken`, `/api/calendar/feed/<token>`, title+time only) (#915). Mentee-facing deadline events no longer link into /admin.

## [0.89.0-beta] - 2026-08-23

_Shipped 2026-08-23 19:53 UTC · commit [401e29f](https://github.com/21072026/Internship/commit/401e29f214472d234c382c0225b424c78ee00c6c)_

- **Notification coverage (#886)**: the silent mentee-facing events now create in-app notifications — interaction logged, meeting scheduled (recipient's timezone), goal assigned/completed (two-way), evaluation added (two-way, no scores/comments in the text). Stage changes now emit the same notification + `pipeline.stage_change` webhook from every write path (`PUT /api/mentorship/[id]`, non-backdated `POST /api/status-changes` — which now also keeps `pipelineStatus` in sync in one transaction — and bulk advance, one notification per person) via a shared `emitStageChange` service (#926). Company interest changes now also reach the candidate — only INTERESTED/SHORTLISTED, only with an active TALENT_POOL_VISIBILITY consent, and never with the company's name or note (#1101). Three new notification categories (interaction notes, goals & evaluations, stage updates) join /account; category toggles now gate in-app notifications too and stay usable when the e-mail master switch is off.

## [0.88.0-beta] - 2026-08-23

_Shipped 2026-08-23 19:06 UTC · commit [02f15d1](https://github.com/21072026/Internship/commit/02f15d15bbe61c00b89e34149c3bd33753c16c22)_

- **Email delivery health (#1190)**: delivery health (last success, failures since, attempts in 24h) is now derived from the `EmailLog` ledger and surfaced on the admin settings page, `/api/admin/email-health` and the token-gated `/api/health` detail view. An hourly check writes a durable `email.health_alert` activity entry and sends a best-effort ops email (`ALERT_EMAIL_TO`) after 3 consecutive failures or when the last success goes stale while attempts continue. Error text is scrubbed of recipient addresses before it leaves the server.

## [0.87.0-beta] - 2026-08-23

_Shipped 2026-08-23 17:52 UTC · commit [9fd52ec](https://github.com/21072026/Internship/commit/9fd52ecc9df7be5e1283bc5bf5ebb6bcedd456b3)_

- **Consent-based mentor directory + structured matching preferences (#937, #938, #939 — story #900).** New `MENTOR_DIRECTORY_VISIBILITY` consent (mentor-only `/account` toggle; revocation delists immediately); `/mentors` mentee-facing directory (`GET /api/mentors`: publicProfile AND active consent — the talent-pool dual gate verbatim — strict select allowlist, never e-mail/phone/WhatsApp, COMPANY/SOURCE fail closed, skill/language/accepting filters + pagination, availability via `getMentorAvailability`); `MentorshipRequest` gains non-binding `preferredField`/`preferredLanguages`/`preferredMentorId` (validated against the same directory-visibility rule), surfaced as chips + a preselected (changeable) mentor in the admin queue. Three new e2e specs, each proven locally against a real DB.

## [0.86.1-beta] - 2026-08-23

_Shipped 2026-08-23 16:46 UTC · commit [5e38009](https://github.com/21072026/Internship/commit/5e380094195166f73a699535e035b6105ea408c8)_

- **Registration assigns the tenant at creation time (#1272).** Invited users inherit the inviter's org (carried on `InvitationToken.orgId`, set at invite time); token-less self-registration gets the default org via the new `defaultOrgId()` helper — the same upsert the deploy backfill uses. Previously every account was created org-less, so fail-closed org scoping (#1227) 403'd an invited COMPANY user's portal until the next deploy ran the backfill. The demo seeder now backfills the default org onto its rows too, so the demo company account survives demo resets between deploys.

## [0.86.0-beta] - 2026-08-23

_Shipped 2026-08-23 12:25 UTC · commit [559ea7d](https://github.com/21072026/Internship/commit/559ea7dd83152f1ffd34c980dc9883ea13a3df52)_

- **Release fragments end the version-collision churn** (#1275). PRs no longer edit `package.json`'s version, `CHANGELOG.md` or `src/lib/releaseNotes.ts` — they add one JSON fragment under `releases/unreleased/` (new files cannot conflict). The displayed version is derived at build time from base+fragments (`next.config.js` → `APP_DERIVED_VERSION`), `/release-notes` shows pending notes as a synthetic entry, `check:release-fragments` validates fragments in CI, and the scheduled `release-compact.yml` folds them into the canonical files through a normal PR. This very entry is the first fragment.

## [0.85.0-beta] - 2026-08-23

### Changed
- **Mentee portal split into a summary + three sub-pages (#916).** The dashboard stacked
  ~15 panels on one page (5 641 px tall at 390 px). `/portal` is now a short summary —
  checklist, upcoming-meeting strip, missing documents, nudges, offer, journey strip and a
  compact mentor card — at 2 124 px (−62 %), with the heavier panels on real sub-routes so
  deep links and the back button behave: `/portal/journey` (full journey + mentorship
  detail incl. company and recent interactions), `/portal/goals` (goals, weekly reports,
  evaluations, interview prep), `/portal/requests` (questions, meeting requests). A shared
  `PortalTabs` bar (tablist/tab a11y markup) links the four sections on every page.
  `NotesPanel` no longer renders twice (only `/portal/notes`); the read-only profile card
  and the documents list left the dashboard for `/portal/profile(#documents)`. Sub-route
  fetches are trimmed to what each page needs. Affected e2e specs updated in the same
  change; the 390 px mobile-overflow audit now covers the three new sub-pages. EN/TR/DE.

## [0.84.1-beta] - 2026-08-23

### Fixed
- **Duplicate merge no longer 500s after committing** (#841 hotfix). `AuditLog.detail`
  is a default VARCHAR(191); the `USER_MERGE` detail carries per-relation move counts
  as JSON and overflowed it, so the audit insert threw P2000 AFTER `mergeUsers` had
  committed — the admin saw a 500 for a merge that had succeeded, no audit row was
  written, and a retry hit `not_found` because the absorbed user was already gone.
  (Caught by running `e2e/duplicate-merge.spec.ts`, which is not in the smoke set the
  PR gate runs.) The column is now `@db.Text` (lossless widen, passes the schema
  guard), and the post-commit audit/activity writes can no longer turn a committed,
  irreversible merge into an error response.
- **Merged profiles no longer point at the deleted user's files** (#841 hotfix).
  `cvUrl`/`avatarUrl` embed the user id (`/api/cv/<id>`, `/api/avatar/<id>`); the
  verbatim copy-if-empty left the primary linking to the absorbed id (404 after the
  delete). The URLs are now rewritten against the primary's own id whenever a file
  row moved.

## [0.84.0-beta] - 2026-08-19

### Added
- **Duplicate candidate detection & merge (#841).** The same student could enter through
  four doors (CSV import, self-registration, mentor manual entry, public application) that
  never checked each other; there was no way to combine the resulting records.
  - `src/lib/duplicateDetection.ts`: shared detector — exact signals on normalized e-mail
    and phone (country code / trunk zero / separators stripped, last-10-digit compare,
    cross-checked against WhatsApp), fuzzy name matching with Turkish-safe normalization
    (İ/ı, ş, ğ, ç, ö, ü via `transliterate` before lowercasing — the `'İ'.toLowerCase()`
    two-code-point trap is unit-tested), university as a corroborating signal. Generated
    `@import.local` / `@erased.local` addresses never match. Org-scoped.
  - Warn, never auto-merge: the mentor "new mentee" form gets a pre-flight 409 with a
    comparison panel and an explicit "create anyway" override; CSV import (incl. dry run)
    reports possible duplicates per row; public apply/register and source submissions
    notify admins (`duplicate.suspected`) without leaking anything into public responses.
  - `src/lib/mergeUsers.ts`: MENTEE-into-MENTEE merge in ONE transaction — every FK-backed
    relation re-pointed with per-constraint dedupe (consents, files, project membership,
    onboarding, reminders), bare no-FK user-id columns re-pointed (messages, evaluations,
    meetings, audit trails), derived unique keys recomputed (`CompanyInterest.scopeKey`,
    `InterviewRequest.activeKey`, `Conversation.directKey` incl. folding converged direct
    threads), mentorship relations collapsed semantically with weekly-report weekStart
    dedupe, profile fields folded (copy-if-empty + skills/languages union), then the
    duplicate row deleted. Refuses cross-org, non-MENTEE, erased and directly-linked pairs.
  - `/admin/duplicates`: bulk scan report with signal badges + side-by-side compare and an
    irreversible-merge dialog copying the erase pattern (typed name + admin password
    step-up, impersonation refused); `AuditLog` `USER_MERGE` entry with moved-row counts.
  - EN/TR/DE throughout; 14-test unit spec for the normalizers/matcher plus a full e2e
    merge spec asserting every moved relation and the audit record.

## [0.83.0-beta] - 2026-08-19

### Added
- **Mentor capacity/availability warnings on assignment** (#942). Building on #941's
  `getMentorAvailability()`, the three places an admin puts a mentee with a mentor now
  surface the mentor's current load and ask for confirmation before assigning one who's
  full or not currently accepting new mentees: direct assignment (`POST /api/mentorship`,
  used by `AssignMentorInline` on `/admin/candidates` and the assign form on
  `/admin/mentorship`), approving a mentee's mentorship request
  (`PUT /api/admin/mentorship-requests`), and pre-linking a mentor on an invite
  (`POST /api/invite`, `/admin/invite`). Advisory only — capacity/availability never
  blocks an assignment, only the existing plan-relation limit does; a full or paused
  mentor stays selectable everywhere, never hidden or disabled. `GET
  /api/users?view=mentorAvailability` is the new shared picker source (batched active-
  mentee counts, no N+1), and `formatMentorAvailability()`
  (`src/lib/mentorAvailabilityLabel.ts`) renders the same "3 / 4 · Available" label in
  all four pickers. E2E coverage: `mentor-assign-confirm`, `mentorship-request-approve-
  confirm`, `invite-mentor-confirm`, `mentor-picker-availability`, and extensions to
  `mentorship-direct-assign`, `mentorship-request` and `invitations`.

## [0.82.0-beta] - 2026-08-19

### Added
- **Participants can declare a meeting over, and the banner can show who is really
  in the call.** The dashboard's "meeting in progress" strip used to sit there for
  the whole assumed 60-minute window even when everyone had hung up, reading as
  "they are still talking". Now:
  - Any participant can mark the running meeting as over (`POST
    /api/meetings/[id]/end`) from a button on the banner — the strip then
    disappears for **every** participant, not just the clicker. Untouched, the
    banner still times out after the assumed hour exactly as before. Works for
    one-off `Meeting` rows, for multi-mentee meetings (all sibling rows sharing
    the room link are ended together), and for recurring-series occurrences that
    have no `Meeting` row (composite `<seriesId>:<ISO>` ids, marked in the new
    `MeetingOccurrenceEnd` table). Ending is participant-only, start-gated
    (a future meeting can't be hidden), and deliberately has no undo.
  - Optional live room info from JaaS: a new webhook receiver
    (`/api/webhooks/jaas`, enabled by `JAAS_WEBHOOK_SECRET`; subscribe the tenant
    to ROOM_CREATED / ROOM_DESTROYED / PARTICIPANT_JOINED / PARTICIPANT_LEFT)
    keeps a per-room `MeetingRoomState`, and the banner shows "n in the call"
    with real names while the room is active. Display-only: room lifecycle never
    auto-ends a meeting (rooms die whenever the last person drops, including
    someone popping in early). Unset secret = endpoint answers 404, feature off —
    the default in dev, CI and un-provisioned deployments.
  - Schema: `Meeting.endedAt` / `Meeting.endedById`, new `MeetingOccurrenceEnd`
    and `MeetingRoomState` models (additive `db push`).
  - E2E: `e2e/meeting-end.spec.ts` (end flow tagged `@smoke`, sibling-row fanout,
    occurrence ids, outsider 404, webhook feed end-to-end).

## [0.81.0-beta] - 2026-08-19

### Changed
- **Hybrid Jitsi routing — JaaS is now 1:1-only (#1256).** JaaS bills per monthly
  active user (25 MAU on the free dev tier) and every participant of an `8x8.vc` room
  counts, so `generateMeetingLink()` now takes the invitee count and only mints a JaaS
  room for one-on-one meetings (organizer + exactly one invitee: single-relation
  instant/scheduled meetings, accepted meeting requests, two-person project/chat
  calls). Group and bulk meetings (2+ invitees) and recurring series (audience derived
  from membership later, so never fixed) always get a free `meet.jit.si` link, tenant
  configured or not. All four link-generation call sites pass the count; unit-style
  coverage in `e2e/meeting-link-hybrid.unit.spec.ts` (tagged `@smoke`) exercises the
  JaaS branch that CI's env-less browser suite cannot.

### Added
- **Free-room fallback for failing JaaS calls.** A JaaS room name works verbatim on the
  public instance, so `freeMeetingFallbackLink()` (`src/lib/meetingLink.ts`) derives
  `https://meet.jit.si/<room>` from any of our own `8x8.vc` links (pasted third-party
  URLs get none). When the embedded JaaS call fails to start — tenant down, MAU quota
  blocked, token rejected — the meeting panel now offers "Continue in the free room"
  next to "Open in a new tab"; everyone who switches lands in the same room. New
  `meetings.instant.freeRoomHint` / `openFreeRoom` strings in EN/TR/DE.
  Docs: `docs/video-calls-jaas.md` gains the hybrid-routing table and fallback section.

## [0.80.1-beta] - 2026-08-19

### Fixed
- **Mentors can add their own mentees to their projects again** (#1103, from PR #1240).
  The mentor-facing `/api/users?view=picker` directory only returned mentors and admins,
  so the member picker was empty of mentees for mentors; it now also includes the
  mentees of the requesting mentor's own mentorship relations. Defense in depth on the
  write side: a MENTOR adding a MENTEE member to a project is refused with 403 unless a
  mentorship relation between them exists (admins unchanged). `@smoke` e2e regression in
  `e2e/project-members.spec.ts` covers picker scoping, own-mentee add (201), foreign-
  mentee add (403) and the admin path.

## [0.80.0-beta] - 2026-08-19

### Added
- **Mentees can own projects** (#1222, reworked from PR #1223). `ProjectOwnerType`
  gains `MENTEE`: the admin project form offers "A mentee" with a mentee picker,
  `resolveOwner()` verifies the picked user really has the MENTEE role (as it already
  did for ADMIN/MENTOR), and both project APIs accept the new owner type. The enum
  widening deploys cleanly now that the schema guard tells widening from narrowing
  (#1244/#1246). E2E regression in `e2e/project-owners-ui.spec.ts` covers the happy
  path and the role-mismatch rejection. Differences from PR #1223: the out-of-scope
  `docs/agent-experience.md` hunk was dropped, and an accidental deletion of the EN
  `projects.demo` i18n key (which would have broken key parity) was not carried over.

## [0.79.0-beta] - 2026-08-19

### Changed
- **In-app notifications are now multilingual (#921, #922).** Every notification used to be
  stored as a fixed English sentence; Turkish- and German-speaking users read their bell in
  English. Notifications now store an event key (`Notification.type`, e.g. `message.new`)
  plus interpolation values (`Notification.params Json?`), and the client renders them from
  the dictionary in the viewer's locale at display time — switch your language and your
  existing notifications switch with you.
  - Schema: `Notification.text` is nullable, new `Notification.params Json?`. Additive
    `db push`; legacy rows (and announcements, which stay admin-authored free text) keep
    rendering their stored `text` verbatim.
  - `notify()` new contract: `notify(userId, type, params?, link?)` — the old
    string-text signature is gone, so an un-migrated call is a type error. All ~45 call
    sites across `src/app/api` and `src/services/emailService.ts` migrated, plus the two
    raw `prisma.notification.create` writers (`company/interests`, `public-contact`).
  - `renderNotification()` (`src/lib/notificationText.ts`, client-safe) drives the bell,
    the `/notifications` page, browser notifications and the GDPR account export (which
    previously would have exported `null` for migrated rows). Unknown types fall back to a
    neutral string; `stage.changed` resolves built-in stage keys to localized labels and
    keeps tenant-set labels for custom stages via a `fromLabel`/`toLabel` snapshot.
  - Stage-change notifications now say which stage → which stage instead of "was updated".
  - ~70 event templates × EN/TR/DE in `notifications.events` (`check:i18n` enforces
    parity); a `notification-text.unit.spec.ts` unit suite covers rendering, fallbacks and
    custom-stage labels; affected e2e specs moved from text/exact-type assertions to
    event-key/params assertions.

## [0.78.0-beta] - 2026-08-19

### Added
- **Role conversion, where the person is** (#1252): the MENTOR ↔ MENTEE convert
  button (#1243) now also lives on the admin profile pages —
  `/admin/candidates/[id]` and `/admin/mentors/[id]` — via a shared
  `RoleConvertButton` component (the users list reuses it instead of its inline
  panel).
- **The converted person is told what happened** (#1252): the conversion signs
  them out of every device, so the endpoint now leaves an in-app notification
  (waiting after the forced re-login, linking to their new home shell) and sends
  an email in their preferred language (EN/TR/DE). The email is deliberately not
  gated on notification preferences — an account-level change that signs you out
  everywhere is a transactional notice like a password reset, not an opt-out-able
  digest.
## [0.77.0-beta] - 2026-08-19

### Added
- **OpenGraph cards for public profiles (#966, extracted from PR #1221).** Sharing a
  `/p/<userId>` link on LinkedIn/WhatsApp/Slack/X now unfurls into a branded 1200×630 PNG
  (`src/app/p/[userId]/opengraph-image.tsx`, Node runtime): name, role, location, bio
  snippet and up to 5 skills, selected with the same PII-safe visibility gate as the page.
  Non-public and nonexistent ids get the same generic brand card, so the endpoint never
  reveals whether an id exists. Differences from the PR #1221 version: the avatar is
  embedded as a data URI read straight from `AvatarFile` (satori cannot fetch the relative
  `/api/avatar/<id>` URL), and the bio is truncated in JS (satori does not support
  `-webkit-box` line clamping — that render path was never exercised by the old CI test).
  E2E coverage in `e2e/public-profile.spec.ts`; `publicProfiles` feature-catalogue entry
  added (EN/TR/DE). The demo-mode part of PR #1221 was superseded by #1234; its analytics
  part remains open (CSP + consent questions).
## [0.76.0-beta] - 2026-08-19

### Added
- **One-click demo sign-in** (#966, maintainer request). On the demo instance the
  sign-in page shows the shared demo accounts as three buttons (Admin / Mentor /
  Mentee, `demo-quick-login`) that sign in directly — no copying credentials from
  `/demo`. `src/app/auth/signin/page.tsx` became a thin server wrapper that resolves
  the server-only `IS_DEMO_MODE` flag and hands `DEMO_ACCOUNTS`/`DEMO_PASSWORD` to the
  (unchanged) client form as a prop — on every non-demo instance the prop is null and
  the page renders exactly as before (guarded by an e2e test). The Safari
  session-settle poll was extracted into `settleAndRedirect()` and shared by both
  sign-in paths. i18n: `demo.quickTitle`/`demo.quickHint` (EN/TR/DE).

## [0.75.0-beta] - 2026-08-19

### Added
- **The public demo is now reachable** (#966). The demo shipped in #1234 but nothing
  linked to it and the environment itself had never been provisioned — the changelog
  said "demo" while visitors had no way in. Two halves to fix that:
  - *Server (docs/DEMO.md prerequisites, done 2026-08-19):* `internship_crm_demo` DB +
    scoped user, `/etc/internship-crm/demo.env`, the `internship-crm-demo` container on
    :3203 (current `preview-<sha>` image), and the `crm-demo.ersah.in` Plesk vhost with
    the wildcard cert. First fill via the `demo-reset.yml` workflow; write blocklist
    verified live (403 on `/api/account`).
  - *App:* the landing page links to the demo from the hero (`hero-demo-cta`, with a
    "synthetic data, resets twice a day" note), the bottom CTA block and the public
    footer; new `demo` feature-catalogue entry (EN/TR/DE). All read `DEMO_URL` from
    `src/lib/demoMode.ts` and are hidden on the demo instance itself (it has the banner).
    E2E: `e2e/landing-demo-cta.spec.ts`.

## [0.74.0-beta] - 2026-08-18

### Added
- **Admin role conversion** (#1243): an admin can convert an account between
  MENTOR and MENTEE from the `/admin/users` row (inline confirm panel, EN/TR/DE).
  `PATCH /api/users/[id]` accepts a `role` field — those two roles only: ADMIN is
  not grantable through this endpoint, and COMPANY/SOURCE accounts (structural
  links) are refused as source or target. Existing mentorships survive the flip —
  the shells are derived from the relation table (#1141), so a converted mentor
  still reaches their open mentees and vice versa. The conversion stamps
  `sessionsValidFrom` (the sign-out-all cutoff): every live session of the
  converted user is revoked, the next sign-in mints the new role — and walks a
  promotion through the 2FA setup gate where the org policy covers mentors.
  Audited as `user.role_changed` at warning level.

## [0.73.0-beta] - 2026-08-17

### Added
- **Video calls on our own Jitsi tenant (JaaS, #1237).** The embedded meeting panel used
  the public `meet.jit.si`, which *disconnects an embedded call after five minutes* and
  says so in a banner — the in-app call was a demo, not a feature. With
  `JAAS_APP_ID` + `JAAS_API_KEY_ID` + `JAAS_PRIVATE_KEY` set, new rooms are
  `https://8x8.vc/<appId>/InternshipCRM-<hex>` and the panel loads them through 8x8's
  `external_api.js` with a signed per-participant JWT: no cutoff, display name filled in
  from the account, and the organizer (plus admins) joins as moderator. Setup, costs and
  the rollback are in [docs/video-calls-jaas.md](docs/video-calls-jaas.md).
  - `src/lib/jaas.ts` signs the token with `node:crypto` (RS256, `kid` = the API key id) —
    no new dependency. It is scoped to **one room**, never `*`, lives two hours, is minted
    per join and never stored. Recording/live-streaming/transcription/dial-out are off in
    every token. `JAAS_PRIVATE_KEY` accepts a PEM with escaped newlines or a base64 PEM,
    and all three variables are required or the feature stays off — a half-configured
    tenant would mint tokens 8x8 rejects, which reads to the user as a broken call.
  - `GET /api/meetings/[id]/call-token` mints it, but only for someone who was in the
    meeting: `canAccessMeeting` (`src/lib/meetingAccess.ts`, extracted from
    `canAttachNoteToMeeting` so notes and calls share one rule). Anyone else gets a 404,
    the same answer as a meeting that does not exist. `Cache-Control: no-store`.
  - **Unset, nothing changes**: rooms stay on `meet.jit.si`, the panel keeps its plain
    iframe, and the endpoint answers `409 { code: 'not-configured' }`. That is the state of
    local dev, CI and every e2e run — and the rollback for production.
  - The panel falls back to "open in a new tab" whenever the room cannot be shown inside
    the app: an old link, a rejected token, a fatal error from 8x8, or a blocked script.
    A blank panel is worse than a working link.
  - Rooms are only mounted on the wide layout now. The phone branch was already a Join
    button, and `display:none` does not stop an iframe from joining a call.

### Changed
- `Permissions-Policy` and the CSP `script-src`/`frame-src` name `https://8x8.vc` (exact
  host, no wildcard) alongside `meet.jit.si`, which stays for rooms created before the
  switch. `e2e/security-headers.spec.ts` pins both.
- The room-link template lived in three places (instant meetings, accepted meeting
  requests, recurring series); it is one `generateMeetingLink()` in `src/lib/meetingRoom.ts`
  now, so the JaaS switch applies to all three.
- New feature-catalogue entry for in-app video calls (`src/lib/features.ts` +
  `featureCatalog` EN/TR/DE) — the claim only became true with this change.

## [0.72.0-beta] - 2026-08-14

### Added
- **Public demo instance** (#966). `DEMO_MODE=true` turns a deployment into a public,
  self-serve demo: a banner on every page, a `/demo` page listing the three sign-in
  accounts `prisma/seed-demo.mjs` creates, and a dedicated database of synthetic data.
  Unset — which is every other environment — the feature is completely inert: no banner,
  `/demo` answers 404, and no write is refused.
  - **Writable on purpose.** A demo where every button 403s demonstrates nothing, so
    writes are allowed by default and only a short, explicit list is refused
    (`DEMO_BLOCKED_WRITES`, `src/lib/demoMode.ts`): account email/password, 2FA,
    sign-out-all, account erase, admin password reset, webhooks (an SSRF egress from the
    production host), API keys, the mail tester, bulk import, and every file upload. The
    pipeline, interactions, projects, offers and reports all stay usable.
  - **Mail is stopped at the transport, not the routes.** `sendEmail()` records a
    `SKIPPED` row on the demo instead of delivering, so a visitor cannot point an invite
    at a stranger, every flow stays clickable, and the admin email log shows what would
    have been sent.
  - **The reset is an operational job, not an endpoint.** `.github/workflows/demo-reset.yml`
    (02:00/14:00 UTC) runs `prisma/reset-demo.mjs` on the server, then re-seeds. There is
    no `/api/demo/reset`, so no reset secret exists to leak and no route can be aimed at
    the wrong database.
  - `prisma/reset-demo.mjs` truncates every table in the database it is given, so it
    refuses unless `DEMO_MODE=true` **and** the database name ends in `_demo` — no
    override flag. Production (`internship_crm`) and the shared preview
    (`internship_crm_preview`) can never satisfy that check.
  - `prisma/seed-demo.mjs` now also seeds a namespaced demo ADMIN
    (`admin.demo@demo.example.com`) and accepts a `*_demo` database as a legitimate
    target alongside localhost.
  - Two new CI gates: `npm run check:demo-blocklist` fails the build when a blocked
    pattern stops matching any real route (how the block silently breaks — a rename) or
    when a must-block route is left uncovered, and
    `infra/test/reset-demo-guard.test.sh` asserts the reset refusals against the real
    production and preview database names.
  - Setup and rationale: [`docs/DEMO.md`](docs/DEMO.md).

## [0.71.2-beta] - 2026-08-14

### Changed
- The public project showcase empty state now tells mentees to ask their mentor about
  projects they can join, while continuing to describe only publicly visible projects (#1106).

## [0.71.1-beta] - 2026-08-14

### Fixed
- **The destructive-schema gate no longer blocks additive deploys** (#1230). The
  `DESTRUCTIVE` pattern in `infra/schema-guard.sh` matched `MODIFY`/`CHANGE` without a
  trailing word boundary, so any identifier or enum value merely *starting* with "change"
  matched and the rest of the line satisfied `[^;]*NOT NULL` on its own. `WeeklyReport`'s
  `CHANGES_REQUESTED` enum value (#1218) tripped it inside a plain `CREATE TABLE`, and
  production stopped deploying — six releases' worth of merged work stayed off prod while
  preview kept deploying, because preview runs the gate with `--warn-only`. Added `\b` on
  both sides of the alternation.
- New `infra/test/schema-guard.test.sh`, wired into the CI job next to the backup-dump
  test: it reads the pattern out of the guard itself (so it cannot pass against a stale
  copy) and asserts both directions — every genuinely destructive statement still matches,
  and additive `CREATE TABLE` / `ADD COLUMN` / index statements do not.

## [0.71.0-beta] - 2026-08-14

### Added
- **Mentor availability preference** (#941). New nullable `User.acceptingMentees` — the
  mentor's own "I can take a new mentee right now" switch, deliberately separate from
  `mentorCapacity` (a headcount ceiling): a mentor under capacity can still switch it off
  (e.g. going on leave). `null` means no preference was ever recorded, in which case
  availability falls back to a capacity-derived guess.
  - Derivation lives in one pure function, `getMentorAvailability()`
    (`src/lib/mentorAvailability.ts`), returning `status` (`available` / `at_capacity` /
    `not_accepting`), `source` (`preference` / `capacity`) and `capacityKnown`, so the #941
    mentor screen and the #942 admin assignment screen can never drift apart.
  - `GET /api/profile` returns `activeMenteeCount` + `availability` for MENTORs only; the
    response shape is unchanged for every other role.
  - `acceptingMentees` joins `MENTOR_ONLY_FIELDS`, so a mentee or admin cannot set it
    through the shared profile endpoint.

## [0.70.0-beta] - 2026-08-14

### Added
- **Requisition shortlists and interview approvals** (#807). Companies can shortlist eligible candidates for their own requisitions and submit deduplicated interview requests. Tenant-scoped admins or the candidate's active mentor can approve or decline atomically; approvals notify the candidate and recommend—but never automatically apply—the interview pipeline stage. Every decision is audited, and approved requests link to the existing meeting scheduler.

## [0.69.0-beta] - 2026-08-14

### Added
- **Structured requisition management** (#806). Admins and COMPANY users can create, filter, edit, assign and close tenant-scoped hiring requisitions while tracking openings, filled positions, skills and lifecycle status. A manual idempotent backfill can copy legacy `CompanyNeed` rows without changing the existing need-alert matcher or dedupe flow.

## [0.68.0-beta] - 2026-08-14

### Added
- **Internship completion certificate & reference letter** (#813). Admin/mentor can generate
  an org-branded PDF for a completed internship, from a completed-relation action on the
  candidate/mentee detail page (both `/admin/candidates/[id]` and `/mentor/mentees/[id]`).
  - `CertificateGenerator` previews an auto-filled, editable EN/TR/DE draft (certificate or a
    freely-rewritable reference letter) — start/end date, duration, and which of the mentee's
    skills to list — before generating. Reuses `renderTemplate.templateToHtml` for the preview
    and `orgBranding`/`branding` for the org name/logo/accent color, matching the existing
    document-template pattern (`templates.ts` / `TemplatesLibrary`) instead of introducing a
    new branding system.
  - Eligibility (`certificateEligibility.ts`) does not hardcode `INTERNSHIP_COMPLETED_490`: it
    accepts `MentorshipRelation.status === 'COMPLETED'` (works under any custom pipeline, #747)
    or, when the canonical stage key is still present in the org's resolved stages, having
    reached-or-passed it.
  - The generated PDF is rendered server-side with `pdf-lib` (new dependency) — pure JS, no
    native binaries, no headless-browser process — and stored as a normal `Document` row
    (`type: CERTIFICATE`, `ownerId` the mentee), so the existing `documentAccess` rules (owner,
    their mentor, or an admin — 403 otherwise) gate it with no new access-control code. The
    mentee can download it from `/portal` (reuses `DocumentsManager`, read-only there).
  - Deliberately did not add: public/unauthenticated verification (out of scope for #813), a
    new PDF template engine (the renderer understands the same constrained markdown subset as
    `renderTemplate.ts`), or a schema change (no new columns/models — the existing `Document`/
    `DocumentType.CERTIFICATE` were already sufficient).

## [0.67.0-beta] - 2026-08-14

### Added
- **Weekly internship reports, mentor approval and missing-report attention** (Story #812).
  Mentees can save or submit one report per UTC week from the portal, review their history
  and print an internship diary. Assigned mentors review the same reports from a dedicated
  mentee-detail tab, approving them or requesting changes with feedback. Strict server-side
  role and relationship checks protect every read and transition.
- Mentors now see an attention signal after two consecutive completed internship weeks are
  missing. A Friday cron sends a localized in-app reminder and, when the mentee's weekly-report
  email preference permits it, an email in their stored EN/TR/DE language. A unique weekly
  delivery claim makes overlapping or repeated runs idempotent.

## [0.66.0-beta] - 2026-08-14

### Added
- **Required-document checklist and missing-document reminders** (Story #811). Organizations
  can configure localized, role- and pipeline-stage-specific document requirements without
  extending the fixed document-type enum. Admins can review missing mandatory documents,
  uploads can be linked to a requirement while preserving existing versioning and access
  controls, and mentees see only their own outstanding items on the portal. Weekly reminders
  use recipient language and preference settings, with a database-backed per-week dedupe key;
  organizations without requirements retain the previous document behavior.
## [0.65.0-beta] - 2026-08-14

### Added
- **Drop-off reason tracking** (#810) — moving a mentee into a negative/off-path pipeline stage
  (e.g. "Internship dropped") now requires picking a reason from a shared whitelist
  (`src/lib/dropoffReasons.ts`: candidate withdrew, no response, accepted elsewhere, schedule
  conflict, location, skill mismatch, company cancelled, performance, other — "other" additionally
  requires a free-text note). New `StatusChange.reasonCode` / `reasonNote` columns, left `null` for
  every pre-existing row and every move into a non-negative stage.
  - Centralized in `validateDropoffReason()` (`src/lib/stageChange.ts`) and enforced server-side on
    every write path that can change `pipelineStatus`: `/api/mentorship/[id]` (also what the admin
    and mentor board drag-and-drop and the per-card stage select call), the manual history
    correction endpoint `/api/status-changes`, and `/api/admin/candidates/bulk`'s `advanceStage`
    action (defense in depth — that action only ever targets the next on-path stage, so it never
    actually triggers the check, but it's still wired the same way as the others).
  - "Negative stage" is resolved from the org's own pipeline config (`PipelineStage.isOffPath` via
    `resolvePipelineStages`), not a hardcoded key list — a tenant's custom pipeline (#747) is
    honored automatically.
  - New shared `DropoffReasonDialog` gates the admin board, mentor board, and candidate-detail
    stage-change/history UI — a reason-less request into a negative stage can't be sent from any of
    them.
  - Admin analytics gained a stage × reason drop-off breakdown (`GET /api/admin/analytics/aging`
    → `dropReasons`), with legacy rows that predate this feature (`reasonCode: null`) grouped under
    "Unspecified" rather than dropped, plus a matching sheet in the analytics Excel export.
  - `#740`'s bulk-advance regression (stepping via `nextOnPathStatus`, never a raw `indexOf+1`) is
    unaffected and re-covered in `e2e/dropoff-reasons.spec.ts`.
  - New EN/TR/DE `dropoff.*` and `analytics.aging.dropReasons*` i18n strings.
## [0.64.0-beta] - 2026-08-10

### Added
- **Offer management** (#809) — a full workflow for extending, sending and deciding job offers
  within a mentorship. New `Offer` model (`orgId`, `relationId`, `requisitionId?`, `companyId?`,
  `status` — free `String`, not an enum, per the existing pipeline-status convention —
  `position`, `startDate?`, `compensationNote?`, `expiresAt?`, `sentAt?`, `decidedAt?`,
  `declineReasonCode?`, `declineNote?`, `createdById`, `decidedById?`), indexed on
  `[orgId, status]` and `[relationId]`. A single server-side state machine
  (`src/lib/offers.ts`) is the only place that decides legal transitions
  (`DRAFT -> SENT -> ACCEPTED|DECLINED|EXPIRED|WITHDRAWN`) and who may run them — ADMIN does
  everything; a MENTEE may only accept/decline their own `SENT` offer; COMPANY is read-only on
  its own `companyId`'s offers. `GET/POST /api/offers` and `GET/PATCH /api/offers/[id]` validate
  `status`/`declineReasonCode` as `z.string()` against that central whitelist (never
  `z.enum`), and never `select` `compensationNote` for any caller except ADMIN or the offer's own
  MENTEE — verified by e2e response-body assertions, not just UI hiding.
  Admin UX: a 3-step "Offer bilgileri → Tarih & ücret → Önizleme ve gönder" wizard on the
  candidate's Mentorship card (`OfferManagementPanel`/`OfferWizardModal`), with send/withdraw
  actions gated to the current status and a history timeline read from `AuditLog`
  (`offer.create/send/accept/decline/withdraw/expire`).
  Mentee UX: an `/portal` offer card (`OfferCard`) showing position, company, start date, a
  "N days left / due tomorrow / due today" decision countdown, and — only for this offer's own
  mentee — the compensation note; accept goes through a confirmation dialog, decline requires a
  reason (`COMPENSATION | POSITION | LOCATION | OTHER_OFFER | START_DATE | OTHER`, free text
  optional); after a decision the card shows a persistent accepted/declined state (not just a
  toast) with a "what's next" note.
  SENT and ACCEPTED/DECLINED transitions email + in-app notify through the existing
  `emailService`/`notify` infrastructure, EN/TR/DE. A new cron step (`expireOffers`,
  `src/lib/offerNotify.ts`) flips overdue `SENT` offers to `EXPIRED`, idempotently — the
  transition is claimed with a guarded `updateMany` before any audit/notify/email, so two
  overlapping cron ticks can never double-fire either. An ACCEPTED offer never auto-changes the
  mentee's pipeline stage; the admin panel only *suggests* moving to the org's `HIRED_660` stage
  when that key actually exists in the org's resolved pipeline (`resolvePipelineStages`) — a
  tenant on a fully custom pipeline (#747) without that stage never sees the suggestion, and the
  accept/decline flow itself has no dependency on pipeline stages at all.
  Tests: `e2e/offers.spec.ts` (wizard create+send, mentee accept/decline with a persistent state,
  invalid-transition 400, cross-mentee IDOR, compensationNote leak check, company-with-no-companyId
  403, withdraw, and the two-run cron dedupe) and `e2e/offers-custom-pipeline.spec.ts`
  (custom-pipeline org never gets the HIRED_660 suggestion; accept still works end-to-end).

## [0.63.2-beta] - 2026-08-11

### Changed
- Offline fallback (`/offline`) now shows a direct link to the live site (`https://crm.ersah.in`), so users can jump back to the main CRM URL once they reconnect.

## [0.63.1-beta] - 2026-08-09

### Security
- **Email action links expire after 90 days** (#1211). They previously never aged out, so a
  forwarded notification or a leaked mailbox archive let someone mark-read/react as that user
  indefinitely. An expired link answers `410 Gone` and the page says so, rather than showing
  the misleading "invalid link". Both actions remain low-severity and reversible — hence 90
  days rather than hours.
- **`EmailLog` is now covered by erasure and retention** (#1211). The log is keyed by
  recipient address, not by a relation, so nothing cascaded to it: an erased account's address
  survived in it. `hardDeleteUser` and `anonymizeUser` now clear it (reading the address
  *before* the row is deleted or rewritten), and a daily job prunes rows older than
  `EMAIL_LOG_RETENTION_DAYS` (90).
- **Regression test for the password column** (#1211). `accountState` has to *read*
  `User.password` to tell a mentor-created record apart from a deactivated account, which
  puts the hash one spread operator away from a response. A spec now asserts that no
  `/api/users` response contains a bcrypt prefix — matching on `$2a$`/`$2b$` rather than a key
  name, so a rename cannot silence it.
### Changed
- **The unread digest no longer carries per-line reaction links** (#1211). A five-item digest
  meant 25 extra links, and a high link count is one of the strongest spam signals there is —
  the opposite of what this change set exists to achieve. The five reactions stay on the
  single-message notification, where "the message this email is about" is unambiguous; the
  digest keeps its per-conversation "mark as read" link.

## [0.63.0-beta] - 2026-08-09

### Added
- **Timezones, end to end** (#1210). The render/parse helpers landed with #1030 / #1061 /
  #1110, but the user-facing half was missing: only mentees could pick a zone, new accounts
  had none, nothing confirmed a time across zones, and no email said which clock it was
  written on.
  - **Settings → Timezone**, for every role (`AccountSettings`, `/account#timezone`). Saved on
    pick like the language and theme selectors — a zone left unsaved behind a button is
    exactly the state that produces a wrong meeting time. The browser's zone is *offered*
    when it differs, never forced: someone working Istanbul hours from Berlin means the zone
    they chose. Writes go through the existing `PUT /api/profile` (`timezone` is already in
    its schema and belongs to no role), so `POST /api/profile/timezone` stays what it is —
    the silent, fill-if-empty path used by `TimezoneSync`.
  - **Registration records the browser's zone** (`/api/register` accepts an optional
    `timezone`, dropped if invalid — registration must never fail over this), so the
    verification mail and anything booked on day one already read right.
  - **`AttendeeTimes`** (`src/components/meeting/AttendeeTimes.tsx`) previews the picked
    instant on every attendee's clock, one line per *distinct* clock — three people in
    Berlin, Paris and Madrid are one reading, not three. Wired into the bulk scheduler
    (`MeetingsManager`), the per-candidate panel (`MeetingSchedulerPanel`), the mentee's
    meeting request (`MeetingRequestsPanel`) and the project's recurring slot
    (`ProjectWeeklyMeeting`, which recomputes the next occurrence client-side from the
    picked days/time). Readings sort west → east and render `h23`, matching how the app
    writes times everywhere else.
  - **`Meeting.timeZone`** stores the clock the organizer picked on, captured at creation.
    `scheduledAt` is enough to render the time for anyone but not to say *which* reading was
    agreed on, and the organizer's profile zone cannot stand in for it — that changes when
    they travel. Null for older rows; falls back to the profile zone.
  - **Every time-bearing email** now names the recipient's zone and links to
    `/account#timezone` in small print, adds the other participants' clocks when they differ
    (the project-series reminder does this for the whole team), and prints the organizer's /
    requester's reading as a second line on invites and meeting requests. Zone comparison is
    by *offset at that instant* (`sameWallClock`), so Berlin and Paris don't produce a
    redundant second line and a pair that diverges across a DST change still does.
  - New helpers in `src/lib/timezone.ts`: `zoneLabel`, `sameWallClock`, `readingsByZone`,
    `supportedTimeZones` / `timeZoneOptions` (memoized — the IANA list is ~450 strings) and
    `browserTimeZone`. `ProfileForm` now shares the option list instead of building its own.
  - `e2e/timezone-settings.spec.ts` covers the `/account` picker, the registration capture
    and the cross-zone scheduling preview.

## [0.62.0-beta] - 2026-08-09

### Added
- **One-click actions in notification emails** (#1204): the five composer reactions
  (`👍 ❤️ 😂 😮 🎉`) and a "mark this conversation as read" link, in both the per-message
  notification and the unread digest.
  - `src/lib/emailActionToken.ts` — HMAC-signed action tokens, same construction and trust
    argument as the Reply-To tokens (`replyToken.ts`). A reaction token is bound to a
    **message id**, not to "the newest message in the thread", so a reply arriving between
    send and click cannot redirect the reaction onto the wrong message. The emoji is stored
    as an *index*, so a token can never carry an arbitrary string into the database.
  - Links land on `/m/[token]`, which performs the action from the browser via
    `POST /api/email-action`. Deliberately not a mutating `GET`: mail clients and corporate
    link scanners (Outlook Safe Links, antivirus gateways) prefetch every URL in a message,
    which would post reactions nobody clicked. Scanners do not execute scripts.
  - Reacting also marks the thread read — you cannot react to something you have not seen.

### Fixed
- **Replying by email now marks the conversation read** (#1204). `routeInboundEmail` stored
  the reply but left `readAt` untouched, so the hourly unread digest kept resurfacing
  conversations that had already been answered — and the in-app badge kept counting messages
  the user had demonstrably read. Answering the newest message now marks it and everything
  before it, matching what opening the thread in a browser already did
  (`src/lib/threadRead.ts`, shared by the inbound-email and email-action paths). Failures are
  logged, never fatal: a delivered reply is not lost over its read bookkeeping.

### Added
- **Outbound mail is split into two channels by category** (#1203), so scheduled system mail
  cannot eat a relay's daily allowance. `primary` (`SMTP_*`) carries what must reach a human —
  `verification`, `invitation`, `password-reset`, `message`, `test` — and points at a reputable
  relay; `bulk` (`SMTP_BULK_*`) carries `unread-digest`, `activity-digest`, `mentor-digest`,
  `analytics-report`, `meeting-reminder`, `interaction-reminder`, `stage-deadline`,
  `retention-reminder`, `company-need-alert` and `announcement` over our own server.
  - **Uncategorised mail stays on `primary`** — silently downgrading an unclassified call site
    is the kind of regression that only surfaces when it costs a user. Bulk is opt-in.
  - **`SMTP_BULK_HOST` unset ⇒ single channel**, exactly the previous behaviour, so preview and
    topic environments need no new configuration.
  - `SMTP_BULK_FROM` may use a different domain (e.g. `noreply@ersah.in`) so the two sender
    reputations stay independent — a digest marked as spam cannot drag down the password-reset
    mail. Verified: both identities resolve distinctly at runtime.
  - `EmailLog.transport` records which channel carried each message; the admin panel shows both
    channels' health, a 24-hour per-channel count ("this is what counts against the quota") and
    a per-category breakdown so a noisy job can be moved rather than the quota raised.
- **`infra/check-mail-dns.sh`** — read-only sender-authentication readiness check (every DKIM
  selector in both record types, plus SPF/DMARC/PTR). Exits non-zero while DKIM is missing so it
  can gate a relay switch.
- **Outbound email delivery log** (#1194). `sendEmail()` now records every attempt in a new
  `EmailLog` model — recipient, subject, category, outcome (`SENT` / `FAILED` / `SKIPPED`)
  and the error. Metadata only: the body is never stored, so message content does not get a
  second home that account erasure would have to chase.
  - Visible at **Admin → Settings → Email health**, with a 7-day `SENT/FAILED/SKIPPED`
    breakdown above the last 25 attempts (`GET /api/admin/email-log`, admin-only —
    recipient addresses are personal data).
  - The key call sites pass a `category`: `verification`, `invitation`, `password-reset`,
    `message`, `unread-digest`, `test`. "Are verification mails going out at all?" is now
    answerable without shell access to the server.
- **Admin-side "resend verification"** (`POST /api/users/[id]/resend-verification`, #1194).
  The self-service resend on the sign-in page only helps someone who comes back and tries
  again; a user who never received the first mail has no reason to. The endpoint refuses
  any account that is not actually waiting on a click (409 + the resolved state).
- **`accountState` — one derived state instead of a bare `isActive` flag** (`src/lib/accountState.ts`,
  #1194): `active` / `unverified` / `pending_approval` / `deactivated` / `no_login` /
  `placeholder_email` / `erased`. `/api/users` returns it for the directory and full field
  sets (the `password` column is read only to derive it and is stripped from every response).

### Changed
- **SMTP transports now have bounded timeouts** (10s connect/greeting, 20s socket, #1203). An
  unreachable or wedged mail host used to hang the request that triggered the send — and, once
  the admin panel began verifying two channels, the panel itself.
- **`sendEmail()` no longer fails silently** (#1194). An unconfigured SMTP setup used to be a
  bare `console.log` + `return`, which made a broken mail pipeline indistinguishable from
  users who simply never replied. It now logs at error level and records a `SKIPPED` row;
  send failures are recorded as `FAILED` and rethrown unchanged, so existing callers behave
  exactly as before.
- **The admin user list explains *why* an account is inactive** (#1194). One amber "Inactive"
  badge covered five unrelated situations; each state now has its own label, colour and a
  one-line "what to do about it", plus a **Resend verification** button on `unverified` rows.
- **The message composer warns when the other side cannot read it** (#1194). A 1:1 thread now
  resolves the counterpart's `accountState` (`GET /api/messages` → `counterpartState`) and
  shows a banner when they cannot sign in, have no login at all, or sit on a generated
  stand-in address that discards every email.

### Fixed
- Silence from an unreachable account no longer reads as being ignored: the three states
  behind it (never verified, no login, placeholder address) are now surfaced everywhere they
  matter — the user list, the composer and the delivery log.
## [0.61.1-beta] - 2026-08-09

### Fixed
- **The public chrome no longer tells a signed-in user they are signed out** (#1211). A
  regression from #1197: `/release-notes`, `/privacy`, `/terms`, `/code-of-conduct`,
  `/features`, `/projects` and `/for-companies` gained the shared header, but it rendered
  "Sign In / Register" unconditionally. Following the sidebar's version link mid-session
  replaced the app nav with a logged-out one and offered no way back into the app.
  - `PublicShell` resolves the session on the server (behind the existing `hasSessionCookie()`
    gate) and passes a `dashboardHref` to `PublicHeader`, which then shows a link to the
    user's own dashboard instead of the sign-in pair. Resolved server-side on purpose: a
    client `useSession()` would paint the signed-out chrome first and swap it a beat later,
    which looks like the very bug being fixed.
  - `/` was never affected — it already redirects a signed-in visitor to their role home.

## [0.61.0-beta] - 2026-08-09

### Added
- **One header and one footer for every public page** (#1197). The nine pages a visitor can
  reach from the landing — `/`, `/features`, `/for-companies`, `/apply-as-mentor`,
  `/projects`, `/release-notes`, `/privacy`, `/terms`, `/code-of-conduct` — now render the
  same chrome instead of four different ones (or, on the legal pages, none).
  - `src/components/landing/PublicShell.tsx` frames them all: `PublicHeader` (client — it
    owns the mobile menu), `<main id="main-content">`, `PublicFooter` (server, so
    `package.json` stays out of the browser bundle via `APP_VERSION`).
  - The wordmark is a link to `/` on every page **including `/`**, where it was an inert
    `<div>`. `data-testid="public-home-link"`.
  - The footer is new on eight of the nine pages. It carries Product / Community / Legal
    columns; the legal labels are read from `t.privacy.title` / `t.terms.title` /
    `t.codeOfConduct.title` so a link can never disagree with the heading it points at.
  - New `publicNav` i18n namespace (EN/TR/DE) for the chrome strings. It is deliberately
    *not* part of `landing`, which is in `SERVER_ONLY_NAMESPACES` and so is never shipped
    to the browser — the header is a client component and needs its labels there.
  - `/for-companies` passes `showRegister={false}`: companies have no self-service sign-up
    (#1102/#1104), so the chrome must not offer them the mentee registration button.

### Fixed
- **The skip-to-content link now lands somewhere on public pages** (#1197). The root layout
  has always rendered `href="#main-content"`, but only `ResponsiveShell` (the signed-in
  chrome) defined that anchor — so for a keyboard or screen-reader user the first control on
  every public page was a link to nothing. `PublicShell` supplies it.
- **The phone nav reaches the whole site** (#1197). The landing header hid "Features" and
  "For companies" behind `sm:`/`md:` with nothing behind them, so on a phone those pages
  were unreachable from the header. They now collapse into a disclosure menu
  (`public-nav-toggle` / `public-nav-mobile`) that also carries GitHub, sign-in, register,
  the language switcher and the theme toggle. Moving the theme toggle in there is what stops
  the wordmark truncating to "InternshipC…" at 375px.
- Footer column headings were `text-gray-400 dark:text-gray-500`, which fails contrast on the
  dark surface at that size; swapped to `text-gray-500 dark:text-gray-400`.

### Changed
- `src/app/apply-as-mentor/page.tsx` is now a server component; its form moved to
  `src/components/forms/ApplyMentorForm.tsx` so the page can wear the shared chrome.
- `src/lib/sessionCookie.ts` (new) gates `getServerSession()` on a session cookie actually
  being present, in the root layout, `getLocale()`, the landing page and `/projects`. This
  removes work that is provably useless for a signed-out visitor. **It is not a measurable
  speed win** — an A/B over two rounds on a dev server was inside the noise, and production
  TTFB for these pages is already 11–27 ms. The real navigation improvement comes from the
  shared chrome: public pages now link to each other through `next/link`, so moving between
  them is a ~20–50 ms RSC fetch rather than a full document load.
- `/projects` no longer renders `BrandWordmark` (which resolves a session and the org
  branding) in its header; the public header is static.

## [0.60.0-beta] - 2026-08-08

### Added
- **Live chat on the landing page** (#1174). A visitor who is not signed in can now ask a
  question from `/` instead of composing an email — the tawk.to widget, mounted on the
  landing page and nowhere else.
  - `src/components/TawkChat.tsx` injects the embed **only** when
    `hasConsent('marketing')` is true. This is the first script to use the gate the consent
    banner was built for (EPIC K, #424) — before opt-in, nothing is requested from tawk.to
    at all. The widget id is public by design (it ships in the page HTML), so it is a
    constant in the component rather than an env var.
  - The embed attaches itself to `document`, not to the React tree, so it survives a
    client-side navigation off `/`. The component hides it on unmount, and sets
    `Tawk_API.onLoad` to hide it on arrival for the case where the visitor already left
    while the script was still loading.
  - `CookieConsent` now dispatches a `cookieconsentchange` event on `window` after saving
    (`COOKIE_CONSENT_EVENT` in `src/lib/cookieConsent.ts`), so accepting brings the chat up
    on the spot instead of on the next page load.
- Cookie-banner copy for the "Marketing" category names the live chat and tawk.to in EN/TR/DE.

### Changed
- `COOKIE_CONSENT_VERSION` 2 → 3. "Marketing" now actually loads a third-party script that
  sees the visitor's IP; a choice made while the category was purely hypothetical does not
  cover that, so the banner asks once more.
- CSP (`next.config.js`) allows `https://*.tawk.to` for `script-src`, `style-src`, `img-src`,
  `font-src`, `frame-src`, plus `wss://*.tawk.to` in `connect-src` and a new `media-src`
  (notification sound — it previously fell back to `default-src 'self'`). The widget also
  pulls its emoji picker from jsdelivr, allowed as `https://cdn.jsdelivr.net/emojione/` —
  a path-scoped source, because allowing all of cdn.jsdelivr.net would mean allowing
  anything ever published to npm. Headers are per-request, so this is app-wide even though
  the widget is landing-page-only; the consent gate, not the CSP, is what keeps it from
  loading elsewhere.
- `e2e/global-setup.ts` reads `COOKIE_CONSENT_KEY`/`COOKIE_CONSENT_VERSION` from the app
  instead of hard-coding them, so a future version bump can't silently put the banner back
  in front of every test in the suite.

### Notes
- The privacy notice does not name tawk.to as a recipient yet (#1177) — that means bumping
  `PRIVACY_POLICY_VERSION`, which is the maintainer's call.

## [0.59.0-beta] - 2026-08-08

### Added
- **A person card behind a name** (#1166). Names were plain text nearly everywhere: you could
  read who someone was but not reach them, and on a screen where the name sits *inside a form*
  (the bulk email composer) following a link would have thrown away half-typed work.
  - `<PersonHoverCard />` opens on hover, focus or tap and shows role, pipeline stage, mentor
    and company, university, and the language they read (#1164) — plus "open profile",
    "message" and (when the viewer may write to them) "email".
  - Wired into the bulk email recipient list, the 1:1 message thread header, and the messages
    inbox rows. Where clicking the *name* already does something else — ticking a recipient
    checkbox, opening a thread — the card hangs off its own small icon so the existing gesture
    is untouched.
  - `src/lib/personHref.ts` centralises "where does *this* viewer read *that* person": there is
    no single profile route (an admin reads a mentee at `/admin/candidates/<id>`, their mentor
    at `/mentor/mentees/<id>`), which is why most call sites never linked a name at all. It
    returns null when the viewer has no page for that person, and the name renders unlinked
    rather than pointing at a 404.
  - `GET /api/people/[id]/card` serves the summary. Authorization is the whole story for a
    lookup-by-id endpoint, so the rule is narrow and stated once in `src/lib/personCard.ts`:
    **you may look up anyone whose name the app already shows you** — a mentorship counterpart,
    a project co-member, a conversation participant, yourself; everyone, for an admin. Any other
    role is denied rather than inheriting a view. "Not allowed" and "no such person" both answer
    404 so the endpoint cannot be used as an account-existence oracle, and `email` is omitted
    from the payload for viewers who are not allowed to write to that person.
  - Data is cached per person id for the page's lifetime (including misses), so sweeping the
    pointer down a list of names costs at most one request each and re-hovering costs none.

## [0.58.0-beta] - 2026-08-08

### Added
- **Multilingual bulk email to mentees** (#1165). The ready-made templates already existed in
  EN/TR/DE (`emailTemplates` in the dictionaries), but the composer only ever read the
  **sender's** locale — so a group of mentees who do not all read the same language received
  whichever one the sender's UI happened to be in, and the alternative was hand-translating
  before every send.
  - `src/lib/localizedEmail.ts` resolves a subject+body **pair** per recipient: their language,
    then the default locale, then the canonical version. Same shape as
    `src/lib/announcementText.ts` and `src/lib/goalTemplates.ts`; the difference is that subject
    and body travel together — a Turkish body under an English subject is worse than either
    alone — so a language with only one half filled in is dropped rather than sent.
  - `POST /api/mentor/email` accepts `translations` ({ locale → { subject, body } }) alongside
    the original `subject`/`body`, which stays valid for callers that never learned about it.
    `{name}` is filled in *after* resolving, so placeholders keep working in every language.
  - The composer gets EN/TR/DE tabs with a written/not-written dot, and choosing a template
    fills **all three languages at once**. A coverage line names the languages written and warns
    when some ticked recipients will fall back.

## [0.57.0-beta] - 2026-08-08

### Added
- **Multilingual announcements** (#1163). An announcement was a single body sent to everyone,
  even though every `User` has a `preferredLanguage` and the app speaks EN/TR/DE — the email
  translated only its *shell* (subject, link label) while the message itself went out in one
  language.
  - `Announcement.translations` (nullable `Json`, `{ en?, tr?, de? }`). `text` stays the
    canonical wording — the default locale's version, or the first language filled in — so every
    row written before this column existed keeps working untouched.
  - `src/lib/announcementText.ts` resolves per reader: their language, then the default locale,
    then `text`. Deliberately the same shape as `src/lib/goalTemplates.ts`, which solved this
    first for goal templates — one canonical column plus a nullable JSON map — so there is one
    mental model, not two.
  - The admin composer takes language tabs with a written/not-written dot per language (one box
    at a time: long-form bodies do not fit side by side the way goal-template titles do). At
    least one language is required; the rest may stay empty.
  - Resolution reaches every surface: `GET /api/announcements` returns `text` already in the
    reader's language (the per-locale bodies never travel to a browser that cannot use them),
    each `Notification` row is written in **its own** recipient's language at fan-out, and the
    announcement email's **body** now follows the recipient too, not just the subject around it.
  - `languageFallback` marks a reader who is seeing a language they did not choose, and the
    archive says so rather than presenting a foreign-language message as if it were meant for
    them. The dashboard card stays clean — it is a two-line digest and the full text is one
    click away.

### Changed
- `PATCH /api/admin/announcements/[id]` accepts `translations` too, and re-resolves the already
  delivered notifications **per language** — one statement per distinct resolved body rather
  than a single blanket overwrite, which would have flattened every recipient back to the
  canonical wording and undone the translation for two thirds of them.

## [0.56.1-beta] - 2026-08-08

### Added
- **Announcements can be edited and deleted** (#1162). `POST` was the resource's only verb, so
  a typo in a broadcast was permanent and a superseded announcement stayed on everyone's screen
  forever.
  - New `PATCH` / `DELETE /api/admin/announcements/[id]` (ADMIN only, both `logActivity`-audited
    as `announcement.update` / `announcement.delete`). `PATCH` takes text, link and the image
    (JSON to edit copy, multipart to swap the file, `imageAction: 'remove'` to detach it) and
    validates the image *before* writing anything, so a rejected file cannot leave the text
    half-updated. The `AnnouncementImage` write is an `upsert` — a plain `create` would violate
    the unique `announcementId` when replacing an existing image.
  - Edit/delete controls on each row of the admin history panel; deleting goes through a
    `ConfirmDialog`.
  - **An edit does not re-broadcast** — no second notification, no second email. It corrects a
    record people were already handed.

### Changed
- `Notification.announcementId` (nullable, indexed) links a bell row back to the broadcast that
  created it. The `Announcement` row is now written *before* the fan-out so its id can be
  stamped on every notification (`emailedCount` is filled in afterwards, being the one value not
  knowable up front). This link is what lets an edit rewrite the copy already sitting in
  everyone's bell, and a delete take those rows with it instead of leaving them pointing at an
  announcement that no longer exists.

## [0.56.0-beta] - 2026-08-08

### Added
- **A person's language is visible where you write to them** (#1164). Every `User` carries a
  `preferredLanguage` and the app speaks EN/TR/DE, but that preference was shown nowhere
  outside the person's own settings — so mentors and admins were composing to people in a
  language those people had not chosen.
  - New `<LanguageBadge />` (`src/components/LanguageBadge.tsx`): a two-letter chip with the
    language name in the `title`. It distinguishes *chosen* from *unset* — an unset preference
    renders the app default in a muted style (`data-language-set="false"`), because "chose
    English" and "never chose" are a fact and a guess respectively.
  - Shown on the candidate list (both the desktop and the `md:hidden` mobile card), the 1:1
    message thread header, and the bulk email composer's recipient list.
  - The bulk composer additionally summarises the **selected** recipients' languages
    (`data-testid="recipient-languages"`, e.g. `DE ×2 · TR ×1`) — one body goes to everyone
    ticked, so the sender sees the spread before they start typing. `languageBreakdown()` folds
    unset preferences into the app default, which is what those people actually receive.
  - `preferredLanguage` now rides along in `/api/candidates`, `/api/mentorship`, and the
    message thread's participant payload (`getThreadIfAllowed` / `getConversationIfAllowed`).
    Group chats get no header badge — a room has no single language to name.

## [0.55.7-beta] - 2026-08-08

### Changed
- **Announcements start the day you join** (#1161). The dashboard card and the
  `/announcements` archive both read `GET /api/announcements`, which returned the whole
  `Announcement` table to every signed-in user — so a brand-new account's first screen was
  filled with other people's history ("the meeting has started", "re-point your git remote
  today"), messages written for whoever was in the room at the time and, read weeks later,
  misleading.
  - The feed is now cut at the reader's own `User.createdAt` (`where: { createdAt: { gte } }`,
    applied to the `count` as well, so pagination cannot walk back past it).
  - The per-user notification bell already behaved this way for free — `Notification` rows are
    created during the broadcast fan-out, so an account created later simply has none. This
    brings the two remaining surfaces in line with it.
  - The complete record is untouched at `/admin/announcements`, which is the sending log.
  - The cutoff is read from the database, never from the session: a JWT minted before this
    shipped carries no such claim, and a client-supplied date would be a trivial way to read
    the archive back. A session pointing at a deleted user row gets an empty feed.

## [0.55.6-beta] - 2026-08-08

### Fixed
- **A way back out of the project showcase** (#1159). `/projects` renders outside the
  admin/mentor/portal shell — no sidebar — and its header held a single link: the hard-coded
  "InternshipCRM" wordmark pointing at `/`. A signed-in visitor who followed "Browse the
  project showcase" from `/portal/projects` had no visible route back into the app (the
  wordmark did land them on their dashboard via the `/` → `roleHome` redirect, but nothing
  said so); on a phone, with no sidebar either, the page was a dead end.
  - Added an `ArrowLeft` back link above the page title (`data-testid="showcase-back"`),
    targeted at who is looking: `roleHome(session.user.role)` for a signed-in visitor,
    `/` for an anonymous one. Same shape the project detail page already uses.
  - The header wordmark now points at the same destination and renders `<BrandWordmark />`
    instead of hard-coded product chrome, so the showcase honours tenant branding (#546)
    like every other page.
  - New dictionary keys `projects.backDashboard` / `projects.backHome` (EN/TR/DE), and an
    e2e case in `e2e/projects-showcase.spec.ts` covering both viewers.

## [0.55.5-beta] - 2026-08-08

### Fixed
- **One 1:1 thread per pair** (#1156). The same person could show up twice in `/messages`,
  each row holding half the history. A 1:1 chat had two homes: the mentorship thread
  (`Message.relationId`, `/messages/<relationId>`, linked from the mentee card, the portal,
  notifications and digest emails) and the conversation layer (`Message.conversationId`,
  `/messages/c/<id>`, reached from user-card quick actions and the inbox's "new chat" picker).
  The inbox listed both, so anyone reachable both ways — a mentee who is also a project
  co-member — got two rows. `Conversation.directKey` only ever deduped *within* the second
  layer; nothing tied the two together. Several `MentorshipRelation` rows for one pair had the
  same effect, one thread each.
  - The DIRECT conversation is now the single home for a 1:1 chat.
    `conversationForRelation()` (`src/lib/conversations.ts`) create-or-gets the pair's
    conversation and adopts the relation's messages into it with a single indexed
    `UPDATE … WHERE relationId = ? AND conversationId IS NULL` — idempotent, so it runs
    lazily on the paths that touch a thread rather than as a deploy-time migration.
  - `/messages/<relationId>` is now a server component that redirects to `/messages/c/<id>`,
    so every existing link, notification and digest email lands on the one thread. It keeps
    the same participants-or-admin authorization and falls through to the old view (which
    renders "not found") when the relation isn't the viewer's.
  - The inbox resolves the viewer's mentorships first, then lists conversations only.
    `/portal/messages` — a mentorship-only list that missed project DMs and group chats —
    redirects to the shared inbox, and the portal nav points there.
  - Messages carry **both** links whenever both exist: the conversation is where the thread
    lives, `relationId` keeps them inside the mentorship-scoped features. So reply-by-email
    (relation-scoped `replyAddress` tokens) now works in the conversation the mentorship
    thread redirects to, and the unread digest, the inbound-mail bridge, the mentor bulk
    email and the onboarding checklist are unaffected.
  - `e2e/one-thread-per-person.spec.ts` seeds the split state (a mentorship message + a
    separate DIRECT conversation for the same pair) and asserts it collapses into one inbox
    row holding both histories; the two specs asserting the old thread URL now expect the
    conversation URL.

## [0.55.4-beta] - 2026-08-08

### Added
- **"Select all" in the project goal-template pool.** Handing the whole shortlist to a new
  member meant ticking 20 boxes one by one. The pool now has a select-all checkbox directly
  above the list (`select-all-templates`), with a `{n} selected` counter next to it.
  - The control already existed as a text link below the list, but it was rendered under
    `picked.length > 0` — so it only appeared *after* something had been ticked by hand,
    which is exactly when it is least useful. It is now always visible while the pool has
    entries, sits next to the boxes it ticks, and doubles as **Clear** once everything is
    selected (indeterminate on a partial selection).
  - `src/components/project/ProjectGoals.tsx`; new `projects.clearSelection` / `projects.selected`
    strings in EN/TR/DE.
  - Covered by a new e2e case in `e2e/goal-templates.spec.ts` (tick all → send → every
    template lands on the member).

## [0.55.3-beta] - 2026-08-08

### Fixed
- **Sign-in is no longer hostage to a profile column** (#1150). Production login failed with
  `Unexpected end of JSON input` — a 401 from `/api/auth/callback/credentials` whose body was
  the normal `?error=<message>` redirect, so the string on the login form came from the
  *server*. Root cause: `authorize()` read the account with an unqualified
  `prisma.user.findUnique({ where: { email } })`, which hydrates all ~60 `User` columns
  including its four `Json` ones. Prisma `JSON.parse()`s a `Json` column on read, so one row
  holding an invalid value (`''` instead of `'[]'`) made the read throw **before the password
  was ever compared** — the account was unreachable by any password, and the raw parser
  message was shown to the user. Reproduced on a real MariaDB row: an unqualified
  `findUnique` throws while the narrowed read of the same row succeeds and login completes.
  - `src/lib/auth.ts` now selects only the columns sign-in uses (`AUTH_USER_SELECT`), across
    all three providers (`credentials`, `impersonate`, `sso`) and both `jwt`-callback lookups.
    The `user.update()` calls got `select: { id: true }` too — an unqualified `update()`
    returns the whole row and would re-open the same hole.
  - **Where the invalid value came from — `prisma db push` itself.** Prisma *drops*
    `@default` when it emits DDL for a `Json` field: `languages Json @default("[]")` becomes a
    bare `ALTER TABLE \`User\` ADD COLUMN \`languages\` JSON NOT NULL` (verified with
    `prisma migrate diff`; a `String @db.Text @default` keeps its DEFAULT). On MariaDB — which
    production is, and where `JSON` is only an alias for `LONGTEXT utf8mb4_bin` — that ALTER
    backfills **every pre-existing row with the empty string**, silently, even under
    `STRICT_TRANS_TABLES` (reproduced locally: `length=0`, `JSON_VALID=0`, no warning). So
    every account older than the deploy that added the column was locked out at once, not just
    the one that reported it. `User.languages` was added by #1078 and reached production on the
    2026-08-07 deploy — the day before. The schema comment on `notificationPrefs` already
    warned about exactly this ("nullable … avoids MariaDB `json_valid` CHECK issues"); a
    nullable `Json` column is unaffected.
  - Why CI stayed green: the test databases are **MySQL 8**, whose native `JSON` type rejects
    the value at write time (ERROR 3140), so the failure is not merely untested there — it is
    unrepresentable. The `@smoke` suite passed on every one of these commits.
  - `infra/deploy-prod.sh` now runs the repair immediately after `db push`, where the damage is
    created, so the next new `Json` column cannot lock anyone out. It only rewrites values that
    are *already* unreadable, so it is inert on a healthy database.
- **The way back in no longer shares sign-in's failure mode** (#1150). `forgot` and
  `verify-email/resend` read the whole row too, and `forgot` answers a generic `ok: true`
  whether or not the mail was sent — so on a corrupt row the reset link silently never arrived
  and looked like an SMTP fault. Both now select only the fields the mail needs, and both are
  covered by `check:auth-reads` (which caught a third unqualified read while being written).

### Security
- Sign-in no longer echoes internal exception messages to the browser (#1150). NextAuth hands
  a thrown `authorize()` error's `.message` to the client as `?error=<message>`; every
  provider is now wrapped once (`guardProviders`), so the errors the sign-in page is designed
  around still pass through unchanged while anything unexpected becomes
  `UNEXPECTED_ERROR` — rendered as a localized "something went wrong" (`auth.signInFailed`,
  EN/TR/DE) with the real cause logged server-side.

### Added
- `npm run check:auth-reads` (`scripts/check-auth-reads.mjs`), wired into `ci.yml`: fails the
  build if any `prisma.user` query in `src/lib/auth.ts` lacks a `select`, or if one selects a
  `Json` column. Needs no database, so it guards the invariant on every PR.
- `npm run db:check-json` (`prisma/backfill-json-columns.mjs`, shipped inside the runtime image so the deploy can run it): reports — and with `--repair`
  fixes — rows whose `Json` value is not valid JSON, across all 11 `Json` columns in the
  schema. Read-only by default, exits non-zero on unrepaired damage, and prints ids and value
  lengths only (never the value, which may be personal data).
- `e2e/auth-corrupt-json-column.spec.ts`: a user whose `skills` column holds invalid JSON can
  still sign in. Skips itself on engines that reject the bad value at write time.

## [0.55.2-beta] - 2026-08-08

### Fixed
- **Switching an account off no longer promises a review that never comes** (#1148) — since
  #1085, `PATCH /api/users/[id]` set `pendingApproval = true` on every deactivation, so
  `src/lib/auth.ts` answered the next sign-in with `ACCOUNT_PENDING_APPROVAL` and the page
  showed *"Your account is waiting for a quick review. We will email you the moment it is
  opened."* — to someone an admin had just switched off. That is the exact opposite of what
  #1085 introduced the flag for ("tell 'waiting for a review' apart from 'an admin switched
  you off', since both are `isActive=false`"): the same PR then set it on both paths and
  collapsed the distinction. Deactivating now parks only an **unverified** account, which is
  the sole case the flag was actually load-bearing for — a never-activated sign-up still
  holding a verification link. A verified account is already barred from re-admitting itself
  by `verify-email`'s own `!emailVerified` term, so it keeps the honest "this account has
  been deactivated" message. Activating still clears the flag unconditionally.

### Tests
- **The four specs that still waited for a native `confirm()`** (#1148) — #1071 moved 16
  components onto `ConfirmDialog` without touching a single spec, so
  `page.on('dialog', d => d.accept())` sat waiting for an event that no longer fires. The
  click opened ordinary DOM, was swallowed, and the failure surfaced one assertion later as
  "the row I deleted is still there": `delete-confirm`, `goal-templates`,
  `goals-archive-sort` and `todos` all went red in the scheduled full run
  ([31220653046](https://github.com/21072026/Internship/actions/runs/31220653046)). New
  `e2e/helpers/confirm.ts` (`acceptConfirmDialog` / `cancelConfirmDialog`) is the one place
  the dialog's test ids live; `delete-confirm` keeps its #470 intent, now reading the
  question out of the DOM — the click asks and sends no `DELETE`, cancelling keeps the note.
  `impersonation-governance`, `search` and `xss-injection` also listen for dialogs and are
  deliberately left alone: those are a `prompt()`, an `alert()` and XSS detection.
- **`email-verification` seeded a mentor into the first-run wizard** (#1148) — it creates the
  user by hand because it needs `emailVerified: false`, which also skipped `seedUser`'s
  `mentorOnboardingSeenAt` concession, so the first `/mentor` visit was redirected to
  `/onboarding` (#911) and the sign-in's landing wait timed out. Now stamped explicitly, with
  the reason next to it.
- `admin-user-active` additionally asserts `pendingApproval === false` after a deactivation,
  so the message distinction above cannot disappear silently again.

## [0.55.1-beta] - 2026-08-07

### Security
- **`nodemailer` 7.0.13 → 9.0.5** (#1143) — closes the open **high** finding
  ([GHSA-p6gq-j5cr-w38f](https://github.com/advisories/GHSA-p6gq-j5cr-w38f): the
  message-level `raw` option bypasses `disableFileAccess`/`disableUrlAccess`, giving
  arbitrary file read and full-response SSRF, range `<=9.0.0`) plus three moderates that
  cover `<=8.0.8`. On a clean `npm ci`, `npm audit` goes from 6 findings (3 high, 3
  moderate) to 4 (2 high, 2 moderate): `next-auth`'s moderate was transitive through
  nodemailer and cleared with it, and both rows moved out of
  `docs/security-exceptions.md`. What remains is untouched by this change — `xlsx` and
  `node-cron`/`uuid` are written up there, and `nanoid` (high, via `postcss`) is a
  pre-existing finding that is in neither — filed as #1144.
- **Bumping the root range alone does not install.** `next-auth@4.24.15` declares
  `peerOptional nodemailer@"^7.0.7"`, so `npm ci` fails with ERESOLVE — which is exactly
  where Dependabot's #1129 (7.0.13 → 9.0.1) died, in under 30s, before any of the three
  jobs ran a line of project code. The fix is one `overrides` entry pinning next-auth's
  peer to the root's: `"next-auth": { "nodemailer": "$nodemailer" }`. Safe because
  `src/lib/auth.ts` only registers `CredentialsProvider` — there is no `EmailProvider`, so
  next-auth never loads nodemailer at runtime and the peer is unused as well as optional.
- **The 7 → 9 breaking change does not reach this app.** 9.0.0 made HTTPS requests
  validate the server's TLS certificate *when fetching remote content* — attachment
  `path`/`href` URLs, OAuth2 token endpoints, proxy CONNECT. Our transport is plain SMTP
  host/port/password (`src/services/emailService.ts:41`) and every attachment is an
  in-memory `Buffer` (`emailService.ts:93`, and the message/announcement senders that feed
  it); nothing fetches remote content. Verified beyond the type level: `tsc --noEmit` is
  clean against `@types/nodemailer` 6.4.23, and a message built with our exact shape
  (multipart, `cid` attachment, UTF-8 subject) renders correctly on 9.0.5.
- Taken deliberately rather than as an automated PR, which is what `.github/dependabot.yml`
  intends by ignoring `semver-major` — #1129 is a security update, so Dependabot opened it
  past that rule anyway. Closed in favour of this one.

## [0.55.0-beta] - 2026-08-07

### Added
- **A mentor can also be a mentee** (#1141) — someone who helps another person can need help
  themselves, and the app now says so. `User.role` is unchanged (still one enum, still what
  every authorization decision keys off); the second side is **derived** from the relation
  table by `src/lib/dualRole.ts`: `mentorshipSides()` counts the relations where the user is
  the mentor and where they are the mentee, and `availableModes()` / `canUsePortal()` /
  `canUseMentorShell()` turn that into shell access. Derived rather than stored on purpose —
  `MentorshipRelation` (plain `mentorId`/`menteeId` user FKs, no role constraint) already
  permitted this, so the relation table *is* the truth and a second stored flag could only
  disagree with it.
- `ModeSwitcher` now takes a `modes: AppMode[]` prop (server-decided) and renders a
  variable-width group instead of a hardcoded admin/mentor pair; it returns `null` below two
  modes, so a plain mentor still sees no switcher. `AppMode` gains `'mentee'` (→ `/portal`),
  `MODE_ROOT` maps each mode to its shell root, and `modeOf()` recognises `/portal`.
  New `modeSwitch.mentee` / `modeSwitch.menteeHint` strings (EN/TR/DE).
- `e2e/dual-role.spec.ts` — dual-role mentor reaches the portal and returns (`@smoke`), a
  mentor with no mentorship of their own is still bounced out of `/portal`, a mentee given
  someone to mentor reaches `/mentor`, and a plain mentee is still kept out of it.

### Changed
- `appMode.counterpartPath()` now keeps the current section only when the *target* shell owns
  that page (`SECTIONS` per mode, `ALIASES` keyed by from→to). The portal has far fewer
  sections than the staff shells, and the old "shared section" list would have linked to
  `/portal` pages that don't exist.
- `authzScope` — the `relation` scope for MENTOR and MENTEE now matches **both** sides
  (`OR: [{ mentorId }, { menteeId }]`). Read-only widening: all three `scopeForRole()` callers
  are GETs, and it only ever adds rows the user is personally named in.
- `POST /api/mentorship` accepts ADMIN/MENTOR/MENTEE on **either** side (COMPANY and SOURCE
  stay barred — they have no personal mentorship) and rejects `mentorId === menteeId`.
  `/admin/mentorship` offers the same people in both pickers, each sorted with that picker's
  usual role first and off-role entries carrying a role suffix; the person picked on one side
  drops out of the other.
- `PortalLayout` no longer bounces ADMIN/MENTOR unconditionally — it admits anyone who is
  actually being mentored — and gained the **2FA setup gate** the staff shells already had, so
  the portal can't become a way around it for a role in scope for the policy. `MentorLayout`
  admits a MENTEE who has someone to mentor; the mentor onboarding wizard redirect stays
  scoped to `role === 'MENTOR'`, so a dual-role mentee is never bounced into it.
## [0.54.0-beta] - 2026-08-07

### Changed
- **The mentor sidebar is a component now** (`src/components/MentorNav.tsx`, salvaged from #1080)
  — twelve hand-written `<Link>` blocks in `src/app/mentor/layout.tsx` became one array, and the
  entry for the page you are on is highlighted and carries `aria-current="page"`. `/mentor` is
  matched exactly rather than by prefix, so the dashboard entry does not light up on every mentor
  route. `/todos` is included: #1080 was branched before it landed and its nav list would have
  silently dropped it, so `e2e/mentor-profile-navigation.spec.ts` now asserts the entry exists.

### Not taken from #1080
- Its `MentorProfileCompletionBanner` (a dashboard nag when bio / interests / `mentorCapacity`
  are empty) is left out: `OnboardingChecklist` already checks those same three fields for
  mentors and already links to `/mentor/profile` (`GET /api/onboarding`), so the banner would
  have stacked a second blue box saying the same thing on a dashboard that #1136 had just made
  more compact.

## [0.53.0-beta] - 2026-08-07

### Added
- **Consent-based public mentor profiles** (`/p/<userId>`, salvaged from #1079) — the public
  profile page already existed for mentees; it now renders a mentor variant when the account is
  a MENTOR and `publicProfile` is on. Mentors show areas of expertise, spoken languages, active
  mentee *count* and capacity (`data-testid="public-profile-active-mentees"` / `-capacity`);
  the mentee-shaped rows (university, department, graduation year, target position) are hidden
  for them. The query is additionally narrowed to `role in (MENTEE, MENTOR)`, so an ADMIN or
  COMPANY account that happens to carry `publicProfile` can no longer be rendered.
- **Link to the mentor's public profile from the mentee portal** (`/portal`) — shown only when
  that mentor has actually opted in (`publicProfile === true`), next to "message mentor".
- `e2e/public-profile.spec.ts` gained a mentor case asserting the mentor fields are visible and
  that phone, WhatsApp, the mentee-only rows **and the linked mentee's name** are not.

## [0.52.0-beta] - 2026-08-07

### Added
- **Mentors can edit their own profile** (`/mentor/profile`, salvaged from #1078) — the mentee
  profile form was extracted into a shared `ProfileForm` component that takes a `role` prop, so
  `/portal/profile` (MENTEE) and the new `/mentor/profile` (MENTOR) are the same form with
  different fields. Mentors get name, bio, city, avatar, LinkedIn/GitHub/portfolio, skills +
  skill levels, areas of expertise, `mentorCapacity`, spoken languages and the `publicProfile`
  toggle; the mentee-only blocks (university, department, graduation year, target position, CV
  manager/feedback/suggestions, documents, templates) do not render for them. New "My profile"
  entry in the mentor sidebar.
- **`User.languages`** (`Json`, default `[]`) — the languages a mentor speaks, distinct from
  `preferredLanguage` (the UI locale). Edited as a comma-separated list, stored as an array.

### Changed
- **`PUT /api/profile` rejects fields the caller may not set** instead of silently ignoring them:
  unknown keys, and role-owned keys sent by the wrong role, now return `403` with
  `{ code: 'protected_fields', fields: [...] }`. `mentorCapacity` and `languages` are
  MENTOR-only; `university`, `department`, `graduationYear`, `targetPosition` and `cvUrl` are
  MENTEE-only; `interests` stays open to both (a mentee's interests, a mentor's expertise).
  `role`, `isActive` and `userId` were never writable here and are now rejected loudly.

## [0.51.2-beta] - 2026-08-07

### Changed
- **Compact onboarding cards on the mentor dashboard** (`MenteeOnboardingWizard`) — the
  per-mentee onboarding cards were full width and stacked, so two newly joined mentees pushed
  the rest of the dashboard below the fold while the right half of the screen stayed empty.
  They now sit in a responsive grid (1 / 2 / 3 columns at `md` / `2xl`), each card carries the
  mentee's name as its heading (the name link, `onboarding-mentee-link-<id>`, moved into that
  header and stays visible when collapsed), and the shared "My Mentees" / "Meetings" links moved
  out of every card into one block header. The `{name}` placeholder is gone from
  `menteeOnboarding.subtitle` in all three locales — the heading carries the name now.
- **Collapsible onboarding cards** — a chevron (`onboarding-toggle-<id>`) folds a card down to
  its summary: name, an `x/y` progress badge (`onboarding-progress-<id>`), a progress bar and
  the next open step (`onboarding-next-<id>`). The choice is remembered per mentee in
  `localStorage` under `mentee-onboarding-collapsed`. With more than two mentees pending, cards
  past the second start collapsed. New i18n keys: `menteeOnboarding.expand` / `.collapse` /
  `.next`.
- E2E: `e2e/mentee-onboarding-collapse.spec.ts` covers the summary, the collapse toggle and its
  persistence across a reload.

## [0.51.1-beta] - 2026-08-07

### Changed
- **Landing copy: the product is no longer written by one person** (`src/i18n/dictionaries.ts`,
  EN/TR/DE) — the honesty note under "What you can check for yourself" (`transBeta`) and the
  mentor FAQ answer to "Will this still be around in a year?" (`faqMentor3A`) both claimed a
  single author ("tek kişi yazıyor" / "written by a single maintainer" / "von einer einzelnen
  Person"); several people write it now, so both say "a small team" instead. The rest of each
  string — beta, no testimonials yet, hand-opened company accounts, one-click export — is
  unchanged, and the objection table in `docs/landing-value-proposition.md` was updated to
  match. No bearing on the IP position: the sole rights holder is still one natural person.

## [0.51.0-beta] - 2026-08-07

### Added
- **"Send a message" on the mentor's mentee pages** (#1130) — `/mentor/mentees/<relationId>` now
  links straight to the mentorship thread (`/messages/<relationId>`,
  `data-testid="mentee-message-link"`), and each card on `/mentor/mentees` carries an icon-only
  entry (`data-testid="message-mentee-<id>"`). The thread already existed; the page you read
  about a mentee on simply had no way into it, so writing meant a detour through the messages
  inbox to find the right person.
- **Suggested openers for an empty thread** (`MessageThreadView`, #1130) — with no messages yet,
  three chips (`data-testid="message-suggestions"`) offer a starting point; clicking one *fills*
  the composer instead of sending, so the wording stays the sender's. The mentor side of a
  mentorship thread gets welcome-flavoured openers (welcome / intro call / ask about goals), any
  other viewer gets neutral ones (hello / introduce myself / ask a question), and the other
  party's first name is interpolated into the text. Group (project) chats are excluded — there is
  no single person to greet — as are read-only threads and threads that already have history.
  New `messages.openers.*` i18n block (EN/TR/DE); `MessageComposer` gained an optional
  `textareaRef` so the box can be focused after a chip is used. Covered by
  `e2e/messaging.spec.ts` ("mentor opens the thread from the mentee page and uses a suggested
  opener").

## [0.50.2-beta] - 2026-08-07

### Added
- **Pending-count badge on the admin nav's "Mentor Applications" entry** (`AdminNav`) — a red
  count bubble (`data-testid="mentor-applications-badge"`, `9+` above nine) fed by
  `GET /api/mentor-applications?status=PENDING`, so the review queue is visible from any admin
  page. The count is refetched on route changes rather than on a timer: every decision
  (review/approve/reject) navigates away from the detail page, so navigation already covers the
  moments the count can change. New i18n key `mentorApplicationsAdmin.pendingBadge` (EN/TR/DE)
  backs its `title`/`aria-label`; e2e coverage in `e2e/mentor-application-review.spec.ts`.
  Salvaged from #1076, which was otherwise superseded by the mentor-application review flow
  already on `main` (#1048, #1072) and closed as a duplicate of #906.

## [0.50.1-beta] - 2026-08-06

### Changed
- **The register form no longer reads as "invitation required".** The invitation-token field was
  the first thing on the form, which contradicted the open sign-up the landing page invites
  everyone into. It is now folded behind an "I have an invitation code" link and unfolds
  automatically for anyone who arrived through an invitation link (`?token=`). Subtitle and hint
  reworded in EN/TR/DE: signing up as a mentee needs no invitation.
## [0.50.0-beta] - 2026-08-06

### Added
- **`/for-companies`** — the first page a company can actually land on. Public, three languages,
  and it reuses the landing's `landing.audCompany*` strings for its six benefit items so a claim
  can never drift between the two pages. Ends in an enquiry form rather than a register button:
  a COMPANY user is only born from an `InvitationToken`, so registration was never the right
  bridge (`src/app/api/register/route.ts` pins token-less sign-up to `MENTEE`).
- **`POST /api/company-inquiry`** with the proven public-form anti-spam trio — honeypot field,
  minimum render-to-submit time, per-IP rate limit (3/hour). No external captcha; the CSP blocks
  third-party scripts. Consent is validated server-side and stored as `consentAt`, not merely
  ticked in the UI.
- **`CompanyInquiry` model** + **`/admin/company-inquiries`** (`GET`/`PATCH`, `AdminNav` entry).
  The enquiry is persisted rather than only emailed so it cannot quietly die in an inbox, and so
  an admin can see what is still unanswered; NEW → CONTACTED → CLOSED records who picked it up.
- `sendCompanyInquiryEmail` — every active admin is emailed with the company's address as
  Reply-To, alongside the in-app notification.

### Changed
- **The landing's mentor and company CTAs now point at real pages** — `/apply-as-mentor` (#1072)
  and `/for-companies` — instead of a `mailto:` that only rendered when `supportEmail` happened
  to be configured. The landing header gains a "For companies" link.
## [0.49.2-beta] - 2026-08-06

Closes #1123.

### Fixed
- **A mentee added by a mentor can now become a real account.** A mentee created without an
  e-mail got a generated `mentee.<name>.<hex>@import.local` address and the sentinel
  `!created-no-login` in the password column — never a bcrypt hash, so `bcrypt.compare` could
  never match and the record could not sign in. Every recovery path was a dead end:
  `/api/auth/forgot` and `/api/admin/users/[id]/reset-password` only *mail* a link, and that
  mail went to a domain that does not exist; no endpoint could change the address
  (`/api/users/[id]` PATCH never accepted `email`, and `/api/account` PATCH requires the
  account's own session plus `currentPassword`); and registering with the real address created
  a second, unrelated user, orphaning the interaction log and stage history. The only way out
  was deleting the record or editing the DB by hand.

### Added
- **`PATCH /api/mentor/mentees/[id]`** — sets the real e-mail on a mentee record and issues a
  `SET_INITIAL` password token, mailing the activation link (and returning it, like
  `POST /api/mentor/mentees` already does, so the mentor can pass it on when SMTP is down).
  Allowed for the assigned mentor or an admin. Guards: target must be a `MENTEE`; the record
  must still carry a no-login sentinel (`!created-no-login` / `!imported-no-login`) — once
  someone has set a password the address is theirs and only they can change it, via
  `/api/account`; `@import.local` / `@erased.local` are rejected as new addresses; erased or
  deactivated records are refused; e-mail uniqueness is enforced (409); rate-limited to 20 per
  15 min; every call writes a `mentee.activation_link_sent` activity row at warning level.
  Sending with the address unchanged doubles as "resend the activation link".
- **`MenteeActivationPanel`** (`src/components/MenteeActivationPanel.tsx`) — shown on the
  mentor's mentee detail page and the admin candidate page whenever the record has no password
  yet, driven by a new `pendingActivation` flag on `GET /api/mentorship/[id]` and
  `GET /api/users/[id]` (derived server-side; the password column is destructured out before
  the response). New `menteeActivation` i18n block (EN/TR/DE).
- **`src/lib/menteeAccount.ts`** — single home for the no-login sentinels and the placeholder /
  erased e-mail domains, previously inline string literals in the create route.
- **`e2e/mentee-activation.spec.ts`** — the full path (create without e-mail → activate → the
  mentee sets a password and signs in, on the same row with its relation intact) plus the
  refusals: already has a password (409), placeholder domain (400), foreign mentor (403).

## [0.49.1-beta] - 2026-08-06

### Added
- **Mentor onboarding wizard** (#911): a MENTOR's very first visit to `/mentor` now redirects once
  to a 4-step wizard at `/onboarding` — Profile (name, bio), Expertise (skills, interests),
  Capacity (mentee capacity) and Availability (weekly slots, via the existing
  `/api/availability`) — reusing the mentee `OnboardingForm`'s progress/step-card shell and
  `PUT /api/profile` for the saved fields. The redirect is stamped server-side on `User`
  (`mentorOnboardingSeenAt`) before it fires, so it never loops and never repeats, whether the
  mentor finishes, skips, or abandons the wizard; both Finish and Skip return to `/mentor`. The
  MENTEE onboarding flow and the dashboard "Get started" checklist (`/api/onboarding`) are
  untouched. EN/TR/DE translations.

### Changed
- **Added a reusable `ConfirmDialog` component** (`src/components/ui/ConfirmDialog.tsx`) and
  replaced all native `window.confirm(...)` calls under `src/` with it — across
  `RelationNotesPanel`, `GoalsPanel`, `NotesPanel`, `DocumentsManager`, `EvaluationPanel`,
  `MessageThreadView`, `ProjectGoals` (including the goal-template pool's delete), the admin
  goal-templates page, `MyTodos` and `PersonTodos` (added since), `ProjectWeeklyMeeting`, the
  admin cohorts page, the mentor availability page, the mentee detail page, and
  `ProjectsManager`. Each delete (or stop, for the weekly-meeting series) now opens an
  accessible modal (`role="dialog"`/`aria-modal`, Escape/overlay-to-cancel, focus starts on
  Cancel) instead of the browser's blocking `confirm()` prompt, with a `loading` state that
  disables the buttons during the request to prevent double-submits. Existing i18n confirm
  messages, API calls and delete behavior are unchanged.

## [0.49.0-beta] - 2026-08-06

Closes #1116.

### Fixed
- **A mentee can see the project they are on.** Not an authorization bug — `scopeForRole`
  already returned the mentee's own projects and `/projects/[id]` already gave a member the
  internal view. The portal simply never linked there: `PortalNav` had no entry, the
  dashboard's relation query selected `mentor`/`company`/`interactions` but not the project,
  and the only list page (`/projects`) is the `isPublic: true` showcase, which by definition
  excludes a private project. The project was reachable only by typing its URL.

### Added
- **`/portal/projects`** — the mentee's own project list (name, owner, status, technologies,
  intern count, repo/demo/board links), with an empty state pointing at the public showcase,
  where a mentee can still ask to join a project.
- **Project card on the portal dashboard**, above the announcements, linking to the full list.
- `lib/menteeProjects.ts` — one helper for "which projects is this person on?", unioning both
  membership sources the way `mergeTeam` does (a `ProjectMember` row *and* a legacy
  `MentorshipRelation.projectId`); reading only one of them is what made pre-#617 assignments
  invisible. It deliberately does **not** include the showcase scope: it answers "mine", not
  "browsable".

### Changed
- The project detail page's back link sends a mentee member to `/portal/projects` instead of
  `/projects` — the showcase that does not contain their own project.

## [0.48.0-beta] - 2026-08-06

Closes #1113.

### Fixed
- **The project goal pool stopped duplicating the goals handed out from it.** Two implicit
  captures fed it: `POST /api/projects/[id]/tasks` upserted every hand-written task into
  `ProjectTaskTemplate`, and `GET /api/projects/[id]/task-templates` backfilled the pool from
  the project's existing tasks on every read. A goal sent from the *shared* pool was resolved
  into the assignee's language before it was stored, so the backfill adopted that translation
  as a new project-local template — the same goal reappeared in the pool once per language it
  had ever been sent in, and grew every round. Both captures are gone: the pool is this
  project's deliberately-added templates plus the shared ones, nothing else. The panel now has
  its own "add to the pool" input (`new-project-template`).

### Added
- **`/todos` — one to-do list per person** (`MyTodos`, `TodoRow`), in every role's sidebar
  (`nav.todos`). It holds what a mentor handed them, what their projects need, the open project
  goals they may claim, and to-dos they write for themselves; finished ones are archived rather
  than deleted (`ProjectTask.archivedAt`, `PATCH { archived }`). This replaces the split where
  personal goals sat on `/portal/profile` and project goals on the project page — the goals card
  is gone from the profile.
- **Shared to-dos are now references, not copies** (`ProjectTask.templateId`). A to-do sent from
  the pool reads its wording from the template on every render, resolved in the *reader's*
  language (`resolveTaskTitle`, `taskTemplateSelect`): reword the pool entry and it changes for
  everyone who has it, in each of their languages, and switching your app language re-reads it.
  A shared to-do cannot be reworded (`409`) or deleted (`403`) by the person who received it —
  they tick it off and archive it.
- **Retiring a template no longer takes it away from anyone.** `DELETE` on both
  `/api/admin/goal-templates` and `/api/projects/[id]/task-templates` sets
  `ProjectTaskTemplate.archivedAt` instead of deleting the row: the entry stops being offered,
  while the to-dos already handed out keep their wording and still follow later edits. Adding
  the same wording back revives the archived row rather than creating a second one.
- **A mentor can hand someone a to-do without a project** — `POST /api/todos` (free text or
  shared-pool `templateIds`), surfaced by `PersonTodos` on the mentee and candidate pages, which
  replaces `PersonProjectGoals`. `GET /api/todos?userId=` reads a mentee's list, minus the lines
  they wrote for themselves.
- `GET /api/todos/templates` — the shared pool for mentors/admins outside any project.

### Changed
- `ProjectTask.projectId` is nullable (a personal to-do belongs to no project) and the model
  carries `createdById`, so "your mentor asked for this" and "you wrote this" are distinguishable.
- `goalLinkFor()` points every goal notification at `/todos` instead of `/portal/profile` or the
  project page.
- `GET /api/projects/[id]` leaves archived tasks out of the project list and ships each task's
  template alongside it. `/api/project-goals` is removed — `/api/todos` supersedes it.
- E2E: new `e2e/todos.spec.ts` (pool reference, retire-without-loss, no re-capture, own to-dos +
  privacy); the `@smoke` project-goals test now ticks the goal off on `/todos`.

## [0.47.0-beta] - 2026-08-06

### Added
- **Mentor self-application review lifecycle** (#933), completing #904/#905 end to end:
  `Mentör Ol` / `Become a Mentor` / `Mentor werden` link on the landing page and sign-in
  page, both leading to `/apply-as-mentor`. New admin section **Mentor Applications**
  (`/admin/mentor-applications` + `/admin/mentor-applications/[id]`, nav entry added):
  a status-filterable queue (Pending / Under review / Approved / Rejected) and a detail
  screen showing contact info, skills, experience, motivation, capacity, consent, and an
  admin-only review note. Admin actions — **Take under review**, **Approve**, **Reject**
  (rejection reason required) — hit a new `PATCH /api/mentor-applications/[id]`
  (`GET` added too) that guards every transition with a conditional `updateMany` so a
  double click or retry 409s (`already_decided`) instead of repeating side effects.
  Approving is one DB transaction: an email tied to no existing account gets an
  `InvitationToken` (same `/auth/register?token=` flow as an admin invite) and the
  application is only left `APPROVED` if that succeeds; an email tied to an existing
  `MENTEE` account promotes it to `MENTOR` in place (filling in capacity/skills only if
  unset) instead of creating a duplicate; an existing `ADMIN`/`COMPANY`/`SOURCE` account is
  never silently repurposed — the transaction rolls back with `role_conflict` for manual
  resolution. Applicants get transactional, localized (EN/TR/DE) emails at every stage —
  received, under review, approved, rejected — via four new `emailService.ts` functions;
  rejection email is a generic decline, never the admin's internal reason. Both the public
  POST and the admin PATCH send email fire-and-forget (not awaited) so a slow/unreachable
  SMTP server can never hold up the response. The public form also gained the same
  honeypot + minimum-render-time anti-spam guard already used by the public contact form,
  and now sends the applicant a "received" confirmation email. Schema: added
  `UNDER_REVIEW` to `MentorApplicationStatus`.

## [0.46.0-beta] - 2026-08-04

### Added
- **Public "apply as mentor" form** (#905), at `/apply-as-mentor`, on top of the #904
  application API. No account is required or created — the success screen says so
  explicitly. Fields: full name, email, phone, expertise/skills, experience summary,
  motivation, mentee capacity, LinkedIn; a consent checkbox (linking to `/privacy` and
  `/terms`) is mandatory before submit. The API's 409 (a pending application already
  exists for this email) and 429 (rate limited) responses each get their own message
  instead of a generic failure banner. Localized EN/TR/DE like the rest of the public
  application surface (`/apply/[mentorId]`, `/auth/register`).

## [0.45.0-beta] - 2026-08-06

### Fixed
- **A cancelled recurring project meeting no longer haunts the calendar.** Setting one up used
  to materialise a `Meeting` row per mentee per occurrence, weeks ahead; `DELETE
  /api/meeting-series` only flipped `active` to false, so every generated row stayed on
  everyone's calendar forever, and moving the meeting to another day/time left the old slots
  sitting next to the new ones. A series is now a *rule* and nothing else — no occurrence rows
  are written at all, and cancelling or moving one deletes every row the old generator left
  behind (`purgeGeneratedMeetings`). Notes taken in those meetings survive
  (`PersonalNote.meetingId` is `SetNull`).
- **The recurring meeting is one calendar entry, not one per attendee.** Occurrences are
  expanded from the rule in `/api/calendar-events` (`type: 'series'`) and carry the meeting's
  own title with the project as context, where the generated rows showed each mentee's name.
- **`timeOfDay` is on a real clock.** New `MeetingSeries.timeZone` (IANA, sent by the browser
  on create). The wall clock used to be anchored to UTC, so a rule the UI displayed as "09:00"
  was reminded to an Istanbul mentee as "12:00 (GMT+3)". Rules saved before this read on the
  deployment default zone — the clock the UI was already showing them on. Editing an existing
  rule keeps its zone, so saving the form from another country does not move the meeting.

### Added
- **Week, day and upcoming views on the calendar** (`CalendarView`), alongside the month grid.
  A phone opens on "upcoming" — a flat chronological list — because a 30-cell month grid at
  390px was unreadable; the choice is remembered per browser. Month cells cap at three chips
  (dots on a phone) and a tapped day opens its full list underneath.
- `/api/calendar-events` accepts `from`/`to` and returns only that window (max 400 days), so a
  view fetches what it shows. Omitting both keeps the old unfiltered contract for API clients.
- `src/lib/meetingSeriesOccurrences.ts` — the single rule-expansion used by the calendar, the
  dashboard banner and the reminder cron, so they can't disagree about when a meeting is.

### Changed
- `POST`/`PUT /api/meeting-series` return `nextOccurrence` (the resolved instant) instead of
  `createdMeetings`; `weeksAhead` is still accepted but no longer does anything. The project
  page shows that next occurrence next to the rule, in the reader's own zone.
- A series announcement email is sent on create and when the meeting *moves* — renaming it, or
  saving the same form twice, no longer mails the whole team. It carries no RSVP buttons, as
  there is no row to RSVP against.

## [0.44.0-beta] - 2026-08-06

### Changed
- **The landing page now argues instead of listing.** Rebuilt around the three-sided loop
  (mentee ↔ mentor ↔ company) that `docs/landing-value-proposition.md` derived from a
  code-grounded capability audit: hero → the loop + chain of proof → "pick your side" cards →
  one section per audience → how it works → pipeline → features → roles → transparency → FAQ →
  a closing CTA with one button per audience. 152 new `landing.*` keys in EN/TR/DE.
- **Every claim is one the code can back.** Dropped from the copy: "companies discover you"
  (the interest signal reaches the mentor, not the mentee), "junior *and* senior talent"
  (the talent-pool query filters `role: 'MENTEE'`), "reach out directly / go talent hunting"
  (company users cannot message candidates), "manage your interns" (the company panel is
  read-only) and "cheaper than ever" (there is no price to compare). Each is replaced by what
  the product actually does, with its limit stated in the same sentence.
- Hero drops its buttons: a single "Get Started" funnelled mentors and companies into the
  mentee sign-up form. Mentor and company CTAs are an email to the program (from the
  `supportEmail` setting) until their own entry pages land (#905, #1102) — and render only
  when that address is configured, so the page never ships a dead button.
- Landing header, transparency strip and footer now link the public source (AGPL-3.0), the
  release notes and `/features`; the version count is read from `RELEASE_NOTES`, never typed in.

### Added
- FAQ section: 16 real objections with answers, grouped by audience.
- `data-testid="role-card"` on the three audience cards, for the e2e assertions.

## [0.43.0-beta] - 2026-08-05

### Added
- **`selfRegistration` setting** (`src/lib/settings.ts`, admin → Settings, `auto` by default).
  `auto` = an open sign-up admits itself the moment its email is verified; `manual` = it waits
  for an admin, which is the escape hatch if sign-ups ever need vetting. Invited users are
  unaffected — an invitation already proves the address.
- **`User.pendingApproval`** (Boolean, default false) — set only under `manual`, so the sign-in
  page can tell "we haven't reviewed you yet" apart from "an admin switched you off"; both are
  `isActive = false`. Cleared when an admin activates the account, set when one deactivates it.
- `auth.verifyEmailSent` string (EN/TR/DE) and a `?verify=true` notice on the sign-in page.

### Changed
- **Open registration no longer dead-ends.** `POST /api/register` creates a self-registered
  account inactive as before, but `POST /api/auth/verify-email` now activates it (unless it is
  parked for an admin or was deactivated by one). Registering used to leave the visitor stuck:
  before verifying they were told "your email is not verified", and *after* verifying they were
  told "this account has been deactivated" — the account never became reachable without an admin.
- The post-registration redirect now distinguishes the three cases (invited → `registered`,
  open sign-up → `verify`, manual approval → `pending`).
- The admin notification for a new sign-up says whether it needs action or is an FYI.

## [Unreleased]

### Added
- **Database backups, and a gate that refuses to destroy data** (#1181, #1182 · epic #1179).
  Every deploy runs `prisma db push --accept-data-loss` and, until now, there was no backup
  anywhere in the repo — a PR that renamed a column would drop it in production with no way
  back. `infra/backup-db.sh` dumps the database (mysqldump → gzip, size + gzip-integrity +
  `CREATE TABLE` checks, `KEEP_DAYS` rotation, `0600` files in a `0700` directory) and
  `infra/schema-guard.sh` asks `prisma migrate diff --script` what the pending push would run,
  stopping the deploy on `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / a `NOT NULL` conversion.
  Both are wired into `infra/deploy-prod.sh` ahead of the push, and scale with the environment:
  prod backs up and blocks, preview backs up and warns, topic envs do neither (disposable,
  shared DB). Overrides: `FORCE_NO_BACKUP=1`, and `ALLOW_DESTRUCTIVE=1` — which is refused
  unless a backup was taken in the same run. An unavailable diff is treated as unsafe, never
  as "probably fine".
- `docs/disaster-recovery.md` — restore runbook with a drill log whose RPO/RTO stay empty until
  a real drill measures them, plus `infra/README.md` §5 (cron setup, overrides). Dumps are
  git-ignored; they contain real personal data.
- **Topic-environment sweep** (`.github/workflows/topic-sweep.yml`, #962). Teardown is driven by a
  `pull_request: closed` event, and an event that never fires (approval-gated run, cancelled run,
  offline runner, reboot) leaks a container forever. On 2026-08-08 one such orphan held port 3392
  and stopped PR #1192 from deploying at all — topic ports are `3300 + PR % 100`, so a leak
  silently steals the slot of every hundredth PR after it. The sweep reconciles instead of
  trusting the event: list the `internship-crm-pr<N>` containers actually on the box, ask GitHub
  which of those PRs are still open, tear down the rest. Split across runners because only the box
  sees docker and only a hosted runner is guaranteed `gh`. A number that is not a PR at all is left
  alone — the job only removes what it can prove is finished. It reports on every run, including
  "nothing to do" (a silent janitor is how the ten orphans in #962 went unnoticed), and records
  which container holds each 33xx port.

### Fixed
- **The five specs failing in the scheduled full e2e suite** (run 31051715943). Both causes were
  test defects, not product bugs. Since #1008 gave `/admin/candidates` a separate `md:hidden`
  mobile list, every candidate is in the DOM twice, so the unscoped `getByText('<name>')`
  assertions in `admin-bulk-candidates`, `dashboard-links`, `export-filter` and `export` became
  strict-mode violations — they now scope to `candidates-desktop-list` (the list the Desktop
  Chrome viewport actually renders). `security-headers` still asserted the pre-Jitsi
  `camera=()`; it now checks that camera/microphone/display-capture are delegated to
  `self "https://meet.jit.si"` only, that `geolocation=()` stays denied and that no directive
  opens up to `*`. No version bump — tests only.

## [0.42.2-beta] - 2026-08-05

### Added
- **Mentor onboarding checklist** (#912): the existing first-run `OnboardingChecklist` (already
  role-aware and shared with the mentee/admin dashboards) now drives a mentor-specific step set
  from `GET /api/onboarding` — bio filled, interests or skills filled, mentee capacity set, and
  at least one availability slot — linking to `/mentor/profile` (the mentor profile-editing page
  itself is #908, a dependency of this issue) and to the existing `/mentor/availability`. Hides
  once every step is done, or when dismissed, same as the other roles. Replaces the previous
  mentee-count/interaction/meeting-based mentor steps. EN/TR/DE translations.

## [0.42.1-beta] - 2026-08-05

### Added
- **Entry links to the "become a mentor" application page** (#907, depends on #905's
  `/apply-as-mentor` page): a "Want to become a mentor?" prompt now points there from three
  places without an invitation — a secondary CTA on the landing page's closing section, a link
  on sign-in, and the same prompt next to the invitation-token field on register (whose hint
  text now also points here). All copy is EN/TR/DE via `src/i18n/dictionaries.ts` (new
  `auth.wantMentor` / `auth.applyMentorLink` keys, updated `auth.tokenHint`); no existing
  landing copy changed.

### Changed
- **Notification emails now respect each recipient's stored language preference** (Story #883).
  Announcement emails use `preferredLanguage` for their EN/TR/DE subject and template text,
  while stage-deadline cron emails use the mentor's stored preference without relying on
  cookies or request context. Missing or unsupported language values fall back to English.

## [0.42.0-beta] - 2026-08-04

### Added
- **Goal templates are managed, and multilingual.** `ProjectTaskTemplate` gains a nullable
  `translations` Json column (`{ en?, tr?, de? }`); `title` stays the canonical wording, the
  pool's dedupe key and the fallback. `src/lib/goalTemplates.ts` normalizes input, derives the
  canonical title (default locale first, then any filled language) and resolves the wording one
  person should read.
- **New admin screen `/admin/goal-templates`** (+ `AdminNav` entry) over
  `GET/POST/PATCH/DELETE /api/admin/goal-templates` (ADMIN only, shared pool = `projectId: null`):
  add a goal in up to three languages, reword it, delete it, see which languages are still
  missing and how often each has been handed out. Deleting a template leaves goals already handed
  out alone — by then they are tasks of their own.
- **Per-project template management** in `ProjectGoals`: the pool box now shows each entry in the
  viewer's language, marks the admin-managed shared ones as read-only ("shared" badge), and lets
  a project lead reword (new `PATCH /api/projects/[id]/task-templates`) or delete the project's
  own entries. `POST` on that route accepts `translations` alongside the legacy `title`.

### Changed
- A goal handed out from the pool is created in the **assignee's** language
  (`User.preferredLanguage`, falling back to the default locale, then `title`) — a task is a
  single string, so the language is resolved once, at hand-over.
- Sending a shared template no longer clones it into the project's own pool: the automatic
  "capture what was written" upsert now skips titles that came from the pool, which would
  otherwise copy a shared goal in under whatever language it resolved to.
- `prisma/seed-goal-templates.mjs` seeds all 20 starter goals in EN/TR/DE and back-fills
  translations onto rows seeded before the column existed. Still idempotent, still keyed on the
  Turkish `title`.
- `isLocale()` accepts `null` (it is now fed `User.preferredLanguage`).
- Feature catalogue: the `projectTeams` entry describes the managed multilingual pool and goals
  living on the person's profile.

## [0.41.5-beta] - 2026-08-04

### Fixed
- **"View CV" downloaded the file instead of showing it** — on a phone that reads as a dead
  link: the tab opens blank and the file lands in Downloads. `GET /api/cv/[userId]` has answered
  `Content-Disposition: attachment` for everything since #890; it now accepts `?inline=1` and
  honours it for `application/pdf` only (upload accepts PDF and Word, and the bytes are verified
  against the declared type in #888, so an inline PDF here really is a PDF and renders in the
  browser's own viewer rather than as a page on our origin). Word CVs still download — no browser
  renders them. Every "view CV" link now goes through `cvViewHref()` (`src/lib/cvLink.ts`):
  mentee detail, admin candidates list and detail (`CvManager`), company candidate detail. An
  external `cvUrl` (a Drive link a mentee typed in) is untouched.
- **A long e-mail broke the mentee detail header on mobile** (`/mentor/mentees/[id]`). Name +
  e-mail and the stage select shared one flex row with a `min-w-[240px]` right column, so a long
  address ran under the select and pushed the status badge off the right edge of the screen. The
  header now stacks below `sm`, and the text column is `min-w-0 break-words` so a long address
  wraps instead of widening the row. Same `break-words` on the admin candidate detail header,
  which had the identical text.

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
