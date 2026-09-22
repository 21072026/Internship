import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeRoute, checkTree, codeOnly, exemptionFor, HTTP_METHODS } from '../check-route-auth.mjs';

// scripts/check-route-auth.mjs reads TypeScript with a scanner rather than a
// parser, and its two failure modes are both silent on the tree it ships with.
//
// TOO LENIENT is the one that costs something: a handler the reader calls
// guarded when it is not leaves the very hole the guard exists to catch, and the
// frozen baseline makes it look reviewed. TOO STRICT is cheap in principle — CI
// goes red and somebody looks — but a guard that reports a third of the admin
// surface as open gets an EXEMPT entry rather than a fix, which is the same
// outcome one step later. An earlier draft did exactly that: it took the first
// `{` after the function name as the body, which in this tree is the destructured
// `{ params }` of `(request, { params })`, so it read eleven guarded handlers as
// empty and reported them all.
//
// The cases below pin both directions on fixture strings, so they hold whatever
// the real tree happens to contain today.

/** The verdict for one method, or undefined if the reader did not see it. */
function verdict(source, method) {
  return analyzeRoute(source).handlers.find((h) => h.method === method)?.guarded;
}

test('a handler that reads the session is guarded', () => {
  const source = `
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true });
}
`;
  assert.equal(verdict(source, 'GET'), true);
});

test('a handler that reads nothing is unguarded', () => {
  const source = `
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  const users = await prisma.user.findMany();
  return NextResponse.json(users);
}
`;
  assert.equal(verdict(source, 'GET'), false);
});

test('the API-key door counts as a guard', () => {
  const source = `
export async function GET(request: Request) {
  return withApiKey(request, 'candidates:read', async (ctx) => NextResponse.json(ctx.orgId));
}
`;
  assert.equal(verdict(source, 'GET'), true);
});

test('each exported method is judged on its own', () => {
  // The real shape of src/app/api/auth/remember/route.ts: POST takes a session,
  // DELETE deliberately does not. A file-level grep says "this file mentions
  // getServerSession" and misses the open half.
  const source = `
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const token = await readRememberToken();
  if (token) await revokeTrustedDeviceByToken(token);
  return NextResponse.json({ ok: true });
}
`;
  assert.equal(verdict(source, 'POST'), true);
  assert.equal(verdict(source, 'DELETE'), false);
});

test('a guard reached through a helper in the same file counts', () => {
  // Eleven admin routes delegate to a local requireAdmin(), and the return type
  // annotation puts two decoy braces between the parameter list and the body.
  const source = `
async function requireAdmin(): Promise<{ session: Session } | { error: NextResponse }> {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { session };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  return NextResponse.json({ ok: true });
}
`;
  assert.equal(verdict(source, 'GET'), true);
});

test('a helper that does not authenticate does not launder the handler', () => {
  const source = `
async function loadRows(id: string) {
  return prisma.company.findMany({ where: { id } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await loadRows(id));
}
`;
  assert.equal(verdict(source, 'GET'), false);
});

test('prose about getServerSession is not a call', () => {
  // src/app/api/unsubscribe/route.ts says in its header that there is
  // deliberately no getServerSession in that directory and there must never be
  // one. A guard that read its own documentation as compliance would bless the
  // one route whose comment says it is open.
  const source = `
// THE SIGNED TOKEN IS THE ONLY CREDENTIAL. There is deliberately no
// getServerSession(authOptions) anywhere in this directory, and there must
// never be one.
export async function POST(request: Request) {
  const userId = verifyUnsubscribeToken(await request.json());
  return NextResponse.json({ ok: !!userId });
}
`;
  assert.equal(verdict(source, 'POST'), false);
});

test('a brace inside a string or comment does not end the body early', () => {
  const source = `
export async function POST(request: Request) {
  const sample = '{ "role": "ADMIN" }'; // } not the end of the handler
  /* nor } this one */
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ sample });
}
`;
  assert.equal(verdict(source, 'POST'), true);
});

test('codeOnly blanks comments and string contents without moving offsets', () => {
  const source = `const a = 'xx'; // yy\nconst b = 1;`;
  const code = codeOnly(source);
  assert.equal(code.length, source.length);
  assert.equal(code.includes('yy'), false);
  assert.equal(code.includes('xx'), false);
  assert.equal(code.includes('const b = 1;'), true);
});

test('a handler shape the reader cannot follow is reported, not skipped', () => {
  // The alternative is a silent pass, which would make "write the export in an
  // unusual shape" a way around the guard.
  const source = `
const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
`;
  const { handlers, unreadable } = analyzeRoute(source);
  assert.deepEqual(handlers, []);
  assert.deepEqual(unreadable, ['GET', 'POST']);
});

test('a const-assigned handler is reported too, in either arrow shape', () => {
  // Every handler in this tree is `export async function`. A const arrow is not
  // wrong, it is just a shape this reader does not follow — so it lands in
  // `unreadable` and the author is told to declare it, rather than passing
  // unexamined.
  const expression = `export const GET = async (request: Request) => NextResponse.json({ ok: true });`;
  assert.deepEqual(analyzeRoute(expression).unreadable, ['GET']);
  const block = `export const POST = async (request: Request) => { return NextResponse.json({}); };`;
  assert.deepEqual(analyzeRoute(block).unreadable, ['POST']);
});

