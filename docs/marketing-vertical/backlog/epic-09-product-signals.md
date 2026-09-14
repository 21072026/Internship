# Epic 9 — Signals from the SaleVali product

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **Low** · Effort **High**

**DE:** Nutzungsdaten aus SaleVali ins CRM holen, statt Zahlen von Hand zu pflegen.
**TR:** Sayıları elle girmek yerine SaleVali'den kullanım verisini CRM'e getir.

Two numbers decide most of what this CRM is for — how much a merchant is worth
and whether they are drifting away — and both are typed in by hand today, which
means they are stale by definition.

The strongest churn predictor for an ERP is usage: a merchant whose transaction
volume drops for two weeks is leaving, whatever the CRM's stage field says.

**This epic depends on the SaleVali side**, both for read access to the data and
for a decision about who calls whom. Do not start the implementation tasks
before T-9.1.1 has an answer.

---

## Story 9.1 — Usage sync

`Feature` · Priority **Low** · Effort **High**

**DE:** Transaktionsvolumen je Kunde regelmäßig übernehmen.
**TR:** Müşteri başına işlem hacmini düzenli olarak aktar.

---

### T-9.1.1 — Agree the data contract with the SaleVali team

`Task` · Priority **Medium** · Effort **Medium** · `documentation`

**DE:** Mit dem SaleVali-Team klären, welche Daten wie bereitgestellt werden.
**TR:** SaleVali ekibiyle hangi verinin nasıl sağlanacağını netleştir.

**Done when**
- It is decided whether the CRM pulls (read replica, API) or SaleVali pushes.
- The identifier linking a SaleVali account to a CRM `Customer` is agreed.
- `docs/salevali-integration.md` records the contract, including who owns it.

**Prompt**

> Write `docs/salevali-integration.md` for the SaleVali Marketing CRM,
> capturing the agreement with the SaleVali product team before any code.
>
> Three questions to settle. **Direction**: does the CRM pull (read replica,
> reporting API) or does SaleVali push? **Identity**: what links a SaleVali
> account to a CRM `Customer` — a tenant id, the VAT ID, the account email?
> Whatever it is, the CRM will need a column for it, and picking wrong means a
> migration later. **Cadence and fields**: daily transaction counts per account
> is the minimum; order counts, connected channels and last-login are the
> obvious extras.
>
> Also record the data-protection angle: this is customer business data
> crossing a system boundary, so state the legal basis and who owns the
> integration on each side. Do not write the sync in this task.

---

### T-9.1.2 — `CustomerUsage` model and external id

`Task` · Priority **Low** · Effort **Low**

**DE:** Modell für tägliche Nutzungswerte und ein Feld für die SaleVali-Kennung.
**TR:** Günlük kullanım değerleri modeli ve SaleVali kimliği için alan.

**Done when**
- `CustomerUsage { customerId, date, transactions, orders? }`, unique on
  `[customerId, date]`.
- `Customer.externalId` holds the SaleVali identifier agreed in T-9.1.1, unique
  and nullable.
- The change is additive.

**Prompt**

> Add the usage schema to the SaleVali Marketing CRM, following
> `docs/salevali-integration.md`.
>
> `CustomerUsage` with `customerId`, `date` (a day, not a timestamp),
> `transactions`, optional `orders`, unique on `[customerId, date]` so a
> re-sync overwrites rather than duplicates, cascading from `Customer`, indexed
> on `[customerId, date]` for the range queries the sparkline will run.
>
> Add `Customer.externalId` — nullable, `@unique` — for the SaleVali
> identifier. Nullable because customers imported from the spreadsheet may
> never have one, and a required column would make the import fail.
>
> Additive only; run `npx prisma db push` and confirm the schema guard is quiet.

---

### T-9.1.3 — Nightly sync job

`Task` · Priority **Low** · Effort **High**

**DE:** Nächtlicher Abgleich der Nutzungsdaten, robust gegen Ausfälle.
**TR:** Gecelik kullanım verisi senkronu, kesintilere dayanıklı.

**Done when**
- A `sync-usage` cron job fetches the last N days and upserts `CustomerUsage`.
- It re-fetches a small overlap window rather than only "since last run".
- Unmatched external ids are reported, not silently dropped.

**Prompt**

> Add a `sync-usage` job to the SaleVali Marketing CRM's cron registry that
> pulls per-account transaction counts from SaleVali and upserts them into
> `CustomerUsage`.
>
> Always re-fetch an overlapping window (the last 7 days, say) rather than only
> data since the last successful run. Syncs miss days — a failed job, a
> restarted container, a network blip — and "since last run" turns one missed
> night into a permanent hole in the chart. The unique key makes re-upserting
> idempotent.
>
> Report accounts whose `externalId` matches no customer as a count and a
> sample, rather than discarding them: that number is how you find out the
> import missed someone or a merchant signed up without anyone noticing.
>
> Also refresh `Customer.monthlyTransactions` from the trailing 30 days, so the
> revenue estimate stops being hand-typed — but never overwrite an explicitly
> recorded `mrr`.

---

### T-9.1.4 — Usage sparkline on the customer record

`Task` · Priority **Low** · Effort **Medium**

**DE:** Nutzungsverlauf als kleine Grafik auf der Kundenseite.
**TR:** Müşteri sayfasında küçük bir kullanım grafiği.

**Done when**
- The detail page shows the last 90 days of transactions as a compact chart.
- The synced 30-day total is shown next to the hand-entered figure when they
  disagree.
- No charting library is added.

**Prompt**

