// Unit tests for the filters and sort of the admin's affiliate lists
// (src/lib/affiliateListQueryRule.ts, docs/affiliate-module.md § Admin screens,
// #3539). Synthetic ids and dates only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The rule imports its sibling without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  COMMISSION_LIST,
  PAYMENT_LIST,
  PAYOUT_LIST,
  PARTNER_LIST,
  LIST_SEARCH_MAX,
  parseListQuery,
  listQueryParams,
  hasListFilter,
  listDateRange,
  commissionOrderBy,
  paymentOrderBy,
  payoutOrderBy,
  sortPartnerRows,
} = await import('../../src/lib/affiliateListQueryRule.ts');

const parse = (spec, qs) => parseListQuery(spec, new URLSearchParams(qs));

test('no parameters: each list keeps the order it always had', () => {
  assert.deepEqual(parse(COMMISSION_LIST, '').query, { partnerId: null, q: null, from: null, to: null, status: null, kind: null, sort: 'due', dir: 'asc', page: 1 });
  assert.equal(parse(PAYMENT_LIST, '').query.sort, 'date');
  assert.equal(parse(PAYMENT_LIST, '').query.dir, 'desc');
  assert.equal(parse(PARTNER_LIST, '').query.sort, 'created');
  assert.deepEqual(commissionOrderBy(parse(COMMISSION_LIST, '').query), [{ dueAt: 'asc' }, { id: 'asc' }]);
  assert.deepEqual(paymentOrderBy(parse(PAYMENT_LIST, '').query), [{ receivedAt: 'desc' }, { id: 'desc' }]);
  assert.deepEqual(payoutOrderBy(parse(PAYOUT_LIST, '').query), [{ paidAt: 'desc' }, { id: 'desc' }]);
});

test('a sort, direction, status or kind outside the allowlist is refused, never passed on', () => {
  assert.deepEqual(parse(COMMISSION_LIST, 'sort=createdAt'), { ok: false, field: 'sort' });
  assert.deepEqual(parse(COMMISSION_LIST, 'sort=__proto__'), { ok: false, field: 'sort' });
  assert.deepEqual(parse(PAYMENT_LIST, 'sort=partner'), { ok: false, field: 'sort' }); // another list's key
  assert.deepEqual(parse(PAYMENT_LIST, 'dir=up'), { ok: false, field: 'dir' });
  assert.deepEqual(parse(COMMISSION_LIST, 'status=PAID;DROP'), { ok: false, field: 'status' });
  assert.deepEqual(parse(COMMISSION_LIST, 'kind=BONUS'), { ok: false, field: 'kind' });
  assert.deepEqual(parse(PARTNER_LIST, 'status=PENDING'), { ok: false, field: 'status' });
});

test('every order is built from the table — a forged key falls back, never reaches Prisma', () => {
  assert.deepEqual(commissionOrderBy({ sort: 'partner', dir: 'desc' }), [{ partner: { displayName: 'desc' } }, { dueAt: 'asc' }, { id: 'desc' }]);
  assert.deepEqual(commissionOrderBy({ sort: 'amount', dir: 'asc' }), [{ amountMinor: 'asc' }, { id: 'asc' }]);
  assert.deepEqual(commissionOrderBy({ sort: 'constructor', dir: 'asc' }), [{ dueAt: 'asc' }, { id: 'asc' }]);
  assert.deepEqual(paymentOrderBy({ sort: 'amount', dir: 'desc' }), [{ amountMinor: 'desc' }, { id: 'desc' }]);
  // Every order ends with the id: equal rows keep their place across pages.
  for (const sort of COMMISSION_LIST.sorts) assert.deepEqual(commissionOrderBy({ sort, dir: 'asc' }).at(-1), { id: 'asc' });
});

test('a parameter the list does not offer is ignored', () => {
  const r = parse(PARTNER_LIST, 'partnerId=abc&from=2026-01-01&kind=TIER');
  assert.equal(r.ok, true);
  assert.equal(r.query.partnerId, null);
  assert.equal(r.query.from, null);
  assert.equal(r.query.kind, null);
});