test('exemptions match a directory prefix or an exact file, nothing else', () => {
  const patterns = { 'src/app/api/v1/': 'x', 'src/app/api/auth/[...nextauth]/route.ts': 'y' };
  assert.equal(exemptionFor('src/app/api/v1/candidates/route.ts', patterns), 'src/app/api/v1/');
  assert.equal(
    exemptionFor('src/app/api/auth/[...nextauth]/route.ts', patterns),
    'src/app/api/auth/[...nextauth]/route.ts',
  );
  assert.equal(exemptionFor('src/app/api/auth/reset/route.ts', patterns), undefined);
  // Not a prefix match on a file name that merely starts the same way.
  assert.equal(exemptionFor('src/app/api/v1x/route.ts', patterns), undefined);
});

// --- the scanner's blind spots -------------------------------------------

test('a regex literal holding a quote does not swallow the next handler', () => {
  // Reported in review of #2444: codeOnly() had no case for a regex literal, so
  // the `'` in a character class opened a string that blanked everything up to
  // the next quote — including the whole of the handler below it. The handler
  // then appeared in NEITHER `handlers` nor `unreadable`, and the check passed
  // with an unguarded route it had never looked at. That is the exact failure
  // this guard exists to prevent, so it is pinned here.
  const source = `
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  return NextResponse.json({ ok: !!session });
}

const APOSTROPHE = /[']/g;

export async function POST(request: Request) {
  await prisma.user.update({ where: { id: body.id }, data: { role: 'ADMIN' } });
  return NextResponse.json({ ok: true });
}
`;
  const { handlers, unreadable } = analyzeRoute(source);
  assert.deepEqual(unreadable, []);
  assert.deepEqual(handlers, [
    { method: 'GET', guarded: true },
    { method: 'POST', guarded: false },
  ]);
});

test('a regex literal holding a brace does not end the body early', () => {
  const source = `
export async function GET(request: Request) {
  const re = /[{}]/g;
  const session = await getServerSession(authOptions);
  return NextResponse.json({ ok: !!session, re: re.source });
}
`;
  assert.equal(verdict(source, 'GET'), true);
});

test('division is not read as a regex literal', () => {
  // The other direction of the same heuristic: over-blanking would eat the
  // guard call and report a private handler as open.
  const source = `
export async function GET(request: Request) {
  const half = total / 2;
  const session = await getServerSession(authOptions);
  return NextResponse.json({ half, ok: !!session });
}
`;
  assert.equal(verdict(source, 'GET'), true);
});

test('a handler the blanking loses is reported, never dropped', () => {
  // The structural promise: `exported` is built from the RAW source as well as
  // the blanked copy, so no confusion inside codeOnly can hide a handler from
  // the report. Here the look-behind heuristic deliberately reads `/['"]/` as
  // division (the character before it is `)`), the fake string swallows both
  // bodies — and both methods still come back, loudly, as unreadable.
  const source = `
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session) /['"]/g.test(session.user.id);
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  await prisma.user.update({ where: { id: body.id }, data: { role: 'ADMIN' } });
  return NextResponse.json({ ok: true });
}
`;
  const { handlers, unreadable } = analyzeRoute(source);
  assert.deepEqual(handlers, []);
  assert.deepEqual(unreadable, ['GET', 'POST']);
});

test('HEAD and OPTIONS are handlers like any other', () => {
  // No route in the tree exports either today. A verb the guard does not know
  // is a verb it waves through in silence, which is the one thing it must not
  // do, so they are in HTTP_METHODS before the first one is written.
  assert.ok(HTTP_METHODS.includes('HEAD') && HTTP_METHODS.includes('OPTIONS'));
  const source = `
export async function OPTIONS(request: Request) {
  return NextResponse.json(await prisma.company.findMany());
}
`;
  assert.equal(verdict(source, 'OPTIONS'), false);
});

// --- the ratchet ----------------------------------------------------------
//
// The detector above is the half with a safety net; main()'s decision layer is
// the half with the security value, and the half a later edit (an `--update`
// flag, a softer staleness rule) would quietly undo. checkTree() is that layer
// with the filesystem lifted out, so the four failures the guard promises can
// be driven from fixtures instead of reproduced by hand.

const GUARDED = `
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true });
}
`;
const OPEN = `
export async function GET(request: Request) {
  return NextResponse.json(await prisma.company.findMany());
}
`;
const WHY = 'a written reason long enough to be a reason';

/** checkTree over an in-memory tree; `exempt` defaults to one live pattern. */
function check({ tree, baseline = {}, exempt = { 'src/app/api/v1/': 'covered by the api-key guard' } }) {
  const files = { 'src/app/api/v1/x/route.ts': OPEN, ...tree };
  return checkTree({
    files: Object.keys(files),
    read: (file) => files[file],
    baseline,
    exempt,
    exists: (file) => file in files,
  });
}

