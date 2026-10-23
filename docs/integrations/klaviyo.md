# Klaviyo: profiles in, leads out — read-only

A MARKETING organization can connect its Klaviyo account. Every Klaviyo profile then
becomes a lead on the organization's funnel and is kept in step every 15 minutes.
Alongside the profiles the connector also reads the account's lists, segments and their
members, metrics, events, campaigns (with their statistics) and flows
([Beyond profiles](#beyond-profiles)).
**The connector only reads.** Nothing is ever written back to Klaviyo, and no lead is
ever e-mailed by it.

| File | Owns |
| --- | --- |
| `src/lib/klaviyoRule.ts` | The pure rules: the wire format (paths, headers, the pinned revision), the profile → lead mapping, the cursor, the backoff. Zero imports; `scripts/test/klaviyo-rule.test.mjs`. |
| `src/lib/klaviyoClient.ts` | The HTTP half: GET only, one fixed host, time- and size-bounded, one retry. |
| `src/lib/klaviyoSync.ts` | The Prisma half and the **only writer** of `ExternalConnection` / `ExternalProfileLink`: a page of profiles through the shared import engine, the run, the 15-minute tick. |
| `src/lib/klaviyoKey.ts` | Where a connection's key comes from: sealed in the database, or the server environment (fingerprint only). |
| `src/lib/klaviyoResourceRule.ts` | The pure rules beyond profiles: paths, mapping, schedule, pass. Zero imports; `scripts/test/klaviyo-resource-rule.test.mjs`. |
| `src/lib/klaviyoResources.ts` | The **only writer** of `ExternalSyncState` and the resource tables (`ExternalAudience`, `…Member`, `ExternalMetric`, `ExternalEvent`, `ExternalCampaign`, `…Message`, `…Stat`, `ExternalFlow`). |
| `src/app/api/admin/integrations/klaviyo/**` | The admin routes (connect, test, sync now, preview, pause, disconnect). |
| `src/components/admin/KlaviyoCard.tsx` | The card on `/admin/integrations` (MARKETING only). |
| `e2e/klaviyo-connector.spec.ts` + `e2e/support/klaviyo-mock.mjs` | End-to-end against a local stand-in of the API. No test ever calls Klaviyo. |
| `scripts/test/klaviyo-client.test.mjs` | The client with an injected fetch: headers, revision, pagination, 429 / 5xx / network retry, pacing, the POST allowlist. |

## Setting it up

1. In Klaviyo: **Settings → API keys → Create private API key**. Choose custom/read-only
   access and grant exactly these scopes, read only:
   - `profiles:read` — the profiles themselves (required);
   - `lists:read`, `segments:read` — lists, segments and their members (and the name of
     the list a person subscribed through);
   - `metrics:read`, `events:read` — metrics and the allow-listed events;
   - `campaigns:read` — campaigns, their messages and their statistics;
   - `flows:read` — flows.

   Only `profiles:read` is required; a resource whose scope is missing records
   `forbidden` on its own line and everything else keeps syncing. Nothing else: the
   connector never needs a write scope, and a key that has one is a key that could do
   more than this product ever asks of it.
2. In the CRM, as an ADMIN of the MARKETING organization: **Integrations → Klaviyo**,
   paste the key (it starts with `pk_`; the six-character public key is refused), **Test
   connection**, **Save key**. Saving tests the key again and stores it sealed.
3. Optional: **Preview the first profiles** — the first 25 profiles, mapped and planned
   by the same code a sync runs, with a writer that writes nothing.
4. **Sync now**, or wait for the next 15-minute tick.

### Who owns a new lead

**Nobody, until somebody takes it.** The connector writes the account, the lead person
and the provider link, but it opens **no funnel record**: `createMarketingAccountsBatch`
runs with `leadOnly`. A machine does not decide whose book a lead lands on.

- **The pool.** Every sales rep of the org sees the unassigned leads on `/sales`, newest
  first (`GET /api/sales/pool`, `src/lib/leadClaim.ts`). **Take it**
  (`POST /api/sales/pool/[id]/claim`) puts one on the taker's own book at the org's first
  stage. A pool lead is a stand-in lead of the org, linked to an account, with no record
  at all. A lead whose record somebody closed is not in the pool: re-opening it is an
  admin's transfer.
- **One owner under a race (#419).** The claim locks the lead's row before it asks
  whether a record exists, so of two simultaneous takers one gets the record and the
  other gets `409 taken`. A lead of another org answers 404.
- **Admins** still assign through the usual assignment, and the admin candidate list
  shows the lead as unassigned.
- After the quiet first import, a run that created leads rings every active ADMIN and
  MENTOR of the org once. Admins are linked to the filtered accounts list, reps to the
  pool.
- The writer still plans the run as a user of the org (its activity actor): the default
  lead owner, else the admin who connected, else any active admin. None of them owns the
  leads. With no admin at all the run records `no_owner`.

**A lead is a record, never a login.** Its user row keeps the generated stand-in address
(`import.local`, never mailed, no password), and the real address is the account's
contact e-mail. The admin candidate page and list show the real one
(`src/lib/leadEmail.ts`; `GET /api/users/[id]` returns `leadRecord` + `contactEmail`).
A marketing lead gets no activation panel and no password-reset button. On top of that,
the customer-mail lock (`docs/mail-queue.md`) stops every mail to it during the test
phase.

### Phones

A profile's `phone_number` is the lead's phone unless it is not that person's
(`dropNonPersonalPhones` in `klaviyoSync.ts`, rules in `klaviyoRule.ts`):

- **Ignored numbers**: the org's own switchboard and the like, typed on the card (one per
  line, at most 50, stored on `ExternalConnection.ignoredPhones`).
- **Shared numbers**: a number carried by at least `KLAVIYO_SHARED_PHONE_MIN` (3) different
  people. People are counted from the page's profiles by address and from this org's
  existing accounts by account; a re-synced profile is not counted twice.

Numbers are compared on their last 9 digits (`phoneKey`), so `+49 176 …`, `0049176…` and
`0176…` are the same number. A dropped phone is written nowhere: not on the lead, not on
the account. A number that only becomes shared later stays on the first two people who
carried it; *Starting over* below re-reads everyone under the rule.

### Starting over

**Delete what Klaviyo brought in and read it again** on the card
(`GET|POST /api/admin/integrations/klaviyo/reset`, `src/lib/klaviyoReset.ts`).

1. **Preview.** Shows how many accounts would go and which are kept, and why.
2. **Confirm.** The admin types that number. The POST carries it as `expectRemove`, and a
   plan that changed in between deletes nothing and answers 409 with the new preview.
3. **What goes.** It runs the operator rollback (`prisma/wipe-integration-source.mjs
   --source klaviyo`, #2959) on the caller's org. Only accounts the connector created
   (`createdBySource = 'klaviyo'`) are candidates. Any account with a person's work on it
   is kept: a note, a stage move, a follow-up, a value, a claim, contact-permission
   evidence, another user. Each account's verdict is re-read inside its own transaction.
   A deleted account takes its records, its own stand-in leads (unassigned ones included)
   and its provider links.
4. **Re-import.** The profile cursor goes back to a quiet first import, and the next run
   re-reads every profile under today's rules. Nothing is mailed.

### The key from the server environment (optional)

A deployment may supply the key instead: `KLAVIYO_PRIVATE_API_KEY` plus `KLAVIYO_ORG_ID`
(the id or slug of ONE MARKETING organization). At the start of every tick
(`ensureEnvKlaviyoConnection`) it creates that organization's connection if there is
none. **The key is never written to the database**: the row's key column holds
`env:<sha256 of the key>` (`KLAVIYO_ENV_KEY_PREFIX`), and the key is read from the
environment at run time (`openConnectionKey`). A rotated environment key changes the
fingerprint → the query starts over like any changed key. A key an admin saved in the
app wins and is never replaced by the environment's; *Disconnect* removes an
environment-backed connection only until the next tick — unset the variable to stop it.
With no admin who connected, the lead owner must be the org's **default lead owner**.
The card shows such a connection as *Server key (environment)*.

The key is never shown again: every response returns its last four characters only. It is
stored encrypted (`secretBox`, purpose `external-connection:klaviyo`). Saving the same key
again keeps the cursor. Saving a **different** key starts the profile query over as a
quiet first import: a key cannot tell us whether it belongs to the same Klaviyo account,
and a key of another account must not inherit a cursor that would skip all of its older
profiles. For a rotated key of the same account that costs one re-read, in which every
linked profile comes back UNCHANGED. A run already in flight when the key changes stops
after its current page: every cursor write is guarded on the key that run opened, so it
cannot write the old account's position over the reset. *Disconnect* deletes the key and
the live profile links, never an account or a lead — and never an erasure tombstone (see
[Erasure](#erasure)), whose connection is set null so a later reconnect still skips it.

## What is imported

Every profile, whatever its subscription status — the owner's decision (2026-10-20): a
Klaviyo profile is a lead.

| Klaviyo (profile attribute) | CRM |
| --- | --- |
| `id` | `ExternalProfileLink.externalId` — the key that makes a re-sync an update, never a duplicate |
| `organization` | `Company.name` (a new account); without one the account is named after the person, else the address |
| `first_name` + `last_name` | `Company.contactName` and the lead's name |
| `email` | `Company.contactEmail`; the lead person gets a generated stand-in address, exactly as in the marketing import — the mailbox is never a login |
| `phone_number` | `Company.contactPhone` and the lead's phone |
| `location.city` | the lead's city |
| `location.country` | `Company.country` / the lead's country — **only** when it is an ISO-3166 alpha-2 code; a country name is shown, not guessed |
| `title`, `locale`, `location` (city, region, zip, country, timezone), `created`, custom `properties` | `ExternalProfileLink.attributes` — bounded JSON text (≤ 8 000 characters, ≤ 50 properties of ≤ 500 characters each), shown on the account page as information |
| `subscriptions` (consent, method, method detail, double opt-in, timestamp) | `ExternalProfileLink.consent` — shown on the account page as **information only** |
| UTM in the custom properties (`initial_utm_*` / `first_utm_*`, else `utm_*`), else the subscription method and its form/list | the lead's `Source` through `leadSourceName()`: `utm:<source>/<medium>/<campaign>`, else `klaviyo:<method>/<form or list name>`, else `klaviyo` |

Never kept: the IP address and the coordinates of `location`, and predictive analytics
(never requested).

**Consent is information, not permission.** A Klaviyo consent never creates a contact
permission in this CRM: a machine writes `NONE` only ([contact-permission.md](../contact-permission.md)).
Mail engagement (opens, clicks …) arrives as events with their own cursor ([Beyond profiles](#beyond-profiles)).

## Where a profile goes

1. Already linked → that account: **UPDATE** or **UNCHANGED**.
2. Else its address matches a lead of this organization (the stand-in or the real
   address) or exactly one account's contact e-mail → that account is **adopted**: linked,
   gaps filled.
3. Else a **new** account + lead + funnel record at the organization's **first stage**,
   created through the marketing import's own create-only writer
   (`createMarketingAccountsBatch`, [marketing-import.md](../marketing-import.md)) — so the
   stand-in, the one-active-owner rule and first-touch attribution are the import's, not
   a copy. `Company.createdBySource = 'klaviyo'`, so `prisma/wipe-integration-source.mjs
   --source klaviyo` can roll back what the connector created.
   If the import's match key finds an existing account by **name**: the same organization
   name is the same company (linked); the same *person's* name with another contact is
   another person — the account is created as `Name (address)`.
   Two new profiles of the same organization in one page go to the writer in two passes
   (one row per account name per pass), so the second is linked to the account the first
   one created — never dropped as a "duplicate account in file".

**A second person of the same company** (linked by the account's name, not by their
address) is linked to the account but is **not its contact**: their profile never fills
the account's contact columns, and never the lead, the location or the first-touch
source of the account's record — that lead is somebody else. Their Klaviyo data is shown
on the account page like any linked profile. A profile fills the account's contact
columns only when it is the contact (same address) or the account names nobody.

Each page runs through the shared engine, `runImport({ parse, validate, resolve, apply })`
([roster-feed.md](../roster-feed.md)): the page is the table, the mapping is the
validator, the batched diff is `resolve`, and the preview is the same call with a writer
that does not write. That writer is the run's own path: creates go through the marketing
account writer in its preview mode, so a profile the run would link to an existing account
by name previews as that UPDATE, not as a CREATE.

### What a re-sync may overwrite

The one overwrite policy (`planFieldUpdates`, non-authoritative): an empty field is
filled; a field a person filled is **left alone** and reported as withheld. The account
name and the stage are never touched by a re-sync. The link's own columns (`attributes`,
`consent`, `sourceName`) are Klaviyo's and are replaced on every sync.

## The schedule and the cursor

- Every 15 minutes (the queued job `klaviyo.sync`, `src/lib/jobs/schedules.ts`), every enabled connection
  whose backoff has elapsed, one after the other; a connection that fails is logged and
  the next one runs. One run per connection at a time: a `JobLease` named
  `klaviyo-sync:<connectionId>` (the cron also runs on one replica only).
- A run reads at most 20 pages of 100 (5 for *Sync now*) and stops starting pages after
  4 minutes; the rest follows on the next tick.
- **The cursor** (`ExternalConnection.profilesSince / profilesQueryStartedAt /
  profilesPageCursor`): a query asks for profiles `greater-than(updated, since)` sorted by
  `updated`, and walks Klaviyo's own `page[cursor]`, committed after every page — a run cut
  off anywhere resumes at the next page. When a query ends, the next one starts **five
  minutes before this one began**, so a profile saved while a long query was being paged
  is read again rather than missed (an unchanged profile comes back UNCHANGED and writes
  nothing). Not "the highest `updated` seen": Klaviyo sorts by one field, and a bulk list
  import gives thousands of profiles the same second — a high-water mark could never move
  past it without skipping rows. A stale page cursor (400) restarts the open query.
- **A row that failed is retried.** The oldest `updated` of a profile that ended as ERROR
  in the open query is kept (`profilesErrorFloor`); when the query closes, the next one
  starts one second before it, so that profile is read and tried again. At most
  `KLAVIYO_ERROR_RETRY_QUERIES` (3) queries in a row are held back like that
  (`profilesErrorHolds`); a permanent failure then lets the cursor move on and stays
  counted in `lastErrors`.

### Failures and backoff

`lastErrorCode` is a code, never a response body: `unauthorized` (401), `forbidden`
(403 — a missing scope), `rate_limited`, `upstream_error`, `bad_request`, `network`,
`bad_response`, `key_unreadable`, `no_owner`, `internal`.

- A request is tried up to 4 times (`KLAVIYO_MAX_ATTEMPTS`, `retryDelayMs`): a 429 waits
  its `Retry-After` when that is ≤ 5 s, a 5xx or a network failure backs off 1 s → 2 s →
  4 s with ±25 % jitter. A longer `Retry-After` gives the request up at once — it becomes
  the run's backoff. 400/401/403 are never retried. Every request has a 20 s timeout and
  a 5 MB body cap; what is logged is the method, the path without its query, the status
  and the duration — never the key, never a body.
- A failed run backs the connection off: the next tick, then 30 min, 1 h, 2 h … up to 6 h;
  a longer `Retry-After` wins. A success clears it. Klaviyo's limits for both endpoints are
  per account, 75/s burst and 750/min steady — a run of 20 pages is far inside them.

## Erasure

Erasing a person (`anonymizeUser` / `hardDeleteUser`, or forgetting an account-less
contact) also turns their profile links into **tombstones**
(`src/lib/externalProfileErasure.ts`): found by the lead they point at or by `emailHash`
(sha256 of the lower-cased address, kept on a live link only), they keep the Klaviyo
profile id and `erasedAt` and nothing else — no account, no lead, no hash, no
attributes. Every later sync **SKIPS** that profile id, so the person is not written back
onto the scrubbed account nor re-created as a new one — also after a disconnect and
reconnect, because tombstones are matched org-wide, not per connection. A person who signs up again under
a new Klaviyo profile is a new lead.

## Quiet first import

Until the first full query completes (`initialSyncDoneAt`), runs are silent: no bell, no
per-lead activity line, and one aggregated `integration.klaviyo.initial_import` activity
entry when it completes. After that, a run that created leads rings the lead owner's bell
once (`integration.newLeads`, a count; an ADMIN's links to the Klaviyo-filtered accounts
list, a sales rep's to `/sales/accounts`) and writes one `integration.klaviyo.sync` line.
No run ever sends mail to a lead.

## Beyond profiles

Every 15-minute tick runs, after the profiles and under the same per-connection lease,
every other resource that is due (`runKlaviyoResources`, `src/lib/klaviyoResources.ts`).
**Sync everything** on the card (`POST …/sync` with `{ "scope": "all" }`) runs them at
once, ignoring their schedule and backoff — except the campaign statistics, which keep
their daily schedule (the reporting API allows 225 queries a day).

| Resource | Endpoint | Schedule | CRM table |
| --- | --- | --- | --- |
| Lists | `GET /api/lists` (10/page) | incremental (`updated`) every tick, full daily | `ExternalAudience` (`kind = 'list'`) |
| Segments | `GET /api/segments` (10/page) | incremental (`updated`) every tick, full daily | `ExternalAudience` (`kind = 'segment'`) |
| Members | `GET /api/{lists,segments}/{id}/profiles` (100/page, `fields[profile]=joined_group_at`) | incremental (`joined_group_at`) hourly, full daily — per list/segment | `ExternalAudienceMember` (profile id + joined at, nothing else) |
| Metrics | `GET /api/metrics` (200/page) | full every 6 h (no time filter exists) | `ExternalMetric` |
| Events | `GET /api/events?filter=equals(metric_id,…),greater-than(datetime,…)&sort=datetime` (200/page) | per allow-listed metric: incremental every tick, catch-up daily | `ExternalEvent` (metric, profile id, time, bounded properties) |
| Campaigns | `GET /api/campaigns?include=campaign-messages` (100/page) | incremental (`updated_at`) every tick, full daily | `ExternalCampaign` + `ExternalCampaignMessage` |
| Campaign statistics | `POST /api/campaign-values-reports` (read-only query) | daily, `last_365_days` | `ExternalCampaignStat` (numbers only) |
| Flows | `GET /api/flows` (50/page) | incremental (`updated`) every tick, full daily | `ExternalFlow` |

- **Cursor per resource** (`ExternalSyncState`, one row per `lists`, `segments`, `metrics`,
  `flows`, `campaigns`, `campaign_stats`, `members:<id>`, `events:<metric id>`): since,
  the open pass (start, mode, page cursor), last full pass, status, error code, failures,
  backoff, counts. A run reads at most 120 pages (20 for *Sync everything*), 30 per
  resource, and stops starting pages after 4 minutes; an open pass resumes at its page.
- **Idempotent.** Every row is upserted by (connection, provider id); events are
  immutable and inserted with `skipDuplicates`. A **full pass** stamps `seenAt` and then
  deletes what it did not see — the only way a deletion on the provider's side reaches
  us (an `updated` filter never returns a deleted row). A failed pass prunes nothing.
- **Events are not everything.** Only the metrics named in `KLAVIYO_EVENT_METRICS`
  (comma-separated; `*` = all) are imported; by default `DEFAULT_EVENT_METRICS` —
  opened/clicked/bounced e-mail, spam complaints, (un)subscribes, form submissions,
  orders. *Received Email* and *Active on Site* are left out on purpose: they are the
  high-volume logs. Events are kept **13 months** (`EVENT_RETENTION_DAYS`; the first pass
  starts there) and leave by the retention sweep. The provider filters events by when
  they happened, not when it received them, so a daily **catch-up** pass re-reads from the
  previous catch-up's start minus an hour (`eventsWindowStart`): an event delivered up to
  a day late is still picked up; one delivered later than that can be missed.
- **Campaign statistics** ask for counts and rates only (`CAMPAIGN_STATISTICS`), grouped
  by campaign, message and channel. The query needs a conversion metric:
  `KLAVIYO_CONVERSION_METRIC` (default *Placed Order*); without it any metric serves and
  the conversion figures are dropped. A finished report replaces the previous one.
- **Pacing.** Requests are strictly sequential, and one family is never sent faster than
  `RESOURCE_PACE_MS` (flows ≥ 1.1 s apart — 60/min steady; the reporting query ≥ 31 s —
  2/min).
- **Erasure.** Erasing a person also deletes their events and memberships, inside the
  same transaction as the tombstone (`externalProfileDataErasureOps`), and a later sync
  never writes an erased profile id as an event or a member.
- **Disconnect** deletes all of it (the tables cascade with the connection). Saving a
  **different** key deletes it too — it may be another account's — and a full re-read
  rebuilds it.
- **Status.** `GET /api/admin/integrations/klaviyo` returns `resources[]`: one line per
  kind (members and events summed over their lists/metrics) with the worst status, the
  first error code, how many parts fail, rows kept, the oldest last success; the card
  renders it.

## The one POST

`klaviyoQuery()` sends a POST **only** to a path in `KLAVIYO_QUERY_POST_PATHS` —
today `/api/campaign-values-reports` — and throws for any other path before a request is
made. The reporting API is query-by-body: it creates, changes and deletes nothing, and
the key's scopes are read-only anyway. Every other request is a GET.

## Version pinned, verified against the provider's reference (2026-10-22)

- Base URL `https://a.klaviyo.com`, header `Authorization: Klaviyo-API-Key <key>`, header
  `revision: 2026-10-15` (`KLAVIYO_REVISION` in `klaviyoRule.ts` — change it only after
  re-reading the reference of every endpoint above). A deployment may pin another GA date
  with the `KLAVIYO_REVISION` environment variable; a `.pre` (beta) revision, junk or a
  date before `KLAVIYO_OLDEST_REVISION` falls back to the default (logged once). Each
  revision is supported for two years after its release (2024-10-15 ended on 2026-10-15).
- Breaking changes between 2024-10-15 and 2026-10-15 that touch what we read:
  2025-01-15 — campaigns gained push, flow-message endpoints moved to cursor paging;
  2026-07-15 — Get Events returns events with unresolved metrics by default; 2026-10-15
  — campaigns, messages and clone moved to the omnichannel model (no channel on the
  campaign, one audience/channel/variation per message, no channel filter required). No
  breaking change touched profiles, lists, segments or their members in that range.
  The campaign mapping reads the old flat shape too, so a pin to an older GA revision
  still maps.
- `GET /api/profiles`: `page[size]` ≤ 100, `filter=greater-than(updated,…)` (updated takes
  greater-than / less-than only), `sort=updated`, `additional-fields[profile]=subscriptions`.
  A profile's lists are not an `include` of this endpoint — one call per profile, so they
  are not fetched; the subscription method and its detail are.
- `GET /api/lists`: ≤ 10 per page, read once per run (≤ 10 pages) for the list names.
- 429 carries `Retry-After` in seconds.

Every request goes through the SSRF guard (`assertPublicHttpsUrl`). The e2e suite points
the app at `e2e/support/klaviyo-mock.mjs` through `KLAVIYO_API_BASE_URL`, which is honoured
only together with `KLAVIYO_ALLOW_INSECURE_STUB=1` (that switch also skips the guard for the
plain-http loopback stub); no deployment sets either.
