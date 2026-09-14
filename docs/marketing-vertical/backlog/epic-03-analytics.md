# Epic 3 — See the funnel

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

`Feature` · Priority **High** · Effort **Medium**

**DE:** Trichter, Konversion und Umsatz sichtbar machen — die Daten liegen schon vor.
**TR:** Huniyi, dönüşümü ve geliri görünür kıl — veri zaten birikiyor.

`StageChange` records every lifecycle transition with a timestamp, an author and
an optional reason. Nothing reads it. That means conversion rate, time in stage
and churn are all computable today from data already in the database — this epic
is almost entirely reading, with no new write paths to get wrong.

Start it once a few weeks of transitions have accumulated; a funnel chart of
three customers teaches nobody anything.

---

## Story 3.1 — The metrics themselves

`Feature` · Priority **High** · Effort **Medium**

**DE:** Kennzahlen aus `StageChange` berechnen, getrennt von der Darstellung.
**TR:** Metrikleri `StageChange`'ten hesapla, gösterimden ayrı tut.

---

### T-3.1.1 — `src/lib/analytics.ts` skeleton and date-range helper

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Modul für Kennzahlen anlegen, inklusive Zeitraum-Hilfsfunktion.
**TR:** Metrik modülünü ve tarih aralığı yardımcısını oluştur.

**Done when**
- `src/lib/analytics.ts` exists with a `DateRange` type and
  `rangeFor(preset)` covering last 30 days, this quarter, this year, all time.
- Every metric function will take a `DateRange`, so no caller invents its own.
- Boundaries are inclusive at the start, exclusive at the end, and that is
  written down.

**Prompt**

> Create `src/lib/analytics.ts` in the SaleVali Marketing CRM as the home for
> funnel metrics — all reads over `StageChange` and `Customer`, no writes.
>
> Start with the shared plumbing: a `DateRange { from: Date; to: Date }` type
> and `rangeFor(preset: "30d" | "quarter" | "year" | "all", now: Date)`.
> Half-open intervals — `from` inclusive, `to` exclusive — and say so in a
> comment, because an off-by-one day here silently misreports a month boundary.
> Take `now` as a parameter so the functions are testable.
>
> No metric implementations in this task; just the module, the type and the
> helper, with a short doc comment explaining that everything in this file is
> derived from the audit trail rather than stored.

---

### T-3.1.2 — Trial → paying conversion rate

`Task` · Priority **High** · Effort **Medium**

**DE:** Konversionsrate von Testphase zu zahlendem Kunden, pro Monat.
**TR:** Denemeden ödeyen müşteriye dönüşüm oranı, aylık.

**Done when**
- `conversionByMonth(range)` returns, per month, how many customers entered
  `TRIAL_ACTIVE_500` and how many of those later reached
  `CUSTOMER_ACTIVE_700`.
- Cohorts are keyed on the month the trial **started**, not the month of
  conversion — otherwise the rate reads above 100%.
- Covered by a test with a customer who converts in a later month.

**Prompt**

> Implement `conversionByMonth(range)` in `src/lib/analytics.ts` of the
> SaleVali Marketing CRM: for each month in the range, how many customers
> entered `TRIAL_ACTIVE_500`, how many of those later reached
> `CUSTOMER_ACTIVE_700`, and the resulting rate.
>
> The subtlety worth getting right: cohort by the month the **trial started**,
> not the month of conversion. Counting conversions in the month they happen
> against trials started that same month produces rates over 100% whenever
> people convert late, and it is the classic way this metric ends up quietly
> wrong. Put that reasoning in a comment.
>
> Read from `StageChange`, not from the customer's current stage — a customer
> who has since churned still converted. Test with a trial started in January
> that converts in March.

---

### T-3.1.3 — Median time in each stage

`Task` · Priority **High** · Effort **Medium**

**DE:** Mediane Verweildauer je Trichterstufe.
**TR:** Her huni aşamasında geçen medyan süre.

**Done when**
- `timeInStage(range)` returns, per `LifecycleStage`, the median days between
  entering it and leaving it.
- Customers still sitting in a stage are excluded from the median but reported
  separately as "still open".
