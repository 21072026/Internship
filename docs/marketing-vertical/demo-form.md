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

### Operator step (once per environment)

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
  both written by the server. The separate, **unchecked-by-default** product-news box is
  `marketingOptIn`, a plain boolean that creates no lawful basis by itself (the consent
  model is #2577). `NULL` means the form never asked (the internship form).
- **Source:** `utmSource/Medium/Campaign/Term/Content` (trimmed, capped at 150) and
  `referrer` — origin + path only; the query string and fragment are dropped, and a
  referrer on our own host is not a source (`src/lib/inquiryAttribution.ts`). Stored raw;
  binding them to a `Source` row is #2570.
- **No IP address** — neither on the row nor in the activity log of an automatic placement.
- `receivedHost`, the hostname the request arrived on.

The notification and the e-mail go to the **target org's** active admins only.

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
