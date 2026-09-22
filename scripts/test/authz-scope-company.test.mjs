// Unit tests for the `company` read scope in src/lib/authzScope.ts (#2430).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The leak these tests pin down (#2396/#2431): `GET /api/companies` stopped at
// `if (!session)`, so every signed-in role read every company in the tenant,
// `contactEmail` included. The fix is a builder per role in ONE place; these
// tests assert what each of the five frozen roles gets — and, just as
// important, which roles get NOTHING. A deny test per role is what makes
// "MENTEE has no builder" a decision rather than an omission: the day someone
// adds one, this file says so.
//
// The `company` builders are pure (no prisma call), so the module is imported
// as-is; the `@/` alias and the extensionless imports inside it are resolved by
// the shared hook. Nothing here touches a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { scopeForRole, andScope, NO_MATCH } = await import('../../src/lib/authzScope.ts');

// The Role enum is FROZEN (prisma/schema.prisma) — this list is the whole
// universe the matrix has to decide, and a sixth entry here would be wrong.
const ROLES = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'];

const user = (role, extra = {}) => ({ id: 'user-1', role, email: 'u@example.com', ...extra });

test('ADMIN is deliberately unscoped: `{}`, so the admin screens are unchanged', async () => {
  assert.deepEqual(await scopeForRole(user('ADMIN'), 'company'), {});
});

test('COMPANY reads exactly its own row', async () => {
  assert.deepEqual(await scopeForRole(user('COMPANY', { companyId: 'co-1' }), 'company'), { id: 'co-1' });
});

test('an unassigned COMPANY user sees nothing, never everything', async () => {
  // The sentinel can never equal a cuid, so the result set is empty rather
  // than unfiltered — the same rule the `relation` builder applies.
  assert.deepEqual(await scopeForRole(user('COMPANY', { companyId: null }), 'company'), { id: NO_MATCH });
  assert.deepEqual(await scopeForRole(user('COMPANY'), 'company'), { id: NO_MATCH });
});

test('MENTOR reads the companies of relations it is personally named in — both sides (#1141)', async () => {
  const scope = await scopeForRole(user('MENTOR', { companyId: 'ignored' }), 'company');
  assert.deepEqual(scope, {
    mentorships: { some: { OR: [{ mentorId: 'user-1' }, { menteeId: 'user-1' }] } },
  });
  // A mentor's companyId (if a row ever carried one) must play no part.
  assert.ok(!('id' in scope));
});

// ── Deny cases, one per role ────────────────────────────────────────────────
// `null` is the fail-closed answer: the route turns it into logScopeDenial()
// + 403. These are the cells docs/role-access-matrix.md marks `—`.

test('MENTEE has no company scope → null (403), even when it sits in a relation with a company', async () => {
  assert.equal(await scopeForRole(user('MENTEE', { companyId: 'co-1' }), 'company'), null);
});

test('SOURCE has no company scope → null (403)', async () => {
  assert.equal(await scopeForRole(user('SOURCE', { companyId: 'co-1' }), 'company'), null);
});

test('a role outside the frozen enum is denied, not granted', async () => {
  assert.equal(await scopeForRole(user('MARKETER'), 'company'), null);
  assert.equal(await scopeForRole(user(''), 'company'), null);
  assert.equal(await scopeForRole(user('admin'), 'company'), null); // case matters
});

test('every frozen role is DECIDED: a builder or a documented deny, nothing accidental', async () => {
  const decided = { ADMIN: 'scope', MENTOR: 'scope', COMPANY: 'scope', MENTEE: 'deny', SOURCE: 'deny' };
  for (const role of ROLES) {
    const scope = await scopeForRole(user(role, { companyId: 'co-1' }), 'company');
    assert.equal(scope === null ? 'deny' : 'scope', decided[role], `${role} changed sides — update docs/role-access-matrix.md too`);
  }
  assert.deepEqual(Object.keys(decided).sort(), [...ROLES].sort());
});

// ── Composition ─────────────────────────────────────────────────────────────

test('a request filter narrows the company scope as a conjunct, never replaces it (#2288)', async () => {
  const scope = await scopeForRole(user('COMPANY', { companyId: 'co-1' }), 'company');
  const where = andScope(scope, { id: 'co-OTHER' });
  // Both terms survive, so asking for another company's id yields nothing.
  assert.deepEqual(where, { AND: [{ id: 'co-1' }, { id: 'co-OTHER' }] });
});

test('the detail route composes ADMIN\'s `{}` with the id into a plain id lookup', async () => {
  const scope = await scopeForRole(user('ADMIN'), 'company');
  assert.deepEqual(andScope(scope, { id: 'co-9' }), { id: 'co-9' });
});

test('the list route hands ADMIN a copy of `{}`, not the builder\'s object', async () => {
  const scope = await scopeForRole(user('ADMIN'), 'company');
  const where = andScope(scope);
  assert.deepEqual(where, {});
  assert.notEqual(where, scope);
});
