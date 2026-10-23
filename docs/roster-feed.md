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
| `src/lib/rosterFeed.ts` | **The configuration rules** (#1964): the vocabulary (transports, key fields, mappable columns), `validateFeedConfig()`, `resolveColumns()`, and the UTC cron parser (`parseCron` / `cronMatches` / `nextCronRun`). Pure and client-safe. |
| `src/lib/rosterFeedAdmin.ts` + `/api/admin/roster-feeds` | The admin CRUD: the sealed secret going in, `secretSet` coming out. |
| `src/lib/externalSyncPolicy.ts` | What an external system may overwrite on a user — shared with SSO/SCIM sync (#1943), deliberately one policy and not two. |
| `prisma/schema.prisma` | `RosterFeed`, `RosterRun`, `RosterRowResult` (+ their enums). All three carry `orgId` and are registered in `TENANT_MODELS`. |
| `scripts/test/roster-ingest.test.mjs` | The suite that pins the parser fixtures, the diff, resume-after-crash, idempotency and two-tenant isolation. `npm run test:roster-ingest`. |

There is **one** parser and **one** dry-run engine in the tree. A second of either is the
bug this design exists to prevent — see below.

The roster feed is the engine's first consumer, not its only one. The **marketing account
import** (#2391) is the second: same `runImport`, same parser, its own four hooks in
`src/lib/marketingImport.ts` / `src/lib/marketingImportStore.ts`, its column contract in
[`marketing-import.md`](marketing-import.md). Read that one for the worked example of
adding a consumer, and its [**Running it**](marketing-import.md#running-it) section for
the operator's side of a by-hand import against real data: the backup first, choosing
`--owner`, the dry run, reading the report, fixing the rows it refuses, and `--apply`.

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
   fingerprint** and refuses without one. The feed's secret (SFTP password or key, or the
   HTTPS bearer token) is resolved at fetch time by `resolveFeedSecret()`: the sealed
   `secretEnc` column first, else the environment variable the feed *names* — see
   [The feed's secret](#the-feeds-secret).
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

## Configuring a feed (#1964)

`/api/admin/roster-feeds` (list, create) and `/api/admin/roster-feeds/[id]` (read, edit,
delete) are ADMIN-only, run inside the tenant scope and filter every query by the caller's
org as well; another org's feed answers **404** on every verb. Every write goes through
`validateFeedConfig()`, which reports all problems at once and refuses:

- a `cronExpression` it cannot parse. Five fields (minute hour day-of-month month
  day-of-week), numbers / `*` / ranges / steps / lists, **evaluated in UTC**; when both day
  fields are restricted either one matches (classic cron). Null means "run by hand only".
- a transport without its own fields — HTTPS needs an `https://` URL without credentials
  in it (and the URL must pass the SSRF guard at save time, not only at fetch time); SFTP
  needs host, username, path **and the pinned host key fingerprint**;
- a `columnMap` with no `email` mapping, an `EXTERNAL_ID` feed without an `externalId`
  mapping, or a mapping for a field we do not have (it would be ignored, and an ignored
  mapping reads as a working one).

An edit is validated as the **whole merged config**, so a PATCH that switches the transport
cannot leave the new one's requirements unchecked. `resolveColumns(header, columnMap)` is
the same trimmed, case-insensitive header match the engine reads with, so the console's
"column not found" and a run cannot disagree.

### The feed's secret

The secret goes in as `secret` on a create or an edit and is stored only as
`seal(secret, 'roster-feed-secret')` (`src/lib/secretBox.ts`, AES-256-GCM, a key of its own).
Nothing returns it: the API answers `secretSet: boolean` (the `ssoCertificateSet` pattern),
the activity trail records "secret replaced/cleared" without the value, and
`clearSecret: true` removes it. The only reader is the run, at fetch time. A sealed value
that no longer opens (the server secret rotated, a row copied between environments) fails
the run with "enter it again" rather than fetching without it.

`credentialEnvVar` remains for an operator who wants the secret out of the database
altogether; the sealed column wins when both are set.

The route is on the public demo's write blocklist (`src/lib/demoMode.ts`): it stores a real
remote credential.

### Retention

`RosterRowResult` grows by the size of the roster on every run. The one retention job
(`rosterRowResult` in `src/lib/retentionEntries.ts`) deletes row-level results older than
**90 days**; `RosterRun` summaries are kept indefinitely.

## The console and the schedule (#1967)

`/admin/roster-feeds` lists each feed with its schedule, its next run (computed in UTC,
shown in the viewer's zone), its last run and whether it is on, off or paused. From there an
admin can:

- create or edit a feed. The **column mapper** reads a pasted or uploaded sample, offers the
  file's own header names, and reads them with the parser the run uses;
- **Run now (dry run)**: the same run with a writer that does not write;
- **Run now**;
- open a feed's **run history**, and from it a **run detail** whose per-row outcomes
  (`RosterRowResult`) can be filtered by action, paged, and exported as CSV
  (`?format=csv`; cells starting with `= + - @` are neutralised);
- **Approve and apply** a run the deactivation ceiling stopped (#1966). Approval lifts that
  valve only, and only for the file the admin looked at: the run is fetched again with the
  stopped run's hash expected. It is audited (`roster.run_approved`) and stamped
  (`RosterRun.approvedById`). A row-floor stop cannot be approved; fix the export instead.

A failed or stopped last run shows a banner until an admin dismisses it
(`RosterRun.acknowledgedAt`).

Every route under `/api/admin/roster-feeds/*` is ADMIN-only and runs in the tenant scope with
the org in every `where`. Another org's feed or run answers **404** to read, run, approve
and acknowledge alike (`e2e/roster-feeds-console.spec.ts` checks this through the API).

### Running exactly once: the claim

`src/lib/rosterFeedRunner.ts` runs a feed only under its **claim**. The claim is one
conditional UPDATE (`RosterFeed.claimedUntil`: empty or expired, set to now + 35 minutes).
Whoever's UPDATE matched runs; everyone else gets `claimed_elsewhere`, which the console shows
as a 409 "already running". The claim covers the waker on two replicas, a waker tick racing a
click, and two admins clicking at once. It is cleared when the run ends and expires on its own
when a process dies.

### The waker

There is **one** queued job, `roster.sweep`, every five minutes (`src/lib/jobs/schedules.ts`,
run by #1676's scheduler under the `'scheduler'` lease, handler in `src/jobs/index.ts`). It
runs each enabled feed whose `cronExpression` is due (`isFeedDue`: the first scheduled minute
after `lastRunAt`, or after creation, has passed). A late tick therefore runs a due feed once,
not once per missed slot. There is no timer per feed.

### Failures pause a feed

A run that throws (a transport error, a credential) or ends `FAILED` increments
`consecutiveFailures`. A successful run resets it. A safety stop neither counts nor resets:
there the file was wrong, not the feed. On the **third** failure in a row the feed is
switched off with `pausedReason`, so a broken credential does not retry forever against a
customer's server. A failure alert goes to `ALERT_EMAIL_TO` and the org's `supportEmail`.
Switching the feed back on clears the reason and the streak.

The e2e suite reaches a local HR-export stub (`e2e/support/roster-source.mjs`) through the
real transport. `ROSTER_FEED_ALLOW_INSECURE_STUB=1` admits exactly `http://127.0.0.1:…` for
it. That switch is set only by `playwright.config.ts` and never on a deployment.

## Not in this engine

- **Deprovisioning** (#1966) is a separate phase after the import, with its own rules and
  four safety valves: [`roster-feeds.md`](roster-feeds.md). The engine only hands it the
  diff's `absent` people. It runs only after a run whose every row was read, and its
  ceiling is checked before the first chunk is applied, so a valve that fires leaves
  nothing written.

- **Row-level retry.** A row that throws is recorded `ERROR` and its chunk still commits, so
  the checkpoint moves past it. Re-running the *same* file therefore resumes at the end and
  changes nothing: the errored row is retried when the file next changes (the plan is
  re-derived, so it comes back as the `CREATE`/`UPDATE` it always was), not on the next
  night. That is deliberate for now — retrying individual rows means deciding how many
  times and how far apart, which is a feature and not a detail of the checkpoint. The run
  stays `FAILED` and its `RosterRowResult` rows say exactly which keys are outstanding.
- **The SFTP client.** The host-key pin is implemented and tested, but pulling in an SFTP
  dependency is its own reviewed change. Until then the transport refuses loudly rather
  than falling back to anything less safe, and `scripts/import-csv.mjs` stays the manual
  escape hatch.
