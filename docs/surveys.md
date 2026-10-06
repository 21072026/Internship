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
(`src/lib/surveys.ts`) writes `respondentId = NULL` and `invitationId = NULL`
on an anonymous response; it stamps the invitation's `respondedAt` in the same
transaction, so completion tracking and reminders still work without any record
of which answer came from whom. `e2e/survey-schema.spec.ts` reads the row back
from the database to prove it.

## The response floor — the sentence for buyers

> **No breakdown ever shows a number for fewer than five people, and the group
> next to it is hidden too, so nobody can be worked out by subtraction.**

`applyResponseFloor()` hides every bucket under the floor *with its count*, and
when exactly one bucket would be hidden next to a published total it hides the
smallest shown bucket as well. An "everyone else" bucket gets no exemption. The
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
