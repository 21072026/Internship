# Affiliate module

Status: **design, not yet built.** Branch `feat/affiliate-module`.

The CRM gains an affiliate program as one of its modules. Its first goal is to
reproduce the program that runs today on the marketing site's WordPress plugin,
with the same rules and the same data, so the plugin can be retired without
changing what partners earn. Nothing here changes the contract text; the
contract is the source of truth for the rules.

## Decisions taken

| # | Question | Decision |
|---|---|---|
| 1 | Scope | Affiliate programme only. The landing page and the partner contract page stay on the marketing site and link into the module. |
| 2 | Commission rules | **As the contract states**, not the plugin's defaults (see "The contract rules" below). |
| 3 | Payment source | **Manual entry is the only source today**, and the marketing product has no paid-status data to pull yet. The manual entry goes through the **same writer** a future API import will use (`AffiliatePayment`, `source` = `MANUAL` / `API`). No commission is ever written outside that writer. Designed in from the first commit, not added later. |
| 4 | Identity | Existing CRM sign-in. A new `AFFILIATE` role for partners; admins stay `ADMIN`. |
| 5 | Passwords | **Revised (mentor's proposal, pending approval):** a one-time check on first sign-in. The WordPress password hash is imported for that purpose only. A partner who enters the correct old password gets a "set a new password" screen; a wrong one gets the normal reset flow. The old hash is deleted once the partner has set a new password. Any hash never used in that check is purged **90 days after import** (a common retention window for migrated credentials; no formal standard sets it). This is still a password-equivalent secret, so it needs the same rate limit as sign-in and must never be logged. |
| 6 | Referral links | `?ref=<code>` keeps working for every existing partner, with the same codes. Codes are permanent. |
| 7 | Suspicious accounts | Not migrated automatically. Listed for manual review. |
| 8 | Click data | IP addresses are **hashed** (keyed hash, never stored raw). Everything else is kept as is. |
| 9 | Bank details | Stored by default, handled like any other personal data (see "Data"). |
| 10 | Payouts | Recorded and approved in the CRM. The bank transfer itself stays manual. |
| 11 | Migration | Default: old URLs redirect to the new module, the plugin is switched off only after the reconciliation in "Migration" passes. |
| 12 | Naming | Code uses the generic word **affiliate**. The marketing product's name lives only in organisation settings and data, never in code, tests or docs (CLAUDE.md, "Tenant names never enter this repo"). |
| 13 | Placement | A module inside the CRM, its own organisation (`orgId`) per tenant. The marketing product is a customer of the CRM, not a part of it. |

## The contract rules

These come from the partner contract. They are the rule, and the pure module
`src/lib/affiliateCommissionRule.ts` (to be written, dependency-free, unit-tested)
is the only place they are computed.

1. **Commission base.** 20 % of the amount the referred customer actually pays,
   for at most 24 months from that customer's first payment.
2. **Before the tenth paying customer** (per partner): one fixed commission,
   chosen by the customer's **first monthly payment**:

   | First payment | Commission |
   |---|---|
   | up to €20 | €50 |
   | €21 – €50 | €100 |
   | €51 – €100 | €150 |
   | above €100 | €250 |

3. **From the tenth paying customer on:** 20 % of every future payment of every
   referred customer, including the first nine. Not retroactive: only payments
   received after the tenth customer's first payment count.
4. **Payout:** within 14 days of the customer payment arriving.
5. **Customer benefit:** 2 months free, then 4 months at 20 % off. Handled by the
   marketing product; the CRM only needs to know the customer's start date.
6. **Termination:** 30 days' written notice. Earned commissions stay payable for
   their own 24-month window; nothing new accrues after the notice takes effect.

Money is stored as **integer minor units** with an ISO currency code, never a
float (same rule as `Offer` and `ProgramCost`).

## Known conflicts with today's plugin (to be resolved by the contract, not the plugin)

| Plugin today | Contract | Consequence |
|---|---|---|
| Flat €150 per sign-up (default rate) | Tiered by first payment | Sign-up referrals must not auto-accrue €150 |
| Pro rank: 25 % | 20 % | Pro is not a separate rate under the contract |
| Pro rank threshold: 4 referrals | 10 paying customers | Threshold changes from referral count to paying-customer count |
| Rank "Pro" not applied to a partner with 5 referrals | Not applicable | Ranks are computed, never set by hand |

Existing data is migrated as recorded. Existing commission amounts are not
recalculated retroactively without an explicit decision.

## Data model (planned)

All tenant models get an `orgId` and an entry in `TENANT_MODELS`
(`src/lib/orgContext.ts`).

- **AffiliatePartner**: `id`, `orgId`, `userId` (one-to-one), `code` (the
  `?ref=` value, unique per org), `rank`, `status` (ACTIVE / SUSPENDED /
  TERMINATED), `contractAcceptedAt`, `noticeEffectiveAt`, timestamps.
- **AffiliateCustomer**: a referred customer from the marketing product.
  `partnerId`, `externalRef` (the customer's id on the marketing side),
  `startedAt`, `firstPaymentMinor`, `currency`, `paidCustomerOrdinal` (1, 2, …
  set when the first payment lands, which decides the tier and the 10-customer
  switch).
- **AffiliatePayment**: a payment received from a referred customer. `customerId`,
  `amountMinor`, `currency`, `receivedAt`, `source` (`MANUAL` for now, `API` later).
  Idempotent on `(customerId, externalPaymentRef)`.
- **AffiliateCommission**: the accrued amount. `partnerId`, `paymentId` or
  `customerId` (for tier commissions), `kind` (TIER / PERCENT), `amountMinor`,
  `currency`, `accruedAt`, `windowEndsAt` (24 months), `status`
  (PENDING / APPROVED / PAID / REJECTED), `paidAt`. One row per accrual, never
  edited in place once PAID.
- **AffiliatePayout**: a batch that marks commissions PAID. `partnerId`,
  `amountMinor`, `method` (`BANK_TRANSFER`), `paidAt`, `paidBy`, `reference`.
- **AffiliateClick**: `partnerId`, `ipHash`, `landingPath`, `referrerHost`,
  `browserFamily`, `createdAt`. No raw IP, no full user-agent, no query string.

Bank details live on `AffiliatePartner` (or a 1:1 `AffiliatePayoutDetail`) as
**encrypted at rest**, readable by ADMIN in the payout screen only.

## Sign-up and the `affiliate:<code>` source

`src/lib/leadSourceName.ts` already turns an account event's `reference` into a
Source named `affiliate:<code>`. The module reuses that mapping: an account event
carrying a partner's code attaches the lead to that partner's record, and no
second code-to-partner mapping is written.

## Permissions

| Role | Can |
|---|---|
| ADMIN | Manage partners, rates, customers, payments, commissions, payouts |
| AFFILIATE | See own link, clicks (aggregated), customers, commissions and payouts; edit own payout details |
| MENTOR, MENTEE, COMPANY, SOURCE | Nothing in this module |

Every read goes through one visibility rule, the same way `visibleApplicationsWhere()`
works. A partner who asks for another partner's row gets 404, not 403.

## Migration

1. **Export** from the plugin: affiliates CSV, referrals CSV, clicks CSV, payouts
   CSV, settings XML (all available in the plugin's Export/Import screen).
2. **Map** plugin affiliate IDs to `AffiliatePartner`, plugin user IDs to CRM
   users. Codes are copied verbatim.
3. **Import** as recorded, referrals become commissions with their recorded
   amounts and `paidAt` where the plugin says PAID.
4. **Reconcile** the totals against the plugin: per partner, paid and unpaid
   amounts must match to the cent. The migration does not finish until they do.
5. **Redirect** the old `?ref=` and affiliate-portal URLs, then switch the plugin off.

The migration script is a one-off in `prisma/`, with a dry-run default, and
works on synthetic data in development (CLAUDE.md, "Develop on synthetic data only").

## Out of scope for the first milestone

- Automatic payment pull from the marketing product (later, behind the same
  `AffiliatePayment` writer).
- Automatic bank transfer.
- Multi-level (MLM) partners. The plugin has the matrix feature; no partner uses it.

## Open items

- The partner contract page has no acceptance record today. The module records
  `contractAcceptedAt` on the first login after go-live; whether existing partners
  must re-accept is a business decision, not a technical one.
- IP hashing key: a per-org secret held outside the repo.
- Bank details (IBAN) are visible to ADMIN, because the admin makes the
  transfers by hand. Nobody else reads them. Partners edit their own details.
  Decided, not open.
- The tenth paying customer's first payment is paid as a percent commission,
  not a tier. The contract's "ab dem zehnten" can also be read as the tenth
  customer still getting the tier. Pinned by a test in
  `scripts/test/affiliate-commission-rule.test.mjs`; change needs the business
  decision first.
- A first payment of exactly 0.00 is not a paying customer. Customers with two
  free months only count when the first real payment lands.
- Decision 5 (one-time password check) is approved. Unused imported hashes are
  purged 90 days after import. Still open: whether partners get a reminder before
  that deadline (a mail through `sendEmail()`, its category decided then).
- Amounts with cents between two tier bands (e.g. 20.50) fall into the higher
  band, because the contract states whole-euro bounds only.

## Implementation status

- `src/lib/affiliateCommissionRule.ts`: the contract's commission rule, pure
  (tiers, 20 %, 10-customer switch, 24-month window, termination). Integer cents.
- `scripts/test/affiliate-commission-rule.test.mjs`: 12 unit tests, passing.
- `prisma/schema.prisma`: six tenant models (partner, customer, payment,
  commission, payout, click), registered in `TENANT_MODELS`. The `AFFILIATE`
  role is deliberately not added yet: it changes the role unions in
  notifications and registration and gets its own change.
- `src/lib/affiliatePaymentPlan.ts`: pure plan for one payment (which rows to
  create or update). `scripts/test/affiliate-payment-plan.test.mjs`: 11 tests.
- `src/lib/affiliatePaymentWriter.ts`: the one writer. It locks the partner row
  (`SELECT … FOR UPDATE`), reads the facts, applies the plan. Covered by an
  end-to-end spec later, not by unit tests.
- Every payment needs an external reference, manual entries included. Without
  it a double entry could not be detected.
- Not yet: admin and partner screens, the AFFILIATE role, migration.

## Per-organisation programme page and contract

Decided with the maintainer (decisions 14 and 15):

- **14. One host per organisation.** Each organisation's programme lives on its own
  public host (`Organization.publicHost`). The host decides which copy and contract a
  visitor sees; it never widens what data anyone may read. A host in `MARKETING_HOSTS`
  is required for the marketing product to open there.
- **14a. Copy and contract are tenant data.** `AffiliateProgramSettings` holds the
  sign-in copy (`/affiliate/signin`) and the partner contract (`/affiliate/contract`),
  per locale. The organisation edits them at `/admin/affiliates/settings`. No
  organisation's wording is written into the repository.
- **15. Re-acceptance on change.** Saving a changed contract bumps `contractVersion`.
  Every partner must accept the current version before the portal opens. Acceptance
  is recorded per partner and version (`AffiliateContractAcceptance`).
- The portal refuses a host that belongs to another organisation, so a partner of one
  programme cannot open another's portal by visiting its host.

Open: a marketing sign-in finds an account by e-mail within the marketing world, not
within the host's organisation. Two marketing organisations sharing an e-mail address
would be ambiguous. Not yet handled; the rule belongs in `src/lib/userWorld.ts`.
