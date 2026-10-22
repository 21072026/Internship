# Affiliate module

Status: **in development** on `feat/affiliate-module-v2`. Supersedes the first
draft (`feat/affiliate-module`), which hard-coded one customer's contract terms.

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
| 3 | Payment source | **Manual entry by an ADMIN** is the only source in the first milestone. It goes through the one payment writer that a later API import will also use (`source` = `MANUAL` / `API`). No commission is written anywhere else. |
| 4 | Attribution | An ADMIN links a customer (the customer's id on the product side, opaque here) to a partner by hand. Automatic attribution through the `affiliate:<code>` lead source (`src/lib/leadSourceName.ts`) is a later step. |
| 5 | Identity | Existing CRM sign-in, new `AFFILIATE` role. Partners moved from a previous system are **invited** (invitation / sign-in link); no password hash from another system is ever imported. |
| 6 | Referral codes | Permanent once issued, unique per organisation. A migrated partner keeps the exact code the previous system used (a number or a custom slug). |
| 7 | Payouts | Recorded and approved in the CRM; the bank transfer itself stays manual. |
| 8 | Contract | Each organisation writes its programme copy and partner contract (per locale). A changed contract bumps its version, and every partner must accept the current version before the portal or its API answers. |
| 9 | Clicks | Not migrated. New clicks, if recorded, store a keyed hash of the IP, never the raw address. |

## The commission plan

One plan per organisation, stored on `AffiliateProgramSettings` and edited at
`/admin/affiliates/settings`. Money is **integer minor units** with an ISO currency
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
and `resyncPartnerCommissions` after a plan or termination change). It locks the
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
  difference as **drift** for the admin to look at. A correction is a separate,
  explicit admin action.
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

## Data model

All models carry `orgId` and are registered in `TENANT_MODELS`.

- **AffiliatePartner** — `userId` (1:1, null until the invitation is accepted),
  `code`, `displayName`, `contactEmail`, `status` (ACTIVE / SUSPENDED / TERMINATED),
  `noticeEffectiveAt`, sealed payout details (IBAN, holder).
- **AffiliateCustomer** — `partnerId`, `externalRef` (unique per org). Ordinals are
  not stored: the engine derives them from the payments every time.
- **AffiliatePayment** — `amountMinor`, `currency`, `receivedAt` (never in the
  future), `source`, `externalPaymentRef` (**required, unique per organisation**, so a
  double entry is caught even under a mistyped customer).
- **AffiliateCommission** — one per payment at most: `kind` (TIER / PERCENT),
  `amountMinor`, `accruedAt`, `dueAt`, `windowEndsAt`, `planVersion`, `status`
  (PENDING / APPROVED / PAID / REJECTED), `payoutId`.
- **AffiliatePayout** — a batch that marks commissions PAID; all-or-nothing.
- **AffiliateProgramSettings** — one per organisation: the commission plan (JSON,
  validated by `parseCommissionPlan`) and its `planVersion`, landing copy, contract
  text and `contractVersion`. Without a valid plan the writer refuses payments.
- **AffiliateContractAcceptance** — one row per partner and contract version.

## Security

- `AFFILIATE` is covered by the 2FA policy (`TWO_FACTOR_ROLES`) and the partner
  shell carries the same server-side 2FA gate as every role shell.
- Payout details (`src/lib/affiliatePayoutDetails.ts`, the one writer and reader)
  are validated by the ISO 13616 IBAN check (`src/lib/payoutDetailsRule.ts`),
  sealed with `secretBox`, frozen while the partner is SUSPENDED, and every change
  sends the `payoutDetailsChanged` security notice (essential `account_security`
  group: no preference silences it) to the partner. The partner's API answers the
  last four characters only.
- Every money or contract write leaves one `AuditLog` row with its `orgId`, in the
  same transaction where there is one: `affiliate.payment.record`,
  `affiliate.commissions.resync`, `affiliate.contract.publish`,
  `affiliate.contract.accept`, `affiliate.payout_details.update`. No row carries
  an IBAN (the masked last four at most) or a person's data beyond ids.
  Commission status changes and payouts will add theirs with the admin screens.
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

## Migration from a previous system

A one-off script under `prisma/`, dry-run by default, developed against synthetic
data. Input: CSV exports of partners, commissions and payouts. Codes are copied
verbatim. Commissions are imported **as recorded** (amount, status, paid date);
nothing is recalculated. The import is not complete until, per partner, paid and
unpaid totals match the source to the cent. Partners then receive an invitation.

## Milestone plan

| Step | Content |
|---|---|
| 1 | This document. |
| 2 | Commission plan + pure engine + unit tests (synthetic plans). |
| 3 | Data model, payment writer (lock, date-ordered ordinals, plan version, unique reference). |
| 4 | Role, 2FA, security notices, audit, contract acceptance in the API. |
| 5 | Admin screens: plan and contract settings, customers, payments, commissions, payouts. |
| 6 | Partner portal and invitations. |
| 7 | Migration script with reconciliation. |
| 8 | Release fragment, `features.ts`, `@smoke` security specs, review, PR. |

Out of scope for this milestone: automatic payment import, automatic attribution,
automatic bank transfer, multi-level partners, click analytics.
