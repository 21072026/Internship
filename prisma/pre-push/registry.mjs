// The steps that make `prisma db push` succeed against a database that already
// has tables, in the order they run (#3144). Run by prisma/run-pre-push.mjs.
//
// Before this file they were hand-copied lines in THREE places: infra/deploy-prod.sh
// (fatal), infra/server/topic-deploy.sh (`|| true`) and nowhere at all in
// infra/server/demo-refresh.sh. #3073 added push-setting-program-expand.mjs to
// the first two; the demo, missing it, died on its next push with "Cannot drop
// index 'Setting_orgId_key_key': needed in a foreign key constraint" and stayed
// wiped. One list now, and all three callers run it through the one runner
// (scripts/test/pre-push-registry.test.mjs fails on a direct line in any of them).
//
// These are NOT data migrations. Those follow the push and live in
// prisma/backfills/registry.mjs, with a ledger; these bracket the push itself,
// converge to a no-op once applied, and so run every time with no ledger.
//
// Each entry:
//   id        kebab-case name for the log
//   script    the file the runner executes with `node`, relative to the repo
//             root. prisma/ is copied into the image whole.
//   args      extra arguments
//   optional  true: a failure is printed and the run goes on (was `|| true`
//             on prod). `why` says why it may fail without stopping the push.
//   why       the reason the step exists, and the reason it is optional
//
// THE ORDER IS LOAD-BEARING (the test pins it): every expand push runs before
// the backfill that fills what it added, and the Json repair runs last, right
// before the push it unblocks.
export const PRE_PUSH_STEPS = [
  {
    id: 'company-interest-expand',
    script: 'prisma/push-company-interest-expand.mjs',
    optional: false,
    why: "MySQL backs CompanyInterest's companyId FK with the legacy (companyId, menteeId) unique, and Prisma's diff drops it before creating the replacement. Expand to both first.",
  },
  {
    id: 'company-interest-scope',
    script: 'prisma/backfill-company-interest-scope.mjs',
    optional: false,
    why: 'Fills the deterministic scope keys the expand added, so the contract push has no NULLs to reject.',
  },
  {
    id: 'setting-id-expand',
    script: 'prisma/push-setting-id-expand.mjs',
    optional: false,
    why: 'Adds the Setting.id surrogate key nullable, before the push makes it the primary key.',
  },
  {
    id: 'setting-id',
    script: 'prisma/backfill-setting-id.mjs',
    optional: false,
    why: 'Fills Setting.id for pre-existing rows, so the contract push has no NULLs left.',
  },
  {
    id: 'setting-program-expand',
    script: 'prisma/push-setting-program-expand.mjs',
    optional: false,
    why: "#1619 re-keys Setting to (orgId, programId, key). MySQL backs the orgId FK with the old (orgId, key) unique, and Prisma drops it first. Expand to old + new indexes while the legacy one exists.",
  },
  {
    id: 'json-columns-repair',
    script: 'prisma/backfill-json-columns.mjs',
    args: ['--repair'],
    optional: true,
    why:
      'Also before the push, not only after (#1288). A half-applied push can leave a Json column filled ' +
      "with '' (MariaDB's longtext fill), and the next push then dies at any step that rebuilds the table, " +
      'which re-validates json_valid() against the poisoned rows. That wedged the 2026-08-24 prod deploy. ' +
      'Optional because the push is attempted either way, and it reports its own problem if one is left.',
  },
];