- Median, not mean — one abandoned prospect from 2024 must not move the number.

**Prompt**

> Implement `timeInStage(range)` in `src/lib/analytics.ts` of the SaleVali
> Marketing CRM: per lifecycle stage, the median number of days customers spend
> there.
>
> Pair up consecutive `StageChange` rows per customer, ordered by `changedAt`,
> to get an entered/left interval for each stage. Customers currently sitting
> in a stage have no exit, so exclude them from the median and return their
> count separately as `stillOpen` — dropping them silently makes a stalling
> funnel look healthy.
>
> Median rather than mean, deliberately: one prospect nobody ever touched again
> would drag an average into uselessness. Note that in a comment. Test with a
> handful of hand-built intervals including an even and an odd count.

---

### T-3.1.4 — Conversion by source and by campaign

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Konversion nach Herkunft und Kampagne aufschlüsseln.
**TR:** Dönüşümü kaynağa ve kampanyaya göre kır.

**Done when**
- `conversionBySource(range)` and `conversionByCampaign(range)` return counts
  and rates per `CustomerSource` / campaign.
- Sources with no customers in the range are omitted, not shown as 0/0.
- Customers with no campaign are grouped as "No campaign" rather than dropped.

**Prompt**

> Add `conversionBySource(range)` and `conversionByCampaign(range)` to
> `src/lib/analytics.ts` in the SaleVali Marketing CRM: how many customers came
> in through each `CustomerSource` (and each `Campaign`), and how many of them
> became paying customers.
>
> This is the number that decides where marketing spends its time, so make it
> honest: omit sources with no customers in the range instead of listing them
> as 0/0, and group customers with no campaign under an explicit "No campaign"
> bucket rather than dropping them — the untracked share is itself worth
> seeing. Reuse the cohort logic from `conversionByMonth` rather than
> duplicating it.

---

### T-3.1.5 — Recurring revenue over time

`Task` · Priority **Medium** · Effort **Medium**

**DE:** MRR-Verlauf aus zahlenden Kunden je Monatsende.
**TR:** Ay sonu ödeyen müşterilerden MRR trendi.

**Done when**
- `mrrByMonth(range)` returns, per month end, the summed revenue of customers
  paying at that moment.
- Explicit `mrr` wins; otherwise the tiered estimate from
  `estimateMonthlyRevenue()` is used, and the two are reported separately.
- Reconstructed from `StageChange`, so past months do not change when a
  customer churns today.

**Prompt**

> Implement `mrrByMonth(range)` in `src/lib/analytics.ts` of the SaleVali
> Marketing CRM: monthly recurring revenue at the end of each month in the
> range.
>
> Who counted as paying at a past month end has to come from `StageChange`, not
> from today's `stage` — otherwise last quarter's revenue silently drops every
> time someone churns, and the chart rewrites its own history. Reconstruct the
> paying set per month end from the audit trail.
>
> For each paying customer use the recorded `mrr` when present, otherwise
> `estimateMonthlyRevenue(pricingModel, monthlyTransactions)` from
> `src/lib/lifecycle.ts`. Return the two totals separately (`recorded`,
> `estimated`) as well as the sum, so nobody presents a guess as a measurement.

---

## Story 3.2 — The analytics page

`Feature` · Priority **High** · Effort **Medium**

**DE:** Eine Seite, die die Kennzahlen zeigt — ohne Chart-Bibliothek.
**TR:** Metrikleri gösteren bir sayfa — grafik kütüphanesi olmadan.

---

### T-3.2.1 — Page shell and navigation entry

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Route, Seitengerüst und Eintrag in der Navigation.
**TR:** Route, sayfa iskeleti ve menü girişi.

**Done when**
- `/dashboard/analytics` renders a titled page with placeholder sections.
- The sidebar has an "Analytics" entry with a lucide icon, active-state styling
  matching the others.
- An e2e spec asserts a signed-in user can reach it.

**Prompt**

