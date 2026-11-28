# What a marketing funnel record IS (epic #2348, open decision 1)

**Status: the default for the whole marketing backlog. The cost owner can still overturn
it** — this is the answer the implementation proceeds on, not a vote that has been taken.
Everything below is what every slice of epics 01–09 assumes; overturning it is a
deliberate, costed change, not a detail a single PR may quietly differ on.

The inherited backlog (`21072026/Marketing`) was written for a separate product with its
own `Customer`, `Contact`, `Deal` and `LifecycleStage`. Epic #2348 turned that product into
a **vertical of this core** (`Organization.vertical = "MARKETING"`). That leaves exactly one
question the backlog cannot answer for itself: *which row in this schema is a funnel record?*

## The decision

| The marketing concept | The row it is here | Why |
| --- | --- | --- |
| **Account** (a merchant) | `Company` | Already the master-data record for an organisation you do business with: name, industry, address, and — since #2405/#2407 — `vatId`, `country`, `contactName`/`contactEmail`/`contactPhone`. It is registered in `TENANT_MODELS`, it is what `/admin/companies` shows, and the MARKETING vertical carries the `companies` capability. |
| **Funnel record** (this account's journey) | `MentorshipRelation` | The **only** pipeline carrier in the tree. The board, `PipelineStage`, `StageSla`, the aging report, `StatusChange`, the stage clock, the drop-off reasons and the metering rules all key off it. A second carrier means re-teaching every one of them. |
| **Lead person** (who we talk to) | `User` with role `MENTEE` | The relation's `menteeId` is a required FK, `Role` is frozen (#2348), and MENTEE is the side of a relation a lead occupies. It is also the entity the shipped **Leads** list already renders. |
| **Owner** (the marketer) | the relation's `mentorId` | Not a new role: "owner" is any `User` of the org. |

So a MARKETING funnel record is:

```
MentorshipRelation { mentorId = owner, menteeId = lead person, companyId = account }
```

and its stage is `pipelineStatus`, a key of the org's own `PipelineStage` rows — seeded from
the `MARKETING_FUNNEL` preset (`src/lib/programTemplates.ts`), never a canonical
`APPLICATION_100`-family key.

## Trial stages

The trial epic (#2392 and friends) added **two** stages to `MARKETING_FUNNEL`, **on-path**,
between qualification and the proposal — shipped in #2518 (issue #2413); the preset is
`src/lib/programTemplates.ts:546-570` and the two keys are spelled once, in
`src/lib/trialReminderRule.ts:89` (`TRIAL_ACTIVE_STAGE_KEY`) and `:97`
(`TRIAL_EXPIRED_STAGE_KEY`):

```
LEAD_NEW → LEAD_CONTACTED → LEAD_QUALIFIED → TRIAL_ACTIVE → TRIAL_EXPIRED → DEAL_WON | DEAL_LOST
```

`TRIAL_EXPIRED` is on-path, not off-path: an expired trial is a deal that still has to be
chased, and an off-path stage stops the SLA clock and demands a drop-off reason. No TypeScript
source outside those two constants spells the keys; the one deliberate mirror is the plain-ESM
demo seeder `prisma/seed-demo-marketing.mjs` (`:93-94`, reused at `:154-161`, `:236-241` and `:417-419`),
which cannot import the TS constants. `TRIAL_ACTIVE` deliberately carries no SLA
and `TRIAL_EXPIRED` a 7-day one (3 until #2840) (`src/lib/programTemplates.ts:573-591`).

How long a trial runs is the tenant product's rule, not this repo's. The `trialLengthDays`
org setting (default 30) models the free period; the decision window after it is
`TRIAL_EXPIRED`, ending `trialEndsAt` + the `decisionWindowDays` org setting (default
`DEFAULT_DECISION_WINDOW_DAYS` = 30, `src/lib/trialReminderRule.ts`; #2843, #2927). A source
system that knows the real dates sends them (the import's
`trial_ends_at` column, the account-event ingest) and they win over the default.

## Around the trial and after `DEAL_WON` (#2572 — decided 2026-10-07)

What happens around the trial and **after** `DEAL_WON` (active / notice given / churned /
won back), the preset without `DEAL_PROPOSAL`/`DEAL_NEGOTIATION`, and which stage existing
paying customers are imported at (#2555) are decided in [`funnel-decision.md`](funnel-decision.md)
(option C), with the implementation issues linked there.

## What this decision rules OUT

- **A second pipeline carrier.** No `Deal`, no `Opportunity`, no `pipelineStatus` on
  `Company`. A row that carries a stage and is not a `MentorshipRelation` is invisible to
  the board, the SLA clock, the aging report and the funnel KPIs.
- **A Company-level stage history.** Stage history is `StatusChange`, keyed on
  `relationId`. Not a `StatusChange.companyId` variant and not a small separate table: the
  account does not move, the funnel record does, and everything that reads history already
  reads `StatusChange` (`src/lib/stageClock.ts`, `src/lib/stageAging.ts`).
  An account with two funnel records over time therefore has two chains — which is
  correct: they are two journeys, chained through `previousRelationId` when one continues
  the other (`docs/mentor-transfer.md`).
- **A `LifecycleStage` enum.** Stages are per-tenant rows since #747. `npm run
  check:stage-keys` is the guard.
- **A new role.** `Role` is `ADMIN | MENTOR | MENTEE | COMPANY | SOURCE` and stays that way.

## The uncomfortable part, stated plainly

The MARKETING vertical does **not** carry the `mentorship` capability
(`src/lib/verticals.ts`), and a marketing funnel record is a row in a table called
`MentorshipRelation`. That is deliberate and it is not a contradiction:

- A **capability is a module** — the mentor shell, the mentee portal, the evaluation
  cycle, the "my mentees" navigation. Switching `mentorship` off hides those screens and
  refuses writes to those APIs. It says nothing about which table the pipeline lives in.
- The vertical carries `pipeline`, and the pipeline's storage has been
  `MentorshipRelation.pipelineStatus` since #747. Renaming the table (or adding a parallel
  one) to make the noun fit the vertical would touch every read path in the product to buy
  a nicer word.

The naming debt is real and is tracked as its own question, not smuggled into a feature PR.

## What an importer or an ingest must do

Anything that puts an account **on the funnel** needs a person, because `menteeId` is a
required FK. So:

1. Create (or find) the lead `User` from the row's **primary contact**: password-less
   (`NO_LOGIN_PASSWORD` — a sentinel `bcrypt.compare` can never match), never invited,
   `role: 'MENTEE'`, `companyId` set to the account, and — the part that actually makes it
   a record rather than a login — on a **generated stand-in address** on
   `PLACEHOLDER_EMAIL_DOMAIN` (`import.local`), not the merchant's mailbox. See the next
   section for why the sentinel alone is not enough. An existing person is reused under
   whichever address they already carry, real or stand-in; only a *creation* generates one.
2. A row with **no primary contact** gets its `Company` written and the stage **skipped**,
   with a row-level warning. Losing the account because nobody typed a contact would be
   the worse failure, and inventing a placeholder person would put a fake human in the
   Leads list.
3. Every relation write goes through `src/lib/activeMentorship.ts` (one mentee, at most
   one ACTIVE mentor — #419) and every stage write through `src/lib/stageChange.ts`.

`src/lib/marketingImport.ts` + `src/lib/marketingImportStore.ts` are the worked example;
the column contract is [`docs/marketing-import.md`](../marketing-import.md).

## The known cost of "the lead person is a User row"

`#2407`'s acceptance criterion reads "no `User` row is created by the import". Taken
literally that is unimplementable together with "the account is placed on the funnel":
`MentorshipRelation.menteeId` is a required foreign key to `User`, so a funnel record
without a person cannot exist. So the import creates one `User` per placed row, and the
question is what is actually enforced about it.

**The sentinel password alone is not the guarantee.** `src/lib/menteeAccount.ts` says a
record like this can never sign in because "every recovery path is a dead end … that mail
goes to the stand-in address" — and it is the *address*, not the password, that makes the
dead end. `POST /api/auth/forgot` mails a reset link to **any** existing user and
`POST /api/auth/reset` consumes it and writes a bcrypt hash; neither asks
`isPendingActivation()`. A bulk import onto merchants' real mailboxes would therefore mint
one claimable MENTEE login per contact — people who never asked for a portal account.

So the criterion's *intent* — an import must not hand a merchant's phone contact an
authentication identity — is met this way, and this is the full list of what enforces it:

- the lead's `email` is a **generated stand-in** on `import.local`, a domain that does not
  resolve, so `/api/auth/forgot` has nowhere to mail. It is derived from the contact
  address **and the organisation id** (`leadStandInEmail`), so the same contact resolves to
  the same lead on every run and two tenants importing one contact do not collide on the
  globally-unique `User.email`;
- the merchant's real address is not lost — it is written to `Company.contactEmail`, which
  is where #2407 asks for it, next to `contactName`/`contactPhone`;
- the row's `password` is a sentinel, so `bcrypt.compare` can never succeed;
- no invitation and no "set your password" mail is ever sent by the import;
- `isPendingActivation()` recognises the sentinel and `isPlaceholderEmail()` the address,
  so the row shows in the UI as a record, and a mentor who decides this person *should*
  have a login corrects the address through `PATCH /api/mentor/mentees/[id]` — the
  documented path for exactly these rows;
- nothing in the import writes `emailVerified`, a session, or a trusted device.

What is **not** enforced, and is left to the endpoints' own issue: `/api/auth/forgot` and
`/api/auth/reset` still do not check `isPendingActivation()`, so any record created
elsewhere on a real address (`POST /api/apply` is the largest source) remains claimable.
That is pre-existing and deliberate there — an applicant needs to set a password — and is
not something this importer changes either way.

The alternative — a `Contact` table plus a nullable `contactId` on the relation — is a new
carrier for the person half of the funnel and was rejected for the same reason as a second
pipeline carrier. `Company.contactName/contactEmail/contactPhone` (#2407) still land, so an
account **without** a funnel record keeps its "who do we call" without any `User` at all.

## The lead's contact (#3655)

The lead page's contact card shows the **account's primary contact** — the four
`Company.contact*` columns (name, position, e-mail, phone) — never the lead row's
`@import.local` stand-in address (`shownEmail()`, `src/lib/leadEmail.ts`). With no
account contact it falls back to the lead row's name and phone, and shows no address.

The record's rep corrects it in place (`PATCH /api/sales/leads/[id]/contact`, one
writer: `src/lib/salesLeadContact.ts`):

- **Who:** the record's own rep (MENTOR, or an ADMIN in sales mode); an admin
  holding `company.write` for any record of the tenant. Another rep's record,
  another tenant's and an unknown id are the same 404; an OBSERVER is 403.
- **What moves:** the account's four contact columns, and in the same transaction
  the lead row's `fullName` and `phone` (the page heading, the board card and the
  Klaviyo phone matcher read them). **Never `User.email`** — a login address is not
  a rep's to change.
- **One writer for the account's columns:** `writePrimaryContactTx()` in
  `src/lib/companyContacts.ts`, inside the request's transaction — the same row
  lock as a concurrent "make primary" (#2442) and the same duplicate test against
  the account's address book: an address another contact holds is
  `409 duplicate_email`. The admin address-book route's primary edit goes
  through the same function.
- **Audit:** `sales.lead.contact.update` with the account id, the names of the
  changed account fields (`changed`) and of the synced lead-row fields
  (`leadRow`), never their values. The lead row is compared on its own: a
  contact that was already right still brings a stale heading back in step. A
  save that changes neither writes nothing.
- **Nothing is sent.** Phase 1 of the sales CRM manages lead data only; a
  correction mails nobody. Contact permission stays bound to its address
  (`docs/contact-permission.md`): a new address starts with no basis.
- **Feeds:** the Klaviyo sync and the account import fill an empty contact column
  but do not overwrite a typed-in one (`src/lib/externalSyncPolicy.ts`), so a
  correction survives the next sync.
- A record without an account has no contact to correct: no editor, `409 no_account`.

## The sales dispatcher (#3656)

A sales team lead who is not an org admin. An ORG_ADMIN marks a sales rep as
**lead dispatcher** on `/admin/users` (`POST /api/admin/users/[id]/sales-dispatcher`,
`user.write`, never while impersonating, audited `sales.dispatcher_granted` /
`sales.dispatcher_revoked`). From then on that rep works the **whole tenant's
sales book** as each record's owner would.

- **One rule, owner-level.** `User.salesDispatcher` is effective only for an
  active MENTOR of an org whose vertical has the sales surface
  (`effectiveSalesDispatcher()`, `src/lib/salesDispatcher.ts`); on an INTERNSHIP
  mentor, an admin or a lead it is inert. `actorFromSession()` carries the
  effective value, and `dispatcherCovers()` (`src/lib/authzRule.ts`, via
  `dispatcherMay()` in `src/lib/authz.ts`) answers "may act on a record of this
  org as its owner" — own org only, impersonated → reads only.
- **An owner, never an admin.** The dispatcher is deliberately NOT in
  `decide()`: routes read `can(…, 'relation.write' | 'program.read' |
  'pipeline.transition')` as "is an admin" — admin-only fields (record kind,
  re-pointing a record at an account), stage gates set to `pipeline.transition`,
  relation creation, the admin timeline view. Those stay admin-only. Routes add
  `dispatcherMay(actor, permission, relation.orgId)` next to their OWNER check:
  `PUT /api/mentorship/[id]`, interactions, trial, contract end, win-back, value,
  the hand-off and the lead contact (`PATCH /api/sales/leads/[id]/contact`).
- **Reads.** The relation scope (`src/lib/authzScope.ts`) gives a dispatcher the
  whole tenant, like an ORG_ADMIN; `scopeForRole` still adds the org. The sales
  board then shows every rep's records, each card naming its owner, and the
  hand-off strip lets the dispatcher take a lead too. `/sales/leads/[id]` opens
  any record of the tenant for a dispatcher. `/sales` and `/sales/accounts` stay
  the dispatcher's own book.
- **Ends with the account.** Deactivating the user or changing their role
  clears the flag (`PATCH /api/users/[id]`), so a reactivation brings nothing
  back; the users list offers "remove" on any row still carrying it.
- **Live.** The flag is read on every request: a revoke takes effect on the
  dispatcher's next request; no session is revoked.

## Closing hand-offs to a person (#3979)

An ORG_ADMIN may stop colleagues from handing leads to someone — a person who
only manages, or who is away for a while — on `/admin/users` ("Close lead
hand-offs", `POST /api/admin/users/[id]/lead-handoffs`, `user.write`, never
while impersonating, audited `sales.handoffs_closed` / `sales.handoffs_opened`).
`User.acceptsLeadHandoffs` (default `true`) carries it.

- **One rule.** `mayReceiveHandoff()` (`src/lib/leadHandoffRule.ts`): closed
  means no colleague may hand them a lead, but taking a lead onto your OWN book
  stays yours to do. `GET /api/sales/team` answers it per member as
  `acceptsHandoffs`; `handOffLead()` refuses a closed recipient with
  `409 recipient_not_accepting` before anything moves — for a rep, the
  dispatcher and an admin alike.
- **The board.** The dialog's colleague list leaves them out. On the strip they
  stay only where a name is also the owner filter (#3906), dashed and marked
  "no hand-offs", and are not a drop target; elsewhere they are not on it.
- **Their own book is untouched**: their records stay with them and may still
  be handed on to someone else. New-lead ownership (the default owner, the
  hand-typed lead, the import) is a different door and does not read the flag.

## "Assigned to you" (#3874)

A record that came to a rep from someone else is listed first on `/sales` and as
a one-line strip above the columns on `/sales/board`, until the rep opens it.
Three nullable columns on `MentorshipRelation` carry it:

- **Written** by the two paths that put a record on someone else's book:
  `transferMentorship()` (both modes, so the board's hand-off and the admin's
  transfer alike) and the admin's `POST /api/mentorship`. Each sets
  `assignedAt`, `assignedById` (the actor) and clears `assignmentSeenAt`.
  A pool claim and a lead the rep typed in are the rep's own doing and write
  nothing; neither does a bulk import.
- **Read** by `src/lib/assignedToYou.ts` only: own, `ACTIVE`, in the tenant,
  `assignedAt` set, `assignmentSeenAt` null, `assignedById` not the viewer.
  Rows from before the columns read as seen, so the rollout shows no one an old
  book as "new".
- **Cleared** when the owner opens `/sales/leads/[id]`
  (`markAssignmentSeen`, one conditional `updateMany`) — not when an admin or a
  colleague reads it, and not under impersonation.

## What the next step is (#3900)

A follow-up is a day and a note (`nextActionAt`, `nextActionNote`, the rule in
`src/lib/nextActionRule.ts`) and, since #3900, **what kind of step it is**:
`nextActionType` — `call` | `email` | `meeting` | `demo` | `other`, the
hand-off's quick picks (`HANDOFF_ACTIONS`, `src/lib/leadHandoffRule.ts`), or
null when nobody said.

- **Written with the note, by every follow-up writer.** The hand-off stores its
  pick (a kept step keeps its own); an owner's edit through
  `PUT /api/mentorship/[id]` stores the `nextActionType` it sends, else reads it
  from the new note's label (`nextActionTypeFor`). A day-only edit leaves it.
- **Cleared with the step.** `nextActionPatch` clears it whenever the day and the
  note are both cleared ("Complete", "Clear"), whatever the caller sent.
- **Not carried** to a successor record and **stripped** with the note
  (`stripNextActionFor`), exactly like the other follow-up columns.
- **Older rows** are typed by the deploy backfill
  `prisma/backfill-next-action-type.mjs` (registry `0039`) from the label a
  hand-off wrote into the note — a plain-ESM mirror of the app's reading,
  pinned to the dictionary and to the TS rule by
  `scripts/test/next-action-type.test.mjs`. A free-text note stays untyped.
- **Readers prefer the column** and fall back to the note's label
  (`followUpInteractionType`), so a row the backfill has not reached reads as
  before.

A hand-off still composes the label into the note ("Telefonla aranacak: …"), so
e-mails, the attention queue and older readers keep reading it; the sales
follow-up panel reads the column instead (#3903, below).

## One follow-up form (#3903)

The hand-off dialog and the lead page's follow-up panel render the **same
editor**, `src/components/FollowUpFields.tsx`: *what* is next (the hand-off's
picks), *when* (Today · Tomorrow · 3 days · 1 week · 2 weeks, or a day, plus the
optional time of #3901) and the words. Controlled and presentation-only — each
screen keeps its own write (`POST /api/sales/leads/[id]/handoff`,
`PUT /api/mentorship/[id]`).

- **One rule.** `other` IS the words, so it needs some: `followUpNoteMissing()`
  (`leadHandoffRule.ts`) in both forms, and `PUT /api/mentorship/[id]` answers
  `400 note_required` for `nextActionType: 'other'` with no note sent or stored —
  the same code the hand-off route gives.
- **The panel writes the pick as `nextActionType` and the words alone.** It does
  not compose a label into the note. On read, the sales lead page passes the
  note through `handoffNoteText()` (every locale's labels, longest first), so a
  hand-off's "Call: ask about pricing" shows as the pick **Call** — in the
  reader's language, from the column — and the words "ask about pricing". Saved
  again from the panel, the note becomes the words alone; the pick stays in the
  column. A saved step with no pick opens as `other` (free words), a new one as
  a call.
- **Only the sales panel offers the picks** (`actionPicks`). The internship
  follow-up (admin candidates, mentor mentees) keeps day, time and note.

## When: a day, and optionally a time (#3901)

Interactions and follow-ups both learnt a time of day, in two different ways,
because they are two different kinds of date.

**An interaction is an instant.** The log form asks for date *and* time
(`datetime-local`, defaulting to the moment the form opens) in the person's own
zone and sends the instant; `interactionInstant()` (`src/lib/interactionSchema.ts`)
stores it. A log sent as a bare day (`2026-11-24` — the older forms, imports,
`PUT /api/interactions/[id]` from a date field) is still stored as UTC midnight,
and the app keeps reading "exactly UTC midnight" as *a day with no time*
(`isDayOnly`, `src/lib/relativeTime.ts`) — no column and no backfill, since every
row written before #3901 is already such a midnight. Those rows render as their
day: the sales interactions card shows "yesterday" without a time, the admin
timeline shows the date in UTC, never an invented "01:00". An instant that lands
on UTC midnight to the millisecond is moved by 1 ms on write so it keeps its time.

**A follow-up stays a day.** `nextActionAt` is still the calendar day the
reminder and the attention queue count, in UTC, exactly as `nextActionRule.ts`
argues. The optional time is a separate `nextActionTime` column, `"HH:MM"` as
the owner typed it — a *wall time*, not an instant. Folding it into
`nextActionAt` would make "Thursday 00:30" typed in Berlin a Wednesday in UTC and
fire the reminder a day early. So the time:

- never moves the day, never re-arms or delays the reminder, and never makes a
  step due or overdue earlier or later (those stay per day);
- orders a day's steps — untimed ("some time that day") first, then by time
  (`compareNextActions`, and `orderBy: [nextActionAt, nextActionTime]` in the
  sales calendar);
- is shown as typed, beside the day: the follow-up panel, the hand-off dialog's
  "current follow-up" line, the sales calendar. It is not converted per viewer —
  it is the owner's own schedule;
- is cleared with the day, and dropped when sent without one;
- travels with "keep the follow-up" on a hand-off, and a new hand-off step may
  carry one (`dueAt`).

The subscribed calendar feed (`/api/calendar/feed/[token]`) still publishes a
follow-up as its day: a wall time without a zone is not an instant an external
calendar can place, and the feed has no zone of the owner to read.

## After a call: one answer, at most one record (#3904)

Dialling a lead from its page (the contact card's `tel:` link) or from the
WhatsApp/Call buttons elsewhere asks how it went — `src/components/ContactActions.tsx`:

| Answer | Writes | Follow-up |
|---|---|---|
| **Reached** | one `Call` / `WhatsApp` interaction (the note typed in the small form, else "Phone call") through `POST /api/interactions` — the only path the first-contact advance and its Undo toast (#3746) follow | "Complete the follow-up" (shown when one is open; ticked when the open step is a call) clears it with `nextActionCompleted` → history `COMPLETED`; "Set the next follow-up" opens the shared editor (#3903) and writes the new step in the same save |
| **Not reached** | one attempt (`outcome = NOT_REACHED`, #3902): no contact, no stage move | stays; Tomorrow / In 2 days / a day and time moves only its day (step and words stay) |
| **Didn't call** | nothing — a mis-tap or a change of mind | untouched |

"Add a note" is gone: the note lives inside "Reached", so a contact and the
follow-up it completes no longer produce two interactions. The follow-up controls
render only where the page passes the record's follow-up (`followUp`, the
owner's view of a sales lead); the mentor and admin pages ask the same question
without them. The interaction is written first; a follow-up write that fails
after it says so ("The contact was logged, but the follow-up was not updated")
rather than un-saying the contact. The e-mail link's "Did you send it?" is out
of scope.

## E-mail templates on a lead (#3908)

The sales team's ready-made mails live in the same pool as the composer's
canned replies — `MessageTemplate`, managed on `/admin/message-templates` — with
a `channel` column (#3908): `message` (the composer's; every older row, the
column's default) or `email`. An e-mail template also stores a subject per
locale (`subjects`). The admin screen has one tab per channel; the pickers ask
for theirs (`GET /api/message-templates?channel=email`, default `message`, so the
composer never sees a mail template). Both routes are tenant-scoped like the
rest of the pool: another org's template is never offered.

On the lead page a picker sits under the contact's e-mail address. Choosing a
template turns the address link into a `mailto:` with the subject and the text
filled in — in the **rep's** language (`resolveMessageTemplateText`: they send
it under their own name), placeholders `{name}` (the contact), `{company}`
(the account) and `{sender}` (the rep) filled, a missing value left empty,
every part percent-encoded and line breaks as CRLF (`emailTemplateMailto()`,
`src/lib/messageTemplates.ts`). The CRM still sends nothing: the rep's own mail
program does (#3741). Opening the link logs the e-mail as before and counts the
template's use (the pool sorts by it). The texts themselves are the team's
data, written on the admin screen; nothing curated ships in the repo.

## Images on a follow-up (#3931)

A follow-up — set in the panel or written by a hand-off — may carry up to three
images (a pasted screenshot: "look at this screen"). `FollowUpImage` holds the
bytes; the rules are `src/lib/followUpImageRule.ts`, the Prisma half
`src/lib/followUpImages.ts`. Images only for now (PNG, JPEG, WebP, GIF, read
from the bytes, never the name), at most 5 MB each.

- **Two steps.** `POST /api/mentorship/[id]/follow-up-images` stores a
  **draft**; the follow-up write that names it attaches it —
  `PUT /api/mentorship/[id]` with `nextActionImageIds` (the set the form holds:
  named current images stay, the caller's own drafts are attached, current ones
  not named are cleared), or the hand-off's `imageIds`. A write may attach only
  the caller's own drafts on that record (`unknown_image` otherwise). A draft
  nobody attached within 24 h is deleted on its uploader's next upload; no job.
- **Cleared, not deleted.** Clearing or completing the follow-up, or a hand-off
  with a new step, sets `clearedAt`: the image leaves the panel and stays in the
  record's history (`GET …/follow-up-images` → `current` / `history`). A kept
  hand-off moves the images to the new record with the follow-up.
- **Who reads.** Whoever reads the follow-up note (owner, admin —
  `canSeeNextAction`) and whoever may write it (+ the sales dispatcher); a
  draft only its uploader. `GET /api/follow-up-images/[id]` serves the bytes
  `no-store`, `nosniff`, under a `sandbox` CSP. Another rep, the lead and
  another org get the same 404.
- **Personal data.** The lead's erasure deletes the images of their records
  (`accountErasure.ts`, beside the follow-up lines it blanks); an uploader's
  erasure only drops `uploaderId`. Like the follow-up note they are the owner's
  working material and are not in the account export.

**The UI (#3932).** The shared follow-up form (`FollowUpFields`) takes an image
strip (`FollowUpImagePicker`, `src/components/FollowUpImages.tsx`): "Add image"
or Ctrl+V into the note — a pasted screenshot is uploaded as a draft at once and
the note text is left alone. The sales follow-up panel and the hand-off dialog
use it; saving sends the ids the form holds. The panel's reading view shows the
current images, and each history line shows the images it set (matched by
`imagesByEvent()`: the step-setting event the image was attached with). Every
thumbnail opens in the app's `ImageLightbox`, never a new tab. The "Reached"
form's next follow-up (#3904) has no images yet.
