import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  analyzeSource,
  checkTree,
  maskCode,
  sourceFiles,
  EXEMPT,
  LOOKUP_API,
  METHODS,
} from '../check-user-email-lookups.mjs';

// scripts/check-user-email-lookups.mjs reads TypeScript with a scanner rather
// than a parser (#2590), and its two failure modes are both silent on the tree
// it ships with.
//
// TOO LENIENT is the one that costs something: a lookup the reader calls pinned
// (or does not see at all) when it is not leaves exactly the bug the guard
// exists for — `findFirst({ where: { email } })` signing a person into the wrong
// product — and a green check makes it look reviewed. The reflex fix for the
// compile error Prisma now gives on `findUnique({ where: { email } })` IS that
// `findFirst`, so the guard has to tell the two shapes apart when the compiler
// cannot.
//
// TOO STRICT is cheap in principle — CI goes red and somebody looks — but a
// guard that cries wolf on `data: { email }`, on a search box or on a lookup by
// primary key gets an EXEMPT entry rather than a fix, which is the same outcome
// one step later.
//
// The cases below pin both directions on fixture strings, so they hold whatever
// the real tree happens to contain today. (The tree itself is the CI step's job,
// not this file's: a unit test that read the live tree would go red on
// somebody else's commit.)

const verdicts = (source) => analyzeSource(source).map((c) => c.verdict);
const only = (source) => {
  const calls = analyzeSource(source);
  assert.equal(calls.length, 1, `expected exactly one User call, read ${calls.length}`);
  return calls[0].verdict;
};

// ── too lenient: these must be caught ────────────────────────────────────────

test('a bare e-mail lookup is a violation — the very shape #2590 is about', () => {
  assert.equal(only(`const u = await prisma.user.findFirst({ where: { email } });`), 'violation');
  assert.equal(only(`const u = await prisma.user.findFirst({ where: { email: body.email } });`), 'violation');
  assert.equal(only(`await prisma.user.findFirst({ where: { email: normalizeEmail(email) }, select: { id: true } });`), 'violation');
});

test('every guarded method is read, not just findFirst', () => {
  for (const method of METHODS) {
    const source = `await prisma.user.${method}({ where: { email } });`;
    assert.equal(only(source), 'violation', method);
  }
});

test('the receiver does not matter: tx, a renamed client, a multi-line chain', () => {
  assert.equal(only(`await tx.user.findFirst({ where: { email } });`), 'violation');
  assert.equal(only(`await appPrisma.user.findFirst({ where: { email } });`), 'violation');
  assert.equal(only(`await db.user.updateMany({ where: { email }, data: { x: 1 } });`), 'violation');
  assert.equal(only(`await prisma\n  .user\n  .findFirst({\n    where: { email },\n  });`), 'violation');
  assert.equal(only(`await (await getClient()).user.findFirst({ where: { email } });`), 'violation');
});

test('the line reported is the line of the call', () => {
  const calls = analyzeSource(`\n\nconst a = 1;\nconst u = await prisma.user.findFirst({ where: { email } });\n`);
  assert.equal(calls[0].line, 4);
});

test('a call nested in another expression is still read (an arrow, an await, a Promise.all)', () => {
  assert.equal(only(`const n = (await runUnscoped(() => prisma.user.count({ where: { email: u.email } }))) > 0;`), 'violation');
  assert.deepEqual(
    verdicts(`await Promise.all([prisma.user.findFirst({ where: { email } }), prisma.user.count({ where: { email } })]);`),
    ['violation', 'violation'],
  );
});

test('email inside an OR / AND is still an e-mail lookup', () => {
  assert.equal(only(`prisma.user.findFirst({ where: { OR: [{ email }, { fullName }] } });`), 'violation');
  assert.equal(only(`prisma.user.findMany({ where: { AND: [{ email }, { role: 'MENTOR' }] } });`), 'violation');
  assert.equal(only(`prisma.user.findMany({ where: { AND: { email } } });`), 'violation');
});