> Add `/dashboard/analytics` to the SaleVali Marketing CRM: for now just the
> page shell — heading, short explanatory line, and empty sections for
> "Funnel", "Conversion", "Revenue".
>
> Add an "Analytics" item to `src/components/Sidebar.tsx` using a lucide icon
> (`TrendingUp` fits), following exactly how the existing entries handle the
> active state. Mark the page `export const dynamic = "force-dynamic"` like the
> other dashboard pages.
>
> Add a case to an e2e spec asserting a signed-in user can open it and sees the
> heading. No metrics in this task.

---

### T-3.2.2 — Stat tiles for the headline numbers

`Task` · Priority **High** · Effort **Low** · `good first issue`

**DE:** Kacheln für Konversionsrate, MRR, aktive Testphasen, Churn.
**TR:** Dönüşüm oranı, MRR, aktif deneme ve churn için kutucuklar.

**Done when**
- Four tiles: trial→paying conversion, current MRR, active trials, customers
  churned in the range.
- They reuse the tile markup already on `/dashboard` rather than inventing a
  second style.
- Currency goes through `formatCurrency()`.

**Prompt**

> Add the headline stat tiles to `/dashboard/analytics` in the SaleVali
> Marketing CRM: trial→paying conversion rate, current recurring revenue,
> active trials, and customers churned in the selected range.
>
> Reuse the tile markup from `src/app/dashboard/page.tsx` — the dashboard
> already has this pattern and a second visual style for the same idea is how
> a UI starts to look assembled from parts. Format money with
> `formatCurrency()` from `src/lib/lifecycle.ts` (de-DE, EUR) and percentages
> with one decimal place.
>
> Read the numbers from `src/lib/analytics.ts`; do not query Prisma from the
> page directly.

---

### T-3.2.3 — Funnel chart in plain CSS

`Task` · Priority **High** · Effort **Medium**

**DE:** Trichter als CSS-Balken darstellen, ohne zusätzliche Abhängigkeit.
**TR:** Huniyi ek bağımlılık olmadan CSS çubuklarıyla göster.

**Done when**
- A horizontal bar per lifecycle stage, width proportional to the count, in
  `LIFECYCLE_STAGE_ORDER`.
- Each bar shows the count and the drop-off from the previous stage.
- No charting library is added.

**Prompt**

> Add a funnel visualisation to `/dashboard/analytics` in the SaleVali
> Marketing CRM: one horizontal bar per lifecycle stage, ordered by
> `LIFECYCLE_STAGE_ORDER` from `src/lib/constants.ts`, width proportional to
> the number of customers.
>
> Build it with Tailwind and a percentage width — no chart library. The
> dependency tree here is deliberately small, and one bar chart does not
> justify adding to it; say so in a comment so the next person does not "fix"
> it by installing one.
>
> Label each bar with the stage name, the count, and the drop-off from the
> stage above (`-42%`). Keep the terminal stages (lost, churned, disqualified)
> visually separate from the main funnel — they are outcomes, not steps.

---

### T-3.2.4 — Conversion and revenue tables

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Tabellen für Konversion nach Monat/Herkunft und den MRR-Verlauf.
**TR:** Aya/kaynağa göre dönüşüm ve MRR trendi tabloları.

**Done when**
- A month-by-month conversion table and a source breakdown are rendered.
- MRR per month shows recorded and estimated separately.
- Tables scroll horizontally on small screens instead of breaking the layout.

**Prompt**

> Render the conversion and revenue sections of `/dashboard/analytics` in the
> SaleVali Marketing CRM, using `conversionByMonth`, `conversionBySource` and
> `mrrByMonth` from `src/lib/analytics.ts`.
>
> Three tables: conversion by month (trials started, converted, rate),
> conversion by source, and MRR by month with `recorded` and `estimated` in
> separate columns plus a total — presenting an estimate as a measurement is
> the one thing this page must not do.
>
> Follow the table styling already used on `/dashboard/contacts`, and wrap each
> in an `overflow-x-auto` container so a narrow screen scrolls the table
> instead of the page.

---

### T-3.2.5 — Date-range filter

`Task` · Priority **Medium** · Effort **Medium**

**DE:** Zeitraum-Auswahl, die die ganze Seite steuert.
**TR:** Tüm sayfayı yöneten tarih aralığı seçimi.

