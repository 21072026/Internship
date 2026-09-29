# The demo form on the marketing landing (#2569) and the default lead owner (#2580)

A merchant who wants to see SaleVali asks for a demo on the marketing landing
(`marketing.bcsit-gmbh.de/#demo`). The request becomes a `CompanyInquiry` row in the
**MARKETING tenant that explicitly claims that host**, and — if the tenant has a default
lead owner — a funnel record on that owner's pipeline straight away.

## Which tenant receives a public request

The form has no session, so the only signal is the request host. The rule
(`src/lib/publicHostRule.ts`, pure and unit-tested in `scripts/test/public-host-org.test.mjs`):

| Host | Mapping (`Organization.publicHost`) | Result |
| --- | --- | --- |
| any | an org whose `publicHost` is **exactly** this hostname, same product as the host | that org |
| any | an org of the **other** product | **closed** (configuration error) |
| internship host | none | the default org — what the form always did |
| marketing host | none | **closed** — never the internship tenant, never "the first MARKETING org" |

"Closed" means the landing section says *demo requests are closed right now* instead of
showing a form, and `POST /api/company-inquiry` answers `503 { code: 'form_unavailable' }`.

**Why a column, not an env var.** The value mapped to is a database id: an env map would
need a cuid copied by hand into every environment and a redeploy to change, and nothing
would stop one host from naming two tenants. `publicHost` is `@unique`, lowercase, no port,
no wildcard — the `servedHosts.ts` exact-match rule.

**Trust.** Reading the host here is the second permitted authz-adjacent use of the host
signal (see the note in `src/lib/hostVertical.ts`). It only decides which inbox a new,
unauthenticated request is filed into; nothing is read back out. Caddy overwrites
`X-Forwarded-Host` in every environment, and even a forged one can only put the forger's
own request into another tenant's queue.

### Operator step — REQUIRED after merge, once per environment

Nothing in the deploy opens the form: until this runs, `marketing.bcsit-gmbh.de` and
`marketing.bcsit-gmbh.dev` show *demo requests are closed right now*. Every deploy prints
the state in its log (`infra/deploy-prod.sh` runs `set-public-host.mjs --list`, report
only), including a `WARNING:` line with the exact command for each MARKETING org that
claims no host — so the slug to use is the one that line names.

| Environment | Host | Org |
| --- | --- | --- |
| Production | `marketing.bcsit-gmbh.de` | the prod MARKETING org (slug from the deploy log's `WARNING:` line) |
| Preview | `marketing.bcsit-gmbh.dev` | the preview MARKETING org (same) |
| Topic env (`pr<N>`) | not mapped | the form stays closed there unless a reviewer maps it by hand |

```bash
node prisma/set-public-host.mjs --org <slug|id> --host marketing.bcsit-gmbh.de   # prod
node prisma/set-public-host.mjs --org <slug|id> --host marketing.bcsit-gmbh.dev  # preview
node prisma/set-public-host.mjs --list
node prisma/set-public-host.mjs --org <slug|id> --clear
```

Until this runs, the marketing landing's form is closed — by design.

## What is stored

- The form fields; `marketplaces` instead of `openRoles` on the marketing form.
- **Consent record:** `consentAt` and `consentTextVersion` (= `PRIVACY_POLICY_VERSION`),
  both written by the server. The notice at that version (`2026-09-29`) has a section on
  these forms naming every field below, so the stamp points at a text that covers what the
  row keeps. Bump the version whenever what this form stores changes.
- **Product news — a REQUEST, never a send permission.** The separate,
  **unchecked-by-default** box is stored as `marketingOptInRequested` (`NULL` = the form
  never asked, the internship form), with `marketingOptInTextVersion`
  (= `MARKETING_OPT_IN_TEXT_VERSION`, the wording's own version; the language is the row's
  `locale`) and `marketingOptInConfirmedAt`, which stays `NULL` because no double opt-in
  exists. A single opt-in on a public form can be ticked by anyone for anyone's address and
  proves nothing under UWG §7(2) Nr. 2 — **no code, export or person may mail on
  `marketingOptInRequested`**; only a non-NULL `marketingOptInConfirmedAt` would ever be a
  basis (the consent model is #2577). The admin list says so on the row.
- **Source:** `utmSource/Medium/Campaign/Term/Content` (trimmed, capped at 150) and
  `referrer` — origin + path only; the query string and fragment are dropped, and a
  referrer on our own host is not a source (`src/lib/inquiryAttribution.ts`). Stored raw;
  when the enquiry becomes a lead, its lead person is bound to the org's `Source`
  named by `leadSourceName()` (#2570, `src/lib/leadSourceName.ts`):
  `utm:<source>/<medium>/<campaign>`, created in the org when missing. No
  `utm_source` = unknown = no Source (the attribution report's `unsourced` bucket).
  The referrer is not mapped yet.
- **No IP address** — neither on the row nor in the activity log of an automatic placement.
- `receivedHost`, the hostname the request arrived on.

The notification and the e-mail go to the **target org's** active admins only — decided by
which org it is (`orgWhere()`, `src/lib/tenantFilter.ts`), so the default org's includes
admins with no org exactly as its list does, however the host was resolved.

**The public response is `{ ok: true }` and nothing else**, identical to the honeypot's. It
must not depend on what the tenant already holds: whether the default-owner placement
succeeded is decided by whether the e-mail is a staff member's or somebody's lead and
whether the company is an existing account, so echoing it would be an anonymous lookup of
all three.

## Owner: default, or the unowned list

`defaultLeadOwnerId` (org setting, MARKETING settings form, `src/lib/leadOwner.ts`): an
active ADMIN or MENTOR of the same org. A stale id reads as "none".

- **Web request, default owner set:** placed on that owner's funnel at the org's first
  stage immediately — Company + stand-in lead + `MentorshipRelation`, through the #2562
  one-row import writer; the enquiry is marked converted.
- **Web request, no default owner** (or the writer refused — the account name already
  exists, the contact is already a lead): it stays `NEW` in `/admin/company-inquiries`
  ("Demo requests" in the MARKETING nav), labelled **Unowned**, until an admin presses
  **Add to pipeline**. Never dropped.
- **Hand-typed lead** (`POST /api/admin/marketing-accounts`): `ownerId` in the body, else
  the default owner, else the admin typing it. The last fallback is the one place "no
  default" does not mean "unowned": a funnel record cannot exist without an owner, and
  the typist is working the lead at that moment.
- **Add to pipeline** (`POST /api/admin/company-inquiries/[id]/convert` in a MARKETING org):
  `ownerId` in the body, else the default owner, else the admin pressing it. No COMPANY
  login, no invitation. Idempotent: the enquiry is claimed by a conditional update on
  `convertedAt` before the writer runs, a second click answers `409 already_converted`,
  and a claim older than ten minutes without a company is a crashed attempt that may be
  retaken (`src/lib/inquiryLead.ts`).

## Rate limit

The `company-inquiry` bucket (3 per hour per client IP) is unchanged. No confirmation
(double opt-in) mail is sent; if one is ever added, it needs a per-recipient cap of one
mail per address per day (#2569 § 9).
