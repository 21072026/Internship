# Metering — what we count, and what we deliberately do not

Issue: **#1750** · Code: `src/lib/meteringRules.ts` (the rule) ·
`src/lib/metering.ts` (the queries) · `src/lib/jobs/usageRollup.ts` (the nightly job) ·
`UsageRollup` in `prisma/schema.prisma` (the ledger)

There is **exactly one billing meter in this repo**. If you are about to write a second
count of "active pairs", stop: the number below goes on an invoice, and a number with two
implementations has two values the first time somebody argues about it.

## The billable unit

> **A relation in ACTIVE state with any logged activity in the calendar month; paused,
> benched and completed pairs are not counted.**

That is the sentence we publish on the pricing page, it is the header comment of
`src/lib/meteringRules.ts`, and it is exported as `ACTIVE_MATCHED_PAIR_DEFINITION` so a
screen renders the same words the code enforces. Every clause is load-bearing:

| Clause | How the code makes it true |
|--------|----------------------------|
| **ACTIVE state** | `BILLABLE_RELATION_STATES` — an **allowlist**. A lifecycle state added later (`PAUSED`, `BENCHED`) is non-billable the moment it exists; making one billable is that one array and nothing else. |
| **any logged activity** | At least one row in any of the seven per-relation signals below, inside the month. One query with `some` filters, not seven round trips. |
| **calendar month** | UTC month boundaries from `periodRange(period)`, half-open `[gte, lt)`. Nobody computes their own month, so nobody drifts the invoice by a timezone — and no row lands in two months or in none. |
| **completed not counted** | Falls out of the allowlist; a COMPLETED pair with plenty of activity is still not billed. |

**Dormancy is not special-cased, on purpose.** `dormantSince`
(`docs/dormant-first-contacts.md`) marks a first contact that has gone quiet — and a quiet
relation has no activity row in the month, which the definition already excludes. The meter
contains no reference to dormancy in either direction: a dormant pair that comes back to
life is billable again the moment something is logged against it.

### The activity signals

`ACTIVITY_SIGNALS` in `meteringRules.ts`, each naming the timestamp column that says *when*:

| Signal | Column | Note |
|--------|--------|------|
| `InteractionLog` | `date` | The date the interaction **happened**, not when it was typed: Friday's conversation logged on Monday belongs to Friday's month. |
| `Message` | `createdAt` | Relation-stamped messages only. A pair that talks solely in a group/project thread is counted through its other signals — the same boundary `lib/lastContactRule.ts` draws. |
| `Meeting` | `createdAt` | |
| `MeetingRequest` | `createdAt` | |
| `StatusChange` | `createdAt` | A stage move is activity. |
| `WeeklyReport` | `createdAt` | |
| `Goal` | `createdAt` | |

## The metrics

| Metric | Kind | What it is |
|--------|------|-----------|
| `ACTIVE_MATCHED_PAIRS` | COMPUTED | The billable unit above. |
| `ADMIN_SEATS` | COMPUTED | Active `ADMIN` users of the org. The second metered number a customer sees, from the same file as the first. |
| `VIDEO_ROOM` | COUNTER | Video rooms created in the period. |
| `VIDEO_PARTICIPANT` | COUNTER | Invitees the created rooms were for — the JaaS MAU exposure. |
| `ACTIVE_PAIR_ACTIVITY` | COUNTER | Activity signals logged against a relation. **Volume, not the pair count**: one pair can raise it fifty times in a month and is still one billable pair. |

**COMPUTED vs COUNTER is the idempotency guarantee**, not a taxonomy:

* **COMPUTED** — recomputed from the domain tables by the nightly rollup and written
  **absolutely** (`setUsage`). Re-running a closed period writes the same value onto the
  same row, so a re-run can neither double-count nor leave a second row behind.
* **COUNTER** — incremented at the moment the thing happens (`recordUsage`), because a
  room created last Tuesday cannot be recounted afterwards. The rollup never touches
  these; an increment is not idempotent.

`setUsage()` refuses a counter and `recordUsage()` refuses a computed metric, so the two
cannot be crossed by accident.

## The ledger and the nightly rollup

`UsageRollup` holds **one row per `(orgId, metric, period)`** — unique in the schema, which
is what makes "exactly one row" a database guarantee rather than a convention. `period` is
`'YYYY-MM'`. It carries `orgId` and is registered in `TENANT_MODELS`
(`docs/tenant-isolation.md`): one tenant reading another's usage is a commercial leak.

`runUsageRollup()` (02:40 UTC, registered from `/api/cron/start` next to the other
scheduled jobs; also runnable now via `GET /api/cron?job=usage-rollup` as an ADMIN)
recomputes every COMPUTED metric for **every tenant**, for the **open month and the one
before it**. The previous month is re-read because activity is still being *logged* into it
(a backdated `InteractionLog.date` is exactly that case), and because the first run of a new
month would otherwise freeze the old one at whatever the last nightly tick happened to see.

It is a **plain handler**: `node-cron` is only the carrier until the leader-elected
scheduler (#1676) lands, when this becomes a queue handler and the timer goes away with the
other twelve. `runUsageRollup()` is the handler either way.

**A request path must never compute the pair count.** The definition is a scan across seven
activity tables; a usage screen or an invoice reads `UsageRollup`.

## Video is reported, never gated

JaaS MAU is a metered allowance and *every* participant of a JaaS room counts against it, so
the 1:1-only routing in `src/lib/meetingRoom.ts` is a guess at protecting it.
`generateMeetingLink()` — the one chokepoint every room creation passes through — now counts
`VIDEO_ROOM` and `VIDEO_PARTICIPANT` so the exposure is a number instead of a guess.

This is **reporting only**, and that is a product rule, not an implementation detail:
meetings and video are part of the free core. Nothing here refuses a call, changes the
JaaS/public-instance routing, or returns a 403. The counter is fire-and-forget and swallows
its own failures — a meter must not be able to fail somebody's meeting. A room created with
no resolvable tenant is simply not counted.

## What we deliberately do **not** meter

* **Mentor seats** and **mentee seats** — the mentor/mentee loop is free, permanently. Metering
  it would be the first step towards charging for it.
* **Programs / projects / cohorts** — structure, not usage. A tenant reorganising its
  programmes must never change its bill.
* **Messages, meetings, video minutes, storage** — usage, but not *billable* usage. Video
  volume is counted for **cost visibility** (above), not to charge for it.
* **Logins, page views, notifications** — presence is not activity; the activity report
  (`lib/activityReport.ts`) is where presence belongs.

## Adding a metric

1. Add it to `USAGE_METRICS` in `src/lib/meteringRules.ts` with its kind and one sentence
   saying what it is.
2. COUNTER → call `recordUsage()` at the one place the thing happens. COMPUTED → add a
   branch to `computeMetric()` in `src/lib/jobs/usageRollup.ts`; `COMPUTED_METRICS` is
   derived from the catalogue, so a missing branch throws instead of silently writing zero.
3. Extend `scripts/test/metering.test.mjs` (`npm run test:metering`) — the pure rule and
   the catalogue are unit-tested because none of the ways of getting them wrong are visible
   in a browser.
4. Document it in the table above. A metric a customer can see and nobody wrote down is a
   support ticket.
