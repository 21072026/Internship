# Epic 1 — Import the existing customer base

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **Urgent** · Effort **Medium**

**DE:** Bestehende SaleVali-Kunden aus der Tabelle in das CRM importieren.
**TR:** Mevcut SaleVali müşterilerini tablodan CRM'e aktar.

There are already customers. Until they are in the CRM, the CRM is a parallel
universe and the team keeps using the spreadsheet — which means the funnel data
never accumulates and every other epic here operates on an empty database.

The import has to be **idempotent** and **dry-run by default**: it will be run
more than once, against data that someone is still editing by hand.

---

## Story 1.1 — CSV import script

`Feature` · Priority **Urgent** · Effort **Medium**

**DE:** Ein Kommandozeilen-Skript, das eine CSV liest, prüft und schreibt.
**TR:** CSV okuyan, doğrulayan ve yazan bir komut satırı script'i.

---

### T-1.1.1 — Define the CSV column contract and a sample fixture

`Task` · Priority **Urgent** · Effort **Low** · `good first issue`

**DE:** Spalten der Import-CSV festlegen und eine Beispieldatei einchecken.
**TR:** İçe aktarma CSV'sinin sütunlarını belirle ve örnek dosyayı repoya ekle.

**Done when**
- `docs/import.md` lists every column, whether it is required, and its format.
- `scripts/fixtures/customers-sample.csv` has ~5 rows covering the interesting
  cases: no VAT ID, several channels, a customer already paying, a trial.
- Column names map onto `Customer` fields in `prisma/schema.prisma`.

**Prompt**

> In the SaleVali Marketing CRM repo, define the CSV contract for importing
> existing customers. Read `prisma/schema.prisma` for the `Customer`,
> `Contact` and `CustomerIntegration` models first.
>
> Write `docs/import.md` with a table of columns: name, required/optional,
> format, and which model field it maps to. Cover company name, legal name,
> country (ISO-2), city, VAT ID, website, industry, locale (DE/EN/TR),
> lifecycle stage, source, pricing model, monthly transactions, MRR, trial
> start/end, SEPA mandate status, assigned marketer e-mail, channels
> (semicolon-separated), and the primary contact's first name, last name,
> e-mail, phone and role.
>
> Then add `scripts/fixtures/customers-sample.csv` with about five rows that
> cover: a merchant with no VAT ID, one selling on three channels, one already
> paying, one mid-trial, and one with no contact person. Do not write the
> importer itself in this task.

---

### T-1.1.2 — Parse and validate rows with a zod schema

`Task` · Priority **Urgent** · Effort **Low** · `good first issue`

**DE:** Jede Zeile mit zod prüfen; ungültige Zeilen sammeln statt abbrechen.
**TR:** Her satırı zod ile doğrula; hatalı satırda durma, hepsini topla.

**Done when**
- `scripts/import-csv.mjs` reads a CSV path from `argv` and parses it with
  `csv-parse`.
- Each row is validated; invalid rows are collected with their line number and
  the reason, and reported at the end.
- One invalid row does not stop the run, and does not write anything.

**Prompt**

> Add `scripts/import-csv.mjs` to the SaleVali Marketing CRM. It takes a CSV
> path as its first argument and, for now, only parses and validates — no
> database writes at all in this task.
>
> Use `csv-parse` (add it as a devDependency) and validate each row against a
> zod schema that mirrors the contract in `docs/import.md`. Reuse the enum
> values from `@prisma/client` rather than re-typing them as strings.
>
> Collect failures instead of throwing: keep `{ line, column, message }` for
> every invalid row and print a summary at the end — `12 rows read, 10 valid,
> 2 rejected` followed by the rejects. Exit non-zero if anything was rejected.
> Verify it against `scripts/fixtures/customers-sample.csv`.

---

### T-1.1.3 — Dry-run reporter: print what would change

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Standardmäßig nur anzeigen, was sich ändern würde — nichts schreiben.
**TR:** Varsayılan olarak sadece neyin değişeceğini yazdır, hiçbir şey yazma.

**Done when**
- Running the script without `--commit` writes nothing to the database.
- The output says, per row, whether it would **create** or **update** a
  customer, and for updates which fields would change (old → new).
- A run where nothing would change says so plainly.

**Prompt**

