import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  EXEMPT,
  analyzeSchemas,
  parseSchema,
} from '../check-schema-push-safety.mjs';

// scripts/check-schema-push-safety.mjs is the only thing standing between a
// schema diff that `prisma db push` cannot apply to a populated table and a
// stalled production deploy (#2298). It cannot be exercised by any e2e run:
// every PR topic environment pushes against a FRESH database (#1185), where
// exactly the steps this guard refuses are perfectly legal. That is the whole
// reason #2249 went green everywhere and then stalled prod and preview for 13
// commits — so the assertions live here, on the classifier itself.
//
// The two failure modes are opposite and both expensive. Too narrow and the
// next `@id @default(cuid())` reaches the deploy unexamined; too broad and it
// fires on the ordinary additive change (a nullable column, a whole new model —
// every model in this tree carries `id String @id @default(cuid())`), at which
// point people learn to bypass it. Both directions are pinned below.

const SCHEMA_HEADER = `datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

enum OrgPlan {
  FREE
  PRO
}
`;

const schema = (...models) => `${SCHEMA_HEADER}\n${models.join('\n')}\n`;

const KEEP = `model Keep {
  id    String @id @default(cuid())
  value String
}
`;

// ── The real #2249 diff ──────────────────────────────────────────────────────
// Both blocks are verbatim from `git show aa257b2 -- prisma/schema.prisma`
// (the merge commit of #2249). Nothing else in that diff touched a column: the
// only other change was `settings Setting[]` on Organization, a list relation,
// which is included here precisely because it must be ignored.

const SETTING_BEFORE = `model Setting {
  key       String   @id
  value     String   @db.Text
  updatedAt DateTime @updatedAt
}
`;

const SETTING_AFTER = `model Setting {
  id        String   @id @default(cuid())
  orgId     String?
  key       String
  value     String   @db.Text
  updatedAt DateTime @updatedAt

  org Organization? @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@unique([orgId, key])
}
`;

const ORGANIZATION_BEFORE = `model Organization {
  id   String @id @default(cuid())
  name String
}
`;

const ORGANIZATION_AFTER = `model Organization {
  id       String    @id @default(cuid())
  name     String
  settings Setting[]
}
`;

test('fires on the real #2249 diff, naming the model and the field', () => {
  const findings = analyzeSchemas(
    schema(ORGANIZATION_BEFORE, SETTING_BEFORE),
    schema(ORGANIZATION_AFTER, SETTING_AFTER),
  );
  const errors = findings.filter((f) => f.level === 'error');
  const keys = errors.map((f) => f.key).sort();

  // The new NOT NULL column with a Prisma-generated default is the step the
  // live database refused ("There are 8 rows in this table, it is not possible
  // to execute this step"); the primary key moving from `key` to `id` is the
  // DROP + CREATE that would have destroyed the rows had it been allowed.
  assert.deepEqual(keys, ['Setting.@id', 'Setting.id']);

  const column = errors.find((f) => f.key === 'Setting.id');
  assert.match(column.message, /Setting\.id/);
  assert.match(column.message, /@default\(cuid\(\)\)/);
  assert.match(column.message, /db push/);
  assert.match(column.message, /not possible to execute this step/);
  // The pointer at a worked expand/backfill/contract script is half the
  // deliverable: a failure nobody knows how to fix gets bypassed.
  assert.match(column.message, /prisma\/push-[a-z-]+\.mjs/);

  const key = errors.find((f) => f.key === 'Setting.@id');
  assert.match(key.message, /primary key changes from `key` to `id`/);

  // `@@unique([orgId, key])` is NOT reported: `orgId` is new in this diff, so
  // there are no existing rows that could collide on the pair.
  assert.equal(
    findings.some((f) => f.key.includes('@unique')),
    false,
  );

  // `settings Setting[]` on Organization is a list relation — no column, no
  // finding, even though the model exists on both sides.
  assert.equal(
    findings.some((f) => f.key.startsWith('Organization.')),
    false,
  );
});