**Done when**
- A preset selector (30 days / quarter / year / all time) drives every section.
- The choice lives in the URL, so a view can be shared or bookmarked.
- The default is the last 30 days.

**Prompt**

> Add a date-range filter to `/dashboard/analytics` in the SaleVali Marketing
> CRM: a preset selector for last 30 days, this quarter, this year and all
> time, defaulting to 30 days.
>
> Put the selection in the URL as a search param and read it server-side with
> `searchParams`, the way `/dashboard/customers` already handles its filters —
> a range you cannot link to is a range nobody shares in a discussion. Validate
> the param against the allowed presets and fall back to the default rather
> than throwing on a hand-edited URL.
>
> Pass the resulting `DateRange` into every metric call on the page.

---

### T-3.2.6 — Export the current view as CSV

`Task` · Priority **Low** · Effort **Low** · `good first issue`

**DE:** Aktuelle Auswertung als CSV herunterladen.
**TR:** Mevcut görünümü CSV olarak indir.

**Done when**
- A button downloads the tables of the current range as CSV.
- The endpoint requires a session, like every other API route.
- The filename carries the range, e.g. `funnel-2026-Q3.csv`.

**Prompt**

> Add a CSV export to `/dashboard/analytics` in the SaleVali Marketing CRM:
> `GET /api/analytics/export?range=...` returning the conversion and MRR tables
> for that range as CSV, with a download button on the page.
>
> Check the session and return `401` without one — `e2e/auth.spec.ts` asserts
> that every API route does this, so a route that forgets fails the gate. Set
> `Content-Disposition` with a filename that includes the range so a folder of
> exports is still readable a month later. Escape values properly: company
> names contain commas and quotes.

---

## Story 3.3 — Churn

`Feature` · Priority **Medium** · Effort **Medium**

**DE:** Verstehen, wer abwandert und warum.
**TR:** Kimin neden ayrıldığını anla.

---

### T-3.3.1 — Churn by cohort

`Task` · Priority **Medium** · Effort **High**

**DE:** Abwanderung nach Startmonat der Kunden.
**TR:** Müşterinin başladığı aya göre churn.

**Done when**
- `churnByCohort(range)` groups customers by the month they converted and
  reports how many had churned by 1, 3, 6 and 12 months.
- Cohorts too young for a bucket show "—", not 0%.
- The page renders it as a triangle table.

**Prompt**

> Implement `churnByCohort(range)` in `src/lib/analytics.ts` of the SaleVali
> Marketing CRM and render it on the analytics page: customers grouped by the
> month they reached `CUSTOMER_ACTIVE_700`, with the share churned by 1, 3, 6
> and 12 months after that.
>
> The detail that decides whether this table is trustworthy: a cohort from two
> months ago has no 6-month number yet. Render those cells as "—", never as 0%
> — a cohort table that shows zeros for immature buckets reads as excellent
> retention and is simply false. Put that in a comment next to the code that
> decides it.
>
> Reconstruct both dates from `StageChange`.

---

### T-3.3.2 — Aggregate churn reasons

`Task` · Priority **Low** · Effort **Medium**

**DE:** Angegebene Kündigungsgründe zusammenfassen.
**TR:** Girilen churn gerekçelerini bir arada göster.

**Done when**
- The notes attached to `CHURNED_900` and `CANCELLATION_NOTICE_800` transitions
  are listed with their customer and date.
- Transitions recorded without a note are counted, so the gap is visible.
- No attempt at automatic categorisation.

**Prompt**

> Add a churn-reasons section to `/dashboard/analytics` in the SaleVali
> Marketing CRM: the free-text notes operators wrote on `CHURNED_900` and
> `CANCELLATION_NOTICE_800` transitions, newest first, each with the company
> and the date.
>
> Do **not** try to categorise them automatically — with a few dozen churns a
> human reading ten sentences learns more than any bucketing would give, and a
> wrong taxonomy is worse than none. Instead, count the transitions recorded
> with no note at all and show that as "N churns with no reason recorded", so
> the missing input is visible and can be nagged about.
