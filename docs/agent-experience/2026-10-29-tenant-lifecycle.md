# 2026-10-29 — Tenant lifecycle: rename, archive, export, gated hard delete (#1580, #1582, #1584, #3277, #3291)

- **A schema-driven walk beats a hand list for "every row of a tenant".** `Prisma.dmmf.datamodel.models`
  gives every model's `orgId` and its FK edges (`relationFromFields`/`relationToFields`, required-ness from
  the scalar's `isRequired`); `src/lib/orgExport.ts` and `src/lib/orgDeletionRule.ts` both plan from it, and
  the unit tests load `@prisma/client` with `createRequire` to run the plan on the real schema.
- **Fail-closed policy tests pay for themselves fast.** `org-export-policy.test.mjs` (every credential-looking
  column must be decided) caught `Organization.ssoClientSecretEnc`, merged to main by another session hours
  after the export shipped — it would otherwise have gone out in every export.
- **When you null optional links before a delete, never null the ownership column.** `User.orgId` is an
  optional link to `Organization`; nulling it first made `deleteMany({ where: { orgId } })` find nothing and
  orphaned the users into the default org. Only the e2e run of the real executor showed it — assert on
  `result.deleted.User`, not just "no row has this orgId" (an orphaned row passes that).
- **Keep a destructive executor free of the app's Prisma singleton** (`deleteTenantRows(client, orgId)`), so a
  Playwright spec can run it against the test DB while the server-side switch stays off in CI.
- **Account mails did not pass `orgId` to `sendEmail()`** (reset, magic link, verification, invitation, role
  change, 2FA reset): any per-tenant mail gate has to make those senders pass it, or it silently misses them.
- **Local DB lags main after a rebase**: a `P2022 column does not exist` mid-stream is `prisma db push`, not a bug.
  Also re-run `node scripts/i18n-scopes.mjs` after pulling — a stale generated scopes file shows up as tsc errors
  in unrelated `layout.tsx` files.