test('says nothing about a nullable column added to an existing model', () => {
  const before = `model Keep {
  id    String @id @default(cuid())
  value String
}
`;
  const after = `model Keep {
  id       String  @id @default(cuid())
  value    String
  nickname String?
  ownerId  String?
}
`;
  assert.deepEqual(analyzeSchemas(schema(before), schema(after)), []);
});

test('says nothing about a brand-new model, however it is keyed', () => {
  const after = `model Fresh {
  id        String   @id @default(cuid())
  orgId     String
  label     String
  createdAt DateTime @default(now())

  @@unique([orgId, label])
}
`;
  // A model that does not exist at the base has no rows in any environment, so
  // every step that creates it is legal. This is the biggest source of
  // would-be false positives — every model in this tree is keyed exactly so.
  assert.deepEqual(analyzeSchemas(schema(KEEP), schema(KEEP, after)), []);
});

test('says nothing about a required column MySQL can fill itself', () => {
  const before = `model Keep {
  id    String @id @default(cuid())
  value String
}
`;
  const after = `model Keep {
  id        String   @id @default(cuid())
  value     String
  count     Int      @default(0)
  label     String   @default("")
  flag      Boolean  @default(false)
  stampedAt DateTime @default(now())
  plan      OrgPlan  @default(FREE)
  seq       Int      @default(autoincrement())
  raw       String   @default(dbgenerated("(uuid())"))
}
`;
  assert.deepEqual(analyzeSchemas(schema(before), schema(after)), []);
});

test('says nothing about an index-only change', () => {
  const before = `model Keep {
  id    String @id @default(cuid())
  value String

  @@index([value])
}
`;
  const after = `model Keep {
  id    String @id @default(cuid())
  value String

  @@index([value, id])
  @@index([id])
}
`;
  assert.deepEqual(analyzeSchemas(schema(before), schema(after)), []);
});

test('fires on a required column with no default at all', () => {
  const before = KEEP;
  const after = `model Keep {
  id    String @id @default(cuid())
  value String
  owner String
}
`;
  const findings = analyzeSchemas(schema(before), schema(after));
  assert.deepEqual(
    findings.map((f) => [f.key, f.level]),
    [['Keep.owner', 'error']],
  );
  assert.match(findings[0].message, /NOT NULL with no default/);
});

test('fires on a required enum column with no default', () => {
  const after = `model Keep {
  id    String  @id @default(cuid())
  value String
  plan  OrgPlan
}
`;
  const findings = analyzeSchemas(schema(KEEP), schema(after));
  assert.deepEqual(
    findings.map((f) => f.key),
    ['Keep.plan'],
  );
});

test('fires on every client-side id generator, and on one it does not know', () => {
  for (const expression of ['cuid()', 'uuid()', 'uuid(7)', 'ulid()', 'nanoid()', 'auto()']) {
    const after = `model Keep {
  id    String @id @default(cuid())
  value String
  extra String @default(${expression})
}
`;
    const findings = analyzeSchemas(schema(KEEP), schema(after));
    assert.deepEqual(
      findings.map((f) => f.key),
      ['Keep.extra'],
      `@default(${expression}) must be treated as client-side`,
    );
  }

  // Fail closed: a default this script cannot classify is exactly the case a
  // human should look at, so it is reported rather than assumed harmless.
  const unknown = `model Keep {
  id    String @id @default(cuid())
  value String
  extra String @default(someFutureGenerator())
}
`;
  assert.deepEqual(
    analyzeSchemas(schema(KEEP), schema(unknown)).map((f) => f.key),
    ['Keep.extra'],
  );
});

test('fires on a composite primary key replacing a single one', () => {
  const before = `model Keep {
  id    String @id @default(cuid())
  value String
}
`;
  const after = `model Keep {
  id    String
  value String

  @@id([id, value])
}
`;
  const findings = analyzeSchemas(schema(before), schema(after));
  assert.deepEqual(
    findings.map((f) => f.key),
    ['Keep.@id'],
  );
  assert.match(findings[0].message, /DROP PRIMARY KEY/);
});

