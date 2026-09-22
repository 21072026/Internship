# The marketing account import: the column contract (#2404 / story #2391)

The marketing team's customer base still lives in a spreadsheet. This is the written
contract for turning that file into accounts and funnel records: which column is required,
in what format, and which field it lands in. Without it the same file is interpreted
differently on every run.

- **The engine** is the shared one — `runImport({ parse, validate, resolve, apply })` and
  the shared delimited parser in `src/lib/importPreview.ts`, the same ones the roster feed
  runs on ([`roster-feed.md`](roster-feed.md)). There is no second parser and no second
  dry-run engine in this tree.
- **The hooks** are `src/lib/marketingImport.ts` (pure: the contract, the match key, the
  diff) and `src/lib/marketingImportStore.ts` (the only Prisma-aware half).
- **The CLI** is `npm run import:marketing-accounts`.
- **What a row becomes** is [`marketing-vertical/pipeline-record.md`](marketing-vertical/pipeline-record.md):
  account = `Company`, funnel record = `MentorshipRelation`, lead person = a `MENTEE` `User`.
- **A sample file with all four edge cases**: `scripts/fixtures/marketing-accounts-sample.csv`.

## There is no tenant column

**One run imports into exactly one organisation: the one that owns `--owner`.** The
organisation is never a column, and no header spelling of "org", "tenant" or "mandant" is
accepted — a unit test asserts it. A spreadsheet that could name a tenant would be a
cross-tenant write whose only authorisation is a cell someone typed
([`tenant-isolation.md`](tenant-isolation.md)).

For the same reason, `owner_email` is **not** a marketing-specific role. `Role` is frozen
(`ADMIN | MENTOR | MENTEE | COMPANY | SOURCE`, `prisma/schema.prisma`); an owner is any
existing `ADMIN` or `MENTOR` **of that same organisation**.

## File format

Anything the shared parser reads: `,` `;` `\t` or `|` (sniffed from the header line, or
forced with `--delimiter`), CRLF, a UTF-8 BOM, quoted fields with embedded newlines and
`""` as an escaped quote. A German Excel export works unchanged.

Header matching is **case- and whitespace-insensitive**, and each column accepts a few
aliases (below), so `E-Mail`, `email ` and `contact_email` are one column.

## The columns

Only `name` is required. Everything else may be blank, and a blank cell means *"this file
has no opinion"* — it never blanks a value that is already stored.