test('under OR a pin only counts when EVERY branch carries one', () => {
  // The unpinned branch can still return the other world's row.
  assert.equal(only(`prisma.user.findMany({ where: { OR: [{ email, orgId }, { email: other }] } });`), 'violation');
  assert.equal(only(`prisma.user.findMany({ where: { OR: [{ email, orgId }, { fullName, orgId: b }] } });`), 'pinned');
  assert.equal(only(`prisma.user.findMany({ where: { OR: [{ email }, { fullName }], orgId } });`), 'pinned');
});

test('a quoted key is still a key', () => {
  assert.equal(only(`prisma.user.findFirst({ where: { 'email': e } });`), 'violation');
  assert.equal(only(`prisma.user.findFirst({ where: { "email": e, "orgId": o } });`), 'pinned');
});

test('email operators other than a search are still a lookup', () => {
  assert.equal(only(`prisma.user.findMany({ where: { email: { in: emails } } });`), 'violation');
  assert.equal(only(`prisma.user.findFirst({ where: { email: { equals: e, mode: 'insensitive' } } });`), 'violation');
  assert.equal(only(`prisma.user.findMany({ where: { email: { not: null } } });`), 'violation');
});

test('things that LOOK like a pin but are not', () => {
  // `id: { not }` admits every other row — the 2FA "twin" count is exactly this shape.
  assert.equal(only(`prisma.user.count({ where: { email: u.email, id: { not: userId } } });`), 'violation');
  assert.equal(only(`prisma.user.count({ where: { email: u.email, id: { notIn: ids } } });`), 'violation');
  // `undefined` is "no filter" to Prisma.
  assert.equal(only(`prisma.user.findFirst({ where: { email, orgId: undefined } });`), 'violation');
  // A negated org still admits every other organization, in both worlds.
  assert.equal(only(`prisma.user.findFirst({ where: { email, NOT: { orgId: other } } });`), 'violation');
  // A field that merely contains the letters.
  assert.equal(only(`prisma.user.findFirst({ where: { email, orgIdHint: x, idx: 1, mentorId: m } });`), 'violation');
  // An unknown spread may or may not pin; the guard does not assume it does.
  assert.equal(only(`prisma.user.findFirst({ where: { email, ...scopeFor(session) } });`), 'violation');
  // Only sometimes pinned is not pinned.
  assert.equal(only(`prisma.user.findFirst({ where: { email, ...(orgId ? { orgId } : {}) } });`), 'violation');
});

test('a where held in a variable is followed to its declaration', () => {
  assert.equal(only(`const where = { email };\nawait prisma.user.findFirst({ where });`), 'violation');
  assert.equal(only(`const where: Prisma.UserWhereInput = { email, role: 'MENTOR' };\nawait prisma.user.findFirst({ where });`), 'violation');
  assert.equal(only(`const query = { email };\nawait prisma.user.findFirst({ where: query });`), 'violation');
  assert.equal(only(`const base = { email };\nawait prisma.user.findFirst({ where: { ...base, role: 'MENTOR' } });`), 'violation');
  // ...and pinned when the declaration pins.
  assert.equal(only(`const where = { email, orgId };\nawait prisma.user.findFirst({ where });`), 'pinned');
  assert.equal(only(`const base = { email };\nawait prisma.user.findFirst({ where: { ...base, orgId } });`), 'pinned');
});

test('the nearest declaration before the call wins (two functions, one name)', () => {
  const source = `
async function a() {
  const where = { email, orgId };
  return prisma.user.findFirst({ where });
}
async function b() {
  const where = { email };
  return prisma.user.findFirst({ where });
}`;
  assert.deepEqual(verdicts(source), ['pinned', 'violation']);
});

test('a JSX apostrophe earlier in the file does not blind the guard to a later call', () => {
  const source = `
export default async function Page() {
  return <p>Don't panic — it's fine</p>;
}
export async function later() {
  return prisma.user.findFirst({ where: { email } });
}`;
  assert.equal(only(source), 'violation');
});

test('a regex literal holding a quote earlier in the file does not blind it either', () => {
  const source = `
const QUOTE = /['"]/g;
const clean = (s) => s.replace(/'/g, '');
export async function later() {
  return prisma.user.findFirst({ where: { email } });
}`;
  assert.equal(only(source), 'violation');
});