> Extend `scripts/import-csv.mjs` in the SaleVali Marketing CRM with a dry-run
> reporter. Dry-run is the default; there is no flag to request it.
>
> For each valid row, look up the existing customer (see T-1.1.4 for the
> matching rule; if that is not implemented yet, match on `companyName` +
> `country`). Print one line per row: `CREATE <company>` or
> `UPDATE <company>` followed by the fields that differ, formatted as
> `field: old → new`. Never print the whole row when only one field changed.
>
> End with counts: `would create N, would update M, unchanged K`. Nothing may
> reach the database on this path — no `create`, no `update`, no `upsert`.

---

### T-1.1.4 — Idempotent matching: VAT ID first, then company + country

`Task` · Priority **Urgent** · Effort **Medium**

**DE:** Bestehende Kunden über USt-IdNr., sonst Firma + Land wiedererkennen.
**TR:** Mevcut müşteriyi önce VAT ID, yoksa firma + ülke ile eşleştir.

**Done when**
- A row with a VAT ID matches the customer with that VAT ID, whatever the
  company name says.
- Without a VAT ID, matching falls back to case-insensitive company name plus
  country.
- Running the same file twice reports `unchanged` for every row the second
  time. There is a test for exactly that.

**Prompt**

> Implement the matching rule for `scripts/import-csv.mjs` in the SaleVali
> Marketing CRM, so re-running an import is safe.
>
> Match an incoming row to an existing `Customer` by `vatId` when the row has
> one — a company can rename itself, its VAT ID does not change. Fall back to
> a case-insensitive `companyName` plus `country` match. If neither matches, it
> is a create.
>
> The property that matters: importing the same file twice must be a no-op the
> second time. Add a script or spec that imports the sample fixture twice and
> asserts the second run reports zero creates and zero updates.

---

### T-1.1.5 — `--commit` flag that writes, with a summary

`Task` · Priority **Urgent** · Effort **Low** · `good first issue`

**DE:** Mit `--commit` tatsächlich schreiben und am Ende eine Bilanz ausgeben.
**TR:** `--commit` ile gerçekten yaz ve sonunda özet raporu bas.

**Done when**
- `node scripts/import-csv.mjs file.csv --commit` performs the creates and
  updates the dry run described.
- Every created customer gets a `StageChange` row for its initial stage, and
  stage-implied dates come from `lifecycleTimestampsFor()`.
- The final line reports `created N, updated M, unchanged K, rejected R`.

**Prompt**

> Add the `--commit` path to `scripts/import-csv.mjs` in the SaleVali Marketing
> CRM. Without the flag the script stays a dry run.
>
> Important: do not write `stage` directly. Import `lifecycleTimestampsFor()`
> from `src/lib/lifecycle.ts` and let it derive `trialStartedAt`,
> `trialEndsAt`, `convertedAt` and the rest, exactly as the API routes do — and
> create a `StageChange` row for the initial stage of every new customer, so
> the funnel reporting has a starting point. `CLAUDE.md` explains why this is
> not optional.
>
> The importer runs as a script, not a request, so there is no session: take
> the importing user's e-mail from a `--as <email>` argument and use that
> user's id for `createdById`. Fail with a clear message if the user does not
> exist. Print `created N, updated M, unchanged K, rejected R` at the end.

---

### T-1.1.6 — Import the primary contact per row

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Ansprechpartner aus der CSV anlegen und mit dem Kunden verknüpfen.
**TR:** CSV'deki muhatabı oluştur ve müşteriye bağla.

**Done when**
- A row with contact columns creates a `Contact` linked to the customer, with
  `isPrimary = true`.
- A contact whose e-mail already exists is updated, not duplicated — `email` is
  unique in the schema, so an unhandled duplicate throws.
- A row with no contact columns imports the customer alone, without error.

**Prompt**

> Extend `scripts/import-csv.mjs` in the SaleVali Marketing CRM to import the
> primary contact for each customer row.
>
> Create a `Contact` with `isPrimary: true` linked to the customer. `email` is
> `@unique` in `prisma/schema.prisma`, so upsert on it rather than create — a
> re-run must not throw `P2002`. Rows with no contact columns import the
> customer on its own and are not an error.
>
> Include this in the dry-run output too: `+ contact ayse@example.de` or
> `~ contact ayse@example.de (phone changed)`.

---

### T-1.1.7 — Import the channels each merchant sells on

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Verkaufskanäle aus der CSV als `CustomerIntegration` anlegen.
**TR:** CSV'deki satış kanallarını `CustomerIntegration` olarak ekle.

