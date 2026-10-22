# Schema changes under `db push` — expand/contract, rollback, the traps (#1538)

One document to follow at 02:00 with a failed deploy and no context: how to
write a schema change that does not lose data, what to do when a push is half
applied, and which changes are the dangerous ones.

**This project has no `prisma/migrations/` folder.** The schema is synced with
`prisma db push --accept-data-loss` on every deploy (`infra/deploy-prod.sh`,
step 3), so there is no migration file to review, no `_prisma_migrations`
table and no `migrate resolve`. What stands in for them is listed in
[What exists](#what-exists). Do not run `prisma migrate dev` or `migrate deploy`
against any shared database: they would try to create a migration history the
deploy does not know about.

## What exists

| Piece | What it does |
|---|---|
| `prisma/schema.prisma` | The source of truth. The deploy makes the database look like it. |
| `npm run check:schema-push` (CI, `scripts/check-schema-push-safety.mjs`) | Diffs the schema against the merge-base with `origin/main` and **refuses** what `db push` cannot apply to a populated table: a new required column whose default is client-side (`cuid()`, `uuid()`) or absent, and any `@id` / `@@id` change (#2298). |
| `infra/schema-guard.sh` (deploy, before the push) | Asks Prisma for the SQL the push would run (`migrate diff --script`, writes nothing) and stops a prod deploy on a statement that destroys data (`DROP COLUMN`, `DROP TABLE`, an enum narrowing …). Enum *widening* is recognised and allowed (#1244). Preview/topic run it `--warn-only`. `ALLOW_DESTRUCTIVE=1` needs `BACKUP_TAKEN=1`. |
| `infra/backup-db.sh` (deploy, before the guard) | The pre-deploy dump. Required on prod. |
| The expand helpers (`prisma/push-*-expand.mjs`) | Push an intermediate schema first, so the final push only has a contract step left. Worked example below. |
| `prisma/run-pre-push.mjs` + `prisma/pre-push/registry.mjs` (#3144) | The expand helpers and their backfills, in order, before the push — ONE list run by every path that pushes onto existing tables: prod/preview (`infra/deploy-prod.sh`), an existing topic DB (`infra/server/topic-deploy.sh`) and the public demo (`infra/server/demo-refresh.sh`). |
| `prisma/backfill-json-columns.mjs --repair` | Runs **before** (the last pre-push step) **and after** the push — the MariaDB Json trap, below. |
| `prisma/run-backfills.mjs` + `prisma/backfills/registry.mjs` (#1540) | Every data migration (seeds, backfills) after the push, in order, recorded in `BackfillRun`. |

## How to change the schema

```bash
# 1. edit prisma/schema.prisma, then
npx prisma format && npx prisma validate && npx prisma generate
# 2. will db push be able to apply it to a table WITH rows?
npm run check:schema-push
# 3. against your LOCAL database only — see the SQL it would run first
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script   # sanity: prints nothing when in sync
npx prisma db push                                       # local DB only
```

Read the SQL `infra/schema-guard.sh` would see before you open the PR: run the
same `migrate diff` with `--from-schema-datasource` pointing at a local database
that has the **old** schema and data in it. A topic environment is not evidence
— its database is fresh and empty (#1185), so a step `db push` refuses on a
populated table sails through there. #2249 was green on every PR environment
and then stalled every prod and preview deploy for 13 commits.

Rules of thumb that keep a change appliable:

- A new column is **nullable**, or has a **database** default (`@default(now())`,
  a literal). `DateTime @updatedAt` on an existing table is
  `@default(now()) @updatedAt` (#1990).
- A new model is always safe — it is a `CREATE TABLE`.
- Never change an `@id`. Add a surrogate key in an expand step (the `Setting`
  sequence: `prisma/push-setting-id-expand.mjs` → `prisma/backfill-setting-id.mjs`
  → the final push).
- A model that holds tenant data needs `orgId` **and** a `TENANT_MODELS` entry
  (`docs/tenant-isolation.md`); `npm run check:tenant-models` enforces both.

## Expand / backfill / contract

When the end state cannot be pushed in one go onto a populated table, split it:

1. **Expand** — add the new shape next to the old one, nullable / additive.
   Every reader and writer of the old shape keeps working.
2. **Backfill** — fill the new shape from the old, idempotently, as a registry
   entry in `prisma/backfills/registry.mjs` (it runs on every deploy after the
   push until it converges to a no-op).
3. **Contract** — make the new column required / drop the old one, in a **later
   PR**, once the backfill has run on prod *and* shared preview.

The three steps never share a PR: each one is deployed and verified before the
next is written. Inside one deploy, an expand helper can stage steps 1 and 3
around a backfill when the intermediate schema is only needed for minutes —
that is the worked example:

**CompanyInterest** (`prisma/pre-push/registry.mjs`, then the push):

```js
{ id: 'company-interest-expand', script: 'prisma/push-company-interest-expand.mjs', … }   // expand: old unique + new FK indexes together
{ id: 'company-interest-scope',  script: 'prisma/backfill-company-interest-scope.mjs', … } // backfill: deterministic scope keys
// … the Setting expand/backfill pairs …
```

```bash
run_tool node prisma/run-pre-push.mjs                     # every entry above, in order
run_tool npx prisma db push --accept-data-loss            # contract: the final schema
```

MySQL used the legacy `(companyId, menteeId)` unique index to back the
`companyId` foreign key; Prisma's diff can order the `DROP` of that index
before creating its replacement, which MySQL rejects. The expand push creates
both, so the final push only has to drop the old one (header of
`prisma/push-company-interest-expand.mjs`).

A **multi-deploy** example is `MentorshipRelation.lifecycleState` (#1768):
nullable with a DB default, filled by a registered backfill, and made required
only in a separate, later contract PR.

## Rollback

```bash
CONTAINER=internship-crm ./infra/deploy-prod.sh --rollback
```

- **It rolls back the IMAGE, not the schema.** `--rollback` starts the
  `${CONTAINER}:previous` image the last deploy tagged, and touches nothing but
  docker — no git, no build, no push. The database keeps whatever shape the
  failed deploy pushed.
- That is safe exactly when the change was additive: the old code ignores a new
  nullable column or table. It is **not** safe after a contract step (the old
  code expects a column that is gone) — which is why contracts ship separately.
- Prod runs with `FORWARD_ONLY=1`: an ordinary deploy refuses a commit older
  than the one that is live. A deliberate redeploy of an older commit needs
  `FORCE=1`, and then the push makes the DB look like the *older* schema —
  which drops what the newer schema added. Prefer `--rollback`.
- To undo a schema change, write a **compensating forward change** (a new PR
  whose schema is the shape you want) and deploy it normally.
- When data was lost, do not push your way out of it: restore from the
  pre-deploy dump first (`docs/disaster-recovery.md` § Restore), then deploy.

One more thing a rollback does not undo: a **data** migration. The backfills
are written to be idempotent and forward-only; the previous image simply does
not read what they wrote.

## A push failed halfway

There is no migration table to repair. MySQL DDL is not transactional, so a
failed `db push` can leave some statements applied and others not. The deploy
stops at that step (`set -euo pipefail`); the old container keeps serving.

```bash
# 1. what does the DB still differ in? (prints the remaining SQL, writes nothing)
docker run --rm -e DATABASE_URL="$DATABASE_URL" "$IMAGE" \
  npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
# 2. if it is a Json-column '' fill (below), repair, then deploy again
docker run --rm -e DATABASE_URL="$DATABASE_URL" "$IMAGE" node prisma/backfill-json-columns.mjs --repair
```

Then fix forward: correct the schema (or add the missing expand step) in a PR
and deploy. Every later deploy re-runs the same push, so a push that cannot be
applied blocks **every** deploy after it until the schema is fixed — that is
how #2249 held 13 commits.

## MariaDB / MySQL traps

- **Json columns lose their default and get `''`.** Prisma drops `@default` on a
  `Json` field in the DDL, so a new one is `ADD COLUMN x JSON NOT NULL`; on
  MariaDB (`JSON` = `LONGTEXT`) every existing row gets the empty string, which
  Prisma cannot parse — `User.languages` locked every older account out of
  sign-in (#1150). A half-applied push can also leave `''` behind and make the
  next push die on the json_valid() CHECK (#1288). Hence
  `backfill-json-columns.mjs --repair` both **before and after** the push. A
  new Json column on an existing table: make it nullable.
- **Enum widening vs narrowing.** Adding a value emits the same
  `ALTER TABLE … MODIFY … ENUM(…)` as removing one; `infra/schema-guard.sh`
  tells them apart with the reverse diff (#1223, #1244). Removing a value is
  destructive. Prefer a free `String` + a whitelist in code for anything that
  will grow (`pipelineStatus`, `lifecycleState`).
- **An FK silently adopts a new index.** Add `@@index([orgId, …])` to a table
  whose `orgId` FK only had MySQL's implicit index, and MySQL drops the
  implicit one and uses yours; a later push of a schema *without* your index
  then fails with "needed in a foreign key constraint" (seen on
  `MentorshipRelation` in #1990). Keep a plain `@@index([orgId])` if the
  composite might go.
- **Big `ALTER TABLE`s rebuild the table.** Adding an index or a column to a
  large table (`ActivityLog`, `Notification`, `EmailLog`) copies it; on a busy
  prod that is minutes of locked writes. Schedule it, and say so in the PR.
- **MariaDB accepts what MySQL 8 refuses** (and the other way round: savepoints
  over the prepared-statement protocol, #2988). CI runs MySQL 8; test locally
  on MySQL 8, not MariaDB.

## The DANGEROUS list (Initiative #1514)

Each of these is a drop-and-recreate if written as one schema edit. Each needs
its own expand → backfill → contract plan, reviewed before the first PR.

| Change | Why it is dangerous |
|---|---|
| `orgId` on `Setting` | It changed the primary key of a `key String @id` table. **Done** as expand (`push-setting-id-expand.mjs`) → backfill (`backfill-setting-id.mjs`) → contract — the reference sequence. |
| Retiring `CompanyNeed` (#1359) | Its rows must have been converted to `Requisition` first. `scripts/backfill-requisitions.mjs` only really runs on deploy since #1540 (the image did not contain it); verify the conversion on prod before any drop. |
| Unifying `Goal` and `ProjectTask` | Two tables become one: a rename at best, DROP + CREATE as `db push` sees it, with every child row's FK re-pointed. |
| Re-keying `PipelineStage` / `StageSla` to `programId` | Their unique keys are `@@unique([orgId, key])`; changing a unique that other rows join on is a re-key. |
| Splitting the `Role` enum into a permission model | `Role` is in the JWT and compared in hundreds of places (`schema.prisma` notes why `SUPER_ADMIN` is not in it); narrowing the enum is destructive. Add the new model alongside; never remove a `Role` value in the same deploy. |
| Skills free text → taxonomy | **Done additively** (#1815, #1819): `Skill` / `UserSkill` next to the JSON `skills`, filled by a backfill. Dropping the JSON column is a separate contract step. |

## Never do this

- **Never `prisma migrate reset`, `migrate dev` or `migrate deploy` against a
  shared database.** This project has no migration history; those commands
  create one or wipe the data.
- **Never run `prisma db push` against prod or the shared preview by hand.** The
  deploy runs it after the backup and the schema guard; by hand it runs after
  neither (`docs/disaster-recovery.md` § Never do this).
- **Never rename a column or a model and call it additive.** `db push` sees a
  DROP and an ADD; the data in the old column is gone.
- **Never use "it worked on the topic preview" as evidence.** That database is
  fresh (#1185); run `npm run check:schema-push` and a diff against data.
- **Never put expand and contract in one PR**, and never contract before the
  backfill has run on prod *and* shared preview.
- **Never add an `EXEMPT` entry to `check:schema-push` to get green.** The fix is
  expand → backfill → contract.
- **Never add a backfill as a new line in `infra/deploy-prod.sh`.** Add an entry
  to `prisma/backfills/registry.mjs`; the unit test fails on a direct line.
- **Never add an expand step as a line in a deploy script.** Add an entry to
  `prisma/pre-push/registry.mjs`. Three scripts push onto existing tables, and a
  step copied into two of them is how the demo died on `Setting_orgId_key_key`
  (#3144). `scripts/test/pre-push-registry.test.mjs` fails on a direct line and
  on a `prisma/push-*-expand.mjs` the registry does not list.
