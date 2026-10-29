# Affiliate module

Status: **first release** (Story #3111: #3112–#3119). Supersedes the first draft,
which hard-coded one customer's contract terms and was dropped.

An organisation runs a partner (affiliate) programme inside the CRM: partners bring
paying customers, the organisation records the customers' payments, the module
computes the partners' commissions from the organisation's own commission plan, and
the organisation pays them out by bank transfer. The module is generic. **No
organisation's rates, tiers, contract text or previous tooling appear in this
repository** (CLAUDE.md, "Tenant names never enter this repo"): they are data, entered
per organisation, and every number in tests and examples here is synthetic.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Where it runs | A module of the CRM, gated by the `affiliate` capability (MARKETING vertical). Every row carries `orgId`. |
| 2 | Commission rules | **A per-organisation commission plan (data)**, evaluated by one pure engine. The engine has no defaults that mirror a real contract. |
| 3 | Payment source | **Manual entry by an ADMIN** is the only source in the first milestone. It goes through the one payment writer that a later API import will also use (`source` = `MANUAL` / `API`). No commission is written anywhere else — except the one-off migration (`IMPORT`, below), which takes a previous system's history as recorded. |
| 4 | Attribution | An ADMIN links a customer (the customer's id on the product side, opaque here) to a partner by hand. Automatic attribution through the `affiliate:<code>` lead source (`src/lib/leadSourceName.ts`) is a later step. |
| 5 | Identity | Existing CRM sign-in, new `AFFILIATE` role. Partners moved from a previous system are **invited** (invitation / sign-in link); no password hash from another system is ever imported. |
| 6 | Referral codes | Permanent once issued, unique per organisation. A migrated partner keeps the exact code the previous system used (a number or a custom slug). |
| 7 | Payouts | Recorded and approved in the CRM; the bank transfer itself stays manual. |
| 8 | Contract | Each organisation writes its programme copy and partner contract (per locale). A changed contract bumps its version, and every partner must accept the current version before the portal or its API answers. |
| 9 | Clicks | Not migrated. New clicks, if recorded, store a keyed hash of the IP, never the raw address. |

## The commission plan

One plan per organisation, stored on `AffiliateProgramSettings` and edited at
`/admin/affiliates/settings` (`src/lib/affiliateProgramSettings.ts`, the one writer;
`PUT /api/admin/affiliate/settings/plan`). Reading takes `affiliate.read`
(ORG_ADMIN and OBSERVER), changing `affiliate.write` (ORG_ADMIN only, never while
impersonating). A PROGRAM_ADMIN has no access at all: its reach is its cohort and
company grants, and affiliate data belongs to neither — opening it would open the
whole organisation. The screens tell such an admin so instead of failing. **The currency is EUR only for now** — a product
decision for the first release; the engine is currency-agnostic and widening is
the one list `AFFILIATE_CURRENCIES`. A real plan change bumps `planVersion`, stamps
`planEffectiveAt`, is audited (`affiliate.plan.update`) and re-evaluates every
partner on the queue (see "Re-evaluation after a plan change"); an unchanged save is a no-op. Money is **integer minor units** with an ISO currency
(same rule as `Offer` / `ProgramCost`). Shape:

| Field | Meaning |
|---|---|
| `currency` | ISO 4217 code all amounts of the plan are in. |
| `tiers` | Ordered bands `{ upToMinor, commissionMinor }`. A customer's **first payment** picks the band: the first band whose `upToMinor` is ≥ the payment. `topCommissionMinor` applies above the last band. Bounds are inclusive and in minor units, so there is no gap between bands. |
| `percentBps` | Percent phase rate in basis points (100 = 1 %). `0` disables the percent phase. |
| `switchAtCustomer` | The Nth paying customer of a partner that switches the partner to the percent phase. Null = never switches. |
| `boundaryCustomer` | `TIER` or `PERCENT`: what the Nth customer's own first payment earns. |
| `windowMonths` | A customer's payments earn percent commission for this many months from that customer's first payment. Null = no limit. |
| `payoutDays` | Days after a payment by which its commission is due (shown to the admin, not enforced). |
| `afterNotice` | `STOP_ALL` (nothing accrues once a termination takes effect) or `RUN_OUT` (customers referred before it keep earning inside their window; nothing for customers referred after). |

**Engine semantics** (fixed, documented here, not configurable):

- Before the switch, each paying customer earns **one** tier commission, on its
  first payment. Later payments of that customer earn nothing before the switch.
- The switch instant is the first payment of the partner's `switchAtCustomer`-th
  paying customer. From then on, every payment received **at or after** that
  instant earns `percentBps` — for all of the partner's customers, the earlier ones
  included — inside each customer's window. Nothing is recomputed retroactively.
- A customer's ordinal is decided by **first-payment date**, not by entry order.
  The engine therefore judges a partner's **whole** history in one pass, and a
  back-dated entry is answered by running it again.
- A first payment of zero does not make a paying customer.
- Each commission records the plan version it was computed under.

## The writer and the reconciliation

`src/lib/affiliatePaymentWriter.ts` is the only code that creates a payment, or
creates, changes the amount of, or removes a commission (`recordAffiliatePayment`,
and `resyncPartnerCommissions` after a plan or termination change). **The one
exception is the migration** (`src/lib/affiliateMigration.ts`, "Migration from a
previous system"): it writes a previous system's payments and commissions once,
into an empty programme, as recorded (source `IMPORT`, kind `IMPORTED`), and the
writer never touches them afterwards. After a termination takes effect a partner
brings no new customer (`partner_terminated`); its known customers keep paying in. It locks the
partner row first (`SELECT … FOR UPDATE`), reads the customer again under the lock,
runs the engine over the partner's whole history, and lets the pure
`src/lib/affiliateCommissionSync.ts` decide the changes. Status changes (approve,
reject, pay) must take the same partner lock, so they never interleave with a
reconciliation.

- A commission that is `PENDING` **and** of the current plan version is a
  projection: it is created, updated or removed to match the engine.
- Everything else is **frozen**: `APPROVED`, `PAID`, `REJECTED`, and a `PENDING`
  row of an older plan version (so a plan change applies to what comes after it).
  A frozen row is never changed; when the engine disagrees, the writer returns the
  difference as **drift** for the admin to look at. There is no correction action
  in this release: a rejection is final (the screen confirms it with the count and
  the sum first), and an APPROVED row goes back to PENDING only by un-approving.
- A PENDING row of an older plan version whose payment was recorded AFTER the
  current plan took effect (a payment that raced a plan change) is live too: the
  next reconciliation recomputes it under the current plan.
- **A plan change is not retroactive.** `AffiliateProgramSettings.planEffectiveAt`
  stamps when the current version took effect. A payment *recorded* before it never
  gets a commission created by the new plan (what it would give is drift); a
  payment recorded after it is judged by the new plan, whatever its `receivedAt`.
- A payment must be in the plan's currency (`currency_mismatch` otherwise), so a
  mistyped currency never shifts a customer's first payment.
- A `SUSPENDED` partner gets no new payments; a terminated one is judged by
  `noticeEffectiveAt` and the plan's `afterNotice`.
- External references are stored trimmed and compared **case-insensitively** (the
  database collation): `INV-1` and `inv-1` are the same payment. Revisit before an
  API import whose ids differ only by case.
- Every guarded write must hit exactly the rows it planned, or the transaction is
  undone (`conflict`). Waiting too long for the lock, or a deadlock, answers `busy`
  (retry). Amounts are capped at the signed 32-bit column (`MAX_AMOUNT_MINOR`).

The engine is pure and dependency-free (`src/lib/affiliateCommissionRule.ts`) and
unit-tested with synthetic plans.

### Re-evaluation after a plan change (#3170)

A plan save returns as soon as the plan is committed, whatever the number of
partners. In the same transaction it writes `AffiliateProgramSettings.planResync`
(QUEUED, for the new version), and after the commit it enqueues the job
`affiliate.planResync` (keyed on the organisation and the version, 5 attempts).
The job (`src/lib/affiliatePlanResync.ts`; the state rules are pure in
`affiliatePlanResyncRule.ts`) walks the partners in id order, 100 at a time, each
through `resyncPartnerCommissions()`. The writer is still the only code that
touches a commission.

- **Checkpoint.** After every batch the state stores the last partner done
  (`cursor`), the counts (`total`, `done`, `failed`, `drift`), and the partners whose
  lock was busy (`retry`, at most 500; past that, `overflow` makes the next attempt
  walk everyone again). A rerun after a crash, a timeout or a redeploy resumes after
  the cursor.
- **Retries.** Partners still outstanding at the end of a pass mean the attempt
  throws, and the worker backs off. The next attempt judges exactly the retry list.
  On the last attempt the state ends INCOMPLETE: those partners are re-evaluated by
  their next payment write, as the writer always does.
- **Newer plan wins.** Every state write is guarded on the plan version. A job for an
  older version stops at its first write after a newer plan is saved.
- **At-least-once.** A second run over a partner changes nothing and reports the
  same drift.
- **Visible to the admin.** The settings API returns `planResync`, and the plan card
  follows it every 3 s while it is QUEUED, RUNNING or RETRYING. It shows the
  progress, then the result: re-evaluated, still failing, and the drift.

## Data model

All models carry `orgId` and are registered in `TENANT_MODELS`.

- **AffiliatePartner** — `userId` (1:1, null until the invitation is accepted),
  `code`, `displayName`, `contactEmail`, `status` (ACTIVE / SUSPENDED / TERMINATED),
  `noticeEffectiveAt`, sealed payout details (IBAN, holder).
- **AffiliateCustomer** — `partnerId`, `externalRef` (unique per org; shown to the
  partner, so a customer number — never a name or an address). Ordinals are not
  stored: the engine derives them from the payments every time.
- **AffiliatePayment** — `amountMinor`, `currency`, `receivedAt` (never in the
  future), `source` (MANUAL / API / IMPORT), `externalPaymentRef` (**required,
  unique per organisation**, so a double entry is caught even under a mistyped customer).
- **AffiliateCommission** — one per payment at most: `kind` (TIER / PERCENT, or
  IMPORTED for a migrated one),
  `amountMinor`, `accruedAt`, `dueAt`, `windowEndsAt`, `planVersion`, `status`
  (PENDING / APPROVED / PAID / REJECTED), `payoutId`.
- **AffiliatePayout** — a batch that marks commissions PAID; all-or-nothing; its
  day is never before a commission it pays accrued (`payout_before_accrual`).
- **AffiliateProgramSettings** — one per organisation: the commission plan (JSON,
  validated by `parseCommissionPlan`) and its `planVersion`, the referral base URL
  (`referralUrl`), landing copy, contract text and `contractVersion`. Without a
  valid plan the writer refuses payments.
- **InvitationToken.partnerId** — the partner an AFFILIATE invitation links to.
- **AffiliateContractAcceptance** — one row per partner and contract version.

## Admin screens

`/admin/affiliates` has one sidebar entry and its own tabs:

- **Overview** (`src/lib/affiliateOverview.ts`, `/api/admin/affiliate/overview`,
  #3173) — partners per state, referred customers, commission totals per status,
  payouts and the latest one, with shortcuts to the commissions waiting for approval
  (`/admin/affiliates/commissions?status=PENDING`) and to the approved ones to pay.
  The totals are the Commissions tab's own query and the latest payout is the Payouts
  tab's first row, so the screens cannot disagree. Six aggregate queries whatever the
  programme's size (an e2e counts them at 1 and 25 partners). While the plan, the
  contract or the first partner is missing it shows those setup steps.
  `affiliate.read` (OBSERVER included).
- **Settings** — the plan and the contract (above).
- **Partners** (`src/lib/affiliatePartners.ts`, `/api/admin/affiliate/partners`) —
  the list with customer counts and PENDING / APPROVED / PAID totals summed in SQL,
  a new partner (referral code: letters, digits, `-`, `_`, unique per organisation
  case-insensitively, permanent), and the state changes. Suspend / reactivate /
  terminate go through `changePartnerState()` in the payment writer: under the
  partner lock, re-evaluating the partner's commissions, audited
  (`affiliate.partner.state`). ACTIVE ↔ SUSPENDED freely; a termination needs its
  effective date (a calendar day, UTC midnight). **TERMINATED is final** (decided):
  no change leaves it, because clearing the date would pay the termination
  period's payments retroactively — a partner who returns gets a new record and
  code. Every calendar day the API takes (payment, payout, termination) goes
  through `parseCalendarDay()`, which refuses an impossible day (31 February)
  instead of rolling it into the next month. The full IBAN is revealed to an
  `affiliate.write` admin only, and every reveal is audited
  (`affiliate.payout_details.read`).
- **Payments** (`/api/admin/affiliate/payments`, list in `src/lib/affiliatePayments.ts`) —
  a manual entry goes straight to `recordAffiliatePayment()`; the currency is the
  plan's, the amount is typed as people write it (`19,99`) and sent as minor
  units, the received date is a calendar day (UTC midnight, up to +14 h ahead of
  UTC is still "today"). A new customer number needs its partner; a known one
  keeps its own. The list is newest first, paged, with the commission each
  payment got.
- **Commissions** (`/api/admin/affiliate/commissions`, list in
  `src/lib/affiliateCommissions.ts`) — by status, oldest due first, totals per
  status in SQL. `transitionCommissions()` (payment writer) approves
  (PENDING → APPROVED), rejects (PENDING → REJECTED) or un-approves
  (APPROVED → PENDING), at most 200 at a time, each partner's rows under that
  partner's lock by a guarded update on the expected status; anything else — a
  PAID row above all, another organisation's id — comes back as `skipped`. Each
  partner is its own transaction: one that fails (its lock busy) is reported in
  `failedPartners` and does not undo the others. One
  audit row per partner (`affiliate.commission.approve|reject|unapprove`).
  Every move is confirmed with its row count and sum; a rejection says it is
  final. `driftReport()` lists the frozen rows the current plan would calculate
  differently — read only, nothing written, the whole programme in three queries,
  and run only when the admin asks for it ("Check for differences").
- **Payouts** (`/api/admin/affiliate/payouts`, list in `src/lib/affiliatePayouts.ts`) —
  recorded after the manual bank transfer. The screen lists a partner's approved
  commissions unpaged (`/payouts/candidates`, up to the 200 a payout can take) and
  says when there are more, so the sum shown is always the rows selected. `createPayout()` (payment writer)
  takes ONE partner's selected commissions under its lock: all APPROVED, all that
  partner's, one currency — or nothing is written (`payout_mismatch`). The payout
  row carries their sum, the transfer day (a calendar day, not in the future) and
  an optional bank reference; the commissions become PAID with `payoutId` and
  `paidAt`, and stay frozen for good. Audited (`affiliate.payout.create`).

## Security

- `AFFILIATE` is covered by the 2FA policy (`TWO_FACTOR_ROLES`) and the partner
  shell carries the same server-side 2FA gate as every role shell. That gate is a
  page redirect and does not protect an API (true of every role today), so the one
  write that redirects money — `PUT /api/affiliate/me/payout-details` — checks the
  policy itself and answers `403 two_factor_required` to an un-enrolled partner.
  A step-up (password or code on every IBAN change) is a separate, later task.
- While an admin impersonates a partner, the partner's own declarations and money
  writes are refused (400 `impersonating`): accepting the contract and changing
  payout details — the same rule as `/api/account`.
- A partner never falls through to the mentee portal: `AFFILIATE_NAV_LINKS` is the
  web and native-app menu, the shared shell (`RoleShell`: /messages, /todos, …)
  sends a partner home, and `/mentors` admits the mentoring roles only.
- SSO: a returning user's role sync never touches an AFFILIATE (like ADMIN). In an
  organisation that enforces SSO, an external partner without an IdP account needs
  a password exemption to sign in — a product decision per organisation.
- Payout details (`src/lib/affiliatePayoutDetails.ts`, the one writer and reader)
  are validated by the ISO 13616 IBAN check (`src/lib/payoutDetailsRule.ts`),
  sealed with `secretBox` under a purpose bound to the organisation and the
  partner (a sealed value copied to another partner's row does not open), frozen
  while the partner is SUSPENDED (a guarded write, so a concurrent suspension wins), and every change
  sends the `payoutDetailsChanged` security notice (essential `account_security`
  group: no preference silences it) to the partner. The partner's API answers the
  last four characters only.
- Every money or contract write leaves one `AuditLog` row with its `orgId`, in the
  same transaction where there is one: `affiliate.payment.record`,
  `affiliate.commissions.resync`, `affiliate.contract.publish`,
  `affiliate.contract.accept`, `affiliate.payout_details.update`. No row carries
  an IBAN (the masked last four at most) or a person's data beyond ids.
  The admin screens add `affiliate.plan.update`, `affiliate.partner.create`,
  `affiliate.partner.state`, `affiliate.payout_details.read`,
  `affiliate.commission.approve|reject|unapprove`, `affiliate.payout.create`,
  `affiliate.referral_url.update`, `affiliate.partner.invite` and
  `affiliate.migration.run`; registration adds `affiliate.partner.account_linked`.
- Every partner API goes through `affiliatePartnerGate()` (`src/lib/affiliateContract.ts`):
  AFFILIATE only (403), inside a vertical with the `affiliate` module (403), the
  session's OWN partner record (404 without one — never taken from the request),
  and the current contract accepted (409 `contract_not_accepted`). Only
  `/api/affiliate/contract` (read the text, accept a version) skips the last check.
- Contract version (`saveContract`): texts are compared locale by locale in a fixed
  order (`src/lib/affiliateContractRule.ts`; the JSON column's key order is not
  stable, and line endings are normalised), so an unchanged save keeps the
  version. A change bumps it by a guarded update on the version that was read.
  Accepting needs the current version; accepting it twice is the same answer.
- One visibility rule for every read (`affiliateRowScope`): ADMIN the programme of
  their organisation, AFFILIATE their own partner's rows, anyone else nothing; a
  row outside it answers 404, never 403.
- Payout details: ADMIN reads them in full (manual transfers); the partner sees the
  last four characters.

## The partner's account

A partner exists before its account (the admin creates it, or a migration does).
`src/lib/affiliateInvite.ts` is the one writer of the link between the two:

- `POST /api/admin/affiliate/partners/[id]/invite` (`affiliate.write`) mints an
  `AFFILIATE` invitation through the shared `createInvitation()` — addressed to the
  partner's **contact e-mail** (a named invitation is what proves the mailbox) and
  carrying `InvitationToken.partnerId`. Only an ACTIVE partner without an account
  is invited (409 `already_linked` / `partner_inactive`, 400 `no_contact_email`,
  409 `email_taken` when the address already has an account in this product).
  A new invitation withdraws the partner's open ones (`revokedAt`) under the
  partner's row lock, in the transaction that mints it, so the newest mail holds
  the only live link; a partner leaving ACTIVE (`changePartnerState`) withdraws
  them too. The register link is returned to the admin only when the mail could
  not be sent. Audited (`affiliate.partner.invite`).
- The generic invitation board never resends a partner's invitation
  (`POST /api/invite/[id]` 409 `partner_invitation`, bulk `skippedPartner`): it
  answers any ADMIN tier with the live link, and that link opens an account that
  receives payouts — so it stays behind `affiliate.write`.
- `/api/register` accepts an `AFFILIATE` token only when it names a partner and an
  address. The account and `linkPartnerAccount()` run in ONE transaction; the link
  is a guarded write (`userId: null`, status ACTIVE), so a second token for the
  same partner, or a partner suspended since the mail, rolls the account back and
  answers 400. Audited (`affiliate.partner.account_linked`). The partner chooses
  their own password under the org's policy — nothing is imported.
- The invitation is world-bound like every other (`docs/worlds.md`): a token of a
  MARKETING organisation is unknown on any other host.

## The partner portal

`/affiliate` and its pages are server-rendered from the session: the partner is
never taken from the request. Every page except `/affiliate/contract` calls
`requirePortalPartner()` (`src/lib/affiliatePortal.ts`), which sends a partner who
has not accepted the current contract to the contract page; the API refuses the
same partner with 409 `contract_not_accepted`, so the page is a convenience, not
the check.

- **Home:** the referral link, the customer count and the totals per commission
  status, and a notice while the partnership is suspended or ending.
- **Referral link:** organisation data. `AffiliateProgramSettings.referralUrl`
  (admin settings, `PUT /api/admin/affiliate/settings/referral-url`, audited
  `affiliate.referral_url.update`) is an https base URL without credentials,
  fragment or its own `ref`; the link is that URL with `ref=<code>` set
  (`src/lib/affiliateReferralRule.ts`, unit-tested). Without one the portal shows
  the code alone.
- **Customers, commissions, payouts:** read through `src/lib/affiliatePartnerView.ts`,
  narrowed by `affiliateRowScope()` to the partner's own rows. A partner sees its
  customers' opaque references, payment amounts and dates, commissions and payouts
  (with the transfer reference) — never a payment's own reference, who entered a
  row, or another partner's rows. Another partner's payout page is 404.
- **Bank details:** entered on `/affiliate/payout-details` through the existing
  partner API (2FA policy, impersonation refusal, sealed, audited, announced); the
  stored IBAN is shown masked and never read back into the form.

## Migration from a previous system

An admin screen (`/admin/affiliates/migration`, `affiliate.write`) — not a script on
the server — so it runs on the shared import engine: `runAffiliateMigration()`
(`src/lib/affiliateMigration.ts`) passes the commissions file through `runImport`
and reads the partners and payouts files with the same parser; the rules are pure
in `src/lib/affiliateMigrationRule.ts` (unit-tested with synthetic files). A dry run
is the same call with a writer that does not write, and the screen offers the real
run only after a clean dry run of exactly the files it checked.

- **Input** — three CSV files (comma or semicolon, a header row). Partners:
  `code, name, paid_total, unpaid_total` (+ `email, status, ended_on`). Commissions:
  `partner_code, customer_ref, payment_ref, payment_amount, payment_date,
  commission_amount, status` (+ `due_date, payout_ref`). Payouts:
  `payout_ref, partner_code, amount, paid_date` (+ `bank_reference`). Amounts in
  euros in an unambiguous shape only (`1234`, `19,99`, `19.99`, `1.234,56`,
  `1,234.56`, `1 234,56`; three digits after a mark are a thousands group) —
  four decimals, an exponent, a sign or a letter is refused, because a wrong
  reading on both sides would still reconcile. Days `YYYY-MM-DD`. Files must be
  UTF-8 (the screen decodes strictly, the rule refuses U+FFFD): a Windows-1252
  export would collapse different names into one customer. Clicks are not migrated.
- **As recorded** — codes verbatim (compared like the database does: case- and
  accent-insensitive, ß = ss — `sameKey`); commissions keep
  their amount, status, due day and payout and are never recalculated: they are
  stored with kind `IMPORTED`, plan version 0, and their payments with source
  `IMPORT`, which the payment writer skips entirely (no update, no removal, no
  drift — `affiliateCommissionSync.ts`). Imported customers still count for the
  customer order, so the next new customer gets the right position in the plan.
- **Checks** — a PAID commission belongs to a payout of the same partner; a payout's
  amount is exactly the sum of its commissions; a customer belongs to one partner;
  no duplicate codes, payment or payout references.
- **Reconciliation** — per partner, the PAID sum and the PENDING + APPROVED sum
  equal `paid_total` / `unpaid_total` from the source, to the cent. Any issue
  blocks the whole migration.
- **All or nothing, once** — the set is one chunk and one transaction. It is
  refused into a programme that already holds partners or payments, checked again
  inside the transaction under a lock on the organisation row that
  `createPartner()` takes too; after writing, the transaction re-checks the
  reconciliation and every payout against what it wrote and rolls back on a
  difference. A refusal says why: `issues` (the files), `not_empty`,
  `reconciliation_failed`, `duplicate_ref` (two references the database treats
  as one) or `failed` (a timeout or lock wait — nothing to fix in the files).
  Audited (`affiliate.migration.run`, counts only).
- Partners are created without an account; the admin invites them afterwards
  (see "The partner's account").

## Milestone plan

| Step | Content |
|---|---|
| 1 | This document. |
| 2 | Commission plan + pure engine + unit tests (synthetic plans). |
| 3 | Data model, payment writer (lock, date-ordered ordinals, plan version, unique reference). |
| 4 | Role, 2FA, security notices, audit, contract acceptance in the API. |
| 5 | Admin screens: plan and contract settings, partners, payments, commissions, payouts. |
| 6 | Partner portal and invitations. |
| 7 | Migration screen with reconciliation. |
| 8 | Release fragment, `features.ts`, `@smoke` security specs, review, PR. |

Out of scope for this milestone: automatic payment import, automatic attribution,
automatic bank transfer, multi-level partners, click analytics.
