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
`aiMonthlyQuota = 0` means "AI is off" whether or not an API key happens to be
present, and so quota behaviour stays testable in an environment with no key.
Metering happens **after** a successful call, so a provider failure never
consumes credit; the `AiUsage` insert is `.catch(() => {})` because metering must
never break a call the user already paid for in latency.

The **limit and the counter are scoped differently**, which matters on a
multi-tenant installation: the limit is a `Setting`, so it resolves tenant row →
global row → default like every other one, while `AiUsage` has no `orgId` and is
not in `TENANT_MODELS` — `getAiQuota()` counts every row for the month, whoever
made the call. So the month's pool is **installation-wide**: two tenants share
one counter, and the number one tenant's admin sets is measured against the
calls both of them made. The field on `/admin/settings` (#1625) says so in its
hint. Scoping the meter per tenant means adding `orgId` to `AiUsage`,
registering it, and filtering the count — until then, treat the quota as an
operator-level cost control that happens to be editable per tenant.

## The task table

| Task (`scope`) | Route | Audience | What is sent | What is deliberately **not** sent | Consent | Free? |
|---|---|---|---|---|---|---|
| `cv_extract` | `POST /api/cv/[userId]/extract-ai` | mentee (own CV), and roles `canAccessCv()` allows | the CV's already-extracted **text**, capped at 24 000 chars | the CV **file** itself; anything not in the CV | `AI_CV_PARSING`, from the CV owner | yes |
| `cv_feedback` | `POST /api/cv/feedback` | mentee, own CV only | the same extracted CV text, same cap | the file; other people's CVs (the route ignores any id and reads the caller's own) | `AI_CV_PARSING`, from the caller | yes — never a paywall |
| `interaction_summary` | `POST /api/interactions/summary` | mentor / admin on their own relation | the 30 newest log entries: date, type, subject, notes; the mentee's display name | attachments, documents, e-mail addresses, phone numbers, CV | `AI_INTERACTION_SUMMARY`, from the **mentee** whose log it is | yes |
| `interview_prep` | `POST /api/interview-prep` | mentee, for themselves | the target position, the skills on the profile, an optional free-text focus (≤300 chars) | name, contact data, CV, employer names, anything about the mentor | none — no identifier is sent | yes — never a paywall |
| `mentor_match` | `POST /api/admin/mentor-suggest` | admin | the mentee's skills / target position / interests, and up to five mentors as **anonymous labels A–E** with skills, interests and load | every name, e-mail and id on both sides; labels are mapped back to mentor ids locally, after the response | none — no identifier is sent | n/a (admin tool) |
| `survey_summary` | `POST /api/admin/surveys/[id]/summary` | admin | one free-text question's answers on the open-text engine: unattributed, contact details masked, under labels `r1…`; only above the survey's response floor **and** only when the question itself has that many answers | respondent ids, names, timestamps | none — no identifier is sent | n/a (admin tool) |
| `analytics_narrative` | `POST /api/admin/analytics/narrative` | admin | the dashboard's totals as `label: value` lines (stage counts with stage names, monthly trends, engagement, RSVP rate, sign-up windows), recomputed on the server | mentor workload rows (they carry names), every per-person row and id | none — totals only | n/a (admin tool) |
| `evaluation_insights` | `POST /api/admin/insights/evaluations` | admin | up to 400 evaluation comments in range, under labels `r1…`, with contact details **and every known name** (author, mentee, mentor) masked; capped at 24 000 chars | database ids, who wrote which row, interview scorecards (no relation) | none — names are masked and the rows are the programme's own records | n/a (admin tool) |
| `weekly_report_digest` | `POST /api/admin/insights/weekly-reports` | admin | the `blockers` of up to 400 submitted weekly reports in range, same masking and cap | the report summary, hours, mentor comments, ids | none — as above | n/a (admin tool) |

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
| Retries | At most 2, only on 429 / 5xx / timeout / connection loss, jittered exponential backoff, and no attempt starts after 45 s (`src/lib/ai/provider.ts`, #2024). The SDK's own retries are off (`maxRetries: 0`) so the two cannot multiply. One task is one metered call however many attempts it took. |
| Circuit breaker | 5 failures inside a minute open it for a minute; calls then fail fast with `provider_error` and no network request, and the first call after the cool-down is the probe. Per container — a cost guard, not a distributed breaker. |
| Input cap | 24 000 chars for text tasks; the structured tasks are bounded by their schema |
| Output cap | 600–1024 `max_tokens` per task |

`cv_extract` and `mentor_match` additionally pin a **JSON schema** on the
response — and still parse it through `safeParseModelJson` (#2024), which
validates against a zod schema and falls back (marking the call `parse_error`)
rather than throwing when a reply is not the shape asked for.

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

The prompt is never stored. Since #2044 some generated text **is** kept, as an
`AiArtifact` row (see § Artefacts below):

| Output | Where it goes |
|---|---|
| CV field suggestions | rendered next to an "Apply" button; stored only in the profile field the person chose to apply |
| CV feedback | **kept** as an `AiArtifact` (7-day cache TTL), shown again on reload |
| Interaction summary | **kept** as an `AiArtifact` about the mentee, tied to the relation (1-day cache TTL); the card opens on it |
| Interview prep | **kept** as an `AiArtifact` (7-day cache TTL), shown again on reload |
| Match rationale | **kept** as an `AiArtifact` about the mentee (1-day cache TTL), keyed on the exact candidate list |
| Open-text themes (evaluation comments, weekly-report blockers) | **kept** as an org-level `AiArtifact` with no subject (1-day cache TTL); wiped for the whole org the moment any person in it is erased or anonymized, since it may quote them |

The only row written per call is `AiUsage` — `scope`, `userId`, `companyId`,
`createdAt` and `outcome` (`ok`, `parse_error` when the reply was not the JSON
asked for and the task fell back, `provider_error` when the provider never
answered — the last one is recorded for the console but **does not consume
quota**). **No prompt, no completion, no excerpt.** It exists to meter the
monthly quota and to answer "how much did this cost us", and it is the reason a
usage figure can be shown without keeping anyone's CV around.

## Artefacts (#2044)

`AiArtifact` holds what a call **produced**. `AiUsage` stays the meter.
`runAiGated({ persist })` handles the artefact in four steps:

1. **Consent first.** A withdrawn consent is not answered from a stored copy.
2. **Cache.** An artefact with the same `taskId` (the gate's `scope`) and
   `inputHash`, younger than the task's TTL (`TASK_TTL_MS` in
   `src/lib/ai/artifacts.ts`), is returned with `cached: true`. That skips the
   provider call and the quota.
3. **Regenerate.** `force` (the UI's *Regenerate*) bypasses the cache.
4. **Write-through.** A successful call is written through, best-effort like the
   meter: a failed write never breaks the response. A `parse_error` fallback is
   not kept, because it would answer the next identical request with the
   fallback.

**Who reads one** is decided by `canReadArtifact` in the route, never in a
component:

- the subject (the person it is about) and the creator;
- the subject's ACTIVE mentor, once the subject shared it (`SHARED_WITH_MENTOR`);
- an admin of the org, once it was shared;
- never anyone across an org line.

Only the subject changes visibility (`PATCH /api/ai/artifacts/[id]`, audited as
`ai_artifact.visibility`). The mentor sees shared ones on the mentee's page.

**What each surface keeps, and what counts as "the same input":**

| Task (`scope`) | TTL | Hashed input | Re-opened by |
|---|---|---|---|
| `cv_feedback` | 7 days | the CV text | the CV card, on mount (`GET /api/cv/feedback`) |
| `interview_prep` | 7 days | position, skills, focus | the prep card, on mount (`GET /api/interview-prep`) |
| `interaction_summary` | 1 day | the relation, the mentee's name, the 30 newest log entries | the summary card on `/mentor/mentees/[id]`, on mount (`GET /api/interactions/summary?relationId=`), for the pair's mentor or an admin |
| `mentor_match` | 1 day | the mentee's skills / target / interests and the candidate list **including each candidate's mentor id and position** | the next *Suggest* on the candidate row |

- **Interaction summary:** one log entry added or edited changes the hash. The
  `latest` read is narrowed to the relation, so a mentor who took the mentee
  over does not open on the previous pairing's digest.
- **Match rationale:** the provider sees anonymous labels (`A`–`E`), which are
  positions in the candidate list. The mentor ids are hashed even though they
  never leave the server. Without them, a stored "A" could name a different
  person once the pool changed. A stored ranking that no longer decodes is
  treated as a miss (`runAiGated` falls through to a fresh call), never a 500.
  The candidates page renders one row per mentee, so the card does not fetch on
  mount. A repeat *Suggest* is free and says it is the saved copy.

**Erasure and retention:**

- `subjectUserId` is a real relation with `onDelete: Cascade`, so a hard delete
  takes the person's artefacts with it.
- `anonymizeUser` deletes them explicitly.
- A merge carries them to the primary account.
- A daily sweep (03:20, `sweepAiArtifacts`) deletes every artefact older than
  its org's `retentionMonths`. Pinned ones are not exempt.

## Open-text insights (#2046)

One engine reads many free-text rows at once:
[`src/lib/ai/openTextRules.ts`](../src/lib/ai/openTextRules.ts) holds the
pure rules (what is sent, what is kept, the floor), and
[`src/lib/ai/summarizeOpenText.ts`](../src/lib/ai/summarizeOpenText.ts) holds the
one prompt and `runOpenTextSummary`. The consumers today are the evaluation
themes and the weekly-report digest on `/admin/insights`, and — since #2046
part 2 — the survey summary (#1910), whose engine floor is the survey's own
k-floor applied to the question's written answers.

**What leaves.** Each row's text, with contact details masked (the survey rules)
and every known person's name masked. That means the full name and each part of
three letters or more, on letter boundaries. Rows go under local labels
`r1, r2, …`; database ids never reach the provider.

**What comes back is verified, not trusted:**

- A theme keeps only labels that were sent. Its `count` is the number of those
  labels, never a number the model typed. A theme with no valid label is dropped.
- Sentiment is a **flag**, never a score. Each row gets one of `positive`,
  `neutral`, `negative` or `unclear`, and anything else counts as `unclear`.
  A theme's sentiment is the majority of its rows; a tie is `unclear`. `overall`
  is a count per bucket. There is no decimal anywhere, on purpose.
- A quote survives only if it appears verbatim in the row it names, as it was
  sent, so a quote shows `[name]` and never the name behind the mask.
- `caveats` are codes the screen translates (`below_floor`, `truncated`,
  `names_masked`, `quotes_dropped`), not model prose.

**The floor.** Below the caller's floor, nothing is sent, nothing is metered and
nothing is stored. The response says only that there were too few rows. For
named rows (evaluations, weekly reports) the floor is `NAMED_ROWS_FLOOR` = 3.
Anonymous survey answers use the survey's own k-anonymity floor.

**Cost.** `GET` never calls the provider. It returns the numbers and, when one
is stored for *exactly* the rows in range (`openTextInputHash`: purpose,
language, the sent text), the summary. `POST` runs the gate, and an unchanged
set is still answered from the artefact. A reply that is not the JSON asked for
is metered `parse_error` (`noteParseError()`) and never kept.

**Graceful degradation.** The weekly digest's figures (submissions per week, who
owed last week and did not hand it in) come from the compliance rule
(`src/lib/weeklyReportCompliance.ts`) and render with AI off. Only the themes
are absent, and `reason` says why.

**Click-through.** Every theme lists the ids of its rows, and the screen opens
them with the person and a link to the record. A summary you cannot check is
worse than none.

## The analytics narrative (#2046)

`/admin/analytics` can show a short "what changed" paragraph
([`src/lib/ai/analyticsNarrative.ts`](../src/lib/ai/analyticsNarrative.ts)).

- **Grounded by construction.** The figures are recomputed on the server from
  [`src/lib/adminAnalyticsData.ts`](../src/lib/adminAnalyticsData.ts), the same
  function `GET /api/admin/analytics` returns, never numbers a client sent. They
  go to the model as `label: value` lines (`analyticsFacts`). No names leave:
  mentor workload rows are left out.
- **Verified, not trusted.** `acceptNarrative`
  ([`src/lib/ai/narrativeRules.ts`](../src/lib/ai/narrativeRules.ts)) extracts
  every number in the reply and rejects the whole paragraph if any one of them is
  not in the facts. That covers a computed percentage, a rounded figure and a
  year the range does not contain. Thousands separators and decimal commas are
  read both ways, and neither becomes a loophole. A rejected paragraph is
  metered `parse_error` and never stored. The screen says it was discarded.
- **The golden case** is `scripts/test/narrative-rules.test.mjs`: a fixed
  dashboard, one paragraph that must pass, and the ways a paragraph goes wrong,
  each of which must fail. The eval harness of #2036 does not exist yet; when it
  lands, this case moves there.
- **Cost.** `GET` reads the stored paragraph for exactly the current figures
  (`hashInput({ facts, locale })`). `POST` writes one. With AI off the card is
  not drawn.

## The degradation contract

An AI denial is never an error page and never a paywall:

| Reason | Mentee-facing surfaces | Staff-facing surfaces |
|---|---|---|
| `no_consent` | a hint linking to the consent setting | "the mentee has not consented" |
| `not_configured` | the feature **hides itself** (`GET` availability probes) | the button hides after the first attempt |
| `quota_exceeded` | a neutral "temporarily unavailable" — never quota mechanics, never pricing | the actual reason, because they can fix it |
| `provider_error` (#2024) | the same neutral "temporarily unavailable" (HTTP 503, `code: 'provider_error'`) | "the AI service is not answering right now" |

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