test('braces and quotes inside strings and templates do not unbalance the call', () => {
  assert.equal(only(`prisma.user.findFirst({ where: { email: '}', note: "{", x: \`\${'}'}\` } });`), 'violation');
  assert.equal(only(`prisma.user.findFirst({ where: { email: \`\${a}}\${b({ c: 1 })}\`, orgId } });`), 'pinned');
  assert.equal(only(`prisma.user.findFirst({ where: { /* orgId, */ email } });`), 'violation');
  assert.equal(only(`prisma.user.findFirst({ where: { email, // orgId,\n } });`), 'violation');
});

test('a call whose brackets never close is reported, never read as clean', () => {
  const calls = analyzeSource(`prisma.user.findFirst({ where: { email }`);
  assert.deepEqual(calls.map((c) => c.verdict), ['unbalanced']);
});

// ── the shapes that are fine ─────────────────────────────────────────────────

test('a lookup that names the world is pinned', () => {
  for (const where of [
    '{ email, orgId }',
    '{ orgId, email }',
    '{ email, orgId: session.user.orgId }',
    '{ email, orgId: null }',
    '{ email, org: { is: { vertical: "MARKETING" } } }',
    '{ email, ...worldUserWhere(world) }',
    '{ ...worldUserWhere(await worldOfOrg(orgId)), email }',
    '{ email: { in: emails }, ...worldUserWhere(world) }',
    '{ AND: [{ email }, worldUserWhere(world)] }',
    '{ email, AND: worldUserWhere(world) }',
    '{ email, ...(await tenantWhere(session)) }',
    '{ email, ...tenantWhere(session) }',
    'withinTenant({ email }, await tenantWhere(session))',
    'withinTenant<Prisma.UserWhereInput>({ email }, tenant)',
    'orgScoped({ email }, orgId)',
  ]) {
    assert.equal(only(`await prisma.user.findFirst({ where: ${where} });`), 'pinned', where);
  }
});

test('the compound unique key names its org by construction, so it is not an e-mail lookup at all', () => {
  assert.equal(only(`prisma.user.findUnique({ where: { email_orgId: { email, orgId } } });`), 'no-email');
});

test('the plain-ESM mirror of the default world (NOT … vertical) is a pin — the seeders cannot import worldUserWhere', () => {
  const inline = `prisma.user.findFirst({ where: { email, NOT: { org: { is: { vertical: { in: ['MARKETING'] } } } } } });`;
  assert.equal(only(inline), 'pinned');
  const viaConst = `
const INTERNSHIP_WORLD = { NOT: { org: { is: { vertical: { in: ['MARKETING'] } } } } };
async function find(email) {
  return prisma.user.findFirst({ where: { email, ...INTERNSHIP_WORLD }, orderBy: { createdAt: 'asc' } });
}`;
  assert.equal(only(viaConst), 'pinned');
});

test('a lookup by primary key is pinned: one row, no world to guess', () => {
  assert.equal(only(`prisma.user.update({ where: { id }, data: { email } });`), 'no-email');
  assert.equal(only(`prisma.user.findFirst({ where: { id: userId, email } });`), 'pinned');
  assert.equal(only(`prisma.user.findMany({ where: { id: { in: ids }, email: { in: emails } } });`), 'pinned');
});

test('withinTenant / orgScoped still have their own where read for an e-mail', () => {
  // The wrapper pins the tenant; it does not make the caller's e-mail a non-lookup.
  // Both forms below are pinned — the point is that the first argument was READ
  // (an unreadable one would be `unread`, and a plain bare email is `violation`).
  assert.equal(only(`prisma.user.findFirst({ where: withinTenant({ id }, tenant) });`), 'no-email');
  assert.equal(only(`prisma.user.findFirst({ where: withinTenant({ email }, tenant) });`), 'pinned');
});

