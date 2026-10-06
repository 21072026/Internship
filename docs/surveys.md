# Surveys — the data model and who may read an answer (#1879, epic #1877)

Anonymity is why people answer honestly. If it is a UI convention, the first
works council that tests it finds a small cohort de-anonymised and the deal
stops. So in this engine it is a rule of the **database write** and of **one
library**, never of a screen.

## Why a survey is not an `Evaluation`

An evaluation is one named person assessing another against a framework, read
by the people involved. A survey is many people answering about their **own**
experience, read **in aggregate**. Mixing them would put a mentee's honest
answer about their mentor next to the mentor's assessment of the mentee — the
one place it must never be.

## The model

| Model | What it is | Tenant |
|---|---|---|
| `Survey` | one instrument run: title, audience, **anonymity mode**, status, the response floor | `TENANT_MODELS` |
| `SurveyQuestion` | a question; `key` is the answer join key, frozen once the survey opens | via `Survey` (not listed — same reasoning as `MeetingGuest`) |
| `SurveyInvitation` | one per person per survey; stores the token **hash** only; `respondedAt` is the completion record | `TENANT_MODELS` |
| `SurveyResponse` | one submission; `respondentId`/`invitationId` are **NULL** for an anonymous survey | `TENANT_MODELS` |
| `SurveyAnswer` | one answer, keyed by `questionKey`, so re-wording never orphans an answer | via `SurveyResponse` (not listed) |

Question types are the shared form field types (`src/lib/forms/schema.ts` —
TEXT, LONG_TEXT, SELECT, MULTI_SELECT, NUMBER, BOOLEAN, DATE, SCALE) plus
**NPS**, validated as a 0..10 scale through the same `validateResponse()`. The
browser, the API and any job call that one function.

## What each mode promises

| Mode | We promise | Who reads one answer |
|---|---|---|
| **IDENTIFIED** | your name is on your answer | you, and an ADMIN |
| **CONFIDENTIAL** | we know you answered (to stop reminding you), staff see only totals | you |
| **ANONYMOUS** | your answer is not linked to you anywhere — not even in our database | nobody |

In **every** mode, a mentor never reads their own mentee's individual answer,
even if the mentor also holds the ADMIN role. That rule is checked before
anything that could allow it (`canReadIndividualResponse`,
`src/lib/surveyPrivacy.ts`).

