# Outbound approval — the outbox (#2960)

An organization that is just going live wants to be sure that **no automated mail
reaches a lead or a customer unseen**. With outbound approval on, every such mail
— a trial or deadline reminder, a "still interested?" check-in, a win-back mail,
the e-mail copy of a message, a meeting mail — becomes a **draft** in the outbox.
An operator previews it and then **sends it now**, **schedules** it or
**discards** it.

## The switch

`outboundApproval`, a per-org setting read through the settings chain
(`src/lib/settings.ts`):

| Value | Meaning |
|---|---|
| `off` (default) | Mail behaves exactly as it always has. |
| `lead_mail` | Automated mail to a lead, a customer or an account-less contact of the org is held. |

- **Default `off` for every org.** Merging this changes nothing for any tenant;
  switching an org on is a data step (`/admin/settings` → *Approve automated
  mail to leads and customers*, or a `Setting` row).
- **The sales vertical only.** The setting exists where there is a pipeline and
  no mentorship (`outboundApprovalApplies()`, the same rule as `/sales`):
  `PUT /api/admin/settings` refuses it anywhere else (`400 vertical_mismatch`),
  and the rule reads it as `off` in such a vertical whatever a row says.
- A stored value other than `off`/`lead_mail` (only writable by hand) reads as
  **on** — the safe side of a misspelt switch is a draft, not a mail.

## Which mail is held — the one rule

`outboundDecision()` in [`src/lib/outboundApprovalRule.ts`](../src/lib/outboundApprovalRule.ts),
pure and unit-tested (`scripts/test/outbound-approval-rule.test.mjs`). In order:

1. Approval off (or not applicable to the vertical) → send.
2. The mail belongs to no organization (an operator alert to the server's alert
   address) → send: there is no outbox for it to wait in.
3. The category is **exempt** → send.
4. The recipient is **staff** → send.
5. Everything else → **hold**, with the reason `held_lead`, `held_customer`,
   `held_contact` or `held_other`.

### Recipients

