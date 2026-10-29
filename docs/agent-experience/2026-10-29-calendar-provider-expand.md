# 2026-10-29 — provider-neutral calendar tables, expand phase (#1989)

- **A "dangerous schema" issue can often ship its safe half alone.** #1989 asked to rename
  `GoogleCalendarConnection` (drop-and-recreate under `db push --accept-data-loss`). Adding
  NEW tables, moving every read/write to them, and leaving the old ones untouched as the
  rollback is purely additive (`check:schema-push` green). Only the contract (drop) needs the
  human gate.
- **A backfill that copies into a table the code now writes must be `once: true`.** Otherwise a
  person who disconnects (deleting the new row) is silently reconnected on the next deploy from
  the stale old row. Insert-only (`createMany({ skipDuplicates: true })`) also keeps a manual
  re-run from overwriting a token refreshed since.
- **A spec that never calls the app can skip the dev server:** `BASE_URL=http://127.0.0.1:9`
  makes `playwright.config.ts` treat the target as external and start no `webServer`.
- **`check:text-limits` was red on `main` for `Organization.sso*`** while this ran — not this
  change; check `git stash` + rerun before chasing it.
- **A second provider is the moment to extract the interface, not before.** #1991 put
  `CalendarSyncProvider` in front of the existing loop: the only provider-shaped parts are
  `writeEvent` / `deleteEvent` / `accessTokenFor`; create-vs-patch, dead-pointer cleanup and
  error recording stay in the one loop. Keeping the old module name (`googleCalendarSync.ts`)
  meant no call site changed.
- **Graph wants a local wall clock plus a zone name.** Compute it with `Intl.DateTimeFormat`
  `formatToParts` in the zone (`hourCycle: 'h23'`); a DST-night unit case (00:30→03:30 UTC on the
  last Sunday of October) catches the off-by-an-hour bugs a same-zone test cannot.
- **Account erasure must know every provider.** `accountErasure.ts` called Google's disconnect
  only; a new token store needs its own call there and in `check-erasure-coverage`'s file list.
