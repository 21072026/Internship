import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// scripts/check-capability-writers.mjs is the mechanical half of #2364: it fails
// CI when a write to a vertical-gated model is reachable without
// requireCapability() in front of it. The whole point of the guard is the
// writer nobody noticed, so its own two failure modes have to be pinned:
//
// TOO NARROW — it passes a leaked writer. That is the exact class of bug it was
// written for (#2352 shipped with two ungated Evaluation/Goal writers, found in
// review, not by a check). A guard that only ever prints green is worse than no
// guard, because the green is quoted in review.
//
// TOO BROAD — it fails a gated handler, e.g. because the gate sits a few lines
// above the write rather than immediately before it, or because a second
// handler in the same file has its own gate. A check that cries wolf gets
// `--no-verify`d, and then it protects nothing.
//
// Both directions are asserted against throwaway fixture trees, so these tests
// keep passing when the real routes are refactored.

const GUARD = path.join(process.cwd(), 'scripts/check-capability-writers.mjs');

/** Run the guard over a throwaway tree: { 'a/b.ts': '…source…' }. */
function check(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cap-writers-'));
  try {
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(dir, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    const run = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf8' });
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GATED_POST = `
import { requireCapability } from '@/lib/capabilityGate';
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  return withTenantScope(session, async () => {
    const offer = await prisma.offer.create({ data: {} });
    return NextResponse.json({ offer });
  });
}
`;

test('a gated handler passes', () => {
  const { code, out } = check({ 'app/api/offers/route.ts': GATED_POST });
  assert.equal(code, 0, out);
  assert.match(out, /capability writers OK/);
});

test('an ungated handler fails and names the file, the line and the capability', () => {
  const { code, out } = check({
    'app/api/offers/route.ts': GATED_POST.replace(
      /const capGate[\s\S]*?if \(capGate\) return capGate;\n/,
      '',
    ),
  });
  assert.equal(code, 1, out);
  assert.match(out, /app\/api\/offers\/route\.ts:\d+/);
  assert.match(out, /offer\.create\(\)/);
  assert.match(out, /'placements'/);
});

test('a SECOND handler in an already-gated file is checked on its own', () => {
  // The leak that a file-level grep cannot see: route.ts is gated for POST and
  // someone adds a DELETE underneath it.
  const { code, out } = check({
    'app/api/offers/route.ts': `${GATED_POST}
export async function DELETE(request: Request) {
  await prisma.offer.deleteMany({ where: {} });
  return NextResponse.json({ ok: true });
}
`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /DELETE writes offer\.deleteMany\(\)/);
});

test('the wrong capability does not satisfy the gate', () => {
  const { code, out } = check({
    'app/api/offers/route.ts': GATED_POST.replace("'placements'", "'evaluations'"),
  });
  assert.equal(code, 1, out);
  assert.match(out, /requireCapability\(…, 'placements'\)/);
});

test('a write in a read handler is not a gated write path', () => {
  // The backward walk must land on a MUTATING handler; a read handler carries
  // no gate and must not shadow one.
  const { code, out } = check({
    'app/api/offers/route.ts': `
export async function GET() {
  await prisma.offer.updateMany({ where: {}, data: {} });
  return NextResponse.json({});
}
`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /nearest export above it is `GET`/);
});

test('a GET declared UNDER a gated handler does not inherit its gate', () => {
  // The same leak as the second-handler test, with a READ verb. The backward
  // walk used to look only for POST/PUT/PATCH/DELETE, so it stepped straight
  // over this GET and credited the write to the POST's gate above it — and the
  // ordering is real: src/app/api/interview-panels/route.ts declares POST above
  // GET. Asserted with the gated POST present, which is what made the old
  // version of this test pass for the wrong reason (its fixture had no POST at
  // all, so it only re-asserted the "no handler" branch).
  const { code, out } = check({
    'app/api/offers/route.ts': `${GATED_POST}
export async function GET() {
  await prisma.offer.updateMany({ where: {}, data: {} });
  return NextResponse.json({});
}
`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /offer\.updateMany\(\)/);
  assert.match(out, /nearest export above it is `GET`/);
});

test('a gate whose orgId comes from a helper call is still a gate', () => {
  // TOO BROAD guard: `requireCapability(resolveOrgId(session), 'placements')`
  // is the repo's other idiom for the same call (src/lib/orgScope.ts), and a
  // paren-free scan could not cross `resolveOrgId(session)`'s closing paren, so
  // a correctly gated handler was reported as ungated.
  const { code, out } = check({
    'app/api/offers/route.ts': GATED_POST.replace(
      'requireCapability(session.user.orgId,',
      'requireCapability(resolveOrgId(session),',
    ),
  });
  assert.equal(code, 0, out);
});

test('an arrow-function handler export is checked like a declared one', () => {
  // Next.js accepts `export const POST = async (…) => {}`; the region walk is
  // name-based, so this form gets the same treatment rather than falling
  // through to "not inside a handler".
  const ungated = `
export const DELETE = async (request: Request) => {
  await prisma.offer.deleteMany({ where: {} });
  return NextResponse.json({ ok: true });
};
`;
  assert.equal(check({ 'app/api/offers/route.ts': ungated }).code, 1);
  const gated = ungated.replace(
    'await prisma.offer.deleteMany',
    `const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  await prisma.offer.deleteMany`,
  );
  const run = check({ 'app/api/offers/route.ts': gated });
  assert.equal(run.code, 0, run.out);
});

test('a write outside any handler fails unless the file is exempted by name', () => {
  const { code, out } = check({
    'lib/someSweep.ts': `
export async function sweep() {
  await prisma.offer.updateMany({ where: { status: 'SENT' }, data: { status: 'EXPIRED' } });
}
`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /not inside an exported POST\/PUT\/PATCH\/DELETE handler/);
});

test('a file that reads but never writes a gated model is left alone', () => {
  const { code, out } = check({
    'app/api/offers/route.ts': `
export async function GET() {
  return NextResponse.json({ offers: await prisma.offer.findMany() });
}
`,
  });
  assert.equal(code, 0, out);
});

test('the real tree is clean', () => {
  const run = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});