test('a search box is not an identity lookup: contains / startsWith / endsWith / search', () => {
  assert.equal(only(`prisma.user.findMany({ where: { email: { contains: q } } });`), 'no-email');
  assert.equal(only(`prisma.user.findMany({ where: { email: { contains: q, mode: 'insensitive' } } });`), 'no-email');
  assert.equal(only(`prisma.user.findMany({ where: { email: { startsWith: q } } });`), 'no-email');
  assert.equal(only(`prisma.user.findMany({ where: { email: { endsWith: '@x.example' } } });`), 'no-email');
  assert.equal(only(`prisma.user.findMany({ where: { OR: [{ fullName: { contains: q } }, { email: { contains: q } }] } });`), 'no-email');
});

test('an e-mail that is not in the where is not a lookup', () => {
  // The false positives that would get this guard exempted instead of obeyed.
  assert.equal(only(`prisma.user.update({ where: { id }, data: { email: next } });`), 'no-email');
  assert.equal(only(`prisma.user.findUnique({ where: { id }, select: { email: true, orgId: true } });`), 'no-email');
  assert.equal(only(`prisma.user.findMany({ where: { orgId }, select: { id: true, email: true }, orderBy: { email: 'asc' } });`), 'no-email');
  assert.equal(only(`prisma.user.findMany({ where: { role: 'MENTOR' }, include: { mentorships: { where: { mentee: { email } } } } });`), 'no-email');
  assert.equal(only(`prisma.user.findFirst({ where: { emailVerified: { not: null }, contactEmail: e } });`), 'no-email');
  assert.equal(only(`prisma.user.findMany({ where: { NOT: { email: 'a@b.example' } } });`), 'no-email');
  assert.equal(only(`prisma.user.deleteMany({ where: { createdAt: { lt: cutoff } } });`), 'no-email');
  assert.equal(only(`prisma.user.count();`), 'no-email');
  assert.equal(only(`prisma.user.count({ select: { _all: true } });`), 'no-email');
});

test('create is not a lookup and is not read (its rule is emailTakenInWorld, a different question)', () => {
  assert.deepEqual(verdicts(`await prisma.user.create({ data: { email, password } });`), []);
  assert.deepEqual(verdicts(`await prisma.user.createMany({ data: rows });`), []);
});

test('prose and strings that mention a lookup are not calls', () => {
  const source = `
// prisma.user.findFirst({ where: { email } }) is the bug this file guards against
/* and so is prisma.user.findMany({ where: { email } }) */
const msg = "prisma.user.findFirst({ where: { email } })";
const tpl = \`prisma.user.update({ where: { email } })\`;
const re = /prisma\\.user\\.count\\(/;
`;
  assert.deepEqual(analyzeSource(source), []);
});

test('a where the guard cannot read is counted as unread, not as clean and not as a violation', () => {
  assert.equal(only(`prisma.user.findMany(args);`), 'unread');
  assert.equal(only(`prisma.user.findMany({ ...args });`), 'unread');
  assert.equal(only(`function f(where) { return prisma.user.findMany({ where }); }`), 'unread');
  assert.equal(only(`prisma.user.findMany({ where: buildWhere(q), take: 5 });`), 'unread');
  // ...but an e-mail the guard CAN see is never softened by something it cannot.
  assert.equal(only(`prisma.user.findMany({ where: { email, ...buildWhere(q) } });`), 'violation');
});

// ── maskCode ────────────────────────────────────────────────────────────────

test('maskCode keeps every offset and newline', () => {
  const source = "const a = 'x\\'y'; // c\n/* b\nc */ const t = `p${q}r`; const r = /a'b/g;\n";
  const masked = maskCode(source);
  assert.equal(masked.length, source.length);
  assert.deepEqual([...masked].flatMap((c, i) => (c === '\n' ? [i] : [])), [...source].flatMap((c, i) => (c === '\n' ? [i] : [])));
});

