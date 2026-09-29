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
- **A sample file with the edge cases** (VAT id, a Turkish name, a stage without a contact,
  `ß`, a trial with its dates and one without — #2554): `scripts/fixtures/marketing-accounts-sample.csv`.
  A unit test runs it twice and expects six `CREATE`s, then six `UNCHANGED`.
  A lower-case `.csv` or `.tsv` directly in `scripts/fixtures/` is the one exception
  `.gitignore` lets through — a synthetic fixture goes there, a real export goes nowhere
  near the checkout.
- **How to run it against real data** — backup, owner, dry run, reading the report, fixing
  rows, apply: [Running it](#running-it).

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
| `external_id` (`external id`, `externalid`, `salevali_id`, `salevali id`, `externe_id`, `externe id`, `harici_id`, `harici id`) | no | the account's id in the product the tenant sells, ≤ 191, stored as written; matched trimmed and case-insensitively. For SaleVali: the merchant's `User._id` (24 hex characters) — the key [#2565](https://github.com/21072026/Internship/issues/2565) proposes; `user_number` is a display number and is **not** accepted as this column | `Company.externalId` — what the usage feed matches on ([`salevali-usage-feed.md`](marketing-vertical/salevali-usage-feed.md)) |
| `trial_started_at` (`trial_start`, `trial start`, `testbeginn`, `test_beginn`, `deneme_baslangic`, `deneme başlangıç`) | no | ISO date — see [Dates](#dates-2554) | the funnel record's `trialStartedAt` |
| `trial_ends_at` (`trial_end`, `trial end`, `testende`, `test_ende`, `deneme_bitis`, `deneme bitiş`) | no | ISO date; not before `trial_started_at` | the funnel record's `trialEndsAt` — what the trial reminders and the expiry sweep read |
| `customer_since` (`customer since`, `kunde_seit`, `kunde seit`, `musteri_tarihi`, `müşteri tarihi`) | no | ISO date | the funnel record's `startDate` — what the cohort, retention and aging reports read |

### Dates (#2554)

`trial_started_at`, `trial_ends_at` and `customer_since` take exactly two ISO 8601 shapes:

- `2026-05-04` — a calendar **day**, stored as midnight UTC (the same reading as a trial end
  typed into the app, so the reminder ladder, which compares UTC days, sees the same day);
- `2026-05-04T10:30:00Z` or `2026-05-04T12:30+02:00` — a date-time **with** a zone, what a
  system export writes.

Anything else is a row `ERROR` naming the column: `04.05.2026` (day-first and month-first
cannot be told apart, and a wrong guess moves a trial end by months without a single error),
a time without a zone (it would mean the importing machine's timezone), an impossible date
(`2026-02-30` is refused, not rolled into March), or a year outside 2000–2100.
`trial_ends_at` before `trial_started_at` is an `ERROR` too.

The dates live on the **funnel record**, so they are written only when the row places one
(a `stage` and a `contact_email`). A row that carries dates but places no record says so in
its reason — `trial_ends_at, customer_since not stored: the row places no funnel record` —
and the account itself still lands.

### The `stage` column takes MARKETING funnel keys only

The value is validated against **this organisation's own `PipelineStage` rows** — for a
marketing tenant those come from the `MARKETING_FUNNEL` preset
(`src/lib/programTemplates.ts`):

```
LEAD_NEW · LEAD_CONTACTED · LEAD_QUALIFIED · TRIAL_ACTIVE · TRIAL_EXPIRED · DEAL_PROPOSAL · DEAL_NEGOTIATION · DEAL_WON · DEAL_LOST
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

The order is **`external_id` > `vat_id` > name + country** (#2554).

0. **`external_id`**, trimmed and compared case-insensitively (MySQL's collation compares
   the column that way when the usage feed looks it up, so two spellings the database
   calls equal must not be two accounts here). The product's own id for the merchant can
   only **confirm** what the weaker keys say — it is never overruled by them and never
   guessed around. Each of these is a row-level `ERROR`, in the dry run as well as the
   apply, and nothing on the row is written:
   - two accounts of the organisation already carry the id (`Company.externalId` is
     deliberately not unique — see its schema comment): merge them in the app first;
   - the id names one account and the `vat_id` names another;
   - the id is new, and the `vat_id` / name finds an account that carries a **different**
     external id;
   - an earlier row of the same file gives the id to a different account (or to the same
     merchant under a different `vat_id`).

   An id no account carries yet falls through to the keys below, and the account they find
   has it filled in as a gap — which is how the first run over an account master that
   predates the column gives every account its id.
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
- The **funnel record's dates** (#2554) — `trial_started_at`, `trial_ends_at` and
  `customer_since` (→ `startDate`). A record the row **creates** takes every date the row
  carries. On an **existing** record they go through the one overwrite policy
  (`planFieldUpdates`): an empty date is filled, a stored one that disagrees is left alone
  and named in the reason (`left alone: funnelRecord.trialEndsAt`), and only
  `--authoritative` overwrites it. `startDate` is never empty on a stored record (it
  defaults to the insert), so `customer_since` corrects an existing record only under
  `--authoritative`.
- The **trial window** (#2551) — when a row lands in `TRIAL_ACTIVE` (a create at that
  stage, or an update that *moves* a record into it) and **neither the file nor the record
  gives an end**, `funnelRelationCreateData` / `funnelRelationUpdateData` stamp one through
  the same rule every other write into the stage uses (`trialWindowFor`,
  `src/lib/trialReminderRule.ts`): `trialEndsAt` = `trial_started_at` + the organisation's
  `trialLengthDays` (default 30) when the file gives a start, else the run time + that
  length (and `trialStartedAt` = the run time). **A date from the file always wins over the
  stamp**, a re-run that does not move a record stamps nothing, and an existing window is
  never overwritten.

  The dry run says it on the row before it happens:
  `trial_ends_at is blank: the default trial window applies (30 days from the import day)`.
  A record that already sits in `TRIAL_ACTIVE` with **no** end, and a file that gives none,
  is reported as `… no trial reminder will be sent until one is set` — fill `trial_ends_at`
  for it (a gap, so no `--authoritative` needed) rather than accepting a silent trial.
- **Stage history** — a `StatusChange` on the relation when an existing record *moves*
  (`src/lib/stageChange.ts`, which refuses a no-op row by construction). A relation
  **created** at a stage gets no `StatusChange`: `stageEnteredAt()` already answers from
  `startDate`, and a `from → to` row would record a move that never happened.

One database transaction per **row**: a refused row leaves none of its four tables
half-written, and the rest of the file still lands.

## Running it

This is the runbook: what to do, in order, when you have the real customer file in hand.
It does not restate a rule another page owns — each warning below links the page that
does.

```bash
# Dry run — the default. Nothing is written.
npm run import:marketing-accounts -- --file=$HOME/import/accounts.csv --owner=sales.lead@example.com

# Write.
npm run import:marketing-accounts -- --file=$HOME/import/accounts.csv --owner=sales.lead@example.com --apply
```

| Flag | |
| --- | --- |
| `--file=<path>` | required |
| `--owner=<email>` | required; an `ADMIN` or `MENTOR`. Their organisation is the run's organisation — see step 2 |
| `--apply` | write. Without it the run reports and touches nothing |
| `--authoritative` | let the file overwrite a value it disagrees with. **Off by default**: the file only fills gaps, so a value somebody corrected in the app survives a re-run (`planFieldUpdates`, the one policy shared with SSO sync and the roster feed) |
| `--delimiter=<c>` | force `,` `;` `\t` or `\|` |
| `--report=<path>` | write the full per-row JSON report, including the columns with no home yet |
| `--rows=<n>` | how many per-row lines to print (default 20) |

**A dry run is the same call with a writer that does not write.** There is no `if (dryRun)`
branch anywhere in the planning path — the preview is produced by the code that applies,
which is the property [`roster-feed.md`](roster-feed.md) spells out and #1432 lacked. The
one thing a dry run cannot show is a refusal only the write itself can make (step 5, "Only
under `--apply`").

### Before the first run

- **Where it runs.** From a checkout of the commit the target database is deployed at,
  after `npm install` (which also runs `prisma generate`), on **Node ≥ 22.6** — the CLI
  loads the TypeScript engine under `src/lib` through `--experimental-strip-types`. It
  cannot run inside the app container: the runtime image is `node:20-slim` and ships
  neither `scripts/` nor `src/` (`Dockerfile`).
- **Which database.** The one `DATABASE_URL` names: the shell's value when it is set,
  otherwise the checkout's `.env`, which Prisma reads by itself. The CLI prints the
  organisation it writes to, but not the database host — know which one you are pointed at
  before you start.
- **Rehearse on synthetic data.** `npm run seed:demo` against a local database adds a
  MARKETING tenant (`prisma/seed-demo-marketing.mjs`) whose admin is
  `admin.marketing@demo.example.com`, and `scripts/fixtures/marketing-accounts-sample.csv`
  runs against it. That is as far as a contributor ever goes: a run against production or
  the shared preview is an operator action ([`DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md),
  rules 1, 2 and 5).
- **Take a backup first.** There is no un-import. An `--apply` writes ordinary `Company`,
  `User`, `MentorshipRelation` and `StatusChange` rows, and the only complete way back is a
  restore — which also throws away everything else written since the dump. So take a fresh
  dump right before the first `--apply` against a shared database and write down which one
  it is. Where the dumps live, how one is taken and how it is restored:
  [`disaster-recovery.md`](disaster-recovery.md).
- **The file is personal data, and so is everything the run prints.** The export names real
  people with their e-mail addresses and phone numbers; the console output quotes account
  names and, in several reasons, contact addresses; the `--report` JSON carries every input
  field of every row. Keep all three in a directory of your own **outside** the checkout
  (`mkdir -m 700 ~/import`), never paste them into an issue, a PR or a chat, and delete them
  when you are done (step 7). What may be seen by whom, and for how long:
  [`DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md) and
  [`pii-access-lifecycle.md`](pii-access-lifecycle.md).
  Two things make "outside the checkout" matter: `npm run` executes from the checkout root,
  so a *relative* `--file` or `--report` path resolves **inside** the repository; and
  `.gitignore` keeps `.csv`, `.tsv`, `.xlsx`, `.xls` and `.ods` files, in any letter case,
  away from `git add`, but not a JSON report.

### 1. Export the spreadsheet

- One header row first; the headers are the column names or any alias from the table
  above, in any order and any case. Blank rows are ignored.
- Save it as **CSV UTF-8** ("CSV UTF-8 (durch Trennzeichen getrennt)" in a German Excel).
  The delimiter is sniffed, so `;` is fine — the *encoding* is not: Excel's plain "CSV"
  writes the machine's Windows code page (Windows-1252 on a German or Western machine,
  Windows-1254 on a Turkish one), the CLI reads UTF-8 only, and `Grüße Süßwaren GmbH`
  arrives as `Gr��e S��waren GmbH`. The broken encoding on its own produces **no
  `ERROR`**: the file validates, the broken names are stored, and a later, correctly
  encoded run creates a twin of every such account that has no `vat_id` (the name no longer
  matches) while leaving the broken name standing on those that have one (the file only
  fills gaps — `left alone: name`). Check before you run:

  ```bash
  iconv -f UTF-8 -t UTF-8 ~/import/accounts.csv > /dev/null && echo "UTF-8: ok"
  ```

- **Not UTF-8? Export it again as CSV UTF-8** from the workbook. Do not convert the file
  you have, for two reasons:
  - A conversion needs the code page the file was saved in, and a wrong guess does not
    fail. A Turkish (Windows-1254) file converted as Windows-1252 comes out as
    `Ýstanbul Tekstil A.Þ.` and `Yýldýz Aðaç Sanayi`: valid UTF-8 with no `�`, so it
    passes the check above, the CLI stores it without an `ERROR`, and the names no longer
    match anything (`normalizeNameKey` reads `ystanbul tekstil a` instead of
    `istanbul tekstil a s`).
  - A code page loses what it cannot hold before any conversion runs. Windows-1252 has no
    `İ`, `ı`, `ş` or `ğ`, and Excel writes `?` in their place. For a list that mixes German
    and Turkish merchants, the workbook is the only copy that still has every name.

### 2. Choose `--owner`

`--owner` decides three things at once:

1. **The organisation.** The run imports into the owner's organisation and nowhere else
   ([There is no tenant column](#there-is-no-tenant-column)).
2. **The default owner** of every funnel record whose row leaves `owner_email` blank. A
   row's own `owner_email` wins, and must be an `ADMIN` or `MENTOR` of the same
   organisation.
3. **Who the activity log names** as having run the import
   (`marketing.accounts.imported`, written on `--apply` only).

So pick the person who should own the unassigned leads in the right organisation — not
whoever happens to type the command — and use the **same** `--owner` on every re-run. A
different one does not re-point the records an earlier run created: each of those rows is
refused as `already_mentored` (step 5), because moving a funnel record is a transfer
([`mentor-transfer.md`](mentor-transfer.md)), never an import side effect.

### 3. Dry run

```bash
npm run import:marketing-accounts -- --file=$HOME/import/accounts.csv \
  --owner=sales.lead@example.com --report=$HOME/import/dry-run.json
```

Nothing is written, however many times you run it.

### 4. Read the output

Every run starts with a header block:

```text
=== Marketing account import (DRY-RUN — no writes) ===    ← (APPLY) when it writes
File            : /home/you/import/accounts.csv
Owner           : sales.lead@example.com (ADMIN)          ← owns every row without owner_email
Organization    : <org id>                                ← the tenant it writes to
Pipeline stages : LEAD_NEW, LEAD_CONTACTED, …             ← what the `stage` column may hold
Field policy    : fill gaps only                          ← "authoritative (overwrites)" with the flag
Columns known   : name, legal_name, country, …
Not stored yet  : legal_name, website, monthly_transactions, mrr, channels — …
```

and then the rows. This is the real output for a four-line synthetic file:

```text
name;country;vat_id;contact_email
Acme Handel GmbH;DE;DE 811.234-567;
İstanbul Tekstil A.Ş.;TR;;
Acme Handel GmbH;DE;;
Beispiel AG;Deutschland;;
```

```text
Rows: 4
  CREATE: 2
  UPDATE: 0
  UNCHANGED: 0
  SKIP: 1
  ERROR: 1

Rows needing attention (2):
  row 3 [SKIP] name:acme handel gmbh DE — duplicate account in file (first seen at row 1)
  row 4 [ERROR] Beispiel AG — country must be an ISO-3166-1 alpha-2 code, got "Deutschland"

Sample of what would be written:
  row 1 [CREATE] Acme Handel GmbH → name, vatId, country
  row 2 [CREATE] İstanbul Tekstil A.Ş. → name, country

(Dry-run only. Re-run with --apply to write.)
```

Row 3 is a `SKIP` although it names no VAT id: it resolves onto the account row 1 is about
to create (same name, same country), and the duplicate check is on the account a row
*resolves to* ([Matching](#matching-which-existing-account-is-this-row-2405)). The run
exits `1` because of row 4.

- **Check the header block first.** `Organization` and `Pipeline stages` are the two lines
  that say whether this is the right tenant. If the stages read `APPLICATION_100,
  APPROVAL_PENDING_220, …`, the owner belongs to an *internship* organisation: every row
  with a stage comes back `ERROR`, each naming its own stage — e.g. `stage
  "LEAD_QUALIFIED" is not one of this organization's pipeline stages (APPLICATION_100, …)`.
  That is the wrong `--owner`, not a wrong file — it is exactly what the sample file
  produces when it is run as the internship demo admin.
- **The counts** mean what [Row outcomes](#row-outcomes) says.
- **Rows needing attention** lists every `ERROR` and `SKIP`, and every row that lands but
  carries a reason — at most `--rows` of them (default 20); the rest are in the `--report`
  file. `row N` is the N-th **data** row, so it is spreadsheet row N + 1 (the header is row
  1) as long as the sheet has no blank rows. The next column is the row's match key —
  `vat:<VAT id, normalised>` or `name:<name, normalised> <country>` — or, for a row that
  failed validation, simply its name.
- **Sample of what would be written** shows the first five `CREATE`/`UPDATE` rows and the
  fields each would write: account fields (`vatId`, `contactPhone`, …), `lead` (a new lead
  person) or `lead.<field>`, `funnelRecord` (a new funnel record) and `pipelineStatus` (a
  stage move). It is a sample, not the file: to look for a broken encoding, search the whole
  report — `grep -c '�' ~/import/dry-run.json` must print `0` (step 1), and
  `grep -nE 'Ý|Þ|Ð|ý|þ|ð' ~/import/dry-run.json` must find nothing (the letters a Turkish
  file read as Windows-1252 turns into; spelled as alternatives because a `[…]` class of
  them matches `ü` and `ß` too under a non-UTF-8 locale). A `?` Excel wrote for a letter
  its code page lacks looks like any other `?`, so read a few of the Turkish names as well.
- **The exit code:** `0` — no row errored; `1` — at least one `ERROR` row, in a dry run
  too, so a wrapper script can stop on it; `2` — the run was refused before it read a row
  (a missing `--file`/`--owner`, `owner_not_found`, `owner_role`). A Node stack trace
  instead of the banner means the run stopped before it produced a report — a file that
  does not exist, an unreachable database.

### 5. Fix the file, not the database

Every `ERROR` and `SKIP` is fixed **in the file, or in the app** — never by editing rows in
the database — and then you dry-run again, until the run shows `ERROR: 0` and every
remaining reason is one you accept.

| The reason says | What to do |
| --- | --- |
| `name is required` | the row has no account name: fill it in, or delete the row |
| `country must be an ISO-3166-1 alpha-2 code, got "Deutschland"` | two letters: `DE`, `AT`, `TR`, `CH` |
| `vat_id is too short to be an identity` | usually a placeholder (`-`, `n/a`): correct it or blank the cell |
| `locale must be one of en/tr/de, got "…"` | one of those three, or blank |
| `stage "…" is not one of this organization's pipeline stages (…)` | use a **key** from the list in the message, never the label on the board. If *every* staged row says this, see step 4: the owner is in the wrong organisation |
| `monthly_transactions must be a whole number` · `mrr is not a number` · `mrr must not be negative` | fix the number; a currency sign and `.`/`,` grouping are fine |
| `contact_email is not an address` · `owner_email is not an address` | a typo, or two addresses in one cell — keep one |
| `contact_email is on a reserved stand-in domain` | `@import.local` / `@erased.local` are addresses the CRM generated, not mailboxes — usually the file was exported from the CRM itself. Use the real address or blank it |
| `<field> is longer than <n> characters` | shorten it. Nothing is truncated for you |
| `trial_started_at` / `trial_ends_at` / `customer_since must be an ISO date …` | write `YYYY-MM-DD` (or a date-time with `Z`/`±HH:MM`). In Excel: format the column as text `JJJJ-MM-TT` / `yyyy-mm-dd` before saving |
| `trial_ends_at is before trial_started_at` | one of the two is wrong in the source; fix it there |
| `external_id "…" is carried by N accounts of this organization` | the CRM already holds duplicates under that id: merge them in the app, then dry-run again |
| `external_id "…" and vat_id name two different accounts` · `… differs from the external id "…" of the account this row matches` | the file and the CRM disagree about who this merchant is. Check the id against the source system; never "fix" it by blanking the CRM's value |
| `external_id "…" is already given to a different account by row N` · `… is given to row N with a different vat_id` | the file itself hands one id to two merchants — one of the two lines has the wrong id |
| `duplicate account in file (first seen at row N)` · `(matches N earlier rows by name; …)` | `SKIP`: one merchant, two lines. The first line won; move what the other one knows into it and delete it |
| `ambiguous: N existing accounts are named "…" — add a country or vat_id column` | `SKIP`: the CRM holds several accounts of that name. If they carry different countries, fill `country` or `vat_id` on that row. If they carry **no** country and no VAT id — the state every account is in before its first import — the file cannot tell them apart, whatever the row says: fix it in the app (set their country/VAT id, or merge the duplicates), then dry-run again |

Reasons on a row that **still lands** — nothing is lost, but something was not done:

| The reason says | What to do |
| --- | --- |
| `left alone: industry, contactPhone` | the CRM holds a different value and the file only fills gaps. If the file is right, correct the value in the app — or re-run with `--authoritative`, which overwrites **every** disagreeing field on **every** row, so dry-run that too and read all of it |
| `stage "…" not placed: the row has no primary contact e-mail` | a funnel record needs a person. Add `contact_email`; the next run fills the account's gap and places the stage as an `UPDATE` |
| `stage "…" not placed: owner_email "…" is not a user of this organization` | not an `ADMIN`/`MENTOR` of this organisation: correct it, or blank it to fall back to `--owner` |
| `stage "…" not placed: contact … is already the lead of row N` | two accounts share one contact, and one person leads one funnel record. Give the second account its own contact |
| `trial_ends_at is blank: the default trial window applies (N days from …)` | the trial end is being made up from `trialLengthDays`. For a customer whose trial is already running, put the real `trial_ends_at` in the file |
| `the record is in TRIAL_ACTIVE with no trial end and trial_ends_at is blank …` | a trial nobody will be reminded about. Add `trial_ends_at` to the row |
| `… not stored: the row places no funnel record` | the row has dates but no `stage` or no `contact_email`; the dates have nowhere to go until it does |
| `left alone: funnelRecord.trialEndsAt` (or `.trialStartedAt`, `.startDate`) | the record already has a different date. Correct it in the app, or `--authoritative` |

**Only under `--apply`.** Two kinds of refusal come from the write itself, so a dry run
shows those rows as the `CREATE`/`UPDATE` they were planned as, and they turn into `ERROR`
only when you write:

| The reason says | What to do |
| --- | --- |
| `… already has an active owner in this organization — transfer the record instead of importing it (already_mentored)` | the lead's funnel record belongs to somebody else (or to a different `--owner` from an earlier run). Put that person in the row's `owner_email`, or move the record with the transfer in the app ([`mentor-transfer.md`](mentor-transfer.md)) and re-run. Never change the owner in the database by hand |
| any other message — usually a database error with its Prisma code (`P2002: …`) | a constraint the plan could not see. `--apply` plans afresh from the database when it starts, so a change made in the app *before* it is already in its plan; this is somebody changing the same account *while* the apply runs. Dry-run again to see the current plan, fix what it names, re-run `--apply` |

### 6. Apply

```bash
npm run import:marketing-accounts -- --file=$HOME/import/accounts.csv \
  --owner=sales.lead@example.com --apply --report=$HOME/import/apply.json
```

Same file, same `--owner`, same flags as the last clean dry run. The first `--apply` is the
one that creates people, so read the dry run's `CREATE` count and believe it.

The output has the same shape, with `(APPLY)` in the banner. Each row is its own
transaction, so exit code `1` means *those* rows did not land and the rest did. Fix them
(step 5) and re-run `--apply` with the **whole** file — there is no need to cut it down to
the failed rows: `--apply` twice is safe by design, and everything already written comes
back `UNCHANGED`.

### 7. Check, then clean up

- **Dry-run the same file once more.** Every row that landed must now read `UNCHANGED`
  (`SKIP` rows and the rows that failed validation stay what they were). A row the apply
  refused — the "Only under `--apply`" table in step 5 — wrote nothing at all, because each
  row is one transaction, so it comes back as the `CREATE` or `UPDATE` it was planned as:
  match those against the `ERROR` rows in `apply.json` first. Any *other* `CREATE` or
  `UPDATE` means the file and the database disagree about who an account is: an encoding
  problem, or a `name`, `country` or `vat_id` that changed between runs. Stop and find out
  before applying again.
- **Spot-check** a few of the created accounts and their stage in the app.
- **Delete** the export, the `--report` files and every copy of them (downloads folder, a
  mail attachment). The dump from "Take a backup first" stays where it is and expires on its
  own schedule — [`disaster-recovery.md`](disaster-recovery.md) says how long, and it is
  not to be copied anywhere either.

## One lead typed in by hand (#2562)

The **"New lead / account"** dialog on `/admin/companies` (MARKETING orgs, ADMIN only) is
this importer with a file of one row — not a second lead writer.
`POST /api/admin/marketing-accounts` builds the row with `manualAccountTable()` under the
canonical headers, so the same validator, match key and diff decide it, and runs it through
`runImport` in **create-only** mode (`createMarketingAccount()` in
`src/lib/marketingImportStore.ts`, sharing `runMarketingRows()` with the CLI run):

| Plan | Written? | Answer |
|---|---|---|
| `CREATE` | yes — `Company` + stand-in lead + funnel record, via the import's database writer | `201`, with `companyId` and `leadId` |
| `UPDATE` / `UNCHANGED` (the match key found an account) | **no** (`createOnlyWriter` never updates) | `409 account_exists` + `companyId` — the dialog opens that account |
| `CREATE` whose contact already has an ACTIVE funnel record | no (`createOnlyPlan` turns it into a `SKIP`) | `409 contact_in_funnel` + `leadId` — the import would re-point that record at the new account; a form should not |
| the contact address is a staff user (ADMIN/MENTOR/COMPANY) of the org — typically the admin's own | no (checked before planning) | `409 contact_is_user` — staff is never a lead; the file import instead creates a separate stand-in lead, because the lead lookup matches `MENTEE` users only |
| the contact is another owner's lead (#419) | no (the writer's guard, transaction rolled back) | `409 already_mentored` |
| `SKIP` for an ambiguous name | no | `409 account_ambiguous` |

Differences from a file row, all deliberate: the contact e-mail is **required** (without it
the import places no funnel record, and a hand-typed lead that is not on the board is not
what the form promises); the owner is the acting admin; the stage defaults to the org's
first on-path stage and an off-path stage is refused (it would need a drop-off reason the
form has no field for). No marketing-consent record is written (#2577). INTERNSHIP orgs
never see the dialog, and the route answers them `403 vertical_unavailable`.

## Tests

`scripts/test/marketing-import.test.mjs` (`npm run test:marketing-import`) pins the four
properties that typecheck while being wrong: the match key (VAT beats name; İ/ı/ü/ß), a
second run being all `UNCHANGED`, the dry run planning exactly what the apply plans, and a
bad row being reported rather than thrown. Dependency-free, with an in-memory writer whose
funnel records are built by the same `funnelRelationCreateData` / `funnelRelationUpdateData`
the Prisma writer spreads — so the #2554 cases (external-id conflicts, ISO dates, the file
date winning over the default window, an imported trial showing up in
`selectDueTrialReminders`) are asserted against the data production writes.
