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
  When a back-dated first payment changes the order, the writer re-evaluates the
  affected partner's not-yet-paid commissions in the same transaction; a commission
  already `PAID` is never changed (a correction is a separate adjustment the admin
  records).
- A first payment of zero does not make a paying customer.
- Each commission records the plan version it was computed under. A plan change
  applies to payments received after it.

The engine is pure and dependency-free (`src/lib/affiliateCommissionRule.ts`) and
unit-tested with synthetic plans.

## Data model

All models carry `orgId` and are registered in `TENANT_MODELS`.

- **AffiliatePartner** — `userId` (1:1), `code`, `status` (ACTIVE / SUSPENDED /
  TERMINATED), `noticeEffectiveAt`, sealed payout details (IBAN, holder). A partner
  that is not ACTIVE accrues nothing new, and a SUSPENDED one cannot change payout
  details.
- **AffiliateCustomer** — `partnerId`, `externalRef` (unique per org),
  `firstPaymentAt`, `firstPaymentMinor`, `payingCustomerOrdinal`.
- **AffiliatePayment** — `amountMinor`, `currency`, `receivedAt` (never in the
  future), `source`, `externalPaymentRef` (**required, unique per organisation**, so a
  double entry is caught even under a mistyped customer).
- **AffiliateCommission** — `kind` (TIER / PERCENT), `amountMinor`, `accruedAt`,
  `windowEndsAt`, `planVersion`, `status` (PENDING / APPROVED / PAID / REJECTED),
  `payoutId`. Never edited once PAID.
- **AffiliatePayout** — a batch that marks commissions PAID; all-or-nothing.
- **AffiliateProgramSettings** — landing copy, contract text, `contractVersion`, the
  commission plan and its `planVersion`.
- **AffiliateContractAcceptance** — one row per partner and contract version.

## Security

- `AFFILIATE` is covered by the 2FA policy (`TWO_FACTOR_ROLES`) and the partner
  shell carries the same server-side 2FA gate as every role shell.
- Changing payout details sends a security notice (`sendSecurityNotice`) and writes
  an `AuditLog` row. So do payment entries, commission status changes and payouts.
- The contract-acceptance check runs in the API handlers, not only in the layout.
- Contract version: texts are compared locale by locale in a fixed order (the JSON
  column's key order is not stable), and the bump is a guarded update on the
  version that was read.
- One visibility rule for every read; a partner asking for another partner's row
  gets 404.
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