test('maskCode blanks comments, string bodies, template bodies and regex bodies — and only those', () => {
  const masked = maskCode("call('secret', `t${x}`, /re'/, 1 / 2); // gone\nconst keep = value;");
  assert.ok(!/secret|gone|re'|t\$/.test(masked), masked);
  assert.ok(/call\(/.test(masked) && /const keep = value;/.test(masked) && /1 \/ 2/.test(masked), masked);
});

// ── the tree ────────────────────────────────────────────────────────────────

const BAD = `export async function f(email: string) {\n  return prisma.user.findFirst({ where: { email } });\n}\n`;
const GOOD = `export async function f(email: string, orgId: string) {\n  return prisma.user.findFirst({ where: { email, orgId } });\n}\n`;
const treeOf = (files, exempt = new Map()) =>
  checkTree({ files: Object.keys(files), read: (f) => files[f], exempt });

test('checkTree names the file and line of an unpinned lookup, and the way out', () => {
  const { problems } = treeOf({ 'src/app/api/x/route.ts': BAD });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^src\/app\/api\/x\/route\.ts:2 /);
  assert.match(problems[0], /findUserInWorld/);
  assert.match(problems[0], /findUsersByEmail/);
});

test('checkTree passes a tree of pinned lookups and counts them', () => {
  const { problems, examined, pinned } = treeOf({ 'src/a.ts': GOOD, 'src/b.ts': GOOD });
  assert.deepEqual(problems, []);
  assert.equal(examined, 2);
  assert.equal(pinned, 2);
});

test('checkTree does not read the lookup API itself: it is the one module that may resolve an e-mail', () => {
  const anyWorld = `export const findUsersByEmail = (email) => prisma.user.findMany({ where: { email } });\n`;
  assert.deepEqual(treeOf({ [LOOKUP_API]: anyWorld }).problems, []);
  // ...and only that path: the same body anywhere else fails.
  assert.equal(treeOf({ 'src/lib/notUserWorld.ts': anyWorld }).problems.length, 1);
  assert.equal(treeOf({ 'src/lib/userWorld.tsx': anyWorld }).problems.length, 1);
});

test('LOOKUP_API is a real file — a rename must not silently void the exemption', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  assert.ok(existsSync(path.join(root, LOOKUP_API)), `${LOOKUP_API} no longer exists; move LOOKUP_API with it`);
});

test('calibration: the lookup API\'s own world-pinned lookups read as pinned', () => {
  // The guard's idea of "pinned" has to match the shape the helper really uses
  // (`email: normalizeEmail(email), ...worldUserWhere(world)`), or the fix the
  // failure message recommends would still fail the check.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const calls = analyzeSource(readFileSync(path.join(root, LOOKUP_API), 'utf8'));
  assert.ok(calls.filter((c) => c.verdict === 'pinned').length >= 2, JSON.stringify(calls.map((c) => c.verdict)));
  // At most the one deliberate "any world" door reads as unpinned.
  assert.ok(calls.filter((c) => c.verdict === 'violation').length <= 1, JSON.stringify(calls.map((c) => c.verdict)));
});

test('an EXEMPT entry excuses exactly the calls it counts', () => {
  const two = `${BAD}${BAD}`;
  const exempt = (calls) =>
    new Map([['src/lib/twin.ts', { calls, reason: 'counts the OTHER accounts of the mailbox on purpose, across worlds' }]]);

  assert.deepEqual(treeOf({ 'src/lib/twin.ts': BAD }, exempt(1)).problems, []);
  assert.equal(treeOf({ 'src/lib/twin.ts': BAD }, exempt(1)).excused, 1);

  // A NEW unpinned lookup next to an excused one still fails...
  const grown = treeOf({ 'src/lib/twin.ts': two }, exempt(1)).problems;
  assert.ok(grown.some((p) => /holds 2 unpinned/.test(p) && /excuses 1/.test(p)), grown.join('\n'));
  assert.ok(grown.some((p) => /^src\/lib\/twin\.ts:\d+ /.test(p)), 'and names the calls');

  // ...and an excuse that stopped being needed fails too.
  const stale = treeOf({ 'src/lib/twin.ts': GOOD }, exempt(1)).problems;
  assert.equal(stale.length, 1);
  assert.match(stale[0], /only 0 remain/);
});

test('an EXEMPT entry for a file the check no longer reads is stale', () => {
  const exempt = new Map([['src/lib/gone.ts', { calls: 1, reason: 'a perfectly good reason that outlived its file' }]]);
  const { problems } = treeOf({ 'src/a.ts': GOOD }, exempt);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/lib\/gone\.ts/);
  assert.match(problems[0], /delete the entry/);
});

