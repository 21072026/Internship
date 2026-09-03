# AI features (#2034)

Five product features send text to a third-party language model. This document
is the complete, honest inventory: which features, what leaves the server, what
deliberately does not, who consents, and what happens when the provider is
absent.

The public, visitor-facing version of the same facts is [`/ai`](../src/app/ai/page.tsx)
(EN/TR/DE, strings in the `ai` block of `src/i18n/dictionaries.ts`). **They must
not disagree.** If you change what a feature sends, change both.

## The one door: `runAiGated`

Every provider call in this codebase goes through
[`src/lib/aiGate.ts`](../src/lib/aiGate.ts). Nothing else may construct an
`Anthropic` client and call it — the `src/lib/ai*.ts` modules only *talk* to the
provider, they never decide whether they are allowed to.

```
runAiGated({ scope, consent?, userId?, companyId?, call })
  │
  ├─ consent?      hasConsent(userId, type) — false → { ok:false, 'no_consent' }
  ├─ quota         Setting.aiMonthlyQuota, calls this calendar month
  │                0 or exhausted → { ok:false, 'quota_exceeded' }
  ├─ configured    ANTHROPIC_API_KEY set → else { ok:false, 'not_configured' }
  ├─ call()        the provider request
  └─ meter         AiUsage row AFTER success only
```

The order is deliberate. Quota is checked **before** configuration so that
`aiMonthlyQuota = 0` means "AI is off for this organisation" whether or not an
API key happens to be present, and so quota behaviour stays testable in an
environment with no key. Metering happens **after** a successful call, so a
provider failure never consumes credit; the `AiUsage` insert is
`.catch(() => {})` because metering must never break a call the user already
paid for in latency.

## The task table

| Task (`scope`) | Route | Audience | What is sent | What is deliberately **not** sent | Consent | Free? |
|---|---|---|---|---|---|---|
| `cv_extract` | `POST /api/cv/[userId]/extract-ai` | mentee (own CV), and roles `canAccessCv()` allows | the CV's already-extracted **text**, capped at 24 000 chars | the CV **file** itself; anything not in the CV | `AI_CV_PARSING`, from the CV owner | yes |
| `cv_feedback` | `POST /api/cv/feedback` | mentee, own CV only | the same extracted CV text, same cap | the file; other people's CVs (the route ignores any id and reads the caller's own) | `AI_CV_PARSING`, from the caller | yes — never a paywall |
| `interaction_summary` | `POST /api/interactions/summary` | mentor / admin on their own relation | the 30 newest log entries: date, type, subject, notes; the mentee's display name | attachments, documents, e-mail addresses, phone numbers, CV | `AI_INTERACTION_SUMMARY`, from the **mentee** whose log it is | yes |
| `interview_prep` | `POST /api/interview-prep` | mentee, for themselves | the target position, the skills on the profile, an optional free-text focus (≤300 chars) | name, contact data, CV, employer names, anything about the mentor | none — no identifier is sent | yes — never a paywall |
| `mentor_match` | `POST /api/admin/mentor-suggest` | admin | the mentee's skills / target position / interests, and up to five mentors as **anonymous labels A–E** with skills, interests and load | every name, e-mail and id on both sides; labels are mapped back to mentor ids locally, after the response | none — no identifier is sent | n/a (admin tool) |

Two of these carry no consent type because there is no personal identifier in
the payload to consent to. That is not an oversight and it is not a loophole:
`interview_prep` sends what the mentee typed about the job they want, and
`mentor_match` sends a skills vector under a letter. Adding a personal field to
either payload means adding a consent type in the same change.

Consent types live in `ConsentType` (`prisma/schema.prisma`), are read through
[`src/lib/consent.ts`](../src/lib/consent.ts), and are self-serve for the person
they belong to in Account → Privacy (`src/components/ConsentSettings.tsx`).
Revoking one takes effect on the next call — there is no cached grant.

## Provider

| | |
|---|---|
| Provider | Anthropic, through the official `@anthropic-ai/sdk` |
| Credential | `ANTHROPIC_API_KEY` — server-side only, never reaches the browser |
| Model | `ANTHROPIC_CV_MODEL` (default `claude-opus-4-8`), plus `ANTHROPIC_SUMMARY_MODEL` for the interaction summary. The operator of an instance chooses. |
| Request timeout | 60 s. The SDK's own default is 10 minutes, long enough to hold a request handler open until the user gives up (#895). |
| Input cap | 24 000 chars for text tasks; the structured tasks are bounded by their schema |
| Output cap | 600–1024 `max_tokens` per task |