Every length below comes from `src/lib/textLimits.ts` (the one source of truth, #1433) and is
checked per field: a value past its cap is a row-level `ERROR`, never a silent truncation.

| Column (aliases) | Req. | Format | Lands in |
| --- | --- | --- | --- |
| `name` (`company`, `firma`, `firma adi`) | **yes** | free text, ≤ 191 chars | `Company.name` |
| `legal_name` (`legal name`, `firmenname`) | no | free text, ≤ 191 | *nothing yet* — see "Columns with no home" |
| `country` (`land`, `ulke`) | no | **ISO-3166-1 alpha-2**, e.g. `DE`, `TR`, `AT`; stored upper case | `Company.country`, and the lead's `User.country` |
| `city` (`stadt`, `sehir`) | no | free text, ≤ 191 | the lead's `User.city` (there is no `Company.city` column) |
| `vat_id` (`vat`, `ustid`, `vergi no`) | no | as written; matched with separators and case removed (`DE 123.456-789` = `de123456789`); ≥ 4 alphanumerics, ≤ 64 | `Company.vatId` |
| `website` (`url`, `web`) | no | free text, ≤ 191 | *nothing yet* |
| `industry` (`branche`, `sektor`) | no | free text, ≤ 191 | `Company.industry` |
| `locale` (`language`, `sprache`, `dil`) | no | exactly `de`, `en` or `tr` | the lead's `User.preferredLanguage` |
| `stage` (`funnel_stage`, `status`) | no | a stage **key** of this organisation's own pipeline | `MentorshipRelation.pipelineStatus` |
| `source` (`quelle`, `kaynak`) | no | free text, ≤ 191 | the lead's `User.referralSource` |
| `monthly_transactions` (`transactions`, `bestellungen`) | no | whole number; `.`/`,`/spaces allowed as grouping | *nothing yet* |
| `mrr` (`monthly_revenue`) | no | money; `1.250,00` and `1,250.50` both read, parsed to integer minor units | *nothing yet* |
| `owner_email` (`owner`, `betreuer`) | no | e-mail of an `ADMIN`/`MENTOR` in this org; blank = `--owner` | `MentorshipRelation.mentorId` |
| `channels` (`kanale`, `kanallar`) | no | `;`-separated list, trimmed and de-duplicated (`Amazon;eBay;OTTO`) | *nothing yet* — #2408 |
| `contact_name` (`ansprechpartner`) | no | free text, ≤ 191 | `Company.contactName` **and** the lead's `User.fullName` |
| `contact_email` (`email`, `e-mail`) | no | an address; `@import.local` / `@erased.local` refused | `Company.contactEmail`. It is also the lead person's **identity** for matching — but a lead this importer *creates* is stored under a generated stand-in address, never this one (see "What it writes") |
| `contact_phone` (`telefon`, `phone`) | no | free text, ≤ 40; compared by normalised digits, so a re-spelling is not a change | `Company.contactPhone` **and** the lead's `User.phone` |

### The `stage` column takes MARKETING funnel keys only

The value is validated against **this organisation's own `PipelineStage` rows** — for a
marketing tenant those come from the `MARKETING_FUNNEL` preset
(`src/lib/programTemplates.ts`):

```
LEAD_NEW · LEAD_CONTACTED · LEAD_QUALIFIED · DEAL_PROPOSAL · DEAL_NEGOTIATION · DEAL_WON · DEAL_LOST
```

An unknown value is a row-level `ERROR` that names the keys the organisation does have.
Nothing is hardcoded: a tenant that renamed or extended its stages is validated against
what it actually has (`resolvePipelineStages`, and `npm run check:stage-keys` is the guard
against a literal creeping back in).

The **key** is what goes in the cell, never the label. The Turkish/German words on the
board are labels.

### Columns with no home yet

`legal_name`, `website`, `monthly_transactions`, `mrr` and `channels` are part of the
contract: they are **validated** (a malformed `mrr` fails its row now, not in six months)
and carried into the run report, and the CLI prints the list up front. They are not
persisted, because no column holds them yet — sales channels are #2408, revenue and volume
belong with metering.

They are **not** silently dropped: `--report=<path>` writes the complete per-row JSON,
including these fields, and the same file can simply be replayed once the column lands.
Adding a speculative column for each of them would be five schema changes nobody has
designed yet.

## Matching: which existing account is this row? (#2405)

1. **`vat_id`**, normalised (upper case, separators stripped). The strongest identity a
   merchant has across systems, and the reason `Company` now carries
   `@@unique([orgId, vatId])` — org-scoped, never global, because two tenants may each hold
   the same merchant and MySQL allows many NULLs in a unique index.
2. Otherwise **normalised name + country**. The normaliser is the repo's existing
   `normalizeNameKey()` (`src/lib/duplicateDetection.ts`): it transliterates İ/ı/ş/ğ/ü/ö/ç
   and strips accents *before* lowercasing. A plain `toLowerCase()` cannot do this —
   `'İ'.toLowerCase()` is `i` plus a combining dot, two code points — so `İstanbul Tekstil
   A.Ş.` and `ISTANBUL TEKSTIL A.S.` would be two accounts on every run. Country is the
   other half because `address` is free text: two merchants of the same name in two
   countries must stay two accounts.
3. **A country missing on one side falls back to the name alone** — but only when exactly
   one stored account bears that name. `Company.country` and `Company.vatId` arrive with
   this feature, so on the first run every account the tenant already holds has both
   `NULL`: an exact name+country key would compare the stored `acme gmbh␀` against the
   file's `acme gmbh␀DE` and duplicate the whole account master on the one run that
   matters. A loosely matched account has its `country` filled in as a gap, so the next run
   keys exactly. If two stored accounts share the name in **different** countries and the
   row names none, the row is a `SKIP` reading *ambiguous* — add a `country` or `vat_id`
   column. It is never guessed.

**`ß` does not fold to `ss`.** The normaliser transliterates İ/ı/ş/ğ/ü/ö/ç and strips
accents, but leaves `ß` as its own letter, so `Grüße Süßwaren` and `Grüsse Süsswaren` are
two accounts. #2405's criterion names `ß` among the characters that must "match correctly";
the deliberate reading here is that matching correctly means *not* fusing two spellings a
human wrote differently — one is a legal name, the other a transcription — and the run stays
idempotent for either spelling on its own. A file that mixes both needs a `vat_id`.

Resolution is **batched**: one query loads the organisation's accounts, one loads the lead
users the file names, one loads their relations — not three per row. (The name half is
matched in memory because `normalizeNameKey()` is a JavaScript function; a `WHERE` built
from raw names would be a second, weaker normaliser, which is the bug this is here to
prevent.)

Two rows for the same account **in one file**: the first wins, the second is reported as
`SKIP` naming the row it duplicates. The check is on the account a row **resolves to**, not
on the identity it claims — one merchant listed twice with the VAT filled in on only one of
the two lines holds two different claimed keys and is still one account.

## Row outcomes

The engine's own vocabulary, no new states:

| | |
| --- | --- |
| `CREATE` | no existing account matched |
| `UPDATE` | matched, and something would be written (account fields, the lead, or a stage move) |
| `UNCHANGED` | matched and nothing would be written — **what a second run of the same file produces for every row** |
| `SKIP` | the row duplicates an earlier row in the same file |
| `ERROR` | the row is unwritable; `reason` says why. Never thrown — the run continues |

A row carries a `reason` even when it lands, for the two soft cases:

- **a stage but no `contact_email`** — the `Company` is written, the stage is not placed,
  because a funnel record needs a person (`menteeId` is a required FK). Losing the account
  because nobody typed a contact would be the worse failure.
- **an `owner_email` nobody in the organisation has** — same: account written, stage not
  placed.

A contact whose lead already has an **active** funnel record with a *different* owner is an
`ERROR`, not a silent re-pointing: changing `mentorId` in place would re-attribute somebody
else's work ([`mentor-transfer.md`](mentor-transfer.md), #419).

## What it writes

- `Company` — created or updated (see the table above).
- The **lead person** — a `User` with `role: 'MENTEE'`, `companyId` set to the account, a
  sentinel password (`NO_LOGIN_PASSWORD`) that `bcrypt.compare` can never match, and a
  **generated stand-in address** on `import.local` rather than the merchant's mailbox. The
  sentinel alone would not be enough: `/api/auth/forgot` mails a reset link to any existing
  user and `/api/auth/reset` consumes it, so a real address would make every imported
  contact a claimable login. The real address stays on `Company.contactEmail`. No
  invitation and no "set your password" mail is sent, ever. Rationale and the deviation it
  represents: [`marketing-vertical/pipeline-record.md`](marketing-vertical/pipeline-record.md).
- The **funnel record** — a `MentorshipRelation` (owner, lead, account, stage), created
  through `src/lib/activeMentorship.ts` so "one mentee, at most one active mentor" (#419)
  holds.
- **Stage history** — a `StatusChange` on the relation when an existing record *moves*
  (`src/lib/stageChange.ts`, which refuses a no-op row by construction). A relation
  **created** at a stage gets no `StatusChange`: `stageEnteredAt()` already answers from
  `startDate`, and a `from → to` row would record a move that never happened.

One database transaction per **row**: a refused row leaves none of its four tables
half-written, and the rest of the file still lands.

## Running it

```bash
# Dry run — the default. Nothing is written.
npm run import:marketing-accounts -- --file=accounts.csv --owner=admin@example.com

# Write.
npm run import:marketing-accounts -- --file=accounts.csv --owner=admin@example.com --apply
```

| Flag | |
| --- | --- |
| `--file=<path>` | required |
| `--owner=<email>` | required; an `ADMIN` or `MENTOR`. Their organisation is the run's organisation |
| `--apply` | write. Without it the run reports and touches nothing |
| `--authoritative` | let the file overwrite a value it disagrees with. **Off by default**: the file only fills gaps, so a value somebody corrected in the app survives a re-run (`planFieldUpdates`, the one policy shared with SSO sync and the roster feed) |
| `--delimiter=<c>` | force `,` `;` `\t` or `|` |
| `--report=<path>` | write the full per-row JSON report, including the columns with no home yet |
| `--rows=<n>` | how many per-row lines to print (default 20) |

The run prints `CREATE / UPDATE / UNCHANGED / SKIP / ERROR` counts, the rows needing
attention, and a sample of what would be written. It exits non-zero if any row errored, so
a half-landed import is never a green run.

**A dry run is the same call with a writer that does not write.** There is no `if (dryRun)`
branch anywhere in the planning path — the preview is produced by the code that applies,
which is the property [`roster-feed.md`](roster-feed.md) spells out and #1432 lacked.

## Before you run it against real data

- Keep the file out of the repo. Real customer data is not synthetic data
  ([`DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md)).
- Dry-run first, read the `ERROR` rows, fix the file, dry-run again.
- `--apply` twice is safe by design — the second run is all `UNCHANGED` — but the first
  `--apply` is the one that creates people, so read the dry run's CREATE count and believe
  it.

## Tests

`scripts/test/marketing-import.test.mjs` (`npm run test:marketing-import`) pins the four
properties that typecheck while being wrong: the match key (VAT beats name; İ/ı/ü/ß), a
second run being all `UNCHANGED`, the dry run planning exactly what the apply plans, and a
bad row being reported rather than thrown. Dependency-free, with an in-memory writer.