**Done when**
- A semicolon-separated channel column becomes one `CustomerIntegration` row
  per channel.
- Unknown channel names are reported as row errors rather than silently
  dropped.
- Re-running does not duplicate: the model is unique on
  `[customerId, channel]`.

**Prompt**

> Extend `scripts/import-csv.mjs` in the SaleVali Marketing CRM to import sales
> channels.
>
> The CSV has one column with semicolon-separated channel names
> (`Amazon;Shopify;DHL`). Map them, case-insensitively, onto the
> `IntegrationChannel` enum in `prisma/schema.prisma` — accept the display
> labels from `INTEGRATION_CHANNEL_LABELS` in `src/lib/constants.ts` as well as
> the raw enum values. A name that matches nothing is a row-level error with a
> helpful message listing the valid options; do not silently skip it.
>
> Write them with `upsert` on the `customerId_channel` unique key so a re-run
> is a no-op, and default the status to `INTERESTED` unless the CSV says
> otherwise.

---

### T-1.1.8 — Document how to run an import

`Task` · Priority **Medium** · Effort **Low** · `good first issue` · `documentation`

**DE:** Ablauf des Imports dokumentieren, inklusive Sicherheitshinweisen.
**TR:** İçe aktarma sürecini, güvenlik uyarılarıyla birlikte dokümante et.

**Done when**
- `docs/import.md` has a runnable walkthrough: export the spreadsheet, dry run,
  read the report, `--commit`.
- It says to take a backup first (`infra/backup-db.sh`) and warns that the CSV
  contains personal data and must not be committed.
- `README.md` links to it.

**Prompt**

> Finish `docs/import.md` in the SaleVali Marketing CRM with a walkthrough an
> operator can follow without reading the script: export the spreadsheet to
> CSV, run the dry run, how to read the report, then `--commit`.
>
> Two warnings that must be in there: take a backup first with
> `infra/backup-db.sh`, and the CSV holds names, e-mail addresses and phone
> numbers of real people, so it must never be committed to the repository or
> pasted into a ticket — see `SECURITY.md`. Add the CSV pattern to
> `.gitignore`. Link the doc from `README.md`.

---

## Story 1.2 — Import from inside the app

`Feature` · Priority **Low** · Effort **High**

**DE:** Später: CSV-Upload direkt im Admin-Bereich statt über die Kommandozeile.
**TR:** Sonrası için: komut satırı yerine yönetici ekranından CSV yükleme.

Only worth doing once the script has been used a few times and the shape has
settled. A UI for a one-off migration is wasted work.

---

### T-1.2.1 — Admin-only CSV upload page

`Task` · Priority **Low** · Effort **Medium**

**DE:** Upload-Seite für Admins mit Vorschau der Änderungen.
**TR:** Admin'ler için, değişiklik önizlemeli yükleme sayfası.

**Done when**
- `/dashboard/import` is reachable by `ADMIN` only.
- Uploading a CSV shows the same dry-run report the script prints.
- Nothing is written until the operator confirms.

**Prompt**

> Add `/dashboard/import` to the SaleVali Marketing CRM: an `ADMIN`-only page
> that accepts a CSV upload and shows the dry-run report before writing
> anything.
>
> Reuse the parsing and matching logic from `scripts/import-csv.mjs` — extract
> it into `src/lib/import.ts` first so the script and the page cannot drift
> apart, and leave the script as a thin wrapper. The page shows the create /
> update / unchanged breakdown and a confirm button; only the confirm writes.
>
> Check the role server-side, not just in the UI, and add an e2e spec asserting
> a `MARKETER` gets a 403 or a redirect.

---

### T-1.2.2 — Reject files that are too large or not CSV

`Task` · Priority **Low** · Effort **Low** · `good first issue`

**DE:** Uploads auf Typ und Größe begrenzen.
**TR:** Yüklemeleri tip ve boyut olarak sınırla.

**Done when**
- Non-CSV uploads are refused with a readable message.
- Files over a documented size limit are refused before being parsed.
- Neither case throws an unhandled error.

**Prompt**

> Add input limits to the CSV upload at `/dashboard/import` in the SaleVali
> Marketing CRM: refuse anything that is not `text/csv`, and refuse files over
> a size limit defined as a constant in `src/lib/constants.ts` (start with 5 MB
> and say why in a comment). Both refusals return a readable message, not a
> stack trace, and are checked on the server, not only in the browser.
