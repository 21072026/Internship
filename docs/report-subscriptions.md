# Report subscriptions (#1905)

A named report from the registry ([reports.md](reports.md)) mailed on a cadence
to **one** recipient: a user of the org, or an address with no account (a dean,
a funder, a sponsor) who leaves through a signed link.

| File | Role |
|------|------|
| `prisma/schema.prisma` → `ReportSubscription`, `ReportSubscriptionSend` | The subscription and one row per delivered period (both tenant models) |
| `src/lib/reportSubscriptions.ts` | The rules, pure and client-safe: validity, `periodKey`, `isDue` |
| `src/lib/reportSubscriptionTokens.ts` | Server-only: the HMAC unsubscribe token and link |
| `src/lib/jobs/reportSubscriptions.ts` | The sender — `runReportSubscriptions()`, `sendReportSubscription()`, the hourly cron |
| `src/lib/reportSubscriptionAdmin.ts` | Who may manage them and the write-time checks |
| `/api/admin/report-subscriptions` (+ `/[id]`, `/[id]/test`) | Admin CRUD and "send me a test" |
| `/reports/unsubscribe` + `POST /api/report-subscriptions/unsubscribe` | The account-less way out |
| `src/lib/analyticsReports.ts` | The cohort / source / mentor computations, sessionless, shared by the screens, the registry and this job |

## Rules

- **Valid when written.** An unknown report, a report this org's vertical does
  not carry, an impossible schedule, a CSV/XLSX format without `REPORT_EXPORT`
  and a user recipient from another tenant are refused by the API (400/403) —
  never discovered by the job with nobody watching.
- **Gated.** Managing subscriptions needs ADMIN + `ADVANCED_ANALYTICS`. The job
  re-checks at send time (a downgraded org stops receiving; the row says
  `locked`), and a file additionally `REPORT_EXPORT`.
- **Due** from the subscription's hour (UTC) on its day until the end of that
  day — a job that missed the exact hour still sends that day. Weekly = ISO
  weekday 1–7; monthly/quarterly = day 1–28 (quarterly: Jan/Apr/Jul/Oct).
- **Once per period.** The job inserts `ReportSubscriptionSend(subscriptionId,
  periodKey)` *before* reading or sending; a retry, a second firing or a second
  replica collides on the unique and sends nothing. A send that fails after the
  claim is `FAILED` and is not retried in that period — a missed report is
  recoverable, a duplicate to a funder is not.
- **Opt-outs hold.** A user recipient keeps the `analytics-report` per-user
  opt-out (and gets the central footer); an external address is checked
  against the org's `ContactSuppression` e-mail block list and carries its own
  signed link in the body and as `List-Unsubscribe`.
- **No enum keys.** The mail is rendered in the subscription's language with
  the tenant's stage labels and the registry's privacy floor.
- **Tests** go to the admin who asks, under a `test-<ms>` period, and never
  take the place of a real period.

## Running it

Hourly at :25 via node-cron, registered from `/api/cron/start` (not
`initCronJobs`) until the leader-elected scheduler (#1676) takes it as a plain
handler. An admin can fire their own org's due subscriptions with
`GET /api/cron?job=report-subscriptions` (`&at=<ISO>` pins the clock).

## Not yet

- The admin screen (`/admin/reports/subscriptions`) — follow-up PR.
- Retiring `sendWeeklyAnalyticsReport()` into a seeded weekly subscription per
  org — follow-up PR; until then both exist and the old one is unchanged.
