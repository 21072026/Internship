import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The usage-signal schema (#2446), pinned where a reviewer can see it break.
//
// WHY THIS TEST EXISTS. Every decision below was made AGAINST the obvious one,
// and the obvious one is written down in the inherited backlog
// (docs/marketing-vertical/backlog/epic-09-product-signals.md, T-9.1.2) as
// "`Customer.externalId` — nullable, `@unique`". A later reader who finds a
// duplicate merchant id and "fixes" the column by adding `@unique` — or who
// adds `@@unique([orgId, externalId])` because per-tenant uniqueness is what we
// actually want — gets a constraint that enforces NOTHING while the column is
// still null on every row (MySQL counts NULLs in a unique index as distinct),
// and then breaks two tenants who legitimately share an id the day it stops
// being null. That is the trap User.externalId and Job.idempotencyKey already
// document; this is the assertion that keeps the third instance of it out.
//
// The rest pins what the data contract promises
// (docs/marketing-vertical/salevali-usage-feed.md): a day is a day, one row per
// account per day, the row dies with its account, the table is tenant-scoped,
// and it has a retention window because it grows every night for ever.
//
// Text assertions, deliberately: the acceptance criteria are statements about
// the SCHEMA FILE ("not @unique", "indexed on [orgId, externalId]"), and a
// generated client cannot answer either of them — it has no idea whether a
// lookup is backed by an index, and it reports a unique constraint the same way
// whatever the column names are.

const root = process.cwd();
const schema = readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
const orgContext = readFileSync(path.join(root, 'src/lib/orgContext.ts'), 'utf8');
const retentionEntries = readFileSync(path.join(root, 'src/lib/retentionEntries.ts'), 'utf8');

/** One model's body, comments and all. */
function model(name) {
  const match = schema.match(new RegExp(`^model ${name} \\{$([\\s\\S]*?)^\\}$`, 'm'));
  assert.ok(match, `model ${name} is missing from prisma/schema.prisma`);
  return match[1];
}

/** The model body with `//` and `///` comment lines stripped — the declarations only. */
function declarations(body) {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

test('Company.externalId is nullable, bounded and NOT unique', () => {
  const body = declarations(model('Company'));
  const field = body.match(/^\s*externalId\s+(.+)$/m);
  assert.ok(field, 'Company.externalId is missing');

  const decl = field[1];
  assert.match(decl, /^String\?/, 'externalId must be optional — most companies never have one');
  assert.match(decl, /@db\.VarChar\(191\)/, 'externalId must be bounded so it can be indexed');
  assert.doesNotMatch(
    decl,
    /@unique/,
    'externalId must NOT be @unique: two tenants may legitimately use the same id, and the ' +
      'uniqueness that matters is per tenant (see the comment on the field)',
  );
});

test('Company.externalId is looked up through a tenant-leading index', () => {
  const body = declarations(model('Company'));
  assert.match(
    body,
    /@@index\(\[orgId, externalId\]\)/,
    'the feed resolves a row by (org, external id); without this index that is a table scan ' +
      'and, under MT_ENFORCE_ISOLATION, a row-by-row orgId filter',
  );
  assert.doesNotMatch(
    body,
    /@@unique\(\[orgId, externalId\]\)/,
    'a composite unique over a NULLABLE pair de-duplicates nothing in MySQL — the same trap ' +
      'documented on User.externalId and Job.idempotencyKey',
  );
});

test('CompanyUsage holds one row per account per day', () => {
  const body = declarations(model('CompanyUsage'));

  assert.match(
    body,
    /^\s*date\s+DateTime\s+@db\.Date\b/m,
    'the grain is a DAY: @db.Date, so reading a row on another continent cannot shift it into ' +
      'the neighbouring day and produce a second row for it',
  );
  assert.match(body, /^\s*transactions\s+Int\s+@default\(0\)/m, 'transactions is a required count');
  assert.match(body, /^\s*orders\s+Int\?/m, 'orders is optional — not every feed carries it');

  assert.match(
    body,
    /@@unique\(\[companyId, date\]\)/,
    'the idempotency key of the sync: re-fetching an overlapping window must overwrite a day, ' +
      'never append a second row for it',
  );
  assert.match(
    body,
    /@@index\(\[date\]\)/,
    'the retention sweep asks for the oldest rows across ALL accounts, which the ' +
      '(companyId, date) key cannot serve — the PageView lesson',
  );
  assert.doesNotMatch(
    body,
    /@@index\(\[companyId, date\]\)/,
    '@@unique([companyId, date]) is already that index; declaring it twice maintains two ' +
      'identical B-trees on the fastest-growing table in the vertical',
  );
});

test('CompanyUsage is tenant data and dies with its account', () => {
  const body = declarations(model('CompanyUsage'));

  assert.match(body, /^\s*orgId\s+String\?/m, 'nullable orgId, mirroring Company');
  assert.match(
    body,
    /org\s+Organization\?\s+@relation\(fields: \[orgId\], references: \[id\]\)/,
    'the org relation is what makes the column a real anchor rather than a loose string',
  );
  assert.match(
    body,
    /company\s+Company\s+@relation\(fields: \[companyId\], references: \[id\], onDelete: Cascade\)/,
    'usage rows that outlive their company describe nothing and would only accumulate',
  );

  assert.match(
    orgContext,
    /^\s*'CompanyUsage',$/m,
    "CompanyUsage carries orgId, so it must be registered in TENANT_MODELS — an unregistered " +
      'model is ignored by the middleware in silence (check:tenant-models fails on this too, ' +
      'and this assertion says WHY)',
  );
});

test('CompanyUsage has a retention window', () => {
  assert.match(
    retentionEntries,
    /key: 'companyUsage'/,
    'an unbounded table that gains one row per account every night needs an entry in the one ' +
      'retention registry — that is the PageView lesson the schema comment cites',
  );
  const sweep = retentionEntries.match(/prisma\.companyUsage\.findMany\(\{[\s\S]*?\}\)/);
  assert.ok(sweep, 'the entry must select the rows it is about to delete (pruneInBatches)');
  assert.match(
    sweep[0],
    /where: \{ date: \{ lt: ctx\.cutoff \} \}/,
    'the sweep must select by `date` (the day the usage happened), not by createdAt: a ' +
      'backfill writes old days today, and a createdAt rule would never delete them',
  );
});
