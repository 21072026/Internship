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

The trial epic (#2392 and friends) adds three stages to `MARKETING_FUNNEL`, **on-path**,
between qualification and the proposal:

```
LEAD_NEW → LEAD_CONTACTED → LEAD_QUALIFIED → TRIAL_ACTIVE → TRIAL_EXPIRED → DEAL_PROPOSAL
         → DEAL_NEGOTIATION → DEAL_WON | DEAL_LOST
```

`TRIAL_EXPIRED` is on-path, not off-path: an expired trial is a deal that still has to be
chased, and an off-path stage stops the SLA clock and demands a drop-off reason. A sibling
PR adds the three keys; nothing in this slice hardcodes them.

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
   `role: 'MENTEE'`, `companyId` set to the account. That is exactly the record the
   mentor-entered mentee (`POST /api/mentor/mentees`) and the public application
   (`POST /api/apply`) already mint; see `src/lib/menteeAccount.ts`.
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
without a person cannot exist. The criterion's *intent* — an import must not hand a
merchant's phone contact an authentication identity — is met in full and is enforced, not
merely intended:

- the row's `password` is a sentinel, so `bcrypt.compare` can never succeed;
- no invitation and no "set your password" mail is ever sent by the import;
- `isPendingActivation()` already recognises the sentinel, so the account shows in the UI
  as a record, not as a user who can sign in;
- nothing in the import writes `emailVerified`, a session, or a trusted device.

The alternative — a `Contact` table plus a nullable `contactId` on the relation — is a new
carrier for the person half of the funnel and was rejected for the same reason as a second
pipeline carrier. `Company.contactName/contactEmail/contactPhone` (#2407) still land, so an
account **without** a funnel record keeps its "who do we call" without any `User` at all.
