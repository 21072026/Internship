# One mentee, at most one active mentor

**Status:** application-level guards shipped; the DB-level constraint is a
deliberate follow-up (see [Sequencing](#sequencing)). Tracking: EPIC F / #419.

## The rule

A mentee has **at most one `ACTIVE` `MentorshipRelation` at a time.** This is not
up for debate and it is not a stepping stone to multi-mentor support: the whole
product is built on it. `pickMenteeRelation` renders *the* mentorship, the
portal shows *the* mentor, the pipeline board puts a candidate in *one* column,
and the dormant-first-contact nudge counts *the* relation.

It was always the intended rule — `POST /api/mentorship` and the
request-approval path have answered `409` for it since the beginning — but it
was enforced at **two of eight write paths**, by two hand-rolled `findFirst`s
that had drifted apart, and skipped entirely everywhere else.

## The one reader

[`src/lib/activeMentorship.ts`](../src/lib/activeMentorship.ts) owns the
question. `findActiveMentorship(db, menteeId, { exceptRelationId })` and
`hasOtherActiveMentorship(...)` take either the prisma singleton or a
`Prisma.TransactionClient`, so a front door can re-ask **inside** the
transaction that writes. Every refusal uses `ALREADY_MENTORED_ERROR`, whose
`error` string is byte-identical to the one `POST /api/mentorship` has always
returned (`e2e/dup-guard-transliteration.spec.ts` matches on it) and whose
`code: 'already_mentored'` is what the UI translates.

No hand-rolled copy of the filter is left in `src/`. There is exactly one seam:
`scripts/import-csv.mjs` is a `.mjs` file and `tsconfig.json` excludes
`scripts/`, so it carries the filter inline with a comment pointing here.

## The write paths, and what each one does now

| Path | Before | Now |
|---|---|---|
| `POST /api/mentorship` | 409, but read-then-write with the plan gate, an availability count and a stage lookup in between | 409 from a guard **inside** the `$transaction` that creates |
| `src/lib/mentorshipDecision.ts` (approve a request) | 409, guard outside an array `$transaction` | 409 from inside an interactive transaction; the request `update` also matches on `status: 'PENDING'`, so two concurrent approvals of one request cannot both win |
| `PUT /api/mentorship/[id]` (reopen) | **nothing** — a `COMPLETED` relation could go back to `ACTIVE` beside another live one | 409, `exceptRelationId` excluding itself |
| `POST /api/register` (invitation auto-link, #51) | **nothing** — matched the `(mentorId, menteeId)` **pair** with no status filter, so pre-linking an existing mentee created a second `ACTIVE` relation *and notified the mentee* | no relation created, no "connected" notification, a `mentorship.autolink_skipped` ActivityLog entry and an admin notification |
| `POST /api/invite` | **nothing** | 409 at invite time, while the admin is still looking at the form |
| `POST /api/mentor/mentees` | no guard (safe only because the mentee row was three statements old) | account + relation in one transaction, with the assertion inside it |
| `src/lib/mergeUsers.ts` | **nothing** — re-pointing `menteeId` carried a duplicate's differently-mentored `ACTIVE` relation over *alongside* the primary's | refused with `active_mentor_conflict` (409), naming both mentors; nothing is written |
| `scripts/import-csv.mjs` | owner-scoped, no status filter — importing the same sheet as a second `--owner` added a second `ACTIVE` relation | the row is skipped, listed under `SKIPPED — already has an active mentor`, and the process exits 1 |

Seeders are clean by construction and stay that way: `prisma/seed-demo.mjs`
skips a mentee that already has any relation, and `scripts/seed-dummy.mjs`
truncates first and pairs only freshly created mentees.

### Why the merge refuses instead of closing one relation

Because stamping `completedAt` on the losing relation is not bookkeeping, it is
deciding who the mentee's mentor is — and it does five things the admin merging
two duplicate rows would never predict: it closes the post-mentorship
CV/document window (#854) on that mentor, flips the mentee's portal to an
archive and closes their own write actions, makes them certificate-eligible for
a mentorship that never finished, stops an in-flight dormant-first-contact
episode mid-way, and is irreversible. The losing relation is not a stub: it
carries interactions, goals, meetings, messages, evaluations, offers, questions
and stage history.

The resolution is human and cheap: one mentor closes their mentorship through
"Mark complete" on `/admin/mentorship`, which writes a real `StatusChange` and an
honest `completedAt`; then the merge runs clean. Nothing is lost by waiting — a
merge is never urgent. Same stance as the existing `linked_by_mentorship`
refusal five lines above it.

## What a violation costs

The dormant-first-contact nudge cap (`DORMANT_MAX_NUDGES = 2`) is spent on the
**relation**. A mentee with two `ACTIVE` relations therefore received **four**
"still interested?" e-mails out of two independent budgets — and the second one
already said we would not write again.
[`docs/dormant-first-contacts.md`](dormant-first-contacts.md) declares that
ceiling non-negotiable on sender-reputation grounds. `sendDormantCheckIns` now
also de-duplicates by person within a tick; that is a floor, not the fix. The
fix is the invariant.

## Reading the integrity report

The guards stop *new* violations and touch no existing rows, so the live data
has to be looked at. Three read paths, one shared query:

- **`GET /api/admin/relation-integrity`** — ADMIN-only, read-only JSON. Returns
  `clean`, `offendingMentees`, `extraRelations` (exactly the number of rows the
  future unique index would reject) and a group per mentee naming every `ACTIVE`
  relation with its mentor, `startDate`, stage, `dormantSince` and
  `dormantNudgeCount`. There is no `POST` on that route and there never should
  be: remediation is "Mark complete" on `/admin/mentorship`.
- **Every deploy** prints the same numbers:
  `prisma/check-active-mentor-duplicates.mjs` runs in the idempotent-backfill
  block of `infra/deploy-prod.sh`. It is a **detector, not a gate** — it never
  writes and always exits 0, with `|| true` on top, because a detector that can
  red a deploy is one that gets removed the first time it fires.
- **Locally / over SSH:** `npm run check:active-mentors`.

Clean output looks like
`check-active-mentors: OK — no mentee has more than one ACTIVE mentorship (N active relations checked).`

## Sequencing

**This order is load-bearing.**

1. **The guards deploy first** (this change). Reading a clean report before the
   back doors are closed proves nothing: a merge or an invitation can dirty the
   data the next day.
2. **Then read the report** — on production *and* on the shared preview, whose
   database is separate. Record both numbers.
3. **Then, and only then, add the constraint.** MySQL has no partial unique
   index, so the technique is a nullable `activeMenteeKey String?`
   (`= menteeId` while `ACTIVE`, `NULL` otherwise) with
   `@@unique([activeMenteeKey])`, since MySQL permits many `NULL`s. It needs an
   idempotent backfill of the same shape the deploy already runs for other
   columns.

Step 3 must not be folded into step 1. If the live database already holds a
mentee with two `ACTIVE` relations, adding the constraint makes
`prisma db push --accept-data-loss` **fail** — and that push is how this app
ships. A failed push is a failed deploy.

If the report comes back dirty, resolving it is a data decision (which mentor is
the real one?) only the maintainer can make, and it likely wants a small admin
surface first — a filter on `/admin/mentorship` listing mentees with more than
one `ACTIVE` relation — before the constraint PR, not after.

## What is *not* closed

The race is narrowed, not eliminated, and this document will not pretend
otherwise. MySQL InnoDB runs `REPEATABLE READ`, where a plain `SELECT` inside a
transaction is a consistent **non-locking** read: two concurrent transactions
can both see "no active mentor", both insert, and both commit. What the
transactions above do buy is atomicity (no half-state, and in the approval path
no request marked `APPROVED` with no relation behind it) and a read-to-write
window shrunk from several awaits to two adjacent statements. Only the unique
index — or an explicit `SELECT … FOR UPDATE` on the mentee's own row, which was
considered and deferred because the index supersedes it — makes two
simultaneous assignments of two different mentors genuinely impossible.
