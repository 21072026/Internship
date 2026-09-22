import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeRoute, codeOnly, exemptionFor, HTTP_METHODS } from '../check-route-auth.mjs';

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

test('the shipped baseline is well formed', () => {
  const baseline = JSON.parse(readFileSync('scripts/route-auth-baseline.json', 'utf8'));
  const entries = Object.entries(baseline).filter(([key]) => !key.startsWith('_'));
  assert.ok(entries.length > 0, 'a frozen baseline with nothing in it records nothing');
  for (const [file, entry] of entries) {
    assert.ok(Array.isArray(entry.methods) && entry.methods.length > 0, `${file}: methods`);
    for (const method of entry.methods) assert.ok(HTTP_METHODS.includes(method), `${file}: ${method}`);
    assert.equal(typeof entry.why, 'string', `${file}: why`);
    assert.ok(entry.why.trim().length >= 20, `${file}: why is too short to be a reason`);
  }
});