test('ratchet: a clean tree reports nothing', () => {
  const { problems, examined, anonymous } = check({
    tree: { 'src/app/api/a/route.ts': GUARDED, 'src/app/api/b/route.ts': OPEN },
    baseline: { 'src/app/api/b/route.ts': { methods: ['GET'], why: WHY } },
  });
  assert.deepEqual(problems, []);
  assert.equal(examined, 2);
  assert.equal(anonymous, 1);
});

test('ratchet: a new anonymous handler that is not listed fails', () => {
  const { problems } = check({ tree: { 'src/app/api/new/route.ts': OPEN } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/app\/api\/new\/route\.ts {2}GET answers without calling/);
  // The message hands over a paste-ready entry, but nothing writes it: adding
  // one costs writing the reason by hand.
  assert.match(problems[0], /"methods": \["GET"\]/);
});

test('ratchet: a listed handler that has since gained a guard fails', () => {
  const { problems } = check({
    tree: { 'src/app/api/a/route.ts': GUARDED },
    baseline: { 'src/app/api/a/route.ts': { methods: ['GET'], why: WHY } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /now authenticates, but is still listed/);
});

test('ratchet: a baseline entry naming a file that is gone fails', () => {
  const { problems } = check({
    tree: { 'src/app/api/a/route.ts': GUARDED },
    baseline: { 'src/app/api/deleted/route.ts': { methods: ['GET'], why: WHY } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer exists — delete the entry/);
});

test('ratchet: an exemption that suppresses nothing fails', () => {
  const { problems } = check({
    tree: { 'src/app/api/a/route.ts': GUARDED },
    exempt: { 'src/app/api/nothing-here/': 'a pattern that stopped covering anything' },
  });
  // The v1 fixture is open but no longer excused, so it is reported too.
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /still excuses src\/app\/api\/nothing-here\//.test(p)));
});

test('ratchet: a baseline entry with no usable reason fails', () => {
  const { problems } = check({
    tree: { 'src/app/api/b/route.ts': OPEN },
    baseline: { 'src/app/api/b/route.ts': { methods: ['GET'], why: 'public' } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no usable "why"/);
});

test('ratchet: a baseline entry naming a method the file does not export fails', () => {
  const { problems } = check({
    tree: { 'src/app/api/b/route.ts': OPEN },
    baseline: { 'src/app/api/b/route.ts': { methods: ['GET', 'DELETE'], why: WHY } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lists DELETE, which the file does not export/);
});

test('ratchet: an unreadable handler shape fails instead of passing', () => {
  const { problems } = check({
    tree: { 'src/app/api/odd/route.ts': 'export const GET = async (r: Request) => NextResponse.json({});' },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /exports GET in a shape this guard cannot read/);
});

test('_conditional: an entry that stopped authenticating must move to the baseline', () => {
  // The annotation of "asks, but answers anonymous callers on a branch" is
  // written by hand, so it is held to a rule that cannot rot: the day the
  // handler stops asking at all, the entry fails and it goes where the ratchet
  // counts it.
  const { problems } = check({
    tree: { 'src/app/api/health/route.ts': OPEN },
    baseline: { _conditional: { 'src/app/api/health/route.ts': { methods: ['GET'], why: WHY } } },
  });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /move it to the frozen baseline/.test(p)));
  assert.ok(problems.some((p) => /answers without calling/.test(p)));
});

test('_conditional: a handler cannot be in both sections', () => {
  const { problems } = check({
    tree: { 'src/app/api/health/route.ts': GUARDED },
    baseline: {
      'src/app/api/health/route.ts': { methods: ['GET'], why: WHY },
      _conditional: { 'src/app/api/health/route.ts': { methods: ['GET'], why: WHY } },
    },
  });
  assert.ok(problems.some((p) => /both the frozen baseline and _conditional/.test(p)));
});

test('_conditional: a well-formed annotation of a guarded handler reports nothing', () => {
  const { problems } = check({
    tree: { 'src/app/api/health/route.ts': GUARDED },
    baseline: { _conditional: { 'src/app/api/health/route.ts': { methods: ['GET'], why: WHY } } },
  });
  assert.deepEqual(problems, []);
});

test('the shipped baseline is well formed, in both sections', () => {
  const baseline = JSON.parse(readFileSync('scripts/route-auth-baseline.json', 'utf8'));
  const entries = [
    ...Object.entries(baseline),
    ...Object.entries(baseline._conditional ?? {}),
  ].filter(([key]) => !key.startsWith('_'));
  assert.ok(entries.length > 0, 'a frozen baseline with nothing in it records nothing');
  for (const [file, entry] of entries) {
    assert.ok(Array.isArray(entry.methods) && entry.methods.length > 0, `${file}: methods`);
    for (const method of entry.methods) assert.ok(HTTP_METHODS.includes(method), `${file}: ${method}`);
    assert.equal(typeof entry.why, 'string', `${file}: why`);
    assert.ok(entry.why.trim().length >= 20, `${file}: why is too short to be a reason`);
  }
});
