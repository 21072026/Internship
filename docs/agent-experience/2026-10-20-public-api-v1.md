## 2026-10-20 — the /api/v1 contract, read breadth, write floor, writes and REST hooks (#1988 #2998, #1990 #3003, #1994 #3009, #1996 #3016, #2002 #3020)

- **Adding `@@index([orgId, …])` to a model whose `orgId` FK had only MySQL's implicit index lets
  MySQL take the new composite over as the FK's index.** After that, a `db push` of a schema
  *without* the composite fails with `Cannot drop index 'MentorshipRelation_orgId_updatedAt_id_idx':
  needed in a foreign key constraint`. Locally that happens when you switch to an older branch;
  in production it would happen on a rollback. On a local DB, drop and recreate
  `internship_test`, then `db push` and `db seed`. Before you add an `orgId`-leading index, check
  whether the model already has one (here `MentorshipRelation` did not; `User`, `Company`,
  `Requisition` and `InterviewRequest` did).
- **A new `updatedAt` on a table that already has rows is `DateTime @default(now()) @updatedAt`.**
  A bare `@updatedAt` is a required column with no DB default, which `check:schema-push`
  refuses. Every existing row then starts at the deploy instant, and a raw SQL `UPDATE` never
  moves the column.
- **Keep `withApiKey(request, '<literal scope>', …)` literally in every `/api/v1` route file.**
  `check:api-key-routes`, `check:route-auth` and the OpenAPI generator all find the door by text.
  Put shared behaviour *inside* the door instead of wrapping it, e.g.
  `withApiKey(request, 'x:write', (key) => apiWrite(request, key, schema, handler))`.
  `check:api-key-routes` maps `[id]` segments to OpenAPI `{id}` now, so a `/{id}` route needs
  `'/res/{id}'` in the spec.
- **`check:api-key-routes` reads `API_SCOPES` and `SCOPE_ENTITLEMENT` with a quote regex.** An
  apostrophe in a comment inside the array ("another key's") turns into phantom scopes. Write
  those comments without apostrophes.
- **`check:events` pins every direct `dispatchWebhook()` caller by file path.** If you move a
  producer into a shared helper (#1996: `createInteraction()` in `src/lib/interactionWrite.ts`),
  move its `PENDING_MIGRATION` line in the same commit, with the count unchanged. Anything that
  would add an emit site waits for `emit()` (#1693). That is why #1998 is blocked.
- **A Next.js route file may export only handlers and route config.** A shared constant such as
  `MAX_HOOKS_PER_KEY` exported from `route.ts` passes `tsc` but fails `next build`. Keep it in
  `src/lib`.
- **Prisma logs every unique violation as `prisma:error`, even when you catch it.** When a
  collision is the normal case (an idempotency replay), claim with
  `createMany({ data: [row], skipDuplicates: true })` (`INSERT IGNORE`) and read the row back.
- **To test a server helper without a browser, import it into a `*.unit.spec.ts`.** Playwright
  resolves `@/lib/...`, and the helper runs against the real DB (`e2e/api-v1-write-foundation.unit.spec.ts`
  drives `withApiKey` + `apiWrite` with a counting stand-in handler). This works before any route
  uses the helper.
- **After the base PR of a stack is squash-merged, merging `main` into the next branch conflicts
  (add/add, or empty-vs-ours hunks) on every file the base created or touched.** The stacked
  branch is a superset, so resolve hunk by hunk, keeping `ours`
  (`re.sub(r"<<<<<<< .*?\n(.*?)=======\n.*?>>>>>>> .*?\n", r"\1", …)`). Never `git checkout
  --ours` a whole file: in `prisma/schema.prisma` that silently drops whatever else landed on
  `main`. Run every CI check (`grep -oE "npm run [a-z:0-9-]+" .github/workflows/ci.yml`) before
  you push the merge.
- **The SSRF guard refuses every local webhook sink, by design.** Assert "an event reaches the
  subscriber" on the delivery query (`liveSubscriptionsWhere()`). Use a literal public address
  (`https://93.184.215.14/…`) as the target, so subscribing needs no DNS in the container.
- **`e2e/api-key-quota.spec.ts:81` fails on `main` as well (seen 2026-10-20).** The test reads
  the unmetered key's batched usage tally (`usage.requests` 0 vs 1, line 116) before the tally is
  flushed. The failure is not caused by `/api/v1` changes.