`cv_extract` and `mentor_match` additionally pin a **JSON schema** on the
response, so what comes back is a shape, not prose we then have to parse
defensively.

### What we do not have

Write this section down rather than leaving it implied, because the honest
answer is the one a procurement reviewer is actually checking for:

- **No signed DPA or zero-retention addendum** with the provider. We are an API
  customer on published commercial terms. When that changes, this table and
  `/ai` change with it.
- **No guaranteed processing region.** Requests go wherever the provider's API
  serves them.
- **No SOC 2 / ISO 27001** for this application.
- **No published model evaluations** for these five tasks.

Do not let any of these turn into a claim on the public page. "Not yet, and here
is what we do instead" is the format.

## Retention

Neither the prompt nor the generated text is stored:

| Output | Where it goes |
|---|---|
| CV field suggestions | rendered next to an "Apply" button; stored only in the profile field the person chose to apply |
| CV feedback | rendered in the mentee's browser, gone on reload |
| Interaction summary | rendered in the mentor's browser, gone on reload |
| Interview prep | rendered in the mentee's browser, gone on reload |
| Match rationale | rendered next to the suggestion, gone on reload |

The only row written per call is `AiUsage` — `scope`, `userId`, `companyId`,
`createdAt`. **No prompt, no completion, no excerpt.** It exists to meter the
monthly quota and to answer "how much did this cost us", and it is the reason a
usage figure can be shown without keeping anyone's CV around.

## The degradation contract

An AI denial is never an error page and never a paywall:

| Reason | Mentee-facing surfaces | Staff-facing surfaces |
|---|---|---|
| `no_consent` | a hint linking to the consent setting | "the mentee has not consented" |
| `not_configured` | the feature **hides itself** (`GET` availability probes) | the button hides after the first attempt |
| `quota_exceeded` | a neutral "temporarily unavailable" — never quota mechanics, never pricing | the actual reason, because they can fix it |

`mentor_match` degrades differently and more strongly: the rule-based ranking
(skill overlap, then lighter load) is computed **first, always**. AI only
re-orders that list and adds one sentence of reasoning. With no provider, no
quota or a provider failure, the admin gets the same list with `aiUsed: false`
and no rationale text. The feature is a garnish on a deterministic ranking, not
the ranking.

## Human in the loop

Nothing here decides anything about a person.

- The match suggestion is ordered by a local rule first, is limited to the top
  five mentors, and is applied only when an administrator picks a name and
  presses Assign.
- No pipeline stage, no rejection, no offer and no account state is ever set by
  a model.
- CV extraction proposes field values; the person applies them field by field.

That is the posture we state publicly (EU AI Act / NYC LL144, #2019), and it is
a design constraint, not a description of the current implementation that could
drift: any future feature that lets a model write a decision back into a record
needs a separate discussion first.

## The two boundaries that are closed

1. **No provider call outside `runAiGated`.** A module that imports
   `@anthropic-ai/sdk` and calls it directly bypasses consent, quota and
   metering all at once — three failures for the price of one import. New AI
   tasks add a `scope` and go through the gate.
2. **Participant AI is never paywalled.** `cv_feedback` and `interview_prep`
   belong to the mentee, cost the mentee nothing, and surface quota exhaustion
   as "not right now" rather than "upgrade". The org's plan is the operator's
   problem; a student preparing for an interview is not the person to bill for
   it.

## Labelling

Every rendered model output carries the shared ✨ marker
([`src/components/AiBadge.tsx`](../src/components/AiBadge.tsx)): a visible chip,
a screen-reader label, a tooltip, and — where the output is prose someone might
act on — a one-line "check it before you rely on it" note linking to `/ai`.

Badged surfaces: `CvFeedback`, `InterviewPrep`, `InteractionSummary`,
`CvSuggestPanel` (the AI block only — the local heuristic block next to it is
**not** AI and must not be badged), and the match rationale in
`admin/AssignMentorInline`. A new surface that renders a model's words adds the
badge in the same change.

## Adding an AI task

1. A `src/lib/ai<Task>.ts` module that only talks to the provider: a `SYSTEM`
   prompt, an input cap, a timeout, and a return value. No consent logic.
2. A route that calls `runAiGated` with a new `scope` string and, if any
   personal data is in the payload, a `ConsentType` — added additively to
   `prisma/schema.prisma`, surfaced in `ConsentSettings`.
3. Handle all three denial reasons per the degradation contract above.
4. `<AiBadge />` on whatever renders the result.
5. A row in the task table here, the matching entry in the `ai` dictionary block
   for `/ai`, and the route in
   [`role-access-matrix.md`](role-access-matrix.md).

Step 5 is the one that gets skipped, and it is the one this document exists for.