test('partner id, search and dates are checked; empty means absent', () => {
  assert.equal(parse(PAYMENT_LIST, 'partnerId=cm0abc_DEF-1').query.partnerId, 'cm0abc_DEF-1');
  assert.deepEqual(parse(PAYMENT_LIST, 'partnerId=a%20b'), { ok: false, field: 'partnerId' });
  assert.equal(parse(PAYMENT_LIST, 'partnerId=&q=%20%20').query.partnerId, null);
  assert.equal(parse(PAYMENT_LIST, 'q=%20%20').query.q, null);
  assert.equal(parse(PAYMENT_LIST, 'q=%20ACME-7%20').query.q, 'ACME-7');
  assert.equal(parse(PAYMENT_LIST, `q=${'x'.repeat(LIST_SEARCH_MAX)}`).ok, true);
  assert.deepEqual(parse(PAYMENT_LIST, `q=${'x'.repeat(LIST_SEARCH_MAX + 1)}`), { ok: false, field: 'q' });
  assert.deepEqual(parse(PAYOUT_LIST, 'from=2026-02-31'), { ok: false, field: 'from' });
  assert.deepEqual(parse(PAYOUT_LIST, 'to=yesterday'), { ok: false, field: 'to' });
  assert.deepEqual(parse(PAYOUT_LIST, 'from=2026-05-02&to=2026-05-01'), { ok: false, field: 'range' });
  assert.equal(parse(PAYOUT_LIST, 'from=2026-05-01&to=2026-05-01').ok, true);
});

test('page is clamped the way the lists always clamped it', () => {
  assert.equal(parse(PAYMENT_LIST, 'page=3').query.page, 3);
  assert.equal(parse(PAYMENT_LIST, 'page=0').query.page, 1);
  assert.equal(parse(PAYMENT_LIST, 'page=abc').query.page, 1);
  assert.equal(parse(PAYMENT_LIST, 'page=1e9').query.page, 10_000);
});

test('the date range is UTC days, both ends inclusive', () => {
  assert.equal(listDateRange({ from: null, to: null }), null);
  assert.deepEqual(listDateRange({ from: '2026-05-01', to: '2026-05-31' }), { gte: new Date('2026-05-01T00:00:00Z'), lt: new Date('2026-06-01T00:00:00Z') });
  assert.deepEqual(listDateRange({ from: null, to: '2026-12-31' }), { lt: new Date('2027-01-01T00:00:00Z') });
});

test('the URL round-trips, defaults left out', () => {
  const q = parse(COMMISSION_LIST, 'partnerId=p1&status=APPROVED&kind=PERCENT&from=2026-01-01&sort=amount&dir=desc&page=2').query;
  const back = listQueryParams(COMMISSION_LIST, q);
  assert.deepEqual(parse(COMMISSION_LIST, back.toString()).query, q);
  assert.equal(listQueryParams(COMMISSION_LIST, parse(COMMISSION_LIST, '').query).toString(), '');
  assert.equal(hasListFilter(parse(COMMISSION_LIST, 'sort=amount&page=4').query), false);
  assert.equal(hasListFilter(q), true);
});

test('partners sort after the sums: open commission is pending + approved; ties by id', () => {
  const row = (id, displayName, createdAt, customers, PENDING, APPROVED) => ({ id, displayName, createdAt, customers, totals: { PENDING, APPROVED, PAID: 0 } });
  const rows = [row('b', 'beta', '2026-01-02T00:00:00.000Z', 3, 100, 0), row('a', 'Alpha', '2026-01-03T00:00:00.000Z', 3, 0, 50), row('c', 'gamma', '2026-01-01T00:00:00.000Z', 1, 70, 70)];
  const ids = (sort, dir) => sortPartnerRows(rows, { sort, dir }).map((r) => r.id);
  assert.deepEqual(ids('created', 'desc'), ['a', 'b', 'c']);
  assert.deepEqual(ids('name', 'asc'), ['a', 'b', 'c']); // case-insensitive
  assert.deepEqual(ids('open', 'desc'), ['c', 'b', 'a']);
  assert.deepEqual(ids('customers', 'asc'), ['c', 'a', 'b']); // a and b tie → by id
  assert.deepEqual(ids('nope', 'desc'), ids('created', 'desc'));
  assert.equal(sortPartnerRows(rows, { sort: 'name', dir: 'asc' }) !== rows, true); // a copy
});