| Kind | Who | Held? |
|---|---|---|
| `staff` | an `ADMIN` or `MENTOR` (a sales rep) account of the org | never |
| `lead` | a `MENTEE` account — the person on a funnel record | yes |
| `customer` | a `COMPANY` account — a customer's login | yes |
| `contact` | an address with no account in the org (a company contact, an enquiry's sender, a meeting guest) | yes |
| `other` | any other role (`SOURCE` has no place in a sales org) | yes (fail safe) |

The recipient's own account decides the org when there is one; an address
without one belongs to the org the sender named (`orgId`). Address lookups use
the `(email, orgId)` pair — one world's row ([`docs/worlds.md`](worlds.md)).

### Categories

Every category the product sends is listed in `OUTBOUND_CATEGORIES` with its
reason; the unit test fails when a category of `src/lib/emailGroups.ts` has no
entry, so a new mail is a decision somebody makes. **Exempt** (still sent with
approval on):

- the essential `account_security` group — `verification`,
  `password-reset`, `invitation`, `account`, `security`, `ops-alert`, `test`
  and `consent` (the demo form's double-opt-in confirmation, triggered by the
  person themselves) — **except `retention-reminder`**: the "do you want to keep
  your data with us?" ask is a cron the person never triggered, sent to every
  lead past the retention limit, so it is held like any other automated mail to
  a lead (to staff it still goes at once);
- `mentor-application-received` — the acknowledgement of the person's own
  application.

The demo form has no separate "we got your request" acknowledgement today; the
enquiry mail (`company-inquiry`) goes to the org's admins, who are staff and
never held. **An unknown or missing category is held.**

### What the plan said, and what the code does

- *"A trial reminder for a lead becomes a draft."* Trial reminders today go to
  the record's **owner** (a sales rep, staff) — never to the lead — so they are
  not held. The rule holds the `stage-deadline` category whenever it **is**
  addressed to a lead, and the e2e spec drives `sendTrialReminderEmail()` to a
  lead to pin exactly that. The mails that really reach leads today are the
  check-ins (`dormant-check-in`), re-engagement and message / meeting mails.
- The e-mail copy of an in-app message (`message`, `mentor-direct`) is held
  too: the in-app message itself is delivered as always; only the product
  writing to a lead by mail on its own waits.

## The hook

One place, so every sender is covered without per-caller changes:
`sendEmail()` in `src/services/emailService.ts`, **after** `prepareEmail()` (the
opt-out gate, demo mode, no SMTP — an unsubscribed lead is not drafted at all)
and **before** the dispatch (inline send or the queue). `holdIfRequired()`
(`src/lib/outboundDrafts.ts`) answers in this order of cost: an exempt category
costs no query; then the org's vertical (memoised a minute); then the setting
(read live, so switching on holds the very next mail on every replica); then the
recipient.

`sendEmail()` returns **`'HELD'`** and writes an `EmailLog` row with status
`HELD` (once per draft). Callers that compare `!== 'SKIPPED'` — the digests, the
reminder ladders, the announcement fan-out — treat it as handled and stamp their
claim, so the next run does not ask again. When the decision cannot be made (the
database is down) the send **throws**, recorded `FAILED`: a mail to a lead never
leaves because the check failed.

## The safety net (#2970)

Approval decides which mail **waits**. Four smaller rules make sure that some
mail never even gets that far, and that a quiet launch stays quiet. All of them
apply whatever the org's `outboundApproval` value is.

| Net | Where | What it does |
|---|---|---|
| **No mail to a generated address** | `unmailableRecipient()` in `src/lib/mailDeliveryRule.ts` (pure, unit-tested), the first check of `prepareEmail()` | A stand-in lead address (`…@import.local`, written by the importer, an account event or a mentor for a lead with no known address) or an erased account's (`…@erased.local`) is not a mailbox. The mail is recorded `SKIPPED` with `Unmailable address: placeholder_address` / `erased_address` **before** the opt-out read, demo mode, the hold and the queue: never queued, never a draft somebody could approve, in every org and every category. A list (`a, b`) with one such address on it is refused whole. |
| **No dormant check-in outside mentorship** | `dormantCheckInApplies()` in `src/lib/salesSurface.ts`, read in `sendDormantCheckIns()` | The "are you still interested?" mail is an internship concept. In a vertical without `mentorship` the job skips the relation before it claims anything: no mail, no draft, no spent nudge. |
| **No stale decision-window bell** | `isDecisionWindowBellDue()` / `DECISION_WINDOW_STALE_DAYS` (7) in `src/lib/trialReminderRule.ts`, read in `ringDecisionWindows()` | A window that closed more than a week ago never rings — a historic or late-loaded record stays in the owner's queue but does not produce a reminder for something long past. |
| **A quieter trial expiry** | `expireTrials()` (`src/lib/jobs/trialReminders.ts`), `expiryRecordedAt()` | The automatic `TRIAL_ACTIVE → TRIAL_EXPIRED` history row is dated when the trial **ended** (strictly after the record's previous move, never in the future), not when the sweep noticed; its `AuditLog` rows carry the org's `orgId`. |

### Audit: what can reach the lead side of a MARKETING org

Every category the product sends is in `OUTBOUND_CATEGORIES` (the unit test
pins that `src/lib/emailGroups.ts` has no category without an entry). For a
recipient that is a lead (`MENTEE`), a customer login (`COMPANY`) or an
account-less contact of a MARKETING org, each one is either **exempt by
design** — the person or a staff member asked for it — or **held**:

| Category | With approval on | Why |
|---|---|---|
| `verification`, `password-reset`, `account` | sent | the person asked: their own sign-up, reset or sign-in link, an account change |
| `security` | sent | a security notice may never be silenced (docs/security-notices.md) |
| `invitation` | sent | an invitation is a staff member's deliberate act, never a cron |
| `consent` | sent | the demo form's double-opt-in confirmation, triggered by the person |
| `mentor-application-received` | sent | the acknowledgement of the person's own application |
| `ops-alert`, `test` | sent | staff addresses only (the server's alert address, the admin's own test) |
| `retention-reminder` | **held** | a cron's re-consent ask the person never triggered |
| every other category (deadlines, check-ins, re-engagement, digests, messages, meetings, pipeline notices, content, surveys, inbound copies) | **held** | automated mail, or the mail copy of something done in the app |
| an unknown or missing category | **held** | fail safe |

And none of them reaches a generated address at all (the first net above).

`e2e/mail-safety-net.spec.ts` pins it end to end: a synthetic MARKETING org
with approval on, a lead in every funnel stage, a customer login and a stand-in
lead; the daily crons are called directly (the `/api/cron` batch, the trial
sweep, report subscriptions, surveys, evaluations), and the spec asserts zero
`email.send` jobs and zero `SENT` / `DEFERRED` `EmailLog` rows for anybody on
the lead side — only `OutboundDraft` rows, and for the stand-in not even that.

## The draft — `OutboundDraft`

- `orgId` (registered in `TENANT_MODELS`), `category`, `lane`, `mailGroup`,
  `reason` (the rule's code), `trigger` (what produced it, rendered as a
  sentence: deadline, check-in, win-back, message, meeting, …), `rcpt` (sha256
  of the address), `recipientUserId` / `recipientCompanyId` when known.
- `box` (`LongText`: a message copy may carry 10 MB of attachments) — the whole prepared mail, **sealed** with `secretBox`
  (`'outbound-draft'`), like the mail queue's envelope. `summary` — a sealed
  copy of what the list shows (subject, display name, masked address). No
  address is ever in the clear on the row or in a log line.
- `dedupeKey`, unique per org: the sender's own key (`dedupeKeyFor()`) when it
  named one, else a hash of category + recipient + subject + UTC day + **body**
  (html, text and attachments). The same logical mail held twice is one draft,
  whatever its state — a discarded draft is a decision, not an invitation to ask
  again — while two different mails that share a subject on one day (two in-app
  messages to the same lead) are two drafts.
- `status`: `DRAFT` → `SENT` | `SCHEDULED` | `DISCARDED` | `EXPIRED`.
  `notAfter` = the sender's own deadline, capped at 14 days.

## Deciding

`applyDraftAction()` — the only way a held mail leaves:

| Action | Writes | Then |
|---|---|---|
| send now | `SENT` | `enqueueMail(…, { reason: 'approved', dedupeKey: 'draft:<id>' })` — the mail queue's drain delivers it |
| schedule | `SCHEDULED`, `scheduledFor` | the same, with `runAt` = the chosen time (the page converts the operator's local time; stored UTC). In the future, within 30 days, before the draft expires |
| discard | `DISCARDED`, `box` cleared | nothing is sent |

A mail whose attachments are over the queue's cap (`MAX_QUEUED_ATTACHMENT_BYTES`,
256 KB — a message copy with a photo, a newsletter with a large image) cannot
wait on the queue: **schedule** refuses it (`409 not_queueable`, the screen says
"send it now instead") and **send now** delivers it inline through the same
dispatch an ordinary send takes after the hook; a failed inline send undoes the
claim (`500 send_failed`) and the draft waits again.

A held newsletter copy is recorded `HELD` and counted with the skipped; when
its approved copy settles, `settleMailRef()` moves the record out of `HELD` and
the issue's tally from *skipped* to *sent* (or *failed*). Announcements report
held copies as `held`, not `emailed`; a held report-subscription mail is
recorded `SKIPPED` / `held_for_approval`, never `SENT`.

Each is **one guarded `updateMany` from `DRAFT`** with its `AuditLog` row
(`outbound_draft.send|schedule|discard`, the org's `orgId`) in the same
transaction, plus an `ActivityLog` row. A draft decided meanwhile answers `409`.
The queue job's idempotency key `draft:<id>` makes "exactly one mail per
approval" a database fact; if the queue refuses the mail, the claim is undone
and the draft is a `DRAFT` again. Once queued, the draft keeps no second copy of
the mail (`box` cleared, `jobId` set); withdrawing a scheduled mail is the mail
queue's own cancel. The drain re-runs the recipient's opt-out gate, as for any
queued mail.

Bulk: `POST /api/admin/outbox/bulk` (≤ 50 ids) runs the same action draft by
draft and answers `{ done, skipped[] }` with each skipped draft's reason code.

**Expiry**: the hourly mail tick (`initCronJobs`, `:05`) moves every `DRAFT`
past its `notAfter` to `EXPIRED` and deletes its mail (`expireDrafts()`).

## Who sees which draft

`visibleDraftsWhere()` is the one filter:

- **ADMIN** — every draft of their org (`/admin/outbox`).
- **MENTOR** (a sales rep, `/sales/outbox`) — the drafts addressed to a lead or
  an account they own **now** (an `ACTIVE` relation they are the owner of, by
  its lead or its company), so a handed-over lead's waiting mail moves with the
  lead and the previous owner loses it.
- Anybody else — nothing.

Another org's draft, or another rep's, answers **404** like a missing id —
reading and every action. The API lives under `/api/admin/outbox` and is the
second `/api/admin/*` family open to a MENTOR (the first is
`duplicates/check`); in a vertical with mentorship it answers `403
capability_unavailable`. Matrix: [`docs/role-access-matrix.md`](role-access-matrix.md)
§ the MARKETING sales rep; executable in `e2e/outbound-approval.spec.ts` and
`e2e/fixtures/authz-matrix.ts` → `OUTBOX_FOREIGN`.

## The screen

`src/components/outbox/OutboxPanel.tsx`, mounted at `/admin/outbox` (admins) and
`/sales/outbox` (reps): filter by status and type; each row shows the subject,
the recipient's name and masked address, the type, why it waits, when it was
held and when it expires; **preview** in an iframe with `srcdoc` and an
**empty `sandbox`** (no scripts, no same-origin, no forms, no navigation); send
now / schedule (date-time picker in the operator's own time zone, suggested the
next morning at 9:00) / discard; multi-select with bulk actions. The sidebar
link carries the pending count (`OutboxBadge`). The nav link is tagged
`withoutCapability: 'mentorship'` and the pages close themselves with
`gateOutboxPage()`.

## Retention and erasure

- `outboundDraft` retention entry (`src/lib/retentionEntries.ts`): decided
  drafts are deleted 30 days after their last change; a waiting draft is never
  touched (it expires first).
- Account erasure deletes every draft addressed to the account and every draft
  addressed to its address **inside its own org**; forgetting an account-less
  contact does the same for the requesting org (`forgetOutboundDrafts()`). An
  approved draft's queued copy (sent now and not yet drained, or scheduled) is
  deleted with it, by the `jobId` the approval recorded.
  Another world's drafts for the same address are untouched by construction.
