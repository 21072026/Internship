## 2026-11-06 — Agenda templates: the org in the WHERE (#3592)

- **Check the backlog before proposing a story.** I proposed "#1827 slice 1, an AgendaTemplate
  library" without opening the issue: its three children were closed and the models were in the
  schema. `issue_read get_sub_issues` and a `grep -n "model <Name>" prisma/schema.prisma` take
  seconds; do them before the one-line proposal, not after the approval.
- **An id-only read followed by an org check in JS is the shape to grep for.**
  `findUnique({ where: { id } })` then `x.orgId !== null && x.orgId !== rel.orgId && rel.orgId !== null`
  reads as careful and is wrong twice: every NULL on either side becomes a wildcard, while the
  repo's rule (`src/lib/tenantFilter.ts`) is NULL = the default org. Put the org in the WHERE with
  `withinTenant(…, await orgWhere(org ?? await defaultOrgId()))`. A sibling path that "reuses the
  same helper" (here carry-over → `instantiateAgenda`) may have had no check at all, so read every
  caller of the helper you harden.
- **Before you decide whether a NULL org means "global", read the writer and the seeder.** Here the
  admin route said "a legacy NULL row is the default org's" and the seeder stamped the default org,
  so NULL was not a global starter set.
