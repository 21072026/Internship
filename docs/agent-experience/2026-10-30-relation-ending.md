# 2026-10-30 — ending-soon nudge and one-click extend (#1786)

- **A new public event moves a pinned list.** `e2e/domain-event-catalog.unit.spec.ts`
  pins `WEBHOOK_EVENTS` in order (`PUBLISHED`) and keeps one sample payload per
  producer (`PRODUCERS`). Append new public entries at the END of the public
  block in `src/lib/events/catalog.ts` and add them to both lists in the spec.
- **A new daily job touches four places:** `registerJob()` in `src/jobs/*.ts`,
  `queue({...})` in `src/lib/jobs/schedules.ts`, the `JobPayloads` map AND the
  name list in `src/lib/jobs/types.ts`, and (to run it by hand)
  `src/lib/jobs/manualJobs.ts` + the inline branch in `/api/cron`.
- **A new mail category** needs a group in `src/lib/emailGroups.ts` and an entry
  in `OUTBOUND_CATEGORIES` (`src/lib/outboundApprovalRule.ts`); its dedupe key
  goes through `dedupeKeyFor()` (`src/lib/mailDeliveryRule.ts`), not a string.
- **A one-click mail action that mutates must be replay-proof.** Bind the token
  to the state it was minted for (here: the announced end date) and guard the
  write on it; the signature alone does not stop a second click.
- **Hand-started `next start` lacks the e2e webServer env** (`INBOUND_SECRET`
  and friends from `playwright.config.ts`): `email-actions` "reply" fails
  against it for that reason alone. Export those before starting the server.