> Add a usage sparkline to the customer detail page of the SaleVali Marketing
> CRM: the last 90 days of `CustomerUsage.transactions` as a compact inline
> chart.
>
> Build it as an inline SVG polyline — no chart library, consistent with the
> funnel chart in epic 3. Include an accessible summary (`aria-label` with the
> trend and the totals) so it is not a picture with no meaning to a screen
> reader.
>
> When the synced 30-day total disagrees with the hand-entered
> `monthlyTransactions`, show both and label which is which. Quietly replacing
> an operator's number with a synced one destroys their trust in every other
> number on the page.

---

### T-9.1.5 — Churn-risk filter

`Task` · Priority **Low** · Effort **Medium**

**DE:** Filter für Kunden mit deutlich gefallenem Volumen.
**TR:** Hacmi belirgin düşen müşteriler için filtre.

**Done when**
- `/dashboard/customers` can filter to paying customers whose trailing 30-day
  volume dropped more than 40% against the previous 30.
- Customers with too little history are excluded, not counted as a drop.
- The threshold is a named constant.

**Prompt**

> Add a churn-risk filter to `/dashboard/customers` in the SaleVali Marketing
> CRM: paying customers whose trailing 30-day transaction volume is more than
> 40% below the preceding 30 days.
>
> Exclude anyone without at least 60 days of usage history. A customer who
> started three weeks ago has no "previous 30 days", and treating that as a
> 100% drop puts every new customer on the at-risk list, which is how a signal
> becomes noise nobody reads.
>
> Put the threshold in `src/lib/constants.ts` with a comment saying it is a
> guess to be tuned once there is data to tune it against. Show the percentage
> drop on the card so the number is inspectable rather than a mystery flag.

---

## Story 9.2 — Signup ingest

`Feature` · Priority **Low** · Effort **Medium**

**DE:** Neue Testkunden automatisch aus der SaleVali-Anmeldung übernehmen.
**TR:** Yeni deneme kullanıcılarını SaleVali kaydından otomatik al.

---

### T-9.2.1 — Ingest endpoint

`Task` · Priority **Low** · Effort **Medium**

**DE:** Endpunkt, den SaleVali bei einer Registrierung aufruft.
**TR:** SaleVali'nin kayıt anında çağıracağı endpoint.

**Done when**
- `POST /api/customers/ingest` creates a customer at `TRIAL_ACTIVE_500` with
  `source = WEBSITE_TRIAL`.
- It authenticates with a shared secret compared in constant time.
- The lifecycle dates and the initial `StageChange` come from the normal path.

**Prompt**

> Add `POST /api/customers/ingest` to the SaleVali Marketing CRM: the endpoint
> SaleVali calls when a merchant signs up, so a new trial appears in the CRM
> without anyone re-typing it.
>
> Authenticate with an `INGEST_SECRET` header compared using `timingSafeEqual`,
> failing closed when the secret is unset (copy the reasoning from the cron
> endpoint, not from `/api/health`). Validate the body with a zod schema in
> `src/lib/schemas.ts`.
>
> Create at `TRIAL_ACTIVE_500` with `source: WEBSITE_TRIAL`, going through
> `lifecycleTimestampsFor()` and writing the initial `StageChange` exactly as
> `POST /api/customers` does — a second write path that skips the audit trail
> is precisely what `CLAUDE.md` warns about. There is no session, so attribute
> `createdById` to a dedicated system user, seeded if absent.

---

### T-9.2.2 — Make ingest idempotent

`Task` · Priority **Low** · Effort **Medium**

**DE:** Wiederholte Aufrufe dürfen keine Dubletten erzeugen.
**TR:** Tekrarlanan çağrılar mükerrer kayıt oluşturmasın.

**Done when**
- A repeat call for the same signup updates the existing customer.
- Matching uses `externalId`, then VAT ID, then company + country.
- An ingest never moves a customer *backwards* in the funnel.

**Prompt**

> Make `POST /api/customers/ingest` idempotent in the SaleVali Marketing CRM.
> A webhook that retries — and they all do — must not create a second copy of
> the merchant.
>
> Match on `externalId` first, then the VAT ID, then company plus country,
> reusing the rule from the CSV importer rather than inventing a second one;
> extract it into `src/lib/matching.ts` and have both call it.
>
> One rule that matters more than the deduplication: an ingest must never move
> a customer backwards. If someone is already at `CUSTOMER_ACTIVE_700` and a
> retried signup webhook arrives, updating them to `TRIAL_ACTIVE_500` would
> corrupt the funnel and re-trigger trial reminders for a paying customer.
> Compare the numeric stage ordering and refuse to regress, logging when it
> happens.

---

### T-9.2.3 — End-to-end test for ingest

`Task` · Priority **Low** · Effort **Medium**

**DE:** E2E-Test für den Ingest-Endpunkt, inklusive Wiederholungen.
**TR:** Ingest endpoint'i için, tekrarlar dahil, E2E testi.

**Done when**
- A spec posts a signup twice and asserts one customer with one initial
  `StageChange`.
- An unauthenticated call is refused.
- A signup for an existing paying customer does not regress their stage.

**Prompt**

> Add `e2e/ingest.spec.ts` to the SaleVali Marketing CRM covering
> `POST /api/customers/ingest`.
>
> Three cases: an unauthenticated call is refused; the same signup posted twice
> produces exactly one customer with exactly one initial `StageChange`; and a
> signup naming a customer already at `CUSTOMER_ACTIVE_700` leaves their stage
> alone.
>
> That last one is the assertion worth writing — a retried webhook silently
> demoting a paying customer to a trial would restart their reminder emails and
> quietly corrupt the conversion reporting, and it is the kind of bug that is
> found months later in a report nobody trusts any more.
>
> Verify with Prisma via `e2e/helpers/db.ts`, use a unique prefix, clean up in
> `afterAll`.
