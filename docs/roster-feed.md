# The roster feed: fetch → parse → diff → dry run → apply (#1963 / #1965)

A tenant drops a CSV export of their people on an SFTP server, or serves it over HTTPS,
and we turn it into an accurate roster without a human in the loop. The parsing is the
easy half. The hard half is the **diff** — which row is new, which changed, which is
unchanged and must therefore not be touched at all — and doing it so that a retry after a
crash halfway through does not apply anything twice.

This document is the map. The code is the authority, and the two properties below are the
ones to preserve if you change any of it.

## Where the pieces live

| File | Owns |
|------|------|
| `src/lib/importPreview.ts` | **The engine and the vocabulary** (#2072): `runImport({ parse, validate, resolve, apply })`, `RowStatus` / `RowResult` / `ImportReport`, and the shared delimited parser. Free of Prisma, `next` and React. |
| `src/lib/rosterIngest.ts` | The feed layer: transport, the SHA-256 file hash, `diffRoster()`, chunked apply, the resume protocol. Also free of Prisma — it talks to ports. |
| `src/lib/rosterIngestStore.ts` | The only Prisma-aware file: `RosterRun` / `RosterRowResult`, one transaction per chunk, and the org-explicit entry point (`runRosterFeed`, `sweepRosterFeeds`). |
| `src/lib/externalSyncPolicy.ts` | What an external system may overwrite on a user — shared with SSO/SCIM sync (#1943), deliberately one policy and not two. |
| `prisma/schema.prisma` | `RosterFeed`, `RosterRun`, `RosterRowResult` (+ their enums). All three carry `orgId` and are registered in `TENANT_MODELS`. |
| `scripts/test/roster-ingest.test.mjs` | The suite that pins the parser fixtures, the diff, resume-after-crash, idempotency and two-tenant isolation. `npm run test:roster-ingest`. |

There is **one** parser and **one** dry-run engine in the tree. A second of either is the
bug this design exists to prevent — see below.

## The two properties that matter

**1. The dry run is honest.** A dry run is the same call with a writer that does not write
(`previewWriter`). Nothing is planned inside an `if (dryRun)` branch, so the preview is
produced by the code that applies. The old candidate importer built its report in one
branch and its writes in another, which is exactly how #1432 happened: dry run green, real
run 500 halfway through with rows already written.

**2. Resume means resume after a crash mid-batch.** The checkpoint is a column
(`RosterRun.nextChunkIndex`), committed in the **same transaction** as the chunk's writes
and its per-row results — not a counter in memory. It is *contiguous*: it never advances
past a chunk that failed, so a failed chunk is re-attempted on the next run rather than
skipped for ever. Re-attempting is safe because the plan is re-derived against the live
roster: a row an earlier attempt already wrote comes back `UNCHANGED`.

Two smaller ones follow from those:

- **An unchanged file is a no-op.** The fetched bytes are hashed (SHA-256); a hash equal to
  the last successful run's records a `NOOP` run and stops. An HR export that has not
  changed must not churn the roster (or its `updatedAt` column, or its audit trail).
- **Apply is idempotent.** A run is identified by `(feedId, fileHash, dryRun)`. The same
  file applied twice changes nothing the second time, and a `RUNNING` run younger than
  `DEFAULT_STALE_RUN_MS` (30 minutes) is left alone — two workers on one file is the
  double-apply the whole design refuses.

## Choose the key column: e-mail or external id

`RosterFeed.keyField` decides what identifies a person.

- `EMAIL` — the obvious choice, and the wrong one for any tenant whose people ever change
  their address. With e-mail as the key, one person renaming their mailbox is
  **indistinguishable** from a leaver plus a joiner: the old address lands in `absent[]`
  and the new one is a `CREATE`. Deprovisioning (#1966) acting on that `absent[]` would
  offboard somebody who is still employed.
- `EXTERNAL_ID` — the HR system's own personnel number (`User.externalId`). An e-mail
  change is then one `UPDATE`, which is what it is. Prefer it whenever the export carries
  a stable id.

An `EXTERNAL_ID` feed also **adopts** people who predate it: a row whose external id
matches nobody is matched by e-mail once, and the id is stamped in that same update. So
turning the id on for an existing tenant does not re-create their roster.

## What a run does, in order

1. `fetchFeedFile(feed)` — HTTPS through `assertPublicHttpsUrl()` (the URL is
   tenant-supplied and fetched from the server's network position, so SSRF is not
   hypothetical), `redirect: 'error'`, and an 8 MiB cap. SFTP checks the **pinned host key
   fingerprint** and refuses without one; the credential is read from the environment
   variable the feed *names* — never stored in the row, because a credential in a database
   row is a credential in every backup.
2. Hash the bytes. Equal to the last successful run's hash → record a no-op and stop.
3. `parseRoster` — the shared parser: quoted embedded newlines, CRLF, a UTF-8 BOM, `""`
   escapes, and a sniffed delimiter (`,` `;` `\t` `|`). A German or Turkish Excel export
   uses `;`, and a `RosterFeed.delimiter` value overrides the sniff.
4. `validateRosterRow` — map the columns, reject a row with no usable e-mail or no key
   value. A rejected row is an `ERROR`, never a guess.
5. `diffRoster` — `CREATE` / `UPDATE` / `UNCHANGED` / `SKIP` per row, plus `absent[]`:
   the people the roster holds and the feed never mentioned. An `UPDATE` writes only the
   fields `externalSyncPolicy` allows; a `withheld` list says which it left alone.
6. `applyRoster` (through `runImport`) — chunks of `chunkSize` (100 by default), one
   transaction each, each row's outcome persisted as it is applied. A row that throws is
   recorded `ERROR` and the chunk continues; a chunk that throws rolls back as a unit and
   the run carries on with the next one.

## Do not clobber what a human typed

`planFieldUpdates` (`src/lib/externalSyncPolicy.ts`) is the single answer, shared with SSO
sync:

- an empty stored field is a gap the feed may always fill;
- a non-empty stored field is the tenant's own data — a **non-authoritative** feed leaves
  it alone even when it disagrees (a user who fixed their own phone number must not have
  it reverted at 03:00) and reports it as `withheld`;
- an **authoritative** feed (`RosterFeed.authoritative`, the tenant saying "the HR system
  is the record of truth for these people") overwrites it;
- a column the feed does not carry — or carries empty — is *no opinion*, and is never
  written. We do not blank a field because a cell was left empty in a spreadsheet.

## Tenancy

A scheduled run has **no session**, so `withTenantScope(session, …)` is unavailable to it.
`runRosterFeed(feedId)` reads the feed row (the row is what says which tenant this is) and
then binds that org for the whole run with `runWithOrg(feed.orgId, …)`. The writer scopes
its `updateMany` by `(id, orgId)` on top of the middleware, and the suite proves with a
two-tenant fixture that a feed for org A can neither read nor write a row of org B.

## Not in this engine

- **Deprovisioning.** `absent[]` is computed, reported and stored on the run. Deciding to
  act on it — offboarding, archiving, closing a relation — is #1966, on purpose: a bug in
  the diff should cost a wrong report, not a wrong offboarding.
- **The admin surface and the schedule** (#1964): creating a feed, mapping its columns,
  the run log screen and the cron registration. The engine is callable from a route handler
  and from a scheduled job today (`runRosterFeed`, `sweepRosterFeeds`); nothing calls it
  yet.
- **The SFTP client.** The host-key pin is implemented and tested, but pulling in an SFTP
  dependency is its own reviewed change. Until then the transport refuses loudly rather
  than falling back to anything less safe, and `scripts/import-csv.mjs` stays the manual
  escape hatch.
