# Klaviyo: profiles in, leads out — read-only

A MARKETING organization can connect its Klaviyo account. Every Klaviyo profile then
becomes a lead on the organization's funnel and is kept in step every 15 minutes.
**The connector only reads.** Nothing is ever written back to Klaviyo, and no lead is
ever e-mailed by it.

| File | Owns |
| --- | --- |
| `src/lib/klaviyoRule.ts` | The pure rules: the wire format (paths, headers, the pinned revision), the profile → lead mapping, the cursor, the backoff. Zero imports; `scripts/test/klaviyo-rule.test.mjs`. |
| `src/lib/klaviyoClient.ts` | The HTTP half: GET only, one fixed host, time- and size-bounded, one retry. |
| `src/lib/klaviyoSync.ts` | The Prisma half and the **only writer** of `ExternalConnection` / `ExternalProfileLink`: a page of profiles through the shared import engine, the run, the 15-minute tick. |
| `src/app/api/admin/integrations/klaviyo/**` | The admin routes (connect, test, sync now, preview, pause, disconnect). |
| `src/components/admin/KlaviyoCard.tsx` | The card on `/admin/integrations` (MARKETING only). |
| `e2e/klaviyo-connector.spec.ts` + `e2e/support/klaviyo-mock.mjs` | End-to-end against a local stand-in of the API. No test ever calls Klaviyo. |

## Setting it up

1. In Klaviyo: **Settings → API keys → Create private API key**. Choose custom/read-only
   access and grant exactly these scopes, read only:
   - `profiles:read` — the profiles themselves (required);
   - `lists:read` — the names of the lists a person subscribed through (optional: without
     it the source shows the list id instead of its name).

   Nothing else. The connector never needs a write scope, and a key that has one is a key
   that could do more than this product ever asks of it.
2. In the CRM, as an ADMIN of the MARKETING organization: **Integrations → Klaviyo**,
   paste the key (it starts with `pk_`; the six-character public key is refused), **Test
   connection**, **Save key**. Saving tests the key again and stores it sealed.
3. Optional: **Preview the first profiles** — the first 25 profiles, mapped and planned
   by the same code a sync runs, with a writer that writes nothing.
4. **Sync now**, or wait for the next 15-minute tick.

Who owns the new leads: the organization's **default lead owner** (Settings), else the
admin who saved the key. With neither, the run records `no_owner` and imports nothing.

The key is never shown again: every response returns its last four characters only. It is
stored encrypted (`secretBox`, purpose `external-connection:klaviyo`). Replacing the key
keeps the cursor and the links (same account, rotated key); a key of a **different**
Klaviyo account is *Disconnect*, then connect — disconnecting deletes the key and the
profile links, never an account or a lead.

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
Mail engagement (opens, clicks) is a later step (K2) with its own cursor.

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

Each page runs through the shared engine, `runImport({ parse, validate, resolve, apply })`
([roster-feed.md](../roster-feed.md)): the page is the table, the mapping is the
validator, the batched diff is `resolve`, and the preview is the same call with a writer
that does not write.

### What a re-sync may overwrite

The one overwrite policy (`planFieldUpdates`, non-authoritative): an empty field is
filled; a field a person filled is **left alone** and reported as withheld. The account
name and the stage are never touched by a re-sync. The link's own columns (`attributes`,
`consent`, `sourceName`) are Klaviyo's and are replaced on every sync.

## The schedule and the cursor

- Every 15 minutes (`/api/cron/start` → `initKlaviyoSyncCron`), every enabled connection
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

### Failures and backoff

`lastErrorCode` is a code, never a response body: `unauthorized` (401), `forbidden`
(403 — a missing scope), `rate_limited`, `upstream_error`, `bad_request`, `network`,
`bad_response`, `key_unreadable`, `no_owner`, `internal`.

- A request is retried once: a 5xx after a second, a 429 after its `Retry-After` when
  that is ≤ 5 s.
- A failed run backs the connection off: the next tick, then 30 min, 1 h, 2 h … up to 6 h;
  a longer `Retry-After` wins. A success clears it. Klaviyo's limits for both endpoints are
  per account, 75/s burst and 750/min steady — a run of 20 pages is far inside them.

## Quiet first import

Until the first full query completes (`initialSyncDoneAt`), runs are silent: no bell, no
per-lead activity line, and one aggregated `integration.klaviyo.initial_import` activity
entry when it completes. After that, a run that created leads rings the lead owner's bell
once (`integration.newLeads`, a count) and writes one `integration.klaviyo.sync` line.
No run ever sends mail to a lead.

## Version pinned, verified against the provider's reference (2026-10-20)

- Base URL `https://a.klaviyo.com`, header `Authorization: Klaviyo-API-Key <key>`, header
  `revision: 2026-07-15` (`KLAVIYO_REVISION` — change it only after re-reading the
  profiles reference).
- `GET /api/profiles`: `page[size]` ≤ 100, `filter=greater-than(updated,…)` (updated takes
  greater-than / less-than only), `sort=updated`, `additional-fields[profile]=subscriptions`.
  A profile's lists are not an `include` of this endpoint — one call per profile, so they
  are not fetched; the subscription method and its detail are.
- `GET /api/lists`: ≤ 10 per page, read once per run (≤ 10 pages).
- 429 carries `Retry-After` in seconds.

The e2e suite points the app at `e2e/support/klaviyo-mock.mjs` through
`KLAVIYO_API_BASE_URL`; no deployment sets it.