test('an EXEMPT entry needs a real reason and a positive count', () => {
  for (const entry of [
    { calls: 1, reason: '' },
    { calls: 1, reason: 'todo' },
    { calls: 0, reason: 'a perfectly good reason that excuses nothing at all' },
  ]) {
    const { problems } = treeOf({ 'src/lib/x.ts': BAD }, new Map([['src/lib/x.ts', entry]]));
    assert.ok(problems.some((p) => /needs a positive `calls` and a real `reason`/.test(p)), JSON.stringify(entry));
  }
});

test('the shipped EXEMPT entries are well-formed and none of them excuses the lookup API', () => {
  for (const [file, entry] of EXEMPT) {
    assert.notEqual(file, LOOKUP_API, 'the lookup API is exempt by construction, not by an entry');
    assert.ok(entry.calls > 0, file);
    assert.ok(entry.reason.trim().length >= 20, `${file}: a reason is the whole point of an entry`);
  }
});

test('checkTree reports an unbalanced call as a problem', () => {
  const { problems } = treeOf({ 'src/a.ts': `prisma.user.findFirst({ where: { email }` });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /do not balance/);
});

test('checkTree lists unread calls without failing on them', () => {
  const { problems, unread } = treeOf({ 'src/a.ts': `\nprisma.user.findMany(args);\n` });
  assert.deepEqual(problems, []);
  assert.deepEqual(unread, ['src/a.ts:2']);
});

// ── which files are read ─────────────────────────────────────────────────────

/** A fake readdir over a nested { name: children | null } tree, shaped like fs.Dirent. */
function fakeList(tree) {
  return (dir) => {
    let node = tree;
    for (const part of dir.split('/')) node = node?.[part];
    if (!node) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return Object.entries(node).map(([name, child]) => ({ name, isDirectory: () => child !== null }));
  };
}

test('sourceFiles: reads ts/tsx/js/mjs source, skips tests, dependencies and the unit-test directory', () => {
  const tree = {
    src: {
      'a.ts': null,
      'b.tsx': null,
      'c.test.ts': null,
      'd.spec.ts': null,
      'e.css': null,
      'f.json': null,
      node_modules: { 'g.ts': null },
      __tests__: { 'h.ts': null },
      test: { 'route.ts': null }, // a route directory that happens to be called `test` is real code
    },
    prisma: { 'seed.mjs': null, 'schema.prisma': null },
    scripts: {
      'check.mjs': null,
      'thing.test.mjs': null,
      test: { 'unit.test.mjs': null, 'helper.mjs': null },
    },
  };
  assert.deepEqual(sourceFiles(['src', 'prisma', 'scripts', 'missing'], fakeList(tree)), [
    'prisma/seed.mjs',
    'scripts/check.mjs',
    'src/a.ts',
    'src/b.tsx',
    'src/test/route.ts',
  ]);
});

// ── the command ─────────────────────────────────────────────────────────────

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../check-user-email-lookups.mjs');

// The shipped EXEMPT entries name real files, and an entry whose file the check
// does not find is stale (and fails the run) — so the fixture tree carries a
// file for each, holding exactly the number of excused lookups.
const EXCUSED_FIXTURES = Object.fromEntries([...EXEMPT].map(([file, entry]) => [file, BAD.repeat(entry.calls)]));

function runIn(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'user-email-lookups-'));
  try {
    for (const [name, body] of Object.entries({ ...EXCUSED_FIXTURES, ...files })) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), body);
    }
    return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the command exits non-zero and names file:line for an unpinned lookup', () => {
  const r = runIn({ 'src/app/api/x/route.ts': BAD });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /src\/app\/api\/x\/route\.ts:2/);
  assert.match(r.stderr, /one account per world/);
});

test('the command exits zero on a tree of pinned lookups, and says what it read', () => {
  const r = runIn({ 'src/a.ts': GOOD, 'prisma/seed.mjs': GOOD, 'scripts/test/ignored.test.mjs': BAD });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /user e-mail lookups OK/);
  assert.match(r.stdout, /pinned to a world or a row \(2\)/, r.stdout);
});
