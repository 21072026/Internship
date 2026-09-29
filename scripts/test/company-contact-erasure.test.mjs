// Unit tests for "erase the person, keep the company" (#2434).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHAT THIS PINS
//   Erasure reaches `CompanyInquiry` and `Company.contact*` by ADDRESS — neither
//   table references `User` — and an address is not a tenant boundary. The first
//   draft of this fix (135a367a, never merged) ran both `updateMany`s with no org
//   filter; with MT_ENFORCE_ISOLATION off (#2542) that rewrites another tenant's
//   lead that happens to carry the same address. So:
//
//   1. For EVERY subject, no row of a different tenant is ever matched.
//   2. A subject's own tenant is matched, and a not-yet-stamped (NULL-org) row
//      only when that tenant is the default org — the org the deploy backfill
//      will give the row.
//   3. A subject with no org is the default org's, and a missing default org
//      THROWS instead of producing an unscoped write.
//   4. The data halves follow the module's tombstone/scrub split and never touch
//      a column that belongs to the ACCOUNT rather than the person.
//
// Nothing here touches a database: the `where` each call produces is evaluated
// against an in-memory table with a matcher for exactly the Prisma subset the
// module emits (equality, `AND`, `OR`), which is what makes rule 1 a statement
// about ROWS rather than about the shape of an object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The module imports `./orgScope` and `./menteeAccount` — extensionless
// specifiers Node's ESM resolver refuses; the hook must be installed before it
// loads, hence the dynamic import.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  ERASED_CONTACT_NAME,
  companyContactErasureData,
  erasedAddress,
  erasureOrgId,
  erasureScoped,
  inquiryErasureData,
} = await import('../../src/lib/companyContactErasure.ts');

const DEFAULT = 'org-default';
const A = 'org-a';
const B = 'org-b';
const ADDRESS = 'contact@example.test';

/** The subset of Prisma's `where` the module emits: equality, AND, OR. */
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every((w) => matches(row, w));
    if (key === 'OR') return value.some((w) => matches(row, w));
    return row[key] === value;
  });
}

// One enquiry per tenant carrying the SAME address, one unstamped, plus a
// same-tenant row for a different person that must never be touched.
const rows = [
  { id: 'default', orgId: DEFAULT, email: ADDRESS },
  { id: 'a', orgId: A, email: ADDRESS },
  { id: 'b', orgId: B, email: ADDRESS },
  { id: 'unstamped', orgId: null, email: ADDRESS },
  { id: 'a-other-person', orgId: A, email: 'someone.else@example.test' },
  { id: 'default-other-person', orgId: DEFAULT, email: 'someone.else@example.test' },
];

const touched = (subjectOrgId) =>
  rows
    .filter((r) => matches(r, erasureScoped({ email: ADDRESS }, subjectOrgId, DEFAULT)))
    .map((r) => r.id)
    .sort();

test('a non-default tenant touches its own rows only — never another tenant, never an unstamped row', () => {
  assert.deepEqual(touched(A), ['a']);
  assert.deepEqual(touched(B), ['b']);
});

test('a non-default tenant goes through orgScoped(): the where is the address plus that org', () => {
  assert.deepEqual(erasureScoped({ email: ADDRESS }, A, DEFAULT), { email: ADDRESS, orgId: A });
});

test('the default tenant also takes the rows the deploy backfill has not stamped yet', () => {
  assert.deepEqual(touched(DEFAULT), ['default', 'unstamped']);
});

test('a subject with no org is the default org’s, not "every org"', () => {
  assert.equal(erasureOrgId(null, DEFAULT), DEFAULT);
  assert.equal(erasureOrgId(undefined, DEFAULT), DEFAULT);
  assert.equal(erasureOrgId('', DEFAULT), DEFAULT);
  assert.deepEqual(touched(null), ['default', 'unstamped']);
  assert.deepEqual(touched(undefined), ['default', 'unstamped']);
});

test('for every subject, no row of a different tenant is ever matched', () => {
  for (const subject of [DEFAULT, A, B, null]) {
    const own = subject ?? DEFAULT;
    for (const id of touched(subject)) {
      const row = rows.find((r) => r.id === id);
      const rowTenant = row.orgId ?? DEFAULT; // what the backfill will make it
      assert.equal(rowTenant, own, `subject ${subject} touched ${id} of ${rowTenant}`);
      assert.equal(row.email, ADDRESS, `subject ${subject} touched somebody else's row ${id}`);
    }
  }
});

test('a missing default org fails closed instead of producing an unscoped write', () => {
  assert.throws(() => erasureOrgId(null, ''), /default organization/);
  assert.throws(() => erasureScoped({ email: ADDRESS }, A, ''), /default organization/);
  assert.throws(() => erasureScoped({ email: ADDRESS }, null, undefined), /default organization/);
});

test('the caller’s own where is never merged into or overwritten by the tenant half', () => {
  const where = { contactEmail: ADDRESS, OR: [{ id: 'x' }, { id: 'y' }] };
  const scoped = erasureScoped(where, DEFAULT, DEFAULT);
  assert.deepEqual(scoped.AND[0], where, 'the caller’s OR survives intact');
  assert.equal(matches({ id: 'z', orgId: DEFAULT, contactEmail: ADDRESS }, scoped), false);
  assert.equal(matches({ id: 'x', orgId: null, contactEmail: ADDRESS }, scoped), true);
});

test('the enquiry: what they wrote is tombstoned, what identifies them is scrubbed', () => {
  assert.deepEqual(inquiryErasureData('user123'), {
    contactName: ERASED_CONTACT_NAME,
    email: 'erased-user123@erased.local',
    phone: null,
    note: null,
    message: null,
  });
});

test('the enquiry keeps every column that belongs to the account', () => {
  const data = inquiryErasureData('user123');
  for (const kept of [
    'companyName',
    'openRoles',
    'status',
    'locale',
    'consentAt',
    'handledAt',
    'handledById',
    'createdAt',
    'convertedCompanyId',
    'convertedAt',
    'orgId',
  ]) {
    assert.equal(kept in data, false, `${kept} is the account's, not the person's`);
  }
});

test('the company loses its three contact columns and nothing else', () => {
  assert.deepEqual(companyContactErasureData(), { contactEmail: null, contactName: null, contactPhone: null });
});

test('one tombstone address for the User row and the enquiry', () => {
  assert.equal(erasedAddress('abc'), 'erased-abc@erased.local');
  assert.equal(inquiryErasureData('abc').email, erasedAddress('abc'));
});