test('warns — but does not fail — on a unique constraint over existing columns', () => {
  const before = `model Keep {
  id    String @id @default(cuid())
  orgId String
  value String
}
`;
  const after = `model Keep {
  id    String @id @default(cuid())
  orgId String
  value String

  @@unique([orgId, value])
}
`;
  const findings = analyzeSchemas(schema(before), schema(after));
  // Whether it fails depends on data this script cannot see, and a gate that
  // goes red on a maybe is a gate people learn to bypass.
  assert.deepEqual(
    findings.map((f) => [f.key, f.level]),
    [['Keep.@unique(orgId, value)', 'warning']],
  );

  // A field-level @unique on an existing column is the same risk, same level.
  const fieldLevel = `model Keep {
  id    String @id @default(cuid())
  orgId String
  value String @unique
}
`;
  assert.deepEqual(
    analyzeSchemas(schema(before), schema(fieldLevel)).map((f) => [f.key, f.level]),
    [['Keep.@unique(value)', 'warning']],
  );
});

test('a comment or a // inside a string default does not confuse the parser', () => {
  const { models } = parseSchema(
    schema(`model Keep {
  id    String @id @default(cuid()) // the surrogate key
  home  String @default("https://interncrm.com") // not a comment
  value String
}
`),
  );
  const keep = models.get('Keep');
  assert.equal(keep.primaryKey, 'id');
  assert.equal(keep.fields.get('home').default, '"https://interncrm.com"');
  assert.equal(keep.fields.get('home').defaultKind, 'db');
});

test("today's schema parses, and comparing it with itself is clean", () => {
  const source = readFileSync('prisma/schema.prisma', 'utf8');
  const { models } = parseSchema(source);
  // A parser that silently matched nothing would report every schema as clean.
  assert.ok(models.size > 50, `expected the real schema to parse, got ${models.size} models`);
  for (const [name, model] of models) {
    assert.ok(model.primaryKey !== null, `${name} parsed without a primary key`);
  }
  assert.deepEqual(analyzeSchemas(source, source), []);
});

test('every EXEMPT entry carries a written reason', () => {
  for (const [key, reason] of EXEMPT) {
    assert.ok(typeof reason === 'string' && reason.trim().length > 10, `${key} needs a reason`);
  }
});

// ── The CLI, end to end ──────────────────────────────────────────────────────

const SCRIPT = path.resolve('scripts/check-schema-push-safety.mjs');

const runCli = (options = {}) =>
  spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    ...options,
    env: { ...process.env, GITHUB_ACTIONS: '', ...(options.env ?? {}) },
  });

test('the CLI is quiet when the schema has not moved since the base', () => {
  const run = runCli({ env: { SCHEMA_PUSH_SAFETY_BASE: 'HEAD' } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /schema push safety OK/);
});

test('the CLI fails closed when there is no base revision to diff against', () => {
  // A shallow clone with no merge-base must never be reported as "no problem":
  // that is the one outcome that puts the failure back on the deploy.
  const outside = mkdtempSync(path.join(tmpdir(), 'schema-push-safety-'));
  try {
    const run = runCli({ cwd: outside });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /schema push safety FAILED/);
    assert.match(run.stderr, /not a git repository/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the CLI fails on the real #2249 commit when git can reach it', (t) => {
  // The verbatim fixture above is the assertion that always runs; this one
  // exercises the whole path — merge-base resolution, `git show`, the exit code
  // — against the actual commit that broke production. It needs history, which
  // a shallow clone does not have (CI checks out with fetch-depth: 0).
  const reachable =
    spawnSync('git', ['cat-file', '-e', 'aa257b2^{commit}'], { encoding: 'utf8' }).status === 0;
  if (!reachable) {
    t.skip('aa257b2 (#2249) is not in this clone — run with full history');
    return;
  }

  const run = runCli({ env: { SCHEMA_PUSH_SAFETY_BASE: 'aa257b2^' } });
  assert.equal(run.status, 1, `expected the #2249 schema step to be refused\n${run.stdout}`);
  assert.match(run.stderr, /schema push safety FAILED/);
  assert.match(run.stderr, /Setting\.id/);
  assert.match(run.stderr, /EXEMPT/);
});
