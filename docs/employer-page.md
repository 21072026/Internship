# The public employer page (#1867)

Before this page, a role on the job board told a candidate the company's name
and nothing else. Now a company can publish its own page at
`/employers/<slug>`, on the tenant's host. Each role on the board links to it.

## When the page exists

A company is shown when it meets **all** of these. Otherwise the URL is a
**404**, the same answer a slug nobody holds gets:

- `isPublicProfile` is on (it defaults to off; the company switches it on in
  `/company/profile`)
- the company is `VERIFIED` (#1865, `docs/company-verification.md`)
- the company has a slug

The rule lives in `isPublicEmployer()` (`src/lib/employerPage.ts`, pure and
unit-tested). The read is `loadPublicEmployer()` (`src/lib/employerPageStore.ts`).
The page and `GET /api/public/employers/[slug]` share that one read.

## What is public

The page shows:

- name and logo
- `about` (candidate-facing copy, kept separate from the internal `description`)
- industry, size
- `websiteUrl`: https only, no credentials; rendered with `rel="noopener nofollow"`
- open roles: `OPEN` with a seat free (`filled < openings`), each linking to
  `/portal/jobs/<id>`

**Never** shown: `contactEmail`, `address` or any other internal field. The
select in `loadPublicEmployer()` is the whole public surface.

## The slug

- **Per tenant:** the constraint is `@@unique([orgId, slug])`, never global. A
  global unique would let one tenant's employer block another's name. The
  tenant is resolved from the request host (`resolvePublicInquiryTarget()`,
  internship hosts only).
- **Assigned on first publish:** `ensureEmployerSlug()` runs from
  `PUT /api/companies/[id]`. It transliterates the name (Turkish-safe
  `kebabSlug()`) and tries `name`, then `name-2`, `name-3` and so on. A guarded
  write on `slug: null` handles races.
- **No backfill:** an unpublished company needs no slug.
- **Never moves:** once given, the slug stays, so a shared link stays valid.

## Who edits it

A COMPANY user edits its own company's `about`, `websiteUrl` and
`isPublicProfile` from `/company/profile`. These join the self-editable fields
from #1865 (`COMPANY_SELF_EDITABLE_FIELDS`). The slug itself is server-set.

Only the role **detail** page links the employer. The job card on the board is
already one link, and a second link nested inside it would be invalid HTML.