**Anonymous means severed at the write.** `submitSurveyResponse()`
(`src/lib/surveys.ts`) writes `respondentId = NULL`, `invitationId = NULL` and
`relationId = NULL` on an anonymous response (the relation names the mentee
just as well as their id does — #1910 closed that gap); it stamps the invitation's `respondedAt` in the same
transaction, so completion tracking and reminders still work without any record
of which answer came from whom. `e2e/survey-schema.spec.ts` reads the row back
from the database to prove it.

## The response floor — the sentence for buyers

> **No breakdown ever shows a number for fewer than five people, and the group
> next to it is hidden too, so nobody can be worked out by subtraction.**

`applyResponseFloor()` hides every bucket under the floor *with its count*, and
while the hidden buckets together add up to fewer than the floor it hides the
smallest shown bucket as well — next to a published total, the hidden ones
can be recovered *as a group* by subtraction (#1879 did this only for a single
hidden bucket, so buckets of 1 and 2 were readable as a group of 3; #1910). An "everyone else" bucket gets no exemption. The
default floor is `SURVEY_MIN_RESPONSES = 5`; a survey may raise it
(`minResponses`), never lower it — the API refuses a lower value and
`effectiveMinResponses()` enforces it again on read.

## Rules at the write boundary

- Once a survey has left `DRAFT`, its questions' keys and types are frozen:
  adding, removing, re-keying or re-typing a question is **409
  `questions_locked`**. Wording, help text, options and order may still change.
- A survey never returns to `DRAFT` (**409 `reopen_draft`**).
- Anonymity and audience are fixed at create — changing who may see an answer
  after people answered would break the promise they answered under.
- An invitation is answered once (**409 `already_responded`**); a response to a
  survey that is not `OPEN` is **409 `not_open`**.

Admin API: `GET/POST /api/admin/surveys`, `GET/PATCH /api/admin/surveys/[id]`.
The builder screen, login-free answering (#1881) and campaigns (#1887) build
on this.

## Answering by link, no login (#1881)

A survey behind a password is a survey nobody answers, so an invitation is a
link: `createSurveyInvitation()` (`src/lib/surveyTokens.ts`) mints a random
256-bit token, stores only its SHA-256 hash in `SurveyInvitation.tokenHash`,
and returns the token once for the mail (`surveyInviteUrl()` →
`/s/<token>`, default lifetime 30 days). A random token looked up by its hash
cannot be re-derived from the server secret and is revoked by deleting one row
— the `TrustedDevice` discipline rather than a third token scheme.

- `GET /api/surveys/respond?token=` returns the survey in the recipient's
  language and the invitation's state — `open`, `alreadyAnswered`, `closed`
  (status or `opensAt`/`closesAt`, the one rule `surveyAcceptsAnswers()`),
  `expired` (410) or `invalid` (404). It never returns an answer.
- `POST /api/surveys/respond` validates through the shared validator and
  writes through `submitSurveyResponse()`; the invitation is claimed, so a
  second submit is `{ state: 'alreadyAnswered' }`, never a second row. Both are
  rate-limited per IP; POST also per token.
- `/s/<token>` shows one question per screen on a phone and all of them from
  `sm` up; NPS renders as a 0–10 row. Partial answers stay in component state
  only — an unfinished anonymous draft saved anywhere would be a stored identity.
## Meeting feedback (#1896)

The smallest survey in the product: after a relation meeting, each of its two
people is asked **at most two questions** — did it take place, and how helpful
was it (1–5). `MeetingFeedback` holds one row per (meeting, rater); answering
again updates it.

- **Ask once, in two places.** An inline card right after "mark meeting ended"
  (`MeetingFeedbackCard`, in the dashboard banner), and — when nobody ended the
  meeting — one e-mail to the mentee from the auto-log sweep
  (`askForMeetingFeedback`, `src/lib/meetingFeedback.ts`). The sweep claims the
  meeting row (`Meeting.feedbackAskedAt`) before mailing, so a second sweep
  asks nobody; a mentee who answered in the app is not asked at all. External
  `MeetingGuest` invitees are never asked — no account, no relation.
- **One click, no login.** Each button in the mail is its own signed link
  (`src/lib/meetingFeedbackToken.ts`, its own HMAC domain). The link opens
  `/meeting-feedback/<token>`, which records the rating from the browser;
  `GET /api/meeting-feedback/<token>` only reads, because mail scanners
  prefetch links.
- **"We didn't meet" is its own answer.** It counts in `happenedRate` and never
  in `avgHelpfulness`.
- **Visibility.** A rater reads their own answer. A mentor reads only
  `GET /api/mentor/meeting-feedback` — the aggregate of what *other* people
  said about their meetings, `null` under the response floor, never a rating,
  a rater or a note. `meetingQualityFor(relationId, windowDays)` is the health
  score's input and returns `null` under the floor as well.
- **Free.** No entitlement check anywhere: what is asked is the participant's
  own experience. The mail is category `meeting-feedback` in the
  *task reminders* group, so it can be switched off without silencing the
  meeting reminders.

## Campaigns (#1887)

A campaign turns a survey from something an admin sends into something the
programme sends: **who** (the survey's audience, or an override: MENTEE,
MENTOR or BOTH) gets **which** survey **when**.

| Trigger | Fires | Period key |
|---|---|---|
| `STAGE_ENTERED` | a `StatusChange` into `stageKey` — the tenant's own key, checked against its resolved stages at create (`unknown_stage` otherwise) | `stage:<key>` |
| `DAYS_AFTER_START` | `dayOffset` days after the relation started | `day:<n>` |
| `DAYS_BEFORE_END` | `dayOffset` days before the relation's stage deadline (a moved deadline is a new period) | `before:<deadline day>` |
| `MANUAL` | once to the whole active audience, as soon as the campaign is active | `manual` |
| `RECURRING` | every `everyDays` days (7–365), one round per period from the campaign's creation day | `pulse:<n>` |

`dispatchDueSurveyCampaigns()` (`src/lib/surveyCampaigns.ts`, daily 10:00 UTC
from `/api/cron/start`, and `GET /api/cron?job=surveys` for an admin's own org):

- **claims first** — a `SurveyCampaignSend` row, unique on (campaign, person,
  period), before the invitation is minted or the mail sent; two sweeps send one
  invitation;
- **never backfills** — a trigger looks back at most 7 days and never before
  the campaign was created;
- **caps a tick** at 50 invitations (`?batch=` may only lower it); the rest go
  next tick;
- **skips opt-outs** — the mail is category `survey-invite` in its own
  `surveys` e-mail group, and a person who switched it off (or an inactive
  account) is not claimed and not invited.

**How RECURRING got here (expand → contract).** A pulse needs one invitation
per person *per round*, so `SurveyInvitation`'s unique is
`[surveyId, email, round]`. It used to be `[surveyId, email]`, and MariaDB
refuses to drop a unique the `surveyId` foreign key is served by
(`Cannot drop index … needed in a foreign key constraint`) — Prisma drops
before it creates, so a one-step change fails the deploy. It shipped in two
deploys: #1887 added the `round` column and a dedicated `@@index([surveyId])`
(the **expand**), #2769 widened the unique and switched RECURRING on (the
**contract**). Keep that index: it is what lets the unique change again.

## Results (#1910)

`/admin/surveys` lists the surveys with their response counts;
`/admin/surveys/[id]/results` (API: `GET /api/admin/surveys/[id]/results`,
ADMIN only, tenant-scoped, 404 for another tenant's survey) shows one. Every
rule is applied in `loadSurveyResults()` (`src/lib/surveyResults.ts`) before a
number leaves the server — the screen only draws what it gets:

- **Under the floor, nothing but counts.** With fewer responses than the
  survey's floor the result is the total and how many answered each question —
  no score, no distribution, no free text.
- **NPS** (`src/lib/nps.ts`): 9–10 promoter, 7–8 passive, 0–6 detractor,
  score = % promoters − % detractors, rounded once. The **week-by-week trend**
  is a breakdown like any other — next to the overall score a lone hidden week
  could be recovered by subtraction — so the weeks go through
  `applyResponseFloor`, residual included, and a hidden week carries no count.
- **Breakdowns** of the first NPS question by respondent role, cohort and
  mentor go through `applyResponseFloor`, and a hidden group is **not sent at
  all** — not even its key: "Mentor X: hidden" already says Mentor X has fewer
  than five. The response says only that some were held back. Cohort and
  mentor breakdowns exist only where responses carry a relation, so an
  ANONYMOUS survey has none.
- **Free text** is an unattributed list sorted alphabetically, never in
  arrival order (which could be matched to a known time).

Per-question distributions of a survey that passed the floor are shown in
full: they are counts over at least *floor* people, not a group of them.

## Reminders and completion (#1889)

**Two reminders, never three.** `SURVEY_MAX_REMINDERS = 2`
(`src/lib/surveyReminders.ts`) — the same ceiling as the dormant first-contact
check-ins, for the same reason: two well-timed reminders roughly double a
response rate, a third burns the sending domain. Reminder 1 is due 3 days after
the invitation, reminder 2 after 7, only while the survey is open and in its
window, the invitation unanswered and unexpired, and the person active and not
opted out of the `surveys` e-mail group. Never two within 24 hours.

**One claim for both paths.** The scheduled pass (with the campaign sweep,
daily 10:00 UTC; `GET /api/cron?job=surveys` → `surveyReminders`) and "remind
now" (`POST /api/admin/surveys/[id]/remind`) both claim reminder *k+1* with the
same conditional UPDATE (`remindersSent = k AND respondedAt IS NULL`, plus the
`lastRemindedAt` it read). Exactly one caller wins: two clicks at once send one
mail, and a manual nudge moves the schedule along — it is reminder 1, not an
extra. `remind now` waives only the day-3/day-7 timing.

**Every link keeps working.** Only token hashes are stored, so a reminder mints
its own link (`SurveyInvitationToken`) instead of resending the first; the
first mail's link answers the same invitation, once.

**The completion console** — `/admin/surveys/[id]`, API
`GET /api/admin/surveys/[id]/completion` (ADMIN only, tenant-scoped):

- invited, answered and the rate **answered / invited** — not shown below the
  survey's floor (2 of 30 is noise, not a rate). The same rule now applies to
  the response rate on the results screen. The counts of who is still pending
  stay visible: completion is not an answer, and the floor protects answers;
- the unanswered invitations by reminders received (0 / 1 / 2);
- **IDENTIFIED / CONFIDENTIAL:** the people who have not answered, each with
  its reminder state and a "remind now" that the cap still governs. Who did
  answer is not listed — the console's job is the next nudge;
- **ANONYMOUS:** no per-person list **in the payload at all** — "who answered"
  next to the response timestamps is exactly the link the promise says does not
  exist — and "remind now" exists only for the whole survey (naming an
  invitation is **400 `anonymous_bulk_only`**).
